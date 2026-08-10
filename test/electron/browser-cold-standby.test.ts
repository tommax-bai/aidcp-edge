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
  DEFAULT_STALLED_BLOCKER_EVICTION_MS: number;
  MIN_VALID_STALLED_BLOCKER_EVICTION_MS: number;
  EVICTABLE_STALLED_BLOCKER_REASONS: readonly string[];
  isEvictableStalledBlocker: (reason: unknown) => boolean;
  noteStalledBlocker: (
    previous: { reason: string; since: number } | null,
    reason: unknown,
    now?: number,
  ) => { reason: string; since: number } | null;
  shouldEvictStalledBlocker: (input: {
    hint: unknown;
    flags?: Record<string, unknown>;
    status?: Record<string, unknown>;
    stall?: { reason: string; since: number } | null;
    settings?: Record<string, unknown>;
    now?: number;
  }) => { evict: boolean; reason: string; stalledMs?: number; since?: number };
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

// ─── 阻塞滞留终止（change release-browser-slot-on-stalled-blocker）────────────────────────
//
// 需人介入的阻塞（卡在弹窗上 / 没绑人设）此前可以**无限期**攥住一格浏览器执行槽：云端刻意不产出
// 可让位提示（对的——绝不能关掉运营正要去解验证码的浏览器），而红线只写了「不许关」、没写「人一直
// 不来怎么办」。这批测试守的是那个补上的上限，以及它**绝不能误伤**的四条护栏。

const EVICT_CFG = {
  enabled: true,
  warmupMs: 90_000,
  minHoldMs: 3 * 60_000,
  evictionEnabled: true,
  evictionMs: 15 * 60_000,
};
const OVERLAY = 'hard_blocker:overlay_pause';
const STALLED = { reason: OVERLAY, since: now - 20 * 60_000 };

function blockedHint(overrides: Record<string, unknown> = {}) {
  return hint({ eligible: false, reason: OVERLAY, waitMs: 0, wakeAt: now, ...overrides });
}

function evictInput(overrides: {
  hint?: unknown;
  flags?: Record<string, unknown>;
  status?: Record<string, unknown>;
  stall?: { reason: string; since: number } | null;
  settings?: Record<string, unknown>;
} = {}) {
  return {
    hint: overrides.hint ?? blockedHint(),
    status: { cloud: 'connected', ...(overrides.status || {}) },
    flags: { occupiesSlot: true, automationIntent: 'enabled', automationPaused: false, ...(overrides.flags || {}) },
    stall: overrides.stall === undefined ? STALLED : overrides.stall,
    settings: { ...EVICT_CFG, ...(overrides.settings || {}) },
    now,
  };
}

test('滞留终止: 四条护栏齐备且超门槛 → 终止并给出已滞留时长', () => {
  const v = standby.shouldEvictStalledBlocker(evictInput());
  assert.equal(v.evict, true);
  assert.equal(v.reason, OVERLAY);
  assert.equal(v.stalledMs, 20 * 60_000);
});

test('滞留终止: 四条护栏逐条证伪——只差一条就绝不终止', () => {
  const cases: [string, Parameters<typeof standby.shouldEvictStalledBlocker>[0], string][] = [
    // ① 原因不在白名单：全局停机 / 特性未开 / 副本陈旧都会走到这里，照关即整机清场。
    ['原因不可终止', evictInput({ hint: blockedHint({ reason: 'not_ready:dispatch_halted' }) }), 'not_evictable'],
    // ② 不占槽：关掉它腾不出任何位子，纯亏。
    ['不占执行槽', evictInput({ flags: { occupiesSlot: false } }), 'no_slot'],
    // ③ 运营已手动暂停/关闭：那是另一条路，不归本机制管。
    ['自动化未启用', evictInput({ flags: { automationIntent: 'paused' } }), 'automation_not_enabled'],
    // ④ 断连：收不到提示 ≠ 阻塞仍在。
    ['云端未连接', evictInput({ status: { cloud: 'disconnected' } }), 'cloud_not_connected'],
  ];
  for (const [label, input, expected] of cases) {
    const v = standby.shouldEvictStalledBlocker(input);
    assert.equal(v.evict, false, `${label}：绝不能终止`);
    assert.equal(v.reason, expected, `${label}：拒绝原因必须具名可诊断`);
  }
});

test('滞留终止: 全局性原因（停机 / 特性未开）与会自愈原因一律不在白名单内', () => {
  // 这四种此前与「人设未绑」共用裸 not_ready 一个名字。若照单终止：前两种每个环境都报，
  // 一次误配清空整机且无受益人；后两种副本追上就自愈，根本没有人可以去「处理」。
  for (const reason of [
    'not_ready:dispatch_halted',
    'not_ready:feature_off',
    'not_ready:persona_unavailable',
    'not_ready:config_stale',
    'not_ready:platform_no_browse',
    'not_ready:unclassified',
    'hard_blocker:risk_unclassified',
  ]) {
    assert.equal(standby.isEvictableStalledBlocker(reason), false, `${reason} 绝不可终止`);
  }
  assert.deepEqual([...standby.EVICTABLE_STALLED_BLOCKER_REASONS], [OVERLAY, 'not_ready:persona_unbound']);
});

test('滞留终止: 云端没见过的新原因默认不终止（白名单而非黑名单）', () => {
  // 黑名单对新增原因的默认后果是「关掉它」，白名单的默认后果是「多占一会儿槽位」。
  // 云端将来新增任何原因，在有人显式收录之前都必须落在安全的那一侧。
  const v = standby.shouldEvictStalledBlocker(
    evictInput({ hint: blockedHint({ reason: 'hard_blocker:some_future_reason' }), stall: null }),
  );
  assert.equal(v.evict, false);
  assert.equal(v.reason, 'not_evictable');
  assert.equal(standby.noteStalledBlocker(null, 'hard_blocker:some_future_reason', now), null, '未收录的原因连计时都不该起');
});

test('滞留终止: 云端改口说可以让位 → 不归本机制，且滞留计时归零', () => {
  const v = standby.shouldEvictStalledBlocker(evictInput({ hint: hint({ eligible: true }) }));
  assert.equal(v.evict, false);
  assert.equal(v.reason, 'eligible');
  assert.equal(standby.noteStalledBlocker(STALLED, 'view_quota:hour', now), null, '可让位的等待不是滞留');
});

test('滞留终止: 未到门槛不终止，且如实回报已滞留多久', () => {
  const v = standby.shouldEvictStalledBlocker(
    evictInput({ stall: { reason: OVERLAY, since: now - 14 * 60_000 } }),
  );
  assert.equal(v.evict, false);
  assert.equal(v.reason, 'stall_too_short');
  assert.equal(v.stalledMs, 14 * 60_000);
});

test('滞留计时: 换原因即归零，同原因持续累计', () => {
  const first = standby.noteStalledBlocker(null, OVERLAY, now);
  assert.deepEqual(first, { reason: OVERLAY, since: now });
  const same = standby.noteStalledBlocker(first, OVERLAY, now + 60_000);
  assert.equal(same?.since, now, '同一原因必须继续用最初那个起点，否则永远攒不满门槛');
  const changed = standby.noteStalledBlocker(same, 'not_ready:persona_unbound', now + 120_000);
  assert.equal(changed?.since, now + 120_000, '换了原因 = 情况变了，MUST NOT 继承上一段时长');
});

test('滞留计时: 断连期间不得推进——重连后必须从头计满门槛', () => {
  // 若只按「首次出现时刻」算差值，断连 20 分钟后重连的第一跳就越过门槛：
  // 那等于让断连时长替阻塞背书，凭空关掉一个环境。清零由 updateStatus 在断连时收口执行。
  const reconnected = standby.noteStalledBlocker(null, OVERLAY, now);
  const v = standby.shouldEvictStalledBlocker(
    evictInput({ stall: reconnected, settings: { evictionMs: 15 * 60_000 } }),
  );
  assert.equal(v.evict, false, '重连后第一跳绝不能立刻终止');
  assert.equal(v.reason, 'stall_too_short');
});

test('滞留终止: 记账与当前原因对不上时不拿别人的时长顶数', () => {
  const v = standby.shouldEvictStalledBlocker(
    evictInput({ stall: { reason: 'not_ready:persona_unbound', since: now - 60 * 60_000 } }),
  );
  assert.equal(v.evict, false);
  assert.equal(v.reason, 'no_stall');
});

test('滞留终止: 开关关闭 → 完全回到本 change 之前的行为', () => {
  const v = standby.shouldEvictStalledBlocker(evictInput({ settings: { evictionEnabled: false } }));
  assert.equal(v.evict, false);
  assert.equal(v.reason, 'disabled');
});

test('滞留终止: 门槛低于下限的配置一律回落默认（一两跳抖动不得关掉环境）', () => {
  const tooSmall = standby.normalizeColdStandbySettings({ stalledBlockerEvictionMs: 30_000 }, {}) as unknown as {
    evictionMs: number; evictionEnabled: boolean;
  };
  assert.equal(tooSmall.evictionMs, standby.DEFAULT_STALLED_BLOCKER_EVICTION_MS);
  assert.ok(
    standby.MIN_VALID_STALLED_BLOCKER_EVICTION_MS >= 5 * 60_000,
    '下限必须显著大于待机提示约 60s 的到达节拍',
  );
  const ok = standby.normalizeColdStandbySettings({ stalledBlockerEvictionMs: 30 * 60_000 }, {}) as unknown as {
    evictionMs: number;
  };
  assert.equal(ok.evictionMs, 30 * 60_000, '合法配置必须生效，MUST NOT 使用另一份内置门槛');
});

test('滞留终止: 环境变量可秒级回滚', () => {
  const off = standby.normalizeColdStandbySettings({}, { AIDCP_STALLED_BLOCKER_EVICTION: 'false' }) as unknown as {
    evictionEnabled: boolean;
  };
  assert.equal(off.evictionEnabled, false);
});

test('滞留终止: 判定必经每一跳提示，且排在冷待机判定之前', () => {
  // 挂在「云端说不该让位」那一支里必然漏：那支下面有若干条提前 return，漏掉的形态是
  // 某些原因下计时永远不归零、或永远不推进，两个方向都错。
  const body = functionBody(electronMainSource, 'applyBrowserStandbyHint');
  const evictAt = body.indexOf('evictStalledBlockerIfDue(');
  const standbyAt = body.indexOf('shouldEnterColdStandby(');
  assert.ok(evictAt !== -1, '提示应用路径必须调用滞留判定');
  assert.ok(evictAt < standbyAt, '滞留判定必须在冷待机判定之前，不能挂在某个分支里');
});

test('滞留终止: 占槽判据与槽位记账同源', () => {
  // 各写一份判据，漂移的现形方式是关掉一个本来就不占槽的环境——关了也腾不出位子，纯亏。
  assert.ok(
    functionBody(electronMainSource, 'occupiedSlots').includes('handleOccupiesBrowserSlot('),
    '槽位计数必须走同一个判据',
  );
  assert.ok(
    functionBody(electronMainSource, 'evictStalledBlockerIfDue').includes('handleOccupiesBrowserSlot('),
    '滞留终止必须走同一个判据',
  );
});

test('滞留终止: 复用运营关闭那条路径，但归因必须可分辨', () => {
  const body = functionBody(electronMainSource, 'evictStalledBlockerIfDue');
  assert.ok(body.includes('stopAutomation(handle)'), '必须复用既有关闭路径，不新造终止路径');
  assert.ok(body.includes('stalledEviction:'), '必须写下可分辨的系统终止归因，否则事后分不清是人关的还是系统关的');
  assert.equal(body.includes('queueStartEnv('), false, '终止是终态：绝不自动重启');
  assert.equal(body.includes('enqueueStartFlow('), false, '终止是终态：绝不进启动队列');
});

test('滞留终止: 断连清零与卡片清除都收口在状态出口上', () => {
  const body = functionBody(electronMainSource, 'updateStatus');
  assert.ok(body.includes('handle.stalledBlocker = null'), '断连必须清滞留计时');
  assert.ok(body.includes('stalledEviction: null'), '环境重新跑起来后必须撕掉旧卡片');
});

test('滞留终止: 持久卡片与运行状态解耦，只随主进程归因存亡', () => {
  // 与 edgeFailure 那张卡片不同，这一张 MUST NOT 挂在任何瞬时状态轴上：一个被系统关掉的号，
  // 在有人处理之前必须一直看得见。撕卡由主进程在环境重新跑起来时统一执行。
  const rendererSource = readFileSync(new URL('../../src/electron/renderer/renderer.js', import.meta.url), 'utf8');
  const body = functionBody(rendererSource, 'renderStalledEviction');
  assert.ok(body.includes('status.stalledEviction'), '卡片必须直接读主进程的归因');
  for (const axis of ['status.edge', 'status.session', 'status.cloud', 'status.auth']) {
    assert.equal(body.includes(axis), false, `卡片 MUST NOT 挂在 ${axis} 上——那会让它被一次状态刷新冲掉`);
  }
  assert.ok(body.includes('手动重新启动'), '卡片必须写明需要人做什么');
});
