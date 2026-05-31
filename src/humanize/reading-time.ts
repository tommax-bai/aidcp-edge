/**
 * 阅读停留时间（与内容长度相关）。
 *
 * 背景（见 docs/risk-control.md §3.2）：阅读时间不能是固定区间，应与笔记内容量正
 * 相关——长文/多图停留久，短笔记一扫而过。这种"停留时长与内容的相关性"是真人最
 * 自然的指纹。
 *
 * 模型：
 *   base = 正文字数 / 阅读速度(字/分钟) × 60000ms
 *   read = (base + 基础常量) × 对数正态噪声因子
 *   裁剪到 [minMs, maxMs]
 */

import { gaussian, type RandomFn, defaultRandom } from './timing.js';

/** 阅读时间配置 */
export interface ReadingTimeOptions {
  /** 阅读速度（字/分钟），默认 300 */
  charsPerMinute?: number;
  /** 基础常量(ms)（打开到开始读的固定开销），默认 1500 */
  baseMs?: number;
  /** 对数正态噪声分散度，默认 0.3 */
  sigma?: number;
  /** 裁剪下限(ms)，默认 2000 */
  minMs?: number;
  /** 裁剪上限(ms)，默认 20000 */
  maxMs?: number;
  /** 随机源（注入便于测试确定性） */
  random?: RandomFn;
}

/**
 * 估算一段正文的阅读停留时间(ms)。
 *
 * @param textLength 正文字数（已 trim 的字符数）
 */
export function estimateReadingTime(textLength: number, options: ReadingTimeOptions = {}): number {
  const cpm = options.charsPerMinute ?? 300;
  const base = options.baseMs ?? 1500;
  const sigma = options.sigma ?? 0.3;
  const min = options.minMs ?? 2000;
  const max = options.maxMs ?? 20000;
  const random = options.random ?? defaultRandom;

  const len = Math.max(0, textLength);
  // 基础阅读时间 = 字数 / 速度 × 60000ms
  const reading = (len / cpm) * 60000;
  // 对数正态噪声因子（中位 1.0）
  const noise = Math.exp(sigma * gaussian(random));
  const raw = (base + reading) * noise;

  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.round(Math.min(hi, Math.max(lo, raw)));
}
