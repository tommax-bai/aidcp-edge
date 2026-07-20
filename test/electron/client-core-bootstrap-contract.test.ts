import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');

test('customer login and roster refresh bootstrap trustworthy browserless cores', () => {
  const start = main.indexOf('function bootstrapOwnedClientCores()');
  const end = main.indexOf('/** fleet 快照', start);
  const block = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /bindingState === 'bound'/);
  assert.match(block, /coreBootstrapSupervisor\.enqueue/);
  assert.match(block, /startBrowserAbsentCore\(handle\)/);
  assert.doesNotMatch(block, /queueStartEnv|startEdge|resumeEdge|ensureAdsServiceOnce|ensureKernelOnce|admitBrowserSlot|launchQueue/,
    'normal core bootstrap must not enter browser/provider/CDP/slot paths');

  const proceed = main.slice(main.indexOf('async function proceedAfterAuth()'), main.indexOf('function startSessionMaintenance'));
  assert.match(proceed, /syncEnvHandles\(\)[\s\S]*bootstrapOwnedClientCores\(\)/);
  const maintenance = main.slice(main.indexOf('function startSessionMaintenance'), main.indexOf('function applyLegacyMirror'));
  assert.match(maintenance, /refreshAllowedEnvironments\(\)[\s\S]*syncEnvHandles\(\)[\s\S]*bootstrapOwnedClientCores\(\)/);
});

test('untrusted binding restricts only the core and never opens a browser to recover identity', () => {
  const start = main.indexOf('function bootstrapOwnedClientCores()');
  const end = main.indexOf('/** fleet 快照', start);
  const block = main.slice(start, end);
  assert.match(block, /handle\.child\.kill\('SIGTERM'\)/);
  assert.match(block, /浏览器保持关闭/);
  assert.doesNotMatch(block, /browser\.show|browser\.wake|queueStartEnv|openProfile|CDP/);
});

test('client core startup no longer prewarms AdsPower after login', () => {
  const proceed = main.slice(main.indexOf('async function proceedAfterAuth()'), main.indexOf('function startSessionMaintenance'));
  assert.doesNotMatch(proceed, /ensureAdsServiceOnce|ensureKernelOnce/, 'login must not depend on provider startup');
});
