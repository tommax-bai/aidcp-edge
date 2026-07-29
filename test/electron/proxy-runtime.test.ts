import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { invalidateProxyRuntime, normalizeProxyRuntime } = require('../../src/electron/proxy-runtime.cjs') as {
  invalidateProxyRuntime: (value: unknown) => Record<string, unknown> | null;
  normalizeProxyRuntime: (value: unknown) => Record<string, unknown> | null;
};
const uiLogic = require('../../src/electron/renderer/ui-logic.js') as {
  formatReceivedBytes(value: unknown): string;
  proxyRuntimeView(runtime: unknown, configuration: unknown, preflight?: unknown): {
    label: string; tone: string; compact: string; configuration: string; browserIp: string; directIp: string; checkedAt: string;
  };
};
const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');
const coreSource = readFileSync(join(here, '../../src/main.ts'), 'utf8');
const sessionSource = readFileSync(join(here, '../../src/cdp/session.ts'), 'utf8');
const html = readFileSync(join(here, '../../src/electron/renderer/index.html'), 'utf8');

function sourceBlock(startToken: string, endToken: string) {
  const start = mainSource.indexOf(startToken);
  const end = mainSource.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `${startToken} block must exist`);
  return mainSource.slice(start, end);
}

test('单环境人工启动只刷新已完成预检，自动与批量路径保留 TTL 和单飞', () => {
  const helper = sourceBlock(
    'function invalidateCompletedProxyPreflightForManualStart(',
    'function scheduleSelectedProxyPreflight(',
  );
  const checkingAt = helper.indexOf("proxyPreflight.snapshot(handle.envId)?.state === 'checking'");
  const invalidateAt = helper.indexOf('proxyPreflight.invalidate(handle.envId)');
  assert.match(helper, /eligibleForProxyPreflight\(handle\)/);
  assert.match(helper, /handle\.coldStandbyWaking/);
  assert.match(helper, /handle\.startFlowQueued/);
  assert.ok(checkingAt >= 0 && invalidateAt > checkingAt,
    'an in-flight real probe must remain singleflight instead of being superseded');

  const startHandler = sourceBlock(
    "ipcMain.handle('edge:start'",
    "ipcMain.handle('edge:restart'",
  );
  const wakeRefreshAt = startHandler.indexOf('invalidateCompletedProxyPreflightForManualStart(handle)');
  const wakeAt = startHandler.indexOf("wakeColdStandby(handle, 'user_start')");
  const ordinaryRefreshAt = startHandler.indexOf(
    'invalidateCompletedProxyPreflightForManualStart(handle)',
    wakeRefreshAt + 1,
  );
  const queueAt = startHandler.indexOf('queueStartEnv(handle)');
  assert.ok(wakeRefreshAt >= 0 && wakeAt > wakeRefreshAt,
    'manual standby wake must refresh completed evidence before waking');
  assert.ok(ordinaryRefreshAt > wakeAt && queueAt > ordinaryRefreshAt,
    'manual ordinary start must refresh completed evidence before queueing');

  const automaticWake = sourceBlock('function wakeColdStandby(', 'function onColdStandbyWoken(');
  const ordinaryQueue = sourceBlock('function queueStartEnv(', 'function stopAndRestart(');
  const batchStart = sourceBlock('function startAllEnvs(', 'function stopAllEnvs(');
  assert.doesNotMatch(automaticWake, /invalidateCompletedProxyPreflightForManualStart/);
  assert.doesNotMatch(ordinaryQueue, /invalidateCompletedProxyPreflightForManualStart/);
  assert.doesNotMatch(batchStart, /invalidateCompletedProxyPreflightForManualStart/);
});

test('fleet 投影严格 allowlist，非法 IP/额外敏感字段不会进入 renderer', () => {
  const normalized = normalizeProxyRuntime({
    state: 'verified',
    generation: 3,
    sessionReceivedBytes: 2048.9,
    browserIp: '203.0.113.7',
    directIp: 'bad\r\nheader',
    checkedAt: '2026-07-20T08:00:00.000Z',
    proxyPassword: 'must-not-pass',
    url: 'https://facebook.com/private',
  });
  assert.deepEqual(normalized, {
    state: 'verified',
    generation: 3,
    sessionReceivedBytes: 2048,
    browserIp: '203.0.113.7',
    checkedAt: '2026-07-20T08:00:00.000Z',
  });
});

test('失效投影与迟到 stale 事件只保留代际标记，不恢复旧出口或流量', () => {
  const previous = {
    state: 'verified',
    generation: 3,
    sessionReceivedBytes: 31.4 * 1024 * 1024,
    browserIp: '203.0.113.7',
    directIp: '198.51.100.4',
    checkedAt: '2026-07-20T08:00:00.000Z',
  };
  assert.deepEqual(invalidateProxyRuntime(previous), {
    state: 'stale',
    generation: 3,
    sessionReceivedBytes: 0,
  });
  assert.deepEqual(normalizeProxyRuntime({ ...previous, state: 'stale' }), {
    state: 'stale',
    generation: 3,
    sessionReceivedBytes: 0,
  });
  assert.equal(invalidateProxyRuntime(null), null);
});

test('视图只有运行证据能给“代理已验证”，配置存在但证据未知仍是无法确认', () => {
  const verified = uiLogic.proxyRuntimeView(
    { state: 'verified', sessionReceivedBytes: 12 * 1024, browserIp: '203.0.113.7', directIp: '198.51.100.4' },
    { known: true, noProxy: false, summary: 'socks5 · proxy.example' },
  );
  assert.equal(verified.label, '代理已验证');
  assert.equal(verified.compact, '代理已验证 · 本次 12.0 KB');
  assert.equal(verified.configuration, 'socks5 · proxy.example');

  const unknown = uiLogic.proxyRuntimeView(
    { state: 'unavailable', sessionReceivedBytes: 0 },
    { known: true, noProxy: false, summary: 'http · proxy.example' },
  );
  assert.equal(unknown.label, '无法确认');
  assert.notEqual(unknown.tone, 'verified');

  const noProxy = uiLogic.proxyRuntimeView(
    { state: 'verified', sessionReceivedBytes: 512 },
    { known: true, noProxy: true, summary: '无代理配置' },
  );
  assert.equal(noProxy.label, '未配置代理');
  assert.equal(uiLogic.formatReceivedBytes(1024 * 1024), '1.00 MB');
});

test('浏览器证据缺失时展示预检状态，当前运行证据始终优先', () => {
  const config = { known: true, noProxy: false, summary: 'http · proxy.example' };
  const expired = invalidateProxyRuntime({
    state: 'verified',
    generation: 4,
    sessionReceivedBytes: 31.4 * 1024 * 1024,
    browserIp: '203.0.113.7',
    directIp: '198.51.100.4',
    checkedAt: '2026-07-21T01:00:00.000Z',
  });
  const stopped = uiLogic.proxyRuntimeView(expired, config);
  assert.equal(stopped.label, '验证已失效');
  assert.notEqual(stopped.tone, 'verified');
  assert.equal(stopped.compact, '验证已失效 · 本次 0 B');
  assert.equal(stopped.browserIp, '未取得');
  assert.equal(stopped.directIp, '未取得');
  assert.equal(stopped.checkedAt, '');

  const available = uiLogic.proxyRuntimeView(
    { state: 'stale', generation: 1, sessionReceivedBytes: 0 },
    config,
    { state: 'available', checkedAt: '2026-07-21T01:02:03.000Z' },
  );
  assert.equal(available.label, '代理可用');
  assert.equal(available.browserIp, '未取得');
  assert.equal(available.checkedAt, '2026-07-21T01:02:03.000Z');

  const failed = uiLogic.proxyRuntimeView(null, config, { state: 'unavailable' });
  assert.equal(failed.label, '代理不可用');
  assert.equal(failed.tone, 'danger');

  const expiredThenFailed = uiLogic.proxyRuntimeView(expired, config, { state: 'unavailable' });
  assert.equal(expiredThenFailed.label, '代理不可用');
  assert.equal(expiredThenFailed.tone, 'danger');

  const verifiedWins = uiLogic.proxyRuntimeView(
    { state: 'verified', browserIp: '203.0.113.7', directIp: '198.51.100.4' },
    config,
    { state: 'unavailable' },
  );
  assert.equal(verifiedWins.label, '代理已验证');

  const runtimeWins = uiLogic.proxyRuntimeView(
    { state: 'same_as_host', browserIp: '198.51.100.4', directIp: '198.51.100.4' },
    config,
    { state: 'available' },
  );
  assert.equal(runtimeWins.label, '疑似直连');
});

test('生命周期装配契约：只在新启动前或代际确认结束后使运行证据失效', () => {
  const startFlowStart = mainSource.indexOf('async function startAdsPowerFlow');
  const startFlowEnd = mainSource.indexOf('// 按环境分派启动流程', startFlowStart);
  const startFlow = mainSource.slice(startFlowStart, startFlowEnd);
  const runtimeInvalidation = 'proxyRuntime: invalidateProxyRuntime(handle.status.proxyRuntime)';
  const startInvalidationIndex = startFlow.indexOf(runtimeInvalidation);
  const preparationIndex = startFlow.indexOf('await ensureAdsRuntimeAndKernel(handle)');
  assert.ok(startInvalidationIndex >= 0, 'replacement start must invalidate previous runtime evidence');
  assert.match(startFlow, /\.\.\.\(!handle\.child \? \{ proxyRuntime: invalidateProxyRuntime\(handle\.status\.proxyRuntime\) \} : \{\}\)/,
    'replacement-start invalidation must require no current child');
  assert.ok(preparationIndex > startInvalidationIndex,
    'old runtime evidence must expire before asynchronous preparation can fail');

  const browserAbsentStart = mainSource.indexOf('async function startBrowserAbsentCore');
  const browserAbsentEnd = mainSource.indexOf('async function startRestrictedOffboardCleanupCore', browserAbsentStart);
  assert.ok(browserAbsentStart >= 0 && browserAbsentEnd > browserAbsentStart, 'missing browser-absent bootstrap');
  const browserAbsent = mainSource.slice(browserAbsentStart, browserAbsentEnd);
  const browserAbsentInvalidationIndex = browserAbsent.indexOf(runtimeInvalidation);
  assert.ok(browserAbsentInvalidationIndex >= 0, 'browser-absent bootstrap must invalidate previous runtime evidence');
  assert.ok(browserAbsent.indexOf('await resolveControlBootstrap(handle)') > browserAbsentInvalidationIndex,
    'queue-full and manual-open bootstrap failures must not retain previous runtime evidence');

  const standbyStart = mainSource.indexOf('function onColdStandbyAck');
  const standbyEnd = mainSource.indexOf('function updateColdStandbyCloudRecovery', standbyStart);
  const standbyAck = mainSource.slice(standbyStart, standbyEnd);
  assert.match(standbyAck, /proxyRuntime: invalidateProxyRuntime\(handle\.status\.proxyRuntime\)/);

  const spawnChildStart = mainSource.indexOf('async function spawnEdgeChild');
  assert.ok(spawnChildStart >= 0, 'missing spawnEdgeChild');
  const childErrorStart = mainSource.indexOf("child.on('error'", spawnChildStart);
  const childCloseStart = mainSource.indexOf("child.on('close'", childErrorStart);
  assert.ok(childErrorStart > spawnChildStart && childCloseStart > childErrorStart,
    'missing spawnEdgeChild error/close lifecycle handlers');
  const childError = mainSource.slice(childErrorStart, childCloseStart);
  const childErrorInvalidationIndex = childError.indexOf(
    'handle.status.proxyRuntime = invalidateProxyRuntime(handle.status.proxyRuntime)',
  );
  assert.ok(childErrorInvalidationIndex > childError.indexOf('handle.child = undefined'));
  assert.ok(childErrorInvalidationIndex < childError.indexOf("settleTransientBrowserLease(handle, 'core_spawn_error'"),
    'spawn error must invalidate before a transient-lease settlement broadcasts fleet state');
  assert.ok(childErrorInvalidationIndex < childError.indexOf('if (handle.removed) return'));

  const childCloseEnd = mainSource.indexOf('function stopLoginPoller', childCloseStart);
  const childClose = mainSource.slice(childCloseStart, childCloseEnd);
  const childCloseInvalidationIndex = childClose.indexOf(
    'handle.status.proxyRuntime = invalidateProxyRuntime(handle.status.proxyRuntime)',
  );
  assert.ok(childCloseInvalidationIndex > childClose.indexOf('handle.child = undefined'));
  assert.ok(childCloseInvalidationIndex < childClose.indexOf("settleTransientBrowserLease(handle, 'core_closed'"),
    'child close must invalidate before a transient-lease settlement broadcasts fleet state');
  assert.ok(childCloseInvalidationIndex < childClose.indexOf('if (handle.removed) return'));

  const standbyRequestStart = mainSource.indexOf('function enterColdStandby');
  const standbyRequestEnd = mainSource.indexOf('function onColdStandbyAck', standbyRequestStart);
  assert.doesNotMatch(mainSource.slice(standbyRequestStart, standbyRequestEnd), /invalidateProxyRuntime/,
    'an unconfirmed standby request must not make current runtime evidence expire');

  const coreStandbyStart = coreSource.indexOf('enterStandby: async () =>');
  const coreStandbyEnd = coreSource.indexOf('wakeFromStandby: async', coreStandbyStart);
  const coreStandby = coreSource.slice(coreStandbyStart, coreStandbyEnd);
  assert.match(
    coreStandby,
    /const freed = await chrome\.killAndConfirmDead\(\);[\s\S]*if \(!freed\) \{[\s\S]*return false;[\s\S]*proxyRuntime\?\.suspendGeneration\('browser_standby'\);[\s\S]*return true;/,
    'core evidence must stay current when browser closure is not confirmed',
  );

  assert.equal(
    [...mainSource.matchAll(/invalidateProxyRuntime\(handle\.status\.proxyRuntime\)/g)].length,
    5,
    'Electron invalidation stays limited to no-child starts, confirmed standby, and child termination boundaries',
  );
});

test('装配契约：Facebook 或配置代理接管证据启用 Network，注入 /egress，IP 事件落盘前脱敏', () => {
  assert.match(sessionSource, /if \(opts\.network\) await cdp\.send\('Network\.enable'\)/);
  assert.match(coreSource, /provider\.kind === 'adspower' && platformDriver\.platform === 'facebook'/);
  assert.match(coreSource, /observesFacebookProxy \|\| observesConfiguredProxy/);
  assert.match(mainSource, /return clientAuthBase \? `\$\{clientAuthBase\}\/egress` : ''/);
  assert.match(mainSource, /spawnEnv\.AIDCP_EGRESS_PROBE_URL = egressProbeUrl/);
  assert.match(mainSource, /proxyRuntime updated \(redacted\)/);
  assert.match(html, /本次会话接收流量/);
  assert.match(html, /不是代理商计费流量/);
});

test('预检装配契约：选择时预热，启动与唤醒复用，代理修改后失效且不新建重试器', () => {
  assert.match(mainSource, /ipcMain\.handle\('fleet:select'[\s\S]*scheduleSelectedProxyPreflight\(envs\.get\(envId\)\)/);
  assert.match(mainSource, /const preflight = await ensureNetworkPreparation\(handle\);[\s\S]*preflight\.state === 'unavailable'[\s\S]*startEdge\(handle\)/);
  assert.match(mainSource, /launchQueue\.enqueue\(\{[\s\S]*run: async \(\) => \{[\s\S]*await ensureNetworkPreparation\(handle\)[\s\S]*admitBrowserSlot\(handle\)/);
  assert.match(mainSource, /onColdStandbyWakeFailed\(handle, `代理预检未通过/);
  assert.match(mainSource, /proxyPreflight\.invalidate\(envId\)/);
  assert.doesNotMatch(mainSource, /proxyPreflightRetry|proxyRetryTimer/);
});
