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

// 注意：本文件里「断言脚本文本包含某标识符 / 某字面量」的用例一律是**存在性断言**，
// 不构成「这道闸会判定」的证据 —— 闸门指向一个任何构建都产不出的位置时，
// 这类断言同样全绿（本仓两道恒不触发的泄漏闸就是在这类断言下绿了很久）。
// 判定型证据在 test/native-page-engine/artifact-gates.test.ts：
// 每道否定式闸门都被植入违规内容并观察到拒绝。
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
    'targetGroupScope',
  ]) {
    assert.match(script, new RegExp(marker));
  }
  assert.match(script, /rustup', \['which', 'cargo'\]/);
  assert.match(script, /cwd: crateDir/);
  assert.match(script, /unsigned target artifact verified with encoded page rules/);
  assert.doesNotMatch(main, /NativePageEngineClient/);
});

test('the repository exposes native toolchain gates next to the TypeScript gates', async () => {
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const script of ['gate:native', 'gate:native:fmt', 'gate:native:clippy', 'gate:native:test']) {
    assert.match(packageJson.scripts[script] ?? '', /gate-native/, `${script} must be a repository-level command`);
  }
  const gate = await readFile(resolve(repoRoot, 'scripts/gate-native.mjs'), 'utf8');
  // 工具链解析必须锚在 crate 目录：从仓根敲 cargo 会落到默认工具链。
  assert.match(gate, /cwd: crateDir/);
  assert.match(gate, /rust-toolchain\.toml/);
  // 缺组件必须失败，不得记为跳过或非阻断。
  assert.match(gate, /rustup component add/);
  assert.doesNotMatch(gate, /skip(ped|ping)/i);
  assert.doesNotMatch(gate, /non-blocking/i);
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
