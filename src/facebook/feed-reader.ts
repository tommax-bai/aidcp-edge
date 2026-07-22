/**
 * Facebook feed 卡片识别（浏览闭环 page.cards 的数据源）。
 *
 * 选择器全部由真机探针钉死（docs/facebook-browse-and-like-loop-probe-findings.md）：
 *  - feed 容器 `div[role="feed"]`，卡片 `[role="article"]`；window/document 滚动（非内层容器）。
 *  - FB **虚拟化** feed：视口外 article 是空壳（无作者/正文/permalink/按钮）——**抽取必须跳过空壳**。
 *    水合判据 = 存在 `h2/h3/h4 a` 作者链接或结构化 story-message；两者皆无时绝不臆造。
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
import { normalizeFacebookPermalinks, classifyFacebookSurface, type FacebookSurfaceType } from './probes/page-structure.js';
import type { FacebookConsentAccepter } from './consent.js';
import { scrollFacebookViewport } from './viewport-scroll.js';
import type { RandomFn } from '../humanize/index.js';
import { FB_FEED_LAYOUT_HELPERS_JS, POST_IDENTITY_JS } from './post-identity.js';

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
  /** True only when this call successfully dispatched Page.navigate to the requested list URL. */
  navigated?: boolean;
}

/** 当前页面 surface 探测结果（幂等 ensureFeed 的判据）。 */
export interface FacebookFeedSurface {
  href: string;
  surface: FacebookSurfaceType;
  hasFeed: boolean;
  hydratedArticles: number;
  dialogOpen: boolean;
  /** 首页壳已就绪；与 feed 容器/卡片是否存在分离。 */
  homeReady: boolean;
}

export type FacebookHomeFeedState =
  | 'cards_ready'
  | 'empty_feed_confirmed'
  | 'feed_still_loading'
  | 'feed_unknown'
  | 'login_required'
  | 'blocked_by_captcha'
  | 'blocked_by_consent';

export interface FacebookHomeFeedStateResult {
  state: FacebookHomeFeedState;
  generation?: string;
  /** 同一完整样本里的 loading 信号；present-unreportable 只接受明确 false。 */
  loading?: boolean;
}

export interface FacebookHomeEmptyOptions {
  minDocumentAgeMs?: number;
  stableSamples?: number;
  roundMs?: number;
  wallClockMs?: number;
}

/** loading-aware 累积判稳结果。cards 为真抽卡（绝不含空壳）；degraded=到 wall-clock 仍未完全稳但有真卡。 */
export interface FacebookFeedSettleResult {
  cards: FacebookFeedCard[];
  degraded: boolean;
  /** 仅当 cards 为空时给出失败原因。 */
  reason?: 'feed_still_loading' | 'no_feed' | 'login_required' | 'blocked_by_captcha';
}

export interface FacebookFeedSettleOptions {
  /** 至少多少张真卡才算稳（默认 1）。 */
  minCards?: number;
  /** 硬 wall-clock 上限（毫秒）；导航后~6000、滚动/刷新后~3500。 */
  wallClockMs?: number;
  /** 每轮复扫间隔（毫秒，默认 500）。 */
  roundMs?: number;
}

/** 点顶栏首页图标换批的诚实结果。 */
export interface FacebookHomeRefreshResult {
  ok: boolean;
  reason?: 'no_home_link' | 'click_error';
}

/** 可滚动的列表 surface（首页 / 搜索结果 / 群组 feed）——ensureFeed 幂等放行仅限这些。 */
function isFacebookListSurface(surface: FacebookSurfaceType): boolean {
  return surface === 'home' || surface === 'search' || surface === 'group';
}

export interface FacebookFeedReaderDeps {
  cdp: BrowseCdp;
  /** 旁路弹窗监测体；导航后 fresh 复检登录/验证码（fail-closed）。 */
  overlayMonitor?: OverlayMonitor;
  /** cookie 同意浮层拟人接受（feed 前置门之一）。缺省=不处理（退化，可能卡在同意条）。 */
  acceptConsent?: FacebookConsentAccepter;
  sleep?: (ms: number) => Promise<void>;
  random?: RandomFn;
  logger?: (msg: string) => void;
}

export interface FacebookFeedReaderOptions {
  /** 导航后短暂等待页面接手的间隔（毫秒）；等 feed 水合的耗时改由 settleCards 承担。 */
  pollMs?: number;
  /** 一次 scrollNext 的基准位移（CSS 像素；手势会在 +/-20% 内抖动）。 */
  scrollDistancePx?: number;
  /** 单次快照最多上报的卡片数。 */
  maxCards?: number;
}

const DEFAULTS: Required<FacebookFeedReaderOptions> = {
  pollMs: 900,
  scrollDistancePx: 650,
  maxCards: 12,
};

/** settleCards 兜底默认（wall-clock 上限 / 每轮间隔）。 */
const SETTLE_DEFAULT_WALL_CLOCK_MS = 3_500;
const SETTLE_DEFAULT_ROUND_MS = 500;
const HOME_EMPTY_MIN_DOCUMENT_AGE_MS = 8_000;
const HOME_EMPTY_STABLE_SAMPLES = 3;
const HOME_EMPTY_ROUND_MS = 600;
const HOME_EMPTY_WALL_CLOCK_MS = 15_000;

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
  videoEligible?: boolean;
  videoCenterDistance?: number;
}

/**
 * feed 卡片扫描 IIFE：遍历共享多布局 helper 给出的顶层卡片，跳过未水合空壳（无作者链接），
 * 抽作者/正文预览/反应数/permalink/视频标记。返回原始数组 JSON。
 */
const FEED_SCAN_JS = String.raw`(function(){${POST_IDENTITY_JS}${FB_FEED_LAYOUT_HELPERS_JS}
  function txt(el){ return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\s+/g,' ').trim(); }
  var arts = fbFeedTopCards(document);
  var out = [];
  for(var i=0;i<arts.length;i++){
    var a = arts[i];
    if(!fbFeedVisible(a)) continue;
    // 水合判据：作者或结构化正文至少一个；虚拟化空壳二者皆无 → 跳过（绝不臆造）。
    var authorLink = a.querySelector('h2 a, h3 a, h4 a');
    var storyWitness=a.querySelector(fbFeedStorySelector);
    if(!authorLink&&!storyWitness){ out.push({ hydrated:false }); continue; }
    var author = txt(authorLink);
    // 身份与动作链同源：普通卡取首个 canonical permalink；严格轻量视频可安全合成 watch?v=。
    var cardPermalink=fbFeedCardPermalink(a); var perms=cardPermalink?[cardPermalink]:[];
    // 正文预览：story_message / message 优先，否则首个非空 div[dir=auto]。
    var msg = storyWitness;
    var preview = msg ? txt(msg) : '';
    if(!preview){ var das = a.querySelectorAll('div[dir="auto"]'); for(var k=0;k<das.length;k++){ var t=txt(das[k]); if(t && t.length>=2){ preview=t; break; } } }
    // 反应计数：帖级动作栏「赞」计数汇总按钮（aria-label 以 赞/Like 开头且带数字文案）。
    var reactionText = '';
    var btns = a.querySelectorAll('[role="button"][aria-label]');
    for(var b=0;b<btns.length;b++){ var lab=(btns[b].getAttribute('aria-label')||'').replace(/\s+/g,' ').trim(); var bt=txt(btns[b]); if(/^(赞|讚|Like|Me gusta|Thích)/i.test(lab) && /\d/.test(lab+' '+bt)){ reactionText=bt||lab; break; } }
    var hasVideo = !!(a.querySelector('video') || perms.some(function(h){ return /\/videos\/|\/reel\/|\/watch\/?\?/i.test(h); }));
    var videoEligible=true, videoCenterDistance=0;
    if(hasVideo){ var video=a.querySelector('video'); videoEligible=false; videoCenterDistance=Number.MAX_SAFE_INTEGER;
      if(video&&fbFeedVisible(video)){ var vr=video.getBoundingClientRect(), vw=window.innerWidth||0, vh=window.innerHeight||0;
        var hOverlap=Math.max(0,Math.min(vr.right,vw)-Math.max(vr.left,0));
        var vOverlap=Math.max(0,Math.min(vr.bottom,vh)-Math.max(vr.top,0));
        var hRatio=vr.width>0?hOverlap/vr.width:0, vRatio=vr.height>0?vOverlap/vr.height:0;
        videoEligible=hRatio>=0.1&&vRatio>=0.35;
        videoCenterDistance=Math.abs((vr.top+vr.height/2)-(vh/2));
      }
    }
    out.push({ hydrated:true, author:author||null, textPreview:(preview||'').slice(0,180)||null, reactionText:reactionText||null, permalinkHrefs:perms, hasVideo:hasVideo, videoEligible:videoEligible, videoCenterDistance:videoCenterDistance });
  }
  var primary=-1, distance=Number.MAX_SAFE_INTEGER;
  for(var p=0;p<out.length;p++){ if(out[p].hydrated&&out[p].hasVideo&&out[p].videoEligible&&out[p].permalinkHrefs&&out[p].permalinkHrefs.length>0&&out[p].videoCenterDistance<distance){ primary=p; distance=out[p].videoCenterDistance; } }
  var filtered=[];
  for(var q=0;q<out.length;q++){ if(out[q].hasVideo&&q!==primary) continue; filtered.push(out[q]); }
  return JSON.stringify(filtered);
})()`;

/** 探测当前 surface：URL / 是否有任一受支持 feed 布局 / 已水合卡数 / dialog。用于幂等 ensureFeed。 */
const SURFACE_PROBE_JS = String.raw`(function(){${POST_IDENTITY_JS}${FB_FEED_LAYOUT_HELPERS_JS}
  var feed=document.querySelector('div[role="feed"]');
  var fallback=!feed&&fbFeedFallbackCards(document,false);
  var arts=feed?fbFeedTopCards(feed):(fallback||[]);
  var hydrated=0;
  for(var i=0;i<arts.length;i++){ if(arts[i].querySelector('h2 a, h3 a, h4 a,'+fbFeedStorySelector)) hydrated++; }
  var hostOk=/(^|\.)facebook\.com$/i.test(location.hostname||'');
  var topLevel=false; try{ topLevel=window.top===window; }catch(e){}
  var main=!!document.querySelector('[role="main"],main');
  var shell=!!document.querySelector('[role="banner"],nav[aria-label]');
  var login=!!document.querySelector('input[type="password"],form[action*="login"]');
  var ready=document.readyState==='interactive'||document.readyState==='complete';
  return JSON.stringify({ href: location.href, hasFeed: !!feed||arts.length>0, hydratedArticles: hydrated, dialogOpen: !!document.querySelector('[role="dialog"]'), homeReady: hostOk&&topLevel&&main&&shell&&!login&&ready });
})()`;

interface RawHomeState {
  href: string;
  generation: string;
  ageMs: number;
  homeReady: boolean;
  hasCards: boolean;
  loading: boolean;
  explicitEmpty: boolean;
  loginLike: boolean;
  checkpointLike: boolean;
}

/** 首页空态完整样本：卡片、loading、generation 与同容器成对空态文字一次性同源读取。 */
const HOME_STATE_JS = String.raw`(function(){/*__AIDCP_FB_HOME_STATE__*/${POST_IDENTITY_JS}${FB_FEED_LAYOUT_HELPERS_JS}
  function norm(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase();}
  var href=location.href, hostOk=/(^|\.)facebook\.com$/i.test(location.hostname||''), topLevel=false;try{topLevel=window.top===window;}catch(e){}
  var main=document.querySelector('[role="main"],main'), shell=document.querySelector('[role="banner"],nav[aria-label]');
  var loginLike=!!document.querySelector('input[type="password"],form[action*="login"]');
  var checkpointLike=/\/checkpoint|\/recover/i.test(location.pathname)||!!document.querySelector('form[action*="checkpoint"]');
  var ready=document.readyState==='interactive'||document.readyState==='complete';
  var feed=document.querySelector('div[role="feed"]'), fallback=!feed&&fbFeedFallbackCards(document,false), arts=feed?fbFeedTopCards(feed):(fallback||[]), hasCards=false;
  for(var i=0;i<arts.length;i++){if(arts[i].querySelector('h2 a,h3 a,h4 a,'+fbFeedStorySelector)&&fbFeedVisible(arts[i])){hasCards=true;break;}}
  var scope=main||document.body, loading=!!(scope&&scope.querySelector('[role="progressbar"],[aria-busy="true"]'));
  var explicitEmpty=false, nodes=scope?scope.querySelectorAll('div,section'):[];
  for(var n=0;n<nodes.length;n++){var raw=String(nodes[n].innerText||nodes[n].textContent||'').replace(/\s+/g,' ').trim();if(raw.length<15||raw.length>600)continue;var t=norm(raw);
    var title=/(no more posts|there are no posts|khong con bai viet nao|khong co bai viet nao|没有更多帖子|没有帖子)/i.test(t);
    var hint=/(add friends|them ban be|添加好友)/i.test(t)&&/(feed|bang feed|动态消息|信息流)/i.test(t);
    if(title&&hint){explicitEmpty=true;break;}
  }
  var origin=Number(performance&&performance.timeOrigin)||0, age=origin?Math.max(0,Date.now()-origin):0;
  return JSON.stringify({href:href,generation:String(origin),ageMs:age,homeReady:hostOk&&topLevel&&!!main&&!!shell&&!loginLike&&!checkpointLike&&ready,hasCards:hasCards,loading:loading,explicitEmpty:explicitEmpty,loginLike:loginLike,checkpointLike:checkpointLike});
})()`;

/** feed 区域内是否有 loading 信号——只按可访问性语义（progressbar / aria-busy），绝不认骨架屏 CSS 类名。 */
const LOADING_SIGNAL_JS = String.raw`(function(){
  var scope=document.querySelector('div[role="feed"]')||document.querySelector('[role="main"]')||document.body;
  if(!scope) return false;
  if(scope.querySelector('[role="progressbar"]')) return true;
  if(scope.querySelector('[aria-busy="true"]')) return true;
  return false;
})()`;

/** 页内点顶栏首页图标（结构性定位 [role=banner] a[href="/"]，绝不按「Home/首页」文案）换批，随后显式回顶。 */
const HOME_CLICK_JS = String.raw`(function(){
  var banner=document.querySelector('[role="banner"]');
  var a=(banner&&banner.querySelector('a[href="/"]'))||document.querySelector('[role="banner"] a[href="/"]');
  if(!a) return JSON.stringify({ ok:false, reason:'no_home_link' });
  try { a.click(); } catch(e) { return JSON.stringify({ ok:false, reason:'click_error' }); }
  try { window.scrollTo(0,0); } catch(e) {}
  return JSON.stringify({ ok:true });
})()`;

/** 视口滚动量测：当前滚动位置 / 内容总高 / 视口高。用于判「FB 懒加载是否还在长内容」与「是否已接近底部」。 */
const SCROLL_METRICS_JS = String.raw`(function(){
  var root=document.scrollingElement||document.documentElement;
  var sh=Math.max(document.documentElement?document.documentElement.scrollHeight:0, document.body?document.body.scrollHeight:0);
  return JSON.stringify({ scrollY: Number(window.scrollY||(root&&root.scrollTop)||0), scrollHeight: sh, innerHeight: Number(window.innerHeight||0) });
})()`;

export class FacebookFeedReader {
  private readonly cdp: BrowseCdp;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly acceptConsent?: FacebookConsentAccepter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random?: RandomFn;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookFeedReaderOptions>;

  constructor(deps: FacebookFeedReaderDeps, options: FacebookFeedReaderOptions = {}) {
    this.cdp = deps.cdp;
    this.overlayMonitor = deps.overlayMonitor;
    this.acceptConsent = deps.acceptConsent;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random;
    this.log = deps.logger ?? (() => {});
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * 幂等确保在目标 feed surface：先探一次当前页；已在目标列表面（首页/搜索/群）且有受支持 feed 结构
   * 时直接过前置门返回（**不导航**，消掉「滚动前整页重载」回归）；否则导航到目标 URL。
   *
   * 红线（fail-closed）：无论是否导航，consent 预清理 + 登录/验证码复检都必须跑——它们现搭在导航步骤里，
   * 绝不因省导航而漏掉。等 feed 水合的耗时改由 settleCards 承担（三段合一，避免逼近命令超时）。
   */
  async ensureFeed(
    feedUrl: string,
    onNavigate?: () => void,
    options: { forceNavigate?: boolean } = {},
  ): Promise<FacebookFeedEnsureResult> {
    let onTarget = false;
    let navigated = false;
    let probe: FacebookFeedSurface | undefined;
    try {
      probe = await this.probeSurface();
      const want = classifyFacebookSurface(feedUrl);
      let exactSearch = true;
      if (want === 'search') {
        try {
          const current = new URL(probe.href);
          const target = new URL(feedUrl);
          exactSearch = current.pathname === target.pathname && current.searchParams.get('q') === target.searchParams.get('q');
        } catch {
          exactSearch = false;
        }
      }
      // dialogOpen 不再作为「非目标」判据（change facebook-feed-lazyload-exhaustion-fix）：FB 首页常挂**瞬时/良性**
      // [role=dialog]（聊天弹窗、加载态、通知提示浮层，来了又走）。旧判据「只要存在任意 dialog 就判非目标」→ 每条
      // scroll 命令开头都整页 Page.navigate（经 fbsbx/maw_proxy_page 重定向链回首页）→ 真机上看着就是「一直刷新」、
      // feed 被反复钉回第一屏、永远下不去（真机 CDP 取证：timeOrigin 每 ~8s 重置一次）。FB 就地读不弹模态，dialogOpen
      // 对 FB 恒为良性浮层。既已在正确列表面且任一受支持 feed 结构在场，就是在目标——良性浮层绝不该触发整页重载；真正的
      // 登录/验证码阻断由下方 blockingReason 单独 fail-closed 兜底（不受此变更影响）。
      onTarget = !options.forceNavigate
        && isFacebookListSurface(probe.surface)
        && probe.surface === want
        && exactSearch
        && (want === 'home' ? probe.homeReady : probe.hasFeed);
    } catch (err) {
      this.log(`[fb-feed] surface 探测失败，按需导航：${(err as Error).message}`);
      onTarget = false;
    }
    if (!onTarget) {
      // 导航决策以前不可观测（整页重载没日志）——把判据打出来，便于定位「为什么又整页导航/看着像刷新」。
      this.log(
        `[fb-feed] ensureFeed 判非目标→整页导航 want=${classifyFacebookSurface(feedUrl)} surface=${probe?.surface ?? '探测失败'} homeReady=${probe?.homeReady} hasFeed=${probe?.hasFeed} dialog=${probe?.dialogOpen} href=${(probe?.href ?? '').slice(0, 48)}`,
      );
      try {
        await this.cdp.send('Page.navigate', { url: feedUrl });
        navigated = true;
        onNavigate?.();
      } catch (err) {
        this.log(`[fb-feed] 导航 feed 失败：${(err as Error).message}`);
        return { ok: false, reason: 'nav_error', ...(navigated ? { navigated: true } : {}) };
      }
      await this.sleep(this.opts.pollMs);
    }
    // cookie 同意浮层拟人接受（良性合规横幅）：清不掉则诚实 blocked_by_consent。两条路径都必须跑，绝不因省导航而漏。
    if (this.acceptConsent) {
      try {
        const consent = await this.acceptConsent(this.cdp);
        if (consent.handled && !consent.cleared) return { ok: false, reason: 'blocked_by_consent', ...(navigated ? { navigated: true } : {}) };
      } catch (err) {
        this.log(`[fb-feed] consent accept error: ${(err as Error).message}`);
      }
    }
    const blocked = await this.blockingReason();
    if (blocked) return { ok: false, reason: blocked, ...(navigated ? { navigated: true } : {}) };
    return { ok: true, ...(navigated ? { navigated: true } : {}) };
  }

  /** 探测当前页 surface（URL 归类 + feed/dialog/水合数）。 */
  async probeSurface(): Promise<FacebookFeedSurface> {
    const raw = await evalJson<{ href: string; hasFeed: boolean; hydratedArticles: number; dialogOpen: boolean; homeReady?: boolean }>(
      this.cdp,
      SURFACE_PROBE_JS,
    );
    return {
      href: raw.href,
      surface: classifyFacebookSurface(raw.href),
      hasFeed: raw.hasFeed === true,
      hydratedArticles: Number(raw.hydratedArticles) || 0,
      dialogOpen: raw.dialogOpen === true,
      // 老测试/旧探针桩未提供该字段时保持原有幂等语义；真实脚本始终显式给 boolean。
      homeReady: raw.homeReady !== false,
    };
  }

  /**
   * 只确认 Facebook 首页显式空态。0 卡、超时或未知布局绝不推断为空；样本不能跨 URL/document generation 累积。
   */
  async confirmHomeEmpty(options: FacebookHomeEmptyOptions = {}): Promise<FacebookHomeFeedStateResult> {
    const minAge = Math.max(0, options.minDocumentAgeMs ?? HOME_EMPTY_MIN_DOCUMENT_AGE_MS);
    const stableNeeded = Math.max(1, options.stableSamples ?? HOME_EMPTY_STABLE_SAMPLES);
    const roundMs = Math.max(1, options.roundMs ?? HOME_EMPTY_ROUND_MS);
    const maxRounds = Math.max(stableNeeded, Math.ceil((options.wallClockMs ?? HOME_EMPTY_WALL_CLOCK_MS) / roundMs));
    let generationKey = '';
    let stable = 0;
    let lastLoading = false;
    for (let round = 0; round < maxRounds; round++) {
      const blocked = await this.blockingReason();
      if (blocked) return { state: blocked };
      if (this.acceptConsent) {
        try {
          const consent = await this.acceptConsent(this.cdp);
          if (consent.handled && !consent.cleared) return { state: 'blocked_by_consent' };
        } catch (err) {
          this.log(`[fb-feed] 首页状态复检 consent 失败：${(err as Error).message}`);
          return { state: 'blocked_by_consent' };
        }
      }
      let sample: RawHomeState;
      try {
        sample = await evalJson<RawHomeState>(this.cdp, HOME_STATE_JS);
      } catch {
        return { state: 'feed_unknown' };
      }
      const surface = classifyFacebookSurface(sample.href);
      if (surface === 'login' || sample.loginLike) return { state: 'login_required' };
      if (surface === 'checkpoint' || sample.checkpointLike) return { state: 'blocked_by_captcha' };
      if (surface !== 'home' || !sample.homeReady) return { state: 'feed_unknown' };
      if (sample.hasCards) return { state: 'cards_ready', generation: sample.generation, loading: sample.loading };
      lastLoading = sample.loading;
      const nextKey = `${sample.href}|${sample.generation}`;
      if (nextKey !== generationKey) {
        generationKey = nextKey;
        stable = 0;
      }
      if (sample.loading || sample.ageMs < minAge || !sample.explicitEmpty) {
        stable = 0;
      } else {
        stable += 1;
      }
      if (stable >= stableNeeded) {
        // 动作前最终完整复检：不复用上一样本；任何卡/loading/generation/阻断变化都取消确认。
        const finalBlocked = await this.blockingReason();
        if (finalBlocked) return { state: finalBlocked };
        if (this.acceptConsent) {
          try {
            const consent = await this.acceptConsent(this.cdp);
            if (consent.handled && !consent.cleared) return { state: 'blocked_by_consent' };
          } catch (err) {
            this.log(`[fb-feed] 首页最终复检 consent 失败：${(err as Error).message}`);
            return { state: 'blocked_by_consent' };
          }
        }
        let finalSample: RawHomeState;
        try {
          finalSample = await evalJson<RawHomeState>(this.cdp, HOME_STATE_JS);
        } catch {
          return { state: 'feed_unknown' };
        }
        if (finalSample.hasCards) return { state: 'cards_ready', generation: finalSample.generation, loading: finalSample.loading };
        const finalKey = `${finalSample.href}|${finalSample.generation}`;
        if (
          classifyFacebookSurface(finalSample.href) === 'home' &&
          finalSample.homeReady &&
          finalKey === generationKey &&
          finalSample.ageMs >= minAge &&
          !finalSample.loading &&
          finalSample.explicitEmpty &&
          !finalSample.loginLike &&
          !finalSample.checkpointLike
        ) {
          return { state: 'empty_feed_confirmed', generation: finalSample.generation };
        }
        stable = 0;
        generationKey = finalKey;
        lastLoading = finalSample.loading;
      }
      if (round < maxRounds - 1) await this.sleep(roundMs);
    }
    return { state: lastLoading ? 'feed_still_loading' : 'feed_unknown', ...(generationKey ? { generation: generationKey } : {}) };
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

  /** feed 翻页：惯性 wheel 手势；只有实测 document 未动时才一次 JS 兜底。 */
  async scrollNext(): Promise<void> {
    await scrollFacebookViewport(this.cdp, {
      distancePx: this.opts.scrollDistancePx,
      random: this.random,
      sleep: this.sleep,
      logger: this.log,
    });
    await this.sleep(this.opts.pollMs);
  }

  /**
   * 量测视口滚动状态（scrollY / 内容总高 / 视口高）。用于滚动循环区分「FB 懒加载还在长内容 / 未到底」
   * 与「真·刷到底」——只有内容不再增长且接近底部时才允许判 feed_exhausted。探测异常保守回全 0（调用方据此不判到底）。
   */
  async scrollMetrics(): Promise<{ scrollY: number; scrollHeight: number; innerHeight: number }> {
    try {
      const raw = await evalJson<{ scrollY: number; scrollHeight: number; innerHeight: number }>(this.cdp, SCROLL_METRICS_JS);
      return {
        scrollY: Number(raw.scrollY) || 0,
        scrollHeight: Number(raw.scrollHeight) || 0,
        innerHeight: Number(raw.innerHeight) || 0,
      };
    } catch {
      return { scrollY: 0, scrollHeight: 0, innerHeight: 0 };
    }
  }

  /** feed 区域内是否有 loading 信号（progressbar / aria-busy）。探测异常保守当无信号（交给 wall-clock 兜底）。 */
  private async feedLoading(): Promise<boolean> {
    try {
      return (await evalJson<boolean>(this.cdp, LOADING_SIGNAL_JS)) === true;
    } catch {
      return false;
    }
  }

  /**
   * loading-aware 累积判稳：每轮复扫同一 scanCards，比对相邻两轮真卡 noteId 集合；
   * 三条件全满足（≥minCards 真卡 / 相邻两轮集合相等 / feed 区域无 loading 信号）才返回稳定批。
   * loading 信号是单向「继续等」否决票。有界迭代（maxRounds = ceil(wallClock/round)）兜底，绝不空转死循环。
   */
  async settleCards(options: FacebookFeedSettleOptions = {}): Promise<FacebookFeedSettleResult> {
    const minCards = Math.max(1, options.minCards ?? 1);
    const wallClockMs = options.wallClockMs ?? SETTLE_DEFAULT_WALL_CLOCK_MS;
    const roundMs = options.roundMs ?? SETTLE_DEFAULT_ROUND_MS;
    const maxRounds = Math.max(2, Math.ceil(wallClockMs / Math.max(1, roundMs)));
    let prevKey: string | null = null;
    let lastCards: FacebookFeedCard[] = [];
    let lastLoading = false;
    for (let round = 0; round < maxRounds; round++) {
      // 等待期间弹登录/验证码也 fail-closed。
      const blocked = await this.blockingReason();
      if (blocked) return { cards: [], degraded: false, reason: blocked };
      const cards = await this.scanCards();
      const loading = await this.feedLoading();
      lastCards = cards;
      lastLoading = loading;
      const key = cards.map((c) => c.noteId).join('|');
      const stable = prevKey !== null && key === prevKey;
      if (cards.length >= minCards && stable && !loading) {
        return { cards, degraded: false };
      }
      prevKey = key;
      if (round < maxRounds - 1) await this.sleep(roundMs);
    }
    // 触达 wall-clock：有真卡则照实上报 + degraded（非假成功，卡为真抽）；否则按 loading 与否分可重试 / 无 feed。
    if (lastCards.length >= 1) return { cards: lastCards, degraded: true };
    if (lastLoading) return { cards: [], degraded: false, reason: 'feed_still_loading' };
    return { cards: [], degraded: false, reason: 'no_feed' };
  }

  /** 页内点顶栏首页图标换批（SPA、不整页重载），随后回顶。诚实回执，定位不到不假点。 */
  async clickHomeAndScrollTop(): Promise<FacebookHomeRefreshResult> {
    try {
      const r = await evalJson<{ ok: boolean; reason?: 'no_home_link' | 'click_error' }>(this.cdp, HOME_CLICK_JS);
      return r?.ok ? { ok: true } : { ok: false, reason: r?.reason ?? 'no_home_link' };
    } catch (err) {
      this.log(`[fb-feed] 首页图标点击失败：${(err as Error).message}`);
      return { ok: false, reason: 'click_error' };
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
