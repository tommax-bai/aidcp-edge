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

function verifyPackagedXiaohongshuLeakage(asarPath) {
  const entries = asar.listPackage(asarPath);
  const forbiddenEntries = [
    '/native/page-engine/src/facebook-router/00-shared.js',
    '/native/page-engine/src/facebook-router/05-session.js',
    '/native/page-engine/src/facebook-router/10-feed-like.js',
    '/native/page-engine/src/facebook-router/20-feed.js',
    '/native/page-engine/src/facebook-router/30-reels.js',
    '/native/page-engine/src/facebook-router/40-group-join.js',
    '/native/page-engine/src/facebook-router/50-comment.js',
    '/native/page-engine/src/facebook-router/60-publish.js',
    '/native/page-engine/src/facebook-router/70-identity.js',
    '/native/page-engine/src/facebook-router/90-dispatch.js',
    '/dist/browse/browse-session.js',
    '/dist/browse/feed-scroller.js',
    '/dist/browse/modal-controller.js',
    '/dist/browse/note-extractor.js',
    '/dist/browse/search-handler.js',
    '/dist/browse/notification-monitor.js',
    '/dist/flows/publish-command-handlers.js',
    '/dist/client/cloud-selector.js',
    '/dist/client/like-runner.js',
    '/dist/locating/engine.js',
    '/dist/locating/cache.js',
  ];
  const leakedPath = forbiddenEntries.find((entry) => entries.includes(entry));
  if (leakedPath) throw new Error(`Packaged migrated Xiaohongshu JavaScript is forbidden: ${leakedPath}`);
  const sourceMap = entries.find((entry) => entry.startsWith('/dist/') && entry.endsWith('.map'));
  if (sourceMap) throw new Error(`Packaged source map is forbidden: ${sourceMap}`);
  const markers = [
    'FOLLOW_BUTTON_SELECTORS',
    'note.publish_set_cover',
    'creator-preview-image-0',
    'input.upload-input[type=file]',
    'data-aidcp-native-feed-like',
    'data-aidcp-native-reel-like-target',
    'targetGroupScope',
    'composer_editor_not_found',
  ];
  for (const entry of entries.filter((value) => value.startsWith('/dist/') && value.endsWith('.js'))) {
    const source = asar.extractFile(asarPath, entry.slice(1)).toString('utf8');
    const marker = markers.find((value) => source.includes(value));
    if (marker) throw new Error(`Packaged migrated Xiaohongshu rule marker is forbidden in ${entry}: ${marker}`);
  }
  if (!entries.includes('/dist/native-page-engine/runtime.js')) {
    throw new Error('Packaged selector-free Native Page Engine facade is missing');
  }
  return entries.filter((entry) => entry.startsWith('/dist/') && entry.endsWith('.js')).length;
}

async function afterPack(context) {
  const { asarPath, executable, nativeResourceDir, smokeEntry } = resolvePackagedSmokePaths(context);
  const packageCount = verifyPackagedDependencyClosure(asarPath, resolve(__dirname, '..', 'package-lock.json'));
  const runtimeModuleCount = verifyPackagedXiaohongshuLeakage(asarPath);
  const targetArch = normalizeTargetArch(context.arch) || 'unknown';
  verifyNativePageEngineArtifact(nativeResourceDir, {
    platform: context.electronPlatformName,
    arch: targetArch,
  });
  console.log(`Native Page Engine artifact verified for ${context.electronPlatformName}/${targetArch}.`);
  console.log(`Packaged Xiaohongshu JavaScript leakage scan passed across ${runtimeModuleCount} runtime modules.`);

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
module.exports.verifyPackagedXiaohongshuLeakage = verifyPackagedXiaohongshuLeakage;
