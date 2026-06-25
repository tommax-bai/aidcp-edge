import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityWatcher, type IdentityHealth } from '../../src/browse/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

const ID_A = '63e2ff0500000000260049ce'; // 基线
const ID_B = 'a1b2c3d4e5f60718293a4b5c'; // 换成别的号

/** 假 CDP：就地扫描返回 holder.anchorHref 当头像祖先锚点；display 固定。可在 check 之间改 holder。 */
function fakeCdp(holder: { anchorHref: string | null }): BrowseCdp {
  const send = async (_m: string, params?: Record<string, unknown>) => {
    const e = String((params as { expression?: string } | undefined)?.expression ?? '');
    let value: unknown = '';
    if (e.includes('avatarAnchorHref')) {
      value = JSON.stringify({ href: '/explore', avatarAnchorHref: holder.anchorHref, navProfileHrefs: [], nickname: null, redId: null });
    } else if (e.includes('小红书号')) {
      value = JSON.stringify({ nickname: null, redId: null });
    }
    return { result: { value } };
  };
  return { send } as unknown as BrowseCdp;
}

const noTimer = { setTimer: () => 0 as unknown as ReturnType<typeof setInterval>, clearTimer: () => undefined };

function makeWatcher(holder: { anchorHref: string | null }, threshold = 2) {
  const transitions: Array<[IdentityHealth, IdentityHealth]> = [];
  const w = new IdentityWatcher(fakeCdp(holder), ID_A, { threshold, ...noTimer });
  w.start((from, to) => transitions.push([from, to]));
  return { w, transitions };
}

test('IdentityWatcher: 读出基线 id → 健康，不转移', async () => {
  const holder: { anchorHref: string | null } = { anchorHref: `/user/profile/${ID_A}` };
  const { w, transitions } = makeWatcher(holder);
  await w.check();
  await w.check();
  assert.equal(transitions.length, 0);
});

test('IdentityWatcher: 换号需连续达阈值才判失效（防抖）', async () => {
  const holder: { anchorHref: string | null } = { anchorHref: `/user/profile/${ID_A}` };
  const { w, transitions } = makeWatcher(holder, 2);
  holder.anchorHref = `/user/profile/${ID_B}`;
  await w.check(); // 1/2
  assert.equal(transitions.length, 0);
  await w.check(); // 2/2 → 触发
  assert.deepEqual(transitions, [['healthy', 'invalid']]);
  assert.deepEqual(w.lastReason, { kind: 'changed', newId: ID_B });
});

test('IdentityWatcher: 中途恢复基线 → 计数清零、不误触发', async () => {
  const holder: { anchorHref: string | null } = { anchorHref: `/user/profile/${ID_B}` };
  const { w, transitions } = makeWatcher(holder, 2);
  await w.check(); // 1/2 (changed)
  holder.anchorHref = `/user/profile/${ID_A}`; // 恢复
  await w.check(); // 健康，清零
  holder.anchorHref = `/user/profile/${ID_B}`;
  await w.check(); // 1/2 again，未到阈值
  assert.equal(transitions.length, 0);
});

test('IdentityWatcher: 读不出 id（登出/过期）连续达阈值 → lost', async () => {
  const holder: { anchorHref: string | null } = { anchorHref: `/user/profile/${ID_A}` };
  const { w, transitions } = makeWatcher(holder, 2);
  holder.anchorHref = null; // 读不出
  await w.check();
  await w.check();
  assert.deepEqual(transitions, [['healthy', 'invalid']]);
  assert.deepEqual(w.lastReason, { kind: 'lost' });
});

test('IdentityWatcher: 判失效后不再重复转移', async () => {
  const holder: { anchorHref: string | null } = { anchorHref: null };
  const { w, transitions } = makeWatcher(holder, 1);
  await w.check(); // 阈值1 → 立即触发
  await w.check();
  await w.check();
  assert.equal(transitions.length, 1);
});

test('IdentityWatcher: rebaseline 复位为健康、换新基线', async () => {
  const holder: { anchorHref: string | null } = { anchorHref: null };
  const { w, transitions } = makeWatcher(holder, 1);
  await w.check(); // invalid (lost)
  assert.equal(transitions.length, 1);
  // 身份重新确立为 ID_B 后 rebaseline
  holder.anchorHref = `/user/profile/${ID_B}`;
  w.rebaseline(ID_B);
  await w.check(); // 新基线 == 读出 → 健康，不再转移
  assert.equal(transitions.length, 1);
});
