import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient, type MinimalWebSocket } from '../../src/cdp/index.js';

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
