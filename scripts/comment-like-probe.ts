/**
 * comment-like-probe.ts — XHS「给单条评论点赞」执行端探针（Phase-0 硬闸，非生产代码）
 * ===========================================================================
 * 只读 + 良性滚动；【绝不点赞、绝不发任何内容、绝不改动账号状态】。
 *
 * 目的：把后续实装「给别人的单条评论点赞」动作所缺的三件事摸清楚——
 *   1. 单条评论行（[id^="comment-"]）内的「赞」控件长什么样、用什么选择器；
 *   2. 它的「已赞 / 未赞」状态信号（用于点前预过滤 + 点后后置校验）；
 *   3. 评论锚点在评论区滚动后，能否经 document.getElementById(anchor) 重新定位
 *      （虚拟化检查——决定「云端挑→边缘回点」这套往返架构成不成立）。
 *
 * 运行：复用已登录小红书、开着 9222 调试端口的 Chrome。外层脚本会先 PUT /json/new
 *   开一个 explore 标签，本脚本 attach 到它、点开第一篇笔记进详情、滚动评论区做检查，
 *   结束写 JSON + 截图到 /tmp，再由外层关掉该标签。
 *     tsx scripts/comment-like-probe.ts
 */
import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { attachToPage } from '../src/cdp/index.js';
import { evalJson, evalRaw, dispatchClick } from '../src/browse/cdp-util.js';

const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const URL_INCLUDES = process.env.AIDCP_PAGE_URL ?? 'explore';
const TS = new Date().toISOString().replace(/[:.]/g, '-');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Cdp = Awaited<ReturnType<typeof attachToPage>>['cdp'];

async function waitFor(cdp: Cdp, expr: string, timeoutMs: number, intervalMs = 400): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evalRaw<boolean>(cdp, expr).catch(() => false);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ---- 页面内 JS：找首张卡片中心坐标 ----------------------------------------
const COLLECT_CARDS_EXPR = `(() => {
  var secs = Array.prototype.slice.call(document.querySelectorAll('section.note-item'));
  var out = [], seen = {};
  secs.forEach(function(sec){
    var a = sec.querySelector('a[href*="/explore/"]');
    var href = a && a.getAttribute ? a.getAttribute('href') : null;
    if (!href || seen[href]) return;
    seen[href] = 1;
    var likeEl = sec.querySelector('.like-wrapper .count, [class*="like"] [class*="count"], span.count');
    out.push({ href: href, like: likeEl ? (likeEl.textContent || '').trim() : null });
  });
  return JSON.stringify(out.slice(0, 12));
})()`;

const COMMENT_COUNT_EXPR = 'document.querySelectorAll(\'[id^="comment-"]\').length';

// ---- 页面内 JS：评论结构 + 赞控件启发式扫描 -------------------------------
const STRUCTURE_EXPR = `(() => {
  function cssPath(el){
    var parts = [], n = el, guard = 0;
    while (n && n.nodeType === 1 && guard < 8) {
      if (n.id && /^comment-/.test(n.id)) { parts.unshift('#' + n.id); break; }
      var s = n.tagName.toLowerCase();
      var cls = (typeof n.className === 'string' ? n.className.trim() : '');
      if (cls) s += '.' + cls.split(/\\s+/).slice(0, 2).join('.');
      parts.unshift(s);
      n = n.parentElement; guard++;
    }
    return parts.join(' > ');
  }
  var out = { rowCount: 0, engageLikeHref: null, distinctUseHrefs: [], rows: [], rawHtml: [] };
  var eb = document.querySelector('.interactions.engage-bar .like-wrapper svg use');
  out.engageLikeHref = eb ? (eb.getAttribute('xlink:href') || eb.getAttribute('href')) : null;
  var rows = Array.prototype.slice.call(document.querySelectorAll('[id^="comment-"]'));
  out.rowCount = rows.length;
  var useSet = {};
  rows.slice(0, 5).forEach(function(r, idx){
    var rec = { idx: idx, anchorId: r.id, textSnippet: '', useHrefs: [], likeCandidates: [] };
    rec.textSnippet = (r.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    Array.prototype.slice.call(r.querySelectorAll('svg use')).forEach(function(u){
      var h = u.getAttribute('xlink:href') || u.getAttribute('href');
      if (h) { rec.useHrefs.push(h); useSet[h] = (useSet[h] || 0) + 1; }
    });
    var cand = [];
    Array.prototype.slice.call(r.querySelectorAll('*')).forEach(function(el){
      var cls = (typeof el.className === 'string' ? el.className : '') + '';
      var al = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
      var u = el.querySelector ? el.querySelector('svg use') : null;
      var uh = u ? (u.getAttribute('xlink:href') || u.getAttribute('href') || '') : '';
      var isLike = /like|zan|praise/i.test(cls) || /赞|like/i.test(al) || /like|zan|praise/i.test(uh);
      if (isLike) cand.push({
        tag: el.tagName.toLowerCase(), cls: cls.slice(0, 90), aria: al.slice(0, 30),
        useHref: uh, text: (el.textContent || '').trim().slice(0, 12), path: cssPath(el)
      });
    });
    rec.likeCandidates = cand.slice(0, 10);
    out.rows.push(rec);
  });
  out.distinctUseHrefs = Object.keys(useSet).map(function(k){ return { href: k, count: useSet[k] }; });
  rows.slice(0, 2).forEach(function(r){ out.rawHtml.push((r.outerHTML || '').slice(0, 3500)); });
  return JSON.stringify(out);
})()`;

// ---- 页面内 JS：滚动评论可滚容器 -----------------------------------------
const SCROLL_EXPR = `(() => {
  // 优先：从评论种子上溯找可滚祖先（评论已现时最准）
  function scrollableFrom(el){
    var n = el;
    while (n && n !== document.body && n !== document.documentElement){
      var s = window.getComputedStyle(n);
      if (n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(s.overflowY)) return n;
      n = n.parentElement;
    }
    return null;
  }
  var seed = document.querySelector('[id^="comment-"]')
          || document.querySelector('.comment-item, [class*="comment-item"], [class*="comment-list"]');
  var c = seed ? scrollableFrom(seed) : null;
  // 兜底：全页扫最大可滚元素（评论尚未加载时用它把主容器滚下去触发懒加载）
  if (!c) {
    var all = document.querySelectorAll('*'); var bestGap = 60;
    for (var i = 0; i < all.length; i++){
      var e = all[i], s2 = window.getComputedStyle(e), gap = e.scrollHeight - e.clientHeight;
      if (gap > bestGap && /(auto|scroll)/.test(s2.overflowY) && e.clientHeight > 200) { c = e; bestGap = gap; }
    }
  }
  if (c) {
    var before = c.scrollTop; c.scrollBy({ top: 700 });
    return JSON.stringify({ found: true, mode: 'el', cls: (c.className || '').toString().slice(0, 40), before: before, after: c.scrollTop, max: c.scrollHeight - c.clientHeight });
  }
  // 最后兜底：滚 window
  var wy = window.scrollY; window.scrollBy(0, 700);
  return JSON.stringify({ found: true, mode: 'win', before: wy, after: window.scrollY, max: document.scrollingElement ? document.scrollingElement.scrollHeight - window.innerHeight : 0 });
})()`;

const SNAPSHOT_IDS_EXPR = `(() => JSON.stringify(
  Array.prototype.slice.call(document.querySelectorAll('[id^="comment-"]')).map(function(r){ return r.id; })
))()`;

function parseLikeNum(s: string | null): number {
  if (!s) return 0;
  const m = s.replace(/,/g, '').match(/([\d.]+)\s*(万|w|k)?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  const u = (m[2] || '').toLowerCase();
  if (u === '万' || u === 'w') n *= 10000;
  else if (u === 'k') n *= 1000;
  return n;
}

// 按 noteId 片段在 feed 里定位卡片封面中心坐标（必要时先 scrollIntoView）
function findCardByIdExpr(id: string): string {
  return `(() => {
    var a = document.querySelector('a[href*="${id}"]');
    if (!a) return JSON.stringify({ found: false });
    var sec = (a.closest && a.closest('section.note-item')) || a;
    var cover = sec.querySelector('a.cover') || sec.querySelector('a[href*="/explore/"]') || sec.querySelector('img') || sec;
    var rect = cover.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) rect = sec.getBoundingClientRect();
    if (rect.top < 0 || rect.top > window.innerHeight - 60) { sec.scrollIntoView({ block: 'center' }); rect = cover.getBoundingClientRect(); }
    return JSON.stringify({ found: true, cx: rect.left + rect.width / 2, cy: rect.top + Math.min(rect.height / 2, 110) });
  })()`;
}

function survivalExpr(ids: string[]): string {
  return `(() => {
    var ids = ${JSON.stringify(ids)};
    var alive = 0, dead = [];
    ids.forEach(function(id){ if (document.getElementById(id)) alive++; else dead.push(id); });
    var cur = Array.prototype.slice.call(document.querySelectorAll('[id^="comment-"]')).map(function(r){ return r.id; });
    var fresh = cur.filter(function(id){ return ids.indexOf(id) < 0; });
    return JSON.stringify({
      snapshotCount: ids.length, alive: alive, deadCount: dead.length, deadSample: dead.slice(0, 10),
      currentVisible: cur.length, freshCount: fresh.length
    });
  })()`;
}

// 标定：找首条评论的赞按钮中心坐标 + 当前状态（点前 scrollIntoView 进视口）
const FIND_LIKE_TARGET_EXPR = `(() => {
  var row = document.querySelector('[id^="comment-"]');
  if (!row) return JSON.stringify({ found: false });
  row.scrollIntoView({ block: 'center' });
  var w = row.querySelector('.interactions .like .like-wrapper') || row.querySelector('.like-wrapper');
  if (!w) return JSON.stringify({ found: false, anchorId: row.id, reason: 'no like-wrapper' });
  var r = w.getBoundingClientRect();
  var use = w.querySelector('svg use');
  var cnt = w.querySelector('.count');
  return JSON.stringify({
    found: true, anchorId: row.id, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    cls: w.className, useHref: use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : null,
    count: cnt ? (cnt.textContent || '').trim() : null
  });
})()`;

function readLikeStateExpr(anchorId: string): string {
  return `(() => {
    var row = document.getElementById(${JSON.stringify(anchorId)});
    if (!row) return JSON.stringify({ found: false });
    var w = row.querySelector('.interactions .like .like-wrapper') || row.querySelector('.like-wrapper');
    if (!w) return JSON.stringify({ found: false });
    var use = w.querySelector('svg use');
    var cnt = w.querySelector('.count');
    var r = w.getBoundingClientRect();
    return JSON.stringify({
      found: true, cls: w.className,
      useHref: use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : null,
      count: cnt ? (cnt.textContent || '').trim() : null,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2
    });
  })()`;
}

async function main() {
  const snap: Record<string, unknown> = { ts: TS, host: HOST, port: PORT };
  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: URL_INCLUDES });
  const { cdp } = session;
  try {
    await cdp.send('Page.enable').catch(() => undefined);
    await cdp.send('Input.enable').catch(() => undefined);

    // 1) 等 feed 卡片
    console.log('[probe] 等待 feed 卡片 section.note-item …');
    const feedOk = await waitFor(cdp, 'document.querySelectorAll("section.note-item").length > 0', 20000);
    snap.feedReady = feedOk;
    if (!feedOk) {
      console.log('[probe] ✗ 未出现 feed 卡片（可能未登录/布局变化）。');
      writeSnap(snap, session);
      return;
    }

    // 2) 收集卡片（href+点赞数），按点赞量从高到低点开（高赞更可能有评论），开一篇没评论就 history.back 换下一篇
    const cards = await evalJson<{ href: string; like: string | null }[]>(cdp, COLLECT_CARDS_EXPR).catch(() => []);
    snap.cardCount = cards.length;
    const ranked = cards
      .map((c) => ({ ...c, id: (c.href.match(/\/explore\/([A-Za-z0-9]+)/) || [])[1] || '', likeNum: parseLikeNum(c.like) }))
      .filter((c) => c.id)
      .sort((a, b) => b.likeNum - a.likeNum);
    console.log(`[probe] 收集到 ${cards.length} 张卡片，按点赞量降序逐个找有评论的笔记 …`);
    const detailSel =
      '!!document.querySelector(".interactions.engage-bar") || !!document.querySelector(".engage-bar") || !!document.querySelector(".collect-wrapper")';
    const feedSel = 'document.querySelectorAll("section.note-item").length > 0';

    let probed = false;
    const tried: { id: string; like: string | null; detailReady: boolean; rows: number }[] = [];
    for (let k = 0; k < Math.min(ranked.length, 7) && !probed; k++) {
      const c = ranked[k];
      console.log(`[probe] (${k + 1}/${Math.min(ranked.length, 7)}) 点开 ${c.id} like=${c.like ?? '?'}(${c.likeNum})`);
      await waitFor(cdp, feedSel, 8000);
      const card = await evalJson<{ found: boolean; cx?: number; cy?: number }>(cdp, findCardByIdExpr(c.id)).catch(() => ({ found: false }));
      if (!card.found || card.cx == null) {
        console.log('   feed 中找不到该卡片，跳过');
        tried.push({ id: c.id, like: c.like, detailReady: false, rows: 0 });
        continue;
      }
      await dispatchClick(cdp, card.cx, card.cy!);
      let detailOk = await waitFor(cdp, detailSel, 8000);
      if (!detailOk) {
        await dispatchClick(cdp, card.cx, card.cy!);
        detailOk = await waitFor(cdp, detailSel, 8000);
      }
      if (!detailOk) {
        console.log('   详情未渲染，跳过');
        tried.push({ id: c.id, like: c.like, detailReady: false, rows: 0 });
        await evalRaw(cdp, 'history.back()').catch(() => undefined);
        await sleep(800);
        continue;
      }
      const href = c.href;
      // 滚主容器把评论区带进视口触发懒加载，每滚一轮检测评论行
      let hasRows = false;
      let firstScroll: unknown = null;
      for (let i = 0; i < 8 && !hasRows; i++) {
        const sc = await evalJson(cdp, SCROLL_EXPR).catch(() => null);
        if (i === 0) firstScroll = sc;
        await sleep(600);
        hasRows = await evalRaw<boolean>(cdp, COMMENT_COUNT_EXPR + ' > 0').catch(() => false);
      }
      const rowCnt = await evalRaw<number>(cdp, COMMENT_COUNT_EXPR).catch(() => 0);
      tried.push({ id: c.id, like: c.like, detailReady: true, rows: rowCnt });
      if (!hasRows) {
        console.log(`   该笔记评论行=0（可能 0 评论/荒地），换下一篇`);
        await evalRaw(cdp, 'history.back()').catch(() => undefined);
        await sleep(800);
        continue;
      }
      console.log(`   ✓ 找到有评论的笔记，评论行=${rowCnt}，开始探测`);
      snap.openedNote = { href, like: c.like, firstScroll, rowCnt };

      // 3) 结构 + 赞控件探测
      const structure = await evalJson(cdp, STRUCTURE_EXPR).catch((e) => ({ error: String(e) }));
      snap.structure = structure;
      console.log(`[probe] 评论行数=${(structure as any).rowCount}, engage-bar like href=${(structure as any).engageLikeHref}`);
      console.log(`[probe] 行内 svg use href 种类:`, JSON.stringify((structure as any).distinctUseHrefs));
      console.log(`[probe] 第一行赞控件候选:`, JSON.stringify((structure as any).rows?.[0]?.likeCandidates ?? []));

      // 4) 虚拟化检查：快照锚点 → 大力滚动 → 看 getElementById 存活率
      const before = await evalJson<string[]>(cdp, SNAPSHOT_IDS_EXPR).catch(() => [] as string[]);
      const snapshotIds = (before as string[]).slice(0, 40);
      snap.snapshotIds = snapshotIds;
      console.log(`[probe] 锚点快照 ${snapshotIds.length} 条，大力滚动评论区 …`);
      let lastScroll: unknown = null;
      for (let i = 0; i < 14; i++) {
        lastScroll = await evalJson(cdp, SCROLL_EXPR).catch(() => null);
        await sleep(450);
      }
      snap.lastScroll = lastScroll;
      const survival = await evalJson(cdp, survivalExpr(snapshotIds)).catch((e) => ({ error: String(e) }));
      snap.virtualization = survival;
      const s = survival as any;
      if (s && typeof s.alive === 'number') {
        const rate = s.snapshotCount ? Math.round((s.alive / s.snapshotCount) * 100) : 0;
        console.log(`[probe] 虚拟化结果：滚动后 ${s.alive}/${s.snapshotCount} 锚点仍可 getElementById（存活率 ${rate}%），当前可见 ${s.currentVisible}、新出现 ${s.freshCount}`);
        snap.survivalRatePct = rate;
      }

      // 5) 点赞标定（仅 AIDCP_LIKE_CALIBRATE=1）：点→读→取消→读，自还原，抓「已赞」信号
      if (process.env.AIDCP_LIKE_CALIBRATE === '1') {
        console.log('[probe] === 点赞标定（点一次→读取变化→再点取消，净状态为零）===');
        const same = (a: any, b: any) => a && b && a.cls === b.cls && a.useHref === b.useHref && a.count === b.count;
        const read = (id: string) => evalJson<any>(cdp, readLikeStateExpr(id)).catch(() => ({ found: false }));
        const t = await evalJson<any>(cdp, FIND_LIKE_TARGET_EXPR).catch(() => ({ found: false }));
        if (!t.found) {
          console.log('   找不到可标定的评论赞按钮:', JSON.stringify(t));
        } else {
          await sleep(500);
          const before = await read(t.anchorId);
          console.log('   BEFORE :', JSON.stringify(before));
          let cx = before.cx ?? t.cx, cy = before.cy ?? t.cy;
          await dispatchClick(cdp, cx, cy);
          await sleep(1400);
          let after = await read(t.anchorId);
          if (same(before, after)) {
            console.log('   click#1 无变化，重试一次');
            const fresh = await read(t.anchorId);
            cx = fresh.cx ?? cx; cy = fresh.cy ?? cy;
            await dispatchClick(cdp, cx, cy);
            await sleep(1400);
            after = await read(t.anchorId);
          }
          console.log('   AFTER  :', JSON.stringify(after));
          snap.calibration = { anchorId: t.anchorId, before, after };
          if (same(before, after)) {
            console.log('   ⚠️ 两次点击都没观察到变化——未改动状态，但也没抓到信号（坐标/选择器可能需调整）。');
          } else {
            const fresh2 = await read(t.anchorId);
            await dispatchClick(cdp, fresh2.cx ?? cx, fresh2.cy ?? cy);
            await sleep(1400);
            const restored = await read(t.anchorId);
            (snap.calibration as any).restored = restored;
            console.log('   RESTORED:', JSON.stringify(restored));
            const okRestore = same(before, restored);
            console.log(`   还原校验: ${okRestore ? '✅ OK（净状态为零）' : '⚠️ 未完全还原！请手动核对/取消该评论赞 anchor=' + t.anchorId}`);
            // 差异摘要
            const diff: string[] = [];
            if (before.cls !== after.cls) diff.push(`class: "${before.cls}" → "${after.cls}"`);
            if (before.useHref !== after.useHref) diff.push(`svg use href: "${before.useHref}" → "${after.useHref}"`);
            if (before.count !== after.count) diff.push(`count: "${before.count}" → "${after.count}"`);
            console.log('   【已赞信号】', diff.length ? diff.join(' ; ') : '(无可见差异?)');
          }
        }
      }

      probed = true;
    }
    snap.tried = tried;
    snap.probed = probed;
    if (!probed) console.log('[probe] ✗ 前几篇都没探到评论，请换一批 feed 重试。');
  } finally {
    await writeSnap(snap, session);
    session.close();
  }
}

async function writeSnap(snap: Record<string, unknown>, session: Awaited<ReturnType<typeof attachToPage>>) {
  const jsonPath = `/tmp/aidcp-comment-like-probe-${TS}.json`;
  writeFileSync(jsonPath, JSON.stringify(snap, null, 2));
  console.log(`[probe] 快照写入 ${jsonPath}`);
  try {
    const shot = await session.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const pngPath = `/tmp/aidcp-comment-like-probe-${TS}.png`;
    writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    console.log(`[probe] 截图写入 ${pngPath}`);
  } catch {
    /* 截图失败不影响快照 */
  }
}

main().catch((e) => {
  console.error('[probe] 失败:', e);
  process.exit(1);
});
