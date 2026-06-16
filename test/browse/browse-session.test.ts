import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowseSession, type BrowseSessionDeps } from '../../src/browse/browse-session.js';
import type { FeedScroller, NoteCard } from '../../src/browse/feed-scroller.js';
import type { ModalController } from '../../src/browse/modal-controller.js';
import type { NoteContent } from '../../src/browse/note-extractor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import { makeEnvelope, type Envelope, type NoteContentPayload, type PageCardsPayload, type ActionCompletedPayload } from '../../src/comm/protocol.js';
import type { PlanStep, ActionResultPayload } from '../../src/comm/protocol.js';

const CARD: NoteCard = { position: 0, centerX: 10, centerY: 10, title: 'A', author: 'u', likes: '100', isVideo: false };

function fakeContent(): NoteContent {
  return {
    title: 'A',
    body: 'b',
    author: 'u',
    likes: 1,
    collects: 0,
    comments: 0,
    tags: [],
    isLiked: false,
  };
}

interface Harness {
  deps: BrowseSessionDeps;
  reportedCards: PageCardsPayload[];
  completedActions: ActionCompletedPayload[];
  openedCards: number[];
  closes: number;
  steps: PlanStep[];
}

function makeHarness(cards: NoteCard[] = [CARD]): Harness {
  const reportedCards: PageCardsPayload[] = [];
  const completedActions: ActionCompletedPayload[] = [];
  const openedCards: number[] = [];
  const steps: PlanStep[] = [];
  let closes = 0;

  const scroller: FeedScroller = {
    getVisibleCards: async () => cards,
    scrollNext: async () => {},
    openCard: async (c) => {
      openedCards.push(c.position);
    },
  };

  const modalCtrl: ModalController = {
    isModalOpen: async () => true,
    closeModal: async () => {
      closes++;
    },
    waitForModal: async () => true,
  };

  const cdp: BrowseCdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        // engage-bar 探测
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) {
          return { result: { value: true } } as never;
        }
        // note-item 查询
        if (expr.includes('note-item')) {
          return { result: { value: 10 } } as never;
        }
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };

  const client = {
    reportNoteContent: async (_payload: NoteContentPayload): Promise<Envelope> => {
      return makeEnvelope('browse.next', 'ack', 0, { reason: 'ack' });
    },
    reportPageCards: (payload: PageCardsPayload) => {
      reportedCards.push(payload);
    },
    reportNoteDetail: () => {},
    reportActionCompleted: (payload: ActionCompletedPayload) => {
      completedActions.push(payload);
    },
  };

  const stepRunner = {
    run: async (step: PlanStep): Promise<ActionResultPayload> => {
      steps.push(step);
      return { actionId: step.actionId, ok: true, outcome: 'success', attempts: 1, reason: 'ok' };
    },
  };

  const deps: BrowseSessionDeps = {
    dom: { getRoot: () => ({}) as unknown as Document },
    cdp,
    client,
    scroller,
    noteExtractor: (async () => fakeContent()) as unknown as BrowseSessionDeps['noteExtractor'],
    modalCtrl,
    stepRunner,
  };

  return {
    deps,
    reportedCards,
    completedActions,
    openedCards,
    get closes() {
      return closes;
    },
    steps,
  } as Harness;
}

function noOpts() {
  return {
    random: () => 0.99,
    sleep: async () => {},
    logger: () => {},
  };
}

/** 启动会话并延迟推送命令（等 loop 进入 waitForCommand 后再推） */
async function startAndPush(sess: BrowseSession, commands: Envelope[]): Promise<void> {
  const done = sess.start();
  // 给 start() 时间完成初始化（ensureExplore + scanDelay + reportVisibleCards）
  await new Promise(r => setTimeout(r, 10));
  for (const cmd of commands) {
    await sess.onCloudCommand(cmd);
    await new Promise(r => setTimeout(r, 1));
  }
  await done;
}

// ======== 命令驱动模式测试 ========

test('browse-session: start 后上报 page.cards', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  assert.ok(h.reportedCards.length >= 1, '应至少上报一次 page.cards');
  assert.equal(h.reportedCards[0].cards[0].title, 'A');
});

test('browse-session: 首屏 feed 延迟渲染时轮询等卡片再上报（不空报）', async () => {
  const h = makeHarness();
  // 模拟首屏未水合：前两次扫描为空，第三次才渲染出卡片。
  let calls = 0;
  h.deps.scroller = {
    ...h.deps.scroller,
    getVisibleCards: async () => {
      calls++;
      return calls >= 3 ? [CARD] : [];
    },
  };
  const sess = new BrowseSession(h.deps, { ...noOpts(), initialScanTimeoutMs: 2000 });
  await startAndPush(sess, [makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  // 轮询应等到卡片出现后才上报，而非首次空扫即静默返回。
  assert.ok(h.reportedCards.length >= 1, '延迟渲染后应仍上报 page.cards');
  assert.equal(h.reportedCards[0].cards[0].title, 'A');
});

test('browse-session: page.cards 包含 isVideo 字段', async () => {
  const videoCard: NoteCard = { position: 0, centerX: 10, centerY: 10, title: 'Video', isVideo: true };
  const h = makeHarness([videoCard]);
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  assert.equal(h.reportedCards[0].cards[0].isVideo, true);
});

test('browse-session: session.end 命令停止循环', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [makeEnvelope('session.end', 's1', 0, { reason: 'test_end' })]);
  assert.equal(sess.isRunning(), false);
});

test('browse-session: note.open 命令打开卡片并上报 note.detail', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.deepEqual(h.openedCards, [0]);
});

test('browse-session: note.open 按 noteId 命中目标卡（index 已失效也开对）', async () => {
  // 当前快照：position 0 = NPD，position 1 = LLM 卡。云端意图开 LLM（noteId=llm），
  // 但下发的 index=0 是「决策时快照」的序号、已过期。应按 noteId 开对，而非按过期 index 开 NPD。
  const cards: NoteCard[] = [
    { position: 0, centerX: 10, centerY: 10, noteId: 'npd', title: '职场NPD', isVideo: false },
    { position: 1, centerX: 10, centerY: 200, noteId: 'llm', title: 'LLM 推理', isVideo: false },
  ];
  const h = makeHarness(cards);
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('note.open', 'n1', 0, { index: 0, noteId: 'llm' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.deepEqual(h.openedCards, [1], '应按 noteId 命中 LLM 卡（position 1），而非过期 index=0 指向的 NPD');
});

test('browse-session: note.open 目标已滚走时重报当前卡片（不开邻座）', async () => {
  const cards: NoteCard[] = [
    { position: 0, centerX: 10, centerY: 10, noteId: 'aaa', title: 'A 卡', isVideo: false },
    { position: 1, centerX: 10, centerY: 200, noteId: 'bbb', title: 'B 卡', isVideo: false },
  ];
  const h = makeHarness(cards);
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('note.open', 'n1', 0, { index: 0, noteId: 'gone' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  // 目标 noteId 不在当前可见集 → 不开任何卡，且重报一次当前快照（初始 1 次 + 重报 1 次）。
  assert.equal(h.openedCards.length, 0, '目标已滚走时不应开邻座');
  assert.ok(h.reportedCards.length >= 2, '应重报当前卡片让云端按现状重判');
});

test('browse-session: browse.scroll 命令触发滚动并上报新卡片', async () => {
  const h = makeHarness();
  let scrolled = false;
  h.deps.scroller = {
    ...h.deps.scroller,
    scrollNext: async () => { scrolled = true; },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('browse.scroll', 'bs1', 0, { reason: 'scroll' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(scrolled, true);
  // 初始上报 + scroll 后再次上报
  assert.ok(h.reportedCards.length >= 2);
});

test('browse-session: plan.response 命令执行步骤', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('plan.response', 'p1', 0, {
      steps: [{ actionId: 'note.like_button', op: 'click', goal: '点赞' }],
      reason: 'like it',
    }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(h.steps.length, 1);
  assert.equal(h.steps[0].actionId, 'note.like_button');
});

test('browse-session: stop() 从外部停止循环', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise(r => setTimeout(r, 10));
  sess.stop();
  await done;
  assert.equal(sess.isRunning(), false);
});

test('browse-session: interaction.like 命令执行点赞并上报结果', async () => {
  const h = makeHarness();
  // Mock CDP 返回按钮坐标（模拟未点赞状态 → 点击 → 变为 #liked）
  let clickCount = 0;
  let likeCallIndex = 0;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        // like-wrapper 检查必须在 engage-bar 之前
        if (expr.includes('like-wrapper')) {
          likeCallIndex++;
          if (likeCallIndex === 1) {
            // 第一次调用：返回按钮坐标
            return { result: { value: JSON.stringify({ x: 100, y: 200, href: '#like' }) } } as never;
          } else {
            // 第二次调用（验证）：返回 #liked
            return { result: { value: '#liked' } } as never;
          }
        }
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      if (method === 'Input.dispatchMouseEvent') {
        clickCount++;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.like', 'l1', 0, { noteId: 'n1' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  // 应上报 action.completed
  const likeResult = h.completedActions.find(a => a.action === 'like');
  assert.ok(likeResult);
  assert.equal(likeResult!.ok, true);
});

test('browse-session: interaction.like 已点赞时上报 already_liked', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        // like-wrapper 检查必须在 engage-bar 之前（like 表达式包含 engage-bar）
        if (expr.includes('like-wrapper')) {
          return { result: { value: JSON.stringify({ error: 'already' }) } } as never;
        }
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.like', 'l1', 0, { noteId: 'n1' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const likeResult = h.completedActions.find(a => a.action === 'like');
  assert.ok(likeResult);
  assert.equal(likeResult!.ok, false);
  assert.equal(likeResult!.reason, 'already_liked');
});

test('browse-session: 命令在 loop 等待期间推入能被消费', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  // 启动后等 loop 进入 waitForCommand，再推入 session.end
  const done = sess.start();
  await new Promise(r => setTimeout(r, 10));
  await sess.onCloudCommand(makeEnvelope('session.end', 's1', 0, { reason: 'queued-during-loop' }));
  await done;
  assert.equal(sess.isRunning(), false);
});

test('browse-session: search.execute 命令触发搜索', async () => {
  const h = makeHarness();
  const calls: string[] = [];
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push(method);
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        if (expr.includes('location.href')) return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
        return { result: { value: true } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('search.execute', 'se1', 0, { keyword: '奶茶' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(calls.includes('Input.dispatchKeyEvent'), '应触发键盘输入搜索');
});

test('browse-session: note.browse_images 使用 Cloud 指定的 count', async () => {
  const h = makeHarness();
  let evalCalls = 0;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        evalCalls++;
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        if (expr.includes('swiper-wrapper')) return { result: { value: JSON.stringify({ count: 10 }) } } as never;
        if (expr.includes('swiper-button-next')) return { result: { value: undefined } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const logs: string[] = [];
  const sess = new BrowseSession(h.deps, { ...noOpts(), logger: (m) => logs.push(m) });
  await startAndPush(sess, [
    makeEnvelope('note.browse_images', 'bi1', 0, { noteId: 'n1', count: 4 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(logs.some(l => l.includes('浏览了 4 张图片')), '应浏览 Cloud 指定的 4 张');
  assert.ok(h.completedActions.some(a => a.action === 'browse_images' && a.ok));
});

test('browse-session: note.scroll_comments 使用 Cloud 指定的 count', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        if (expr.includes('comments-container') || expr.includes('note-comment')) return { result: { value: 'ok' } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const logs: string[] = [];
  const sess = new BrowseSession(h.deps, { ...noOpts(), logger: (m) => logs.push(m) });
  await startAndPush(sess, [
    makeEnvelope('note.scroll_comments', 'sc1', 0, { noteId: 'n1', count: 5 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(logs.some(l => l.includes('评论区滚动完成') && l.includes('5 次')));
  assert.ok(h.completedActions.some(a => a.action === 'scroll_comments' && a.ok));
});
