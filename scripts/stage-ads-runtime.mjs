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
import { existsSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
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

// --- CJS-compat shim for @bomb.sh/tab (Electron Node 20 can't require() ESM) ---
// cli/index.js does `require("@bomb.sh/tab/commander")` — a pure-ESM package with no
// CJS build — only to register shell tab-completion (`import_commander.default(program)`).
// require(ESM) needs Node >=22; Electron 31 bundles Node 20 -> ERR_REQUIRE_ESM, which
// bricks EVERY CLI invocation (start/status/stop). We invoke the CLI programmatically
// and never use shell completion, so replace the package with a CJS no-op. The service
// (cwd/lib/main.min.js) is CJS-clean and unaffected.
const tabDir = join(out, 'node_modules', '@bomb.sh', 'tab');
rmSync(tabDir, { recursive: true, force: true });
mkdirSync(join(tabDir, 'dist'), { recursive: true });
const NOOP_CJS = 'const noop = function () {};\nnoop.default = noop;\nmodule.exports = noop;\n';
for (const f of ['index.cjs', 'commander.cjs', 'cac.cjs', 'citty.cjs']) {
  writeFileSync(join(tabDir, 'dist', f), NOOP_CJS);
}
writeFileSync(
  join(tabDir, 'package.json'),
  JSON.stringify(
    {
      name: '@bomb.sh/tab',
      version: '0.0.0-cjs-noop-shim',
      type: 'commonjs',
      exports: {
        '.': './dist/index.cjs',
        './commander': './dist/commander.cjs',
        './cac': './dist/cac.cjs',
        './citty': './dist/citty.cjs',
        './package.json': './package.json',
      },
    },
    null,
    2,
  ) + '\n',
);
console.log('[stage-ads-runtime] shimmed @bomb.sh/tab -> CJS no-op (Electron Node 20 compat)');

// --- Neuter the CLI self-update (deterministic pinned runtime) ---
// `ads start`, after the daemon is up, runs `await checkUpdates(...)` and, if a newer
// version exists, `promptYesNo("Update now?")` (reads stdin) then `npm install -g`.
// In our non-interactive spawn (stdin ignored) that risks a hang, and self-update
// targets the GLOBAL npm — not our pinned bundled copy — so it must never fire.
// Replace the single checkUpdates call with a static "no updates" result.
const cliPath = join(out, 'cli', 'index.js');
const CHECK_CALL = 'await checkUpdates(store.getStoreValue("apiKey"), store.getStoreValue("baseUrl"))';
const CHECK_STUB = 'Promise.resolve({ js: false, npm: false })';
const cliSrc = readFileSync(cliPath, 'utf8');
if (!cliSrc.includes(CHECK_CALL)) {
  console.error('[stage-ads-runtime] FAILED: checkUpdates call not found (CLI shape changed — re-verify on version bump)');
  process.exit(1);
}
writeFileSync(cliPath, cliSrc.split(CHECK_CALL).join(CHECK_STUB));
console.log('[stage-ads-runtime] neutered CLI self-update (pinned runtime)');

// Sanity: native sqlite must be present (all-arch) or the packaged service can't load.
const nativeMac = join(out, 'sqlite', 'mac', 'node_sqlite3.node');
const nativeArm = join(out, 'sqlite', 'arm64', 'node_sqlite3.node');
if (!existsSync(nativeMac) && !existsSync(nativeArm)) {
  console.error('[stage-ads-runtime] FAILED: native node_sqlite3.node missing in staged tree');
  process.exit(1);
}
console.log(`[stage-ads-runtime] staged -> ${out}`);
