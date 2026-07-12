import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { AnchorCache } from '../../src/locating/cache.js';
import type {
  ActionRequest,
  DomProvider,
  ElementDescriptor,
  ElementSelector,
  SelectionResult,
} from '../../src/locating/index.js';
import type { ActionExecutor } from '../../src/locating/engine.js';
import { PublishCommandDispatcher } from '../../src/flows/publish-command-handlers.js';
import type { PublishCommandPayload } from '../../src/comm/protocol.js';
import {
  XHS_PUBLISH_CONTENT_ACTION_ID,
  XHS_PUBLISH_ENTRY_ACTION_ID,
  XHS_PUBLISH_SUBMIT_ACTION_ID,
  XHS_PUBLISH_TAG_ACTION_ID,
  XHS_PUBLISH_TITLE_ACTION_ID,
} from '../../src/flows/anchors.js';
import { committedTopicPill } from '../../src/flows/publish-post.js';

function buildDom(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

class LiveDom implements DomProvider {
  constructor(private readonly doc: Document) {}
  getRoot(): Document {
    return this.doc;
  }
}

/** 按 goal 关键词路由到对应 action-id 元素（复刻 publish-post 测试的最小选择器）。 */
class FakeSelector implements ElementSelector {
  async select(goal: string, els: ElementDescriptor[]): Promise<SelectionResult> {
    const byId = (id: string) => els.find((el) => el.attributes['data-action-id'] === id);
    // (关键词命中, 目标 action-id) 路由表，首条命中即定向；命中但元素缺失 → null（诚实 no_target，不退而求其次）。
    const routes: Array<[boolean, string]> = [
      [goal.includes('进入') || goal.includes('图文'), XHS_PUBLISH_ENTRY_ACTION_ID],
      [goal.includes('标题'), XHS_PUBLISH_TITLE_ACTION_ID],
      [goal.includes('正文') || goal.includes('内容'), XHS_PUBLISH_CONTENT_ACTION_ID],
      [goal.includes('@提及'), 'note.publish_mention'],
      [goal.includes('地点'), 'note.publish_location'],
      [goal.includes('合集'), 'note.publish_collection'],
      [goal.includes('可见范围'), 'note.publish_set_option.visibility'],
      [goal.includes('AI'), 'note.publish_set_option.declaration_ai'],
      [goal.includes('定时'), 'note.publish_set_schedule'],
      [goal.includes('封面'), 'note.publish_set_cover'], // 早于「发布」分支（封面 goal 含「发布页」）
      [goal.includes('标签') || goal.includes('话题'), XHS_PUBLISH_TAG_ACTION_ID],
      [goal.includes('提交') || goal.includes('发布'), XHS_PUBLISH_SUBMIT_ACTION_ID],
    ];
    for (const [match, id] of routes) {
      if (!match) continue;
      const el = byId(id);
      return el ? { index: el.index, element: el, reason: 'picked' } : { index: null, reason: 'none' };
    }
    return els[0] ? { index: els[0].index, element: els[0], reason: 'picked' } : { index: null, reason: 'none' };
  }
}

/** 正常执行器：input 真写入 DOM；可选 noopInput 模拟「点了但没生效」→ 触发后置校验失败。 */
class FakeExecutor implements ActionExecutor {
  constructor(
    private readonly doc: Document,
    private readonly noopInput = false,
  ) {}
  execute(op: ActionRequest['op'], element: ElementDescriptor, value?: string): void {
    const actionId = element.attributes['data-action-id'] ?? '';
    const node = this.doc.querySelector(`[data-action-id="${actionId}"]`);
    if (!node) return;
    if (op === 'input' && !this.noopInput) {
      const view = this.doc.defaultView!;
      if (node instanceof view.HTMLInputElement || node instanceof view.HTMLTextAreaElement) {
        node.value = value ?? '';
      } else {
        node.textContent = value ?? '';
      }
    }
  }
}

function publishPageHtml(extra = ''): string {
  return `
    <div class="publish-container">
      <input data-action-id="note.publish_title" placeholder="填写标题会有更多赞哦" />
      <textarea data-action-id="note.publish_content" placeholder="写点什么"></textarea>
      <input data-action-id="note.publish_tag" placeholder="添加标签" />
      <button data-action-id="note.publish_submit">立即发布</button>
      ${extra}
    </div>
  `;
}

function depsFor(doc: Document, executor: ActionExecutor) {
  return { dom: new LiveDom(doc), executor, selector: new FakeSelector(), cache: new AnchorCache() };
}

function cmd(kind: PublishCommandPayload['kind'], params: PublishCommandPayload['params'] = {}, seq = 0): PublishCommandPayload {
  return { taskId: 'task-publish-1', recordId: 100, seq, kind, params };
}

/** instant sleep：拟人停顿在测试里无延迟（保持快+确定），逻辑（逐字/点击调用）仍真实执行。 */
const instantSleep = async (_ms: number): Promise<void> => {};

/** 构造器封装：默认注入 instant sleep，使新加的拟人节奏不拖慢测试套件。 */
function mk(
  deps: ConstructorParameters<typeof PublishCommandDispatcher>[0],
  options?: ConstructorParameters<typeof PublishCommandDispatcher>[1],
  clock?: ConstructorParameters<typeof PublishCommandDispatcher>[2],
  uploader?: ConstructorParameters<typeof PublishCommandDispatcher>[3],
  cdp?: ConstructorParameters<typeof PublishCommandDispatcher>[4],
): PublishCommandDispatcher {
  return new PublishCommandDispatcher(deps, options ?? {}, clock ?? Date.now, uploader, cdp, { sleep: instantSleep });
}

test('AC-CMD fill_field(title) 成功 → ok:true，DOM 真写入，回报带 recordId+seq+kind', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'title', value: '测试标题' }, 3));
  assert.equal(res.ok, true);
  assert.equal(res.recordId, 100);
  assert.equal(res.seq, 3);
  assert.equal(res.kind, 'fill_field');
  assert.equal((doc.querySelector('[data-action-id="note.publish_title"]') as HTMLInputElement).value, '测试标题');
});

test('AC-CMD fill_field 后置校验失败（点了没生效）→ ok:false，绝不伪造成功（红线反例）', async () => {
  const doc = buildDom(publishPageHtml());
  // noopInput：执行器点击但不真写入 → 校验读不到内容 → engine 重试到顶仍失败。
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc, true)), { maxAttempts: 2 });
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'title', value: '没写进去的标题' }));
  assert.equal(res.ok, false);
  assert.ok(res.error, '失败必须带真实 error');
  assert.notEqual(res.error, undefined);
});

test('AC-CMD capture_postId 抓到 → ok:true value=真实 postId', async () => {
  const doc = buildDom(publishPageHtml('<a href="/explore/post_abc123">查看笔记</a>'));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'));
  assert.equal(res.ok, true);
  assert.equal(res.value, 'post_abc123');
});

test('AC-CMD capture_postId 抓不到 → ok:false error=no_target（红线：MUST NOT postId||fake）', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_target');
  assert.equal(res.value, undefined);
});

// change publish-history-account-and-detail：capture_postId 附带抓「带 xsec_token 的完整详情页分享 URL」。
test('AC-CMD capture_postId 抓到带 xsec_token 的完整分享 URL → 回报 postUrl', async () => {
  const doc = buildDom(
    publishPageHtml('<a href="https://www.xiaohongshu.com/explore/post_abc123?xsec_token=ABCTOKEN&xsec_source=pc_feed">查看笔记</a>'),
  );
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'));
  assert.equal(res.ok, true);
  assert.equal(res.value, 'post_abc123');
  assert.ok(res.postUrl?.includes('xsec_token=ABCTOKEN'), '应回报带 token 的完整分享 URL');
});

test('AC-CMD capture_postId 只有裸 id（缺 xsec_token）→ postUrl 诚实置空（红线：不拼打不开的假链接）', async () => {
  const doc = buildDom(publishPageHtml('<a href="/explore/post_bare">查看笔记</a>'));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'));
  assert.equal(res.ok, true);
  assert.equal(res.value, 'post_bare', 'postId 仍抓得到');
  assert.equal(res.postUrl, undefined, '缺 token → 不回 postUrl（诚实置空，绝不裸 id 拼假链接）');
});

test('AC-MEDIA upload_image 未注入 uploader → kind_not_implemented（诚实，不假成功）', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('upload_image', { imageUrl: 'https://cdn/x.jpg' }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'kind_not_implemented');
});

test('AC-MEDIA upload_image 经注入 uploader → 成功透传 ok:true / 失败透传真实 error（绝不翻成功）', async () => {
  const doc = buildDom(publishPageHtml());
  let calledWith = '';
  const okUploader = { upload: async (url: string) => { calledWith = url; return { ok: true }; } } as any;
  const okDisp = mk(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, okUploader);
  const ok = await okDisp.dispatch(cmd('upload_image', { imageUrl: 'https://cdn/a.png' }));
  assert.equal(ok.ok, true);
  assert.equal(calledWith, 'https://cdn/a.png', 'imageUrl 透传给 uploader');

  const failUploader = { upload: async () => ({ ok: false, error: 'image_not_attached' }) } as any;
  const failDisp = mk(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, failUploader);
  const fail = await failDisp.dispatch(cmd('upload_image', { imageUrl: 'https://cdn/a.png' }));
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'image_not_attached', '上传失败如实回报，绝不翻成 ok:true');
});

test('AC-MEDIA upload_image 缺 imageUrl（有 uploader）→ no_target', async () => {
  const doc = buildDom(publishPageHtml());
  const uploader = { upload: async () => ({ ok: true }) } as any;
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, uploader);
  const res = await dispatcher.dispatch(cmd('upload_image', {}));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_target');
});

test('FB-PUBLISH platform=facebook → 交给 Facebook executor，绝不走 XHS fill_field DOM 路径', async () => {
  const doc = buildDom(publishPageHtml());
  const seen: PublishCommandPayload[] = [];
  const facebookPublisher = {
    dispatch: async (payload: PublishCommandPayload) => {
      seen.push(payload);
      return { recordId: payload.recordId, seq: payload.seq, kind: payload.kind, ok: true };
    },
  };
  const dispatcher = new PublishCommandDispatcher(
    depsFor(doc, new FakeExecutor(doc)),
    {},
    Date.now,
    undefined,
    undefined,
    { sleep: instantSleep },
    facebookPublisher,
  );
  const res = await dispatcher.dispatch({ ...cmd('fill_field', { fieldType: 'content', value: 'FB正文' }, 9), platform: 'facebook' });
  assert.equal(res.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].platform, 'facebook');
  assert.equal((doc.querySelector('[data-action-id="note.publish_content"]') as HTMLTextAreaElement).value, '');
});

test('FB-PUBLISH platform=facebook 但未注入 executor → kind_not_implemented（诚实失败）', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch({ ...cmd('fill_field', { fieldType: 'content', value: 'FB正文' }), platform: 'facebook' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'kind_not_implemented');
});

test('AC-MEDIA set_cover → 定位封面入口 + 封面激活态后置校验通过 → ok:true', async () => {
  // 校验器 fail-closed，只认精确锚点 note.publish_cover_active（模拟校准后注入的真实成功态）。
  const extra = `<button data-action-id="note.publish_set_cover">设为封面</button><div data-action-id="note.publish_cover_active"></div>`;
  const doc = buildDom(publishPageHtml(extra));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('set_cover', { imageUrl: 'https://cdn/a.png' }));
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'set_cover');
});

test('AC-MEDIA set_cover 封面入口缺失 → ok:false（诚实 no_target，不假成功）', async () => {
  const doc = buildDom(publishPageHtml()); // 无封面入口
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), { maxAttempts: 2 });
  const res = await dispatcher.dispatch(cmd('set_cover', { imageUrl: 'https://cdn/a.png' }));
  assert.equal(res.ok, false);
  assert.ok(res.error, '失败必须带真实 error');
});

test('AC-CMD-S4 add_with_candidate 按 candidateKind 路由：mention/location/collection 各入对应控件 + 值校验', async () => {
  const extra = `
    <input data-action-id="note.publish_mention" placeholder="@提及用户" />
    <input data-action-id="note.publish_location" placeholder="添加地点" />
    <input data-action-id="note.publish_collection" placeholder="加入合集" />
  `;
  const doc = buildDom(publishPageHtml(extra));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));

  const mention = await dispatcher.dispatch(cmd('add_with_candidate', { candidateKind: 'mention', value: '老王' }));
  assert.equal(mention.ok, true, 'mention 应成功');
  assert.equal((doc.querySelector('[data-action-id="note.publish_mention"]') as HTMLInputElement).value, '老王');

  const location = await dispatcher.dispatch(cmd('add_with_candidate', { candidateKind: 'location', value: '上海' }));
  assert.equal(location.ok, true, 'location 应成功');
  assert.equal((doc.querySelector('[data-action-id="note.publish_location"]') as HTMLInputElement).value, '上海');

  const collection = await dispatcher.dispatch(cmd('add_with_candidate', { candidateKind: 'collection', value: '技术札记' }));
  assert.equal(collection.ok, true, 'collection 应成功');
});

test('AC-CMD-S4 add_with_candidate(mention) 控件缺失 → ok:false（诚实 no_target，不假成功）', async () => {
  const doc = buildDom(publishPageHtml()); // 无 mention 控件
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), { maxAttempts: 2 });
  const res = await dispatcher.dispatch(cmd('add_with_candidate', { candidateKind: 'mention', value: '查无此控件' }));
  assert.equal(res.ok, false);
  assert.ok(res.error, '失败必须带真实 error');
});

test('AC-CMD-S4 set_option(visibility) → 定位选项控件 + 值校验通过', async () => {
  const extra = `<button data-action-id="note.publish_set_option.visibility">公开</button>`;
  const doc = buildDom(publishPageHtml(extra));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('set_option', { optionKind: 'visibility', optionValue: '公开' }));
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'set_option');
});

test('AC-CMD-S4 set_schedule → 定位定时控件 + 值写入', async () => {
  const extra = `<label>定时发布</label><input data-action-id="note.publish_set_schedule" placeholder="选择时间" />`;
  const doc = buildDom(publishPageHtml(extra));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('set_schedule', { publishTime: 1800000000000 }));
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'set_schedule');
});

// ── change publish-fill-humanization（Phase A）：CDP 路径填写拟人化 ──────────────

/** 记录 CDP 调用的最小 fake；Runtime.evaluate（FOCUS/CHECK）恒返回 true，使填写后置校验通过。 */
class FakeCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Runtime.evaluate') return { result: { value: true } } as T;
    return {} as T;
  }
  inserts(): string[] {
    return this.calls.filter((c) => c.method === 'Input.insertText').map((c) => String(c.params?.text ?? ''));
  }
}

function dispatcherWithCdp(cdp: FakeCdp, pacingEnabled = true): PublishCommandDispatcher {
  const doc = buildDom(publishPageHtml());
  return new PublishCommandDispatcher(
    depsFor(doc, new FakeExecutor(doc)),
    {},
    Date.now,
    undefined,
    cdp as unknown as ConstructorParameters<typeof PublishCommandDispatcher>[4],
    { sleep: instantSleep, enabled: pacingEnabled, random: () => 0.5 },
  );
}

test('拟人填写：CDP 路径标题/正文逐字打字（多次 insertText，拼接==原值）而非一次性灌入', async () => {
  const cdp = new FakeCdp();
  const dispatcher = dispatcherWithCdp(cdp);
  const value = '大模型选型避坑';
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }));
  assert.equal(res.ok, true);
  const inserts = cdp.inserts();
  assert.equal(inserts.length, Array.from(value).length, '应逐字 insertText（每字符一次）');
  assert.equal(inserts.join(''), value, '逐字拼接应等于原值（不丢内容）');
});

test('拟人填写：pacing 关 → 回退一次性 insertText（旧快路径，零回归）', async () => {
  const cdp = new FakeCdp();
  const dispatcher = dispatcherWithCdp(cdp, false);
  const value = '大模型选型避坑';
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'title', value }));
  assert.equal(res.ok, true);
  const inserts = cdp.inserts();
  assert.equal(inserts.length, 1, 'pacing 关时一次性灌入');
  assert.equal(inserts[0], value);
});

// ── change split-topic-roles：真话题 token 校验 + runAddTopic CDP 直驱（实机校准选择器）──

/** 话题专用 fake cdp：FOCUS(含 ProseMirror)→focus 布尔；CENTER(含 tippy-box)→建议中心 JSON 或 ''；其余(点击等)→{}。 */
class TopicFakeCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  constructor(private readonly opts: { focus?: boolean; center: { x: number; y: number } | null }) {}
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      const expr = String((params as { expression?: string })?.expression ?? '');
      if (expr.includes('ProseMirror')) return { result: { value: this.opts.focus !== false } } as T;
      if (expr.includes('tippy-box')) {
        return { result: { value: this.opts.center ? JSON.stringify(this.opts.center) : '' } } as T;
      }
      return { result: { value: true } } as T;
    }
    return {} as T;
  }
}

/** 快进时钟：每次调用 +5000ms，使 runAddTopic 的 4s 轮询上限被立即触发（no_target/失败用例不真等 4s）。 */
function fastClock(): () => number {
  let t = 0;
  return () => { t += 5000; return t; };
}

function mkTopicCdp(doc: Document, cdp: TopicFakeCdp, clock?: () => number): PublishCommandDispatcher {
  return new PublishCommandDispatcher(
    depsFor(doc, new FakeExecutor(doc)),
    {},
    clock ?? Date.now,
    undefined,
    cdp as unknown as ConstructorParameters<typeof PublishCommandDispatcher>[4],
    { sleep: instantSleep, random: () => 0.5 },
  );
}

test('committedTopicPill：真话题 token 存在 → true；仅纯文本 #kw → false（治静默假成功）', () => {
  const withPill = buildDom(
    `<div class="tiptap ProseMirror"><p><a class="tiptap-topic" data-topic='{"id":"1","name":"大模型"}' contenteditable="false">#大模型<span class="content-hide">[话题]#</span></a></p></div>`,
  );
  assert.equal(committedTopicPill(withPill, '大模型'), true);
  const plainText = buildDom(`<div class="tiptap ProseMirror"><p>#大模型 还没从下拉提交</p></div>`);
  assert.equal(committedTopicPill(plainText, '大模型'), false, '纯文本 #kw 不算真话题');
  // 子串误判防护：已存在的超串话题 #大模型部署 不得被当作「大模型」已贴上（精确匹配、非子串）。
  const superStr = buildDom(
    `<div class="tiptap ProseMirror"><p><a class="tiptap-topic" data-topic='{"id":"9","name":"大模型部署"}' contenteditable="false">#大模型部署<span class="content-hide">[话题]#</span></a></p></div>`,
  );
  assert.equal(committedTopicPill(superStr, '大模型'), false, '超串话题不得误判为子串关键词已贴上（治静默假成功）');
});

test('runAddTopic happy：#→下拉→真实鼠标点→正文出现 a.tiptap-topic → ok', async () => {
  process.env.AIDCP_PUBLISH_TOPIC_CDP = '1';
  try {
    // 正文预置已提交 token（模拟点击后平台插入的真话题）。
    const doc = buildDom(
      `<div class="tiptap ProseMirror"><p><a class="tiptap-topic" data-topic='{"id":"1","name":"大模型"}' contenteditable="false">#大模型</a></p></div>`,
    );
    const cdp = new TopicFakeCdp({ focus: true, center: { x: 120, y: 200 } });
    const res = await mkTopicCdp(doc, cdp).dispatch(cmd('add_with_candidate', { candidateKind: 'topic', value: '大模型' }));
    assert.equal(res.ok, true);
    // 逐字打字：各 insertText 拼接应含 #大模型（治静默假成功——确实在正文打了 #关键词）。
    const typed = cdp.calls.filter((c) => c.method === 'Input.insertText').map((c) => String((c.params as { text?: string })?.text ?? '')).join('');
    assert.ok(typed.includes('#大模型'), '真的打了 #大模型');
    assert.ok(cdp.calls.some((c) => c.method === 'Input.dispatchMouseEvent'), '真实鼠标事件点建议（非 .click()）');
  } finally {
    delete process.env.AIDCP_PUBLISH_TOPIC_CDP;
  }
});

test('runAddTopic 下拉未出现 → 诚实 no_target', async () => {
  process.env.AIDCP_PUBLISH_TOPIC_CDP = '1';
  try {
    const doc = buildDom(`<div class="tiptap ProseMirror"><p></p></div>`);
    const cdp = new TopicFakeCdp({ focus: true, center: null });
    const res = await mkTopicCdp(doc, cdp, fastClock()).dispatch(cmd('add_with_candidate', { candidateKind: 'topic', value: '大模型' }));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'no_target');
  } finally {
    delete process.env.AIDCP_PUBLISH_TOPIC_CDP;
  }
});

test('runAddTopic 点了但未生成真 token → post_validate_failed（fail-closed，不静默假成功）', async () => {
  process.env.AIDCP_PUBLISH_TOPIC_CDP = '1';
  try {
    // 正文只有纯文本、无 a.tiptap-topic（模拟未真正提交）。
    const doc = buildDom(`<div class="tiptap ProseMirror"><p>#大模型</p></div>`);
    const cdp = new TopicFakeCdp({ focus: true, center: { x: 120, y: 200 } });
    const res = await mkTopicCdp(doc, cdp, fastClock()).dispatch(cmd('add_with_candidate', { candidateKind: 'topic', value: '大模型' }));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'post_validate_failed');
  } finally {
    delete process.env.AIDCP_PUBLISH_TOPIC_CDP;
  }
});

test('runAddTopic kill-switch(=0) → 走旧兜底路径、绝不碰 CDP 直驱', async () => {
  // 默认已启用；显式 AIDCP_PUBLISH_TOPIC_CDP=0 → topicCdpEnabled=false；即便注入 cdp 也走 buildTagInputRequest 兜底（不触 cdp）。
  process.env.AIDCP_PUBLISH_TOPIC_CDP = '0';
  try {
    const doc = buildDom(publishPageHtml());
    const cdp = new TopicFakeCdp({ focus: true, center: { x: 1, y: 1 } });
    await mkTopicCdp(doc, cdp).dispatch(cmd('add_with_candidate', { candidateKind: 'topic', value: '大模型' }));
    assert.equal(cdp.calls.length, 0, '兜底路径不走 CDP 直驱（无任何 cdp 调用）');
  } finally {
    delete process.env.AIDCP_PUBLISH_TOPIC_CDP;
  }
});

// ── change publish-select-mode-layout-robust：select_mode 跨宽/窄双布局稳健 ──────────────
//
// 说明：in-page JS 的真实「取可见」选择只有在真实浏览器上才可验证（→ 真机标定 backlog）。
// 这些单测用脚本化 fake cdp（按表达式注释标记分派）验证 runSelectMode 的【控制流 + 诚实分类】：
// 幂等早退 / 冷加载有界重试 / 点了没切上 post_validate_failed / 从未点中 no_target / 绝不假成功；
// 另有两条静态断言，坐实「取可见」与「保守幂等判据」这两条双布局红线确实注入进了下发的 JS。

/**
 * select_mode 专用 fake cdp：按 Runtime.evaluate 表达式里的注释标记（/*CLICK_TAB* / 等）分派、脚本化返回值。
 */
class SelectModeFakeCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private clicked = false;
  private clickAttempts = 0;
  constructor(
    private readonly opts: {
      /** MODE_STATE 在成功点击前的返回（''|'image'|'video'，缺省 'video'=正常起步于视频模式）。 */
      stateFromStart?: '' | 'image' | 'video';
      /** CLICK_TAB 从第几次尝试起返回 clicked:true（0=首次即中，缺省 0）；Infinity=永不命中。 */
      clickSucceedsAtAttempt?: number;
      /** MODE_STATE 在成功点击后的返回（缺省沿用 stateFromStart）。 */
      stateAfterClick?: '' | 'image' | 'video';
      /** 成功点击后 IMG_MODE_ACTIVE 转真（辅助信号）。 */
      imgActiveAfterClick?: boolean;
      /** IMG_MODE_ACTIVE 点击前就为真——模拟「视频模式下残留图片信号」，验证硬化否决。 */
      imgActiveFromStart?: boolean;
    },
  ) {}
  private static exprOf(c: { params?: Record<string, unknown> }): string {
    return String((c.params as { expression?: string })?.expression ?? '');
  }
  clickEvalCount(): number {
    return this.calls.filter((c) => SelectModeFakeCdp.exprOf(c).includes('/*CLICK_TAB*/')).length;
  }
  exprContaining(marker: string): string | undefined {
    const c = this.calls.find((x) => SelectModeFakeCdp.exprOf(x).includes(marker));
    return c ? SelectModeFakeCdp.exprOf(c) : undefined;
  }
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method !== 'Runtime.evaluate') return {} as T;
    const expr = String((params as { expression?: string })?.expression ?? '');
    if (expr.includes('/*CLICK_TAB*/')) {
      const attempt = this.clickAttempts++;
      const hit = attempt >= (this.opts.clickSucceedsAtAttempt ?? 0);
      if (hit) this.clicked = true;
      return { result: { value: { clicked: hit } } } as T;
    }
    if (expr.includes('/*MODE_STATE*/')) {
      const start = this.opts.stateFromStart ?? 'video';
      const v = this.clicked ? (this.opts.stateAfterClick ?? start) : start;
      return { result: { value: v } } as T;
    }
    if (expr.includes('/*IMG_MODE_ACTIVE*/')) {
      const v = !!this.opts.imgActiveFromStart || (this.clicked && !!this.opts.imgActiveAfterClick);
      return { result: { value: v } } as T;
    }
    return { result: { value: false } } as T;
  }
}

/** 小步时钟：每次调用 +stepMs，使 20s 窗口在有限次迭代后触发（失败用例不真等 20s）。 */
function selectStepClock(stepMs: number): () => number {
  let t = 0;
  return () => { t += stepMs; return t; };
}

function mkSelectMode(cdp: SelectModeFakeCdp, clock: () => number): PublishCommandDispatcher {
  const doc = buildDom(publishPageHtml());
  return new PublishCommandDispatcher(
    depsFor(doc, new FakeExecutor(doc)),
    {},
    clock,
    undefined,
    cdp as unknown as ConstructorParameters<typeof PublishCommandDispatcher>[4],
    { sleep: instantSleep, random: () => 0.5 },
  );
}

test('select_mode 幂等早退：进入时已在图文模式（state=image）→ ok:true 且不点击（治「本已在模式却报 no_target」）', async () => {
  const cdp = new SelectModeFakeCdp({ stateFromStart: 'image' });
  const res = await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1));
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'select_mode');
  assert.equal(cdp.clickEvalCount(), 0, '已在图文模式应幂等早退、绝不点击');
});

test('select_mode happy：视频起步 → 点中可见 tab → 激活 tab 变图文（state=image）→ ok:true', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: 'image' });
  const res = await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1));
  assert.equal(res.ok, true);
  assert.ok(cdp.clickEvalCount() >= 1, '视频模式起步应真的点了图文 tab');
});

test('select_mode happy（辅助信号兜底）：点击后激活态未识别（state=""）但 IMG_MODE_ACTIVE 转真 → ok:true（不回归旧验证信号）', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: '', imgActiveAfterClick: true });
  const res = await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1));
  assert.equal(res.ok, true, '激活态识别不出时点击后 IMG 信号（文件输入 accept 变图片类）应兜底确认成功');
});

test('select_mode 冷加载：tab 晚渲染（前若干次点击 miss，稍后命中）→ 有界重试点中 → ok:true', async () => {
  // 前 2 次 CLICK_TAB miss（clicked:false），第 3 次起命中；命中后激活 tab 变图文。
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 2, stateAfterClick: 'image' });
  const res = await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1));
  assert.equal(res.ok, true);
  assert.ok(cdp.clickEvalCount() >= 3, '应重试点击直到命中（冷加载容忍）');
});

test('select_mode 始终无可见 tab 且未在图文模式 → 诚实 no_target（红线：绝不假成功）', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: Number.POSITIVE_INFINITY });
  const res = await mkSelectMode(cdp, selectStepClock(5000)).dispatch(cmd('select_mode', {}, 1));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_target');
});

test('select_mode 点了但模式始终未激活（点到隐藏副本/点击无效）→ 诚实 post_validate_failed', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: '', imgActiveAfterClick: false });
  const res = await mkSelectMode(cdp, selectStepClock(5000)).dispatch(cmd('select_mode', {}, 1));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'post_validate_failed', '点了没切上模式必须诚实报，绝不谎报已切');
});

// ── 双布局硬化（评审对抗性反馈：辅助信号是「电平」非「跃变」，须防残留图片信号在视频模式假成功）──

test('select_mode 硬化：点了但仍确认在视频模式（state=video）+ 残留图片信号 → 否决辅助信号、诚实 post_validate_failed', async () => {
  // 关键：imgActiveFromStart=true（视频模式下就存在图片信号）+ 点击后 state 仍 'video'。
  // 旧「电平或」会因 IMG 为真而假成功；硬化后 state==='video' 否决 IMG → 诚实失败。
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: 'video', imgActiveFromStart: true });
  const res = await mkSelectMode(cdp, selectStepClock(5000)).dispatch(cmd('select_mode', {}, 1));
  assert.equal(res.ok, false, '仍在视频模式绝不因残留图片信号谎报成功（红线：不假成功）');
  assert.equal(res.error, 'post_validate_failed');
});

test('select_mode 硬化：点击前存在残留图片信号但未点中任何 tab → 只认权威 state、诚实 no_target（不盲信 IMG）', async () => {
  // 点击前只认权威 MODE_STATE（'video'），IMG 残留信号不参与点击前判定 → 从未点中 → no_target（非假成功）。
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: Number.POSITIVE_INFINITY, stateFromStart: 'video', imgActiveFromStart: true });
  const res = await mkSelectMode(cdp, selectStepClock(5000)).dispatch(cmd('select_mode', {}, 1));
  assert.equal(res.ok, false, '点击前残留图片信号绝不当作已在图文模式');
  assert.equal(res.error, 'no_target');
});

test('select_mode 红线：下发的点击 JS 含可见性判据（取可见非取首个，躲隐藏副本）', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: 'image' });
  await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1));
  const clickJs = cdp.exprContaining('/*CLICK_TAB*/');
  assert.ok(clickJs, '应有 CLICK_TAB 表达式被下发');
  // 可见性判据须按「与视口相交」过滤（真机标定：隐藏副本被移到屏幕外 x≈-9758，offsetParent 判据会误判其可见）。
  assert.ok(clickJs!.includes('getBoundingClientRect') && clickJs!.includes('innerWidth'), '点击 JS 必须按视口相交过滤候选（getBoundingClientRect + innerWidth/Height）');
});

test('select_mode 红线：模式判据保守（激活 tab 文本含「图文」与「视频」两侧约束，绝不视频模式谎报）', async () => {
  const cdp = new SelectModeFakeCdp({ stateFromStart: 'image' });
  await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1));
  const modeJs = cdp.exprContaining('/*MODE_STATE*/');
  assert.ok(modeJs, '应有 MODE_STATE 表达式被下发');
  assert.ok(modeJs!.includes('图文') && modeJs!.includes('视频'), '模式判据须同时约束「图文」与「视频」两侧');
  assert.ok(/aria-selected|active|selected|current/.test(modeJs!), '模式判据须限定激活态 tab');
});
