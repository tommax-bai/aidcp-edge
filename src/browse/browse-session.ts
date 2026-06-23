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
} from '../comm/protocol.js';
import type { ActionResultPayload, CommentCandidate } from '../comm/protocol.js';
import type { FeedScroller, NoteCard } from './feed-scroller.js';
import type { ModalController } from './modal-controller.js';
import type { LoginModalWatcher } from './login-modal-watcher.js';
import type { OverlayKind, OverlayMonitor } from './overlay-monitor.js';
import { isBlockingKind } from './overlay-monitor.js';
import type { extractNoteContent as ExtractFn } from './note-extractor.js';
import { NOTE_BODY_SELECTORS } from './note-extractor.js';
import { executeSearch } from './search-handler.js';
import { evalRaw, type RandomFn, type BrowseCdp } from './cdp-util.js';
import { CdpDisconnectedError } from '../cdp/client.js';
import type { DomProvider } from '../locating/engine.js';
import {
  sampleDelay,
  jitterAround,
  TIMING_PRESETS,
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
  /** 首屏扫描前等待 feed 卡片渲染的最长轮询时间（毫秒，默认 12000） */
  initialScanTimeoutMs?: number;
  /** 登录弹窗闸门的轮询间隔（毫秒，默认 2000）：弹窗存在时多久复检一次 */
  loginGatePollMs?: number;
  /** explore 页 URL（不在该页时导航过去，默认小红书 explore） */
  exploreUrl?: string;
  /** 会话节奏曲线（默认热身→正常→加速→疲劳） */
  rhythm?: SessionRhythm;
  /**
   * 估算的会话总卡片数（用于计算会话进度 → 疲劳曲线）。
   * 默认回退到 60（约一次正常档会话动作数）。
   */
  rhythmTotal?: number;
  /** 日志（默认 console） */
  logger?: (msg: string) => void;
  /** 单调时钟（注入便于测试；用于详情页停留时长统计），默认 Date.now */
  now?: () => number;
  /**
   * 详情页最小停留下限区间（毫秒）——缺指令 / 断连兜底用，**非零延迟**。
   * 默认 {min:1200,max:2600}；可由 session.budget.pacing.dwellFloorMs 覆盖。
   */
  dwellFloorMs?: { min: number; max: number };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 详情页停留下限默认区间（与云端 buildPacingDefaults / DWELL_FLOOR_MS 同口径）。 */
const DEFAULT_DWELL_FLOOR_MS = { min: 2500, max: 5000 } as const;

/** 由 [min,max] 下限区间构造一个 lognormal 采样配置（中位数取几何中点）。 */
function makeDwellFloorTiming(range: { min: number; max: number }): TimingConfig {
  const lo = Math.max(1, Math.min(range.min, range.max));
  const hi = Math.max(lo, Math.max(range.min, range.max));
  return { mu: Math.log(Math.sqrt(lo * hi)), sigma: 0.25, min: lo, max: hi };
}

const DEFAULT_EXPLORE_URL = 'https://www.xiaohongshu.com/explore';
/**
 * explore feed 页 URL 判定：匹配 /explore（feed 列表），【排除 /explore/<noteId>（笔记详情页）】。
 * 用于 ensureExplore（启动）与 navigateBack（back_to_feed）统一判定是否真在 feed——
 * 历史上松判断 `url.includes('/explore')` 会把详情页误当 feed，导致扫不到卡 → 静默 → 边-云互等死锁。
 */
const EXPLORE_FEED_RE = /\/explore\/?(\?|#|$)/;
const DEFAULT_RHYTHM_TOTAL = 60;

/** 浏览会话（命令驱动模式） */
export class BrowseSession {
  private running = false;
  private stopRequested = false;
  private readonly random: RandomFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cardGapTiming: TimingConfig;
  private readonly actionTiming: TimingConfig;
  private readonly modalTimeoutMs: number;
  private readonly initialScanTimeoutMs: number;
  private readonly loginGatePollMs: number;
  /** 阻断弹窗当前是否处于"已暂停"状态（用于出现/消失各只记一次日志） */
  private blockingOverlayActive = false;
  private readonly exploreUrl: string;
  private readonly rhythm: SessionRhythm;
  private readonly rhythmTotal: number;
  private readonly logger: (msg: string) => void;
  private readonly now: () => number;
  /** 详情页停留下限配置（lognormal，落在 [min,max]） */
  private dwellFloorTiming: TimingConfig;
  /** 当前详情页打开时刻（单调时钟）；无打开的详情页时为 null。 */
  private noteOpenedAt: number | null = null;
  private processed = 0;

  /** 命令队列：外部通过 onCloudCommand() 推入，loop() 消费 */
  private commandQueue: Envelope[] = [];
  private commandResolver: ((env: Envelope) => void) | null = null;

  /** CDP 断线重连：等待重连结果的 waiter（reconnected→true / unrecoverable→false） */
  private cdpReconnectWaiters: Array<(ok: boolean) => void> = [];
  /** CDP 生命周期事件订阅的退订句柄（start 订阅，结束时退订） */
  private cdpUnsub: Array<() => void> = [];

  constructor(
    private readonly deps: BrowseSessionDeps,
    options: BrowseSessionOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.cardGapTiming = options.cardGapTiming ?? TIMING_PRESETS.cardGap;
    this.actionTiming = options.actionTiming ?? TIMING_PRESETS.action;
    this.modalTimeoutMs = options.modalTimeoutMs ?? 5000;
    this.initialScanTimeoutMs = options.initialScanTimeoutMs ?? 12000;
    this.loginGatePollMs = options.loginGatePollMs ?? 2000;
    this.exploreUrl = options.exploreUrl ?? DEFAULT_EXPLORE_URL;
    this.rhythm = options.rhythm ?? createDefaultRhythm();
    this.rhythmTotal = options.rhythmTotal ?? DEFAULT_RHYTHM_TOTAL;
    this.logger = options.logger ?? ((m) => console.log(m));
    this.now = options.now ?? Date.now;
    this.dwellFloorTiming = makeDwellFloorTiming(options.dwellFloorMs ?? DEFAULT_DWELL_FLOOR_MS);
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
   * - 中心值 = `dwellMs`（云端按内容算）或缺失时从内置下限采样，再叠抖动；
   * - 已停留时长（含真实阅读）已达标则不叠加等待（无双重延迟）。
   */
  private async ensureDetailDwell(dwellMs?: number): Promise<void> {
    if (this.noteOpenedAt == null) return;
    const center = dwellMs && dwellMs > 0 ? dwellMs : sampleDelay(this.dwellFloorTiming, this.random);
    const target = jitterAround(center, 0.2, this.random);
    const elapsed = this.now() - this.noteOpenedAt;
    const remain = target - elapsed;
    if (remain > 0) {
      this.logger(`[browse] 返回前兜底停留 +${Math.round(remain)}ms（目标≈${Math.round(target)}ms，已停${Math.round(elapsed)}ms）`);
      await this.sleep(remain);
    }
    this.noteOpenedAt = null;
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
   * 拟人化停顿：按预设分布采样，再按会话进度的疲劳曲线缩放，最后 sleep。
   */
  private async humanPause(timing: TimingConfig): Promise<void> {
    const base = sampleDelay(timing, this.random);
    const factor = this.rhythm.getSpeedFactor(this.progress());
    const ms = applySpeedFactor(base, factor);
    if (ms > 0) await this.sleep(ms);
  }

  /** 启动浏览循环（命令驱动：上报卡片 → 等待指令 → 执行 → 循环） */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.processed = 0;
    this.commandQueue = [];
    this.commandResolver = null;
    this.logger('[browse] 启动命令驱动浏览循环');
    this.subscribeCdpLifecycle();
    try {
      await this.ensureExplore();
      // 初始扫描延迟：真人打开页面后会先扫一眼 feed 再点击（3-6s）
      const scanDelay = sampleDelay(
        { mu: Math.log(4500), sigma: 0.3, min: 3000, max: 7000 },
        this.random,
      );
      this.logger(`[browse] 扫描 feed（${Math.round(scanDelay / 1000)}s）...`);
      await this.sleep(scanDelay);

      await this.loop();
    } finally {
      this.running = false;
      for (const u of this.cdpUnsub) u();
      this.cdpUnsub = [];
      this.logger('[browse] 浏览循环结束');
    }
  }

  /** 请求停止（下个安全点退出循环） */
  stop(): void {
    this.stopForReason('local_stop');
  }

  /** 请求停止并附带理由（local_stop / cdp_unrecoverable）。唤醒可能正在等待命令的 loop。 */
  private stopForReason(reason: string): void {
    this.stopRequested = true;
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
      on('cdp.reconnected', () => this.onCdpReconnected()),
      on('cdp.unrecoverable', () => this.onCdpUnrecoverable()),
    );
  }

  private onCdpReconnected(): void {
    // 重连后页面可能已变（回 feed / 重载）：清详情页 dwell 计时，避免下次返回误判已达标。
    this.noteOpenedAt = null;
    this.logger('[browse] CDP 已重连，准备续跑');
    const waiters = this.cdpReconnectWaiters;
    this.cdpReconnectWaiters = [];
    for (const w of waiters) w(true);
  }

  private onCdpUnrecoverable(): void {
    // 重连耗尽：停止上报、退出循环（诚实失败），交云端 idle 看门狗兜底结束会话；绝不假装在跑。
    this.logger('[browse] CDP 重连不可恢复，停止浏览循环（交云端看门狗兜底）');
    const waiters = this.cdpReconnectWaiters;
    this.cdpReconnectWaiters = [];
    for (const w of waiters) w(false);
    this.stopForReason('cdp_unrecoverable');
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
   * 云端命令入口。
   * 外部（WebSocket 接收层）调用此方法将云端命令送入队列，loop() 消费执行。
   */
  async onCloudCommand(env: Envelope): Promise<void> {
    if (this.commandResolver) {
      const resolve = this.commandResolver;
      this.commandResolver = null;
      resolve(env);
    } else {
      this.commandQueue.push(env);
    }
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
    const onSearch = url.includes('/search');
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
      try {
        const res = await this.deps.cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: 'document.querySelectorAll("section.note-item").length', returnByValue: true },
        );
        const count = (res as any).result?.value ?? 0;
        if (count >= 4) return; // 至少 4 张卡片出现
      } catch { /* ignore */ }
      await this.sleep(1000);
    }
    this.logger('[browse] 页面加载超时，继续尝试');
  }

  /**
   * 轮询直到 scroller 真正检测到可见卡片（与 reportVisibleCards 同口径），超时返回 false。
   * history.back 后 feed 重渲染有延迟，固定 sleep 后瞬时判断会误判为空 → 误报"无可见卡片"。
   */
  private async waitForVisibleCards(timeout: number, min = 1): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if ((await this.deps.scroller.getVisibleCards()).length >= min) return true;
      } catch { /* ignore */ }
      await this.sleep(500);
    }
    return false;
  }

  private async evalUrl(): Promise<string> {
    const res = await this.deps.cdp.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
    );
    return typeof res.result?.value === 'string' ? res.result.value : '';
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
    await this.waitWhileBlocked();
    await this.waitForVisibleCards(this.initialScanTimeoutMs);
    // 上报初始可见卡片
    await this.reportVisibleCards();

    while (!this.stopRequested) {
      const cmd = await this.waitForCommand();
      if (this.stopRequested) return;
      try {
        await this.executeCommand(cmd);
      } catch (err) {
        // CDP 断线：不当业务失败，等有界重连；成功→续跑重报，耗尽→已请求停止退出。
        if (err instanceof CdpDisconnectedError) {
          this.logger('[browse] 命令执行中 CDP 断连，等待有界重连…');
          const ok = await this.waitForReconnect();
          if (!ok || this.stopRequested) return;
          await this.resumeAfterReconnect();
          continue;
        }
        throw err; // 其他业务异常保持现状（冒泡 → 会话结束）
      }
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
        await this.deps.scroller.scrollNext();
        await this.waitForCards(5000);
        await this.reportVisibleCards();
        break;
      }
      case 'note.open': {
        const payload = env.payload as NoteOpenPayload;
        this.logger(`[browse] 命令: note.open (index=${payload.index}, noteId=${payload.noteId ?? '?'})`);
        await this.thinkBefore(payload.thinkMs); // 决定打开前的犹豫（time directive）
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
        await this.thinkBefore(payload.thinkMs); // 点赞前犹豫（time directive）
        await this.executeLikeOrCollect('like');
        break;
      }
      case 'interaction.collect': {
        const payload = env.payload as InteractionCollectPayload;
        this.logger(`[browse] 命令: interaction.collect (noteId=${payload.noteId})`);
        await this.thinkBefore(payload.thinkMs); // 收藏前犹豫（time directive）
        await this.executeLikeOrCollect('collect');
        break;
      }
      case 'interaction.follow': {
        const payload = env.payload as InteractionFollowPayload;
        this.logger(`[browse] 命令: interaction.follow (authorId=${payload.authorId ?? '?'})`);
        await this.thinkBefore(payload.thinkMs); // 关注前犹豫（time directive）
        await this.executeFollow();
        break;
      }
      case 'interaction.comment': {
        const payload = env.payload as InteractionCommentPayload;
        this.logger(`[browse] 命令: interaction.comment (noteId=${payload.noteId})`);
        await this.thinkBefore(payload.thinkMs); // 发评论前犹豫（time directive）
        await this.executeComment(payload.text);
        break;
      }
      case 'interaction.like_comment': {
        const payload = env.payload as InteractionLikeCommentPayload;
        this.logger(`[browse] 命令: interaction.like_comment (anchor=${payload.commentAnchorId})`);
        await this.thinkBefore(payload.thinkMs); // 点评论赞前犹豫（time directive；边缘只叠抖动，不另加停留）
        await this.executeLikeComment(payload.commentAnchorId);
        break;
      }
      case 'search.execute': {
        const payload = env.payload as { keyword?: string; maxResults?: number };
        const kw = payload.keyword ?? '';
        this.logger(`[browse] 命令: search.execute「${kw}」`);
        await this.safeCloseModal();
        if (kw) {
          try {
            await executeSearch(kw, {
              cdp: this.deps.cdp,
              random: this.random,
              sleep: this.sleep,
              logger: this.logger,
            });
          } catch (err) {
            this.logger(`[browse] 搜索执行失败：${(err as Error).message}`);
          }
        }
        await this.waitForCards(5000);
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
        await this.thinkBefore(payload.thinkMs);
        await this.browseNoteImages(payload.noteId, count);
        break;
      }
      case 'note.scroll_comments': {
        const payload = env.payload as NoteScrollCommentsPayload;
        const count = payload.count ?? 3;
        this.logger(`[browse] 命令: note.scroll_comments (noteId=${payload.noteId}, count=${count})`);
        await this.thinkBefore(payload.thinkMs);
        await this.scrollNoteComments(payload.noteId, count);
        break;
      }
      case 'profile.open': {
        const payload = env.payload as ProfileOpenPayload;
        this.logger(`[browse] 命令: profile.open (authorId=${payload.authorId ?? '?'})`);
        await this.thinkBefore(payload.thinkMs);
        await this.openAuthorProfile(payload.authorId);
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
        this.logger('[browse] 命令: session.end，结束会话');
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
    };
    // 解析 likes 字符串为数字
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].likes) {
        const { parseCount } = await import('./note-extractor.js');
        payload.cards[i].likeCount = parseCount(cards[i].likes!);
      }
    }
    this.deps.client.reportPageCards?.(payload);
    const cardSummary = payload.cards
      .map((c) => `[${c.index}]“${(c.title ?? '').slice(0, 18)}”${c.author ? '@' + c.author : ''}${c.likeCount ? ' 👍' + c.likeCount : ''}`)
      .join(' / ');
    this.logger(`[browse] 已上报 ${cards.length} 张可见卡片 (page.cards): ${cardSummary}`);
  }

  /**
   * 打开指定 index 的卡片，提取内容并用 note.detail 协议上报给云端。
   */
  private async openAndReportNote(index: number, noteId?: string): Promise<void> {
    const cards = await this.deps.scroller.getVisibleCards();
    // 优先按 noteId 在「当前快照」里定位：云端决策与 edge 执行之间 feed 可能已滚动，
    // 纯 index/position 寻址会开成同序号上的"邻座"（云端判 LLM 卡 valuable，edge 却开了 NPD/C罗）。
    let card: NoteCard | undefined;
    if (noteId) {
      card = cards.find((c) => c.noteId === noteId);
      if (!card) {
        // 目标卡已滚出可见区：不开邻座，重报当前快照让云端按现状重判
        // （比报失败触发兜底再 scroll 更稳——再 scroll 会又划过更多内容）。
        this.logger(`[browse] note.open: 目标 noteId=${noteId} 已不在当前可见卡中（feed 已滚动），重报当前卡片`);
        await this.reportVisibleCards();
        return;
      }
    } else {
      // 无 noteId（兜底 / 老协议）：退回按 position/index 寻址。
      card = cards.find((c) => c.position === index) ?? cards[index];
    }
    if (!card) {
      this.logger(`[browse] note.open: 找不到 index=${index} 的卡片`);
      this.deps.client.reportActionCompleted?.({ action: 'open_note', ok: false, reason: 'card_not_found' });
      return;
    }
    await this.deps.scroller.openCard(card);
    let opened = await this.deps.modalCtrl.waitForModal(this.modalTimeoutMs);
    if (!opened) {
      // 重试一次：点击可能未命中或渲染较慢
      this.logger('[browse] note.open: modal 未打开，重试一次');
      await this.deps.scroller.openCard(card);
      opened = await this.deps.modalCtrl.waitForModal(this.modalTimeoutMs);
    }
    if (!opened) {
      this.logger(`[browse] note.open: modal 未打开（重试后仍失败）`);
      this.deps.client.reportActionCompleted?.({ action: 'open_note', ok: false, reason: 'modal_timeout' });
      return;
    }
    await this.waitForEngageBar();
    // 正文(#detail-desc)常比 engage-bar 晚渲染：先等正文出现再抽取，避免抽到空/「标题+刚刚」。
    await this.waitForNoteBody();
    // 记录详情页打开时刻：后续 navigation.back / note.close 据此判定实际停留是否达标（治秒退）。
    this.noteOpenedAt = this.now();

    let content: import('./note-extractor.js').NoteContent;
    try {
      content = await this.deps.noteExtractor(this.deps.dom);
    } catch (err) {
      this.logger(`[browse] note.open: 提取内容失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'open_note', ok: false, reason: 'extract_failed' });
      return;
    }

    // Fallback: 用卡片数据补充
    if (content.likes === 0 && card.likes) {
      const { parseCount } = await import('./note-extractor.js');
      content.likes = parseCount(card.likes);
    }

    // 解析真实 noteId：优先 feed 卡片 → modal 内 explore 链接 → 当前页面 URL → 合成兜底。
    // 真实 noteId 是云端 visited 去重的主键，缺失会导致"反复打开同一张卡"的死循环。
    const parseNoteId = (u?: string): string | undefined => {
      const m = (u ?? '').match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
      return m ? m[1] : undefined;
    };
    const realNoteId = card.noteId ?? parseNoteId(content.noteUrl) ?? parseNoteId(await this.evalUrl());

    // 用 note.detail 上报
    const payload: NoteDetailPayload = {
      noteId: realNoteId ?? `card-${card.position}`,
      title: content.title,
      content: content.body,
      author: content.author,
      likeCount: content.likes,
      collectCount: content.collects,
    };
    this.deps.client.reportNoteDetail?.(payload);
    this.logger(
      `[browse] note.open: 已上报 note.detail noteId=${payload.noteId}「${(payload.title ?? '').slice(0, 24)}」` +
        `${payload.author ? ' by ' + payload.author : ''} 👍${payload.likeCount ?? 0} ⭐${payload.collectCount ?? 0}` +
        ` 正文:${(payload.content ?? '').replace(/\s+/g, ' ').slice(0, 50)}…`,
    );
    this.processed++;
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
   * 在当前打开的 modal 中执行点赞或收藏。
   * Cloud 已做出决策，Edge 直接执行。执行结果通过 action.completed 上报。
   */
  private async executeLikeOrCollect(action: 'like' | 'collect'): Promise<void> {
    const wrapperCls = action === 'like' ? 'like-wrapper' : 'collect-wrapper';
    const alreadyDoneHref = action === 'like' ? '#liked' : '#collected';
    try {
      const js = `(function(){
        var bar = document.querySelector('.interactions.engage-bar');
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
      await this.humanPause(this.actionTiming);
      // 提交前 fresh 复检：humanPause 窗口里若弹出验证码，放弃点击（避免打进风控墙）。
      if (await this.captchaPresentFresh()) {
        this.logger(`[browse] ${action} 提交前复检到验证码/未知阻断弹窗，放弃点击`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'blocked_by_captcha' });
        return;
      }
      const { dispatchClick } = await import('./cdp-util.js');
      await dispatchClick(this.deps.cdp, result.x, result.y, { random: this.random });
      // 验证：等动画后检查 SVG href 是否变为 #liked / #collected
      await this.sleep(1500);
      const verifyJs = `(function(){
        var bar = document.querySelector('.interactions.engage-bar');
        if (!bar) return 'no-bar';
        var el = bar.querySelector('.${wrapperCls}');
        if (!el) return 'no-btn';
        var use = el.querySelector('svg use');
        return use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : 'no-use';
      })()`;
      const afterHref = await evalRaw<string>(this.deps.cdp, verifyJs);
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
      await this.humanPause(this.actionTiming);
      // 提交前 fresh 复检：humanPause 窗口里若弹出验证码，放弃点击（避免打进风控墙）。
      if (await this.captchaPresentFresh()) {
        this.logger('[browse] comment_like 提交前复检到验证码/未知阻断弹窗，放弃点击');
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'blocked_by_captcha' });
        return;
      }
      const { dispatchClick } = await import('./cdp-util.js');
      await dispatchClick(this.deps.cdp, result.x, result.y, { random: this.random });
      // 校验：等动画后【按同一锚点复读】该评论行的赞控件，确认 use 翻成 #liked（或赞数较点前 +1）。
      await this.sleep(1500);
      const beforeCount = typeof result.count === 'string' ? result.count : null;
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
      const afterRaw = await evalRaw<string>(this.deps.cdp, verifyJs);
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
  private async executeComment(text: string): Promise<void> {
    const action = 'comment';
    const body = (text ?? '').trim();
    if (!body) {
      this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'empty_text' });
      return;
    }
    try {
      const { dispatchClick, dispatchKeystrokes } = await import('./cdp-util.js');

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

      // 3) 拟人逐字输入
      await dispatchKeystrokes(this.deps.cdp, body, { random: this.random });
      await this.humanPause(this.actionTiming);

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

      // 6) 后置校验：等待后检查 编辑器清空 且 自己的评论作为顶部新行出现
      await this.sleep(2000);
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
      const vRaw = await evalRaw<string>(this.deps.cdp, verifyJs);
      const v = typeof vRaw === 'string' ? JSON.parse(vRaw) : vRaw;
      if (v?.cleared && v?.ownRow) {
        this.logger('[browse] ✓ 评论发布成功（编辑器清空 + 自己的评论行出现）');
        this.deps.client.reportActionCompleted?.({ action, ok: true });
      } else {
        this.logger(`[browse] ⚠ 评论提交后未确认生效 (cleared=${v?.cleared}, ownRow=${v?.ownRow})`);
        this.deps.client.reportActionCompleted?.({ action, ok: false, reason: 'state_unchanged' });
      }
    } catch (err) {
      this.logger(`[browse] comment 执行失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action, ok: false, reason: (err as Error).message });
    }
  }

  /**
   * 执行关注操作。Cloud 已做出决策，Edge 直接执行。
   */
  private async executeFollow(): Promise<void> {
    try {
      const js = `(function(){
        // 关注按钮两种上下文：笔记 modal 内 .author-wrapper .follow-button；作者主页 .user-info .follow-button
        // （真实小红书主页按钮为 button.reds-button-new.follow-button）。bare .follow-button 兜底两者。
        var selectors = ['.author-wrapper .follow-button', '.user-info .follow-button', '.user-page .follow-button', '.follow-button', '.author-follow-btn', '[data-type="follow"]', '.follow-btn'];
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
      await this.humanPause(this.actionTiming);
      // 提交前 fresh 复检：避免在验证码窗口里点关注。
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
    await this.safeCloseModal();
    const wantSearch = targetPage === 'search';
    // 熟悉度提速：返回到刚看过的 feed（back_to_feed）时，离页停留已由 ensureDetailDwell 治理，
    // 返回手势不必再全量犹豫 → 用更轻的手势停顿（cardGap 量级，约 action 的 1/3，仍带抖动、非零、不秒退）。
    const fastReturn = reason === 'back_to_feed' && !wantSearch;
    await this.humanPause(fastReturn ? this.cardGapTiming : this.actionTiming);
    // 关键：深读链路用 Page.navigate 进作者主页，故从主页 history.back() 只会回到【可能已过期的笔记详情页
    // (/explore/<noteId>，搜索来源 token 易失效)】——闪现小红书 404 且回不到列表。因此【当前在作者主页时
    // 跳过 history.back，直接整页导航到目标列表】，消除 404 闪现；普通情形（笔记 modal 覆盖在列表上）
    // history.back() 能回到列表并保住滚动位，仍优先用它。
    const fromUrl = await this.evalUrl();
    const onProfile = /\/user\/profile\//.test(fromUrl);
    if (!onProfile) {
      await this.deps.cdp.send('Runtime.evaluate', { expression: 'history.back()' });
      // 熟悉 feed 已水合更快：缩短 history.back 后的固定落地等待（仍由后续 waitForVisibleCards 兜底确认卡片）。
      await this.sleep(fastReturn ? 300 : (wantSearch ? 1200 : 800));
    }
    // 健康校验：必须落在【目标列表页（feed: EXPLORE_FEED_RE / search: /search_result）且有可见卡片】才算成功；
    // 否则整页导航兜底——消除经过期笔记的 404、深读经主页回不去、以及坏页 0 卡 → reportVisibleCards 静默 →
    // 边-云互等死锁。search 列表不可达时回退 explore feed（保证不卡死，搜索上下文交由云端续刷重建）。
    const landed = await this.evalUrl();
    const onTarget = wantSearch ? /\/search_result/.test(landed) : EXPLORE_FEED_RE.test(landed);
    if (onProfile || !onTarget || !(await this.waitForVisibleCards(wantSearch ? 5000 : 8000))) {
      if (wantSearch && !onTarget) this.logger('[browse] 搜索结果列表不可达（主页返回/页失效），回退 explore feed');
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
        if (clicked) viewed++;
        await this.sleep(800);
      }
      this.logger(`[browse] 浏览了 ${viewed}/${total} 张图片`);
      this.deps.client.reportActionCompleted?.({ action: 'browse_images', ok: true, reason: `browsed=${viewed}` });
    } catch (err) {
      this.logger(`[browse] 浏览图片失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'browse_images', ok: false, reason: (err as Error).message });
    }
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
      // 单次 eval：上溯找可滚动祖先（评论节点优先）→ 记录 before → scrollBy(instant) → 返回 before/after。
      const scrollExpr = `(function(){
        function scrollable(el){
          var n = el;
          while (n && n !== document.body && n !== document.documentElement){
            var s = window.getComputedStyle(n);
            if (n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(s.overflowY)) return n;
            n = n.parentElement;
          }
          return null;
        }
        var seed = document.querySelector('.comment-item, [class*="comment-item"], [class*="comment"] [class*="content"], .comments-container, [class*="comment-list"], [class*="commentList"]');
        var c = seed ? scrollable(seed) : null;
        if (!c) {
          var cands = document.querySelectorAll('.note-scroller, [class*="scroller"], [class*="comment"], [class*="note-detail"] *');
          for (var i=0;i<cands.length;i++){
            var e=cands[i], s=window.getComputedStyle(e);
            if (e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(s.overflowY)) { c=e; break; }
          }
        }
        if (!c) return JSON.stringify({found:false});
        var before = c.scrollTop;
        c.scrollBy({top: 360});
        return JSON.stringify({found:true, before:before, after:c.scrollTop});
      })()`;
      const times = Math.max(1, count);
      let anyFound = false;
      let moved = 0;
      for (let i = 0; i < times; i++) {
        await this.humanPause(TIMING_PRESETS.scroll);
        const raw = await evalRawFn<string>(this.deps.cdp, scrollExpr);
        const r = typeof raw === 'string' ? JSON.parse(raw) : { found: false };
        if (r.found) {
          anyFound = true;
          if (typeof r.after === 'number' && typeof r.before === 'number' && r.after > r.before) moved++;
        }
      }
      if (!anyFound) {
        this.logger('[browse] 未找到可滚动的评论区容器');
        this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: false, reason: 'no_target' });
        return;
      }
      if (moved === 0) {
        this.logger(`[browse] 评论区命中但未发生位移（已到底/不可滚，0/${times}）`);
        this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: false, reason: 'no_scroll' });
        return;
      }
      this.logger(`[browse] 评论区已滚动 ${moved}/${times} 次（实测 scrollTop 位移）`);
      // 终态视口快照：随手抽取当前在视口内的评论候选（锚点最新鲜）供云端 comment_like 评估。
      // best-effort：抽不到就报空 candidates，云端据此弃权——绝不编造目标。
      const candidates = await this.harvestCommentCandidates();
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
          var authorEl = r.querySelector('.author .name, [class*="author"] [class*="name"], [class*="nickname"], [class*="name"]');
          var contentEl = r.querySelector('.content, [class*="content"], .note-text, p');
          var text = (contentEl ? (contentEl.textContent || '') : (r.textContent || '')).replace(/\\s+/g, ' ').trim().slice(0, 80);
          if (!text) continue;
          out.push({
            anchorId: r.id,
            author: authorEl ? (authorEl.textContent || '').trim().slice(0, 30) : undefined,
            text: text,
            alreadyLiked: href === '#liked'
          });
        }
        return JSON.stringify(out);
      })()`;
      const raw = await evalRaw<string>(this.deps.cdp, harvestJs);
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(arr) ? (arr as CommentCandidate[]) : [];
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
      const homeJs = `(function(){
        function unreadNear(labelRe){
          var els = Array.from(document.querySelectorAll('[role="tab"], [class*="tab"], a, span, div'));
          for (var i=0;i<els.length;i++){
            var t=(els[i].textContent||'').trim();
            if(t.length>10 || !labelRe.test(t)) continue;
            var badge = els[i].querySelector('[class*="badge"],[class*="dot"],[class*="count"],[class*="red"]');
            if(badge){ var n=parseInt((badge.textContent||'').replace(/[^0-9]/g,''),10); return isNaN(n)?1:n; }
          }
          return 0;
        }
        return JSON.stringify({ comments: unreadNear(/评论|@/), likes: unreadNear(/赞|收藏/), follows: unreadNear(/关注|粉丝/) });
      })()`;
      const raw = await evalRawFn<string>(this.deps.cdp, homeJs);
      const home = typeof raw === 'string' ? JSON.parse(raw) : { comments: 0, likes: 0, follows: 0 };
      this.deps.client.send?.('notification.home', home);
      this.logger(`[browse] notification.home: 评论${home.comments} 赞藏${home.likes} 关注${home.follows}（选择器待真机校准）`);
    } catch (err) {
      this.logger(`[browse] notification.open 失败（上报全 0 以便分诊收尾）：${(err as Error).message}`);
      this.deps.client.send?.('notification.home', { comments: 0, likes: 0, follows: 0 });
    }
  }

  /**
   * 进「评论和@」分类、滚动加载、抽取原始评论/@ 项，经 notification.items 上报。
   * 边缘只产出原始项；是否值得通知由云端判。选择器 best-effort、待真机校准；失败上报空 items（不静默吞）。
   */
  private async browseNotificationComments(scrollMax: number): Promise<void> {
    try {
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      await evalRawFn<boolean>(
        this.deps.cdp,
        `(function(){ var els = Array.from(document.querySelectorAll('[role="tab"], [class*="tab"], a, span, div')); for (var i=0;i<els.length;i++){ var t=(els[i].textContent||'').trim(); if(t==='评论和@' || (/^评论/.test(t) && t.indexOf('@')>=0)){ els[i].click(); return true; } } return false; })()`,
      );
      await this.sleep(800);
      for (let i = 0; i < scrollMax; i++) {
        await evalRawFn<boolean>(this.deps.cdp, `(function(){ window.scrollBy(0, document.documentElement.clientHeight*0.8); return true; })()`);
        await this.sleep(600);
      }
      const extractJs = `(function(){
        var out = [];
        var items = document.querySelectorAll('[class*="notification"] [class*="item"], [class*="comment"] [class*="item"], [class*="tabs-content"] [class*="container"] > div');
        for (var i=0;i<items.length && out.length<50;i++){
          var it = items[i];
          var txt = (it.textContent||'');
          var isMention = /@\\s*(我|你)|提到了你/.test(txt);
          var isComment = /评论|回复/.test(txt);
          if(!isMention && !isComment) continue;
          var userEl = it.querySelector('[class*="name"], [class*="user"], a[href*="/user/profile/"]');
          var contentEl = it.querySelector('[class*="content"], [class*="comment"], p');
          var noteEl = it.querySelector('[class*="note"] [class*="title"], [class*="extract"]');
          var keyEl = it.querySelector('a[href]');
          out.push({
            kind: isMention ? 'mention' : 'comment',
            fromUser: (userEl && userEl.textContent || '').trim().slice(0,40),
            content: (contentEl && contentEl.textContent || txt).trim().slice(0,200),
            noteTitle: (noteEl && noteEl.textContent || '').trim().slice(0,40) || undefined,
            itemKey: (keyEl && keyEl.getAttribute('href') || '').slice(0,120) || undefined
          });
        }
        return JSON.stringify(out);
      })()`;
      const raw = await evalRawFn<string>(this.deps.cdp, extractJs);
      const items = typeof raw === 'string' ? JSON.parse(raw) : [];
      this.deps.client.send?.('notification.items', { items });
      this.logger(`[browse] notification.items: 上报 ${Array.isArray(items) ? items.length : 0} 条评论/@（选择器待真机校准）`);
    } catch (err) {
      this.logger(`[browse] notification.browse_comments 失败（上报空 items 以便云端收尾）：${(err as Error).message}`);
      this.deps.client.send?.('notification.items', { items: [] });
    }
  }

  /**
   * 进「赞和收藏」/「新增关注」分类看一眼清未读（v1 不抽取），回执 action.completed。
   * 选择器 best-effort、待真机校准；失败也如实回执，使云端巡视能收尾。
   */
  private async viewNotificationCategory(kind: 'likes' | 'follows'): Promise<void> {
    const action = kind === 'likes' ? 'browse_notification_likes' : 'browse_notification_follows';
    try {
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      const labelRe = kind === 'likes' ? '赞|收藏' : '关注|粉丝';
      await evalRawFn<boolean>(
        this.deps.cdp,
        `(function(){ var els = Array.from(document.querySelectorAll('[role="tab"], [class*="tab"], a, span, div')); for (var i=0;i<els.length;i++){ var t=(els[i].textContent||'').trim(); if(t.length<=8 && new RegExp('${labelRe}').test(t)){ els[i].click(); return true; } } return false; })()`,
      );
      await this.sleep(800);
      this.logger(`[browse] ${action}: 已查看（清未读，v1 不抽取）`);
      this.deps.client.reportActionCompleted?.({ action, ok: true, reason: 'viewed' });
    } catch (err) {
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
  private async openAuthorProfile(authorId?: string): Promise<void> {
    const { evalRaw: evalRawFn } = await import('./cdp-util.js');
    try {
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
      const url = String(info.href).startsWith('http') ? String(info.href) : `https://www.xiaohongshu.com${info.href}`;
      await this.humanPause(this.actionTiming);
      await this.deps.cdp.send('Page.navigate', { url });

      // 2) 等待作者主页渲染
      if (!(await this.waitForProfile(8000))) {
        this.logger('[browse] profile.open: 作者主页未在超时内渲染');
        this.reportProfileFallback(authorId);
        return;
      }

      // 3) 抽取作者资料
      const profile = await this.extractAuthorProfile();
      const resolvedId = profile.authorId || authorId || '';
      if (profile.extracted) {
        this.logger(`[browse] profile.open: 作者资料 粉丝${profile.followersCount} 获赞与收藏${profile.likesCollects}（作品数主页不公开）`);
        this.deps.client.reportProfileDetail?.({
          authorId: resolvedId,
          postsCount: profile.postsCount,
          followersCount: profile.followersCount,
          likesCollects: profile.likesCollects,
          extracted: true,
        });
      } else {
        this.logger('[browse] profile.open: 进了主页但未抽到作品/粉丝数');
        this.reportProfileFallback(resolvedId);
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

  /** 从作者主页抽取粉丝数 / 获赞与收藏数（作品数主页不公开，恒 0）。复用 parseCount 解析中文计数。 */
  private async extractAuthorProfile(): Promise<{ authorId: string; postsCount: number; followersCount: number; likesCollects: number; extracted: boolean }> {
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
      var idm = location.href.match(/\\/user\\/profile\\/([A-Za-z0-9]+)/);
      return JSON.stringify({authorId: idm?idm[1]:'', followers: followers, posts: posts, lc: lc});
    })()`;
    const { parseCount } = await import('./note-extractor.js');
    // Page.navigate 整页加载后 .user-interactions 数据异步晚到：轮询等出数再抽（最多 5s），
    // 避免"进了主页但抽到空"。
    const deadline = this.now() + 5000;
    let lastId = '';
    for (;;) {
      try {
        const raw = await evalRawFn<string>(this.deps.cdp, js);
        const info = typeof raw === 'string' ? JSON.parse(raw) : {};
        if (info.authorId) lastId = info.authorId;
        const hasFollowers = info.followers != null && info.followers !== '';
        const hasPosts = info.posts != null && info.posts !== '';
        const hasLc = info.lc != null && info.lc !== '';
        if (hasFollowers || hasPosts || hasLc) {
          return {
            authorId: info.authorId || '',
            postsCount: hasPosts ? parseCount(String(info.posts)) : 0,
            followersCount: hasFollowers ? parseCount(String(info.followers)) : 0,
            likesCollects: hasLc ? parseCount(String(info.lc)) : 0,
            extracted: true,
          };
        }
      } catch {
        /* ignore，下一轮重试 */
      }
      if (this.now() >= deadline) break;
      await this.sleep(500);
    }
    return { authorId: lastId, postsCount: 0, followersCount: 0, likesCollects: 0, extracted: false };
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
    while (!this.stopRequested && !this.terminatePending()) {
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
      await this.sleep(this.loginGatePollMs);
    }
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


