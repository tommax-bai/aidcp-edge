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
    if (this.closed || this.blocked) {
      this.options.client.reportActionCompleted({ action: env.type, ok: false, reason: 'native_session_quiesced' });
      return;
    }
    const command = nativeCommandForEnvelope(env);
    if (!command) {
      this.options.client.reportActionCompleted({ action: env.type, ok: false, reason: 'native_command_not_mapped' });
      return;
    }
    const taskId = this.taskId(env);
    const controller = new AbortController();
    this.activeAbort = controller;
    const active = this.executeAndReport(command, taskId, controller.signal, env);
    this.active = active;
    try {
      await active;
      if (env.type === 'session.end') this.stop();
    } catch (error) {
      const detail = error as { code?: string; detail?: { effectPhase?: string; reasonCode?: string } };
      const phase = detail.detail?.effectPhase;
      this.options.client.reportActionCompleted({
        action: env.type,
        ok: false,
        reason: phase === 'ambiguous' ? 'native_effect_ambiguous' : detail.code ?? 'native_command_failed',
      });
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

  private taskId(env: Envelope): string {
    const payload = env.payload as { taskId?: unknown } | undefined;
    return typeof payload?.taskId === 'string' && payload.taskId ? payload.taskId : this.ownerId;
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
