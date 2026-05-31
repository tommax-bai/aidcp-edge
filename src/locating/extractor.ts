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

export interface ExtractOptions {
  /** 文本裁剪长度上限 */
  maxTextLength?: number;
  /** 可见性判定（默认 best-effort，可注入浏览器精确实现） */
  isVisible?: (el: Element) => boolean;
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
    if (!scopeEl) return [];
    container = scopeEl;
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
    if (scopeEl) descriptor.scopePath = buildPath(scopeEl);
    descriptors.push(descriptor);
  }
  return descriptors;
}
