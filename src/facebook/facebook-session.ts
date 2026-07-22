/**
 * Facebook 浏览会话（change facebook-browse-and-like-loop）。
 *
 * 装配闸（main.ts）在 Facebook driver 声明 'browse' 后，据平台解析到本会话（而非小红书 BrowseSession）——
 * design 的「browse 能力翻转与 FB BrowseSession 原子同落」不变量。它独占 edge-client 的单槽 browseHandler，
 * 因此**必须同时承载评论/加群**（FB 声明 browse 后，旧 comment-only 注册闸 `(comment||join)&&!browse` 不再触发）：
 * 评论/搜索/加群/按 url 开帖【委托】给现成 {@link FacebookCommentHandler}（原样、已测），浏览/点赞/翻页/返回/
 * 按 permalink 深读由本会话新增。
 *
 * 平台无关的编排在云端 role-dispatcher（feed.entered→pick→open→deep-read→interact→back），本会话只是
 * 平台执行器：把云端命令翻成 FB DOM 操作、把结构化结果按【既有平台中立消息】上报（page.cards / note.detail /
 * action.completed）。首页空态/Reels 只使用 page.cards 的向后兼容可选观察字段，不新增消息类型。
 *
 * 红线：
 *  - 每条命令恰好一个诚实回执（page.cards / note.detail / action.completed）；有界超时兜底 timeout 回执，
 *    绝不静默丢弃 / 假成功（否则云端 sendAndAwait + idle 看门狗挂死）。
 *  - kill switch `AIDCP_FB_BROWSE_AUTO`（三态 off/shadow/on）：off=不自动浏览/点赞（评论/加群仍服务）；
 *    shadow=浏览+上报但点赞只记不执行；on=真点赞。默认 off。
 *  - FB 无收藏/看图；关注只在 Reels 当前作者区具备 note-bound 执行器，其它 FB surface 仍诚实回
 *    capability_unsupported，绝不臆造。
 */

import { type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayMonitor } from '../browse/overlay-monitor.js';
import { jitterAround } from '../humanize/index.js';
import type { EdgeBrowseSession } from '../browse/edge-browse-session.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TaskTakeoverError, BrowseQuiesceTimeoutError, DEFAULT_TASK_QUIESCE_MS } from '../browse/browse-session.js';
import type {
  Envelope,
  ActionCompletedPayload,
  NoteDetailPayload,
  NoteOpenPayload,
  InteractionLikePayload,
  InteractionFollowPayload,
  PageCardsPayload,
  PageScrollPayload,
  SearchExecutePayload,
  ProfileDetailPayload,
  ProfileOpenPayload,
  PacingOp,
  PacingFloorPayload,
} from '../comm/protocol.js';
import type { PlatformDriver } from '../platform/driver.js';
import { FACEBOOK_DEFAULT_START_URL } from './driver.js';
import { readFacebookIdentity } from './identity.js';
import { FacebookFeedReader, type FacebookFeedCard, type FacebookFeedSettleResult } from './feed-reader.js';
import { FacebookPostReader } from './post-reader.js';
import { FacebookLikeExecutor, type FacebookLikeObservation } from './like-executor.js';
import { FacebookInlineReader } from './inline-reader.js';
import { FacebookReelsReader, type FacebookReelCard, FACEBOOK_REELS_ENTRY_URL } from './reels-reader.js';
import { FacebookCommentHandler } from './comment-handler.js';
import { canonicalPostId } from './post-identity.js';
import { defaultFacebookConsentAccepter, type FacebookConsentAccepter } from './consent.js';
import {
  emitCompanionUiEvent as emitCompanionUiEventLine,
  facebookFeedVideoViewUiText,
  facebookLikeUiText,
  facebookReadUiText,
  facebookReelViewUiText,
  isAttempted,
  reasonText,
  type FacebookCompanionUiEvent,
} from './companion-ui.js';

export type FacebookBrowseMode = 'off' | 'shadow' | 'on';

/** 解析 kill switch：默认 off。'shadow' → 浏览但点赞只记不执行；'on'/'true'/'1' → 真点赞。 */
export function parseFacebookBrowseMode(env: Record<string, string | undefined> = process.env): FacebookBrowseMode {
  const v = String(env.AIDCP_FB_BROWSE_AUTO ?? '').trim().toLowerCase();
  if (v === 'shadow') return 'shadow';
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return 'on';
  return 'off';
}

/**
 * 协变落地判定（co-landing）：声明 'browse' 的 Facebook edge 解析到 FacebookBrowseSession（绝不小红书）。
 * main.ts 用它选会话；测试用它锁死不变量。
 */
export function usesFacebookBrowseSession(driver: PlatformDriver): boolean {
  return driver.platform === 'facebook' && driver.capabilities.includes('browse');
}

/**
 * 将协议消息名归一为云端编排消费的动作名。
 *
 * `action.completed.action` 是云端角色之间的关联键，而不是协议消息名。即使 Facebook
 * 当前不支持某个原子动作，也必须回报这里的规范动作名；否则云端会把
 * `note.browse_images` 误当成未知失败并在详情页下发 feed scroll。
 */
const FB_COMMAND_ACTION_NAMES: Readonly<Record<string, string>> = {
  'page.scroll': 'scroll',
  'feed.refresh': 'refresh',
  'interaction.like': 'like',
  'interaction.collect': 'collect',
  'interaction.follow': 'follow',
  'interaction.comment': 'comment',
  'interaction.like_comment': 'comment_like',
  'search.execute': 'search',
  'note.open': 'open_note',
  'note.close': 'close',
  'note.browse_images': 'browse_images',
  'note.scroll_comments': 'scroll_comments',
  'navigation.back': 'back',
  'profile.open': 'profile_open',
  'group.join': 'join_group',
  'notification.open': 'open_notifications',
  'notification.browse_comments': 'browse_notification_comments',
  'notification.browse_likes': 'browse_notification_likes',
  'notification.browse_follows': 'browse_notification_follows',
  'notification.back_home': 'notification_back_home',
  'pacing.update': 'pacing_update',
  'session.end': 'session.end',
};

export function facebookActionNameForCommand(type: string): string {
  return FB_COMMAND_ACTION_NAMES[type] ?? type;
}

/** 本会话上报所需的最小客户端能力（EdgeClient 已实现）。 */
export interface FacebookSessionClient {
  reportPageCards(payload: PageCardsPayload): void;
  reportNoteDetail(payload: NoteDetailPayload): void;
  reportProfileDetail(payload: ProfileDetailPayload): void;
  reportActionCompleted(payload: ActionCompletedPayload): void;
}

export interface FacebookBrowseSessionDeps {
  cdp: BrowseCdp;
  client: FacebookSessionClient;
  /** 评论/搜索/加群/按 url 开帖的委托处理器（原样复用，已测）。 */
  commentHandler: FacebookCommentHandler;
  overlayMonitor?: OverlayMonitor;
  acceptConsent?: FacebookConsentAccepter;
  /** 子执行器（缺省内部按 cdp 构造；测试可注入桩）。 */
  feedReader?: FacebookFeedReader;
  postReader?: FacebookPostReader;
  likeExecutor?: FacebookLikeExecutor;
  inlineReader?: FacebookInlineReader;
  reelsReader?: FacebookReelsReader;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

export interface FacebookBrowseSessionOptions {
  feedUrl?: string;
  /** 完整核心/浏览器启动代号；随 page.cards 上报，供云端限定首次启动采集。 */
  startupId?: string;
  mode?: FacebookBrowseMode;
  /** 单条浏览命令的兜底超时（毫秒）；超时回诚实 timeout 回执，绝不挂死。 */
  commandTimeoutMs?: number;
  tempo?: number;
}

type TerminalReport =
  // presence：列表面不都是推荐流——搜索结果页说「正在浏览推荐流」是假话。带上就用，不带回落推荐流。
  | { type: 'cards'; payload: PageCardsPayload; presence?: string }
  | { type: 'detail'; payload: NoteDetailPayload }
  | { type: 'profile'; payload: ProfileDetailPayload }
  | { type: 'action'; payload: ActionCompletedPayload; companionLikeObservation?: FacebookLikeObservation };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** feed 判稳 wall-clock：导航类（首屏/返回/搜索）给足页面加载；原地类（滚动/刷新换批）更短。 */
const FEED_SETTLE_NAV_MS = 6_000;
const FEED_SETTLE_INPLACE_MS = 3_500;
/** refresh 的 Page.reload 兜底频率下限（毫秒）。 */
const REFRESH_RELOAD_FLOOR_MS = 3 * 60_000;

/**
 * 与 Cloud `isCanonicalFacebookFeedVideoNoteId` 保持同一 fail-closed 边界：只接受
 * www.facebook.com 的规范 Feed 帖/视频身份，并显式排除 Reels。`isVideo:true` 是另一条独立见证。
 */
function canonicalFacebookFeedVideoPostId(noteId: string | undefined): string | null {
  if (!noteId) return null;
  try {
    const url = new URL(noteId);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'www.facebook.com' || url.hash) return null;
    const path = url.pathname;
    if (/^\/reel\//i.test(path)) return null;
    if (/^\/watch\/?$/i.test(path)) {
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== 'v' || !/^\d+$/.test(url.searchParams.get('v') ?? '')) return null;
    } else if (
      /\/(?:videos|posts|permalink)\/[^/?#]+\/?$/i.test(path)
    ) {
      if (url.search) return null;
    } else if (/^\/(?:permalink|story)\.php$/i.test(path)) {
      const id = url.searchParams.get('story_fbid');
      if (!id || ![...url.searchParams.keys()].every((key) => key === 'story_fbid' || key === 'id')) return null;
    } else {
      const multi = url.searchParams.get('multi_permalinks');
      if (!multi || ![...url.searchParams.keys()].every((key) => key === 'multi_permalinks')) return null;
    }
    return canonicalPostId(noteId);
  } catch {
    return null;
  }
}
/**
 * page.scroll 单条命令内有界续滚上限：本次 0 新卡时最多再滚几次找下沉的新卡（FB 懒加载 + 虚拟化需要时间渲染下一批）。
 * 从旧值 2 提到 8——给懒加载足够时间把下一批渲染出来，避免「滚两下没冒新卡就误判到底、立刻刷新回顶」的换批抖动。
 * 单条命令兜底超时 90s、每轮 ~5s，8 轮 ≤ ~45s 安全在预算内。
 */
const FEED_SCROLL_MAX_ROUNDS = 8;
/** 判「真到底」需连续满足「高度稳定 + 接近底部 + 0 新卡」的轮数（连续确认防抖，绝不单轮误判到底）。 */
const FEED_EXHAUST_CONFIRM_ROUNDS = 2;
/** scrollHeight 视为「FB 懒加载又长出内容」的最小增量（像素）——只要页面在长就继续下滚、绝不判到底。 */
const FEED_LAZYLOAD_GROWTH_PX = 100;
/** 距内容底部小于此值（像素）视为「接近底部」——FB 通常在触底前就懒加载，故留约一屏余量提前判定。 */
const FEED_NEAR_BOTTOM_PX = 900;
/** 就地读停留地板：base + 每字符增量，封顶（× tempo 由调用点乘）。 */
const INLINE_READ_FLOOR_BASE_MS = 1_200;
const INLINE_READ_FLOOR_PER_CHAR_MS = 20;
const INLINE_READ_FLOOR_CAP_MS = 9_000;
/** 孤儿写者排空的轮询间隔（change lease-strict-preemption）。 */
const WRITER_DRAIN_POLL_MS = 100;

/** refresh 的 Page.reload 兜底频率闸：距上次兜底达到下限才放行（纯函数，便于单测）。 */
export function refreshReloadAllowed(lastReloadAt: number, now: number, floorMs: number): boolean {
  if (!lastReloadAt || lastReloadAt <= 0) return true;
  return now - lastReloadAt >= floorMs;
}

/** 就地读停留地板（纯函数，便于单测）：按正文字数线性、封顶，再乘 tempo。 */
export function computeInlineReadFloorMs(bodyLen: number, tempo: number): number {
  const raw = INLINE_READ_FLOOR_BASE_MS + Math.max(0, bodyLen) * INLINE_READ_FLOOR_PER_CHAR_MS;
  const capped = Math.min(INLINE_READ_FLOOR_CAP_MS, raw);
  return Math.round(capped * (tempo > 0 ? tempo : 1));
}

function canonicalHomeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(^|\.)facebook\.com$/i.test(url.hostname) && (url.pathname === '/' || url.pathname === '/home.php');
  } catch {
    return false;
  }
}

export class FacebookBrowseSession implements EdgeBrowseSession {
  private readonly cdp: BrowseCdp;
  private readonly client: FacebookSessionClient;
  private readonly commentHandler: FacebookCommentHandler;
  private readonly feedReader: FacebookFeedReader;
  private readonly postReader: FacebookPostReader;
  private readonly likeExecutor: FacebookLikeExecutor;
  private readonly inlineReader: FacebookInlineReader;
  private readonly reelsReader: FacebookReelsReader;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly feedUrl: string;
  private readonly mode: FacebookBrowseMode;
  private readonly commandTimeoutMs: number;

  private running = false;
  private closing = false;
  private tempo: number;
  /** 当前可滚动列表的来源；详情页恢复时必须回原 feed 或原搜索页，不能一律跳首页。 */
  private activeFeedUrl: string;
  /** 当前列表形态；只有 Cloud 的 empty_feed_reels_fallback 授权可以把 feed 切成 reels。 */
  private listMode: 'feed' | 'reels' = 'feed';
  /** 最近一次 page.cards 到达时间；用于吸收云端评估耗时，避免 dwellMs 变成额外固定等待。 */
  private lastCardsAt = 0;
  /** 最近一次 refresh 的 Page.reload 兜底时刻；配 REFRESH_RELOAD_FLOOR_MS 做频率下限。 */
  private lastReloadAt = 0;
  /**
   * 会话级已上报 postId 游标（规范 `fb:<id>`，change facebook-feed-inline-browse task 1.2）。
   * page.scroll 只上报**未见过**的顶层新卡；FB feed 回收已滚过的卡（探针 P7），DOM 序水位不可靠，必用身份集合。
   * 首屏 / 刷新 / 返回是「新批」——重置后按当前批重新播种。
   */
  private seenPostIds = new Set<string>();
  /** Reels 路由可能晚于视频切换；用 route+videoKey 去重，不能只按暂未更新的地址栏拒绝新视频。 */
  private seenReelIdentities = new Set<string>();
  /** 已投影为“读”的 Reel postId；随后打开同一详情仍上报 Cloud，但不重复生成活动或本地浏览数。 */
  private reelViewActivityPostIds = new Set<string>();
  /** 已投影为“读”的 Feed 视频 postId；与 Cloud 一样覆盖整个连接，不随刷新/返回的新批重置。 */
  private feedVideoViewActivityPostIds = new Set<string>();
  /** 最近一次就地读的时刻 + 读地板（毫秒）：inline read 停留兜底（task 4.2），下一条 scroll 前 max（不累加）。 */
  private inlineReadStartedAt = 0;
  private inlineReadFloorMs = 0;
  private readonly startupId?: string;
  /** 命令串行链：一次只处理一条，避免并发争抢同一浏览器会话。 */
  private chain: Promise<void> = Promise.resolve();

  // —— 任务接管（change lease-strict-preemption）——
  /**
   * **在飞页面写者计数**：只在执行体**真正结束**时才减 —— 绝不随「命令超时放行串行链」而减。
   *
   * 这是让位探针的唯一事实源。历史缺陷：让位问的是「串行链空了没有」，而命令超时会在执行体
   * 仍在写页面时就 resolve 并放行链（见 runBrowseCommand 的超时兜底）⇒ 让位回「页面已静默」是**谎话**，
   * 抢占者会在一个仍在写页面的孤儿动作之上拿到执行权（双写）。
   */
  private activePageWriters = 0;
  /** 孤儿写者：命令已超时放行串行链、执行体仍在写页面。计数>0 期间让位一律如实回「未静默」。 */
  private orphanWriters = 0;
  /** 任务接管世代号：每次交接 +1。判据必须是世代号，不能是「已让位」标志（持权任务自己的命令就跑在让位期内）。 */
  private taskBlockEpoch = 0;
  /**
   * 「我这条命令启动时的世代号」——**按写者隔离，不能是一个共享标量**。
   *
   * 本会话**允许写者重叠**：命令超时会放行串行链、执行体变成孤儿仍在写页面（见 runBrowseCommand），
   * 此时下一条命令已经开跑。用一个共享标量记世代，孤儿收尾时会把**正在跑的那条命令**的判据一起清掉
   * ⇒ 它的取消点全部静默失效（评论会一路打完并按下回车，让位退化成「等满整条命令」）。
   *
   * AsyncLocalStorage 天然沿 await 链传播，每个写者各拿一份、互不覆盖，孤儿结束也动不了别人的。
   */
  private readonly writerEpoch = new AsyncLocalStorage<number>();
  /** 可打断 sleep 的唤醒器集合（接管时全部唤醒，让安全取消点当场让路）。 */
  private readonly sleepWakers = new Set<() => void>();

  constructor(deps: FacebookBrowseSessionDeps, options: FacebookBrowseSessionOptions = {}) {
    this.cdp = deps.cdp;
    this.client = deps.client;
    this.commentHandler = deps.commentHandler;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.logger ?? ((m) => console.log(m));
    this.feedUrl = options.feedUrl ?? FACEBOOK_DEFAULT_START_URL;
    this.activeFeedUrl = this.feedUrl;
    this.mode = options.mode ?? parseFacebookBrowseMode();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 90_000;
    this.tempo = options.tempo && options.tempo > 0 ? options.tempo : 1.0;
    this.startupId = options.startupId;
    const accept = deps.acceptConsent ?? defaultFacebookConsentAccepter();
    this.feedReader =
      deps.feedReader ??
      new FacebookFeedReader({ cdp: this.cdp, overlayMonitor: deps.overlayMonitor, acceptConsent: accept, sleep: this.sleep, logger: this.log });
    this.postReader =
      deps.postReader ??
      new FacebookPostReader({ cdp: this.cdp, overlayMonitor: deps.overlayMonitor, acceptConsent: accept, sleep: this.sleep, logger: this.log });
    this.likeExecutor =
      deps.likeExecutor ?? new FacebookLikeExecutor({ cdp: this.cdp, overlayMonitor: deps.overlayMonitor, sleep: this.sleep, logger: this.log });
    this.inlineReader =
      deps.inlineReader ?? new FacebookInlineReader({ cdp: this.cdp, overlayMonitor: deps.overlayMonitor, sleep: this.sleep, logger: this.log });
    this.reelsReader = deps.reelsReader ?? new FacebookReelsReader({ cdp: this.cdp, sleep: this.sleep, logger: this.log });
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 启动会话。mode==='off' → 不自动浏览（评论/加群仍按命令服务）；否则导航 feed → 上报首屏 page.cards
   * 以驱动云端浏览闭环。仅在 kill switch 开启时才有自动浏览行为。
   */
  async start(): Promise<void> {
    this.running = true;
    if (this.closing) return;
    if (this.mode === 'off') {
      this.log('[fb-session] AIDCP_FB_BROWSE_AUTO=off：不自动浏览/点赞（评论/加群仍按命令服务）');
      return;
    }
    this.log(`[fb-session] 启动自动浏览（mode=${this.mode}）→ 导航 feed ${this.feedUrl}`);
    this.emitCompanionUiEvent({
      kind: 'activity',
      type: 'session_start',
      sentence: '开始自动浏览',
      presence: '开始今天的浏览…',
      loopStage: 'feed',
    });
    await this.reportInitialFeed();
  }

  stop(): void {
    this.running = false;
  }

  close(): void {
    this.closing = true;
    this.running = false;
  }

  /** 终态关闭 + 有界等待在途命令链排空（关浏览器前必须走这条；语义见 BrowseSession.closeAndWait）。 */
  async closeAndWait(timeoutMs = 5000): Promise<boolean> {
    this.close();
    return this.waitDrained(timeoutMs);
  }

  /** 冷待机排空（change browser-slot-scheduling）：等在途命令链排空但**非终态**，唤醒后可再 start()。 */
  async stopAndWait(timeoutMs = 5000): Promise<boolean> {
    this.stop();
    return this.waitDrained(timeoutMs);
  }

  /**
   * 有界等待**页面真正静默**：串行链排空 **且** 在飞写者归零。
   *
   * 串行链排空 ≠ 页面已静默 —— 命令超时会在执行体仍在写页面时放行链（孤儿写者）。只等链 = 撒谎。
   */
  private async waitDrained(timeoutMs: number): Promise<boolean> {
    const budget = Math.max(0, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chainDrained = await Promise.race([
      this.chain.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), budget);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!chainDrained) return false;
    if (this.activePageWriters === 0) return true;

    // 链空了但还有写者在飞 = 孤儿。按**迭代次数**限界（不用墙钟：注入的 sleep 桩可能立即 resolve）。
    const maxIters = Math.ceil(budget / WRITER_DRAIN_POLL_MS) + 1;
    for (let i = 0; i < maxIters; i++) {
      if (this.activePageWriters === 0) return true;
      await this.sleep(WRITER_DRAIN_POLL_MS);
    }
    return this.activePageWriters === 0;
  }

  /**
   * 交接：唤醒安全取消点上的纯等待让路 → 有界等真写段收敛。**未收敛即抛出，绝不谎称已静默**。
   * 协调器据此不授予、诚实终结排队申请（见 edge-task-coordinator）。
   */
  async quiesceForTask(timeoutMs = DEFAULT_TASK_QUIESCE_MS): Promise<number> {
    this.taskBlockEpoch++;
    this.wakeInterruptibleSleeps(); // 让路：停在犹豫/停留上的命令当场作废，不必等它睡完
    const drained = await this.waitDrained(timeoutMs);
    if (!drained) {
      this.log(
        `[fb-session] 交接未在 ${timeoutMs}ms 内收敛（在飞写者 ${this.activePageWriters}，其中孤儿 ${this.orphanWriters}）→ 如实抛出，不授予`,
      );
      throw new BrowseQuiesceTimeoutError(timeoutMs);
    }
    return 0;
  }

  async resumeAfterTask(): Promise<void> {
    /* FB 会话无独立恢复态：命令到达即处理。 */
  }

  /**
   * 可打断 sleep：正常到时或被 wakeInterruptibleSleeps() 提前唤醒即 resolve。
   * 用注入的 this.sleep 计时（测试可控）。唤醒后调用方须立刻 throwIfTakeover()，否则会当作睡完继续写页面。
   */
  private sleepInterruptible(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.sleepWakers.delete(waker);
        resolve();
      };
      const waker = (): void => finish();
      this.sleepWakers.add(waker);
      void this.sleep(ms).then(finish); // 到时自然 resolve；finish 幂等，多余定时器无害空转
    });
  }

  private wakeInterruptibleSleeps(): void {
    if (this.sleepWakers.size === 0) return;
    const wakers = [...this.sleepWakers];
    this.sleepWakers.clear();
    for (const w of wakers) w();
  }

  /**
   * **本条命令**是否已被更高优先级的独占任务接管：仅在写者执行域内（拿得到自己那份世代号）
   * 且交接已推进世代号时为真。域外（无在飞写者）恒 false —— 与「无命令在执行」同义。
   */
  private takeoverRequested(): boolean {
    const mine = this.writerEpoch.getStore();
    return mine !== undefined && mine !== this.taskBlockEpoch;
  }

  /** 在安全取消点检查接管：已被接管即抛出，令本命令零页面副作用地作废。 */
  private throwIfTakeover(): void {
    if (this.takeoverRequested()) throw new TaskTakeoverError();
  }

  /**
   * 页面写者记账：**只在 fn 真正 settle 时才减计数**。命令超时放行串行链不减 —— 那正是孤儿写者。
   *
   * fn 跑在自己的 writerEpoch 域里 ⇒ 它内部任何深度的 throwIfTakeover() 读到的都是**它自己**启动时
   * 的世代号。重叠写者（孤儿 + 新命令）各看各的，谁也清不掉谁。
   */
  private trackWriter<T>(fn: () => Promise<T>): Promise<T> {
    this.activePageWriters++;
    const running = this.writerEpoch.run(this.taskBlockEpoch, () => fn());
    return running.finally(() => {
      this.activePageWriters--;
    });
  }

  discardQueuedCloudCommands(_reason?: string): void {
    /* FB 会话不缓冲命令（串行即时处理），无队列可丢弃。 */
  }

  applyPacingSnapshot(_opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>, tempo?: number): void {
    if (typeof tempo === 'number' && Number.isFinite(tempo) && tempo > 0) this.tempo = tempo;
  }

  async recoverAfterCloudReconnect(): Promise<void> {
    if (this.closing || this.mode === 'off') return;
    this.log('[fb-session] 云端重连后重报 feed 首屏，恢复浏览闭环');
    await this.reportInitialFeed().catch((err) => this.log(`[fb-session] 重连重报失败：${(err as Error).message}`));
  }

  /** 云端主动命令入口：串行化处理，保证每条恰好一个诚实回执。 */
  onCloudCommand(env: Envelope): Promise<void> {
    this.chain = this.chain.then(() => this.dispatch(env)).catch((err) => {
      this.log(`[fb-session] 命令处理未捕获异常 type=${env.type}：${(err as Error).message}`);
    });
    return this.chain;
  }

  private async dispatch(env: Envelope): Promise<void> {
    if (this.closing) {
      // 终态：诚实回执，绝不静默丢弃。
      this.client.reportActionCompleted({ action: this.actionName(env.type), ok: false, reason: 'session_closing' });
      return;
    }
    switch (env.type) {
      // —— 委托给评论处理器（定向评论搜索/评论/加群；已测、自带诚实回执与单飞）——
      // 普通浏览搜索没有 taskId/container，走 FB BrowseSession 自己的全站搜索；
      // 定向评论搜索必须带 taskId 或 container，仍由 commentHandler fail-closed 处理。
      case 'search.execute': {
        const payload = (env.payload ?? {}) as SearchExecutePayload;
        if (!payload.taskId && !payload.container) {
          await this.runBrowseCommand('search', () => this.searchBrowse(payload));
          return;
        }
        await this.trackWriter(() => this.commentHandler.handle(env, () => this.throwIfTakeover())); // 委托执行体同样是页面写者：让位必须等它真停
        return;
      }
      case 'interaction.comment':
      case 'group.join':
        await this.trackWriter(() => this.commentHandler.handle(env, () => this.throwIfTakeover())); // 委托执行体同样是页面写者：让位必须等它真停
        return;
      case 'note.open': {
        const payload = (env.payload ?? {}) as NoteOpenPayload;
        // url 存在 = 评论支线按 permalink 开帖（读评论供撰写）；否则 = 浏览闭环按卡片 noteId 深读。
        if (payload.url) {
          await this.trackWriter(() => this.commentHandler.handle(env, () => this.throwIfTakeover())); // 委托执行体同样是页面写者：让位必须等它真停
          return;
        }
        await this.runBrowseCommand('open_note', async () => {
          await this.thinkBefore(payload.thinkMs); // 开帖前犹豫（云端中心值 × tempo + 抖动）
          return this.openNoteRouted(payload);
        });
        return;
      }
      // —— 浏览/点赞类（受 kill switch 门控）——
      case 'page.scroll': {
        const payload = (env.payload ?? {}) as PageScrollPayload;
        await this.runBrowseCommand('scroll', async () => {
          await this.ensureFeedDwell(payload.dwellMs);
          if (payload.reason === 'empty_feed_reels_fallback') return this.enterReels();
          if (this.listMode === 'reels') return this.scrollReels();
          return this.scrollFeed();
        });
        return;
      }
      case 'feed.refresh':
        await this.runBrowseCommand('refresh', () => (this.listMode === 'reels' ? this.scrollReels() : this.refreshFeed()));
        return;
      case 'interaction.like': {
        const payload = env.payload as InteractionLikePayload;
        await this.runBrowseCommand('like', async () => {
          await this.thinkBefore(payload?.thinkMs); // 点赞前犹豫（云端中心值 × tempo + 抖动）
          return this.likeCurrent(payload);
        });
        return;
      }
      case 'interaction.follow': {
        if (this.listMode !== 'reels') {
          this.reportUnsupportedCommand(env.type);
          return;
        }
        const payload = env.payload as InteractionFollowPayload;
        await this.runBrowseCommand('follow', async () => {
          await this.thinkBefore(payload?.thinkMs);
          return this.followCurrentReel(payload);
        });
        return;
      }
      case 'navigation.back':
        await this.runBrowseCommand('back', () => this.backToFeed());
        return;
      case 'note.close':
        await this.runBrowseCommand('close', () => this.closeNote());
        return;
      case 'profile.open': {
        const payload = (env.payload ?? {}) as ProfileOpenPayload;
        if (payload.direct) {
          await this.runProfileCommand(payload);
          return;
        }
        this.log('[fb-session] profile.open 非 direct 路径 FB v1 不支持，回 capability_unsupported');
        this.client.reportActionCompleted({ action: 'profile_open', ok: false, reason: 'capability_unsupported' });
        return;
      }
      case 'pacing.update': {
        const payload = (env.payload ?? {}) as { opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>; tempo?: number };
        // 配置更新不是原子动作：只更新后续命令的节奏，不产生 action.completed，更不唤醒浏览循环。
        this.applyPacingSnapshot(payload.opFloorsMs, payload.tempo);
        return;
      }
      case 'session.end':
        this.log('[fb-session] 命令: session.end');
        this.running = false;
        await this.navigateFeedBestEffort();
        return;
      // FB 还未具备这些原子实现，但它们是云端可下发的正式命令。必须保留规范
      // action 名称，让 DeepReader / CommentReviewer / 通知恢复链能消费失败并退出详情页。
      case 'interaction.collect':
      case 'interaction.like_comment':
      case 'note.browse_images':
      case 'note.scroll_comments':
      case 'notification.open':
      case 'notification.browse_comments':
      case 'notification.browse_likes':
      case 'notification.browse_follows':
      case 'notification.back_home':
        this.reportUnsupportedCommand(env.type);
        return;
      // —— 未知消息同样诚实失败，绝不静默丢弃或伪造成功 ——
      default:
        this.reportUnsupportedCommand(env.type);
        return;
    }
  }

  private reportUnsupportedCommand(type: string): void {
    const action = facebookActionNameForCommand(type);
    this.log(`[fb-session] 命令 ${type} FB v1 浏览不支持，回 ${action}:capability_unsupported`);
    this.client.reportActionCompleted({ action, ok: false, reason: 'capability_unsupported' });
  }

  /**
   * 执行一条浏览命令：kill switch off → 诚实 browse_disabled；否则跑 fn（返回终态报文），
   * 有界超时兜底 timeout。保证恰好一个终态上报。
   */
  private async runBrowseCommand(action: string, fn: () => Promise<TerminalReport>): Promise<void> {
    if (this.mode === 'off') {
      this.client.reportActionCompleted({ action, ok: false, reason: 'browse_disabled' });
      return;
    }
    let settled = false;
    const emitOnce = (r: TerminalReport): void => {
      if (settled) return;
      settled = true;
      this.emit(r);
    };
    // 执行体登记为页面写者：计数只在 fn **真正 settle** 时才减 —— 下面的超时兜底会放行串行链，
    // 但绝不代表页面已静默。让位探针只认这个计数（change lease-strict-preemption task 2.1）。
    const running = this.trackWriter(fn);
    // 有界超时【race】fn：超时即回诚实 timeout 并**放行串行链**（哪怕 fn 卡死 CDP 仍挂着）——
    // 否则一个卡死命令会永久阻塞后续命令与云端 nudge，整会话活锁（task 4.3 红线）。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 放行链 ≠ 页面静默：登记孤儿写者，让位期间据此如实回「未静默、不可接管」（task 2.2）。
        this.orphanWriters++;
        void running.finally(() => {
          this.orphanWriters--;
        });
        this.log(
          `[fb-session] 命令 ${action} 超时（${this.commandTimeoutMs}ms），回诚实 timeout 并放行链；` +
            `执行体仍可能在写页面 → 登记孤儿写者（当前 ${this.orphanWriters}）`,
        );
        emitOnce({ type: 'action', payload: { action, ok: false, reason: 'timeout' } });
        resolve();
      }, this.commandTimeoutMs);
      running
        .then((report) => {
          clearTimeout(timer);
          emitOnce(report);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          // 安全取消点上被独占任务接管：零页面副作用作废，回诚实失败回执，绝不重放、绝不假成功。
          if (err instanceof TaskTakeoverError) {
            this.log(`[fb-session] 命令 ${action} 在安全取消点被独占任务接管 → 零副作用作废`);
            emitOnce({ type: 'action', payload: { action, ok: false, reason: 'preempted_by_task' } });
            resolve();
            return;
          }
          emitOnce({ type: 'action', payload: { action, ok: false, reason: `handler_error:${(err as Error).message}` } });
          resolve();
        });
    });
  }

  /**
   * 动作前犹豫：云端下发的中心值 thinkMs × 风控 tempo，叠 lognormal 抖动（边缘只叠抖动，不自造系数）。
   * **安全取消点**：纯等待、平台侧零副作用 → 被接管即当场作废，不必睡完。
   */
  private async thinkBefore(thinkMs?: number): Promise<void> {
    if (!thinkMs || thinkMs <= 0) return;
    const ms = jitterAround(thinkMs * this.tempo, 0.25);
    if (ms > 0) await this.sleepInterruptible(ms);
    this.throwIfTakeover();
  }

  /**
   * feed 翻页前确保停留达标；已花掉的 LLM/网络时间会被吸收，不双重叠加。
   * 两个来源取 **max（不累加）**：① 云端 dwellMs（锚点 lastCardsAt）；② 就地读地板（锚点 inlineReadStartedAt）——
   * 上一步若是 surface='feed' 就地读、读完不导航，靠这里补足最小阅读停留（task 4.2），消费一次即清。
   * **安全取消点**（change lease-strict-preemption）：停留是「离页前的等待」，用可打断 sleep + 让路后查接管，让路时不改任何页面状态。
   */
  private async ensureFeedDwell(dwellMs?: number): Promise<void> {
    const now = Date.now();
    let remaining = 0;
    if (dwellMs && dwellMs > 0 && this.lastCardsAt > 0) {
      const target = jitterAround(dwellMs * this.tempo, 0.2);
      remaining = Math.max(remaining, target - (now - this.lastCardsAt));
    }
    if (this.inlineReadStartedAt > 0) {
      remaining = Math.max(remaining, this.inlineReadFloorMs - (now - this.inlineReadStartedAt));
      this.inlineReadStartedAt = 0; // 消费一次
      this.inlineReadFloorMs = 0;
    }
    if (remaining > 0) await this.sleepInterruptible(remaining);
    this.throwIfTakeover();
  }

  private emit(r: TerminalReport): void {
    if (r.type === 'cards') {
      this.lastCardsAt = Date.now();
      this.client.reportPageCards(r.payload);
      if (r.payload.listKind === 'reels' && r.payload.cards.length === 1) {
        const card = r.payload.cards[0];
        const postId = canonicalPostId(card.noteId);
        if (postId) {
          this.reelViewActivityPostIds.add(postId);
          this.emitCompanionUiEvent({
            kind: 'activity',
            type: 'reel_view',
            ...facebookReelViewUiText(card),
            loopStage: 'read',
            statsDelta: { views: 1 },
          });
        }
      }
      if (r.payload.listKind === 'feed') {
        const videos = r.payload.cards.filter((card) => card.isVideo === true);
        const card = videos.length === 1 ? videos[0] : undefined;
        const postId = canonicalFacebookFeedVideoPostId(card?.noteId);
        if (card && postId && !this.feedVideoViewActivityPostIds.has(postId)) {
          this.feedVideoViewActivityPostIds.add(postId);
          this.emitCompanionUiEvent({
            kind: 'activity',
            type: 'feed_video_view',
            ...facebookFeedVideoViewUiText(card),
            loopStage: 'read',
            statsDelta: { views: 1 },
          });
        }
      }
      this.emitCompanionUiEvent({
        kind: 'presence',
        type: 'feed',
        presence: r.presence ?? '正在浏览推荐流…',
        loopStage: 'feed',
      });
    }
    else if (r.type === 'detail') {
      this.client.reportNoteDetail(r.payload);
      const postId = canonicalPostId(r.payload.noteId);
      if (!postId || (!this.reelViewActivityPostIds.has(postId) && !this.feedVideoViewActivityPostIds.has(postId))) {
        const readText = facebookReadUiText(r.payload);
        this.emitCompanionUiEvent({
          kind: 'activity',
          type: 'note_open',
          ...readText,
          loopStage: 'read',
          statsDelta: { views: 1 },
        });
      }
    }
    else if (r.type === 'profile') this.client.reportProfileDetail(r.payload);
    else {
      this.client.reportActionCompleted(r.payload);
      if (r.payload.action === 'like' && r.payload.ok) {
        const likeText = facebookLikeUiText(r.companionLikeObservation);
        this.emitCompanionUiEvent({
          kind: 'activity',
          type: 'like',
          ...likeText,
          loopStage: 'interact',
          statsDelta: { likes: 1 },
        });
      }
      if (r.payload.action === 'follow' && r.payload.ok && r.payload.reason !== 'already_followed') {
        this.emitCompanionUiEvent({
          kind: 'activity',
          type: 'follow',
          sentence: '关注了一位 Reel 作者',
          presence: '刚关注了一位 Reel 作者',
          loopStage: 'interact',
          statsDelta: { follows: 1 },
        });
      }
    }
  }

  /** 薄包装：叙述与发射已下沉到 companion-ui.ts（供委托处理器共用），此处只绑定本会话的 logger。 */
  private emitCompanionUiEvent(event: FacebookCompanionUiEvent): void {
    emitCompanionUiEventLine(this.log, event);
  }

  /** 导航 feed → 扫卡 → 上报 page.cards（首屏 / 重连恢复）。无命令可回，best-effort 直发。 */
  private async reportInitialFeed(): Promise<void> {
    this.listMode = 'feed';
    const ensure = await this.feedReader.ensureFeed(this.feedUrl);
    if (!ensure.ok) {
      this.log(`[fb-session] feed 未就绪（${ensure.reason}）：不上报首屏（云端看门狗后续可 nudge）`);
      return;
    }
    this.activeFeedUrl = this.feedUrl;
    const settle = await this.feedReader.settleCards({ wallClockMs: FEED_SETTLE_NAV_MS });
    if (settle.cards.length === 0) {
      if (settle.reason === 'no_feed') {
        const empty = await this.feedReader.confirmHomeEmpty();
        if (empty.state === 'empty_feed_confirmed') {
          this.emit({
            type: 'cards',
            payload: {
              cards: [],
              listKind: 'feed',
              listState: 'empty',
              ...(this.startupId ? { startupId: this.startupId } : {}),
              ...(empty.generation ? { documentGeneration: empty.generation } : {}),
            },
            presence: '首页暂时没有可浏览的帖子…',
          });
          this.log(`[fb-session] 首页显式空态已确认 generation=${empty.generation ?? '-'} → 等 Cloud 授权 Reels fallback`);
          return;
        }
        if (empty.state === 'cards_ready') {
          // 页面有真实结构卡，但当前卡没有可信 canonical permalink（常见于媒体-only / 轻量视频首卡）。
          // 这不是空 feed，也不能停在原视口等 Cloud——Cloud 尚未收到 page.cards，正常闭环无法自行下发 scroll。
          // 复用 page.scroll 的同一套有界、人类化、懒加载感知续滚；仅发找到的真实 cards，绝不凭空发 action 回执。
          this.log('[fb-session] 首页当前视口存在不可上报卡片：忽略并有界向下滚动寻找下一张');
          const continued = await this.scrollFeed();
          if (continued.type === 'cards') {
            this.emit(continued);
            if (continued.payload.listState === 'empty') {
              this.log('[fb-session] 跳过不可上报首卡后确认首页显式空态 → 等 Cloud 授权 Reels fallback');
            } else if (continued.payload.listState === 'present_unreportable') {
              this.log('[fb-session] 8 轮后确认首页仍有物理卡但不可上报 → 等 Cloud 单次授权 Reels fallback');
            } else {
              this.log(`[fb-session] 跳过不可上报首卡后已上报 ${continued.payload.cards.length} 张 feed 卡片`);
            }
          } else {
            this.log(
              `[fb-session] 跳过不可上报首卡后有界续滚未找到可上报卡片（${continued.payload.reason ?? 'no_target'}）：不发无命令 action 回执`,
            );
          }
          return;
        }
        this.log(`[fb-session] 首页无可上报卡片且未确认空态（${empty.state}）：不上报空态、不切 Reels`);
        return;
      }
      this.log(`[fb-session] feed 就绪但无可上报卡片（${settle.reason ?? 'no_target'}）`);
      return;
    }
    if (settle.degraded) this.log(`[fb-session] initial settle degraded：上报 ${settle.cards.length} 张（未完全稳定，卡为真抽）`);
    this.resetCursor(); // 首屏 = 全新一批，重置游标后按本批播种
    this.emit({ type: 'cards', payload: this.toPageCards(this.seedCursor(settle.cards)) });
    this.log(`[fb-session] 已上报首屏 ${settle.cards.length} 张 feed 卡片`);
  }

  /**
   * note.open 按 surface / purpose 分流（change facebook-feed-inline-browse task 3.1）：
   *  - purpose='navigate' → 只把浏览器带到详情供后续评论迁移，**MUST NOT 上报 note.detail**（避免 0 覆盖真实反应数），
   *    只回 action.completed{ok, observation, page-derived noteId}。
   *  - surface='feed' → 就地展开读全文（不离 feed）；环境变化则回落 detail 导航。
   *  - 缺省（surface='detail' + purpose='read'）→ 今天行为：导航进详情页深读。
   */
  private async openNoteRouted(payload: NoteOpenPayload): Promise<TerminalReport> {
    const noteId = String(payload.noteId ?? '').trim();
    const surface = payload.surface === 'feed' ? 'feed' : 'detail';
    const purpose = payload.purpose === 'navigate' ? 'navigate' : 'read';
    if (purpose === 'navigate') return this.navigateForMigration(noteId);
    if (surface === 'feed' && this.listMode === 'reels') return this.openReelNote(noteId);
    if (surface === 'feed') return this.openInlineNote(noteId);
    return this.openBrowseNote(noteId);
  }

  /**
   * surface='feed' 就地深读：inline-reader 按 noteId 三段式锁卡、就地读全文（展开/textContent 捷径），
   * 成功回 note.detail（noteId 用卡自身 DOM permalink，页面派生）。环境变化 → 回落 detail 导航（诚实读详情）。
   */
  private async openInlineNote(noteId: string): Promise<TerminalReport> {
    if (!noteId) return { type: 'action', payload: { action: 'open_note', ok: false, reason: 'no_target' } };
    const r = await this.inlineReader.openAndReadInline(noteId);
    if (!r.ok) {
      if (r.reason === 'context_changed') {
        this.log('[fb-session] 就地读环境变化 → 回落 detail 导航深读');
        return this.openBrowseNote(noteId);
      }
      return { type: 'action', payload: { action: 'open_note', ok: false, reason: r.reason ?? 'open_failed' } };
    }
    // 就地读停留地板（edge-local，task 4.2）：锚定 inlineReadStartedAt，下一条 scroll 前与云端 dwell 取 max（不累加）。
    this.inlineReadFloorMs = computeInlineReadFloorMs(r.body?.length ?? 0, this.tempo);
    this.inlineReadStartedAt = Date.now();
    const noteIdOut = r.permalinkHref || noteId;
    const payloadOut: NoteDetailPayload = {
      noteId: noteIdOut,
      title: r.body ? r.body.slice(0, 60) : '',
      content: r.body ?? '',
      mediaType: r.isVideo ? 'video' : 'image_text',
      likeCount: r.reactionCount ?? 0,
      collectCount: 0, // FB 无收藏：诚实缺省
      url: noteIdOut,
      ...(r.author ? { author: r.author } : {}),
      ...(r.comments && r.comments.length > 0 ? { comments: r.comments } : {}),
    };
    this.log(
      `[fb-session] note.detail(inline) noteId=${noteIdOut} 👍${r.reactionCount ?? 0} ` +
        `正文:${(r.body ?? '').slice(0, 40).replace(/\s+/g, ' ')}…`,
    );
    return { type: 'detail', payload: payloadOut };
  }

  /**
   * purpose='navigate'（评论迁移第一步）：按 noteId 导航进详情页、**不上报 note.detail**，
   * 只回 action.completed{ok, observation{surface:'detail'}, noteId=落地页派生}。落地失败 → 诚实 ok:false。
   */
  private async navigateForMigration(noteId: string): Promise<TerminalReport> {
    if (!noteId) return { type: 'action', payload: { action: 'open_note', ok: false, reason: 'no_target' } };
    const detail = await this.postReader.openAndRead(noteId);
    if (!detail.ok) {
      return { type: 'action', payload: { action: 'open_note', ok: false, reason: detail.reason ?? 'open_failed' } };
    }
    const observation = {
      surface: 'detail' as const,
      noteId: detail.permalink,
      ...(detail.author ? { author: detail.author } : {}),
      ...(detail.body ? { textPreviewHead: detail.body.slice(0, 40) } : {}),
      reactionText: String(detail.reactionCount),
    };
    this.log(`[fb-session] open_note(navigate) 落地详情 noteId=${detail.permalink}（不报 note.detail，供评论迁移）`);
    return {
      type: 'action',
      payload: { action: 'open_note', ok: true, noteId: detail.permalink, observation },
    };
  }

  /** 浏览闭环：按 permalink（noteId）深读 → note.detail。 */
  private async openBrowseNote(noteId?: string): Promise<TerminalReport> {
    if (!noteId) return { type: 'action', payload: { action: 'open_note', ok: false, reason: 'no_target' } };
    const detail = await this.postReader.openAndRead(noteId);
    if (!detail.ok) {
      return { type: 'action', payload: { action: 'open_note', ok: false, reason: detail.reason ?? 'open_failed' } };
    }
    const payload: NoteDetailPayload = {
      noteId: detail.permalink,
      title: detail.body ? detail.body.slice(0, 60) : '',
      content: detail.body,
      mediaType: detail.isVideo ? 'video' : 'image_text',
      likeCount: detail.reactionCount,
      collectCount: 0, // FB 无收藏：诚实缺省，绝不臆造
      url: detail.permalink,
      ...(detail.author ? { author: detail.author } : {}),
      ...(detail.comments.length > 0 ? { comments: detail.comments } : {}),
    };
    this.log(
      `[fb-session] note.detail noteId=${detail.permalink} 👍${detail.reactionCount} 💬${detail.commentCount} ` +
        `正文:${detail.body.slice(0, 40).replace(/\s+/g, ' ')}…`,
    );
    return { type: 'detail', payload };
  }

  /**
   * 点赞**命令指定的那张卡**（change facebook-note-scoped-targeting）：noteId → 规范帖身份 →
   * 页内三段式解析出唯一目标 article 再动手。绝不再靠「当前页」的隐式假设 + DOM 序第一个反应按钮
   * （那在信息流态会点错卡）。mode=shadow → 只记不执行（诚实 shadow）；on → 真点赞 + 绑定同卡的后置校验。
   */
  private async likeCurrent(payload: InteractionLikePayload): Promise<TerminalReport> {
    const shadow = this.mode === 'shadow';
    const noteId = String(payload?.noteId ?? '').trim();
    const r = this.listMode === 'reels'
      ? await this.reelsReader.like(noteId, shadow)
      : await this.likeExecutor.like({ shadow, ...(noteId ? { noteId } : {}) });
    // ok:true 才让云端经 RiskController.record 记账；shadow/失败一律 ok:false（云端不记、不扣风控）。
    // 独立见证（noteId + observation）**只在 feed 就地作用面上挂**——detail 面（今天）逐位回落会话当前笔记、
    // 逐位等于今天（零回归）；feed 面才激活云端归账仲裁（N4，shadow/真点均带）。
    const obs = r.observation;
    const attachWitness = obs?.surface === 'feed';
    return {
      type: 'action',
      ...(r.ok && obs ? { companionLikeObservation: obs } : {}),
      payload: {
        action: 'like',
        ok: r.ok,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(attachWitness && obs?.noteId ? { noteId: obs.noteId } : {}),
        ...(attachWitness && obs ? { observation: obs } : {}),
      },
    };
  }

  /** Reels only: bind follow to the commanded canonical Reel and forward the reader's terminal truth. */
  private async followCurrentReel(payload: InteractionFollowPayload): Promise<TerminalReport> {
    const noteId = String(payload?.noteId ?? '').trim();
    const result = await this.reelsReader.follow(noteId, this.mode === 'shadow');
    return {
      type: 'action',
      payload: {
        action: 'follow',
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
      },
    };
  }

  /**
   * feed 翻页 → 判稳扫卡 → 只上报**未见过的新卡**（游标去回收重现）。ensureFeed 幂等：已在 feed 就不重新导航。
   *
   * 懒加载感知的「到底」判据（change facebook-feed-lazyload-exhaustion-fix）：FB feed 是懒加载 + 虚拟化——
   * 往下滚到接近底部时才异步拉 + 渲染下一批，需要时间。旧逻辑「滚 2 次 0 新卡就判 feed_exhausted」会在
   * 下一批还没渲染出来时**误判到底、立刻刷新回顶**，回顶后又从顶部那几张重新开始 → 频繁刷新、永远下不去。
   * 现在：本轮 0 新卡时，只有「页面高度不再增长（懒加载没在长）**且**已接近底部**且**连续确认」才诚实
   * `feed_exhausted`（云端映射为 refresh）；只要页面还在长或还没到底就继续下滚找下沉的新卡。让 60 篇深度阈值
   * （云端 FeedScroller）成为换批主路。绝不把回收重现当新内容重复上报，绝不在还有内容时假判到底。
   */
  private async scrollFeed(): Promise<Extract<TerminalReport, { type: 'cards' | 'action' }>> {
    // 只有确认已在目标列表面后才能滚动。ensureFeed 幂等——已在首页/搜索页且无 dialog 时直接放行、不导航，
    // 因此连续滚动能真正累积深度，而非每次被整页重载钉回第一屏。
    const ensure = await this.feedReader.ensureFeed(this.activeFeedUrl);
    if (!ensure.ok) {
      return { type: 'action', payload: { action: 'scroll', ok: false, reason: ensure.reason ?? 'no_feed' } };
    }
    let bottomDryRounds = 0;
    let sawAnyCard = false;
    let lastEmptyReason: FacebookFeedSettleResult['reason'];
    for (let round = 0; round < FEED_SCROLL_MAX_ROUNDS; round++) {
      const before = await this.feedReader.scrollMetrics();
      await this.feedReader.scrollNext();
      const settle = await this.feedReader.settleCards({ wallClockMs: FEED_SETTLE_INPLACE_MS });
      const after = await this.feedReader.scrollMetrics();
      if (settle.cards.length > 0) {
        sawAnyCard = true;
        const fresh = this.takeNewCards(settle.cards);
        if (fresh.length > 0) {
          if (settle.degraded) this.log(`[fb-session] scroll settle degraded：上报 ${fresh.length} 张新卡（未完全稳定，卡为真抽）`);
          return { type: 'cards', payload: this.toPageCards(fresh) };
        }
      } else {
        lastEmptyReason = settle.reason;
      }
      // 本轮 0 新卡：判是「懒加载还在长 / 还没到底」→ 继续下滚，还是「真到底」→ 连续确认后换批。
      const grew = after.scrollHeight > before.scrollHeight + FEED_LAZYLOAD_GROWTH_PX;
      const remaining = after.scrollHeight - after.scrollY - after.innerHeight;
      const nearBottom = after.innerHeight > 0 && after.scrollHeight > 0 && remaining <= FEED_NEAR_BOTTOM_PX;
      if (grew || !nearBottom) {
        // 页面在长（FB 懒加载中）或还没滚到底 → 继续下滚找下沉的新卡，绝不当到底。
        bottomDryRounds = 0;
        continue;
      }
      // 高度稳定 + 接近底部 + 0 新卡 → 真到底候选，连续确认防抖后才诚实 feed_exhausted。
      bottomDryRounds += 1;
      if (bottomDryRounds >= FEED_EXHAUST_CONFIRM_ROUNDS && sawAnyCard) {
        this.log('[fb-session] 已到 feed 底部且无新卡 → feed_exhausted（云端映射为 refresh）');
        return { type: 'action', payload: { action: 'scroll', ok: false, reason: 'feed_exhausted' } };
      }
    }
    // 轮次耗尽：从没扫到任何可上报卡时做一次新的首页完整样本。只有“首页壳就绪 + 无阻断/loading +
    // 可见物理卡仍在场”才上报 present_unreportable，交给 Cloud 单次授权 Reels；未知/加载/登录/检查点继续失败关闭。
    if (!sawAnyCard) {
      // 首次 empty 观察若因连接时序未被 Cloud 消费，后续 watchdog/redrive 仍可重新做同一套严格确认并重报；
      // 仅 canonical 首页可达，搜索/群组/unknown 绝不套用。
      if (canonicalHomeUrl(this.activeFeedUrl)) {
        const home = await this.feedReader.confirmHomeEmpty();
        if (home.state === 'empty_feed_confirmed') {
          return {
            type: 'cards',
            payload: {
              cards: [],
              listKind: 'feed',
              listState: 'empty',
              ...(this.startupId ? { startupId: this.startupId } : {}),
              ...(home.generation ? { documentGeneration: home.generation } : {}),
            },
            presence: '首页暂时没有可浏览的帖子…',
          };
        }
        if (home.state === 'cards_ready' && home.loading === false) {
          return {
            type: 'cards',
            payload: {
              cards: [],
              listKind: 'feed',
              listState: 'present_unreportable',
              ...(this.startupId ? { startupId: this.startupId } : {}),
              ...(home.generation ? { documentGeneration: home.generation } : {}),
            },
            presence: '首页有内容，但当前卡片暂时无法可靠解析…',
          };
        }
        lastEmptyReason = home.state === 'feed_still_loading' || home.loading === true ? 'feed_still_loading' : 'no_feed';
      }
      return { type: 'action', payload: { action: 'scroll', ok: false, reason: lastEmptyReason ?? 'no_target' } };
    }
    this.log('[fb-session] 连续滚动无新卡（未确认到底，轮次耗尽）→ feed_exhausted 兜底换批');
    return { type: 'action', payload: { action: 'scroll', ok: false, reason: 'feed_exhausted' } };
  }

  /** 普通浏览搜索：导航 FB 全站帖子搜索页，再复用同一 feed 扫描器读结果。 */
  /**
   * 浏览侧搜索失败的诚实叙述（change facebook-write-action-visibility）。
   * 成功走 `cards` 分支——那条分支是 presence-only，故成功条目必须在这里就地发（见下方成功返回处）。
   */
  private emitSearchFailed(keyword: string, reason: string): void {
    if (!isAttempted(reason)) return; // 未开始 / 已作废：不产条目、也不叙述成失败
    this.emitCompanionUiEvent({
      kind: 'activity',
      type: 'search_failed',
      sentence: `搜索「${keyword}」失败：${reasonText(reason)}`,
      loopStage: 'feed',
    });
  }

  private async searchBrowse(payload: SearchExecutePayload): Promise<TerminalReport> {
    const keyword = String(payload.keyword ?? '').trim();
    if (!keyword) return { type: 'action', payload: { action: 'search', ok: false, reason: 'no_target' } };

    let searchUrl: string;
    try {
      const url = new URL('/search/posts/', this.feedUrl);
      url.searchParams.set('q', keyword);
      searchUrl = url.toString();
    } catch {
      this.emitSearchFailed(keyword, 'nav_error');
      return { type: 'action', payload: { action: 'search', ok: false, reason: 'nav_error' } };
    }

    const ensure = await this.feedReader.ensureFeed(searchUrl);
    if (!ensure.ok) {
      const reason = ensure.reason ?? 'search_unavailable';
      this.emitSearchFailed(keyword, reason);
      return { type: 'action', payload: { action: 'search', ok: false, reason } };
    }
    this.activeFeedUrl = searchUrl;
    this.listMode = 'feed';
    const settle = await this.feedReader.settleCards({ wallClockMs: FEED_SETTLE_NAV_MS });
    const cards = settle.cards;
    if (cards.length === 0) {
      const reason = settle.reason ?? 'no_candidates';
      this.emitSearchFailed(keyword, reason);
      return { type: 'action', payload: { action: 'search', ok: false, reason } };
    }
    const maxResults = Number.isFinite(payload.maxResults) && (payload.maxResults ?? 0) > 0
      ? Math.floor(payload.maxResults as number)
      : cards.length;
    this.resetCursor(); // 搜索结果 = 全新一批，重置游标后按本批播种
    const shown = cards.slice(0, maxResults);
    // 成功条目就地发：`cards` 分支只发 presence（无 sentence）故不产条目。关键词与卡数此刻均为一手，
    // 绝不猜。无 statsDelta：搜索在云端既不进 interaction.occurred 也不进 dailyUsage，本地不得凭空计数。
    this.emitCompanionUiEvent({
      kind: 'activity',
      type: 'search',
      sentence: `搜索「${keyword}」，找到 ${shown.length} 条`,
      loopStage: 'feed',
    });
    // presence 随 cards 分支统一发，避免这里发一句立刻被覆盖（列表面是搜索结果、不是推荐流）。
    return {
      type: 'cards',
      payload: this.toPageCards(this.seedCursor(shown)),
      presence: `正在看「${keyword}」的搜索结果…`,
    };
  }

  /**
   * 返回列表面：回到**发起本次浏览的当前列表面**（activeFeedUrl，可能是搜索结果页），而非会话初始首页
   * —— 修 split-brain：从搜索结果开帖后返回被带回首页、搜索结果丢失、下次从头重搜。
   */
  private async backToFeed(): Promise<TerminalReport> {
    const ensure = await this.feedReader.ensureFeed(this.activeFeedUrl);
    if (!ensure.ok) {
      return { type: 'action', payload: { action: 'back', ok: false, reason: ensure.reason ?? 'no_feed' } };
    }
    const settle = await this.feedReader.settleCards({ wallClockMs: FEED_SETTLE_NAV_MS });
    if (settle.cards.length === 0) {
      return { type: 'action', payload: { action: 'back', ok: false, reason: settle.reason ?? 'no_feed' } };
    }
    // 返回列表面 = 给云端一份当前位置的完整候选（不过滤，避免返回后无候选），并把它们并入游标供后续 scroll 去重。
    return { type: 'cards', payload: this.toPageCards(this.seedCursor(settle.cards)) };
  }

  /** 关闭当前帖（详情态 dialog）：导航回 feed 关闭 dialog，诚实回 close ok。 */
  private async closeNote(): Promise<TerminalReport> {
    await this.navigateFeedBestEffort();
    return { type: 'action', payload: { action: 'close', ok: true } };
  }

  /**
   * feed.refresh 实装：页内点顶栏首页图标换批（SPA、不整页重载），后置校验「首卡 permalink 变更且非空」。
   * 成功回单一终态 page.cards（既推进云端循环又是成功信号）；失败诚实回 action.completed，绝不报陈旧卡。
   */
  private async refreshFeed(): Promise<TerminalReport> {
    // 前置门 + 幂等确保在可刷新的 feed（已在首页则不导航）。ensureFeed 内含 consent / 登录 / 验证码复检。
    const ensure = await this.feedReader.ensureFeed(this.feedUrl);
    if (!ensure.ok) {
      return { type: 'action', payload: { action: 'refresh', ok: false, reason: ensure.reason ?? 'wrong_context' } };
    }
    this.activeFeedUrl = this.feedUrl;
    this.listMode = 'feed';
    // 基线首卡 permalink（点击前）。
    const before = await this.feedReader.scanCards();
    const beforeTop = before[0]?.noteId ?? '';
    // 页内点首页图标换批；定位不到 → 受频率下限约束的 Page.reload 兜底（仅本路径可达）。
    const clicked = await this.feedReader.clickHomeAndScrollTop();
    if (!clicked.ok) {
      const reloaded = await this.reloadFeedFallback();
      if (!reloaded) {
        return { type: 'action', payload: { action: 'refresh', ok: false, reason: clicked.reason ?? 'no_home_link' } };
      }
    }
    // 后置校验：首卡 permalink 非空且 ≠ 基线（实机证实「滚动回顶」不可靠，故不以回顶为判据）。
    const settle = await this.feedReader.settleCards({ wallClockMs: FEED_SETTLE_INPLACE_MS });
    const afterTop = settle.cards[0]?.noteId ?? '';
    if (settle.cards.length === 0 || !afterTop || afterTop === beforeTop) {
      return { type: 'action', payload: { action: 'refresh', ok: false, reason: settle.reason ?? 'not_refreshed' } };
    }
    this.resetCursor(); // 换批成功 = 全新一批，重置游标后按本批播种
    return { type: 'cards', payload: this.toPageCards(this.seedCursor(settle.cards)) };
  }

  /** refresh 的整页重载兜底：仅页内换批不可用时用，带频率下限（≥3min），仅本方法可达（恢复/滚动路径永不触发）。 */
  private async reloadFeedFallback(): Promise<boolean> {
    if (!refreshReloadAllowed(this.lastReloadAt, Date.now(), REFRESH_RELOAD_FLOOR_MS)) {
      this.log('[fb-session] refresh reload 兜底距上次 <3min，拒绝重复整页重载');
      return false;
    }
    this.lastReloadAt = Date.now();
    try {
      await this.cdp.send('Page.reload', { ignoreCache: false });
      return true;
    } catch (err) {
      this.log(`[fb-session] refresh reload 兜底失败：${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Facebook 本人昵称采集：云端会在首个 page.cards 后下发 profile.open{direct:true}。
   * v1 只支持 direct 自己主页采集，回 profile.detail 解除云端 nickname-enricher 等待；
   * 不支持普通作者主页/关注链路，避免扩大自动行为面。
   */
  private async runProfileCommand(payload: ProfileOpenPayload): Promise<void> {
    let settled = false;
    const emitOnce = (report: TerminalReport): void => {
      if (settled) return;
      settled = true;
      this.emit(report);
    };
    const running = this.trackWriter(() => this.openDirectProfile(payload));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.orphanWriters++;
        void running.finally(() => {
          this.orphanWriters--;
        });
        this.log(
          `[fb-session] profile.open direct 超时（${this.commandTimeoutMs}ms），回 extracted:false；` +
            `执行体仍可能在写页面 → 登记孤儿写者（当前 ${this.orphanWriters}）`,
        );
        emitOnce({ type: 'profile', payload: this.profileFallback(payload.authorId) });
        resolve();
      }, this.commandTimeoutMs);
      running
        .then((report) => {
          clearTimeout(timer);
          emitOnce(report);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          if (err instanceof TaskTakeoverError) {
            this.log('[fb-session] profile.open direct 在安全取消点被独占任务接管 → 零副作用作废');
            emitOnce({ type: 'action', payload: { action: 'profile_open', ok: false, reason: 'preempted_by_task' } });
            resolve();
            return;
          }
          this.log(`[fb-session] profile.open direct 失败：${(err as Error).message}`);
          emitOnce({ type: 'profile', payload: this.profileFallback(payload.authorId) });
          resolve();
        });
    });
  }

  private async openDirectProfile(payload: ProfileOpenPayload): Promise<TerminalReport> {
    const requestedAuthorId = String(payload.authorId ?? '').trim();
    await this.thinkBefore(payload.thinkMs);
    // change facebook-nickname-capture-timing：本人昵称采集**就地读**（id 锚定顶栏头像标签），
    // 绝不为取昵称导航 profile.php / /me（与 facebook-identity「取昵称绝不导航」契约一致）。
    // 就地读从不离开 feed → 采集完的 back 经幂等 ensureFeed 变空操作、不整页重载。
    // 上报按【就地读到的】数字 id 自校验：读到不匹配的 id → authorId≠连接 accountId，云端按「非本人」安全忽略（绝不写错账号）。
    // 措辞刻意不带「命令: profile.open」——那会命中壳侧中文兜底表里的小红书专属规则
    // （ui-events.cjs 的 /命令: profile\.open/ → 在场感「顺路去作者主页看看…」），而 FB 是**就地读、从不跳转**，
    // 那句在 FB 上是假话。兜底表是小红书会话专属的，FB 一律走结构化 [ui-event] 行。
    this.log(`[fb-session] profile.open direct（就地读, authorId=${requestedAuthorId || '<self>'}）`);
    const idRes = await readFacebookIdentity(this.cdp, {
      allowNavigate: false,
      logger: (m) => this.log(m),
      sleep: this.sleep,
    });
    if (!idRes.ok) {
      this.log(`[fb-session] profile.detail direct 就地读身份失败（${idRes.reason}）→ 空昵称回执（不导航、不猜）`);
      return { type: 'profile', payload: this.profileFallback(requestedAuthorId) };
    }
    const authorId = idRes.identity.accountId;
    const nickname = (idRes.identity.displayName ?? '').trim();
    this.log(
      `[fb-session] profile.detail direct authorId=${authorId}` +
        `${nickname ? ` nickname="${nickname}"` : ' nickname=<empty>'} extracted=false（就地读、无导航）`,
    );
    return {
      type: 'profile',
      payload: {
        authorId,
        postsCount: 0,
        followersCount: 0,
        likesCollects: 0,
        extracted: false,
        ...(nickname ? { nickname } : {}),
      },
    };
  }

  private profileFallback(authorId?: string): ProfileDetailPayload {
    return {
      authorId: authorId ?? '',
      postsCount: 0,
      followersCount: 0,
      likesCollects: 0,
      extracted: false,
    };
  }

  private async navigateFeedBestEffort(): Promise<void> {
    try {
      // 回到当前列表面（activeFeedUrl，可能是搜索页），而非会话初始首页——与 backToFeed 一致，不丢搜索上下文。
      await this.cdp.send('Page.navigate', { url: this.activeFeedUrl });
    } catch {
      /* best-effort：关 dialog 失败不影响回执 */
    }
  }

  /** 「新批」重置游标（首屏 / 刷新 / 搜索结果 = 全新列表）。 */
  private resetCursor(): void {
    this.seenPostIds.clear();
    this.seenReelIdentities.clear();
    this.reelViewActivityPostIds.clear();
  }

  /** 播种：把整批卡标记为已上报并连续重排 index（不过滤）。首屏/刷新/返回用——保证云端总有候选。 */
  private seedCursor(cards: FacebookFeedCard[]): FacebookFeedCard[] {
    const out: FacebookFeedCard[] = [];
    for (const c of cards) {
      const key = canonicalPostId(c.noteId);
      if (key) this.seenPostIds.add(key);
      out.push({ ...c, index: out.length });
    }
    return out;
  }

  /** 只取**未见过**的顶层新卡、标记为已见、连续重排 index（page.scroll 用；回收的旧卡重现被滤掉）。 */
  private takeNewCards(cards: FacebookFeedCard[]): FacebookFeedCard[] {
    const fresh: FacebookFeedCard[] = [];
    for (const c of cards) {
      const key = canonicalPostId(c.noteId);
      if (key && this.seenPostIds.has(key)) continue; // 已上报过（含回收重现）→ 不重复作候选
      if (key) this.seenPostIds.add(key);
      fresh.push({ ...c, index: fresh.length });
    }
    return fresh;
  }

  private toPageCards(cards: FacebookFeedCard[]): PageCardsPayload {
    return {
      cards: cards.map((c, i) => ({
        index: c.index ?? i,
        title: c.textPreview ?? '',
        likeCount: c.reactionCount,
        collectCount: 0, // FB 无收藏：诚实缺省
        noteId: c.noteId,
        isVideo: c.isVideo,
        ...(c.author ? { author: c.author } : {}),
      })),
      ...(this.startupId ? { startupId: this.startupId } : {}),
      listKind: 'feed',
      listState: 'ready',
    };
  }

  /** Cloud 授权后的唯一 Reels 入口；普通 0 卡/滚动命令不可达。 */
  private async enterReels(): Promise<TerminalReport> {
    if (this.listMode === 'reels') return this.scrollReels();
    const card = await this.reelsReader.enter();
    if (!card) return { type: 'action', payload: { action: 'scroll', ok: false, reason: 'no_target' } };
    this.listMode = 'reels';
    this.activeFeedUrl = FACEBOOK_REELS_ENTRY_URL;
    this.resetCursor();
    this.seedReel(card);
    this.log(`[fb-session] Cloud 已授权首页空态 fallback → Reels ${card.noteId}`);
    return { type: 'cards', payload: this.toReelPageCards(card), presence: '正在浏览 Reels 视频流…' };
  }

  private async openReelNote(noteId: string): Promise<TerminalReport> {
    const card = await this.reelsReader.readActive();
    const activeKey = canonicalPostId(card?.noteId);
    const requestedKey = canonicalPostId(noteId);
    if (!card || !activeKey || !requestedKey || activeKey !== requestedKey) {
      return { type: 'action', payload: { action: 'open_note', ok: false, reason: 'no_target' } };
    }
    return {
      type: 'detail',
      payload: {
        noteId: card.noteId,
        title: card.summary.slice(0, 60),
        content: card.summary,
        mediaType: 'video',
        likeCount: 0,
        collectCount: 0,
        url: card.noteId,
        ...(card.author ? { author: card.author } : {}),
      },
    };
  }

  private async scrollReels(): Promise<TerminalReport> {
    const card = await this.reelsReader.next();
    if (!card) return { type: 'action', payload: { action: 'scroll', ok: false, reason: 'no_target' } };
    const identity = this.reelIdentity(card);
    if (this.seenReelIdentities.has(identity)) {
      return { type: 'action', payload: { action: 'scroll', ok: false, reason: 'no_target' } };
    }
    this.seedReel(card);
    return { type: 'cards', payload: this.toReelPageCards(card), presence: '正在浏览 Reels 视频流…' };
  }

  private seedReel(card: FacebookReelCard): void {
    const key = canonicalPostId(card.noteId);
    if (key) this.seenPostIds.add(key);
    this.seenReelIdentities.add(this.reelIdentity(card));
  }

  private reelIdentity(card: FacebookReelCard): string {
    return `${canonicalPostId(card.noteId) || card.noteId}\n${card.videoKey}`;
  }

  private toReelPageCards(card: FacebookReelCard): PageCardsPayload {
    return {
      cards: [{
        index: 0,
        title: card.summary,
        likeCount: 0,
        collectCount: 0,
        noteId: card.noteId,
        isVideo: true,
        ...(card.author ? { author: card.author } : {}),
      }],
      ...(this.startupId ? { startupId: this.startupId } : {}),
      listKind: 'reels',
      listState: 'ready',
    };
  }

  private actionName(type: string): string {
    return facebookActionNameForCommand(type);
  }
}
