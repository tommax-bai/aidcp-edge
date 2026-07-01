const fields = {
  auth: document.querySelector('#auth-status'),
  cloud: document.querySelector('#cloud-status'),
  session: document.querySelector('#session-state'),
  risk: document.querySelector('#risk-status'),
  edge: document.querySelector('#edge-state'),
  views: document.querySelector('#views'),
  likes: document.querySelector('#likes'),
  collects: document.querySelector('#collects'),
  updatedAt: document.querySelector('#updated-at'),
  lastMessage: document.querySelector('#last-message'),
  toggle: document.querySelector('#toggle-session'),
  relogin: document.querySelector('#relogin'),
  loginGuide: document.querySelector('#login-guide'),
  noticeTitle: document.querySelector('#notice-title'),
  noticeBody: document.querySelector('#notice-body'),
  subtitle: document.querySelector('#subtitle'),
};

const settingsUi = {
  provAdspower: document.querySelector('#prov-adspower'),
  provSelf: document.querySelector('#prov-self'),
  adsConfig: document.querySelector('#ads-config'),
  adsProfile: document.querySelector('#ads-profile'),
  adsApiKey: document.querySelector('#ads-apikey'),
  adsApiBase: document.querySelector('#ads-apibase'),
  adsDownload: document.querySelector('#ads-download'),
  save: document.querySelector('#save-settings'),
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
  session: { idle: '空闲', running: '运行中', paused: '已暂停' },
  risk: { normal: '正常', warned: '警戒', restricted: '受限', frozen: '冻结' },
  edge: { stopped: '已停止', starting: '启动中', running: '运行中', warning: '异常' },
};

const SUBTITLE = {
  adspower: 'AdsPower 指纹浏览器托管，每个分身独立指纹与 IP，规避同机多账号关联。',
  self: '本机 Chrome 以持久化配置启动，用于小红书登录与自动运营。',
};

let currentStatus;
// 用户正在编辑设置表单时不被状态推送回填覆盖（避免边打字边被清空）。
let editingProvider = null;
let adsDownloadUrl = 'https://www.adspower.net/download';
const LOG_RETENTION_MS = 2 * 60 * 1000; // 2 minutes
const logEntries = [];

function setBadge(element, field, value) {
  element.textContent = STATUS_LABELS[field]?.[value] ?? value;
  element.className = `badge ${value}`;
}

function addLogEntry(message) {
  if (!message) return;
  const now = Date.now();
  logEntries.push({ time: now, message });
  // Prune entries older than 2 minutes
  const cutoff = now - LOG_RETENTION_MS;
  while (logEntries.length > 0 && logEntries[0].time < cutoff) {
    logEntries.shift();
  }
  renderLog();
}

function renderLog() {
  fields.lastMessage.innerHTML = logEntries.map((entry) => {
    const time = new Date(entry.time).toLocaleTimeString();
    return `<div class="log-entry"><span class="log-time">${time}</span> ${entry.message}</div>`;
  }).join('');
  fields.lastMessage.scrollTop = fields.lastMessage.scrollHeight;
}

function renderNotice(status) {
  let title = '';
  let body = '';
  if (status.auth === 'login required') {
    title = '需要登录';
    body = '请在刚打开的 Chrome 窗口中登录 xiaohongshu.com，检测到登录后 AIDCP Edge 会自动继续。';
  } else if (status.auth === 'config required') {
    title = '待配置';
    body = '请在下方「浏览器」设置中填写 AdsPower 分身 ID，然后点击「保存并启动」。';
  }
  const show = Boolean(title);
  fields.loginGuide.classList.toggle('hidden', !show);
  if (show) {
    fields.noticeTitle.textContent = title;
    fields.noticeBody.textContent = body;
  }
}

function render(status) {
  currentStatus = status;
  setBadge(fields.auth, 'auth', status.auth);
  setBadge(fields.cloud, 'cloud', status.cloud);
  setBadge(fields.session, 'session', status.session);
  setBadge(fields.risk, 'risk', status.risk);
  setBadge(fields.edge, 'edge', status.edge);
  fields.views.textContent = status.stats.views;
  fields.likes.textContent = status.stats.likes;
  fields.collects.textContent = status.stats.collects;
  fields.updatedAt.textContent = new Date(status.updatedAt).toLocaleTimeString();
  addLogEntry(status.lastMessage);
  fields.toggle.textContent = status.session === 'paused' ? '恢复' : '暂停';
  if (status.provider && SUBTITLE[status.provider]) fields.subtitle.textContent = SUBTITLE[status.provider];
  // 表单未在编辑时，让 provider 分段跟随实际运行 provider。
  if (status.provider && !editingProvider) applyProviderSelection(status.provider);
  renderNotice(status);
}

// ─── Browser provider settings ───

function applyProviderSelection(provider) {
  const isAds = provider !== 'self';
  settingsUi.provAdspower.classList.toggle('active', isAds);
  settingsUi.provSelf.classList.toggle('active', !isAds);
  settingsUi.adsConfig.classList.toggle('hidden', !isAds);
}

function selectedProvider() {
  return settingsUi.provAdspower.classList.contains('active') ? 'adspower' : 'self';
}

function applySettings(s) {
  if (!s) return;
  if (s.adsDownloadUrl) adsDownloadUrl = s.adsDownloadUrl;
  settingsUi.adsProfile.value = s.adsProfileId || '';
  settingsUi.adsApiKey.value = s.adsApiKey || '';
  settingsUi.adsApiBase.value = s.adsApiBase || '';
  editingProvider = null;
  applyProviderSelection(s.provider || 'adspower');
}

settingsUi.provAdspower.addEventListener('click', () => {
  editingProvider = 'adspower';
  applyProviderSelection('adspower');
});
settingsUi.provSelf.addEventListener('click', () => {
  editingProvider = 'self';
  applyProviderSelection('self');
});

settingsUi.adsDownload.addEventListener('click', (event) => {
  event.preventDefault();
  window.aidcpEdge.openAdsDownload();
});

settingsUi.save.addEventListener('click', async () => {
  const provider = selectedProvider();
  const adsProfileId = settingsUi.adsProfile.value.trim();
  if (provider === 'adspower' && !adsProfileId) {
    settingsUi.msg.textContent = '请先填写 AdsPower 分身 ID。';
    settingsUi.adsProfile.focus();
    return;
  }
  settingsUi.save.disabled = true;
  settingsUi.msg.textContent = '正在保存并按新配置重启…';
  try {
    const saved = await window.aidcpEdge.saveSettings({
      provider,
      adsProfileId,
      adsApiKey: settingsUi.adsApiKey.value,
      adsApiBase: settingsUi.adsApiBase.value.trim(),
    });
    applySettings(saved);
    // 红线：写盘失败如实告知，不谎报「已保存」。
    settingsUi.msg.textContent = saved.saveOk === false
      ? `已应用，但写入本地失败：${saved.saveError || ''}（重启后可能丢失）`
      : '已保存。';
  } finally {
    settingsUi.save.disabled = false;
  }
});

fields.toggle.addEventListener('click', async () => {
  fields.toggle.disabled = true;
  try {
    const next = currentStatus?.session === 'paused'
      ? await window.aidcpEdge.resume()
      : await window.aidcpEdge.pause();
    render(next);
  } finally {
    fields.toggle.disabled = false;
  }
});

fields.relogin.addEventListener('click', async () => {
  fields.relogin.disabled = true;
  try {
    render(await window.aidcpEdge.relogin());
  } finally {
    fields.relogin.disabled = false;
  }
});

window.aidcpEdge.onStatusUpdate(render);
window.aidcpEdge.getSettings().then(applySettings);
window.aidcpEdge.getStatus().then(render);
