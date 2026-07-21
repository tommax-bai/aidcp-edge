import type { ChromeInstance } from '../cdp/chrome-launcher.js';
import { attachToPage, selectBrowserProvider, type BrowserProvider, type EdgeSession } from '../cdp/index.js';
import type { WechatCookie, WechatRequestContext, WechatSessionMaterial } from './types.js';
import { WECHAT_CHANNELS_DEFAULT_START_URL, WECHAT_CHANNELS_TARGET } from './driver.js';

export type BrowserSidecarState = 'closed' | 'opening' | 'open' | 'closing' | 'unavailable';

export interface WechatChannelsBrowserSidecar {
  readonly browserProfileId: string;
  getState(): BrowserSidecarState;
  open(): Promise<void>;
  readSessionCandidate(): Promise<WechatSessionMaterial | null>;
  close(): Promise<void>;
}

export interface BrowserSidecarOptions {
  env?: NodeJS.ProcessEnv;
  provider?: BrowserProvider;
  logImpl?: (message: string) => void;
  nowImpl?: () => number;
}

export class CdpWechatChannelsBrowserSidecar implements WechatChannelsBrowserSidecar {
  readonly browserProfileId: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly provider: BrowserProvider;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private session?: EdgeSession;
  private browser?: ChromeInstance;
  private state: BrowserSidecarState = 'closed';
  private requestContext?: WechatRequestContext;
  private stopRequestCapture?: () => void;

  constructor(options: BrowserSidecarOptions = {}) {
    this.env = options.env ?? process.env;
    this.browserProfileId =
      this.env.AIDCP_ADS_USER_ID?.trim() || this.env.AIDCP_WECHAT_BROWSER_PROFILE_ID?.trim() || '';
    if (!this.browserProfileId) {
      throw new Error('wechat_channels requires AIDCP_ADS_USER_ID or AIDCP_WECHAT_BROWSER_PROFILE_ID');
    }
    this.log = options.logImpl ?? ((message) => console.log(message));
    this.now = options.nowImpl ?? Date.now;
    this.provider =
      options.provider ??
      selectBrowserProvider({
        env: this.env,
        startUrl: WECHAT_CHANNELS_DEFAULT_START_URL,
        logImpl: this.log,
      });
  }

  getState(): BrowserSidecarState {
    return this.state;
  }

  async open(): Promise<void> {
    if (this.state === 'open') return;
    if (this.state === 'opening' || this.state === 'closing') throw new Error(`browser sidecar is ${this.state}`);
    this.state = 'opening';
    try {
      const launched = await this.provider.launch({
        host: this.env.AIDCP_CDP_HOST ?? '127.0.0.1',
        port: Number(this.env.AIDCP_CDP_PORT ?? 9222),
        chromePath: this.env.AIDCP_CHROME_PATH,
        profileDir: this.env.AIDCP_CHROME_PROFILE,
        headless: false,
        readyTimeoutMs: positiveMs(this.env.AIDCP_WECHAT_BROWSER_READY_TIMEOUT_MS, 20_000),
      });
      this.browser = launched.instance;
      this.session = await attachToPage({
        host: launched.endpoint.host,
        port: launched.endpoint.port,
        stealth: this.provider.kind !== 'adspower',
        targetPredicate: (target) => {
          try {
            const host = new URL(target.url).hostname.toLowerCase();
            return WECHAT_CHANNELS_TARGET.allowedHostSuffixes.some(
              (suffix) => host === suffix || host.endsWith(`.${suffix}`),
            );
          } catch {
            return false;
          }
        },
      });
      await this.session.cdp.send('Network.enable');
      await this.session.cdp.send('Page.bringToFront').catch(() => undefined);
      this.stopRequestCapture = this.session.cdp.on('Network.requestWillBeSent', (params) => {
        const captured = captureRequestContext(params);
        if (captured) this.requestContext = captured;
      });
      await this.session.cdp.send('Page.reload', { ignoreCache: false }).catch(() => undefined);
      this.state = 'open';
      this.log('[wechat-channels] browser login sidecar is open');
    } catch (error) {
      // A provider may have opened the physical browser before attach/capture failed. Rejecting open()
      // without closing it would let the shell release the transient lane while an orphan browser is
      // still alive. Always perform bounded teardown first; close confirmation remains authoritative.
      const session = this.session;
      const browser = this.browser;
      this.session = undefined;
      this.browser = undefined;
      this.stopRequestCapture?.();
      this.stopRequestCapture = undefined;
      try {
        session?.close();
        if (browser && !(await browser.killAndConfirmDead())) {
          throw new Error('browser sidecar open cleanup was not confirmed');
        }
      } catch (cleanupError) {
        this.state = 'unavailable';
        this.log(`[wechat-channels] browser login sidecar cleanup unavailable: ${safeBrowserSidecarDiagnostic(cleanupError)}`);
        throw cleanupError;
      }
      // The authentication attempt failed, but the physical browser is confirmed gone. Expose
      // `closed` so the lease decorator may safely release the transient lane.
      this.state = 'closed';
      this.log(`[wechat-channels] browser login sidecar unavailable: ${safeBrowserSidecarDiagnostic(error)}`);
      throw error;
    }
  }

  async readSessionCandidate(): Promise<WechatSessionMaterial | null> {
    const cdp = this.session?.cdp;
    if (!cdp || this.state !== 'open') return null;
    const response = await cdp.send<{ cookies?: WechatCookie[] }>('Network.getAllCookies').catch(() => ({ cookies: [] }));
    const cookies = (response.cookies ?? []).filter((cookie) => {
      const domain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
      return domain === 'weixin.qq.com' || domain.endsWith('.weixin.qq.com');
    });
    if (cookies.length === 0 || !this.requestContext) return null;
    const userAgentResponse = await cdp
      .send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: 'navigator.userAgent',
        returnByValue: true,
      })
      .catch(() => ({ result: { value: '' } }));
    const userAgent = String(userAgentResponse.result?.value ?? '').trim();
    if (!userAgent) return null;
    return {
      cookies: cookies.map((cookie) => ({
        name: String(cookie.name),
        value: String(cookie.value),
        domain: String(cookie.domain),
        path: cookie.path ? String(cookie.path) : '/',
        expires: typeof cookie.expires === 'number' ? cookie.expires : undefined,
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
        sameSite: cookie.sameSite ? String(cookie.sameSite) : undefined,
      })),
      userAgent,
      acquiredAt: this.now(),
      requestContext: this.requestContext,
    };
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closing';
    const session = this.session;
    const browser = this.browser;
    this.session = undefined;
    this.browser = undefined;
    this.stopRequestCapture?.();
    this.stopRequestCapture = undefined;
    try {
      session?.close();
      if (browser) {
        const confirmed = await browser.killAndConfirmDead();
        if (!confirmed) throw new Error('browser sidecar close was not confirmed');
      }
      this.state = 'closed';
      this.log('[wechat-channels] browser sidecar closed');
    } catch (error) {
      this.state = 'unavailable';
      throw error;
    }
  }
}

/**
 * Whitelist-only diagnostic for provider failures. Never forward the raw error: provider messages
 * may contain response bodies, URLs, credentials, or platform session material.
 */
export function safeBrowserSidecarDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const provider = /adspower/i.test(message) ? 'adspower' : 'browser';
  const operationMatch = message.match(/\b(browser-profile\/(?:start|active|stop))\b/i)
    ?? message.match(/不可达（([A-Za-z0-9/_-]{1,64})）/);
  const operation = safeToken(operationMatch?.[1]) ?? 'sidecar.open';
  const httpStatus = message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  const providerCode = safeToken(message.match(/\bcode=([A-Za-z0-9_.:-]{1,64})\b/i)?.[1]);
  const kind = /不可达|ECONN(?:REFUSED|RESET)|fetch failed|network/i.test(message)
    ? 'api_unreachable'
    : /未返回有效\s*debug_port|invalid\s+debug_port/i.test(message)
      ? 'invalid_handle'
      : /CDP.*(?:超时|timeout)|(?:超时|timeout).*CDP/i.test(message)
        ? 'cdp_timeout'
        : httpStatus
          ? 'http_error'
          : providerCode || /失败|rejected/i.test(message)
            ? 'provider_rejected'
            : 'unexpected';
  const fields = [`provider=${provider}`, `operation=${operation}`, `kind=${kind}`];
  if (httpStatus) fields.push(`http_status=${httpStatus}`);
  if (providerCode) fields.push(`provider_code=${providerCode}`);
  return fields.join(' ');
}

function safeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return /^[A-Za-z0-9_.:/-]{1,64}$/.test(token) ? token : null;
}

export function captureRequestContext(value: unknown): WechatRequestContext | null {
  if (!value || typeof value !== 'object') return null;
  const request = (value as { request?: unknown }).request;
  if (!request || typeof request !== 'object') return null;
  const raw = request as { url?: unknown; postData?: unknown; headers?: unknown };
  if (typeof raw.url !== 'string' || typeof raw.postData !== 'string') return null;
  let url: URL;
  let body: Record<string, unknown>;
  try {
    url = new URL(raw.url);
    body = JSON.parse(raw.postData) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (url.hostname !== 'channels.weixin.qq.com' || !url.pathname.endsWith('/auth/auth_data')) return null;
  const headers = raw.headers && typeof raw.headers === 'object'
    ? Object.fromEntries(Object.entries(raw.headers as Record<string, unknown>).map(([key, item]) => [key.toLowerCase(), item]))
    : {};
  const aid = url.searchParams.get('_aid');
  const pageUrl = url.searchParams.get('_pageUrl');
  const logFinderId = body._log_finder_id;
  const logFinderUin = body._log_finder_uin;
  const rawKeyBuff = body.rawKeyBuff;
  const reqScene = body.reqScene;
  const scene = body.scene;
  const fingerprintDeviceId = headers['finger-print-device-id'];
  const wechatUin = headers['x-wechat-uin'];
  if (![aid, pageUrl, logFinderId, fingerprintDeviceId, wechatUin]
      .every((item) => typeof item === 'string' && item.length > 0) ||
      typeof logFinderUin !== 'string' || typeof rawKeyBuff !== 'string' ||
      typeof reqScene !== 'number' || typeof scene !== 'number') return null;
  const pluginSessionId = body.pluginSessionId;
  if (pluginSessionId !== null && typeof pluginSessionId !== 'string') return null;
  return {
    version: 1,
    aid: aid!,
    pageUrl: pageUrl!,
    commonBody: {
      logFinderId: logFinderId as string,
      logFinderUin: logFinderUin as string,
      rawKeyBuff: rawKeyBuff as string,
      pluginSessionId,
      reqScene,
      scene,
    },
    headers: {
      fingerprintDeviceId: fingerprintDeviceId as string,
      wechatUin: wechatUin as string,
    },
  };
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
