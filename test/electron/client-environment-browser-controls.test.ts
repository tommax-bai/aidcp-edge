import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');
const renderer = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');

function functionBlock(name: string, nextName: string) {
  const start = main.indexOf(`function ${name}`);
  const end = main.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} block must exist`);
  return main.slice(start, end);
}

test('filtered close-all scopes live handles and reuses single-environment close truth', () => {
  const block = functionBlock('closeAllEnvs', 'stopManagedAdsRuntime');
  assert.match(block, /fleet\.scopeFleetHandles\(\[\.\.\.envs\.values\(\)\], envIds\)/);
  assert.match(block, /for \(const handle of targets\) stopAutomation\(handle\)/);
  assert.match(block, /accepted: targets\.length/);
  assert.doesNotMatch(block, /pauseEdge|stopAllEnvs|app\.quit|stopManagedAdsRuntime/);
  assert.match(main, /ipcMain\.handle\('fleet:closeAll', \(_event, opts\) => closeAllEnvs\(opts \|\| \{\}\)\)/);
  assert.match(preload, /fleetCloseAll: \(opts\) => ipcRenderer\.invoke\('fleet:closeAll', opts\)/);
  assert.match(html, /id="rail-close-all"[^>]*>全部关闭<\/button>/);
  const woken = functionBlock('onColdStandbyWoken', 'onColdStandbyWakeFailed');
  assert.match(woken, /handle\.stopRequested \|\| handle\.removed \|\| isQuitting/,
    'a late wake acknowledgement must not undo a batch or single close');
});

test('rapid close then start waits for the closing core and starts exactly from the new lifecycle generation', () => {
  const stop = functionBlock('stopAutomation', 'closeBrowserExecutor');
  assert.match(stop, /advanceLifecycleGeneration\(handle, 'user_close'\)/);
  assert.match(stop, /handle\.stopRequested = true/);
  assert.match(stop, /loopStage: null/);

  const resume = functionBlock('resumeEdge', 'confirmOwnedProfileClosedFromShell');
  const barrierAt = resume.indexOf('if (closingBeforeResume)');
  const restartIntentAt = resume.indexOf('handle.resumeAfterStop = true', barrierAt);
  const releaseStopAt = resume.indexOf('handle.stopRequested = false', restartIntentAt);
  assert.ok(barrierAt >= 0 && restartIntentAt > barrierAt && releaseStopAt > restartIntentAt,
    '关闭中的新启动先记录 resumeAfterStop，返回后才允许普通路径复位 stopRequested');
  assert.match(resume, /关闭收尾中；引擎和浏览器关闭后将重新启动/);

  const startAll = functionBlock('startAllEnvs', 'stopAllEnvs');
  assert.match(startAll, /const closing = scoped\.filter/);
  assert.match(startAll, /\[\.\.\.closing, \.\.\.paused, \.\.\.standby\]\.forEach\(\(h\) => resumeEdge\(h\)\)/);
  assert.doesNotMatch(startAll, /standby\.forEach\(\(h\) => wakeColdStandby/);

  assert.match(main, /if \(shouldResumeAfterStop && !isQuitting\)[\s\S]*queueStartEnv\(handle\)/,
    '旧核心真实退出后才进入统一启动队列');
  assert.match(main, /const currentStopReply = !currentGeneration[\s\S]*lifecycle\.close_failed[\s\S]*lifecycle\.paused/,
    '旧子进程只可回报与当前停止意图匹配的终局结果');
  assert.match(main, /if \(staleGeneration\)[\s\S]*shouldStartCurrent[\s\S]*queueStartEnv\(handle\)/,
    '旧代 spawn 的迟到失败不得挂自动重启，只能按当前代意图收尾或重启');
  assert.match(main, /本次重新启动已取消；请重试关闭/,
    '浏览器未确认关闭时不得继续开启新一代浏览器');
});

test('closed-task browser open joins the normal FIFO without a browser-absent core', () => {
  const start = main.indexOf("ipcMain.handle('browser:open'");
  const end = main.indexOf("ipcMain.handle('edge:start'", start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  const statusAt = block.indexOf('updateStatus(handle');
  const enqueueAt = block.indexOf('enqueueStartFlow(handle)');
  const returnAt = block.indexOf('return statusOf(handle)', enqueueAt);
  assert.ok(statusAt >= 0 && enqueueAt > statusAt && returnAt > enqueueAt);
  assert.match(block, /handle\.automationIntent = 'stopped'/);
  assert.match(block, /handle\.automationPaused = true/);
  assert.match(block, /if \(handle\.child\)[\s\S]*wakeColdStandby\(handle, 'user_browser_open'\)/);
  assert.doesNotMatch(block, /startBrowserAbsentCore|resolveControlBootstrap|controlBootstrap/);
  const pauseBlock = functionBlock('pauseEdge', 'resumeEdge');
  assert.match(pauseBlock, /handle\.automationIntent = 'paused'/, 'manual browser-open state must not change pause semantics');
});

test('successful foreground and parking requests no longer emit explanatory copy', () => {
  const forbidden = /已向该环境发出窗口|窗口平时停放在屏幕边缘|系统窗口切换器里按名字找到/;
  assert.doesNotMatch(main, forbidden);
  assert.doesNotMatch(renderer, forbidden);
  const block = functionBlock('sendBrowserParkingCommand', 'sendPersonaCommand');
  assert.match(block, /return \{ ok: true \}/);
  assert.doesNotMatch(block, /hint|currentParkingPlan/);
});

test('environment-avatar exclusive recall uses correlated park/show completion and restores AIDCP above the target', () => {
  assert.match(preload, /showDrivenBrowser: \(envId, opts\) => ipcRenderer\.invoke\('browser:showDriven', envId, opts\)/);
  assert.match(preload, /recallExclusiveBrowser: \(envId\) => ipcRenderer\.invoke\('browser:recallExclusive', envId\)/);
  assert.match(preload, /parkShownBrowser: \(envId\) => ipcRenderer\.invoke\('browser:parkShown', envId\)/);
  assert.match(renderer, /window\.aidcpEdge\.recallExclusiveBrowser/);
  assert.match(renderer, /window\.aidcpEdge\.parkShownBrowser/);
  assert.match(main, /const browserControlPending = new Map\(\)/);
  assert.match(main, /mainWindow\.getBounds\(\)/);
  assert.match(main, /screen\.getDisplayMatching\(clientBounds\)/);
  assert.match(main, /clientAlignedBrowserBounds\(clientBounds, display\)/);
  assert.match(main, /sendCorrelatedBrowserControlCommand\([\s\S]{0,180}'browser\.show'[\s\S]{0,180}bounds: targetBounds/);
  assert.match(main, /parkDrivenBrowserUsingConfiguredBounds[\s\S]{0,180}'browser\.park'/);
  assert.match(main, /message\.startsWith\(BROWSER_PARKING_REPLY_PREFIX\)/);
  const focus = functionBlock('focusAidcpAboveDrivenBrowser', 'handleBrowserParkingReply');
  assert.match(focus, /mainWindow\.show\(\)/);
  assert.match(focus, /mainWindow\.focus\(\)/);
  assert.match(focus, /mainWindow\.moveTop\(\)/);
  const show = functionBlock('showDrivenBrowserBelowClient', 'browserHandleControllable');
  assert.match(show, /浏览器窗口移动超时/);
  assert.match(main, /createExclusiveBrowserRecallCoordinator\(\{[\s\S]{0,500}parkBrowser: parkDrivenBrowserUsingConfiguredBounds[\s\S]{0,160}showBrowser: showDrivenBrowserBelowClient/);
  assert.match(main, /ipcMain\.handle\('browser:recallExclusive'[\s\S]{0,180}envs\.get\(envId\)[\s\S]{0,120}exclusiveBrowserRecallCoordinator\.recall/);
  assert.match(main, /ipcMain\.handle\('browser:parkShown'[\s\S]{0,180}envs\.get\(envId\)[\s\S]{0,120}exclusiveBrowserRecallCoordinator\.park/);
  assert.match(main, /opts && opts\.keepClientForeground === true[\s\S]{0,120}showDrivenBrowserBelowClient/);
  assert.match(renderer, /showDrivenBrowser\(envId\)/, '登录引导保留不带 client-foreground policy 的浏览器前台调用');
});
