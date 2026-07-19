export const WECHAT_CONTROL_PLANE_HEARTBEAT_LINE = '[wechat-channels] control-plane heartbeat';
export const DEFAULT_WECHAT_CONTROL_PLANE_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_WECHAT_CONTROL_PLANE_HEARTBEAT_TIMEOUT_MS = 10_000;

type IntervalTimer = ReturnType<typeof setInterval>;

export interface WechatControlPlaneHeartbeatOptions {
  probe: () => Promise<{ type: string }>;
  logImpl?: (message: string) => void;
  intervalMs?: number;
  setIntervalImpl?: (callback: () => void, ms: number) => IntervalTimer;
  clearIntervalImpl?: (timer: IntervalTimer) => void;
}

/**
 * Keeps the desktop fleet projection fresh from a proven Cloud round trip, independently of
 * browser/auth/business-sync state. Timer ticks and failed probes are deliberately silent: only a
 * matching pong is evidence, so a genuinely dead/half-open runtime still ages into the fleet's stale
 * state. One probe at a time prevents slow links from accumulating requests.
 */
export class WechatControlPlaneHeartbeat {
  private readonly probe: () => Promise<{ type: string }>;
  private readonly log: (message: string) => void;
  private readonly intervalMs: number;
  private readonly setIntervalImpl: (callback: () => void, ms: number) => IntervalTimer;
  private readonly clearIntervalImpl: (timer: IntervalTimer) => void;
  private timer?: IntervalTimer;
  private inFlight = false;
  private started = false;
  private generation = 0;

  constructor(options: WechatControlPlaneHeartbeatOptions) {
    this.probe = options.probe;
    this.log = options.logImpl ?? ((message) => console.log(message));
    this.intervalMs = positiveMs(options.intervalMs, DEFAULT_WECHAT_CONTROL_PLANE_HEARTBEAT_INTERVAL_MS);
    this.setIntervalImpl = options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms));
    this.clearIntervalImpl = options.clearIntervalImpl ?? ((timer) => clearInterval(timer));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    const timer = this.setIntervalImpl(() => void this.probeNow(), this.intervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (!this.started && !this.timer) return;
    this.started = false;
    this.generation += 1;
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = undefined;
  }

  async probeNow(): Promise<void> {
    if (!this.started || this.inFlight) return;
    this.inFlight = true;
    const generation = this.generation;
    try {
      const response = await this.probe();
      if (this.started && generation === this.generation && response.type === 'pong') {
        this.log(WECHAT_CONTROL_PLANE_HEARTBEAT_LINE);
      }
    } catch {
      // Failure is intentionally silent. Logging it would refresh the stdout-backed fleet timestamp
      // and turn a failed proof into false online evidence.
    } finally {
      this.inFlight = false;
    }
  }
}

function positiveMs(raw: number | undefined, fallback: number): number {
  return Number.isFinite(raw) && Number(raw) > 0 ? Math.floor(Number(raw)) : fallback;
}
