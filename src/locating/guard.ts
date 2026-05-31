/**
 * 守卫层：清理偶现干扰（弹窗/遮罩/活动浮层/青少年模式/登录过期提示）。
 *
 * 每个原子操作前先扫一遍 DOM，发现已知干扰 → 上层先处置（关闭/跳过）再继续主流程。
 * 规则枚举不完的部分，可注入 LLM 判定兜底（detectExtra）。
 */

import type { ElementDescriptor, GuardHit } from './types.js';
import {
  accessibleName,
  buildPath,
  deriveRole,
  defaultIsVisible,
  pickAttributes,
} from './extractor.js';

/** 单条守卫规则 */
export interface GuardRule {
  id: string;
  /** 在容器上匹配（CSS 选择器或自定义判定） */
  match: (el: Element) => boolean;
  /** 在该干扰容器内寻找"关闭/取消"按钮的判定 */
  findDismiss?: (container: Element) => Element | null;
  /** 关闭按钮对应的 actionId（供执行层使用） */
  dismissActionId?: string;
}

function toDescriptor(el: Element, index: number): ElementDescriptor {
  return {
    index,
    role: deriveRole(el),
    tag: el.tagName.toLowerCase(),
    text: accessibleName(el),
    attributes: pickAttributes(el),
    clickable: true,
    path: buildPath(el),
  };
}

/** 常见小红书/通用干扰的内置规则（按文本/role/属性识别，不依赖混淆 class） */
export const DEFAULT_GUARD_RULES: GuardRule[] = [
  {
    id: 'modal_dialog',
    match: (el) => deriveRole(el) === 'dialog' || el.getAttribute('aria-modal') === 'true',
    findDismiss: (c) => findByText(c, ['关闭', '取消', '知道了', '我知道了', '稍后再说', '跳过']),
    dismissActionId: 'guard.dismiss_dialog',
  },
  {
    id: 'overlay_mask',
    match: (el) =>
      el.getAttribute('data-type') === 'mask' ||
      /(^|\s)(mask|overlay|backdrop)(\s|$)/i.test(el.getAttribute('data-role') || ''),
    dismissActionId: 'guard.dismiss_mask',
  },
  {
    id: 'login_expired',
    match: (el) => {
      const t = (el.textContent || '').replace(/\s+/g, '');
      return /登录已过期|重新登录|登录失效/.test(t) && deriveRole(el) === 'dialog';
    },
    dismissActionId: 'guard.login_expired',
  },
];

/** 在容器内按可见文本找按钮（关闭类） */
export function findByText(container: Element, texts: string[]): Element | null {
  const candidates = Array.from(container.querySelectorAll('*')) as Element[];
  for (const el of candidates) {
    const role = deriveRole(el);
    if (role !== 'button' && role !== 'link') continue;
    if (!defaultIsVisible(el)) continue;
    const name = accessibleName(el);
    if (texts.some((t) => name.includes(t))) return el;
  }
  return null;
}

export interface ExtraDetector {
  /** 返回挡路元素（如有），用于规则枚举不到的偶现干扰 */
  detect(root: Element | Document): Promise<ElementDescriptor | null>;
}

/**
 * 扫描页面已知干扰。
 */
export function scanInterrupts(
  root: Element | Document,
  rules: GuardRule[] = DEFAULT_GUARD_RULES,
): GuardHit[] {
  const hits: GuardHit[] = [];
  const all = Array.from(root.querySelectorAll('*')) as Element[];
  let idx = 0;
  for (const rule of rules) {
    for (const el of all) {
      if (!defaultIsVisible(el)) continue;
      if (!rule.match(el)) continue;
      const dismissEl = rule.findDismiss ? rule.findDismiss(el) : null;
      const hit: GuardHit = {
        ruleId: rule.id,
        element: toDescriptor(dismissEl ?? el, idx++),
      };
      if (rule.dismissActionId) hit.dismissActionId = rule.dismissActionId;
      hits.push(hit);
      break; // 同一规则命中一次即可
    }
  }
  return hits;
}
