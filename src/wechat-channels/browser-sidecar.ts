import type { ChromeInstance } from '../cdp/chrome-launcher.js';
import { selectBrowserProvider, type BrowserProvider } from '../cdp/index.js';
import {
  NativePageRuntime,
  type NativePageEndpoint,
} from '../native-page-engine/runtime.js';
import type { NativePageCommandExecution } from '../native-page-engine/client.js';
import type { WechatCookie, WechatSessionMaterial } from './types.js';
import { WECHAT_CHANNELS_DEFAULT_START_URL } from './driver.js';

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
  createNativeRuntime?: (getEndpoint: () => NativePageEndpoint) => WechatNativeCaptureRuntime;
}

export interface WechatNativeCaptureRuntime {
  openOwner(ownerId: string): Promise<void>;
  execute(
    ownerId: string,
    command: { kind: 'wechat_capture_session'; params: Record<string, never> },
    timeoutMs?: number,
  ): Promise<NativePageCommandExecution>;
  shutdown(): Promise<void>;
}

export class CdpWechatChannelsBrowserSidecar implements WechatChannelsBrowserSidecar {
  readonly browserProfileId: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly provider: BrowserProvider;
  private readonly log: (message: string) => void;
  private browser?: ChromeInstance;
  private nativeRuntime?: WechatNativeCaptureRuntime;
  private state: BrowserSidecarState = 'closed';
  private readonly ownerId: string;
  private readonly createNativeRuntime: (getEndpoint: () => NativePageEndpoint) => WechatNativeCaptureRuntime;

  constructor(options: BrowserSidecarOptions = {}) {
    this.env = options.env ?? process.env;
    this.browserProfileId =
      this.env.AIDCP_ADS_USER_ID?.trim() || this.env.AIDCP_WECHAT_BROWSER_PROFILE_ID?.trim() || '';
    if (!this.browserProfileId) {
      throw new Error('wechat_channels requires AIDCP_ADS_USER_ID or AIDCP_WECHAT_BROWSER_PROFILE_ID');
    }
    this.log = options.logImpl ?? ((message) => console.log(message));
    this.provider =
      options.provider ??
      selectBrowserProvider({
        env: this.env,
        startUrl: WECHAT_CHANNELS_DEFAULT_START_URL,
        logImpl: this.log,
      });
    this.ownerId = `wechat-auth:${this.browserProfileId}`;
    this.createNativeRuntime =
      options.createNativeRuntime
      ?? ((getEndpoint) => NativePageRuntime.fromEnvironment(getEndpoint, 'wechat_channels'));
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
      const endpoint = { host: launched.endpoint.host, port: launched.endpoint.port };
      const nativeRuntime = this.createNativeRuntime(() => endpoint);
      this.nativeRuntime = nativeRuntime;
      await nativeRuntime.openOwner(this.ownerId);
      this.state = 'open';
      this.log('[wechat-channels] browser login sidecar is open');
    } catch (error) {
      // A provider may have opened the physical browser before attach/capture failed. Rejecting open()
      // without closing it would let the shell release the transient lane while an orphan browser is
      // still alive. Always perform bounded teardown first; close confirmation remains authoritative.
      const nativeRuntime = this.nativeRuntime;
      const browser = this.browser;
      this.nativeRuntime = undefined;
      this.browser = undefined;
      try {
        await nativeRuntime?.shutdown();
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
    const nativeRuntime = this.nativeRuntime;
    if (!nativeRuntime || this.state !== 'open') return null;
    const execution = await nativeRuntime.execute(
      this.ownerId,
      { kind: 'wechat_capture_session', params: {} },
      5_000,
    );
    if (
      execution.effectPhase !== 'confirmed'
      || execution.output?.kind !== 'wechat_session_candidate'
    ) {
      throw new Error('Native WeChat session capture returned an invalid result');
    }
    return parseNativeWechatSessionCandidate(execution.output.value);
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closing';
    const nativeRuntime = this.nativeRuntime;
    const browser = this.browser;
    this.nativeRuntime = undefined;
    this.browser = undefined;
    try {
      await nativeRuntime?.shutdown();
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

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function parseNativeWechatSessionCandidate(value: unknown): WechatSessionMaterial | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasOnlyKeys(value, ['cookies', 'userAgent', 'acquiredAt', 'requestContext'])) return null;
  if (
    !Array.isArray(value.cookies)
    || value.cookies.length === 0
    || value.cookies.length > 128
    || typeof value.userAgent !== 'string'
    || !boundedNonempty(value.userAgent, 1_024)
    || !Number.isSafeInteger(value.acquiredAt)
    || Number(value.acquiredAt) < 0
  ) return null;
  const cookies: WechatCookie[] = [];
  for (const raw of value.cookies) {
    if (
      !isRecord(raw)
      || !hasOnlyKeys(raw, ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'])
      || typeof raw.name !== 'string' || !boundedNonempty(raw.name, 256)
      || typeof raw.value !== 'string' || !boundedNonempty(raw.value, 8 * 1024)
      || typeof raw.domain !== 'string' || !boundedNonempty(raw.domain, 255)
      || typeof raw.path !== 'string' || raw.path.length > 1_024
      || (raw.expires !== undefined && typeof raw.expires !== 'number')
      || typeof raw.httpOnly !== 'boolean'
      || typeof raw.secure !== 'boolean'
      || (raw.sameSite !== undefined && (typeof raw.sameSite !== 'string' || raw.sameSite.length > 32))
    ) return null;
    const domain = raw.domain.replace(/^\./, '').toLowerCase();
    if (domain !== 'weixin.qq.com' && !domain.endsWith('.weixin.qq.com')) return null;
    cookies.push({
      name: raw.name,
      value: raw.value,
      domain: raw.domain,
      path: raw.path,
      ...(typeof raw.expires === 'number' ? { expires: raw.expires } : {}),
      httpOnly: raw.httpOnly,
      secure: raw.secure,
      ...(typeof raw.sameSite === 'string' ? { sameSite: raw.sameSite } : {}),
    });
  }
  const requestContext = parseRequestContext(value.requestContext);
  if (!requestContext) return null;
  return {
    cookies,
    userAgent: value.userAgent,
    acquiredAt: Number(value.acquiredAt),
    requestContext,
  };
}

function parseRequestContext(value: unknown): WechatSessionMaterial['requestContext'] | null {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['version', 'aid', 'pageUrl', 'commonBody', 'headers'])
    || value.version !== 1
    || typeof value.aid !== 'string' || !boundedNonempty(value.aid, 1_024)
    || typeof value.pageUrl !== 'string' || !boundedNonempty(value.pageUrl, 8 * 1024)
    || !isRecord(value.commonBody)
    || !hasOnlyKeys(value.commonBody, ['logFinderId', 'logFinderUin', 'rawKeyBuff', 'pluginSessionId', 'reqScene', 'scene'])
    || typeof value.commonBody.logFinderId !== 'string' || !boundedNonempty(value.commonBody.logFinderId, 1_024)
    || typeof value.commonBody.logFinderUin !== 'string' || value.commonBody.logFinderUin.length > 1_024
    || typeof value.commonBody.rawKeyBuff !== 'string' || value.commonBody.rawKeyBuff.length > 16 * 1024
    || (value.commonBody.pluginSessionId !== null && typeof value.commonBody.pluginSessionId !== 'string')
    || typeof value.commonBody.reqScene !== 'number' || !Number.isSafeInteger(value.commonBody.reqScene)
    || typeof value.commonBody.scene !== 'number' || !Number.isSafeInteger(value.commonBody.scene)
    || !isRecord(value.headers)
    || !hasOnlyKeys(value.headers, ['fingerprintDeviceId', 'wechatUin'])
    || typeof value.headers.fingerprintDeviceId !== 'string' || !boundedNonempty(value.headers.fingerprintDeviceId, 1_024)
    || typeof value.headers.wechatUin !== 'string' || !boundedNonempty(value.headers.wechatUin, 1_024)
  ) return null;
  return value as unknown as WechatSessionMaterial['requestContext'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && allowed.every((key) => key in value || ['expires', 'sameSite'].includes(key));
}

function boundedNonempty(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max;
}
