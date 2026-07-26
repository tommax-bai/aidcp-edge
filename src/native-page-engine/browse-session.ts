import { performance } from 'node:perf_hooks';
import type { EdgeBrowseSession } from '../browse/edge-browse-session.js';
import type { EdgeClient } from '../client/edge-client.js';
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
    await this.start();
  }

  discardQueuedCloudCommands(): void {
    this.activeAbort?.abort();
  }

  applyPacingSnapshot(
    _opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>,
    _tempo?: number,
  ): void {
    // Pacing stays Cloud-owned. Each Native command receives the already-authorized timing fields.
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
    await this.ensureFacebookScrollDwell(command, signal);
    const timeoutMs = this.options.platform === 'facebook' && command.kind === 'group_join'
      ? FACEBOOK_GROUP_JOIN_TIMEOUT_MS
      : DEFAULT_NATIVE_COMMAND_TIMEOUT_MS;
    const result = await this.options.runtime.execute(ownerId, command, timeoutMs, signal);
    this.report(result, env);
  }

  private async ensureFacebookScrollDwell(
    command: Parameters<NativePageRuntime['execute']>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.options.platform !== 'facebook' || command.kind !== 'page_scroll' || this.lastFacebookCardsAt <= 0) return;
    const centerMs = Number(command.params.dwellMs);
    if (!Number.isFinite(centerMs) || centerMs <= 0) return;
    const targetMs = jitterAround(centerMs, 0.2, this.options.random);
    const elapsedMs = Math.max(0, (this.options.clock ?? monotonicNow)() - this.lastFacebookCardsAt);
    const remainingMs = Math.max(0, targetMs - elapsedMs);
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
      case 'action_receipt': {
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
          ...(receipt.observation === undefined && receipt.groupObservation !== undefined
            ? { observation: receipt.groupObservation }
            : {}),
          ok: receipt.ok && execution.effectPhase === 'confirmed',
        } as ActionCompletedPayload;
        delete (completed as ActionCompletedPayload & { groupObservation?: unknown }).groupObservation;
        this.options.client.reportActionCompleted(completed);
        if (this.options.platform === 'facebook') this.emitFacebookAction(completed);
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
