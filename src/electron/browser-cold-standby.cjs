'use strict';

const DEFAULT_BROWSER_COLD_STANDBY_ENABLED = true;
const DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS = 90_000;
const MIN_VALID_BROWSER_STANDBY_WAIT_MS = 1_000;
// 旧客户端会把当时的默认门槛固化进 settings.json；升级后必须丢弃，Cloud hint 才是唯一门槛权威。
const LEGACY_BROWSER_COLD_STANDBY_MIN_WAIT_SETTING = 'browserColdStandbyMinWaitMs';

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

function omitLegacyColdStandbyMinWaitSetting(input = {}) {
  const settings = input && typeof input === 'object' ? { ...input } : {};
  delete settings[LEGACY_BROWSER_COLD_STANDBY_MIN_WAIT_SETTING];
  return settings;
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
  if (minWaitMs < MIN_VALID_BROWSER_STANDBY_WAIT_MS) return null;
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

function classifyBrowserStandbyHintUpdate(input, state = {}) {
  const hint = normalizeBrowserStandbyHint(input);
  if (hint) return { action: 'apply', hint };
  if (!state.hasCachedHint) return { action: 'ignore', hint: null };
  if (state.active) return { action: 'retain_active', hint: null };
  if (state.pending) return { action: 'wake_pending', hint: null };
  return { action: 'clear_awake', hint: null };
}

/**
 * 判「此刻该不该进入冷待机」。
 *
 * **准入 MUST 只读当场可验证的事实**（change admit-browser-standby-on-live-facts）。曾经这里读两个
 * 由核心 stdout 中文日志推断出来的轴（`status.edge` / `status.session`）。会话轴的写入方是已退役的
 * 那套页面自动化路径——现役平台跑 Native 引擎、发的是结构化会话事件，外壳对其零处理分支，于是该轴
 * 自核心启动被写下那一次之后**再无任何人维护**：只会被各种失败路径单向改坏、永不复原。它一旦停在
 * 错值上，此后每一条提示都被拒，浏览器槽位被永久锁死，而拒绝这条路径当时还不留痕（真机实测：连续
 * 32 分钟、零证据）。
 *
 * 因此新增条款：**任何一个准入输入都必须在每个在产平台上有可证的写入方**，并由回归断言钉死
 * （见 test/electron/browser-cold-standby.test.ts 的写入方存在断言）。想把「浏览循环在不在跑」重新
 * 加回来的人请先回答：这个平台上谁写它、哪条测试证明它还在被写。
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
  // 仍在 Edge 复核 remaining，防止 hint 延迟到达或 min_hold 到点重判时，剩余等待已短于 Cloud 门槛。
  if (remainingMs < normalizedHint.minWaitMs) return skip('short_wait', normalizedHint);

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
  // 运营意图是本地事实（点了暂停 / 关闭就是暂停 / 关闭），取代原先那条「会话轴 ∈ running/resting」。
  if (flags.automationPaused || flags.automationIntent === 'paused' || flags.automationIntent === 'stopped') {
    return skip('automation_not_enabled', normalizedHint);
  }
  if (status.cloud !== 'connected') return skip('cloud_not_connected', normalizedHint);
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

/**
 * 连续拒绝的日志节流：首次一条、原因变化一条（计数复位到 1），此后每 N 次一条。
 *
 * 不能每次都写——提示每 60s 一跳，一个卡住的环境会把日志淹掉，反而看不见别的；也不能只写首次——
 * 那样「卡了 32 分钟」和「拒了一次」在日志里仍然长得一样，而这正是本 change 要消灭的那种等价。
 */
const STANDBY_REFUSAL_LOG_EVERY = 5;

/**
 * 连续拒绝记账（change admit-browser-standby-on-live-facts）。
 *
 * 纯函数：调用方持有上一次的记账值，这里只算下一个。**单次拒绝是正常运行的一部分**（刚醒来、
 * 任务在跑），**连续拒绝才意味着这个环境正在无限期占着一个浏览器槽位**——二者若在呈现与日志上
 * 长得一样，运营就永远认不出后者。
 */
function noteStandbyRefusal(previous, reason, now = Date.now()) {
  const named = typeof reason === 'string' && reason ? reason : 'unknown';
  if (previous && previous.reason === named && Number.isFinite(previous.count) && Number.isFinite(previous.since)) {
    return { reason: named, count: previous.count + 1, since: previous.since };
  }
  return { reason: named, count: 1, since: now };
}

/** 这一次拒绝要不要落日志（见 STANDBY_REFUSAL_LOG_EVERY 的理由）。 */
function shouldLogStandbyRefusal(streak) {
  if (!streak || !Number.isFinite(streak.count) || streak.count < 1) return false;
  return streak.count === 1 || streak.count % STANDBY_REFUSAL_LOG_EVERY === 0;
}

/**
 * 这一次判决要不要上报云端（change report-host-standby-decisions）。
 *
 * **与本地日志留痕共用同一套节流**（`shouldLogStandbyRefusal`，同一个 `STANDBY_REFUSAL_LOG_EVERY`）。
 * 两处各写一份常量会让「本地日志里有几条」与「云端收到几条」对不上，排障时制造互相矛盾的证据——
 * 那比没有证据更贵。
 *
 * **判决迁移不受节流约束**：由拒转让、由让转拒都是状态变化而非重复，必须立刻发；节流只压重复。
 *
 * @param previous 上一次**已上报**的 `{ verdict, reason }`；从未上报过传 null。
 */
function shouldReportStandbyDecision(previous, verdict, reason, streak) {
  if (!previous) return true;
  if (previous.verdict !== verdict) return true;   // 判决迁移：立即发
  if (previous.reason !== reason) return true;     // 换因：立即发（与记账的「换因即复位」同步）
  if (verdict !== 'refused') return false;         // 同因重复让位 = 没有新事实
  return shouldLogStandbyRefusal(streak);
}

/**
 * 组装一次让位判决的上报事实（change report-host-standby-decisions）。
 *
 * 纯函数、只产出**事实**：判决、具名原因、连续拒绝次数与首次时刻、所针对提示的标识、判决时刻。
 * MUST NOT 塞任何形如「云端应该怎么做」的字段——遥测一旦携带诉求，下一轮就会被读成协商。
 *
 * 提示标识取该提示的 `generatedAt`：没有它，云端分不清「拒的是刚推那条」与「拒的是三跳之前那条」，
 * 连续拒绝次数就无法归因。
 */
function standbyDecisionFact({ verdict, reason, streak, hint, envId, now = Date.now() }) {
  const refusing = verdict === 'refused';
  const count = refusing && streak && Number.isFinite(streak.count) ? streak.count : 0;
  const since = refusing && streak && Number.isFinite(streak.since) ? streak.since : null;
  const normalizedHint = normalizeBrowserStandbyHint(hint);
  return {
    verdict,
    reason: typeof reason === 'string' && reason ? reason : 'unknown',
    refusedCount: count,
    ...(since === null ? {} : { refusedSince: since }),
    hintGeneratedAt: normalizedHint ? normalizedHint.generatedAt : 0,
    decidedAt: now,
    ...(envId ? { envId } : {}),
  };
}

/**
 * 外壳 → 核心的中转消息类型（change report-host-standby-decisions）。
 *
 * **与核心侧的具名解析器共用同一个字面量**（src/client/core-lifecycle.ts 的
 * `STANDBY_DECISION_RELAY_TYPE`）。两处各写一个字符串的现形方式不是编译报错，是**静默不转发**：
 * 外壳日志显示已发送，云端什么都收不到。回归断言把两个常量钉在一起。
 */
const STANDBY_DECISION_RELAY_TYPE = 'lifecycle.standby_decision';

/** 把一次判决事实包成外壳 → 核心的中转消息。信封形状只在这里定义一次。 */
function standbyDecisionRelayMessage(fact) {
  return { type: STANDBY_DECISION_RELAY_TYPE, decision: fact };
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
  DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS,
  DEFAULT_BROWSER_COLD_STANDBY_MIN_HOLD_MS,
  MIN_VALID_BROWSER_STANDBY_WAIT_MS,
  STANDBY_REFUSAL_LOG_EVERY,
  noteStandbyRefusal,
  shouldLogStandbyRefusal,
  shouldReportStandbyDecision,
  standbyDecisionFact,
  standbyDecisionRelayMessage,
  STANDBY_DECISION_RELAY_TYPE,
  normalizeColdStandbySettings,
  omitLegacyColdStandbyMinWaitSetting,
  normalizeBrowserStandbyHint,
  classifyBrowserStandbyHintUpdate,
  shouldEnterColdStandby,
};
