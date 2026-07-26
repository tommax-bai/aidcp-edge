import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const afterPack = require('../../scripts/after-pack.cjs') as {
  canExecutePackagedBinary: (
    context: { electronPlatformName: string; arch: number | string },
    host?: { platform: string; arch: string },
  ) => boolean;
  normalizeTargetArch: (arch: number | string) => string;
  productionPackageEntries: (packageLockPath: string) => string[];
  resolvePackagedSmokeRunner: (
    context: {
      electronPlatformName: string;
      arch: number | string;
      appOutDir: string;
      packager: { appInfo: { productFilename: string } };
    },
    options?: { host?: { platform: string; arch: string }; projectRoot?: string },
  ) => null | {
    kind: 'packaged-product' | 'trusted-dev-electron';
    executable: string;
    appPath?: string;
  };
  runPackagedRuntimeSmoke: (
    runner: { kind: string; executable: string; appPath?: string },
    smokeEntry: string,
    options?: {
      pathExists?: (path: string) => boolean;
      run?: (command: string, args: string[], options: unknown) => unknown;
      runSmoke?: (command: string, args: string[], options: unknown) => string;
      timeoutMs?: number;
    },
  ) => string;
  verifyPackagedSmokeRunner: (
    runner: { kind: string; executable: string; appPath?: string },
    options?: {
      pathExists?: (path: string) => boolean;
      run?: (command: string, args: string[], options: unknown) => unknown;
    },
  ) => void;
  verifyPackagedXiaohongshuLeakage: (asarPath: string) => number;
  resolvePackagedSmokePaths: (context: {
    electronPlatformName: string;
    appOutDir: string;
    packager: { appInfo: { productFilename: string } };
  }) => { executable: string; asarPath: string; nativeResourceDir: string; smokeEntry: string };
};
const asar = require('@electron/asar') as { createPackage(source: string, destination: string): Promise<void> };

test('desktop builds run the packaged runtime smoke hook', () => {
  assert.equal(packageJson.build.afterPack, 'scripts/after-pack.cjs');
  const source = readFileSync(join(root, 'src/electron/packaged-runtime-smoke.cjs'), 'utf8');
  assert.match(source, /require\('jsdom'\)/);
  assert.match(source, /new CookieJar\(\)/);
  assert.match(source, /require\('ws'\)/);
});

test('afterPack resolves the smoke entry inside the generated macOS app.asar', () => {
  const paths = afterPack.resolvePackagedSmokePaths({
    electronPlatformName: 'darwin',
    appOutDir: join('dist-electron', 'mac-arm64'),
    packager: { appInfo: { productFilename: 'AIDCP' } },
  });
  assert.equal(paths.executable, join('dist-electron', 'mac-arm64', 'AIDCP.app', 'Contents', 'MacOS', 'AIDCP'));
  assert.equal(paths.asarPath, join('dist-electron', 'mac-arm64', 'AIDCP.app', 'Contents', 'Resources', 'app.asar'));
  assert.equal(
    paths.nativeResourceDir,
    join('dist-electron', 'mac-arm64', 'AIDCP.app', 'Contents', 'Resources', 'native-page-engine'),
  );
  assert.equal(
    paths.smokeEntry,
    join('dist-electron', 'mac-arm64', 'AIDCP.app', 'Contents', 'Resources', 'app.asar', 'src', 'electron', 'packaged-runtime-smoke.cjs'),
  );
});

test('afterPack executes only same-architecture binaries and statically verifies cross-arch packages', () => {
  const armHost = { platform: 'darwin', arch: 'arm64' };
  assert.equal(afterPack.normalizeTargetArch(1), 'x64');
  assert.equal(afterPack.normalizeTargetArch(3), 'arm64');
  assert.equal(afterPack.canExecutePackagedBinary({ electronPlatformName: 'darwin', arch: 3 }, armHost), true);
  assert.equal(afterPack.canExecutePackagedBinary({ electronPlatformName: 'darwin', arch: 1 }, armHost), false);
  assert.equal(afterPack.canExecutePackagedBinary({ electronPlatformName: 'win32', arch: 3 }, armHost), false);
});

test('same-architecture macOS smoke uses the trusted development Electron instead of the unsigned product app', () => {
  const projectRoot = join('workspace', 'aidcp-edge');
  const runner = afterPack.resolvePackagedSmokeRunner({
    electronPlatformName: 'darwin',
    arch: 'arm64',
    appOutDir: join('dist-electron', 'mac-arm64'),
    packager: { appInfo: { productFilename: 'AIDCP' } },
  }, {
    host: { platform: 'darwin', arch: 'arm64' },
    projectRoot,
  });

  assert.deepEqual(runner, {
    kind: 'trusted-dev-electron',
    appPath: join(process.cwd(), projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app'),
    executable: join(
      process.cwd(),
      projectRoot,
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron',
    ),
  });
  assert.notEqual(
    runner?.executable,
    join('dist-electron', 'mac-arm64', 'AIDCP.app', 'Contents', 'MacOS', 'AIDCP'),
  );
});

test('trusted macOS smoke runner must exist and pass strict code-signature verification', () => {
  const runner = {
    kind: 'trusted-dev-electron',
    appPath: '/workspace/node_modules/electron/dist/Electron.app',
    executable: '/workspace/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  };
  assert.throws(
    () => afterPack.verifyPackagedSmokeRunner(runner, { pathExists: () => false }),
    /Trusted Electron smoke runner is missing.*npm ci/,
  );

  assert.throws(
    () => afterPack.verifyPackagedSmokeRunner(runner, {
      pathExists: () => true,
      run: () => {
        throw new Error('invalid signature');
      },
    }),
    /invalid code signature.*npm ci/,
  );

  const invocations: Array<{ command: string; args: string[] }> = [];
  afterPack.verifyPackagedSmokeRunner(runner, {
    pathExists: () => true,
    run: (command, args) => {
      invocations.push({ command, args });
    },
  });
  assert.deepEqual(invocations, [{
    command: '/usr/bin/codesign',
    args: ['--verify', '--deep', '--strict', runner.appPath],
  }]);
});

test('non-macOS same-architecture smoke keeps the packaged executable and cross-architecture smoke stays static-only', () => {
  const context = {
    electronPlatformName: 'linux',
    arch: 'x64',
    appOutDir: join('dist-electron', 'linux-unpacked'),
    packager: { appInfo: { productFilename: 'AIDCP' } },
  };
  assert.deepEqual(afterPack.resolvePackagedSmokeRunner(context, {
    host: { platform: 'linux', arch: 'x64' },
  }), {
    kind: 'packaged-product',
    executable: join('dist-electron', 'linux-unpacked', 'AIDCP'),
  });
  assert.equal(afterPack.resolvePackagedSmokeRunner(context, {
    host: { platform: 'linux', arch: 'arm64' },
  }), null);
});

test('packaged smoke failures retain bounded child-process evidence', () => {
  const runner = { kind: 'packaged-product', executable: '/workspace/AIDCP' };
  assert.throws(
    () => afterPack.runPackagedRuntimeSmoke(runner, '/workspace/app.asar/smoke.cjs', {
      timeoutMs: 123,
      runSmoke: () => {
        throw Object.assign(new Error('failed'), {
          killed: true,
          signal: 'SIGTERM',
          stdout: 'x'.repeat(2_100),
          stderr: 'dependency missing',
        });
      },
    }),
    (error: Error) => {
      assert.match(error.message, /signal SIGTERM after 123 ms timeout/);
      assert.match(error.message, /\[last 2000 characters\]/);
      assert.match(error.message, /dependency missing/);
      assert.ok(error.message.length < 2_500);
      return true;
    },
  );
});

test('static packaged closure covers every non-dev non-optional production package', () => {
  const entries = afterPack.productionPackageEntries(join(root, 'package-lock.json'));
  assert.ok(entries.length > 50, 'production closure should include jsdom transitive dependencies');
  assert.ok(entries.includes('/node_modules/jsdom/package.json'));
  assert.ok(entries.includes('/node_modules/tough-cookie/package.json'));
  assert.ok(entries.includes('/node_modules/tldts/package.json'));
  assert.ok(entries.includes('/node_modules/ws/package.json'));
  assert.ok(!entries.includes('/node_modules/electron/package.json'), 'dev-only Electron must not be required inside app.asar');
});

test('final ASAR scan accepts the Native facade and rejects a migrated Xiaohongshu module', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aidcp-asar-leakage-'));
  try {
    const input = join(fixture, 'input');
    const nativeDir = join(input, 'dist', 'native-page-engine');
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(input, 'dist', 'main.js'), 'import "./native-page-engine/runtime.js";');
    writeFileSync(join(nativeDir, 'runtime.js'), 'export const nativeOnly = true;');
    const cleanAsar = join(fixture, 'clean.asar');
    await asar.createPackage(input, cleanAsar);
    assert.equal(afterPack.verifyPackagedXiaohongshuLeakage(cleanAsar), 2);

    const legacyDir = join(input, 'dist', 'browse');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'browse-session.js'), 'export const legacy = true;');
    const leakedAsar = join(fixture, 'leaked.asar');
    await asar.createPackage(input, leakedAsar);
    assert.throws(
      () => afterPack.verifyPackagedXiaohongshuLeakage(leakedAsar),
      /migrated Xiaohongshu JavaScript is forbidden/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('desktop build input rejects a top-level node_modules self-link', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aidcp-desktop-build-input-'));
  try {
    const fixtureNodeModules = join(fixture, 'node_modules');
    mkdirSync(fixtureNodeModules);
    symlinkSync(fixtureNodeModules, join(fixtureNodeModules, 'node_modules'));
    const guard = await import(pathToFileURL(join(root, 'scripts/verify-desktop-build-input.mjs')).href) as {
      verifyDesktopBuildInput: (projectRoot: string) => unknown;
    };
    assert.throws(() => guard.verifyDesktopBuildInput(fixture), /unexpected symbolic link/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
