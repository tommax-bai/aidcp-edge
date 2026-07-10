import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SelfChromeProvider,
  AdsPowerProvider,
  selectBrowserProvider,
} from '../../src/cdp/index.js';
import type { ChromeInstance } from '../../src/cdp/index.js';

const fakeInstance: ChromeInstance = {
  pid: 4321,
  reused: false,
  kill: () => undefined,
  killAndConfirmDead: async () => true,
};

const noopDeps = { sleepImpl: async () => undefined, logImpl: () => undefined, nowImpl: () => 0 };

/** 路由式 fetch 桩：按 url 子串返回 {ok,json}；记录每次调用的 url 与 headers。 */
function routedFetch(
  routes: Array<[string, () => unknown]>,
  calls: Array<{ url: string; headers?: Record<string, string> }> = [],
): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers });
    for (const [pat, body] of routes) {
      if (String(url).includes(pat)) return { ok: true, json: async () => body() } as unknown;
    }
    throw new Error(`unrouted ${String(url)}`);
  }) as unknown as typeof fetch;
}

// ---- SelfChromeProvider ----

test('SelfChromeProvider 透传 launchChrome 入参与返回，端点=传入端点', async () => {
  let seen: { port?: number; profileDir?: string; headless?: boolean } | undefined;
  const provider = new SelfChromeProvider((opts) => {
    seen = { port: opts?.port, profileDir: opts?.profileDir, headless: opts?.headless };
    return Promise.resolve(fakeInstance);
  });
  const out = await provider.launch({ host: '127.0.0.1', port: 9222, profileDir: '/p', headless: true });
  assert.equal(out.instance, fakeInstance);
  assert.deepEqual(out.endpoint, { host: '127.0.0.1', port: 9222 });
  assert.equal(seen?.port, 9222);
  assert.equal(seen?.profileDir, '/p');
  assert.equal(seen?.headless, true);
});

// ---- AdsPowerProvider.launch ----

test('AdsPowerProvider.launch 成功 → 端点带 debug_port、实例非 reused，含视口+起始页+Bearer', async () => {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchImpl = routedFetch(
    [
      ['/api/v1/browser/start', () => ({ code: 0, data: { debug_port: 61332 } })],
      ['/json/version', () => ({})],
    ],
    calls,
  );
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1', apiKey: 'secret' },
    { fetchImpl, ...noopDeps },
  );
  const out = await provider.launch({ host: '127.0.0.1', port: 9222, windowPosition: { left: 1902, top: 0 } });
  assert.equal(out.endpoint.port, 61332);
  assert.equal(out.endpoint.host, '127.0.0.1');
  assert.equal(out.instance.reused, false);
  assert.equal(out.instance.pid, null);
  const startCall = calls.find((c) => c.url.includes('browser/start'));
  assert.ok(startCall);
  const decoded = decodeURIComponent(startCall.url);
  assert.match(decoded, /--window-size=1440,980/);
  assert.match(decoded, /--deny-permission-prompts/);
  assert.match(decoded, /--window-position=1902,0/);
  assert.match(decoded, /xiaohongshu\.com/);
  assert.equal(startCall.headers?.Authorization, 'Bearer secret');
});

test('AdsPowerProvider.launch 支持平台 driver 注入起始页', async () => {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchImpl = routedFetch(
    [
      ['/api/v1/browser/start', () => ({ code: 0, data: { debug_port: 61332 } })],
      ['/json/version', () => ({})],
    ],
    calls,
  );
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1', startUrl: 'https://example.test/home' },
    { fetchImpl, ...noopDeps },
  );
  await provider.launch({ host: '127.0.0.1', port: 9222 });
  const startCall = calls.find((c) => c.url.includes('browser/start'));
  assert.ok(startCall);
  assert.match(decodeURIComponent(startCall.url), /https:\/\/example\.test\/home/);
});

test('AdsPowerProvider.launch code≠0 → 诚实报错（不回落 self）', async () => {
  const fetchImpl = routedFetch([
    ['/api/v1/browser/start', () => ({ code: -1, msg: 'Profile does not exist' })],
  ]);
  const provider = new AdsPowerProvider({ apiBase: 'http://x:50325', userId: 'k1' }, { fetchImpl, ...noopDeps });
  await assert.rejects(provider.launch({ host: '127.0.0.1', port: 9222 }), /code=-1|不回落 self/);
});

test('AdsPowerProvider.launch 无 debug_port → 诚实报错', async () => {
  const fetchImpl = routedFetch([['/api/v1/browser/start', () => ({ code: 0, data: {} })]]);
  const provider = new AdsPowerProvider({ apiBase: 'http://x:50325', userId: 'k1' }, { fetchImpl, ...noopDeps });
  await assert.rejects(provider.launch({ host: '127.0.0.1', port: 9222 }), /debug_port/);
});

test('AdsPowerProvider.launch API 不可达 → 诚实报错（不回落 self）', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const provider = new AdsPowerProvider({ apiBase: 'http://x:50325', userId: 'k1' }, { fetchImpl, ...noopDeps });
  await assert.rejects(provider.launch({ host: '127.0.0.1', port: 9222 }), /不可达|不回落 self/);
});

test('AdsPowerProvider.launch API 半开无响应 → 有界超时并诚实报错', async () => {
  const fetchImpl = ((url: string, init?: { signal?: AbortSignal }) => {
    assert.match(String(url), /browser\/start/);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    { fetchImpl, sleepImpl: async () => undefined, logImpl: (m) => logs.push(m), nowImpl: () => 0, apiTimeoutMs: 5 },
  );
  await assert.rejects(provider.launch({ host: '127.0.0.1', port: 9222 }), /browser\/start 超时|不回落 self/);
  assert.match(logs.join('\n'), /请求 AdsPower browser\/start profile=k1/);
});

test('AdsPowerProvider.launch API 响应体卡住 → 有界超时并诚实报错', async () => {
  const fetchImpl = (async () => ({
    ok: true,
    json: async () => new Promise(() => undefined),
  })) as unknown as typeof fetch;
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    { fetchImpl, ...noopDeps, apiTimeoutMs: 5 },
  );
  await assert.rejects(provider.launch({ host: '127.0.0.1', port: 9222 }), /响应异常|响应 超时|不回落 self/);
});

test('AdsPowerProvider killAndConfirmDead：stop + active 确认已关 → true', async () => {
  const fetchImpl = routedFetch([
    ['/api/v1/browser/start', () => ({ code: 0, data: { debug_port: 5000 } })],
    ['/json/version', () => ({})],
    ['/api/v1/browser/stop', () => ({ code: 0 })],
    ['/api/v1/browser/active', () => ({ code: 0, data: { status: 'Inactive' } })],
  ]);
  const provider = new AdsPowerProvider({ apiBase: 'http://x:50325', userId: 'k1' }, { fetchImpl, ...noopDeps });
  const { instance } = await provider.launch({ host: '127.0.0.1', port: 9222 });
  assert.equal(await instance.killAndConfirmDead(), true);
});

// ---- selectBrowserProvider ----

test('selectBrowserProvider 默认 adspower（缺 user_id → 诚实报错，不静默 self）', () => {
  assert.throws(() => selectBrowserProvider({ env: {} as NodeJS.ProcessEnv }), /AIDCP_ADS_USER_ID/);
});

test('selectBrowserProvider 默认 adspower 全配（仅 user_id）→ adspower', () => {
  assert.equal(selectBrowserProvider({ env: { AIDCP_ADS_USER_ID: 'k1' } as NodeJS.ProcessEnv }).kind, 'adspower');
});

test('selectBrowserProvider 显式 self', () => {
  assert.equal(
    selectBrowserProvider({ env: { AIDCP_BROWSER_PROVIDER: 'self' } as NodeJS.ProcessEnv }).kind,
    'self',
  );
});

test('selectBrowserProvider adspower 全配 → AdsPowerProvider', () => {
  const p = selectBrowserProvider({
    env: { AIDCP_BROWSER_PROVIDER: 'adspower', AIDCP_ADS_USER_ID: 'k1' } as NodeJS.ProcessEnv,
  });
  assert.equal(p.kind, 'adspower');
});

test('selectBrowserProvider accepts driver-provided startUrl without changing provider selection', () => {
  const p = selectBrowserProvider({
    env: { AIDCP_BROWSER_PROVIDER: 'adspower', AIDCP_ADS_USER_ID: 'k1' } as NodeJS.ProcessEnv,
    startUrl: 'https://example.test/home',
  });
  assert.equal(p.kind, 'adspower');
});

test('selectBrowserProvider adspower 缺 user_id → 诚实报错', () => {
  assert.throws(
    () => selectBrowserProvider({ env: { AIDCP_BROWSER_PROVIDER: 'adspower' } as NodeJS.ProcessEnv }),
    /AIDCP_ADS_USER_ID/,
  );
});

test('selectBrowserProvider 未知 kind → 诚实报错', () => {
  assert.throws(
    () => selectBrowserProvider({ env: { AIDCP_BROWSER_PROVIDER: 'foo' } as NodeJS.ProcessEnv }),
    /未知|仅支持/,
  );
});
