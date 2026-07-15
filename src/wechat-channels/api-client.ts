import { TextDecoder } from 'node:util';
import {
  asWechatChannelsError,
  classifyHttpFailure,
  WechatChannelsError,
} from './error-classifier.js';
import {
  parseComments,
  parseDmMessages,
  parseDmSessions,
  parseIdentity,
  parseLoginCode,
  parseLoginStatus,
  parsePosts,
  parseSendAck,
} from './api-schemas.js';
import type {
  WechatComment,
  WechatDmMessage,
  WechatDmSession,
  WechatIdentity,
  WechatLoginCode,
  WechatLoginStatus,
  WechatPage,
  WechatPost,
  WechatSendAck,
  WechatSessionMaterial,
} from './types.js';

export const WECHAT_CHANNELS_API_BASE_URL = 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin' as const;

export const WECHAT_CHANNELS_ENDPOINTS = {
  authLoginCode: '/auth/auth_login_code',
  authLoginStatus: '/auth/auth_login_status',
  authData: '/auth/auth_data',
  postList: '/post/post_list',
  commentList: '/comment/comment_list',
  commentCreate: '/comment/create_comment',
  dmLoginCookie: '/private-msg/get-login-cookie',
  dmNewMessages: '/private-msg/get-new-msg',
  dmHistory: '/private-msg/get-history-msg',
  dmSendText: '/private-msg/send-private-msg',
  dmUploadMedia: '/private-msg/upload-media-info',
} as const;

export type WechatChannelsEndpoint = keyof typeof WECHAT_CHANNELS_ENDPOINTS;

const READ_ENDPOINTS = new Set<WechatChannelsEndpoint>([
  'authLoginCode',
  'authLoginStatus',
  'authData',
  'postList',
  'commentList',
  'dmLoginCookie',
  'dmNewMessages',
  'dmHistory',
]);

export interface WechatChannelsApiClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  maxResponseBytes?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  onSchemaChanged?: (endpoint: WechatChannelsEndpoint, error: WechatChannelsError) => void;
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

  constructor(options: WechatChannelsApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = positiveInt(options.timeoutMs, 15_000);
    this.maxRetries = Math.min(3, Math.max(0, Math.floor(options.maxRetries ?? 2)));
    this.maxResponseBytes = positiveInt(options.maxResponseBytes, 2 * 1024 * 1024);
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.nowImpl ?? Date.now;
    this.onSchemaChanged = options.onSchemaChanged;
    if (new URL(WECHAT_CHANNELS_API_BASE_URL).protocol !== 'https:') {
      throw new Error('WeChat Channels API base URL must use TLS');
    }
  }

  requestLoginCode(): Promise<WechatLoginCode> {
    return this.call('authLoginCode', {}, undefined, (body, endpoint) => parseLoginCode(body, endpoint, this.now()));
  }

  pollLoginStatus(token: string): Promise<WechatLoginStatus> {
    return this.call('authLoginStatus', { token }, undefined, parseLoginStatus);
  }

  getIdentity(session: WechatSessionMaterial): Promise<WechatIdentity> {
    return this.call('authData', {}, session, parseIdentity);
  }

  listPosts(session: WechatSessionMaterial, cursor: string | null, limit = 50): Promise<WechatPage<WechatPost>> {
    return this.call('postList', { cursor, limit }, session, parsePosts);
  }

  listComments(
    session: WechatSessionMaterial,
    postExternalId: string,
    cursor: string | null,
    limit = 100,
  ): Promise<WechatPage<WechatComment>> {
    return this.call(
      'commentList',
      { objectId: postExternalId, cursor, limit },
      session,
      (body, endpoint) => parseComments(body, endpoint, postExternalId),
    );
  }

  listDmSessions(session: WechatSessionMaterial, cursor: string | null, limit = 50): Promise<WechatPage<WechatDmSession>> {
    return this.call('dmNewMessages', { cursor, limit }, session, parseDmSessions);
  }

  listDmHistory(
    session: WechatSessionMaterial,
    threadExternalId: string,
    cursor: string | null,
    limit = 100,
  ): Promise<WechatPage<WechatDmMessage>> {
    return this.call(
      'dmHistory',
      { sessionId: threadExternalId, cursor, limit },
      session,
      (body, endpoint) => parseDmMessages(body, endpoint, threadExternalId),
    );
  }

  sendComment(
    session: WechatSessionMaterial,
    input: { postExternalId: string; parentExternalId: string; text: string },
  ): Promise<WechatSendAck> {
    return this.call(
      'commentCreate',
      { objectId: input.postExternalId, commentId: input.parentExternalId, content: input.text },
      session,
      parseSendAck,
    );
  }

  sendDmText(
    session: WechatSessionMaterial,
    input: { threadExternalId: string; text: string },
  ): Promise<WechatSendAck> {
    return this.call(
      'dmSendText',
      { sessionId: input.threadExternalId, messageType: 'text', content: input.text },
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
    try {
      const platform = await this.requestJson(endpoint, payload, session);
      return parse(platform.body, endpoint);
    } catch (error) {
      const safe = asWechatChannelsError(error, endpoint, true);
      if (safe.category === 'schema_changed') {
        try {
          this.onSchemaChanged?.(endpoint, safe);
        } catch {
          // Circuit-breaker observers cannot replace the stable endpoint error.
        }
      }
      throw safe;
    }
  }

  private async requestJson(
    endpoint: WechatChannelsEndpoint,
    payload: Record<string, unknown>,
    session: WechatSessionMaterial | undefined,
  ): Promise<PlatformEnvelope> {
    const retrySafe = READ_ENDPOINTS.has(endpoint);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = `${WECHAT_CHANNELS_API_BASE_URL}${WECHAT_CHANNELS_ENDPOINTS[endpoint]}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': session?.userAgent || 'AIDCP-Edge/WechatChannels',
    };
    if (session) headers.Cookie = buildCookieHeader(session, endpoint.startsWith('dm'));
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
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
        throw new WechatChannelsError('schema_changed', endpoint, 'WeChat Channels returned non-JSON data', false, null, true);
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

function buildCookieHeader(session: WechatSessionMaterial, dm: boolean): string {
  const cookies = dm && session.dmCookies?.length ? session.dmCookies : session.cookies;
  return cookies
    .filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      return domain === 'weixin.qq.com' || domain.endsWith('.weixin.qq.com');
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function readLimitedText(response: Response, maxBytes: number, endpoint: string): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new WechatChannelsError('schema_changed', endpoint, 'WeChat Channels response exceeded the size limit', false, null, true);
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
      throw new WechatChannelsError('schema_changed', endpoint, 'WeChat Channels response exceeded the size limit', false, null, true);
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
  const nested = root.baseResp ?? root.base_resp;
  const base = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : {};
  const code = root.errCode ?? root.errcode ?? root.code ?? base.ret ?? null;
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
