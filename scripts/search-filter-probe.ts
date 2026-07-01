/**
 * search-filter-probe.ts — XHS 搜索结果页「排序 + 筛选」执行端探针（先决调研，非生产代码）
 * ===========================================================================
 *
 * 背景 / 要解决的未知项
 * ---------------------------------------------------------------------------
 * 按需评论任务（change comment-search-command）要在搜索结果页应用原生
 * 「最多收藏 + 一天内」筛选。真机现象报告：**「筛选」是 hover 态控件——鼠标
 * 移上去（hover）就把筛选框展开了，随后代码那一下 click 反而把它又收起来**，
 * 于是「一天内」永远点不到。生产实现 applySearchFilters 目前对「筛选」走的是
 * dispatchClick（贝塞尔 mouseMoved 逐帧移动 → mousePressed+mouseReleased），
 * 即「先 hover 展开、再 click 收起」——正好复现这个 bug。
 *
 * 本探针在一台**已登录小红书、停在搜索结果页**的 Chrome 上，把以下摸清：
 *   1. 顶排「排序 tab」（综合/最新/最多点赞/最多收藏/最多评论）到底是不是行内常驻、点文案能不能直接切；
 *   2. 「筛选」控件的 DOM 形态（标签/类名/父链/cursor），以及「不限/一天内/一周内/半年内」
 *      这些时间选项**是否预渲染在 DOM 里、平时被隐藏**（hover 才显现）——这是判定「hover 展开」的硬证据；
 *   3. 三种交互路径分别会发生什么：
 *        --hover  ：只把鼠标移到「筛选」中心（**不 click**），等面板动画，再 dump 时间选项可见性 → 证明「hover 即展开」；
 *        --click  ：hover + 完整 click「筛选」（复现当前 buggy 行为）→ 证明「click 又收起」；
 *        --apply  ：hover「筛选」→ 等展开 → 把鼠标**从筛选位置**平移到「一天内」并 click（拟议修法）→ 校验是否真选中；
 *        --sort   ：直接点「最多收藏」排序 tab（验证行内 tab 直点是否可行）。
 *
 * 安全分级（默认只读，绝不改账号状态）
 * ---------------------------------------------------------------------------
 *   - 默认（不带任何 flag）：**纯只读**。只 dump DOM 候选 + 截图，零交互。
 *   - --hover / --click / --apply / --sort：会移动鼠标 / 点击排序或时间筛选。这些只是
 *     **重排当前搜索结果**（可逆、无写互动、不发内容、不改账号风控），但仍需显式带 flag 才做。
 *   - 本探针**永不**点赞 / 收藏 / 关注 / 发评论。
 *
 * 运行（不需要 build，用 tsx 直接跑；本文件不在 tsconfig include 内，是独立脚本）
 * ---------------------------------------------------------------------------
 *   # 1) 让目标 Chrome 带调试端口跑起来（AdsPower 分身或本机 Chrome 均可），登录小红书；
 *   #    在里面搜一个词（如「工程师大白」）进到**搜索结果页**。
 *   # 2) 只读探测（先看 DOM 结构 + 时间选项是否预渲染隐藏）：
 *   cd ../aidcp-edge && tsx scripts/search-filter-probe.ts
 *   # 3) 证明「hover 即展开」：
 *   tsx scripts/search-filter-probe.ts --hover
 *   # 4) 复现「click 又收起」的 bug：
 *   tsx scripts/search-filter-probe.ts --click
 *   # 5) 验证拟议修法（hover 展开 → 平移点「一天内」）：
 *   tsx scripts/search-filter-probe.ts --apply --time=一天内
 *   # 6) 顺带验证排序直点：
 *   tsx scripts/search-filter-probe.ts --sort --sort-text=最多收藏
 *   # 可组合：--hover --apply 会先 dump hover 展开态，再点时间选项。
 *
 * 环境变量：
 *   AIDCP_CDP_HOST（默认 127.0.0.1）/ AIDCP_CDP_PORT（默认 9222）/
 *   AIDCP_PAGE_URL（attach 时按 url 子串匹配标签页，默认 'xiaohongshu'）
 *
 * 产物：每步都把快照写到 /tmp/aidcp-search-filter-probe-<ts>-<stage>.json，并截图到
 *       同名 .png。把这些发回来即可敲定 applySearchFilters 的修法。
 */

import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { attachToPage } from '../src/cdp/index.js';
import { evalRaw } from '../src/browse/cdp-util.js';
import { applySearchFilters } from '../src/browse/search-handler.js';

type Session = Awaited<ReturnType<typeof attachToPage>>;
type Cdp = Session['cdp'];

// ---------------------------------------------------------------------------
// 参数 / flag / 环境
// ---------------------------------------------------------------------------

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function readArg(name: string, dflt: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : dflt;
}

const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const URL_INCLUDES = process.env.AIDCP_PAGE_URL ?? 'xiaohongshu';

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const TIME_TEXT = readArg('time', '一天内'); // 时间筛选目标文案
const SORT_TEXT = readArg('sort-text', '最多收藏'); // 排序 tab 目标文案

// 排序 tab / 时间筛选的候选文案（与生产 SEARCH_SORT_TEXT / SEARCH_TIME_TEXT 对齐）
const SORT_TEXTS = ['综合', '最新', '最多点赞', '最多收藏', '最多评论'];
const TIME_TEXTS = ['不限', '一天内', '一周内', '半年内'];

// ---------------------------------------------------------------------------
// DOM dump：一次 eval 把「排序 tab / 筛选控件 / 时间选项」全部结构化取回。
// 关键判据：时间选项若「存在于 DOM 但 offsetParent===null / 高度为 0」→ 说明预渲染隐藏、
// 靠 hover（或 click）才显现——这就是「hover 展开」的硬证据。
// ---------------------------------------------------------------------------

function buildDumpJs(sortTexts: string[], timeTexts: string[]): string {
  return `(function(){
    function describe(el){
      if(!el) return null;
      var r = el.getBoundingClientRect();
      var cs = window.getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.toString) ? el.className.toString().slice(0,120) : '',
        text: (el.textContent||'').trim().slice(0,24),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        center: { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) },
        visible: !!(el.offsetParent) && r.width>0 && r.height>0,
        offsetParentNull: el.offsetParent === null,
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity, cursor: cs.cursor,
      };
    }
    function findExact(texts){
      var nodes = Array.prototype.slice.call(document.querySelectorAll('button,a,span,div,li,label,p'));
      var out = [];
      for (var i=0;i<nodes.length;i++){
        var el = nodes[i]; var t = (el.textContent||'').trim();
        if (texts.indexOf(t) === -1) continue;
        var d = describe(el); if (d){ d.match = t; out.push(d); }
      }
      return out;
    }
    // 「筛选」控件本体 + 父链（3 层）+ 兄弟里疑似面板容器
    var filterEls = findExact(['筛选']);
    var filterDetail = null;
    if (filterEls.length){
      // 取面积最小的那个作为真正可点的「筛选」按钮
      var nodes = Array.prototype.slice.call(document.querySelectorAll('button,a,span,div,li,label,p'));
      var best = null;
      for (var i=0;i<nodes.length;i++){
        var el = nodes[i]; if ((el.textContent||'').trim() !== '筛选') continue;
        if (el.offsetParent === null) continue;
        var r = el.getBoundingClientRect(); if (r.width<=0||r.height<=0) continue;
        var area = r.width*r.height; if (!best || area < best.area){ best = { el: el, area: area }; }
      }
      if (best){
        var node = best.el; var chain = [];
        var p = node;
        for (var k=0;k<4 && p;k++){ chain.push(describe(p)); p = p.parentElement; }
        filterDetail = { self: describe(node), parentChain: chain };
      }
    }
    return JSON.stringify({
      url: location.href,
      title: document.title,
      isSearchResult: /search_result|search\\/result|explore\\?/.test(location.href) || location.href.indexOf('search') >= 0,
      sortTabs: findExact(${JSON.stringify(sortTexts)}),
      filterControls: filterEls,
      filterDetail: filterDetail,
      timeOptions: findExact(${JSON.stringify(timeTexts)}),
    });
  })()`;
}

async function dump(cdp: Cdp): Promise<any> {
  const raw = await evalRaw<string>(cdp, buildDumpJs(SORT_TEXTS, TIME_TEXTS)).catch((e) => {
    return JSON.stringify({ error: String(e) });
  });
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { error: 'parse_failed', raw };
  }
}

// ---------------------------------------------------------------------------
// 鼠标原语：hover-only（移动但不 click）vs full click。
// hoverTo：从 from 沿直线几帧 mouseMoved 到目标中心，**不 press/release**。
// clickAt：hover 后再 mousePressed + mouseReleased（含 from→to 的移动）。
// 若 from 传入「筛选」坐标，则移动路径尽量落在面板区域内，避免中途 mouseleave 收起面板。
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function moveMouse(cdp: Cdp, from: { x: number; y: number }, to: { x: number; y: number }, frames = 12): Promise<void> {
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(12);
  }
}

async function hoverTo(cdp: Cdp, to: { x: number; y: number }, from?: { x: number; y: number }): Promise<void> {
  const start = from ?? { x: to.x - 60, y: to.y - 40 };
  await moveMouse(cdp, start, to);
}

async function clickAt(cdp: Cdp, to: { x: number; y: number }, from?: { x: number; y: number }): Promise<void> {
  await hoverTo(cdp, to, from);
  const base = { x: to.x, y: to.y, button: 'left' as const, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

// ---------------------------------------------------------------------------
// 产物落盘
// ---------------------------------------------------------------------------

async function writeSnap(stage: string, snap: Record<string, unknown>, session: Session): Promise<void> {
  const jsonPath = `/tmp/aidcp-search-filter-probe-${TS}-${stage}.json`;
  writeFileSync(jsonPath, JSON.stringify(snap, null, 2));
  let pngPath = '(截图失败)';
  try {
    const shot = await session.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    pngPath = `/tmp/aidcp-search-filter-probe-${TS}-${stage}.png`;
    writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
  } catch (e) {
    pngPath = `(截图失败: ${String(e)})`;
  }
  console.log(`  [${stage}] → ${jsonPath}\n            ${pngPath}`);
}

// 精简摘要：把 dump 的关键结论一行行打到控制台，方便当场判读。
function summarize(tag: string, d: any): void {
  if (!d || d.error) {
    console.log(`  [${tag}] dump 失败: ${d?.error ?? '?'}`);
    return;
  }
  const times = (d.timeOptions ?? []) as any[];
  const visTimes = times.filter((t) => t.visible).map((t) => t.match);
  const hidTimes = times.filter((t) => !t.visible).map((t) => t.match);
  const sorts = (d.sortTabs ?? []).filter((s: any) => s.visible).map((s: any) => s.match);
  console.log(`  [${tag}] 搜索结果页=${d.isSearchResult} url=${String(d.url).slice(0, 70)}`);
  console.log(`  [${tag}] 排序tab可见: [${sorts.join(', ')}]`);
  console.log(`  [${tag}] 时间选项 可见: [${visTimes.join(', ')}]  隐藏(预渲染): [${hidTimes.join(', ')}]`);
  if (d.filterDetail?.self) {
    const f = d.filterDetail.self;
    console.log(`  [${tag}] 「筛选」: <${f.tag} class="${f.cls}"> cursor=${f.cursor} center=(${f.center.x},${f.center.y}) visible=${f.visible}`);
  } else {
    console.log(`  [${tag}] 「筛选」控件未找到`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[probe] attach → ${HOST}:${PORT} (url~="${URL_INCLUDES}")`);
  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: URL_INCLUDES });
  const cdp = session.cdp;

  // ── stage 0: 只读基线 dump ──
  const base = await dump(cdp);
  summarize('baseline', base);
  await writeSnap('0-baseline', base, session);

  if (!base.isSearchResult) {
    console.log('\n⚠ 当前页看起来不是搜索结果页。请先在浏览器里搜一个词进到结果页再跑本探针。\n' +
      '  （baseline 快照仍已写盘，可据 url 判断实际停在哪。）');
  }

  const filterCenter: { x: number; y: number } | undefined = base.filterDetail?.self?.center;

  // ── --hover: 只 hover「筛选」，不 click，看时间选项是否显现 ──
  if (hasFlag('hover')) {
    if (!filterCenter) {
      console.log('\n[hover] 找不到「筛选」控件坐标，跳过。');
    } else {
      console.log(`\n[hover] mouseMoved → 「筛选」中心 (${filterCenter.x},${filterCenter.y})，不 click，等 700ms 面板动画…`);
      await hoverTo(cdp, filterCenter);
      await sleep(700);
      const afterHover = await dump(cdp);
      summarize('after-hover', afterHover);
      await writeSnap('1-after-hover', afterHover, session);
      console.log('  ↑ 若「时间选项 可见」比 baseline 多了「不限/一天内/…」→ 证实：hover 即展开面板（无需 click）。');
    }
  }

  // ── --click: hover + 完整 click「筛选」，复现「click 又收起」 ──
  if (hasFlag('click')) {
    if (!filterCenter) {
      console.log('\n[click] 找不到「筛选」控件坐标，跳过。');
    } else {
      console.log(`\n[click] hover+click 「筛选」(${filterCenter.x},${filterCenter.y})（复现当前 applySearchFilters 的行为）…`);
      await clickAt(cdp, filterCenter);
      await sleep(700);
      const afterClick = await dump(cdp);
      summarize('after-click', afterClick);
      await writeSnap('2-after-click', afterClick, session);
      console.log('  ↑ 若这里「时间选项 可见」反而变少/为空 → 证实：click 把 hover 展开的面板又收起了（即报告的 bug）。');
    }
  }

  // ── --apply: 拟议修法——hover「筛选」展开，从筛选位置平移到「一天内」并 click ──
  if (hasFlag('apply')) {
    if (!filterCenter) {
      console.log('\n[apply] 找不到「筛选」控件坐标，跳过。');
    } else {
      console.log(`\n[apply] hover「筛选」展开 → 找「${TIME_TEXT}」→ 从筛选位置平移点击（拟议修法）…`);
      await hoverTo(cdp, filterCenter);
      await sleep(700);
      const opened = await dump(cdp);
      const opt = (opened.timeOptions ?? []).find((t: any) => t.match === TIME_TEXT && t.visible);
      if (!opt) {
        console.log(`  [apply] hover 后仍未见可见的「${TIME_TEXT}」选项，写盘 hover 态供判读。`);
        await writeSnap('3-apply-no-option', opened, session);
      } else {
        // 关键：from = 筛选坐标 → 移动路径落在「筛选→面板」区域内，避免中途 mouseleave 收起。
        await clickAt(cdp, opt.center, filterCenter);
        await sleep(900);
        const afterApply = await dump(cdp);
        summarize('after-apply', afterApply);
        await writeSnap('3-after-apply', afterApply, session);
        console.log(`  ↑ 看 url 是否带上时间筛选参数 / 「${TIME_TEXT}」是否呈选中态 → 证实修法可行。`);
      }
    }
  }

  // ── --sort: 直接点排序 tab（验证行内 tab 直点） ──
  if (hasFlag('sort')) {
    const tab = (base.sortTabs ?? []).find((s: any) => s.match === SORT_TEXT && s.visible);
    if (!tab) {
      console.log(`\n[sort] baseline 未见可见的「${SORT_TEXT}」排序 tab，跳过（可能在更窄布局里）。`);
    } else {
      console.log(`\n[sort] 直接点排序 tab「${SORT_TEXT}」(${tab.center.x},${tab.center.y})…`);
      await clickAt(cdp, tab.center);
      await sleep(900);
      const afterSort = await dump(cdp);
      summarize('after-sort', afterSort);
      await writeSnap('4-after-sort', afterSort, session);
    }
  }

  // ── --production: 直接跑真实（已修）的 applySearchFilters，端到端验证生产代码路径 ──
  if (hasFlag('production')) {
    console.log('\n[production] 调用真实 applySearchFilters({ sort: most_collected, timeWindow: one_day })（即 /comment 任务用的筛选）…');
    const before = await dump(cdp);
    await writeSnap('5a-production-before', before, session);
    const res = await applySearchFilters(
      { sort: 'most_collected', timeWindow: 'one_day' },
      { cdp, logger: (m) => console.log('    ' + m) },
    );
    console.log(`  [production] 返回：sortApplied=${res.sortApplied} timeApplied=${res.timeApplied}（false=诚实降级，未冒充已筛）`);
    await sleep(1000);
    const after = await dump(cdp);
    summarize('production-after', after);
    await writeSnap('5b-production-after', after, session);
    console.log('  ↑ 对比 before/after 的排序选中态 + url，判定修复后的生产路径是否真把「最近一天·最多收藏」筛上了。');
  }

  console.log('\n[probe] 完成。把 /tmp/aidcp-search-filter-probe-* 的 json+png 发回即可敲定 applySearchFilters 修法。');
  try {
    session.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[probe] 失败:', err);
  process.exit(1);
});
