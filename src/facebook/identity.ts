import { evalRaw, type BrowseCdp } from '../browse/cdp-util.js';
import type { SelfIdentityResult } from '../cdp/self-identity.js';

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
}

export type FacebookIdentityDerivation =
  | { ok: true; accountId: string; displayName: string | null; source: 'cookie' | 'profile-link' | 'cookie+profile-link' }
  | { ok: false; reason: string };

export function extractFacebookIdFromHref(href: string | null | undefined): string {
  if (!href) return '';
  let url: URL;
  try {
    url = new URL(href, 'https://www.facebook.com');
  } catch {
    return '';
  }
  const profileId = url.searchParams.get('id');
  if (profileId && FACEBOOK_NUMERIC_ID_RE.test(profileId)) return profileId;
  const peopleMatch = url.pathname.match(/\/people\/[^/]+\/(\d{5,})(?:\/|$)/i);
  if (peopleMatch) return peopleMatch[1];
  return '';
}

function cleanDisplayName(value: string | null | undefined): string | null {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
}

export function deriveFacebookIdentity(signals: FacebookIdentitySignals): FacebookIdentityDerivation {
  const cookieUserId = FACEBOOK_NUMERIC_ID_RE.test(signals.cookieUserId ?? '') ? signals.cookieUserId : null;
  const ids = signals.profileHrefs
    .map(extractFacebookIdFromHref)
    .filter(Boolean);
  const unique = Array.from(new Set(ids));
  if (unique.length > 1) return { ok: false, reason: `facebook identity candidates conflict: ${unique.join(',')}` };
  const profileId = unique[0] ?? null;
  if (cookieUserId && profileId && cookieUserId !== profileId) {
    return { ok: false, reason: 'facebook identity cookie/profile mismatch' };
  }
  if (cookieUserId) {
    return {
      ok: true,
      accountId: cookieUserId,
      displayName: cleanDisplayName(signals.displayName),
      source: profileId ? 'cookie+profile-link' : 'cookie',
    };
  }
  if (profileId) {
    return {
      ok: true,
      accountId: profileId,
      displayName: cleanDisplayName(signals.displayName),
      source: 'profile-link',
    };
  }
  if (cleanDisplayName(signals.displayName)) {
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
  return JSON.stringify({ href: location.href, profileHrefs: hrefs, displayName: menuName });
})()`;

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

export async function readFacebookIdentity(
  cdp: BrowseCdp,
  opts: { logger?: (msg: string) => void } = {},
): Promise<SelfIdentityResult> {
  const cookie = await readFacebookCookieUserId(cdp);
  if (!cookie.ok) {
    opts.logger?.(`[facebook-identity] ${cookie.reason}`);
    return { ok: false, reason: cookie.reason };
  }
  const raw = await evalRaw<string>(cdp, FACEBOOK_IDENTITY_SCAN_JS);
  let signals: FacebookIdentitySignals;
  try {
    signals = { ...(JSON.parse(raw) as FacebookIdentitySignals), cookieUserId: cookie.accountId };
  } catch {
    return { ok: false, reason: 'facebook identity scan returned invalid JSON' };
  }
  const derived = deriveFacebookIdentity(signals);
  if (!derived.ok) {
    opts.logger?.(`[facebook-identity] ${derived.reason}`);
    return { ok: false, reason: derived.reason };
  }
  return {
    ok: true,
    identity: {
      accountId: derived.accountId,
      displayName: derived.displayName,
      redId: null,
      source: derived.source === 'profile-link' ? 'in-place' : 'facebook-cookie',
    },
  };
}
