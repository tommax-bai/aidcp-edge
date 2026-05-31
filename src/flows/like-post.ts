/**
 * 点赞流程（XHS 垂直切片）。
 *
 * 把"定位层引擎 + CDP 执行器"组装成一个可独立调用的点赞动作：
 *  1) 用 LocatingEngine 在当前笔记页定位点赞按钮（缓存优先 → 文本 LLM 兜底）；
 *  2) 通过 CdpActionExecutor 执行 click；
 *  3) 后置校验"点赞态是否真实翻转"（aria-pressed / 选中类名 / 可访问名变化），
 *     校验不过判失败，绝不静默成功（复用引擎三道闸）。
 *
 * 该模块不直接连 CDP，依赖通过 EngineDeps 注入，便于单测（jsdom + 假执行器）。
 */

import { LocatingEngine } from '../locating/engine.js';
import type {
  ActionResult,
  ElementDescriptor,
  PostValidator,
  ActionRequest,
} from '../locating/index.js';
import type { EngineDeps, EngineOptions } from '../locating/engine.js';
import {
  XHS_LIKE_ACTION_ID,
  XHS_LIKE_ANCHOR_HINT,
  XHS_LIKE_GOAL,
} from './anchors.js';

/** "已点赞"态的判定信号（任一命中即视为点赞已生效） */
const LIKED_ATTR_SIGNALS: Array<{ attr: string; value: string }> = [
  { attr: 'aria-pressed', value: 'true' },
  { attr: 'aria-selected', value: 'true' },
  { attr: 'data-liked', value: 'true' },
  { attr: 'data-selected', value: 'true' },
];

/** "已点赞"态的文本/类名关键词（可访问名或 class 含其一即视为已点赞） */
const LIKED_TEXT_SIGNALS = ['已点赞', '取消点赞', 'liked', 'active', 'selected'];

/**
 * 在某元素及其祖先/自身上判断是否处于"已点赞"态。
 * 真实页面里点赞翻转可能落在按钮自身或其包裹容器上，故向上回溯有限层级。
 */
export function isLikedElement(el: Element | null): boolean {
  let node: Element | null = el;
  let hops = 0;
  while (node && hops < 3) {
    for (const sig of LIKED_ATTR_SIGNALS) {
      if (node.getAttribute(sig.attr) === sig.value) return true;
    }
    const cls = (node.getAttribute('class') || '').toLowerCase();
    const aria = (node.getAttribute('aria-label') || '').toLowerCase();
    const title = (node.getAttribute('title') || '').toLowerCase();
    for (const kw of LIKED_TEXT_SIGNALS) {
      const k = kw.toLowerCase();
      if (cls.includes(k) || aria.includes(k) || title.includes(k)) return true;
    }
    node = node.parentElement;
    hops++;
  }
  return false;
}

/**
 * 点赞后置校验器：在操作后的 DOM 里，寻找点赞相关控件并判断其是否已翻转为"已点赞"态。
 *
 * 策略：扫描所有可能的点赞控件（可访问名/title/aria-label 含"点赞/赞/like/喜欢/心形"），
 * 只要其中之一进入已点赞态即判通过。这样既能覆盖"按钮自身翻转"也能覆盖"容器翻转"。
 */
export class LikePostValidator implements PostValidator {
  validate(_req: ActionRequest, root: Element | Document): boolean {
    const candidates = findLikeControls(root);
    for (const el of candidates) {
      if (isLikedElement(el)) return true;
    }
    return false;
  }
}

/** 在 DOM 中找出疑似"点赞控件"的元素（用于后置校验定位翻转目标） */
function findLikeControls(root: Element | Document): Element[] {
  const all = Array.from(root.querySelectorAll('*')) as Element[];
  const hints = ['点赞', '赞', 'like', '喜欢', 'heart', '心形'];
  return all.filter((el) => {
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const text = (el.textContent || '').toLowerCase();
    const cls = (el.getAttribute('class') || '').toLowerCase();
    return hints.some(
      (h) =>
        aria.includes(h.toLowerCase()) ||
        title.includes(h.toLowerCase()) ||
        cls.includes(h.toLowerCase()) ||
        (text.length < 30 && text.includes(h.toLowerCase())),
    );
  });
}

export interface LikePostOptions extends EngineOptions {
  /** 透传给引擎的覆盖项（maxAttempts 等） */
}

/** 构造点赞用的 ActionRequest */
export function buildLikeRequest(goal = XHS_LIKE_GOAL): ActionRequest {
  return {
    actionId: XHS_LIKE_ACTION_ID,
    op: 'click',
    goal,
    anchorHint: XHS_LIKE_ANCHOR_HINT,
  };
}

/**
 * 执行一次点赞：用注入的引擎依赖（dom/executor/selector/validator/cache）跑五层编排。
 * 若调用方未提供 validator，则默认用 LikePostValidator。
 */
export async function likePost(
  deps: Omit<EngineDeps, 'validator'> & { validator?: PostValidator },
  options: LikePostOptions = {},
  goal?: string,
): Promise<ActionResult> {
  const validator = deps.validator ?? new LikePostValidator();
  const engine = new LocatingEngine({ ...deps, validator }, options);
  return engine.resolveAndAct(buildLikeRequest(goal));
}

/** 便捷导出：点赞动作选中的元素（调试/上报用） */
export type LikeResultElement = ElementDescriptor | undefined;
