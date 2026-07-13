import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const buildScript = readFileSync(join(root, 'scripts/build-desktop-macos.sh'), 'utf8');
const workflow = readFileSync(join(root, '.github/workflows/build-desktop.yml'), 'utf8');
const verifier = readFileSync(join(root, 'scripts/verify-ol-auto-update-artifacts.mjs'), 'utf8');
const main = readFileSync(join(root, 'src/electron/main.cjs'), 'utf8');
const preload = readFileSync(join(root, 'src/electron/preload.cjs'), 'utf8');
const renderer = readFileSync(join(root, 'src/electron/renderer/renderer.js'), 'utf8');
const html = readFileSync(join(root, 'src/electron/renderer/index.html'), 'utf8');

test('only OL macOS build bakes a generic HTTPS update source', () => {
  assert.match(buildScript, /AIDCP_CLOUD_DEFAULT_ENV:-\}" = "ol"/, 'OL guard is required');
  assert.match(buildScript, /aidcpUpdateChannel=ol/, 'OL package must carry an explicit channel');
  assert.match(buildScript, /aidcpUpdateUrl=\$update_url/, 'OL package must carry the fixed update URL');
  assert.match(buildScript, /publish\.provider=generic/, 'OL package must use the generic static provider');
  assert.match(buildScript, /AIDCP_UPDATE_URL must be an https:\/\/ URL/, 'OL build must reject non-HTTPS update sources');
});

test('CI delivers every macOS update artifact and build runs the fail-closed verifier', () => {
  for (const pattern of ['dist-electron/*-mac.zip', 'dist-electron/*-mac.zip.blockmap', 'dist-electron/latest-mac.yml']) {
    assert.ok(workflow.includes(pattern), `workflow must deliver ${pattern}`);
  }
  assert.match(buildScript, /verify-ol-auto-update-artifacts\.mjs/, 'OL release build must verify artifacts before CI delivery');
  assert.match(verifier, /app-update\.yml/, 'verifier must inspect packaged updater config');
  assert.match(verifier, /aidcpUpdateChannel/, 'verifier must inspect packaged OL channel');
  assert.match(verifier, /latest-mac\.yml/, 'verifier must inspect generated update manifest');
});

test('only eligible OL clients expose a user-triggered update check without auto-downloading', () => {
  assert.match(main, /async function checkOlUpdateManually\(\)/, 'main process owns the manual check gate');
  assert.match(main, /result\.isUpdateAvailable/, 'manual result must distinguish an available update');
  assert.match(main, /label: '检查更新'/, 'eligible tray menu must expose manual check');
  assert.match(main, /ipcMain\.handle\('update:check'/, 'renderer must not access updater directly');
  assert.match(preload, /checkForUpdate: \(\) => ipcRenderer\.invoke\('update:check'\)/, 'preload exposes a narrow manual-check IPC');
  assert.match(html, /id="ol-update-check"/, 'settings drawer must contain the visible manual check button');
  assert.match(renderer, /loadOlUpdateManualControl/, 'unsupported clients must keep the settings card hidden');
  assert.match(renderer, /正在检查更新/, 'manual click must show progress rather than silently doing nothing');
});
