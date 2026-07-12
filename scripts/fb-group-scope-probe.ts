/**
 * fb-group-scope-probe.ts — FB 加群「候选作用域守卫」真机校准探针（task 0.1，纯只读）
 * ===========================================================================
 *
 * 目的：把 change `facebook-join-candidate-scope-guard` 的**发货判据**（SCOPE_HELPERS_JS
 *       里的目标群 id 解析 / 头部块正向包含 / heading 甄别 / 异群引用检测）原样注入真机 FB
 *       群页面，验证它在**真实 DOM** 上：
 *         - 能否把目标群 id 从 URL 解出（__TARGET_GID）；
 *         - 能否解析出目标群头部块（__HEADER_BLOCK，非 null）；
 *         - 目标群自身的「加入/已申请/已加入」控件是否 __inTargetScope=true；
 *         - 推荐位「发现更多小组」的异群 join 是否 __inTargetScope=false（落块外）。
 *       并 dump 0.1 需要坐实的结构事实：推荐卡片导航形态（a[href]/role=link/属性编码/纯 JS 闭包）、
 *       是否双列布局、群名是否 h1/aria-level=1、目标头部是否引用别群、是否嵌套 [role=main]。
 *
 * 零漂移：SCOPE_HELPERS_JS 从 src/facebook/join-executor.ts **原样抽取**注入（该块无 ${} 插值），
 *       故这里跑的就是发货的那套判据，不是复刻。
 *
 * 安全：**纯只读**。零点击、零输入、零提交。只 eval 诊断 JS + 截图。
 *
 * 运行（tsx 直跑，不需 build；本文件不在 tsconfig include 内）：
 *   # 浏览器已由 AdsPower 启动、CDP 端口已知；把要看的群页导航过去（探针自己也会导航 --url）
 *   AIDCP_CDP_PORT=<port> tsx scripts/fb-group-scope-probe.ts --url="https://www.facebook.com/groups/<id>"
 *   # 不导航、就地分析当前标签页：
 *   AIDCP_CDP_PORT=<port> tsx scripts/fb-group-scope-probe.ts
 *
 * 环境变量：AIDCP_CDP_HOST（默认 127.0.0.1）/ AIDCP_CDP_PORT（默认 9222）/
 *          AIDCP_PAGE_URL（attach 时按 url 子串匹配标签页，默认 'facebook'）
 * 参数：--url=<先导航到此群页> --wait-ms=<导航后等待，默认 6000> --tag=<产物标签>
 *
 * 产物：/tmp/aidcp-fb-scope-<ts>.json + /tmp/aidcp-fb-scope-<ts>.png
 */

import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { attachToPage } from '../src/cdp/index.js';
import { evalJson } from '../src/browse/cdp-util.js';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function log(event: string, data: unknown): void {
  console.log(`[scope-probe] ${event} ${JSON.stringify(data)}`);
}

/** 从 src/facebook/join-executor.ts 原样抽取 SCOPE_HELPERS_JS 的 String.raw 内容（无 ${} 插值，安全）。 */
function extractScopeHelpers(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, '../src/facebook/join-executor.ts'), 'utf8');
  const startMarker = 'const SCOPE_HELPERS_JS = String.raw`';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error('SCOPE_HELPERS_JS 起始标记未找到——源码结构变了，更新抽取逻辑');
  const contentStart = startIdx + startMarker.length;
  const endIdx = src.indexOf('`;', contentStart);
  if (endIdx < 0) throw new Error('SCOPE_HELPERS_JS 结束标记未找到');
  return src.slice(contentStart, endIdx);
}

/**
 * 诊断 IIFE：注入真实 SCOPE_HELPERS_JS，再暴露其内部解析结果 + 结构事实。
 * 复用 helpers 内的 __TARGET_GID / __HEADER_BLOCK / __SCOPE_RESOLVED / __inTargetScope /
 * __groupHeadings / __hasForeignGroupRef / __groupIdFromEl / __resolveHeaderBlock 等。
 */
function buildDiagnosticJs(scopeHelpers: string): string {
  return String.raw`(function(){
 try {
  // SCOPE_HELPERS_JS 依赖宿主 IIFE 定义的 visible()（真实 OBSERVE_JS/CLICK_JS 里都有，靠函数声明提升）。
  // 这里逐字复刻发货 OBSERVE_JS 的 visible 定义，保证 __groupHeadings 的可见性过滤与真机一致。
  function visible(el){
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    var s = window.getComputedStyle ? getComputedStyle(el) : null;
    return r.width > 0 && r.height > 0 && (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01));
  }
${scopeHelpers}
  // ---- 本诊断自带的小工具（不污染 helpers 命名空间）----
  function _vis(el){
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    var s = window.getComputedStyle ? getComputedStyle(el) : null;
    return r.width > 0 && r.height > 0 && (!s || (s.visibility !== 'hidden' && s.display !== 'none'));
  }
  function _txt(el){ return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g,' ').trim(); }
  function _short(v,n){ v=String(v||'').replace(/\s+/g,' ').trim(); return v.length>n? v.slice(0,n):v; }
  function _tag(el){ return el ? String(el.tagName||'').toLowerCase() : null; }
  function _role(el){ return el ? String((el.getAttribute&&el.getAttribute('role'))||'') : ''; }
  // 元素的简短路径描述（tag#id.class[role]），便于人读定位
  function _desc(el){
    if (!el) return null;
    var t = _tag(el);
    var id = el.id ? ('#'+el.id) : '';
    var role = _role(el) ? ('[role='+_role(el)+']') : '';
    var cls = '';
    try { cls = el.className && typeof el.className==='string' ? ('.'+el.className.trim().split(/\s+/).slice(0,2).join('.')) : ''; } catch(e){}
    return t+id+role+cls;
  }
  function _path(el){
    var out=[], n=el, hops=0;
    while(n && n!==document.body && hops<14){ out.push(_desc(n)); n=n.parentElement; hops++; }
    return out;
  }
  // 分类启发式（宽松，仅用于诊断分类，非精确复刻 ctaKind）——提到顶部：altBlock(section 2b) 早于 section 4 用到。
  var JOIN_HINT = /(加入|join|參加|参加|tham gia|beitreten|unirse|entrar|se joindre|เข้าร่วม|가입|参加する)/i;
  var MEMBER_HINT = /(已加入|已加入小组|joined|đã tham gia|beigetreten|miembro|会员|會員|멤버|退出小组)/i;
  var PENDING_HINT = /(已申请|待审|取消请求|取消申请|requested|cancel request|đã yêu cầu|solicitado)/i;

  // ---- 1) 发货判据在真机上的解析结果 ----
  var shipped = {
    targetGid: __TARGET_GID,
    headerBlockFound: !!__HEADER_BLOCK,
    scopeResolved: __SCOPE_RESOLVED,
    headerBlockDesc: __HEADER_BLOCK ? _desc(__HEADER_BLOCK) : null,
    headerBlockPath: __HEADER_BLOCK ? _path(__HEADER_BLOCK) : null,
    headerBlockTextSample: __HEADER_BLOCK ? _short(_txt(__HEADER_BLOCK), 200) : null,
    headerBlockHasForeignRef: __HEADER_BLOCK ? __hasForeignGroupRef(__HEADER_BLOCK, __TARGET_GID) : null
  };

  // ---- 2) 每个候选 heading 的甄别过程（复算 __resolveHeaderBlock 的内部逻辑并逐项暴露）----
  var hs = __groupHeadings();
  var headings = [];
  for (var hi=0; hi<hs.length; hi++){
    var h = hs[hi];
    var ceiling = (h.closest && h.closest('[role="main"]')) || document.body;
    var node = h, brokeBelowCeiling=false, stopDesc=null, stopIsCeiling=null, hops=0;
    while (node && node !== ceiling && hops<40){
      var parent = node.parentElement;
      if (!parent) break;
      if (__hasForeignGroupRef(parent, __TARGET_GID)){
        stopDesc = _desc(parent);
        stopIsCeiling = (parent === ceiling);
        if (parent !== ceiling) brokeBelowCeiling = true;
        break;
      }
      node = parent; hops++;
    }
    var selfForeign = (node === h) && __hasForeignGroupRef(node, __TARGET_GID);
    var accepted = !brokeBelowCeiling && !selfForeign;
    headings.push({
      text: _short(_txt(h), 80),
      tag: _tag(h),
      ariaLevel: (h.getAttribute && h.getAttribute('aria-level')) || null,
      isRoleHeading: _role(h)==='heading',
      inRoleMain: !!(h.closest && h.closest('[role="main"]')),
      ceilingDesc: _desc(ceiling),
      ceilingIsRoleMain: _role(ceiling)==='main',
      walkHops: hops,
      resolvedBlockDesc: _desc(node),
      stoppedAtDesc: stopDesc,
      stoppedAtCeiling: stopIsCeiling,
      brokeBelowCeiling: brokeBelowCeiling,
      selfForeign: selfForeign,
      accepted: accepted
    });
  }

  // ---- 2b) 候选修法验证：「最后一个干净祖先作块」（原始 D1；不因 broke-below-ceiling 拒 heading）----
  // 对每个 heading：walk 上溯，停在**首个含异群引用的祖先之下**（该祖先的上一跳），封顶 [role=main]。用该 clean 祖先作块。
  function _lastCleanAncestor(h){
    var ceiling = (h.closest && h.closest('[role="main"]')) || document.body;
    var node = h;
    while (node && node !== ceiling){
      var parent = node.parentElement;
      if (!parent) break;
      if (__hasForeignGroupRef(parent, __TARGET_GID)) break; // 停：不把含异群引用的祖先并入块
      node = parent;
    }
    return node;
  }
  var altBlocks = [];
  for (var ai2=0; ai2<hs.length; ai2++){
    var ab = _lastCleanAncestor(hs[ai2]);
    // 该 altBlock 内是否含：目标自身 member/join CTA？任何异群 rail join？
    var memberInBlock = false, joinInBlock = false, foreignJoinInBlock = 0;
    var acts = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(function(el){
      return _vis(el) && !(el.closest && el.closest('[role="banner"],[role="navigation"],[role="complementary"]'));
    });
    for (var qi=0; qi<acts.length; qi++){
      var ae = acts[qi];
      if (!(ab.contains && ab.contains(ae))) continue;
      var al = _short(_txt(ae)||(ae.getAttribute&&ae.getAttribute('aria-label'))||'', 40);
      if (MEMBER_HINT.test(al)) memberInBlock = true;
      if (JOIN_HINT.test(al) && !MEMBER_HINT.test(al)){
        // 该 join 是目标自身还是异群？看其 2 跳内后代是否含异群锚点
        var isForeign=false;
        for (var up2=ae, uh2=0; up2 && uh2<4; up2=up2.parentElement, uh2++){ if (__hasForeignGroupRef(up2, __TARGET_GID)){ isForeign=true; break; } }
        if (isForeign) foreignJoinInBlock++; else joinInBlock=true;
      }
    }
    altBlocks.push({ headingText:_short(_txt(hs[ai2]),40), blockDesc:_desc(ab), blockHasForeignRef:__hasForeignGroupRef(ab,__TARGET_GID), memberCtaInBlock:memberInBlock, ownJoinInBlock:joinInBlock, foreignJoinInBlock:foreignJoinInBlock });
  }

  // ---- 3) [role=main] 数量 / 嵌套 ----
  var mains = Array.from(document.querySelectorAll('[role="main"]'));
  var mainNested = false;
  for (var mi=0; mi<mains.length; mi++){
    for (var mj=0; mj<mains.length; mj++){
      if (mi!==mj && mains[mi].contains(mains[mj])) mainNested = true;
    }
  }

  // ---- 4) 所有 join/member/pending 动作节点：作用域分类 + 导航形态 ----
  // 用与发货同源的分类词表（从 helpers 外部注入不便，这里用宽松启发式抓「像加入的按钮」，
  // 目的是看 __inTargetScope 分类，不是精确复刻 ctaKind）——真值仍以 shipped observe 为准。
  function _navFormOf(el){
    // 该候选自身/祖先链上，异群/本群 group 引用是怎么编码的
    var forms = { anchorGroupHref:false, roleLink:false, attrEncoded:false, foreignGid:null, sameGid:false };
    for (var n=el, hop=0; n && hop<12; n=n.parentElement, hop++){
      var href = n.getAttribute && n.getAttribute('href');
      if (href && /\/groups\//i.test(href)) forms.anchorGroupHref = true;
      if (_role(n)==='link') forms.roleLink = true;
      // 扫属性值里的 /groups/<id>（非 href 的 data-* 等）
      if (n.attributes){
        for (var ai=0; ai<n.attributes.length; ai++){
          var av = n.attributes[ai] && n.attributes[ai].value;
          if (av && n.attributes[ai].name!=='href' && /\/groups\//i.test(String(av))) forms.attrEncoded = true;
        }
      }
      var gid = __groupIdFromEl(n);
      if (gid){ if (__TARGET_GID && gid===__TARGET_GID) forms.sameGid=true; else if (gid) forms.foreignGid = gid; }
    }
    return forms;
  }
  var actionNodes = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(function(el){
    return _vis(el) && !(el.closest && el.closest('[role="banner"],[role="navigation"],[role="complementary"]'));
  });
  var joinLike = [];
  for (var ni=0; ni<actionNodes.length; ni++){
    var el = actionNodes[ni];
    var label = _short(_txt(el) || (el.getAttribute&&el.getAttribute('aria-label'))||'', 60);
    var kindHint = MEMBER_HINT.test(label) ? 'member' : (PENDING_HINT.test(label) ? 'pending' : (JOIN_HINT.test(label) ? 'join' : ''));
    if (!kindHint) continue;
    if (joinLike.length >= 30) break;
    // D1 后代扫描能否边界住该候选：向上找首个「__hasForeignGroupRef=true」的祖先（其后代含异群 /groups/id）及跳数。
    // hops>=0 表示 D1 能在该祖先处停住头部块的上溯（把该候选挡在块外）；-1 表示 D1 全程扫不到异群引用（真·JS闭包 fail-open 风险）。
    var fdHops = -1, fdDesc = null;
    for (var up=el, uh=0; up && uh<14; up=up.parentElement, uh++){
      if (__hasForeignGroupRef(up, __TARGET_GID)){ fdHops=uh; fdDesc=_desc(up); break; }
    }
    joinLike.push({
      text: label,
      kindHint: kindHint,
      inTargetScope: __inTargetScope(el),
      candForeignRef: (typeof __candForeignRef==='function') ? __candForeignRef(el, __TARGET_GID) : null,
      inHeaderBlock: !!(__HEADER_BLOCK && __HEADER_BLOCK.contains && __HEADER_BLOCK.contains(el)),
      foreignDescBoundaryHops: fdHops,
      foreignDescBoundaryDesc: fdDesc,
      navForm: _navFormOf(el),
      path: _path(el).slice(0,8)
    });
  }

  // ---- 5) 推荐位「发现更多小组」rail 结构取证 ----
  // 找页面内含多个 /groups/<异 id> 链接的横向容器（近似 rail）
  var railSamples = [];
  var groupAnchors = Array.from(document.querySelectorAll('a[href*="/groups/"]')).filter(_vis);
  // 归组：按最近的「含≥3 个群链接」祖先聚类
  var seenContainers = [];
  for (var ga=0; ga<groupAnchors.length && railSamples.length<6; ga++){
    var a = groupAnchors[ga];
    // 上溯找「含多个群链接」的容器
    var container=null;
    for (var c=a.parentElement, ch=0; c && ch<10; c=c.parentElement, ch++){
      var cnt = c.querySelectorAll ? c.querySelectorAll('a[href*="/groups/"]').length : 0;
      if (cnt >= 3){ container=c; break; }
    }
    if (!container || seenContainers.indexOf(container)>=0) continue;
    seenContainers.push(container);
    var cardAnchors = Array.from(container.querySelectorAll('a[href*="/groups/"]')).filter(_vis).slice(0,6);
    railSamples.push({
      containerDesc: _desc(container),
      containerPath: _path(container).slice(0,6),
      groupLinkCount: container.querySelectorAll('a[href*="/groups/"]').length,
      cards: cardAnchors.map(function(ca){
        var gid = __groupIdFromEl(ca);
        return {
          href: _short(ca.getAttribute('href')||'', 60),
          gid: gid,
          isForeign: !!(gid && __TARGET_GID && gid!==__TARGET_GID),
          text: _short(_txt(ca), 40),
          hasRoleHeadingInside: !!ca.querySelector && (!!ca.querySelector('h1,[role="heading"][aria-level="1"]'))
        };
      })
    });
  }
  // 另找「非锚点」群卡片：role=link 或属性编码 /groups/ 但无 a[href] 的可见元素
  var nonAnchorGroupNav = [];
  var allEls = Array.from(document.querySelectorAll('[role="link"],[data-nav],[data-href]')).filter(_vis).slice(0,400);
  for (var ei=0; ei<allEls.length && nonAnchorGroupNav.length<8; ei++){
    var e = allEls[ei];
    if (e.closest && e.closest('a[href*="/groups/"]')) continue; // 已被锚点覆盖
    var gid2 = __groupIdFromEl(e);
    if (gid2){
      nonAnchorGroupNav.push({ desc:_desc(e), gid:gid2, isForeign: !!(gid2 && __TARGET_GID && gid2!==__TARGET_GID), text:_short(_txt(e),40), role:_role(e) });
    }
  }

  return JSON.stringify({
    location: { href: location.href, pathname: location.pathname },
    title: _short(document.title||'', 120),
    readyState: document.readyState,
    shipped: shipped,
    altBlocks: altBlocks,
    headings: headings,
    roleMainCount: mains.length,
    roleMainNested: mainNested,
    joinLikeCount: joinLike.length,
    joinLike: joinLike,
    railSampleCount: railSamples.length,
    railSamples: railSamples,
    nonAnchorGroupNavCount: nonAnchorGroupNav.length,
    nonAnchorGroupNav: nonAnchorGroupNav
  });
 } catch (e) {
   return JSON.stringify({ __probeError: String((e && e.message) || e), __probeStack: String((e && e.stack) || '') });
 }
})()`;
}

async function main(): Promise<void> {
  const ts = Date.now();
  const host = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
  const port = Number(process.env.AIDCP_CDP_PORT ?? 9222);
  const urlIncludes = process.env.AIDCP_PAGE_URL ?? 'facebook';
  const navUrl = readArg('url');
  const waitMs = Number(readArg('wait-ms') ?? 6000);
  const tag = readArg('tag') ?? 'g';

  if (hasFlag('help')) {
    console.log('见文件头用法；纯只读，零点击。');
    return;
  }

  log('start', { ts, host, port, urlIncludes, navUrl: navUrl ?? null, waitMs });
  const scopeHelpers = extractScopeHelpers();
  log('helpers_extracted', { bytes: scopeHelpers.length });

  const session = await attachToPage({ host, port, urlIncludes });
  if (navUrl) {
    log('navigate', { navUrl });
    await session.cdp.send('Page.navigate', { url: navUrl });
    await sleep(waitMs);
  }
  // 可选滚动：触发懒加载的「相关小组/你可能也喜欢」推荐位（真正攻击面常在首屏外）。纯只读滚动，不点击。
  const scrollRounds = Number(readArg('scroll') ?? 0);
  for (let i = 0; i < scrollRounds; i++) {
    await session.cdp.send('Runtime.evaluate', {
      expression: 'window.scrollTo(0, Math.min(document.body.scrollHeight, (window.scrollY||0) + 1400));',
    }).catch(() => undefined);
    await sleep(1600);
  }
  if (scrollRounds > 0) log('scrolled', { rounds: scrollRounds });
  const diag = await evalJson<Record<string, unknown>>(session.cdp, buildDiagnosticJs(scopeHelpers));
  log('diagnostic', diag);
  // 截图
  try {
    const shot = await session.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const p = `/tmp/aidcp-fb-scope-${ts}-${tag}.png`;
    writeFileSync(p, Buffer.from(shot.data, 'base64'));
    log('screenshot', { path: p });
  } catch (e) {
    log('screenshot_failed', { reason: (e as Error).message });
  }
  const outPath = `/tmp/aidcp-fb-scope-${ts}-${tag}.json`;
  writeFileSync(outPath, JSON.stringify({ ts, navUrl: navUrl ?? null, diag }, null, 2));
  log('done', { artifact: outPath });
  // 浏览器保持开着（供连跑多个群页）；进程用 exit 干净退出，不 close 会话。
  process.exit(0);
}

main().catch((e) => {
  console.error('[scope-probe] fatal', e);
  process.exit(1);
});
