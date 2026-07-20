import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');

test('customer login and roster refresh never bootstrap ordinary automation engines', () => {
  const start = main.indexOf('function enforceOwnedAutomationEngines()');
  const end = main.indexOf('/** fleet 快照', start);
  const block = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /bindingState === 'bound'/);
  assert.doesNotMatch(block, /coreBootstrapSupervisor\.enqueue|startBrowserAbsentCore|queueStartEnv|startEdge|resumeEdge|spawnEdgeChild/,
    'login-time ownership enforcement must never start an automation engine');

  const proceed = main.slice(main.indexOf('async function proceedAfterAuth()'), main.indexOf('function startSessionMaintenance'));
  assert.match(proceed, /syncEnvHandles\(\)[\s\S]*enforceOwnedAutomationEngines\(\)/);
  const maintenance = main.slice(main.indexOf('function startSessionMaintenance'), main.indexOf('function applyLegacyMirror'));
  assert.match(maintenance, /refreshAllowedEnvironments\(\)[\s\S]*syncEnvHandles\(\)[\s\S]*enforceOwnedAutomationEngines\(\)/);
});

test('untrusted binding stops only an existing automation engine and never opens a browser to recover identity', () => {
  const start = main.indexOf('function enforceOwnedAutomationEngines()');
  const end = main.indexOf('/** fleet 快照', start);
  const block = main.slice(start, end);
  assert.match(block, /handle\.child\.kill\('SIGTERM'\)/);
  assert.match(block, /数据管理仍可继续使用/);
  assert.doesNotMatch(block, /browser\.show|browser\.wake|queueStartEnv|openProfile|CDP/);
});

test('client login no longer prewarms AdsPower or an automation engine', () => {
  const proceed = main.slice(main.indexOf('async function proceedAfterAuth()'), main.indexOf('function startSessionMaintenance'));
  assert.doesNotMatch(proceed, /ensureAdsServiceOnce|ensureKernelOnce/, 'login must not depend on provider startup');
  assert.doesNotMatch(proceed, /startBrowserAbsentCore|queueStartEnv|spawnEdgeChild/, 'login must not start the automation engine');
});
