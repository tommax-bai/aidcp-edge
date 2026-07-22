import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = join(repoRoot, 'native', 'page-engine');
const executableName = process.platform === 'win32' ? 'aidcp-page-engine.exe' : 'aidcp-page-engine';
const targetArchFlagIndex = process.argv.indexOf('--target-arch');
const targetArch = targetArchFlagIndex >= 0 ? process.argv[targetArchFlagIndex + 1] : process.arch;
if (!targetArch || !['x64', 'arm64'].includes(targetArch)) {
  throw new Error(`Unsupported or missing --target-arch value: ${targetArch ?? ''}`);
}
const rustTarget = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
}[`${process.platform}-${targetArch}`];
if (!rustTarget) {
  throw new Error(`Native Page Engine packaging is unsupported for ${process.platform}-${targetArch}`);
}
const sourceBinary = join(crateDir, 'target', rustTarget, 'release', executableName);
const stageDir = join(repoRoot, 'build', 'native-page-engine', `${process.platform}-${targetArch}`);
const stagedBinary = join(stageDir, executableName);
const checksumPath = `${stagedBinary}.sha256`;
const manifestPath = join(stageDir, 'manifest.json');
const protocolVersion = 2;
const platformAdapterVersion = 'xiaohongshu-v1';
const forbiddenCleartextMarkers = [
  'document.querySelectorAll',
  '.note-detail-mask',
  'section.note-item',
  '扫码登录',
  'Input.dispatch',
  'Page.navigate',
];

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function resolveCargoBinary() {
  const configured = String(process.env.AIDCP_CARGO_BIN || '').trim();
  if (configured) return configured;

  const direct = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (!direct.error && direct.status === 0) return 'cargo';

  const rustup = spawnSync('rustup', ['which', 'cargo'], { cwd: crateDir, encoding: 'utf8' });
  const rustupCargo = String(rustup.stdout || '').trim();
  if (!rustup.error && rustup.status === 0 && isAbsolute(rustupCargo)) {
    return rustupCargo;
  }
  return 'cargo';
}

async function verify() {
  const [binary, checksumRecord, manifestRecord, cargoToml, commandManifest] = await Promise.all([
    readFile(stagedBinary),
    readFile(checksumPath, 'utf8'),
    readFile(manifestPath, 'utf8'),
    readFile(join(crateDir, 'Cargo.toml'), 'utf8'),
    readFile(join(crateDir, 'command-manifest.json')),
  ]);
  const manifest = JSON.parse(manifestRecord);
  const expected = checksumRecord.trim().split(/\s+/)[0];
  const actual = digest(binary);
  const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const capabilityDigest = digest(commandManifest);
  if (!expected || expected !== actual) {
    throw new Error('Native Page Engine staged SHA-256 does not match');
  }
  if (
    manifest.schemaVersion !== 1
    || manifest.engineVersion !== cargoVersion
    || manifest.protocolVersion !== protocolVersion
    || manifest.platformAdapterVersion !== platformAdapterVersion
    || manifest.capabilityDigest !== capabilityDigest
    || manifest.platform !== process.platform
    || manifest.arch !== targetArch
    || manifest.executable !== executableName
    || manifest.sha256 !== actual
  ) {
    throw new Error('Native Page Engine staged manifest does not match the artifact or package target');
  }
  if (!stagedBinary.startsWith(join(repoRoot, 'build', 'native-page-engine'))) {
    throw new Error('Native Page Engine must be staged outside ASAR inputs');
  }
  for (const marker of forbiddenCleartextMarkers) {
    if (binary.includes(Buffer.from(marker))) {
      throw new Error(`Native Page Engine staged artifact exposes forbidden cleartext marker: ${marker}`);
    }
  }
  process.stdout.write(
    `OK: unsigned target artifact verified with encoded page rules ${process.platform}-${targetArch} ${actual}\n`,
  );
}

async function build() {
  const cargo = resolveCargoBinary();
  const cargoDirectory = isAbsolute(cargo) ? dirname(cargo) : undefined;
  const executablePath = cargoDirectory
    ? [cargoDirectory, process.env.PATH].filter(Boolean).join(delimiter)
    : process.env.PATH;
  const outcome = spawnSync(
    cargo,
    ['build', '--release', '--locked', '--target', rustTarget],
    { cwd: crateDir, stdio: 'inherit', env: { ...process.env, PATH: executablePath } },
  );
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) {
    throw new Error(`Native Page Engine Cargo build failed with status ${outcome.status}`);
  }
  await mkdir(stageDir, { recursive: true });
  await copyFile(sourceBinary, stagedBinary);
  if (process.platform !== 'win32') await chmod(stagedBinary, 0o755);
  const checksum = digest(await readFile(stagedBinary));
  await writeFile(checksumPath, `${checksum}  ${executableName}\n`, 'utf8');
  const cargoToml = await readFile(join(crateDir, 'Cargo.toml'), 'utf8');
  const engineVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!engineVersion) throw new Error('Native Page Engine Cargo version is missing');
  const capabilityDigest = digest(await readFile(join(crateDir, 'command-manifest.json')));
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    engineVersion,
    protocolVersion,
    platformAdapterVersion,
    capabilityDigest,
    platform: process.platform,
    arch: targetArch,
    executable: executableName,
    sha256: checksum,
  }, null, 2)}\n`, 'utf8');
  await verify();
}

const verifyOnly = process.argv.includes('--verify');
(verifyOnly ? verify() : build()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
