import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectFacebookFingerprintSummary,
  collectFacebookStorageSummary,
  summarizeCookies,
  summarizeStorageNames,
} from '../../src/facebook/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

function fakeCdpForProbes(): BrowseCdp {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Network.getAllCookies') {
        return {
          cookies: [
            {
              name: 'c_user',
              value: '1234567890',
              domain: '.facebook.com',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'Lax',
              expires: 1999999999,
            },
            {
              name: 'xs',
              value: 'SECRET_SESSION_TOKEN_SHOULD_NOT_LEAK',
              domain: '.facebook.com',
              path: '/',
              secure: true,
              httpOnly: true,
            },
          ],
        } as never;
      }
      const expression = String(params?.expression ?? '');
      if (expression.includes('indexedDB')) {
        return {
          result: {
            value: JSON.stringify({
              href: 'https://www.facebook.com/',
              localStorage: { count: 3, keys: ['presence', 'USER_SETTINGS', 'falco_queue_hmac_ttl.SECRET_KEY_SHOULD_NOT_LEAK'] },
              sessionStorage: { count: 1, keys: ['tabId'] },
              indexedDB: { count: 2, names: ['Comet', 'Messenger'] },
              cacheStorage: { count: 0, names: [] },
            }),
          },
        } as never;
      }
      return {
        result: {
          value: JSON.stringify({
            href: 'https://www.facebook.com/',
            viewport: { width: 430, height: 932, devicePixelRatio: 3 },
            language: 'zh-CN',
            languagesCount: 2,
            timezone: 'Asia/Shanghai',
            webdriverExposed: false,
            pluginsLength: 3,
          }),
        },
      } as never;
    },
  };
}

test('summarizeCookies: redacts cookie values by construction', () => {
  const out = summarizeCookies([{ name: 'xs', value: 'SECRET_VALUE', domain: '.facebook.com', path: '/' }]);
  assert.deepEqual(out, [{
    name: 'xs',
    domain: '.facebook.com',
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: null,
    hasExpiry: false,
    valueLengthBucket: 'short',
  }]);
  assert.equal(JSON.stringify(out).includes('SECRET_VALUE'), false);
});

test('collectFacebookStorageSummary: output contains no raw cookie/storage values', async () => {
  const summary = await collectFacebookStorageSummary(fakeCdpForProbes());
  const serialized = JSON.stringify(summary);
  assert.equal(summary.cookies.length, 2);
  assert.equal(summary.localStorage.count, 3);
  assert.equal(summary.localStorage.entries.length, 3);
  assert.equal(serialized.includes('SECRET_SESSION_TOKEN_SHOULD_NOT_LEAK'), false);
  assert.equal(serialized.includes('SECRET_KEY_SHOULD_NOT_LEAK'), false);
  assert.equal(serialized.includes('1234567890'), false);
  assert.equal(serialized.includes('presence'), false);
  assert.equal(serialized.includes('USER_SETTINGS'), false);
});

test('summarizeStorageNames: redacts storage keys and flags risky shapes', () => {
  const out = summarizeStorageNames(['presence', 'falco_queue_hmac_ttl.SECRET_KEY_SHOULD_NOT_LEAK']);
  const serialized = JSON.stringify(out);
  assert.equal(out.length, 2);
  assert.equal(out[0].nameHash.length, 16);
  assert.equal(out[1].tokenLike, true);
  assert.equal(serialized.includes('presence'), false);
  assert.equal(serialized.includes('SECRET_KEY_SHOULD_NOT_LEAK'), false);
});

test('collectFacebookFingerprintSummary: reports safe non-secret provider/page summary', async () => {
  const summary = await collectFacebookFingerprintSummary(fakeCdpForProbes(), {
    providerKind: 'adspower',
    stealth: false,
  });
  assert.equal(summary.providerKind, 'adspower');
  assert.equal(summary.stealth, false);
  assert.equal(summary.viewport.width, 430);
  assert.equal(summary.language, 'zh-CN');
  assert.equal(summary.webdriverExposed, false);
});
