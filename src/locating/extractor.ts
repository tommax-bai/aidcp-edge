/**
 * DOM 作用域元素抽取。
 *
 * 作用：把页面（或某作用域容器）内的可交互元素抽取成结构化清单，
 * 供匹配器（命中）或文本 LLM（缺口时选择）使用。
 *
 * 关键点：
 * - 不输出混淆 class；输出 role/text/稳定属性 + 结构路径（tag+nth）。
 * - 支持作用域限定，把"当前笔记/当前会话"内的元素单独抽取，天然消歧。
 * - 作用于通用 DOM（浏览器 page.evaluate 或 jsdom 均可）。
 */

import type { ElementDescriptor, ScopeSpec } from './types.js';

/** 视为"可交互"的标签 */
const INTERACTIVE_TAGS = new Set([
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
]);

/** 视为"可交互"的 role */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'switch',
  'textbox',
  'searchbox',
  'option',
]);

/** 抽取出的稳定属性白名单（混淆 class 不在其中） */
const STABLE_ATTRS = [
  'role',
  'type',
  'name',
  'placeholder',
  'aria-label',
  'aria-labelledby',
  'alt',
  'title',
  'value',
  'href',
  'contenteditable',
  'data-testid',
  'data-id',
  'data-key',
  'data-type',
];

/**
 * 反混淆"语义 class 白名单"。
 *
 * 设计原则（与反混淆设计一致）：**绝不信任任意 class**。混淆构建会把 class
 * 打成随机串（如 .css-1a2b3c），不可作为定位依据；但少数站点（典型如小红书）
 * 对核心互动控件保留**人类可读、跨改版稳定的语义 class**（like-wrapper /
 * comment-wrapper / collect-wrapper / share-wrapper）。这些是手写语义而非
 * 编译产物，值得作为"稳定属性"参与匹配。
 *
 * 只认这里列出的精确语义片段：用单词边界匹配（- _ 或串首尾分隔），既容忍
 * BEM/前缀（note-footer__like-wrapper、xhs-like-wrapper），又不会把随机串
 * 里偶然出现的子串误当语义命中。
 */
const SEMANTIC_CLASS_PATTERNS = [
  'like-wrapper',
  'comment-wrapper',
  'collect-wrapper',
  'share-wrapper',
] as const;

export type SemanticClass = (typeof SEMANTIC_CLASS_PATTERNS)[number];

/**
 * 从元素 class 中识别"已知语义 class"。命中返回规范化的语义片段，否则 null。
 * 用单词边界（class token 内以 - _ 或边界分隔）匹配，避免子串误命中。
 */
export function matchSemanticClass(el: Element): SemanticClass | null {
  const raw = el.getAttribute('class');
  if (!raw) return null;
  const tokens = raw.split(/\s+/);
  for (const token of tokens) {
    const lower = token.toLowerCase();
    for (const pat of SEMANTIC_CLASS_PATTERNS) {
      // 边界匹配：pat 必须是整个 token，或被 - _ 包裹（容忍 BEM/前缀）。
      const re = new RegExp('(^|[-_])' + pat + '($|[-_])');
      if (re.test(lower)) return pat;
    }
  }
  return null;
}

export interface ExtractOptions {
  /** 文本裁剪长度上限 */
  maxTextLength?: number;
  /** 可见性判定（默认 best-effort，可注入浏览器精确实现） */
  isVisible?: (el: Element) => boolean;
  /**
   * 作用域兜底策略：当指定了 scope 但在 root 内找不到对应容器时的行为。
   * - 'empty'（默认）：返回空清单（严格作用域，保持既有契约）。
   * - 'root'：降级为在整个 root 内抽取（best-effort 作用域）。
   *
   * 小红书场景下用 'root'：explore 页打开笔记弹层时 scope 命中、只抽弹层内的
   * 唯一点赞控件；而单条笔记页/无弹层时 scope 落空，则降级整页抽取不致漏抽。
   */
  scopeFallback?: 'empty' | 'root';
}

/** 由标签 + 属性推导角色 */
export function deriveRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.toLowerCase();
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
      return 'button';
    case 'textarea':
      return 'textbox';
    case 'select':
      return 'combobox';
    case 'summary':
      return 'button';
    case 'input': {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    default:
      if (el.getAttribute('contenteditable') === 'true') return 'textbox';
      return 'generic';
  }
}

/** 计算可见文本 / 可访问名（优先无障碍属性） */
export function accessibleName(el: Element, maxLen = 80): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return clip(aria.trim(), maxLen);
  const alt = el.getAttribute('alt');
  if (alt && alt.trim()) return clip(alt.trim(), maxLen);
  const placeholder = el.getAttribute('placeholder');
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const value = (el as HTMLInputElement).value;
    if (value && value.trim()) return clip(value.trim(), maxLen);
    if (placeholder && placeholder.trim()) return clip(placeholder.trim(), maxLen);
  }
  const title = el.getAttribute('title');
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) return clip(text, maxLen);
  if (title && title.trim()) return clip(title.trim(), maxLen);
  if (placeholder && placeholder.trim()) return clip(placeholder.trim(), maxLen);
  return '';
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** best-effort 可见性：jsdom 无布局，仅看显式隐藏标记 */
export function defaultIsVisible(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.hasAttribute('hidden')) return false;
  const style = el.getAttribute('style') || '';
  if (/display\s*:\s*none/i.test(style)) return false;
  if (/visibility\s*:\s*hidden/i.test(style)) return false;
  return true;
}

/** 是否可交互 */
export function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
  if (el.getAttribute('contenteditable') === 'true') return true;
  if (el.hasAttribute('onclick')) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && tabindex !== '-1') return true;
  // 反混淆白名单：无障碍属性缺失但带"已知语义 class"的控件（如小红书 span.like-wrapper）
  // 也视为可交互，否则无 aria/role/text 的站点会被整体漏抽。
  if (matchSemanticClass(el)) return true;
  return false;
}

/** 抽取稳定属性子集 */
export function pickAttributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of STABLE_ATTRS) {
    const v = el.getAttribute(name);
    if (v !== null && v !== '') out[name] = v;
  }
  // 透传所有 data-* 属性
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-') && !(attr.name in out)) {
      out[attr.name] = attr.value;
    }
  }
  return out;
}

/**
 * 构建结构路径（类 XPath，tag + nth-of-type），从 root（含）到 el。
 * 不使用混淆 class，改版时比 class 稳。
 */
export function buildPath(el: Element, root?: Element | Document): string {
  const parts: string[] = [];
  let node: Element | null = el;
  const stopAt = root && 'tagName' in root ? (root as Element) : undefined;
  while (node && node.nodeType === 1) {
    if (stopAt && node === stopAt) break;
    const tag = node.tagName.toLowerCase();
    let nth = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName.toLowerCase() === tag) nth++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${tag}[${nth}]`);
    node = node.parentElement;
  }
  return (stopAt ? './' : '/') + parts.join('/');
}

/** 在 root 内查找匹配 ScopeSpec 的作用域容器（返回首个匹配） */
export function findScope(
  root: Element | Document,
  scope: ScopeSpec,
): Element | null {
  // CSS 选择器优先：用于无稳定 role/text/属性、仅有特征性容器 class 的场景
  // （如小红书笔记详情弹层）。selector 可逗号分隔多个候选，querySelector
  // 天然按文档顺序取首个命中。选择器非法时不抛错，降级到下方 role/text 路径。
  if (scope.selector) {
    let hit: Element | null = null;
    try {
      hit = root.querySelector(scope.selector);
    } catch {
      hit = null; // 非法选择器：忽略，继续走 role/text/attributes 兜底
    }
    if (hit) return hit;
  }
  // 若只指定了 selector（无 role/text/attributes 约束）且未命中，则视为未找到容器，
  // 交由上层 scopeFallback 决定降级行为。否则继续走 role/text/attributes 兜底匹配。
  // 注意：缺这道判断会让无约束的兜底循环命中文档首个元素（如 <html>），误判为命中。
  if (
    scope.role === undefined &&
    scope.containsText === undefined &&
    scope.attributes === undefined
  ) {
    return null;
  }
  const all = Array.from(root.querySelectorAll('*')) as Element[];
  for (const el of all) {
    if (scope.role) {
      if (deriveRole(el) !== scope.role.toLowerCase()) continue;
    }
    if (scope.attributes) {
      let ok = true;
      for (const [k, v] of Object.entries(scope.attributes)) {
        if (el.getAttribute(k) !== v) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    if (scope.containsText) {
      const text = (el.textContent || '').replace(/\s+/g, ' ');
      if (!text.includes(scope.containsText)) continue;
    }
    return el;
  }
  return null;
}

/**
 * 抽取可交互元素清单。
 * @param root 抽取根（document 或作用域容器）
 * @param scope 可选作用域：若提供，先在 root 内定位容器，仅抽取容器内元素
 */
export function extractInteractiveElements(
  root: Element | Document,
  scope?: ScopeSpec,
  options: ExtractOptions = {},
): ElementDescriptor[] {
  const maxTextLength = options.maxTextLength ?? 80;
  const isVisible = options.isVisible ?? defaultIsVisible;

  let container: Element | Document = root;
  let scopeEl: Element | null = null;
  if (scope) {
    scopeEl = findScope(root, scope);
    if (!scopeEl) {
      // 作用域容器未命中：按兜底策略决定空清单（严格）或整页抽取（best-effort）。
      if (options.scopeFallback === 'root') {
        container = root;
      } else {
        return [];
      }
    } else {
      container = scopeEl;
    }
  }

  const all = Array.from(container.querySelectorAll('*')) as Element[];
  const descriptors: ElementDescriptor[] = [];
  let index = 0;
  for (const el of all) {
    if (!isInteractive(el)) continue;
    if (!isVisible(el)) continue;
    const descriptor: ElementDescriptor = {
      index: index++,
      role: deriveRole(el),
      tag: el.tagName.toLowerCase(),
      text: accessibleName(el, maxTextLength),
      attributes: pickAttributes(el),
      clickable: true,
      path: buildPath(el),
    };
    const semantic = matchSemanticClass(el);
    if (semantic) descriptor.classHint = semantic;
    if (scopeEl) descriptor.scopePath = buildPath(scopeEl);
    descriptors.push(descriptor);
  }
  return descriptors;
}
