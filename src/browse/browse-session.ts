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
  NavigationBackPayload,
  NoteBrowseImagesPayload,
  NoteScrollCommentsPayload,
} from '../comm/protocol.js';
import type { ActionResultPayload } from '../comm/protocol.js';
import type { FeedScroller, NoteCard } from './feed-scroller.js';
import type { ModalController } from './modal-controller.js';
import type { extractNoteContent as ExtractFn } from './note-extractor.js';
import { executeSearch } from './search-handler.js';
import { evalRaw, type RandomFn, type BrowseCdp } from './cdp-util.js';
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

/** 详情页停留下限默认区间（与云端 buildPacingDefaults 同口径）。 */
const DEFAULT_DWELL_FLOOR_MS = { min: 1200, max: 2600 } as const;

/** 由 [min,max] 下限区间构造一个 lognormal 采样配置（中位数取几何中点）。 */
function makeDwellFloorTiming(range: { min: number; max: number }): TimingConfig {
  const lo = Math.max(1, Math.min(range.min, range.max));
  const hi = Math.max(lo, Math.max(range.min, range.max));
  return { mu: Math.log(Math.sqrt(lo * hi)), sigma: 0.25, min: lo, max: hi };
}

const DEFAULT_EXPLORE_URL = 'https://www.xiaohongshu.com/explore';
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
      this.logger('[browse] 浏览循环结束');
    }
  }

  /** 请求停止（下个安全点退出循环） */
  stop(): void {
    this.stopRequested = true;
    // 唤醒可能正在等待命令的 loop
    if (this.commandResolver) {
      const resolve = this.commandResolver;
      this.commandResolver = null;
      resolve({ v: 2, type: 'session.end', id: 'stop', ts: Date.now(), payload: { reason: 'local_stop' } });
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
    if (!url.includes('/explore') && !url.includes('/search')) {
      this.logger(`[browse] 不在 explore（当前 ${url || '?'}），导航到 ${this.exploreUrl}`);
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
    await this.waitForVisibleCards(this.initialScanTimeoutMs);
    // 上报初始可见卡片
    await this.reportVisibleCards();

    while (!this.stopRequested) {
      const cmd = await this.waitForCommand();
      if (this.stopRequested) return;
      await this.executeCommand(cmd);
    }
  }

  /**
   * 执行单条云端命令。
   * 每条命令执行后，相应的 handler 会上报 action.completed 或新的 page.cards/note.detail。
   */
  private async executeCommand(env: Envelope): Promise<void> {
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
        await this.navigateBack(payload.targetPage);
        break;
      }
      case 'note.browse_images': {
        const payload = env.payload as NoteBrowseImagesPayload;
        const count = payload.count ?? 3;
        this.logger(`[browse] 命令: note.browse_images (noteId=${payload.noteId}, count=${count})`);
        await this.browseNoteImages(payload.noteId, count);
        break;
      }
      case 'note.scroll_comments': {
        const payload = env.payload as NoteScrollCommentsPayload;
        const count = payload.count ?? 3;
        this.logger(`[browse] 命令: note.scroll_comments (noteId=${payload.noteId}, count=${count})`);
        await this.scrollNoteComments(payload.noteId, count);
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
    const cards = await this.deps.scroller.getVisibleCards();
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
   * 执行关注操作。Cloud 已做出决策，Edge 直接执行。
   */
  private async executeFollow(): Promise<void> {
    try {
      const js = `(function(){
        var selectors = ['.author-wrapper .follow-button', '.author-follow-btn', '[data-type="follow"]', '.follow-btn'];
        for (var s of selectors) {
          var el = document.querySelector(s);
          if (el) {
            var text = el.textContent || '';
            if (text.includes('已关注') || text.includes('互关')) return JSON.stringify({error:'already'});
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});
          }
        }
        return JSON.stringify({error:'no-btn'});
      })()`;
      const { evalRaw: evalRawFn, dispatchClick } = await import('./cdp-util.js');
      const raw = await evalRawFn<string>(this.deps.cdp, js);
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result?.error) {
        const reason = result.error === 'already' ? 'already_followed' : `btn_${result.error}`;
        this.logger(`[browse] 关注失败: ${reason}`);
        this.deps.client.reportActionCompleted?.({ action: 'follow', ok: false, reason });
        return;
      }
      await this.humanPause(this.actionTiming);
      await dispatchClick(this.deps.cdp, result.x, result.y, { random: this.random });
      await this.sleep(1500);
      this.logger(`[browse] ✓ 关注成功 (${result.x}, ${result.y})`);
      this.deps.client.reportActionCompleted?.({ action: 'follow', ok: true });
    } catch (err) {
      this.logger(`[browse] 关注执行失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'follow', ok: false, reason: (err as Error).message });
    }
  }

  private async navigateBack(targetPage?: 'feed' | 'search'): Promise<void> {
    await this.safeCloseModal();
    await this.humanPause(this.actionTiming);
    if (targetPage === 'feed') {
      // 优先 history.back()：保住 feed 滚动位与卡片顺序，避免整页重载导致卡片重新编号 → 反复开同一张。
      await this.deps.cdp.send('Runtime.evaluate', { expression: 'history.back()' });
      // 轮询等卡片真正出现（scroller 口径），而非固定 sleep 后瞬时判断——
      // 否则 back 后 feed 没渲染完就误判为空，会让 reportVisibleCards 空报 → 云端误判 session.end。
      if (!(await this.waitForVisibleCards(8000))) {
        // 兜底：history.back 未恢复出卡片 → 整页重载，并再次按 scroller 口径确认
        await this.deps.cdp.send('Page.navigate', { url: this.exploreUrl });
        await this.waitForCards(10000);
        await this.waitForVisibleCards(5000);
      }
    } else if (targetPage === 'search') {
      await this.deps.cdp.send('Runtime.evaluate', { expression: 'history.back()' });
      await this.sleep(2000);
    } else {
      await this.deps.cdp.send('Runtime.evaluate', { expression: 'history.back()' });
      await this.sleep(2000);
    }
    await this.reportVisibleCards();
    this.deps.client.reportActionCompleted?.({ action: 'back', ok: true });
  }

  /**
   * 浏览笔记图片。count 由 Cloud 指定。
   */
  private async browseNoteImages(_noteId: string, count: number): Promise<void> {
    try {
      const js = `(function(){
        var swiper = document.querySelector('.swiper-wrapper') || document.querySelector('.note-slider');
        if (!swiper) return JSON.stringify({count: 0});
        var slides = swiper.querySelectorAll('.swiper-slide, img');
        return JSON.stringify({count: slides.length});
      })()`;
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      const raw = await evalRawFn<string>(this.deps.cdp, js);
      const info = typeof raw === 'string' ? JSON.parse(raw) : { count: 0 };
      const available = info.count || 1;
      const browseCount = Math.min(count, available);
      // 模拟逐张浏览图片（点击下一张按钮或滑动）
      for (let i = 1; i < browseCount; i++) {
        await this.humanPause(this.cardGapTiming);
        await this.deps.cdp.send('Runtime.evaluate', {
          expression: `(function(){ var btn = document.querySelector('.swiper-button-next, .next-btn'); if(btn) btn.click(); })()`
        });
        await this.sleep(800);
      }
      this.logger(`[browse] 浏览了 ${browseCount} 张图片`);
      this.deps.client.reportActionCompleted?.({ action: 'browse_images', ok: true });
    } catch (err) {
      this.logger(`[browse] 浏览图片失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'browse_images', ok: false, reason: (err as Error).message });
    }
  }

  /**
   * 滚动评论区。count 由 Cloud 指定。
   */
  private async scrollNoteComments(_noteId: string, count: number): Promise<void> {
    try {
      const { evalRaw: evalRawFn } = await import('./cdp-util.js');
      const js = `(function(){
        var comments = document.querySelector('.comments-container') || document.querySelector('.note-comment');
        if (!comments) return 'no-comments';
        comments.scrollBy({top: 300, behavior: 'smooth'});
        return 'ok';
      })()`;
      const result = await evalRawFn<string>(this.deps.cdp, js);
      if (result === 'no-comments') {
        this.logger('[browse] 未找到评论区容器');
        this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: false, reason: 'no-comments' });
        return;
      }
      // 按 Cloud 指定次数滚动
      for (let i = 1; i < count; i++) {
        await this.humanPause(this.cardGapTiming);
        await this.deps.cdp.send('Runtime.evaluate', {
          expression: `(function(){ var c = document.querySelector('.comments-container') || document.querySelector('.note-comment'); if(c) c.scrollBy({top: 300, behavior: 'smooth'}); })()`
        });
      }
      this.logger(`[browse] 评论区滚动完成 (${count} 次)`);
      this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: true });
    } catch (err) {
      this.logger(`[browse] 滚动评论失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: false, reason: (err as Error).message });
    }
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
}


