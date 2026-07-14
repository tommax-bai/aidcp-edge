import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const standby = require('../../src/electron/browser-cold-standby.cjs') as {
  DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS: number;
  DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS: number;
  DEFAULT_BROWSER_COLD_STANDBY_MIN_HOLD_MS: number;
  normalizeColdStandbySettings: (settings?: Record<string, unknown>, env?: Record<string, string | undefined>) => {
    enabled: boolean; minWaitMs: number; warmupMs: number; minHoldMs: number;
  };
  normalizeBrowserStandbyHint: (input: unknown) => Record<string, unknown> | null;
  shouldEnterColdStandby: (input: {
    status: Record<string, unknown>;
    flags: Record<string, unknown>;
    hint: unknown;
    settings: { enabled: boolean; minWaitMs: number; warmupMs: number; minHoldMs?: number };
    now: number;
    lastWokenAt?: number;
  }) => { ok: boolean; reason: string; remainingMs?: number; warmupMs?: number; wakeDelayMs?: number; holdRemainingMs?: number };
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
    ...overrides,
  };
}

test('browser-cold-standby: settings default enabled and can be disabled by env', () => {
  const defaults = standby.normalizeColdStandbySettings({}, {});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.minWaitMs, standby.DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS);
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
    settings: { enabled: true, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
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
      settings: { enabled: false, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
      now,
    }).reason,
    'disabled',
  );
  assert.equal(
    standby.shouldEnterColdStandby({
      status: status({ overlayBlocked: true }),
      flags: flags(),
      hint: hint(),
      settings: { enabled: true, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
      now,
    }).reason,
    'overlay_blocked',
  );
  assert.equal(
    standby.shouldEnterColdStandby({
      status: status(),
      flags: flags({ closePending: true }),
      hint: hint(),
      settings: { enabled: true, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
      now,
    }).reason,
    'closePending',
  );
});

test('browser-cold-standby: malformed or short hints do not enter standby', () => {
  assert.equal(standby.normalizeBrowserStandbyHint({ ...hint(), reason: '' }), null);
  assert.equal(
    standby.shouldEnterColdStandby({
      status: status(),
      flags: flags(),
      hint: hint({ wakeAt: now + 5 * 60_000, waitMs: 5 * 60_000 }),
      settings: { enabled: true, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
      now,
    }).reason,
    'short_wait',
  );
});

// ─── change standby-covers-idle-waits ────────────────────────────────────────────────────

test('browser-cold-standby: 默认门槛 5 分钟，且 MUST 与云端那份逐字一致', () => {
  assert.equal(standby.DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS, 5 * 60_000);

  // **这是「只改一端不生效且无任何报错」那个陷阱的唯一机械防线。**
  // shouldEnterColdStandby 取的是 max(本地门槛, 云端提示里的门槛)：只把云端调到 5 分钟、边缘仍是 20 分钟时，
  // 边缘会静默按 20 分钟拦下所有 5–20 分钟的等待——改动完全不生效，却不会有任何报错或告警。
  // 云端那份由 aidcp-cloud 的 test/comm/browser-standby.test.ts 断言同为 5 分钟。
  const cfg = standby.normalizeColdStandbySettings({}, {});
  assert.equal(cfg.minWaitMs, 5 * 60_000);
});

test('browser-cold-standby: 5 分钟等待现在够格待机（旧门槛 20 分钟会拦下它）', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ wakeAt: now + 5 * 60_000, waitMs: 5 * 60_000, minWaitMs: 5 * 60_000 }),
    settings: { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
    now,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.remainingMs, 5 * 60_000);
  // 净收益 = 门槛 − 热身：让出约 3.5 分钟，成本约 40s 的全局串行启动队列占用。
  assert.equal(decision.wakeDelayMs, 5 * 60_000 - 90_000);
});

test('browser-cold-standby: 云端门槛更大时取较大值（两端取 max，这正是那个陷阱）', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ wakeAt: now + 8 * 60_000, waitMs: 8 * 60_000, minWaitMs: 20 * 60_000 }), // 云端仍是旧门槛
    settings: { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
    now,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'short_wait', '边缘取 max → 8 分钟仍够不上云端那份 20 分钟');
});

test('browser-cold-standby: 最短持有时长——刚醒来的环境不得立刻再次待机', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ minWaitMs: 5 * 60_000 }),
    settings: { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
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
    settings: { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
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
    settings: { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
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
    settings: { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
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
    settings: { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000, minHoldMs: 3 * 60_000 },
    now,
  });
  assert.equal(decision.ok, true, 'session 来源必须被 normalizeBrowserStandbyHint 接受');
});

test('browser-cold-standby: 最短持有时长可关（设 0）', () => {
  const decision = standby.shouldEnterColdStandby({
    status: status(),
    flags: flags(),
    hint: hint({ minWaitMs: 5 * 60_000 }),
    settings: { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000, minHoldMs: 0 },
    now,
    lastWokenAt: now - 1_000,
  });
  assert.equal(decision.ok, true);
});
