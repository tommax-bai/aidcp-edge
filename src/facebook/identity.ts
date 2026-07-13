import { evalRaw, type BrowseCdp } from '../browse/cdp-util.js';
import type { PageContext, ReadSelfIdentityOptions, SelfIdentity, SelfIdentityResult } from '../cdp/self-identity.js';

export const FACEBOOK_NUMERIC_ID_RE = /^\d{5,}$/;

interface FacebookCookieLike {
  name?: string;
  value?: string;
  domain?: string;
}

/** 本人 profile 锚点（含 aria-label）——用于 id 锚定就地取昵称（顶栏头像锚点 aria 形如「<昵称>的头像」）。 */
export interface FacebookProfileAnchor {
  href: string;
  ariaLabel: string | null;
}

export interface FacebookIdentitySignals {
  href: string;
  profileHrefs: string[];
  /** 本人/他人 profile 锚点及其 aria-label（就地 id 锚定取昵称用；缺省空数组）。 */
  profileAnchors?: FacebookProfileAnchor[];
  cookieUserId: string | null;
  displayName: string | null;
  h1?: string | null;
  ogTitle?: string | null;
  title?: string | null;
}

export type FacebookIdentityDerivation =
  | {
      ok: true;
      accountId: string;
      displayName: string | null;
      source: 'cookie' | 'profile-link' | 'profile-url' | 'cookie+profile-link' | 'cookie+profile-url';
    }
  | { ok: false; reason: string };

type FacebookIdentitySource = Extract<FacebookIdentityDerivation, { ok: true }>['source'];

export function extractFacebookIdFromHref(href: string | null | undefined): string {
  if (!href) return '';
  let url: URL;
  try {
    url = new URL(href, 'https://www.facebook.com');
  } catch {
    return '';
  }
  const profileId = url.searchParams.get('id');
  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (profileId && path.endsWith('/profile.php') && FACEBOOK_NUMERIC_ID_RE.test(profileId)) return profileId;
  const peopleMatch = url.pathname.match(/\/people\/[^/]+\/(\d{5,})(?:\/|$)/i);
  if (peopleMatch) return peopleMatch[1];
  return '';
}

const GENERIC_FACEBOOK_DISPLAY_NAMES = new Set([
  'facebook',
  'home',
  'profile',
  'your profile',
  'log in',
  'login',
  'sign up',
  'create new account',
  'account controls and settings',
  'menu',
  'marketplace',
  '首页',
  '主页',
  '个人主页',
  '你的个人主页',
  '账户控制选项和设置',
  '帐户控制选项和设置',
  '菜单',
  '登录',
  '注册',
]);

export function cleanFacebookDisplayName(value: string | null | undefined): string | null {
  let s = String(value ?? '').replace(/\s+/g, ' ').trim();
  // 先剥前导未读计数前缀「(4) 」，防「(4) Facebook」这类标签栏标题穿过清洗被当昵称。
  s = s.replace(/^\(\d+\)\s*/, '').trim();
  s = s.replace(/\s*[|｜]\s*Facebook(?:\s*[-–—]\s*.*)?$/i, '').trim();
  s = s.replace(/\s*[-–—]\s*Facebook(?:\s*[-–—]\s*.*)?$/i, '').trim();
  s = s.replace(/\s*[·•]\s*Facebook$/i, '').trim();
  if (/^facebook\s*[-–—]\s*(log in|login|sign up|signup|登录|注册)/i.test(s)) return null;
  if (GENERIC_FACEBOOK_DISPLAY_NAMES.has(s.toLowerCase())) return null;
  return s || null;
}

/** 头像 aria-label 的多语后缀：仅当命中才认定这是「头像标签」、剥离后取名；否则不信为昵称。 */
const AVATAR_ARIA_SUFFIX_RE = /\s*(?:的大?头像|的大頭貼|['’‘]s\s+(?:profile picture|profile photo|avatar))\s*$/i;

/**
 * 从本人头像锚点的 aria-label 提取昵称（纯函数）。
 * 仅当 aria 含已知「头像 / 's profile picture」后缀时才剥后缀取名——无后缀的 aria（如「你的个人主页」）一律返回 null，
 * 避免把通用外壳标签误当昵称。剥后结果再过 cleanFacebookDisplayName（拒 Facebook/(N) Facebook/通用词）。
 */
export function extractNameFromAvatarAria(aria: string | null | undefined): string | null {
  const s = String(aria ?? '').replace(/\s+/g, ' ').trim();
  if (!s || !AVATAR_ARIA_SUFFIX_RE.test(s)) return null;
  const name = s.replace(AVATAR_ARIA_SUFFIX_RE, '').trim();
  return cleanFacebookDisplayName(name);
}

/** 本人头像锚点判据：href 数字 id === accountId，或 href 为 /me 自链（无 id 但确为本人）。纯函数。 */
function isSelfProfileHref(href: string, accountId: string): boolean {
  if (extractFacebookIdFromHref(href) === accountId) return true;
  try {
    const path = new URL(href, 'https://www.facebook.com').pathname.replace(/\/+$/, '').toLowerCase();
    return path === '/me';
  } catch {
    return false;
  }
}

/**
 * 从本人 profile 锚点集里按 id 锚定取昵称（纯函数）：取首个「是本人（id 匹配或 /me） & aria 含头像后缀」的名字。
 * id 锚定 ⇒ 绝不把他人/他页锚点的名字当作本账号昵称。
 */
export function avatarNameForId(
  anchors: FacebookProfileAnchor[] | undefined,
  accountId: string,
): string | null {
  if (!anchors || !accountId) return null;
  for (const a of anchors) {
    if (!a || typeof a.href !== 'string') continue;
    if (!isSelfProfileHref(a.href, accountId)) continue;
    const name = extractNameFromAvatarAria(a.ariaLabel);
    if (name) return name;
  }
  return null;
}

function firstDisplayNameCandidate(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const cleaned = cleanFacebookDisplayName(value);
    if (cleaned) return cleaned;
  }
  return null;
}

export function deriveFacebookIdentity(signals: FacebookIdentitySignals): FacebookIdentityDerivation {
  const cookieUserId = FACEBOOK_NUMERIC_ID_RE.test(signals.cookieUserId ?? '') ? signals.cookieUserId : null;
  const locationId = extractFacebookIdFromHref(signals.href);
  const ids = signals.profileHrefs
    .map(extractFacebookIdFromHref)
    .filter(Boolean);
  const unique = Array.from(new Set(ids));

  // 上下文选昵称：
  //  - onOwnProfile=true（当前页就是本人主页，URL id === accountId）：页面标题/og/h1 就是本人姓名，可用；
  //  - onOwnProfile=false（首页/信息流/群页面等）：标题=页面名而非本人姓名，MUST NOT 用——只用 id 锚定头像标签 + 菜单文本。
  const nameForId = (accountId: string, onOwnProfile: boolean): string | null => {
    const avatarName = avatarNameForId(signals.profileAnchors, accountId);
    const candidates = onOwnProfile
      ? [avatarName, signals.h1, signals.ogTitle, signals.title, signals.displayName]
      : [avatarName, signals.displayName];
    return firstDisplayNameCandidate(candidates);
  };

  if (locationId) {
    if (cookieUserId && cookieUserId !== locationId) {
      return { ok: false, reason: 'facebook identity cookie/profile mismatch' };
    }
    return {
      ok: true,
      accountId: locationId,
      displayName: nameForId(locationId, true),
      source: cookieUserId ? 'cookie+profile-url' : 'profile-url',
    };
  }

  if (unique.length > 1) return { ok: false, reason: `facebook identity candidates conflict: ${unique.join(',')}` };
  const profileId = unique[0] ?? null;
  if (cookieUserId && profileId && cookieUserId !== profileId) {
    return { ok: false, reason: 'facebook identity cookie/profile mismatch' };
  }
  if (cookieUserId) {
    return {
      ok: true,
      accountId: cookieUserId,
      displayName: nameForId(cookieUserId, false),
      source: profileId ? 'cookie+profile-link' : 'cookie',
    };
  }
  if (profileId) {
    return {
      ok: true,
      accountId: profileId,
      displayName: nameForId(profileId, false),
      source: 'profile-link',
    };
  }
  const anyName = firstDisplayNameCandidate([signals.displayName, signals.h1, signals.ogTitle, signals.title]);
  if (anyName) {
    return { ok: false, reason: 'facebook display name is present but no stable numeric id candidate was found' };
  }
  return { ok: false, reason: 'facebook stable numeric id candidate was not found' };
}

const FACEBOOK_IDENTITY_SCAN_JS = `(function(){
  function attr(el, name){ return el && el.getAttribute ? (el.getAttribute(name) || '') : ''; }
  function text(el){ return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  var hrefs = [];
  var profileAnchors = [];
  // 顶栏头像自链一般是 profile.php?id=<自己>（其 aria-label 形如「<昵称>的头像」），/me 为其自链变体。
  var anchors = document.querySelectorAll('a[href*="profile.php?id="],a[href*="/people/"],a[href$="/me"],a[href*="/me/"]');
  for (var i = 0; i < anchors.length && profileAnchors.length < 30; i++) {
    var h = attr(anchors[i], 'href');
    if (!h) continue;
    profileAnchors.push({ href: h, ariaLabel: attr(anchors[i], 'aria-label') || null });
    // profileHrefs 只收 profile.php?id= / people（数字 id 派生输入，逐字保持既有行为，不含 /me）。
    var isProfileHref = h.indexOf('profile.php?id=') >= 0 || h.indexOf('/people/') >= 0;
    if (isProfileHref && hrefs.length < 20) hrefs.push(h);
  }
  var menuName = null;
  var labels = document.querySelectorAll('[aria-label]');
  for (var j = 0; j < labels.length; j++) {
    var a = attr(labels[j], 'aria-label');
    if (/^(你的个人主页|Your profile|个人主页|Profile)/i.test(a)) {
      menuName = text(labels[j]) || null;
      break;
    }
  }
  var og = document.querySelector('meta[property="og:title"],meta[name="og:title"]');
  var mainH1 = document.querySelector('[role="main"] h1') || document.querySelector('h1');
  return JSON.stringify({
    href: location.href,
    profileHrefs: hrefs,
    profileAnchors: profileAnchors,
    displayName: menuName,
    h1: text(mainH1) || null,
    ogTitle: og ? attr(og, 'content') || null : null,
    title: document.title || null
  });
})()`;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalizeFacebookIdentitySignals(raw: FacebookIdentitySignals, cookieUserId: string | null): FacebookIdentitySignals {
  const profileHrefs = Array.isArray(raw.profileHrefs) ? raw.profileHrefs.filter((href): href is string => typeof href === 'string') : [];
  const profileAnchors = Array.isArray(raw.profileAnchors)
    ? raw.profileAnchors
        .filter((a): a is FacebookProfileAnchor => !!a && typeof a.href === 'string')
        .map((a) => ({ href: a.href, ariaLabel: typeof a.ariaLabel === 'string' ? a.ariaLabel : null }))
    : [];
  return {
    href: typeof raw.href === 'string' ? raw.href : '',
    profileHrefs,
    profileAnchors,
    cookieUserId,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : null,
    h1: typeof raw.h1 === 'string' ? raw.h1 : null,
    ogTitle: typeof raw.ogTitle === 'string' ? raw.ogTitle : null,
    title: typeof raw.title === 'string' ? raw.title : null,
  };
}

async function readFacebookCookieUserId(cdp: BrowseCdp): Promise<{ ok: true; accountId: string | null } | { ok: false; reason: string }> {
  const cookieRes = await cdp.send<{ cookies?: FacebookCookieLike[] }>('Network.getAllCookies').catch(() => ({ cookies: [] }));
  const ids = (cookieRes.cookies ?? [])
    .filter((cookie) => cookie.name === 'c_user' && String(cookie.domain ?? '').includes('facebook.com'))
    .map((cookie) => String(cookie.value ?? '').trim())
    .filter((value) => FACEBOOK_NUMERIC_ID_RE.test(value));
  const unique = Array.from(new Set(ids));
  if (unique.length > 1) return { ok: false, reason: 'facebook c_user cookie candidates conflict' };
  return { ok: true, accountId: unique[0] ?? null };
}

async function scanFacebookIdentitySignals(cdp: BrowseCdp, cookieUserId: string | null): Promise<FacebookIdentitySignals | null> {
  const raw = await evalRaw<string>(cdp, FACEBOOK_IDENTITY_SCAN_JS);
  try {
    return normalizeFacebookIdentitySignals(JSON.parse(raw) as FacebookIdentitySignals, cookieUserId);
  } catch {
    return null;
  }
}

function selfIdentitySource(source: FacebookIdentitySource): 'in-place' | 'facebook-cookie' {
  return String(source).startsWith('cookie') ? 'facebook-cookie' : 'in-place';
}

export function classifyFacebookIdentityPageContext(href: string | null | undefined): PageContext {
  if (!href) return 'unknown';
  let host = '';
  let path = '';
  try {
    const url = new URL(href);
    host = url.hostname.toLowerCase();
    path = url.pathname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (!(host === 'facebook.com' || host.endsWith('.facebook.com'))) return 'unknown';
  if (/\/(login|recover|checkpoint|two_step_verification)(?:\/|$)/.test(path)) return 'creator-login';
  return 'consumer';
}

export async function readFacebookIdentityPageContext(cdp: BrowseCdp): Promise<PageContext> {
  const href = await evalRaw<string>(cdp, 'location.href').catch(() => '');
  return classifyFacebookIdentityPageContext(href);
}

/**
 * 读出 Facebook 登录账号身份（数字 id + 昵称）。
 * - 数字 id：cookie `c_user` / profile 锚点 / profile URL 锚定（逐字保持既有行为）。
 * - 昵称：**就地** id 锚定读取（本人头像锚点 aria-label「<昵称>的头像」），**绝不导航 /me**、非本人主页页不取页面标题。
 * - 昵称随顶栏异步渲染 → 按次数上界就地轮询等它出现；耗尽仍无 → 诚实以空昵称返回（不阻断身份、不猜、不导航）。
 */
export async function readFacebookIdentity(
  cdp: BrowseCdp,
  opts: ReadSelfIdentityOptions = {},
): Promise<SelfIdentityResult> {
  const log = opts.logger ?? (() => undefined);
  const sleep = opts.sleep ?? defaultSleep;
  const hydrateTimeoutMs = opts.hydrateTimeoutMs ?? 3000;
  const hydrateIntervalMs = opts.hydrateIntervalMs ?? 500;

  const cookie = await readFacebookCookieUserId(cdp);
  if (!cookie.ok) {
    log(`[facebook-identity] ${cookie.reason}`);
    return { ok: false, reason: cookie.reason };
  }

  // 就地有界重试（不导航）：昵称随顶栏异步渲染，按【次数上界】轮询等它出现。
  // 用迭代次数限界（不依赖 now() 前进——单测常注入恒定假时钟，靠 deadline 会死循环）。
  const attempts = Math.max(1, Math.ceil(hydrateTimeoutMs / Math.max(1, hydrateIntervalMs)) + 1);
  let lastReason = 'facebook identity scan returned invalid JSON';
  let bestIdentity: SelfIdentity | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const signals = await scanFacebookIdentitySignals(cdp, cookie.accountId);
    if (signals) {
      const derived = deriveFacebookIdentity(signals);
      if (derived.ok) {
        const identity: SelfIdentity = {
          accountId: derived.accountId,
          displayName: derived.displayName,
          redId: null,
          source: selfIdentitySource(derived.source),
        };
        if (derived.displayName) return { ok: true, identity };
        bestIdentity = identity; // id 已确立、昵称尚空 → 记为兜底，继续等昵称就地渲染
      } else {
        lastReason = derived.reason;
      }
    }
    if (attempt < attempts - 1) await sleep(hydrateIntervalMs);
  }
  if (bestIdentity) {
    log(`[facebook-identity] 就地读出 id=${bestIdentity.accountId}，昵称就地未读到 → 诚实留空（不再跳 /me）`);
    return { ok: true, identity: bestIdentity };
  }
  log(`[facebook-identity] ${lastReason}`);
  return { ok: false, reason: lastReason };
}
