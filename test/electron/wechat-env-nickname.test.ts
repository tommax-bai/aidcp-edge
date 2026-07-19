import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');

test('Electron identity bridge keeps the real platform source and reuses the existing nickname rename path', () => {
  const start = main.indexOf('if (evt.account) {');
  const end = main.indexOf('// 人设绑定态', start);
  assert.ok(start >= 0 && end > start, 'identity event branch must remain present');
  const branch = main.slice(start, end);

  assert.match(branch, /source: evt\.account\.name \? fleet\.nicknameSourceForPlatform\(handle\.platform\) : 'env'/);
  assert.match(branch, /if \(evt\.account\.name\) maybeRenameEnvToNickname\(handle, evt\.account\.name\)/);

  const helperStart = main.indexOf('async function maybeRenameEnvToNickname');
  const helperEnd = main.indexOf('function makeStatus', helperStart);
  const helper = main.slice(helperStart, helperEnd);
  assert.match(helper, /if \(handle\.nameSource === 'manual'\) return;/, '人工昵称必须在任何 AdsPower 自动改名前 fail closed');
  assert.match(main, /nameSource: env\.nameSource/, '花名册人工来源必须进入环境 handle');
  assert.match(main, /nameSource: h\.nameSource/, '人工来源必须随 fleet snapshot 回到 renderer');
});
