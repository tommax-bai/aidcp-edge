import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import {
  launchChrome,
  discoverChromePath,
  probeCdp,
  buildChromeArgs,
  deriveLoginProbeResult,
  evaluateLoginState,
  ensurePageTarget,
  clearStaleSingletonLock,
  type CdpWsLike,
} from '../../src/cdp/index.js';

/** 构造一个最小可用的假 fetch（按 url -> ok 映射） */
function fakeFetch(ok: boolean): typeof fetch {
  return (async () => ({ ok }) as Response) as unknown as typeof fetch;
}

/** 记录 spawn 调用，返回一个带 pid 的假子进程 */
function makeSpawn(pid = 4242) {
  const calls: { cmd: string; args: string[]; opts: unknown }[] = [];
  let killCount = 0;
  const child = {
    pid,
    on: () => child,
    kill: () => {
      killCount += 1;
      return true;
    },
  } as unknown as ChildProcess;
  const spawnImpl = ((cmd: string, args: string[], opts: unknown) => {
    calls.push({ cmd, args, opts });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return {
    spawnImpl,
    calls,
    killCount: () => killCount,
  };
}

const noSleep = async () => undefined;
const noLog = () => undefined;

// ---------------- discoverChromePath ----------------

test('discoverChromePath 优先使用显式路径（存在时）', () => {
  const p = discoverChromePath('C:/custom/chrome.exe', (x) => x === 'C:/custom/chrome.exe');
  assert.equal(p, 'C:/custom/chrome.exe');
});

test('discoverChromePath 显式路径不存在时抛错', () => {
  assert.throws(() => discoverChromePath('C:/missing.exe', () => false), /不存在/);
});

test('discoverChromePath 回退到常见 Windows 路径', () => {
  const target = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const p = discoverChromePath(undefined, (x) => x === target);
  assert.equal(p, target);
});

test('discoverChromePath 全部找不到时抛明确错误', () => {
  assert.throws(() => discoverChromePath(undefined, () => false), /未找到 Chrome/);
});

// ---------------- probeCdp ----------------

test('probeCdp 在 /json/version 200 时返回 true', async () => {
  assert.equal(await probeCdp('127.0.0.1', 9222, fakeFetch(true)), true);
});

test('probeCdp 在 fetch 抛错时返回 false', async () => {
  const throwing = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  assert.equal(await probeCdp('127.0.0.1', 9222, throwing), false);
});

// ---------------- buildChromeArgs ----------------

test('buildChromeArgs 含全部硬性调试参数', () => {
  const args = buildChromeArgs({
    port: 9222,
    profileDir: '/tmp/p',
    headless: false,
    startUrl: 'https://www.xiaohongshu.com/explore',
  });
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--no-default-browser-check'));
  assert.ok(args.includes('--disable-session-crashed-bubble'));
  assert.ok(args.includes('--hide-crash-restore-bubble'));
  assert.ok(args.includes('--deny-permission-prompts'));
  assert.ok(args.includes('--user-data-dir=/tmp/p'));
  assert.equal(args[args.length - 1], 'https://www.xiaohongshu.com/explore');
  assert.ok(!args.includes('--headless=new'));
});

test('buildChromeArgs headless 时追加 --headless=new', () => {
  const args = buildChromeArgs({ port: 1, profileDir: 'd', headless: true, startUrl: 'u' });
  assert.ok(args.includes('--headless=new'));
});

test('buildChromeArgs 带窗口位置提示', () => {
  const args = buildChromeArgs({
    port: 1,
    profileDir: 'd',
    headless: false,
    windowPosition: { left: 1902, top: 0 },
    startUrl: 'u',
  });
  assert.ok(args.includes('--window-position=1902,0'));
});

test('buildChromeArgs 含反检测启动参数且不含 --enable-automation', () => {
  const args = buildChromeArgs({
    port: 9222,
    profileDir: '/tmp/p',
    headless: false,
    startUrl: 'https://www.xiaohongshu.com/explore',
  });
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(args.includes('--disable-infobars'));
  assert.ok(!args.includes('--enable-automation'));
});

// ---------------- launchChrome：拒绝静默接管 / 显式复用 ----------------

test('launchChrome 探测到端口已有 Chrome 时默认诚实报错（拒绝静默接管，不 spawn）', async () => {
  const sp = makeSpawn();
  await assert.rejects(
    () =>
      launchChrome({
        fetchImpl: fakeFetch(true),
        spawnImpl: sp.spawnImpl,
        existsImpl: () => true,
        sleepImpl: noSleep,
        logImpl: noLog,
        waitForLoginImpl: async () => {},
        ensurePageTargetImpl: async () => {},
      }),
    /拒绝静默接管/,
  );
  // 既不接管也不另起进程
  assert.equal(sp.calls.length, 0);
});

test('launchChrome 显式 allowReuse 时复用已有实例（端口已就绪，不 spawn）', async () => {
  const sp = makeSpawn();
  const inst = await launchChrome({
    allowReuse: true,
    fetchImpl: fakeFetch(true),
    spawnImpl: sp.spawnImpl,
    existsImpl: () => true,
    sleepImpl: noSleep,
    logImpl: noLog,
    waitForLoginImpl: async () => {},
    ensurePageTargetImpl: async () => {},
  });
  assert.equal(inst.reused, true);
  assert.equal(inst.pid, null);
  assert.equal(sp.calls.length, 0);
  // 复用实例的 kill 不应抛错
  inst.kill();
});

// ---------------- clearStaleSingletonLock：陈旧锁清理 / 诚实失败 ----------------

test('clearStaleSingletonLock 无锁时正常返回（readlink 抛错）', () => {
  assert.doesNotThrow(() =>
    clearStaleSingletonLock('/data/profile', noLog, {
      readlink: () => {
        throw new Error('ENOENT');
      },
    }),
  );
});

test('clearStaleSingletonLock 持有进程已死则清理陈旧锁', () => {
  let unlinked = '';
  clearStaleSingletonLock('/data/profile', noLog, {
    readlink: () => 'myhost-4242',
    localHostname: () => 'myhost',
    isProcessAlive: () => false,
    unlink: (p) => {
      unlinked = p;
    },
  });
  assert.ok(unlinked.endsWith('SingletonLock'));
});

test('clearStaleSingletonLock 持有进程仍存活则诚实失败（绝不强删）', () => {
  let unlinked = false;
  assert.throws(
    () =>
      clearStaleSingletonLock('/data/profile', noLog, {
        readlink: () => 'myhost-4242',
        localHostname: () => 'myhost',
        isProcessAlive: () => true,
        unlink: () => {
          unlinked = true;
        },
      }),
    /存活进程/,
  );
  assert.equal(unlinked, false);
});

test('clearStaleSingletonLock 锁由其它主机持有则诚实失败（无法判定存活）', () => {
  assert.throws(
    () =>
      clearStaleSingletonLock('/data/profile', noLog, {
        readlink: () => 'otherhost-4242',
        localHostname: () => 'myhost',
        isProcessAlive: () => false,
      }),
    /其它主机/,
  );
});

test('clearStaleSingletonLock 解析不出 pid 则诚实失败（绝不盲删）', () => {
  assert.throws(
    () =>
      clearStaleSingletonLock('/data/profile', noLog, {
        readlink: () => 'garbage-without-pid-xx',
        localHostname: () => 'garbage-without-pid-xx',
        isProcessAlive: () => false,
      }),
    /无法解析/,
  );
});

// ---------------- launchChrome：启动 ----------------

test('launchChrome 端口空闲时 spawn 并传入正确参数', async () => {
  const sp = makeSpawn(777);
  // 第一次 probe 返回 false（未就绪），后续返回 true（已就绪）
  let n = 0;
  const fetchImpl = (async () => ({ ok: n++ > 0 }) as Response) as unknown as typeof fetch;
  const inst = await launchChrome({
    chromePath: 'C:/chrome.exe',
    profileDir: '/data/profile',
    fetchImpl,
    spawnImpl: sp.spawnImpl,
    existsImpl: (p) => p === 'C:/chrome.exe' || p === '/data/profile',
    sleepImpl: noSleep,
    logImpl: noLog,
    waitForLoginImpl: async () => {},
  });
  assert.equal(inst.reused, false);
  assert.equal(inst.pid, 777);
  assert.equal(sp.calls.length, 1);
  const call = sp.calls[0]!;
  assert.equal(call.cmd, 'C:/chrome.exe');
  assert.ok(call.args.includes('--remote-debugging-port=9222'));
  assert.ok(call.args.includes('--user-data-dir=/data/profile'));
});

test('launchChrome 自己启动的实例 kill 会真正调用 child.kill', async () => {
  const sp = makeSpawn();
  const inst = await launchChrome({
    chromePath: 'C:/chrome.exe',
    profileDir: '/data/profile',
    fetchImpl: (() => {
      let n = 0;
      return (async () => ({ ok: n++ > 0 }) as Response) as unknown as typeof fetch;
    })(),
    spawnImpl: sp.spawnImpl,
    existsImpl: () => true,
    sleepImpl: noSleep,
    logImpl: noLog,
    waitForLoginImpl: async () => {},
  });
  inst.kill();
  inst.kill(); // 幂等
  assert.equal(sp.killCount(), 1);
});

test('launchChrome 就绪超时时抛错并 kill 子进程', async () => {
  const sp = makeSpawn();
  await assert.rejects(
    launchChrome({
      chromePath: 'C:/chrome.exe',
      profileDir: '/data/profile',
      readyTimeoutMs: 0,
      fetchImpl: fakeFetch(false),
      spawnImpl: sp.spawnImpl,
      existsImpl: () => true,
      sleepImpl: noSleep,
      logImpl: noLog,
    }),
    /就绪超时/,
  );
  assert.equal(sp.killCount(), 1);
});

test('launchChrome 首次启动（profile 不存在）等待人工登录', async () => {
  const sp = makeSpawn();
  let waited = false;
  let ctxHost = '';
  let n = 0;
  const fetchImpl = (async () => ({ ok: n++ > 0 }) as Response) as unknown as typeof fetch;
  await launchChrome({
    chromePath: 'C:/chrome.exe',
    profileDir: '/data/new-profile',
    fetchImpl,
    spawnImpl: sp.spawnImpl,
    // chrome 存在，但 profile 目录不存在 -> 首次启动
    existsImpl: (p) => p === 'C:/chrome.exe',
    sleepImpl: noSleep,
    logImpl: noLog,
    waitForLoginImpl: async (ctx) => {
      waited = true;
      ctxHost = ctx.host;
    },
  });
  assert.equal(waited, true);
  assert.equal(ctxHost, '127.0.0.1');
});

test('launchChrome 非首次启动（profile 已存在）仍验证登录态', async () => {
  const sp = makeSpawn();
  let waited = false;
  let n = 0;
  const fetchImpl = (async () => ({ ok: n++ > 0 }) as Response) as unknown as typeof fetch;
  await launchChrome({
    chromePath: 'C:/chrome.exe',
    profileDir: '/data/profile',
    fetchImpl,
    spawnImpl: sp.spawnImpl,
    existsImpl: () => true,
    sleepImpl: noSleep,
    logImpl: noLog,
    waitForLoginImpl: async () => {
      waited = true;
    },
  });
  // 新逻辑：始终验证登录态，不再跳过非首次启动
  assert.equal(waited, true);
});

test('launchChrome 首次启动时透传登录轮询配置', async () => {
  const sp = makeSpawn();
  let capturedTimeout = 0;
  let capturedInterval = 0;
  let n = 0;
  const fetchImpl = (async () => ({ ok: n++ > 0 }) as Response) as unknown as typeof fetch;
  await launchChrome({
    chromePath: 'C:/chrome.exe',
    profileDir: '/data/new-profile',
    loginTimeoutMs: 12_345,
    loginPollIntervalMs: 678,
    fetchImpl,
    spawnImpl: sp.spawnImpl,
    existsImpl: (p) => p === 'C:/chrome.exe',
    sleepImpl: noSleep,
    logImpl: noLog,
    waitForLoginImpl: async (ctx) => {
      capturedTimeout = ctx.timeoutMs;
      capturedInterval = ctx.pollIntervalMs;
    },
  });
  assert.equal(capturedTimeout, 12_345);
  assert.equal(capturedInterval, 678);
});

test('deriveLoginProbeResult: web_session 命中即返回已登录', () => {
  const result = deriveLoginProbeResult({
    href: 'https://www.xiaohongshu.com/explore',
    hasUserCookie: true,
    hasUserStorage: false,
    hasAvatar: false,
    hasCreatorEntry: false,
    hasLoginPrompt: false,
  });
  assert.equal(result.loggedIn, true);
  assert.equal(result.reason, 'web_session');
});

test('deriveLoginProbeResult: 登录提示存在时不误判成功', () => {
  const result = deriveLoginProbeResult({
    href: 'https://www.xiaohongshu.com/explore',
    hasUserCookie: true,
    hasUserStorage: true,
    hasAvatar: true,
    hasCreatorEntry: true,
    hasLoginPrompt: true,
  });
  assert.equal(result.loggedIn, false);
  assert.equal(result.reason, 'login-prompt');
});

test('deriveLoginProbeResult: 无 web_session 时单个 DOM 信号不足以判定已登录（修复匿名 cookie/头像误判）', () => {
  // 历史误判：未登录的 explore 也有 feed 作者头像 / 匿名 cookie；任一单信号都不应放行。
  for (const partial of [
    { hasAvatar: true },
    { hasCreatorEntry: true },
    { hasUserStorage: true },
  ]) {
    const result = deriveLoginProbeResult({
      href: 'https://www.xiaohongshu.com/explore',
      hasUserCookie: false,
      hasUserStorage: false,
      hasAvatar: false,
      hasCreatorEntry: false,
      hasLoginPrompt: false,
      ...partial,
    });
    assert.equal(result.loggedIn, false, `partial=${JSON.stringify(partial)}`);
    assert.equal(result.reason, 'signals-missing');
  }
});

test('deriveLoginProbeResult: 无 web_session 但 nav头像&&创作入口 兜底判定已登录', () => {
  const result = deriveLoginProbeResult({
    href: 'https://www.xiaohongshu.com/explore',
    hasUserCookie: false,
    hasUserStorage: false,
    hasAvatar: true,
    hasCreatorEntry: true,
    hasLoginPrompt: false,
  });
  assert.equal(result.loggedIn, true);
  assert.equal(result.reason, 'avatar+creator-entry');
});

test('deriveLoginProbeResult: /login URL 一律判未登录', () => {
  const result = deriveLoginProbeResult({
    href: 'https://www.xiaohongshu.com/login',
    hasUserCookie: true,
    hasUserStorage: true,
    hasAvatar: true,
    hasCreatorEntry: true,
    hasLoginPrompt: false,
  });
  assert.equal(result.loggedIn, false);
  assert.equal(result.reason, 'login-url');
});

test('launchChrome 首次启动时检测到登录即继续', async () => {
  const sp = makeSpawn();
  let n = 0;
  const logs: string[] = [];
  const fetchImpl = (async () => ({ ok: n++ > 0 }) as Response) as unknown as typeof fetch;
  await launchChrome({
    chromePath: 'C:/chrome.exe',
    profileDir: '/data/new-profile',
    fetchImpl,
    spawnImpl: sp.spawnImpl,
    existsImpl: (p) => p === 'C:/chrome.exe',
    sleepImpl: noSleep,
    logImpl: (msg) => logs.push(msg),
    probeLoginImpl: async () => ({
      loggedIn: true,
      reason: 'cookie+avatar',
      url: 'https://www.xiaohongshu.com/explore',
    }),
  });
  assert.ok(logs.some((msg) => msg.includes('已检测到登录，继续')));
});

// ---------------- ensurePageTarget ----------------

/** 按 URL 路由的假 fetch：/json 返回 targets；/json/new 按配置返回 ok。 */
function makeTargetFetch(opts: {
  targets: Array<{ type: string; webSocketDebuggerUrl?: string; url?: string }>;
  newPutOk?: boolean;
  newGetOk?: boolean;
}) {
  const calls: { url: string; method: string }[] = [];
  const impl = (async (url: string | URL, init?: { method?: string }) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: u, method });
    if (u.endsWith('/json')) {
      return { ok: true, json: async () => opts.targets } as unknown as Response;
    }
    if (u.includes('/json/new')) {
      const ok = method === 'PUT' ? (opts.newPutOk ?? false) : (opts.newGetOk ?? false);
      return { ok, status: ok ? 200 : 405 } as unknown as Response;
    }
    return { ok: true } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('ensurePageTarget 已有可用 page target 时不新开标签', async () => {
  const f = makeTargetFetch({
    targets: [{ type: 'page', webSocketDebuggerUrl: 'ws://x', url: 'https://www.xiaohongshu.com/explore' }],
  });
  await ensurePageTarget('127.0.0.1', 9222, 'https://www.xiaohongshu.com/explore', f.impl, () => {});
  assert.equal(f.calls.some((c) => c.url.includes('/json/new')), false, '已有标签时不应调用 /json/new');
});

test('ensurePageTarget 无可用 page target 时 PUT 新开一个标签', async () => {
  // browser 级 target + 一个无 webSocketDebuggerUrl 的 page（都不算可用）
  const f = makeTargetFetch({ targets: [{ type: 'browser' }, { type: 'page' }], newPutOk: true });
  await ensurePageTarget('127.0.0.1', 9222, 'https://www.xiaohongshu.com/explore', f.impl, () => {});
  const newCall = f.calls.find((c) => c.url.includes('/json/new'));
  assert.ok(newCall, '无可用标签时应调用 /json/new');
  assert.equal(newCall!.method, 'PUT');
  assert.ok(newCall!.url.includes('xiaohongshu.com/explore'));
});

test('ensurePageTarget PUT 不支持时回退 GET', async () => {
  const f = makeTargetFetch({ targets: [], newPutOk: false, newGetOk: true });
  await ensurePageTarget('127.0.0.1', 9222, 'u', f.impl, () => {});
  const methods = f.calls.filter((c) => c.url.includes('/json/new')).map((c) => c.method);
  assert.deepEqual(methods, ['PUT', 'GET'], '应先试 PUT 再回退 GET');
});

test('ensurePageTarget 新开失败时抛错', async () => {
  const f = makeTargetFetch({ targets: [], newPutOk: false, newGetOk: false });
  await assert.rejects(
    ensurePageTarget('127.0.0.1', 9222, 'u', f.impl, () => {}),
    /无法在复用的 Chrome 中新开页面标签/,
  );
});

// ---------------- evaluateLoginState（CDP 路径：getCookies + DOM 信号 + 兜底） ----------------

/** 假 fetch：/json 返回给定 targets。 */
function makeJsonFetch(targets: Array<{ type: string; url?: string; webSocketDebuggerUrl?: string }>): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => targets,
  })) as unknown as typeof fetch;
}

/**
 * 假 CDP WebSocket 工厂：记录发出的帧；按 method 回复。
 * - Runtime.evaluate → { result: { value: domSignals } }
 * - Network.getCookies → { cookies }（cookiesError 为 true 时回 error）
 */
function makeFakeWsFactory(opts: {
  domSignals: Record<string, unknown>;
  cookies: Array<{ name: string; value: string }>;
  cookiesError?: boolean;
  sent: Array<{ method: string; params: Record<string, unknown> }>;
}): (url: string) => CdpWsLike {
  return () => {
    let msgHandler: ((ev?: { data?: unknown }) => void) | undefined;
    let openHandler: ((ev?: { data?: unknown }) => void) | undefined;
    const ws: CdpWsLike = {
      addEventListener(type, handler) {
        if (type === 'open') openHandler = handler;
        else if (type === 'message') msgHandler = handler;
      },
      send(data: string) {
        const msg = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
        opts.sent.push({ method: msg.method, params: msg.params ?? {} });
        let payload: Record<string, unknown>;
        if (msg.method === 'Runtime.evaluate') {
          payload = { id: msg.id, result: { result: { value: opts.domSignals } } };
        } else if (msg.method === 'Network.getCookies') {
          payload = opts.cookiesError
            ? { id: msg.id, error: { message: 'getCookies unavailable' } }
            : { id: msg.id, result: { cookies: opts.cookies } };
        } else {
          payload = { id: msg.id, result: {} };
        }
        setImmediate(() => msgHandler?.({ data: JSON.stringify(payload) }));
      },
      close() {},
    };
    setImmediate(() => openHandler?.());
    return ws;
  };
}

const XHS_TARGETS = [
  { type: 'page', url: 'https://www.xiaohongshu.com/explore', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/X' },
];

test('evaluateLoginState: web_session 存在且无登录提示 → 已登录，且 getCookies 限定 xiaohongshu 作用域', async () => {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const wsFactory = makeFakeWsFactory({
    domSignals: { href: 'https://www.xiaohongshu.com/explore', hasUserStorage: false, hasAvatar: false, hasCreatorEntry: false, hasLoginPrompt: false },
    cookies: [{ name: 'web_session', value: 'abc123def456' }],
    sent,
  });
  const res = await evaluateLoginState('127.0.0.1', 9222, makeJsonFetch(XHS_TARGETS), wsFactory);
  assert.equal(res.loggedIn, true);
  assert.ok(res.reason.includes('web_session'));
  const getCookies = sent.find((s) => s.method === 'Network.getCookies');
  assert.ok(getCookies, '应调用 Network.getCookies');
  assert.ok(Array.isArray(getCookies!.params.urls), 'getCookies 应显式传 urls 作用域');
  assert.ok((getCookies!.params.urls as string[]).some((u) => u.includes('xiaohongshu.com')), 'urls 应限定到 xiaohongshu.com');
});

test('evaluateLoginState: 空 web_session 值不算登录', async () => {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const res = await evaluateLoginState('127.0.0.1', 9222, makeJsonFetch(XHS_TARGETS), makeFakeWsFactory({
    domSignals: { href: 'https://www.xiaohongshu.com/explore', hasUserStorage: false, hasAvatar: false, hasCreatorEntry: false, hasLoginPrompt: false },
    cookies: [{ name: 'web_session', value: '   ' }],
    sent,
  }));
  assert.equal(res.loggedIn, false);
});

test('evaluateLoginState: web_session 在但页面有登录提示 → 否决（真机场景：残留 session + 登录框）', async () => {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const res = await evaluateLoginState('127.0.0.1', 9222, makeJsonFetch(XHS_TARGETS), makeFakeWsFactory({
    domSignals: { href: 'https://www.xiaohongshu.com/explore', hasUserStorage: false, hasAvatar: false, hasCreatorEntry: true, hasLoginPrompt: true },
    cookies: [{ name: 'web_session', value: 'stale-but-present' }],
    sent,
  }));
  assert.equal(res.loggedIn, false);
  assert.equal(res.reason, 'login-prompt');
});

test('evaluateLoginState: getCookies 失败时退回 DOM 信号（nav头像&&创作入口）兜底', async () => {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const res = await evaluateLoginState('127.0.0.1', 9222, makeJsonFetch(XHS_TARGETS), makeFakeWsFactory({
    domSignals: { href: 'https://www.xiaohongshu.com/explore', hasUserStorage: false, hasAvatar: true, hasCreatorEntry: true, hasLoginPrompt: false },
    cookies: [],
    cookiesError: true,
    sent,
  }));
  assert.equal(res.loggedIn, true);
  assert.equal(res.reason, 'avatar+creator-entry');
});
