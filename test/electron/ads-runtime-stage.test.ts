import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const runtimeStage = require('../../src/electron/ads-runtime-stage.cjs') as {
  computeTemplateIdentity: (root: string) => string;
  writeTemplateManifest: (root: string) => { contentIdentity: string; packageVersion: string };
  readTemplateManifest: (root: string) => { contentIdentity: string; packageVersion: string };
  resolveRuntimeTemplateSource: (options: {
    resourcesPath?: string;
    appRoot?: string;
    isPackaged?: boolean;
  }) => string | null;
  stageRuntimeTemplate: (options: {
    source: string;
    destRoot: string;
    appVersion: string;
    stopExisting?: (options: { cliEntry: string }) => Promise<{ ok: boolean; error?: string }>;
  }) => Promise<{ ok: boolean; staged?: boolean; error?: string }>;
};

function makeRuntime(root: string, marker: string): string {
  mkdirSync(join(root, 'cli', 'core'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.1.0' }));
  writeFileSync(join(root, 'cli', 'index.js'), `// ${marker}\n`);
  writeFileSync(join(root, 'cli', 'core', 'winHideChildProcess.js'), `// hook ${marker}\n`);
  return root;
}

test('template identity is stable and changes with patched content', () => {
  const root = mkdtempSync(join(tmpdir(), 'aidcp-runtime-identity-'));
  try {
    makeRuntime(root, 'visible-v1');
    const first = runtimeStage.computeTemplateIdentity(root);
    const manifest = runtimeStage.writeTemplateManifest(root);
    assert.equal(manifest.contentIdentity, first);
    assert.equal(runtimeStage.computeTemplateIdentity(root), first, 'manifest must not hash itself');
    assert.equal(runtimeStage.readTemplateManifest(root).contentIdentity, first);

    writeFileSync(join(root, 'cli', 'core', 'winHideChildProcess.js'), '// hook visible-v2\n');
    assert.notEqual(runtimeStage.computeTemplateIdentity(root), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('development source prefers current build template over Resources and historical userData', () => {
  const root = mkdtempSync(join(tmpdir(), 'aidcp-runtime-source-'));
  try {
    const appRoot = join(root, 'app');
    const resourcesPath = join(root, 'resources');
    const build = makeRuntime(join(appRoot, 'build', 'ads-runtime', 'adspower-browser'), 'build');
    const resources = makeRuntime(join(resourcesPath, 'adspower-browser'), 'resources');
    assert.equal(runtimeStage.resolveRuntimeTemplateSource({ appRoot, resourcesPath, isPackaged: false }), build);
    assert.equal(runtimeStage.resolveRuntimeTemplateSource({ appRoot, resourcesPath, isPackaged: true }), resources);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('same-version content change stops old daemon and refreshes userData once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aidcp-runtime-refresh-'));
  try {
    const source = makeRuntime(join(root, 'source'), 'new-visible-hook');
    runtimeStage.writeTemplateManifest(source);
    const destRoot = join(root, 'userData', 'ads-runtime');
    makeRuntime(join(destRoot, 'adspower-browser'), 'old-hidden-hook');
    writeFileSync(join(destRoot, 'stage.json'), JSON.stringify({ appVersion: '0.3.22', pkgVersion: '2.1.0' }));

    const stoppedEntries: string[] = [];
    const first = await runtimeStage.stageRuntimeTemplate({
      source,
      destRoot,
      appVersion: '0.3.22',
      stopExisting: async ({ cliEntry }) => {
        stoppedEntries.push(cliEntry);
        return { ok: true };
      },
    });
    assert.equal(first.ok, true);
    assert.equal(first.staged, true);
    assert.equal(stoppedEntries.length, 1);
    assert.match(stoppedEntries[0], /adspower-browser[\\/]cli[\\/]index\.js$/);
    assert.match(readFileSync(join(destRoot, 'adspower-browser', 'cli', 'core', 'winHideChildProcess.js'), 'utf8'), /new-visible-hook/);
    const stamp = JSON.parse(readFileSync(join(destRoot, 'stage.json'), 'utf8'));
    assert.match(stamp.contentIdentity, /^sha256:[0-9a-f]{64}$/);

    const second = await runtimeStage.stageRuntimeTemplate({
      source,
      destRoot,
      appVersion: '0.3.22',
      stopExisting: async () => {
        stoppedEntries.push('unexpected');
        return { ok: true };
      },
    });
    assert.equal(second.ok, true);
    assert.equal(second.staged, false);
    assert.equal(stoppedEntries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed daemon stop preserves the previous runtime and reports staging failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aidcp-runtime-rollback-'));
  try {
    const source = makeRuntime(join(root, 'source'), 'new-visible-hook');
    const destRoot = join(root, 'userData', 'ads-runtime');
    makeRuntime(join(destRoot, 'adspower-browser'), 'old-hidden-hook');

    const result = await runtimeStage.stageRuntimeTemplate({
      source,
      destRoot,
      appVersion: '0.3.22',
      stopExisting: async () => ({ ok: false, error: 'stop timeout' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error || '', /stop timeout/);
    assert.match(readFileSync(join(destRoot, 'adspower-browser', 'cli', 'core', 'winHideChildProcess.js'), 'utf8'), /old-hidden-hook/);
    assert.equal(existsSync(join(destRoot, 'stage.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
