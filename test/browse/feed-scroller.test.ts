import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CdpFeedScroller, type NoteCard } from '../../src/browse/feed-scroller.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

/** 假 CDP：记录调用并按 method 返回预设 */
function fakeCdp(handler: (method: string, params: Record<string, unknown>) => unknown): {
  cdp: BrowseCdp;
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const cdp: BrowseCdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return handler(method, params) as never;
    },
  };
  return { cdp, calls };
}

const CARDS: NoteCard[] = [
  { position: 0, centerX: 100, centerY: 200, title: 'A', author: 'u1', likes: '1.2w' },
  { position: 1, centerX: 300, centerY: 200, title: 'B', author: 'u2' },
];

test('getVisibleCards: 解析浏览器侧返回的 JSON 卡片清单', async () => {
  const { cdp } = fakeCdp((method) => {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { type: 'string', value: JSON.stringify(CARDS) } };
  });
  const scroller = new CdpFeedScroller(cdp);
  const cards = await scroller.getVisibleCards();
  assert.equal(cards.length, 2);
  assert.equal(cards[0].title, 'A');
  assert.equal(cards[1].centerX, 300);
});

test('getVisibleCards: 从包裹卡片元素的祖先链接解析 noteId', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<a href="/explore/target123?xsec_token=t">' +
        '<section class="note-item">' +
          '<img src="https://example.test/a.jpg">' +
          '<div class="title">目标标题</div>' +
          '<div class="author">作者</div>' +
        '</section>' +
      '</a>' +
    '</body></html>',
    { runScripts: 'outside-only' },
  );
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { left: 10, top: 100, right: 210, bottom: 300, width: 200, height: 200 };
    },
  });

  const { cdp } = fakeCdp((method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    const value = dom.window.eval(String(params.expression ?? ''));
    return { result: { type: 'string', value } };
  });
  const scroller = new CdpFeedScroller(cdp);
  const cards = await scroller.getVisibleCards();
  assert.equal(cards[0].noteId, 'target123');
});

test('getVisibleCards: 非数组返回时降级为空数组', async () => {
  const { cdp } = fakeCdp(() => ({ result: { type: 'string', value: '"oops"' } }));
  const scroller = new CdpFeedScroller(cdp);
  const cards = await scroller.getVisibleCards();
  assert.deepEqual(cards, []);
});

test('scrollNext: 惯性序列多帧真实 mouseWheel（加速→减速，两布局通吃）', async () => {
  // 新机制：CDP 真实 mouseWheel 在 feed 中心派发（取代旧 window.scrollBy，后者在 document 不可滚的
  // 窄布局上 no-op；见 docs/xhs-layout-states.md）。仅一次 Runtime.evaluate 读 viewport。
  const { cdp, calls } = fakeCdp((method) => {
    if (method === 'Runtime.evaluate') return { result: { type: 'object', value: { w: 1280, h: 800 } } };
    return { result: { value: true } };
  });
  const scroller = new CdpFeedScroller(cdp, {
    random: () => 0.5,
    scrollDistancePx: 800,
    sleep: async () => {},
  });
  await scroller.scrollNext();
  const wheels = calls.filter(
    (c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseWheel',
  );
  // 惯性序列应为 8–15 帧，全部走真实 mouseWheel
  assert.ok(wheels.length >= 8 && wheels.length <= 15, `帧数应在 8–15，实际 ${wheels.length}`);
  const deltas = wheels.map((c) => Number(c.params.deltaY));
  const sum = deltas.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0, '总位移向下');
  const peak = Math.max(...deltas);
  assert.ok(deltas[0] < peak, '首帧小于峰值（加速）');
  assert.ok(deltas[deltas.length - 1] < peak, '末帧小于峰值（减速）');
  // 不应再用 window.scrollBy
  const evals = calls
    .filter((c) => c.method === 'Runtime.evaluate')
    .map((c) => String(c.params.expression));
  for (const e of evals) assert.doesNotMatch(e, /window\.scrollBy/);
});

test('openCard: 沿贝塞尔轨迹移动后 press/release（非瞬移）', async () => {
  const { cdp, calls } = fakeCdp(() => ({}));
  const scroller = new CdpFeedScroller(cdp, { random: () => 0.5, sleep: async () => {} });
  await scroller.openCard(CARDS[0]);
  const mouse = calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
  const moves = mouse.filter((c) => c.params.type === 'mouseMoved');
  // 真人轨迹应有多个 mouseMoved（非瞬移）
  assert.ok(moves.length >= 5, `应有多帧 mouseMoved，实际 ${moves.length}`);
  const pressed = mouse.find((c) => c.params.type === 'mousePressed');
  const released = mouse.find((c) => c.params.type === 'mouseReleased');
  assert.ok(pressed, '有 mousePressed');
  assert.ok(released, '有 mouseReleased');
  // 落点应在中心附近（jitter 默认 3px；random=0.5 → 抖动量 0）
  assert.ok(Math.abs(Number(pressed?.params.x) - 100) <= 5, '落点 x 接近中心');
  assert.ok(Math.abs(Number(pressed?.params.y) - 200) <= 5, '落点 y 接近中心');
});
