/**
 * 弹窗旁路监测体（持续监测 + 状态缓存 + 翻转回调）。
 *
 * 设计动机（与 login-modal-watcher 的「被调才跑」内联探测相对）：
 *  - 把「检测节奏」与「执行节奏」解耦——后台 loop 按自己的节奏(默认 1s)持续判类，
 *    状态独立于命令到达保持新鲜，闸门只读缓存(零 CDP)；
 *  - 把弹窗分成多类，各类的「拿不准时怎么办」与「应对动作」相反：
 *      login    → 暂停等登录（沿用现状）
 *      captcha  → 暂停 + 停手 + 升级（漏一次=可能封号，故 fail-CLOSED）
 *      dismissible(运营活动) → 可关（本 PR 仅分类，关闭交后续 NuisanceDismisser）
 *      unknown  → 可见阻断遮罩但本地未能归类 → 保守暂停 + 上报云端命名(fail-CLOSED)
 *      none     → 放行
 *
 * 错误策略分两处（关键）：
 *  - 后台 tick()：探测失败按「保持上一状态」(sticky)，不翻转——否则页面正常导航期间
 *    Runtime.evaluate 瞬时失败会被误判为验证码，刷假告警；
 *  - probeNow()：原样抛出，交由调用方（高风险动作提交前复检）按 fail-CLOSED 处理。
 *
 * 检测口径沿用项目反混淆理念：只认人类可读、跨改版稳定的语义片段（厂商 iframe host、
 * 挑战文案、稳定语义 class），不锁混淆 class。验证码组件(数美/极验/网易易盾…)的 DOM 指纹
 * 极稳定，故本地确定性探测召回高、误报低，无需云端 LLM 介入热路径。
 */

import type { BrowseCdp } from './cdp-util.js';
import { evalRaw } from './cdp-util.js';
import { BackgroundWatcher } from './background-watcher.js';
import {
  DEFAULT_LOGIN_CONTAINER_SELECTORS,
  DEFAULT_LOGIN_PHRASES,
  LOGIN_EXCLUDE_SELECTOR,
} from './login-modal-watcher.js';

/** 弹窗类别。 */
export type OverlayKind = 'none' | 'login' | 'captcha' | 'dismissible' | 'unknown';
export type BlockingOverlayKind = 'captcha' | 'unknown';

export interface OverlayDomFeature {
  tag: string;
  id?: string;
  className?: string;
  role?: string;
  ariaModal?: string;
  selector?: string;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
  style?: { position?: string; zIndex?: string; opacity?: string };
  hasIframe?: boolean;
  iframeSrcs?: string[];
  hasClose?: boolean;
  matchReasons?: string[];
}

export interface BlockingOverlaySnapshot {
  kind: BlockingOverlayKind;
  /** URL captured at the first local transition into captcha/unknown for this episode. */
  firstDetectedUrl?: string;
  capturedAt: number;
  text?: string;
  dom?: OverlayDomFeature;
  candidates: OverlayDomFeature[];
}

/** 阻断浏览的类别（闸门据此暂停）：登录墙 / 验证码 / 未知阻断遮罩。 */
export function isBlockingKind(kind: OverlayKind): boolean {
  return kind === 'login' || kind === 'captcha' || kind === 'unknown';
}

/** 验证码/风控挑战的特征文案（命中任一即判 captcha）。 */
export const DEFAULT_CAPTCHA_PHRASES = [
  '安全验证',
  '滑动验证',
  '拖动滑块',
  '拖动下方滑块',
  '按住滑块拖动',
  '按住左边滑块',
  '向右滑动',
  '依次点击',
  '请完成验证',
  '完成下方验证',
  '点击完成验证',
  '请按住滑块',
  '请通过滑块验证',
];

/** 运营活动/营销弹窗的特征文案（命中 + 存在关闭按钮 → dismissible）。 */
export const DEFAULT_DISMISSIBLE_PHRASES = [
  '签到',
  '领红包',
  '立即领取',
  '下载App',
  '打开App',
  '开通会员',
  '立即开通',
  '新人专享',
  '限时优惠',
  '优惠券',
];

/** 小红书笔记级访问限制弹窗：不是账号级验证码/登录墙，应允许返回列表恢复。 */
export const DEFAULT_XHS_ACCESS_LIMIT_PHRASES = [
  '当前笔记暂时无法浏览',
  '请打开小红书App扫码查看',
  '小红书如何扫码',
];

export interface OverlayMonitorOptions {
  /** 后台轮询间隔(ms)，默认 1000。 */
  pollMs?: number;
  /** 探测失败兜底类别（probeNow 抛错时由调用方决定；此处仅留扩展位）。 */
  loginContainerSelectors?: string[];
  loginPhrases?: string[];
  captchaPhrases?: string[];
  dismissiblePhrases?: string[];
  excludeSelector?: string;
  /** 注入 setTimeout / clearTimeout（测试可控）。 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  /** 日志（默认不打）。 */
  logger?: (msg: string) => void;
}

/** 弹窗监测体接口（便于在 BrowseSession 里打桩）。 */
export interface OverlayMonitor {
  /** 当前缓存的弹窗类别（零 CDP，供闸门读取）。 */
  readonly state: OverlayKind;
  /** 就地 fresh 探测一次（高风险动作提交前复检用；CDP 失败会抛）。 */
  probeNow(): Promise<OverlayKind>;
  /** 启动后台监测；onTransition 在类别翻转时触发一次。 */
  start(onTransition?: (from: OverlayKind, to: OverlayKind) => void): void;
  /** 停止后台监测（解绑定时器）。 */
  stop(): void;
}

/**
 * 生成「返回当前弹窗类别字符串」的判定 JS。
 *
 * 判定优先级（高危先判）：captcha > login > dismissible > unknown > none。
 * 复用 login-modal-watcher 的可见性/笔记详情排除口径，避免漂移。
 */
export function buildClassifyOverlayJs(
  loginSelectors: string[] = DEFAULT_LOGIN_CONTAINER_SELECTORS,
  loginPhrases: string[] = DEFAULT_LOGIN_PHRASES,
  captchaPhrases: string[] = DEFAULT_CAPTCHA_PHRASES,
  dismissiblePhrases: string[] = DEFAULT_DISMISSIBLE_PHRASES,
  excludeSelector: string = LOGIN_EXCLUDE_SELECTOR,
): string {
  const loginSel = loginSelectors.join(', ');
  return `(function(){
    var EXCLUDE = ${JSON.stringify(excludeSelector)};
    var LOGIN_SEL = ${JSON.stringify(loginSel)};
    var LOGIN_PHRASES = ${JSON.stringify(loginPhrases)};
    var CAPTCHA_PHRASES = ${JSON.stringify(captchaPhrases)};
    var DISMISS_PHRASES = ${JSON.stringify(dismissiblePhrases)};
    var ACCESS_LIMIT_PHRASES = ${JSON.stringify(DEFAULT_XHS_ACCESS_LIMIT_PHRASES)};
    // 已知验证码厂商的 iframe/script host 指纹（数美/极验/网易易盾/阿里 NC/腾讯…）。
    var CAPTCHA_HOST = /captcha|geetest|geevisit|shumei|fengkong|yidun|dun\\.163|aliyun.*nc|nocaptcha|t\\.captcha\\.qq|aq\\.qq|vaptcha|verify/i;
    // 可疑验证码容器 class（滑块/拼图/点选等稳定语义片段）。
    var CAPTCHA_CLS = /(^|[^a-z])(captcha|geetest|nc[_-]|slide[_-]?(verify|wrap|track|btn)|puzzle|vaptcha|shumei|yidun|verify[_-]?(slider|wrap|bar))([^a-z]|$)/i;
    var ACCESS_LIMIT_CLS = /access[-_](modal|limit)|access-limit-app/i;

    function vis(el){
      if(!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      if(!r || r.width<=0 || r.height<=0) return false;
      var s = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if(s && (s.display==='none' || s.visibility==='hidden' || parseFloat(s.opacity||'1')<=0.05)) return false;
      return true;
    }
    function txt(el){ return ((el && el.textContent) || '').replace(/\\s+/g,''); }
    function inNote(el){ return !!(EXCLUDE && el.closest && el.closest(EXCLUDE)); }
    function hitsAny(s, arr){ for(var i=0;i<arr.length;i++){ if(s.indexOf(arr[i])>=0) return true; } return false; }
    function hasClose(el){ return !!(el.querySelector && el.querySelector('.close,[class*="close"],[class*="Close"],[aria-label*="关闭"],[aria-label*="close"]')); }

    // 候选遮罩/对话框集合（验证码、运营、unknown 都在这里面找）。
    var masks = document.querySelectorAll('[class*="mask"],[class*="modal"],[role="dialog"],[aria-modal="true"],[class*="captcha"],[class*="verify"],[id*="captcha"]');

    // ① 验证码：厂商 iframe host / 可疑容器 class / 挑战文案（任一命中）。
    var iframes = document.querySelectorAll('iframe');
    for(var i=0;i<iframes.length;i++){
      var f=iframes[i];
      if(!vis(f) || inNote(f)) continue;
      var src=(f.getAttribute && f.getAttribute('src')) || f.src || '';
      if(CAPTCHA_HOST.test(src)) return 'captcha';
    }
    for(var i=0;i<masks.length;i++){
      var el=masks[i];
      if(!vis(el) || inNote(el)) continue;
      if(hitsAny(txt(el), CAPTCHA_PHRASES)) return 'captcha';
      if(CAPTCHA_CLS.test((el.className && el.className.toString && el.className.toString()) || '')) return 'captcha';
    }

    // ② 登录墙（沿用 login-modal-watcher 口径）。
    var logins = document.querySelectorAll(LOGIN_SEL);
    for(var i=0;i<logins.length;i++){
      var el=logins[i];
      if(!vis(el) || inNote(el)) continue;
      if(hitsAny(txt(el), LOGIN_PHRASES)) return 'login';
    }

    // ③ 小红书笔记级访问限制：可通过回来源列表恢复，不作为账号级阻断。
    for(var i=0;i<masks.length;i++){
      var el=masks[i];
      if(!vis(el) || inNote(el)) continue;
      var cls=(el.className && el.className.toString && el.className.toString()) || '';
      if(ACCESS_LIMIT_CLS.test(cls) || hitsAny(txt(el), ACCESS_LIMIT_PHRASES)) return 'dismissible';
    }

    // ④ 运营活动：营销文案 且 有关闭按钮 → 可关。
    for(var i=0;i<masks.length;i++){
      var el=masks[i];
      if(!vis(el) || inNote(el)) continue;
      if(hitsAny(txt(el), DISMISS_PHRASES) && hasClose(el)) return 'dismissible';
    }

    // ⑤ unknown：可见、较大且 fixed/absolute 的阻断遮罩(非笔记详情)，分不出类且没有明显关闭键，
    //    或内含未识别 iframe → 保守上报，交云端命名。口径偏保守以抑制误暂停。
    var vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    for(var i=0;i<masks.length;i++){
      var el=masks[i];
      if(!vis(el) || inNote(el)) continue;
      var r=el.getBoundingClientRect();
      var s = window.getComputedStyle ? window.getComputedStyle(el) : null;
      var fixed = !!(s && (s.position==='fixed' || s.position==='absolute'));
      var big = r.width >= vw*0.6 && r.height >= vh*0.4;
      var hasIframe = !!(el.querySelector && el.querySelector('iframe'));
      if(hasIframe || (big && fixed && !hasClose(el))) return 'unknown';
    }

    return 'none';
  })()`;
}

export function buildBlockingOverlaySnapshotJs(
  kind: BlockingOverlayKind,
  loginSelectors: string[] = DEFAULT_LOGIN_CONTAINER_SELECTORS,
  loginPhrases: string[] = DEFAULT_LOGIN_PHRASES,
  captchaPhrases: string[] = DEFAULT_CAPTCHA_PHRASES,
  dismissiblePhrases: string[] = DEFAULT_DISMISSIBLE_PHRASES,
  excludeSelector: string = LOGIN_EXCLUDE_SELECTOR,
): string {
  const loginSel = loginSelectors.join(', ');
  return `(function(){
    var KIND = ${JSON.stringify(kind)};
    var EXCLUDE = ${JSON.stringify(excludeSelector)};
    var LOGIN_SEL = ${JSON.stringify(loginSel)};
    var LOGIN_PHRASES = ${JSON.stringify(loginPhrases)};
    var CAPTCHA_PHRASES = ${JSON.stringify(captchaPhrases)};
    var DISMISS_PHRASES = ${JSON.stringify(dismissiblePhrases)};
    var CAPTCHA_HOST = /captcha|geetest|geevisit|shumei|fengkong|yidun|dun\\.163|aliyun.*nc|nocaptcha|t\\.captcha\\.qq|aq\\.qq|vaptcha|verify/i;
    var CAPTCHA_CLS = /(^|[^a-z])(captcha|geetest|nc[_-]|slide[_-]?(verify|wrap|track|btn)|puzzle|vaptcha|shumei|yidun|verify[_-]?(slider|wrap|bar))([^a-z]|$)/i;

    function clip(s, n){
      s = String(s || '').replace(/\\s+/g,' ').trim();
      return s.length > n ? s.slice(0, n - 1) + '...' : s;
    }
    function classText(el){
      var c = el && el.className;
      if(!c) return '';
      if(typeof c === 'string') return c;
      if(typeof c.baseVal === 'string') return c.baseVal;
      return String(c);
    }
    function vis(el){
      if(!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      if(!r || r.width<=0 || r.height<=0) return false;
      var s = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if(s && (s.display==='none' || s.visibility==='hidden' || parseFloat(s.opacity||'1')<=0.05)) return false;
      return true;
    }
    function txt(el){ return clip((el && el.textContent) || '', 500); }
    function compactTxt(el){ return ((el && el.textContent) || '').replace(/\\s+/g,''); }
    function inNote(el){ return !!(EXCLUDE && el.closest && el.closest(EXCLUDE)); }
    function hitsAny(s, arr){ for(var i=0;i<arr.length;i++){ if(s.indexOf(arr[i])>=0) return true; } return false; }
    function hasClose(el){ return !!(el.querySelector && el.querySelector('.close,[class*="close"],[class*="Close"],[aria-label*="close"]')); }
    function selectorHint(el){
      var parts = [];
      var cur = el;
      for(var depth=0; cur && cur.nodeType === 1 && depth < 4; depth++, cur = cur.parentElement){
        var tag = (cur.tagName || '').toLowerCase();
        if(!tag) break;
        var id = cur.id ? '#' + cur.id : '';
        var cls = classText(cur).split(/\\s+/).filter(Boolean).slice(0, 3).map(function(c){ return '.' + c; }).join('');
        parts.unshift(tag + id + cls);
        if(cur.id) break;
      }
      return parts.join(' > ');
    }
    function iframeSrcs(el){
      var out = [];
      if(((el.tagName || '').toLowerCase()) === 'iframe') {
        var own = (el.getAttribute && el.getAttribute('src')) || el.src || '';
        if(own) out.push(clip(own, 180));
      }
      if(!el.querySelectorAll) return out;
      return out.concat(Array.prototype.slice.call(el.querySelectorAll('iframe')).slice(0, 5).map(function(f){
        return clip((f.getAttribute && f.getAttribute('src')) || f.src || '', 180);
      }).filter(Boolean)).slice(0, 5);
    }
    function domFeature(el, reasons){
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle ? window.getComputedStyle(el) : null;
      var srcs = iframeSrcs(el);
      return {
        tag: (el.tagName || '').toLowerCase(),
        id: el.id || undefined,
        className: clip(classText(el), 220) || undefined,
        role: el.getAttribute && (el.getAttribute('role') || undefined),
        ariaModal: el.getAttribute && (el.getAttribute('aria-modal') || undefined),
        selector: selectorHint(el) || undefined,
        text: txt(el) || undefined,
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        style: s ? { position: s.position, zIndex: s.zIndex, opacity: s.opacity } : undefined,
        hasIframe: srcs.length > 0,
        iframeSrcs: srcs,
        hasClose: hasClose(el),
        matchReasons: reasons
      };
    }
    function reasonsFor(el){
      var reasons = [];
      var t = compactTxt(el);
      var cls = classText(el);
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle ? window.getComputedStyle(el) : null;
      var fixed = !!(s && (s.position==='fixed' || s.position==='absolute'));
      var vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
      var big = r.width >= vw*0.6 && r.height >= vh*0.4;
      var srcs = iframeSrcs(el);
      if(hitsAny(t, CAPTCHA_PHRASES)) reasons.push('captcha_text');
      if(CAPTCHA_CLS.test(cls)) reasons.push('captcha_class');
      if(srcs.some(function(src){ return CAPTCHA_HOST.test(src); })) reasons.push('captcha_iframe_host');
      if(srcs.length > 0) reasons.push('has_iframe');
      if(big) reasons.push('large_rect');
      if(fixed) reasons.push('fixed_or_absolute');
      if(!hasClose(el)) reasons.push('no_close_control');
      if(hitsAny(t, LOGIN_PHRASES)) reasons.push('login_text');
      if(hitsAny(t, DISMISS_PHRASES)) reasons.push('dismissible_text');
      return reasons;
    }
    function includeForKind(reasons){
      if(KIND === 'captcha') {
        return reasons.indexOf('captcha_text') >= 0 || reasons.indexOf('captcha_class') >= 0 || reasons.indexOf('captcha_iframe_host') >= 0;
      }
      return reasons.indexOf('has_iframe') >= 0 ||
        (reasons.indexOf('large_rect') >= 0 && reasons.indexOf('fixed_or_absolute') >= 0 && reasons.indexOf('no_close_control') >= 0);
    }

    var nodes = Array.prototype.slice.call(document.querySelectorAll(
      '[class*="mask"],[class*="modal"],[role="dialog"],[aria-modal="true"],[class*="captcha"],[class*="verify"],[id*="captcha"]'
    ));
    if (KIND === 'captcha') {
      nodes = nodes.concat(Array.prototype.slice.call(document.querySelectorAll('iframe')).filter(function(f){
        var src = (f.getAttribute && f.getAttribute('src')) || f.src || '';
        return CAPTCHA_HOST.test(src);
      }));
    }
    var candidates = [];
    for(var i=0;i<nodes.length;i++){
      var el = nodes[i];
      if(!vis(el) || inNote(el)) continue;
      var reasons = reasonsFor(el);
      if(!includeForKind(reasons)) continue;
      candidates.push(domFeature(el, reasons));
    }
    candidates.sort(function(a,b){
      var ar = a.rect ? a.rect.width * a.rect.height : 0;
      var br = b.rect ? b.rect.width * b.rect.height : 0;
      return br - ar;
    });
    var primary = candidates[0];
    return {
      kind: KIND,
      firstDetectedUrl: String(location.href || ''),
      capturedAt: Date.now(),
      text: primary && primary.text || undefined,
      dom: primary || undefined,
      candidates: candidates.slice(0, 3)
    };
  })()`;
}

/** Read-only diagnostic snapshot for the current blocking overlay. */
export async function captureBlockingOverlaySnapshot(
  cdp: BrowseCdp,
  kind: BlockingOverlayKind,
  js: string = buildBlockingOverlaySnapshotJs(kind),
): Promise<BlockingOverlaySnapshot> {
  const raw = await evalRaw<BlockingOverlaySnapshot>(cdp, js);
  return normalizeBlockingOverlaySnapshot(raw, kind);
}

function normalizeBlockingOverlaySnapshot(raw: unknown, fallbackKind: BlockingOverlayKind): BlockingOverlaySnapshot {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const candidates = Array.isArray(obj.candidates)
    ? obj.candidates.map(normalizeOverlayDomFeature).filter((v): v is OverlayDomFeature => v !== undefined)
    : [];
  const dom = normalizeOverlayDomFeature(obj.dom);
  return {
    kind: obj.kind === 'captcha' || obj.kind === 'unknown' ? obj.kind : fallbackKind,
    firstDetectedUrl: typeof obj.firstDetectedUrl === 'string' ? obj.firstDetectedUrl : undefined,
    capturedAt: typeof obj.capturedAt === 'number' ? obj.capturedAt : Date.now(),
    text: typeof obj.text === 'string' ? obj.text : dom?.text,
    dom,
    candidates,
  };
}

function normalizeOverlayDomFeature(raw: unknown): OverlayDomFeature | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.tag !== 'string') return undefined;
  const rect =
    obj.rect && typeof obj.rect === 'object'
      ? (obj.rect as Record<string, unknown>)
      : undefined;
  const style =
    obj.style && typeof obj.style === 'object'
      ? (obj.style as Record<string, unknown>)
      : undefined;
  return {
    tag: obj.tag,
    id: typeof obj.id === 'string' ? obj.id : undefined,
    className: typeof obj.className === 'string' ? obj.className : undefined,
    role: typeof obj.role === 'string' ? obj.role : undefined,
    ariaModal: typeof obj.ariaModal === 'string' ? obj.ariaModal : undefined,
    selector: typeof obj.selector === 'string' ? obj.selector : undefined,
    text: typeof obj.text === 'string' ? obj.text : undefined,
    rect:
      rect &&
      typeof rect.x === 'number' &&
      typeof rect.y === 'number' &&
      typeof rect.width === 'number' &&
      typeof rect.height === 'number'
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : undefined,
    style: style
      ? {
          position: typeof style.position === 'string' ? style.position : undefined,
          zIndex: typeof style.zIndex === 'string' ? style.zIndex : undefined,
          opacity: typeof style.opacity === 'string' ? style.opacity : undefined,
        }
      : undefined,
    hasIframe: typeof obj.hasIframe === 'boolean' ? obj.hasIframe : undefined,
    iframeSrcs: Array.isArray(obj.iframeSrcs)
      ? obj.iframeSrcs.filter((v): v is string => typeof v === 'string')
      : undefined,
    hasClose: typeof obj.hasClose === 'boolean' ? obj.hasClose : undefined,
    matchReasons: Array.isArray(obj.matchReasons)
      ? obj.matchReasons.filter((v): v is string => typeof v === 'string')
      : undefined,
  };
}

/** 就地探测一次，返回弹窗类别（CDP 失败会抛——交调用方决定 fail 策略）。 */
export async function classifyOverlay(
  cdp: BrowseCdp,
  js: string = buildClassifyOverlayJs(),
): Promise<OverlayKind> {
  const v = await evalRaw<string>(cdp, js);
  return isOverlayKind(v) ? v : 'none';
}

function isOverlayKind(v: unknown): v is OverlayKind {
  return v === 'none' || v === 'login' || v === 'captcha' || v === 'dismissible' || v === 'unknown';
}

/**
 * 基于 CDP 的弹窗旁路监测体。复用 BackgroundWatcher 的循环 / 容错(sticky) / 翻转 / 启停 / 心跳，
 * 只提供"如何探测一次弹窗类别"（probe）。外部契约（state/probeNow/start/stop/tick）保持不变。
 */
export class CdpOverlayMonitor extends BackgroundWatcher<OverlayKind> implements OverlayMonitor {
  private readonly cdp: BrowseCdp;
  private readonly js: string;

  constructor(cdp: BrowseCdp, options: OverlayMonitorOptions = {}) {
    super('none', {
      pollMs: options.pollMs,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      logger: options.logger,
      onProbeError: 'sticky',
      label: 'overlay',
    });
    this.cdp = cdp;
    this.js = buildClassifyOverlayJs(
      options.loginContainerSelectors ?? DEFAULT_LOGIN_CONTAINER_SELECTORS,
      options.loginPhrases ?? DEFAULT_LOGIN_PHRASES,
      options.captchaPhrases ?? DEFAULT_CAPTCHA_PHRASES,
      options.dismissiblePhrases ?? DEFAULT_DISMISSIBLE_PHRASES,
      options.excludeSelector ?? LOGIN_EXCLUDE_SELECTOR,
    );
  }

  protected async probe(): Promise<OverlayKind> {
    return classifyOverlay(this.cdp, this.js);
  }
}
