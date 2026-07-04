/**
 * calibrate-select-mode-layout.ts — 创作发布页「上传图文」tab 宽/窄双布局只读标定
 * （change publish-select-mode-layout-robust，backlog 簇 12 task 1）。
 *
 * 连到已登录小红书创作平台的 Chrome（CDP），Page.navigate 到发布页，在**宽**与**窄**两个视口
 * （Emulation.setDeviceMetricsOverride）各只读 dump 一次：所有 tab 候选（creator-tab / header-tabs /
 * [role=tab] / [class*=tab]）的 文本 / class / 可见性(offsetParent||getClientRects) / 激活态 / rect，
 * 以及 file input 的 accept/可见性；并跑 production 同款 MODE_STATE 判据 + 一个「只选不点」的
 * CLICK_TAB 选择逻辑，报告在每个布局下 runSelectMode **会点哪个** tab（不真点）。
 *
 * 红线：**严格只读** —— 只 Runtime.evaluate 读取 + Page.navigate + Emulation 改视口，
 * 绝不点击 / 输入 / 上传 / 提交任何元素。
 *
 * 用法：AdsPower 起该账号浏览器拿 debug_port → `AIDCP_CDP_PORT=<port> npx tsx scripts/calibrate-select-mode-layout.ts`
 */

import { attachToPage } from '../src/cdp/index.js';

const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
// 附着的 tab url 关键词：AdsPower 起浏览器默认停在 start.adspower.net 启动页（非 xiaohongshu）→ 默认匹配 'adspower'；
// 若 tab 已在小红书创作页（如本探针跑过一次后），用 AIDCP_CDP_URL_INCLUDES=xiaohongshu 覆盖。
const URL_INCLUDES = process.env.AIDCP_CDP_URL_INCLUDES ?? 'adspower';
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 只读采集：镜像 production runSelectMode 的 IS_VISIBLE / MODE_STATE / CLICK_TAB 候选逻辑，
// 但 CLICK_TAB 改为「只选不点」返回被选中 tab 的描述符（供核对取可见是否正确）。
const DUMP_EXPRESSION = String.raw`(() => {
  const visible = (el) => { try { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0; const vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0; return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh; } catch (e) { return false; } };
  const txtOf = (e) => ((e.innerText || e.textContent || '')).replace(/\s+/g, '').trim();
  const clsOf = (el) => String((el.className && el.className.baseVal != null) ? el.className.baseVal : (el.className || ''));
  const activeOf = (el) => {
    const cls = clsOf(el);
    return /(^|[\s_-])(active|selected|current)([\s_-]|$)/i.test(cls)
      || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'true';
  };
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const desc = (el) => ({ tag: el.tagName.toLowerCase(), text: txtOf(el).slice(0, 24), cls: clsOf(el).slice(0, 80), role: el.getAttribute && el.getAttribute('role'), visible: visible(el), active: activeOf(el), rect: rectOf(el) });
  const all = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; } };

  // 全部 tab 候选（去重）。
  const tabNodes = [];
  const seen = new Set();
  for (const sel of ['[class*=creator-tab]', '[class*=header-tab]', '[role=tab]', '[class*=tab]']) {
    for (const el of all(sel)) { if (!seen.has(el)) { seen.add(el); tabNodes.push(el); } }
  }
  const tabs = tabNodes.map(desc).filter((d) => d.text.length > 0 && d.text.length <= 12);

  // 文本涉及「图文 / 视频」的所有元素（不限 tab class，用于发现窄布局别样形态）。
  const byKw = (kw) => all('div,span,button,a,li,[role=tab],[role=button]')
    .filter((e) => { const t = txtOf(e); return t.length > 0 && t.length <= 10 && t.indexOf(kw) >= 0; })
    .map(desc);

  // MODE_STATE（production 同款）。
  const modeState = (() => {
    for (const t of tabNodes) {
      if (!visible(t)) continue;
      if (!activeOf(t)) continue;
      const txt = txtOf(t);
      const isImg = txt.indexOf('图文') >= 0, isVid = txt.indexOf('视频') >= 0;
      if (isImg && !isVid) return 'image';
      if (isVid && !isImg) return 'video-seen';
    }
    return '';
  })();

  // CLICK_TAB「只选不点」：报告 runSelectMode 会点哪个 + 命中层级。
  const pick = (() => {
    const allEls = all('div,span,button,a,li,[role=tab],[role=button]');
    const vis = allEls.filter(visible);
    let tab = vis.find((e) => txtOf(e) === '上传图文' && /creator-tab/.test(clsOf(e)));
    if (tab) return { tier: 1, el: desc(tab) };
    tab = vis.find((e) => txtOf(e) === '上传图文' && /tab/i.test(clsOf(e)));
    if (tab) return { tier: 2, el: desc(tab) };
    tab = vis.find((e) => txtOf(e) === '上传图文');
    if (tab) return { tier: 3, el: desc(tab) };
    const cand = vis.filter((e) => {
      const t = txtOf(e);
      return t.length > 0 && t.length <= 6 && t.indexOf('图文') >= 0
        && t.indexOf('视频') < 0 && t.indexOf('长文') < 0 && t.indexOf('播客') < 0 && t.indexOf('直播') < 0
        && (/tab/i.test(clsOf(e)) || e.getAttribute('role') === 'tab' || t === '图文' || t === '写图文');
    });
    cand.sort((a, b) => txtOf(a).length - txtOf(b).length);
    return cand[0] ? { tier: 'narrow-best-effort', el: desc(cand[0]) } : { tier: 'none', el: null };
  })();

  const fileInputs = all('input[type=file]').map((fi) => ({ accept: fi.getAttribute('accept'), visible: visible(fi), cls: clsOf(fi).slice(0, 60) }));
  const bodyText = (document.body && document.body.innerText) || '';

  return {
    href: location.href,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    looksLoggedIn: !/扫码登录|手机号登录/.test(bodyText.slice(0, 300)) && location.href.indexOf('/login') < 0,
    modeState,
    wouldClick: pick,
    imgTextTags: byKw('图文'),
    videoTags: byKw('视频'),
    allTabs: tabs,
    fileInputs,
    bodyHasImgWords: bodyText.indexOf('上传图片') >= 0 || bodyText.indexOf('文字配图') >= 0,
  };
})()`;

async function dumpOnce(session: { cdp: { send: <T>(m: string, p?: unknown) => Promise<T> } }, label: string): Promise<void> {
  const res = await session.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression: DUMP_EXPRESSION, returnByValue: true },
  );
  console.log(`\n===== ${label} LAYOUT (read-only) =====`);
  if (res.exceptionDetails) {
    console.error('evaluate exception:', JSON.stringify(res.exceptionDetails, null, 2));
    return;
  }
  console.log(JSON.stringify(res.result?.value, null, 2));
}

async function main(): Promise<void> {
  console.log(`[calib] 连接 CDP ${HOST}:${PORT}（严格只读）...`);
  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: URL_INCLUDES, stealth: false });
  try {
    console.log(`[calib] Page.navigate → ${PUBLISH_URL}`);
    await session.cdp.send('Page.navigate', { url: PUBLISH_URL });
    await sleep(6000); // 冷加载 + tab 渲染

    // 1) 宽布局（清除任何 override，用真实窗口宽度）。
    try { await session.cdp.send('Emulation.clearDeviceMetricsOverride'); } catch {}
    await sleep(500);
    await dumpOnce(session, 'WIDE');

    // 2) 窄布局（强制窄视口触发响应式断点）。
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 600, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2500);
    await dumpOnce(session, 'NARROW(600x900)');

    // 3) 复位视口（不改页面内容）。
    try { await session.cdp.send('Emulation.clearDeviceMetricsOverride'); } catch {}
    console.log('\n[calib] done（未点击/未上传/未发布；视口已复位）。');
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error('[calib] 失败:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
