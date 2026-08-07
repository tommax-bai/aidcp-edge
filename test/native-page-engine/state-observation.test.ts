/**
 * 观察命令「问现状」（change add-state-observation-command，蓝图批 3）——边缘侧行为契约。
 *
 * 守护点：
 *   ① 应答按信封 id 关联回请求（state.observed 的 replyTo = 请求 envelope.id）；
 *   ② 两态诚实：读得出 ⇒ confirmed + 穷举面；读不出 ⇒ unconfirmed + 具名原因，
 *      MUST NOT 把「读不出来」伪装成任何具体面 / 任何身份（变异 4.2b 的落点）；
 *   ③ 纯读：整个应答路径只执行引擎 `page_probe` 一种命令（零导航 / 零输入 / 零滚动）；
 *   ④ 执行权不在会话手里（quiesce）时不碰引擎、如实 executor_busy；
 *   ⑤ 参数不完整 fail-closed 拒收（语法规则二），不伪造应答。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgeClient } from '../../src/client/edge-client.js';
import type { Envelope, MessageType, StateObservedPayload } from '../../src/comm/protocol.js';
import type { SelfIdentityResult } from '../../src/cdp/self-identity.js';
import { NativeBrowseSession } from '../../src/native-page-engine/browse-session.js';
import type { NativePageCommand, NativePageCommandExecution } from '../../src/native-page-engine/client.js';
import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

function envelope(type: MessageType, id: string, payload: Record<string, unknown>): Envelope {
  return { v: 2, type, id, ts: Date.now(), payload } as Envelope;
}

function probeValue(pageKind: string): Record<string, unknown> {
  return {
    targetId: 't1',
    origin: 'https://www.xiaohongshu.com',
    path: '/explore',
    readyState: 'complete',
    pageKind,
    signals: {
      feedCardCount: 3, noteDetailCount: 0, loginWallCount: 0, captchaSignalCount: 0,
      dialogCount: 0, profileSignalCount: 0, notificationSignalCount: 0,
      publishSignalCount: 0, errorSignalCount: 0, mainCount: 1,
    },
    notificationUnread: { state: 'clear', count: 0 },
  };
}

function stateHarness(options: {
  execute?: (ownerId: string, command: NativePageCommand) => Promise<NativePageCommandExecution>;
  readIdentity?: () => Promise<SelfIdentityResult>;
} = {}) {
  const executions: Array<{ ownerId: string; command: NativePageCommand; timeoutMs?: number }> = [];
  const sent: Array<{ type: string; payload: unknown; replyTo?: string }> = [];
  const logs: string[] = [];
  const runtime = {
    async execute(ownerId: string, command: NativePageCommand, timeoutMs?: number) {
      executions.push({ ownerId, command, timeoutMs });
      if (!options.execute) throw new Error('engine unavailable');
      return options.execute(ownerId, command);
    },
    async closeOwner() { /* noop */ },
  } as unknown as NativePageRuntime;
  const client = {
    reportActionCompleted() { /* noop */ },
    send(type: string, payload: unknown, replyTo?: string) { sent.push({ type, payload, replyTo }); },
  } as unknown as EdgeClient;
  const session = new NativeBrowseSession({
    runtime,
    client,
    startupId: 'startup-state-test',
    logger: (message) => logs.push(message),
    ...(options.readIdentity ? { readIdentity: options.readIdentity } : {}),
  });
  return { session, executions, sent, logs };
}

const okIdentity: SelfIdentityResult = {
  ok: true,
  identity: { accountId: 'acc-observed-1', displayName: '观察昵称', redId: null, source: 'in-place' },
};

test('state.read answers confirmed surface + identity, correlated by envelope id, and stays pure-read', async () => {
  const h = stateHarness({
    execute: async () => ({
      ok: true, effectPhase: 'confirmed', reasonCode: 'confirmed',
      output: { kind: 'page_probe', value: probeValue('search') },
    }),
    readIdentity: async () => okIdentity,
  });

  await h.session.onCloudCommand(envelope('state.read', 'req-state-1', { captureId: 'cap-1' }));

  assert.equal(h.sent.length, 1);
  const reply = h.sent[0]!;
  assert.equal(reply.type, 'state.observed');
  // ① 信封关联：应答必须回填请求 envelope.id，MUST NOT 靠事后回执顺带。
  assert.equal(reply.replyTo, 'req-state-1');
  const report = reply.payload as StateObservedPayload;
  assert.equal(report.captureId, 'cap-1');
  assert.deepEqual(report.surface, { outcome: 'confirmed', kind: 'search' });
  assert.deepEqual(report.identity, { outcome: 'confirmed', accountId: 'acc-observed-1', nickname: '观察昵称' });
  assert.equal(typeof report.observedAt, 'number');
  // ③ 纯读断言：应答路径只允许 page_probe 一种引擎命令。
  assert.deepEqual(h.executions.map((e) => e.command.kind), ['page_probe']);
});

test('unrecognized page kind is reported as unconfirmed, never disguised as a concrete surface', async () => {
  const h = stateHarness({
    execute: async () => ({
      ok: true, effectPhase: 'confirmed', reasonCode: 'confirmed',
      output: { kind: 'page_probe', value: probeValue('unknown') },
    }),
    readIdentity: async () => okIdentity,
  });

  await h.session.onCloudCommand(envelope('state.read', 'req-state-2', { captureId: 'cap-2' }));

  const report = h.sent[0]!.payload as StateObservedPayload;
  // ② 两态诚实：引擎归不进任何已知面 ⇒ unconfirmed + page_unrecognized（变异 4.2b：
  //    把这里伪装成任何具体面，本断言当场红）。
  assert.deepEqual(report.surface, { outcome: 'unconfirmed', reason: 'page_unrecognized' });
  // 身份维独立判定：面读不出不连坐身份。
  assert.equal(report.identity.outcome, 'confirmed');
});

test('probe failure is honest unconfirmed probe_failed; identity dimension stays independent', async () => {
  const h = stateHarness({
    execute: async () => { throw new Error('cdp gone'); },
    readIdentity: async () => okIdentity,
  });

  await h.session.onCloudCommand(envelope('state.read', 'req-state-3', { captureId: 'cap-3' }));

  const report = h.sent[0]!.payload as StateObservedPayload;
  assert.deepEqual(report.surface, { outcome: 'unconfirmed', reason: 'probe_failed' });
  assert.deepEqual(report.identity, { outcome: 'confirmed', accountId: 'acc-observed-1', nickname: '观察昵称' });
});

test('identity read failure is honest unconfirmed read_failed, never the handshake identity', async () => {
  const h = stateHarness({
    execute: async () => ({
      ok: true, effectPhase: 'confirmed', reasonCode: 'confirmed',
      output: { kind: 'page_probe', value: probeValue('home') },
    }),
    readIdentity: async () => ({ ok: false, reason: 'not logged in' }),
  });

  await h.session.onCloudCommand(envelope('state.read', 'req-state-4', { captureId: 'cap-4' }));

  const report = h.sent[0]!.payload as StateObservedPayload;
  assert.deepEqual(report.surface, { outcome: 'confirmed', kind: 'home' });
  assert.deepEqual(report.identity, { outcome: 'unconfirmed', reason: 'read_failed' });
});

test('quiesced session answers executor_busy on both dimensions without touching the engine', async () => {
  const h = stateHarness({
    execute: async () => ({
      ok: true, effectPhase: 'confirmed', reasonCode: 'confirmed',
      output: { kind: 'page_probe', value: probeValue('home') },
    }),
    readIdentity: async () => okIdentity,
  });
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('state.read', 'req-state-5', { captureId: 'cap-5' }));

  assert.equal(h.sent.length, 1, 'quiesce 期间仍必须按信封应答，绝不静默');
  const report = h.sent[0]!.payload as StateObservedPayload;
  // ④ 引擎 owner 位是单写位：观察 MUST NOT 抢占在跑任务的引擎会话。
  assert.deepEqual(report.surface, { outcome: 'unconfirmed', reason: 'executor_busy' });
  assert.deepEqual(report.identity, { outcome: 'unconfirmed', reason: 'executor_busy' });
  assert.deepEqual(h.executions, [], '读不到现场时一条引擎命令都不许发');
});

test('state.read without captureId is rejected fail-closed with no fabricated report', async () => {
  const h = stateHarness({
    execute: async () => ({
      ok: true, effectPhase: 'confirmed', reasonCode: 'confirmed',
      output: { kind: 'page_probe', value: probeValue('home') },
    }),
    readIdentity: async () => okIdentity,
  });

  await h.session.onCloudCommand(envelope('state.read', 'req-state-6', {}));

  // ⑤ 语法规则二：参数不完整 fail-closed 拒收，不伪造应答、不碰引擎。
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.executions, []);
  assert.ok(h.logs.some((line) => line.includes('state.read 缺 captureId')));
});
