/**
 * browser-provider.ts — 可插拔浏览器 provider（change adspower-browser-provider）。
 *
 * 把「浏览器启动 / 生命周期」从 main.ts 抽成 provider；CDP attach 及以下（定位 / 拟人 / 读身份）零改动：
 *  - SelfChromeProvider：**默认**，自起真实指纹 Chrome（委托现有 `launchChrome`），行为逐字不变。
 *  - AdsPowerProvider：opt-in，经 AdsPower 本地 API 托管指纹浏览器，拿标准 `debug_port` 交给现成 `attachToPage`。
 *
 * 红线延续（绝不静默假成功）：provider 无法交付一个可用且已就绪的浏览器时**诚实报错停手**，
 * MUST NOT 静默回落 self、MUST NOT 假成功——否则本应用独立指纹 / IP 的账号会偷偷以本机真实指纹起跑。
 */
import { launchChrome, type ChromeInstance } from './chrome-launcher.js';

export type BrowserProviderKind = 'self' | 'adspower';

/** provider.launch 入参（self 用 chromePath/profileDir/...；adspower 仅用 headless/readyTimeoutMs）。 */
export interface BrowserLaunchOptions {
  host: string;
  port: number;
  chromePath?: string;
  profileDir?: string;
  headless?: boolean;
  loginTimeoutMs?: number;
  /** CDP 就绪轮询超时（adspower 用），默认 15000。 */
  readyTimeoutMs?: number;
}

/** provider.launch 产物：浏览器实例句柄 + CDP 接入端点（adspower 端口是动态的）。 */
export interface LaunchedBrowser {
  instance: ChromeInstance;
  /** CDP 附着端点：self=传入端口；adspower=browser/start 返回的 debug_port。 */
  endpoint: { host: string; port: number };
}

export interface BrowserProvider {
  readonly kind: BrowserProviderKind;
  launch(opts: BrowserLaunchOptions): Promise<LaunchedBrowser>;
}

/** self：自起真实指纹 Chrome，委托现有 `launchChrome`（行为零变化）。 */
export class SelfChromeProvider implements BrowserProvider {
  readonly kind = 'self' as const;
  constructor(private readonly launchImpl: typeof launchChrome = launchChrome) {}

  async launch(opts: BrowserLaunchOptions): Promise<LaunchedBrowser> {
    const instance = await this.launchImpl({
      host: opts.host,
      port: opts.port,
      chromePath: opts.chromePath,
      profileDir: opts.profileDir,
      headless: opts.headless,
      loginTimeoutMs: opts.loginTimeoutMs,
    });
    // self 模式下 Chrome 绑定在传入端口上，attach 端点即传入端点。
    return { instance, endpoint: { host: opts.host, port: opts.port } };
  }
}

// ---- AdsPower ----

export interface AdsPowerConfig {
  apiBase: string;
  apiKey?: string;
  userId: string;
  /** 启动后打开的页（确保落到小红书，readSelfIdentity 才读得到），默认 explore。 */
  startUrl?: string;
}

export interface AdsPowerDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  logImpl?: (msg: string) => void;
  nowImpl?: () => number;
}

interface AdsStartData {
  ws?: { selenium?: string; puppeteer?: string };
  debug_port?: string | number;
  webdriver?: string;
}
interface AdsActiveData {
  status?: string;
}

const DEFAULT_ADS_BASE = 'http://local.adspower.net:50325';
const DEFAULT_ADS_START_URL = 'https://www.xiaohongshu.com/explore';
/** 本地 API 限速 1req/s，留余量串行节流。 */
const ADS_MIN_INTERVAL_MS = 1100;

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/**
 * adspower：经 AdsPower 本地 API（browser/start|stop|active）托管指纹浏览器。
 * 指纹层由 AdsPower 的 cdp_mask 独占（main.ts 在本模式默认关 edge 自研 stealth）。
 */
export class AdsPowerProvider implements BrowserProvider {
  readonly kind = 'adspower' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private lastApiAt = 0;

  constructor(
    private readonly cfg: AdsPowerConfig,
    deps: AdsPowerDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleep = deps.sleepImpl ?? defaultSleep;
    this.log = deps.logImpl ?? ((m) => console.log(m));
    this.now = deps.nowImpl ?? (() => Date.now());
  }

  async launch(opts: BrowserLaunchOptions): Promise<LaunchedBrowser> {
    const startUrl = this.cfg.startUrl ?? DEFAULT_ADS_START_URL;
    // 固定桌面视口（否则落进小红书窄屏布局变体致定位/滚动失效）+ 起始页，均经 launch_args 传入。
    const launchArgs = ['--window-size=1440,980', startUrl];
    const data = await this.api<AdsStartData>('browser/start', {
      user_id: this.cfg.userId,
      open_tabs: '1', // 关掉平台/历史页，留干净标签
      ip_tab: '0', // 不弹 IP 检测页
      headless: opts.headless ? '1' : '0',
      launch_args: JSON.stringify(launchArgs),
    });
    const port = Number(data?.debug_port);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(
        `[aidcp-edge] AdsPower browser/start 未返回有效 debug_port（profile=${this.cfg.userId}）——诚实失败，不回落 self`,
      );
    }
    const host = '127.0.0.1';
    this.log(`[aidcp-edge] AdsPower 启动 profile=${this.cfg.userId} → debug_port=${port}`);
    await this.waitCdpReady(host, port, opts.readyTimeoutMs ?? 15_000);

    const instance: ChromeInstance = {
      pid: null,
      reused: false, // 由本节点经 API 启动 → 退出时经 browser/stop 回收（非外部复用）
      kill: () => {
        void this.stop();
      },
      killAndConfirmDead: async () => {
        await this.stop();
        return this.confirmClosed();
      },
    };
    return { instance, endpoint: { host, port } };
  }

  /** 调本地 API（带 Bearer + 1req/s 串行节流 + code≠0 诚实报错）。 */
  private async api<T>(path: string, params: Record<string, string>): Promise<T> {
    if (this.lastApiAt !== 0) {
      const wait = ADS_MIN_INTERVAL_MS - (this.now() - this.lastApiAt);
      if (wait > 0) await this.sleep(wait);
    }
    const qs = new URLSearchParams(params).toString();
    const url = `${this.cfg.apiBase}/api/v1/${path}?${qs}`;
    const headers: Record<string, string> = {};
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers });
    } catch (e) {
      throw new Error(
        `[aidcp-edge] AdsPower 本地 API 不可达（${path}）：${(e as Error).message}` +
          '——确认 AdsPower 客户端已运行、本地 API 已开启。诚实失败，不回落 self。',
      );
    } finally {
      this.lastApiAt = this.now();
    }
    const body = (await res.json()) as { code: number; msg?: string; data?: T };
    if (body.code !== 0) {
      throw new Error(
        `[aidcp-edge] AdsPower ${path} 失败：code=${body.code} msg=${body.msg ?? ''}（诚实失败，不回落 self）`,
      );
    }
    return body.data as T;
  }

  private async waitCdpReady(host: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      try {
        const r = await this.fetchImpl(`http://${host}:${port}/json/version`);
        if (r.ok) return;
      } catch {
        /* 未就绪，继续轮询 */
      }
      if (this.now() >= deadline) {
        throw new Error(`[aidcp-edge] AdsPower 浏览器 CDP ${host}:${port} 未就绪（${timeoutMs}ms）——诚实失败`);
      }
      await this.sleep(300);
    }
  }

  private async stop(): Promise<void> {
    try {
      await this.api<unknown>('browser/stop', { user_id: this.cfg.userId });
      this.log(`[aidcp-edge] AdsPower browser/stop profile=${this.cfg.userId}`);
    } catch (e) {
      this.log(`[aidcp-edge] AdsPower stop 容忍异常：${(e as Error).message}`);
    }
  }

  /** 轮询 browser/active 确认已关（status!=Active）；无法确认返回 false（不阻塞退出）。 */
  private async confirmClosed(): Promise<boolean> {
    for (let i = 0; i < 5; i++) {
      try {
        const data = await this.api<AdsActiveData>('browser/active', { user_id: this.cfg.userId });
        if (data?.status !== 'Active') return true;
      } catch {
        return true; // 查不动就当已关，best-effort
      }
      await this.sleep(500);
    }
    return false;
  }
}

/** 按 `AIDCP_BROWSER_PROVIDER` 选 provider（默认 self）。adspower 缺 user_id / 未知 kind 诚实报错。 */
export function selectBrowserProvider(
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
    logImpl?: (msg: string) => void;
  } = {},
): BrowserProvider {
  const env = opts.env ?? process.env;
  const kind = (env.AIDCP_BROWSER_PROVIDER ?? 'self').toLowerCase();
  if (kind === 'self') return new SelfChromeProvider();
  if (kind === 'adspower') {
    const userId = env.AIDCP_ADS_USER_ID;
    if (!userId) {
      throw new Error('[aidcp-edge] AIDCP_BROWSER_PROVIDER=adspower 需要 AIDCP_ADS_USER_ID（目标 AdsPower profile id）');
    }
    const cfg: AdsPowerConfig = {
      apiBase: env.AIDCP_ADS_API_BASE ?? DEFAULT_ADS_BASE,
      apiKey: env.AIDCP_ADS_API_KEY,
      userId,
      startUrl: env.AIDCP_EXPLORE_URL,
    };
    return new AdsPowerProvider(cfg, {
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      logImpl: opts.logImpl,
    });
  }
  throw new Error(`[aidcp-edge] 未知 AIDCP_BROWSER_PROVIDER=${kind}（仅支持 self | adspower）`);
}
