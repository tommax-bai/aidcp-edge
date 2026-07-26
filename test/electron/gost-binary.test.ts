import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const binary = require('../../src/electron/gost-binary.cjs') as {
  resolveGostBinaryPath(input?: Record<string, unknown>): { ok: boolean; binaryPath?: string; reason?: string };
};
const ARM64_ARCHIVE_SHA256 = 'e54f6c22e81c00650adfbbb23317c74a4dca9b9b73fa28cfa150f5559cc3ff2e';

async function writeStagedArtifact(root: string, contents = '#!/bin/sh\nexit 0\n') {
  const staged = join(root, 'build', 'gost', 'darwin-arm64');
  await mkdir(staged, { recursive: true });
  const stagedBinary = join(staged, 'gost');
  await writeFile(stagedBinary, contents);
  await chmod(stagedBinary, 0o755);
  await writeFile(join(staged, 'LICENSE'), 'MIT License\n\nCopyright (c) 2016 ginuerzh\n');
  await writeFile(join(staged, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'gost',
    version: '3.2.6',
    platform: 'darwin',
    arch: 'arm64',
    archiveSha256: ARM64_ARCHIVE_SHA256,
    binary: 'gost',
    binarySha256: createHash('sha256').update(contents).digest('hex'),
    license: 'LICENSE',
  }));
  return stagedBinary;
}

test('gost binary resolver prefers explicit executable and otherwise uses staged dev resource', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-gost-binary-'));
  const explicit = join(root, 'explicit-gost');
  await writeFile(explicit, '#!/bin/sh\nexit 0\n');
  await chmod(explicit, 0o755);
  assert.equal(binary.resolveGostBinaryPath({
    appRoot: root,
    platform: 'darwin',
    arch: 'arm64',
    env: { AIDCP_GOST_BINARY: explicit },
  }).binaryPath, explicit);

  const stagedBinary = await writeStagedArtifact(root);
  assert.equal(binary.resolveGostBinaryPath({
    appRoot: root,
    platform: 'darwin',
    arch: 'arm64',
    env: {},
  }).binaryPath, stagedBinary);
});

test('gost binary resolver fails closed for missing or non-executable candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-gost-missing-'));
  const candidate = join(root, 'gost');
  await writeFile(candidate, 'not executable');
  assert.deepEqual(binary.resolveGostBinaryPath({
    appRoot: root,
    env: { AIDCP_GOST_BINARY: candidate },
  }), { ok: false, reason: 'proxy_chain_binary_missing' });
});

test('gost binary resolver rejects a tampered staged artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-gost-tampered-'));
  const stagedBinary = await writeStagedArtifact(root);
  await writeFile(stagedBinary, '#!/bin/sh\nexit 7\n');
  assert.deepEqual(binary.resolveGostBinaryPath({
    appRoot: root,
    platform: 'darwin',
    arch: 'arm64',
    env: {},
  }), { ok: false, reason: 'proxy_chain_binary_missing' });
});
