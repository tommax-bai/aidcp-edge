// Facebook 定向评论生产执行器（change facebook-scheduled-comment，task 4.x）。
//
// 把 phase-0 只读探针（page-structure / editor / gated-submit）升格为生产执行器，服务云端
// `runFacebookTargetedTask` 的真发三步：容器内搜索 → 开帖 → 提交评论并「服务器确认」。
//
// 安全不变量（贯穿全文件）：
// - 绝不全站搜索：容器必须是白名单内的合法 Facebook 链接，非法/非成员一律 honest `permission_gated`。
// - 绝不假成功：登录/验证码/checkpoint 在每步操作前 fresh 复检，命中即诚实非成功回执。
// - 成功判定收窄（F1 补丁②）：reload 后在「目标帖评论区 + 本人身份评论行 + 文本片段」三重命中才算
//   服务器确认；全页文本命中（旧探针 buildMarkerVisibleJs）不作数。缺本人 id 无法收窄 → 诚实 ambiguous、绝不提交。
// - 懒加载评论框（F1 补丁①）：提交前有界滚动催出视口外的评论框，滚不出即 `editor_not_found`、不硬提交。
//
// 所有 DOM 交互经 BrowseCdp（Runtime.evaluate 注入自包含 IIFE + Node 侧 JSON.parse），与探针同构、可用 { send } 桩单测。

import {
  dispatchKey,
  dispatchKeystrokes,
  evalJson,
  evalRaw,
  insertText,
  type BrowseCdp,
} from '../browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../browse/overlay-monitor.js';
import { FACEBOOK_TARGET } from './driver.js';
import { defaultFacebookConsentAccepter, type FacebookConsentAccepter } from './consent.js';
import { FACEBOOK_NUMERIC_ID_RE } from './identity.js';
import {
  classifyFacebookSurface,
  collectFacebookPageStructure,
  type FacebookPageStructureSummary,
} from './probes/page-structure.js';
import { isUrlAllowedByTargetDescriptor } from '../platform/driver.js';

/** 搜索/开帖/提交诚实非成功原因（与云端 outcome 映射对齐）。 */
export type FacebookCommentStepReason =
  | 'permission_gated' // 容器非法 / 非成员 / 待批准 / 群问答门槛
  | 'login_required' // 登录失效 / checkpoint / 账号恢复
  | 'blocked_by_consent' // cookie 同意浮层清不掉（认出但接受失败）
  | 'blocked_by_captcha' // 人机验证 / 未知阻断浮层
  | 'no_candidates' // 容器内搜索无可评论候选
  | 'not_facebook' // 链接非 Facebook（防御性）
  | 'open_failed' // 开帖后未落到帖子详情面
  | 'identity_unknown' // 本人稳定 id 未知——无法做 own-identity 收窄，绝不提交
  | 'editor_not_found' // 滚动催拉后仍无评论框
  | 'submit_control_not_found' // 无发布按钮
  | 'submit_control_disabled' // 发布按钮禁用（空/受限）
  | 'marker_not_accepted' // 受控输入未被编辑器接受
  | 'verification_ambiguous' // 提交后无法在目标帖评论区确认本人评论
  | 'nav_error'; // 导航/CDP 异常

/** 容器内搜索到的候选帖（permalink 作为云端 noteId）。 */
export interface FacebookCandidatePost {
  index: number;
  /** 规范化后的候选帖 permalink（云端据此下发 note.open{url}）。 */
  permalink: string;
  kind: 'group_post' | 'page_post' | 'story' | 'unknown';
  /** 该帖是否观测到评论区/评论框（供云端优选）。 */
  hasCommentRegion: boolean;
}

export interface FacebookSearchResult {
  ok: boolean;
  reason?: FacebookCommentStepReason;
  candidates: FacebookCandidatePost[];
  surface?: string;
  /**
   * 容器（群/主页）的真实人类可读名称（change facebook-container-display-name）。
   * 从容器页读出真名回传，供云端把配置里的容器名自动回填——人只看群名、不看 id。读不出为 undefined、不编造。
   */
  containerName?: string;
}

export interface FacebookOpenResult {
  ok: boolean;
  reason?: FacebookCommentStepReason;
  surface?: string;
  /** 开帖后是否已在视口内探到评论框（含滚动催拉后的复探）。 */
  editorReady: boolean;
  /**
   * 帖子文字正文（change facebook-comment-read-before-write）：图片帖常为空。best-effort、不臆造。
   * 供云端撰写器「读了再写」。
   */
  postText?: string;
  /** 帖子下他人评论正文样本（去作者名/界面词，顶部若干条）。供撰写器顺着讨论、用内容语言写。 */
  comments?: string[];
}

export interface FacebookSubmitResult {
  ok: boolean;
  reason?: FacebookCommentStepReason;
  /** 是否真的派发了提交点击（用于云端防重复：一旦 true，无论确认与否都视为已尝试）。 */
  submitted: boolean;
  /** reload 后是否在目标帖评论区 + 本人身份 + 文本片段三重命中。 */
  serverConfirmed: boolean;
}

export interface FacebookCommentExecutorDeps {
  cdp: BrowseCdp;
  /** 本人稳定数字 id（握手身份读出）；缺失 → submit 前诚实 identity_unknown、绝不提交。 */
  getAccountId: () => string | undefined;
  /** 旁路弹窗监测体；每步操作前 fresh 复检登录/验证码。缺省则退化为不阻断（仅结构探测把关）。 */
  overlayMonitor?: OverlayMonitor;
  /** cookie 同意浮层自动接受器（缺省用 env 策略）；每步阻断复检前置调用。 */
  acceptConsent?: FacebookConsentAccepter;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: (msg: string) => void;
}

export interface FacebookCommentExecutorOptions {
  /** 候选帖上限（有界抽取）。 */
  maxCandidates?: number;
  /** 每次导航后固定沉淀（等首屏渲染）。 */
  settleMs?: number;
  /** 催拉懒加载评论框的滚动轮数上限（每轮滚一屏、复探一次）。 */
  editorScrollRounds?: number;
  editorScrollDistancePx?: number;
  /** 结构探测的复探轮数（导航后等 surface 稳定）。 */
  surfaceProbeRounds?: number;
  /** 提交点击后 / reload 后的确认等待。 */
  waitAfterSubmitMs?: number;
  waitAfterReloadMs?: number;
  /** 读了再写：开帖后最多抽取的他人评论条数（供撰写器上下文）。 */
  maxComments?: number;
}

const DEFAULTS: Required<FacebookCommentExecutorOptions> = {
  maxCandidates: 8,
  settleMs: 2_500,
  editorScrollRounds: 6,
  editorScrollDistancePx: 700,
  surfaceProbeRounds: 4,
  waitAfterSubmitMs: 4_000,
  waitAfterReloadMs: 5_000,
  maxComments: 6,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function jsString(s: string): string {
  return JSON.stringify(s);
}

export class FacebookCommentExecutor {
  private readonly cdp: BrowseCdp;
  private readonly getAccountId: () => string | undefined;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly acceptConsent: FacebookConsentAccepter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookCommentExecutorOptions>;

  constructor(deps: FacebookCommentExecutorDeps, options: FacebookCommentExecutorOptions = {}) {
    this.cdp = deps.cdp;
    this.getAccountId = deps.getAccountId;
    this.overlayMonitor = deps.overlayMonitor;
    this.acceptConsent = deps.acceptConsent ?? defaultFacebookConsentAccepter();
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.logger ?? (() => {});
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * fresh 复检旁路弹窗；命中登录/验证码/未知 → 返回诚实原因，否则 undefined。
   * 探测本身抛错 → 保守当验证码（fail-closed，绝不带阻断继续操作）。
   *
   * 先清 cookie 同意浮层（良性合规横幅，先于阻断判定）：clear 后照常复检；
   * 认出但清不掉 → 诚实 blocked_by_consent，绝不带浮层继续。
   */
  private async blockingReason(): Promise<FacebookCommentStepReason | undefined> {
    try {
      const consent = await this.acceptConsent(this.cdp);
      if (consent.handled && !consent.cleared) return 'blocked_by_consent';
    } catch (err) {
      // 接受器自身异常不吞成阻断，也不假成功——记日志后继续走原阻断复检。
      this.log(`[fb-comment] consent accept error: ${(err as Error).message}`);
    }
    const monitor = this.overlayMonitor;
    if (!monitor) return undefined;
    let kind: OverlayKind;
    try {
      kind = await monitor.probeNow();
    } catch {
      return 'blocked_by_captcha';
    }
    if (kind === 'login') return 'login_required';
    if (kind === 'captcha' || kind === 'unknown') return 'blocked_by_captcha';
    return undefined;
  }

  private isAllowed(url: string): boolean {
    return isUrlAllowedByTargetDescriptor(url, FACEBOOK_TARGET);
  }

  private async navigate(url: string): Promise<void> {
    await this.cdp.send('Page.navigate', { url });
    await this.sleep(this.opts.settleMs);
  }

  /**
   * 读容器（群/主页）真实名称：og:title → group header h1 → 清洗后的 document.title。
   * 读不出返回 undefined（诚实：绝不用 id 冒充名称）。best-effort，不抛。
   */
  private async readContainerName(): Promise<string | undefined> {
    try {
      const raw = await evalJson<{ name: string | null }>(this.cdp, CONTAINER_NAME_JS);
      const name = (raw?.name ?? '').trim();
      return name.length > 0 ? name : undefined;
    } catch {
      return undefined;
    }
  }

  /** 有界复探页面结构，直到 surface 落到期望集合或轮数耗尽（返回最后一次探测）。 */
  private async probeStructureUntil(
    accept: (s: FacebookPageStructureSummary) => boolean,
  ): Promise<FacebookPageStructureSummary | null> {
    let last: FacebookPageStructureSummary | null = null;
    for (let i = 0; i < this.opts.surfaceProbeRounds; i++) {
      try {
        last = await collectFacebookPageStructure(this.cdp);
      } catch (err) {
        this.log(`[fb-comment] 结构探测失败：${(err as Error).message}`);
        last = null;
      }
      if (last && accept(last)) return last;
      if (i < this.opts.surfaceProbeRounds - 1) await this.sleep(600);
    }
    return last;
  }

  /**
   * 构造容器内搜索 URL。容器必须是白名单合法 Facebook 链接。
   * - 群（/groups/<id>）→ `<origin>/groups/<id>/search/?q=<kw>`
   * - 主页（单段路径）→ `<origin>/<page>/search/?q=<kw>`（无稳定站内搜路由的主页在探测阶段 honest 降级）
   * 返回 null = 容器无法归类到受支持的站内搜索面（绝不回退全站）。
   */
  private buildContainerSearchUrl(container: string, keyword: string): string | null {
    let url: URL;
    try {
      url = new URL(container);
    } catch {
      return null;
    }
    const surface = classifyFacebookSurface(container);
    const q = encodeURIComponent(keyword);
    const groupMatch = url.pathname.match(/^\/groups\/([^/]+)/);
    if (surface === 'group' || surface === 'group_post' || groupMatch) {
      const groupId = groupMatch?.[1];
      if (!groupId) return null;
      return `${url.origin}/groups/${groupId}/search/?q=${q}`;
    }
    if (surface === 'page') {
      const seg = url.pathname.split('/').filter(Boolean)[0];
      if (!seg) return null;
      return `${url.origin}/${seg}/search/?q=${q}`;
    }
    return null;
  }

  /**
   * 容器内关键词搜索 → 有界抽取候选帖 permalink。
   * 绝不全站搜：容器非法/无法归类/非成员 → honest permission_gated。
   */
  async searchInContainer(keyword: string, container: string): Promise<FacebookSearchResult> {
    const kw = (keyword ?? '').trim();
    if (!kw) return { ok: false, reason: 'no_candidates', candidates: [] };
    if (!this.isAllowed(container)) {
      this.log(`[fb-comment] 容器非白名单 Facebook 链接，permission_gated（绝不全站搜）：${container}`);
      return { ok: false, reason: 'permission_gated', candidates: [] };
    }
    const searchUrl = this.buildContainerSearchUrl(container, kw);
    if (!searchUrl) {
      this.log('[fb-comment] 容器无法归类到受支持的站内搜索面，permission_gated（绝不全站搜）');
      return { ok: false, reason: 'permission_gated', candidates: [] };
    }
    try {
      await this.navigate(searchUrl);
    } catch (err) {
      this.log(`[fb-comment] 导航容器搜索失败：${(err as Error).message}`);
      return { ok: false, reason: 'nav_error', candidates: [] };
    }
    const blocked = await this.blockingReason();
    if (blocked) return { ok: false, reason: blocked, candidates: [] };

    // 读容器真实名称（人只看群名、不看 id）——导航到容器搜索面后即可读，与候选无关，尽早捕获。
    const containerName = await this.readContainerName();

    // 催拉懒加载搜索结果（滚一屏、复探），直到探到**带 permalink 的**候选帖或轮数耗尽。
    // 关键：搜索结果页的帖子 article 先渲染、permalink 链接晚一拍才 hydrate——只等「有 article」会过早接受
    // 到一批无 permalink 的帖 → 候选空（no_candidates）。故接受条件收窄为「至少一条帖已带 permalink」。
    const hasPermalink = (s: FacebookPageStructureSummary): boolean =>
      s.postCandidates.some((p) => p.permalinkCandidates.length > 0);
    let structure = await this.probeStructureUntil(hasPermalink);
    for (let i = 0; i < this.opts.editorScrollRounds && !(structure && hasPermalink(structure)); i++) {
      await this.scrollViewport(this.opts.editorScrollDistancePx);
      structure = await this.probeStructureUntil(hasPermalink);
    }
    if (!structure) return { ok: false, reason: 'nav_error', candidates: [], containerName };

    // 非成员 / 待批准 / 群问答门槛 → 绝不评论，honest permission_gated。
    const m = structure.membership;
    if ((m.joinVisible && !m.joinedVisible) || m.pendingVisible || m.questionVisible) {
      return { ok: false, reason: 'permission_gated', candidates: [], surface: structure.surface, containerName };
    }
    // 结果面应是站内搜索面；落到 login/checkpoint（surface 归类）→ 登录失效。
    if (structure.surface === 'login') return { ok: false, reason: 'login_required', candidates: [], surface: 'login', containerName };
    if (structure.surface === 'checkpoint')
      return { ok: false, reason: 'blocked_by_captcha', candidates: [], surface: 'checkpoint', containerName };

    const candidates: FacebookCandidatePost[] = [];
    for (const post of structure.postCandidates) {
      const permalink = post.permalinkCandidates[0];
      if (!permalink) continue;
      candidates.push({
        index: candidates.length,
        permalink: permalink.href,
        kind: permalink.kind,
        hasCommentRegion: post.hasCommentRegion,
      });
      if (candidates.length >= this.opts.maxCandidates) break;
    }
    if (candidates.length === 0) return { ok: true, reason: 'no_candidates', candidates: [], surface: structure.surface, containerName };
    return { ok: true, candidates, surface: structure.surface, containerName };
  }

  /**
   * 按 permalink 直驱开帖 + 有界催拉懒加载评论框（F1 补丁①）。
   * 返回 editorReady=true 表示视口内已探到评论框（可进入提交）。
   */
  async openPost(url: string): Promise<FacebookOpenResult> {
    if (!this.isAllowed(url)) return { ok: false, reason: 'not_facebook', editorReady: false };
    try {
      await this.navigate(url);
    } catch (err) {
      this.log(`[fb-comment] 开帖导航失败：${(err as Error).message}`);
      return { ok: false, reason: 'nav_error', editorReady: false };
    }
    const blocked = await this.blockingReason();
    if (blocked) return { ok: false, reason: blocked, editorReady: false };

    let structure = await this.probeStructureUntil((s) => s.commentEditorCount > 0 || s.articleCount > 0);
    if (!structure) return { ok: false, reason: 'nav_error', editorReady: false };
    if (structure.surface === 'login') return { ok: false, reason: 'login_required', editorReady: false, surface: 'login' };
    if (structure.surface === 'checkpoint') return { ok: false, reason: 'blocked_by_captcha', editorReady: false, surface: 'checkpoint' };
    if (structure.articleCount === 0) return { ok: false, reason: 'open_failed', editorReady: false, surface: structure.surface };

    // F1 补丁①：评论框常在首屏之下懒渲染——有界滚动催拉，每轮复探评论框计数。
    let editorReady = structure.commentEditorCount > 0;
    for (let i = 0; i < this.opts.editorScrollRounds && !editorReady; i++) {
      await this.scrollViewport(this.opts.editorScrollDistancePx);
      structure = await this.probeStructureUntil((s) => s.commentEditorCount > 0);
      editorReady = Boolean(structure && structure.commentEditorCount > 0);
    }
    // 读了再写：滚动已催出评论区后，抽帖子正文（图片帖常空）+ 顶部他人评论，供云端撰写器用内容语言顺着讨论写。
    const content = await this.readPostContent();
    return {
      ok: true,
      editorReady,
      surface: structure?.surface,
      ...(content.postText ? { postText: content.postText } : {}),
      ...(content.comments.length > 0 ? { comments: content.comments } : {}),
    };
  }

  /**
   * 抽帖子文字正文 + 顶部他人评论（change facebook-comment-read-before-write）。
   * 正文：主帖 article 的 story_message / 最长非链接文本块，图片帖常为空。
   * 评论：嵌套 article（评论条目）里去作者名/界面词后的正文，顶部 maxComments 条。best-effort、不抛。
   */
  private async readPostContent(): Promise<{ postText?: string; comments: string[] }> {
    try {
      const raw = await evalJson<{ postText: string | null; comments: string[] }>(
        this.cdp,
        buildPostContentJs(this.opts.maxComments),
      );
      const postText = (raw?.postText ?? '').trim();
      const comments = Array.isArray(raw?.comments) ? raw.comments.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
      return { ...(postText ? { postText } : {}), comments };
    } catch (err) {
      this.log(`[fb-comment] 读帖子内容失败：${(err as Error).message}`);
      return { comments: [] };
    }
  }

  /**
   * 在当前已打开的目标帖 permalink 上提交评论并做「服务器确认」。
   * 顺序：本人 id 前置 → fresh 阻断复检 → 催拉+聚焦评论框 → 受控输入 → 找发布控件 → 提交前二次 fresh 复检 →
   *       点击提交 → reload → own-identity + 目标帖评论区 + 文本片段 三重收窄确认。
   * 任一确认未达 → verification_ambiguous（诚实非成功，绝不以乐观渲染冒充）。
   */
  async submitComment(targetUrl: string, text: string, contactInfo?: string): Promise<FacebookSubmitResult> {
    const body = (text ?? '').trim();
    if (!body) return { ok: false, reason: 'marker_not_accepted', submitted: false, serverConfirmed: false };
    // 本人稳定 id 是「服务器确认」收窄的必要条件；缺则绝不提交（宁可不发，也不发了无法确认）。
    const ownId = this.getAccountId();
    if (!ownId || !FACEBOOK_NUMERIC_ID_RE.test(ownId)) {
      this.log('[fb-comment] 本人稳定数字 id 未知——无法做 own-identity 服务器确认，identity_unknown（不提交）');
      return { ok: false, reason: 'identity_unknown', submitted: false, serverConfirmed: false };
    }
    const blockedPre = await this.blockingReason();
    if (blockedPre) return { ok: false, reason: blockedPre, submitted: false, serverConfirmed: false };

    // 催拉 + 聚焦评论框（F1 补丁①再保险：submit 独立入口也需自证评论框在位）。
    const focus = await this.focusEditorWithScroll();
    if (focus.reason) return { ok: false, reason: focus.reason, submitted: false, serverConfirmed: false };

    // 受控输入（逐字符拟人）。
    await dispatchKeystrokes(this.cdp, body, { sleep: this.sleep });
    const accepted = await evalJson<{ accepted: boolean }>(this.cdp, buildMarkerAcceptedJs(body));
    if (!accepted?.accepted) {
      await this.clearEditorBestEffort();
      return { ok: false, reason: 'marker_not_accepted', submitted: false, serverConfirmed: false };
    }
    const code = contactInfo && contactInfo.length > 0 ? contactInfo : '';
    if (code) {
      await insertText(this.cdp, `\n${code}`);
      this.log(`[fb-comment] 联系方式整段插入（${code.length} 字，绕过逐字补全）`);
    }

    // 提交前二次 fresh 复检验证码：真验证码绝不硬提交（清空编辑器不留痕）。
    const blockedMid = await this.blockingReason();
    if (blockedMid) {
      await this.clearEditorBestEffort();
      return { ok: false, reason: blockedMid, submitted: false, serverConfirmed: false };
    }

    // 提交：FB 评论/回答框**回车即发**（语言无关，不依赖按钮文案；Shift+Enter 才换行）。
    // 受控输入后可能失焦——先再聚焦一次，确保 Enter 落在编辑器上；随后按 Enter 提交。
    // （旧版按按钮文案 `发布评论|Post|…` 定位提交控件在西语/问答帖上会 submit_control_not_found；回车更稳。）
    await evalJson<FocusEditorResult>(this.cdp, FOCUS_EDITOR_JS);
    await dispatchKey(this.cdp, 'Enter', 'Enter', 13);
    await this.sleep(this.opts.waitAfterSubmitMs);
    // reload 后做 own-identity 收窄确认（F1 补丁②）：绝不用乐观渲染 / 全页文本命中冒充成功。
    try {
      await this.cdp.send('Page.reload', { ignoreCache: true });
    } catch (err) {
      this.log(`[fb-comment] reload 失败：${(err as Error).message}`);
      return { ok: false, reason: 'verification_ambiguous', submitted: true, serverConfirmed: false };
    }
    await this.sleep(this.opts.waitAfterReloadMs);
    let confirmed = false;
    try {
      const verify = await evalJson<ScopedVerifyResult>(this.cdp, buildScopedVerifyJs(body, ownId, targetUrl));
      confirmed = Boolean(verify?.confirmed);
    } catch (err) {
      this.log(`[fb-comment] 服务器确认探测失败：${(err as Error).message}`);
      confirmed = false;
    }
    if (!confirmed) return { ok: false, reason: 'verification_ambiguous', submitted: true, serverConfirmed: false };
    return { ok: true, submitted: true, serverConfirmed: true };
  }

  /** 催拉 + 聚焦评论框；返回 reason 表示失败（editor_not_found / permission_gated）。 */
  private async focusEditorWithScroll(): Promise<{ reason?: FacebookCommentStepReason }> {
    for (let i = 0; i <= this.opts.editorScrollRounds; i++) {
      const focus = await evalJson<FocusEditorResult>(this.cdp, FOCUS_EDITOR_JS);
      if (focus?.permissionGated) return { reason: 'permission_gated' };
      if (focus?.focused) return {};
      if (i < this.opts.editorScrollRounds) await this.scrollViewport(this.opts.editorScrollDistancePx);
    }
    return { reason: 'editor_not_found' };
  }

  private async clearEditorBestEffort(): Promise<void> {
    try {
      await evalRaw<string>(this.cdp, SELECT_EDITOR_CONTENTS_JS);
      await dispatchKey(this.cdp, 'Backspace', 'Backspace', 8);
    } catch {
      /* best-effort：清空失败不影响诚实回执 */
    }
  }

  /** 视口滚动催拉懒加载：真 wheel 事件优先，JS scrollBy 兜底。 */
  private async scrollViewport(distance: number): Promise<void> {
    try {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 400,
        y: 400,
        deltaX: 0,
        deltaY: distance,
      });
    } catch {
      /* 桩/无 Input 域时忽略 */
    }
    try {
      await evalRaw<unknown>(this.cdp, `window.scrollBy(0, ${Math.round(distance)})`);
    } catch {
      /* best-effort */
    }
    await this.sleep(500);
  }
}

// ─────────────────────────────── 内联页面脚本（自包含 IIFE，返回 JSON.stringify）───────────────────────────────

interface FocusEditorResult {
  found: boolean;
  focused: boolean;
  permissionGated: boolean;
}


interface ScopedVerifyResult {
  confirmed: boolean;
  matchedText: boolean;
  matchedOwnIdentity: boolean;
  articleCount: number;
}

/** 共享页内工具：可见性、评论框判定、群问答/入群门禁判定。 */
const FB_EXEC_HELPERS_JS = `
  function fbVisible(el){ if(!el) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; }
  function fbText(el){ return ((el&&el.innerText)||'').replace(/\\s+/g,' ').trim(); }
  function fbIsCommentEditor(el){ if(!el) return false; var lab=((el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('data-placeholder')||el.getAttribute('placeholder')))||''); if(/写评论|发表评论|Write a comment|Comment as|Comment|输入回答|Answer/i.test(lab)) return true; return /写评论|Write a comment/i.test(fbText(el)); }
  function fbIsGroupQuestionEditor(el){ var lab=((el&&el.getAttribute&&el.getAttribute('aria-label'))||''); return /输入回答|Answer/i.test(lab); }
  function fbJoinSignalVisible(){ try{ if(!/\\/groups\\//.test(location.pathname)) return false; return /(加入小组|Join group|\\bJoin\\b|待批准|Pending|回答问题|Answer questions)/i.test(document.body.innerText||''); }catch(e){ return false; } }
  function fbEditors(){ return Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).filter(function(el){ return fbVisible(el)&&fbIsCommentEditor(el); }); }
`;

/**
 * 读容器真实群名。真机实证：群内**搜索页与群主页**的 document.title 都是「(N) <群名> | Facebook」形态
 * （N=未读数前缀），群名稳定藏在这里；而搜索页的 h1 是「搜索结果」（会误当群名）。故顺序：
 * og:title（群主页偶有、干净）→ 清洗后的 document.title（去「(N) 」未读前缀 + 去「| Facebook」尾缀）→ h1，
 * 且每步都过「通用词」过滤（搜索结果/Search results/Facebook/群组/首页 等一律丢，绝不当群名）。
 * 读不出返回 null——诚实，云端据此不回填、绝不用 id 或界面词冒充群名。
 */
const CONTAINER_NAME_JS = `(function(){
  function clean(s){ return String(s||'').replace(/\\s+/g,' ').replace(/^\\(\\d+\\+?\\)\\s*/,'').replace(/\\s*[|\\-–·]\\s*Facebook\\s*$/i,'').trim(); }
  function generic(s){ return !s || /^(搜索结果|搜尋結果|Search results?|Resultados|Facebook|群组|群組|Groups?|首页|首頁|Home)$/i.test(s); }
  var og=document.querySelector('meta[property="og:title"]'); var ogv=og?clean(og.getAttribute('content')):'';
  if(ogv && !generic(ogv)) return JSON.stringify({name:ogv});
  var tv=clean(document.title);
  if(tv && !generic(tv)) return JSON.stringify({name:tv});
  var h1=document.querySelector('[role="main"] h1, h1'); var hv=h1?clean(h1.innerText||h1.textContent):'';
  if(hv && !generic(hv)) return JSON.stringify({name:hv});
  return JSON.stringify({name: null});
})()`;

/**
 * 读了再写：抽帖子正文 + 顶部他人评论（change facebook-comment-read-before-write）。
 * - 主帖 = 不被其他 article 包含的顶层 [role=article]；评论 = 嵌套 article（探针实证：主帖 + N 条嵌套评论）。
 * - 正文：story_message 优先，否则主帖里最长的「非链接、非界面词」文本块；图片帖常为空 → null。
 * - 评论正文：每条评论 article 里，取最长的「非作者链接、非界面词」文本块（作者名在 <a> 里、界面词是短块）。
 * - 界面词过滤（本号 FB 界面为中文/英文）：赞/回复/分享/查看翻译/关注/时间数字等。
 */
function buildPostContentJs(maxComments: number): string {
  return `(function(){
    function t(el){return ((el&&el.innerText)||'').replace(/\\s+/g,' ').trim();}
    var CHROME=/^(赞|回复|分享|查看翻译|隐藏|关注|举报|编辑|删除|置顶|Like|Reply|Share|See translation|Follow|Hide|\\d+\\s*(分钟|小时|天|周|年|min|h|d|w|y)?|[·•]|)$/i;
    function isChrome(s){ return !s || s.length<2 || CHROME.test(s); }
    function inAnchor(node){ var p=node; while(p){ if(p.tagName==='A') return true; p=p.parentElement; } return false; }
    function inAny(node, roots){ for(var i=0;i<roots.length;i++){ if(roots[i]!==node && roots[i].contains(node)) return true; } return false; }
    // 取 root 下的文本块节点（非链接、非嵌套 exclude 内、非界面词），返回其文本。
    function blockTexts(root, exclude){
      return Array.prototype.slice.call(root.querySelectorAll('div[dir="auto"]'))
        .filter(function(d){ return !inAnchor(d) && !inAny(d, exclude||[]); })
        .map(t).filter(function(s){ return !isChrome(s); });
    }
    function longest(arr){ var best=''; for(var i=0;i<arr.length;i++){ if(arr[i].length>best.length) best=arr[i]; } return best; }
    var arts=Array.prototype.slice.call(document.querySelectorAll('[role="article"], article'));
    function isNested(a){ return arts.some(function(b){ return b!==a && b.contains(a); }); }
    var top=arts.filter(function(a){ return !isNested(a); });
    var comments=arts.filter(isNested);
    var post=top[0]||null;
    var postText=null;
    if(post){
      var sm=post.querySelector('[data-ad-rendering-role="story_message"],[data-ad-comet-preview="message"]');
      var smt=sm?t(sm):'';
      // 主帖正文：story_message 优先；否则取主帖里「排除嵌套评论区」后的最长文本块（图片帖常为空）。
      postText = (smt && !isChrome(smt)) ? smt : (longest(blockTexts(post, comments)) || null);
      if(postText) postText=postText.slice(0,600);
    }
    // 疑似「纯人名」（1-4 个首字母大写词、无句子小写词/标点）→ 丢：这类是标记好友/回复空评论，非实义讨论。
    function looksLikeName(s){ return /^([A-ZÁÉÍÓÚÑ][\\wáéíóúñ'’.-]*\\s+){0,3}[A-ZÁÉÍÓÚÑ][\\wáéíóúñ'’.-]*$/.test(s) && s.split(/\\s+/).length<=4; }
    function authorOf(c){ var a=c.querySelector('a[href*="/user/"],a[href*="profile.php?id="],a[href*="/groups/"][role="link"]'); return a?t(a):''; }
    var out=[]; var seen={};
    for(var k=0;k<comments.length && out.length<${Math.max(1, Math.floor(maxComments))};k++){
      var author=authorOf(comments[k]);
      var all=blockTexts(comments[k], []);
      var blocks=author ? all.filter(function(s){ return s!==author && s.indexOf(author)!==0; }) : all;
      var body=longest(blocks);
      if(!body || looksLikeName(body)) continue;   // 空 / 纯人名 → 跳过
      var key=body.slice(0,60);
      if(seen[key]) continue; seen[key]=1;          // 去重
      out.push(body.slice(0,240));
    }
    return JSON.stringify({postText:postText, comments:out});
  })()`;
}

/**
 * 催拉后聚焦评论/回答框，聚焦成功即可评论。
 * 注意：**不再**在此做入群/群问答门禁。真机实证两类假阳：(1) 全页 body 的「加入/Join」词会命中侧栏/推荐群 chrome，
 * 把已入群成员误判未入群；(2) **问答型帖子**的回复框 aria-label 是「输入回答…/Answer」（与入群问答同文案），
 * 但那是合法的回帖框、答一条即评论。成员身份已在搜索期由 membership 闸核过（搜到候选=可访问该群帖），
 * 且此处已找到真实可聚焦的评论框——直接聚焦。真正的入群/待批准在搜索期就 permission_gated 了。
 */
const FOCUS_EDITOR_JS = `(function(){${FB_EXEC_HELPERS_JS}
  var eds=fbEditors();
  if(eds.length===0) return JSON.stringify({found:false,focused:false,permissionGated:false});
  var el=eds[0];
  try{ el.scrollIntoView({block:'center'}); }catch(e){}
  try{ el.focus(); }catch(e){}
  var focused=document.activeElement===el;
  return JSON.stringify({found:true,focused:focused,permissionGated:false});
})()`;

/** 受控输入后校验 marker 已被编辑器接受（编辑器文本含该片段）。 */
function buildMarkerAcceptedJs(text: string): string {
  return `(function(){${FB_EXEC_HELPERS_JS}
    var eds=fbEditors(); var el=eds[0]||document.activeElement;
    var t=fbText(el);
    return JSON.stringify({accepted: t.indexOf(${jsString(text.trim())})>=0});
  })()`;
}

/** 全选评论编辑器内容（配合 Backspace 清空，不提交）。 */
const SELECT_EDITOR_CONTENTS_JS = `(function(){${FB_EXEC_HELPERS_JS}
  var eds=fbEditors(); var el=eds[0]||document.activeElement; if(!el) return 'no-editor';
  try{ el.focus(); var range=document.createRange(); range.selectNodeContents(el); var sel=getSelection(); sel.removeAllRanges(); sel.addRange(range); return 'selected'; }catch(e){ return 'err:'+e.message; }
})()`;

/**
 * F1 补丁②：own-identity + 目标帖评论区 + 文本片段 三重收窄确认。
 * - 目标帖优选：article 内含指向 targetUrl 的链接，否则退到首个 article。
 * - 在其评论区找评论节点：文本含片段（前 60 字）且节点内有指向本人数字 id 的作者链接。
 * - 全页文本命中（旧探针）不作数；缺任一命中 → confirmed=false。
 */
function buildScopedVerifyJs(text: string, ownId: string, targetUrl: string): string {
  const fragment = text.trim().slice(0, 60);
  let targetPath = '';
  try {
    targetPath = new URL(targetUrl).pathname;
  } catch {
    targetPath = '';
  }
  return `(function(){${FB_EXEC_HELPERS_JS}
    var frag=${jsString(fragment)}; var ownId=${jsString(ownId)}; var targetPath=${jsString(targetPath)};
    var articles=Array.prototype.slice.call(document.querySelectorAll('[role="article"], article'));
    if(articles.length===0) return JSON.stringify({confirmed:false,matchedText:false,matchedOwnIdentity:false,articleCount:0});
    var target=null;
    if(targetPath){ for(var i=0;i<articles.length;i++){ var links=articles[i].querySelectorAll('a[href]'); for(var j=0;j<links.length;j++){ if((links[j].getAttribute('href')||'').indexOf(targetPath)>=0){ target=articles[i]; break; } } if(target) break; } }
    if(!target) target=articles[0];
    // 评论节点：article 内的评论条目（role=article 嵌套 / [aria-label*=Comment/评论]），退化为整个 target。
    var commentNodes=Array.prototype.slice.call(target.querySelectorAll('[role="article"], [aria-label*="评论"], [aria-label*="Comment"]'));
    if(commentNodes.length===0) commentNodes=[target];
    var matchedText=false, matchedOwn=false;
    for(var k=0;k<commentNodes.length;k++){ var node=commentNodes[k];
      var txt=fbText(node); var hasText=frag.length>0 && txt.indexOf(frag)>=0; if(!hasText) continue; matchedText=true;
      var authorLinks=node.querySelectorAll('a[href*="/profile.php?id="], a[href*="/people/"], a[href*="user/"]');
      for(var a=0;a<authorLinks.length;a++){ if((authorLinks[a].getAttribute('href')||'').indexOf(ownId)>=0){ matchedOwn=true; break; } }
      if(matchedText&&matchedOwn) break;
    }
    return JSON.stringify({confirmed:matchedText&&matchedOwn,matchedText:matchedText,matchedOwnIdentity:matchedOwn,articleCount:articles.length});
  })()`;
}
