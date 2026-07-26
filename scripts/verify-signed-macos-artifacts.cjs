'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyPackagedGostArtifact } = require('../src/electron/gost-artifact.cjs');
const {
  verifyPackagedNativePageEngineArtifact,
} = require('../src/electron/native-page-engine-artifact.cjs');

function verifySignedMacArtifacts(appBundlePath, { arch } = {}) {
  const resourcesPath = path.join(appBundlePath, 'Contents', 'Resources');
  const gostResourceDir = path.join(resourcesPath, 'gost');
  const nativeResourceDir = path.join(resourcesPath, 'native-page-engine');
  const gostManifest = JSON.parse(fs.readFileSync(path.join(gostResourceDir, 'manifest.json'), 'utf8'));
  const targetArch = arch || gostManifest.arch;

  verifyPackagedGostArtifact(gostResourceDir, {
    appBundlePath,
    platform: 'darwin',
    arch: targetArch,
  });
  verifyPackagedNativePageEngineArtifact(nativeResourceDir, {
    appBundlePath,
    platform: 'darwin',
    arch: targetArch,
  });
  return { arch: targetArch, gostResourceDir, nativeResourceDir };
}

if (require.main === module) {
  const appBundlePath = path.resolve(process.argv[2] || '');
  if (!process.argv[2] || !fs.statSync(appBundlePath).isDirectory()) {
    throw new Error('usage: node scripts/verify-signed-macos-artifacts.cjs /path/to/AIDCP.app [arch]');
  }
  const result = verifySignedMacArtifacts(appBundlePath, { arch: process.argv[3] || undefined });
  console.log(`Signed nested macOS artifacts verified for ${result.arch}: ${appBundlePath}`);
}

module.exports = {
  verifySignedMacArtifacts,
};
