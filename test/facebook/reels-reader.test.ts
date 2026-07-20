import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import { buildNextTargetJs, buildReelProbeJs, FacebookReelsReader } from '../../src/facebook/reels-reader.js';

const REEL_1 = {
  ok: true,
  noteId: 'https://www.facebook.com/reel/111',
  summary: 'Ở Trung Quốc lạ lắm mọi người ơi. #xuhuongfacebook',
  author: 'Bao',
  reactionText: '5.8K',
  videoKey: 'video-111',
  videoRect: { left: 557, top: 72, right: 959, bottom: 786 },
};
const REEL_2 = { ...REEL_1, noteId: 'https://www.facebook.com/reel/222', summary: 'Second reel', videoKey: 'video-222' };

function scriptedCdp(options: {
  probes?: unknown[];
  likeTarget?: unknown;
  likeVerify?: unknown[];
  nextTarget?: unknown;
}): {
  cdp: BrowseCdp;
  clicks: Array<Record<string, unknown>>;
  keys: Array<Record<string, unknown>>;
  navigations: string[];
  evaluations: string[];
} {
  let probeIndex = 0;
  let verifyIndex = 0;
  const clicks: Array<Record<string, unknown>> = [];
  const keys: Array<Record<string, unknown>> = [];
  const navigations: string[] = [];
  const evaluations: string[] = [];
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
      if (method === 'Input.dispatchKeyEvent') {
        keys.push(params);
        return {} as never;
      }
      if (method !== 'Runtime.evaluate') return {} as never;
      const expression = String(params.expression ?? '');
      evaluations.push(expression);
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
  return { cdp, clicks, keys, navigations, evaluations };
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

test('Reels 下一条：ArrowDown 成功后停止，不再滚轮或点按钮', async () => {
  const scripted = scriptedCdp({
    probes: [REEL_1, REEL_1, REEL_2],
  });
  const reader = new FacebookReelsReader(
    { cdp: scripted.cdp, sleep: async () => {} },
    { navigationRounds: 1, navigationMs: 1 },
  );
  const next = await reader.next();
  assert.equal(next?.noteId, REEL_2.noteId);
  assert.deepEqual(scripted.keys.map((event) => event.type), ['rawKeyDown', 'keyUp']);
  assert.equal(scripted.clicks.length, 0);
  assert.equal(scripted.evaluations.some((value) => value.includes('__AIDCP_REEL_NEXT_TARGET__')), false);
});

test('Reels 下一条：键盘不动才发一次 70px 滚轮，滚轮成功后不点按钮', async () => {
  const scripted = scriptedCdp({ probes: [REEL_1, REEL_1, REEL_1, REEL_1, REEL_2] });
  const reader = new FacebookReelsReader(
    { cdp: scripted.cdp, sleep: async () => {}, random: () => 0 },
    { navigationRounds: 1, navigationMs: 1 },
  );
  assert.equal((await reader.next())?.noteId, REEL_2.noteId);
  assert.deepEqual(scripted.clicks.map((event) => event.type), ['mouseWheel']);
  assert.equal(scripted.clicks[0]?.deltaY, 70);
  assert.equal(scripted.evaluations.some((value) => value.includes('__AIDCP_REEL_NEXT_TARGET__')), false);
});

test('Reels 下一条：滚轮随机上界钳制为 100px', async () => {
  const scripted = scriptedCdp({ probes: [REEL_1, REEL_1, REEL_1, REEL_1, REEL_2] });
  const reader = new FacebookReelsReader(
    { cdp: scripted.cdp, sleep: async () => {}, random: () => 1 },
    { navigationRounds: 1, navigationMs: 1 },
  );
  assert.equal((await reader.next())?.noteId, REEL_2.noteId);
  assert.equal(scripted.clicks[0]?.deltaY, 100);
});

test('Reels 下一条：键盘后的迟到位移在滚轮前胜出，禁止第二次写', async () => {
  const scripted = scriptedCdp({ probes: [REEL_1, REEL_1, REEL_1, REEL_2] });
  const reader = new FacebookReelsReader(
    { cdp: scripted.cdp, sleep: async () => {} },
    { navigationRounds: 1, navigationMs: 1 },
  );
  assert.equal((await reader.next())?.noteId, REEL_2.noteId);
  assert.equal(scripted.clicks.length, 0);
});

test('Reels 下一条：键盘和滚轮不动后才点按钮，按钮后身份变化才成功', async () => {
  const scripted = scriptedCdp({
    probes: [REEL_1, REEL_1, REEL_1, REEL_1, REEL_1, REEL_1, REEL_2],
    nextTarget: { ...REEL_1, found: true, ambiguous: false, cx: 1404, cy: 461, label: '下一张牌' },
  });
  const reader = new FacebookReelsReader(
    { cdp: scripted.cdp, sleep: async () => {}, random: () => 0.5 },
    { navigationRounds: 1, navigationMs: 1 },
  );
  assert.equal((await reader.next())?.noteId, REEL_2.noteId);
  assert.deepEqual(scripted.clicks.map((event) => event.type), ['mouseWheel', 'mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(scripted.clicks[0]?.deltaY, 85);
});

test('Reels 下一条：按钮歧义零点击；全部输入后身份不变仍不报成功', async () => {
  const unchangedBeforeButton = [REEL_1, REEL_1, REEL_1, REEL_1, REEL_1, REEL_1];
  const ambiguous = scriptedCdp({
    probes: unchangedBeforeButton,
    nextTarget: { ...REEL_1, found: false, ambiguous: true },
  });
  const ambiguousReader = new FacebookReelsReader(
    { cdp: ambiguous.cdp, sleep: async () => {} },
    { navigationRounds: 1, navigationMs: 1 },
  );
  assert.equal(await ambiguousReader.next(), null);
  assert.deepEqual(ambiguous.clicks.map((event) => event.type), ['mouseWheel']);

  const unchanged = scriptedCdp({
    probes: [...unchangedBeforeButton, REEL_1],
    nextTarget: { ...REEL_1, found: true, ambiguous: false, cx: 1404, cy: 461, label: '下一张牌' },
  });
  const unchangedReader = new FacebookReelsReader(
    { cdp: unchanged.cdp, sleep: async () => {} },
    { navigationRounds: 1, navigationMs: 1 },
  );
  assert.equal(await unchangedReader.next(), null);
  assert.deepEqual(unchanged.clicks.map((event) => event.type), ['mouseWheel', 'mouseMoved', 'mousePressed', 'mouseReleased']);
});

function setRect(element: Element, rect: { left: number; top: number; right: number; bottom: number }): void {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ ...rect, width, height, x: rect.left, y: rect.top, toJSON: () => ({}) }),
  });
}

test('Reels 活动视频身份[jsdom]：同一 video 元素仅发生位移动画时 key 保持稳定', () => {
  const dom = new JSDOM('<video></video>', { url: REEL_1.noteId, runScripts: 'outside-only' });
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440 });
  Object.defineProperty(dom.window, 'innerHeight', { value: 802 });
  const video = dom.window.document.querySelector('video')!;
  setRect(video, { left: 557, top: 72, right: 959, bottom: 786 });
  const before = JSON.parse(String(dom.window.eval(buildReelProbeJs()))) as { videoKey: string };
  setRect(video, { left: 557, top: -200, right: 959, bottom: 514 });
  const duringAnimation = JSON.parse(String(dom.window.eval(buildReelProbeJs()))) as { videoKey: string };
  assert.equal(duringAnimation.videoKey, before.videoKey);
});

test('Reels 下一按钮[jsdom]：排除顶栏，首条上一张禁用时唯一命中下一张', () => {
  const dom = new JSDOM(
    '<video></video><div id="menu" role="button" aria-label="Facebook上的菜单"></div><div id="notice" role="button" aria-label="通知"></div><div id="previous" role="button" aria-label="上一张牌" aria-disabled="true"></div><div id="next" role="button" aria-label="下一张牌"></div>',
    { url: REEL_1.noteId, runScripts: 'outside-only' },
  );
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440 });
  Object.defineProperty(dom.window, 'innerHeight', { value: 802 });
  setRect(dom.window.document.querySelector('video')!, { left: 557, top: 72, right: 959, bottom: 786 });
  setRect(dom.window.document.querySelector('#menu')!, { left: 1240, top: 8, right: 1280, bottom: 48 });
  setRect(dom.window.document.querySelector('#notice')!, { left: 1336, top: 8, right: 1376, bottom: 48 });
  setRect(dom.window.document.querySelector('#previous')!, { left: 1380, top: 373, right: 1428, bottom: 421 });
  setRect(dom.window.document.querySelector('#next')!, { left: 1380, top: 437, right: 1428, bottom: 485 });
  const result = JSON.parse(String(dom.window.eval(buildNextTargetJs()))) as Record<string, unknown>;
  assert.equal(result.found, true);
  assert.equal(result.ambiguous, false);
  assert.equal(result.label, '下一张牌');
  assert.equal(result.cx, 1404);
  assert.equal(result.cy, 461);
});

test('Reels 下一按钮[jsdom]：多个可信下一张保持歧义并零目标', () => {
  const dom = new JSDOM(
    '<video></video><div id="next1" role="button" aria-label="Next card"></div><div id="next2" role="button" aria-label="下一张牌"></div>',
    { url: REEL_1.noteId, runScripts: 'outside-only' },
  );
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440 });
  Object.defineProperty(dom.window, 'innerHeight', { value: 802 });
  setRect(dom.window.document.querySelector('video')!, { left: 557, top: 72, right: 959, bottom: 786 });
  setRect(dom.window.document.querySelector('#next1')!, { left: 1380, top: 373, right: 1428, bottom: 421 });
  setRect(dom.window.document.querySelector('#next2')!, { left: 1380, top: 437, right: 1428, bottom: 485 });
  const result = JSON.parse(String(dom.window.eval(buildNextTargetJs()))) as Record<string, unknown>;
  assert.equal(result.found, false);
  assert.equal(result.ambiguous, true);
});
