import type { EdgeBrowseSession } from '../browse/edge-browse-session.js';
import type { EdgeClient } from '../client/edge-client.js';
import type {
  ActionCompletedPayload,
  ActionResultPayload,
  Envelope,
  NoteDetailPayload,
  PageCardsPayload,
  PacingFloorPayload,
  PacingOp,
  ProfileDetailPayload,
} from '../comm/protocol.js';
import { nativeCommandForEnvelope } from './command-mapper.js';
import type { NativePageCommandExecution } from './client.js';
import { NativePageRuntime } from './runtime.js';

export interface NativeBrowseSessionOptions {
  runtime: NativePageRuntime;
  client: EdgeClient;
  startupId: string;
  logger?: (message: string) => void;
}

export class NativeBrowseSession implements EdgeBrowseSession {
  private readonly ownerId: string;
  private readonly logger: (message: string) => void;
  private blocked = false;
  private closed = false;
  private running = false;
  private active?: Promise<void>;
  private activeAbort?: AbortController;

  constructor(private readonly options: NativeBrowseSessionOptions) {
    this.ownerId = `browse:${options.startupId}`;
    this.logger = options.logger ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.running || this.blocked || this.closed) return;
    this.running = true;
    try {
      await this.executeAndReport({ kind: 'browse_scroll', params: { reason: 'initial_scan' } });
      this.logger('[native-page] Xiaohongshu Native-only browse session ready');
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
    const command = nativeCommandForEnvelope(env);
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
    this.activeAbort?.abort();
    const drained = await this.waitActive(timeoutMs);
    await this.options.runtime.closeOwner(this.ownerId);
    return drained;
  }

  async quiesceForTask(timeoutMs = 5_000): Promise<number> {
    this.blocked = true;
    this.activeAbort?.abort();
    if (!(await this.waitActive(timeoutMs))) {
      throw new Error('Native Xiaohongshu command did not reach its atomic boundary before takeover');
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
    const result = await this.options.runtime.execute(ownerId, command, 30_000, signal);
    this.report(result, env);
  }

  private report(execution: NativePageCommandExecution, env?: Envelope): void {
    const output = execution.output;
    if (!output) return;
    const value = output.value as Record<string, unknown>;
    switch (output.kind) {
      case 'page_cards':
        this.options.client.reportPageCards({ ...(value as unknown as PageCardsPayload), startupId: this.options.startupId });
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
        return;
      case 'profile_detail':
        this.options.client.reportProfileDetail(value as unknown as ProfileDetailPayload);
        return;
      case 'notification_home':
        this.options.client.send('notification.home', value as never);
        return;
      case 'notification_items':
        this.options.client.send('notification.items', value as never);
        return;
      case 'action_receipt': {
        const receipt = value as { action: string; ok: boolean; reason?: string };
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
        this.options.client.reportActionCompleted({
          ...receipt,
          ok: receipt.ok && execution.effectPhase === 'confirmed',
        } as ActionCompletedPayload);
        return;
      }
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
      this.options.client.reportActionCompleted({ action: env.type, ok: false, reason });
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
}
