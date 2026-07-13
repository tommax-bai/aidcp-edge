import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');

function functionSource(name: string, nextName: string): string {
  const start = main.indexOf(`function ${name}(`);
  const end = main.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `missing function boundary ${name} -> ${nextName}`);
  return main.slice(start, end);
}

test('Electron core child has IPC and pause uses lifecycle.pause rather than SIGTERM', () => {
  assert.match(main, /stdio:\s*\['pipe', 'pipe', 'pipe', 'ipc'\]/);
  const pause = functionSource('pauseEdge', 'resumeEdge');
  assert.match(pause, /sendCoreLifecycle\(handle, 'pause'/);
  assert.doesNotMatch(pause, /kill\(['"]SIGTERM['"]\)/, 'pause must never fall back to final-close SIGTERM');
});

test('explicit close is exposed through preload and routed by envId', () => {
  assert.match(preload, /close:\s*\(envId\)\s*=>\s*ipcRenderer\.invoke\('edge:close', envId\)/);
  assert.match(main, /ipcMain\.handle\('edge:close'/);
  const close = functionSource('closeEdge', 'relogin');
  assert.match(close, /sendCoreLifecycle\(handle, 'close'/);
});

test('browser cold standby uses lifecycle.standby and manual controls cancel timers', () => {
  assert.match(main, /browserColdStandbyEnabled:\s*DEFAULT_BROWSER_COLD_STANDBY_ENABLED/);
  assert.match(main, /sendCoreLifecycle\(handle, 'standby'/);
  assert.match(main, /message\.type === 'lifecycle\.standby'/);
  assert.match(main, /message\.type === 'lifecycle\.wake_requested'/);

  const pause = functionSource('pauseEdge', 'resumeEdge');
  assert.match(pause, /clearColdStandbyTimer\(handle\)/, 'manual pause must cancel cold standby timers');
  const close = functionSource('closeEdge', 'relogin');
  assert.match(close, /clearColdStandbyTimer\(handle\)/, 'manual close must cancel cold standby timers');
  const restart = functionSource('stopAndRestart', 'handleEdgeOutput');
  assert.match(restart, /clearColdStandbyTimer\(handle\)/, 'manual restart must cancel cold standby timers');
});

test('application quit still uses final SIGTERM for every retained core', () => {
  const quit = functionSource('stopAllEdgeChildren', 'gracefulStopAllAndQuit');
  assert.match(quit, /kill\('SIGTERM'\)/);
});

test('automatic update stops all retained cores before calling quitAndInstall', () => {
  const install = functionSource('installDownloadedOlUpdate', 'showOlUpdateDownloaded');
  assert.match(install, /await stopAllEdgeChildren\(\)/, 'update install must await the shared stop gate');
  assert.match(install, /if \(!stopped\.ok\)/, 'update install must cancel when a child remains');
  assert.match(install, /autoUpdateService\.quitAndInstall\(\)/, 'only the safe path may invoke updater restart');
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
