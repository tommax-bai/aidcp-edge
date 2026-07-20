import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const notice = require('../../src/electron/persona-notice.cjs') as {
  browserPersonaNoticeForStatus: (
    status: Record<string, unknown>,
    environment?: string | Record<string, unknown>,
  ) => { active: boolean; accountLabel?: string };
  browserPersonaNoticeKey: (value: { active: boolean; accountLabel?: string }) => string;
};

test('persona notice loads through Electron embedded Node without a tsx loader', () => {
  const electronExecutable = require('electron') as string;
  const output = execFileSync(electronExecutable, [
    '-e',
    "require('./src/electron/persona-notice.cjs'); process.stdout.write(JSON.stringify({ loaded: true, electron: process.versions.electron, node: process.versions.node }))",
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    timeout: 30_000,
  });
  const result = JSON.parse(output) as { loaded: boolean; electron: string; node: string };
  assert.equal(result.loaded, true);
  assert.match(result.electron, /^31\./);
  assert.match(result.node, /^20\./);
});

test('browser persona notice activates only for logged-in + connected + unbound status', () => {
  const active = notice.browserPersonaNoticeForStatus({
    auth: 'logged in',
    cloud: 'connected',
    personaBound: false,
    account: { name: '账号 A' },
  }, '环境 A');
  assert.deepEqual(active, { active: true, accountLabel: '账号 A' });

  assert.deepEqual(notice.browserPersonaNoticeForStatus({ auth: 'checking', cloud: 'connected', personaBound: false }, '环境 A'), { active: false });
  assert.deepEqual(notice.browserPersonaNoticeForStatus({ auth: 'logged in', cloud: 'disconnected', personaBound: false }, '环境 A'), { active: false });
  assert.deepEqual(notice.browserPersonaNoticeForStatus({ auth: 'logged in', cloud: 'connected', personaBound: true }, '环境 A'), { active: false });
});

// 三态（change persona-bound-tristate）：只有云端权威的 false 才提示；「还没收到信号」= 未知 ≠ 未绑。
test('browser persona notice never fires while the bound state is still unknown', () => {
  const base = { auth: 'logged in', cloud: 'connected', account: { name: '账号 A' } };
  assert.deepEqual(notice.browserPersonaNoticeForStatus({ ...base, personaBound: null }, '环境 A'), { active: false }, 'null=未知：绝不提示');
  assert.deepEqual(notice.browserPersonaNoticeForStatus(base, '环境 A'), { active: false }, '字段缺省=未知：绝不提示');
});

test('browser persona notice uses the routed environment label and stable de-duplication key', () => {
  const first = notice.browserPersonaNoticeForStatus({ auth: 'logged in', cloud: 'connected', personaBound: false }, '  环境   B  ');
  const second = notice.browserPersonaNoticeForStatus({ auth: 'logged in', cloud: 'connected', personaBound: false }, '环境 B');
  assert.deepEqual(first, { active: true, accountLabel: '环境 B' });
  assert.equal(notice.browserPersonaNoticeKey(first), notice.browserPersonaNoticeKey(second));
  assert.notEqual(notice.browserPersonaNoticeKey(first), notice.browserPersonaNoticeKey({ active: false }));
});

test('browser persona notice uses the same manual-first environment display-name rule', () => {
  const status = {
    auth: 'logged in',
    cloud: 'connected',
    personaBound: false,
    account: { name: 'Tianxing Bai', source: 'facebook' },
  };
  const environment = { envId: 'ads-p1', name: 'Tianxing Bai1', nameSource: 'manual' };
  assert.deepEqual(notice.browserPersonaNoticeForStatus(status, environment), {
    active: true,
    accountLabel: 'Tianxing Bai1',
  });
});
