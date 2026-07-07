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

function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 解析随包 CLI 入口：优先 extraResources（打包态 process.resourcesPath），回落 node_modules（开发态）。
// 找不到返回 null——调用方据此优雅跳过内嵌运行时（迁移期：外部已装 AdsPower 客户端时行为不变）。
function resolveCliEntry({ resourcesPath, appRoot } = {}) {
  const candidates = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'adspower-browser', 'cli', 'index.js'));
    candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'adspower-browser', 'cli', 'index.js'));
  }
  if (appRoot) {
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
function parseCliJson(out) {
  const clean = stripAnsi(out);
  const body = clean
    .split('\n')
    .filter((l) => !/^Executing command:/.test(l.trim()))
    .join('\n')
    .trim();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
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
// 返回 { ok, base, port } 或 { ok:false, error }。
async function ensureRuntime({ cliEntry, execPath, apiKey, run = runCli, readyTries = 20, readyIntervalMs = 500 } = {}) {
  if (!cliEntry) return { ok: false, error: '未找到随包 AdsPower 运行时（cli entry）' };
  let rt = await getRuntime({ cliEntry, execPath, run });
  if (rt.running && rt.port) return { ok: true, base: rt.base, port: rt.port, alreadyRunning: true };
  if (!apiKey || !String(apiKey).trim()) {
    return { ok: false, error: '运行时未在跑且缺少 AdsPower api-key，无法启动内嵌运行时' };
  }
  const started = await run(cliEntry, ['start', '-k', String(apiKey)], { execPath, timeoutMs: 120000 });
  // start 会 daemon 化并返回；轮询 status 确认就绪。
  for (let i = 0; i < readyTries; i += 1) {
    rt = await getRuntime({ cliEntry, execPath, run });
    if (rt.running && rt.port) return { ok: true, base: rt.base, port: rt.port };
    await delay(readyIntervalMs);
  }
  return { ok: false, error: started.error || started.err || '内嵌运行时启动后未在预期时间内就绪', out: started.out };
}

// 查某内核是否已下载：{ ok, present, listed }。
async function kernelDownloaded({ cliEntry, execPath, version, kernelType = DEFAULT_KERNEL_TYPE, run = runCli } = {}) {
  const r = await runResilient(run, cliEntry, ['get-kernel-list', JSON.stringify({ kernel_type: kernelType })], {
    execPath,
    timeoutMs: 20000,
  });
  const data = parseCliJson(r.out);
  const list = data && (Array.isArray(data.list) ? data.list : data.data && Array.isArray(data.data.list) ? data.data.list : Array.isArray(data.data) ? data.data : null);
  if (!Array.isArray(list)) {
    const throttled = isThrottled(r);
    return { ok: false, error: throttled ? 'AdsPower 本地 API 限流，未取到内核列表' : '无法解析内核列表（get-kernel-list）', raw: r.out, throttled };
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
  resolveCliEntry,
  runCli,
  parseCliJson,
  parseRuntimePort,
  runtimeRunning,
  getRuntime,
  ensureRuntime,
  kernelDownloaded,
  ensureKernel,
  DEFAULT_KERNEL_TYPE,
};
