import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeClient, type CloudWebSocket } from '../../src/client/edge-client.js';
import { makeEnvelope, type Envelope } from '../../src/comm/protocol.js';

class ReconnectWs implements CloudWebSocket {
  private readonly listeners = {
    open: [] as Array<() => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(ev: unknown) => void>,
    message: [] as Array<(ev: { data: unknown }) => void>,
  };
  sent: string[] = [];
  closeCalled = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalled = true;
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

  emitClose(): void {
    for (const cb of this.listeners.close) cb();
  }

  emitMessage(env: Envelope): void {
    const data = JSON.stringify(env);
    for (const cb of this.listeners.message) cb({ data });
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeClient(sockets: ReconnectWs[], ids: string[]): EdgeClient {
  let idIndex = 0;
  return new EdgeClient({
    url: 'ws://cloud',
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
    wsFactory: () => {
      const ws = new ReconnectWs();
      sockets.push(ws);
      return ws;
    },
    idGen: () => ids[idIndex++] ?? `id-${idIndex}`,
    clock: () => 1,
    logger: () => {},
    reconnect: {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      hardCapMs: 10_000,
      sleepImpl: async () => {},
    },
  });
}

async function connectInitial(client: EdgeClient, sockets: ReconnectWs[], sessionId = 's1'): Promise<ReconnectWs> {
  const connecting = client.connect();
  const ws = sockets[0];
  assert.ok(ws, 'connect() 应同步创建第一条 WS');
  ws.emitOpen();
  await tick();
  const hello = JSON.parse(ws.sent[0]) as Envelope;
  assert.equal(hello.type, 'hello');
  ws.emitMessage(makeEnvelope('welcome', hello.id, 1, { sessionId, serverVersion: 'v1' }));
  await connecting;
  ws.sent.length = 0;
  return ws;
}

test('edge-client: 云端 WS 意外关闭后自动重连并重新 hello', async () => {
  const sockets: ReconnectWs[] = [];
  const client = makeClient(sockets, ['hello-1', 'hello-2']);
  const events: string[] = [];
  client.on('cloud.disconnected', () => events.push('disconnected'));
  client.on('cloud.reconnecting', () => events.push('reconnecting'));
  const reconnected = new Promise<void>((resolve) => {
    client.on('cloud.reconnected', () => {
      events.push('reconnected');
      resolve();
    });
  });

  const first = await connectInitial(client, sockets, 's1');
  first.emitClose();
  await tick();

  assert.equal(sockets.length, 2, '应创建第二条云端 WS 连接');
  const next = sockets[1];
  next.emitOpen();
  await tick();
  const hello = JSON.parse(next.sent[0]) as Envelope;
  assert.equal(hello.type, 'hello', '重连成功后必须重新 hello');
  next.emitMessage(makeEnvelope('welcome', hello.id, 2, { sessionId: 's2', serverVersion: 'v2' }));
  await reconnected;

  assert.equal(client.isConnected(), true);
  assert.equal(client.getSessionId(), 's2');
  assert.deepEqual(events, ['disconnected', 'reconnecting', 'reconnected']);
});

test('edge-client: 初次 hello 收到 error 时拒绝握手且不保留协商状态', async () => {
  const sockets: ReconnectWs[] = [];
  const client = makeClient(sockets, ['hello-error']);
  const connecting = client.connect();
  const ws = sockets[0];
  ws.emitOpen();
  await tick();
  const hello = JSON.parse(ws.sent[0]) as Envelope;
  ws.emitMessage(makeEnvelope('error', hello.id, 1, { code: 'handler_error', message: 'runtime not ready' }));
  await assert.rejects(connecting, /Cloud 握手失败 \[handler_error\]: runtime not ready/);
  assert.equal(client.isConnected(), false);
  assert.equal(client.getSessionId(), undefined);
  assert.equal(client.isInteractionInboxNegotiated(), false);
  assert.equal(ws.closeCalled, true);
});

test('edge-client: welcome 缺少 sessionId 时拒绝握手', async () => {
  const sockets: ReconnectWs[] = [];
  const client = makeClient(sockets, ['hello-invalid-welcome']);
  const connecting = client.connect();
  const ws = sockets[0];
  ws.emitOpen();
  await tick();
  const hello = JSON.parse(ws.sent[0]) as Envelope;
  ws.emitMessage(makeEnvelope('welcome', hello.id, 1, { sessionId: '', serverVersion: 'v1' }));
  await assert.rejects(connecting, /welcome 缺少有效 sessionId\/serverVersion/);
  assert.equal(client.isConnected(), false);
  assert.equal(client.getSessionId(), undefined);
  assert.equal(ws.closeCalled, true);
});

test('edge-client: 重连 hello error 不冒充成功并继续下一次有界重试', async () => {
  const sockets: ReconnectWs[] = [];
  const client = makeClient(sockets, ['hello-1', 'hello-error', 'hello-3']);
  let reconnectedCount = 0;
  const reconnected = new Promise<void>((resolve) => {
    client.on('cloud.reconnected', () => {
      reconnectedCount += 1;
      resolve();
    });
  });
  const first = await connectInitial(client, sockets, 's1');
  first.emitClose();
  await tick();

  const rejected = sockets[1];
  rejected.emitOpen();
  await tick();
  const rejectedHello = JSON.parse(rejected.sent[0]) as Envelope;
  rejected.emitMessage(makeEnvelope('error', rejectedHello.id, 2, {
    code: 'handler_error', message: 'runtime not ready',
  }));
  await tick();
  assert.equal(reconnectedCount, 0, 'error hello MUST NOT emit cloud.reconnected');
  assert.equal(client.getSessionId(), undefined);
  assert.equal(client.isInteractionInboxNegotiated(), false);

  const accepted = sockets[2];
  assert.ok(accepted, 'reconnect loop should create another socket after rejected hello');
  accepted.emitOpen();
  await tick();
  const acceptedHello = JSON.parse(accepted.sent[0]) as Envelope;
  accepted.emitMessage(makeEnvelope('welcome', acceptedHello.id, 3, { sessionId: 's3', serverVersion: 'v3' }));
  await reconnected;
  assert.equal(client.isConnected(), true);
  assert.equal(client.getSessionId(), 's3');
  assert.equal(reconnectedCount, 1);
});

test('edge-client: 断线时 pending 请求失败，重连后不重放旧请求', async () => {
  const sockets: ReconnectWs[] = [];
  const client = makeClient(sockets, ['hello-1', 'note-1', 'hello-2']);
  const first = await connectInitial(client, sockets, 's1');

  const pending = client.reportNoteContent({
    noteId: 'n1',
    title: 't',
    summary: 's',
    author: 'a',
    likeCount: 1,
    collectCount: 1,
  });
  const oldRequest = JSON.parse(first.sent[0]) as Envelope;
  assert.equal(oldRequest.type, 'note.content');

  first.emitClose();
  await assert.rejects(pending, /边-云 WS 已关闭/);
  await tick();

  const next = sockets[1];
  next.emitOpen();
  await tick();
  const afterReconnect = next.sent.map((line) => (JSON.parse(line) as Envelope).type);
  assert.deepEqual(afterReconnect, ['hello'], '新连接只应重新 hello，不应重放旧 note.content');
});

test('edge-client: 主动 close 不触发自动重连', async () => {
  const sockets: ReconnectWs[] = [];
  const client = makeClient(sockets, ['hello-1']);
  let reconnecting = 0;
  client.on('cloud.reconnecting', () => {
    reconnecting++;
  });
  const first = await connectInitial(client, sockets, 's1');

  client.close();
  first.emitClose();
  await tick();

  assert.equal(reconnecting, 0);
  assert.equal(sockets.length, 1, '主动 close 后不得创建新 WS');
  assert.equal(client.isConnected(), false);
});
