import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('ordinary TypeScript builds remain independent while every Electron package requires Native', async () => {
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    build: { extraResources?: unknown };
  };
  for (const script of ['build', 'build:dist']) {
    assert.doesNotMatch(packageJson.scripts[script] ?? '', /cargo|native-page-engine/i);
  }
  for (const script of ['electron:build', 'electron:build:mac', 'electron:build:win']) {
    assert.match(packageJson.scripts[script] ?? '', /build:native-page-engines-for-package/);
  }
  assert.match(packageJson.scripts['ensure:native-page-engine'] ?? '', /ensure-native-page-engine-dev/);
  for (const script of ['preelectron:dev', 'preelectron:ol']) {
    assert.match(packageJson.scripts[script] ?? '', /ensure:native-page-engine/);
  }
  assert.match(JSON.stringify(packageJson.build.extraResources ?? []), /build\/native-page-engine\/\$\{platform\}-\$\{arch\}/);
});

test('native staging is explicit, locked, outside ASAR, and unsigned', async () => {
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = await readFile(resolve(repoRoot, 'scripts/build-native-page-engine.mjs'), 'utf8');
  const main = await readFile(resolve(repoRoot, 'src/main.ts'), 'utf8');
  assert.match(packageJson.scripts['build:native-page-engine'] ?? '', /build-native-page-engine/);
  assert.match(script, /--release/);
  assert.match(script, /--locked/);
  assert.match(script, /--target/);
  assert.match(script, /build', 'native-page-engine/);
  assert.match(script, /manifest\.json/);
  assert.match(script, /protocolVersion/);
  assert.match(script, /capabilityDigest/);
  assert.match(script, /process\.platform/);
  assert.match(script, /targetArch/);
  assert.match(script, /forbiddenCleartextMarkers/);
  for (const marker of [
    'data-aidcp-native-feed-like',
    'data-aidcp-native-reel-like-target',
    'targetGroupScope',
  ]) {
    assert.match(script, new RegExp(marker));
  }
  assert.match(script, /rustup', \['which', 'cargo'\]/);
  assert.match(script, /cwd: crateDir/);
  assert.match(script, /unsigned target artifact verified with encoded page rules/);
  assert.doesNotMatch(main, /NativePageEngineClient/);
});

test('packaged artifact verifier pins the production protocol and capability set', async () => {
  const verifier = await readFile(resolve(repoRoot, 'src/electron/native-page-engine-artifact.cjs'), 'utf8');
  const commandManifest = await readFile(resolve(repoRoot, 'native/page-engine/command-manifest.json'));
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(commandManifest).digest('hex');
  assert.match(verifier, new RegExp(digest));
  assert.match(verifier, /EXPECTED_PROTOCOL_VERSION = 2/);
  assert.match(verifier, /binaryArch/);
  assert.match(verifier, /SHA-256/);
});
