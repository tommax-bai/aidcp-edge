import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChromeInstance } from '../../src/cdp/chrome-launcher.js';
import type { BrowserProvider } from '../../src/cdp/browser-provider.js';
import {
  CdpWechatChannelsBrowserSidecar,
  parseNativeWechatSessionCandidate,
  type WechatNativeCaptureRuntime,
} from '../../src/wechat-channels/browser-sidecar.js';

const CANDIDATE = {
  cookies: [{
    name: 'session',
    value: 'secret',
    domain: '.weixin.qq.com',
    path: '/',
    httpOnly: true,
    secure: true,
  }],
  userAgent: 'Wechat Native Test',
  acquiredAt: 123,
  requestContext: {
    version: 1,
    aid: 'aid-test',
    pageUrl: 'https://channels.weixin.qq.com/platform/post/list',
    commonBody: {
      logFinderId: 'finder-test',
      logFinderUin: '',
      rawKeyBuff: '',
      pluginSessionId: null,
      reqScene: 7,
      scene: 7,
    },
    headers: {
      fingerprintDeviceId: 'device-test',
      wechatUin: 'uin-test',
    },
  },
};

function harness(options: { failOpen?: boolean; closeConfirmed?: boolean } = {}) {
  const order: string[] = [];
  const browser = {
    killAndConfirmDead: async () => {
      order.push('browser.close');
      return options.closeConfirmed !== false;
    },
  } as unknown as ChromeInstance;
  const provider = {
    kind: 'adspower',
    launch: async () => {
      order.push('browser.open');
      return { instance: browser, endpoint: { host: '127.0.0.1', port: 9222 } };
    },
  } as BrowserProvider;
  const runtime: WechatNativeCaptureRuntime = {
    openOwner: async () => {
      order.push('native.open');
      if (options.failOpen) throw new Error('native unavailable');
    },
    execute: async (_ownerId, command) => {
      order.push(`native.execute:${command.kind}`);
      return {
        ok: true,
        effectPhase: 'confirmed',
        reasonCode: 'confirmed',
        output: { kind: 'wechat_session_candidate', value: CANDIDATE },
      };
    },
    shutdown: async () => {
      order.push('native.close');
    },
  };
  const sidecar = new CdpWechatChannelsBrowserSidecar({
    env: { AIDCP_ADS_USER_ID: 'wechat-profile' },
    provider,
    createNativeRuntime: () => runtime,
    logImpl: () => undefined,
  });
  return { sidecar, order };
}

test('WeChat browser sidecar obtains its bounded session candidate only through Native', async () => {
  const { sidecar, order } = harness();
  await sidecar.open();
  assert.deepEqual(await sidecar.readSessionCandidate(), CANDIDATE);
  await sidecar.close();
  assert.deepEqual(order, [
    'browser.open',
    'native.open',
    'native.execute:wechat_capture_session',
    'native.close',
    'browser.close',
  ]);
  assert.equal(sidecar.getState(), 'closed');
});

test('Native attach failure closes Native before the physical browser and preserves close truth', async () => {
  const { sidecar, order } = harness({ failOpen: true });
  await assert.rejects(sidecar.open(), /native unavailable/);
  assert.deepEqual(order, ['browser.open', 'native.open', 'native.close', 'browser.close']);
  assert.equal(sidecar.getState(), 'closed');
});

test('Native candidate parser rejects raw extras and non-WeChat cookies', () => {
  assert.equal(parseNativeWechatSessionCandidate({ ...CANDIDATE, outerHTML: '<body />' }), null);
  assert.equal(parseNativeWechatSessionCandidate({
    ...CANDIDATE,
    cookies: [{ ...CANDIDATE.cookies[0], domain: '.example.com' }],
  }), null);
});
