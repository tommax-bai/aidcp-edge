import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stageSource = readFileSync(join(root, 'scripts/stage-gost.mjs'), 'utf8');
const artifactSource = readFileSync(join(root, 'src/electron/gost-artifact.cjs'), 'utf8');
const afterPackSource = readFileSync(join(root, 'scripts/after-pack.cjs'), 'utf8');
const macBuildSource = readFileSync(join(root, 'scripts/build-desktop-macos.sh'), 'utf8');
const license = readFileSync(join(root, 'resources/licenses/gost-MIT.txt'), 'utf8');

test('macOS desktop builds stage and package a verified GOST resource outside ASAR', () => {
  assert.match(packageJson.scripts['electron:build:mac'], /build:gost -- x64 arm64/);
  assert.match(macBuildSource, /npm run build:gost -- \$arch_list/);
  const resources = packageJson.build.extraResources as Array<{ from?: string; to?: string }>;
  assert.ok(resources.some((entry) => (
    entry.from === 'build/gost/${platform}-${arch}' && entry.to === 'gost'
  )));
  assert.match(afterPackSource, /verifyGostArtifact\(gostResourceDir/);
});

test('GOST staging pins version and both macOS archive checksums before extraction', () => {
  assert.match(artifactSource, /GOST_VERSION = '3\.2\.6'/);
  assert.match(artifactSource, /0892485bd94e37b67a1f1d0d2372ed12d7dc0f1bc763d56177a0c0ee734855e6/);
  assert.match(artifactSource, /e54f6c22e81c00650adfbbb23317c74a4dca9b9b73fa28cfa150f5559cc3ff2e/);
  assert.match(stageSource, /archiveDigest !== asset\.archiveSha256/);
  assert.match(stageSource, /verifyGostArtifact\(nextDir/);
});

test('packaged GOST carries its MIT attribution', () => {
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2016 ginuerzh/);
  assert.match(stageSource, /gost-MIT\.txt/);
});
