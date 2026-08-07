import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FacebookBrowseSession,
  computeInlineReadFloorMs,
  type FacebookBrowseSessionDeps,
  type FacebookBrowseMode,
} from '../../src/facebook/facebook-session.js';
import type { FacebookCommentHandler } from '../../src/facebook/comment-handler.js';
import type { FacebookFeedReader, FacebookFeedCard, FacebookFeedSettleResult } from '../../src/facebook/feed-reader.js';
import type { FacebookPostReader, FacebookPostDetail } from '../../src/facebook/post-reader.js';
import type { FacebookLikeExecutor, FacebookLikeResult } from '../../src/facebook/like-executor.js';
import type { FacebookInlineReader, FacebookInlineReadResult } from '../../src/facebook/inline-reader.js';
import type { Envelope, ActionCompletedPayload, NoteDetailPayload, PageCardsPayload, ProfileDetailPayload } from '../../src/comm/protocol.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

/**
 * C2 会话集成（change facebook-feed-inline-browse）：note.open surface/purpose 分流、postId 游标只报新卡 +
 * feed_exhausted、就地读停留地板、点赞独立见证按 surface gate。逐位守 XHS/detail 零回归。
 */

function makeEnv(type: string, payload: unknown = {}): Envelope {
  return { v: 2, type, id: `cmd-${type}`, ts: 0, payload } as unknown as Envelope;
}

const A = 'https://www.facebook.com/a/posts/pfbidAAA';
const B = 'https://www.facebook.com/b/posts/pfbidBBB';
const C = 'https://www.facebook.com/c/posts/pfbidCCC';
function fbCard(noteId: string, i = 0): FacebookFeedCard {
  return { index: i, noteId, author: 'auth', textPreview: 't', reactionCount: 1, isVideo: false };
}

interface Harness {
  session: FacebookBrowseSession;
  cards: PageCardsPayload[];
  details: NoteDetailPayload[];
  actions: ActionCompletedPayload[];
  profiles: ProfileDetailPayload[];
  postOpenCalls: string[];
  inlineCalls: string[];
}

function makeSession(opts: {
  mode?: FacebookBrowseMode;
  settle?: (call: number) => FacebookFeedSettleResult;
  inline?: FacebookInlineReadResult;
  like?: FacebookLikeResult;
  detail?: Partial<FacebookPostDetail>;
  cdp?: BrowseCdp;
}): Harness {
  const cards: PageCardsPayload[] = [];
  const details: NoteDetailPayload[] = [];
  const actions: ActionCompletedPayload[] = [];
  const profiles: ProfileDetailPayload[] = [];
  const postOpenCalls: string[] = [];
  const inlineCalls: string[] = [];
  let settleCall = 0;

  const client = {
    reportPageCards: (p: PageCardsPayload) => cards.push(p),
    reportNoteDetail: (p: NoteDetailPayload) => details.push(p),
    reportProfileDetail: (p: ProfileDetailPayload) => profiles.push(p),
    reportActionCompleted: (p: ActionCompletedPayload) => actions.push(p),
  };
  const commentHandler = { handle: async () => {} } as unknown as FacebookCommentHandler;
  const feedReader = {
    ensureFeed: async () => ({ ok: true as const }),
    scanCards: async () => [],
    scrollNext: async () => {},
    scrollMetrics: async () => ({ scrollY: 0, scrollHeight: 5000, innerHeight: 900 }),
    settleCards: async () => (opts.settle ? opts.settle(settleCall++) : { cards: [fbCard(A)], degraded: false }),
    clickHomeAndScrollTop: async () => ({ ok: true as const }),
  } as unknown as FacebookFeedReader;
  const postReader = {
    openAndRead: async (permalink: string): Promise<FacebookPostDetail> => {
      postOpenCalls.push(permalink);
      return {
        ok: true,
        permalink,
        body: 'detail body',
        comments: [],
        reactionCount: 7,
        commentCount: 0,
        isVideo: false,
        author: 'Alice',
        ...opts.detail,
      };
    },
  } as unknown as FacebookPostReader;
  const likeExecutor = {
    like: async (): Promise<FacebookLikeResult> => opts.like ?? { ok: true, executed: true },
  } as unknown as FacebookLikeExecutor;
  const inlineReader = {
    openAndReadInline: async (noteId?: string): Promise<FacebookInlineReadResult> => {
      inlineCalls.push(String(noteId ?? ''));
      return opts.inline ?? { ok: true, permalinkHref: A, postId: 'fb:pfbidAAA', body: 'inline full body', reactionCount: 9, author: 'iQIYI', isVideo: false, articleIndex: 0 };
    },
  } as unknown as FacebookInlineReader;

  const deps: FacebookBrowseSessionDeps = {
    cdp: opts.cdp ?? ({ send: async () => ({}) } as unknown as BrowseCdp),
    client,
    commentHandler,
    feedReader,
    postReader,
    likeExecutor,
    inlineReader,
    logger: () => {},
    sleep: async () => {},
  };
  const session = new FacebookBrowseSession(deps, { mode: opts.mode ?? 'on', commandTimeoutMs: 90_000, feedUrl: 'https://www.facebook.com/' });
  return { session, cards, details, actions, profiles, postOpenCalls, inlineCalls };
}

// ─────────────────────────── note.open surface / purpose 分流 ───────────────────────────

test('note.open surface=feed → 就地读 → note.detail（noteId 页面派生），不导航详情', async () => {
  const h = makeSession({ inline: { ok: true, permalinkHref: A, postId: 'fb:pfbidAAA', body: 'inline full body', reactionCount: 9, author: 'iQIYI', isVideo: false, articleIndex: 0 } });
  await h.session.onCloudCommand(makeEnv('facebook.note.open', { noteId: A, surface: 'feed' }));
  assert.equal(h.details.length, 1);
  assert.equal(h.details[0].noteId, A);
  assert.equal(h.details[0].content, 'inline full body');
  assert.equal(h.details[0].likeCount, 9);
  assert.equal(h.details[0].collectCount, 0);
  assert.equal(h.inlineCalls.length, 1, '走了就地读');
  assert.equal(h.postOpenCalls.length, 0, '绝不导航详情');
});

test('note.open 缺省 surface=detail → 导航详情深读（今天行为，inline 不触发）', async () => {
  const h = makeSession({});
  await h.session.onCloudCommand(makeEnv('facebook.note.open', { noteId: A }));
  assert.equal(h.details.length, 1);
  assert.equal(h.postOpenCalls.length, 1, '走详情导航');
  assert.equal(h.inlineCalls.length, 0, 'inline 不触发');
});

test('note.open purpose=navigate → 落地详情但 MUST NOT 上报 note.detail，只回 action.completed', async () => {
  const h = makeSession({});
  await h.session.onCloudCommand(makeEnv('facebook.note.open', { noteId: A, purpose: 'navigate' }));
  assert.equal(h.details.length, 0, 'navigate 绝不上报 note.detail');
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].action, 'open_note');
  assert.equal(h.actions[0].ok, true);
  assert.equal(h.actions[0].noteId, A);
  assert.equal((h.actions[0].observation as { surface?: string })?.surface, 'detail');
});

test('note.open surface=feed 环境变化 → 回落 detail 导航（诚实读详情）', async () => {
  const h = makeSession({ inline: { ok: false, reason: 'context_changed' } });
  await h.session.onCloudCommand(makeEnv('facebook.note.open', { noteId: A, surface: 'feed' }));
  assert.equal(h.inlineCalls.length, 1);
  assert.equal(h.postOpenCalls.length, 1, 'context_changed → 回落详情导航');
  assert.equal(h.details.length, 1, '回落后照实上报 note.detail');
});

test('note.open surface=feed 诚实失败（no_target）→ action.completed，不假 note.detail', async () => {
  const h = makeSession({ inline: { ok: false, reason: 'no_target' } });
  await h.session.onCloudCommand(makeEnv('facebook.note.open', { noteId: A, surface: 'feed' }));
  assert.equal(h.details.length, 0);
  assert.equal(h.actions[0].action, 'open_note');
  assert.equal(h.actions[0].ok, false);
  assert.equal(h.actions[0].reason, 'no_target');
});

// ─────────────────────────── postId 游标：只报新卡 + feed_exhausted ───────────────────────────

test('page.scroll 只上报未见过的新卡（回收重现被滤掉）', async () => {
  // settle(0)=首屏[A,B]；settle(1)=滚动后[A,B,C]（A/B 回收重现）→ 只报 C。
  const h = makeSession({
    settle: (call) =>
      call === 0
        ? { cards: [fbCard(A), fbCard(B, 1)], degraded: false }
        : { cards: [fbCard(A), fbCard(B, 1), fbCard(C, 2)], degraded: false },
  });
  await h.session.start(); // 首屏
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].cards.length, 2, '首屏播种 A,B');
  await h.session.onCloudCommand(makeEnv('facebook.feed.scroll', {}));
  assert.equal(h.cards.length, 2);
  assert.equal(h.cards[1].cards.length, 1, '滚动只报新卡 C');
  assert.equal(h.cards[1].cards[0].noteId, C);
  assert.equal(h.cards[1].cards[0].index, 0, '新卡连续重排 index');
});

test('page.scroll 连续无新卡（全回收重现）→ 有界续滚后 feed_exhausted', async () => {
  const h = makeSession({ settle: () => ({ cards: [fbCard(A), fbCard(B, 1)], degraded: false }) });
  await h.session.start(); // 首屏播种 A,B
  await h.session.onCloudCommand(makeEnv('facebook.feed.scroll', {}));
  const last = h.actions[h.actions.length - 1];
  assert.equal(last.action, 'scroll');
  assert.equal(last.ok, false);
  assert.equal(last.reason, 'feed_exhausted');
  assert.equal(h.cards.length, 1, '无新卡时不重复上报 page.cards');
});

test('feed.refresh 换批成功 → 重置游标，随后 scroll 重新把换批后的卡当新报', async () => {
  // 首屏[A]；refresh 后首卡变 B（换批成功，beforeTop=A≠afterTop=B）；再 scroll settle=[B,C] → 报 C（B 已随 refresh 播种）。
  let phase = 0;
  const h = makeSession({
    settle: () => {
      phase++;
      if (phase === 1) return { cards: [fbCard(A)], degraded: false }; // 首屏
      if (phase === 2) return { cards: [fbCard(B)], degraded: false }; // refresh 后
      return { cards: [fbCard(B), fbCard(C, 1)], degraded: false }; // scroll
    },
  });
  await h.session.start();
  await h.session.onCloudCommand(makeEnv('facebook.feed.refresh', {}));
  assert.equal(h.cards.length, 2);
  assert.equal(h.cards[1].cards[0].noteId, B, 'refresh 报换批后的 B');
  await h.session.onCloudCommand(makeEnv('facebook.feed.scroll', {}));
  assert.equal(h.cards.length, 3);
  assert.equal(h.cards[2].cards.length, 1);
  assert.equal(h.cards[2].cards[0].noteId, C, 'B 已随 refresh 播种，scroll 只报新的 C');
});

// ─────────────────────────── 点赞独立见证按 surface gate ───────────────────────────

test('facebook.note.like feed 面 → 回执挂 noteId + observation（激活云端仲裁）', async () => {
  const h = makeSession({ like: { ok: true, executed: true, observation: { surface: 'feed', noteId: 'fb:pfbidAAA', author: 'iQIYI', articleIndex: 2 } } });
  await h.session.onCloudCommand(makeEnv('facebook.note.like', { noteId: A }));
  const a = h.actions[0];
  assert.equal(a.action, 'like');
  assert.equal(a.ok, true);
  assert.equal(a.noteId, 'fb:pfbidAAA');
  assert.equal((a.observation as { surface?: string })?.surface, 'feed');
});

test('facebook.note.like detail 面 → 回执不挂 noteId/observation（逐位等于今天，零回归）', async () => {
  const h = makeSession({ like: { ok: true, executed: true, observation: { surface: 'detail', noteId: 'fb:pfbidAAA' } } });
  await h.session.onCloudCommand(makeEnv('facebook.note.like', { noteId: A }));
  const a = h.actions[0];
  assert.equal(a.action, 'like');
  assert.equal(a.ok, true);
  assert.equal(a.noteId, undefined, 'detail 面不挂 noteId');
  assert.equal(a.observation, undefined, 'detail 面不挂 observation');
});

// ─────────────────────────── 就地读停留地板（纯函数）───────────────────────────

test('computeInlineReadFloorMs: 按字数线性、封顶、乘 tempo', () => {
  assert.equal(computeInlineReadFloorMs(0, 1), 1200);
  assert.equal(computeInlineReadFloorMs(100, 1), 1200 + 100 * 20);
  assert.equal(computeInlineReadFloorMs(100000, 1), 9000, '封顶 9000');
  assert.equal(computeInlineReadFloorMs(0, 1.6), Math.round(1200 * 1.6), 'tempo 放大');
});
