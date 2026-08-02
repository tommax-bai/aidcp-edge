import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgeClient } from '../../src/client/edge-client.js';
import { CommitWindowGuard } from '../../src/execution/commit-window.js';
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

function envelope<T extends MessageType>(type: T, payload: Record<string, unknown>): Envelope {
  return { v: 2, type, id: `env-${type}`, ts: Date.now(), payload } as Envelope;
}

function harness(execute: (
  ownerId: string,
  command: NativePageCommand,
  timeoutMs?: number,
  signal?: AbortSignal,
  commitWindowHandler?: NativeCommitWindowHandler,
  onDispatched?: () => void,
) => Promise<NativePageCommandExecution>, options: {
  platform?: 'xiaohongshu' | 'facebook';
  accountId?: string;
  clock?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  overlayConfirmMs?: number;
  commitWindow?: CommitWindowGuard;
  probeIntervalMs?: number;
} = {}) {
  const executions: Array<{ ownerId: string; command: NativePageCommand; timeoutMs?: number }> = [];
  const actions: ActionCompletedPayload[] = [];
  const cards: PageCardsPayload[] = [];
  const details: NoteDetailPayload[] = [];
  const closedOwners: string[] = [];
  const logs: string[] = [];
  const sent: Array<{ type: string; payload: unknown; replyTo?: string }> = [];
  const runtime = {
    async execute(
      ownerId: string,
      command: NativePageCommand,
      timeoutMs?: number,
      signal?: AbortSignal,
      commitWindowHandler?: NativeCommitWindowHandler,
      onDispatched?: () => void,
    ) {
      executions.push({ ownerId, command, timeoutMs });
      return execute(ownerId, command, timeoutMs, signal, commitWindowHandler, onDispatched);
    },
    async closeOwner(ownerId: string) { closedOwners.push(ownerId); },
  } as unknown as NativePageRuntime;
  const client = {
    reportActionCompleted(payload: ActionCompletedPayload) { actions.push(payload); },
    reportPageCards(payload: PageCardsPayload) { cards.push(payload); },
    reportNoteDetail(payload: NoteDetailPayload) { details.push(payload); },
    send(type: string, payload: unknown, replyTo?: string) { sent.push({ type, payload, replyTo }); },
  } as unknown as EdgeClient;
  const session = new NativeBrowseSession({
    runtime,
    client,
    startupId: 'startup-native-test',
    platform: options.platform,
    getAccountId: () => options.accountId,
    clock: options.clock,
    random: options.random,
    sleep: options.sleep,
    overlayConfirmMs: options.overlayConfirmMs,
    commitWindow: options.commitWindow,
    probeIntervalMs: options.probeIntervalMs,
    logger: (message) => logs.push(message),
  });
  return { session, executions, actions, cards, details, closedOwners, logs, sent };
}

function uiEvents(logs: string[]): Array<Record<string, unknown>> {
  return logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as Record<string, unknown>);
}

const searchPayload = {
  taskId: 'task-comment-1',
  activityId: 'activity-search-1',
  purpose: 'task_targeting',
  scope: 'global',
  keyword: 'AI Agent实战',
};

test('Native identity current read injects bound account and reports correlated observation', async () => {
  const h = harness(async (_ownerId, command) => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: {
      kind: 'identity_observation',
      value: {
        captureId: command.params.captureId,
        accountId: command.params.accountId,
        nickname: 'Gi Vo',
        source: 'current_page',
        pageEffect: 'none',
      },
    },
  }), { platform: 'facebook', accountId: '61591824155856' });

  await h.session.onCloudCommand(envelope('identity.read_current', {
    captureId: 'capture-fb-1',
    accountId: 'cloud-injected-id',
  }));

  assert.deepEqual(h.executions[0]?.command, {
    kind: 'identity_read_current',
    params: { captureId: 'capture-fb-1', accountId: '61591824155856' },
  });
  assert.deepEqual(h.sent, [{
    type: 'identity.observed',
    payload: {
      captureId: 'capture-fb-1',
      accountId: '61591824155856',
      nickname: 'Gi Vo',
      source: 'current_page',
      pageEffect: 'none',
    },
    replyTo: 'env-identity.read_current',
  }]);
});

test('unsupported Facebook commands are rejected before Native/CDP dispatch', async () => {
  const h = harness(async () => assert.fail('unsupported command must not reach Native runtime'), {
    platform: 'facebook',
  });
  await h.session.onCloudCommand(envelope('profile.open', {
    authorId: '61591824155856',
    direct: true,
  }));
  await h.session.onCloudCommand(envelope('interaction.like_comment', {
    noteId: 'post-1',
    commentAnchorId: 'comment-1',
  }));
  await h.session.onCloudCommand(envelope('note.browse_images', { noteId: 'post-1', count: 2 }));
  await h.session.onCloudCommand(envelope('note.scroll_comments', { noteId: 'post-1' }));
  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.actions, [
    { action: 'profile_open', ok: false, reason: 'capability_unsupported' },
    { action: 'comment_like', ok: false, reason: 'capability_unsupported' },
    { action: 'browse_images', ok: false, reason: 'capability_unsupported' },
    { action: 'scroll_comments', ok: false, reason: 'capability_unsupported' },
  ]);
});

test('Native Facebook action receipt logs bounded terminal phase and reason without payload content', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'not_started',
    reasonCode: 'like_button_not_found',
    output: {
      kind: 'action_receipt',
      value: {
        action: 'like',
        ok: false,
        reason: 'like button not found / secret page text',
      },
    },
  }), { platform: 'facebook' });

  await h.session.onCloudCommand(envelope('interaction.like', {
    noteId: 'https://www.facebook.com/reel/777',
  }));

  assert.deepEqual(h.actions, [{
    action: 'like',
    ok: false,
    reason: 'like button not found / secret page text',
  }]);
  assert.equal(
    h.logs.find((line) => line.includes('action.completed')),
    '[native-page] action.completed action=like ok=false effectPhase=not_started reason=non_token_reason',
  );
  assert.equal(h.logs.some((line) => line.includes('https://')), false);
});

test('Native Facebook promotes a Rust groupObservation when generic observation is serialized as null', async () => {
  const groupObservation = {
    groupUrl: 'https://www.facebook.com/groups/42',
    title: 'Target group',
    documentReady: 'complete',
    scopeResolved: true,
    joinCtaPresent: true,
  };
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: {
      kind: 'action_receipt',
      value: {
        action: 'join_group',
        ok: false,
        reason: 'observation_only',
        observation: null,
        groupObservation,
        groupUrl: groupObservation.groupUrl,
        clicked: false,
      },
    },
  }), { platform: 'facebook' });

  await h.session.onCloudCommand(envelope('group.join', {
    taskId: 'task-join-observe',
    groupUrl: groupObservation.groupUrl,
    click: false,
  }));

  assert.deepEqual(h.actions, [{
    action: 'join_group',
    ok: false,
    reason: 'observation_only',
    observation: groupObservation,
    groupUrl: groupObservation.groupUrl,
    clicked: false,
  }]);
  assert.equal('groupObservation' in h.actions[0]!, false);
});

test('Native Facebook keeps an existing generic observation authoritative over groupObservation', async () => {
  const observation = { source: 'generic' };
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: {
      kind: 'action_receipt',
      value: {
        action: 'join_group',
        ok: false,
        reason: 'observation_only',
        observation,
        groupObservation: { source: 'group' },
        clicked: false,
      },
    },
  }), { platform: 'facebook' });

  await h.session.onCloudCommand(envelope('group.join', {
    taskId: 'task-join-observe-existing',
    groupUrl: 'https://www.facebook.com/groups/42',
    click: false,
  }));

  assert.deepEqual(h.actions[0]?.observation, observation);
  assert.equal('groupObservation' in h.actions[0]!, false);
});

test('Native Facebook keeps Join, comments, and ordinary refresh on their command-specific budgets', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: {
      kind: 'action_receipt',
      value: {
        action: 'join_group',
        ok: false,
        reason: 'observation_only',
        groupUrl: 'https://www.facebook.com/groups/42',
        clicked: false,
      },
    },
  }), { platform: 'facebook' });

  await h.session.onCloudCommand(envelope('group.join', {
    groupUrl: 'https://www.facebook.com/groups/42',
  }));
  await h.session.onCloudCommand(envelope('interaction.comment', {
    noteId: 'https://www.facebook.com/groups/42/posts/7',
    text: 'x'.repeat(100),
    groupChatCode: 'Zalo:123',
  }));
  await h.session.onCloudCommand(envelope('interaction.comment', {
    noteId: 'https://www.facebook.com/groups/42/posts/8',
    text: 'x'.repeat(400),
  }));
  await h.session.onCloudCommand(envelope('feed.refresh', { reason: 'ordinary' }));

  // 2026-07-29 Facebook 时间预算整体 ×1.5、评论上限单独取 180s。
  // 评论按 code point 算「正文 + 换行 + 联系方式」：100+1+8=109 → 27_000 + 330×109 = 62_970，减回执余量 2_000。
  // 第二条 400 字符无联系方式 → 27_000 + 330×400 = 159_000，减 2_000。
  assert.equal(h.executions[0]?.command.kind, 'group_join');
  assert.equal(h.executions[0]?.timeoutMs, 135_000);
  assert.equal(h.executions[1]?.command.kind, 'interaction_comment');
  assert.equal(h.executions[1]?.timeoutMs, 60_970);
  assert.equal(h.executions[2]?.command.kind, 'interaction_comment');
  assert.equal(h.executions[2]?.timeoutMs, 157_000);
  assert.equal(h.executions[3]?.timeoutMs, 45_000);
});

test('Native Facebook gives the first-post open its own long budget; 普通开帖仍取默认', async () => {
  // 首帖开帖内部是一串串行有界窗（就绪 8s + 四轮下滚 + 可选二次导航就绪 8s + 绑定 12s + 身份回读 20s）。
  // 沿用默认 30s ⇒ 外层先到点，把边端一个具名失败改判成合成失败：只放宽内层窗口等于没改。
  const h = harness(async () => ({
    ok: false,
    effectPhase: 'not_started',
    reasonCode: 'target_context_mismatch',
    output: {
      kind: 'action_receipt',
      value: { action: 'open_note', ok: false, reason: 'target_context_mismatch' },
    },
  }), { platform: 'facebook' });

  await h.session.onCloudCommand(envelope('note.open', {
    selection: 'first_commentable_group_post',
    container: 'https://www.facebook.com/groups/42',
  }));
  await h.session.onCloudCommand(envelope('note.open', {
    url: 'https://www.facebook.com/groups/42/posts/7',
  }));

  assert.equal(h.executions[0]?.command.kind, 'note_open');
  assert.equal(h.executions[0]?.timeoutMs, 135_000, '首帖开帖必须拿到长预算');
  assert.equal(h.executions[1]?.command.kind, 'note_open');
  assert.ok(
    (h.executions[1]?.timeoutMs ?? 0) < (h.executions[0]?.timeoutMs ?? 0),
    '按 URL 开帖走默认档，必须明显短于首帖那条专属预算',
  );
});

test('Native Facebook forwards the exact Join commit window to the shared coordinator guard', async () => {
  let now = 1_000;
  const guard = new CommitWindowGuard(() => now);
  const h = harness(async (
    _ownerId,
    command,
    _timeoutMs,
    _signal,
    commitWindowHandler,
  ) => {
    assert.equal(command.kind, 'group_join');
    assert.ok(commitWindowHandler);
    const dispose = commitWindowHandler({
      sessionId: 'facebook-session',
      taskId: 'task-join-window',
      commandId: 1,
      token: 'cw_1_1',
      label: 'fb_join_click',
      budgetMs: 18_500,
    });
    assert.equal(guard.isOpen(), true);
    assert.equal(guard.label, 'fb_join_click');
    assert.equal(guard.remainingMs(), 18_500);
    now += 500;
    dispose();
    assert.equal(guard.isOpen(), false);
    return {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: {
        kind: 'action_receipt',
        value: { action: 'join_group', ok: true, clicked: true },
      },
    };
  }, {
    platform: 'facebook',
    commitWindow: guard,
  });

  await h.session.onCloudCommand(envelope('group.join', {
    taskId: 'task-join-window',
    groupUrl: 'https://www.facebook.com/groups/42',
    click: true,
  }));
  assert.equal(h.actions[0]?.ok, true);
});

test('Native Facebook probe reports sustained unknown blockers with same-source evidence', async () => {
  const h = harness(async () => assert.fail('probe transition test does not execute runtime'), {
    platform: 'facebook',
    accountId: '61591824155856',
    overlayConfirmMs: 0,
  });
  const observe = (h.session as unknown as {
    observeFacebookProbe(value: Record<string, unknown>): void;
  }).observeFacebookProbe.bind(h.session);

  observe({
    origin: 'https://www.facebook.com',
    path: '/',
    pageKind: 'unknown',
    blockingKind: 'unknown',
    blockingText: 'We limit how often you can do this.',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const detected = h.sent.find((entry) => entry.type === 'risk.captcha_detected');
  assert.deepEqual(detected?.payload, {
    edgeId: undefined,
    accountId: '61591824155856',
    kind: 'unknown',
    url: 'https://www.facebook.com/',
    overlay: {
      kind: 'unknown',
      firstDetectedUrl: 'https://www.facebook.com/',
      capturedAt: (detected?.payload as { overlay?: { capturedAt?: number } })?.overlay?.capturedAt,
      text: 'We limit how often you can do this.',
      candidates: [],
    },
    reason: 'native_page_probe',
  });

  observe({
    origin: 'https://www.facebook.com',
    path: '/',
    pageKind: 'home',
    blockingKind: 'none',
  });
  assert.equal(h.sent.filter((entry) => entry.type === 'risk.captcha_cleared').length, 1);
});

test('quiesced Native session admits the coordinator-owned task command', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'page_cards', value: { cards: [{ index: 0, title: 'result' }] } },
  }));
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('search.execute', searchPayload));

  assert.equal(h.executions.length, 1);
  assert.equal(h.executions[0]?.ownerId, searchPayload.taskId);
  assert.equal(h.executions[0]?.command.kind, 'search_execute');
  assert.equal(h.cards.length, 1);
  assert.equal(h.actions.length, 1);
  assert.deepEqual(h.actions[0], {
    action: 'search',
    ok: true,
    activityId: searchPayload.activityId,
    purpose: searchPayload.purpose,
    scope: searchPayload.scope,
    actuated: true,
    searchOutcome: 'results_ready',
    resultCount: 1,
  });
});

test('quiesced Native session rejects ordinary browse without touching runtime', async () => {
  const h = harness(async () => assert.fail('runtime must not execute ordinary browse while quiesced'));
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'ordinary' }));

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.actions, [{ action: 'scroll', ok: false, reason: 'native_session_quiesced' }]);
});

test('pre-actuation Native search rejection keeps one valid correlated terminal', async () => {
  const h = harness(async () => assert.fail('runtime must not execute an unowned search while quiesced'));
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('search.execute', {
    ...searchPayload,
    taskId: undefined,
  }));

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.actions, [{
    action: 'search',
    ok: false,
    reason: 'native_session_quiesced',
    activityId: searchPayload.activityId,
    purpose: searchPayload.purpose,
    scope: searchPayload.scope,
    actuated: false,
    searchOutcome: 'not_submitted',
  }]);
});

test('Native empty search cards report no_results exactly once', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'page_cards', value: { cards: [] } },
  }));
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('search.execute', searchPayload));

  assert.equal(h.cards.length, 1);
  assert.deepEqual(h.actions, [{
    action: 'search',
    ok: true,
    activityId: searchPayload.activityId,
    purpose: searchPayload.purpose,
    scope: searchPayload.scope,
    actuated: true,
    searchOutcome: 'no_results',
    resultCount: 0,
  }]);
});

test('Native non-confirmed search cards never upgrade the action to success', async () => {
  const h = harness(async () => ({
    ok: false,
    effectPhase: 'ambiguous',
    reasonCode: 'search_submit_unconfirmed',
    output: { kind: 'page_cards', value: { cards: [{ index: 0, title: 'unconfirmed result' }] } },
  }));
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('search.execute', searchPayload));

  assert.equal(h.cards.length, 1, 'observed cards may still be forwarded as observations');
  assert.deepEqual(h.actions, [{
    action: 'search',
    ok: false,
    reason: 'search_submit_unconfirmed',
    activityId: searchPayload.activityId,
    purpose: searchPayload.purpose,
    scope: searchPayload.scope,
    actuated: true,
    searchOutcome: 'failed_after_submit',
  }]);
});

test('Native action receipt failure falls back to the execution reason code', async () => {
  const h = harness(async () => ({
    ok: false,
    effectPhase: 'ambiguous',
    reasonCode: 'submitted_unconfirmed',
    output: { kind: 'action_receipt', value: { action: 'like', ok: true } },
  }));

  await h.session.onCloudCommand(envelope('interaction.like', { noteId: 'note-1' }));

  assert.deepEqual(h.actions, [{ action: 'like', ok: false, reason: 'submitted_unconfirmed' }]);
});

test('Native search execution error preserves effect-phase honesty and correlation', async () => {
  const error = Object.assign(new Error('CDP execution failed'), {
    code: 'cdp_error',
    detail: { effectPhase: 'ambiguous' },
  });
  const h = harness(async () => { throw error; });
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('search.execute', searchPayload));

  assert.equal(h.actions.length, 1);
  assert.deepEqual(h.actions[0], {
    action: 'search',
    ok: false,
    reason: 'native_effect_ambiguous',
    activityId: searchPayload.activityId,
    purpose: searchPayload.purpose,
    scope: searchPayload.scope,
    actuated: true,
    searchOutcome: 'failed_after_submit',
  });
});

function cardsExecution(listKind: 'feed' | 'reels' = 'feed'): NativePageCommandExecution {
  return {
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: {
      kind: 'page_cards',
      value: {
        cards: [{ index: 0, title: 'visible card', likeCount: 0, collectCount: 0 }],
        listKind,
      },
    },
  };
}

test('Native Facebook projects each canonical single-card Reel once and suppresses matching detail activity', async () => {
  const reel = {
    index: 0,
    title: 'first reel summary',
    author: 'Bao',
    likeCount: 0,
    collectCount: 0,
    noteId: 'https://www.facebook.com/reel/333',
    isVideo: true,
  };
  const detail: NoteDetailPayload = {
    noteId: 'https://www.facebook.com/reel/333/',
    title: '',
    content: 'first reel summary',
    author: 'Bao',
    likeCount: 0,
    collectCount: 0,
    mediaType: 'video',
  };
  const results: NativePageCommandExecution[] = [
    {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: {
        kind: 'page_cards',
        value: {
          cards: [{ ...reel, noteId: 'https://www.facebook.com/reel/333/' }],
          listKind: 'reels',
        },
      },
    },
    {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: { kind: 'page_cards', value: { cards: [reel], listKind: 'reels' } },
    },
    {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: { kind: 'note_detail', value: detail },
    },
  ];
  const h = harness(async () => results.shift() ?? assert.fail('unexpected Native execution'), {
    platform: 'facebook',
  });

  await h.session.start();
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  await h.session.onCloudCommand(envelope('note.open', { noteId: reel.noteId }));

  const activities = uiEvents(h.logs).filter((event) => event.kind === 'activity');
  assert.deepEqual(activities, [{
    kind: 'activity',
    type: 'reel_view',
    sentence: '看了「first reel summary」 · Bao',
    loopStage: 'read',
    statsDelta: { views: 1 },
  }]);
  assert.deepEqual(h.details, [detail], 'detail data still reaches Cloud');
});

test('Native Facebook does not project malformed or multi-card Reels batches', async () => {
  const reel = (noteId: string, index = 0) => ({
    index,
    title: 'reel',
    author: 'A',
    likeCount: 0,
    collectCount: 0,
    noteId,
    isVideo: true,
  });
  const batches = [
    {
      cards: [
        reel('https://www.facebook.com/reel/1'),
        reel('https://www.facebook.com/reel/2', 1),
      ],
      listKind: 'reels' as const,
    },
    {
      cards: [reel('https://www.facebook.com/profile.php?id=3')],
      listKind: 'reels' as const,
    },
    {
      cards: [reel('https://evil.example/reel/3')],
      listKind: 'reels' as const,
    },
    {
      cards: [reel('https://www.facebook.com/reel/hashtag')],
      listKind: 'reels' as const,
    },
    {
      cards: [reel('https://www.facebook.com/Example/posts/3')],
      listKind: 'reels' as const,
    },
  ];
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'page_cards', value: batches.shift() ?? assert.fail('unexpected Native execution') },
  }), { platform: 'facebook' });

  await h.session.start();
  while (batches.length > 0) {
    await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  }

  assert.equal(uiEvents(h.logs).some((event) => event.type === 'reel_view'), false);
});

test('Native Facebook keeps Reel projection witnesses across task resume and resets them for a new session', async () => {
  const reel = {
    index: 0,
    title: 'session reel',
    author: 'Bao',
    likeCount: 0,
    collectCount: 0,
    noteId: 'https://www.facebook.com/reel/444',
    isVideo: true,
  };
  const execution: NativePageCommandExecution = {
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'page_cards', value: { cards: [reel], listKind: 'reels' } },
  };
  const first = harness(async () => execution, { platform: 'facebook' });

  await first.session.start();
  await first.session.quiesceForTask();
  await first.session.resumeAfterTask();

  assert.equal(uiEvents(first.logs).filter((event) => event.type === 'reel_view').length, 1);
  first.session.close();

  const second = harness(async () => execution, { platform: 'facebook' });
  await second.session.start();

  assert.equal(uiEvents(second.logs).filter((event) => event.type === 'reel_view').length, 1);
  second.session.close();
});

test('Native Facebook task resume preserves the current page until the next deliberate command', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'page_cards', value: { cards: [], listKind: 'feed' } },
  }), { platform: 'facebook' });

  await h.session.start();
  await h.session.quiesceForTask();
  await h.session.resumeAfterTask();

  assert.deepEqual(
    h.executions.map((execution) => execution.command.kind),
    ['browse_scroll'],
    'task release must not issue another initial_scan that navigates Facebook home',
  );
  assert.equal(h.executions[0]?.timeoutMs, 180_000, 'initial Feed scroll uses the long budget');

  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  assert.equal(h.executions.at(-1)?.command.kind, 'page_scroll', 'resume still unblocks the next explicit command');
  assert.equal(h.executions.at(-1)?.timeoutMs, 180_000, 'explicit Feed scroll uses the long budget');
  h.session.close();
});

test('Native Xiaohongshu task resume keeps the existing initial-scan restart behavior', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'page_cards', value: { cards: [], listKind: 'feed' } },
  }), { platform: 'xiaohongshu' });

  await h.session.start();
  await h.session.quiesceForTask();
  await h.session.resumeAfterTask();

  assert.deepEqual(
    h.executions.map((execution) => execution.command.kind),
    ['browse_scroll', 'browse_scroll'],
  );
  h.session.close();
});

test('Native Facebook projects a unique canonical Feed video once even beside non-video cards', async () => {
  const video = {
    index: 1,
    title: 'Hành trình đi tìm vợ con…',
    author: 'BHD Movies',
    likeCount: 12,
    collectCount: 0,
    noteId: 'https://www.facebook.com/watch?v=1547652190157533',
    isVideo: true,
  };
  const batch = {
    cards: [
      {
        index: 0,
        title: 'ordinary post',
        author: 'Text Author',
        likeCount: 0,
        collectCount: 0,
        noteId: 'https://www.facebook.com/Text/posts/111',
        isVideo: false,
      },
      video,
    ],
    listKind: 'feed' as const,
  };
  const detail: NoteDetailPayload = {
    noteId: video.noteId,
    title: '',
    content: video.title,
    author: video.author,
    likeCount: video.likeCount,
    collectCount: 0,
    mediaType: 'video',
  };
  const results: NativePageCommandExecution[] = [
    {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: {
        kind: 'page_cards',
        value: {
          ...batch,
          cards: batch.cards.map((card) => (
            card === video
              ? { ...card, noteId: 'https://www.facebook.com/BHD/videos/1547652190157533' }
              : card
          )),
        },
      },
    },
    {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: { kind: 'page_cards', value: batch },
    },
    {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      output: { kind: 'note_detail', value: detail },
    },
  ];
  const h = harness(async () => results.shift() ?? assert.fail('unexpected Native execution'), {
    platform: 'facebook',
  });

  await h.session.start();
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  await h.session.onCloudCommand(envelope('note.open', { noteId: video.noteId }));

  const activities = uiEvents(h.logs).filter((event) => event.kind === 'activity');
  assert.deepEqual(
    activities,
    [{
      kind: 'activity',
      type: 'feed_video_view',
      sentence: '看了「Hành trình đi tìm vợ con…」 · BHD Movies',
      loopStage: 'read',
      statsDelta: { views: 1 },
    }],
  );
  assert.deepEqual(h.details, [detail], 'matching Feed-video detail still reaches Cloud');
});

test('Native Facebook does not project ordinary or ambiguous Feed batches as video views', async () => {
  const video = (noteId: string, index = 0) => ({
    index,
    title: 'video',
    author: 'A',
    likeCount: 0,
    collectCount: 0,
    noteId,
    isVideo: true,
  });
  const batches = [
    {
      cards: [{ ...video('https://www.facebook.com/watch?v=1'), isVideo: false }],
      listKind: 'feed' as const,
    },
    {
      cards: [
        video('https://www.facebook.com/watch?v=2'),
        video('https://www.facebook.com/watch?v=3', 1),
      ],
      listKind: 'feed' as const,
    },
    {
      cards: [video('https://evil.example/watch?v=4')],
      listKind: 'feed' as const,
    },
    {
      cards: [video('https://www.facebook.com/reel/5')],
      listKind: 'feed' as const,
    },
  ];
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'page_cards', value: batches.shift() ?? assert.fail('unexpected Native execution') },
  }), { platform: 'facebook' });

  await h.session.start();
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));

  assert.equal(uiEvents(h.logs).some((event) => event.type === 'feed_video_view'), false);
});

test('Native Facebook keeps the existing local read activity for unmatched detail', async () => {
  const detail: NoteDetailPayload = {
    noteId: 'https://www.facebook.com/Example/posts/999',
    title: '',
    content: 'ordinary detail',
    author: 'Lan',
    likeCount: 1,
    collectCount: 0,
  };
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'note_detail', value: detail },
  }), { platform: 'facebook' });

  await h.session.onCloudCommand(envelope('note.open', { noteId: detail.noteId }));

  assert.deepEqual(
    uiEvents(h.logs).filter((event) => event.type === 'note_open'),
    [{
      kind: 'activity',
      type: 'note_open',
      sentence: '打开「ordinary detail」 · Lan',
      presence: '正在读 Lan 的「ordinary detail」…',
      loopStage: 'read',
      statsDelta: { views: 1 },
    }],
  );
  assert.deepEqual(h.details, [detail]);
});

test('Native Facebook page.scroll waits only the remaining jittered dwell', async () => {
  let now = 1_000;
  const waits: number[] = [];
  const h = harness(async () => cardsExecution('reels'), {
    platform: 'facebook',
    clock: () => now,
    random: () => 0.25,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  await h.session.start();
  now = 2_000;

  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll', dwellMs: 7_000 }));

  assert.deepEqual(waits, [6_000]);
  assert.equal(h.executions.at(-1)?.command.kind, 'page_scroll');
});

test('Native Facebook page.scroll absorbs elapsed evaluation time and ignores missing dwell', async () => {
  let now = 1_000;
  const waits: number[] = [];
  const h = harness(async () => cardsExecution(), {
    platform: 'facebook',
    clock: () => now,
    random: () => 0.25,
    sleep: async (ms) => { waits.push(ms); },
  });
  await h.session.start();
  now = 9_000;

  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll', dwellMs: 7_000 }));
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));

  assert.deepEqual(waits, []);
  assert.equal(h.executions.length, 3);
});

// 这条用例原本断言「小红书 page.scroll 不使用停留锚点」——它编码的是**被修掉的缺陷本身**
// （change restore-native-actuation-humanization-and-locating 任务 4.6：翻页停留曾整段包在
// Facebook 判据里，小红书全线失效，而退役的小红书实现本来就有这一段）。改成锁真正的不变量：
// 锚点与平台无关；不等的条件是「缺锚点」或「缺中心值」，不是「平台不是 Facebook」。
test('Native Xiaohongshu page.scroll uses the same platform-neutral dwell anchor', async () => {
  const waits: number[] = [];
  const h = harness(async () => cardsExecution(), {
    platform: 'xiaohongshu',
    clock: () => 1_000,
    random: () => 0.25,
    sleep: async (ms) => { waits.push(ms); },
  });

  // 还没有任何一批卡到达 ⇒ 无锚点，不凭空补停留。
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll', dwellMs: 7_000 }));
  assert.deepEqual(waits, []);

  await h.session.start(); // 首屏扫描回 page.cards ⇒ 立下锚点
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll', dwellMs: 7_000 }));
  assert.deepEqual(waits, [7_000]);

  // 云端没给中心值（返回未刷新 / 旧云端 / 断连）⇒ 立即翻页、不额外等待。
  waits.length = 0;
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));
  assert.deepEqual(waits, []);
});

test('Native Facebook dwell wait is cancelled before runtime actuation', async () => {
  let releaseWait: (() => void) | undefined;
  const enteredWait = new Promise<void>((resolve) => { releaseWait = resolve; });
  const h = harness(async () => cardsExecution('reels'), {
    platform: 'facebook',
    clock: () => 1_000,
    random: () => 0.25,
    sleep: (_ms, signal) => new Promise((_resolve, reject) => {
      releaseWait?.();
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'aborted' })), { once: true });
      if (signal?.aborted) reject(Object.assign(new Error('cancelled'), { code: 'aborted' }));
    }),
  });
  await h.session.start();

  const pending = h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll', dwellMs: 7_000 }));
  await enteredWait;
  h.session.stop();
  await pending;

  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.actions.at(-1), { action: 'scroll', ok: false, reason: 'aborted' });
});

// ─────────── 节奏字段的实际消费（change restore-native-facebook-inline-expand-read）───────────
// 判据是「有没有真的等」，不是「字段有没有被映射进 payload」——收下即丢弃正是这次要修的回归。

test('Native command honours the cloud thinkMs before touching the page', async () => {
  const waits: number[] = [];
  const h = harness(async () => cardsExecution(), {
    platform: 'facebook',
    clock: () => 1_000,
    random: () => 0.25,
    sleep: async (ms) => { waits.push(ms); },
  });

  await h.session.onCloudCommand(envelope('interaction.like', { noteId: 'https://www.facebook.com/A/posts/1', thinkMs: 2_400 }));

  assert.deepEqual(waits, [2_400]);
  assert.equal(h.executions.length, 1);
});

test('Native in-place read floor and cloud dwell take the larger, never the sum', async () => {
  let now = 1_000;
  const waits: number[] = [];
  const detail: NoteDetailPayload = {
    noteId: 'https://www.facebook.com/Example/posts/777',
    title: '',
    content: 'x'.repeat(200), // read floor = 1200 + 200*20 = 5200ms
    author: 'Lan',
    likeCount: 0,
    collectCount: 0,
  };
  const h = harness(async (_owner, command) => (command.kind === 'note_open'
    ? { ok: true, effectPhase: 'confirmed', reasonCode: 'confirmed', output: { kind: 'note_detail', value: detail } }
    : cardsExecution()), {
    platform: 'facebook',
    clock: () => now,
    random: () => 0.25,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  await h.session.start();       // 立下「本批卡到达」锚点（now=1000）
  await h.session.onCloudCommand(envelope('note.open', { noteId: detail.noteId, surface: 'feed' }));
  now = 2_000;                   // 就地读花掉 1s
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll', dwellMs: 3_000 }));

  // dwell 剩余 = 3000-(2000-1000) = 2000；read floor 剩余 = 5200-(2000-1000) = 4200 ⇒ 取 4200，不是 6200。
  assert.deepEqual(waits, [4_200]);
});

test('A short in-place read still gets a floor instead of a zero-delay scroll', async () => {
  let now = 1_000;
  const waits: number[] = [];
  const detail: NoteDetailPayload = {
    noteId: 'https://www.facebook.com/Example/posts/778',
    title: '',
    content: 'hi', // read floor = 1200 + 2*20 = 1240ms
    author: 'Lan',
    likeCount: 0,
    collectCount: 0,
  };
  const h = harness(async (_owner, command) => (command.kind === 'note_open'
    ? { ok: true, effectPhase: 'confirmed', reasonCode: 'confirmed', output: { kind: 'note_detail', value: detail } }
    : cardsExecution()), {
    platform: 'facebook',
    clock: () => now,
    random: () => 0.25,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  await h.session.onCloudCommand(envelope('note.open', { noteId: detail.noteId, surface: 'feed' }));
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' })); // 云端没给 dwell

  assert.deepEqual(waits, [1_240]);
});

test('A failed in-place read leaves no read floor behind', async () => {
  let now = 1_000;
  const waits: number[] = [];
  const h = harness(async (_owner, command) => (command.kind === 'note_open'
    ? {
        ok: false,
        effectPhase: 'not_started' as const,
        reasonCode: 'expand_no_effect',
        output: { kind: 'action_receipt', value: { action: 'open_note', ok: false, reason: 'expand_no_effect' } },
      }
    : cardsExecution()), {
    platform: 'facebook',
    clock: () => now,
    random: () => 0.25,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  await h.session.onCloudCommand(envelope('note.open', { noteId: 'https://www.facebook.com/Example/posts/779', surface: 'feed' }));
  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll' }));

  assert.deepEqual(waits, []);
});

test('A drained Native session never re-arms its probe from an in-flight probe', async () => {
  let releaseProbe: () => void = () => undefined;
  const inFlight = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let probeStarted = 0;
  let probeArrived: () => void = () => undefined;
  const firstProbe = new Promise<void>((resolve) => { probeArrived = resolve; });

  const h = harness(async (_owner, command) => {
    if (command.kind !== 'page_probe') return cardsExecution();
    probeStarted += 1;
    probeArrived();
    await inFlight;
    return {
      ok: true,
      effectPhase: 'confirmed' as const,
      reasonCode: 'confirmed',
      output: { kind: 'page_probe', value: { pageKind: 'feed' } },
    };
  }, { probeIntervalMs: 1 });

  await h.session.start();
  await firstProbe;
  assert.equal(probeStarted, 1, '会话起来后必须真的开始周期观测');

  // 停手发生在探测「已发出、未返回」的窗口里：定时器被清掉了，但在途的那一次仍会走到
  // 它的收尾分支。收尾分支若照旧重新武装，探针就会对着一条已停手（乃至已 detach）的
  // 连接一直空轮询下去。
  await h.session.stopAndWait(50);
  releaseProbe();
  await inFlight;
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(probeStarted, 1, '停手之后不得再武装出任何一次探测');
});
