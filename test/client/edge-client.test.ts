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

test('edge-client: hello carries platform metadata without changing message type', async () => {
  const ws = new FakeWebSocket();
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-1',
    platform: 'xiaohongshu',
    app: 'xhs',
    capabilities: ['locating', 'cdp', 'like', 'browse'],
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
    idGen: () => 'hello-1',
    clock: () => 1,
    logger: () => {},
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();

  const sent = JSON.parse(ws.sent[0]) as Envelope;
  assert.equal(sent.type, 'hello');
  assert.deepEqual(sent.payload, {
    edgeId: 'edge-1',
    platform: 'xiaohongshu',
    app: 'xhs',
    capabilities: ['locating', 'cdp', 'like', 'browse'],
  });

  ws.emitMessage(makeEnvelope('welcome', 'hello-1', 1, { sessionId: 's1', serverVersion: 'v1' }));
  await connecting;
});

test('edge-client: hello carries optional account nickname for display enrichment', async () => {
  const ws = new FakeWebSocket();
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-1',
    platform: 'facebook',
    app: 'fb',
    capabilities: ['identity', 'overlay', 'comment'],
    accountId: '1234567890',
    accountNickname: 'Test User',
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
    idGen: () => 'hello-1',
    clock: () => 1,
    logger: () => {},
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();

  const sent = JSON.parse(ws.sent[0]) as Envelope;
  assert.equal(sent.type, 'hello');
  assert.deepEqual(sent.payload, {
    edgeId: 'edge-1',
    platform: 'facebook',
    app: 'fb',
    capabilities: ['identity', 'overlay', 'comment'],
    accountId: '1234567890',
    accountNickname: 'Test User',
  });

  ws.emitMessage(makeEnvelope('welcome', 'hello-1', 1, { sessionId: 's1', serverVersion: 'v1' }));
  await connecting;
});

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

// 回归：浏览闭环互动命令（点赞 / 收藏 / 关注 / 发评论）MUST 放行到 browseHandler。
// 历史 bug：入口路由白名单漏接 interaction.comment，云端 sendCommand action=comment 已发（飞书已审通过），
// 但命令在到达处理器前被静默丢弃 → 评论永不发出、无回执（实测 8 发 / 0 执行 / 0 回执）。
// 与 cloud command-bridge 的 comment→interaction.comment / like→interaction.like 映射一一对应（§2 第4处同步点）。
const INTERACTION_COMMANDS = [
  'interaction.like',
  'interaction.collect',
  'interaction.follow',
  'interaction.comment',
  // 评论点赞（AIDCP_COMMENT_LIKE）：2026-07-03 发现的同类存量缺口——cloud comment_like→
  // interaction.like_comment 已下发但白名单漏接、browse-session 处理分支永不可达；修复后锁死。
  'interaction.like_comment',
] as const;

for (const type of INTERACTION_COMMANDS) {
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

test('edge-client: group.join 路由到 browseHandler（Facebook 命令处理器），不得静默丢弃', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('group.join', 'cmd-group-join', 2, { groupUrl: 'https://www.facebook.com/groups/1' }));

  assert.equal(calls.length, 1, 'group.join 应被路由到 handler 而非在入口丢弃');
  assert.equal(calls[0].type, 'group.join');
});

test('edge-client: edge.task.acquire/release 路由到任务控制处理器', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onEdgeTaskCommand((env) => calls.push(env));
  ws.emitMessage(makeEnvelope('edge.task.acquire', 'task-acquire', 2, {
    taskId: 'task-1', kind: 'publish', priority: 'human', leaseMs: 60_000,
  }));
  ws.emitMessage(makeEnvelope('edge.task.release', 'task-release', 3, {
    taskId: 'task-1', outcome: 'completed',
  }));
  assert.deepEqual(calls.map((env) => env.type), ['edge.task.acquire', 'edge.task.release']);
});
// 回归：陪伴界面数据快照（ui.snapshot，cloud 主动推送）MUST 路由到 onUiSnapshot 处理器，
// 不得在入口静默丢弃（§2 第4处同步点；edge-companion-ui 8.1）。
test('edge-client: ui.snapshot 路由到 uiSnapshotHandler（不得静默丢弃）', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onUiSnapshot((env) => calls.push(env));

  ws.emitMessage(
    makeEnvelope('ui.snapshot', 'cmd-ui-snapshot', 2, {
      account: { id: 'acc-1', nickname: '晚风手作' },
      lastPublish: { title: '一篇笔记', at: 1730000000000 },
    }),
  );

  assert.equal(calls.length, 1, 'ui.snapshot 应被路由到 uiSnapshotHandler 而非在入口丢弃');
  assert.equal(calls[0].type, 'ui.snapshot');
  assert.equal((calls[0].payload as { account?: { nickname?: string } }).account?.nickname, '晚风手作');
});

test('edge-client: ui.snapshot 未注册处理器时不抛错（静默容忍）', async () => {
  const ws = new FakeWebSocket();
  await connectClient(ws);
  // 不注册 onUiSnapshot，直接推送——不应抛异常
  ws.emitMessage(makeEnvelope('ui.snapshot', 'cmd-ui-snapshot-2', 2, {}));
});

test('edge-client: captcha assist capture/click 路由到 captchaAssistHandler（不得静默丢弃）', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onCaptchaAssistCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('captcha.assist.capture', 'cap-1', 2, { incidentId: 'incident-1', reason: 'refresh' }));
  ws.emitMessage(
    makeEnvelope('captcha.assist.click', 'click-1', 2, {
      incidentId: 'incident-1',
      snapshotId: 'snap-1',
      points: [{ x: 0.25, y: 0.75 }],
    }),
  );

  assert.deepEqual(calls.map((env) => env.type), ['captcha.assist.capture', 'captcha.assist.click']);
});
