/**
 * 通知巡视（消息查看）边缘 handler 单测 — 按分类原子动作。
 *
 * 守护点：
 *  - notification.open → 导航通知首页 + 上报 notification.home（各类未读）；
 *  - notification.browse_comments → 进评论和@ + 滚动抽取 + 上报 notification.items（原始项）；
 *  - notification.browse_likes/follows → 看一眼清未读 + 如实 action.completed 回执；
 *  - 失败不静默吞：home 上报全 0 / items 上报空 / 回执 ok:false（红线：自愈不自残）。
 *
 * 环境层级：离线 / 逻辑级（cdp 用桩，无浏览器）。选择器真机校准见 tasks 6.5。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowseSession, type BrowseSessionDeps } from '../../src/browse/browse-session.js';
import type { FeedScroller, NoteCard } from '../../src/browse/feed-scroller.js';
import type { ModalController } from '../../src/browse/modal-controller.js';
import type { NoteContent } from '../../src/browse/note-extractor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import {
  makeEnvelope,
  type Envelope,
  type NoteContentPayload,
  type ActionCompletedPayload,
} from '../../src/comm/protocol.js';
import type { PlanStep, ActionResultPayload } from '../../src/comm/protocol.js';
import { CdpDisconnectedError } from '../../src/cdp/client.js';

const CARD: NoteCard = { position: 0, centerX: 10, centerY: 10, title: 'A', author: 'u', likes: '100', isVideo: false };

function fakeContent(): NoteContent {
  return { title: 'A', body: 'b', author: 'u', likes: 1, collects: 0, comments: 0, tags: [], images: [], isLiked: false };
}

interface Sent { type: string; payload: unknown }

/**
 * cdp 行为：
 *  - normal：按通知 JS 返回桩值；
 *  - throw：通知 eval 抛普通 Error（业务/选择器失败，不吞）；
 *  - disconnect：通知 eval 抛 CdpDisconnectedError（断连——handler 必须重抛、绝不假报成功）。
 * viewClickHits=false：看一眼分类 tab 点击 JS（含 new RegExp）返回 false（模拟选择器漂移未命中 → 应 no_target）。
 */
function makeHarness(mode: 'normal' | 'throw' | 'disconnect' = 'normal', viewClickHits = true) {
  const sent: Sent[] = [];
  const completed: ActionCompletedPayload[] = [];

  const cdp: BrowseCdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params.expression ?? '');
      // 仅通知 handler 的 eval 在 throw/disconnect 模式抛错；启动期 URL 探测照常成功（否则 ensureExplore 空等超时）。
      const isNotifExpr =
        expr.includes('/notification') || expr.includes('tabUnread') ||
        expr.includes('评论和@') || expr.includes('isMention') || expr.includes('new RegExp(');
      if ((mode === 'throw' || mode === 'disconnect') && isNotifExpr) {
        throw mode === 'disconnect' ? new CdpDisconnectedError('cdp 断连') : new Error('cdp boom');
      }
      if (expr.includes('tabUnread')) {
        return { result: { value: '{"comments":2,"likes":1,"follows":0}' } } as never;
      }
      if (expr.includes('isMention')) {
        return {
          result: {
            value: JSON.stringify([
              { kind: 'comment', fromUser: '小明', content: '学到了', noteTitle: '我的笔记', itemKey: '/note/c1' },
              { kind: 'mention', fromUser: '小红', content: '@你看看这个', itemKey: '/note/m1' },
            ]),
          },
        } as never;
      }
      // 看一眼分类 tab 点击 JS（含 new RegExp）：命中可控（false 模拟选择器漂移）。须先于通用 click 分支判定。
      if (expr.includes('new RegExp(')) return { result: { value: viewClickHits } } as never;
      // 导航点击 / scrollBy 等动作 expr → 命中即可（返回值不被业务校验）；
      // 其余（URL 探测等）回 explore URL，满足 start() 的 ensureExplore，避免空等初始扫描超时。
      if (expr.includes('click') || expr.includes('scrollBy')) return { result: { value: true } } as never;
      return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
    },
  };

  const scroller: FeedScroller = {
    getVisibleCards: async () => [CARD],
    scrollNext: async () => {},
    openCard: async () => {},
  };
  const modalCtrl: ModalController = {
    isModalOpen: async () => false,
    closeModal: async () => {},
    waitForModal: async () => true,
  };
  const client = {
    reportNoteContent: async (_p: NoteContentPayload): Promise<Envelope> => makeEnvelope('page.scroll', 'ack', 0, { reason: 'ack' }),
    reportPageCards: () => {},
    reportNoteDetail: () => {},
    reportProfileDetail: () => {},
    reportActionCompleted: (p: ActionCompletedPayload) => { completed.push(p); },
    send: (type: string, payload: unknown) => { sent.push({ type, payload }); },
  };
  const stepRunner = {
    run: async (step: PlanStep): Promise<ActionResultPayload> => ({ actionId: step.actionId, ok: true, outcome: 'success', attempts: 1, reason: 'ok' }),
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
  return { deps, sent, completed };
}

function noOpts() {
  return { random: () => 0.99, sleep: async () => {}, logger: () => {} };
}

async function startAndPush(sess: BrowseSession, commands: Envelope[]): Promise<void> {
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  for (const cmd of commands) {
    await sess.onCloudCommand(cmd);
    await new Promise((r) => setTimeout(r, 1));
  }
  await done;
}

test('notification.open → 导航通知首页并上报 notification.home（各类未读）', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('notification.open', 'n1', 0, {}),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const home = h.sent.find((s) => s.type === 'notification.home');
  assert.ok(home, '应上报 notification.home');
  assert.deepEqual(home!.payload, { comments: 2, likes: 1, follows: 0 });
});

test('notification.browse_comments → 抽取评论/@ 原始项并上报 notification.items', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('notification.browse_comments', 'n2', 0, { scrollMax: 2 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const items = h.sent.find((s) => s.type === 'notification.items');
  assert.ok(items, '应上报 notification.items');
  const payload = items!.payload as { items: { kind: string; fromUser: string }[] };
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].fromUser, '小明');
  assert.equal(payload.items[1].kind, 'mention');
});

test('notification.browse_likes → 看一眼清未读 + 如实 action.completed 回执', async () => {
  const h = makeHarness();
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('notification.browse_likes', 'n3', 0, {}),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const rec = h.completed.find((c) => c.action === 'browse_notification_likes');
  assert.ok(rec, '应回执 browse_notification_likes');
  assert.equal(rec!.ok, true);
});

test('失败不静默吞：cdp 抛错 → home 上报全 0', async () => {
  const h = makeHarness('throw');
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('notification.open', 'n4', 0, {}),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const home = h.sent.find((s) => s.type === 'notification.home');
  assert.ok(home, '失败也应上报 notification.home（不静默吞）');
  assert.deepEqual(home!.payload, { comments: 0, likes: 0, follows: 0 });
});

test('失败不静默吞：cdp 抛错 → items 上报空 + likes 回执 ok:false', async () => {
  const h = makeHarness('throw');
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('notification.browse_comments', 'n5', 0, {}),
    makeEnvelope('notification.browse_likes', 'n6', 0, {}),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const items = h.sent.find((s) => s.type === 'notification.items');
  assert.ok(items, '失败也应上报 notification.items');
  assert.deepEqual((items!.payload as { items: unknown[] }).items, []);
  const rec = h.completed.find((c) => c.action === 'browse_notification_likes');
  assert.ok(rec && rec.ok === false, 'likes 失败应如实回执 ok:false');
});

test('NM-C-1: 看一眼未命中分类 tab → ok:false reason:no_target（绝不丢弃点击返回值假报 viewed）', async () => {
  const h = makeHarness('normal', false); // 分类 tab 点击返回 false（选择器漂移/未渲染）
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('notification.browse_likes', 'n', 0, {}),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  const rec = h.completed.find((c) => c.action === 'browse_notification_likes');
  assert.ok(rec, '应有回执');
  assert.equal(rec!.ok, false, '未命中 tab 不得假报成功');
  assert.equal(rec!.reason, 'no_target', '应诚实 no_target，暴露选择器漂移');
});

test('CDP-NOTIF-1: 通知 open 断连 → 重抛冒泡、绝不假报 notification.home（区别于业务失败才上报全 0）', async () => {
  const h = makeHarness('disconnect'); // 无 on → waitForReconnect 立即 false → 会话诚实结束
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('notification.open', 'n', 0, {}),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(!h.sent.find((s) => s.type === 'notification.home'), '断连绝不假报 notification.home');
});

test('CDP-NOTIF-1: 通知 browse_comments 断连 → 绝不假报空 items', async () => {
  const h = makeHarness('disconnect');
  const sess = new BrowseSession(h.deps, noOpts());
  await startAndPush(sess, [
    makeEnvelope('notification.browse_comments', 'n', 0, { scrollMax: 1 }),
    makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }),
  ]);
  assert.ok(!h.sent.find((s) => s.type === 'notification.items'), '断连绝不假报空 items');
});

test('CDP-NOTIF-1: 巡视中断连重连成功 → 发诚实 ok:false(cdp_reconnect_aborted) 终止回执，触发云端关暂停回 feed', async () => {
  const h = makeHarness('normal');
  const reconnectedListeners: Array<(params: unknown) => void> = [];
  let threwOnce = false;
  // 覆盖 cdp：首个通知 eval 抛 CdpDisconnectedError，并安排（waiter 注册后的）setImmediate 触发重连成功。
  (h.deps as { cdp: BrowseCdp }).cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params.expression ?? '');
      const isNotif =
        expr.includes('/notification') || expr.includes('tabUnread') ||
        expr.includes('评论和@') || expr.includes('new RegExp(') || expr.includes('isMention');
      if (isNotif && !threwOnce) {
        threwOnce = true;
        setImmediate(() => { for (const l of reconnectedListeners.slice()) l(undefined); });
        throw new CdpDisconnectedError('cdp 断连');
      }
      if (expr.includes('click') || expr.includes('scrollBy')) return { result: { value: true } } as never;
      return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
    },
    on: (method: string, cb: (params: unknown) => void) => {
      if (method === 'cdp.reconnected') reconnectedListeners.push(cb);
      return () => {};
    },
  };
  const sess = new BrowseSession(h.deps, noOpts());
  const done = sess.start();
  await new Promise((r) => setTimeout(r, 10));
  await sess.onCloudCommand(makeEnvelope('notification.open', 'n', 0, {}));
  await new Promise((r) => setTimeout(r, 30));
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'test_end' }));
  await done;
  assert.ok(!h.sent.find((s) => s.type === 'notification.home'), '断连绝不假报 notification.home');
  const abort = h.completed.find((c) => c.reason === 'cdp_reconnect_aborted');
  assert.ok(abort, '重连后应发 cdp_reconnect_aborted 中止回执');
  assert.equal(abort!.ok, false, '中止回执必须 ok:false（诚实，非伪造成功）');
  assert.equal(abort!.action, 'notification_back_home', '用 notification_back_home 触发云端 excursion_resumer 关暂停');
});
