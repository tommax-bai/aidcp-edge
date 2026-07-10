/**
 * 验证码协助：运营真实鼠标轨迹回放（change captcha-assist-trajectory-replay）。
 *
 * 落点权威取离散点（WHERE），轨迹样本只供"怎么移动/何时按下"（HOW/WHEN）。反检测要点：
 *  - **每次 press 前补一帧 move 到权威落点**：保证 mousedown 坐标 == 最后 mousemove 坐标，
 *    消除"mousedown 落在鼠标从未移动到的坐标"这一比合成路径更可检测的瞬移伪影。
 *  - **缩时只裁剪长停顿（Δt clamp），绝不等比压缩**：等比压缩会产生超人速度。
 *  - 帧间 dt 叠轻量对数正态抖动、坐标叠 ±1px 亚像素：不做 verbatim 原样重放（固定节流采样节奏本身是指纹）。
 *  - 样本数/单调/坐标/clicks 越界任一不过 → 判无效，调用方回落合成路径（绝不硬回放、绝不谎称用了轨迹）。
 *
 * 纯逻辑 + 注入 sink/random/sleep，脱 CDP 可单测（比照 mouse-path.ts）。
 */

import { jitterAround, defaultRandom, type RandomFn } from './timing.js';
import type { CaptchaAssistClickPointPayload, CaptchaAssistTrajectoryPayload } from '../comm/protocol.js';

export interface MouseEventSink {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 样本数上限（超限判无效、回落合成，防 payload 膨胀 + 回放时长失控）。 */
export const MAX_TRAJECTORY_SAMPLES = 250;
/** 单帧最大停顿（ms）：长停顿裁到此值，短的照留（只裁不压缩）。 */
const MAX_FRAME_GAP_MS = 120;

/**
 * 校验并归一轨迹；任一不合法返回 null（调用方回落合成路径）。
 * 校验：v===1；samples 非空且 ≤ MAX；每样本 x/y∈[0,1]、t 有限；clicks 长度===点数、每项为 [0,samples) 内整数。
 */
export function sanitizeTrajectory(
  traj: CaptchaAssistTrajectoryPayload | undefined,
  pointsLen: number,
): CaptchaAssistTrajectoryPayload | null {
  if (!traj || traj.v !== 1) return null;
  const { samples, clicks } = traj;
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_TRAJECTORY_SAMPLES) return null;
  for (const s of samples) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.t)) return null;
    if (s.x < 0 || s.x > 1 || s.y < 0 || s.y > 1) return null;
  }
  if (!Array.isArray(clicks) || clicks.length !== pointsLen) return null;
  for (const c of clicks) {
    if (!Number.isInteger(c) || c < 0 || c >= samples.length) return null;
  }
  return traj;
}

/**
 * 回放轨迹到原浏览器。样本按 crop 缩放逐帧 mouseMoved（带 dt 裁剪+抖动、坐标亚像素）；
 * 到 clicks 指定的样本下标时，先补 move 到 points[i] 权威落点再 press/release。
 * clicks 可非单调（按样本下标建 press 查找表）；保证所有 points 都被 press（防遗漏）。
 */
export async function replayTrajectory(
  sink: MouseEventSink,
  crop: CropRect,
  points: CaptchaAssistClickPointPayload[],
  traj: CaptchaAssistTrajectoryPayload,
  random: RandomFn = defaultRandom,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const pressAt = new Map<number, number[]>();
  traj.clicks.forEach((sampleIdx, pointIdx) => {
    const arr = pressAt.get(sampleIdx) ?? [];
    arr.push(pointIdx);
    pressAt.set(sampleIdx, arr);
  });
  const fired = new Set<number>();
  const move = (x: number, y: number) => sink.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const pressPoint = async (pointIdx: number): Promise<void> => {
    const p = points[pointIdx];
    const tx = crop.x + p.x * crop.width;
    const ty = crop.y + p.y * crop.height;
    // 按下前补一帧移动到权威落点（无瞬移伪影）。
    await move(tx, ty);
    const base = { x: tx, y: ty, button: 'left' as const, clickCount: 1 };
    await sink.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await sleep(Math.min(200, Math.max(0, jitterAround(60, 0.3, random))));
    await sink.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    fired.add(pointIdx);
  };

  let prevT = traj.samples[0].t;
  for (let s = 0; s < traj.samples.length; s++) {
    const smp = traj.samples[s];
    if (s > 0) {
      let dt = smp.t - prevT;
      if (!(dt >= 0)) dt = 0; // 非单调 t 兜底
      dt = Math.min(dt, MAX_FRAME_GAP_MS); // 只裁剪长停顿，不等比压缩
      dt = jitterAround(dt, 0.2, random);
      if (dt > 0) await sleep(dt);
    }
    prevT = smp.t;
    const px = crop.x + smp.x * crop.width + (random() * 2 - 1); // ±1px 亚像素
    const py = crop.y + smp.y * crop.height + (random() * 2 - 1);
    await move(px, py);
    const pending = pressAt.get(s);
    if (pending) for (const pi of pending) await pressPoint(pi);
  }
  // 防御：validation 保证 clicks[i]<samples.length，理论上都已触发；重复下标等导致遗漏时补发，
  // 保证 press 次数 == points 数（不静默漏点）。
  for (let i = 0; i < points.length; i++) if (!fired.has(i)) await pressPoint(i);
}
