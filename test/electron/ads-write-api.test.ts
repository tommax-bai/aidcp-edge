import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 主进程侧写客户端是 CJS（供 Electron main.cjs require），经 createRequire 引入以不破 ESM typecheck。
const require = createRequire(import.meta.url);
const mod = require('../../src/electron/ads-write-api.cjs') as {
  createAdsWriteApi: (deps?: Record<string, unknown>) => {
    post: (path: string, body: unknown, opts?: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; code?: number; error?: string }>;
    createGroup: (name: string, opts?: Record<string, unknown>) => Promise<{ ok: boolean; groupId?: string; error?: string }>;
    createProfile: (
      p: { groupId: string; name?: string; fingerprintConfig: unknown; proxyConfig?: unknown; accountImport?: Record<string, unknown> },
      opts?: Record<string, unknown>,
    ) => Promise<{ ok: boolean; userId?: string; error?: string }>;
    deleteProfile: (userId: string, opts?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    WRITE_ALLOWLIST: string[];
  };
  redactSensitive: (v: unknown) => unknown;
  normalizePath: (p: string) => string;
};
const { createAdsWriteApi, redactSensitive } = mod;

interface StubRes {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function res(statusCode: number, body: unknown): StubRes {
  return { ok: statusCode >= 200 && statusCode < 300, status: statusCode, json: async () => body };
}
function stubFetch(
  make: () => StubRes | never,
  calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [],
): typeof fetch {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: String(url), init });
    return make();
  }) as unknown as typeof fetch;
}
const noThrottle = { nowImpl: () => 0, sleepImpl: async () => undefined };

// ── 红线回归：allowlist 结构性拦截生命周期端点（task 2.3，M7；user/update 已受限放行、仅改代理） ──
for (const forbidden of ['browser/start', 'browser/stop', 'browser/active', '/api/v1/browser/start']) {
  test(`allowlist: 禁止端点「${forbidden}」抛错且绝不发出请求`, async () => {
    const calls: Array<{ url: string }> = [];
    const api = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0 }), calls) });
    await assert.rejects(() => api.post(forbidden, { user_id: 'x' }), /禁止的写端点/);
    assert.equal(calls.length, 0, '禁止端点绝不触发任何 fetch');
  });
}

// ── user/update 受限放行（edge-client-proxy-platform-persona-ux）：body 结构性只含两键 ──
test('updateProfileProxy: user/update 放行、body 只含 user_id + user_proxy_config 两键', async () => {
  const calls: Array<{ url: string; init?: { body?: string } }> = [];
  const api = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0 }), calls) }) as unknown as {
    updateProfileProxy: (a: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  };
  const r = await api.updateProfileProxy({
    userId: 'u1',
    proxyConfig: { proxy_soft: 'other', proxy_type: 'socks5', proxy_host: '1.2.3.4', proxy_port: '1080' },
    // 多余字段（调用方硬塞也进不了 body——结构性两键约束）：
    remark: 'evil', fingerprint_config: { canvas: '0' },
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/api/v1/user/update'), calls[0].url);
  const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['user_id', 'user_proxy_config'], 'body 只允许两键，放行 update ≠ 打开整张写面');
  assert.equal(body.user_id, 'u1');
});

// ── C1 存量号结构性边界（facebook-locale-pin-en-us task 3.1）：写客户端改不动指纹语言 ──
test('updateProfileProxy: 硬塞 fingerprint_config(含 language) 也进不了 body——存量号指纹语言结构性改不动', async () => {
  const calls: Array<{ url: string; init?: { body?: string } }> = [];
  const api = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0 }), calls) }) as unknown as {
    updateProfileProxy: (a: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ ok: boolean }>;
  };
  const r = await api.updateProfileProxy({
    userId: 'u1',
    proxyConfig: { proxy_soft: 'no_proxy' },
    // 攻击面：调用方想借 update 改指纹语言（language_switch/language）——结构性两键约束应挡下。
    fingerprint_config: { language_switch: '1', language: ['vi-VN'] },
  });
  assert.equal(r.ok, true);
  const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['user_id', 'user_proxy_config'], 'fingerprint_config 结构性进不了 user/update body');
  assert.ok(!('fingerprint_config' in body), '存量号指纹语言经受限写客户端改不动、无法回退到随 IP');
});

test('updateProfileProxy: 缺 userId / 缺归一 proxyConfig 诚实拒绝、不发请求', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0 }), calls) }) as unknown as {
    updateProfileProxy: (a: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  };
  const r1 = await api.updateProfileProxy({ proxyConfig: { proxy_soft: 'no_proxy' } });
  assert.equal(r1.ok, false);
  const r2 = await api.updateProfileProxy({ userId: 'u1', proxyConfig: { proxy_type: 'http' } });
  assert.equal(r2.ok, false, '未经归一层（无 proxy_soft）的对象拒发');
  assert.equal(calls.length, 0);
});

test('deleteProfile: user/delete 放行、body 带 user_ids（C3 放宽为 UI 确认删）', async () => {
  const calls: Array<{ url: string; init?: { body?: string } }> = [];
  const api = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0 }), calls) });
  const r = await api.deleteProfile('u1');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/api/v1/user/delete'), calls[0].url);
  assert.match(String(calls[0].init?.body), /user_ids/);
  assert.match(String(calls[0].init?.body), /u1/);
});

test('allowlist: user/create 与 group/create 放行、打 /api/v1/ 前缀', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0, data: { id: 'u1' } }), calls) });
  const r1 = await api.post('user/create', { group_id: '1', fingerprint_config: { canvas: '1' } });
  const r2 = await api.post('group/create', { group_name: 'g' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('/api/v1/user/create'), calls[0].url);
  assert.ok(calls[1].url.includes('/api/v1/group/create'), calls[1].url);
});

// ── 诚实失败：code≠0 / 不可达一律 { ok:false }，MUST NOT 假成功 ──
test('诚实失败: code≠0 返回 ok=false 带 code/msg，不假成功', async () => {
  const api = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: -1, msg: 'quota exceeded' })) });
  const r = await api.post('user/create', { group_id: '1', fingerprint_config: { canvas: '1' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
  assert.match(String(r.error), /quota exceeded/);
});

// ── 凭据安全（H3/D9）：不可达错误绝不含代理账密 ──
test('凭据安全: fetch 抛错时错误信息不含 proxy_password', async () => {
  const throwing = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const api = createAdsWriteApi({ ...noThrottle, fetchImpl: throwing });
  const r = await api.createProfile({
    groupId: '1',
    fingerprintConfig: { canvas: '1' },
    proxyConfig: { proxy_soft: 'http', proxy_user: 'alice', proxy_password: 'S3cr3t!' },
  });
  assert.equal(r.ok, false);
  assert.doesNotMatch(String(r.error), /S3cr3t!/, '错误信息 MUST NOT 泄露代理密码');
  assert.doesNotMatch(String(r.error), /alice/, '错误信息 MUST NOT 泄露代理账号');
});

test('redactSensitive: 脱敏 proxy_password / Authorization / api_key', () => {
  const red = redactSensitive({
    group_id: '1',
    user_proxy_config: { proxy_soft: 'http', proxy_user: 'alice', proxy_password: 'S3cr3t!' },
    headers: { Authorization: 'Bearer abc' },
    api_key: 'k',
    cookie: 'c_user=secret',
    fakey: '2fa',
    fingerprint_config: { canvas: '1' },
  }) as Record<string, any>;
  assert.equal(red.user_proxy_config.proxy_password, '***');
  assert.equal(red.user_proxy_config.proxy_user, '***');
  assert.equal(red.headers.Authorization, '***');
  assert.equal(red.api_key, '***');
  assert.equal(red.cookie, '***');
  assert.equal(red.fakey, '***');
  assert.equal(red.group_id, '1'); // 非敏感保留
  assert.equal(red.fingerprint_config.canvas, '1');
});

test('createProfile: Facebook account import fields enter user/create body', async () => {
  const calls: Array<{ url: string; init?: { body?: string } }> = [];
  const api = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0, data: { id: 'k1fb' } }), calls) });
  const r = await api.createProfile({
    groupId: '42',
    name: 'Facebook import 1',
    fingerprintConfig: { canvas: '1' },
    accountImport: {
      domainName: 'facebook.com',
      openUrls: ['https://www.facebook.com/'],
      username: 'a@example.com',
      password: 'pw',
      fakey: 'KEY',
      cookie: '[{"name":"c_user","value":"100000000000001"}]',
      repeatConfig: [4],
      ignoreCookieError: '0',
    },
  });
  assert.equal(r.ok, true);
  const body = JSON.parse(calls[0].init?.body || '{}') as Record<string, any>;
  assert.equal(body.domain_name, 'facebook.com');
  assert.deepEqual(body.open_urls, ['https://www.facebook.com/']);
  assert.equal(body.username, 'a@example.com');
  assert.equal(body.password, 'pw');
  assert.equal(body.fakey, 'KEY');
  assert.match(body.cookie, /c_user/);
  assert.deepEqual(body.repeat_config, [4]);
  assert.equal(body.ignore_cookie_error, '0');
});

// ── 便捷封装：createGroup / createProfile 抽出 id ──
test('createGroup 抽出 groupId、createProfile 抽出 userId', async () => {
  const gapi = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0, data: { group_id: 42 } })) });
  const g = await gapi.createGroup('probe');
  assert.equal(g.ok, true);
  assert.equal(g.groupId, '42');

  const papi = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0, data: { id: 'k1e0' } })) });
  const p = await papi.createProfile({ groupId: '42', fingerprintConfig: { canvas: '1' } });
  assert.equal(p.ok, true);
  assert.equal(p.userId, 'k1e0');
});
