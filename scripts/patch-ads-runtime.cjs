'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ORIGINAL_SPAWN_BLOCK = String.raw`var origSpawn = cp.spawn.bind(cp);
cp.spawn = function spawn(command, args, options) {
  const normalized = normalizeSpawnArgs(args, options);
  return origSpawn(command, normalized.args, normalized.options);
};
var origSpawnSync = cp.spawnSync.bind(cp);
cp.spawnSync = function spawnSync(command, args, options) {
  const normalized = normalizeSpawnArgs(args, options);
  return origSpawnSync(command, normalized.args, normalized.options);
};`;

const PATCHED_SPAWN_BLOCK = String.raw`function withDrivenBrowserVisibility(command, options) {
  const executable = typeof command === "string" ? command.replace(/\\/g, "/").split("/").pop() : "";
  if (/^SunBrowser(?:\.exe)?$/i.test(executable)) {
    return { ...options, windowsHide: false };
  }
  return options;
}
var origSpawn = cp.spawn.bind(cp);
cp.spawn = function spawn(command, args, options) {
  const normalized = normalizeSpawnArgs(args, options);
  return origSpawn(command, normalized.args, withDrivenBrowserVisibility(command, normalized.options));
};
var origSpawnSync = cp.spawnSync.bind(cp);
cp.spawnSync = function spawnSync(command, args, options) {
  const normalized = normalizeSpawnArgs(args, options);
  return origSpawnSync(command, normalized.args, withDrivenBrowserVisibility(command, normalized.options));
};`;

function patchAdsRuntimeBrowserVisibility(runtimeRoot) {
  const hookPath = join(runtimeRoot, 'cli', 'core', 'winHideChildProcess.js');
  const source = readFileSync(hookPath, 'utf8');
  if (source.includes(PATCHED_SPAWN_BLOCK)) {
    return { changed: false, hookPath };
  }
  if (!source.includes(ORIGINAL_SPAWN_BLOCK)) {
    throw new Error(
      `Ads CLI Windows child-process hook changed at ${hookPath}; refusing to stage an unverified SunBrowser visibility policy`,
    );
  }
  writeFileSync(hookPath, source.replace(ORIGINAL_SPAWN_BLOCK, PATCHED_SPAWN_BLOCK));
  return { changed: true, hookPath };
}

module.exports = {
  ORIGINAL_SPAWN_BLOCK,
  PATCHED_SPAWN_BLOCK,
  patchAdsRuntimeBrowserVisibility,
};

