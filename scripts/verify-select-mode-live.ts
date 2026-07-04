/**
 * verify-select-mode-live.ts — 真机端到端验证 production runSelectMode（change publish-select-mode-layout-robust）。
 *
 * 连到已登录的创作平台 Chrome，Page.navigate 到发布页，用**真实的** PublishCommandDispatcher 跑一条
 * `select_mode` 指令（CDP 路径），观察：是否点中**可见**的「上传图文」tab、是否真切到图文模式、回报 ok。
 *
 * 红线：只切「上传图文」发布模式这一步（production select_mode 同款，与 calibrate-imgtab-probe 同级）——
 * **绝不**填写 / 上传 / 提交任何会产生发布的元素。跑完导航到 about:blank 复位。
 *
 * 用法：AIDCP_CDP_PORT=<port> AIDCP_CDP_URL_INCLUDES=xiaohongshu npx tsx scripts/verify-select-mode-live.ts
 */

import { attachToPage } from '../src/cdp/index.js';
import { PublishCommandDispatcher } from '../src/flows/publish-command-handlers.js';

const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
const URL_INCLUDES = process.env.AIDCP_CDP_URL_INCLUDES ?? 'adspower';
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 只读状态快照：当前模式（激活 tab 图文/视频）+ 文件输入 accept + 可见「上传图文」的 rect。
const STATE_EXPR = String.raw`(() => {
  const visible = (el) => { try { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const vw = window.innerWidth||0, vh = window.innerHeight||0; return r.right>0 && r.bottom>0 && r.left<vw && r.top<vh; } catch(e){ return false; } };
  const txtOf = (e) => ((e.innerText||e.textContent||'')).replace(/\s+/g,'').trim();
  const clsOf = (el) => String((el.className && el.className.baseVal!=null)?el.className.baseVal:(el.className||''));
  const activeOf = (el) => { const c=clsOf(el); return /(^|[\s_-])(active|selected|current)([\s_-]|$)/i.test(c) || el.getAttribute('aria-selected')==='true' || el.getAttribute('aria-current')==='true'; };
  const tabs = Array.prototype.slice.call(document.querySelectorAll('[role=tab],[class*=creator-tab],[class*=tab]'));
  let mode = '';
  for (const t of tabs) { if(!visible(t)||!activeOf(t)) continue; const x=txtOf(t); const i=x.indexOf('图文')>=0, v=x.indexOf('视频')>=0; if(i&&!v){mode='image';break;} if(v&&!i){mode='video';} }
  const fis = Array.prototype.slice.call(document.querySelectorAll('input[type=file]')).map((fi)=>fi.getAttribute('accept'));
  const visImgTab = tabs.filter((t)=>visible(t)&&txtOf(t)==='上传图文').map((t)=>{const r=t.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top)};});
  return { mode, fileAccepts: fis, visibleImgTabRects: visImgTab };
})()`;

async function readState(cdp: { send: <T>(m: string, p?: unknown) => Promise<T> }): Promise<unknown> {
  const r = await cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true });
  return r.result?.value;
}

async function main(): Promise<void> {
  console.log(`[verify] 连接 CDP ${HOST}:${PORT} ...`);
  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: URL_INCLUDES, stealth: false });
  try {
    console.log(`[verify] Page.navigate → ${PUBLISH_URL}`);
    await session.cdp.send('Page.navigate', { url: PUBLISH_URL });
    await sleep(6000);

    const cdp = session.cdp as unknown as { send: <T>(m: string, p?: unknown) => Promise<T> };
    console.log('[verify] BEFORE:', JSON.stringify(await readState(cdp)));

    // 真实 dispatcher：select_mode 的 CDP 路径只用 this.cdp + this.clock，deps 用最小桩（不被触达）。
    const deps = {
      dom: { getRoot: async () => ({}) },
      executor: { execute: () => {} },
      selector: { select: async () => ({ index: null, reason: 'none' }) },
      cache: { get: () => undefined, stage: () => {}, confirm: () => {}, drop: () => {} },
    } as unknown as ConstructorParameters<typeof PublishCommandDispatcher>[0];
    const dispatcher = new PublishCommandDispatcher(
      deps, {}, Date.now, undefined,
      cdp as unknown as ConstructorParameters<typeof PublishCommandDispatcher>[4],
      { sleep: async () => {}, enabled: true },
    );

    const t0 = Date.now();
    const res = await dispatcher.dispatch({ recordId: 0, seq: 1, kind: 'select_mode', params: {} } as never);
    console.log(`[verify] select_mode RESULT (${Date.now() - t0}ms):`, JSON.stringify(res));

    await sleep(1500);
    console.log('[verify] AFTER:', JSON.stringify(await readState(cdp)));

    // 复位：离开发布页（未填未传未发）。
    await session.cdp.send('Page.navigate', { url: 'about:blank' });
    console.log('[verify] done（只切了图文模式、未填/未传/未发；已导航 about:blank 复位）。');
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error('[verify] 失败:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
