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
      p: { groupId: string; name?: string; fingerprintConfig: unknown; proxyConfig?: unknown },
      opts?: Record<string, unknown>,
    ) => Promise<{ ok: boolean; userId?: string; error?: string }>;
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

// ── 红线回归：allowlist 结构性拦截生命周期 / 删除端点（task 2.3，M7 + C3） ──
for (const forbidden of ['browser/start', 'browser/stop', 'browser/active', 'user/delete', '/api/v1/browser/start', 'user/update']) {
  test(`allowlist: 禁止端点「${forbidden}」抛错且绝不发出请求`, async () => {
    const calls: Array<{ url: string }> = [];
    const api = createAdsWriteApi({ ...noThrottle, fetchImpl: stubFetch(() => res(200, { code: 0 }), calls) });
    await assert.rejects(() => api.post(forbidden, { user_id: 'x' }), /禁止的写端点/);
    assert.equal(calls.length, 0, '禁止端点绝不触发任何 fetch');
  });
}

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
    fingerprint_config: { canvas: '1' },
  }) as Record<string, any>;
  assert.equal(red.user_proxy_config.proxy_password, '***');
  assert.equal(red.user_proxy_config.proxy_user, '***');
  assert.equal(red.headers.Authorization, '***');
  assert.equal(red.api_key, '***');
  assert.equal(red.group_id, '1'); // 非敏感保留
  assert.equal(red.fingerprint_config.canvas, '1');
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
