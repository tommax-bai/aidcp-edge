'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { binaryArch } = require('./binary-artifact.cjs');
const {
  runCommand,
  verifySignedMacArtifact,
} = require('./macos-signed-artifact.cjs');

const EXPECTED_PROTOCOL_VERSION = 2;
const EXPECTED_PLATFORM_ADAPTER_VERSION = 'multi-platform-v1';
const EXPECTED_PLATFORM_ADAPTERS = Object.freeze([
  Object.freeze({ platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-v1' }),
  Object.freeze({ platform: 'facebook', adapterVersion: 'facebook-v1' }),
  Object.freeze({ platform: 'wechat_channels', adapterVersion: 'wechat-channels-v1' }),
]);
const EXPECTED_CAPABILITY_DIGEST = '89c8488c1e475780b6b9fedde8b14fcb06d5285884e5bda1d325ef26da4b1c71';

function executableName(platform) {
  return platform === 'win32' ? 'aidcp-page-engine.exe' : 'aidcp-page-engine';
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function readNativePageEngineArtifact(
  resourceDir,
  target = { platform: process.platform, arch: process.arch },
) {
  const manifestPath = path.join(resourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectedExecutable = executableName(target.platform);
  if (
    manifest.schemaVersion !== 1
    || manifest.protocolVersion !== EXPECTED_PROTOCOL_VERSION
    || manifest.platformAdapterVersion !== EXPECTED_PLATFORM_ADAPTER_VERSION
    || JSON.stringify(manifest.platformAdapters) !== JSON.stringify(EXPECTED_PLATFORM_ADAPTERS)
    || manifest.capabilityDigest !== EXPECTED_CAPABILITY_DIGEST
    || manifest.platform !== target.platform
    || manifest.arch !== target.arch
    || manifest.executable !== expectedExecutable
    || !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error(`Native Page Engine manifest is incompatible with ${target.platform}-${target.arch}`);
  }
  const binaryPath = path.join(resourceDir, expectedExecutable);
  const binary = fs.readFileSync(binaryPath);
  const actualArch = binaryArch(binary, target.platform);
  if (actualArch !== target.arch) {
    throw new Error(`Native Page Engine binary architecture mismatch: expected ${target.arch}, got ${actualArch}`);
  }
  if (target.platform !== 'win32' && (fs.statSync(binaryPath).mode & 0o111) === 0) {
    throw new Error('Native Page Engine executable bit is missing');
  }
  return { binaryPath, manifest };
}

function verifyNativePageEngineArtifact(
  resourceDir,
  target = { platform: process.platform, arch: process.arch },
) {
  const artifact = readNativePageEngineArtifact(resourceDir, target);
  if (sha256(fs.readFileSync(artifact.binaryPath)) !== artifact.manifest.sha256) {
    throw new Error('Native Page Engine executable SHA-256 does not match its manifest');
  }
  return artifact;
}

function verifyPackagedNativePageEngineArtifact(resourceDir, {
  appBundlePath,
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error(`signed packaged Native Page Engine verification is unsupported on ${platform}`);
  }
  const artifact = readNativePageEngineArtifact(resourceDir, { platform, arch });
  verifySignedMacArtifact(artifact.binaryPath, {
    appBundlePath,
    arch,
    identifier: 'aidcp-page-engine',
    run,
  });
  return artifact;
}

module.exports = {
  EXPECTED_CAPABILITY_DIGEST,
  EXPECTED_PLATFORM_ADAPTER_VERSION,
  EXPECTED_PLATFORM_ADAPTERS,
  EXPECTED_PROTOCOL_VERSION,
  binaryArch,
  executableName,
  readNativePageEngineArtifact,
  verifyNativePageEngineArtifact,
  verifyPackagedNativePageEngineArtifact,
};
