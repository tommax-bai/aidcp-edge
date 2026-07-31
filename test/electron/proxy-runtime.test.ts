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
    label: string;
    tone: string;
    compact: string;
    configuration: string;
    checkedAt: string;
    [key: string]: unknown;
  };
};
const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');
const coreSource = readFileSync(join(here, '../../src/main.ts'), 'utf8');
const observerSource = readFileSync(join(here, '../../src/cdp/proxy-runtime-observer.ts'), 'utf8');
const sessionSource = readFileSync(join(here, '../../src/cdp/session.ts'), 'utf8');
const html = readFileSync(join(here, '../../src/electron/renderer/index.html'), 'utf8');

function sourceBlock(startToken: string, endToken: string) {
  const start = mainSource.indexOf(startToken);
  const end = mainSource.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `${startToken} block must exist`);
  return mainSource.slice(start, end);
}

test('fleet 投影只接受流量代际字段，不接收出口 IP 或其它敏感字段', () => {
  assert.deepEqual(normalizeProxyRuntime({
    state: 'active',
    generation: 3,
    sessionReceivedBytes: 2048.9,
    browserIp: '203.0.113.7',
    directIp: '198.51.100.4',
    checkedAt: '2026-07-20T08:00:00.000Z',
    proxyPassword: 'must-not-pass',
    url: 'https://facebook.com/private',
  }), {
    state: 'active',
    generation: 3,
    sessionReceivedBytes: 2048,
  });
  assert.equal(normalizeProxyRuntime({ state: 'verified', generation: 1, sessionReceivedBytes: 1 }), null);
});

test('失效投影只保留代际并清零流量', () => {
  const previous = {
    state: 'active',
    generation: 3,
    sessionReceivedBytes: 31.4 * 1024 * 1024,
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

test('视图只用 Inactive 启动前可达性给代理状态，运行时仅贡献接收流量', () => {
  const config = { known: true, noProxy: false, summary: 'http · proxy.example' };
  const pending = uiLogic.proxyRuntimeView(
    { state: 'active', sessionReceivedBytes: 12 * 1024 },
    config,
  );
  assert.equal(pending.label, '待检测');
  assert.equal(pending.compact, '待检测 · 本次 12.0 KB');
  assert.equal(pending.configuration, 'http · proxy.example');
  assert.equal(Object.hasOwn(pending, 'browserIp'), false);
  assert.equal(Object.hasOwn(pending, 'directIp'), false);

  const available = uiLogic.proxyRuntimeView(
    { state: 'active', sessionReceivedBytes: 512 },
    config,
    { state: 'available', checkedAt: '2026-07-21T01:02:03.000Z' },
  );
  assert.equal(available.label, '代理可用');
  assert.equal(available.checkedAt, '2026-07-21T01:02:03.000Z');

  const failed = uiLogic.proxyRuntimeView(null, config, { state: 'unavailable' });
  assert.equal(failed.label, '代理不可用');
  assert.equal(failed.tone, 'danger');

  const noProxy = uiLogic.proxyRuntimeView(null, { known: true, noProxy: true, summary: '无代理配置' });
  assert.equal(noProxy.label, '未配置代理');
  assert.equal(uiLogic.formatReceivedBytes(1024 * 1024), '1.00 MB');
});

test('运行时只启用 Network 流量统计，不再装配公网出口探测', () => {
  assert.match(sessionSource, /if \(opts\.network\) await cdp\.send\('Network\.enable'\)/);
  assert.match(coreSource, /new ProxyRuntimeObserver\(\{[\s\S]*cdp: session\.cdp/);
  assert.doesNotMatch(observerSource, /Network\.loadNetworkResource|fetchImpl|probeUrl|browserIp|directIp/);
  assert.doesNotMatch(coreSource, /AIDCP_EGRESS_PROBE_URL|requireActiveProxyEgressMatch|expectedEgressIp/);
  assert.doesNotMatch(mainSource, /AIDCP_EGRESS_PROBE_URL|probeProxyEgress|expectedEgressIp/);
  assert.doesNotMatch(html, /浏览器实际出口|本机直连出口/);
  assert.match(html, /最后可达性检测/);
  assert.match(html, /本次会话接收流量/);
  assert.match(html, /不是代理商计费流量/);
});

test('选择预热与启动都先识别 Active，只有非 Active 才执行网络准备', () => {
  const selected = sourceBlock(
    'function scheduleSelectedProxyPreflight(',
    'function proxyPreflightFailureText(',
  );
  assert.match(selected, /await adsBrowserStartupState\(current\)/);
  assert.match(selected, /if \(browserState === 'active'\) \{[\s\S]*?proxyPreflight\.invalidate\(envId\);[\s\S]*?return;/);
  assert.ok(
    selected.indexOf("browserState === 'active'") < selected.indexOf('ensureNetworkPreparation(current)'),
    'selected Active browser must return before preflight',
  );

  const spawn = sourceBlock('async function spawnEdgeChild(', 'function stopLoginPoller');
  assert.match(spawn, /activeBrowserTakeover = await adsBrowserStartupState\(handle\) === 'active'/);
  assert.match(spawn, /if \(activeBrowserTakeover\) \{[\s\S]*?proxyPreflight\.invalidate\(handle\.envId\);[\s\S]*?\} else \{[\s\S]*?ensureNetworkPreparation\(handle\)/);
  assert.match(spawn, /spawnEnv\.AIDCP_ADS_ACTIVE_ONLY = '1'/);
});
