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
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
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
  /** 启动后打开的 URL（默认小红书 explore 页） */
  startUrl?: string;
  /** 探测/启动就绪超时（毫秒），默认 10000 */
  readyTimeoutMs?: number;

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
  /** 注入日志输出（默认 console.log） */
  logImpl?: (msg: string) => void;
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
  const loggedIn =
    !/\/login/.test(signals.href) &&
    !signals.hasLoginPrompt &&
    (signals.hasUserCookie || signals.hasUserStorage || signals.hasAvatar || signals.hasCreatorEntry);
  return {
    loggedIn,
    reason: loggedIn
      ? [
          signals.hasUserCookie ? 'cookie' : '',
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

function waitForManualEnter(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = () => {
      stdin.removeListener('data', onData);
      try {
        stdin.pause();
      } catch {
        /* ignore */
      }
      resolve();
    };
    try {
      stdin.resume();
    } catch {
      /* ignore */
    }
    stdin.once('data', onData);
  });
}

async function evaluateLoginState(host: string, port: number, fetchImpl: typeof fetch): Promise<LoginProbeResult> {
  const targets = await fetchJson<CdpTargetInfo[]>(`http://${host}:${port}/json`, fetchImpl);
  const pageTarget =
    targets.find((target) => target.type === 'page' && target.url?.includes('xiaohongshu.com')) ??
    targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('未找到可用于检测登录态的 page target');
  }
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
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
          payload = JSON.parse(String(event.data));
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
        const hasUserCookie = document.cookie.split(';').some((item) => /^\\s*(web_session|a1|webId)=/.test(item));
        const hasUserStorage = Boolean(localStorage.getItem('redmoji') || localStorage.getItem('user'));
        const avatar = document.querySelector('img[class*="avatar"], .user-avatar img, [class*="avatar"] img');
        const creatorEntry = Array.from(document.querySelectorAll('a,button,div')).some((node) => {
          const text = (node.textContent || '').trim();
          return text.includes('创作中心') || text.includes('发布笔记') || text.includes('我');
        });
        const loginPrompt = Array.from(document.querySelectorAll('div,span,p')).some((node) => {
          const text = (node.textContent || '').trim();
          return text.includes('登录后') || text.includes('立即登录') || text.includes('扫码登录');
        });
        return {
          href,
          hasUserCookie,
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
    const signals = evalRes.result?.value as LoginProbeSignals | undefined;
    if (!signals) {
      return { loggedIn: false, reason: 'empty-result', url: '' };
    }
    return deriveLoginProbeResult(signals);
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

async function defaultWaitForLogin(ctx: LoginWaitContext): Promise<void> {
  const deadline = Date.now() + ctx.timeoutMs;
  const allowManualEnter = shouldAllowManualEnterFallback();
  const probeLogin = ctx.probeLoginImpl ?? evaluateLoginState;
  let manualEnterPromise: Promise<void> | undefined;
  if (allowManualEnter) {
    ctx.logImpl('[aidcp-edge] 可在浏览器中登录小红书；若已确认完成，也可按 Enter 手动继续。');
    manualEnterPromise = waitForManualEnter().then(() => {
      ctx.logImpl('[aidcp-edge] 收到 Enter，按手动兜底继续启动。');
    });
  } else {
    ctx.logImpl('[aidcp-edge] 请在浏览器中登录小红书，系统将自动检测登录态后继续。');
  }
  while (Date.now() < deadline) {
    const probePromise = probeLogin(ctx.host, ctx.port, ctx.fetchImpl)
      .then((result) => ({ type: 'probe' as const, result }))
      .catch((error) => ({ type: 'error' as const, error: error as Error }));
    const race = manualEnterPromise
      ? await Promise.race([probePromise, manualEnterPromise.then(() => ({ type: 'manual' as const }))])
      : await probePromise;
    if (race.type === 'manual') return;
    if (race.type === 'probe' && race.result.loggedIn) {
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
    // 注意：刻意不加 --enable-automation（它会让 UA 暴露调试态、弹出自动化提示）。
    `--user-data-dir=${opts.profileDir}`,
  ];
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
  const log = opts.logImpl ?? ((m: string) => console.log(m));

  // 1) 复用已有实例
  if (await probeCdp(host, port, fetchImpl)) {
    log(`[aidcp-edge] 检测到已有 Chrome 监听 ${host}:${port}，复用实例`);
    return { pid: null, reused: true, kill: () => undefined };
  }

  // 2) 发现路径并启动
  const isFirstLaunch = !existsImpl(profileDir);
  const chromePath = discoverChromePath(opts.chromePath, existsImpl);
  const args = buildChromeArgs({ port, profileDir, headless, startUrl });

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

  // 4) 首次登录处理
  if (isFirstLaunch) {
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
  }

  let killed = false;
  return {
    pid: child.pid ?? null,
    reused: false,
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
