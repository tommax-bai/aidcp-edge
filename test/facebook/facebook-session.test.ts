import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FacebookBrowseSession,
  facebookActionNameForCommand,
  parseFacebookBrowseMode,
  usesFacebookBrowseSession,
  refreshReloadAllowed,
  type FacebookBrowseSessionDeps,
  type FacebookBrowseMode,
} from '../../src/facebook/facebook-session.js';
import type { FacebookCommentHandler } from '../../src/facebook/comment-handler.js';
import type {
  FacebookFeedReader,
  FacebookFeedCard,
  FacebookFeedSettleResult,
  FacebookHomeRefreshResult,
} from '../../src/facebook/feed-reader.js';
import type { FacebookPostReader, FacebookPostDetail } from '../../src/facebook/post-reader.js';
import type { FacebookLikeExecutor, FacebookLikeResult } from '../../src/facebook/like-executor.js';
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
  likeShadowFlags: Array<boolean | undefined>;
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
  cdpSend?: BrowseCdp['send'];
} = {}): Harness {
  const cards: PageCardsPayload[] = [];
  const details: NoteDetailPayload[] = [];
  const profiles: ProfileDetailPayload[] = [];
  const actions: ActionCompletedPayload[] = [];
  const logs: string[] = [];
  const delegated: Envelope[] = [];
  const likeShadowFlags: Array<boolean | undefined> = [];
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
  const commentHandler = {
    handle: async (env: Envelope) => {
      delegated.push(env);
    },
  } as unknown as FacebookCommentHandler;
  const feedReader = {
    ensureFeed: async (url: string) => {
      state.ensureCalls++;
      state.ensureUrls.push(url);
      return { ok: true as const };
    },
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
  } as unknown as FacebookFeedReader;
  const postReader = {
    openAndRead: async (permalink: string): Promise<FacebookPostDetail> => {
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

  const deps: FacebookBrowseSessionDeps = {
    cdp: { send: opts.cdpSend ?? (async () => ({})) } as unknown as BrowseCdp,
    client,
    commentHandler,
    feedReader,
    postReader,
    likeExecutor,
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
    get ensureCalls() {
      return state.ensureCalls;
    },
    get ensureUrls() {
      return state.ensureUrls;
    },
    get scanCalls() {
      return state.scanCalls;
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
});

test('co-landing: FacebookBrowseSession 满足 EdgeBrowseSession 契约（9 方法）', async () => {
  const { session } = makeSession();
  for (const m of ['start', 'onCloudCommand', 'stop', 'close', 'quiesceForTask', 'resumeAfterTask', 'discardQueuedCloudCommands', 'applyPacingSnapshot', 'recoverAfterCloudReconnect']) {
    assert.equal(typeof (session as unknown as Record<string, unknown>)[m], 'function', `缺方法 ${m}`);
  }
  assert.equal(await session.quiesceForTask(), 0);
});

// ─────────────────────────── kill switch 解析 ───────────────────────────

test('parseFacebookBrowseMode: 默认 off；shadow/on 三态', () => {
  assert.equal(parseFacebookBrowseMode({}), 'off');
  assert.equal(parseFacebookBrowseMode({ AIDCP_FB_BROWSE_AUTO: 'shadow' }), 'shadow');
  assert.equal(parseFacebookBrowseMode({ AIDCP_FB_BROWSE_AUTO: 'on' }), 'on');
  assert.equal(parseFacebookBrowseMode({ AIDCP_FB_BROWSE_AUTO: 'true' }), 'on');
  assert.equal(parseFacebookBrowseMode({ AIDCP_FB_BROWSE_AUTO: 'garbage' }), 'off');
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

test('profile.open direct：就地读本人昵称（id 锚定头像标签）→ 上报 profile.detail，绝不导航、不走 action.completed（change facebook-nickname-capture-timing）', async () => {
  const navUrls: string[] = [];
  const scan = JSON.stringify({
    href: 'https://www.facebook.com/',
    profileHrefs: ['https://www.facebook.com/profile.php?id=61591701813509'],
    profileAnchors: [{ href: 'https://www.facebook.com/profile.php?id=61591701813509', ariaLabel: "Dennis Scott's profile picture" }],
    displayName: null, h1: null, ogTitle: null, title: 'Facebook',
  });
  const h = makeSession({
    mode: 'shadow',
    cdpSend: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (method === 'Page.navigate') {
        navUrls.push(String(params?.url ?? ''));
        return {} as T;
      }
      if (method === 'Network.getAllCookies') {
        return { cookies: [{ name: 'c_user', value: '61591701813509', domain: '.facebook.com' }] } as T;
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: scan } } as T;
      }
      return {} as T;
    },
  });
  await h.session.onCloudCommand(makeEnv('profile.open', { authorId: '61591701813509', direct: true }));
  assert.deepEqual(navUrls, [], '本人昵称采集就地读、绝不导航（facebook-identity「取昵称绝不导航」契约）');
  assert.equal(h.profiles.length, 1);
  assert.equal(h.profiles[0].authorId, '61591701813509', 'authorId 用就地读到的数字 id（自校验）');
  assert.equal(h.profiles[0].nickname, 'Dennis Scott');
  assert.equal(h.profiles[0].extracted, false, 'FB v1 不臆造主页数字');
  assert.equal(h.actions.length, 0, 'profile.detail 即回执，不额外 action.completed');
});

// ─────────────────────────── 不支持命令诚实回执 ───────────────────────────

test('FB v1 不支持的命令 → capability_unsupported（绝不静默丢弃）', async () => {
  const h = makeSession({ mode: 'on' });
  await h.session.onCloudCommand(makeEnv('interaction.collect', { noteId: 'x' }));
  await h.session.onCloudCommand(makeEnv('interaction.follow', { authorId: 'a' }));
  await h.session.onCloudCommand(makeEnv('profile.open', { authorId: 'a' }));
  assert.equal(h.actions.length, 3);
  assert.ok(h.actions.every((a) => a.reason === 'capability_unsupported'));
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
