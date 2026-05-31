/**
 * 贝塞尔鼠标轨迹生成（非瞬移）。
 *
 * 背景（见 docs/risk-control.md §3.5 / docs/anti-detection.md §5.1）：绝不直接派发
 * mousePressed 到目标坐标（瞬移=机器）。真人鼠标从当前位置沿曲线移动到目标，速度
 * 服从 ease-in-out（Fitts 定律：先快后慢逼近），常有 overshoot（越过目标再回拉）。
 *
 * 本模块用三阶贝塞尔曲线 B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
 * 生成中间点序列，供调用方逐帧派发 Input.dispatchMouseEvent(type='mouseMoved')。
 */

import { type RandomFn, defaultRandom } from './timing.js';

/** 二维坐标点 */
export interface Point {
  x: number;
  y: number;
}

/** 鼠标轨迹生成选项 */
export interface MousePathOptions {
  /** 起点（当前光标位置） */
  from: Point;
  /** 终点（目标） */
  to: Point;
  /** 轨迹点数；不传则按距离自动计算 */
  steps?: number;
  /** 是否模拟 overshoot（到达后多走一点再回来） */
  overshoot?: boolean;
  /** 落点微抖动幅度(px)，默认 3 */
  jitter?: number;
  /** 随机源（注入便于测试确定性） */
  random?: RandomFn;
}

/** [-1, 1] 区间的对称随机 */
function symmetric(random: RandomFn): number {
  return random() * 2 - 1;
}

/** ease-in-out（三次）：起步慢、中间快、逼近慢 */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 三阶贝塞尔在参数 t 处的点 */
function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** 两点欧氏距离 */
function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 生成贝塞尔鼠标轨迹点序列。
 *
 * 控制点（docs/anti-detection.md §5.1）：
 *  - P0 = from；P3 = to + 落点抖动(±jitter px)
 *  - P1,P2 在 P0→P3 连线两侧加随机垂直偏移（offset ∝ 距离），产生自然弧线
 *  - 时间参数 t 走 ease-in-out，使点在两端更密（慢）、中间更疏（快）
 *  - overshoot：在抵达 P3 后沿运动方向多走 5–15px 再回拉到 P3
 *
 * 返回的点为整数像素坐标；序列首点 ≈ from，末点 = 抖动后的落点。
 */
export function generateMousePath(opts: MousePathOptions): Point[] {
  const random = opts.random ?? defaultRandom;
  const jitter = opts.jitter ?? 3;
  const from = opts.from;

  // 落点抖动（±jitter）
  const target: Point = {
    x: opts.to.x + symmetric(random) * jitter,
    y: opts.to.y + symmetric(random) * jitter,
  };

  const dist = distance(from, target);

  // 距离很小时直接两点，避免无意义的曲线
  if (dist < 1) {
    return [
      { x: Math.round(from.x), y: Math.round(from.y) },
      { x: Math.round(target.x), y: Math.round(target.y) },
    ];
  }

  // 点数 ∝ 距离（远则多点），裁剪到 [15, 60]
  const steps = opts.steps ?? Math.min(60, Math.max(15, Math.round(dist / 8)));

  // 连线方向与法线方向
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; // 法线
  const ny = dx / len;

  // 两侧随机垂直偏移：幅度 = U(0.1, 0.3) × 距离，左右随机
  const off1 = (0.1 + random() * 0.2) * dist * (symmetric(random) >= 0 ? 1 : -1);
  const off2 = (0.1 + random() * 0.2) * dist * (symmetric(random) >= 0 ? 1 : -1);
  // 控制点落在连线 1/3、2/3 处，叠加法向偏移
  const p1: Point = {
    x: from.x + dx * (1 / 3) + nx * off1,
    y: from.y + dy * (1 / 3) + ny * off1,
  };
  const p2: Point = {
    x: from.x + dx * (2 / 3) + nx * off2,
    y: from.y + dy * (2 / 3) + ny * off2,
  };

  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = easeInOut(i / steps);
    const pt = cubicBezier(from, p1, p2, target, t);
    out.push({ x: Math.round(pt.x), y: Math.round(pt.y) });
  }

  // overshoot：沿运动方向多走 5–15px 再回拉到 target
  if (opts.overshoot) {
    const over = 5 + random() * 10;
    const ox = target.x + (dx / len) * over;
    const oy = target.y + (dy / len) * over;
    out.push({ x: Math.round(ox), y: Math.round(oy) });
    out.push({ x: Math.round(target.x), y: Math.round(target.y) });
  }

  return out;
}
