import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdsPowerActiveProxyTakeoverError,
  requireActiveProxyEgressMatch,
} from '../../src/cdp/active-proxy-takeover.js';

test('Active 浏览器真实出口与冻结有效代理出口精确匹配时允许接管', () => {
  assert.deepEqual(requireActiveProxyEgressMatch({
    profileId: 'k1',
    expectedEgressIp: '::ffff:203.0.113.7',
    browserEgressIp: '203.0.113.7',
  }), {
    expectedEgressIp: '203.0.113.7',
    browserEgressIp: '203.0.113.7',
  });
});

test('Active 浏览器出口不匹配时给出稳定终局错误且不暴露代理凭据', () => {
  assert.throws(
    () => requireActiveProxyEgressMatch({
      profileId: 'k1',
      expectedEgressIp: '203.0.113.7',
      browserEgressIp: '198.51.100.9',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AdsPowerActiveProxyTakeoverError);
      assert.equal(error.code, 'adspower_active_proxy_takeover_rejected');
      assert.equal(error.reason, 'egress_mismatch');
      assert.match(error.message, /\[adspower_active_proxy_takeover_rejected\]/);
      return true;
    },
  );
});

test('Active 浏览器或权威代理出口无法观测时拒绝接管', () => {
  for (const input of [
    { expectedEgressIp: undefined, browserEgressIp: '203.0.113.7' },
    { expectedEgressIp: '203.0.113.7', browserEgressIp: undefined },
  ]) {
    assert.throws(
      () => requireActiveProxyEgressMatch({ profileId: 'k1', ...input }),
      (error: unknown) => error instanceof AdsPowerActiveProxyTakeoverError
        && error.reason === 'egress_unavailable',
    );
  }
});
