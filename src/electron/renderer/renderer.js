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
  adsProbeBadge: document.querySelector('#ads-probe-badge'),
  adsDetect: document.querySelector('#ads-detect'),
  adsEnvSelect: document.querySelector('#ads-env-select'),
  adsRefresh: document.querySelector('#ads-refresh'),
  adsEnvMsg: document.querySelector('#ads-env-msg'),
  adsCreate: document.querySelector('#ads-create'),
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
  probeAds(); // 切到 AdsPower 分段即探一次可用性（真实事件，非「打开设置面板」）
});
settingsUi.provSelf.addEventListener('click', () => {
  editingProvider = 'self';
  applyProviderSelection('self');
});

settingsUi.adsDownload.addEventListener('click', (event) => {
  event.preventDefault();
  window.aidcpEdge.openAdsDownload();
});

// ─── AdsPower 探测 / 环境下拉 / 新建入口 ───

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

// 探测本地 API 可用性（根级 /status）。可达→就绪；不可达→诚实提示 + 引导下载，不禁死流程。
async function probeAds() {
  setProbeBadge('checking', '检测中');
  settingsUi.adsDetect.disabled = true;
  try {
    const r = await window.aidcpEdge.adsStatus(formAdsOpts());
    if (r && r.ok) {
      setProbeBadge('connected', '已就绪');
      if (settingsUi.adsEnvMsg.classList.contains('error')) setEnvMsg('', false);
    } else {
      setProbeBadge('warning', '未就绪');
      setEnvMsg(
        `未检测到 AdsPower 本地 API${r && r.error ? '（' + r.error + '）' : ''}。请启动 AdsPower 客户端并开启本地 API，或点下方「下载 AdsPower」。仍可手动填写分身 ID 继续。`,
        true,
      );
    }
  } catch {
    setProbeBadge('warning', '未就绪');
  } finally {
    settingsUi.adsDetect.disabled = false;
  }
}

// 把选中环境的 user_id（非 serial_number）写入分身 ID 输入框（手敲框仍可编辑覆盖）。
function populateEnvs(profiles) {
  const sel = settingsUi.adsEnvSelect;
  const current = settingsUi.adsProfile.value.trim();
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = profiles.length ? '（请选择浏览器环境）' : '（未找到环境，可手动填写分身 ID）';
  sel.appendChild(ph);
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.userId; // ← 写入 adsProfileId 的是 user_id
    const bits = [p.name || '(未命名)'];
    if (p.serialNumber) bits.push('#' + p.serialNumber);
    if (p.groupName) bits.push(p.groupName);
    if (p.proxy) bits.push(p.proxy);
    opt.textContent = `${bits.join(' · ')} — ${p.userId}`;
    if (p.userId && p.userId === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

// 拉取环境列表；失败诚实降级为手敲（疑似鉴权失败提示已用当前填写值、别叫用户重填已填的框）。
async function refreshEnvs() {
  settingsUi.adsRefresh.disabled = true;
  setEnvMsg('正在从 AdsPower 拉取环境…', false);
  try {
    const r = await window.aidcpEdge.adsListProfiles(formAdsOpts());
    if (!r || !r.ok) {
      const authHint = r && r.authLikely
        ? '：疑似开启了 API 校验；若已在上方填了 API Key，本次刷新已用当前填写值，请确认 Key 正确后重试'
        : '';
      setEnvMsg(`拉取环境失败${r && r.error ? '（' + r.error + '）' : ''}${authHint}。可在下方手动填写分身 ID。`, true);
      return;
    }
    populateEnvs(r.profiles || []);
    const extra = r.truncated ? '（环境较多，仅显示前若干条，可在 AdsPower 用分组精简）' : '';
    setEnvMsg(`已加载 ${(r.profiles || []).length} 个环境${extra}。选择后其分身 ID 自动填入下方。`, false);
  } catch (e) {
    setEnvMsg(`拉取环境失败（${e && e.message ? e.message : e}）。可在下方手动填写分身 ID。`, true);
  } finally {
    settingsUi.adsRefresh.disabled = false;
  }
}

settingsUi.adsEnvSelect.addEventListener('change', () => {
  const v = settingsUi.adsEnvSelect.value;
  if (v) settingsUi.adsProfile.value = v; // 选中即写入分身 ID（user_id）
});
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

settingsUi.save.addEventListener('click', async () => {
  const provider = selectedProvider();
  const adsProfileId = settingsUi.adsProfile.value.trim();
  if (provider === 'adspower') probeAds(); // 保存并启动前探一次可用性（早反馈，不阻塞保存）
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
window.aidcpEdge.getSettings().then((s) => {
  applySettings(s);
  // 面板加载时若为 AdsPower 模式即探一次（真实事件，低频；非「打开设置面板」）。
  if (selectedProvider() === 'adspower') probeAds();
});
window.aidcpEdge.getStatus().then(render);
