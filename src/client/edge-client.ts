/**
 * 边-云 WebSocket 客户端（边缘侧）。
 *
 * 职责：
 *  - 连接云端 WS，握手（hello → welcome），声明 edgeId / app / 能力；
 *  - 接收云端下发的命令（以 plan.response 信封承载有序步骤），
 *    逐步派发给本地"定位层 + CDP 执行器"执行；
 *  - 把每步结果以 action.result 回传云端（观测/训练）；
 *  - 支持以 id 关联的请求/响应（anchor.get / select.request / note.content 等）；
 *  - 自动浏览：把笔记内容以 note.content 作为请求发给云端，等回一个决策信封
 *    （browse.next / search.execute / session.end），交由 BrowseSession 编排。
 *
 * 设计：
 *  - WebSocket 通过工厂注入（默认用运行时全局 WebSocket，Node>=22），便于单测打桩；
 *  - 实际"如何执行一个步骤"通过 StepRunner 注入，client 只管协议收发与路由。
 */

import {
  makeEnvelope,
  parseEnvelope,
  type Envelope,
  type PlanResponsePayload,
  type PlanStep,
  type ActionResultPayload,
  type AnchorGetResultPayload,
  type RemoteAnchor,
  type NoteContentPayload,
  type PublishRequestPayload,
  type SessionBudgetPayload,
  type RiskCanDoPayload,
  type RiskCanDoResultPayload,
  type RiskRecordPayload,
  type RiskRecordResultPayload,
} from '../comm/protocol.js';

/** 最小 WebSocket 抽象（与 cdp/client.ts 同形，便于测试注入） */
export interface CloudWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'close', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

export type CloudWebSocketFactory = (url: string) => CloudWebSocket;

/** 一个步骤的执行器：边缘把云端下发的 PlanStep 落到真实页面，返回结果。 */
export interface StepRunner {
  run(step: PlanStep): Promise<ActionResultPayload>;
}

/**
 * 云端主动下发（非请求响应）的浏览命令处理器。
 * 典型用于 session.end / browse.next 这类云端可主动推送的控制信令。
 */
export type BrowseCommandHandler = (env: Envelope) => void;
export type PublishCommandHandler = (env: Envelope<PublishRequestPayload>) => void;

export interface EdgeClientOptions {
  /** 云端 WS 地址，如 ws://127.0.0.1:8787 */
  url: string;
  /** 边缘节点标识 */
  edgeId: string;
  /** 业务/站点标识（如 "xhs"） */
  app?: string;
  /** 能力声明 */
  capabilities?: string[];
  /** 步骤执行器（把命令落到页面） */
  runner: StepRunner;
  /** WebSocket 工厂（默认全局 WebSocket） */
  wsFactory?: CloudWebSocketFactory;
  /** 注入时钟（测试用） */
  clock?: () => number;
  /** id 生成器（测试用） */
  idGen?: () => string;
  /** 日志（默认 console） */
  logger?: (msg: string) => void;
}

function defaultWsFactory(url: string): CloudWebSocket {
  const G = globalThis as unknown as { WebSocket?: new (u: string) => CloudWebSocket };
  if (!G.WebSocket) {
    throw new Error('global WebSocket 不可用（需 Node>=22 或浏览器）；请通过 wsFactory 注入实现');
  }
  return new G.WebSocket(url);
}

interface Pending {
  resolve: (env: Envelope) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 边-云 WS 客户端 */
export class EdgeClient {
  private ws?: CloudWebSocket;
  private readonly opts: Required<Omit<EdgeClientOptions, 'app' | 'capabilities'>> &
    Pick<EdgeClientOptions, 'app' | 'capabilities'>;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private sessionId?: string;
  private connected = false;
  private browseHandler?: BrowseCommandHandler;
  private publishHandler?: PublishCommandHandler;

  constructor(options: EdgeClientOptions) {
    this.opts = {
      url: options.url,
      edgeId: options.edgeId,
      app: options.app,
      capabilities: options.capabilities,
      runner: options.runner,
      wsFactory: options.wsFactory ?? defaultWsFactory,
      clock: options.clock ?? Date.now,
      idGen: options.idGen ?? (() => `edge-${++this.seq}`),
      logger: options.logger ?? ((m) => console.log(m)),
    };
  }

  /** 连接云端并完成握手（hello → welcome） */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = this.opts.wsFactory(this.opts.url);
      this.ws = ws;
      let settled = false;
      ws.addEventListener('open', () => {
        this.connected = true;
        settled = true;
        resolve();
      });
      ws.addEventListener('error', (ev) => {
        if (!settled) {
          settled = true;
          reject(new Error(`边-云 WS 连接失败: ${describeError(ev)}`));
        }
      });
      ws.addEventListener('close', () => {
        this.connected = false;
        this.failAllPending(new Error('边-云 WS 已关闭'));
      });
      ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    });
    const welcome = await this.request('hello', {
      edgeId: this.opts.edgeId,
      app: this.opts.app,
      capabilities: this.opts.capabilities,
    });
    const p = welcome.payload as { sessionId?: string };
    this.sessionId = p.sessionId;
    this.opts.logger(`[edge-client] 已握手，sessionId=${this.sessionId ?? '?'}`);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * 注册"云端主动下发浏览命令"处理器（session.end / browse.next 等）。
   * 返回取消注册函数。
   */
  onBrowseCommand(handler: BrowseCommandHandler): () => void {
    this.browseHandler = handler;
    return () => {
      if (this.browseHandler === handler) this.browseHandler = undefined;
    };
  }

  onPublishCommand(handler: PublishCommandHandler): () => void {
    this.publishHandler = handler;
    return () => {
      if (this.publishHandler === handler) this.publishHandler = undefined;
    };
  }

  /** 发送一条信封（不等待响应） */
  send<T>(type: Parameters<typeof makeEnvelope>[0], payload: T, id?: string): void {
    if (!this.ws || !this.connected) throw new Error('边-云 WS 未连接');
    const env = makeEnvelope(type, id ?? this.opts.idGen(), this.opts.clock(), payload as never);
    this.ws.send(JSON.stringify(env));
  }

  /** 发送并按 id 等待对应响应信封 */
  request<T>(
    type: Parameters<typeof makeEnvelope>[0],
    payload: T,
    timeoutMs = 15_000,
  ): Promise<Envelope> {
    const id = this.opts.idGen();
    const env = makeEnvelope(type, id, this.opts.clock(), payload as never);
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`边-云请求超时: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.ws || !this.connected) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('边-云 WS 未连接'));
        return;
      }
      this.ws.send(JSON.stringify(env));
    });
  }

  /**
   * 上报当前笔记内容并等待云端决策信封（browse.next / search.execute / session.end）。
   * 返回云端回包的整个信封，交由 BrowseSession 按 type 分发执行。
   */
  reportNoteContent(payload: NoteContentPayload, timeoutMs = 20_000): Promise<Envelope> {
    return this.request('note.content', payload, timeoutMs);
  }

  async requestSessionBudget(accountId?: string): Promise<SessionBudgetPayload> {
    const res = await this.request('session.budget.request', { accountId });
    return res.payload as SessionBudgetPayload;
  }

  async canDo(action: RiskCanDoPayload['action'], accountId?: string): Promise<RiskCanDoResultPayload> {
    const res = await this.request('risk.canDo', { action, accountId });
    return res.payload as RiskCanDoResultPayload;
  }

  async recordRiskAction(action: RiskRecordPayload['action'], accountId?: string): Promise<RiskRecordResultPayload> {
    const res = await this.request('risk.record', { action, accountId });
    return res.payload as RiskRecordResultPayload;
  }

  /** 向云端取某 actionId 的主缓存锚点（缓存命中可省一次 LLM） */
  async getAnchor(actionId: string): Promise<RemoteAnchor | null> {
    const res = await this.request('anchor.get', { actionId });
    const p = res.payload as AnchorGetResultPayload;
    return p.anchor ?? null;
  }

  close(): void {
    this.failAllPending(new Error('边-云客户端主动关闭'));
    this.ws?.close();
    this.connected = false;
  }

  private onMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : String(data);
    const env = parseEnvelope(text);
    if (!env) return;

    // 1) 命中等待中的响应（按 id）
    const p = this.pending.get(env.id);
    if (p) {
      this.pending.delete(env.id);
      clearTimeout(p.timer);
      p.resolve(env);
      return;
    }

    // 2) 云端主动下发的命令（以 plan.response 承载有序步骤）
    if (env.type === 'plan.response') {
      void this.onCommand(env);
      return;
    }

    // 3) 云端主动下发的浏览控制信令（session.end / browse.next / search.execute）
    if (
      env.type === 'session.end' ||
      env.type === 'browse.next' ||
      env.type === 'search.execute'
    ) {
      this.browseHandler?.(env);
      return;
    }

    if (env.type === 'publish.request') {
      this.publishHandler?.(env as Envelope<PublishRequestPayload>);
      return;
    }

    // 其他主动消息（ping 等）暂忽略
  }

  /** 执行云端下发的有序步骤命令，并逐步回传 action.result */
  private async onCommand(env: Envelope): Promise<void> {
    const payload = env.payload as PlanResponsePayload;
    const steps = payload?.steps ?? [];
    this.opts.logger(`[edge-client] 收到命令：${steps.length} 步（${payload?.reason ?? ''}）`);
    for (const step of steps) {
      let result: ActionResultPayload;
      try {
        result = await this.opts.runner.run(step);
      } catch (err) {
        result = {
          actionId: step.actionId,
          ok: false,
          outcome: 'escalated',
          attempts: 0,
          reason: `runner_error:${(err as Error).message}`,
        };
      }
      this.opts.logger(
        `[edge-client] 步骤 ${step.actionId} → ${result.ok ? 'OK' : 'FAIL'}（${result.outcome}: ${result.reason}）`,
      );
      try {
        this.send('action.result', result, env.id);
      } catch {
        // 连接可能已断；忽略回传失败
      }
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
