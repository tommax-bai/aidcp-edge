import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const artifact = require('../../src/electron/native-page-engine-artifact.cjs') as {
  binaryArch(binary: Buffer, platform: string): string;
  verifyNativePageEngineArtifact(
    resourceDir: string,
    target: { platform: string; arch: string },
  ): { binaryPath: string; manifest: Record<string, unknown> };
};

function macho(cpuType: number): Buffer {
  const binary = Buffer.alloc(16);
  binary.writeUInt32BE(0xcffaedfe, 0);
  binary.writeUInt32LE(cpuType, 4);
  return binary;
}

test('recognizes thin x64 and arm64 Mach-O headers', () => {
  assert.equal(artifact.binaryArch(macho(0x01000007), 'darwin'), 'x64');
  assert.equal(artifact.binaryArch(macho(0x0100000c), 'darwin'), 'arm64');
});

test('rejects a manifest that lies about the binary architecture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aidcp-native-artifact-'));
  const binary = macho(0x0100000c);
  const binaryPath = join(dir, 'aidcp-page-engine');
  await writeFile(binaryPath, binary);
  await chmod(binaryPath, 0o755);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    protocolVersion: 2,
    platformAdapterVersion: 'multi-platform-v1',
    platformAdapters: [
      { platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-v1' },
      { platform: 'facebook', adapterVersion: 'facebook-v1' },
      { platform: 'wechat_channels', adapterVersion: 'wechat-channels-v1' },
    ],
    capabilityDigest: '8ec2b0281599d863e250398c598d41ac8ed233e57764fa61513abb898fc8a8a3',
    platform: 'darwin',
    arch: 'x64',
    executable: 'aidcp-page-engine',
    sha256: createHash('sha256').update(binary).digest('hex'),
  }));
  assert.throws(
    () => artifact.verifyNativePageEngineArtifact(dir, { platform: 'darwin', arch: 'x64' }),
    /architecture mismatch/,
  );
});
