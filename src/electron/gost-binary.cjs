'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  verifyGostArtifact,
  verifyPackagedGostArtifact,
} = require('./gost-artifact.cjs');

const GOST_EXECUTABLE = process.platform === 'win32' ? 'gost.exe' : 'gost';

function resolveGostBinaryPath({
  appRoot,
  resourcesPath,
  isPackaged = false,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const explicit = isPackaged ? '' : String((env && env.AIDCP_GOST_BINARY) || '').trim();
  if (explicit) {
    const candidate = path.resolve(explicit);
    try {
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.X_OK);
      return { ok: true, binaryPath: candidate };
    } catch {
      // An invalid explicit override may still fall through to the verified bundled artifact.
    }
  }
  const resourceDir = isPackaged && resourcesPath
    ? path.join(resourcesPath, 'gost')
    : appRoot
      ? path.join(appRoot, 'build', 'gost', `${platform}-${arch}`)
      : '';
  if (resourceDir) {
    try {
      const verified = isPackaged && platform === 'darwin'
        ? verifyPackagedGostArtifact(resourceDir, {
          appBundlePath: path.resolve(resourcesPath, '..', '..'),
          platform,
          arch,
        })
        : verifyGostArtifact(resourceDir, { platform, arch });
      return { ok: true, binaryPath: verified.binaryPath };
    } catch {
      // Missing, stale, non-executable, or untrusted artifacts all fail closed.
    }
  }
  return { ok: false, reason: 'proxy_chain_binary_missing' };
}

module.exports = {
  GOST_EXECUTABLE,
  resolveGostBinaryPath,
};
