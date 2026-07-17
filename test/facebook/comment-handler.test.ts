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
import type { FacebookJoinResult } from '../../src/facebook/join-executor.js';

// 最小执行器桩：三个方法各返可配结果。
class FakeExecutor {
  searchArg?: { keyword: string; container: string };
  openArg?: string;
  submitArg?: { url: string; text: string; contactInfo?: string };
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
  async submitComment(url: string, text: string, contactInfo?: string): Promise<FacebookSubmitResult> {
    this.submitArg = { url, text, ...(contactInfo ? { contactInfo } : {}) };
    return this.cfg.submit ?? { ok: true, submitted: true, serverConfirmed: true };
  }
}

class FakeJoinExecutor {
  joinArg?: { groupUrl: string; click?: boolean; thinkMs?: number };
  constructor(private readonly result: FacebookJoinResult) {}
  async joinGroup(groupUrl: string, options: { click?: boolean; thinkMs?: number } = {}): Promise<FacebookJoinResult> {
    this.joinArg = {
      groupUrl,
      ...(typeof options.click === 'boolean' ? { click: options.click } : {}),
      ...(typeof options.thinkMs === 'number' ? { thinkMs: options.thinkMs } : {}),
    };
    return this.result;
  }
}

/** 陪伴客户端活动条目（change facebook-write-action-visibility）：按发射器契约断言的最小形状。 */
interface UiEvent {
  kind: string;
  type: string;
  sentence?: string;
  presence?: string;
  loopStage?: string;
  statsDelta?: { views?: number; likes?: number; comments?: number };
}

interface Captured {
  cards: PageCardsPayload[];
  details: NoteDetailPayload[];
  actions: ActionCompletedPayload[];
  /** 从 logger 里解析出的 [ui-event] 行——覆盖压在**发射器侧**：壳侧解析器测试只测解析器、
   *  从不执行发射器，改一句措辞它照样全绿而条目静默消失。 */
  ui: UiEvent[];
}
function fakeClient(): { client: FacebookCommentReplyClient; cap: Captured } {
  const cap: Captured = { cards: [], details: [], actions: [], ui: [] };
  const client: FacebookCommentReplyClient = {
    reportPageCards: (p) => cap.cards.push(p),
    reportNoteDetail: (p) => cap.details.push(p),
    reportActionCompleted: (p) => cap.actions.push(p),
  };
  return { client, cap };
}

const UI_PREFIX = '[ui-event]';

function makeHandler(exec: FakeExecutor, joinExec?: FakeJoinExecutor) {
  const { client, cap } = fakeClient();
  const handler = new FacebookCommentHandler({
    executor: exec as unknown as import('../../src/facebook/comment-executor.js').FacebookCommentExecutor,
    ...(joinExec ? { joinExecutor: joinExec as unknown as import('../../src/facebook/join-executor.js').FacebookJoinExecutor } : {}),
    client,
    logger: (m: string) => {
      const at = m.indexOf(UI_PREFIX);
      if (at === -1) return;
      cap.ui.push(JSON.parse(m.slice(at + UI_PREFIX.length).trim()) as UiEvent);
    },
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

test('fb-handler: interaction.comment 带 groupChatCode → 透传给 executor contactInfo', async () => {
  const exec = new FakeExecutor({ submit: { ok: true, submitted: true, serverConfirmed: true } });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(
    makeEnvelope('interaction.comment', 'c1', 1, {
      noteId: 'https://www.facebook.com/groups/1/posts/2',
      text: '正文',
      groupChatCode: 'LINE ID: abc123',
    } as never),
  );
  assert.equal(cap.actions[0].ok, true);
  assert.deepEqual(exec.submitArg, {
    url: 'https://www.facebook.com/groups/1/posts/2',
    text: '正文',
    contactInfo: 'LINE ID: abc123',
  });
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

test('fb-handler: group.join 路由到 join executor，回 action.completed{join_group}', async () => {
  const exec = new FakeExecutor();
  const joinExec = new FakeJoinExecutor({
    ok: false,
    reason: 'observation_only',
    groupUrl: 'https://www.facebook.com/groups/1',
    clicked: false,
    observation: { groupUrl: 'https://www.facebook.com/groups/1', mainCtaText: 'Join group' },
  });
  const { handler, cap } = makeHandler(exec, joinExec);
  await handler.handle(makeEnvelope('group.join', 'c1', 1, { groupUrl: 'https://www.facebook.com/groups/1', click: false } as never));
  assert.equal(cap.actions[0].action, 'join_group');
  assert.equal(cap.actions[0].ok, false);
  assert.equal(cap.actions[0].reason, 'observation_only');
  assert.equal(cap.actions[0].groupUrl, 'https://www.facebook.com/groups/1');
  assert.deepEqual(joinExec.joinArg, { groupUrl: 'https://www.facebook.com/groups/1', click: false });
});

test('fb-handler: group.join 未装配 join executor → capability_unsupported', async () => {
  const { handler, cap } = makeHandler(new FakeExecutor());
  await handler.handle(makeEnvelope('group.join', 'c1', 1, { groupUrl: 'https://www.facebook.com/groups/1' } as never));
  assert.equal(cap.actions[0].action, 'join_group');
  assert.equal(cap.actions[0].ok, false);
  assert.equal(cap.actions[0].reason, 'capability_unsupported');
});

// ─────────────────────────────────────────────────────────────────────────────
// 陪伴客户端活动条目（change facebook-write-action-visibility）
//
// 这条委托路径原本对客户端**完全静默**：评论/加群/搜索由会话直接委托到本处理器，处理器自己回执给
// 云端后返回，走不到会话里唯一的叙述出口 ⇒ 运营分不清「没做」和「做了但没显示」。
// 断言压在**发射器侧**：壳侧解析器测试只测解析器、从不执行发射器，改一句措辞它照样全绿。
// ─────────────────────────────────────────────────────────────────────────────

test('fb-ui: 评论真成功 → comment 条目 + comments:1（唯一计数点）', async () => {
  const exec = new FakeExecutor({ submit: { ok: true, submitted: true, serverConfirmed: true } });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('interaction.comment', 'c1', 1, {
    noteId: 'https://www.facebook.com/groups/1/posts/2',
    text: '这个岗位还招人吗？',
  } as never));
  const ev = cap.ui.filter((e) => e.kind === 'activity');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'comment');
  assert.equal(ev[0].statsDelta?.comments, 1);
  // 主语用打进去的评论文本（一手），绝不用 permalink。
  assert.match(ev[0].sentence ?? '', /这个岗位还招人吗/);
  assert.doesNotMatch(ev[0].sentence ?? '', /facebook\.com/);
});

test('fb-ui【红线】: 评论待群管理员批准 → comment_pending，不说已发布、绝不计数', async () => {
  const exec = new FakeExecutor({
    submit: { ok: false, reason: 'pending_group_approval', submitted: true, serverConfirmed: false },
  });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('interaction.comment', 'c1', 1, {
    noteId: 'https://www.facebook.com/groups/1/posts/2',
    text: '请问还招人吗',
  } as never));
  const ev = cap.ui.filter((e) => e.kind === 'activity');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'comment_pending');
  assert.match(ev[0].sentence ?? '', /待管理员批准/);
  // 未上墙：绝不计数（云端 dailyUsage 才是权威，本地兜底不得虚增）。
  assert.equal(ev[0].statsDelta, undefined);
  // 也绝不能读成「已发布」。
  assert.doesNotMatch(ev[0].sentence ?? '', /^评论了/);
});

test('fb-ui: 评论框没找到 → comment_failed 且吐人话、不吐机器码', async () => {
  const exec = new FakeExecutor({
    submit: { ok: false, reason: 'editor_not_found', submitted: false, serverConfirmed: false },
  });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('interaction.comment', 'c1', 1, { noteId: 'u', text: 'x' } as never));
  const ev = cap.ui.filter((e) => e.kind === 'activity');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'comment_failed');
  assert.match(ev[0].sentence ?? '', /评论框没找到/);
  assert.doesNotMatch(ev[0].sentence ?? '', /editor_not_found/);
  assert.equal(ev[0].statsDelta, undefined);
});

test('fb-ui【红线】: 未知失败原因默认可见（拒绝集而非白名单）', async () => {
  const exec = new FakeExecutor({
    submit: { ok: false, reason: 'brand_new_reason_nobody_mapped' as never, submitted: false, serverConfirmed: false },
  });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('interaction.comment', 'c1', 1, { noteId: 'u', text: 'x' } as never));
  const ev = cap.ui.filter((e) => e.kind === 'activity');
  // 白名单实现会在这里静默吞掉——那正是本 change 要修的病。
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'comment_failed');
  assert.match(ev[0].sentence ?? '', /没能完成/);
});

test('fb-ui: 被占用 / 被抢占 = 未开始，不产条目也不叙述成失败', async () => {
  for (const reason of ['busy', 'preempted_by_task', 'session_closing', 'capability_unsupported'] as const) {
    const exec = new FakeExecutor({ submit: { ok: false, reason: reason as never, submitted: false, serverConfirmed: false } });
    const { handler, cap } = makeHandler(exec);
    await handler.handle(makeEnvelope('interaction.comment', 'c1', 1, { noteId: 'u', text: 'x' } as never));
    assert.equal(cap.ui.filter((e) => e.kind === 'activity').length, 0, `${reason} 不应产条目`);
  }
});

test('fb-ui: 加群成功以「ok && clicked」为闸（镜像云端证据闸）', async () => {
  const join = new FakeJoinExecutor({
    ok: true,
    clicked: true,
    groupUrl: 'https://www.facebook.com/groups/1',
    // 真实形状：FB 标题常带未读计数前缀 + " | Facebook" 后缀（越南语群名，取自 dev 真机）。
    postObservation: { title: '(3) Việc Làm KCN | Facebook' },
  });
  const { handler, cap } = makeHandler(new FakeExecutor(), join);
  await handler.handle(makeEnvelope('group.join', 'c1', 1, { groupUrl: 'https://www.facebook.com/groups/1' } as never));
  const ev = cap.ui.filter((e) => e.kind === 'activity');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'join_group');
  // 群名剥掉通知计数前缀与 Facebook 后缀，绝不露 URL。
  assert.match(ev[0].sentence ?? '', /加入了小组「Việc Làm KCN」/);
  assert.doesNotMatch(ev[0].sentence ?? '', /facebook\.com/);
  assert.equal(ev[0].statsDelta, undefined); // 加群无计数字段，绝不凭空造
});

test('fb-ui: 超长群名有界截断（越南语群名常超 18 字，活动流一行放得下才是目的）', async () => {
  const join = new FakeJoinExecutor({
    ok: true,
    clicked: true,
    groupUrl: 'https://www.facebook.com/groups/1',
    postObservation: { title: 'Việc Làm KCN Long Hậu | Facebook' },
  });
  const { handler, cap } = makeHandler(new FakeExecutor(), join);
  await handler.handle(makeEnvelope('group.join', 'c1', 1, { groupUrl: 'https://www.facebook.com/groups/1' } as never));
  const s = cap.ui.filter((e) => e.kind === 'activity')[0].sentence ?? '';
  assert.match(s, /加入了小组「Việc Làm KCN Long …」/); // 截断而非截错、不露 URL
});

test('fb-ui【红线】: 加群待批准 → join_pending，绝不说「加入了」', async () => {
  const join = new FakeJoinExecutor({
    ok: false,
    reason: 'pending',
    clicked: true,
    groupUrl: 'https://www.facebook.com/groups/1',
    postObservation: { title: 'Việc Làm KCN Quang Minh | Facebook' },
  });
  const { handler, cap } = makeHandler(new FakeExecutor(), join);
  await handler.handle(makeEnvelope('group.join', 'c1', 1, { groupUrl: 'https://www.facebook.com/groups/1' } as never));
  const ev = cap.ui.filter((e) => e.kind === 'activity');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'join_pending');
  assert.match(ev[0].sentence ?? '', /等待管理员通过/);
  assert.doesNotMatch(ev[0].sentence ?? '', /加入了/);
});

test('fb-ui: 已是成员 / 只观察 → 没发生一次加群动作，不产条目', async () => {
  for (const reason of ['already_member', 'observation_only'] as const) {
    const join = new FakeJoinExecutor({ ok: false, reason, clicked: false, groupUrl: 'https://www.facebook.com/groups/1' });
    const { handler, cap } = makeHandler(new FakeExecutor(), join);
    await handler.handle(makeEnvelope('group.join', 'c1', 1, { groupUrl: 'https://www.facebook.com/groups/1' } as never));
    assert.equal(cap.ui.filter((e) => e.kind === 'activity').length, 0, `${reason} 不应产条目`);
  }
});

test('fb-ui: 群名读不到 → 回落通用文案，绝不用 URL 顶替', async () => {
  const join = new FakeJoinExecutor({ ok: true, clicked: true, groupUrl: 'https://www.facebook.com/groups/1' });
  const { handler, cap } = makeHandler(new FakeExecutor(), join);
  await handler.handle(makeEnvelope('group.join', 'c1', 1, { groupUrl: 'https://www.facebook.com/groups/1' } as never));
  const ev = cap.ui.filter((e) => e.kind === 'activity');
  assert.match(ev[0].sentence ?? '', /加入了小组「一个小组」/);
  assert.doesNotMatch(ev[0].sentence ?? '', /facebook\.com/);
});

test('fb-ui: 搜索零结果与搜索失败可区分', async () => {
  const ok0 = new FakeExecutor({ search: { ok: true, candidates: [], containerName: '越南招工群' } });
  const { handler: h1, cap: c1 } = makeHandler(ok0);
  await h1.handle(makeEnvelope('search.execute', 'c1', 1, { keyword: 'tuyển dụng', container: 'https://www.facebook.com/groups/1' } as never));
  const e1 = c1.ui.filter((e) => e.kind === 'activity');
  assert.equal(e1[0].type, 'search');
  assert.match(e1[0].sentence ?? '', /没有匹配的帖子/);

  const failed = new FakeExecutor({ search: { ok: false, reason: 'login_required', candidates: [] } });
  const { handler: h2, cap: c2 } = makeHandler(failed);
  await h2.handle(makeEnvelope('search.execute', 'c1', 1, { keyword: 'tuyển dụng', container: 'https://www.facebook.com/groups/1' } as never));
  const e2 = c2.ui.filter((e) => e.kind === 'activity');
  assert.equal(e2[0].type, 'search_failed');
  assert.match(e2[0].sentence ?? '', /登录已失效/);
});

test('fb-ui: 评论路径开帖产出与浏览路径一致的读条目 + views:1', async () => {
  const exec = new FakeExecutor({ open: { ok: true, editorReady: true, postText: 'Cần tuyển 5 công nhân' } as never });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('note.open', 'c1', 1, { url: 'https://www.facebook.com/groups/1/posts/2' } as never));
  const ev = cap.ui.filter((e) => e.kind === 'activity');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'note_open');
  assert.equal(ev[0].statsDelta?.views, 1);
  assert.match(ev[0].sentence ?? '', /Cần tuyển 5 công nhân/);
});

test('fb-ui: 开帖成功但评论框没找到 → 不叙述为读失败（沉默才诚实）', async () => {
  const exec = new FakeExecutor({ open: { ok: true, editorReady: false, postText: 'x' } as never });
  const { handler, cap } = makeHandler(exec);
  await handler.handle(makeEnvelope('note.open', 'c1', 1, { url: 'https://www.facebook.com/groups/1/posts/2' } as never));
  assert.equal(cap.ui.filter((e) => e.kind === 'activity').length, 0);
  assert.equal(cap.actions[0].reason, 'editor_not_found'); // 回执照旧诚实
});
