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
  return { recordId: 100, seq, kind, params };
}

test('AC-CMD fill_field(title) 成功 → ok:true，DOM 真写入，回报带 recordId+seq+kind', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));
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
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc, true)), { maxAttempts: 2 });
  const res = await dispatcher.dispatch(cmd('fill_field', { fieldType: 'title', value: '没写进去的标题' }));
  assert.equal(res.ok, false);
  assert.ok(res.error, '失败必须带真实 error');
  assert.notEqual(res.error, undefined);
});

test('AC-CMD capture_postId 抓到 → ok:true value=真实 postId', async () => {
  const doc = buildDom(publishPageHtml('<a href="/explore/post_abc123">查看笔记</a>'));
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'));
  assert.equal(res.ok, true);
  assert.equal(res.value, 'post_abc123');
});

test('AC-CMD capture_postId 抓不到 → ok:false error=no_target（红线：MUST NOT postId||fake）', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));
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
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'));
  assert.equal(res.ok, true);
  assert.equal(res.value, 'post_abc123');
  assert.ok(res.postUrl?.includes('xsec_token=ABCTOKEN'), '应回报带 token 的完整分享 URL');
});

test('AC-CMD capture_postId 只有裸 id（缺 xsec_token）→ postUrl 诚实置空（红线：不拼打不开的假链接）', async () => {
  const doc = buildDom(publishPageHtml('<a href="/explore/post_bare">查看笔记</a>'));
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('capture_postId'));
  assert.equal(res.ok, true);
  assert.equal(res.value, 'post_bare', 'postId 仍抓得到');
  assert.equal(res.postUrl, undefined, '缺 token → 不回 postUrl（诚实置空，绝不裸 id 拼假链接）');
});

test('AC-MEDIA upload_image 未注入 uploader → kind_not_implemented（诚实，不假成功）', async () => {
  const doc = buildDom(publishPageHtml());
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('upload_image', { imageUrl: 'https://cdn/x.jpg' }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'kind_not_implemented');
});

test('AC-MEDIA upload_image 经注入 uploader → 成功透传 ok:true / 失败透传真实 error（绝不翻成功）', async () => {
  const doc = buildDom(publishPageHtml());
  let calledWith = '';
  const okUploader = { upload: async (url: string) => { calledWith = url; return { ok: true }; } } as any;
  const okDisp = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, okUploader);
  const ok = await okDisp.dispatch(cmd('upload_image', { imageUrl: 'https://cdn/a.png' }));
  assert.equal(ok.ok, true);
  assert.equal(calledWith, 'https://cdn/a.png', 'imageUrl 透传给 uploader');

  const failUploader = { upload: async () => ({ ok: false, error: 'image_not_attached' }) } as any;
  const failDisp = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, failUploader);
  const fail = await failDisp.dispatch(cmd('upload_image', { imageUrl: 'https://cdn/a.png' }));
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'image_not_attached', '上传失败如实回报，绝不翻成 ok:true');
});

test('AC-MEDIA upload_image 缺 imageUrl（有 uploader）→ no_target', async () => {
  const doc = buildDom(publishPageHtml());
  const uploader = { upload: async () => ({ ok: true }) } as any;
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)), {}, Date.now, uploader);
  const res = await dispatcher.dispatch(cmd('upload_image', {}));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_target');
});

test('AC-MEDIA set_cover → 定位封面入口 + 封面激活态后置校验通过 → ok:true', async () => {
  // 校验器 fail-closed，只认精确锚点 note.publish_cover_active（模拟校准后注入的真实成功态）。
  const extra = `<button data-action-id="note.publish_set_cover">设为封面</button><div data-action-id="note.publish_cover_active"></div>`;
  const doc = buildDom(publishPageHtml(extra));
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('set_cover', { imageUrl: 'https://cdn/a.png' }));
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'set_cover');
});

test('AC-MEDIA set_cover 封面入口缺失 → ok:false（诚实 no_target，不假成功）', async () => {
  const doc = buildDom(publishPageHtml()); // 无封面入口
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)), { maxAttempts: 2 });
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
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));

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
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)), { maxAttempts: 2 });
  const res = await dispatcher.dispatch(cmd('add_with_candidate', { candidateKind: 'mention', value: '查无此控件' }));
  assert.equal(res.ok, false);
  assert.ok(res.error, '失败必须带真实 error');
});

test('AC-CMD-S4 set_option(visibility) → 定位选项控件 + 值校验通过', async () => {
  const extra = `<button data-action-id="note.publish_set_option.visibility">公开</button>`;
  const doc = buildDom(publishPageHtml(extra));
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('set_option', { optionKind: 'visibility', optionValue: '公开' }));
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'set_option');
});

test('AC-CMD-S4 set_schedule → 定位定时控件 + 值写入', async () => {
  const extra = `<label>定时发布</label><input data-action-id="note.publish_set_schedule" placeholder="选择时间" />`;
  const doc = buildDom(publishPageHtml(extra));
  const dispatcher = new PublishCommandDispatcher(depsFor(doc, new FakeExecutor(doc)));
  const res = await dispatcher.dispatch(cmd('set_schedule', { publishTime: 1800000000000 }));
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'set_schedule');
});
