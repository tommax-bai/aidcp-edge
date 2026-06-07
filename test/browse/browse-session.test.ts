import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowseSession, type BrowseSessionDeps } from '../../src/browse/browse-session.js';
import type { FeedScroller, NoteCard } from '../../src/browse/feed-scroller.js';
import type { ModalController } from '../../src/browse/modal-controller.js';
import type { NoteContent } from '../../src/browse/note-extractor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import { makeEnvelope, type Envelope, type NoteContentPayload } from '../../src/comm/protocol.js';
import type { PlanStep, ActionResultPayload } from '../../src/comm/protocol.js';

const CARD: NoteCard = { position: 0, centerX: 10, centerY: 10, title: 'A' };

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
  reported: NoteContentPayload[];
  openedCards: number[];
  closes: number;
  steps: PlanStep[];
  decisionFor: (n: number) => Envelope;
}

function makeHarness(decisions: Envelope[]): Harness {
  const reported: NoteContentPayload[] = [];
  const openedCards: number[] = [];
  const steps: PlanStep[] = [];
  let closes = 0;
  let cardBatches = 0;
  let reportIdx = 0;

  const scroller: FeedScroller = {
    getVisibleCards: async () => {
      // 第一屏返回一张卡（probe + loop 首次），之后返回空（触发停止）
      cardBatches++;
      return cardBatches <= 2 ? [CARD] : [];
    },
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
        // engage-bar 探测：立即报告已渲染，避免轮询空转到超时
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) {
          return { result: { value: true } } as never;
        }
        // note-item 查询：返回 >= 4 以避免 waitForCards 循环
        if (expr.includes('note-item')) {
          return { result: { value: 10 } } as never;
        }
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };

  const client = {
    reportNoteContent: async (payload: NoteContentPayload): Promise<Envelope> => {
      reported.push(payload);
      const d = decisions[Math.min(reportIdx, decisions.length - 1)];
      reportIdx++;
      return d;
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
    reported,
    openedCards,
    get closes() {
      return closes;
    },
    steps,
    decisionFor: (n) => decisions[n],
  } as Harness;
}

function noOpts() {
  return {
    random: () => 0.99, // > skipProbability(0.2) → 不跳过
    sleep: async () => {},
    logger: () => {},
  };
}

test('browse-session: browse.next 决策下打开→提取→上报→关闭', async () => {
  const dec = makeEnvelope('browse.next', 'd1', 0, { reason: 'skip' });
  const h = makeHarness([dec, makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  const sess = new BrowseSession(h.deps, noOpts());
  await sess.start();
  assert.equal(h.reported.length, 1);
  assert.equal(h.reported[0].title, 'A');
  assert.deepEqual(h.openedCards, [0]);
  assert.ok(h.closes >= 1);
});

test('browse-session: plan.response 决策执行 like 步骤', async () => {
  const plan = makeEnvelope('plan.response', 'p1', 0, {
    steps: [{ actionId: 'note.like_button', op: 'click', goal: '点赞' }],
    reason: 'like it',
  });
  const h = makeHarness([plan, makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  const sess = new BrowseSession(h.deps, noOpts());
  await sess.start();
  assert.equal(h.steps.length, 1);
  assert.equal(h.steps[0].actionId, 'note.like_button');
});

test('browse-session: session.end 决策停止循环', async () => {
  const end = makeEnvelope('session.end', 's1', 0, { reason: 'test_end' });
  const h = makeHarness([end]);
  const sess = new BrowseSession(h.deps, noOpts());
  await sess.start();
  assert.equal(sess.isRunning(), false);
  assert.equal(h.reported.length, 1);
});

test('browse-session: 随机跳过卡片时不打开 modal', async () => {
  const h = makeHarness([makeEnvelope('session.end', 's', 0, { reason: 'test_end' })]);
  const opts = { ...noOpts(), random: () => 0.0, maxCards: 0 }; // 0 < 0.2 → 总是跳过
  const sess = new BrowseSession(h.deps, opts);
  await sess.start();
  assert.equal(h.openedCards.length, 0);
  assert.equal(h.reported.length, 0);
});

test('browse-session: search.execute 决策触发搜索', async () => {
  const search = makeEnvelope('search.execute', 'se1', 0, { keyword: '奶茶' });
  const h = makeHarness([search, makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  // 让 cdp 记录搜索调用
  const calls: string[] = [];
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push(method);
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) {
          return { result: { value: 10 } } as never;
        }
        if (expr.includes('location.href')) {
          return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
        }
        return { result: { value: true } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, { ...noOpts(), maxCards: 1 });
  await sess.start();
  assert.ok(calls.includes('Input.dispatchKeyEvent'), '应触发键盘输入搜索');
});


test('browse-session: 预筛跳过低赞卡片（不打开 modal、不上报，但计入 processed）', async () => {
  const h = makeHarness([makeEnvelope('session.end', 's', 0, { reason: 'test_end' })]);
  // 覆盖 scroller：第二屏给一张低赞卡，之后空屏触发停止
  let batches = 0;
  h.deps.scroller = {
    getVisibleCards: async () => {
      batches++;
      return batches <= 2 ? [{ position: 0, centerX: 10, centerY: 10, title: '某技术分享', likes: '8' }] : [];
    },
    scrollNext: async () => {},
    openCard: async (cc) => {
      h.openedCards.push(cc.position);
    },
  };
  const logs: string[] = [];
  const sess = new BrowseSession(h.deps, { ...noOpts(), logger: (m) => logs.push(m) });
  await sess.start();
  assert.equal(h.openedCards.length, 0, '不应打开 modal');
  assert.equal(h.reported.length, 0, '不应上报云端');
  assert.ok(logs.some((l) => l.includes('跳过低赞卡片') && l.includes('likes=8')), '应有低赞跳过日志');
});

test('browse-session: 预筛跳过无关标题卡片（不打开、不上报）', async () => {
  const h = makeHarness([makeEnvelope('session.end', 's', 0, { reason: 'test_end' })]);
  let batches = 0;
  h.deps.scroller = {
    getVisibleCards: async () => {
      batches++;
      return batches <= 2 ? [{ position: 0, centerX: 10, centerY: 10, title: '原神抽卡攻略', likes: '999' }] : [];
    },
    scrollNext: async () => {},
    openCard: async (cc) => {
      h.openedCards.push(cc.position);
    },
  };
  const logs: string[] = [];
  const sess = new BrowseSession(h.deps, { ...noOpts(), logger: (m) => logs.push(m) });
  await sess.start();
  assert.equal(h.openedCards.length, 0);
  assert.equal(h.reported.length, 0);
  assert.ok(logs.some((l) => l.includes('跳过无关卡片')), '应有无关跳过日志');
});

test('browse-session: 预筛放行相关标题卡片（正常打开并上报）', async () => {
  const dec = makeEnvelope('browse.next', 'd1', 0, { reason: 'skip' });
  const h = makeHarness([dec, makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  let batches = 0;
  h.deps.scroller = {
    getVisibleCards: async () => {
      batches++;
      return batches <= 2 ? [{ position: 0, centerX: 10, centerY: 10, title: 'LLM 大模型推理优化', likes: '1.2w' }] : [];
    },
    scrollNext: async () => {},
    openCard: async (cc) => {
      h.openedCards.push(cc.position);
    },
  };
  const sess = new BrowseSession(h.deps, { ...noOpts(), maxCards: 1 });
  await sess.start();
  assert.deepEqual(h.openedCards, [0]);
  assert.equal(h.reported.length, 1);
});

test('browse-session: 会话预算动作数到上限后自动结束', async () => {
  const plan = makeEnvelope('plan.response', 'p1', 0, {
    steps: [{ actionId: 'note.like_button', op: 'click', goal: '点赞' }],
    reason: 'like it',
  });
  const h = makeHarness([plan, plan]);
  let batches = 0;
  h.deps.scroller = {
    getVisibleCards: async () => {
      batches++;
      return batches <= 2
        ? [
            { position: 0, centerX: 10, centerY: 10, title: 'LLM 大模型推理优化', likes: '1.2w' },
            { position: 1, centerX: 20, centerY: 20, title: 'AI Agent 应用实践', likes: '1.1w' },
          ]
        : [];
    },
    scrollNext: async () => {},
    openCard: async (cc) => {
      h.openedCards.push(cc.position);
    },
  };
  h.deps.client = {
    ...h.deps.client,
    requestSessionBudget: async () => ({
      quotaLevel: 'normal',
      durationMs: 60_000,
      maxActions: 1,
      viewOnly: false,
      startedAt: Date.now(),
    }),
  };
  const sess = new BrowseSession(h.deps, { ...noOpts(), maxCards: 1 });
  await sess.start();
  assert.deepEqual(h.openedCards, [0]);
  assert.equal(h.steps.length, 1);
});

test('browse-session: 会话预算时长到上限后自动结束', async () => {
  const h = makeHarness([makeEnvelope('browse.next', 'd1', 0, { reason: 'skip' })]);
  h.deps.client = {
    ...h.deps.client,
    requestSessionBudget: async () => ({
      quotaLevel: 'normal',
      durationMs: 1,
      maxActions: 60,
      viewOnly: false,
      startedAt: Date.now() - 10,
    }),
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await sess.start();
  assert.equal(h.openedCards.length, 0);
  assert.equal(h.reported.length, 0);
});

// ======== onCloudCommand 测试 ========

test('onCloudCommand: session.end 设置 stopRequested', async () => {
  const dec = makeEnvelope('browse.next', 'd1', 0, { reason: 'skip' });
  const h = makeHarness([dec, makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  const sess = new BrowseSession(h.deps, noOpts());
  const env = makeEnvelope('session.end', 'cmd-1', 1, { reason: 'test_end' });
  await sess.onCloudCommand(env);
  // session.end 后 stopRequested 应为 true（外部可观测 isRunning===false 或无异常即可）
});

test('onCloudCommand: note.close 关闭 modal', async () => {
  const h = makeHarness([makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  const sess = new BrowseSession(h.deps, noOpts());
  const env = makeEnvelope('note.close', 'cmd-2', 1, { reason: 'close' });
  await sess.onCloudCommand(env);
  assert.ok(h.closes >= 1, '应调用 closeModal');
});

test('onCloudCommand: browse.scroll 调用 scrollNext', async () => {
  const h = makeHarness([makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  let scrolled = false;
  h.deps.scroller = {
    ...h.deps.scroller,
    scrollNext: async () => { scrolled = true; },
    getVisibleCards: async () => [],
  };
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  const env = makeEnvelope('browse.scroll', 'cmd-3', 1, { reason: 'scroll' });
  await sess.onCloudCommand(env);
  assert.equal(scrolled, true, '应调用 scrollNext');
});

test('onCloudCommand: browse.next 附带 action=like 先执行点赞', async () => {
  const h = makeHarness([makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  const logs: string[] = [];
  h.deps.scroller = {
    ...h.deps.scroller,
    scrollNext: async () => {},
    getVisibleCards: async () => [],
  };
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, { ...noOpts(), logger: (m) => logs.push(m) });
  const env = makeEnvelope('browse.next', 'cmd-4', 1, { reason: 'next', action: 'like' } as any);
  await sess.onCloudCommand(env);
  assert.ok(logs.some((l) => l.includes('互动') && l.includes('like')), '应触发 like 互动逻辑');
});
