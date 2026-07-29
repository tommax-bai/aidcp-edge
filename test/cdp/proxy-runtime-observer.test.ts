import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyRuntimeObserver, normalizeObservedIp, type ProxyRuntimeUiEvent } from '../../src/cdp/proxy-runtime-observer.js';

class FakeCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();

  constructor(private browserIp = '203.0.113.7', private browserFailure = '') {}

  on(method: string, listener: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }

  async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } } as T;
    if (method === 'Network.loadNetworkResource') {
      if (this.browserFailure) throw new Error(this.browserFailure);
      return {
        resource: {
          success: true,
          httpStatusCode: 200,
          headers: { 'X-AIDCP-Egress-IP': this.browserIp },
        },
      } as T;
    }
    return {} as T;
  }
}

function directFetch(ip: string): typeof fetch {
  return async () => new Response(JSON.stringify({ ip }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-aidcp-egress-ip': ip },
  });
}

test('浏览器与 Node 出口不同才标为 verified，且探测关闭缓存/凭据', async () => {
  const cdp = new FakeCdp('203.0.113.7');
  const events: ProxyRuntimeUiEvent[] = [];
  const observer = new ProxyRuntimeObserver({
    cdp: cdp as never,
    probeUrl: 'https://cloud.example/capi/egress',
    fetchImpl: directFetch('198.51.100.4'),
    emit: (event) => events.push(event),
    trafficEmitIntervalMs: 0,
  });

  const result = await observer.startGeneration();
  assert.equal(result.state, 'verified');
  assert.equal(result.browserIp, '203.0.113.7');
  assert.equal(result.directIp, '198.51.100.4');
  const browserCall = cdp.calls.find((call) => call.method === 'Network.loadNetworkResource');
  assert.deepEqual(browserCall?.params?.options, { disableCache: true, includeCredentials: false });
  assert.equal(JSON.stringify(events).includes('cloud.example'), false, '事件只带证据，不带探测 URL');
  observer.dispose();
});

test('只累计有效 loadingFinished.encodedDataLength，新代际清零、普通读快照不清零', async () => {
  const cdp = new FakeCdp();
  const events: ProxyRuntimeUiEvent[] = [];
  const observer = new ProxyRuntimeObserver({
    cdp: cdp as never,
    probeUrl: 'https://cloud.example/capi/egress',
    fetchImpl: directFetch('198.51.100.4'),
    emit: (event) => events.push(event),
    trafficEmitIntervalMs: 0,
  });
  await observer.startGeneration();
  cdp.emit('Network.loadingFinished', { encodedDataLength: 1024 });
  cdp.emit('Network.loadingFinished', { encodedDataLength: 512.8 });
  cdp.emit('Network.loadingFinished', { encodedDataLength: -1 });
  cdp.emit('Network.loadingFinished', { encodedDataLength: Number.POSITIVE_INFINITY });
  cdp.emit('Network.loadingFailed', { encodedDataLength: 9999 });
  assert.equal(observer.snapshot().sessionReceivedBytes, 1536.8);
  assert.equal(events.at(-1)?.proxyRuntime.sessionReceivedBytes, 1536.8);

  await observer.startGeneration();
  assert.equal(observer.snapshot().sessionReceivedBytes, 0);
  assert.equal(observer.snapshot().generation, 2);
  observer.dispose();
});

test('同出口标疑似直连；浏览器探测失败不得用 Node 结果冒充成功；待机使证据失效', async () => {
  const sameCdp = new FakeCdp('198.51.100.4');
  const same = new ProxyRuntimeObserver({
    cdp: sameCdp as never,
    probeUrl: 'https://cloud.example/capi/egress',
    fetchImpl: directFetch('198.51.100.4'),
    emit: () => undefined,
  });
  assert.equal((await same.startGeneration()).state, 'same_as_host');
  sameCdp.emit('Network.loadingFinished', { encodedDataLength: 2048 });
  assert.equal(same.snapshot().sessionReceivedBytes, 2048);
  same.suspendGeneration();
  assert.equal(same.snapshot().state, 'stale');
  assert.equal(same.snapshot().browserIp, undefined);
  assert.equal(same.snapshot().directIp, undefined);
  assert.equal(same.snapshot().checkedAt, undefined);
  assert.equal(same.snapshot().sessionReceivedBytes, 0);
  sameCdp.emit('Network.loadingFinished', { encodedDataLength: 1024 });
  assert.equal(same.snapshot().sessionReceivedBytes, 0, 'late traffic from an expired generation stays discarded');
  same.dispose();

  const failed = new ProxyRuntimeObserver({
    cdp: new FakeCdp('203.0.113.7', 'unsupported') as never,
    probeUrl: 'https://cloud.example/capi/egress',
    fetchImpl: directFetch('198.51.100.4'),
    emit: () => undefined,
  });
  const result = await failed.startGeneration();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.browserIp, undefined);
  assert.equal(result.directIp, '198.51.100.4');
  failed.dispose();
});

test('IP 规范化只接受合法地址并去掉 IPv4-mapped IPv6', () => {
  assert.equal(normalizeObservedIp('::ffff:198.51.100.4'), '198.51.100.4');
  assert.equal(normalizeObservedIp('[2001:db8::1]'), '2001:db8::1');
  assert.equal(normalizeObservedIp('not-an-ip'), null);
});
