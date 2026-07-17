/**
 * fb-comment-verify-probe.ts — FB 评论「发布成功判定」执行端探针（先决调研，非生产代码）
 * ===========================================================================
 *
 * 背景：现在判定 FB 评论发布成功走的是「回车提交 → 整页刷新 → 死等 5s → 只查一次
 *       本人身份+文本三重命中」（src/facebook/comment-executor.ts:415-475）。慢页面下评论
 *       其实已在服务器上却没在 5s 内重渲染 → 误报 verification_ambiguous（P2②）。
 *
 * 拟议改法：不刷新，就地盯「刚发那条评论」的状态流转——中文界面「发布中」→ 出现
 *       「发布时间 + 点赞 + 回复」；或直接看那条评论有没有拿到服务器发的评论永久链接
 *       （comment_id）。但这是否安全，取决于一个真机事实：这些信号是**服务器确认前**
 *       （乐观渲染，用它判定会假成功）还是**确认后**才出现（可信、且比现状更硬）。
 *
 * 本探针就为定这个总开关：把「按回车」那一刻起，那条评论行上各信号的**首次出现时刻**
 *       （相对回车 t0 的 ms）逐帧记录下来，并用 CDP Network 抓「评论写入」GraphQL 请求的
 *       **响应到达时刻**做对齐；最后刷新一次拿服务器真相（是否真持久化）。据此判断：
 *         - comment_id 锚点在服务器响应「之后」出现 且 刷新后确证持久 → 可信，可做快确认；
 *         - 在响应「之前/无响应」就出现 → 乐观渲染，不能单独当成功。
 *
 * 安全分级（默认只读，绝不静默发评论）：
 *   - 默认（无 flag）：**纯只读**。dump 评论区结构 + 采样已存在的评论行（学「已确认态」
 *                      的 comment_id 锚点/时间戳/点赞回复长什么样），零输入零提交。
 *   - --type-test    ：聚焦评论框、拟人输入一段无害探针文本、读回确认后立即清空（不提交）。
 *   - AIDCP_FB_COMMENT_PROBE_SUBMIT=true 且 --yes-post-real-comment ：**真发一条**探针评论，
 *                      抓「回车→就地信号→刷新确证」完整时间线。会真的在该帖下留言——
 *                      **只在 tom 测试分组的测试帖上跑**，跑完请手动删掉这条探针评论。
 *
 * 运行（用 tsx 直接跑，不需要 build；本文件不在 tsconfig include 内）：
 *   # 1) 用已登录 FB 的指纹浏览器开着 CDP 端口，手动导航到测试分组里的一个测试帖详情
 *   # 2) 只读：学「已确认评论」的 DOM 形态
 *   cd ../aidcp-edge && AIDCP_CDP_PORT=<port> tsx scripts/fb-comment-verify-probe.ts
 *   # 3) 验证输入链路（输入后自动清空、不提交）
 *   AIDCP_CDP_PORT=<port> tsx scripts/fb-comment-verify-probe.ts --type-test
 *   # 4) 真发一条，抓完整时间线（确认 2/3 都 OK 后，只在测试帖上）
 *   AIDCP_FB_COMMENT_PROBE_SUBMIT=true AIDCP_CDP_PORT=<port> \
 *     tsx scripts/fb-comment-verify-probe.ts --yes-post-real-comment \
 *       --text="很实用的分享，感谢" --own-id=<你的数字id可选>
 *
 * 环境变量：
 *   AIDCP_CDP_HOST（默认 127.0.0.1）/ AIDCP_CDP_PORT（默认 9222）/
 *   AIDCP_PAGE_URL（attach 时按 url 子串匹配标签页，默认 'facebook'）
 *   AIDCP_FB_COMMENT_PROBE_SUBMIT（=true 才允许真发）
 * 参数：--text=<正文> --own-id=<本人数字id，可选，验证身份收窄> --url=<先导航到此帖，可选>
 *      --window-ms=<就地轮询窗口，默认 15000> --poll-ms=<轮询间隔，默认 200>
 *
 * 产物：/tmp/aidcp-fb-comment-verify-<ts>.json（完整时间线+网络对齐+刷新确证）
 *      + /tmp/aidcp-fb-comment-verify-<ts>-<tag>.png 若干截图。把 json 发回来即可定方案。
 *
 * 关联：中控仓「FB 评论发布判定」评估对话（reload+triple-match vs 就地状态流转，P2②）。
 */

import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { attachToPage } from '../src/cdp/index.js';
import {
  evalJson,
  evalRaw,
  dispatchKeystrokes,
  dispatchKey,
} from '../src/browse/cdp-util.js';

// ---------------------------------------------------------------------------
// 参数 / flag / 环境 / 日志
// ---------------------------------------------------------------------------

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function log(step: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ step, ...payload }));
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 页面内 JS 辅助（语言无关优先；locale 文案只用于兜底找编辑器）
// ---------------------------------------------------------------------------

const HELPERS_JS = String.raw`
function fbVisible(el){
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  var s = window.getComputedStyle ? getComputedStyle(el) : null;
  return r.width > 0 && r.height > 0 && (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01));
}
function fbText(el){ return String((el && el.innerText) || (el && el.textContent) || '').replace(/\s+/g, ' ').trim(); }
function fbLabel(el){ return String((el && (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder')))) || '').replace(/\s+/g, ' ').trim(); }
function fbIsCommentEditor(el){
  var label = fbLabel(el);
  return /写评论|发表评论|发表公开评论|Write a comment|Comment as|Comment|Bình luận|Comentar|Escribe un comentario|输入回答|Answer/i.test(label);
}
function fbFindEditor(){
  var eds = Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).filter(fbVisible);
  // 优先带评论 label 的；否则退化取第一个可见可编辑框（探针容忍，日志记明用了哪种）
  var labeled = eds.filter(fbIsCommentEditor);
  return { editor: labeled[0] || eds[0] || null, labeled: labeled.length > 0, editorCount: eds.length };
}
// 语言无关：评论永久链接锚点（comment_id / reply_comment_id / /comment/ 路径）
function fbCommentIdHref(node){
  var links = node.querySelectorAll('a[href]');
  for (var i=0;i<links.length;i++){
    var h = links[i].getAttribute('href') || '';
    if (/comment_id=|reply_comment_id=|[?&]cid=|\/comment\//i.test(h)) return { href: h, text: fbText(links[i]).slice(0,40) };
  }
  return null;
}
// 作者链接（数字 id 收窄用）
function fbAuthorHrefs(node){
  var links = node.querySelectorAll('a[href*="/profile.php?id="], a[href*="/user/"], a[href*="/people/"], a[href*="/groups/"]');
  var out = [];
  for (var i=0;i<links.length && out.length<4;i++){ var h=links[i].getAttribute('href')||''; if(h) out.push(h); }
  return out;
}
// 在目标帖内找「含指定文本片段」的最小评论节点（最小=评论条目而非整帖 article）
function fbFindFragNode(frag){
  var arts = Array.prototype.slice.call(document.querySelectorAll('[role="article"], article'));
  var best = null, bestLen = Infinity;
  for (var i=0;i<arts.length;i++){ var t = fbText(arts[i]); if (t.indexOf(frag) >= 0 && t.length < bestLen){ best = arts[i]; bestLen = t.length; } }
  if (best) return best;
  // 兜底：任意含 frag 且内部有 <a> 的最小元素
  var all = document.querySelectorAll('*');
  for (var j=0;j<all.length;j++){ var el=all[j]; if(!el.querySelector) continue; var tt=fbText(el);
    if (tt.indexOf(frag)>=0 && tt.length<bestLen && el.querySelector('a[href]')){ best=el; bestLen=tt.length; } }
  return best;
}
`;

function jsString(v: string): string {
  return JSON.stringify(v);
}

/** 只读：采样已存在评论行的「已确认态」形态（comment_id 锚点/时间戳/点赞回复/作者链接）。零风险。 */
function buildExistingSampleJs(): string {
  return `(function(){${HELPERS_JS}
    var arts = Array.prototype.slice.call(document.querySelectorAll('[role="article"], article'));
    // 评论 = 嵌套在别的 article 里的 article（排除顶层帖）
    var comments = arts.filter(function(a){ return a.parentElement && a.parentElement.closest && a.parentElement.closest('[role="article"], article'); });
    var sample = comments.slice(0, 5).map(function(node){
      var cid = fbCommentIdHref(node);
      var btns = node.querySelectorAll('[role="button"]');
      var btnLabels = []; for (var i=0;i<btns.length && btnLabels.length<8;i++){ var l=(fbLabel(btns[i])||fbText(btns[i])).slice(0,24); if(l) btnLabels.push(l); }
      var abbr = node.querySelector('abbr, time, [data-tooltip-content]');
    // 真机（2026-07-17）：FB 把评论时间渲染成**普通 <a>**（href=帖 permalink、文本「1 分钟」），
    // 不是 abbr/time → 上一版选择器恒 null（结论里被误读成「平台没有时间戳」）。故回落到短文本 <a>。
    if(!abbr){ var _ls=node.querySelectorAll('a[href*="story_fbid="], a[href*="/posts/"], a[href*="comment_id="]');
      for(var _q=0;_q<_ls.length;_q++){ var _lt=fbText(_ls[_q]); if(_lt && _lt.length<=12 && !/^https?:/.test(_lt)){ abbr=_ls[_q]; break; } } }
      return {
        textHead: fbText(node).slice(0, 60),
        commentIdHref: cid ? cid.href : null,
        commentIdText: cid ? cid.text : null,
        timeElText: abbr ? fbText(abbr).slice(0,40) : null,
        roleButtonCount: btns.length,
        roleButtonLabels: btnLabels,
        authorHrefs: fbAuthorHrefs(node),
        opacity: (window.getComputedStyle ? getComputedStyle(node).opacity : null)
      };
    });
    var ed = fbFindEditor();
    return JSON.stringify({
      url: location.href,
      commentArticleCount: comments.length,
      editorFound: !!ed.editor, editorLabeled: ed.labeled, editorCount: ed.editorCount,
      sample: sample
    });
  })()`;
}

/** 轻量：评论框/评论是否已渲染（用于导航后等待真实渲染，避开弹层骨架期）。 */
function buildEditorPresentJs(): string {
  return `(function(){${HELPERS_JS}
    var ed = fbFindEditor();
    var arts = document.querySelectorAll('[role="article"], article');
    var comments = 0;
    for (var i=0;i<arts.length;i++){ if (arts[i].parentElement && arts[i].parentElement.closest && arts[i].parentElement.closest('[role="article"], article')) comments++; }
    return JSON.stringify({ editorFound: !!ed.editor, editorCount: ed.editorCount, commentArticleCount: comments });
  })()`;
}

/** 点击「写评论…」占位（部分 FB 面板评论框需点开才出现 contenteditable）。返回是否点到。 */
function buildClickComposerPlaceholderJs(): string {
  return `(function(){${HELPERS_JS}
    // 已有真编辑器则无需点
    if (fbFindEditor().editor) return JSON.stringify({clicked:false, reason:'already_editor'});
    var cands = Array.prototype.slice.call(document.querySelectorAll('[aria-label], [role="button"], div'));
    for (var i=0;i<cands.length;i++){ var el=cands[i]; if(!fbVisible(el)) continue;
      var lab = (fbLabel(el)||fbText(el));
      if (/写评论|发表评论|发表公开评论|Write a comment|Comment|Bình luận|Comentar|Escribe un comentario/i.test(lab) && fbText(el).length < 30){
        try{ el.scrollIntoView({block:'center'}); el.click(); }catch(e){}
        return JSON.stringify({clicked:true, label:lab.slice(0,30)});
      }
    }
    return JSON.stringify({clicked:false, reason:'no_placeholder'});
  })()`;
}

/** 聚焦评论框（scrollIntoView + focus）。 */
function buildFocusJs(): string {
  return `(function(){${HELPERS_JS}
    var ed = fbFindEditor(); var el = ed.editor;
    if(!el) return JSON.stringify({found:false, focused:false, labeled:false});
    try{ el.scrollIntoView({block:'center'}); }catch(e){}
    try{ el.focus(); }catch(e){}
    return JSON.stringify({found:true, focused:document.activeElement===el, labeled:ed.labeled});
  })()`;
}

/** 读回编辑器内容（确认拟人输入落到了编辑器上）。 */
function buildEditorTextJs(): string {
  return `(function(){${HELPERS_JS}
    var ed = fbFindEditor(); var el = ed.editor;
    if(!el) return JSON.stringify({found:false, text:''});
    return JSON.stringify({found:true, text: fbText(el).slice(0,200)});
  })()`;
}

/** 清空编辑器（全选 + 派发；不提交）。 */
function buildClearEditorJs(): string {
  return `(function(){${HELPERS_JS}
    var ed = fbFindEditor(); var el = ed.editor; if(!el) return 'no-editor';
    try{ el.focus(); var range=document.createRange(); range.selectNodeContents(el); var sel=getSelection(); sel.removeAllRanges(); sel.addRange(range); return 'selected'; }catch(e){ return 'err:'+e.message; }
  })()`;
}

/** 就地捕获「刚发那条」的信号快照（每帧一次，语言无关信号 + locale 参考信号并存）。 */
function buildNodeSignalJs(frag: string, ownId: string): string {
  return `(function(){${HELPERS_JS}
    var frag=${jsString(frag)}; var ownId=${jsString(ownId)};
    var node = fbFindFragNode(frag);
    if(!node) return JSON.stringify({nodeFound:false});
    var cid = fbCommentIdHref(node);
    var btns = node.querySelectorAll('[role="button"]');
    var btnLabels = []; for (var i=0;i<btns.length && btnLabels.length<8;i++){ var l=(fbLabel(btns[i])||fbText(btns[i])).slice(0,24); if(l) btnLabels.push(l); }
    var abbr = node.querySelector('abbr, time, [data-tooltip-content]');
    var authorHrefs = fbAuthorHrefs(node);
    var hasOwn = false; if(ownId){ for(var j=0;j<authorHrefs.length;j++){ if(authorHrefs[j].indexOf(ownId)>=0){ hasOwn=true; break; } } }
    var busy = node.getAttribute('aria-busy')==='true' || !!node.querySelector('[aria-busy="true"], [role="progressbar"]');
    var opacity = null; try{ opacity = Number(getComputedStyle(node).opacity); }catch(e){}
    return JSON.stringify({
      nodeFound:true,
      hasCommentId: !!cid,
      commentIdHref: cid ? cid.href : null,
      commentIdText: cid ? cid.text : null,
      hasTimeEl: !!abbr,
      timeElText: abbr ? fbText(abbr).slice(0,40) : null,
      roleButtonCount: btns.length,
      roleButtonLabels: btnLabels,
      authorHrefs: authorHrefs,
      hasOwnId: hasOwn,
      ariaBusy: busy,
      opacity: opacity,
      nodeTextLen: fbText(node).length,
      // 🔴 每帧存该行**原文**：只存长度的话,「发布中」这类纯文字状态结构上就测不到
      // （上一轮正是因此漏掉它,方案里提出后在结论中蒸发,时隔 5 天靠肉眼重新发现）。
      nodeText: fbText(node).slice(0, 220)
    });
  })()`;
}

// ---------------------------------------------------------------------------
// 网络对齐：抓评论写入 GraphQL 请求的响应到达时刻
// ---------------------------------------------------------------------------

interface GraphqlHit {
  requestId: string;
  tSentMs: number | null; // 相对 t0
  tRespMs: number | null; // 相对 t0
  inlinePostData?: string;
  friendlyName?: string | null;
  isCommentCandidate?: boolean;
}

function friendlyNameOf(postData: string | undefined): string | null {
  if (!postData) return null;
  const m = /fb_api_req_friendly_name=([^&]+)/.exec(postData);
  return m ? decodeURIComponent(m[1]) : null;
}
function looksLikeCommentMutation(name: string | null): boolean {
  if (!name) return false;
  return /comment/i.test(name) && /(create|add|mutation|ufi)/i.test(name);
}

// ---------------------------------------------------------------------------
// 类型（松散即可，仅本脚本用）
// ---------------------------------------------------------------------------

interface NodeSignal {
  nodeFound: boolean;
  hasCommentId?: boolean;
  commentIdHref?: string | null;
  commentIdText?: string | null;
  hasTimeEl?: boolean;
  timeElText?: string | null;
  roleButtonCount?: number;
  roleButtonLabels?: string[];
  authorHrefs?: string[];
  hasOwnId?: boolean;
  ariaBusy?: boolean;
  opacity?: number | null;
  nodeTextLen?: number;
}
interface PollFrame extends NodeSignal {
  tMs: number;
}

type Session = Awaited<ReturnType<typeof attachToPage>>;

async function screenshot(session: Session, ts: number, tag: string): Promise<void> {
  try {
    const shot = await session.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const p = `/tmp/aidcp-fb-comment-verify-${ts}-${tag}.png`;
    writeFileSync(p, Buffer.from(shot.data, 'base64'));
    log('artifact_png', { path: p, tag });
  } catch (err) {
    log('artifact_png_failed', { tag, reason: (err as Error).message });
  }
}

// 导航后等评论框/评论真实渲染（避开弹层骨架期）；必要时点开「写评论…」占位
async function waitForEditor(session: Session, maxMs: number): Promise<{ editorFound: boolean; commentArticleCount: number; waitedMs: number; clickedPlaceholder: boolean }> {
  const start = Date.now();
  let last = { editorFound: false, commentArticleCount: 0 };
  let clicked = false;
  while (Date.now() - start < maxMs) {
    try {
      const s = await evalJson<{ editorFound: boolean; editorCount: number; commentArticleCount: number }>(session.cdp, buildEditorPresentJs());
      last = { editorFound: s.editorFound, commentArticleCount: s.commentArticleCount };
      if (s.editorFound) break;
      // 渲染出结构但没现成 contenteditable → 试点开占位（每轮最多一次）
      if (!clicked && (s.commentArticleCount > 0 || Date.now() - start > 6000)) {
        const c = await evalJson<{ clicked: boolean }>(session.cdp, buildClickComposerPlaceholderJs());
        if (c.clicked) { clicked = true; log('composer_placeholder_clicked', c as unknown as Record<string, unknown>); }
      }
    } catch {
      // ignore transient eval errors during modal render
    }
    await sleep(600);
  }
  return { ...last, waitedMs: Date.now() - start, clickedPlaceholder: clicked };
}

// firstMs：某信号在时间线里首次为真的相对 ms（无则 null）
function firstMs(frames: PollFrame[], pred: (f: PollFrame) => boolean): number | null {
  for (const f of frames) if (pred(f)) return f.tMs;
  return null;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (hasFlag('help')) {
    console.log('见 scripts/fb-comment-verify-probe.ts 头部用法；默认只读。');
    return;
  }

  const ts = Date.now();
  const host = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
  const port = Number(process.env.AIDCP_CDP_PORT ?? 9222);
  const urlIncludes = process.env.AIDCP_PAGE_URL ?? 'facebook';
  const navUrl = readArg('url');
  const ownId = readArg('own-id') ?? '';
  const windowMs = Number(readArg('window-ms') ?? 15000);
  const pollMs = Number(readArg('poll-ms') ?? 200);

  const doTypeTest = hasFlag('type-test');
  const wantSubmit = process.env.AIDCP_FB_COMMENT_PROBE_SUBMIT === 'true' && hasFlag('yes-post-real-comment');
  const baseText = readArg('text') ?? 'AIDCP probe, please ignore';
  const token = `p${ts.toString(36)}`;
  const marker = `${baseText} [${token}]`; // 唯一化，便于定位 + 跑完删除
  const frag = marker.slice(0, 60);

  log('probe_start', { ts, host, port, urlIncludes, navUrl: navUrl ?? null, ownId: ownId || null, doTypeTest, wantSubmit, windowMs, pollMs });

  const session = await attachToPage({ host, port, urlIncludes });
  await session.cdp.send('Input.enable').catch(() => undefined);

  try {
    if (navUrl) {
      log('navigate', { navUrl });
      await session.cdp.send('Page.navigate', { url: navUrl });
      await sleep(3000);
    }
    // 等评论框/评论真实渲染（弹层式帖子详情有骨架加载期，固定等待会误判 editor_not_found）
    const ready = await waitForEditor(session, 20000);
    log('editor_ready', ready);

    // ---- Stage 0（默认，只读）：学「已确认评论」的 DOM 形态 ----
    const sample = await evalJson<{
      url: string; commentArticleCount: number; editorFound: boolean; editorLabeled: boolean; editorCount: number;
      sample: Array<Record<string, unknown>>;
    }>(session.cdp, buildExistingSampleJs());
    log('readonly_sample', sample);
    await screenshot(session, ts, '0-readonly');

    if (!doTypeTest && !wantSubmit) {
      writeFileSync(`/tmp/aidcp-fb-comment-verify-${ts}.json`, JSON.stringify({ mode: 'readonly', ts, sample }, null, 2));
      log('done_readonly', {
        note: '只读完成：sample[].commentIdHref 就是「已确认评论」的服务器永久链接形态。加 --type-test 验输入，或授权真发抓时间线。',
        artifact: `/tmp/aidcp-fb-comment-verify-${ts}.json`,
      });
      return;
    }

    // ---- 聚焦 + 拟人输入（type-test 与真发共用）----
    let focus = await evalJson<{ found: boolean; focused: boolean; labeled: boolean }>(session.cdp, buildFocusJs());
    if (!focus.found) {
      // 兜底：点开「写评论…」占位再聚焦一次（部分面板评论框需先点开）
      await evalRaw(session.cdp, buildClickComposerPlaceholderJs()).catch(() => undefined);
      await sleep(900);
      focus = await evalJson<{ found: boolean; focused: boolean; labeled: boolean }>(session.cdp, buildFocusJs());
    }
    log('focus', focus);
    if (!focus.found) {
      log('abort', { reason: 'editor_not_found', hint: '把 readonly_sample 发回来，可能需要放宽编辑器选择器' });
      return;
    }
    await dispatchKeystrokes(session.cdp, marker);
    await sleep(400);
    const readback = await evalJson<{ found: boolean; text: string }>(session.cdp, buildEditorTextJs());
    const landed = (readback.text ?? '').includes(token);
    log('type_readback', { landed, editorText: readback.text });

    if (!wantSubmit) {
      await evalRaw(session.cdp, buildClearEditorJs());
      await dispatchKey(session.cdp, 'Backspace', 'Backspace', 8);
      log('done_type_test', {
        landed,
        note: landed
          ? '输入链路通、已清空未提交。真发抓时间线：AIDCP_FB_COMMENT_PROBE_SUBMIT=true ... --yes-post-real-comment'
          : '输入没落到编辑器——把 focus/readonly 发回来，需换聚焦策略。',
      });
      return;
    }

    // ---- Stage 真发：抓「回车 → 就地信号首现 → 网络确认 → 刷新确证」完整时间线 ----
    log('SUBMIT_WARNING', { note: '即将真发一条探针评论。请确认是 tom 测试分组的测试帖；跑完请手动删除。', marker });
    if (!landed) {
      await evalRaw(session.cdp, buildClearEditorJs());
      await dispatchKey(session.cdp, 'Backspace', 'Backspace', 8);
      log('submit_abort', { reason: 'marker_not_accepted', note: '输入未确认落入编辑器，拒绝提交' });
      return;
    }

    // 网络订阅：仅在提交窗口内记录 graphql 请求/响应时刻
    const graphql = new Map<string, GraphqlHit>();
    let capturing = false;
    let t0 = 0;
    const offReq = session.cdp.on?.('Network.requestWillBeSent', (raw) => {
      if (!capturing) return;
      const p = raw as { requestId?: string; request?: { url?: string; postData?: string } };
      const url = p.request?.url ?? '';
      if (!/\/api\/graphql/i.test(url)) return;
      if (p.requestId && !graphql.has(p.requestId)) {
        graphql.set(p.requestId, { requestId: p.requestId, tSentMs: Date.now() - t0, tRespMs: null, inlinePostData: p.request?.postData });
      }
    });
    const offResp = session.cdp.on?.('Network.responseReceived', (raw) => {
      const p = raw as { requestId?: string };
      if (p.requestId && graphql.has(p.requestId)) {
        const hit = graphql.get(p.requestId)!;
        if (hit.tRespMs === null) hit.tRespMs = Date.now() - t0;
      }
    });
    await session.cdp.send('Network.enable').catch(() => undefined);

    // 提交：FB 评论框回车即发（语言无关）。t0 = 回车时刻。
    capturing = true;
    t0 = Date.now();
    await dispatchKey(session.cdp, 'Enter', 'Enter', 13);

    // 就地轮询（不刷新）：逐帧记录信号，直到窗口耗尽
    const frames: PollFrame[] = [];
    let shotMid = false;
    const deadline = t0 + windowMs;
    while (Date.now() < deadline) {
      const tMs = Date.now() - t0;
      let sig: NodeSignal;
      try {
        sig = await evalJson<NodeSignal>(session.cdp, buildNodeSignalJs(frag, ownId));
      } catch (err) {
        sig = { nodeFound: false };
        log('poll_eval_error', { tMs, reason: (err as Error).message });
      }
      frames.push({ tMs, ...sig });
      if (!shotMid && tMs >= 2500) { shotMid = true; await screenshot(session, ts, '1-midpoll'); }
      await sleep(pollMs);
    }
    capturing = false;

    // 补抓 graphql 请求体的 friendly name（响应后请求体通常仍可取；刷新前取）
    for (const hit of graphql.values()) {
      let postData = hit.inlinePostData;
      if (!postData) {
        try {
          const r = await session.cdp.send<{ postData?: string }>('Network.getRequestPostData', { requestId: hit.requestId });
          postData = r.postData;
        } catch {
          postData = undefined;
        }
      }
      hit.friendlyName = friendlyNameOf(postData);
      hit.isCommentCandidate = looksLikeCommentMutation(hit.friendlyName);
      delete hit.inlinePostData; // 不落原始请求体
    }
    offReq?.();
    offResp?.();

    // 刷新一次拿服务器真相（现状权威判据）
    await session.cdp.send('Page.reload', { ignoreCache: true }).catch(() => undefined);
    await sleep(5000);
    let reloaded: NodeSignal = { nodeFound: false };
    try {
      reloaded = await evalJson<NodeSignal>(session.cdp, buildNodeSignalJs(frag, ownId));
    } catch (err) {
      log('reload_verify_error', { reason: (err as Error).message });
    }
    await screenshot(session, ts, '2-postreload');

    // ---- 归纳判据 ----
    const firstNodeMs = firstMs(frames, (f) => !!f.nodeFound);
    const firstCommentIdMs = firstMs(frames, (f) => !!f.hasCommentId);
    const firstTimeElMs = firstMs(frames, (f) => !!f.hasTimeEl);
    const firstTwoButtonsMs = firstMs(frames, (f) => (f.roleButtonCount ?? 0) >= 2);
    const firstOwnIdMs = ownId ? firstMs(frames, (f) => !!f.hasOwnId) : null;
    // ⚠️ pendingObserved 只探 aria-busy / opacity —— 真机（2026-07-17）实测「发布中」是**纯文字**、
    // 无 aria-busy 且 opacity 恒为 1,故此位对在飞态**结构上恒为 false**,别再据它下「没有在飞态」的结论。
    const pendingObserved = frames.some((f) => f.ariaBusy || (typeof f.opacity === 'number' && f.opacity < 0.9));
    // 三态直读（change facebook-comment-lifecycle-verify）:从每帧原文认,别再靠属性/样式。
    const IN_FLIGHT_RE = /发布中|發佈中|发送中|đang đăng|posting|sending/i;
    const REJECTED_RE = /已拒绝|被拒绝|查看反馈|đã từ chối|xem phản hồi|rejected|declined|see feedback/i;
    const inFlightObserved = frames.some((f) => IN_FLIGHT_RE.test(String(f.nodeText ?? '')));
    const rejectedObserved = frames.some((f) => REJECTED_RE.test(String(f.nodeText ?? '')));
    const firstInFlightMs = firstMs(frames, (f) => IN_FLIGHT_RE.test(String(f.nodeText ?? '')));
    const lastInFlightMs = frames.filter((f) => IN_FLIGHT_RE.test(String(f.nodeText ?? ''))).map((f) => f.tMs).pop() ?? null;

    const candidateAckMs = Array.from(graphql.values())
      .filter((h) => h.isCommentCandidate && h.tRespMs !== null)
      .map((h) => h.tRespMs as number)
      .sort((a, b) => a - b)[0] ?? null;
    const anyGraphqlAckMs = Array.from(graphql.values())
      .filter((h) => h.tRespMs !== null)
      .map((h) => h.tRespMs as number)
      .sort((a, b) => a - b)[0] ?? null;

    const reloadPersisted = !!reloaded.nodeFound && !!reloaded.hasCommentId;

    // 关键结论：comment_id 锚点相对「服务器确认」的先后 → 决定就地信号能否单独当成功
    let commentIdVerdict = 'inconclusive';
    if (firstCommentIdMs !== null && candidateAckMs !== null) {
      commentIdVerdict = firstCommentIdMs + 150 >= candidateAckMs ? 'appears_at_or_after_ack_TRUSTWORTHY' : 'appears_before_ack_OPTIMISTIC_UNSAFE';
    } else if (firstCommentIdMs !== null && candidateAckMs === null && anyGraphqlAckMs !== null) {
      commentIdVerdict = firstCommentIdMs + 150 >= anyGraphqlAckMs ? 'appears_after_some_graphql_LIKELY_OK_no_named_mutation' : 'appears_before_any_graphql_OPTIMISTIC_UNSAFE';
    }

    const verdict = {
      firstNodeMs, firstCommentIdMs, firstTimeElMs, firstTwoButtonsMs, firstOwnIdMs,
      pendingObserved,
      inFlightObserved, firstInFlightMs, lastInFlightMs, rejectedObserved,
      candidateAckMs, anyGraphqlAckMs,
      reloadPersisted,
      commentIdVerdict,
      note:
        'commentIdVerdict=appears_at_or_after_ack → 就地看到 comment_id 锚点即可当成功（比现状更快更硬）；' +
        '=appears_before_ack → 乐观渲染，comment_id 不能单独当成功，仍需服务器确认；' +
        'inFlightObserved=true → 「发布中」在飞态存在，lastInFlightMs≈其消失时刻，对齐 candidateAckMs 看点头与落定的间隔；' +
        'rejectedObserved=true → 该评论被平台拒绝（终局，绝不可判成功）；' +
        'pendingObserved 恒 false 属预期（在飞是纯文字，非 aria-busy/opacity）；' +
        'reloadPersisted=false 未必是真相 —— 真机实测刷新后评论区常未及渲染完就被查，会给出假阴性（务必人工复核）。',
    };
    log('verdict', verdict);

    const artifact = {
      mode: 'submit', ts, marker, ownId: ownId || null, windowMs, pollMs,
      editorLabeled: focus.labeled,
      frames, graphql: Array.from(graphql.values()), reloaded, verdict,
      readonlySample: sample.sample,
    };
    const jsonPath = `/tmp/aidcp-fb-comment-verify-${ts}.json`;
    writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));
    log('done_submit', { artifact: jsonPath, note: '把该 json 发回来定方案；并去 FB 手动删除这条探针评论。', marker });
  } catch (err) {
    log('probe_error', { message: (err as Error).message, stack: (err as Error).stack });
    process.exitCode = 1;
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
