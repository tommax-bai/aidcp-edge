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
// 用户正在编辑设置表单时不被状态推送回填覆盖（避免边打字边被清空）。
let editingProvider = null;
// 设置是否相对「已应用/已保存」有改动。核心在跑且 dirty 时才显示「按新设置重启」；
// 「保存」按钮已并入「启动」——启动时先存再起，故无独立保存按钮。
let dirty = false;
// 选中环境的 AdsPower 环境名（随设置持久化，作标题带账号标签兜底）。
let selectedProfileName = '';
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
const logEntries = [];
let lastLogMessage = '';
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

// ─── 开发者详情：原始日志（滚动保留 + 连续去重）───
function addLogEntry(message) {
  if (!message || message === lastLogMessage) return;
  lastLogMessage = message;
  const now = Date.now();
  logEntries.push({ time: now, message });
  const cutoff = now - LOG_RETENTION_MS;
  while (logEntries.length > 0 && logEntries[0].time < cutoff) {
    logEntries.shift();
  }
  renderLog();
}

function renderLog() {
  fields.lastMessage.innerHTML = logEntries.map((entry) => {
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
let lastPublishSig = '';
// 用户点薄条的临时展开（进行中审批到来 / 会话停止时自动复位）。
let pubManualOpen = false;
function renderPublish(status, nowMs) {
  const view = uiLogic.publishView(status.publish, status.lastPublish, nowMs);
  // 终态折一条进活动流（按签名去重，状态重推不重复记）。
  if (view.collapsed && status.publish) {
    const sig = `${status.publish.state}:${status.publish.title || ''}`;
    if (sig !== lastPublishSig) {
      lastPublishSig = sig;
      prependActivity({
        ts: status.publish.at || new Date().toISOString(),
        type: `publish_${view.collapsed.type}`,
        sentence: view.collapsed.sentence,
      }, view.collapsed.type === 'published' ? 'pub-done' : 'pub-muted');
    }
  }
  if (status.publish) lastPublishSig = `${status.publish.state}:${status.publish.title || ''}`;
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
function prependActivity(entry, extraClass) {
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
  addLogEntry(status.lastMessage);
  renderEdgeFailure(status);
  renderTitlebar(status);
  renderPresence(status, now);
  renderKernelPrep(status);
  renderLoop(status);
  renderPublish(status, now);
  renderFab(status);
  renderNotice(status);
  updateApplyRestart(); // 依「dirty && 核心在跑」决定是否显示「按新设置重启」
  if (status.provider && SUBTITLE[status.provider]) fields.subtitle.textContent = SUBTITLE[status.provider];
  // 表单未在编辑时，让 provider 分段跟随实际运行 provider。
  if (status.provider && !editingProvider) applyProviderSelection(status.provider);
  updatePersonaGate(status); // 建号人设：仅登录+云端已连接才可生成（不触碰已选关键词/草稿，避免状态推送重置向导）
}

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

// 保存当前表单设置（供「启动」「按新设置重启」复用；无独立保存按钮）。返回 saveSettings 结果。
async function saveCurrentSettings() {
  const provider = selectedProvider();
  const saved = await window.aidcpEdge.saveSettings({
    provider,
    browserParkingMode: selectedParkingMode(),
    adsProfileId: settingsUi.adsProfile.value.trim(),
    adsProfileName: selectedProfileName,
    platform: selectedPlatform,
    adsApiKey: settingsUi.adsApiKey.value,
    adsApiBase: settingsUi.adsApiBase.value.trim(),
  });
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
    const r = await api();
    settingsUi.msg.textContent = r && r.ok ? `${label}指令已发送。` : `${label}失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`;
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
function selectProfile(userId, itemEl, profileName, platform) {
  settingsUi.adsProfile.value = userId;
  selectedProfileName = profileName || '';
  selectedPlatform = normPlatform(platform);
  updateProfileDisplay();
  markDirty();
  settingsUi.adsEnvList.querySelectorAll('.ads-env-item').forEach((el) => el.classList.remove('selected'));
  if (itemEl) itemEl.classList.add('selected');
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

// 直接把环境铺成可点行（非下拉）。每行：名称 + 序号/分组/代理配置/user_id + 删除按钮。
// 返回 { autoSelected }：恰好一个环境、分身 ID 为空且核心未在跑时自动选中（spec：唯一环境自动选中；
// 多环境不代选、已有值不覆盖、在跑不动配置）。
function populateEnvs(profiles) {
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
    item.appendChild(makeDeleteBtn(prof));
    item.addEventListener('click', () => selectProfile(prof.userId, item, prof.name, prof.platform));
    if (prof.userId && prof.userId === current) {
      item.classList.add('selected');
      currentSelected = prof.name || prof.userId;
    }
    if (!firstItem) firstItem = item;
    list.appendChild(item);
  }
  if (profiles.length === 1 && !current && profiles[0].userId && !coreRunning()) {
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
      ? `已自动选中唯一环境「${autoSelected}」。`
      : currentSelected
        ? `已选中「${currentSelected}」。`
        : '点选一个即自动带出分身 ID。';
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
    const next = await window.aidcpEdge.restart();
    if (next) render(next);
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
      next = await window.aidcpEdge.resume();
    } else if (action === 'start') {
      // 启动 = 先保存当前设置再启动（保存并入启动，无独立保存按钮）。
      if (selectedProvider() === 'adspower' && !settingsUi.adsProfile.value.trim()) {
        promptMissingAdsProfile();
        return;
      }
      const saved = await saveCurrentSettings();
      settingsUi.msg.textContent = saved && saved.saveOk === false
        ? `设置本次生效但写盘失败：${saved.saveError || ''}（重启应用后可能丢失）`
        : '设置已保存，正在启动…';
      next = await window.aidcpEdge.start();
    } else {
      next = await window.aidcpEdge.pause();
    }
    if (next) render(next);
  } finally {
    fields.sessionFab.disabled = false;
  }
});

fields.relogin.addEventListener('click', async () => {
  fields.relogin.disabled = true;
  try {
    // 重新登录同为「按当前浏览器设置重启核心」：若表单有未保存改动（如切换了环境），先落盘再重启。
    if (!(await persistDirtyBeforeRestart('设置已保存，正在重新登录…'))) return;
    render(await window.aidcpEdge.relogin());
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
  try {
    const r = await window.aidcpEdge.personaGenerate({ keywordSelections, idempotencyKey: newIdempotencyKey() });
    if (r && r.ok && r.soulYaml) {
      personaDraftYaml = r.soulYaml;
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
    const r = await window.aidcpEdge.personaPersist({ soulYaml: personaDraftYaml });
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
window.aidcpEdge.onStatusUpdate(render);
// 活动流条目（旧版主进程无此通道时安全跳过——渲染层对旧形状降级不炸）。
window.aidcpEdge.onActivity?.((entry) => prependActivity(entry));
window.aidcpEdge.getSettings().then((s) => {
  applySettings(s);
  // 面板加载时若为 AdsPower 模式即探一次并自动列环境（真实事件，低频；非「打开设置面板」）。
  if (selectedProvider() === 'adspower') probeAds();
});
window.aidcpEdge.getStatus().then(render);
