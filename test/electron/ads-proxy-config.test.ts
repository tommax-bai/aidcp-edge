import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 代理输入归一/校验单点真源（change edge-client-proxy-platform-persona-ux task 1.1）。
const require = createRequire(import.meta.url);
const { normalizeProxyInput, parseProxyLines, PROXY_TYPES } = require('../../src/electron/ads-proxy-config.cjs') as {
  normalizeProxyInput: (input?: Record<string, unknown>) => {
    ok: boolean;
    proxyConfig?: Record<string, string>;
    noProxy?: boolean;
    error?: string;
  };
  parseProxyLines: (input?: Record<string, unknown>) => {
    ok: boolean;
    noProxy?: boolean;
    proxies?: Array<Record<string, string>>;
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

test('parseProxyLines: 单行与多行共用结构化归一，保留密码尾部分隔符', () => {
  const result = parseProxyLines({
    proxyType: 'HTTPS',
    proxyText: '1.2.3.4:443\ncolon.example:9443:bob:p:tail\nproxy.example----8443----alice----p----tail',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.proxies, [
    {
      proxyType: 'https', proxyHost: '1.2.3.4', proxyPort: '443', proxyUser: '', proxyPassword: '',
    },
    {
      proxyType: 'https', proxyHost: 'colon.example', proxyPort: '9443', proxyUser: 'bob', proxyPassword: 'p:tail',
    },
    {
      proxyType: 'https', proxyHost: 'proxy.example', proxyPort: '8443', proxyUser: 'alice', proxyPassword: 'p----tail',
    },
  ]);
});

test('parseProxyLines: 后置坏行只返回行号和字段原因', () => {
  const result = parseProxyLines({
    proxyType: 'socks5',
    proxyText: 'ok.example:1080\nbad.example:70000:secret-user:secret-pass',
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /第 2 条代理.*端口/);
  assert.doesNotMatch(String(result.error), /bad\.example|secret-user|secret-pass/);
});
