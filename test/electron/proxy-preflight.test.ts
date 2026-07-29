import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createProxyPreflightController,
  preflightFacebookProxy,
  probeProxyEgress,
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
      expectedEgressIp?: string;
    }>;
    invalidate: (envId: string) => void;
    snapshot: (envId: string) => { state: string; checkedAt?: string } | null;
  };
  preflightFacebookProxy: (proxy: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{
    state: 'available' | 'unavailable' | 'unknown' | 'skipped';
    checkedAt: string;
    reason: string;
  }>;
  probeProxyEgress: (proxy: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{
    state: 'available' | 'unavailable' | 'unknown' | 'skipped';
    checkedAt: string;
    reason: string;
    expectedEgressIp?: string;
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

function successfulEgressRequest(capture: Record<string, unknown>, ip = '203.0.113.7') {
  return (url: URL, options: Record<string, unknown>, callback: (response: {
    statusCode: number;
    headers: Record<string, string>;
    resume: () => void;
  }) => void) => {
    capture.url = String(url);
    capture.options = options;
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    request.end = () => queueMicrotask(() => callback({
      statusCode: 200,
      headers: { 'x-aidcp-egress-ip': ip },
      resume: () => undefined,
    }));
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

test('冻结有效代理出口探测只返回规范化 IP，公开状态不泄露该证据或认证信息', async () => {
  const capture: Record<string, unknown> = {};
  const result = await probeProxyEgress(authenticatedHttpProxy, {
    targetUrl: 'https://cloud.example/capi/egress',
    requestImpl: successfulEgressRequest(capture, '::ffff:203.0.113.7'),
    agentFactory: () => ({ fake: true }),
    now: () => Date.parse('2026-07-28T00:00:00.000Z'),
  });
  assert.deepEqual(result, {
    state: 'available',
    checkedAt: '2026-07-28T00:00:00.000Z',
    reason: 'egress_observed',
    expectedEgressIp: '203.0.113.7',
  });
  assert.equal(capture.url, 'https://cloud.example/capi/egress');
  assert.equal(JSON.stringify(result).includes('proxy.example'), false);
  assert.equal(JSON.stringify(result).includes('p@ss'), false);

  const controller = createProxyPreflightController({
    readProxy: async () => ({ ok: true, proxy: authenticatedHttpProxy }),
    probe: async () => result,
  });
  await controller.ensure({ envId: 'env-egress', profileId: 'profile-egress' });
  assert.equal(JSON.stringify(controller.snapshot('env-egress')).includes('203.0.113.7'), false);
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

test('Facebook 可达但期望出口证据暂缺时不缓存，避免 Active 接管复用无证据结果', async () => {
  let probes = 0;
  const controller = createProxyPreflightController({
    readProxy: async () => ({ ok: true, proxy: authenticatedHttpProxy }),
    probe: async () => {
      probes += 1;
      return {
        state: 'available',
        checkedAt: new Date().toISOString(),
        reason: 'facebook_reachable',
        expectedEgressReason: 'egress_probe_unavailable',
      };
    },
  });
  await controller.ensure({ envId: 'env-no-egress', profileId: 'profile-no-egress' });
  await controller.ensure({ envId: 'env-no-egress', profileId: 'profile-no-egress' });
  assert.equal(probes, 2);
});
