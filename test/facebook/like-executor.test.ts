import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FacebookLikeExecutor } from '../../src/facebook/like-executor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../../src/browse/overlay-monitor.js';

/**
 * 按 in-page 脚本阶段（LOCATE / CLICK / VERIFY）返回预置 JSON 的 CDP 桩。
 * 判据：CLICK 脚本含 `.click()`；LOCATE 含 `already:`；其余为 VERIFY。
 */
function fakeCdp(phases: {
  locate: unknown;
  click?: unknown;
  verify?: unknown | unknown[];
}): BrowseCdp {
  let verifyCall = 0;
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params?.expression ?? '');
      let value: unknown;
      if (expr.includes('.click()')) value = phases.click ?? { clicked: true };
      else if (expr.includes('already:')) value = phases.locate;
      else {
        const v = phases.verify;
        value = Array.isArray(v) ? v[Math.min(verifyCall++, v.length - 1)] : v;
      }
      return { result: { value: JSON.stringify(value) } } as never;
    },
  };
}

function fakeMonitor(kind: OverlayKind): OverlayMonitor {
  return {
    get state() {
      return kind;
    },
    probeNow: async () => kind,
    start: () => {},
    stop: () => {},
    tick: async () => {},
  } as unknown as OverlayMonitor;
}

const fastOpts = { verifyTimeoutMs: 60, verifyPollMs: 5, settleMs: 0 };
const noSleep = { sleep: async () => {} };

test('fb-like: 按钮状态真翻转 → ok:true + executed', async () => {
  const cdp = fakeCdp({
    locate: { found: true, already: false, label: '留下心情', text: '' },
    click: { clicked: true },
    verify: { found: true, reacted: true, label: '留下心情', text: '赞' },
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like();
  assert.equal(r.ok, true);
  assert.equal(r.executed, true);
  assert.equal(r.reason, undefined);
});

test('fb-like: 找不到帖级 react 按钮 → no_target（绝不假成功）', async () => {
  const cdp = fakeCdp({ locate: { found: false, already: false } });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_target');
  assert.equal(r.executed, false);
});

test('fb-like: 已赞 → already_liked（不重复点、不执行）', async () => {
  const cdp = fakeCdp({ locate: { found: true, already: true, label: '取消赞', text: '赞' } });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_liked');
  assert.equal(r.executed, false);
});

test('fb-like: 点击后状态未翻转 → state_unchanged（诚实，绝不假成功）', async () => {
  const cdp = fakeCdp({
    locate: { found: true, already: false, label: '留下心情', text: '' },
    click: { clicked: true },
    verify: { found: true, reacted: false, label: '留下心情', text: '' }, // 一直未翻转
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state_unchanged');
  assert.equal(r.executed, true); // 点了但没生效——诚实回报「执行过但未变」
});

test('fb-like: 点击前复检到验证码 → blocked_by_captcha，不点击', async () => {
  const cdp = fakeCdp({
    locate: { found: true, already: false, label: '留下心情', text: '' },
    click: { clicked: true },
    verify: { found: true, reacted: true },
  });
  const exec = new FacebookLikeExecutor({ cdp, overlayMonitor: fakeMonitor('captcha'), ...noSleep }, fastOpts);
  const r = await exec.like();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked_by_captcha');
  assert.equal(r.executed, false);
});

test('fb-like[shadow]: 目标存在但只记不执行 → shadow（executed=false，云端不记账）', async () => {
  let clicked = false;
  const base = fakeCdp({
    locate: { found: true, already: false, label: '留下心情', text: '' },
    click: { clicked: true },
    verify: { found: true, reacted: true },
  });
  const cdp: BrowseCdp = {
    send: async (m, p) => {
      if (String(p?.expression ?? '').includes('.click()')) clicked = true;
      return base.send(m, p);
    },
  };
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ shadow: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'shadow');
  assert.equal(r.executed, false);
  assert.equal(clicked, false, 'shadow 模式绝不派发点击');
});

test('fb-like[shadow]: 目标不存在 → 仍诚实 no_target（不冒充 shadow 成功）', async () => {
  const cdp = fakeCdp({ locate: { found: false, already: false } });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ shadow: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_target');
});

// ─── jsdom：对真实动作栏 DOM 跑 in-page 定位/点击/校验 IIFE（不桩 JSON 边界，验 reactState 真逻辑）───
// 回归：反应【计数汇总】按钮（aria-label=赞 + 数字文案，DOM 序在 留下心情 toggle 之前）绝不被误当已赞 toggle。

/** 构造 FB 帖级动作栏 DOM（dialog>article>action-bar：计数汇总 / 留下心情 toggle / 发表评论 / 分享）。 */
function buildActionBarDom(opts: { withToggle?: boolean; reactionText?: string } = {}): JSDOM {
  const toggle = opts.withToggle === false ? '' : '<div role="button" aria-label="留下心情"></div>';
  const dom = new JSDOM(
    '<!doctype html><html><body><div role="dialog"><div role="article">' +
      '<div class="action-bar">' +
      `<div role="button" aria-label="赞">${opts.reactionText ?? '3,829'}</div>` + // 计数汇总（非 toggle）
      toggle + // 留下心情 toggle（可选）
      '<div role="button" aria-label="发表评论">66</div>' +
      '<div role="button" aria-label="发送给好友或发布到你的个人主页。">12</div>' +
      '</div></div></div></body></html>',
    { runScripts: 'outside-only' },
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { left: 10, top: 100, right: 60, bottom: 130, width: 50, height: 30 };
    },
  });
  return dom;
}

function jsdomCdp(dom: JSDOM): BrowseCdp {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const value = dom.window.eval(String(params?.expression ?? ''));
      return { result: { value: typeof value === 'string' ? value : JSON.stringify(value) } } as never;
    },
  };
}

test('fb-like[jsdom]: 选中 留下心情 toggle（非「赞」计数汇总按钮），点击→翻转→ok', async () => {
  const dom = buildActionBarDom();
  // 模拟 FB：点 toggle 后其空文案变为反应词「赞」（已赞态）。
  const toggle = dom.window.document.querySelector('[aria-label="留下心情"]') as HTMLElement;
  toggle.addEventListener('click', () => {
    toggle.textContent = '赞';
  });
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like();
  assert.equal(r.ok, true, 'toggle 真翻转 → ok');
  assert.equal(r.executed, true);
  // 计数汇总按钮文案不变（证明点的是 toggle 不是计数按钮）。
  assert.equal(dom.window.document.querySelector('[aria-label="赞"]')?.textContent, '3,829');
});

test('fb-like[jsdom]: 已有反应但本号未赞 → 找到真 toggle 而非误报 already_liked（critical 回归）', async () => {
  const dom = buildActionBarDom({ reactionText: '10,532' }); // 帖子已有 1 万+ 反应
  const toggle = dom.window.document.querySelector('[aria-label="留下心情"]') as HTMLElement;
  toggle.addEventListener('click', () => {
    toggle.textContent = '赞';
  });
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like();
  // 修复前：会把「赞 10,532」计数按钮当已赞 → already_liked、永不点击。修复后：找到真 toggle → 点赞成功。
  assert.equal(r.reason, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.executed, true);
});

test('fb-like[jsdom]: 只有「赞」计数汇总按钮、无 toggle → no_target（绝不把计数按钮当 toggle 点）', async () => {
  const dom = buildActionBarDom({ withToggle: false });
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_target');
  assert.equal(r.executed, false);
});
