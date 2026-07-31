import type { CdpClient } from './client.js';

export type ProxyRuntimeState = 'active' | 'stale';

export interface ProxyRuntimeSnapshot {
  state: ProxyRuntimeState;
  generation: number;
  sessionReceivedBytes: number;
}

export interface ProxyRuntimeUiEvent {
  kind: 'proxyRuntime';
  type: 'proxy_runtime';
  proxyRuntime: ProxyRuntimeSnapshot;
}

interface ProxyRuntimeObserverOptions {
  cdp: Pick<CdpClient, 'on'>;
  emit: (event: ProxyRuntimeUiEvent) => void;
  now?: () => number;
  trafficEmitIntervalMs?: number;
}

/**
 * 当前 AdsPower page 的本次接管流量聚合器。
 *
 * 只累计完成请求的 encodedDataLength，不发探测请求，也不读取 URL、Cookie、正文或公网出口。
 */
export class ProxyRuntimeObserver {
  private readonly cdp: ProxyRuntimeObserverOptions['cdp'];
  private readonly emitEvent: ProxyRuntimeObserverOptions['emit'];
  private readonly now: () => number;
  private readonly trafficEmitIntervalMs: number;
  private generation = 0;
  private receivedBytes = 0;
  private state: ProxyRuntimeState = 'stale';
  private lastEmitAt = 0;
  private trafficTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;

  constructor(options: ProxyRuntimeObserverOptions) {
    this.cdp = options.cdp;
    this.emitEvent = options.emit;
    this.now = options.now ?? Date.now;
    this.trafficEmitIntervalMs = Math.max(0, options.trafficEmitIntervalMs ?? 2_000);
    this.unsubscribe = this.cdp.on('Network.loadingFinished', (params) => this.onLoadingFinished(params));
  }

  snapshot(): ProxyRuntimeSnapshot {
    return {
      state: this.state,
      generation: this.generation,
      sessionReceivedBytes: this.receivedBytes,
    };
  }

  startGeneration(): ProxyRuntimeSnapshot {
    this.generation += 1;
    this.receivedBytes = 0;
    this.state = 'active';
    this.emitNow();
    return this.snapshot();
  }

  suspendGeneration(_reason?: string): void {
    this.generation += 1;
    this.receivedBytes = 0;
    this.state = 'stale';
    this.emitNow();
  }

  dispose(): void {
    this.unsubscribe();
    if (this.trafficTimer) clearTimeout(this.trafficTimer);
    this.trafficTimer = undefined;
  }

  private onLoadingFinished(params: unknown): void {
    if (this.state === 'stale') return;
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
}
