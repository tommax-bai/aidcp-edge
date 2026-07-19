import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 内嵌 AdsPower 运行时编排是 CJS（供 Electron main.cjs require），经 createRequire 引入以不破 ESM typecheck。
const require = createRequire(import.meta.url);
const runtimePatch = require('../../scripts/patch-ads-runtime.cjs') as {
  ORIGINAL_SPAWN_BLOCK: string;
  PATCHED_SPAWN_BLOCK: string;
  patchAdsRuntimeBrowserVisibility: (root: string) => { changed: boolean; hookPath: string };
};

type RunResult = { ok: boolean; code?: number; out: string; err?: string; error?: string };
type RunFn = (
  cliEntry: string,
  args: string[],
  opts?: { onStdout?: (s: string) => void; [k: string]: unknown },
) => Promise<RunResult>;

const adsRuntime = require('../../src/electron/ads-runtime.cjs') as {
  resolveRuntimeExecPath: (o: {
    isPackaged?: boolean;
    execPath?: string;
    env?: Record<string, string | undefined>;
    platform?: string;
    exists?: (path: string) => boolean;
  }) => string;
  resolveCliEntry: (o: { resourcesPath?: string; appRoot?: string; userDataPath?: string }) => string | null;
  stripAnsi: (s: unknown) => string;
  isThrottled: (r: { out?: string; err?: string }) => boolean;
  parseCliJson: (out: string) => unknown;
  parseRuntimePort: (out: string) => number | null;
  runtimeRunning: (out: string) => boolean;
  getRuntime: (o: { cliEntry: string; run?: RunFn }) => Promise<{ running: boolean; port: number | null; base: string | null }>;
  ensureRuntime: (o: {
    cliEntry: string | null;
    apiKey?: string;
    run?: RunFn;
    readyTries?: number;
    readyIntervalMs?: number;
    resetExisting?: boolean;
    stopTries?: number;
    stopIntervalMs?: number;
  }) => Promise<{ ok: boolean; base?: string; port?: number; alreadyRunning?: boolean; error?: string }>;
  stopRuntime: (o: {
    cliEntry: string | null;
    run?: RunFn;
    stopTries?: number;
    stopIntervalMs?: number;
  }) => Promise<{ ok: boolean; stopped?: boolean; alreadyStopped?: boolean; error?: string }>;
  kernelDownloaded: (o: { cliEntry: string; version: string; run?: RunFn }) => Promise<{ ok: boolean; present?: boolean; listed?: boolean; throttled?: boolean; error?: string }>;
  ensureKernel: (o: {
    cliEntry: string;
    version: string;
    onProgress?: (p: { percent: number; state: string }) => void;
    run?: RunFn;
  }) => Promise<{ ok: boolean; alreadyPresent?: boolean; downloaded?: boolean; error?: string }>;
};

test('resolveRuntimeExecPath keeps packaged clients self-contained', () => {
  const ownExecutable = 'C:\\Program Files\\AIDCP\\AIDCP.exe';
  const resolved = adsRuntime.resolveRuntimeExecPath({
    isPackaged: true,
    execPath: ownExecutable,
    env: { npm_node_execpath: 'C:\\Program Files\\nodejs\\node.exe' },
    platform: 'win32',
    exists: () => true,
  });
  assert.equal(resolved, ownExecutable);
});

test('resolveRuntimeExecPath uses npm Node in Windows development to avoid locking node_modules/electron', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const resolved = adsRuntime.resolveRuntimeExecPath({
    isPackaged: false,
    execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
    env: { npm_node_execpath: node },
    platform: 'win32',
    exists: (candidate) => candidate === node,
  });
  assert.equal(resolved, node);
});

test('resolveRuntimeExecPath finds Node on PATH and falls back honestly when absent', () => {
  const fromPath = adsRuntime.resolveRuntimeExecPath({
    isPackaged: false,
    execPath: '/repo/node_modules/electron/dist/electron',
    env: { PATH: '/opt/tools:/usr/local/bin' },
    platform: 'linux',
    exists: (candidate) => candidate === '/usr/local/bin/node',
  });
  assert.equal(fromPath, '/usr/local/bin/node');

  const fallback = adsRuntime.resolveRuntimeExecPath({
    isPackaged: false,
    execPath: '/repo/node_modules/electron/dist/electron',
    env: { PATH: '/missing' },
    platform: 'linux',
    exists: () => false,
  });
  assert.equal(fallback, '/repo/node_modules/electron/dist/electron');
});

test('resolveCliEntry prefers the patched staged runtime in development', () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'aidcp-ads-runtime-'));
  const stagedCli = join(appRoot, 'build', 'ads-runtime', 'adspower-browser', 'cli', 'index.js');
  const rawCli = join(appRoot, 'node_modules', 'adspower-browser', 'cli', 'index.js');
  try {
    mkdirSync(join(stagedCli, '..'), { recursive: true });
    mkdirSync(join(rawCli, '..'), { recursive: true });
    writeFileSync(stagedCli, '// staged');
    writeFileSync(rawCli, '// raw');
    assert.equal(adsRuntime.resolveCliEntry({ appRoot }), stagedCli);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test('staging patch keeps Ads CLI-launched SunBrowser visible and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'aidcp-ads-runtime-patch-'));
  const hookDir = join(root, 'cli', 'core');
  const hookPath = join(hookDir, 'winHideChildProcess.js');
  try {
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(hookPath, `"use strict";\n${runtimePatch.ORIGINAL_SPAWN_BLOCK}\n`);
    const first = runtimePatch.patchAdsRuntimeBrowserVisibility(root);
    assert.equal(first.changed, true);
    const patched = readFileSync(hookPath, 'utf8');
    assert.match(patched, /SunBrowser/);
    assert.match(patched, /windowsHide: false/);
    assert.ok(patched.includes(runtimePatch.PATCHED_SPAWN_BLOCK));

    const second = runtimePatch.patchAdsRuntimeBrowserVisibility(root);
    assert.equal(second.changed, false);
    assert.equal(readFileSync(hookPath, 'utf8'), patched, 'second patch must be byte-stable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staging patch fails closed when the pinned Ads CLI hook shape changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'aidcp-ads-runtime-patch-shape-'));
  const hookDir = join(root, 'cli', 'core');
  try {
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'winHideChildProcess.js'), '// incompatible vendor hook\n');
    assert.throws(
      () => runtimePatch.patchAdsRuntimeBrowserVisibility(root),
      /refusing to stage an unverified SunBrowser visibility policy/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const A = '\x1b[32m';
const Z = '\x1b[39m';

// 造一个 status 输出（含 ANSI），端口可变。
function statusOut(port: number | null): string {
  if (port == null) return `${A}[!] Adspower runtime is not running${Z}\n`;
  return `${A}[i] Adspower program is running at:${Z}\n${A} - http://local.adspower.net:${port}${Z}\n`;
}
// 造一个 get-kernel-list 输出（前缀行 + ANSI + JSON）。
function kernelListOut(list: Array<{ kernel: string; is_downloaded: boolean; kernel_type?: string }>): string {
  const body = JSON.stringify({ list: list.map((k) => ({ kernel_type: 'Chrome', ...k })) }, null, 2);
  return `${A}Executing command: get-kernel-list, params: {"kernel_type":"Chrome"}${Z}\n\n${body}\n`;
}
const THROTTLE_OUT = { ok: false as const, out: '', err: `\x1b[31mToo many request per second, please check${Z}\n` };

// 简易 run 桩：按 args[0] 路由到预设结果，记录调用。
function makeRun(routes: Record<string, RunResult | RunResult[]>, calls: string[][] = []): RunFn {
  const counters: Record<string, number> = {};
  return async (_cli, args, opts) => {
    calls.push(args);
    const key = args[0];
    const r = routes[key];
    if (!r) return { ok: false, out: '', err: `no route for ${key}` };
    const picked = Array.isArray(r) ? r[Math.min((counters[key] = (counters[key] || 0) + 1) - 1, r.length - 1)] : r;
    // 若是 download-kernel 且带进度脚本，回放到 onStdout
    if (key === 'download-kernel' && opts?.onStdout && (picked as RunResult & { progress?: string[] }).progress) {
      for (const line of (picked as RunResult & { progress?: string[] }).progress as string[]) opts.onStdout(line);
    }
    return picked;
  };
}

// ── 纯解析 ────────────────────────────────────────────────
test('stripAnsi removes color codes', () => {
  assert.equal(adsRuntime.stripAnsi(`${A}hi${Z}`), 'hi');
  assert.equal(adsRuntime.stripAnsi(null), '');
});

test('parseCliJson drops preamble + ANSI and parses JSON block', () => {
  const parsed = adsRuntime.parseCliJson(kernelListOut([{ kernel: '148', is_downloaded: true }])) as { list: unknown[] };
  assert.ok(Array.isArray(parsed.list));
  assert.equal((parsed.list[0] as { kernel: string }).kernel, '148');
});

test('parseCliJson returns null when no JSON body (throttle/only preamble)', () => {
  assert.equal(adsRuntime.parseCliJson(`${A}Executing command: get-kernel-list${Z}\n`), null);
});

test('parseRuntimePort + runtimeRunning read the status line', () => {
  assert.equal(adsRuntime.parseRuntimePort(statusOut(50325)), 50325);
  assert.equal(adsRuntime.parseRuntimePort(statusOut(50427)), 50427);
  assert.equal(adsRuntime.parseRuntimePort(statusOut(null)), null);
  assert.equal(adsRuntime.runtimeRunning(statusOut(50325)), true);
  assert.equal(adsRuntime.runtimeRunning(statusOut(null)), false);
});

test('isThrottled detects the rate-limit message on stderr', () => {
  assert.equal(adsRuntime.isThrottled(THROTTLE_OUT), true);
  assert.equal(adsRuntime.isThrottled({ out: '{"list":[]}', err: '' }), false);
});

// ── getRuntime ────────────────────────────────────────────
test('getRuntime parses running port', async () => {
  const run = makeRun({ status: { ok: true, out: statusOut(50325) } });
  const rt = await adsRuntime.getRuntime({ cliEntry: 'x', run });
  assert.deepEqual(rt, { running: true, port: 50325, base: 'http://local.adspower.net:50325' });
});

test('getRuntime reports not-running', async () => {
  const run = makeRun({ status: { ok: true, out: statusOut(null) } });
  const rt = await adsRuntime.getRuntime({ cliEntry: 'x', run });
  assert.equal(rt.running, false);
  assert.equal(rt.base, null);
});

// ── ensureRuntime ─────────────────────────────────────────
test('ensureRuntime: already running needs no key, no start', async () => {
  const calls: string[][] = [];
  const run = makeRun({ status: { ok: true, out: statusOut(50325) } }, calls);
  const r = await adsRuntime.ensureRuntime({ cliEntry: 'x', run });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyRunning, true);
  assert.equal(r.base, 'http://local.adspower.net:50325');
  assert.ok(!calls.some((a) => a[0] === 'start'), 'must not call start when already running');
});

test('ensureRuntime: not running + no key → honest failure', async () => {
  const run = makeRun({ status: { ok: true, out: statusOut(null) } });
  const r = await adsRuntime.ensureRuntime({ cliEntry: 'x', run });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /api-key/);
});

test('ensureRuntime: not running + key → start then becomes ready', async () => {
  const calls: string[][] = [];
  // 第一次 status 未就绪，start 后第二次 status 就绪
  const run = makeRun(
    { status: [{ ok: true, out: statusOut(null) }, { ok: true, out: statusOut(50325) }], start: { ok: true, out: 'Server running at: http://local.adspower.net:50325' } },
    calls,
  );
  const r = await adsRuntime.ensureRuntime({ cliEntry: 'x', apiKey: 'KEY', run, readyTries: 3, readyIntervalMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.port, 50325);
  assert.ok(calls.some((a) => a[0] === 'start' && a.includes('KEY')), 'start called with key');
});

test('ensureRuntime: no cliEntry → honest failure', async () => {
  const r = await adsRuntime.ensureRuntime({ cliEntry: null });
  assert.equal(r.ok, false);
});

test('ensureRuntime: reset skips stop for an already-stopped daemon and starts fresh', async () => {
  const calls: string[][] = [];
  const run = makeRun(
    {
      status: [
        { ok: true, out: statusOut(null) },
        { ok: true, out: statusOut(null) },
        { ok: true, out: statusOut(50326) },
      ],
      start: { ok: true, out: 'Server running at: http://local.adspower.net:50326' },
    },
    calls,
  );

  const result = await adsRuntime.ensureRuntime({
    cliEntry: 'x',
    apiKey: 'KEY',
    run,
    resetExisting: true,
    readyTries: 2,
    readyIntervalMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.base, 'http://local.adspower.net:50326');
  assert.deepEqual(calls.map((args) => args[0]), ['status', 'status', 'start', 'status']);
});

test('ensureRuntime: reset stops a registered daemon before starting fresh', async () => {
  const calls: string[][] = [];
  let phase = 'old';
  const run: RunFn = async (_entry, args) => {
    calls.push(args);
    if (args[0] === 'stop') {
      phase = 'stopped';
      return { ok: true, code: 0, out: '' };
    }
    if (args[0] === 'start') {
      phase = 'fresh';
      return { ok: true, code: 0, out: 'Server running at: http://local.adspower.net:50326' };
    }
    if (phase === 'old') return { ok: true, code: 0, out: statusOut(50325) };
    if (phase === 'stopped') return { ok: true, code: 0, out: statusOut(null) };
    return { ok: true, code: 0, out: statusOut(50326) };
  };

  const result = await adsRuntime.ensureRuntime({
    cliEntry: 'x',
    apiKey: 'KEY',
    run,
    resetExisting: true,
    readyTries: 2,
    readyIntervalMs: 1,
    stopIntervalMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.base, 'http://local.adspower.net:50326');
  assert.deepEqual(calls.map((args) => args[0]), ['status', 'stop', 'status', 'status', 'start', 'status']);
});

test('ensureRuntime: reset stop failure blocks start and preserves the cause', async () => {
  const calls: string[][] = [];
  const run: RunFn = async (_entry, args) => {
    calls.push(args);
    return args[0] === 'status'
      ? { ok: true, code: 0, out: statusOut(50325) }
      : { ok: false, code: 1, out: '', err: 'permission denied' };
  };

  const result = await adsRuntime.ensureRuntime({ cliEntry: 'x', apiKey: 'KEY', run, resetExisting: true });

  assert.equal(result.ok, false);
  assert.match(result.error || '', /已有 Ads CLI daemon 无法停止：permission denied/);
  assert.ok(!calls.some((args) => args[0] === 'start'));
});

test('ensureRuntime: reset timeout blocks start honestly', async () => {
  const calls: string[][] = [];
  const run: RunFn = async (_entry, args) => {
    calls.push(args);
    return args[0] === 'stop'
      ? { ok: true, code: 0, out: '' }
      : { ok: true, code: 0, out: statusOut(50325) };
  };

  const result = await adsRuntime.ensureRuntime({
    cliEntry: 'x',
    apiKey: 'KEY',
    run,
    resetExisting: true,
    stopTries: 2,
    stopIntervalMs: 1,
  });

  assert.equal(result.ok, false);
  assert.match(result.error || '', /已有 Ads CLI daemon 无法停止：Ads CLI daemon 停止超时/);
  assert.ok(!calls.some((args) => args[0] === 'start'));
});

test('stopRuntime: running daemon receives stop and is confirmed down', async () => {
  const calls: string[][] = [];
  let running = true;
  const run: RunFn = async (_entry, args) => {
    calls.push(args);
    if (args[0] === 'stop') {
      running = false;
      return { ok: true, code: 0, out: '' };
    }
    return { ok: true, code: 0, out: running ? 'Server running at http://local.adspower.net:50325' : 'Server is not running' };
  };
  const result = await adsRuntime.stopRuntime({ cliEntry: 'x', run, stopIntervalMs: 1 });
  assert.deepEqual(result, { ok: true, stopped: true });
  assert.deepEqual(calls.map((args) => args[0]), ['status', 'stop', 'status']);
});

test('stopRuntime: stopped daemon is a no-op and stop failures stay honest', async () => {
  const stoppedRun: RunFn = async () => ({ ok: true, code: 0, out: 'Server is not running' });
  assert.deepEqual(await adsRuntime.stopRuntime({ cliEntry: 'x', run: stoppedRun }), { ok: true, alreadyStopped: true });

  const failingRun: RunFn = async (_entry, args) => (
    args[0] === 'status'
      ? { ok: true, code: 0, out: 'Server running at http://local.adspower.net:50325' }
      : { ok: false, code: 1, out: '', err: 'permission denied' }
  );
  const failed = await adsRuntime.stopRuntime({ cliEntry: 'x', run: failingRun });
  assert.equal(failed.ok, false);
  assert.match(failed.error || '', /permission denied/);

  const unknownStatus: RunFn = async () => ({ ok: false, code: 1, out: '', err: 'status transport failed' });
  const unknown = await adsRuntime.stopRuntime({ cliEntry: 'x', run: unknownStatus });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error || '', /status transport failed/);
});

// ── kernelDownloaded ──────────────────────────────────────
test('kernelDownloaded: present', async () => {
  const run = makeRun({ 'get-kernel-list': { ok: true, out: kernelListOut([{ kernel: '148', is_downloaded: true }]) } });
  const r = await adsRuntime.kernelDownloaded({ cliEntry: 'x', version: '148', run });
  assert.deepEqual({ ok: r.ok, present: r.present, listed: r.listed }, { ok: true, present: true, listed: true });
});

test('kernelDownloaded: listed but not downloaded', async () => {
  const run = makeRun({ 'get-kernel-list': { ok: true, out: kernelListOut([{ kernel: '148', is_downloaded: false }]) } });
  const r = await adsRuntime.kernelDownloaded({ cliEntry: 'x', version: '148', run });
  assert.deepEqual({ present: r.present, listed: r.listed }, { present: false, listed: true });
});

test('kernelDownloaded: not listed', async () => {
  const run = makeRun({ 'get-kernel-list': { ok: true, out: kernelListOut([{ kernel: '147', is_downloaded: false }]) } });
  const r = await adsRuntime.kernelDownloaded({ cliEntry: 'x', version: '999', run });
  assert.deepEqual({ present: r.present, listed: r.listed }, { present: false, listed: false });
});

test('kernelDownloaded: throttle then success (retry)', async () => {
  const run = makeRun({ 'get-kernel-list': [THROTTLE_OUT, { ok: true, out: kernelListOut([{ kernel: '148', is_downloaded: true }]) }] });
  const r = await adsRuntime.kernelDownloaded({ cliEntry: 'x', version: '148', run });
  assert.equal(r.ok, true);
  assert.equal(r.present, true);
});

// ── ensureKernel ──────────────────────────────────────────
test('ensureKernel: already present → no download', async () => {
  const calls: string[][] = [];
  const run = makeRun({ 'get-kernel-list': { ok: true, out: kernelListOut([{ kernel: '148', is_downloaded: true }]) } }, calls);
  const r = await adsRuntime.ensureKernel({ cliEntry: 'x', version: '148', run });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyPresent, true);
  assert.ok(!calls.some((a) => a[0] === 'download-kernel'), 'must NOT download when already present');
});

test('ensureKernel: missing → download with progress → completed', async () => {
  const progress: Array<{ percent: number; state: string }> = [];
  const run = makeRun({
    'get-kernel-list': { ok: true, out: kernelListOut([{ kernel: '148', is_downloaded: false }]) },
    'download-kernel': Object.assign(
      { ok: true, out: `${A}Kernel progress: 100% [completed]${Z}\n\n{\n  "status": "completed"\n}\n` },
      { progress: [`${A}Kernel progress: 0% [downloading]${Z}\n`, `Kernel progress: 56% [downloading]\n`, `Kernel progress: 100% [installing]\n`] },
    ) as RunResult,
  });
  const r = await adsRuntime.ensureKernel({ cliEntry: 'x', version: '148', run, onProgress: (p) => progress.push(p) });
  assert.equal(r.ok, true);
  assert.equal(r.downloaded, true);
  assert.deepEqual(progress.map((p) => p.percent), [0, 56, 100]);
  assert.equal(progress[progress.length - 1].state, 'installing');
});

test('ensureKernel: not listed → honest error, no download', async () => {
  const calls: string[][] = [];
  const run = makeRun({ 'get-kernel-list': { ok: true, out: kernelListOut([{ kernel: '147', is_downloaded: false }]) } }, calls);
  const r = await adsRuntime.ensureKernel({ cliEntry: 'x', version: '148', run });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /不在可下载列表/);
  assert.ok(!calls.some((a) => a[0] === 'download-kernel'));
});

test('ensureKernel: download fails (not completed) → honest failure', async () => {
  const run = makeRun({
    'get-kernel-list': { ok: true, out: kernelListOut([{ kernel: '148', is_downloaded: false }]) },
    'download-kernel': { ok: false, out: `${A}Kernel progress: 38% [downloading]${Z}\n`, error: 'network error' },
  });
  const r = await adsRuntime.ensureKernel({ cliEntry: 'x', version: '148', run });
  assert.equal(r.ok, false);
});
