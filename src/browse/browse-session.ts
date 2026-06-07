/**
 * 浏览会话编排（核心自动浏览循环）。
 *
 * 编排 feed 滚动 / 卡片打开 / modal 控制 / 内容提取 / 与云端通信，形成闭环：
 *
 *   确保在 explore → 取可见卡片 → 逐张：
 *     打开 modal → 等稳定 → 模拟阅读 → 提取内容 → 上报 cloud → 等决策
 *       决策=like        → 执行 like flow（plan.response 步骤）
 *       决策=browse.next → 关 modal，继续下一张
 *       决策=search      → 关 modal，执行搜索，结果页继续巡航
 *       决策=session.end → 关 modal，停止循环
 *     → 当前屏处理完 → scrollNext → 回到取卡片
 *
 * 人类行为模拟（见 docs/risk-control.md §3）：所有停顿改用对数正态分布采样
 * （HumanizedTiming），并按会话进度施加疲劳曲线（SessionRhythm）；阅读停留时间与
 * 正文长度相关；点击走贝塞尔轨迹、滚动走惯性序列、输入走键盘节奏（在各子模块内）。
 */

import type {
  Envelope,
  NoteContentPayload,
  PlanResponsePayload,
  PlanStep,
  SessionBudgetPayload,
  PageCardsPayload,
  NoteDetailPayload,
  ProfileDetailPayload,
  ActionCompletedPayload,
  PageScrollPayload,
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
import type { NoteContent } from './note-extractor.js';
import type { extractNoteContent as ExtractFn } from './note-extractor.js';
import { executeSearch } from './search-handler.js';
import { shouldOpenCard } from './card-filter.js';
import { evalRaw, type RandomFn, type BrowseCdp } from './cdp-util.js';
import type { DomProvider } from '../locating/engine.js';
import {
  sampleDelay,
  TIMING_PRESETS,
  type TimingConfig,
  createDefaultRhythm,
  applySpeedFactor,
  estimateReadingTime,
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
  requestSessionBudget?(accountId?: string): Promise<SessionBudgetPayload>;
  canDo?(action: 'like' | 'collect', accountId?: string): Promise<{ allowed: boolean; reason?: string }>;
  recordRiskAction?(action: 'like' | 'collect', accountId?: string): Promise<{ recorded: boolean; reason?: string }>;
  // 新增 v2 上报方法
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
  /** 随机跳过卡片概率（0..1，默认 0.2） */
  skipProbability?: number;
  /** modal 打开超时（毫秒，默认 5000） */
  modalTimeoutMs?: number;
  /** explore 页 URL（不在该页时导航过去，默认小红书 explore） */
  exploreUrl?: string;
  /** 单次循环最多处理的卡片数上限（防御无限循环；默认无上限 0） */
  maxCards?: number;
  /** 会话节奏曲线（默认热身→正常→加速→疲劳） */
  rhythm?: SessionRhythm;
  /**
   * 估算的会话总卡片数（用于计算会话进度 → 疲劳曲线）。
   * 默认取 maxCards（若 >0），否则回退到 60（约一次正常档会话动作数）。
   */
  rhythmTotal?: number;
  /** 阅读速度（字/分钟），默认 300 */
  charsPerMinute?: number;
  /** 日志（默认 console） */
  logger?: (msg: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_EXPLORE_URL = 'https://www.xiaohongshu.com/explore';
const DEFAULT_RHYTHM_TOTAL = 60;

/** 浏览会话 */
export class BrowseSession {
  private running = false;
  private stopRequested = false;
  private readonly random: RandomFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cardGapTiming: TimingConfig;
  private readonly actionTiming: TimingConfig;
  private readonly skipProbability: number;
  private readonly modalTimeoutMs: number;
  private readonly exploreUrl: string;
  private readonly maxCards: number;
  private readonly rhythm: SessionRhythm;
  private readonly rhythmTotal: number;
  private readonly charsPerMinute: number;
  private readonly logger: (msg: string) => void;
  private sessionBudget?: SessionBudgetPayload;
  private sessionStartedAt = 0;
  private actionCount = 0;
  private processed = 0;
  private seenCardKeys = new Set<string>();

  constructor(
    private readonly deps: BrowseSessionDeps,
    options: BrowseSessionOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.cardGapTiming = options.cardGapTiming ?? TIMING_PRESETS.cardGap;
    this.actionTiming = options.actionTiming ?? TIMING_PRESETS.action;
    this.skipProbability = options.skipProbability ?? 0.2;
    this.modalTimeoutMs = options.modalTimeoutMs ?? 5000;
    this.exploreUrl = options.exploreUrl ?? DEFAULT_EXPLORE_URL;
    this.maxCards = options.maxCards ?? 0;
    this.rhythm = options.rhythm ?? createDefaultRhythm();
    this.rhythmTotal =
      options.rhythmTotal ?? (this.maxCards > 0 ? this.maxCards : DEFAULT_RHYTHM_TOTAL);
    this.charsPerMinute = options.charsPerMinute ?? 300;
    this.logger = options.logger ?? ((m) => console.log(m));
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
   * 这是替换原 randomDelay(min,max) 的统一入口。
   */
  private async humanPause(timing: TimingConfig): Promise<void> {
    const base = sampleDelay(timing, this.random);
    const factor = this.rhythm.getSpeedFactor(this.progress());
    const ms = applySpeedFactor(base, factor);
    if (ms > 0) await this.sleep(ms);
  }

  /** 启动浏览循环（直到 session.end / stop() / 无更多卡片） */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.processed = 0;
    this.actionCount = 0;
    this.seenCardKeys.clear();
    this.sessionStartedAt = Date.now();
    this.logger('[browse] 启动自动浏览循环');
    try {
      await this.loadSessionBudget();
      await this.ensureExplore();
      // 初始扫描延迟：真人打开页面后会先扫一眼 feed 再点击（3-6s）
      const scanDelay = sampleDelay(
        { mu: Math.log(4500), sigma: 0.3, min: 3000, max: 7000 },
        this.random,
      );
      this.logger(`[browse] 扫描 feed（${Math.round(scanDelay / 1000)}s）...`);
      await this.sleep(scanDelay);

      // 检测云端是否为异步推送模式：用首张卡片试探
      const probeCards = await this.deps.scroller.getVisibleCards();
      if (probeCards.length > 0 && this.deps.client.send) {
        // 向云端上报可见卡片，测试是否返回 note.ack
        const firstCard = probeCards[0];
        const probePayload: NoteContentPayload = {
          noteId: firstCard.noteId ?? `card-${firstCard.position}`,
          title: firstCard.title ?? '',
          summary: '',
          likeCount: 0,
          collectCount: 0,
          author: firstCard.author,
        };
        try {
          const resp = await this.deps.client.reportNoteContent(probePayload, 10_000);
          if (resp.type === 'note.ack') {
            this.logger('[browse] 检测到云端异步推送模式（note.ack），切换为被动等待');
            // 上报剩余可见卡片
            for (const card of probeCards.slice(1)) {
              const payload: NoteContentPayload = {
                noteId: card.noteId ?? `card-${card.position}`,
                title: card.title ?? '',
                summary: '',
                likeCount: 0,
                collectCount: 0,
                author: card.author,
              };
              this.deps.client.send('note.content', payload);
            }
            // 被动模式：不进入 loop()，等待云端命令通过 onCloudCommand 驱动
            this.logger('[browse] 已进入被动模式，等待云端推送命令...');
            await this.waitForStop();
            return;
          }
        } catch {
          // 超时或错误：降级为主动模式
          this.logger('[browse] 模式探测失败，使用主动循环模式');
        }
      }

      await this.loop();
    } finally {
      this.running = false;
      this.logger('[browse] 浏览循环结束');
    }
  }

  /** 请求停止（下个安全点退出循环） */
  stop(): void {
    this.stopRequested = true;
  }

  /**
   * 云端命令执行入口（被动模式）。
   * 云端通过 CommandSink 异步推送命令，edge 通过此方法逐条执行。
   */
  async onCloudCommand(env: Envelope): Promise<void> {
    // 先处理互动附加：payload.action === 'like' | 'collect'
    const action = (env.payload as { action?: string })?.action;
    if (action === 'like' || action === 'collect') {
      this.logger(`[browse] 云端命令附带互动: ${action}`);
      await this.executeLikeOrCollect(action);
    }

    switch (env.type) {
      case 'browse.next': {
        this.logger(`[browse] 云端命令: browse.next`);
        await this.safeCloseModal();
        await this.humanPause(this.cardGapTiming);
        await this.deps.scroller.scrollNext();
        await this.waitForCards(5000);
        await this.reportVisibleCards();
        break;
      }
      case 'browse.scroll': {
        this.logger(`[browse] 云端命令: browse.scroll`);
        await this.deps.scroller.scrollNext();
        await this.waitForCards(5000);
        await this.reportVisibleCards();
        break;
      }
      case 'note.open': {
        const payload = env.payload as { noteId?: string; index?: number; reason?: string };
        this.logger(`[browse] 云端命令: note.open (index=${payload.index})`);
        await this.openAndReportNote(payload.index ?? 0);
        break;
      }
      case 'note.close': {
        this.logger(`[browse] 云端命令: note.close`);
        await this.safeCloseModal();
        break;
      }
      case 'search.execute': {
        const payload = env.payload as { keyword?: string; maxResults?: number };
        const kw = payload.keyword ?? '';
        this.logger(`[browse] 云端命令: search.execute「${kw}」`);
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
      case 'session.end': {
        this.logger('[browse] 云端命令: session.end，结束会话');
        this.stopRequested = true;
        await this.safeCloseModal();
        break;
      }
      case 'page.scroll': {
        const payload = env.payload as PageScrollPayload;
        this.logger(`[browse] 云端命令: page.scroll (${payload.reason ?? ''})`);
        await this.deps.scroller.scrollNext();
        await this.waitForCards(5000);
        await this.reportVisibleCards();
        break;
      }
      case 'interaction.like': {
        const payload = env.payload as InteractionLikePayload;
        this.logger(`[browse] 云端命令: interaction.like (noteId=${payload.noteId})`);
        await this.executeLikeOrCollect('like');
        this.deps.client.reportActionCompleted?.({ action: 'like', ok: true });
        break;
      }
      case 'interaction.collect': {
        const payload = env.payload as InteractionCollectPayload;
        this.logger(`[browse] 云端命令: interaction.collect (noteId=${payload.noteId})`);
        await this.executeLikeOrCollect('collect');
        this.deps.client.reportActionCompleted?.({ action: 'collect', ok: true });
        break;
      }
      case 'interaction.follow': {
        const payload = env.payload as InteractionFollowPayload;
        this.logger(`[browse] 云端命令: interaction.follow (authorId=${payload.authorId ?? '?'})`);
        await this.executeFollow(payload.authorId);
        break;
      }
      case 'navigation.back': {
        const payload = env.payload as NavigationBackPayload;
        this.logger(`[browse] 云端命令: navigation.back (${payload.reason ?? ''}, target=${payload.targetPage ?? ''})`);
        await this.navigateBack(payload.targetPage);
        break;
      }
      case 'note.browse_images': {
        const payload = env.payload as NoteBrowseImagesPayload;
        this.logger(`[browse] 云端命令: note.browse_images (noteId=${payload.noteId})`);
        await this.browseNoteImages(payload.noteId);
        break;
      }
      case 'note.scroll_comments': {
        const payload = env.payload as NoteScrollCommentsPayload;
        this.logger(`[browse] 云端命令: note.scroll_comments (noteId=${payload.noteId})`);
        await this.scrollNoteComments(payload.noteId);
        break;
      }
      default:
        this.logger(`[browse] 未知云端命令: ${env.type}`);
    }
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

  private async evalUrl(): Promise<string> {
    const res = await this.deps.cdp.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
    );
    return typeof res.result?.value === 'string' ? res.result.value : '';
  }

  /** 主循环：取卡片 → 逐张处理 → 滚动下一屏 */
  private async loop(): Promise<void> {
    let emptyScrolls = 0;
    while (!this.stopRequested) {
      if (this.shouldEndByBudget()) return;
      const cards = await this.deps.scroller.getVisibleCards();
      if (cards.length === 0) {
        emptyScrolls++;
        if (emptyScrolls >= 3) {
          this.logger('[browse] 连续多屏无卡片，停止');
          return;
        }
        await this.deps.scroller.scrollNext();
        // 等待懒加载新卡片（最多 5 秒）
        await this.waitForCards(5000);
        await this.humanPause(this.cardGapTiming);
        continue;
      }
      emptyScrolls = 0;

      for (const card of cards) {
        if (this.stopRequested) return;
        if (this.shouldEndByBudget()) return;
        if (this.maxCards > 0 && this.processed >= this.maxCards) {
          this.logger(`[browse] 达到 maxCards=${this.maxCards}，停止`);
          return;
        }
        const key = this.cardKey(card);
        if (this.seenCardKeys.has(key)) {
          continue;
        }
        this.seenCardKeys.add(key);
        // 跳过视频笔记（对我们没有意义）
        if (card.isVideo) {
          this.logger(`[browse] 跳过视频卡片 #${card.position}`);
          this.processed++;
          continue;
        }
        // 20% 概率随机跳过不点开
        if (this.random() < this.skipProbability) {
          this.logger(`[browse] 随机跳过卡片 #${card.position}`);
          this.processed++;
          continue;
        }
        // 卡片预筛：用标题 / likes 快速判断是否值得打开 modal（不调用 LLM）。
        // 被预筛跳过的卡片仍计入 processed（影响 relevance_rate），但不上报云端。
        const prefilter = shouldOpenCard(card);
        if (!prefilter.open) {
          const detail = prefilter.reason ?? '';
          if (detail.startsWith('likes=')) {
            this.logger(`[browse] 跳过低赞卡片 #${card.position} (${detail})`);
          } else {
            this.logger(`[browse] 跳过无关卡片 #${card.position}: ${detail}`);
          }
          this.processed++;
          continue;
        }
        const cont = await this.processCard(card);
        this.processed++;
        if (!cont) return; // session.end
        // 卡片间停顿（对数正态 + 疲劳曲线）
        await this.humanPause(this.cardGapTiming);
      }

      await this.deps.scroller.scrollNext();
      this.recordBudgetAction('scroll');
      // 等待懒加载新卡片
      await this.waitForCards(5000);
      await this.humanPause(this.cardGapTiming);
    }
  }

  private cardKey(card: NoteCard): string {
    return `${card.title ?? ''}|${card.author ?? ''}|${card.likes ?? ''}`;
  }

  /**
   * 处理单张卡片：打开 → 提取 → 上报 → 执行决策 → 关闭。
   * @returns 是否继续循环（false 表示 session.end）。
   */
  private async processCard(card: NoteCard): Promise<boolean> {
    await this.deps.scroller.openCard(card);
    const opened = await this.deps.modalCtrl.waitForModal(this.modalTimeoutMs);
    if (!opened) {
      this.logger(`[browse] 卡片 #${card.position} modal 未打开，跳过`);
      return true;
    }

    // engage-bar（含收藏数 collects）在 modal 打开后异步渲染，比正文/likes 晚。
    // 等它出现后再提取，否则 collects 会始终读到 0。超时则降级继续。
    await this.waitForEngageBar();

    let content: NoteContent;
    try {
      content = await this.deps.noteExtractor(this.deps.dom);
    } catch (err) {
      this.logger(`[browse] 提取内容失败：${(err as Error).message}`);
      await this.safeCloseModal();
      return true;
    }

    // Fallback: 如果 modal 内没提取到 likes/collects，用卡片上的数据
    if (content.likes === 0 && card.likes) {
      const { parseCount } = await import('./note-extractor.js');
      content.likes = parseCount(card.likes);
    }

    // Qwen API 延迟（3-10s）自然提供了足够的"阅读停留时间"，无需额外 readPause。
    // 如果 Qwen 响应极快（<2s），补一个最低停留保证。
    const modalOpenedAt = Date.now();

    let decision: Envelope;
    try {
      decision = await this.deps.client.reportNoteContent(toPayload(content, card.noteId ?? `card-${card.position}`));
    } catch (err) {
      this.logger(`[browse] 上报/等待云端决策失败：${(err as Error).message}`);
      await this.safeCloseModal();
      return true;
    }

    // 保证在笔记上至少停留 3 秒（防止 Qwen 极快返回时操作过快被检测）
    const elapsed = Date.now() - modalOpenedAt;
    if (elapsed < 3000) {
      await this.sleep(3000 - elapsed);
    }

    const cont = await this.applyDecision(decision);
    return cont;
  }

  /**
   * 等待 modal 的 engage-bar（含收藏数 collect-wrapper）渲染完成。
   *
   * modal 打开后，正文与 likes 先加载，但底部 engage-bar（含收藏数 collects）是异步
   * 渲染的，紧随 waitForModal 立即提取会读到 collects=0。这里轮询 DOM，直到
   * .collect-wrapper（或 engage-bar 容器）出现再返回；超时则不阻塞，降级为 collects=0。
   *
   * @param timeout 最长等待毫秒（默认 3000）。
   * @param intervalMs 轮询间隔（默认 300）。
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

  /** 与正文长度相关的阅读停留，叠加疲劳曲线。(保留用于 like/collect 后的停留) */
  // @ts-ignore kept for future use
  private async readPause(content: NoteContent): Promise<void> {
    const textLen = (content.body || '').length + (content.title || '').length;
    const base = estimateReadingTime(textLen, {
      charsPerMinute: this.charsPerMinute,
      random: this.random,
    });
    const factor = this.rhythm.getSpeedFactor(this.progress());
    const ms = applySpeedFactor(base, factor);
    if (ms > 0) await this.sleep(ms);
  }

  /**
   * 执行云端决策信封。
   * - plan.response：执行步骤（覆盖 like），完后关 modal 继续；
   * - browse.next：关 modal 继续；
   * - search.execute：关 modal，执行搜索，继续巡航；
   * - session.end：关 modal，停止。
   */
  private async applyDecision(env: Envelope): Promise<boolean> {
    // 统一检查 action 字段：无论导航命令是什么，先执行 like/collect
    const action = (env.payload as { action?: string })?.action;
    if (action === 'like' || action === 'collect') {
      this.logger(`[browse] 执行${action === 'like' ? '点赞' : '收藏'}`);
      await this.executeLikeOrCollect(action);
    }

    switch (env.type) {
      case 'plan.response': {
        const payload = env.payload as PlanResponsePayload;
        const steps = payload?.steps ?? [];
        this.logger(`[browse] 决策=plan（${steps.length} 步）`);
        for (const step of steps) {
          if (this.shouldEndByBudget()) return false;
          await this.humanPause(this.actionTiming);
          try {
            const r = await this.deps.stepRunner.run(step);
            if (r.ok) this.recordBudgetAction(step.actionId);
            this.logger(`[browse] 步骤 ${step.actionId} → ${r.ok ? 'OK' : 'FAIL'}（${r.reason}）`);
          } catch (err) {
            this.logger(`[browse] 步骤 ${step.actionId} 异常：${(err as Error).message}`);
          }
        }
        await this.safeCloseModal();
        return true;
      }
      case 'search.execute': {
        const kw = (env.payload as { keyword?: string })?.keyword ?? '';
        this.logger(`[browse] 决策=search「${kw}」`);
        await this.safeCloseModal();
        if (kw) {
          try {
            await executeSearch(kw, {
              cdp: this.deps.cdp,
              random: this.random,
              sleep: this.sleep,
              logger: this.logger,
            });
            const href = await evalRaw<string>(this.deps.cdp, '(function(){ return location.href; })()');
            this.logger(`[browse] 搜索页已加载: ${href}`);
          } catch (err) {
            this.logger(`[browse] 搜索执行失败：${(err as Error).message}`);
          }
        }
        return true;
      }
      case 'session.end': {
        this.logger('[browse] 决策=session.end，结束会话');
        await this.safeCloseModal();
        return false;
      }
      case 'browse.next':
      default: {
        this.logger(`[browse] 决策=browse.next（${env.type}）`);
        await this.safeCloseModal();
        return true;
      }
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

  /**
   * 在当前打开的 modal 中执行点赞或收藏。
   *
   * 定位策略：使用 `.interactions.engage-bar .like-wrapper` / `.collect-wrapper`
   * 精确选中 modal 底部 engage bar 的按钮（避免匹配到 feed 或评论区按钮）。
   *
   * 判断已操作：检查 SVG use[xlink:href] 是否为 "#liked" / "#collected"。
   * 注意：`.like-active` class 在 XHS 新版中始终存在，不能用于判断状态。
   */
  private async executeLikeOrCollect(action: 'like' | 'collect'): Promise<void> {
    if (this.sessionBudget?.viewOnly) {
      this.logger(`[browse] viewOnly=true，跳过${action === 'like' ? '点赞' : '收藏'}`);
      return;
    }
    if (this.shouldEndByBudget()) return;
    const allowed = await this.deps.client.canDo?.(action).catch((err) => ({
      allowed: false,
      reason: `risk_error:${(err as Error).message}`,
    }));
    if (allowed && !allowed.allowed) {
      this.logger(`[browse] 风控拒绝 ${action}：${allowed.reason ?? 'deny'}`);
      return;
    }
    const wrapperCls = action === 'like' ? 'like-wrapper' : 'collect-wrapper';
    // SVG href: 未操作时 #like / #collect，已操作时 #liked / #collected
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
        const msg = result.error === 'already'
          ? `已${action === 'like' ? '点赞' : '收藏'}，跳过`
          : `按钮未找到 (${result.error})`;
        this.logger(`[browse] ${msg}`);
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
        this.recordBudgetAction(action);
        await this.deps.client.recordRiskAction?.(action).catch((err) => {
          this.logger(`[browse] 风控记录 ${action} 失败：${(err as Error).message}`);
        });
        this.logger(`[browse] ✓ ${action === 'like' ? '点赞' : '收藏'}成功 (${result.x}, ${result.y})`);
      } else {
        this.logger(`[browse] ⚠ ${action} 点击后状态未变化 (href=${afterHref})，可能未生效`);
      }
    } catch (err) {
      this.logger(`[browse] ${action} 执行失败：${(err as Error).message}`);
    }
  }

  private async loadSessionBudget(): Promise<void> {
    if (!this.deps.client.requestSessionBudget) return;
    try {
      this.sessionBudget = await this.deps.client.requestSessionBudget();
      this.sessionStartedAt = this.sessionBudget.startedAt || Date.now();
      this.logger(
        `[browse] 会话预算：level=${this.sessionBudget.quotaLevel}, maxActions=${this.sessionBudget.maxActions}, durationMs=${this.sessionBudget.durationMs}, viewOnly=${this.sessionBudget.viewOnly}`,
      );
    } catch (err) {
      this.logger(`[browse] 获取会话预算失败，使用本地默认限制：${(err as Error).message}`);
    }
  }

  /**
   * 获取当前可见卡片，以结构化 page.cards 协议上报给云端。
   * 云端据此决策下一步操作（open_note / scroll / search / end）。
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
    this.logger(`[browse] 已上报 ${cards.length} 张可见卡片 (page.cards)`);
  }

  /**
   * 打开指定 index 的卡片，提取内容并用 note.detail 协议上报给云端。
   */
  private async openAndReportNote(index: number): Promise<void> {
    const cards = await this.deps.scroller.getVisibleCards();
    const card = cards.find(c => c.position === index) ?? cards[index];
    if (!card) {
      this.logger(`[browse] note.open: 找不到 index=${index} 的卡片`);
      return;
    }
    await this.deps.scroller.openCard(card);
    const opened = await this.deps.modalCtrl.waitForModal(this.modalTimeoutMs);
    if (!opened) {
      this.logger(`[browse] note.open: modal 未打开`);
      return;
    }
    await this.waitForEngageBar();

    let content: import('./note-extractor.js').NoteContent;
    try {
      content = await this.deps.noteExtractor(this.deps.dom);
    } catch (err) {
      this.logger(`[browse] note.open: 提取内容失败：${(err as Error).message}`);
      return;
    }

    // Fallback: 用卡片数据补充
    if (content.likes === 0 && card.likes) {
      const { parseCount } = await import('./note-extractor.js');
      content.likes = parseCount(card.likes);
    }

    // 用 note.detail 上报
    const payload: NoteDetailPayload = {
      noteId: card.noteId ?? `card-${card.position}`,
      title: content.title,
      content: content.body,
      author: content.author,
      likeCount: content.likes,
      collectCount: content.collects,
    };
    this.deps.client.reportNoteDetail?.(payload);
    this.logger(`[browse] note.open: 已上报 note.detail (noteId=${payload.noteId})`);
    this.processed++;
  }

  /** 被动模式下等待 stopRequested 信号（由 session.end 命令或 stop() 触发）。 */
  private async waitForStop(): Promise<void> {
    while (!this.stopRequested) {
      await this.sleep(500);
    }
  }

  private shouldEndByBudget(): boolean {
    if (!this.sessionBudget) return false;
    if (this.actionCount >= this.sessionBudget.maxActions) {
      this.logger(`[browse] 达到会话动作预算 ${this.actionCount}/${this.sessionBudget.maxActions}，停止`);
      return true;
    }
    if (Date.now() - this.sessionStartedAt >= this.sessionBudget.durationMs) {
      this.logger('[browse] 达到会话时长预算，停止');
      return true;
    }
    return false;
  }

  private recordBudgetAction(label: string): void {
    if (!this.sessionBudget) return;
    this.actionCount++;
    this.logger(`[browse] 预算动作 ${label}: ${this.actionCount}/${this.sessionBudget.maxActions}`);
  }

  private async executeFollow(_authorId?: string): Promise<void> {
    if (this.sessionBudget?.viewOnly) {
      this.logger('[browse] viewOnly=true，跳过关注');
      this.deps.client.reportActionCompleted?.({ action: 'follow', ok: false, reason: 'viewOnly' });
      return;
    }
    try {
      // 定位关注按钮
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
      const { evalRaw, dispatchClick } = await import('./cdp-util.js');
      const raw = await evalRaw<string>(this.deps.cdp, js);
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result?.error) {
        const msg = result.error === 'already' ? '已关注，跳过' : `关注按钮未找到 (${result.error})`;
        this.logger(`[browse] ${msg}`);
        this.deps.client.reportActionCompleted?.({ action: 'follow', ok: result.error === 'already', reason: result.error });
        return;
      }
      await this.humanPause(this.actionTiming);
      await dispatchClick(this.deps.cdp, result.x, result.y, { random: this.random });
      await this.sleep(1500);
      this.recordBudgetAction('follow');
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
      await this.deps.cdp.send('Page.navigate', { url: this.exploreUrl });
      await this.waitForCards(10000);
    } else if (targetPage === 'search') {
      // 返回搜索页：用 history.back
      await this.deps.cdp.send('Runtime.evaluate', { expression: 'history.back()' });
      await this.sleep(2000);
    } else {
      // 默认 history.back
      await this.deps.cdp.send('Runtime.evaluate', { expression: 'history.back()' });
      await this.sleep(2000);
    }
    await this.reportVisibleCards();
    this.deps.client.reportActionCompleted?.({ action: 'back', ok: true });
  }

  private async browseNoteImages(_noteId: string): Promise<void> {
    try {
      // 在笔记 modal 中找到图片轮播，模拟滑动浏览
      const js = `(function(){
        var swiper = document.querySelector('.swiper-wrapper') || document.querySelector('.note-slider');
        if (!swiper) return JSON.stringify({count: 0});
        var slides = swiper.querySelectorAll('.swiper-slide, img');
        return JSON.stringify({count: slides.length});
      })()`;
      const { evalRaw } = await import('./cdp-util.js');
      const raw = await evalRaw<string>(this.deps.cdp, js);
      const info = typeof raw === 'string' ? JSON.parse(raw) : { count: 0 };
      const count = info.count || 1;
      // 模拟逐张浏览图片（点击下一张按钮或滑动）
      for (let i = 1; i < count && i < 5; i++) {
        await this.humanPause(this.cardGapTiming);
        // 尝试点击下一张按钮
        await this.deps.cdp.send('Runtime.evaluate', {
          expression: `(function(){ var btn = document.querySelector('.swiper-button-next, .next-btn'); if(btn) btn.click(); })()`
        });
        await this.sleep(800);
      }
      this.logger(`[browse] 浏览了 ${Math.min(count, 5)} 张图片`);
      this.deps.client.reportActionCompleted?.({ action: 'browse_images', ok: true });
    } catch (err) {
      this.logger(`[browse] 浏览图片失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'browse_images', ok: false, reason: (err as Error).message });
    }
  }

  private async scrollNoteComments(_noteId: string): Promise<void> {
    try {
      // 在笔记 modal 中滚动评论区域
      const { evalRaw } = await import('./cdp-util.js');
      // 定位评论区容器并滚动
      const js = `(function(){
        var comments = document.querySelector('.comments-container') || document.querySelector('.note-comment');
        if (!comments) return 'no-comments';
        comments.scrollBy({top: 300, behavior: 'smooth'});
        return 'ok';
      })()`;
      const result = await evalRaw<string>(this.deps.cdp, js);
      if (result === 'no-comments') {
        this.logger('[browse] 未找到评论区容器');
        this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: false, reason: 'no-comments' });
        return;
      }
      // 模拟多次滚动
      for (let i = 0; i < 3; i++) {
        await this.humanPause(this.cardGapTiming);
        await this.deps.cdp.send('Runtime.evaluate', {
          expression: `(function(){ var c = document.querySelector('.comments-container') || document.querySelector('.note-comment'); if(c) c.scrollBy({top: 300, behavior: 'smooth'}); })()`
        });
      }
      this.logger('[browse] 评论区滚动完成');
      this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: true });
    } catch (err) {
      this.logger(`[browse] 滚动评论失败：${(err as Error).message}`);
      this.deps.client.reportActionCompleted?.({ action: 'scroll_comments', ok: false, reason: (err as Error).message });
    }
  }
}

/** NoteContent → NoteContentPayload（v2 结构：截取正文前200字作为摘要） */
function toPayload(c: NoteContent, noteId: string): NoteContentPayload {
  return {
    noteId,
    title: c.title,
    summary: c.body.slice(0, 200),
    likeCount: c.likes,
    collectCount: c.collects,
    author: c.author,
  };
}
