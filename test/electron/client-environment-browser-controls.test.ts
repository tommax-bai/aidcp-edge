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

test('closed-task browser open returns a pending projection before bootstrap settles', () => {
  const start = main.indexOf("ipcMain.handle('browser:open'");
  const end = main.indexOf("ipcMain.handle('edge:start'", start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  const pendingAt = block.indexOf('handle.browserOpenPending = true');
  const startAt = block.indexOf('void startBrowserAbsentCore(handle)');
  const returnAt = block.indexOf('return statusOf(handle)', startAt);
  assert.ok(pendingAt >= 0 && startAt > pendingAt && returnAt > startAt);
  assert.doesNotMatch(block, /await startBrowserAbsentCore/);
  assert.match(block, /handle\.automationIntent = 'stopped'/);
  assert.match(block, /handle\.automationIntent !== 'stopped'/);
  assert.match(block, /handle\.stopRequested/);
  assert.match(renderer, /fields\.sessionClose\.textContent = '浏览器开启中'/);
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
