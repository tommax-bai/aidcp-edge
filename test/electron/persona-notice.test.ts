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
    facebookRuleMode?: unknown,
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

// ── change facebook-rule-mode-without-persona：规则模式免人设的受控页横幅 ──
// 未绑人设的 Facebook 账号若其环境已启用规则模式，「没有人设」是它的正常运行态，不是待办：
// 横幅会让运营去补一份规则模式根本不读的配置。判据只认已读到的云端权威配置。

const unboundFacebook = {
  auth: 'logged in',
  cloud: 'connected',
  personaBound: false,
  account: { name: 'FB 账号' },
};
const facebookEnv = { envId: 'ads-fb', name: 'FB 环境', platform: 'facebook' };

test('browser persona notice stays silent for an unbound Facebook account under rule mode', () => {
  assert.deepEqual(
    notice.browserPersonaNoticeForStatus(unboundFacebook, facebookEnv, { platform: 'facebook', enabled: true }),
    { active: false },
  );
});

test('browser persona notice keeps firing when rule mode is off, unread or for another platform', () => {
  // 规则模式关闭：逐字保持既有横幅。
  assert.equal(
    notice.browserPersonaNoticeForStatus(unboundFacebook, facebookEnv, { platform: 'facebook', enabled: false }).active,
    true,
  );
  // 读不到 / 回包不完整 / 还没读：fail-closed 回既有横幅，MUST NOT 猜成已启用。
  for (const fact of [null, undefined, {}, { platform: 'facebook' }, { platform: 'facebook', enabled: 'true' }]) {
    assert.equal(
      notice.browserPersonaNoticeForStatus(unboundFacebook, facebookEnv, fact).active,
      true,
      `未读到的规则模式事实 ${JSON.stringify(fact)} 不得静默横幅`,
    );
  }
  // 例外不外溢到别的平台：即便传进来一份 enabled 的事实，平台没确认为 Facebook 就不成立。
  assert.equal(
    notice.browserPersonaNoticeForStatus(
      unboundFacebook,
      { envId: 'ads-p1', name: '小红书环境', platform: 'xiaohongshu' },
      { platform: 'xiaohongshu', enabled: true },
    ).active,
    true,
  );
});

test('browser persona notice keeps the bound and unknown states untouched under rule mode', () => {
  const ruleMode = { platform: 'facebook', enabled: true };
  // 已绑：本来就不提示，规则模式不改变这一点。
  assert.deepEqual(
    notice.browserPersonaNoticeForStatus({ ...unboundFacebook, personaBound: true }, facebookEnv, ruleMode),
    { active: false },
  );
  // 未知：三态判例不受影响，仍然不提示（而且不是因为规则模式）。
  assert.deepEqual(
    notice.browserPersonaNoticeForStatus({ ...unboundFacebook, personaBound: null }, facebookEnv, ruleMode),
    { active: false },
  );
  assert.deepEqual(
    notice.browserPersonaNoticeForStatus({ ...unboundFacebook, personaBound: null }, facebookEnv),
    { active: false },
  );
});
