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

test('browser persona notice uses the routed environment label and stable de-duplication key', () => {
  const first = notice.browserPersonaNoticeForStatus({ auth: 'logged in', cloud: 'connected', personaBound: false }, '  环境   B  ');
  const second = notice.browserPersonaNoticeForStatus({ auth: 'logged in', cloud: 'connected', personaBound: false }, '环境 B');
  assert.deepEqual(first, { active: true, accountLabel: '环境 B' });
  assert.equal(notice.browserPersonaNoticeKey(first), notice.browserPersonaNoticeKey(second));
  assert.notEqual(notice.browserPersonaNoticeKey(first), notice.browserPersonaNoticeKey({ active: false }));
});
