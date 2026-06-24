import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowseSession, type BrowseSessionDeps } from '../../src/browse/browse-session.js';
import type { FeedScroller, NoteCard } from '../../src/browse/feed-scroller.js';
import type { ModalController } from '../../src/browse/modal-controller.js';
import type { NoteContent } from '../../src/browse/note-extractor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import { makeEnvelope, type Envelope, type NoteContentPayload, type PageCardsPayload, type ActionCompletedPayload, type ProfileDetailPayload } from '../../src/comm/protocol.js';
import type { PlanStep, ActionResultPayload } from '../../src/comm/protocol.js';
import type { OverlayKind, OverlayMonitor } from '../../src/browse/overlay-monitor.js';
import { CdpDisconnectedError } from '../../src/cdp/client.js';

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
  reportedProfiles: ProfileDetailPayload[];
  openedCards: number[];
  closes: number;
  steps: PlanStep[];
}

function makeHarness(cards: NoteCard[] = [CARD]): Harness {
  const reportedCards: PageCardsPayload[] = [];
  const completedActions: ActionCompletedPayload[] = [];
  const reportedProfiles: ProfileDetailPayload[] = [];
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
        // 图片轮播探测（含 swiper-slide）→ 命中 5 张，可翻页
        if (expr.includes('swiper-slide')) {
          return { result: { value: '{"total":5,"hasNext":true}' } } as never;
        }
        // 翻图点击（含 swiper-button-next，不含 swiper-slide）→ 点中
        if (expr.includes('swiper-button-next')) {
          return { result: { value: true } } as never;
        }
        // 评论区滚动（新实现：单次 eval 内 overflow 上溯 + scrollBy + 返回 before/after）→ 模拟真实位移
        if (expr.includes('overflowY')) {
          return { result: { value: '{"found":true,"before":0,"after":360}' } } as never;
        }
        // 评论区探测（旧路径兼容）
        if (expr.includes('comments-container')) {
          return { result: { value: '{"found":true}' } } as never;
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
    reportProfileDetail: (payload: ProfileDetailPayload) => {
      reportedProfiles.push(payload);
    },
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
    reportedProfiles,
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

// ======== executeComment（发评论）测试：绝不静默假成功 ========

function commentHarness(opts: { editorError?: boolean; verify?: { cleared: boolean; ownRow: boolean } }): Harness {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params.expression ?? '');
      if (expr.includes('ownRow')) {
        return { result: { value: JSON.stringify(opts.verify ?? { cleared: true, ownRow: true }) } } as never;
      }
      if (expr.includes('content-textarea')) {
        return { result: { value: opts.editorError ? '{"error":"no-editor"}' : '{"x":200,"y":200}' } } as never;
      }
      if (expr.includes('btn.submit')) {
        return { result: { value: '{"x":300,"y":300}' } } as never;
      }
      if (expr.includes('content-edit')) {
        return { result: { value: '{"x":100,"y":100}' } } as never;
      }
      if (expr.includes('engage-bar')) return { result: { value: true } } as never;
      return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
    },
  };
  return h;
}

test('executeComment: 编辑器清空且自己的评论行出现 → ok:true', async () => {
  const h = commentHarness({ verify: { cleared: true, ownRow: true } });
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.comment', 'c1', 0, { noteId: 'n1', text: '赞' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const c = h.completedActions.find((a) => a.action === 'comment');
  assert.ok(c, '应上报 comment 结果');
  assert.equal(c!.ok, true);
});

test('executeComment: 找不到编辑器 → ok:false reason no_target（不假成功）', async () => {
  const h = commentHarness({ editorError: true });
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.comment', 'c1', 0, { noteId: 'n1', text: '赞' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const c = h.completedActions.find((a) => a.action === 'comment');
  assert.ok(c);
  assert.equal(c!.ok, false);
  assert.equal(c!.reason, 'no_target');
});

test('executeComment: 提交后未确认生效 → ok:false reason state_unchanged（不假成功）', async () => {
  const h = commentHarness({ verify: { cleared: false, ownRow: false } });
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.comment', 'c1', 0, { noteId: 'n1', text: '赞' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const c = h.completedActions.find((a) => a.action === 'comment');
  assert.ok(c);
  assert.equal(c!.ok, false);
  assert.equal(c!.reason, 'state_unchanged');
});

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

test('browse-session: interaction.follow 已关注 → 良性 no-op 成功 ok:true + already_followed（非失败）', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        // follow 按钮探测：已关注
        if (expr.includes('follow-button')) {
          return { result: { value: JSON.stringify({ already: true }) } } as never;
        }
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.follow', 'f1', 0, { authorId: 'a1' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const followResult = h.completedActions.find(a => a.action === 'follow');
  assert.ok(followResult);
  assert.equal(followResult!.ok, true, 'already_followed 应报良性成功，而非失败');
  assert.equal(followResult!.reason, 'already_followed');
});

test('browse-session: interaction.follow 找不到按钮 → ok:false + btn_no-btn（真失败仍如实）', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        if (expr.includes('follow-button')) {
          return { result: { value: JSON.stringify({ error: 'no-btn' }) } } as never;
        }
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.follow', 'f2', 0, { authorId: 'a1' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const followResult = h.completedActions.find(a => a.action === 'follow');
  assert.ok(followResult);
  assert.equal(followResult!.ok, false, '找不到按钮是真失败');
  assert.equal(followResult!.reason, 'btn_no-btn');
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

test('browse-session: note.browse_images 命中轮播 → 如实回报 browsed=N', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('note.browse_images', 'bi1', 0, { noteId: 'n1', count: 4 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'browse_images');
  assert.ok(act && act.ok, '命中轮播应 ok:true');
  assert.match(String(act!.reason ?? ''), /browsed=/, '应回报实际浏览张数');
});

test('browse-session: note.browse_images 无轮播 → no_target 不假报成功', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        if (expr.includes('swiper-slide')) return { result: { value: '{"total":0,"hasNext":false}' } } as never;
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('note.browse_images', 'bi2', 0, { noteId: 'n1', count: 3 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'browse_images');
  assert.ok(act && act.ok === false && act.reason === 'no_target', '无轮播应 ok:false reason:no_target');
});

test('browse-session: note.scroll_comments 命中评论区 → 如实回报 scrolled=N', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('note.scroll_comments', 'sc1', 0, { noteId: 'n1', count: 5 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'scroll_comments');
  assert.ok(act && act.ok, '命中评论区应 ok:true');
  assert.match(String(act!.reason ?? ''), /scrolled=5/);
});

test('browse-session: note.scroll_comments 无评论区 → no_target', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        if (expr.includes('comments-container')) return { result: { value: '{"found":false}' } } as never;
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('note.scroll_comments', 'sc2', 0, { noteId: 'n1', count: 3 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'scroll_comments');
  assert.ok(act && act.ok === false && act.reason === 'no_target');
});

test('browse-session: note.scroll_comments 命中但不可滚/已到底（scrollTop 无位移）→ no_scroll（不假报成功）', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        // 命中可滚动容器但 scrollTop 始终不变（已到底/不可滚）
        if (expr.includes('overflowY')) return { result: { value: '{"found":true,"before":500,"after":500}' } } as never;
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('note.scroll_comments', 'sc3', 0, { noteId: 'n1', count: 3 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'scroll_comments');
  assert.ok(act && act.ok === false && act.reason === 'no_scroll', `应回报 no_scroll，实际 ${JSON.stringify(act)}`);
});

test('browse-session: profile.open 进主页抽到资料 → reportProfileDetail extracted:true', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        if (expr.includes('author-wrapper')) return { result: { value: '{"href":"/user/profile/abc123"}' } } as never;
        if (expr.includes('user-interactions')) return { result: { value: '{"authorId":"","followers":"1.2万","posts":"88","lc":"6707"}' } } as never;
        if (expr.includes('user-page') || expr.includes('userInfo')) return { result: { value: true } } as never;
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('profile.open', 'po1', 0, { authorId: 'abc123' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(h.reportedProfiles.length, 1, '应上报一次 profile.detail');
  const p = h.reportedProfiles[0];
  assert.equal(p.extracted, true);
  assert.equal(p.followersCount, 12000, '1.2万 → 12000');
  assert.equal(p.postsCount, 88);
  assert.equal(p.likesCollects, 6707, '获赞与收藏 6707 应被抽取并串到 payload');
  assert.equal(p.authorId, 'abc123', '无 URL id 时回退 payload authorId');
});

test('browse-session: profile.open 找不到作者入口 → 上报 extracted:false（保守兜底）', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        if (expr.includes('author-wrapper')) return { result: { value: '{"error":"no_author"}' } } as never;
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('profile.open', 'po2', 0, { authorId: 'abc123' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(h.reportedProfiles.length, 1);
  assert.equal(h.reportedProfiles[0].extracted, false, '抽取失败应 extracted:false');
});

// ======== 指令级节奏（Command Pacing）测试 ========

/** 捕获 sleep 时长 + 可控时钟的 opts。 */
function pacingOpts(sleeps: number[], now: () => number) {
  return {
    random: () => 0.5, // 固定随机源 → gaussian/jitter 确定性
    sleep: async (ms: number) => { sleeps.push(ms); },
    logger: () => {},
    now,
  };
}

// dwellMs=30000 远超所有停顿预设上限（cardGap≤12000 / reading≤15000），
// 故"> 16000 的 sleep"只可能来自详情页停留兜底，可干净隔离。
const DWELL_SENTINEL = 30000;
const ISOLATE = 16000;

test('pacing: navigation.back 带 dwellMs 且停留不足 → 兜底停留（治秒退）', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const sess = new BrowseSession(h.deps, pacingOpts(sleeps, () => 1000)); // 时钟恒定 → 已停留≈0
  await startAndPush(sess, [
    makeEnvelope('note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('navigation.back', 'b', 0, { reason: 'quality_rejected', targetPage: 'feed', dwellMs: DWELL_SENTINEL }),
    makeEnvelope('session.end', 'e', 0, { reason: 'end' }),
  ]);
  assert.ok(sleeps.some((ms) => ms > ISOLATE), `应有一次≈dwellMs的兜底停留，实际: ${sleeps}`);
});

test('pacing: 真实阅读已超过 dwellMs → 不叠加等待（无双重延迟）', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  // 时钟每次调用 +40000ms：note.open 取 t0，back 时 elapsed≈40000 > 抖动后目标 → 不再补停。
  let t = 1000;
  const now = () => { const v = t; t += 40000; return v; };
  const sess = new BrowseSession(h.deps, pacingOpts(sleeps, now));
  await startAndPush(sess, [
    makeEnvelope('note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('navigation.back', 'b', 0, { reason: 'quality_rejected', targetPage: 'feed', dwellMs: DWELL_SENTINEL }),
    makeEnvelope('session.end', 'e', 0, { reason: 'end' }),
  ]);
  assert.ok(!sleeps.some((ms) => ms > ISOLATE), `已读够不应再兜底停留，实际: ${sleeps}`);
});

test('pacing: navigation.back 缺 dwellMs（旧云端）仍非零停留（不秒退）', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const sess = new BrowseSession(h.deps, pacingOpts(sleeps, () => 1000));
  await startAndPush(sess, [
    makeEnvelope('note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('navigation.back', 'b', 0, { reason: 'quality_rejected', targetPage: 'feed' }), // 无 dwellMs
    makeEnvelope('session.end', 'e', 0, { reason: 'end' }),
  ]);
  // 内置下限 [1200,2600] 采样后抖动 → 必有一次落在该量级的兜底停留（> 1000ms）。
  assert.ok(sleeps.some((ms) => ms >= 1000), `缺 dwellMs 也应有内置下限兜底，实际: ${sleeps}`);
});

test('pacing: interaction.like 的 thinkMs → 执行前犹豫等待', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const sess = new BrowseSession(h.deps, pacingOpts(sleeps, () => 1000));
  await startAndPush(sess, [
    makeEnvelope('note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('interaction.like', 'l', 0, { noteId: 'x', thinkMs: DWELL_SENTINEL }),
    makeEnvelope('session.end', 'e', 0, { reason: 'end' }),
  ]);
  assert.ok(sleeps.some((ms) => ms > ISOLATE), `点赞前应有 thinkMs 犹豫，实际: ${sleeps}`);
});

// 回归：云端 back_to_feed 实际下发的 navigation.back【不带 targetPage】（生产路径）。
// 修复前 undefined 落进 else 分支（裸 history.back + 固定 sleep + 瞬时扫描），feed 未水合即扫到
// 0 卡 → reportVisibleCards 静默不发 page.cards → 边端死等命令、云端死等上报 → 边-云互等死锁。
// 修复后 undefined 等同 'feed'：走 waitForVisibleCards 轮询，等水合出卡再上报。
test('browse-session: navigation.back 无 targetPage（back_to_feed 生产路径）轮询等水合再上报，不静默死锁', async () => {
  const h = makeHarness();
  const origSend = h.deps.cdp.send;
  let wentBack = false;
  let pollsAfterBack = 0;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate' && String(params.expression ?? '').includes('history.back()')) {
        wentBack = true;
      }
      return origSend(method, params);
    },
  };
  // 初始扫描有卡；back 之后模拟 feed 延迟水合：前 3 次轮询为空，之后才出卡。
  h.deps.scroller = {
    ...h.deps.scroller,
    getVisibleCards: async () => {
      if (!wentBack) return [CARD];
      pollsAfterBack++;
      return pollsAfterBack <= 3 ? [] : [CARD];
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('navigation.back', 'b', 0, { reason: 'back_to_feed' }), // 无 targetPage：复刻云端实际报文
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(
    h.completedActions.some((a) => a.action === 'back' && a.ok),
    'navigation.back 应回报 action.completed{back, ok:true}',
  );
  // 关键断言：back 后必须等水合再上报 page.cards（初始 1 次 + back 后 1 次）。
  // 修复前 else 分支瞬时扫到 0 卡会静默 → 只会有 1 次 → 此断言失败。
  assert.ok(
    h.reportedCards.length >= 2,
    `back 后应轮询等水合再上报 page.cards（不静默），实际上报 ${h.reportedCards.length} 次`,
  );
});

// 回归：启动时若 Chrome 停在【笔记详情页 /explore/<noteId>】（上一会话残留），
// 松判断 url.includes('/explore') 会误当"已在 feed"→ 扫详情页 modal 0 卡 → 静默死锁。
// 严格判定后必须导航回 feed。
test('browse-session: 启动停在笔记详情页(/explore/<id>) → ensureExplore 严格判定并导航回 feed', async () => {
  const h = makeHarness();
  const navIed: string[] = [];
  const origSend = h.deps.cdp.send;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.navigate') navIed.push(String(params.url ?? ''));
      if (method === 'Runtime.evaluate' && String(params.expression ?? '') === 'location.href') {
        // 模拟启动时停在笔记详情页（而非 feed 列表）
        return { result: { value: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=x' } } as never;
      }
      return origSend(method, params);
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  // 应发出一次到 feed 的 Page.navigate（/explore 列表，而非 /explore/<id> 详情）。
  assert.ok(
    navIed.some((u) => u.includes('/explore') && !/\/explore\/[A-Za-z0-9]/.test(u)),
    `详情页启动应导航回 feed，实际 Page.navigate: ${JSON.stringify(navIed)}`,
  );
});

// ======== 登录弹窗闸门测试 ========

/** 捕获日志的 opts（用于断言暂停/恢复日志） */
function captureOpts(logs: string[]) {
  return {
    random: () => 0.99,
    sleep: async () => {},
    logger: (m: string) => logs.push(m),
    loginGatePollMs: 1,
  };
}

test('登录闸门: loop 启动时检测到弹窗则暂停，弹窗消失后恢复并上报卡片', async () => {
  const h = makeHarness();
  const logs: string[] = [];
  // isOpen: 前两次 true（暂停 + 一次轮询）后转 false（消失）
  let n = 0;
  h.deps.loginGate = { isOpen: async () => ++n <= 2 };
  const sess = new BrowseSession(h.deps, captureOpts(logs));
  await startAndPush(sess, [makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  assert.ok(logs.some((m) => m.includes('检测到登录弹窗')), '应记录暂停');
  assert.ok(logs.some((m) => m.includes('阻断弹窗已消失，恢复浏览')), '应记录恢复');
  assert.ok(h.reportedCards.length >= 1, '恢复后应上报 page.cards');
});

test('登录闸门: 弹窗存在时暂停 browse.next，弹窗消失后才执行滚动', async () => {
  const h = makeHarness();
  const logs: string[] = [];
  let scrolled = 0;
  h.deps.scroller = { ...h.deps.scroller, scrollNext: async () => { scrolled++; } };
  // 调用序列：#1 loop 启动闸门→false（放行首屏上报）；#2、#3 browse.next 闸门→true（暂停）；#4→false（放行）
  let n = 0;
  h.deps.loginGate = { isOpen: async () => { n++; return n >= 2 && n <= 3; } };
  const sess = new BrowseSession(h.deps, captureOpts(logs));
  await startAndPush(sess, [
    makeEnvelope('browse.next', 'c1', 0, {}),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(logs.some((m) => m.includes('检测到登录弹窗')), '应记录暂停');
  assert.ok(logs.some((m) => m.includes('阻断弹窗已消失，恢复浏览')), '应记录恢复');
  assert.equal(scrolled, 1, '弹窗消失后应执行一次滚动');
});

test('登录闸门: session.end 不被弹窗阻塞（终止命令绕过闸门）', async () => {
  const h = makeHarness();
  const logs: string[] = [];
  // loop 启动闸门看到 false（#1），之后恒 true：若 session.end 经过闸门会卡死
  let n = 0;
  h.deps.loginGate = { isOpen: async () => ++n > 1 };
  const sess = new BrowseSession(h.deps, captureOpts(logs));
  // 若 session.end 被闸门阻塞，下面会挂起（测试超时）；正常应立即结束。
  await startAndPush(sess, [makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  assert.equal(sess.isRunning(), false, '会话应已停止');
});

test('登录闸门: 未注入 loginGate 时为 no-op（向后兼容）', async () => {
  const h = makeHarness();
  assert.equal(h.deps.loginGate, undefined);
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  assert.ok(h.reportedCards.length >= 1, '无闸门时正常上报');
});

test('登录闸门: 弹窗常驻时 cloud session.end 仍能终止会话（治死锁，回归）', async () => {
  const h = makeHarness();
  const logs: string[] = [];
  // 弹窗一直在；用 setImmediate 让出事件循环，避免 instant-sleep 微任务饿死宏任务计时器。
  h.deps.loginGate = { isOpen: () => new Promise((r) => setImmediate(() => r(true))) };
  const sess = new BrowseSession(h.deps, {
    random: () => 0.99,
    sleep: async () => {},
    logger: (m: string) => logs.push(m),
    loginGatePollMs: 1,
  });
  const done = sess.start();
  // 等 loop 进入初始闸门并暂停
  await new Promise((r) => setTimeout(r, 20));
  // 弹窗仍在时，loop 不在 waitForCommand —— session.end 只会进队列；闸门须据此退出。
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }));
  // 有界等待：若死锁则超时失败而非挂起整个套件。
  await Promise.race([
    done,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('DEADLOCK: 弹窗常驻时 session.end 未能终止会话')), 2000),
    ),
  ]);
  assert.equal(sess.isRunning(), false, '会话应已停止');
  assert.ok(logs.some((m) => m.includes('检测到登录弹窗')), '应已记录暂停');
});

// ======== 弹窗旁路监测体（overlayMonitor）闸门 + 提交前复检 ========

/** 可变状态的假监测体：state 由 stateSeq 控制，probeNow 返回 probe 的结果。 */
function fakeMonitor(opts: { stateSeq?: () => OverlayKind; probe?: () => Promise<OverlayKind> }): OverlayMonitor {
  return {
    get state() {
      return opts.stateSeq ? opts.stateSeq() : 'none';
    },
    probeNow: opts.probe ?? (async () => 'none'),
    start() {},
    stop() {},
  };
}

test('overlayMonitor 闸门: state=captcha 时暂停 browse.next，翻回 none 后才滚动', async () => {
  const h = makeHarness();
  const logs: string[] = [];
  let scrolled = 0;
  h.deps.scroller = { ...h.deps.scroller, scrollNext: async () => { scrolled++; } };
  // 读序：#1 loop 启动→none（放行首屏上报）；#2、#3 browse.next→captcha（暂停）；#4→none（放行）
  let n = 0;
  h.deps.overlayMonitor = fakeMonitor({ stateSeq: () => { n++; return n >= 2 && n <= 3 ? 'captcha' : 'none'; } });
  const sess = new BrowseSession(h.deps, captureOpts(logs));
  await startAndPush(sess, [
    makeEnvelope('browse.next', 'c1', 0, {}),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(logs.some((m) => m.includes('检测到验证码弹窗')), '应记录验证码暂停');
  assert.ok(logs.some((m) => m.includes('阻断弹窗已消失，恢复浏览')), '应记录恢复');
  assert.equal(scrolled, 1, '验证码消失后才滚动一次');
});

test('overlayMonitor 闸门: session.end 不被 captcha 阻塞（绕过闸门，治死锁）', async () => {
  const h = makeHarness();
  const logs: string[] = [];
  let n = 0;
  // loop 启动看到 none（#1），之后恒 captcha：若 session.end 经闸门会卡死
  h.deps.overlayMonitor = fakeMonitor({ stateSeq: () => (++n > 1 ? 'captcha' : 'none') });
  const sess = new BrowseSession(h.deps, captureOpts(logs));
  await startAndPush(sess, [makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  assert.equal(sess.isRunning(), false, '会话应已停止');
});

// ======== CDP 断线重连续跑 ========

/** 给 harness 的 cdp 加 on()（暴露生命周期事件），返回手动 emit 句柄。 */
function withCdpEvents(h: Harness): (method: string) => void {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  h.deps.cdp = {
    ...h.deps.cdp,
    on: (m: string, l: (p: unknown) => void) => {
      let s = listeners.get(m);
      if (!s) {
        s = new Set();
        listeners.set(m, s);
      }
      s.add(l);
      return () => s!.delete(l);
    },
  };
  return (method: string) => {
    for (const l of [...(listeners.get(method) ?? [])]) l({});
  };
}

test('browse-session: 命令执行中 CDP 断线 → 等重连成功后续跑重报（不当业务失败、不退出会话）', async () => {
  const h = makeHarness();
  const emit = withCdpEvents(h);
  let armed = false;
  h.deps.scroller = {
    ...h.deps.scroller,
    scrollNext: async () => {
      if (armed) {
        armed = false;
        throw new CdpDisconnectedError('boom'); // 模拟命令执行中 CDP 断线
      }
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10)); // 初始上报，loop 进 waitForCommand
  const before = h.reportedCards.length;
  armed = true;
  await sess.onCloudCommand(makeEnvelope('browse.scroll', 'c1', 0, { reason: 'scroll' }));
  await new Promise((r) => setTimeout(r, 5)); // scrollNext 抛 CdpDisconnectedError → loop 捕获 → waitForReconnect 挂起
  emit('cdp.reconnected'); // 模拟重连成功
  await new Promise((r) => setTimeout(r, 10)); // resumeAfterReconnect 重报
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  assert.ok(h.reportedCards.length > before, '重连成功后应续跑重报 page.cards');
  assert.equal(sess.isRunning(), false);
});

test('browse-session: cdp.unrecoverable → 停止浏览循环（诚实失败，交云端看门狗兜底）', async () => {
  const h = makeHarness();
  const emit = withCdpEvents(h);
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  emit('cdp.unrecoverable'); // 模拟 CDP 重连耗尽
  await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error('unrecoverable 未能停止会话')), 1500)),
  ]);
  assert.equal(sess.isRunning(), false, 'unrecoverable 应干净停止会话');
});

test('overlayMonitor 提交前复检: like 命中 captcha → 放弃点击并上报 blocked_by_captcha', async () => {
  const h = makeHarness();
  let clickCount = 0;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        if (expr.includes('like-wrapper')) {
          return { result: { value: JSON.stringify({ x: 100, y: 200, href: '#like' }) } } as never;
        }
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      if (method === 'Input.dispatchMouseEvent') clickCount++;
      return {} as never;
    },
  };
  // 闸门放行（state=none），但提交前 fresh 复检命中 captcha → 应放弃点击
  h.deps.overlayMonitor = fakeMonitor({ probe: async () => 'captcha' });
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.like', 'l1', 0, { noteId: 'n1' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const likeResult = h.completedActions.find((a) => a.action === 'like');
  assert.ok(likeResult, '应上报 like 结果');
  assert.equal(likeResult!.ok, false);
  assert.equal(likeResult!.reason, 'blocked_by_captcha');
  assert.equal(clickCount, 0, '复检命中验证码时不得派发点击');
});
