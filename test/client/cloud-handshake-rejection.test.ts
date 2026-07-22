/**
 * 云端拒绝握手的诚实呈现（change risk-state-cross-process-integrity，task 9.1）。
 *
 * 「被拒」与「连不上」是两件不同的事，MUST 可区分：连不上重试有意义，被拒重试一万次答案不变。
 * 边缘 MUST 原样带出云端给的拒绝码与人话说明，MUST NOT 改写成通用「云端离线 / 连接失败」。
 *
 * 本用例只覆盖协议层的区分与原样透传；不新增消息类型、不动主动命令白名单
 * （拒绝走的仍是既有的 hello → error 应答形态，与 platform_mismatch / missing_account_id 同形）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudHandshakeRejectedError, EdgeClient, type CloudWebSocket } from '../../src/client/edge-client.js';
import { makeEnvelope, type Envelope } from '../../src/comm/protocol.js';
import { createRequire } from 'node:module';

// fleet.cjs 是外壳侧的纯 CommonJS 工具（无 .d.ts），用 require 取出被测纯函数。
const requireCjs = createRequire(import.meta.url);
const { isFailureShapedLine } = requireCjs('../../src/electron/fleet.cjs') as {
  isFailureShapedLine: (line: string) => boolean;
};

class FakeWebSocket implements CloudWebSocket {
  private readonly listeners = {
    open: [] as Array<() => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(ev: unknown) => void>,
    message: [] as Array<(ev: { data: unknown }) => void>,
  };

  send(): void {}
  close(): void {
    for (const cb of this.listeners.close) cb();
  }
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'close', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', cb: never): void {
    (this.listeners[type] as unknown[]).push(cb);
  }
  emitOpen(): void {
    for (const cb of this.listeners.open) cb();
  }
  emitMessage(env: Envelope): void {
    const data = JSON.stringify(env);
    for (const cb of this.listeners.message) cb({ data });
  }
}

async function handshakeWith(reply: Envelope): Promise<unknown> {
  const ws = new FakeWebSocket();
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-1',
    accountId: 'acc-1',
    runner: { run: async () => ({ actionId: 'noop', ok: true, outcome: 'success', attempts: 1, reason: 'ok' }) },
    wsFactory: () => ws,
    idGen: () => 'hello-1',
    clock: () => 1,
    logger: () => {},
  });
  const connecting = client.connect().then(
    () => null,
    (err: unknown) => err,
  );
  ws.emitOpen();
  await Promise.resolve();
  ws.emitMessage(reply);
  return connecting;
}

test('execution_target_mismatch：拒绝码与真实归属说明原样带出，绝不吞成通用连接失败', async () => {
  const message =
    '账号 acc-1 归属 ol 的自动化，本云端是 dev，拒绝派活。处理办法：把该边缘节点接到 ol 的云端。';
  const err = await handshakeWith(
    makeEnvelope('error', 'hello-1', 1, { code: 'execution_target_mismatch', message }),
  );
  assert.ok(err instanceof CloudHandshakeRejectedError, '被拒 MUST 是一个可区分的错误类型');
  assert.equal(err.code, 'execution_target_mismatch');
  assert.equal(err.detail, message, '说明 MUST 原样透传：真实归属 target 与处理办法都在里面');
  assert.match(err.message, /归属 ol/);
});

test('与既有 platform_mismatch 同形（不新增分支语义）', async () => {
  const err = await handshakeWith(
    makeEnvelope('error', 'hello-1', 1, { code: 'platform_mismatch', message: '平台不一致' }),
  );
  assert.ok(err instanceof CloudHandshakeRejectedError);
  assert.equal(err.code, 'platform_mismatch');
});

test('云端没给码 → 诚实回落 cloud_rejected，MUST NOT 冒充某个具体原因', async () => {
  const err = await handshakeWith(
    makeEnvelope('error', 'hello-1', 1, { code: '', message: '' } as never),
  );
  assert.ok(err instanceof CloudHandshakeRejectedError);
  assert.equal(err.code, 'cloud_rejected');
});

test('外壳把「云端拒绝」认作失败形状（否则界面显示的归因会是前一条无关行）', () => {
  assert.equal(isFailureShapedLine('[aidcp-edge] 云端拒绝本节点握手 [execution_target_mismatch]：账号归属 ol'), true);
  assert.equal(isFailureShapedLine('[aidcp-edge] 给不出浏览器槽位，排队中'), false, '良性行仍不算失败');
});
