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
import {
  existsSync,
  rmSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { patchAdsRuntimeBrowserVisibility } = require('./patch-ads-runtime.cjs');

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

const npmInstallArgs = ['install', '--global', '--prefix', prefix, `adspower-browser@${ADS_VERSION}`];
const npmExecPath = process.env.npm_execpath;
if (process.platform === 'win32' && (!npmExecPath || !existsSync(npmExecPath))) {
  throw new Error('npm_execpath is unavailable; run staging through npm run build:ads-runtime');
}

execFileSync(
  process.platform === 'win32' ? process.execPath : 'npm',
  process.platform === 'win32' ? [npmExecPath, ...npmInstallArgs] : npmInstallArgs,
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

// Ads CLI preloads a Windows child-process hook into its daemon. The pinned 2.1.0 hook
// defaults every descendant spawn to windowsHide=true, which also hides the driven
// SunBrowser native window. Patch only that GUI executable back to windowsHide=false;
// keep the existing policy for other Ads CLI helper subprocesses.
patchAdsRuntimeBrowserVisibility(out);
console.log('[stage-ads-runtime] preserved native visibility for Ads CLI-launched SunBrowser');

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

// --- Host/Node-version-agnostic liveness (replace the CLI's `ps | grep "node"` check) ---
// isRunning(pid) decided "is the runtime alive" via `ps -f -p <pid> | grep "node"` (posix)
// / `tasklist | findstr node.exe` (win) — it ASSUMES the service process is named "node".
// But `ads start` forks the service with process.execPath as the interpreter; under Electron
// (ELECTRON_RUN_AS_NODE) that's the Electron binary (named "AIDCP", not "node"), so the grep
// never matches -> readPidFile has a live pid yet isRunning=false -> every store-dependent CLI
// command (status / get-kernel-list / download-kernel / stop, via hasRunning/getChildStatus)
// wrongly reports "runtime is not running". This is INDEPENDENT of Node version (a newer Node
// doesn't rename the host binary), so it can't be fixed by upgrading — only by dropping the
// "must be named node" assumption. We already route kernel/status over HTTP LocalAPI (main.cjs),
// but patch the CLI's own check too, as defense-in-depth, so raw CLI subcommands also work under
// any host: probe liveness with process.kill(pid, 0) (signal 0 = existence check; throws ESRCH
// when gone, EPERM when alive-but-not-ours). Cross-platform, no subprocess, no name assumption.
// The surrounding `if (pid) { ... } else { resolve(false); }` guard is preserved.
const cliSrc2 = readFileSync(cliPath, 'utf8');
const ISRUNNING_CALL = [
  '      (0, import_node_child_process.exec)(',
  `        util.format(process.platform === "win32" ? 'tasklist /fi "PID eq %s" | findstr /i "node.exe"' : 'ps -f -p %s | grep "node"', pid),`,
  '        { windowsHide: true },',
  '        function(err, stdout, stderr) {',
  '          resolve(!err && !!stdout.toString().trim());',
  '        }',
  '      );',
].join('\n');
const ISRUNNING_STUB = [
  '      try {',
  '        process.kill(Number(pid), 0);',
  '        resolve(true);',
  '      } catch (e) {',
  '        resolve(!!(e && e.code === "EPERM"));',
  '      }',
].join('\n');
if (!cliSrc2.includes(ISRUNNING_CALL)) {
  console.error('[stage-ads-runtime] FAILED: isRunning ps|grep-node block not found (CLI shape changed — re-verify on version bump)');
  process.exit(1);
}
writeFileSync(cliPath, cliSrc2.split(ISRUNNING_CALL).join(ISRUNNING_STUB));
console.log('[stage-ads-runtime] patched isRunning -> host/version-agnostic liveness (process.kill 0)');

// --- Strip absolute / bundle-escaping symlinks (codesign --deep --strict killers) ---
// npm materializes node_modules/.bin/* CLI shims as ABSOLUTE symlinks into build/ads-prefix
// (the throwaway global-install prefix). Bundled into a signed .app they are dead links
// pointing at build-machine paths, and `codesign --verify --deep --strict` rejects the whole
// bundle with "invalid destination for symbolic link in bundle". This ONLY surfaces in signed
// CI builds — local unsigned builds skip codesign, so it slips through typecheck/tests/dir builds.
// These .bin shims are CLI conveniences the app never uses (the runtime is invoked
// programmatically, not via .bin), so drop any symlink whose target is absolute or resolves
// outside the staged tree. Internal relative symlinks (target stays inside `out`) are kept —
// codesign is fine with those.
function stripEscapingSymlinks(dir, rootReal) {
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      let escapes = readlinkSync(p).startsWith('/');
      if (!escapes) {
        try {
          escapes = !realpathSync(p).startsWith(rootReal);
        } catch {
          escapes = true; // dangling → dead link, drop it
        }
      }
      if (escapes) {
        unlinkSync(p);
        removed++;
      }
    } else if (st.isDirectory()) {
      removed += stripEscapingSymlinks(p, rootReal);
    }
  }
  return removed;
}
const strippedLinks = stripEscapingSymlinks(out, realpathSync(out));
console.log(`[stage-ads-runtime] stripped ${strippedLinks} absolute/escaping symlink(s) (codesign-safe)`);

// Sanity: native sqlite must be present (all-arch) or the packaged service can't load.
const nativeMac = join(out, 'sqlite', 'mac', 'node_sqlite3.node');
const nativeArm = join(out, 'sqlite', 'arm64', 'node_sqlite3.node');
if (!existsSync(nativeMac) && !existsSync(nativeArm)) {
  console.error('[stage-ads-runtime] FAILED: native node_sqlite3.node missing in staged tree');
  process.exit(1);
}
console.log(`[stage-ads-runtime] staged -> ${out}`);
