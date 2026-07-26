import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const gostArtifact = require('../../src/electron/gost-artifact.cjs') as {
  verifyPackagedGostArtifact(
    resourceDir: string,
    options: Record<string, unknown>,
  ): { binaryPath: string };
};
const nativeArtifact = require('../../src/electron/native-page-engine-artifact.cjs') as {
  verifyPackagedNativePageEngineArtifact(
    resourceDir: string,
    options: Record<string, unknown>,
  ): { binaryPath: string };
};

function arm64MachO(): Buffer {
  const binary = Buffer.alloc(16);
  binary.writeUInt32BE(0xcffaedfe, 0);
  binary.writeUInt32LE(0x0100000c, 4);
  return binary;
}

function signatureOutput(identifier: string, teamIdentifier = 'DK3BYZ9K32'): string {
  return [
    `Identifier=${identifier}`,
    'Authority=Developer ID Application: tianxing bai (DK3BYZ9K32)',
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    `TeamIdentifier=${teamIdentifier}`,
    `designated => identifier "${identifier}" and anchor apple generic `
      + 'and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ '
      + 'and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ '
      + `and certificate leaf[subject.OU] = ${teamIdentifier}`,
  ].join('\n');
}

function signedRunner({
  appBundlePath,
  gostPath,
  nativePath,
  gostTeamIdentifier = 'DK3BYZ9K32',
}: {
  appBundlePath: string;
  gostPath: string;
  nativePath: string;
  gostTeamIdentifier?: string;
}) {
  return (command: string, args: string[]) => {
    if (command === gostPath && args[0] === '-V') {
      return { status: 0, stdout: 'gost v3.2.6 (go1.25.4 darwin/arm64)\n', stderr: '' };
    }
    if (command !== '/usr/bin/codesign') {
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    }
    if (args[0] === '--verify') {
      return { status: 0, stdout: '', stderr: `${args.at(-1)}: valid on disk\n` };
    }
    const target = args.at(-1);
    if (target === appBundlePath) {
      return { status: 0, stdout: '', stderr: signatureOutput('com.aidcp.edge') };
    }
    if (target === gostPath) {
      return { status: 0, stdout: '', stderr: signatureOutput('gost', gostTeamIdentifier) };
    }
    if (target === nativePath) {
      return { status: 0, stdout: '', stderr: signatureOutput('aidcp-page-engine') };
    }
    return { status: 1, stdout: '', stderr: 'unexpected target' };
  };
}

async function writeSignedLikeApp() {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-signed-artifacts-'));
  const appBundlePath = join(root, 'AIDCP.app');
  const resourcesPath = join(appBundlePath, 'Contents', 'Resources');
  const gostDir = join(resourcesPath, 'gost');
  const nativeDir = join(resourcesPath, 'native-page-engine');
  await mkdir(gostDir, { recursive: true });
  await mkdir(nativeDir, { recursive: true });

  const gostPath = join(gostDir, 'gost');
  const nativePath = join(nativeDir, 'aidcp-page-engine');
  await writeFile(gostPath, arm64MachO());
  await writeFile(nativePath, arm64MachO());
  await chmod(gostPath, 0o755);
  await chmod(nativePath, 0o755);
  await writeFile(join(gostDir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2016 ginuerzh\n');
  await writeFile(join(gostDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'gost',
    version: '3.2.6',
    platform: 'darwin',
    arch: 'arm64',
    archiveSha256: 'e54f6c22e81c00650adfbbb23317c74a4dca9b9b73fa28cfa150f5559cc3ff2e',
    binary: 'gost',
    binarySha256: '0'.repeat(64),
    license: 'LICENSE',
  }));
  await writeFile(join(nativeDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    protocolVersion: 2,
    platformAdapterVersion: 'multi-platform-v1',
    platformAdapters: [
      { platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-v1' },
      { platform: 'facebook', adapterVersion: 'facebook-v1' },
      { platform: 'wechat_channels', adapterVersion: 'wechat-channels-v1' },
    ],
    capabilityDigest: '89c8488c1e475780b6b9fedde8b14fcb06d5285884e5bda1d325ef26da4b1c71',
    platform: 'darwin',
    arch: 'arm64',
    executable: 'aidcp-page-engine',
    sha256: '0'.repeat(64),
  }));
  return { appBundlePath, gostDir, gostPath, nativeDir, nativePath };
}

test('signed packaged artifacts trust Developer ID identity instead of pre-sign file hashes', async () => {
  const paths = await writeSignedLikeApp();
  const run = signedRunner(paths);
  assert.equal(gostArtifact.verifyPackagedGostArtifact(paths.gostDir, {
    appBundlePath: paths.appBundlePath,
    platform: 'darwin',
    arch: 'arm64',
    run,
  }).binaryPath, paths.gostPath);
  assert.equal(nativeArtifact.verifyPackagedNativePageEngineArtifact(paths.nativeDir, {
    appBundlePath: paths.appBundlePath,
    platform: 'darwin',
    arch: 'arm64',
    run,
  }).binaryPath, paths.nativePath);
});

test('signed packaged GOST rejects a mismatched Developer ID Team ID', async () => {
  const paths = await writeSignedLikeApp();
  assert.throws(
    () => gostArtifact.verifyPackagedGostArtifact(paths.gostDir, {
      appBundlePath: paths.appBundlePath,
      platform: 'darwin',
      arch: 'arm64',
      run: signedRunner({ ...paths, gostTeamIdentifier: 'OTHERTEAM01' }),
    }),
    /Team ID mismatch/,
  );
});
