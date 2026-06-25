/**
 * 极简 CDP（Chrome DevTools Protocol）客户端 —— 原生 WebSocket 实现，不依赖
 * chrome-remote-interface / Playwright，保持边缘端轻量。
 *
 * 职责：
 * - 与某个 page target 的 webSocketDebuggerUrl 建立 WS 连接；
 * - 以 id 关联请求/响应（CDP 是基于 JSON 消息的 RPC）；
 * - 分发 CDP 事件给监听者。
 *
 * 仅覆盖定位层接入所需的最小子集：Runtime.evaluate / DOM.getDocument 等
 * 由上层（DomProvider / ActionExecutor）通过 send() 调用。
 *
 * 运行环境：Node >= 22（内置全局 WebSocket）。Node 20 可注入自定义 ws 实现。
 */

/** CDP 命令返回的通用结构 */
export interface CdpResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** CDP 事件 */
export interface CdpEvent<T = unknown> {
  method: string;
  params: T;
}

export type CdpEventListener = (params: unknown) => void;

/** 最小 WebSocket 抽象（便于在测试/Node20 注入实现） */
export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'close', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

/**
 * CDP 连接已断开（区分于业务失败）。上层据此类型走「等重连 / 续跑」，
 * 而非把连接层丢失误当业务命令失败。
 */
export class CdpDisconnectedError extends Error {
  constructor(message = 'CDP 连接已断开') {
    super(message);
    this.name = 'CdpDisconnectedError';
  }
}

/**
 * CDP 断线有界重连配置。缺省不传即关闭重连（行为与历史一致）。
 * 总时长由 hardCapMs 运行时硬约束，须远小于云端 idle 看门狗阈值（不撞 130s）。
 */
export interface CdpReconnectOptions {
  /** 最大重试次数，默认 5 */
  maxAttempts?: number;
  /** 退避基数 ms，默认 500 */
  baseDelayMs?: number;
  /** 退避上限 ms，默认 8000 */
  maxDelayMs?: number;
  /** 重连总时长硬上限 ms，默认 90_000（到点强制放弃，绝不撞看门狗） */
  hardCapMs?: number;
  /** 重新发现目标 page 的 webSocketDebuggerUrl（旧 url 已随 target 失效）；不提供则重试原 url */
  rediscoverTarget?: () => Promise<string>;
  /** 新连接建好后回调：重 enable 域 + 重注入反检测 */
  onReconnected?: (cdp: CdpClient) => Promise<void>;
  /**
   * 进入有界退避循环**之前**的终态快判：返回 'terminal' 则跳过重连、立即发 `cdp.unrecoverable`
   * （浏览器进程已死 / 页面 target 归零，经验不可恢复——见 06-24 两次真机复现），不磨满重连预算；
   * 返回 'retry' 走正常退避循环（页面 target 仍在，可重连透明续跑）。不提供则按旧行为直接进循环。
   */
  classify?: () => Promise<'terminal' | 'retry'>;
  /** 注入 sleep（测试用） */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 注入时钟（测试用，硬上限计时） */
  nowImpl?: () => number;
}

export interface CdpClientOptions {
  /** 命令超时（毫秒） */
  timeoutMs?: number;
  /**
   * WebSocket 工厂。默认用全局 WebSocket（Node>=22 / 浏览器）。
   * Node20 环境可传入基于 `ws` 包的适配器。
   */
  wsFactory?: WebSocketFactory;
  /** CDP 断线有界重连（缺省不传即关闭，零行为变化） */
  reconnect?: CdpReconnectOptions;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 默认 WebSocket 工厂：使用运行时全局 WebSocket */
function defaultWsFactory(url: string): MinimalWebSocket {
  const G = globalThis as unknown as { WebSocket?: new (u: string) => MinimalWebSocket };
  if (!G.WebSocket) {
    throw new Error(
      'global WebSocket 不可用（需 Node>=22 或浏览器）；请通过 wsFactory 注入实现',
    );
  }
  return new G.WebSocket(url);
}

export class CdpClient {
  private ws?: MinimalWebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly timeoutMs: number;
  private readonly wsFactory: WebSocketFactory;
  private connected = false;
  private readonly reconnectOpts?: CdpReconnectOptions;
  private intentionalClose = false;
  private reconnecting = false;

  constructor(
    private wsUrl: string,
    options: CdpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.wsFactory = options.wsFactory ?? defaultWsFactory;
    this.reconnectOpts = options.reconnect;
  }

  /** 建立 WS 连接 */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    // 复用前弃用旧 ws（重连场景），避免双 socket 与迟到事件
    if (this.ws) {
      const old = this.ws;
      this.ws = undefined;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = this.wsFactory(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.connected = true;
        settled = true;
        resolve();
      });
      ws.addEventListener('error', (ev) => {
        if (!settled) {
          settled = true;
          reject(new Error(`CDP WS 连接失败: ${describeError(ev)}`));
        }
      });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return; // 已被弃用的旧 ws，忽略其 close
        this.connected = false;
        this.failAllPending(new CdpDisconnectedError('CDP WS 已关闭'));
        // 意外丢失（非主动 close）且配置了重连 → 启动有界重连
        if (!this.intentionalClose && this.reconnectOpts && !this.reconnecting) {
          void this.runReconnect();
        }
      });
      ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    });
  }

  /** 发送一条 CDP 命令并等待结果 */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || !this.connected) {
      return Promise.reject(new CdpDisconnectedError('CDP 未连接，请先 connect()'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.ws!.send(payload);
    });
  }

  /** 订阅 CDP 事件 */
  on(method: string, listener: CdpEventListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** 关闭连接（主动）。置 intentionalClose 以抢占正在进行的重连退避循环、阻止再触发重连。 */
  close(): void {
    this.intentionalClose = true;
    this.failAllPending(new Error('CDP 客户端主动关闭'));
    this.ws?.close();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private onMessage(data: unknown): void {
    let msg: CdpResponse & Partial<CdpEvent>;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return; // 忽略不可解析的帧
    }
    // 响应（带 id）
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`CDP 错误[${msg.error.code}]: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // 事件（带 method）
    if (typeof msg.method === 'string') {
      this.emitEvent(msg.method, msg.params);
    }
  }

  /** 派发事件给 on() 订阅者（CDP 事件与内部生命周期事件 cdp.reconnecting/reconnected/unrecoverable 共用） */
  private emitEvent(method: string, params: unknown): void {
    const set = this.listeners.get(method);
    if (set) for (const l of [...set]) l(params);
  }

  /**
   * 有界退避重连：重发现 target → 重连 → onReconnected（重 enable + 重注入）→ 续跑。
   * 总时长受 hardCapMs 运行时硬约束；主动 close 可随时抢占；耗尽/超时则发 'cdp.unrecoverable'。
   */
  private async runReconnect(): Promise<void> {
    const opts = this.reconnectOpts;
    if (!opts) return;
    this.reconnecting = true;
    const maxAttempts = opts.maxAttempts ?? 5;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    const maxDelayMs = opts.maxDelayMs ?? 8_000;
    const hardCapMs = opts.hardCapMs ?? 90_000;
    const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = opts.nowImpl ?? (() => Date.now());
    const deadline = now() + hardCapMs;
    try {
      // 进入退避循环前先做终态快判：端口死 / 页面归零则立即放弃，不磨满重连预算（主导失败 case 从数十秒坍缩到近零）。
      if (opts.classify) {
        let verdict: 'terminal' | 'retry' = 'retry';
        try {
          verdict = await opts.classify();
        } catch {
          verdict = 'retry'; // 快判本身出错不武断判死，退回正常退避循环
        }
        if (this.intentionalClose) return; // 主动 close 抢占
        if (verdict === 'terminal') {
          this.emitEvent('cdp.unrecoverable', { reason: 'fast-classify' });
          return;
        }
      }
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleep(delay);
        if (this.intentionalClose) return; // 主动 close 抢占重连
        if (now() >= deadline) break; // 总时长硬上限
        this.emitEvent('cdp.reconnecting', { attempt });
        try {
          if (opts.rediscoverTarget) {
            this.wsUrl = await opts.rediscoverTarget();
          }
          if (this.intentionalClose) return;
          await this.connect(); // 建新 ws；open 后 connected=true
          if (opts.onReconnected) await opts.onReconnected(this);
          this.emitEvent('cdp.reconnected', { attempt });
          return; // 成功
        } catch {
          this.connected = false; // 本次失败，继续下个 attempt
        }
      }
      this.emitEvent('cdp.unrecoverable', {}); // 次数/总时长耗尽
    } finally {
      this.reconnecting = false;
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

function describeError(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'message' in ev) {
    return String((ev as { message: unknown }).message);
  }
  return 'unknown';
}
