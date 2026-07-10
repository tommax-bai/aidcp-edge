import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denyPermissionPrompts } from '../../src/cdp/index.js';

// 记录型 fake CDP：登记每次 send；failOn 指定某权限名时该次 send 抛错，用于验 best-effort。
function recordingCdp(failOn?: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (failOn && (params.permission as { name?: string } | undefined)?.name === failOn) {
        throw new Error(`setPermission unsupported: ${failOn}`);
      }
      return {};
    },
  };
  return { cdp: cdp as never, calls };
}

test('denyPermissionPrompts 把常见弹窗权限一律置 denied（省略 origin ⇒ 全 origin 生效）', async () => {
  const { cdp, calls } = recordingCdp();
  await denyPermissionPrompts(cdp);
  const perms = calls
    .filter((c) => c.method === 'Browser.setPermission')
    .map((c) => ({
      name: (c.params.permission as { name: string }).name,
      setting: c.params.setting,
      origin: c.params.origin,
    }));
  assert.deepEqual(
    perms.map((p) => p.name),
    ['notifications', 'geolocation', 'camera', 'microphone'],
  );
  assert.ok(
    perms.every((p) => p.setting === 'denied'),
    '每项设置必须是 denied（不是 grant/prompt）',
  );
  assert.ok(
    perms.every((p) => p.origin === undefined),
    '必须省略 origin，否则只对单一 origin 生效',
  );
});

test('denyPermissionPrompts best-effort：某权限名不被内核接受而 reject 时不抛、其余照常下发', async () => {
  const { cdp, calls } = recordingCdp('camera');
  await assert.doesNotReject(() => denyPermissionPrompts(cdp));
  const names = calls
    .filter((c) => c.method === 'Browser.setPermission')
    .map((c) => (c.params.permission as { name: string }).name);
  // 即便 camera 那次 reject，microphone 仍被尝试——单点失败不中断整轮，attach 不受影响。
  assert.deepEqual(names, ['notifications', 'geolocation', 'camera', 'microphone']);
});
