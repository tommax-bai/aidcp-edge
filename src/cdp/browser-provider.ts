/**
 * browser-provider.ts — 可插拔浏览器 provider（change adspower-browser-provider）。
 *
 * 把「浏览器启动 / 生命周期」从 main.ts 抽成 provider；CDP attach 及以下（定位 / 拟人 / 读身份）零改动：
 *  - AdsPowerProvider：**默认**（`AIDCP_BROWSER_PROVIDER` 缺省 = adspower），经 AdsPower 本地 API 托管指纹浏览器，
 *    拿标准 `debug_port` 交给现成 `attachToPage`；须配 `AIDCP_ADS_USER_ID`，否则诚实报错。
 *  - SelfChromeProvider：显式 `AIDCP_BROWSER_PROVIDER=self`，自起真实指纹 Chrome（委托现有 `launchChrome`），行为逐字不变。
 *    （`launch-multinode` 与 Electron 桌面版这两条 self 专属路径已各自钉回 self，不受默认翻转影响。）
 *
 * 红线延续（绝不静默假成功）：provider 无法交付一个可用且已就绪的浏览器时**诚实报错停手**，
 * MUST NOT 静默回落 self、MUST NOT 假成功——否则本应用独立指纹 / IP 的账号会偷偷以本机真实指纹起跑。
 */
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { launchChrome, type ChromeInstance } from './chrome-launcher.js';

export type BrowserProviderKind = 'self' | 'adspower';

/** provider.launch 入参（self 用 chromePath/profileDir/...；adspower 仅用 headless/readyTimeoutMs）。 */
export interface BrowserLaunchOptions {
  host: string;
  port: number;
  chromePath?: string;
  profileDir?: string;
  headless?: boolean;
  windowPosition?: { left: number; top: number };
  loginTimeoutMs?: number;
  /** CDP 就绪轮询超时（adspower 用），默认 15000。 */
  readyTimeoutMs?: number;
}

/** provider.launch 产物：浏览器实例句柄 + CDP 接入端点（adspower 端口是动态的）。 */
export interface LaunchedBrowser {
  instance: ChromeInstance;
  /** CDP 附着端点：self=传入端口；adspower=V2 active/start 返回或已验证失联 marker 的 debug_port。 */
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
      windowPosition: opts.windowPosition,
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
  apiTimeoutMs?: number;
  cdpProbeTimeoutMs?: number;
  /** 关闭确认用的调试端点探活（默认 chrome-launcher.probeCdp）；测试可注入。 */
  probeCdpImpl?: (host: string, port: number, fetchImpl: typeof fetch) => Promise<boolean>;
  /** 软停止未生效时的 OS 级强杀兜底（默认按调试端口反查监听进程 SIGKILL）；测试可注入。 */
  osKillImpl?: (host: string, port: number, log: (m: string) => void) => Promise<boolean>;
  /** OS 级强杀兜底开关（默认随 env AIDCP_ADS_CLOSE_OS_KILL，缺省开）。 */
  osKillEnabled?: boolean;
  /** 关闭确认轮询次数（迭代限界，勿用 Date.now，测试注入恒定 now 才不死循环）。 */
  closeConfirmTries?: number;
  /** 关闭确认每次轮询间隔 ms。 */
  closeConfirmIntervalMs?: number;
  /** 单次关闭探测超时 ms（小于轮询间隔量级，保最坏总时长落在退出预算内）。 */
  closeProbeTimeoutMs?: number;
  /** Ads CLI profile cache 根目录；生产缺省 ~/.adspowerCli/source/cache，测试可注入隔离目录。 */
  adsCacheRoot?: string;
}

interface AdsStartData {
  ws?: { selenium?: string; puppeteer?: string };
  debug_port?: string | number;
  webdriver?: string;
}

interface AdsActiveData extends AdsStartData {
  status?: string;
}

const DEFAULT_ADS_BASE = 'http://local.adspower.net:50325';
const DEFAULT_ADS_START_URL = 'https://www.xiaohongshu.com/explore';
/** 本地 API 限速 1req/s，留余量串行节流。 */
const ADS_MIN_INTERVAL_MS = 1100;
const DEFAULT_ADS_API_TIMEOUT_MS = 30_000;
const DEFAULT_ADS_CDP_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_ADS_CACHE_ROOT = join(homedir(), '.adspowerCli', 'source', 'cache');
const MAX_ORPHAN_CACHE_CANDIDATES = 8;
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const DEVTOOLS_BROWSER_PATH_RE = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/;
/**
 * 关闭确认：每个阶段（停止 / 重发停止 / OS 杀后）轮询该 profile 调试端点是否变暗的次数与间隔。
 * 每次探测都设**小超时**（closeProbeTimeoutMs），超时/异常一律视为「仍应答」（浏览器可能只是慢/挂，
 * 绝不据此假报已关）；只有连续 K 次**明确不应答**（连接被拒 = 端口无监听）才判真死，过滤单次瞬态。
 * 最坏（端口挂着一直超时）≈ 2 阶段 × 5×(0.35+0.25)s + 一次 1req/s 节流 ≈ 7.6s，稳落在外壳退出期
 * gracefulStopAllAndQuit 的 10s 有界等待内（避免退出期截断致孤儿）。正常 stop 秒级生效即在首阶段确认。
 */
const DEFAULT_CLOSE_CONFIRM_TRIES = 5;
const DEFAULT_CLOSE_CONFIRM_INTERVAL_MS = 250;
/** 单次关闭探测超时：小于轮询间隔量级，使「端口挂着一直超时」的最坏总时长仍落在 10s 退出预算内。 */
const DEFAULT_CLOSE_PROBE_TIMEOUT_MS = 350;
/** 判「真死」所需的连续不应答次数（过滤单次瞬态错误，防残余假成功）。 */
const CLOSE_CONFIRM_DARK_STREAK = 2;

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
const positiveMs = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
const positiveInt = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

function envOsKillEnabled(): boolean {
  const v = (process.env.AIDCP_ADS_CLOSE_OS_KILL ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v); // 缺省开
}

/**
 * 关闭探测（默认）：判该 profile 的**本机调试端点**是否仍在监听（浏览器是否还活着）。
 * 有界超时；**返回 true = 仍应答/仍活**：收到任意 HTTP 响应=在监听；超时（TCP 接受但 HTTP 慢/挂）也当仍活
 * （绝不据「慢」判已关）。**只有连接被拒 / 复位**（端口无监听）才返回 false = 已死。与「查不动当已关」相反。
 */
async function defaultProbeAlive(
  host: string,
  port: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(`http://${host}:${port}/json/version`, { signal: controller.signal });
    return true; // 有响应 = 端口在监听 = 仍活
  } catch {
    return controller.signal.aborted; // 超时（aborted）= 仍在监听但慢 = 仍活(true)；连接被拒 = 已死(false)
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OS 级强杀兜底：按浏览器**本机调试端口**反查其**监听进程**并 SIGKILL（仅打监听者、不误伤客户端连接）。
 * 仅对本机端口生效；win32 暂不支持（返回 false → 上层如实判未确认，绝不假成功）。
 */
async function defaultOsKill(host: string, port: number, log: (m: string) => void): Promise<boolean> {
  if (host !== '127.0.0.1' && host !== 'localhost') return false;
  if (process.platform === 'win32') return false;
  const pids = await new Promise<number[]>((resolve) => {
    // 地址+端口双限定（-iTCP@host:port）：只打绑在该回环端点上的监听者（浏览器），不误伤同端口他址监听。
    execFile('lsof', ['-nP', `-iTCP@${host}:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 3_000 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      resolve(
        String(stdout)
          .split(/\s+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      );
    });
  });
  if (pids.length === 0) return false;
  let anyKilled = false;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      anyKilled = true;
      log(`[aidcp-edge] OS 级强杀调试端口 ${port} 监听进程 pid=${pid}`);
    } catch {
      /* 进程可能已退出 */
    }
  }
  return anyKilled;
}

/**
 * adspower：经 AdsPower V2 本地 API（browser-profile/start|stop|active）托管指纹浏览器。
 * 反检测整层交 AdsPower（main.ts 在本模式默认关 edge 自研 stealth）：自动化痕迹由 cdp_mask
 * （browser-profile/start 字段，默认开，掩盖 navigator.webdriver 等 CDP 特征）掩盖、指纹由该 profile 的
 * fingerprint_config（Canvas/WebGL/UA/时区…按分身稳定生成）负责——两者是 AdsPower 的两套独立机制。
 */
export class AdsPowerProvider implements BrowserProvider {
  readonly kind = 'adspower' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly apiTimeoutMs: number;
  private readonly cdpProbeTimeoutMs: number;
  private readonly probeCdpImpl: (host: string, port: number, fetchImpl: typeof fetch) => Promise<boolean>;
  private readonly osKillImpl: (host: string, port: number, log: (m: string) => void) => Promise<boolean>;
  private readonly osKillEnabled: boolean;
  private readonly closeConfirmTries: number;
  private readonly closeConfirmIntervalMs: number;
  private readonly closeProbeTimeoutMs: number;
  private readonly adsCacheRoot: string;
  private lastApiAt = 0;

  constructor(
    private readonly cfg: AdsPowerConfig,
    deps: AdsPowerDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleep = deps.sleepImpl ?? defaultSleep;
    this.log = deps.logImpl ?? ((m) => console.log(m));
    this.now = deps.nowImpl ?? (() => Date.now());
    this.apiTimeoutMs = positiveMs(deps.apiTimeoutMs, DEFAULT_ADS_API_TIMEOUT_MS);
    this.cdpProbeTimeoutMs = positiveMs(deps.cdpProbeTimeoutMs, DEFAULT_ADS_CDP_PROBE_TIMEOUT_MS);
    this.osKillImpl = deps.osKillImpl ?? defaultOsKill;
    this.osKillEnabled = deps.osKillEnabled ?? envOsKillEnabled();
    this.closeConfirmTries = positiveInt(deps.closeConfirmTries, DEFAULT_CLOSE_CONFIRM_TRIES);
    this.closeConfirmIntervalMs = positiveMs(deps.closeConfirmIntervalMs, DEFAULT_CLOSE_CONFIRM_INTERVAL_MS);
    this.closeProbeTimeoutMs = positiveMs(deps.closeProbeTimeoutMs, DEFAULT_CLOSE_PROBE_TIMEOUT_MS);
    this.adsCacheRoot = resolve(deps.adsCacheRoot ?? DEFAULT_ADS_CACHE_ROOT);
    // 默认探测走有界超时的「仍活」判据（超时=仍活、连接被拒=已死）；测试可注入即时桩。
    this.probeCdpImpl = deps.probeCdpImpl ?? ((h, p, f) => defaultProbeAlive(h, p, f, this.closeProbeTimeoutMs));
  }

  async launch(opts: BrowserLaunchOptions): Promise<LaunchedBrowser> {
    const startUrl = this.cfg.startUrl ?? DEFAULT_ADS_START_URL;
    // 固定桌面视口（否则落进小红书窄屏布局变体致定位/滚动失效；FB 同理，窄窗触发响应式移动布局、无 role=feed/article）
    //   --window-size 作兜底；--start-maximized 覆盖 AdsPower profile 记忆的小窗口（探针实测默认 360px 窄窗压过
    //   --window-size → FB 移动布局），与 self 模式 chrome-launcher 一致强制 PC 布局。
    // + 关权限弹窗（--deny-permission-prompts：通知/定位/摄像头等一律拒绝而非弹窗，见 change browser-permission-prompt-defaults）
    // + 界面语言钉英文（--lang=en-US：只兜登出/未登录 chrome 的界面语言，belt-not-authority——登录态群面语言由 AdsPower 指纹
    //   语言 + FB 账号服务端语言主导，此参数改不动，见 change facebook-locale-pin-en-us）+ 起始页，均经 launch_args 传入。
    const launchArgs = ['--window-size=1440,980', '--start-maximized', '--deny-permission-prompts', '--lang=en-US'];
    if (opts.windowPosition) {
      launchArgs.push(`--window-position=${Math.floor(opts.windowPosition.left)},${Math.floor(opts.windowPosition.top)}`);
    }
    launchArgs.push(startUrl);
    this.log(`[aidcp-edge] 检查 AdsPower V2 profile active=${this.cfg.userId} ...`);
    const active = await this.apiV2<AdsActiveData>('GET', 'browser-profile/active', {
      query: { profile_id: this.cfg.userId },
    });
    const activeStatus = String(active?.status ?? '').trim().toLowerCase();
    let port = 0;
    if (activeStatus === 'active') {
      port = Number(active?.debug_port);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(
          `[aidcp-edge] AdsPower browser-profile/active 已报告 Active 但未返回有效 debug_port（profile=${this.cfg.userId}）——诚实失败，不启动重复浏览器`,
        );
      }
      this.log(`[aidcp-edge] AdsPower V2 已有活跃 profile=${this.cfg.userId} → debug_port=${port}`);
    } else if (activeStatus === 'inactive') {
      const orphan = await this.findValidatedOrphanCdp();
      if (orphan) {
        port = orphan.port;
        this.log(
          `[aidcp-edge] AdsPower V2 registry 未登记但检测到该 profile 的有效 CDP，接管失联浏览器 profile=${this.cfg.userId} → debug_port=${port}`,
        );
      } else {
        this.log(`[aidcp-edge] 请求 AdsPower V2 browser-profile/start profile=${this.cfg.userId} ...`);
        const data = await this.apiV2<AdsStartData>('POST', 'browser-profile/start', {
          body: {
            profile_id: this.cfg.userId,
            last_opened_tabs: '0', // 不恢复历史标签，交付干净的自动化起始页
            ip_tab: '0', // 不弹 IP 检测页
            headless: opts.headless ? '1' : '0',
            launch_args: launchArgs,
          },
        });
        port = Number(data?.debug_port);
        this.log(`[aidcp-edge] AdsPower V2 启动 profile=${this.cfg.userId} → debug_port=${port}`);
      }
    } else {
      throw new Error(
        `[aidcp-edge] AdsPower browser-profile/active 返回未知状态 ${JSON.stringify(active?.status)}（profile=${this.cfg.userId}）——诚实失败，不启动重复浏览器`,
      );
    }
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(
        `[aidcp-edge] AdsPower browser-profile/start 未返回有效 debug_port（profile=${this.cfg.userId}）——诚实失败，不回落 self`,
      );
    }
    const host = '127.0.0.1';
    await this.waitCdpReady(host, port, opts.readyTimeoutMs ?? 15_000);

    const instance: ChromeInstance = {
      pid: null,
      reused: false, // 由本节点启动或接管 → 退出时均经 V2 stop 回收（ChromeInstance.reused 仅指 self 外部 Chrome）
      kill: () => {
        void this.stop();
      },
      // 权威关闭：以该 profile 调试端点是否变暗判死活，软停止未生效则升级（重发 + OS 级强杀），
      // 无法确认绝不假成功（红线：绝不静默假成功）。endpoint 端口即此处交付的 debug_port。
      killAndConfirmDead: async () => this.closeAndConfirm(host, port),
    };
    return { instance, endpoint: { host, port } };
  }

  /** 调 V2 本地 API（带 Bearer + 1req/s 串行节流 + code≠0 诚实报错）。 */
  private async apiV2<T>(
    method: 'GET' | 'POST',
    path: string,
    request: { query?: Record<string, string>; body?: Record<string, unknown> },
  ): Promise<T> {
    if (this.lastApiAt !== 0) {
      const wait = ADS_MIN_INTERVAL_MS - (this.now() - this.lastApiAt);
      if (wait > 0) await this.sleep(wait);
    }
    const qs = new URLSearchParams(request.query ?? {}).toString();
    const apiBase = this.cfg.apiBase.replace(/\/+$/, '');
    const url = `${apiBase}/api/v2/${path}${qs ? `?${qs}` : ''}`;
    const headers: Record<string, string> = {};
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchWithTimeout(
        url,
        { method, headers, ...(method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}) },
        this.apiTimeoutMs,
        path,
      );
    } catch (e) {
      const message = (e as Error).message || String(e);
      throw new Error(
        `[aidcp-edge] AdsPower 本地 API 不可达（${path}）：${message}` +
          '——确认 AdsPower 客户端已运行、本地 API 已开启。诚实失败，不回落 self。',
      );
    } finally {
      this.lastApiAt = this.now();
    }
    if (!res.ok) {
      throw new Error(`[aidcp-edge] AdsPower ${path} 响应异常：HTTP ${res.status}（诚实失败，不回落 self）`);
    }
    let body: { code: number; msg?: string; data?: T };
    try {
      body = await this.withTimeout(
        res.json() as Promise<{ code: number; msg?: string; data?: T }>,
        this.apiTimeoutMs,
        `${path} 响应`,
      );
    } catch (e) {
      const message = (e as Error).message || String(e);
      throw new Error(`[aidcp-edge] AdsPower ${path} 响应异常：${message}（诚实失败，不回落 self）`);
    }
    if (body.code !== 0) {
      throw new Error(
        `[aidcp-edge] AdsPower ${path} 失败：code=${body.code} msg=${body.msg ?? ''}（诚实失败，不回落 self）`,
      );
    }
    return body.data as T;
  }

  /**
   * CLI daemon 重启会丢失 active registry，但已起的 SunBrowser 可能继续监听 CDP。只在目标 profile 的
   * cache 目录内做有界查找，并同时核对 DevToolsActivePort 的端口、browser path 与 /json/version；
   * 任一不一致都拒绝，绝不只凭「某端口可连」接管。
   */
  private async findValidatedOrphanCdp(): Promise<{ host: '127.0.0.1'; port: number } | null> {
    if (!PROFILE_ID_RE.test(this.cfg.userId)) return null;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.adsCacheRoot, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return null;
    }
    const prefix = `${this.cfg.userId}_`;
    const candidates = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, MAX_ORPHAN_CACHE_CANDIDATES);
    const rootPrefix = `${this.adsCacheRoot}${sep}`;
    for (const entry of candidates) {
      const markerPath = resolve(this.adsCacheRoot, entry.name, 'DevToolsActivePort');
      if (!markerPath.startsWith(rootPrefix)) continue;
      let raw: string;
      try {
        const markerStat = await lstat(markerPath);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) continue;
        raw = await readFile(markerPath, 'utf8');
      } catch {
        continue;
      }
      const [portLine, browserPathLine] = raw.split(/\r?\n/);
      const port = Number(portLine?.trim());
      const browserPath = browserPathLine?.trim() ?? '';
      if (!Number.isInteger(port) || port <= 0 || port > 65_535 || !DEVTOOLS_BROWSER_PATH_RE.test(browserPath)) {
        continue;
      }
      try {
        const response = await this.fetchWithTimeout(
          `http://127.0.0.1:${port}/json/version`,
          {},
          this.cdpProbeTimeoutMs,
          'orphan-cdp/json/version',
        );
        if (!response.ok) continue;
        const version = await this.withTimeout(
          response.json() as Promise<{ webSocketDebuggerUrl?: unknown }>,
          this.cdpProbeTimeoutMs,
          'orphan-cdp/json/version 响应',
        );
        const ws = new URL(String(version?.webSocketDebuggerUrl ?? ''));
        const hostname = ws.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
        if (ws.protocol !== 'ws:' || !loopback || Number(ws.port) !== port || ws.pathname !== browserPath) continue;
        return { host: '127.0.0.1', port };
      } catch {
        continue;
      }
    }
    return null;
  }

  private async waitCdpReady(host: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      try {
        const remaining = Math.max(1, deadline - this.now());
        const r = await this.fetchWithTimeout(
          `http://${host}:${port}/json/version`,
          {},
          Math.min(this.cdpProbeTimeoutMs, remaining),
          'cdp/json/version',
        );
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

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    label: string,
  ): Promise<Response> {
    const controller = new AbortController();
    try {
      return await this.withTimeout(
        this.fetchImpl(url, { ...init, signal: controller.signal }),
        timeoutMs,
        label,
        () => controller.abort(),
      );
    } catch (e) {
      if (controller.signal.aborted) throw new Error(`${label} 超时（${timeoutMs}ms）`);
      throw e;
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
    onTimeout?: () => void,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            reject(new Error(`${label} 超时（${timeoutMs}ms）`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 调 V2 browser-profile/stop 请求关闭；失败**如实返回并记日志**（不再静默吞成假成功）。 */
  private async stop(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.apiV2<unknown>('POST', 'browser-profile/stop', { body: { profile_id: this.cfg.userId } });
      this.log(`[aidcp-edge] AdsPower V2 browser-profile/stop profile=${this.cfg.userId}`);
      return { ok: true };
    } catch (e) {
      const error = (e as Error).message || String(e);
      this.log(`[aidcp-edge] ⚠ AdsPower browser-profile/stop 失败（profile=${this.cfg.userId}）：${error}`);
      return { ok: false, error };
    }
  }

  /**
   * 有界轮询该 profile 的**调试端点**（`/json/version`）是否不再应答 = 浏览器进程真退出。
   * 这是**独立于 AdsPower 自报状态**的权威判据：浏览器存活期其本机调试端口一直应答（即便暂停
   * 已拆掉本进程的 CDP 客户端连接，端口仍监听），端口不再应答才是真死。迭代次数限界（勿用 Date.now，
   * 否则测试注入恒定 now 会死循环）。端口仍应答=未死返回 false。
   */
  private async waitPortDark(host: string, port: number): Promise<boolean> {
    let darkStreak = 0;
    for (let i = 0; i < this.closeConfirmTries; i++) {
      // probeCdpImpl 返回 true=仍应答/仍活，false=不应答（连接被拒=已死）；默认实现带超时（超时→仍活）。
      if (await this.probeCdpImpl(host, port, this.fetchImpl)) {
        darkStreak = 0; // 端口仍应答 → 连读清零
      } else if (++darkStreak >= CLOSE_CONFIRM_DARK_STREAK) {
        return true; // 连续 K 次不应答 = 真死（过滤单次瞬态错误，防残余假成功）
      }
      await this.sleep(this.closeConfirmIntervalMs);
    }
    return false; // 上限内未连续确认不应答 = 未确认已死（仍活或不确定）
  }

  /**
   * 关闭并按权威端点实证确认：软停止 → 等端口变暗 → 未暗重发停止 → 仍未暗则 OS 级强杀兜底 → 再确认。
   * 全程无法确认端口变暗（或无法取得可杀进程）时**如实返回 false**（未确认关闭），MUST NOT 假成功。
   * 关闭按 profile 重新发起、以端点判定，不依赖关闭前 CDP 客户端连接状态（暂停驻留后仍能收敛）。
   */
  private async closeAndConfirm(host: string, port: number): Promise<boolean> {
    await this.stop();
    if (await this.waitPortDark(host, port)) return true;

    this.log(`[aidcp-edge] AdsPower 首次停止后调试端口仍应答，重发 V2 browser-profile/stop profile=${this.cfg.userId}`);
    await this.stop();
    if (await this.waitPortDark(host, port)) return true;

    if (this.osKillEnabled) {
      this.log(`[aidcp-edge] 软停止未使浏览器退出，升级 OS 级强杀 profile=${this.cfg.userId} 调试端口=${port}`);
      const killed = await this.osKillImpl(host, port, this.log);
      if (killed && (await this.waitPortDark(host, port))) return true;
    }

    this.log(
      `[aidcp-edge] ⚠ AdsPower 关闭未能确认浏览器真死（profile=${this.cfg.userId}，端口=${port}）——如实回报未确认，不假成功`,
    );
    return false;
  }
}

/** 按 `AIDCP_BROWSER_PROVIDER` 选 provider（**默认 adspower**）。adspower 缺 user_id / 未知 kind 诚实报错。 */
export function selectBrowserProvider(
  opts: {
    env?: NodeJS.ProcessEnv;
    startUrl?: string;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
    logImpl?: (msg: string) => void;
  } = {},
): BrowserProvider {
  const env = opts.env ?? process.env;
  const kind = (env.AIDCP_BROWSER_PROVIDER ?? 'adspower').toLowerCase();
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
      startUrl: opts.startUrl ?? env.AIDCP_EXPLORE_URL,
    };
    return new AdsPowerProvider(cfg, {
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      logImpl: opts.logImpl,
    });
  }
  throw new Error(`[aidcp-edge] 未知 AIDCP_BROWSER_PROVIDER=${kind}（仅支持 self | adspower）`);
}
