/**
 * 搜索执行：响应云端的 search.execute 指令。
 *
 * 流程：展开搜索框（XHS explore 默认收起）→ 聚焦 → 清空旧值 → 逐字符拟人化输入关键词
 *      → 回车 → 等待导航到搜索结果页 → 等待瀑布流卡片加载。
 * 搜索结果页结构与 explore 类似（瀑布流卡片），调用方可继续复用 FeedScroller。
 *
 * 实现用 CDP：
 *  - explore 页搜索框 #search-input 默认收起（offsetWidth=0、不可见），直接 focus/输入
 *    虽不报错但不会触发原生搜索导航，必须先点击 div.search-icon 展开；
 *  - 展开后在页面侧聚焦/清空搜索框（document.querySelector + focus），
 *    再用拟人化键盘节奏逐字符输入（docs/anti-detection.md §5.2）、派发 Enter；
 *  - 最后轮询 location.href 确认已导航到搜索结果页。
 */

import type { BrowseCdp } from './cdp-util.js';
import { evalRaw, dispatchClick, dispatchKeystrokes, pressEnter, type RandomFn } from './cdp-util.js';
import { sampleDelay, TIMING_PRESETS } from '../humanize/index.js';

/** 小红书搜索框常见选择器（按优先级） */
export const XHS_SEARCH_INPUT_SELECTOR =
  '#search-input, input#search-input, input[placeholder*="搜索"], ' +
  'input[type="search"], [class*="search"] input';

/** 搜索图标选择器（点击后展开搜索框） */
export const XHS_SEARCH_ICON_SELECTOR = 'div.search-icon, .search-icon';

export interface ExecuteSearchDeps {
  cdp: BrowseCdp;
  /** 随机源（延迟抖动 + 键盘节奏用） */
  random?: RandomFn;
  /** 注入 sleep（测试用） */
  sleep?: (ms: number) => Promise<void>;
  /** 搜索框选择器（默认 XHS_SEARCH_INPUT_SELECTOR） */
  searchSelector?: string;
  /** 搜索图标选择器（默认 XHS_SEARCH_ICON_SELECTOR） */
  searchIconSelector?: string;
  /** 日志输出（默认 console.log） */
  logger?: (msg: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 生成"聚焦并清空搜索框"的 JS（命中返回 true） */
function buildFocusClearJs(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    try {
      var setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
      if (setter && setter.set) { setter.set.call(el, ''); } else { el.value = ''; }
      el.dispatchEvent(new Event('input', {bubbles:true}));
    } catch (e) {}
    return true;
  })()`;
}

/** 生成"检查搜索框是否可见（offsetWidth>0）"的 JS（可见返回 true） */
function buildIsVisibleJs(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    return el.offsetWidth > 0;
  })()`;
}

/** 生成"取搜索图标中心坐标"的 JS（返回 JSON 字符串 {x,y} 或 null） */
function buildIconRectJs(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return null;
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`;
}

/**
 * 展开搜索框：点击搜索图标，等待输入框 offsetWidth>0。
 *
 * XHS explore 页搜索框默认收起（width=0、不可见），直接 focus/输入不会触发搜索导航，
 * 必须先点击 div.search-icon 展开。
 *
 * @returns 是否成功展开（输入框变为可见）。
 */
export async function expandSearchBar(
  cdp: BrowseCdp,
  sleep: (ms: number) => Promise<void>,
  options: {
    inputSelector?: string;
    iconSelector?: string;
    random?: RandomFn;
    timeout?: number;
  } = {},
): Promise<boolean> {
  const inputSelector = options.inputSelector ?? XHS_SEARCH_INPUT_SELECTOR;
  const iconSelector = options.iconSelector ?? XHS_SEARCH_ICON_SELECTOR;
  const timeout = options.timeout ?? 2000;

  // 取搜索图标坐标
  const rectRaw = await evalRaw<string | null>(cdp, buildIconRectJs(iconSelector));
  if (!rectRaw) return false;
  let rect: { x: number; y: number };
  try {
    rect =
      typeof rectRaw === 'string'
        ? (JSON.parse(rectRaw) as { x: number; y: number })
        : (rectRaw as { x: number; y: number });
  } catch {
    return false;
  }

  // 拟人化点击展开
  await dispatchClick(cdp, rect.x, rect.y, { random: options.random, sleep });

  // 轮询等待输入框可见（最多 timeout ms）
  const interval = 100;
  let waited = 0;
  while (waited < timeout) {
    const visible = await evalRaw<boolean>(cdp, buildIsVisibleJs(inputSelector));
    if (visible === true) return true;
    await sleep(interval);
    waited += interval;
  }
  // 最后再判一次
  return (await evalRaw<boolean>(cdp, buildIsVisibleJs(inputSelector))) === true;
}

/**
 * 等待搜索导航完成：轮询 location.href 直到包含 "search_result" 或 "search"。
 *
 * @returns 是否在超时内确认导航到搜索结果页。
 */
export async function waitForSearchNavigation(
  cdp: BrowseCdp,
  sleep: (ms: number) => Promise<void>,
  timeout = 5000,
): Promise<boolean> {
  const interval = 200;
  let waited = 0;
  const check = `(function(){ return location.href; })()`;
  while (waited <= timeout) {
    const href = await evalRaw<string>(cdp, check);
    if (typeof href === 'string' && (href.includes('search_result') || href.includes('search'))) {
      return true;
    }
    await sleep(interval);
    waited += interval;
  }
  return false;
}

/**
 * 执行一次搜索。
 * @throws 当页面上找不到搜索框时抛错（调用方可据此降级/上报）。
 */
export async function executeSearch(
  keyword: string,
  deps: ExecuteSearchDeps,
): Promise<void> {
  const { cdp } = deps;
  const selector = deps.searchSelector ?? XHS_SEARCH_INPUT_SELECTOR;
  const iconSelector = deps.searchIconSelector ?? XHS_SEARCH_ICON_SELECTOR;
  const random = deps.random;
  const sleep = deps.sleep ?? defaultSleep;
  const logger = deps.logger ?? ((m: string) => console.log(m));

  // 1. 检查搜索框是否已展开（可见）；收起时先点击 search-icon 展开。
  const visible = await evalRaw<boolean>(cdp, buildIsVisibleJs(selector));
  if (visible !== true) {
    logger('[search] 展开搜索框');
    await expandSearchBar(cdp, sleep, { inputSelector: selector, iconSelector, random });
  }

  // 2. 聚焦并清空搜索框。
  const focused = await evalRaw<boolean>(cdp, buildFocusClearJs(selector));
  if (focused !== true) {
    throw new Error(`搜索框未找到（selector: ${selector}）`);
  }
  // 逐字符拟人化输入（不再一次性 insertText 整段）。
  await dispatchKeystrokes(cdp, keyword, { random, sleep });
  // 输入完到回车的"想一下"停顿（操作间对数正态）。
  await sleep(sampleDelay(TIMING_PRESETS.action, random));
  await pressEnter(cdp);

  // 3. 等待导航到搜索结果页（轮询 URL，最多 5 秒）。
  const navigated = await waitForSearchNavigation(cdp, sleep, 5000);
  if (navigated) {
    const href = await evalRaw<string>(cdp, `(function(){ return location.href; })()`);
    logger(`[search] 搜索导航成功: ${href}`);
    // 4. 额外等待让搜索结果卡片加载。
    await sleep(sampleDelay(TIMING_PRESETS.reading, random));
  } else {
    // 兜底：即使未确认导航，也给结果页渲染留出时间。
    await sleep(sampleDelay(TIMING_PRESETS.reading, random));
  }
}
