import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeClient, type CloudWebSocket } from '../../src/client/edge-client.js';
import { makeEnvelope, type Envelope } from '../../src/comm/protocol.js';

/** 可控关闭的假 WS：close() 只标记、**不**自动 emit close（模拟 FIN 异步、需显式触发）。 */
class CtlWs implements CloudWebSocket {
  private readonly listeners = {
    open: [] as Array<() => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(ev: unknown) => void>,
    message: [] as Array<(ev: { data: unknown }) => void>,
  };
  closeCalled = false;

  send(): void {}
  close(): void {
    this.closeCalled = true; // 不自动 emit close
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
  emitClose(): void {
    for (const cb of this.listeners.close) cb();
  }
}

async function connect(ws: CtlWs): Promise<EdgeClient> {
  const client = new EdgeClient({
    url: 'ws://t',
    edgeId: 'e1',
    runner: { run: async () => ({ actionId: 'n', ok: true, outcome: 'success', attempts: 1, reason: 'ok' }) },
    wsFactory: () => ws,
    idGen: (() => {
      let i = 0;
      const ids = ['hello-1'];
      return () => ids[i++] ?? `id-${i}`;
    })(),
    clock: () => 1,
    logger: () => {},
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  ws.emitMessage(makeEnvelope('welcome', 'hello-1', 1, { sessionId: 's1', serverVersion: 'v1' }));
  await connecting;
  return client;
}

test('closeAndWait 等到 ws close 事件后才 resolve（诚实下线，BLOCKER①）', async () => {
  const ws = new CtlWs();
  const client = await connect(ws);
  let resolved = false;
  const p = client.closeAndWait(5_000).then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ws.closeCalled, true, '应已发起 ws.close()');
  assert.equal(resolved, false, 'close 事件未到前 MUST NOT resolve（否则关闭帧可能没刷上线 → 云端僵尸窗口）');
  ws.emitClose();
  await p;
  assert.equal(resolved, true, 'close 事件到达后应 resolve');
});

test('closeAndWait 在 close 迟迟不来时按超时 resolve（有界等待，不无限挂）', async () => {
  const ws = new CtlWs();
  const client = await connect(ws);
  const t0 = Date.now();
  await client.closeAndWait(30);
  const dt = Date.now() - t0;
  assert.equal(dt >= 20, true, '应等到接近超时');
  assert.equal(dt < 2_000, true, '不应无限等待');
});
