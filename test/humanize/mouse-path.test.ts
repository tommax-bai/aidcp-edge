import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMousePath, type Point } from '../../src/humanize/mouse-path.js';

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

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

test('起点接近 from，末点接近 to（含落点抖动 ≤ jitter）', () => {
  const rng = mulberry32(1);
  const from = { x: 0, y: 0 };
  const to = { x: 500, y: 300 };
  const path = generateMousePath({ from, to, jitter: 3, random: rng });
  assert.ok(dist(path[0], from) < 2, '首点≈from');
  assert.ok(dist(path[path.length - 1], to) <= 5, '末点≈to（抖动内）');
});

test('点数随距离增加，且在 [15,60] 区间', () => {
  const rng = mulberry32(2);
  const path = generateMousePath({ from: { x: 0, y: 0 }, to: { x: 800, y: 0 }, random: rng });
  assert.ok(path.length >= 15 && path.length <= 62, `点数 ${path.length}`);
});

test('轨迹是曲线而非直线（存在垂直于连线的偏移）', () => {
  const rng = mulberry32(3);
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 0 }; // 水平连线，曲线点应有非零 y
  const path = generateMousePath({ from, to, random: rng });
  const maxOffset = Math.max(...path.map((p) => Math.abs(p.y)));
  assert.ok(maxOffset > 5, `应有明显弧线偏移，实际 ${maxOffset}`);
});

test('ease-in-out：两端步距小、中间步距大（速度变化）', () => {
  const rng = mulberry32(4);
  const from = { x: 0, y: 0 };
  const to = { x: 600, y: 0 };
  const path = generateMousePath({ from, to, random: rng });
  const steps: number[] = [];
  for (let i = 1; i < path.length; i++) steps.push(dist(path[i], path[i - 1]));
  const first = steps[0];
  const mid = steps[Math.floor(steps.length / 2)];
  const last = steps[steps.length - 1];
  assert.ok(mid > first, '中段比起步快');
  assert.ok(mid > last, '中段比收尾快');
});

test('overshoot：末段先越过 to 再回拉', () => {
  const rng = mulberry32(5);
  const from = { x: 0, y: 0 };
  const to = { x: 300, y: 0 };
  const path = generateMousePath({ from, to, overshoot: true, jitter: 0, random: rng });
  // 倒数第二点应越过目标（x > to.x），最后点回到 to 附近
  const overshootPt = path[path.length - 2];
  const finalPt = path[path.length - 1];
  assert.ok(overshootPt.x > to.x, 'overshoot 点越过目标');
  assert.ok(Math.abs(finalPt.x - to.x) <= 3, '末点回到目标附近');
});

test('极近距离：退化为两点', () => {
  const rng = mulberry32(6);
  const path = generateMousePath({ from: { x: 10, y: 10 }, to: { x: 10, y: 10 }, jitter: 0, random: rng });
  assert.equal(path.length, 2);
});

test('所有点为整数像素', () => {
  const rng = mulberry32(7);
  const path = generateMousePath({ from: { x: 0, y: 0 }, to: { x: 250, y: 120 }, random: rng });
  for (const p of path) {
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
  }
});
