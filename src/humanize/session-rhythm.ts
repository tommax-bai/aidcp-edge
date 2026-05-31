/**
 * 会话节奏曲线（热身 → 自然 → 轻微加速 → 疲劳）。
 *
 * 背景（见 docs/risk-control.md §3.4）：真人不是匀速刷内容的。一次会话内的操作速度
 * 有疲劳曲线——刚打开 App 在"逛"（慢），中段节奏稳定，后段疲劳停顿变长。当前实现
 * 全程恒定节奏，是机器特征。
 *
 * 本模块把会话进度(0..1)映射为一个"速度系数"：
 *   speedFactor > 1 → 更快（停顿更短）
 *   speedFactor < 1 → 更慢（停顿更长）
 * 用法：实际停顿 = sampleDelay(preset) / speedFactor。
 */

/** 会话节奏接口 */
export interface SessionRhythm {
  /** 根据会话进度(0..1)返回速度系数(>1=更快, <1=更慢) */
  getSpeedFactor(progress: number): number;
}

/** 单个节奏分段：[起点, 终点) 进度区间内的速度系数 */
export interface RhythmPhase {
  /** 进度上界（不含），最后一段应为 1 */
  until: number;
  /** 该段速度系数 */
  factor: number;
}

/**
 * 默认节奏曲线（docs/risk-control.md §3.4）：
 *  - 0–0.15  热身期：系数 0.7（慢 30%）
 *  - 0.15–0.7 正常期：系数 1.0
 *  - 0.7–0.85 轻微加速：系数 1.1（刷快了一点）
 *  - 0.85–1.0 疲劳期：系数 0.8（慢下来了）
 */
export const DEFAULT_PHASES: RhythmPhase[] = [
  { until: 0.15, factor: 0.7 },
  { until: 0.7, factor: 1.0 },
  { until: 0.85, factor: 1.1 },
  { until: 1.0, factor: 0.8 },
];

/** 把进度裁剪到 [0,1] */
function clampProgress(p: number): number {
  if (Number.isNaN(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/** 分段常数节奏曲线 */
export class PhaseSessionRhythm implements SessionRhythm {
  private readonly phases: RhythmPhase[];

  constructor(phases: RhythmPhase[] = DEFAULT_PHASES) {
    // 复制并按 until 升序，确保查找正确
    this.phases = [...phases].sort((a, b) => a.until - b.until);
  }

  getSpeedFactor(progress: number): number {
    const p = clampProgress(progress);
    for (const phase of this.phases) {
      if (p < phase.until) return phase.factor;
    }
    // p 落在最后一段上界（通常 p===1）：返回最后一段系数
    return this.phases.length > 0 ? this.phases[this.phases.length - 1].factor : 1.0;
  }
}

/** 便捷构造默认曲线 */
export function createDefaultRhythm(): SessionRhythm {
  return new PhaseSessionRhythm();
}

/** 把停顿按速度系数缩放（系数越大停顿越短）。返回取整毫秒，下限 1ms。 */
export function applySpeedFactor(delayMs: number, speedFactor: number): number {
  const f = speedFactor > 0 ? speedFactor : 1.0;
  return Math.max(1, Math.round(delayMs / f));
}
