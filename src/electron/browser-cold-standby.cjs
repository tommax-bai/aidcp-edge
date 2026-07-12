'use strict';

const DEFAULT_BROWSER_COLD_STANDBY_ENABLED = true;
const DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS = 20 * 60_000;
const DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS = 90_000;

function normalizeColdStandbySettings(settings = {}, env = process.env) {
  const settingEnabled = typeof settings.browserColdStandbyEnabled === 'boolean'
    ? settings.browserColdStandbyEnabled
    : DEFAULT_BROWSER_COLD_STANDBY_ENABLED;
  const envEnabled = parseBooleanOverride(env.AIDCP_BROWSER_COLD_STANDBY);
  return {
    enabled: envEnabled == null ? settingEnabled : envEnabled,
    minWaitMs: parsePositiveMs(
      settings.browserColdStandbyMinWaitMs,
      env.AIDCP_BROWSER_COLD_STANDBY_MIN_WAIT_MS,
      DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS,
    ),
    warmupMs: parsePositiveMs(
      settings.browserColdStandbyWarmupMs,
      env.AIDCP_BROWSER_COLD_STANDBY_WARMUP_MS,
      DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS,
    ),
  };
}

function normalizeBrowserStandbyHint(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.enabled !== 'boolean' || typeof input.eligible !== 'boolean') return null;
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return null;
  const source = input.source === 'risk' || input.source === 'session' ? input.source : null;
  if (!source) return null;
  const waitMs = nonNegativeInt(input.waitMs);
  const wakeAt = nonNegativeInt(input.wakeAt);
  const generatedAt = nonNegativeInt(input.generatedAt);
  const minWaitMs = nonNegativeInt(input.minWaitMs);
  const warmupMs = nonNegativeInt(input.warmupMs);
  if ([waitMs, wakeAt, generatedAt, minWaitMs, warmupMs].some((v) => v == null)) return null;
  return {
    enabled: input.enabled,
    eligible: input.eligible,
    reason,
    waitMs,
    wakeAt,
    generatedAt,
    source,
    minWaitMs,
    warmupMs,
  };
}

function shouldEnterColdStandby({ status = {}, flags = {}, hint, settings, now = Date.now() }) {
  const normalizedHint = normalizeBrowserStandbyHint(hint);
  const config = settings || normalizeColdStandbySettings();
  if (!config.enabled) return skip('disabled', normalizedHint);
  if (!normalizedHint) return skip('invalid_hint', normalizedHint);
  if (!normalizedHint.enabled) return skip('cloud_disabled', normalizedHint);
  if (!normalizedHint.eligible) return skip(normalizedHint.reason || 'ineligible', normalizedHint);

  const remainingMs = Math.max(0, normalizedHint.wakeAt - now);
  const effectiveMinWaitMs = Math.max(config.minWaitMs, normalizedHint.minWaitMs || 0);
  if (remainingMs < effectiveMinWaitMs) return skip('short_wait', normalizedHint);

  if (!flags.hasChild) return skip('no_child', normalizedHint);
  for (const flag of ['restartPending', 'pausePending', 'closePending', 'coreParked', 'removed', 'stopRequested']) {
    if (flags[flag]) return skip(flag, normalizedHint);
  }
  if (status.edge !== 'running') return skip('edge_not_running', normalizedHint);
  if (status.cloud !== 'connected') return skip('cloud_not_connected', normalizedHint);
  if (status.session !== 'running' && status.session !== 'resting') return skip('session_not_idle_safe', normalizedHint);
  if (status.overlayBlocked) return skip('overlay_blocked', normalizedHint);
  if (status.auth && status.auth !== 'logged in') return skip('auth_not_ready', normalizedHint);
  if (status.publish && status.publish.state === 'approved') return skip('publish_inflight', normalizedHint);

  const warmupMs = Math.max(0, Math.min(config.warmupMs, normalizedHint.warmupMs || config.warmupMs, remainingMs));
  return {
    ok: true,
    reason: 'ok',
    hint: normalizedHint,
    remainingMs,
    warmupMs,
    wakeDelayMs: Math.max(0, remainingMs - warmupMs),
  };
}

function skip(reason, hint) {
  return { ok: false, reason, hint: hint || null };
}

function parseBooleanOverride(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return null;
}

function parsePositiveMs(settingValue, envValue, fallback) {
  const fromEnv = Number(envValue);
  if (Number.isFinite(fromEnv) && fromEnv >= 1_000) return Math.floor(fromEnv);
  const fromSetting = Number(settingValue);
  if (Number.isFinite(fromSetting) && fromSetting >= 1_000) return Math.floor(fromSetting);
  return fallback;
}

function nonNegativeInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

module.exports = {
  DEFAULT_BROWSER_COLD_STANDBY_ENABLED,
  DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS,
  DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS,
  normalizeColdStandbySettings,
  normalizeBrowserStandbyHint,
  shouldEnterColdStandby,
};
