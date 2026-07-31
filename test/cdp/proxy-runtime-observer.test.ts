import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyRuntimeObserver, type ProxyRuntimeUiEvent } from '../../src/cdp/proxy-runtime-observer.js';

class FakeCdp {
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();

  on(method: string, listener: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }
}

test('流量观测器启动代际时不发送任何探测请求，只发布 active 空快照', () => {
  const cdp = new FakeCdp();
  const events: ProxyRuntimeUiEvent[] = [];
  const observer = new ProxyRuntimeObserver({
    cdp,
    emit: (event) => events.push(event),
    trafficEmitIntervalMs: 0,
  });

  assert.deepEqual(observer.startGeneration(), {
    state: 'active',
    generation: 1,
    sessionReceivedBytes: 0,
  });
  assert.deepEqual(events.at(-1)?.proxyRuntime, observer.snapshot());
  observer.dispose();
});

test('只累计有效 loadingFinished.encodedDataLength，新代际清零、普通快照不清零', () => {
  const cdp = new FakeCdp();
  const events: ProxyRuntimeUiEvent[] = [];
  const observer = new ProxyRuntimeObserver({
    cdp,
    emit: (event) => events.push(event),
    trafficEmitIntervalMs: 0,
  });
  observer.startGeneration();
  cdp.emit('Network.loadingFinished', { encodedDataLength: 1024 });
  cdp.emit('Network.loadingFinished', { encodedDataLength: 512.8 });
  cdp.emit('Network.loadingFinished', { encodedDataLength: -1 });
  cdp.emit('Network.loadingFinished', { encodedDataLength: Number.POSITIVE_INFINITY });
  cdp.emit('Network.loadingFailed', { encodedDataLength: 9999 });
  assert.equal(observer.snapshot().sessionReceivedBytes, 1536.8);
  assert.equal(events.at(-1)?.proxyRuntime.sessionReceivedBytes, 1536.8);

  observer.startGeneration();
  assert.deepEqual(observer.snapshot(), {
    state: 'active',
    generation: 2,
    sessionReceivedBytes: 0,
  });
  observer.dispose();
});

test('待机使代际失效并丢弃迟到流量', () => {
  const cdp = new FakeCdp();
  const observer = new ProxyRuntimeObserver({
    cdp,
    emit: () => undefined,
    trafficEmitIntervalMs: 0,
  });
  observer.startGeneration();
  cdp.emit('Network.loadingFinished', { encodedDataLength: 2048 });
  observer.suspendGeneration('browser_standby');
  assert.deepEqual(observer.snapshot(), {
    state: 'stale',
    generation: 2,
    sessionReceivedBytes: 0,
  });
  cdp.emit('Network.loadingFinished', { encodedDataLength: 1024 });
  assert.equal(observer.snapshot().sessionReceivedBytes, 0);
  observer.dispose();
});
