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

/** Sensitive. Instances must never be logged or sent over WS. */
export interface WechatSessionMaterial {
  cookies: WechatCookie[];
  dmCookies?: WechatCookie[];
  userAgent: string;
  acquiredAt: number;
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
  updatedAt: number;
}

export interface WechatParticipant {
  externalId: string;
  displayName: string | null;
  avatarUrl: string | null;
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
  replies: WechatComment[];
}

export interface WechatDmSession {
  externalId: string;
  participant: WechatParticipant | null;
  updatedAt: number;
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
