// 陪伴式主界面渲染层（edge-companion-ui）。
// 纯视图逻辑（健康合成 / 在场感动效门 / 发布卡状态机）在 ui-logic.js（window.uiLogic，可单测）；
// 本文件只做 DOM 粘合。设置表单 / 悬浮三态 FAB 的既有逻辑原样保留（仅 DOM 迁入设置抽屉）。
const uiLogic = window.uiLogic;

const fields = {
  dailySummary: document.querySelector('#daily-summary'),
  auth: document.querySelector('#auth-status'),
  cloud: document.querySelector('#cloud-status'),
  session: document.querySelector('#session-state'),
  risk: document.querySelector('#risk-status'),
  edge: document.querySelector('#edge-state'),
  views: document.querySelector('#views'),
  likes: document.querySelector('#likes'),
  collects: document.querySelector('#collects'),
  comments: document.querySelector('#comments'),
  follows: document.querySelector('#follows'),
  publishes: document.querySelector('#publishes'),
  usageSource: document.querySelector('#usage-source'),
  usageLimit: document.querySelector('#usage-limit'),
  quotaToggle: document.querySelector('#quota-toggle'),
  quotaWindows: document.querySelector('#quota-windows'),
  updatedAt: document.querySelector('#updated-at'),
  usageCaps: {
    view: document.querySelector('#views-cap'),
    like: document.querySelector('#likes-cap'),
    collect: document.querySelector('#collects-cap'),
    comment: document.querySelector('#comments-cap'),
    follow: document.querySelector('#follows-cap'),
    publish: document.querySelector('#publishes-cap'),
  },
  usageBars: {
    view: document.querySelector('#views-bar'),
    like: document.querySelector('#likes-bar'),
    collect: document.querySelector('#collects-bar'),
    comment: document.querySelector('#comments-bar'),
    follow: document.querySelector('#follows-bar'),
    publish: document.querySelector('#publishes-bar'),
  },
  lastMessage: document.querySelector('#last-message'),
  sessionFab: document.querySelector('#session-fab'),
  relogin: document.querySelector('#relogin'),
  loginGuide: document.querySelector('#login-guide'),
  noticeTitle: document.querySelector('#notice-title'),
  noticeBody: document.querySelector('#notice-body'),
  noticeAction: document.querySelector('#notice-action'),
  edgeFailure: document.querySelector('#edge-failure'),
  edgeFailureText: document.querySelector('#edge-failure-text'),
  subtitle: document.querySelector('#subtitle'),
  // 陪伴式新增
  titlebar: document.querySelector('#titlebar'),
  acctAva: document.querySelector('#acct-ava'),
  acctName: document.querySelector('#acct-name'),
  healthPill: document.querySelector('#health-pill'),
  healthLabel: document.querySelector('#health-label'),
  healthPop: document.querySelector('#health-pop'),
  healthDetail: document.querySelector('#health-detail'),
  gear: document.querySelector('#gear'),
  presenceText: document.querySelector('#presence-text'),
  presenceFresh: document.querySelector('#presence-fresh'),
  presenceCore: document.querySelector('#presence-core'),
  kernelPrep: document.querySelector('#kernel-prep'),
  kernelPrepLabel: document.querySelector('#kernel-prep-label'),
  kernelPrepPct: document.querySelector('#kernel-prep-pct'),
  kernelPrepBar: document.querySelector('#kernel-prep-bar'),
  loop: document.querySelector('#loop'),
  stream: document.querySelector('#activity-stream'),
  streamEmpty: document.querySelector('#stream-empty'),
  pubCard: document.querySelector('#pub-card'),
  pubHeadRow: document.querySelector('#pub-head-row'),
  pubHead: document.querySelector('#pub-head'),
  pubCorner: document.querySelector('#pub-corner'),
  pubTitle: document.querySelector('#pub-title'),
  pubThumb: document.querySelector('#pub-thumb'),
  pubMeta: document.querySelector('#pub-meta'),
  pubSteps: document.querySelector('#pub-steps'),
  pubFoot: document.querySelector('#pub-foot'),
  pubLink: document.querySelector('#pub-link'),
  pubMain: document.querySelector('#pub-main'),
  pubBar: document.querySelector('#pub-bar'),
  pubBarSum: document.querySelector('#pub-bar-sum'),
  drawer: document.querySelector('#drawer'),
  drawerMask: document.querySelector('#drawer-mask'),
  drawerClose: document.querySelector('#drawer-close'),
  lightsPad: document.querySelector('.tb-lights-pad'),
  winctlPad: document.querySelector('.tb-winctl-pad'),
  // 多环境 fleet（edge-multi-environment-fleet）
  fleetRow: document.querySelector('#fleet-row'),
  envRail: document.querySelector('#env-rail'),
  railToggle: document.querySelector('#rail-toggle'),
  railBadge: document.querySelector('#rail-badge'),
  railList: document.querySelector('#rail-list'),
  railGuide: document.querySelector('#rail-guide'),
  railStartAll: document.querySelector('#rail-start-all'),
  railRamConfirm: document.querySelector('#rail-ram-confirm'),
  railRamText: document.querySelector('#rail-ram-text'),
  railRamForce: document.querySelector('#rail-ram-force'),
  railRamCancel: document.querySelector('#rail-ram-cancel'),
  railMsg: document.querySelector('#rail-msg'),
  guidePanel: document.querySelector('#guide-panel'),
  guideTitle: document.querySelector('#guide-title'),
  guideBody: document.querySelector('#guide-body'),
  guideOpen: document.querySelector('#guide-open'),
  guideDone: document.querySelector('#guide-done'),
  guideSkip: document.querySelector('#guide-skip'),
  guideExit: document.querySelector('#guide-exit'),
  guideHint: document.querySelector('#guide-hint'),
  sameAccountWarn: document.querySelector('#same-account-warn'),
  sameAccountText: document.querySelector('#same-account-text'),
};

const settingsUi = {
  useChrome: document.querySelector('#use-chrome'),
  adsConfig: document.querySelector('#ads-config'),
  adsProfile: document.querySelector('#ads-profile'),
  adsProfileDisplay: document.querySelector('#ads-profile-display'),
  adsManual: document.querySelector('#ads-manual'),
  adsApiKey: document.querySelector('#ads-apikey'),
  adsApiBase: document.querySelector('#ads-apibase'),
  adsAdvancedToggle: document.querySelector('#ads-advanced-toggle'),
  adsAdvanced: document.querySelector('#ads-advanced'),
  adsEnvList: document.querySelector('#ads-env-list'),
  adsRefresh: document.querySelector('#ads-refresh'),
  adsEnvMsg: document.querySelector('#ads-env-msg'),
  adsCreate: document.querySelector('#ads-create'),
  adsTemplate: document.querySelector('#ads-template'),
  adsPlatform: document.querySelector('#ads-platform'),
  adsCreateMsg: document.querySelector('#ads-create-msg'),
  parkingButtons: Array.from(document.querySelectorAll('.parking-btn')),
  browserShow: document.querySelector('#browser-show'),
  browserResetParking: document.querySelector('#browser-reset-parking'),
  applyRestart: document.querySelector('#apply-restart'),
  msg: document.querySelector('#settings-msg'),
};
const PARKING_MODES = new Set(['parking-display', 'edge-strip', 'offscreen']);

// 状态码保持英文（供 CSS 上色 + main 侧判断），展示文案在此本地化。className 仍用原始码不动色。
const STATUS_LABELS = {
  auth: {
    checking: '检测中',
    'login required': '需登录',
    'logged in': '已登录',
    'chrome missing': '缺少 Chrome',
    'config required': '待配置',
  },
  cloud: { disconnected: '未连接', connected: '已连接' },
  session: { idle: '待命', running: '进行中', resting: '休息中', paused: '已暂停' },
  risk: { normal: '正常', warned: '谨慎放慢', restricted: '受限', frozen: '已冻结' },
  edge: { stopped: '已停止', starting: '启动中', running: '运行中', warning: '异常' },
};

const SUBTITLE = {
  adspower: '内置指纹浏览器托管，每个分身独立指纹与 IP，规避同机多账号关联。',
  self: '本机 Chrome 以持久化配置启动，用于小红书登录与自动运营。',
};

let currentStatus;
// ── 多环境 fleet 视图态（edge-multi-environment-fleet）──
// 状态 / 活动按 envId 归属；右侧主区域只呈现「当前选中环境」的投影（内容与交互不变）。
// 无 envId 的旧形状（单环境主进程 / 测试桩）归 '__local__'，环境栏对其隐藏——零回归。
const fleetView = {
  envs: new Map(), // envId -> { envId, name, platform, status }
  order: [], // 花名册顺序
  selected: null, // 当前选中 envId
  collapsed: true, // 环境栏默认收起为窄图标条
  buffers: new Map(), // envId -> [{ entry, cls }]（每环境活动流缓冲，≤200 条，绝不串号）
  logs: new Map(), // envId -> { entries:[{time,message}], last }（每环境开发者原始日志，绝不串号）
  guided: null, // 引导处理态 { done:Set, current }
  lastRailSig: '', // 环境栏 DOM 变更签名（每秒 stale 重估时避免无谓重建，见 renderRail）
};
function currentEnvId() {
  return fleetView.selected && fleetView.selected !== '__local__' ? fleetView.selected : undefined;
}
function routeSelKey() {
  return fleetView.selected || '__local__';
}
// 用户正在编辑设置表单时不被状态推送回填覆盖（避免边打字边被清空）。
let editingProvider = null;
// 设置是否相对「已应用/已保存」有改动。核心在跑且 dirty 时才显示「按新设置重启」；
// 「保存」按钮已并入「启动」——启动时先存再起，故无独立保存按钮。
let dirty = false;
// 选中环境的 AdsPower 环境名（随设置持久化，作标题带账号标签兜底）。
let selectedProfileName = '';
// 运行花名册（edge-multi-environment-fleet）：多选加入的环境成员 [{profileId, name, platform}]，
// 按 profileId 去重（同一分身 MUST NOT 重复加入，防 edgeId 撞车）；持久化为 settings.environments。
let roster = [];
// 最近一次拉取的环境列表（roster 变更后就地重刷成员标记，无需重新拉取）。
let lastProfiles = [];
function normalizeRosterList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String((raw && (raw.profileId !== undefined ? raw.profileId : raw.userId)) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ profileId: id, name: (raw && raw.name) || '', platform: normPlatform(raw && raw.platform) });
  }
  return out;
}
function rosterHas(profileId) {
  return roster.some((m) => m.profileId === profileId);
}
// change edge-environment-platform-select：当前选中环境的运行时平台（同步进 settings.platform，启动时注入核心）。
let selectedPlatform = 'xiaohongshu';
function normPlatform(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === 'facebook' || v === 'fb') return 'facebook';
  return 'xiaohongshu';
}
function platformLabel(p) {
  return normPlatform(p) === 'facebook' ? 'Facebook' : '小红书';
}
const LOG_RETENTION_MS = 2 * 60 * 1000; // 开发者详情原始日志保留 2 分钟
let quotaDetailsOpen = false;

// 平台占位：mac 红绿灯内嵌预留左侧；Windows 叠加窗控预留右侧。其余平台两侧归零。
(function initPlatformPads() {
  const platform = (navigator.platform || '').toLowerCase();
  const isMac = platform.includes('mac');
  const isWin = platform.includes('win');
  if (!isMac && fields.lightsPad) fields.lightsPad.classList.add('none');
  if (isWin && fields.winctlPad) fields.winctlPad.classList.add('win');
})();

function setBadge(element, field, value) {
  element.textContent = STATUS_LABELS[field]?.[value] ?? value;
  element.className = `badge ${value}`;
}

const USAGE_ITEMS = [
  { action: 'view', stat: 'views', value: fields.views, label: '浏览' },
  { action: 'like', stat: 'likes', value: fields.likes, label: '点赞' },
  { action: 'collect', stat: 'collects', value: fields.collects, label: '收藏' },
  { action: 'comment', stat: 'comments', value: fields.comments, label: '评论' },
  { action: 'follow', stat: 'follows', value: fields.follows, label: '关注' },
  { action: 'publish', stat: 'publishes', value: fields.publishes, label: '发帖' },
];

const QUOTA_WINDOWS = [
  { key: 'session', label: '单场' },
  { key: 'minute', label: '分钟' },
  { key: 'hour', label: '小时' },
  { key: 'day', label: '今日' },
];

const QUOTA_LEVEL_LABELS = {
  conservative: '保守档',
  normal: '标准档',
  aggressive: '进取档',
};

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function parseUsageTime(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  if (Number.isFinite(parsed)) return parsed;
  return Date.parse(fallback || '') || Date.now();
}

function parseOptionalTime(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeHint(at, now) {
  const diff = at - now;
  if (diff > 0) {
    const seconds = Math.ceil(diff / 1000);
    if (seconds < 90) return `约 ${seconds} 秒后`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 90) return `约 ${minutes} 分钟后`;
    const hours = Math.ceil(minutes / 60);
    if (hours < 24) return `约 ${hours} 小时后`;
  }
  return new Date(at).toLocaleTimeString();
}

function refreshMeta(refreshAt, now) {
  if (refreshAt === null) return '等待云端快照';
  if (refreshAt > now) return `${timeHint(refreshAt, now)}刷新`;
  return `${new Date(refreshAt).toLocaleTimeString()} 应已刷新，等待云端快照`;
}

function usageView(status) {
  const daily = status.dailyUsage;
  const hasDaily = Boolean(daily && daily.totals && typeof daily.totals === 'object');
  const stats = status.stats || {};
  const totals = {};
  for (const item of USAGE_ITEMS) {
    totals[item.action] = hasDaily ? count(daily.totals[item.action]) : count(stats[item.stat]);
  }
  const quotas = daily && daily.quotas && typeof daily.quotas === 'object' ? daily.quotas : null;
  return {
    hasDaily,
    quotaLevel: daily?.quotaLevel,
    asOf: hasDaily ? parseUsageTime(daily.asOf, status.updatedAt) : parseUsageTime(status.updatedAt, status.updatedAt),
    totals,
    quotas,
    saturated: new Set(Array.isArray(daily?.saturated) ? daily.saturated : []),
    windows: daily && daily.windows && typeof daily.windows === 'object' ? daily.windows : null,
  };
}

function renderUsageItem(item, usage) {
  const used = count(usage.totals[item.action]);
  const cap = usage.quotas && typeof usage.quotas[item.action] === 'number' ? count(usage.quotas[item.action]) : null;
  const card = item.value.closest('.kpi');
  const capEl = fields.usageCaps[item.action];
  const barEl = fields.usageBars[item.action];
  const hasCap = cap !== null;
  const saturated = hasCap && (usage.saturated.has(item.action) || used >= cap);
  const ratio = hasCap ? (cap > 0 ? Math.min(1, used / cap) : 1) : 0;

  item.value.textContent = used;
  item.value.classList.toggle('zero', used === 0);
  if (capEl) capEl.textContent = hasCap ? `/${cap}` : '';
  if (barEl) barEl.style.width = hasCap ? `${Math.round(ratio * 100)}%` : '0%';
  if (card) {
    card.classList.toggle('has-limit', hasCap);
    card.classList.toggle('near', hasCap && !saturated && ratio >= 0.8);
    card.classList.toggle('saturated', saturated);
    card.title = hasCap ? `${item.label} ${used}/${cap}${saturated ? '，今日已到上限' : ''}` : `${item.label} ${used}`;
  }
}

function compactLabels(labels) {
  const unique = [...new Set(labels.filter(Boolean))];
  if (unique.length <= 2) return unique.join('/');
  return `${unique.slice(0, 2).join('/')}等${unique.length}项`;
}

function compactHitText(parts) {
  if (parts.length <= 2) return parts.join(' · ');
  return `${parts.slice(0, 2).join(' · ')} 等${parts.length}项`;
}

function quotaHitTexts(windowViews) {
  const byAction = new Map();
  for (const window of windowViews) {
    for (const entry of window.rows.filter((row) => row.hit)) {
      const current = byAction.get(entry.action) || { label: entry.label, windows: [] };
      if (!current.windows.includes(window.label)) current.windows.push(window.label);
      byAction.set(entry.action, current);
    }
  }
  return [...byAction.values()].map((entry) => `${entry.label}已达${compactLabels(entry.windows)}上限`);
}

function usageLimitLabel(usage) {
  const windowViews = quotaWindowViews(usage);
  if (windowViews.length > 0) {
    const hit = quotaHitTexts(windowViews);
    if (hit.length > 0) return { tone: 'hit', text: compactHitText(hit), title: hit.join(' · ') };
    return { tone: 'ok', text: '额度正常' };
  }
  if (!usage.quotas) return null;
  const limited = [];
  for (const item of USAGE_ITEMS) {
    const cap = typeof usage.quotas[item.action] === 'number' ? count(usage.quotas[item.action]) : null;
    if (cap === null) continue;
    const used = count(usage.totals[item.action]);
    if (usage.saturated.has(item.action) || used >= cap) limited.push(item.label);
  }
  return limited.length > 0 ? { tone: 'hit', text: `${compactLabels(limited)}已达今日上限` } : { tone: 'ok', text: '额度正常' };
}

function quotaWindowViewsAt(usage, now) {
  const windows = usage.windows;
  if (!windows || typeof windows !== 'object') return [];
  return QUOTA_WINDOWS.map((item) => quotaWindowView(item, windows[item.key], now))
    .filter(Boolean);
}

function quotaWindowViews(usage) {
  return quotaWindowViewsAt(usage, Date.now());
}

function quotaWindowView(item, window, now) {
  if (!window || typeof window !== 'object') return null;
  const totals = window.totals && typeof window.totals === 'object' ? window.totals : {};
  const quotas = window.quotas && typeof window.quotas === 'object' ? window.quotas : {};
  const saturated = new Set(Array.isArray(window.saturated) ? window.saturated : []);
  const active = item.key === 'session' ? window.active !== false : true;
  const expiresAt = parseOptionalTime(window.expiresAt);
  const refreshAt = parseOptionalTime(window.refreshAt);
  const releaseAt = parseOptionalTime(window.releaseAt);
  const expired = (item.key === 'minute' || item.key === 'hour') && expiresAt !== null && expiresAt <= now;
  const rows = [];
  const capped = [];
  for (const usageItem of USAGE_ITEMS) {
    const hasTotal = Object.prototype.hasOwnProperty.call(totals, usageItem.action);
    const hasCap = typeof quotas[usageItem.action] === 'number';
    if (!hasTotal && !hasCap) continue;
    const used = count(totals[usageItem.action]);
    const cap = hasCap ? count(quotas[usageItem.action]) : null;
    const ratio = cap !== null ? (cap > 0 ? Math.min(1, used / cap) : 1) : 0;
    const hit = !expired && active && cap !== null && (saturated.has(usageItem.action) || used >= cap);
    const row = { ...usageItem, used, cap, ratio, hit, hasCap };
    rows.push(row);
    if (hasCap) capped.push(row);
  }
  if (rows.length === 0) return null;
  const limited = rows.filter((entry) => entry.hit).length;
  const worst = capped.reduce((best, entry) => (!best || entry.ratio > best.ratio ? entry : best), null);
  const ratio = !expired && active ? (worst?.ratio ?? 0) : 0;
  const tone = expired || !active ? 'idle' : limited > 0 ? 'hit' : ratio >= 0.8 ? 'near' : 'ok';
  const state = expired ? '待刷新' : !active ? '未运行' : limited > 0 ? `已满 ${limited}项` : ratio >= 0.8 ? '临近' : '正常';
  const baseMeta = worst ? `${worst.label} ${worst.used}/${worst.cap}` : '无窗口上限';
  const meta = expired
    ? refreshMeta(refreshAt, now)
    : (limited > 0 && releaseAt !== null && releaseAt > now ? `${baseMeta} · ${timeHint(releaseAt, now)}释放` : baseMeta);
  return {
    key: item.key,
    label: item.label,
    tone,
    state,
    meta,
    ratio,
    limited,
    expired,
    rows,
    title: `${item.label}: ${state}${rows.length > 0 ? ` · ${rows.map((entry) => `${entry.label} ${entry.used}/${entry.cap ?? '-'}`).join(' · ')}` : ''}`,
  };
}

function renderQuotaWindows(usage) {
  if (!fields.quotaWindows) return;
  const windows = quotaWindowViews(usage);
  fields.dailySummary?.classList.toggle('expanded', quotaDetailsOpen && windows.length > 0);
  if (fields.quotaToggle) {
    fields.quotaToggle.classList.toggle('open', quotaDetailsOpen && windows.length > 0);
    fields.quotaToggle.setAttribute('aria-expanded', quotaDetailsOpen && windows.length > 0 ? 'true' : 'false');
  }
  if (windows.length === 0 || !quotaDetailsOpen) {
    fields.quotaWindows.className = 'quota-windows hidden';
    fields.quotaWindows.innerHTML = '';
    return;
  }
  fields.quotaWindows.className = 'quota-windows';
  fields.quotaWindows.innerHTML = windows.map((window) => {
    const rows = window.rows.map((entry) => {
      const pct = entry.cap !== null ? Math.round(entry.ratio * 100) : 0;
      const value = entry.cap !== null ? `${entry.used}/${entry.cap}` : `${entry.used}/-`;
      return `
        <div class="qwd-row ${entry.hit ? 'hit' : entry.ratio >= 0.8 && entry.cap !== null ? 'near' : ''}">
          <span>${escapeHtml(entry.label)}</span>
          <b>${escapeHtml(value)}</b>
          <i><em style="width:${pct}%"></em></i>
        </div>`;
    }).join('');
    return `
      <div class="quota-window-detail ${window.tone}" title="${escapeHtml(window.title)}">
        <div class="qwd-head">
          <span>${escapeHtml(window.label)}</span>
          <strong>${escapeHtml(window.state)}</strong>
        </div>
        <small>${escapeHtml(window.meta)}</small>
        <div class="qwd-rows">${rows}</div>
      </div>`;
  }).join('');
}

function renderUsageSummary(status) {
  const usage = usageView(status);
  fields.usageSource.textContent = usage.hasDaily
    ? `账号今日${usage.quotaLevel ? ` · ${QUOTA_LEVEL_LABELS[usage.quotaLevel] || usage.quotaLevel}` : ''}`
    : '本机实时';
  const limit = usageLimitLabel(usage);
  if (fields.usageLimit) {
    fields.usageLimit.textContent = limit ? limit.text : '';
    fields.usageLimit.className = limit ? `summary-limit ${limit.tone}` : 'summary-limit hidden';
    fields.usageLimit.title = limit ? limit.title || limit.text : '';
  }
  for (const item of USAGE_ITEMS) renderUsageItem(item, usage);
  renderQuotaWindows(usage);
  fields.updatedAt.textContent = new Date(usage.asOf).toLocaleTimeString();
}

// ─── 开发者详情：原始日志（滚动保留 + 连续去重；按 envId 分桶，绝不跨环境串号/相邻误吞）───
function logBucket(envKey) {
  let b = fleetView.logs.get(envKey);
  if (!b) { b = { entries: [], last: '' }; fleetView.logs.set(envKey, b); }
  return b;
}

// 记录某环境一行原始日志（供所有环境调用，含未选中环境；只有选中环境时才刷 DOM）。
function recordLog(envKey, message) {
  if (!message) return;
  const b = logBucket(envKey);
  if (message === b.last) return; // 连续去重按本环境桶判，绝不因别环境的相同末行而误吞
  b.last = message;
  const now = Date.now();
  b.entries.push({ time: now, message });
  const cutoff = now - LOG_RETENTION_MS;
  while (b.entries.length > 0 && b.entries[0].time < cutoff) b.entries.shift();
  if (envKey === routeSelKey()) renderLog();
}

function renderLog() {
  const b = fleetView.logs.get(routeSelKey());
  fields.lastMessage.innerHTML = (b ? b.entries : []).map((entry) => {
    const time = new Date(entry.time).toLocaleTimeString();
    return `<div class="log-entry"><span class="log-time">${time}</span> ${escapeHtml(entry.message)}</div>`;
  }).join('');
  fields.lastMessage.scrollTop = fields.lastMessage.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── 阻塞动作主动步骤（需登录 / 待配置）───
function renderNotice(status) {
  let title = '';
  let body = '';
  let action = false;
  if (status.auth === 'login required') {
    title = '需要登录';
    body = '请在刚打开的 Chrome 窗口中登录 xiaohongshu.com，检测到登录后会自动继续。';
  } else if (status.auth === 'config required') {
    title = '先完成一次设置';
    body = '选择一个浏览器环境（或手动填写分身 ID），之后就不用再管了。';
    action = true;
  }
  const show = Boolean(title);
  fields.loginGuide.classList.toggle('hidden', !show);
  if (show) {
    fields.noticeTitle.textContent = title;
    fields.noticeBody.textContent = body;
    fields.noticeAction.classList.toggle('hidden', !action);
  }
}

function failureSummary(status) {
  const summary = status && status.edgeFailure && status.edgeFailure.summary;
  return typeof summary === 'string' ? summary.trim() : '';
}

function renderEdgeFailure(status) {
  const summary = failureSummary(status);
  const show = Boolean(summary) && (status.edge === 'warning' || status.auth === 'chrome missing');
  fields.edgeFailure.classList.toggle('hidden', !show);
  fields.edgeFailureText.textContent = show ? summary : '';
}

// ─── 标题带：账号身份 + 健康合成 + 风控染色 ───
function renderTitlebar(status) {
  const acct = status.account;
  if (acct && (acct.name || acct.id)) {
    // 标签兜底链：小红书昵称（@ 前缀）> AdsPower 环境名（平铺，不冒充小红书昵称）> 账号 …尾4位。
    const nick = (acct.name || '').replace(/^@/, '');
    const isXhsNick = nick && acct.source !== 'env';
    fields.acctName.textContent = nick ? (isXhsNick ? `@${nick}` : nick) : `账号 …${String(acct.id).slice(-4)}`;
    fields.acctAva.textContent = nick ? nick.slice(0, 1) : '书';
  }
  const health = uiLogic.synthesizeHealth(status);
  fields.healthLabel.textContent = health.label;
  fields.healthPill.className = `health-pill nodrag ${health.code}`;
  fields.healthDetail.textContent = failureSummary(status) || health.detail || '';
  fields.titlebar.className = `titlebar tone-${uiLogic.bandTone(status)}`;
}

// ─── 在场感行（动效只由真实事件驱动；诚实待命）───
function renderPresence(status, nowMs) {
  const view = uiLogic.presenceView(status, nowMs);
  fields.presenceText.textContent = view.text;
  fields.presenceText.classList.toggle('shimmer', view.animate);
  fields.presenceCore.classList.toggle('live', view.animate);
  fields.presenceFresh.textContent = view.fresh || '';
}

// ─── 浏览循环 chip ───
function renderLoop(status) {
  const running = status.edge === 'running' && status.session === 'running';
  const active = running ? uiLogic.loopIndex(status.loopStage) : -1;
  fields.loop.querySelectorAll('.loop-step').forEach((el) => {
    el.classList.toggle('on', running && el.dataset.stage === status.loopStage && active !== -1);
  });
}

// ─── 发布卡（常驻三态：flow 进行中 / last 上次发布 / empty 从未发布；纯展示零按钮）───
// 终态折流的去重签名按 envId 分桶（多环境下 A 的终态签名绝不吞掉 B 的折流）。
const lastPublishSigByEnv = new Map();
// 用户点薄条的临时展开（进行中审批到来 / 会话停止 / 切换环境时自动复位）。
let pubManualOpen = false;
function renderPublish(status, nowMs) {
  const view = uiLogic.publishView(status.publish, status.lastPublish, nowMs);
  // 终态折流 + 去重已收口到 absorbPublishTerminal（在 routeStatus 里对每个环境跑，含未选中环境），
  // 这里只负责发布卡的视觉渲染，绝不再自己 prependActivity（否则选中环境会重复记一条）。
  fields.pubCard.classList.remove('hidden'); // 常驻
  fields.pubCard.classList.toggle('empty', view.mode === 'empty');
  // 收展：flow 永远展开；运行中且无在途审批自动收起为薄条（点击可临时展开）。
  const dock = uiLogic.publishDock(view, status, pubManualOpen);
  if (view.mode === 'flow') pubManualOpen = false; // 新审批到来自动展开并复位手动态
  fields.pubCard.classList.toggle('collapsed', dock.collapsed);
  fields.pubBar.classList.toggle('hidden', !dock.collapsed);
  fields.pubMain.classList.toggle('folded', dock.collapsed);
  if (dock.collapsed) fields.pubBarSum.textContent = dock.summary;
  fields.pubHead.textContent = view.head;
  fields.pubCorner.textContent = view.corner;
  fields.pubCorner.classList.toggle('hot', Boolean(view.cornerHot));
  fields.pubTitle.textContent = view.title || '（新笔记）';
  fields.pubTitle.classList.toggle('muted', view.mode === 'empty');
  // 编号默认形态：无真编号时以「—」占位（云端飞书卡印上 requestId 后自动点亮真编号）；编号值带灰底小片（设计稿）。
  fields.pubMeta.textContent = '';
  fields.pubMeta.appendChild(document.createTextNode(view.mode === 'empty' ? '等待第一条笔记 · 编号 ' : '图文笔记 · 编号 '));
  const codeChip = document.createElement('span');
  codeChip.className = 'no';
  codeChip.textContent = view.code || '—';
  fields.pubMeta.appendChild(codeChip);
  renderFootRich(fields.pubFoot, view.foot); // 固定模板内 **…** 加粗，破掉整片灰
  fields.pubLink.classList.toggle('hidden', !view.showLink);
  const steps = fields.pubSteps.querySelectorAll('.j-step');
  view.stepStates.forEach((state, i) => {
    const el = steps[i];
    if (!el) return;
    el.className = `j-step ${state}${state === 'cur' && view.curCalm ? ' calm' : ''}`;
  });
}

// foot 富文本：仅解析固定文案模板里的 **加粗** 标记（无任何插值，无注入面）。
function renderFootRich(el, text) {
  el.textContent = '';
  String(text).split(/\*\*(.+?)\*\*/g).forEach((seg, i) => {
    if (!seg) return;
    if (i % 2 === 1) {
      const b = document.createElement('b');
      b.textContent = seg;
      el.appendChild(b);
    } else {
      el.appendChild(document.createTextNode(seg));
    }
  });
}

// 收起薄条：点击临时展开（再点卡头收回）；键盘可达。
function togglePubManual() {
  pubManualOpen = !pubManualOpen;
  if (currentStatus) renderPublish(currentStatus, Date.now());
}
function collapsePubManual() {
  if (!pubManualOpen) return;
  pubManualOpen = false;
  if (currentStatus) renderPublish(currentStatus, Date.now());
}
fields.pubBar.addEventListener('click', togglePubManual);
fields.pubBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') togglePubManual();
});
fields.pubHeadRow.addEventListener('click', collapsePubManual);
fields.pubHeadRow.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') collapsePubManual();
});

// 「打开飞书 ↗」：纯导航（拉起飞书客户端），不是审批操作；拉不起降级为纯文字说明。
fields.pubLink.addEventListener('click', async () => {
  const api = window.aidcpEdge.openFeishu;
  if (!api) return;
  const res = await api();
  if (!res || !res.ok) {
    fields.pubLink.textContent = '在手机或电脑上打开飞书即可处理';
    fields.pubLink.classList.add('plain');
  }
});

// ─── 叙述式活动流（环形 ≤200 条，最新在上）───
const STREAM_MAX = 200;
// 事件类型 → 图标字 + 色调（给纯文字流加视觉锚点；这是类型记号，不是 App 图标）。
const EV_ICONS = [
  [/^(like|comment_like|follow)$/, ['赞', 'ic-like']],
  [/^collect$/, ['藏', 'ic-collect']],
  [/^comment$/, ['评', 'ic-comment']],
  [/^(note_open|images|profile_read)$/, ['读', 'ic-read']],
  [/^popup/, ['注', 'ic-warn']],
  [/^publish/, ['发', 'ic-pub']],
];
function evIcon(type) {
  for (const [re, spec] of EV_ICONS) if (re.test(type || '')) return spec;
  return ['·', 'ic-sys'];
}
function domPrependActivity(entry, extraClass) {
  if (!entry || !entry.sentence) return;
  if (fields.streamEmpty) fields.streamEmpty.classList.add('hidden');
  const row = document.createElement('div');
  row.className = `ev${extraClass ? ` ${extraClass}` : ''}`;
  row.dataset.ts = entry.ts || new Date().toISOString();
  const t = document.createElement('span');
  t.className = 'ev-t';
  t.textContent = uiLogic.relTime(Date.parse(row.dataset.ts), Date.now());
  const [glyph, iconCls] = evIcon(entry.type);
  const ic = document.createElement('span');
  ic.className = `ev-ic ${iconCls}`;
  ic.textContent = glyph;
  const x = document.createElement('span');
  x.className = 'ev-x';
  x.textContent = entry.sentence;
  row.appendChild(t);
  row.appendChild(ic);
  row.appendChild(x);
  fields.stream.insertBefore(row, fields.stream.firstChild);
  while (fields.stream.querySelectorAll('.ev').length > STREAM_MAX) {
    const evs = fields.stream.querySelectorAll('.ev');
    evs[evs.length - 1].remove();
  }
}

// 每环境活动缓冲（旧→新，≤200 条）：切换环境时按缓冲重建流，绝不串号。
function bufferActivity(envKey, entry, cls) {
  const arr = fleetView.buffers.get(envKey) || [];
  arr.push({ entry, cls });
  while (arr.length > STREAM_MAX) arr.shift();
  fleetView.buffers.set(envKey, arr);
}

/** 面向「当前选中环境」的活动追加（渲染层内部合成的条目也经此入缓冲）。 */
function prependActivity(entry, extraClass) {
  if (!entry || !entry.sentence) return;
  bufferActivity(routeSelKey(), entry, extraClass);
  domPrependActivity(entry, extraClass);
}

/** 主进程活动广播入口：按 entry.envId 归属；非选中环境只进缓冲、不上屏。 */
function routeActivity(entry) {
  if (!entry || !entry.sentence) return;
  const key = entry.envId || routeSelKey();
  bufferActivity(key, entry, undefined);
  if (key === routeSelKey()) domPrependActivity(entry);
}

/** 切换环境后按缓冲整体重建活动流 DOM（旧→新逐条前插 → 最新在上）。 */
function rebuildActivityStream() {
  fields.stream.querySelectorAll('.ev').forEach((row) => row.remove());
  const arr = fleetView.buffers.get(routeSelKey()) || [];
  if (fields.streamEmpty) fields.streamEmpty.classList.toggle('hidden', arr.length > 0);
  for (const item of arr) domPrependActivity(item.entry, item.cls);
}

// 每秒走字：在场感新鲜度 / 发布卡等待时长 / 活动流相对时间（真实时间，不造活跃）。
setInterval(() => {
  if (!currentStatus) return;
  const now = Date.now();
  renderUsageSummary(currentStatus);
  renderPresence(currentStatus, now);
  renderPublish(currentStatus, now);
  fields.stream.querySelectorAll('.ev').forEach((row) => {
    const ts = Date.parse(row.dataset.ts || '');
    if (Number.isFinite(ts)) row.querySelector('.ev-t').textContent = uiLogic.relTime(ts, now);
  });
  renderRail(); // 失联（stale）判定依赖走钟，每秒重估状态环
}, 1000);

function toggleQuotaDetails() {
  quotaDetailsOpen = !quotaDetailsOpen;
  if (currentStatus) renderUsageSummary(currentStatus);
}

fields.dailySummary?.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  toggleQuotaDetails();
});
fields.quotaToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleQuotaDetails();
});

// ─── 健康明细浮层 ───
fields.healthPill.addEventListener('click', (event) => {
  event.stopPropagation();
  fields.healthPop.classList.toggle('hidden');
});
document.addEventListener('click', (event) => {
  if (!fields.healthPop.classList.contains('hidden') && !fields.healthPop.contains(event.target)) {
    fields.healthPop.classList.add('hidden');
  }
});

// ─── 设置抽屉 ───
function openDrawer() {
  fields.drawer.classList.add('open');
  fields.drawer.setAttribute('aria-hidden', 'false');
  fields.drawerMask.classList.remove('hidden');
}
function closeDrawer() {
  fields.drawer.classList.remove('open');
  fields.drawer.setAttribute('aria-hidden', 'true');
  fields.drawerMask.classList.add('hidden');
}
fields.gear.addEventListener('click', openDrawer);
fields.drawerClose.addEventListener('click', closeDrawer);
fields.drawerMask.addEventListener('click', closeDrawer);
fields.noticeAction.addEventListener('click', openDrawer);

// ─── 开发者详情：默认不展示，设置抽屉里开关（persisted）───
const devSection = document.querySelector('#dev-section');
const devToggle = document.querySelector('#dev-toggle');
function applyDevVisible(v) {
  devSection.classList.toggle('hidden', !v);
  devToggle.checked = Boolean(v);
}
devToggle.addEventListener('change', () => {
  applyDevVisible(devToggle.checked);
  window.aidcpEdge.saveSettings({ devDetails: devToggle.checked }); // 独立持久化，不打断在跑核心
});

// 悬浮会话按钮三态：已暂停→恢复 / 已停止（或异常）→启动 / 其余（运行·启动中）→暂停。
function renderFab(status) {
  const fab = fields.sessionFab;
  let text;
  let cls;
  let action;
  if (status.session === 'paused') {
    text = '恢复';
    cls = 'resume';
    action = 'resume';
  } else if (status.edge === 'stopped' || status.edge === 'warning') {
    text = '启动';
    cls = 'start';
    action = 'start';
  } else {
    text = '暂停';
    cls = 'pause';
    action = 'pause';
  }
  fab.textContent = text;
  fab.className = `fab ${cls}`;
  fab.dataset.action = action;
}

// 内嵌运行时首启内核准备进度条：仅在 kernelPrep 处于下载/安装态时显示；null/完成/失败态隐藏（失败走 edge-failure 呈现）。
function renderKernelPrep(status) {
  if (!fields.kernelPrep) return;
  const kp = status.kernelPrep;
  const active = kp && (kp.state === 'pending' || kp.state === 'downloading' || kp.state === 'installing');
  fields.kernelPrep.classList.toggle('hidden', !active);
  if (!active) return;
  const pct = Math.max(0, Math.min(100, Number(kp.percent) || 0));
  const stateLabel = kp.state === 'installing' ? '正在安装浏览器内核' : '正在下载浏览器内核';
  fields.kernelPrepLabel.textContent = `${stateLabel} ${kp.version || ''}…`.trim();
  fields.kernelPrepPct.textContent = `${pct}%`;
  fields.kernelPrepBar.style.width = `${pct}%`;
}

function render(status) {
  currentStatus = status;
  const now = Date.now();
  setBadge(fields.auth, 'auth', status.auth);
  setBadge(fields.cloud, 'cloud', status.cloud);
  setBadge(fields.session, 'session', status.session);
  setBadge(fields.risk, 'risk', status.risk);
  setBadge(fields.edge, 'edge', status.edge);
  renderUsageSummary(status); // 各计数一律 ?? 0 兜底（旧形状 / 部分补丁都不出空数字）
  // 原始日志记录已移到 routeStatus（按 envId 分桶、覆盖未选中环境）；此处仅刷当前环境的日志 DOM。
  renderLog();
  renderEdgeFailure(status);
  renderTitlebar(status);
  renderPresence(status, now);
  renderKernelPrep(status);
  renderLoop(status);
  renderPublish(status, now);
  renderFab(status);
  renderNotice(status);
  renderSameAccount(status); // 同账号铺多环境告警（多环境 fleet；无告警字段时隐藏，零回归）
  updateApplyRestart(); // 依「dirty && 核心在跑」决定是否显示「按新设置重启」
  if (status.provider && SUBTITLE[status.provider]) fields.subtitle.textContent = SUBTITLE[status.provider];
  // 表单未在编辑时，让 provider 分段跟随实际运行 provider。
  if (status.provider && !editingProvider) applyProviderSelection(status.provider);
  updatePersonaGate(status); // 建号人设：仅登录+云端已连接才可生成（不触碰已选关键词/草稿，避免状态推送重置向导）
}

// ─── 多环境 fleet：状态路由 / 环境栏 / 引导处理 / 全部启动（edge-multi-environment-fleet）───

function renderSameAccount(status) {
  if (!fields.sameAccountWarn) return;
  const warn = status && status.sameAccountWarning;
  fields.sameAccountWarn.classList.toggle('hidden', !warn);
  if (warn && fields.sameAccountText) fields.sameAccountText.textContent = warn.message || '';
}

/** 主进程状态推送入口：按 envId 归属到对应环境；仅选中环境上屏。无 envId 的旧形状归 '__local__'。 */
function routeStatus(status) {
  if (!status) return;
  const key = status.envId || '__local__';
  let env = fleetView.envs.get(key);
  if (!env) {
    env = { envId: key, name: status.envName || '', platform: '', status };
    fleetView.envs.set(key, env);
    if (!fleetView.order.includes(key)) fleetView.order.push(key);
  } else {
    env.status = status;
    if (status.envName) env.name = status.envName;
  }
  if (!fleetView.selected) fleetView.selected = key;
  // 原始日志与发布终态折流对**每个**环境记录（含未选中）：未选中环境的日志进其桶、发布终态折进其活动缓冲，
  // 切过去时历史完整、绝不丢，也绝不串到别的环境。
  recordLog(key, status.lastMessage);
  absorbPublishTerminal(key, status);
  if (fleetView.selected === key) render(status);
  renderRail();
  maybeAdvanceGuide();
  updateStartAllProgress(); // 「全部启动」进度随各环境起来实时推进 k/N
}

// 发布终态（published/rejected/failed）折一条叙述进**该环境**的活动缓冲，按签名去重（每环境独立）。
// 覆盖未选中环境（渲染层的 renderPublish 只跑选中环境，会漏掉后台环境的发布叙述）。
function absorbPublishTerminal(envKey, status) {
  if (!status || !status.publish || !window.uiLogic) return;
  const view = uiLogic.publishView(status.publish, status.lastPublish, Date.now());
  if (!view.collapsed) { lastPublishSigByEnv.set(envKey, `${status.publish.state}:${status.publish.title || ''}`); return; }
  const sig = `${status.publish.state}:${status.publish.title || ''}`;
  if (sig === (lastPublishSigByEnv.get(envKey) || '')) return;
  lastPublishSigByEnv.set(envKey, sig);
  const entry = {
    ts: status.publish.at || new Date().toISOString(),
    type: `publish_${view.collapsed.type}`,
    sentence: view.collapsed.sentence,
  };
  const cls = view.collapsed.type === 'published' ? 'pub-done' : 'pub-muted';
  bufferActivity(envKey, entry, cls);
  if (envKey === routeSelKey()) domPrependActivity(entry, cls);
}

/** fleet 快照（花名册 + 各环境状态 + 选中项）全量对齐：建行 / 摘行 / 同步选中与收展。 */
function applyFleetSnapshot(snap) {
  if (!snap || !Array.isArray(snap.environments)) return;
  const known = new Set();
  fleetView.order = [];
  for (const e of snap.environments) {
    if (!e || !e.envId) continue;
    known.add(e.envId);
    fleetView.order.push(e.envId);
    const existing = fleetView.envs.get(e.envId);
    if (existing) {
      existing.name = e.name || existing.name;
      existing.platform = e.platform || existing.platform;
      if (e.status) existing.status = e.status;
    } else {
      fleetView.envs.set(e.envId, { envId: e.envId, name: e.name || '', platform: e.platform || '', status: e.status });
    }
  }
  for (const key of [...fleetView.envs.keys()]) {
    if (known.has(key)) continue;
    fleetView.envs.delete(key); // 快照为准（含 '__local__' 占位）
    // 连同该环境的所有渲染层缓冲一并清（否则同一分身移出再加回会重放上一会话的陈旧活动 + 吞掉新发布折流，
    // 还有全会话内存泄漏）。
    fleetView.buffers.delete(key);
    fleetView.logs.delete(key);
    lastPublishSigByEnv.delete(key);
  }
  if (typeof snap.railCollapsed === 'boolean') fleetView.collapsed = snap.railCollapsed;
  const prevSelected = fleetView.selected;
  if (snap.selectedEnvId && fleetView.envs.has(snap.selectedEnvId)) fleetView.selected = snap.selectedEnvId;
  if (!fleetView.selected || !fleetView.envs.has(fleetView.selected)) fleetView.selected = fleetView.order[0] || null;
  if (fleetView.selected && fleetView.selected !== prevSelected) {
    pubManualOpen = false;
    resetPersonaDraft();
    const env = fleetView.envs.get(fleetView.selected);
    if (env && env.status) render(env.status);
    rebuildActivityStream();
  }
  renderRail();
}

/** 点选环境：右侧主区域整体切到该环境的陪伴视图（状态 + 活动流 + 发布卡投影一起换，绝不残留）。 */
function selectEnv(envId) {
  if (!envId || !fleetView.envs.has(envId) || envId === fleetView.selected) return;
  fleetView.selected = envId;
  pubManualOpen = false;
  resetPersonaDraft(); // 人设向导每环境独立：切换即清草稿，绝不把 A 的草稿误确认到 B
  window.aidcpEdge.fleetSelect?.(envId);
  const env = fleetView.envs.get(envId);
  if (env && env.status) render(env.status);
  rebuildActivityStream();
  renderRail();
}

function railEnvList() {
  return fleetView.order
    .filter((id) => id !== '__local__')
    .map((id) => fleetView.envs.get(id))
    .filter(Boolean);
}

function renderRail() {
  if (!fields.envRail || !window.uiLogic || typeof uiLogic.fleetRailModel !== 'function') return;
  const list = railEnvList();
  const show = list.length > 0;
  fields.envRail.classList.toggle('hidden', !show);
  fields.fleetRow?.classList.toggle('with-rail', show);
  if (!show) { fleetView.lastRailSig = ''; return; }
  const model = uiLogic.fleetRailModel(list, Date.now());
  // 变更签名：每秒 stale 重估会反复调本函数，但只有模型真变时才重建 DOM——否则 innerHTML='' 会每秒
  // 打断 1.6s 脉冲动画（视觉抖动）、把行焦点甩回 <body>、并吞掉跨 tick 的点击手势。
  const sig = JSON.stringify({
    show,
    collapsed: fleetView.collapsed,
    selected: fleetView.selected,
    guided: Boolean(fleetView.guided),
    rows: model.rows.map((r) => [r.envId, r.level, r.needsAction, r.name || (r.status && r.status.account && r.status.account.name) || '', r.label]),
  });
  if (sig === fleetView.lastRailSig) return;
  fleetView.lastRailSig = sig;
  fields.envRail.classList.toggle('collapsed', fleetView.collapsed);
  fields.envRail.classList.toggle('expanded', !fleetView.collapsed);
  if (fields.railToggle) {
    fields.railToggle.title = fleetView.collapsed ? '展开环境列表' : '收起环境列表';
    fields.railToggle.setAttribute('aria-label', fields.railToggle.title);
  }
  if (fields.railBadge) {
    fields.railBadge.textContent = String(model.pendingCount);
    fields.railBadge.classList.toggle('hidden', model.pendingCount === 0);
  }
  if (fields.railGuide) {
    fields.railGuide.classList.toggle('hidden', model.pendingCount === 0 && !fleetView.guided);
    fields.railGuide.textContent = model.pendingCount > 0 ? `引导处理（${model.pendingCount}）` : '引导处理';
  }
  if (!fields.railList) return;
  fields.railList.innerHTML = '';
  for (const row of model.rows) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `rail-row lv-${row.level}${row.needsAction ? ' pulse' : ''}${row.envId === fleetView.selected ? ' selected' : ''}`;
    btn.dataset.envId = row.envId;
    const displayName = row.name || (row.status && row.status.account && row.status.account.name) || `环境 …${String(row.envId).slice(-4)}`;
    btn.title = `${displayName} · ${row.label}`; // 收起态悬停出名字与状态
    const ava = document.createElement('span');
    ava.className = 'rail-ava';
    ava.textContent = displayName.slice(0, 1);
    btn.appendChild(ava);
    const meta = document.createElement('span');
    meta.className = 'rail-meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'rail-name';
    nameEl.textContent = displayName;
    const stateEl = document.createElement('span');
    stateEl.className = 'rail-state';
    stateEl.textContent = row.label;
    meta.appendChild(nameEl);
    meta.appendChild(stateEl);
    btn.appendChild(meta);
    btn.addEventListener('click', () => selectEnv(row.envId));
    fields.railList.appendChild(btn);
  }
}

function setRailMsg(text) {
  if (fields.railMsg) fields.railMsg.textContent = text || '';
}

fields.railToggle?.addEventListener('click', () => {
  fleetView.collapsed = !fleetView.collapsed;
  window.aidcpEdge.fleetSetRailCollapsed?.(fleetView.collapsed);
  renderRail();
});

// ── 「全部启动」：内存上限预检，超限诚实拦阻、让运维确认后 force 放行 ──
async function doStartAll(force) {
  const api = window.aidcpEdge.fleetStartAll;
  if (typeof api !== 'function') return;
  fields.railRamConfirm?.classList.add('hidden');
  const res = await api(force ? { force: true } : undefined);
  if (res && res.ok === false && res.reason === 'ram') {
    if (fields.railRamText) {
      fields.railRamText.textContent = `预计需 ~${res.requiredMB}MB 内存（${res.plannedCount} 个环境 × ~1GB），本机当前可用 ~${res.freeMB}MB，可能不足并拖垮已在跑的环境。仍要全部启动吗？`;
    }
    fields.railRamConfirm?.classList.remove('hidden');
    return;
  }
  if (res && res.ok) {
    if (res.queued > 0 && Array.isArray(res.envIds)) {
      fleetView.startAll = { ids: res.envIds, total: res.queued };
      updateStartAllProgress();
    } else if (res.queued > 0) {
      setRailMsg(`已错峰排队启动 ${res.queued} 个环境（相邻间隔约 1.1s）。`); // 旧主进程无 envIds 时兜底
    } else {
      setRailMsg('没有待启动的环境。');
    }
  }
}

// 「全部启动」实时进度（如实呈现 k/N，不是一句静态提示）：随各环境状态推送重算已起数，全起后收尾。
// 精确「下一个 Ns 后」倒计时依赖错峰队列时序（未透传渲染层），当前以每行「第 N 位」传达顺序。
function updateStartAllProgress() {
  const sa = fleetView.startAll;
  if (!sa) return;
  const launched = sa.ids.filter((id) => {
    const e = fleetView.envs.get(id);
    return e && e.status && e.status.edge === 'running';
  }).length;
  if (launched >= sa.total) {
    setRailMsg(`已全部启动（${sa.total}/${sa.total}）。`);
    fleetView.startAll = null;
    return;
  }
  setRailMsg(`启动中 ${launched}/${sa.total} · 其余 ${sa.total - launched} 个错峰排队（相邻约 1.1s）…`);
}
fields.railStartAll?.addEventListener('click', () => { void doStartAll(false); });
fields.railRamForce?.addEventListener('click', () => { void doStartAll(true); });
fields.railRamCancel?.addEventListener('click', () => fields.railRamConfirm?.classList.add('hidden'));

// ── 引导式登录 / 验证码流：待处理环境排队、一次引导一个；新到项实时并入（队列每步重算）──
function guideQueue() {
  if (!fleetView.guided) return [];
  const model = uiLogic.fleetRailModel(railEnvList(), Date.now());
  return model.rows.filter((r) => r.needsAction && !fleetView.guided.done.has(r.envId));
}

function setGuideHint(text) {
  if (!fields.guideHint) return;
  fields.guideHint.textContent = text || '';
  fields.guideHint.classList.toggle('hidden', !text);
}

function exitGuide(message) {
  fleetView.guided = null;
  fields.guidePanel?.classList.add('hidden');
  setGuideHint(message || '');
  renderRail();
}

function showGuideStep() {
  const q = guideQueue();
  if (q.length === 0) {
    exitGuide('全部待处理环境已处理完成。');
    return;
  }
  const target = q[0];
  fleetView.guided.current = target.envId;
  selectEnv(target.envId);
  const displayName = target.name || `环境 …${String(target.envId).slice(-4)}`;
  if (fields.guideTitle) fields.guideTitle.textContent = `引导处理（剩 ${q.length} 个）：${displayName}`;
  if (fields.guideBody) {
    fields.guideBody.textContent = `当前状态：${target.label}。点「打开窗口」找到它的浏览器窗口，在窗口里完成登录 / 验证码后点「完成 · 重检」。`;
  }
  fields.guidePanel?.classList.remove('hidden');
}

function startGuide() {
  fleetView.guided = { done: new Set(), current: null };
  setGuideHint('');
  showGuideStep();
}

/** 状态推送后：当前引导中的环境**真正恢复**（核心在跑且不再需处理）→ 自动续跑并前进到下一个。
 * 红线修正：绝不在 relogin 重启的 checking/starting/stopped 瞬态（needsAction 短暂为 false）误判已恢复
 * ——那会把「登录其实没完成」的环境错误退休、永久踢出引导队列。只认「edge 在跑且不需处理」这个正向成功信号。 */
function maybeAdvanceGuide() {
  if (!fleetView.guided || !fleetView.guided.current) return;
  const env = fleetView.envs.get(fleetView.guided.current);
  if (!env) { // 环境被移出花名册：视为完成，前进
    fleetView.guided.done.add(fleetView.guided.current);
    showGuideStep();
    return;
  }
  const lv = uiLogic.fleetLevel(env.status, Date.now());
  const recovered = !lv.needsAction && env.status && env.status.edge === 'running';
  if (recovered) {
    fleetView.guided.done.add(fleetView.guided.current);
    setGuideHint(`「${env.name || env.envId}」已恢复（${lv.label}），前进到下一个。`);
    showGuideStep();
  }
}

fields.railGuide?.addEventListener('click', startGuide);
fields.guideExit?.addEventListener('click', () => exitGuide(''));
fields.guideSkip?.addEventListener('click', () => {
  if (!fleetView.guided || !fleetView.guided.current) return;
  fleetView.guided.done.add(fleetView.guided.current);
  showGuideStep();
});
fields.guideOpen?.addEventListener('click', async () => {
  const envId = fleetView.guided && fleetView.guided.current;
  if (!envId || typeof window.aidcpEdge.showDrivenBrowser !== 'function') return;
  const r = await window.aidcpEdge.showDrivenBrowser(envId);
  // 诚实红线：抬不动 / 无法保证抬前时告知窗口所在，绝不假装已抬前。
  setGuideHint(r && r.ok ? (r.hint || '已请求把该环境的浏览器窗口前置。') : `打开窗口失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`);
});
fields.guideDone?.addEventListener('click', async () => {
  const envId = fleetView.guided && fleetView.guided.current;
  if (!envId || typeof window.aidcpEdge.relogin !== 'function') return;
  setGuideHint('已触发该环境重新登录 / 重检，恢复后会自动前进到下一个…');
  await window.aidcpEdge.relogin(envId);
});

// ─── Browser provider settings（既有逻辑原样保留，DOM 已迁入抽屉）───

function applyProviderSelection(provider) {
  const isChrome = provider === 'self';
  // 开关：开=本机 Chrome(self)，关=默认内置 AdsPower。AdsPower 环境卡仅在关(=adspower)时显示。
  settingsUi.useChrome.checked = isChrome;
  settingsUi.adsConfig.classList.toggle('hidden', isChrome);
}

// dirty 且核心在跑（非停止/异常）时才显示「按新设置重启」——把已改设置显式应用到在跑核心。
function updateApplyRestart() {
  const running = Boolean(currentStatus) && currentStatus.edge !== 'stopped' && currentStatus.edge !== 'warning';
  settingsUi.applyRestart.classList.toggle('hidden', !(dirty && running));
}

function markDirty() {
  dirty = true;
  updateApplyRestart();
}

// 保存前把「手动填写的分身 ID」并入花名册（兜底路径也是一个成员；重复 id 不复加）。
function rosterForSave() {
  const val = settingsUi.adsProfile.value.trim();
  const list = roster.map((m) => ({ ...m }));
  if (val && !list.some((m) => m.profileId === val)) {
    list.push({ profileId: val, name: selectedProfileName, platform: selectedPlatform });
  }
  return list;
}

// 保存当前表单设置（供「启动」「按新设置重启」复用；无独立保存按钮）。返回 saveSettings 结果。
async function saveCurrentSettings() {
  const provider = selectedProvider();
  const environments = rosterForSave();
  const saved = await window.aidcpEdge.saveSettings({
    provider,
    browserParkingMode: selectedParkingMode(),
    adsProfileId: settingsUi.adsProfile.value.trim(),
    adsProfileName: selectedProfileName,
    platform: selectedPlatform,
    adsApiKey: settingsUi.adsApiKey.value,
    adsApiBase: settingsUi.adsApiBase.value.trim(),
    environments,
  });
  roster = normalizeRosterList((saved && saved.environments) || environments);
  refreshRosterMarks();
  dirty = false;
  // 表单已落盘 = 与持久化/在跑设置一致：解除「编辑中不回填」闩锁，让后续状态推送可再跟随实际 provider。
  // （否则点过一次 provider 分段后，render 的「跟随实际 provider」分支被永久旁路，段选可能与在跑 provider 不符。）
  editingProvider = null;
  updateApplyRestart();
  return saved;
}

// 重启类动作（恢复 / 重新登录）前的落盘闸：这些动作都会按【持久化设置】重起核心进程，
// 而选环境 / 改 provider 等只改了本地表单（markDirty）、未落盘。若有未保存改动则先存再重启，
// 否则核心会按旧设置重起——用户「暂停中切换的新环境」不生效（暂停态下「按新设置重启」按钮隐藏、
// 「恢复」是唯一控件，故必须在此吸收未保存改动）。返回 true=可继续；false=因缺分身 ID 被拦下、调用方应中止。
async function persistDirtyBeforeRestart(okMessage) {
  if (!dirty) return true;
  if (selectedProvider() === 'adspower' && !settingsUi.adsProfile.value.trim()) {
    promptMissingAdsProfile();
    return false;
  }
  const saved = await saveCurrentSettings();
  settingsUi.msg.textContent = saved && saved.saveOk === false
    ? `设置本次生效但写盘失败：${saved.saveError || ''}（重启应用后可能丢失）`
    : okMessage;
  return true;
}

function selectedProvider() {
  return settingsUi.useChrome.checked ? 'self' : 'adspower';
}

function selectedParkingMode() {
  const active = settingsUi.parkingButtons.find((btn) => btn.classList.contains('active'));
  const mode = active && active.dataset ? active.dataset.mode : '';
  return PARKING_MODES.has(mode) ? mode : 'edge-strip';
}

function applyParkingSelection(mode) {
  const safe = PARKING_MODES.has(mode) ? mode : 'edge-strip';
  for (const btn of settingsUi.parkingButtons) {
    btn.classList.toggle('active', btn.dataset.mode === safe);
  }
}

function promptMissingAdsProfile() {
  settingsUi.msg.textContent = '请先选择一个环境，或在「高级设置」里打开「手动填写」填分身 ID。';
  openDrawer();
}

// 分身 ID 只读展示：默认由选中环境带出；手动模式时改由输入框承载。
function updateProfileDisplay() {
  const v = settingsUi.adsProfile.value.trim();
  settingsUi.adsProfileDisplay.textContent = v || '（请从上方选择一个环境）';
  settingsUi.adsProfileDisplay.classList.toggle('empty', !v);
}

function applySettings(s) {
  if (!s) return;
  selectedProfileName = s.adsProfileName || '';
  selectedPlatform = normPlatform(s.platform);
  // 花名册：新形状 environments 优先；旧单值 adsProfileId 向后兼容加载为单元素花名册。
  roster = Array.isArray(s.environments) && s.environments.length > 0
    ? normalizeRosterList(s.environments)
    : normalizeRosterList(s.adsProfileId ? [{ profileId: s.adsProfileId, name: s.adsProfileName, platform: s.platform }] : []);
  if (typeof s.railCollapsed === 'boolean') fleetView.collapsed = s.railCollapsed;
  applyDevVisible(Boolean(s.devDetails));
  settingsUi.adsProfile.value = s.adsProfileId || '';
  settingsUi.adsApiKey.value = s.adsApiKey || '';
  settingsUi.adsApiBase.value = s.adsApiBase || '';
  applyParkingSelection(s.browserParkingMode || 'edge-strip');
  updateProfileDisplay();
  editingProvider = null;
  dirty = false;
  applyProviderSelection(s.provider || 'adspower');
  updateApplyRestart();
}

settingsUi.useChrome.addEventListener('change', () => {
  const provider = selectedProvider();
  editingProvider = provider;
  markDirty();
  applyProviderSelection(provider);
  if (provider === 'adspower') probeAds(); // 切回 AdsPower 即探一次可用性并列环境
});

settingsUi.adsAdvancedToggle.addEventListener('click', () => {
  const hidden = settingsUi.adsAdvanced.classList.toggle('hidden');
  settingsUi.adsAdvancedToggle.textContent = hidden ? '高级设置 ▾' : '高级设置 ▴';
});

// 分身 ID / 手动填写 收在「高级设置」里；需要手动兜底时（探测未就绪 / 拉取失败）自动展开，免得用户去找。
function openAdvanced() {
  settingsUi.adsAdvanced.classList.remove('hidden');
  settingsUi.adsAdvancedToggle.textContent = '高级设置 ▴';
}

// 「手动填写」开关：开=显示手敲输入框；关=用选中环境的值（只读展示）。
settingsUi.adsManual.addEventListener('change', () => {
  const manual = settingsUi.adsManual.checked;
  settingsUi.adsProfile.classList.toggle('hidden', !manual);
  settingsUi.adsProfileDisplay.classList.toggle('hidden', manual);
  if (manual) settingsUi.adsProfile.focus();
  else updateProfileDisplay();
});
settingsUi.adsProfile.addEventListener('input', () => {
  selectedProfileName = ''; // 手填 id 对不上环境名，不冒认
  selectedPlatform = 'xiaohongshu'; // 手填 id 平台未知 → 回落小红书（与历史一致，零回归）；需 FB 则经环境列表选中
  updateProfileDisplay();
  markDirty();
});
settingsUi.adsApiBase.addEventListener('input', markDirty);
settingsUi.adsApiKey.addEventListener('input', markDirty);
for (const btn of settingsUi.parkingButtons) {
  btn.addEventListener('click', () => {
    applyParkingSelection(btn.dataset.mode);
    markDirty();
  });
}

async function runBrowserRecovery(action) {
  const api = action === 'show' ? window.aidcpEdge.showDrivenBrowser : window.aidcpEdge.resetBrowserParking;
  if (typeof api !== 'function') return;
  const label = action === 'show' ? '显示浏览器' : '重置浏览器位置';
  try {
    const r = await api(currentEnvId());
    // 诚实边界：外壳只能「尽力抬前」，成功回执带窗口所在提示（r.hint），绝不宣称已抬到最前。
    settingsUi.msg.textContent = r && r.ok ? (r.hint || `${label}指令已发送。`) : `${label}失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`;
  } catch (e) {
    settingsUi.msg.textContent = `${label}失败：${(e && e.message) || e}`;
  }
}
settingsUi.browserShow.addEventListener('click', () => runBrowserRecovery('show'));
settingsUi.browserResetParking.addEventListener('click', () => runBrowserRecovery('reset'));

// ─── AdsPower 探测 / 环境列表 / 新建入口 ───

// 只读调用带上「当前表单值」（调用级）：支持「新填 API Key 未保存即刷新」而不陷回环。
function formAdsOpts() {
  return {
    apiBase: settingsUi.adsApiBase.value.trim(),
    apiKey: settingsUi.adsApiKey.value,
  };
}

function setEnvMsg(text, isError) {
  settingsUi.adsEnvMsg.textContent = text || '';
  settingsUi.adsEnvMsg.className = `ads-env-msg${isError ? ' error' : ''}`;
}

// 静默探测本地 API（根级 /status）以填充环境列表：可达→列环境；不可达→诚实提示于环境行、不禁死流程
// （启动时应用会自动拉起内置 AdsPower 运行时；此处不再有可见「检测」按钮/状态徽标）。
async function probeAds() {
  try {
    const r = await window.aidcpEdge.adsStatus(formAdsOpts());
    if (r && r.ok) {
      if (settingsUi.adsEnvMsg.classList.contains('error')) setEnvMsg('', false);
      refreshEnvs(); // 就绪即自动列出环境，无需先点刷新
    } else {
      setEnvMsg(
        `暂未连接到本地指纹浏览器服务${r && r.error ? '（' + r.error + '）' : ''}。启动后应用会自动拉起内置运行时；也可在「高级设置」打开「手动填写」直接填分身 ID。`,
        true,
      );
      openAdvanced();
    }
  } catch {
    setEnvMsg('检测本地指纹浏览器服务失败。', true);
  }
}

// 选中某环境：把其 user_id（非 serial_number）设为将写入的分身 ID，并高亮该行；顺手记环境名作账号标签
// 与该环境的平台（platform，来自其 remark；同步进 settings 供启动注入 AIDCP_PLATFORM）。
// 多环境（edge-multi-environment-fleet）：选中即**加入运行花名册**（多选累积）；已在花名册的成员
// 再点只切换当前值、诚实提示已加入，MUST NOT 重复出现两次（防 edgeId 撞车）。
function selectProfile(userId, itemEl, profileName, platform) {
  settingsUi.adsProfile.value = userId;
  selectedProfileName = profileName || '';
  selectedPlatform = normPlatform(platform);
  if (userId && !rosterHas(userId)) {
    roster.push({ profileId: userId, name: profileName || '', platform: normPlatform(platform) });
  } else if (userId) {
    setEnvMsg(`「${profileName || userId}」已在运行花名册中。`, false);
  }
  updateProfileDisplay();
  markDirty();
  settingsUi.adsEnvList.querySelectorAll('.ads-env-item').forEach((el) => el.classList.remove('selected'));
  if (itemEl) itemEl.classList.add('selected');
  refreshRosterMarks();
}

// 从花名册移出一个成员；若其恰为当前分身 ID，则回落到剩余首个成员（或清空）。
function removeFromRoster(profileId) {
  roster = roster.filter((m) => m.profileId !== profileId);
  if (settingsUi.adsProfile.value.trim() === profileId) {
    const next = roster[0];
    settingsUi.adsProfile.value = next ? next.profileId : '';
    selectedProfileName = next ? next.name : '';
    selectedPlatform = next ? normPlatform(next.platform) : 'xiaohongshu';
    updateProfileDisplay();
  }
  markDirty();
  refreshRosterMarks();
}

// roster 变更后就地重刷环境列表的成员标记（不重新拉取）。
function refreshRosterMarks() {
  if (lastProfiles.length > 0) populateEnvs(lastProfiles);
}

// 核心是否在跑（自动选中的闸：在跑时绝不替用户改配置）。
function coreRunning() {
  return Boolean(currentStatus) && currentStatus.edge !== 'stopped' && currentStatus.edge !== 'warning';
}

// 每行删除按钮：点两次确认（第一次「删」→「确认删除?」armed 态，4s 自动收回；第二次才真删）。
// 删除不可恢复（若已登录账号其登录态一并丢失）——故绝不一次点就删、绝不自动/批量（C3 放宽为 UI 确认删）。
function makeDeleteBtn(prof) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ads-env-del';
  btn.textContent = '删';
  let armed = false;
  let timer = null;
  const disarm = () => {
    armed = false;
    btn.textContent = '删';
    btn.classList.remove('armed');
    if (timer) { clearTimeout(timer); timer = null; }
  };
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // 不触发行选中
    if (!armed) {
      armed = true;
      btn.textContent = '确认删除?';
      btn.classList.add('armed');
      btn.title = `永久删除「${prof.name || prof.userId}」，不可恢复；若已登录账号其登录态一并丢失`;
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    if (!window.aidcpEdge || typeof window.aidcpEdge.adsDeleteEnv !== 'function') return;
    btn.disabled = true;
    setEnvMsg(`正在删除「${prof.name || prof.userId}」…`, false);
    try {
      const r = await window.aidcpEdge.adsDeleteEnv({ ...formAdsOpts(), userId: prof.userId });
      if (r && r.ok) {
        setEnvMsg(`已删除环境「${prof.name || prof.userId}」。`, false);
        refreshEnvs();
      } else {
        setEnvMsg(`删除失败：${(r && r.error) || '未知错误'}`, true);
        btn.disabled = false;
      }
    } catch {
      btn.disabled = false;
    }
  });
  return btn;
}

// 直接把环境铺成可点行（非下拉）。每行：名称 + 序号/分组/代理配置/user_id + 成员标记/移出 + 删除按钮。
// 多选（edge-multi-environment-fleet）：点行 = 加入运行花名册（已加入的行带「已加入」标记与「移出」钮）。
// 返回 { autoSelected }：恰好一个环境、花名册为空且核心未在跑时自动加入（spec：唯一环境自动加入花名册；
// 多环境不代选、已有成员不覆盖、在跑不动配置）。
function populateEnvs(profiles) {
  lastProfiles = Array.isArray(profiles) ? profiles : [];
  const list = settingsUi.adsEnvList;
  const current = settingsUi.adsProfile.value.trim();
  list.innerHTML = '';
  if (!profiles.length) {
    const empty = document.createElement('p');
    empty.className = 'ads-env-empty';
    empty.textContent = '（未找到环境，可在「高级设置」打开「手动填写」填分身 ID）';
    list.appendChild(empty);
    return { autoSelected: null };
  }
  let firstItem = null;
  let currentSelected = null;
  for (const prof of profiles) {
    const item = document.createElement('div');
    item.className = 'ads-env-item';
    const text = document.createElement('div');
    text.className = 'env-text';
    const name = document.createElement('div');
    name.className = 'env-name';
    name.textContent = prof.name || '(未命名)';
    const meta = document.createElement('div');
    meta.className = 'env-meta';
    const bits = [];
    bits.push(platformLabel(prof.platform)); // 平台标签（小红书 / Facebook）
    if (prof.serialNumber) bits.push('#' + prof.serialNumber);
    if (prof.groupName) bits.push(prof.groupName);
    bits.push(prof.proxy || '无代理配置');
    bits.push(prof.userId);
    meta.textContent = bits.join(' · ');
    text.appendChild(name);
    text.appendChild(meta);
    item.appendChild(text);
    if (prof.userId && rosterHas(prof.userId)) {
      const badge = document.createElement('span');
      badge.className = 'env-member-badge';
      badge.textContent = '已加入';
      item.appendChild(badge);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'ads-env-remove';
      removeBtn.textContent = '移出';
      removeBtn.title = '从运行花名册移出（不删除环境本身）';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromRoster(prof.userId);
      });
      item.appendChild(removeBtn);
    }
    item.appendChild(makeDeleteBtn(prof));
    item.addEventListener('click', () => selectProfile(prof.userId, item, prof.name, prof.platform));
    if (prof.userId && prof.userId === current) {
      item.classList.add('selected');
      currentSelected = prof.name || prof.userId;
    }
    if (!firstItem) firstItem = item;
    list.appendChild(item);
  }
  if (profiles.length === 1 && !current && roster.length === 0 && profiles[0].userId && !coreRunning()) {
    selectProfile(profiles[0].userId, firstItem, profiles[0].name, profiles[0].platform);
    return { autoSelected: profiles[0].name || profiles[0].userId };
  }
  return { autoSelected: null, currentSelected };
}

// 拉取环境列表；失败诚实降级为手敲（疑似鉴权失败提示已用当前填写值、别叫用户重填已填的框）。
async function refreshEnvs() {
  settingsUi.adsRefresh.disabled = true;
  setEnvMsg('正在拉取指纹浏览器环境…', false);
  try {
    const r = await window.aidcpEdge.adsListProfiles(formAdsOpts());
    if (!r || !r.ok) {
      const authHint = r && r.authLikely
        ? '：疑似开启了 API 校验；若已在「高级设置」里填了 API Key，本次刷新已用当前填写值，请确认 Key 正确后重试'
        : '';
      setEnvMsg(`拉取环境失败${r && r.error ? '（' + r.error + '）' : ''}${authHint}。可在「高级设置」打开「手动填写」填分身 ID。`, true);
      openAdvanced();
      return;
    }
    const { autoSelected, currentSelected } = populateEnvs(r.profiles || []);
    const extra = r.truncated ? '（环境较多，仅显示前若干条，可用分组精简）' : '';
    const autoHint = autoSelected
      ? `已自动加入唯一环境「${autoSelected}」。`
      : currentSelected
        ? `已选中「${currentSelected}」。`
        : '点选环境即加入运行花名册（可多选并行运行）。';
    setEnvMsg(`已加载 ${(r.profiles || []).length} 个环境${extra}。${autoHint}`, false);
  } catch (e) {
    setEnvMsg(`拉取环境失败（${e && e.message ? e.message : e}）。可在「高级设置」打开「手动填写」填分身 ID。`, true);
    openAdvanced();
  } finally {
    settingsUi.adsRefresh.disabled = false;
  }
}

settingsUi.adsRefresh.addEventListener('click', refreshEnvs);
// 创建提示行（与环境列表提示分开，避免互相覆盖）。
function setCreateMsg(text, isError) {
  if (!settingsUi.adsCreateMsg) return;
  settingsUi.adsCreateMsg.textContent = text;
  settingsUi.adsCreateMsg.classList.toggle('error', !!isError);
}

// 整机模板下拉：一次性从主进程拉清单填充（防御：桩 / 旧壳无此 API 时静默跳过）。
async function populateTemplates() {
  if (!settingsUi.adsTemplate || !window.aidcpEdge || typeof window.aidcpEdge.adsTemplates !== 'function') return;
  try {
    const list = await window.aidcpEdge.adsTemplates();
    if (!Array.isArray(list) || !list.length) return;
    settingsUi.adsTemplate.innerHTML = '';
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t.key;
      opt.textContent = t.label || t.key;
      settingsUi.adsTemplate.appendChild(opt);
    }
  } catch {
    /* 静默：模板拉取失败不影响其它 */
  }
}
populateTemplates();

// 「创建环境」程序化建号：挑模板 → 建一个指纹环境（代理不碰，建完提醒去 AdsPower 配代理）。
settingsUi.adsCreate.addEventListener('click', async () => {
  const tpl = settingsUi.adsTemplate && settingsUi.adsTemplate.value;
  if (!tpl) return setCreateMsg('请先选择一个整机模板', true);
  const platform = normPlatform(settingsUi.adsPlatform && settingsUi.adsPlatform.value);
  if (!window.aidcpEdge || typeof window.aidcpEdge.adsCreateEnv !== 'function') return;
  settingsUi.adsCreate.disabled = true;
  setCreateMsg('正在创建环境…', false);
  try {
    const r = await window.aidcpEdge.adsCreateEnv({ ...formAdsOpts(), templateKey: tpl, platform });
    if (r && r.ok) {
      // 新建即选中时，带上刚选的平台（回执 platform 优先，回落表单选择）。
      if (r.userId && !coreRunning()) selectProfile(r.userId, null, '', r.platform || platform);
      const selectedHint = r.userId && !coreRunning() ? '已自动选中，可直接点「启动」。' : '点上方「刷新」可看到它。';
      setCreateMsg(`已创建环境（${r.template || tpl}）。${selectedHint}请为它配好代理再使用。`, false);
      refreshEnvs();
    } else {
      const extra = r && r.violations && r.violations.length ? '（' + r.violations.join('；') + '）' : '';
      setCreateMsg(`创建失败：${(r && r.error) || '未知错误'}${extra}。`, true);
    }
  } finally {
    settingsUi.adsCreate.disabled = false;
  }
});

// 「按新设置重启」：先保存当前设置，再显式重启把改动应用到在跑核心（dirty && 在跑时才出现）。
settingsUi.applyRestart.addEventListener('click', async () => {
  settingsUi.applyRestart.disabled = true;
  try {
    const saved = await saveCurrentSettings();
    if (saved && saved.saveOk === false) {
      settingsUi.msg.textContent = `设置本次生效但写盘失败：${saved.saveError || ''}（重启应用后可能丢失）`;
    }
    const next = await window.aidcpEdge.restart(currentEnvId());
    if (next) routeStatus(next);
  } finally {
    settingsUi.applyRestart.disabled = false;
  }
});

// 悬浮会话按钮：三态触发 恢复 / 启动（=先保存再启动） / 暂停。无独立「保存」按钮。
fields.sessionFab.addEventListener('click', async () => {
  const action = fields.sessionFab.dataset.action;
  fields.sessionFab.disabled = true;
  try {
    let next;
    if (action === 'resume') {
      // 恢复 = 重启核心。若暂停期间改过浏览器设置（如切换了环境），先落盘再重启，否则会按旧设置重起。
      if (!(await persistDirtyBeforeRestart('设置已保存，正在按新设置恢复…'))) return;
      next = await window.aidcpEdge.resume(currentEnvId());
    } else if (action === 'start') {
      // 启动 = 先保存当前设置再启动（保存并入启动，无独立保存按钮）。
      if (selectedProvider() === 'adspower' && !settingsUi.adsProfile.value.trim() && roster.length === 0) {
        promptMissingAdsProfile();
        return;
      }
      const saved = await saveCurrentSettings();
      settingsUi.msg.textContent = saved && saved.saveOk === false
        ? `设置本次生效但写盘失败：${saved.saveError || ''}（重启应用后可能丢失）`
        : '设置已保存，正在启动…';
      next = await window.aidcpEdge.start(currentEnvId());
    } else {
      next = await window.aidcpEdge.pause(currentEnvId());
    }
    if (next) routeStatus(next);
  } finally {
    fields.sessionFab.disabled = false;
  }
});

fields.relogin.addEventListener('click', async () => {
  fields.relogin.disabled = true;
  try {
    // 重新登录同为「按当前浏览器设置重启核心」：若表单有未保存改动（如切换了环境），先落盘再重启。
    if (!(await persistDirtyBeforeRestart('设置已保存，正在重新登录…'))) return;
    routeStatus(await window.aidcpEdge.relogin(currentEnvId()));
  } finally {
    fields.relogin.disabled = false;
  }
});

// ─── 建号自助人设向导（change edge-persona-keyword-generation）───
const personaUi = {
  stateBadge: document.querySelector('#persona-state-badge'),
  hint: document.querySelector('#persona-hint'),
  boundNote: document.querySelector('#persona-bound-note'),
  wizardBody: document.querySelector('#persona-wizard-body'),
  verticalCustom: document.querySelector('#persona-vertical-custom'),
  interestCustom: document.querySelector('#persona-interest-custom'),
  kwGroups: Array.from(document.querySelectorAll('.persona-kw-group')),
  generate: document.querySelector('#persona-generate'),
  msg: document.querySelector('#persona-msg'),
  draft: document.querySelector('#persona-draft'),
  draftSummary: document.querySelector('#persona-draft-summary'),
  draftBody: document.querySelector('#persona-draft-body'),
  regenerate: document.querySelector('#persona-regenerate'),
  confirm: document.querySelector('#persona-confirm'),
};
let personaReady = false; // 已登录 + 云端已连接才可生成
let personaDraftYaml = ''; // 当前草稿 soulYaml（确认时提交）
let personaLocallyBound = false; // 本会话确认成功后即视为已绑（personaBound 信号要等下次 hello 才到）
let personaDraftEnvId; // 草稿所属环境（多环境：persist MUST 打回生成时那个账号，不随后续切换环境漂移）

// 切换环境时清空人设草稿（向导是每环境独立的）：绝不让 A 生成的草稿留在界面上被误确认到 B 的账号。
// 同时清本会话「已绑」态（personaLocallyBound 是账号级、随环境切换失效，等新环境自己的 hello 信号）。
function resetPersonaDraft() {
  personaDraftYaml = '';
  personaDraftEnvId = undefined;
  personaLocallyBound = false;
  personaUi.draft?.classList.add('hidden');
}

const PERSONA_GEN_FAIL = {
  generation_failed: '生成失败（模型未产出可用结果），请重试。',
  persona_invalid: '生成结果不合规，请重试。',
  input_too_large: '关键词太多或太长，请精简后重试。',
  no_keywords: '请先选择关键词。',
  missing_idempotency_key: '内部错误（缺幂等键），请重试。',
  edge_not_running: '引擎未运行，请先启动。',
  edge_request_timeout: '生成超时，请重试。',
  edge_request_failed: '与云端通信失败，请检查连接后重试。',
  unavailable: '云端暂不支持人设生成，请稍后再试。',
  unknown_account: '账号身份未就绪，请确认已扫码登录。',
};
const PERSONA_PERSIST_FAIL = {
  unknown_account: '账号身份未就绪（云端未建号），请稍后重试。',
  persona_required: '人设为空，无法保存。',
  persona_invalid: '人设格式无效，请重新生成。',
  edge_request_failed: '与云端通信失败，请重试。',
  edge_request_timeout: '保存超时，请重试。',
  unavailable: '云端暂不支持，请稍后再试。',
};

function setPersonaMsg(text, isError) {
  if (!personaUi.msg) return;
  personaUi.msg.textContent = text || '';
  personaUi.msg.classList.toggle('error', Boolean(isError));
}

function setPersonaBadge(text, variant) {
  if (!personaUi.stateBadge) return;
  personaUi.stateBadge.textContent = text;
  personaUi.stateBadge.className = `badge${variant ? ' ' + variant : ''}`;
}

function collectPersonaKeywords() {
  const chips = personaUi.kwGroups
    .flatMap((g) => Array.from(g.querySelectorAll('.kw-btn.active')).map((b) => b.dataset.kw))
    .filter(Boolean);
  const custom = [];
  const v = personaUi.verticalCustom && personaUi.verticalCustom.value.trim();
  if (v) custom.push(v); // 自定义垂类（长尾）
  const iRaw = personaUi.interestCustom && personaUi.interestCustom.value.trim();
  if (iRaw) custom.push(...iRaw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)); // 自由文本兴趣（逗号/顿号分隔）
  return [...chips, ...custom];
}

function newIdempotencyKey() {
  return `persona-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// onboarding 三态（change persona-wizard-onboarding-fixes）：已绑→已设置跳过 / 未绑未连→分态引导 / 未绑已连→启用。
// 只改 disabled/hint/显隐，绝不触碰已选关键词与草稿（状态推送不重置向导进度）。
function updatePersonaGate(status) {
  const bound = Boolean((status && status.personaBound) || personaLocallyBound);
  const loggedIn = Boolean(status && status.auth === 'logged in');
  const connected = Boolean(status && status.cloud === 'connected');
  personaReady = loggedIn && connected;

  // ① 已绑人设：显示「已设置」、隐藏向导体与提示、不再要求配置（修「已绑仍显示未设置」）。
  if (personaUi.boundNote) personaUi.boundNote.classList.toggle('hidden', !bound);
  if (personaUi.wizardBody) personaUi.wizardBody.classList.toggle('hidden', bound);
  if (personaUi.hint) personaUi.hint.classList.toggle('hidden', bound);
  if (bound) {
    setPersonaBadge('已设置', 'normal');
    return;
  }
  // 未绑：本会话刚生成的「待确认」态不被状态推送覆盖，否则回落「未设置」。
  if (personaUi.stateBadge && personaUi.stateBadge.textContent !== '待确认') setPersonaBadge('未设置', 'checking');

  // ②/③ 未绑：gate 判据不变，只改可见性与分态引导。
  if (personaUi.generate) personaUi.generate.disabled = !personaReady;
  if (personaUi.hint) {
    if (personaReady) {
      personaUi.hint.textContent = '选几类关键词，自动生成这个账号的人设；确认后账号才会开始自动运营。';
    } else if (!loggedIn) {
      personaUi.hint.textContent = '请先点右下角「启动」，并在打开的浏览器里扫码登录，再来生成人设。';
    } else {
      personaUi.hint.textContent = '已登录，正在连接云端…连上后即可生成人设。';
    }
  }
}

// 关键词 toggle：单选组互斥、多选组可叠加。
personaUi.kwGroups.forEach((group) => {
  const single = group.dataset.select === 'single';
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.kw-btn');
    if (!btn || !group.contains(btn)) return;
    if (single) {
      group.querySelectorAll('.kw-btn').forEach((b) => b.classList.toggle('active', b === btn));
    } else {
      btn.classList.toggle('active');
    }
  });
});

async function runPersonaGenerate() {
  if (!personaReady) return setPersonaMsg('请先扫码登录并连上云端', true);
  const keywordSelections = collectPersonaKeywords();
  if (!keywordSelections.length) return setPersonaMsg('请先选择关键词', true);
  if (!window.aidcpEdge || typeof window.aidcpEdge.personaGenerate !== 'function') return;
  personaUi.generate.disabled = true;
  if (personaUi.regenerate) personaUi.regenerate.disabled = true;
  setPersonaMsg('正在生成人设…（可能需要十几秒）', false);
  const genEnvId = currentEnvId(); // 生成时锁定目标环境；persist 打回它，绝不随后续切换漂移
  try {
    const r = await window.aidcpEdge.personaGenerate(genEnvId, { keywordSelections, idempotencyKey: newIdempotencyKey() });
    if (r && r.ok && r.soulYaml) {
      personaDraftYaml = r.soulYaml;
      personaDraftEnvId = genEnvId;
      if (personaUi.draftSummary) personaUi.draftSummary.textContent = r.identitySummary || '已生成';
      if (personaUi.draftBody) personaUi.draftBody.textContent = r.soulYaml;
      personaUi.draft?.classList.remove('hidden');
      setPersonaBadge('待确认', 'warning');
      setPersonaMsg('已生成草稿，确认后即绑定；不满意可「重新生成」。', false);
    } else {
      personaDraftYaml = '';
      personaUi.draft?.classList.add('hidden');
      setPersonaMsg(PERSONA_GEN_FAIL[(r && r.reason) || ''] || `生成失败：${(r && r.reason) || '未知'}`, true);
    }
  } finally {
    personaUi.generate.disabled = !personaReady;
    if (personaUi.regenerate) personaUi.regenerate.disabled = false;
  }
}

personaUi.generate?.addEventListener('click', runPersonaGenerate);
personaUi.regenerate?.addEventListener('click', runPersonaGenerate);

personaUi.confirm?.addEventListener('click', async () => {
  if (!personaDraftYaml) return;
  if (!window.aidcpEdge || typeof window.aidcpEdge.personaPersist !== 'function') return;
  personaUi.confirm.disabled = true;
  setPersonaMsg('正在保存人设…', false);
  try {
    // 打回草稿所属环境（personaDraftEnvId），不是「当前选中环境」——防中途切换环境把 A 的人设写进 B 的账号。
    const r = await window.aidcpEdge.personaPersist(personaDraftEnvId, { soulYaml: personaDraftYaml });
    if (r && r.ok) {
      // 确认成功即本地视为已绑（personaBound 信号要等下次 hello 才到）：立即折叠向导为「已设置」态。
      personaLocallyBound = true;
      setPersonaBadge('已设置', 'normal');
      personaUi.draft?.classList.add('hidden');
      personaUi.wizardBody?.classList.add('hidden');
      personaUi.hint?.classList.add('hidden');
      personaUi.boundNote?.classList.remove('hidden');
      setPersonaMsg('人设已保存，账号即将开始自动运营。', false);
    } else {
      setPersonaMsg(PERSONA_PERSIST_FAIL[(r && r.reason) || ''] || `保存失败：${(r && r.reason) || '未知'}`, true);
    }
  } finally {
    personaUi.confirm.disabled = false;
  }
});

// ─── 启动接线 ───
// 状态 / 活动按 envId 路由（无 envId 的旧形状归 '__local__'，行为与单环境逐位一致）。
window.aidcpEdge.onStatusUpdate(routeStatus);
// 活动流条目（旧版主进程无此通道时安全跳过——渲染层对旧形状降级不炸）。
window.aidcpEdge.onActivity?.(routeActivity);
// fleet 快照通道（多环境花名册 / 选中项 / 收展；旧主进程无此通道时安全跳过）。
window.aidcpEdge.onFleetUpdate?.(applyFleetSnapshot);
window.aidcpEdge.getSettings().then((s) => {
  applySettings(s);
  // 面板加载时若为 AdsPower 模式即探一次并自动列环境（真实事件，低频；非「打开设置面板」）。
  if (selectedProvider() === 'adspower') probeAds();
});
window.aidcpEdge.getStatus().then(routeStatus);
if (typeof window.aidcpEdge.fleetGet === 'function') {
  window.aidcpEdge.fleetGet().then(applyFleetSnapshot).catch(() => undefined);
}
