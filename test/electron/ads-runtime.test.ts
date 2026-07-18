import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 内嵌 AdsPower 运行时编排是 CJS（供 Electron main.cjs require），经 createRequire 引入以不破 ESM typecheck。
const require = createRequire(import.meta.url);

type RunResult = { ok: boolean; code?: number; out: string; err?: string; error?: string };
type RunFn = (
  cliEntry: string,
  args: string[],
  opts?: { onStdout?: (s: string) => void; [k: string]: unknown },
) => Promise<RunResult>;

const adsRuntime = require('../../src/electron/ads-runtime.cjs') as {
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
  }) => Promise<{ ok: boolean; base?: string; port?: number; alreadyRunning?: boolean; error?: string }>;
  kernelDownloaded: (o: { cliEntry: string; version: string; run?: RunFn }) => Promise<{ ok: boolean; present?: boolean; listed?: boolean; throttled?: boolean; error?: string }>;
  ensureKernel: (o: {
    cliEntry: string;
    version: string;
    onProgress?: (p: { percent: number; state: string }) => void;
    run?: RunFn;
  }) => Promise<{ ok: boolean; alreadyPresent?: boolean; downloaded?: boolean; error?: string }>;
};

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
