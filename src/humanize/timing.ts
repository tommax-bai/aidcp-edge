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

/**
 * 从对数正态分布采样一个停顿时长（毫秒，已取整），但对越界样本做**反射**（triangle-wave 折返）
 * 回到 [min,max] 内，而非 `sampleDelay` 的**硬裁**。
 *
 * 背景（见 pacing-floor-configurable-min-interval 设计 §7 防指纹）：最小间隔 gating 会把「补差额」
 * 补到 floor 这一固定值，硬裁采样在直方图 min 处堆出一根竖直左壁尖峰——本身是可被行为分析识别的
 * 指纹。反射采样把超出 [lo,hi] 的样本按边界**反弹**回区间内（周期 = 2·span 的三角波折叠），保证结果
 * 恒落在 [lo,hi]，同时把原本会堆在墙上的左/右尾质量摊回分布内、消掉竖直壁。
 *
 * - 中位数取 [min,max] 的几何中点（median = √(min·max)），与 `makeDwellFloorTiming` 同口径；
 * - `min===max`（退化区间）直接返回该值；
 * - **新 helper，刻意不改共享 `sampleDelay`**（避免波及其它 dwell/pause caller，见设计 §9-Q1）。
 *
 * @param min 区间下界（毫秒，调用方须保证 > 0）
 * @param max 区间上界（毫秒）
 * @param sigma 对数正态分散度（越大长尾越重）
 */
export function sampleReflect(min: number, max: number, sigma: number, random: RandomFn = defaultRandom): number {
  const lo = Math.max(1, Math.min(min, max));
  const hi = Math.max(lo, Math.max(min, max));
  if (!(hi > lo)) return Math.round(lo); // 退化区间（min===max）：无展宽可采，直接返回下界
  const mu = ln(Math.sqrt(lo * hi));
  const raw = Math.exp(mu + sigma * gaussian(random));
  // 三角波折返：把 raw 折进 [lo,hi]。周期 = 2·span，[0,span] 段正向、(span,2·span) 段反向。
  const span = hi - lo;
  const period = 2 * span;
  let t = (raw - lo) % period;
  if (t < 0) t += period;
  const folded = t <= span ? lo + t : hi - (t - span);
  return Math.round(folded);
}

/**
 * 围绕一个**中心值**叠加对数正态抖动（指令级节奏 Command Pacing 的边缘抖动层）。
 *
 * 云端基于内容算出的 `dwellMs`/`thinkMs` 是确定性中心值；若边缘直接照用，两个账号看
 * 同一篇笔记会停得分毫不差——这本身是指纹。本函数用 median=1.0 的乘性 lognormal 噪声
 * （`center · exp(sigma · N(0,1))`）把它打散成带随机性的实际时长。
 *
 * @param centerMs 中心时长（毫秒）
 * @param sigma 抖动分散度（默认 0.25）
 */
export function jitterAround(centerMs: number, sigma = 0.25, random: RandomFn = defaultRandom): number {
  const noise = Math.exp(sigma * gaussian(random));
  return Math.round(Math.max(0, centerMs * noise));
}

/**
 * 围绕调用方给定的中心值生成乘性 lognormal 抖动，并把越界样本反射回相对区间。
 *
 * 与 `sampleReflect` 不同，本函数不能用区间几何中点反推中心：Cloud 下发的 `centerMs`
 * 已经是节奏 authority，median=1.0 的噪声必须围绕它生成。反射只承担安全边界，避免
 * 硬裁剪在 min/max 处堆出可识别的墙尖峰。
 */
export function jitterAroundBounded(
  centerMs: number,
  sigma: number,
  minMultiplier: number,
  maxMultiplier: number,
  absoluteMaxMs: number,
  random: RandomFn = defaultRandom,
): number {
  const center = Number.isFinite(centerMs) ? Math.max(0, centerMs) : 0;
  if (center === 0) return 0;

  const firstMultiplier = Number.isFinite(minMultiplier) ? Math.max(0, minMultiplier) : 0;
  const secondMultiplier = Number.isFinite(maxMultiplier) ? Math.max(0, maxMultiplier) : firstMultiplier;
  const lowerMultiplier = Math.min(firstMultiplier, secondMultiplier);
  const upperMultiplier = Math.max(firstMultiplier, secondMultiplier);
  const absoluteCap = Number.isFinite(absoluteMaxMs) ? Math.max(0, absoluteMaxMs) : center * upperMultiplier;
  const lo = Math.min(center * lowerMultiplier, absoluteCap);
  const hi = Math.min(center * upperMultiplier, absoluteCap);
  if (!(hi > lo)) return Math.round(Math.max(0, hi));

  const raw = center * Math.exp(sigma * gaussian(random));
  const span = hi - lo;
  const period = 2 * span;
  let t = (raw - lo) % period;
  if (t < 0) t += period;
  const folded = t <= span ? lo + t : hi - (t - span);
  return Math.round(folded);
}
