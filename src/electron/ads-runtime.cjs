// 内嵌 AdsPower CLI 运行时（adspower-browser）编排：拉起/看护运行时、内核预检+下载。
//
// 设计要点（change edge-bundled-adspower-cli-runtime）：
//  - 运行时随安装包分发；用 Electron 自带 Node（ELECTRON_RUN_AS_NODE + process.execPath）跑其 `cli/index.js`，
//    不依赖目标机的 npm / 独立 Node / 全局安装、不依赖单独安装的 AdsPower 桌面客户端。
//  - 唯一 native 模块 sqlite 为 N-API，可在 Electron 自带 Node 下加载（打包侧需置 asar 外并随 hardened runtime 签名）。
//  - 内核**不打进安装包**：首次需要时按需下载、落用户可写目录（~/.adspowerCli）；此模块只负责编排。
//  - 红线：一切失败诚实回报（{ ok:false, error }），MUST NOT 静默假成功。
//
// 编排函数（ensureRuntime / kernelDownloaded / ensureKernel）接受可注入的 `run`（默认 runCli），便于脱进程单测。

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const DEFAULT_KERNEL_TYPE = 'Chrome';
const ADS_HOST = 'local.adspower.net';
const DEFAULT_PORT = 50325;

function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Packaged clients must be self-contained and therefore run the CLI with their own
// Electron executable. In development, leaving the daemon attached to
// node_modules/electron locks that dependency tree after the UI exits; a later
// `npm ci` can then stop halfway with EBUSY and leave node_modules incomplete.
// Prefer a real Node executable only in development (the CLI's sqlite binding is
// N-API); fall back to the current Electron executable when no trusted Node path
// is available.
function resolveRuntimeExecPath({
  isPackaged = false,
  execPath = process.execPath,
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  if (isPackaged) return execPath;
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const candidates = [env.AIDCP_ADS_RUNTIME_NODE, env.npm_node_execpath];
  const pathValue = env.PATH || env.Path || '';
  for (const dir of String(pathValue).split(pathDelimiter)) {
    if (dir) candidates.push(pathImpl.join(dir, nodeName));
  }
  for (const candidate of candidates) {
    if (!candidate || pathImpl.basename(String(candidate)).toLowerCase() !== nodeName) continue;
    try {
      if (exists(String(candidate))) return String(candidate);
    } catch {
      /* best-effort candidate probing */
    }
  }
  return execPath;
}

// 解析随包 CLI 入口：优先 extraResources（打包态 process.resourcesPath），回落 node_modules（开发态）。
// 找不到返回 null——调用方据此优雅跳过内嵌运行时（迁移期：外部已装 AdsPower 客户端时行为不变）。
function resolveCliEntry({ resourcesPath, appRoot, userDataPath } = {}) {
  const candidates = [];
  if (userDataPath) {
    // 首选：首启暂存到用户可写目录的副本（打包态 App Translocation 下 Resources 只读，
    // CLI 要往自身 cwd/ 写，故运行时用这份可写副本）。
    candidates.push(path.join(userDataPath, 'ads-runtime', 'adspower-browser', 'cli', 'index.js'));
  }
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'adspower-browser', 'cli', 'index.js'));
    candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'adspower-browser', 'cli', 'index.js'));
  }
  if (appRoot) {
    // Development builds prefer the patched staging output over the raw package.
    candidates.push(path.join(appRoot, 'build', 'ads-runtime', 'adspower-browser', 'cli', 'index.js'));
    candidates.push(path.join(appRoot, 'node_modules', 'adspower-browser', 'cli', 'index.js'));
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* best-effort：路径探测失败当未命中 */
    }
  }
  // 开发态兜底：从模块解析（require.resolve 不执行 CLI、只拿路径）。
  try {
    return require.resolve('adspower-browser');
  } catch {
    return null;
  }
}

// spawn `<node> <cliEntry> <args...>`，用 Electron 自带 Node（ELECTRON_RUN_AS_NODE）。
// 返回 { ok, code, out, err, error }。onStdout 逐块回调用于实时进度解析。
function runCli(cliEntry, args, { execPath, env, onStdout, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(execPath || process.execPath, [cliEntry, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: e && e.message ? e.message : String(e), out: '', err: '' });
      return;
    }
    let out = '';
    let err = '';
    let timer;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (onStdout) {
        try {
          onStdout(s);
        } catch {
          /* 进度回调异常不影响下载本身 */
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    if (timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* best-effort */
        }
        done({ ok: false, error: `timeout after ${timeoutMs}ms`, out, err });
      }, timeoutMs);
    }
    child.on('error', (e) => done({ ok: false, error: e && e.message ? e.message : String(e), out, err }));
    child.on('exit', (code) => done({ ok: code === 0, code, out, err }));
  });
}

// AdsPower 本地 API 限频（约 1req/s）：连续快调会回 stderr「Too many request per second」。
// 读操作（status / get-kernel-list）据此退避重试，避免把「被限流」误判为「无法解析 / 未就绪」。
function isThrottled(r) {
  const text = stripAnsi((r && r.out) || '') + '\n' + stripAnsi((r && r.err) || '');
  return /too many request/i.test(text);
}

async function runResilient(run, cliEntry, args, opts, { retries = 3, throttleDelayMs = 1300 } = {}) {
  let r;
  for (let i = 0; i <= retries; i += 1) {
    r = await run(cliEntry, args, opts);
    if (!isThrottled(r)) return r;
    if (i < retries) await delay(throttleDelayMs);
  }
  return r;
}

// 从 CLI stdout 抽 JSON 载荷：去 ANSI、丢弃「Executing command:」前缀行，其余 trim 后 JSON.parse。
// 解析失败返回 null（调用方诚实报错，不臆造）。
// 从 start 处（'{' 或 '['）做括号平衡抽取（尊重字符串/转义），返回该 JSON 片段或 null。
function balancedJsonSlice(s, start) {
  const openCh = s[start];
  if (openCh !== '{' && openCh !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{' || c === '[') {
      depth += 1;
    } else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function parseCliJson(out) {
  const clean = stripAnsi(out)
    .split('\n')
    .filter((l) => !/^\s*Executing command:/.test(l))
    .join('\n');
  // 先整体尝试（干净输出的常见情形）。
  const trimmed = clean.trim();
  if (trimmed) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* 落到容错抽取 */
    }
  }
  // 容错：扫描每个 { 或 [ 起点做括号平衡抽取，返回首个能 parse 成对象/数组的 JSON——
  // 容忍 CLI 的 [i]/[warn] 日志行与前后混入的非 JSON 文本（不同机器 / 首启态输出各异）。
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (c !== '{' && c !== '[') continue;
    const block = balancedJsonSlice(clean, i);
    if (!block) continue;
    try {
      const v = JSON.parse(block);
      if (v && typeof v === 'object') return v;
    } catch {
      /* 继续找下一个候选 */
    }
  }
  return null;
}

// 从 `ads status` 人类输出解析实际监听端口（默认 50325，被占时运行时会回退，故不硬编码）。
function parseRuntimePort(statusOut) {
  const m = stripAnsi(statusOut).match(new RegExp(`${ADS_HOST.replace('.', '\\.')}:(\\d+)`));
  return m ? Number(m[1]) : null;
}

function runtimeRunning(statusOut) {
  return /running at/i.test(stripAnsi(statusOut));
}

function baseForPort(port) {
  return port ? `http://${ADS_HOST}:${port}` : null;
}

// 查运行时状态：{ running, port, base }。
async function getRuntime({ cliEntry, execPath, run = runCli } = {}) {
  const r = await runResilient(run, cliEntry, ['status'], { execPath, timeoutMs: 15000 });
  const running = runtimeRunning(r.out);
  const port = parseRuntimePort(r.out);
  return { running: running && !!port, port, base: baseForPort(port) };
}

// 确保运行时在跑：已跑则返回其 base；未跑则用 apiKey `start`、轮询就绪。
// 新 Electron 会话可传 resetExisting=true：只经 CLI 自身 status/stop 有界清理登记 daemon，
// 再用本会话当前 key 启动；不扫描/终止独立 AdsPower 桌面或任意进程。
// 就绪判定优先用注入的 `isReady`（HTTP LocalAPI /status，权威且可靠）：实测在 Electron 自带 Node 20 下
// `ads start` 经 child_process.fork 起服务后，其 pid/store 写入握手可能未完成 → `ads status` 误报「未在跑」，
// 但服务本身在监听、HTTP LocalAPI 正常。故不依赖 `ads status`（仅作端口解析与兜底），以 HTTP 探活为准。
// 端口优先从 `ads start` 输出（"Server running at :<port>"）解析，回落 `ads status`，再回落默认 50325。
// isReady: 可选 async () => boolean，命中即视为就绪。返回 { ok, base, port } 或 { ok:false, error }。
async function ensureRuntime({
  cliEntry,
  execPath,
  apiKey,
  run = runCli,
  isReady,
  readyTries = 40,
  readyIntervalMs = 500,
  resetExisting = false,
  stopTries,
  stopIntervalMs,
} = {}) {
  if (!cliEntry) return { ok: false, error: '未找到随包 AdsPower 运行时（cli entry）' };
  if (resetExisting) {
    if (!apiKey || !String(apiKey).trim()) {
      return { ok: false, error: '缺少 AdsPower api-key，无法重置并启动本会话指纹浏览器运行时' };
    }
    const stopped = await stopRuntime({ cliEntry, execPath, run, isReady, stopTries, stopIntervalMs });
    if (!stopped.ok) {
      return { ok: false, error: `已有 Ads CLI daemon 无法停止：${stopped.error || '未知错误'}` };
    }
  }
  // 已在跑？优先 HTTP 探活（可靠），否则回落 CLI status。
  if (isReady) {
    if (await isReady().catch(() => false)) {
      const rt0 = await getRuntime({ cliEntry, execPath, run }).catch(() => ({}));
      const port0 = rt0.port || DEFAULT_PORT;
      return { ok: true, base: baseForPort(port0), port: port0, alreadyRunning: true };
    }
  } else {
    const rt = await getRuntime({ cliEntry, execPath, run });
    if (rt.running && rt.port) return { ok: true, base: rt.base, port: rt.port, alreadyRunning: true };
  }
  if (!apiKey || !String(apiKey).trim()) {
    return { ok: false, error: '运行时未在跑且缺少 AdsPower api-key，无法启动内嵌运行时' };
  }
  const started = await run(cliEntry, ['start', '-k', String(apiKey)], { execPath, timeoutMs: 120000 });
  const startedPort = parseRuntimePort(started.out) || DEFAULT_PORT;
  // start 会 daemon 化并返回；轮询就绪。
  for (let i = 0; i < readyTries; i += 1) {
    if (isReady) {
      if (await isReady().catch(() => false)) {
        return { ok: true, base: baseForPort(startedPort), port: startedPort };
      }
    } else {
      const rt = await getRuntime({ cliEntry, execPath, run });
      if (rt.running && rt.port) return { ok: true, base: rt.base, port: rt.port };
    }
    await delay(readyIntervalMs);
  }
  return { ok: false, error: started.error || started.err || '内嵌运行时启动后未在预期时间内就绪', out: started.out };
}

// 有界停止 Ads CLI daemon。真正退出与运行时模板刷新共用这一条编排：
// stop 命令成功不等于 daemon 已退出，故继续以 Local API/CLI status 有界确认。
async function stopRuntime({ cliEntry, execPath, run = runCli, isReady, stopTries = 30, stopIntervalMs = 100 } = {}) {
  if (!cliEntry) return { ok: false, error: '未找到随包 AdsPower 运行时（cli entry）' };
  const probe = async () => {
    const result = await runResilient(run, cliEntry, ['status'], { execPath, timeoutMs: 15000 });
    const text = `${stripAnsi(result.out || '')}\n${stripAnsi(result.err || '')}`;
    if (runtimeRunning(text)) return { ok: true, running: true };
    if (result.ok || /not running/i.test(text)) return { ok: true, running: false };
    return { ok: false, error: result.error || result.err || 'Ads CLI daemon 状态确认失败' };
  };
  const initial = await probe();
  if (!initial.ok) return initial;
  if (!initial.running) return { ok: true, alreadyStopped: true };

  const stopped = await run(cliEntry, ['stop'], { execPath, timeoutMs: 30000 });
  if (!stopped.ok) {
    return { ok: false, error: stopped.error || stopped.err || 'Ads CLI daemon 停止命令失败' };
  }
  for (let i = 0; i < stopTries; i += 1) {
    const current = isReady && !(await isReady().catch(() => false))
      ? { ok: true, running: false }
      : await probe();
    if (current.ok && !current.running) return { ok: true, stopped: true };
    if (!current.ok && i + 1 === stopTries) return current;
    if (i + 1 < stopTries) await delay(stopIntervalMs);
  }
  return { ok: false, error: 'Ads CLI daemon 停止超时' };
}

function extractKernelList(out) {
  const data = parseCliJson(out);
  if (!data) return null;
  if (Array.isArray(data.list)) return data.list;
  if (data.data && Array.isArray(data.data.list)) return data.data.list;
  if (Array.isArray(data.data)) return data.data;
  return null;
}

// 查某内核是否已下载：{ ok, present, listed }。
// get-kernel-list 走 LocalAPI 查云端内核清单；刚起服务/云端握手未稳/网络慢时可能一时取不到，
// 故有界重试（不止限流那一种）；仍失败带 raw 回报，供上层落日志诊断。
async function kernelDownloaded({ cliEntry, execPath, version, kernelType = DEFAULT_KERNEL_TYPE, run = runCli, tries = 6, retryDelayMs = 1500 } = {}) {
  let r;
  let list = null;
  for (let i = 0; i < tries; i += 1) {
    r = await runResilient(run, cliEntry, ['get-kernel-list', JSON.stringify({ kernel_type: kernelType })], {
      execPath,
      timeoutMs: 30000,
    });
    list = extractKernelList(r.out);
    if (Array.isArray(list) && list.length) break;
    if (i < tries - 1) await delay(retryDelayMs);
  }
  if (!Array.isArray(list) || !list.length) {
    const throttled = isThrottled(r);
    return {
      ok: false,
      error: throttled ? 'AdsPower 本地 API 限流，未取到内核列表' : '无法解析内核列表（get-kernel-list）',
      raw: (r && r.out) || '',
      rawErr: (r && r.err) || '',
      throttled,
    };
  }
  const hit = list.find((k) => String(k.kernel) === String(version) && String(k.kernel_type || DEFAULT_KERNEL_TYPE) === String(kernelType));
  return { ok: true, present: !!(hit && hit.is_downloaded), listed: !!hit };
}

// 确保内核就绪：已下载则秒过；缺则 download-kernel 并把 { percent, state } 经 onProgress 上报；下完（completed）才 ok。
// 返回 { ok, alreadyPresent } / { ok, downloaded } / { ok:false, error }。
async function ensureKernel({ cliEntry, execPath, version, kernelType = DEFAULT_KERNEL_TYPE, onProgress, run = runCli } = {}) {
  const chk = await kernelDownloaded({ cliEntry, execPath, version, kernelType, run });
  if (!chk.ok) return chk;
  if (chk.present) return { ok: true, alreadyPresent: true };
  if (!chk.listed) return { ok: false, error: `内核 ${kernelType} ${version} 不在可下载列表中` };

  let lastPercent = 0;
  let lastState = 'pending';
  const r = await runResilient(run, cliEntry, ['download-kernel', JSON.stringify({ kernel_type: kernelType, kernel_version: String(version) })], {
    execPath,
    timeoutMs: 30 * 60 * 1000,
    onStdout: (s) => {
      const clean = stripAnsi(s);
      const re = /Kernel progress:\s*(\d+)%\s*\[(\w+)\]/g;
      let m;
      while ((m = re.exec(clean))) {
        lastPercent = Number(m[1]);
        lastState = m[2];
        if (onProgress) onProgress({ percent: lastPercent, state: lastState });
      }
    },
  });
  const data = parseCliJson(r.out);
  const completed = (data && data.status === 'completed') || /"status"\s*:\s*"completed"/.test(stripAnsi(r.out));
  if (r.ok && completed) return { ok: true, downloaded: true };
  return { ok: false, error: r.error || r.err || `内核下载未完成（state=${lastState}, ${lastPercent}%）`, raw: r.out };
}

module.exports = {
  stripAnsi,
  isThrottled,
  resolveRuntimeExecPath,
  resolveCliEntry,
  runCli,
  parseCliJson,
  parseRuntimePort,
  runtimeRunning,
  getRuntime,
  ensureRuntime,
  stopRuntime,
  kernelDownloaded,
  ensureKernel,
  DEFAULT_KERNEL_TYPE,
};
