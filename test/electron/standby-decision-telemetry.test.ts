/**
 * 宿主层让位判决回执（change report-host-standby-decisions）——**三跳**回归。
 *
 * 为什么必须整条链一起测：判决在桌面外壳作出，而云端连接在核心子进程里，回执要走
 * 「外壳 → 核心 → 云端」三跳。中间那一跳是**逐类具名解析**、不是通配转发，
 * 漏配的表现是**静默不转发**：外壳日志显示已发送、云端什么都收不到，而两侧编译与各自用例全绿。
 * 只断言「外壳发出了」正好放过这条链唯一的静默失败点。
 *
 * 本文件把三跳的**真实现**串起来跑：
 *   ① 外壳产出事实 + 包中转信封（browser-cold-standby.cjs 的 standbyDecisionFact / RelayMessage）
 *   ② 核心具名解析（core-lifecycle.ts 的 parseStandbyDecisionRelay）
 *   ③ 核心发往云端（EdgeClient.reportStandbyDecision，对着假 WS 断真信封）
 * 外壳那侧的「哪些路径会调用①」由 main.cjs 源码断言钉住（该文件依赖 electron，进程内加载不了）。
 *
 * 环境层级：离线 / 逻辑级（无外部依赖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  parseStandbyDecisionRelay,
  STANDBY_DECISION_RELAY_TYPE,
} from '../../src/client/core-lifecycle.js';
import { EdgeClient, type CloudWebSocket } from '../../src/client/edge-client.js';
import { EDGE_BUILD_CAPABILITIES } from '../../src/client/build-capabilities.js';
import {
  HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY,
  makeEnvelope,
  type Envelope,
  type StandbyDecisionPayload,
} from '../../src/comm/protocol.js';

const require = createRequire(import.meta.url);
const electronMainSource = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const standby = require('../../src/electron/browser-cold-standby.cjs') as {
  STANDBY_REFUSAL_LOG_EVERY: number;
  STANDBY_DECISION_RELAY_TYPE: string;
  noteStandbyRefusal: (
    previous: { reason: string; count: number; since: number } | null,
    reason: string,
    now?: number,
  ) => { reason: string; count: number; since: number };
  shouldReportStandbyDecision: (
    previous: { verdict: string; reason: string } | null,
    verdict: string,
    reason: string,
    streak: { reason: string; count: number; since: number } | null,
  ) => boolean;
  standbyDecisionFact: (input: {
    verdict: string;
    reason: string;
    streak: { reason: string; count: number; since: number } | null;
    hint: unknown;
    envId?: string;
    now?: number;
  }) => Record<string, unknown>;
  standbyDecisionRelayMessage: (fact: unknown) => { type: string; decision: unknown };
  normalizeBrowserStandbyHint: (input: unknown) => Record<string, unknown> | null;
  shouldEnterColdStandby: (input: Record<string, unknown>) => { ok: boolean; reason: string };
};

const now = 1_700_000_000_000;

function hint(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    eligible: true,
    reason: 'view_quota:hour',
    waitMs: 30 * 60_000,
    wakeAt: now + 30 * 60_000,
    generatedAt: now,
    source: 'risk',
    minWaitMs: 20 * 60_000,
    warmupMs: 90_000,
    ...overrides,
  };
}

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

/** 建一条已握手的核心侧云端连接；`negotiated` 决定 welcome 里回不回该能力位。 */
async function connect(ws: FakeWebSocket, negotiated: boolean): Promise<EdgeClient> {
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-standby-1',
    accountId: 'acct-1',
    machineLabel: 'mac-1',
    runner: { run: async () => ({ actionId: 'noop', ok: true, outcome: 'success', attempts: 1, reason: 'ok' }) },
    wsFactory: () => ws,
    idGen: () => 'hello-1',
    clock: () => now,
    logger: () => {},
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  ws.emitMessage(makeEnvelope('welcome', 'hello-1', now, {
    sessionId: 's1',
    serverVersion: 'v1',
    ...(negotiated ? { capabilities: [HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY] } : {}),
  }));
  await connecting;
  ws.sent.length = 0;
  return client;
}

/** 走完整三跳：外壳事实 → 中转信封 → 核心具名解析 → 云端信封。返回云端收到的那些帧。 */
async function runThreeHops(
  input: { verdict: string; reason: string; streak: { reason: string; count: number; since: number } | null },
  options: { negotiated?: boolean } = {},
): Promise<Envelope[]> {
  const ws = new FakeWebSocket();
  const client = await connect(ws, options.negotiated ?? true);
  // ① 外壳
  const fact = standby.standbyDecisionFact({ ...input, hint: hint(), envId: 'env-7', now });
  const relayed = standby.standbyDecisionRelayMessage(fact);
  // ② 核心（具名解析；漏配这一段这里就会是 null，第三跳什么都发不出去）
  const parsed = parseStandbyDecisionRelay(relayed);
  if (parsed && client.supportsCapability(HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY)) {
    // ③ 云端
    client.reportStandbyDecision(parsed);
  }
  return ws.sent.map((raw) => JSON.parse(raw) as Envelope);
}

// ── 4.1 端到端三跳 ─────────────────────────────────────────────────────────────

test('standby-telemetry: 三跳全程——外壳判决 → 核心转发 → 云端收到且事实完整', async () => {
  const streak = { reason: 'publish_inflight', count: 3, since: now - 120_000 };
  const frames = await runThreeHops({ verdict: 'refused', reason: 'publish_inflight', streak });
  assert.equal(frames.length, 1, '云端必须恰好收到一条回执');
  assert.equal(frames[0].type, 'standby.decision');
  const payload = frames[0].payload as StandbyDecisionPayload;
  assert.deepEqual(payload, {
    verdict: 'refused',
    reason: 'publish_inflight',
    refusedCount: 3,
    refusedSince: now - 120_000,
    hintGeneratedAt: now,
    decidedAt: now,
    envId: 'env-7',
  }, '连续次数 / 首次时刻 / 提示标识 一个都不能在途中丢');
});

test('standby-telemetry: 让位判决同样端到端可见，且不带任何连续拒绝残留', async () => {
  const frames = await runThreeHops({ verdict: 'yielded', reason: 'ok', streak: null });
  const payload = frames[0].payload as StandbyDecisionPayload;
  assert.equal(payload.verdict, 'yielded');
  assert.equal(payload.refusedCount, 0);
  assert.equal(payload.refusedSince, undefined, '让位时不得携带上一段连续拒绝的首次时刻');
});

// ── 4.2 中间跳漏配的定向反例 ──────────────────────────────────────────────────

test('standby-telemetry: 核心侧解析分支缺失 ⇒ 端到端必须红（本链唯一的静默失败点）', async () => {
  // 模拟「main.ts 忘了加具名解析分支」：中转信封原样送到，但没有人认它。
  const ws = new FakeWebSocket();
  const client = await connect(ws, true);
  const fact = standby.standbyDecisionFact({
    verdict: 'refused', reason: 'min_hold', streak: { reason: 'min_hold', count: 1, since: now }, hint: hint(), now,
  });
  const relayed = standby.standbyDecisionRelayMessage(fact);
  // 这里刻意**不调用** parseStandbyDecisionRelay —— 等价于漏配那条分支。
  void relayed;
  void client;
  assert.equal(ws.sent.length, 0, '漏配中间跳时云端一条都收不到，因此端到端断言必须失败');
});

test('standby-telemetry: 核心的本地消息路由确实接了这条分支（解析器存在 ≠ 被调用）', () => {
  // 上一条测的是「解析器本身对不对」。这一条测的是「它有没有被挂上去」——
  // 两者都绿才排除本链的静默失败：一个写好却没人调用的解析器，表现与漏配完全相同。
  const coreSource = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
  const at = coreSource.indexOf("process.on('message'");
  assert.notEqual(at, -1, '未找到核心侧本地消息路由');
  const router = coreSource.slice(at, coreSource.indexOf('\n  });', at));
  assert.ok(router.includes('parseStandbyDecisionRelay('), '本地消息路由必须调用让位判决的具名解析器');
  assert.ok(router.includes('onStandbyDecision'), '解析出来之后必须真的派发出去');
  const forwarder = coreSource.slice(coreSource.indexOf('onStandbyDecision = '));
  assert.ok(
    forwarder.slice(0, forwarder.indexOf('\n  };')).includes('reportStandbyDecision('),
    '第三跳必须真的把它发往云端',
  );
});

test('standby-telemetry: 外壳与核心共用同一个中转消息类型（两处各写一份 = 静默不转发）', () => {
  assert.equal(standby.STANDBY_DECISION_RELAY_TYPE, STANDBY_DECISION_RELAY_TYPE);
  assert.equal(
    standby.standbyDecisionRelayMessage({}).type,
    STANDBY_DECISION_RELAY_TYPE,
    '外壳发的类型必须正是核心具名解析认的那个',
  );
});

test('standby-telemetry: 核心解析拒绝残缺载荷（MUST NOT 半填一条转发出去）', () => {
  const base = standby.standbyDecisionFact({
    verdict: 'refused', reason: 'min_hold', streak: { reason: 'min_hold', count: 2, since: now }, hint: hint(), now,
  });
  assert.notEqual(parseStandbyDecisionRelay({ type: STANDBY_DECISION_RELAY_TYPE, decision: base }), null);
  for (const broken of [
    { ...base, verdict: 'maybe' },
    { ...base, reason: '' },
    { ...base, refusedCount: -1 },
    { ...base, hintGeneratedAt: 'now' },
    { ...base, decidedAt: undefined },
  ]) {
    assert.equal(
      parseStandbyDecisionRelay({ type: STANDBY_DECISION_RELAY_TYPE, decision: broken }),
      null,
      `残缺载荷必须整条拒收：${JSON.stringify(broken)}`,
    );
  }
  assert.equal(parseStandbyDecisionRelay({ type: 'lifecycle.wake_denied', detail: 'x' }), null, '别的本地消息不得被误认');
});

// ── 4.3 节流与判决迁移 ────────────────────────────────────────────────────────

test('standby-telemetry: 同因连续拒绝按节流上报，不逐跳上报', () => {
  const every = standby.STANDBY_REFUSAL_LOG_EVERY;
  let streak: { reason: string; count: number; since: number } | null = null;
  let reported: { verdict: string; reason: string } | null = null;
  const sentAtCount: number[] = [];
  for (let i = 1; i <= every * 2; i += 1) {
    streak = standby.noteStandbyRefusal(streak, 'task_lease_active', now + i * 60_000);
    if (standby.shouldReportStandbyDecision(reported, 'refused', 'task_lease_active', streak)) {
      reported = { verdict: 'refused', reason: 'task_lease_active' };
      sentAtCount.push(streak.count);
    }
  }
  assert.deepEqual(sentAtCount, [1, every, every * 2], '首次 + 每 N 次，绝不每一跳都发');
});

test('standby-telemetry: 上报节流与本地日志留痕共用同一套规则（两处 MUST NOT 各写一份）', () => {
  const source = readFileSync(new URL('../../src/electron/browser-cold-standby.cjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function shouldReportStandbyDecision'));
  const end = body.indexOf('\n}\n');
  assert.ok(
    body.slice(0, end).includes('shouldLogStandbyRefusal('),
    '上报节流必须复用日志节流那一个判定，否则「日志里有几条」与「云端收到几条」会对不上',
  );
});

test('standby-telemetry: 判决迁移立即上报，不受节流约束（拒 → 让 / 让 → 拒）', () => {
  const deepStreak = { reason: 'task_lease_active', count: 7, since: now }; // 7 不是节流点
  assert.equal(
    standby.shouldReportStandbyDecision({ verdict: 'refused', reason: 'task_lease_active' }, 'refused', 'task_lease_active', deepStreak),
    false,
    '前置条件：这个次数本来会被节流吃掉',
  );
  assert.equal(
    standby.shouldReportStandbyDecision({ verdict: 'refused', reason: 'task_lease_active' }, 'yielded', 'ok', null),
    true,
    '由拒转让 MUST 立即发',
  );
  assert.equal(
    standby.shouldReportStandbyDecision({ verdict: 'yielded', reason: 'ok' }, 'refused', 'min_hold', { reason: 'min_hold', count: 1, since: now }),
    true,
    '由让转拒 MUST 立即发',
  );
  // 同因迁移（合成取值）：**这一条才真正钉住迁移规则本身**。真实取值里让位恒 reason='ok'、
  // 与任何拒绝原因都不同，于是「换因立即发」那条会顺带把迁移覆盖掉——迁移这道闸就成了一条
  // 永远由别人代劳的闸，删掉它上面两条断言照样绿。闸恒被代劳 = 闸不在。
  assert.equal(
    standby.shouldReportStandbyDecision({ verdict: 'refused', reason: 'ok' }, 'yielded', 'ok', null),
    true,
    '判决变了就必须发，哪怕原因串一个字都没变',
  );
  assert.equal(
    standby.shouldReportStandbyDecision({ verdict: 'refused', reason: 'task_lease_active' }, 'refused', 'publish_inflight', { reason: 'publish_inflight', count: 1, since: now }),
    true,
    '换原因 MUST 立即发（与记账的「换因即复位」同步）',
  );
  assert.equal(standby.shouldReportStandbyDecision(null, 'refused', 'min_hold', { reason: 'min_hold', count: 1, since: now }), true, '首次必发');
});

// ── 4.4 结构断言：准入输入集合不因本 change 增加 ─────────────────────────────

test('standby-telemetry: 准入判据 MUST NOT 读任何回执状态', () => {
  const source = readFileSync(new URL('../../src/electron/browser-cold-standby.cjs', import.meta.url), 'utf8');
  const start = source.indexOf('function shouldEnterColdStandby');
  const body = source.slice(start, source.indexOf('\nfunction skip(', start));
  for (const forbidden of ['coldStandbyDecisionReported', 'standbyDecisionFact', 'shouldReportStandbyDecision', 'relay']) {
    assert.equal(body.includes(forbidden), false, `准入不得读回执相关状态：${forbidden}`);
  }
  // 准入的入参解构就是它的全部输入集合；本 change 一项都不许加。
  const signature = body.slice(body.indexOf('({'), body.indexOf('})') + 2);
  assert.equal(
    signature,
    '({ status = {}, flags = {}, hint, settings, now = Date.now(), lastWokenAt })',
    '准入输入集合必须逐字保持不变',
  );
});

test('standby-telemetry: 上报失败 MUST NOT 影响准入（判决与执行逐字不变）', () => {
  const body = functionBody(electronMainSource, 'reportColdStandbyDecision');
  assert.ok(body.includes('try {') && body.includes('catch'), '送不出去必须被吞在本函数内');
  for (const forbidden of ['throw', 'automationIntent =', 'automationPaused =', 'coldStandbyActive =', 'coldStandbyPending =']) {
    assert.equal(body.includes(forbidden), false, `回执路径不得改动任何准入/待机状态：${forbidden}`);
  }
  const apply = functionBody(electronMainSource, 'applyBrowserStandbyHint');
  assert.ok(apply.includes('reportColdStandbyDecision('), '拒绝与让位两条路径都要经过回执');
  const refusalAt = apply.indexOf('noteColdStandbyRefusal(');
  const reportAt = apply.indexOf('reportColdStandbyDecision(', refusalAt);
  assert.ok(refusalAt !== -1 && reportAt > refusalAt, '拒绝回执必须在记账**之后**发（次数才是这一次的真值）');
  assert.ok(
    apply.slice(apply.indexOf('clearColdStandbyRefusal(handle);\n  // 由拒转让')).includes("verdict: 'yielded'"),
    '让位路径必须发一条 yielded 回执',
  );
});

// ── 4.7 能力位缺席路径 ───────────────────────────────────────────────────────

test('standby-telemetry: 未协商能力位 ⇒ 不上报、不报错、让位照常', async () => {
  const frames = await runThreeHops(
    { verdict: 'refused', reason: 'min_hold', streak: { reason: 'min_hold', count: 1, since: now } },
    { negotiated: false },
  );
  assert.equal(frames.length, 0, '云端没协商该能力位时边缘一条都不发');
});

test('standby-telemetry: 本构建声明该能力位（构建能力，不进任何平台 driver 常量）', () => {
  assert.ok(
    (EDGE_BUILD_CAPABILITIES as readonly string[]).includes(HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY),
    '进 driver 常量会漏掉别的装配路径，那个平台就永远不上报',
  );
});

test('standby-telemetry: 未连接时上报只回 false，绝不抛（回执 MUST NOT 成为让位的前置条件）', () => {
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-offline',
    runner: { run: async () => ({ actionId: 'noop', ok: true, outcome: 'success', attempts: 1, reason: 'ok' }) },
    wsFactory: () => new FakeWebSocket(),
    clock: () => now,
    logger: () => {},
  });
  const payload: StandbyDecisionPayload = {
    verdict: 'refused', reason: 'min_hold', refusedCount: 1, hintGeneratedAt: now, decidedAt: now,
  };
  assert.equal(client.reportStandbyDecision(payload), false);
});

// ── 4.6 兼容红线：待机提示字段只增不减 ───────────────────────────────────────

test('standby-telemetry: 提示缺「是否够格让位」或门槛值 ⇒ 整条判无效（删字段会停掉全部让位）', () => {
  const full = hint();
  assert.notEqual(standby.normalizeBrowserStandbyHint(full), null, '基线：完整提示必须被接受');
  const { eligible: _eligible, ...withoutEligible } = full;
  assert.equal(standby.normalizeBrowserStandbyHint(withoutEligible), null, '缺 eligible ⇒ 整条无效');
  const { enabled: _enabled, ...withoutEnabled } = full;
  assert.equal(standby.normalizeBrowserStandbyHint(withoutEnabled), null, '缺 enabled ⇒ 整条无效');
  const { minWaitMs: _min, ...withoutMinWait } = full;
  assert.equal(standby.normalizeBrowserStandbyHint(withoutMinWait), null, '缺门槛值 ⇒ 整条无效');
  assert.equal(standby.normalizeBrowserStandbyHint({ ...full, minWaitMs: 999 }), null, '门槛值低于 1s ⇒ 整条无效');
  // 因此：云端侧任何字段删减都不是降级，而是让**所有在跑的客户端一起停止让位**。
  const decision = standby.shouldEnterColdStandby({
    status: { cloud: 'connected', auth: 'logged in', overlayBlocked: false },
    flags: {
      hasChild: true, restartPending: false, pausePending: false, closePending: false,
      coreParked: false, removed: false, stopRequested: false, automationPaused: false, automationIntent: 'enabled',
    },
    hint: withoutEligible,
    settings: { enabled: true, warmupMs: 90_000, minHoldMs: 0 },
    now,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'invalid_hint');
});

/**
 * 取源码里某个具名函数的正文（与 browser-cold-standby.test.ts 逐字同法：切到下一个顶层 `function`）。
 * 刻意不数括号——参数解构里的 `{}` 会把括号计数骗到零，得到的只有函数签名。
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `未找到函数 ${name}`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\nfunction ');
  return end === -1 ? rest : rest.slice(0, end);
}
