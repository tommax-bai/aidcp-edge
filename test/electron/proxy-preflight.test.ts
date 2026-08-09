import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createProxyPreflightController,
  preflightFacebookProxy,
  proxyUrlForConfig,
  reasonForError,
} = require('../../src/electron/proxy-preflight.cjs') as {
  createProxyPreflightController: (options: Record<string, unknown>) => {
    ensure: (input: {
      envId: string;
      profileId: string;
      authorityRevision?: number;
      proxyConfig?: Record<string, unknown>;
    }) => Promise<{
      state: string;
      reason: string;
      checkedAt: string;
      authorityRevision?: number;
    }>;
    invalidate: (envId: string) => void;
    snapshot: (envId: string) => { state: string; checkedAt?: string } | null;
  };
  preflightFacebookProxy: (proxy: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{
    state: 'available' | 'unavailable' | 'unknown' | 'skipped';
    checkedAt: string;
    reason: string;
  }>;
  proxyUrlForConfig: (proxy: Record<string, unknown>) => { ok: boolean; noProxy?: boolean; proxyType?: string; url?: URL; reason?: string };
  reasonForError: (error: unknown) => string;
};

function successfulRequest(capture: Record<string, unknown>, statusCode = 200) {
  return (url: string, options: Record<string, unknown>, callback: (response: { statusCode: number; resume: () => void }) => void) => {
    capture.url = url;
    capture.options = options;
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    request.end = () => queueMicrotask(() => callback({ statusCode, resume: () => undefined }));
    request.destroy = (error) => { if (error) request.emit('error', error); };
    return request;
  };
}

function failedRequest(error: Error & { code?: string }) {
  return () => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    request.end = () => queueMicrotask(() => request.emit('error', error));
    request.destroy = (destroyError) => { if (destroyError) request.emit('error', destroyError); };
    return request;
  };
}

const authenticatedHttpProxy = {
  proxyType: 'http',
  proxyHost: 'proxy.example',
  proxyPort: '8080',
  proxyUser: 'user@example',
  proxyPassword: 'p@ss:/word',
};

test('代理 URL 正确编码认证信息并支持 http/https/socks5，不接受非法配置', () => {
  const http = proxyUrlForConfig(authenticatedHttpProxy);
  assert.equal(http.ok, true);
  assert.equal(http.url?.protocol, 'http:');
  assert.equal(http.url?.username, 'user%40example');
  assert.equal(http.url?.password, 'p%40ss%3A%2Fword');

  assert.equal(proxyUrlForConfig({ ...authenticatedHttpProxy, proxyType: 'https' }).url?.protocol, 'https:');
  assert.equal(proxyUrlForConfig({ ...authenticatedHttpProxy, proxyType: 'socks5' }).url?.protocol, 'socks5:');
  assert.deepEqual(proxyUrlForConfig({ proxyType: 'ftp', proxyHost: 'x', proxyPort: '1' }), {
    ok: false,
    reason: 'config_invalid',
  });
});

test('预检只发无身份 HEAD 请求，成功结果不含代理配置或密码', async () => {
  const capture: Record<string, unknown> = {};
  const result = await preflightFacebookProxy(authenticatedHttpProxy, {
    requestImpl: successfulRequest(capture),
    agentFactory: () => ({ fake: true }),
    now: () => Date.parse('2026-07-21T00:00:00.000Z'),
  });

  assert.deepEqual(result, {
    state: 'available',
    checkedAt: '2026-07-21T00:00:00.000Z',
    reason: 'facebook_reachable',
  });
  assert.equal(capture.url, 'https://www.facebook.com/');
  const options = capture.options as { method?: string; headers?: Record<string, string> };
  assert.equal(options.method, 'HEAD');
  assert.equal(Object.hasOwn(options.headers ?? {}, 'cookie'), false);
  assert.equal(JSON.stringify(result).includes('p@ss'), false);
  assert.equal(JSON.stringify(result).includes('proxy.example'), false);
});

test('407 与网络/协议错误是确定失败，无代理跳过，检测器异常保持未知', async () => {
  const auth = await preflightFacebookProxy(authenticatedHttpProxy, {
    requestImpl: successfulRequest({}, 407),
    agentFactory: () => ({}),
  });
  assert.equal(auth.state, 'unavailable');
  assert.equal(auth.reason, 'authentication_failed');

  const protocolError = Object.assign(new Error('wrong version number'), { code: 'EPROTO' });
  const protocol = await preflightFacebookProxy(authenticatedHttpProxy, {
    requestImpl: failedRequest(protocolError),
    agentFactory: () => ({}),
  });
  assert.equal(protocol.state, 'unavailable');
  assert.equal(protocol.reason, 'protocol_mismatch');

  const skipped = await preflightFacebookProxy({ proxyType: 'no_proxy' });
  assert.equal(skipped.state, 'skipped');
  const unknown = await preflightFacebookProxy(authenticatedHttpProxy, { agentFactory: () => { throw new Error('broken'); } });
  assert.equal(unknown.state, 'unknown');
  assert.equal(reasonForError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), 'connection_refused');
});

test('控制器按环境单飞并在 TTL 内复用，缓存与公开快照不保存代理认证信息', async () => {
  let clock = Date.parse('2026-07-21T00:00:00.000Z');
  let reads = 0;
  let probes = 0;
  const updates: unknown[] = [];
  const controller = createProxyPreflightController({
    now: () => clock,
    ttlMs: 120_000,
    readProxy: async () => {
      reads += 1;
      return { ok: true, proxy: authenticatedHttpProxy };
    },
    probe: async () => {
      probes += 1;
      await Promise.resolve();
      return { state: 'available', checkedAt: new Date(clock).toISOString(), reason: 'facebook_reachable' };
    },
    onUpdate: (_envId: string, snapshot: unknown) => updates.push(snapshot),
  });

  const [first, duplicate] = await Promise.all([
    controller.ensure({ envId: 'env-a', profileId: 'profile-a' }),
    controller.ensure({ envId: 'env-a', profileId: 'profile-a' }),
  ]);
  assert.equal(first.state, 'available');
  assert.deepEqual(duplicate, first);
  assert.equal(reads, 1);
  assert.equal(probes, 1);

  await controller.ensure({ envId: 'env-a', profileId: 'profile-a' });
  assert.equal(reads, 1, 'TTL 内直接复用');
  assert.equal(JSON.stringify(controller.snapshot('env-a')).includes('proxy.example'), false);
  assert.equal(JSON.stringify(updates).includes('p@ss'), false);

  clock += 120_001;
  await controller.ensure({ envId: 'env-a', profileId: 'profile-a' });
  assert.equal(reads, 2, '过期后仅补做一次');
});

test('人工启动清除已完成失败缓存后重新探测并采用新结果', async () => {
  let probes = 0;
  const controller = createProxyPreflightController({
    ttlMs: 120_000,
    readProxy: async () => ({ ok: true, proxy: authenticatedHttpProxy }),
    probe: async () => {
      probes += 1;
      return probes === 1
        ? { state: 'unavailable', checkedAt: new Date().toISOString(), reason: 'connection_refused' }
        : { state: 'available', checkedAt: new Date().toISOString(), reason: 'facebook_reachable' };
    },
  });

  assert.equal((await controller.ensure({ envId: 'env-manual', profileId: 'profile-manual' })).state, 'unavailable');
  assert.equal((await controller.ensure({ envId: 'env-manual', profileId: 'profile-manual' })).state, 'unavailable');
  assert.equal(probes, 1, '确定失败在 TTL 内仍按默认规则复用');

  controller.invalidate('env-manual');
  assert.equal((await controller.ensure({ envId: 'env-manual', profileId: 'profile-manual' })).state, 'available');
  assert.equal(probes, 2, '显式失效后必须真实补做检测');
});

test('人工启动遇到在途检测时保留单飞而不制造 superseded 未知结果', async () => {
  let releaseProbe: ((value: unknown) => void) | undefined;
  let probes = 0;
  const controller = createProxyPreflightController({
    readProxy: async () => ({ ok: true, proxy: authenticatedHttpProxy }),
    probe: () => {
      probes += 1;
      return new Promise((resolve) => { releaseProbe = resolve; });
    },
  });

  const first = controller.ensure({ envId: 'env-inflight', profileId: 'profile-inflight' });
  await Promise.resolve();
  assert.equal(controller.snapshot('env-inflight')?.state, 'checking');
  if (controller.snapshot('env-inflight')?.state !== 'checking') controller.invalidate('env-inflight');
  const manualStart = controller.ensure({ envId: 'env-inflight', profileId: 'profile-inflight' });
  releaseProbe?.({ state: 'available', checkedAt: new Date().toISOString(), reason: 'facebook_reachable' });

  assert.deepEqual(await manualStart, await first);
  assert.equal((await manualStart).state, 'available');
  assert.equal(probes, 1);
});

test('控制器不缓存 unknown，invalidate 使在途旧结果失效', async () => {
  let releaseRead: ((value: unknown) => void) | undefined;
  const updates: unknown[] = [];
  const controller = createProxyPreflightController({
    readProxy: () => new Promise((resolve) => { releaseRead = resolve; }),
    probe: async () => ({ state: 'available', checkedAt: new Date().toISOString(), reason: 'facebook_reachable' }),
    onUpdate: (_envId: string, snapshot: unknown) => updates.push(snapshot),
  });
  const pending = controller.ensure({ envId: 'env-b', profileId: 'profile-b' });
  controller.invalidate('env-b');
  releaseRead?.({ ok: true, proxy: authenticatedHttpProxy });
  assert.equal((await pending).state, 'unknown');
  assert.equal(controller.snapshot('env-b'), null);
  assert.equal(updates.at(-1), null);

  let reads = 0;
  const unknownController = createProxyPreflightController({
    readProxy: async () => { reads += 1; return { ok: false }; },
  });
  await unknownController.ensure({ envId: 'env-c', profileId: 'profile-c' });
  await unknownController.ensure({ envId: 'env-c', profileId: 'profile-c' });
  assert.equal(reads, 2, 'unknown 不成为阻断启动的陈旧缓存');
});

test('显式阻断的代理读取失败保留稳定原因并阻止启动', async () => {
  const controller = createProxyPreflightController({
    readProxy: async () => ({
      ok: false,
      blocking: true,
      reason: 'system_proxy_not_configured',
    }),
  });
  const result = await controller.ensure({ envId: 'env-chain', profileId: 'profile-chain' });
  assert.equal(result.state, 'unavailable');
  assert.equal(result.reason, 'system_proxy_not_configured');
});

test('环境明确未配置代理时跳过检测且不调用探测器', async () => {
  let probes = 0;
  const controller = createProxyPreflightController({
    readProxy: async () => ({ ok: true, noProxy: true }),
    probe: async () => {
      probes += 1;
      return { state: 'available', checkedAt: new Date().toISOString(), reason: 'unexpected_probe' };
    },
  });
  const result = await controller.ensure({ envId: 'env-no-proxy', profileId: 'profile-no-proxy' });
  assert.equal(result.state, 'skipped');
  assert.equal(result.reason, 'no_proxy');
  assert.equal(probes, 0);
});

test('控制器仅在 Cloud 代理权威 revision 相同时复用缓存', async () => {
  let probes = 0;
  const controller = createProxyPreflightController({
    readProxy: async () => assert.fail('已提供冻结快照时不得二次读取代理权威'),
    probe: async () => {
      probes += 1;
      return { state: 'available', checkedAt: new Date().toISOString(), reason: 'facebook_reachable' };
    },
  });
  const snapshot = { ok: true, noProxy: false, proxy: authenticatedHttpProxy };
  const first = await controller.ensure({
    envId: 'env-revision',
    profileId: 'profile-revision',
    proxyConfig: snapshot,
    authorityRevision: 3,
  });
  const cached = await controller.ensure({
    envId: 'env-revision',
    profileId: 'profile-revision',
    proxyConfig: snapshot,
    authorityRevision: 3,
  });
  const changed = await controller.ensure({
    envId: 'env-revision',
    profileId: 'profile-revision',
    proxyConfig: snapshot,
    authorityRevision: 4,
  });
  assert.equal(first.authorityRevision, 3);
  assert.equal(cached.authorityRevision, 3);
  assert.equal(changed.authorityRevision, 4);
  assert.equal(probes, 2);
});

// ── 确定失败的处置决策（change bound-proxy-preflight-retry）──────────────────────
//
// 这些用例驱动的是**真实现**，不是源码文本：把重排改成无条件、把预算判反、把不可恢复也放进
// 重排通道——每一种削弱形态都会在下面当场变红。

const {
  decideProxyPreflightFailure,
  preflightFailureIsRecoverable,
  NON_RECOVERABLE_PREFLIGHT_REASONS,
  DEFAULT_REQUEUE_DELAYS_MS,
} = require('../../src/electron/proxy-preflight.cjs') as {
  decideProxyPreflightFailure: (input: {
    reason?: string;
    requeuesUsed?: number;
    maxRequeues?: number;
    delaysMs?: number[];
  }) => {
    action: string;
    terminal?: string;
    reason?: string;
    probes?: number;
    attempt?: number;
    maxRequeues?: number;
    delayMs?: number;
  };
  preflightFailureIsRecoverable: (reason: string) => boolean;
  NON_RECOVERABLE_PREFLIGHT_REASONS: Set<string>;
  DEFAULT_REQUEUE_DELAYS_MS: number[];
};

test('未识别的失败原因按可恢复处置，绝不折进终局', () => {
  // 这是分类器的红线：把没认出来的原因归进不可恢复，就是让一个谁也没做过的决定
  // 变成「这件事做不到」。新增原因串必须自动落进重排通道。
  for (const unknown of ['some_reason_nobody_has_seen_yet', 'proxy_chain_future_failure', '']) {
    assert.equal(preflightFailureIsRecoverable(unknown), true, `${unknown} 必须按可恢复处置`);
    const decision = decideProxyPreflightFailure({ reason: unknown, requeuesUsed: 0 });
    assert.equal(decision.action, 'requeue', `${unknown} 必须进重排通道`);
  }
});

test('链路瞬时失败进重排通道，配置类失败当场终结', () => {
  const recoverable = [
    'timeout', 'connection_refused', 'host_unresolved', 'proxy_connect_failed', 'request_failed',
    'proxy_chain_port_unavailable', 'proxy_chain_spawn_failed', 'proxy_chain_exited',
    'proxy_chain_ready_timeout', 'system_proxy_read_failed',
    // 云端代理权威读取的传输失败（请求没送达）：与 unavailable（云端答复了但给不出）分开命名，
    // 恒可恢复。谁把它加进不可恢复清单，这里当场红。
    'proxy_authority_unreachable',
  ];
  for (const reason of recoverable) {
    const decision = decideProxyPreflightFailure({ reason, requeuesUsed: 0 });
    assert.equal(decision.action, 'requeue', `${reason} 应重排`);
  }
  const nonRecoverable = [
    'config_invalid', 'protocol_mismatch', 'authentication_failed', 'environment_proxy_missing',
    'system_proxy_not_configured', 'system_proxy_pac_unsupported', 'proxy_chain_duplicate_hop',
    'proxy_authority_unavailable', 'proxy_authority_revision_changed', 'proxy_chain_binary_missing',
  ];
  for (const reason of nonRecoverable) {
    const decision = decideProxyPreflightFailure({ reason, requeuesUsed: 0 });
    assert.equal(decision.action, 'terminate', `${reason} 应当场终结`);
    assert.equal(decision.terminal, 'config', `${reason} 应走配置类终局`);
  }
  // 清单本身也锁住：任何一条被误删都会让它悄悄变成「可重排」，这里当场报出来。
  for (const reason of nonRecoverable) {
    assert.ok(NON_RECOVERABLE_PREFLIGHT_REASONS.has(reason), `${reason} 必须在不可恢复清单里`);
  }
});

test('重排预算耗尽后终结，且回执口径是「试了几次」而非「确认做不到」', () => {
  const first = decideProxyPreflightFailure({ reason: 'timeout', requeuesUsed: 0, maxRequeues: 2 });
  assert.deepEqual(
    { action: first.action, attempt: first.attempt, delayMs: first.delayMs },
    { action: 'requeue', attempt: 1, delayMs: DEFAULT_REQUEUE_DELAYS_MS[0] },
  );
  const second = decideProxyPreflightFailure({ reason: 'timeout', requeuesUsed: 1, maxRequeues: 2 });
  assert.deepEqual(
    { action: second.action, attempt: second.attempt, delayMs: second.delayMs },
    { action: 'requeue', attempt: 2, delayMs: DEFAULT_REQUEUE_DELAYS_MS[1] },
  );
  const exhausted = decideProxyPreflightFailure({ reason: 'timeout', requeuesUsed: 2, maxRequeues: 2 });
  assert.equal(exhausted.action, 'terminate');
  // exhausted 与 config 是**两个不同的终局**：前者「试了 3 次没通、链路可能还在抖」，
  // 后者「配置就是错的、再试也没用」。压成一态运营就无从判断下一步。
  assert.equal(exhausted.terminal, 'exhausted');
  assert.equal(exhausted.probes, 3, '探测总次数 = 首探 1 次 + 重排 2 次');
});

test('预算设 0 逐字退回旧行为：连终局措辞一起回到配置类', () => {
  const decision = decideProxyPreflightFailure({ reason: 'timeout', requeuesUsed: 0, maxRequeues: 0 });
  assert.equal(decision.action, 'terminate');
  assert.equal(decision.terminal, 'config',
    '回滚旋钮必须连回执措辞一起退回，否则一个「什么都没变」的回滚会读到新造的预算耗尽文案');
});

test('重排间隔递增且在末位饱和', () => {
  const delays = [10, 30];
  const at = (used: number) => decideProxyPreflightFailure({
    reason: 'timeout', requeuesUsed: used, maxRequeues: 5, delaysMs: delays,
  }).delayMs;
  assert.equal(at(0), 10);
  assert.equal(at(1), 30);
  assert.equal(at(2), 30, '超出末位一律用末位值，不得回绕到第一跳');
  assert.equal(at(3), 30);
});
