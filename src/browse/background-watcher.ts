/**
 * 后台监测体基类（所有"只看不动"的监测体共用骨架）。
 *
 * 职责：自走时钟轮询 + 状态缓存 + 仅在状态翻转时回调一次 + 启停幂等 + 自身存活（心跳）。
 * 子类只实现 probe()（一次检测，CDP/读取失败可抛）与可选的 equals()/状态类型；检测什么、怎么归类
 * 是子类的事，循环 / 容错 / 翻转 / 启停由基类统一负责。
 *
 * 容错（按"漏判代价"分，子类通过 onProbeError 选择）：
 *  - tick()：探测失败时——'sticky'（默认）保持上一状态、不翻转（避免页面导航期瞬时失败刷假翻转）；
 *    'reset' 回落到 initialState（仅用于"读不到就当没有"的低风险监测体）。
 *  - probeNow()：直接抛（fail-closed 复检用，调用方据此"宁可信其有"）。
 *
 * 存活：记录"上次成功探测时刻"，msSinceLastOkTick() 供上层判断"是否已看不见"——绝不把"探测不了"
 * 当成"没情况"（那是传感层的假成功）。基类只暴露该度量，是否升级为告警由上层决定。
 */
export abstract class BackgroundWatcher<S> {
  protected _state: S;
  private readonly initialState: S;
  private readonly pollMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;
  protected readonly logger?: (msg: string) => void;
  private readonly onProbeError: 'sticky' | 'reset';
  private readonly clock: () => number;
  private readonly label: string;
  private onTransition?: (from: S, to: S) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private _lastOkTickAt = 0;

  constructor(initialState: S, options: BackgroundWatcherOptions = {}) {
    this._state = initialState;
    this.initialState = initialState;
    this.pollMs = options.pollMs ?? 1000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
    this.logger = options.logger;
    this.onProbeError = options.onProbeError ?? 'sticky';
    this.clock = options.clock ?? Date.now;
    this.label = options.label ?? 'watcher';
  }

  /** 子类实现：一次检测（CDP/读取失败可抛——由基类按 onProbeError 处理，或 probeNow 直接抛）。 */
  protected abstract probe(): Promise<S>;

  /** 子类可覆盖：状态相等判定（默认 ===）。 */
  protected equals(a: S, b: S): boolean {
    return a === b;
  }

  get state(): S {
    return this._state;
  }

  /** 上次成功探测距今毫秒；从未成功返回 Infinity（供"是否已看不见"判断）。 */
  msSinceLastOkTick(): number {
    return this._lastOkTickAt === 0 ? Infinity : this.clock() - this._lastOkTickAt;
  }

  /** fresh 探测（失败会抛——fail-closed 复检用）。 */
  probeNow(): Promise<S> {
    return this.probe();
  }

  /**
   * 单次探测 + 状态对比 + 翻转回调。供 start 的定时器与单测复用。
   */
  async tick(): Promise<void> {
    let next: S;
    try {
      next = await this.probe();
    } catch (err) {
      const msg = (err as Error).message;
      if (this.onProbeError === 'reset') {
        this.logger?.(`[${this.label}] 探测失败(回落初始态): ${msg}`);
        this.applyState(this.initialState);
      } else {
        this.logger?.(`[${this.label}] 探测失败(保持上一状态): ${msg}`);
      }
      return;
    }
    this._lastOkTickAt = this.clock();
    this.applyState(next);
  }

  private applyState(next: S): void {
    if (this.equals(next, this._state)) return;
    const from = this._state;
    this._state = next;
    try {
      this.onTransition?.(from, next);
    } catch (err) {
      this.logger?.(`[${this.label}] onTransition 回调异常(忽略): ${(err as Error).message}`);
    }
  }

  start(onTransition?: (from: S, to: S) => void): void {
    if (!this.stopped) return;
    this.onTransition = onTransition;
    this.stopped = false;
    const loop = async (): Promise<void> => {
      if (this.stopped) return;
      await this.tick();
      if (this.stopped) return;
      this.timer = this.setTimer(() => void loop(), this.pollMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}

export interface BackgroundWatcherOptions {
  /** 轮询间隔，默认 1000ms。 */
  pollMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  logger?: (msg: string) => void;
  /** 探测失败策略：'sticky'=保持上一状态（默认）；'reset'=回落初始态。 */
  onProbeError?: 'sticky' | 'reset';
  /** 时钟（测试可注入）。 */
  clock?: () => number;
  /** 日志前缀标签。 */
  label?: string;
}
