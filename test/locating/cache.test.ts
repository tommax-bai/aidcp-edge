import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnchorCache } from '../../src/locating/index.js';
import type { Anchor } from '../../src/locating/index.js';

const anchorA: Anchor = { actionId: 'like', role: 'button', text: '点赞', textMatch: 'contains' };
const anchorA2: Anchor = { actionId: 'like', role: 'button', text: '赞', textMatch: 'contains' };

test('反污染：暂存锚点不直接进主缓存，连续确认达阈值才晋升', () => {
  const cache = new AnchorCache({ mode: 'read-write', confirmThreshold: 2 });

  assert.equal(cache.stage(anchorA), true);
  assert.equal(cache.hasStaged('like'), true);
  assert.equal(cache.get('like'), undefined, '暂存期间主缓存应为空');

  const r1 = cache.confirmStaged('like');
  assert.equal(r1.promoted, false);
  assert.equal(r1.successes, 1);
  assert.equal(cache.get('like'), undefined, '一次确认不应晋升');

  const r2 = cache.confirmStaged('like');
  assert.equal(r2.promoted, true);
  assert.equal(cache.get('like')?.text, '点赞', '达阈值后晋升主缓存');
  assert.equal(cache.hasStaged('like'), false);
});

test('暂存校验失败 dropStaged 阻止晋升', () => {
  const cache = new AnchorCache({ mode: 'read-write', confirmThreshold: 2 });
  cache.stage(anchorA);
  cache.confirmStaged('like');
  cache.dropStaged('like');
  assert.equal(cache.hasStaged('like'), false);
  const r = cache.confirmStaged('like');
  assert.equal(r.promoted, false);
  assert.equal(cache.get('like'), undefined);
});

test('暂存锚点变化会重置确认计数（不稳定不晋升）', () => {
  const cache = new AnchorCache({ mode: 'read-write', confirmThreshold: 2 });
  cache.stage(anchorA);
  cache.confirmStaged('like'); // successes=1
  cache.stage(anchorA2); // 与上次不一致 → 重置
  const r = cache.confirmStaged('like');
  assert.equal(r.promoted, false);
  assert.equal(r.successes, 1, '更换锚点后计数应从头累计');
});

test('read-only 模式不暂存但允许读取已有主缓存', () => {
  const cache = new AnchorCache({ mode: 'read-only' });
  cache.put(anchorA);
  assert.equal(cache.get('like')?.text, '点赞');
  assert.equal(cache.stage(anchorA2), false, 'read-only 运行时不应回写');
});

test('write-only 模式 get 恒为空（强制走 AI）', () => {
  const cache = new AnchorCache({ mode: 'write-only' });
  cache.put(anchorA);
  assert.equal(cache.get('like'), undefined);
  assert.equal(cache.snapshot().length, 1, '主缓存仍被写入用于建库');
});

test('snapshot/load 往返一致', () => {
  const cache = new AnchorCache();
  cache.put(anchorA);
  const snap = cache.snapshot();
  const cache2 = new AnchorCache();
  cache2.load(snap);
  assert.equal(cache2.get('like')?.text, '点赞');
});
