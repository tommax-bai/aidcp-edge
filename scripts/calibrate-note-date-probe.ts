/**
 * calibrate-note-date-probe.ts — 笔记详情页「发布时刻」窄选择器真机标定（宽/窄双布局）
 * （change feed-hot-lead-group-comment，backlog 簇 16）。
 *
 * 连到已登录小红书的 Chrome（CDP），导航到 explore feed，点开第一篇笔记详情，在**宽**与**窄**两个视口
 * 各只读 dump 一次：
 *  1) production `extractPublishedAtText` 复刻（同一组 NOTE_PUBLISHED_AT_SELECTORS + denylist）会抽到什么（EXTRACTED，null=miss）；
 *  2) 逐选择器命中数 / 样本 / 是否落在正文 denylist；
 *  3) 「发现式」扫描：详情作用域内所有文本形如 刚刚/X小时前/昨天/日期 的叶子节点及其路径/类/rect/是否被我的选择器命中
 *     —— 若 EXTRACTED=null，据此定位真·日期节点、回补选择器。
 *
 * 红线：只 Runtime.evaluate 读取 + Page.navigate + Emulation 改视口 + 【一次点击】打开笔记详情（正常浏览动作，
 * 不点赞/评论/关注/发布/上传）。绝不产生任何互动写操作。
 *
 * 用法：AdsPower 起该账号浏览器拿 debug_port → `AIDCP_CDP_PORT=<port> npx tsx scripts/calibrate-note-date-probe.ts`
 */

import { attachToPage } from '../src/cdp/index.js';

const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
const URL_INCLUDES = process.env.AIDCP_CDP_URL_INCLUDES ?? '';
const EXPLORE_URL = 'https://www.xiaohongshu.com/explore';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 返回第 n 张【视口内、可见、够大】feed 卡片【封面区】中心坐标（供 CDP 真坐标点击，触发 XHS 原生打开详情
// modal——带 xsec_token，避免裸 href 导航 404）。点封面上部（图区）比卡片正中更可靠。仿真实边端坐标点击开笔记。
const FIND_NTH_CARD_CENTER = (n: number) => String.raw`(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const cards = Array.from(document.querySelectorAll('section.note-item, [class*="note-item"]'))
    .filter(el => { const r = el.getBoundingClientRect(); return r.width>=120 && r.height>=120 && r.top>=60 && r.top<=vh-100 && r.left>=0 && r.left<=vw; });
  const el = cards[${n}];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + Math.min(60, r.height*0.3)), idx: ${n} };
})()`;

// 详情是否已打开 + 记录 modal 容器（供回补 scope 选择器）。
const OPEN_CHECK = String.raw`(() => {
  const url = location.href;
  const byUrl = /\/explore\/[0-9a-f]{16,}/.test(url) && url.indexOf('xsec_token') >= 0;
  const container = document.querySelector('.note-detail-mask, #noteContainer, [class*="note-scroller"], [class*="noteScroll"], #detail-desc, .note-content');
  const clsOf = (el) => el ? String((el.className && el.className.baseVal!=null)?el.className.baseVal:(el.className||'')) : '';
  return { open: byUrl || !!container, byUrl, containerCls: clsOf(container).slice(0,60), url: url.slice(0,90) };
})()`;

const PRECLICK_DIAG = String.raw`(() => {
  const clean = (s) => (s||'').replace(/\s+/g,' ').trim();
  const bodyText = clean((document.body && document.body.innerText) || '').slice(0,400);
  const has = (t) => bodyText.indexOf(t) >= 0;
  const loginModal = !!document.querySelector('[class*="login"], [class*="Login"], .login-container, [class*="mask"]');
  const cardCount = document.querySelectorAll('section.note-item, [class*="note-item"]').length;
  const scopeCandidates = ['#noteContainer','.note-detail-mask','.note-container','[class*="note-detail"]','[class*="noteContainer"]']
    .map(s => ({ s, n: document.querySelectorAll(s).length }));
  return { href: location.href, looksLoggedIn: !/扫码登录|手机号登录|登录后查看|立即登录/.test(bodyText) && location.href.indexOf('/login')<0, hasLoginWord: has('登录'), loginModalPresent: loginModal, cardCount, scopeCandidates, bodyHead: bodyText.slice(0,120) };
})()`;

const DUMP_EXPRESSION = String.raw`(() => {
  const SELECTORS = ['.bottom-container .date','[class*="bottom-container"] .date','.bottom-container time','time[datetime]','.date','[class*="date"]'];
  const DENYLIST = '#detail-desc, .desc, .note-text, .comment-item, [class*="comment-item"], [class*="comment"]';
  const clean = (s) => (s||'').replace(/\s+/g,' ').trim();
  const clsOf = (el) => String((el.className && el.className.baseVal!=null)?el.className.baseVal:(el.className||''));
  const rectOf = (el) => { const r=el.getBoundingClientRect(); return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}; };
  const pathOf = (el) => { const p=[]; let n=el; for(let i=0;i<5&&n&&n.nodeType===1;i++){ let s=n.tagName.toLowerCase(); const c=clsOf(n).trim().split(/\s+/).filter(Boolean).slice(0,2).join('.'); if(c)s+='.'+c; p.unshift(s); n=n.parentElement;} return p.join(' > '); };

  const scope = document.querySelector('#noteContainer, .note-detail-mask, .note-container, [class*="note-detail"]') || document.body;

  // production extractPublishedAtText 复刻
  let extracted = null, extractedSel = null;
  for (const sel of SELECTORS) {
    let hit = null;
    for (const el of Array.from(scope.querySelectorAll(sel))) {
      if (el.closest(DENYLIST)) continue;
      const t = clean(el.textContent);
      if (t) { hit = t; break; }
    }
    if (hit) { extracted = hit; extractedSel = sel; break; }
  }

  const perSel = SELECTORS.map(sel => {
    let els = [];
    try { els = Array.from(scope.querySelectorAll(sel)); } catch(e) {}
    return { sel, count: els.length, samples: els.slice(0,3).map(el => ({ text: clean(el.textContent).slice(0,40), inBody: !!el.closest(DENYLIST), cls: clsOf(el).slice(0,50), rect: rectOf(el) })) };
  });

  // 发现式：真·日期叶子节点
  const TIME_RE = /^(编辑于\s*)?(刚刚|\d+\s*分钟前|\d+\s*小时前|昨天|前天|\d+\s*天前|\d{1,4}[-\/年]\d{1,2}([-\/月]\d{1,2})?日?)/;
  const dateNodes = []; const seen = new Set();
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, null);
  let node;
  while ((node = walker.nextNode())) {
    const t = clean(node.textContent);
    if (t.length===0 || t.length>30) continue;
    if (!TIME_RE.test(t)) continue;
    if (node.querySelectorAll('*').length > 2) continue; // 近叶子
    const key = pathOf(node)+'|'+t;
    if (seen.has(key)) continue; seen.add(key);
    let matched = null; for (const s of SELECTORS) { try { if (node.matches(s)) { matched = s; break; } } catch(e){} }
    dateNodes.push({ text: t.slice(0,40), path: pathOf(node), cls: clsOf(node).slice(0,60), inBody: !!node.closest(DENYLIST), rect: rectOf(node), matchedByMySelector: matched });
    if (dateNodes.length>=10) break;
  }

  const bodyText = clean((document.body && document.body.innerText) || '').slice(0,200);
  return {
    href: location.href,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    scopeFound: scope === document.body ? '(fallback body)' : (scope.id || clsOf(scope)),
    looksLoggedIn: !/扫码登录|登录后查看|手机号登录/.test(bodyText) && location.href.indexOf('/login')<0,
    detailOpen: /\/explore\/[0-9a-f]+/.test(location.href) || !!document.querySelector('#noteContainer, .note-detail-mask'),
    EXTRACTED_by_production: extracted,
    extractedBySelector: extractedSel,
    perSelector: perSel,
    discoveredDateNodes: dateNodes,
  };
})()`;

async function evaluate(session: { cdp: { send: <T>(m: string, p?: unknown) => Promise<T> } }, expr: string): Promise<unknown> {
  const res = await session.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true },
  );
  if (res.exceptionDetails) return { __exception: JSON.stringify(res.exceptionDetails).slice(0, 400) };
  return res.result?.value;
}

async function dumpOnce(session: any, label: string): Promise<void> {
  const v = await evaluate(session, DUMP_EXPRESSION);
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(v, null, 2));
}

async function main(): Promise<void> {
  console.log(`[date-probe] 连接 CDP ${HOST}:${PORT}（只读 + 单次开笔记点击）...`);
  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: URL_INCLUDES, stealth: false });
  try {
    console.log(`[date-probe] Page.navigate → ${EXPLORE_URL}`);
    await session.cdp.send('Page.navigate', { url: EXPLORE_URL });
    await sleep(9000); // 等客户端 feed 渲染（覆盖 SSR 占位）
    const pre = await evaluate(session, PRECLICK_DIAG);
    console.log('[date-probe] PRE-CLICK 诊断:', JSON.stringify(pre));
    await evaluate(session, 'window.scrollBy(0, 400); true');
    await sleep(1500);

    // 可靠开笔记：从 feed 提取带 xsec_token 的笔记链接，直接 Page.navigate（坐标点击在部分会话不稳）。
    const GET_TOKENED_HREF = String.raw`(() => {
      for (const a of Array.from(document.querySelectorAll('a[href*="/explore/"]'))) {
        const h = a.getAttribute('href') || '';
        if (h.indexOf('xsec_token') >= 0) return h.charAt(0) === '/' ? location.origin + h : h;
      }
      return null;
    })()`;
    const href = (await evaluate(session, GET_TOKENED_HREF)) as string | null;
    console.log('[date-probe] 带 token 笔记链接:', href ? href.slice(0, 90) : 'null');
    let opened = false;
    if (href) {
      await session.cdp.send('Page.navigate', { url: href });
      await sleep(5000);
      const chk = (await evaluate(session, OPEN_CHECK)) as { open: boolean; containerCls: string; url: string };
      console.log(`[date-probe] 详情 open=${chk.open} container='${chk.containerCls}'`);
      opened = chk.open;
    }
    if (!opened) console.log('[date-probe] ⚠️ 未能打开详情；dump 仅作诊断');

    try { await session.cdp.send('Emulation.clearDeviceMetricsOverride'); } catch {}
    await sleep(400);
    await dumpOnce(session, 'WIDE');

    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(2000);
    await dumpOnce(session, 'NARROW(800x1000)');

    // 更窄一档，探响应式断点
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2000);
    await dumpOnce(session, 'NARROW(500x900)');

    try { await session.cdp.send('Emulation.clearDeviceMetricsOverride'); } catch {}
    console.log('\n[date-probe] done（未互动/未发布；视口已复位）。');
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error('[date-probe] 失败:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
