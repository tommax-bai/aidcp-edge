#!/usr/bin/env tsx
/**
 * feed-refresh-button-probe.ts — 小红书 explore feed「右下角刷新按钮」真机标定探针。
 *
 * 目标（回答 change 提案前的三个问题）：
 *   1. 存在性 + 选择器：向下滚动若干屏后，页面右下角是否出现一个悬浮按钮（刷新 / 换一批 / 回到顶部）？
 *      抓它的 tag / class / 文本 / title / aria-label / 内嵌 svg use / rect / 最近 fixed|sticky 祖先容器，
 *      以及该容器的 outerHTML（截断）——供后续 edge 定位选择器直接使用。
 *   2. 双布局：宽（1440×980）与窄（600×900，Emulation）各抓一次——按钮可能只在其中一套出现或位置不同。
 *   3. 行为（关键）：点击最像「刷新」的候选后，feed 是否真的 **重载出全新一批、从第一条起**？
 *      记录点击前/后的 window.scrollY + .feeds-page.scrollTop + 前 6 张卡 noteId + 卡片总数，报告差异。
 *      —— 只有「滚动归零 且 首卡 noteId 变了」才算满足「从新从第一条开始刷」。
 *
 * 红线：只滚动 + 只点这一个刷新候选（benign：不点赞/不关注/不发布/不评论/不搜索）。若无高置信刷新候选则**不点**、只 dump。
 *
 * 用法：npx tsx scripts/feed-refresh-button-probe.ts [user_id]
 *   默认 user_id = k1e0ero8（tom 分组「工程师大白」）。可选 AIDCP_ADS_USER_ID 覆盖。
 *   AIDCP_REFRESH_NO_CLICK=1 → 全程只读、绝不点击（只做双布局 dump）。
 */
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { attachToPage } from '../src/cdp/index.js';
import { evalRaw, dispatchClick } from '../src/browse/index.js';

const API_BASE = process.env.AIDCP_ADS_API_BASE ?? 'http://local.adspower.net:50325';
const USER_ID = process.argv[2] ?? process.env.AIDCP_ADS_USER_ID ?? 'k1e0ero8'; // tom 分组「工程师大白」
const NO_CLICK = process.env.AIDCP_REFRESH_NO_CLICK === '1';
const EXPLORE_URL = 'https://www.xiaohongshu.com/explore';

interface AdsResp<T> {
  code: number;
  msg?: string;
  data?: T;
}
interface AdsStartData {
  ws?: { selenium?: string; puppeteer?: string };
  debug_port?: string | number;
}

async function adsApi<T>(path: string, params: Record<string, string>): Promise<AdsResp<T>> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${path}?${qs}`);
  return (await res.json()) as AdsResp<T>;
}

async function startBrowser(): Promise<{ host: string; port: number }> {
  const launchArgs = ['--window-size=1440,980'];
  const resp = await adsApi<AdsStartData>('/api/v1/browser/start', {
    user_id: USER_ID,
    open_tabs: '1',
    ip_tab: '0',
    headless: '0',
    launch_args: JSON.stringify(launchArgs),
  });
  if (resp.code !== 0 || !resp.data?.debug_port) {
    throw new Error(`browser/start 失败：code=${resp.code} msg=${resp.msg ?? ''}`);
  }
  const port = Number(resp.data.debug_port);
  console.log(`[probe] AdsPower 启动 profile=${USER_ID} → debug_port=${port}`);
  return { host: '127.0.0.1', port };
}

async function stopBrowser(): Promise<void> {
  try {
    await adsApi<unknown>('/api/v1/browser/stop', { user_id: USER_ID });
  } catch {
    /* best-effort */
  }
}

async function waitCdpReady(host: string, port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://${host}:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    if (Date.now() >= deadline) throw new Error('CDP /json/version 未就绪');
    await sleep(300);
  }
}

// ── 悬浮按钮候选采集（右下角小可点元素 + 其 fixed/sticky 祖先容器） ────────────────
const DUMP_JS = String.raw`(() => {
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const txt = (e) => ((e.innerText || e.textContent || '').replace(/\s+/g, '').trim()).slice(0, 40);
  const clsOf = (el) => String((el.className && el.className.baseVal != null) ? el.className.baseVal : (el.className || '')).slice(0, 140);
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const svgUses = (el) => Array.from(el.querySelectorAll('use')).map(u => u.getAttribute('xlink:href') || u.getAttribute('href') || '').filter(Boolean).slice(0, 6);
  const attrs = (el) => ({ title: el.getAttribute && el.getAttribute('title'), aria: el.getAttribute && el.getAttribute('aria-label') });
  const posAncestor = (el) => {
    let n = el, depth = 0;
    while (n && depth < 8) {
      let cs; try { cs = getComputedStyle(n); } catch (e) { break; }
      if (cs.position === 'fixed' || cs.position === 'sticky') {
        return { tag: n.tagName.toLowerCase(), cls: clsOf(n), pos: cs.position, rect: rectOf(n), html: (n.outerHTML || '').replace(/\s+/g, ' ').slice(0, 400) };
      }
      n = n.parentElement; depth++;
    }
    return null;
  };

  // 右下角区域：中心落在距右边缘 ≤ 260px 且 距底边 ≤ 320px；尺寸像按钮（16..160 px）。
  const cand = [];
  const seenRect = new Set();
  const nodes = document.querySelectorAll('div,span,button,a,svg,li,[role=button]');
  for (const el of nodes) {
    let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    if (!(r.width > 0 && r.height > 0)) continue;
    if (!(r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh)) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const inBR = cx >= vw - 260 && cy >= vh - 320;
    if (!inBR) continue;
    if (!(r.width >= 16 && r.width <= 180 && r.height >= 16 && r.height <= 180)) continue;
    const key = Math.round(r.left) + 'x' + Math.round(r.top) + 'x' + Math.round(r.width) + 'x' + Math.round(r.height);
    if (seenRect.has(key)) continue; seenRect.add(key);
    const a = attrs(el);
    const uses = svgUses(el);
    const t = txt(el);
    const cls = clsOf(el);
    const anc = posAncestor(el);
    // 刷新评分
    const blob = (t + ' ' + cls + ' ' + (a.title || '') + ' ' + (a.aria || '') + ' ' + uses.join(' ') + ' ' + (anc ? anc.cls : '')).toLowerCase();
    let score = 0;
    if (/刷新|换一换|换一批|refresh|reload/.test(blob)) score += 100;
    if (/回到顶部|回顶|置顶|to-?top|backtop|back-?top|gotop|scroll-?top/.test(blob)) score += 40;
    if (uses.some(u => /refresh|reload|renew|change/i.test(u))) score += 30;
    cand.push({ tag: el.tagName.toLowerCase(), text: t, cls, title: a.title, aria: a.aria, uses, rect: rectOf(el), score, ancestor: anc });
  }
  cand.sort((a, b) => b.score - a.score || (b.rect.y - a.rect.y));

  // feed 状态指纹
  const feedEl = document.querySelector('.feeds-page');
  const noteIds = Array.from(document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"]'))
    .map(a => { const m = (a.getAttribute('href') || '').match(/\/(explore|discovery\/item)\/([0-9a-f]{8,})/i); return m ? m[2] : ''; })
    .filter(Boolean);
  const uniqFirst = [];
  const s = new Set();
  for (const id of noteIds) { if (!s.has(id)) { s.add(id); uniqFirst.push(id); } if (uniqFirst.length >= 6) break; }

  const isWide = (() => { const sb = document.querySelector('.side-bar, [class*="side-bar"]'); return !!(sb && sb.offsetParent !== null); })();

  return JSON.stringify({
    vw, vh, isWide,
    scroll: { winY: Math.round(window.scrollY || 0), feedY: Math.round(feedEl ? feedEl.scrollTop : 0) },
    cardCount: s.size,
    firstNoteIds: uniqFirst,
    candidates: cand.slice(0, 12),
  });
})()`;

interface Cand {
  tag: string;
  text: string;
  cls: string;
  title?: string;
  aria?: string;
  uses: string[];
  rect: { x: number; y: number; w: number; h: number };
  score: number;
  ancestor?: { tag: string; cls: string; pos: string; rect: { x: number; y: number; w: number; h: number }; html: string } | null;
}
interface Dump {
  vw: number;
  vh: number;
  isWide: boolean;
  scroll: { winY: number; feedY: number };
  cardCount: number;
  firstNoteIds: string[];
  candidates: Cand[];
}

async function scrollDown(cdp: any, rounds: number, x = 700, y = 500): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 800 });
    await sleep(400);
  }
  await sleep(1200);
}

async function readDump(cdp: any): Promise<Dump> {
  const raw = await evalRaw<string>(cdp, DUMP_JS).catch(() => '{}');
  return JSON.parse(raw) as Dump;
}

function printDump(label: string, d: Dump): void {
  console.log(`\n──────── ${label} ────────`);
  console.log(`viewport=${d.vw}x${d.vh} isWide=${d.isWide} scroll=${JSON.stringify(d.scroll)} cards=${d.cardCount}`);
  console.log(`firstNoteIds=${d.firstNoteIds.join(',')}`);
  console.log(`右下角悬浮候选 (${d.candidates.length}):`);
  d.candidates.forEach((c, i) => {
    console.log(
      `  [${i}] score=${c.score} <${c.tag}> text="${c.text}" title=${JSON.stringify(c.title)} aria=${JSON.stringify(c.aria)}\n` +
        `       cls="${c.cls}"\n` +
        `       uses=${JSON.stringify(c.uses)} rect=${JSON.stringify(c.rect)}\n` +
        `       ancestor=${c.ancestor ? `<${c.ancestor.tag} pos=${c.ancestor.pos}> cls="${c.ancestor.cls}" rect=${JSON.stringify(c.ancestor.rect)}` : 'none'}`,
    );
    if (c.ancestor && i < 3) console.log(`       ancestorHTML=${c.ancestor.html}`);
  });
}

async function clickAndMeasure(cdp: any, label: string, pick: (c: Cand) => boolean): Promise<void> {
  const before = await readDump(cdp);
  const target = before.candidates.find(pick);
  if (!target) {
    console.log(`\n[probe] ${label}：未找到目标按钮，跳过。`);
    return;
  }
  const cx = target.rect.x + target.rect.w / 2;
  const cy = target.rect.y + target.rect.h / 2;
  console.log(`\n[probe] 行为测试「${label}」：点 cls="${target.cls}" rect=${JSON.stringify(target.rect)} @ (${Math.round(cx)},${Math.round(cy)})`);
  await dispatchClick(cdp, cx, cy).catch((e) => console.warn('  dispatchClick 异常:', (e as Error).message));
  await sleep(3200);
  const after = await readDump(cdp);
  const scrolledToTop = after.scroll.winY <= 8 && after.scroll.feedY <= 8 && (before.scroll.winY > 50 || before.scroll.feedY > 50);
  const firstChanged = before.firstNoteIds.length > 0 && after.firstNoteIds.length > 0 && before.firstNoteIds[0] !== after.firstNoteIds[0];
  const overlap = before.firstNoteIds.filter((id) => after.firstNoteIds.includes(id)).length;
  console.log(`  before: scroll=${JSON.stringify(before.scroll)} first=${before.firstNoteIds.join(',')}`);
  console.log(`  after : scroll=${JSON.stringify(after.scroll)} first=${after.firstNoteIds.join(',')}`);
  console.log(`  ▶ 回到顶部 = ${scrolledToTop}`);
  console.log(`  ▶ 首卡变化(出新内容) = ${firstChanged}  (前${before.firstNoteIds.length}卡重叠 ${overlap})`);
  console.log(
    `  ▶ 结论 = ${
      scrolledToTop && firstChanged
        ? '✅ 回到顶部 + 换出全新一批 → 满足「从新从第一条开始刷」'
        : scrolledToTop && !firstChanged
          ? '↩︎ 只回到顶部、内容未变（纯 back-to-top）'
          : firstChanged && !scrolledToTop
            ? '⚠️ 内容变了但未回顶'
            : '❓ 无明显变化'
    }`,
  );
}

async function main(): Promise<void> {
  const { host, port } = await startBrowser();
  let closeSession: (() => void) | undefined;
  try {
    await waitCdpReady(host, port);
    const session = await attachToPage({ host, port, stealth: false });
    closeSession = () => session.close();
    const cdp = session.cdp;

    // 导航到 explore 并等 hydrate
    await cdp.send('Page.navigate', { url: EXPLORE_URL });
    {
      const deadline = Date.now() + 25_000;
      for (;;) {
        const href = await evalRaw<string>(cdp, 'String(location.href)').catch(() => '');
        const rs = await evalRaw<string>(cdp, 'String(document.readyState)').catch(() => '');
        if ((href.includes('xiaohongshu.com') && rs === 'complete') || Date.now() >= deadline) break;
        await sleep(500);
      }
    }
    await sleep(2000);

    // ── 阶段 1：宽布局，滚动出按钮，读 dump（只读）
    console.log('\n[probe] 阶段1 宽布局：滚动 14 屏后 dump 右下角悬浮元素…');
    await scrollDown(cdp, 14);
    const wide = await readDump(cdp);
    printDump('WIDE 1440x980 (scrolled)', wide);

    // ── 阶段 2：点击行为测试（宽布局，精确点两个按钮各一次，完整刻画）
    if (!NO_CLICK) {
      // 先测「刷新」(div.reload)：期望 = 出全新一批 + 回到顶部
      await clickAndMeasure(cdp, '刷新按钮 div.reload', (c) => /(^|\s)reload(\s|$)/.test(c.cls) && c.tag === 'div' && c.rect.w <= 60);
      // 重新滚下去，再测「回到顶部」(div.back-top)：期望 = 回到顶部、内容不变
      console.log('\n[probe] 重新滚动 14 屏，准备测「回到顶部」…');
      await scrollDown(cdp, 14);
      await clickAndMeasure(cdp, '回到顶部按钮 div.back-top', (c) => /(^|\s)back-top(\s|$)/.test(c.cls) && c.tag === 'div' && c.rect.w <= 60);
    } else {
      console.log('\n[probe] 阶段2 跳过点击：AIDCP_REFRESH_NO_CLICK=1 只读模式。');
    }

    // ── 阶段 3：窄布局（Emulation 600x900）滚动后 dump（只读）
    console.log('\n[probe] 阶段3 窄布局：Emulation 600x900，重新导航+滚动后 dump…');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 600, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: EXPLORE_URL });
    await sleep(3500);
    await scrollDown(cdp, 14, 300, 500);
    const narrow = await readDump(cdp);
    printDump('NARROW 600x900 (scrolled)', narrow);
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  } finally {
    if (closeSession) {
      try {
        closeSession();
      } catch {
        /* best-effort */
      }
    }
    await stopBrowser();
  }
}

process.on('SIGINT', () => {
  void stopBrowser().finally(() => process.exit(130));
});

main().catch((e) => {
  console.error(`[probe] 致命错误：${(e as Error).stack ?? (e as Error).message}`);
  void stopBrowser().finally(() => process.exit(1));
});
