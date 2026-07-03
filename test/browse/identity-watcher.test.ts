import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityWatcher, type IdentityHealth } from '../../src/browse/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { PageContext } from '../../src/cdp/index.js';

const ID_A = '63e2ff0500000000260049ce'; // 基线
const ID_B = 'a1b2c3d4e5f60718293a4b5c'; // 换成别的号

/**
 * 页面上下文（`ctx`，默认消费端）与正向登出信号（`loggedOut`，默认 true=有登录浮层）经注入喂给 watcher；
 * 锚点 `anchorHref` 经假 CDP 的就地扫描回给 readSelfIdentity。可在 check 之间改 holder 三者。
 */
type Holder = { anchorHref: string | null; ctx?: PageContext; loggedOut?: boolean };

/** 假 CDP：就地扫描返回 holder.anchorHref 当头像祖先锚点；display 固定。 */
function fakeCdp(holder: Holder): BrowseCdp {
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

function makeWatcher(holder: Holder, threshold = 2) {
  const transitions: Array<[IdentityHealth, IdentityHealth]> = [];
  const w = new IdentityWatcher(fakeCdp(holder), ID_A, {
    threshold,
    ...noTimer,
    pageContext: async () => holder.ctx ?? 'consumer',
    confirmLoggedOut: async () => holder.loggedOut ?? true,
  });
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

// —— 页面上下文分域判定（change identity-recheck-page-context-guard）——

test('IdentityWatcher: 停在创作发布页（creator-app）→ 判健康、绝不误杀（即便无消费端锚点）', async () => {
  // 发布把标签页带到 creator.xiaohongshu.com/publish/publish：无「我」锚点但登录门禁=已登录。
  const holder: Holder = { anchorHref: null, ctx: 'creator-app' };
  const { w, transitions } = makeWatcher(holder, 2);
  await w.check();
  await w.check();
  assert.equal(transitions.length, 0); // 不退回无身份态
});

test('IdentityWatcher: 创作子域被弹到登录页（creator-login）→ 判 lost', async () => {
  const holder: Holder = { anchorHref: null, ctx: 'creator-login' };
  const { w, transitions } = makeWatcher(holder, 2);
  await w.check(); // 1/2
  await w.check(); // 2/2 → 触发
  assert.deepEqual(transitions, [['healthy', 'invalid']]);
  assert.deepEqual(w.lastReason, { kind: 'lost' });
});

test('IdentityWatcher: 无法判定页（unknown，about:blank/非小红书）→ 本轮跳过，不计失效', async () => {
  const holder: Holder = { anchorHref: null, ctx: 'unknown' };
  const { w, transitions } = makeWatcher(holder, 2);
  await w.check();
  await w.check();
  assert.equal(transitions.length, 0);
});

test('IdentityWatcher: 消费页无本人锚点但无登录浮层 → 无法确认、跳过（不误杀 AI 搜索/看图态）', async () => {
  const holder: Holder = { anchorHref: null, ctx: 'consumer', loggedOut: false };
  const { w, transitions } = makeWatcher(holder, 2);
  await w.check();
  await w.check();
  assert.equal(transitions.length, 0); // inconclusive：既不判 lost 也不误杀
});

test('IdentityWatcher: 消费页无本人锚点且有登录浮层 → 真登出判 lost（分域闸不漏判）', async () => {
  const holder: Holder = { anchorHref: null, ctx: 'consumer', loggedOut: true };
  const { w, transitions } = makeWatcher(holder, 2);
  await w.check(); // 1/2
  await w.check(); // 2/2
  assert.deepEqual(transitions, [['healthy', 'invalid']]);
  assert.deepEqual(w.lastReason, { kind: 'lost' });
});

test('IdentityWatcher: 创作发布页穿插在消费页失效计数间 → 清零，防止跨页凑够阈值', async () => {
  // 模拟真实事故序列：消费页偶发读空(1/2) → 发布跳创作页(健康清零) → 回消费页再读空(1/2)，绝不凑成 2/2。
  const holder: Holder = { anchorHref: null, ctx: 'consumer', loggedOut: true };
  const { w, transitions } = makeWatcher(holder, 2);
  await w.check(); // consumer 无锚点+登录浮层 → lost 1/2
  assert.equal(transitions.length, 0);
  holder.ctx = 'creator-app'; // 发布把页带到创作发布页
  await w.check(); // creator-app → 健康、清零
  holder.ctx = 'consumer';
  await w.check(); // 又 1/2（清零后重新计），未到阈值
  assert.equal(transitions.length, 0);
});

test('IdentityWatcher: inconclusive 跳过后回消费页仍能正常判定（换号达阈值）', async () => {
  const holder: Holder = { anchorHref: null, ctx: 'unknown' };
  const { w, transitions } = makeWatcher(holder, 2);
  await w.check(); // unknown → 跳过
  holder.ctx = 'consumer';
  holder.anchorHref = `/user/profile/${ID_B}`; // 回消费页、读出别的号
  await w.check(); // changed 1/2
  await w.check(); // changed 2/2 → 触发
  assert.deepEqual(transitions, [['healthy', 'invalid']]);
  assert.deepEqual(w.lastReason, { kind: 'changed', newId: ID_B });
});
