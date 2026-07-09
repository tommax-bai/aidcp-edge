import { evalRaw, type BrowseCdp } from '../browse/cdp-util.js';
import type { ReadSelfIdentityOptions, SelfIdentityResult } from '../cdp/self-identity.js';

export const FACEBOOK_NUMERIC_ID_RE = /^\d{5,}$/;

interface FacebookCookieLike {
  name?: string;
  value?: string;
  domain?: string;
}

export interface FacebookIdentitySignals {
  href: string;
  profileHrefs: string[];
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
  '首页',
  '主页',
  '个人主页',
  '登录',
  '注册',
]);

export function cleanFacebookDisplayName(value: string | null | undefined): string | null {
  let s = String(value ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*[|｜]\s*Facebook(?:\s*[-–—]\s*.*)?$/i, '').trim();
  s = s.replace(/\s*[-–—]\s*Facebook(?:\s*[-–—]\s*.*)?$/i, '').trim();
  s = s.replace(/\s*[·•]\s*Facebook$/i, '').trim();
  if (/^facebook\s*[-–—]\s*(log in|login|sign up|signup|登录|注册)/i.test(s)) return null;
  if (GENERIC_FACEBOOK_DISPLAY_NAMES.has(s.toLowerCase())) return null;
  return s || null;
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
  const displayName = firstDisplayNameCandidate([signals.displayName, signals.h1, signals.ogTitle, signals.title]);

  if (locationId) {
    if (cookieUserId && cookieUserId !== locationId) {
      return { ok: false, reason: 'facebook identity cookie/profile mismatch' };
    }
    return {
      ok: true,
      accountId: locationId,
      displayName: firstDisplayNameCandidate([signals.h1, signals.ogTitle, signals.title, signals.displayName]),
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
      displayName,
      source: profileId ? 'cookie+profile-link' : 'cookie',
    };
  }
  if (profileId) {
    return {
      ok: true,
      accountId: profileId,
      displayName,
      source: 'profile-link',
    };
  }
  if (displayName) {
    return { ok: false, reason: 'facebook display name is present but no stable numeric id candidate was found' };
  }
  return { ok: false, reason: 'facebook stable numeric id candidate was not found' };
}

const FACEBOOK_IDENTITY_SCAN_JS = `(function(){
  function attr(el, name){ return el && el.getAttribute ? (el.getAttribute(name) || '') : ''; }
  function text(el){ return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  var hrefs = [];
  var anchors = document.querySelectorAll('a[href*="profile.php?id="],a[href*="/people/"]');
  for (var i = 0; i < anchors.length && hrefs.length < 20; i++) {
    var h = attr(anchors[i], 'href');
    if (h) hrefs.push(h);
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
    displayName: menuName,
    h1: text(mainH1) || null,
    ogTitle: og ? attr(og, 'content') || null : null,
    title: document.title || null
  });
})()`;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalizeFacebookIdentitySignals(raw: FacebookIdentitySignals, cookieUserId: string | null): FacebookIdentitySignals {
  const profileHrefs = Array.isArray(raw.profileHrefs) ? raw.profileHrefs.filter((href): href is string => typeof href === 'string') : [];
  return {
    href: typeof raw.href === 'string' ? raw.href : '',
    profileHrefs,
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

export async function readFacebookIdentity(
  cdp: BrowseCdp,
  opts: ReadSelfIdentityOptions = {},
): Promise<SelfIdentityResult> {
  const log = opts.logger ?? (() => undefined);
  const sleep = opts.sleep ?? defaultSleep;
  const allowNavigate = opts.allowNavigate ?? true;
  const navTimeout = opts.navigateTimeoutMs ?? 4000;

  const cookie = await readFacebookCookieUserId(cdp);
  if (!cookie.ok) {
    log(`[facebook-identity] ${cookie.reason}`);
    return { ok: false, reason: cookie.reason };
  }

  const signals = await scanFacebookIdentitySignals(cdp, cookie.accountId);
  if (!signals) {
    return { ok: false, reason: 'facebook identity scan returned invalid JSON' };
  }
  let derived = deriveFacebookIdentity(signals);
  if (!derived.ok) {
    log(`[facebook-identity] ${derived.reason}`);
    return { ok: false, reason: derived.reason };
  }
  if (!derived.displayName && allowNavigate) {
    try {
      await cdp.send('Page.navigate', { url: 'https://www.facebook.com/me' });
      await sleep(navTimeout);
      const profileSignals = await scanFacebookIdentitySignals(cdp, cookie.accountId);
      if (profileSignals) {
        const profileDerived = deriveFacebookIdentity(profileSignals);
        if (profileDerived.ok) {
          if (profileDerived.accountId !== derived.accountId) {
            const reason = `facebook /me identity mismatch: expected ${derived.accountId}, got ${profileDerived.accountId}`;
            log(`[facebook-identity] ${reason}`);
            return { ok: false, reason };
          }
          if (profileDerived.displayName) derived = { ...derived, displayName: profileDerived.displayName };
        } else {
          log(`[facebook-identity] /me nickname probe skipped: ${profileDerived.reason}`);
        }
      } else {
        log('[facebook-identity] /me nickname probe returned invalid JSON');
      }
    } catch (err) {
      log(`[facebook-identity] /me nickname probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    ok: true,
    identity: {
      accountId: derived.accountId,
      displayName: derived.displayName,
      redId: null,
      source: selfIdentitySource(derived.source),
    },
  };
}
