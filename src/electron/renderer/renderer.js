// 陪伴式主界面渲染层（edge-companion-ui）。
// 纯视图逻辑（健康合成 / 在场感动效门 / 发布卡状态机）在 ui-logic.js（window.uiLogic，可单测）；
// 本文件只做 DOM 粘合。设置表单 / 悬浮三态 FAB 的既有逻辑原样保留（仅 DOM 迁入设置抽屉）。
const uiLogic = window.uiLogic;

const fields = {
  auth: document.querySelector('#auth-status'),
  cloud: document.querySelector('#cloud-status'),
  session: document.querySelector('#session-state'),
  risk: document.querySelector('#risk-status'),
  edge: document.querySelector('#edge-state'),
  views: document.querySelector('#views'),
  likes: document.querySelector('#likes'),
  collects: document.querySelector('#collects'),
  comments: document.querySelector('#comments'),
  updatedAt: document.querySelector('#updated-at'),
  lastMessage: document.querySelector('#last-message'),
  sessionFab: document.querySelector('#session-fab'),
  relogin: document.querySelector('#relogin'),
  loginGuide: document.querySelector('#login-guide'),
  noticeTitle: document.querySelector('#notice-title'),
  noticeBody: document.querySelector('#notice-body'),
  noticeAction: document.querySelector('#notice-action'),
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
  loop: document.querySelector('#loop'),
  stream: document.querySelector('#activity-stream'),
  streamEmpty: document.querySelector('#stream-empty'),
  pubCard: document.querySelector('#pub-card'),
  pubHead: document.querySelector('#pub-head'),
  pubCorner: document.querySelector('#pub-corner'),
  pubTitle: document.querySelector('#pub-title'),
  pubMeta: document.querySelector('#pub-meta'),
  pubSteps: document.querySelector('#pub-steps'),
  pubFoot: document.querySelector('#pub-foot'),
  pubLink: document.querySelector('#pub-link'),
  drawer: document.querySelector('#drawer'),
  drawerMask: document.querySelector('#drawer-mask'),
  drawerClose: document.querySelector('#drawer-close'),
  lightsPad: document.querySelector('.tb-lights-pad'),
  winctlPad: document.querySelector('.tb-winctl-pad'),
};

const settingsUi = {
  provAdspower: document.querySelector('#prov-adspower'),
  provSelf: document.querySelector('#prov-self'),
  adsConfig: document.querySelector('#ads-config'),
  adsProfile: document.querySelector('#ads-profile'),
  adsProfileDisplay: document.querySelector('#ads-profile-display'),
  adsManual: document.querySelector('#ads-manual'),
  adsApiKey: document.querySelector('#ads-apikey'),
  adsApiBase: document.querySelector('#ads-apibase'),
  adsAdvancedToggle: document.querySelector('#ads-advanced-toggle'),
  adsAdvanced: document.querySelector('#ads-advanced'),
  adsDownload: document.querySelector('#ads-download'),
  adsProbeBadge: document.querySelector('#ads-probe-badge'),
  adsDetect: document.querySelector('#ads-detect'),
  adsEnvList: document.querySelector('#ads-env-list'),
  adsRefresh: document.querySelector('#ads-refresh'),
  adsEnvMsg: document.querySelector('#ads-env-msg'),
  adsCreate: document.querySelector('#ads-create'),
  applyRestart: document.querySelector('#apply-restart'),
  msg: document.querySelector('#settings-msg'),
};

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
  session: { idle: '待命', running: '进行中', paused: '已暂停' },
  risk: { normal: '正常', warned: '谨慎放慢', restricted: '受限', frozen: '已冻结' },
  edge: { stopped: '已停止', starting: '启动中', running: '运行中', warning: '异常' },
};

const SUBTITLE = {
  adspower: 'AdsPower 指纹浏览器托管，每个分身独立指纹与 IP，规避同机多账号关联。',
  self: '本机 Chrome 以持久化配置启动，用于小红书登录与自动运营。',
};

let currentStatus;
// 用户正在编辑设置表单时不被状态推送回填覆盖（避免边打字边被清空）。
let editingProvider = null;
// 设置是否相对「已应用/已保存」有改动。核心在跑且 dirty 时才显示「按新设置重启」；
// 「保存」按钮已并入「启动」——启动时先存再起，故无独立保存按钮。
let dirty = false;
let adsDownloadUrl = 'https://www.adspower.net/download';
const LOG_RETENTION_MS = 2 * 60 * 1000; // 开发者详情原始日志保留 2 分钟
const logEntries = [];
let lastLogMessage = '';

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

// 今日小结计数：数字永不为空（undefined/null → 0）；零值弱化显示，避免一排死零抢视觉。
function renderKpi(el, value) {
  const n = Number(value) || 0;
  el.textContent = n;
  el.classList.toggle('zero', n === 0);
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

// ─── 标题带：账号身份 + 健康合成 + 风控染色 ───
function renderTitlebar(status) {
  const acct = status.account;
  if (acct && (acct.name || acct.id)) {
    // 有昵称显示昵称；只有 id 时显示「账号 …尾4位」——长 id 不上标题带（in-place 身份读取拿不到昵称属常态）。
    const nick = (acct.name || '').replace(/^@/, '');
    fields.acctName.textContent = nick ? `@${nick}` : `账号 …${String(acct.id).slice(-4)}`;
    fields.acctAva.textContent = nick ? nick.slice(0, 1) : '书';
  }
  const health = uiLogic.synthesizeHealth(status);
  fields.healthLabel.textContent = health.label;
  fields.healthPill.className = `health-pill nodrag ${health.code}`;
  fields.healthDetail.textContent = health.detail || '';
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

// ─── 发布等待卡（纯展示零按钮；终态收进活动流）───
let lastPublishSig = '';
function renderPublish(status, nowMs) {
  const view = uiLogic.publishView(status.publish, nowMs);
  // 终态：卡片收起 + 折一条进活动流（按签名去重，状态重推不重复记）。
  if (view.collapsed) {
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
  fields.pubCard.classList.toggle('hidden', !view.visible);
  if (!view.visible) return;
  lastPublishSig = `${status.publish.state}:${status.publish.title || ''}`;
  fields.pubHead.textContent = view.head;
  fields.pubCorner.textContent = view.corner;
  fields.pubCorner.classList.toggle('hot', Boolean(view.cornerHot));
  fields.pubTitle.textContent = view.title || '（新笔记）';
  fields.pubMeta.textContent = view.code ? `图文笔记 · 编号 ${view.code}` : '图文笔记';
  fields.pubFoot.textContent = view.foot;
  const steps = fields.pubSteps.querySelectorAll('.j-step');
  view.stepStates.forEach((state, i) => {
    const el = steps[i];
    if (!el) return;
    el.className = `j-step ${state}${state === 'cur' && view.curCalm ? ' calm' : ''}`;
  });
}

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
  renderPresence(currentStatus, now);
  if (currentStatus.publish) renderPublish(currentStatus, now);
  fields.stream.querySelectorAll('.ev').forEach((row) => {
    const ts = Date.parse(row.dataset.ts || '');
    if (Number.isFinite(ts)) row.querySelector('.ev-t').textContent = uiLogic.relTime(ts, now);
  });
}, 1000);

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

function render(status) {
  currentStatus = status;
  const now = Date.now();
  setBadge(fields.auth, 'auth', status.auth);
  setBadge(fields.cloud, 'cloud', status.cloud);
  setBadge(fields.session, 'session', status.session);
  setBadge(fields.risk, 'risk', status.risk);
  setBadge(fields.edge, 'edge', status.edge);
  renderKpi(fields.views, status.stats.views);
  renderKpi(fields.likes, status.stats.likes);
  renderKpi(fields.collects, status.stats.collects);
  renderKpi(fields.comments, status.stats.comments); // 各计数一律 ?? 0 兜底（旧形状 / 部分补丁都不出空数字）
  fields.updatedAt.textContent = new Date(status.updatedAt).toLocaleTimeString();
  addLogEntry(status.lastMessage);
  renderTitlebar(status);
  renderPresence(status, now);
  renderLoop(status);
  renderPublish(status, now);
  renderFab(status);
  renderNotice(status);
  updateApplyRestart(); // 依「dirty && 核心在跑」决定是否显示「按新设置重启」
  if (status.provider && SUBTITLE[status.provider]) fields.subtitle.textContent = SUBTITLE[status.provider];
  // 表单未在编辑时，让 provider 分段跟随实际运行 provider。
  if (status.provider && !editingProvider) applyProviderSelection(status.provider);
}

// ─── Browser provider settings（既有逻辑原样保留，DOM 已迁入抽屉）───

function applyProviderSelection(provider) {
  const isAds = provider !== 'self';
  settingsUi.provAdspower.classList.toggle('active', isAds);
  settingsUi.provSelf.classList.toggle('active', !isAds);
  settingsUi.adsConfig.classList.toggle('hidden', !isAds);
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
    adsProfileId: settingsUi.adsProfile.value.trim(),
    adsApiKey: settingsUi.adsApiKey.value,
    adsApiBase: settingsUi.adsApiBase.value.trim(),
  });
  if (saved && saved.adsDownloadUrl) adsDownloadUrl = saved.adsDownloadUrl;
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
    settingsUi.msg.textContent = '请先选择一个环境，或在「高级设置」里打开「手动填写」填分身 ID。';
    return false;
  }
  const saved = await saveCurrentSettings();
  settingsUi.msg.textContent = saved && saved.saveOk === false
    ? `设置本次生效但写盘失败：${saved.saveError || ''}（重启应用后可能丢失）`
    : okMessage;
  return true;
}

function selectedProvider() {
  return settingsUi.provAdspower.classList.contains('active') ? 'adspower' : 'self';
}

// 分身 ID 只读展示：默认由选中环境带出；手动模式时改由输入框承载。
function updateProfileDisplay() {
  const v = settingsUi.adsProfile.value.trim();
  settingsUi.adsProfileDisplay.textContent = v || '（请从上方选择一个环境）';
  settingsUi.adsProfileDisplay.classList.toggle('empty', !v);
}

function applySettings(s) {
  if (!s) return;
  if (s.adsDownloadUrl) adsDownloadUrl = s.adsDownloadUrl;
  applyDevVisible(Boolean(s.devDetails));
  settingsUi.adsProfile.value = s.adsProfileId || '';
  settingsUi.adsApiKey.value = s.adsApiKey || '';
  settingsUi.adsApiBase.value = s.adsApiBase || '';
  updateProfileDisplay();
  editingProvider = null;
  dirty = false;
  applyProviderSelection(s.provider || 'adspower');
  updateApplyRestart();
}

settingsUi.provAdspower.addEventListener('click', () => {
  editingProvider = 'adspower';
  markDirty();
  applyProviderSelection('adspower');
  probeAds(); // 切到 AdsPower 分段即探一次可用性并自动列环境（真实事件，非「打开设置面板」）
});
settingsUi.provSelf.addEventListener('click', () => {
  editingProvider = 'self';
  markDirty();
  applyProviderSelection('self');
});

settingsUi.adsDownload.addEventListener('click', (event) => {
  event.preventDefault();
  window.aidcpEdge.openAdsDownload();
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
  updateProfileDisplay();
  markDirty();
});
settingsUi.adsApiBase.addEventListener('input', markDirty);
settingsUi.adsApiKey.addEventListener('input', markDirty);

// ─── AdsPower 探测 / 环境列表 / 新建入口 ───

// 只读调用带上「当前表单值」（调用级）：支持「新填 API Key 未保存即刷新」而不陷回环。
function formAdsOpts() {
  return {
    apiBase: settingsUi.adsApiBase.value.trim(),
    apiKey: settingsUi.adsApiKey.value,
  };
}

function setProbeBadge(code, text) {
  settingsUi.adsProbeBadge.textContent = text;
  settingsUi.adsProbeBadge.className = `badge ${code}`;
}

function setEnvMsg(text, isError) {
  settingsUi.adsEnvMsg.textContent = text || '';
  settingsUi.adsEnvMsg.className = `ads-env-msg${isError ? ' error' : ''}`;
}

// 探测本地 API 可用性（根级 /status）。可达→就绪并自动列环境；不可达→诚实提示 + 引导下载，不禁死流程。
async function probeAds() {
  setProbeBadge('checking', '检测中');
  settingsUi.adsDetect.disabled = true;
  try {
    const r = await window.aidcpEdge.adsStatus(formAdsOpts());
    if (r && r.ok) {
      setProbeBadge('connected', '已就绪');
      if (settingsUi.adsEnvMsg.classList.contains('error')) setEnvMsg('', false);
      refreshEnvs(); // 就绪即自动列出环境，无需先点刷新
    } else {
      setProbeBadge('warning', '未就绪');
      setEnvMsg(
        `未检测到 AdsPower 本地 API${r && r.error ? '（' + r.error + '）' : ''}。请启动 AdsPower 客户端并开启本地 API，或点右侧「下载 AdsPower」。仍可在「高级设置」打开「手动填写」填分身 ID 继续。`,
        true,
      );
      openAdvanced();
    }
  } catch {
    setProbeBadge('warning', '未就绪');
  } finally {
    settingsUi.adsDetect.disabled = false;
  }
}

// 选中某环境：把其 user_id（非 serial_number）设为将写入的分身 ID，并高亮该行。
function selectProfile(userId, itemEl) {
  settingsUi.adsProfile.value = userId;
  updateProfileDisplay();
  markDirty();
  settingsUi.adsEnvList.querySelectorAll('.ads-env-item').forEach((el) => el.classList.remove('selected'));
  if (itemEl) itemEl.classList.add('selected');
}

// 核心是否在跑（自动选中的闸：在跑时绝不替用户改配置）。
function coreRunning() {
  return Boolean(currentStatus) && currentStatus.edge !== 'stopped' && currentStatus.edge !== 'warning';
}

// 直接把环境铺成可点行（非下拉）。每行：名称 + 序号/分组/代理配置/user_id。
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
  for (const prof of profiles) {
    const item = document.createElement('div');
    item.className = 'ads-env-item';
    const name = document.createElement('div');
    name.className = 'env-name';
    name.textContent = prof.name || '(未命名)';
    const meta = document.createElement('div');
    meta.className = 'env-meta';
    const bits = [];
    if (prof.serialNumber) bits.push('#' + prof.serialNumber);
    if (prof.groupName) bits.push(prof.groupName);
    bits.push(prof.proxy || '无代理配置');
    bits.push(prof.userId);
    meta.textContent = bits.join(' · ');
    item.appendChild(name);
    item.appendChild(meta);
    item.addEventListener('click', () => selectProfile(prof.userId, item));
    if (prof.userId && prof.userId === current) item.classList.add('selected');
    if (!firstItem) firstItem = item;
    list.appendChild(item);
  }
  if (profiles.length === 1 && !current && profiles[0].userId && !coreRunning()) {
    selectProfile(profiles[0].userId, firstItem);
    return { autoSelected: profiles[0].name || profiles[0].userId };
  }
  return { autoSelected: null };
}

// 拉取环境列表；失败诚实降级为手敲（疑似鉴权失败提示已用当前填写值、别叫用户重填已填的框）。
async function refreshEnvs() {
  settingsUi.adsRefresh.disabled = true;
  setEnvMsg('正在从 AdsPower 拉取环境…', false);
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
    const { autoSelected } = populateEnvs(r.profiles || []);
    const extra = r.truncated ? '（环境较多，仅显示前若干条，可在 AdsPower 用分组精简）' : '';
    const autoHint = autoSelected ? `已自动选中唯一环境「${autoSelected}」。` : '点选一个即自动带出分身 ID。';
    setEnvMsg(`已加载 ${(r.profiles || []).length} 个环境${extra}。${autoHint}`, false);
  } catch (e) {
    setEnvMsg(`拉取环境失败（${e && e.message ? e.message : e}）。可在「高级设置」打开「手动填写」填分身 ID。`, true);
    openAdvanced();
  } finally {
    settingsUi.adsRefresh.disabled = false;
  }
}

settingsUi.adsDetect.addEventListener('click', probeAds);
settingsUi.adsRefresh.addEventListener('click', refreshEnvs);
settingsUi.adsCreate.addEventListener('click', async (event) => {
  event.preventDefault();
  const r = await window.aidcpEdge.adsOpenCreate();
  setEnvMsg(
    r && r.launched
      ? '已打开 AdsPower 客户端：请在其中点「新建浏览器」完成配置，返回后点「刷新」加载新环境。'
      : '已打开 AdsPower 官网（未能直接拉起客户端）：安装 / 打开 AdsPower 后在其中点「新建浏览器」，完成后回来点「刷新」。',
    false,
  );
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
        settingsUi.msg.textContent = '请先选择一个环境，或在「高级设置」里打开「手动填写」填分身 ID。';
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
