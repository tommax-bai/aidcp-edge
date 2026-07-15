import type {
  InteractionEffectiveCapabilities,
  InteractionErrorCode,
  InteractionReplyErrorCategory,
  InteractionReplyResultPayload,
  InteractionReplySendPayload,
} from '../comm/protocol.js';
import type { WechatChannelsApiClient } from './api-client.js';
import type { WechatAuthCoordinator } from './auth-session.js';
import { WechatChannelsError } from './error-classifier.js';
import type { WechatRuntimeStateStore } from './state-store.js';
import type { WechatComment, WechatDmMessage, WechatSessionMaterial } from './types.js';

export interface ReplySenderOptions {
  envKey: string;
  accountId: string;
  api: WechatChannelsApiClient;
  auth: WechatAuthCoordinator;
  state: WechatRuntimeStateStore;
  getCapabilities: () => InteractionEffectiveCapabilities;
  nowImpl?: () => number;
  verificationPages?: number;
}

export class WechatReplySender {
  private readonly now: () => number;
  private readonly verificationPages: number;

  constructor(private readonly options: ReplySenderOptions) {
    this.now = options.nowImpl ?? Date.now;
    this.verificationPages = options.verificationPages ?? 3;
  }

  async send(command: InteractionReplySendPayload): Promise<InteractionReplyResultPayload> {
    if (!this.scopeMatches(command)) {
      // A foreign scope must never write into this account's idempotency namespace.
      return resultFor(command, {
        status: 'failed',
        errorCategory: 'invalid_scope',
        errorCode: 'INTERACTION_SCOPE_MISMATCH',
        verification: 'not_verified',
        finishedAt: this.now(),
      });
    }
    if (!this.commandValid(command)) {
      return resultFor(command, {
        status: 'failed',
        errorCategory: 'invalid_command',
        errorCode: 'INTERACTION_VALIDATION_FAILED',
        verification: 'not_verified',
        finishedAt: this.now(),
      });
    }
    const existing = await this.options.state.getReply(command.idempotencyKey);
    if (existing) return existing.result;
    const existingAttemptKey = await this.options.state.idempotencyKeyForAttempt(command.attemptId);
    if (existingAttemptKey && existingAttemptKey !== command.idempotencyKey) {
      // The attempt is already durably owned by another key; do not mutate either idempotency record.
      return resultFor(command, {
        status: 'failed',
        errorCategory: 'invalid_command',
        errorCode: 'INTERACTION_VALIDATION_FAILED',
        verification: 'not_verified',
        finishedAt: this.now(),
      });
    }
    if (command.expiresAt <= this.now()) {
      return this.persistFailure(command, 'expired_command', 'INTERACTION_VALIDATION_FAILED');
    }
    const capabilities = this.options.getCapabilities();
    if ((command.channel === 'comment' && !capabilities.commentsReply) || (command.channel === 'dm' && !capabilities.dmSendText)) {
      return this.persistFailure(command, 'permission_denied', 'INTERACTION_FEATURE_DISABLED');
    }
    const identityOk = await this.options.auth.verifyIdentity();
    if (!identityOk) {
      const snapshot = this.options.auth.getSnapshot();
      const category: InteractionReplyErrorCategory = snapshot.reasonCode === 'WECHAT_IDENTITY_MISMATCH'
        ? 'identity_mismatch'
        : snapshot.reasonCode === 'WECHAT_CHALLENGE_REQUIRED'
          ? 'challenge_required'
          : 'auth_expired';
      const code: InteractionErrorCode = snapshot.reasonCode === 'WECHAT_IDENTITY_MISMATCH'
        ? 'WECHAT_IDENTITY_MISMATCH'
        : snapshot.reasonCode === 'WECHAT_CHALLENGE_REQUIRED'
          ? 'WECHAT_CHALLENGE_REQUIRED'
          : 'WECHAT_AUTH_REQUIRED';
      return this.persistFailure(command, category, code);
    }
    const session = this.options.auth.getSession();
    if (!session) return this.persistFailure(command, 'auth_expired', 'WECHAT_AUTH_REQUIRED');

    let commentPostExternalId: string | null = null;
    if (command.channel === 'comment') {
      commentPostExternalId =
        (await this.options.state.getThreadSource('comment', command.target.threadExternalId)) ?? null;
      if (!commentPostExternalId) {
        return this.persistFailure(command, 'invalid_scope', 'INTERACTION_SCOPE_MISMATCH');
      }
    }

    const dispatchedAt = this.now();
    // Write-ahead ambiguous result: after this durable point a crash/replay can never call the platform twice.
    await this.options.state.putReply(
      command.idempotencyKey,
      command.attemptId,
      resultFor(command, {
        status: 'ambiguous',
        errorCategory: 'transient_network',
        errorCode: 'INTERACTION_UPSTREAM_UNAVAILABLE',
        verification: 'not_verified',
        finishedAt: dispatchedAt,
      }),
      dispatchedAt,
    );

    try {
      const ack = command.channel === 'comment'
        ? await this.options.api.sendComment(session, {
            postExternalId: commentPostExternalId!,
            parentExternalId: command.target.parentExternalId ?? command.target.inboundMessageExternalId,
            text: command.content.text,
          })
        : await this.options.api.sendDmText(session, {
            threadExternalId: command.target.threadExternalId,
            text: command.content.text,
          });
      const confirmed = resultFor(command, {
        status: 'confirmed',
        externalMessageId: ack.externalMessageId,
        verification: 'platform_ack',
        finishedAt: this.now(),
      });
      await this.options.state.putReply(command.idempotencyKey, command.attemptId, confirmed, this.now());
      return confirmed;
    } catch (error) {
      const safe = error instanceof WechatChannelsError
        ? error
        : new WechatChannelsError('transient_network', 'send', 'Send outcome was not trustworthy', true, null, true);
      this.options.auth.markApiFailure(safe);
      if (isDefinitiveFailure(safe)) {
        const failed = resultFor(command, {
          status: 'failed',
          errorCategory: safe.category,
          errorCode: safe.code,
          retryAfterMs: safe.retryAfterMs,
          verification: 'not_verified',
          finishedAt: this.now(),
        });
        await this.options.state.putReply(command.idempotencyKey, command.attemptId, failed, this.now());
        return failed;
      }
      const verified = await this.verifyAmbiguous(command, session, commentPostExternalId, dispatchedAt);
      if (verified) {
        await this.options.state.putReply(command.idempotencyKey, command.attemptId, verified, this.now());
        return verified;
      }
      const ambiguous = resultFor(command, {
        status: 'ambiguous',
        errorCategory: safe.category === 'schema_changed' ? 'schema_changed' : 'transient_network',
        errorCode: safe.category === 'schema_changed' ? 'WECHAT_SCHEMA_CHANGED' : 'INTERACTION_UPSTREAM_UNAVAILABLE',
        verification: 'not_verified',
        retryAfterMs: safe.retryAfterMs,
        finishedAt: this.now(),
      });
      await this.options.state.putReply(command.idempotencyKey, command.attemptId, ambiguous, this.now());
      return ambiguous;
    }
  }

  private scopeMatches(command: InteractionReplySendPayload): boolean {
    return (
      command.envKey === this.options.envKey &&
      command.accountId === this.options.accountId &&
      command.platform === 'wechat_channels'
    );
  }

  private commandValid(command: InteractionReplySendPayload): boolean {
    return (
      command.content.type === 'text' &&
      command.content.text.trim().length > 0 &&
      command.content.text.length <= 4000
    );
  }

  private async persistFailure(
    command: InteractionReplySendPayload,
    category: InteractionReplyErrorCategory,
    code: InteractionErrorCode,
  ): Promise<InteractionReplyResultPayload> {
    const result = resultFor(command, {
      status: 'failed',
      errorCategory: category,
      errorCode: code,
      verification: 'not_verified',
      finishedAt: this.now(),
    });
    await this.options.state.putReply(command.idempotencyKey, command.attemptId, result, this.now());
    return result;
  }

  private async verifyAmbiguous(
    command: InteractionReplySendPayload,
    session: WechatSessionMaterial,
    commentPostExternalId: string | null,
    dispatchedAt: number,
  ): Promise<InteractionReplyResultPayload | null> {
    try {
      const externalMessageId = command.channel === 'comment'
        ? await this.verifyComment(command, session, commentPostExternalId!, dispatchedAt)
        : await this.verifyDm(command, session, dispatchedAt);
      if (!externalMessageId) return null;
      return resultFor(command, {
        status: 'confirmed',
        externalMessageId,
        verification: command.channel === 'comment' ? 'comment_lookup' : 'history_lookup',
        finishedAt: this.now(),
      });
    } catch {
      return null;
    }
  }

  private async verifyComment(
    command: InteractionReplySendPayload,
    session: WechatSessionMaterial,
    postExternalId: string,
    dispatchedAt: number,
  ): Promise<string | null> {
    let cursor: string | null = null;
    const matches: WechatComment[] = [];
    const ownIdentity = this.options.auth.getSnapshot().identity?.externalId;
    for (let pageNo = 0; pageNo < this.verificationPages; pageNo++) {
      const page = await this.options.api.listComments(session, postExternalId, cursor);
      collectCommentMatches(page.items, matches, {
        text: command.content.text,
        parentExternalId: command.target.parentExternalId ?? command.target.inboundMessageExternalId,
        ownIdentity,
        earliestAt: dispatchedAt - 30_000,
      });
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const unique = [...new Set(matches.map((match) => match.externalId))];
    return unique.length === 1 ? unique[0] : null;
  }

  private async verifyDm(
    command: InteractionReplySendPayload,
    session: WechatSessionMaterial,
    dispatchedAt: number,
  ): Promise<string | null> {
    let cursor: string | null = null;
    const matches: WechatDmMessage[] = [];
    for (let pageNo = 0; pageNo < this.verificationPages; pageNo++) {
      const page = await this.options.api.listDmHistory(session, command.target.threadExternalId, cursor);
      matches.push(
        ...page.items.filter(
          (message) =>
            message.direction === 'outbound' &&
            message.messageType === 'text' &&
            message.contentText === command.content.text &&
            message.createdAt >= dispatchedAt - 30_000,
        ),
      );
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const unique = [...new Set(matches.map((match) => match.externalId))];
    return unique.length === 1 ? unique[0] : null;
  }
}

function isDefinitiveFailure(error: WechatChannelsError): boolean {
  return [
    'auth_expired',
    'challenge_required',
    'identity_mismatch',
    'rate_limited',
    'permission_denied',
    'unsupported_message_type',
    'invalid_scope',
    'invalid_command',
    'expired_command',
    'platform_rejected',
  ].includes(error.category);
}

function resultFor(
  command: InteractionReplySendPayload,
  input: {
    status: 'confirmed' | 'failed' | 'ambiguous';
    externalMessageId?: string | null;
    errorCategory?: InteractionReplyErrorCategory | null;
    errorCode?: InteractionErrorCode | null;
    verification: InteractionReplyResultPayload['verification'];
    retryAfterMs?: number | null;
    finishedAt: number;
  },
): InteractionReplyResultPayload {
  return {
    jobId: command.jobId,
    attemptId: command.attemptId,
    idempotencyKey: command.idempotencyKey,
    envKey: command.envKey,
    accountId: command.accountId,
    platform: 'wechat_channels',
    channel: command.channel,
    status: input.status,
    externalMessageId: input.externalMessageId ?? null,
    errorCategory: input.errorCategory ?? null,
    errorCode: input.errorCode ?? null,
    verification: input.verification,
    retryAfterMs: input.retryAfterMs ?? null,
    finishedAt: input.finishedAt,
  };
}

function collectCommentMatches(
  comments: readonly WechatComment[],
  out: WechatComment[],
  input: { text: string; parentExternalId: string; ownIdentity: string | undefined; earliestAt: number },
): void {
  for (const comment of comments) {
    if (
      comment.contentText === input.text &&
      comment.parentExternalId === input.parentExternalId &&
      comment.createdAt >= input.earliestAt &&
      input.ownIdentity &&
      comment.participant?.externalId === input.ownIdentity
    ) {
      out.push(comment);
    }
    collectCommentMatches(comment.replies, out, input);
  }
}
