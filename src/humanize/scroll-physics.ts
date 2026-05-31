/**
 * 惯性滚动序列生成（模拟触控板/滚轮）。
 *
 * 背景（见 docs/risk-control.md §3.3 / docs/anti-detection.md §5.3）：当前滚动是固定
 * 3 步 × 300ms 的匀速分段，是机器特征。真人滑动手势有"加速 → 巡航 → 减速"的惯性：
 * 手指刚触碰时 deltaY 小，中段达到峰值，松手后惯性衰减尾逐渐变小；且帧间隔不均匀
 * （模拟真实帧率波动）。
 *
 * 本模块把一次"滑动手势"拆成 8–15 帧的 wheel delta 序列，每帧带不均匀延迟，
 * 供调用方逐帧派发 Input.dispatchMouseEvent(type='mouseWheel') 或 window.scrollBy。
 */

import { type RandomFn, defaultRandom } from './timing.js';

/** 一帧滚动事件 */
export interface ScrollSequence {
  /** 该帧滚动量（与 totalDistance 同号） */
  deltaY: number;
  /** 距上一帧的延迟(ms) */
  delay: number;
}

/** 惯性滚动生成选项 */
export interface ScrollPhysicsOptions {
  /** 随机源（注入便于测试确定性） */
  random?: RandomFn;
  /** 帧数范围 [min,max]，默认 [8,15] */
  frames?: [number, number];
  /** 每帧延迟范围(ms) [min,max]，默认 [16,60] */
  frameDelayMs?: [number, number];
}

/** 在 [lo,hi] 取均匀随机整数 */
function randInt(lo: number, hi: number, random: RandomFn): number {
  return Math.floor(lo + random() * (hi - lo + 1));
}

/**
 * 速度包络：先升后降的钟形曲线（用 sin 半波近似惯性"加速→峰值→衰减"）。
 * 输入归一化位置 u∈[0,1]，输出权重∈(0,1]。
 */
function envelope(u: number): number {
  // sin(pi*u) 在 0 和 1 处为 0、中间为峰值；加一个偏置避免端点权重为 0。
  return Math.sin(Math.PI * u) * 0.85 + 0.15;
}

/**
 * 生成一次滚动的事件序列（模拟触控板惯性）。
 *
 * 特征（docs/anti-detection.md §5.3）：
 *  - 开始：deltaY 小（手指刚触碰）
 *  - 中间：deltaY 达峰值（快速滑动）
 *  - 结束：deltaY 逐渐减小（惯性衰减）
 *  - 帧数 8–15，每帧间隔 16–60ms 不均匀
 *  - 各帧 deltaY 之和 = totalDistance（保号、整数）
 *
 * @param totalDistance 本次滚动总位移（正=向下，负=向上）
 */
export function generateScrollSequence(
  totalDistance: number,
  options: ScrollPhysicsOptions = {},
): ScrollSequence[] {
  const random = options.random ?? defaultRandom;
  const [fMin, fMax] = options.frames ?? [8, 15];
  const [dMin, dMax] = options.frameDelayMs ?? [16, 60];

  if (totalDistance === 0) return [];
  const sign = totalDistance >= 0 ? 1 : -1;
  const magnitude = Math.abs(totalDistance);

  const frames = randInt(Math.min(fMin, fMax), Math.max(fMin, fMax), random);

  // 各帧权重 = 钟形包络 × 轻微随机抖动
  const weights: number[] = [];
  let sumW = 0;
  for (let i = 0; i < frames; i++) {
    const u = frames === 1 ? 0.5 : i / (frames - 1);
    const w = envelope(u) * (0.85 + random() * 0.3);
    weights.push(w);
    sumW += w;
  }

  // 按权重分配位移，最后一帧吸收取整误差，保证总和精确
  const out: ScrollSequence[] = [];
  let allocated = 0;
  for (let i = 0; i < frames; i++) {
    let d: number;
    if (i === frames - 1) {
      d = magnitude - allocated;
    } else {
      d = Math.round((weights[i] / sumW) * magnitude);
      allocated += d;
    }
    const delay = randInt(Math.min(dMin, dMax), Math.max(dMin, dMax), random);
    out.push({ deltaY: sign * d, delay });
  }
  return out;
}
