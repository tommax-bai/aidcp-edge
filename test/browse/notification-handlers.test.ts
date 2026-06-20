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

const CARD: NoteCard = { position: 0, centerX: 10, centerY: 10, title: 'A', author: 'u', likes: '100', isVideo: false };

function fakeContent(): NoteContent {
  return { title: 'A', body: 'b', author: 'u', likes: 1, collects: 0, comments: 0, tags: [], isLiked: false };
}

interface Sent { type: string; payload: unknown }

/** cdp 行为：normal=按通知 JS 返回桩值；throw=Runtime.evaluate 抛错（验证失败不吞）。 */
function makeHarness(mode: 'normal' | 'throw' = 'normal') {
  const sent: Sent[] = [];
  const completed: ActionCompletedPayload[] = [];

  const cdp: BrowseCdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params.expression ?? '');
      // 仅通知 handler 的 eval 在 throw 模式抛错；启动期 URL 探测照常成功（否则 ensureExplore 空等超时）。
      const isNotifExpr =
        expr.includes('/notification') || expr.includes('unreadNear') ||
        expr.includes('评论和@') || expr.includes('isMention') || expr.includes('new RegExp(');
      if (mode === 'throw' && isNotifExpr) throw new Error('cdp boom');
      if (expr.includes('unreadNear')) {
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
      // 导航点击 / tab 点击 / scrollBy 等动作 expr → 命中即可（返回值不被业务校验）；
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
    reportNoteContent: async (_p: NoteContentPayload): Promise<Envelope> => makeEnvelope('browse.next', 'ack', 0, { reason: 'ack' }),
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
