/**
 * 浏览会话编排（命令驱动模式）。
 *
 * Edge 端不做任何内容决策，仅作为 Cloud 端的命令执行器：
 *
 *   启动 → 上报可见卡片(page.cards) → 等待 Cloud 指令 → 执行 → 上报结果 → 继续等待
 *
 * Cloud 端（ContentEvaluator / RoleDispatcher）负责所有决策：
 *   - 打开哪张卡片
 *   - 是否点赞/收藏/关注
 *   - 何时滚动、何时搜索、何时结束会话
 *
 * 人类行为模拟（见 docs/risk-control.md §3）保留：所有停顿用对数正态分布采样
 * （HumanizedTiming），按会话进度施加疲劳曲线（SessionRhythm）；点击走贝塞尔轨迹、
 * 滚动走惯性序列、输入走键盘节奏（在各子模块内）。
 */

import type {
  Envelope,
  NoteContentPayload,
  PlanResponsePayload,
  PlanStep,
  PageCardsPayload,
  NoteDetailPayload,
  ProfileDetailPayload,
  ActionCompletedPayload,
  PageScrollPayload,
  FeedRefreshPayload,
  PacingUpdatePayload,
  NoteOpenPayload,
  NoteClosePayload,
  InteractionLikePayload,
  InteractionCollectPayload,
  InteractionFollowPayload,
  InteractionCommentPayload,
  InteractionLikeCommentPayload,
  NavigationBackPayload,
  NoteBrowseImagesPayload,
  NoteScrollCommentsPayload,
  ProfileOpenPayload,
  NotificationOpenPayload,
  NotificationBrowseCommentsPayload,
  NotificationBrowseLikesPayload,
  NotificationBrowseFollowsPayload,
  NotificationBackHomePayload,
  SessionEndPayload,
} from '../comm/protocol.js';
import type { ActionResultPayload, CommentCandidate } from '../comm/protocol.js';
import type { PacingOp, PacingFloorPayload } from '../comm/protocol.js';
import type { FeedScroller, NoteCard } from './feed-scroller.js';
import type { ModalController } from './modal-controller.js';
import type { LoginModalWatcher } from './login-modal-watcher.js';
import type { OverlayKind, OverlayMonitor } from './overlay-monitor.js';
import { isBlockingKind } from './overlay-monitor.js';
import type { extractNoteContent as ExtractFn, NoteContent } from './note-extractor.js';
import { NOTE_BODY_SELECTORS, parseCount } from './note-extractor.js';
import { executeSearch, applySearchFilters, SEARCH_RESULT_URL_RE, searchResultMatchesKeyword } from './search-handler.js';
import { evalRaw, InputDispatchDeadlineError, type RandomFn, type BrowseCdp } from './cdp-util.js';
import { CdpDisconnectedError } from '../cdp/client.js';
import { buildNotificationHomeJs, buildNotificationItemsJs, buildNotificationCategoryItemsJs } from './notification-monitor.js';
import type { DomProvider } from '../locating/engine.js';
import {
  sampleDelay,
  sampleReflect,
  jitterAround,
  TIMING_PRESETS,
  generateScrollSequence,
  type TimingConfig,
  createDefaultRhythm,
  applySpeedFactor,
  type SessionRhythm,
} from '../humanize/index.js';

/** 步骤执行器（与 EdgeClient.StepRunner 同形，用于执行 like 等 plan 步骤） */
export interface StepRunnerLike {
  run(step: PlanStep): Promise<ActionResultPayload>;
}

/** 与云端通信的最小子集（便于测试打桩） */
export interface BrowseCloudClient {
  reportNoteContent(payload: NoteContentPayload, timeoutMs?: number): Promise<Envelope>;
  /** fire-and-forget 发送（用于上报卡片摘要，不等响应） */
  send?(type: string, payload: unknown): void;
  // v2 上报方法
  reportPageCards?(payload: PageCardsPayload): void;
  reportNoteDetail?(payload: NoteDetailPayload): void;
  reportProfileDetail?(payload: ProfileDetailPayload): void;
  reportActionCompleted?(payload: ActionCompletedPayload): void;
}

export interface BrowseSessionDeps {
  dom: DomProvider;
  cdp: BrowseCdp;
  client: BrowseCloudClient;
  scroller: FeedScroller;
  noteExtractor: typeof ExtractFn;
  modalCtrl: ModalController;
  /** like 等 plan 步骤执行器（通常是 LikeStepRunner） */
  stepRunner: StepRunnerLike;
  /**
   * 登录弹窗检测器（可选，legacy 内联探测）：注入后，每条命令执行前若检测到登录浮层则暂停，
   * 轮询等待用户登录、弹窗消失后再恢复。未注入且未注入 overlayMonitor 时闸门为 no-op（向后兼容）。
   */
  loginGate?: LoginModalWatcher;
  /**
   * 弹窗旁路监测体（可选，推荐）：注入后闸门改读其缓存状态（零 CDP）——
   * 对 login/captcha/unknown 暂停；high-risk 动作（like/collect/follow）提交前用
   * probeNow() 做一次 fresh 复检（验证码 fail-CLOSED，避免点进风控墙）。
   * 同时注入 overlayMonitor 与 loginGate 时，优先用 overlayMonitor。
   */
  overlayMonitor?: OverlayMonitor;
}

export interface BrowseSessionOptions {
  /** 随机源（注入便于测试确定性） */
  random?: RandomFn;
  /** 注入 sleep（测试用，默认 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 卡片间停顿分布（默认 TIMING_PRESETS.cardGap） */
  cardGapTiming?: TimingConfig;
  /** 操作间停顿分布（默认 TIMING_PRESETS.action） */
  actionTiming?: TimingConfig;
  /** modal 打开超时（毫秒，默认 5000） */
  modalTimeoutMs?: number;
  /** 单次 note.open 的整体墙钟上限（毫秒，默认 30000）；仅在 CDP 安全边界后收敛。 */
  noteOpenTimeoutMs?: number;
  /** 首屏扫描前等待 feed 卡片渲染的最长轮询时间（毫秒，默认 12000） */
  initialScanTimeoutMs?: number;
  /** 登录弹窗闸门的轮询间隔（毫秒，默认 2000）：弹窗存在时多久复检一次 */
  loginGatePollMs?: number;
  /** explore 页 URL（不在该页时导航过去，默认小红书 explore） */
  exploreUrl?: string;
  /** 完整核心/浏览器启动代号；随 page.cards 上报，供云端限定首次启动采集。 */
  startupId?: string;
  /** 会话节奏曲线（默认热身→正常→加速→疲劳） */
  rhythm?: SessionRhythm;
  /**
   * 估算的会话总卡片数（用于计算会话进度 → 疲劳曲线）。
   * 默认回退到 60（约一次正常档会话动作数）。
   */
  rhythmTotal?: number;
  /** 日志（默认 console） */
  logger?: (msg: string) => void;
  /** 详情页停留时长统计用的墙钟（注入便于测试），默认 Date.now。与最小间隔的单调时钟 monoNow 分离、绝不混算。 */
  now?: () => number;
  /**
   * 最小间隔 gating 的**单调时钟**（注入便于测试给可控递增值）：单一注入口、只自身作差、绝不与 now/Date.now
   * 混算或持久化。默认 performance.now()（备选 hrtime）。（pacing-floor-config-min-interval 设计 §3.2）
   */
  monoNow?: () => number;
  /**
   * 详情页最小停留下限区间（毫秒）——缺指令 / 断连兜底用，**非零延迟**。
   * 默认 {min:2500,max:5000}；由 welcome pacing 快照的 detail_dwell 区间下发（复活死参数、设计 §4.3）。
   */
  dwellFloorMs?: { min: number; max: number };
  /**
   * welcome pacing 快照的每类操作 floor 区间（构造期初值；重连经 applyPacingSnapshot 刷新）。
   * 缺该 op → effectiveFloor 逐字段回落 BUILTIN_FLOOR。（设计 §4.2/§4.3）
   */
  opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>;
  /** welcome pacing 快照的风控档标量（边缘乘算；默认 1.0≡无 tempo）。（设计 §7-tempo） */
  tempo?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 详情页停留下限默认区间（与云端 DWELL_FLOOR_MS 同口径；welcome 快照缺 detail_dwell 时的内置回落）。 */
const DEFAULT_DWELL_FLOOR_MS = { min: 2500, max: 5000 } as const;

/** tempo 档位上限（防呆）：云端现役最大 1.6（restricted/frozen）；留足头寸、越界即忽略，杜绝失控大停留逼近 idle 看门狗。 */
const MAX_TEMPO = 3;

/** 由 [min,max] 下限区间构造一个 lognormal 采样配置（中位数取几何中点）。 */
function makeDwellFloorTiming(range: { min: number; max: number }): TimingConfig {
  const lo = Math.max(1, Math.min(range.min, range.max));
  const hi = Math.max(lo, Math.max(range.min, range.max));
  return { mu: Math.log(Math.sqrt(lo * hi)), sigma: 0.25, min: lo, max: hi };
}

// ======== 最小间隔 gating（pacing-floor-config-min-interval，设计 §3/§4.3/§5） ========
//
// 语义：边缘记「上次操作完成时刻」(lastActionEndAt，单调时钟)；下一动作到达时够久（elapsed≥floor）
// 立即执行、不累加，不够只补差额（remaining = max(0, floor−elapsed)）。云端往返被 elapsed 天然吸收。
//
// 三道夹之第三道（边缘二次夹）：即便云端读出口/facade 失守，floor 离开边缘前恒被夹进
// [OP_MIN_FLOOR[op], 类别上限] —— 配置只能抬高延迟、**永远抬不穿非零防呆下限**（绝不零延迟红线）。

/** 每类操作的内置默认区间（welcome 缺该 op 时逐字段回落，量级=现役预设/DWELL_FLOOR_MS，天然非零）。 */
const BUILTIN_FLOOR: Record<PacingOp, PacingFloorPayload> = {
  action: { minMs: 1500, maxMs: 4000 },
  scroll: { minMs: 500, maxMs: 1500 },
  card_gap: { minMs: 3000, maxMs: 7000 },
  detail_dwell: { minMs: 2500, maxMs: 5000 },
  feed_card_read: { minMs: 450, maxMs: 7000 },
  content_glance: { minMs: 2500, maxMs: 90000 },
  content_read: { minMs: 2500, maxMs: 90000 },
};

/** 每类操作的防呆下限（= 边缘二次夹的下界，> 0）：有效 floor 恒 ≥ 此值，杜绝零延迟。 */
const OP_MIN_FLOOR: Record<PacingOp, number> = {
  action: 800,
  scroll: 300,
  card_gap: 1000,
  detail_dwell: 1000,
  feed_card_read: 100,
  content_glance: 1000,
  content_read: 1000,
};

/** 每类操作的采样分散度（内置常量、不入库；较现役预设略放宽以稀释左尾、配合反射采样消硬左壁）。 */
const BUILTIN_SIGMA: Record<PacingOp, number> = {
  action: 0.35,
  scroll: 0.3,
  card_gap: 0.45,
  detail_dwell: 0.25,
  feed_card_read: 0.25,
  content_glance: 0.25,
  content_read: 0.25,
};

/**
 * 前台 gate 小上限（结构上 ≪ 云端 idle 看门狗下限 IDLE_NUDGE_MIN_MS=200_000）：前台动作 floor 恒 ≤ 15s，
 * 阅读停留类另有更高但仍低于看门狗轻推的类别上限，二者与断连兜底/idle 看门狗结构性不冲突（设计 §4.3）。
 */
const CAP_MS = 15_000;

const OP_MAX_FLOOR: Record<PacingOp, number> = {
  action: CAP_MS,
  scroll: CAP_MS,
  card_gap: CAP_MS,
  detail_dwell: CAP_MS,
  feed_card_read: 30_000,
  content_glance: 90_000,
  content_read: 90_000,
};

/** 正数校验：welcome 逐字段回落用（非有限正数 → 回落内置默认，绝不回落 0/负数）。 */
function validPositiveMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 把协议 {minMs,maxMs} 区间转成 dwell 采样用的 {min,max}；任一字段非正数则整体判无效返回 undefined。 */
function floorRangeToMinMax(f: PacingFloorPayload | undefined): { min: number; max: number } | undefined {
  if (!f) return undefined;
  const lo = validPositiveMs(f.minMs);
  const hi = validPositiveMs(f.maxMs);
  if (lo == null || hi == null) return undefined;
  return { min: lo, max: hi };
}

function floorRangeToTiming(f: PacingFloorPayload | undefined, fallback: TimingConfig): TimingConfig {
  const range = floorRangeToMinMax(f);
  return range ? makeDwellFloorTiming(range) : fallback;
}

/** 单调时钟默认实现：优先 performance.now()，备选 process.hrtime.bigint()/1e6（只自身作差、绝不持久化/跨基准）。 */
function defaultMonoNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  const hr = (globalThis as { process?: { hrtime?: { bigint?: () => bigint } } }).process?.hrtime?.bigint;
  if (typeof hr === 'function') return Number(hr()) / 1e6;
  return Date.now();
}

const DEFAULT_EXPLORE_URL = 'https://www.xiaohongshu.com/explore';
const BODY_READ_MIN_CHARS = 240;
const BODY_READ_MIN_LINES = 5;
const COMMENT_PRELUDE_MIN_STEPS = 4;
const COMMENT_PRELUDE_MAX_STEPS = 14;
const COMMENT_SCROLL_MIN_PX = 150;
const COMMENT_SCROLL_MAX_PX = 290;

interface ScrollProbeSnapshot {
  found?: boolean;
  visible?: boolean;
  scrollTop?: number;
  before?: number;
  after?: number;
  scrollHeight?: number;
  clientHeight?: number;
  x?: number;
  y?: number;
  reachedEnd?: boolean;
  atBottom?: boolean;
  moved?: boolean;
}
/**
 * explore feed 页 URL 判定：匹配 /explore（feed 列表），【排除 /explore/<noteId>（笔记详情页）】。
 * 用于 ensureExplore（启动）与 navigateBack（back_to_feed）统一判定是否真在 feed——
 * 历史上松判断 `url.includes('/explore')` 会把详情页误当 feed，导致扫不到卡 → 静默 → 边-云互等死锁。
 */
const EXPLORE_FEED_RE = /\/explore\/?(\?|#|$)/;
// 搜索结果页 URL：经典 /search_result、AI 搜索 /search_result_ai（含 _ai 等后缀）、裸 /search 均算。
// `_result\w*` 覆盖 search_result_ai 这类真机 AI 搜索页——否则诚实闸会把真结果页误判为「未到结果页」而漏报（change comment-search-nav-confirm）。
// 单一真源（change comment-keep-open-through-approval）：与 search-handler 的 executeSearch 判据 import 同一常量，杜绝两处漂移。
const SEARCH_LIST_RE = SEARCH_RESULT_URL_RE;
const DEFAULT_RHYTHM_TOTAL = 60;
const DEFAULT_NOTE_OPEN_TIMEOUT_MS = 30_000;

/** note.open 到达自身安全边界前耗尽整体预算。 */
class NoteOpenDeadlineError extends Error {
  constructor(public readonly phase: string) {
    super(`note.open 超时 phase=${phase}`);
    this.name = 'NoteOpenDeadlineError';
  }
}

/**
 * 命令在**安全取消点**上被更高优先级的独占任务接管（change lease-strict-preemption）。
 *
 * 安全取消点 = 命令入口到它**第一次真正改写页面**之前的整段：阻断浮层等待、动作前统一闸
 * （最小间隔 + 犹豫）、离页/翻页前的停留。这一整段只消耗时间、平台侧零副作用，**不占页面写原子区**。
 * 抛出本错误 = 该命令零页面副作用地作废，由主循环回一条诚实失败回执，**绝不重放**。
 */
export class TaskTakeoverError extends Error {
  constructor() {
    super('命令在安全取消点被独占任务接管');
    this.name = 'TaskTakeoverError';
  }
}

/**
 * 交接（quiesce）在预算内未能等到真写段收敛（change lease-strict-preemption）。
 * 协调器据此 MUST NOT 授予租约、MUST NOT 谎称已收敛、MUST NOT 停在让位态。
 */
export class BrowseQuiesceTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`浏览交接未在 ${timeoutMs}ms 内收敛`);
    this.name = 'BrowseQuiesceTimeoutError';
  }
}

/**
 * 交接上界：只覆盖「真正在改写页面」的动作（纯等待已由安全取消点当场让路）。
 * 云端的受理预算 MUST 大于本值 + 一个消息往返余量，否则边缘按时交接了、云端已判死走人。
 */
export const DEFAULT_TASK_QUIESCE_MS = Number(process.env.AIDCP_TASK_QUIESCE_MS ?? 30_000);

/**
 * 关注按钮选择器（笔记 modal 作者区 + 作者主页两种上下文）。
 * executeFollow（点关注）与 note.open 时的关注态探测 probeAuthorFollowed 共用同一份，
 * 保证「已关注」判定口径完全一致、不漂移（change skip-profile-visit-if-followed）。
 */
const FOLLOW_BUTTON_SELECTORS = ['.author-wrapper .follow-button', '.user-info .follow-button', '.user-page .follow-button', '.follow-button', '.author-follow-btn', '[data-type="follow"]', '.follow-btn'];

/** 浏览会话（命令驱动模式） */
export class BrowseSession {
  private running = false;
  private stopRequested = false;
  private stopInProgress = false;
  /**
   * 终态关闭标记（change restore-auto-resume A②）：进程主动关闭/下线（close()）或 CDP 不可恢复时置 true，
   * 永久阻止云端迟到命令唤醒重启浏览循环。注意：与 stopRequested 区分——云端 session.end 只置 stopRequested、
   * 不置 closing，故 session.end 停循环后仍可被后续浏览类命令唤醒续场；而 close()/CDP 死局是终态、绝不复活。
   */
  private closing = false;
  private readonly random: RandomFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private cardGapTiming: TimingConfig;
  private readonly actionTiming: TimingConfig;
  private scrollTiming: TimingConfig;
  private readonly modalTimeoutMs: number;
  private readonly noteOpenTimeoutMs: number;
  private readonly initialScanTimeoutMs: number;
  private readonly loginGatePollMs: number;
  /** 阻断弹窗当前是否处于"已暂停"状态（用于出现/消失各只记一次日志） */
  private blockingOverlayActive = false;
  private readonly exploreUrl: string;
  private readonly startupId?: string;
  private readonly rhythm: SessionRhythm;
  private readonly rhythmTotal: number;
  private readonly logger: (msg: string) => void;
  private readonly now: () => number;
  /** 最小间隔的单调时钟（单一实现·单一注入口·只自身作差）。 */
  private readonly monoNow: () => number;
  /** 详情页停留下限配置（lognormal，落在 [min,max]） */
  private dwellFloorTiming: TimingConfig;
  /** 当前详情页打开时刻（墙钟 this.now）；无打开的详情页时为 null。 */
  private noteOpenedAt: number | null = null;
  /** 打开笔记前所在的来源列表 URL；用于 navigation.back 直连返回 search/feed，避免回踩详情历史。 */
  private sourceListUrl: string | null = null;
  private sourceListPageType: 'feed' | 'search' | null = null;
  /** 当前 feed 卡片批次的到达时刻（墙钟 this.now）；feed-scroll-card-floor 的停留锚点，每次上报刷新。 */
  private feedCardsArrivedAt: number | null = null;
  /**
   * 最小间隔单锚点 = 上次操作完成时刻（monoNow 单调值）；null=首操作/重连后，跳过间隔。
   * 会话内内存、单进程；重启/重连即 null。绝不持久化、绝不与墙钟作差。（设计 §3.2）
   */
  private lastActionEndAt: number | null = null;
  /** welcome pacing 快照的每类操作 floor 区间（构造/重连注入；缺 op 回落 BUILTIN_FLOOR）。 */
  private opFloorCfg: Partial<Record<PacingOp, PacingFloorPayload>> = {};
  /** welcome pacing 快照的风控档标量（边缘乘算；1.0≡无 tempo）。 */
  private tempo = 1.0;
  /** 可打断 sleep 的唤醒句柄集合（stopRequested / 终止命令到达时全部提前 resolve）。 */
  private readonly sleepWakers = new Set<() => void>();
  private wakeAfterStop = false;
  private processed = 0;

  /** 命令队列：外部通过 onCloudCommand() 推入，loop() 消费 */
  private commandQueue: Envelope[] = [];
  private commandResolver: ((env: Envelope) => void) | null = null;
  /** 任务租约冻结普通浏览命令；带当前 taskId 的评论/维护命令仍由同一 loop 执行。 */
  private taskBlocked = false;
  private taskBlockEpoch = 0;
  /**
   * 当前正在执行的命令在入口拍下的接管世代号；null = 不在命令执行中（冷启动 / 恢复路径的等待不认接管打断）。
   *
   * **判据必须是世代号，不能是 `taskBlocked` 标志**（change lease-strict-preemption）：交接一开始就置
   * `taskBlocked=true`、只在恢复时才清，于是**独占任务自己的命令就跑在冻结期内**。若用标志作取消令牌，
   * 评论 / 巡视的每条命令要么在自己的等待里当场自尽，要么直接跳过浮层闸对着验证码墙点击。
   * 世代号在一个租约期内恒定（授予期间不会再触发交接），是唯一正确的取消令牌。
   */
  private activeCommandEpoch: number | null = null;
  /** 当前正在执行的启动/命令原子区；quiesce 只等到该边界，不排空旧命令。 */
  private activeOperationCount = 0;
  private readonly operationIdleWaiters = new Set<() => void>();
  /** 收到 session.end 时云端给出的自动续场休息时长；等循环真正停稳时展示给桌面壳。 */
  private pendingAutoResumeInMs: number | undefined;

  /** CDP 断线重连：等待重连结果的 waiter（reconnected→true / unrecoverable→false） */
  private cdpReconnectWaiters: Array<(ok: boolean) => void> = [];
  /** 慢 CDP 输入触发的软恢复完成后，必须重报一次当前页面，不沿用恢复前的 DOM/坐标快照。 */
  private cdpControlRecoveryRefreshPending = false;
  /** 同一轮 CDP 恢复只允许一个续跑/重报，命令异常恢复与生命周期回调会在此汇合。 */
  private cdpResumePromise: Promise<void> | null = null;
  /** CDP 生命周期事件订阅的退订句柄（start 订阅，结束时退订） */
  private cdpUnsub: Array<() => void> = [];

  constructor(
    private readonly deps: BrowseSessionDeps,
    options: BrowseSessionOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.cardGapTiming = options.cardGapTiming ?? floorRangeToTiming(options.opFloorsMs?.card_gap, TIMING_PRESETS.cardGap);
    this.actionTiming = options.actionTiming ?? TIMING_PRESETS.action;
    this.scrollTiming = floorRangeToTiming(options.opFloorsMs?.scroll, TIMING_PRESETS.scroll);
    this.modalTimeoutMs = options.modalTimeoutMs ?? 5000;
    this.noteOpenTimeoutMs = Math.max(1, options.noteOpenTimeoutMs ?? DEFAULT_NOTE_OPEN_TIMEOUT_MS);
    this.initialScanTimeoutMs = options.initialScanTimeoutMs ?? 12000;
    this.loginGatePollMs = options.loginGatePollMs ?? 2000;
    this.exploreUrl = options.exploreUrl ?? DEFAULT_EXPLORE_URL;
    this.startupId = options.startupId;
    this.rhythm = options.rhythm ?? createDefaultRhythm();
    this.rhythmTotal = options.rhythmTotal ?? DEFAULT_RHYTHM_TOTAL;
    this.logger = options.logger ?? ((m) => console.log(m));
    this.now = options.now ?? Date.now;
    this.monoNow = options.monoNow ?? defaultMonoNow;
    // 详情页停留下限：优先显式 dwellFloorMs（main.ts 由 welcome detail_dwell 区间塞入），
    // 否则回落 opFloorsMs.detail_dwell，再否则内置默认。
    const detailDwell = options.dwellFloorMs
      ?? floorRangeToMinMax(options.opFloorsMs?.detail_dwell)
      ?? DEFAULT_DWELL_FLOOR_MS;
    this.dwellFloorTiming = makeDwellFloorTiming(detailDwell);
    this.opFloorCfg = { ...(options.opFloorsMs ?? {}) };
    if (validPositiveMs(options.tempo)) this.tempo = options.tempo!;
  }

  /**
   * 重连后重注入 welcome pacing 快照（设计 §4.3 最严重缺口修复）：BrowseSession 只构造一次，
   * identity 翻转重连复用同一对象，若不重注入则连接级快照退化成进程级、风控升级到不了边缘节奏层。
   * `reestablishIdentity` 在 connect() 之后、start() 之前调用本方法。逐字段回落，缺省不改现值。
   * 同时重置最小间隔锚点（重连后页面已变、首操作跳过间隔——对齐 §3.2 不变量2「重连丢弃重置」，
   * 与 onCdpReconnected 的 CDP-重连清锚点两路一致；否则身份翻转重连极快时首操作会补一次残余间隔）。
   */
  applyPacingSnapshot(opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>, tempo?: number): void {
    if (opFloorsMs) this.opFloorCfg = { ...opFloorsMs };
    if (validPositiveMs(tempo)) this.tempo = tempo!;
    const dd = floorRangeToMinMax(opFloorsMs?.detail_dwell);
    if (dd) this.dwellFloorTiming = makeDwellFloorTiming(dd);
    const cg = floorRangeToMinMax(opFloorsMs?.card_gap);
    if (cg) this.cardGapTiming = makeDwellFloorTiming(cg);
    const sc = floorRangeToMinMax(opFloorsMs?.scroll);
    if (sc) this.scrollTiming = makeDwellFloorTiming(sc);
    this.lastActionEndAt = null;
    this.logger(
      `[browse] 应用 pacing 快照：tempo=${this.tempo} ops=${Object.keys(this.opFloorCfg).join(',') || '(空,用内置)'}`,
    );
  }

  /**
   * 中途风控档位刷新（change pacing-fallback-hardening）：会话稳定连接期间收到 cloud 的 `pacing.update`，
   * 只更新兜底节奏所用 tempo（校验正数、否则忽略）。**不动 `lastActionEndAt`**——中途刷新 ≠ 重连，
   * 不得借此跳过一次最小间隔（区别于 `applyPacingSnapshot` 的重连语义会清锚点）。
   */
  applyTempoUpdate(tempo?: number): void {
    // 校验正数且不超上限（防 malformed / 未来云端下发过大 tempo 使兜底停留失控逼近 idle 看门狗）；越界忽略、保留现值。
    if (!validPositiveMs(tempo) || tempo! > MAX_TEMPO) return;
    this.tempo = tempo!;
    this.logger(`[browse] 应用中途档位刷新：tempo=${this.tempo}`);
  }

  /**
   * 动作前犹豫 / 感知（time directive `thinkMs`）：围绕云端中心值叠抖动后等待。
   * 缺 `thinkMs`（旧云端 / 自主动作）→ 不额外等待，由各动作自身的 humanPause 兜底。
   */
  private async thinkBefore(thinkMs?: number): Promise<void> {
    if (!thinkMs || thinkMs <= 0) return;
    const ms = jitterAround(thinkMs, 0.25, this.random);
    if (ms > 0) await this.sleep(ms);
  }

  /**
   * 返回 / 关闭详情页前确保**实际停留**达标（time directive `dwellMs`），治「无价值秒退」。
   * - 仅当确有打开的详情页（noteOpenedAt 非空）时生效；
   * - 中心值 = `dwellMs`（云端按内容算，已烘入 tempo）或缺失时从内置下限采样、**叠当前 tempo 档位**，再叠抖动；
   * - 已停留时长（含真实阅读）已达标则不叠加等待（无双重延迟）。
   * 注（change pacing-fallback-hardening）：tempo 只叠在**边缘采样兜底**上，云端已下发的 `dwellMs` 不再叠（防 double-count）。
   */
  private async ensureDetailDwell(dwellMs?: number): Promise<void> {
    if (this.noteOpenedAt == null) return;
    const center = dwellMs && dwellMs > 0 ? dwellMs : sampleDelay(this.dwellFloorTiming, this.random) * this.tempo;
    const target = jitterAround(center, 0.2, this.random);
    const elapsed = this.now() - this.noteOpenedAt;
    const remain = target - elapsed;
    if (remain > 0) {
      this.logger(`[browse] 返回前兜底停留 +${Math.round(remain)}ms（目标≈${Math.round(target)}ms，已停${Math.round(elapsed)}ms）`);
      // 安全取消点：停留只消耗时间、不碰页面。被接管即当场让路，绝不让一个 90s 的停留预算
      // 把系统恢复任务的受理预算撑爆（change lease-strict-preemption）。
      await this.sleepInterruptible(remain);
      this.throwIfTakeover();
    }
    this.noteOpenedAt = null;
  }

  /**
   * feed 翻页前确保"看完本批新卡"的停留达标（time directive `dwellMs`，feed-scroll-card-floor）。
   * - 缺 `dwellMs` / ≤0（返回未刷新 / 旧云端 / 断连）→ 立即翻页、不额外等待；
   * - 中心值 = 云端按新卡数算的 `dwellMs`，叠抖动为目标；
   * - 从"本批卡到达时刻"起算已停留，已达标则不叠加（评估耗时被吸收，无双重延迟）；
   * - 与详情页停留互不干扰（锚点 feedCardsArrivedAt vs noteOpenedAt，触发命令不同）。
   */
  private async ensureFeedDwell(dwellMs?: number): Promise<void> {
    if (!dwellMs || dwellMs <= 0) return;
    const target = jitterAround(dwellMs, 0.2, this.random);
    const anchor = this.feedCardsArrivedAt ?? this.now();
    const elapsed = this.now() - anchor;
    const remain = target - elapsed;
    if (remain > 0) {
      this.logger(`[browse] 翻页前看新卡停留 +${Math.round(remain)}ms（目标≈${Math.round(target)}ms，已停${Math.round(elapsed)}ms）`);
      // 安全取消点：同 ensureDetailDwell（change lease-strict-preemption）。
      await this.sleepInterruptible(remain);
      this.throwIfTakeover();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 当前会话进度(0..1)：已处理卡片 / 估算总数 */
  private progress(): number {
    if (this.rhythmTotal <= 0) return 0;
    return Math.min(1, this.processed / this.rhythmTotal);
  }

  /**
   * 某类操作的**有效 floor**（毫秒，恒 > 0）：配置区间**反射采样** × tempo ÷ fatigue，夹进
   * [OP_MIN_FLOOR[op], 类别上限]（边缘二次夹=第三道）。每次现采样一次（勿在循环里重采）。
   * - 逐字段回落：cfg 缺 / 非正 → BUILTIN_FLOOR[op]；
   * - tempo 乘算（风控档，≥1 放大延迟）、fatigue 用 applySpeedFactor 除算（与 humanPause 同向：系数>1=更快）；
   * - clamp 下界 OP_MIN_FLOOR[op] > 0 → **配置只能抬高延迟、抬不穿非零下限**（绝不零延迟红线）。
   */
  private effectiveFloor(op: PacingOp): number {
    const cfg = this.opFloorCfg[op];
    const minMs = validPositiveMs(cfg?.minMs) ?? BUILTIN_FLOOR[op].minMs;
    const maxMs = validPositiveMs(cfg?.maxMs) ?? BUILTIN_FLOOR[op].maxMs;
    const raw = sampleReflect(minMs, maxMs, BUILTIN_SIGMA[op], this.random);
    const withTempo = raw * this.tempo;
    const withFatigue = applySpeedFactor(withTempo, this.rhythm.getSpeedFactor(this.progress()));
    const clamped = Math.min(OP_MAX_FLOOR[op], Math.max(OP_MIN_FLOOR[op], withFatigue));
    return Math.round(clamped);
  }

  /**
   * 最小间隔待补差额（毫秒）：设计 ensureMinInterval 抽象的通用式（锚 lastActionEndAt → elapsed → 只补差额）。
   * **只计算、不自 sleep**——sleep 由 gateBeforeAction 与 think 取 `max` 后单次执行，杜绝叠加（设计 §3.2 不变量 6）。
   * - 无锚点（首操作 / 重连后）→ 0（首操作由会话起点初始扫描延迟兜住）；
   * - elapsed 含云端 RTT / 决策 / LLM 时间 → 天然被吸收，云端慢回（elapsed≥floor）返 0、不额外等、不塌零。
   */
  private ensureMinInterval(op: PacingOp): number {
    if (this.lastActionEndAt == null) return 0;
    const floor = this.effectiveFloor(op);
    const elapsed = this.monoNow() - this.lastActionEndAt;
    return Math.max(0, floor - elapsed);
  }

  /**
   * 动作前统一闸（替代散落的 thinkBefore + 引导性 humanPause）：折 think（云端犹豫）与最小间隔，
   * 同一「now→执行本动作」跨度**只比一次、用 `max` 不用 `+`**（设计 §3.1）。
   * @returns 是否应继续执行本动作：等待期间被 stop / 终止命令唤醒则返回 false（醒后立即检查、令调用方中止）。
   */
  private async gateBeforeAction(op: PacingOp, thinkMs?: number): Promise<boolean> {
    const think = thinkMs && thinkMs > 0 ? jitterAround(thinkMs, 0.25, this.random) : 0;
    const remaining = this.ensureMinInterval(op);
    const wait = Math.max(remaining, think); // ← max，绝不相加
    if (wait > 0) await this.sleepInterruptible(wait);
    // 安全取消点：最小间隔 + 动作前犹豫都只消耗时间、不碰页面。被接管即抛出让路
    // （change lease-strict-preemption）。抛出而非返回 false，是为了让主循环发出诚实回执——
    // 返回 false 是既有的「停机/终止」静默中止路径，与「被接管」语义不同。
    this.throwIfTakeover();
    return !this.stopRequested && !this.closing && !this.terminatePending();
  }

  /** 记账：把上次操作完成时刻推进到当前单调时刻。放在命令原子动作 + 功能性 settle + uplink 之后（设计 §4.3）。 */
  private markActionEnd(): void {
    this.lastActionEndAt = this.monoNow();
  }

  /**
   * 可打断 sleep（替代裸 setTimeout）：正常到时或被 wakeInterruptibleSleeps() 提前唤醒（stopRequested /
   * 终止命令到达）即 resolve。用注入的 this.sleep 计时（测试可控），故 gate 等待时长仍被 sleep 桩捕获。
   * 不复活 closing 终态（唤醒只 resolve 本 sleep，重启由 onCloudCommand 的 !closing 闸把关）。
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
      void this.sleep(ms).then(finish); // 到时自然 resolve；唤醒时 finish 已幂等，多余定时器无害空转
    });
  }

  /**
   * 当前命令是否已被更高优先级的独占任务接管（change lease-strict-preemption）。
   * 仅在命令执行中（activeCommandEpoch 非 null）且交接已推进世代号时为真。
   */
  private takeoverRequested(): boolean {
    return this.activeCommandEpoch !== null && this.taskBlockEpoch !== this.activeCommandEpoch;
  }

  /** 在安全取消点检查接管：已被接管即抛出，令本命令零页面副作用地作废。 */
  private throwIfTakeover(): void {
    if (this.takeoverRequested()) throw new TaskTakeoverError();
  }

  /** 唤醒所有正在等待的可打断 sleep（stopForReason / 终止命令入队 / 任务接管时调用）。 */
  private wakeInterruptibleSleeps(): void {
    if (this.sleepWakers.size === 0) return;
    const wakers = [...this.sleepWakers];
    this.sleepWakers.clear();
    for (const w of wakers) w();
  }

  /**
   * 拟人化停顿：按预设分布采样，再按会话进度的疲劳曲线缩放，最后 sleep。
   */
  private async humanPause(timing: TimingConfig): Promise<void> {
    const base = sampleDelay(timing, this.random);
    const factor = this.rhythm.getSpeedFactor(this.progress());
    const ms = applySpeedFactor(base, factor);
    if (ms > 0) await this.sleep(ms);
  }

  private variedScrollDistance(min = COMMENT_SCROLL_MIN_PX, max = COMMENT_SCROLL_MAX_PX): number {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.round(lo + this.random() * (hi - lo));
  }

  private parseScrollProbe(raw: unknown): ScrollProbeSnapshot {
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as ScrollProbeSnapshot : { found: false };
      } catch {
        return { found: false };
      }
    }
    return raw && typeof raw === 'object' ? raw as ScrollProbeSnapshot : { found: false };
  }

  private probeScrollTop(p: ScrollProbeSnapshot): number | undefined {
    for (const v of [p.scrollTop, p.before, p.after]) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  }

  private async dispatchInertialWheel(x: number, y: number, distance: number, deadlineAt?: number): Promise<void> {
    const total = Math.round(distance);
    const seq = generateScrollSequence(total, { random: this.random });
    if (seq.length === 0) return;
    const px = Math.round(x);
    const py = Math.round(y);
    this.assertNoteOpenDeadline(deadlineAt, 'body_scroll_move');
    await this.deps.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    for (const frame of seq) {
      this.assertNoteOpenDeadline(deadlineAt, 'body_scroll_wheel');
      await this.deps.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: px,
        y: py,
        deltaX: 0,
        deltaY: frame.deltaY,
      });
      if (frame.delay > 0) await this.sleep(frame.delay);
    }
  }

  private async inertialScrollByProbe(
    evalRawFn: (cdp: BrowseCdp, expression: string) => Promise<string>,
    probeExpr: string,
    distance: number,
    deadlineAt?: number,
  ): Promise<ScrollProbeSnapshot> {
    this.assertNoteOpenDeadline(deadlineAt, 'body_scroll_probe_before');
    const beforeProbe = this.parseScrollProbe(await evalRawFn(this.deps.cdp, probeExpr));
    const before = this.probeScrollTop(beforeProbe);
    const hasPoint = typeof beforeProbe.x === 'number' && typeof beforeProbe.y === 'number';

    if (hasPoint) {
      await this.dispatchInertialWheel(beforeProbe.x!, beforeProbe.y!, distance, deadlineAt);
      this.assertNoteOpenDeadline(deadlineAt, 'body_scroll_probe_after');
      const afterProbe = this.parseScrollProbe(await evalRawFn(this.deps.cdp, probeExpr));
      const after = this.probeScrollTop(afterProbe) ?? before;
      const moved = typeof before === 'number' && typeof after === 'number' && after > before;
      const atBottom = afterProbe.atBottom ?? (
        typeof after === 'number' &&
        typeof afterProbe.clientHeight === 'number' &&
        typeof afterProbe.scrollHeight === 'number'
          ? after + afterProbe.clientHeight >= afterProbe.scrollHeight - 24
          : undefined
      );
      return {
        ...afterProbe,
        before,
        after,
        moved,
        atBottom,
        found: afterProbe.found ?? beforeProbe.found,
        visible: afterProbe.visible ?? beforeProbe.visible,
      };
    }

    // Compatibility for unit-test probes that return a precomputed before/after pair.
    const after = beforeProbe.after ?? before;
    const moved = typeof before === 'number' && typeof after === 'number' && after > before;
    return { ...beforeProbe, before, after, moved };
  }

  /** 启动浏览循环（命令驱动：上报卡片 → 等待指令 → 执行 → 循环） */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.stopInProgress = false;
    this.wakeAfterStop = false;
    this.processed = 0;
    this.commandQueue = [];
    this.commandResolver = null;
    this.logger('[browse] 启动命令驱动浏览循环');
    this.subscribeCdpLifecycle();
    try {
      if (!this.taskBlocked) {
        await this.trackOperation(async () => {
          await this.ensureExplore();
          if (this.stopRequested || this.closing) return;
          // 初始扫描延迟：真人打开页面后会先扫一眼 feed 再点击（3-6s）
          const scanDelay = sampleDelay(
            { mu: Math.log(4500), sigma: 0.3, min: 3000, max: 7000 },
            this.random,
          );
          this.logger(`[browse] 扫描 feed（${Math.round(scanDelay / 1000)}s）...`);
          // 可打断：停止请求（冷待机 / 退出）必须能立刻叫醒它，否则醒来时浏览器已被关掉。
          await this.sleepInterruptible(scanDelay);
        });
      }
      // 启动段的每个 await 之后都要复核停止请求：close() 只置标志，不会把我们从 await 里拽出来。
      if (this.stopRequested || this.closing) return;

      await this.loop();
    } finally {
      const shouldWake = this.wakeAfterStop && !this.closing;
      this.wakeAfterStop = false;
      this.stopInProgress = false;
      this.running = false;
      for (const u of this.cdpUnsub) u();
      this.cdpUnsub = [];
      const resumeSuffix = this.pendingAutoResumeInMs === undefined
        ? ''
        : `，预计休息约 ${this.formatAutoResumeMinutes(this.pendingAutoResumeInMs)} 分钟后继续`;
      this.pendingAutoResumeInMs = undefined;
      this.logger(`[browse] 浏览循环结束${resumeSuffix}`);
      if (shouldWake) {
        this.logger('[browse] 停止期间收到续场命令 → 停稳后唤醒重启浏览循环');
        void this.start().catch((err) => this.logger(`[browse] 唤醒重启失败：${(err as Error).message}`));
      }
    }
  }

  /** 请求停止（下个安全点退出循环）。非终态：identity 重连等 stop-then-restart 走此（仍可被后续命令唤醒）。 */
  stop(): void {
    this.stopForReason('local_stop');
  }

  /**
   * 终态关闭（change restore-auto-resume A②）：进程主动关闭/下线时调用——置 closing 永久阻止后续云端
   * 命令唤醒重启循环，再 stop()。供 main.ts 关机路径用，与 identity 重连的 stop()（非终态）区分。
   */
  close(): void {
    this.closing = true;
    this.stop();
  }

  /**
   * 终态关闭 + 等待在途原子操作排空。**关浏览器之前必须走这条**（冷待机 / 退出 / 回收）。
   *
   * close() 只是「请求」停止：循环可能正卡在某个 await 里，醒来后还会继续摸页面。若此时浏览器已被关掉，
   * 那些调用就会打在死 CDP 上（冷待机实测：循环停在首屏扫描里，对着已关闭的浏览器空转 12s 后抛
   * CdpDisconnectedError）。故关浏览器前必须等循环真正退出原子区。
   *
   * 有界：CDP 已死时页面调用会立刻 reject，但停留 / 轮询类等待未必；无界等待会把冷待机本身卡死
   * （浏览器关不掉 = 待机失效），比原 bug 更糟。超时返回 false，由调用方诚实告知并照常关浏览器。
   */
  async closeAndWait(timeoutMs = 5000): Promise<boolean> {
    this.close();
    return this.waitDrained(timeoutMs);
  }

  /**
   * 冷待机排空（change browser-slot-scheduling）：与 closeAndWait 一样等在途原子操作真正退出原子区
   * （关浏览器前的硬要求），但**非终态**——不置 closing，唤醒后可再 start() 重新开跑。
   *
   * 终态关闭（进程退出 / 回收）仍走 closeAndWait()；两者的差别只在「还回不回得来」。
   */
  async stopAndWait(timeoutMs = 5000): Promise<boolean> {
    this.stop();
    return this.waitDrained(timeoutMs);
  }

  /** 有界等待在途原子操作排空。超时返回 false，由调用方诚实告知并照常关浏览器（无界等待会把待机本身卡死）。 */
  private async waitDrained(timeoutMs: number): Promise<boolean> {
    if (!this.running && this.activeOperationCount === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      new Promise<boolean>((resolve) => {
        if (this.activeOperationCount === 0) resolve(true);
        else this.operationIdleWaiters.add(() => resolve(true));
      }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return drained;
  }

  /** 请求停止并附带理由（local_stop / cdp_unrecoverable）。唤醒可能正在等待命令的 loop。 */
  private stopForReason(reason: string): void {
    this.stopInProgress = true;
    this.stopRequested = true;
    this.wakeInterruptibleSleeps(); // 打断可能正卡在 gate 最小间隔等待里的循环，让其立即中止本动作、退出
    if (this.commandResolver) {
      const resolve = this.commandResolver;
      this.commandResolver = null;
      resolve({ v: 2, type: 'session.end', id: 'stop', ts: Date.now(), payload: { reason } });
    }
  }

  /** 订阅 CDP 断线重连生命周期事件（仅当底层 cdp 暴露 on()；真实 CdpClient 有，测试桩可无）。 */
  private subscribeCdpLifecycle(): void {
    const on = this.deps.cdp.on?.bind(this.deps.cdp);
    if (!on) return;
    this.cdpUnsub.push(
      on('cdp.control_recovering', () => this.onCdpControlRecovering()),
      on('cdp.reconnected', () => this.onCdpReconnected()),
      on('cdp.unrecoverable', () => this.onCdpUnrecoverable()),
      on('cdp.control_unavailable', () => this.onCdpControlUnavailable()),
    );
  }

  private onCdpReconnected(): void {
    // 重连后页面可能已变（回 feed / 重载）：清详情页 dwell 计时，避免下次返回误判已达标。
    this.noteOpenedAt = null;
    // 同处清最小间隔锚点：重连页面已变、间隔重置，首操作跳过间隔（设计 §4.3）。
    this.lastActionEndAt = null;
    this.logger('[browse] CDP 已重连，准备续跑');
    // 慢输入的软恢复可能发生在一条命令的最后一个 CDP 调用之后；这时没有
    // CdpDisconnectedError 可驱动 loop 续跑。仍要主动按新连接上的真实页面重报，
    // 让云端重新决定下一步，而不是继续使用恢复前的页面判断。
    if (this.cdpControlRecoveryRefreshPending && this.running && !this.stopRequested && !this.closing) {
      this.cdpControlRecoveryRefreshPending = false;
      void this.resumeAfterReconnect();
    }
    const waiters = this.cdpReconnectWaiters;
    this.cdpReconnectWaiters = [];
    for (const w of waiters) w(true);
  }

  private onCdpControlRecovering(): void {
    // 软恢复前已有的坐标/DOM 快照不可跨新 CDP 连接使用；普通新命令会由 task coordinator 的
    // control readiness 闸拦住，此处只清理已在本地排队、尚未开始的旧命令。
    const cancelled = this.commandQueue.length;
    this.commandQueue = [];
    this.cdpControlRecoveryRefreshPending = true;
    if (cancelled > 0) this.logger(`[browse] CDP 控制恢复中，取消 ${cancelled} 条未开始浏览命令`);
  }

  private onCdpUnrecoverable(): void {
    // 重连耗尽：停止上报、退出循环（诚实失败），交云端 idle 看门狗兜底结束会话；绝不假装在跑。
    // CDP 死局是终态：置 closing，绝不让云端迟到命令（如看门狗 nudge）唤醒重启到一个已死的 CDP 上。
    this.closing = true;
    this.cdpControlRecoveryRefreshPending = false;
    this.logger('[browse] CDP 重连不可恢复，停止浏览循环（交云端看门狗兜底）');
    const waiters = this.cdpReconnectWaiters;
    this.cdpReconnectWaiters = [];
    for (const w of waiters) w(false);
    this.stopForReason('cdp_unrecoverable');
  }

  private onCdpControlUnavailable(): void {
    // 输入超时的真实结果不确定：不能继续执行队列里的页面写操作，也不能在同一进程内自动重放。
    const cancelled = this.commandQueue.length;
    this.commandQueue = [];
    this.taskBlocked = true;
    this.taskBlockEpoch++;
    this.closing = true;
    this.cdpControlRecoveryRefreshPending = false;
    this.logger(`[browse] CDP 输入控制不可用，停止浏览并取消 ${cancelled} 条未开始命令；请重启浏览器客户端后恢复`);
    this.stopForReason('cdp_control_unavailable');
  }

  /** 云端 WS 断开时丢弃旧连接上已经排队、尚未执行的云端命令，避免重连后盲目重放。 */
  discardQueuedCloudCommands(reason = 'cloud_ws_disconnected'): void {
    const count = this.commandQueue.length;
    this.commandQueue = [];
    if (count > 0) this.logger(`[browse] 云端连接断开，已丢弃 ${count} 条旧命令（reason=${reason}）`);
  }

  /**
   * 独占任务接管：先封住普通浏览准入、丢弃尚未开始的旧命令，唤醒所有安全取消点上的纯等待，
   * 再**有界**等待真正在改写页面的动作收敛。
   * 返回被取消的旧命令数，供 edge.task.acquired 可观测上报。
   *
   * change lease-strict-preemption —— 这里过去是硬死锁的锁体，两处错：
   * ① 无界等待「命令处理函数还没返回」，而不是「页面正在被改写」：一条停在验证码浮层闸里的命令
   *    （一个字节都没写过页面）会让本函数永远不返回，而那个验证码只有这次要授予的协助任务才能点掉。
   * ② 协调器的「正在让位」标志只在本函数返回后才复位 ⇒ 本函数永不返回 ⇒ 标志永为真 ⇒ 此后拒绝授予
   *    任何租约、拒绝进入冷待机，整台机器停摆，只有云端断连能解。
   * 现在：推进世代号 → 唤醒全部可打断等待（安全取消点当场让路）→ 有界排空真写段；未收敛即抛出，
   * 由协调器诚实地不授权（MUST NOT 在一个可能仍在写页面的动作头上再放一个人进来）。
   */
  async quiesceForTask(timeoutMs = DEFAULT_TASK_QUIESCE_MS): Promise<number> {
    this.taskBlocked = true;
    const epoch = ++this.taskBlockEpoch;
    this.wakeAfterStop = false;
    const cancelled = this.commandQueue.length;
    this.commandQueue = [];
    if (cancelled > 0) this.logger(`[browse] 任务接管取消 ${cancelled} 条未开始的旧浏览命令`);
    // 让路：唤醒停在安全取消点（浮层闸 / 停留 / 动作前闸）上的纯等待，它们醒来即抛 TaskTakeoverError。
    this.wakeInterruptibleSleeps();
    if (this.activeOperationCount === 0) return cancelled;
    const drained = await this.waitDrained(timeoutMs);
    if (!drained) {
      // 未收敛：真写段里有一个超出预算的动作。回滚自己置的冻结标志——不回滚就是把停摆从「让位态」
      // 搬到「浏览冻结态」：协调器看着完全健康，而云端浏览命令逐条被静默丢弃，且没有任何事件会再来清它。
      // 按世代号守卫：期间若来了新 acquire，世代号已推进，绝不能误清新任务的冻结。
      if (this.taskBlockEpoch === epoch) this.taskBlocked = false;
      throw new BrowseQuiesceTimeoutError(timeoutMs);
    }
    return cancelled;
  }

  /** 最后一个独占任务释放：回真实 feed/search，再解除冻结并重报快照。 */
  async resumeAfterTask(): Promise<void> {
    if (this.closing) return;
    if (!this.taskBlocked) return;
    const resumeEpoch = this.taskBlockEpoch;
    if (!this.running) {
      if (this.taskBlockEpoch === resumeEpoch) this.taskBlocked = false;
      if (!this.closing && !this.stopRequested) void this.start().catch((err) => this.logger(`[browse] 任务后重启失败：${(err as Error).message}`));
      return;
    }
    const overlayStillBlocked = this.deps.overlayMonitor && isBlockingKind(this.deps.overlayMonitor.state);
    if (overlayStillBlocked) {
      // 验证码仍在时不等待恢复（否则下一次 system_recovery acquire 会与此等待互锁）。传输层硬暂停
      // 已阻止普通命令；浏览 loop 自己继续等浮层清除，下一次人工点击仍可立即取得系统租约。
      if (this.taskBlockEpoch === resumeEpoch) this.taskBlocked = false;
      this.logger('[browse] 系统恢复任务已释放但阻断仍在，保持本地闸门等待下一次恢复动作');
      return;
    }
    try {
      await this.waitWhileBlocked();
      if (this.taskBlockEpoch !== resumeEpoch) return;
      await this.trackOperation(async () => {
        await this.ensureExplore();
        await this.waitForVisibleCards(this.initialScanTimeoutMs);
        await this.reportVisibleCards();
      });
    } finally {
      // 若恢复期间来了新 acquire，epoch 已推进，绝不能误清新任务的冻结。
      if (this.taskBlockEpoch === resumeEpoch) this.taskBlocked = false;
    }
    this.logger('[browse] 独占任务队列已清空，按当前页面恢复浏览');
  }

  private async trackOperation<T>(work: () => Promise<T>): Promise<T> {
    this.activeOperationCount++;
    try {
      return await work();
    } finally {
      this.activeOperationCount--;
      if (this.activeOperationCount === 0) {
        const waiters = [...this.operationIdleWaiters];
        this.operationIdleWaiters.clear();
        for (const resolve of waiters) resolve();
      }
    }
  }

  /** 等待 CDP 重连结果：reconnected→true / unrecoverable→false。无 on() 能力（测试桩）即视为失败。 */
  private waitForReconnect(): Promise<boolean> {
    if (!this.deps.cdp.on) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.cdpReconnectWaiters.push(resolve);
    });
  }

  /**
   * 重连成功后的续跑点：先过浮层闸门（重连可能落在登录/验证码页，连上≠可用），
   * 再按当前页确保回 feed 并重报快照让云端重判。不重放断连前的 in-flight 命令（坐标可能已失效）。
   */
  private async resumeAfterReconnect(): Promise<void> {
    if (this.cdpResumePromise) return this.cdpResumePromise;
    const work = this.resumeAfterReconnectOnce();
    this.cdpResumePromise = work;
    try {
      return await work;
    } finally {
      if (this.cdpResumePromise === work) this.cdpResumePromise = null;
    }
  }

  private async resumeAfterReconnectOnce(): Promise<void> {
    try {
      await this.waitWhileBlocked();
      if (this.stopRequested) return;
      await this.ensureExplore();
      await this.waitForVisibleCards(this.initialScanTimeoutMs);
      await this.reportVisibleCards();
    } catch (err) {
      this.logger(`[browse] 重连后续跑重报失败：${(err as Error).message}`);
    }
  }

  /**
   * 云端 WS 重连后的恢复点：不重放旧连接命令，按当前真实页面重报快照让云端重新决策。
   * 与 CDP 重连共用恢复语义，但这里不触碰 CDP 连接本身。
   */
  async recoverAfterCloudReconnect(): Promise<void> {
    this.discardQueuedCloudCommands('cloud_ws_reconnected');
    this.lastActionEndAt = null;
    this.logger('[browse] 云端已重连，清理旧命令状态并重报当前页面');
    if (!this.running) {
      if (this.closing || this.stopRequested) return;
      await this.start();
      return;
    }
    await this.resumeAfterReconnect();
  }

  /**
   * 云端命令入口。
   * 外部（WebSocket 接收层）调用此方法将云端命令送入队列，loop() 消费执行。
   */
  async onCloudCommand(env: Envelope): Promise<void> {
    // 中途风控档位刷新（change pacing-fallback-hardening）：轻量标量更新，MUST 早于 wake / 独占任务 / 停机判定，
    // 直接应用并返回——绝不入队、绝不唤醒或复活已停会话。否则会被当作唤醒命令 start() 复活云端意在停住的会话（自残），
    // 或在停机 / 独占任务窗口被静默丢弃使边缘永停在旧档（云端乐观推送、不重发同值）。停机时应用亦无害：只更
    // this.tempo 供下次运行取用（不触碰 lastActionEndAt、不做原子动作）。
    if (env.type === 'pacing.update') {
      this.applyTempoUpdate((env.payload as PacingUpdatePayload).tempo);
      return;
    }
    const taskId = (env.payload as { taskId?: unknown } | undefined)?.taskId;
    if (this.taskBlocked && typeof taskId !== 'string') {
      this.logger(`[browse] 独占任务期间丢弃普通命令 ${env.type}`);
      return;
    }
    // 循环已停（如云端 session.end 后）：浏览类命令唤醒重启循环，让自动续场 / idle 看门狗 nudge 能复活闭环
    // （change restore-auto-resume A②）。否则命令会被静默堆进无人消费的队列（loop 已退出、无人 shift）。
    // 终态关闭（closing：进程下线 / CDP 死局）一律不复活；session.end 本身不唤醒（它就是来停的）。
    // 注意 start() 会清空 commandQueue（见 :280），故此处不 push 触发命令——靠循环重启后重报 page.cards
    // 重新驱动云端决策环，而非依赖这条命令存活。
    if (!this.running) {
      if (!this.closing && this.isWakeCommand(env.type)) {
        this.logger(`[browse] 循环已停，收到 ${env.type} → 唤醒重启浏览循环（续场/恢复）`);
        void this.start().catch((err) => this.logger(`[browse] 唤醒重启失败：${(err as Error).message}`));
      }
      return; // 不入队：无消费者，避免静默堆积
    }
    if (!this.closing && this.isWakeCommand(env.type) && (this.stopRequested || this.stopInProgress)) {
      // A publish/comment takeover can send session.end and then a resume scroll very close together.
      // If the scroll lands while the old loop is still unwinding, queueing it would lose the wake.
      this.wakeAfterStop = true;
      this.logger(`[browse] 循环正在停止，收到 ${env.type} → 记录为停稳后续场唤醒`);
      return;
    }
    if (env.type === 'session.end') this.stopInProgress = true;
    if (this.commandResolver) {
      const resolve = this.commandResolver;
      this.commandResolver = null;
      resolve(env);
    } else {
      this.commandQueue.push(env);
      // 循环正卡在某命令处理中（含 gate 最小间隔等待）：仅当排入的是**终止命令**才唤醒 gate 提前中止本动作
      // （让 loop 尽快取到 session.end 停下）。普通命令绝不唤醒——否则 gate 会在 floor 未满时提前放行 → 破坏最小间隔。
      if (env.type === 'session.end') this.wakeInterruptibleSleeps();
    }
  }

  /** 浏览循环已停时，哪些云端命令应唤醒重启循环：除终止命令 session.end 外的浏览类推进命令均可。 */
  private isWakeCommand(type: string): boolean {
    // pacing.update 在 onCloudCommand 顶端已被直接应用并返回、永不到此；显式排除作纵深防御——它绝不唤醒/复活循环。
    return type !== 'session.end' && type !== 'pacing.update';
  }

  private validAutoResumeInMs(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  }

  private formatAutoResumeMinutes(ms: number): number {
    return Math.max(1, Math.ceil(ms / 60_000));
  }

  /**
   * 队列里是否已有终止命令（session.end）在等待。
   * 用于登录弹窗闸门：闸门暂停期间 loop 不在 waitForCommand，云端 session.end 只会进队列
   * （commandResolver 为 null），若闸门只看 stopRequested 会永远卡住——故闸门也据此提前退出，
   * 让 loop 取出 session.end 正常处理（治死锁）。
   */
  private terminatePending(): boolean {
    return this.commandQueue.some((e) => e.type === 'session.end');
  }

  /** 等待下一条云端命令（阻塞直到有命令到达或 stop） */
  private waitForCommand(): Promise<Envelope> {
    if (this.commandQueue.length > 0) {
      return Promise.resolve(this.commandQueue.shift()!);
    }
    return new Promise((resolve) => {
      this.commandResolver = resolve;
    });
  }

  /** 确保当前在 explore 页：若不在则导航过去 */
  private async ensureExplore(): Promise<void> {
    let url = '';
    try {
      url = await this.evalUrl();
    } catch {
      url = '';
    }
    // 严格判定：仅 feed 列表(/explore)或搜索结果(/search)算"已在位"；笔记详情页 /explore/<noteId>
    // 不算 feed，必须导航回 feed——否则启动时若 Chrome 停在某详情页会扫不到卡 → 静默死锁。
    const onFeed = EXPLORE_FEED_RE.test(url);
    const onSearch = this.isSearchListUrl(url);
    if (!onFeed && !onSearch) {
      this.logger(`[browse] 不在 explore feed（当前 ${url || '?'}），导航到 ${this.exploreUrl}`);
      await this.deps.cdp.send('Page.navigate', { url: this.exploreUrl });
      // 等待页面加载：轮询 section.note-item 出现（最多 15 秒）
      await this.waitForCards(15000);
    }
  }

  /** 等待 feed 中出现卡片（轮询 DOM） */
  private async waitForCards(timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.stopRequested || this.closing) return; // 已请求停止：不再对页面轮询（浏览器可能正被关闭）
      try {
        const res = await this.deps.cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: 'document.querySelectorAll("section.note-item").length', returnByValue: true },
        );
        const count = (res as any).result?.value ?? 0;
        if (count >= 4) return; // 至少 4 张卡片出现
      } catch (err) {
        // 「浏览器没了」绝不能被读成「卡片还没渲染出来」：断连必须立刻上抛给会有界重连 / 诚实终止的调用方，
        // 否则会对着死 CDP 空转满整个墙钟预算（冷待机实测静默 12s）。其余异常（导航期 context 丢失等）仍宽容。
        if (err instanceof CdpDisconnectedError) throw err;
      }
      await this.sleepInterruptible(1000);
    }
    this.logger('[browse] 页面加载超时，继续尝试');
  }

  /**
   * 轮询直到 scroller 真正检测到可见卡片（与 reportVisibleCards 同口径），超时返回 false。
   * history.back 后 feed 重渲染有延迟，固定 sleep 后瞬时判断会误判为空 → 误报"无可见卡片"。
   */
  private async waitForVisibleCards(
    timeout: number,
    min = 1,
    isReady?: (cards: NoteCard[]) => boolean,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.stopRequested || this.closing) return false; // 已请求停止：不再对页面轮询
      try {
        const cards = await this.deps.scroller.getVisibleCards();
        if (cards.length >= min && (!isReady || isReady(cards))) return true;
      } catch (err) {
        // 同 waitForCards：断连立刻上抛，绝不吞成「还没渲染好」（见该处注释）。
        if (err instanceof CdpDisconnectedError) throw err;
      }
      await this.sleepInterruptible(500);
    }
    return false;
  }

  private async waitForSearchResultNoteIds(timeout = 2500): Promise<void> {
    const ready = await this.waitForVisibleCards(
      timeout,
      1,
      (cards) => Boolean(cards[0]?.noteId),
    );
    if (!ready) {
      this.logger('[browse] 搜索结果 noteId 水合等待超时，按当前卡片快照诚实上报');
    }
  }

  private async evalUrl(): Promise<string> {
    const res = await this.deps.cdp.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
    );
    return typeof res.result?.value === 'string' ? res.result.value : '';
  }

  private isSearchListUrl(url: string): boolean {
    return SEARCH_LIST_RE.test(url);
  }

  private isTargetListUrl(url: string, target: 'feed' | 'search'): boolean {
    return target === 'search' ? this.isSearchListUrl(url) : EXPLORE_FEED_RE.test(url);
  }

  private rememberSourceListUrl(url: string): void {
    if (EXPLORE_FEED_RE.test(url)) {
      this.sourceListPageType = 'feed';
      this.sourceListUrl = this.exploreUrl;
      return;
    }
    if (this.isSearchListUrl(url)) {
      this.sourceListPageType = 'search';
      this.sourceListUrl = url;
    }
  }

  private async rememberCurrentSourceList(): Promise<void> {
    try {
      this.rememberSourceListUrl(await this.evalUrl());
    } catch {
      // 记录来源列表是返回路径优化，失败不应阻断 note.open；后续会走诚实降级。
    }
  }

  private parseNoteIdFromUrl(u?: string): string | undefined {
    const m = (u ?? '').match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
    return m ? m[1] : undefined;
  }

  private async reportCurrentNoteImageSnapshot(noteId: string): Promise<void> {
    let content: NoteContent;
    try {
      content = await this.deps.noteExtractor(this.deps.dom);
    } catch (err) {
      this.logger(`[browse] note.browse_images: 图片快照抽取失败：${(err as Error).message}`);
      return;
    }
    if (content.images.length === 0) return;
    const pageUrl = await this.evalUrl();
    const detailUrl = pageUrl.includes('xsec_token=') ? pageUrl : undefined;
    const realNoteId = noteId || this.parseNoteIdFromUrl(content.noteUrl) || this.parseNoteIdFromUrl(pageUrl);
    if (!realNoteId) return;
    const payload: NoteDetailPayload = {
      noteId: realNoteId,
      title: content.title,
      content: content.body,
      mediaType: 'image_text',
      author: content.author,
      likeCount: content.likes,
      collectCount: content.collects,
      ...(detailUrl ? { url: detailUrl } : {}),
      images: content.images,
      refreshOnly: true,
    };
    this.deps.client.reportNoteDetail?.(payload);
    this.logger(`[browse] note.browse_images: 已刷新参考图快照 noteId=${payload.noteId} images=${content.images.length}`);
  }

  /**
   * 主循环：上报可见卡片 → 等待 Cloud 命令 → 执行 → 上报完成 → 循环。
   * 所有决策由 Cloud 端做出，Edge 只负责执行。
   */
  private async loop(): Promise<void> {
    // 首屏 feed 可能尚未水合完成（页面刚 reload / 网络慢，或本就停在 /explore 而 ensureExplore
    // 跳过了 DOM-ready 轮询）。固定 scanDelay 后瞬时扫描会扫到空 → reportVisibleCards 静默早返回、
    // 不发 page.cards → 云端只被 page.cards.arrived 驱动 → 两端互等死锁。
    // 故先轮询等卡片真正渲染出来再上报；getVisibleCards 一旦有卡即返回，feed 已就绪时几乎零延迟。
    // 弹窗闸门：冷启动若停在登录/验证码浮层（含 launcher 误放行的兜底），先暂停再上报。
    if (!this.taskBlocked) {
      // 阻断等待本身不占页面写原子区：system_recovery 租约必须能穿透验证码等待并执行人工点击。
      await this.waitWhileBlocked();
      if (this.stopRequested || this.closing) return;
      if (!this.taskBlocked && !(await this.runInitialScan())) return;
    }

    while (!this.stopRequested) {
      const cmd = await this.waitForCommand();
      if (this.stopRequested) return;
      // 接管取消令牌：本命令入口拍下当前世代号。交接推进世代号 ⇒ 本命令的所有安全取消点抛出让路。
      // 一个租约期内世代号恒定 ⇒ 持权任务自己的命令不会自尽（change lease-strict-preemption）。
      this.activeCommandEpoch = this.taskBlockEpoch;
      try {
        await this.trackOperation(() => this.executeCommand(cmd));
        // 记账：命令的原子动作 + 功能性 settle + uplink 已完成，把「上次操作完成时刻」推进到现在，
        // 让下一动作的最小间隔从此刻起算、与云端 idle 看门狗量同一段 gap（设计 §4.3）。
        // session.end 非操作、stopRequested 时本命令已被 gate 中止 → 不记账。
        if (!this.stopRequested && cmd.type !== 'session.end') this.markActionEnd();
      } catch (err) {
        // 安全取消点上被独占任务接管：该命令一个字节都没写过页面。回诚实失败回执、不记账、不重放。
        // 红线：MUST NOT 静默丢弃（云端还要据此释放在途互动坑位）。
        // 动作名直接回协议消息名——云端入口有归一函数；边缘侧**绝不新建映射表**（CLAUDE.md §2 第 5 处
        // 漂移点，typecheck 抓不到，回错名的后果是角色永远等不到回执）。
        if (err instanceof TaskTakeoverError) {
          this.logger(`[browse] 命令 ${cmd.type} 在安全取消点被独占任务接管 → 零副作用作废`);
          this.deps.client.reportActionCompleted?.({ action: cmd.type, ok: false, reason: 'preempted_by_task' });
          continue;
        }
        // CDP 断线：不当业务失败，等有界重连；成功→续跑重报，耗尽→已请求停止退出。
        if (err instanceof CdpDisconnectedError) {
          // 断连中止的若是通知巡视命令：重连后必须给云端一个诚实的 ok:false 终止回执，触发 excursion_resumer
          // 关暂停 + 回 feed。否则云端 excursionActive 永真 → 发命令暂停出口扣住 feed 命令 → 看门狗 ~240s 杀整会话，
          // 且 gatekeeper 此后永久忽略新通知。reason 如实 = cdp_reconnect_aborted（非伪造成功）。
          const wasExcursion = typeof cmd?.type === 'string' && cmd.type.startsWith('notification.');
          // 终态关闭（冷待机 / 退出）：浏览器是我们自己关的，等重连毫无意义。但云端连接还活着，
          // 在途巡视必须照样收到诚实的终止回执，否则云端 excursionActive 永真、看门狗随后杀会话。
          if (this.closing) {
            this.logger('[browse] 停止请求期间浏览器已关闭 → 中止在途命令，浏览循环干净退出');
            if (wasExcursion) {
              this.deps.client.reportActionCompleted?.({ action: 'notification_back_home', ok: false, reason: 'browser_closed' });
            }
            return;
          }
          this.logger('[browse] 命令执行中 CDP 断连，等待有界重连…');
          const ok = await this.waitForReconnect();
          if (!ok || this.stopRequested) return;
          if (wasExcursion) {
            this.deps.client.reportActionCompleted?.({ action: 'notification_back_home', ok: false, reason: 'cdp_reconnect_aborted' });
          }
          await this.resumeAfterReconnect();
          continue;
        }
        // 输入超时会先同步宣告 control unavailable 并请求终止；此处不得再把已请求停止的会话翻成未处理异常。
        if (this.stopRequested) return;
        throw err; // 其他业务异常保持现状（冒泡 → 会话结束）
      } finally {
        // 命令已离开执行域：冷启动 / 恢复路径的等待不认接管打断（它们不在 quiesce 等的原子区里）。
        this.activeCommandEpoch = null;
      }
    }
  }

  /**
   * 首屏扫描 + 初始上报。返回 false = 循环应就此终止。
   *
   * 这段过去裸跑在 while 体之外：既不看停止标志、也不在 while 体那套 CdpDisconnectedError 处理域里。
   * 于是「冷待机关浏览器」撞上「循环刚启动」时，它会对着已经死掉的 CDP 发调用，异常一路冒到 main.ts
   * 的裸 catch，打成「浏览会话异常」。现在与命令路径同规矩：停止即退、断连走有界重连、绝不静默。
   */
  private async runInitialScan(): Promise<boolean> {
    try {
      await this.trackOperation(async () => {
        await this.waitForVisibleCards(this.initialScanTimeoutMs);
        if (this.stopRequested || this.closing) return;
        await this.reportVisibleCards(); // 上报初始可见卡片
      });
      return true;
    } catch (err) {
      if (!(err instanceof CdpDisconnectedError)) throw err;
      // 我们自己请求了停止（冷待机 / 退出）：浏览器被有意关掉，断连是预期终局而非故障。
      // 干净退出——不重连、不上报、也不冒成「会话异常」（那是把自伤读成外部故障）。
      if (this.stopRequested || this.closing) {
        this.logger('[browse] 停止请求期间浏览器已关闭 → 首屏扫描中止，浏览循环干净退出');
        return false;
      }
      this.logger('[browse] 首屏扫描中 CDP 断连，等待有界重连…');
      const ok = await this.waitForReconnect();
      if (!ok || this.stopRequested) return false;
      await this.resumeAfterReconnect(); // 重连成功：按当前真实页面重报，再进命令循环
      return true;
    }
  }

  /**
   * 执行单条云端命令。
   * 每条命令执行后，相应的 handler 会上报 action.completed 或新的 page.cards/note.detail。
   */
  private async executeCommand(env: Envelope): Promise<void> {
    // 弹窗闸门：登录/验证码/未知阻断弹窗出现时暂停一切 feed/详情操作，消失后再放行。
    // session.end 是终止命令，必须先于闸门处理，否则弹窗会卡死会话无法停止。
    if (env.type !== 'session.end') {
      await this.waitWhileBlocked();
      if (this.stopRequested) return;
    }
    switch (env.type) {
      case 'browse.next': {
        this.logger(`[browse] 命令: browse.next`);
        await this.safeCloseModal();
        await this.humanPause(this.cardGapTiming);
        await this.deps.scroller.scrollNext();
        await this.waitForCards(5000);
        await this.reportVisibleCards();
        break;
      }
      case 'browse.scroll': {
        this.logger(`[browse] 命令: browse.scroll`);
        await this.deps.scroller.scrollNext();
        await this.waitForCards(5000);
        await this.reportVisibleCards();
        break;
      }
      case 'page.scroll': {
        const payload = env.payload as PageScrollPayload;
        this.logger(`[browse] 命令: page.scroll (${payload.reason ?? ''})`);
        if (payload.reason === 'resume_redrive') await this.ensureExplore();
        await this.ensureFeedDwell(payload.dwellMs); // 翻页前看完本批新卡（feed-scroll-card-floor）
        await this.deps.scroller.scrollNext();
        await this.waitForCards(5000);
        await this.reportVisibleCards();
        break;
      }
      case 'feed.refresh': {
        const payload = env.payload as FeedRefreshPayload;
        this.logger(`[browse] 命令: feed.refresh (${payload.reason ?? ''})`);
        await this.refreshFeed(payload.thinkMs);
        break;
      }
      case 'note.open': {
        const payload = env.payload as NoteOpenPayload;
        this.logger(`[browse] 命令: note.open (index=${payload.index}, noteId=${payload.noteId ?? '?'})`);
        if (!(await this.gateBeforeAction('action', payload.thinkMs))) break; // 最小间隔 + 打开前犹豫（max，非累加）
        await this.openAndReportNote(payload.index ?? 0, payload.noteId);
        break;
      }
      case 'note.close': {
        const payload = env.payload as NoteClosePayload;
        this.logger(`[browse] 命令: note.close`);
        await this.ensureDetailDwell(payload.dwellMs); // 关闭前确保停留达标
        await this.safeCloseModal();
        this.deps.client.reportActionCompleted?.({ action: 'close', ok: true });
        break;
      }
      case 'interaction.like': {
        const payload = env.payload as InteractionLikePayload;
        this.logger(`[browse] 命令: interaction.like (noteId=${payload.noteId})`);
        if (!(await this.gateBeforeAction('action', payload.thinkMs))) break; // 最小间隔 + 点赞前犹豫（max）
        await this.executeLikeOrCollect('like');
        break;
      }
      case 'interaction.collect': {
        const payload = env.payload as InteractionCollectPayload;
        this.logger(`[browse] 命令: interaction.collect (noteId=${payload.noteId})`);
        if (!(await this.gateBeforeAction('action', payload.thinkMs))) break; // 最小间隔 + 收藏前犹豫（max）
        await this.executeLikeOrCollect('collect');
        break;
      }
      case 'interaction.follow': {
        const payload = env.payload as InteractionFollowPayload;
        this.logger(`[browse] 命令: interaction.follow (authorId=${payload.authorId ?? '?'})`);
        if (!(await this.gateBeforeAction('action', payload.thinkMs))) break; // 最小间隔 + 关注前犹豫（max）
        await this.executeFollow();
        break;
      }
      case 'interaction.comment': {
        const payload = env.payload as InteractionCommentPayload;
        this.logger(`[browse] 命令: interaction.comment (noteId=${payload.noteId})`);
        if (!(await this.gateBeforeAction('action', payload.thinkMs))) break; // 最小间隔 + 发评论前犹豫（max）
        // 发布前就地核对（change comment-keep-open-through-approval，取舍2）：读当前详情页 URL 的 noteId
        // 与目标核对，明确不符（页面被弹层顶掉/被导航到别的笔记）→ 诚实终止不发；不搜索、不重开。
        // 只在 URL 能正向解析出 noteId 且【明确不符】时拦；取不到（如详情为搜索页上的弹层）宽松放行——
        // keep-open 持锁已是主保护，此为二次安全闸，绝不因取不到就误杀有效评论、也绝不在错笔记上发。
        if (payload.noteId) {
          const currentId = this.parseNoteIdFromUrl(await this.evalUrl());
          if (currentId && currentId !== payload.noteId) {
            this.logger(`[browse] interaction.comment 目标核对失败：当前详情 noteId=${currentId} ≠ 目标 ${payload.noteId} → 诚实终止不发`);
            this.deps.client.reportActionCompleted?.({ action: 'comment', ok: false, reason: 'note_page_mismatch' });
            break;
          }
        }
        await this.executeComment(payload.text, payload.groupChatCode);
        break;
      }
      case 'interaction.like_comment': {
        const payload = env.payload as InteractionLikeCommentPayload;
        this.logger(`[browse] 命令: interaction.like_comment (anchor=${payload.commentAnchorId})`);
        if (!(await this.gateBeforeAction('action', payload.thinkMs))) break; // 最小间隔 + 点评论赞前犹豫（max）
        await this.executeLikeComment(payload.commentAnchorId);
        break;
      }
      case 'search.execute': {
        const payload = env.payload as { keyword?: string; maxResults?: number; sort?: string; timeWindow?: string };
        const kw = payload.keyword ?? '';
        this.logger(`[browse] 命令: search.execute「${kw}」${payload.sort ? ` sort=${payload.sort}` : ''}${payload.timeWindow ? ` time=${payload.timeWindow}` : ''}`);
        await this.safeCloseModal();
        // 诚实闸（change comment-search-nav-confirm）：采卡前必须确认真到达搜索结果页。
        // 判据是「采卡时刻的实时 URL」——不与 executeSearch 的布尔取 AND（布尔可能滞后，
        // AND 会把「其实已到结果页但确认稍慢」误杀成不上报，制造新的静默不上报回归）。
        let onSearch = false;
        if (kw) {
          try {
            await executeSearch(kw, {
              cdp: this.deps.cdp,
              random: this.random,
              sleep: this.sleep,
              logger: this.logger,
            });
            // 权威判据（采卡时刻实时 URL）：既是搜索结果页，且结果页关键词与本次搜索词一致（change
            // comment-keep-open-through-approval，关 Bug C）——提交失败时浏览器赖在旧关键词结果页上，
            // 只验页型会把旧页当本次成功、采错词的卡；核对 keyword 参数杜绝。
            {
              const nowUrl = await this.evalUrl();
              onSearch = this.isSearchListUrl(nowUrl) && searchResultMatchesKeyword(nowUrl, kw);
            }
            // 按需评论任务（change comment-search-command）：仅在**确认已到结果页**时应用原生「排序 + 发布时间」筛选。
            // 自治浏览不带 sort/timeWindow → 跳过，行为不变。控件未生效 honest 降级（不冒充已筛）。
            if (onSearch && (payload.sort || payload.timeWindow)) {
              const filterRes = await applySearchFilters(
                { sort: payload.sort, timeWindow: payload.timeWindow },
                { cdp: this.deps.cdp, random: this.random, sleep: this.sleep, logger: this.logger },
              );
              // honest：控件未生效如实记录（云端暂不消费此信号，仅供边缘日志/最近状态追溯；绝不据此冒充已筛）。
              // 不用 ⚠ 前缀——main.cjs 见 ⚠ 会把风控置 warned，筛选未命中不应触发风控。
              if ((payload.sort && !filterRes.sortApplied) || (payload.timeWindow && !filterRes.timeApplied)) {
                this.logger(
                  `[browse] 搜索原生筛选未完全生效（sort=${filterRes.sortApplied} time=${filterRes.timeApplied}）：结果非严格「最近一天·最多收藏」`,
                );
              }
            }
          } catch (err) {
            // 抛错（搜索框未找到等）→ 视为未到结果页，走诚实失败分支，绝不 fall through 去报当前页。
            this.logger(`[browse] 搜索执行失败：${(err as Error).message}`);
            onSearch = false;
          }
        } else {
          // 无关键词：仅当已在搜索结果页才认，绝不主动把当前页当搜索结果。
          onSearch = this.isSearchListUrl(await this.evalUrl());
        }
        if (!onSearch) {
          // 红线（MUST NOT 静默假成功）：未确认到达结果页时绝不采/报当前页 feed；诚实回失败回执供云端消费。
          this.logger('[browse] 搜索未到达结果页（未确认导航/仍在 feed）→ 诚实回 search ok:false，不把当前页当搜索结果上报');
          this.deps.client.reportActionCompleted?.({ action: 'search', ok: false, reason: 'not_on_search_page' });
          break;
        }
        await this.waitForCards(5000);
        await this.waitForSearchResultNoteIds();
        await this.reportVisibleCards();
        break;
      }
      case 'navigation.back': {
        const payload = env.payload as NavigationBackPayload;
        this.logger(`[browse] 命令: navigation.back (${payload.reason ?? ''}, target=${payload.targetPage ?? ''})`);
        // 返回前确保详情页实际停留达标（治秒退）；须在关 modal 前完成。
        await this.ensureDetailDwell(payload.dwellMs);
        await this.navigateBack(payload.targetPage, payload.reason);
        break;
      }
      case 'note.browse_images': {
        const payload = env.payload as NoteBrowseImagesPayload;
        const count = payload.count ?? 3;
        this.logger(`[browse] 命令: note.browse_images (noteId=${payload.noteId}, count=${count})`);
        if (!(await this.gateBeforeAction('card_gap', payload.thinkMs))) break; // 翻图前最小间隔（card_gap 档）
        await this.browseNoteImages(payload.noteId, count);
        break;
      }
      case 'note.scroll_comments': {
        const payload = env.payload as NoteScrollCommentsPayload;
        const count = payload.count ?? 3;
        this.logger(`[browse] 命令: note.scroll_comments (noteId=${payload.noteId}, count=${count})`);
        if (!(await this.gateBeforeAction('scroll', payload.thinkMs))) break; // 滚评论前最小间隔（scroll 档）
        await this.scrollNoteComments(payload.noteId, count);
        break;
      }
      case 'profile.open': {
        const payload = env.payload as ProfileOpenPayload;
        this.logger(`[browse] 命令: profile.open (authorId=${payload.authorId ?? '?'})`);
        if (!(await this.gateBeforeAction('action', payload.thinkMs))) break; // 开主页前最小间隔（action 档）
        await this.openAuthorProfile(payload.authorId, payload.direct);
        break;
      }
      case 'notification.open': {
        const payload = env.payload as NotificationOpenPayload;
        this.logger('[browse] 命令: notification.open (导航通知首页)');
        await this.thinkBefore(payload.thinkMs);
        await this.openNotificationsHome();
        break;
      }
      case 'notification.browse_comments': {
        const payload = env.payload as NotificationBrowseCommentsPayload;
        this.logger('[browse] 命令: notification.browse_comments');
        await this.thinkBefore(payload.thinkMs);
        await this.browseNotificationComments(payload.scrollMax ?? 3);
        break;
      }
      case 'notification.browse_likes': {
        const payload = env.payload as NotificationBrowseLikesPayload;
        this.logger('[browse] 命令: notification.browse_likes');
        await this.thinkBefore(payload.thinkMs);
        await this.viewNotificationCategory('likes');
        break;
      }
      case 'notification.browse_follows': {
        const payload = env.payload as NotificationBrowseFollowsPayload;
        this.logger('[browse] 命令: notification.browse_follows');
        await this.thinkBefore(payload.thinkMs);
        await this.viewNotificationCategory('follows');
        break;
      }
      case 'notification.back_home': {
        const payload = env.payload as NotificationBackHomePayload;
        this.logger('[browse] 命令: notification.back_home (返回通知首页)');
        await this.thinkBefore(payload.thinkMs);
        await this.openNotificationsHome();
        break;
      }
      case 'plan.response': {
        const payload = env.payload as PlanResponsePayload;
        const steps = payload?.steps ?? [];
        this.logger(`[browse] 命令: plan.response（${steps.length} 步）`);
        for (const step of steps) {
          await this.humanPause(this.actionTiming);
          try {
            const r = await this.deps.stepRunner.run(step);
            this.logger(`[browse] 步骤 ${step.actionId} → ${r.ok ? 'OK' : 'FAIL'}（${r.reason}）`);
          } catch (err) {
            this.logger(`[browse] 步骤 ${step.actionId} 异常：${(err as Error).message}`);
          }
        }
        await this.safeCloseModal();
        this.deps.client.reportActionCompleted?.({ action: 'plan', ok: true });
        break;
      }
      case 'session.end': {
        const payload = env.payload as SessionEndPayload;
        this.pendingAutoResumeInMs = this.validAutoResumeInMs(payload.autoResumeInMs);
        this.logger(
          this.pendingAutoResumeInMs === undefined
            ? '[browse] 命令: session.end，结束会话'
            : `[browse] 命令: session.end，结束会话（预计休息约 ${this.formatAutoResumeMinutes(this.pendingAutoResumeInMs)} 分钟后继续）`,
        );
        this.stopRequested = true;
        await this.safeCloseModal();
        break;
      }
      default:
        this.logger(`[browse] 未知命令: ${env.type}`);
    }
  }

  /**
   * 获取当前可见卡片，以结构化 page.cards 协议上报给云端。
   * 包含 title, author, likeCount, collectCount, isVideo, position 等完整信息供 Cloud 决策。
   */
  private async reportVisibleCards(): Promise<void> {
    let cards = await this.deps.scroller.getVisibleCards();
    if (cards.length === 0) {
      // 不立即放弃：再轮询一轮等 feed 水合（back 后 / 慢渲染），避免静默吞 0 卡 → 边-云互等死锁。
      await this.waitForVisibleCards(3000);
      cards = await this.deps.scroller.getVisibleCards();
    }
    if (cards.length === 0) {
      this.logger('[browse] 无可见卡片可上报');
      return;
    }
    // 近重复折叠（change dedup）：同一快照里「同标题+同作者」只保留首张——小红书会把同一创作者近乎一样的
    // 系列帖（不同 noteId）混进瀑布流,否则云端会对内容几乎相同的两条各开一次（真机实测「第7集 Harness」连开两次）。
    // 标题或作者为空时用 noteId/coverUrl/position 当指纹,避免把多张「无标题」误折叠成一张。
    {
      const seenFp = new Map<string, number>();
      const before = cards.length;
      const deduped: typeof cards = [];
      for (const c of cards) {
        const fp = c.title && c.author ? `${c.title}|${c.author}` : (c.noteId ?? c.coverUrl ?? `pos:${c.position}`);
        const priorIndex = seenFp.get(fp);
        if (priorIndex === undefined) {
          seenFp.set(fp, deduped.length);
          deduped.push(c);
          continue;
        }
        const prior = deduped[priorIndex];
        if (!prior.noteId && c.noteId) {
          deduped[priorIndex] = c;
        }
      }
      cards = deduped;
      if (cards.length < before) this.logger(`[browse] 近重复折叠：${before} → ${cards.length} 张`);
    }
    const payload: PageCardsPayload = {
      cards: cards.map((card, i) => ({
        index: card.position ?? i,
        title: card.title ?? '',
        author: card.author,
        likeCount: 0,
        collectCount: 0,
        coverDesc: undefined,
        noteId: card.noteId,
        isVideo: card.isVideo,
      })),
      ...(this.startupId ? { startupId: this.startupId } : {}),
    };
    // 解析 likes 字符串为数字
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].likes) {
        const { parseCount } = await import('./note-extractor.js');
        payload.cards[i].likeCount = parseCount(cards[i].likes!);
      }
    }
    this.deps.client.reportPageCards?.(payload);
    // feed-scroll-card-floor：刷新"本批卡到达时刻"锚点（下一次带 dwellMs 的翻页据此只补差额）。
    this.feedCardsArrivedAt = this.now();
    const cardSummary = payload.cards
      .map((c) => `[${c.index}]“${(c.title ?? '').slice(0, 18)}”${c.author ? '@' + c.author : ''}${c.likeCount ? ' 👍' + c.likeCount : ''}`)
      .join(' / ');
    this.logger(`[browse] 已上报 ${cards.length} 张可见卡片 (page.cards): ${cardSummary}`);
  }

  /**
   * 按 noteId 找回目标卡——**先判它是否还在 DOM**（getVisibleCards 只取视口内卡，卡可能只是被 AI 总结
   * 顶出视口、仍在 DOM）：在 DOM 就 `scrollIntoView` 精准拉回视口再扫（治 /comment 开笔记）；真被虚拟
   * 列表回收出 DOM（自主 feed 换页的常态）就**立即返回 undefined、绝不盲滚**——盲滚既救不回、还会把
   * feed 越滚越乱、每次白费数秒（真机黑匣子实证：自主浏览 note.open 级联里盲滚 5 下次次落空）。
   * 命中返回卡片；不在 DOM / 拉回后仍无 → undefined（回退旧兜底重报）。
   */
  private async locateCardByNoteId(noteId: string): Promise<NoteCard | undefined> {
    // 找该 noteId 的 /explore|/discovery/item 链接卡（不限视口），命中则滚其容器到视口中央、返回 true。
    const scrollIntoViewJs = `(function(){
      var id = ${JSON.stringify(noteId)};
      var links = Array.prototype.slice.call(document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]'));
      for (var i=0;i<links.length;i++){
        var h = links[i].getAttribute('href') || '';
        if (h.indexOf('/' + id) === -1) continue;
        var card = (links[i].closest && (links[i].closest('section') || links[i].closest('[class*="note-item"]') || links[i].closest('li') || links[i].closest('div'))) || links[i];
        try { card.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { card.scrollIntoView(); }
        return true;
      }
      return false; // 不在 DOM（真被回收）
    })()`;
    const inDom = await evalRaw<boolean>(this.deps.cdp, scrollIntoViewJs).catch(() => false);
    if (inDom !== true) return undefined; // 不在 DOM → 立即放弃、不盲滚
    await this.sleep(500); // 等滚动落定 + 视口内渲染，再按视口口径重扫
    const cards = await this.deps.scroller.getVisibleCards();
    const hit = cards.find((c) => c.noteId === noteId);
    if (hit) this.logger(`[browse] note.open: scrollIntoView 找回 noteId=${noteId}`);
    return hit;
  }

  /**
   * 打开指定 index 的卡片，提取内容并用 note.detail 协议上报给云端。
   */
  private assertNoteOpenDeadline(deadlineAt: number | undefined, phase: string): void {
    if (deadlineAt !== undefined && this.now() >= deadlineAt) throw new NoteOpenDeadlineError(phase);
  }

  private remainingNoteOpenMs(deadlineAt: number, phase: string): number {
    this.assertNoteOpenDeadline(deadlineAt, phase);
    return Math.max(1, deadlineAt - this.now());
  }

  /** 以剩余 budget 截短非关键阅读停顿；返回 false 表示预算已耗尽。 */
  private async humanPauseBeforeNoteDeadline(timing: TimingConfig, deadlineAt: number): Promise<boolean> {
    const base = sampleDelay(timing, this.random);
    const ms = applySpeedFactor(base, this.rhythm.getSpeedFactor(this.progress()));
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) return false;
    if (ms > 0) await this.sleep(Math.min(ms, remaining));
    return this.now() < deadlineAt;
  }

  private async openAndReportNote(index: number, noteId?: string): Promise<void> {
    const startedAt = this.now();
    const deadlineAt = startedAt + this.noteOpenTimeoutMs;
    const phaseDurations: string[] = [];
    const finish = (outcome: string): void => {
      this.logger(
        `[browse] note.open ${outcome} totalMs=${Math.max(0, this.now() - startedAt)} budgetMs=${this.noteOpenTimeoutMs} phases=${phaseDurations.join(',') || '-'}`,
      );
    };
    const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      this.assertNoteOpenDeadline(deadlineAt, name);
      const phaseStartedAt = this.now();
      try {
        const result = await work();
        this.assertNoteOpenDeadline(deadlineAt, name);
        return result;
      } finally {
        phaseDurations.push(`${name}=${Math.max(0, this.now() - phaseStartedAt)}ms`);
      }
    };

    try {
      const cards = await phase('cards_snapshot', () => this.deps.scroller.getVisibleCards());
    // 优先按 noteId 在「当前快照」里定位：云端决策与 edge 执行之间 feed 可能已滚动，
    // 纯 index/position 寻址会开成同序号上的"邻座"（云端判 LLM 卡 valuable，edge 却开了 NPD/C罗）。
    let card: NoteCard | undefined;
    if (noteId) {
      card = cards.find((c) => c.noteId === noteId);
      if (!card) {
        // 目标卡不在【视口内】快照（getVisibleCards 只取视口内卡）——最常见成因：AI 总结流式生成
        // 一边变长一边把下方 feed 卡往下顶，被选中的卡滚出视口（仍在 DOM）。命令式流程（/comment 读笔记）
        // 严格等 note.detail、消费不了「重报 page.cards」，找不到就会让云端干等满超时 → 评论发不出。
        // 故先【按 noteId 有界滚动找回视口】（卡还在 DOM，滚回来即命中），再开。
        this.logger(`[browse] note.open: 目标 noteId=${noteId} 不在视口内快照，尝试 scrollIntoView 找回…`);
        card = await phase('locate_card', () => this.locateCardByNoteId(noteId));
      }
      if (!card) {
        // 有界滚动仍找不到（真被虚拟列表回收出 DOM）：回到旧兜底「重报当前快照」（自主浏览据此重判；
        // 命令式流程则如实超时——已尽力，不假成功）。
        this.logger(`[browse] note.open: 滚动后仍无 noteId=${noteId}，重报当前卡片`);
        await phase('report_cards_fallback', () => this.reportVisibleCards());
        finish('failed:card_not_found');
        return;
      }
    } else {
      // 无 noteId（兜底 / 老协议）：退回按 position/index 寻址。
      card = cards.find((c) => c.position === index) ?? cards[index];
    }
    if (!card) {
      this.logger(`[browse] note.open: 找不到 index=${index} 的卡片`);
      this.deps.client.reportActionCompleted?.({ action: 'open_note', ok: false, reason: 'card_not_found' });
      finish('failed:card_not_found');
      return;
    }
    await phase('remember_source', () => this.rememberCurrentSourceList());
    await phase('click_primary', () => this.deps.scroller.openCard(card, { deadlineAt, clock: this.now }));
    let opened = await phase(
      'modal_wait_primary',
      () => this.deps.modalCtrl.waitForModal(Math.min(this.modalTimeoutMs, this.remainingNoteOpenMs(deadlineAt, 'modal_wait_primary'))),
    );
    if (!opened) {
      // 重试一次：点击可能未命中或渲染较慢
      this.logger('[browse] note.open: modal 未打开，重试一次');
      await phase('click_retry', () => this.deps.scroller.openCard(card!, { deadlineAt, clock: this.now }));
      opened = await phase(
        'modal_wait_retry',
        () => this.deps.modalCtrl.waitForModal(Math.min(this.modalTimeoutMs, this.remainingNoteOpenMs(deadlineAt, 'modal_wait_retry'))),
      );
    }
    if (!opened) {
      this.logger(`[browse] note.open: modal 未打开（重试后仍失败）`);
      this.deps.client.reportActionCompleted?.({ action: 'open_note', ok: false, reason: 'modal_timeout' });
      finish('failed:modal_timeout');
      return;
    }
    await phase('engage_bar', () => this.waitForEngageBar(Math.min(3000, this.remainingNoteOpenMs(deadlineAt, 'engage_bar'))));
    // 正文(#detail-desc)常比 engage-bar 晚渲染：先等正文出现再抽取，避免抽到空/「标题+刚刚」。
    // 按类型给正文门余量：文字/图文渲染实测 <1s，3.5s 已远超（body-less 时早停不空等满 5.5s）；
    // video 主体是视频、正文多为空 → 2.5s 更短。命中真正文即提前返回，不影响抽取保真。
    await phase(
      'body_ready',
      () => this.waitForNoteBody(Math.min(card.isVideo ? 2500 : 3500, this.remainingNoteOpenMs(deadlineAt, 'body_ready'))),
    );
    // 记录详情页打开时刻：后续 navigation.back / note.close 据此判定实际停留是否达标（治秒退）。
    this.noteOpenedAt = this.now();

    let content: import('./note-extractor.js').NoteContent;
    try {
      content = await phase('extract', () => this.deps.noteExtractor(this.deps.dom));
    } catch (err) {
      if (err instanceof NoteOpenDeadlineError || err instanceof InputDispatchDeadlineError) throw err;
      this.logger(`[browse] note.open: 提取内容失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'open_note', ok: false, reason: 'extract_failed' });
      finish('failed:extract_failed');
      return;
    }

    // Fallback: 用卡片数据补充
    if (content.likes === 0 && card.likes) {
      const { parseCount } = await import('./note-extractor.js');
      content.likes = parseCount(card.likes);
    }
    // 标题兜底（change detail-extraction）：详情标题抽空（选择器未命中 / 命中插页被 denylist 置空）时回退卡片标题,
    // 避免上报「空标题」note.detail。
    if ((!content.title || content.title.trim() === '') && card.title) {
      content.title = card.title;
    }

    // 解析真实 noteId：优先 feed 卡片 → modal 内 explore 链接 → 当前页面 URL → 合成兜底。
    // 真实 noteId 是云端 visited 去重的主键，缺失会导致"反复打开同一张卡"的死循环。
    // 当前地址栏 URL（含 xsec_token，详情态）：既用于解析 noteId，也作 note.detail 的可点链接来源（change interaction-feed-enrichment）。
    const pageUrl = await phase('page_url', () => this.evalUrl());
    const realNoteId = card.noteId ?? this.parseNoteIdFromUrl(content.noteUrl) ?? this.parseNoteIdFromUrl(pageUrl);
    // 诚实置空：仅当地址栏链接确含 xsec_token 才作为真实可点链接上报；否则不带，绝不用裸 id 拼打不开的假链接。
    const detailUrl = pageUrl.includes('xsec_token=') ? pageUrl : undefined;

    // 探测作者区关注按钮当下真实态（change skip-profile-visit-if-followed）：已关注则随 note.detail 带回，
    // 云端在「是否进主页」评估前据此短路掉整条主页子链。读不到→false→回退原流程。
    const authorFollowed = await phase('author_follow_probe', () => this.probeAuthorFollowed());

    // 用 note.detail 上报
    const payload: NoteDetailPayload = {
      noteId: realNoteId ?? `card-${card.position}`,
      title: content.title,
      content: content.body,
      mediaType: card.isVideo ? 'video' : 'image_text',
      author: content.author,
      likeCount: content.likes,
      collectCount: content.collects,
      authorFollowed,
      // 发布相对时刻原始文本（change feed-hot-lead-group-comment）：抽到才带、缺则不带（诚实置空）。
      ...(content.publishedAtText ? { publishedAtText: content.publishedAtText } : {}),
      ...(detailUrl ? { url: detailUrl } : {}),
      ...(content.images.length > 0 ? { images: content.images } : {}),
    };
    this.deps.client.reportNoteDetail?.(payload);
    this.logger(
      `[browse] note.open: 已上报 note.detail noteId=${payload.noteId}「${(payload.title ?? '').slice(0, 24)}」` +
        `${payload.author ? ' by ' + payload.author : ''} 👍${payload.likeCount ?? 0} ⭐${payload.collectCount ?? 0}` +
        `${authorFollowed ? ' [已关注]' : ''}` +
        ` 正文:${(payload.content ?? '').replace(/\s+/g, ' ').slice(0, 50)}…`,
    );
    await this.readLongBody(content, deadlineAt);
    this.processed++;
    finish('completed');
    } catch (err) {
      if (err instanceof NoteOpenDeadlineError || err instanceof InputDispatchDeadlineError) {
        const timeoutPhase = err instanceof NoteOpenDeadlineError ? err.phase : 'click_input';
        this.logger(`[browse] note.open: 预算耗尽，停止后续输入并等待安全边界 phase=${timeoutPhase}`);
        this.deps.client.reportActionCompleted?.({ action: 'open_note', ok: false, reason: 'open_timeout' });
        finish(`failed:open_timeout phase=${timeoutPhase}`);
        return;
      }
      throw err;
    }
  }

  /**
   * 等待 modal 的 engage-bar（含收藏数 collect-wrapper）渲染完成。
   */
  private async waitForEngageBar(timeout = 3000, intervalMs = 300): Promise<void> {
    const start = Date.now();
    const expr =
      '!!document.querySelector(".collect-wrapper") || !!document.querySelector(".engage-bar")';
    while (Date.now() - start < timeout) {
      try {
        const res = await this.deps.cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: expr, returnByValue: true },
        );
        if ((res as { result?: { value?: unknown } }).result?.value === true) return;
      } catch {
        /* ignore，下一轮重试 */
      }
      await this.sleep(intervalMs);
    }
    this.logger('[browse] engage-bar 未在超时内出现，收藏数可能为 0');
  }

  /**
   * 等待笔记正文（#detail-desc）渲染出实际文本再返回。
   *
   * 背景（实测 6/16）：正文常比 engage-bar 晚一拍渲染，过早抽取会拿到空 body，
   * 进而回退到含"标题+发布时间"的容器、并让云端 curator 误判"空洞"。这里只盯
   * 正文容器 `#detail-desc`（评论区也用 `.note-text`，故不以它为准）；纯图文/视频
   * 笔记本就无正文 → 等到超时即放行（body 合法为空，不阻塞）。
   */
  private async waitForNoteBody(timeout = 5500, intervalMs = 250): Promise<void> {
    const start = Date.now();
    // 渲染门与抽取器共用 NOTE_BODY_SELECTORS（避免门通过但抽取器未命中的漂移）。
    const sel = JSON.stringify([...NOTE_BODY_SELECTORS]);
    const expr = `(function(){var S=${sel};for(var i=0;i<S.length;i++){var d=document.querySelector(S[i]);if(d&&(d.textContent||'').trim().length>=3)return true;}return false;})()`;
    while (Date.now() - start < timeout) {
      try {
        const res = await this.deps.cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: expr, returnByValue: true },
        );
        if ((res as { result?: { value?: unknown } }).result?.value === true) return;
      } catch {
        /* ignore，下一轮重试 */
      }
      await this.sleep(intervalMs);
    }
    // 超时：区分「真·纯图文/视频笔记（合法无正文）」与「布局变体未命中（modal 内有正文文本但已知选择器没覆盖到，需补 NOTE_BODY_SELECTORS）」。
    let variantMiss = false;
    try {
      const probe = `(function(){var c=document.querySelector('.note-scroller, [class*="note-content"], #noteContainer');return !!c && (c.textContent||'').replace(/\\s+/g,'').length>20;})()`;
      const res = await this.deps.cdp.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: probe, returnByValue: true },
      );
      variantMiss = (res as { result?: { value?: unknown } }).result?.value === true;
    } catch {
      /* ignore */
    }
    if (variantMiss) {
      this.logger('[browse] 正文容器疑似布局变体，已知选择器未命中（body 抽空，需补 NOTE_BODY_SELECTORS）');
    } else {
      this.logger('[browse] 正文未在超时内渲染（可能是纯图文/视频笔记，body 为空）');
    }
  }

  /**
   * 长正文阅读动作：详情抽取完成后，先在正文/详情滚动容器内做数次小步滚动，再进入看图/评论阶段。
   * 这不是数据抽取所必需，而是浏览行为本身的保真：长文不能只抽完文本就直接跳到评论。
   */
  private async readLongBody(content: NoteContent, deadlineAt?: number): Promise<void> {
    const compactLen = (content.body || '').replace(/\s+/g, '').length;
    const lineCount = (content.body || '').split(/\n+/).filter((s) => s.trim().length > 0).length;
    if (compactLen < BODY_READ_MIN_CHARS && lineCount < BODY_READ_MIN_LINES) return;

    const steps = Math.min(8, Math.max(2, Math.ceil((compactLen - 160) / 260)));
    const selectors = JSON.stringify([...NOTE_BODY_SELECTORS]);
    const { evalRaw: evalRawFn } = await import('./cdp-util.js');
    let moved = 0;
    try {
      for (let i = 0; i < steps; i++) {
        if (deadlineAt !== undefined && !(await this.humanPauseBeforeNoteDeadline(TIMING_PRESETS.scroll, deadlineAt))) {
          this.logger('[browse] note.open: 详情已上报，预算耗尽，跳过剩余长文阅读');
          return;
        }
        const distance = this.variedScrollDistance(170, 320);
      const expr = `(function(){
        var S=${selectors};
        var root=document.querySelector('.note-detail-mask')||document.querySelector('.note-container')||document;
        function pointFor(el){
          var r=el.getBoundingClientRect();
          var vw=document.documentElement.clientWidth||document.body.clientWidth||1280;
          var vh=document.documentElement.clientHeight||document.body.clientHeight||800;
          var left=Math.max(8, Math.min(vw-8, Math.max(r.left, 8)));
          var right=Math.max(8, Math.min(vw-8, Math.min(r.right, vw-8)));
          var top=Math.max(80, Math.min(vh-40, Math.max(r.top, 80)));
          var bottom=Math.max(80, Math.min(vh-40, Math.min(r.bottom, vh-40)));
          var x=Math.round((left+right)/2);
          var y=Math.round((top+bottom)/2);
          return {x:x,y:y};
        }
        function firstBody(){
          for(var i=0;i<S.length;i++){ var el=root.querySelector(S[i])||document.querySelector(S[i]); if(el&&(el.textContent||'').trim()) return el; }
          return null;
        }
        function scrollable(el){
          var n=el;
          while(n&&n!==document.body&&n!==document.documentElement){
            var s=window.getComputedStyle(n);
            if(n.scrollHeight>n.clientHeight+8&&/(auto|scroll)/.test(s.overflowY)) return n;
            n=n.parentElement;
          }
          return document.scrollingElement||document.documentElement;
        }
        var body=firstBody();
        if(!body) return JSON.stringify({found:false});
        var c=scrollable(body);
        var rect=body.getBoundingClientRect();
        var vh=document.documentElement.clientHeight||document.body.clientHeight||800;
        var scrollTop=c.scrollTop||0;
        var reachedEnd=rect.bottom<vh*0.75 || scrollTop+c.clientHeight>=c.scrollHeight-24;
        var p=pointFor(c);
        return JSON.stringify({found:true,scrollTop:scrollTop,scrollHeight:c.scrollHeight,clientHeight:c.clientHeight,x:p.x,y:p.y,reachedEnd:reachedEnd});
      })()`;
        const r = await this.inertialScrollByProbe(evalRawFn, expr, distance, deadlineAt);
        if (!r.found) break;
        if (typeof r.after === 'number' && typeof r.before === 'number' && r.after > r.before) moved++;
        if (r.reachedEnd) break;
      }
    } catch (err) {
      if (err instanceof NoteOpenDeadlineError) {
        this.logger('[browse] note.open: 详情已上报，预算耗尽，停止长文阅读');
        return;
      }
      throw err;
    }
    if (moved > 0) this.logger(`[browse] 正文已小步滚动阅读 ${moved}/${steps} 次`);
  }

  /**
   * 轮询一个返回校验值的表达式，命中 predicate 即提前返回（互动生效多在 300–600ms、发评论多在 1s 内），
   * 到 timeout 仍未命中则返回最后一次读到的值再交由调用方判定。带上限、首轮立即读——
   * 取代「固定 sleep 后单次读」：快路径省时，慢路径退化为原等待时长后再判，绝不因过早读误报「未生效」。
   */
  private async pollDomUntil(
    expr: string,
    predicate: (raw: string) => boolean,
    timeout: number,
    intervalMs = 200,
  ): Promise<string | undefined> {
    // 按迭代次数限界（不依赖注入时钟 now() 推进——测试常注入恒定 now，若靠 now() 判超时会死循环）：
    // 约 timeout/intervalMs 轮、每轮之间真等 intervalMs；测试注入即时 sleep 也确定性退出。对齐 waitOptionVisible。
    const rounds = Math.max(1, Math.ceil(timeout / intervalMs));
    let last: string | undefined;
    for (let i = 0; i < rounds; i++) {
      last = await evalRaw<string>(this.deps.cdp, expr);
      if (typeof last === 'string' && predicate(last)) return last;
      if (i < rounds - 1) await this.sleep(intervalMs);
    }
    return last;
  }

  /** 抽取当前 DOM 里第一张 feed 卡的 noteId（虚拟列表下 = 当前渲染的最上一张）；无则空串。 */
  private async firstVisibleNoteId(): Promise<string> {
    const js = `(function(){
      var a = document.querySelector('a[href*="/explore/"],a[href*="/discovery/item/"]');
      if (!a) return '';
      var m = (a.getAttribute('href')||'').match(/\\/(explore|discovery\\/item)\\/([0-9a-f]{8,})/i);
      return m ? m[2] : '';
    })()`;
    const raw = await evalRaw<string>(this.deps.cdp, js).catch(() => '');
    return typeof raw === 'string' ? raw : '';
  }

  /**
   * feed 深度到阈值：点击右下角「刷新」按钮回到顶部换出全新一批（change feed-refresh-on-depth）。
   * 诚实执行 + 硬化后置校验：仅当「滚动回顶 且 出现具体非空的、与点击前不同的首卡」才算刷新真发生；
   * 只看滚动归零会被空首卡蒙混（纯回到顶部冒充换新批）——红线：绝不静默假成功。成功才上报新一批卡片。
   */
  private async refreshFeed(thinkMs?: number): Promise<void> {
    const action = 'refresh' as const;
    try {
      // ① 上下文闸：必须在 explore feed（详情/搜索/通知页无此按钮）
      const url = await this.evalUrl();
      if (!EXPLORE_FEED_RE.test(url)) {
        this.logger(`[browse] refresh 非 feed 页(${url})，诚实放弃`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'wrong_context' });
        return;
      }
      // ② 定位右下「刷新」按钮：.floating-btn-sets 内 class 含 reload 且非 back-top（退路 svg use[href="#reload"]）。
      //    真机标定：宽窄布局结构一致（docs/xhs-layout-states，探针 scripts/feed-refresh-button-probe.ts）。
      const locateJs = `(function(){
        var box = document.querySelector('.floating-btn-sets');
        if (!box) return JSON.stringify({error:'no_floating_btn'});
        var btn = null;
        var kids = box.querySelectorAll('*');
        for (var i=0;i<kids.length;i++){
          var el = kids[i];
          var cls = String((el.className && el.className.baseVal!=null)?el.className.baseVal:(el.className||''));
          if (/(^|\\s)reload(\\s|$)/.test(cls) && !/back-top/.test(cls)) { btn = el; break; }
        }
        if (!btn) {
          var use = box.querySelector('use[href="#reload"], use[*|href="#reload"]');
          if (use) btn = (use.closest && use.closest('div,button,span')) || use.parentElement;
        }
        if (!btn) return JSON.stringify({error:'no_reload_btn'});
        var r = btn.getBoundingClientRect();
        if (!(r.width>0 && r.height>0)) return JSON.stringify({error:'no_reload_btn'});
        return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});
      })()`;
      const rawLoc = await evalRaw<string>(this.deps.cdp, locateJs);
      const loc = typeof rawLoc === 'string' ? JSON.parse(rawLoc) : rawLoc;
      if (loc?.error) {
        this.logger(`[browse] refresh 定位失败: ${loc.error}`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: loc.error });
        return;
      }
      // ③ 最小间隔 + 点前犹豫（复用 action 档；gate 返回 false = CDP 重连中止等，诚实退出不点）
      if (!(await this.gateBeforeAction('action', thinkMs))) return;
      // ④ 点击前 fresh 复检验证码（fail-CLOSED）
      if (await this.captchaPresentFresh()) {
        this.logger('[browse] refresh 提交前复检到验证码/阻断，放弃点击');
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'blocked_by_captcha' });
        return;
      }
      // ⑤ 点击前一刻抓 pre-state 首卡（在 think-gate 之后，使前后比较只框住这次点击，防 think 窗内异步重渲染误判）
      const preFirstNoteId = await this.firstVisibleNoteId();
      // ⑥ 拟人点击
      const { dispatchClick } = await import('./cdp-util.js');
      await dispatchClick(this.deps.cdp, loc.x, loc.y, { random: this.random });
      // ⑦ 后置校验：滚动回顶(~0) 且 出现具体非空、与点前不同的首卡，才算真刷新。
      const verifyJs = `(function(){
        var y = Math.round(window.scrollY || (document.scrollingElement ? document.scrollingElement.scrollTop : 0) || 0);
        var a = document.querySelector('a[href*="/explore/"],a[href*="/discovery/item/"]');
        var id = '';
        if (a) { var m = (a.getAttribute('href')||'').match(/\\/(explore|discovery\\/item)\\/([0-9a-f]{8,})/i); if (m) id = m[2]; }
        return JSON.stringify({y: y, first: id});
      })()`;
      const reloaded = (raw: string): boolean => {
        try {
          const o = JSON.parse(raw) as { y: number; first: string };
          return typeof o.first === 'string' && o.first.length > 0 && o.first !== preFirstNoteId && o.y < 100;
        } catch {
          return false;
        }
      };
      const last = await this.pollDomUntil(verifyJs, reloaded, 2000);
      if (typeof last === 'string' && reloaded(last)) {
        this.logger('[browse] refresh 成功：回顶 + 换出全新一批');
        await this.reportVisibleCards();
        this.deps.client.reportActionCompleted?.({ action, ok: true });
      } else {
        this.logger('[browse] refresh 点后未确认换新批（not_reloaded），诚实失败、不报卡');
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'not_reloaded' });
      }
    } catch (err) {
      this.deps.client.reportActionCompleted?.({ action, ok: false, reason: (err as Error).message });
    }
  }

  /**
   * 在当前打开的 modal 中执行点赞或收藏。
   * Cloud 已做出决策，Edge 直接执行。执行结果通过 action.completed 上报。
   */
  private async executeLikeOrCollect(action: 'like' | 'collect'): Promise<void> {
    const wrapperCls = action === 'like' ? 'like-wrapper' : 'collect-wrapper';
    const alreadyDoneHref = action === 'like' ? '#liked' : '#collected';
    try {
      // 互动栏常比笔记打开晚一拍渲染（AI 总结流式重排 / 卡片回收）：定位前有界等待，
      // 避免在渲染完成前误报 btn_no-bar。超时不抛、仍走下方诚实 no-bar。
      await this.waitForEngageBar();
      const js = `(function(){
        var bar = document.querySelector('.interactions.engage-bar') || document.querySelector('.engage-bar');
        if (!bar) return JSON.stringify({error:'no-bar'});
        var el = bar.querySelector('.${wrapperCls}');
        if (!el) return JSON.stringify({error:'no-btn'});
        var use = el.querySelector('svg use');
        var href = use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : null;
        if (href === '${alreadyDoneHref}') return JSON.stringify({error:'already'});
        var r = el.getBoundingClientRect();
        return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), href: href});
      })()`;
      const raw = await evalRaw<string>(this.deps.cdp, js);
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result?.error) {
        // 已操作或按钮未找到 → 上报失败
        const reason = result.error === 'already'
          ? `already_${action}d`
          : `btn_${result.error}`;
        this.logger(`[browse] ${action} 失败: ${reason}`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason });
        return;
      }
      // 点击前 fresh 复检验证码（fail-CLOSED）：引导性停顿已上移到命令入口的 gateBeforeAction（最小间隔 + 云端犹豫，
      // 取 max 不累加），此处不再叠一段停顿——避免「操作后兜底累加」（设计 §3.3）。若当前有验证码/未知阻断浮层则放弃点击。
      if (await this.captchaPresentFresh()) {
        this.logger(`[browse] ${action} 提交前复检到验证码/未知阻断弹窗，放弃点击`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'blocked_by_captcha' });
        return;
      }
      const { dispatchClick } = await import('./cdp-util.js');
      await dispatchClick(this.deps.cdp, result.x, result.y, { random: this.random });
      // 验证：轮询 SVG href 是否翻成 #liked / #collected（多在 300–600ms 翻转），命中即返回、
      // 上限 1500ms —— 取代原固定 sleep(1500) 后单次读，快路径省 ~1s，仍带上限不会过早误报。
      const verifyJs = `(function(){
        var bar = document.querySelector('.interactions.engage-bar') || document.querySelector('.engage-bar');
        if (!bar) return 'no-bar';
        var el = bar.querySelector('.${wrapperCls}');
        if (!el) return 'no-btn';
        var use = el.querySelector('svg use');
        return use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : 'no-use';
      })()`;
      const afterHref = await this.pollDomUntil(verifyJs, (h) => h === alreadyDoneHref, 1500);
      if (afterHref === alreadyDoneHref) {
        this.logger(`[browse] ✓ ${action === 'like' ? '点赞' : '收藏'}成功 (${result.x}, ${result.y})`);
        this.deps.client.reportActionCompleted?.({ action, ok: true });
      } else {
        this.logger(`[browse] ⚠ ${action} 点击后状态未变化 (href=${afterHref})，可能未生效`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'state_unchanged' });
      }
    } catch (err) {
      this.logger(`[browse] ${action} 执行失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action, ok: false, reason: (err as Error).message });
    }
  }

  /**
   * 给详情页内「某一条评论」点赞。靠云端给的稳定锚点 commentAnchorId 经 getElementById 重新定位，
   * 在该评论行内点 `.interactions .like .like-wrapper`，点后按锚点复读校验 svg use #like→#liked（或赞数+1）。
   * 红线（绝不静默假成功）：
   *   - 锚点已不在（评论被滚走/重渲染）→ no_target，【绝不退化成「点现在在那个位置的那条」】；
   *   - 该评论已是已赞 → already_liked，不重复点；
   *   - 点击后状态未翻转 → state_unchanged；验证码弹窗 → blocked_by_captcha。
   * action 一律上报为 'comment_like'（= RiskAction，云端据此记账/扣预算/抑制补救滚动）。
   */
  private async executeLikeComment(anchorId: string): Promise<void> {
    const action = 'comment_like';
    try {
      const anchorJson = JSON.stringify(anchorId);
      const locateJs = `(function(){
        var row = document.getElementById(${anchorJson});
        if (!row) return JSON.stringify({error:'no_target'});
        var el = row.querySelector('.interactions .like .like-wrapper') || row.querySelector('.like-wrapper');
        if (!el) return JSON.stringify({error:'no_like_btn'});
        var use = el.querySelector('svg use');
        var href = use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : null;
        if (href === '#liked') return JSON.stringify({error:'already'});
        var cntEl = el.querySelector('.count');
        var cnt = cntEl ? (cntEl.textContent || '').trim() : null;
        var r = el.getBoundingClientRect();
        return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), href: href, count: cnt});
      })()`;
      const raw = await evalRaw<string>(this.deps.cdp, locateJs);
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result?.error) {
        const reason = result.error === 'already' ? 'already_liked' : result.error; // no_target | no_like_btn | already_liked
        this.logger(`[browse] comment_like 失败/跳过: ${reason} (anchor=${anchorId})`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason });
        return;
      }
      // 点击前 fresh 复检验证码（fail-CLOSED）：引导性停顿已上移到命令入口 gateBeforeAction（max 非累加），此处不再叠停顿。
      if (await this.captchaPresentFresh()) {
        this.logger('[browse] comment_like 提交前复检到验证码/未知阻断弹窗，放弃点击');
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'blocked_by_captcha' });
        return;
      }
      const { dispatchClick } = await import('./cdp-util.js');
      await dispatchClick(this.deps.cdp, result.x, result.y, { random: this.random });
      // 校验：轮询【按同一锚点复读】该评论行的赞控件，确认 use 翻成 #liked（或赞数较点前 +1），
      // 命中即返回、上限 1500ms（取代固定 sleep(1500)，快路径省 ~1s）。
      const beforeCount = typeof result.count === 'string' ? result.count : null;
      const isCommentLikeFlipped = (raw: string): boolean => {
        try {
          const a = JSON.parse(raw);
          const inc =
            beforeCount != null && a?.count != null && /^\d+$/.test(beforeCount) && /^\d+$/.test(a.count)
              ? Number(a.count) === Number(beforeCount) + 1
              : false;
          return a?.href === '#liked' || inc;
        } catch {
          return false;
        }
      };
      const verifyJs = `(function(){
        var row = document.getElementById(${anchorJson});
        if (!row) return JSON.stringify({href:'no_target', count:null});
        var el = row.querySelector('.interactions .like .like-wrapper') || row.querySelector('.like-wrapper');
        if (!el) return JSON.stringify({href:'no_btn', count:null});
        var use = el.querySelector('svg use');
        var href = use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : 'no-use';
        var cntEl = el.querySelector('.count');
        var cnt = cntEl ? (cntEl.textContent || '').trim() : null;
        return JSON.stringify({href: href, count: cnt});
      })()`;
      const afterRaw = await this.pollDomUntil(verifyJs, isCommentLikeFlipped, 1500);
      const after = typeof afterRaw === 'string' ? JSON.parse(afterRaw) : afterRaw;
      const countIncremented =
        beforeCount != null && after?.count != null && /^\d+$/.test(beforeCount) && /^\d+$/.test(after.count)
          ? Number(after.count) === Number(beforeCount) + 1
          : false;
      if (after?.href === '#liked' || countIncremented) {
        this.logger(`[browse] ✓ 评论点赞成功 (anchor=${anchorId})`);
        this.deps.client.reportActionCompleted?.({ action, ok: true });
      } else {
        this.logger(`[browse] ⚠ comment_like 点击后状态未变化 (href=${after?.href})，可能未生效`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'state_unchanged' });
      }
    } catch (err) {
      this.logger(`[browse] comment_like 执行失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action, ok: false, reason: (err as Error).message });
    }
  }

  /**
   * 在当前打开的笔记详情页发一条评论。Cloud 已撰写 / 去AI味 / 人审通过，Edge 直接执行。
   *
   * 选择器与发布后校验信号由真机 CDP 探针坐实（scripts/comment-probe.ts）：
   *  - 折叠态入口 `.engage-bar .content-edit .not-active`（"说点什么"）→ 激活后 engage-bar 加 `.active`；
   *  - 真编辑器 `p#content-textarea`（contenteditable，data-tribute 提及）——必须点本体落 caret；
   *  - 提交键 `.engage-bar.active button.btn.submit`（"发送"）；
   *  - 发布后校验：编辑器清空 且 自己的评论作为顶部新 `[id^="comment-"]` 行出现（评论数文本不可靠，不依赖）。
   * 红线：找不到框/按钮 no_target、未生效 state_unchanged、验证码 blocked_by_captcha——绝不静默假成功。
   */
  private async executeComment(text: string, contactInfo?: string): Promise<void> {
    const action = 'comment';
    // 记评论处理耗时：成功/未生效/异常三条出口都带上「耗时」，让 electron「最近状态」能看到评论处理用时（honest，失败也如实报时）。
    const startedAt = Date.now();
    const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    const body = (text ?? '').trim();
    if (!body) {
      this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'empty_text' });
      return;
    }
    try {
      const { dispatchClick, dispatchKeystrokes, insertText } = await import('./cdp-util.js');

      // 1) 定位折叠态评论入口并点击激活
      const entryJs = `(function(){
        var bar = document.querySelector('.interactions.engage-bar') || document.querySelector('.engage-bar');
        if (!bar) return JSON.stringify({error:'no-bar'});
        var entry = bar.querySelector('.content-edit .not-active') || bar.querySelector('.content-edit') || bar.querySelector('.input-box');
        if (!entry) return JSON.stringify({error:'no-entry'});
        var r = entry.getBoundingClientRect();
        return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});
      })()`;
      const entryRaw = await evalRaw<string>(this.deps.cdp, entryJs);
      const entry = typeof entryRaw === 'string' ? JSON.parse(entryRaw) : entryRaw;
      if (entry?.error) {
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: entry.error === 'no-bar' ? 'no_target' : `entry_${entry.error}` });
        return;
      }
      await dispatchClick(this.deps.cdp, entry.x, entry.y, { random: this.random });
      await this.sleep(400);

      // 2) 定位真正的编辑器（激活后出现），点本体落 caret（contenteditable + data-tribute 不能靠 activeElement）
      const editorJs = `(function(){
        var el = document.querySelector('#content-textarea') || document.querySelector('.engage-bar.active [contenteditable="true"]') || document.querySelector('.engage-bar [contenteditable="true"]');
        if (!el) return JSON.stringify({error:'no-editor'});
        var r = el.getBoundingClientRect();
        return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});
      })()`;
      const editorRaw = await evalRaw<string>(this.deps.cdp, editorJs);
      const editor = typeof editorRaw === 'string' ? JSON.parse(editorRaw) : editorRaw;
      if (editor?.error) {
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'no_target' });
        return;
      }
      await dispatchClick(this.deps.cdp, editor.x, editor.y, { random: this.random });
      await this.sleep(250);

      // 3) 拟人逐字输入正文（文字部分手动输入）
      await dispatchKeystrokes(this.deps.cdp, body, { random: this.random });
      // 3b) 联系方式（change account-group-chat-injection）：串码部分**单次整段插入**（Input.insertText），
      //     绕过逐字输入会触发的 @/# 提及/主题补全劫持；verbatim，不 trim/不逐字敲。追加「换行 + 联系方式」，
      //     与云端人审卡展示的合并终稿一致（AC-PUB 审=发）。缺省则不插、行为与今天一致。
      const code = (contactInfo ?? '').length > 0 ? contactInfo! : '';
      if (code) {
        await this.sleep(300); // 敲完正文到粘联系方式之间的自然停顿
        await insertText(this.deps.cdp, `\n${code}`);
        this.logger(`[browse] comment 联系方式整段插入（${code.length} 字，绕过逐字补全）`);
      }
      // 注：敲完正文到发送之间的「子步骤微停顿」由上面 3) 的逐字输入 / 3b) 的粘码前 sleep(300) 承载（保留）；
      // 引导性停顿已上移到命令入口 gateBeforeAction（最小间隔，max 非累加），此处不再叠一段——避免操作后兜底累加（设计 §3.3）。

      // 4) 提交前 fresh 复检验证码（最高风险写互动，务必复检）
      if (await this.captchaPresentFresh()) {
        this.logger('[browse] comment 提交前复检到验证码/未知阻断弹窗，放弃发送');
        await evalRaw(this.deps.cdp, `(function(){var el=document.querySelector('#content-textarea')||document.querySelector('.engage-bar.active [contenteditable="true"]');if(el){el.textContent='';el.dispatchEvent(new Event('input',{bubbles:true}));}return 'ok';})()`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'blocked_by_captcha' });
        return;
      }

      // 5) 定位提交键并点击（有效内容后 .gray 消失）
      const submitJs = `(function(){
        var btn = document.querySelector('.engage-bar.active button.btn.submit') || document.querySelector('.engage-bar button.btn.submit');
        if (!btn) return JSON.stringify({error:'no-submit'});
        var r = btn.getBoundingClientRect();
        return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});
      })()`;
      const submitRaw = await evalRaw<string>(this.deps.cdp, submitJs);
      const submit = typeof submitRaw === 'string' ? JSON.parse(submitRaw) : submitRaw;
      if (submit?.error) {
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'no_target' });
        return;
      }
      await dispatchClick(this.deps.cdp, submit.x, submit.y, { random: this.random });

      // 6) 后置校验：轮询「编辑器清空 且 自己的评论作为顶部新行出现」，命中即返回、上限 2000ms
      //    （取代固定 sleep(2000)；发评论生效多在 1s 内，快路径省 ~1s）。
      const snippet = body.slice(0, 12);
      const verifyJs = `(function(){
        var snip = ${JSON.stringify(snippet)};
        var el = document.querySelector('#content-textarea') || document.querySelector('.engage-bar.active [contenteditable="true"]');
        var editorText = el ? (el.textContent || '').trim() : '';
        var rows = Array.prototype.slice.call(document.querySelectorAll('[id^="comment-"]'), 0, 3);
        var ownRow = rows.some(function(r){ return (r.textContent || '').indexOf(snip) >= 0; });
        var cleared = !editorText || editorText.indexOf(snip) < 0;
        return JSON.stringify({cleared: cleared, ownRow: ownRow});
      })()`;
      const vRaw = await this.pollDomUntil(verifyJs, (raw) => {
        try {
          const v = JSON.parse(raw);
          return !!(v?.cleared && v?.ownRow);
        } catch {
          return false;
        }
      }, 2000);
      const v = typeof vRaw === 'string' ? JSON.parse(vRaw) : vRaw;
      if (v?.cleared && v?.ownRow) {
        this.logger(`[browse] ✓ 评论发布成功（编辑器清空 + 自己的评论行出现，耗时 ${elapsed()}）`);
        this.deps.client.reportActionCompleted?.({ action, ok: true });
      } else {
        this.logger(`[browse] ⚠ 评论提交后未确认生效 (cleared=${v?.cleared}, ownRow=${v?.ownRow}，耗时 ${elapsed()})`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'state_unchanged' });
      }
    } catch (err) {
      this.logger(`[browse] comment 执行失败（耗时 ${elapsed()}）：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action, ok: false, reason: (err as Error).message });
    }
  }

  /**
   * 执行关注操作。Cloud 已做出决策，Edge 直接执行。
   */
  /**
   * note.open 时探测笔记 modal 作者区关注按钮当下真实态（change skip-profile-visit-if-followed）。
   * 复用 executeFollow 的选择器与「已关注/互关/aria-pressed」判定，逐字镜像其扫描顺序：
   * 对 executeFollow 会判「已关注」的同一元素返回 true，会去点击（未关注）的返回 false。
   * 无按钮 / 读取失败 / 异常 → false（falsy），云端据此回退原主页评估流程。
   * 边缘只读取平台当下信号上报、不臆造（红线：MUST NOT 静默假成功）。
   */
  private async probeAuthorFollowed(): Promise<boolean> {
    try {
      const js = `(function(){
        var selectors = ${JSON.stringify(FOLLOW_BUTTON_SELECTORS)};
        for (var s of selectors) {
          var el = document.querySelector(s);
          if (el) {
            var text = el.textContent || '';
            var pressed = el.getAttribute('aria-pressed') === 'true';
            if (text.includes('已关注') || text.includes('互关') || pressed) return JSON.stringify({followed:true});
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return JSON.stringify({followed:false});
          }
        }
        return JSON.stringify({followed:false});
      })()`;
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      const raw = await evalRawFn<string>(this.deps.cdp, js);
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return result?.followed === true;
    } catch {
      return false;
    }
  }

  private async executeFollow(): Promise<void> {
    try {
      const js = `(function(){
        // 关注按钮两种上下文：笔记 modal 内 .author-wrapper .follow-button；作者主页 .user-info .follow-button
        // （真实小红书主页按钮为 button.reds-button-new.follow-button）。bare .follow-button 兜底两者。
        var selectors = ${JSON.stringify(FOLLOW_BUTTON_SELECTORS)};
        for (var s of selectors) {
          var el = document.querySelector(s);
          if (el) {
            var text = el.textContent || '';
            var pressed = el.getAttribute('aria-pressed') === 'true';
            if (text.includes('已关注') || text.includes('互关') || pressed) return JSON.stringify({already:true});
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});
          }
        }
        return JSON.stringify({error:'no-btn'});
      })()`;
      const { evalRaw: evalRawFn, dispatchClick } = await import('./cdp-util.js');
      const raw = await evalRawFn<string>(this.deps.cdp, js);
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result?.already) {
        // 已关注：目标状态（已关注）本就达成 —— 良性 no-op 成功，而非失败。
        // 以 ok:true + reason:'already_followed' 上报；云端据 reason 区分"真实新关注"（不带 reason）与"已关注 no-op"。
        this.logger(`[browse] ✓ 已关注（无需重复关注）`);
        this.deps.client.reportActionCompleted?.({ action: 'follow', ok: true, reason: 'already_followed' });
        return;
      }
      if (result?.error) {
        const reason = `btn_${result.error}`;
        this.logger(`[browse] 关注失败: ${reason}`);
        this.deps.client.reportActionCompleted?.({ action: 'follow', ok: false, reason });
        return;
      }
      // 点击前 fresh 复检验证码（fail-CLOSED）：引导性停顿已上移到命令入口 gateBeforeAction（max 非累加），此处不再叠停顿。
      if (await this.captchaPresentFresh()) {
        this.logger('[browse] follow 提交前复检到验证码/未知阻断弹窗，放弃点击');
        this.deps.client.reportActionCompleted?.({ action: 'follow', ok: false, reason: 'blocked_by_captcha' });
        return;
      }
      await dispatchClick(this.deps.cdp, result.x, result.y, { random: this.random });
      await this.sleep(1500);
      this.logger(`[browse] ✓ 关注成功 (${result.x}, ${result.y})`);
      this.deps.client.reportActionCompleted?.({ action: 'follow', ok: true });
    } catch (err) {
      this.logger(`[browse] 关注执行失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'follow', ok: false, reason: (err as Error).message });
    }
  }

  private async navigateBack(targetPage?: 'feed' | 'search', reason?: string): Promise<void> {
    // navigation.back 的协议名保留，但边缘语义改为「回到来源列表」：
    // 默认用 Page.navigate 直连 feed/search 来源页，避免 history.back 回踩过期详情路由并触发
    // 小红书 access-limit-app 弹窗；只有搜索来源 URL 缺失且当前仍像笔记浮层时，才允许历史兜底。
    const modalWasOpen = await this.deps.modalCtrl.isModalOpen();
    await this.safeCloseModal();
    const target: 'feed' | 'search' = targetPage === 'search' ? 'search' : 'feed';
    const wantSearch = target === 'search';
    // 熟悉度提速：返回到刚看过的 feed（back_to_feed）时，离页停留已由 ensureDetailDwell 治理，
    // 返回手势不必再全量犹豫 → 用更轻的手势停顿（scroll 档，中位 ~0.8s ≈ action 的 1/3，仍带抖动、非零、不秒退）。
    // 注：此处原误取 cardGapTiming（中位 5s，比 action 还重一倍，与注释本意相反）——快速返回反成最慢档，已修正为 scroll 档。
    const fastReturn = reason === 'back_to_feed' && !wantSearch;
    await this.humanPause(fastReturn ? this.scrollTiming : this.actionTiming);

    const recordedSearchUrl = wantSearch
      && this.sourceListPageType === 'search'
      && this.sourceListUrl
      && this.isSearchListUrl(this.sourceListUrl)
      ? this.sourceListUrl
      : null;
    const targetUrl = wantSearch ? recordedSearchUrl : this.exploreUrl;
    const targetWaitMs = wantSearch ? 5000 : 8000;
    const navigateToList = async (url: string): Promise<boolean> => {
      await this.deps.cdp.send('Page.navigate', { url });
      await this.waitForCards(10000);
      return this.waitForVisibleCards(targetWaitMs);
    };

    let landed = await this.evalUrl().catch(() => '');
    let ready = false;
    if (!this.isTargetListUrl(landed, target)) {
      if (targetUrl) {
        ready = await navigateToList(targetUrl);
      } else if (wantSearch && modalWasOpen) {
        this.logger('[browse] 搜索来源 URL 缺失，使用 history.back 健康校验兜底');
        await this.deps.cdp.send('Runtime.evaluate', { expression: 'history.back()' });
        await this.sleep(1200);
      } else {
        if (wantSearch) this.logger('[browse] 搜索来源 URL 缺失，回退 explore feed');
        ready = await navigateToList(this.exploreUrl);
      }
      landed = await this.evalUrl().catch(() => landed);
    }

    if (!ready && this.isTargetListUrl(landed, target)) {
      ready = await this.waitForVisibleCards(targetWaitMs);
    }
    if (!ready && targetUrl) {
      ready = await navigateToList(targetUrl);
      landed = await this.evalUrl().catch(() => landed);
    }
    // 健康校验安全网：search 来源不可达或历史兜底落到坏页时，最终回退 explore，保证闭环继续上报。
    if (!ready) {
      if (wantSearch) this.logger('[browse] 搜索结果列表不可达（来源 URL 缺失/页失效），回退 explore feed');
      await this.deps.cdp.send('Page.navigate', { url: this.exploreUrl });
      await this.waitForCards(10000);
      await this.waitForVisibleCards(5000);
    }
    await this.reportVisibleCards();
    this.deps.client.reportActionCompleted?.({ action: 'back', ok: true });
  }

  /**
   * 浏览笔记图片。count 由 Cloud 指定。
   *
   * 如实回报（不再用 `count||1` 兜底假报成功）：找不到图片轮播 → ok:false reason:'no_target'；
   * 命中 → ok:true reason:'browsed=N'（N 为实际浏览张数）。选择器对照真实小红书详情页 DOM，
   * 需本地核对校准（见 tasks 5.4）。
   */
  private async browseNoteImages(_noteId: string, count: number): Promise<void> {
    try {
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      // 探测图片轮播：返回 {total, hasNext}。真实小红书：真图用 .swiper-slide:not(.swiper-slide-duplicate)
      // 计数（swiper loop 会复制首尾），翻页箭头为 .arrow-controller.right（首图时左箭头带 .forbidden）。
      const probe = `(function(){
        var root = document.querySelector('.note-detail-mask') || document.querySelector('.note-container') || document;
        var real = root.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate)').length;
        var imgs = root.querySelectorAll('.note-slider-img, [class*="media"] img').length;
        var total = real || imgs;
        var next = root.querySelector('.arrow-controller.right, .swiper-button-next');
        return JSON.stringify({total: total, hasNext: !!(next && !/forbidden|disabled|hidden/.test(next.className || ''))});
      })()`;
      const raw = await evalRawFn<string>(this.deps.cdp, probe);
      const info = typeof raw === 'string' ? JSON.parse(raw) : { total: 0, hasNext: false };
      const total = Number(info.total) || 0;
      if (total <= 0) {
        this.logger('[browse] 未找到图片轮播，无图可浏览');
        this.deps.client.reportActionCompleted?.({ action: 'browse_images', ok: false, reason: 'no_target' });
        return;
      }
      const target = Math.max(1, Math.min(count, total));
      let viewed = 1;
      for (let i = 1; i < target; i++) {
        await this.humanPause(this.cardGapTiming);
        const clicked = await evalRawFn<boolean>(
          this.deps.cdp,
          `(function(){ var root = document.querySelector('.note-detail-mask') || document; var btn = root.querySelector('.arrow-controller.right, .swiper-button-next'); if(btn && !/forbidden|disabled/.test(btn.className || '')){ btn.click(); return true; } return false; })()`,
        );
        if (!clicked) break;
        viewed++;
        await this.sleep(800);
      }
      this.logger(`[browse] 浏览了 ${viewed}/${total} 张图片`);
      await this.reportCurrentNoteImageSnapshot(_noteId);
      this.deps.client.reportActionCompleted?.({ action: 'browse_images', ok: true, reason: `browsed=${viewed}` });
    } catch (err) {
      this.logger(`[browse] 浏览图片失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'browse_images', ok: false, reason: (err as Error).message });
    }
  }

  private async bringCommentAreaIntoReach(
    evalRawFn: (cdp: BrowseCdp, expression: string) => Promise<string>,
    maxSteps: number,
  ): Promise<boolean> {
    const steps = Math.max(COMMENT_PRELUDE_MIN_STEPS, Math.min(COMMENT_PRELUDE_MAX_STEPS, maxSteps));
    for (let i = 0; i < steps; i++) {
      const distance = this.variedScrollDistance(180, 340);
      const expr = `(function(){
        function pointFor(el){
          var r=el.getBoundingClientRect();
          var vw=document.documentElement.clientWidth||document.body.clientWidth||1280;
          var vh=document.documentElement.clientHeight||document.body.clientHeight||800;
          var left=Math.max(8, Math.min(vw-8, Math.max(r.left, 8)));
          var right=Math.max(8, Math.min(vw-8, Math.min(r.right, vw-8)));
          var top=Math.max(80, Math.min(vh-40, Math.max(r.top, 80)));
          var bottom=Math.max(80, Math.min(vh-40, Math.min(r.bottom, vh-40)));
          return {x:Math.round((left+right)/2),y:Math.round((top+bottom)/2)};
        }
        function visible(el){
          var r=el.getBoundingClientRect();
          var vh=document.documentElement.clientHeight||document.body.clientHeight||800;
          return r.bottom>80 && r.top<vh*0.92;
        }
        function seed(root){
          var sels=['[id^="comment-"]','.comment-item','[class*="comment-item"]','.comments-container','[class*="comments-container"]','[class*="comment-list"]','[class*="commentList"]'];
          for(var i=0;i<sels.length;i++){
            var el=(root||document).querySelector(sels[i]);
            if(el&&((el.textContent||'').trim().length>0||el.children.length>0)) return el;
          }
          return null;
        }
        function scrollable(el){
          var n=el;
          while(n&&n!==document.body&&n!==document.documentElement){
            var s=window.getComputedStyle(n);
            if(n.scrollHeight>n.clientHeight+8&&/(auto|scroll)/.test(s.overflowY)) return n;
            n=n.parentElement;
          }
          return null;
        }
        function fallback(root){
          var sels=['.note-scroller','[class*="note-scroller"]','[class*="scroller"]','.note-detail-mask','.note-container'];
          for(var i=0;i<sels.length;i++){
            var nodes=(root||document).querySelectorAll(sels[i]);
            for(var j=0;j<nodes.length;j++){
              var n=nodes[j], s=window.getComputedStyle(n);
              if(n.scrollHeight>n.clientHeight+8&&/(auto|scroll)/.test(s.overflowY)) return n;
            }
          }
          return document.scrollingElement||document.documentElement;
        }
        var root=document.querySelector('.note-detail-mask')||document.querySelector('.note-container')||document;
        var hit=seed(root);
        if(hit&&visible(hit)) return JSON.stringify({found:true,visible:true});
        var c=hit ? (scrollable(hit)||fallback(root)) : fallback(root);
        if(!c) return JSON.stringify({found:false,atBottom:true});
        var scrollTop=c.scrollTop||0;
        var hitAfter=seed(root);
        var p=pointFor(c);
        return JSON.stringify({
          found:!!hitAfter,
          visible:!!(hitAfter&&visible(hitAfter)),
          scrollTop:scrollTop,
          scrollHeight:c.scrollHeight,
          clientHeight:c.clientHeight,
          x:p.x,
          y:p.y,
          atBottom:scrollTop+c.clientHeight>=c.scrollHeight-24
        });
      })()`;
      const r = await this.inertialScrollByProbe(evalRawFn, expr, distance);
      if (r.found && r.visible !== false) return true;
      if (r.atBottom && !r.moved) return false;
      await this.humanPause(TIMING_PRESETS.scroll);
    }
    return false;
  }

  /**
   * 滚动评论区。count 由 Cloud 指定。
   *
   * 真执行 + 如实回报（不再"命中即假报成功"）：运行时按 overflow 能力上溯定位真正可滚动的评论容器，
   * 每次滚动记录前后 scrollTop——按实测位移回报：有位移→ok:true scrolled=N/total；命中但不可滚/已到底→
   * ok:false no_scroll；找不到可滚动容器→ok:false no_target。间隔用 scroll 预设（~0.4-2s）而非 cardGap。
   */
  private async scrollNoteComments(_noteId: string, count: number): Promise<void> {
    try {
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      const times = Math.max(1, count);
      await this.bringCommentAreaIntoReach(evalRawFn, Math.max(times + 2, Math.ceil(times * 1.5)));
      // 单次滚动：上溯找可滚动祖先（评论节点优先）→ 记录 before → feed 同款惯性 wheel → 复测 after。
      const scrollProbeExpr = `(function(){
        function pointFor(el){
          var r=el.getBoundingClientRect();
          var vw=document.documentElement.clientWidth||document.body.clientWidth||1280;
          var vh=document.documentElement.clientHeight||document.body.clientHeight||800;
          var left=Math.max(8, Math.min(vw-8, Math.max(r.left, 8)));
          var right=Math.max(8, Math.min(vw-8, Math.min(r.right, vw-8)));
          var top=Math.max(80, Math.min(vh-40, Math.max(r.top, 80)));
          var bottom=Math.max(80, Math.min(vh-40, Math.min(r.bottom, vh-40)));
          return {x:Math.round((left+right)/2),y:Math.round((top+bottom)/2)};
        }
        function scrollable(el){
          var n = el;
          while (n && n !== document.body && n !== document.documentElement){
            var s = window.getComputedStyle(n);
            if (n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(s.overflowY)) return n;
            n = n.parentElement;
          }
          return null;
        }
        var seed = document.querySelector('[id^="comment-"], .comment-item, [class*="comment-item"], .comments-container, [class*="comments-container"], [class*="comment-list"], [class*="commentList"]');
        var c = seed ? scrollable(seed) : null;
        if (!c) {
          var cands = document.querySelectorAll('.note-scroller, [class*="note-scroller"], [class*="scroller"], .comments-container, [class*="comments-container"], [class*="comment-list"], [class*="commentList"]');
          for (var i=0;i<cands.length;i++){
            var e=cands[i], s=window.getComputedStyle(e);
            if (e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(s.overflowY)) { c=e; break; }
          }
        }
        if (!c) return JSON.stringify({found:false});
        var p=pointFor(c);
        return JSON.stringify({found:true, scrollTop:c.scrollTop||0, scrollHeight:c.scrollHeight, clientHeight:c.clientHeight, x:p.x, y:p.y});
      })()`;
      let anyFound = false;
      let moved = 0;
      // 跨屏累计去重：逐屏抽取候选按锚点合并，不再只取终态一屏；首屏也抓，故短评论区
      // （no_scroll）/ 无可滚容器（no_target）时仍带回当前可见评论。best-effort，有界。
      const acc = new Map<string, CommentCandidate>();
      const HARVEST_CAP = 40;
      const mergeHarvest = async (): Promise<void> => {
        if (acc.size >= HARVEST_CAP) return;
        for (const c of await this.harvestCommentCandidates()) {
          if (!acc.has(c.anchorId)) acc.set(c.anchorId, c);
          if (acc.size >= HARVEST_CAP) break;
        }
      };
      for (let i = 0; i < times; i++) {
        await this.humanPause(this.scrollTiming);
        // 先抓当前（已 settle 的）本屏候选再滚动：i=0 抓首屏，之后每屏累计。
        await mergeHarvest();
        const r = await this.inertialScrollByProbe(evalRawFn, scrollProbeExpr, this.variedScrollDistance());
        if (r.found) {
          anyFound = true;
          if (typeof r.after === 'number' && typeof r.before === 'number' && r.after > r.before) moved++;
        }
      }
      // 末屏渲染门：仅当真滚动过（moved>0）才 settle 再抓一次，接住最后一次滚动懒加载的评论；
      // no_target/no_scroll 无更多可加载，用循环内已累计的候选即可，不白等一拍。
      if (moved > 0) {
        await this.humanPause(this.scrollTiming);
        await mergeHarvest();
      }
      const candidates = [...acc.values()];
      if (!anyFound) {
        this.logger(`[browse] 未找到可滚动的评论区容器（仍抓到可见评论 ${candidates.length} 条随回执带回）`);
        this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: false, reason: 'no_target', candidates });
        return;
      }
      if (moved === 0) {
        this.logger(`[browse] 评论区命中但未发生位移（已到底/不可滚，0/${times}；抓到可见评论 ${candidates.length} 条）`);
        this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: false, reason: 'no_scroll', candidates });
        return;
      }
      this.logger(`[browse] 评论区已滚动 ${moved}/${times} 次（实测位移，累计候选 ${candidates.length} 条）`);
      this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: true, reason: `scrolled=${moved}/${times}`, candidates });
    } catch (err) {
      this.logger(`[browse] 滚动评论失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: false, reason: (err as Error).message });
    }
  }

  /**
   * 终态视口快照：抽取当前视口内的评论候选 {anchorId, author?, text, alreadyLiked}，供云端 comment_like_appraiser 评估。
   * 只取视口内行（锚点最新鲜，bound no_target 率）；alreadyLiked 由该行赞控件 svg use===#liked 判定（供云端预过滤）。
   * best-effort：任何异常返回空数组（云端据此弃权，绝不编造目标）。
   */
  private async harvestCommentCandidates(): Promise<CommentCandidate[]> {
    try {
      const harvestJs = `(function(){
        var rows = Array.prototype.slice.call(document.querySelectorAll('[id^="comment-"]'));
        var out = [];
        for (var i = 0; i < rows.length && out.length < 12; i++){
          var r = rows[i];
          var rect = r.getBoundingClientRect();
          if (rect.bottom < -100 || rect.top > window.innerHeight + 100) continue; // 仅视口内（含少量缓冲）
          var lw = r.querySelector('.interactions .like .like-wrapper') || r.querySelector('.like-wrapper');
          var use = lw ? lw.querySelector('svg use') : null;
          var href = use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : null;
          var lcEl = lw ? (lw.querySelector('[class*="count"]') || lw) : null;
          var likeText = lcEl ? (lcEl.textContent || '').replace(/\\s+/g, ' ').trim() : '';
          var authorEl = r.querySelector('.author .name, [class*="author"] [class*="name"], [class*="nickname"], [class*="name"]');
          var contentEl = r.querySelector('.content, [class*="content"], .note-text, p');
          // 保留换行：真页面 innerText 把 <br>/块级边界映射为换行；只压换行以外的空白（\\s+ 会抹平段落）。
          var srcEl = contentEl || r;
          var rawText = (srcEl.innerText || srcEl.textContent || '');
          var text = rawText.replace(/[^\\S\\n]+/g, ' ').replace(/ *\\n */g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 80);
          if (!text) continue;
          out.push({
            anchorId: r.id,
            author: authorEl ? (authorEl.textContent || '').trim().slice(0, 30) : undefined,
            text: text,
            alreadyLiked: href === '#liked',
            likeText: likeText
          });
        }
        return JSON.stringify(out);
      })()`;
      const raw = await evalRaw<string>(this.deps.cdp, harvestJs);
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(arr)) return [];
      // 解析评论赞数（「1.2万」等惯例 → 数字；抓不到为 undefined，不编造）。change curated-inspiration-corpus Phase 2b。
      return (arr as Array<{ anchorId: string; author?: string; text: string; alreadyLiked?: boolean; likeText?: string }>).map((c) => ({
        anchorId: c.anchorId,
        author: c.author,
        text: c.text,
        alreadyLiked: c.alreadyLiked,
        likeCount: c.likeText ? parseCount(c.likeText) : undefined,
      }));
    } catch (err) {
      this.logger(`[browse] 评论候选抽取失败（不影响滚动回执）：${(err as Error).message}`);
      return [];
    }
  }

  /**
   * 导航到通知首页并上报各类未读快照（notification.home），喂给云端分诊。
   * 选择器 best-effort、待真机校准。失败也上报全 0（不静默吞），使分诊能判"无未读"收尾。
   */
  private async openNotificationsHome(): Promise<void> {
    try {
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      await evalRawFn<boolean>(
        this.deps.cdp,
        `(function(){ var a = document.querySelector('a[href*="/notification"]'); if(a){ a.click(); return true; } return false; })()`,
      );
      await this.sleep(1200);
      // per-tab 未读：复用入口探测同源的结构判据（buildNotificationHomeJs，单一真相），仅作用在真实分类 tab、
      // 只认纯数字角标——绝不沿用 6.5.3 删掉的宽选择器假阳性源（详见该 builder 注释）。
      const raw = await evalRawFn<string>(this.deps.cdp, buildNotificationHomeJs());
      const home = typeof raw === 'string' ? JSON.parse(raw) : { comments: 0, likes: 0, follows: 0 };
      this.deps.client.send?.('notification.home', home);
      this.logger(`[browse] notification.home: 评论${home.comments} 赞藏${home.likes} 关注${home.follows}（无数字红点的 tab 待真机校准）`);
    } catch (err) {
      if (err instanceof CdpDisconnectedError) throw err; // 断连不当业务失败：冒泡到主循环重连，绝不假报「无未读」
      this.logger(`[browse] notification.open 失败（上报全 0 以便分诊收尾）：${(err as Error).message}`);
      this.deps.client.send?.('notification.home', { comments: 0, likes: 0, follows: 0 });
    }
  }

  /**
   * 进「评论和@」分类、**滚到底**加载、抽取原始评论/@ 项，经 notification.items 上报。
   * 边缘只产出原始项；是否值得通知由云端判。选择器 best-effort、待真机校准；失败上报空 items（不静默吞）。
   *
   * 滚动策略（change notification-clear-to-zero）：滚到底 / 直到不再有新项（连续 STABLE_ROUNDS 次评论行数不增），
   * 有界兜底 HARD_CAP——替代旧的「固定 scrollMax 屏」：未读条数多于一屏时固定屏数会遗留未清，破坏「清零」前提。
   * scrollMax 由云端下发，此处当作硬上限的下限参考（实际上限取 max(scrollMax, HARD_CAP_FLOOR)）。
   */
  private async browseNotificationComments(scrollMax: number): Promise<void> {
    try {
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      await evalRawFn<boolean>(
        this.deps.cdp,
        // 真机校准（2026-06-24）：真实分类 tab = [class*="tab-item"]（叶子），点它而非全页文本匹配（避免点到包裹容器）。
        `(function(){ var els = Array.from(document.querySelectorAll('[class*="tab-item"]')); for (var i=0;i<els.length;i++){ var t=(els[i].textContent||'').trim(); if(t==='评论和@' || (/^评论/.test(t) && t.indexOf('@')>=0)){ els[i].click(); return true; } } return false; })()`,
      );
      await this.sleep(800);
      // 滚到底：连续 STABLE_ROUNDS 次评论行数不增即判到底；HARD_CAP 防异常无限滚（诚实有界）。
      const COUNT_JS = `document.querySelectorAll('.tabs-content-container > .container').length`;
      const SCROLL_JS = `(function(){ window.scrollBy(0, document.documentElement.clientHeight*0.8); return true; })()`;
      const HARD_CAP = Math.max(scrollMax, 12);
      const STABLE_ROUNDS = 2;
      let lastCount = -1;
      let stable = 0;
      for (let i = 0; i < HARD_CAP; i++) {
        const count = await evalRawFn<number>(this.deps.cdp, COUNT_JS).catch(() => lastCount);
        if (count > lastCount) {
          lastCount = count;
          stable = 0;
        } else if (++stable >= STABLE_ROUNDS) {
          break; // 连续无新项 → 到底
        }
        await evalRawFn<boolean>(this.deps.cdp, SCROLL_JS);
        await this.sleep(600);
      }
      // 抽取 JS 抽成单一真相 builder（含 code-point 安全截断 / 正文缺失发空串 / itemKey 排除 profile 链，
      // 详见 buildNotificationItemsJs 注释）；选择器本身待真机校准 item(a)。
      const raw = await evalRawFn<string>(this.deps.cdp, buildNotificationItemsJs());
      const items = typeof raw === 'string' ? JSON.parse(raw) : [];
      this.deps.client.send?.('notification.items', { items });
      this.logger(`[browse] notification.items: 上报 ${Array.isArray(items) ? items.length : 0} 条评论/@（选择器待真机校准）`);
    } catch (err) {
      if (err instanceof CdpDisconnectedError) throw err; // 断连不当业务失败：冒泡到主循环重连，绝不假报「空 items」
      this.logger(`[browse] notification.browse_comments 失败（上报空 items 以便云端收尾）：${(err as Error).message}`);
      this.deps.client.send?.('notification.items', { items: [] });
    }
  }

  /**
   * 进「赞和收藏」/「新增关注」分类：清未读 + 抽取发送者经 notification.items 上报（change notification-contact-registry）。
   * 清零仍是首要目的（保 notification-clear-to-zero 语义）；发送者抽取是清零旁路只读输出，抽取失败绝不阻断清零回执。
   * 选择器 best-effort、待真机校准；点击未命中如实 no_target（绝不静默假报已看）。
   */
  private async viewNotificationCategory(kind: 'likes' | 'follows'): Promise<void> {
    const action = kind === 'likes' ? 'browse_notification_likes' : 'browse_notification_follows';
    try {
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      const labelRe = kind === 'likes' ? '赞|收藏' : '关注|粉丝';
      // 捕获点击命中布尔：未命中分类 tab（选择器漂移/页面未渲染/单合并 tab）→ 诚实 no_target，
      // **绝不**像旧码那样丢弃返回值、无条件报 viewed（那是静默假成功，且掩盖了 6.5.4 本要暴露的选择器漂移）。
      const clicked = await evalRawFn<boolean>(
        this.deps.cdp,
        // 真机校准（2026-06-24）：分类 tab = [class*="tab-item"]（叶子，文本如「赞和收藏1」含角标数字故放宽到 <=8）。
        `(function(){ var els = Array.from(document.querySelectorAll('[class*="tab-item"]')); for (var i=0;i<els.length;i++){ var t=(els[i].textContent||'').trim(); if(t.length<=8 && new RegExp('${labelRe}').test(t)){ els[i].click(); return true; } } return false; })()`,
      );
      if (!clicked) {
        this.logger(`[browse] ${action}: 未找到分类 tab（no_target，不假报已看）`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'no_target' });
        return;
      }
      await this.sleep(800);
      // 滚动加载更多发送者（有界）+ 清未读：连续 STABLE_ROUNDS 行数不增即到底，HARD_CAP 诚实有界（同评论栏策略）。
      const COUNT_JS = `document.querySelectorAll('.tabs-content-container > .container').length`;
      const SCROLL_JS = `(function(){ window.scrollBy(0, document.documentElement.clientHeight*0.8); return true; })()`;
      const HARD_CAP = 12;
      const STABLE_ROUNDS = 2;
      let lastCount = -1;
      let stable = 0;
      for (let i = 0; i < HARD_CAP; i++) {
        const count = await evalRawFn<number>(this.deps.cdp, COUNT_JS).catch(() => lastCount);
        if (count > lastCount) {
          lastCount = count;
          stable = 0;
        } else if (++stable >= STABLE_ROUNDS) {
          break;
        }
        await evalRawFn<boolean>(this.deps.cdp, SCROLL_JS);
        await this.sleep(600);
      }
      // 抽取发送者（点赞/收藏 或 关注）→ notification.items（云端沉淀进通知联系人名册）。
      // best-effort、待真机校准；抽取失败只记日志、绝不阻断下方清零回执（清零是首要目的）。
      try {
        const raw = await evalRawFn<string>(this.deps.cdp, buildNotificationCategoryItemsJs(kind));
        const items = typeof raw === 'string' ? JSON.parse(raw) : [];
        this.deps.client.send?.('notification.items', { items });
        this.logger(`[browse] ${action}: 抽取上报 ${Array.isArray(items) ? items.length : 0} 个发送者（选择器待真机校准）`);
      } catch (exErr) {
        if (exErr instanceof CdpDisconnectedError) throw exErr; // 断连冒泡重连，绝不假报
        this.logger(`[browse] ${action}: 发送者抽取失败（不阻断清零）：${(exErr as Error).message}`);
      }
      this.logger(`[browse] ${action}: 已查看（清未读）`);
      this.deps.client.reportActionCompleted?.({ action, ok: true, reason: 'viewed' });
    } catch (err) {
      if (err instanceof CdpDisconnectedError) throw err; // 断连不当业务失败：冒泡到主循环重连，绝不假报「已看」
      this.logger(`[browse] ${action} 失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action, ok: false, reason: (err as Error).message });
    }
  }

  /**
   * 进入作者主页并抽取作者资料（作品数/粉丝数），经 profile.detail 上报。
   *
   * 取代被静默丢弃的 open_note{type:'profile'}：点击详情页作者头像/名字进入主页、等渲染、抽数字。
   * 抽取失败/超时仍上报（extracted:false），让云端 FollowAgent 保守 skip 而非把缺失当真 0 粉丝；
   * 并兜底返回信息流不卡死。选择器需本地核对校准（见 tasks 6.5）。
   */
  private async openAuthorProfile(authorId?: string, direct?: boolean): Promise<void> {
    const { evalRaw: evalRawFn } = await import('./cdp-util.js');
    try {
      let url: string;
      if (direct && authorId) {
        // 云端直驱（change account-real-nickname）：直接导航到指定 profile id、不抓取当前页第一个作者链。
        // 边缘纯执行——不判定「这是不是自己」（云端独知）；下游 waitForProfile/抽取/上报与点头像进入完全一致。
        url = `https://www.xiaohongshu.com/user/profile/${authorId}`;
      } else {
        // 1) 在详情页定位作者主页链接 a[href*="/user/profile/"]（真实小红书 a.link-wrapper）。
        // 合成点击不一定触发 SPA 路由跳转，故读出 href 后用 Page.navigate 直达主页
        // （手动核对该 URL 能正常渲染 .user-interactions）。
        const probe = `(function(){
          var sels = ['.note-detail-mask a[href*="/user/profile/"]', '.author-wrapper a[href*="/user/profile/"]', 'a[href*="/user/profile/"]'];
          for (var i=0;i<sels.length;i++){ var el=document.querySelector(sels[i]); if(el){ var h=el.getAttribute('href'); if(h) return JSON.stringify({href:h}); } }
          return JSON.stringify({error:'no_author'});
        })()`;
        const raw = await evalRawFn<string>(this.deps.cdp, probe);
        const info = typeof raw === 'string' ? JSON.parse(raw) : { error: 'no_author' };
        if (info.error || !info.href) {
          this.logger('[browse] profile.open: 未找到作者主页链接');
          this.reportProfileFallback(authorId);
          return;
        }
        url = String(info.href).startsWith('http') ? String(info.href) : `https://www.xiaohongshu.com${info.href}`;
      }
      await this.humanPause(this.actionTiming);
      await this.deps.cdp.send('Page.navigate', { url });

      // 2) 等待作者主页渲染
      if (!(await this.waitForProfile(8000))) {
        this.logger('[browse] profile.open: 作者主页未在超时内渲染');
        this.reportProfileFallback(authorId);
        return;
      }

      // 主页链接（change interaction-feed-enrichment）：取落地地址栏 URL；仅当确是 /user/profile/ 才作可点链接（诚实置空）。
      const landedUrl = await this.evalUrl();
      const profileUrl = landedUrl.includes('/user/profile/') ? landedUrl : undefined;

      // 3) 抽取作者资料
      const profile = await this.extractAuthorProfile();
      const resolvedId = profile.authorId || authorId || '';
      const nickname = profile.nickname || undefined; // 抓不到则不带（诚实置空）
      if (profile.extracted) {
        this.logger(`[browse] profile.open: 作者资料 粉丝${profile.followersCount} 获赞与收藏${profile.likesCollects}（作品数主页不公开）${nickname ? ' 昵称「' + nickname + '」' : ''}`);
        this.deps.client.reportProfileDetail?.({
          authorId: resolvedId,
          postsCount: profile.postsCount,
          followersCount: profile.followersCount,
          likesCollects: profile.likesCollects,
          extracted: true,
          ...(nickname ? { nickname } : {}),
          ...(profileUrl ? { url: profileUrl } : {}),
        });
      } else {
        // 数字未渲染，但昵称/主页链接可能已抽到（change account-real-nickname：昵称读与数字渲染门解耦）——
        // 仍把昵称/url 带回（extracted:false、计数置 0），使本人主页昵称采集不被数字门卡空。
        this.logger(`[browse] profile.open: 进了主页但未抽到作品/粉丝数${nickname ? '（仍带回昵称「' + nickname + '」）' : ''}`);
        this.deps.client.reportProfileDetail?.({
          authorId: resolvedId,
          postsCount: 0,
          followersCount: 0,
          likesCollects: 0,
          extracted: false,
          ...(nickname ? { nickname } : {}),
          ...(profileUrl ? { url: profileUrl } : {}),
        });
      }
    } catch (err) {
      this.logger(`[browse] profile.open 失败：${(err as Error).message}`);
      this.reportProfileFallback(authorId);
    }
  }

  /** 作者资料不可用时上报 extracted:false，供云端区分"数据缺失"与"真 0 粉丝"。 */
  private reportProfileFallback(authorId?: string): void {
    this.deps.client.reportProfileDetail?.({
      authorId: authorId ?? '',
      postsCount: 0,
      followersCount: 0,
      likesCollects: 0,
      extracted: false,
    });
  }

  /** 轮询等待作者主页渲染（URL 含 /user/profile/ 或主页 DOM 出现）。 */
  private async waitForProfile(timeout: number): Promise<boolean> {
    const { evalRaw: evalRawFn } = await import('./cdp-util.js');
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const url = await this.evalUrl();
        if (url.includes('/user/profile/')) return true;
        const hasDom = await evalRawFn<boolean>(
          this.deps.cdp,
          `!!document.querySelector('.user-page, .user-info, [class*="userPage"], [class*="userInfo"]')`,
        );
        if (hasDom === true) return true;
      } catch {
        /* ignore，下一轮重试 */
      }
      await this.sleep(400);
    }
    return false;
  }

  /** 从作者主页抽取粉丝数 / 获赞与收藏数（作品数主页不公开，恒 0）+ 真实昵称。复用 parseCount 解析中文计数。 */
  private async extractAuthorProfile(): Promise<{ authorId: string; postsCount: number; followersCount: number; likesCollects: number; nickname: string; extracted: boolean }> {
    const { evalRaw: evalRawFn } = await import('./cdp-util.js');
    const js = `(function(){
      function txt(el){return (el&&el.textContent||'').replace(/\\s+/g,' ').trim();}
      var followers=null, posts=null, lc=null;
      var blocks = document.querySelectorAll('.user-interactions > div, .interaction-item, [class*="userInteraction"] > div, [class*="interactionItem"]');
      for (var i=0;i<blocks.length;i++){
        var label = txt(blocks[i]);
        var numEl = blocks[i].querySelector('.count, [class*="count"]') || blocks[i];
        var num = txt(numEl);
        if (/粉丝/.test(label)) followers = num;
        if (/笔记|作品/.test(label)) posts = num;
        if (/获赞|收藏/.test(label)) lc = num; // 获赞与收藏：主页真实提供的质量信号（不会误命中 关注/粉丝）
      }
      // 真实昵称（change interaction-feed-enrichment）：主页显示名；抓不到留空（诚实置空，云端不伪造）。
      var name = txt(document.querySelector('.user-name, .user-nickname, [class*="userName"], [class*="nickname"], .user-info .name'));
      // 标题兜底（change account-real-nickname）：本人主页 document.title 形如「<昵称> - 小红书」，去尾取昵称；
      // 使昵称不依赖 .user-interactions 数字渲染即可采到（与数字门解耦）。
      if(!name){ var t=(document.title||'').replace(/\\s*-\\s*小红书\\s*$/,'').replace(/\\s+/g,' ').trim(); if(t) name=t; }
      var idm = location.href.match(/\\/user\\/profile\\/([A-Za-z0-9]+)/);
      return JSON.stringify({authorId: idm?idm[1]:'', followers: followers, posts: posts, lc: lc, name: name});
    })()`;
    const { parseCount } = await import('./note-extractor.js');
    // Page.navigate 整页加载后 .user-interactions 数据异步晚到：轮询等出数再抽（最多 5s），
    // 避免"进了主页但抽到空"。
    const deadline = this.now() + 5000;
    let lastId = '';
    let lastName = '';
    for (;;) {
      try {
        const raw = await evalRawFn<string>(this.deps.cdp, js);
        const info = typeof raw === 'string' ? JSON.parse(raw) : {};
        if (info.authorId) lastId = info.authorId;
        if (typeof info.name === 'string' && info.name) lastName = info.name;
        const hasFollowers = info.followers != null && info.followers !== '';
        const hasPosts = info.posts != null && info.posts !== '';
        const hasLc = info.lc != null && info.lc !== '';
        if (hasFollowers || hasPosts || hasLc) {
          return {
            authorId: info.authorId || '',
            postsCount: hasPosts ? parseCount(String(info.posts)) : 0,
            followersCount: hasFollowers ? parseCount(String(info.followers)) : 0,
            likesCollects: hasLc ? parseCount(String(info.lc)) : 0,
            nickname: typeof info.name === 'string' ? info.name : '',
            extracted: true,
          };
        }
      } catch {
        /* ignore，下一轮重试 */
      }
      if (this.now() >= deadline) break;
      await this.sleep(500);
    }
    // 昵称与数字门解耦（change account-real-nickname）：数字 5s 未渲染时，仍把轮询中读到的昵称带回
    // （extracted:false 不变，供云端区分「数据缺失」与「真 0 粉丝」），否则本人主页采集每次都被数字门卡空。
    return { authorId: lastId, postsCount: 0, followersCount: 0, likesCollects: 0, nickname: lastName, extracted: false };
  }

  private async safeCloseModal(): Promise<void> {
    try {
      if (await this.deps.modalCtrl.isModalOpen()) {
        await this.deps.modalCtrl.closeModal();
        await this.humanPause(this.actionTiming);
      }
    } catch (err) {
      this.logger(`[browse] 关闭 modal 失败：${(err as Error).message}`);
    }
  }

  /**
   * 弹窗闸门：检测到阻断弹窗（登录/验证码/未知阻断）时**暂停所有操作**，轮询等其消失后恢复。
   *
   * - 优先读 overlayMonitor 的**缓存状态**（零 CDP、零网络）；其旁路 loop 已在并行持续判类。
   *   未注入 overlayMonitor 时回退到 legacy loginGate.isOpen() 内联探测；两者都没有则 no-op。
   * - 出现 / 消失各只记一次日志（blockingOverlayActive 状态翻转才打），不刷屏。
   * - 等待期间响应 stopRequested，避免 session.end / 本地 stop 被弹窗卡死。
   *   注意：调用方须保证 session.end 等终止命令不经过本闸门（见 executeCommand）。
   * - captcha/unknown 的**云端上报**不在此处——由 overlayMonitor 的 onTransition 回调负责（见 main.ts），
   *   闸门只管「停手」，与「通知」解耦。
   */
  private async waitWhileBlocked(): Promise<void> {
    const monitor = this.deps.overlayMonitor;
    const gate = this.deps.loginGate;
    if (!monitor && !gate) return;
    // 退出条件除 stopRequested 外，还包含"队列已有 session.end"——否则弹窗常驻时
    // 云端 session.end 进队列却无人消费，闸门永远轮询 → 死锁（见 terminatePending 注释）。
    //
    // 第三个出口 = 任务接管（change lease-strict-preemption，治硬死锁）：
    // 本闸门是 executeCommand 的第一句、排在任何页面写之前——停在这里的命令**一个字节都没写过页面**。
    // 但交接（quiesceForTask）等的是「命令处理函数还没返回」，于是它无界地等一条正在等验证码的命令，
    // 而那个验证码只有这次交接要授予的 system_recovery 协助任务才能点掉 → 闭环死锁，整台机器停摆。
    // 故：接管信号到达即抛出，命令零副作用作废、当场让路。**绝不能只 return**——那会让命令继续往下
    // 对着验证码墙点击。
    while (!this.stopRequested && !this.terminatePending()) {
      this.throwIfTakeover();
      let blocked = false;
      let kind: OverlayKind = 'none';
      if (monitor) {
        kind = monitor.state; // 读缓存，不打 CDP
        blocked = isBlockingKind(kind);
      } else if (gate) {
        try {
          blocked = await gate.isOpen();
        } catch (err) {
          // legacy 探测失败按"未弹出"处理（fail-open，与历史一致），不误暂停浏览。
          this.logger(`[browse] 登录弹窗检测失败（按未弹出处理）：${(err as Error).message}`);
          blocked = false;
        }
        kind = blocked ? 'login' : 'none';
      }
      if (!blocked) {
        if (this.blockingOverlayActive) {
          this.blockingOverlayActive = false;
          this.logger('[browse] 阻断弹窗已消失，恢复浏览');
        }
        return;
      }
      if (!this.blockingOverlayActive) {
        this.blockingOverlayActive = true;
        const label = kind === 'captcha' ? '验证码' : kind === 'unknown' ? '未知阻断' : '登录';
        this.logger(`[browse] 检测到${label}弹窗，暂停操作，等待处理…`);
      }
      // 可打断 sleep：交接推进世代号后会立刻唤醒，无需干等满一个轮询周期（2s）。
      await this.sleepInterruptible(this.loginGatePollMs);
    }
    // 循环因 stopRequested / 终止命令退出时也要认接管——避免刚被接管的命令继续往下写页面。
    this.throwIfTakeover();
  }

  /**
   * 高风险动作（like/collect/follow）提交前的 fresh 复检。
   *
   * 旁路缓存可能过期约一个 poll 周期：闸门放行后、真正点击前的 humanPause 窗口里若弹出验证码，
   * 仅靠缓存会漏过。故在 dispatchClick 前就地再探一次：命中 captcha/unknown 即放弃点击。
   * 复检的 CDP 失败按"有挑战"保守处理（fail-CLOSED）——错过一次点赞很便宜，点进风控墙很贵。
   * 未注入 overlayMonitor 时恒返回 false（不改变 legacy 行为）。
   */
  private async captchaPresentFresh(): Promise<boolean> {
    const monitor = this.deps.overlayMonitor;
    if (!monitor) return false;
    try {
      const kind = await monitor.probeNow();
      return kind === 'captcha' || kind === 'unknown';
    } catch {
      return true; // fresh 探测失败 → 保守当成有挑战，不点
    }
  }
}
