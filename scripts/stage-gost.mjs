import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  GOST_ARCHIVE_SHA256,
  GOST_VERSION,
  sha256,
  verifyGostArtifact,
} = require('../src/electron/gost-artifact.cjs');
const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function targetAsset(platform, arch) {
  if (platform !== 'darwin' || !['x64', 'arm64'].includes(arch)) return null;
  const releaseArch = arch === 'x64' ? 'amd64' : 'arm64';
  const archive = `gost_${GOST_VERSION}_darwin_${releaseArch}.tar.gz`;
  return {
    archive,
    url: `https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/${archive}`,
    archiveSha256: GOST_ARCHIVE_SHA256[`${platform}-${arch}`],
  };
}

async function download(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GOST download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function stageUnsupported(platform, arch) {
  const targetDir = join(repoRoot, 'build', 'gost', `${platform}-${arch}`);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(
    join(targetDir, 'UNSUPPORTED.txt'),
    'The system-upstream proxy chain is currently supported only on macOS.\n',
    'utf8',
  );
  console.log(`GOST staging skipped for unsupported target ${platform}/${arch}.`);
}

async function stage(platform, arch) {
  const asset = targetAsset(platform, arch);
  if (!asset) return stageUnsupported(platform, arch);
  const targetDir = join(repoRoot, 'build', 'gost', `${platform}-${arch}`);
  try {
    verifyGostArtifact(targetDir, { platform, arch });
    console.log(`GOST v${GOST_VERSION} already verified for ${platform}/${arch}.`);
    return;
  } catch {
    // Missing or stale staged input is replaced from the pinned release below.
  }

  const workDir = await mkdtemp(join(tmpdir(), 'aidcp-gost-'));
  const nextDir = `${targetDir}.next-${process.pid}`;
  try {
    const archiveBytes = await download(asset.url);
    const archiveDigest = createHash('sha256').update(archiveBytes).digest('hex');
    if (archiveDigest !== asset.archiveSha256) {
      throw new Error(`GOST archive checksum mismatch for ${basename(asset.url)}`);
    }
    const archivePath = join(workDir, asset.archive);
    await writeFile(archivePath, archiveBytes);
    await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', workDir], {
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });
    const extractedBinary = join(workDir, 'gost');
    const binaryBytes = await readFile(extractedBinary);
    await rm(nextDir, { recursive: true, force: true });
    await mkdir(nextDir, { recursive: true });
    await copyFile(extractedBinary, join(nextDir, 'gost'));
    await chmod(join(nextDir, 'gost'), 0o755);
    await copyFile(join(repoRoot, 'resources', 'licenses', 'gost-MIT.txt'), join(nextDir, 'LICENSE'));
    await writeFile(join(nextDir, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      name: 'gost',
      version: GOST_VERSION,
      platform,
      arch,
      archive: asset.archive,
      archiveSha256: asset.archiveSha256,
      binary: 'gost',
      binarySha256: sha256(binaryBytes),
      license: 'LICENSE',
    }, null, 2)}\n`, 'utf8');
    verifyGostArtifact(nextDir, { platform, arch });
    await rm(targetDir, { recursive: true, force: true });
    await rename(nextDir, targetDir);
    console.log(`GOST v${GOST_VERSION} staged and verified for ${platform}/${arch}.`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(nextDir, { recursive: true, force: true });
  }
}

const arches = process.argv.slice(2).filter(Boolean);
for (const arch of arches.length > 0 ? arches : [process.arch]) {
  await stage(process.platform, arch);
}
