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
import type {
  WechatComment,
  WechatCommentWriteContext,
  WechatDmMessage,
  WechatSessionMaterial,
} from './types.js';

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

interface ActiveReplyFlight {
  attemptId: string;
  promise: Promise<InteractionReplyResultPayload>;
}

const ACTIVE_REPLY_FLIGHTS = new Map<string, ActiveReplyFlight>();

export class WechatReplySender {
  private readonly now: () => number;
  private readonly verificationPages: number;

  constructor(private readonly options: ReplySenderOptions) {
    this.now = options.nowImpl ?? Date.now;
    this.verificationPages = options.verificationPages ?? 3;
  }

  send(command: InteractionReplySendPayload): Promise<InteractionReplyResultPayload> {
    if (!this.scopeMatches(command)) {
      // A foreign scope must never write into this account's idempotency namespace.
      return Promise.resolve(resultFor(command, {
        status: 'failed',
        errorCategory: 'invalid_scope',
        errorCode: 'INTERACTION_SCOPE_MISMATCH',
        verification: 'not_verified',
        finishedAt: this.now(),
      }));
    }
    if (!this.commandValid(command)) {
      return Promise.resolve(this.invalidCommandResult(command));
    }

    const flightKey = `${this.options.accountId}\u0000${command.idempotencyKey}`;
    const active = ACTIVE_REPLY_FLIGHTS.get(flightKey);
    if (active) {
      return active.attemptId === command.attemptId
        ? active.promise
        : Promise.resolve(this.invalidCommandResult(command));
    }

    const promise = this.executeClaimed(command).finally(() => {
      if (ACTIVE_REPLY_FLIGHTS.get(flightKey)?.promise === promise) ACTIVE_REPLY_FLIGHTS.delete(flightKey);
    });
    ACTIVE_REPLY_FLIGHTS.set(flightKey, { attemptId: command.attemptId, promise });
    return promise;
  }

  /** Recovery is verification-only: a missing durable claim is reported and never becomes a platform write. */
  async reconcile(command: InteractionReplySendPayload): Promise<'result_replayed' | 'not_found' | 'binding_conflict'> {
    if (!this.scopeMatches(command) || !this.commandValid(command)) return 'binding_conflict';
    const stored = await this.options.state.inspectReplyExecution(command.idempotencyKey, command.attemptId);
    if (stored.status === 'not_found') return 'not_found';
    if (stored.status === 'conflict') return 'binding_conflict';
    if (stored.status === 'completed') {
      await this.options.state.ensureReplyResultOutbox(stored.result);
      return 'result_replayed';
    }
    if (stored.status === 'executing') {
      const result = await this.reconcileExecuting(command, stored.result);
      await this.options.state.ensureReplyResultOutbox(result);
      return 'result_replayed';
    }
    // `claimed` is durably before the executing marker and therefore before any platform call.
    await this.persistFailure(command, 'transient_network', 'INTERACTION_UPSTREAM_UNAVAILABLE');
    return 'result_replayed';
  }

  private async executeClaimed(command: InteractionReplySendPayload): Promise<InteractionReplyResultPayload> {
    const claim = await this.options.state.claimReplyExecution(
      command.idempotencyKey,
      command.attemptId,
      this.now(),
    );
    if (claim.status === 'conflict') return this.invalidCommandResult(command);
    if (claim.status === 'completed') return claim.result;
    if (claim.status === 'executing') return this.reconcileExecuting(command, claim.result);

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
    let commentWriteContext: WechatCommentWriteContext | null = null;
    if (command.channel === 'comment') {
      commentPostExternalId =
        (await this.options.state.getThreadSource('comment', command.target.threadExternalId)) ?? null;
      if (!commentPostExternalId) {
        return this.persistFailure(command, 'invalid_scope', 'INTERACTION_SCOPE_MISMATCH');
      }
      try {
        commentWriteContext = await this.resolveCommentWriteContext(
          session,
          commentPostExternalId,
          command.target.inboundMessageExternalId,
        );
      } catch (error) {
        const safe = error instanceof WechatChannelsError
          ? error
          : new WechatChannelsError('transient_network', 'commentList', 'Comment context lookup failed', true);
        this.options.auth.markApiFailure(safe);
        return this.persistFailure(command, safe.category, safe.code);
      }
      if (!commentWriteContext) {
        return this.persistFailure(command, 'invalid_scope', 'INTERACTION_SCOPE_MISMATCH');
      }
    }

    const dispatchedAt = this.now();
    const executingResult = resultFor(command, {
      status: 'ambiguous',
      errorCategory: 'transient_network',
      errorCode: 'INTERACTION_UPSTREAM_UNAVAILABLE',
      verification: 'not_verified',
      finishedAt: dispatchedAt,
    });
    // The platform call is allowed only after the claim and executing marker are durably bound together.
    const start = await this.options.state.markReplyExecuting(
      command.idempotencyKey,
      command.attemptId,
      executingResult,
      dispatchedAt,
    );
    if (start.status === 'conflict') return this.invalidCommandResult(command);
    if (start.status === 'completed') return start.result;
    if (start.status === 'executing') return this.reconcileExecuting(command, start.result);

    try {
      const ack = command.channel === 'comment'
          ? await this.options.api.sendComment(session, {
            postExternalId: commentPostExternalId!,
            rootExternalId: command.target.threadExternalId,
            parentExternalId: command.target.parentExternalId ?? command.target.inboundMessageExternalId,
            text: command.content.text,
            writeContext: commentWriteContext!,
          })
        : await this.options.api.sendDmText(session, {
            threadExternalId: command.target.threadExternalId,
            fromUsername: this.options.auth.getSnapshot().identity!.externalId,
            text: command.content.text,
          });
      const confirmed = resultFor(command, {
        status: 'confirmed',
        externalMessageId: ack.externalMessageId,
        verification: 'platform_ack',
        finishedAt: this.now(),
      });
      return this.options.state.completeReplyExecution(
        command.idempotencyKey,
        command.attemptId,
        confirmed,
        this.now(),
      );
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
        return this.options.state.completeReplyExecution(
          command.idempotencyKey,
          command.attemptId,
          failed,
          this.now(),
        );
      }
      const verified = await this.verifyAmbiguous(command, session, commentPostExternalId, dispatchedAt);
      if (verified) {
        return this.options.state.completeReplyExecution(
          command.idempotencyKey,
          command.attemptId,
          verified,
          this.now(),
        );
      }
      const ambiguous = resultFor(command, {
        status: 'ambiguous',
        errorCategory: safe.category === 'schema_changed' ? 'schema_changed' : 'transient_network',
        errorCode: safe.category === 'schema_changed' ? 'WECHAT_SCHEMA_CHANGED' : 'INTERACTION_UPSTREAM_UNAVAILABLE',
        verification: 'not_verified',
        retryAfterMs: safe.retryAfterMs,
        finishedAt: this.now(),
      });
      return this.options.state.completeReplyExecution(
        command.idempotencyKey,
        command.attemptId,
        ambiguous,
        this.now(),
      );
    }
  }

  private async reconcileExecuting(
    command: InteractionReplySendPayload,
    executingResult: InteractionReplyResultPayload,
  ): Promise<InteractionReplyResultPayload> {
    let identityOk = false;
    try {
      identityOk = await this.options.auth.verifyIdentity();
    } catch {
      return executingResult;
    }
    const session = identityOk ? this.options.auth.getSession() : null;
    if (!session) return executingResult;

    let commentPostExternalId: string | null = null;
    if (command.channel === 'comment') {
      commentPostExternalId =
        (await this.options.state.getThreadSource('comment', command.target.threadExternalId)) ?? null;
      if (!commentPostExternalId) return executingResult;
    }

    const verified = await this.verifyAmbiguous(
      command,
      session,
      commentPostExternalId,
      executingResult.finishedAt,
    );
    const recovered = verified ?? resultFor(command, {
      status: 'ambiguous',
      errorCategory: executingResult.errorCategory ?? 'transient_network',
      errorCode: executingResult.errorCode ?? 'INTERACTION_UPSTREAM_UNAVAILABLE',
      verification: 'not_verified',
      retryAfterMs: executingResult.retryAfterMs,
      finishedAt: this.now(),
    });
    return this.options.state.completeReplyExecution(
      command.idempotencyKey,
      command.attemptId,
      recovered,
      this.now(),
    );
  }

  private invalidCommandResult(command: InteractionReplySendPayload): InteractionReplyResultPayload {
    return resultFor(command, {
      status: 'failed',
      errorCategory: 'invalid_command',
      errorCode: 'INTERACTION_VALIDATION_FAILED',
      verification: 'not_verified',
      finishedAt: this.now(),
    });
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
    return this.options.state.completeReplyExecution(
      command.idempotencyKey,
      command.attemptId,
      result,
      this.now(),
    );
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

  private async resolveCommentWriteContext(
    session: WechatSessionMaterial,
    postExternalId: string,
    targetExternalId: string,
  ): Promise<WechatCommentWriteContext | null> {
    const stored = await this.options.state.getCommentWriteContext(targetExternalId);
    if (stored) return stored;

    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let pageNo = 0; pageNo < this.verificationPages; pageNo++) {
      const page = await this.options.api.listComments(session, postExternalId, cursor);
      const target = findCommentByExternalId(page.items, targetExternalId);
      if (target?.writeContext) {
        await this.options.state.putCommentWriteContexts([target.writeContext]);
        return target.writeContext;
      }
      if (!page.hasMore || !page.nextCursor || seen.has(page.nextCursor)) break;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return null;
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
      const page = await this.options.api.listDmHistory(
        session,
        command.target.threadExternalId,
        cursor,
        100,
        this.options.auth.getSnapshot().identity?.externalId ?? null,
      );
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
  return !error.requestDispatched || [
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

function findCommentByExternalId(
  comments: readonly WechatComment[],
  targetExternalId: string,
): WechatComment | null {
  for (const comment of comments) {
    if (comment.externalId === targetExternalId) return comment;
    const nested = findCommentByExternalId(comment.replies, targetExternalId);
    if (nested) return nested;
  }
  return null;
}
