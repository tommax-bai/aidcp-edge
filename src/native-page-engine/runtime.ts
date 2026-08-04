import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  NativePageEngineClient,
  type NativeCommitWindowHandler,
  type NativeEngineDiagnosticSink,
  type NativePageCommand,
  type NativePageCommandExecution,
  type NativePageEngineManifest,
  type NativePageEngineSession,
  type NativePagePlatform,
} from './client.js';
import {
  createEngineDiagnosticForwarder,
  type EngineDiagnosticForwarder,
} from './diagnostic-forwarder.js';

export interface NativePageEndpoint {
  host: string;
  port: number;
  /**
   * 这个端点上那一个浏览器实例的身份证据（浏览器级调试地址）。提供方读得到就带上。
   *
   * 端口不是身份：同机多环境并行时，指纹浏览器释放的调试端口会被另一个环境复用。
   * 引擎拿它在**重连**时复核「这一次连上的还是不是当初那一个浏览器」；读不到就省略，
   * 代价是重连会被诚实拒绝，而不是附着到别人的浏览器上。
   */
  browserDebuggerUrl?: string;
}

export interface NativePageRuntimeOptions {
  binaryPath: string;
  /**
   * 端点解析入口。**会话期内会被反复调用**：建会话时一次，之后引擎每次重连各一次。
   * 因此它必须返回「此刻」的端点，而不是把第一次的结果冻在闭包里
   * （冻住的那种写法只有在「每次都重建运行时」时才是安全的）。
   */
  getEndpoint(): NativePageEndpoint;
  expectedManifest: NativePageEngineManifest;
  platform?: NativePagePlatform;
  processTimeoutMs?: number;
  /** 测试 / 开发夹具专用，与客户端同名选项一致。生产的 Rust 二进制不接受参数。 */
  binaryArgs?: string[];
  /** 测试 / 开发夹具专用：注入给引擎子进程的环境变量。 */
  env?: NodeJS.ProcessEnv;
}

interface OpenOwner {
  ownerId: string;
  session: NativePageEngineSession;
}

/**
 * ⚠️ 本组是**四处同步**的第 ③ 层（会话超时），也是最容易漏、漏了最难发现的一层。
 *
 * 引擎侧算命令预算时取 `session_timeout_ms.min(命令种类天花板)`：会话超时若小于天花板，
 * 就会把天花板**静默夹回**小值——不报错、不打日志、看着改了其实没生效。
 * 因此本值必须 ≥ 所有 Facebook 命令天花板里的最大者（当前 = 评论 180s）。
 * 另外三层：① `browse-session.ts` 请求值、② `client.ts` 准入校验、
 * ④ `native/page-engine/src/engine.rs` 的 command_timeout_ceiling。
 */
const DEFAULT_NATIVE_SESSION_TIMEOUT_MS = 45_000;
const FACEBOOK_NATIVE_SESSION_TIMEOUT_MS = 180_000;

/**
 * 丢弃一个**已经决定不再使用**的会话句柄。关闭失败（引擎已死时必然失败）不再往外抛：
 * 这个会话此刻已从 owner 位上摘掉，关不掉不能反过来堵死重建入口——
 * 「结束会话失败 → owner 没释放 → 下一次开始还是同一个死会话」这条链就是这么形成的。
 * 命令层的成败仍按各自的执行结果如实回报，这里吞掉的只是收尾动作的异常。
 */
async function discardSession(session: NativePageEngineSession): Promise<void> {
  try {
    await session.close();
  } catch {
    // 关不掉的句柄已经不在 owner 位上，进程退出兜底由传输层负责。
  }
}

/**
 * 引擎诊断行的落点：**核心进程自己的 stderr**。
 *
 * 为什么是 stderr 而不是 stdout：核心 stdout 已被两条前缀桥占用（建号人设回执 / 发布审批回执），
 * 它们按前缀拦截并按 id 关联 pending，多一路自由文本只会给那两条桥添误命中的机会。
 * stderr 同样被桌面外壳逐行 tee，且不与任何 stdout 协议桥交织。
 *
 * 到得了哪儿，如实说：外壳把未命中已知前缀的行**原样落进 `edge.log`**，并把它作为该环境的
 * 「最近一条消息」呈现。它**到不了**那条按句子播报的活动流 —— 那条流只吃结构化的 `[ui-event]`
 * 记录。本通路的读者是排障，不是实时看板，这个落点够用。
 *
 * 「走了 stderr」是传输事实、不是语义事实：外壳侧已按**内容**判定徽标与失败归因，
 * 一条良性诊断不会因为走了这根管子就把环境染红。
 */
function writeEngineDiagnostic(line: string): void {
  process.stderr.write(`${line}\n`);
}

export class NativePageRuntime {
  private readonly client: NativePageEngineClient;
  /**
   * 本运行时的诊断转发器。**公开的理由是装配闸**：它要按引用核对客户端手上那个出口
   * 就是这里造的这一个 —— 「选项加了、生产没传」是本改动最像成功的失败形态，
   * 而断言「选项可被接受」对它完全无感。
   */
  readonly diagnosticForwarder: EngineDiagnosticForwarder;
  private owner?: OpenOwner;
  private tail: Promise<void> = Promise.resolve();
  private activeAbort?: AbortController;

  constructor(private readonly options: NativePageRuntimeOptions) {
    this.diagnosticForwarder = createEngineDiagnosticForwarder(writeEngineDiagnostic);
    this.client = new NativePageEngineClient({
      binaryPath: options.binaryPath,
      processTimeoutMs: options.processTimeoutMs ?? 31_000,
      expectedManifest: options.expectedManifest,
      // 会话期内可重复取值：引擎重连时会问一次「现在该连哪里」。取不到就如实回空，
      // 绝不把上一次的端口原样回填 —— 那个端口此刻可能已经属于另一个环境的浏览器。
      resolveEndpoint: () => {
        try {
          const endpoint = options.getEndpoint();
          return { host: endpoint.host, port: endpoint.port };
        } catch {
          return undefined;
        }
      },
      // 引擎子进程错误输出的逐行出口。**必须在这里传**：客户端只提供可选项，
      // 生产装配漏传 = 通路不存在，而所有单测照绿。
      onDiagnosticLine: this.diagnosticForwarder.sink,
      ...(options.binaryArgs ? { binaryArgs: options.binaryArgs } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
  }

  /** 客户端**实际持有**的诊断出口，供装配闸按引用核对（见 `diagnosticForwarder` 的注释）。 */
  engineDiagnosticSink(): NativeEngineDiagnosticSink | undefined {
    return this.client.diagnosticSink();
  }

  static fromEnvironment(
    getEndpoint: () => NativePageEndpoint,
    platform: NativePagePlatform = 'xiaohongshu',
  ): NativePageRuntime {
    const binaryPath = String(process.env.AIDCP_NATIVE_PAGE_ENGINE_BINARY ?? '').trim();
    if (!binaryPath || !isAbsolute(binaryPath)) {
      throw new Error(`AIDCP_NATIVE_PAGE_ENGINE_BINARY is required for ${platform} Native-only runtime`);
    }
    const manifest = JSON.parse(readFileSync(join(dirname(binaryPath), 'manifest.json'), 'utf8')) as Record<string, unknown>;
    if (
      typeof manifest.engineVersion !== 'string'
      || manifest.platformAdapterVersion !== 'multi-platform-v1'
      || !Array.isArray(manifest.platformAdapters)
      || !manifest.platformAdapters.some((adapter) => (
        adapter
        && typeof adapter === 'object'
        && (adapter as { platform?: unknown }).platform === platform
        && typeof (adapter as { adapterVersion?: unknown }).adapterVersion === 'string'
      ))
      || typeof manifest.capabilityDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(manifest.capabilityDigest)
    ) {
      throw new Error('Native Page Engine package manifest is invalid');
    }
    return new NativePageRuntime({
      binaryPath,
      getEndpoint,
      platform,
      expectedManifest: {
        engineVersion: manifest.engineVersion,
        platformAdapterVersion: manifest.platformAdapterVersion,
        platformAdapters: manifest.platformAdapters as NativePageEngineManifest['platformAdapters'],
        capabilityDigest: manifest.capabilityDigest,
      },
    });
  }

  execute(
    ownerId: string,
    command: NativePageCommand,
    timeoutMs = 30_000,
    signal?: AbortSignal,
    commitWindowHandler?: NativeCommitWindowHandler,
    onCommandDispatched?: () => void,
  ): Promise<NativePageCommandExecution> {
    return this.serial(async () => {
      // 建会话发生在盖章**之前**：那一段没有命令在飞，诊断行如实标 `cmd=none`，
      // MUST NOT 顺手挂到接下来这条命令上 —— 那是把「不知道」写成「知道」。
      const session = await this.sessionFor(ownerId);
      const controller = new AbortController();
      this.activeAbort = controller;
      const forwardAbort = (): void => controller.abort();
      signal?.addEventListener('abort', forwardAbort, { once: true });
      this.diagnosticForwarder.beginCommand(command.kind);
      try {
        return await session.execute(
          command,
          timeoutMs,
          controller.signal,
          commitWindowHandler,
          onCommandDispatched,
        );
      } finally {
        this.diagnosticForwarder.endCommand();
        signal?.removeEventListener('abort', forwardAbort);
        if (this.activeAbort === controller) this.activeAbort = undefined;
      }
    });
  }

  openOwner(ownerId: string): Promise<void> {
    return this.serial(async () => {
      await this.sessionFor(ownerId);
    });
  }

  async closeOwner(ownerId: string): Promise<void> {
    this.activeAbort?.abort();
    await this.serial(async () => {
      if (this.owner?.ownerId !== ownerId) return;
      const current = this.owner;
      this.owner = undefined;
      await discardSession(current.session);
    });
  }

  async shutdown(): Promise<void> {
    this.activeAbort?.abort();
    await this.serial(async () => {
      const current = this.owner;
      this.owner = undefined;
      if (current) await discardSession(current.session);
    });
    // 收摊时把还没结账的抑制计数冲出去：关闭期若正好有一批诊断被压掉，
    // 计数悬在内存里没人报 = 又一次静默闭嘴。
    this.diagnosticForwarder.flush();
  }

  private async sessionFor(ownerId: string): Promise<NativePageEngineSession> {
    const cached = this.owner;
    if (cached?.ownerId === ownerId) {
      // 命中缓存不等于句柄还活着。返回前必须取到存活的肯定证据，取不到就按已死处理、
      // 丢弃并重开——否则引擎进程死掉之后，这里会一直把僵尸句柄发下去，
      // 每一条命令都撞「引擎已退出」，而重建入口永远轮不到。
      if (cached.session.isLive()) return cached.session;
      this.owner = undefined;
      await discardSession(cached.session);
    } else if (cached) {
      this.owner = undefined;
      await discardSession(cached.session);
    }
    const endpoint = this.options.getEndpoint();
    const suffix = ownerId.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'page';
    const session = await this.client.openSession({
      host: endpoint.host,
      port: endpoint.port,
      // 准入证据：把提供方读到的浏览器实例标识交给引擎，供它在重连时复核。
      ...(endpoint.browserDebuggerUrl ? { browserDebuggerUrl: endpoint.browserDebuggerUrl } : {}),
      platform: this.options.platform ?? 'xiaohongshu',
      sessionId: `${this.options.platform ?? 'xiaohongshu'}_${process.pid}_${Date.now().toString(36)}`,
      taskId: suffix,
      timeoutMs: (this.options.platform ?? 'xiaohongshu') === 'facebook'
        ? FACEBOOK_NATIVE_SESSION_TIMEOUT_MS
        : DEFAULT_NATIVE_SESSION_TIMEOUT_MS,
    });
    this.owner = { ownerId, session };
    return session;
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
}
