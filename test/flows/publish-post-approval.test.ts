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
import { publishPost, type PublishRequestPayload } from '../../src/flows/publish-post.js';

function buildDom(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

class LiveDom implements DomProvider {
  constructor(private readonly doc: Document) {}
  getRoot(): Document {
    return this.doc;
  }
}

class Selector implements ElementSelector {
  async select(_goal: string, els: ElementDescriptor[]): Promise<SelectionResult> {
    return { index: els[0]?.index ?? null, element: els[0], reason: 'first' };
  }
}

class Executor implements ActionExecutor {
  readonly calls: string[] = [];
  constructor(private readonly doc: Document) {}
  execute(op: ActionRequest['op'], element: ElementDescriptor, value?: string): void {
    const actionId = element.attributes['data-action-id'] ?? '';
    this.calls.push(actionId);
    const node = this.doc.querySelector(`[data-action-id="${actionId}"]`);
    if (!node) return;
    if (op === 'input') {
      if (node instanceof this.doc.defaultView!.HTMLInputElement || node instanceof this.doc.defaultView!.HTMLTextAreaElement) {
        node.value = value ?? '';
      } else {
        node.textContent = value ?? '';
      }
      if (actionId === 'note.publish_tag' && value) {
        const chip = this.doc.createElement('span');
        chip.textContent = value;
        this.doc.getElementById('selected-tags')?.appendChild(chip);
      }
    }
    if (op === 'click' && actionId === 'note.publish_submit') {
      this.doc.getElementById('publish-result')?.setAttribute('data-post-id', 'post_approval_1');
    }
  }
}

function html(): string {
  return `
    <button data-action-id="note.publish_entry">发布</button>
    <input data-action-id="note.publish_title" placeholder="填写标题" value="标题" />
    <textarea data-action-id="note.publish_content" placeholder="写点什么">正文</textarea>
    <input data-action-id="note.publish_tag" placeholder="添加标签" />
    <div id="selected-tags"></div>
    <button data-action-id="note.publish_submit">立即发布</button>
    <div id="publish-result"></div>
  `;
}

const payload: PublishRequestPayload = { title: '标题', content: '正文', tags: ['AI'] };

test('publish-post: approval gate blocks submit before click', async () => {
  const doc = buildDom(html());
  const executor = new Executor(doc);
  const result = await publishPost(
    { dom: new LiveDom(doc), executor, selector: new Selector(), cache: new AnchorCache() },
    {},
    payload,
    {
      // 夹具自测：绕过显式启用门（生产路径没有本闸的调用者）。
      forceEnabledForTest: true,
      requestId: 'req-block',
      now: () => 0,
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      readSignal: async () =>
        JSON.stringify({
          requestId: 'req-block',
          approved: false,
          ts: 1,
          payload: { title: '标题', content: '正文', tags: ['AI'] },
        }),
      removeSignal: async () => undefined,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, '[approval_gate] approval_rejected requestId=req-block');
  assert.ok(!executor.calls.includes('note.publish_submit'));
});

test('publish-post: 开发夹具未显式启用时闸不放行、提交按钮绝不被点', async () => {
  const doc = buildDom(html());
  const executor = new Executor(doc);
  delete process.env.AIDCP_PUBLISH_APPROVAL_SIGNAL_DIR;
  delete process.env.AIDCP_DEV_PUBLISH;
  const result = await publishPost(
    { dom: new LiveDom(doc), executor, selector: new Selector(), cache: new AnchorCache() },
    {},
    payload,
    {
      requestId: 'req-disabled',
      now: () => 0,
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      readSignal: async () =>
        JSON.stringify({
          requestId: 'req-disabled',
          approved: true,
          ts: 1,
          payload: { title: '标题', content: '正文', tags: ['AI'] },
        }),
      removeSignal: async () => undefined,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, '[approval_gate] approval_gate_disabled requestId=req-disabled');
  assert.ok(!executor.calls.includes('note.publish_submit'), '闸未启用绝不静默放行');
});
