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
