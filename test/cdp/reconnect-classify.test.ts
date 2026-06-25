import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient, type MinimalWebSocket } from '../../src/cdp/index.js';

/** 可编程假 WS（与 client.test.ts 同形，本文件自带以避免跨文件耦合）。 */
class FakeWs {
  closed = false;
  private handlers: Record<string, ((arg: never) => void)[]> = {};
  send(): void {}
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
  asWs(): MinimalWebSocket {
    return this as unknown as MinimalWebSocket;
  }
}

function seqFactory(list: FakeWs[]): () => MinimalWebSocket {
  let i = 0;
  return () => (list[i++] ?? new FakeWs()).asWs();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('终态快判=terminal → 立即发 cdp.unrecoverable，绝不进退避循环（不发 cdp.reconnecting）', async () => {
  const list = [new FakeWs(), new FakeWs()];
  let reconnecting = 0;
  let unrecoverable = 0;
  let classified = 0;
  const client = new CdpClient('ws://x', {
    wsFactory: seqFactory(list),
    reconnect: {
      sleepImpl: async () => undefined,
      rediscoverTarget: async () => 'ws://new',
      classify: async () => {
        classified++;
        return 'terminal';
      },
    },
  });
  const p = client.connect();
  list[0].emit('open', undefined);
  await p;
  client.on('cdp.reconnecting', () => reconnecting++);
  client.on('cdp.unrecoverable', () => unrecoverable++);

  list[0].emit('close', undefined); // 意外断线 → runReconnect
  await flush();
  await flush();

  assert.equal(classified, 1, '应做一次终态快判');
  assert.equal(reconnecting, 0, 'terminal 时绝不进退避循环、不发 cdp.reconnecting');
  assert.equal(unrecoverable, 1, '应立即发一次 cdp.unrecoverable');
});

test('终态快判=retry → 进退避循环（页面 target 仍在，可重连）', async () => {
  const list = [new FakeWs(), new FakeWs()];
  let reconnecting = 0;
  let reconnected = 0;
  const client = new CdpClient('ws://x', {
    wsFactory: seqFactory(list),
    reconnect: {
      sleepImpl: async () => undefined,
      rediscoverTarget: async () => 'ws://new',
      classify: async () => 'retry',
    },
  });
  const p = client.connect();
  list[0].emit('open', undefined);
  await p;
  client.on('cdp.reconnecting', () => reconnecting++);
  client.on('cdp.reconnected', () => reconnected++);

  list[0].emit('close', undefined); // 意外断线
  await flush();
  list[1].emit('open', undefined); // 第二条 ws 建连成功
  await flush();
  await flush();

  assert.equal(reconnecting >= 1, true, 'retry 时应进退避循环、发 cdp.reconnecting');
  assert.equal(reconnected, 1, '重连应成功');
});
