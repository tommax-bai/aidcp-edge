import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 主进程侧只读模块是 CJS（供 Electron main.cjs require），经 createRequire 引入以不破 ESM typecheck。
const require = createRequire(import.meta.url);
const { createAdsLocalApi, normalizeProfile } = require('../../src/electron/ads-local-api.cjs') as {
  createAdsLocalApi: (deps?: Record<string, unknown>) => {
    status: (opts?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    listProfiles: (opts?: Record<string, unknown>) => Promise<{
      ok: boolean;
      profiles?: Array<{ userId: string; serialNumber: string; name: string; groupName: string; proxy: string }>;
      truncated?: boolean;
      authLikely?: boolean;
      error?: string;
    }>;
    ADS_MIN_INTERVAL_MS: number;
  };
  normalizeProfile: (it: Record<string, unknown>) => { userId: string; serialNumber: string; proxy: string };
};

interface StubRes {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function res(ok: boolean, statusCode: number, body: unknown): StubRes {
  return { ok, status: statusCode, json: async () => body };
}

/** fetch 桩：按 url 子串命中返回响应或抛错；记录所有请求 url + headers。 */
function stubFetch(
  routes: Array<[string, () => StubRes | never]>,
  calls: Array<{ url: string; headers?: Record<string, string> }> = [],
): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers });
    for (const [needle, make] of routes) {
      if (String(url).includes(needle)) return make();
    }
    throw new Error(`unrouted: ${url}`);
  }) as unknown as typeof fetch;
}

const noThrottle = { nowImpl: () => 0, sleepImpl: async () => undefined };

test('status: 可达且打的是根级 /status（不含 /api/v1）', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/status', () => res(true, 200, { code: 0, msg: 'success' })]], calls),
  });
  const r = await api.status();
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/status(\?|$)/);
  assert.doesNotMatch(calls[0].url, /\/api\/v1\/status/); // 红线：绝不误加 /api/v1 前缀
});

test('status: 本地 API 不可达（fetch 抛错）→ ok:false 诚实回报，不抛', async () => {
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/status', () => { throw new Error('ECONNREFUSED'); }]]),
  });
  const r = await api.status();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /未检测到 AdsPower 本地 API/);
});

test('status: 非 2xx → ok:false 标 HTTP 码', async () => {
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/status', () => res(false, 500, {})]]),
  });
  const r = await api.status();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /HTTP 500/);
});

test('listProfiles: 成功归一化，取 user_id 而非 serial_number；打的是 /api/v1/user/list', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch(
      [['/api/v1/user/list', () => res(true, 200, {
        code: 0,
        data: {
          total: 1,
          list: [{
            user_id: 'k1e0awu5',
            serial_number: '123',
            name: '账号A',
            group_name: '组1',
            ip: '1.2.3.4',
            ip_country: 'hk',
            user_proxy_config: { proxy_type: 'socks5', proxy_host: 'h.example' },
          }],
        },
      })]],
      calls,
    ),
  });
  const r = await api.listProfiles();
  assert.equal(r.ok, true);
  assert.equal(r.profiles?.length, 1);
  const p = r.profiles![0];
  assert.equal(p.userId, 'k1e0awu5'); // ← 写入 adsProfileId 的必须是 user_id
  assert.notEqual(p.userId, '123'); // 绝不取 serial_number
  assert.equal(p.serialNumber, '123');
  assert.match(p.proxy, /socks5/);
  assert.match(p.proxy, /ip=1\.2\.3\.4/);
  assert.match(calls[0].url, /\/api\/v1\/user\/list/);
});

test('listProfiles: 分页拼接（首页满 page_size、次页短即止）', async () => {
  let page = 0;
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/api/v1/user/list', () => {
      page += 1;
      if (page === 1) {
        return res(true, 200, { code: 0, data: { list: Array.from({ length: 100 }, (_, i) => ({ user_id: `p${i}` })) } });
      }
      return res(true, 200, { code: 0, data: { list: [{ user_id: 'last' }] } });
    }]]),
  });
  const r = await api.listProfiles({ pageSize: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.profiles?.length, 101);
  assert.equal(r.profiles?.at(-1)?.userId, 'last');
  assert.equal(r.truncated, false);
});

test('listProfiles: code≠0 → ok:false 诚实回报', async () => {
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/api/v1/user/list', () => res(true, 200, { code: -1, msg: 'something wrong' })]]),
  });
  const r = await api.listProfiles();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /code=-1/);
});

test('listProfiles: 401 → ok:false 且 authLikely 提示配 API key', async () => {
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/api/v1/user/list', () => res(false, 401, {})]]),
  });
  const r = await api.listProfiles();
  assert.equal(r.ok, false);
  assert.equal(r.authLikely, true);
  assert.match(r.error ?? '', /API 校验/);
});

test('listProfiles: 空列表 → ok:true 空数组', async () => {
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/api/v1/user/list', () => res(true, 200, { code: 0, data: { list: [] } })]]),
  });
  const r = await api.listProfiles();
  assert.equal(r.ok, true);
  assert.deepEqual(r.profiles, []);
});

test('调用级 apiKey 覆盖：传入表单当前 key → Authorization 用之', async () => {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    apiKey: 'PERSISTED',
    fetchImpl: stubFetch([['/api/v1/user/list', () => res(true, 200, { code: 0, data: { list: [] } })]], calls),
  });
  await api.listProfiles({ apiKey: 'FORM_CURRENT' });
  assert.equal(calls[0].headers?.Authorization, 'Bearer FORM_CURRENT');
});

test('本进程内串行节流：相邻只读调用间隔 ≥1s（跨进程碰撞另走诚实降级，本测仅覆盖单进程）', async () => {
  // 起点非零，贴合生产 now()=Date.now()（大数）；若从 0 起，首次 markCalled 后 lastApiAt 仍为 0、
  // 会被 `lastApiAt !== 0` 守卫当成「从未调用」（与核心 provider 同款语义）——那是零时钟测试假象、非真缺陷。
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const api = createAdsLocalApi({
    nowImpl: () => clock,
    sleepImpl: async (ms: number) => { sleeps.push(ms); clock += ms; },
    fetchImpl: stubFetch([['/status', () => res(true, 200, { code: 0 })]]),
  });
  await api.status();
  await api.status();
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 1000, `expected ≥1000ms throttle, got ${sleeps[0]}`);
});

test('并发串行化：两个调用同时进入也按 ≥1s 串行（防两独立按钮/自动探测撞限速）', async () => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const order: string[] = [];
  const api = createAdsLocalApi({
    nowImpl: () => clock,
    sleepImpl: async (ms: number) => { sleeps.push(ms); clock += ms; },
    fetchImpl: (async (url: string) => {
      order.push(String(url).includes('/status') ? 'status' : 'list');
      return res(true, 200, { code: 0, data: { list: [] } });
    }) as unknown as typeof fetch,
  });
  // 同时发起（模拟「检测」与「刷新」几乎同时点）——旧实现两者同读旧 lastApiAt、都不等 → sleeps 为空；
  // 队列串行化后第二个必须等 ≥1s。
  await Promise.all([api.status(), api.listProfiles()]);
  assert.equal(order.length, 2);
  assert.ok(sleeps.some((s) => s >= 1000), `并发调用应被串行节流，实测 sleeps=${JSON.stringify(sleeps)}`);
});

test('只读边界：normalizeProfile 只读字段映射，模块从不构造 browser/start|stop|active URL', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch(
      [
        ['/status', () => res(true, 200, { code: 0 })],
        ['/api/v1/user/list', () => res(true, 200, { code: 0, data: { list: [] } })],
      ],
      calls,
    ),
  });
  await api.status();
  await api.listProfiles();
  for (const c of calls) {
    assert.doesNotMatch(c.url, /browser\/(start|stop|active)/);
  }
  // 归一化纯映射，不发请求
  const n = normalizeProfile({ user_id: 'u1', serial_number: 's1' });
  assert.equal(n.userId, 'u1');
  assert.equal(n.serialNumber, 's1');
});

test('normalizeProfile: 真机 no_proxy（带下划线）归一为「无代理配置」', () => {
  assert.equal(normalizeProfile({ user_id: 'u', user_proxy_config: { proxy_type: 'no_proxy' } }).proxy, '无代理配置');
  assert.equal(normalizeProfile({ user_id: 'u', user_proxy_config: { proxy_type: 'noproxy' } }).proxy, '无代理配置');
  // 有真代理配置仍如实展示
  assert.match(normalizeProfile({ user_id: 'u', ip: '9.9.9.9', user_proxy_config: { proxy_type: 'socks5' } }).proxy, /socks5/);
});

test('listGroups: 打 group/list、归一化 groupId/groupName', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/group/list', () => res(true, 200, { code: 0, data: { list: [{ group_id: 42, group_name: 'aidcp-创建' }] } })]], calls),
  }) as unknown as { listGroups: (o?: unknown) => Promise<{ ok: boolean; groups?: Array<{ groupId: string; groupName: string }>; error?: string }> };
  const r = await api.listGroups();
  assert.equal(r.ok, true);
  assert.equal(r.groups?.[0].groupId, '42');
  assert.equal(r.groups?.[0].groupName, 'aidcp-创建');
  assert.ok(calls[0].url.includes('/api/v1/group/list'));
});
