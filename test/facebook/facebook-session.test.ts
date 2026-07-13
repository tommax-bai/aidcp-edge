import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FacebookBrowseSession,
  parseFacebookBrowseMode,
  usesFacebookBrowseSession,
  type FacebookBrowseSessionDeps,
  type FacebookBrowseMode,
} from '../../src/facebook/facebook-session.js';
import type { FacebookCommentHandler } from '../../src/facebook/comment-handler.js';
import type { FacebookFeedReader, FacebookFeedCard } from '../../src/facebook/feed-reader.js';
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
  const state = { ensureCalls: 0, ensureUrls: [] as string[], scanCalls: 0 };

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
    scrollNext: async () => {},
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
  const h = makeSession({ mode: 'on', sleep: async (ms) => { sleeps.push(ms); } });
  await h.session.start();
  assert.equal(h.cards.length, 1, 'start 应先上报首屏，建立 dwell 锚点');

  await h.session.onCloudCommand(makeEnv('page.scroll', { dwellMs: 5000 }));

  assert.ok(sleeps.some((ms) => ms > 0), `应消费 dwellMs 产生等待，实际=${JSON.stringify(sleeps)}`);
  assert.equal(h.cards.length, 2, '等待后仍应执行 scroll 并上报新 page.cards');
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

test('profile.open direct：采本人主页昵称 → 上报 profile.detail，不走 action.completed', async () => {
  const navUrls: string[] = [];
  const h = makeSession({
    mode: 'shadow',
    cdpSend: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (method === 'Page.navigate') {
        navUrls.push(String(params?.url ?? ''));
        return {} as T;
      }
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: JSON.stringify({
              url: 'https://www.facebook.com/profile.php?id=61591701813509',
              title: 'Dennis Scott | Facebook',
              nickname: 'Dennis Scott',
              bodyTextLen: 100,
            }),
          },
        } as T;
      }
      return {} as T;
    },
  });
  await h.session.onCloudCommand(makeEnv('profile.open', { authorId: '61591701813509', direct: true }));
  assert.deepEqual(navUrls, ['https://www.facebook.com/profile.php?id=61591701813509']);
  assert.equal(h.profiles.length, 1);
  assert.equal(h.profiles[0].authorId, '61591701813509');
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

test('start(): feed 已就绪但 permalink 晚水合 → 短重试后上报 page.cards', async () => {
  let sleepCalls = 0;
  const h = makeSession({
    mode: 'shadow',
    cardBatches: [
      [],
      [],
      [{
        index: 0,
        noteId: 'https://www.facebook.com/a/posts/pfbid0LATE',
        author: 'Late',
        textPreview: 'hydrated later',
        reactionCount: 0,
        isVideo: false,
      }],
    ],
    sleep: async () => {
      sleepCalls++;
    },
  });
  await h.session.start();
  assert.equal(h.scanCalls, 3);
  assert.equal(sleepCalls, 2);
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].cards[0].noteId, 'https://www.facebook.com/a/posts/pfbid0LATE');
});

test('session_closing：close 后命令诚实回执，绝不静默', async () => {
  const h = makeSession({ mode: 'on' });
  h.session.close();
  await h.session.onCloudCommand(makeEnv('page.scroll', {}));
  assert.equal(h.actions.at(-1)?.reason, 'session_closing');
});
