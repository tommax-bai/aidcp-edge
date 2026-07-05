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
import { evalRaw, dispatchClick, dispatchHover, dispatchKeystrokes, pressEnter, type RandomFn } from './cdp-util.js';
import { sampleDelay, TIMING_PRESETS, type Point } from '../humanize/index.js';

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
 * 「筛选」面板触发器的文案候选。真机实证：**应用任一筛选后，触发器文案由「筛选」变为「已筛选」**——
 * 若只精确匹配「筛选」，应用第一个筛选后就找不到触发器、打不开面板、第二个筛选永远切不上（真机 bug）。
 * 故两者都收进候选。
 */
export const SEARCH_FILTER_TRIGGER_TEXTS = ['筛选', '已筛选'];

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
      // 跳过埋点/命中代理：真机 AI 搜索页每个筛选项都并排一个 aria-hidden=true 的代理 div（data-hp-kind=filter-tag-*）
      // 与真元素精确重叠，点它无效（会造成「已点却没选上」的假阳性）。凡处于 aria-hidden 子树内一律不点。
      if (el.closest && el.closest('[aria-hidden="true"]')) continue;
      var r = el.getBoundingClientRect();
      if (r.width<=0 || r.height<=0) continue;
      if (r.top<0 || r.left<0) continue;
      var area = r.width*r.height;
      if (!best || area < best.area) best = { area: area, x: r.left+r.width/2, y: r.top+r.height/2 };
    }
    return best ? JSON.stringify({x:best.x,y:best.y}) : null;
  })()`;
}

/**
 * 生成「读取单个筛选项的提交信号」的 JS（返回 JSON 字符串 `{selected,trigger}`，体内带
 * commit-signals 标记供测试桩识别）：
 *  - selected：按可见文案命中该项（排除 aria-hidden 埋点代理），上溯几层任一祖先 class 令牌含
 *    active/selected/checked/current/is-active 或 aria-selected/aria-checked="true" → 视为选中态在身。
 *  - trigger：页面可见的筛选触发器文案（'已筛选' 优先 > '筛选' > null 无触发器布局）。
 *    真机法证（docs/xhs-layout-states.md §2.6.1）：任一筛选**真提交**后触发器由「筛选」变「已筛选」，
 *    是廉价的全局提交信号；而「点击未提交」的失败只留 CSS 级瞬时高亮、触发器不变。
 */
function buildCommitSignalsJs(text: string): string {
  return `(function(){/*commit-signals*/
    var target = ${JSON.stringify(text)};
    var SEL = ['active','selected','checked','current','is-active'];
    var nodes = Array.prototype.slice.call(document.querySelectorAll('button,a,span,div,li,label,p'));
    var selected = false;
    for (var i=0;i<nodes.length;i++){
      var el = nodes[i];
      if ((el.textContent||'').trim() !== target) continue;
      if (el.offsetParent === null) continue;
      if (el.closest && el.closest('[aria-hidden="true"]')) continue;
      var p = el;
      for (var k=0;k<4 && p;k++){
        var toks = ((p.className||'')+'').split(/\\s+/);
        for (var j=0;j<SEL.length;j++){ if (toks.indexOf(SEL[j])>=0) selected = true; }
        if (p.getAttribute && (p.getAttribute('aria-selected')==='true' || p.getAttribute('aria-checked')==='true')) selected = true;
        p = p.parentElement;
      }
    }
    var trigger = null;
    var trigTexts = ['已筛选','筛选'];
    for (var t=0;t<trigTexts.length && !trigger;t++){
      for (var m=0;m<nodes.length;m++){
        var e2 = nodes[m];
        if ((e2.textContent||'').trim() !== trigTexts[t]) continue;
        if (e2.offsetParent === null) continue;
        if (e2.closest && e2.closest('[aria-hidden="true"]')) continue;
        trigger = trigTexts[t];
        break;
      }
    }
    return JSON.stringify({ selected: selected, trigger: trigger });
  })()`;
}

/**
 * 权威读一次「该项是否已真提交」：selected 在身，且（存在触发器时）触发器已变「已筛选」。
 * 触发器仍是「筛选」= 全页尚无任何筛选真提交 → 此刻读到的 selected 只可能是瞬时高亮 → 判 false
 * （假阳性守卫）。无触发器的布局（行内 tab 经典页）以 selected 为准。读不到/解析失败 → false，不冒充。
 */
async function readCommitVerdict(cdp: BrowseCdp, target: string): Promise<boolean> {
  const raw = await evalRaw<string>(cdp, buildCommitSignalsJs(target)).catch(() => null);
  if (typeof raw !== 'string') return false;
  try {
    const sig = JSON.parse(raw) as { selected?: boolean; trigger?: string | null };
    if (!sig.selected) return false;
    return sig.trigger == null || sig.trigger === '已筛选';
  } catch {
    return false;
  }
}

/** 按可见文案定位可点元素中心坐标；命中返回 {x,y}，找不到（含隐藏/未渲染）返回 null。 */
async function findRectByVisibleText(cdp: BrowseCdp, texts: string[]): Promise<Point | null> {
  const rectRaw = await evalRaw<string | null>(cdp, buildFindByTextRectJs(texts)).catch(() => null);
  if (!rectRaw) return null;
  try {
    const rect = typeof rectRaw === 'string' ? (JSON.parse(rectRaw) as Point) : (rectRaw as Point);
    return rect && typeof rect.x === 'number' && typeof rect.y === 'number' ? rect : null;
  } catch {
    return null;
  }
}

/**
 * 按可见文案找到元素并拟人化点击其中心；命中并点击返回 true，找不到返回 false（honest，不假点）。
 * opts.from：把移动起点设为某已知坐标（如刚 hover 展开的「筛选」控件），让路径落在面板区域内、
 * 避免中途 mouseleave 把 hover 面板收起（见 applySearchFilters）。
 */
async function clickByVisibleText(
  cdp: BrowseCdp,
  texts: string[],
  opts: { random?: RandomFn; sleep: (ms: number) => Promise<void>; from?: Point },
): Promise<boolean> {
  const rect = await findRectByVisibleText(cdp, texts);
  if (!rect) return false;
  await dispatchClick(cdp, rect.x, rect.y, { random: opts.random, sleep: opts.sleep, from: opts.from });
  return true;
}

/**
 * 按可见文案 hover（只移动、不 click）到元素中心，返回该中心坐标（找不到返回 null）。
 * 用于 hover 展开的悬浮控件（如小红书搜索页「筛选」面板）：hover 展开后不 click 触发控件，
 * 避免「hover 开 → click 又收」；返回的坐标可作为后续点击面板内选项的 from（保持路径在面板内）。
 */
async function hoverByVisibleText(
  cdp: BrowseCdp,
  texts: string[],
  opts: { random?: RandomFn; sleep: (ms: number) => Promise<void> },
): Promise<Point | null> {
  const rect = await findRectByVisibleText(cdp, texts);
  if (!rect) return null;
  await dispatchHover(cdp, rect.x, rect.y, { random: opts.random, sleep: opts.sleep });
  return rect;
}

/** 有界轮询：等某文案的可见元素出现（面板展开动画/异步渲染），命中返回 true，超时返回 false。 */
async function waitOptionVisible(
  cdp: BrowseCdp,
  texts: string[],
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  // 按累计 sleep 计时（不依赖 Date.now()）：生产每轮真等 120ms、约 timeoutMs/120 轮；测试注入即时 sleep 则同轮数快速退出。
  for (let waited = 0; waited < timeoutMs; waited += 120) {
    if (await findRectByVisibleText(cdp, texts)) return true;
    await sleep(120);
  }
  return false;
}

/** 单项筛选最大「点击→复核」尝试轮数（未提交→重试；固定 3 轮足以熬过亚秒级重渲染过渡窗口）。 */
const MAX_FILTER_APPLY_ATTEMPTS = 3;

/**
 * 点击后到权威复核前的最短 settle。真机法证（docs/xhs-layout-states.md §2.6.1）：
 * 「点击未提交」的失败只留 ~1.7s 内消退的 CSS 级瞬时高亮——settle 足量后读到的选中态才是持久态。
 */
const FILTER_VERIFY_SETTLE_MS = 1800;

/**
 * 确保目标选项可见（行内 tab 已可见则直接用；否则 hover「筛选/已筛选」展开面板，hover 展不开
 * 再补一次 click 触发器兜底——绝不对 hover 型触发器 click，防「hover 开→click 又收」老 bug）。
 * 返回 visible 与触发器坐标 from（点面板内选项时作为移动起点，防中途 mouseleave 收面板）。
 */
async function ensurePanelTargetVisible(
  cdp: BrowseCdp,
  target: string,
  ctx: { random?: RandomFn; sleep: (ms: number) => Promise<void> },
): Promise<{ visible: boolean; from?: Point }> {
  // 已可见（行内 tab，或面板恰好开着）：from=目标自身中心——点击路径原地微动、绝不划出面板。
  // 若用默认起点（目标外侧 ~60px）起步，路径可能出面板 → mouseleave 收起 → 点空/误点下层卡片（真机实证）。
  const inline = await findRectByVisibleText(cdp, [target]);
  if (inline) return { visible: true, from: inline };
  const trig = await hoverByVisibleText(cdp, SEARCH_FILTER_TRIGGER_TEXTS, ctx);
  if (!trig) return { visible: false };
  let ready = await waitOptionVisible(cdp, [target], 800, ctx.sleep);
  if (!ready) {
    await clickByVisibleText(cdp, SEARCH_FILTER_TRIGGER_TEXTS, { ...ctx, from: trig });
    ready = await waitOptionVisible(cdp, [target], 1500, ctx.sleep);
  }
  return { visible: ready, from: trig };
}

/**
 * 应用单个筛选项：〔幂等前查（已提交→跳过不重复点）→ 点 → settle → 权威复核，未提交则重试〕。
 *
 * 治真根因（§2.6.1「点击未提交的瞬态竞态」）：点击撞上页面亚秒级重渲染过渡窗口时会「瞬时高亮但
 * 从未提交」且无法预判窗口——故不押注任何具体机理，靠「复核戳穿未提交 + 隔轮重试自然错开窗口」通吃。
 * 返回值只由权威复核（settle 之后 + 触发器提交信号）决定，瞬时高亮绝不作数；已提交的筛选实测在
 * AI 总结流式生成全程存活、重复点选已选项不 toggle（幂等安全），重试无副作用。
 */
async function applyOneFilter(
  cdp: BrowseCdp,
  target: string,
  ctx: { random?: RandomFn; sleep: (ms: number) => Promise<void>; logger?: (msg: string) => void },
): Promise<boolean> {
  const log = ctx.logger ?? (() => {});
  for (let attempt = 0; attempt < MAX_FILTER_APPLY_ATTEMPTS; attempt++) {
    const open = await ensurePanelTargetVisible(cdp, target, ctx);
    if (open.visible) {
      // 幂等前查 = 上一轮点击的权威复核：已真提交 → 成功返回，绝不重复点。
      if (await readCommitVerdict(cdp, target)) {
        log(`[search] 筛选「${target}」第 ${attempt + 1} 轮复核：已提交`);
        return true;
      }
      // 面板刚展开就点会「瞬时高亮不提交」（4a8f241）→ settle 再点；首轮 action 档自然停顿，
      // 重试轮降为 scroll 档短抖动（控预算：K 轮重试不炸 ~28s 单步）。
      const preset = attempt === 0 ? TIMING_PRESETS.action : TIMING_PRESETS.scroll;
      await ctx.sleep(sampleDelay(preset, ctx.random));
      const clicked = await clickByVisibleText(cdp, [target], { random: ctx.random, sleep: ctx.sleep, from: open.from });
      log(`[search] 筛选「${target}」第 ${attempt + 1} 轮：未提交→点击${clicked ? '已派发' : '落空（点前面板收起）'}`);
    } else {
      log(`[search] 筛选「${target}」第 ${attempt + 1} 轮：控件不可见（触发器/面板未展开）`);
    }
    // 点后（或本轮控件不可见）settle 足量再复核：瞬时高亮 ~1.7s 内消退，之后读到的才是持久态。
    await ctx.sleep(Math.max(sampleDelay(TIMING_PRESETS.scroll, ctx.random), FILTER_VERIFY_SETTLE_MS));
  }
  // 终判：最后一轮点击后的权威复核。控件不可见/仍未提交 → 诚实 false（云端降级，不冒充已筛）。
  const fin = await ensurePanelTargetVisible(cdp, target, ctx);
  const verdict = fin.visible ? await readCommitVerdict(cdp, target) : false;
  log(`[search] 筛选「${target}」终判：${verdict ? '已提交' : `未提交（控件${fin.visible ? '可见' : '不可见'}）`}`);
  return verdict;
}

export interface ApplySearchFiltersDeps {
  cdp: BrowseCdp;
  random?: RandomFn;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

/**
 * 在搜索结果页应用原生「排序 + 发布时间」筛选（change comment-search-command，task 5.4 重构）。
 *
 * 按需评论任务要「最近一天 + 最多收藏」：靠点平台原生排序（最多收藏）+ 时间筛选（一天内）。
 * 按可见文案点击（跨宽/窄布局、跨类名漂移最稳）；行内 tab 直接点，藏在「筛选」hover 面板内则展开再点。
 *
 * 逐项走「幂等应用 + 权威复核 + 有界重试」（applyOneFilter）：治真根因「点击未提交的瞬态竞态」
 * （真机法证 docs/xhs-layout-states.md §2.6.1——点击撞上亚秒级重渲染过渡窗口时瞬时高亮但从未提交；
 * AI 总结流式生成不影响已提交筛选，无需等它、无需关它）。
 *
 * 红线（honest）：返回值只由权威复核决定——控件定位失败 / K 轮重试后仍未提交 → applied=false，
 * **绝不假装已筛**——云端据此降级回报、不把未筛结果当「最近一天最多收藏」。
 */
export async function applySearchFilters(
  opts: { sort?: string; timeWindow?: string },
  deps: ApplySearchFiltersDeps,
): Promise<{ sortApplied: boolean; timeApplied: boolean }> {
  const { cdp } = deps;
  const random = deps.random;
  const sleep = deps.sleep ?? defaultSleep;
  const logger = deps.logger ?? ((m: string) => console.log(m));

  const sortIsDefault = opts.sort === 'comprehensive';
  const timeIsDefault = opts.timeWindow === 'all';
  const wantSort = opts.sort && !sortIsDefault ? SEARCH_SORT_TEXT[opts.sort] : undefined;
  const wantTime = opts.timeWindow && !timeIsDefault ? SEARCH_TIME_TEXT[opts.timeWindow] : undefined;
  if (!wantSort && !wantTime) {
    const sortApplied = opts.sort ? sortIsDefault : false;
    const timeApplied = opts.timeWindow ? timeIsDefault : false;
    if (sortIsDefault || timeIsDefault) {
      logger(
        `[search] 原生筛选：排序「${sortIsDefault ? SEARCH_SORT_TEXT.comprehensive : '-'}」=` +
          `${sortIsDefault ? '默认态无需点击' : '-'}、时间「${timeIsDefault ? SEARCH_TIME_TEXT.all : '-'}」=` +
          `${timeIsDefault ? '默认态无需点击' : '-'}（默认值不打开筛选面板）`,
      );
    }
    return { sortApplied, timeApplied };
  }

  const ctx = { random, sleep, logger };
  const sortApplied = sortIsDefault ? true : wantSort ? await applyOneFilter(cdp, wantSort, ctx) : false;
  // 项间自然停顿（一次 action 档），像真人切完排序再看时间。
  if (wantSort && wantTime) await sleep(sampleDelay(TIMING_PRESETS.action, random));
  const timeApplied = timeIsDefault ? true : wantTime ? await applyOneFilter(cdp, wantTime, ctx) : false;

  logger(
    `[search] 原生筛选：排序「${sortIsDefault ? SEARCH_SORT_TEXT.comprehensive : wantSort ?? '-'}」=` +
      `${sortIsDefault ? '默认态无需点击' : sortApplied ? '已切' : '未生效'}、` +
      `时间「${timeIsDefault ? SEARCH_TIME_TEXT.all : wantTime ?? '-'}」=` +
      `${timeIsDefault ? '默认态无需点击' : timeApplied ? '已切' : '未生效'}（未生效=诚实降级，云端不冒充已筛）`,
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
    // 4. 只给结果页首屏渲染一个轻缓冲（scroll 档，中位 ~0.8s）；真正「等结果卡片出现」由调用方
    //    waitForCards(5000) 兜底、命中即提前返回。原按 reading 档（中位 5s、长尾 15s）固定睡眠与之
    //    功能重复、纯属白等，故降为轻缓冲。
    await sleep(sampleDelay(TIMING_PRESETS.scroll, random));
  } else {
    logger('[search] 未确认导航到搜索结果页（待真机确认提交方式）');
    // 兜底：未确认导航时也只给轻缓冲；同样由调用方 waitForCards 兜底真正的卡片等待。
    await sleep(sampleDelay(TIMING_PRESETS.scroll, random));
  }
}
