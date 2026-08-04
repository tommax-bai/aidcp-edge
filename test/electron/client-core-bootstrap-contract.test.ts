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
  assert.match(block, /fleet\.automationAuthorizationDecision\(/,
    'ownership enforcement must consult the pure authorization decision instead of an inline judgement');
  assert.doesNotMatch(block, /bindingState === 'bound'|binding_unknown|binding_unavailable/,
    'a never-handshaked or unreadable binding is not an authorization denial and must not stop automation');
  assert.match(block, /if \(!allowedEnvironmentsAuthoritative\) return;/,
    'a failed authoritative roster read must not be consumed as a revocation');
  assert.doesNotMatch(block, /coreBootstrapSupervisor\.enqueue|startBrowserAbsentCore|queueStartEnv|startEdge|resumeEdge|spawnEdgeChild/,
    'login-time ownership enforcement must never start an automation engine');

  const proceed = main.slice(main.indexOf('async function proceedAfterAuth()'), main.indexOf('function startSessionMaintenance'));
  assert.match(proceed, /syncEnvHandles\(\)[\s\S]*enforceOwnedAutomationEngines\(\)/);
  const maintenance = main.slice(main.indexOf('function startSessionMaintenance'), main.indexOf('function applyLegacyMirror'));
  assert.match(maintenance, /refreshAllowedEnvironments\(\)[\s\S]*syncEnvHandles\(\)[\s\S]*enforceOwnedAutomationEngines\(\)/);
});

test('an authorization convergence stops the engine, cancels the in-flight launch and never opens a browser to recover identity', () => {
  const start = main.indexOf('function enforceOwnedAutomationEngines()');
  const end = main.indexOf('/** fleet 快照', start);
  const block = main.slice(start, end);
  assert.match(block, /handle\.child\.kill\('SIGTERM'\)/);
  assert.match(block, /数据管理仍可继续使用/);
  // 停必须停干净：推进操作代（取消错峰/串行启动队列待执行项 + 归还启动排队名额）并清等槽位资历，
  // 否则会留下「已判停止、随后仍打开浏览器」的无人认领启动，界面同时写着「未启动 + 浏览器开启中」。
  assert.match(block, /advanceLifecycleGeneration\(handle, decision\.reason\)/);
  assert.match(block, /clearSlotWaiting\(handle\)/);
  assert.match(block, /handle\.stopRequested = true/);
  assert.doesNotMatch(block, /browser\.show|browser\.wake|queueStartEnv|openProfile|CDP/);
});

test('client login no longer prewarms AdsPower or an automation engine', () => {
  const proceed = main.slice(main.indexOf('async function proceedAfterAuth()'), main.indexOf('function startSessionMaintenance'));
  assert.doesNotMatch(proceed, /ensureAdsServiceOnce|ensureKernelOnce/, 'login must not depend on provider startup');
  assert.doesNotMatch(proceed, /startBrowserAbsentCore|queueStartEnv|spawnEdgeChild/, 'login must not start the automation engine');
});
