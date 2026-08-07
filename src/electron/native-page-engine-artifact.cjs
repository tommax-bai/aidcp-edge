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
const EXPECTED_CAPABILITY_DIGEST = '936375a80b97370dbe495b8bc5b17838bdbf516341c7f552d710cbd46ec5f186';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/**
 * 引擎源码输入摘要（`scripts/build-native-page-engine.mjs` 的 `sourceDigest`）。
 *
 * 打包态**无法重算**它：安装包里没有 Rust 源码树与页面规则分片。所以这里只能判
 * 「在不在、像不像一个 sha256」—— 但这已经是它要挡的那件事：清单里没有这个字段，
 * 说明这份产物出自**还没有把产物与源码绑定**的构建器，它的自洽（二进制哈希 / 能力摘要 /
 * crate 版本号）对源码漂移完全无感。缺字段一律判不兼容，MUST NOT 当成「旧版兼容」放行。
 *
 * ⚠️ 落地顺序（踩过一次，写下来防复发）：本文件**硬校验 `schemaVersion === 1`**。
 * 因此写入侧（5.1）只新增字段、没有抬版本号 —— 先抬版本会让打包在这里就炸。
 * 现在读取侧已接受该字段，才谈得上抬版本；抬的时候两侧必须在同一个提交里一起动。
 * 这条路径不是死代码：**每一次出包都会跑到**（`scripts/after-pack.cjs` 打包后置校验）。
 */
function hasBoundSourceDigest(manifest) {
  return typeof manifest.sourceDigest === 'string' && DIGEST_PATTERN.test(manifest.sourceDigest);
}

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
    || !hasBoundSourceDigest(manifest)
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

function verifyRuntimeNativePageEngineArtifact(
  resourceDir,
  target = { platform: process.platform, arch: process.arch },
) {
  return readNativePageEngineArtifact(resourceDir, target);
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
  verifyRuntimeNativePageEngineArtifact,
};
