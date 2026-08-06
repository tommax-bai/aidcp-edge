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
 *    （page.scroll / search.execute / session.end），交由 BrowseSession 编排。
 *  - 异步命令推送：云端通过 CommandSink 异步推送控制命令（page.scroll /
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
  type PublishCommandPayload,
  type CaptchaAssistCapturePayload,
  type CaptchaAssistClickPayload,
  type UiSnapshotPayload,
  type ActionCompletedPayload,
  type PageCardsPayload,
  type NoteDetailPayload,
  type ProfileDetailPayload,
  type WelcomePayload,
  type BrowserState,
  type BrowserStatusPayload,
  type StandbyDecisionPayload,
  type PacingSnapshotPayload,
  type EdgeTaskAcquirePayload,
  type EdgeTaskReleasePayload,
  INTERACTION_INBOX_CAPABILITY,
  INTERACTION_BROWSER_CONTROL_CAPABILITY,
  INTERACTION_OFFBOARDING_CAPABILITY,
  INTERACTION_REPLY_RECOVERY_CAPABILITY,
  INTERACTION_RUNTIME_CONTROLS_CAPABILITY,
  INTERACTION_TEST_DATA_RESET_CAPABILITY,
  type InteractionAuthReopenPayload,
  type InteractionBrowserControlPayload,
  type InteractionOffboardAckPayload,
  type InteractionOffboardCommandPayload,
  type InteractionReplyReconcilePayload,
  type InteractionReplyResultAckPayload,
  type InteractionReplySendPayload,
  type InteractionRuntimeControlsPayload,
  type InteractionSyncAckPayload,
  type InteractionSyncRequestPayload,
} from '../comm/protocol.js';
import { isInteractionMessageType, validateInteractionEnvelope } from '../wechat-channels/protocol-validation.js';
import { EDGE_BUILD_CAPABILITIES } from './build-capabilities.js';
import {
  commandDiagnosticLine,
  isActiveCommandType,
  type CommandDiagnosticReason,
  type CommandDiagnosticStage,
} from './command-diagnostics.js';
import { operationDescriptorFor } from './operation-registry.js';

/** 最小 WebSocket 抽象（与 cdp/client.ts 同形，便于测试注入） */
/**
 * 云端**拒绝**了本节点的握手（change risk-state-cross-process-integrity，task 9.1）。
 *
 * 与「连不上云端」是两件不同的事，MUST 可区分：连不上是网络 / 云端不在，重试有意义；
 * 被拒是云端看清了本节点是谁之后作出的裁决（平台不一致、缺 accountId 等），
 * 重试一万次也还是同一个答案。把后者渲染成「云端离线 / 连接失败」，运营会一直去查网络，
 * 而真正要做的是把这个节点接到正确的云端、或改配置。
 *
 * 注：账号归属已改为「跟随当次会话」（change risk-target-follows-active-session），
 * 云端不再因归属不符而拒绝握手，故此处不再有「归属另一个 target」这类拒绝。
 *
 * 拒绝码与人话说明都来自云端，边缘 MUST 原样呈现、MUST NOT 改写成通用文案。
 */
export class CloudHandshakeRejectedError extends Error {
  override readonly name = 'CloudHandshakeRejectedError';

  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`Cloud 握手失败 [${code}]: ${detail}`);
  }
}

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
 * 典型用于 session.end / page.scroll 这类云端可主动推送的控制信令。
 */
export type BrowseCommandHandler = (env: Envelope) => void;
export type PlanCommandHandler = (env: Envelope<PlanResponsePayload>) => void;
/** A 阶段1 指令驱动发布：单条参数化原子指令处理器（publish.command）。 */
export type PublishAtomCommandHandler = (env: Envelope<PublishCommandPayload>) => void;
/** 同一 edge/CDP 页面写任务租约控制（acquire/release）。 */
export type EdgeTaskCommandHandler = (env: Envelope<EdgeTaskAcquirePayload | EdgeTaskReleasePayload>) => void;
/** 验证码云端协助指令处理器（captcha.assist.capture/click）。 */
export type CaptchaAssistCommandHandler = (
  env: Envelope<CaptchaAssistCapturePayload | CaptchaAssistClickPayload>,
) => void;
/** 陪伴界面数据快照处理器（ui.snapshot，cloud 主动推送；核心转 [ui-event] 行给桌面壳）。 */
export type UiSnapshotHandler = (env: Envelope<UiSnapshotPayload>) => void;
export type InteractionCommandHandler = (
  env: Envelope<
    InteractionSyncAckPayload | InteractionSyncRequestPayload | InteractionReplySendPayload | InteractionAuthReopenPayload |
    InteractionBrowserControlPayload |
    InteractionReplyResultAckPayload | InteractionReplyReconcilePayload | InteractionOffboardCommandPayload |
    InteractionOffboardAckPayload | InteractionRuntimeControlsPayload
  >,
) => void;
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
  /** 该账号的人类可读昵称（hello 上报，仅用于云端展示补充） */
  accountNickname?: string;
  /** 人类可读机器标签（hello 上报，验证码卡片据此告诉运维去哪台机器） */
  machineLabel?: string;
  /** 当前浏览器执行层真态；缺省只用于旧/非浏览平台兼容。 */
  browserState?: BrowserState;
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

/** 把构建能力位并进调用方传入的能力声明（去重、保序，构建位追加在后）。 */
function mergeBuildCapabilities(caps: string[] | undefined): string[] {
  const merged = [...(caps ?? [])];
  for (const c of EDGE_BUILD_CAPABILITIES) {
    if (!merged.includes(c)) merged.push(c);
  }
  return merged;
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
      'platform' | 'app' | 'capabilities' | 'accountId' | 'accountNickname' | 'machineLabel' | 'browserState' | 'reconnect'
    >
  > &
    Pick<EdgeClientOptions, 'platform' | 'app' | 'capabilities' | 'accountId' | 'accountNickname' | 'machineLabel' | 'browserState'>;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private sessionId?: string;
  /** welcome 握手下发的节奏快照（每类操作 floor 区间 + tempo）；重连（新 connect）后被最新 welcome 覆盖。 */
  private pacing?: PacingSnapshotPayload;
  private peerCapabilities = new Set<string>();
  private interactionRecovery?: WelcomePayload['interactionRecovery'];
  private interactionRuntime?: WelcomePayload['interactionRuntime'];
  /** TCP/WS transport 已打开；只有合法 welcome 后 connected 才为 true。 */
  private socketOpen = false;
  private connected = false;
  private intentionalClose = false;
  private reconnecting = false;
  private hasCompletedHello = false;
  private readonly reconnectOpts?: CloudReconnectOptions;
  private readonly listeners = new Map<CloudConnectionEvent, Set<CloudConnectionListener>>();
  private browseHandler?: BrowseCommandHandler;
  private planHandler?: PlanCommandHandler;
  private publishAtomHandler?: PublishAtomCommandHandler;
  private edgeTaskHandler?: EdgeTaskCommandHandler;
  private captchaAssistHandler?: CaptchaAssistCommandHandler;
  private uiSnapshotHandler?: UiSnapshotHandler;
  private interactionHandler?: InteractionCommandHandler;

  constructor(options: EdgeClientOptions) {
    this.opts = {
      url: options.url,
      edgeId: options.edgeId,
      platform: options.platform,
      app: options.app,
      // 构建能力位在此**统一并入**（design D8），绝不放进任何 driver 的 edgeCapabilities 常量：
      // 那是平台能力、有三个 driver、两条装配路径（main.ts / wechat-channels/runtime.ts），漏一个
      // driver 该平台就永久 409 且与「客户端太老」不可区分。收进构造函数 ⇒ 两条装配路径都拿不掉、
      // 新增平台不可能漏。去重后回传，避免与 driver 常量或调用方传入重复。
      capabilities: mergeBuildCapabilities(options.capabilities),
      accountId: options.accountId,
      accountNickname: options.accountNickname,
      machineLabel: options.machineLabel,
      browserState: options.browserState,
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
        this.socketOpen = true;
        this.connected = false;
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
        this.socketOpen = false;
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
    // 新 socket 尚未完成 hello/welcome；旧连接的协商结果绝不能跨代存活。
    this.hasCompletedHello = false;
    this.sessionId = undefined;
    this.peerCapabilities.clear();
    this.interactionRecovery = undefined;
    this.interactionRuntime = undefined;
    this.pacing = undefined;
    let welcome: Envelope;
    try {
      welcome = await this.request('hello', {
        edgeId: this.opts.edgeId,
        platform: this.opts.platform,
        app: this.opts.app,
        capabilities: this.opts.capabilities,
        accountId: this.opts.accountId,
        accountNickname: this.opts.accountNickname,
        machineLabel: this.opts.machineLabel,
        browserState: this.opts.browserState,
      });
    } catch (error) {
      this.failHandshake(error);
      throw error;
    }

    if (welcome.type === 'error') {
      const payload = welcome.payload as { code?: unknown; message?: unknown } | null;
      const code = typeof payload?.code === 'string' && payload.code.trim() ? payload.code.trim() : 'cloud_rejected';
      const message = typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : 'Cloud 拒绝 hello';
      const error = new CloudHandshakeRejectedError(code, message);
      this.failHandshake(error);
      throw error;
    }
    if (welcome.type !== 'welcome' || !welcome.payload || typeof welcome.payload !== 'object') {
      const error = new Error(`Cloud 握手协议错误: 期望 welcome，实际 ${welcome.type}`);
      this.failHandshake(error);
      throw error;
    }

    const p = welcome.payload as WelcomePayload;
    if (
      typeof p.sessionId !== 'string' || !p.sessionId.trim() ||
      typeof p.serverVersion !== 'string' || !p.serverVersion.trim()
    ) {
      const error = new Error('Cloud 握手协议错误: welcome 缺少有效 sessionId/serverVersion');
      this.failHandshake(error);
      throw error;
    }
    this.sessionId = p.sessionId;
    this.peerCapabilities = new Set(Array.isArray(p.capabilities) ? p.capabilities : []);
    this.interactionRecovery = p.interactionRecovery;
    this.interactionRuntime = p.interactionRuntime;
    // 节奏快照（pacing-floor-config-min-interval 设计 §4.3）：welcome 是 hello 的请求/响应，按 pending-id
    // 命中返回、永不经过主动命令白名单，故此处直接取用零白名单遗漏风险。缺省（旧云端）→ undefined，边缘用内置默认。
    this.pacing = p.pacing;
    this.hasCompletedHello = true;
    this.connected = true;
    this.opts.logger(
      `[edge-client] 已握手，sessionId=${this.sessionId ?? '?'}${this.pacing ? `，pacing tempo=${this.pacing.tempo}` : '（无 pacing，用内置默认）'}`,
    );
  }

  private failHandshake(error: unknown): void {
    this.connected = false;
    this.hasCompletedHello = false;
    this.sessionId = undefined;
    this.peerCapabilities.clear();
    this.interactionRecovery = undefined;
    this.interactionRuntime = undefined;
    this.pacing = undefined;
    this.opts.logger(`[edge-client] Cloud 握手未成立: ${error instanceof Error ? error.message : String(error)}`);
    const ws = this.ws;
    this.ws = undefined;
    this.socketOpen = false;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
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

  /** Both hello and welcome must advertise the capability before interaction v1 is usable. */
  supportsCapability(capability: string): boolean {
    return Boolean(this.opts.capabilities?.includes(capability) && this.peerCapabilities.has(capability));
  }

  isInteractionInboxNegotiated(): boolean {
    return this.supportsCapability(INTERACTION_INBOX_CAPABILITY);
  }

  /** Negotiated offboarding requires an explicit false barrier before the connector may resume. */
  hasPendingInteractionOffboard(): boolean {
    return this.supportsCapability(INTERACTION_OFFBOARDING_CAPABILITY) &&
      this.interactionRecovery?.offboardPending !== false;
  }

  getInteractionRuntimeControls(): InteractionRuntimeControlsPayload | undefined {
    return this.supportsCapability(INTERACTION_RUNTIME_CONTROLS_CAPABILITY)
      ? this.interactionRuntime
      : undefined;
  }

  isInteractionTestDataResetNegotiated(): boolean {
    return this.supportsCapability(INTERACTION_TEST_DATA_RESET_CAPABILITY);
  }

  /**
   * 注册"云端主动下发浏览命令"处理器（session.end / page.scroll 等）。
   * 返回取消注册函数。
   */
  onBrowseCommand(handler: BrowseCommandHandler): () => void {
    this.browseHandler = handler;
    return () => {
      if (this.browseHandler === handler) this.browseHandler = undefined;
    };
  }

  /** Register a whole-plan executor. Native Xiaohongshu uses this to keep plan DOM rules out of JS. */
  onPlanCommand(handler: PlanCommandHandler): () => void {
    this.planHandler = handler;
    return () => {
      if (this.planHandler === handler) this.planHandler = undefined;
    };
  }

  /** 注册 A 阶段1 指令驱动发布处理器（publish.command 逐条原子指令）。 */
  onPublishAtomCommand(handler: PublishAtomCommandHandler): () => void {
    this.publishAtomHandler = handler;
    return () => {
      if (this.publishAtomHandler === handler) this.publishAtomHandler = undefined;
    };
  }

  onEdgeTaskCommand(handler: EdgeTaskCommandHandler): () => void {
    this.edgeTaskHandler = handler;
    return () => {
      if (this.edgeTaskHandler === handler) this.edgeTaskHandler = undefined;
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

  /** Register the explicit active-command route for all Cloud → Edge interaction types. */
  onInteractionCommand(handler: InteractionCommandHandler): () => void {
    this.interactionHandler = handler;
    return () => {
      if (this.interactionHandler === handler) this.interactionHandler = undefined;
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

  /**
   * 发送并按 id 等待对应响应信封。
   *
   * `signal`（change lease-strict-preemption 4.3）：**就地作废一条在飞请求**。必须真删 pending 条目
   * 并 clearTimeout —— 只在调用方 Promise.race 而不删，这里的超时定时器（没有 unref）会把进程事件
   * 循环最长再吊住 timeoutMs（选元素是 200s；冷待机 / 关浏览器 / 退出场景对这个时延敏感）。
   * reject 用 `signal.reason`（MUST 是 TaskTakeoverError，见 execution/takeover.ts），让调用方能按
   * 类型把「被接管」与「云端不可用」分开。
   *
   * 迟到的响应安全：pending 条目已删 ⇒ 按 id 查不到、落不进来；请求 id 单调递增、永不撞新请求。
   * 绝不复用 failAllPending 做取消——那会把同时在飞的 hello / note.content / anchor.get 一起炸掉。
   */
  request<T>(
    type: Parameters<typeof makeEnvelope>[0],
    payload: T,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<Envelope> {
    const id = this.opts.idGen();
    const env = makeEnvelope(type, id, this.opts.clock(), payload as never);
    return new Promise<Envelope>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`边-云请求超时: ${type}`));
      }, timeoutMs);
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return; // 已 resolve / 已超时：不重复 reject
        clearTimeout(timer);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer });
      // hello 发生在 welcome 之前，只要求 transport 已打开；其它请求必须已有合法 Cloud session。
      const available = type === 'hello' ? this.socketOpen : this.connected;
      if (!this.ws || !available) {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('边-云 WS 未连接'));
        return;
      }
      this.ws.send(JSON.stringify(env));
    });
  }

  /**
   * 上报当前笔记内容并等待云端决策信封（search.execute / session.end 等）。
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

  /** 上报浏览器执行层真态；不会触发或代替任何页面命令。 */
  reportBrowserStatus(payload: BrowserStatusPayload): void {
    this.send('browser.status', payload);
  }

  /**
   * 上报一次宿主层让位判决（只读遥测，change report-host-standby-decisions）。
   *
   * **绝不抛**：这条回执是观测，MUST NOT 成为让位的前置条件——一次云端抖动不该让整批环境停止让出
   * 浏览器槽位，那会把一条观测通道变成新的可用性依赖。未连接 / 发送失败返回 false，调用方只记一行日志。
   */
  reportStandbyDecision(payload: StandbyDecisionPayload): boolean {
    try {
      this.send('standby.decision', payload);
      return true;
    } catch {
      return false;
    }
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
   * Rebind only the Cloud control transport. Browser/CDP ownership is outside EdgeClient and is untouched.
   * The caller must first drain page work to a safe boundary; success means the new hello/welcome completed.
   */
  async rebind(url: string, timeoutMs = 1500): Promise<void> {
    const target = String(url || '').trim();
    if (!/^wss?:\/\//i.test(target)) throw new Error('Cloud rebind target must be ws:// or wss://');
    await this.closeAndWait(timeoutMs);
    this.opts.url = target;
    await this.connect();
  }

  /**
   * 更新握手携带的账号身份（account-identity-from-login：身份翻转后按新 id 重连）。
   * 仅改下次 connect() 的 hello 身份；须在 close() 之后、connect() 之前调用。
   */
  setAccountId(accountId: string | undefined): void {
    this.opts.accountId = accountId;
  }

  /**
   * 更新握手携带的账号身份和展示名；须在 close() 之后、connect() 之前调用。
   * accountNickname 只作展示补充，云端不得用它做身份路由。
   */
  setAccountIdentity(accountId: string | undefined, accountNickname: string | undefined): void {
    this.opts.accountId = accountId;
    this.opts.accountNickname = accountNickname;
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

    if (!operationDescriptorFor(env.type)) {
      this.emitCommandDiagnostic(env, 'rejected', 'operation_unclassified');
      this.opts.logger(`[edge-client] operation_unclassified type=${env.type}; rejected`);
      return;
    }

    // 2) 视频号 interaction 主动命令/迟到 ack：协商 + strict payload + 显式 route 三道闸。
    if (isInteractionMessageType(env.type)) {
      const diagnostic = isActiveCommandType(env.type);
      if (diagnostic) this.emitCommandDiagnostic(env, 'received');
      if (!this.isInteractionInboxNegotiated()) {
        if (diagnostic) this.emitCommandDiagnostic(env, 'rejected', 'capability_not_negotiated');
        this.opts.logger(`[edge-client] 忽略未协商的 interaction type=${env.type}`);
        return;
      }
      const extension = interactionExtensionCapability(env.type);
      if (extension && !this.supportsCapability(extension)) {
        if (diagnostic) this.emitCommandDiagnostic(env, 'rejected', 'extension_not_negotiated');
        this.opts.logger(`[edge-client] 忽略未协商扩展 capability=${extension} type=${env.type}`);
        return;
      }
      try {
        validateInteractionEnvelope(env);
      } catch (error) {
        if (diagnostic) this.emitCommandDiagnostic(env, 'rejected', 'payload_invalid');
        this.opts.logger(
          `[edge-client] 拒绝非法 interaction type=${env.type}: ${error instanceof Error ? error.message : 'invalid payload'}`,
        );
        return;
      }
      if (
        env.type === 'interaction.sync.ack' ||
        env.type === 'interaction.sync.request' ||
        env.type === 'interaction.reply.send' ||
        env.type === 'interaction.auth.reopen' ||
        env.type === 'interaction.browser.control' ||
        env.type === 'interaction.runtime.controls' ||
        env.type === 'interaction.reply.result.ack' ||
        env.type === 'interaction.reply.reconcile' ||
        env.type === 'interaction.offboard.command' ||
        env.type === 'interaction.offboard.ack'
      ) {
        if (!this.interactionHandler) {
          this.emitCommandDiagnostic(env, 'rejected', 'handler_unavailable');
          return;
        }
        this.emitCommandDiagnostic(env, 'dispatched');
        this.interactionHandler(
          env as Envelope<
            InteractionSyncAckPayload | InteractionSyncRequestPayload | InteractionReplySendPayload | InteractionAuthReopenPayload |
            InteractionBrowserControlPayload |
            InteractionReplyResultAckPayload | InteractionReplyReconcilePayload | InteractionOffboardCommandPayload |
            InteractionOffboardAckPayload | InteractionRuntimeControlsPayload
          >,
        );
      }
      return;
    }

    // 3) 云端主动下发的命令（以 plan.response 承载有序步骤）
    if (env.type === 'plan.response') {
      this.emitCommandDiagnostic(env, 'received');
      if (this.planHandler) {
        this.emitCommandDiagnostic(env, 'dispatched');
        this.planHandler(env as Envelope<PlanResponsePayload>);
        return;
      }
      void this.onCommand(env);
      return;
    }

    // 4) 云端主动下发的浏览控制信令
    if (
      env.type === 'session.end' ||
      env.type === 'note.open' ||
      env.type === 'note.close' ||
      env.type === 'search.execute' ||
      env.type === 'page.scroll' ||
      // feed 深度到阈值改点右下「刷新」（change feed-refresh-on-depth）：独立主动命令 MUST 放行到 browseHandler。
      // ⚠️ 此白名单 typecheck 抓不到——漏加则 feed.refresh 在入口被静默丢弃，browse-session 的处理分支永不可达
      //    （同 §2 第4处同步点，notification-monitor 活锁前车之鉴）。与 command-bridge 的 refresh→feed.refresh 映射对应。
      env.type === 'feed.refresh' ||
      // 中途风控档位刷新（change pacing-fallback-hardening）：独立主动命令，MUST 放行到 browseHandler，
      // 否则在入口被静默丢弃 → 边缘兜底节奏收不到升档（notification-monitor 活锁前车，同 §2 第4处同步点）。
      env.type === 'pacing.update' ||
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
      // Facebook 加群原子指令：走 Facebook 命令处理器（不是 xhs BrowseSession）。漏白名单会在入口静默丢弃。
      env.type === 'group.join' ||
      env.type === 'navigation.back' ||
      env.type === 'note.browse_images' ||
      env.type === 'note.scroll_comments' ||
      env.type === 'profile.open' ||
      // 运行期身份读取（edge 侧 identity-command-gate 的救援放行清单成员）：独立主动命令，
      // MUST 放行到 browseHandler，否则在入口被静默丢弃 → command-mapper 的
      // identity_read_current 映射与 browse-session 的 identity_observation 回报分支**永不可达**，
      // 云端只看得到 20s 静默超时（与「边缘没装到」「页面读不出来」三者同形，不可区分）。
      // 这两条是身份落到「不知道浏览器里登着谁」终局时**唯一**能问出当前登录身份、解开该终局的
      // 事实来源；漏放行等于把那条自救通道在边缘这一侧也堵死（同 §2 第4处同步点）。
      // 2026-08-05 实测：云端补齐登记表后 sent=1，边缘仍静默 20s，根因即本白名单缺这两条。
      env.type === 'identity.read_current' ||
      env.type === 'identity.read_self_profile' ||
      // 观察命令「问现状」（change add-state-observation-command）：独立主动命令，MUST 放行到
      // browseHandler，否则在入口被静默丢弃 → 云端按信封 id 等 state.report 只会等到超时——
      // 与「边缘没装到」「页面读不出来」同形不可区分（§2 第 4 处同步点）。它是三段对账第③段
      // 唯一的真相探针：报错之后云端靠它问「现在到底在哪个面、登着谁」，漏放行等于把出路堵死。
      env.type === 'state.read' ||
      // 通知巡视（软中断离开流程）自身的命令：MUST 放行到 browseHandler，
      // 否则会在入口被静默丢弃 → 巡视无回执 → 恢复链永不收敛 → 会话挂死。
      // 与 command-bridge 的 open_notifications/browse_notification_* 映射对应。
      env.type === 'notification.open' ||
      env.type === 'notification.browse_comments' ||
      env.type === 'notification.browse_likes' ||
      env.type === 'notification.browse_follows' ||
      env.type === 'notification.back_home'
    ) {
      this.emitCommandDiagnostic(env, 'received');
      if (!this.browseHandler) {
        this.emitCommandDiagnostic(env, 'rejected', 'handler_unavailable');
        return;
      }
      this.emitCommandDiagnostic(env, 'dispatched');
      this.browseHandler(env);
      return;
    }

    if (env.type === 'publish.command') {
      this.emitCommandDiagnostic(env, 'received');
      if (!this.publishAtomHandler) {
        this.emitCommandDiagnostic(env, 'rejected', 'handler_unavailable');
        return;
      }
      this.emitCommandDiagnostic(env, 'dispatched');
      this.publishAtomHandler(env as Envelope<PublishCommandPayload>);
      return;
    }

    if (env.type === 'edge.task.acquire' || env.type === 'edge.task.release') {
      this.emitCommandDiagnostic(env, 'received');
      if (!this.edgeTaskHandler) {
        this.emitCommandDiagnostic(env, 'rejected', 'handler_unavailable');
        return;
      }
      this.emitCommandDiagnostic(env, 'dispatched');
      this.edgeTaskHandler(env as Envelope<EdgeTaskAcquirePayload | EdgeTaskReleasePayload>);
      return;
    }

    if (env.type === 'captcha.assist.capture' || env.type === 'captcha.assist.click') {
      this.emitCommandDiagnostic(env, 'received');
      if (!this.captchaAssistHandler) {
        this.emitCommandDiagnostic(env, 'rejected', 'handler_unavailable');
        return;
      }
      this.emitCommandDiagnostic(env, 'dispatched');
      this.captchaAssistHandler(env as Envelope<CaptchaAssistCapturePayload | CaptchaAssistClickPayload>);
      return;
    }

    // 陪伴界面数据快照（cloud 主动推送）：转给 main.ts 落成 [ui-event] 行
    if (env.type === 'ui.snapshot') {
      this.uiSnapshotHandler?.(env as Envelope<UiSnapshotPayload>);
      return;
    }

    // 已登记但无需业务 handler 的控制消息（ping/pong）到此结束。
  }

  /** 执行云端下发的有序步骤命令，并逐步回传 action.result */
  private async onCommand(env: Envelope): Promise<void> {
    const payload = env.payload as PlanResponsePayload;
    const steps = payload?.steps ?? [];
    this.emitCommandDiagnostic(env, 'dispatched');
    this.opts.logger(`[edge-client] 收到命令：${steps.length} 步`);
    let failed = false;
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
      if (!result.ok) failed = true;
      this.opts.logger(
        `[edge-client] 命令步骤 → ${result.ok ? 'OK' : 'FAIL'}（${result.outcome}）`,
      );
      try {
        this.send('action.result', result, env.id);
      } catch {
        // 连接可能已断；忽略回传失败
      }
    }
    this.emitCommandDiagnostic(env, failed ? 'failed' : 'completed', failed ? 'step_failed' : undefined);
  }

  private emitCommandDiagnostic(
    env: { id?: unknown; type?: unknown; payload?: unknown },
    stage: CommandDiagnosticStage,
    reason?: CommandDiagnosticReason,
  ): void {
    this.opts.logger(commandDiagnosticLine(env, stage, reason));
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

function interactionExtensionCapability(type: string): string | null {
  if (type === 'interaction.browser.control') return INTERACTION_BROWSER_CONTROL_CAPABILITY;
  if (type === 'interaction.runtime.controls') return INTERACTION_RUNTIME_CONTROLS_CAPABILITY;
  if (type.startsWith('interaction.reply.result.') || type.startsWith('interaction.reply.reconcile')) {
    return INTERACTION_REPLY_RECOVERY_CAPABILITY;
  }
  if (type.startsWith('interaction.offboard.')) return INTERACTION_OFFBOARDING_CAPABILITY;
  return null;
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
