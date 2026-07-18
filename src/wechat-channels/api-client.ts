import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  asWechatChannelsError,
  classifyHttpFailure,
  WechatChannelsError,
} from './error-classifier.js';
import {
  assertWechatRequestDescriptorAvailable,
  serializeWechatRequest,
  WECHAT_CHANNELS_REQUEST_DESCRIPTORS,
  type WechatChannelsEndpoint,
} from './request-descriptors.js';
import {
  parseComments,
  parseDmParticipantInfo,
  parseDmSessions,
  parseDmUpdates,
  parseIdentity,
  parsePosts,
  parseSendAck,
} from './api-schemas.js';
import type {
  WechatComment,
  WechatDmMessage,
  WechatDmParticipantInfo,
  WechatDmSession,
  WechatDmUpdatePage,
  WechatIdentity,
  WechatLoginCode,
  WechatLoginStatus,
  WechatPage,
  WechatPost,
  WechatSendAck,
  WechatSessionMaterial,
} from './types.js';
export type { WechatChannelsEndpoint } from './request-descriptors.js';

export const WECHAT_CHANNELS_API_BASE_URL = 'https://channels.weixin.qq.com' as const;
export const WECHAT_CHANNELS_ENDPOINTS = Object.fromEntries(
  Object.entries(WECHAT_CHANNELS_REQUEST_DESCRIPTORS).map(([endpoint, descriptor]) => [endpoint, descriptor.path]),
) as Readonly<Record<WechatChannelsEndpoint, string | null>>;

export interface WechatChannelsApiClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  maxResponseBytes?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  onSchemaChanged?: (endpoint: WechatChannelsEndpoint, error: WechatChannelsError) => void;
  allowUnverifiedWrites?: boolean;
}

interface PlatformEnvelope {
  body: unknown;
  code: string | number | null;
  message: string | null;
}

export class WechatChannelsApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onSchemaChanged?: (endpoint: WechatChannelsEndpoint, error: WechatChannelsError) => void;
  private readonly allowUnverifiedWrites: boolean;

  constructor(options: WechatChannelsApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = positiveInt(options.timeoutMs, 15_000);
    this.maxRetries = Math.min(3, Math.max(0, Math.floor(options.maxRetries ?? 2)));
    this.maxResponseBytes = positiveInt(options.maxResponseBytes, 2 * 1024 * 1024);
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.nowImpl ?? Date.now;
    this.onSchemaChanged = options.onSchemaChanged;
    this.allowUnverifiedWrites = options.allowUnverifiedWrites === true;
    if (new URL(WECHAT_CHANNELS_API_BASE_URL).protocol !== 'https:') {
      throw new Error('WeChat Channels API base URL must use TLS');
    }
  }

  requestLoginCode(): Promise<WechatLoginCode> {
    return Promise.reject(new WechatChannelsError(
      'schema_changed', 'authLoginCode', 'QR login is owned by the authorized browser sidecar', false, null, false,
    ));
  }

  pollLoginStatus(token: string): Promise<WechatLoginStatus> {
    void token;
    return Promise.reject(new WechatChannelsError(
      'schema_changed', 'authLoginStatus', 'QR login status is owned by the authorized browser sidecar', false, null, false,
    ));
  }

  getIdentity(session: WechatSessionMaterial): Promise<WechatIdentity> {
    return this.call('authData', {}, session, parseIdentity);
  }

  listPosts(session: WechatSessionMaterial, cursor: string | null, limit = 50): Promise<WechatPage<WechatPost>> {
    const page = cursor === null ? 1 : Number(cursor);
    if (!Number.isInteger(page) || page < 1) {
      return Promise.reject(new WechatChannelsError('invalid_command', 'postList', 'Invalid page cursor', false));
    }
    return this.call(
      'postList',
      { currentPage: page, pageSize: limit, userpageType: 0, stickyOrder: false },
      session,
      (body, endpoint) => parsePosts(body, endpoint, page),
    );
  }

  listComments(
    session: WechatSessionMaterial,
    postExternalId: string,
    cursor: string | null,
    limit = 100,
  ): Promise<WechatPage<WechatComment>> {
    void limit;
    return this.call(
      'commentList',
      { lastBuff: cursor ?? '', exportId: postExternalId, commentSelection: false, forMcn: false },
      session,
      (body, endpoint) => parseComments(body, endpoint, postExternalId),
    );
  }

  async listDmSessions(session: WechatSessionMaterial, cursor: string | null, limit = 50): Promise<WechatPage<WechatDmSession>> {
    void limit;
    return this.call('dmHistory', { cookie: cursor ?? '' }, session, parseDmSessions);
  }

  async getDmParticipantInfo(
    session: WechatSessionMaterial,
    sessionExternalIds: readonly string[],
  ): Promise<WechatDmParticipantInfo[]> {
    const uniqueIds = [...new Set(sessionExternalIds.map((id) => id.trim()).filter(Boolean))];
    const participants: WechatDmParticipantInfo[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 50) {
      participants.push(...await this.call(
        'dmSessionInfo',
        { sessionId: uniqueIds.slice(offset, offset + 50) },
        session,
        parseDmParticipantInfo,
      ));
    }
    return participants;
  }

  listDmUpdates(
    session: WechatSessionMaterial,
    cursor: string | null,
    ownIdentityExternalId: string | null,
    limit = 100,
  ): Promise<WechatDmUpdatePage> {
    void limit;
    return this.call(
      'dmHistory',
      { cookie: cursor ?? '' },
      session,
      (body, endpoint) => parseDmUpdates(body, endpoint, ownIdentityExternalId),
    );
  }

  listDmHistory(
    session: WechatSessionMaterial,
    threadExternalId: string,
    cursor: string | null,
    limit = 100,
    ownIdentityExternalId: string | null = null,
  ): Promise<WechatPage<WechatDmMessage>> {
    return this.listDmUpdates(session, cursor, ownIdentityExternalId, limit).then((page) => ({
      items: page.messages.filter((message) => message.threadExternalId === threadExternalId),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }));
  }

  sendComment(
    session: WechatSessionMaterial,
    input: { postExternalId: string; rootExternalId: string; parentExternalId: string; text: string },
  ): Promise<WechatSendAck> {
    return this.call(
      'commentCreate',
      {
        exportId: input.postExternalId,
        rootCommentId: input.rootExternalId,
        replyCommentId: input.parentExternalId,
        content: input.text,
      },
      session,
      parseSendAck,
    );
  }

  async sendDmText(
    session: WechatSessionMaterial,
    input: { threadExternalId: string; fromUsername: string; text: string },
  ): Promise<WechatSendAck> {
    try {
      assertWechatRequestDescriptorAvailable('dmSendText', this.allowUnverifiedWrites);
    } catch (error) {
      this.throwEndpointError('dmSendText', error, false);
    }
    const participant = (await this.getDmParticipantInfo(session, [input.threadExternalId]))
      .find((item) => item.sessionExternalId === input.threadExternalId)?.participant;
    if (!participant) {
      throw new WechatChannelsError(
        'invalid_scope', 'dmSendText', 'DM participant could not be resolved for the selected session', false, null, false,
      );
    }
    return this.call(
      'dmSendText',
      {
        msgPack: {
          sessionId: input.threadExternalId,
          fromUsername: input.fromUsername,
          toUsername: participant.externalId,
          msgType: 1,
          textMsg: { content: input.text },
          cliMsgId: randomUUID(),
        },
      },
      session,
      parseSendAck,
    );
  }

  private async call<T>(
    endpoint: WechatChannelsEndpoint,
    payload: Record<string, unknown>,
    session: WechatSessionMaterial | undefined,
    parse: (body: unknown, endpoint: string) => T,
  ): Promise<T> {
    let platform: PlatformEnvelope;
    try {
      platform = await this.requestJson(endpoint, payload, session);
    } catch (error) {
      this.throwEndpointError(endpoint, error, false);
    }
    try {
      return parse(platform.body, endpoint);
    } catch (error) {
      // Parsing happens only after a platform response exists, so parser-local schema errors
      // must not retain their default pre-dispatch evidence.
      this.throwEndpointError(endpoint, error, true);
    }
  }

  private throwEndpointError(endpoint: WechatChannelsEndpoint, error: unknown, promoteDispatched: boolean): never {
    const classified = asWechatChannelsError(error, endpoint, true);
    const safe = promoteDispatched && !classified.requestDispatched
      ? new WechatChannelsError(
          classified.category,
          classified.endpoint,
          classified.message,
          classified.retryable,
          classified.retryAfterMs,
          true,
          classified.httpStatus,
          classified.platformCode,
        )
      : classified;
    if (safe.category === 'schema_changed') {
      try {
        this.onSchemaChanged?.(endpoint, safe);
      } catch {
        // Circuit-breaker observers cannot replace the stable endpoint error.
      }
    }
    throw safe;
  }

  private async requestJson(
    endpoint: WechatChannelsEndpoint,
    payload: Record<string, unknown>,
    session: WechatSessionMaterial | undefined,
  ): Promise<PlatformEnvelope> {
    const retrySafe = WECHAT_CHANNELS_REQUEST_DESCRIPTORS[endpoint].retrySafe;
    const attempts = retrySafe ? this.maxRetries + 1 : 1;
    let lastError: WechatChannelsError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.requestOnce(endpoint, payload, session);
      } catch (error) {
        const safe = asWechatChannelsError(error, endpoint, true);
        lastError = safe;
        if (!retrySafe || !safe.retryable || attempt + 1 >= attempts) throw safe;
        const delay = safe.retryAfterMs ?? Math.min(2_000, 200 * 2 ** attempt);
        await this.sleep(delay);
      }
    }
    throw lastError ?? new WechatChannelsError('internal_error', endpoint, 'Unreachable retry state', false);
  }

  private async requestOnce(
    endpoint: WechatChannelsEndpoint,
    payload: Record<string, unknown>,
    session: WechatSessionMaterial | undefined,
  ): Promise<PlatformEnvelope> {
    if (!session) {
      throw new WechatChannelsError('auth_expired', endpoint, 'Authorized session is required', false, null, false);
    }
    const serialized = serializeWechatRequest(endpoint, payload, session, {
      now: this.now,
      allowUnverifiedWrite: this.allowUnverifiedWrites,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(serialized.url, {
          method: serialized.method,
          headers: serialized.headers,
          body: serialized.body,
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        throw asWechatChannelsError(error, endpoint, true);
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now());
      let text: string;
      try {
        text = await readLimitedText(response, this.maxResponseBytes, endpoint);
      } catch (error) {
        throw asWechatChannelsError(error, endpoint, true);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        if (!response.ok) throw classifyHttpFailure({ endpoint, status: response.status, retryAfterMs, requestDispatched: true });
        throw new WechatChannelsError(
          'transient_network', endpoint, 'WeChat Channels returned a temporary non-JSON response', true,
          null, true, response.status, null,
        );
      }
      const { code, message } = platformStatus(body);
      if (!response.ok || (code !== null && String(code) !== '0')) {
        throw classifyHttpFailure({
          endpoint,
          status: response.status,
          retryAfterMs,
          platformCode: code,
          platformMessage: message,
          requestDispatched: true,
        });
      }
      return { body, code, message };
    } finally {
      clearTimeout(timer);
    }
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function readLimitedText(response: Response, maxBytes: number, endpoint: string): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new WechatChannelsError('transient_network', endpoint, 'WeChat Channels response exceeded the size limit', true, null, true);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WechatChannelsError('transient_network', endpoint, 'WeChat Channels response exceeded the size limit', true, null, true);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function platformStatus(body: unknown): { code: string | number | null; message: string | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { code: null, message: null };
  const root = body as Record<string, unknown>;
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : {};
  const nested = root.baseResp ?? root.base_resp ?? data.baseResp ?? data.base_resp;
  const base = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : {};
  const code = root.errCode ?? root.errcode ?? root.code ?? base.errCode ?? base.errcode ?? base.ret ?? null;
  const messageValue = root.errMsg ?? root.errmsg ?? root.message ?? base.errMsg ?? base.err_msg;
  return {
    code: typeof code === 'string' || typeof code === 'number' ? code : null,
    message: typeof messageValue === 'string' ? messageValue.slice(0, 512) : null,
  };
}

function parseRetryAfter(raw: string | null, now: number): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
