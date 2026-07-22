'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const asar = require('@electron/asar');
const { verifyNativePageEngineArtifact } = require('../src/electron/native-page-engine-artifact.cjs');

const ARCH_NAMES = Object.freeze({
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
});

function resolvePackagedSmokePaths(context) {
  const platform = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;
  const appOutDir = context.appOutDir;

  if (platform === 'darwin') {
    const appRoot = join(appOutDir, `${productFilename}.app`, 'Contents');
    return {
      executable: join(appRoot, 'MacOS', productFilename),
      asarPath: join(appRoot, 'Resources', 'app.asar'),
      nativeResourceDir: join(appRoot, 'Resources', 'native-page-engine'),
      smokeEntry: join(appRoot, 'Resources', 'app.asar', 'src', 'electron', 'packaged-runtime-smoke.cjs'),
    };
  }
  if (platform === 'win32') {
    return {
      executable: join(appOutDir, `${productFilename}.exe`),
      asarPath: join(appOutDir, 'resources', 'app.asar'),
      nativeResourceDir: join(appOutDir, 'resources', 'native-page-engine'),
      smokeEntry: join(appOutDir, 'resources', 'app.asar', 'src', 'electron', 'packaged-runtime-smoke.cjs'),
    };
  }
  return {
    executable: join(appOutDir, productFilename),
    asarPath: join(appOutDir, 'resources', 'app.asar'),
    nativeResourceDir: join(appOutDir, 'resources', 'native-page-engine'),
    smokeEntry: join(appOutDir, 'resources', 'app.asar', 'src', 'electron', 'packaged-runtime-smoke.cjs'),
  };
}

function normalizeTargetArch(arch) {
  return typeof arch === 'number' ? ARCH_NAMES[arch] : arch;
}

function canExecutePackagedBinary(context, host = { platform: process.platform, arch: process.arch }) {
  const targetArch = normalizeTargetArch(context.arch);
  if (context.electronPlatformName !== host.platform) return false;
  if (targetArch === 'universal' && host.platform === 'darwin') return true;
  return targetArch === host.arch;
}

function productionPackageEntries(packageLockPath) {
  const lock = JSON.parse(readFileSync(packageLockPath, 'utf8'));
  return Object.entries(lock.packages || {})
    .filter(([path, metadata]) => path.startsWith('node_modules/') && metadata.dev !== true && metadata.optional !== true)
    .map(([path]) => `/${path}/package.json`);
}

function verifyPackagedDependencyClosure(asarPath, packageLockPath) {
  const packagedEntries = new Set(asar.listPackage(asarPath));
  const requiredEntries = [
    '/src/electron/packaged-runtime-smoke.cjs',
    ...productionPackageEntries(packageLockPath),
  ];
  const missing = requiredEntries.filter((entry) => !packagedEntries.has(entry));
  if (missing.length > 0) {
    throw new Error(`Packaged runtime dependency closure is incomplete:\n${missing.join('\n')}`);
  }
  return requiredEntries.length - 1;
}

async function afterPack(context) {
  const { asarPath, executable, nativeResourceDir, smokeEntry } = resolvePackagedSmokePaths(context);
  const packageCount = verifyPackagedDependencyClosure(asarPath, resolve(__dirname, '..', 'package-lock.json'));
  const targetArch = normalizeTargetArch(context.arch) || 'unknown';
  verifyNativePageEngineArtifact(nativeResourceDir, {
    platform: context.electronPlatformName,
    arch: targetArch,
  });
  console.log(`Native Page Engine artifact verified for ${context.electronPlatformName}/${targetArch}.`);

  if (!canExecutePackagedBinary(context)) {
    console.log(
      `Packaged dependency closure verified statically: ${packageCount} production packages present ` +
      `(target ${context.electronPlatformName}/${targetArch}, host ${process.platform}/${process.arch}).`,
    );
    return;
  }

  const output = execFileSync(executable, [smokeEntry], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
  });
  process.stdout.write(output);
}

module.exports = afterPack;
module.exports.canExecutePackagedBinary = canExecutePackagedBinary;
module.exports.normalizeTargetArch = normalizeTargetArch;
module.exports.productionPackageEntries = productionPackageEntries;
module.exports.resolvePackagedSmokePaths = resolvePackagedSmokePaths;
module.exports.verifyPackagedDependencyClosure = verifyPackagedDependencyClosure;
