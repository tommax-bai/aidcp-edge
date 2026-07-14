'use strict';

const DEFAULT_BROWSER_COLD_STANDBY_ENABLED = true;

/**
 * 待机门槛（change standby-covers-idle-waits：20min → 5min）。
 *
 * **红线：这个默认值在云端也有一份**（aidcp-cloud `src/comm/browser-standby.ts` 的
 * `DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS`），而下面 `shouldEnterColdStandby` 取的是**两者的较大值**。
 * 只改一端 **不生效且无任何报错**——只改云端时，边缘仍按自己这份旧门槛把提示拦下来。改门槛 MUST 两端同改。
 *
 * 为什么 5 分钟站得住：唤醒是**原地重开浏览器、不重启核心进程**（main.cjs 的 wakeColdStandby），成本约
 * 30–45s 的全局串行启动队列占用；一次待机的净收益 = 门槛 − 热身(90s)。盈亏平衡点约 2min10s，5 分钟留
 * 约 2.3 倍余量。再往下（如 3 分钟）余量过薄，不建议。
 */
const DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS = 5 * 60_000;

const DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS = 90_000;

/**
 * 最短持有时长（change standby-covers-idle-waits）：唤醒后至少保持浏览器开启这么久，才允许再次进入待机。
 *
 * 这是把「不要频繁开关浏览器」从**推断**变成**保证**的那道机械闸——门槛降到 5 分钟后，光靠「等待时长
 * 通常很长」来论证不抖动是不够的（配额窗口滑动会让等待在门槛附近来回）。有了它，「醒来干 30 秒又睡」
 * 在结构上就不可能发生。
 *
 * 排期外 / 时长满 / 冻结这几类等待都是小时级，本闸对它们无影响（一天仍只关一次、开一次）。
 */
const DEFAULT_BROWSER_COLD_STANDBY_MIN_HOLD_MS = 3 * 60_000;

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
    minHoldMs: parseNonNegativeMs(
      settings.browserColdStandbyMinHoldMs,
      env.AIDCP_BROWSER_COLD_STANDBY_MIN_HOLD_MS,
      DEFAULT_BROWSER_COLD_STANDBY_MIN_HOLD_MS,
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

/**
 * 判「此刻该不该进入冷待机」。
 *
 * @param lastWokenAt 上次唤醒完成的时刻（ms）；未唤醒过 / 未知 → 传 undefined（视作不受最短持有时长约束）。
 *        min_hold 被拦下时**调用方 MUST NOT 丢弃这条提示**，而应在持有时长满足后按最新提示重新判定
 *        （见 main.cjs 的 coldStandbyHoldTimer）——否则一次拦截就把该环境永久留在开启态。
 */
function shouldEnterColdStandby({ status = {}, flags = {}, hint, settings, now = Date.now(), lastWokenAt }) {
  const normalizedHint = normalizeBrowserStandbyHint(hint);
  const config = settings || normalizeColdStandbySettings();
  if (!config.enabled) return skip('disabled', normalizedHint);
  if (!normalizedHint) return skip('invalid_hint', normalizedHint);
  if (!normalizedHint.enabled) return skip('cloud_disabled', normalizedHint);
  if (!normalizedHint.eligible) return skip(normalizedHint.reason || 'ineligible', normalizedHint);

  const remainingMs = Math.max(0, normalizedHint.wakeAt - now);
  const effectiveMinWaitMs = Math.max(config.minWaitMs, normalizedHint.minWaitMs || 0);
  if (remainingMs < effectiveMinWaitMs) return skip('short_wait', normalizedHint);

  // 最短持有时长（抗抖动）：刚醒过来的环境不得立刻再次待机。holdRemainingMs 一并回传，
  // 供调用方排一个「持有满足后重新判定」的定时器——绝不能把提示丢掉。
  const minHoldMs = Math.max(0, config.minHoldMs || 0);
  if (minHoldMs > 0 && typeof lastWokenAt === 'number' && Number.isFinite(lastWokenAt)) {
    const heldMs = now - lastWokenAt;
    if (heldMs < minHoldMs) {
      return { ...skip('min_hold', normalizedHint), holdRemainingMs: Math.max(0, minHoldMs - heldMs) };
    }
  }

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

/** 同 parsePositiveMs，但接受 0（= 关闭最短持有时长这道闸）。 */
function parseNonNegativeMs(settingValue, envValue, fallback) {
  const fromEnv = Number(envValue);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return Math.floor(fromEnv);
  const fromSetting = Number(settingValue);
  if (Number.isFinite(fromSetting) && fromSetting >= 0) return Math.floor(fromSetting);
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
  DEFAULT_BROWSER_COLD_STANDBY_MIN_HOLD_MS,
  normalizeColdStandbySettings,
  normalizeBrowserStandbyHint,
  shouldEnterColdStandby,
};
