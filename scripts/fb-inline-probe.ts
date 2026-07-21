#!/usr/bin/env tsx
/**
 * fb-inline-probe.ts — Facebook 首页 feed「就地读全文 / 就地点赞 / 卡身份稳定 / 虚拟化」真机探针。
 *
 * 服务于 change facebook-feed-inline-browse（C2）落地前的硬阻断探针 P1/P3/P4/P7
 * （设计档 §六；plan fb-fb-xhs-fb-xhs-fb-robust-narwhal.md）。
 *
 * 关键原则——**只跑生产代码，绝不另写一份**：
 *  - 卡身份 / 三段式解析：注入生产 `FB_TARGET_HELPERS_JS`（= `canonicalPostId` 本体 toString + fbTgt*）。
 *  - 点赞定位 / 点击 / 后置校验：直接实例化生产 `FacebookLikeExecutor`（shadow=只定位不点；real=真点）。
 *  - 已赞态判定：用生产导出的 `isReactedState` / `isNeutralLikeLabel` / `isCommentLabel`。
 *  探针只做「读 + 结构化上报」，把结论建立在生产逻辑上，杜绝「探针里另写一份判定、结论对不上线上」。
 *
 * 探针清单：
 *  - **P1**（read.surface='feed' gate）：逐卡 textContent.length vs innerText.length（捷径：前者远大 ⇒ 全文已在
 *    DOM、根本不必点展开）+ 锚定展开控件（message 容器内、role=button/tabindex、**非 <a href>**）存在性与文案。
 *  - **P3**（feed-like gate）：逐卡派生 postId（生产 `fbTgtArticlePostId`）→ `fbTgtResolve` 反查命中数=1
 *    （不撞卡、不歧义）；跨卡唯一；滚动后同卡 postId 恒等（稳定性）；permalink 形态刻画（pfbid/multi_permalinks/
 *    story_fbid/posts/permalink.php）。
 *  - **P4**（feed-like 真开硬前置，**唯一破坏性步骤**，默认关）：对锁定卡 shadow 定位（不点）→ 真点（el.click，
 *    生产执行器）→ 后置校验按钮是否**直接翻转成已赞**（vs 弹反应选择器）+ 抓已赞态确切串 + 断言别的卡未误点。
 *    **须显式 `AIDCP_FB_PROBE_LIKE=1` 才执行真点**；否则只做 P4-shadow（只定位、零外发动作）。
 *  - **P7**（feed 游标策略，只读）：连续滚动下 [role=article] 数与已见 postId 是否留在 DOM（虚拟化留壳 vs 回收）。
 *
 * 红线：默认全程只读 + P4-shadow（零外发）。真点（P4-real）只在显式旗标下、对**已授权的 dev/测试号**执行，
 * 每次真点前打印「将点哪张卡（postId/作者/正文头）」。找不到目标一律诚实上报，绝不假装成功。
 *
 * 用法：
 *   npx tsx scripts/fb-inline-probe.ts [user_id]        # 只读 + P4-shadow（默认 user_id=Dennis k1ej3o8f）
 *   AIDCP_FB_PROBE_LIKE=1 npx tsx scripts/fb-inline-probe.ts   # 追加 P4 真点（破坏性，已授权才用）
 *   AIDCP_FB_PROBE_STOP=1 …                             # 跑完停 AdsPower 浏览器（默认保持打开，便于续跑）
 *   AIDCP_FB_PROBE_SCROLL=<n>                           # P7 滚动轮数（默认 8）
 */
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { attachToPage } from '../src/cdp/index.js';
import { evalRaw } from '../src/browse/index.js';
import { FacebookLikeExecutor } from '../src/facebook/like-executor.js';
import { FB_TARGET_HELPERS_JS, canonicalPostId } from '../src/facebook/post-identity.js';
import {
  NEUTRAL_LIKE_LABEL_SOURCE,
  COMMENT_LABEL_SOURCE,
  REACTED_WORD_SOURCE,
  UNREACT_LABEL_SOURCE,
  isReactedState,
  isNeutralLikeLabel,
  isCommentLabel,
} from '../src/facebook/cta-labels.js';

const API_BASE = process.env.AIDCP_ADS_API_BASE ?? 'http://local.adspower.net:50325';
const USER_ID = process.argv[2] ?? process.env.AIDCP_ADS_USER_ID ?? 'k1ej3o8f'; // Dennis Scott（aidcp-env）
const FEED_URL = 'https://www.facebook.com/';
const DO_LIKE = process.env.AIDCP_FB_PROBE_LIKE === '1';
const DO_STOP = process.env.AIDCP_FB_PROBE_STOP === '1';
/** 把 P4 目标钉死到某条 permalink（按规范身份匹配）。设了就绝不点替代卡：钉的帖不在当前 feed ⇒ 跳过。 */
const PINNED_TARGET = process.env.AIDCP_FB_PROBE_TARGET ?? '';
const configuredScrollRounds = Number(process.env.AIDCP_FB_PROBE_SCROLL ?? '8');
const SCROLL_ROUNDS = Number.isFinite(configuredScrollRounds) && configuredScrollRounds >= 0
  ? Math.floor(configuredScrollRounds)
  : 8;

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

/** 若已在运行则复用其 debug_port，否则启动。 */
async function ensureBrowser(): Promise<{ host: string; port: number }> {
  const active = await adsApi<AdsStartData>('/api/v1/browser/active', { user_id: USER_ID }).catch(() => null);
  if (active && active.code === 0 && active.data?.debug_port) {
    const port = Number(active.data.debug_port);
    console.log(`[probe] AdsPower 已在运行 profile=${USER_ID} → 复用 debug_port=${port}`);
    return { host: '127.0.0.1', port };
  }
  const resp = await adsApi<AdsStartData>('/api/v1/browser/start', {
    user_id: USER_ID,
    open_tabs: '1',
    ip_tab: '0',
    headless: '0',
    launch_args: JSON.stringify(['--window-size=1440,980']),
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

// ── in-page 扫描（注入生产 helpers；只读；返回逐卡结构化事实）────────────────────────────
const SCAN_JS = String.raw`(function(){${FB_TARGET_HELPERS_JS}
  var NEUTRAL=new RegExp(${JSON.stringify(NEUTRAL_LIKE_LABEL_SOURCE)},'i');
  var REACTED=new RegExp(${JSON.stringify(REACTED_WORD_SOURCE)},'i');
  var UNREACT=new RegExp(${JSON.stringify(UNREACT_LABEL_SOURCE)},'i');
  var EXPAND=/^(?:查看更多|展开|显示更多|更多|See more|See More|View more|Show more|Ver más|Voir plus)$/i;
  function lab(el){ return String((el&&el.getAttribute&&el.getAttribute('aria-label'))||'').replace(/\s+/g,' ').trim(); }
  function txt(el){ return String((el&&el.innerText)||'').replace(/\s+/g,' ').trim(); }
  function tc(el){ return String((el&&el.textContent)||'').replace(/\s+/g,' ').trim(); }
  function ownHref(a){ try { return String(a.getAttribute('href')||''); } catch(e){ return ''; } }
  // 该卡内 react 候选按钮（aria-label 命中 中性/反应词/撤销 串；仅本卡子树、可见）——供 P4 定位/误点 diff。
  function reactCands(a){
    var out=[]; var btns=a.querySelectorAll('[role="button"][aria-label]');
    for(var i=0;i<btns.length;i++){ var el=btns[i];
      if(!fbTgtVisible(el)) continue;
      if(fbTgtClosestArticle(el)!==a) continue;               // 嵌套评论里的 react 不算
      var l=lab(el);
      if(NEUTRAL.test(l)||REACTED.test(l)||UNREACT.test(l)){ out.push({label:l, text:txt(el)}); }
    }
    return out; }
  // 锚定展开控件（message 容器内、非 <a>、role=button/tabindex/cursor-pointer、自身文案即「查看更多」类）。
  function expandCtl(a){
    var nodes=a.querySelectorAll('[role="button"],[tabindex],span,div');
    for(var i=0;i<nodes.length;i++){ var el=nodes[i];
      if(el.tagName==='A') continue;                          // <a href> 展开是导航、不是就地展开
      if(!fbTgtVisible(el)) continue;
      if(fbTgtClosestArticle(el)!==a) continue;
      var t=txt(el); if(t.length>12) continue;                // 只认叶子级短控件，避免命中包着「See more」的大容器
      if(!EXPAND.test(t)) continue;
      var role=el.getAttribute('role')||''; var hasTab=el.getAttribute('tabindex')!=null;
      var cur=''; try{ cur=getComputedStyle(el).cursor; }catch(e){}
      var clickable=(role==='button')||hasTab||cur==='pointer';
      if(!clickable) continue;
      // 是否在 message 容器内（FB 正文块常带这些标记）——只作观测标注，不作硬判据。
      var inMsg=!!(el.closest&&el.closest('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"]'));
      return {tag:el.tagName.toLowerCase(), role:role, isAnchor:false, text:t, clickable:true, inMessage:inMsg};
    }
    return null; }
  // 卡的作者名（卡头首个「非帖形态」链接文案，近似）。
  function author(a){
    var links=a.querySelectorAll('a[href]');
    for(var i=0;i<links.length;i++){ var el=links[i];
      if(fbTgtClosestArticle(el)!==a) continue;
      var h=ownHref(el); if(!h) continue;
      if(fbCanonicalPostId(h)) continue;                      // 帖 permalink 不是作者名
      var t=txt(el); if(t.length>=2 && t.length<=40) return t;
    }
    return ''; }
  // 卡的规范 permalink 完整 href（= DOM 序首个 own-level 可派生身份的锚，绝对化）。
  // 这才是云端下发给执行器的 noteId（FB=规范化 permalink）；执行器内部再 canonicalPostId() 成 fb:<id>。
  function canonHref(a){
    var links=a.querySelectorAll('a[href]');
    for(var i=0;i<links.length;i++){ var el=links[i];
      if(fbTgtClosestArticle(el)!==a) continue;
      var h=ownHref(el); if(!h) continue;
      if(fbCanonicalPostId(h)){ try{ return new URL(h, location.href).href; }catch(e){ return h; } }
    }
    return ''; }
  // 卡内 own-level 可派生身份的锚（刻画 permalink 形态）。
  function forms(a){
    var links=a.querySelectorAll('a[href]'); var seen={}; var out=[];
    for(var i=0;i<links.length && out.length<6;i++){ var el=links[i];
      if(fbTgtClosestArticle(el)!==a) continue;
      var h=ownHref(el); var id=fbCanonicalPostId(h); if(!id) continue;
      var kind = /pfbid/i.test(h)?'pfbid' : /multi_permalinks=/i.test(h)?'multi_permalinks'
        : /story_fbid=/i.test(h)?'story_fbid' : /\/permalink\.php/i.test(h)?'permalink.php'
        : /\/posts\//i.test(h)?'posts' : /\/videos\/|\/reel\/|\/watch/i.test(h)?'video' : 'other';
      if(seen[kind]) continue; seen[kind]=1;
      out.push({kind:kind, id:id, hrefHead:h.slice(0,80)});
    }
    return out; }

  var arts=fbTgtTopArticles(document);
  var cards=[];
  for(var i=0;i<arts.length;i++){ var a=arts[i];
    var pid=fbTgtArticlePostId(a);
    var resolve = pid ? fbTgtResolve(pid) : {status:'no_id', el:null};
    // 反查命中数（同一身份在作用域内命中几张顶层卡）——1 才安全。
    var hits=0; if(pid){ var root=fbTgtScopeRoot(); var ta=fbTgtTopArticles(root);
      for(var k=0;k<ta.length;k++){ if(fbTgtArticlePostId(ta[k])===pid) hits++; } }
    var box=a.getBoundingClientRect();
    cards.push({
      index:i, postId:pid, permalinkHref:canonHref(a), resolveStatus:resolve.status, resolveHits:hits,
      author:author(a), textHead:txt(a).slice(0,60), ariaLabel:lab(a), hasImg:!!a.querySelector('img[src]'),
      textContentLen:tc(a).length, innerTextLen:txt(a).length,
      expand:expandCtl(a), reactCands:reactCands(a), forms:forms(a),
      top:Math.round(box.top), bottom:Math.round(box.bottom)
    });
  }
  var bodyText=tc(document.body).slice(0,4000);
  return JSON.stringify({
    href:location.href, readyState:document.readyState,
    articleCount:arts.length,
    scrollHeight:Math.max(document.documentElement?document.documentElement.scrollHeight:0, document.body?document.body.scrollHeight:0),
    viewportH:window.innerHeight||0,
    signals:{
      login:/(登入|登錄|登录 Facebook|Log in to Facebook|Log Into Facebook|Iscriviti a Facebook)/i.test(bodyText),
      checkpoint:/checkpoint/i.test(location.href),
      consent:/(允许所有 Cookie|Allow all cookies|Accetta|Consenti tutti|同意)/i.test(bodyText)
    },
    cards:cards
  });
})()`;

interface ReactCand {
  label: string;
  text: string;
}
interface ExpandCtl {
  tag: string;
  role: string;
  isAnchor: boolean;
  text: string;
  clickable: boolean;
  inMessage: boolean;
}
interface FormInfo {
  kind: string;
  id: string;
  hrefHead: string;
}
interface Card {
  index: number;
  postId: string | null;
  permalinkHref: string;
  resolveStatus: string;
  resolveHits: number;
  author: string;
  textHead: string;
  ariaLabel: string;
  hasImg: boolean;
  textContentLen: number;
  innerTextLen: number;
  expand: ExpandCtl | null;
  reactCands: ReactCand[];
  forms: FormInfo[];
  top: number;
  bottom: number;
}
interface Scan {
  href: string;
  readyState: string;
  articleCount: number;
  scrollHeight: number;
  viewportH: number;
  signals: { login: boolean; checkpoint: boolean; consent: boolean };
  cards: Card[];
}

async function readScan(cdp: unknown): Promise<Scan> {
  const raw = await evalRaw<string>(cdp as never, SCAN_JS);
  return JSON.parse(raw) as Scan;
}

async function scrollDown(cdp: any, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: 800 });
    await sleep(500);
  }
  await sleep(1500);
}

/** 判定该卡是否「中性可点」的点赞目标：有 reactCand 命中中性 like 且非已赞。 */
function neutralLikeCand(card: Card): ReactCand | undefined {
  return card.reactCands.find((c) => isNeutralLikeLabel(c.label) && !isReactedState(c.label, c.text));
}

/** 单次扫描内的跨卡撞键数（同一 postId 命中 >1 张顶层卡）。 */
function intraScanCollisions(s: Scan): number {
  const byId = new Map<string, number>();
  for (const c of s.cards) if (c.postId) byId.set(c.postId, (byId.get(c.postId) ?? 0) + 1);
  let n = 0;
  for (const v of byId.values()) if (v > 1) n++;
  return n;
}

// ─────────────────────────────── P1 ───────────────────────────────
function reportP1(cards: Card[]): void {
  console.log('\n════════ P1 · 就地读全文（textContent vs innerText + 锚定展开控件）════════');
  console.log('  期望：textContent 远大于 innerText ⇒ 全文已在 DOM（捷径：读 textContent 无需点展开）；或存在非<a>锚定展开控件。');
  const posts = cards.filter((c) => c.postId);
  const nonPost = cards.length - posts.length;
  console.log(`  样本：可派生身份的帖 ${posts.length} 张（跨全部滚动轮去重）；另 ${nonPost} 张无身份卡（媒体架/推荐/回收壳）跳过。`);
  for (const c of posts) {
    const ratio = c.innerTextLen > 0 ? (c.textContentLen / c.innerTextLen).toFixed(2) : 'n/a';
    const shortcut = c.textContentLen > c.innerTextLen * 1.3 ? '✅捷径(全文已在DOM)' : '—';
    const exp = c.expand
      ? `展开控件<${c.expand.tag} role=${c.expand.role || '-'} 非<a>=${!c.expand.isAnchor} inMsg=${c.expand.inMessage}> "${c.expand.text}"`
      : '无展开控件';
    const flag = c.expand ? '  ⭐长帖候选' : '';
    console.log(
      `  [卡${c.index}] pid=${c.postId} tc=${c.textContentLen} it=${c.innerTextLen} ratio=${ratio} ${shortcut}${flag}\n` +
        `         ${exp}   img=${c.hasImg} 作者="${c.author}" 头="${c.textHead}"`,
    );
  }
  const withExpand = posts.filter((c) => c.expand).length;
  console.log(
    `  小结：有锚定展开控件的帖=${withExpand}${withExpand === 0 ? '（本次未采到长/截断帖——P1 展开控件形态待更长样本，登记 backlog）' : '（见 ⭐，形态：非<a>、role/tabindex 可点）'}`,
  );
}

// ─────────────────────────────── P3 ───────────────────────────────
function reportP3(cards: Card[], maxIntraScanCollisions: number): void {
  console.log('\n════════ P3 · 卡身份稳定 / 反查唯一 / 形态刻画 ════════');
  console.log('  期望：每帖 postId 反查命中数=1（不撞卡）、跨卡唯一、形态收敛。');
  const posts = cards.filter((c) => c.postId);
  let badHits = 0;
  for (const c of posts) {
    const hits = c.resolveHits;
    if (hits !== 1) badHits++;
    const formKinds = c.forms.map((f) => f.kind).join(',');
    console.log(
      `  [卡${c.index}] pid=${c.postId} resolve=${c.resolveStatus} 反查命中=${hits}${hits === 1 ? '✅' : '❌'} 形态=[${formKinds}] href=${c.permalinkHref.slice(0, 88)}`,
    );
  }
  const formTally: Record<string, number> = {};
  for (const c of posts) for (const f of c.forms) formTally[f.kind] = (formTally[f.kind] ?? 0) + 1;
  console.log(
    `  小结：唯一帖=${posts.length} 反查非1=${badHits} 单次扫描内跨卡撞键(max)=${maxIntraScanCollisions} 形态分布=${JSON.stringify(formTally)}`,
  );
  console.log('  注：跨入口/跨会话 postId 恒等（feed 打开 vs permalink 直达同一帖）单 feed 会话证不了 → 留真机 backlog。');
}

// ─────────────────────────────── P7 ───────────────────────────────
function reportP7(snapshots: { round: number; articleCount: number; ids: string[]; scrollHeight: number }[]): void {
  console.log('\n════════ P7 · 虚拟化（留壳 vs 回收）════════');
  console.log('  期望刻画：滚动加深时 [role=article] 数是否封顶（回收）、早期 postId 是否退出 DOM。');
  const firstIds = new Set(snapshots[0]?.ids ?? []);
  for (const s of snapshots) {
    const survived = s.ids.filter((id) => firstIds.has(id)).length;
    console.log(
      `  轮${s.round}: 卡数=${s.articleCount} scrollH=${s.scrollHeight} 首屏postId存活=${survived}/${firstIds.size}`,
    );
  }
  const last = snapshots[snapshots.length - 1];
  const survivedLast = last ? last.ids.filter((id) => firstIds.has(id)).length : 0;
  const verdict =
    firstIds.size > 0 && survivedLast === 0
      ? '→ 疑【回收】：首屏卡已全部退出 DOM（游标不能靠 DOM 序水位，须 postId 集合）'
      : firstIds.size > 0 && survivedLast === firstIds.size
        ? '→ 疑【留壳】：首屏卡仍在 DOM'
        : '→ 部分留存（混合）';
  console.log(`  ${verdict}`);
}

// ─────────────────────────────── P4 ───────────────────────────────
/** 抓目标卡的 react 候选按钮原始串（观测已赞态确切串用）。 */
const targetButtonsJs = (postId: string): string =>
  String.raw`(function(){${FB_TARGET_HELPERS_JS}
  var NEUTRAL=new RegExp(${JSON.stringify(NEUTRAL_LIKE_LABEL_SOURCE)},'i');
  var REACTED=new RegExp(${JSON.stringify(REACTED_WORD_SOURCE)},'i');
  var UNREACT=new RegExp(${JSON.stringify(UNREACT_LABEL_SOURCE)},'i');
  var COMMENT=new RegExp(${JSON.stringify(COMMENT_LABEL_SOURCE)},'i');
  var r=fbTgtResolve(${JSON.stringify(postId)});
  if(!r.el) return JSON.stringify({resolved:r.status, buttons:[], overlay:false});
  function lab(el){ return String((el&&el.getAttribute&&el.getAttribute('aria-label'))||'').replace(/\s+/g,' ').trim(); }
  function txt(el){ return String((el&&el.innerText)||'').replace(/\s+/g,' ').trim(); }
  var out=[]; var btns=r.el.querySelectorAll('[role="button"][aria-label]');
  for(var i=0;i<btns.length;i++){ var el=btns[i];
    if(fbTgtClosestArticle(el)!==r.el) continue;
    var l=lab(el);
    if(NEUTRAL.test(l)||REACTED.test(l)||UNREACT.test(l)||COMMENT.test(l)){ out.push({label:l,text:txt(el)}); }
  }
  // 反应选择器浮层（点后可能弹）：一个悬浮的、含多个反应项的容器。
  var overlay=false; var dls=document.querySelectorAll('[role="dialog"],[aria-label*="反应"],[aria-label*="Reaction"]');
  for(var j=0;j<dls.length;j++){ var d=dls[j]; if(!fbTgtVisible(d)) continue;
    if(d.querySelectorAll('[aria-label*="赞"],[aria-label*="Like"],[aria-label*="大爱"],[aria-label*="Love"]').length>=2){ overlay=true; break; } }
  return JSON.stringify({resolved:'ok', buttons:out, overlay:overlay});
})()`;

interface TargetButtons {
  resolved: string;
  buttons: ReactCand[];
  overlay: boolean;
}

/** 反应选择器浮层里点「赞」项提交（二段）。picker 常渲染在 portal（article 外），故全局可见项里找。 */
const pickerCommitJs = (): string =>
  String.raw`(function(){${FB_TARGET_HELPERS_JS}
  function lab(el){ return String((el&&el.getAttribute&&el.getAttribute('aria-label'))||'').replace(/\s+/g,' ').trim(); }
  var REACTION=/^(赞|讚|大爱|大讚|超讚|加油|哈哈|哇|嗚嗚|怒|Like|Love|Care|Haha|Wow|Sad|Angry|Me gusta|Me encanta)$/i;
  var LIKEITEM=/^(赞|讚|Like|Me gusta)$/i;
  var btns=document.querySelectorAll('[role="button"][aria-label]');
  var cands=[]; var clicked=false; var clickedLabel='';
  for(var i=0;i<btns.length;i++){ var el=btns[i]; if(!fbTgtVisible(el)) continue;
    var l=lab(el); if(!REACTION.test(l)) continue;
    cands.push(l);
    if(LIKEITEM.test(l) && !clicked){ try{ el.click(); clicked=true; clickedLabel=l; }catch(e){} }
  }
  return JSON.stringify({items:cands.slice(0,12), clicked:clicked, clickedLabel:clickedLabel});
})()`;

interface PickerCommit {
  items: string[];
  clicked: boolean;
  clickedLabel: string;
}

async function runP4(cdp: unknown, target: Card, doLike: boolean): Promise<void> {
  console.log('\n════════ P4 · feed 就地点赞（唯一破坏性步骤）════════');
  const pid = target.postId as string; // 规范身份 fb:<id>（供 targetButtonsJs / fbTgtResolve / 展示）
  const href = target.permalinkHref; // 云端下发口径的 noteId = 规范化 permalink（执行器内部再 canonicalPostId）
  console.log(`  锁定目标卡：卡${target.index} postId=${pid}`);
  console.log(`             noteId(href)=${href}`);
  console.log(`             作者="${target.author}" 头="${target.textHead}"`);

  const logs: string[] = [];
  const exec = new FacebookLikeExecutor({
    cdp: cdp as never,
    logger: (m) => {
      logs.push(m);
      console.log(`    [exec] ${m}`);
    },
  });

  // P4-shadow：只定位、绝不点。
  console.log('  ── P4-shadow：生产执行器 shadow 定位（不点击）…');
  const shadow = await exec.like({ noteId: href, shadow: true });
  console.log(`     shadow 结果：ok=${shadow.ok} reason=${shadow.reason ?? '-'} executed=${shadow.executed}`);
  if (shadow.reason === 'shadow') console.log('     ✅ 目标可就地定位（帖级 react 按钮存在、中性可点）。');
  else console.log(`     ⚠️ shadow 未命中中性目标（reason=${shadow.reason}）——见上，据实判断。`);

  if (!doLike) {
    console.log('\n  ⏸ P4 真点跳过：未设 AIDCP_FB_PROBE_LIKE=1（当前零外发动作）。');
    console.log('     如需真点，对已授权 dev/测试号：AIDCP_FB_PROBE_LIKE=1 npx tsx scripts/fb-inline-probe.ts ' + USER_ID);
    return;
  }

  // P4-real：真点（对已授权号）。
  console.log('\n  ── P4-real：真点（el.click，生产执行器）…');
  const before = JSON.parse(await evalRaw<string>(cdp as never, targetButtonsJs(pid))) as TargetButtons;
  console.log(`     点前目标卡按钮：${JSON.stringify(before.buttons)}`);
  const beforeAll = await readScan(cdp); // 全 feed 反应态快照（误点 diff 基线）

  const res = await exec.like({ noteId: href });
  await sleep(1200);
  const after = JSON.parse(await evalRaw<string>(cdp as never, targetButtonsJs(pid))) as TargetButtons;
  const afterAll = await readScan(cdp);

  console.log(`\n     执行器结果：ok=${res.ok} reason=${res.reason ?? '-'} executed=${res.executed}`);
  console.log(`     点后目标卡按钮：${JSON.stringify(after.buttons)}`);
  console.log(`     反应选择器浮层出现=${after.overlay}`);
  const directToggle = res.ok === true;
  console.log(
    `     ▶ el.click 是否【直接提交 Like】= ${directToggle ? '✅ 是（按钮状态直接翻转成已赞）' : after.overlay ? '❓ 否，弹了反应选择器（需二段确认）' : '❌ 未翻转（state_unchanged）'}`,
  );
  // 已赞态确切串（cta-labels §8.2 待补的 ground truth）。
  let reactedBtn = after.buttons.find((b) => isReactedState(b.label, b.text));
  if (reactedBtn) console.log(`     ▶ 已赞态确切串（一段即成）：aria-label="${reactedBtn.label}" text="${reactedBtn.text}"`);
  else console.log('     ▶ 一段未见已赞态串（若弹了 picker，走二段提交）。');

  // 二段：一段没直接翻转 + 弹了反应选择器 ⇒ 点 picker 里「赞」项提交（P4 完整刻画 + 采已赞态串）。
  if (!directToggle && after.overlay) {
    console.log('\n  ── P4 二段：反应选择器已弹，点其中「赞」项提交…');
    const pick = JSON.parse(await evalRaw<string>(cdp as never, pickerCommitJs())) as PickerCommit;
    console.log(`     picker 反应项：${JSON.stringify(pick.items)}`);
    console.log(`     点「赞」项：clicked=${pick.clicked} 命中="${pick.clickedLabel}"`);
    await sleep(1800);
    const after2 = JSON.parse(await evalRaw<string>(cdp as never, targetButtonsJs(pid))) as TargetButtons;
    console.log(`     二段点后目标卡按钮：${JSON.stringify(after2.buttons)}`);
    reactedBtn = after2.buttons.find((b) => isReactedState(b.label, b.text));
    if (reactedBtn) {
      console.log(`     ▶ ✅ 二段提交后【已赞态确切串】：aria-label="${reactedBtn.label}" text="${reactedBtn.text}"`);
      console.log('     ▶ 结论：feed 点赞是【两段】——click 留下心情→弹 picker→click「赞」项才提交。');
    } else {
      console.log('     ▶ 二段点后仍未见已赞态串——据实登记（picker 项定位或提交方式待复核）。');
    }
  }

  // 误点断言：除目标外，别的卡 react 态是否变化。
  let misclicked = 0;
  const beforeMap = new Map(beforeAll.cards.filter((c) => c.postId).map((c) => [c.postId as string, c.reactCands]));
  for (const c of afterAll.cards) {
    if (!c.postId || c.postId === pid) continue;
    const b = beforeMap.get(c.postId);
    if (!b) continue;
    const bReacted = b.some((x) => isReactedState(x.label, x.text));
    const aReacted = c.reactCands.some((x) => isReactedState(x.label, x.text));
    if (bReacted !== aReacted) {
      misclicked++;
      console.log(`     ❌ 误点疑似：卡 postId=${c.postId} 反应态从 ${bReacted} → ${aReacted}`);
    }
  }
  console.log(`     ▶ 别的卡误点数=${misclicked}${misclicked === 0 ? ' ✅（只动了目标卡）' : ' ❌'}`);
  void isCommentLabel; // 保留导入（口径一致性参考）
}

async function main(): Promise<void> {
  const { host, port } = await ensureBrowser();
  let closeSession: (() => void) | undefined;
  try {
    await waitCdpReady(host, port);
    const session = await attachToPage({ host, port, stealth: false });
    closeSession = () => session.close();
    const cdp = session.cdp;

    console.log(`\n[probe] 导航 → ${FEED_URL} 并等 hydrate…`);
    await cdp.send('Page.navigate', { url: FEED_URL });
    {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const rs = await evalRaw<string>(cdp, 'String(document.readyState)').catch(() => '');
        const href = await evalRaw<string>(cdp, 'String(location.href)').catch(() => '');
        const nArt = await evalRaw<number>(
          cdp,
          'document.querySelectorAll(\'[role="article"], article\').length',
        ).catch(() => 0);
        if ((href.includes('facebook.com') && rs === 'complete' && Number(nArt) >= 1) || Date.now() >= deadline) break;
        await sleep(600);
      }
    }
    console.log('[probe] 等 hydrate 稳定 12s（纪律：每次导航后等 ~12s）…');
    await sleep(12_000);

    // ── 表面守卫：不是可用 feed 就诚实中止 ──
    const scan = await readScan(cdp);
    console.log(`\n[probe] 落地：href=${scan.href} readyState=${scan.readyState} 顶层卡=${scan.articleCount}`);
    console.log(`[probe] 信号：login=${scan.signals.login} checkpoint=${scan.signals.checkpoint} consent=${scan.signals.consent}`);
    if (scan.signals.login || scan.signals.checkpoint) {
      console.log('\n❌ 落在登录/风控页——诚实中止（未做任何 feed 探测）。请人工在该 profile 完成登录/验证后重跑。');
      return;
    }
    if (scan.articleCount === 0) {
      console.log('\n❌ feed 上 0 张卡（可能同意浮层遮挡或未水合）——诚实中止，不臆造结论。');
      return;
    }

    // 跨全部滚动轮累积去重的帖集合（P1/P3 用 union，捕捉长帖 / 更多 permalink 形态）。
    const union = new Map<string, Card>();
    const absorb = (s: Scan): void => {
      for (const c of s.cards) if (c.postId && !union.has(c.postId)) union.set(c.postId, c);
    };
    absorb(scan);
    let maxColl = intraScanCollisions(scan);

    // P7：连续滚动采样（同时喂 union）。
    const snapshots: { round: number; articleCount: number; ids: string[]; scrollHeight: number }[] = [];
    snapshots.push({
      round: 0,
      articleCount: scan.articleCount,
      ids: scan.cards.map((c) => c.postId).filter((x): x is string => !!x),
      scrollHeight: scan.scrollHeight,
    });
    for (let r = 1; r <= SCROLL_ROUNDS; r++) {
      await scrollDown(cdp, 2);
      const s = await readScan(cdp);
      absorb(s);
      maxColl = Math.max(maxColl, intraScanCollisions(s));
      snapshots.push({
        round: r,
        articleCount: s.articleCount,
        ids: s.cards.map((c) => c.postId).filter((x): x is string => !!x),
        scrollHeight: s.scrollHeight,
      });
    }

    const unionCards = Array.from(union.values());
    reportP1(unionCards);
    reportP3(unionCards, maxColl);
    reportP7(snapshots);

    // P4：回顶 + 新鲜扫描后挑目标（对抗 P7 已证的回收/刷新——绝不用陈旧的首屏卡）。
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' }).catch(() => undefined);
    await sleep(3000);
    const fresh = await readScan(cdp);
    let target: Card | undefined;
    if (PINNED_TARGET) {
      const pinnedId = canonicalPostId(PINNED_TARGET);
      console.log(`\n[probe] P4 目标已钉死：${PINNED_TARGET}（身份=${pinnedId ?? 'null'}）——不点替代卡。`);
      target = fresh.cards.find((c) => c.postId && c.postId === pinnedId && c.permalinkHref && neutralLikeCand(c));
      if (!target) {
        console.log(
          '\n════════ P4 ════════\n  ⚠️ 钉死的目标帖不在当前 feed（或已赞 / 无中性 react）——诚实跳过，绝不改点别的卡。',
        );
      }
    } else {
      target = fresh.cards.find((c) => c.postId && c.permalinkHref && neutralLikeCand(c));
      if (!target) {
        console.log(
          '\n════════ P4 ════════\n  ⚠️ 回顶新鲜扫描未找到「中性可点 + 有 permalink」的目标卡（都已赞 / 无帖级 react / 无身份）——P4 跳过。',
        );
      }
    }
    if (target) await runP4(cdp, target, DO_LIKE);

    console.log('\n[probe] 完成。');
  } finally {
    if (closeSession) {
      try {
        closeSession();
      } catch {
        /* best-effort */
      }
    }
    if (DO_STOP) await stopBrowser();
    else console.log('[probe] 浏览器保持打开（AIDCP_FB_PROBE_STOP=1 可跑完关闭）。');
  }
}

process.on('SIGINT', () => {
  if (DO_STOP) void stopBrowser().finally(() => process.exit(130));
  else process.exit(130);
});

main().catch((e) => {
  console.error(`[probe] 致命错误：${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});
