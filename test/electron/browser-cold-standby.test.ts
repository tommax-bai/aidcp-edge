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
