import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

/**
 * 小红书注入脚本（页面规则）的 jsdom 夹具。
 *
 * 几何（task 1.12）：**不再**在原型上钉死一个固定的 100×40 —— 那会让
 * `xhs-command-router.js` 的宽高可见性判定恒真，可见性相关的断言全无保护力。
 * 这里按元素解析几何，优先级：
 *   ① 用例通过 `setRect()` 显式指定的几何；
 *   ② 元素上的 `data-test-rect="宽,高"` 属性；
 *   ③ 已从文档移除的节点（`isConnected===false`）→ 零几何（不可见）；
 *   ④ 计算样式为 display:none / visibility:hidden → 零几何（不可见）；
 *   ⑤ 其余在档节点 → 默认可见几何。
 * 于是「可见 / 不可见」在测试里真有两态，用例可以自己造出不可见控件。
 */
export interface FixtureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const VISIBLE_RECT: FixtureRect = { x: 0, y: 0, width: 100, height: 40 };
const ZERO_RECT: FixtureRect = { x: 0, y: 0, width: 0, height: 0 };

export interface RouterResult {
  effectPhase: string;
  output: { kind: string; value: Record<string, unknown> };
}

export type RouterInput = { kind: string; params: Record<string, unknown> };

export interface XhsDomFixture {
  dom: JSDOM;
  /** 给某个元素（或选择器命中的全部元素）单独指定几何；传 null 撤销。宽高为 0 即「不可见」。 */
  setRect(target: Element | string, rect: Partial<FixtureRect> | null): void;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const routerSource = await readFile(
  resolve(repoRoot, 'native/page-engine/src/xhs-command-router.js'),
  'utf8',
);

export const runXhsRouter = Function(`return (${routerSource})`)() as (
  input: RouterInput,
) => Promise<RouterResult>;

const searchInputSource = await readFile(
  resolve(repoRoot, 'native/page-engine/src/xhs-search-input-geometry.js'),
  'utf8',
);

export const runXhsSearchInput = Function(`return (${searchInputSource})`)() as (
  mode: 'geometry' | 'focus' | 'focus-clear',
) => { found: boolean; focused?: boolean; value?: string; x?: number; y?: number };

export function installXhsDom(html: string, url = 'https://www.xiaohongshu.com/explore'): XhsDomFixture {
  const dom = new JSDOM(html, { url });
  const win = dom.window as unknown as Record<string, unknown>;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    innerHeight: 800,
  });

  const overrides = new WeakMap<Element, FixtureRect>();

  const fromAttribute = (el: Element): FixtureRect | null => {
    const raw = typeof el.getAttribute === 'function' ? el.getAttribute('data-test-rect') : null;
    if (!raw) return null;
    const parts = raw.split(',').map((piece) => Number(piece.trim()));
    if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) return null;
    return { x: 0, y: 0, width: parts[0], height: parts[1] };
  };

  const hiddenByStyle = (el: Element): boolean => {
    try {
      const style = dom.window.getComputedStyle(el as HTMLElement);
      return style.display === 'none' || style.visibility === 'hidden';
    } catch {
      return false;
    }
  };

  const rectOf = (el: Element): FixtureRect => {
    const explicit = overrides.get(el);
    if (explicit) return explicit;
    const declared = fromAttribute(el);
    if (declared) return declared;
    if (!el.isConnected) return ZERO_RECT;
    if (hiddenByStyle(el)) return ZERO_RECT;
    return VISIBLE_RECT;
  };

  Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      const rect = rectOf(this);
      return {
        x: rect.x,
        y: rect.y,
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        width: rect.width,
        height: rect.height,
      };
    },
  });
  Object.defineProperty(dom.window.Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  });
  win.scrollBy = () => undefined;

  const setRect: XhsDomFixture['setRect'] = (target, rect) => {
    const elements =
      typeof target === 'string'
        ? Array.from(dom.window.document.querySelectorAll(target))
        : [target];
    for (const element of elements) {
      if (rect === null) {
        overrides.delete(element);
        continue;
      }
      overrides.set(element, { ...VISIBLE_RECT, ...rect });
    }
  };

  return { dom, setRect };
}
