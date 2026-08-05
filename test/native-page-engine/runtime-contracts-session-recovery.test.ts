import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { EdgeClient } from '../../src/client/edge-client.js';
import type { Envelope } from '../../src/comm/protocol.js';
import { NativeBrowseSession } from '../../src/native-page-engine/browse-session.js';
import type { NativePageCommandExecution } from '../../src/native-page-engine/client.js';
import { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

/**
 * 引擎进程死亡之后的自愈（`harden-native-engine-runtime-contracts` 5.1–5.4）。
 *
 * 会话缓存过去是**命中即返回、零判据**：引擎进程死了以后，缓存里那个僵尸句柄会被一直发下去，
 * 每一条命令都撞「引擎已退出」，而重建入口永远轮不到——一个环境就此变砖，
 * 云端只看到一串普通失败。现在的口径是：返回缓存句柄前必须取到**存活的肯定证据**，
 * 取不到就丢弃重开；收尾动作失败也不许把 owner 位堵住。
 *
 * 5.3 补的是**另一条入口**：结束会话命令**自己**失败的时候。
 * 收尾一旦挂在成功路径上，这条路径的后果链是——
 * 收尾不做 ⇒ owner 位不释放 + 周期观测不停 ⇒ 下一次开始拿到的还是同一场死会话，
 * 而云端只看到一条普通失败，**没有任何东西指向「这个环境已经变砖」**。
 * 行为已由 5.1 落在 `finally` 里；这里是钉住它的那条护栏。
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

// ─────────────────────────────────────────────────────────────────────────────
// 5.3：结束会话命令自己失败时，收尾照做
// ─────────────────────────────────────────────────────────────────────────────

function envelope(type: Envelope['type'], payload: Record<string, unknown> = {}): Envelope {
  return { v: 2, type, id: `env-${type}`, ts: Date.now(), payload } as Envelope;
}

/** 一个「引擎已经退出」的运行时替身：任何命令都撞同一堵墙，收尾调用被记下来。 */
function deadEngineRuntime(closed: string[]): NativePageRuntime {
  return {
    async execute(): Promise<NativePageCommandExecution> {
      throw Object.assign(new Error('engine has exited'), { code: 'engine_exited' });
    },
    async closeOwner(ownerId: string) { closed.push(ownerId); },
  } as unknown as NativePageRuntime;
}

function recordingClient(receipts: Array<{ action: string; ok: boolean; reason?: string }>): EdgeClient {
  return {
    reportActionCompleted(receipt: { action: string; ok: boolean; reason?: string }) { receipts.push(receipt); },
    reportPageCards() { /* noop */ },
    reportNoteDetail() { /* noop */ },
    send() { /* noop */ },
  } as unknown as EdgeClient;
}

test('引擎已死时下发结束会话：命令诚实报失败，且收尾照做（owner 释放 + 周期观测停）', async () => {
  const closed: string[] = [];
  const receipts: Array<{ action: string; ok: boolean; reason?: string }> = [];
  const session = new NativeBrowseSession({
    runtime: deadEngineRuntime(closed),
    client: recordingClient(receipts),
    startupId: 'session-end-on-dead-engine',
    platform: 'xiaohongshu',
    probeIntervalMs: 60_000,
    logger: () => undefined,
  });
  // 先起一次会话，让周期观测真的武装起来——否则「观测停了」这条断言在一个从未起拍的
  // 观测上恒真，闸就成了装饰（memory `gate-always-true-equals-gate-gone`）。
  await session.start().catch(() => undefined);
  assert.equal(session.observationStatus().running, true, '前置：周期观测必须已武装，否则下面那条断言恒真');
  const openedBefore = closed.length;

  await session.onCloudCommand(envelope('session.end'));

  // ① 命令本身如实报失败：绝不因为「收尾做了」就把这条报成功。
  const endReceipts = receipts.slice(-1);
  assert.equal(endReceipts.length, 1);
  assert.equal(endReceipts[0]!.ok, false, '结束命令打在死引擎上必须如实报失败');
  // ② 收尾照做：owner 被释放。这是「下一次开始能拿到新引擎」的唯一前提。
  assert.ok(
    closed.length > openedBefore,
    '结束命令失败时收尾仍必须执行：owner 不释放 = 下次开始拿到的还是同一场死会话',
  );
  assert.deepEqual(closed.slice(-1), ['browse:session-end-on-dead-engine']);
  // ③ 周期观测停了：观测不停 = 一个已经变砖的环境还在持续自报「在跑」。
  assert.equal(session.observationStatus().running, false, '结束命令失败时周期观测仍必须停');
});

/*
 * 5.3 原文的后半句「随后一条命令能重建引擎并正常执行」**没有再写一条用例**，这是判断不是遗漏：
 *
 * 实测发现原文描述的场景在今天已经不成立了 —— 它写于 5.2 / 5.4 落地之前。
 * 用真引擎跑「引擎已退出 → 下发结束会话」，命令**不会失败**：运行时的存活判据先一步认出
 * 缓存句柄是僵尸，丢弃重开，于是这条结束命令落在一个**新**引擎上、正常成功。
 * 也就是说「引擎已退出」这一条**单独不再构成结束命令的失败原因**。
 *
 * 5.1 真正护住的是更一般的那一类：**结束命令因任何原因失败**（重建也起不来、页面规则报错、
 * 中途被接管……）时，收尾照样得做。上面那条用例用「任何命令都撞同一堵墙」的替身正是喂这一类，
 * 而「让开 owner 之后下一条命令能重建引擎」已由本文件第二条用例（真引擎、断言 pid 不同）钉住。
 * 再写一条只会重复它，且会把一个必然自愈的路径伪装成失败路径。
 */
