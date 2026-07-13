/**
 * Facebook 帖子详情深读（浏览闭环 note.detail 的数据源）。
 *
 * 真机探针（facebook-browse-and-like-loop-probe-findings.md §Detail）：导航到 `/posts/pfbid…` permalink
 * 会在 feed 之上打开 `role="dialog"` 模态；主帖正文 `[data-ad-comet-preview="message"]|[data-ad-preview="message"]`，
 * 兜底 `div[dir="auto"]`；评论是 dialog 内嵌套 `[role="article"]`（懒加载）；反应/评论计数在动作栏按钮文案里。
 *
 * 与评论支线的 openPost 分工：本 reader 服务【自治浏览】——抽正文/评论/反应计数供 content_evaluator 判值 +
 * 撰写器读评论；不校验评论框就绪（不发评论）。计数诚实解析、抓不到为 0，collect 恒 0（FB 无收藏）。
 */

import { evalJson, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../browse/overlay-monitor.js';
import { collectFacebookPageStructure } from './probes/page-structure.js';
import { parseFacebookCount } from './feed-reader.js';
import type { FacebookConsentAccepter } from './consent.js';

export interface FacebookPostDetail {
  ok: boolean;
  reason?: 'login_required' | 'blocked_by_captcha' | 'blocked_by_consent' | 'open_failed' | 'nav_error';
  /** 规范化 permalink（回显，作 note.detail 的 noteId + url）。 */
  permalink: string;
  /** 帖子正文（图片帖常空；best-effort、不臆造）。 */
  body: string;
  /** 顶部他人评论正文样本（去作者名/界面词）；供撰写器读了再写。 */
  comments: string[];
  /** 反应（赞）数——已解析，抓不到为 0。 */
  reactionCount: number;
  /** 评论数——已解析，抓不到为 0。 */
  commentCount: number;
  /** 作者名（读不到则缺省）。 */
  author?: string;
  isVideo: boolean;
}

export interface FacebookPostReaderDeps {
  cdp: BrowseCdp;
  overlayMonitor?: OverlayMonitor;
  acceptConsent?: FacebookConsentAccepter;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

export interface FacebookPostReaderOptions {
  settleMs?: number;
  surfaceProbeRounds?: number;
  pollMs?: number;
  maxComments?: number;
}

const DEFAULTS: Required<FacebookPostReaderOptions> = {
  settleMs: 2_500,
  surfaceProbeRounds: 8,
  pollMs: 700,
  maxComments: 6,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Facebook 某些帖子路由在 CDP 的 Page.navigate 上可能迟迟不回 ACK，但页面仍能接受脚本导航。
 * 只在主导航失败后尝试一次 location.assign；兜底也失败时继续向上返回原始错误，保持诚实失败。
 */
export async function navigateFacebookPost(
  cdp: BrowseCdp,
  permalink: string,
  logger: (message: string) => void = () => {},
): Promise<'page.navigate' | 'runtime.assign'> {
  try {
    await cdp.send('Page.navigate', { url: permalink });
    return 'page.navigate';
  } catch (primaryError) {
    logger(`[fb-detail] Page.navigate 失败，尝试脚本导航兜底：${(primaryError as Error).message}`);
    try {
      await cdp.send('Runtime.evaluate', {
        expression: `void window.location.assign(${JSON.stringify(permalink)})`,
        returnByValue: true,
      });
      logger('[fb-detail] 脚本导航兜底已派发');
      return 'runtime.assign';
    } catch (fallbackError) {
      logger(`[fb-detail] 脚本导航兜底失败：${(fallbackError as Error).message}`);
      throw primaryError;
    }
  }
}

interface RawPostDetail {
  body: string | null;
  comments: string[];
  reactionText: string | null;
  commentText: string | null;
  author: string | null;
  isVideo: boolean;
}

export class FacebookPostReader {
  private readonly cdp: BrowseCdp;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly acceptConsent?: FacebookConsentAccepter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookPostReaderOptions>;

  constructor(deps: FacebookPostReaderDeps, options: FacebookPostReaderOptions = {}) {
    this.cdp = deps.cdp;
    this.overlayMonitor = deps.overlayMonitor;
    this.acceptConsent = deps.acceptConsent;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.logger ?? (() => {});
    this.opts = { ...DEFAULTS, ...options };
  }

  /** 按 permalink 直驱开帖 → 过前置门 → 等 article 渲染 → 抽详情。诚实回执，绝不假成功。 */
  async openAndRead(permalink: string): Promise<FacebookPostDetail> {
    const empty = (reason: FacebookPostDetail['reason']): FacebookPostDetail => ({
      ok: false,
      reason,
      permalink,
      body: '',
      comments: [],
      reactionCount: 0,
      commentCount: 0,
      isVideo: false,
    });
    try {
      await navigateFacebookPost(this.cdp, permalink, this.log);
    } catch (err) {
      this.log(`[fb-detail] 开帖导航失败：${(err as Error).message}`);
      return empty('nav_error');
    }
    await this.sleep(this.opts.settleMs);
    if (this.acceptConsent) {
      try {
        const consent = await this.acceptConsent(this.cdp);
        if (consent.handled && !consent.cleared) return empty('blocked_by_consent');
      } catch (err) {
        this.log(`[fb-detail] consent accept error: ${(err as Error).message}`);
      }
    }
    const blocked = await this.blockingReason();
    if (blocked) return empty(blocked);

    // 等 article 渲染（主帖 + 评论各是一个 article）。有界复探。
    let hasArticle = false;
    for (let i = 0; i < this.opts.surfaceProbeRounds; i++) {
      try {
        const s = await collectFacebookPageStructure(this.cdp);
        if (s.surface === 'login') return empty('login_required');
        if (s.surface === 'checkpoint') return empty('blocked_by_captcha');
        if (s.articleCount > 0) {
          hasArticle = true;
          break;
        }
      } catch (err) {
        this.log(`[fb-detail] 结构探测失败：${(err as Error).message}`);
      }
      await this.sleep(this.opts.pollMs);
    }
    if (!hasArticle) return empty('open_failed');

    let raw: RawPostDetail;
    try {
      raw = await evalJson<RawPostDetail>(this.cdp, buildDetailJs(this.opts.maxComments));
    } catch (err) {
      this.log(`[fb-detail] 详情抽取失败：${(err as Error).message}`);
      return empty('open_failed');
    }
    const detail: FacebookPostDetail = {
      ok: true,
      permalink,
      body: (raw.body ?? '').trim(),
      comments: Array.isArray(raw.comments) ? raw.comments.map((c) => String(c ?? '').trim()).filter(Boolean) : [],
      reactionCount: parseFacebookCount(raw.reactionText),
      commentCount: parseFacebookCount(raw.commentText),
      isVideo: raw.isVideo === true,
    };
    const author = (raw.author ?? '').trim();
    if (author) detail.author = author;
    return detail;
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

/**
 * 详情抽取 IIFE：主帖（dialog 内首个非嵌套 article，退化整页首个）正文 + 顶部他人评论 + 反应/评论计数 + 作者。
 * 界面词过滤同 comment-executor（本号 FB 界面 zh/en）。
 */
function buildDetailJs(maxComments: number): string {
  return `(function(){
    function t(el){ return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\\s+/g,' ').trim(); }
    var CHROME=/^(赞|讚|回复|回覆|分享|查看翻译|隐藏|关注|举报|编辑|删除|置顶|Like|Reply|Share|See translation|Follow|Hide|More|\\d+\\s*(分钟|小时|天|周|年|min|h|d|w|y)?|[·•])$/i;
    function isChrome(s){ return !s || s.length<2 || CHROME.test(s); }
    function inAnchor(node){ var p=node; while(p){ if(p.tagName==='A') return true; p=p.parentElement; } return false; }
    function inAny(node, roots){ for(var i=0;i<roots.length;i++){ if(roots[i]!==node && roots[i].contains(node)) return true; } return false; }
    function blockTexts(root, exclude){ return Array.prototype.slice.call(root.querySelectorAll('div[dir="auto"]')).filter(function(d){ return !inAnchor(d) && !inAny(d, exclude||[]); }).map(t).filter(function(s){ return !isChrome(s); }); }
    function longest(arr){ var best=''; for(var i=0;i<arr.length;i++){ if(arr[i].length>best.length) best=arr[i]; } return best; }
    var dialog=document.querySelector('[role="dialog"]');
    var root=dialog||document;
    var arts=Array.prototype.slice.call(root.querySelectorAll('[role="article"], article'));
    function isNested(a){ return arts.some(function(b){ return b!==a && b.contains(a); }); }
    var top=arts.filter(function(a){ return !isNested(a); });
    var comments=arts.filter(isNested);
    var post=top[0]||null;
    var body=null, author=null, isVideo=false, reactionText=null, commentText=null;
    if(post){
      var sm=post.querySelector('[data-ad-rendering-role="story_message"],[data-ad-comet-preview="message"],[data-ad-preview="message"]');
      var smt=sm?t(sm):'';
      body=(smt && !isChrome(smt)) ? smt : (longest(blockTexts(post, comments)) || null);
      if(body) body=body.slice(0,2000);
      var al=post.querySelector('h2 a, h3 a, h4 a'); author=al?t(al):null;
      isVideo=!!post.querySelector('video');
      // 反应/评论计数：动作栏「赞/Like」「评论/Comment」按钮里的数字文案。
      var btns=post.querySelectorAll('[role="button"][aria-label]');
      for(var b=0;b<btns.length;b++){ var lab=(btns[b].getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim(); var bt=t(btns[b]);
        if(!reactionText && /^(赞|讚|Like|Me gusta)/i.test(lab) && /\\d/.test(bt)) reactionText=bt;
        if(!commentText && /(发表评论|發表評論|Comment)/i.test(lab) && /\\d/.test(bt)) commentText=bt;
      }
    }
    function looksLikeName(s){ return /^([A-ZÀ-ſ][^\\s]*\\s+){0,3}[A-ZÀ-ſ][^\\s]*$/.test(s) && s.split(/\\s+/).length<=4; }
    function authorOf(c){ var a=c.querySelector('a[href*="/user/"],a[href*="profile.php?id="],h3 a,h4 a'); return a?t(a):''; }
    var out=[]; var seen={};
    for(var k=0;k<comments.length && out.length<${Math.max(1, Math.floor(maxComments))};k++){
      var au=authorOf(comments[k]);
      var all=blockTexts(comments[k], []);
      var blocks=au ? all.filter(function(s){ return s!==au && s.indexOf(au)!==0; }) : all;
      var cb=longest(blocks);
      if(!cb || looksLikeName(cb)) continue;
      var key=cb.slice(0,60); if(seen[key]) continue; seen[key]=1;
      out.push(cb.slice(0,240));
    }
    return JSON.stringify({ body:body, comments:out, reactionText:reactionText, commentText:commentText, author:author, isVideo:isVideo });
  })()`;
}
