import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseFacebookBatchProxies,
  createFacebookBatchPlan,
  validateCreationCapacity,
  failedFacebookBatchReceipt,
} = require('../../src/electron/facebook-batch-create.cjs') as {
  parseFacebookBatchProxies: (input: Record<string, unknown>) => {
    ok: boolean;
    noProxy?: boolean;
    proxies?: Array<Record<string, string>>;
    error?: string;
  };
  createFacebookBatchPlan: (input: Record<string, unknown>) => {
    ok: boolean;
    plan?: Array<{ accountImport: unknown; accountLine: number; osFamilyKey: string; proxy: Record<string, string> }>;
    proxyCount?: number;
    error?: string;
  };
  validateCreationCapacity: (input: Record<string, unknown>) => {
    ok: boolean;
    configured: number;
    accountCap: number;
    requested: number;
    remaining: number;
  };
  failedFacebookBatchReceipt: (created: unknown[], failedIndex: number, reason: string) => {
    ok: boolean;
    error: string;
    created: unknown[];
    createdCount: number;
    failedIndex: number;
    partial: boolean;
  };
};

test('parseFacebookBatchProxies: 支持冒号与 ---- 两种逐行格式，代理类型只注入一次', () => {
  const result = parseFacebookBatchProxies({
    proxyType: 'SOCKS5',
    proxyText: [
      '1.2.3.4:1080',
      'proxy.example----2080----alice----p:with:colon',
    ].join('\n'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.noProxy, false);
  assert.deepEqual(result.proxies, [
    {
      proxyType: 'socks5',
      proxyHost: '1.2.3.4',
      proxyPort: '1080',
      proxyUser: '',
      proxyPassword: '',
    },
    {
      proxyType: 'socks5',
      proxyHost: 'proxy.example',
      proxyPort: '2080',
      proxyUser: 'alice',
      proxyPassword: 'p:with:colon',
    },
  ]);
});

test('parseFacebookBatchProxies: no_proxy 必须没有代理行，实际类型必须至少一行', () => {
  const none = parseFacebookBatchProxies({ proxyType: 'no_proxy', proxyText: '\n  ' });
  assert.equal(none.ok, true);
  assert.equal(none.noProxy, true);
  assert.deepEqual(none.proxies, []);

  const stray = parseFacebookBatchProxies({ proxyType: 'no_proxy', proxyText: '1.2.3.4:80' });
  assert.equal(stray.ok, false);
  assert.match(String(stray.error), /清空/);

  const missing = parseFacebookBatchProxies({ proxyType: 'http', proxyText: '' });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /至少.*一条/);
});

test('parseFacebookBatchProxies: 非法后置行只报告安全行号，不回显凭据', () => {
  const result = parseFacebookBatchProxies({
    proxyType: 'https',
    proxyText: 'ok.example:443\nbad.example:70000:secret-user:secret-pass',
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /第 2 条代理.*端口/);
  assert.doesNotMatch(String(result.error), /bad\.example|secret-user|secret-pass/);
});

test('createFacebookBatchPlan: 五个账号按 A/B/A/B/A 轮询代理，并独立选择 OS family', () => {
  const accounts = Array.from({ length: 5 }, (_, index) => ({ username: `account-${index + 1}` }));
  const picks = [1, 0, 1, 1, 0];
  const result = createFacebookBatchPlan({
    accountEntries: accounts,
    proxyType: 'http',
    proxyText: 'proxy-a:8001\nproxy-b:8002',
    osFamilyKeys: ['windows', 'macos'],
    randomIndex: () => picks.shift(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.proxyCount, 2);
  assert.deepEqual(result.plan?.map((item) => item.proxy.proxyHost), [
    'proxy-a', 'proxy-b', 'proxy-a', 'proxy-b', 'proxy-a',
  ]);
  assert.deepEqual(result.plan?.map((item) => item.osFamilyKey), [
    'macos', 'windows', 'macos', 'macos', 'windows',
  ]);
  assert.deepEqual(result.plan?.map((item) => item.accountLine), [1, 2, 3, 4, 5]);
  assert.equal(result.plan?.[3].accountImport, accounts[3]);
});

test('createFacebookBatchPlan: 无代理时每个账号显式获得独立 no_proxy 输入', () => {
  const result = createFacebookBatchPlan({
    accountEntries: [{ username: 'a' }, { username: 'b' }],
    proxyType: 'no_proxy',
    proxyText: '',
    osFamilyKeys: ['windows'],
    randomIndex: () => 0,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan?.map((item) => item.proxy), [
    { proxyType: 'no_proxy' },
    { proxyType: 'no_proxy' },
  ]);
  assert.notEqual(result.plan?.[0].proxy, result.plan?.[1].proxy);
});

test('createFacebookBatchPlan: 缺账号、缺 OS family 或随机索引越界均诚实拒绝', () => {
  const missingAccounts = createFacebookBatchPlan({ accountEntries: [], osFamilyKeys: ['windows'] });
  assert.equal(missingAccounts.ok, false);
  assert.match(String(missingAccounts.error), /至少.*账号/);

  const missingOsFamilies = createFacebookBatchPlan({ accountEntries: [{}], osFamilyKeys: [] });
  assert.equal(missingOsFamilies.ok, false);
  assert.match(String(missingOsFamilies.error), /操作系统/);

  const badRandom = createFacebookBatchPlan({
    accountEntries: [{}],
    proxyType: 'no_proxy',
    osFamilyKeys: ['windows'],
    randomIndex: () => 1,
  });
  assert.equal(badRandom.ok, false);
  assert.match(String(badRandom.error), /随机操作系统/);
});

test('validateCreationCapacity: 整批超过剩余容量时在写入前拒绝', () => {
  assert.deepEqual(validateCreationCapacity({ configured: 3, accountCap: 5, requested: 2 }), {
    ok: true,
    configured: 3,
    accountCap: 5,
    requested: 2,
    remaining: 2,
  });
  assert.deepEqual(validateCreationCapacity({ configured: 3, accountCap: 5, requested: 3 }), {
    ok: false,
    configured: 3,
    accountCap: 5,
    requested: 3,
    remaining: 2,
  });
});

test('failedFacebookBatchReceipt: 部分失败保留真实计数、序号与安全摘要', () => {
  const created = [{ userId: 'u1', template: 'tpl-a' }, { userId: 'u2', template: 'tpl-b' }];
  const result = failedFacebookBatchReceipt(created, 3, 'AdsPower 暂不可用');
  assert.equal(result.ok, false);
  assert.equal(result.createdCount, 2);
  assert.equal(result.failedIndex, 3);
  assert.equal(result.partial, true);
  assert.equal(result.created, created);
  assert.match(result.error, /第 3 个账号.*已创建 2 个环境.*后续账号尚未创建/);
});
