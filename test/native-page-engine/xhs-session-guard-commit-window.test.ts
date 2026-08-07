/**
 * 小红书不可逆写入的提交窗口：宿主侧的仲裁与转发。
 *
 * 迁移后宿主只在平台是 Facebook 时把窗口处理器传下去，小红书拿到的是 `undefined`——
 * 它的评论提交、三条通知分类栏与发布提交在协调器眼里始终「没有窗口」，等价于**无声照写**：
 * 高档位任务可以在提交进行中接管。发布侧的处理器虽然平台无关地传了下去，但小红书从不发起请求，
 * 于是那条注入长期空转。
 *
 * 窗口契约（标签与预算）的事实源在执行体一侧，由 Rust 用例 `xhs_session_guard_write_protection` 钉住；
 * 这里钉住宿主这一半：**转发不带平台条件**、**拿不到窗口就诚实判未开始**、**终态必关窗**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgeClient } from '../../src/client/edge-client.js';
import { CommitWindowGuard, combineCommitWindows } from '../../src/execution/commit-window.js';
import type {
  ActionCompletedPayload,
  Envelope,
  MessageType,
  NoteDetailPayload,
  PageCardsPayload,
  PublishCommandPayload,
} from '../../src/comm/protocol.js';
import { NativeBrowseSession } from '../../src/native-page-engine/browse-session.js';
import { NativePublishExecutor } from '../../src/native-page-engine/publish.js';
import type {
  NativePageCommand,
  NativePageCommandExecution,
  NativeCommitWindowHandler,
  NativeCommitWindowRequest,
} from '../../src/native-page-engine/client.js';

import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

/**
 * 提交窗口的预算是宿主权威（`NATIVE_COMMIT_WINDOW_BUDGETS`），而那张表同时是**准入白名单**：
 * 不在表里的标签会被判成契约违规并否决窗口，窗口拿不到时写入 MUST NOT 派发。所以引擎这边
 * 接上五条小红书窗口、宿主那边漏加标签，后果不是「少一层保护」，而是这五处写入**全部拒发**。
 *
 * 这里**不做类型转型**，就是要让漏加标签在类型层当场失败，而不是等到运行期变成功能停摆。
 */
function windowRequest(request: NativeCommitWindowRequest): NativeCommitWindowRequest {
  return request;
}

function envelope<T extends MessageType>(type: T, payload: Record<string, unknown> = {}): Envelope {
  return { v: 2, type, id: `env-${type}`, ts: Date.now(), payload } as Envelope;
}

function harness(
  execute: (
    ownerId: string,
    command: NativePageCommand,
    timeoutMs?: number,
    signal?: AbortSignal,
    commitWindowHandler?: NativeCommitWindowHandler,
  ) => Promise<NativePageCommandExecution>,
  commitWindow: CommitWindowGuard,
) {
  const actions: ActionCompletedPayload[] = [];
  const runtime = {
    async execute(
      ownerId: string,
      command: NativePageCommand,
      timeoutMs?: number,
      signal?: AbortSignal,
      commitWindowHandler?: NativeCommitWindowHandler,
    ) {
      return execute(ownerId, command, timeoutMs, signal, commitWindowHandler);
    },
    async closeOwner() { /* no-op */ },
  } as unknown as NativePageRuntime;
  const client = {
    reportActionCompleted(payload: ActionCompletedPayload) { actions.push(payload); },
    reportPageCards(_payload: PageCardsPayload) { /* no-op */ },
    reportNoteDetail(_payload: NoteDetailPayload) { /* no-op */ },
    send() { /* no-op */ },
  } as unknown as EdgeClient;
  const session = new NativeBrowseSession({
    runtime,
    client,
    startupId: 'startup-xhs-commit-window',
    platform: 'xiaohongshu',
    commitWindow,
    logger: () => undefined,
  });
  return { session, actions };
}

test('Xiaohongshu browse writes reach the shared coordinator guard without any platform condition', async () => {
  let now = 1_000;
  const guard = new CommitWindowGuard(() => now);
  const coordinator = combineCommitWindows([guard]);
  const observed: Array<{ label: string; budgetMs: number; openDuring: boolean; remaining: number }> = [];
  const h = harness(async (_ownerId, _command, _timeoutMs, _signal, commitWindowHandler) => {
    assert.ok(commitWindowHandler, '小红书写入必须拿到窗口处理器，而不是 undefined');
    const dispose = commitWindowHandler(windowRequest({
      sessionId: 'xhs-session',
      taskId: 'task-comment',
      commandId: 1,
      token: 'cw_1_1',
      label: 'xhs_comment_submit',
      budgetMs: 4_000,
    }));
    observed.push({
      label: guard.label ?? '',
      budgetMs: 4_000,
      openDuring: coordinator.inCommitWindow(),
      remaining: coordinator.commitWindowRemainingMs(),
    });
    now += 500;
    dispose();
    return {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: { kind: 'action_receipt', value: { action: 'comment', ok: true } },
    };
  }, guard);

  await h.session.onCloudCommand(envelope('xiaohongshu.note.comment', { noteId: 'note-1', text: 'hi' }));

  // 窗口内协调器读到「占用中 + 剩余预算」，窗口外才可抢占。
  assert.deepEqual(observed, [{
    label: 'xhs_comment_submit',
    budgetMs: 4_000,
    openDuring: true,
    remaining: 4_000,
  }]);
  // 终态必关窗：不得泄漏成永久占用，否则一次提交能永久挡住抢占。
  assert.equal(guard.isOpen(), false);
  assert.equal(coordinator.commitWindowRemainingMs(), 0);
  assert.equal(h.actions[0]?.ok, true);
});

test('Xiaohongshu publish submit consumes the platform-neutral publish guard injection', async () => {
  let now = 5_000;
  const guard = new CommitWindowGuard(() => now);
  let observedLabel: string | undefined;
  let observedRemaining = 0;
  const runtime = {
    execute: async (
      _owner: string,
      _command: NativePageCommand,
      _timeoutMs: number,
      _signal: AbortSignal | undefined,
      commitWindowHandler?: NativeCommitWindowHandler,
    ) => {
      assert.ok(commitWindowHandler, '发布提交必须拿到窗口处理器');
      const dispose = commitWindowHandler(windowRequest({
        sessionId: 'xhs-session',
        taskId: 'task-publish',
        commandId: 2,
        token: 'cw_2_1',
        label: 'xhs_publish_submit',
        budgetMs: 15_000,
      }));
      observedLabel = guard.label;
      observedRemaining = guard.remainingMs();
      dispose();
      return {
        effectPhase: 'confirmed' as const,
        output: { kind: 'publish_receipt', value: { ok: true, submitDispatched: true } },
      };
    },
  } as unknown as NativePageRuntime;
  const executor = new NativePublishExecutor(runtime, 'aidcp-native-publish-guard-', guard);

  const payload: PublishCommandPayload = {
    platform: 'xiaohongshu',
    taskId: 'task-publish',
    recordId: 9,
    seq: 1,
    kind: 'submit_publish',
    params: {},
  };
  const result = await executor.dispatch(payload);

  assert.equal(result.ok, true);
  assert.equal(observedLabel, 'xhs_publish_submit');
  assert.equal(observedRemaining, 15_000);
  assert.equal(guard.isOpen(), false, '终态必关窗');
});

test('an unavailable commit window leaves the Xiaohongshu write not started', async () => {
  const guard = new CommitWindowGuard();
  const h = harness(async () => {
    // 执行体拿不到窗口：整条命令按未开始终结，页面一个字节都没写过。
    throw Object.assign(new Error('commit window unavailable'), {
      code: 'commit_window_unavailable',
      detail: { effectPhase: 'not_started' },
    });
  }, guard);

  await h.session.onCloudCommand(envelope('xiaohongshu.note.comment', { noteId: 'note-1', text: 'hi' }));

  assert.deepEqual(h.actions, [{
    action: 'comment',
    ok: false,
    reason: 'commit_window_unavailable',
  }]);
  assert.equal(guard.isOpen(), false);
});

test('a stuck commit window expires on the clock and a late disposer never closes a newer one', () => {
  let now = 0;
  const guard = new CommitWindowGuard(() => now);

  // 时基兜底：disposer 因异常 / 崩溃从未被调用，窗口也必须在预算耗尽后自动过期——
  // 一个卡死的窗口绝不永久挡住抢占。
  guard.enter(4_000, 'xhs_comment_submit');
  now = 3_999;
  assert.equal(guard.isOpen(), true);
  assert.equal(guard.remainingMs(), 1);
  now = 4_000;
  assert.equal(guard.isOpen(), false);
  assert.equal(guard.remainingMs(), 0);
  assert.equal(guard.label, undefined);

  // 世代守卫：一个迟到的旧 disposer 绝不误关一个新开的窗口（连续提交下不串味）。
  const stale = guard.enter(20_000, 'xhs_notification_comments');
  guard.enter(15_000, 'xhs_publish_submit');
  stale();
  assert.equal(guard.isOpen(), true);
  assert.equal(guard.label, 'xhs_publish_submit');
  assert.equal(guard.remainingMs(), 15_000);
});
