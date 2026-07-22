/**
 * 验收用例 AC-PUB-* — 发布人审授权契约（边缘侧）
 *
 * 判据由 change publish-approval-signal-to-database 重述：
 *   旧判据是「edge 与 cloud 读写同一个本机文件路径」——写方与执行侧一分进程即静默失效，
 *   它从来不是一个跨服务能成立的契约。新判据是「同一 `requestId` 的授权判定」，而该判定
 *   **完全在云端**完成（持久授权记录的活跃行 + 版本一致）。
 *
 * 因此 edge 侧只断言两件事：
 *   1) **生产路径无文件依赖**：`publish.request` 只是协议兼容墓碑，main 从不注册整页发布处理器，
 *      收到即诚实回 `handler_unavailable`；生产发布只执行云端逐条下发的 `publish.command` 原子。
 *   2) 本机开发夹具**必须显式启用**；未启用时立刻给出可区分拒因，
 *      绝不静默通过（未授权直发）、也绝不静默等到超时（把配置遗漏伪装成「没人点通过」）。
 *
 * 产品红线不变：未获授权时绝不静默发布。
 * 环境层级：离线 / 逻辑级（ws 与 fs 均为注入桩，不碰网络与磁盘）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPublishApprovalRequestId,
  waitForPublishApproval,
  type PublishApprovalSignal,
} from '../../src/publish/approval-gate.js';
import { EdgeClient, type CloudWebSocket } from '../../src/client/edge-client.js';
import { COMMAND_DIAGNOSTIC_PREFIX } from '../../src/client/command-diagnostics.js';
import { makeEnvelope, type Envelope } from '../../src/comm/protocol.js';

const signalFor = (id: string, approved: boolean): PublishApprovalSignal => ({
  requestId: id,
  approved,
  ts: 1700000000000,
  payload: { title: 'T', content: 'C', tags: ['a', 'b'] },
});

/** 开发夹具自测专用：绕过显式启用门。生产路径根本没有本闸的调用者，故这不是后门。 */
const devFixture = { forceEnabledForTest: true as const };

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

describe('AC-PUB 发布人审授权契约（edge）', () => {
  it('AC-PUB-01 生产路径无文件依赖：整页发布处理器未注册 → handler_unavailable，绝不静默执行', async () => {
    const ws = new FakeWebSocket();
    const logs: string[] = [];
    const client = new EdgeClient({
      url: 'ws://test',
      edgeId: 'edge-ac-pub',
      runner: { run: async () => ({ actionId: 'noop', ok: true, outcome: 'success', attempts: 1, reason: 'ok' }) },
      wsFactory: () => ws,
      idGen: () => 'hello-ac-pub',
      clock: () => 1,
      logger: (line) => logs.push(line),
    });
    const connecting = client.connect();
    ws.emitOpen();
    await Promise.resolve();
    ws.emitMessage(makeEnvelope('welcome', 'hello-ac-pub', 1, { sessionId: 's1', serverVersion: 'v1' }));
    await connecting;
    ws.sent.length = 0;
    logs.length = 0;

    // 生产装配（main）从不调用 onPublishCommand —— 这里刻意不注册，复现生产形态。
    ws.emitMessage(
      makeEnvelope('publish.request', 'pub-tombstone', 2, { title: 'T', content: 'C', tags: [], images: [] }),
    );

    const diagnostics = logs
      .filter((line) => line.startsWith(`${COMMAND_DIAGNOSTIC_PREFIX} `))
      .map((line) => JSON.parse(line.slice(COMMAND_DIAGNOSTIC_PREFIX.length + 1)) as Record<string, unknown>);
    const rejected = diagnostics.find((d) => d.stage === 'rejected');
    assert.equal(rejected?.type, 'publish.request', '整页发布信封必须被诚实拒绝');
    assert.equal(rejected?.reason, 'handler_unavailable');
    assert.equal(ws.sent.length, 0, '未注册处理器时不回任何发布结果（绝不假成功）');
  });

  it('AC-PUB-02 requestId 唯一且形如 edge-*', () => {
    const a = buildPublishApprovalRequestId(() => 1);
    const b = buildPublishApprovalRequestId(() => 1);
    assert.notEqual(a, b);
    assert.match(a, /^edge-/);
  });

  it('AC-PUB-03 开发夹具未显式启用 → 立即 approval_gate_disabled，不读文件、不等待、不放行', async () => {
    let reads = 0;
    let slept = 0;
    delete process.env.AIDCP_PUBLISH_APPROVAL_SIGNAL_DIR;
    delete process.env.AIDCP_DEV_PUBLISH;
    const res = await waitForPublishApproval({
      requestId: 'req-disabled',
      pollIntervalMs: 1,
      timeoutMs: 100,
      readSignal: async () => {
        reads += 1;
        return JSON.stringify(signalFor('req-disabled', true));
      },
      removeSignal: async () => {},
      sleep: async () => { slept += 1; },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'approval_gate_disabled');
    assert.equal(reads, 0, '未启用时绝不读取任何信号文件');
    assert.equal(slept, 0, '未启用时绝不静默等待到超时');
  });

  it('AC-PUB-04 目录 + 开发开关同时给出才启用夹具', async () => {
    process.env.AIDCP_PUBLISH_APPROVAL_SIGNAL_DIR = join(tmpdir(), 'aidcp-approve-test');
    process.env.AIDCP_DEV_PUBLISH = '1';
    try {
      const res = await waitForPublishApproval({
        requestId: 'req-enabled',
        pollIntervalMs: 1,
        timeoutMs: 100,
        readSignal: async () => JSON.stringify(signalFor('req-enabled', true)),
        removeSignal: async () => {},
      });
      assert.equal(res.ok, true);
      assert.equal(res.approved, true);
    } finally {
      delete process.env.AIDCP_PUBLISH_APPROVAL_SIGNAL_DIR;
      delete process.env.AIDCP_DEV_PUBLISH;
    }
    // 只给目录、不给开发开关 → 仍然不启用。
    process.env.AIDCP_PUBLISH_APPROVAL_SIGNAL_DIR = join(tmpdir(), 'aidcp-approve-test');
    try {
      const res = await waitForPublishApproval({
        requestId: 'req-half',
        pollIntervalMs: 1,
        timeoutMs: 100,
        readSignal: async () => JSON.stringify(signalFor('req-half', true)),
        removeSignal: async () => {},
      });
      assert.equal(res.reason, 'approval_gate_disabled');
    } finally {
      delete process.env.AIDCP_PUBLISH_APPROVAL_SIGNAL_DIR;
    }
  });

  it('AC-PUB-05 approved=false → 拒绝（绝不静默发布）', async () => {
    const id = 'req-no';
    const res = await waitForPublishApproval({
      ...devFixture,
      requestId: id,
      pollIntervalMs: 1,
      timeoutMs: 100,
      readSignal: async () => JSON.stringify(signalFor(id, false)),
      removeSignal: async () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'approval_rejected');
  });

  it('AC-PUB-06 requestId 不匹配的授权被拒（防串号误发）', async () => {
    const res = await waitForPublishApproval({
      ...devFixture,
      requestId: 'req-self',
      pollIntervalMs: 1,
      timeoutMs: 100,
      readSignal: async () => JSON.stringify(signalFor('req-other', true)),
      removeSignal: async () => {},
    });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /signal_request_id_mismatch/);
  });

  it('AC-PUB-07 无授权 → 超时返回（不阻塞、不误发）', async () => {
    let t = 0;
    const res = await waitForPublishApproval({
      ...devFixture,
      requestId: 'req-timeout',
      pollIntervalMs: 10,
      timeoutMs: 30,
      now: () => (t += 10),
      sleep: async () => {},
      readSignal: async () => {
        const e = new Error('missing') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'approval_timeout');
  });
});
