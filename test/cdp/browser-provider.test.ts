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
  assert.match(decoded, /--lang=en-US/); // C1: 界面语言钉英文（兜登出 chrome，见 facebook-locale-pin-en-us）
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

// ---- AdsPowerProvider.killAndConfirmDead：权威端点实证 + 升级实杀 + 诚实未确认 ----
// 关闭确认以「该 profile 调试端点是否变暗」为权威判据（独立于 AdsPower 自报），软停止未生效则升级
// （重发 + OS 级强杀）；无法确认端点变暗时诚实 false，绝不假成功（红线）。

// launch 所需的最小路由（browser/start + waitCdpReady 用 /json/version）+ browser/stop。
const adsCloseFetch = (extra: Array<[string, () => unknown]> = []): typeof fetch =>
  routedFetch([
    ['/api/v1/browser/start', () => ({ code: 0, data: { debug_port: 5000 } })],
    ['/json/version', () => ({})],
    ['/api/v1/browser/stop', () => ({ code: 0 })],
    ...extra,
  ]);
const closeBounds = { closeConfirmTries: 3, closeConfirmIntervalMs: 0 };

test('killAndConfirmDead：软停止后调试端点变暗 → 确认已关 true', async () => {
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    { fetchImpl: adsCloseFetch(), ...noopDeps, ...closeBounds, probeCdpImpl: async () => false, osKillEnabled: false },
  );
  const { instance } = await provider.launch({ host: '127.0.0.1', port: 9222 });
  assert.equal(await instance.killAndConfirmDead(), true);
});

test('killAndConfirmDead：软停止未使端点变暗 + OS 级强杀成功 → 升级后 true', async () => {
  let osKilled = false;
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    {
      fetchImpl: adsCloseFetch(),
      ...noopDeps,
      ...closeBounds,
      probeCdpImpl: async () => !osKilled, // OS 杀前一直应答（浏览器仍活），杀后变暗
      osKillEnabled: true,
      osKillImpl: async () => {
        osKilled = true;
        return true;
      },
    },
  );
  const { instance } = await provider.launch({ host: '127.0.0.1', port: 9222 });
  assert.equal(await instance.killAndConfirmDead(), true);
  assert.equal(osKilled, true);
});

test('killAndConfirmDead：端点一直应答 + OS 杀禁用 → 诚实 false（绝不假成功）', async () => {
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    { fetchImpl: adsCloseFetch(), ...noopDeps, ...closeBounds, probeCdpImpl: async () => true, osKillEnabled: false },
  );
  const { instance } = await provider.launch({ host: '127.0.0.1', port: 9222 });
  assert.equal(await instance.killAndConfirmDead(), false);
});

test('killAndConfirmDead：端点一直应答 + OS 杀也没杀掉 → 诚实 false', async () => {
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    {
      fetchImpl: adsCloseFetch(),
      ...noopDeps,
      ...closeBounds,
      probeCdpImpl: async () => true,
      osKillEnabled: true,
      osKillImpl: async () => false, // 拿不到可杀进程
    },
  );
  const { instance } = await provider.launch({ host: '127.0.0.1', port: 9222 });
  assert.equal(await instance.killAndConfirmDead(), false);
});

test('killAndConfirmDead：browser/stop 失败但端点变暗 → 端点权威判 true，且如实记 stop 失败', async () => {
  const logs: string[] = [];
  const fetchImpl = routedFetch([
    ['/api/v1/browser/start', () => ({ code: 0, data: { debug_port: 5000 } })],
    ['/json/version', () => ({})],
    ['/api/v1/browser/stop', () => ({ code: -1, msg: 'stop failed' })], // api() 抛错 → stop 记失败
  ]);
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    {
      fetchImpl,
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      logImpl: (m) => logs.push(m),
      ...closeBounds,
      probeCdpImpl: async () => false, // 端点已暗 = 真死
      osKillEnabled: false,
    },
  );
  const { instance } = await provider.launch({ host: '127.0.0.1', port: 9222 });
  assert.equal(await instance.killAndConfirmDead(), true);
  assert.match(logs.join('\n'), /browser\/stop 失败/);
});

test('killAndConfirmDead：stop API 不可达 + 端点仍应答 → 不再「查不动当已关」，诚实 false', async () => {
  // 老 bug 反例：停止 API 抛错曾被静默吞 + confirmClosed 查不动返回 true。新逻辑以端点为权威，端口仍应答=未死。
  const fetchImpl = routedFetch([
    ['/api/v1/browser/start', () => ({ code: 0, data: { debug_port: 5000 } })],
    ['/json/version', () => ({})],
    // 不路由 browser/stop → api() 抛 unrouted → stop 如实记失败、不当已关
  ]);
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    { fetchImpl, ...noopDeps, ...closeBounds, probeCdpImpl: async () => true, osKillEnabled: false },
  );
  const { instance } = await provider.launch({ host: '127.0.0.1', port: 9222 });
  assert.equal(await instance.killAndConfirmDead(), false);
});

test('killAndConfirmDead：单次瞬态不应答（非连续）不判已关 → 不假成功（K=2 连读闸）', async () => {
  // probe 交替 应答/不应答：任何时刻都凑不出连续 2 次不应答 → 绝不据单次瞬态误判已关。
  let n = 0;
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    {
      fetchImpl: adsCloseFetch(),
      ...noopDeps,
      ...closeBounds,
      probeCdpImpl: async () => n++ % 2 === 0, // true,false,true,false… 无连续两次 false
      osKillEnabled: false,
    },
  );
  const { instance } = await provider.launch({ host: '127.0.0.1', port: 9222 });
  assert.equal(await instance.killAndConfirmDead(), false);
});

test('默认关闭探测：stop 后 /json/version 连接被拒 → 判真死 true（超时=仍活、被拒=已死）', async () => {
  // 用默认 probeCdpImpl（带超时的 defaultProbeAlive）：启动期端点应答；关闭后端口被拒即真死。
  let stopped = false;
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes('/api/v1/browser/start')) {
      return { ok: true, json: async () => ({ code: 0, data: { debug_port: 5000 } }) } as unknown;
    }
    if (u.includes('/api/v1/browser/stop')) {
      stopped = true;
      return { ok: true, json: async () => ({ code: 0 }) } as unknown;
    }
    if (u.includes('/json/version')) {
      if (!stopped) return { ok: true, json: async () => ({}) } as unknown; // 启动就绪
      throw new Error('ECONNREFUSED'); // 关闭后端口被拒 = 已死
    }
    throw new Error(`unrouted ${u}`);
  }) as unknown as typeof fetch;
  const provider = new AdsPowerProvider(
    { apiBase: 'http://x:50325', userId: 'k1' },
    { fetchImpl, ...noopDeps, ...closeBounds, closeProbeTimeoutMs: 50, osKillEnabled: false }, // 不注入 probeCdpImpl → 走默认
  );
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
