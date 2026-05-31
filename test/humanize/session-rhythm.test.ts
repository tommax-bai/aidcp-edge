import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PhaseSessionRhythm,
  createDefaultRhythm,
  applySpeedFactor,
  DEFAULT_PHASES,
} from '../../src/humanize/session-rhythm.js';

test('默认曲线：各阶段速度系数符合设计', () => {
  const r = createDefaultRhythm();
  // 热身期 0–0.15 → 0.7
  assert.equal(r.getSpeedFactor(0), 0.7);
  assert.equal(r.getSpeedFactor(0.1), 0.7);
  // 正常期 0.15–0.7 → 1.0
  assert.equal(r.getSpeedFactor(0.15), 1.0);
  assert.equal(r.getSpeedFactor(0.5), 1.0);
  // 轻微加速 0.7–0.85 → 1.1
  assert.equal(r.getSpeedFactor(0.7), 1.1);
  assert.equal(r.getSpeedFactor(0.8), 1.1);
  // 疲劳期 0.85–1.0 → 0.8
  assert.equal(r.getSpeedFactor(0.85), 0.8);
  assert.equal(r.getSpeedFactor(0.95), 0.8);
  // p===1 落在最后一段
  assert.equal(r.getSpeedFactor(1), 0.8);
});

test('进度越界裁剪到 [0,1]', () => {
  const r = createDefaultRhythm();
  assert.equal(r.getSpeedFactor(-5), 0.7); // <0 → 0
  assert.equal(r.getSpeedFactor(99), 0.8); // >1 → 1
});

test('加速期系数 > 正常期 > 热身/疲劳期', () => {
  const r = createDefaultRhythm();
  const warmup = r.getSpeedFactor(0.05);
  const normal = r.getSpeedFactor(0.4);
  const speedup = r.getSpeedFactor(0.78);
  const fatigue = r.getSpeedFactor(0.95);
  assert.ok(speedup > normal, '加速期最快');
  assert.ok(normal > warmup, '正常 > 热身');
  assert.ok(normal > fatigue, '正常 > 疲劳');
});

test('applySpeedFactor: 系数>1 缩短停顿，<1 拉长停顿', () => {
  assert.equal(applySpeedFactor(1000, 2), 500);
  assert.equal(applySpeedFactor(1000, 0.5), 2000);
  assert.equal(applySpeedFactor(1000, 1), 1000);
  // 非正系数回退为 1，且下限 1ms
  assert.equal(applySpeedFactor(1000, 0), 1000);
  assert.equal(applySpeedFactor(0, 1), 1);
});

test('自定义 phases 可覆盖默认', () => {
  const r = new PhaseSessionRhythm([
    { until: 0.5, factor: 2.0 },
    { until: 1.0, factor: 0.5 },
  ]);
  assert.equal(r.getSpeedFactor(0.2), 2.0);
  assert.equal(r.getSpeedFactor(0.7), 0.5);
});

test('DEFAULT_PHASES 覆盖完整 [0,1] 且末段 until=1', () => {
  assert.equal(DEFAULT_PHASES[DEFAULT_PHASES.length - 1].until, 1.0);
});
