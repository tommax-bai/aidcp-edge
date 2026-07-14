import test from 'node:test';
import assert from 'node:assert/strict';

import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import { scrollFacebookViewport } from '../../src/facebook/viewport-scroll.js';

interface ScrollCdpOptions {
  moveOnWheel?: boolean;
  failWheelAt?: number;
}

class ScrollCdp implements BrowseCdp {
  scrollY = 100;
  fallbackCalls = 0;
  wheelCalls: Array<Record<string, unknown>> = [];

  constructor(private readonly options: ScrollCdpOptions = {}) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type !== 'mouseWheel') return {} as T;
      if (this.options.failWheelAt !== undefined && this.wheelCalls.length === this.options.failWheelAt) {
        throw new Error('CDP Input transient failure');
      }
      this.wheelCalls.push(params);
      if (this.options.moveOnWheel !== false) this.scrollY += Number(params.deltaY);
      return {} as T;
    }
    if (method !== 'Runtime.evaluate') return {} as T;
    const expression = String(params.expression ?? '');
    if (expression.includes('window.scrollBy')) {
      this.fallbackCalls += 1;
      this.scrollY += Number(expression.match(/scrollBy\(0,\s*(\d+)\)/)?.[1] ?? 0);
      return { result: { value: true } } as T;
    }
    if (expression.includes('window.innerWidth')) {
      return { result: { value: JSON.stringify({ w: 1280, h: 800 }) } } as T;
    }
    if (expression.includes('window.scrollY')) {
      return { result: { value: JSON.stringify({ y: this.scrollY }) } } as T;
    }
    throw new Error(`unexpected evaluate: ${expression}`);
  }
}

test('fb-scroll: 多帧惯性 wheel 守恒总距离，已移动时不走 JS 兜底', async () => {
  const cdp = new ScrollCdp();
  const result = await scrollFacebookViewport(cdp, {
    distancePx: 650,
    random: () => 0.5,
    sleep: async () => {},
  });

  assert.equal(result.targetDistancePx, 650);
  assert.ok(cdp.wheelCalls.length >= 8 && cdp.wheelCalls.length <= 15, `wheel 帧数 ${cdp.wheelCalls.length}`);
  assert.equal(result.wheelFrames, cdp.wheelCalls.length);
  const deltas = cdp.wheelCalls.map((call) => Number(call.deltaY));
  assert.equal(deltas.reduce((sum, delta) => sum + delta, 0), 650, '各帧总和等于手势目标');
  const peak = Math.max(...deltas);
  assert.ok(deltas[0] < peak, '首帧为加速段');
  assert.ok(deltas[deltas.length - 1] < peak, '末帧为减速段');
  assert.equal(result.wheelMovedDocument, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(cdp.fallbackCalls, 0, 'wheel 已移动时绝不追加 scrollBy');
});

test('fb-scroll: 观测到 wheel 未移动时只作一次 JS 兜底', async () => {
  const cdp = new ScrollCdp({ moveOnWheel: false });
  const result = await scrollFacebookViewport(cdp, {
    distancePx: 650,
    random: () => 0.5,
    sleep: async () => {},
  });

  assert.equal(result.wheelMovedDocument, false);
  assert.equal(result.fallbackUsed, true);
  assert.equal(cdp.fallbackCalls, 1);
});

test('fb-scroll: 部分 wheel 已移动后 CDP 出错，不抛出也不双滚', async () => {
  const logs: string[] = [];
  const cdp = new ScrollCdp({ failWheelAt: 3 });
  const result = await scrollFacebookViewport(cdp, {
    distancePx: 650,
    random: () => 0.5,
    sleep: async () => {},
    logger: (message) => logs.push(message),
  });

  assert.equal(cdp.wheelCalls.length, 3);
  assert.equal(result.wheelMovedDocument, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(cdp.fallbackCalls, 0, '部分成功后不能补第二段');
  assert.equal(logs.length, 1);
});

test('fb-scroll: wheel 起步即失败时，仍有一次受限兜底且不抛出', async () => {
  const cdp = new ScrollCdp({ moveOnWheel: false, failWheelAt: 0 });
  const result = await scrollFacebookViewport(cdp, {
    distancePx: 650,
    random: () => 0.5,
    sleep: async () => {},
  });

  assert.equal(result.wheelFrames, 0);
  assert.equal(result.wheelMovedDocument, false);
  assert.equal(result.fallbackUsed, true);
  assert.equal(cdp.fallbackCalls, 1);
});

// 带符号位移（change facebook-note-scoped-targeting）：点赞前把视口**上方**的目标卡拟人滚回视野，
// 需要向上滚。旧实现 Math.max(1, …) 把负位移夹成 +1px，永远只能往下滚、够不着上方的目标。
test('scrollFacebookViewport: 负位移 → wheel 全部向上，回执位移带负号', async () => {
  const cdp = new ScrollCdp();
  const before = cdp.scrollY;
  const result = await scrollFacebookViewport(cdp, { distancePx: -600, random: () => 0.5, sleep: async () => {} });
  assert.ok(result.targetDistancePx < 0, '目标位移必须保留方向（负=向上）');
  assert.ok(result.wheelFrames > 0);
  assert.ok(
    cdp.wheelCalls.every((w) => Number(w.deltaY) < 0),
    '每一帧 wheel 都必须是向上的负 deltaY',
  );
  assert.ok(cdp.scrollY < before, '文档真的向上滚了');
  assert.equal(result.fallbackUsed, false);
});
