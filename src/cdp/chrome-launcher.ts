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
  /** 注入“等待人工登录”逻辑（默认等待 stdin Enter） */
  waitForLoginImpl?: () => Promise<void>;
  /** 注入日志输出（默认 console.log） */
  logImpl?: (msg: string) => void;
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

/** 默认“等待人工登录”：等待 stdin 收到一行（Enter）。 */
function defaultWaitForLogin(): Promise<void> {
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

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const spawnImpl = opts.spawnImpl ?? spawn;
  const existsImpl = opts.existsImpl ?? existsSync;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const waitForLogin = opts.waitForLoginImpl ?? defaultWaitForLogin;
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
    log('[aidcp-edge] 请在浏览器中登录小红书，登录完成后按 Enter 继续...');
    await waitForLogin();
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
