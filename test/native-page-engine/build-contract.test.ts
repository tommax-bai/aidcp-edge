import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('ordinary Edge and Electron builds remain independent of Rust', async () => {
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    build: { extraResources?: unknown };
  };
  for (const script of ['build', 'build:dist', 'electron:build', 'electron:build:mac', 'electron:build:win']) {
    assert.doesNotMatch(packageJson.scripts[script] ?? '', /cargo|native-page-engine/i);
  }
  assert.doesNotMatch(JSON.stringify(packageJson.build.extraResources ?? []), /native-page-engine/i);
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
  assert.match(script, /build', 'native-page-engine/);
  assert.match(script, /forbiddenCleartextMarkers/);
  assert.match(script, /unsigned host artifact verified with encoded page rules/);
  assert.doesNotMatch(main, /native-page-engine|NativePageEngineClient/);
});
