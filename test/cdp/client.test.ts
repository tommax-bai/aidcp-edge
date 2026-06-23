import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient, type MinimalWebSocket } from '../../src/cdp/index.js';
import { CdpDisconnectedError } from '../../src/cdp/client.js';

/** 可编程的假 WebSocket：记录发出的帧，允许手动注入 open/message */
class FakeWs {
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, ((arg: never) => void)[]> = {};

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit('close', undefined);
  }
  addEventListener(type: string, cb: (arg: never) => void): void {
    (this.handlers[type] ??= []).push(cb);
  }
  emit(type: string, arg: unknown): void {
    for (const cb of this.handlers[type] ?? []) (cb as (a: unknown) => void)(arg);
  }
  /** 模拟服务器回包 */
  reply(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }
  /** 作为 MinimalWebSocket 注入 */
  asWs(): MinimalWebSocket {
    return this as unknown as MinimalWebSocket;
  }
}

test('connect() 在 open 后 resolve', async () => {
  const ws = new FakeWs();
  const client = new CdpClient('ws://x', { wsFactory: () => ws.asWs() });
  const p = client.connect();
  ws.emit('open', undefined);
  await p;
  assert.equal(client.isConnected(), true);
});

test('send() 关联 id 并以 result resolve', async () => {
  const ws = new FakeWs();
  const client = new CdpClient('ws://x', { wsFactory: () => ws.asWs() });
  const cp = client.connect();
  ws.emit('open', undefined);
  await cp;

  const resP = client.send<{ ok: boolean }>('Runtime.evaluate', { expression: '1+1' });
  // 取出刚发出的帧，拿到 id 后回包
  const frame = JSON.parse(ws.sent[0]);
  assert.equal(frame.method, 'Runtime.evaluate');
  ws.reply({ id: frame.id, result: { ok: true } });
  const res = await resP;
  assert.deepEqual(res, { ok: true });
});

test('send() 在 CDP error 时 reject', async () => {
  const ws = new FakeWs();
  const client = new CdpClient('ws://x', { wsFactory: () => ws.asWs() });
  const cp = client.connect();
  ws.emit('open', undefined);
  await cp;

  const resP = client.send('DOM.bad');
  const frame = JSON.parse(ws.sent[0]);
  ws.reply({ id: frame.id, error: { code: -32000, message: 'boom' } });
  await assert.rejects(resP, /boom/);
});

test('事件被分发给监听者', async () => {
  const ws = new FakeWs();
  const client = new CdpClient('ws://x', { wsFactory: () => ws.asWs() });
  const cp = client.connect();
  ws.emit('open', undefined);
  await cp;

  let got: unknown = null;
  client.on('Page.loadEventFired', (p) => {
    got = p;
  });
  ws.reply({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
  assert.deepEqual(got, { timestamp: 1 });
});

test('未连接时 send() 直接 reject', async () => {
  const client = new CdpClient('ws://x', { wsFactory: () => new FakeWs().asWs() });
  await assert.rejects(client.send('Runtime.evaluate'), /未连接/);
});

// —— CDP 断线有界重连 ——

/** 工厂：每次 connect 发一个新 FakeWs，自动在下个 microtask 触发 open（模拟建连成功）。 */
function seqFactory(list: FakeWs[]): () => MinimalWebSocket {
  return () => {
    const w = new FakeWs();
    list.push(w);
    queueMicrotask(() => w.emit('open', undefined));
    return w.asWs();
  };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('未连接 send() 拒绝类型为 CdpDisconnectedError（区分业务失败）', async () => {
  const client = new CdpClient('ws://x', { wsFactory: () => new FakeWs().asWs() });
  await assert.rejects(client.send('X'), (e) => e instanceof CdpDisconnectedError);
});

test('断线时在途命令以 CdpDisconnectedError 失败（无重连配置）', async () => {
  const list: FakeWs[] = [];
  const client = new CdpClient('ws://x', { wsFactory: seqFactory(list) });
  await client.connect();
  const p = client.send('Runtime.evaluate', { expression: '1' }); // 在途，不回包
  list[0].emit('close', undefined);
  await assert.rejects(p, (e) => e instanceof CdpDisconnectedError);
});

test('CDP 意外断线 → 有界重连成功，发 cdp.reconnected', async () => {
  const list: FakeWs[] = [];
  let reconnected = 0;
  const client = new CdpClient('ws://x', {
    wsFactory: seqFactory(list),
    reconnect: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleepImpl: () => Promise.resolve(),
      rediscoverTarget: async () => 'ws://new',
    },
  });
  await client.connect();
  client.on('cdp.reconnected', () => {
    reconnected++;
  });
  assert.equal(list.length, 1);
  list[0].emit('close', undefined); // 模拟意外断线
  await tick();
  assert.equal(reconnected, 1, '应重连一次');
  assert.equal(client.isConnected(), true);
  assert.ok(list.length >= 2, '应建了新 ws');
});

test('CDP 断线 → 重连耗尽，发 cdp.unrecoverable 且 send 继续诚实拒绝', async () => {
  const list: FakeWs[] = [];
  let unrec = 0;
  const client = new CdpClient('ws://x', {
    wsFactory: seqFactory(list),
    reconnect: {
      maxAttempts: 2,
      baseDelayMs: 1,
      sleepImpl: () => Promise.resolve(),
      rediscoverTarget: async () => {
        throw new Error('no target');
      },
    },
  });
  await client.connect();
  client.on('cdp.unrecoverable', () => {
    unrec++;
  });
  list[0].emit('close', undefined);
  await tick();
  assert.equal(unrec, 1, '耗尽应发一次 unrecoverable');
  assert.equal(client.isConnected(), false);
  await assert.rejects(client.send('X'), (e) => e instanceof CdpDisconnectedError);
});

test('主动 close() 不触发重连', async () => {
  const list: FakeWs[] = [];
  let reconnecting = 0;
  const client = new CdpClient('ws://x', {
    wsFactory: seqFactory(list),
    reconnect: {
      baseDelayMs: 1,
      sleepImpl: () => Promise.resolve(),
      rediscoverTarget: async () => 'ws://new',
    },
  });
  await client.connect();
  client.on('cdp.reconnecting', () => {
    reconnecting++;
  });
  client.close(); // 主动关闭
  await tick();
  assert.equal(reconnecting, 0, '主动 close 不应触发重连');
  assert.equal(list.length, 1, '不应建新 ws');
});

test('重连退避进行中 close() → 抢占，不再建新 ws / 不重连', async () => {
  const list: FakeWs[] = [];
  let released: () => void = () => {};
  let reconnected = 0;
  const client = new CdpClient('ws://x', {
    wsFactory: seqFactory(list),
    reconnect: {
      baseDelayMs: 1,
      sleepImpl: () => new Promise<void>((r) => { released = r; }), // 可控 sleep
      rediscoverTarget: async () => 'ws://new',
    },
  });
  await client.connect();
  client.on('cdp.reconnected', () => {
    reconnected++;
  });
  list[0].emit('close', undefined); // 进入重连退避（卡在 sleep）
  await Promise.resolve();
  client.close(); // 退避中途主动关闭
  released(); // 释放 sleep → 退避循环检查 intentionalClose 后终止
  await tick();
  assert.equal(reconnected, 0, '主动 close 后不应重连成功');
  assert.equal(list.length, 1, '不应建新 ws');
});
