import type { InteractionErrorCode, InteractionReplyErrorCategory } from '../comm/protocol.js';

export type WechatEndpointErrorCategory = InteractionReplyErrorCategory;

const CODE_BY_CATEGORY: Record<WechatEndpointErrorCategory, InteractionErrorCode> = {
  auth_expired: 'WECHAT_AUTH_REQUIRED',
  challenge_required: 'WECHAT_CHALLENGE_REQUIRED',
  identity_mismatch: 'WECHAT_IDENTITY_MISMATCH',
  rate_limited: 'WECHAT_RATE_LIMITED',
  permission_denied: 'WECHAT_PERMISSION_DENIED',
  schema_changed: 'WECHAT_SCHEMA_CHANGED',
  transient_network: 'INTERACTION_UPSTREAM_UNAVAILABLE',
  unsupported_message_type: 'INTERACTION_UNSUPPORTED_MESSAGE_TYPE',
  invalid_scope: 'INTERACTION_SCOPE_MISMATCH',
  invalid_command: 'INTERACTION_VALIDATION_FAILED',
  expired_command: 'INTERACTION_VALIDATION_FAILED',
  platform_rejected: 'INTERACTION_UPSTREAM_UNAVAILABLE',
  verification_failed: 'INTERACTION_SEND_AMBIGUOUS',
  internal_error: 'INTERACTION_INTERNAL_ERROR',
};

export class WechatChannelsError extends Error {
  readonly code: InteractionErrorCode;

  constructor(
    readonly category: WechatEndpointErrorCategory,
    readonly endpoint: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    readonly requestDispatched = false,
  ) {
    super(message);
    this.name = 'WechatChannelsError';
    this.code = CODE_BY_CATEGORY[category];
  }
}

export function schemaChanged(endpoint: string, field: string): WechatChannelsError {
  return new WechatChannelsError(
    'schema_changed',
    endpoint,
    `WeChat Channels endpoint schema changed (missing/invalid ${field})`,
    false,
  );
}

export function classifyHttpFailure(params: {
  endpoint: string;
  status: number;
  retryAfterMs?: number | null;
  platformCode?: string | number | null;
  platformMessage?: string | null;
  requestDispatched?: boolean;
}): WechatChannelsError {
  const { endpoint, status } = params;
  const hint = `${params.platformCode ?? ''} ${params.platformMessage ?? ''}`.toLowerCase();
  if (status === 401 || /(?:not.?login|login.?expired|auth.?expired|未登录|登录失效|登录过期)/i.test(hint)) {
    return new WechatChannelsError('auth_expired', endpoint, 'WeChat Channels authentication is required', false, null, true);
  }
  if (/(?:captcha|challenge|verify|risk.?control|验证码|风控|验证)/i.test(hint)) {
    return new WechatChannelsError('challenge_required', endpoint, 'WeChat Channels requires local browser verification', false, null, true);
  }
  if (status === 429 || /(?:too.?many|rate.?limit|频繁|限流)/i.test(hint)) {
    return new WechatChannelsError('rate_limited', endpoint, 'WeChat Channels rate limited the request', true, params.retryAfterMs ?? null, true);
  }
  if (status === 403 || /(?:permission|forbidden|无权限|拒绝访问)/i.test(hint)) {
    return new WechatChannelsError('permission_denied', endpoint, 'WeChat Channels denied the requested capability', false, null, true);
  }
  if (status >= 500 || status === 408 || status === 425) {
    return new WechatChannelsError('transient_network', endpoint, 'WeChat Channels upstream is temporarily unavailable', true, params.retryAfterMs ?? null, true);
  }
  return new WechatChannelsError(
    'platform_rejected',
    endpoint,
    `WeChat Channels rejected the request (status=${status || 'platform'})`,
    false,
    null,
    params.requestDispatched ?? true,
  );
}

export function asWechatChannelsError(error: unknown, endpoint: string, dispatched = false): WechatChannelsError {
  if (error instanceof WechatChannelsError) return error;
  return new WechatChannelsError(
    'transient_network',
    endpoint,
    'WeChat Channels request failed before a trustworthy result was available',
    true,
    null,
    dispatched,
  );
}
