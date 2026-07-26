import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const orphans = require('../../src/electron/proxy-chain-orphans.cjs') as {
  commandMatchesBinary(command: string, binaryPath: string): boolean;
  createProxyChainOrphanRegistry(options: Record<string, unknown>): {
    cleanup(): Promise<{ ok: boolean; reason?: string }>;
    add(pid: number, binaryPath: string): Promise<{ ok: boolean; reason?: string }>;
    remove(pid: number): Promise<{ ok: boolean; reason?: string }>;
  };
};

test('orphan cleanup kills only an exact previously registered GOST executable', async () => {
  let records = [
    { pid: 101, binaryPath: '/Applications/AIDCP.app/Contents/Resources/gost/gost' },
    { pid: 202, binaryPath: '/Applications/AIDCP.app/Contents/Resources/gost/gost' },
  ];
  const commands = new Map([
    [101, '/Applications/AIDCP.app/Contents/Resources/gost/gost -C -'],
    [202, '/usr/local/bin/unrelated --name gost'],
  ]);
  const killed: Array<[number, string]> = [];
  const registry = orphans.createProxyChainOrphanRegistry({
    registryPath: '/tmp/aidcp-test/proxy-chain-processes.json',
    read: () => records,
    write: (_path: string, next: typeof records) => { records = next; },
    inspectProcess: async (pid: number) => commands.get(pid) || '',
    killProcess: (pid: number, signal: string) => {
      killed.push([pid, signal]);
      commands.delete(pid);
    },
    sleep: async () => undefined,
  });

  assert.deepEqual(await registry.cleanup(), { ok: true });
  assert.deepEqual(killed, [[101, 'SIGTERM']]);
  assert.deepEqual(records, []);
  assert.equal(orphans.commandMatchesBinary('/safe/gost-helper -C -', '/safe/gost'), false);
});

test('registry tracks only absolute valid child records and removes them on shutdown', async () => {
  let records: Array<{ pid: number; binaryPath: string }> = [];
  const registry = orphans.createProxyChainOrphanRegistry({
    registryPath: '/tmp/aidcp-test/proxy-chain-processes.json',
    read: () => [],
    write: (_path: string, next: typeof records) => { records = next; },
    inspectProcess: async () => '',
    sleep: async () => undefined,
  });
  await registry.cleanup();
  assert.equal((await registry.add(303, '/safe/gost')).ok, true);
  assert.deepEqual(records, [{ pid: 303, binaryPath: '/safe/gost' }]);
  assert.equal((await registry.add(0, 'gost')).reason, 'proxy_chain_process_untracked');
  await registry.remove(303);
  assert.deepEqual(records, []);
});
