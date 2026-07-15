import { createHash } from 'node:crypto';
import type {
  InteractionAuthReopenPayload,
  InteractionAuthStatusPayload,
  InteractionReplyResultPayload,
  InteractionReplySendPayload,
  InteractionSyncAckPayload,
  InteractionSyncBatchPayload,
  InteractionSyncRequestPayload,
} from '../comm/protocol.js';
import type { InteractionConnector, InteractionTransport } from '../platform/interaction-connector.js';
import type { WechatChannelsApiClient } from './api-client.js';
import type { WechatAuthCoordinator } from './auth-session.js';
import { WechatCommentSynchronizer } from './comment-sync.js';
import { WechatDmSynchronizer } from './dm-sync.js';
import { WechatChannelsError } from './error-classifier.js';
import type { WechatCapabilityState } from './feature-flags.js';
import { WechatReplySender } from './reply-sender.js';
import type { WechatRuntimeStateStore } from './state-store.js';
import { assertMatchingAck } from './sync-common.js';

export interface WechatChannelsConnectorOptions {
  envKey: string;
  accountId: string;
  api: WechatChannelsApiClient;
  auth: WechatAuthCoordinator;
  state: WechatRuntimeStateStore;
  capabilities: WechatCapabilityState;
  transport: InteractionTransport;
  commentSyncIntervalMs?: number;
  dmSyncIntervalMs?: number;
  nowImpl?: () => number;
  logImpl?: (message: string) => void;
}

export class WechatChannelsConnector implements InteractionConnector {
  readonly platform = 'wechat_channels' as const;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly comments: WechatCommentSynchronizer;
  private readonly dms: WechatDmSynchronizer;
  private readonly replies: WechatReplySender;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly syncLocks = new Map<'comment' | 'dm', Promise<void>>();
  private readonly replyLocks = new Set<Promise<InteractionReplyResultPayload>>();
  private readonly pendingBatches = new Map<string, InteractionSyncBatchPayload>();
  private unsubscribeAuth?: () => void;
  private started = false;

  constructor(private readonly options: WechatChannelsConnectorOptions) {
    this.now = options.nowImpl ?? Date.now;
    this.log = options.logImpl ?? ((message) => console.log(message));
    const shared = {
      envKey: options.envKey,
      accountId: options.accountId,
      api: options.api,
      state: options.state,
      getSession: () => this.requireSession(),
      getOwnIdentityExternalId: () => options.auth.getSnapshot().identity?.externalId ?? null,
      publishBatch: (batch: InteractionSyncBatchPayload) => this.publishBatch(batch),
      nowImpl: this.now,
    };
    this.comments = new WechatCommentSynchronizer(shared);
    this.dms = new WechatDmSynchronizer(shared);
    this.replies = new WechatReplySender({
      envKey: options.envKey,
      accountId: options.accountId,
      api: options.api,
      auth: options.auth,
      state: options.state,
      getCapabilities: () => this.getAuthStatus().capabilities,
      nowImpl: this.now,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.options.state.load();
    this.unsubscribeAuth = this.options.auth.onChange(() => this.publishAuthStatus());
    this.publishAuthStatus();
    this.schedule('comment', this.options.commentSyncIntervalMs ?? 60_000);
    this.schedule('dm', this.options.dmSyncIntervalMs ?? 30_000);
    await Promise.allSettled([
      this.runScheduled('comment'),
      this.runScheduled('dm'),
    ]);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = undefined;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    await Promise.allSettled([...this.syncLocks.values(), ...this.replyLocks]);
  }

  getAuthStatus(): InteractionAuthStatusPayload {
    const auth = this.options.auth.getSnapshot();
    const capabilities = this.options.capabilities.effective({
      authActive: auth.status === 'active',
      identityMatches: auth.identityMatches,
    });
    return {
      envKey: this.options.envKey,
      accountId: this.options.accountId,
      platform: 'wechat_channels',
      status: auth.status,
      browserState: auth.browserState,
      capabilities,
      identity: auth.identity
        ? {
            externalId: auth.identity.externalId,
            displayName: auth.identity.displayName,
            identityHash: `sha256:${createHash('sha256')
              .update(`${this.options.envKey}|${this.options.accountId}|${auth.identity.externalId}`, 'utf8')
              .digest('hex')}`,
          }
        : null,
      checkedAt: auth.checkedAt,
      reasonCode: auth.reasonCode,
    };
  }

  async sync(request: InteractionSyncRequestPayload): Promise<void> {
    this.assertScope(request);
    const capability = this.getAuthStatus().capabilities;
    if ((request.channel === 'comment' && !capability.commentsRead) || (request.channel === 'dm' && !capability.dmRead)) {
      throw new WechatChannelsError('permission_denied', 'interaction.sync.request', 'Requested sync capability is disabled', false);
    }
    const previous = this.syncLocks.get(request.channel) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          if (request.channel === 'comment') await this.comments.sync(request);
          else await this.dms.sync(request);
        } catch (error) {
          if (error instanceof WechatChannelsError) this.options.auth.markApiFailure(error);
          this.publishAuthStatus();
          throw error;
        }
      });
    this.syncLocks.set(request.channel, current);
    try {
      await current;
    } finally {
      if (this.syncLocks.get(request.channel) === current) this.syncLocks.delete(request.channel);
    }
  }

  send(command: InteractionReplySendPayload): Promise<InteractionReplyResultPayload> {
    if (!this.started) return Promise.resolve({
      jobId: command.jobId,
      attemptId: command.attemptId,
      idempotencyKey: command.idempotencyKey,
      envKey: command.envKey,
      accountId: command.accountId,
      platform: 'wechat_channels',
      channel: command.channel,
      status: 'failed',
      externalMessageId: null,
      errorCategory: 'invalid_command',
      errorCode: 'INTERACTION_FEATURE_DISABLED',
      verification: 'not_verified',
      retryAfterMs: null,
      finishedAt: this.now(),
    });
    const running = this.replies.send(command);
    this.replyLocks.add(running);
    void running.then(() => this.replyLocks.delete(running), () => this.replyLocks.delete(running));
    return running;
  }

  reconcileReply(command: InteractionReplySendPayload): Promise<'result_replayed' | 'not_found' | 'binding_conflict'> {
    return this.replies.reconcile(command);
  }

  async reopenAuth(request: InteractionAuthReopenPayload): Promise<void> {
    this.assertScope(request);
    await this.options.auth.reopen(request.reason);
    this.publishAuthStatus();
  }

  acceptSyncAck(ack: InteractionSyncAckPayload): void {
    const batch = this.pendingBatches.get(ack.batchId);
    if (!batch) return;
    try {
      assertMatchingAck(batch, ack);
    } catch {
      return;
    }
    this.pendingBatches.delete(ack.batchId);
    void this.commitAcceptedBatch(batch);
  }

  reportStatus(): void {
    this.publishAuthStatus();
  }

  private async publishBatch(batch: InteractionSyncBatchPayload): Promise<InteractionSyncAckPayload> {
    this.pendingBatches.set(batch.batchId, batch);
    try {
      const ack = await this.options.transport.publishSyncBatch(batch);
      assertMatchingAck(batch, ack);
      this.pendingBatches.delete(batch.batchId);
      return ack;
    } catch (error) {
      // Keep the batch for a late active-route ack. The synchronizer will not move its checkpoint yet.
      throw error;
    }
  }

  private publishAuthStatus(): void {
    if (!this.started) return;
    try {
      this.options.transport.publishAuthStatus(this.getAuthStatus());
    } catch {
      this.log('[wechat-channels] auth status not published: transport unavailable');
    }
  }

  private async commitAcceptedBatch(batch: InteractionSyncBatchPayload): Promise<void> {
    await this.options.state.commitCheckpoint(batch.channel, batch.scopeExternalId, {
      cursor: batch.cursorAfter,
      batchId: batch.batchId,
      updatedAt: this.now(),
    });
    if (batch.channel !== 'comment') return;
    for (const thread of batch.threads) {
      if (thread.sourceExternalId) {
        await this.options.state.putThreadSource('comment', thread.externalThreadId, thread.sourceExternalId);
      }
    }
  }

  private schedule(channel: 'comment' | 'dm', intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    const timer = setInterval(() => void this.runScheduled(channel), Math.floor(intervalMs));
    (timer as { unref?: () => void }).unref?.();
    this.timers.push(timer);
  }

  private async runScheduled(channel: 'comment' | 'dm'): Promise<void> {
    if (!this.started) return;
    const caps = this.getAuthStatus().capabilities;
    if ((channel === 'comment' && !caps.commentsRead) || (channel === 'dm' && !caps.dmRead)) return;
    try {
      await this.sync({
        requestId: `scheduled-${channel}-${this.now()}`,
        envKey: this.options.envKey,
        accountId: this.options.accountId,
        platform: 'wechat_channels',
        channel,
        scopeExternalId: null,
        reason: 'scheduled',
        requestedAt: this.now(),
      });
    } catch (error) {
      this.log(
        `[wechat-channels] scheduled ${channel} sync stopped safely: ${
          error instanceof WechatChannelsError ? error.code : 'INTERACTION_INTERNAL_ERROR'
        }`,
      );
    }
  }

  private requireSession(): import('./types.js').WechatSessionMaterial {
    const session = this.options.auth.getSession();
    if (!session) throw new WechatChannelsError('auth_expired', 'session', 'Encrypted API session is unavailable', false);
    return session;
  }

  private assertScope(value: { envKey: string; accountId: string; platform: string }): void {
    if (
      value.envKey !== this.options.envKey ||
      value.accountId !== this.options.accountId ||
      value.platform !== 'wechat_channels'
    ) {
      throw new WechatChannelsError('invalid_scope', 'interaction.command', 'Interaction command scope mismatch', false);
    }
  }
}
