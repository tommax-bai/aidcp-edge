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
import { EdgeClient, type CloudWebSocket } from '../../src/client/edge-client.js';
import { makeEnvelope, type Envelope, type PublishRequestPayload, type PublishResultPayload } from '../../src/comm/protocol.js';
import { publishPost } from '../../src/flows/publish-post.js';
import {
  XHS_PUBLISH_CONTENT_ACTION_ID,
  XHS_PUBLISH_ENTRY_ACTION_ID,
  XHS_PUBLISH_SUBMIT_ACTION_ID,
  XHS_PUBLISH_TAG_ACTION_ID,
  XHS_PUBLISH_TITLE_ACTION_ID,
} from '../../src/flows/anchors.js';

class FakeWebSocket implements CloudWebSocket {
  private readonly listeners = {
    open: [] as Array<() => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(ev: unknown) => void>,
    message: [] as Array<(ev: { data: unknown }) => void>,
  };

  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    for (const cb of this.listeners.close) cb();
  }

  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'close', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    cb: (() => void) | ((ev: unknown) => void) | ((ev: { data: unknown }) => void),
  ): void {
    (this.listeners[type] as Array<typeof cb>).push(cb);
  }

  emitOpen(): void {
    for (const cb of this.listeners.open) cb();
  }

  emitMessage(env: Envelope): void {
    const data = JSON.stringify(env);
    for (const cb of this.listeners.message) cb({ data });
  }
}

class LiveDom implements DomProvider {
  constructor(private readonly doc: Document) {}

  getRoot(): Document {
    return this.doc;
  }
}

class FakeSelector implements ElementSelector {
  async select(goal: string, els: ElementDescriptor[]): Promise<SelectionResult> {
    const preferred =
      (goal.includes('进入') &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_ENTRY_ACTION_ID)) ||
      (goal.includes('标题') &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_TITLE_ACTION_ID)) ||
      ((goal.includes('正文') || goal.includes('内容')) &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_CONTENT_ACTION_ID)) ||
      ((goal.includes('标签') || goal.includes('话题')) &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_TAG_ACTION_ID)) ||
      ((goal.includes('提交') || goal.includes('发布')) &&
        els.find((el) => el.attributes['data-action-id'] === XHS_PUBLISH_SUBMIT_ACTION_ID)) ||
      els[0];

    return preferred
      ? { index: preferred.index, element: preferred, reason: 'picked_publish_target' }
      : { index: null, reason: 'none' };
  }
}

class FakeExecutor implements ActionExecutor {
  constructor(
    private readonly doc: Document,
    private readonly failActionIds: Set<string> = new Set(),
    private readonly skipSubmitPostId = false,
  ) {}

  execute(op: ActionRequest['op'], element: ElementDescriptor, value?: string): void {
    const actionId = element.attributes['data-action-id'] ?? '';
    if (this.failActionIds.has(actionId)) {
      throw new Error(`forced_failure:${actionId}`);
    }

    const node = this.doc.querySelector(`[data-action-id="${actionId}"]`);
    if (!node) return;

    if (op === 'click' && actionId === XHS_PUBLISH_ENTRY_ACTION_ID) {
      this.doc.body.setAttribute('data-page', 'publish');
    }

    if (op === 'input') {
      if (
        node instanceof this.doc.defaultView!.HTMLInputElement ||
        node instanceof this.doc.defaultView!.HTMLTextAreaElement
      ) {
        node.value = value ?? '';
      } else {
        node.textContent = value ?? '';
      }

      if (actionId === XHS_PUBLISH_TAG_ACTION_ID && value) {
        const tags = this.doc.getElementById('selected-tags');
        const chip = this.doc.createElement('span');
        chip.textContent = value;
        chip.setAttribute('data-tag', value);
        tags?.appendChild(chip);
      }
    }

    if (op === 'click' && actionId === XHS_PUBLISH_SUBMIT_ACTION_ID && !this.skipSubmitPostId) {
      this.doc.getElementById('publish-result')?.setAttribute('data-post-id', 'post_e2e_123');
    }
  }
}

function buildDom(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
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

function depsFor(doc: Document, executor: ActionExecutor) {
  return {
    dom: new LiveDom(doc),
    executor,
    selector: new FakeSelector(),
    cache: new AnchorCache(),
  };
}

async function connectClient(ws: FakeWebSocket): Promise<EdgeClient> {
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-1',
    runner: {
      run: async () => ({
        actionId: 'noop',
        ok: true,
        outcome: 'success',
        attempts: 1,
        reason: 'ok',
      }),
    },
    wsFactory: () => ws,
    idGen: (() => {
      const ids = ['hello-1', 'send-1', 'send-2'];
      let index = 0;
      return () => ids[index++] ?? `id-${index}`;
    })(),
    clock: () => 1,
    logger: () => {},
  });

  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  ws.emitMessage(makeEnvelope('welcome', 'hello-1', 1, { sessionId: 's1', serverVersion: 'v1' }));
  await connecting;
  ws.sent.length = 0;
  return client;
}

function publishPayload(): PublishRequestPayload {
  return {
    title: '标题',
    content: '正文',
    tags: ['tag1', 'tag2'],
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('publish e2e: success path replies publish.result with postId and request id', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const doc = buildDom(publishPageHtml());
  const executor = new FakeExecutor(doc);

  client.onPublishCommand((env) => {
    void (async () => {
      const result = await publishPost(depsFor(doc, executor), {}, env.payload);
      client.send('publish.result', result, env.id);
    })();
  });

  ws.emitMessage(makeEnvelope('publish.request', 'pub-success', 2, publishPayload()));
  await flushAsyncWork();

  assert.equal(ws.sent.length, 1);
  const sent = JSON.parse(ws.sent[0]) as Envelope<PublishResultPayload>;
  assert.equal(sent.type, 'publish.result');
  assert.equal(sent.id, 'pub-success');
  assert.equal(sent.payload.ok, true);
  assert.equal(sent.payload.postId, 'post_e2e_123');
});

test('publish e2e: failure path replies explicit step error and request id', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const doc = buildDom(publishPageHtml());
  const executor = new FakeExecutor(doc, new Set([XHS_PUBLISH_TITLE_ACTION_ID]));

  client.onPublishCommand((env) => {
    void (async () => {
      const result = await publishPost(depsFor(doc, executor), {}, env.payload);
      client.send('publish.result', result, env.id);
    })();
  });

  ws.emitMessage(makeEnvelope('publish.request', 'pub-fail', 2, publishPayload()));
  await flushAsyncWork();

  assert.equal(ws.sent.length, 1);
  const sent = JSON.parse(ws.sent[0]) as Envelope<PublishResultPayload>;
  assert.equal(sent.type, 'publish.result');
  assert.equal(sent.id, 'pub-fail');
  assert.equal(sent.payload.ok, false);
  assert.match(sent.payload.error ?? '', /^\[input_title\] /);
  assert.match(sent.payload.error ?? '', /forced_failure:note\.publish_title/);
});

test('publish e2e: exception path still replies unknown error and request id', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);

  client.onPublishCommand((env) => {
    void (async () => {
      let result: PublishResultPayload;
      try {
        throw new Error('boom');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: `[unknown] ${message}` };
      }
      client.send('publish.result', result, env.id);
    })();
  });

  ws.emitMessage(makeEnvelope('publish.request', 'pub-exception', 2, publishPayload()));
  await flushAsyncWork();

  assert.equal(ws.sent.length, 1);
  const sent = JSON.parse(ws.sent[0]) as Envelope<PublishResultPayload>;
  assert.equal(sent.type, 'publish.result');
  assert.equal(sent.id, 'pub-exception');
  assert.deepEqual(sent.payload, { ok: false, error: '[unknown] boom' });
});

test('publish approval request envelope can round-trip', () => {
  const env = makeEnvelope('publish.approval_request', 'apr-1', 2, {
    requestId: 'req-1',
    title: '标题',
    content: '正文',
    tags: ['tag1'],
    edgeId: 'edge-1',
  });
  assert.equal(env.type, 'publish.approval_request');
  assert.equal((env.payload as { requestId: string }).requestId, 'req-1');
});