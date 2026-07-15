import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InteractionChannel, InteractionReplyResultPayload } from '../comm/protocol.js';
import { resolveWechatStateRoot, runtimeStatePath, type WechatRuntimeScope } from './local-paths.js';

export interface SyncCheckpoint {
  cursor: string | null;
  batchId: string | null;
  updatedAt: number;
}

interface StoredReplyExecution {
  attemptId: string;
  result: InteractionReplyResultPayload;
  updatedAt: number;
}

interface RuntimeState {
  version: 1;
  checkpoints: Record<string, SyncCheckpoint>;
  replies: Record<string, StoredReplyExecution>;
  attempts: Record<string, string>;
  threadSources: Record<string, string | null>;
}

export class WechatRuntimeStateStore {
  private state: RuntimeState = { version: 1, checkpoints: {}, replies: {}, attempts: {}, threadSources: {} };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(
    scope: WechatRuntimeScope,
    rootDir = resolveWechatStateRoot(),
  ) {
    this.path = runtimeStatePath(rootDir, scope);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as RuntimeState;
      if (parsed.version === 1 && parsed.checkpoints && parsed.replies && parsed.attempts) {
        this.state = { ...parsed, threadSources: parsed.threadSources ?? {} };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  async getCheckpoint(channel: InteractionChannel, scopeExternalId: string | null): Promise<SyncCheckpoint> {
    await this.load();
    return this.state.checkpoints[checkpointKey(channel, scopeExternalId)] ?? { cursor: null, batchId: null, updatedAt: 0 };
  }

  async commitCheckpoint(
    channel: InteractionChannel,
    scopeExternalId: string | null,
    checkpoint: SyncCheckpoint,
  ): Promise<void> {
    await this.load();
    this.state.checkpoints[checkpointKey(channel, scopeExternalId)] = checkpoint;
    await this.persist();
  }

  async getReply(idempotencyKey: string): Promise<StoredReplyExecution | null> {
    await this.load();
    return this.state.replies[idempotencyKey] ?? null;
  }

  async putThreadSource(
    channel: InteractionChannel,
    externalThreadId: string,
    sourceExternalId: string | null,
  ): Promise<void> {
    await this.load();
    this.state.threadSources[`${channel}:${externalThreadId}`] = sourceExternalId;
    await this.persist();
  }

  async getThreadSource(channel: InteractionChannel, externalThreadId: string): Promise<string | null | undefined> {
    await this.load();
    return this.state.threadSources[`${channel}:${externalThreadId}`];
  }

  async idempotencyKeyForAttempt(attemptId: string): Promise<string | null> {
    await this.load();
    return this.state.attempts[attemptId] ?? null;
  }

  async putReply(
    idempotencyKey: string,
    attemptId: string,
    result: InteractionReplyResultPayload,
    now: number,
  ): Promise<void> {
    await this.load();
    const existingAttempt = this.state.attempts[attemptId];
    if (existingAttempt && existingAttempt !== idempotencyKey) throw new Error('attempt_idempotency_conflict');
    this.state.attempts[attemptId] = idempotencyKey;
    this.state.replies[idempotencyKey] = { attemptId, result, updatedAt: now };
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.state)}\n`;
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.path);
      await chmod(this.path, 0o600).catch(() => undefined);
    };
    this.writeChain = this.writeChain.then(write, write);
    return this.writeChain;
  }
}

function checkpointKey(channel: InteractionChannel, scopeExternalId: string | null): string {
  return `${channel}:${scopeExternalId ?? '__global__'}`;
}
