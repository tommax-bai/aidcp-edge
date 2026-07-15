import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  InteractionChannel,
  InteractionOffboardAckPayload,
  InteractionOffboardCommandPayload,
  InteractionOffboardResultPayload,
  InteractionReplyResultAckPayload,
  InteractionReplyResultPayload,
} from '../comm/protocol.js';
import { resolveWechatStateRoot, runtimeStatePath, type WechatRuntimeScope } from './local-paths.js';

export interface SyncCheckpoint {
  cursor: string | null;
  batchId: string | null;
  updatedAt: number;
}

interface StoredReplyExecution {
  attemptId: string;
  state: 'claimed' | 'executing' | 'completed';
  result: InteractionReplyResultPayload | null;
  updatedAt: number;
}

interface StoredOffboardExecution {
  command: InteractionOffboardCommandPayload;
  state: 'claimed' | 'completed';
  result: InteractionOffboardResultPayload | null;
  updatedAt: number;
}

interface RuntimeState {
  version: 3;
  checkpoints: Record<string, SyncCheckpoint>;
  replies: Record<string, StoredReplyExecution>;
  attempts: Record<string, string>;
  resultOutbox: Record<string, InteractionReplyResultPayload>;
  offboards: Record<string, StoredOffboardExecution>;
  offboardOutbox: Record<string, InteractionOffboardResultPayload>;
  threadSources: Record<string, string | null>;
}

export type ReplyExecutionClaim =
  | { status: 'claimed' }
  | { status: 'executing' | 'completed'; result: InteractionReplyResultPayload }
  | { status: 'conflict' };

export type ReplyExecutionStart =
  | { status: 'started'; result: InteractionReplyResultPayload }
  | { status: 'executing' | 'completed'; result: InteractionReplyResultPayload }
  | { status: 'conflict' };

export type StoredReplyState =
  | { status: 'claimed' }
  | { status: 'executing' | 'completed'; result: InteractionReplyResultPayload }
  | { status: 'not_found' | 'conflict' };

export type OffboardExecutionClaim =
  | { status: 'claimed' }
  | { status: 'completed'; result: InteractionOffboardResultPayload }
  | { status: 'conflict' };

export class WechatRuntimeStateStore {
  private state: RuntimeState = emptyRuntimeState();
  private loaded = false;
  private loadPromise?: Promise<void>;
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(
    scope: WechatRuntimeScope,
    rootDir = resolveWechatStateRoot(),
  ) {
    this.path = runtimeStatePath(rootDir, scope);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.loadFromDisk();
    try {
      await this.loadPromise;
    } catch (error) {
      this.loadPromise = undefined;
      throw error;
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as {
        version?: number;
        checkpoints?: Record<string, SyncCheckpoint>;
        replies?: Record<string, Partial<StoredReplyExecution> & { attemptId?: string }>;
        attempts?: Record<string, string>;
        resultOutbox?: Record<string, InteractionReplyResultPayload>;
        offboards?: Record<string, StoredOffboardExecution>;
        offboardOutbox?: Record<string, InteractionOffboardResultPayload>;
        threadSources?: Record<string, string | null>;
      };
      if ((parsed.version === 1 || parsed.version === 2 || parsed.version === 3) && parsed.checkpoints && parsed.replies && parsed.attempts) {
        const attempts = { ...parsed.attempts };
        const replies: Record<string, StoredReplyExecution> = {};
        for (const [idempotencyKey, stored] of Object.entries(parsed.replies)) {
          if (typeof stored.attemptId !== 'string') continue;
          const state = (parsed.version === 2 || parsed.version === 3) && (
            stored.state === 'claimed' || stored.state === 'executing' || stored.state === 'completed'
          ) ? stored.state : 'completed';
          const result = stored.result ?? null;
          if (state !== 'claimed' && !result) continue;
          replies[idempotencyKey] = {
            attemptId: stored.attemptId,
            state,
            result,
            updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : 0,
          };
          attempts[stored.attemptId] ??= idempotencyKey;
        }
        this.state = {
          version: 3,
          checkpoints: parsed.checkpoints,
          replies,
          attempts,
          resultOutbox: parsed.version === 3 && parsed.resultOutbox
            ? { ...parsed.resultOutbox }
            : Object.fromEntries(Object.values(replies)
              .filter((entry): entry is StoredReplyExecution & { result: InteractionReplyResultPayload } =>
                entry.state === 'completed' && entry.result !== null)
              .map((entry) => [entry.attemptId, entry.result])),
          offboards: parsed.version === 3 && parsed.offboards ? { ...parsed.offboards } : {},
          offboardOutbox: parsed.version === 3 && parsed.offboardOutbox ? { ...parsed.offboardOutbox } : {},
          threadSources: parsed.threadSources ?? {},
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  async getCheckpoint(channel: InteractionChannel, scopeExternalId: string | null): Promise<SyncCheckpoint> {
    await this.waitForMutations();
    return this.state.checkpoints[checkpointKey(channel, scopeExternalId)] ?? { cursor: null, batchId: null, updatedAt: 0 };
  }

  async commitCheckpoint(
    channel: InteractionChannel,
    scopeExternalId: string | null,
    checkpoint: SyncCheckpoint,
  ): Promise<void> {
    await this.mutate((state) => {
      state.checkpoints[checkpointKey(channel, scopeExternalId)] = checkpoint;
    });
  }

  async putThreadSource(
    channel: InteractionChannel,
    externalThreadId: string,
    sourceExternalId: string | null,
  ): Promise<void> {
    await this.mutate((state) => {
      state.threadSources[`${channel}:${externalThreadId}`] = sourceExternalId;
    });
  }

  async getThreadSource(channel: InteractionChannel, externalThreadId: string): Promise<string | null | undefined> {
    await this.waitForMutations();
    return this.state.threadSources[`${channel}:${externalThreadId}`];
  }

  async claimReplyExecution(idempotencyKey: string, attemptId: string, now: number): Promise<ReplyExecutionClaim> {
    return this.mutate((state) => {
      if (replyBindingConflicts(state, idempotencyKey, attemptId)) return { status: 'conflict' };
      const existing = state.replies[idempotencyKey];
      if (existing) {
        if (existing.state === 'claimed') return { status: 'claimed' };
        if (!existing.result) return { status: 'conflict' };
        return { status: existing.state, result: existing.result };
      }
      state.attempts[attemptId] = idempotencyKey;
      state.replies[idempotencyKey] = { attemptId, state: 'claimed', result: null, updatedAt: now };
      return { status: 'claimed' };
    });
  }

  async markReplyExecuting(
    idempotencyKey: string,
    attemptId: string,
    result: InteractionReplyResultPayload,
    now: number,
  ): Promise<ReplyExecutionStart> {
    return this.mutate((state) => {
      if (replyBindingConflicts(state, idempotencyKey, attemptId)) return { status: 'conflict' };
      const existing = state.replies[idempotencyKey];
      if (!existing) return { status: 'conflict' };
      if (existing.state === 'executing' || existing.state === 'completed') {
        if (!existing.result) return { status: 'conflict' };
        return { status: existing.state, result: existing.result };
      }
      existing.state = 'executing';
      existing.result = result;
      existing.updatedAt = now;
      return { status: 'started', result };
    });
  }

  async completeReplyExecution(
    idempotencyKey: string,
    attemptId: string,
    result: InteractionReplyResultPayload,
    now: number,
  ): Promise<InteractionReplyResultPayload> {
    return this.mutate((state) => {
      if (replyBindingConflicts(state, idempotencyKey, attemptId)) throw new Error('attempt_idempotency_conflict');
      if (result.attemptId !== attemptId || result.idempotencyKey !== idempotencyKey) {
        throw new Error('reply_result_binding_conflict');
      }
      const existing = state.replies[idempotencyKey];
      if (!existing) throw new Error('reply_execution_not_claimed');
      if (existing.state === 'completed' && existing.result) {
        state.resultOutbox[attemptId] = existing.result;
        return existing.result;
      }
      existing.state = 'completed';
      existing.result = result;
      existing.updatedAt = now;
      state.resultOutbox[attemptId] = result;
      return result;
    });
  }

  async inspectReplyExecution(idempotencyKey: string, attemptId: string): Promise<StoredReplyState> {
    await this.waitForMutations();
    if (replyBindingConflicts(this.state, idempotencyKey, attemptId)) return { status: 'conflict' };
    const existing = this.state.replies[idempotencyKey];
    if (!existing) return { status: 'not_found' };
    if (existing.state === 'claimed') return { status: 'claimed' };
    if (!existing.result) return { status: 'conflict' };
    return { status: existing.state, result: existing.result };
  }

  async ensureReplyResultOutbox(result: InteractionReplyResultPayload): Promise<void> {
    await this.mutate((state) => {
      const existing = state.replies[result.idempotencyKey];
      if (!existing || existing.attemptId !== result.attemptId || existing.state !== 'completed') {
        throw new Error('reply_result_not_completed');
      }
      state.resultOutbox[result.attemptId] = result;
    });
  }

  async pendingReplyResults(): Promise<InteractionReplyResultPayload[]> {
    await this.waitForMutations();
    return Object.values(this.state.resultOutbox).map((result) => ({ ...result }));
  }

  async acknowledgeReplyResult(ack: InteractionReplyResultAckPayload): Promise<boolean> {
    if (ack.status === 'rejected') return false;
    return this.mutate((state) => {
      const result = state.resultOutbox[ack.attemptId];
      if (!result || result.jobId !== ack.jobId || result.idempotencyKey !== ack.idempotencyKey ||
          result.envKey !== ack.envKey || result.accountId !== ack.accountId || result.platform !== ack.platform) return false;
      delete state.resultOutbox[ack.attemptId];
      return true;
    });
  }

  async claimOffboard(command: InteractionOffboardCommandPayload, now: number): Promise<OffboardExecutionClaim> {
    return this.mutate((state) => {
      const existing = state.offboards[command.offboardId];
      if (existing) {
        if (!sameOffboardScope(existing.command, command)) return { status: 'conflict' };
        if (existing.state === 'completed' && existing.result) {
          if (existing.result.status === 'failed') {
            existing.state = 'claimed';
            existing.result = null;
            existing.updatedAt = now;
            delete state.offboardOutbox[command.offboardId];
            return { status: 'claimed' };
          }
          state.offboardOutbox[command.offboardId] = existing.result;
          return { status: 'completed', result: existing.result };
        }
        return { status: 'claimed' };
      }
      state.offboards[command.offboardId] = { command, state: 'claimed', result: null, updatedAt: now };
      return { status: 'claimed' };
    });
  }

  async completeOffboard(
    command: InteractionOffboardCommandPayload,
    result: InteractionOffboardResultPayload,
    now: number,
  ): Promise<InteractionOffboardResultPayload> {
    return this.mutate((state) => {
      const existing = state.offboards[command.offboardId];
      if (!existing || !sameOffboardScope(existing.command, command)) throw new Error('offboard_scope_conflict');
      if (!sameOffboardResultScope(command, result)) throw new Error('offboard_result_scope_conflict');
      if (existing.state === 'completed' && existing.result) return existing.result;
      existing.state = 'completed';
      existing.result = result;
      existing.updatedAt = now;
      state.offboardOutbox[command.offboardId] = result;
      return result;
    });
  }

  async pendingOffboardResults(): Promise<InteractionOffboardResultPayload[]> {
    await this.waitForMutations();
    return Object.values(this.state.offboardOutbox).map((result) => ({ ...result }));
  }

  async acknowledgeOffboard(ack: InteractionOffboardAckPayload): Promise<boolean> {
    if (ack.status === 'rejected') return false;
    return this.mutate((state) => {
      const result = state.offboardOutbox[ack.offboardId];
      if (!result || result.envKey !== ack.envKey || result.accountId !== ack.accountId || result.platform !== ack.platform) {
        return false;
      }
      delete state.offboardOutbox[ack.offboardId];
      return true;
    });
  }

  async isOffboarded(): Promise<boolean> {
    await this.waitForMutations();
    return Object.values(this.state.offboards).some((entry) => entry.state === 'completed' &&
      (entry.result?.status === 'cleared' || entry.result?.status === 'already_cleared'));
  }

  private async waitForMutations(): Promise<void> {
    await this.load();
    await this.mutationChain;
  }

  private async mutate<T>(update: (state: RuntimeState) => T): Promise<T> {
    await this.load();
    const operation = this.mutationChain.then(async () => {
      const next = cloneRuntimeState(this.state);
      const result = update(next);
      await this.persistState(next);
      this.state = next;
      return result;
    });
    this.mutationChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persistState(state: RuntimeState): Promise<void> {
    const snapshot = `${JSON.stringify(state)}\n`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.path);
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

function emptyRuntimeState(): RuntimeState {
  return { version: 3, checkpoints: {}, replies: {}, attempts: {}, resultOutbox: {},
    offboards: {}, offboardOutbox: {}, threadSources: {} };
}

function cloneRuntimeState(state: RuntimeState): RuntimeState {
  return {
    version: 3,
    checkpoints: { ...state.checkpoints },
    replies: Object.fromEntries(Object.entries(state.replies).map(([key, value]) => [
      key,
      { ...value, result: value.result ? { ...value.result } : null },
    ])),
    attempts: { ...state.attempts },
    resultOutbox: Object.fromEntries(Object.entries(state.resultOutbox).map(([key, value]) => [key, { ...value }])),
    offboards: Object.fromEntries(Object.entries(state.offboards).map(([key, value]) => [key, {
      ...value, command: { ...value.command }, result: value.result ? { ...value.result } : null,
    }])),
    offboardOutbox: Object.fromEntries(Object.entries(state.offboardOutbox).map(([key, value]) => [key, { ...value }])),
    threadSources: { ...state.threadSources },
  };
}

function replyBindingConflicts(state: RuntimeState, idempotencyKey: string, attemptId: string): boolean {
  const attemptOwner = state.attempts[attemptId];
  const reply = state.replies[idempotencyKey];
  return Boolean(
    (attemptOwner && attemptOwner !== idempotencyKey) ||
    (reply && reply.attemptId !== attemptId),
  );
}

function checkpointKey(channel: InteractionChannel, scopeExternalId: string | null): string {
  return `${channel}:${scopeExternalId ?? '__global__'}`;
}

function sameOffboardScope(a: InteractionOffboardCommandPayload, b: InteractionOffboardCommandPayload): boolean {
  return a.offboardId === b.offboardId && a.envKey === b.envKey && a.accountId === b.accountId &&
    a.platform === b.platform && a.reason === b.reason && a.requestedAt === b.requestedAt && a.expiresAt === b.expiresAt;
}

function sameOffboardResultScope(
  command: InteractionOffboardCommandPayload,
  result: InteractionOffboardResultPayload,
): boolean {
  return command.offboardId === result.offboardId && command.envKey === result.envKey &&
    command.accountId === result.accountId && command.platform === result.platform;
}
