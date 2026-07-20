import { evalRaw, type BrowseCdp } from '../browse/cdp-util.js';
import type { PageContext, ReadSelfIdentityOptions, SelfIdentity, SelfIdentityResult } from '../cdp/self-identity.js';

export const FACEBOOK_NUMERIC_ID_RE = /^\d{5,}$/;

interface FacebookCookieLike {
  name?: string;
  value?: string;
  domain?: string;
}

/** 本人 profile 锚点——aria 与可见文本都只能在 href 先绑定本人 id 后作为昵称候选。 */
export interface FacebookProfileAnchor {
  href: string;
  ariaLabel: string | null;
  textContent?: string | null;
}

export interface FacebookIdentitySignals {
  href: string;
  profileHrefs: string[];
  /** 本人/他人 profile 锚点及其标签/可见文本（就地 id 锚定取昵称用；缺省空数组）。 */
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
  'your timeline',
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
  'trang cá nhân',
  'trang cá nhân của bạn',
  'dòng thời gian của bạn',
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

/**
 * 本人自链 aria-label 的多语后缀：仅当命中才认定这是「本人主页/头像自链标签」、剥离后取名；否则不信为昵称。
 * 覆盖两类本人自链后缀：
 *  - 头像后缀：的头像 / 的大头像 / 的大頭貼 / 's profile picture|photo|avatar
 *  - 时间线后缀：的时间线 / 的時間線 / 's timeline —— 中文界面下个人主页链接常用「<名>的时间线」而非「<名>的头像」
 *    （change facebook-nickname-aria-timeline-suffix：真机中文号「Nancy Terry的时间线」曾因此读空）。
 */
const AVATAR_ARIA_SUFFIX_RE = /\s*(?:的大?头像|的大頭貼|的时间线|的時間線|['’‘]s\s+(?:profile picture|profile photo|avatar|timeline))\s*$/i;

/**
 * 从本人 profile 自链锚点的 aria-label 提取昵称（纯函数）。
 * 仅当 aria 含已知本人自链后缀（头像 / 's profile picture / 时间线 / 's timeline）时才剥后缀取名——
 * 无后缀的 aria（如「你的个人主页」）一律返回 null，避免把通用外壳标签误当昵称。
 * 剥后结果再过 cleanFacebookDisplayName（拒 Facebook/(N) Facebook/通用词）。
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
 * 从本人 profile 锚点集里按 id 锚定取昵称（纯函数）：
 * 先取可安全解析的 aria 本人标签；本地化 aria 未覆盖时，再取同一个本人锚点的可见文本。
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
    const name = extractNameFromAvatarAria(a.ariaLabel) ?? cleanFacebookDisplayName(a.textContent);
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

  // 非本人主页页（首页/信息流/群/详情等）：c_user cookie 是登录态【权威】数字自我 id。
  // 在场即以其为准——按 id 锚定取本人昵称；页面上其他用户的 profile 链接（帖子作者/评论者/群成员）
  // 与自我 id 确立无关，MUST NOT 计入候选、MUST NOT 触发 conflict。id 锚定保证绝不把他人名字当自己
  // （读到别人链接 → avatarNameForId 不匹配 → 留空、id 仍取 cookie）。
  // change facebook-self-identity-cookie-authoritative：采集时机迁到「首批 feed 卡片」后，feed 上必有
  // 他人 profile.php?id= 链接，旧的 unique.length>1 会把他人链接误判成自我 id 候选冲突 → 读身份失败 → 昵称空。
  if (cookieUserId) {
    return {
      ok: true,
      accountId: cookieUserId,
      displayName: nameForId(cookieUserId, false),
      source: unique.includes(cookieUserId) ? 'cookie+profile-link' : 'cookie',
    };
  }
  // 无权威 cookie：只能靠页面 profile 链接确立 id —— 此时多个互异候选才是真歧义，诚实失败。
  if (unique.length > 1) return { ok: false, reason: `facebook identity candidates conflict: ${unique.join(',')}` };
  const profileId = unique[0] ?? null;
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
    profileAnchors.push({
      href: h,
      ariaLabel: attr(anchors[i], 'aria-label') || null,
      textContent: text(anchors[i]) || null
    });
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
        .map((a) => ({
          href: a.href,
          ariaLabel: typeof a.ariaLabel === 'string' ? a.ariaLabel : null,
          textContent: typeof a.textContent === 'string' ? a.textContent : null,
        }))
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
  let raw = '';
  try {
    raw = await evalRaw<string>(cdp, FACEBOOK_IDENTITY_SCAN_JS);
  } catch {
    // Page.navigate / React 重载期间 Runtime execution context 可短暂销毁；交给有界重扫，而不是把首读炸断。
    return null;
  }
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
 * - 昵称：在 Facebook 页内按本人 id 锚定读取 aria/可见文本，**绝不导航 /me/profile**、非本人主页不取页面标题。
 * - 仅显式 allowNavigate=true 且当前 tab 明确非 Facebook 时，可启动引导一次首页；运行期调用必须传 false。
 * - 昵称随顶栏异步渲染 → 按次数上界轮询；耗尽仍无 → 诚实以空昵称返回（不阻断身份、不猜）。
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

  // 先拿当前页信号，显式允许启动导航且 tab 仍是 about:blank/非 Facebook 时，才一次性引导到消费端首页。
  // 这是启动页面 bootstrap，不是去 /me/profile 取昵称；所有运行期调用必须传 allowNavigate=false。
  let firstSignals = await scanFacebookIdentitySignals(cdp, cookie.accountId);
  const initialHref = firstSignals?.href ||
    (opts.allowNavigate === true ? await evalRaw<string>(cdp, 'location.href').catch(() => '') : '');
  // Runtime 扫描失败不等于“已证明在非 Facebook 页”；只有拿到明确 href 且确属 unknown 才允许 bootstrap。
  if (opts.allowNavigate === true && initialHref && classifyFacebookIdentityPageContext(initialHref) === 'unknown') {
    try {
      log(`[facebook-identity] 当前 tab 非 Facebook 页面（${initialHref}）→ 启动引导首页后再采集昵称`);
      await cdp.send('Page.navigate', { url: 'https://www.facebook.com/' });
      firstSignals = null; // 导航前 about:blank 信号绝不参与导航后的昵称成功判定。
      if (hydrateTimeoutMs > 0) await sleep(hydrateIntervalMs);
    } catch (err) {
      log(`[facebook-identity] 启动引导 Facebook 首页失败：${(err as Error).message} → 保留就地有界读取`);
    }
  }

  // 有界重试：在 Facebook 页面内始终就地读；昵称随顶栏异步渲染，按【次数上界】轮询等它出现。
  // 用迭代次数限界（不依赖 now() 前进——单测常注入恒定假时钟，靠 deadline 会死循环）。
  const attempts = Math.max(1, Math.ceil(hydrateTimeoutMs / Math.max(1, hydrateIntervalMs)) + 1);
  let lastReason = 'facebook identity scan returned invalid JSON';
  let bestIdentity: SelfIdentity | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const signals = firstSignals ?? (await scanFacebookIdentitySignals(cdp, cookie.accountId));
    firstSignals = null;
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
