import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FacebookOverlayMonitor,
  classifyFacebookOverlay,
  classifyFacebookOverlayFromSignals,
} from '../../src/facebook/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

function fakeCdp(ref: { value: unknown; throwIt?: boolean }): BrowseCdp {
  return {
    send: async () => {
      if (ref.throwIt) throw new Error('CDP boom');
      return { result: { value: ref.value } } as never;
    },
  };
}

test('classifyFacebookOverlayFromSignals: checkpoint and human verification are captcha-blocking', () => {
  assert.equal(classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/checkpoint/123' }), 'captcha');
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/two_step_verification/authentication/',
    text: '进行人机身份验证',
    frameUrls: ['https://www.google.com/recaptcha/enterprise/anchor'],
  }), 'captcha');
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/',
    frameUrls: ['https://www.fbsbx.com/captcha/recaptcha/iframe'],
  }), 'captcha');
});

test('classifyFacebookOverlayFromSignals: login and recovery pages are login-blocking', () => {
  assert.equal(classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/login/?next=x' }), 'login');
  assert.equal(classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/recover/initiate/' }), 'login');
  assert.equal(classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/', text: '登录 Facebook' }), 'login');
});

test('classifyFacebookOverlayFromSignals: temporarily blocked text is unknown-blocking', () => {
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/',
    text: "You're temporarily blocked from using this feature",
  }), 'unknown');
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/',
    text: '你暂时无法使用此功能',
  }), 'unknown');
});

test('classifyFacebookOverlayFromSignals: FB soft-block/throttle toasts are unknown-blocking (§5.2)', () => {
  const throttles = [
    'Action Blocked',
    "You can't use this feature right now",
    'We limit how often you can do this to protect our community',
    'It looks like you were misusing this feature by going too fast',
    'You’re Going Too Fast', // 智能引号 + 大小写
    '操作被封锁',
    '此功能暂时无法使用',
  ];
  for (const text of throttles) {
    assert.equal(
      classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/', text }),
      'unknown',
      `should classify throttle text as unknown: ${text}`,
    );
  }
});

test('classifyFacebookOverlayFromSignals: 普通正文不误判为限流（no false positive）', () => {
  assert.equal(
    classifyFacebookOverlayFromSignals({
      href: 'https://www.facebook.com/groups/x/',
      text: 'This feature helps you limit distractions while you post updates.',
    }),
    'none',
  );
});

test('classifyFacebookOverlayFromSignals: clean facebook page is none', () => {
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/groups/example/permalink/1/',
    text: 'Some regular group post text',
  }), 'none');
});

test('classifyFacebookOverlay: invalid JSON fails closed as unknown', async () => {
  assert.equal(await classifyFacebookOverlay(fakeCdp({ value: '{bad-json' })), 'unknown');
});

test('FacebookOverlayMonitor: sticky on probe errors', async () => {
  const ref = { value: JSON.stringify({ href: 'https://www.facebook.com/login/' }) as unknown };
  const monitor = new FacebookOverlayMonitor(fakeCdp(ref), { pollMs: 1 });
  const transitions: Array<[string, string]> = [];

  await monitor.tick((from, to) => transitions.push([from, to]));
  assert.equal(monitor.state, 'login');
  ref.value = JSON.stringify({ href: 'https://www.facebook.com/' });
  (ref as { throwIt?: boolean }).throwIt = true;
  await monitor.tick((from, to) => transitions.push([from, to]));
  assert.equal(monitor.state, 'login');
  assert.deepEqual(transitions, [['none', 'login']]);
});
