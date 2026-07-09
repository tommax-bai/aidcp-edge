import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFacebookIdentity,
  extractFacebookIdFromHref,
  readFacebookIdentity,
  type FacebookIdentitySignals,
} from '../../src/facebook/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

function fakeCdp(raw: string, cookies: Array<{ name?: string; value?: string; domain?: string }> = []): BrowseCdp {
  return {
    send: async (method: string) => {
      if (method === 'Network.getAllCookies') return { cookies } as never;
      return { result: { value: raw } } as never;
    },
  };
}

test('extractFacebookIdFromHref: accepts numeric profile.php and /people ids only', () => {
  assert.equal(extractFacebookIdFromHref('https://www.facebook.com/profile.php?id=1234567890'), '1234567890');
  assert.equal(extractFacebookIdFromHref('/people/Test-User/1234567890/'), '1234567890');
  assert.equal(extractFacebookIdFromHref('https://www.facebook.com/some.vanity.name'), '');
  assert.equal(extractFacebookIdFromHref(null), '');
});

test('deriveFacebookIdentity: stable numeric id succeeds with optional display name', () => {
  const signals: FacebookIdentitySignals = {
    href: 'https://www.facebook.com/',
    profileHrefs: ['https://www.facebook.com/profile.php?id=1234567890'],
    cookieUserId: null,
    displayName: ' Test User ',
  };
  assert.deepEqual(deriveFacebookIdentity(signals), {
    ok: true,
    accountId: '1234567890',
    displayName: 'Test User',
    source: 'profile-link',
  });
});

test('deriveFacebookIdentity: display name alone is rejected', () => {
  const res = deriveFacebookIdentity({ href: 'https://www.facebook.com/', profileHrefs: [], cookieUserId: null, displayName: 'Test User' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /display name/);
});

test('deriveFacebookIdentity: c_user cookie succeeds when profile link is not rendered yet', () => {
  assert.deepEqual(
    deriveFacebookIdentity({
      href: 'https://www.facebook.com/',
      profileHrefs: [],
      cookieUserId: '1234567890',
      displayName: 'Test User',
    }),
    {
      ok: true,
      accountId: '1234567890',
      displayName: 'Test User',
      source: 'cookie',
    },
  );
});

test('deriveFacebookIdentity: matching c_user and profile link succeeds', () => {
  assert.deepEqual(
    deriveFacebookIdentity({
      href: 'https://www.facebook.com/',
      profileHrefs: ['https://www.facebook.com/profile.php?id=1234567890'],
      cookieUserId: '1234567890',
      displayName: null,
    }),
    {
      ok: true,
      accountId: '1234567890',
      displayName: null,
      source: 'cookie+profile-link',
    },
  );
});

test('deriveFacebookIdentity: mismatched c_user and profile link fails honestly', () => {
  const res = deriveFacebookIdentity({
    href: 'https://www.facebook.com/',
    profileHrefs: ['https://www.facebook.com/profile.php?id=1234567890'],
    cookieUserId: '9876543210',
    displayName: 'Test User',
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /mismatch/);
});

test('deriveFacebookIdentity: conflicting stable candidates are rejected', () => {
  const res = deriveFacebookIdentity({
    href: 'https://www.facebook.com/',
    profileHrefs: [
      'https://www.facebook.com/profile.php?id=1234567890',
      'https://www.facebook.com/people/Test-User/9876543210/',
    ],
    cookieUserId: null,
    displayName: 'Test User',
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /conflict/);
});

test('readFacebookIdentity: invalid JSON fails honestly', async () => {
  const res = await readFacebookIdentity(fakeCdp('{bad-json'));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /invalid JSON/);
});

test('readFacebookIdentity: returns SelfIdentityResult with stable id', async () => {
  const res = await readFacebookIdentity(
    fakeCdp(JSON.stringify({
      href: 'https://www.facebook.com/',
      profileHrefs: ['https://www.facebook.com/profile.php?id=1234567890'],
      displayName: 'Test User',
    })),
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.accountId, '1234567890');
    assert.equal(res.identity.displayName, 'Test User');
    assert.equal(res.identity.source, 'in-place');
  }
});

test('readFacebookIdentity: c_user cookie supplies id before profile link renders', async () => {
  const res = await readFacebookIdentity(
    fakeCdp(
      JSON.stringify({
        href: 'https://www.facebook.com/',
        profileHrefs: [],
        displayName: 'Test User',
      }),
      [{ name: 'c_user', value: '1234567890', domain: '.facebook.com' }],
    ),
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.accountId, '1234567890');
    assert.equal(res.identity.displayName, 'Test User');
    assert.equal(res.identity.source, 'facebook-cookie');
  }
});

test('readFacebookIdentity: non-numeric c_user is ignored and does not replace stable profile link', async () => {
  const res = await readFacebookIdentity(
    fakeCdp(
      JSON.stringify({
        href: 'https://www.facebook.com/',
        profileHrefs: ['https://www.facebook.com/profile.php?id=1234567890'],
        displayName: 'Test User',
      }),
      [{ name: 'c_user', value: 'not-numeric', domain: '.facebook.com' }],
    ),
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.accountId, '1234567890');
    assert.equal(res.identity.source, 'in-place');
  }
});

test('readFacebookIdentity: conflicting c_user cookies fail without logging cookie values', async () => {
  const logs: string[] = [];
  const res = await readFacebookIdentity(
    fakeCdp(
      JSON.stringify({
        href: 'https://www.facebook.com/',
        profileHrefs: [],
        displayName: null,
      }),
      [
        { name: 'c_user', value: '1234567890', domain: '.facebook.com' },
        { name: 'c_user', value: '9876543210', domain: 'www.facebook.com' },
      ],
    ),
    { logger: (msg) => logs.push(msg) },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /c_user cookie candidates conflict/);
  assert.equal(logs.some((line) => line.includes('1234567890') || line.includes('9876543210')), false);
});
