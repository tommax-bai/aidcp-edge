import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeClient, type CloudWebSocket } from '../../src/client/edge-client.js';
import { makeEnvelope, type Envelope, type PublishRequestPayload, type PublishResultPayload } from '../../src/comm/protocol.js';

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

test('edge-client: 收到 publish.request 触发 handler', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope<PublishRequestPayload>[] = [];
  client.onPublishCommand((env) => {
    calls.push(env);
  });

  ws.emitMessage(makeEnvelope('publish.request', 'pub-1', 2, publishPayload()));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'publish.request');
  assert.equal(calls[0].id, 'pub-1');
});

test('edge-client: publish 成功后回 send publish.result', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  client.onPublishCommand((env) => {
    const result: PublishResultPayload = { ok: true, postId: 'post-1' };
    client.send('publish.result', result, env.id);
  });

  ws.emitMessage(makeEnvelope('publish.request', 'pub-2', 2, publishPayload()));

  assert.equal(ws.sent.length, 1);
  const sent = JSON.parse(ws.sent[0]) as Envelope<PublishResultPayload>;
  assert.equal(sent.type, 'publish.result');
  assert.equal(sent.id, 'pub-2');
  assert.deepEqual(sent.payload, { ok: true, postId: 'post-1' });
});

test('edge-client: publish 失败后仍回 result', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  client.onPublishCommand((env) => {
    const result: PublishResultPayload = { ok: false, error: '[input_title] failed' };
    client.send('publish.result', result, env.id);
  });

  ws.emitMessage(makeEnvelope('publish.request', 'pub-3', 2, publishPayload()));

  const sent = JSON.parse(ws.sent[0]) as Envelope<PublishResultPayload>;
  assert.equal(sent.type, 'publish.result');
  assert.equal(sent.id, 'pub-3');
  assert.deepEqual(sent.payload, { ok: false, error: '[input_title] failed' });
});

test('edge-client: handler 抛异常时装配层仍可兜底回 result', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  client.onPublishCommand((env) => {
    try {
      throw new Error('boom');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      client.send('publish.result', { ok: false, error: `[unknown] ${message}` }, env.id);
    }
  });

  ws.emitMessage(makeEnvelope('publish.request', 'pub-4', 2, publishPayload()));

  const sent = JSON.parse(ws.sent[0]) as Envelope<PublishResultPayload>;
  assert.equal(sent.type, 'publish.result');
  assert.equal(sent.id, 'pub-4');
  assert.deepEqual(sent.payload, { ok: false, error: '[unknown] boom' });
});

test('edge-client: onPublishCommand 注销后不再触发', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  let calls = 0;
  const off = client.onPublishCommand(() => {
    calls++;
  });
  off();

  ws.emitMessage(makeEnvelope('publish.request', 'pub-5', 2, publishPayload()));

  assert.equal(calls, 0);
  assert.equal(ws.sent.length, 0);
});

test('edge-client: reportNoteContent 收到 note.ack 正常 resolve', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);

  const promise = client.reportNoteContent({
    noteId: 'test-note-1',
    title: '测试笔记',
    summary: '内容',
    author: '作者',
    likeCount: 100,
    collectCount: 50,
  });

  // 模拟云端回 note.ack
  const sent = JSON.parse(ws.sent[0]);
  ws.emitMessage(makeEnvelope('note.ack', sent.id, 2, { received: true }));

  const resp = await promise;
  assert.equal(resp.type, 'note.ack');
  assert.deepEqual(resp.payload, { received: true });
});

test('edge-client: browse.scroll 路由到 browseHandler', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('browse.scroll', 'cmd-1', 2, { reason: 'scroll' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'browse.scroll');
});

test('edge-client: note.open 路由到 browseHandler', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('note.open', 'cmd-2', 2, { index: 3, reason: 'open' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'note.open');
  assert.equal((calls[0].payload as any).index, 3);
});

test('edge-client: note.close 路由到 browseHandler', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('note.close', 'cmd-3', 2, { reason: 'close' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'note.close');
});

test('edge-client: 旧消息类型仍正常路由（向后兼容）', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('browse.next', 'cmd-4', 2, { reason: 'next' }));
  ws.emitMessage(makeEnvelope('session.end', 'cmd-5', 2, { reason: 'end' }));
  ws.emitMessage(makeEnvelope('search.execute', 'cmd-6', 2, { keyword: 'AI' }));

  assert.equal(calls.length, 3);
  assert.equal(calls[0].type, 'browse.next');
  assert.equal(calls[1].type, 'session.end');
  assert.equal(calls[2].type, 'search.execute');
});

// 回归：通知巡视（软中断离开流程）自身的命令 MUST 放行到 browseHandler。
// 历史 bug：入口路由白名单漏接 notification.*，命令在到达处理器前被静默丢弃，
// 导致巡视无回执 → 恢复链（excursion_resumer）永不收敛 → 浏览永挂 → 会话被看门狗杀。
// 与 cloud command-bridge 的 open_notifications/browse_notification_*/notification_back_home 映射一一对应。
const NOTIFICATION_EXCURSION_COMMANDS = [
  'notification.open',
  'notification.browse_comments',
  'notification.browse_likes',
  'notification.browse_follows',
  'notification.back_home',
] as const;

for (const type of NOTIFICATION_EXCURSION_COMMANDS) {
  test(`edge-client: ${type} 路由到 browseHandler（不得静默丢弃）`, async () => {
    const ws = new FakeWebSocket();
    const client = await connectClient(ws);
    const calls: Envelope[] = [];
    client.onBrowseCommand((env) => calls.push(env));

    ws.emitMessage(makeEnvelope(type, `cmd-${type}`, 2, { thinkMs: 0 }));

    assert.equal(calls.length, 1, `${type} 应被路由到 browseHandler 而非在入口丢弃`);
    assert.equal(calls[0].type, type);
  });
}