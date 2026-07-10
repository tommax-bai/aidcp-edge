#!/usr/bin/env node
// Stage the AdsPower CLI runtime template for extraResources bundling.
// Produces build/ads-runtime/adspower-browser — a FRESH (unwarmed) install tree
// (no profile data in cwd/), all-arch native sqlite, nested node_modules incl.
// playwright-core. Native .node forces extraResources (a .node cannot dlopen from
// inside app.asar); this tree lands at Contents/Resources/adspower-browser =
// resolveCliEntry's primary packaged candidate.
//
// Cross-platform seam: only the OS-specific global-install path differs (§2.2).
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADS_VERSION = '2.1.0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = join(root, 'build', 'ads-prefix');
const outDir = join(root, 'build', 'ads-runtime');
const out = join(outDir, 'adspower-browser');

// Global install dir differs by OS: posix => <prefix>/lib/node_modules, win32 => <prefix>/node_modules.
const installedPkg =
  process.platform === 'win32'
    ? join(prefix, 'node_modules', 'adspower-browser')
    : join(prefix, 'lib', 'node_modules', 'adspower-browser');

console.log(`[stage-ads-runtime] fresh install adspower-browser@${ADS_VERSION} -> ${prefix}`);
rmSync(prefix, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });
mkdirSync(prefix, { recursive: true });

execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--global', '--prefix', prefix, `adspower-browser@${ADS_VERSION}`],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      // The CLI uses the SunBrowser kernel, not playwright's chromium — never download it.
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      PLAYWRIGHT_BROWSERS_PATH: '0',
    },
  },
);

if (!existsSync(installedPkg)) {
  console.error(`[stage-ads-runtime] FAILED: ${installedPkg} not found after install`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
cpSync(installedPkg, out, { recursive: true });

// Sanity: native sqlite must be present (all-arch) or the packaged service can't load.
const nativeMac = join(out, 'sqlite', 'mac', 'node_sqlite3.node');
const nativeArm = join(out, 'sqlite', 'arm64', 'node_sqlite3.node');
if (!existsSync(nativeMac) && !existsSync(nativeArm)) {
  console.error('[stage-ads-runtime] FAILED: native node_sqlite3.node missing in staged tree');
  process.exit(1);
}
console.log(`[stage-ads-runtime] staged -> ${out}`);
