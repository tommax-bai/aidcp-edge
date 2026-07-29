import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

/**
 * 引擎进程死亡之后的自愈（`harden-native-engine-runtime-contracts` 5.2–5.4）。
 *
 * 会话缓存过去是**命中即返回、零判据**：引擎进程死了以后，缓存里那个僵尸句柄会被一直发下去，
 * 每一条命令都撞「引擎已退出」，而重建入口永远轮不到——一个环境就此变砖，
 * 云端只看到一串普通失败。现在的口径是：返回缓存句柄前必须取到**存活的肯定证据**，
 * 取不到就丢弃重开；收尾动作失败也不许把 owner 位堵住。
 */

const fixture = fileURLToPath(
  new URL('../fixtures/native-page-engine/runtime-contract-engine.mjs', import.meta.url),
);

const manifest = {
  engineVersion: 'runtime-contract-test',
  platformAdapterVersion: 'multi-platform-test',
  platformAdapters: [
    { platform: 'xiaohongshu' as const, adapterVersion: 'xiaohongshu-test' },
    { platform: 'facebook' as const, adapterVersion: 'facebook-test' },
    { platform: 'wechat_channels' as const, adapterVersion: 'wechat-channels-test' },
  ],
  capabilityDigest: 'b'.repeat(64),
};

function runtime(mode: string, pidFile: string): NativePageRuntime {
  return new NativePageRuntime({
    binaryPath: process.execPath,
    binaryArgs: [fixture],
    processTimeoutMs: 4_000,
    expectedManifest: manifest,
    platform: 'xiaohongshu',
    getEndpoint: () => ({ host: '127.0.0.1', port: 9222 }),
    env: {
      AIDCP_RUNTIME_CONTRACT_ENGINE_MODE: mode,
      AIDCP_RUNTIME_CONTRACT_ENGINE_PID_FILE: pidFile,
    },
  });
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`engine process ${pid} did not exit`);
}

test('缓存会话的传输已死时，下一条命令走重建而不是立刻抛「引擎已退出」', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aidcp-runtime-contract-'));
  const pidFile = join(directory, 'engine.pid');
  const engine = runtime('exit-after-first-command', pidFile);
  try {
    const first = await engine.execute('browse:one', { kind: 'browse_scroll', params: { reason: 'first' } }, 3_000);
    assert.equal(first.ok, true);

    const pid = Number(await readFile(pidFile, 'utf8'));
    await waitForExit(pid);

    // 同一个 owner 再下一条命令：缓存句柄已经是僵尸，必须被丢弃并重开一个引擎。
    const second = await engine.execute('browse:one', { kind: 'browse_scroll', params: { reason: 'second' } }, 3_000);
    assert.equal(second.ok, true);
    assert.equal(second.output?.kind, 'page_cards');
    assert.notEqual(Number(await readFile(pidFile, 'utf8')), pid, '第二条命令必须跑在新的引擎进程上');
  } finally {
    await engine.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('引擎已退出时释放 owner：收尾失败不堵住重建入口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aidcp-runtime-contract-'));
  const pidFile = join(directory, 'engine.pid');
  const engine = runtime('exit-after-first-command', pidFile);
  try {
    await engine.execute('browse:two', { kind: 'browse_scroll', params: { reason: 'first' } }, 3_000);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await waitForExit(pid);

    // 结束会话的收尾打在一个已经死掉的句柄上：关不掉是必然的，但 owner 必须被释放，
    // 且这次收尾不得把异常抛给调用方（调用点是 `void closeOwner(...)`，抛出去就是未处理拒绝）。
    await engine.closeOwner('browse:two');

    const next = await engine.execute('browse:two', { kind: 'browse_scroll', params: { reason: 'after-close' } }, 3_000);
    assert.equal(next.ok, true);
    assert.notEqual(Number(await readFile(pidFile, 'utf8')), pid);
  } finally {
    await engine.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('存活判据只认肯定证据：进程还在、通道可写、握手已完成', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aidcp-runtime-contract-'));
  const pidFile = join(directory, 'engine.pid');
  const engine = runtime('success', pidFile);
  try {
    await engine.openOwner('browse:three');
    const pid = Number(await readFile(pidFile, 'utf8'));
    // 活着时缓存必须被复用：判据不许严到把健康会话也丢掉（那会变成每条命令重开一个引擎）。
    await engine.execute('browse:three', { kind: 'browse_scroll', params: { reason: 'a' } }, 3_000);
    await engine.execute('browse:three', { kind: 'browse_scroll', params: { reason: 'b' } }, 3_000);
    assert.equal(Number(await readFile(pidFile, 'utf8')), pid, '健康会话必须被复用');

    // 外部杀掉引擎（不经过任何收尾）：宿主没有「记到死讯」的机会，
    // 但存活判据要的是肯定证据，所以下一条命令仍然走重建。
    process.kill(pid, 'SIGKILL');
    await waitForExit(pid);
    const recovered = await engine.execute('browse:three', { kind: 'browse_scroll', params: { reason: 'c' } }, 3_000);
    assert.equal(recovered.ok, true);
    assert.notEqual(Number(await readFile(pidFile, 'utf8')), pid);
  } finally {
    await engine.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
