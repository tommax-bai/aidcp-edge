/**
 * 会话启动失败的诚实性（change restore-xiaohongshu-native-session-honesty §2）
 *
 * 被守住的四件事，每一件都对应一次真实停摆（2026-07-29 起小红书一条命令都没执行过，
 * 而每一层都在说它在正常工作）：
 *   ① 失败必须**离开本进程**（云端不知道有过一次点火 ⇒ 没有任何看门狗会响）；
 *   ② 外壳运行态必须**离开「正常」**；
 *   ③ 分档必须写进回执，且**未识别原因 MUST NOT 折进已有失败名**；
 *   ④ 非结构性失败 MUST NOT 落终态，MUST 留**带上限**的自愈通道。
 *
 * 闸类断言一律喂**违规输入**：伪造的未知错误码、非 Error 抛出、被暂停时的自愈请求、
 * 超出上限的连续失败。只验恒真路径的断言等于没有闸（memory `gate-always-true-equals-gate-gone`）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgeClient } from '../../src/client/edge-client.js';
import {
  BROWSE_START_FAILURE_CLASS,
  BROWSE_START_UNRECOGNIZED_CODE,
  BrowseStartFailureReporter,
  NativeBrowseSession,
  classifyBrowseStartFailure,
  type BrowseStartFailureReport,
} from '../../src/native-page-engine/browse-session.js';
import type { NativePageCommand, NativePageCommandExecution } from '../../src/native-page-engine/client.js';
import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

function engineError(code: string, message = 'engine said no'): Error {
  return Object.assign(new Error(message), { code });
}

interface ReporterHarnessOptions {
  cloudReachable?: () => boolean;
  canSelfHeal?: () => boolean;
  restart?: () => Promise<void>;
  maxSelfHealRetries?: number;
}

function reporterHarness(options: ReporterHarnessOptions = {}) {
  const delivered: BrowseStartFailureReport[] = [];
  const stalls: string[] = [];
  const clears: number[] = [];
  const logs: string[] = [];
  const restarts: number[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const cloudReachable = options.cloudReachable ?? (() => true);
  const reporter = new BrowseStartFailureReporter({
    reportToCloud: (report) => {
      if (!cloudReachable()) return false;
      delivered.push(report);
      return true;
    },
    declareStalled: (reason) => stalls.push(reason),
    clearStalled: () => clears.push(clears.length + 1),
    logger: (line) => logs.push(line),
    restart: options.restart ?? (async () => { restarts.push(restarts.length + 1); }),
    canSelfHeal: options.canSelfHeal ?? (() => true),
    maxSelfHealRetries: options.maxSelfHealRetries,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      timers.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
  });
  /** 触发最近一次**未被取消**的自愈定时器。 */
  const fireSelfHeal = async (): Promise<void> => {
    const pending = timers.filter((t) => !t.cancelled).pop();
    assert.ok(pending, '期望存在一条已武装的自愈通道');
    pending.cancelled = true;
    pending.fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { reporter, delivered, stalls, clears, logs, restarts, timers, fireSelfHeal };
}

// ─────────────────────────────────────────────────────────────────────────────
// 分档（结构性 / 非结构性 / 没认出来）
// ─────────────────────────────────────────────────────────────────────────────

test('结构性集合与可恢复集合互斥且对引擎错误码全集穷尽', () => {
  const entries = Object.entries(BROWSE_START_FAILURE_CLASS);
  // 穷尽由 `Record<NativePageEngineErrorCode, …>` 在 typecheck 期钉住（漏一个码就编译不过）；
  // 这里钉住的是**分档本身的决定**：把一个新码判成结构性，等于宣布该环境永久判死，
  // 必须是一次显式的、要改这条断言才能通过的动作。
  const structural = entries.filter(([, cls]) => cls === 'structural').map(([code]) => code).sort();
  assert.deepEqual(structural, [
    'endpoint_not_loopback',
    'invalid_request',
    'unsupported_command',
    'unsupported_protocol',
  ]);
  for (const [code, cls] of entries) {
    assert.ok(cls === 'structural' || cls === 'recoverable', `${code} 落在两档之外`);
  }
});

test('门口拒收判结构性；端点不可达判非结构性', () => {
  // 这次真实停摆的那一条：引擎入口对非 Facebook 平台的会话超时准入不通过。
  const refused = classifyBrowseStartFailure(engineError('invalid_request', 'invalid session timeout'));
  assert.equal(refused.structural, true);
  assert.equal(refused.recognized, true);
  assert.equal(refused.code, 'invalid_request');

  const unreachable = classifyBrowseStartFailure(engineError('endpoint_unreachable'));
  assert.equal(unreachable.structural, false);
  assert.equal(unreachable.recognized, true);
  assert.equal(unreachable.code, 'endpoint_unreachable');
});

test('没认出来的原因以自己的名字露出，且绝不被判成结构性', () => {
  // 违规输入①：一个分档表里根本没有的码（引擎将来新增、或别的层抛上来的）。
  const unknown = classifyBrowseStartFailure(engineError('quantum_flux_failure', 'boom'));
  assert.equal(unknown.recognized, false);
  assert.equal(unknown.code, BROWSE_START_UNRECOGNIZED_CODE);
  assert.equal(unknown.structural, false, '未识别原因被判成结构性 = 把可恢复失败传成终局判决');
  assert.match(unknown.detail, /quantum_flux_failure/, '原码必须原样带进现场，不得丢失');

  // 违规输入②：连 Error 都不是（引擎客户端之外的抛出）。
  const nonError = classifyBrowseStartFailure('just a string');
  assert.equal(nonError.recognized, false);
  assert.equal(nonError.structural, false);

  // 违规输入③：原型链上的属性名不得被当成命中（`toString` 在任何对象上都「有」）。
  const prototypePollution = classifyBrowseStartFailure(engineError('toString'));
  assert.equal(prototypePollution.recognized, false);
  assert.equal(prototypePollution.structural, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ① 结构性失败：上报 + 姿态翻转 + 回执标结构性 + 一次都不重试
// ─────────────────────────────────────────────────────────────────────────────

test('结构性启动失败：上报云端、外壳姿态离开「正常」、回执写清重来也不会变、不排自愈', () => {
  const h = reporterHarness();
  const report = h.reporter.report(engineError('invalid_request', 'invalid session timeout'), 'first_start');

  // ① 失败离开了本进程
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0]?.code, 'browse_start_refused:invalid_request');
  // ② 外壳运行态离开「正常」（走既有的运行姿态通道；reason 里带得出是哪一档）
  assert.deepEqual(h.stalls, ['browse_start_refused:invalid_request']);
  // ③ 回执标结构性并说明为什么重来也没用
  assert.equal(report.verdict.structural, true);
  assert.match(report.message, /结构性失败/);
  assert.match(report.message, /原样重来必然得到同一结果/);
  assert.match(report.message, /invalid session timeout/, '现场原文必须带上，否则排障拿不到引擎原话');
  // ④ 结构性一次都不重试：重试只会原样再撞同一堵墙，还多一次页面动作
  assert.equal(report.selfHealArmed, false);
  assert.equal(h.reporter.selfHealArmed, false);
  assert.equal(h.timers.filter((t) => !t.cancelled).length, 0);
});

test('结构性启动失败：巡视仍武装（首扫抛出后周期观测照常起拍）', async () => {
  const runtime = {
    async execute(_ownerId: string, _command: NativePageCommand): Promise<NativePageCommandExecution> {
      throw engineError('invalid_request', 'invalid session timeout');
    },
    async closeOwner() { /* noop */ },
  } as unknown as NativePageRuntime;
  const client = {
    reportActionCompleted() { /* noop */ },
    reportPageCards() { /* noop */ },
    reportNoteDetail() { /* noop */ },
    send() { /* noop */ },
  } as unknown as EdgeClient;
  const session = new NativeBrowseSession({
    runtime,
    client,
    startupId: 'startup-browse-start-failure',
    platform: 'xiaohongshu',
    probeIntervalMs: 60_000,
    logger: () => undefined,
  });

  await assert.rejects(() => session.start(), /invalid session timeout/);
  // 首扫失败恰恰是最需要周期观测的时刻，而四个启动点没有一个会再次触发它。
  assert.equal(session.observationStatus().running, true);
  session.stop('test_cleanup');
  assert.equal(session.observationStatus().running, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 非结构性失败：不落终态 + 自愈有上限
// ─────────────────────────────────────────────────────────────────────────────

test('非结构性启动失败：不落终态，自愈通道武装且**有上限**', async () => {
  // 违规输入：每一次自愈都再失败一次。上限必须真的封顶，否则「有界自愈」只是措辞
  // ——一条无上限的自愈通道与静默是同一件事，只是噪音更大。
  const restarts: string[] = [];
  const h = reporterHarness({
    maxSelfHealRetries: 2,
    restart: async () => {
      restarts.push(`attempt-${restarts.length + 1}`);
      throw engineError('endpoint_unreachable');
    },
  });

  const first = h.reporter.report(engineError('endpoint_unreachable'), 'first_start');
  assert.equal(first.verdict.structural, false);
  assert.equal(first.selfHealArmed, true, '非结构性失败必须留自愈通道');
  assert.match(first.message, /未落终态/);
  assert.equal(h.stalls[0], 'browse_start_retrying:endpoint_unreachable:1/2');

  await h.fireSelfHeal();
  assert.equal(restarts.length, 1);
  assert.equal(h.delivered.length, 2, '每一次失败都要重新离开本进程');
  assert.equal(h.delivered.at(-1)?.selfHealArmed, true);
  assert.equal(h.stalls.at(-1), 'browse_start_retrying:endpoint_unreachable:2/2');

  await h.fireSelfHeal();
  assert.equal(restarts.length, 2);
  const exhausted = h.delivered.at(-1);
  assert.equal(exhausted?.selfHealArmed, false, '第 3 次失败必须撞上限，不得继续无限重试');
  assert.equal(h.timers.filter((t) => !t.cancelled).length, 0);
  // 用尽之后的措辞仍 MUST NOT 说成「做不到」——那是把一次可恢复失败讲成结构性。
  assert.match(exhausted!.message, /已用尽/);
  assert.match(exhausted!.message, /不是「做不到」/);
  assert.equal(h.stalls.at(-1), 'browse_start_unavailable:endpoint_unreachable:retries_exhausted');
  assert.equal(restarts.length, 2, '上限之外一次都不许再点火');
});

test('自愈准入不放行时不硬闯（暂停中绝不擅自把浏览拉起来）', async () => {
  const h = reporterHarness({ canSelfHeal: () => false });
  h.reporter.report(engineError('cdp_connect_failed'), 'automation_resumed');
  await h.fireSelfHeal();
  assert.equal(h.restarts.length, 0);
  assert.ok(h.logs.some((line) => line.includes('browse_start_self_heal_skipped')));
});

test('自愈成功后收回停摆声明，并把恢复预算还回去（预算只由失败消费）', async () => {
  const h = reporterHarness({ maxSelfHealRetries: 1 });
  h.reporter.report(engineError('engine_exited'), 'first_start');
  assert.equal(h.reporter.selfHealRetriesUsed, 1);

  await h.fireSelfHeal();
  assert.equal(h.restarts.length, 1);
  assert.equal(h.clears.length, 1, '恢复之后必须把外壳的停摆声明收回');
  assert.equal(h.reporter.selfHealRetriesUsed, 0);

  // 预算还回去了 ⇒ 下一次失败仍有一次有界自愈，而不是一撞就终局。
  const again = h.reporter.report(engineError('engine_exited'), 'standby_wake');
  assert.equal(again.selfHealArmed, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ 云端不可达：义务只是延后，不是解除
// ─────────────────────────────────────────────────────────────────────────────

test('云端连不上时上报被攒下，重连后补发（不解除上报义务）', () => {
  let reachable = false;
  const h = reporterHarness({ cloudReachable: () => reachable });

  h.reporter.report(engineError('invalid_request'), 'first_start');
  assert.equal(h.delivered.length, 0);
  assert.equal(h.reporter.pendingReportCount, 1, '送不出去 MUST NOT 丢弃');
  // 送不出去也照样翻姿态：外壳那条边与云端那条边互不替代。
  assert.equal(h.stalls.length, 1);

  reachable = true;
  h.reporter.flushPendingReports();
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0]?.code, 'browse_start_refused:invalid_request');
  assert.equal(h.reporter.pendingReportCount, 0);
});
