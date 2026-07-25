import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FacebookBrowseSession,
  facebookActionNameForCommand,
  usesFacebookBrowseSession,
  refreshReloadAllowed,
  type FacebookBrowseSessionDeps,
  type FacebookBrowseMode,
} from '../../src/facebook/facebook-session.js';
import { FacebookCommentHandler } from '../../src/facebook/comment-handler.js';
import { FacebookCommentExecutor } from '../../src/facebook/comment-executor.js';
import type {
  FacebookFeedReader,
  FacebookFeedCard,
  FacebookFeedSettleResult,
  FacebookHomeFeedStateResult,
  FacebookHomeRefreshResult,
} from '../../src/facebook/feed-reader.js';
import type { FacebookPostReader, FacebookPostDetail } from '../../src/facebook/post-reader.js';
import type { FacebookLikeExecutor, FacebookLikeResult } from '../../src/facebook/like-executor.js';
import type {
  FacebookReelsReader,
  FacebookReelCard,
  FacebookReelFollowResult,
  FacebookReelsEntryResult,
} from '../../src/facebook/reels-reader.js';
import { selectPlatformDriver } from '../../src/platform/index.js';
import type { Envelope, ActionCompletedPayload, NoteDetailPayload, PageCardsPayload, ProfileDetailPayload } from '../../src/comm/protocol.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

function makeEnv(type: string, payload: unknown = {}): Envelope {
  return { v: 2, type, id: `cmd-${type}`, ts: 0, payload } as unknown as Envelope;
}

interface Harness {
  session: FacebookBrowseSession;
  cards: PageCardsPayload[];
  details: NoteDetailPayload[];
  profiles: ProfileDetailPayload[];
  actions: ActionCompletedPayload[];
  logs: string[];
  delegated: Envelope[];
  ensureCalls: number;
  ensureUrls: string[];
  scanCalls: number;
  scrollCalls: number;
  likeShadowFlags: Array<boolean | undefined>;
  reelFollowCalls: Array<{ noteId: string; shadow: boolean }>;
  reelNextCalls: string[];
}

function makeSession(opts: {
  mode?: FacebookBrowseMode;
  commandTimeoutMs?: number;
  card?: FacebookFeedCard;
  detail?: Partial<FacebookPostDetail>;
  like?: (shadow?: boolean) => FacebookLikeResult;
  cardBatches?: FacebookFeedCard[][];
  settleBatches?: FacebookFeedSettleResult[];
  scrollMetrics?: { scrollY: number; scrollHeight: number; innerHeight: number };
  scrollMetricsBatches?: Array<{ scrollY: number; scrollHeight: number; innerHeight: number }>;
  clickHome?: FacebookHomeRefreshResult;
  sleep?: (ms: number) => Promise<void>;
  hangOpen?: boolean;
  /** 卡住的读帖执行体等这个 promise 才结束——用来造「孤儿写者在下一条命令跑到一半时才 settle」。 */
  hangOpenUntil?: Promise<void>;
  cdpSend?: BrowseCdp['send'];
  commentHandler?: FacebookCommentHandler;
  homeState?: FacebookHomeFeedStateResult;
  reelCards?: FacebookReelCard[];
  reelEntry?: FacebookReelsEntryResult;
  reelSettles?: Array<FacebookReelCard | null>;
  reelFollow?: (noteId: string, shadow: boolean) => FacebookReelFollowResult;
} = {}): Harness {
  const cards: PageCardsPayload[] = [];
  const details: NoteDetailPayload[] = [];
  const profiles: ProfileDetailPayload[] = [];
  const actions: ActionCompletedPayload[] = [];
  const logs: string[] = [];
  const delegated: Envelope[] = [];
  const likeShadowFlags: Array<boolean | undefined> = [];
  const reelFollowCalls: Array<{ noteId: string; shadow: boolean }> = [];
  const state = { ensureCalls: 0, ensureUrls: [] as string[], scanCalls: 0, scrollCalls: 0 };

  const card: FacebookFeedCard = opts.card ?? {
    index: 0,
    noteId: 'https://www.facebook.com/a/posts/pfbid0ONE',
    author: 'Alice',
    textPreview: 'hi there',
    reactionCount: 5,
    isVideo: false,
  };

  const client = {
    reportPageCards(p: PageCardsPayload) {
      cards.push(p);
    },
    reportNoteDetail(p: NoteDetailPayload) {
      details.push(p);
    },
    reportProfileDetail(p: ProfileDetailPayload) {
      profiles.push(p);
    },
    reportActionCompleted(p: ActionCompletedPayload) {
      actions.push(p);
    },
  };
  const commentHandler =
    opts.commentHandler ??
    ({
      handle: async (env: Envelope) => {
        delegated.push(env);
      },
    } as unknown as FacebookCommentHandler);
  const feedReader = {
    ensureFeed: async (url: string, onNavigate?: () => void) => {
      state.ensureCalls++;
      state.ensureUrls.push(url);
      if (url.includes('/search/')) onNavigate?.();
      return { ok: true as const, navigated: url.includes('/search/') };
    },
    probeSurface: async () => ({
      href: state.ensureUrls.at(-1) ?? 'https://www.facebook.com/',
      surface: state.ensureUrls.at(-1)?.includes('/search/') ? 'search' : 'home',
      hasFeed: true,
      hydratedArticles: 1,
      dialogOpen: false,
      homeReady: true,
    }),
    scanCards: async () => {
      state.scanCalls++;
      if (opts.cardBatches) return opts.cardBatches.shift() ?? [];
      return [card];
    },
    scrollNext: async () => {
      state.scrollCalls++;
    },
    // 默认「未接近底部、高度稳定」——无新卡时循环继续下滚（对齐懒加载感知的续滚意图）；
    // 需要触发「真到底 → feed_exhausted」的用例可用 opts.scrollMetricsBatches 逐轮喂到底状态。
    scrollMetrics: async () => {
      if (opts.scrollMetricsBatches) return opts.scrollMetricsBatches.shift() ?? { scrollY: 5000, scrollHeight: 5900, innerHeight: 900 };
      return opts.scrollMetrics ?? { scrollY: 0, scrollHeight: 5000, innerHeight: 900 };
    },
    settleCards: async () => {
      if (opts.settleBatches) return opts.settleBatches.shift() ?? { cards: [], degraded: false, reason: 'no_feed' as const };
      return { cards: [card], degraded: false };
    },
    clickHomeAndScrollTop: async () => opts.clickHome ?? { ok: true as const },
    confirmHomeEmpty: async () => opts.homeState ?? { state: 'feed_unknown' as const },
  } as unknown as FacebookFeedReader;
  const postReader = {
    openAndRead: async (permalink: string): Promise<FacebookPostDetail> => {
      // 等门（可选）：命令已超时放行串行链、执行体仍在飞 = 孤儿写者；门一开它才 settle。
      if (opts.hangOpenUntil) await opts.hangOpenUntil;
      if (opts.hangOpen) return new Promise<FacebookPostDetail>(() => {}); // 永不 resolve → 触发超时兜底
      return {
        ok: true,
        permalink,
        body: 'the post body',
        comments: ['c1', 'c2'],
        reactionCount: 5,
        commentCount: 2,
        isVideo: false,
        author: 'Alice',
        ...opts.detail,
      };
    },
  } as unknown as FacebookPostReader;
  const likeExecutor = {
    like: async (o?: { shadow?: boolean }): Promise<FacebookLikeResult> => {
      likeShadowFlags.push(o?.shadow);
      if (opts.like) return opts.like(o?.shadow);
      return o?.shadow ? { ok: false, reason: 'shadow', executed: false } : { ok: true, executed: true };
    },
  } as unknown as FacebookLikeExecutor;
  const reelQueue = [...(opts.reelCards ?? [])];
  const reelNextCalls: string[] = [];
  let activeReel: FacebookReelCard | undefined;
  const reelsReader = {
    enter: async () => {
      if (opts.reelEntry) {
        if (opts.reelEntry.state === 'ready') activeReel = opts.reelEntry.card;
        return opts.reelEntry;
      }
      activeReel = reelQueue.shift();
      return activeReel
        ? { state: 'ready' as const, card: activeReel }
        : { state: 'failed' as const, reason: 'route_unconfirmed' as const };
    },
    readActive: async () => activeReel ?? null,
    settleActive: async () => {
      if (opts.reelSettles?.length) activeReel = opts.reelSettles.shift() ?? undefined;
      return activeReel ?? null;
    },
    next: async () => {
      reelNextCalls.push('next');
      activeReel = reelQueue.shift();
      return activeReel ?? null;
    },
    like: async (noteId: string, shadow: boolean): Promise<FacebookLikeResult> => {
      if (!activeReel || activeReel.noteId !== noteId) return { ok: false, reason: 'no_target', executed: false };
      return shadow
        ? { ok: false, reason: 'shadow', executed: false, observation: { noteId, surface: 'feed', textPreviewHead: activeReel.summary } }
        : { ok: true, executed: true, observation: { noteId, surface: 'feed', textPreviewHead: activeReel.summary } };
    },
    follow: async (noteId: string, shadow: boolean): Promise<FacebookReelFollowResult> => {
      reelFollowCalls.push({ noteId, shadow });
      if (opts.reelFollow) return opts.reelFollow(noteId, shadow);
      if (!activeReel || activeReel.noteId !== noteId) return { ok: false, reason: 'no_target', executed: false };
      return shadow
        ? { ok: false, reason: 'shadow', executed: false }
        : { ok: true, executed: true };
    },
  } as unknown as FacebookReelsReader;

  const deps: FacebookBrowseSessionDeps = {
    cdp: { send: opts.cdpSend ?? (async () => ({})) } as unknown as BrowseCdp,
    client,
    commentHandler,
    feedReader,
    postReader,
    likeExecutor,
    reelsReader,
    logger: (message) => logs.push(message),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  };
  const session = new FacebookBrowseSession(deps, {
    mode: opts.mode ?? 'on',
    commandTimeoutMs: opts.commandTimeoutMs ?? 90_000,
    feedUrl: 'https://www.facebook.com/',
  });
  return {
    session,
    cards,
    details,
    profiles,
    actions,
    logs,
    delegated,
    likeShadowFlags,
    reelFollowCalls,
    reelNextCalls,
    get ensureCalls() {
      return state.ensureCalls;
    },
    get ensureUrls() {
      return state.ensureUrls;
    },
    get scanCalls() {
      return state.scanCalls;
    },
    get scrollCalls() {
      return state.scrollCalls;
    },
  } as Harness;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── co-landing（task 6.2）───────────────────────────

test('co-landing: 声明 browse 的 Facebook driver 解析到 FacebookBrowseSession，小红书不', () => {
  const fb = selectPlatformDriver({ env: { AIDCP_PLATFORM: 'facebook' } as NodeJS.ProcessEnv });
  const xhs = selectPlatformDriver({ env: {} as NodeJS.ProcessEnv });
  assert.equal(usesFacebookBrowseSession(fb), true);
  assert.equal(usesFacebookBrowseSession(xhs), false);
  assert.equal(fb.capabilities.includes('browse'), true, 'FB 声明 browse');
  assert.equal(fb.edgeCapabilities.includes('facebook_reel_follow_v1'), true, '本构建声明 Reel 关注执行器，供 Cloud 做版本闸');
});

test('co-landing: FacebookBrowseSession 满足 EdgeBrowseSession 契约（9 方法）', async () => {
  const { session } = makeSession();
  for (const m of ['start', 'onCloudCommand', 'stop', 'close', 'quiesceForTask', 'resumeAfterTask', 'discardQueuedCloudCommands', 'applyPacingSnapshot', 'recoverAfterCloudReconnect']) {
    assert.equal(typeof (session as unknown as Record<string, unknown>)[m], 'function', `缺方法 ${m}`);
  }
  assert.equal(await session.quiesceForTask(), 0);
});

// ─────────────────────────── 浏览命令 dispatch（mode=on）───────────────────────────

test('note.open（浏览，无 url）→ 深读上报 note.detail（collectCount=0，带 comments/url）', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
  assert.equal(h.details.length, 1);
  const d = h.details[0];
  assert.equal(d.noteId, 'https://www.facebook.com/a/posts/pfbid0ONE');
  assert.equal(d.content, 'the post body');
  assert.equal(d.collectCount, 0, 'FB 无收藏：诚实 0');
  assert.equal(d.url, 'https://www.facebook.com/a/posts/pfbid0ONE');
  assert.deepEqual(d.comments, ['c1', 'c2']);
  assert.equal(h.actions.length, 0, '成功深读不发 action.completed（note.detail 即回执）');
});

test('interaction.like（mode=on）→ 真点赞 ok:true（云端据此 record）', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('interaction.like', { noteId: 'x' }));
  assert.deepEqual(h.likeShadowFlags, [false]);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].action, 'like');
  assert.equal(h.actions[0].ok, true);
});

test('confirmed Facebook session/read/like → structured companion UI events；shadow 不计成功', async () => {
  const on = makeSession({ mode: 'on' });
  await on.session.start();
  await on.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
  await on.session.onCloudCommand(makeEnv('interaction.like', { noteId: 'x' }));
  const events = on.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as Record<string, unknown>);
  assert.deepEqual(events.map((event) => event.type), ['session_start', 'feed', 'note_open', 'like']);
  assert.equal(events[2].sentence, '打开「the post body」 · Alice');
  assert.equal(events[2].presence, '正在读 Alice 的「the post body」…');
  assert.deepEqual(events[2].statsDelta, { views: 1 });
  assert.deepEqual(events[3].statsDelta, { likes: 1 });

  const shadow = makeSession({ mode: 'shadow' });
  await shadow.session.onCloudCommand(makeEnv('interaction.like', { noteId: 'x' }));
  assert.equal(shadow.logs.some((line) => line.includes('"type":"like"')), false, 'shadow 不得伪报点赞成功');
});

test('Facebook like UI event: 使用实际被作用帖子的作者与正文摘要，并规范化截断', async () => {
  const h = makeSession({
    mode: 'on',
    like: () => ({
      ok: true,
      executed: true,
      observation: {
        surface: 'feed',
        noteId: 'fb:pfbid0ONE',
        author: ' Alice\nSmith ',
        textPreviewHead: '  01234567890123456789012345\nnext ',
      },
    }),
  });
  await h.session.onCloudCommand(makeEnv('interaction.like', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
  const event = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as Record<string, unknown>)
    .find((line) => line.type === 'like');
  assert.equal(event?.sentence, '赞了「012345678901234567890123…」 · Alice Smith');
  assert.equal(event?.presence, '刚赞了 Alice Smith 的「012345678901234567890123…」');
  assert.deepEqual(event?.statsDelta, { likes: 1 });
  assert.ok(!String(event?.sentence).includes('pfbid0ONE'));
});

test('Facebook like UI event: 见证字段缺失时部分展示或诚实降级', async () => {
  const cases: Array<{
    observation?: FacebookLikeResult['observation'];
    sentence: string;
    presence: string;
  }> = [
    {
      observation: { surface: 'detail', textPreviewHead: 'the post body' },
      sentence: '赞了「the post body」',
      presence: '刚赞了「the post body」',
    },
    {
      observation: { surface: 'detail', author: 'Alice' },
      sentence: '赞了 Alice 的一条内容',
      presence: '刚赞了 Alice 的一条内容',
    },
    { sentence: '点了个赞', presence: '刚点了个赞' },
  ];

  for (const item of cases) {
    const h = makeSession({
      mode: 'on',
      like: () => ({ ok: true, executed: true, ...(item.observation ? { observation: item.observation } : {}) }),
    });
    await h.session.onCloudCommand(makeEnv('interaction.like', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
    const event = h.logs
      .filter((line) => line.startsWith('[ui-event] '))
      .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as Record<string, unknown>)
      .find((line) => line.type === 'like');
    assert.equal(event?.sentence, item.sentence);
    assert.equal(event?.presence, item.presence);
  }
});

test('Facebook like UI event: 未确认成功时即使有目标见证也不生成成功记录', async () => {
  const h = makeSession({
    mode: 'on',
    like: () => ({
      ok: false,
      reason: 'state_unchanged',
      executed: true,
      observation: { surface: 'feed', author: 'Alice', textPreviewHead: 'the post body' },
    }),
  });
  await h.session.onCloudCommand(makeEnv('interaction.like', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
  assert.equal(h.logs.some((line) => line.includes('"type":"like"')), false);
});

test('Facebook read UI event: 作者或正文缺失时诚实降级，不泄露 permalink', async () => {
  const h = makeSession({ mode: 'on', detail: { body: '', author: undefined } });
  await h.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
  const event = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as Record<string, unknown>)
    .find((line) => line.type === 'note_open');
  assert.equal(event?.sentence, '打开了一条内容');
  assert.equal(event?.presence, '正在认真阅读一条内容…');
  assert.ok(!String(event?.sentence).includes('pfbid0ONE'));
});

test('Facebook read UI event: 正文与昵称规范化后按活动流宽度截断', async () => {
  const h = makeSession({
    mode: 'on',
    detail: { body: '  01234567890123456789012345\nnext ', author: ' Alice\nSmith ' },
  });
  await h.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
  const event = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as Record<string, unknown>)
    .find((line) => line.type === 'note_open');
  assert.equal(event?.sentence, '打开「012345678901234567890123…」 · Alice Smith');
  assert.equal(event?.presence, '正在读 Alice Smith 的「012345678901234567890123…」…');
});

test('page.scroll → 翻页扫卡 page.cards（collectCount=0）', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].cards[0].collectCount, 0);
  assert.equal(h.cards[0].cards[0].noteId, 'https://www.facebook.com/a/posts/pfbid0ONE');
});

test('page.scroll 带 dwellMs → FB 翻页前先按卡片停留兜底等待', async () => {
  const sleeps: number[] = [];
  // 首屏与滚动给**不同**卡（滚动带出真新卡）——同卡在游标下会被当回收重现滤掉（见 feed_exhausted 语义）。
  const cardA: FacebookFeedCard = { index: 0, noteId: 'https://www.facebook.com/a/posts/pfbidONE', author: 'Alice', textPreview: 'one', reactionCount: 1, isVideo: false };
  const cardB: FacebookFeedCard = { index: 0, noteId: 'https://www.facebook.com/b/posts/pfbidTWO', author: 'Bob', textPreview: 'two', reactionCount: 2, isVideo: false };
  const h = makeSession({
    mode: 'on',
    sleep: async (ms) => { sleeps.push(ms); },
    settleBatches: [{ cards: [cardA], degraded: false }, { cards: [cardB], degraded: false }],
  });
  await h.session.start();
  assert.equal(h.cards.length, 1, 'start 应先上报首屏，建立 dwell 锚点');

  await h.session.onCloudCommand(makeEnv('page.scroll', { dwellMs: 5000 }));

  assert.ok(sleeps.some((ms) => ms > 0), `应消费 dwellMs 产生等待，实际=${JSON.stringify(sleeps)}`);
  assert.equal(h.cards.length, 2, '等待后仍应执行 scroll 并上报新 page.cards');
  assert.equal(h.cards[1].cards[0].noteId, 'https://www.facebook.com/b/posts/pfbidTWO', '滚动报的是新卡 B');
});

test('navigation.back → 回 feed 重报 page.cards（驱动下一轮 feed.entered）', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('navigation.back', { targetPage: 'feed' }));
  assert.equal(h.cards.length, 1);
});

// ─────────────────────────── 评论/加群委托 ───────────────────────────

test('普通浏览 search.execute（无 taskId/container）→ FB 搜索页读卡，不误走定向评论处理器', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('search.execute', { keyword: '意大利本地生活', maxResults: 1 }));
  assert.equal(h.delegated.length, 0);
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].cards.length, 1);
  assert.match(h.ensureUrls[0], /\/search\/posts\/\?q=/);
  assert.match(h.ensureUrls[0], /%E6%84%8F%E5%A4%A7%E5%88%A9/);
  assert.deepEqual(h.actions, [{
    action: 'search', ok: true, activityId: 'cmd-search.execute', purpose: 'discovery', scope: 'global',
    actuated: true, searchOutcome: 'results_ready', resultCount: 1,
  }]);
});

test('普通浏览 search.execute 搜索页无卡 → no_results 成功终态', async () => {
  const h = makeSession({
    mode: 'on',
    settleBatches: [{ cards: [], degraded: false, reason: 'no_feed' }],
  });
  await h.session.onCloudCommand(makeEnv('search.execute', {
    keyword: '不存在的主题', activityId: 'fb-global-empty', purpose: 'operator', scope: 'global',
  }));
  assert.equal(h.cards.at(-1)?.cards.length, 0);
  assert.deepEqual(h.actions, [{
    action: 'search', ok: true, activityId: 'fb-global-empty', purpose: 'operator', scope: 'global',
    actuated: true, searchOutcome: 'no_results', resultCount: 0,
  }]);
});

test('评论/搜索/加群/按url开帖 → 委托 commentHandler（不走浏览路径）', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('search.execute', { container: 'https://www.facebook.com/groups/x' }));
  await h.session.onCloudCommand(makeEnv('search.execute', { keyword: '咖啡', taskId: 'task-1' }));
  await h.session.onCloudCommand(makeEnv('interaction.comment', { noteId: 'x', text: 'hi' }));
  await h.session.onCloudCommand(makeEnv('group.join', { groupUrl: 'https://www.facebook.com/groups/x' }));
  await h.session.onCloudCommand(makeEnv('note.open', { url: 'https://www.facebook.com/a/posts/pfbid0URL', taskId: 't1' }));
  assert.deepEqual(h.delegated.map((e) => e.type), ['search.execute', 'search.execute', 'interaction.comment', 'group.join', 'note.open']);
  assert.equal(h.details.length, 0, '委托路径不走浏览深读');
});

// ─────────────────────────── kill switch 门控 ───────────────────────────

test('mode=off：浏览/点赞回 browse_disabled；评论/加群仍委托', async () => {
  const h = makeSession({ mode: 'off' });
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  await h.session.onCloudCommand(makeEnv('interaction.like', { noteId: 'x' }));
  await h.session.onCloudCommand(makeEnv('group.join', { groupUrl: 'https://www.facebook.com/groups/x' }));
  const disabled = h.actions.filter((a) => a.reason === 'browse_disabled');
  assert.equal(disabled.length, 2, 'scroll + like 均 browse_disabled');
  assert.equal(h.likeShadowFlags.length, 0, 'off 不触发点赞执行器');
  assert.deepEqual(h.delegated.map((e) => e.type), ['group.join'], '加群仍委托');
});

test('mode=shadow：点赞只记不执行 → ok:false reason=shadow（云端不记账）', async () => {
  const h = makeSession({ mode: 'shadow' });
  await h.session.onCloudCommand(makeEnv('interaction.like', { noteId: 'x' }));
  assert.deepEqual(h.likeShadowFlags, [true], 'shadow 传入 like 执行器');
  assert.equal(h.actions[0].ok, false);
  assert.equal(h.actions[0].reason, 'shadow');
});

test('profile.open direct 遗留载荷在 Facebook 旧会话也不再解释为本人身份读取', async () => {
  const navUrls: string[] = [];
  const h = makeSession({
    mode: 'shadow',
    cdpSend: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (method === 'Page.navigate') {
        navUrls.push(String(params?.url ?? ''));
        return {} as T;
      }
      return {} as T;
    },
  });
  await h.session.onCloudCommand(makeEnv('profile.open', { authorId: '61591701813509', direct: true }));
  assert.deepEqual(navUrls, []);
  assert.equal(h.profiles.length, 0);
  assert.deepEqual(h.actions, [{
    action: 'profile_open',
    ok: false,
    reason: 'capability_unsupported',
  }]);
});

// ─────────────────────────── 不支持命令诚实回执 ───────────────────────────

test('FB v1 不支持的命令 → capability_unsupported（绝不静默丢弃）', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('interaction.collect', { noteId: 'x' }));
  await h.session.onCloudCommand(makeEnv('interaction.follow', { authorId: 'a' }));
  await h.session.onCloudCommand(makeEnv('profile.open', { authorId: 'a' }));
  assert.equal(h.actions.length, 3);
  assert.ok(h.actions.every((a) => a.reason === 'capability_unsupported'));
  assert.equal(h.reelFollowCalls.length, 0, '普通 Feed 不能误路由到 Reel 关注执行器');
});

test('FB 云端命令回执使用规范动作名，深读失败不会退化为未知动作', async () => {
  const expected: Record<string, string> = {
    'page.scroll': 'scroll',
    'feed.refresh': 'refresh',
    'interaction.like': 'like',
    'interaction.collect': 'collect',
    'interaction.follow': 'follow',
    'interaction.comment': 'comment',
    'interaction.like_comment': 'comment_like',
    'search.execute': 'search',
    'note.open': 'open_note',
    'note.close': 'close',
    'note.browse_images': 'browse_images',
    'note.scroll_comments': 'scroll_comments',
    'navigation.back': 'back',
    'profile.open': 'profile_open',
    'group.join': 'join_group',
    'notification.open': 'open_notifications',
    'notification.browse_comments': 'browse_notification_comments',
    'notification.browse_likes': 'browse_notification_likes',
    'notification.browse_follows': 'browse_notification_follows',
    'notification.back_home': 'notification_back_home',
    'pacing.update': 'pacing_update',
    'session.end': 'session.end',
  };
  for (const [command, action] of Object.entries(expected)) {
    assert.equal(facebookActionNameForCommand(command), action, command);
  }

  const h = makeSession({ mode: 'on' });
  for (const type of ['note.browse_images', 'note.scroll_comments', 'interaction.collect', 'interaction.follow', 'interaction.like_comment']) {
    await h.session.onCloudCommand(makeEnv(type, {}));
  }
  assert.deepEqual(h.actions.map((a) => a.action), ['browse_images', 'scroll_comments', 'collect', 'follow', 'comment_like']);
  assert.ok(h.actions.every((a) => a.ok === false && a.reason === 'capability_unsupported'));
});

test('FB scroll 在详情页时先回到 feed，再扫描并滚动', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.ensureCalls, 1);
  assert.deepEqual(h.ensureUrls, ['https://www.facebook.com/']);
  assert.equal(h.cards.length, 1);
});

test('page.scroll 懒加载还在长内容/未到底时绝不提前判到底：续滚到出新卡才上报（不刷新回顶）', async () => {
  const cardA: FacebookFeedCard = { index: 0, noteId: 'https://www.facebook.com/a/posts/pfbidONE', author: 'A', textPreview: 'one', reactionCount: 1, isVideo: false };
  const cardB: FacebookFeedCard = { index: 0, noteId: 'https://www.facebook.com/b/posts/pfbidTWO', author: 'B', textPreview: 'two', reactionCount: 2, isVideo: false };
  const h = makeSession({
    mode: 'on',
    // start 报首屏 A；随后两轮仍是已见的 A（0 新卡），第三轮才下沉出真新卡 B。默认 metrics=未接近底部 → 每轮判「继续下滚」。
    settleBatches: [
      { cards: [cardA], degraded: false },
      { cards: [cardA], degraded: false },
      { cards: [cardA], degraded: false },
      { cards: [cardB], degraded: false },
    ],
  });
  await h.session.start();
  assert.equal(h.cards.length, 1, 'start 先报首屏 A');
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.cards.length, 2, '续滚到下沉出的新卡 B 才上报（未因懒加载慢而提前判到底）');
  assert.equal(h.cards[1].cards[0].noteId, cardB.noteId, '报的是新卡 B');
  assert.equal(h.actions.filter((a) => a.reason === 'feed_exhausted').length, 0, '绝不因懒加载慢误报 feed_exhausted');
});

test('page.scroll 高度稳定且接近底部、连续无新卡 → 诚实 feed_exhausted 换批（真到底才刷新）', async () => {
  const cardA: FacebookFeedCard = { index: 0, noteId: 'https://www.facebook.com/a/posts/pfbidONE', author: 'A', textPreview: 'one', reactionCount: 1, isVideo: false };
  // remaining = 5900-5000-900 = 0 ≤ 900 → 接近底部；高度前后不变 → 未在长（非懒加载中）。
  const atBottom = { scrollY: 5000, scrollHeight: 5900, innerHeight: 900 };
  const h = makeSession({
    mode: 'on',
    settleBatches: [
      { cards: [cardA], degraded: false },
      { cards: [cardA], degraded: false },
      { cards: [cardA], degraded: false },
    ],
    scrollMetricsBatches: [atBottom, atBottom, atBottom, atBottom], // 两轮 ×（before+after）
  });
  await h.session.start();
  assert.equal(h.cards.length, 1);
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.cards.length, 1, '真到底无新卡不再上报陈旧卡');
  const exhausted = h.actions.filter((a) => a.action === 'scroll' && a.reason === 'feed_exhausted');
  assert.equal(exhausted.length, 1, '连续确认到底 → 诚实回 feed_exhausted（云端据此换批）');
});

test('FB scroll 在搜索详情页时回到原搜索结果，不误跳首页', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('search.execute', { keyword: 'Puerto Rico' }));
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.ensureUrls[0], 'https://www.facebook.com/search/posts/?q=Puerto+Rico');
  assert.equal(h.ensureUrls[1], 'https://www.facebook.com/search/posts/?q=Puerto+Rico');
});

// ─────────────────────────── 有界超时兜底（task 4.2/7.5）───────────────────────────

test('浏览命令超时 → 诚实 timeout 回执，绝不挂死', async () => {
  const h = makeSession({ mode: 'on', commandTimeoutMs: 30, hangOpen: true });
  // 不 await（fn 永不 resolve）；定时器触发 timeout 回执。
  void h.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0HANG' }));
  await sleep(80);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].action, 'open_note');
  assert.equal(h.actions[0].ok, false);
  assert.equal(h.actions[0].reason, 'timeout');
});

// ─────────────────────────── start() 门控 ───────────────────────────

test('超时后串行链继续：卡死命令不活锁后续命令（task 4.3）', async () => {
  const h = makeSession({ mode: 'on', commandTimeoutMs: 30, hangOpen: true });
  void h.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0HANG' })); // 卡死
  void h.session.onCloudCommand(makeEnv('page.scroll', {})); // 排在卡死命令之后
  await sleep(120);
  const timeout = h.actions.find((a) => a.reason === 'timeout');
  assert.ok(timeout, '卡死命令回 timeout');
  assert.equal(h.cards.length, 1, '超时放行链后，后续 page.scroll 仍执行并上报（未被活锁）');
});

test('start(): mode=off 不进 feed（不 ensureFeed/不报卡）；mode=on 进 feed 报首屏', async () => {
  const off = makeSession({ mode: 'off' });
  await off.session.start();
  assert.equal(off.ensureCalls, 0);
  assert.equal(off.cards.length, 0);

  const on = makeSession({ mode: 'on' });
  await on.session.start();
  assert.equal(on.ensureCalls, 1);
  assert.equal(on.cards.length, 1, 'on 模式上报首屏 page.cards');
});

test('start(): settleCards 判稳后上报（晚水合的卡由 settle 承担，非会话再叠一层重试）', async () => {
  const h = makeSession({
    mode: 'shadow',
    settleBatches: [
      {
        cards: [{
          index: 0,
          noteId: 'https://www.facebook.com/a/posts/pfbid0LATE',
          author: 'Late',
          textPreview: 'hydrated later',
          reactionCount: 0,
          isVideo: false,
        }],
        degraded: false,
      },
    ],
  });
  await h.session.start();
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].cards[0].noteId, 'https://www.facebook.com/a/posts/pfbid0LATE');
});

test('start(): 不可上报首卡立即有界续滚，只上报后续 canonical 卡且不伪造 action 回执', async () => {
  const later: FacebookFeedCard = {
    index: 0,
    noteId: 'https://www.facebook.com/watch?v=1547652190157533',
    author: 'Đưa Béo Vlog',
    textPreview: 'Mời các bác ăn sáng #Buffet… Xem thêm',
    reactionCount: 0,
    isVideo: true,
  };
  const h = makeSession({
    mode: 'on',
    settleBatches: [
      { cards: [], degraded: false, reason: 'no_feed' },
      { cards: [], degraded: false, reason: 'no_feed' },
      { cards: [later], degraded: false },
    ],
    scrollMetricsBatches: [
      { scrollY: 4_100, scrollHeight: 5_000, innerHeight: 900 },
      { scrollY: 4_750, scrollHeight: 6_200, innerHeight: 900 },
      { scrollY: 4_750, scrollHeight: 6_200, innerHeight: 900 },
      { scrollY: 5_300, scrollHeight: 6_200, innerHeight: 900 },
    ],
    homeState: { state: 'cards_ready' },
  });

  await h.session.start();

  assert.equal(h.scrollCalls, 2, '首轮只增长页面高度、卡片尚未水合时继续等待并下滚，而非等 Cloud watchdog');
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].cards[0].noteId, later.noteId);
  assert.equal(h.actions.length, 0, 'bootstrap 续滚没有对应 Cloud 命令，不得伪造 action.completed');
  assert.ok(h.logs.some((line) => line.includes('不可上报卡片')));
  assert.ok(h.logs.some((line) => line.includes('跳过不可上报首卡后已上报 1 张')));
});

test('Feed 单视频卡一经呈现即投影一条可读活动与本地浏览兜底', async () => {
  const video: FacebookFeedCard = {
    index: 0,
    noteId: 'https://www.facebook.com/watch?v=1547652190157533',
    author: 'BHD Movies',
    textPreview: 'Hành trình đi tìm vợ con…',
    reactionCount: 12,
    isVideo: true,
  };
  const h = makeSession({ mode: 'on', settleBatches: [{ cards: [video], degraded: false }] });

  await h.session.start();

  const events = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as Record<string, unknown>);
  assert.deepEqual(
    events.filter((event) => event.type === 'feed_video_view'),
    [{
      kind: 'activity',
      type: 'feed_video_view',
      sentence: '看了「Hành trình đi tìm vợ con…」 · BHD Movies',
      loopStage: 'read',
      statsDelta: { views: 1 },
    }],
  );
});

test('Feed 视频活动跨刷新按 canonical postId 去重，随后同帖详情仍上报但不重复投影', async () => {
  const video: FacebookFeedCard = {
    index: 0,
    noteId: 'https://www.facebook.com/watch?v=1547652190157533',
    author: 'BHD Movies',
    textPreview: 'Hành trình đi tìm vợ con…',
    reactionCount: 12,
    isVideo: true,
  };
  const refreshedLead: FacebookFeedCard = {
    index: 0,
    noteId: 'https://www.facebook.com/example/posts/pfbid0NEW',
    author: 'New',
    textPreview: 'new lead card',
    reactionCount: 0,
    isVideo: false,
  };
  const h = makeSession({
    mode: 'on',
    cardBatches: [[video]],
    settleBatches: [
      { cards: [video], degraded: false },
      { cards: [refreshedLead, video], degraded: false },
    ],
  });

  await h.session.start();
  await h.session.onCloudCommand(makeEnv('feed.refresh', {}));
  await h.session.onCloudCommand(makeEnv('note.open', { noteId: video.noteId }));

  const events = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as { type: string });
  assert.equal(events.filter((event) => event.type === 'feed_video_view').length, 1);
  assert.equal(events.filter((event) => event.type === 'note_open').length, 0, '同一 Feed 视频详情不重复生成“读”或本地浏览数');
  assert.equal(h.details.length, 1, '详情仍须上报 Cloud，去重只作用于客户端活动投影');
});

test('Feed 非视频、多视频、非规范身份和 Reel 身份均不投影视频浏览活动', async () => {
  const video = (noteId: string, index = 0): FacebookFeedCard => ({
    index,
    noteId,
    author: 'A',
    textPreview: 'video',
    reactionCount: 0,
    isVideo: true,
  });
  const cases: Array<{ name: string; cards: FacebookFeedCard[] }> = [
    {
      name: 'non-video',
      cards: [{ ...video('https://www.facebook.com/watch?v=1'), isVideo: false }],
    },
    {
      name: 'multiple videos',
      cards: [
        video('https://www.facebook.com/watch?v=2'),
        video('https://www.facebook.com/watch?v=3', 1),
      ],
    },
    {
      name: 'malformed identity',
      cards: [video('https://evil.example/watch?v=4')],
    },
    {
      name: 'Reel identity',
      cards: [video('https://www.facebook.com/reel/5')],
    },
  ];

  for (const fixture of cases) {
    const h = makeSession({ mode: 'on', settleBatches: [{ cards: fixture.cards, degraded: false }] });
    await h.session.start();
    assert.equal(
      h.logs.some((line) => line.includes('"type":"feed_video_view"')),
      false,
      fixture.name,
    );
  }
});

test('start(): 连续不可上报卡片 8 轮后上报独立结构态，不伪造内容卡或 action', async () => {
  const h = makeSession({
    mode: 'on',
    settleBatches: [
      { cards: [], degraded: false, reason: 'no_feed' },
      ...Array.from({ length: 8 }, () => ({ cards: [], degraded: false, reason: 'no_feed' as const })),
    ],
    homeState: { state: 'cards_ready', generation: 'doc-1', loading: false },
  });

  await h.session.start();

  assert.equal(h.scrollCalls, 8, 'bootstrap 续滚必须受既有最大轮次约束');
  assert.deepEqual(h.cards, [{
    cards: [],
    listKind: 'feed',
    listState: 'present_unreportable',
    documentGeneration: 'doc-1',
  }], '只报告物理卡在场但不可上报，不伪造帖子身份');
  assert.equal(h.actions.length, 0, 'bootstrap 没有对应 Cloud 命令就不伪造 action.completed');
  assert.ok(h.logs.some((line) => line.includes('8 轮后确认首页仍有物理卡但不可上报')));
});

test('start(): 8 轮后物理卡仍伴随 loading 时失败关闭，不切 Reels', async () => {
  const h = makeSession({
    mode: 'on',
    settleBatches: [
      { cards: [], degraded: false, reason: 'no_feed' },
      ...Array.from({ length: 8 }, () => ({ cards: [], degraded: false, reason: 'no_feed' as const })),
    ],
    homeState: { state: 'cards_ready', generation: 'doc-loading', loading: true },
  });

  await h.session.start();

  assert.equal(h.scrollCalls, 8);
  assert.equal(h.cards.length, 0, 'loading 样本不得上报 present_unreportable');
  assert.equal(h.actions.length, 0, 'bootstrap 仍不得伪造 action.completed');
});

test('首页明确空态只上报观察；Cloud 专用授权后进入 Reels，摘要/点赞/下一条走独立列表路径', async () => {
  const first: FacebookReelCard = {
    noteId: 'https://www.facebook.com/reel/111',
    summary: 'first reel summary',
    author: 'Bao',
    videoKey: 'video-111',
  };
  const second: FacebookReelCard = {
    noteId: 'https://www.facebook.com/reel/222',
    summary: 'second reel summary',
    author: 'Lan',
    videoKey: 'video-222',
  };
  const h = makeSession({
    mode: 'on',
    settleBatches: [{ cards: [], degraded: false, reason: 'no_feed' }],
    homeState: { state: 'empty_feed_confirmed', generation: 'g1' },
    reelCards: [first, second],
  });
  await h.session.start();
  assert.deepEqual(h.cards[0], {
    cards: [], listKind: 'feed', listState: 'empty', documentGeneration: 'g1',
  }, 'Edge 只报告空态，不自行导航');

  await h.session.onCloudCommand(makeEnv('page.scroll', { reason: 'empty_feed_reels_fallback' }));
  assert.equal(h.cards[1].listKind, 'reels');
  assert.equal(h.cards[1].cards[0].noteId, first.noteId);
  let uiEvents = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as { type: string; sentence?: string; statsDelta?: { views?: number; follows?: number } });
  assert.deepEqual(
    uiEvents.filter((event) => event.type === 'reel_view'),
    [{ kind: 'activity', type: 'reel_view', sentence: '看了「first reel summary」 · Bao', loopStage: 'read', statsDelta: { views: 1 } }],
    '首条已确认 Reel 应立即投影为一条可读浏览活动',
  );

  await h.session.onCloudCommand(makeEnv('note.open', { noteId: first.noteId, surface: 'feed' }));
  assert.equal(h.details.at(-1)?.content, first.summary);
  assert.equal(h.details.at(-1)?.mediaType, 'video');
  uiEvents = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as { type: string; sentence?: string; statsDelta?: { views?: number; follows?: number } });
  assert.equal(uiEvents.filter((event) => event.type === 'reel_view').length, 1);
  assert.equal(uiEvents.filter((event) => event.type === 'note_open').length, 0, '同一 Reel 的后续详情仍上报，但不重复计读');

  await h.session.onCloudCommand(makeEnv('interaction.like', { noteId: first.noteId }));
  assert.equal(h.actions.at(-1)?.ok, true);
  assert.equal(h.actions.at(-1)?.noteId, first.noteId);

  await h.session.onCloudCommand(makeEnv('interaction.follow', { authorId: 'Bao', noteId: first.noteId }));
  assert.equal(h.actions.at(-1)?.action, 'follow');
  assert.equal(h.actions.at(-1)?.ok, true);
  assert.deepEqual(h.reelFollowCalls, [{ noteId: first.noteId, shadow: false }]);
  uiEvents = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as { type: string; sentence?: string; presence?: string; statsDelta?: { views?: number; follows?: number } });
  assert.deepEqual(
    uiEvents.filter((event) => event.type === 'follow'),
    [{
      kind: 'activity',
      type: 'follow',
      sentence: '关注了一位 Reel 作者',
      presence: '刚关注了一位 Reel 作者',
      loopStage: 'interact',
      statsDelta: { follows: 1 },
    }],
    '只有验证为新关注成功时，客户端活动与本地即时计数才增加',
  );

  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.cards.at(-1)?.cards[0].noteId, second.noteId);
  uiEvents = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as { type: string; sentence?: string; statsDelta?: { views?: number; follows?: number } });
  assert.deepEqual(
    uiEvents.filter((event) => event.type === 'reel_view').map((event) => event.sentence),
    ['看了「first reel summary」 · Bao', '看了「second reel summary」 · Lan'],
    '每次已确认的新 Reel 切卡各有一条读活动',
  );
});

test('Reels 路由先到、首卡晚到时保持 pending，恢复当前卡前不切下一条也不退回 Feed', async () => {
  const first: FacebookReelCard = {
    noteId: 'https://www.facebook.com/reel/333',
    summary: 'late hydrated reel',
    author: 'Ming',
    videoKey: 'video-333',
  };
  const h = makeSession({
    mode: 'on',
    settleBatches: [{ cards: [], degraded: false, reason: 'no_feed' }],
    homeState: { state: 'empty_feed_confirmed', generation: 'g-late' },
    reelEntry: { state: 'route_ready', href: 'https://www.facebook.com/reel/?s=tab' },
    reelSettles: [null, first],
  });
  await h.session.start();
  const initialEnsureCalls = h.ensureCalls;

  await h.session.onCloudCommand(makeEnv('page.scroll', { reason: 'empty_feed_reels_fallback' }));
  assert.deepEqual(h.actions.at(-1), { action: 'scroll', ok: false, reason: 'reels_pending' });
  assert.equal(h.cards.length, 1, 'route_ready 不是卡片证据，不得上报 Reels 卡');
  assert.equal(h.logs.some((line) => line.includes('"type":"reel_view"')), false, 'route_ready 不得伪计一次浏览');

  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.deepEqual(h.actions.at(-1), { action: 'scroll', ok: false, reason: 'reels_pending' });
  assert.equal(h.reelNextCalls.length, 0, '首卡未恢复前不得执行 next');
  assert.equal(h.ensureCalls, initialEnsureCalls, 'pending Reels 不得重新导航 Feed/home');

  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.cards.at(-1)?.listKind, 'reels');
  assert.equal(h.cards.at(-1)?.cards[0]?.noteId, first.noteId);
  assert.equal(h.reelNextCalls.length, 0, '首张可读卡应原地恢复，不能被当成下一条越过');
  assert.equal(h.ensureCalls, initialEnsureCalls);
  const reelViews = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as { type: string })
    .filter((event) => event.type === 'reel_view');
  assert.equal(reelViews.length, 1, '只有首卡实际可读后才计一次浏览');
});

test('Reels 关注：shadow 标志与 reader 的真实终态原样回执', async () => {
  const reel: FacebookReelCard = {
    noteId: 'https://www.facebook.com/reel/111',
    summary: 'reel summary',
    author: 'Salon de Comolis',
    videoKey: 'video-111',
  };
  const h = makeSession({
    mode: 'shadow',
    settleBatches: [{ cards: [], degraded: false, reason: 'no_feed' }],
    homeState: { state: 'empty_feed_confirmed', generation: 'g1' },
    reelCards: [reel],
    reelFollow: () => ({ ok: false, reason: 'shadow', executed: false }),
  });
  await h.session.start();
  await h.session.onCloudCommand(makeEnv('page.scroll', { reason: 'empty_feed_reels_fallback' }));
  await h.session.onCloudCommand(makeEnv('interaction.follow', { authorId: reel.author, noteId: reel.noteId }));

  assert.deepEqual(h.reelFollowCalls, [{ noteId: reel.noteId, shadow: true }]);
  assert.deepEqual(h.actions.at(-1), { action: 'follow', ok: false, reason: 'shadow' });
  assert.equal(h.logs.some((line) => line.includes('"type":"follow"')), false, 'shadow 不得伪报关注活动或计数');
});

test('Reels 关注：already_followed 是已满足的幂等终态，缺 noteId 则 fail-closed', async () => {
  const reel: FacebookReelCard = {
    noteId: 'https://www.facebook.com/reel/111',
    summary: 'reel summary',
    videoKey: 'video-111',
  };
  const h = makeSession({
    mode: 'on',
    settleBatches: [{ cards: [], degraded: false, reason: 'no_feed' }],
    homeState: { state: 'empty_feed_confirmed', generation: 'g1' },
    reelCards: [reel],
    reelFollow: (noteId) => noteId
      ? { ok: true, reason: 'already_followed', executed: false }
      : { ok: false, reason: 'no_target', executed: false },
  });
  await h.session.start();
  await h.session.onCloudCommand(makeEnv('page.scroll', { reason: 'empty_feed_reels_fallback' }));

  await h.session.onCloudCommand(makeEnv('interaction.follow', { authorId: 'Salon de Comolis', noteId: reel.noteId }));
  assert.deepEqual(h.actions.at(-1), { action: 'follow', ok: true, reason: 'already_followed' });
  assert.equal(h.logs.some((line) => line.includes('"type":"follow"')), false, 'already_followed 未发生新关注，不得计入今日进展');
  await h.session.onCloudCommand(makeEnv('interaction.follow', { authorId: 'Salon de Comolis' }));
  assert.deepEqual(h.actions.at(-1), { action: 'follow', ok: false, reason: 'no_target' });
});

test('Reels 全部导航方式均未证明下一条时，session 诚实回 scroll/no_target', async () => {
  const first: FacebookReelCard = {
    noteId: 'https://www.facebook.com/reel/111',
    summary: 'first reel summary',
    videoKey: 'video-111',
  };
  const h = makeSession({
    mode: 'on',
    settleBatches: [{ cards: [], degraded: false, reason: 'no_feed' }],
    homeState: { state: 'empty_feed_confirmed', generation: 'g1' },
    reelCards: [first],
  });
  await h.session.start();
  await h.session.onCloudCommand(makeEnv('page.scroll', { reason: 'empty_feed_reels_fallback' }));
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.actions.at(-1)?.action, 'scroll');
  assert.equal(h.actions.at(-1)?.ok, false);
  assert.equal(h.actions.at(-1)?.reason, 'no_target');
  const reelViews = h.logs
    .filter((line) => line.startsWith('[ui-event] '))
    .map((line) => JSON.parse(line.slice('[ui-event] '.length)) as { type: string })
    .filter((event) => event.type === 'reel_view');
  assert.equal(reelViews.length, 1, '未证明切到下一条时不能伪造第二条读活动');
});

test('Reels 视频已切但路由尚未水合时，route+videoKey 新身份仍可进入下一轮', async () => {
  const first: FacebookReelCard = {
    noteId: 'https://www.facebook.com/reel/111',
    summary: 'first reel summary',
    videoKey: 'video-element-1',
  };
  const transitioned: FacebookReelCard = {
    noteId: first.noteId,
    summary: 'transitioned reel summary',
    videoKey: 'video-element-2',
  };
  const h = makeSession({
    mode: 'on',
    settleBatches: [{ cards: [], degraded: false, reason: 'no_feed' }],
    homeState: { state: 'empty_feed_confirmed', generation: 'g1' },
    reelCards: [first, transitioned],
  });
  await h.session.start();
  await h.session.onCloudCommand(makeEnv('page.scroll', { reason: 'empty_feed_reels_fallback' }));
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.cards.length, 3);
  assert.equal(h.cards.at(-1)?.cards[0].title, transitioned.summary);
});

test('首页 0 卡但 feed_unknown 时不报告 empty，也不进入 Reels', async () => {
  const h = makeSession({
    mode: 'on',
    settleBatches: [{ cards: [], degraded: false, reason: 'no_feed' }],
    homeState: { state: 'feed_unknown' },
    reelCards: [{ noteId: 'https://www.facebook.com/reel/111', summary: 'x', videoKey: 'v1' }],
  });
  await h.session.start();
  assert.equal(h.cards.length, 0);
  assert.ok(h.logs.some((line) => line.includes('未确认空态')));
});

test('首页从未出现真卡时 page.scroll 不得误报 feed_exhausted，并可严格复确认空态', async () => {
  const h = makeSession({
    mode: 'on',
    settleBatches: Array.from({ length: 8 }, () => ({ cards: [], degraded: false, reason: 'no_feed' as const })),
    homeState: { state: 'empty_feed_confirmed', generation: 'g-scroll' },
    scrollMetrics: { scrollY: 0, scrollHeight: 800, innerHeight: 800 },
  });
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.actions.some((action) => action.reason === 'feed_exhausted'), false, '从未见卡不能声称刷到底');
  assert.deepEqual(h.cards[0], {
    cards: [], listKind: 'feed', listState: 'empty', documentGeneration: 'g-scroll',
  });
});

// ─────────────────────────── split-brain：返回落回当前列表面（task 1.4/1.5）───────────────────────────

test('navigation.back 从搜索结果开帖后回落搜索页而非会话初始首页（修 split-brain）', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('search.execute', { keyword: 'Puerto Rico' }));
  await h.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/x/posts/pfbid0Z' }));
  await h.session.onCloudCommand(makeEnv('navigation.back', {}));
  assert.equal(h.ensureUrls.at(-1), 'https://www.facebook.com/search/posts/?q=Puerto+Rico', 'back 回搜索页而非首页');
});

// ─────────────────────────── feed.refresh 实装（task 3.5）───────────────────────────

test('feed.refresh 成功：点首页图标换批 + 首卡变更 → 回新一批 page.cards（单一终态，无 action.completed）', async () => {
  const h = makeSession({
    mode: 'on',
    settleBatches: [{
      cards: [{ index: 0, noteId: 'https://www.facebook.com/x/posts/pfbid0NEW', author: 'N', reactionCount: 0, isVideo: false }],
      degraded: false,
    }],
  });
  await h.session.onCloudCommand(makeEnv('feed.refresh', {}));
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].cards[0].noteId, 'https://www.facebook.com/x/posts/pfbid0NEW');
  assert.equal(h.actions.length, 0, '成功刷新回 cards，不另发 action.completed');
});

test('feed.refresh 首卡未变 → not_refreshed，绝不报陈旧卡', async () => {
  const h = makeSession({
    mode: 'on',
    settleBatches: [{
      cards: [{ index: 0, noteId: 'https://www.facebook.com/a/posts/pfbid0ONE', author: 'A', reactionCount: 0, isVideo: false }],
      degraded: false,
    }],
  });
  await h.session.onCloudCommand(makeEnv('feed.refresh', {}));
  assert.equal(h.cards.length, 0);
  assert.equal(h.actions.at(-1)?.action, 'refresh');
  assert.equal(h.actions.at(-1)?.ok, false);
  assert.equal(h.actions.at(-1)?.reason, 'not_refreshed');
});

test('feed.refresh 无首页锚点且 reload 兜底失败 → no_home_link（不假成功）', async () => {
  const h = makeSession({
    mode: 'on',
    clickHome: { ok: false, reason: 'no_home_link' },
    cdpSend: async (method: string) => {
      if (method === 'Page.reload') throw new Error('reload boom');
      return {} as never;
    },
  });
  await h.session.onCloudCommand(makeEnv('feed.refresh', {}));
  assert.equal(h.cards.length, 0);
  assert.equal(h.actions.at(-1)?.action, 'refresh');
  assert.equal(h.actions.at(-1)?.reason, 'no_home_link');
});

test('refreshReloadAllowed: 首次放行；下限内拒绝；超下限放行', () => {
  assert.equal(refreshReloadAllowed(0, 1_000, 180_000), true);
  assert.equal(refreshReloadAllowed(1_000, 1_000 + 179_999, 180_000), false);
  assert.equal(refreshReloadAllowed(1_000, 1_000 + 180_000, 180_000), true);
});

test('session_closing：close 后命令诚实回执，绝不静默', async () => {
  const h = makeSession({ mode: 'on' });
  h.session.close();
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.actions.at(-1)?.reason, 'session_closing');
});

// ─────────── 让位探针不许撒谎（change lease-strict-preemption task 2）───────────

test('让位探针不许撒谎：命令超时放行串行链后执行体仍在写页面 → 交接 MUST 抛出，绝不回「已静默」', async () => {
  // hangOpen：读帖执行体永不返回（真实对应 CDP 卡死）。commandTimeoutMs=50 → 命令超时回诚实 timeout
  // 并**放行串行链**，但执行体仍挂在页面上 = 孤儿写者。
  const h = makeSession({ mode: 'on', hangOpen: true, commandTimeoutMs: 50 });
  await h.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
  assert.equal(h.actions.at(-1)?.reason, 'timeout', '命令已超时并放行链');
  assert.ok(
    h.logs.some((l) => l.includes('孤儿写者')),
    '超时放行链时 MUST 登记孤儿写者',
  );

  // 修复前：quiesceForTask 只 await 串行链 → 链已被超时放行 → 回 0（「页面已静默」）＝**谎话**，
  // 抢占者会在一个仍在写页面的执行体之上拿到执行权（双写）。修复后必须诚实抛出。
  await assert.rejects(
    () => h.session.quiesceForTask(200),
    (err: Error) => err.name === 'BrowseQuiesceTimeoutError',
    '孤儿写者在飞时 MUST NOT 谎称已静默',
  );
});

test('让位：命令停在动作前犹豫（安全取消点）被接管 → 秒收敛、零页面写、回诚实 preempted_by_task', async () => {
  const h = makeSession({ mode: 'on' });
  // 60s 犹豫：纯等待、平台侧零副作用。被接管应当场作废，绝不等它睡完。
  const running = h.session.onCloudCommand(
    makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE', thinkMs: 60_000 }),
  );
  await sleep(20); // 让命令跑进 thinkBefore

  const t0 = Date.now();
  assert.equal(await h.session.quiesceForTask(2_000), 0, '安全取消点上的纯等待 MUST 当场让路');
  assert.ok(Date.now() - t0 < 1_000, `交接必须秒收敛，实测 ${Date.now() - t0}ms`);
  await running;

  assert.equal(h.details.length, 0, '零页面写：帖子根本没被打开');
  assert.equal(h.actions.at(-1)?.ok, false);
  assert.equal(h.actions.at(-1)?.reason, 'preempted_by_task', '诚实回执，绝不假成功、绝不静默丢弃');
});

// ─────── 取消点补齐：FB 评论直路（change lease-strict-preemption task 4）───────

test('让位：FB 评论逐字输入中途被接管 → 清空半截评论 + 回诚实 preempted_by_task（绝不 handler_error、绝不零回执）', async () => {
  const body = '这是一条会被独占任务打断的评论';
  const replies: ActionCompletedPayload[] = [];
  const typed: string[] = [];
  let editorSelects = 0; // clearEditorBestEffort 的「全选编辑器内容」
  let backspaces = 0; // clearEditorBestEffort 的删除键（逐字输入本身不产生退格）
  let enters = 0; // FB 评论回车即发 = 提交点
  let quiesced: Promise<number> | undefined;
  let sessionRef: FacebookBrowseSession | undefined;

  const cdp = {
    send: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      const val = (v: unknown): T => ({ result: { value: v } }) as unknown as T;
      if (method === 'Input.insertText') {
        typed.push(String(params?.text ?? ''));
        // 打到第 3 个字符时独占任务发起交接：半截评论此刻**已在编辑器里**。
        if (typed.length === 3) quiesced = sessionRef?.quiesceForTask(2_000);
        return {} as T;
      }
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown') {
        if (params?.key === 'Backspace') backspaces++;
        if (params?.key === 'Enter') enters++;
        return {} as T;
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression ?? '');
        if (expr.includes('focused:focused')) return val(JSON.stringify({ found: true, focused: true, permissionGated: false }));
        if (expr.includes('selectNodeContents')) {
          editorSelects++;
          return val('selected');
        }
        return val('{}');
      }
      return {} as T;
    },
  } as unknown as BrowseCdp;

  const commentHandler = new FacebookCommentHandler({
    executor: new FacebookCommentExecutor(
      {
        cdp,
        getAccountId: () => '100000123456789',
        acceptConsent: async () => ({ handled: false, cleared: false, attempts: 0 }),
        sleep: async () => {},
        logger: () => {},
      },
      { settleMs: 0, waitAfterSubmitMs: 0 },
    ),
    client: {
      reportPageCards: () => {},
      reportNoteDetail: () => {},
      reportActionCompleted: (p: ActionCompletedPayload) => replies.push(p),
    },
    logger: () => {},
  });

  const h = makeSession({ mode: 'on', commentHandler });
  sessionRef = h.session;

  await h.session.onCloudCommand(
    makeEnv('interaction.comment', { noteId: 'https://www.facebook.com/groups/123456/posts/999', text: body }),
  );
  assert.equal(await quiesced, 0, '取消点上的命令 MUST 当场收敛，抢占者才拿得到「页面已静默」');

  // ① 半截评论 MUST 被清场：FB 侧打字前只聚焦、不清空 —— 留下的半截会直接接在下一条评论前面发出去。
  assert.ok(typed.length >= 3 && typed.length < Array.from(body).length, `输入应在中途停下，实测打了 ${typed.length} 字`);
  assert.equal(editorSelects, 1, '接管后 MUST 全选编辑器内容');
  assert.equal(backspaces, 1, '接管后 MUST 删除已打入的半截评论');
  // ② 禁区未跨：回车即发，绝不能在提交后才取消（那会把一条已发出的评论当成没发生 → 上游重发）。
  assert.equal(enters, 0, '打字段被接管 → 绝不提交');

  // ③ FB 评论走会话直路、不经浏览命令主循环 ⇒ 回执必须由 commentHandler 就地发出；
  //    抛出去只会落进会话链级 catch（只打日志、零回执）→ 云端干等超时、看门狗杀整会话。
  assert.equal(replies.length, 1, '恰好一条回执：绝不静默丢弃');
  assert.equal(replies[0].action, 'comment');
  assert.equal(replies[0].ok, false, '被接管绝不假成功');
  assert.equal(replies[0].reason, 'preempted_by_task', '被接管 = 未开始/已作废，MUST NOT 降级成 handler_error');
});

test('让位：孤儿写者在评论打字中途结束 → **绝不能**解除这条评论的取消点武装（写者重叠：判据必须按写者隔离）', async () => {
  // 本会话允许写者重叠：命令超时会放行串行链、执行体变成孤儿仍在写页面，而下一条命令已经开跑。
  // 若「我这条命令启动时的世代号」是一个共享标量，孤儿收尾时会把**正在跑的那条命令**的判据一起清掉
  // ⇒ 它的取消点全部静默失效：评论一路打完并按下回车，让位退化成「等满整条命令」。
  const body = '这是一条会被独占任务打断的评论';
  const replies: ActionCompletedPayload[] = [];
  const typed: string[] = [];
  let backspaces = 0;
  let enters = 0;
  let quiesced: Promise<number> | undefined;
  let sessionRef: FacebookBrowseSession | undefined;
  let openOrphanGate!: () => void;
  const orphanGate = new Promise<void>((r) => {
    openOrphanGate = r;
  });

  const cdp = {
    send: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      const val = (v: unknown): T => ({ result: { value: v } }) as unknown as T;
      if (method === 'Input.insertText') {
        typed.push(String(params?.text ?? ''));
        if (typed.length === 3) {
          // 半截评论已在编辑器里。此刻让**孤儿**结束——旧实现会在它的收尾里把本命令的判据清成 null。
          openOrphanGate();
          await new Promise((r) => setTimeout(r, 50)); // 让孤儿的收尾真正跑完
          quiesced = sessionRef?.quiesceForTask(2_000); // 再发起交接
        }
        return {} as T;
      }
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown') {
        if (params?.key === 'Backspace') backspaces++;
        if (params?.key === 'Enter') enters++;
        return {} as T;
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression ?? '');
        if (expr.includes('focused:focused')) return val(JSON.stringify({ found: true, focused: true, permissionGated: false }));
        if (expr.includes('selectNodeContents')) return val('selected');
        return val('{}');
      }
      return {} as T;
    },
  } as unknown as BrowseCdp;

  const commentHandler = new FacebookCommentHandler({
    executor: new FacebookCommentExecutor(
      {
        cdp,
        getAccountId: () => '100000123456789',
        acceptConsent: async () => ({ handled: false, cleared: false, attempts: 0 }),
        sleep: async () => {},
        logger: () => {},
      },
      { settleMs: 0, waitAfterSubmitMs: 0 },
    ),
    client: {
      reportPageCards: () => {},
      reportNoteDetail: () => {},
      reportActionCompleted: (p: ActionCompletedPayload) => replies.push(p),
    },
    logger: () => {},
  });

  // ① 造孤儿：读帖执行体卡在门后，命令 50ms 超时 → 回诚实 timeout 并放行串行链，执行体仍在飞。
  const h = makeSession({ mode: 'on', commentHandler, commandTimeoutMs: 50, hangOpenUntil: orphanGate });
  sessionRef = h.session;
  await h.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
  assert.equal(h.actions.at(-1)?.reason, 'timeout', '前置：读帖命令已超时并放行链');
  assert.ok(h.logs.some((l) => l.includes('孤儿写者')), '前置：孤儿写者已登记');

  // ② 孤儿在飞期间下发评论 → 打到第 3 个字符时孤儿结束，随后交接。
  await h.session.onCloudCommand(
    makeEnv('interaction.comment', { noteId: 'https://www.facebook.com/groups/123456/posts/999', text: body }),
  );
  await quiesced;

  // 旧实现（共享标量）在这里全线崩：孤儿的收尾清掉判据 ⇒ 取消点一个都不抛 ⇒ 评论打满并回车发出。
  assert.ok(
    typed.length >= 3 && typed.length < Array.from(body).length,
    `孤儿结束绝不能解除本命令的取消点武装：输入应停在中途，实测打了 ${typed.length}/${Array.from(body).length} 字`,
  );
  assert.equal(enters, 0, '禁区未跨：绝不提交一条被接管的评论');
  assert.equal(backspaces, 1, '半截评论 MUST 被清场');
  assert.equal(replies.length, 1, '恰好一条回执');
  assert.equal(replies[0].reason, 'preempted_by_task', '被接管 = 未开始/已作废');
});

test('让位：无在飞命令 / 命令已正常跑完 → 交接照常收敛回 0（不引入回归）', async () => {
  const h = makeSession({ mode: 'on' });
  assert.equal(await h.session.quiesceForTask(500), 0);
  await h.session.onCloudCommand(makeEnv('note.open', { noteId: 'https://www.facebook.com/a/posts/pfbid0ONE' }));
  assert.equal(h.details.length, 1, '正常命令照常执行');
  assert.equal(await h.session.quiesceForTask(500), 0);
});
