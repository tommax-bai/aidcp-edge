/**
 * Chrome 生命周期管理：由 edge 进程自己启动 / 复用 Chrome，而不再假设外部已启动。
 *
 * 设计：
 * - 先探测 CDP 端口（GET /json/version）。已有实例则复用，避免重复启动。
 * - 否则发现 chrome.exe 路径并以固定调试参数启动一个独立 user-data-dir 的实例。
 * - 启动后轮询 /json/version 直到端口就绪（超时 10s）。
 * - 首次启动（profile 不存在）时打开起始页并提示人工登录，等待 stdin Enter。
 *
 * 为便于单元测试，所有副作用（spawn / fetch / fs / readline / stdout）均可注入。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readlinkSync, unlinkSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

export interface ChromeLauncherOptions {
  /** CDP host，默认 127.0.0.1 */
  host?: string;
  /** CDP 端口，默认 9222 */
  port?: number;
  /** Chrome 可执行文件路径（覆盖自动发现） */
  chromePath?: string;
  /** user-data-dir，默认 ~/.aidcp-chrome-profile */
  profileDir?: string;
  /** 是否 headless（默认 false：需要人工登录） */
  headless?: boolean;
  /** 启动时的窗口位置提示；最终位置仍由 CDP 停放校准。 */
  windowPosition?: { left: number; top: number };
  /** 启动后打开的 URL（默认小红书 explore 页） */
  startUrl?: string;
  /** 探测/启动就绪超时（毫秒），默认 10000 */
  readyTimeoutMs?: number;
  /**
   * 是否允许复用端口上已有的 Chrome（默认 false：诚实拒绝静默接管）。
   * 默认读环境变量 AIDCP_CDP_ALLOW_REUSE（'1'/'true'/'yes' 视为开启）。
   * 多节点同机运行时，每个节点必须使用独立调试端口 + 独立用户数据目录；
   * 探测到端口已有别人的 Chrome 时默认诚实报错、绝不静默 attach（红线：绝不静默假成功）。
   */
  allowReuse?: boolean;

  // --- 以下为可注入依赖（测试用，业务无需传） ---
  /** 注入 fetch */
  fetchImpl?: typeof fetch;
  /** 注入 spawn */
  spawnImpl?: typeof spawn;
  /** 注入文件存在性判断（默认 fs.existsSync） */
  existsImpl?: (p: string) => boolean;
  /** 注入 sleep（默认 setTimeout 包装），便于测试快进 */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 登录检测轮询间隔（毫秒），默认 2000 */
  loginPollIntervalMs?: number;
  /** 登录等待超时（毫秒），默认 5 分钟 */
  loginTimeoutMs?: number;
  /** 注入“等待登录完成”逻辑（默认自动检测登录态） */
  waitForLoginImpl?: (ctx: LoginWaitContext) => Promise<void>;
  /** 注入登录态探测逻辑（测试用） */
  probeLoginImpl?: (host: string, port: number, fetchImpl: typeof fetch) => Promise<LoginProbeResult>;
  /** 注入“确保复用实例有可用页面标签”逻辑（测试用） */
  ensurePageTargetImpl?: (
    host: string,
    port: number,
    startUrl: string,
    fetchImpl: typeof fetch,
    log: (msg: string) => void,
  ) => Promise<void>;
  /** 注入日志输出（默认 console.log） */
  logImpl?: (msg: string) => void;
  /** 注入“清理陈旧单例锁”逻辑（测试用；默认 clearStaleSingletonLock） */
  clearSingletonLockImpl?: (profileDir: string, log: (msg: string) => void) => void;
}

export interface LoginWaitContext {
  host: string;
  port: number;
  startUrl: string;
  timeoutMs: number;
  pollIntervalMs: number;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  logImpl: (msg: string) => void;
  probeLoginImpl?: (host: string, port: number, fetchImpl: typeof fetch) => Promise<LoginProbeResult>;
}

export interface ChromeInstance {
  /** 子进程 pid；null 表示复用了已有实例 */
  pid: number | null;
  /** 是否复用了已有实例 */
  reused: boolean;
  /** 关闭实例（仅自己启动的才真正 kill） */
  kill: () => void;
  /**
   * 回收路径用：终止本进程独占的 Chrome 并**确认其真死、调试端口释放**；
   * 优雅 SIGTERM 在 grace 内未释放端口则升级 SIGKILL。返回 true=端口已确认释放，false=升级后仍占用。
   * 复用实例（不拥有该浏览器）为 no-op、直接返回 true（绝不回收外部浏览器）。
   * 这道确认屏障须在「仍活着的旧进程」上跑完再退出，否则重起的新进程会被 clearStaleSingletonLock 诚实拒启。
   */
  killAndConfirmDead: (opts?: {
    sigtermGraceMs?: number;
    sigkillGraceMs?: number;
    pollMs?: number;
  }) => Promise<boolean>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE_DIR = join(homedir(), '.aidcp-chrome-profile');
const DEFAULT_START_URL = 'https://www.xiaohongshu.com/explore';
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_LOGIN_POLL_INTERVAL_MS = 2_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CHROME_LOG_DIR = join(homedir(), '.aidcp-edge-logs');

function chromeLogPath(): string {
  const dir = process.env.AIDCP_CHROME_LOG_DIR ?? DEFAULT_CHROME_LOG_DIR;
  mkdirSync(dir, { recursive: true });
  return join(dir, 'chrome-stderr.log');
}

/** Windows 常见 chrome.exe 安装位置（按优先级） */
function windowsChromePaths(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  if (localAppData) {
    paths.push(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return paths;
}

/** macOS 常见 Chrome 位置（兼容） */
function macChromePaths(): string[] {
  return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
}

/**
 * 发现 chrome.exe 路径。优先级：
 * 1. 显式 chromePath / 环境变量 AIDCP_CHROME_PATH
 * 2. Windows 常见路径
 * 3. macOS 路径
 * 都找不到则抛出明确错误。
 */
export function discoverChromePath(
  explicit?: string,
  existsImpl: (p: string) => boolean = existsSync,
): string {
  const fromEnv = explicit ?? process.env.AIDCP_CHROME_PATH;
  if (fromEnv) {
    if (!existsImpl(fromEnv)) {
      throw new Error(`指定的 Chrome 路径不存在: ${fromEnv}`);
    }
    return fromEnv;
  }
  const candidates = [...windowsChromePaths(), ...macChromePaths()];
  for (const p of candidates) {
    if (existsImpl(p)) return p;
  }
  throw new Error(
    '未找到 Chrome 可执行文件。请安装 Chrome，或通过环境变量 AIDCP_CHROME_PATH 指定 chrome.exe 路径。\n' +
      `已尝试: ${candidates.join(', ')}`,
  );
}

/**
 * 探测指定 CDP 端口是否已有 Chrome 在监听。
 * 返回 true 表示 /json/version 可正常响应。
 */
export async function probeCdp(
  host: string,
  port: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  if (!fetchImpl) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
  try {
    const res = await fetchImpl(`http://${host}:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

/** clearStaleSingletonLock 的可注入副作用（测试用） */
export interface SingletonLockDeps {
  /** 读符号链接目标（默认 fs.readlinkSync）；锁不存在 / 非符号链接时抛错 */
  readlink?: (p: string) => string;
  /** 删除符号链接（默认 fs.unlinkSync） */
  unlink?: (p: string) => void;
  /** 判定 pid 是否存活（默认 process.kill(pid,0)：ESRCH=死、EPERM=活） */
  isProcessAlive?: (pid: number) => boolean;
  /** 本机 hostname（默认 os.hostname） */
  localHostname?: () => string;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 无此进程（已死）；EPERM = 进程存在但无权限发信号（仍活着）。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 清理用户数据目录里崩溃残留的 Chrome 单例锁（SingletonLock）。
 * 红线：MUST 仅在确认无存活进程持有时才清；被活进程持有 / 无法判定持有者时**诚实失败**，绝不盲删致并发损坏。
 *
 * Chrome 的 SingletonLock 是 user-data-dir 下的符号链接，目标形如 `<hostname>-<pid>`。
 * - 无锁（readlink 抛错）→ 正常启动。
 * - 目标解析不出 pid / 由其它主机持有 → 无法确认持有者存活 → 诚实失败，绝不删。
 * - pid 仍存活 → 另一实例正持有该 profile → 诚实失败（请改用独立用户数据目录或先停掉它）。
 * - pid 已不存活 → 陈旧锁，安全清理后正常启动。
 */
export function clearStaleSingletonLock(
  profileDir: string,
  log: (msg: string) => void = () => undefined,
  deps: SingletonLockDeps = {},
): void {
  const readlink = deps.readlink ?? readlinkSync;
  const unlink = deps.unlink ?? unlinkSync;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const localHost = (deps.localHostname ?? hostname)();
  const lockPath = join(profileDir, 'SingletonLock');

  let target: string;
  try {
    target = readlink(lockPath);
  } catch {
    // 无单例锁（或非符号链接）：正常启动。
    return;
  }

  // 目标形如 "<hostname>-<pid>"；pid 取最后一个 '-' 之后（hostname 自身可能含 '-'）。
  const dash = target.lastIndexOf('-');
  const lockHost = dash >= 0 ? target.slice(0, dash) : '';
  const pid = dash >= 0 ? Number(target.slice(dash + 1)) : NaN;

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `[aidcp-edge] 无法解析用户数据目录单例锁(${lockPath} -> ${target})；为避免误删运行中实例，拒绝启动。`,
    );
  }
  if (lockHost && lockHost !== localHost) {
    throw new Error(
      `[aidcp-edge] 用户数据目录被其它主机(${lockHost})的实例持有(${lockPath} -> ${target})，本机无法判定其存活，拒绝启动。`,
    );
  }
  if (isAlive(pid)) {
    throw new Error(
      `[aidcp-edge] 用户数据目录正被存活进程(pid=${pid})持有(${lockPath})，拒绝启动以防并发损坏；` +
        `请为本节点使用独立用户数据目录，或先停掉该实例。`,
    );
  }
  // pid 已不存活：陈旧锁，安全清理。
  unlink(lockPath);
  log(`[aidcp-edge] 清理陈旧单例锁(${lockPath} -> ${target}, pid=${pid} 已不存活)`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`请求失败: ${url} HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

interface CdpTargetInfo {
  id: string;
  type: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface RuntimeEvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string };
}

interface LoginProbeResult {
  loggedIn: boolean;
  reason: string;
  url: string;
}

export interface LoginProbeSignals {
  href: string;
  hasUserCookie: boolean;
  hasUserStorage: boolean;
  hasAvatar: boolean;
  hasCreatorEntry: boolean;
  hasLoginPrompt: boolean;
}

export function deriveLoginProbeResult(signals: LoginProbeSignals): LoginProbeResult {
  // 判定口径（修复历史误判：a1/webId 等匿名 cookie、feed 作者头像、恒存在的"我"
  // 在未登录时也命中，旧的 OR 逻辑因此误放行）：
  //  - 主信号：web_session（httpOnly，经 CDP 读取）——它是登录态的主要正向信号；
  //  - 兜底：nav 头像 && 创作入口（均为收紧后信号，未登录的 explore 不会同时满足），
  //          仅在 web_session 读取不到时挽救，避免死等；
  //  - 否决（高于一切正向信号）：URL 含 /login，或页面出现登录提示（扫码/手机号登录弹窗等）。
  //    注意：web_session 可能残留但已失效——此时页面会弹登录框，故 loginPrompt 必须能否决
  //    web_session（真机实测：web_session 仍在但弹着"扫码成功请在手机上确认"的登录框）。
  const positive = signals.hasUserCookie || (signals.hasAvatar && signals.hasCreatorEntry);
  const loggedIn = !/\/login/.test(signals.href) && !signals.hasLoginPrompt && positive;
  return {
    loggedIn,
    reason: loggedIn
      ? [
          signals.hasUserCookie ? 'web_session' : '',
          signals.hasUserStorage ? 'storage' : '',
          signals.hasAvatar ? 'avatar' : '',
          signals.hasCreatorEntry ? 'creator-entry' : '',
        ]
          .filter(Boolean)
          .join('+') || 'page-signal'
      : signals.hasLoginPrompt
        ? 'login-prompt'
        : /\/login/.test(signals.href)
          ? 'login-url'
          : 'signals-missing',
    url: signals.href,
  };
}

function shouldAllowManualEnterFallback(): boolean {
  return process.env.AIDCP_LOGIN_WAIT_MODE === 'manual' || process.stdin.isTTY === true;
}

function waitForManualEnter(): { promise: Promise<void>; cancel: () => void } {
  const stdin = process.stdin;
  let onData: (() => void) | undefined;
  const cancel = () => {
    if (onData) stdin.removeListener('data', onData);
    onData = undefined;
    try {
      stdin.pause();
    } catch {
      /* ignore */
    }
  };
  const promise = new Promise<void>((resolve) => {
    onData = () => {
      cancel();
      resolve();
    };
    try {
      stdin.resume();
    } catch {
      /* ignore */
    }
    stdin.once('data', onData);
  });
  return { promise, cancel };
}

/** 检测登录态所需的最小 WebSocket 能力（便于单测注入假实现） */
export interface CdpWsLike {
  addEventListener(type: string, handler: (ev?: { data?: unknown }) => void, opts?: { once?: boolean }): void;
  send(data: string): void;
  close(): void;
}

export async function evaluateLoginState(
  host: string,
  port: number,
  fetchImpl: typeof fetch,
  wsFactory: (url: string) => CdpWsLike = (url) => new WebSocket(url) as unknown as CdpWsLike,
): Promise<LoginProbeResult> {
  const targets = await fetchJson<CdpTargetInfo[]>(`http://${host}:${port}/json`, fetchImpl);
  const pageTarget =
    targets.find((target) => target.type === 'page' && target.url?.includes('xiaohongshu.com')) ??
    targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('未找到可用于检测登录态的 page target');
  }
  const ws = wsFactory(pageTarget.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('browser CDP WebSocket 连接失败')), { once: true });
      ws.addEventListener('message', (event) => {
        let payload: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          payload = JSON.parse(String(event?.data));
        } catch {
          return;
        }
        if (typeof payload.id !== 'number') return;
        const waiter = pending.get(payload.id);
        if (!waiter) return;
        pending.delete(payload.id);
        if (payload.error) {
          waiter.reject(new Error(payload.error.message ?? 'CDP 调用失败'));
          return;
        }
        waiter.resolve(payload.result);
      });
    });
    await send('Runtime.enable');
    const evalRes = await send<RuntimeEvaluateResult>('Runtime.evaluate', {
      expression: `(() => {
        const href = location.href;
        const hasUserStorage = Boolean(localStorage.getItem('redmoji') || localStorage.getItem('user'));
        // 头像信号收紧：仅认顶栏/侧边导航区内的用户头像，排除 feed 卡片作者头像
        // （未登录的 explore 瀑布流也满屏作者头像，会造成误判）。
        const navScope = document.querySelector('header, nav, .side-bar, [class*="side-bar"], [class*="sidebar"]');
        const avatar = navScope && navScope.querySelector('img[class*="avatar"], [class*="avatar"] img, .user-avatar img');
        // 创作入口收紧：去掉恒存在的"我"，仅认登录后才出现的创作中心/发布笔记/我的主页。
        const creatorEntry = Array.from(document.querySelectorAll('a,button,div')).some((node) => {
          const text = (node.textContent || '').trim();
          return text.includes('创作中心') || text.includes('发布笔记') || text.includes('我的主页');
        });
        const loginPrompt = Array.from(document.querySelectorAll('div,span,p,button')).some((node) => {
          const text = (node.textContent || '').replace(/\\s+/g, '');
          return /登录后|立即登录|扫码登录|手机号登录|验证码登录|新用户登录/.test(text);
        });
        return {
          href,
          hasUserStorage,
          hasAvatar: Boolean(avatar),
          hasCreatorEntry: creatorEntry,
          hasLoginPrompt: loginPrompt,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (evalRes.exceptionDetails?.text) {
      throw new Error(`Runtime.evaluate 失败: ${evalRes.exceptionDetails.text}`);
    }
    const domSignals = evalRes.result?.value as Omit<LoginProbeSignals, 'hasUserCookie'> | undefined;
    if (!domSignals) {
      return { loggedIn: false, reason: 'empty-result', url: '' };
    }
    // web_session 是登录态的权威信号，但它是 httpOnly cookie——document.cookie 读不到，
    // 必须经 CDP 的 Network.getCookies 读取（能返回 httpOnly cookie）。
    // 读取失败时退回 DOM 信号兜底（见 deriveLoginProbeResult），避免死等。
    let hasUserCookie = false;
    try {
      // 显式传 urls 限定到 xiaohongshu.com：不传时 getCookies 仅返回"当前文档 URL"作用域的
      // cookie，若附着的 page target 不是小红书页（fallback 选页）会漏读 web_session。
      const cookieRes = await send<{ cookies?: Array<{ name?: string; value?: string }> }>(
        'Network.getCookies',
        { urls: ['https://www.xiaohongshu.com', 'https://www.xiaohongshu.com/'] },
      );
      hasUserCookie = (cookieRes.cookies ?? []).some(
        (c) => c.name === 'web_session' && typeof c.value === 'string' && c.value.trim().length > 0,
      );
    } catch {
      // Network.getCookies 不可用（旧版/权限）：保持 false，由 DOM 兜底判定。
      hasUserCookie = false;
    }
    return deriveLoginProbeResult({ ...domSignals, hasUserCookie });
  } finally {
    for (const [, waiter] of pending) {
      waiter.reject(new Error('browser CDP WebSocket 已关闭'));
    }
    pending.clear();
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 确保复用的 Chrome 至少有一个可用的页面标签（type:"page" 且有 webSocketDebuggerUrl）。
 *
 * 复用场景下 Chrome 可能“活着但无标签”（窗口被关、进程仍在）：此时 `/json/version`
 * 仍可响应（probeCdp 通过、判定可复用），但 `/json` 无 page target，导致登录检测
 * （evaluateLoginState）与后续 attachToPage 都失败、卡到超时。此时主动新开一个标签兜底。
 */
export async function ensurePageTarget(
  host: string,
  port: number,
  startUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<void> {
  const targets = await fetchJson<CdpTargetInfo[]>(`http://${host}:${port}/json`, fetchImpl);
  if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) return;
  log(`[aidcp-edge] 复用的 Chrome 无可用页面标签，自动新开一个：${startUrl}`);
  // 新版 Chrome 的 /json/new 需要 PUT；旧版仅支持 GET，做一次回退。
  let res = await fetchImpl(`http://${host}:${port}/json/new?${startUrl}`, { method: 'PUT' });
  if (!res.ok) {
    res = await fetchImpl(`http://${host}:${port}/json/new?${startUrl}`);
  }
  if (!res.ok) {
    throw new Error(`无法在复用的 Chrome 中新开页面标签（/json/new HTTP ${res.status}）`);
  }
}

async function defaultWaitForLogin(ctx: LoginWaitContext): Promise<void> {
  const deadline = Date.now() + ctx.timeoutMs;
  const allowManualEnter = shouldAllowManualEnterFallback();
  const probeLogin = ctx.probeLoginImpl ?? evaluateLoginState;
  let manual: { promise: Promise<void>; cancel: () => void } | undefined;
  if (allowManualEnter) {
    ctx.logImpl('[aidcp-edge] 可在浏览器中登录小红书；若已确认完成，也可按 Enter 手动继续。');
    manual = waitForManualEnter();
    void manual.promise.then(() => {
      ctx.logImpl('[aidcp-edge] 收到 Enter，按手动兜底继续启动。');
    });
  } else {
    ctx.logImpl('[aidcp-edge] 请在浏览器中登录小红书，系统将自动检测登录态后继续。');
  }
  while (Date.now() < deadline) {
    const probePromise = probeLogin(ctx.host, ctx.port, ctx.fetchImpl)
      .then((result) => ({ type: 'probe' as const, result }))
      .catch((error) => ({ type: 'error' as const, error: error as Error }));
    const race = manual
      ? await Promise.race([probePromise, manual.promise.then(() => ({ type: 'manual' as const }))])
      : await probePromise;
    if (race.type === 'manual') return;
    if (race.type === 'probe' && race.result.loggedIn) {
      manual?.cancel(); // 登录已检测到：注销 stdin 监听，避免后续误吃用户回车
      ctx.logImpl(`[aidcp-edge] 已检测到登录，继续（signal=${race.result.reason} url=${race.result.url}）`);
      return;
    }
    if (race.type === 'probe') {
      ctx.logImpl(`[aidcp-edge] 等待小红书登录中（signal=${race.result.reason} url=${race.result.url || ctx.startUrl}）`);
    } else {
      ctx.logImpl(`[aidcp-edge] 登录态检测暂不可用：${race.error.message}`);
    }
    await ctx.sleepImpl(ctx.pollIntervalMs);
  }
  throw new Error(`等待小红书登录超时（${ctx.timeoutMs}ms），请确认已在浏览器完成登录。`);
}

/** 组装 Chrome 启动参数（CDP 调试 + 独立 profile + 去打扰）。 */
export function buildChromeArgs(opts: {
  port: number;
  profileDir: string;
  headless: boolean;
  windowPosition?: { left: number; top: number };
  startUrl: string;
}): string[] {
  const args = [
    `--remote-debugging-port=${opts.port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // —— 反检测启动参数（见 docs/anti-detection.md §1.1 / §4.1）——
    // 关闭 Blink 的 AutomationControlled 特征：使 navigator.webdriver 不再被置 true。
    '--disable-blink-features=AutomationControlled',
    // 去掉"正受到自动化控制"信息栏提示。
    '--disable-infobars',
    // 关掉权限弹窗（通知/定位/摄像头等一律拒绝而非弹窗），见 change browser-permission-prompt-defaults。
    '--deny-permission-prompts',
    // 注意：刻意不加 --enable-automation（它会让 UA 暴露调试态、弹出自动化提示）。
    // —— 固定桌面视口：优先进小红书【宽布局】（左侧栏），避免落入【窄布局】（底部图标栏）
    //    导致 self-id/通知/滚动等选择器与滚动机制错位（见 docs/xhs-layout-states.md）。
    //    --window-size 作兜底；有 Electron 启动暂存坐标时不再同时最大化，避免首帧先铺满主屏。
    //    裸启动没有坐标时仍用 --start-maximized 覆盖 profile 记忆的小窗口。
    //    注：代码仍按两布局健壮，不只依赖此处把窗口撑宽。
    '--window-size=1440,980',
    `--user-data-dir=${opts.profileDir}`,
  ];
  if (!opts.windowPosition) args.push('--start-maximized');
  if (opts.windowPosition) {
    args.push(`--window-position=${Math.floor(opts.windowPosition.left)},${Math.floor(opts.windowPosition.top)}`);
  }
  if (opts.headless) {
    args.push('--headless=new');
  }
  args.push(opts.startUrl);
  return args;
}

/**
 * 启动或复用 Chrome。
 * - 若 CDP 端口已就绪：直接复用（pid=null, reused=true）。
 * - 否则发现路径并 spawn 新进程，轮询直至 /json/version 就绪。
 * - 首次启动（profile 目录不存在）时提示人工登录并等待 Enter。
 */
export async function launchChrome(opts: ChromeLauncherOptions = {}): Promise<ChromeInstance> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const profileDir = opts.profileDir ?? process.env.AIDCP_CHROME_PROFILE ?? DEFAULT_PROFILE_DIR;
  const headless = opts.headless ?? process.env.AIDCP_CHROME_HEADLESS === 'true';
  const startUrl = opts.startUrl ?? DEFAULT_START_URL;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const loginPollIntervalMs = opts.loginPollIntervalMs ?? DEFAULT_LOGIN_POLL_INTERVAL_MS;
  const loginTimeoutMs = opts.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const spawnImpl = opts.spawnImpl ?? spawn;
  const existsImpl = opts.existsImpl ?? existsSync;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const waitForLogin = opts.waitForLoginImpl ?? defaultWaitForLogin;
  const probeLogin = opts.probeLoginImpl ?? evaluateLoginState;
  const ensurePage = opts.ensurePageTargetImpl ?? ensurePageTarget;
  const log = opts.logImpl ?? ((m: string) => console.log(m));
  const allowReuse =
    opts.allowReuse ?? ['1', 'true', 'yes'].includes((process.env.AIDCP_CDP_ALLOW_REUSE ?? '').toLowerCase());
  const clearLock = opts.clearSingletonLockImpl ?? ((dir: string, l: (m: string) => void) => clearStaleSingletonLock(dir, l));

  // 1) 端口上已有 Chrome：默认诚实拒绝静默接管（红线：绝不静默假成功）。
  //    多节点同机运行须各用独立调试端口 + 独立用户数据目录；探测到端口已被占用即停手，
  //    绝不 attach 陌生浏览器并伪装成功。仅在显式 AIDCP_CDP_ALLOW_REUSE 时才复用。
  if (await probeCdp(host, port, fetchImpl)) {
    if (!allowReuse) {
      throw new Error(
        `[aidcp-edge] 调试端口 ${host}:${port} 上已有 Chrome 在运行——拒绝静默接管陌生浏览器实例。` +
          `本节点须使用独立的调试端口与用户数据目录；如确属同一节点的有意复用，显式设置 AIDCP_CDP_ALLOW_REUSE=true。`,
      );
    }
    log(`[aidcp-edge] 检测到已有 Chrome 监听 ${host}:${port}（AIDCP_CDP_ALLOW_REUSE 已开启），复用实例`);
    // 复用的实例可能“活着但无标签”（窗口被关、进程仍在）：/json/version 仍响应、
    // 被判可复用，但无 page target，登录检测与 attachToPage 都会失败、卡到超时。
    // 复用前先确保有一个可用页面标签，没有就主动新开一个。
    await ensurePage(host, port, startUrl, fetchImpl, log);
    // 复用实例也需要验证登录态
    await waitForLogin({
      host,
      port,
      startUrl,
      timeoutMs: loginTimeoutMs,
      pollIntervalMs: loginPollIntervalMs,
      fetchImpl,
      sleepImpl: sleep,
      logImpl: log,
      probeLoginImpl: probeLogin,
    });
    // 复用实例不归本进程所有：kill 与回收均为 no-op（killAndConfirmDead 直接 true，绝不回收外部浏览器）。
    return { pid: null, reused: true, kill: () => undefined, killAndConfirmDead: async () => true };
  }

  // 2) 发现路径并启动
  const chromePath = discoverChromePath(opts.chromePath, existsImpl);
  // 启动前清理崩溃残留的单例锁：仅在确认无存活进程持有时清，否则诚实失败（绝不盲删致并发损坏）。
  clearLock(profileDir, log);
  const args = buildChromeArgs({ port, profileDir, headless, windowPosition: opts.windowPosition, startUrl });

  log(`[aidcp-edge] 启动 Chrome: ${chromePath}`);
  const stderrLogPath = chromeLogPath();
  appendFileSync(
    stderrLogPath,
    `\n=== ${new Date().toISOString()} spawn chrome pid=pending port=${port} profile=${profileDir} ===\n`,
  );
  const child: ChildProcess = spawnImpl(chromePath, args, {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk) => {
    const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
    appendFileSync(stderrLogPath, text);
  });
  child.on('error', (err) => {
    log(`[aidcp-edge] Chrome 进程错误: ${(err as Error).message}`);
    appendFileSync(
      stderrLogPath,
      `[${new Date().toISOString()}] child error: ${(err as Error).stack ?? (err as Error).message}\n`,
    );
  });
  child.on('exit', (code, signal) => {
    const message = `[aidcp-edge] Chrome 进程退出: code=${code ?? 'null'} signal=${signal ?? 'null'} stderrLog=${stderrLogPath}`;
    log(message);
    appendFileSync(stderrLogPath, `[${new Date().toISOString()}] exit code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
  });

  // 3) 等待 CDP 就绪
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (await probeCdp(host, port, fetchImpl)) {
      ready = true;
      break;
    }
    await sleep(250);
  }
  if (!ready) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw new Error(
      `等待 Chrome CDP 端口 ${host}:${port} 就绪超时（${readyTimeoutMs}ms）。` +
        '请检查 Chrome 是否成功启动，或端口是否被占用。',
    );
  }

  log(`[aidcp-edge] Chrome 已就绪（pid=${child.pid ?? '?'}），CDP ${host}:${port}，stderr=${stderrLogPath}`);

  // 4) 验证登录态（无论是否首次启动，都需要确认已登录）
  await waitForLogin({
    host,
    port,
    startUrl,
    timeoutMs: loginTimeoutMs,
    pollIntervalMs: loginPollIntervalMs,
    fetchImpl,
    sleepImpl: sleep,
    logImpl: log,
    probeLoginImpl: probeLogin,
  });

  let killed = false;
  const portFree = async (): Promise<boolean> => !(await probeCdp(host, port, fetchImpl));
  const killAndConfirmDead = async (o: {
    sigtermGraceMs?: number;
    sigkillGraceMs?: number;
    pollMs?: number;
  } = {}): Promise<boolean> => {
    const sigtermGraceMs = o.sigtermGraceMs ?? 2_000;
    const sigkillGraceMs = o.sigkillGraceMs ?? 2_000;
    const pollMs = o.pollMs ?? 150;
    // ① 优雅 SIGTERM，轮询端口直至释放
    killed = true;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    let t0 = Date.now();
    while (Date.now() - t0 < sigtermGraceMs) {
      if (await portFree()) return true;
      await sleep(pollMs);
    }
    // ② 优雅未释放端口 → 升级 SIGKILL，继续轮询确认
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    t0 = Date.now();
    while (Date.now() - t0 < sigkillGraceMs) {
      if (await portFree()) return true;
      await sleep(pollMs);
    }
    return portFree();
  };
  return {
    pid: child.pid ?? null,
    reused: false,
    killAndConfirmDead,
    kill: () => {
      if (killed) return;
      killed = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}
