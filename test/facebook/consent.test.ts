import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptFacebookConsent,
  classifyFacebookConsentFromSignals,
  facebookConsentPolicyFromEnv,
  type FacebookConsentDetection,
  type FacebookConsentSignals,
} from '../../src/facebook/consent.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

const NOOP_CDP = {} as BrowseCdp;
const ACCEPT_ALL_BTN = { x: 100, y: 200, label: '允许所有 Cookie' };
const NECESSARY_BTN = { x: 300, y: 200, label: '仅允许必要 Cookie' };

function signals(over: Partial<FacebookConsentSignals> = {}): FacebookConsentSignals {
  return {
    href: 'https://www.facebook.com/',
    hasCookiePolicyCopy: true,
    captchaLike: false,
    acceptAll: ACCEPT_ALL_BTN,
    necessaryOnly: NECESSARY_BTN,
    ...over,
  };
}

// ---- classifyFacebookConsentFromSignals ----

test('consent classify: cookie banner with accept button on non-login url is present', () => {
  const det = classifyFacebookConsentFromSignals(signals());
  assert.equal(det.present, true);
  assert.deepEqual(det.acceptAll, ACCEPT_ALL_BTN);
});

test('consent classify: banner text mentioning 登录 Facebook is still consent, not login', () => {
  // 关键碰撞：同意条正文含「登录 Facebook」字样，但有 cookie 接受按钮 + 非登录 URL → 判 consent。
  const det = classifyFacebookConsentFromSignals(
    signals({ href: 'https://www.facebook.com/', hasCookiePolicyCopy: true }),
  );
  assert.equal(det.present, true);
  assert.equal(det.onLoginUrl, false);
});

test('consent classify: real login/checkpoint url is never consent even with cookie copy', () => {
  assert.equal(classifyFacebookConsentFromSignals(signals({ href: 'https://www.facebook.com/login/?next=x' })).present, false);
  assert.equal(classifyFacebookConsentFromSignals(signals({ href: 'https://www.facebook.com/checkpoint/123' })).present, false);
});

test('consent classify: captcha-like page is never consent', () => {
  assert.equal(classifyFacebookConsentFromSignals(signals({ captchaLike: true })).present, false);
});

test('consent classify: no accept button means not present (never mis-click)', () => {
  assert.equal(classifyFacebookConsentFromSignals(signals({ acceptAll: null, necessaryOnly: null })).present, false);
});

test('consent classify: no cookie-policy copy means not present', () => {
  assert.equal(classifyFacebookConsentFromSignals(signals({ hasCookiePolicyCopy: false })).present, false);
});

// ---- acceptFacebookConsent ----

function detector(seq: FacebookConsentDetection[]): { fn: (cdp: BrowseCdp) => Promise<FacebookConsentDetection>; calls: number } {
  const box = { calls: 0 } as { calls: number; fn: (cdp: BrowseCdp) => Promise<FacebookConsentDetection> };
  box.fn = async () => {
    const idx = Math.min(box.calls, seq.length - 1);
    box.calls++;
    return seq[idx];
  };
  return box;
}

const PRESENT: FacebookConsentDetection = { present: true, onLoginUrl: false, captchaLike: false, acceptAll: ACCEPT_ALL_BTN, necessaryOnly: NECESSARY_BTN };
const ABSENT: FacebookConsentDetection = { present: false, onLoginUrl: false, captchaLike: false, acceptAll: null, necessaryOnly: null };

test('accept: no consent present is a no-op (handled=false, no click)', async () => {
  const clicks: Array<[number, number]> = [];
  const res = await acceptFacebookConsent(NOOP_CDP, {
    detect: async () => ABSENT,
    click: async (_c, x, y) => { clicks.push([x, y]); },
    sleep: async () => {},
  });
  assert.deepEqual(res, { handled: false, cleared: false, attempts: 0 });
  assert.equal(clicks.length, 0);
});

test('accept: accept_all clicks the allow-all button and confirms cleared', async () => {
  const clicks: Array<[number, number]> = [];
  const det = detector([PRESENT, ABSENT]);
  const res = await acceptFacebookConsent(NOOP_CDP, {
    policy: 'accept_all',
    detect: det.fn,
    click: async (_c, x, y) => { clicks.push([x, y]); },
    sleep: async () => {},
  });
  assert.equal(res.handled, true);
  assert.equal(res.cleared, true);
  assert.equal(res.attempts, 1);
  assert.deepEqual(clicks, [[ACCEPT_ALL_BTN.x, ACCEPT_ALL_BTN.y]]);
});

test('accept: necessary_only policy clicks the essential-only button', async () => {
  const clicks: Array<[number, number]> = [];
  const det = detector([PRESENT, ABSENT]);
  const res = await acceptFacebookConsent(NOOP_CDP, {
    policy: 'necessary_only',
    detect: det.fn,
    click: async (_c, x, y) => { clicks.push([x, y]); },
    sleep: async () => {},
  });
  assert.equal(res.cleared, true);
  assert.deepEqual(clicks, [[NECESSARY_BTN.x, NECESSARY_BTN.y]]);
});

test('accept: required button missing for policy is honest no_target, never clicks the other', async () => {
  const clicks: Array<[number, number]> = [];
  const onlyNecessary: FacebookConsentDetection = { ...PRESENT, acceptAll: null };
  const res = await acceptFacebookConsent(NOOP_CDP, {
    policy: 'accept_all',
    detect: async () => onlyNecessary,
    click: async (_c, x, y) => { clicks.push([x, y]); },
    sleep: async () => {},
  });
  assert.equal(res.handled, true);
  assert.equal(res.cleared, false);
  assert.equal(res.reason, 'no_target');
  assert.equal(clicks.length, 0);
});

test('accept: banner that never clears escalates blocked_by_consent within bounded attempts', async () => {
  const clicks: Array<[number, number]> = [];
  const res = await acceptFacebookConsent(NOOP_CDP, {
    policy: 'accept_all',
    maxAttempts: 3,
    detect: async () => PRESENT, // 永远还在
    click: async (_c, x, y) => { clicks.push([x, y]); },
    sleep: async () => {},
  });
  assert.equal(res.handled, true);
  assert.equal(res.cleared, false);
  assert.equal(res.reason, 'blocked_by_consent');
  assert.equal(res.attempts, 3);
  assert.equal(clicks.length, 3); // 有界，不无限点
});

test('accept: detect failure is treated as no consent (never fake success)', async () => {
  const res = await acceptFacebookConsent(NOOP_CDP, {
    detect: async () => { throw new Error('CDP boom'); },
    click: async () => {},
    sleep: async () => {},
  });
  assert.deepEqual(res, { handled: false, cleared: false, attempts: 0 });
});

// ---- facebookConsentPolicyFromEnv ----

test('policy from env: defaults to accept_all', () => {
  assert.equal(facebookConsentPolicyFromEnv({}), 'accept_all');
  assert.equal(facebookConsentPolicyFromEnv({ AIDCP_FB_COOKIE_CONSENT: '' }), 'accept_all');
  assert.equal(facebookConsentPolicyFromEnv({ AIDCP_FB_COOKIE_CONSENT: 'accept_all' }), 'accept_all');
});

test('policy from env: necessary_only variants', () => {
  assert.equal(facebookConsentPolicyFromEnv({ AIDCP_FB_COOKIE_CONSENT: 'necessary_only' }), 'necessary_only');
  assert.equal(facebookConsentPolicyFromEnv({ AIDCP_FB_COOKIE_CONSENT: 'NECESSARY' }), 'necessary_only');
  assert.equal(facebookConsentPolicyFromEnv({ AIDCP_FB_COOKIE_CONSENT: 'essential' }), 'necessary_only');
});
