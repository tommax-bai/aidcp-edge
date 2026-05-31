import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('getVisibleCards: 非数组返回时降级为空数组', async () => {
  const { cdp } = fakeCdp(() => ({ result: { type: 'string', value: '"oops"' } }));
  const scroller = new CdpFeedScroller(cdp);
  const cards = await scroller.getVisibleCards();
  assert.deepEqual(cards, []);
});

test('scrollNext: 惯性序列多帧 window.scrollBy（加速→减速）', async () => {
  const exprs: string[] = [];
  const { cdp } = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') exprs.push(String(params.expression));
    return { result: { type: 'boolean', value: true } };
  });
  const scroller = new CdpFeedScroller(cdp, {
    random: () => 0.5,
    scrollDistancePx: 800,
    sleep: async () => {},
  });
  await scroller.scrollNext();
  // 惯性序列应为 8–15 帧，全部走 window.scrollBy
  assert.ok(exprs.length >= 8 && exprs.length <= 15, `帧数应在 8–15，实际 ${exprs.length}`);
  for (const e of exprs) assert.match(e, /window\.scrollBy/);
  // 解析每帧 deltaY，验证总和为正（向下滚）且呈先增后减
  const deltas = exprs.map((e) => {
    const m = e.match(/scrollBy\(0,\s*(-?\d+)\)/);
    return m ? Number(m[1]) : 0;
  });
  const sum = deltas.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0, '总位移向下');
  const peak = Math.max(...deltas);
  assert.ok(deltas[0] < peak, '首帧小于峰值（加速）');
  assert.ok(deltas[deltas.length - 1] < peak, '末帧小于峰值（减速）');
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
