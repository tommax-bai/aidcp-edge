import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');

test('preload uses two named environment-risk IPC methods', () => {
  assert.match(preload, /getEnvironmentRisk:\s*\(args\)\s*=>\s*ipcRenderer\.invoke\('environment-risk:get',\s*args\)/);
  assert.match(preload, /recoverEnvironmentRisk:\s*\(args\)\s*=>\s*ipcRenderer\.invoke\('environment-risk:recover',\s*args\)/);
});

test('main risk IPC accepts only envKey and fixes Cloud route/method/body', () => {
  const getBlock = main.match(/ipcMain\.handle\('environment-risk:get',[\s\S]*?\n\}\)\);/)?.[0] ?? '';
  const recoverBlock = main.match(/ipcMain\.handle\('environment-risk:recover',[\s\S]*?\n\}\)\);/)?.[0] ?? '';
  assert.ok(getBlock && recoverBlock, '两个具名 handler 必须存在');
  for (const block of [getBlock, recoverBlock]) {
    assert.match(block, /interactionArgs\(raw,\s*new Set\(\['envKey'\]\)\)/);
    assert.doesNotMatch(block, /args\.(accountId|kind|status|reason)/, 'renderer 不得选择账号、风险信号、状态或理由');
  }
  assert.match(getBlock, /pathname:\s*`\/environments\/\$\{encodeURIComponent\(envKey\)\}\/risk-state`/);
  assert.match(getBlock, /method:\s*'GET'/);
  assert.match(recoverBlock, /pathname:\s*`\/environments\/\$\{encodeURIComponent\(envKey\)\}\/risk-state\/recover`/);
  assert.match(recoverBlock, /method:\s*'POST'/);
  assert.match(recoverBlock, /body:\s*\{\}/);
});

test('successful customer response still passes the shared envKey scope guard', () => {
  assert.match(
    main,
    /if\s*\(result\.ok\)[\s\S]*?responseEnvKey\s*!==\s*envKey[\s\S]*?INTERACTION_SCOPE_MISMATCH/,
    'risk routes reuse interactionCustomerRequest, so a mismatched success response is refused before renderer',
  );
});
