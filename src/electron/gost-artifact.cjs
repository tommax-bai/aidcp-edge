'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { binaryArch } = require('./binary-artifact.cjs');
const {
  requireSuccessfulCommand,
  runCommand,
  verifySignedMacArtifact,
} = require('./macos-signed-artifact.cjs');

const GOST_VERSION = '3.2.6';
const GOST_ARCHIVE_SHA256 = Object.freeze({
  'darwin-x64': '0892485bd94e37b67a1f1d0d2372ed12d7dc0f1bc763d56177a0c0ee734855e6',
  'darwin-arm64': 'e54f6c22e81c00650adfbbb23317c74a4dca9b9b73fa28cfa150f5559cc3ff2e',
});

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function readGostArtifact(resourceDir, {
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const key = `${platform}-${arch}`;
  const expectedArchiveSha256 = GOST_ARCHIVE_SHA256[key];
  if (!expectedArchiveSha256) throw new Error(`unsupported GOST artifact target: ${key}`);
  const manifestPath = path.join(resourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1
    || manifest.name !== 'gost'
    || manifest.version !== GOST_VERSION
    || manifest.platform !== platform
    || manifest.arch !== arch
    || manifest.archiveSha256 !== expectedArchiveSha256
    || manifest.binary !== 'gost'
    || manifest.license !== 'LICENSE'
    || !/^[a-f0-9]{64}$/.test(manifest.binarySha256 || '')) {
    throw new Error('invalid GOST artifact manifest');
  }
  const binaryPath = path.join(resourceDir, manifest.binary);
  fs.accessSync(binaryPath, fs.constants.R_OK | fs.constants.X_OK);
  const license = fs.readFileSync(path.join(resourceDir, manifest.license), 'utf8');
  if (!license.startsWith('MIT License\n\nCopyright (c) 2016 ginuerzh')) {
    throw new Error('GOST license is missing or invalid');
  }
  return { binaryPath, manifest };
}

function verifyGostArtifact(resourceDir, target = {}) {
  const artifact = readGostArtifact(resourceDir, target);
  if (sha256(fs.readFileSync(artifact.binaryPath)) !== artifact.manifest.binarySha256) {
    throw new Error('GOST artifact checksum mismatch');
  }
  return artifact;
}

function verifyRuntimeGostArtifact(resourceDir, {
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const artifact = readGostArtifact(resourceDir, { platform, arch });
  const actualArch = binaryArch(fs.readFileSync(artifact.binaryPath), platform);
  if (actualArch !== arch) {
    throw new Error(`GOST architecture mismatch: expected ${arch}, got ${actualArch}`);
  }
  return artifact;
}

function verifyPackagedGostArtifact(resourceDir, {
  appBundlePath,
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error(`signed packaged GOST verification is unsupported on ${platform}`);
  }
  const artifact = readGostArtifact(resourceDir, { platform, arch });
  verifySignedMacArtifact(artifact.binaryPath, {
    appBundlePath,
    arch,
    identifier: 'gost',
    run,
  });
  const versionOutput = requireSuccessfulCommand(
    run(artifact.binaryPath, ['-V']),
    'GOST version verification',
  );
  if (!new RegExp(`^gost v${GOST_VERSION.replaceAll('.', '\\.')}\\b`, 'm').test(versionOutput)) {
    throw new Error(`GOST version mismatch: expected ${GOST_VERSION}`);
  }
  return artifact;
}

module.exports = {
  GOST_ARCHIVE_SHA256,
  GOST_VERSION,
  readGostArtifact,
  sha256,
  verifyGostArtifact,
  verifyPackagedGostArtifact,
  verifyRuntimeGostArtifact,
};
