import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// CommonJS production helper is intentionally dependency-injected so cold/failure
// behavior can be tested without booting Electron or a real Ads CLI daemon.
const require = createRequire(import.meta.url);
const { needsRuntimeRecovery, readWithRuntimeRecovery } = require('../../src/electron/ads-read-runtime.cjs') as {
  needsRuntimeRecovery: (result: unknown) => boolean;
  readWithRuntimeRecovery: (deps: {
    hasBase: () => boolean;
    clearBase: () => void;
    ensure: () => Promise<{ ok: boolean; error?: string }>;
    read: () => Promise<{ ok: boolean; error?: string; marker?: string }>;
  }) => Promise<{ ok: boolean; error?: string; marker?: string; retryable?: boolean }>;
};
const mainSource = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');

test('cold read ensures the Ads CLI once before reading', async () => {
  const calls: string[] = [];
  let hasBase = false;
  const result = await readWithRuntimeRecovery({
    hasBase: () => hasBase,
    clearBase: () => { calls.push('clear'); hasBase = false; },
    ensure: async () => { calls.push('ensure'); hasBase = true; return { ok: true }; },
    read: async () => { calls.push('read'); return { ok: true, marker: 'ready' }; },
  });

  assert.deepEqual(calls, ['ensure', 'read']);
  assert.equal(result.marker, 'ready');
});

test('healthy cached-base read does not spawn the CLI ensure path', async () => {
  let ensureCalls = 0;
  const result = await readWithRuntimeRecovery({
    hasBase: () => true,
    clearBase: () => assert.fail('healthy read must not clear the base'),
    ensure: async () => { ensureCalls += 1; return { ok: true }; },
    read: async () => ({ ok: true }),
  });

  assert.equal(result.ok, true);
  assert.equal(ensureCalls, 0);
});

test('cached-base fetch failure clears, re-ensures, and retries once', async () => {
  const calls: string[] = [];
  let reads = 0;
  const result = await readWithRuntimeRecovery({
    hasBase: () => true,
    clearBase: () => { calls.push('clear'); },
    ensure: async () => { calls.push('ensure'); return { ok: true }; },
    read: async () => {
      calls.push('read');
      reads += 1;
      return reads === 1 ? { ok: false, error: 'fetch failed' } : { ok: true, marker: 'recovered' };
    },
  });

  assert.deepEqual(calls, ['read', 'clear', 'ensure', 'read']);
  assert.equal(result.marker, 'recovered');
});

test('semantic API failure is returned without restarting the daemon', async () => {
  assert.equal(needsRuntimeRecovery({ ok: false, error: 'authentication failed' }), false);
  let ensureCalls = 0;
  const result = await readWithRuntimeRecovery({
    hasBase: () => true,
    clearBase: () => assert.fail('semantic failure must not clear the base'),
    ensure: async () => { ensureCalls += 1; return { ok: true }; },
    read: async () => ({ ok: false, error: 'authentication failed' }),
  });

  assert.equal(result.ok, false);
  assert.equal(ensureCalls, 0);
});

test('ensure failure returns an honest retryable error and does not read', async () => {
  let readCalls = 0;
  const result = await readWithRuntimeRecovery({
    hasBase: () => false,
    clearBase: () => {},
    ensure: async () => ({ ok: false, error: 'missing bundled CLI' }),
    read: async () => { readCalls += 1; return { ok: true }; },
  });

  assert.equal(readCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.error || '', /运行时未就绪.*missing bundled CLI/);
});

test('main process wires both read IPC handlers through cached-base recovery', () => {
  assert.match(
    mainSource,
    /ipcMain\.handle\('ads:status',[\s\S]{0,240}readAdsWithRuntime\(opts,[\s\S]{0,160}adsApi\.status/,
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\('ads:listProfiles',[\s\S]{0,300}readAdsWithRuntime\(opts,[\s\S]{0,180}adsApi\.listProfiles/,
  );
});

test('client-core startup does not warm AdsPower or reconcile browser profiles', () => {
  const proceedStart = mainSource.indexOf('async function proceedAfterAuth()');
  const proceedEnd = mainSource.indexOf('// 会话维护', proceedStart);
  const proceed = mainSource.slice(proceedStart, proceedEnd);
  assert.doesNotMatch(proceed, /ensureAdsServiceOnce\(null\)/, 'browserless client cores must not start the bundled CLI');
  assert.match(
    proceed,
    /if \(settings\.provider !== 'adspower'\) \{[\s\S]*reconcileRunningProfiles\(\)/,
    'AdsPower browser reconciliation must stay behind an explicit browser intent',
  );
});
