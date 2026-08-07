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
  verifyRuntimeNativePageEngineArtifact(
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
    capabilityDigest: 'b5da30fbaf752614b977f899cf6fa38953a9c5c4e697813e058553c68da782a1',
    sourceDigest: '1'.repeat(64),
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

// 5.5：打包态校验必须接受并校验源码摘要字段，缺字段视为不兼容清单。
// 失败优先：先证明缺了这个字段会红，再谈「已接受」。缺字段说明该产物出自还没有把
// 产物与源码绑定的构建器 —— 它的自洽（二进制哈希 / 能力摘要 / crate 版本号）对源码漂移
// 完全无感，放行等于让一份相对源码已过期的引擎照常出包、照常签名、照常发出去。
test('packaged verification refuses a manifest without a bound engine-source digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aidcp-native-artifact-nodigest-'));
  const binary = macho(0x0100000c);
  const binaryPath = join(dir, 'aidcp-page-engine');
  await writeFile(binaryPath, binary);
  await chmod(binaryPath, 0o755);
  const manifest = {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    protocolVersion: 2,
    platformAdapterVersion: 'multi-platform-v1',
    platformAdapters: [
      { platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-v1' },
      { platform: 'facebook', adapterVersion: 'facebook-v1' },
      { platform: 'wechat_channels', adapterVersion: 'wechat-channels-v1' },
    ],
    capabilityDigest: 'b5da30fbaf752614b977f899cf6fa38953a9c5c4e697813e058553c68da782a1',
    platform: 'darwin',
    arch: 'arm64',
    executable: 'aidcp-page-engine',
    sha256: createHash('sha256').update(binary).digest('hex'),
  };
  const target = { platform: 'darwin', arch: 'arm64' };

  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(
    () => artifact.verifyNativePageEngineArtifact(dir, target),
    /manifest is incompatible/,
  );

  // 形状也要判：一个不是 sha256 的占位串同样不算「已绑定」。
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...manifest, sourceDigest: 'not-a-digest' }),
  );
  assert.throws(
    () => artifact.verifyNativePageEngineArtifact(dir, target),
    /manifest is incompatible/,
  );

  // 对照：带上合法摘要即放行，证明上面两条红的是摘要判据本身，不是别的检查。
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...manifest, sourceDigest: 'a'.repeat(64) }),
  );
  assert.equal(
    artifact.verifyNativePageEngineArtifact(dir, target).binaryPath,
    binaryPath,
  );
});

test('installed runtime accepts signed-byte drift while retaining manifest and architecture checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aidcp-native-runtime-artifact-'));
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
    capabilityDigest: 'b5da30fbaf752614b977f899cf6fa38953a9c5c4e697813e058553c68da782a1',
    sourceDigest: '1'.repeat(64),
    platform: 'darwin',
    arch: 'arm64',
    executable: 'aidcp-page-engine',
    sha256: '0'.repeat(64),
  }));
  assert.equal(
    artifact.verifyRuntimeNativePageEngineArtifact(
      dir,
      { platform: 'darwin', arch: 'arm64' },
    ).binaryPath,
    binaryPath,
  );
});
