import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const childStartup = readFileSync(join(electronDir, 'core-child-startup.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');
const edgeMain = readFileSync(join(here, '../../src/main.ts'), 'utf8');

function functionSource(name: string, nextName: string): string {
  const start = main.indexOf(`function ${name}(`);
  const end = main.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `missing function boundary ${name} -> ${nextName}`);
  return main.slice(start, end);
}

test('Electron engine child has IPC and pause disconnects it through lifecycle.pause_and_exit', () => {
  assert.match(main, /stdio: proxyAuthorityPayload[\s\S]{0,160}?\['pipe', 'pipe', 'pipe', 'ipc', 'pipe'\][\s\S]{0,100}?\['pipe', 'pipe', 'pipe', 'ipc'\]/);
  const pause = functionSource('pauseEdge', 'resumeEdge');
  assert.match(pause, /sendCoreLifecycle\(handle, 'pause_and_exit'/);
  assert.match(pause, /handle\.automationIntent = 'paused'/);
  assert.match(pause, /handle\.stopRequested = true/);
  assert.match(pause, /child\.kill\('SIGTERM'\)/, 'IPC failure must still enforce pause = engine disconnected');
  assert.match(main, /if \(handle\.automationPaused\) \{\s*spawnEnv\.AIDCP_AUTOMATION_PAUSED_AT_START = '1'/,
    'manual browser sessions must remain paused even when bootstrapped browser-absent');
});

test('managed AdsPower child uses the parent FIFO without receiving the API key', () => {
  assert.match(main, /AIDCP_ADS_API_BROKER: 'ipc'/);
  assert.match(main, /delete spawnEnv\.AIDCP_ADS_API_KEY/);
  const broker = functionSource('handleAdsApiBrokerRequest', 'handleFacebookTotpRequest');
  assert.match(broker, /adsApi\.brokerBatch\(\{/);
  assert.match(broker, /profileId: handle\.profileId/);
  assert.match(broker, /\.\.\.resolveAdsOpts\(\)/);
  assert.doesNotMatch(broker, /message\.(apiKey|apiBase)/);

  const spawn = functionSource('spawnEdgeChild', 'stopLoginPoller');
  const brokerBranch = spawn.indexOf("message.type === 'ads-api.request'");
  const staleGenerationGate = spawn.indexOf('if (!currentGeneration && !currentStopReply) return;');
  assert.ok(brokerBranch >= 0 && staleGenerationGate > brokerBranch,
    'the still-current child must retain broker access while close/restore advances lifecycle generation');
});

test('spawned core is observed before fallible post-spawn setup', () => {
  const spawn = functionSource('spawnEdgeChild', 'stopLoginPoller');
  const childOwnership = childStartup.indexOf('handle.child = child;');
  const launchReady = childStartup.indexOf('const launchReady = createLaunchReady();');
  const observerRegistrations = [
    "child.on('error'",
    "child.on('exit', observers.exit);",
    "child.on('close', observers.close);",
    "child.on('message', observers.message);",
    "child.stdout?.on?.('data', observers.stdout);",
    "child.stderr?.on?.('data', observers.stderr);",
  ].map((needle) => childStartup.indexOf(needle));
  const prepareCall = childStartup.indexOf('return { ok: prepare() !== false, launchReady };');

  assert.ok(childOwnership >= 0, 'spawn must establish current-child ownership');
  assert.ok(launchReady > childOwnership, 'launch readiness must exist after ownership');
  for (const registration of observerRegistrations) {
    assert.ok(registration > launchReady, 'every child observer must be registered after readiness exists');
    assert.ok(registration < prepareCall, 'every child observer must precede fallible setup');
  }
  assert.match(childStartup, /catch \(error\) \{[\s\S]*?onSetupFailure\(error\)[\s\S]*?settleLaunchFailure[\s\S]*?releaseStartReservation[\s\S]*?requestTermination/);
  assert.match(spawn, /initializeOwnedCoreChild\(\{[\s\S]*?prepare\(\) \{[\s\S]*?if \(proxyAuthorityPayload\)[\s\S]*?edge: 'starting'/);
  assert.match(spawn, /const retryableSetupFailure = Boolean\(setupRetryRequested\) && !intentional;[\s\S]*?exitCode: retryableSetupFailure \? setupDisposition\.respawnExitCode/,
    'graceful cleanup code=0 must still reach bounded respawn, unless a user terminal overrides it');
  assert.match(spawn, /finalizeNonRetryableSetupTerminal\(\{[\s\S]*?childStillOwned: handle\.child === child[\s\S]*?stopStartForProxyFailure[\s\S]*?broadcastFleet/,
    'known proxy terminal must be reprojected after ownership clears and must not auto-respawn');
  assert.match(spawn, /return startup\.launchReady;/);
});

test('Facebook TOTP IPC is current-child/profile bound and projects no raw AdsPower material', () => {
  const broker = functionSource('handleFacebookTotpRequest', 'maybeRenameEnvToNickname');
  assert.match(broker, /adsApi\.getFacebookTotp\(\{/);
  assert.match(broker, /profileId: handle\.profileId/);
  assert.match(broker, /handle\.child !== child/);
  assert.match(broker, /fleet\.nicknameSourceForPlatform\(handle\.platform\) !== 'facebook'/);
  assert.match(broker, /Object\.keys\(message\)\.length === 3/);
  assert.doesNotMatch(broker, /message\.(profileId|profile_id|apiKey|apiBase)/);
  assert.doesNotMatch(broker, /console\.(log|warn|error)/);
  assert.match(broker, /code: result\.code/);
  assert.match(broker, /windowStartMs: result\.windowStartMs/);
  assert.match(broker, /windowEndMs: result\.windowEndMs/);

  const spawn = functionSource('spawnEdgeChild', 'stopLoginPoller');
  const staleGenerationGate = spawn.indexOf('if (!currentGeneration && !currentStopReply) return;');
  const totpBranch = spawn.indexOf("message.type === 'facebook-totp.request'");
  assert.ok(totpBranch > staleGenerationGate,
    'TOTP must not remain available to a stale lifecycle generation during teardown');
});

test('Facebook TOTP handler executes against the real fleet platform authority and sends only projected fields', async () => {
  const source = `async ${functionSource('handleFacebookTotpRequest', 'maybeRenameEnvToNickname').replace(/async\s*$/, '')}`;
  const calls: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const adsApi = {
    getFacebookTotp: async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        ok: true,
        code: '287082',
        windowStartMs: 1_770_000_000_000,
        windowEndMs: 1_770_000_030_000,
      };
    },
  };
  const resolveAdsOpts = () => ({ apiKey: 'parent-owned-key' });
  const fleet = {
    nicknameSourceForPlatform: (platform: unknown) => platform === 'facebook' ? 'facebook' : 'xhs',
  };
  const handler = new Function(
    'adsApi',
    'resolveAdsOpts',
    'fleet',
    `${source}; return handleFacebookTotpRequest;`,
  )(adsApi, resolveAdsOpts, fleet) as (
    handle: Record<string, unknown>,
    child: Record<string, unknown>,
    message: Record<string, unknown>,
  ) => Promise<void>;
  const child = {
    connected: true,
    send: (payload: Record<string, unknown>) => sent.push(payload),
  };
  const handle = {
    kind: 'adspower',
    platform: 'facebook',
    profileId: 'bound-profile',
    child,
  };
  await handler(handle, child, {
    type: 'facebook-totp.request',
    requestId: 'facebook-totp-123-1',
    serverEpochMs: 1_770_000_001_000,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileId, 'bound-profile');
  assert.equal(calls[0].serverEpochMs, 1_770_000_001_000);
  assert.equal(typeof calls[0].isCancelled, 'function');
  assert.deepEqual(sent, [{
    type: 'facebook-totp.response',
    requestId: 'facebook-totp-123-1',
    ok: true,
    code: '287082',
    windowStartMs: 1_770_000_000_000,
    windowEndMs: 1_770_000_030_000,
  }]);
});

test('Facebook TOTP handler rejects a child-supplied profile id before reading AdsPower', async () => {
  let reads = 0;
  const source = `async ${functionSource('handleFacebookTotpRequest', 'maybeRenameEnvToNickname').replace(/async\s*$/, '')}`;
  const handler = new Function(
    'adsApi',
    'resolveAdsOpts',
    'fleet',
    `${source}; return handleFacebookTotpRequest;`,
  )(
    { getFacebookTotp: async () => { reads += 1; return { ok: false }; } },
    () => ({}),
    { nicknameSourceForPlatform: () => 'facebook' },
  ) as (
    handle: Record<string, unknown>,
    child: Record<string, unknown>,
    message: Record<string, unknown>,
  ) => Promise<void>;
  const sent: Record<string, unknown>[] = [];
  const child = {
    connected: true,
    send: (payload: Record<string, unknown>) => sent.push(payload),
  };
  const handle = {
    kind: 'adspower',
    platform: 'facebook',
    profileId: 'bound-profile',
    child,
  };
  await handler(handle, child, {
    type: 'facebook-totp.request',
    requestId: 'facebook-totp-123-2',
    serverEpochMs: 1_770_000_001_000,
    profileId: 'other-profile',
  });
  assert.equal(reads, 0);
  assert.deepEqual(sent, [{
    type: 'facebook-totp.response',
    requestId: 'facebook-totp-123-2',
    ok: false,
    reason: 'invalid_totp_request',
  }]);
});

test('Active browser bypasses proxy preparation and is handed to an active-only core', () => {
  const spawn = functionSource('spawnEdgeChild', 'stopLoginPoller');
  assert.match(spawn, /activeBrowserTakeover = await adsBrowserStartupState\(handle\) === 'active'/);
  assert.match(spawn, /if \(activeBrowserTakeover\) \{[\s\S]*?proxyPreflight\.invalidate\(handle\.envId\);[\s\S]*?\} else \{[\s\S]*?ensureNetworkPreparation\(handle\)/);
  assert.match(spawn, /if \(activeBrowserTakeover\) \{\s*spawnEnv\.AIDCP_ADS_ACTIVE_ONLY = '1';/);
  assert.doesNotMatch(spawn, /expectedEgressIp|AIDCP_EGRESS_PROBE_URL/);
  assert.doesNotMatch(edgeMain, /requireActiveProxyEgressMatch|verifyActiveProxyTakeover|expectedEgressIp/);
});

test('every Electron AdsPower write client uses the same parent FIFO', () => {
  const constructors = main.match(/createAdsWriteApi\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(constructors.length > 0, 'main process should construct managed write clients');
  for (const constructor of constructors) {
    assert.match(constructor, /requestImpl:\s*adsApi\.enqueueRequest/);
  }
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

test('startup-auth close requires generation-bound browser death evidence before Electron claims closure', () => {
  assert.match(edgeMain, /settleStartupAuthLifecycleInterrupt\(command, \{/);
  assert.match(edgeMain, /closeOwnedBrowser: \(\) => chrome \? chrome\.killAndConfirmDead\(\) : Promise\.resolve\(false\)/,
    'startup authentication must reuse the authoritative provider teardown');
  assert.match(edgeMain, /reportBrowserClosed: \(\) => sendLifecycleIpcAcknowledged\(\{ type: 'lifecycle\.browser_closed' \}\)/,
    'the core must flush browser-death evidence before it may exit');

  const spawn = functionSource('spawnEdgeChild', 'stopLoginPoller');
  assert.match(spawn, /message\.type === 'lifecycle\.browser_closed'[\s\S]*?handle\.browserCloseConfirmedGeneration = handle\.lifecycleGeneration/,
    'Electron must bind the receipt to the current stop generation');
  assert.match(spawn, /const browserCloseConfirmed = handle\.browserCloseConfirmedGeneration === handle\.lifecycleGeneration/);
  assert.match(spawn, /const closeEvidenceMissing = \(stopReason === 'user_close' \|\| stopReason === 'user_pause'\)[\s\S]*?!browserCloseConfirmed/);
  assert.match(spawn, /lastMessage: closeEvidenceMissing[\s\S]*?浏览器关闭状态未能确认[\s\S]*?stopReason === 'user_close'[\s\S]*?引擎和浏览器已关闭/,
    'missing evidence must win over the normal user-close success projection');

  const occupied = functionSource('occupiedSlots', 'queuedStartCount');
  assert.match(occupied, /liveCoreBrowser \|\| h\.browserStateUnconfirmed/,
    'an orphaned browser must retain its concurrency slot');
  const admit = functionSource('admitBrowserSlot', 'slotWaiters');
  assert.match(admit, /occupiedSlots\(\) - \(handle\.browserStateUnconfirmed \? 1 : 0\)/,
    'the same profile may reacquire its retained slot to recover and close the browser');

  const shellConfirmation = functionSource('confirmOwnedProfileClosedFromShell', 'stopAutomation');
  assert.match(shellConfirmation, /handle\.browserStateUnconfirmed = false;[\s\S]*?drainSlotWaiters\(\)/,
    'read-only confirmation of browser death must release queued starts');
});

test('browser cold standby uses lifecycle.standby and manual controls cancel timers', () => {
  assert.match(main, /browserColdStandbyEnabled:\s*DEFAULT_BROWSER_COLD_STANDBY_ENABLED/);
  assert.match(main, /sendCoreLifecycle\(handle, 'standby'/);
  assert.match(main, /message\.type === 'lifecycle\.standby'/);
  assert.match(main, /message\.type === 'lifecycle\.wake_requested'/);
  assert.match(edgeMain, /onIdle:\s*\(\)\s*=>\s*sendLifecycleIpc\(\{ type: 'lifecycle\.task_idle' \}\)/,
    'core should report only a safe-idle hint after task coordination settles');
  assert.match(main, /message\.type === 'lifecycle\.task_idle'/);
  assert.match(main, /if \(standbyHint && !handle\.coldStandbyHintRevoked\) applyBrowserStandbyHint\(handle, standbyHint\)/,
    'Electron must reapply only a current hint through existing safety gates, not close directly');

  const revoke = functionSource('revokeBrowserStandbyHint', 'applyBrowserStandbyHint');
  assert.match(revoke, /action === 'ignore'/,
    'a manual browser-close state without a cached Cloud hint must not be auto-woken');
  assert.match(revoke, /clearColdStandbyHoldTimer\(handle\)/,
    'missing Cloud evidence must cancel a cached post-hold recheck');
  assert.match(revoke, /action === 'retain_active'[\s\S]*handle\.coldStandbyHintRevoked = true[\s\S]*return/,
    'an already sleeping browser keeps its deterministic wake cycle');
  assert.match(revoke, /coldStandbyStatus\('skipped', null, \{ reason: 'hint_revoked' \}\)/,
    'awake/pending revocation must remove the cached hint from status readback');
  assert.match(revoke, /action === 'wake_pending'[\s\S]*wakeColdStandby\(handle, 'hint_revoked'\)/,
    'a close that is only pending must be cancelled through the existing wake path');

  const apply = functionSource('applyBrowserStandbyHint', 'enterColdStandby');
  assert.match(apply, /const cachedHint = normalizeBrowserStandbyHint\(handle\.status\.browserStandby/);
  assert.match(apply, /classifyBrowserStandbyHintUpdate\(rawHint/);
  assert.match(apply, /hasCachedHint: Boolean\(cachedHint\)/);
  assert.match(apply, /if \(update\.action !== 'apply'\)[\s\S]*revokeBrowserStandbyHint\(handle, update\.action\)/);
  assert.match(apply, /handle\.coldStandbyHintRevoked = false/,
    'a later valid Cloud hint must supersede an earlier revocation');

  const enter = functionSource('enterColdStandby', 'onColdStandbyAck');
  assert.match(enter, /const hintRevoked = Boolean\(handle\.coldStandbyHintRevoked\)[\s\S]*hintRevoked \? null : decision\.hint/,
    'a revoked pending hint must not be restored when the original standby request fails');

  const output = functionSource('handleEdgeOutput', 'pauseEdge');
  assert.match(output, /evt\.kind === 'browserStandby' \|\| Object\.prototype\.hasOwnProperty\.call\(evt, 'browserStandby'\)/);
  assert.match(output, /if \(standbyHintUpdated\) applyBrowserStandbyHint\(handle, standbyHint\)/,
    'the null revocation marker must reach the same authority-update path');

  const woken = functionSource('onColdStandbyWoken', 'onColdStandbyWakeFailed');
  assert.match(woken, /const hintRevoked = Boolean\(handle\.coldStandbyHintRevoked\)/);
  assert.match(woken, /const completedHint = hintRevoked[\s\S]*\? null[\s\S]*handle\.status\.browserStandby/);
  assert.match(woken, /coldStandbyStatus\('awake', completedHint, hintRevoked \? \{ reason: 'hint_revoked' \} : \{\}\)/,
    'an active cycle may wake normally but must not carry the revoked hint into the next cycle');

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
  assert.match(quit, /await proxyChainManager\.stopAll\(\)/);
  assert.match(quit, /await stopManagedAdsRuntime\(\)/);
  assert.ok(quit.indexOf('await proxyChainManager.stopAll()') < quit.indexOf('await stopManagedAdsRuntime()'), 'proxy relays must stop before Ads CLI');
  assert.ok(quit.indexOf("kill('SIGTERM')") < quit.indexOf('await stopManagedAdsRuntime()'), 'core shutdown must precede Ads CLI stop');
  assert.match(main, /const hasManagedAdsRuntime = Boolean\(managedAdsRuntime\)/);
  assert.match(main, /if \(!anyRunning && !hasManagedAdsRuntime && !hasManagedProxyChains\)/,
    'daemon-only or relay-only quit must still enter cleanup');
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
    /verifyRuntimeNativePageEngineArtifact\(nativeResourceDir\)/,
    'packaged macOS runtime must use the availability verifier rather than repeat release signature checks',
  );
  assert.doesNotMatch(
    spawnEdgeChild,
    /verifyPackagedNativePageEngineArtifact/,
    'strict Developer ID verification belongs to afterSign/final release gates, not installed runtime startup',
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
