import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MAX_NATIVE_TIMEOUT_MS,
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

/**
 * 引擎里那些「命令墙钟上限」类的常量。预算允许写成对它们的**引用**而不是字面量 ——
 * 那正是我们要的：上限被调时（Facebook 时间预算整体 ×1.5 就调过一次）预算自动跟随，
 * 而不是留一份手抄值在那里等着静默失配。故这里把引用解析开再对账，
 * 解析不出来 MUST 响亮失败（悄悄跳过等于把那条窗口从对账表里抹掉）。
 */
const ENGINE_CONSTANT_SOURCES = ['../../native/page-engine/src/engine.rs'];

async function engineConstants(): Promise<Record<string, number>> {
  const table: Record<string, number> = {};
  for (const source of ENGINE_CONSTANT_SOURCES) {
    const text = await readFile(fileURLToPath(new URL(source, import.meta.url)), 'utf8');
    for (const entry of text.matchAll(/^(?:pub )?const ([A-Z0-9_]+): u64 = ([0-9_]+);/gm)) {
      table[entry[1]!] = Number(entry[2]!.replaceAll('_', ''));
    }
  }
  return table;
}

test('提交窗口的预算只有一处声明：引擎源码里不得再出现任何预算数字', async () => {
  // **这条断言在 3.2 之后换了保护对象，别按旧标题读。**
  //
  // 旧形态：两侧各写一份数字，这里断言它们逐字相等（防「改了一边忘了另一边」）。
  // 3.2 把引擎侧的数字整个删掉、线路上只留标签之后，「两份相等」已经无从谈起 ——
  // 但直接删掉这条用例会**同时丢掉两个仍然成立的保护**，所以改成下面两条：
  //
  //  ① 引擎源码里不得再出现窗口预算数字。有人把它加回来 = 第二份事实源复活，
  //     而且不会有任何文本冲突提示他 —— 这里当场拦下。
  //  ② 引擎声明的每个标签都必须在宿主表里。宿主表同时是**准入白名单**：
  //     标签不认识就否决这一次窗口。引擎新增一处窗口却漏进宿主表，
  //     那处不可逆写入会在**运行期被静默拒发**，而这是本仓最不能接受的失败姿势。
  for (const source of ENGINE_WINDOW_SOURCES) {
    const text = await readFile(fileURLToPath(new URL(source, import.meta.url)), 'utf8');
    const leftovers = [...text.matchAll(/budget_ms\s*:/g)];
    assert.equal(
      leftovers.length,
      0,
      `${source} still declares a commit window budget; the host table is the only source of truth `
        + `since task 3.2 — an engine-side number here is a second one that nothing reconciles`,
    );
  }
});

test('引擎声明的每个窗口标签都在宿主的准入白名单里', async () => {
  // 漏一个标签的后果不是「窗口短了」，是宿主**认不出、直接否决这一次窗口**，
  // 于是那条不可逆写入失去写保护 —— 且在运行期才现形。
  const declared = new Set<string>();
  for (const source of ENGINE_WINDOW_SOURCES) {
    const text = await readFile(fileURLToPath(new URL(source, import.meta.url)), 'utf8');
    for (const entry of text.matchAll(/label:\s*"([a-z_]+)"/g)) declared.add(entry[1]!);
  }
  assert.ok(declared.size > 0, 'no commit window labels found in the engine sources — has the regex drifted?');
  const allowed = new Set(Object.keys(NATIVE_COMMIT_WINDOW_BUDGETS));
  const missing = [...declared].filter((label) => !allowed.has(label));
  assert.deepEqual(
    missing,
    [],
    `engine declares commit window labels the host table does not admit: ${missing.join(', ')}`,
  );
});

test('评论提交窗口的预算 ≥ 命令墙钟上限：这条恒等式必须机械成立，不许靠人记得改数字', () => {
  // 为什么钉的是关系而不是数字：窗口预算低于命令墙钟上限时，窗口会在命令还在跑的时候
  // **静默过期**（宿主 `isOpen()` 只按 now < openUntil 判定，过期即 false，没有任何告警），
  // 于是抢占重新落回提交那一刻 —— 一条可能已经发出去的评论被当成没发生 ⇒ 上游重投 ⇒
  // 重复评论。上限已经被整体调过一次（30s → 45s），任何一处手抄的字面量都会在下一次调整时
  // 悄悄把这颗雷装回去，而且**不会有任何文本冲突**。
  assert.ok(
    NATIVE_COMMIT_WINDOW_BUDGETS.xhs_comment_submit >= MAX_NATIVE_TIMEOUT_MS,
    `xhs_comment_submit budget ${NATIVE_COMMIT_WINDOW_BUDGETS.xhs_comment_submit}ms is shorter than `
    + `the command wall-clock ceiling ${MAX_NATIVE_TIMEOUT_MS}ms: the window expires silently mid-command`,
  );
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
