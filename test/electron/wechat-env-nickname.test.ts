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
});
