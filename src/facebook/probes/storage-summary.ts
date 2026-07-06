import { createHash } from 'node:crypto';
import { evalRaw, type BrowseCdp } from '../../browse/cdp-util.js';

export interface RawCookieLike {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

export interface RedactedCookieSummary {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  hasExpiry: boolean;
  valueLengthBucket: 'empty' | 'short' | 'medium' | 'long';
}

export interface RedactedStorageNameSummary {
  nameHash: string;
  nameLengthBucket: 'empty' | 'short' | 'medium' | 'long';
  containsDigit: boolean;
  tokenLike: boolean;
}

export interface WebStorageAreaSummary {
  count: number;
  entries: RedactedStorageNameSummary[];
}

export interface IndexedDbSummary {
  count: number;
  entries: RedactedStorageNameSummary[];
}

export interface CacheStorageSummary {
  count: number;
  entries: RedactedStorageNameSummary[];
}

export interface FacebookStorageSummary {
  href: string;
  cookies: RedactedCookieSummary[];
  localStorage: WebStorageAreaSummary;
  sessionStorage: WebStorageAreaSummary;
  indexedDB: IndexedDbSummary;
  cacheStorage: CacheStorageSummary;
}

interface RawStorageSummary {
  href: string;
  localStorage: { count: number; keys: string[] };
  sessionStorage: { count: number; keys: string[] };
  indexedDB: { count: number; names: string[] };
  cacheStorage: { count: number; names: string[] };
}

function valueLengthBucket(value: string | undefined): RedactedCookieSummary['valueLengthBucket'] {
  const len = String(value ?? '').length;
  if (len === 0) return 'empty';
  if (len <= 16) return 'short';
  if (len <= 64) return 'medium';
  return 'long';
}

function nameLengthBucket(value: string | undefined): RedactedStorageNameSummary['nameLengthBucket'] {
  return valueLengthBucket(value);
}

function storageNameHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function summarizeStorageNames(names: string[]): RedactedStorageNameSummary[] {
  return names.map((name) => ({
    nameHash: storageNameHash(String(name ?? '')),
    nameLengthBucket: nameLengthBucket(name),
    containsDigit: /\d/.test(name),
    tokenLike: /token|secret|session|hmac|ttl|queue|persist|recovery|auth|key/i.test(name) || /[A-Za-z0-9_-]{24,}/.test(name),
  }));
}

export function summarizeCookies(cookies: RawCookieLike[]): RedactedCookieSummary[] {
  return cookies.map((c) => ({
    name: String(c.name ?? ''),
    domain: String(c.domain ?? ''),
    path: String(c.path ?? ''),
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite: c.sameSite ? String(c.sameSite) : null,
    hasExpiry: Number.isFinite(c.expires) && Number(c.expires) > 0,
    valueLengthBucket: valueLengthBucket(c.value),
  }));
}

const STORAGE_SCAN_JS = `(async function(){
  function keysOf(area){
    try { var out=[]; for(var i=0;i<area.length;i++) out.push(area.key(i)); return out.filter(Boolean).sort(); }
    catch(e){ return []; }
  }
  var idbNames = [];
  try {
    if (indexedDB && indexedDB.databases) {
      var dbs = await indexedDB.databases();
      idbNames = (dbs || []).map(function(d){ return d && d.name; }).filter(Boolean).sort();
    }
  } catch(e) {}
  var cacheNames = [];
  try {
    if (window.caches && caches.keys) cacheNames = (await caches.keys()).sort();
  } catch(e) {}
  var localKeys = keysOf(localStorage);
  var sessionKeys = keysOf(sessionStorage);
  return JSON.stringify({
    href: location.href,
    localStorage: { count: localKeys.length, keys: localKeys },
    sessionStorage: { count: sessionKeys.length, keys: sessionKeys },
    indexedDB: { count: idbNames.length, names: idbNames },
    cacheStorage: { count: cacheNames.length, names: cacheNames }
  });
})()`;

export async function collectFacebookStorageSummary(cdp: BrowseCdp): Promise<FacebookStorageSummary> {
  const cookieRes = await cdp.send<{ cookies?: RawCookieLike[] }>('Network.getAllCookies').catch(() => ({ cookies: [] }));
  const raw = await evalRaw<string>(cdp, STORAGE_SCAN_JS);
  const storage = JSON.parse(raw) as RawStorageSummary;
  return {
    href: storage.href,
    localStorage: {
      count: storage.localStorage.count,
      entries: summarizeStorageNames(storage.localStorage.keys),
    },
    sessionStorage: {
      count: storage.sessionStorage.count,
      entries: summarizeStorageNames(storage.sessionStorage.keys),
    },
    indexedDB: {
      count: storage.indexedDB.count,
      entries: summarizeStorageNames(storage.indexedDB.names),
    },
    cacheStorage: {
      count: storage.cacheStorage.count,
      entries: summarizeStorageNames(storage.cacheStorage.names),
    },
    cookies: summarizeCookies(cookieRes.cookies ?? []),
  };
}
