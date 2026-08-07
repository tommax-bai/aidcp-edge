import {
  dispatchClick,
  dispatchKey,
  dispatchKeystrokes,
  evalJson,
  evalRaw,
  InputDispatchDeadlineError,
  type BrowseCdp,
} from '../browse/cdp-util.js';
import type { ImageUploader } from '../flows/image-uploader.js';
import type { PublishCommandPayload, PublishCommandResultPayload } from '../comm/protocol.js';
import { rethrowIfTakeover, TaskTakeoverError, type TakeoverCtx } from '../execution/takeover.js';
import type { CommitWindowGuard } from '../execution/commit-window.js';
import { classifyFacebookSurface, type FacebookSurfaceType } from './probes/page-structure.js';

export interface FacebookPublishExecutorOptions {
  pollMs?: number;
  /** 导航到 Facebook 首页后的落地确认窗口；MUST 小于 cloud 默认单指令 30s。 */
  navigationTimeoutMs?: number;
  /** cloud 未下发 select_mode 预算时的兼容兜底；MUST 小于 cloud 默认单指令 30s。 */
  composerTimeoutMs?: number;
  submitVerifyTimeoutMs?: number;
  capturePostTimeoutMs?: number;
  /**
   * 云端未下发单步预算时（旧云端 / 兼容路径），正文填写自己的兜底预算。
   * MUST 小于云端的常数单步窗口 30s——这样即使对端没升级，也是**边缘先答**（诚实失败），
   * 而不是云端先超时、边缘还在往活着的编辑器里打字。
   */
  fillFallbackTimeoutMs?: number;
  /** 从预算里为「聚焦 + 清场 + 全文回读」预留的部分；其余才是逐字输入可用的时间。 */
  fillReserveMs?: number;
  /** 打完字后等待编辑器接受全文的窗口。 */
  fillVerifyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 墙钟（测试可注入）。 */
  now?: () => number;
}

export interface FacebookPublishExecutorDeps {
  cdp: BrowseCdp;
  uploader?: ImageUploader;
  logger?: (message: string) => void;
  /**
   * 提交窗口守卫（change lease-strict-preemption 5.1）：发布提交点击前 `enter()`、确认后 `dispose()`。
   * 未注入 = 抢占能力休眠、行为逐字不变（保守缺省，同 EdgeTaskPageWriterProbe）。与 XHS 发布共用同一实例。
   */
  commitWindow?: CommitWindowGuard;
}

const FACEBOOK_HOME_URL = 'https://www.facebook.com/';
const COMPOSER_TRIGGER_MAX_MS = 20_000;

const DEFAULTS: Required<FacebookPublishExecutorOptions> = {
  pollMs: 400,
  navigationTimeoutMs: 20_000,
  composerTimeoutMs: 20_000,
  submitVerifyTimeoutMs: 20_000,
  capturePostTimeoutMs: 20_000,
  fillFallbackTimeoutMs: 25_000,
  fillReserveMs: 8_000,
  fillVerifyTimeoutMs: 5_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const FB_PUBLISH_HELPERS_JS = String.raw`
function fbPublishVisible(el){
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  var s = window.getComputedStyle ? getComputedStyle(el) : null;
  return r.width > 0 && r.height > 0 &&
    (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01)) &&
    r.right > 0 && r.bottom > 0 && r.left < (window.innerWidth || 0) && r.top < (window.innerHeight || 0);
}
function fbPublishText(el){
  return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
}
function fbPublishLabel(el){
  return String((el && (el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || el.getAttribute('title'))) || '').replace(/\s+/g, ' ').trim();
}
function fbPublishNorm(value){ return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function fbPublishDialog(){
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(fbPublishVisible);
  return dialogs[0] || null;
}
function fbPublishComposerTrigger(){
  var nodes = Array.from(document.querySelectorAll('[role="region"][aria-label],button,[role="button"],div[aria-label],span[aria-label],a[role="link"]')).filter(fbPublishVisible);
  var re = /(what('|’)s on your mind|create post|create a post|write something|写点什么|在想什么|创建帖子|分享你的新鲜事|bạn đang nghĩ gì|crear publicación|crear una publicación|post something)/i;
  var scored = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (el.closest('[role="menu"]')) continue;
    var label = fbPublishLabel(el);
    var text = fbPublishText(el);
    var hay = label + ' ' + text;
    if (!re.test(hay)) continue;
    if (/comment|评论|reply|回复/i.test(hay)) continue;
    scored.push({ el: el, score: (label ? 0 : 4) + Math.min(text.length, 120) });
  }
  scored.sort(function(a,b){ return a.score - b.score; });
  return scored.length ? scored[0].el : null;
}
function fbPublishEditor(){
  var dialog = fbPublishDialog();
  var root = dialog || document;
  var editors = Array.from(root.querySelectorAll('[contenteditable="true"][role="textbox"],[contenteditable="true"]')).filter(fbPublishVisible);
  var re = /(what('|’)s on your mind|create a public post|write something|写点什么|在想什么|bạn đang nghĩ gì|qué estás pensando|publicación)/i;
  var exact = editors.find(function(el){
    var hay = fbPublishLabel(el) + ' ' + fbPublishText(el);
    return re.test(hay) && !/comment|评论|reply|回复/i.test(hay);
  });
  // 首页 feed 也可能渲染评论 contenteditable；没有 composer dialog 时绝不拿任意 textbox 兜底。
  return exact || (dialog ? editors[0] : null) || null;
}
function fbPublishFileInput(){
  var root = fbPublishDialog() || document;
  var inputs = Array.from(root.querySelectorAll('input[type="file"]'));
  var imageInput = inputs.find(function(input){
    return /image|jpg|jpeg|png|webp|gif/i.test(input.getAttribute('accept') || '');
  });
  return imageInput || inputs[0] || null;
}
function fbPublishHasImageAttachment(){
  var root = fbPublishDialog() || document;
  if (Array.from(root.querySelectorAll('img[src], video')).some(function(el){ return fbPublishVisible(el); })) return true;
  var body = fbPublishText(root);
  return /(remove (photo|attachment)|移除(照片|帖子附件)|删除照片|photo attached|attachment attached|已添加照片|已添加附件|ảnh)/i.test(body);
}
function fbPublishSubmitControl(){
  var root = fbPublishDialog() || document;
  var nodes = Array.from(root.querySelectorAll('button,[role="button"],div[aria-label],span[aria-label]')).filter(fbPublishVisible);
  var exact = /^(post|发布|發佈|发帖|đăng|publicar|compartir)$/i;
  for (var i = nodes.length - 1; i >= 0; i--) {
    var el = nodes[i];
    var label = fbPublishLabel(el) || fbPublishText(el);
    var clean = label.replace(/\s+/g, ' ').trim();
    if (!exact.test(clean)) continue;
    var disabled = el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null ||
      /disabled/i.test(String(el.className || ''));
    var r = el.getBoundingClientRect();
    return { found: true, disabled: disabled, label: clean.slice(0, 40), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  return { found: false, disabled: false, label: null, x: null, y: null };
}
function fbPublishSubmittedSignal(){
  var dialog = fbPublishDialog();
  if (!dialog) return true;
  var text = fbPublishText(document.body);
  return /(your post is being processed|your post has been shared|post shared|已发布|发布中|發佈中|đã đăng|publicación compartida)/i.test(text);
}
function fbPublishFocusEditor(){
  var el = fbPublishEditor();
  if (!el) return { found:false, focused:false };
  try { el.scrollIntoView({ block:'center' }); } catch(e) {}
  try { el.focus(); if (el.click) el.click(); } catch(e) {}
  return { found:true, focused: document.activeElement === el };
}
function fbPublishSelectEditorContents(){
  var el = fbPublishEditor();
  if (!el) return { found:false, selected:false };
  try {
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { found:true, selected:true };
  } catch(e) { return { found:true, selected:false }; }
}
function fbPublishEditorText(){
  var el = fbPublishEditor();
  return { found: !!el, text: el ? fbPublishText(el) : '' };
}
function fbPublishPageState(){
  var publishEditor = fbPublishEditor();
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(fbPublishVisible);
  var blockingDialog = dialogs.some(function(dialog){
    return !publishEditor || !dialog.contains(publishEditor);
  });
  var credentialInput = Array.from(document.querySelectorAll('input[type="password"],input[type="email"]')).some(fbPublishVisible);
  var mainVisible = Array.from(document.querySelectorAll('[role="main"]')).some(fbPublishVisible);
  return {
    href: String(location.href || ''),
    readyState: String(document.readyState || ''),
    mainVisible: mainVisible,
    editorReady: !!publishEditor,
    blockingDialog: blockingDialog,
    credentialInput: credentialInput
  };
}
function fbPublishCloseComposer(){
  var dlg = fbPublishDialog();
  if (!dlg) return { dialogFound:false, clicked:false };
  var re = /^(close|关闭|關閉|đóng|cerrar|fermer|schließen)$/i;
  var nodes = Array.from(dlg.querySelectorAll('[aria-label],[role="button"],button')).filter(fbPublishVisible);
  var btn = nodes.find(function(el){ return re.test((fbPublishLabel(el) || '').trim()); });
  if (!btn) return { dialogFound:true, clicked:false };
  try { btn.click(); } catch(e) { return { dialogFound:true, clicked:false }; }
  return { dialogFound:true, clicked:true };
}
function fbPublishExtractPost(){
  var links = Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; });
  var hit = links.find(function(h){ return /\/posts\/|story_fbid=|\/permalink\//i.test(h); }) || location.href;
  var id = '';
  try {
    var u = new URL(hit, location.href);
    var sf = u.searchParams.get('story_fbid');
    if (sf) id = sf;
    if (!id) {
      var parts = u.pathname.split('/').filter(Boolean);
      var idx = parts.indexOf('posts');
      if (idx >= 0 && parts[idx + 1]) id = parts[idx + 1];
      var pidx = parts.indexOf('permalink');
      if (!id && pidx >= 0 && parts[pidx + 1]) id = parts[pidx + 1];
    }
  } catch(e) {}
  return { postId: id || '', postUrl: hit || '' };
}
`;

function base(payload: PublishCommandPayload): Pick<PublishCommandResultPayload, 'recordId' | 'seq' | 'kind'> {
  return { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
}

/** 与页面侧 fbPublishText 同口径归一（折叠空白、去首尾），供全文比对。 */
function normalizeEditorText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 允许的「多出来的字符数」。编辑器可能带入零宽字符/不间断空格之类的无害残留；
 * 超出这个容差就是真被塞了东西（如打字途中被 typeahead 劫持插入了 @提及），
 * 那样的正文 MUST NOT 发出去。
 */
const FILL_EXTRA_CHAR_TOLERANCE = 4;

interface ClearResult {
  cleared: boolean;
  residual: string | null;
  /** 编辑器是否还在页面上。false = 已被导航走 / 弹层已关，没有残文可留（≠ 脏页）。 */
  editorFound: boolean;
}

interface FacebookPublishPageState {
  href: string;
  readyState: string;
  mainVisible: boolean;
  editorReady: boolean;
  blockingDialog: boolean;
  credentialInput: boolean;
}

interface FacebookComposerTargetProbe extends FacebookPublishPageState {
  found: boolean;
  x: number | null;
  y: number | null;
}

type FacebookHomeFailure =
  | 'not_facebook'
  | 'login_required'
  | 'checkpoint_detected'
  | 'blocked_dialog'
  | 'home_not_reached';

interface FacebookHomeAssessment {
  ready: boolean;
  error: FacebookHomeFailure;
  surface: FacebookSurfaceType;
  pathname: string;
}

type FacebookComposerProbeOutcome = {
  kind: 'home_failure' | 'already_open' | 'target';
  probe: FacebookComposerTargetProbe;
};

function facebookPathname(href: string): string {
  try {
    return new URL(href).pathname || '/';
  } catch {
    return 'invalid';
  }
}

function isFacebookHostname(href: string): boolean {
  try {
    const hostname = new URL(href).hostname.toLowerCase();
    return (
      hostname === 'facebook.com' ||
      hostname.endsWith('.facebook.com') ||
      hostname === 'facebookcorewwwi.onion' ||
      hostname.endsWith('.facebookcorewwwi.onion')
    );
  } catch {
    return false;
  }
}

/**
 * 首页语境判定只消费脱敏结构信号。URL 路由复用全仓统一分类器；main/dialog/editor
 * 只决定是否真的渲染就绪，绝不凭相似文案猜「大概是首页」。
 */
function assessFacebookHome(state: FacebookPublishPageState): FacebookHomeAssessment {
  const surface = classifyFacebookSurface(state.href);
  const pathname = facebookPathname(state.href);
  if (!isFacebookHostname(state.href)) return { ready: false, error: 'not_facebook', surface, pathname };
  if (surface === 'checkpoint') return { ready: false, error: 'checkpoint_detected', surface, pathname };
  if (surface === 'login' || state.credentialInput) {
    return { ready: false, error: 'login_required', surface, pathname };
  }
  if (state.blockingDialog && !state.editorReady) {
    return { ready: false, error: 'blocked_dialog', surface, pathname };
  }
  const documentReady = state.readyState === 'interactive' || state.readyState === 'complete';
  const ready = surface === 'home' && documentReady && (state.mainVisible || state.editorReady);
  return { ready, error: 'home_not_reached', surface, pathname };
}

export class FacebookPublishExecutor {
  private readonly cdp: BrowseCdp;
  private readonly uploader?: ImageUploader;
  private readonly opts: Required<FacebookPublishExecutorOptions>;
  private readonly log: (message: string) => void;
  private readonly commitWindow?: CommitWindowGuard;

  constructor(deps: FacebookPublishExecutorDeps, options: FacebookPublishExecutorOptions = {}) {
    this.cdp = deps.cdp;
    this.uploader = deps.uploader;
    this.opts = { ...DEFAULTS, ...options };
    this.log = deps.logger ?? (() => {});
    this.commitWindow = deps.commitWindow;
  }

  /**
   * `takeover`（change lease-strict-preemption 第 4 节）：可选取消上下文。接管只由 TaskTakeoverError 表达，
   * 由上层 dispatch 统一分类成「未开始」。取消点只落在逐字输入与上传下载段；**提交点击之后一格都不加**。
   */
  async dispatch(
    payload: PublishCommandPayload,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    switch (payload.kind) {
      case 'navigate_entry':
        return this.navigate(payload);
      case 'select_mode':
        return this.openComposer(payload);
      case 'upload_image':
        return this.uploadImage(payload, takeover);
      case 'fill_field':
        return this.fillContent(payload, takeover);
      case 'submit_publish':
        return this.submit(payload, takeover);
      case 'capture_postId':
        return this.capturePostId(payload);
      default:
        // fail-closed（批 6b）：显式六臂即 Facebook 合法 kind 全集（FacebookPublishCommandKind），
        // 落到 default 的都是 XHS 专属 kind——云端类型面已不可表示，运行时仍拒收、绝不静默改道。
        return { ...base(payload), ok: false, error: 'kind_not_supported_on_platform' };
    }
  }

  private async waitUntil<T>(
    timeoutMs: number,
    fn: () => Promise<T | null | undefined | false>,
  ): Promise<T | null> {
    const deadline = this.opts.now() + timeoutMs;
    // 双闸=墙钟 + 迭代帽（同 flows/bounded-poll 的护栏）：注入恒定 now 的测试桩会让墙钟永不到期，
    // 裸 for(;;) 就成死循环。迭代帽是唯一能终止它的机械保证（change lease-strict-preemption 5.10）。
    const cap = Math.ceil(timeoutMs / Math.max(1, this.opts.pollMs)) + 2;
    for (let i = 0; i < cap; i++) {
      const value = await fn();
      if (value) return value;
      const remainingMs = deadline - this.opts.now();
      if (remainingMs <= 0) return null;
      await this.opts.sleep(Math.min(this.opts.pollMs, remainingMs));
    }
    return null;
  }

  private async navigate(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    try {
      await this.cdp.send('Page.navigate', { url: FACEBOOK_HOME_URL });
      let attempts = 0;
      let lastAssessment: FacebookHomeAssessment = {
        ready: false,
        error: 'home_not_reached',
        surface: 'unknown',
        pathname: 'unknown',
      };
      let successfulStateReads = 0;
      let lastProbeError: unknown = null;
      const startedAt = this.opts.now();
      const ready = await this.waitUntil(this.opts.navigationTimeoutMs, async () => {
        attempts += 1;
        try {
          const state = await this.readPageState();
          successfulStateReads += 1;
          lastProbeError = null;
          lastAssessment = assessFacebookHome(state);
          return lastAssessment.ready;
        } catch (err) {
          lastProbeError = err;
          return false;
        }
      });
      const elapsedMs = Math.max(0, this.opts.now() - startedAt);
      const withinDeadline = ready && elapsedMs <= this.opts.navigationTimeoutMs;
      this.log(
        `[fb-publish] stage=navigate surface=${lastAssessment.surface} path=${lastAssessment.pathname} attempts=${attempts} elapsedMs=${elapsedMs}`,
      );
      if (!withinDeadline && successfulStateReads === 0 && lastProbeError) {
        const detail = lastProbeError instanceof Error ? lastProbeError.message : String(lastProbeError);
        return { ...base(payload), ok: false, error: `nav_error: ${detail}` };
      }
      return withinDeadline
        ? { ...base(payload), ok: true }
        : { ...base(payload), ok: false, error: lastAssessment.error };
    } catch (err) {
      return { ...base(payload), ok: false, error: `nav_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async openComposer(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    if (
      (payload.params.optionKind !== undefined && payload.params.optionKind !== 'target') ||
      payload.params.optionValue !== 'facebook_personal_timeline'
    ) {
      return { ...base(payload), ok: false, error: 'unsupported_target' };
    }
    try {
      const startedAt = this.opts.now();
      const requestedBudgetMs = payload.timeoutMs ?? this.opts.composerTimeoutMs;
      const totalBudgetMs = Number.isFinite(requestedBudgetMs) && requestedBudgetMs > 0
        ? requestedBudgetMs
        : this.opts.composerTimeoutMs;
      const deadline = startedAt + totalBudgetMs;
      const initial = await this.probeComposerTarget();
      let lastAssessment = assessFacebookHome(initial);
      let attempts = 1;
      if (!lastAssessment.ready) {
        this.log(
          `[fb-publish] stage=select_mode result=${lastAssessment.error} surface=${lastAssessment.surface} path=${lastAssessment.pathname} attempts=${attempts} elapsedMs=${Math.max(0, this.opts.now() - startedAt)}`,
        );
        return { ...base(payload), ok: false, error: lastAssessment.error };
      }
      if (initial.editorReady) {
        this.log(
          `[fb-publish] stage=select_mode result=already_open surface=${lastAssessment.surface} path=${lastAssessment.pathname} attempts=${attempts} elapsedMs=${Math.max(0, this.opts.now() - startedAt)}`,
        );
        return { ...base(payload), ok: true };
      }

      let target: FacebookComposerProbeOutcome | null =
        initial.found && typeof initial.x === 'number' && typeof initial.y === 'number'
          ? { kind: 'target', probe: initial }
          : null;
      const triggerDeadline = Math.min(deadline, startedAt + COMPOSER_TRIGGER_MAX_MS);
      const triggerBudgetMs = triggerDeadline - this.opts.now();
      if (!target && triggerBudgetMs > 0) {
        target = await this.waitUntil(triggerBudgetMs, async () => {
          const probe = await this.probeComposerTarget();
          attempts += 1;
          lastAssessment = assessFacebookHome(probe);
          if (!lastAssessment.ready) return { kind: 'home_failure' as const, probe };
          if (probe.editorReady) return { kind: 'already_open' as const, probe };
          if (probe.found && typeof probe.x === 'number' && typeof probe.y === 'number') {
            return { kind: 'target' as const, probe };
          }
          return null;
        });
      }

      if (target?.kind === 'home_failure') {
        this.log(
          `[fb-publish] stage=select_mode result=${lastAssessment.error} surface=${lastAssessment.surface} path=${lastAssessment.pathname} attempts=${attempts} elapsedMs=${Math.max(0, this.opts.now() - startedAt)}`,
        );
        return { ...base(payload), ok: false, error: lastAssessment.error };
      }
      if (target?.kind === 'already_open') {
        this.log(
          `[fb-publish] stage=select_mode result=already_open surface=${lastAssessment.surface} path=${lastAssessment.pathname} attempts=${attempts} elapsedMs=${Math.max(0, this.opts.now() - startedAt)}`,
        );
        return { ...base(payload), ok: true };
      }
      if (!target || target.kind !== 'target' || this.opts.now() >= deadline) {
        this.log(
          `[fb-publish] stage=select_mode result=composer_trigger_timeout surface=${lastAssessment.surface} path=${lastAssessment.pathname} attempts=${attempts} elapsedMs=${Math.max(0, this.opts.now() - startedAt)}`,
        );
        return { ...base(payload), ok: false, error: 'no_target' };
      }

      await dispatchClick(this.cdp, target.probe.x as number, target.probe.y as number, {
        overshoot: false,
        jitter: 0,
      });
      const remainingMs = deadline - this.opts.now();
      const ready = remainingMs > 0
        ? await this.waitUntil(remainingMs, () => this.editorReady())
        : false;
      const confirmedWithinDeadline = ready && this.opts.now() <= deadline;
      this.log(
        `[fb-publish] stage=select_mode result=${confirmedWithinDeadline ? 'composer_open' : 'composer_open_timeout'} surface=${lastAssessment.surface} path=${lastAssessment.pathname} attempts=${attempts} elapsedMs=${Math.max(0, this.opts.now() - startedAt)}`,
      );
      return confirmedWithinDeadline
        ? { ...base(payload), ok: true }
        : { ...base(payload), ok: false, error: 'post_validate_failed' };
    } catch (err) {
      return { ...base(payload), ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async readPageState(): Promise<FacebookPublishPageState> {
    return evalJson<FacebookPublishPageState>(
      this.cdp,
      `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify(fbPublishPageState()); })()`,
    );
  }

  /** 页面语境与入口坐标在同一 Runtime.evaluate 快照读取，避免校验后导航再消费旧坐标。 */
  private async probeComposerTarget(): Promise<FacebookComposerTargetProbe> {
    return evalJson<FacebookComposerTargetProbe>(
      this.cdp,
      `(function(){${FB_PUBLISH_HELPERS_JS} var state = fbPublishPageState(); var el = fbPublishComposerTrigger(); if (!el) return JSON.stringify(Object.assign(state, { found:false, x:null, y:null })); try { el.scrollIntoView({ block:'center' }); } catch(e) {} var r = el.getBoundingClientRect(); return JSON.stringify(Object.assign(state, { found:true, x:Math.round(r.left + r.width / 2), y:Math.round(r.top + r.height / 2) })); })()`,
    );
  }

  private async editorReady(): Promise<boolean> {
    return evalRaw<boolean>(
      this.cdp,
      `(function(){${FB_PUBLISH_HELPERS_JS} return !!fbPublishEditor(); })()`,
    ).catch(() => false);
  }

  private async uploadImage(
    payload: PublishCommandPayload,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    const imageUrl = payload.params.imageUrl;
    if (!this.uploader) return { ...base(payload), ok: false, error: 'kind_not_implemented' };
    if (!imageUrl) return { ...base(payload), ok: false, error: 'no_target' };
    // 上传器自管取消边界：下载段可取消、塞文件之后不可取消。
    const result = await this.uploader.upload(imageUrl, takeover);
    if (!result.ok) return { ...base(payload), ok: false, error: result.error ?? 'upload_failed' };
    return { ...base(payload), ok: true };
  }

  /** 读回编辑器当前文本（已按 fbPublishText 折叠空白）。编辑器不在 → null。 */
  private async readEditorText(): Promise<string | null> {
    const r = await evalJson<{ found: boolean; text: string }>(
      this.cdp,
      `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify(fbPublishEditorText()); })()`,
    ).catch(() => null);
    if (!r || !r.found) return null;
    return r.text;
  }

  /**
   * 清空编辑器（全选 + Backspace），并回读确认真的空了。
   *
   * 必要性：openComposer 见到已存在的编辑区会直接复用，而输入是在光标处**追加**——
   * 上一次失败留下的脏正文不清掉，就会和这一篇拼在一起发出去。
   */
  private async clearEditor(): Promise<ClearResult> {
    let residual: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const sel = await evalJson<{ found: boolean; selected: boolean }>(
        this.cdp,
        `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify(fbPublishSelectEditorContents()); })()`,
      ).catch(() => ({ found: false, selected: false }));
      // 编辑器不在（页面被导航走 / 弹层已关）≠ 编辑器里有清不掉的残文。两者 MUST 区分上报。
      if (!sel.found) return { cleared: false, residual: null, editorFound: false };
      if (!sel.selected) return { cleared: false, residual: await this.readEditorText(), editorFound: true };
      await dispatchKey(this.cdp, 'Backspace', 'Backspace', 8);
      residual = await this.readEditorText();
      if (residual === '') return { cleared: true, residual: '', editorFound: true };
      if (residual === null) return { cleared: false, residual: null, editorFound: false };
    }
    return { cleared: false, residual, editorFound: true };
  }

  /**
   * 放弃这一步：清场 + 诚实回报。绝不把「清不干净」谎报成干净页——运维据此知道
   * 浏览器里还躺着残文，而不是以为下一篇能干净地开工。
   *
   * 三态 MUST 分开：清干净了 / 编辑器已不在（无残文可留）/ 编辑器还在但清不掉（真脏页）。
   */
  private async abandonFill(
    payload: PublishCommandPayload,
    error: string,
  ): Promise<PublishCommandResultPayload> {
    const cleanup: ClearResult = await this.clearEditor().catch(() => ({
      cleared: false,
      residual: null,
      editorFound: true,
    }));
    const suffix = cleanup.cleared ? '' : cleanup.editorFound ? '_dirty_composer' : '_composer_gone';
    // 清空 ≠ 让位（change lease-strict-preemption task 3.3）：发帖弹层还盖在页面上，抢占者拿到执行权
    // 也看不见底下的 feed / 验证码。清干净之后 MUST 把弹层关掉，并回读确认它真的没了。
    const closed = await this.closeComposer();
    this.log(
      `[facebook-publish] 放弃正文填写 error=${error} cleared=${cleanup.cleared} editorFound=${cleanup.editorFound} composerClosed=${closed}`,
    );
    return { ...base(payload), ok: false, error: `${error}${suffix}` };
  }

  /**
   * 关闭发帖弹层并**回读确认真的关掉了**。返回 false = 弹层还在（页面没让干净）。
   * 关不掉不改写回执结论（这一步已经是失败路径），但日志必须说实话，让运维知道页面上还盖着弹层。
   */
  private async closeComposer(): Promise<boolean> {
    const r = await evalJson<{ dialogFound: boolean; clicked: boolean }>(
      this.cdp,
      `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify(fbPublishCloseComposer()); })()`,
    ).catch(() => ({ dialogFound: true, clicked: false }));
    if (!r.dialogFound) return true; // 本来就没有弹层
    if (!r.clicked) return false; // 找不到关闭键 / 点不动
    // 回读：点了 ≠ 关掉了。关闭本身可能再触发一个「放弃帖子？」确认框——那个由 CDP 层的对话框接管
    // 统一 accept（见 cdp/session.ts），此处只需等弹层消失。
    const gone = await this.waitUntil(this.opts.fillVerifyTimeoutMs, async () => {
      const still = await evalJson<{ dialogFound: boolean }>(
        this.cdp,
        `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify({ dialogFound: !!fbPublishDialog() }); })()`,
      ).catch(() => ({ dialogFound: true }));
      return still.dialogFound ? null : { gone: true };
    });
    return gone !== null;
  }

  /**
   * 正文填写。Facebook 的编辑器要逐字符输入（拒整段灌入），这是 O(正文长度) 的操作——
   * 因此它 MUST 在云端下发的单步预算（payload.timeoutMs）内自我掐表停手，否则上游放弃后
   * 这条循环仍在往活着的编辑器里写字，造成「上游已判失败、页面上却躺着半篇正文」的错位。
   *
   * 红线（不假成功）：插入调用没报错 ≠ 文本进去了。校验 MUST 回读**全文**——
   * 老的「前 20 字」探针会把「被吞掉 90%」判成成功，长正文一旦跑得完就会真发出截断的帖子。
   */
  private async fillContent(
    payload: PublishCommandPayload,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    if (payload.params.fieldType && payload.params.fieldType !== 'content') {
      this.log(`[facebook-publish] ignore unsupported fieldType=${payload.params.fieldType}`);
      return { ...base(payload), ok: true };
    }
    const value = payload.params.value ?? '';
    if (!value.trim()) return { ...base(payload), ok: false, error: 'empty_content' };

    const expected = normalizeEditorText(value);
    const budgetMs = payload.timeoutMs ?? this.opts.fillFallbackTimeoutMs;
    const typingDeadlineAt = this.opts.now() + Math.max(1_000, budgetMs - this.opts.fillReserveMs);

    try {
      const focus = await evalJson<{ found: boolean; focused: boolean }>(
        this.cdp,
        `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify(fbPublishFocusEditor()); })()`,
      );
      if (!focus.found) return { ...base(payload), ok: false, error: 'no_target' };
      if (!focus.focused) {
        // 聚焦是尽力而为、不是判据：Lexical 可能把焦点落在子节点上。真正的判据是打完后的全文回读。
        this.log('[facebook-publish] 编辑器已找到但焦点未落在其上，继续输入，以全文回读为准');
      }

      const before = await this.clearEditor();
      if (!before.editorFound) return { ...base(payload), ok: false, error: 'no_target' };
      if (!before.cleared) {
        const residual = (before.residual ?? '').slice(0, 40);
        return { ...base(payload), ok: false, error: `composer_not_clean: ${JSON.stringify(residual)}` };
      }

      await dispatchKeystrokes(this.cdp, value, {
        sleep: this.opts.sleep,
        deadlineAt: typingDeadlineAt,
        clock: this.opts.now,
        checkpoint: takeover?.checkpoint,
      });
    } catch (err) {
      // 🔴 顺序不能反：被接管必须先于死线分类。写反了，一次「让路」会被报成
      //    fill_deadline_exceeded（「我超预算了」≠「我没开始」），触上游的诚实闸。
      if (err instanceof TaskTakeoverError) {
        // 清场（清空 composer + 关弹层）后原样重抛，由上层 dispatch 统一分类成「未开始」。
        await this.abandonFill(payload, 'preempted_by_task').catch(() => undefined);
        throw err;
      }
      if (err instanceof InputDispatchDeadlineError) {
        return this.abandonFill(payload, `fill_deadline_exceeded: budget=${budgetMs}ms chars=${Array.from(value).length}`);
      }
      // 打字途中抛出的任何异常（CDP 命令超时 / 协议错误 / 断连）同样把半篇正文留在活着的编辑器里，
      // MUST 走同一条清场 + 诚实回报的路径——否则脏 composer 会被报成一次「干净的失败」，
      // 下一篇稿在复用的编辑区里接着追加。
      return this.abandonFill(payload, `engine_error: ${err instanceof Error ? err.message : String(err)}`);
    }

    const actual = await this.waitUntil(this.opts.fillVerifyTimeoutMs, async () => {
      const text = await this.readEditorText();
      return text !== null && text.includes(expected) ? { text } : null;
    });
    if (!actual) return this.abandonFill(payload, 'content_not_accepted');

    const extra = actual.text.length - expected.length;
    if (extra > FILL_EXTRA_CHAR_TOLERANCE) {
      return this.abandonFill(payload, `content_polluted: expected=${expected.length} actual=${actual.text.length}`);
    }
    return { ...base(payload), ok: true };
  }

  private async submit(payload: PublishCommandPayload, takeover?: TakeoverCtx): Promise<PublishCommandResultPayload> {
    // 已派发提交动作（6.2）：按下事件真正发出那一刻置真。center 查找 / no_target / 控件禁用等**点击之前**的失败保持 false。
    let submitDispatched = false;
    // 提交窗口守卫（5.1）：点「发布」前 enter、确认段内绝不被强杀，disposer 在 finally 关窗（时基兜底自动过期兜底）。
    let disposeCommit: (() => void) | undefined;
    try {
      const target = await evalJson<{ found: boolean; disabled: boolean; label: string | null; x: number | null; y: number | null }>(
        this.cdp,
        `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify(fbPublishSubmitControl()); })()`,
      );
      if (!target.found || typeof target.x !== 'number' || typeof target.y !== 'number') {
        return { ...base(payload), ok: false, error: 'no_target' };
      }
      if (target.disabled) return { ...base(payload), ok: false, error: 'submit_control_disabled' };
      // 🔴 提交窗口未开时的抢占在此被接住（复核 wf_1657e89b BLOCKER：FB submit 此前全程无取消点，
      //    target 查找期间被抢占→abort 对它无效→点击照发→云端却按 preempted 重投=双发）。
      //    checkpoint 与 enter() 之间**无 await**：抛出即点击前作废、零副作用；窗口一开协调器改回 window_busy、不再抢占。
      takeover?.checkpoint();
      // 🔴 不可逆提交窗口开启（5.1）：点击 → 确认段整体受保护，协调器此间不强杀（回 window_busy + 剩余预算）。
      disposeCommit = this.commitWindow?.enter(this.opts.submitVerifyTimeoutMs, 'fb_publish_submit');
      // 🔴 6.2：press 派发那一刻置真（onPressDispatched），即便 press 超时/release 抛出（点击可能已生效）也不谎报「压根没点」。
      await dispatchClick(this.cdp, target.x, target.y, {
        overshoot: false,
        jitter: 0,
        onPressDispatched: () => {
          submitDispatched = true;
        },
      });
      const submitted = await this.waitUntil(this.opts.submitVerifyTimeoutMs, () =>
        evalRaw<boolean>(
          this.cdp,
          `(function(){${FB_PUBLISH_HELPERS_JS} return fbPublishSubmittedSignal(); })()`,
        ).catch(() => false),
      );
      return submitted
        ? { ...base(payload), ok: true, submitDispatched }
        : { ...base(payload), ok: false, error: 'post_validate_failed', submitDispatched };
    } catch (err) {
      // 被接管（提交窗口前的 checkpoint）绝不降级成 engine_error：冒泡到 dispatch 顶层 catch 转 preempted_by_task。
      rethrowIfTakeover(err);
      return { ...base(payload), ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}`, submitDispatched };
    } finally {
      disposeCommit?.();
    }
  }

  private async capturePostId(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    try {
      const found = await this.waitUntil(this.opts.capturePostTimeoutMs, async () => {
        const post = await evalJson<{ postId: string; postUrl: string }>(
          this.cdp,
          `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify(fbPublishExtractPost()); })()`,
        ).catch(() => ({ postId: '', postUrl: '' }));
        return post.postId ? post : null;
      },
      );
      if (!found?.postId) return { ...base(payload), ok: false, error: 'no_target' };
      return {
        ...base(payload),
        ok: true,
        value: found.postId,
        ...(found.postUrl ? { postUrl: found.postUrl } : {}),
      };
    } catch (err) {
      return { ...base(payload), ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
