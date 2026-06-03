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
  buildContentInputRequest,
  buildEnterPublishPageRequest,
  buildSubmitPublishRequest,
  buildTagInputRequest,
  buildTitleInputRequest,
  publishPost,
  type PublishRequestPayload,
} from '../../src/flows/publish-post.js';
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

class FakeSelector implements ElementSelector {
  async select(_goal: string, els: ElementDescriptor[]): Promise<SelectionResult> {
    const goal = _goal;
    const preferred =
      (goal.includes('进入') &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_ENTRY_ACTION_ID)) ||
      (goal.includes('标题') &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_TITLE_ACTION_ID)) ||
      ((goal.includes('正文') || goal.includes('内容')) &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_CONTENT_ACTION_ID)) ||
      ((goal.includes('标签') || goal.includes('话题')) &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_TAG_ACTION_ID)) ||
      (goal.includes('提交') &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_SUBMIT_ACTION_ID)) ||
      (goal.includes('发布') &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_SUBMIT_ACTION_ID)) ||
      els[0];
    return preferred
      ? { index: preferred.index, element: preferred, reason: 'picked_publish_target' }
      : { index: null, reason: 'none' };
  }
}

class FakeExecutor implements ActionExecutor {
  readonly calls: { op: ActionRequest['op']; actionId: string; value?: string }[] = [];

  constructor(
    private readonly doc: Document,
    private readonly failActionIds: Set<string> = new Set(),
    private readonly skipTagCommit: Set<string> = new Set(),
    private readonly skipSubmitPostId = false,
  ) {}

  execute(op: ActionRequest['op'], element: ElementDescriptor, value?: string): void {
    const actionId = element.attributes['data-action-id'] ?? '';
    this.calls.push({ op, actionId, value });
    if (this.failActionIds.has(actionId)) {
      throw new Error(`forced_failure:${actionId}`);
    }
    const node = this.doc.querySelector(`[data-action-id="${actionId}"]`);
    if (!node) return;
    if (op === 'click' && actionId === 'note.publish_entry') {
      this.doc.body.setAttribute('data-page', 'publish');
    }
    if (op === 'input') {
      if (node instanceof this.doc.defaultView!.HTMLInputElement || node instanceof this.doc.defaultView!.HTMLTextAreaElement) {
        node.value = value ?? '';
      } else {
        node.textContent = value ?? '';
      }
      if (actionId === 'note.publish_tag' && value && !this.skipTagCommit.has(value)) {
        const tags = this.doc.getElementById('selected-tags')!;
        const chip = this.doc.createElement('span');
        chip.textContent = value;
        chip.setAttribute('data-tag', value);
        tags.appendChild(chip);
      }
    }
    if (op === 'click' && actionId === 'note.publish_submit' && !this.skipSubmitPostId) {
      const result = this.doc.getElementById('publish-result')!;
      result.setAttribute('data-post-id', 'post_123');
    }
  }
}

function publishPageHtml(): string {
  return `
    <button data-action-id="note.publish_entry">发布</button>
    <div class="publish-container">
      <input data-action-id="note.publish_title" placeholder="填写标题" />
      <textarea data-action-id="note.publish_content" placeholder="写点什么"></textarea>
      <input data-action-id="note.publish_tag" placeholder="添加标签" />
      <div id="selected-tags"></div>
      <button data-action-id="note.publish_submit">立即发布</button>
      <div id="publish-result"></div>
    </div>
  `;
}

function depsFor(
  doc: Document,
  executor: ActionExecutor,
): {
  dom: DomProvider;
  executor: ActionExecutor;
  selector: ElementSelector;
  cache: AnchorCache;
} {
  return {
    dom: new LiveDom(doc),
    executor,
    selector: new FakeSelector(),
    cache: new AnchorCache(),
  };
}

const payload: PublishRequestPayload = {
  title: '测试标题',
  content: '测试正文内容',
  tags: ['AI', 'Agent'],
};

test('publish-post: success path returns postId', async () => {
  const doc = buildDom(publishPageHtml());
  const executor = new FakeExecutor(doc);
  const contentNode = doc.querySelector('[data-action-id="note.publish_content"]') as HTMLTextAreaElement;
  const result = await publishPost(depsFor(doc, executor), {}, payload);
  assert.equal(contentNode.value, payload.content);
  assert.deepEqual(result, { ok: true, postId: 'post_123' });
  assert.deepEqual(
    executor.calls.map((call) => call.actionId),
    [
      buildEnterPublishPageRequest().actionId,
      buildTitleInputRequest(payload.title).actionId,
      buildContentInputRequest(payload.content).actionId,
      buildTagInputRequest(payload.tags[0]).actionId,
      buildTagInputRequest(payload.tags[1]).actionId,
      buildSubmitPublishRequest().actionId,
    ],
  );
});

test('publish-post: images are rejected in phase one', async () => {
  const doc = buildDom(publishPageHtml());
  const executor = new FakeExecutor(doc);
  const result = await publishPost(depsFor(doc, executor), {}, { ...payload, images: ['a.png'] });
  assert.deepEqual(result, { ok: false, error: '[images] images are not supported in phase one' });
  assert.equal(executor.calls.length, 0);
});

test('publish-post: each step failure returns explicit step error', async () => {
  const cases: Array<{ actionId: string; step: string }> = [
    { actionId: 'note.publish_entry', step: 'enter_publish_page' },
    { actionId: 'note.publish_title', step: 'input_title' },
    { actionId: 'note.publish_content', step: 'input_content' },
    { actionId: 'note.publish_tag', step: 'input_tag' },
    { actionId: 'note.publish_submit', step: 'submit_publish' },
  ];

  for (const item of cases) {
    const doc = buildDom(publishPageHtml());
    const executor = new FakeExecutor(doc, new Set([item.actionId]));
    const result = await publishPost(depsFor(doc, executor), {}, payload);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', new RegExp(`^\\[${item.step}\\]`));
  }
});

test('publish-post: final validation failure after submit returns explicit error', async () => {
  const doc = buildDom(publishPageHtml());
  const executor = new FakeExecutor(doc, new Set(), new Set(), true);
  const result = await publishPost(depsFor(doc, executor), {}, payload);
  assert.deepEqual(result, { ok: false, error: '[validate_publish] missing_post_id' });
});

test('publish-post: tag not joined successfully fails at input_tag step', async () => {
  const doc = buildDom(publishPageHtml());
  const executor = new FakeExecutor(doc, new Set(), new Set(['Agent']));
  const result = await publishPost(depsFor(doc, executor), {}, payload);
  assert.deepEqual(result, { ok: false, error: '[input_tag] post_validate_failed' });
});