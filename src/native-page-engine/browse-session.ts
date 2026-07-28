import { performance } from 'node:perf_hooks';
import type { EdgeBrowseSession } from '../browse/edge-browse-session.js';
import type { EdgeClient } from '../client/edge-client.js';
import type { CommitWindowGuard } from '../execution/commit-window.js';
import { jitterAround, type RandomFn } from '../humanize/timing.js';
import type {
  ActionCompletedPayload,
  ActionResultPayload,
  Envelope,
  IdentityObservedPayload,
  NoteDetailPayload,
  PageCardsPayload,
  PacingFloorPayload,
  PacingOp,
  ProfileDetailPayload,
} from '../comm/protocol.js';
import {
  facebookFeedVideoViewUiText,
  facebookReadUiText,
  facebookReelViewUiText,
} from '../facebook/companion-ui.js';
import {
  canonicalFacebookFeedVideoPostId,
  canonicalFacebookReelPostId,
  canonicalPostId,
} from '../facebook/post-identity-core.js';
import { nativeActionNameForCommand, nativeCommandForEnvelope } from './command-mapper.js';
import type { NativePageCommandExecution, NativePagePlatform } from './client.js';
import { NativePageRuntime } from './runtime.js';

export interface NativeBrowseSessionOptions {
  runtime: NativePageRuntime;
  client: EdgeClient;
  startupId: string;
  platform?: Extract<NativePagePlatform, 'xiaohongshu' | 'facebook'>;
  edgeId?: string;
  getAccountId?: () => string | undefined;
  logger?: (message: string) => void;
  clock?: () => number;
  random?: RandomFn;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  overlayConfirmMs?: number;
  commitWindow?: CommitWindowGuard;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Native pacing wait aborted'), { code: 'aborted' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('Native pacing wait aborted'), { code: 'aborted' }));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const monotonicNow = (): number => performance.now();
const DEFAULT_NATIVE_COMMAND_TIMEOUT_MS = 30_000;
const FACEBOOK_GROUP_JOIN_TIMEOUT_MS = 90_000;
/**
 * 空关键词首帖开帖的原子上限（change restore-facebook-post-join-comment-continuity）。
 *
 * 该命令内部是一串**串行**有界窗口，最坏路径：群页导航后就绪 8s + 首次探测约 2s +
 * 四轮下滚约 12s + 可选固链导航后就绪 8s + 评论框绑定 12s + 身份回读 20s ≈ 62s。
 * 默认 30s 会在内层窗口跑完之前先到点，把边端一个具名失败改判成外层合成失败——
 * 只放宽内层而不抬这一层等于没改。取值与加群命令同为 90s，避免上限种类膨胀。
 * 普通开帖（带 url / noteId）不受影响，仍取默认值。
 */
const FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS = 90_000;
const FACEBOOK_FIRST_POST_SELECTION = 'first_commentable_group_post';
const FACEBOOK_COMMENT_TIMEOUT_FLOOR_MS = 28_000;
const FACEBOOK_COMMENT_TIMEOUT_BASE_MS = 18_000;
const FACEBOOK_COMMENT_TIMEOUT_PER_CHAR_MS = 220;
const FACEBOOK_COMMENT_TIMEOUT_MAX_MS = 90_000;
const FACEBOOK_COMMENT_RESPONSE_SLACK_MS = 1_000;

/**
 * 就地读停留地板（edge-local 兜底，纯函数便于单测）：按正文字数线性、封顶，再乘 tempo。
 * 量级沿用已退役的 TypeScript 就地读实现，不另起一套；本文件自带一份是为了不把已退役的
 * Facebook 会话模块重新链回生产路径（打包裁剪会把它剔掉，import 它等于把裁剪判据搞坏）。
 */
const INLINE_READ_FLOOR_BASE_MS = 1_200;
const INLINE_READ_FLOOR_PER_CHAR_MS = 20;
const INLINE_READ_FLOOR_CAP_MS = 9_000;

export function computeInlineReadFloorMs(bodyLen: number, tempo: number): number {
  const raw = INLINE_READ_FLOOR_BASE_MS + Math.max(0, bodyLen) * INLINE_READ_FLOOR_PER_CHAR_MS;
  const capped = Math.min(INLINE_READ_FLOOR_CAP_MS, raw);
  return Math.round(capped * (tempo > 0 ? tempo : 1));
}

const FACEBOOK_UNSUPPORTED_COMMANDS = new Set<Envelope['type']>([
  'interaction.collect',
  'interaction.like_comment',
  'note.browse_images',
  'note.scroll_comments',
  'profile.open',
  'notification.open',
  'notification.browse_comments',
  'notification.browse_likes',
  'notification.browse_follows',
  'notification.back_home',
]);

export class NativeBrowseSession implements EdgeBrowseSession {
  private readonly ownerId: string;
  private readonly logger: (message: string) => void;
  private blocked = false;
  private closed = false;
  private running = false;
  private active?: Promise<void>;
  private activeAbort?: AbortController;
  private probeTimer?: NodeJS.Timeout;
  private facebookBlockingKind: 'none' | 'login' | 'captcha' | 'unknown' = 'none';
  private facebookReportedBlockingKind?: 'captcha' | 'unknown';
  private facebookUnknownTimer?: NodeJS.Timeout;
  private lastFacebookBlockingEvidence?: { url?: string; text?: string };
  private lastFacebookCardsAt = 0;
  private readonly facebookReelViewActivityPostIds = new Set<string>();
  private readonly facebookFeedVideoViewActivityPostIds = new Set<string>();
  /** 就地读停留地板的锚点与目标（edge-local）。与云端 dwell 的新卡锚点取 max、绝不相加。 */
  private inlineReadStartedAt = 0;
  private inlineReadFloorMs = 0;
  /** 本次 feed 面开帖的起始时刻；只有真读出内容（note_detail 到达）才会晋升成 read floor 锚点。 */
  private pendingInlineReadStartedAt = 0;
  /** 握手下发的降速系数。只作用于**边缘本地**兜底值（就地读 read floor），不重复乘到云端已算好的时长上。 */
  private pacingTempo = 1;

  constructor(private readonly options: NativeBrowseSessionOptions) {
    this.ownerId = `browse:${options.startupId}`;
    this.logger = options.logger ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.running || this.blocked || this.closed) return;
    this.running = true;
    try {
      await this.executeAndReport({ kind: 'browse_scroll', params: { reason: 'initial_scan' } });
      this.logger(`[native-page] ${this.options.platform ?? 'xiaohongshu'} Native-only browse session ready`);
      this.scheduleProbe();
    } finally {
      this.running = false;
    }
  }

  async onCloudCommand(env: Envelope): Promise<void> {
    if (env.type === 'pacing.update') return;
    const ownedTaskId = this.ownedTaskId(env);
    if (this.closed || (this.blocked && !ownedTaskId)) {
      this.reportFailure(env, 'native_session_quiesced', 'not_started');
      return;
    }
    if (this.options.platform === 'facebook' && FACEBOOK_UNSUPPORTED_COMMANDS.has(env.type)) {
      this.reportFailure(env, 'capability_unsupported', 'not_started');
      return;
    }
    const command = nativeCommandForEnvelope(env, this.options.getAccountId?.());
    if (!command) {
      this.reportFailure(env, 'native_command_not_mapped', 'not_started');
      return;
    }
    const controller = new AbortController();
    this.activeAbort = controller;
    const active = this.executeAndReport(command, ownedTaskId ?? this.ownerId, controller.signal, env);
    this.active = active;
    try {
      await active;
      if (env.type === 'session.end') this.stop();
    } catch (error) {
      const detail = error as { code?: string; detail?: { effectPhase?: string; reasonCode?: string } };
      const phase = detail.detail?.effectPhase;
      this.reportFailure(
        env,
        phase === 'ambiguous' ? 'native_effect_ambiguous' : detail.code ?? 'native_command_failed',
        phase === 'not_started' || phase === 'dispatched' || phase === 'confirmed' || phase === 'ambiguous'
          ? phase
          : 'ambiguous',
      );
      this.logger(`[native-page] ${env.type} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.active === active) this.active = undefined;
      if (this.activeAbort === controller) this.activeAbort = undefined;
    }
  }

  stop(): void {
    this.running = false;
    this.stopProbe();
    this.activeAbort?.abort();
    void this.options.runtime.closeOwner(this.ownerId);
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  async closeAndWait(timeoutMs = 5_000): Promise<boolean> {
    this.closed = true;
    return this.stopAndWait(timeoutMs);
  }

  async stopAndWait(timeoutMs = 5_000): Promise<boolean> {
    this.running = false;
    this.stopProbe();
    this.activeAbort?.abort();
    const drained = await this.waitActive(timeoutMs);
    await this.options.runtime.closeOwner(this.ownerId);
    return drained;
  }

  async quiesceForTask(timeoutMs = 5_000): Promise<number> {
    this.blocked = true;
    this.stopProbe();
    this.activeAbort?.abort();
    if (!(await this.waitActive(timeoutMs))) {
      throw new Error(`Native ${this.options.platform ?? 'xiaohongshu'} command did not reach its atomic boundary before takeover`);
    }
    await this.options.runtime.closeOwner(this.ownerId);
    return 0;
  }

  async resumeAfterTask(): Promise<void> {
    if (this.closed) return;
    this.blocked = false;
    if (this.options.platform === 'facebook') {
      // Facebook task legs are command-driven and may intentionally reuse the current group/post page.
      // Returning home here destroys that handoff; the next explicit feed command restores active_list_url.
      this.scheduleProbe();
      return;
    }
    await this.start();
  }

  discardQueuedCloudCommands(): void {
    this.activeAbort?.abort();
  }

  applyPacingSnapshot(
    _opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>,
    tempo?: number,
  ): void {
    // 云端已把内容 / 状态相关的系数算进随指令下发的 thinkMs / dwellMs，边缘不再重复乘一次。
    // tempo 仍要留：它是**边缘本地兜底值**（这里是就地读 read floor）唯一的降速旋钮。
    if (typeof tempo === 'number' && Number.isFinite(tempo) && tempo > 0) this.pacingTempo = tempo;
    // opFloorsMs 尚未接线：command-pacing 要求的「操作类命令最小间隔 gating」在 Native 路径整体缺失，
    // 属独立一层、单列后续 change 处理。此处不消费不等于此处无事可做——别照着这条注释再判一次「本就该空」。
  }

  async recoverAfterCloudReconnect(): Promise<void> {
    if (!this.blocked && !this.closed) await this.start();
  }

  private async executeAndReport(
    command: Parameters<NativePageRuntime['execute']>[1],
    ownerId = this.ownerId,
    signal?: AbortSignal,
    env?: Envelope,
  ): Promise<void> {
    await this.applyCommandPacing(command, signal);
    // 就地读锚点在犹豫之后、执行之前记：犹豫属于「决定要看」，不属于「正在看这条」。
    this.pendingInlineReadStartedAt =
      this.options.platform === 'facebook'
        && command.kind === 'note_open'
        && (command.params as { surface?: unknown }).surface === 'feed'
        ? (this.options.clock ?? monotonicNow)()
        : 0;
    const timeoutMs = this.facebookCommandTimeoutMs(command);
    const result = await this.options.runtime.execute(
      ownerId,
      command,
      timeoutMs,
      signal,
      this.options.platform === 'facebook' && this.options.commitWindow
        ? (request) => this.options.commitWindow!.enter(request.budgetMs, request.label)
        : undefined,
    );
    this.report(result, env);
  }

  private facebookCommandTimeoutMs(command: Parameters<NativePageRuntime['execute']>[1]): number {
    if (this.options.platform !== 'facebook') return DEFAULT_NATIVE_COMMAND_TIMEOUT_MS;
    if (command.kind === 'group_join') return FACEBOOK_GROUP_JOIN_TIMEOUT_MS;
    if (
      command.kind === 'note_open'
      && command.params.selection === FACEBOOK_FIRST_POST_SELECTION
    ) {
      return FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS;
    }
    if (command.kind !== 'interaction_comment') return DEFAULT_NATIVE_COMMAND_TIMEOUT_MS;
    const body = typeof command.params.text === 'string' ? command.params.text.trim() : '';
    const groupChatCode = typeof command.params.groupChatCode === 'string'
      ? command.params.groupChatCode.trim()
      : '';
    const text = groupChatCode ? `${body}\n${groupChatCode}` : body;
    const cloudBudgetMs = Math.min(
      FACEBOOK_COMMENT_TIMEOUT_MAX_MS,
      Math.max(
        FACEBOOK_COMMENT_TIMEOUT_FLOOR_MS,
        FACEBOOK_COMMENT_TIMEOUT_BASE_MS
          + FACEBOOK_COMMENT_TIMEOUT_PER_CHAR_MS * Array.from(text).length,
      ),
    );
    return cloudBudgetMs - FACEBOOK_COMMENT_RESPONSE_SLACK_MS;
  }

  /**
   * 命令前节奏的**单一入口**：动作前犹豫（thinkMs）与离开内容前的停留（dwellMs / 就地读 read floor）。
   *
   * 合成一个入口是为了让「取 max、不相加」这条判定只有一处：拆成两处等待，两边都会以为自己在保证停留，
   * 实际结果要么相加、要么互相抵消，而这两种错法在日志上长得一样。
   */
  private async applyCommandPacing(
    command: Parameters<NativePageRuntime['execute']>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.applyThinkBefore(command, signal);
    await this.ensureScrollDwell(command, signal);
  }

  /**
   * 动作前犹豫：云端已把 tempo / 状态 / 熟悉度系数算进这个中心值，边缘只叠抖动，MUST NOT 再乘一次 tempo。
   * 收下字段却不等待，等于把云端整层节奏收口悄悄作废——这正是本 change 要修的那类丢弃。
   */
  private async applyThinkBefore(
    command: Parameters<NativePageRuntime['execute']>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    const centerMs = Number((command.params as { thinkMs?: unknown }).thinkMs);
    if (!Number.isFinite(centerMs) || centerMs <= 0) return;
    const waitMs = jitterAround(centerMs, 0.25, this.options.random);
    if (waitMs <= 0) return;
    await (this.options.sleep ?? abortableSleep)(waitMs, signal);
  }

  /**
   * 离开当前内容前的停留。两个锚点各测各的跨度、**取 max 不相加**：
   *  ① 云端 dwellMs，锚在本批卡到达时刻；② 就地读 read floor，锚在就地读开始时刻。
   * 就地读比进详情页快得多，只认 ① 会让长帖读完立刻秒滚。
   */
  private async ensureScrollDwell(
    command: Parameters<NativePageRuntime['execute']>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.options.platform !== 'facebook' || command.kind !== 'page_scroll') return;
    const now = (this.options.clock ?? monotonicNow)();
    let remainingMs = 0;
    const centerMs = Number(command.params.dwellMs);
    if (this.lastFacebookCardsAt > 0 && Number.isFinite(centerMs) && centerMs > 0) {
      const targetMs = jitterAround(centerMs, 0.2, this.options.random);
      remainingMs = Math.max(0, targetMs - Math.max(0, now - this.lastFacebookCardsAt));
    }
    if (this.inlineReadStartedAt > 0) {
      remainingMs = Math.max(remainingMs, this.inlineReadFloorMs - Math.max(0, now - this.inlineReadStartedAt));
      this.inlineReadStartedAt = 0; // 消费一次：绝不让旧锚点留到下一条内容上
      this.inlineReadFloorMs = 0;
    }
    if (remainingMs <= 0) return;
    await (this.options.sleep ?? abortableSleep)(remainingMs, signal);
  }

  private report(execution: NativePageCommandExecution, env?: Envelope): void {
    const output = execution.output;
    if (!output) return;
    const value = output.value as Record<string, unknown>;
    switch (output.kind) {
      case 'page_cards':
        this.options.client.reportPageCards({ ...(value as unknown as PageCardsPayload), startupId: this.options.startupId });
        if (this.options.platform === 'facebook') {
          if (env?.type !== 'search.execute') {
            this.lastFacebookCardsAt = (this.options.clock ?? monotonicNow)();
          }
          this.projectFacebookCardActivity(value as unknown as PageCardsPayload);
          const reels = value.listKind === 'reels';
          this.emitUi({
            kind: 'presence',
            type: 'feed',
            presence: reels ? '正在浏览 Reels 视频流…' : '正在浏览推荐流…',
            loopStage: 'feed',
          });
        }
        if (env?.type === 'search.execute') {
          const cards = Array.isArray(value.cards) ? value.cards : [];
          this.options.client.reportActionCompleted({
            action: 'search',
            ok: true,
            ...this.searchContext(env),
            actuated: true,
            searchOutcome: cards.length > 0 ? 'results_ready' : 'no_results',
            resultCount: cards.length,
          });
        }
        return;
      case 'note_detail':
        this.options.client.reportNoteDetail(value as unknown as NoteDetailPayload);
        if (this.options.platform === 'facebook') {
          // 就地读停留地板：按读到的正文长度定目标，锚点取**就地读开始那一刻**（命令下发前记下的）。
          // 锚在开始而非读完，是为了让展开与轮询已经花掉的时间被计入、只补差额——与 dwell 的
          // 「已过去的时间必须计入」同一口径。地板只在真读成功时才立：读失败（展开无效 / 环境变化）
          // 不产生 note_detail，也就不该压一段停留。
          if (this.pendingInlineReadStartedAt > 0) {
            const body = typeof value.content === 'string' ? value.content : '';
            this.inlineReadFloorMs = computeInlineReadFloorMs(body.length, this.pacingTempo);
            this.inlineReadStartedAt = this.pendingInlineReadStartedAt;
          }
          const postId = canonicalPostId(typeof value.noteId === 'string' ? value.noteId : undefined);
          if (
            !postId
            || (
              !this.facebookReelViewActivityPostIds.has(postId)
              && !this.facebookFeedVideoViewActivityPostIds.has(postId)
            )
          ) {
            this.emitUi({
              kind: 'activity',
              type: 'note_open',
              ...facebookReadUiText(value as unknown as NoteDetailPayload),
              loopStage: 'read',
              statsDelta: { views: 1 },
            });
          }
        }
        return;
      case 'profile_detail':
        this.options.client.reportProfileDetail(value as unknown as ProfileDetailPayload);
        return;
      case 'identity_observation':
        this.options.client.send('identity.observed', value as unknown as IdentityObservedPayload, env?.id);
        return;
      case 'notification_home':
        this.options.client.send('notification.home', value as never);
        return;
      case 'notification_items':
        this.options.client.send('notification.items', value as never);
        return;
      case 'action_receipt':
        this.reportActionReceipt(value, execution, env);
        return;
      case 'action_receipt_with_observation': {
        // 「回执 + 随行观测」：一条命令只能回一个输出，但这两类终局既要让云端的动作角色结案，
        // 又必须把本次真看到的东西送到云端。顺序是契约——观测先、回执后：角色一收到回执就结案，
        // 观测晚到会落在结案之后被漏掉（参考图刷新与联系人名册都只挂在观测上）。
        const noteDetail = value.noteDetail;
        if (noteDetail && typeof noteDetail === 'object') {
          // refreshOnly 由宿主强制置真：这是一次「刷新参考图」的随行快照，
          // 绝不能被云端当成一次新的详情打开而多记一笔浏览。
          this.options.client.reportNoteDetail({
            ...(noteDetail as Record<string, unknown>),
            refreshOnly: true,
          } as unknown as NoteDetailPayload);
        }
        const notificationItems = value.notificationItems;
        if (notificationItems && typeof notificationItems === 'object') {
          this.options.client.send('notification.items', notificationItems as never);
        }
        const receipt = value.receipt;
        if (!receipt || typeof receipt !== 'object') {
          throw new Error('Native browse output action_receipt_with_observation carries no receipt');
        }
        this.reportActionReceipt(receipt as Record<string, unknown>, execution, env);
        return;
      }
      case 'page_probe':
        this.observeFacebookProbe(value);
        return;
      case 'plan_results': {
        const results = Array.isArray(value.results) ? value.results as unknown as ActionResultPayload[] : [];
        for (const result of results) this.options.client.send('action.result', result, env?.id);
        return;
      }
      default:
        throw new Error(`Unexpected Native browse output: ${output.kind}`);
    }
  }

  /**
   * 动作回执的唯一处理段。裸回执与「回执 + 随行观测」共用这一段：
   * `ok = 回执自称成功 且 效果阶段已确认` 这条口径只许存在一份，复制一份就会漂。
   */
  private reportActionReceipt(
    value: Record<string, unknown>,
    execution: NativePageCommandExecution,
    env?: Envelope,
  ): void {
    const receipt = value as {
      action: string;
      ok: boolean;
      reason?: string;
      groupObservation?: unknown;
      observation?: unknown;
    };
    if (this.options.platform === 'facebook') {
      const action = this.diagnosticToken(receipt.action);
      const reason = this.diagnosticToken(receipt.reason ?? execution.reasonCode ?? 'none');
      this.logger(
        `[native-page] action.completed action=${action} ok=${receipt.ok} effectPhase=${execution.effectPhase} reason=${reason}`,
      );
    }
    if (env?.type === 'search.execute') {
      const ok = receipt.ok && execution.effectPhase === 'confirmed';
      if (!ok) {
        this.reportFailure(env, receipt.reason ?? execution.reasonCode, execution.effectPhase);
        return;
      }
      this.options.client.reportActionCompleted({
        action: 'search',
        ok: true,
        ...this.searchContext(env),
        actuated: true,
        searchOutcome: 'results_ready',
        resultCount: Number.isInteger(value.resultCount) && Number(value.resultCount) >= 0
          ? Number(value.resultCount)
          : undefined,
      });
      return;
    }
    const completed = {
      ...receipt,
      ...((receipt.observation === undefined || receipt.observation === null)
        && receipt.groupObservation !== undefined
        && receipt.groupObservation !== null
        ? { observation: receipt.groupObservation }
        : {}),
      ok: receipt.ok && execution.effectPhase === 'confirmed',
    } as ActionCompletedPayload;
    delete (completed as ActionCompletedPayload & { groupObservation?: unknown }).groupObservation;
    this.options.client.reportActionCompleted(completed);
    if (this.options.platform === 'facebook') this.emitFacebookAction(completed);
  }

  private ownedTaskId(env: Envelope): string | undefined {
    const payload = env.payload as { taskId?: unknown } | undefined;
    return typeof payload?.taskId === 'string' && payload.taskId.trim() ? payload.taskId.trim() : undefined;
  }

  private searchContext(env: Envelope): Pick<
    ActionCompletedPayload,
    'activityId' | 'purpose' | 'scope'
  > {
    const payload = (env.payload ?? {}) as {
      activityId?: unknown;
      purpose?: unknown;
      scope?: unknown;
      taskId?: unknown;
    };
    const activityId = typeof payload.activityId === 'string' && payload.activityId.trim()
      ? payload.activityId.trim()
      : env.id;
    const purpose = payload.purpose === 'discovery' || payload.purpose === 'task_targeting' || payload.purpose === 'operator'
      ? payload.purpose
      : typeof payload.taskId === 'string' && payload.taskId.trim()
        ? 'task_targeting'
        : 'discovery';
    const scope = payload.scope === 'container' ? 'container' : 'global';
    return { activityId, purpose, scope };
  }

  private reportFailure(
    env: Envelope,
    reason: string,
    effectPhase: NativePageCommandExecution['effectPhase'],
  ): void {
    if (env.type !== 'search.execute') {
      this.options.client.reportActionCompleted({ action: nativeActionNameForCommand(env.type), ok: false, reason });
      return;
    }
    const actuated = effectPhase !== 'not_started';
    this.options.client.reportActionCompleted({
      action: 'search',
      ok: false,
      reason,
      ...this.searchContext(env),
      actuated,
      searchOutcome: actuated ? 'failed_after_submit' : 'not_submitted',
    });
  }

  private async waitActive(timeoutMs: number): Promise<boolean> {
    const active = this.active;
    if (!active) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const settled = active.then(() => true, () => true);
    try { return await Promise.race([settled, timeout]); } finally { if (timer) clearTimeout(timer); }
  }

  private scheduleProbe(): void {
    if (this.options.platform !== 'facebook' || this.closed || this.blocked || this.probeTimer) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      void this.probeFacebook().finally(() => this.scheduleProbe());
    }, 2_000);
    this.probeTimer.unref?.();
  }

  private stopProbe(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    if (this.facebookUnknownTimer) clearTimeout(this.facebookUnknownTimer);
    this.facebookUnknownTimer = undefined;
  }

  private async probeFacebook(): Promise<void> {
    if (this.closed || this.blocked || this.options.platform !== 'facebook') return;
    try {
      const execution = await this.options.runtime.execute(
        this.ownerId,
        { kind: 'page_probe', params: {} },
        5_000,
      );
      if (execution.output?.kind === 'page_probe') {
        this.observeFacebookProbe(execution.output.value as Record<string, unknown>);
      }
    } catch (error) {
      this.logger(`[native-page] Facebook probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private observeFacebookProbe(value: Record<string, unknown>): void {
    if (this.options.platform !== 'facebook') return;
    const blockingKind = value.blockingKind === 'captcha'
      || value.blockingKind === 'unknown'
      || value.blockingKind === 'login'
      ? value.blockingKind
      : value.pageKind === 'captcha'
        ? 'captcha'
        : value.pageKind === 'login'
          ? 'login'
          : 'none';
    const url = typeof value.origin === 'string'
      ? `${value.origin}${typeof value.path === 'string' ? value.path : ''}`
      : undefined;
    const evidence = typeof value.blockingText === 'string' && value.blockingText.trim()
      ? value.blockingText.trim().slice(0, 1_000)
      : undefined;
    this.lastFacebookBlockingEvidence = { url, text: evidence };
    const previous = this.facebookBlockingKind;
    this.facebookBlockingKind = blockingKind;

    if (blockingKind === 'captcha') {
      if (this.facebookUnknownTimer) clearTimeout(this.facebookUnknownTimer);
      this.facebookUnknownTimer = undefined;
      if (this.facebookReportedBlockingKind !== 'captcha') this.reportFacebookBlocking('captcha');
      return;
    }
    if (blockingKind === 'unknown') {
      if (previous !== 'unknown' && !this.facebookReportedBlockingKind && !this.facebookUnknownTimer) {
        const configuredConfirmMs = this.options.overlayConfirmMs ?? Number(process.env.AIDCP_OVERLAY_CONFIRM_MS ?? 2_000);
        const confirmMs = Number.isFinite(configuredConfirmMs) && configuredConfirmMs >= 0
          ? configuredConfirmMs
          : 2_000;
        this.facebookUnknownTimer = setTimeout(() => {
          this.facebookUnknownTimer = undefined;
          if (this.facebookBlockingKind === 'unknown' && !this.facebookReportedBlockingKind) {
            this.reportFacebookBlocking('unknown');
          }
        }, confirmMs);
        this.facebookUnknownTimer.unref?.();
      }
      return;
    }
    if (this.facebookUnknownTimer) clearTimeout(this.facebookUnknownTimer);
    this.facebookUnknownTimer = undefined;
    if (this.facebookReportedBlockingKind) {
      this.facebookReportedBlockingKind = undefined;
      this.options.client.send('risk.captcha_cleared', {
        edgeId: this.options.edgeId,
        accountId: this.options.getAccountId?.(),
        ...(url ? { url } : {}),
      });
      this.emitUi({
        kind: 'activity',
        type: 'popup_cleared',
        sentence: '阻断已解除，继续浏览',
        presence: '继续浏览…',
      });
    }
  }

  private reportFacebookBlocking(kind: 'captcha' | 'unknown'): void {
    this.facebookReportedBlockingKind = kind;
    const evidence = this.lastFacebookBlockingEvidence;
    this.options.client.send('risk.captcha_detected', {
      edgeId: this.options.edgeId,
      accountId: this.options.getAccountId?.(),
      kind,
      ...(evidence?.url ? { url: evidence.url } : {}),
      ...(evidence?.text ? {
        overlay: {
          kind,
          ...(evidence.url ? { firstDetectedUrl: evidence.url } : {}),
          capturedAt: Date.now(),
          text: evidence.text,
          candidates: [],
        },
      } : {}),
      reason: 'native_page_probe',
    });
    const what = kind === 'captcha' ? '验证码' : '未知阻断/限流';
    this.emitUi({
      kind: 'activity',
      type: 'popup',
      sentence: `遇到${what}，先停一停等处理`,
      presence: `遇到${what}，暂停操作中…`,
    });
  }

  private emitFacebookAction(payload: ActionCompletedPayload): void {
    if (!payload.ok) return;
    if (payload.action === 'like') {
      this.emitUi({
        kind: 'activity',
        type: 'like',
        sentence: '点了个赞',
        presence: '刚点了个赞',
        loopStage: 'interact',
        statsDelta: { likes: 1 },
      });
    } else if (payload.action === 'follow' && payload.reason !== 'already_following') {
      this.emitUi({
        kind: 'activity',
        type: 'follow',
        sentence: '关注了一位作者',
        presence: '刚关注了一位作者',
        loopStage: 'interact',
        statsDelta: { follows: 1 },
      });
    } else if (payload.action === 'comment') {
      this.emitUi({
        kind: 'activity',
        type: 'comment',
        sentence: '发表了一条评论',
        presence: '刚发表了一条评论',
        loopStage: 'interact',
        statsDelta: { comments: 1 },
      });
    } else if (payload.action === 'join_group') {
      this.emitUi({
        kind: 'activity',
        type: 'join_group',
        sentence: '已提交加群操作',
        presence: '刚处理了一个加群任务',
        loopStage: 'interact',
      });
    }
  }

  private projectFacebookCardActivity(payload: PageCardsPayload): void {
    if (payload.listKind === 'reels' && payload.cards.length === 1) {
      const card = payload.cards[0];
      const postId = canonicalFacebookReelPostId(card.noteId);
      if (postId && !this.facebookReelViewActivityPostIds.has(postId)) {
        this.facebookReelViewActivityPostIds.add(postId);
        this.emitUi({
          kind: 'activity',
          type: 'reel_view',
          ...facebookReelViewUiText(card),
          loopStage: 'read',
          statsDelta: { views: 1 },
        });
      }
      return;
    }
    if (payload.listKind !== 'feed') return;

    const videos = payload.cards.filter((card) => card.isVideo === true);
    const card = videos.length === 1 ? videos[0] : undefined;
    const postId = canonicalFacebookFeedVideoPostId(card?.noteId);
    if (!card || !postId || this.facebookFeedVideoViewActivityPostIds.has(postId)) return;
    this.facebookFeedVideoViewActivityPostIds.add(postId);
    this.emitUi({
      kind: 'activity',
      type: 'feed_video_view',
      ...facebookFeedVideoViewUiText(card),
      loopStage: 'read',
      statsDelta: { views: 1 },
    });
  }

  private diagnosticToken(value: unknown): string {
    const token = typeof value === 'string' ? value : 'unknown';
    return /^[a-zA-Z0-9_.:-]{1,96}$/.test(token) ? token : 'non_token_reason';
  }

  private emitUi(event: Record<string, unknown>): void {
    this.logger(`[ui-event] ${JSON.stringify(event)}`);
  }
}
