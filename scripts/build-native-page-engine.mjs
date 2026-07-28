import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = join(repoRoot, 'native', 'page-engine');
const executableName = process.platform === 'win32' ? 'aidcp-page-engine.exe' : 'aidcp-page-engine';
const targetArchFlagIndex = process.argv.indexOf('--target-arch');
const targetArch = targetArchFlagIndex >= 0 ? process.argv[targetArchFlagIndex + 1] : process.arch;
const rustTarget = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
}[`${process.platform}-${targetArch}`];

// 平台/架构校验是惰性的：本模块的纯函数（源码摘要、哨兵存活校验）要能被
// 闸门自测 import，import 期 MUST NOT 因宿主平台不受支持而抛错。
function requireSupportedTarget() {
  if (!targetArch || !['x64', 'arm64'].includes(targetArch)) {
    throw new Error(`Unsupported or missing --target-arch value: ${targetArch ?? ''}`);
  }
  if (!rustTarget) {
    throw new Error(`Native Page Engine packaging is unsupported for ${process.platform}-${targetArch}`);
  }
  return rustTarget;
}
const stageDir = join(repoRoot, 'build', 'native-page-engine', `${process.platform}-${targetArch}`);
const stagedBinary = join(stageDir, executableName);
const checksumPath = `${stagedBinary}.sha256`;
const manifestPath = join(stageDir, 'manifest.json');
const protocolVersion = 2;
const platformAdapterVersion = 'multi-platform-v1';
const platformAdapters = [
  { platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-v1' },
  { platform: 'facebook', adapterVersion: 'facebook-v1' },
  { platform: 'wechat_channels', adapterVersion: 'wechat-channels-v1' },
];
// 明文哨兵是双向判定的，两类语义不同、都必须能被机械证伪：
//
// - live：这条串现在确实活在会进 release 编译的页面规则 / 引擎源码里。
//   它在源码里消失（改名、属性删除）时 MUST 判「哨兵失活」而失败，
//   MUST NOT 继续报告扫描通过 —— 失活的表现形式与「真的没泄漏」无法区分。
// - structural：这条串按构造就不该出现在源码里，扫描的是「有人把它写死了」。
//   实例：CDP 方法名在 src/cdp.rs 里以 ("Input", "dispatchMouseEvent") 分域存放、
//   运行时才 join('.')，所以拼好的 "Input.dispatch" / "Page.navigate" 不进二进制。
//   对这两条要求「活在源码里」是错的（本 change 的 design 把它们判为空哨，
//   实测 src/cdp.rs:33-56 显示是刻意分域构造，见返回值 correctionsToSpec）。
//   这类哨兵的源码侧判据反过来：release 源码里一旦出现拼好的字面量即失败。
const cleartextSentinels = [
  { marker: 'document.querySelectorAll', presence: 'live' },
  { marker: '.note-detail-mask', presence: 'live' },
  { marker: 'section.note-item', presence: 'live' },
  { marker: '扫码登录', presence: 'live' },
  {
    marker: 'Input.dispatch',
    presence: 'structural',
    reason: 'CDP 方法名在 src/cdp.rs 分域存放、运行时 join("."); 源码里出现拼好的字面量即回归',
  },
  {
    marker: 'Page.navigate',
    presence: 'structural',
    reason: 'CDP 方法名在 src/cdp.rs 分域存放、运行时 join("."); 源码里出现拼好的字面量即回归',
  },
  { marker: 'data-aidcp-native-feed-like', presence: 'live' },
  { marker: 'data-aidcp-native-reel-like-target', presence: 'live' },
  { marker: 'targetGroupScope', presence: 'live' },
];
const forbiddenCleartextMarkers = cleartextSentinels.map((sentinel) => sentinel.marker);

/**
 * 参与 release 编译、且改动会改变二进制的源码输入。
 * 摘要与哨兵存活校验都用这一套语料，两者口径不会漂开。
 * 明确不纳入：测试文件与文档（改它们不该触发开发态重建）。
 */
const engineSourceInputs = [
  { path: 'src', kind: 'directory' },
  { path: 'build.rs', kind: 'file' },
  { path: 'Cargo.toml', kind: 'file' },
  { path: 'Cargo.lock', kind: 'file' },
  { path: 'command-manifest.json', kind: 'file' },
];

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function isTestOnlyRustUnit(relativePath) {
  const name = relativePath.split(/[\\/]/).pop() ?? '';
  return /_tests\.rs$/.test(name) || name === 'tests.rs';
}

/**
 * 粗粒度剥掉内联 `#[cfg(test)]` 块（按花括号配平），使哨兵存活校验不会把
 * 只活在测试单元里的串当成活的。宁可多剥一点：多剥的后果是响亮失败，
 * 少剥的后果是空哨继续报通过。
 */
function stripCfgTestBlocks(source) {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const marker = source.indexOf('#[cfg(test)]', index);
    if (marker < 0) {
      result += source.slice(index);
      break;
    }
    result += source.slice(index, marker);
    const open = source.indexOf('{', marker);
    if (open < 0) {
      index = marker + '#[cfg(test)]'.length;
      continue;
    }
    let depth = 0;
    let cursor = open;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = cursor < source.length ? cursor + 1 : source.length;
  }
  return result;
}

async function collectFilesRecursively(root) {
  const collected = [];
  const walk = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) collected.push(path);
    }
  };
  await walk(root);
  return collected;
}

/**
 * 收集引擎源码语料，按「进 release 编译」与「只进测试编译」两桶分开返回。
 */
async function collectEngineSources() {
  const release = [];
  const testOnly = [];
  for (const input of engineSourceInputs) {
    const absolute = join(crateDir, input.path);
    const paths = input.kind === 'directory' ? await collectFilesRecursively(absolute) : [absolute];
    for (const path of paths) {
      const relativePath = relative(crateDir, path).split(sep).join('/');
      const contents = await readFile(path);
      if (isTestOnlyRustUnit(relativePath)) testOnly.push({ path: relativePath, contents });
      else release.push({ path: relativePath, contents });
    }
  }
  release.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  testOnly.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { release, testOnly };
}

/**
 * 由引擎源码输入本身导出的摘要。产物自己写下的 sha256 / manifest.json /
 * Cargo.toml 版本号 / 能力摘要彼此自洽、对源码漂移无感，MUST NOT 当作
 * 「产物与当前源码一致」的判据。
 */
export function computeEngineSourceDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(digest(file.contents));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * 哨兵存活校验（否定式闸门的前置条件）：
 * live 哨兵必须在 release 语料里定位得到，structural 哨兵必须定位不到。
 */
export function assertSentinelsAreLive(sentinels, sources) {
  const releaseText = sources.release
    .map((file) => (file.path.endsWith('.rs')
      ? stripCfgTestBlocks(file.contents.toString('utf8'))
      : file.contents.toString('utf8')))
    .join('\n');
  const testOnlyText = sources.testOnly.map((file) => file.contents.toString('utf8')).join('\n');
  for (const sentinel of sentinels) {
    const inRelease = releaseText.includes(sentinel.marker);
    if (sentinel.presence === 'live' && !inRelease) {
      const where = testOnlyText.includes(sentinel.marker)
        ? 'it now occurs only in test-only compilation units'
        : 'it occurs in no engine source at all';
      throw new Error(
        `Native Page Engine cleartext sentinel has lost its subject: ${sentinel.marker} (${where}); `
        + 're-point it at a live feature or record the abandoned coverage explicitly',
      );
    }
    if (sentinel.presence === 'structural' && inRelease) {
      throw new Error(
        `Native Page Engine structural sentinel now has a literal in release sources: ${sentinel.marker} `
        + `(${sentinel.reason ?? 'no reason recorded'})`,
      );
    }
  }
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
  requireSupportedTarget();
  const [binary, checksumRecord, manifestRecord, cargoToml, commandManifest, sources] = await Promise.all([
    readFile(stagedBinary),
    readFile(checksumPath, 'utf8'),
    readFile(manifestPath, 'utf8'),
    readFile(join(crateDir, 'Cargo.toml'), 'utf8'),
    readFile(join(crateDir, 'command-manifest.json')),
    collectEngineSources(),
  ]);
  // 哨兵先证明自己还守着东西，再拿它去扫产物；顺序反了就会用一组空哨报「扫描通过」。
  assertSentinelsAreLive(cleartextSentinels, sources);
  const manifest = JSON.parse(manifestRecord);
  const expected = checksumRecord.trim().split(/\s+/)[0];
  const actual = digest(binary);
  const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const capabilityDigest = digest(commandManifest);
  const sourceDigest = computeEngineSourceDigest(sources.release);
  if (!expected || expected !== actual) {
    throw new Error('Native Page Engine staged SHA-256 does not match');
  }
  // 与源码绑定的那一条：产物自己写下的哈希 / 清单 / crate 版本号 / 能力摘要
  // 彼此自洽，对源码漂移完全无感，MUST NOT 单独当作「已校验」。
  if (manifest.sourceDigest !== sourceDigest) {
    throw new Error(
      `Native Page Engine staged artifact is stale relative to engine sources `
      + `(manifest ${manifest.sourceDigest ?? 'absent'} vs sources ${sourceDigest})`,
    );
  }
  if (
    manifest.schemaVersion !== 1
    || manifest.engineVersion !== cargoVersion
    || manifest.protocolVersion !== protocolVersion
    || manifest.platformAdapterVersion !== platformAdapterVersion
    || JSON.stringify(manifest.platformAdapters) !== JSON.stringify(platformAdapters)
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
  const target = requireSupportedTarget();
  const sourceBinary = join(crateDir, 'target', target, 'release', executableName);
  const cargo = resolveCargoBinary();
  const cargoDirectory = isAbsolute(cargo) ? dirname(cargo) : undefined;
  const executablePath = cargoDirectory
    ? [cargoDirectory, process.env.PATH].filter(Boolean).join(delimiter)
    : process.env.PATH;
  const outcome = spawnSync(
    cargo,
    ['build', '--release', '--locked', '--target', target],
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
  // sourceDigest 在 cargo 构建之后重算：构建期 build.rs 不改源码，
  // 但这样能保证记下的摘要与刚编出来的二进制取自同一份工作树快照。
  const sourceDigest = computeEngineSourceDigest((await collectEngineSources()).release);
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    engineVersion,
    protocolVersion,
    platformAdapterVersion,
    platformAdapters,
    capabilityDigest,
    sourceDigest,
    platform: process.platform,
    arch: targetArch,
    executable: executableName,
    sha256: checksum,
  }, null, 2)}\n`, 'utf8');
  await verify();
}

// 主入口守卫：本模块的纯函数要能被闸门自测 import，import 期 MUST NOT 触发构建。
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const verifyOnly = process.argv.includes('--verify');
  (verifyOnly ? verify() : build()).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { cleartextSentinels, collectEngineSources, forbiddenCleartextMarkers };
