import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const electronMainSource = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const standby = require('../../src/electron/browser-cold-standby.cjs') as {
  MIN_VALID_BROWSER_STANDBY_WAIT_MS: number;
  DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS: number;
  DEFAULT_BROWSER_COLD_STANDBY_MIN_HOLD_MS: number;
  normalizeColdStandbySettings: (settings?: Record<string, unknown>, env?: Record<string, string | undefined>) => {
    enabled: boolean; warmupMs: number; minHoldMs: number;
  };
  omitLegacyColdStandbyMinWaitSetting: (settings?: Record<string, unknown>) => Record<string, unknown>;
  normalizeBrowserStandbyHint: (input: unknown) => Record<string, unknown> | null;
  classifyBrowserStandbyHintUpdate: (
    input: unknown,
    state?: { active?: boolean; pending?: boolean; hasCachedHint?: boolean },
  ) => { action: 'apply' | 'retain_active' | 'wake_pending' | 'clear_awake' | 'ignore'; hint: Record<string, unknown> | null };
  shouldEnterColdStandby: (input: {
    status: Record<string, unknown>;
    flags: Record<string, unknown>;
    hint: unknown;
    settings: { enabled: boolean; warmupMs: number; minHoldMs?: number };
    now: number;
    lastWokenAt?: number;
  }) => { ok: boolean; reason: string; remainingMs?: number; warmupMs?: number; wakeDelayMs?: number; holdRemainingMs?: number };
  STANDBY_REFUSAL_LOG_EVERY: number;
  noteStandbyRefusal: (
    previous: { reason: string; count: number; since: number } | null,
    reason: string,
    now?: number,
  ) => { reason: string; count: number; since: number };
  shouldLogStandbyRefusal: (streak: { reason: string; count: number; since: number } | null) => boolean;
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

function status(overrides: Record<string, unknown> = {}) {
  return {
    edge: 'running',
    cloud: 'connected',
    session: 'resting',
    auth: 'logged in',
    overlayBlocked: false,
    ...overrides,
  };
}

function flags(overrides: Record<string, unknown> = {}) {
  return {
    hasChild: true,
    restartPending: false,
    pausePending: false,
    closePending: false,
    coreParked: false,
    removed: false,
    stopRequested: false,
    automationPaused: false,
    automationIntent: 'enabled',
    ...overrides,
  };
}

/** 取一段顶层函数体（到下一个顶层 `function ` 为止），用于结构性断言。 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `未找到函数 ${name}`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\nfunction ');
  return end === -1 ? rest : rest.slice(0, end);
}

test('browser-cold-standby: settings default enabled and can be disabled by env', () => {
  const defaults = standby.normalizeColdStandbySettings({}, {});
  assert.equal(defaults.enabled, true);
  assert.equal(Object.hasOwn(defaults, 'minWaitMs'), false);
  assert.equal(defaults.warmupMs, standby.DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS);

  const disabled = standby.normalizeColdStandbySettings({ browserColdStandbyEnabled: true }, {
    AIDCP_BROWSER_COLD_STANDBY: 'false',
  });
  assert.equal(disabled.enabled, false);
});

test('browser-cold-standby: eligible safe resting session enters standby with wake delay', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint(),
    settings: { enabled: true, warmupMs: 90_000 },
    now,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.remainingMs, 30 * 60_000);
  assert.equal(decision.warmupMs, 90_000);
  assert.equal(decision.wakeDelayMs, 30 * 60_000 - 90_000);
});

test('browser-cold-standby: disabled and unsafe states skip', () => {
  assert.equal(
    standby.shouldEnterColdStandby({
      status: status(),
      flags: flags(),
      hint: hint(),
      settings: { enabled: false, warmupMs: 90_000 },
      now,
    }).reason,
    'disabled',
  );
  assert.equal(
    standby.shouldEnterColdStandby({
      status: status({ overlayBlocked: true }),
      flags: flags(),
      hint: hint(),
      settings: { enabled: true, warmupMs: 90_000 },
      now,
    }).reason,
    'overlay_blocked',
  );
  assert.equal(
    standby.shouldEnterColdStandby({
      status: status(),
      flags: flags({ closePending: true }),
      hint: hint(),
      settings: { enabled: true, warmupMs: 90_000 },
      now,
    }).reason,
    'closePending',
  );
});

test('browser-cold-standby: malformed or short hints do not enter standby', () => {
  assert.equal(standby.normalizeBrowserStandbyHint({ ...hint(), reason: '' }), null);
  const missingThresholdHint = { ...hint(), minWaitMs: undefined };
  assert.equal(standby.normalizeBrowserStandbyHint(missingThresholdHint), null);
  assert.equal(
    standby.shouldEnterColdStandby({
      status: status(),
      flags: flags(),
      hint: missingThresholdHint,
      settings: { enabled: true, warmupMs: 90_000 },
      now,
    }).reason,
    'invalid_hint',
  );
  assert.equal(
    standby.shouldEnterColdStandby({
      status: status(),
      flags: flags(),
      hint: hint({ wakeAt: now + 5 * 60_000, waitMs: 5 * 60_000 }),
      settings: { enabled: true, warmupMs: 90_000 },
      now,
    }).reason,
    'short_wait',
  );
});

test('browser-cold-standby: non-positive or sub-second Cloud thresholds are invalid', () => {
  assert.equal(standby.MIN_VALID_BROWSER_STANDBY_WAIT_MS, 1_000);
  for (const minWaitMs of [0, 999]) {
    const invalid = hint({ minWaitMs });
    assert.equal(standby.normalizeBrowserStandbyHint(invalid), null);
    assert.equal(
      standby.shouldEnterColdStandby({
        status: status(),
        flags: flags(),
        hint: invalid,
        settings: { enabled: true, warmupMs: 90_000 },
        now,
      }).reason,
      'invalid_hint',
    );
  }
  assert.notEqual(standby.normalizeBrowserStandbyHint(hint({ minWaitMs: 1_000 })), null);
});

test('browser-cold-standby: invalid snapshot update revokes only a not-yet-active cycle', () => {
  assert.equal(standby.classifyBrowserStandbyHintUpdate(null, {}).action, 'ignore');
  assert.equal(standby.classifyBrowserStandbyHintUpdate(null, { hasCachedHint: true }).action, 'clear_awake');
  assert.equal(
    standby.classifyBrowserStandbyHintUpdate(null, { pending: true, hasCachedHint: true }).action,
    'wake_pending',
  );
  assert.equal(
    standby.classifyBrowserStandbyHintUpdate(null, { active: true, hasCachedHint: true }).action,
    'retain_active',
  );
  assert.equal(
    standby.classifyBrowserStandbyHintUpdate(null, { pending: true, hasCachedHint: false }).action,
    'ignore',
    'manual browser-close pending state has no Cloud hint and must not be auto-woken',
  );
  assert.equal(standby.classifyBrowserStandbyHintUpdate(hint(), { active: true }).action, 'apply');
});

// ─── change make-cloud-standby-threshold-authoritative ───────────────────────────────────

test('browser-cold-standby: 遗留本地 20 分钟与 Edge env 均不能覆盖 Cloud 5 分钟', () => {
  const loaded = standby.omitLegacyColdStandbyMinWaitSetting({
    browserColdStandbyEnabled: true,
    browserColdStandbyMinWaitMs: 20 * 60_000,
  });
  const cfg = standby.normalizeColdStandbySettings(loaded, {
    AIDCP_BROWSER_COLD_STANDBY_MIN_WAIT_MS: String(20 * 60_000),
  });
  assert.equal(Object.hasOwn(loaded, 'browserColdStandbyMinWaitMs'), false);
  assert.equal(Object.hasOwn(cfg, 'minWaitMs'), false);

  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ wakeAt: now + 5 * 60_000, waitMs: 5 * 60_000, minWaitMs: 5 * 60_000 }),
    settings: cfg,
    now,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.remainingMs, 5 * 60_000);
  assert.equal(decision.wakeDelayMs, 5 * 60_000 - 90_000);
});

test('browser-cold-standby: legacy threshold is omitted from load/readback and cannot re-enter through save', () => {
  const loaded = standby.omitLegacyColdStandbyMinWaitSetting({
    provider: 'self',
    browserColdStandbyMinWaitMs: 20 * 60_000,
  });
  const afterSavePatch = standby.omitLegacyColdStandbyMinWaitSetting({
    ...loaded,
    browserColdStandbyMinWaitMs: 60 * 60_000,
  });
  assert.deepEqual(loaded, { provider: 'self' });
  assert.deepEqual(afterSavePatch, { provider: 'self' });
  assert.doesNotMatch(electronMainSource, /browserColdStandbyMinWaitMs/);
  assert.match(electronMainSource, /settings = omitLegacyColdStandbyMinWaitSetting\(\{ \.\.\.DEFAULT_SETTINGS, \.\.\.parsed \}\)/);
  assert.match(electronMainSource, /const p = omitLegacyColdStandbyMinWaitSetting\(\{ \.\.\.\(patch \|\| \{\}\) \}\)/);
  assert.match(electronMainSource, /settings = omitLegacyColdStandbyMinWaitSetting\(\{ \.\.\.settings, \.\.\.p \}\)/);
});

test('browser-cold-standby: 当前剩余等待只按 Cloud 门槛复核', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ wakeAt: now + 8 * 60_000, waitMs: 8 * 60_000, minWaitMs: 20 * 60_000 }),
    settings: { enabled: true, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
    now,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'short_wait');
});

test('browser-cold-standby: 最短持有时长——刚醒来的环境不得立刻再次待机', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ minWaitMs: 5 * 60_000 }),
    settings: { enabled: true, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
    now,
    lastWokenAt: now - 30_000, // 30 秒前刚醒
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'min_hold');
  // 回传剩余持有时长，供调用方排一个「到点重新判定」的定时器 —— 绝不能把提示丢掉。
  assert.equal(decision.holdRemainingMs, 3 * 60_000 - 30_000);
});

test('browser-cold-standby: 持有时长满足后恢复判定（不抖动，但也不永远拒绝）', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ minWaitMs: 5 * 60_000 }),
    settings: { enabled: true, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
    now,
    lastWokenAt: now - 3 * 60_000, // 恰好满足
  });
  assert.equal(decision.ok, true);
});

test('browser-cold-standby: 从未唤醒过的环境不受最短持有时长约束', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ minWaitMs: 5 * 60_000 }),
    settings: { enabled: true, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
    now,
    // lastWokenAt 缺省
  });
  assert.equal(decision.ok, true);
});

test('browser-cold-standby: 冻结账号的回访提示（小时级 wakeAt）正常进入待机', () => {
  // 云端对「无恢复时刻」的阻塞赋回访 wakeAt（默认 6h）。边缘无需知道那不是恢复承诺——它只管到点醒来，
  // 云端届时重新评估。这条钉死：回访跨度必须能顺利过门槛闸。
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({
      reason: 'risk_state:frozen',
      waitMs: 6 * 3_600_000,
      wakeAt: now + 6 * 3_600_000,
      minWaitMs: 5 * 60_000,
    }),
    settings: { enabled: true, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
    now,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.remainingMs, 6 * 3_600_000);
});

test('browser-cold-standby: 排期外提示（source=session）与风控提示同等对待', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({
      reason: 'session:active_window',
      source: 'session',
      waitMs: 8 * 3_600_000,
      wakeAt: now + 8 * 3_600_000,
      minWaitMs: 5 * 60_000,
    }),
    settings: { enabled: true, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
    now,
  });
  assert.equal(decision.ok, true, 'session 来源必须被 normalizeBrowserStandbyHint 接受');
});

test('browser-cold-standby: 最短持有时长可关（设 0）', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ minWaitMs: 5 * 60_000 }),
    settings: { enabled: true, warmupMs: 90_000, minHoldMs: 0 },
    now,
    lastWokenAt: now - 1_000,
  });
  assert.equal(decision.ok, true);
});

// ── change admit-browser-standby-on-live-facts ──────────────────────────────────
// 真机（2026-08-05，dev 车队）：一个 Facebook 账号在小时浏览配额跑满后连续 32 分钟拒绝让位，
// 锁死两个浏览器槽位之一，界面与日志零痕迹。根因是准入读了一个**已无写入方**的日志推断轴。

test('browser-cold-standby: 陈旧的日志推断轴不再阻挡让位（本次故障的定向回归）', () => {
  // 现役平台跑 Native 引擎，写会话轴的那几句中文只有已退役的页面自动化路径会打印；该轴自核心
  // 启动被写下那一次之后再无人维护，只会被各种失败路径单向改坏。它绝不能再决定要不要让位。
  const decision = standby.shouldEnterColdStandby({
    status: status({ edge: 'idle', session: 'idle' }),
    flags: flags(),
    hint: hint(),
    settings: { enabled: true, warmupMs: 90_000 },
    now,
  });
  assert.equal(decision.ok, true, '两个推断轴都陈旧时仍必须让位');
  assert.equal(decision.wakeDelayMs, 30 * 60_000 - 90_000);
});

test('browser-cold-standby: 准入 MUST NOT 再读日志推断轴', () => {
  const source = readFileSync(new URL('../../src/electron/browser-cold-standby.cjs', import.meta.url), 'utf8');
  const body = functionBody(source, 'shouldEnterColdStandby');
  assert.equal(body.includes('status.session'), false, '准入不得再依赖会话轴');
  assert.equal(body.includes('status.edge'), false, '准入不得再依赖引擎轴');
});

test('browser-cold-standby: 运营意图（本地事实）取代会话轴拦住暂停/关闭的环境', () => {
  for (const [override, label] of [
    [{ automationPaused: true }, 'automationPaused'],
    [{ automationIntent: 'paused' }, 'intent=paused'],
    [{ automationIntent: 'stopped' }, 'intent=stopped'],
  ] as Array<[Record<string, unknown>, string]>) {
    const decision = standby.shouldEnterColdStandby({
      status: status(),
      flags: flags(override),
      hint: hint(),
      settings: { enabled: true, warmupMs: 90_000 },
      now,
    });
    assert.equal(decision.reason, 'automation_not_enabled', label);
  }
});

test('browser-cold-standby: 云端连接轴的每一个匹配串都仍有发射方', () => {
  // 本次事故的机械化教训：准入依赖的每一个标签都必须有活着的写入方。会话轴当年就是这么死的
  // ——匹配串还在，发射它的那条路径已经退役，于是标签静默冻结、闸门永久拒绝。
  // 这里钉住仍在准入里的那一个（云端连接轴）：匹配串必须能在核心侧源码里找到发射点。
  const connectedAt = electronMainSource.indexOf("next.cloud = 'connected'");
  assert.notEqual(connectedAt, -1, '未找到写入云端连接轴的那一处');
  const guardAt = electronMainSource.lastIndexOf('if (message.includes(', connectedAt);
  assert.notEqual(guardAt, -1, '未找到云端连接轴的匹配条件');
  const cloudBranch = electronMainSource.slice(guardAt, electronMainSource.indexOf('\n', guardAt));
  const literals = [...cloudBranch.matchAll(/message\.includes\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(literals.length >= 2, '未能从 main.cjs 取到云端连接轴的匹配串');
  const coreSources = [
    'src/main.ts',
    'src/client/edge-client.ts',
  ].map((p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')).join('\n');
  for (const literal of literals) {
    assert.ok(coreSources.includes(literal), `匹配串「${literal}」在核心侧已无发射方，准入不得再依赖它`);
  }
});

test('browser-cold-standby: 连续拒绝记账——单次与连续必须可分辨', () => {
  const first = standby.noteStandbyRefusal(null, 'task_lease_active', now);
  assert.deepEqual(first, { reason: 'task_lease_active', count: 1, since: now });
  const second = standby.noteStandbyRefusal(first, 'task_lease_active', now + 60_000);
  assert.deepEqual(second, { reason: 'task_lease_active', count: 2, since: now }, '同因累加且保留首次时刻');
  const changed = standby.noteStandbyRefusal(second, 'publish_inflight', now + 120_000);
  assert.deepEqual(changed, { reason: 'publish_inflight', count: 1, since: now + 120_000 }, '换原因即复位');
});

test('browser-cold-standby: 拒绝日志节流——首次一条，此后每 N 次一条', () => {
  const every = standby.STANDBY_REFUSAL_LOG_EVERY;
  assert.equal(standby.shouldLogStandbyRefusal({ reason: 'r', count: 1, since: now }), true);
  assert.equal(standby.shouldLogStandbyRefusal({ reason: 'r', count: 2, since: now }), false);
  assert.equal(standby.shouldLogStandbyRefusal({ reason: 'r', count: every, since: now }), true);
  assert.equal(standby.shouldLogStandbyRefusal(null), false);
});

test('browser-cold-standby: 待机被拒 MUST NOT 收敛运营意图（浏览器完好那一支什么都不许动）', () => {
  // 核心侧「有任务租约在跑，别把浏览器从任务底下抽走」是完全无害的拒绝，而它此前与「运营要求关闭
  // 但没关成」共用同一条无名回执，于是一个健康环境被写成暂停态：永久占槽、且被踢出等槽位队列。
  const body = functionBody(electronMainSource, 'onColdStandbyRefused');
  assert.equal(body.includes('automationIntent ='), false, '待机被拒不得改运营意图');
  assert.equal(body.includes('automationPaused ='), false, '待机被拒不得把环境标成暂停');
  assert.equal(body.includes("session: 'paused'"), false, '待机被拒不得落暂停态');
  assert.ok(body.includes('browserIntact'), '两支必须按浏览器是否被动过分开');
});

test('browser-cold-standby: 每一条本地拒绝都要留痕（不许静默 return）', () => {
  const body = functionBody(electronMainSource, 'applyBrowserStandbyHint');
  const refusalBlock = body.slice(body.indexOf('if (!decision.ok)'));
  assert.ok(refusalBlock.includes('noteColdStandbyRefusal('), '拒绝路径必须经过记账');
  const noteAt = refusalBlock.indexOf('noteColdStandbyRefusal(');
  const eligibleGuardAt = refusalBlock.indexOf('hint.eligible === false');
  assert.ok(eligibleGuardAt !== -1 && eligibleGuardAt < noteAt, '「云端说还有活干」不是拒绝，必须先复位再记账');
  assert.ok(refusalBlock.slice(noteAt).includes('refusalPatch(streak)'), '记账必须写进待机状态供界面呈现');
});
