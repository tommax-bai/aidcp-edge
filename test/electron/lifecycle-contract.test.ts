import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');
const edgeMain = readFileSync(join(here, '../../src/main.ts'), 'utf8');

function functionSource(name: string, nextName: string): string {
  const start = main.indexOf(`function ${name}(`);
  const end = main.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `missing function boundary ${name} -> ${nextName}`);
  return main.slice(start, end);
}

test('Electron engine child has IPC and pause disconnects it through lifecycle.pause_and_exit', () => {
  assert.match(main, /stdio:\s*\['pipe', 'pipe', 'pipe', 'ipc'\]/);
  const pause = functionSource('pauseEdge', 'resumeEdge');
  assert.match(pause, /sendCoreLifecycle\(handle, 'pause_and_exit'/);
  assert.match(pause, /handle\.automationIntent = 'paused'/);
  assert.match(pause, /handle\.stopRequested = true/);
  assert.match(pause, /child\.kill\('SIGTERM'\)/, 'IPC failure must still enforce pause = engine disconnected');
  assert.match(main, /if \(handle\.automationPaused\) \{\s*spawnEnv\.AIDCP_AUTOMATION_PAUSED_AT_START = '1'/,
    'manual browser sessions must remain paused even when bootstrapped browser-absent');
});

// change presence-terminal-honesty：断连时只翻云端徽标、不翻在场感，那一行会挂着断连前的中途动作文案
// （如「顺路去作者主页看看…」）继续演——云端都断了，决策端不可能再推进任何一步。Electron 起不来，
// 按本文件既有做法对源码设契约。
test('cloud disconnect rewrites the presence line instead of leaving the last action narrating', () => {
  const handler = functionSource('handleEdgeLogLine', 'pauseEdge');
  assert.match(handler, /WS 已关闭[\s\S]{0,120}?next\.presence = \{ text: '与云端连接中断，正在重连…'/);
  // 重连回来必须把中断文案翻走（'云端已重连' 在翻译规则表里没有条目、不会自己被顶掉）。
  assert.match(handler, /云端已重连[\s\S]{0,400}?next\.presence = \{ text: '已连接云端，等待安排…'/);
});

test('edge close stops automation engine while explicit browser close only releases the browser executor', () => {
  assert.match(preload, /close:\s*\(envId\)\s*=>\s*ipcRenderer\.invoke\('edge:close', envId\)/);
  assert.match(preload, /browserClose:\s*\(envId\)\s*=>\s*ipcRenderer\.invoke\('browser:close', envId\)/);
  assert.match(main, /ipcMain\.handle\('edge:close'/);
  assert.match(main, /ipcMain\.handle\('browser:close'/);
  const stopAutomation = functionSource('stopAutomation', 'closeBrowserExecutor');
  assert.match(stopAutomation, /sendCoreLifecycle\(handle, 'close'/);
  assert.match(stopAutomation, /handle\.automationIntent = 'stopped'/);
  assert.match(stopAutomation, /const externallyOccupiedBeforeAcquire = !handle\.child && handle\.envInUseThisRun === true/);
  assert.match(stopAutomation, /externallyOccupiedBeforeAcquire[\s\S]*handle\.browserStateUnconfirmed = false/,
    'occupied start rejection never acquired a local browser, so local close must clear the synthetic unconfirmed flag');
  const occupiedReturn = stopAutomation.indexOf('if (externallyOccupiedBeforeAcquire) return;');
  const genericConfirm = stopAutomation.indexOf('confirmOwnedProfileClosedFromShell(handle)');
  assert.ok(occupiedReturn >= 0 && genericConfirm > occupiedReturn,
    'occupied-before-acquire close must settle locally before the generic retained-browser confirmation');
  assert.match(stopAutomation, /closeScope: externallyOccupiedBeforeAcquire \? 'local_automation_only' : null/);
  assert.match(stopAutomation, /占用端浏览器未被本机关闭或触碰/);
  assert.match(stopAutomation, /confirmOwnedProfileClosedFromShell\(handle\)/,
    'closing without a child must verify an externally retained AdsPower browser instead of claiming success');
  const browserClose = functionSource('closeBrowserExecutor', 'relogin');
  assert.match(browserClose, /sendCoreLifecycle\(handle, 'standby'/);
  assert.doesNotMatch(browserClose, /sendCoreLifecycle\(handle, 'close'|kill\(['"]SIGTERM['"]\)/,
    'manual browser close keeps a running engine connected');
});

test('browser cold standby uses lifecycle.standby and manual controls cancel timers', () => {
  assert.match(main, /browserColdStandbyEnabled:\s*DEFAULT_BROWSER_COLD_STANDBY_ENABLED/);
  assert.match(main, /sendCoreLifecycle\(handle, 'standby'/);
  assert.match(main, /message\.type === 'lifecycle\.standby'/);
  assert.match(main, /message\.type === 'lifecycle\.wake_requested'/);
  assert.match(edgeMain, /onIdle:\s*\(\)\s*=>\s*sendLifecycleIpc\(\{ type: 'lifecycle\.task_idle' \}\)/,
    'core should report only a safe-idle hint after task coordination settles');
  assert.match(main, /message\.type === 'lifecycle\.task_idle'/);
  assert.match(main, /if \(standbyHint\) applyBrowserStandbyHint\(handle, standbyHint\)/,
    'Electron must reapply the latest hint through existing safety gates, not close directly');

  const pause = functionSource('pauseEdge', 'resumeEdge');
  assert.match(pause, /clearColdStandbyTimer\(handle\)/, 'manual pause must cancel cold standby timers');
  const close = functionSource('closeBrowserExecutor', 'relogin');
  assert.match(close, /clearColdStandbyTimer\(handle\)/, 'manual close must cancel cold standby timers');
  const restart = functionSource('stopAndRestart', 'handleEdgeOutput');
  assert.match(restart, /clearColdStandbyTimer\(handle\)/, 'manual restart must cancel cold standby timers');
});

test('cold standby cloud reconnect exhaustion keeps the core alive', () => {
  assert.match(edgeMain, /lifecycle\.standby_cloud_degraded/);
  assert.match(edgeMain, /lifecycle\.standby_cloud_reconnected/);

  const start = edgeMain.indexOf("client.on('cloud.unrecoverable'");
  const end = edgeMain.indexOf("client.onEdgeTaskCommand", start);
  assert.ok(start >= 0 && end > start, 'missing cloud.unrecoverable handler');
  const unrecoverable = edgeMain.slice(start, end);
  const standbyBranch = unrecoverable.slice(0, unrecoverable.indexOf("console.warn('[aidcp-edge] 云端重连耗尽"));

  assert.match(standbyBranch, /if \(coldStandbyActive\)/);
  assert.match(standbyBranch, /scheduleColdStandbyCloudReconnect\('cloud_reconnect_exhausted'\)/);
  assert.doesNotMatch(standbyBranch, /requestShutdown\('cloud_ws_unrecoverable'\)/);
  assert.doesNotMatch(standbyBranch, /process\.exitCode = EXIT_RECYCLE/);
});

test('cold standby child close stays in standby rather than respawning as a crash', () => {
  const startEdge = functionSource('startEdge', 'stopLoginPoller');

  assert.match(startEdge, /message\.type === 'lifecycle\.standby_cloud_degraded'/);
  assert.match(startEdge, /message\.type === 'lifecycle\.standby_cloud_reconnected'/);
  assert.match(startEdge, /const wasColdStandby = !controlPlaneNeverEstablished && \(handle\.coldStandbyPending \|\| handle\.coldStandbyActive\)/);
  assert.match(startEdge, /controlPlaneNeverEstablished = handle\.controlPlaneOnly && !handle\.controlPlaneBootstrapped/,
    'browser-absent hello failure must not be laundered into an intentional standby exit');
  assert.match(startEdge, /const intentional = [^;]*wasColdStandby[^;]*;/);
  assert.match(startEdge, /core_exited_during_standby/);
});

test('application quit still uses final SIGTERM for every retained core', () => {
  const quit = functionSource('gracefulStopAllAndQuit', 'quitApp');
  assert.match(quit, /kill\('SIGTERM'\)/);
  assert.match(quit, /await stopManagedAdsRuntime\(\)/);
  assert.ok(quit.indexOf("kill('SIGTERM')") < quit.indexOf('await stopManagedAdsRuntime()'), 'core shutdown must precede Ads CLI stop');
  assert.match(main, /const hasManagedAdsRuntime = Boolean\(managedAdsRuntime\)/);
  assert.match(main, /if \(!anyRunning && !hasManagedAdsRuntime\)/, 'daemon-only quit must still enter cleanup');
});

test('managed Ads runtime resets once per successful app session and owns the resolved base', () => {
  assert.match(main, /let adsRuntimeSessionResetComplete = false;/);
  const ensure = functionSource('ensureAdsService', 'ensureKernelOnce');
  assert.match(ensure, /resetExisting:\s*!adsRuntimeSessionResetComplete/);
  const failureGate = ensure.indexOf('if (!rt.ok)');
  const resetCommit = ensure.indexOf('adsRuntimeSessionResetComplete = true;');
  const baseCommit = ensure.indexOf('adsServiceBase = rt.base;');
  assert.ok(failureGate >= 0 && resetCommit > failureGate, 'session reset must be committed only after ensureRuntime succeeds');
  assert.ok(baseCommit > resetCommit, 'the fresh runtime base is committed after the session reset succeeds');

  assert.match(
    main,
    /const apiBase = adsServiceBase \|\| \(o\.apiBase && String\(o\.apiBase\)\.trim\(\)\) \|\| settings\.adsApiBase \|\| undefined;/,
    'managed CLI base must outrank a stale renderer/settings API base such as 50325',
  );
});

// Regression guard for a recurring packaged-only failure: in an asar:true build
// app.getAppPath() is the app.asar FILE, so spawning the core with cwd = appRoot
// throws 'spawn ENOTDIR' and the browser never launches (invisible to dev /
// typecheck / other tests). Fixed twice already (20d3784 lost on a feature branch,
// re-shipped in 0.3.5, re-fixed in 3f578b9). Keep the asar-guarded cwd forever.
test('core child spawn cwd is asar-guarded and never the raw app.asar appRoot', () => {
  const startEdge = functionSource('startEdge', 'stopLoginPoller');
  // must derive a real directory when appRoot is the packaged asar file
  assert.match(
    startEdge,
    /appRoot\.endsWith\('\.asar'\)\s*\?\s*path\.dirname\(appRoot\)\s*:\s*appRoot/,
    'startEdge must guard the spawn cwd against the app.asar file',
  );
  // the core spawn must consume the guarded value, not the raw appRoot
  assert.match(startEdge, /cwd:\s*edgeCwd\b/, 'core spawn must use the guarded edgeCwd');
  assert.doesNotMatch(
    startEdge,
    /cwd:\s*appRoot\b/,
    'core spawn cwd must never be the raw appRoot (app.asar file → spawn ENOTDIR)',
  );
});

test('every platform core receives the verified Native Page Engine artifact before spawn', () => {
  const spawnEdgeChild = functionSource('spawnEdgeChild', 'stopLoginPoller');
  assert.doesNotMatch(
    spawnEdgeChild,
    /normalizePlatform\(handle\.platform\)\s*===\s*['"]xiaohongshu['"]/,
    'Native artifact injection must not remain limited to Xiaohongshu after the Facebook/WeChat cutover',
  );
  assert.match(
    spawnEdgeChild,
    /verifyNativePageEngineArtifact\(nativeResourceDir\)[\s\S]*spawnEnv\.AIDCP_NATIVE_PAGE_ENGINE_BINARY = artifact\.binaryPath/,
  );
  assert.match(
    spawnEdgeChild,
    /const nativeArtifactRequiredAtSpawn = normalizePlatform\(handle\.platform\) !== 'wechat_channels'/,
    'XHS and Facebook must fail closed at spawn while WeChat may remain API-only in artifact-less direct development runs',
  );
  assert.ok(
    spawnEdgeChild.indexOf('spawnEnv.AIDCP_NATIVE_PAGE_ENGINE_BINARY = artifact.binaryPath')
      < spawnEdgeChild.indexOf('const child = spawn('),
    'the verified artifact path must be frozen into the child environment before spawn',
  );
});
