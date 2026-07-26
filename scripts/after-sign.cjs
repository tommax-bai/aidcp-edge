'use strict';

const path = require('node:path');
const {
  runCommand,
  signatureMetadata,
} = require('../src/electron/macos-signed-artifact.cjs');
const { verifySignedMacArtifacts } = require('./verify-signed-macos-artifacts.cjs');

const ARCH_NAMES = Object.freeze({
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
});

function normalizeTargetArch(arch) {
  return typeof arch === 'number' ? ARCH_NAMES[arch] : arch;
}

async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const productFilename = context.packager.appInfo.productFilename;
  const appBundlePath = path.join(context.appOutDir, `${productFilename}.app`);
  const arch = normalizeTargetArch(context.arch);
  let metadata;
  try {
    metadata = signatureMetadata(appBundlePath, runCommand);
  } catch {
    console.log(`Developer ID signature absent; signed nested artifact gate skipped for ${appBundlePath}.`);
    return;
  }
  if (!metadata.authorities.some((authority) => authority.startsWith('Developer ID Application:'))) {
    console.log(`Developer ID signature absent; signed nested artifact gate skipped for ${appBundlePath}.`);
    return;
  }
  verifySignedMacArtifacts(appBundlePath, { arch });
}

module.exports = afterSign;
module.exports.normalizeTargetArch = normalizeTargetArch;
