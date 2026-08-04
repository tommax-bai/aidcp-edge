import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  NativePageEngineClient,
  NativePageEngineError,
  type NativeEngineDiagnosticLine,
  type NativePageEngineClientOptions,
} from '../../src/native-page-engine/client.js';

const fixture = fileURLToPath(
  new URL('../fixtures/native-page-engine/fake-engine.mjs', import.meta.url),
);

// 假引擎是真起一个 node 子进程（tsx + fixture）。3s 只够空载时启动：满负载并行跑全量时会被吃掉，
// 于是协议校验类用例拿到的是 engine_timeout 而不是它要测的 invalid_protocol —— 单跑必过、全量偶发。
// 这些用例测的是协议与错误语义，不是启动速度，故给足 10s；真要测进程死线的那条自己传更小的值。
function client(mode: string, processTimeoutMs = 10_000): NativePageEngineClient {
  return new NativePageEngineClient({
    binaryPath: process.execPath,
    binaryArgs: [fixture],
    processTimeoutMs,
    env: { AIDCP_FAKE_ENGINE_MODE: mode },
  });
}

const input = {
  host: '127.0.0.1',
  port: 9222,
  platform: 'xiaohongshu' as const,
  timeoutMs: 500,
};

test('resolves only the correlated protocol-v2 command result', async () => {
  const result = await client('success').probePage(input);
  assert.equal(result.pageKind, 'explore');
  assert.equal(result.signals.feedCardCount, 12);
});

test('keeps one supervised process across session status and commands', async () => {
  const taskId = 'task-1';
  const session = await client('success').openSession({
    ...input,
    sessionId: 'session-1',
    taskId,
  });
  assert.equal(session.manifest.platformAdapterVersion, 'multi-platform-test');
  assert.deepEqual(session.manifest.platformAdapters.map(({ platform }) => platform), [
    'xiaohongshu',
    'facebook',
    'wechat_channels',
  ]);
  const result = await session.probePage(500);
  assert.equal(result.pageKind, 'explore');
  const status = await session.status();
  assert.equal(status.taskId, taskId);
  assert.equal(status.lastCommandId, 1);
  await session.close();
});

test('executes only a typed high-level command and preserves the tagged result', async () => {
  const session = await client('success').openSession({
    ...input,
    sessionId: 'session-command',
    taskId: 'task-command',
  });
  const execution = await session.execute({ kind: 'browse_scroll', params: { reason: 'test' } }, 500);
  assert.equal(execution.effectPhase, 'confirmed');
  assert.equal(execution.output?.kind, 'page_cards');
  assert.deepEqual(execution.output?.value, {
    cards: [{ index: 0, title: 'Native card', likeCount: 1, collectCount: 2 }],
  });
  await session.close();
});

test('marks a command dispatched only after stdin accepts the serialized request', async () => {
  const session = await client('success').openSession({
    ...input,
    sessionId: 'session-command-dispatch',
    taskId: 'task-command-dispatch',
  });
  let dispatches = 0;
  try {
    await session.execute(
      { kind: 'browse_scroll', params: { reason: 'dispatch-proof' } },
      500,
      undefined,
      undefined,
      () => { dispatches += 1; },
    );

    assert.equal(dispatches, 1);
  } finally {
    await session.close();
  }
});

test('process exit after a successful command write preserves ambiguous effect truth', async () => {
  const session = await client('cancel').openSession({
    ...input,
    sessionId: 'session-command-exit',
    taskId: 'task-command-exit',
  });
  let dispatches = 0;
  const pending = session.execute(
    { kind: 'browse_scroll', params: { reason: 'exit-after-write' } },
    500,
    undefined,
    undefined,
    () => { dispatches += 1; },
  );
  const observed = pending.then(
    () => assert.fail('the held command must fail when the transport shuts down'),
    (error: unknown) => error,
  );
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  await session.close();

  const error = await observed;
  assert.ok(error instanceof NativePageEngineError);
  assert.equal(error.code, 'engine_exited');
  assert.equal(error.detail?.effectPhase, 'ambiguous');
  assert.equal(dispatches, 1);
});

test('command timeout after a successful write preserves ambiguous effect truth', async () => {
  const session = await client('cancel', 2_000).openSession({
    ...input,
    sessionId: 'session-command-timeout',
    taskId: 'task-command-timeout',
  });
  let dispatches = 0;
  try {
    await assert.rejects(
      session.execute(
        { kind: 'browse_scroll', params: { reason: 'timeout-after-write' } },
        50,
        undefined,
        undefined,
        () => { dispatches += 1; },
      ),
      (error: unknown) => {
        assert.ok(error instanceof NativePageEngineError);
        assert.equal(error.code, 'engine_timeout');
        assert.equal(error.detail?.effectPhase, 'ambiguous');
        return true;
      },
    );
    assert.equal(dispatches, 1);
  } finally {
    await session.close();
  }
});

test('permits only the capability-specific Facebook long command ceilings', async () => {
  const session = await client('success').openSession({
    ...input,
    platform: 'facebook',
    timeoutMs: 180_000,
    sessionId: 'session-facebook-join',
    taskId: 'task-facebook-join',
  });
  await session.execute({
    kind: 'group_join',
    params: { groupUrl: 'https://www.facebook.com/groups/42', click: true },
  }, 90_000);
  await session.execute({
    kind: 'interaction_comment',
    params: {
      noteId: 'https://www.facebook.com/groups/42/posts/7',
      text: 'Vietnamese comment',
      accountId: '61591824155856',
    },
  }, 90_000);
  await session.execute({
    kind: 'browse_scroll',
    params: { reason: 'initial_scan' },
  }, 180_000);
  await session.execute({
    kind: 'page_scroll',
    params: { reason: 'feed_scroll' },
  }, 180_000);
  // 空关键词首帖开帖（change restore-facebook-post-join-comment-continuity）。
  // 这一条**必须走真实准入校验**：桩运行时的单测只看「请求了多少毫秒」、绕过本校验，
  // 于是 2026-07-29 真机上每一次首帖开帖都被判 invalid_request、毫秒级被拒，
  // 云端读到的却是「群内未找到合适的可评论帖子」——比原缺陷更糟，且把人指向完全错误的方向。
  await session.execute({
    kind: 'note_open',
    params: {
      selection: 'first_commentable_group_post',
      container: 'https://www.facebook.com/groups/42',
    },
  }, 90_000);
  await session.execute({
    kind: 'publish_select_mode',
    params: {
      recordId: 7,
      seq: 2,
      optionKind: 'target',
      optionValue: 'facebook_personal_timeline',
    },
  }, 60_000);
  await session.execute({
    kind: 'publish_fill_field',
    params: {
      recordId: 7,
      seq: 3,
      fieldType: 'content',
      value: 'Vietnamese body',
    },
  }, 400_000);
  await assert.rejects(
    session.execute({
      kind: 'page_scroll',
      params: { reason: 'feed_scroll' },
    }, 180_001),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
  await assert.rejects(
    session.execute({
      kind: 'interaction_comment',
      params: {
        noteId: 'https://www.facebook.com/groups/42/posts/7',
        text: 'Vietnamese comment',
        accountId: '61591824155856',
      },
    }, 180_001),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
  await assert.rejects(
    session.execute({
      kind: 'publish_select_mode',
      params: {
        recordId: 7,
        seq: 4,
        optionKind: 'target',
        optionValue: 'facebook_personal_timeline',
      },
    }, 60_001),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
  // Facebook 兜底档 = 90s（change unify-facebook-page-readiness-probe）：该平台每次导航
  // 都含一个 30s 文档就绪窗，45s 装不下。这里守的仍是「兜底档有边界」，只是边界换了值。
  await session.execute({ kind: 'page_probe', params: {} }, 90_000);
  await assert.rejects(
    session.execute({ kind: 'page_probe', params: {} }, 90_001),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
  // 放宽必须**只**落在首帖那一形态：按 URL 开帖走 Facebook 兜底档，绝不跟着首帖那档放开。
  await session.execute({
    kind: 'note_open',
    params: { url: 'https://www.facebook.com/groups/42/posts/7' },
  }, 90_000);
  await assert.rejects(
    session.execute({
      kind: 'note_open',
      params: { url: 'https://www.facebook.com/groups/42/posts/7' },
    }, 90_001),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
  await assert.rejects(
    session.execute({
      kind: 'note_open',
      params: {
        selection: 'first_commentable_group_post',
        container: 'https://www.facebook.com/groups/42',
      },
    }, 135_001),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
  await session.close();

  await assert.rejects(client('success').openSession({
    ...input,
    timeoutMs: 90_000,
    sessionId: 'session-xhs-long',
    taskId: 'task-xhs-long',
  }), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'invalid_request');
    return true;
  });
});

test('opens and closes a correlated host commit window before Native write completion', async () => {
  const session = await client('commit-window').openSession({
    ...input,
    platform: 'facebook',
    sessionId: 'session-facebook-window',
    taskId: 'task-facebook-window',
  });
  let open = false;
  const seen: Array<{ label: string; budgetMs: number; commandId: number }> = [];
  const execution = await session.execute({
    kind: 'group_join',
    params: { groupUrl: 'https://www.facebook.com/groups/42', click: true },
  }, 1_000, undefined, (request) => {
    assert.equal(open, false);
    open = true;
    seen.push({
      label: request.label,
      budgetMs: request.budgetMs,
      commandId: request.commandId,
    });
    return () => { open = false; };
  });
  assert.equal(execution.effectPhase, 'confirmed');
  // 预算来自**宿主事实源**（`NATIVE_COMMIT_WINDOW_BUDGETS` 的 `fb_join_click`），不是引擎报的。
  // change `harden-native-engine-runtime-contracts` 3.2 之后，引擎的开窗请求线路上**只有标签**：
  // 假引擎与真引擎一样不再发预算数字，宿主按标签发放，守卫拿到的就是这个授予值。
  assert.deepEqual(seen, [{ label: 'fb_join_click', budgetMs: 27_750, commandId: 1 }]);
  assert.equal(open, false);
  await session.close();
});

test('refuses an irreversible Native write when no host commit guard is installed', async () => {
  const session = await client('commit-window').openSession({
    ...input,
    platform: 'facebook',
    sessionId: 'session-facebook-window-missing',
    taskId: 'task-facebook-window-missing',
  });
  await assert.rejects(
    session.execute({
      kind: 'group_join',
      params: { groupUrl: 'https://www.facebook.com/groups/42', click: true },
    }, 1_000),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'commit_window_unavailable');
      assert.equal(error.detail?.effectPhase, 'not_started');
      return true;
    },
  );
  await session.close();
});

test('rejects a ready engine whose capability manifest differs from the packaged contract', async () => {
  const strict = new NativePageEngineClient({
    binaryPath: process.execPath,
    binaryArgs: [fixture],
    // 预算给足 10s，理由与本文件顶部的 `client()` 完全一致：这条测的是**协议语义**
    // （能力清单与打包契约不符 ⇒ invalid_protocol），而要拿到清单来比对，引擎必须先真的起来握手。
    // 此前这里硬写 500ms，绕过了那条默认值：满负载并行跑全量时子进程起不来，
    // 拿到的是 engine_timeout 而不是它要测的 invalid_protocol —— **单跑必过、全量偶发**。
    processTimeoutMs: 10_000,
    env: { AIDCP_FAKE_ENGINE_MODE: 'success' },
    expectedManifest: {
      engineVersion: 'test',
      platformAdapterVersion: 'multi-platform-test',
      platformAdapters: [
        { platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-test' },
        { platform: 'facebook', adapterVersion: 'facebook-test' },
        { platform: 'wechat_channels', adapterVersion: 'wechat-channels-test' },
      ],
      capabilityDigest: 'b'.repeat(64),
    },
  });
  await assert.rejects(strict.probePage(input), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'invalid_protocol');
    return true;
  });
});

test('forwards AbortSignal cancellation and preserves not_started truth', async () => {
  const session = await client('cancel').openSession({
    ...input,
    sessionId: 'session-cancel',
    taskId: 'task-cancel',
  });
  const controller = new AbortController();
  const pending = session.probePage(500, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'cancelled');
    assert.equal(error.detail?.effectPhase, 'not_started');
    return true;
  });
  await session.close();
});

test('preserves native stable errors', async () => {
  await assert.rejects(client('native-error').probePage(input), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'no_matching_target');
    assert.equal(error.detail?.diagnostic, undefined);
    return true;
  });
});

test('forwards optional bounded Native decode diagnostics without changing stable error truth', async () => {
  const session = await client('diagnostic-error').openSession({
    ...input,
    platform: 'facebook',
    sessionId: 'session-diagnostic',
    taskId: 'task-diagnostic',
  });
  await assert.rejects(
    session.execute({
      kind: 'group_join',
      params: { groupUrl: 'https://www.facebook.com/groups/42', click: false },
    }, 500),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'cdp_error');
      assert.equal(error.message, 'native Facebook command returned an invalid bounded result');
      assert.equal(error.detail?.effectPhase, 'not_started');
      assert.deepEqual(error.detail?.diagnostic, {
        operationStage: 'readiness_probe',
        decodeStage: 'typed_value',
        expectedKind: 'join_probe',
        fieldPath: 'observation.actionNodeCount',
        actualType: 'number',
        exceptionClass: 'type_error',
        exceptionReason: 'cannot_read_property',
        exceptionToken: 'querySelectorAll',
        lineNumber: 13,
        columnNumber: 55,
      });
      return true;
    },
  );
  await session.close();
});

test('kills a child that exceeds the process deadline', async () => {
  await assert.rejects(
    client('hang', 100).probePage({ ...input, timeoutMs: 50 }),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'engine_timeout');
      return true;
    },
  );
});

test('rejects malformed stdout instead of accepting partial output', async () => {
  await assert.rejects(client('malformed').probePage(input), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'invalid_protocol');
    return true;
  });
});

test('reports exit before readiness honestly', async () => {
  await assert.rejects(client('exit').probePage(input), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'engine_exited');
    assert.equal(error.detail?.exitCode, 23);
    return true;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 引擎诊断行的转发通路（change surface-native-engine-diagnostics）
//
// 中心断言在第一条：引擎在**命令成功、进程不退出**的路径上写的那一行，今天必然收不到
//（错误输出只进 2048 字符滚动尾缓冲，而尾缓冲只在构造进程级失败对象时才挂出去）。
//
// 这里用进程内假引擎而不是真子进程：读边界是这批用例的被测对象之一，真管道给不出确定的
// chunk 切分，而「两个 chunk 拼成一行」若靠运气合并，用例就永远绿、永远什么都没证明。
// ─────────────────────────────────────────────────────────────────────────────

const probeResultValue = {
  targetId: 'target-1',
  origin: 'https://www.xiaohongshu.com',
  path: '/explore',
  readyState: 'complete',
  pageKind: 'explore',
  signals: {
    feedCardCount: 12,
    noteDetailCount: 0,
    loginWallCount: 0,
    captchaSignalCount: 0,
    dialogCount: 0,
    profileSignalCount: 0,
    notificationSignalCount: 0,
    publishSignalCount: 0,
    errorSignalCount: 0,
    mainCount: 1,
  },
};

class FakeEngineChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** 收到 command 请求、在回应答**之前**执行；诊断用例在这里模拟引擎写 stderr。 */
  beforeCommandResult: (() => void) | undefined;
  /** 置真则收到 command 后不回应答（用来撞 IPC 死线）。 */
  swallowCommands = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) this.handleRequest(JSON.parse(line));
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  ready(): void {
    this.stdout.write(`${JSON.stringify({
      type: 'ready',
      protocolVersion: 2,
      manifest: {
        engineVersion: 'test',
        platformAdapterVersion: 'multi-platform-test',
        platformAdapters: [{ platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-test' }],
        capabilityDigest: 'a'.repeat(64),
      },
    })}\n`);
  }

  private handleRequest(request: Record<string, string | number>): void {
    if (request.type === 'session_open') {
      this.stdout.write(`${JSON.stringify({
        type: 'response',
        protocolVersion: 2,
        id: request.id,
        ok: true,
        result: {
          sessionId: request.sessionId,
          taskId: request.taskId,
          state: 'ready',
          targetId: 'target-1',
          lastCommandId: 0,
        },
      })}\n`);
      return;
    }
    if (request.type === 'command') {
      this.beforeCommandResult?.();
      if (this.swallowCommands) return;
      this.stdout.write(`${JSON.stringify({
        type: 'command_result',
        protocolVersion: 2,
        id: request.id,
        sessionId: request.sessionId,
        taskId: request.taskId,
        commandId: request.commandId,
        ok: true,
        effectPhase: 'confirmed',
        reasonCode: 'confirmed',
        result: { kind: 'page_probe', value: probeResultValue },
      })}\n`);
      return;
    }
    if (request.type === 'shutdown') {
      this.stdout.write(`${JSON.stringify({
        type: 'response', protocolVersion: 2, id: request.id, ok: true, result: {},
      })}\n`);
    }
  }
}

async function openFakeSession(sink?: (line: NativeEngineDiagnosticLine) => void): Promise<{
  child: FakeEngineChild;
  session: Awaited<ReturnType<NativePageEngineClient['openSession']>>;
}> {
  const child = new FakeEngineChild();
  const engine = new NativePageEngineClient({
    binaryPath: '/tmp/fake-native-page-engine',
    processTimeoutMs: 2_000,
    spawnImpl: (() => {
      queueMicrotask(() => child.ready());
      return child;
    }) as unknown as NonNullable<NativePageEngineClientOptions['spawnImpl']>,
    ...(sink ? { onDiagnosticLine: sink } : {}),
  });
  const session = await engine.openSession({ ...input, sessionId: 'diag_session', taskId: 'diag_task' });
  return { child, session };
}

test('forwards an engine diagnostic written while the command succeeds', async () => {
  const forwarded: NativeEngineDiagnosticLine[] = [];
  const { child, session } = await openFakeSession((line) => forwarded.push(line));
  child.beforeCommandResult = () => {
    child.stderr.write('native_page_engine_xhs_typing_degraded:comment:degraded_sends=2\n');
  };
  const execution = await session.execute({ kind: 'page_probe', params: {} }, 500);
  // 命令自身的结论不受影响：转发是 tee，不改回执。
  assert.equal(execution.ok, true);
  assert.equal(execution.effectPhase, 'confirmed');
  assert.deepEqual(forwarded, [{
    seq: 1,
    text: 'native_page_engine_xhs_typing_degraded:comment:degraded_sends=2',
    kind: 'known',
    truncated: false,
    incomplete: false,
  }]);
});

test('keeps behavior identical when no diagnostic sink is supplied', async () => {
  const { child, session } = await openFakeSession();
  child.beforeCommandResult = () => {
    child.stderr.write('native_page_engine_xhs_typing_degraded:comment:degraded_sends=2\n');
  };
  const execution = await session.execute({ kind: 'page_probe', params: {} }, 500);
  assert.equal(execution.ok, true);
});

test('rejoins a diagnostic line split across two read chunks', async () => {
  const forwarded: NativeEngineDiagnosticLine[] = [];
  const { child, session } = await openFakeSession((line) => forwarded.push(line));
  child.beforeCommandResult = () => {
    child.stderr.write('native_page_engine_xhs_wheel_abo');
    child.stderr.write('rted:comments:cancelled\n');
  };
  await session.execute({ kind: 'page_probe', params: {} }, 500);
  // 半行必须被识别为半行：两个 chunk 出去的是**一行**，不是两行。
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.text, 'native_page_engine_xhs_wheel_aborted:comments:cancelled');
  assert.equal(forwarded[0]?.incomplete, false);
});

test('marks an over-long line as truncated instead of shortening it silently', async () => {
  const forwarded: NativeEngineDiagnosticLine[] = [];
  const { child, session } = await openFakeSession((line) => forwarded.push(line));
  child.beforeCommandResult = () => {
    child.stderr.write(`native_page_engine_${'x'.repeat(4_000)}\n`);
    child.stderr.write('native_page_engine_after_overlong:1\n');
  };
  await session.execute({ kind: 'page_probe', params: {} }, 500);
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0]?.truncated, true);
  assert.equal(forwarded[0]?.text.length, 2_048);
  // 超长行的尾巴 MUST NOT 变成一条引擎从未写过的诊断；下一条必须是真正的下一行。
  assert.equal(forwarded[1]?.text, 'native_page_engine_after_overlong:1');
  assert.equal(forwarded[1]?.truncated, false);
});

test('flushes a partial line at process exit marked incomplete', async () => {
  const forwarded: NativeEngineDiagnosticLine[] = [];
  const { child } = await openFakeSession((line) => forwarded.push(line));
  child.stderr.write("thread 'main' panicked at src/engine.rs:1:1:\nhalf-written-fragment");
  await new Promise((resolve) => setTimeout(resolve, 10));
  child.stderr.end();
  child.emit('exit', 101, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(forwarded.length, 2);
  // 崩溃前那半行往往最有价值：冲出来并如实标不完整，绝不丢弃。
  assert.equal(forwarded[1]?.text, 'half-written-fragment');
  assert.equal(forwarded[1]?.incomplete, true);
});

test('forwards panic output classified as unrecognized instead of dropping it', async () => {
  const forwarded: NativeEngineDiagnosticLine[] = [];
  const { child, session } = await openFakeSession((line) => forwarded.push(line));
  child.beforeCommandResult = () => {
    child.stderr.write("thread 'main' panicked at src/engine.rs:1:1:\n");
    child.stderr.write('note: run with `RUST_BACKTRACE=1`\n');
    child.stderr.write('native_page_engine_request_rejected:InvalidRequest\n');
  };
  await session.execute({ kind: 'page_probe', params: {} }, 500);
  assert.deepEqual(forwarded.map((line) => line.kind), ['other', 'other', 'known']);
  assert.equal(forwarded[0]?.text, "thread 'main' panicked at src/engine.rs:1:1:");
});

test('still attaches the rolling stderr tail to process-level failures', async () => {
  // ① 进程崩溃
  const crash = await openFakeSession(() => undefined);
  crash.child.swallowCommands = true;
  crash.child.beforeCommandResult = () => {
    crash.child.stderr.write('native_page_engine_stdin_failed\n');
    setTimeout(() => crash.child.emit('exit', 101, null), 5);
  };
  await assert.rejects(
    crash.session.execute({ kind: 'page_probe', params: {} }, 500),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'engine_exited');
      assert.match(String(error.detail?.stderr), /native_page_engine_stdin_failed/);
      return true;
    },
  );

  // ② IPC 死线
  const timeout = await openFakeSession(() => undefined);
  timeout.child.swallowCommands = true;
  timeout.child.beforeCommandResult = () => {
    timeout.child.stderr.write('native_page_engine_session_open_failed:CdpTimeout\n');
  };
  await assert.rejects(
    timeout.session.execute({ kind: 'page_probe', params: {} }, 60),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'engine_timeout');
      assert.match(String(error.detail?.stderr), /native_page_engine_session_open_failed/);
      return true;
    },
  );

  // ③ 协议非法
  const protocolViolation = await openFakeSession(() => undefined);
  protocolViolation.child.swallowCommands = true;
  protocolViolation.child.beforeCommandResult = () => {
    protocolViolation.child.stderr.write('native_page_engine_request_rejected:InvalidProtocol\n');
    setTimeout(() => protocolViolation.child.stdout.write('not-json\n'), 5);
  };
  await assert.rejects(
    protocolViolation.session.execute({ kind: 'page_probe', params: {} }, 500),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'invalid_protocol');
      assert.match(String(error.detail?.stderr), /native_page_engine_request_rejected/);
      return true;
    },
  );
});
