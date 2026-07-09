import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 代理输入归一/校验单点真源（change edge-client-proxy-platform-persona-ux task 1.1）。
const require = createRequire(import.meta.url);
const { normalizeProxyInput, PROXY_TYPES } = require('../../src/electron/ads-proxy-config.cjs') as {
  normalizeProxyInput: (input?: Record<string, unknown>) => {
    ok: boolean;
    proxyConfig?: Record<string, string>;
    noProxy?: boolean;
    error?: string;
  };
  PROXY_TYPES: string[];
};

test('normalizeProxyInput: 全空 / 显式 no_proxy → 无代理配置', () => {
  for (const input of [{}, undefined, { proxyType: 'no_proxy', proxyHost: '1.2.3.4' }]) {
    const r = normalizeProxyInput(input as Record<string, unknown>);
    assert.equal(r.ok, true);
    assert.equal(r.noProxy, true);
    assert.deepEqual(r.proxyConfig, { proxy_soft: 'no_proxy' });
  }
});

test('normalizeProxyInput: 合法输入 → proxy_soft=other + 归一字段（port 转字符串、账密可选）', () => {
  const r = normalizeProxyInput({ proxyType: 'SOCKS5', proxyHost: ' 1.2.3.4 ', proxyPort: 1080, proxyUser: 'alice', proxyPassword: 'p' });
  assert.equal(r.ok, true);
  assert.equal(r.noProxy, false);
  assert.deepEqual(r.proxyConfig, {
    proxy_soft: 'other',
    proxy_type: 'socks5',
    proxy_host: '1.2.3.4',
    proxy_port: '1080',
    proxy_user: 'alice',
    proxy_password: 'p',
  });
  const noAuth = normalizeProxyInput({ proxyType: 'http', proxyHost: 'h.example', proxyPort: '8080' });
  assert.equal(noAuth.ok, true);
  assert.equal(noAuth.proxyConfig!.proxy_user, undefined, '未填账密不下发空字段');
});

test('normalizeProxyInput: 非法输入诚实拒绝（绝不静默降级 no_proxy）', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ proxyType: 'ftp', proxyHost: 'h', proxyPort: '1' }, /代理类型/],
    [{ proxyType: 'http', proxyPort: '8080' }, /host.*不能为空|地址/],
    [{ proxyType: 'http', proxyHost: 'h', proxyPort: '70000' }, /端口/],
    [{ proxyType: 'http', proxyHost: 'h', proxyPort: 'abc' }, /端口/],
    [{ proxyType: 'http', proxyHost: 'h', proxyPort: '0' }, /端口/],
    [{ proxyType: 'http', proxyHost: 'h', proxyPort: '8080', proxyPassword: 'p' }, /用户名/],
    // 只填了 host 没选类型：不是「全空」，不得当 no_proxy 吞掉
    [{ proxyHost: '1.2.3.4' }, /代理类型/],
  ];
  for (const [input, re] of cases) {
    const r = normalizeProxyInput(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(String(r.error), re);
  }
});

test('PROXY_TYPES: 与 AdsPower 契约一致（http/https/socks5）', () => {
  assert.deepEqual(PROXY_TYPES, ['http', 'https', 'socks5']);
});
