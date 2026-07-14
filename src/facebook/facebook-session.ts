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
 * action.completed），零改 protocol.ts。
 *
 * 红线：
 *  - 每条命令恰好一个诚实回执（page.cards / note.detail / action.completed）；有界超时兜底 timeout 回执，
 *    绝不静默丢弃 / 假成功（否则云端 sendAndAwait + idle 看门狗挂死）。
 *  - kill switch `AIDCP_FB_BROWSE_AUTO`（三态 off/shadow/on）：off=不自动浏览/点赞（评论/加群仍服务）；
 *    shadow=浏览+上报但点赞只记不执行；on=真点赞。默认 off。
 *  - FB 无收藏/关注/看图（v1）：这些命令诚实回 capability_unsupported，绝不臆造。
 */

import { evalJson, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayMonitor } from '../browse/overlay-monitor.js';
import { jitterAround } from '../humanize/index.js';
import type { EdgeBrowseSession } from '../browse/edge-browse-session.js';
import { TaskTakeoverError, BrowseQuiesceTimeoutError, DEFAULT_TASK_QUIESCE_MS } from '../browse/browse-session.js';
import type {
  Envelope,
  ActionCompletedPayload,
  NoteDetailPayload,
  NoteOpenPayload,
  InteractionLikePayload,
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
import { FacebookFeedReader, type FacebookFeedCard } from './feed-reader.js';
import { FacebookPostReader } from './post-reader.js';
import { FacebookLikeExecutor } from './like-executor.js';
import { FacebookCommentHandler } from './comment-handler.js';
import { defaultFacebookConsentAccepter, type FacebookConsentAccepter } from './consent.js';

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
  | { type: 'cards'; payload: PageCardsPayload }
  | { type: 'detail'; payload: NoteDetailPayload }
  | { type: 'profile'; payload: ProfileDetailPayload }
  | { type: 'action'; payload: ActionCompletedPayload };

/**
 * 伴随桌面端的结构化事件。云端 `dailyUsage` 才是账号今日总量的权威；这里仅把已确认的
 * Facebook 动作即时投影到当前子进程的活动流、在场状态和本地兜底计数，不能据此猜测成功。
 */
interface FacebookCompanionUiEvent {
  kind: 'activity' | 'presence';
  type: 'session_start' | 'feed' | 'note_open' | 'like';
  sentence?: string;
  presence?: string;
  loopStage?: 'feed' | 'read' | 'interact';
  statsDelta?: { views?: number; likes?: number };
}

interface FacebookProfileSnapshot {
  url?: string;
  title?: string;
  nickname?: string;
  bodyTextLen?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** feed 判稳 wall-clock：导航类（首屏/返回/搜索）给足页面加载；原地类（滚动/刷新换批）更短。 */
const FEED_SETTLE_NAV_MS = 6_000;
const FEED_SETTLE_INPLACE_MS = 3_500;
/** refresh 的 Page.reload 兜底频率下限（毫秒）。 */
const REFRESH_RELOAD_FLOOR_MS = 3 * 60_000;
/** 孤儿写者排空的轮询间隔（change lease-strict-preemption）。 */
const WRITER_DRAIN_POLL_MS = 100;

/** refresh 的 Page.reload 兜底频率闸：距上次兜底达到下限才放行（纯函数，便于单测）。 */
export function refreshReloadAllowed(lastReloadAt: number, now: number, floorMs: number): boolean {
  if (!lastReloadAt || lastReloadAt <= 0) return true;
  return now - lastReloadAt >= floorMs;
}

/**
 * 把帖子详情压成活动流可读的一行：仅使用已成功读取的作者和正文，清掉换行并按字符截断。
 * 元数据缺失时宁可退回通用文案，绝不把 permalink / noteId 当作可读标题展示。
 */
function clipFacebookUiText(value: string | undefined, max: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : normalized;
}

function facebookReadUiText(payload: NoteDetailPayload): Pick<FacebookCompanionUiEvent, 'sentence' | 'presence'> {
  const excerpt = clipFacebookUiText(payload.content || payload.title, 24);
  const author = clipFacebookUiText(payload.author, 18);
  if (excerpt && author) {
    return {
      sentence: `打开「${excerpt}」 · ${author}`,
      presence: `正在读 ${author} 的「${excerpt}」…`,
    };
  }
  if (excerpt) return { sentence: `打开「${excerpt}」`, presence: `正在认真阅读「${excerpt}」…` };
  if (author) return { sentence: `打开了 ${author} 的一条内容`, presence: `正在认真阅读 ${author} 的一条内容…` };
  return { sentence: '打开了一条内容', presence: '正在认真阅读一条内容…' };
}

export class FacebookBrowseSession implements EdgeBrowseSession {
  private readonly cdp: BrowseCdp;
  private readonly client: FacebookSessionClient;
  private readonly commentHandler: FacebookCommentHandler;
  private readonly feedReader: FacebookFeedReader;
  private readonly postReader: FacebookPostReader;
  private readonly likeExecutor: FacebookLikeExecutor;
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
  /** 最近一次 page.cards 到达时间；用于吸收云端评估耗时，避免 dwellMs 变成额外固定等待。 */
  private lastCardsAt = 0;
  /** 最近一次 refresh 的 Page.reload 兜底时刻；配 REFRESH_RELOAD_FLOOR_MS 做频率下限。 */
  private lastReloadAt = 0;
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
  /** 当前在执行的命令拍下的世代号；为 null 表示无命令在执行。 */
  private activeCommandEpoch: number | null = null;
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

  /** 当前命令是否已被更高优先级的独占任务接管：仅在命令执行中且交接已推进世代号时为真。 */
  private takeoverRequested(): boolean {
    return this.activeCommandEpoch !== null && this.taskBlockEpoch !== this.activeCommandEpoch;
  }

  /** 在安全取消点检查接管：已被接管即抛出，令本命令零页面副作用地作废。 */
  private throwIfTakeover(): void {
    if (this.takeoverRequested()) throw new TaskTakeoverError();
  }

  /**
   * 页面写者记账：**只在 fn 真正 settle 时才减计数**。命令超时放行串行链不减 —— 那正是孤儿写者。
   */
  private trackWriter<T>(fn: () => Promise<T>): Promise<T> {
    this.activePageWriters++;
    const epoch = this.taskBlockEpoch;
    this.activeCommandEpoch = epoch;
    return fn().finally(() => {
      this.activePageWriters--;
      if (this.activeCommandEpoch === epoch) this.activeCommandEpoch = null;
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
        await this.trackWriter(() => this.commentHandler.handle(env)); // 委托执行体同样是页面写者：让位必须等它真停
        return;
      }
      case 'interaction.comment':
      case 'group.join':
        await this.trackWriter(() => this.commentHandler.handle(env)); // 委托执行体同样是页面写者：让位必须等它真停
        return;
      case 'note.open': {
        const payload = (env.payload ?? {}) as NoteOpenPayload;
        // url 存在 = 评论支线按 permalink 开帖（读评论供撰写）；否则 = 浏览闭环按卡片 noteId 深读。
        if (payload.url) {
          await this.trackWriter(() => this.commentHandler.handle(env)); // 委托执行体同样是页面写者：让位必须等它真停
          return;
        }
        await this.runBrowseCommand('open_note', async () => {
          await this.thinkBefore(payload.thinkMs); // 开帖前犹豫（云端中心值 × tempo + 抖动）
          return this.openBrowseNote(payload.noteId);
        });
        return;
      }
      // —— 浏览/点赞类（受 kill switch 门控）——
      case 'page.scroll': {
        const payload = (env.payload ?? {}) as PageScrollPayload;
        await this.runBrowseCommand('scroll', async () => {
          await this.ensureFeedDwell(payload.dwellMs);
          return this.scrollFeed();
        });
        return;
      }
      case 'feed.refresh':
        await this.runBrowseCommand('refresh', () => this.refreshFeed());
        return;
      case 'interaction.like': {
        const payload = env.payload as InteractionLikePayload;
        await this.runBrowseCommand('like', async () => {
          await this.thinkBefore(payload?.thinkMs); // 点赞前犹豫（云端中心值 × tempo + 抖动）
          return this.likeCurrent(payload);
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
      case 'interaction.follow':
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
   * feed 翻页前确保本批卡片已停留到云端目标；已花掉的 LLM/网络时间会被吸收，不双重叠加。
   * **安全取消点**：同上。停留是「离页前的等待」，让路时不改任何页面状态。
   */
  private async ensureFeedDwell(dwellMs?: number): Promise<void> {
    if (!dwellMs || dwellMs <= 0 || this.lastCardsAt <= 0) return;
    const target = jitterAround(dwellMs * this.tempo, 0.2);
    const elapsed = Date.now() - this.lastCardsAt;
    const remaining = Math.max(0, target - elapsed);
    if (remaining > 0) await this.sleepInterruptible(remaining);
    this.throwIfTakeover();
  }

  private emit(r: TerminalReport): void {
    if (r.type === 'cards') {
      this.lastCardsAt = Date.now();
      this.client.reportPageCards(r.payload);
      this.emitCompanionUiEvent({
        kind: 'presence',
        type: 'feed',
        presence: '正在浏览推荐流…',
        loopStage: 'feed',
      });
    }
    else if (r.type === 'detail') {
      this.client.reportNoteDetail(r.payload);
      const readText = facebookReadUiText(r.payload);
      this.emitCompanionUiEvent({
        kind: 'activity',
        type: 'note_open',
        ...readText,
        loopStage: 'read',
        statsDelta: { views: 1 },
      });
    }
    else if (r.type === 'profile') this.client.reportProfileDetail(r.payload);
    else {
      this.client.reportActionCompleted(r.payload);
      if (r.payload.action === 'like' && r.payload.ok) {
        this.emitCompanionUiEvent({
          kind: 'activity',
          type: 'like',
          sentence: '点了个赞',
          presence: '刚点了个赞',
          loopStage: 'interact',
          statsDelta: { likes: 1 },
        });
      }
    }
  }

  private emitCompanionUiEvent(event: FacebookCompanionUiEvent): void {
    this.log(`[ui-event] ${JSON.stringify(event)}`);
  }

  /** 导航 feed → 扫卡 → 上报 page.cards（首屏 / 重连恢复）。无命令可回，best-effort 直发。 */
  private async reportInitialFeed(): Promise<void> {
    const ensure = await this.feedReader.ensureFeed(this.feedUrl);
    if (!ensure.ok) {
      this.log(`[fb-session] feed 未就绪（${ensure.reason}）：不上报首屏（云端看门狗后续可 nudge）`);
      return;
    }
    this.activeFeedUrl = this.feedUrl;
    const settle = await this.feedReader.settleCards({ wallClockMs: FEED_SETTLE_NAV_MS });
    if (settle.cards.length === 0) {
      this.log(`[fb-session] feed 就绪但无可上报卡片（${settle.reason ?? 'no_target'}）`);
      return;
    }
    if (settle.degraded) this.log(`[fb-session] initial settle degraded：上报 ${settle.cards.length} 张（未完全稳定，卡为真抽）`);
    this.emit({ type: 'cards', payload: this.toPageCards(settle.cards) });
    this.log(`[fb-session] 已上报首屏 ${settle.cards.length} 张 feed 卡片`);
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
    const r = await this.likeExecutor.like({ shadow, ...(noteId ? { noteId } : {}) });
    // ok:true 才让云端经 RiskController.record 记账；shadow/失败一律 ok:false（云端不记、不扣风控）。
    return { type: 'action', payload: { action: 'like', ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) } };
  }

  /** feed 翻页 → 判稳扫卡 → page.cards。ensureFeed 幂等：已在 feed 就不重新导航（不重置滚动位置）。 */
  private async scrollFeed(): Promise<TerminalReport> {
    // 只有确认已在目标列表面后才能滚动。ensureFeed 幂等——已在首页/搜索页且无 dialog 时直接放行、不导航，
    // 因此连续滚动能真正累积深度，而非每次被整页重载钉回第一屏。
    const ensure = await this.feedReader.ensureFeed(this.activeFeedUrl);
    if (!ensure.ok) {
      return { type: 'action', payload: { action: 'scroll', ok: false, reason: ensure.reason ?? 'no_feed' } };
    }
    await this.feedReader.scrollNext();
    const settle = await this.feedReader.settleCards({ wallClockMs: FEED_SETTLE_INPLACE_MS });
    if (settle.cards.length === 0) {
      return { type: 'action', payload: { action: 'scroll', ok: false, reason: settle.reason ?? 'no_target' } };
    }
    if (settle.degraded) this.log(`[fb-session] scroll settle degraded：上报 ${settle.cards.length} 张（未完全稳定，卡为真抽）`);
    return { type: 'cards', payload: this.toPageCards(settle.cards) };
  }

  /** 普通浏览搜索：导航 FB 全站帖子搜索页，再复用同一 feed 扫描器读结果。 */
  private async searchBrowse(payload: SearchExecutePayload): Promise<TerminalReport> {
    const keyword = String(payload.keyword ?? '').trim();
    if (!keyword) return { type: 'action', payload: { action: 'search', ok: false, reason: 'no_target' } };

    let searchUrl: string;
    try {
      const url = new URL('/search/posts/', this.feedUrl);
      url.searchParams.set('q', keyword);
      searchUrl = url.toString();
    } catch {
      return { type: 'action', payload: { action: 'search', ok: false, reason: 'nav_error' } };
    }

    const ensure = await this.feedReader.ensureFeed(searchUrl);
    if (!ensure.ok) {
      return { type: 'action', payload: { action: 'search', ok: false, reason: ensure.reason ?? 'search_unavailable' } };
    }
    this.activeFeedUrl = searchUrl;
    const settle = await this.feedReader.settleCards({ wallClockMs: FEED_SETTLE_NAV_MS });
    const cards = settle.cards;
    if (cards.length === 0) return { type: 'action', payload: { action: 'search', ok: false, reason: settle.reason ?? 'no_candidates' } };
    const maxResults = Number.isFinite(payload.maxResults) && (payload.maxResults ?? 0) > 0
      ? Math.floor(payload.maxResults as number)
      : cards.length;
    return { type: 'cards', payload: this.toPageCards(cards.slice(0, maxResults)) };
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
    return { type: 'cards', payload: this.toPageCards(settle.cards) };
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
    return { type: 'cards', payload: this.toPageCards(settle.cards) };
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
    const authorId = String(payload.authorId ?? '').trim();
    if (!authorId) return { type: 'profile', payload: this.profileFallback(authorId) };
    await this.thinkBefore(payload.thinkMs);
    const url = /^\d+$/.test(authorId)
      ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(authorId)}`
      : `https://www.facebook.com/${encodeURIComponent(authorId)}`;
    this.log(`[fb-session] 命令: profile.open direct（authorId=${authorId}）`);
    await this.cdp.send('Page.navigate', { url });
    const snapshot = await this.waitAndReadProfile();
    const nickname = (snapshot.nickname ?? '').trim();
    const landedUrl = snapshot.url?.startsWith('https://www.facebook.com/') ? snapshot.url : url;
    this.log(
      `[fb-session] profile.detail direct authorId=${authorId}` +
        `${nickname ? ` nickname="${nickname}"` : ' nickname=<empty>'} extracted=false`,
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
        ...(landedUrl ? { url: landedUrl } : {}),
      },
    };
  }

  private async waitAndReadProfile(timeoutMs = 8000): Promise<FacebookProfileSnapshot> {
    const deadline = Date.now() + timeoutMs;
    let last: FacebookProfileSnapshot = {};
    while (Date.now() < deadline) {
      last = await this.readProfileSnapshot();
      if (last.nickname || (last.bodyTextLen ?? 0) > 0) return last;
      await this.sleep(300);
    }
    return last;
  }

  private async readProfileSnapshot(): Promise<FacebookProfileSnapshot> {
    return evalJson<FacebookProfileSnapshot>(
      this.cdp,
      `(() => {
        const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const title = clean(document.title).replace(/\\s*\\|\\s*Facebook\\s*$/i, '');
        const h1 = clean(document.querySelector('h1')?.textContent || '');
        const mainH1 = clean(document.querySelector('[role="main"] h1')?.textContent || '');
        const bodyText = clean(document.body?.innerText || '');
        const nickname = [mainH1, h1, title].find((v) =>
          v && !/^(Facebook|首页|Home|通知|Notifications)$/i.test(v)
        ) || '';
        return JSON.stringify({
          url: location.href,
          title: document.title,
          nickname,
          bodyTextLen: bodyText.length
        });
      })()`,
    );
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
    };
  }

  private actionName(type: string): string {
    return facebookActionNameForCommand(type);
  }
}
