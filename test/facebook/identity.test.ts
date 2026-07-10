import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avatarNameForId,
  cleanFacebookDisplayName,
  deriveFacebookIdentity,
  extractFacebookIdFromHref,
  extractNameFromAvatarAria,
  readFacebookIdentity,
  type FacebookIdentitySignals,
} from '../../src/facebook/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

type CookieLike = { name?: string; value?: string; domain?: string };

function fakeCdp(raw: string, cookies: CookieLike[] = []): BrowseCdp {
  return {
    send: async (method: string) => {
      if (method === 'Network.getAllCookies') return { cookies } as never;
      return { result: { value: raw } } as never;
    },
  };
}

function fakeCdpSequence(
  raws: string[],
  cookies: CookieLike[] = [],
): { cdp: BrowseCdp; calls: Array<{ method: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    cdp: {
      send: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === 'Network.getAllCookies') return { cookies } as never;
        if (method === 'Runtime.evaluate') {
          const value = raws.shift() ?? '';
          return { result: { value } } as never;
        }
        return {} as never;
      },
    },
  };
}

test('extractFacebookIdFromHref: accepts numeric profile.php and /people ids only', () => {
  assert.equal(extractFacebookIdFromHref('https://www.facebook.com/profile.php?id=1234567890'), '1234567890');
  assert.equal(extractFacebookIdFromHref('/people/Test-User/1234567890/'), '1234567890');
  assert.equal(extractFacebookIdFromHref('https://www.facebook.com/story.php?id=1234567890'), '');
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

test('deriveFacebookIdentity: profile URL id wins over unrelated page profile links', () => {
  const signals: FacebookIdentitySignals = {
    href: 'https://www.facebook.com/profile.php?id=1234567890',
    profileHrefs: [
      'https://www.facebook.com/profile.php?id=1234567890',
      'https://www.facebook.com/profile.php?id=9876543210',
    ],
    cookieUserId: null,
    displayName: null,
    title: 'Test User | Facebook',
  };
  assert.deepEqual(deriveFacebookIdentity(signals), {
    ok: true,
    accountId: '1234567890',
    displayName: 'Test User',
    source: 'profile-url',
  });
});

test('deriveFacebookIdentity: generic Facebook profile titles are ignored', () => {
  const res = deriveFacebookIdentity({
    href: 'https://www.facebook.com/profile.php?id=1234567890',
    profileHrefs: [],
    cookieUserId: null,
    displayName: null,
    title: 'Facebook',
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.displayName, null);
});

test('deriveFacebookIdentity: display name alone is rejected', () => {
  const res = deriveFacebookIdentity({ href: 'https://www.facebook.com/', profileHrefs: [], cookieUserId: null, displayName: 'Test User' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /display name/);
});

test('cleanFacebookDisplayName: strips Facebook title suffixes and rejects generic labels', () => {
  assert.equal(cleanFacebookDisplayName(' Test User | Facebook '), 'Test User');
  assert.equal(cleanFacebookDisplayName('Facebook'), null);
  assert.equal(cleanFacebookDisplayName('Facebook - log in or sign up'), null);
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

test('deriveFacebookIdentity: matching c_user and profile URL succeeds with profile title nickname', () => {
  assert.deepEqual(
    deriveFacebookIdentity({
      href: 'https://www.facebook.com/profile.php?id=1234567890',
      profileHrefs: ['https://www.facebook.com/profile.php?id=1234567890'],
      cookieUserId: '1234567890',
      displayName: null,
      title: 'Test User | Facebook',
    }),
    {
      ok: true,
      accountId: '1234567890',
      displayName: 'Test User',
      source: 'cookie+profile-url',
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
  const res = await readFacebookIdentity(fakeCdp('{bad-json'), { hydrateTimeoutMs: 0 });
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

test('readFacebookIdentity: reads nickname in-place from the id-anchored avatar aria, never navigates', async () => {
  const { cdp, calls } = fakeCdpSequence(
    [
      JSON.stringify({
        href: 'https://www.facebook.com/',
        profileHrefs: ['https://www.facebook.com/profile.php?id=1234567890'],
        profileAnchors: [
          { href: 'https://www.facebook.com/profile.php?id=1234567890', ariaLabel: 'Test User的头像' },
        ],
        displayName: null,
        title: '(4) Facebook',
      }),
    ],
    [{ name: 'c_user', value: '1234567890', domain: '.facebook.com' }],
  );
  const res = await readFacebookIdentity(cdp, { hydrateTimeoutMs: 0 });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.accountId, '1234567890');
    assert.equal(res.identity.displayName, 'Test User');
    assert.equal(res.identity.source, 'facebook-cookie');
  }
  // 绝不为取昵称导航
  assert.equal(calls.some((call) => call.method === 'Page.navigate'), false);
  assert.deepEqual(calls.map((call) => call.method), ['Network.getAllCookies', 'Runtime.evaluate']);
});

test('readFacebookIdentity: id without a readable avatar nickname stays empty and never navigates', async () => {
  const { cdp, calls } = fakeCdpSequence(
    [
      JSON.stringify({
        href: 'https://www.facebook.com/',
        profileHrefs: ['https://www.facebook.com/profile.php?id=1234567890'],
        // 头像锚点 aria 是通用外壳标签（非「…的头像」）→ 不认作昵称
        profileAnchors: [
          { href: 'https://www.facebook.com/profile.php?id=1234567890', ariaLabel: '你的个人主页' },
        ],
        displayName: null,
        title: '(4) Facebook',
      }),
    ],
    [{ name: 'c_user', value: '1234567890', domain: '.facebook.com' }],
  );
  const res = await readFacebookIdentity(cdp, { hydrateTimeoutMs: 0 });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.accountId, '1234567890');
    // (4) Facebook 不当昵称、"你的个人主页" 不当昵称 → 诚实留空
    assert.equal(res.identity.displayName, null);
  }
  assert.equal(calls.some((call) => call.method === 'Page.navigate'), false);
});

test('extractNameFromAvatarAria: strips avatar suffix, rejects non-avatar/generic aria', () => {
  assert.equal(extractNameFromAvatarAria('Tianxing Bai的头像'), 'Tianxing Bai');
  assert.equal(extractNameFromAvatarAria('Test User’s profile picture'), 'Test User');
  assert.equal(extractNameFromAvatarAria('你的个人主页'), null); // 无头像后缀 → 不当昵称
  assert.equal(extractNameFromAvatarAria('(4) Facebook的头像'), null); // 剥后缀后是垃圾 → clean 判空
  assert.equal(extractNameFromAvatarAria(null), null);
});

test('avatarNameForId: id-anchored, ignores other ids and honors /me self-link', () => {
  const anchors = [
    { href: 'https://www.facebook.com/profile.php?id=9876543210', ariaLabel: 'Someone Else的头像' },
    { href: 'https://www.facebook.com/profile.php?id=1234567890', ariaLabel: 'Test User的头像' },
  ];
  assert.equal(avatarNameForId(anchors, '1234567890'), 'Test User');
  assert.equal(avatarNameForId(anchors, '5555555555'), null); // id 不匹配 → 不取别人名字
  assert.equal(
    avatarNameForId([{ href: 'https://www.facebook.com/me', ariaLabel: 'Test User的头像' }], '1234567890'),
    'Test User',
  ); // /me 自链命中
});

test('cleanFacebookDisplayName: rejects unread-count tab titles and generic shell labels', () => {
  assert.equal(cleanFacebookDisplayName('(4) Facebook'), null);
  assert.equal(cleanFacebookDisplayName('(12) Facebook'), null);
  assert.equal(cleanFacebookDisplayName('你的个人主页'), null);
  assert.equal(cleanFacebookDisplayName('账户控制选项和设置'), null);
});

test('deriveFacebookIdentity: id-anchored avatar aria supplies nickname off own profile', () => {
  const res = deriveFacebookIdentity({
    href: 'https://www.facebook.com/',
    profileHrefs: ['https://www.facebook.com/profile.php?id=1234567890'],
    profileAnchors: [{ href: 'https://www.facebook.com/profile.php?id=1234567890', ariaLabel: 'Test User的头像' }],
    cookieUserId: '1234567890',
    displayName: null,
    title: '(4) Facebook',
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.displayName, 'Test User');
});

test('deriveFacebookIdentity: page title is NOT used as nickname off own profile', () => {
  const res = deriveFacebookIdentity({
    href: 'https://www.facebook.com/groups/2692236954368410',
    profileHrefs: [],
    cookieUserId: '1234567890',
    displayName: null,
    title: 'Some Group | Facebook',
    ogTitle: 'Some Group',
    h1: 'Some Group',
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.displayName, null); // 群页面标题/群名 MUST NOT 当昵称
});
