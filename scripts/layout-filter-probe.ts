/**
 * layout-filter-probe.ts — 三布局搜索页「原生筛选」调研探针（investigation, 非生产代码）
 * ===========================================================================
 * 用户报告：搜索结果页有三种情况——① AI 总结在上部(窄版) ② AI 总结在右侧(宽版) ③ 无 AI 总结。
 * 现有 applySearchFilters 只在「宽 AI 搜索页」标定过；本探针把三布局各自的筛选区结构 + 交互摸清。
 *
 * 能力（组合 flag）：
 *   --resize=WxH   先把窗口 setWindowBounds 到指定尺寸（造宽/窄），如 --resize=1440x980 / --resize=560x900
 *   --search=词     导航到小红书 + 真实搜索进结果页（复用生产 executeSearch）
 *   --hover        只 hover「筛选/已筛选」触发器，不 click，dump 面板展开后的时间/排序选项可见性
 *   --production   端到端跑真实 applySearchFilters({most_collected, one_day})（= /comment 用的路径），前后对比
 *   （无 flag）      纯只读：dump 当前页结构 + 截图
 *
 * 环境：AIDCP_CDP_PORT（AdsPower debug_port）/ AIDCP_CDP_HOST（默认 127.0.0.1）
 * 产物：/tmp/aidcp-layout-probe-<ts>-<stage>.{json,png}
 */
import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { attachToPage } from '../src/cdp/index.js';
import { evalRaw } from '../src/browse/cdp-util.js';
import { applySearchFilters, executeSearch } from '../src/browse/search-handler.js';

const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hasFlag(n: string) { return process.argv.includes(`--${n}`); }
function readArg(n: string, d: string) {
  const p = `--${n}=`; const h = process.argv.find((a) => a.startsWith(p)); return h ? h.slice(p.length) : d;
}

const SORT_TEXTS = ['综合', '最新', '最多点赞', '最多收藏', '最多评论'];
const TIME_TEXTS = ['不限', '一天内', '一周内', '半年内'];

// ── 全景 DOM dump：页面类型 / 布局 / AI 总结几何 / 排序 tab / 筛选触发器 + 面板 / 时间选项 ──
function buildDumpJs(): string {
  return `(function(){
    function desc(el){ if(!el) return null; var r=el.getBoundingClientRect(); var cs=getComputedStyle(el);
      return { tag:el.tagName.toLowerCase(), cls:((el.className||'')+'').slice(0,140),
        text:(el.textContent||'').trim().slice(0,30),
        rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
        center:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)},
        visible:!!el.offsetParent && r.width>0 && r.height>0, offsetParentNull:el.offsetParent===null,
        ariaHidden: !!(el.closest && el.closest('[aria-hidden="true"]')),
        display:cs.display, visibility:cs.visibility, opacity:cs.opacity, cursor:cs.cursor }; }
    function findExact(texts){ var ns=[].slice.call(document.querySelectorAll('button,a,span,div,li,label,p')); var out=[];
      for(var i=0;i<ns.length;i++){ var t=(ns[i].textContent||'').trim(); if(texts.indexOf(t)===-1) continue; var d=desc(ns[i]); if(d){d.match=t; out.push(d);} } return out; }
    function smallestVisible(text){ var ns=[].slice.call(document.querySelectorAll('button,a,span,div,li,label,p')); var best=null;
      for(var i=0;i<ns.length;i++){ var el=ns[i]; if((el.textContent||'').trim()!==text) continue; if(el.offsetParent===null) continue;
        if(el.closest&&el.closest('[aria-hidden="true"]')) continue; var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) continue;
        var a=r.width*r.height; if(!best||a<best.a){best={el:el,a:a};} } return best?best.el:null; }

    var url=location.href;
    var pageType = /search_result_ai/.test(url) ? 'ai' : (/search_result/.test(url) ? 'classic' : (url.indexOf('search')>=0?'search-other':'non-search'));

    // AI 总结/对话容器检测 + 几何（判「上部」vs「右侧」vs「无」）
    var aiSel = '.ai-feeds-page, .with-ai-chat, [class*="ai-chat"], [class*="ai-summary"], [class*="aiSummary"], [class*="ai-feeds"]';
    var aiNodes = [].slice.call(document.querySelectorAll(aiSel)).filter(function(e){return e.offsetParent!==null && e.getBoundingClientRect().width>0;});
    var aiInfo = null;
    if(aiNodes.length){
      // 取面积最大的那个可见 ai 容器判位置
      var big=null; for(var i=0;i<aiNodes.length;i++){ var r=aiNodes[i].getBoundingClientRect(); var a=r.width*r.height; if(!big||a>big.a) big={el:aiNodes[i],a:a,r:r}; }
      var r=big.r; var vw=innerWidth;
      var position = r.left > vw*0.45 ? 'right' : (r.width > vw*0.7 && r.top < 300 ? 'top' : 'other');
      aiInfo = { cls:((big.el.className||'')+'').slice(0,120), rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}, position:position, count:aiNodes.length };
    }

    // 宽窄（侧栏/底部栏）
    var sb=document.querySelector('.side-bar,[class*="side-bar"]'); var bm=document.querySelector('.bottom-menu-ai,[class*="bottom-menu"]');
    var isWide=!!(sb&&sb.offsetParent!==null); var isNarrow=!!(bm&&bm.offsetParent!==null);

    // 筛选触发器（筛选/已筛选）本体 + 父链
    var fEl = smallestVisible('筛选') || smallestVisible('已筛选');
    var filterDetail=null;
    if(fEl){ var chain=[]; var p=fEl; for(var k=0;k<5&&p;k++){chain.push(desc(p)); p=p.parentElement;} filterDetail={self:desc(fEl), parentChain:chain}; }

    // 排序/筛选栏容器（以「综合」或「筛选」为锚上溯），dump outerHTML 供判结构
    function findBar(){ var all=[].slice.call(document.querySelectorAll('button,a,span,div,li,label,p')); var anchor=null;
      for(var i=0;i<all.length;i++){var t=(all[i].textContent||'').trim(); if((t==='综合'||t==='筛选'||t==='已筛选')&&all[i].offsetParent!==null){anchor=all[i];break;}}
      if(!anchor) return null; var p=anchor;
      for(var k=0;k<8&&p;k++){ var txt=(p.textContent||''); if((txt.indexOf('综合')>=0||txt.indexOf('最多')>=0)&&(txt.indexOf('筛选')>=0||txt.indexOf('已筛选')>=0)) break; p=p.parentElement; }
      if(!p) p=anchor.parentElement; var cs=getComputedStyle(p);
      return { cls:((p.className||'')+'').slice(0,160), display:cs.display, html:(p.outerHTML||'').slice(0,6000) }; }

    return JSON.stringify({
      url:url, pageType:pageType, title:document.title.slice(0,40),
      loginWall:/login|reds-verify|扫码登录/i.test(document.body.innerHTML.slice(0,3000)),
      layout:{innerWidth:innerWidth,innerHeight:innerHeight,isWide:isWide,isNarrow:isNarrow},
      aiSummary:aiInfo,
      sortTabs:findExact(${JSON.stringify(SORT_TEXTS)}),
      timeOptions:findExact(${JSON.stringify(TIME_TEXTS)}),
      filterTriggers:findExact(['筛选','已筛选']),
      filterDetail:filterDetail,
      bar:findBar()
    });
  })()`;
}

async function dump(cdp: any) {
  const raw = await evalRaw<string>(cdp, buildDumpJs()).catch((e) => JSON.stringify({ error: String(e) }));
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { error: 'parse', raw }; }
}

async function snap(stage: string, d: any, session: any) {
  const j = `/tmp/aidcp-layout-probe-${TS}-${stage}.json`;
  writeFileSync(j, JSON.stringify(d, null, 2));
  let png = '(no shot)';
  try { const s = await session.cdp.send('Page.captureScreenshot', { format: 'png' }); png = `/tmp/aidcp-layout-probe-${TS}-${stage}.png`; writeFileSync(png, Buffer.from((s as any).data, 'base64')); } catch (e) { png = `(shot fail ${e})`; }
  console.log(`  [${stage}] ${j}\n            ${png}`);
}

function summarize(tag: string, d: any) {
  if (!d || d.error) { console.log(`  [${tag}] dump err: ${d?.error}`); return; }
  const L = d.layout || {};
  const vis = (arr: any[]) => (arr || []).filter((x) => x.visible && !x.ariaHidden).map((x) => x.match);
  const hid = (arr: any[]) => (arr || []).filter((x) => !x.visible).map((x) => x.match);
  console.log(`  [${tag}] url=${String(d.url).slice(0, 66)}`);
  console.log(`  [${tag}] pageType=${d.pageType} login-wall=${d.loginWall} layout: ${L.innerWidth}x${L.innerHeight} ${L.isWide ? 'WIDE' : ''}${L.isNarrow ? 'NARROW' : ''}`);
  console.log(`  [${tag}] AI总结: ${d.aiSummary ? `位置=${d.aiSummary.position} rect=${JSON.stringify(d.aiSummary.rect)} cls=${d.aiSummary.cls}` : '无'}`);
  console.log(`  [${tag}] 排序tab可见: [${vis(d.sortTabs).join(', ')}]`);
  console.log(`  [${tag}] 时间选项 可见: [${vis(d.timeOptions).join(', ')}]  隐藏: [${hid(d.timeOptions).join(', ')}]`);
  console.log(`  [${tag}] 筛选触发器可见: [${vis(d.filterTriggers).join(', ')}]`);
  if (d.filterDetail?.self) { const f = d.filterDetail.self; console.log(`  [${tag}] 「筛选」本体: <${f.tag} class="${f.cls}"> cursor=${f.cursor} center=(${f.center.x},${f.center.y}) vis=${f.visible}`); }
  else console.log(`  [${tag}] 「筛选」触发器未找到`);
  if (d.bar) console.log(`  [${tag}] 筛选栏容器: <${d.bar.cls}> display=${d.bar.display} (HTML见json.bar.html)`);
}

async function setWindowSize(cdp: any, w: number, h: number) {
  try {
    const win = await cdp.send('Browser.getWindowForTarget');
    const windowId = (win as any).windowId;
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: w, height: h, windowState: 'normal' } });
  } catch (e) { console.log(`  [resize] Browser.setWindowBounds 失败(${e})，退回 Emulation`); }
  // 兜底：deviceMetrics override 保证 innerWidth 生效
  try { await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); } catch {}
}

async function main() {
  console.log(`[layout-probe] attach ${HOST}:${PORT}`);
  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: 'xiaohongshu' }).catch(async () => {
    // 附着任一 page（可能停在 about:blank/explore）
    return attachToPage({ host: HOST, port: PORT, urlIncludes: '' });
  });
  const cdp = session.cdp;

  const resize = readArg('resize', '');
  if (resize) { const [w, h] = resize.split('x').map(Number); console.log(`[layout-probe] resize → ${w}x${h}`); await setWindowSize(cdp, w, h); await sleep(1200); }

  const kw = readArg('search', '');
  if (kw) {
    console.log(`[layout-probe] --search「${kw}」`);
    const cur = await evalRaw<string>(cdp, `location.href`).catch(() => '');
    if (!/xiaohongshu/.test(String(cur))) { await cdp.send('Page.navigate', { url: 'https://www.xiaohongshu.com/explore' }); await sleep(5000); }
    try { await executeSearch(kw, { cdp, sleep, logger: (m) => console.log('    ' + m) }); } catch (e) { console.log(`    ⚠ executeSearch: ${e}`); }
    if (!hasFlag('nowait')) await sleep(3500);
    else console.log('    [nowait] 跳过探针缓冲，立即进入下一步（复刻生产 executeSearch→applySearchFilters 时序）');
  }

  if (hasFlag('watchai')) {
    console.log('\n[watchai] 搜索后轮询 AI 总结容器：文本长度 + 生成中信号（判完成信号）…');
    const watchJs = `(function(){
      var c = document.querySelector('.with-ai-chat [class*="ai-chat"], [class*="ai-chat"], [class*="aiChat"]');
      var body = document.querySelector('[class*="ai-chat"]');
      var txt = body ? (body.textContent||'').trim() : '';
      var gen = /生成中|正在生成|思考中/.test(document.body.textContent||'');
      var loading = !!document.querySelector('[class*="ai-chat"] [class*="loading"], [class*="ai-chat"] [class*="typing"], [class*="ai-chat"] [class*="cursor"], [class*="ai-chat"] [class*="generating"]');
      var withChat = !!document.querySelector('.ai-feeds-page.with-ai-chat, [class*="with-ai-chat"]');
      return JSON.stringify({ textLen: txt.length, tail: txt.slice(-40), gen: gen, loadingEl: loading, withChat: withChat });
    })()`;
    for (let i = 0; i < 20; i++) {
      const w = JSON.parse(await evalRaw<string>(cdp, watchJs).catch(() => '{}'));
      console.log(`    +${(i * 500)}ms textLen=${w.textLen} withChat=${w.withChat} gen中=${w.gen} loadingEl=${w.loadingEl} tail="${w.tail}"`);
      await sleep(500);
    }
  }

  const base = await dump(cdp); summarize('baseline', base); await snap('0-baseline', base, session);

  if (hasFlag('hover')) {
    const c = base.filterDetail?.self?.center;
    if (!c) console.log('\n[hover] 无「筛选」坐标，跳过');
    else {
      console.log(`\n[hover] mouseMoved → 筛选(${c.x},${c.y})，不click，等800ms`);
      // 直线几帧移动过去
      const from = { x: c.x - 80, y: c.y - 50 };
      for (let i = 1; i <= 12; i++) { const t = i / 12; await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + (c.x - from.x) * t), y: Math.round(from.y + (c.y - from.y) * t) }); await sleep(14); }
      await sleep(800);
      const d = await dump(cdp); summarize('after-hover', d); await snap('1-after-hover', d, session);
    }
  }

  if (hasFlag('diag')) {
    // 先把鼠标移开中性区，消除上一轮 hover 残留导致「面板已开」的假象
    for (let i = 0; i < 6; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 400 }); await sleep(20); }
    await sleep(500);
    const closed = await dump(cdp);
    console.log(`\n[diag] 面板收起态：排序可见=[${(closed.sortTabs||[]).filter((x:any)=>x.visible&&!x.ariaHidden).map((x:any)=>x.match).join(',')}] 时间可见=[${(closed.timeOptions||[]).filter((x:any)=>x.visible&&!x.ariaHidden).map((x:any)=>x.match).join(',')}]`);
    await snap('3a-diag-closed', closed, session);
    const c = closed.filterDetail?.self?.center;
    if (!c) { console.log('[diag] 无筛选触发器坐标，跳过'); }
    else {
      const from = { x: c.x - 80, y: c.y - 50 };
      for (let i = 1; i <= 12; i++) { const t = i / 12; await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + (c.x - from.x) * t), y: Math.round(from.y + (c.y - from.y) * t) }); await sleep(14); }
      await sleep(900);
      // 对每个目标：dump 所有同名节点 + elementFromPoint(命中谁)
      const targets = ['最多收藏', '一天内'];
      const diagJs = `(function(){
        var targets=${JSON.stringify(targets)};
        function info(el){ if(!el) return null; var r=el.getBoundingClientRect(); var cs=getComputedStyle(el);
          return { tag:el.tagName.toLowerCase(), cls:((el.className||'')+'').slice(0,80), text:(el.textContent||'').trim().slice(0,16),
            ariaHidden:!!(el.closest&&el.closest('[aria-hidden="true"]')), dataHp: el.getAttribute&&el.getAttribute('data-hp-kind'),
            rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
            center:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}, z:cs.zIndex, pe:cs.pointerEvents, offNull:el.offsetParent===null }; }
        var out={};
        for(var ti=0;ti<targets.length;ti++){ var tgt=targets[ti];
          var ns=[].slice.call(document.querySelectorAll('button,a,span,div,li,label,p'));
          var matches=[]; for(var i=0;i<ns.length;i++){ if((ns[i].textContent||'').trim()===tgt) matches.push(info(ns[i])); }
          // 取「最小可见且非aria-hidden」那个的中心，看 elementFromPoint 命中谁
          var pick=null; for(var i=0;i<ns.length;i++){ var el=ns[i]; if((el.textContent||'').trim()!==tgt) continue; if(el.offsetParent===null) continue; if(el.closest&&el.closest('[aria-hidden="true"]')) continue; var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) continue; var a=r.width*r.height; if(!pick||a<pick.a){pick={el:el,a:a,cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2)};} }
          var hit=null, hitChain=[];
          if(pick){ var e=document.elementFromPoint(pick.cx,pick.cy); hit=info(e); var p=e; for(var k=0;k<4&&p;k++){hitChain.push({tag:p.tagName.toLowerCase(),cls:((p.className||'')+'').slice(0,60),ah:p.getAttribute&&p.getAttribute('aria-hidden'),dhp:p.getAttribute&&p.getAttribute('data-hp-kind')}); p=p.parentElement;} }
          out[tgt]={ nodeCount:matches.length, nodes:matches, pickCenter:pick?{x:pick.cx,y:pick.cy}:null, elementFromPoint:hit, hitChain:hitChain };
        }
        return JSON.stringify(out);
      })()`;
      const diagRaw = await evalRaw<string>(cdp, diagJs).catch((e) => JSON.stringify({ error: String(e) }));
      const diag = JSON.parse(typeof diagRaw === 'string' ? diagRaw : '{}');
      writeFileSync(`/tmp/aidcp-layout-probe-${TS}-3b-diag.json`, JSON.stringify(diag, null, 2));
      for (const tgt of targets) {
        const d = diag[tgt]; if (!d) continue;
        console.log(`\n[diag] 「${tgt}」同名节点=${d.nodeCount}`);
        for (const n of d.nodes) console.log(`    ${n.ariaHidden ? '⊘aria-hidden' : '✓real'} <${n.tag} class="${n.cls}" data-hp=${n.dataHp}> rect=${JSON.stringify(n.rect)} z=${n.z} pe=${n.pe} offNull=${n.offNull}`);
        console.log(`    pickCenter=${JSON.stringify(d.pickCenter)} → elementFromPoint命中: ${d.elementFromPoint ? `<${d.elementFromPoint.tag} class="${d.elementFromPoint.cls}" data-hp=${d.elementFromPoint.dataHp} aria=${d.elementFromPoint.ariaHidden}>` : 'null'}`);
        console.log(`    命中链: ${d.hitChain.map((h: any) => `${h.tag}${h.dhp ? '[hp=' + h.dhp + ']' : ''}${h.ah === 'true' ? '[aria-hidden]' : ''}`).join(' → ')}`);
      }
      await snap('3c-diag-open', await dump(cdp), session);
      console.log(`\n[diag] 明细 → /tmp/aidcp-layout-probe-${TS}-3b-diag.json`);
    }
  }

  if (hasFlag('closeai')) {
    // 找 AI 总结面板右上角的 × 关闭钮并点掉 → 复现情况③「无 AI 总结」
    const findCloseJs = `(function(){
      // AI 面板容器候选
      var cont = document.querySelector('.ai-chat, [class*="ai-chat"], [class*="aiChat"], [class*="ai-summary"]');
      var cands=[];
      function push(el,why){ if(!el||el.offsetParent===null) return; var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) return; cands.push({why:why,tag:el.tagName.toLowerCase(),cls:((el.className||'')+'').slice(0,80),center:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)},rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}}); }
      // 1) 容器内 class 含 close 的
      var scope = cont || document;
      [].slice.call(scope.querySelectorAll('[class*="close"],[class*="Close"]')).forEach(function(e){push(e,'cls-close');});
      // 2) 容器内 svg use #close / xlink close
      [].slice.call(scope.querySelectorAll('svg use')).forEach(function(u){ var h=(u.getAttribute('xlink:href')||u.getAttribute('href')||''); if(/close/i.test(h)){ push(u.closest('svg')||u, 'use-close'); } });
      // 3) 文本恰为 × 或 ✕ 的小元素
      [].slice.call(document.querySelectorAll('span,div,button,i')).forEach(function(e){ var t=(e.textContent||'').trim(); if(t==='×'||t==='✕'||t==='╳'){ push(e,'x-char'); } });
      return JSON.stringify({ hasContainer: !!cont, containerCls: cont?((cont.className||'')+'').slice(0,80):null, candidates: cands.slice(0,20) });
    })()`;
    const cinfo = JSON.parse(await evalRaw<string>(cdp, findCloseJs).catch(() => '{}'));
    console.log(`\n[closeai] AI容器=${cinfo.hasContainer} cls=${cinfo.containerCls}`);
    (cinfo.candidates || []).forEach((c: any) => console.log(`    候选[${c.why}] <${c.tag} class="${c.cls}"> center=(${c.center.x},${c.center.y}) rect=${JSON.stringify(c.rect)}`));
    // 取最靠右上的候选点击
    const cand = (cinfo.candidates || []).sort((a: any, b: any) => (b.center.x - b.center.y) - (a.center.x - a.center.y))[0];
    if (cand) {
      console.log(`[closeai] 点关闭钮 @(${cand.center.x},${cand.center.y})`);
      const from = { x: cand.center.x - 60, y: cand.center.y + 40 };
      for (let i = 1; i <= 10; i++) { const t = i / 10; await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + (cand.center.x - from.x) * t), y: Math.round(from.y + (cand.center.y - from.y) * t) }); await sleep(14); }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cand.center.x, y: cand.center.y, button: 'left', clickCount: 1 }); await sleep(40);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cand.center.x, y: cand.center.y, button: 'left', clickCount: 1 });
      await sleep(1500);
      const d = await dump(cdp); summarize('after-closeai', d); await snap('6-after-closeai', d, session);
    } else console.log('[closeai] 未找到关闭钮候选');
  }

  if (hasFlag('exp')) {
    const activeJs = (texts: string[]) => `(function(){
      var T=${JSON.stringify(texts)}; var SEL=['active','selected','checked','current','is-active']; var out={};
      var ns=[].slice.call(document.querySelectorAll('div,span,li,button,a'));
      for(var ti=0;ti<T.length;ti++){ var tgt=T[ti]; out[tgt]=false;
        for(var i=0;i<ns.length;i++){ var el=ns[i]; if((el.textContent||'').trim()!==tgt) continue; if(el.offsetParent===null) continue; if(el.closest&&el.closest('[aria-hidden="true"]')) continue;
          var p=el; for(var k=0;k<4&&p;k++){ var toks=((p.className||'')+'').split(/\\s+/); for(var j=0;j<SEL.length;j++){ if(toks.indexOf(SEL[j])>=0){out[tgt]=true;} } p=p.parentElement; } } }
      return JSON.stringify(out); })()`;
    const readActive = async (texts: string[]) => JSON.parse(await evalRaw<string>(cdp, activeJs(texts)).catch(() => '{}'));
    const centerOf = async (text: string) => {
      const r = await evalRaw<string>(cdp, `(function(){var ns=[].slice.call(document.querySelectorAll('div,span,li,button,a'));var best=null;for(var i=0;i<ns.length;i++){var el=ns[i];if((el.textContent||'').trim()!==${JSON.stringify(text)})continue;if(el.offsetParent===null)continue;if(el.closest&&el.closest('[aria-hidden="true"]'))continue;var r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)continue;var a=r.width*r.height;if(!best||a<best.a)best={a:a,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}return best?JSON.stringify({x:best.x,y:best.y}):null;})()`).catch(() => null);
      return r ? JSON.parse(r) : null;
    };
    const clickAt = async (to: any, from: any) => {
      const start = from ?? { x: to.x - 60, y: to.y - 40 };
      for (let i = 1; i <= 12; i++) { const t = i / 12; await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(start.x + (to.x - start.x) * t), y: Math.round(start.y + (to.y - start.y) * t) }); await sleep(12); }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      await sleep(45);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    };
    const watch = ['综合', '最多收藏', '不限', '一天内'];
    const expTarget = readArg('exp-target', '最多收藏');
    const expWait = Number(readArg('exp-wait', '0'));
    if (expWait > 0) { console.log(`\n[exp] 先等 ${expWait}ms 让 AI 总结/页面 settle …`); await sleep(expWait); }
    // 鼠标移开，读基线 active
    for (let i = 0; i < 6; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 400 }); await sleep(20); }
    await sleep(500);
    const fc = base.filterDetail?.self?.center ?? (await centerOf('筛选'));
    console.log(`\n[exp] 筛选触发器 center=${JSON.stringify(fc)}  基线active=${JSON.stringify(await readActive(watch))}`);
    // hover 展开
    const from0 = { x: fc.x - 80, y: fc.y - 50 };
    for (let i = 1; i <= 12; i++) { const t = i / 12; await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from0.x + (fc.x - from0.x) * t), y: Math.round(from0.y + (fc.y - from0.y) * t) }); await sleep(14); }
    await sleep(1000);
    console.log(`[exp] hover展开后 active=${JSON.stringify(await readActive(watch))}`);
    // 单点目标项，按时序轮询
    const sc = await centerOf(expTarget);
    console.log(`[exp] 点「${expTarget}」@${JSON.stringify(sc)}（from=筛选）`);
    await clickAt(sc, fc);
    for (const ms of [300, 500, 900, 1500, 2500]) { await sleep(ms - (ms === 300 ? 0 : 0)); const a = await readActive(watch); console.log(`    +累计? active=${JSON.stringify(a)}`); }
    await snap('4a-exp-after-sort-click', await dump(cdp), session);
    // 重开面板看持久态
    for (let i = 0; i < 4; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 400 }); await sleep(20); }
    await sleep(400);
    const fc2 = await centerOf('筛选') ?? await centerOf('已筛选');
    if (fc2) { const f2 = { x: fc2.x - 80, y: fc2.y - 50 }; for (let i = 1; i <= 12; i++) { const t = i / 12; await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(f2.x + (fc2.x - f2.x) * t), y: Math.round(f2.y + (fc2.y - f2.y) * t) }); await sleep(14); } await sleep(1000); }
    console.log(`[exp] 重开面板后 active=${JSON.stringify(await readActive(watch))}  （最多收藏 是否持久选中=修法关键）`);
    await snap('4b-exp-reopen', await dump(cdp), session);
  }

  if (hasFlag('production')) {
    console.log('\n[production] applySearchFilters({most_collected, one_day}) 端到端…');
    // 生产复刻：鼠标移到中性区，确保面板未预开（真实 /comment 流程无 pre-hover，走 pass2）
    for (let i = 0; i < 5; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 500 }); await sleep(20); }
    const before = await dump(cdp); await snap('2a-before', before, session);
    const res = await applySearchFilters({ sort: 'most_collected', timeWindow: 'one_day' }, { cdp, logger: (m) => console.log('    ' + m) });
    console.log(`  [production] pass1: sortApplied=${res.sortApplied} timeApplied=${res.timeApplied}`);
    if (hasFlag('twice')) {
      await sleep(1500);
      const res2 = await applySearchFilters({ sort: 'most_collected', timeWindow: 'one_day' }, { cdp, logger: (m) => console.log('    [pass2] ' + m) });
      console.log(`  [production] pass2: sortApplied=${res2.sortApplied} timeApplied=${res2.timeApplied}  ← 重试是否补上排序`);
    }
    await sleep(1200);
    const after = await dump(cdp); summarize('production-after', after); await snap('2b-after', after, session);
  }

  console.log('\n[layout-probe] done.');
  try { session.close(); } catch {}
  process.exit(0);
}
main().catch((e) => { console.error('[layout-probe] fail:', e); process.exit(1); });
