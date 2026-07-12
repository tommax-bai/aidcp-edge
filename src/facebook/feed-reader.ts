/**
 * Facebook feed 卡片识别（浏览闭环 page.cards 的数据源）。
 *
 * 选择器全部由真机探针钉死（facebook-browse-and-like-loop-probe-findings.md）：
 *  - feed 容器 `div[role="feed"]`，卡片 `[role="article"]`；window/document 滚动（非内层容器）。
 *  - FB **虚拟化** feed：视口外 article 是空壳（无作者/permalink/按钮）——**抽取必须跳过空壳**
 *    （无作者链接即跳过，绝不臆造），水合判据 = 存在 `h2/h3/h4 a` 作者链接。
 *  - 作者名/主页 `article :is(h2,h3,h4) a`；permalink `a[href*="/posts/"|"/permalink"|"story_fbid"|"/videos/"|"/reel/"|"/watch/?v="]`；
 *    正文预览 `[data-ad-comet-preview="message"]|[data-ad-preview="message"]|div[dir="auto"]`；
 *    反应数取「赞」计数汇总按钮（带数字，非 toggle）。
 *
 * Facebook 无「收藏」概念——collect 一律诚实缺省 0（design 决策），绝不用反应数冒充。
 * 宽窄同选择器（探针 1440/900/700 同构），无需分叉。所有 DOM 经 BrowseCdp Runtime.evaluate 自包含 IIFE，
 * Node 侧 JSON.parse，可用 { send } 桩单测。
 */

import { evalJson, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../browse/overlay-monitor.js';
import { normalizeFacebookPermalinks } from './probes/page-structure.js';
import type { FacebookConsentAccepter } from './consent.js';

/** 一张 Facebook feed 卡片（映射 page.cards 的一项）。 */
export interface FacebookFeedCard {
  /** 在本次快照中的序号（仅当前快照有效）。 */
  index: number;
  /** 规范化后的帖子 permalink（作云端 noteId + 详情直开链接）。 */
  noteId: string;
  /** 作者名（读不到则缺省）。 */
  author?: string;
  /** 正文预览（作 page.cards 的 title；图片帖常空）。 */
  textPreview?: string;
  /** 反应（赞）数——已解析；读不到为 0（绝不臆造）。 */
  reactionCount: number;
  /** 是否视频/短视频帖。 */
  isVideo: boolean;
}

/** feed 就绪/阻断诚实结果。 */
export interface FacebookFeedEnsureResult {
  ok: boolean;
  reason?: 'login_required' | 'blocked_by_captcha' | 'blocked_by_consent' | 'no_feed' | 'nav_error';
}

export interface FacebookFeedReaderDeps {
  cdp: BrowseCdp;
  /** 旁路弹窗监测体；导航后 fresh 复检登录/验证码（fail-closed）。 */
  overlayMonitor?: OverlayMonitor;
  /** cookie 同意浮层拟人接受（feed 前置门之一）。缺省=不处理（退化，可能卡在同意条）。 */
  acceptConsent?: FacebookConsentAccepter;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

export interface FacebookFeedReaderOptions {
  /** 导航后等 feed 水合的复探轮数（每轮间隔 pollMs）。FB 渲染 ~7-12s，给足。 */
  hydrateRounds?: number;
  pollMs?: number;
  /** 一次 scrollNext 的位移（CSS 像素）。 */
  scrollDistancePx?: number;
  /** 单次快照最多上报的卡片数。 */
  maxCards?: number;
}

const DEFAULTS: Required<FacebookFeedReaderOptions> = {
  hydrateRounds: 14,
  pollMs: 900,
  scrollDistancePx: 900,
  maxCards: 12,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 解析 Facebook 反应计数文案："3,829" / "1.2K" / "3.4M" / "1.2万"。抓不到/空 → 0（绝不臆造）。 */
export function parseFacebookCount(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = String(raw).trim().toLowerCase().replace(/,/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(k|m|万|萬|w)?/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return 0;
  switch (m[2]) {
    case 'k':
      return Math.round(num * 1_000);
    case 'm':
      return Math.round(num * 1_000_000);
    case '万':
    case '萬':
    case 'w':
      return Math.round(num * 10_000);
    default:
      return Math.round(num);
  }
}

/** 每张卡片在页面内抽出的原始字段（permalink 规范化在 Node 侧做）。 */
interface RawFeedArticle {
  hydrated: boolean;
  author?: string | null;
  textPreview?: string | null;
  reactionText?: string | null;
  permalinkHrefs?: string[];
  hasVideo?: boolean;
}

/**
 * feed 卡片扫描 IIFE：遍历 `div[role=feed] [role=article]`，跳过未水合空壳（无作者链接），
 * 抽作者/正文预览/反应数/permalink/视频标记。返回原始数组 JSON。
 */
const FEED_SCAN_JS = String.raw`(function(){
  function vis(el){ if(!el||!el.getBoundingClientRect) return false; var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) return false; var s=window.getComputedStyle?getComputedStyle(el):null; return !s||(s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity||'1')>0.01); }
  function txt(el){ return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\s+/g,' ').trim(); }
  function href(a){ try{ return new URL(a.getAttribute('href')||a.href||'', location.href).href; }catch(e){ return ''; } }
  function isPermalink(h){ return /\/groups\/[^/]+\/posts\/[^/?#]+/i.test(h)||/\/posts\/[^/?#]+/i.test(h)||/\/permalink\.php/i.test(h)||/\/videos\/[^/?#]+/i.test(h)||/\/reel\/[^/?#]+/i.test(h)||/\/watch\/?\?[^#]*[?&]?v=/i.test(h)||/[?&](story_fbid|multi_permalinks)=/i.test(h); }
  var feed = document.querySelector('div[role="feed"]');
  var scope = feed || document;
  var arts = Array.prototype.slice.call(scope.querySelectorAll('[role="article"]'));
  var out = [];
  for(var i=0;i<arts.length;i++){
    var a = arts[i];
    if(!vis(a)) continue;
    // 水合判据：存在作者链接（h2/h3/h4 a）。虚拟化空壳无之 → 跳过（绝不臆造）。
    var authorLink = a.querySelector('h2 a, h3 a, h4 a');
    if(!authorLink){ out.push({ hydrated:false }); continue; }
    var author = txt(authorLink);
    // permalink 候选：卡内所有命中 permalink 形态的 a[href]。
    var links = a.querySelectorAll('a[href]');
    var perms = [];
    for(var j=0;j<links.length && perms.length<8;j++){ var h=href(links[j]); if(h&&isPermalink(h)) perms.push(h); }
    // 正文预览：story_message / message 优先，否则首个非空 div[dir=auto]。
    var msg = a.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"], [data-ad-rendering-role="story_message"]');
    var preview = msg ? txt(msg) : '';
    if(!preview){ var das = a.querySelectorAll('div[dir="auto"]'); for(var k=0;k<das.length;k++){ var t=txt(das[k]); if(t && t.length>=2){ preview=t; break; } } }
    // 反应计数：帖级动作栏「赞」计数汇总按钮（aria-label 以 赞/Like 开头且带数字文案）。
    var reactionText = '';
    var btns = a.querySelectorAll('[role="button"][aria-label]');
    for(var b=0;b<btns.length;b++){ var lab=(btns[b].getAttribute('aria-label')||'').replace(/\s+/g,' ').trim(); var bt=txt(btns[b]); if(/^(赞|讚|Like|Me gusta)/i.test(lab) && /\d/.test(bt)){ reactionText=bt; break; } }
    var hasVideo = !!(a.querySelector('video') || perms.some(function(h){ return /\/videos\/|\/reel\/|\/watch\/?\?/i.test(h); }));
    out.push({ hydrated:true, author:author||null, textPreview:(preview||'').slice(0,180)||null, reactionText:reactionText||null, permalinkHrefs:perms, hasVideo:hasVideo });
  }
  return JSON.stringify(out);
})()`;

/** 探测 feed 是否已水合（存在 role=feed 且至少一张带作者链接的 article）。 */
const FEED_READY_JS = String.raw`(function(){
  var feed=document.querySelector('div[role="feed"]');
  var scope=feed||document;
  var arts=Array.prototype.slice.call(scope.querySelectorAll('[role="article"]'));
  for(var i=0;i<arts.length;i++){ if(arts[i].querySelector('h2 a, h3 a, h4 a')) return true; }
  return false;
})()`;

export class FacebookFeedReader {
  private readonly cdp: BrowseCdp;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly acceptConsent?: FacebookConsentAccepter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookFeedReaderOptions>;

  constructor(deps: FacebookFeedReaderDeps, options: FacebookFeedReaderOptions = {}) {
    this.cdp = deps.cdp;
    this.overlayMonitor = deps.overlayMonitor;
    this.acceptConsent = deps.acceptConsent;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.logger ?? (() => {});
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * 导航到 feed 并过前置门（cookie 同意 → 登录/验证码复检 → 等水合）。
   * 诚实回执：阻断/无 feed 各有 reason，绝不假成功。
   */
  async ensureFeed(feedUrl: string): Promise<FacebookFeedEnsureResult> {
    try {
      await this.cdp.send('Page.navigate', { url: feedUrl });
    } catch (err) {
      this.log(`[fb-feed] 导航 feed 失败：${(err as Error).message}`);
      return { ok: false, reason: 'nav_error' };
    }
    await this.sleep(this.opts.pollMs);
    // cookie 同意浮层拟人接受（良性合规横幅）：清不掉则诚实 blocked_by_consent。
    if (this.acceptConsent) {
      try {
        const consent = await this.acceptConsent(this.cdp);
        if (consent.handled && !consent.cleared) return { ok: false, reason: 'blocked_by_consent' };
      } catch (err) {
        this.log(`[fb-feed] consent accept error: ${(err as Error).message}`);
      }
    }
    const blocked = await this.blockingReason();
    if (blocked) return { ok: false, reason: blocked };
    // 等 feed 水合（FB ~7-12s）：有界复探，命中即返回。
    for (let i = 0; i < this.opts.hydrateRounds; i++) {
      if (await this.feedReady()) return { ok: true };
      await this.sleep(this.opts.pollMs);
      // 每轮再顺手复检一次阻断（同意条/登录可能延迟弹出）。
      const b = await this.blockingReason();
      if (b) return { ok: false, reason: b };
    }
    return await this.feedReady() ? { ok: true } : { ok: false, reason: 'no_feed' };
  }

  /** 扫描当前视口 feed 卡片 → 规范化 → 去重 → FacebookFeedCard[]（跳过未水合空壳）。 */
  async scanCards(): Promise<FacebookFeedCard[]> {
    let raw: RawFeedArticle[];
    try {
      raw = await evalJson<RawFeedArticle[]>(this.cdp, FEED_SCAN_JS);
    } catch (err) {
      this.log(`[fb-feed] 卡片扫描失败：${(err as Error).message}`);
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const cards: FacebookFeedCard[] = [];
    const seen = new Set<string>();
    for (const a of raw) {
      if (!a || a.hydrated !== true) continue; // 空壳/未水合 → 跳过，绝不臆造
      const perms = normalizeFacebookPermalinks(a.permalinkHrefs ?? []);
      const permalink = perms[0]?.href;
      if (!permalink) continue; // 无可开链接 → 不作候选（诚实）
      if (seen.has(permalink)) continue;
      seen.add(permalink);
      const card: FacebookFeedCard = {
        index: cards.length,
        noteId: permalink,
        reactionCount: parseFacebookCount(a.reactionText),
        isVideo: a.hasVideo === true,
      };
      const author = (a.author ?? '').trim();
      if (author) card.author = author;
      const preview = (a.textPreview ?? '').trim();
      if (preview) card.textPreview = preview;
      cards.push(card);
      if (cards.length >= this.opts.maxCards) break;
    }
    return cards;
  }

  /** feed 翻页：window 滚动（FB feed = 窗口滚动，非内层容器）。真 wheel 优先，scrollBy 兜底。 */
  async scrollNext(): Promise<void> {
    const distance = this.opts.scrollDistancePx;
    try {
      const vp = await evalJson<{ w: number; h: number }>(
        this.cdp,
        '(function(){ return JSON.stringify({ w: window.innerWidth||1280, h: window.innerHeight||800 }); })()',
      ).catch(() => ({ w: 1280, h: 800 }));
      const cx = Math.round(vp.w / 2);
      const cy = Math.round(vp.h / 2);
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: distance });
    } catch (err) {
      this.log(`[fb-feed] wheel 滚动中止（本轮跳过，不中断）：${(err as Error).message}`);
    }
    try {
      await evalJson<unknown>(this.cdp, `(function(){ window.scrollBy(0, ${Math.round(distance)}); return "1"; })()`);
    } catch {
      /* best-effort */
    }
    await this.sleep(this.opts.pollMs);
  }

  private async feedReady(): Promise<boolean> {
    try {
      const raw = await evalJson<boolean>(this.cdp, FEED_READY_JS);
      return raw === true;
    } catch {
      return false;
    }
  }

  /** fresh 复检旁路弹窗；命中登录/验证码/未知 → 诚实原因（探测抛错保守当验证码 fail-closed）。 */
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
