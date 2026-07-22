'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_PROTOCOL_VERSION = 2;
const EXPECTED_PLATFORM_ADAPTER_VERSION = 'xiaohongshu-v1';
const EXPECTED_CAPABILITY_DIGEST = '3867dff401e1b611cf628040681f20996925dce36182136c48fb6201f078e8eb';

function executableName(platform) {
  return platform === 'win32' ? 'aidcp-page-engine.exe' : 'aidcp-page-engine';
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function binaryArch(binary, platform) {
  if (platform === 'darwin' && binary.length >= 8) {
    const magic = binary.readUInt32BE(0);
    const littleEndian = magic === 0xcffaedfe;
    const bigEndian = magic === 0xfeedfacf;
    if (littleEndian || bigEndian) {
      const cpuType = littleEndian ? binary.readUInt32LE(4) : binary.readUInt32BE(4);
      if (cpuType === 0x01000007) return 'x64';
      if (cpuType === 0x0100000c) return 'arm64';
    }
  }
  if (platform === 'win32' && binary.length >= 0x40 && binary.subarray(0, 2).toString('ascii') === 'MZ') {
    const peOffset = binary.readUInt32LE(0x3c);
    if (peOffset + 6 <= binary.length && binary.subarray(peOffset, peOffset + 4).toString('binary') === 'PE\0\0') {
      const machine = binary.readUInt16LE(peOffset + 4);
      if (machine === 0x8664) return 'x64';
      if (machine === 0xaa64) return 'arm64';
    }
  }
  return 'unknown';
}

function verifyNativePageEngineArtifact(resourceDir, target = { platform: process.platform, arch: process.arch }) {
  const manifestPath = path.join(resourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectedExecutable = executableName(target.platform);
  if (
    manifest.schemaVersion !== 1
    || manifest.protocolVersion !== EXPECTED_PROTOCOL_VERSION
    || manifest.platformAdapterVersion !== EXPECTED_PLATFORM_ADAPTER_VERSION
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
  if (sha256(binary) !== manifest.sha256) {
    throw new Error('Native Page Engine executable SHA-256 does not match its manifest');
  }
  const actualArch = binaryArch(binary, target.platform);
  if (actualArch !== target.arch) {
    throw new Error(`Native Page Engine binary architecture mismatch: expected ${target.arch}, got ${actualArch}`);
  }
  if (target.platform !== 'win32' && (fs.statSync(binaryPath).mode & 0o111) === 0) {
    throw new Error('Native Page Engine executable bit is missing');
  }
  return { binaryPath, manifest };
}

module.exports = {
  EXPECTED_CAPABILITY_DIGEST,
  EXPECTED_PLATFORM_ADAPTER_VERSION,
  EXPECTED_PROTOCOL_VERSION,
  binaryArch,
  executableName,
  verifyNativePageEngineArtifact,
};
