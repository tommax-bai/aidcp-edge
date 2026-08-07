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
import {
  buildXhsContentCaretStateExpression,
  formatXhsScheduleTime,
  normalizeXhsContentSemanticText,
  PublishCommandDispatcher,
  XHS_CONTENT_SEMANTIC_SIMILARITY_THRESHOLD,
  xhsContentSemanticSimilarity,
} from '../../src/flows/publish-command-handlers.js';
import { TaskTakeoverError, type TakeoverCtx } from '../../src/execution/takeover.js';
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
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'title', value: '测试标题' }, 3), 'xiaohongshu');
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
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'title', value: '没写进去的标题' }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.ok(res.error, '失败必须带真实 error');
  assert.notEqual(res.error, undefined);
});

test('AC-CMD capture_postId 抓到 → ok:true value=真实 postId', async () => {
  const doc = buildDom(publishPageHtml('<a href="/explore/post_abc123">查看笔记</a>'));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.value, 'post_abc123');
});

test('AC-CMD capture_postId 抓不到 → ok:false error=no_target（红线：MUST NOT postId||fake）', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'), 'xiaohongshu');
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
  const res = await dispatcher.dispatch(cmd('capture_postId'), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.value, 'post_abc123');
  assert.ok(res.postUrl?.includes('xsec_token=ABCTOKEN'), '应回报带 token 的完整分享 URL');
});

test('AC-CMD capture_postId 只有裸 id（缺 xsec_token）→ postUrl 诚实置空（红线：不拼打不开的假链接）', async () => {
  const doc = buildDom(publishPageHtml('<a href="/explore/post_bare">查看笔记</a>'));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.value, 'post_bare', 'postId 仍抓得到');
  assert.equal(res.postUrl, undefined, '缺 token → 不回 postUrl（诚实置空，绝不裸 id 拼假链接）');
});

test('AC-MEDIA upload_image 未注入 uploader → kind_not_implemented（诚实，不假成功）', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('upload_image', { imageUrl: 'https://cdn/x.jpg' }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'kind_not_implemented');
});

test('AC-MEDIA upload_image 经注入 uploader → 成功透传 ok:true / 失败透传真实 error（绝不翻成功）', async () => {
  const doc = buildDom(publishPageHtml());
  let calledWith = '';
  const okUploader = { upload: async (url: string) => { calledWith = url; return { ok: true }; } } as any;
  const okDisp = mk(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, okUploader);
  const ok = await okDisp.dispatch(cmd('upload_image', { imageUrl: 'https://cdn/a.png' }), 'xiaohongshu');
  assert.equal(ok.ok, true);
  assert.equal(calledWith, 'https://cdn/a.png', 'imageUrl 透传给 uploader');

  const failUploader = { upload: async () => ({ ok: false, error: 'image_not_attached' }) } as any;
  const failDisp = mk(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, failUploader);
  const fail = await failDisp.dispatch(cmd('upload_image', { imageUrl: 'https://cdn/a.png' }), 'xiaohongshu');
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'image_not_attached', '上传失败如实回报，绝不翻成 ok:true');
});

test('AC-MEDIA upload_image 缺 imageUrl（有 uploader）→ no_target', async () => {
  const doc = buildDom(publishPageHtml());
  const uploader = { upload: async () => ({ ok: true }) } as any;
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, uploader);
  const res = await dispatcher.dispatch(cmd('upload_image', {}), 'xiaohongshu');
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
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value: 'FB正文' }, 9), 'facebook');
  assert.equal(res.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'fill_field');
  assert.equal((doc.querySelector('[data-action-id="note.publish_content"]') as HTMLTextAreaElement).value, '');
});

test('FB-PUBLISH platform=facebook 但未注入 executor → kind_not_implemented（诚实失败）', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value: 'FB正文' }), 'facebook');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'kind_not_implemented');
});

test('AC-MEDIA set_cover → 定位封面入口 + 封面激活态后置校验通过 → ok:true', async () => {
  // 校验器 fail-closed，只认精确锚点 note.publish_cover_active（模拟校准后注入的真实成功态）。
  const extra = `<button data-action-id="note.publish_set_cover">设为封面</button><div data-action-id="note.publish_cover_active"></div>`;
  const doc = buildDom(publishPageHtml(extra));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('set_cover', { imageUrl: 'https://cdn/a.png' }), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'set_cover');
});

test('AC-MEDIA set_cover 封面入口缺失 → ok:false（诚实 no_target，不假成功）', async () => {
  const doc = buildDom(publishPageHtml()); // 无封面入口
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), { maxAttempts: 2 });
  const res = await dispatcher.dispatch(cmd('set_cover', { imageUrl: 'https://cdn/a.png' }), 'xiaohongshu');
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

  const mention = await dispatcher.dispatch(cmd('add_with_candidate', { candidateKind: 'mention', value: '老王' }), 'xiaohongshu');
  assert.equal(mention.ok, true, 'mention 应成功');
  assert.equal((doc.querySelector('[data-action-id="note.publish_mention"]') as HTMLInputElement).value, '老王');

  const location = await dispatcher.dispatch(cmd('add_with_candidate', { candidateKind: 'location', value: '上海' }), 'xiaohongshu');
  assert.equal(location.ok, true, 'location 应成功');
  assert.equal((doc.querySelector('[data-action-id="note.publish_location"]') as HTMLInputElement).value, '上海');

  const collection = await dispatcher.dispatch(cmd('add_with_candidate', { candidateKind: 'collection', value: '技术札记' }), 'xiaohongshu');
  assert.equal(collection.ok, true, 'collection 应成功');
});

test('AC-CMD-S4 add_with_candidate(mention) 控件缺失 → ok:false（诚实 no_target，不假成功）', async () => {
  const doc = buildDom(publishPageHtml()); // 无 mention 控件
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), { maxAttempts: 2 });
  const res = await dispatcher.dispatch(cmd('add_with_candidate', { candidateKind: 'mention', value: '查无此控件' }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.ok(res.error, '失败必须带真实 error');
});

test('AC-CMD-S4 set_option(visibility) → 定位选项控件 + 值校验通过', async () => {
  const extra = `<button data-action-id="note.publish_set_option.visibility">公开</button>`;
  const doc = buildDom(publishPageHtml(extra));
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('set_option', { optionKind: 'visibility', optionValue: '公开' }), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'set_option');
});

class FakeScheduleCdp {
  readonly calls: Array<{ method: string; expression: string }> = [];
  value = '';

  constructor(private readonly hasScheduledButton = true) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const expression = String(params?.expression ?? '');
    this.calls.push({ method, expression });
    if (method === 'Runtime.evaluate') {
      if (expression.includes('SCHEDULE_STATE')) {
        return { result: { value: JSON.stringify({ checked: true, inputFound: true, value: this.value }) } } as T;
      }
      if (expression.includes('SCHEDULE_SET_TIME')) {
        const values = [...expression.matchAll(/"(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})"/g)].map((match) => match[1]);
        this.value = values.find((candidate) => candidate.includes(' ')) ?? values[0]?.replace('T', ' ') ?? '';
        return { result: { value: true } } as T;
      }
      return { result: { value: true } } as T;
    }
    if (method === 'DOM.getDocument') {
      return {
        root: {
          nodeType: 9,
          children: this.hasScheduledButton
            ? [{ nodeType: 1, nodeId: 77, children: [{ nodeType: 3, nodeValue: '定时发布' }] }]
            : [],
        },
      } as T;
    }
    if (method === 'DOM.getBoxModel') {
      return { model: { content: [100, 200, 200, 200, 200, 240, 100, 240] } } as T;
    }
    if (method === 'DOM.getAttributes') return { attributes: [] } as T;
    return {} as T;
  }
}

test('XHS-SCHEDULE set_schedule 写入 1h–14d 内时间并以三项正证据确认', async () => {
  const doc = buildDom(publishPageHtml());
  const now = 1_800_000_000_000;
  const publishTime = now + 2 * 60 * 60 * 1000;
  const cdp = new FakeScheduleCdp();
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), {}, () => now, undefined, cdp as any);
  const res = await dispatcher.dispatch(cmd('set_schedule', { publishTime }), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'set_schedule');
  assert.equal(res.value, formatXhsScheduleTime(publishTime));
  assert.equal(cdp.value, formatXhsScheduleTime(publishTime));
});

test('XHS-SCHEDULE 缺“定时发布”提交按钮正证据时 fail closed', async () => {
  const doc = buildDom(publishPageHtml());
  const now = 1_800_000_000_000;
  const cdp = new FakeScheduleCdp(false);
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), {}, () => now, undefined, cdp as any);
  const res = await dispatcher.dispatch(cmd('set_schedule', { publishTime: now + 2 * 60 * 60 * 1000 }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'post_validation_failed');
});

test('XHS-SCHEDULE 边缘再挡 1h–14d 时间窗，越界不触碰页面', async () => {
  const doc = buildDom(publishPageHtml());
  const now = 1_800_000_000_000;
  const cdp = new FakeScheduleCdp();
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), {}, () => now, undefined, cdp as any);
  const res = await dispatcher.dispatch(cmd('set_schedule', { publishTime: now + 60 * 60 * 1000 - 1 }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'schedule_time_out_of_range');
  assert.equal(cdp.calls.length, 0);
});

class FakeManageCdp {
  readonly tabs: string[] = [];
  readonly navigations: string[] = [];
  private matchIndex = 0;

  constructor(private readonly matches: Array<Record<string, unknown>>) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const expression = String(params?.expression ?? '');
    if (method === 'Page.navigate') {
      this.navigations.push(String(params?.url ?? ''));
      return {} as T;
    }
    if (method === 'Runtime.evaluate' && expression.includes('MANAGE_READY')) {
      return { result: { value: true } } as T;
    }
    if (method === 'Runtime.evaluate' && expression.includes('MANAGE_TAB')) {
      const wantedLiteral = expression.match(/const wanted=("(?:[^"\\]|\\.)*")/)?.[1];
      const wanted = wantedLiteral ? JSON.parse(wantedLiteral) as string : '';
      this.tabs.push(wanted === '已发布' ? 'published' : wanted === '全部' ? 'all' : 'scheduled');
      return { result: { value: true } } as T;
    }
    if (method === 'Runtime.evaluate' && expression.includes('MANAGED_NOTE_MATCH')) {
      const value = this.matches[Math.min(this.matchIndex, this.matches.length - 1)] ?? { state: 'missing' };
      this.matchIndex++;
      return { result: { value: JSON.stringify(value) } } as T;
    }
    return { result: { value: true } } as T;
  }
}

test('XHS-SCHEDULE capture_scheduled 只回平台内部句柄，不伪装公开链接', async () => {
  const doc = buildDom(publishPageHtml());
  const cdp = new FakeManageCdp([{ state: 'found', noteId: '6a5b3b98000000000301f011' }]);
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, undefined, cdp as any);
  const res = await dispatcher.dispatch(cmd('capture_scheduled', {
    scheduledTitle: '冻结标题',
    publishTime: Date.now() + 2 * 60 * 60 * 1000,
  }), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.value, '6a5b3b98000000000301f011');
  assert.equal(res.postUrl, undefined);
  assert.deepEqual(cdp.tabs, ['scheduled']);
  assert.deepEqual(cdp.navigations, ['https://creator.xiaohongshu.com/new/note-manager?source=official']);
});

test('XHS-SCHEDULE 定时筛选短暂空集时仅凭“全部”中的定时状态卡片兜底', async () => {
  const doc = buildDom(publishPageHtml());
  const cdp = new FakeManageCdp([
    ...Array.from({ length: 8 }, () => ({ state: 'missing' })),
    { state: 'found', noteId: '6a5b50d30000000005038f98' },
  ]);
  let now = 1_800_000_000_000;
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), {}, () => (now += 500), undefined, cdp as any);
  const res = await dispatcher.dispatch(cmd('capture_scheduled', {
    scheduledTitle: '定时筛选延迟',
    publishTime: now + 2 * 60 * 60 * 1000,
  }), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.value, '6a5b50d30000000005038f98');
  assert.deepEqual(cdp.tabs, ['scheduled', 'all']);
});

test('XHS-SCHEDULE reconcile_scheduled 只有公开 id 与平台 URL 同时存在才确认 published', async () => {
  const doc = buildDom(publishPageHtml());
  const cdp = new FakeManageCdp([
    { state: 'missing' },
    { state: 'missing' },
    {
      state: 'found',
      noteId: 'public1234567890abcd',
      postUrl: 'https://www.xiaohongshu.com/explore/public1234567890abcd?xsec_token=token',
    },
  ]);
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, undefined, cdp as any);
  const res = await dispatcher.dispatch(cmd('reconcile_scheduled', {
    scheduledTitle: '冻结标题',
    publishTime: Date.now() - 10 * 60 * 1000,
    scheduledPlatformId: '6a5b3b98000000000301f011',
  }), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.value, 'public1234567890abcd');
  assert.ok(res.postUrl?.includes('xsec_token=token'));
  assert.deepEqual(cdp.tabs, ['scheduled', 'all', 'published']);
});

test('XHS-SCHEDULE reconcile_scheduled 仍在定时列表时诚实 pending', async () => {
  const doc = buildDom(publishPageHtml());
  const cdp = new FakeManageCdp([{ state: 'found', noteId: '6a5b3b98000000000301f011' }]);
  const dispatcher = mk(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, undefined, cdp as any);
  const res = await dispatcher.dispatch(cmd('reconcile_scheduled', {
    scheduledTitle: '冻结标题',
    publishTime: Date.now() - 10 * 60 * 1000,
    scheduledPlatformId: '6a5b3b98000000000301f011',
  }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'scheduled_pending');
  assert.deepEqual(cdp.tabs, ['scheduled']);
});

// ── change publish-fill-humanization（Phase A）：CDP 路径填写拟人化 ──────────────

/**
 * 编辑器模型 fake（change lease-strict-preemption 升级）。
 *
 * 旧桩对任何 Runtime.evaluate 恒回 true —— 它验不出这条路径真正的语义：**输入是追加**。
 * 现在照真页面建模：insertText 追加到 text；全选 + Backspace 才清空；回读返回 text。
 * 这样「残文没清掉 → 拼接发出」才有可能在单测里被断言到。
 */
class FakeCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  text: string;
  private selected = false;
  private caret: number;
  /** unclearable：模拟「全选做不到」的脏页（框架吃掉了选区）。 */
  private accepted = 0;
  constructor(private readonly opts: {
    initialText?: string;
    unclearable?: boolean;
    swallowAfter?: number;
    /** Enter 后模拟 ProseMirror 用旧 selection 把 caret 恢复到末端之前；探针归尾后可恢复。 */
    rewindCaretAfterEnter?: boolean;
    /** 每次探针后仍把 caret 拉回去，模拟无法稳定的编辑器。 */
    neverStabilizeCaret?: boolean;
    /** 页面吞掉 Enter：光标仍在末端，但没有创建段落。 */
    swallowEnter?: boolean;
  } = {}) {
    this.text = opts.initialText ?? '';
    this.caret = this.text.length;
  }
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      const expr = String(params?.expression ?? '');
      if (expr.includes('xhs-content-caret-state')) {
        const atEnd = !this.opts.neverStabilizeCaret && this.caret === this.text.length;
        if (!atEnd) {
          this.caret = this.opts.neverStabilizeCaret ? Math.max(0, this.text.length - 1) : this.text.length;
        }
        return {
          result: {
            value: JSON.stringify({
              found: true,
              text: this.text.replace(/\s+/g, ' ').trim(),
              newlines: (this.text.match(/\n/g) ?? []).length,
              atEnd,
            }),
          },
        } as T;
      }
      if (expr.includes('text: raw')) {
        return { result: { value: JSON.stringify({ found: true, text: this.text.replace(/\s+/g, ' ').trim() }) } } as T;
      }
      if (expr.includes('selected: true')) {
        if (this.opts.unclearable) return { result: { value: JSON.stringify({ found: true, selected: false }) } } as T;
        this.selected = true;
        return { result: { value: JSON.stringify({ found: true, selected: true }) } } as T;
      }
      return { result: { value: true } } as T; // FOCUS
    }
    if (method === 'Input.insertText') {
      const chunk = String(params?.text ?? '');
      // swallowAfter：编辑器只接收前 N 个字符，之后全吞（真机见过的「吞正文」）。
      const chars = Array.from(chunk);
      const room = this.opts.swallowAfter === undefined ? chars.length : Math.max(0, this.opts.swallowAfter - this.accepted);
      const kept = chars.slice(0, room);
      this.accepted += kept.length;
      const inserted = kept.join('');
      this.text = this.text.slice(0, this.caret) + inserted + this.text.slice(this.caret);
      this.caret += inserted.length;
      this.selected = false;
    }
    if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown') {
      if (params?.key === 'Enter') {
        if (!this.opts.swallowEnter) {
          this.text = this.text.slice(0, this.caret) + '\n' + this.text.slice(this.caret);
          this.caret++;
          if (this.opts.rewindCaretAfterEnter) this.caret = Math.max(0, this.caret - 1);
        }
        this.selected = false;
      }
      if (params?.key === 'Backspace' && this.selected) {
        this.text = '';
        this.caret = 0;
        this.selected = false;
      }
    }
    return {} as T;
  }
  inserts(): string[] {
    return this.calls.filter((c) => c.method === 'Input.insertText').map((c) => String(c.params?.text ?? ''));
  }
}

function dispatcherWithCdp(cdp: FakeCdp, pacingEnabled = true): PublishCommandDispatcher {
  const doc = buildDom(publishPageHtml());
  let now = 0;
  return new PublishCommandDispatcher(
    depsFor(doc, new FakeExecutor(doc)),
    {},
    () => now,
    undefined,
    cdp as unknown as ConstructorParameters<typeof PublishCommandDispatcher>[4],
    { sleep: async (ms) => { now += ms; }, enabled: pacingEnabled, random: () => 0.5 },
  );
}

test('正文语义投影：URL/emoji/换行/标点不参与，中文英文数字与 URL 后紧邻中文均保留', () => {
  const value = '商汤（SenseTime）\n🔹 ７Ｂ：https://example.com/path?q=1后文 **OCR**';
  assert.equal(normalizeXhsContentSemanticText(value), '商汤SenseTime7B后文OCR');
});

test('正文语义相似度边界：90% 放行，89% 拒绝', () => {
  const expected = '甲'.repeat(100);
  assert.equal(xhsContentSemanticSimilarity(expected, '甲'.repeat(90)), XHS_CONTENT_SEMANTIC_SIMILARITY_THRESHOLD);
  assert.ok(xhsContentSemanticSimilarity(expected, '甲'.repeat(89)) < XHS_CONTENT_SEMANTIC_SIMILARITY_THRESHOLD);
});

test('拟人填写：CDP 路径标题/正文逐字打字（多次 insertText，拼接==原值）而非一次性灌入', async () => {
  const cdp = new FakeCdp();
  const dispatcher = dispatcherWithCdp(cdp);
  const value = '大模型选型避坑';
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, true);
  const inserts = cdp.inserts();
  assert.equal(inserts.length, Array.from(value).length, '应逐字 insertText（每字符一次）');
  assert.equal(inserts.join(''), value, '逐字拼接应等于原值（不丢内容）');
});

test('拟人填写：pacing 关 → 回退一次性 insertText（旧快路径，零回归）', async () => {
  const cdp = new FakeCdp();
  const dispatcher = dispatcherWithCdp(cdp, false);
  const value = '大模型选型避坑';
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'title', value }), 'xiaohongshu');
  assert.equal(res.ok, true);
  const inserts = cdp.inserts();
  assert.equal(inserts.length, 1, 'pacing 关时一次性灌入');
  assert.equal(inserts[0], value);
});

test('多段正文：换行独立 Enter + selection 归尾，尾字不再被后续段落顶到文末', async () => {
  const cdp = new FakeCdp({ rewindCaretAfterEnter: true });
  const dispatcher = dispatcherWithCdp(cdp);
  const value = '第一段尾字甲\r\n第二段尾字乙\n\n第三段尾字丙';
  const normalized = value.replace(/\r\n?/g, '\n');
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(cdp.text, normalized, '即使 Enter 后 caret 回退，下一段也必须归尾后再写，正文顺序保持不变');
  assert.ok(cdp.inserts().every((part) => !/[\r\n]/.test(part)), '任何 Input.insertText 都不得携带换行');
  const enters = cdp.calls.filter((call) =>
    call.method === 'Input.dispatchKeyEvent' && call.params?.type === 'keyDown' && call.params?.key === 'Enter');
  assert.equal(enters.length, 3, 'CRLF 归一为一个 Enter，连续空行保留为两个连续 Enter');
  const caretChecks = cdp.calls.filter((call) =>
    call.method === 'Runtime.evaluate' && String(call.params?.expression ?? '').includes('xhs-content-caret-state'));
  assert.ok(caretChecks.length >= 6, '每个 Enter 后至少连续两次确认 selection 稳定在末端');
});

test('ProseMirror 真实段落边界：末段 p 内 caret 是语义末端，不要求等于外层 div 末端', () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div class="tiptap ProseMirror" contenteditable="true"><p>第一段</p><p><br></p></div></body></html>',
    { runScripts: 'outside-only' },
  );
  const doc = dom.window.document;
  const editor = doc.querySelector('.tiptap.ProseMirror')!;
  const lastParagraph = editor.lastElementChild!;
  const selection = dom.window.getSelection()!;
  const caret = doc.createRange();
  caret.setStart(lastParagraph, 0);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);

  const expression = buildXhsContentCaretStateExpression(`document.querySelector('.tiptap.ProseMirror')`);
  const state = JSON.parse(String(dom.window.eval(expression))) as { newlines: number; atEnd: boolean };
  assert.equal(state.newlines, 1, '两个顶层 p 表示一个已创建的换行');
  assert.equal(state.atEnd, true, '末段 p 内的空 caret 与外层 div 末端边界不同，但语义上已经在正文末端');
});

test('ProseMirror 真实段落边界：前段 caret 先归到末段内部，下一轮确认末端', () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div class="tiptap ProseMirror" contenteditable="true"><p>第一段</p><p><br></p></div></body></html>',
    { runScripts: 'outside-only' },
  );
  const doc = dom.window.document;
  const editor = doc.querySelector('.tiptap.ProseMirror')!;
  const firstParagraph = editor.firstElementChild!;
  const lastParagraph = editor.lastElementChild!;
  const selection = dom.window.getSelection()!;
  const staleCaret = doc.createRange();
  staleCaret.selectNodeContents(firstParagraph);
  staleCaret.collapse(false);
  selection.removeAllRanges();
  selection.addRange(staleCaret);

  const expression = buildXhsContentCaretStateExpression(`document.querySelector('.tiptap.ProseMirror')`);
  const first = JSON.parse(String(dom.window.eval(expression))) as { atEnd: boolean };
  assert.equal(first.atEnd, false, '停在上一段尾部不能被当作编辑器末端');
  assert.ok(lastParagraph.contains(selection.anchorNode), '校准必须把 caret 放进最后段落，而不是外层 div 边界');
  const second = JSON.parse(String(dom.window.eval(expression))) as { atEnd: boolean };
  assert.equal(second.atEnd, true, '段内归尾后下一轮应确认稳定');
});

test('换行确认持续不稳定：清空正文并诚实失败，不留下逐渐积累的文末尾字', async () => {
  const cdp = new FakeCdp({ neverStabilizeCaret: true });
  const dispatcher = dispatcherWithCdp(cdp);
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value: '第一段尾字甲\n第二段' }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^engine_error: content_newline_unstable/);
  assert.equal(cdp.text, '', 'Enter 后 selection 无法稳定时 MUST 清场，绝不把半篇正文留给后续步骤');
});

test('Enter 被页面吞掉：即使 caret 在末端也不能放行，必须清场并诚实失败', async () => {
  const cdp = new FakeCdp({ swallowEnter: true });
  const dispatcher = dispatcherWithCdp(cdp);
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value: '第一段\n第二段' }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^engine_error: content_newline_unstable/);
  assert.equal(cdp.text, '', '未建出段落时 MUST 清场，绝不把丢失换行的正文当成功');
});

// ── change lease-strict-preemption task 3.1：清场协议（抢占的硬前置）──────────────

test('清场：编辑器里有上一篇的残文 → 先清空再填，正文 MUST NOT 拼接', async () => {
  // 被抢占 / 失败留下的半截正文。旧代码无清空前置 + 只比对前 8 字 → 残文 + 新文照样放行，
  // 真发出一篇拼接的帖子。这条断言就是那个 bug 的坟。
  const cdp = new FakeCdp({ initialText: '上一篇被抢占时留下的半截正文' });
  const dispatcher = dispatcherWithCdp(cdp);
  const value = '这一篇的正文';
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(cdp.text, value, '编辑器里 MUST 只剩这一篇的正文，绝不与残文拼接');
});

test('清场：残文清不掉（选区被框架吃掉）→ 诚实 editor_not_clean，绝不带着残文往下发', async () => {
  const cdp = new FakeCdp({ initialText: '清不掉的残文', unclearable: true });
  const dispatcher = dispatcherWithCdp(cdp);
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value: '新正文' }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^editor_not_clean/);
  assert.equal(cdp.inserts().length, 0, '清不干净就 MUST NOT 往里打字');
});

test('全文回读：编辑器只吃进前 8 个字 → post_validate_failed（旧的前 8 字探针恰好会放行）', async () => {
  // 刻意卡在旧探针的盲点上：前 8 字进去了，后面全被吞。旧的「includes(前8字)」判定为真
  // → 真发出一篇被截断的帖子。全文回读必须抓到。
  const value = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸';
  const cdp = new FakeCdp({ swallowAfter: 8 });
  const dispatcher = dispatcherWithCdp(cdp);
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^post_validate_failed/);
  assert.equal(cdp.text, '', '放弃这一步 MUST 清场，绝不把半截正文留在活着的编辑器里');
});

test('全文回读：正文被塞入大量额外文字（相似度低于 90%）→ field_polluted + 清场', async () => {
  const cdp = new FakeCdp();
  const dispatcher = dispatcherWithCdp(cdp);
  const value = '干净正文';
  // 打完之后页面被联想/输入法塞了一长串，使对称相似度跌破 90%。
  const orig = cdp.send.bind(cdp);
  let typed = 0;
  (cdp as unknown as { send: typeof orig }).send = async (method, params) => {
    const r = await orig(method, params);
    if (method === 'Input.insertText' && ++typed === Array.from(value).length) cdp.text += '被话题联想塞进来的一长串脏东西';
    return r as never;
  };
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^field_polluted/);
  assert.equal(cdp.text, '', '同样 MUST 清场');
});

test('语义文字：正文 URL/emoji 被编辑器改写但中文英文数字齐全 → ok:true（record 133 回归）', async () => {
  // 实机 record 133：正文含外链 https://... + 组合 emoji 🛠️，小红书富文本编辑器把外链吞掉/emoji 规整掉，
  // 回读文本与原始正文不再逐字一致。旧的精确子串校验会误判 post_validate_failed、连带整篇定时稿被 fail-closed 毙掉。
  const cdp = new FakeCdp();
  const dispatcher = dispatcherWithCdp(cdp);
  const value = '给Agent做长期记忆🛠️看仓库https://github.com/foo/bar就够了';
  // 编辑器改写：打完后把 emoji/URL 从回读里抹掉，中文与 Agent 等英文仍完整。
  const orig = cdp.send.bind(cdp);
  let typed = 0;
  (cdp as unknown as { send: typeof orig }).send = async (method, params) => {
    const r = await orig(method, params);
    if (method === 'Input.insertText' && ++typed === Array.from(value).length) {
      cdp.text = '给Agent做长期记忆看仓库就够了';
    }
    return r as never;
  };
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, true, 'URL/emoji 改写不参与比较，中文英文数字语义文字完整即可成功');
  assert.equal(cdp.text, '给Agent做长期记忆看仓库就够了', '测试必须真实执行 URL/emoji 改写，而不是原文原样通过');
});

test('语义文字：纯英文正文吞字超过 10% → post_validate_failed', async () => {
  const value = 'Agent memory tool';
  const cdp = new FakeCdp({ swallowAfter: 5 }); // 只吃进前 5 字符 'Agent'，其余被吞
  const dispatcher = dispatcherWithCdp(cdp);
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^post_validate_failed/, '英文是语义文字，超过容差的丢失绝不假成功');
});

test('语义文字：中文完整但英文模型名和数字大量丢失 → post_validate_failed', async () => {
  const value = '商汤科技SenseTimeSenseNova7BMoTOCRGUI视觉模型';
  const cdp = new FakeCdp();
  const dispatcher = dispatcherWithCdp(cdp);
  const originalSend = cdp.send.bind(cdp);
  (cdp as unknown as { send: typeof originalSend }).send = async (method, params) => {
    const result = await originalSend(method, params);
    if (method === 'Input.insertText' && cdp.text === value) cdp.text = '商汤科技视觉模型';
    return result as never;
  };
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^post_validate_failed/, '不能因汉字仍完整就忽略英文和数字丢失');
});

test('语义文字：最终回读恰好保留 90% → 保底放行', async () => {
  const value = '甲'.repeat(100);
  const cdp = new FakeCdp();
  const dispatcher = dispatcherWithCdp(cdp);
  const originalSend = cdp.send.bind(cdp);
  (cdp as unknown as { send: typeof originalSend }).send = async (method, params) => {
    const result = await originalSend(method, params);
    if (method === 'Input.insertText' && cdp.text === value) cdp.text = '甲'.repeat(90);
    return result as never;
  };
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, true, '相似度 >= 0.90 必须放行');
  assert.equal(cdp.text.length, 90);
});

test('语义文字：最终回读仅保留 89% → 拒绝并清场', async () => {
  const value = '甲'.repeat(100);
  const cdp = new FakeCdp();
  const dispatcher = dispatcherWithCdp(cdp);
  const originalSend = cdp.send.bind(cdp);
  (cdp as unknown as { send: typeof originalSend }).send = async (method, params) => {
    const result = await originalSend(method, params);
    if (method === 'Input.insertText' && cdp.text === value) cdp.text = '甲'.repeat(89);
    return result as never;
  };
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^post_validate_failed/);
  assert.equal(cdp.text, '', '低于阈值必须清场');
});

test('语义文字为空：仅 URL/emoji 的正文仍走精确兜底，不能空投影假成功', async () => {
  const value = 'https://example.com/only 🛠️';
  const cdp = new FakeCdp({ swallowAfter: 0 });
  const dispatcher = dispatcherWithCdp(cdp);
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^post_validate_failed/);
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
    const res = await mkTopicCdp(doc, cdp).dispatch(cmd('add_with_candidate', { candidateKind: 'topic', value: '大模型' }), 'xiaohongshu');
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
    const res = await mkTopicCdp(doc, cdp, fastClock()).dispatch(cmd('add_with_candidate', { candidateKind: 'topic', value: '大模型' }), 'xiaohongshu');
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
    const res = await mkTopicCdp(doc, cdp, fastClock()).dispatch(cmd('add_with_candidate', { candidateKind: 'topic', value: '大模型' }), 'xiaohongshu');
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
    await mkTopicCdp(doc, cdp).dispatch(cmd('add_with_candidate', { candidateKind: 'topic', value: '大模型' }), 'xiaohongshu');
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
  const res = await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'select_mode');
  assert.equal(cdp.clickEvalCount(), 0, '已在图文模式应幂等早退、绝不点击');
});

test('select_mode happy：视频起步 → 点中可见 tab → 激活 tab 变图文（state=image）→ ok:true', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: 'image' });
  const res = await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.ok(cdp.clickEvalCount() >= 1, '视频模式起步应真的点了图文 tab');
});

test('select_mode happy（辅助信号兜底）：点击后激活态未识别（state=""）但 IMG_MODE_ACTIVE 转真 → ok:true（不回归旧验证信号）', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: '', imgActiveAfterClick: true });
  const res = await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  assert.equal(res.ok, true, '激活态识别不出时点击后 IMG 信号（文件输入 accept 变图片类）应兜底确认成功');
});

test('select_mode 冷加载：tab 晚渲染（前若干次点击 miss，稍后命中）→ 有界重试点中 → ok:true', async () => {
  // 前 2 次 CLICK_TAB miss（clicked:false），第 3 次起命中；命中后激活 tab 变图文。
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 2, stateAfterClick: 'image' });
  const res = await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  assert.equal(res.ok, true);
  assert.ok(cdp.clickEvalCount() >= 3, '应重试点击直到命中（冷加载容忍）');
});

test('select_mode 始终无可见 tab 且未在图文模式 → 诚实 no_target（红线：绝不假成功）', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: Number.POSITIVE_INFINITY });
  const res = await mkSelectMode(cdp, selectStepClock(5000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_target');
});

test('select_mode 点了但模式始终未激活（点到隐藏副本/点击无效）→ 诚实 post_validate_failed', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: '', imgActiveAfterClick: false });
  const res = await mkSelectMode(cdp, selectStepClock(5000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'post_validate_failed', '点了没切上模式必须诚实报，绝不谎报已切');
});

// ── 双布局硬化（评审对抗性反馈：辅助信号是「电平」非「跃变」，须防残留图片信号在视频模式假成功）──

test('select_mode 硬化：点了但仍确认在视频模式（state=video）+ 残留图片信号 → 否决辅助信号、诚实 post_validate_failed', async () => {
  // 关键：imgActiveFromStart=true（视频模式下就存在图片信号）+ 点击后 state 仍 'video'。
  // 旧「电平或」会因 IMG 为真而假成功；硬化后 state==='video' 否决 IMG → 诚实失败。
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: 'video', imgActiveFromStart: true });
  const res = await mkSelectMode(cdp, selectStepClock(5000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  assert.equal(res.ok, false, '仍在视频模式绝不因残留图片信号谎报成功（红线：不假成功）');
  assert.equal(res.error, 'post_validate_failed');
});

test('select_mode 硬化：点击前存在残留图片信号但未点中任何 tab → 只认权威 state、诚实 no_target（不盲信 IMG）', async () => {
  // 点击前只认权威 MODE_STATE（'video'），IMG 残留信号不参与点击前判定 → 从未点中 → no_target（非假成功）。
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: Number.POSITIVE_INFINITY, stateFromStart: 'video', imgActiveFromStart: true });
  const res = await mkSelectMode(cdp, selectStepClock(5000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  assert.equal(res.ok, false, '点击前残留图片信号绝不当作已在图文模式');
  assert.equal(res.error, 'no_target');
});

test('select_mode 红线：下发的点击 JS 含可见性判据（取可见非取首个，躲隐藏副本）', async () => {
  const cdp = new SelectModeFakeCdp({ clickSucceedsAtAttempt: 0, stateAfterClick: 'image' });
  await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  const clickJs = cdp.exprContaining('/*CLICK_TAB*/');
  assert.ok(clickJs, '应有 CLICK_TAB 表达式被下发');
  // 可见性判据须按「与视口相交」过滤（真机标定：隐藏副本被移到屏幕外 x≈-9758，offsetParent 判据会误判其可见）。
  assert.ok(clickJs!.includes('getBoundingClientRect') && clickJs!.includes('innerWidth'), '点击 JS 必须按视口相交过滤候选（getBoundingClientRect + innerWidth/Height）');
});

test('select_mode 红线：模式判据保守（激活 tab 文本含「图文」与「视频」两侧约束，绝不视频模式谎报）', async () => {
  const cdp = new SelectModeFakeCdp({ stateFromStart: 'image' });
  await mkSelectMode(cdp, selectStepClock(1000)).dispatch(cmd('select_mode', {}, 1), 'xiaohongshu');
  const modeJs = cdp.exprContaining('/*MODE_STATE*/');
  assert.ok(modeJs, '应有 MODE_STATE 表达式被下发');
  assert.ok(modeJs!.includes('图文') && modeJs!.includes('视频'), '模式判据须同时约束「图文」与「视频」两侧');
  assert.ok(/aria-selected|active|selected|current/.test(modeJs!), '模式判据须限定激活态 tab');
});

// ── change lease-strict-preemption task 4：取消点补齐（安全取消点让位；提交点之后是禁区）──────
//
// 两侧各一条红线，缺一条都会出人命：
//  ① 安全取消点（下一个页面写尚未发出）MUST 能让位，且让位前 MUST 清场 —— 半截正文留在活着的
//     编辑器里，会和下一篇拼在一起发出去；且回执是 preempted_by_task（「未开始 / 已作废」），
//     不是 engine_error（「发布失败」），云端据此绝不写不可逆 failed 终态。
//  ② 提交点之后（发布按钮已点下去）MUST NOT 取消 —— 中止 = 把一篇**可能已经发出去的帖子**当成
//     没发生 → 云端重投 → 发两遍。后置校验必须照跑到底、按页面真实状态回报。

/**
 * submit_publish 专用 fake cdp：闭合 shadow 里的「发布」按钮（DOM.getDocument 穿透 + getBoxModel 取中心点）
 * + 提交后的成功态回读（CHECK）。
 *
 * 🔴 5.9 收紧后成功证据**只认页面成功文案**（body 出现「发布成功」）。原「URL 已离开 /publish/publish」判据是
 * 一颗已上膛的假成功（抢占方 / 恢复导航会在 15s 窗口内把发布页导走 → 一篇可能没发出的稿被记成已发布），已由
 * 5.2/5.3 的 publishInFlight 闸封住恢复导航、再由本 CHECK 去除 URL 判据做纵深防御。故本桩镜像收紧后的 CHECK：
 * **只按成功文案返回**——「已离开发布页」单独存在（无成功文案）绝不判成功。回归 checkExpr() 另断言 CHECK 串已无 URL 判据。
 */
class SubmitFakeCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private bodyText = '正在编辑';
  private checkProbes = 0;
  /**
   * successAtProbe：第几次 CHECK 轮询时页面才出现「发布成功」（缺省第 2 次：toast 晚一拍，逼后置校验真的轮询；
   *   传 Infinity = 成功文案永不出现，逼出 post_validate_failed）。
   * noButton：DOM 里没有「发布」按钮 → findShadowButtonCenter 返回 null → no_target（点击之前失败）。
   */
  constructor(private readonly opts: { successAtProbe?: number; noButton?: boolean; throwOnMousePressed?: boolean } = {}) {}
  /** 捕获后置校验 CHECK 表达式串（回归断言 5.9：不得含 location.href / URL 判据）。 */
  checkExpr(): string {
    const call = this.calls.find((c) => c.method === 'Runtime.evaluate' && String((c.params as { expression?: string })?.expression ?? '').includes('发布成功'));
    return String((call?.params as { expression?: string })?.expression ?? '');
  }
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'DOM.getDocument') {
      if (this.opts.noButton) return { root: { nodeType: 9, children: [] } } as T; // 无「发布」按钮 → no_target
      // 文本恰为「发布」的元素节点（nodeId=7）；walk() 按 children 里的文本节点命中。
      return { root: { nodeType: 9, children: [{ nodeType: 1, nodeId: 7, children: [{ nodeType: 3, nodeValue: '发布' }] }] } } as T;
    }
    if (method === 'DOM.getBoxModel') return { model: { content: [100, 200, 140, 200, 140, 220, 100, 220] } } as T; // center=(120,210)
    if (method === 'DOM.getAttributes') return { attributes: [] } as T;
    // 故障注入：mousePressed 已注入浏览器（mousedown 已触发）但其 CDP 响应超时/reject——点击可能已生效。
    if (method === 'Input.dispatchMouseEvent' && (params as { type?: string })?.type === 'mousePressed' && this.opts.throwOnMousePressed) {
      throw new Error('CDP 命令超时: Input.dispatchMouseEvent mousePressed');
    }
    if (method === 'Runtime.evaluate') {
      const expr = String(params?.expression ?? '');
      if (expr.includes('发布成功')) {
        // CHECK（5.9 收紧）：**只认成功文案**。leftPublishPage（已离开发布页但无成功文案）MUST NOT 判成功。
        if (++this.checkProbes >= (this.opts.successAtProbe ?? 2)) this.bodyText = '发布成功，稍后可在笔记里查看';
        const byText = /发布成功|发布中|笔记已?发布|成功发布|稍后可在/.test(this.bodyText);
        return { result: { value: byText } } as T;
      }
      return { result: { value: '{}' } } as T; // 诊断快照（只观测，不改行为）
    }
    return {} as T;
  }
  countOf(method: string, type?: string): number {
    return this.calls.filter((c) => c.method === method && (!type || (c.params as { type?: string })?.type === type)).length;
  }
  pressed(): number {
    return this.countOf('Input.dispatchMouseEvent', 'mousePressed');
  }
  checkProbeCount(): number {
    return this.checkProbes;
  }
}

function mkSubmit(cdp: SubmitFakeCdp): PublishCommandDispatcher {
  const doc = buildDom(publishPageHtml());
  return new PublishCommandDispatcher(
    depsFor(doc, new FakeExecutor(doc)),
    {},
    selectStepClock(50), // 小步时钟：15s 后置校验窗口在桩里瞬间跑完，绝不真等
    undefined,
    cdp as unknown as ConstructorParameters<typeof PublishCommandDispatcher>[4],
    { sleep: instantSleep, random: () => 0.5 },
  );
}

test('取消点：fill_field 打字中途被接管 → 插入停在半途 + 让位前清场 + preempted_by_task（非 engine_error）', async () => {
  const cdp = new FakeCdp();
  const value = '这一篇被抢占的正文内容';
  // 抢占发生在「已打进去 3 个字、第 4 块的 CDP 写尚未发出」的那道缝（typeHumanized 里唯一正确的取消缝）。
  const takeover: TakeoverCtx = {
    checkpoint: () => {
      if (cdp.inserts().length >= 3) throw new TaskTakeoverError();
    },
  };
  const res = await dispatcherWithCdp(cdp).dispatch(cmd('fill_field', { fieldType: 'content', value }), 'xiaohongshu', takeover);

  const typed = cdp.inserts().join('');
  assert.ok(typed.length > 0 && typed.length < Array.from(value).length, '插入 MUST 停在半途（既不是零字，也不是整篇打完）');
  assert.equal(cdp.text, '', '让位前 MUST 清场：半截正文留在活着的编辑器里会和下一篇拼在一起发出去');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'preempted_by_task', '被接管 = 未开始/已作废，MUST NOT 降级成 engine_error（云端会据此写不可逆 failed）');
});

test('取消点：submit_publish 在「通读停留」期间被接管 → 零 mousePressed（一个字节都没提交出去）+ preempted_by_task', async () => {
  const cdp = new SubmitFakeCdp();
  // 抢占发生在「发布按钮已定位、点击尚未发出」的那道缝 —— 整条发布流的最后一个安全取消点。
  const takeover: TakeoverCtx = {
    checkpoint: () => {
      if (cdp.countOf('DOM.getBoxModel') > 0) throw new TaskTakeoverError();
    },
  };
  const res = await mkSubmit(cdp).dispatch(cmd('submit_publish', {}, 7), 'xiaohongshu', takeover);

  assert.equal(cdp.pressed(), 0, '提交点之前让位 MUST 零 mousePressed：帖子一个字节都没提交出去');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'preempted_by_task');
  assert.ok(!res.submitDispatched, '点击之前被接管 = 压根没点：submitDispatched MUST 为假（否则云端记成「已提交待确认」丢稿）');
});

test('🔴 禁区：submit_publish 点击已发出后被接管 → 15s 后置校验照跑到底，按页面真实成功态回 ok:true（绝不改写成 preempted）', async () => {
  // 抢占方在**点击落地之后**才翻世代：此后任何 checkpoint 调用都会抛。实现若在这 15s 窗口里取消，
  // 就是把一篇**可能已经发出去的帖子**当成没发生 → 云端重投 → 发两遍。
  // 成功证据只认页面成功文案（桩把 URL 钉死在发布页上，见 SubmitFakeCdp 注释：URL 判据是尚未修复的假成功）。
  const cdp = new SubmitFakeCdp({ successAtProbe: 2 });
  const takeover: TakeoverCtx = {
    checkpoint: () => {
      if (cdp.pressed() > 0) throw new TaskTakeoverError();
    },
  };
  const res = await mkSubmit(cdp).dispatch(cmd('submit_publish', {}, 8), 'xiaohongshu', takeover);

  assert.equal(cdp.pressed(), 1, '确实点了发布（提交点已跨过）');
  assert.equal(res.ok, true, '提交点之后 MUST NOT 取消：后置校验照跑到底、按页面真实成功态回报');
  assert.equal(res.error, undefined, '绝不改写成 preempted_by_task —— 那会让云端重投、发两遍');
  assert.equal(res.submitDispatched, true, '点击已发出 → submitDispatched=true（6.2）');
  assert.ok(cdp.checkProbeCount() >= 2, '后置校验确实轮询到成功文案出现（而非一探就返回）');
  // 反「空测」自证：接管确实是「已发生」态——实现只是（正确地）在禁区里从不调用它。
  assert.throws(() => takeover.checkpoint(), TaskTakeoverError);
});

test('🔴 6.2 已派发提交位：点击已发出但后置校验超时未确认 → ok:false/post_validate_failed 且 submitDispatched=true（云端 MUST NOT 当「提交前失败」重投）', async () => {
  // 成功文案永不出现（successAtProbe=Infinity）+ URL 钉在发布页 → CHECK 全程为假 → post_validate_failed。
  // 关键：点击已经发出去了，帖子可能已发出。此回执必须携 submitDispatched=true，区别于「压根没点」的
  // no_target/engine_error（那些保持假）——否则云端把一篇可能已发出的稿判成提交前失败、重投 = 双发。
  const cdp = new SubmitFakeCdp({ successAtProbe: Number.POSITIVE_INFINITY });
  const res = await mkSubmit(cdp).dispatch(cmd('submit_publish', {}, 9), 'xiaohongshu');

  assert.equal(cdp.pressed(), 1, '确实点了发布');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^post_validate_failed/, '成功证据未命中 → 诚实 post_validate_failed（绝不假成功）');
  assert.equal(res.submitDispatched, true, '已点未确认 MUST submitDispatched=true —— 与「压根没点」回执面区分开');
});

test('🔴 5.9 收紧假成功 CHECK：后置校验只认成功文案，绝不含「离开发布页」URL 判据（那颗已上膛的假成功）', async () => {
  // 成功文案在第 2 次探到 → ok:true。关键回归：下发的 CHECK 表达式**不得**含 location.href / URL 判据——
  // 否则抢占方/恢复导航在 15s 窗口内把发布页导走 → 一篇可能没发出的稿被判已发布（5.9 根治点）。
  const cdp = new SubmitFakeCdp({ successAtProbe: 2 });
  const res = await mkSubmit(cdp).dispatch(cmd('submit_publish', {}, 11), 'xiaohongshu');
  assert.equal(res.ok, true, '成功文案命中 → ok:true');
  const expr = cdp.checkExpr();
  assert.ok(expr.length > 0 && expr.includes('发布成功'), '确实下发了 CHECK 表达式');
  assert.ok(!/location\.href|\/publish\/publish/.test(expr), 'CHECK MUST NOT 含 URL 判据——「已离开发布页」绝不单独判成功（5.9）');
});

test('🔴 6.2 已派发提交位：发布按钮找不到（no_target，压根没点）→ submitDispatched 保持假', async () => {
  // center 查找类失败在点击之前返回，MUST NOT 携 submitDispatched（否则一篇从未提交的稿被记成已提交待确认、永久丢失）。
  const cdp = new SubmitFakeCdp({ noButton: true });
  const res = await mkSubmit(cdp).dispatch(cmd('submit_publish', {}, 10), 'xiaohongshu');

  assert.equal(cdp.pressed(), 0, '没找到发布按钮 → 一次点击都没发出');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_target');
  assert.ok(!res.submitDispatched, 'no_target = 压根没点：submitDispatched MUST 为假');
});

test('🔴 复核 wf_1657e89b MEDIUM：mousePressed 已发出但其响应抛错（点击可能已生效）→ engine_error 且 submitDispatched=true（press 时机）', async () => {
  // 修前：submitDispatched 在 dispatchClick 整体返回后才置真 → press 已注入但 send 抛错 → 回执 submitDispatched=false
  //       → 云端按提交前失败重投 → 双发。修后：onPressDispatched 在 commitLeftClick 之前触发，press 一派发即置真。
  const cdp = new SubmitFakeCdp({ throwOnMousePressed: true });
  const res = await mkSubmit(cdp).dispatch(cmd('submit_publish', {}, 12), 'xiaohongshu');
  assert.equal(cdp.pressed(), 1, 'mousePressed 确实发往浏览器（mousedown 已触发）');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^engine_error/, 'press 响应抛错 → 诚实 engine_error');
  assert.equal(res.submitDispatched, true, '🔴 press 已派发即置真：即便 click 调用抛错也 MUST NOT 报「压根没点」→ 防双发');
});
