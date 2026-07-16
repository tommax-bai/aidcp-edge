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
import { canonicalPostId, FB_TARGET_HELPERS_JS } from './post-identity.js';
import { TaskTakeoverError } from '../execution/takeover.js';
import type { CommitWindowGuard } from '../execution/commit-window.js';
import { scrollFacebookViewport } from './viewport-scroll.js';

/**
 * Facebook 评论编辑框的 aria-label / placeholder 识别（跨 UI 语言 + 文案变体）。
 *
 * 真机实证（zh-Hans 界面、群帖详情页）评论框 aria-label 是「发表公开评论…」——旧表里的 `发表评论`
 * 不含中间「公开」二字、`发表评论` 子串不连续 → 正则漏匹配 → fbEditors() 恒空 → 误报 editor_not_found，
 * 该账号评论**从未发出过一次**。这里改按「评论」概念宽匹配，覆盖真机变体与该账号定向的越南语/西语群
 * （界面语言可能被切到 vi/es）。
 *
 * 宽匹配之所以安全：本正则只作用在**可见的** `[contenteditable="true"][role="textbox"]`（见 fbEditors）——
 * 「用贴图/动图/头像评论」等虽含「评论」字样但是 role=button，被选择器天然排除，不会被误当输入框。
 *   zh 写评论 / 发表评论 / 发表公开评论 / 以…身份发表评论 / 评论 / 留言 · en Write a (public) comment / Comment as ·
 *   vi (Viết) bình luận (công khai) · es Comentar / comentario · 群问答帖回答框 输入回答 / Answer
 *
 * 该来源字符串**同时**喂给页内 IIFE（见 FB_EXEC_HELPERS_JS 的 fbIsCommentEditor）与可单测的 TS 断言
 * isFacebookCommentEditorLabel，二者共用 `.source`、绝不再各写一份漂移出第二个漏配。
 */
export const FB_COMMENT_EDITOR_LABEL_RE = /评论|留言|comment|bình luận|coment|输入回答|answer/i;

/** 与页内 fbIsCommentEditor 同源的评论框标签断言，供单测直接校验语言/变体覆盖（无需真实 DOM/可见性）。 */
export function isFacebookCommentEditorLabel(label: string | null | undefined): boolean {
  return FB_COMMENT_EDITOR_LABEL_RE.test(String(label ?? ''));
}

/**
 * 「待管理员审批」指示（change facebook-comment-participation-gate）。
 * 群参与审批下，账号首条评论只对作者可见、带此徽章、**未上墙**——命中即**否决**「已上墙」确认（红线：待审 ≠ 已发出）。
 * `.source` 同时喂页内 IIFE 与可单测 TS 断言，绝不各写一份漂移。真机文案未逐字坐实前用高置信超集（见 change §5）。
 */
export const FB_PENDING_APPROVAL_RE =
  /待审核|待审批|待批准|等待(?:管理员)?(?:审核|审批|批准)|(?:管理员)?(?:审核|批准)后(?:才)?可见|通过后(?:才)?可见|需(?:要|经)?管理员(?:审核|批准)|pending review|pending approval|awaiting (?:admin(?:istrator)? )?approval|needs? admin(?:istrator)? approval|visible (?:once|after) approved|will be visible (?:once|after)/i;

/** 与页内同源的「待审批」文本断言，供单测直接校验中英文案覆盖（无需真实 DOM）。 */
export function isFacebookPendingApprovalText(text: string | null | undefined): boolean {
  return FB_PENDING_APPROVAL_RE.test(String(text ?? ''));
}

/**
 * 群「参与审批 / 参与问题」入群闸文案（change facebook-comment-participation-gate）。
 * **只**用于**对话框作用域**检测（见 buildParticipationGateJs），绝不整页 body 扫——避开两类已知假阳：
 * 侧栏/推荐群的「加入/Join」chrome、问答型帖子合法回复框的「输入回答/Answer」。因此用的是参与审批**专属**短语，
 * 不含单独的「回答问题/Answer questions」。真机文案未逐字坐实前用高置信超集（英文取自 FB 帮助 verbatim；见 change §5）。
 */
export const FB_PARTICIPATION_GATE_RE =
  /申请参与|请求参与|参与此(?:小组|群)|贡献(?:内容)?给?(?:此|这个)?(?:小组|群)|参与问题|同意(?:此|该|小组|群).{0,4}规则|同意群规|request to participate|participation question|answer questions to participate|contribute to (?:this|the) group|agree to the group rules|待审核|pending review/i;

/** 与页内同源的「参与审批闸」文本断言，供单测直接校验中英文案覆盖（无需真实 DOM）。 */
export function isFacebookParticipationGateText(text: string | null | undefined): boolean {
  return FB_PARTICIPATION_GATE_RE.test(String(text ?? ''));
}

/** 搜索/开帖/提交诚实非成功原因（与云端 outcome 映射对齐）。 */
export type FacebookCommentStepReason =
  | 'permission_gated' // 容器非法 / 非成员 / 待批准 / 群问答门槛
  | 'pending_group_approval' // 群参与审批入群闸：评论未上墙、待管理员批准（区别于搜索期 permission_gated；submitted=false）
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
  /**
   * 提交窗口守卫（change lease-strict-preemption 5.1）：评论回车提交前 `enter()`、确认后 `dispose()`。
   * 未注入 = 抢占能力休眠、行为逐字不变。与浏览会话共用同一 browse 侧实例。
   */
  commitWindow?: CommitWindowGuard;
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
  /** 提交后就地确认前的初始沉淀（等乐观渲染出现）/ reload 后确认前的初始沉淀。 */
  waitAfterSubmitMs?: number;
  waitAfterReloadMs?: number;
  /** 就地 ack 门控确认（不刷新）的有界轮询轮数与间隔（治「秒退」误判、抓服务器点头即成功）。 */
  inPlaceVerifyRounds?: number;
  inPlaceVerifyIntervalMs?: number;
  /** 刷新兜底后的有界轮询轮数与间隔（替代「死等一次」，治慢渲染假阴性 P2②）。 */
  reloadVerifyRounds?: number;
  reloadVerifyIntervalMs?: number;
  /** 读了再写：开帖后最多抽取的他人评论条数（供撰写器上下文）。 */
  maxComments?: number;
}

const DEFAULTS: Required<FacebookCommentExecutorOptions> = {
  maxCandidates: 8,
  settleMs: 2_500,
  editorScrollRounds: 6,
  editorScrollDistancePx: 700,
  surfaceProbeRounds: 4,
  waitAfterSubmitMs: 500,
  waitAfterReloadMs: 2_500,
  inPlaceVerifyRounds: 32,
  inPlaceVerifyIntervalMs: 300,
  reloadVerifyRounds: 8,
  reloadVerifyIntervalMs: 800,
  maxComments: 6,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function jsString(s: string): string {
  return JSON.stringify(s);
}

function textFragment(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 60);
}

function requiredTextFragments(body: string, contactInfo?: string): string[] {
  return [textFragment(body), contactInfo ? textFragment(contactInfo) : ''].filter(Boolean);
}

/**
 * FB 评论 id 的乐观占位前缀（客户端本地生成、服务器点头**前**就渲染在评论行上）——
 * 真机探针实证：回车后 ~68ms 就带 `comment_id=client…`，服务器写入响应 ~3.5s 才到、之后 id 才升级为正式格式。
 * 绝不据乐观占位判成功（会 over-confirm，红线）。
 */
const FB_CLIENT_COMMENT_ID_RE = /^client/i;
/** FB 服务器正式评论 id 前缀（base64 "comment:"）——服务器点头**后**才有，是 ack-gated 的硬信号。 */
const FB_SERVER_COMMENT_ID_RE = /^Y29tbWVudD/;

/**
 * 判某个 `comment_id` 值是否为**服务器正式 id**（而非乐观占位）。TS 与页内 JS 同源（注入 `.source`）。
 * 保守：只认正式前缀、明确排除 client 占位；前缀变体识别不出时宁可返回 false（退到点赞/回复信号或刷新兜底，安全降级、绝不 over-confirm）。
 */
export function isServerFacebookCommentId(value: string): boolean {
  const v = (value ?? '').trim();
  if (!v || FB_CLIENT_COMMENT_ID_RE.test(v)) return false;
  return FB_SERVER_COMMENT_ID_RE.test(v);
}

export class FacebookCommentExecutor {
  private readonly cdp: BrowseCdp;
  private readonly getAccountId: () => string | undefined;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly acceptConsent: FacebookConsentAccepter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random?: () => number;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookCommentExecutorOptions>;
  private readonly commitWindow?: CommitWindowGuard;

  constructor(deps: FacebookCommentExecutorDeps, options: FacebookCommentExecutorOptions = {}) {
    this.cdp = deps.cdp;
    this.getAccountId = deps.getAccountId;
    this.overlayMonitor = deps.overlayMonitor;
    this.acceptConsent = deps.acceptConsent ?? defaultFacebookConsentAccepter();
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random;
    this.log = deps.logger ?? (() => {});
    this.opts = { ...DEFAULTS, ...options };
    this.commitWindow = deps.commitWindow;
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
   * 顺序：本人 id 前置 → fresh 阻断复检 → 催拉+聚焦评论框 → 受控输入 → 提交前二次 fresh 复检 → 回车提交 →
   *   (1) 就地 ack 门控快确认（不刷新）：仅当「本人+文本」评论行上出现**服务器正式评论 id** 或 **点赞/回复交互控件**
   *       才算成功——二者皆服务器点头后才有；乐观渲染、客户端占位 id、全页文本命中一律不算（真机探针实证，绝不 over-confirm）。
   *   (2) 兜底：刷新一次 + **有界轮询**三重收窄确认（own-identity + 目标帖评论区 + 文本片段），
   *       替代旧「死等一次」——治慢渲染下评论已在服务器却没在单次窗口重渲染的假阴性（P2②）。
   * 两条都确认不了 → verification_ambiguous（诚实非成功，去重标记照打、不重发）。
   */
  async submitComment(
    targetUrl: string,
    text: string,
    contactInfo?: string,
    /**
     * 安全取消点（change lease-strict-preemption 4.1）：被独占任务接管即抛出。
     * 最后一个取消点在**回车之前**——FB 评论回车即发，此后取消 = 把一条可能已经发出去的评论当成
     * 没发生 ⇒ 上游重试 ⇒ 重复评论。打字中途取消 MUST 清场（FB 侧没有「输入前先清空」的守卫，
     * 半截评论留下会直接接在下一条前面发出去）。
     */
    checkpoint?: () => void,
  ): Promise<FacebookSubmitResult> {
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

    // 目标帖的规范身份：评论框、marker 验收、清空、服务器确认**全部**收窄到这一帖的作用域内，
    // 绝不再 document 级取第一个编辑框（那会把一次真实的对外写入落到别人帖子底下）。
    const targetPostId = canonicalPostId(targetUrl);
    if (!targetPostId) {
      this.log(`[fb-comment] 目标帖 URL 派生不出规范帖身份（${targetUrl}）——无法收窄评论框，editor_not_found（不提交）`);
      return { ok: false, reason: 'editor_not_found', submitted: false, serverConfirmed: false };
    }

    const code = contactInfo && contactInfo.length > 0 ? contactInfo : '';
    const requiredFragments = requiredTextFragments(body, code);
    // 提交窗口守卫（5.1）：回车（536）前 enter，确认段（禁区）内绝不被强杀；enter 在最后取消点之后赋值，
    // 取消/失败早退时仍为 undefined ⇒ dispose 为 no-op、绝不干扰既有清场。
    let disposeCommit: (() => void) | undefined;
    try {
      checkpoint?.(); // 聚焦/滚动是页面写 → 查在它之前（此刻零副作用）

      // 催拉 + 聚焦**目标帖作用域内**的评论框（F1 补丁①再保险：submit 独立入口也需自证评论框在位）。
      const focus = await this.focusEditorWithScroll(targetPostId);
      if (focus.reason) return { ok: false, reason: focus.reason, submitted: false, serverConfirmed: false };

      // 群参与审批入群闸（打字前）：若已弹出参与审批对话框，聚焦可能落在「输入回答」答题框上——**绝不**把营销评论
      // 灌进答题框（那会把评论当参与答案提交、暴露自动化痕迹）。诚实 pending_group_approval（未打字、无需清场）。
      if (await this.participationGateVisible()) {
        this.log('[fb-comment] 打字前识别到群参与审批入群闸——不把评论灌进答题框，pending_group_approval');
        return { ok: false, reason: 'pending_group_approval', submitted: false, serverConfirmed: false };
      }

      // 受控输入（逐字符拟人）。
      await dispatchKeystrokes(this.cdp, body, { sleep: this.sleep, checkpoint });
      const accepted = await evalJson<{ accepted: boolean }>(this.cdp, buildMarkerAcceptedJs(body, targetPostId));
      if (!accepted?.accepted) {
        await this.clearEditorBestEffort(targetPostId);
        return { ok: false, reason: 'marker_not_accepted', submitted: false, serverConfirmed: false };
      }
      if (code) {
        // 真机探针实证：正文逐字输入后，再用单次 Input.insertText 灌入 "\n+联系方式" 会被 FB/React
        // 编辑器吞掉整段；换行和联系方式逐字符输入可稳定进入编辑器。
        await dispatchKeystrokes(this.cdp, `\n${code}`, { sleep: this.sleep, checkpoint });
        const contactAccepted = await evalJson<{ accepted: boolean }>(
          this.cdp,
          buildEditorContainsFragmentsJs(requiredFragments, targetPostId),
        );
        if (!contactAccepted?.accepted) {
          this.log(`[fb-comment] 联系方式追加后未被编辑器验收（${code.length} 字）——不提交，避免裸发`);
          await this.clearEditorBestEffort(targetPostId);
          return { ok: false, reason: 'marker_not_accepted', submitted: false, serverConfirmed: false };
        }
        this.log(`[fb-comment] 联系方式逐字符追加并验收通过（${code.length} 字）`);
      }

      // 提交前二次 fresh 复检验证码：真验证码绝不硬提交（清空编辑器不留痕）。
      const blockedMid = await this.blockingReason();
      if (blockedMid) {
        await this.clearEditorBestEffort(targetPostId);
        return { ok: false, reason: blockedMid, submitted: false, serverConfirmed: false };
      }

      // 🔴 整条评论流的**最后一个安全取消点**：回车即发。
      checkpoint?.();

      // 提交：FB 评论/回答框**回车即发**（语言无关，不依赖按钮文案；Shift+Enter 才换行）。
      // 受控输入后可能失焦——先再聚焦一次，确保 Enter 落在编辑器上；随后按 Enter 提交。
      // （旧版按按钮文案 `发布评论|Post|…` 定位提交控件在西语/问答帖上会 submit_control_not_found；回车更稳。）
      await evalJson<FocusEditorResult>(this.cdp, buildFocusEditorJs(targetPostId));
      // 🔴 提交窗口开启（5.1）：回车即发，确认段整体受保护，协调器此间不强杀（回 window_busy + 剩余预算）。
      disposeCommit = this.commitWindow?.enter(20000, 'fb_comment_enter');
      await dispatchKey(this.cdp, 'Enter', 'Enter', 13);
    } catch (err) {
      disposeCommit?.(); // 回车派发时的 CDP 故障：关窗（takeover 早退时 disposeCommit 仍 undefined、no-op）。
      if (err instanceof TaskTakeoverError) {
        // 让位前 MUST 清场：FB 侧打字前**只聚焦、不清空**，半截评论留在编辑器里会直接接在下一条
        // 前面发出去（真·对外内容污染）。三条既有失败分支都是这么干的，照抄。
        await this.clearEditorBestEffort(targetPostId).catch(() => undefined);
      }
      throw err;
    }
    // 🔴 回车已发出：以下确认段 MUST NOT 取消（禁区）。窗口在确认段结束（四条出口）由 finally 关闭。
    try {
      // (1) 就地 ack 门控快确认（不刷新，抓服务器点头即成功、比刷新又快又准）。
      const ack = await this.inPlaceAckConfirm(requiredFragments, ownId, targetPostId);
      if (ack.confirmed) {
        return { ok: true, submitted: true, serverConfirmed: true };
      }
      // 群参与审批入群闸：本人首条评论只对作者可见、带「待审核」徽章（ack.pendingApproval），或页面有参与审批对话框。
      // 评论**未上墙**——诚实 pending_group_approval（submitted:false），**不刷新**（reload 会刷掉徽章/对话框掩盖证据）、不重试。
      if (ack.pendingApproval || (await this.participationGateVisible())) {
        this.log('[fb-comment] 识别到群参与审批入群闸——评论未上墙、待管理员批准，pending_group_approval（不刷新、不重试）');
        return { ok: false, reason: 'pending_group_approval', submitted: false, serverConfirmed: false };
      }
      // (2) 兜底：刷新一次 + 有界轮询三重收窄确认（治慢渲染假阴性；提交后误导性报错浮层不当作失败，确认信号权威）。
      try {
        await this.cdp.send('Page.reload', { ignoreCache: true });
      } catch (err) {
        this.log(`[fb-comment] reload 失败：${(err as Error).message}`);
        return { ok: false, reason: 'verification_ambiguous', submitted: true, serverConfirmed: false };
      }
      const reloaded = await this.reloadScopedConfirm(requiredFragments, ownId, targetPostId);
      if (reloaded.confirmed) {
        return { ok: true, submitted: true, serverConfirmed: true };
      }
      // 刷新后仍见「本人+文本+待审核徽章」评论行 → 同样是参与审批未上墙。
      if (reloaded.pendingApproval) {
        this.log('[fb-comment] 刷新后见待审批评论行——评论未上墙、待管理员批准，pending_group_approval');
        return { ok: false, reason: 'pending_group_approval', submitted: false, serverConfirmed: false };
      }
      return { ok: false, reason: 'verification_ambiguous', submitted: true, serverConfirmed: false };
    } finally {
      disposeCommit?.();
    }
  }

  /**
   * 就地 ack 门控确认（不刷新）：有界轮询，命中「服务器正式评论 id 或 点赞/回复交互控件」即成功。
   * 有界轮次 + 注入式 sleep（不用 wall-clock 循环），测试可确定性驱动。
   */
  private async inPlaceAckConfirm(
    requiredFragments: string[],
    ownId: string,
    targetPostId: string | null,
  ): Promise<{ confirmed: boolean; pendingApproval: boolean }> {
    await this.sleep(this.opts.waitAfterSubmitMs);
    let pendingApproval = false;
    for (let i = 0; i < this.opts.inPlaceVerifyRounds; i++) {
      if (i > 0) await this.sleep(this.opts.inPlaceVerifyIntervalMs);
      try {
        const v = await evalJson<AckVerifyResult>(this.cdp, buildAckVerifyJs(requiredFragments, ownId, targetPostId));
        if (v?.pendingApproval) pendingApproval = true;
        if (v?.ackConfirmed) return { confirmed: true, pendingApproval: false };
      } catch (err) {
        this.log(`[fb-comment] 就地 ack 确认探测失败：${(err as Error).message}`);
      }
    }
    return { confirmed: false, pendingApproval };
  }

  /**
   * 刷新兜底后有界轮询三重收窄确认（own-identity + 目标帖评论区 + 文本片段）。
   * 替代旧「reload 后死等一次」：慢渲染下评论已在服务器却没在单次窗口重渲染 → 多查几眼即命中（治 P2② 假阴性）。
   */
  private async reloadScopedConfirm(
    requiredFragments: string[],
    ownId: string,
    targetPostId: string | null,
  ): Promise<{ confirmed: boolean; pendingApproval: boolean }> {
    await this.sleep(this.opts.waitAfterReloadMs);
    let pendingApproval = false;
    for (let i = 0; i < this.opts.reloadVerifyRounds; i++) {
      if (i > 0) await this.sleep(this.opts.reloadVerifyIntervalMs);
      try {
        const v = await evalJson<ScopedVerifyResult>(this.cdp, buildScopedVerifyJs(requiredFragments, ownId, targetPostId));
        if (v?.pendingApproval) pendingApproval = true;
        if (v?.confirmed) return { confirmed: true, pendingApproval: false };
      } catch (err) {
        this.log(`[fb-comment] 刷新确认探测失败：${(err as Error).message}`);
      }
    }
    return { confirmed: false, pendingApproval };
  }

  /**
   * 群参与审批入群闸探针（change facebook-comment-participation-gate）：可见 role=dialog + 参与审批专属文案。
   * 命中 = 评论未上墙、待管理员批准。探测失败一律返回 false（漏检回落 verification_ambiguous 仍诚实、不假绿）。
   */
  private async participationGateVisible(): Promise<boolean> {
    try {
      const r = await evalJson<ParticipationGateResult>(this.cdp, buildParticipationGateJs());
      return !!r?.gate;
    } catch (err) {
      this.log(`[fb-comment] 参与审批闸探测失败：${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 催拉 + 聚焦**目标帖作用域内**的评论框；返回 reason 表示失败（editor_not_found / permission_gated）。
   * 作用域内 0 个评论框 → editor_not_found，**绝不回落 document 第一个编辑框**（红线：不评错帖）。
   */
  private async focusEditorWithScroll(targetPostId: string | null): Promise<{ reason?: FacebookCommentStepReason }> {
    for (let i = 0; i <= this.opts.editorScrollRounds; i++) {
      const focus = await evalJson<FocusEditorResult>(this.cdp, buildFocusEditorJs(targetPostId));
      if (focus?.permissionGated) return { reason: 'permission_gated' };
      if (focus?.focused) return {};
      if (i < this.opts.editorScrollRounds) await this.scrollViewport(this.opts.editorScrollDistancePx);
    }
    return { reason: 'editor_not_found' };
  }

  private async clearEditorBestEffort(targetPostId: string | null): Promise<void> {
    try {
      await evalRaw<string>(this.cdp, buildSelectEditorContentsJs(targetPostId));
      await dispatchKey(this.cdp, 'Backspace', 'Backspace', 8);
    } catch {
      /* best-effort：清空失败不影响诚实回执 */
    }
  }

  /** 视口滚动催拉懒加载：复用 FB 惯性手势，且不在 wheel 已生效后双滚。 */
  private async scrollViewport(distance: number): Promise<void> {
    await scrollFacebookViewport(this.cdp, {
      distancePx: distance,
      random: this.random,
      sleep: this.sleep,
      logger: this.log,
    });
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
  /** 「本人+文本」评论行带「待管理员审批」徽章 → 未上墙（群参与审批）。绝不判 confirmed。 */
  pendingApproval?: boolean;
}

interface AckVerifyResult {
  /** 「本人+文本」评论行上出现服务器正式 id 或 点赞/回复交互控件 → 服务器已点头。 */
  ackConfirmed: boolean;
  serverId: boolean;
  reactions: number;
  /** 「本人+文本」评论行带「待管理员审批」徽章 → 未上墙（群参与审批）。绝不判 ackConfirmed。 */
  pendingApproval?: boolean;
}

interface ParticipationGateResult {
  /** 页面存在「可见 role=dialog」且文案含参与审批专属短语 → 群参与审批入群闸。 */
  gate: boolean;
  scope?: string;
}

/** 共享页内工具：可见性、评论框判定、群问答/入群门禁判定。 */
const FB_EXEC_HELPERS_JS = `
  function fbVisible(el){ if(!el) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; }
  function fbText(el){ return ((el&&el.innerText)||'').replace(/\\s+/g,' ').trim(); }
  function fbIsCommentEditor(el){ if(!el) return false; var lab=((el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('data-placeholder')||el.getAttribute('placeholder')))||''); var re=/${FB_COMMENT_EDITOR_LABEL_RE.source}/i; if(re.test(lab)) return true; return re.test(fbText(el)); }
  function fbIsGroupQuestionEditor(el){ var lab=((el&&el.getAttribute&&el.getAttribute('aria-label'))||''); return /输入回答|Answer/i.test(lab); }
  function fbJoinSignalVisible(){ try{ if(!/\\/groups\\//.test(location.pathname)) return false; return /(加入小组|Join group|\\bJoin\\b|待批准|Pending|回答问题|Answer questions)/i.test(document.body.innerText||''); }catch(e){ return false; } }
  var FB_PENDING_APPROVAL_RE=/${FB_PENDING_APPROVAL_RE.source}/i;
  // 评论行是否带「待管理员审批」徽章（只查该行自身 innerText——徽章内联在行内；false-veto 安全、漏 veto 才危险）。
  function fbNodePendingApproval(node){ try{ return !!node && FB_PENDING_APPROVAL_RE.test(fbText(node)); }catch(e){ return false; } }
`;

/**
 * 目标帖作用域内的评论框（change facebook-note-scoped-targeting）。
 *
 * 旧实现 `fbEditors()` 是 **document 级**取第一个可见评论框（`eds[0]`）——多编辑框页面（详情页下方还挂着
 * 别的帖 / 评论回复框）会把一次**真实的对外写入**落到别人帖子底下。这里按命令携带的规范帖身份把编辑框
 * 收窄到目标帖：
 *  1. 目标卡（三段式解析出的**唯一** article）子树内的评论框——首选；
 *  2. 子树内没有（FB 常把评论输入框渲染在 article 之外、同一帖容器之内）→ 退到目标帖的**排他区域**
 *     （从目标卡向上爬、不混进任何别的顶层帖 article 的最大祖先），只取该区域内**不属于任何 article** 的
 *     评论框——区域内没有第二张帖，故它只可能属于目标帖。这**不是**「取 document 第一个」，而是唯一性可证的作用域；
 *     嵌套评论条目里的**回复框**因 `closest('[role=article]')!==null` 被排除，不会把评论发成回复。
 *  3. 都没有 → 空数组 → 调用方诚实 `editor_not_found`，**绝不回落 `eds[0]`**。
 */
export function buildScopedEditorHelpersJs(targetPostId: string | null): string {
  return `${FB_TARGET_HELPERS_JS}${FB_EXEC_HELPERS_JS}
  var FB_TARGET_POST_ID=${targetPostId ? jsString(targetPostId) : 'null'};
  function fbAllEditors(){ return Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).filter(function(el){ return fbVisible(el)&&fbIsCommentEditor(el); }); }
  function fbEditors(){
    var target=fbTgtResolve(FB_TARGET_POST_ID).el;
    if(!target) return [];                                             // 目标帖解析不出 → 诚实空，绝不乱写
    var all=fbAllEditors();
    // ① 目标卡子树内的评论框（嵌套评论条目里的**回复框** closest!==target，天然排除）。
    var inArticle=all.filter(function(el){ return fbTgtClosestArticle(el)===target; });
    if(inArticle.length>0) return inArticle;
    // ② 退到目标帖的排他区域（区域内没有第二张帖）。区域内**必须唯一**——多于一个就诚实拒，
    //    绝不「取第一个」（那正是本 change 要根除的 DOM 序回落）。
    var region=fbTgtExclusiveRegion(target);
    if(!region) return [];
    var inRegion=all.filter(function(el){ return region.contains(el) && fbTgtClosestArticle(el)===null; });
    return inRegion.length===1 ? inRegion : [];
  }
`;
}

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
function buildFocusEditorJs(targetPostId: string | null): string {
  return `(function(){${buildScopedEditorHelpersJs(targetPostId)}
  var eds=fbEditors();
  if(eds.length===0) return JSON.stringify({found:false,focused:false,permissionGated:false});
  var el=eds[0];
  try{ el.scrollIntoView({block:'center'}); }catch(e){}
  try{ el.focus(); }catch(e){}
  var focused=document.activeElement===el;
  return JSON.stringify({found:true,focused:focused,permissionGated:false});
})()`;
}

/**
 * 群「参与审批 / 参与问题」入群闸探针（change facebook-comment-participation-gate）。
 * **只**认「可见 `role="dialog"`」且其文案含**参与审批专属短语**（FB_PARTICIPATION_GATE_RE）——
 * 绝不整页 `document.body.innerText` 扫，正是为避开 buildFocusEditorJs 注释里记的两类假阳（侧栏 Join chrome、
 * 问答帖合法回复框「输入回答/Answer」）。命中 = 评论未上墙、待管理员批准（诚实 pending_group_approval）。
 * 首版只覆盖对话框形态；若真机实证为非 dialog 的全屏 interstitial，再按 §5 取证扩面。
 */
export function buildParticipationGateJs(): string {
  return `(function(){${FB_EXEC_HELPERS_JS}
    try{
      var GATE_RE=/${FB_PARTICIPATION_GATE_RE.source}/i;
      var dialogs=Array.prototype.slice.call(document.querySelectorAll('[role="dialog"]'));
      for(var i=0;i<dialogs.length;i++){ var d=dialogs[i]; if(!fbVisible(d)) continue; if(GATE_RE.test(fbText(d))) return JSON.stringify({gate:true,scope:'dialog'}); }
      return JSON.stringify({gate:false});
    }catch(e){ return JSON.stringify({gate:false}); }
  })()`;
}

/** 受控输入后校验 marker 已被编辑器接受（**目标帖作用域内**的编辑器文本含该片段）。 */
function buildMarkerAcceptedJs(text: string, targetPostId: string | null): string {
  return `(function(){${buildScopedEditorHelpersJs(targetPostId)}
    var eds=fbEditors(); var el=eds[0]||document.activeElement;
    var t=fbText(el);
    return JSON.stringify({accepted: t.indexOf(${jsString(text.trim())})>=0});
  })()`;
}

function buildEditorContainsFragmentsJs(fragments: string[], targetPostId: string | null): string {
  return `(function(){${buildScopedEditorHelpersJs(targetPostId)}
    var eds=fbEditors(); var el=eds[0]||document.activeElement;
    var t=fbText(el);
    var fragments=${JSON.stringify(fragments)};
    var accepted=fragments.length>0 && fragments.every(function(f){ return f && t.indexOf(f)>=0; });
    return JSON.stringify({accepted:accepted});
  })()`;
}

/** 全选评论编辑器内容（配合 Backspace 清空，不提交）。 */
function buildSelectEditorContentsJs(targetPostId: string | null): string {
  return `(function(){${buildScopedEditorHelpersJs(targetPostId)}
  var eds=fbEditors(); var el=eds[0]||document.activeElement; if(!el) return 'no-editor';
  try{ el.focus(); var range=document.createRange(); range.selectNodeContents(el); var sel=getSelection(); sel.removeAllRanges(); sel.addRange(range); return 'selected'; }catch(e){ return 'err:'+e.message; }
})()`;
}

/**
 * F1 补丁②：own-identity + 目标帖评论区 + 文本片段 三重收窄确认。
 * - 目标帖：先按**规范帖身份**三段式解析（唯一命中才算）；解析不出再退到「全文档里唯一一张**携带目标身份锚**的
 *   article」。两者都落空 → confirmed=false（诚实）。**不再退到首个 article、也不再按 URL pathname 子串挑**——
 *   `multi_permalinks` 形态的 targetUrl 其 pathname 只是 `/groups/<id>`，子串命中群页里几乎任何链接 → 又变成
 *   「取 DOM 序第一张卡」（对抗性评审复现）。
 * - 在其评论区找**评论行**：文本含片段（前 60 字）且节点内有指向本人数字 id 的作者链接。
 * - **绝不退化成整帖 article**（见 buildAckVerifyJs 的同款说明）：那会拿编辑器里还没发出去的正文冒充成功。
 */
export function buildScopedVerifyJs(requiredFragments: string[], ownId: string, targetPostId: string | null): string {
  return `(function(){${buildScopedEditorHelpersJs(targetPostId)}
    var fragments=${JSON.stringify(requiredFragments)}; var ownId=${jsString(ownId)};
    function hasAllFragments(txt){ return fragments.length>0 && fragments.every(function(f){ return f && txt.indexOf(f)>=0; }); }
    var articles=Array.prototype.slice.call(document.querySelectorAll('[role="article"], article'));
    if(articles.length===0) return JSON.stringify({confirmed:false,matchedText:false,matchedOwnIdentity:false,articleCount:0});
    var target=fbTgtResolve(FB_TARGET_POST_ID).el;
    if(!target){ var carriers=[];
      for(var i=0;i<articles.length;i++){ if(fbTgtArticleCarriesId(articles[i], FB_TARGET_POST_ID)) carriers.push(articles[i]); }
      if(carriers.length===1) target=carriers[0];
    }
    if(!target) return JSON.stringify({confirmed:false,matchedText:false,matchedOwnIdentity:false,articleCount:articles.length});
    // 评论行：目标帖内的评论条目（嵌套 role=article / [aria-label*=Comment/评论]），排除编辑框本身。
    var commentNodes=Array.prototype.slice.call(target.querySelectorAll('[role="article"], [aria-label*="评论"], [aria-label*="Comment"]'))
      .filter(function(n){ return n.getAttribute('contenteditable')!=='true'; });
    if(commentNodes.length===0) return JSON.stringify({confirmed:false,matchedText:false,matchedOwnIdentity:false,articleCount:articles.length});
    var matchedText=false, matchedOwn=false, sawPending=false, confirmedNode=false;
    for(var k=0;k<commentNodes.length;k++){ var node=commentNodes[k];
      var txt=fbText(node); var hasText=hasAllFragments(txt); if(!hasText) continue; matchedText=true;
      var authorLinks=node.querySelectorAll('a[href*="/profile.php?id="], a[href*="/people/"], a[href*="user/"]'); var ownOnNode=false;
      for(var a=0;a<authorLinks.length;a++){ if((authorLinks[a].getAttribute('href')||'').indexOf(ownId)>=0){ ownOnNode=true; break; } }
      if(!ownOnNode) continue; matchedOwn=true;
      // 🔴 待审批否决（同 buildAckVerifyJs）：本人+文本评论行带「待审核」徽章 = 未上墙，绝不判 confirmed。
      if(fbNodePendingApproval(node)){ sawPending=true; continue; }
      confirmedNode=true; break;
    }
    return JSON.stringify({confirmed:confirmedNode,matchedText:matchedText,matchedOwnIdentity:matchedOwn,articleCount:articles.length,pendingApproval:sawPending});
  })()`;
}

/**
 * 就地 ack 门控确认（不刷新）：在「本人身份 + 文本片段」收窄到的评论行上，判服务器点头信号——
 * ① 服务器正式评论 id（非 client 乐观占位，与 isServerFacebookCommentId 同源）；② 点赞/回复交互控件（乐观阶段为 0）。
 * 任一命中即 ackConfirmed。语言无关（不吃任何 locale 文案）。红线：绝不据乐观渲染/占位 id 冒充成功。
 */
export function buildAckVerifyJs(requiredFragments: string[], ownId: string, targetPostId: string | null): string {
  return `(function(){${buildScopedEditorHelpersJs(targetPostId)}
    var fragments=${JSON.stringify(requiredFragments)}; var ownId=${jsString(ownId)};
    function hasAllFragments(txt){ return fragments.length>0 && fragments.every(function(f){ return f && txt.indexOf(f)>=0; }); }
    var CLIENT_RE=/${FB_CLIENT_COMMENT_ID_RE.source}/i; var SERVER_RE=/${FB_SERVER_COMMENT_ID_RE.source}/;
    function serverId(href){ var m=/[?&](?:reply_comment_id|comment_id)=([^&]+)/i.exec(href||''); if(!m) return false; var v=''; try{ v=decodeURIComponent(m[1]); }catch(e){ v=m[1]; } if(!v||CLIENT_RE.test(v)) return false; return SERVER_RE.test(v); }
    var articles=Array.prototype.slice.call(document.querySelectorAll('[role="article"], article'));
    if(articles.length===0) return JSON.stringify({ackConfirmed:false,serverId:false,reactions:0});
    var target=fbTgtResolve(FB_TARGET_POST_ID).el;
    if(!target){ var carriers=[];
      for(var i=0;i<articles.length;i++){ if(fbTgtArticleCarriesId(articles[i], FB_TARGET_POST_ID)) carriers.push(articles[i]); }
      if(carriers.length===1) target=carriers[0];
    }
    if(!target) return JSON.stringify({ackConfirmed:false,serverId:false,reactions:0});
    // 评论行 = 目标帖内的**嵌套 article**。**绝不退化成整帖 article**：帖子还没有任何评论时，整帖节点里
    // 既有编辑器里那段还没发出去的正文、又有本人头像链接、还有帖级动作栏的 3 个 role=button（≥2）——
    // 三条全中 → 一个字都没发出去也会被判成「服务器已点头」（假成功，对抗性评审复现）。
    var nodes=Array.prototype.slice.call(target.querySelectorAll('[role="article"]'));
    if(nodes.length===0) return JSON.stringify({ackConfirmed:false,serverId:false,reactions:0});
    var sawPending=false;
    for(var k=0;k<nodes.length;k++){ var node=nodes[k];
      var txt=fbText(node); if(!hasAllFragments(txt)) continue;
      var owns=node.querySelectorAll('a[href*="/profile.php?id="], a[href*="/people/"], a[href*="user/"]'); var ownHit=false;
      for(var a=0;a<owns.length;a++){ if((owns[a].getAttribute('href')||'').indexOf(ownId)>=0){ ownHit=true; break; } }
      if(!ownHit) continue;
      // 🔴 待审批否决（change facebook-comment-participation-gate）：群参与审批下本人首条评论只对作者可见、带
      // 「待审核」徽章、**未上墙**——即便带服务器 id 或 ≥2 交互控件也**绝不**判 ackConfirmed（否则假绿）。
      if(fbNodePendingApproval(node)){ sawPending=true; continue; }
      var hasServer=false; var idl=node.querySelectorAll('a[href*="comment_id="]');
      for(var b=0;b<idl.length;b++){ if(serverId(idl[b].getAttribute('href'))){ hasServer=true; break; } }
      var reactions=node.querySelectorAll('[role="button"]').length;
      if(hasServer || reactions>=2){ return JSON.stringify({ackConfirmed:true,serverId:hasServer,reactions:reactions}); }
    }
    return JSON.stringify({ackConfirmed:false,serverId:false,reactions:0,pendingApproval:sawPending});
  })()`;
}
