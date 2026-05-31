/**
 * 多信号一致性匹配。
 *
 * 反"静默误命中"是这里的核心职责：
 * - 不是"找到第一个就点"，而是对每个候选按 anchor 指定的多个信号（role/text/attrs）打分；
 * - 只有当**唯一**候选同时满足"置信度达标 + 与次佳分差达标"才判 hit；
 * - 否则判 ambiguous / miss，交由上层降级到文本 LLM 重选，宁可多花一次也不点错。
 */

import type { Anchor, ElementDescriptor, MatchResult } from './types.js';

export interface MatchThresholds {
  /** 最低置信度（匹配到的信号权重占比） */
  confThreshold: number;
  /** 最佳与次佳的最小分差，保证唯一性 */
  marginThreshold: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = {
  confThreshold: 0.6,
  marginThreshold: 0.15,
};

const WEIGHT_ROLE = 1.0;
const WEIGHT_TEXT = 2.0;
const WEIGHT_ATTR = 1.0;

interface Scored {
  el: ElementDescriptor;
  score: number;
}

function textMatches(anchorText: string, mode: 'exact' | 'contains', elText: string): boolean {
  if (mode === 'exact') return anchorText === elText;
  // contains：双向包含都算（锚点是元素文本子串，或反之）
  return elText.includes(anchorText) || anchorText.includes(elText);
}

/** 对单个元素按锚点指定信号打分，返回 [matched, specified] 权重 */
function scoreElement(anchor: Anchor, el: ElementDescriptor): number {
  let matched = 0;
  let specified = 0;

  if (anchor.role) {
    specified += WEIGHT_ROLE;
    if (anchor.role.toLowerCase() === el.role) matched += WEIGHT_ROLE;
  }

  if (anchor.text) {
    specified += WEIGHT_TEXT;
    const mode = anchor.textMatch ?? 'contains';
    if (el.text && textMatches(anchor.text, mode, el.text)) matched += WEIGHT_TEXT;
  }

  if (anchor.attributes) {
    for (const [k, v] of Object.entries(anchor.attributes)) {
      specified += WEIGHT_ATTR;
      if (el.attributes[k] === v) matched += WEIGHT_ATTR;
    }
  }

  if (specified === 0) return 0;
  return matched / specified;
}

/**
 * 在候选元素清单中匹配锚点。
 */
export function matchAnchor(
  anchor: Anchor,
  elements: ElementDescriptor[],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchResult {
  if (elements.length === 0) {
    return {
      status: 'miss',
      candidates: [],
      confidence: 0,
      margin: 0,
      reason: 'no_elements_in_scope',
    };
  }

  const scored: Scored[] = elements
    .map((el) => ({ el, score: scoreElement(anchor, el) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  const confidence = best.score;
  const margin = confidence - (second ? second.score : 0);

  if (confidence < thresholds.confThreshold) {
    return {
      status: 'miss',
      candidates: scored.filter((s) => s.score > 0).map((s) => s.el),
      confidence,
      margin,
      reason: `below_conf_threshold(${confidence.toFixed(2)}<${thresholds.confThreshold})`,
    };
  }

  if (margin < thresholds.marginThreshold) {
    // 置信度够，但有并列/接近候选 → 不唯一 → 防误命中，降级 LLM
    const tied = scored.filter((s) => confidence - s.score < thresholds.marginThreshold);
    return {
      status: 'ambiguous',
      candidates: tied.map((s) => s.el),
      confidence,
      margin,
      reason: `ambiguous_top_margin(${margin.toFixed(2)}<${thresholds.marginThreshold})`,
    };
  }

  return {
    status: 'hit',
    element: best.el,
    candidates: [best.el],
    confidence,
    margin,
    reason: 'unique_high_confidence',
  };
}
