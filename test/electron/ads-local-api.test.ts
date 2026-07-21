import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 主进程侧 LocalAPI 模块是 CJS（供 Electron main.cjs require），经 createRequire 引入以不破 ESM typecheck。
const require = createRequire(import.meta.url);
const { createAdsLocalApi, normalizeProfile } = require('../../src/electron/ads-local-api.cjs') as {
  createAdsLocalApi: (deps?: Record<string, unknown>) => {
    status: (opts?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    listProfiles: (opts?: Record<string, unknown>) => Promise<{
      ok: boolean;
      profiles?: Array<{ userId: string; serialNumber: string; name: string; groupName: string; proxy: string; proxyConfig?: Record<string, unknown> }>;
      truncated?: boolean;
      authLikely?: boolean;
      error?: string;
    }>;
    getProfileProxyConfig: (opts?: Record<string, unknown>) => Promise<{
      ok: boolean;
      noProxy?: boolean;
      proxy?: {
        proxyType: string;
        proxyHost: string;
        proxyPort: string;
        proxyUser: string;
        proxyPassword: string;
      };
      error?: string;
    }>;
    openProfileForInspection: (opts?: Record<string, unknown>) => Promise<{
      ok: boolean;
      debugPort?: number;
      error?: string;
    }>;
    ADS_MIN_INTERVAL_MS: number;
  };
  normalizeProfile: (it: Record<string, unknown>) => { userId: string; serialNumber: string; proxy: string; platform: string };
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
  calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [],
): typeof fetch {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body });
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
  assert.match(r.error ?? '', /未检测到本地指纹浏览器服务/);
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

test('getProfileProxyConfig: 精确读取完整认证配置但现有列表投影仍不含密码', async () => {
  const calls: Array<{ url: string }> = [];
  const item = {
    user_id: 'profile-secret',
    serial_number: '321',
    user_proxy_config: {
      proxy_type: 'http',
      proxy_host: 'proxy.example',
      proxy_port: '8000',
      proxy_user: 'operator',
      proxy_password: 'never-render-this',
    },
  };
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/api/v1/user/list', () => res(true, 200, { code: 0, data: { list: [item] } })]], calls),
  });

  const privateResult = await api.getProfileProxyConfig({ profileId: 'profile-secret' });
  assert.deepEqual(privateResult, {
    ok: true,
    noProxy: false,
    proxy: {
      proxyType: 'http',
      proxyHost: 'proxy.example',
      proxyPort: '8000',
      proxyUser: 'operator',
      proxyPassword: 'never-render-this',
    },
  });
  assert.match(calls[0].url, /user_id=profile-secret/);

  const publicResult = await api.listProfiles();
  assert.equal(JSON.stringify(publicResult).includes('never-render-this'), false);
  assert.equal(Object.hasOwn(publicResult.profiles?.[0]?.proxyConfig ?? {}, 'proxyPassword'), false);
});

test('getProfileProxyConfig: 不存在的 profile 和 API 异常均不回显服务端内容', async () => {
  const missing = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/api/v1/user/list', () => res(true, 200, { code: 0, data: { list: [] } })]]),
  });
  assert.deepEqual(await missing.getProfileProxyConfig({ profileId: 'missing' }), {
    ok: false,
    error: '读取代理配置失败：未找到该环境',
  });

  const rejected = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/api/v1/user/list', () => res(true, 200, { code: -1, msg: 'password=secret' })]]),
  });
  const result = await rejected.getProfileProxyConfig({ profileId: 'profile-secret' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('password=secret'), false);
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

test('只读边界：探测与列表仍不构造 browser/start|stop|active URL', async () => {
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

test('人工查看只打开权威视频号分身，固定 V2 start 参数且拿到有效句柄才成功', async () => {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch(
      [
        ['/api/v2/browser-profile/active', () => res(true, 200, { code: 0, data: { status: 'Inactive' } })],
        ['/api/v2/browser-profile/start', () => res(true, 200, { code: 0, data: { debug_port: 61234 } })],
      ],
      calls,
    ),
    adsCacheRoot: join(tmpdir(), '__aidcp_nonexistent_ads_cache__'),
  });
  const result = await api.openProfileForInspection({
    userId: 'k1eoujd8',
    startUrl: 'https://channels.weixin.qq.com/platform/post/list',
    apiBase: 'http://127.0.0.1:50325',
    apiKey: 'secret-test-key',
  });
  assert.deepEqual(result, { ok: true, debugPort: 61234 });
  assert.equal(calls.length, 2);
  const activeCall = calls[0];
  assert.equal(new URL(activeCall.url).pathname, '/api/v2/browser-profile/active');
  assert.equal(new URL(activeCall.url).searchParams.get('profile_id'), 'k1eoujd8');
  const startCall = calls[1];
  assert.equal(new URL(startCall.url).pathname, '/api/v2/browser-profile/start');
  assert.equal(startCall.method, 'POST');
  const payload = JSON.parse(startCall.body || '{}');
  assert.equal(payload.profile_id, 'k1eoujd8');
  assert.equal(payload.last_opened_tabs, '1', '人工查看新启动时应恢复历史标签页');
  assert.equal(payload.headless, '0');
  assert.ok(payload.launch_args.includes('https://channels.weixin.qq.com/platform/post/list'));
  assert.equal(startCall.headers?.Authorization, 'Bearer secret-test-key');
  assert.equal(startCall.headers?.['Content-Type'], 'application/json');
  assert.ok(calls.every((call) => !call.url.includes('/api/v1/browser/')));
});

test('人工查看：V2 Active 时复用 debug_port，不重复 start', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([
      ['/api/v2/browser-profile/active', () => res(true, 200, { code: 0, data: { status: 'Active', debug_port: '59167' } })],
    ], calls),
  });
  const result = await api.openProfileForInspection({
    userId: 'k1eoujd8',
    startUrl: 'https://channels.weixin.qq.com/platform/post/list',
  });
  assert.deepEqual(result, { ok: true, debugPort: 59167 });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/v2/browser-profile/active');
});

test('人工查看：V2 Inactive 但 marker 与 /json/version 匹配时接管失联浏览器', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'aidcp-electron-orphan-'));
  t.after(async () => rm(cacheRoot, { recursive: true, force: true }));
  const profileDir = join(cacheRoot, 'k1eoujd8_suffix');
  await mkdir(profileDir);
  await writeFile(join(profileDir, 'DevToolsActivePort'), '59167\n/devtools/browser/abc-123\n', 'utf8');
  const calls: Array<{ url: string }> = [];
  const logs: string[] = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    adsCacheRoot: cacheRoot,
    logImpl: (message: string) => logs.push(message),
    fetchImpl: stubFetch([
      ['/api/v2/browser-profile/active', () => res(true, 200, { code: 0, data: { status: 'Inactive' } })],
      ['/json/version', () => res(true, 200, { webSocketDebuggerUrl: 'ws://127.0.0.1:59167/devtools/browser/abc-123' })],
    ], calls),
  });
  const result = await api.openProfileForInspection({
    userId: 'k1eoujd8',
    startUrl: 'https://channels.weixin.qq.com/platform/post/list',
  });
  assert.deepEqual(result, { ok: true, debugPort: 59167 });
  assert.equal(calls.filter((call) => call.url.includes('browser-profile/start')).length, 0);
  assert.match(logs.join('\n'), /接管失联浏览器/);
});

test('人工查看拒绝任意站点，且 code=0 但无有效 debug_port 也不假报打开', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch(
      [
        ['/api/v2/browser-profile/active', () => res(true, 200, { code: 0, data: { status: 'Inactive' } })],
        ['/api/v2/browser-profile/start', () => res(true, 200, { code: 0, data: {} })],
      ],
      calls,
    ),
    adsCacheRoot: join(tmpdir(), '__aidcp_nonexistent_ads_cache__'),
  });
  const arbitrary = await api.openProfileForInspection({ userId: 'p1', startUrl: 'https://example.com/' });
  assert.equal(arbitrary.ok, false);
  assert.match(arbitrary.error || '', /只允许打开视频号助手/);
  assert.equal(calls.length, 0, '域名不合法时必须在 fetch 前拒绝');

  const missingHandle = await api.openProfileForInspection({
    userId: 'p1',
    startUrl: 'https://channels.weixin.qq.com/platform/post/list',
  });
  assert.equal(missingHandle.ok, false);
  assert.match(missingHandle.error || '', /未返回有效浏览器句柄/);
});

test('人工查看与列表共用同一条主进程 LocalAPI 串行节流', async () => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const calls: string[] = [];
  const api = createAdsLocalApi({
    nowImpl: () => clock,
    sleepImpl: async (ms: number) => { sleeps.push(ms); clock += ms; },
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('/browser-profile/active')) {
        return res(true, 200, { code: 0, data: { status: 'Inactive' } });
      }
      return String(url).includes('/browser-profile/start')
        ? res(true, 200, { code: 0, data: { debug_port: 61234 } })
        : res(true, 200, { code: 0, data: { list: [] } });
    }) as unknown as typeof fetch,
  });
  await Promise.all([
    api.listProfiles(),
    api.openProfileForInspection({ userId: 'p1', startUrl: 'https://channels.weixin.qq.com/platform/post/list' }),
  ]);
  assert.equal(calls.length, 3);
  assert.ok(sleeps.some((ms) => ms >= 1000), `预期共用串行节流，实测 sleeps=${JSON.stringify(sleeps)}`);
});

test('normalizeProfile: 真机 no_proxy（带下划线）归一为「无代理配置」', () => {
  assert.equal(normalizeProfile({ user_id: 'u', user_proxy_config: { proxy_type: 'no_proxy' } }).proxy, '无代理配置');
  assert.equal(normalizeProfile({ user_id: 'u', user_proxy_config: { proxy_type: 'noproxy' } }).proxy, '无代理配置');
  // 有真代理配置仍如实展示
  assert.match(normalizeProfile({ user_id: 'u', ip: '9.9.9.9', user_proxy_config: { proxy_type: 'socks5' } }).proxy, /socks5/);
});

test('normalizeProfile: 从 remark 解出平台（change edge-environment-platform-select）；旧环境回落 xiaohongshu', () => {
  const fbRemark = JSON.stringify({ t: 'aidcp-env', acct: '', tpl: 'win11-intel', mach: 'm', ts: 1, plat: 'facebook' });
  assert.equal(normalizeProfile({ user_id: 'u', remark: fbRemark }).platform, 'facebook');
  const xhsRemark = JSON.stringify({ t: 'aidcp-env', plat: 'xiaohongshu' });
  assert.equal(normalizeProfile({ user_id: 'u', remark: xhsRemark }).platform, 'xiaohongshu');
  // 旧环境（无 plat / 非本 change remark / 无 remark、且无任何平台信号）→ 回落 xiaohongshu
  assert.equal(normalizeProfile({ user_id: 'u', remark: JSON.stringify({ t: 'aidcp-env', tpl: 'x' }) }).platform, 'xiaohongshu');
  assert.equal(normalizeProfile({ user_id: 'u', remark: '运维随手写的备注' }).platform, 'xiaohongshu');
  assert.equal(normalizeProfile({ user_id: 'u' }).platform, 'xiaohongshu');
});

// ── change edge-client-proxy-platform-persona-ux：存量无 plat 环境的只读兜底推断（remark 权威优先） ──
test('inferPlatform: 表驱动优先级 remark > domain > urls > 关键词 > 回落', () => {
  const infer = (require('../../src/electron/ads-local-api.cjs') as { inferPlatform: (it: Record<string, unknown>) => { platform: string; platformSource: string } }).inferPlatform;
  const fbRemark = JSON.stringify({ t: 'aidcp-env', plat: 'xiaohongshu' });
  const cases: Array<[Record<string, unknown>, string, string]> = [
    // remark 权威：名称/域名信号一律让位
    [{ remark: fbRemark, domain_name: 'facebook.com', name: 'fb 主号' }, 'xiaohongshu', 'remark'],
    // 手工建的 FB 环境：domain_name 命中
    [{ domain_name: 'facebook.com' }, 'facebook', 'domain'],
    [{ domain_name: 'www.xiaohongshu.com' }, 'xiaohongshu', 'domain'],
    // open_urls 命中（字符串/数组两形态都容忍）
    [{ open_urls: ['https://www.facebook.com/'] }, 'facebook', 'urls'],
    [{ open_urls: 'https://xiaohongshu.com/explore' }, 'xiaohongshu', 'urls'],
    // 分组/名称关键词
    [{ group_name: 'FB-客户组' }, 'facebook', 'keyword'],
    [{ name: '脸书-01' }, 'facebook', 'keyword'],
    // 全空回落（与推断引入前逐位等价）
    [{}, 'xiaohongshu', 'fallback'],
    [{ name: '心机小兔' }, 'xiaohongshu', 'fallback'],
  ];
  for (const [it, plat, src] of cases) {
    const r = infer(it);
    assert.equal(r.platform, plat, JSON.stringify(it));
    assert.equal(r.platformSource, src, JSON.stringify(it));
  }
});

test('normalizeProfile: 结构化 proxyConfig 以内存态透传 AdsPower 返回的代理密码，摘要仍不含敏感值', () => {
  const p = normalizeProfile({
    user_id: 'u',
    user_proxy_config: { proxy_soft: 'other', proxy_type: 'socks5', proxy_host: '1.2.3.4', proxy_port: 1080, proxy_user: 'alice', proxy_password: 'S3cr3t!' },
  }) as unknown as { proxy: string; proxyConfig: Record<string, unknown> };
  assert.deepEqual(p.proxyConfig, { noProxy: false, proxyType: 'socks5', proxyHost: '1.2.3.4', proxyPort: '1080', proxyUser: 'alice', proxyPassword: 'S3cr3t!' });
  assert.equal('proxy_password' in p.proxyConfig, false, 'IPC 投影只使用 renderer 约定字段名');
  assert.doesNotMatch(p.proxy, /alice|S3cr3t!/, '环境列表摘要不得包含代理用户名或密码');

  const withoutPassword = normalizeProfile({
    user_id: 'u2',
    user_proxy_config: { proxy_soft: 'other', proxy_type: 'http', proxy_host: 'proxy.example', proxy_port: 8080, proxy_user: 'bob' },
  }) as unknown as { proxyConfig: { proxyPassword: string } };
  assert.equal(withoutPassword.proxyConfig.proxyPassword, '', 'AdsPower 未返回密码时必须如实为空');

  const noProxy = normalizeProfile({ user_id: 'u', user_proxy_config: { proxy_type: 'no_proxy', proxy_password: 'stale' } }) as unknown as { proxyConfig: { noProxy: boolean; proxyType: string; proxyPassword: string } };
  assert.equal(noProxy.proxyConfig.noProxy, true);
  assert.equal(noProxy.proxyConfig.proxyType, '');
  assert.equal(noProxy.proxyConfig.proxyPassword, '', '无代理配置不得透传残留密码');
});

test('listGroups: 精确查询预置分组并归一化 groupId/groupName', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/group/list', () => res(true, 200, { code: 0, data: { list: [{ group_id: 42, group_name: 'aidcp' }] } })]], calls),
  }) as unknown as { listGroups: (o?: unknown) => Promise<{ ok: boolean; groups?: Array<{ groupId: string; groupName: string }>; error?: string }> };
  const r = await api.listGroups({ groupName: 'aidcp' });
  assert.equal(r.ok, true);
  assert.equal(r.groups?.[0].groupId, '42');
  assert.equal(r.groups?.[0].groupName, 'aidcp');
  assert.ok(calls[0].url.includes('/api/v1/group/list'));
  assert.ok(calls[0].url.includes('group_name=aidcp'));
});

// ── V2 browser-profile/active 对账（edge-multi-environment-fleet：外壳重启防双拉/防互踢）──

test('listActiveProfiles：按已知 roster 逐 profile 查询 V2 active，不依赖全局 V1 列表', async () => {
  const calls: Array<{ url: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    adsCacheRoot: join(tmpdir(), '__aidcp_nonexistent_ads_cache__'),
    fetchImpl: stubFetch([
      ['profile_id=p1', () => res(true, 200, { code: 0, data: { status: 'Active', debug_port: 59167 } })],
      ['profile_id=p2', () => res(true, 200, { code: 0, data: { status: 'Inactive' } })],
      ['profile_id=p3', () => res(true, 200, { code: 0, data: { status: 'Active', debug_port: 59169 } })],
    ], calls),
  }) as unknown as { listActiveProfiles: (o?: Record<string, unknown>) => Promise<{ ok: boolean; activeUserIds?: string[]; error?: string }> };
  const r = await api.listActiveProfiles({ profileIds: ['p1', 'p2', 'p3'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.activeUserIds, ['p1', 'p3']);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => new URL(call.url).pathname === '/api/v2/browser-profile/active'));
  assert.ok(calls.every((call) => !call.url.includes('/api/v1/browser/local-active')));
});

test('listActiveProfiles：本地 API 不可达 → 诚实 ok:false（调用方按「无法对账」处理，不猜测）', async () => {
  const api = createAdsLocalApi({
    ...noThrottle,
    fetchImpl: stubFetch([['/api/v2/browser-profile/active', () => { throw new Error('ECONNREFUSED'); }]]),
  }) as unknown as { listActiveProfiles: (o?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }> };
  const r = await api.listActiveProfiles({ profileIds: ['p1'] });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /不可达/);
});

test('listActiveProfiles：缺 roster 时诚实失败，避免把未查询误判成全部已关', async () => {
  const api = createAdsLocalApi({ ...noThrottle });
  const r = await (api as unknown as { listActiveProfiles: (o?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }> })
    .listActiveProfiles();
  assert.equal(r.ok, false);
  assert.match(String(r.error), /roster/);
});

test('listActiveProfiles：V2 Inactive 的匹配 orphan 计为 active，path 不匹配的 stale marker 被拒绝', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'aidcp-electron-reconcile-'));
  t.after(async () => rm(cacheRoot, { recursive: true, force: true }));
  for (const [profileId, browserPath] of [['p1', 'expected-one'], ['p2', 'expected-two']] as const) {
    const profileDir = join(cacheRoot, `${profileId}_suffix`);
    await mkdir(profileDir);
    await writeFile(join(profileDir, 'DevToolsActivePort'), `${profileId === 'p1' ? 59167 : 59168}\n/devtools/browser/${browserPath}\n`, 'utf8');
  }
  const calls: Array<{ url: string }> = [];
  const api = createAdsLocalApi({
    ...noThrottle,
    adsCacheRoot: cacheRoot,
    fetchImpl: stubFetch([
      ['/api/v2/browser-profile/active', () => res(true, 200, { code: 0, data: { status: 'Inactive' } })],
      [':59167/json/version', () => res(true, 200, { webSocketDebuggerUrl: 'ws://127.0.0.1:59167/devtools/browser/expected-one' })],
      [':59168/json/version', () => res(true, 200, { webSocketDebuggerUrl: 'ws://127.0.0.1:59168/devtools/browser/different' })],
    ], calls),
  }) as unknown as { listActiveProfiles: (o?: Record<string, unknown>) => Promise<{ ok: boolean; activeUserIds?: string[] }> };
  const r = await api.listActiveProfiles({ profileIds: ['p1', 'p2'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.activeUserIds, ['p1']);
});
