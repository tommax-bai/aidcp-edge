/**
 * 小红书 Native 会话看护：阻断观测 → 云端上报 → 本地停手 → 自愈后配对清除。
 *
 * 迁移后这条线整段只服务 Facebook（周期探针、观测函数、上报点三处首行都判平台），
 * 于是小红书遇验证码零上报：云端不建 incident、远程协助不被唤起、账号风控态不迁移。
 * 本组用例把这条电接上，并钉住三条最容易写坏的语义：
 *  ① 检出与清除**严格配对**（没上报过就绝不发孤儿清除）；
 *  ② 页面类型**未识别**绝不冒充阻断（那是一台把识别失败换成账号降级的误报机）；
 *  ③ 停手等待循环有三个显式出口（少一个就有一种停摆或死锁形态）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgeClient } from '../../src/client/edge-client.js';
import type {
  ActionCompletedPayload,
  Envelope,
  MessageType,
  NoteDetailPayload,
  PageCardsPayload,
} from '../../src/comm/protocol.js';
import { NativeBrowseSession } from '../../src/native-page-engine/browse-session.js';
import type {
  NativePageCommand,
  NativePageCommandExecution,
  NativeCommitWindowHandler,
} from '../../src/native-page-engine/client.js';
import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

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
  options: {
    platform?: 'xiaohongshu' | 'facebook';
    accountId?: string;
    clock?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    probeIntervalMs?: number;
    blockingWaitMs?: number;
    blockingPollMs?: number;
  } = {},
) {
  const executions: Array<{ ownerId: string; command: NativePageCommand }> = [];
  const actions: ActionCompletedPayload[] = [];
  const logs: string[] = [];
  const sent: Array<{ type: string; payload: unknown }> = [];
  const runtime = {
    async execute(
      ownerId: string,
      command: NativePageCommand,
      timeoutMs?: number,
      signal?: AbortSignal,
      commitWindowHandler?: NativeCommitWindowHandler,
    ) {
      executions.push({ ownerId, command });
      return execute(ownerId, command, timeoutMs, signal, commitWindowHandler);
    },
    async closeOwner() { /* no-op */ },
  } as unknown as NativePageRuntime;
  const client = {
    reportActionCompleted(payload: ActionCompletedPayload) { actions.push(payload); },
    reportPageCards(_payload: PageCardsPayload) { /* no-op */ },
    reportNoteDetail(_payload: NoteDetailPayload) { /* no-op */ },
    send(type: string, payload: unknown) { sent.push({ type, payload }); },
  } as unknown as EdgeClient;
  const session = new NativeBrowseSession({
    runtime,
    client,
    startupId: 'startup-xhs-session-guard',
    platform: options.platform ?? 'xiaohongshu',
    edgeId: 'edge-guard',
    getAccountId: () => options.accountId,
    clock: options.clock,
    sleep: options.sleep,
    probeIntervalMs: options.probeIntervalMs,
    blockingWaitMs: options.blockingWaitMs,
    blockingPollMs: options.blockingPollMs,
    logger: (message) => logs.push(message),
  });
  return { session, executions, actions, logs, sent };
}

const okScroll: NativePageCommandExecution = {
  ok: true,
  effectPhase: 'confirmed',
  reasonCode: 'confirmed',
  output: { kind: 'page_cards', value: { cards: [], listKind: 'feed' } },
};

function diagnostics(logs: string[]): string[] {
  return logs.filter((line) => line.startsWith('[native-page] session.event '));
}

function diagnosticEvents(logs: string[]): string[] {
  return diagnostics(logs).map((line) => /event=([a-z_]+)/.exec(line)?.[1] ?? '');
}

test('Xiaohongshu captcha page kind reports one detection and exactly one paired clearance', async () => {
  const h = harness(async () => okScroll, { accountId: 'xhs-account-1' });

  h.session.observeProbe({
    origin: 'https://www.xiaohongshu.com',
    path: '/explore',
    pageKind: 'captcha',
  });
  // 同一 episode 内重复观测不得重复上报。
  h.session.observeProbe({
    origin: 'https://www.xiaohongshu.com',
    path: '/explore',
    pageKind: 'captcha',
  });

  const detected = h.sent.filter((entry) => entry.type === 'risk.captcha_detected');
  assert.equal(detected.length, 1);
  assert.deepEqual(detected[0]?.payload, {
    edgeId: 'edge-guard',
    accountId: 'xhs-account-1',
    kind: 'captcha',
    url: 'https://www.xiaohongshu.com/explore',
    reason: 'native_page_probe',
  });

  h.session.observeProbe({
    origin: 'https://www.xiaohongshu.com',
    path: '/explore',
    pageKind: 'explore',
  });
  const cleared = h.sent.filter((entry) => entry.type === 'risk.captcha_cleared');
  assert.equal(cleared.length, 1, 'detected/cleared 必须严格配对：一次检出配一次清除');
  assert.deepEqual(cleared[0]?.payload, {
    edgeId: 'edge-guard',
    accountId: 'xhs-account-1',
    url: 'https://www.xiaohongshu.com/explore',
  });
});

test('Xiaohongshu login wall halts locally without any account-level cloud report', async () => {
  const h = harness(async () => okScroll, { accountId: 'xhs-account-1' });

  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'login' });

  assert.deepEqual(h.sent, [], '登录墙只本地停手、不打扰云端');
  assert.equal(h.session.observationStatus().blockingKind, 'login');

  // 自愈：从未上报过的阻断态绝不发孤儿 cleared。
  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'explore' });
  assert.deepEqual(h.sent, []);
  assert.equal(h.session.observationStatus().blockingKind, 'none');
});

test('Xiaohongshu unidentified page kind produces no blocking report and no halt', async () => {
  const h = harness(async () => okScroll, { accountId: 'xhs-account-1' });

  // 「页面类型未识别」不是「我看见一堵归不了类的阻断墙」。小红书的看图态 / AI 搜索结果页 /
  // 详情弹层都会落进未识别；把它当阻断＝每次识别失败换一次账号降级。
  // 连带钉住：即使载荷里带了一个 unknown 阻断字段，小红书侧也 MUST NOT 据此上报——
  // 低置信桶在小红书上是**已声明的缺席**，不是可以由页面类型顶替的空位。
  h.session.observeProbe({
    origin: 'https://www.xiaohongshu.com',
    path: '/search_result_ai',
    pageKind: 'unknown',
    blockingKind: 'unknown',
    blockingText: '看不出来这是什么页面',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(h.sent, [], '未识别页面 MUST NOT 产生任何阻断上报');
  assert.equal(h.session.observationStatus().blockingKind, 'none');

  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  assert.equal(h.executions.length, 1, '未识别页面也 MUST NOT 拦下正常动作');
});

test('Xiaohongshu blocking halt answers ordinary browse with an honest not-started receipt and resumes after clearance', async () => {
  const h = harness(async () => okScroll, { blockingWaitMs: 0 });

  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'captcha' });
  await h.session.onCloudCommand(envelope('interaction.like', { noteId: 'note-1' }));

  assert.equal(h.executions.length, 0, '停手期间一个字节都不许写页面');
  assert.deepEqual(h.actions, [{ action: 'like', ok: false, reason: 'blocked_by_captcha' }]);

  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'explore' });
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  assert.equal(h.executions.length, 1, '清除后必须恢复下发');
});

test('Xiaohongshu login halt answers with login_required rather than a captcha reason', async () => {
  const h = harness(async () => okScroll, { blockingWaitMs: 0 });

  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'login' });
  await h.session.onCloudCommand(envelope('interaction.follow', { authorId: 'a1', noteId: 'note-1' }));

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.actions, [{ action: 'follow', ok: false, reason: 'login_required' }]);
});

test('Xiaohongshu blocking halt exit 2: a queued session end terminates the session instead of waiting on the wall', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'action_receipt', value: { action: 'session_stop', ok: true } },
  }), {
    // 预算故意开得很大：若终止命令也被闸门拦住，本用例会挂在这里而不是通过。
    blockingWaitMs: 600_000,
  });

  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'login' });
  await h.session.onCloudCommand(envelope('session.end', { reason: 'cloud_stop' }));

  assert.equal(h.executions.at(0)?.command.kind, 'session_stop');
  assert.equal(
    diagnosticEvents(h.logs).includes('session_stopped'),
    true,
    '登录墙常驻时云端仍必须能终止会话',
  );
});

test('Xiaohongshu blocking halt lets a coordinator-owned task command through', async () => {
  const h = harness(async () => okScroll, {
    // 预算故意开得很大：若任务命令也被闸门拦住，本用例会挂在这里。
    blockingWaitMs: 600_000,
  });

  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'captcha' });
  await h.session.onCloudCommand(envelope('page.scroll', {
    reason: 'task_leg',
    taskId: 'task-assist-1',
  }));

  // 解除阻断本身就是独占任务干的活；把它拦在「等阻断消失」的闸门里，
  // 等的就是一个只有它自己能促成的条件。
  assert.equal(h.executions.length, 1);
  assert.equal(h.executions[0]?.ownerId, 'task-assist-1');
});

test('Xiaohongshu blocking halt exit 3: task takeover throws so the command is voided with zero side effects', async () => {
  let yielded = false;
  const h = harness(async () => okScroll, {
    blockingWaitMs: 600_000,
    blockingPollMs: 0,
    sleep: async () => {
      if (yielded) return;
      yielded = true;
      // 接管信号到达。MUST NOT 只返回——只返回会让这条命令继续对着验证码墙点下去，
      // 而交接等的是「命令处理函数还没返回」⇒ 闭环死锁、整台机器停摆。
      void h.session.quiesceForTask();
    },
  });

  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'captcha' });
  await assert.rejects(
    h.session.onCloudCommand(envelope('interaction.like', { noteId: 'note-1' })),
    (error: { code?: string }) => error.code === 'preempted_by_task',
  );

  assert.equal(h.executions.length, 0, '零副作用作废：不得留下任何页面写入');
  assert.deepEqual(h.actions, [], '让路的命令不伪造终局回执');
});

test('Xiaohongshu blocking halt exit 1: a local stop ends the wait with an honest not-started receipt', async () => {
  let stopped = false;
  const h = harness(async () => okScroll, {
    blockingWaitMs: 600_000,
    blockingPollMs: 0,
    sleep: async () => {
      if (stopped) return;
      stopped = true;
      h.session.stop('local_stop');
    },
  });

  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'captcha' });
  await h.session.onCloudCommand(envelope('interaction.collect', { noteId: 'note-1' }));

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.actions, [{ action: 'collect', ok: false, reason: 'session_stopped' }]);
});

test('Xiaohongshu periodic observation is lifecycle-managed and idempotent on both ends', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: {
      kind: 'page_probe',
      value: { origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'explore' },
    },
  }), { probeIntervalMs: 1 });

  await h.session.start();
  assert.equal(h.session.observationStatus().running, true);

  h.session.suspendObservation('executor_unrecoverable');
  h.session.suspendObservation('executor_unrecoverable');
  assert.deepEqual(h.session.observationStatus().suspended, true);
  assert.equal(h.session.observationStatus().running, false);
  assert.equal(
    diagnosticEvents(h.logs).filter((event) => event === 'observation_suspended').length,
    1,
    '重复停用是空操作',
  );

  h.session.resumeObservation();
  h.session.resumeObservation();
  assert.equal(h.session.observationStatus().suspended, false);
  assert.equal(h.session.observationStatus().running, true);
  assert.equal(
    diagnosticEvents(h.logs).filter((event) => event === 'observation_resumed').length,
    1,
    '重启幂等：不得重复起两条探针',
  );
  h.session.close();
});

test('Xiaohongshu observation liveness separates "cannot probe" from "nothing to see"', async () => {
  let failing = true;
  let now = 1_000;
  const h = harness(async (_ownerId, command) => {
    if (command.kind === 'page_probe' && failing) throw new Error('probe unavailable');
    return {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: {
        kind: 'page_probe',
        value: { origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'explore' },
      },
    };
  }, { probeIntervalMs: 1, clock: () => now });

  // 阻断态先立起来，再让探测持续失败：容错档是 sticky——保持上一状态，绝不翻转。
  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'captcha' });
  h.session.resumeObservation();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const failed = h.session.observationStatus();
  assert.ok(failed.consecutiveProbeFailures > 0, '持续探测失败必须在外部可见');
  assert.equal(failed.msSinceLastOkProbe, undefined, '一次都没成功过与「刚看过、没情况」是两态');
  assert.equal(failed.blockingKind, 'captcha', '探测失败保持上一状态，绝不翻转成「没情况」');
  assert.equal(
    diagnosticEvents(h.logs).filter((event) => event === 'observation_probe_failed').length,
    1,
    '失败只在进入失败态时记一行，不刷屏',
  );

  failing = false;
  now += 500;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const recovered = h.session.observationStatus();
  assert.equal(recovered.consecutiveProbeFailures, 0);
  assert.equal(typeof recovered.msSinceLastOkProbe, 'number');
  h.session.close();
});

test('Xiaohongshu observation records "assembled but not started" instead of going quiet', async () => {
  const h = harness(async () => okScroll, { probeIntervalMs: 1 });

  await h.session.quiesceForTask();
  h.session.resumeObservation();

  assert.equal(h.session.observationStatus().running, false);
  assert.equal(
    diagnostics(h.logs).some((line) => (
      line.includes('event=observation_deferred') && line.includes('reason=task_takeover')
    )),
    true,
    '运维必须能区分「没装」与「装了没开」',
  );
  h.session.close();
});

test('Xiaohongshu browse loop leaves per-command receipt evidence carrying no page text, credential, or selector', async () => {
  const receipts: NativePageCommandExecution[] = [
    okScroll,
    {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: { kind: 'note_detail', value: { noteId: 'note-1', title: 't', content: 'c' } },
    },
    {
      ok: true,
      effectPhase: 'not_started',
      reasonCode: 'control_not_found',
      output: {
        kind: 'action_receipt',
        value: {
          action: 'like',
          ok: false,
          // 原因码里混进选择器与带令牌的地址：诊断必须把它收敛掉，绝不原样落盘。
          reason: '.like-wrapper missing at https://www.xiaohongshu.com/explore/n1?xsec_token=secret',
        },
      },
    },
    {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: { kind: 'action_receipt', value: { action: 'back', ok: true, reason: 'list_ready' } },
    },
  ];
  const h = harness(async () => receipts.shift() ?? assert.fail('unexpected Native execution'));

  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  await h.session.onCloudCommand(envelope('note.open', { noteId: 'note-1' }));
  await h.session.onCloudCommand(envelope('interaction.like', { noteId: 'note-1' }));
  await h.session.onCloudCommand(envelope('navigation.back', { reason: 'return_feed' }));

  const receiptLogs = h.logs.filter((line) => line.includes('action.completed'));
  assert.deepEqual(receiptLogs, [
    '[native-page] action.completed action=like ok=false effectPhase=not_started reason=non_token_reason',
    '[native-page] action.completed action=back ok=true effectPhase=confirmed reason=list_ready',
  ]);
  // 闭环里那四条命令都必须留下痕迹：滚动与开帖的终局是结构化上报、不产出动作回执，
  // 只看回执行的话它们在日志里等于不存在。
  assert.deepEqual(
    diagnostics(h.logs)
      .filter((line) => line.includes('event=command_outcome'))
      .map((line) => /command=([a-z_]+)/.exec(line)?.[1]),
    ['page_scroll', 'note_open', 'interaction_like', 'navigation_back'],
  );
  assert.equal(h.logs.some((line) => line.includes('https://')), false);
  assert.equal(h.logs.some((line) => line.includes('xsec_token')), false);
  assert.equal(h.logs.some((line) => line.includes('like-wrapper')), false);
});

test('Xiaohongshu session emits lifecycle diagnostics but no companion UI events', async () => {
  const h = harness(async () => okScroll, { blockingWaitMs: 0 });

  await h.session.start();
  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'captcha' });
  h.session.observeProbe({ origin: 'https://www.xiaohongshu.com', path: '/explore', pageKind: 'explore' });
  await h.session.quiesceForTask();
  await h.session.resumeAfterTask();
  h.session.close();

  const events = diagnosticEvents(h.logs);
  for (const expected of [
    'session_ready',
    'blocking_detected',
    'blocking_cleared',
    'task_yield',
    'task_resume',
    'session_stopped',
  ]) {
    assert.equal(events.includes(expected), true, `缺会话级诊断 ${expected}`);
  }
  // 结构化行，不靠措辞：壳侧兜底正则只认「弹窗 / 暂停操作」这类中文措辞，
  // 一改文案阻断态就恒绿（Facebook 已为此吃过一次亏）。
  assert.equal(h.logs.some((line) => line.includes('暂停操作')), false);

  // 刻意的预期状态，不是可观测性缺口：小红书迁移前也没有在场感 / 陪伴界面事件，
  // 补它属产品范围，本次回归只要求排障级诊断对称。此断言用于防后续误当缺口重做。
  assert.equal(
    h.logs.some((line) => line.startsWith('[ui-event] ')),
    false,
    '小红书不产出陪伴界面事件（产品范围，非可观测性缺陷）',
  );
});
