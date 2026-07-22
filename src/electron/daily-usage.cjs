/**
 * 今日进展载荷的清洗 / 归一 / 乐观累加（change platform-honest-usage-metrics 从 main.cjs 抽出）。
 *
 * 抽出的唯一理由是**可测**：这些函数原先是 main.cjs 里的未导出闭包，而 main.cjs 全仓无任何 test import
 * ⇒ 本文件里那两条最容易静默回归的不变量（键清单漂移、乐观累加复活缺席键）过去一条断言都没有，
 * 症状还都是「不报错，只是屏幕上不对」。全部纯函数、无 Electron 依赖。
 */

/**
 * 客户端指标键清单（change platform-honest-usage-metrics）。
 *
 * ⚠️ 本文件是纯 CJS/JS，这张表**派生不了、typecheck 抓不到**——它必须与 `src/comm/protocol.ts` 的
 * `UI_DAILY_USAGE_ACTIONS` 手工保持一致。漏一个键不会报错，症状是「云端发了、界面不显示、没有任何
 * 报错」（与本文件 cleanSlowStart 那道白名单同一个模子）。test/electron 有一条穿透断言钉住它。
 *
 * `join_group` 与风控动作名逐字同名——不是笔误，别「顺手」改成 join。
 */
const DAILY_USAGE_ACTIONS = ['view', 'search', 'like', 'collect', 'comment', 'follow', 'publish', 'join_group'];
const DAILY_USAGE_WINDOWS = ['session', 'minute', 'hour', 'day'];

function cleanCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cleanOptionalCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

/**
 * 云端给了哪些键就留哪些键（change platform-honest-usage-metrics）。
 *
 * 取代旧的 cleanRequiredCounts——那个把全部键无条件物化成 0，于是「云端摘掉了收藏」在客户端被原地
 * 抹平回「收藏 0」，云端那一半白做（这正是上一个 change 只摘上限、不摘计数的原因）。
 *
 * 两件事必须分清：
 *   - **缺席** = 这个平台没有这个动作 ⇒ 原样保持缺席，渲染层据此整格不画。
 *   - **供给的 0** = 真实观测（今天还没做）⇒ 照留，必须画出来。
 *
 * 与 cleanOptionalCounts 的唯一区别：本函数恒返回对象（totals 是必填字段），后者空则返回 null。
 */
function cleanSuppliedCounts(input) {
  const source = input && typeof input === 'object' ? input : {};
  const counts = {};
  for (const action of DAILY_USAGE_ACTIONS) {
    if (typeof source[action] === 'number' && Number.isFinite(source[action])) {
      counts[action] = cleanCount(source[action]);
    }
  }
  return counts;
}

function cleanOptionalCounts(input) {
  const source = input && typeof input === 'object' ? input : null;
  if (!source) return null;
  const counts = {};
  for (const action of DAILY_USAGE_ACTIONS) {
    if (typeof source[action] === 'number' && Number.isFinite(source[action])) {
      counts[action] = cleanCount(source[action]);
    }
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

function cleanInspirationSummary(input) {
  const source = input && typeof input === 'object' ? input : null;
  if (!source) return null;
  const count = cleanOptionalCount(source.count);
  if (!count || count <= 0) return null;
  const out = { count };
  const sourceLikeCount = cleanOptionalCount(source.sourceLikeCount);
  if (sourceLikeCount !== null && sourceLikeCount > 0) out.sourceLikeCount = sourceLikeCount;
  return out;
}

function saturatedActions(totals, quotas, explicit) {
  const set = new Set(Array.isArray(explicit) ? explicit.filter((a) => DAILY_USAGE_ACTIONS.includes(a)) : []);
  if (quotas) {
    for (const action of DAILY_USAGE_ACTIONS) {
      if (typeof quotas[action] === 'number' && cleanCount(totals[action]) >= cleanCount(quotas[action])) {
        set.add(action);
      }
    }
  }
  return [...set];
}

function normalizeUsageWindow(input) {
  if (!input || typeof input !== 'object' || !input.totals || typeof input.totals !== 'object') return null;
  const totals = cleanOptionalCounts(input.totals);
  if (!totals) return null;
  const quotas = cleanOptionalCounts(input.quotas);
  const out = {
    totals,
    saturated: saturatedActions(totals, quotas, input.saturated),
  };
  if (typeof input.active === 'boolean') out.active = input.active;
  if (typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)) out.startedAt = input.startedAt;
  if (typeof input.windowMs === 'number' && Number.isFinite(input.windowMs) && input.windowMs > 0) out.windowMs = Math.floor(input.windowMs);
  if (typeof input.expiresAt === 'number' && Number.isFinite(input.expiresAt)) out.expiresAt = input.expiresAt;
  if (typeof input.refreshAt === 'number' && Number.isFinite(input.refreshAt)) out.refreshAt = input.refreshAt;
  if (typeof input.releaseAt === 'number' && Number.isFinite(input.releaseAt)) out.releaseAt = input.releaseAt;
  if (quotas) out.quotas = quotas;
  return out;
}

function normalizeUsageWindows(input) {
  if (!input || typeof input !== 'object') return null;
  const windows = {};
  for (const name of DAILY_USAGE_WINDOWS) {
    const window = normalizeUsageWindow(input[name]);
    if (window) windows[name] = window;
  }
  return Object.keys(windows).length > 0 ? windows : null;
}

function normalizeDailyUsage(input) {
  if (!input || typeof input !== 'object') return null;
  const asOf = typeof input.asOf === 'number' && Number.isFinite(input.asOf)
    ? new Date(input.asOf).toISOString()
    : new Date().toISOString();
  const totals = cleanSuppliedCounts(input.totals);
  const quotas = cleanOptionalCounts(input.quotas);
  const windows = normalizeUsageWindows(input.windows);
  const inspirationSummary = cleanInspirationSummary(input.inspirationSummary);
  const firstPost = input.firstPost && typeof input.firstPost === 'object'
    && ['searching', 'generating'].includes(input.firstPost.state)
    && typeof input.firstPost.viewed === 'number' && Number.isFinite(input.firstPost.viewed)
    && typeof input.firstPost.startedAt === 'number' && Number.isFinite(input.firstPost.startedAt)
    ? {
        state: input.firstPost.state,
        viewed: cleanCount(input.firstPost.viewed),
        target: 20,
        startedAt: input.firstPost.startedAt,
        ...(typeof input.firstPost.sourceId === 'string' && input.firstPost.sourceId ? { sourceId: input.firstPost.sourceId } : {}),
      }
    : null;
  const out = {
    asOf,
    totals,
    saturated: saturatedActions(totals, quotas, input.saturated),
  };
  if (['conservative', 'normal', 'aggressive'].includes(input.quotaLevel)) out.quotaLevel = input.quotaLevel;
  if (quotas) out.quotas = quotas;
  if (inspirationSummary) out.inspirationSummary = inspirationSummary;
  if (firstPost) out.firstPost = firstPost;
  const slowStart = cleanSlowStart(input.slowStart);
  if (slowStart) out.slowStart = slowStart;
  if (windows) out.windows = windows;
  return out;
}

/**
 * 慢启动字段的第二道白名单（change account-level-slow-start）：与 ui-event-lines.ts 的
 * sanitizeSlowStart 同款校验。这两道都是手写对象组装、**typecheck 一道都抓不到**——
 * 字段不进名单即静默丢弃，症状是「云端发了、界面不显示、没有任何报错」。
 * 校验风格照同函数内的 quotaLevel / firstPost。任一项不合法 → 整块丢弃（不渲染 > 渲染半真）。
 */
function cleanSlowStart(input) {
  if (!input || typeof input !== 'object') return null;
  if (!['off', 'active', 'graduated'].includes(input.state)) return null;
  if (typeof input.eligible !== 'boolean') return null;
  if (!Number.isInteger(input.totalDays) || input.totalDays <= 0) return null;
  const out = { state: input.state, totalDays: input.totalDays, eligible: input.eligible };
  if (input.state === 'active') {
    if (!Number.isInteger(input.day) || input.day < 1 || input.day > input.totalDays) return null;
    // binding 缺省即无从判断「勾了到底压没压」→ 整块丢弃，绝不默认成 true（那等于宣称在压低配额）。
    if (typeof input.binding !== 'boolean') return null;
    out.day = input.day;
    out.binding = input.binding;
  }
  if (typeof input.since === 'number' && Number.isFinite(input.since)) out.since = input.since;
  if (input.ineligibleReason !== undefined) {
    if (!['platform_unsupported', 'platform_unknown', 'globally_disabled'].includes(input.ineligibleReason)) return null;
    out.ineligibleReason = input.ineligibleReason;
  }
  return out;
}

function bumpDailyUsage(usage, action, delta) {
  const amount = cleanCount(delta);
  if (!usage || !DAILY_USAGE_ACTIONS.includes(action) || amount <= 0) return usage || null;
  const totals = cleanSuppliedCounts(usage.totals);
  // 云端没给这个键 = 这个平台结构上没有这个动作 ⇒ 绝不因为一个本地事件把它凭空建出来
  // （change platform-honest-usage-metrics）。少了这道判断的症状不是报错，是**格子闪回**：
  // 云端摘掉收藏、格子隐藏，随便来一个点赞事件就把「收藏 0」补回去、收藏格当场重现，
  // 直到 ≤60s 后下一份云端快照才又消失。窗口那侧（bumpDailyUsageWindows）早就有等价的 hasAction 判断。
  if (!Object.prototype.hasOwnProperty.call(totals, action)) return usage;
  totals[action] = cleanCount(totals[action]) + amount;
  const quotas = cleanOptionalCounts(usage.quotas);
  const windows = bumpDailyUsageWindows(usage.windows, action, amount);
  return {
    ...usage,
    asOf: new Date().toISOString(),
    totals,
    ...(quotas ? { quotas } : {}),
    saturated: saturatedActions(totals, quotas, usage.saturated),
    ...(windows ? { windows } : {}),
  };
}

function bumpDailyUsageWindows(input, action, amount) {
  if (!input || typeof input !== 'object') return null;
  const windows = {};
  for (const name of DAILY_USAGE_WINDOWS) {
    const window = normalizeUsageWindow(input[name]);
    if (!window) continue;
    const hasAction =
      Object.prototype.hasOwnProperty.call(window.totals, action) ||
      (window.quotas && Object.prototype.hasOwnProperty.call(window.quotas, action));
    if (!hasAction) {
      windows[name] = window;
      continue;
    }
    const totals = { ...window.totals, [action]: cleanCount(window.totals[action]) + amount };
    const quotas = cleanOptionalCounts(window.quotas);
    const now = Date.now();
    const expired = typeof window.expiresAt === 'number' && Number.isFinite(window.expiresAt) && window.expiresAt <= now;
    const baseTotals = expired && typeof window.windowMs === 'number'
      ? Object.fromEntries(DAILY_USAGE_ACTIONS.map((name) => [name, name === action ? amount : 0]))
      : totals;
    windows[name] = {
      ...window,
      totals: baseTotals,
      ...(expired && typeof window.windowMs === 'number'
        ? { startedAt: now - window.windowMs, expiresAt: now + window.windowMs }
        : {}),
      ...(quotas ? { quotas } : {}),
      saturated: saturatedActions(baseTotals, quotas, expired ? [] : window.saturated),
    };
  }
  return Object.keys(windows).length > 0 ? windows : null;
}

module.exports = {
  DAILY_USAGE_ACTIONS,
  DAILY_USAGE_WINDOWS,
  cleanCount,
  cleanOptionalCount,
  cleanSuppliedCounts,
  cleanOptionalCounts,
  cleanInspirationSummary,
  saturatedActions,
  normalizeUsageWindow,
  normalizeUsageWindows,
  normalizeDailyUsage,
  cleanSlowStart,
  bumpDailyUsage,
  bumpDailyUsageWindows,
};
