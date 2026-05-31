/**
 * 停顿时间生成器（对数正态分布）。
 *
 * 背景（见 docs/risk-control.md §3.1）：真人停顿不是均匀分布，而是"大量短停顿 +
 * 少数长停顿"的长尾结构，天然服从对数正态分布。当前实现用 `random(min, max)` 均匀
 * 采样，方差小、无长尾，是最易被行为分析模型识别的机器特征。
 *
 * 本模块用 Box–Muller 生成标准正态，再 `exp(mu + sigma·z)` 得到对数正态样本，
 * 并裁剪到 [min, max]，产出"中位数 ≈ exp(mu)、偶有长尾"的真人停顿时长。
 */

/** 随机源类型（注入便于测试确定性） */
export type RandomFn = () => number;

/** 默认随机源 */
export const defaultRandom: RandomFn = Math.random;

/** 对数正态停顿配置 */
export interface TimingConfig {
  /** 中位数的自然对数（中位数 = exp(mu)） */
  mu: number;
  /** 分散度（越大长尾越重） */
  sigma: number;
  /** 下限裁剪（毫秒） */
  min: number;
  /** 上限裁剪（毫秒） */
  max: number;
}

/** 自然对数（便于在预设里直观写出"中位数毫秒数"） */
const ln = Math.log;

/**
 * 预设场景（毫秒）。mu = ln(中位数)，sigma 控制长尾重量。
 * 数值锚定 docs/risk-control.md §3.1 / §6 的"中位停顿"建议。
 */
export const TIMING_PRESETS = {
  /** 卡片间切换：中位 ≈ 5s，少数到 12s */
  cardGap: { mu: ln(5000), sigma: 0.4, min: 3000, max: 12000 },
  /** 阅读停留：中位 ≈ 5s，长尾到 15s（被某条笔记吸引） */
  reading: { mu: ln(5000), sigma: 0.5, min: 2000, max: 15000 },
  /** 操作间隔：中位 ≈ 2.5s */
  action: { mu: ln(2500), sigma: 0.3, min: 1500, max: 6000 },
  /** 滚动间隔：中位 ≈ 0.8s */
  scroll: { mu: ln(800), sigma: 0.3, min: 400, max: 2000 },
} as const satisfies Record<string, TimingConfig>;

/** 预设名 */
export type TimingPresetName = keyof typeof TIMING_PRESETS;

/**
 * 用 Box–Muller 把两个 (0,1) 均匀随机数变换为一个标准正态样本 N(0,1)。
 * 对 u1 做下限保护，避免 ln(0) = -Infinity。
 */
export function gaussian(random: RandomFn = defaultRandom): number {
  let u1 = random();
  const u2 = random();
  if (u1 < 1e-12) u1 = 1e-12;
  return Math.sqrt(-2 * ln(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * 从对数正态分布采样一个停顿时长（毫秒，已裁剪、取整）。
 *
 * sample = clamp(exp(mu + sigma · N(0,1)), min, max)
 */
export function sampleDelay(config: TimingConfig, random: RandomFn = defaultRandom): number {
  const z = gaussian(random);
  const raw = Math.exp(config.mu + config.sigma * z);
  const lo = Math.min(config.min, config.max);
  const hi = Math.max(config.min, config.max);
  const clamped = Math.min(hi, Math.max(lo, raw));
  return Math.round(clamped);
}

/** 便捷：按预设名采样 */
export function samplePreset(name: TimingPresetName, random: RandomFn = defaultRandom): number {
  return sampleDelay(TIMING_PRESETS[name], random);
}
