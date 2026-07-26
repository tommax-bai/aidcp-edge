'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { normalizeProxyInput } = require('./ads-proxy-config.cjs');
const { resolveMacSystemProxy } = require('./system-proxy-resolver.cjs');

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_READY_POLL_MS = 50;
const DEFAULT_STOP_TIMEOUT_MS = 1_500;

class ProxyChainError extends Error {
  constructor(reason) {
    super(String(reason || 'proxy_chain_unavailable'));
    this.name = 'ProxyChainError';
    this.reason = String(reason || 'proxy_chain_unavailable');
  }
}

function normalizedHop(proxy, role) {
  const normalized = normalizeProxyInput(proxy || {});
  if (!normalized.ok) throw new ProxyChainError(`${role}_proxy_config_invalid`);
  if (normalized.noProxy) throw new ProxyChainError(`${role}_proxy_missing`);
  const cfg = normalized.proxyConfig;
  return {
    proxyType: cfg.proxy_type,
    proxyHost: cfg.proxy_host,
    proxyPort: String(cfg.proxy_port),
    proxyUser: cfg.proxy_user || '',
    proxyPassword: cfg.proxy_password || '',
  };
}

function connectorAndDialer(proxyType) {
  switch (proxyType) {
    case 'http': return { connector: 'http', dialer: 'tcp' };
    case 'https': return { connector: 'http', dialer: 'tls' };
    case 'socks5': return { connector: 'socks5', dialer: 'tcp' };
    default: throw new ProxyChainError('environment_proxy_config_invalid');
  }
}

function gostNode(name, proxy) {
  const types = connectorAndDialer(proxy.proxyType);
  const connector = { type: types.connector };
  if (proxy.proxyUser) {
    connector.auth = {
      username: proxy.proxyUser,
      password: proxy.proxyPassword,
    };
  }
  return {
    name,
    addr: `${proxy.proxyHost}:${proxy.proxyPort}`,
    connector,
    dialer: { type: types.dialer },
  };
}

function buildGostChainConfig({ listenPort, systemProxy, environmentProxy }) {
  const first = normalizedHop(systemProxy, 'system');
  const second = normalizedHop(environmentProxy, 'environment');
  if (first.proxyHost.toLowerCase() === second.proxyHost.toLowerCase()
    && first.proxyPort === second.proxyPort) {
    throw new ProxyChainError('proxy_chain_duplicate_hop');
  }
  const port = Number(listenPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProxyChainError('proxy_chain_port_invalid');
  }
  return {
    services: [{
      name: 'aidcp-loopback',
      addr: `127.0.0.1:${port}`,
      handler: { type: 'http', chain: 'aidcp-chain' },
      listener: { type: 'tcp' },
    }],
    chains: [{
      name: 'aidcp-chain',
      hops: [
        { name: 'system-upstream', nodes: [gostNode('system-node', first)] },
        { name: 'environment-proxy', nodes: [gostNode('environment-node', second)] },
      ],
    }],
  };
}

function chainFingerprint(systemProxy, environmentProxy) {
  return crypto.createHash('sha256').update(JSON.stringify({ systemProxy, environmentProxy })).digest('hex');
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('no_loopback_port'));
        else resolve(port);
      });
    });
  });
}

function probeLoopbackPort(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once('exit', finish);
  });
}

function createProxyChainManager(options = {}) {
  const entries = new Map();
  let nextRevision = 1;
  const resolveSystemProxy = options.resolveSystemProxy || resolveMacSystemProxy;
  const resolveBinary = options.resolveBinary;
  if (typeof resolveBinary !== 'function') throw new TypeError('resolveBinary is required');
  const spawnImpl = options.spawnImpl || spawn;
  const allocatePort = options.allocatePort || allocateLoopbackPort;
  const probePort = options.probePort || probeLoopbackPort;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const readyTimeoutMs = Math.max(100, Number(options.readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS);
  const readyPollMs = Math.max(10, Number(options.readyPollMs) || DEFAULT_READY_POLL_MS);
  const stopTimeoutMs = Math.max(100, Number(options.stopTimeoutMs) || DEFAULT_STOP_TIMEOUT_MS);
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => undefined;
  const orphanRegistry = options.orphanRegistry || null;

  function safeNotify(profileId, state, reason, invalidateEvidence = false) {
    try {
      onUpdate(String(profileId), {
        state,
        ...(reason ? { reason } : {}),
        ...(invalidateEvidence ? { invalidateEvidence: true } : {}),
      });
    } catch { /* status projection cannot change routing */ }
  }

  async function stopEntry(entry) {
    if (!entry || !entry.child) return;
    const child = entry.child;
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGTERM'); } catch { /* bounded wait below */ }
      await waitForExit(child, stopTimeoutMs);
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
      }
    }
    if (orphanRegistry && Number.isInteger(child.pid)) await orphanRegistry.remove(child.pid);
  }

  async function invalidate(profileId) {
    const key = String(profileId || '').trim();
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    if (entry.promise) {
      try {
        const ready = await entry.promise;
        await stopEntry(ready);
      } catch {
        // Failed starts have already cleaned up their child.
      }
    } else {
      await stopEntry(entry);
    }
    safeNotify(key, 'idle');
  }

  async function startChain(profileId, fingerprint, systemProxy, environmentProxy) {
    let binary;
    try {
      binary = await resolveBinary();
    } catch {
      throw new ProxyChainError('proxy_chain_binary_missing');
    }
    if (!binary || binary.ok !== true || !binary.binaryPath) {
      throw new ProxyChainError((binary && binary.reason) || 'proxy_chain_binary_missing');
    }
    let port;
    try {
      port = await allocatePort();
    } catch {
      throw new ProxyChainError('proxy_chain_port_unavailable');
    }
    const config = buildGostChainConfig({ listenPort: port, systemProxy, environmentProxy });
    let child;
    try {
      child = spawnImpl(binary.binaryPath, ['-C', '-'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch {
      throw new ProxyChainError('proxy_chain_spawn_failed');
    }
    const entry = { child, port, fingerprint, revision: nextRevision++ };
    if (orphanRegistry) {
      const tracked = await orphanRegistry.add(child.pid, binary.binaryPath);
      if (!tracked || tracked.ok !== true) {
        await stopEntry(entry);
        throw new ProxyChainError((tracked && tracked.reason) || 'proxy_chain_process_untracked');
      }
    }
    let exited = false;
    let spawnError = false;
    child.once?.('error', () => { spawnError = true; });
    child.once?.('exit', () => {
      exited = true;
      if (orphanRegistry && Number.isInteger(child.pid)) void orphanRegistry.remove(child.pid);
      const current = entries.get(profileId);
      if (current === entry) {
        entries.delete(profileId);
        safeNotify(profileId, 'unavailable', 'proxy_chain_exited', Boolean(entry.endpoint));
      }
    });
    try {
      child.stdin?.end(JSON.stringify(config));
    } catch {
      await stopEntry(entry);
      throw new ProxyChainError('proxy_chain_config_write_failed');
    }

    const deadline = now() + readyTimeoutMs;
    while (now() < deadline) {
      if (spawnError) {
        await stopEntry(entry);
        throw new ProxyChainError('proxy_chain_spawn_failed');
      }
      if (exited || child.exitCode != null) {
        throw new ProxyChainError('proxy_chain_exited');
      }
      if (await probePort(port)) {
        entry.endpoint = {
          proxyType: 'http',
          proxyHost: '127.0.0.1',
          proxyPort: String(port),
          proxyUser: '',
          proxyPassword: '',
        };
        return entry;
      }
      await sleep(readyPollMs);
    }
    await stopEntry(entry);
    throw new ProxyChainError('proxy_chain_ready_timeout');
  }

  async function ensure({ profileId, environmentProxy } = {}) {
    const key = String(profileId || '').trim();
    if (!key) throw new ProxyChainError('proxy_chain_profile_missing');
    if (orphanRegistry) {
      const cleaned = await orphanRegistry.cleanup();
      if (!cleaned || cleaned.ok !== true) {
        throw new ProxyChainError((cleaned && cleaned.reason) || 'proxy_chain_orphan_cleanup_failed');
      }
    }
    const normalizedEnvironment = normalizedHop(environmentProxy, 'environment');
    const systemResult = await resolveSystemProxy();
    if (!systemResult || systemResult.ok !== true || !systemResult.proxy) {
      throw new ProxyChainError((systemResult && systemResult.reason) || 'system_proxy_read_failed');
    }
    const normalizedSystem = normalizedHop(systemResult.proxy, 'system');
    const fingerprint = chainFingerprint(normalizedSystem, normalizedEnvironment);
    const current = entries.get(key);
    if (current?.promise && current.fingerprint === fingerprint) return current.promise.then((entry) => entry.endpoint);
    if (current?.endpoint && current.fingerprint === fingerprint) return current.endpoint;
    if (current) await invalidate(key);

    safeNotify(key, 'starting');
    const holder = { fingerprint, promise: null };
    const promise = startChain(key, fingerprint, normalizedSystem, normalizedEnvironment)
      .then((entry) => {
        if (entries.get(key) === holder) entries.set(key, entry);
        safeNotify(key, 'ready');
        return entry;
      })
      .catch((error) => {
        if (entries.get(key) === holder) entries.delete(key);
        const reason = error instanceof ProxyChainError ? error.reason : 'proxy_chain_unavailable';
        safeNotify(key, 'unavailable', reason);
        throw error instanceof ProxyChainError ? error : new ProxyChainError(reason);
      });
    holder.promise = promise;
    entries.set(key, holder);
    return promise.then((entry) => entry.endpoint);
  }

  function endpoint(profileId) {
    const entry = entries.get(String(profileId || '').trim());
    return entry?.endpoint ? { ...entry.endpoint } : null;
  }

  function snapshot(profileId) {
    const entry = entries.get(String(profileId || '').trim());
    if (!entry) return { state: 'idle' };
    if (entry.promise) return { state: 'starting' };
    return entry.endpoint ? { state: 'ready' } : { state: 'unavailable' };
  }

  function revision(profileId) {
    const entry = entries.get(String(profileId || '').trim());
    return Number(entry?.revision) || 0;
  }

  async function stopAll() {
    const keys = [...entries.keys()];
    await Promise.all(keys.map((key) => invalidate(key)));
  }

  function hasActive() {
    return entries.size > 0;
  }

  return { ensure, endpoint, snapshot, revision, invalidate, stopAll, hasActive };
}

module.exports = {
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_READY_POLL_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  ProxyChainError,
  allocateLoopbackPort,
  buildGostChainConfig,
  createProxyChainManager,
  probeLoopbackPort,
};
