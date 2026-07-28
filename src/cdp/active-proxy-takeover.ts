import { normalizeObservedIp } from './proxy-runtime-observer.js';

export type ActiveProxyTakeoverFailureReason = 'egress_unavailable' | 'egress_mismatch';

export class AdsPowerActiveProxyTakeoverError extends Error {
  readonly code = 'adspower_active_proxy_takeover_rejected' as const;

  constructor(
    readonly profileId: string,
    readonly reason: ActiveProxyTakeoverFailureReason,
  ) {
    const guidance = reason === 'egress_mismatch'
      ? '当前浏览器真实出口与本次权威代理出口不一致'
      : '无法核验当前浏览器真实出口与本次权威代理出口';
    super(
      `[aidcp-edge] [adspower_active_proxy_takeover_rejected] AdsPower profile=${profileId} ${guidance}；` +
        '已停止本次接管且不会关闭现有浏览器，请关闭该环境后重新启动',
    );
    this.name = 'AdsPowerActiveProxyTakeoverError';
  }
}

export function requireActiveProxyEgressMatch(input: {
  profileId: string;
  expectedEgressIp?: string;
  browserEgressIp?: string;
}): { expectedEgressIp: string; browserEgressIp: string } {
  const expectedEgressIp = normalizeObservedIp(input.expectedEgressIp);
  const browserEgressIp = normalizeObservedIp(input.browserEgressIp);
  if (!expectedEgressIp || !browserEgressIp) {
    throw new AdsPowerActiveProxyTakeoverError(input.profileId, 'egress_unavailable');
  }
  if (expectedEgressIp !== browserEgressIp) {
    throw new AdsPowerActiveProxyTakeoverError(input.profileId, 'egress_mismatch');
  }
  return { expectedEgressIp, browserEgressIp };
}
