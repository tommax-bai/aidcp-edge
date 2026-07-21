/**
 * Facebook feed 就地深读（change facebook-feed-inline-browse / C2 · surface:'feed'）。
 *
 * 背景（真机探针 docs/facebook-browse-and-like-loop-probe-findings.md §「Feed 就地读全文」）：
 *  - FB 首页 feed 点「展开」= 原地补全全文、**不离开 feed**（P2 已证：location/dialog/卡索引不变）。
 *  - 展开控件 = `div[role=button]` 文案「展开/查看更多/See more」、**非 `<a>`**、在 message 容器内（P1）。
 *  - **textContent 捷径**：折叠帖 `textContent ≈ innerText`（全文不在 DOM，**必须点展开**）；个别无折叠帖
 *    `textContent > innerText`（全文已隐藏在 DOM 里，直接读 textContent，**不点**）。据 ratio 判别。
 *
 * 与 {@link FacebookPostReader}（surface:'detail'，导航进 permalink dialog 读）的分工：本 reader **不导航**，
 * 按命令 noteId 在当前 feed 里三段式锁定目标顶层卡，就地读全文；读取环境一有变化（导航/弹层/卡索引漂移）
 * 就诚实中止 `context_changed`，交由会话回落详情导航——**绝不**在错的页面上把别的内容当成功回报。
 *
 * 红线（贯穿，MUST NOT 静默假成功）：
 *  - **按命令帖身份三段式锁卡**（复用生产 {@link FB_TARGET_HELPERS_JS}，与 like-executor 同一份解析）；
 *    0 个 → `no_target`，>1 → `ambiguous_target`，绝不 DOM 序回落。
 *  - **展开前后校验环境不变**：location.href / dialog 数 / 目标卡在顶层序中的 index / 派生身份，任一变 →
 *    `context_changed`（会话回落 detail），绝不把变了环境后读到的东西当本帖正文。
 *  - **点了展开但正文未变长** → `expand_no_effect`（不当成功）；无展开控件的短帖读到什么算什么（正常成功，非 no_target）。
 *  - **noteId 页面派生**：note.detail 的 noteId 用**目标卡自己 DOM 里的** permalink（三段式已证它携带命令身份），
 *    observation.noteId 用重新派生的规范 `fb:<postId>`，绝不直接复制命令 payload。
 */

import { evalJson, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../browse/overlay-monitor.js';
import { canonicalPostId, FB_TARGET_HELPERS_JS } from './post-identity.js';
import { normalizeFacebookPermalinks } from './probes/page-structure.js';
import { parseFacebookCount } from './feed-reader.js';

export type FacebookInlineReadReason =
  | 'no_target' // 目标帖三段式解析不出
  | 'ambiguous_target' // 同身份 >1 张卡——诚实拒，绝不猜
  | 'expand_no_effect' // 点了展开但正文长度未增（未生效，非成功）
  | 'context_changed' // 展开前后 location/dialog/卡索引/身份变化——就地读不可信，回落 detail
  | 'stale' // 目标卡在读取过程中从 DOM 消失（虚拟化回收）——no_target(stale) 语义
  | 'blocked_by_captcha'
  | 'login_required'
  | 'nav_error';

export interface FacebookInlineReadResult {
  ok: boolean;
  reason?: FacebookInlineReadReason;
  /** 目标卡自己 DOM 里的规范 permalink（作 note.detail 的 noteId + url；页面派生，非命令回显）。 */
  permalinkHref?: string;
  /** 重新派生的规范帖身份 `fb:<postId>`（作 observation.noteId 的独立见证）。 */
  postId?: string;
  /** 帖子正文全文（就地展开 / textContent 捷径后）。 */
  body?: string;
  author?: string;
  /** 反应（赞）计数原始文案；供 note.detail.likeCount + observation.reactionText。 */
  reactionText?: string;
  reactionCount?: number;
  isVideo?: boolean;
  /** 目标卡在顶层可见卡序中的 index（observation 独立见证）。 */
  articleIndex?: number;
  /** feed 卡就地可见的他人评论样本（best-effort，常空——评论多需进详情，见探针 §Detail）。 */
  comments?: string[];
}

export interface FacebookInlineReaderDeps {
  cdp: BrowseCdp;
  /** 旁路弹窗监测体；读取前 fresh 复检登录/验证码（fail-closed）。 */
  overlayMonitor?: OverlayMonitor;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

export interface FacebookInlineReaderOptions {
  /** 点展开后首次复读前的沉淀（毫秒）。 */
  settleMs?: number;
  /** 等展开正文变长的复读轮次上限（每轮复读一次长度）。 */
  expandPollRounds?: number;
  expandPollMs?: number;
  /** feed 卡就地抽评论的条数上限。 */
  maxComments?: number;
}

const DEFAULTS: Required<FacebookInlineReaderOptions> = {
  settleMs: 400,
  expandPollRounds: 6,
  expandPollMs: 300,
  maxComments: 3,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * textContent 捷径判据：textContent 显著长于 innerText ⇒ 全文已隐藏在 DOM 里（无需点展开）。
 * ratio 阈值 1.2、绝对差 30 字符双守卫——折叠帖两者约等（ratio~1.0）时不误判为捷径。
 */
const SHORTCUT_RATIO = 1.2;
const SHORTCUT_MIN_DELTA = 30;

interface RawInlineResolve {
  status: 'ok' | 'no_target' | 'ambiguous_target';
  postId?: string;
  permalinkHrefs?: string[];
  articleIndex?: number;
  href?: string;
  dialogCount?: number;
  textContentLen?: number;
  innerTextLen?: number;
  hasExpandControl?: boolean;
  bodyInner?: string | null;
  bodyFull?: string | null;
  author?: string | null;
  reactionText?: string | null;
  isVideo?: boolean;
}

interface RawInlineExpand {
  found: boolean;
  clicked: boolean;
}

interface RawInlineRead {
  found: boolean;
  postId?: string | null;
  permalinkHrefs?: string[];
  articleIndex?: number;
  href?: string;
  dialogCount?: number;
  innerTextLen?: number;
  bodyInner?: string | null;
  bodyFull?: string | null;
  author?: string | null;
  reactionText?: string | null;
  isVideo?: boolean;
  comments?: string[];
}

export class FacebookInlineReader {
  private readonly cdp: BrowseCdp;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookInlineReaderOptions>;
  private runSeq = 0;

  constructor(deps: FacebookInlineReaderDeps, options: FacebookInlineReaderOptions = {}) {
    this.cdp = deps.cdp;
    this.overlayMonitor = deps.overlayMonitor;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.logger ?? (() => {});
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * 就地深读**命令指定的那张 feed 卡**。noteId 派生规范身份 → 三段式锁卡 → 量 textContent/innerText →
   * 捷径直读 / 点锚定展开 → 展开前后校验环境不变 → 复读全文。诚实回执，绝不假成功。
   */
  async openAndReadInline(noteId?: string): Promise<FacebookInlineReadResult> {
    const raw = String(noteId ?? '').trim();
    const targetId = raw ? canonicalPostId(raw) : null;
    if (!targetId) {
      this.log(`[fb-inline] noteId 派生不出规范帖身份（${raw}），no_target`);
      return { ok: false, reason: 'no_target' };
    }
    // 读取前 fresh 复检旁路弹窗（fail-closed）。
    const blocked = await this.blockingReason();
    if (blocked) return { ok: false, reason: blocked };

    const runId = `inline-${++this.runSeq}`;
    let base: RawInlineResolve;
    try {
      base = await evalJson<RawInlineResolve>(this.cdp, buildInlineResolveJs(targetId, runId));
    } catch (err) {
      this.log(`[fb-inline] 解析/度量失败（CDP/eval 异常）：${(err as Error).message}`);
      return { ok: false, reason: 'nav_error' };
    }
    try {
      if (base.status === 'ambiguous_target') {
        this.log('[fb-inline] 同身份 >1 张卡 → ambiguous_target（诚实拒）');
        return { ok: false, reason: 'ambiguous_target' };
      }
      if (base.status !== 'ok') {
        this.log(`[fb-inline] 解析不到目标卡（targetId=${targetId}），no_target`);
        return { ok: false, reason: 'no_target' };
      }
      return await this.readTagged(targetId, runId, base);
    } finally {
      await this.clearTag(runId);
    }
  }

  /** 目标已锁定并打标：判捷径 → 必要时点展开 + 等变长 → 校验环境不变 → 组装结果。 */
  private async readTagged(targetId: string, runId: string, base: RawInlineResolve): Promise<FacebookInlineReadResult> {
    const baseInner = Number(base.innerTextLen ?? 0);
    const baseFull = Number(base.textContentLen ?? 0);
    const shortcut = baseInner > 0 && baseFull > baseInner * SHORTCUT_RATIO && baseFull - baseInner > SHORTCUT_MIN_DELTA;

    let clickedExpand = false;
    if (!shortcut && base.hasExpandControl === true) {
      let expand: RawInlineExpand;
      try {
        expand = await evalJson<RawInlineExpand>(this.cdp, buildInlineExpandJs(runId));
      } catch (err) {
        this.log(`[fb-inline] 展开点击失败（CDP/eval 异常）：${(err as Error).message}`);
        return { ok: false, reason: 'nav_error' };
      }
      clickedExpand = expand.clicked === true;
      if (clickedExpand) await this.sleep(this.opts.settleMs);
    }

    // 复读：等正文变长（点了展开时）→ 拿最终全文 + 环境校验字段。
    let read = await this.readOnce(targetId, runId);
    if (!read) return { ok: false, reason: 'nav_error' };
    if (clickedExpand) {
      for (let round = 0; round < this.opts.expandPollRounds && Number(read.innerTextLen ?? 0) <= baseInner; round++) {
        await this.sleep(this.opts.expandPollMs);
        const next = await this.readOnce(targetId, runId);
        if (!next) break;
        read = next;
      }
    }
    if (!read.found) {
      this.log('[fb-inline] 目标卡读取时已从 DOM 消失 → stale（no_target 语义）');
      return { ok: false, reason: 'stale' };
    }

    // 环境校验：location / dialog / 卡索引 / 派生身份任一变 → 就地读不可信，回落 detail。
    const contextChanged =
      read.href !== base.href ||
      Number(read.dialogCount ?? -1) !== Number(base.dialogCount ?? -2) ||
      Number(read.articleIndex ?? -1) !== Number(base.articleIndex ?? -2) ||
      (read.postId ?? '') !== (base.postId ?? '');
    if (contextChanged) {
      this.log(
        `[fb-inline] 展开前后环境变化（href/dialog/index/id）→ context_changed（回落 detail）：` +
          `href ${base.href}→${read.href} dlg ${base.dialogCount}→${read.dialogCount} idx ${base.articleIndex}→${read.articleIndex}`,
      );
      return { ok: false, reason: 'context_changed' };
    }

    // 点了展开却没变长 → 未生效，诚实 expand_no_effect（绝不当成功）。
    if (clickedExpand && Number(read.innerTextLen ?? 0) <= baseInner) {
      this.log(`[fb-inline] 点了展开但正文未变长（${baseInner}→${read.innerTextLen}）→ expand_no_effect`);
      return { ok: false, reason: 'expand_no_effect' };
    }

    // 全文：捷径 → textContent（全文已隐藏在 DOM）；否则 → innerText（展开后 / 短帖即全文）。
    const body = shortcut
      ? (base.bodyFull ?? base.bodyInner ?? '').trim()
      : (read.bodyInner ?? base.bodyInner ?? '').trim();
    const perms = normalizeFacebookPermalinks(read.permalinkHrefs ?? base.permalinkHrefs ?? []);
    const permalinkHref = perms[0]?.href;
    const reactionText = (read.reactionText ?? base.reactionText ?? '') || undefined;
    const author = (read.author ?? base.author ?? '').trim() || undefined;
    const comments = Array.isArray(read.comments)
      ? read.comments.map((c) => String(c ?? '').trim()).filter(Boolean).slice(0, this.opts.maxComments)
      : [];

    this.log(
      `[fb-inline] ✓ 就地读全文 postId=${read.postId ?? base.postId} ${shortcut ? '(textContent 捷径)' : clickedExpand ? '(点展开)' : '(短帖直读)'} ` +
        `正文${body.length}字 👍${reactionText ?? '-'}`,
    );
    return {
      ok: true,
      ...(permalinkHref ? { permalinkHref } : {}),
      ...(read.postId || base.postId ? { postId: (read.postId ?? base.postId) as string } : {}),
      body,
      ...(author ? { author } : {}),
      ...(reactionText ? { reactionText } : {}),
      reactionCount: parseFacebookCount(reactionText),
      isVideo: (read.isVideo ?? base.isVideo) === true,
      ...(typeof read.articleIndex === 'number' ? { articleIndex: read.articleIndex } : {}),
      ...(comments.length > 0 ? { comments } : {}),
    };
  }

  private async readOnce(targetId: string, runId: string): Promise<RawInlineRead | null> {
    try {
      return await evalJson<RawInlineRead>(this.cdp, buildInlineReadJs(targetId, runId, this.opts.maxComments));
    } catch (err) {
      this.log(`[fb-inline] 复读失败（CDP/eval 异常）：${(err as Error).message}`);
      return null;
    }
  }

  private async clearTag(runId: string): Promise<void> {
    try {
      await evalJson<{ cleared: boolean }>(this.cdp, buildInlineClearTagJs(runId));
    } catch {
      /* best-effort */
    }
  }

  private async blockingReason(): Promise<'login_required' | 'blocked_by_captcha' | undefined> {
    const monitor = this.overlayMonitor;
    if (!monitor) return undefined;
    let kind: OverlayKind;
    try {
      kind = await monitor.probeNow();
    } catch {
      return 'blocked_by_captcha';
    }
    if (kind === 'login') return 'login_required';
    if (kind === 'captcha' || kind === 'unknown') return 'blocked_by_captcha';
    return undefined;
  }
}

// ─────────────────────────── in-page IIFE（自包含，返回 JSON.stringify；测试按 /*aidcp:inline-\*\*/ 桩）───────────────────────────

/** feed 就地读专用助手：message 容器 + 锚定展开控件 + 就地评论样本。作用域始终是已打标的目标 article。 */
const INLINE_HELPERS = `${FB_TARGET_HELPERS_JS}
  function fbInlText(el){ return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\\s+/g,' ').trim(); }
  var FB_INL_EXPAND=/(查看更多|展开|See more|View more|Ver más|Mostrar más|Voir plus)/i;
  var FB_INL_MSG_SEL='[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-ad-rendering-role="story_message"]';
  /** 目标卡的正文 message 容器（只在该 article 子树内，不落到嵌套评论）。 */
  function fbInlMsg(article){
    if(!article||!article.querySelector) return null;
    var cands=article.querySelectorAll(FB_INL_MSG_SEL);
    for(var i=0;i<cands.length;i++){ if(fbTgtClosestArticle(cands[i])===article) return cands[i]; }
    return null;
  }
  /** 锚定展开控件：[role=button]、文案命中展开词、**非 <a>**、在 message 容器内（无 message 则退到卡内）。 */
  function fbInlExpandControl(article){
    var scope=fbInlMsg(article)||article;
    var btns=scope.querySelectorAll('[role="button"]');
    for(var i=0;i<btns.length;i++){ var el=btns[i];
      if(el.tagName==='A'||(el.closest&&el.closest('a'))) continue;                 // 排 <a>（导航链接不是就地展开）
      if(fbTgtClosestArticle(el)!==article) continue;                              // 嵌套评论里的按钮不算
      if(!fbTgtVisible(el)) continue;
      if(FB_INL_EXPAND.test(fbInlText(el))) return el;
    }
    return null;
  }
  /** 目标卡在顶层可见卡序中的 index（observation 独立见证 + 环境校验）。找不到 → -1。 */
  function fbInlArticleIndex(article){
    var tops=fbTgtTopArticles(fbTgtScopeRoot());
    for(var i=0;i<tops.length;i++){ if(tops[i]===article) return i; }
    return -1;
  }
  /** 卡内 own-level permalink 候选（页面派生 noteId；与 feed 扫卡同源谓词）。 */
  function fbInlPermalinks(article){
    var permalink=fbFeedCardPermalink(article);
    return permalink?[permalink]:[];
  }
  function fbInlTagged(run){ return document.querySelector('[data-aidcp-inline="'+run+'"]'); }
`;

function targetExpr(targetId: string): string {
  return JSON.stringify(targetId);
}

/** 三段式解析 + 打标 + 基线度量（/*aidcp:inline-resolve*\/）。 */
function buildInlineResolveJs(targetId: string, runId: string): string {
  return `(function(){/*aidcp:inline-resolve*/${INLINE_HELPERS}
  var TARGET=${targetExpr(targetId)};
  var stale=document.querySelectorAll('[data-aidcp-inline]');
  for(var i=0;i<stale.length;i++){ stale[i].removeAttribute('data-aidcp-inline'); }
  var r=fbTgtResolve(TARGET);
  if(!r.el) return JSON.stringify({status:r.status});
  r.el.setAttribute('data-aidcp-inline', ${JSON.stringify(runId)});
  var art=r.el;
  var msg=fbInlMsg(art);
  var inner=msg?String(msg.innerText||''):'';
  var full=msg?String(msg.textContent||''):'';
  var ctrl=fbInlExpandControl(art);
  var al=art.querySelector('h2 a, h3 a, h4 a');
  var reactionText='';
  var btns=art.querySelectorAll('[role="button"][aria-label]');
  for(var b=0;b<btns.length;b++){ var lab=(btns[b].getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim(); var bt=fbInlText(btns[b]); if(/^(赞|讚|Like|Me gusta)/i.test(lab)&&/\\d/.test(bt)){ reactionText=bt; break; } }
  return JSON.stringify({
    status:'ok',
    postId:fbTgtArticlePostId(art),
    permalinkHrefs:fbInlPermalinks(art),
    articleIndex:fbInlArticleIndex(art),
    href:location.href,
    dialogCount:document.querySelectorAll('[role="dialog"]').length,
    textContentLen:full.replace(/\\s+/g,' ').trim().length,
    innerTextLen:inner.replace(/\\s+/g,' ').trim().length,
    hasExpandControl:!!ctrl,
    bodyInner:(msg?fbInlText(msg):'').slice(0,2000)||null,
    bodyFull:(full.replace(/\\s+/g,' ').trim()).slice(0,2000)||null,
    author:al?fbInlText(al):null,
    reactionText:reactionText||null,
    isVideo:!!art.querySelector('video')
  });
})()`;
}

/** 点锚定展开控件（/*aidcp:inline-expand*\/）。只对已打标目标卡内的控件 el.click()。 */
function buildInlineExpandJs(runId: string): string {
  return `(function(){/*aidcp:inline-expand*/${INLINE_HELPERS}
  var art=fbInlTagged(${JSON.stringify(runId)});
  if(!art) return JSON.stringify({found:false, clicked:false});
  var ctrl=fbInlExpandControl(art);
  if(!ctrl) return JSON.stringify({found:false, clicked:false});
  try{ ctrl.click(); }catch(e){ return JSON.stringify({found:true, clicked:false}); }
  return JSON.stringify({found:true, clicked:true});
})()`;
}

/** 复读全文 + 环境校验字段 + 就地评论（/*aidcp:inline-read*\/）。只读已打标目标卡。 */
function buildInlineReadJs(targetId: string, runId: string, maxComments: number): string {
  return `(function(){/*aidcp:inline-read*/${INLINE_HELPERS}
  var TARGET=${targetExpr(targetId)};
  var art=fbInlTagged(${JSON.stringify(runId)});
  if(!art) return JSON.stringify({found:false});
  var msg=fbInlMsg(art);
  var inner=msg?String(msg.innerText||'').replace(/\\s+/g,' ').trim():'';
  var full=msg?String(msg.textContent||'').replace(/\\s+/g,' ').trim():'';
  var al=art.querySelector('h2 a, h3 a, h4 a');
  var reactionText='';
  var btns=art.querySelectorAll('[role="button"][aria-label]');
  for(var b=0;b<btns.length;b++){ var lab=(btns[b].getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim(); var bt=fbInlText(btns[b]); if(/^(赞|讚|Like|Me gusta)/i.test(lab)&&/\\d/.test(bt)){ reactionText=bt; break; } }
  // 就地评论：卡内嵌套 [role=article]（评论条目，feed 卡多为空——评论一般需进详情）。best-effort。
  var CHROME=/^(赞|讚|回复|回覆|分享|Like|Reply|Share|More|\\d+)$/i;
  var comments=[]; var nested=art.querySelectorAll('[role="article"]');
  for(var n=0;n<nested.length && comments.length<${Math.max(1, Math.floor(maxComments))};n++){ var c=nested[n];
    if(fbTgtClosestArticle(c.parentElement)!==art) continue;                        // 只取本卡的直接嵌套评论
    var das=c.querySelectorAll('div[dir="auto"]'); var best='';
    for(var d=0;d<das.length;d++){ var t=fbInlText(das[d]); if(t.length>best.length && !CHROME.test(t)) best=t; }
    if(best && best.length>=2) comments.push(best.slice(0,240));
  }
  return JSON.stringify({
    found:true,
    postId:fbTgtArticlePostId(art),
    permalinkHrefs:fbInlPermalinks(art),
    articleIndex:fbInlArticleIndex(art),
    href:location.href,
    dialogCount:document.querySelectorAll('[role="dialog"]').length,
    innerTextLen:inner.length,
    bodyInner:inner.slice(0,2000)||null,
    bodyFull:full.slice(0,2000)||null,
    author:al?fbInlText(al):null,
    reactionText:reactionText||null,
    isVideo:!!art.querySelector('video'),
    comments:comments
  });
})()`;
}

/** 清理临时标记（/*aidcp:inline-cleartag*\/）。 */
function buildInlineClearTagJs(runId: string): string {
  return `(function(){/*aidcp:inline-cleartag*/
  var els=document.querySelectorAll('[data-aidcp-inline="'+${JSON.stringify(runId)}+'"]');
  for(var i=0;i<els.length;i++){ els[i].removeAttribute('data-aidcp-inline'); }
  return JSON.stringify({cleared:true});
})()`;
}
