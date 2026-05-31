import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyStrokes } from '../../src/humanize/keyboard-rhythm.js';
import { estimateReadingTime } from '../../src/humanize/reading-time.js';

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

test('逐字符：字符序列拼接还原原文（含多字节）', () => {
  const rng = mulberry32(1);
  const text = '奶茶推荐 milk tea';
  const strokes = generateKeyStrokes(text, { random: rng });
  assert.equal(strokes.length, Array.from(text).length);
  assert.equal(strokes.map((s) => s.char).join(''), text);
});

test('间隔分布合理：中位接近正常打字速度 (80–150ms)', () => {
  const rng = mulberry32(2);
  // 用一段无标点长文本统计基础间隔
  const text = '今天天气真好我去公园散步看见很多花开得很漂亮心情非常愉快';
  const all: number[] = [];
  for (let i = 0; i < 500; i++) {
    const strokes = generateKeyStrokes(text, { random: rng });
    for (const s of strokes) all.push(s.delay);
  }
  const med = median(all);
  assert.ok(med >= 80 && med <= 160, `中位间隔 ${med} 应在正常打字范围`);
});

test('间隔不均匀（非恒定）', () => {
  const rng = mulberry32(3);
  const strokes = generateKeyStrokes('hello world this is a test', { random: rng });
  const delays = strokes.map((s) => s.delay);
  assert.ok(new Set(delays).size > 3, '间隔应有明显变化');
});

test('存在偶发长停顿（想词）', () => {
  const rng = mulberry32(4);
  const all: number[] = [];
  for (let i = 0; i < 300; i++) {
    const strokes = generateKeyStrokes('一二三四五六七八九十', { random: rng });
    for (const s of strokes) all.push(s.delay);
  }
  const longPauses = all.filter((d) => d >= 300).length;
  assert.ok(longPauses > 0, '应存在 ≥300ms 的长停顿');
});

test('标点/空白处间隔偏长', () => {
  const rng = mulberry32(5);
  // 关闭长停顿干扰，仅看标点放慢效果
  let normalSum = 0;
  let normalCnt = 0;
  let punctSum = 0;
  let punctCnt = 0;
  for (let i = 0; i < 800; i++) {
    const strokes = generateKeyStrokes('ab, cd. ef', { random: rng, pauseProbability: 0 });
    for (const s of strokes) {
      if (/[\s.,]/.test(s.char)) {
        punctSum += s.delay;
        punctCnt++;
      } else {
        normalSum += s.delay;
        normalCnt++;
      }
    }
  }
  const punctAvg = punctSum / punctCnt;
  const normalAvg = normalSum / normalCnt;
  assert.ok(punctAvg > normalAvg, `标点均值 ${punctAvg} 应 > 普通 ${normalAvg}`);
});

// ---- reading-time ----

test('阅读时间随内容长度增加', () => {
  const rng = mulberry32(6);
  const shortT = estimateReadingTime(20, { random: rng, sigma: 0 });
  const longT = estimateReadingTime(2000, { random: rng, sigma: 0 });
  assert.ok(longT > shortT, '长文阅读时间更久');
});

test('阅读时间裁剪到 [min,max]', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const t = estimateReadingTime(50000, { random: rng });
    assert.ok(t >= 2000 && t <= 20000, `阅读时间 ${t} 越界`);
  }
  const tiny = estimateReadingTime(0, { random: rng, sigma: 0 });
  assert.ok(tiny >= 2000, '极短内容仍有下限');
});

test('300字/分钟：约 1000 字 → 基础约 200s 被裁剪到上限', () => {
  // 1000 字 / 300cpm = 3.33min ≈ 200s，远超 20s 上限 → 应裁剪到 20000
  const t = estimateReadingTime(1000, { sigma: 0, random: () => 0.5 });
  assert.equal(t, 20000);
});
