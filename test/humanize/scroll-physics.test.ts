import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateScrollSequence } from '../../src/humanize/scroll-physics.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('帧数在 8–15 之间', () => {
  const rng = mulberry32(1);
  for (let i = 0; i < 50; i++) {
    const seq = generateScrollSequence(800, { random: rng });
    assert.ok(seq.length >= 8 && seq.length <= 15, `帧数 ${seq.length}`);
  }
});

test('各帧 deltaY 之和等于总位移（保号、精确）', () => {
  const rng = mulberry32(2);
  const total = 950;
  const seq = generateScrollSequence(total, { random: rng });
  const sum = seq.reduce((a, s) => a + s.deltaY, 0);
  assert.equal(sum, total);
  for (const s of seq) assert.ok(s.deltaY >= 0, '向下滚每帧非负');
});

test('加速→减速：峰值在中段，首尾较小', () => {
  const rng = mulberry32(3);
  const seq = generateScrollSequence(1200, { random: rng });
  const deltas = seq.map((s) => s.deltaY);
  const peakIdx = deltas.indexOf(Math.max(...deltas));
  // 峰值不应在最两端
  assert.ok(peakIdx > 0 && peakIdx < deltas.length - 1, `峰值索引 ${peakIdx} 应在中段`);
  assert.ok(deltas[0] <= deltas[peakIdx], '首帧 ≤ 峰值');
  assert.ok(deltas[deltas.length - 1] <= deltas[peakIdx], '末帧 ≤ 峰值');
});

test('帧间延迟在 16–60ms 且不均匀', () => {
  const rng = mulberry32(4);
  const seq = generateScrollSequence(800, { random: rng });
  const delays = seq.map((s) => s.delay);
  for (const d of delays) assert.ok(d >= 16 && d <= 60, `延迟 ${d} 越界`);
  // 不均匀：至少有两个不同的延迟值
  assert.ok(new Set(delays).size > 1, '帧间延迟应不均匀');
});

test('负位移（向上滚）：每帧非正、总和守恒', () => {
  const rng = mulberry32(5);
  const total = -600;
  const seq = generateScrollSequence(total, { random: rng });
  const sum = seq.reduce((a, s) => a + s.deltaY, 0);
  assert.equal(sum, total);
  for (const s of seq) assert.ok(s.deltaY <= 0, '向上滚每帧非正');
});

test('零位移：空序列', () => {
  assert.deepEqual(generateScrollSequence(0), []);
});
