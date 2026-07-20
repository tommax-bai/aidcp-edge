import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import { FacebookReelsReader } from '../../src/facebook/reels-reader.js';

const REEL_1 = {
  ok: true,
  noteId: 'https://www.facebook.com/reel/111',
  summary: 'Ở Trung Quốc lạ lắm mọi người ơi. #xuhuongfacebook',
  author: 'Bao',
  reactionText: '5.8K',
  videoKey: 'video-111',
};
const REEL_2 = { ...REEL_1, noteId: 'https://www.facebook.com/reel/222', summary: 'Second reel', videoKey: 'video-222' };

function scriptedCdp(options: {
  probes?: unknown[];
  likeTarget?: unknown;
  likeVerify?: unknown[];
  nextTarget?: unknown;
}): { cdp: BrowseCdp; clicks: Array<Record<string, unknown>>; navigations: string[] } {
  let probeIndex = 0;
  let verifyIndex = 0;
  const clicks: Array<Record<string, unknown>> = [];
  const navigations: string[] = [];
  const cdp: BrowseCdp = {
    send: async (method, params: Record<string, unknown> = {}) => {
      if (method === 'Page.navigate') {
        navigations.push(String(params.url ?? ''));
        return {} as never;
      }
      if (method === 'Input.dispatchMouseEvent') {
        clicks.push(params);
        return {} as never;
      }
      if (method !== 'Runtime.evaluate') return {} as never;
      const expression = String(params.expression ?? '');
      if (expression.includes('__AIDCP_REEL_LIKE_TARGET__')) return { result: { value: JSON.stringify(options.likeTarget) } } as never;
      if (expression.includes('__AIDCP_REEL_LIKE_VERIFY__')) {
        const values = options.likeVerify ?? [];
        const value = values[Math.min(verifyIndex, Math.max(0, values.length - 1))];
        verifyIndex += 1;
        return { result: { value: JSON.stringify(value) } } as never;
      }
      if (expression.includes('__AIDCP_REEL_NEXT_TARGET__')) return { result: { value: JSON.stringify(options.nextTarget) } } as never;
      if (expression.includes('__AIDCP_REEL_PROBE__')) {
        const values = options.probes ?? [];
        const value = values[Math.min(probeIndex, Math.max(0, values.length - 1))];
        probeIndex += 1;
        return { result: { value: JSON.stringify(value) } } as never;
      }
      throw new Error('unexpected expression');
    },
  };
  return { cdp, clicks, navigations };
}

test('Reels：活动视频摘要映射为唯一当前卡', async () => {
  const { cdp } = scriptedCdp({ probes: [REEL_1] });
  const card = await new FacebookReelsReader({ cdp, sleep: async () => {} }).readActive();
  assert.deepEqual(card, {
    noteId: REEL_1.noteId,
    summary: REEL_1.summary,
    author: 'Bao',
    reactionText: '5.8K',
    videoKey: 'video-111',
  });
});

test('Reels 点赞：命令 noteId 与活动 Reel 不同则零点击 fail-closed', async () => {
  const scripted = scriptedCdp({
    likeTarget: { ...REEL_1, found: true, cx: 800, cy: 300 },
  });
  const result = await new FacebookReelsReader({ cdp: scripted.cdp, sleep: async () => {} }).like(REEL_2.noteId, false);
  assert.equal(result.reason, 'no_target');
  assert.equal(scripted.clicks.length, 0);
});

test('Reels 点赞：一次可信点击 + 同 Reel 已选中态才成功，圆整计数不作证明', async () => {
  const scripted = scriptedCdp({
    probes: [REEL_1, REEL_1],
    likeTarget: { ...REEL_1, found: true, already: false, cx: 800, cy: 300 },
    likeVerify: [{ noteId: REEL_1.noteId, selected: true }],
  });
  const result = await new FacebookReelsReader({ cdp: scripted.cdp, sleep: async () => {} }).like(REEL_1.noteId, false);
  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.observation?.reactionText, '5.8K');
  assert.deepEqual(scripted.clicks.map((event) => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('Reels 点赞：结构候选歧义时不点击', async () => {
  const scripted = scriptedCdp({ likeTarget: { ...REEL_1, found: false, ambiguous: true } });
  const result = await new FacebookReelsReader({ cdp: scripted.cdp, sleep: async () => {} }).like(REEL_1.noteId, false);
  assert.equal(result.reason, 'ambiguous_target');
  assert.equal(scripted.clicks.length, 0);
});

test('Reels 下一条：只在全局下按钮点击后 route/video identity 改变才上报', async () => {
  const scripted = scriptedCdp({
    probes: [REEL_1, REEL_1, REEL_2],
    nextTarget: { ok: true, found: true, ambiguous: false, cx: 1380, cy: 700 },
  });
  const reader = new FacebookReelsReader({ cdp: scripted.cdp, sleep: async () => {} }, { settleRounds: 3, settleMs: 1 });
  const next = await reader.next();
  assert.equal(next?.noteId, REEL_2.noteId);
  assert.deepEqual(scripted.clicks.map((event) => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('Reels 下一条：按钮歧义/禁用或身份不变均不报成功', async () => {
  const ambiguous = scriptedCdp({ probes: [REEL_1], nextTarget: { ok: true, found: true, ambiguous: true, cx: 1, cy: 1 } });
  assert.equal(await new FacebookReelsReader({ cdp: ambiguous.cdp, sleep: async () => {} }).next(), null);
  assert.equal(ambiguous.clicks.length, 0);

  const unchanged = scriptedCdp({ probes: [REEL_1], nextTarget: { ok: true, found: true, ambiguous: false, cx: 1380, cy: 700 } });
  assert.equal(await new FacebookReelsReader({ cdp: unchanged.cdp, sleep: async () => {} }, { settleRounds: 2, settleMs: 1 }).next(), null);
});
