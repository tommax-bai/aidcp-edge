import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const chains = require('../../src/electron/proxy-chain-manager.cjs') as {
  ProxyChainError: new (reason: string) => Error & { reason: string };
  buildGostChainConfig(input: Record<string, unknown>): Record<string, unknown>;
  createProxyChainManager(options: Record<string, unknown>): {
    ensure(input: Record<string, unknown>): Promise<Record<string, string>>;
    endpoint(profileId: string): Record<string, string> | null;
    revision(profileId: string): number;
    invalidate(profileId: string): Promise<void>;
    stopAll(): Promise<void>;
  };
};

const systemProxy = { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '7890' };
const environmentProxy = {
  proxyType: 'http',
  proxyHost: 'proxy.example',
  proxyPort: '51072',
  proxyUser: 'alice',
  proxyPassword: 'secret-value',
};

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  stdinText = '';
  stdin = {
    end: (value: string) => { this.stdinText += String(value); },
  };
  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.signalCode = signal;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

test('GOST config builds system then HTTP/HTTPS/SOCKS5 environment hops', () => {
  for (const [proxyType, connector, dialer] of [
    ['http', 'http', 'tcp'],
    ['https', 'http', 'tls'],
    ['socks5', 'socks5', 'tcp'],
  ]) {
    const config = chains.buildGostChainConfig({
      listenPort: 18080,
      systemProxy,
      environmentProxy: { ...environmentProxy, proxyType },
    }) as any;
    assert.equal(config.services[0].addr, '127.0.0.1:18080');
    assert.equal(config.chains[0].hops[0].nodes[0].connector.type, 'socks5');
    assert.equal(config.chains[0].hops[0].nodes[0].dialer.type, 'tcp');
    assert.equal(config.chains[0].hops[1].nodes[0].connector.type, connector);
    assert.equal(config.chains[0].hops[1].nodes[0].dialer.type, dialer);
    assert.deepEqual(config.chains[0].hops[1].nodes[0].connector.auth, {
      username: 'alice',
      password: 'secret-value',
    });
  }
  assert.throws(() => chains.buildGostChainConfig({
    listenPort: 18080,
    systemProxy,
    environmentProxy: { ...environmentProxy, proxyHost: '127.0.0.1', proxyPort: '7890' },
  }), /proxy_chain_duplicate_hop/);
});

test('manager shutdown escalates from bounded SIGTERM wait to SIGKILL', async () => {
  class StubbornChild extends FakeChild {
    signals: string[] = [];
    override kill(signal = 'SIGTERM') {
      this.killed = true;
      this.signals.push(signal);
      if (signal === 'SIGKILL') {
        this.signalCode = signal;
        queueMicrotask(() => this.emit('exit', null, signal));
      }
      return true;
    }
  }
  const child = new StubbornChild();
  const manager = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: true, proxy: systemProxy }),
    resolveBinary: async () => ({ ok: true, binaryPath: '/safe/gost' }),
    allocatePort: async () => 18101,
    probePort: async () => true,
    spawnImpl: () => child,
    stopTimeoutMs: 100,
  });
  await manager.ensure({ profileId: 'stubborn', environmentProxy });
  await manager.stopAll();
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('manager single-flights a profile, sends secrets only on stdin, reuses and invalidates safely', async () => {
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ binary: string; args: string[]; options: Record<string, unknown> }> = [];
  const updates: unknown[] = [];
  const manager = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: true, proxy: systemProxy }),
    resolveBinary: async () => ({ ok: true, binaryPath: '/safe/gost' }),
    allocatePort: async () => 18080,
    probePort: async () => true,
    spawnImpl: (binary: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeChild();
      children.push(child);
      spawnCalls.push({ binary, args, options });
      return child;
    },
    onUpdate: (profileId: string, status: unknown) => updates.push({ profileId, status }),
  });

  const [first, duplicate] = await Promise.all([
    manager.ensure({ profileId: 'profile-a', environmentProxy }),
    manager.ensure({ profileId: 'profile-a', environmentProxy }),
  ]);
  assert.deepEqual(first, {
    proxyType: 'http',
    proxyHost: '127.0.0.1',
    proxyPort: '18080',
    proxyUser: '',
    proxyPassword: '',
  });
  assert.deepEqual(duplicate, first);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, ['-C', '-']);
  assert.equal(JSON.stringify(spawnCalls).includes('secret-value'), false);
  assert.equal(children[0].stdinText.includes('secret-value'), true);
  assert.equal(JSON.stringify(updates).includes('secret-value'), false);

  await manager.ensure({ profileId: 'profile-a', environmentProxy });
  assert.equal(spawnCalls.length, 1, 'same chain is reused');
  await manager.invalidate('profile-a');
  assert.equal(children[0].killed, true);
  assert.equal(manager.endpoint('profile-a'), null);
});

test('manager exposes stable missing binary, early exit and timeout reasons without raw errors', async () => {
  const missing = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: true, proxy: systemProxy }),
    resolveBinary: async () => ({ ok: false, reason: 'proxy_chain_binary_missing' }),
  });
  await assert.rejects(
    missing.ensure({ profileId: 'missing', environmentProxy }),
    (error: any) => error.reason === 'proxy_chain_binary_missing',
  );

  let clock = 0;
  const timeoutChild = new FakeChild();
  const timedOut = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: true, proxy: systemProxy }),
    resolveBinary: async () => ({ ok: true, binaryPath: '/safe/gost' }),
    allocatePort: async () => 18081,
    probePort: async () => false,
    spawnImpl: () => timeoutChild,
    readyTimeoutMs: 100,
    readyPollMs: 20,
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
  });
  await assert.rejects(
    timedOut.ensure({ profileId: 'timeout', environmentProxy }),
    (error: any) => error.reason === 'proxy_chain_ready_timeout' && !String(error).includes('secret-value'),
  );
  assert.equal(timeoutChild.killed, true);

  const earlyChild = new FakeChild();
  const early = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: true, proxy: systemProxy }),
    resolveBinary: async () => ({ ok: true, binaryPath: '/safe/gost' }),
    allocatePort: async () => 18082,
    probePort: async () => {
      earlyChild.exitCode = 1;
      earlyChild.emit('exit', 1);
      return false;
    },
    spawnImpl: () => earlyChild,
  });
  await assert.rejects(
    early.ensure({ profileId: 'early', environmentProxy }),
    (error: any) => error.reason === 'proxy_chain_exited',
  );
});

test('manager replaces a changed chain and advances its non-sensitive revision', async () => {
  const children: FakeChild[] = [];
  let port = 18085;
  const manager = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: true, proxy: systemProxy }),
    resolveBinary: async () => ({ ok: true, binaryPath: '/safe/gost' }),
    allocatePort: async () => port++,
    probePort: async () => true,
    spawnImpl: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  await manager.ensure({ profileId: 'changed', environmentProxy });
  const firstRevision = manager.revision('changed');
  await manager.ensure({
    profileId: 'changed',
    environmentProxy: { ...environmentProxy, proxyPort: '51073' },
  });
  assert.equal(children[0].killed, true);
  assert.ok(manager.revision('changed') > firstRevision);
  await manager.stopAll();
});

test('only an already-ready relay exit asks the supervisor to invalidate cached evidence', async () => {
  const child = new FakeChild();
  const updates: Array<Record<string, unknown>> = [];
  const manager = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: true, proxy: systemProxy }),
    resolveBinary: async () => ({ ok: true, binaryPath: '/safe/gost' }),
    allocatePort: async () => 18086,
    probePort: async () => true,
    spawnImpl: () => child,
    onUpdate: (_profileId: string, status: Record<string, unknown>) => updates.push(status),
  });
  await manager.ensure({ profileId: 'unexpected-exit', environmentProxy });
  child.exitCode = 1;
  child.emit('exit', 1);
  assert.deepEqual(updates.at(-1), {
    state: 'unavailable',
    reason: 'proxy_chain_exited',
    invalidateEvidence: true,
  });
});

test('manager rejects absent system proxy and stops all independent profile relays', async () => {
  const unavailable = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: false, reason: 'system_proxy_not_configured' }),
    resolveBinary: async () => ({ ok: true, binaryPath: '/safe/gost' }),
  });
  await assert.rejects(
    unavailable.ensure({ profileId: 'profile-x', environmentProxy }),
    (error: any) => error.reason === 'system_proxy_not_configured',
  );

  const children: FakeChild[] = [];
  let port = 18090;
  const manager = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: true, proxy: systemProxy }),
    resolveBinary: async () => ({ ok: true, binaryPath: '/safe/gost' }),
    allocatePort: async () => port++,
    probePort: async () => true,
    spawnImpl: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  await manager.ensure({ profileId: 'a', environmentProxy });
  await manager.ensure({ profileId: 'b', environmentProxy: { ...environmentProxy, proxyPort: '51073' } });
  await manager.stopAll();
  assert.equal(children.every((child) => child.killed), true);
});

test('manager cleans prior orphans before start and registers/removes its child', async () => {
  const calls: string[] = [];
  const child = new FakeChild();
  const manager = chains.createProxyChainManager({
    resolveSystemProxy: async () => ({ ok: true, proxy: systemProxy }),
    resolveBinary: async () => ({ ok: true, binaryPath: '/safe/gost' }),
    allocatePort: async () => 18100,
    probePort: async () => true,
    spawnImpl: () => child,
    orphanRegistry: {
      cleanup: async () => { calls.push('cleanup'); return { ok: true }; },
      add: async (pid: number, binaryPath: string) => {
        calls.push(`add:${pid}:${binaryPath}`);
        return { ok: true };
      },
      remove: async (pid: number) => { calls.push(`remove:${pid}`); return { ok: true }; },
    },
  });
  await manager.ensure({ profileId: 'tracked', environmentProxy });
  await manager.stopAll();
  assert.deepEqual(calls.slice(0, 2), ['cleanup', 'add:4242:/safe/gost']);
  assert.ok(calls.includes('remove:4242'));
});
