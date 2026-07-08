import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEnvelope, type ActionCompletedPayload, type NoteDetailPayload, type PageCardsPayload } from '../../src/comm/protocol.js';
import {
  FacebookCommentHandler,
  type FacebookCommentReplyClient,
} from '../../src/facebook/comment-handler.js';
import type {
  FacebookOpenResult,
  FacebookSearchResult,
  FacebookSubmitResult,
} from '../../src/facebook/comment-executor.js';

// 最小执行器桩：三个方法各返可配结果。
class FakeExecutor {
  searchArg?: { keyword: string; container: string };
  openArg?: string;
  submitArg?: { url: string; text: string };
  constructor(
    private readonly cfg: {
      search?: FacebookSearchResult;
      open?: FacebookOpenResult;
      submit?: FacebookSubmitResult;
    } = {},
  ) {}
  async searchInContainer(keyword: string, container: string): Promise<FacebookSearchResult> {
    this.searchArg = { keyword, container };
    return this.cfg.search ?? { ok: true, candidates: [] };
  }
  async openPost(url: string): Promise<FacebookOpenResult> {
    this.openArg = url;
    return this.cfg.open ?? { ok: true, editorReady: true };
  }
  async submitComment(url: string, text: string): Promise<FacebookSubmitResult> {
    this.submitArg = { url, text };
    return this.cfg.submit ?? { ok: true, submitted: true, serverConfirmed: true };
  }
}

interface Captured {
  cards: PageCardsPayload[];
  details: NoteDetailPayload[];
  actions: ActionCompletedPayload[];
}
function fakeClient(): { client: FacebookCommentReplyClient; cap: Captured } {
  const cap: Captured = { cards: [], details: [], actions: [] };
  const client: FacebookCommentReplyClient = {
    reportPageCards: (p) => cap.cards.push(p),
    reportNoteDetail: (p) => cap.details.push(p),
    reportActionCompleted: (p) => cap.actions.push(p),
  };
  return { client, cap };
}

function makeHandler(exec: FakeExecutor) {
  const { client, cap } = fakeClient();
  const handler = new FacebookCommentHandler({
    executor: exec as unknown as import('../../src/facebook/comment-executor.js').FacebookCommentExecutor,
    client,
    logger: () => {},
  });
  return { handler, cap };
}

test('fb-handler: search.execute 命中候选 → page.cards（permalink 放 noteId + 群名回传）', async () => {
  const exec = new FakeExecutor({
    search: {
      ok: true,
      candidates: [{ index: 0, permalink: 'https://www.facebook.com/groups/1/posts/2', kind: 'group_post', hasCommentRegion: true }],
      containerName: 'Puerto Rico Y Sus Encantos e Historia',
    },
  });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('search.execute', 'c1', 1, { keyword: '咖啡', container: 'https://www.facebook.com/groups/1' } as never));
  assert.equal(cap.cards.length, 1);
  assert.equal(cap.cards[0].cards[0].noteId, 'https://www.facebook.com/groups/1/posts/2');
  assert.equal(cap.cards[0].containerName, 'Puerto Rico Y Sus Encantos e Historia');
  assert.equal(cap.actions.length, 0);
  assert.deepEqual(exec.searchArg, { keyword: '咖啡', container: 'https://www.facebook.com/groups/1' });
});

test('fb-handler: search.execute 无容器 → permission_gated（绝不全站搜）', async () => {
  const exec = new FakeExecutor();
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('search.execute', 'c1', 1, { keyword: '咖啡' } as never));
  assert.equal(cap.cards.length, 0);
  assert.equal(cap.actions[0].action, 'search');
  assert.equal(cap.actions[0].ok, false);
  assert.equal(cap.actions[0].reason, 'permission_gated');
});

test('fb-handler: search 被阻断 → action.completed{action:search,ok:false}', async () => {
  const exec = new FakeExecutor({ search: { ok: false, reason: 'login_required', candidates: [] } });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('search.execute', 'c1', 1, { keyword: '咖啡', container: 'https://www.facebook.com/groups/1' } as never));
  assert.equal(cap.actions[0].action, 'search');
  assert.equal(cap.actions[0].reason, 'login_required');
  assert.equal(cap.cards.length, 0);
});

test('fb-handler: note.open{url} 开帖+评论框就绪 → note.detail', async () => {
  const exec = new FakeExecutor({ open: { ok: true, editorReady: true } });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('note.open', 'c1', 1, { url: 'https://www.facebook.com/groups/1/posts/2' } as never));
  assert.equal(cap.details.length, 1);
  assert.equal(cap.details[0].noteId, 'https://www.facebook.com/groups/1/posts/2');
  assert.equal(exec.openArg, 'https://www.facebook.com/groups/1/posts/2');
});

test('fb-handler: note.open 无 url → open_note no_target', async () => {
  const exec = new FakeExecutor();
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('note.open', 'c1', 1, {} as never));
  assert.equal(cap.details.length, 0);
  assert.equal(cap.actions[0].action, 'open_note');
  assert.equal(cap.actions[0].reason, 'no_target');
});

test('fb-handler: note.open 评论框催不出 → open_note editor_not_found（换下一个候选）', async () => {
  const exec = new FakeExecutor({ open: { ok: true, editorReady: false } });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('note.open', 'c1', 1, { url: 'https://www.facebook.com/groups/1/posts/2' } as never));
  assert.equal(cap.details.length, 0);
  assert.equal(cap.actions[0].action, 'open_note');
  assert.equal(cap.actions[0].reason, 'editor_not_found');
});

test('fb-handler: interaction.comment 成功 → action.completed{comment,ok:true}', async () => {
  const exec = new FakeExecutor({ submit: { ok: true, submitted: true, serverConfirmed: true } });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(
    makeEnvelope('interaction.comment', 'c1', 1, { noteId: 'https://www.facebook.com/groups/1/posts/2', text: '很喜欢' } as never),
  );
  assert.equal(cap.actions[0].action, 'comment');
  assert.equal(cap.actions[0].ok, true);
  assert.deepEqual(exec.submitArg, { url: 'https://www.facebook.com/groups/1/posts/2', text: '很喜欢' });
});

test('fb-handler: interaction.comment ambiguous → action.completed{comment,ok:false,reason}', async () => {
  const exec = new FakeExecutor({ submit: { ok: false, reason: 'verification_ambiguous', submitted: true, serverConfirmed: false } });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(
    makeEnvelope('interaction.comment', 'c1', 1, { noteId: 'https://www.facebook.com/groups/1/posts/2', text: '很喜欢' } as never),
  );
  assert.equal(cap.actions[0].action, 'comment');
  assert.equal(cap.actions[0].ok, false);
  assert.equal(cap.actions[0].reason, 'verification_ambiguous');
});

test('fb-handler: 不支持的白名单命令（session.end）→ capability_unsupported（绝不静默丢弃）', async () => {
  const exec = new FakeExecutor();
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('session.end', 'c1', 1, { reason: 'x' } as never));
  assert.equal(cap.actions.length, 1);
  assert.equal(cap.actions[0].ok, false);
  assert.equal(cap.actions[0].reason, 'capability_unsupported');
});
