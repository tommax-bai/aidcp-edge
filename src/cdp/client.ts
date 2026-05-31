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

export interface CdpClientOptions {
  /** 命令超时（毫秒） */
  timeoutMs?: number;
  /**
   * WebSocket 工厂。默认用全局 WebSocket（Node>=22 / 浏览器）。
   * Node20 环境可传入基于 `ws` 包的适配器。
   */
  wsFactory?: WebSocketFactory;
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

  constructor(
    private readonly wsUrl: string,
    options: CdpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.wsFactory = options.wsFactory ?? defaultWsFactory;
  }

  /** 建立 WS 连接 */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
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
        this.connected = false;
        this.failAllPending(new Error('CDP WS 已关闭'));
      });
      ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    });
  }

  /** 发送一条 CDP 命令并等待结果 */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || !this.connected) {
      return Promise.reject(new Error('CDP 未连接，请先 connect()'));
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

  /** 关闭连接 */
  close(): void {
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
      const set = this.listeners.get(msg.method);
      if (set) for (const l of set) l(msg.params);
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
