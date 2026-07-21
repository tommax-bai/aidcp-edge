import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { normalizeProxyRuntime } = require('../../src/electron/proxy-runtime.cjs') as {
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

  const runtimeWins = uiLogic.proxyRuntimeView(
    { state: 'same_as_host', browserIp: '198.51.100.4', directIp: '198.51.100.4' },
    config,
    { state: 'available' },
  );
  assert.equal(runtimeWins.label, '疑似直连');
});

test('装配契约：仅 Facebook AdsPower 启用 Network，注入 /egress，IP 事件落盘前脱敏', () => {
  assert.match(sessionSource, /if \(opts\.network\) await cdp\.send\('Network\.enable'\)/);
  assert.match(coreSource, /provider\.kind === 'adspower' && platformDriver\.platform === 'facebook'/);
  assert.match(mainSource, /AIDCP_EGRESS_PROBE_URL = `\$\{clientAuthBase\}\/egress`/);
  assert.match(mainSource, /proxyRuntime updated \(redacted\)/);
  assert.match(html, /本次会话接收流量/);
  assert.match(html, /不是代理商计费流量/);
});

test('预检装配契约：选择时预热，启动与唤醒复用，代理修改后失效且不新建重试器', () => {
  assert.match(mainSource, /ipcMain\.handle\('fleet:select'[\s\S]*scheduleSelectedProxyPreflight\(envs\.get\(envId\)\)/);
  assert.match(mainSource, /const preflight = await ensureProxyPreflight\(handle\);[\s\S]*preflight\.state === 'unavailable'[\s\S]*startEdge\(handle\)/);
  assert.match(mainSource, /launchQueue\.enqueue\(\{[\s\S]*run: async \(\) => \{[\s\S]*await ensureProxyPreflight\(handle\)[\s\S]*admitBrowserSlot\(handle\)/);
  assert.match(mainSource, /onColdStandbyWakeFailed\(handle, `代理预检未通过/);
  assert.match(mainSource, /proxyPreflight\.invalidate\(envId\)/);
  assert.doesNotMatch(mainSource, /proxyPreflightRetry|proxyRetryTimer/);
});
