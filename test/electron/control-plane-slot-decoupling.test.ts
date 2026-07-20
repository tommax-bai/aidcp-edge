import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const electronMain = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const fleet = readFileSync(new URL('../../src/electron/fleet.cjs', import.meta.url), 'utf8');
const edgeMain = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
const wechatRuntime = readFileSync(new URL('../../src/wechat-channels/runtime.ts', import.meta.url), 'utf8');

function blockBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `missing block ${startNeedle} -> ${endNeedle}`);
  return source.slice(start, end);
}

test('browser slot and start-queue rejection both keep a path to browser-absent Cloud control plane', () => {
  const startEdge = blockBetween(electronMain, 'function startEdge(', 'function spawnEdgeChild(');
  assert.match(startEdge, /admitBrowserSlot\(handle\)[\s\S]*startBrowserAbsentCore\(handle/);
  assert.match(startEdge, /retainStartQueueReservation:\s*true/);

  const enqueue = blockBetween(electronMain, 'function enqueueStartFlow(', 'function queueStartEnv(');
  assert.match(enqueue, /if \(!admission\.ok\)[\s\S]*startBrowserAbsentCore\(handle, \{ queueAdmission: admission \}\)/);
});

test('control bootstrap is customer-auth scoped, validated, and uses dedicated non-inherited env vars', () => {
  const bootstrap = blockBetween(electronMain, 'async function resolveControlBootstrap(', '// ── 视频号 InteractionWorkspace');
  assert.match(bootstrap, /clientAuthFetch\(`\/environments\/\$\{encodeURIComponent\(envKey\)\}\/control-bootstrap`/);
  assert.match(bootstrap, /returnedEnvKey !== envKey/);
  assert.match(electronMain, /binding_unknown:\s*'该环境尚未成功上报过登录账号'/);
  assert.match(electronMain, /binding_conflict:\s*'该环境的账号绑定存在跨客户冲突'/);

  assert.match(fleet, /'AIDCP_START_BROWSER_ABSENT'/);
  assert.match(fleet, /'AIDCP_CONTROL_ACCOUNT_ID'/);
  const spawn = blockBetween(electronMain, 'function spawnEdgeChild(', 'function stopLoginPoller(');
  assert.match(spawn, /spawnEnv\.AIDCP_START_BROWSER_ABSENT = '1'/);
  assert.match(spawn, /spawnEnv\.AIDCP_CONTROL_ACCOUNT_ID = controlBootstrap\.accountId/);
  assert.doesNotMatch(spawn, /spawnEnv\.AIDCP_ACCOUNT_ID\s*=/);
});

test('core browser-absent startup skips provider launch and acknowledges initial standby after valid Cloud connect', () => {
  assert.match(edgeMain, /const startBrowserAbsent = process\.env\.AIDCP_START_BROWSER_ABSENT === '1'/);
  assert.match(edgeMain, /if \(!startBrowserAbsent\) \{[\s\S]{0,180}provider\.launch\(launchOpts\)/);
  assert.match(edgeMain, /startBrowserAbsent \? createDetachedSession\(\) : await attachToPage/);
  assert.match(edgeMain, /startBrowserAbsent \? 'standby' : startAutomationPaused \? 'paused' : 'active'/);
  assert.match(edgeMain, /if \(startBrowserAbsent\) \{[\s\S]{0,200}type: 'lifecycle\.standby'/);
  assert.match(edgeMain, /\.\.\.\(startBrowserAbsent \? \['browser_absent_v1'\] : \[\]\)/);
});

test('browser-absent page commands request a wake and return an explicit failure instead of disappearing', () => {
  const handler = blockBetween(edgeMain, 'const handleBrowserAbsentCommand =', '/** 唤醒有了结论');
  assert.match(handler, /requestColdStandbyWake\(`cloud_command:\$\{env\.type\}`\)/);
  assert.match(handler, /reportActionCompleted\(\{ action, ok: false, reason: 'browser_absent_wake_requested' \}\)/);
  assert.match(handler, /operation\.browser === 'forbidden'[\s\S]*env\.type !== 'pacing\.update'[\s\S]*applyPacingSnapshot/);
  assert.equal(edgeMain.match(/if \(handleBrowserAbsentCommand\(env\)\) return;/g)?.length, 3);
});

test('browser-absent core does not consume a browser slot and real wake clears the marker', () => {
  const occupied = blockBetween(electronMain, 'function occupiedSlots(', 'function queuedStartCount(');
  assert.match(occupied, /!h\.controlPlaneOnly/);
  const woken = blockBetween(electronMain, 'function onColdStandbyWoken(', 'function onColdStandbyWakeFailed(');
  assert.match(woken, /handle\.controlPlaneOnly = false/);
  const wakeFailed = blockBetween(electronMain, 'function onColdStandbyWakeFailed(', '/**\n * 不占浏览器槽位地启动核心控制面');
  assert.match(wakeFailed, /setTimeout\(\(\) => drainSlotWaiters\(\), 0\)/);
});

test('wechat interaction runtime also keeps its browser sidecar closed until a slot-backed wake', () => {
  assert.match(wechatRuntime, /const startBrowserAbsent = env\.AIDCP_START_BROWSER_ABSENT === '1'/);
  assert.match(wechatRuntime, /startBrowserAbsent \? controlAccountId! : \(accountId \|\| envKey\)/);
  assert.match(wechatRuntime, /Cloud control plane online; browser sidecar remains absent/);
  assert.match(wechatRuntime, /process\.send\(\{ type: 'lifecycle\.standby' \}\)/);
  assert.match(wechatRuntime, /if \(type === 'lifecycle\.wake'\)[\s\S]*await auth\.initialize\(\)/);
  assert.match(wechatRuntime, /auth reopen deferred: browser slot unavailable/);
});
