import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  NativePageEngineClient,
  type NativeCommitWindowHandler,
  type NativePageCommand,
  type NativePageCommandExecution,
  type NativePageEngineManifest,
  type NativePageEngineSession,
  type NativePagePlatform,
} from './client.js';

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

export class NativePageRuntime {
  private readonly client: NativePageEngineClient;
  private owner?: OpenOwner;
  private tail: Promise<void> = Promise.resolve();
  private activeAbort?: AbortController;

  constructor(private readonly options: NativePageRuntimeOptions) {
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
      ...(options.binaryArgs ? { binaryArgs: options.binaryArgs } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
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
  ): Promise<NativePageCommandExecution> {
    return this.serial(async () => {
      const session = await this.sessionFor(ownerId);
      const controller = new AbortController();
      this.activeAbort = controller;
      const forwardAbort = (): void => controller.abort();
      signal?.addEventListener('abort', forwardAbort, { once: true });
      try {
        return await session.execute(command, timeoutMs, controller.signal, commitWindowHandler);
      } finally {
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
