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
} from '../../src/native-page-engine/client.js';
import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

function envelope<T extends MessageType>(type: T, payload: Record<string, unknown>): Envelope {
  return { v: 2, type, id: `env-${type}`, ts: Date.now(), payload } as Envelope;
}

function harness(execute: (
  ownerId: string,
  command: NativePageCommand,
  timeoutMs?: number,
) => Promise<NativePageCommandExecution>, options: {
  platform?: 'xiaohongshu' | 'facebook';
  accountId?: string;
  clock?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  overlayConfirmMs?: number;
} = {}) {
  const executions: Array<{ ownerId: string; command: NativePageCommand; timeoutMs?: number }> = [];
  const actions: ActionCompletedPayload[] = [];
  const cards: PageCardsPayload[] = [];
  const details: NoteDetailPayload[] = [];
  const closedOwners: string[] = [];
  const logs: string[] = [];
  const sent: Array<{ type: string; payload: unknown; replyTo?: string }> = [];
  const runtime = {
    async execute(ownerId: string, command: NativePageCommand, timeoutMs?: number) {
      executions.push({ ownerId, command, timeoutMs });
      return execute(ownerId, command, timeoutMs);
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

test('Native Facebook group join alone receives the established 90-second command budget', async () => {
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
  await h.session.onCloudCommand(envelope('feed.refresh', { reason: 'ordinary' }));

  assert.equal(h.executions[0]?.command.kind, 'group_join');
  assert.equal(h.executions[0]?.timeoutMs, 90_000);
  assert.equal(h.executions[1]?.timeoutMs, 30_000);
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

test('Native Xiaohongshu page.scroll does not use the Facebook dwell anchor', async () => {
  const waits: number[] = [];
  const h = harness(async () => cardsExecution(), {
    platform: 'xiaohongshu',
    clock: () => 1_000,
    random: () => 0.25,
    sleep: async (ms) => { waits.push(ms); },
  });
  await h.session.start();

  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'feed_scroll', dwellMs: 7_000 }));

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
