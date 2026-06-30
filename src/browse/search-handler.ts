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

/**
 * 小红书搜索框选择器（按优先级）。当前真机：AI 搜索框是 textarea#search-input
 * （name=aiSearchTextarea，placeholder 为热搜词而非"搜索"，故不能靠 placeholder*=搜索），
 * 位于 .search-area-in-header 内、常驻可见（宽/窄两布局都在，见 docs/xhs-layout-states.md）。
 */
export const XHS_SEARCH_INPUT_SELECTOR =
  // 当前真机：搜索框是 textarea[name=aiSearchTextarea]。宽/窄布局有【两个】实例、id 不同且只有一个可见：
  //   窄布局 → textarea#search-input（header 框，可见）；
  //   宽布局 → textarea#search-input-in-feeds（in-content 大框，可见），而 #search-input 在 display:none 的 ai-header 里。
  // 故选择器同时覆盖两者；取值/聚焦时务必【取可见的那个】（见 buildIsVisibleJs/buildFocusClearJs）。
  'textarea[name="aiSearchTextarea"], textarea#search-input, textarea#search-input-in-feeds, ' +
  '#search-input, #search-input-in-feeds, input#search-input, .search-area-in-header textarea, ' +
  '.search-box-in-content textarea, [class*="search"] textarea, input[placeholder*="搜索"], ' +
  'input[type="search"], [class*="search"] input';

/** 搜索图标选择器（旧 explore 收起态点击展开用；当前布局搜索框常驻，多为冗余但保留兜底）。 */
export const XHS_SEARCH_ICON_SELECTOR = 'div.search-icon, .search-icon';

/** 搜索提交按钮：AI textarea 上 Enter 可能只换行不导航，须点提交按钮兜底（真机 .bottom-box-right-submit-button）。 */
export const XHS_SEARCH_SUBMIT_SELECTOR =
  '.bottom-box-right-submit-button, .search-area-in-header .submit-button, ' +
  '.search-area-in-header [class*="submit"], [class*="search"] [class*="submit-button"]';

/**
 * 搜索结果页原生「排序」标签的中文文案（change comment-search-command）。
 * 真机：搜索结果页顶部一排排序 tab（综合/最新/最多点赞/最多收藏/最多评论），按文案点击最稳（跨布局/类名漂移）。
 */
export const SEARCH_SORT_TEXT: Record<string, string> = {
  comprehensive: '综合',
  latest: '最新',
  most_liked: '最多点赞',
  most_collected: '最多收藏',
  most_commented: '最多评论',
};

/**
 * 搜索结果页原生「发布时间」筛选的中文文案。多在「筛选」面板内（不限/一天内/一周内/半年内）。
 */
export const SEARCH_TIME_TEXT: Record<string, string> = {
  all: '不限',
  one_day: '一天内',
  one_week: '一周内',
  half_year: '半年内',
};

/**
 * 生成「按可见文案精确匹配、取最小面积叶子元素中心坐标」的 JS（返回 JSON {x,y} 或 null）。
 * 精确相等（textContent.trim() === 目标）避免命中包含子节点文案的大容器；取最小面积=最贴近真正可点的那个。
 */
function buildFindByTextRectJs(texts: string[]): string {
  return `(function(){
    var targets = ${JSON.stringify(texts)};
    var nodes = Array.prototype.slice.call(document.querySelectorAll('button,a,span,div,li,label,p'));
    var best = null;
    for (var i=0;i<nodes.length;i++){
      var el = nodes[i];
      var t = (el.textContent||'').trim();
      if (targets.indexOf(t) === -1) continue;
      if (el.offsetParent === null) continue;
      var r = el.getBoundingClientRect();
      if (r.width<=0 || r.height<=0) continue;
      if (r.top<0 || r.left<0) continue;
      var area = r.width*r.height;
      if (!best || area < best.area) best = { area: area, x: r.left+r.width/2, y: r.top+r.height/2 };
    }
    return best ? JSON.stringify({x:best.x,y:best.y}) : null;
  })()`;
}

/** 按可见文案找到元素并拟人化点击其中心；命中并点击返回 true，找不到返回 false（honest，不假点）。 */
async function clickByVisibleText(
  cdp: BrowseCdp,
  texts: string[],
  opts: { random?: RandomFn; sleep: (ms: number) => Promise<void> },
): Promise<boolean> {
  const rectRaw = await evalRaw<string | null>(cdp, buildFindByTextRectJs(texts)).catch(() => null);
  if (!rectRaw) return false;
  let rect: { x: number; y: number };
  try {
    rect = typeof rectRaw === 'string' ? (JSON.parse(rectRaw) as { x: number; y: number }) : (rectRaw as { x: number; y: number });
  } catch {
    return false;
  }
  await dispatchClick(cdp, rect.x, rect.y, { random: opts.random, sleep: opts.sleep });
  return true;
}

export interface ApplySearchFiltersDeps {
  cdp: BrowseCdp;
  random?: RandomFn;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

/**
 * 在搜索结果页应用原生「排序 + 发布时间」筛选（change comment-search-command）。
 *
 * 按需评论任务要「最近一天 + 最多收藏」：靠点平台原生排序 tab（最多收藏）+ 时间筛选（一天内）。
 * 按可见文案点击（跨宽/窄布局、跨类名漂移最稳）。两遍：先当作「行内 tab」直接点；缺则开「筛选」面板再点。
 *
 * 红线（honest）：控件定位失败 → 返回 applied=false，**绝不假装已筛**——云端据此降级回报、不把未筛结果当「最近一天最多收藏」。
 * ⚠️ 选择器/面板机制随搜索页布局变，**待真机标定**（参 docs/xhs-layout-states.md、memory xhs-responsive-nav-layout）。
 */
export async function applySearchFilters(
  opts: { sort?: string; timeWindow?: string },
  deps: ApplySearchFiltersDeps,
): Promise<{ sortApplied: boolean; timeApplied: boolean }> {
  const { cdp } = deps;
  const random = deps.random;
  const sleep = deps.sleep ?? defaultSleep;
  const logger = deps.logger ?? ((m: string) => console.log(m));
  const pause = () => sleep(sampleDelay(TIMING_PRESETS.action, random));

  const wantSort = opts.sort ? SEARCH_SORT_TEXT[opts.sort] : undefined;
  const wantTime = opts.timeWindow ? SEARCH_TIME_TEXT[opts.timeWindow] : undefined;
  if (!wantSort && !wantTime) return { sortApplied: false, timeApplied: false };

  // 第一遍：当作行内 tab 直接按文案点（排序 tab 多为行内常驻）。
  let sortApplied = wantSort ? await clickByVisibleText(cdp, [wantSort], { random, sleep }) : false;
  if (wantSort) await pause();
  let timeApplied = wantTime ? await clickByVisibleText(cdp, [wantTime], { random, sleep }) : false;
  if (wantTime) await pause();

  // 第二遍：仍有未命中 → 尝试开「筛选」面板再点（时间筛选常在面板内）。
  if ((wantSort && !sortApplied) || (wantTime && !timeApplied)) {
    const opened = await clickByVisibleText(cdp, ['筛选'], { random, sleep });
    if (opened) {
      await pause();
      if (wantSort && !sortApplied) {
        sortApplied = await clickByVisibleText(cdp, [wantSort], { random, sleep });
        await pause();
      }
      if (wantTime && !timeApplied) {
        timeApplied = await clickByVisibleText(cdp, [wantTime], { random, sleep });
        await pause();
      }
    }
  }

  logger(
    `[search] 原生筛选：排序「${wantSort ?? '-'}」=${sortApplied ? '已切' : '未生效'}、` +
      `时间「${wantTime ?? '-'}」=${timeApplied ? '已切' : '未生效'}（未生效=诚实降级，云端不冒充已筛）`,
  );
  return { sortApplied, timeApplied };
}

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
  /** 搜索提交按钮选择器（默认 XHS_SEARCH_SUBMIT_SELECTOR） */
  searchSubmitSelector?: string;
  /** 日志输出（默认 console.log） */
  logger?: (msg: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 生成"聚焦并清空搜索框"的 JS（命中返回 true）。取【可见】的那个（宽/窄布局两实例，只有一个可见）。 */
function buildFocusClearJs(selector: string): string {
  return `(function(){
    var cands = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}));
    // 宽布局可见框是 #search-input-in-feeds、窄布局是 #search-input；querySelector 取首个可能命中隐藏的 header 框。
    var el = cands.filter(function(e){ return e.offsetWidth > 0 && e.offsetParent !== null; })[0] || cands[0];
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

/** 生成"检查搜索框是否可见（任一候选 offsetWidth>0）"的 JS（可见返回 true）。 */
function buildIsVisibleJs(selector: string): string {
  return `(function(){
    var cands = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}));
    return cands.some(function(el){ return el.offsetWidth > 0 && el.offsetParent !== null; });
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

/** 点击搜索提交按钮（拟人化点击其中心坐标）。命中并点击返回 true，找不到返回 false。 */
export async function clickSearchSubmit(
  cdp: BrowseCdp,
  selector: string,
  options: { random?: RandomFn; sleep: (ms: number) => Promise<void> },
): Promise<boolean> {
  const rectRaw = await evalRaw<string | null>(cdp, buildIconRectJs(selector));
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
  await dispatchClick(cdp, rect.x, rect.y, { random: options.random, sleep: options.sleep });
  return true;
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

  // 3. 等待导航到搜索结果页。先给 Enter 一个短窗口；AI 搜索 textarea 上 Enter 可能只换行不导航，
  //    未跳转则点提交按钮兜底（当前真机 .bottom-box-right-submit-button）。
  let navigated = await waitForSearchNavigation(cdp, sleep, 1800);
  if (!navigated) {
    const submitSelector = deps.searchSubmitSelector ?? XHS_SEARCH_SUBMIT_SELECTOR;
    const clicked = await clickSearchSubmit(cdp, submitSelector, { random, sleep });
    if (clicked) logger('[search] Enter 未跳转，点击搜索提交按钮兜底');
    navigated = await waitForSearchNavigation(cdp, sleep, 4000);
  }
  if (navigated) {
    const href = await evalRaw<string>(cdp, `(function(){ return location.href; })()`);
    logger(`[search] 搜索导航成功: ${href}`);
    // 4. 额外等待让搜索结果卡片加载。
    await sleep(sampleDelay(TIMING_PRESETS.reading, random));
  } else {
    logger('[search] 未确认导航到搜索结果页（待真机确认提交方式）');
    // 兜底：即使未确认导航，也给结果页渲染留出时间。
    await sleep(sampleDelay(TIMING_PRESETS.reading, random));
  }
}
