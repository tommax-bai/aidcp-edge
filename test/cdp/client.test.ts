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

test('输入控制命令超时后标记 control unavailable，禁止继续把在线 WS 当成可安全控制', async () => {
  const ws = new FakeWs();
  const events: unknown[] = [];
  const client = new CdpClient('ws://x', { timeoutMs: 1, wsFactory: () => ws.asWs() });
  const cp = client.connect();
  ws.emit('open', undefined);
  await cp;
  client.on('cdp.control_unavailable', (event) => events.push(event));

  await assert.rejects(client.send('Input.dispatchMouseEvent'), /CDP 命令超时/);
  assert.equal(client.isConnected(), true, 'transport 可以仍连着');
  assert.equal(client.isControlReady(), false, '但不得继续下发页面写命令');
  assert.equal(events.length, 1);
  const event = events[0] as { state: string; reason: string; recoveryId?: number; method?: string; durationMs?: number };
  assert.equal(event.state, 'unavailable');
  assert.equal(event.reason, 'input_timeout');
  assert.equal(event.method, 'Input.dispatchMouseEvent');
  assert.equal(typeof event.durationMs, 'number');
  assert.equal(typeof event.recoveryId, 'number');
});

test('连续慢输入在均收到成功响应后触发软重连并恢复控制', async () => {
  const list: FakeWs[] = [];
  const client = new CdpClient('ws://x', {
    wsFactory: seqFactory(list),
    slowInputMs: 1,
    slowInputStreak: 2,
    reconnect: { baseDelayMs: 1, maxDelayMs: 1, sleepImpl: () => Promise.resolve(), rediscoverTarget: async () => 'ws://new' },
  });
  await client.connect();
  let recovering = 0;
  let recovered = 0;
  let recoveryId: number | undefined;
  client.on('cdp.control_recovering', (event) => { recovering++; recoveryId = (event as { recoveryId?: number }).recoveryId; });
  client.on('cdp.control_recovered', (event) => { recovered++; assert.equal((event as { recoveryId?: number }).recoveryId, recoveryId); });

  for (let i = 0; i < 2; i++) {
    const pending = client.send('Input.dispatchMouseEvent');
    const frame = JSON.parse(list[0]!.sent.at(-1)!);
    await tick(2);
    list[0]!.reply({ id: frame.id, result: {} });
    await pending;
  }
  await tick();
  assert.equal(recovering, 1);
  assert.equal(recovered, 1);
  assert.equal(typeof recoveryId, 'number');
  assert.equal(client.isControlReady(), true);
  assert.ok(list.length >= 2, '软重连应建立新 CDP WebSocket');
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

// ---------------------------------------------------------------------------
// change browser-slot-scheduling：待机即释放、唤醒即重建
//
// 核心安全性质：浏览器被收起期间，任何页面命令都必须**响亮失败**——绝不静默假成功、也绝不
// 因为「连接对象还在」就以为还能用。重建则必须保住对象身份，否则十几个长期持有者全部拿到过期句柄。
// ---------------------------------------------------------------------------

test('detach(): 释放后页面命令响亮失败，且绝不触发重连（浏览器是我们自己收起来的）', async () => {
  const ws = new FakeWs();
  let reconnects = 0;
  const client = new CdpClient('ws://old', {
    wsFactory: () => ws.asWs(),
    reconnect: { rediscoverTarget: async () => { reconnects++; return 'ws://new'; } },
  });
  const p = client.connect();
  ws.emit('open', undefined);
  await p;

  client.detach();

  assert.equal(client.isDetached(), true);
  assert.equal(client.isControlReady(), false, '缺席的浏览器绝不报「可接管」');
  await assert.rejects(client.send('Runtime.evaluate'), CdpDisconnectedError, '页面命令必须响亮失败');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reconnects, 0, '主动释放绝不被当成掉线去重连（否则连接对象会被搞成 recovering 僵尸）');
});

test('reattach(): 保住实例身份 → 既有订阅者全程无感；并换掉重连配置（AdsPower 端口每次都变）', async () => {
  const first = new FakeWs();
  const second = new FakeWs();
  let made = 0;
  const client = new CdpClient('ws://gen1', {
    wsFactory: () => (made++ === 0 ? first.asWs() : second.asWs()),
    reconnect: { rediscoverTarget: async () => 'ws://gen1-target' },
  });
  const p = client.connect();
  first.emit('open', undefined);
  await p;

  // 长期存活的组件在构造时就挂上了订阅——重建绝不能让它们掉线。
  const recovered: unknown[] = [];
  client.on('cdp.control_recovered', (e) => recovered.push(e));

  client.detach();

  // 新一代浏览器：新的 wsUrl + 新的重连配置（旧的把首次的 host:port 焊在闭包里）。
  let rediscovered = 0;
  const reattached = client.reattach('ws://gen2', {
    rediscoverTarget: async () => { rediscovered++; return 'ws://gen2-target'; },
  });
  second.emit('open', undefined);
  await reattached;

  assert.equal(client.isDetached(), false);
  assert.equal(client.isControlReady(), true, '重建后可安全接管');
  assert.equal(recovered.length, 1, '重建发出 control_recovered → 既有订阅者自行重新同步（订阅未丢）');

  // 重建后真的用的是新一代的重连配置：断线时应去找 gen2 的 target。
  second.emit('close', undefined);
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(rediscovered >= 1, '断线走的是新一代重连配置，绝不拿旧端口去探活');
});

test('reattach() 失败 → 回到缺席态并抛出（绝不把半死的连接当就绪）', async () => {
  const ws = new FakeWs();
  const client = new CdpClient('ws://gen1', {
    wsFactory: () => {
      throw new Error('浏览器没起来');
    },
  });
  // 首连也失败，直接测重建路径的诚实性
  await assert.rejects(client.reattach('ws://gen2'), /浏览器没起来/);
  assert.equal(client.isDetached(), true, '失败后留在缺席态，可再次唤醒');
  assert.equal(client.isControlReady(), false);
  await assert.rejects(client.send('Runtime.evaluate'), CdpDisconnectedError);
  assert.equal(ws.sent.length, 0);
});
