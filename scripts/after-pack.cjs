'use strict';

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const asar = require('@electron/asar');
const {
  PRODUCTION_FORBIDDEN_MARKERS,
  RETIRED_DIST_MODULES,
  assertPackagingAllowListExcludesFragments,
  packagedFragmentEntries,
} = require('./native-engine-inventory.cjs');
const { verifyNativePageEngineArtifact } = require('../src/electron/native-page-engine-artifact.cjs');
const { verifyGostArtifact } = require('../src/electron/gost-artifact.cjs');

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
      gostResourceDir: join(appRoot, 'Resources', 'gost'),
      smokeEntry: join(appRoot, 'Resources', 'app.asar', 'src', 'electron', 'packaged-runtime-smoke.cjs'),
    };
  }
  if (platform === 'win32') {
    return {
      executable: join(appOutDir, `${productFilename}.exe`),
      asarPath: join(appOutDir, 'resources', 'app.asar'),
      nativeResourceDir: join(appOutDir, 'resources', 'native-page-engine'),
      gostResourceDir: join(appOutDir, 'resources', 'gost'),
      smokeEntry: join(appOutDir, 'resources', 'app.asar', 'src', 'electron', 'packaged-runtime-smoke.cjs'),
    };
  }
  return {
    executable: join(appOutDir, productFilename),
    asarPath: join(appOutDir, 'resources', 'app.asar'),
    nativeResourceDir: join(appOutDir, 'resources', 'native-page-engine'),
    gostResourceDir: join(appOutDir, 'resources', 'gost'),
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

function resolvePackagedSmokeRunner(
  context,
  options = {},
) {
  const host = options.host ?? { platform: process.platform, arch: process.arch };
  if (!canExecutePackagedBinary(context, host)) return null;

  const packagedPaths = resolvePackagedSmokePaths(context);
  if (context.electronPlatformName !== 'darwin') {
    return {
      kind: 'packaged-product',
      executable: packagedPaths.executable,
    };
  }

  const projectRoot = resolve(options.projectRoot ?? resolve(__dirname, '..'));
  const appPath = join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
  return {
    kind: 'trusted-dev-electron',
    appPath,
    executable: join(appPath, 'Contents', 'MacOS', 'Electron'),
  };
}

function verifyPackagedSmokeRunner(runner, options = {}) {
  if (runner.kind !== 'trusted-dev-electron') return;

  const pathExists = options.pathExists ?? existsSync;
  if (!pathExists(runner.appPath) || !pathExists(runner.executable)) {
    throw new Error(
      `Trusted Electron smoke runner is missing at ${runner.appPath}. ` +
      'Run npm ci so postinstall can install and verify the development Electron runtime.',
    );
  }

  const run = options.run ?? execFileSync;
  try {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', runner.appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      `Trusted Electron smoke runner has an invalid code signature at ${runner.appPath}. ` +
      'Run npm ci so postinstall can restore its verified local development signature.',
    );
  }
}

function boundedChildOutput(value, limit = 2_000) {
  const output = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  const trimmed = output.trim();
  if (!trimmed) return '';
  return trimmed.length <= limit ? trimmed : `[last ${limit} characters]\n${trimmed.slice(-limit)}`;
}

function packagedSmokeFailure(error, runner, timeoutMs) {
  const reason = Number.isInteger(error?.status)
    ? `exit code ${error.status}`
    : error?.signal
      ? `signal ${error.signal}${error.killed ? ` after ${timeoutMs} ms timeout` : ''}`
      : error?.killed
        ? `timeout after ${timeoutMs} ms`
        : 'child-process launch failure';
  const stdout = boundedChildOutput(error?.stdout);
  const stderr = boundedChildOutput(error?.stderr);
  const evidence = [
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ].filter(Boolean).join('\n');
  return new Error(
    `Packaged runtime smoke failed with ${reason} using ${runner.kind} (${runner.executable}).` +
    (evidence ? `\n${evidence}` : ''),
    { cause: error },
  );
}

function runPackagedRuntimeSmoke(runner, smokeEntry, options = {}) {
  verifyPackagedSmokeRunner(runner, options);
  const run = options.runSmoke ?? execFileSync;
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    return run(runner.executable, [smokeEntry], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } catch (error) {
    throw packagedSmokeFailure(error, runner, timeoutMs);
  }
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

/**
 * 打包禁止条目 = 由页面规则清单派生的明文分片条目 + 已退役的 TypeScript 模块产物。
 * 分片这半边 MUST 派生，MUST NOT 手抄：手抄的那版停在 10 条、漏掉
 * 08-reaction-semantics.js（承载点赞状态识别与反应控件定位），而事实源是 11 条。
 */
function packagedForbiddenEntries(projectRoot) {
  return [
    ...packagedFragmentEntries(projectRoot),
    ...RETIRED_DIST_MODULES.map((path) => `/dist/${path}`),
  ];
}

function verifyPackagedXiaohongshuLeakage(asarPath, options = {}) {
  const projectRoot = options.projectRoot ?? resolve(__dirname, '..');
  const archive = options.asar ?? asar;
  const readPackageJson = options.readPackageJson
    ?? (() => JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')));

  // 今天真正在挡明文分片的是 electron-builder 的 files 允许清单（默认拒绝），
  // 不是下面那份禁止清单。允许清单一旦被放宽到能覆盖 native/page-engine/src/**，
  // 明文分片就可以进归档 —— 所以这里先对允许清单本身断言，而不是只等禁止清单命中。
  const packageJson = readPackageJson();
  assertPackagingAllowListExcludesFragments((packageJson.build && packageJson.build.files) || []);

  const entries = archive.listPackage(asarPath);
  // 两类泄漏各自报各自的名字：明文页面规则分片进归档，与退役 TypeScript 模块进归档，
  // 成因与处置完全不同，合成一句话会让报错指不到真因。
  const fragmentEntries = new Set(packagedFragmentEntries(projectRoot));
  const leakedFragment = entries.find((entry) => fragmentEntries.has(entry));
  if (leakedFragment) {
    throw new Error(`Packaged cleartext page-rule fragment is forbidden: ${leakedFragment}`);
  }
  const leakedPath = RETIRED_DIST_MODULES
    .map((path) => `/dist/${path}`)
    .find((entry) => entries.includes(entry));
  if (leakedPath) throw new Error(`Packaged migrated Xiaohongshu JavaScript is forbidden: ${leakedPath}`);
  const sourceMap = entries.find((entry) => entry.startsWith('/dist/') && entry.endsWith('.map'));
  if (sourceMap) throw new Error(`Packaged source map is forbidden: ${sourceMap}`);
  for (const entry of entries.filter((value) => value.startsWith('/dist/') && value.endsWith('.js'))) {
    const source = archive.extractFile(asarPath, entry.slice(1)).toString('utf8');
    const marker = PRODUCTION_FORBIDDEN_MARKERS.find((value) => source.includes(value));
    if (marker) throw new Error(`Packaged migrated page-rule marker is forbidden in ${entry}: ${marker}`);
  }
  if (!entries.includes('/dist/native-page-engine/runtime.js')) {
    throw new Error('Packaged selector-free Native Page Engine facade is missing');
  }
  return entries.filter((entry) => entry.startsWith('/dist/') && entry.endsWith('.js')).length;
}

async function afterPack(context) {
  const {
    asarPath,
    nativeResourceDir,
    gostResourceDir,
    smokeEntry,
  } = resolvePackagedSmokePaths(context);
  const packageCount = verifyPackagedDependencyClosure(asarPath, resolve(__dirname, '..', 'package-lock.json'));
  const runtimeModuleCount = verifyPackagedXiaohongshuLeakage(asarPath);
  const targetArch = normalizeTargetArch(context.arch) || 'unknown';
  verifyNativePageEngineArtifact(nativeResourceDir, {
    platform: context.electronPlatformName,
    arch: targetArch,
  });
  console.log(`Native Page Engine artifact verified for ${context.electronPlatformName}/${targetArch}.`);
  if (context.electronPlatformName === 'darwin') {
    verifyGostArtifact(gostResourceDir, {
      platform: context.electronPlatformName,
      arch: targetArch,
    });
    console.log(`GOST artifact verified for ${context.electronPlatformName}/${targetArch}.`);
  }
  console.log(`Packaged page-rule JavaScript leakage scan passed across ${runtimeModuleCount} runtime modules.`);

  const runner = resolvePackagedSmokeRunner(context);
  if (!runner) {
    console.log(
      `Packaged dependency closure verified statically: ${packageCount} production packages present ` +
      `(target ${context.electronPlatformName}/${targetArch}, host ${process.platform}/${process.arch}).`,
    );
    return;
  }

  const output = runPackagedRuntimeSmoke(runner, smokeEntry);
  process.stdout.write(output);
}

module.exports = afterPack;
module.exports.canExecutePackagedBinary = canExecutePackagedBinary;
module.exports.normalizeTargetArch = normalizeTargetArch;
module.exports.productionPackageEntries = productionPackageEntries;
module.exports.resolvePackagedSmokeRunner = resolvePackagedSmokeRunner;
module.exports.resolvePackagedSmokePaths = resolvePackagedSmokePaths;
module.exports.runPackagedRuntimeSmoke = runPackagedRuntimeSmoke;
module.exports.verifyPackagedSmokeRunner = verifyPackagedSmokeRunner;
module.exports.verifyPackagedDependencyClosure = verifyPackagedDependencyClosure;
module.exports.verifyPackagedXiaohongshuLeakage = verifyPackagedXiaohongshuLeakage;
module.exports.packagedForbiddenEntries = packagedForbiddenEntries;
