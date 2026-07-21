import type { WechatChannelsBrowserSidecar } from './browser-sidecar.js';

type SendPayload = Record<string, unknown>;

export interface TransientLeaseIpc {
  connected?: boolean;
  send?: (payload: SendPayload) => void;
}

export interface TransientBrowserLeaseOptions {
  ipc?: TransientLeaseIpc;
  initiallyHeld?: boolean;
  lifecycleGeneration?: number;
  acquireTimeoutMs?: number;
  nowImpl?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Child-side client for the machine-level transient browser lane. The Electron shell owns ordering;
 * this client only proves that a sidecar open has an active lease and releases it after confirmed
 * close. Startup may arrive with a pre-granted lease so stored-session validation is serialized too.
 */
export class TransientBrowserLeaseClient {
  private readonly ipc: TransientLeaseIpc;
  private readonly lifecycleGeneration: number;
  private readonly acquireTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimeoutImpl: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (timer: ReturnType<typeof setTimeout>) => void;
  private held: boolean;
  private heldRequestId: string | null;
  private pending?: {
    requestId: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private requestSequence = 0;

  constructor(options: TransientBrowserLeaseOptions = {}) {
    this.ipc = options.ipc ?? process;
    this.lifecycleGeneration = Number.isInteger(options.lifecycleGeneration)
      ? Number(options.lifecycleGeneration)
      : 0;
    this.acquireTimeoutMs = positiveMs(options.acquireTimeoutMs, 180_000);
    this.now = options.nowImpl ?? Date.now;
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? ((timer) => clearTimeout(timer));
    this.held = options.initiallyHeld === true;
    this.heldRequestId = this.held ? 'startup' : null;
  }

  isHeld(): boolean {
    return this.held;
  }

  acquire(reason: string): Promise<void> {
    if (this.held) return Promise.resolve();
    if (this.pending) {
      return new Promise<void>((resolve, reject) => {
        const poll = (): void => {
          if (this.held) resolve();
          else if (!this.pending) reject(new Error('transient browser lease request ended without a grant'));
          else this.setTimeoutImpl(poll, 25).unref?.();
        };
        poll();
      });
    }
    if (!this.ipc.send || this.ipc.connected === false) {
      return Promise.reject(new Error('transient browser lane IPC is unavailable'));
    }
    const requestId = `transient-${this.now()}-${++this.requestSequence}`;
    return new Promise<void>((resolve, reject) => {
      const timer = this.setTimeoutImpl(() => {
        if (!this.pending || this.pending.requestId !== requestId) return;
        this.pending = undefined;
        reject(new Error('transient browser lane acquire timed out'));
      }, this.acquireTimeoutMs);
      timer.unref?.();
      this.pending = { requestId, timer, resolve, reject };
      this.ipc.send?.({
        type: 'lifecycle.transient_browser_requested',
        requestId,
        reason: String(reason || 'browser_sidecar_open').slice(0, 80),
        generation: this.lifecycleGeneration,
      });
    });
  }

  handleMessage(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const raw = message as { type?: unknown; requestId?: unknown; generation?: unknown; reason?: unknown };
    if (raw.type !== 'lifecycle.transient_browser_granted'
        && raw.type !== 'lifecycle.transient_browser_denied') return false;
    const pending = this.pending;
    if (!pending || raw.requestId !== pending.requestId) return true;
    if (Number(raw.generation) !== this.lifecycleGeneration) return true;
    this.clearTimeoutImpl(pending.timer);
    this.pending = undefined;
    if (raw.type === 'lifecycle.transient_browser_granted') {
      this.held = true;
      this.heldRequestId = pending.requestId;
      pending.resolve();
    } else {
      pending.reject(new Error(`transient browser lane denied: ${String(raw.reason || 'cancelled')}`));
    }
    return true;
  }

  release(reason: string): void {
    if (!this.held) return;
    const requestId = this.heldRequestId || 'startup';
    this.held = false;
    this.heldRequestId = null;
    this.ipc.send?.({
      type: 'lifecycle.transient_browser_released',
      requestId,
      reason: String(reason || 'browser_sidecar_closed').slice(0, 80),
      generation: this.lifecycleGeneration,
    });
  }
}

/** Sidecar decorator that makes the transient lane impossible to bypass at the actual open edge. */
export class LeasedWechatChannelsBrowserSidecar implements WechatChannelsBrowserSidecar {
  readonly browserProfileId: string;

  constructor(
    private readonly delegate: WechatChannelsBrowserSidecar,
    private readonly lease: TransientBrowserLeaseClient,
  ) {
    this.browserProfileId = delegate.browserProfileId;
  }

  getState(): ReturnType<WechatChannelsBrowserSidecar['getState']> {
    return this.delegate.getState();
  }

  async open(): Promise<void> {
    await this.lease.acquire('wechat_channels_auth');
    try {
      await this.delegate.open();
    } catch (error) {
      // Release only after the delegate proves the physical browser is closed. If teardown could
      // not be confirmed it reports `unavailable`; keep the lease until the shell's bounded timeout
      // stops the child and surfaces an honest recovery state.
      if (this.delegate.getState() === 'closed') this.lease.release('sidecar_open_failed_closed');
      throw error;
    }
  }

  readSessionCandidate(): ReturnType<WechatChannelsBrowserSidecar['readSessionCandidate']> {
    return this.delegate.readSessionCandidate();
  }

  async close(): Promise<void> {
    await this.delegate.close();
    this.lease.release('sidecar_closed');
  }

  releaseIfBrowserClosed(reason: string): void {
    if (this.delegate.getState() === 'closed') this.lease.release(reason);
  }
}

function positiveMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}
