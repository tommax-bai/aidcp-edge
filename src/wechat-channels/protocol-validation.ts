import type {
  Envelope,
  InteractionAuthReopenPayload,
  InteractionAuthStatusPayload,
  InteractionErrorCode,
  InteractionOffboardAckPayload,
  InteractionOffboardCommandPayload,
  InteractionOffboardResultPayload,
  InteractionReplyReconcilePayload,
  InteractionReplyReconcileResultPayload,
  InteractionReplyResultPayload,
  InteractionReplyResultAckPayload,
  InteractionReplySendPayload,
  InteractionSyncAckPayload,
  InteractionSyncBatchPayload,
  InteractionSyncMessage,
  InteractionSyncRequestPayload,
  InteractionSyncThread,
  MessageType,
} from '../comm/protocol.js';

const INTERACTION_TYPES = new Set<MessageType>([
  'interaction.auth.status',
  'interaction.sync.batch',
  'interaction.sync.ack',
  'interaction.reply.result',
  'interaction.reply.result.ack',
  'interaction.reply.reconcile',
  'interaction.reply.reconcile.result',
  'interaction.sync.request',
  'interaction.reply.send',
  'interaction.auth.reopen',
  'interaction.offboard.command',
  'interaction.offboard.result',
  'interaction.offboard.ack',
]);

const ERROR_CODES = new Set<InteractionErrorCode>([
  'INTERACTION_AUTH_REQUIRED',
  'INTERACTION_PERMISSION_DENIED',
  'INTERACTION_NOT_FOUND',
  'INTERACTION_SCOPE_MISMATCH',
  'INTERACTION_VERSION_CONFLICT',
  'INTERACTION_STATE_CONFLICT',
  'INTERACTION_VALIDATION_FAILED',
  'INTERACTION_CONFIG_MISSING',
  'INTERACTION_APPROVAL_REQUIRED',
  'INTERACTION_SEND_AMBIGUOUS',
  'INTERACTION_UNSUPPORTED_MESSAGE_TYPE',
  'INTERACTION_FEATURE_DISABLED',
  'INTERACTION_RATE_LIMITED',
  'INTERACTION_UPSTREAM_UNAVAILABLE',
  'INTERACTION_INTERNAL_ERROR',
  'WECHAT_AUTH_REQUIRED',
  'WECHAT_CHALLENGE_REQUIRED',
  'WECHAT_IDENTITY_MISMATCH',
  'WECHAT_RATE_LIMITED',
  'WECHAT_PERMISSION_DENIED',
  'WECHAT_SCHEMA_CHANGED',
]);

export class InteractionProtocolValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`invalid interaction payload at ${path}: ${message}`);
    this.name = 'InteractionProtocolValidationError';
  }
}

function fail(path: string, message: string): never {
  throw new InteractionProtocolValidationError(path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unexpected property');
  for (const key of keys) if (!(key in value)) fail(`${path}.${key}`, 'required property missing');
}

function str(value: unknown, path: string, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) fail(path, `expected string 1..${max}`);
  return value;
}

function nullableStr(value: unknown, path: string, max = 4096): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > max) fail(path, `expected null or string <=${max}`);
  return value;
}

function nullableUri(value: unknown, path: string): string | null {
  const uri = nullableStr(value, path, 2048);
  if (uri === null) return null;
  try {
    if (!new URL(uri).protocol) fail(path, 'expected absolute URI');
  } catch {
    fail(path, 'expected absolute URI');
  }
  return uri;
}

function timestamp(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(path, 'expected non-negative integer timestamp');
  return value as number;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected boolean');
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `expected one of ${allowed.join(',')}`);
  return value as T;
}

function nullableErrorCode(value: unknown, path: string): InteractionErrorCode | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !ERROR_CODES.has(value as InteractionErrorCode)) fail(path, 'unknown error code');
  return value as InteractionErrorCode;
}

function platform(value: unknown, path: string): 'wechat_channels' {
  if (value !== 'wechat_channels') fail(path, 'expected wechat_channels');
  return 'wechat_channels';
}

function channel(value: unknown, path: string): 'comment' | 'dm' {
  return oneOf(value, ['comment', 'dm'] as const, path);
}

function validateThread(value: unknown, path: string): InteractionSyncThread {
  const v = record(value, path);
  exact(v, ['externalThreadId', 'sourceExternalId', 'sourceTitle', 'sourceCoverUrl', 'participant', 'updatedAt'], path);
  let participant: InteractionSyncThread['participant'] = null;
  if (v.participant !== null) {
    const p = record(v.participant, `${path}.participant`);
    exact(p, ['externalId', 'displayName', 'avatarUrl'], `${path}.participant`);
    participant = {
      externalId: str(p.externalId, `${path}.participant.externalId`),
      displayName: nullableStr(p.displayName, `${path}.participant.displayName`, 4096),
      avatarUrl: nullableUri(p.avatarUrl, `${path}.participant.avatarUrl`),
    };
  }
  return {
    externalThreadId: str(v.externalThreadId, `${path}.externalThreadId`),
    sourceExternalId: nullableStr(v.sourceExternalId, `${path}.sourceExternalId`, 256),
    sourceTitle: nullableStr(v.sourceTitle, `${path}.sourceTitle`),
    sourceCoverUrl: nullableUri(v.sourceCoverUrl, `${path}.sourceCoverUrl`),
    participant,
    updatedAt: timestamp(v.updatedAt, `${path}.updatedAt`),
  };
}

function validateMessage(value: unknown, path: string): InteractionSyncMessage {
  const v = record(value, path);
  exact(
    v,
    [
      'externalThreadId',
      'externalMessageId',
      'direction',
      'externalParentId',
      'externalRootId',
      'messageType',
      'contentText',
      'attachmentMeta',
      'lifecycle',
      'platformCreatedAt',
      'rawMetaSanitized',
    ],
    path,
  );
  let attachmentMeta: InteractionSyncMessage['attachmentMeta'] = null;
  if (v.attachmentMeta !== null) {
    const a = record(v.attachmentMeta, `${path}.attachmentMeta`);
    exact(a, ['mimeType', 'width', 'height', 'url'], `${path}.attachmentMeta`);
    const dimension = (x: unknown, p: string): number | null => {
      if (x === null) return null;
      if (!Number.isInteger(x) || (x as number) < 1 || (x as number) > 50_000) fail(p, 'invalid dimension');
      return x as number;
    };
    attachmentMeta = {
      mimeType: nullableStr(a.mimeType, `${path}.attachmentMeta.mimeType`),
      width: dimension(a.width, `${path}.attachmentMeta.width`),
      height: dimension(a.height, `${path}.attachmentMeta.height`),
      url: nullableUri(a.url, `${path}.attachmentMeta.url`),
    };
  }
  const raw = record(v.rawMetaSanitized, `${path}.rawMetaSanitized`);
  if (Object.keys(raw).length > 32) fail(`${path}.rawMetaSanitized`, 'too many properties');
  for (const [key, item] of Object.entries(raw)) {
    if (!['string', 'number', 'boolean'].includes(typeof item) && item !== null) fail(`${path}.rawMetaSanitized.${key}`, 'unsafe value');
    if (typeof item === 'string' && item.length > 512) fail(`${path}.rawMetaSanitized.${key}`, 'string too long');
    if (typeof item === 'number' && !Number.isFinite(item)) fail(`${path}.rawMetaSanitized.${key}`, 'number must be finite');
  }
  return {
    externalThreadId: str(v.externalThreadId, `${path}.externalThreadId`),
    externalMessageId: str(v.externalMessageId, `${path}.externalMessageId`),
    direction: oneOf(v.direction, ['inbound', 'outbound'] as const, `${path}.direction`),
    externalParentId: nullableStr(v.externalParentId, `${path}.externalParentId`, 256),
    externalRootId: nullableStr(v.externalRootId, `${path}.externalRootId`, 256),
    messageType: oneOf(v.messageType, ['text', 'image', 'unknown'] as const, `${path}.messageType`),
    contentText: nullableStr(v.contentText, `${path}.contentText`),
    attachmentMeta,
    lifecycle: oneOf(v.lifecycle, ['active', 'deleted', 'hidden'] as const, `${path}.lifecycle`),
    platformCreatedAt: timestamp(v.platformCreatedAt, `${path}.platformCreatedAt`),
    rawMetaSanitized: raw as Record<string, string | number | boolean | null>,
  };
}

export function validateInteractionAuthStatus(value: unknown): InteractionAuthStatusPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['envKey', 'accountId', 'platform', 'status', 'browserState', 'capabilities', 'identity', 'checkedAt', 'reasonCode'], path);
  const c = record(v.capabilities, `${path}.capabilities`);
  exact(c, ['commentsRead', 'commentsReply', 'dmRead', 'dmSendText', 'dmSendImage'], `${path}.capabilities`);
  if (c.dmSendImage !== false) fail(`${path}.capabilities.dmSendImage`, 'v1 requires false');
  let identity: InteractionAuthStatusPayload['identity'] = null;
  if (v.identity !== null) {
    const i = record(v.identity, `${path}.identity`);
    exact(i, ['externalId', 'displayName', 'identityHash'], `${path}.identity`);
    const identityHash = str(i.identityHash, `${path}.identity.identityHash`, 71);
    if (!/^sha256:[a-f0-9]{64}$/.test(identityHash)) fail(`${path}.identity.identityHash`, 'invalid sha256 digest');
    identity = {
      externalId: str(i.externalId, `${path}.identity.externalId`),
      displayName: str(i.displayName, `${path}.identity.displayName`),
      identityHash,
    };
  }
  const reasonCode = v.reasonCode === null
    ? null
    : oneOf(
        v.reasonCode,
        [
          'WECHAT_AUTH_REQUIRED',
          'WECHAT_CHALLENGE_REQUIRED',
          'WECHAT_IDENTITY_MISMATCH',
          'WECHAT_RATE_LIMITED',
          'WECHAT_PERMISSION_DENIED',
          'WECHAT_SCHEMA_CHANGED',
          'INTERACTION_FEATURE_DISABLED',
          'INTERACTION_UPSTREAM_UNAVAILABLE',
        ] as const,
        `${path}.reasonCode`,
      );
  return {
    envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`),
    platform: platform(v.platform, `${path}.platform`),
    status: oneOf(v.status, ['login_required', 'authenticating', 'active', 'reauth_required', 'challenge_required', 'degraded', 'disabled'] as const, `${path}.status`),
    browserState: oneOf(v.browserState, ['closed', 'opening', 'open', 'closing', 'unavailable'] as const, `${path}.browserState`),
    capabilities: {
      commentsRead: bool(c.commentsRead, `${path}.capabilities.commentsRead`),
      commentsReply: bool(c.commentsReply, `${path}.capabilities.commentsReply`),
      dmRead: bool(c.dmRead, `${path}.capabilities.dmRead`),
      dmSendText: bool(c.dmSendText, `${path}.capabilities.dmSendText`),
      dmSendImage: false,
    },
    identity,
    checkedAt: timestamp(v.checkedAt, `${path}.checkedAt`),
    reasonCode,
  };
}

export function validateInteractionSyncBatch(value: unknown): InteractionSyncBatchPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['batchId', 'requestId', 'envKey', 'accountId', 'platform', 'channel', 'scopeExternalId', 'cursorBefore', 'cursorAfter', 'hasMore', 'threads', 'messages', 'observedAt'], path);
  if (!Array.isArray(v.threads) || v.threads.length > 200) fail(`${path}.threads`, 'expected array <=200');
  if (!Array.isArray(v.messages) || v.messages.length > 1000) fail(`${path}.messages`, 'expected array <=1000');
  return {
    batchId: str(v.batchId, `${path}.batchId`),
    requestId: nullableStr(v.requestId, `${path}.requestId`, 256),
    envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`),
    platform: platform(v.platform, `${path}.platform`),
    channel: channel(v.channel, `${path}.channel`),
    scopeExternalId: nullableStr(v.scopeExternalId, `${path}.scopeExternalId`, 256),
    cursorBefore: nullableStr(v.cursorBefore, `${path}.cursorBefore`),
    cursorAfter: nullableStr(v.cursorAfter, `${path}.cursorAfter`),
    hasMore: bool(v.hasMore, `${path}.hasMore`),
    threads: v.threads.map((item, index) => validateThread(item, `${path}.threads[${index}]`)),
    messages: v.messages.map((item, index) => validateMessage(item, `${path}.messages[${index}]`)),
    observedAt: timestamp(v.observedAt, `${path}.observedAt`),
  };
}

export function validateInteractionSyncAck(value: unknown): InteractionSyncAckPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['batchId', 'envKey', 'accountId', 'platform', 'channel', 'scopeExternalId', 'status', 'cursorAfter', 'persisted', 'errorCode', 'receivedAt'], path);
  const persisted = record(v.persisted, `${path}.persisted`);
  exact(persisted, ['threads', 'messages'], `${path}.persisted`);
  const count = (item: unknown, p: string): number => {
    if (!Number.isInteger(item) || (item as number) < 0) fail(p, 'expected non-negative integer');
    return item as number;
  };
  const status = oneOf(v.status, ['accepted', 'duplicate', 'rejected'] as const, `${path}.status`);
  const cursorAfter = nullableStr(v.cursorAfter, `${path}.cursorAfter`);
  const errorCode = nullableErrorCode(v.errorCode, `${path}.errorCode`);
  if (status === 'rejected' && (cursorAfter !== null || errorCode === null)) fail(path, 'rejected ack requires null cursor and errorCode');
  if (status !== 'rejected' && errorCode !== null) fail(`${path}.errorCode`, 'successful ack requires null');
  return {
    batchId: str(v.batchId, `${path}.batchId`),
    envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`),
    platform: platform(v.platform, `${path}.platform`),
    channel: channel(v.channel, `${path}.channel`),
    scopeExternalId: nullableStr(v.scopeExternalId, `${path}.scopeExternalId`, 256),
    status,
    cursorAfter,
    persisted: { threads: count(persisted.threads, `${path}.persisted.threads`), messages: count(persisted.messages, `${path}.persisted.messages`) },
    errorCode,
    receivedAt: timestamp(v.receivedAt, `${path}.receivedAt`),
  };
}

export function validateInteractionSyncRequest(value: unknown): InteractionSyncRequestPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['requestId', 'envKey', 'accountId', 'platform', 'channel', 'scopeExternalId', 'reason', 'requestedAt'], path);
  return {
    requestId: str(v.requestId, `${path}.requestId`),
    envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`),
    platform: platform(v.platform, `${path}.platform`),
    channel: channel(v.channel, `${path}.channel`),
    scopeExternalId: nullableStr(v.scopeExternalId, `${path}.scopeExternalId`, 256),
    reason: oneOf(v.reason, ['user_requested', 'resume', 'scheduled', 'recovery'] as const, `${path}.reason`),
    requestedAt: timestamp(v.requestedAt, `${path}.requestedAt`),
  };
}

export function validateInteractionReplySend(value: unknown): InteractionReplySendPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['jobId', 'attemptId', 'idempotencyKey', 'envKey', 'accountId', 'platform', 'channel', 'target', 'content', 'expiresAt'], path);
  const target = record(v.target, `${path}.target`);
  exact(target, ['threadExternalId', 'inboundMessageExternalId', 'parentExternalId'], `${path}.target`);
  const content = record(v.content, `${path}.content`);
  exact(content, ['type', 'text'], `${path}.content`);
  if (content.type !== 'text') fail(`${path}.content.type`, 'v1 supports text only');
  const idempotencyKey = str(v.idempotencyKey, `${path}.idempotencyKey`, 64);
  if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) fail(`${path}.idempotencyKey`, 'expected lowercase sha256');
  const text = str(content.text, `${path}.content.text`, 4000);
  return {
    jobId: str(v.jobId, `${path}.jobId`),
    attemptId: str(v.attemptId, `${path}.attemptId`),
    idempotencyKey,
    envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`),
    platform: platform(v.platform, `${path}.platform`),
    channel: channel(v.channel, `${path}.channel`),
    target: {
      threadExternalId: str(target.threadExternalId, `${path}.target.threadExternalId`),
      inboundMessageExternalId: str(target.inboundMessageExternalId, `${path}.target.inboundMessageExternalId`),
      parentExternalId: nullableStr(target.parentExternalId, `${path}.target.parentExternalId`, 256),
    },
    content: { type: 'text', text },
    expiresAt: timestamp(v.expiresAt, `${path}.expiresAt`),
  };
}

export function validateInteractionReplyResult(value: unknown): InteractionReplyResultPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['jobId', 'attemptId', 'idempotencyKey', 'envKey', 'accountId', 'platform', 'channel', 'status', 'externalMessageId', 'errorCategory', 'errorCode', 'verification', 'retryAfterMs', 'finishedAt'], path);
  const status = oneOf(v.status, ['confirmed', 'failed', 'ambiguous'] as const, `${path}.status`);
  const idempotencyKey = str(v.idempotencyKey, `${path}.idempotencyKey`, 64);
  if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) fail(`${path}.idempotencyKey`, 'expected lowercase sha256');
  const errorCategory = v.errorCategory === null ? null : oneOf(v.errorCategory, ['auth_expired', 'challenge_required', 'identity_mismatch', 'rate_limited', 'permission_denied', 'schema_changed', 'transient_network', 'unsupported_message_type', 'invalid_scope', 'invalid_command', 'expired_command', 'platform_rejected', 'verification_failed', 'internal_error'] as const, `${path}.errorCategory`);
  const errorCode = nullableErrorCode(v.errorCode, `${path}.errorCode`);
  const verification = oneOf(v.verification, ['platform_ack', 'history_lookup', 'comment_lookup', 'not_verified'] as const, `${path}.verification`);
  if (status === 'confirmed' && (errorCategory !== null || errorCode !== null || verification === 'not_verified')) fail(path, 'confirmed result requires verified success and no error');
  if (status !== 'confirmed' && (errorCategory === null || errorCode === null)) fail(path, 'non-confirmed result requires stable error');
  const retryAfterMs = v.retryAfterMs === null ? null : timestamp(v.retryAfterMs, `${path}.retryAfterMs`);
  return {
    jobId: str(v.jobId, `${path}.jobId`),
    attemptId: str(v.attemptId, `${path}.attemptId`),
    idempotencyKey,
    envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`),
    platform: platform(v.platform, `${path}.platform`),
    channel: channel(v.channel, `${path}.channel`),
    status,
    externalMessageId: nullableStr(v.externalMessageId, `${path}.externalMessageId`, 256),
    errorCategory,
    errorCode,
    verification,
    retryAfterMs,
    finishedAt: timestamp(v.finishedAt, `${path}.finishedAt`),
  };
}

export function validateInteractionReplyResultAck(value: unknown): InteractionReplyResultAckPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['jobId', 'attemptId', 'idempotencyKey', 'envKey', 'accountId', 'platform', 'status', 'errorCode', 'receivedAt'], path);
  const idempotencyKey = str(v.idempotencyKey, `${path}.idempotencyKey`, 64);
  if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) fail(`${path}.idempotencyKey`, 'expected lowercase sha256');
  const status = oneOf(v.status, ['accepted', 'duplicate', 'rejected'] as const, `${path}.status`);
  const errorCode = nullableErrorCode(v.errorCode, `${path}.errorCode`);
  if (status === 'rejected' ? errorCode === null : errorCode !== null) fail(path, 'ack errorCode does not match status');
  return {
    jobId: str(v.jobId, `${path}.jobId`), attemptId: str(v.attemptId, `${path}.attemptId`), idempotencyKey,
    envKey: str(v.envKey, `${path}.envKey`), accountId: str(v.accountId, `${path}.accountId`),
    platform: platform(v.platform, `${path}.platform`), status, errorCode,
    receivedAt: timestamp(v.receivedAt, `${path}.receivedAt`),
  };
}

export function validateInteractionReplyReconcile(value: unknown): InteractionReplyReconcilePayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['reconcileId', 'envKey', 'accountId', 'platform', 'attempts', 'requestedAt'], path);
  if (!Array.isArray(v.attempts) || v.attempts.length < 1 || v.attempts.length > 100) {
    fail(`${path}.attempts`, 'expected array 1..100');
  }
  const attempts = v.attempts.map((item, index) => {
    const itemPath = `${path}.attempts[${index}]`;
    const entry = record(item, itemPath);
    exact(entry, ['cloudStatus', 'command'], itemPath);
    return {
      cloudStatus: oneOf(entry.cloudStatus, ['created', 'dispatched', 'ambiguous'] as const, `${itemPath}.cloudStatus`),
      command: validateInteractionReplySend(entry.command),
    };
  });
  return {
    reconcileId: str(v.reconcileId, `${path}.reconcileId`), envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`), platform: platform(v.platform, `${path}.platform`),
    attempts, requestedAt: timestamp(v.requestedAt, `${path}.requestedAt`),
  };
}

export function validateInteractionReplyReconcileResult(value: unknown): InteractionReplyReconcileResultPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['reconcileId', 'envKey', 'accountId', 'platform', 'attempts', 'finishedAt'], path);
  if (!Array.isArray(v.attempts) || v.attempts.length < 1 || v.attempts.length > 100) {
    fail(`${path}.attempts`, 'expected array 1..100');
  }
  const attempts = v.attempts.map((item, index) => {
    const itemPath = `${path}.attempts[${index}]`;
    const entry = record(item, itemPath);
    exact(entry, ['jobId', 'attemptId', 'idempotencyKey', 'state', 'observedAt'], itemPath);
    const idempotencyKey = str(entry.idempotencyKey, `${itemPath}.idempotencyKey`, 64);
    if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) fail(`${itemPath}.idempotencyKey`, 'expected lowercase sha256');
    return {
      jobId: str(entry.jobId, `${itemPath}.jobId`), attemptId: str(entry.attemptId, `${itemPath}.attemptId`),
      idempotencyKey,
      state: oneOf(entry.state, ['result_replayed', 'not_found', 'binding_conflict'] as const, `${itemPath}.state`),
      observedAt: timestamp(entry.observedAt, `${itemPath}.observedAt`),
    };
  });
  return {
    reconcileId: str(v.reconcileId, `${path}.reconcileId`), envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`), platform: platform(v.platform, `${path}.platform`),
    attempts, finishedAt: timestamp(v.finishedAt, `${path}.finishedAt`),
  };
}

export function validateInteractionOffboardCommand(value: unknown): InteractionOffboardCommandPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['offboardId', 'envKey', 'accountId', 'platform', 'reason', 'requestedAt', 'expiresAt'], path);
  const requestedAt = timestamp(v.requestedAt, `${path}.requestedAt`);
  const expiresAt = timestamp(v.expiresAt, `${path}.expiresAt`);
  if (expiresAt < requestedAt) fail(path, 'expiresAt must not precede requestedAt');
  return {
    offboardId: str(v.offboardId, `${path}.offboardId`), envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`), platform: platform(v.platform, `${path}.platform`),
    reason: oneOf(v.reason, ['environment_unbind', 'customer_terminated', 'admin_revoked'] as const, `${path}.reason`),
    requestedAt, expiresAt,
  };
}

export function validateInteractionOffboardResult(value: unknown): InteractionOffboardResultPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['offboardId', 'envKey', 'accountId', 'platform', 'status', 'errorCode', 'finishedAt'], path);
  const status = oneOf(v.status, ['cleared', 'already_cleared', 'failed'] as const, `${path}.status`);
  const errorCode = nullableErrorCode(v.errorCode, `${path}.errorCode`);
  if (status === 'failed' ? errorCode === null : errorCode !== null) fail(path, 'result errorCode does not match status');
  return {
    offboardId: str(v.offboardId, `${path}.offboardId`), envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`), platform: platform(v.platform, `${path}.platform`),
    status, errorCode, finishedAt: timestamp(v.finishedAt, `${path}.finishedAt`),
  };
}

export function validateInteractionOffboardAck(value: unknown): InteractionOffboardAckPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['offboardId', 'envKey', 'accountId', 'platform', 'status', 'errorCode', 'receivedAt'], path);
  const status = oneOf(v.status, ['accepted', 'duplicate', 'rejected'] as const, `${path}.status`);
  const errorCode = nullableErrorCode(v.errorCode, `${path}.errorCode`);
  if (status === 'rejected' ? errorCode === null : errorCode !== null) fail(path, 'ack errorCode does not match status');
  return {
    offboardId: str(v.offboardId, `${path}.offboardId`), envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`), platform: platform(v.platform, `${path}.platform`),
    status, errorCode, receivedAt: timestamp(v.receivedAt, `${path}.receivedAt`),
  };
}

export function validateInteractionAuthReopen(value: unknown): InteractionAuthReopenPayload {
  const path = 'payload';
  const v = record(value, path);
  exact(v, ['requestId', 'envKey', 'accountId', 'platform', 'reason', 'requestedAt'], path);
  return {
    requestId: str(v.requestId, `${path}.requestId`),
    envKey: str(v.envKey, `${path}.envKey`),
    accountId: str(v.accountId, `${path}.accountId`),
    platform: platform(v.platform, `${path}.platform`),
    reason: oneOf(v.reason, ['user_requested', 'auth_expired', 'identity_mismatch', 'challenge_required'] as const, `${path}.reason`),
    requestedAt: timestamp(v.requestedAt, `${path}.requestedAt`),
  };
}

export function isInteractionMessageType(type: string): type is MessageType {
  return INTERACTION_TYPES.has(type as MessageType);
}

export function validateInteractionPayload(type: MessageType, payload: unknown): unknown {
  switch (type) {
    case 'interaction.auth.status': return validateInteractionAuthStatus(payload);
    case 'interaction.sync.batch': return validateInteractionSyncBatch(payload);
    case 'interaction.sync.ack': return validateInteractionSyncAck(payload);
    case 'interaction.reply.result': return validateInteractionReplyResult(payload);
    case 'interaction.reply.result.ack': return validateInteractionReplyResultAck(payload);
    case 'interaction.reply.reconcile': return validateInteractionReplyReconcile(payload);
    case 'interaction.reply.reconcile.result': return validateInteractionReplyReconcileResult(payload);
    case 'interaction.sync.request': return validateInteractionSyncRequest(payload);
    case 'interaction.reply.send': return validateInteractionReplySend(payload);
    case 'interaction.auth.reopen': return validateInteractionAuthReopen(payload);
    case 'interaction.offboard.command': return validateInteractionOffboardCommand(payload);
    case 'interaction.offboard.result': return validateInteractionOffboardResult(payload);
    case 'interaction.offboard.ack': return validateInteractionOffboardAck(payload);
    default: fail('type', 'not an interaction message');
  }
}

export function validateInteractionEnvelope(env: Envelope): Envelope {
  if (env.v !== 2) fail('v', 'expected protocol v2');
  if (!isInteractionMessageType(env.type)) fail('type', 'not an interaction message');
  validateInteractionPayload(env.type, env.payload);
  return env;
}
