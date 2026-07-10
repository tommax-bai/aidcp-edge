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

test('application quit still uses final SIGTERM for every retained core', () => {
  const quit = functionSource('gracefulStopAllAndQuit', 'quitApp');
  assert.match(quit, /kill\('SIGTERM'\)/);
});
