import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleDelay, samplePreset, TIMING_PRESETS, gaussian } from '../../src/humanize/timing.js';

/** 简单种子化 PRNG（mulberry32），保证测试可复现 */
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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

test('sampleDelay: 大量采样后中位数接近 exp(mu)（对数正态特征）', () => {
  const rng = mulberry32(12345);
  const cfg = TIMING_PRESETS.reading; // mu=ln(5000)
  const target = Math.exp(cfg.mu); // 5000
  const samples = Array.from({ length: 20000 }, () => sampleDelay(cfg, rng));
  const med = median(samples);
  // 裁剪会轻微影响中位数，但应在目标 ±20% 内
  assert.ok(Math.abs(med - target) / target < 0.2, `中位 ${med} 应接近 ${target}`);
});

test('sampleDelay: 始终落在 [min,max] 区间', () => {
  const rng = mulberry32(999);
  const cfg = TIMING_PRESETS.action;
  for (let i = 0; i < 5000; i++) {
    const v = sampleDelay(cfg, rng);
    assert.ok(v >= cfg.min && v <= cfg.max, `样本 ${v} 越界`);
  }
});

test('sampleDelay: 存在长尾（均值 > 中位，右偏）', () => {
  const rng = mulberry32(7);
  const cfg = TIMING_PRESETS.reading;
  const samples = Array.from({ length: 20000 }, () => sampleDelay(cfg, rng));
  const med = median(samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  // 对数正态右偏：均值显著大于中位
  assert.ok(mean > med, `均值 ${mean} 应 > 中位 ${med}（长尾右偏）`);
  // 应存在远超中位的长尾样本
  const longTail = samples.filter((v) => v > med * 1.8).length;
  assert.ok(longTail > 0, '应有长尾样本');
});

test('gaussian: 大量采样均值≈0、标准差≈1', () => {
  const rng = mulberry32(42);
  const n = 50000;
  const xs = Array.from({ length: n }, () => gaussian(rng));
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  assert.ok(Math.abs(mean) < 0.05, `均值 ${mean} 应≈0`);
  assert.ok(Math.abs(Math.sqrt(variance) - 1) < 0.05, `标准差应≈1`);
});

test('samplePreset: 各预设名可用且在区间内', () => {
  const rng = mulberry32(3);
  for (const name of Object.keys(TIMING_PRESETS) as (keyof typeof TIMING_PRESETS)[]) {
    const v = samplePreset(name, rng);
    const cfg = TIMING_PRESETS[name];
    assert.ok(v >= cfg.min && v <= cfg.max);
  }
});
