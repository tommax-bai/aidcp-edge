import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFacebookIdentity,
  extractFacebookIdFromHref,
  readFacebookIdentity,
  type FacebookIdentitySignals,
} from '../../src/facebook/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

function fakeCdp(raw: string): BrowseCdp {
  return {
    send: async () => ({ result: { value: raw } }) as never,
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
  const res = deriveFacebookIdentity({ href: 'https://www.facebook.com/', profileHrefs: [], displayName: 'Test User' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /display name/);
});

test('deriveFacebookIdentity: conflicting stable candidates are rejected', () => {
  const res = deriveFacebookIdentity({
    href: 'https://www.facebook.com/',
    profileHrefs: [
      'https://www.facebook.com/profile.php?id=1234567890',
      'https://www.facebook.com/people/Test-User/9876543210/',
    ],
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
