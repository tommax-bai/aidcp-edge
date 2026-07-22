import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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
  resolvePackagedSmokePaths: (context: {
    electronPlatformName: string;
    appOutDir: string;
    packager: { appInfo: { productFilename: string } };
  }) => { executable: string; asarPath: string; nativeResourceDir: string; smokeEntry: string };
};

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

test('static packaged closure covers every non-dev non-optional production package', () => {
  const entries = afterPack.productionPackageEntries(join(root, 'package-lock.json'));
  assert.ok(entries.length > 50, 'production closure should include jsdom transitive dependencies');
  assert.ok(entries.includes('/node_modules/jsdom/package.json'));
  assert.ok(entries.includes('/node_modules/tough-cookie/package.json'));
  assert.ok(entries.includes('/node_modules/tldts/package.json'));
  assert.ok(entries.includes('/node_modules/ws/package.json'));
  assert.ok(!entries.includes('/node_modules/electron/package.json'), 'dev-only Electron must not be required inside app.asar');
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
