import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const notice = require('../../src/electron/persona-notice.cjs') as {
  browserPersonaNoticeForStatus: (status: Record<string, unknown>, envName?: string) => { active: boolean; accountLabel?: string };
  browserPersonaNoticeKey: (value: { active: boolean; accountLabel?: string }) => string;
};

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
