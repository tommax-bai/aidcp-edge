import { randomUUID } from 'node:crypto';
import { WechatChannelsError } from './error-classifier.js';
import type { WechatSessionMaterial } from './types.js';

export type WechatChannelsEndpoint =
  | 'authLoginCode'
  | 'authLoginStatus'
  | 'authData'
  | 'postList'
  | 'commentList'
  | 'commentCreate'
  | 'dmLoginCookie'
  | 'dmNewMessages'
  | 'dmHistory'
  | 'dmSessionInfo'
  | 'dmSendText'
  | 'dmUploadMedia';

export interface WechatRequestDescriptor {
  method: 'POST';
  path: string | null;
  queryKeys: readonly ['_aid', '_pageUrl', '_rid'];
  bodyEncoding: 'json';
  requiredHeaderNames: readonly string[];
  refererPath: '/' | '/micro/interaction/comment';
  cookieJar: 'primary';
  retrySafe: boolean;
  captureBacked: boolean;
  evidence: 'observed_read_only' | 'observed_write' | 'official_bundle_candidate' | 'not_observed';
  coverage: 'full_shape' | 'candidate_shape' | 'empty_only' | 'none';
}

const QUERY_KEYS = ['_aid', '_pageUrl', '_rid'] as const;
const REQUIRED_HEADERS = ['X-WECHAT-UIN', 'finger-print-device-id'] as const;
const observed = (path: string, retrySafe = true): WechatRequestDescriptor => ({
  method: 'POST', path, queryKeys: QUERY_KEYS, bodyEncoding: 'json',
  requiredHeaderNames: REQUIRED_HEADERS, refererPath: '/', cookieJar: 'primary', retrySafe,
  captureBacked: true, evidence: 'observed_read_only',
  coverage: 'full_shape',
});
const unobserved = (): WechatRequestDescriptor => ({
  method: 'POST', path: null, queryKeys: QUERY_KEYS, bodyEncoding: 'json',
  requiredHeaderNames: REQUIRED_HEADERS, refererPath: '/', cookieJar: 'primary', retrySafe: false,
  captureBacked: false, evidence: 'not_observed',
  coverage: 'none',
});
const candidateWrite = (path: string): WechatRequestDescriptor => ({
  method: 'POST', path, queryKeys: QUERY_KEYS, bodyEncoding: 'json',
  requiredHeaderNames: REQUIRED_HEADERS, refererPath: '/', cookieJar: 'primary', retrySafe: false,
  captureBacked: false, evidence: 'official_bundle_candidate',
  coverage: 'candidate_shape',
});
const capturedCommentWrite = (path: string): WechatRequestDescriptor => ({
  method: 'POST', path, queryKeys: QUERY_KEYS, bodyEncoding: 'json',
  requiredHeaderNames: REQUIRED_HEADERS, refererPath: '/micro/interaction/comment',
  cookieJar: 'primary', retrySafe: false,
  captureBacked: true, evidence: 'observed_write', coverage: 'full_shape',
});

export const WECHAT_CHANNELS_REQUEST_DESCRIPTORS: Readonly<Record<WechatChannelsEndpoint, WechatRequestDescriptor>> = {
  authLoginCode: unobserved(),
  authLoginStatus: unobserved(),
  authData: observed('/cgi-bin/mmfinderassistant-bin/auth/auth_data'),
  postList: observed('/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list'),
  commentList: observed('/micro/interaction/cgi-bin/mmfinderassistant-bin/comment/comment_list'),
  commentCreate: capturedCommentWrite('/micro/interaction/cgi-bin/mmfinderassistant-bin/comment/create_comment'),
  dmLoginCookie: unobserved(),
  dmNewMessages: unobserved(),
  dmHistory: observed('/micro/interaction/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg'),
  dmSessionInfo: observed('/micro/interaction/cgi-bin/mmfinderassistant-bin/private-msg/get-session-info'),
  dmSendText: candidateWrite('/micro/interaction/cgi-bin/mmfinderassistant-bin/private-msg/send-private-msg'),
  dmUploadMedia: unobserved(),
};

export interface SerializedWechatRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export function assertWechatRequestDescriptorAvailable(
  endpoint: WechatChannelsEndpoint,
): WechatRequestDescriptor {
  const descriptor = WECHAT_CHANNELS_REQUEST_DESCRIPTORS[endpoint];
  const candidateAllowed =
    endpoint === 'dmSendText' &&
    descriptor.evidence === 'official_bundle_candidate';
  if ((!descriptor.captureBacked && !candidateAllowed) || !descriptor.path) {
    throw new WechatChannelsError(
      'schema_changed', endpoint, `No capture-backed request descriptor for ${endpoint}`, false, null, false,
    );
  }
  return descriptor;
}

export function serializeWechatRequest(
  endpoint: WechatChannelsEndpoint,
  businessBody: Record<string, unknown>,
  session: WechatSessionMaterial,
  options: { now?: () => number; requestId?: () => string } = {},
): SerializedWechatRequest {
  const descriptor = assertWechatRequestDescriptorAvailable(endpoint);
  const context = session.requestContext;
  if (!context || context.version !== 1) {
    throw new WechatChannelsError('auth_expired', endpoint, 'Authorized request context is missing', false, null, false);
  }
  const query = new URLSearchParams({
    _aid: context.aid,
    _pageUrl: context.pageUrl,
    _rid: (options.requestId ?? randomUUID)(),
  });
  const body = {
    _log_finder_id: context.commonBody.logFinderId,
    _log_finder_uin: context.commonBody.logFinderUin,
    rawKeyBuff: context.commonBody.rawKeyBuff,
    timestamp: String((options.now ?? Date.now)()),
    scene: context.commonBody.scene,
    reqScene: context.commonBody.reqScene,
    pluginSessionId: context.commonBody.pluginSessionId,
    ...businessBody,
  };
  return {
    url: `https://channels.weixin.qq.com${descriptor.path}?${query.toString()}`,
    method: descriptor.method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': session.userAgent,
      Referer: `https://channels.weixin.qq.com${descriptor.refererPath}`,
      'finger-print-device-id': context.headers.fingerprintDeviceId,
      'X-WECHAT-UIN': context.headers.wechatUin,
      Cookie: buildCookieHeader(session),
    },
    body: JSON.stringify(body),
  };
}

function buildCookieHeader(session: WechatSessionMaterial): string {
  return session.cookies
    .filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      return domain === 'weixin.qq.com' || domain.endsWith('.weixin.qq.com');
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function structuralRequestShape(request: SerializedWechatRequest): {
  method: string; path: string; queryKeys: string[]; contentType: string | null;
  headerNames: string[]; bodyShape: Record<string, string>;
} {
  const url = new URL(request.url);
  const body = JSON.parse(request.body) as Record<string, unknown>;
  return {
    method: request.method,
    path: url.pathname,
    queryKeys: [...url.searchParams.keys()].sort(),
    contentType: request.headers['Content-Type'] ?? null,
    headerNames: Object.keys(request.headers).map((name) => name.toLowerCase()).sort(),
    bodyShape: Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [
      key, value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    ])),
  };
}
