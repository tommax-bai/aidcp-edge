import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowseSession, type BrowseSessionDeps } from '../../src/browse/browse-session.js';
import type { FeedScroller, NoteCard } from '../../src/browse/feed-scroller.js';
import type { ModalController } from '../../src/browse/modal-controller.js';
import type { NoteContent } from '../../src/browse/note-extractor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import { makeEnvelope, type Envelope, type NoteContentPayload, type PageCardsPayload, type ActionCompletedPayload, type ProfileDetailPayload, type NoteDetailPayload } from '../../src/comm/protocol.js';
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
    images: [],
    isLiked: false,
  };
}

interface Harness {
  deps: BrowseSessionDeps;
  reportedCards: PageCardsPayload[];
  reportedDetails: NoteDetailPayload[];
  completedActions: ActionCompletedPayload[];
  reportedProfiles: ProfileDetailPayload[];
  openedCards: number[];
  closes: number;
  steps: PlanStep[];
  navigations: string[];
  verifyCalls: number;
}

function makeHarness(cards: NoteCard[] = [CARD]): Harness {
  const reportedCards: PageCardsPayload[] = [];
  const reportedDetails: NoteDetailPayload[] = [];
  const completedActions: ActionCompletedPayload[] = [];
  const reportedProfiles: ProfileDetailPayload[] = [];
  const openedCards: number[] = [];
  const steps: PlanStep[] = [];
  const navigations: string[] = [];
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
      if (method === 'Page.navigate') {
        navigations.push(String(params.url ?? ''));
        return {} as never;
      }
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
      return makeEnvelope('xiaohongshu.feed.scroll', 'ack', 0, { reason: 'ack' });
    },
    reportPageCards: (payload: PageCardsPayload) => {
      reportedCards.push(payload);
    },
    reportNoteDetail: (payload: NoteDetailPayload) => {
      reportedDetails.push(payload);
    },
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
    reportedDetails,
    completedActions,
    reportedProfiles,
    openedCards,
    get closes() {
      return closes;
    },
    steps,
    navigations,
    verifyCalls: 0,
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

function commentHarness(opts: {
  editorError?: boolean;
  verify?: { cleared: boolean; ownRow: boolean };
  pageUrl?: string;
  /** 清场后仍有残文（真脏页）：change lease-strict-preemption task 3.2。 */
  clearResidual?: string;
}): Harness {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.navigate') {
        h.navigations.push(String(params.url ?? ''));
        return {} as never;
      }
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params.expression ?? '');
      if (expr.includes('ownRow')) {
        h.verifyCalls++;
        return { result: { value: JSON.stringify(opts.verify ?? { cleared: true, ownRow: true }) } } as never;
      }
      // 清场前置（必须排在 content-textarea 之前——两条 expr 都含该选择器）。
      if (expr.includes('residual')) {
        return {
          result: { value: JSON.stringify({ found: !opts.editorError, residual: opts.clearResidual ?? '' }) },
        } as never;
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
      // note-item 计数：让 waitForCards 立即满足（否则 pageUrl 为详情页时 ensureExplore 会 waitForCards(15000) 空转 15s）。
      if (expr.includes('note-item')) return { result: { value: 10 } } as never;
      // location.href（evalUrl）与其它兜底 expr：默认停在 /explore（无可解析 noteId → 就地核对宽松放行）；
      // 传 pageUrl 可指定当前详情页 URL 以驱动 keep-open 发前就地核对（change comment-keep-open-through-approval）。
      return { result: { value: opts.pageUrl ?? 'https://www.xiaohongshu.com/explore' } } as never;
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

test('executeComment: 提交后未确认生效 → ok:false reason submitted_unconfirmed（已提交、结果未知，绝不谎报未提交）', async () => {
  const h = commentHarness({ verify: { cleared: false, ownRow: false } });
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.comment', 'c1', 0, { noteId: 'n1', text: '赞' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const c = h.completedActions.find((a) => a.action === 'comment');
  assert.ok(c);
  assert.equal(c!.ok, false);
  // 提交动作已经派发出去了：这条评论可能真已发出。谎报「未提交」会让上游重试 ⇒ 重复评论。
  assert.equal(c!.reason, 'submitted_unconfirmed');
});

test('executeComment --feed: 提交后等 500ms、跳过结果检测、直回首页并诚实 submitted_unconfirmed', async () => {
  const h = commentHarness({ verify: { cleared: true, ownRow: true } });
  const sleeps: number[] = [];
  const sess = new BrowseSession(h.deps, {
    ...noOpts(),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await startAndPush(sess, [
    makeEnvelope('interaction.comment', 'c1', 0, { noteId: 'n1', text: '赞', fastReturnToFeed: true }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const c = h.completedActions.find((a) => a.action === 'comment');
  assert.deepEqual(c, { action: 'comment', ok: false, reason: 'submitted_unconfirmed' });
  assert.equal(h.verifyCalls, 0, 'fast return 不得读取发布结果');
  assert.ok(sleeps.includes(500), '提交后必须等待 500ms');
  assert.ok(h.navigations.includes('https://www.xiaohongshu.com/explore'), '应直达小红书首页');
});

test('executeComment 清场：编辑器里有残文且清不掉 → 诚实 editor_not_clean，绝不拼接发出（task 3.2）', async () => {
  const h = commentHarness({ clearResidual: '上一条被抢占时留下的半截评论' });
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.comment', 'c1', 0, { noteId: 'n1', text: '这一条' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const c = h.completedActions.find((a) => a.action === 'comment');
  assert.ok(c);
  assert.equal(c!.ok, false);
  assert.equal(c!.reason, 'editor_not_clean');
});

// keep-open 发前就地核对（change comment-keep-open-through-approval，取舍2）
test('interaction.comment: 当前详情 noteId 与目标不符 → 诚实回 note_page_mismatch、绝不在错笔记上发', async () => {
  const h = commentHarness({ verify: { cleared: true, ownRow: true }, pageUrl: 'https://www.xiaohongshu.com/explore/other999' });
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.comment', 'c1', 0, { noteId: 'n1', text: '赞' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const c = h.completedActions.find((a) => a.action === 'comment');
  assert.ok(c, '应上报 comment 结果');
  assert.equal(c!.ok, false);
  assert.equal(c!.reason, 'note_page_mismatch', '页面被动到别的笔记 → 诚实终止不发');
});

test('interaction.comment: 当前详情 noteId 与目标一致 → 就地核对通过、正常发布', async () => {
  const h = commentHarness({ verify: { cleared: true, ownRow: true }, pageUrl: 'https://www.xiaohongshu.com/explore/n1' });
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('interaction.comment', 'c1', 0, { noteId: 'n1', text: '赞' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const c = h.completedActions.find((a) => a.action === 'comment');
  assert.ok(c);
  assert.equal(c!.ok, true, '就地核对一致 → 正常发布');
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

test('browse-session: 近重复折叠优先保留带 noteId 的卡片', async () => {
  const h = makeHarness([
    { position: 0, centerX: 10, centerY: 10, title: '同题', author: '同作者', isVideo: false },
    { position: 1, centerX: 10, centerY: 160, title: '同题', author: '同作者', noteId: 'target-note', isVideo: false },
  ]);
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [makeEnvelope('session.end', 'e', 0, { reason: 'test_end' })]);
  assert.equal(h.reportedCards[0].cards.length, 1);
  assert.equal(h.reportedCards[0].cards[0].noteId, 'target-note');
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
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.deepEqual(h.openedCards, [0]);
  assert.equal(h.reportedDetails[0].mediaType, 'image_text');
});

test('browse-session: note.open surface=feed 小红书诚实拒 capability_unsupported（不回落 detail 开卡）', async () => {
  // change facebook-feed-inline-browse task 4.4 / N7：小红书页面模型无 feed 就地读，收到 surface=feed
  // MUST NOT 静默回落 detail——诚实 capability_unsupported，且绝不打开任何卡。
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n-feed', 0, { index: 0, surface: 'feed' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(h.openedCards.length, 0, '绝不回落打开卡片');
  assert.equal(h.reportedDetails.length, 0, '不假 note.detail');
  const refusal = h.completedActions.find((a) => a.action === 'open_note');
  assert.ok(refusal, '必有 open_note 回执');
  assert.equal(refusal?.ok, false);
  assert.equal(refusal?.reason, 'capability_unsupported');
});

test('browse-session: note.open 预算耗尽后如实失败，接管等待到安全边界才结束', async () => {
  const h = makeHarness();
  let clock = 0;
  let signalClickStarted!: () => void;
  const clickStarted = new Promise<void>((resolve) => { signalClickStarted = resolve; });
  let releaseClick!: () => void;
  const clickGate = new Promise<void>((resolve) => { releaseClick = resolve; });
  const logs: string[] = [];
  h.deps.scroller = {
    ...h.deps.scroller,
    openCard: async (_card, options) => {
      signalClickStarted();
      await clickGate;
      clock = options?.deadlineAt ?? clock;
    },
  };
  const sess = new BrowseSession(h.deps, { ...noOpts(), now: () => clock, noteOpenTimeoutMs: 10, logger: (line) => logs.push(line) });
  const running = sess.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.note.open', 'n-timeout', 0, { index: 0 }));
  await clickStarted;

  let quiesced = false;
  const quiesce = sess.quiesceForTask().then(() => { quiesced = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quiesced, false, '点击仍在执行时不得提前完成接管');

  releaseClick();
  await quiesce;
  const openResult = h.completedActions.find((item) => item.action === 'open_note');
  assert.deepEqual(openResult, { action: 'open_note', ok: false, reason: 'open_timeout' });
  assert.equal(h.reportedDetails.length, 0, '未取得详情时不得伪造 note.detail 成功');
  assert.ok(logs.some((line) => line.includes('click_primary=') && line.includes('open_timeout')), '超时日志保留阶段耗时');

  await sess.resumeAfterTask();
  await sess.onCloudCommand(makeEnvelope('session.end', 'end-timeout', 0, { reason: 'test_end' }));
  await running;
});

test('browse-session: note.open 视频卡上报 note.detail.mediaType=video', async () => {
  const h = makeHarness([{ ...CARD, title: 'V', isVideo: true }]);
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(h.reportedDetails[0].mediaType, 'video');
});

test('browse-session: note.open 长正文后执行正文小步滚动阅读', async () => {
  const h = makeHarness();
  const longBody = Array.from({ length: 24 }, (_, i) => `第${i + 1}段正文内容，包含足够多的信息需要继续往下看。`).join('\n');
  h.deps.noteExtractor = (async () => ({ ...fakeContent(), body: longBody })) as unknown as BrowseSessionDeps['noteExtractor'];
  const base = h.deps.cdp;
  let bodyScrolls = 0;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      const expr = String(params.expression ?? '');
      if (method === 'Runtime.evaluate' && expr.includes('return true;}return false')) {
        return { result: { value: true } } as never;
      }
      if (method === 'Runtime.evaluate' && expr.includes('function firstBody')) {
        bodyScrolls += 1;
        return { result: { value: JSON.stringify({ found: true, before: 0, after: 220, reachedEnd: bodyScrolls >= 2 }) } } as never;
      }
      return base.send(method, params);
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(bodyScrolls >= 1, '长正文打开后应滚动正文阅读');
});

test('browse-session: note.open 探测到已关注 → note.detail 带 authorFollowed=true', async () => {
  const h = makeHarness();
  const details: NoteDetailPayload[] = [];
  h.deps.client.reportNoteDetail = (p: NoteDetailPayload) => { details.push(p); };
  // note.open 时关注态探测（probeAuthorFollowed）会 eval 含 follow-button 的 js → 返回已关注。
  const base = h.deps.cdp;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      const expr = String((params as { expression?: unknown })?.expression ?? '');
      if (method === 'Runtime.evaluate' && expr.includes('follow-button') && expr.includes('followed')) {
        return { result: { value: '{"followed":true}' } } as never;
      }
      return base.send(method, params);
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(details.length, 1, '应上报一次 note.detail');
  assert.equal(details[0].authorFollowed, true, '已关注 → authorFollowed=true');
});

test('browse-session: note.open 未关注/读不到 → note.detail authorFollowed=false（回退原流程）', async () => {
  // 默认 harness cdp：关注态探测 js 落到 URL 兜底 → JSON.parse 抛 → probe 返回 false（安全回退）。
  const h = makeHarness();
  const details: NoteDetailPayload[] = [];
  h.deps.client.reportNoteDetail = (p: NoteDetailPayload) => { details.push(p); };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(details.length, 1, '应上报一次 note.detail');
  assert.equal(details[0].authorFollowed, false, '探测不到 → falsy → 回退原流程');
});

test('browse-session: 详情页地址栏带 xsec_token → note.detail 带真实可点 url（change interaction-feed-enrichment）', async () => {
  const h = makeHarness();
  const details: NoteDetailPayload[] = [];
  h.deps.client.reportNoteDetail = (p: NoteDetailPayload) => { details.push(p); };
  const base = h.deps.cdp;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      const expr = String((params as { expression?: unknown })?.expression ?? '');
      if (method === 'Runtime.evaluate' && expr.includes('location.href')) {
        return { result: { value: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=TOK&xsec_source=pc_feed' } } as never;
      }
      return base.send(method, params);
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(details.length, 1);
  assert.ok(details[0].url && details[0].url.includes('xsec_token='), '含 token → 上报真实可点链接');
});

test('browse-session: 详情页地址栏无 xsec_token → note.detail url 诚实置空（绝不裸 id 拼链）', async () => {
  // 默认 harness：location.href 兜底返回 .../explore（无 token）。
  const h = makeHarness();
  const details: NoteDetailPayload[] = [];
  h.deps.client.reportNoteDetail = (p: NoteDetailPayload) => { details.push(p); };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(details.length, 1);
  assert.equal(details[0].url, undefined, '无 token → url 必须置空，绝不伪造');
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
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0, noteId: 'llm' }),
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
  let scrolled = 0;
  h.deps.scroller = { ...h.deps.scroller, scrollNext: async () => { scrolled += 1; } };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0, noteId: 'gone' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  // 目标 noteId 真不在 DOM（scrollIntoView 命不中）→ 不开任何卡、【不盲滚】、重报当前快照（初始 1 + 重报 1）。
  assert.equal(h.openedCards.length, 0, '目标已滚走时不应开邻座');
  assert.equal(scrolled, 0, '真被回收的卡不盲滚（治自主 feed note.open 级联的滚动风暴）');
  assert.ok(h.reportedCards.length >= 2, '应重报当前卡片让云端按现状重判');
});

test('browse-session: note.open 目标滚出视口 → 有界滚动找回并打开（治 /comment 开笔记超时）', async () => {
  // 成因：AI 总结流式变长把卡往下顶，目标卡滚出视口（仍在 DOM）。getVisibleCards 只取视口内 → 首扫无目标。
  // 期望：按 noteId 向下滚动找回视口后打开它（而非重报兜底、让命令式读笔记流程干等超时）。
  const target: NoteCard = { position: 2, centerX: 10, centerY: 300, noteId: 'target', title: '目标卡', isVideo: false };
  const initial: NoteCard[] = [
    { position: 0, centerX: 10, centerY: 10, noteId: 'a', title: 'A 卡', isVideo: false },
    { position: 1, centerX: 10, centerY: 200, noteId: 'b', title: 'B 卡', isVideo: false },
  ];
  const h = makeHarness(initial);
  const originalSend = h.deps.cdp.send;
  let broughtIntoView = false;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      // 目标卡仍在 DOM（仅视口外）→ scrollIntoView 命中、返回 true。
      if (method === 'Runtime.evaluate' && String(params.expression ?? '').includes('scrollIntoView') && String(params.expression ?? '').includes('"target"')) {
        broughtIntoView = true;
        return { result: { value: true } } as never;
      }
      return originalSend(method, params);
    },
  };
  h.deps.scroller = {
    ...h.deps.scroller,
    // scrollIntoView 把目标拉回视口后，getVisibleCards 才含它。
    getVisibleCards: async () => (broughtIntoView ? [...initial, target] : initial),
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0, noteId: 'target' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(broughtIntoView, '应对 DOM 内的目标卡 scrollIntoView 拉回视口');
  assert.deepEqual(h.openedCards, [2], 'scrollIntoView 找回后应打开目标卡（position 2），而非重报兜底');
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
        if (expr.includes('location.href')) return { result: { value: 'https://www.xiaohongshu.com/search_result_ai?keyword=%E5%A5%B6%E8%8C%B6' } } as never;
        return { result: { value: true } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.search.execute', 'se1', 0, { keyword: '奶茶', activityId: 'activity-xhs-1', purpose: 'discovery', scope: 'global' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(calls.includes('Input.dispatchKeyEvent'), '应触发键盘输入搜索');
  const receipt = h.completedActions.find((a) => a.action === 'search');
  assert.deepEqual(receipt, {
    action: 'search', ok: true, activityId: 'activity-xhs-1', purpose: 'discovery', scope: 'global',
    actuated: true, searchOutcome: 'results_ready', resultCount: 1,
  });
});

test('browse-session: search.execute 上报前等待搜索卡片 noteId 水合', async () => {
  const h = makeHarness();
  let searchStarted = false;
  let scansAfterSearch = 0;
  h.deps.scroller = {
    ...h.deps.scroller,
    getVisibleCards: async () => {
      if (!searchStarted) return [CARD];
      scansAfterSearch++;
      return scansAfterSearch < 3
        ? [{ position: 0, centerX: 10, centerY: 10, title: '目标标题', author: '作者', isVideo: false }]
        : [{ position: 0, centerX: 10, centerY: 10, title: '目标标题', author: '作者', noteId: 'target-note', isVideo: false }];
    },
  };
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Input.dispatchKeyEvent') searchStarted = true;
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        if (expr.includes('location.href')) return { result: { value: 'https://www.xiaohongshu.com/search_result_ai?keyword=%E7%9B%AE%E6%A0%87' } } as never; // keyword=目标（与本次搜索词一致，change comment-keep-open-through-approval）
        return { result: { value: true } } as never;
      }
      return {} as never;
    },
  };

  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.search.execute', 'se1', 0, { keyword: '目标' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);

  const last = h.reportedCards[h.reportedCards.length - 1];
  assert.ok(scansAfterSearch >= 3, '应等待到搜索卡片 noteId 水合后再上报');
  assert.equal(last.cards[0].noteId, 'target-note');
  const receipt = h.completedActions.find((a) => a.action === 'search');
  assert.equal(receipt?.actuated, true);
  assert.equal(receipt?.searchOutcome, 'results_ready');
  assert.equal(receipt?.resultCount, 1);
});

// 核心回归（change comment-search-nav-confirm）：搜索未导航到结果页（仍在 feed）时，
// 边端 MUST NOT 把当前 feed 当搜索结果上报，且 MUST 发诚实的 action.completed{search, ok:false}。
test('browse-session: search.execute 未到结果页（恒停 /explore）→ 不把 feed 冒充搜索结果 + 诚实回 search ok:false', async () => {
  const h = makeHarness([
    { position: 0, centerX: 10, centerY: 10, title: 'FEED-A', author: '路人', noteId: 'feed-note', isVideo: false },
  ]);
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        // location.href 恒为首页 feed：搜索导航从未确认到达结果页。
        if (expr.includes('location.href')) return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
        if (expr.includes('getBoundingClientRect')) return { result: { value: null } } as never; // 提交按钮找不到
        return { result: { value: true } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise(r => setTimeout(r, 10)); // 让 start 完成初始 feed 上报
  const before = h.reportedCards.length;
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.search.execute', 'se1', 0, { keyword: 'Claude Code实测' }));
  await new Promise(r => setTimeout(r, 5));
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }));
  await done;

  assert.equal(h.reportedCards.length, before, '未到结果页时 search.execute MUST NOT 新增 page.cards（feed 绝不冒充搜索结果）');
  const searchFail = h.completedActions.find((a) => a.action === 'search' && a.ok === false);
  assert.ok(searchFail, '未到结果页 MUST 发 action.completed{search, ok:false}');
  assert.equal(searchFail?.reason, 'not_on_search_page', 'reason MUST 为 not_on_search_page（诚实归因，非离线/无结果）');
  assert.equal(searchFail?.activityId, 'se1', '旧 Cloud 命令缺 activityId 时回退 envelope id');
  assert.equal(searchFail?.actuated, true, 'Enter 已派发，平台已观察到本次搜索尝试');
  assert.equal(searchFail?.searchOutcome, 'failed_after_submit');
});

test('browse-session: search.execute 空关键词 → not_submitted，绝不把当前搜索页当本次成功', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.search.execute', 'empty-search', 0, { keyword: '' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const receipt = h.completedActions.find((a) => a.action === 'search');
  assert.equal(receipt?.ok, false);
  assert.equal(receipt?.reason, 'no_target');
  assert.equal(receipt?.actuated, false);
  assert.equal(receipt?.searchOutcome, 'not_submitted');
});

test('browse-session: note.browse_images 命中轮播 → 如实回报 browsed=N', async () => {
  const h = makeHarness();
  h.deps.noteExtractor = (async () => ({
    ...fakeContent(),
    images: [
      { index: 0, url: 'https://img.test/a.jpg' },
      { index: 1, url: 'https://img.test/b.jpg' },
    ],
  })) as unknown as BrowseSessionDeps['noteExtractor'];
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.browse_images', 'bi1', 0, { noteId: 'n1', count: 4 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'browse_images');
  assert.ok(act && act.ok, '命中轮播应 ok:true');
  assert.match(String(act!.reason ?? ''), /browsed=/, '应回报实际浏览张数');
  assert.equal(h.reportedDetails.length, 1, '成功翻图后应刷新参考图快照');
  assert.equal(h.reportedDetails[0].refreshOnly, true);
  assert.deepEqual(h.reportedDetails[0].images?.map((img) => img.url), ['https://img.test/a.jpg', 'https://img.test/b.jpg']);
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
    makeEnvelope('xiaohongshu.note.browse_images', 'bi2', 0, { noteId: 'n1', count: 3 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'browse_images');
  assert.ok(act && act.ok === false && act.reason === 'no_target', '无轮播应 ok:false reason:no_target');
  assert.equal(h.reportedDetails.length, 0, '失败翻图不应伪造图片快照');
});

test('browse-session: note.scroll_comments 命中评论区 → 如实回报 scrolled=N', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.scroll_comments', 'sc1', 0, { noteId: 'n1', count: 5 }),
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
    makeEnvelope('xiaohongshu.note.scroll_comments', 'sc2', 0, { noteId: 'n1', count: 3 }),
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
    makeEnvelope('xiaohongshu.note.scroll_comments', 'sc3', 0, { noteId: 'n1', count: 3 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'scroll_comments');
  assert.ok(act && act.ok === false && act.reason === 'no_scroll', `应回报 no_scroll，实际 ${JSON.stringify(act)}`);
});

// change fix-interaction-and-comment-capture：滚不动/无可滚容器时仍抓当前可见评论随回执带回（短评论区不再一条不采）。
test('browse-session: note.scroll_comments 短评论区 no_scroll 仍带回可见评论候选', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        // harvestJs（含 window.innerHeight）→ 返回一条可见评论候选
        if (expr.includes('innerHeight')) {
          return { result: { value: JSON.stringify([{ anchorId: 'comment-1', author: '小明', text: '这条评论很有用', alreadyLiked: false, likeText: '8' }]) } } as never;
        }
        // scrollExpr：命中容器但 scrollTop 不动 → no_scroll
        if (expr.includes('overflowY')) return { result: { value: '{"found":true,"before":500,"after":500}' } } as never;
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.scroll_comments', 'scb1', 0, { noteId: 'n1', count: 2 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'scroll_comments');
  assert.ok(act && act.ok === false && act.reason === 'no_scroll', `应回报 no_scroll，实际 ${JSON.stringify(act)}`);
  assert.ok(act!.candidates && act!.candidates.length > 0, '短评论区滚不动也应带回可见评论候选');
  assert.equal(act!.candidates![0].anchorId, 'comment-1');
});

test('browse-session: note.scroll_comments 无可滚容器 no_target 仍带回可见评论候选', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('innerHeight')) {
          return { result: { value: JSON.stringify([{ anchorId: 'comment-9', text: '路过留言', alreadyLiked: false }]) } } as never;
        }
        if (expr.includes('overflowY')) return { result: { value: '{"found":false}' } } as never; // 找不到可滚容器
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.scroll_comments', 'scb2', 0, { noteId: 'n1', count: 2 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'scroll_comments');
  assert.ok(act && act.ok === false && act.reason === 'no_target', `应回报 no_target，实际 ${JSON.stringify(act)}`);
  assert.ok(act!.candidates && act!.candidates.length > 0, '无可滚容器也应带回当前可见评论候选');
});

test('browse-session: note.scroll_comments 滚动成功经 harvest 回流评论候选（ok:true 带 candidates）', async () => {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('innerHeight')) {
          return { result: { value: JSON.stringify([{ anchorId: 'comment-1', text: '第一条', likeText: '3' }, { anchorId: 'comment-2', text: '第二条' }]) } } as never;
        }
        if (expr.includes('overflowY')) return { result: { value: '{"found":true,"before":0,"after":360}' } } as never; // 真位移
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.scroll_comments', 'scb3', 0, { noteId: 'n1', count: 3 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'scroll_comments');
  assert.ok(act && act.ok === true, '滚动成功应 ok:true');
  assert.ok(act!.candidates && act!.candidates.length > 0, '成功路径也应经 harvest 带回候选');
});

test('browse-session: note.scroll_comments 使用 feed 同款多帧 mouseWheel 而非 DOM 跳滚', async () => {
  const h = makeHarness();
  let scrollTop = 0;
  let wheelFrames = 0;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mouseWheel') {
          wheelFrames++;
          scrollTop += Number(params.deltaY ?? 0);
        }
        return {} as never;
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('innerHeight')) return { result: { value: JSON.stringify([]) } } as never;
        if (expr.includes('function visible')) return { result: { value: '{"found":true,"visible":true}' } } as never;
        if (expr.includes('overflowY')) {
          return { result: { value: JSON.stringify({ found: true, scrollTop, scrollHeight: 2400, clientHeight: 500, x: 640, y: 420 }) } } as never;
        }
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.scroll_comments', 'scb4', 0, { noteId: 'n1', count: 1 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const act = h.completedActions.find(a => a.action === 'scroll_comments');
  assert.ok(wheelFrames >= 8, `评论区滚动应派发惯性 wheel 多帧，实际 ${wheelFrames}`);
  assert.ok(act && act.ok === true, `wheel 后应按真实 scrollTop 位移回报成功，实际 ${JSON.stringify(act)}`);
  assert.match(String(act!.reason ?? ''), /scrolled=1/);
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
    makeEnvelope('xiaohongshu.profile.open', 'po1', 0, { authorId: 'abc123' }),
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
    makeEnvelope('xiaohongshu.profile.open', 'po2', 0, { authorId: 'abc123' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(h.reportedProfiles.length, 1);
  assert.equal(h.reportedProfiles[0].extracted, false, '抽取失败应 extracted:false');
});

test('browse-session: legacy profile.open{direct} 在 CDP 前拒绝', async () => {
  const h = makeHarness();
  const navUrls: string[] = [];
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.navigate') { navUrls.push(String(params.url ?? '')); return {} as never; }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression ?? '');
        if (expression.includes('note-item')) return { result: { value: 0 } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.profile.open', 'pod', 0, { authorId: 'abc123', direct: true } as never),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.equal(navUrls.some((url) => url.includes('/user/profile/')), false);
  assert.deepEqual(h.completedActions[0], {
    action: 'profile_open',
    ok: false,
    reason: 'legacy_profile_direct_unsupported',
  });
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
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
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
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
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
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
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
    makeEnvelope('xiaohongshu.note.open', 'n1', 0, { index: 0 }),
    makeEnvelope('interaction.like', 'l', 0, { noteId: 'x', thinkMs: DWELL_SENTINEL }),
    makeEnvelope('session.end', 'e', 0, { reason: 'end' }),
  ]);
  assert.ok(sleeps.some((ms) => ms > ISOLATE), `点赞前应有 thinkMs 犹豫，实际: ${sleeps}`);
});

// 回归：云端 back_to_feed 实际下发的 navigation.back【不带 targetPage】（生产路径）。
// 修复前 undefined 落进 else 分支（裸 history.back / 固定 sleep + 瞬时扫描），feed 未水合即扫到
// 0 卡 → reportVisibleCards 静默不发 page.cards → 边端死等命令、云端死等上报 → 边-云互等死锁。
// 修复后 undefined 等同 'feed'：直连 explore feed，并走 waitForVisibleCards 轮询，等水合出卡再上报。
test('browse-session: navigation.back 无 targetPage（back_to_feed 生产路径）轮询等水合再上报，不静默死锁', async () => {
  const h = makeHarness();
  let url = 'https://www.xiaohongshu.com/explore';
  let returnStarted = false;
  let pollsAfterBack = 0;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.navigate') {
        url = String(params.url ?? '');
        if (url.includes('/explore')) returnStarted = true;
        return {} as never;
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('history.back()')) throw new Error('navigation.back must not use history.back for feed return');
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        return { result: { value: url } } as never;
      }
      return {} as never;
    },
  };
  // 初始扫描有卡；back 之后模拟 feed 延迟水合：前 3 次轮询为空，之后才出卡。
  h.deps.scroller = {
    ...h.deps.scroller,
    getVisibleCards: async () => {
      if (!returnStarted) return [CARD];
      pollsAfterBack++;
      return pollsAfterBack <= 3 ? [] : [CARD];
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 15)); // 启动在 explore 完成首扫
  url = 'https://www.xiaohongshu.com/notification';
  await sess.onCloudCommand(makeEnvelope('navigation.back', 'b', 0, { reason: 'back_to_feed' })); // 无 targetPage：复刻云端实际报文
  await new Promise((r) => setTimeout(r, 5));
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }));
  await done;
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

test('登录闸门: 弹窗存在时暂停 page.scroll，弹窗消失后才执行滚动', async () => {
  const h = makeHarness();
  const logs: string[] = [];
  let scrolled = 0;
  h.deps.scroller = { ...h.deps.scroller, scrollNext: async () => { scrolled++; } };
  // 调用序列：#1 loop 启动闸门→false（放行首屏上报）；#2、#3 page.scroll 闸门→true（暂停）；#4→false（放行）
  let n = 0;
  h.deps.loginGate = { isOpen: async () => { n++; return n >= 2 && n <= 3; } };
  const sess = new BrowseSession(h.deps, captureOpts(logs));
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.feed.scroll', 'c1', 0, { reason: 'scroll' }),
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
  // 读序：#1 loop 启动→none（放行首屏上报）；#2、#3 page.scroll→captcha（暂停）；#4→none（放行）
  let n = 0;
  h.deps.overlayMonitor = fakeMonitor({ stateSeq: () => { n++; return n >= 2 && n <= 3 ? 'captcha' : 'none'; } });
  const sess = new BrowseSession(h.deps, captureOpts(logs));
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.feed.scroll', 'c1', 0, { reason: 'scroll' }),
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
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 'c1', 0, { reason: 'scroll' }));
  await new Promise((r) => setTimeout(r, 5)); // scrollNext 抛 CdpDisconnectedError → loop 捕获 → waitForReconnect 挂起
  emit('cdp.reconnected'); // 模拟重连成功
  await new Promise((r) => setTimeout(r, 10)); // resumeAfterReconnect 重报
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  assert.ok(h.reportedCards.length > before, '重连成功后应续跑重报 page.cards');
  assert.equal(sess.isRunning(), false);
});

test('browse-session: 云端 WS 重连后丢弃旧队列并重报 page.cards', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10)); // 初始上报，loop 进 waitForCommand
  const before = h.reportedCards.length;
  (sess as unknown as { commandQueue: Envelope[] }).commandQueue = [
    makeEnvelope('xiaohongshu.feed.scroll', 'stale-scroll', 0, { reason: 'stale_before_reconnect' }),
  ];

  await sess.recoverAfterCloudReconnect();

  assert.equal((sess as unknown as { commandQueue: Envelope[] }).commandQueue.length, 0, '旧连接命令队列必须清空');
  assert.ok(h.reportedCards.length > before, '云端重连后应按当前真实页面重报 page.cards');
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
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

test('browse-session: 输入控制不可用 → 停止浏览并丢弃未开始命令，不能在同一进程自动重放', async () => {
  const h = makeHarness();
  const emit = withCdpEvents(h);
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  (sess as unknown as { commandQueue: Envelope[] }).commandQueue = [
    makeEnvelope('xiaohongshu.feed.scroll', 'stale-after-timeout', 0, { reason: 'unsafe' }),
  ];
  emit('cdp.control_unavailable');
  await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error('control unavailable 未能停止会话')), 1500)),
  ]);
  assert.equal(sess.isRunning(), false);
  assert.equal((sess as unknown as { commandQueue: Envelope[] }).commandQueue.length, 0);
});

test('browse-session: CDP 软恢复开始时丢弃本地旧浏览队列，避免跨连接复用坐标', async () => {
  const h = makeHarness();
  const emit = withCdpEvents(h);
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  (sess as unknown as { commandQueue: Envelope[] }).commandQueue = [
    makeEnvelope('xiaohongshu.feed.scroll', 'queued-before-reconnect', 0, { reason: 'stale' }),
  ];
  emit('cdp.control_recovering');
  assert.equal((sess as unknown as { commandQueue: Envelope[] }).commandQueue.length, 0);
  await sess.onCloudCommand(makeEnvelope('session.end', 'end-after-recovery', 0, { reason: 'done' }));
  await done;
});

test('browse-session: 慢输入软恢复完成后主动重报当前页面，且不与命令恢复重复续跑', async () => {
  const h = makeHarness();
  const emit = withCdpEvents(h);
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  const before = h.reportedCards.length;
  emit('cdp.control_recovering');
  emit('cdp.reconnected');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.reportedCards.length, before + 1, '软恢复完成后应仅重报一次当前 page.cards');
  await sess.onCloudCommand(makeEnvelope('session.end', 'end-after-soft-recovery', 0, { reason: 'done' }));
  await done;
});

test('browse-session: 输入超时触发的终止与原子操作报错并发时，循环干净结束而非抛未处理异常', async () => {
  const h = makeHarness();
  const emit = withCdpEvents(h);
  h.deps.scroller = {
    ...h.deps.scroller,
    scrollNext: async () => {
      emit('cdp.control_unavailable');
      throw new Error('CDP 命令超时: Input.dispatchMouseEvent');
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 'timeout-in-flight', 0, { reason: 'unsafe' }));
  await assert.doesNotReject(done);
  assert.equal(sess.isRunning(), false);
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

// ======== 续场唤醒：循环已停后可被云端浏览类命令重启（change restore-auto-resume A②）========

test('browse-session: 循环因 session.end 停止后，收到 page.scroll → 唤醒重启并重报 page.cards', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  // 阶段1：启动 → 上报一次 cards → session.end 停循环（loop 退出、running=false）。
  await startAndPush(sess, [makeEnvelope('session.end', 'e1', 0, { reason: 'test_end' })]);
  const afterStop = h.reportedCards.length;
  assert.ok(afterStop >= 1, '首轮应至少上报一次 page.cards');

  // 阶段2：循环已停，收到一条续场引导 page.scroll → 应唤醒重启循环、重新上报 cards
  //（旧行为：命令静默堆进无人消费的队列，循环不复活、不再上报）。
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 's1', 0, { reason: 'resume_redrive' }));
  await new Promise((r) => setTimeout(r, 30)); // 等重启循环 init + 重报（sleep 已被桩为 no-op）
  assert.ok(h.reportedCards.length > afterStop, 'A②：唤醒重启后应重新上报 page.cards');

  // 收尾：停掉重启的循环，避免悬挂。
  await sess.onCloudCommand(makeEnvelope('session.end', 'e2', 0, { reason: 'test_end' }));
  await new Promise((r) => setTimeout(r, 10));
});

test('browse-session: session.end 收尾竞态中收到 page.scroll → 停稳后仍唤醒重启', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());

  const firstRun = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.reportedCards.length >= 1, '首轮应至少上报一次 page.cards');

  await sess.onCloudCommand(makeEnvelope('session.end', 'e1', 0, { reason: 'publish_takeover' }));
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 's1', 0, { reason: 'resume_redrive' }));
  await firstRun;
  const afterFirstRun = h.reportedCards.length;

  await new Promise((r) => setTimeout(r, 30));
  assert.ok(h.reportedCards.length > afterFirstRun, '停稳后应消费延迟续场唤醒并重新上报 page.cards');

  await sess.onCloudCommand(makeEnvelope('session.end', 'e2', 0, { reason: 'test_end' }));
  await new Promise((r) => setTimeout(r, 10));
});

test('browse-session: 发布续场 page.scroll 在创作平台页时先回 explore feed 再滚动', async () => {
  const h = makeHarness();
  let currentUrl = 'https://www.xiaohongshu.com/explore';
  const navigates: string[] = [];
  const scrollUrls: string[] = [];
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.navigate') {
        const url = String(params.url ?? '');
        currentUrl = url;
        navigates.push(url);
        return {} as never;
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr === 'location.href') return { result: { value: currentUrl } } as never;
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        return { result: { value: currentUrl } } as never;
      }
      return {} as never;
    },
  };
  h.deps.scroller = {
    getVisibleCards: async () => [CARD],
    scrollNext: async () => {
      scrollUrls.push(currentUrl);
    },
    openCard: async (c) => {
      h.openedCards.push(c.position);
    },
  };

  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10));

  currentUrl = 'https://creator.xiaohongshu.com/publish/publish?source=official&published=true';
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 's1', 0, { reason: 'resume_redrive' }));
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(navigates.includes('https://www.xiaohongshu.com/explore'), 'resume_redrive 应先导航回 explore feed');
  assert.equal(scrollUrls.at(-1), 'https://www.xiaohongshu.com/explore', '滚动应发生在 feed 页，而不是 creator 发布页');

  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }));
  await done;
});

test('browse-session: 终态关闭（close）后收到迟到命令 → MUST NOT 复活循环', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [makeEnvelope('session.end', 'e1', 0, { reason: 'test_end' })]);
  const afterStop = h.reportedCards.length;

  sess.close(); // 终态关闭（进程下线语义）：置 closing
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 's1', 0, { reason: 'late_after_close' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.reportedCards.length, afterStop, 'A②：终态关闭后迟到命令 MUST NOT 唤醒重启循环');
});

// ======== navigateBack 返回导航：避免回踩失效 token 笔记详情闪 300031（change avoid-return-nav-token-loss-flash）========

interface NavBackHarness {
  h: Harness;
  calls: { historyBack: number; navigates: string[] };
  urlState: { url: string };
}

/** modalOpen=返回瞬间头上是否盖着笔记浮层；onBackUrl=history.back() 后落到的 URL（模拟历史栈上一格）。 */
function makeNavBackHarness(opts: { modalOpen: boolean; onBackUrl?: string }): NavBackHarness {
  const h = makeHarness();
  const calls = { historyBack: 0, navigates: [] as string[] };
  const urlState = { url: 'https://www.xiaohongshu.com/explore' }; // 启动时在 feed，避免 ensureExplore 导航
  let closes = 0;
  h.deps.modalCtrl = {
    isModalOpen: async () => opts.modalOpen,
    closeModal: async () => {
      closes++;
    },
    waitForModal: async () => true,
  };
  void closes;
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.navigate') {
        const u = String(params.url ?? '');
        calls.navigates.push(u);
        urlState.url = u;
        return {} as never;
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('history.back')) {
          calls.historyBack += 1;
          if (opts.onBackUrl !== undefined) urlState.url = opts.onBackUrl;
          return {} as never;
        }
        if (expr.includes('note-item')) {
          return { result: { value: 10 } } as never;
        }
        return { result: { value: urlState.url } } as never;
      }
      return {} as never;
    },
  };
  return { h, calls, urlState };
}

async function driveNavBack(nb: NavBackHarness, scenarioUrl: string, back: Envelope): Promise<void> {
  const sess = new BrowseSession(nb.h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 15)); // 启动 ensureExplore/初扫完成（此刻在 /explore）
  nb.urlState.url = scenarioUrl; // 模拟已离页 / 在详情
  await sess.onCloudCommand(back);
  await new Promise((r) => setTimeout(r, 5));
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }));
  await done;
}

test('navigateBack: 看笔记→开通知→返回（无浮层整页离页）→ 不 history.back，直接 Page.navigate 回 feed（事故回归）', async () => {
  const nb = makeNavBackHarness({ modalOpen: false });
  await driveNavBack(
    nb,
    'https://www.xiaohongshu.com/notification', // 巡视后停在通知页、头上无浮层
    makeEnvelope('navigation.back', 'b', 0, { reason: 'back_to_feed', targetPage: 'feed' }),
  );
  assert.equal(nb.calls.historyBack, 0, '无浮层整页返回 MUST NOT history.back 回踩失效笔记详情');
  assert.ok(
    nb.calls.navigates.some((u) => u.includes('/explore')),
    `应直接前向 Page.navigate 回 explore feed，实际: ${JSON.stringify(nb.calls.navigates)}`,
  );
  const back = nb.h.completedActions.find((a) => a.action === 'back');
  assert.ok(back && back.ok === true, 'back 应如实回报 ok:true（不静默）');
});

test('navigateBack: 笔记浮层盖在列表上返回 → 直接 Page.navigate 回 feed，不再 history.back', async () => {
  const nb = makeNavBackHarness({
    modalOpen: true,
    onBackUrl: 'https://www.xiaohongshu.com/explore', // history.back 关浮层回到 feed
  });
  await driveNavBack(
    nb,
    'https://www.xiaohongshu.com/explore/abc123?xsec_token=tok', // 详情态、头上有浮层
    makeEnvelope('navigation.back', 'b', 0, { reason: 'back_to_feed', targetPage: 'feed' }),
  );
  assert.equal(nb.calls.historyBack, 0, 'feed 来源即便有浮层也 MUST NOT history.back 回踩详情历史');
  assert.ok(
    nb.calls.navigates.some((u) => u.includes('/explore')),
    `应直接前向 Page.navigate 回 explore feed，实际: ${JSON.stringify(nb.calls.navigates)}`,
  );
});

test('navigateBack: 搜索来源记录 URL → 直接 Page.navigate 回搜索结果，不拽回 explore', async () => {
  const searchUrl = 'https://www.xiaohongshu.com/search_result?keyword=palantir';
  const detailUrl = 'https://www.xiaohongshu.com/explore/abc123?xsec_token=tok';
  const h = makeHarness([{ ...CARD, noteId: 'abc123' }]);
  const calls = { historyBack: 0, navigates: [] as string[] };
  const urlState = { url: searchUrl };
  h.deps.scroller = {
    ...h.deps.scroller,
    openCard: async (c) => {
      h.openedCards.push(c.position);
      urlState.url = detailUrl;
    },
  };
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.navigate') {
        const u = String(params.url ?? '');
        calls.navigates.push(u);
        urlState.url = u;
        return {} as never;
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('history.back')) {
          calls.historyBack += 1;
          return {} as never;
        }
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar') || expr.includes('detail-desc')) {
          return { result: { value: true } } as never;
        }
        if (expr.includes('note-item')) {
          return { result: { value: 10 } } as never;
        }
        return { result: { value: urlState.url } } as never;
      }
      return {} as never;
    },
  };

  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.note.open', 'n', 0, { index: 0, noteId: 'abc123' }),
    makeEnvelope('navigation.back', 'b', 0, { reason: 'back_to_feed', targetPage: 'search' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);

  assert.equal(calls.historyBack, 0, '有记录的搜索来源 MUST NOT history.back');
  assert.equal(calls.navigates.at(-1), searchUrl, `应返回搜索结果 URL，实际: ${JSON.stringify(calls.navigates)}`);
  assert.equal(urlState.url, searchUrl);
});

test('navigateBack: 搜索来源 URL 缺失时 history.back 落坏页 → 兜底 Page.navigate 回 feed 并上报 page.cards', async () => {
  const nb = makeNavBackHarness({
    modalOpen: true,
    onBackUrl: 'https://www.xiaohongshu.com/explore/def456?xsec_token=stale', // back 落到另一条失效详情
  });
  const before = nb.h.reportedCards.length;
  await driveNavBack(
    nb,
    'https://www.xiaohongshu.com/explore/abc123?xsec_token=tok',
    makeEnvelope('navigation.back', 'b', 0, { reason: 'back_to_feed', targetPage: 'search' }),
  );
  assert.equal(nb.calls.historyBack, 1, '搜索来源 URL 缺失的边界情形可用 history.back 健康校验兜底');
  assert.ok(
    nb.calls.navigates.some((u) => u.includes('/explore')),
    `落坏页应兜底整页导航回 feed，实际: ${JSON.stringify(nb.calls.navigates)}`,
  );
  assert.ok(nb.h.reportedCards.length > before, '返回后 MUST 上报 page.cards（不静默吞掉造成边-云互等）');
  const back = nb.h.completedActions.find((a) => a.action === 'back');
  assert.ok(back && back.ok === true, 'back 如实 ok:true');
});

// ======== feed-scroll-card-floor：翻页前「看新卡」停留（ensureFeedDwell） ========

test('pacing: page.scroll 带 dwellMs 且刚到卡（停留不足）→ 翻页前兜底停留', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const sess = new BrowseSession(h.deps, pacingOpts(sleeps, () => 1000)); // 时钟恒定 → 已停≈0
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.feed.scroll', 's', 0, { reason: 'feed_scroll', dwellMs: DWELL_SENTINEL }),
    makeEnvelope('session.end', 'e', 0, { reason: 'end' }),
  ]);
  assert.ok(sleeps.some((ms) => ms > ISOLATE), `翻页前应有≈dwellMs的兜底停留，实际: ${sleeps}`);
});

test('pacing: page.scroll 已停够（评估耗时被吸收）→ 不叠加等待', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  // 时钟每次 +40000：卡片到达锚点后，page.scroll 时 elapsed≈40000 > 抖动后目标 → 不再补停。
  let t = 1000;
  const now = () => { const v = t; t += 40000; return v; };
  const sess = new BrowseSession(h.deps, pacingOpts(sleeps, now));
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.feed.scroll', 's', 0, { reason: 'feed_scroll', dwellMs: DWELL_SENTINEL }),
    makeEnvelope('session.end', 'e', 0, { reason: 'end' }),
  ]);
  assert.ok(!sleeps.some((ms) => ms > ISOLATE), `已停够不应再兜底停留，实际: ${sleeps}`);
});

test('pacing: page.scroll 缺 dwellMs（返回未刷新/旧云端）→ 立即翻页不额外停留', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const sess = new BrowseSession(h.deps, pacingOpts(sleeps, () => 1000));
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.feed.scroll', 's', 0, { reason: 'feed_scroll' }), // 无 dwellMs
    makeEnvelope('session.end', 'e', 0, { reason: 'end' }),
  ]);
  assert.ok(!sleeps.some((ms) => ms > ISOLATE), `缺 dwellMs 不应有 feed 兜底停留，实际: ${sleeps}`);
});

test('task quiesce: 等当前浏览原子动作完成、取消未开始旧命令，租约释放后按新快照恢复', async () => {
  const h = makeHarness();
  let releaseScroll!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const scrollGate = new Promise<void>((resolve) => { releaseScroll = resolve; });
  let scrollCalls = 0;
  h.deps.scroller.scrollNext = async () => {
    scrollCalls++;
    markStarted();
    await scrollGate;
  };
  const sess = new BrowseSession(h.deps, noOpts());
  const running = sess.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 'active-scroll', 0, { reason: 'active' }));
  await started;
  // 当前 scroll 执行中，把一个旧 back 排进队列；quiesce 必须丢它而不是先排空。
  await sess.onCloudCommand(makeEnvelope('navigation.back', 'stale-back', 0, { reason: 'stale' }));
  let settled = false;
  const quiesced = sess.quiesceForTask().then((count) => { settled = true; return count; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, '当前原子动作尚未收敛前不能回 quiesced');
  releaseScroll();
  assert.equal(await quiesced, 1, '未开始的旧 back 被取消');

  await sess.resumeAfterTask();
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 'fresh-scroll', 0, { reason: 'new_page_decision' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sess.onCloudCommand(makeEnvelope('session.end', 'end-after-task', 0, { reason: 'done' }));
  await running;
  assert.equal(scrollCalls, 2, '释放后新浏览命令可执行（未永久冻结）');
  assert.equal(h.completedActions.some((item) => item.action === 'back'), false, '被取消的旧 back 从未重放');
});

test('task quiesce regression: 在途 navigation.back 完成后才允许发布 acquire 收敛', async () => {
  const h = makeHarness();
  const originalSend = h.deps.cdp.send.bind(h.deps.cdp);
  let detailMode = false;
  let releaseNavigate!: () => void;
  let markNavigateStarted!: () => void;
  const navigateStarted = new Promise<void>((resolve) => { markNavigateStarted = resolve; });
  const navigateGate = new Promise<void>((resolve) => { releaseNavigate = resolve; });
  h.deps.cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Runtime.evaluate' && String(params.expression ?? '').includes('location.href')) {
      return { result: { value: detailMode ? 'https://www.xiaohongshu.com/explore/note-1' : 'https://www.xiaohongshu.com/explore' } } as never;
    }
    if (detailMode && method === 'Page.navigate') {
      markNavigateStarted();
      await navigateGate;
      detailMode = false;
      return {} as never;
    }
    return originalSend(method, params);
  };
  const sess = new BrowseSession(h.deps, noOpts());
  const running = sess.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  detailMode = true;
  await sess.onCloudCommand(makeEnvelope('navigation.back', 'active-back', 0, { reason: 'back_to_feed' }));
  await navigateStarted;
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 'stale-scroll', 0, { reason: 'old_page_decision' }));
  let acquired = false;
  const quiesced = sess.quiesceForTask().then((count) => { acquired = true; return count; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquired, false, 'navigation.back 的 Page.navigate 未完成时不得回 acquired');
  releaseNavigate();
  assert.equal(await quiesced, 1, 'back 后尚未开始的旧 scroll 被取消');
  assert.equal(h.completedActions.some((item) => item.action === 'back' && item.ok), true);
  await sess.resumeAfterTask();
  await sess.onCloudCommand(makeEnvelope('session.end', 'end-after-back', 0, { reason: 'done' }));
  await running;
});

// ======== feed.refresh（深度到阈值点右下「刷新」回顶换新批，change feed-refresh-on-depth）========

interface RefreshCtl {
  url?: string;      // location.href（默认 explore feed）
  locate?: string;   // .floating-btn-sets 定位结果（默认命中 {x,y}）
  verify?: string;   // 点后 {y,first} 后置校验（默认回顶+换新）
  preFirst?: string; // 点前首卡 noteId（默认 OLD）
}

function refreshHarness(ctl: RefreshCtl): Harness {
  const h = makeHarness();
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params.expression ?? '');
      if (expr.includes('window.scrollY')) {
        // 点后后置校验（含 a[href*=/explore/]，故须先于 pre-state 判）
        return { result: { value: ctl.verify ?? '{"y":0,"first":"NEWfeed01"}' } } as never;
      }
      if (expr.includes('floating-btn-sets')) {
        return { result: { value: ctl.locate ?? '{"x":100,"y":100}' } } as never;
      }
      if (expr === 'location.href') {
        return { result: { value: ctl.url ?? 'https://www.xiaohongshu.com/explore' } } as never;
      }
      if (expr.includes('/explore/')) {
        // 点前首卡 noteId（firstVisibleNoteId）
        return { result: { value: ctl.preFirst ?? 'OLDfeed00' } } as never;
      }
      return { result: { value: ctl.url ?? 'https://www.xiaohongshu.com/explore' } } as never;
    },
  };
  return h;
}

test('feed.refresh: 定位到刷新按钮 + 点后回顶换新批 → ok:true 且上报新 page.cards', async () => {
  const h = refreshHarness({ verify: '{"y":0,"first":"NEWfeed01"}', preFirst: 'OLDfeed00' });
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 15)); // start 初扫会先报一次 page.cards
  const before = h.reportedCards.length;
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.refresh', 'r1', 0, { reason: 'feed_refresh', thinkMs: 300 }));
  await new Promise((r) => setTimeout(r, 5));
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }));
  await done;
  const r = h.completedActions.find((a) => a.action === 'refresh');
  assert.ok(r, '应上报 refresh 回执');
  assert.equal(r!.ok, true);
  assert.equal(h.reportedCards.length, before + 1, '成功刷新须恰好上报一次新 page.cards');
});

test('feed.refresh: 点后首卡为空（仅回到顶部、内容未换）→ not_reloaded，绝不假成功、不报卡', async () => {
  // 对抗评审红线守卫：空首卡时 undefined!==pre 恒真会让纯回顶冒充换新批。
  const h = refreshHarness({ verify: '{"y":0,"first":""}', preFirst: 'OLDfeed00' });
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 15)); // start 初扫会先报一次 page.cards
  const before = h.reportedCards.length;
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.refresh', 'r1', 0, { reason: 'feed_refresh' }));
  await new Promise((r) => setTimeout(r, 5));
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }));
  await done;
  const r = h.completedActions.find((a) => a.action === 'refresh');
  assert.ok(r);
  assert.equal(r!.ok, false);
  assert.equal(r!.reason, 'not_reloaded');
  assert.equal(h.reportedCards.length, before, 'not_reloaded 不得把陈旧/空卡当新批上报');
});

test('feed.refresh: 找不到悬浮容器 → ok:false no_floating_btn（不假成功）', async () => {
  const h = refreshHarness({ locate: '{"error":"no_floating_btn"}' });
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('xiaohongshu.feed.refresh', 'r1', 0, { reason: 'feed_refresh' }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const r = h.completedActions.find((a) => a.action === 'refresh');
  assert.ok(r);
  assert.equal(r!.ok, false);
  assert.equal(r!.reason, 'no_floating_btn');
});

test('feed.refresh: 不在 explore feed → ok:false wrong_context（不点、不假成功）', async () => {
  const ctl: RefreshCtl = { url: 'https://www.xiaohongshu.com/explore' };
  const h = refreshHarness(ctl);
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  ctl.url = 'https://www.xiaohongshu.com/explore/6abc12345678?xsec_token=t'; // 详情页（非 feed）
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.refresh', 'r1', 0, { reason: 'feed_refresh' }));
  await new Promise((r) => setTimeout(r, 1));
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }));
  await done;
  const r = h.completedActions.find((a) => a.action === 'refresh');
  assert.ok(r);
  assert.equal(r!.ok, false);
  assert.equal(r!.reason, 'wrong_context');
});

// ======== 冷待机 / 退出：关浏览器前必须先把浏览循环排空（绝不对死 CDP 发调用）========
// 真机症状：外壳打「浏览器已关闭进入冷待机」后 13s，循环仍在首屏扫描里对死 CDP 发调用 →
// CdpDisconnectedError 冒到 main.ts 裸 catch，打成「浏览会话异常」。根因是 close() 只置标志、
// 启动段不看标志、且 waitForVisibleCards 把断连吞成「卡片还没渲染」空转满 12s 预算。

test('冷待机：closeAndWait 返回后循环已排空 → 之后关浏览器，绝不再有 CDP 调用、start() 不抛', async () => {
  const h = makeHarness();
  let browserClosed = false;
  let cdpCallsAfterBrowserClosed = 0;
  h.deps.scroller.getVisibleCards = async () => {
    if (browserClosed) {
      cdpCallsAfterBrowserClosed++;
      throw new CdpDisconnectedError('CDP 未连接，请先 connect()');
    }
    return [CARD];
  };
  // 真 sleep（有界）：让循环真的停在启动段的扫描延迟里，复现「close 撞上启动段」这条真机时序。
  const sess = new BrowseSession(h.deps, {
    random: () => 0.99,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    logger: () => {},
  });

  const done = sess.start();
  await new Promise((r) => setTimeout(r, 5)); // 循环此刻卡在 ensureExplore / 扫描延迟里

  const drained = await sess.closeAndWait(2000);
  browserClosed = true; // 外壳在这之后才真正杀浏览器（冷待机的正确时序）
  await done; // 绝不 reject：不再有「浏览会话异常」

  assert.equal(drained, true, 'closeAndWait 应在预算内排空');
  assert.equal(cdpCallsAfterBrowserClosed, 0, '关闭请求排空后绝不再对 CDP 发任何调用');
});

test('冷待机：浏览器真在首屏扫描中途死掉 → 干净退出，不抛异常、不空转满扫描预算', async () => {
  const h = makeHarness();
  let cardCalls = 0;
  h.deps.scroller.getVisibleCards = async () => {
    cardCalls++;
    throw new CdpDisconnectedError('CDP 未连接，请先 connect()'); // 浏览器已被关掉
  };
  const sess = new BrowseSession(h.deps, { ...noOpts(), initialScanTimeoutMs: 12000 });
  const t0 = Date.now();
  await sess.start(); // 旧行为：轮询吞异常满 12s，然后抛 CdpDisconnectedError 出来
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 2000, `断连必须立刻上抛、不得空转满扫描预算（实测 ${elapsed}ms）`);
  assert.equal(cardCalls, 1, '断连后不再重复轮询死 CDP');
  assert.equal(h.reportedCards.length, 0, '拿不到卡片就绝不上报（不静默假成功）');
});

test('冷待机：在途动作卡住时 closeAndWait 有界超时并如实返回 false（绝不把待机本身挂死）', async () => {
  const h = makeHarness();
  h.deps.scroller.getVisibleCards = () => new Promise(() => {}); // 永不 settle 的在途操作
  const sess = new BrowseSession(h.deps, { ...noOpts(), initialScanTimeoutMs: 12000 });
  void sess.start();
  await new Promise((r) => setTimeout(r, 5));

  const drained = await sess.closeAndWait(60);
  assert.equal(drained, false, '排空超时必须如实返回 false，由调用方诚实告警后照常关浏览器');
});

// ======== 安全取消点 / 任务接管让路（change lease-strict-preemption）========
//
// 死锁背景：浏览命令停在阻断浮层闸里（executeCommand 的第一句，任何页面写之前），交接无界地等它
// 「跑完」，而它等的验证码只有这次交接要授予的 system_recovery 协助任务才能点掉 → 闭环死锁。
// 修法：纯等待 = 安全取消点，被接管即当场让路（零页面副作用 + 诚实回执 + 不重放）。

/**
 * 让路用例专用 opts：sleep 必须让出**宏任务**。
 * 别的用例用「立即 resolve」的 sleep 桩，但浮层闸是个轮询循环——sleep 立即 resolve 会让它退化成纯微任务
 * 忙循环，把事件循环饿死，用例自己的 setTimeout 永远排不上（是测试桩的坑，不是产品代码的）。
 * armDwellBlock 置真后，超长停留（>60s；本用例下发 90s 预算）挂起不返回，用来验证「停留被接管唤醒」这条路径。
 * 阈值取 60s 只为挡住停留本身——别的等待（开笔记预算 30s、等卡 5s）都在其下；误挡会让用例假失败。
 */
function yieldingOpts(ctl: { armDwellBlock?: boolean } = {}) {
  return {
    random: () => 0.99,
    sleep: (ms: number) =>
      ctl.armDwellBlock && ms > 60_000
        ? new Promise<void>(() => {}) // 永不自然到时：只能被接管唤醒
        : new Promise<void>((r) => { setTimeout(r, 1); }),
    logger: () => {},
    loginGatePollMs: 5,
  };
}

test('让路: 命令停在阻断浮层闸时被接管 → 交接立即收敛、零页面写、回诚实失败回执', async () => {
  const h = makeHarness();
  let scrolled = 0;
  h.deps.scroller = { ...h.deps.scroller, scrollNext: async () => { scrolled++; } };
  // 首屏放行一次（loop 启动），之后恒 captcha：page.scroll 将永久停在浮层闸里。
  let n = 0;
  h.deps.overlayMonitor = fakeMonitor({ stateSeq: () => (++n > 1 ? 'captcha' : 'none') });
  const sess = new BrowseSession(h.deps, yieldingOpts());
  const running = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 'stuck-scroll', 0, { reason: 'active' }));
  await new Promise((r) => setTimeout(r, 10)); // 让它真正进到浮层闸里等着

  // 关键断言：交接必须立即收敛——绝不等那个永不消失的验证码。
  const cancelled = await sess.quiesceForTask(1_000);
  assert.equal(cancelled, 0, '没有未开始的旧命令');

  const preempted = h.completedActions.filter((a) => a.reason === 'preempted_by_task');
  assert.equal(preempted.length, 1, '被接管的命令必须回恰好一条诚实失败回执（MUST NOT 静默丢弃）');
  assert.equal(preempted[0].ok, false, '被接管 = 失败，绝不假装成功');
  assert.equal(preempted[0].action, 'xiaohongshu.feed.scroll', '回执动作名 = 协议消息名（边缘不建映射表）');
  assert.equal(scrolled, 0, '接管信号之后 MUST 记录到零次页面改写调用');

  sess.stop();
  await running.catch(() => {});
});

test('让路: 命令停在翻页前停留时被接管 → 交接毫秒级收敛、零页面写（长停留预算不得撑爆受理预算）', async () => {
  const h = makeHarness();
  let scrolled = 0;
  h.deps.scroller = { ...h.deps.scroller, scrollNext: async () => { scrolled++; } };
  // 停留阻塞只在启动完成后才武装——否则启动期的首屏扫描等待也会被挡住、start() 永不返回。
  const ctl = { armDwellBlock: false };
  const sess = new BrowseSession(h.deps, yieldingOpts(ctl));
  const running = sess.start();
  await new Promise((r) => setTimeout(r, 30));

  // 翻页前的「看完本批新卡」停留：下发 90s 预算，命令会停在停留里、尚未滚动。
  ctl.armDwellBlock = true;
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 'dwelling-scroll', 0, { reason: 'active', dwellMs: 90_000 }));
  await new Promise((r) => setTimeout(r, 30));

  const t0 = Date.now();
  await sess.quiesceForTask(2_000);
  assert.ok(Date.now() - t0 < 1_000, '交接必须毫秒级收敛，绝不等停留跑满');
  assert.equal(scrolled, 0, '停留是安全取消点：让路时一次页面写都不许发生');
  assert.ok(
    h.completedActions.some((a) => a.reason === 'preempted_by_task'),
    '停在停留里的命令同样要回诚实回执',
  );

  ctl.armDwellBlock = false;
  sess.stop();
  await running.catch(() => {});
});

test('让路判据是接管世代号，不是「浏览已冻结」标志：持权任务自己的命令绝不自尽', async () => {
  const h = makeHarness();
  let scrolled = 0;
  h.deps.scroller = { ...h.deps.scroller, scrollNext: async () => { scrolled++; } };
  const sess = new BrowseSession(h.deps, yieldingOpts());
  const running = sess.start();
  await new Promise((r) => setTimeout(r, 10));

  // 交接完成 → taskBlocked=true（冻结普通浏览），世代号推进到 N。
  await sess.quiesceForTask(1_000);

  // 独占任务自己的命令（带 taskId）跑在冻结期内：世代号仍是 N ⇒ MUST 正常执行。
  // 若判据误用 taskBlocked 标志，这条命令会在自己的第一个安全取消点当场自尽。
  await sess.onCloudCommand({
    ...makeEnvelope('xiaohongshu.feed.scroll', 'task-owned-scroll', 0, { reason: 'task' }),
    payload: { reason: 'task', taskId: 'T1' },
  } as unknown as Envelope);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(scrolled, 1, '持权任务自己的命令 MUST 正常执行（不因冻结标志自尽）');
  assert.equal(
    h.completedActions.some((a) => a.reason === 'preempted_by_task'),
    false,
    '持权任务的命令绝不能被判成「被接管」',
  );

  sess.stop();
  await running.catch(() => {});
});

test('交接有界且不撒谎: 真写段永不收敛 → quiesce 抛出（MUST NOT 谎称已收敛）', async () => {
  const h = makeHarness();
  // 注入一个永不返回的真实页面写（滚动），它在浮层闸之后、属于真写段。
  h.deps.scroller = { ...h.deps.scroller, scrollNext: () => new Promise<void>(() => {}) };
  const sess = new BrowseSession(h.deps, yieldingOpts());
  const running = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  await sess.onCloudCommand(makeEnvelope('xiaohongshu.feed.scroll', 'never-ends', 0, { reason: 'active' }));
  await new Promise((r) => setTimeout(r, 10));

  await assert.rejects(
    () => sess.quiesceForTask(50),
    (err: Error) => err.name === 'BrowseQuiesceTimeoutError',
    '真写段未在预算内收敛 MUST 抛出，绝不谎称已收敛',
  );

  // 注：这里刻意**不** await running —— 那条滚动被注入成永不返回，主循环也就永远走不出这条命令。
  // 这正是本用例要证明的东西：真写段确实卡死了，而交接必须有界地抛出、绝不陪它一起卡死。
  sess.stop();
  void running.catch(() => {});
});

// ======== 评论流的取消点补齐（change lease-strict-preemption 第 4 节）========
//
// 评论是唯一「一条命令里跨越安全区与禁区」的浏览动作：逐字输入期间的每个字符间隙都是安全取消点
// （下一个字符的 CDP 写尚未发出），而提交键一旦点下就进入禁区（已提交、结果未知）。两条用例各钉一端。

test('取消点: 评论逐字输入中途被接管 → 立刻停手 + 清场 + 诚实回 preempted_by_task（半截评论绝不留在框里）', async () => {
  const h = commentHarness({ verify: { cleared: true, ownRow: true } });
  const base = h.deps.cdp.send.bind(h.deps.cdp);
  const body = '这条评论刚打到一半就被独占任务接管了';
  // 逐字输入一旦开始，字符间隙的等待就**只能被接管唤醒**（永不自然到时）：接管若不唤醒可打断 sleep，
  // 本用例直接挂死超时——绝不靠真等墙钟把它蒙混过去。清场脚本发出后解除，让停止路径能正常收尾。
  const ctl = { typingArmed: false };
  let typed = 0;
  let editorCleared = 0;
  let signalTyping!: () => void;
  const typingStarted = new Promise<void>((resolve) => { signalTyping = resolve; });
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Input.insertText') {
        typed++;
        ctl.typingArmed = true;
        signalTyping();
      }
      // 让位前的清场脚本（CLEAR_COMMENT_EDITOR_JS，唯一 `return 'ok'` 的那条）；2b 的清场前置返回 JSON，不会误计。
      if (method === 'Runtime.evaluate' && String(params.expression ?? '').includes("return 'ok'")) {
        editorCleared++;
        ctl.typingArmed = false;
      }
      return base(method, params);
    },
  };
  const sess = new BrowseSession(h.deps, {
    random: () => 0.99,
    sleep: () => (ctl.typingArmed ? new Promise<void>(() => {}) : new Promise<void>((r) => { setTimeout(r, 1); })),
    logger: () => {},
  });
  const running = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  await sess.onCloudCommand(makeEnvelope('interaction.comment', 'c-mid-typing', 0, { noteId: 'n1', text: body }));
  await typingStarted;
  await new Promise((r) => setTimeout(r, 10)); // 让它真正停在「下一个字符前」的那个等待里

  const t0 = Date.now();
  await sess.quiesceForTask(2_000);
  assert.ok(Date.now() - t0 < 1_000, '字符间隙是安全取消点：交接必须毫秒级收敛，绝不等这条评论敲完');
  assert.ok(typed >= 1 && typed < Array.from(body).length, `必须真的停在打字中途（已打 ${typed} / 共 ${Array.from(body).length} 字）`);
  assert.equal(editorCleared, 1, '让位前 MUST 清场：半截评论留在框里，下一条评论会被清场闸判 editor_not_clean（清不掉时更会拼接发出）');
  assert.equal(h.completedActions.length, 1, '被接管的评论命令只回一条回执（MUST NOT 静默丢弃、也不重复上报）');
  assert.deepEqual(
    h.completedActions[0],
    { action: 'interaction.comment', ok: false, reason: 'preempted_by_task' },
    '被接管 = 诚实失败回执，绝不降级成中文 message / engine_error 之类的别的分类',
  );

  sess.stop();
  await running.catch(() => {});
});

test('🔴 禁区: 提交键点下之后被接管 → 后置校验照跑完，回 ok / submitted_unconfirmed，绝不回 preempted、绝不重发', async () => {
  // 提交动作已经派发出去了：这条评论可能真已发出。谎报「未提交」会让上游重试 ⇒ 重复评论。
  const h = commentHarness({ verify: { cleared: true, ownRow: true } });
  const base = h.deps.cdp.send.bind(h.deps.cdp);
  let submitLocated = false;
  let submitPresses = 0;
  let verifyProbes = 0;
  let signalSubmitClicked!: () => void;
  const submitClicked = new Promise<void>((resolve) => { signalSubmitClicked = resolve; });
  let armTakeover!: () => void;
  const takeoverArmed = new Promise<void>((resolve) => { armTakeover = resolve; });
  h.deps.cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        if (expr.includes('btn.submit')) submitLocated = true;
        if (expr.includes('ownRow')) {
          verifyProbes++;
          await takeoverArmed; // 后置校验只在接管已生效后才作答 ⇒ 用例钉的确实是「禁区里被接管」这一刻
        }
      }
      if (method === 'Input.dispatchMouseEvent' && submitLocated) {
        if (params.type === 'mousePressed') submitPresses++;
        if (params.type === 'mouseReleased') signalSubmitClicked();
      }
      return base(method, params);
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  const running = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  await sess.onCloudCommand(makeEnvelope('interaction.comment', 'c-submitted', 0, { noteId: 'n1', text: '提交之后才被接管' }));
  await submitClicked;

  const quiesced = sess.quiesceForTask(2_000);
  armTakeover(); // 世代号已在 quiesceForTask 的同步段推进 ⇒ 此后的后置校验跑在「已被接管」态里
  await quiesced;

  assert.equal(submitPresses, 1, '提交只许点一次：接管绝不能让这条评论被重发');
  assert.ok(verifyProbes >= 1, '提交后的后置校验 MUST 跑完（禁区里不许取消）');
  const c = h.completedActions.find((a) => a.action === 'comment');
  assert.ok(c, '提交后被接管仍 MUST 回一条评论结果回执');
  assert.notEqual(c!.reason, 'preempted_by_task', '提交已派发：谎报「未提交」会让上游重试 ⇒ 重复评论');
  assert.equal(
    h.completedActions.some((a) => a.reason === 'preempted_by_task'),
    false,
    '禁区里的取消点 = 把一次可能已生效的写当成没发生，绝不允许',
  );
  // 只准落在「已确认生效」或「已提交、结果未知」两态之一——本用例 MUST NOT 断言必须是成功那一态
  // （那等于给「接管后后置校验回成功」背书 = 假成功的口子）。
  assert.ok(
    c!.ok === true || c!.reason === 'submitted_unconfirmed',
    `提交后的回执只能是 ok 或 submitted_unconfirmed，实际 ${JSON.stringify(c)}`,
  );

  sess.stop();
  await running.catch(() => {});
});
