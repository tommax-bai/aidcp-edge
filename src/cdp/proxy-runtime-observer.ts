import { isIP } from 'node:net';
import type { CdpClient } from './client.js';

export type ProxyRuntimeState = 'pending' | 'verified' | 'same_as_host' | 'unavailable' | 'stale';

export interface ProxyRuntimeSnapshot {
  state: ProxyRuntimeState;
  generation: number;
  sessionReceivedBytes: number;
  browserIp?: string;
  directIp?: string;
  checkedAt?: string;
  reason?: string;
}

export interface ProxyRuntimeUiEvent {
  kind: 'proxyRuntime';
  type: 'proxy_runtime';
  proxyRuntime: ProxyRuntimeSnapshot;
}

interface ProxyRuntimeObserverOptions {
  cdp: Pick<CdpClient, 'send' | 'on'>;
  probeUrl: string;
  emit: (event: ProxyRuntimeUiEvent) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  probeTimeoutMs?: number;
  trafficEmitIntervalMs?: number;
}

interface FrameTreeResult {
  frameTree?: { frame?: { id?: string } };
}

interface NetworkResourceResult {
  resource?: {
    success?: boolean;
    httpStatusCode?: number;
    headers?: Record<string, unknown>;
    netError?: string;
  };
}

export function normalizeObservedIp(value: unknown): string | null {
  let candidate = String(value ?? '').trim();
  if (!candidate) return null;
  if (candidate.startsWith('[')) {
    const closing = candidate.indexOf(']');
    if (closing > 0) candidate = candidate.slice(1, closing);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(':'));
  }
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const mapped = candidate.slice(7);
    if (isIP(mapped) === 4) candidate = mapped;
  }
  return isIP(candidate) ? candidate.toLowerCase() : null;
}

function headerValue(headers: Record<string, unknown> | undefined, wanted: string): unknown {
  if (!headers) return undefined;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted.toLowerCase());
  return match?.[1];
}

/**
 * 当前 AdsPower Facebook page 的运行时观测器。
 *
 * 只保留两个聚合事实：浏览器/Node 出口证据和完成请求的 encodedDataLength 总和。
 * 不读取 URL、Cookie、请求/响应正文，也不发逐请求事件。
 */
export class ProxyRuntimeObserver {
  private readonly cdp: ProxyRuntimeObserverOptions['cdp'];
  private readonly probeUrl: string;
  private readonly emitEvent: ProxyRuntimeObserverOptions['emit'];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private readonly trafficEmitIntervalMs: number;
  private generation = 0;
  private receivedBytes = 0;
  private state: ProxyRuntimeState = 'stale';
  private browserIp: string | undefined;
  private directIp: string | undefined;
  private checkedAt: string | undefined;
  private reason: string | undefined = 'browser_not_attached';
  private lastEmitAt = 0;
  private trafficTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;

  constructor(options: ProxyRuntimeObserverOptions) {
    this.cdp = options.cdp;
    this.probeUrl = options.probeUrl.trim();
    this.emitEvent = options.emit;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.probeTimeoutMs = Math.max(500, options.probeTimeoutMs ?? 8_000);
    this.trafficEmitIntervalMs = Math.max(0, options.trafficEmitIntervalMs ?? 2_000);
    this.unsubscribe = this.cdp.on('Network.loadingFinished', (params) => this.onLoadingFinished(params));
  }

  snapshot(): ProxyRuntimeSnapshot {
    return {
      state: this.state,
      generation: this.generation,
      sessionReceivedBytes: this.receivedBytes,
      ...(this.browserIp ? { browserIp: this.browserIp } : {}),
      ...(this.directIp ? { directIp: this.directIp } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  async startGeneration(): Promise<ProxyRuntimeSnapshot> {
    const generation = ++this.generation;
    this.receivedBytes = 0;
    this.browserIp = undefined;
    this.directIp = undefined;
    this.checkedAt = undefined;
    this.reason = undefined;
    this.state = 'pending';
    this.emitNow();

    if (!this.probeUrl) {
      this.state = 'unavailable';
      this.reason = 'probe_url_missing';
      this.checkedAt = new Date(this.now()).toISOString();
      this.emitNow();
      return this.snapshot();
    }

    const [browser, direct] = await Promise.allSettled([this.probeBrowser(), this.probeDirect()]);
    if (generation !== this.generation) return this.snapshot();
    this.browserIp = browser.status === 'fulfilled' ? browser.value : undefined;
    this.directIp = direct.status === 'fulfilled' ? direct.value : undefined;
    this.checkedAt = new Date(this.now()).toISOString();
    if (this.browserIp && this.directIp) {
      this.state = this.browserIp === this.directIp ? 'same_as_host' : 'verified';
      this.reason = undefined;
    } else {
      this.state = 'unavailable';
      this.reason = [
        !this.browserIp ? `browser:${browser.status === 'rejected' ? this.errorCode(browser.reason) : 'missing_ip'}` : '',
        !this.directIp ? `direct:${direct.status === 'rejected' ? this.errorCode(direct.reason) : 'missing_ip'}` : '',
      ].filter(Boolean).join(',');
    }
    this.emitNow();
    return this.snapshot();
  }

  suspendGeneration(reason = 'browser_standby'): void {
    this.generation += 1; // 使任何旧探测结果作废。
    this.state = 'stale';
    this.browserIp = undefined;
    this.directIp = undefined;
    this.checkedAt = undefined;
    this.reason = reason;
    this.emitNow();
  }

  dispose(): void {
    this.unsubscribe();
    if (this.trafficTimer) clearTimeout(this.trafficTimer);
    this.trafficTimer = undefined;
  }

  private onLoadingFinished(params: unknown): void {
    const length = Number((params as { encodedDataLength?: unknown } | undefined)?.encodedDataLength);
    if (!Number.isFinite(length) || length < 0) return;
    this.receivedBytes += length;
    this.scheduleTrafficEmit();
  }

  private scheduleTrafficEmit(): void {
    const elapsed = this.now() - this.lastEmitAt;
    if (this.trafficEmitIntervalMs === 0 || elapsed >= this.trafficEmitIntervalMs) {
      this.emitNow();
      return;
    }
    if (this.trafficTimer) return;
    this.trafficTimer = setTimeout(() => {
      this.trafficTimer = undefined;
      this.emitNow();
    }, this.trafficEmitIntervalMs - elapsed);
    this.trafficTimer.unref?.();
  }

  private emitNow(): void {
    if (this.trafficTimer) clearTimeout(this.trafficTimer);
    this.trafficTimer = undefined;
    this.lastEmitAt = this.now();
    this.emitEvent({ kind: 'proxyRuntime', type: 'proxy_runtime', proxyRuntime: this.snapshot() });
  }

  private async probeBrowser(): Promise<string> {
    const frameTree = await this.cdp.send<FrameTreeResult>('Page.getFrameTree');
    const frameId = frameTree.frameTree?.frame?.id;
    if (!frameId) throw new Error('frame_missing');
    const result = await this.cdp.send<NetworkResourceResult>('Network.loadNetworkResource', {
      frameId,
      url: this.probeUrl,
      options: { disableCache: true, includeCredentials: false },
    });
    const resource = result.resource;
    if (!resource?.success || (resource.httpStatusCode && resource.httpStatusCode >= 400)) {
      throw new Error(resource?.netError || `http_${resource?.httpStatusCode ?? 'unknown'}`);
    }
    const ip = normalizeObservedIp(headerValue(resource.headers, 'x-aidcp-egress-ip'));
    if (!ip) throw new Error('ip_header_missing');
    return ip;
  }

  private async probeDirect(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.probeUrl, {
        method: 'GET',
        headers: { 'cache-control': 'no-cache' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const headerIp = normalizeObservedIp(response.headers.get('x-aidcp-egress-ip'));
      if (headerIp) return headerIp;
      const body = await response.json() as { ip?: unknown };
      const bodyIp = normalizeObservedIp(body.ip);
      if (!bodyIp) throw new Error('ip_missing');
      return bodyIp;
    } finally {
      clearTimeout(timer);
    }
  }

  private errorCode(error: unknown): string {
    if (error instanceof Error && error.message) return error.message.slice(0, 80);
    return 'failed';
  }
}
