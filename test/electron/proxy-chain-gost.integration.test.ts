import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  allocateLoopbackPort,
  createProxyChainManager,
  probeLoopbackPort,
} = require('../../src/electron/proxy-chain-manager.cjs') as {
  allocateLoopbackPort(): Promise<number>;
  probeLoopbackPort(port: number): Promise<boolean>;
  createProxyChainManager(options: Record<string, unknown>): {
    ensure(input: Record<string, unknown>): Promise<{ proxyHost: string; proxyPort: string }>;
    stopAll(): Promise<void>;
  };
};
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const defaultBinary = join(root, 'build', 'gost', `${process.platform}-${process.arch}`, 'gost');
const gostBinary = process.env.AIDCP_GOST_INTEGRATION_BINARY || defaultBinary;

async function waitForPort(port: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await probeLoopbackPort(port)) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error(`test upstream did not listen on ${port}`);
}

function stopChild(child: ChildProcess) {
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
}

function requestThroughProxy(proxyPort: number, targetPort: number) {
  return new Promise<string>((resolveBody, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: `http://127.0.0.1:${targetPort}/two-hop-proof`,
      headers: { host: `127.0.0.1:${targetPort}`, connection: 'close' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    });
    request.once('error', reject);
    request.end();
  });
}

test('staged GOST carries traffic through HTTP system hop then SOCKS5 environment hop', {
  skip: !existsSync(gostBinary),
}, async () => {
  const [systemPort, environmentPort] = await Promise.all([
    allocateLoopbackPort(),
    allocateLoopbackPort(),
  ]);
  const target = http.createServer((request, response) => {
    response.end(request.url === '/two-hop-proof' ? 'two-hop-ok' : 'wrong-target');
  });
  await new Promise<void>((resolveListen) => target.listen(0, '127.0.0.1', resolveListen));
  const address = target.address();
  assert.ok(address && typeof address === 'object');

  const systemProxy = spawn(gostBinary, ['-L', `http://127.0.0.1:${systemPort}`], {
    stdio: 'ignore',
  });
  const environmentProxy = spawn(gostBinary, ['-L', `socks5://env-user:env-pass@127.0.0.1:${environmentPort}`], {
    stdio: 'ignore',
  });
  const manager = createProxyChainManager({
    resolveSystemProxy: async () => ({
      ok: true,
      proxy: { proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(systemPort) },
    }),
    resolveBinary: async () => ({ ok: true, binaryPath: gostBinary }),
  });

  try {
    await Promise.all([waitForPort(systemPort), waitForPort(environmentPort)]);
    const endpoint = await manager.ensure({
      profileId: 'gost-integration',
      environmentProxy: {
        proxyType: 'socks5',
        proxyHost: '127.0.0.1',
        proxyPort: String(environmentPort),
        proxyUser: 'env-user',
        proxyPassword: 'env-pass',
      },
    });
    assert.equal(await requestThroughProxy(Number(endpoint.proxyPort), address.port), 'two-hop-ok');
  } finally {
    await manager.stopAll();
    stopChild(systemProxy);
    stopChild(environmentProxy);
    await new Promise<void>((resolveClose) => target.close(() => resolveClose()));
  }
});
