// Native 引擎的 Rust 门禁（格式化 / 静态检查 / 测试），做成仓内 npm 脚本。
//
// 为什么必须有这个文件：package.json 全表 cargo 零命中，近两万行 Rust 与全部
// 构建脚本不在任何自动流程里；而工具链解析是**按 cwd 决定**的 —— 从仓根敲 cargo
// 会落到默认工具链（常报「未安装 clippy」），只有在 crate 目录内才解析到
// native/page-engine/rust-toolchain.toml 钉死的版本。这里把这条解析收口，
// 使门禁与调用目录无关。
//
// 口径：工具链或组件缺失 MUST 非零退出并写明「解析到哪个工具链、缺哪个组件」，
// MUST NOT 记为跳过或非阻断。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = join(repoRoot, 'native', 'page-engine');
const toolchainFile = join(crateDir, 'rust-toolchain.toml');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function pinnedChannel() {
  const contents = readFileSync(toolchainFile, 'utf8');
  const channel = contents.match(/^\s*channel\s*=\s*"([^"]+)"/m)?.[1];
  if (!channel) fail(`native gate: ${toolchainFile} declares no channel`);
  return channel;
}

function pinnedComponents() {
  const contents = readFileSync(toolchainFile, 'utf8');
  const raw = contents.match(/^\s*components\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
  return raw.split(',').map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function rustup(args) {
  return spawnSync('rustup', args, { cwd: crateDir, encoding: 'utf8' });
}

function resolveToolchain() {
  const shown = rustup(['show', 'active-toolchain']);
  if (shown.error || shown.status !== 0) {
    fail(
      'native gate: rustup is unavailable, so the pinned Rust toolchain cannot be resolved. '
      + `Install rustup, then run: rustup toolchain install ${pinnedChannel()} `
      + `--component ${pinnedComponents().join(' --component ') || 'clippy --component rustfmt'}`,
    );
  }
  const active = String(shown.stdout || '').trim().split(/\s+/)[0] ?? '';
  const channel = pinnedChannel();
  if (!active.startsWith(channel)) {
    fail(
      `native gate: resolved toolchain "${active}" does not match the pin "${channel}" in `
      + `native/page-engine/rust-toolchain.toml. An exported RUSTUP_TOOLCHAIN overrides the pin `
      + `(RUSTUP_TOOLCHAIN=${process.env.RUSTUP_TOOLCHAIN ?? '<unset>'}).`,
    );
  }
  return active;
}

/** 用 `rustup which` 证明组件真的装了；缺失即失败，不降级为跳过。 */
function requireComponent(binary, componentName, toolchain) {
  const found = rustup(['which', binary]);
  const path = String(found.stdout || '').trim();
  if (found.error || found.status !== 0 || !isAbsolute(path)) {
    fail(
      `native gate: toolchain "${toolchain}" is missing the "${componentName}" component `
      + `(rustup which ${binary} failed). Install it with: `
      + `rustup component add ${componentName} --toolchain ${toolchain}`,
    );
  }
  return path;
}

function cargoBinary(toolchain) {
  const configured = String(process.env.AIDCP_CARGO_BIN || '').trim();
  if (configured) return configured;
  return requireComponent('cargo', 'cargo', toolchain);
}

function runCargo(cargo, args, label) {
  const cargoDirectory = isAbsolute(cargo) ? dirname(cargo) : undefined;
  const executablePath = cargoDirectory
    ? [cargoDirectory, process.env.PATH].filter(Boolean).join(delimiter)
    : process.env.PATH;
  process.stdout.write(`[gate:native] ${label}: ${cargo} ${args.join(' ')}\n`);
  const outcome = spawnSync(cargo, args, {
    cwd: crateDir,
    stdio: 'inherit',
    env: { ...process.env, PATH: executablePath },
  });
  if (outcome.error) fail(`native gate: ${label} failed to start: ${outcome.error.message}`);
  if (outcome.status !== 0) fail(`native gate: ${label} failed with status ${outcome.status}`);
}

const steps = {
  fmt: (cargo, toolchain) => {
    requireComponent('rustfmt', 'rustfmt', toolchain);
    runCargo(cargo, ['fmt', '--all', '--', '--check'], 'fmt');
  },
  clippy: (cargo, toolchain) => {
    requireComponent('cargo-clippy', 'clippy', toolchain);
    runCargo(cargo, ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'], 'clippy');
  },
  test: (cargo) => {
    runCargo(cargo, ['test', '--locked'], 'test');
  },
};

const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const selected = requested.length > 0 ? requested : ['fmt', 'clippy', 'test'];
for (const name of selected) {
  if (!steps[name]) fail(`native gate: unknown step "${name}" (expected fmt | clippy | test)`);
}

const toolchain = resolveToolchain();
const cargo = cargoBinary(toolchain);
process.stdout.write(`[gate:native] toolchain=${toolchain} cargo=${cargo} steps=${selected.join(',')}\n`);
for (const name of selected) steps[name](cargo, toolchain);
process.stdout.write(`[gate:native] OK toolchain=${toolchain} steps=${selected.join(',')}\n`);
