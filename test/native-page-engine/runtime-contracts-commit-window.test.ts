import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  NATIVE_COMMIT_WINDOW_BUDGETS,
  NativePageEngineClient,
  NativePageEngineError,
  type NativeCommitWindowRequest,
} from '../../src/native-page-engine/client.js';

/**
 * 提交窗口预算的单一事实源与失败姿势（`harden-native-engine-runtime-contracts` 第 3 节）。
 *
 * 过去两侧各写一份数字并做**相等断言**：不等即 `failProtocol` + 终止引擎进程。
 * 也就是说一次纯节奏调优（改一个窗口毫秒数、只改了一侧）会在按下按钮之前把整个引擎杀掉，
 * 再被上报成一条普通失败。现在的口径是：宿主按标签发放预算、保留上限，
 * 契约不符只结掉当前这条命令。
 */

const fixture = fileURLToPath(
  new URL('../fixtures/native-page-engine/runtime-contract-engine.mjs', import.meta.url),
);

function client(mode: string): NativePageEngineClient {
  return new NativePageEngineClient({
    binaryPath: process.execPath,
    binaryArgs: [fixture],
    processTimeoutMs: 4_000,
    env: { AIDCP_RUNTIME_CONTRACT_ENGINE_MODE: mode },
  });
}

const sessionInput = {
  host: '127.0.0.1',
  port: 9222,
  platform: 'facebook' as const,
  timeoutMs: 3_000,
  sessionId: 'runtime-contract-session',
  taskId: 'runtime-contract-task',
};

/**
 * 引擎侧声明窗口的地方**按平台分文件**：Facebook 在 `facebook/capability.rs`，
 * 小红书在 `commit_window.rs`。对账必须取并集 —— 只读其中一份，另一份的标签与预算
 * 就没有任何机械闸看着，而漏在宿主表外的标签在运行期是**拒发**而不是「少一层保护」。
 */
const ENGINE_WINDOW_SOURCES = [
  '../../native/page-engine/src/facebook/capability.rs',
  '../../native/page-engine/src/commit_window.rs',
];

test('提交窗口的预算只有一处声明：引擎侧的数字是宿主那张表的镜像', async () => {
  const mirrored: Record<string, number> = {};
  for (const source of ENGINE_WINDOW_SOURCES) {
    const text = await readFile(fileURLToPath(new URL(source, import.meta.url)), 'utf8');
    for (const entry of text.matchAll(/label: "([a-z_]+)",\s*\n\s*budget_ms: ([0-9_]+),/g)) {
      const label = entry[1]!;
      const budget = Number(entry[2]!.replaceAll('_', ''));
      // 同一个标签在两份源里声明两个不同预算 = 又回到「两边各写一份」，当场拦下。
      assert.ok(
        mirrored[label] === undefined || mirrored[label] === budget,
        `commit window "${label}" is declared twice with different budgets in the engine sources`,
      );
      mirrored[label] = budget;
    }
  }
  // 单边改一个数字（改宿主没改镜像、或反过来）在这里当场失败，而不是等到运行期把引擎杀掉。
  // 引擎新增一处窗口却漏进宿主表，也在这里失败 —— 那处写入否则会在运行期被静默拒发。
  assert.deepEqual(mirrored, NATIVE_COMMIT_WINDOW_BUDGETS);
  assert.equal(Object.keys(mirrored).length, 8);
});

test('引擎要一个超过事实源上限的预算时，宿主只授上限', async () => {
  const session = await client('commit-window-oversized').openSession(sessionInput);
  const granted: NativeCommitWindowRequest[] = [];
  try {
    const execution = await session.execute(
      { kind: 'group_join', params: { groupUrl: 'https://www.facebook.com/groups/42', click: true } },
      5_000,
      undefined,
      (request) => {
        granted.push(request);
        return () => undefined;
      },
    );
    assert.equal(execution.ok, true);
    assert.equal(granted.length, 1);
    assert.equal(granted[0]!.label, 'fb_join_click');
    // 引擎报的是 90_000，宿主只按事实源发放 —— 引擎侧一个笔误不得放大成不受控的写保护窗口。
    assert.equal(granted[0]!.budgetMs, NATIVE_COMMIT_WINDOW_BUDGETS.fb_join_click);
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('标签不认识时：拒发窗口 + 结论绑到当前命令，引擎进程不被终止', async () => {
  const session = await client('commit-window-unknown').openSession(sessionInput);
  let handlerCalls = 0;
  try {
    const failure = await session.execute(
      { kind: 'group_join', params: { groupUrl: 'https://www.facebook.com/groups/42', click: true } },
      5_000,
      undefined,
      () => {
        handlerCalls += 1;
        return () => undefined;
      },
    ).then(() => undefined, (error: unknown) => error);

    assert.ok(failure instanceof NativePageEngineError, '契约违规必须结掉这条命令');
    assert.equal(failure.code, 'commit_window_unavailable');
    assert.equal(failure.detail?.effectPhase, 'not_started');
    assert.equal(failure.detail?.reasonCode, 'commit_window_label_unknown');
    // 拒发意味着不可逆动作没有被授权：宿主的窗口守卫一次都没被打开。
    assert.equal(handlerCalls, 0);

    // 关键：引擎进程还活着，下一条命令照常执行。
    // 旧口径在这里会 terminate()，整个环境从此变砖，而云端只看到一条普通失败。
    const next = await session.execute({ kind: 'browse_scroll', params: { reason: 'test' } }, 3_000);
    assert.equal(next.ok, true);
    assert.equal(next.output?.kind, 'page_cards');
  } finally {
    await session.close().catch(() => undefined);
  }
});
