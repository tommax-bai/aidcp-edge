import type {
  InteractionAttachmentMeta,
  InteractionMessageLifecycle,
  InteractionMessageType,
} from '../comm/protocol.js';

export interface WechatCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** Sensitive request bootstrap captured from the authorized first-party page and stored encrypted. */
export interface WechatRequestContext {
  version: 1;
  aid: string;
  pageUrl: string;
  commonBody: {
    logFinderId: string;
    logFinderUin: string;
    rawKeyBuff: string;
    pluginSessionId: string | null;
    reqScene: number;
    scene: number;
  };
  headers: {
    fingerprintDeviceId: string;
    wechatUin: string;
  };
}

/** Sensitive. Instances must never be logged or sent over WS. */
export interface WechatSessionMaterial {
  cookies: WechatCookie[];
  dmCookies?: WechatCookie[];
  userAgent: string;
  acquiredAt: number;
  requestContext: WechatRequestContext;
}

export interface WechatIdentity {
  externalId: string;
  displayName: string;
}

export interface WechatPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface WechatPost {
  externalId: string;
  title: string | null;
  coverUrl: string | null;
  updatedAt: number | null;
}

export interface WechatParticipant {
  externalId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * Bounded target snapshot required by the captured comment-create request.
 * Sensitive user content: keep account-local and never project it over WS.
 */
export interface WechatCommentWriteContext {
  levelTwoComment: [];
  commentId: string;
  commentNickname: string;
  commentContent: string;
  commentHeadurl: string;
  commentCreatetime: string;
  commentLikeCount: number;
  lastBuff: string;
  downContinueFlag: number;
  visibleFlag: number;
  readFlag: boolean;
  displayFlag: number;
  username: string;
  blacklistFlag: number;
  likeFlag: number;
}

export interface WechatComment {
  externalId: string;
  postExternalId: string;
  rootExternalId: string | null;
  parentExternalId: string | null;
  participant: WechatParticipant | null;
  contentText: string | null;
  lifecycle: InteractionMessageLifecycle;
  createdAt: number;
  likeCount: number | null;
  writeContext: WechatCommentWriteContext | null;
  replies: WechatComment[];
}

export interface WechatDmSession {
  externalId: string;
  participant: WechatParticipant | null;
  updatedAt: number | null;
}

export interface WechatDmParticipantInfo {
  sessionExternalId: string;
  participant: WechatParticipant;
}

export interface WechatDmMessage {
  externalId: string;
  threadExternalId: string;
  direction: 'inbound' | 'outbound';
  messageType: InteractionMessageType;
  contentText: string | null;
  attachmentMeta: InteractionAttachmentMeta | null;
  lifecycle: InteractionMessageLifecycle;
  createdAt: number;
  platformType: string;
}

export interface WechatDmUpdatePage {
  sessions: WechatDmSession[];
  messages: WechatDmMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface WechatSendAck {
  accepted: boolean;
  externalMessageId: string | null;
}

export interface WechatLoginCode {
  token: string;
  expiresAt: number;
}

export interface WechatLoginStatus {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired';
}
