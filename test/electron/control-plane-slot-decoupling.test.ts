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

test('first-start slot and queue rejection stay local without spawning a core or connecting Cloud', () => {
  const startEdge = blockBetween(electronMain, 'function startEdge(', 'function spawnEdgeChild(');
  const slotRejected = blockBetween(startEdge, 'if (!admitted.ok)', 'clearSlotWaiting(handle)');
  assert.match(slotRejected, /parkForSlot\(handle, admitted\)/);
  assert.match(slotRejected, /return false/);
  assert.doesNotMatch(slotRejected, /spawnEdgeChild|controlBootstrap|clientAuthFetch/);

  const enqueue = blockBetween(electronMain, 'function enqueueStartFlow(', 'function queueStartEnv(');
  const queueRejected = blockBetween(enqueue, 'if (!admission.ok)', 'handle.startFlowQueued = true');
  assert.match(queueRejected, /showStartQueueFull\(handle, admission\)/);
  assert.match(queueRejected, /return false/);
  assert.doesNotMatch(queueRejected, /spawnEdgeChild|controlBootstrap|clientAuthFetch/);

  const park = blockBetween(electronMain, 'function parkForSlot(', '/**\n * 到点告诉核心');
  assert.match(park, /clearEdgeFailurePatch\(handle\)/, '进入槽位队列时必须清除旧失败投影');
  assert.match(park, /parked \? \{\} : \{ edge: 'idle', session: 'idle' \}/);
  assert.doesNotMatch(electronMain, /startBrowserAbsentCore|resolveControlBootstrap/);
});

test('restricted offboard cleanup keeps its dedicated browserless core path', () => {
  const cleanup = blockBetween(electronMain, 'async function startRestrictedOffboardCleanupCore(', '/**\n * 启动一个环境');
  assert.match(cleanup, /\/offboarding\/\$\{encodeURIComponent\(pending\.offboardId\)\}\/cleanup-bootstrap/);
  assert.match(cleanup, /data\.mode !== 'restricted_cleanup'/);
  assert.match(cleanup, /spawnEdgeChild\(handle, \{[\s\S]*controlBootstrap: \{ accountId: data\.accountId \}/);
  assert.match(fleet, /'AIDCP_START_BROWSER_ABSENT'/);
  assert.match(fleet, /'AIDCP_CONTROL_ACCOUNT_ID'/);
  const spawn = blockBetween(electronMain, 'function spawnEdgeChild(', 'function stopLoginPoller(');
  assert.match(spawn, /spawnEnv\.AIDCP_START_BROWSER_ABSENT = '1'/);
  assert.match(spawn, /spawnEnv\.AIDCP_CONTROL_ACCOUNT_ID = controlBootstrap\.accountId/);
  assert.doesNotMatch(spawn, /spawnEnv\.AIDCP_ACCOUNT_ID\s*=/);
});

test('restricted browserless core skips provider launch and acknowledges initial standby after valid Cloud connect', () => {
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
  // 这条计数此前期望 2，而那 2 次里有 1 次就落在一段静态恒假的死码里 ——
  // 一条本意是「被移除的页面路由不得再出现」的否定式闸，反被它要禁止的死码喂成了绿。
  // 死码删除后真实入口只剩这一条；把期望改回 2 等于把死码再种回来。
  assert.equal(
    edgeMain.match(/if \(handleBrowserAbsentCommand\(env\)\) return;/g)?.length,
    1,
    'the sole live ingress is the Native page-command route; a second occurrence means the retired route came back',
  );
});

test('browser-absent core does not consume a browser slot and real wake clears the marker', () => {
  // 判据已抽成独立函数，供槽位计数与阻塞滞留终止共用（change release-browser-slot-on-stalled-blocker）。
  // 不变量不变：从未开过浏览器的控制面环境不占槽——终止它同样腾不出任何位子。
  const occupancy = blockBetween(electronMain, 'function handleOccupiesBrowserSlot(', 'function occupiedSlots(');
  assert.match(occupancy, /!h\.controlPlaneOnly/);
  const occupied = blockBetween(electronMain, 'function occupiedSlots(', 'function queuedStartCount(');
  assert.match(occupied, /handleOccupiesBrowserSlot\(h\)/, '槽位计数必须走同一个判据，不得再写一份');
  const woken = blockBetween(electronMain, 'function onColdStandbyWoken(', 'function onColdStandbyWakeFailed(');
  assert.match(woken, /handle\.controlPlaneOnly = false/);
  const wakeFailed = blockBetween(electronMain, 'function onColdStandbyWakeFailed(', 'async function startRestrictedOffboardCleanupCore(');
  assert.match(wakeFailed, /setTimeout\(\(\) => drainSlotWaiters\(\), 0\)/);
});

test('slot handoff keeps FIFO authority until the head actually passes launch admission', () => {
  const admit = blockBetween(electronMain, 'function admitBrowserSlot(', '// ── 等槽位队列');
  assert.match(admit, /const waiting = slotWaiters\(\)/);
  assert.match(admit, /waiting\.length > 0 && waiting\[0\] !== handle/);
  assert.match(admit, /reason: 'slot_fifo_wait'/);

  const drain = blockBetween(electronMain, 'function drainSlotWaiters(', 'function startSlotWaitTimer(');
  assert.doesNotMatch(
    drain,
    /clearSlotWaiting\(head\)/,
    '队头被唤醒任务真正准入前必须保留 FIFO 资格，后来任务不得趁空位直入',
  );

  const wake = blockBetween(electronMain, 'function wakeColdStandby(', '/** 核心已完成原地重建');
  assert.match(wake, /admitBrowserSlot\(handle\)[\s\S]*clearSlotWaiting\(handle\)/);
  const start = blockBetween(electronMain, 'function startEdge(', 'function spawnEdgeChild(');
  assert.match(start, /admitBrowserSlot\(handle\)[\s\S]*clearSlotWaiting\(handle\)/);
});

test('closing a first-start waiter cancels the local queue without sending lifecycle.close', () => {
  const stop = blockBetween(electronMain, 'function stopAutomation(', 'function closeBrowserExecutor(');
  assert.match(stop, /releaseStartQueue\(handle\)[\s\S]*clearSlotWaiting\(handle\)[\s\S]*if \(!handle\.child\)/);
  const noChild = blockBetween(stop, 'if (!handle.child)', 'const child = handle.child');
  assert.match(noChild, /edge: 'stopped'/);
  assert.match(noChild, /session: 'closed'/);
  assert.doesNotMatch(noChild, /sendCoreLifecycle|kill\(/);
});

test('wechat interaction runtime uses an independent transient lane and API/Cloud running proof', () => {
  assert.match(wechatRuntime, /new TransientBrowserLeaseClient\(\{/);
  assert.match(wechatRuntime, /initiallyHeld: env\.AIDCP_TRANSIENT_BROWSER_LEASE === '1'/);
  assert.match(wechatRuntime, /new LeasedWechatChannelsBrowserSidecar\(rawSidecar, transientLease\)/);
  assert.match(wechatRuntime, /onApiCloudRoundTrip: \(at\) => \{[\s\S]{0,100}runtimeProofAt = at/);
  assert.match(wechatRuntime, /type: 'lifecycle\.interaction_runtime'/);
  assert.match(wechatRuntime, /identityMatches: authSnapshot\.identityMatches/);
  assert.match(wechatRuntime, /connectorStarted: connector!\.isStarted\(\)/);
  assert.match(wechatRuntime, /cloudNegotiated: client\.isInteractionInboxNegotiated\(\)/);
  assert.match(wechatRuntime, /proofAt: runtimeProofAt/);
  assert.match(wechatRuntime, /sidecar\.releaseIfBrowserClosed\('startup_initialization_complete'\)/);
});
