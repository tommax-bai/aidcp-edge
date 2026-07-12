import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const standby = require('../../src/electron/browser-cold-standby.cjs') as {
  DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS: number;
  DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS: number;
  normalizeColdStandbySettings: (settings?: Record<string, unknown>, env?: Record<string, string | undefined>) => {
    enabled: boolean; minWaitMs: number; warmupMs: number;
  };
  normalizeBrowserStandbyHint: (input: unknown) => Record<string, unknown> | null;
  shouldEnterColdStandby: (input: {
    status: Record<string, unknown>;
    flags: Record<string, unknown>;
    hint: unknown;
    settings: { enabled: boolean; minWaitMs: number; warmupMs: number };
    now: number;
  }) => { ok: boolean; reason: string; remainingMs?: number; warmupMs?: number; wakeDelayMs?: number };
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
