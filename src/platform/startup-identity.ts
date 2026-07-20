import type { ReadSelfIdentityOptions } from '../cdp/self-identity.js';

/** Facebook 首次页面 bootstrap 的有界等待；只影响握手前首读/新浏览器代次唤醒。 */
export const FACEBOOK_STARTUP_IDENTITY_HYDRATE_MS = 12_000;

/**
 * 启动身份首读策略：
 * - Facebook 需要把 AdsPower 刚附着的 about:blank 引导到消费端首页，并等本人锚点水合；
 * - XHS AdsPower 保持登录页纯就地读，绝不新增误导航；
 * - self provider 维持各平台 reader 的既有默认行为。
 */
export function startupIdentityReadPolicy(platform: string, providerKind: string): ReadSelfIdentityOptions {
  if (platform === 'facebook') {
    return { allowNavigate: true, hydrateTimeoutMs: FACEBOOK_STARTUP_IDENTITY_HYDRATE_MS };
  }
  if (providerKind === 'adspower') return { allowNavigate: false };
  return {};
}
