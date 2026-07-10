import { dispatchClick, evalJson, type BrowseCdp } from '../browse/cdp-util.js';

/**
 * Facebook cookie 同意浮层（「允许 Facebook 使用 Cookie」）的边缘本地识别 + 拟人自动接受。
 *
 * 与验证码 / 登录门相反：同意条是每个真人首次访问都会点掉的合规横幅，自动点才是拟人行为，
 * 明确在验证码远程协助（captcha-incident-handling）射程之外——不上报为 blocking、不暂停会话。
 *
 * 红线（贯穿全模块）：
 *  - 只对被识别为同意条的浮层动手：命中 cookie 政策文案 + cookie 接受按钮 + 非登录/验证 URL + 非验证码。
 *    真登录门（有「登录 Facebook」字样但无 cookie 接受按钮）、验证码天然被排除，绝不误点。
 *  - 后置校验：点完复探确认横幅消失方判成功；找不到按钮 → no_target，绝不乱点其他按钮。
 *  - 有界重试：到上限仍在 → blocked_by_consent 停手升级，绝不静默假成功。
 */

export type FacebookConsentPolicy = 'accept_all' | 'necessary_only';

export interface FacebookConsentButton {
  x: number;
  y: number;
  label: string;
}

/** DOM 侧采集到的同意条信号（纯函数据以判定，便于脱浏览器单测）。 */
export interface FacebookConsentSignals {
  href: string;
  /** 页面存在 cookie 政策语义文案（标题/正文）。 */
  hasCookiePolicyCopy: boolean;
  /** 页面存在验证码/风控挑战特征（存在则 consent 让位，绝不点）。 */
  captchaLike: boolean;
  /** 「允许所有 Cookie」类按钮（可见、带坐标）。 */
  acceptAll?: FacebookConsentButton | null;
  /** 「仅允许必要 Cookie」类按钮（可见、带坐标）。 */
  necessaryOnly?: FacebookConsentButton | null;
}

export interface FacebookConsentDetection {
  /** 判定为可自动接受的同意条（已排除登录门 / 验证码）。 */
  present: boolean;
  onLoginUrl: boolean;
  captchaLike: boolean;
  acceptAll: FacebookConsentButton | null;
  necessaryOnly: FacebookConsentButton | null;
}

export interface FacebookConsentResult {
  /** 探到同意条（有可处置对象）。false = 无同意条，调用方照常继续。 */
  handled: boolean;
  /** 接受后复探确认横幅已消失。 */
  cleared: boolean;
  attempts: number;
  /** 失败时的诚实原因（handled=true 且 cleared=false 时给出）。 */
  reason?: 'blocked_by_consent' | 'no_target';
}

function isLoginLikeUrl(href: string): boolean {
  const path = (() => {
    try {
      return new URL(href).pathname.toLowerCase();
    } catch {
      return String(href || '').toLowerCase();
    }
  })();
  return /\/login|\/checkpoint|\/recover|\/two_step_verification/.test(path);
}

/**
 * 纯判定：把 DOM 采集信号归结为「是否可自动接受的同意条」。
 * 优先级铁律：验证码 / 登录门优先——onLoginUrl 或 captchaLike 时一律 present=false（让既有闸处置）。
 * present 需同时满足：有 cookie 政策文案 + 至少一个 cookie 接受按钮 + 非登录 URL + 非验证码。
 */
export function classifyFacebookConsentFromSignals(signals: FacebookConsentSignals): FacebookConsentDetection {
  const onLoginUrl = isLoginLikeUrl(signals.href);
  const captchaLike = signals.captchaLike === true;
  const acceptAll = signals.acceptAll ?? null;
  const necessaryOnly = signals.necessaryOnly ?? null;
  const hasButton = Boolean(acceptAll || necessaryOnly);
  const present = signals.hasCookiePolicyCopy === true && hasButton && !onLoginUrl && !captchaLike;
  return { present, onLoginUrl, captchaLike, acceptAll, necessaryOnly };
}

const CONSENT_SCAN_JS = String.raw`(function(){
  function vis(el){
    if(!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if(!r || r.width <= 0 || r.height <= 0) return false;
    var s = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if(s && (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') <= 0.05)) return false;
    return true;
  }
  function label(el){
    var a = (el && el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
    var t = (el && (el.innerText || el.textContent)) || '';
    return String(a || t).replace(/\s+/g, ' ').trim();
  }
  function center(el){ var r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), label: label(el).slice(0, 60) }; }

  var bodyText = String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ');
  // cookie 政策语义文案（多语言，稳定人类可读片段，不锁 class）。
  var COOKIE_COPY = /(cookie\s*政策|cookie\s*policy|允许\s*facebook\s*使用\s*cookie|允许使用\s*cookie|使用\s*cookie|allow\s+the\s+use\s+of\s+cookies|use\s+of\s+cookies|allow\s+all\s+cookies|允许所有\s*cookie)/i;
  var hasCookiePolicyCopy = COOKIE_COPY.test(bodyText);

  // 验证码/风控特征（存在则让位，consent 绝不动）。
  var captchaLike = /(recaptcha|captcha|security\s*check|人机身份验证|人机验证|安全验证)/i.test(bodyText);
  var frames = document.querySelectorAll('iframe');
  for(var i=0;i<frames.length && !captchaLike;i++){
    var src = (frames[i].getAttribute && frames[i].getAttribute('src')) || frames[i].src || '';
    if(/captcha|recaptcha|fbsbx\.com\/captcha/i.test(String(src))) captchaLike = true;
  }

  // 接受 / 仅必要 按钮（按可见文案 / aria 命中稳定语义，不锁哈希 class）。
  var ACCEPT_ALL = /^(允许所有\s*cookie|允许全部\s*cookie|接受所有\s*cookie|同意所有\s*cookie|允许\s*facebook\s*使用\s*cookie|允许使用\s*cookie|allow\s+all\s+cookies|accept\s+all\s+cookies|allow\s+the\s+use\s+of\s+cookies)$/i;
  var NECESSARY = /^(仅允许必要\s*cookie|只允许必要\s*cookie|仅接受必要\s*cookie|拒绝非必要\s*cookie|only\s+allow\s+essential\s+cookies|decline\s+optional\s+cookies|refuse\s+non-?essential\s+cookies)$/i;
  var acceptAll = null, necessaryOnly = null;
  var nodes = document.querySelectorAll('[role="button"],button,a[role="button"],div[aria-label],span[aria-label]');
  for(var j=0;j<nodes.length;j++){
    var el = nodes[j];
    if(!vis(el)) continue;
    var lab = label(el);
    if(!lab) continue;
    if(!acceptAll && ACCEPT_ALL.test(lab)) acceptAll = center(el);
    else if(!necessaryOnly && NECESSARY.test(lab)) necessaryOnly = center(el);
    if(acceptAll && necessaryOnly) break;
  }

  return JSON.stringify({
    href: location.href,
    hasCookiePolicyCopy: hasCookiePolicyCopy,
    captchaLike: captchaLike,
    acceptAll: acceptAll,
    necessaryOnly: necessaryOnly
  });
})()`;

/** CDP 侧一次只读探测：采集信号 → 纯判定。CDP 失败向上抛，交调用方决定（默认视为无同意条继续）。 */
export async function detectFacebookConsent(cdp: BrowseCdp): Promise<FacebookConsentDetection> {
  const signals = await evalJson<FacebookConsentSignals>(cdp, CONSENT_SCAN_JS);
  return classifyFacebookConsentFromSignals(signals);
}

/** 读 env 决定接受策略（默认 accept_all）。necessary_only 只在显式配置时启用。 */
export function facebookConsentPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): FacebookConsentPolicy {
  const v = String(env.AIDCP_FB_COOKIE_CONSENT ?? '').trim().toLowerCase();
  if (v === 'necessary_only' || v === 'necessary' || v === 'essential') return 'necessary_only';
  return 'accept_all';
}

export interface AcceptFacebookConsentOptions {
  policy?: FacebookConsentPolicy;
  /** 清不掉时的重试上限（含首次），默认 3。 */
  maxAttempts?: number;
  /** 每次点击后等待横幅消失的时长，默认 700ms。 */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
  /** 注入点（测试用）。 */
  detect?: (cdp: BrowseCdp) => Promise<FacebookConsentDetection>;
  click?: (cdp: BrowseCdp, x: number, y: number) => Promise<void>;
}

/** 按策略挑接受按钮：策略要求的按钮缺失 → null（诚实 no_target，绝不改点另一个）。 */
function pickButton(det: FacebookConsentDetection, policy: FacebookConsentPolicy): FacebookConsentButton | null {
  if (policy === 'necessary_only') return det.necessaryOnly ?? null;
  return det.acceptAll ?? null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 探到同意条则拟人接受，点后复探确认清除；有界重试；诚实回执。
 * 返回 handled=false 表示无同意条（调用方照常继续）。
 */
export async function acceptFacebookConsent(
  cdp: BrowseCdp,
  options: AcceptFacebookConsentOptions = {},
): Promise<FacebookConsentResult> {
  const policy = options.policy ?? 'accept_all';
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const settleMs = options.settleMs ?? 700;
  const sleep = options.sleep ?? defaultSleep;
  const detect = options.detect ?? detectFacebookConsent;
  // 默认走既有拟人点击（内建鼠标路径 + 落点抖动 + 偶发 overshoot）。
  const click = options.click ?? ((c: BrowseCdp, x: number, y: number) => dispatchClick(c, x, y));
  const log = options.logger ?? (() => {});

  let det: FacebookConsentDetection;
  try {
    det = await detect(cdp);
  } catch (err) {
    // 探测失败：不假设有同意条、也不假成功——当作无同意条让既有闸继续处置。
    log(`[fb-consent] detect failed: ${(err as Error).message}`);
    return { handled: false, cleared: false, attempts: 0 };
  }
  if (!det.present) return { handled: false, cleared: false, attempts: 0 };

  let attempts = 0;
  let current = det;
  while (attempts < maxAttempts) {
    const btn = pickButton(current, policy);
    if (!btn) {
      // 认出同意条但策略所需按钮定位失败（文案/布局漂移）——诚实 no_target，绝不乱点。
      log(`[fb-consent] accept button not found for policy=${policy}`);
      return { handled: true, cleared: false, attempts, reason: 'no_target' };
    }
    attempts++;
    try {
      await click(cdp, btn.x, btn.y);
    } catch (err) {
      log(`[fb-consent] click failed: ${(err as Error).message}`);
      return { handled: true, cleared: false, attempts, reason: 'blocked_by_consent' };
    }
    await sleep(settleMs);
    try {
      current = await detect(cdp);
    } catch (err) {
      log(`[fb-consent] re-probe failed: ${(err as Error).message}`);
      return { handled: true, cleared: false, attempts, reason: 'blocked_by_consent' };
    }
    if (!current.present) return { handled: true, cleared: true, attempts };
  }
  // 到上限仍在——停手升级，绝不静默假成功。
  return { handled: true, cleared: false, attempts, reason: 'blocked_by_consent' };
}

export type FacebookConsentAccepter = (cdp: BrowseCdp) => Promise<FacebookConsentResult>;

/** 便捷工厂：绑定 env 策略，供执行器默认注入。 */
export function defaultFacebookConsentAccepter(
  env: Record<string, string | undefined> = process.env,
): FacebookConsentAccepter {
  const policy = facebookConsentPolicyFromEnv(env);
  return (cdp: BrowseCdp) => acceptFacebookConsent(cdp, { policy });
}
