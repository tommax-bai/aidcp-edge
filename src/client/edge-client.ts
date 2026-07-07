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
 *  - 异步命令推送：云端通过 CommandSink 异步推送控制命令（browse.next / browse.scroll /
 *    note.open / note.close / search.execute / session.end / notification.*），由 browseHandler 统一分发。
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
  type PublishCommandPayload,
  type CaptchaAssistCapturePayload,
  type CaptchaAssistClickPayload,
  type UiSnapshotPayload,
  type ActionCompletedPayload,
  type PageCardsPayload,
  type NoteDetailPayload,
  type ProfileDetailPayload,
  type WelcomePayload,
  type PacingSnapshotPayload,
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
/** A 阶段1 指令驱动发布：单条参数化原子指令处理器（publish.command）。 */
export type PublishAtomCommandHandler = (env: Envelope<PublishCommandPayload>) => void;
/** 验证码云端协助指令处理器（captcha.assist.capture/click）。 */
export type CaptchaAssistCommandHandler = (
  env: Envelope<CaptchaAssistCapturePayload | CaptchaAssistClickPayload>,
) => void;
/** 陪伴界面数据快照处理器（ui.snapshot，cloud 主动推送；核心转 [ui-event] 行给桌面壳）。 */
export type UiSnapshotHandler = (env: Envelope<UiSnapshotPayload>) => void;
export type CloudConnectionEvent = 'cloud.disconnected' | 'cloud.reconnecting' | 'cloud.reconnected' | 'cloud.unrecoverable';
export type CloudConnectionListener = (params: unknown) => void;

export interface CloudReconnectOptions {
  /** 最大重试次数，默认 12 */
  maxAttempts?: number;
  /** 退避基数 ms，默认 1000 */
  baseDelayMs?: number;
  /** 单次退避上限 ms，默认 15000 */
  maxDelayMs?: number;
  /** 重连总时长硬上限 ms，默认 180000 */
  hardCapMs?: number;
  /** 注入 sleep（测试用） */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 注入时钟（测试用，硬上限计时） */
  nowImpl?: () => number;
}

export interface EdgeClientOptions {
  /** 云端 WS 地址，如 ws://127.0.0.1:8787 */
  url: string;
  /** 边缘节点标识 */
  edgeId: string;
  /** 运行时平台标识（如 "xiaohongshu"） */
  platform?: string;
  /** 业务/站点标识（如 "xhs"） */
  app?: string;
  /** 能力声明 */
  capabilities?: string[];
  /** 该边缘当前驱动的账号标识（hello 上报，用于云端风控归属与验证码定位） */
  accountId?: string;
  /** 人类可读机器标签（hello 上报，验证码卡片据此告诉运维去哪台机器） */
  machineLabel?: string;
  /** 远程桌面/可达地址（hello 上报，用于人工远程处置） */
  remoteAddr?: string;
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
  /** 云端 WS 意外断线有界重连；默认开启，传 false 可关闭（测试/特殊启动路径用） */
  reconnect?: CloudReconnectOptions | false;
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
  private readonly opts: Required<
    Omit<
      EdgeClientOptions,
      'platform' | 'app' | 'capabilities' | 'accountId' | 'machineLabel' | 'remoteAddr' | 'reconnect'
    >
  > &
    Pick<EdgeClientOptions, 'platform' | 'app' | 'capabilities' | 'accountId' | 'machineLabel' | 'remoteAddr'>;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private sessionId?: string;
  /** welcome 握手下发的节奏快照（每类操作 floor 区间 + tempo）；重连（新 connect）后被最新 welcome 覆盖。 */
  private pacing?: PacingSnapshotPayload;
  private connected = false;
  private intentionalClose = false;
  private reconnecting = false;
  private hasCompletedHello = false;
  private readonly reconnectOpts?: CloudReconnectOptions;
  private readonly listeners = new Map<CloudConnectionEvent, Set<CloudConnectionListener>>();
  private browseHandler?: BrowseCommandHandler;
  private publishHandler?: PublishCommandHandler;
  private publishAtomHandler?: PublishAtomCommandHandler;
  private captchaAssistHandler?: CaptchaAssistCommandHandler;
  private uiSnapshotHandler?: UiSnapshotHandler;

  constructor(options: EdgeClientOptions) {
    this.opts = {
      url: options.url,
      edgeId: options.edgeId,
      platform: options.platform,
      app: options.app,
      capabilities: options.capabilities,
      accountId: options.accountId,
      machineLabel: options.machineLabel,
      remoteAddr: options.remoteAddr,
      runner: options.runner,
      wsFactory: options.wsFactory ?? defaultWsFactory,
      clock: options.clock ?? Date.now,
      idGen: options.idGen ?? (() => `edge-${++this.seq}`),
      logger: options.logger ?? ((m) => console.log(m)),
    };
    this.reconnectOpts = options.reconnect === false ? undefined : (options.reconnect ?? {});
  }

  /** 连接云端并完成握手（hello → welcome） */
  connect(): Promise<void> {
    this.intentionalClose = false;
    return this.openAndHello();
  }

  private openSocket(): Promise<void> {
    if (this.ws) {
      const old = this.ws;
      this.ws = undefined;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    return new Promise<void>((resolve, reject) => {
      const ws = this.opts.wsFactory(this.opts.url);
      this.ws = ws;
      let settled = false;
      ws.addEventListener('open', () => {
        if (this.ws !== ws) return;
        this.connected = true;
        settled = true;
        resolve();
      });
      ws.addEventListener('error', (ev) => {
        if (this.ws !== ws) return;
        if (!settled) {
          settled = true;
          reject(new Error(`边-云 WS 连接失败: ${describeError(ev)}`));
        }
      });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.failAllPending(new Error('边-云 WS 已关闭'));
        if (!this.intentionalClose && this.hasCompletedHello) {
          this.opts.logger('[edge-client] 云端 WS 已关闭，准备自动重连');
          this.emitEvent('cloud.disconnected', {});
          if (this.reconnectOpts && !this.reconnecting) void this.runReconnect();
        }
      });
      ws.addEventListener('message', (ev) => {
        if (this.ws !== ws) return;
        this.onMessage(ev.data);
      });
    });
  }

  private async openAndHello(): Promise<void> {
    await this.openSocket();
    const welcome = await this.request('hello', {
      edgeId: this.opts.edgeId,
      platform: this.opts.platform,
      app: this.opts.app,
      capabilities: this.opts.capabilities,
      accountId: this.opts.accountId,
      machineLabel: this.opts.machineLabel,
      remoteAddr: this.opts.remoteAddr,
    });
    const p = welcome.payload as WelcomePayload;
    this.sessionId = p.sessionId;
    // 节奏快照（pacing-floor-config-min-interval 设计 §4.3）：welcome 是 hello 的请求/响应，按 pending-id
    // 命中返回、永不经过主动命令白名单，故此处直接取用零白名单遗漏风险。缺省（旧云端）→ undefined，边缘用内置默认。
    this.pacing = p.pacing;
    this.hasCompletedHello = true;
    this.opts.logger(
      `[edge-client] 已握手，sessionId=${this.sessionId ?? '?'}${this.pacing ? `，pacing tempo=${this.pacing.tempo}` : '（无 pacing，用内置默认）'}`,
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** 取最近一次 welcome 下发的节奏快照（供 main.ts 组装 browseOpts / 重连后 applyPacingSnapshot）；缺省 undefined。 */
  getPacing(): PacingSnapshotPayload | undefined {
    return this.pacing;
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

  /** 注册 A 阶段1 指令驱动发布处理器（publish.command 逐条原子指令）。 */
  onPublishAtomCommand(handler: PublishAtomCommandHandler): () => void {
    this.publishAtomHandler = handler;
    return () => {
      if (this.publishAtomHandler === handler) this.publishAtomHandler = undefined;
    };
  }

  /** 注册验证码云端协助指令处理器（capture/click 均必须在验证码暂停期间可达）。 */
  onCaptchaAssistCommand(handler: CaptchaAssistCommandHandler): () => void {
    this.captchaAssistHandler = handler;
    return () => {
      if (this.captchaAssistHandler === handler) this.captchaAssistHandler = undefined;
    };
  }

  /** 注册陪伴界面数据快照处理器（ui.snapshot，change edge-companion-ui 8.1）。 */
  onUiSnapshot(handler: UiSnapshotHandler): () => void {
    this.uiSnapshotHandler = handler;
    return () => {
      if (this.uiSnapshotHandler === handler) this.uiSnapshotHandler = undefined;
    };
  }

  /** 订阅云端 WS 生命周期事件（cloud.disconnected/reconnecting/reconnected/unrecoverable）。 */
  on(method: CloudConnectionEvent, listener: CloudConnectionListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
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

  // risk.canDo / risk.record / session.budget.request 为 reserved 通道：风控判定云端单写，
  // 边缘不再持有互动前自判 / 自记的包装（曾在此、零调用，已随 captcha-restrict-and-interaction-gating 移除）。

  /** 向云端取某 actionId 的主缓存锚点（缓存命中可省一次 LLM） */
  async getAnchor(actionId: string): Promise<RemoteAnchor | null> {
    const res = await this.request('anchor.get', { actionId });
    const p = res.payload as AnchorGetResultPayload;
    return p.anchor ?? null;
  }

  /** 上报动作执行完成 */
  reportActionCompleted(payload: ActionCompletedPayload): void {
    this.send('action.completed', payload);
  }

  /** 上报当前可见卡片列表 */
  reportPageCards(payload: PageCardsPayload): void {
    this.send('page.cards', payload);
  }

  /** 上报笔记详情 */
  reportNoteDetail(payload: NoteDetailPayload): void {
    this.send('note.detail', payload);
  }

  /** 上报个人主页数据 */
  reportProfileDetail(payload: ProfileDetailPayload): void {
    this.send('profile.detail', payload);
  }

  close(): void {
    this.intentionalClose = true;
    this.failAllPending(new Error('边-云客户端主动关闭'));
    this.ws?.close();
    this.connected = false;
  }

  /**
   * 诚实下线：发起关闭并**等连接真正关闭**（带有界上限）再返回，使云端收到干净关闭帧、
   * 立即把本节点移出路由目标。回收/关机路径用它，避免「ws.close() 只发起握手、紧接着 process.exit
   * 把关闭帧吞掉 → 云端最长 staleAfterMs 内仍当其在线并派活」的僵尸复活（BLOCKER①）。
   */
  async closeAndWait(timeoutMs = 1500): Promise<void> {
    this.intentionalClose = true;
    this.failAllPending(new Error('边-云客户端主动关闭'));
    const ws = this.ws;
    if (!ws) {
      this.connected = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        ws.addEventListener('close', finish);
      } catch {
        /* 某些桩 ws 不支持二次注册；退化为仅超时兜底 */
      }
      const timer = setTimeout(finish, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      try {
        ws.close();
      } catch {
        finish();
      }
    });
    this.connected = false;
  }

  /**
   * 更新握手携带的账号身份（account-identity-from-login：身份翻转后按新 id 重连）。
   * 仅改下次 connect() 的 hello 身份；须在 close() 之后、connect() 之前调用。
   */
  setAccountId(accountId: string | undefined): void {
    this.opts.accountId = accountId;
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

    // 3) 云端主动下发的浏览控制信令
    if (
      env.type === 'session.end' ||
      env.type === 'browse.next' ||
      env.type === 'browse.scroll' ||
      env.type === 'note.open' ||
      env.type === 'note.close' ||
      env.type === 'search.execute' ||
      env.type === 'page.scroll' ||
      env.type === 'interaction.like' ||
      env.type === 'interaction.collect' ||
      env.type === 'interaction.follow' ||
      // 浏览闭环「发评论」：与 like/follow 同属互动命令，MUST 放行到 browseHandler，
      // 否则云端 interaction.comment 在入口被静默丢弃 → 评论永不发出（飞书已审也没用）。
      // 与 command-bridge 的 comment→interaction.comment 映射对应（同 §2 第4处同步点）。
      env.type === 'interaction.comment' ||
      // 评论点赞（AIDCP_COMMENT_LIKE 浏览闭环微互动）：与 comment 同理 MUST 放行，
      // 否则云端 comment_like→interaction.like_comment 在入口被静默丢弃、browse-session
      // 的处理分支永不可达（2026-07-03 收口 edge-companion-ui 时发现的存量缺口，同 §2 第4处同步点）。
      env.type === 'interaction.like_comment' ||
      env.type === 'navigation.back' ||
      env.type === 'note.browse_images' ||
      env.type === 'note.scroll_comments' ||
      env.type === 'profile.open' ||
      // 通知巡视（软中断离开流程）自身的命令：MUST 放行到 browseHandler，
      // 否则会在入口被静默丢弃 → 巡视无回执 → 恢复链永不收敛 → 会话挂死。
      // 与 command-bridge 的 open_notifications/browse_notification_* 映射对应。
      env.type === 'notification.open' ||
      env.type === 'notification.browse_comments' ||
      env.type === 'notification.browse_likes' ||
      env.type === 'notification.browse_follows' ||
      env.type === 'notification.back_home'
    ) {
      this.browseHandler?.(env);
      return;
    }

    if (env.type === 'publish.request') {
      this.publishHandler?.(env as Envelope<PublishRequestPayload>);
      return;
    }

    if (env.type === 'publish.command') {
      this.publishAtomHandler?.(env as Envelope<PublishCommandPayload>);
      return;
    }

    if (env.type === 'captcha.assist.capture' || env.type === 'captcha.assist.click') {
      this.captchaAssistHandler?.(env as Envelope<CaptchaAssistCapturePayload | CaptchaAssistClickPayload>);
      return;
    }

    // 陪伴界面数据快照（cloud 主动推送）：转给 main.ts 落成 [ui-event] 行
    if (env.type === 'ui.snapshot') {
      this.uiSnapshotHandler?.(env as Envelope<UiSnapshotPayload>);
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

  private emitEvent(method: CloudConnectionEvent, params: unknown): void {
    const set = this.listeners.get(method);
    if (set) for (const l of [...set]) l(params);
  }

  private async runReconnect(): Promise<void> {
    const opts = this.reconnectOpts;
    if (!opts) return;
    this.reconnecting = true;
    const maxAttempts = opts.maxAttempts ?? 12;
    const baseDelayMs = opts.baseDelayMs ?? 1_000;
    const maxDelayMs = opts.maxDelayMs ?? 15_000;
    const hardCapMs = opts.hardCapMs ?? 180_000;
    const sleep = opts.sleepImpl ?? defaultReconnectSleep;
    const now = opts.nowImpl ?? (() => Date.now());
    const deadline = now() + hardCapMs;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleep(delay);
        if (this.intentionalClose) return;
        if (now() >= deadline) break;
        this.opts.logger(`[edge-client] 云端重连中 attempt=${attempt}/${maxAttempts}`);
        this.emitEvent('cloud.reconnecting', { attempt });
        try {
          await this.openAndHello();
          if (this.intentionalClose) return;
          this.opts.logger(`[edge-client] 云端已重连，sessionId=${this.sessionId ?? '?'}`);
          this.emitEvent('cloud.reconnected', { attempt, sessionId: this.sessionId });
          return;
        } catch (err) {
          this.connected = false;
          this.failAllPending(err instanceof Error ? err : new Error(String(err)));
        }
      }
      const reason = 'cloud_reconnect_exhausted';
      this.connected = false;
      this.opts.logger('[edge-client] 云端重连耗尽，停止保持本地假运行态');
      this.emitEvent('cloud.unrecoverable', { reason });
    } finally {
      this.reconnecting = false;
    }
  }
}

function describeError(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'message' in ev) {
    return String((ev as { message: unknown }).message);
  }
  return 'unknown';
}

function defaultReconnectSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
