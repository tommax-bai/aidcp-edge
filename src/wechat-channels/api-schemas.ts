import { schemaChanged, WechatChannelsError } from './error-classifier.js';
import type {
  WechatComment,
  WechatDmMessage,
  WechatDmSession,
  WechatIdentity,
  WechatLoginCode,
  WechatLoginStatus,
  WechatPage,
  WechatParticipant,
  WechatPost,
  WechatSendAck,
} from './types.js';

type JsonRecord = Record<string, unknown>;

function rec(value: unknown, endpoint: string, field = 'body'): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw schemaChanged(endpoint, field);
  return value as JsonRecord;
}

function valueAt(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) if (key in record) return record[key];
  return undefined;
}

function requiredString(record: JsonRecord, keys: readonly string[], endpoint: string, field: string): string {
  const value = valueAt(record, keys);
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw schemaChanged(endpoint, field);
  }
  return String(value).trim();
}

function optionalString(record: JsonRecord, keys: readonly string[]): string | null {
  const value = valueAt(record, keys);
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function epochMs(value: unknown, endpoint: string, field: string): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw schemaChanged(endpoint, field);
  return Math.floor(n < 10_000_000_000 ? n * 1000 : n);
}

function optionalCount(record: JsonRecord, keys: readonly string[]): number | null {
  const value = valueAt(record, keys);
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function pageMeta(data: JsonRecord, endpoint: string): { nextCursor: string | null; hasMore: boolean } {
  const cursorValue = valueAt(data, ['nextCursor', 'next_cursor', 'lastBuffer', 'last_buffer', 'cursor']);
  const nextCursor = cursorValue === undefined || cursorValue === null || cursorValue === '' ? null : String(cursorValue);
  const moreValue = valueAt(data, ['hasMore', 'has_more', 'continueFlag', 'continue_flag']);
  if (![true, false, 0, 1, '0', '1'].includes(moreValue as boolean | number | string)) {
    throw schemaChanged(endpoint, 'hasMore');
  }
  const hasMore = moreValue === true || moreValue === 1 || moreValue === '1';
  if (hasMore && nextCursor === null) throw schemaChanged(endpoint, 'nextCursor');
  return { nextCursor, hasMore };
}

function participant(value: unknown, endpoint: string): WechatParticipant | null {
  if (value === undefined || value === null) return null;
  const p = rec(value, endpoint, 'participant');
  return {
    externalId: requiredString(p, ['externalId', 'external_id', 'userId', 'user_id', 'finderUsername', 'finder_username'], endpoint, 'participant.externalId'),
    displayName: optionalString(p, ['displayName', 'display_name', 'nickname', 'nickName']),
    avatarUrl: optionalString(p, ['avatarUrl', 'avatar_url', 'avatar']),
  };
}

function dataRecord(body: unknown, endpoint: string): JsonRecord {
  const root = rec(body, endpoint);
  const data = root.data;
  return data === undefined ? root : rec(data, endpoint, 'data');
}

export function parseIdentity(body: unknown, endpoint: string): WechatIdentity {
  const data = dataRecord(body, endpoint);
  const identityValue = valueAt(data, ['identity', 'finder', 'account']);
  const identity = identityValue && typeof identityValue === 'object' ? rec(identityValue, endpoint, 'identity') : data;
  return {
    externalId: requiredString(identity, ['externalId', 'external_id', 'finderUsername', 'finder_username', 'finderUserName', 'username'], endpoint, 'identity.externalId'),
    displayName: requiredString(identity, ['displayName', 'display_name', 'nickname', 'nickName'], endpoint, 'identity.displayName'),
  };
}

export function parseLoginCode(body: unknown, endpoint: string, now: number): WechatLoginCode {
  const data = dataRecord(body, endpoint);
  const ttl = optionalCount(data, ['expiresIn', 'expires_in', 'ttl']) ?? 300;
  return {
    token: requiredString(data, ['token', 'loginToken', 'login_token', 'qrcodeId', 'qrcode_id'], endpoint, 'loginCode.token'),
    expiresAt: now + ttl * 1000,
  };
}

export function parseLoginStatus(body: unknown, endpoint: string): WechatLoginStatus {
  const data = dataRecord(body, endpoint);
  const raw = requiredString(data, ['status', 'loginStatus', 'login_status'], endpoint, 'loginStatus.status').toLowerCase();
  const mapped = raw === 'waiting' || raw === '0'
    ? 'waiting'
    : raw === 'scanned' || raw === '1'
      ? 'scanned'
      : raw === 'confirmed' || raw === 'success' || raw === '2'
        ? 'confirmed'
        : raw === 'expired' || raw === '3'
          ? 'expired'
          : null;
  if (!mapped) throw schemaChanged(endpoint, 'loginStatus.status');
  return { status: mapped };
}

export function parsePosts(body: unknown, endpoint: string): WechatPage<WechatPost> {
  const data = dataRecord(body, endpoint);
  const rawItems = valueAt(data, ['posts', 'postList', 'post_list', 'list']);
  if (!Array.isArray(rawItems)) throw schemaChanged(endpoint, 'posts');
  const items = rawItems.map((item, index): WechatPost => {
    const p = rec(item, endpoint, `posts[${index}]`);
    const updated = valueAt(p, ['updatedAt', 'updated_at', 'updateTime', 'update_time', 'createTime', 'create_time']);
    return {
      externalId: requiredString(p, ['externalId', 'external_id', 'objectId', 'object_id', 'postId', 'post_id'], endpoint, `posts[${index}].externalId`),
      title: optionalString(p, ['title', 'description', 'desc']),
      coverUrl: optionalString(p, ['coverUrl', 'cover_url', 'cover']),
      updatedAt: epochMs(updated, endpoint, `posts[${index}].updatedAt`),
    };
  });
  return { items, ...pageMeta(data, endpoint) };
}

function parseCommentRecord(value: unknown, endpoint: string, postExternalId: string, indexPath: string): WechatComment {
  const c = rec(value, endpoint, indexPath);
  const created = valueAt(c, ['createdAt', 'created_at', 'createTime', 'create_time']);
  const status = optionalString(c, ['lifecycle', 'status'])?.toLowerCase();
  const lifecycle = status === 'deleted' || status === 'delete' ? 'deleted' : status === 'hidden' ? 'hidden' : 'active';
  const rawReplies = valueAt(c, ['replies', 'replyList', 'reply_list', 'children']);
  if (rawReplies !== undefined && !Array.isArray(rawReplies)) throw schemaChanged(endpoint, `${indexPath}.replies`);
  const externalId = requiredString(c, ['externalId', 'external_id', 'commentId', 'comment_id'], endpoint, `${indexPath}.externalId`);
  const contentText = optionalString(c, ['contentText', 'content_text', 'content', 'text']);
  if (lifecycle === 'active' && contentText === null) throw schemaChanged(endpoint, `${indexPath}.contentText`);
  return {
    externalId,
    postExternalId,
    rootExternalId: optionalString(c, ['rootExternalId', 'root_external_id', 'rootCommentId', 'root_comment_id']) ?? externalId,
    parentExternalId: optionalString(c, ['parentExternalId', 'parent_external_id', 'parentCommentId', 'parent_comment_id']),
    participant: participant(valueAt(c, ['participant', 'user', 'author']), endpoint),
    contentText,
    lifecycle,
    createdAt: epochMs(created, endpoint, `${indexPath}.createdAt`),
    likeCount: optionalCount(c, ['likeCount', 'like_count', 'likes']),
    replies: (rawReplies ?? []).map((reply, index) => parseCommentRecord(reply, endpoint, postExternalId, `${indexPath}.replies[${index}]`)),
  };
}

export function parseComments(body: unknown, endpoint: string, postExternalId: string): WechatPage<WechatComment> {
  const data = dataRecord(body, endpoint);
  const rawItems = valueAt(data, ['comments', 'commentList', 'comment_list', 'list']);
  if (!Array.isArray(rawItems)) throw schemaChanged(endpoint, 'comments');
  return {
    items: rawItems.map((item, index) => parseCommentRecord(item, endpoint, postExternalId, `comments[${index}]`)),
    ...pageMeta(data, endpoint),
  };
}

export function parseDmSessions(body: unknown, endpoint: string): WechatPage<WechatDmSession> {
  const data = dataRecord(body, endpoint);
  const rawItems = valueAt(data, ['sessions', 'sessionList', 'session_list', 'list']);
  if (!Array.isArray(rawItems)) throw schemaChanged(endpoint, 'sessions');
  const items = rawItems.map((item, index): WechatDmSession => {
    const s = rec(item, endpoint, `sessions[${index}]`);
    return {
      externalId: requiredString(s, ['externalId', 'external_id', 'sessionId', 'session_id'], endpoint, `sessions[${index}].externalId`),
      participant: participant(valueAt(s, ['participant', 'user', 'peer']), endpoint),
      updatedAt: epochMs(valueAt(s, ['updatedAt', 'updated_at', 'updateTime', 'update_time', 'lastMessageAt']), endpoint, `sessions[${index}].updatedAt`),
    };
  });
  return { items, ...pageMeta(data, endpoint) };
}

function dmType(raw: unknown): { messageType: WechatDmMessage['messageType']; platformType: string } {
  const platformType = raw === undefined || raw === null ? 'missing' : String(raw);
  const normalized = platformType.toLowerCase();
  if (normalized === 'text' || normalized === 'plain_text') return { messageType: 'text', platformType };
  if (normalized === 'image' || normalized === 'picture') return { messageType: 'image', platformType };
  return { messageType: 'unknown', platformType };
}

export function parseDmMessages(body: unknown, endpoint: string, threadExternalId: string): WechatPage<WechatDmMessage> {
  const data = dataRecord(body, endpoint);
  const rawItems = valueAt(data, ['messages', 'messageList', 'message_list', 'list']);
  if (!Array.isArray(rawItems)) throw schemaChanged(endpoint, 'messages');
  const items = rawItems.map((item, index): WechatDmMessage => {
    const m = rec(item, endpoint, `messages[${index}]`);
    const { messageType, platformType } = dmType(valueAt(m, ['messageType', 'message_type', 'type']));
    const directionRaw = optionalString(m, ['direction', 'messageDirection', 'message_direction', 'senderType'])?.toLowerCase();
    const direction = directionRaw === 'outbound' || directionRaw === 'sent' || directionRaw === 'self'
      ? 'outbound'
      : directionRaw === 'inbound' || directionRaw === 'received' || directionRaw === 'peer' || directionRaw === 'other'
        ? 'inbound'
        : null;
    if (direction === null) throw schemaChanged(endpoint, `messages[${index}].direction`);
    const status = optionalString(m, ['lifecycle', 'status'])?.toLowerCase();
    const lifecycle = status === 'deleted' || status === 'delete' ? 'deleted' : status === 'hidden' ? 'hidden' : 'active';
    const attachmentValue = valueAt(m, ['attachment', 'media', 'image']);
    const attachment = attachmentValue && typeof attachmentValue === 'object' ? rec(attachmentValue, endpoint, `messages[${index}].attachment`) : null;
    const dimension = (value: unknown): number | null => {
      const n = typeof value === 'string' ? Number(value) : value;
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    };
    const contentText = messageType === 'text' ? optionalString(m, ['contentText', 'content_text', 'content', 'text']) : null;
    if (messageType === 'text' && lifecycle === 'active' && contentText === null) {
      throw schemaChanged(endpoint, `messages[${index}].contentText`);
    }
    return {
      externalId: requiredString(m, ['externalId', 'external_id', 'messageId', 'message_id', 'msgId', 'msg_id'], endpoint, `messages[${index}].externalId`),
      threadExternalId,
      direction,
      messageType,
      contentText,
      attachmentMeta: messageType === 'image'
        ? {
            mimeType: attachment ? optionalString(attachment, ['mimeType', 'mime_type']) : null,
            width: attachment ? dimension(valueAt(attachment, ['width'])) : null,
            height: attachment ? dimension(valueAt(attachment, ['height'])) : null,
            url: attachment ? optionalString(attachment, ['url', 'mediaUrl', 'media_url']) : null,
          }
        : null,
      lifecycle,
      createdAt: epochMs(valueAt(m, ['createdAt', 'created_at', 'createTime', 'create_time', 'timestamp']), endpoint, `messages[${index}].createdAt`),
      platformType,
    };
  });
  return { items, ...pageMeta(data, endpoint) };
}

export function parseSendAck(body: unknown, endpoint: string): WechatSendAck {
  const data = dataRecord(body, endpoint);
  const acceptedValue = valueAt(data, ['accepted', 'success', 'ok']);
  if (acceptedValue === undefined) throw schemaChanged(endpoint, 'sendAck.accepted');
  const accepted = acceptedValue === true || acceptedValue === 1 || acceptedValue === '1';
  if (!accepted) throw new WechatChannelsError('platform_rejected', endpoint, 'WeChat Channels did not accept the write', false, null, true);
  return {
    accepted: true,
    externalMessageId: optionalString(data, ['externalMessageId', 'external_message_id', 'messageId', 'message_id', 'commentId', 'comment_id']),
  };
}
