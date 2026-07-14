import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookInlineReader } from '../../src/facebook/inline-reader.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../../src/browse/overlay-monitor.js';

/**
 * feed 就地深读（change facebook-feed-inline-browse / surface:'feed'）：按命令帖身份三段式锁卡、
 * textContent 捷径 / 点锚定展开读全文、环境变化诚实回落、点了展开没变长诚实 expand_no_effect。
 */

/** 按 inline IIFE 阶段（inline-resolve / inline-expand / inline-read / inline-cleartag）返回预置 JSON 的 CDP 桩。 */
function fakeCdp(phases: {
  resolve?: unknown;
  expand?: unknown;
  read?: unknown | unknown[];
  onEval?: (expr: string) => void;
}): BrowseCdp {
  let readCall = 0;
  const pick = (v: unknown | unknown[], i: number): unknown => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params?.expression ?? '');
      phases.onEval?.(expr);
      let value: unknown = {};
      if (expr.includes('/*aidcp:inline-resolve*/')) value = phases.resolve ?? { status: 'no_target' };
      else if (expr.includes('/*aidcp:inline-expand*/')) value = phases.expand ?? { found: true, clicked: true };
      else if (expr.includes('/*aidcp:inline-read*/')) value = pick(phases.read ?? { found: false }, readCall++);
      else if (expr.includes('/*aidcp:inline-cleartag*/')) value = { cleared: true };
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

const noSleep = { sleep: async () => {} };
const fastOpts = { settleMs: 0, expandPollRounds: 2, expandPollMs: 0 };
const NOTE = 'https://www.facebook.com/groups/111/posts/AAA/';
const PERMS = ['https://www.facebook.com/groups/111/posts/AAA/'];
const CTX = { href: 'https://www.facebook.com/', dialogCount: 0, articleIndex: 0, postId: 'fb:AAA' };

test('fb-inline: textContent 捷径（远大于 innerText）→ 不点展开、正文=textContent', async () => {
  let expandCalled = false;
  const cdp = fakeCdp({
    resolve: {
      status: 'ok',
      ...CTX,
      permalinkHrefs: PERMS,
      textContentLen: 200,
      innerTextLen: 80,
      hasExpandControl: true, // 有控件但捷径优先，不该点
      bodyInner: 'folded head',
      bodyFull: 'the full long body already hidden in DOM',
      author: '大白',
      reactionText: '3,829',
      isVideo: false,
    },
    read: { found: true, ...CTX, permalinkHrefs: PERMS, innerTextLen: 80, bodyInner: 'folded head', bodyFull: 'the full long body already hidden in DOM' },
    onEval: (e) => {
      if (e.includes('/*aidcp:inline-expand*/')) expandCalled = true;
    },
  });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.ok, true);
  assert.equal(expandCalled, false, '捷径命中时绝不点展开');
  assert.equal(r.body, 'the full long body already hidden in DOM');
  assert.equal(r.author, '大白');
  assert.equal(r.reactionCount, 3829);
  // permalink 经 normalizeFacebookPermalinks 归一（去尾斜杠等）——页面派生的 noteId 走同一归一。
  assert.equal(r.permalinkHref, 'https://www.facebook.com/groups/111/posts/AAA');
});

test('fb-inline: 折叠帖点展开 → 正文变长 → ok，正文=展开后 innerText', async () => {
  let expandCalled = false;
  const cdp = fakeCdp({
    resolve: {
      status: 'ok',
      ...CTX,
      permalinkHrefs: PERMS,
      textContentLen: 80,
      innerTextLen: 78, // ≈ innerText，非捷径
      hasExpandControl: true,
      bodyInner: 'folded head…',
    },
    expand: { found: true, clicked: true },
    read: [
      { found: true, ...CTX, permalinkHrefs: PERMS, innerTextLen: 78, bodyInner: 'folded head…' }, // 尚未变长
      { found: true, ...CTX, permalinkHrefs: PERMS, innerTextLen: 300, bodyInner: 'the full expanded body text' },
    ],
    onEval: (e) => {
      if (e.includes('/*aidcp:inline-expand*/')) expandCalled = true;
    },
  });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.ok, true);
  assert.equal(expandCalled, true, '折叠帖必须点展开');
  assert.equal(r.body, 'the full expanded body text');
});

test('fb-inline: 点了展开但正文未变长 → expand_no_effect（不当成功）', async () => {
  const cdp = fakeCdp({
    resolve: { status: 'ok', ...CTX, permalinkHrefs: PERMS, textContentLen: 80, innerTextLen: 78, hasExpandControl: true, bodyInner: 'head' },
    expand: { found: true, clicked: true },
    read: { found: true, ...CTX, permalinkHrefs: PERMS, innerTextLen: 78, bodyInner: 'head' }, // 恒不变长
  });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expand_no_effect');
});

test('fb-inline: 短帖无展开控件 → 正常成功（读到什么算什么，非 no_target）', async () => {
  const cdp = fakeCdp({
    resolve: { status: 'ok', ...CTX, permalinkHrefs: PERMS, textContentLen: 50, innerTextLen: 50, hasExpandControl: false, bodyInner: 'a short post' },
    read: { found: true, ...CTX, permalinkHrefs: PERMS, innerTextLen: 50, bodyInner: 'a short post' },
  });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.ok, true);
  assert.equal(r.body, 'a short post');
});

test('fb-inline: 展开前后环境变化（href 变）→ context_changed（回落 detail 的信号）', async () => {
  const cdp = fakeCdp({
    resolve: { status: 'ok', ...CTX, permalinkHrefs: PERMS, textContentLen: 60, innerTextLen: 60, hasExpandControl: false, bodyInner: 'x' },
    read: { found: true, ...CTX, href: 'https://www.facebook.com/posts/AAA/', permalinkHrefs: PERMS, innerTextLen: 60, bodyInner: 'x' },
  });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'context_changed');
});

test('fb-inline: 卡索引漂移 → context_changed', async () => {
  const cdp = fakeCdp({
    resolve: { status: 'ok', ...CTX, permalinkHrefs: PERMS, textContentLen: 60, innerTextLen: 60, hasExpandControl: false, bodyInner: 'x' },
    read: { found: true, ...CTX, articleIndex: 2, permalinkHrefs: PERMS, innerTextLen: 60, bodyInner: 'x' },
  });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.reason, 'context_changed');
});

test('fb-inline: 读取时目标卡从 DOM 消失 → stale', async () => {
  const cdp = fakeCdp({
    resolve: { status: 'ok', ...CTX, permalinkHrefs: PERMS, textContentLen: 60, innerTextLen: 60, hasExpandControl: false, bodyInner: 'x' },
    read: { found: false },
  });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.reason, 'stale');
});

test('fb-inline: 解析不到目标 → no_target', async () => {
  const cdp = fakeCdp({ resolve: { status: 'no_target' } });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.reason, 'no_target');
});

test('fb-inline: 同身份 >1 张卡 → ambiguous_target', async () => {
  const cdp = fakeCdp({ resolve: { status: 'ambiguous_target' } });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.reason, 'ambiguous_target');
});

test('fb-inline: noteId 派生不出规范身份 → no_target（绝不读第一张）', async () => {
  const cdp = fakeCdp({ resolve: { status: 'ok' } });
  const reader = new FacebookInlineReader({ cdp, ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline('not-a-facebook-post-link');
  assert.equal(r.reason, 'no_target');
});

test('fb-inline: 读取前复检到验证码 → blocked_by_captcha（fail-closed，不读）', async () => {
  const cdp = fakeCdp({ resolve: { status: 'ok', ...CTX } });
  const reader = new FacebookInlineReader({ cdp, overlayMonitor: fakeMonitor('captcha'), ...noSleep }, fastOpts);
  const r = await reader.openAndReadInline(NOTE);
  assert.equal(r.reason, 'blocked_by_captcha');
});
