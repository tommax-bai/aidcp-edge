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
  sessionFab: document.querySelector('#session-fab'),
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
// 设置是否相对「已应用/已保存」有改动。核心在跑且 dirty 时才显示「按新设置重启」；
// 「保存」按钮已并入「启动」——启动时先存再起，故无独立保存按钮。
let dirty = false;
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
    body = '请在下方「浏览器」设置里选择一个环境（或在「高级设置」里打开「手动填写」填分身 ID），然后点右下角「启动」。';
  }
  const show = Boolean(title);
  fields.loginGuide.classList.toggle('hidden', !show);
  if (show) {
    fields.noticeTitle.textContent = title;
    fields.noticeBody.textContent = body;
  }
}

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
  renderFab(status);
  updateApplyRestart(); // 依「dirty && 核心在跑」决定是否显示「按新设置重启」
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
  updateApplyRestart();
  return saved;
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

// 直接把环境铺成可点行（非下拉）。每行：名称 + 序号/分组/代理配置/user_id。
function populateEnvs(profiles) {
  const list = settingsUi.adsEnvList;
  const current = settingsUi.adsProfile.value.trim();
  list.innerHTML = '';
  if (!profiles.length) {
    const empty = document.createElement('p');
    empty.className = 'ads-env-empty';
    empty.textContent = '（未找到环境，可在「高级设置」打开「手动填写」填分身 ID）';
    list.appendChild(empty);
    return;
  }
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
    list.appendChild(item);
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
        ? '：疑似开启了 API 校验；若已在「高级设置」里填了 API Key，本次刷新已用当前填写值，请确认 Key 正确后重试'
        : '';
      setEnvMsg(`拉取环境失败${r && r.error ? '（' + r.error + '）' : ''}${authHint}。可在「高级设置」打开「手动填写」填分身 ID。`, true);
      openAdvanced();
      return;
    }
    populateEnvs(r.profiles || []);
    const extra = r.truncated ? '（环境较多，仅显示前若干条，可在 AdsPower 用分组精简）' : '';
    setEnvMsg(`已加载 ${(r.profiles || []).length} 个环境${extra}。点选一个即自动带出分身 ID。`, false);
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
    render(await window.aidcpEdge.relogin());
  } finally {
    fields.relogin.disabled = false;
  }
});

window.aidcpEdge.onStatusUpdate(render);
window.aidcpEdge.getSettings().then((s) => {
  applySettings(s);
  // 面板加载时若为 AdsPower 模式即探一次并自动列环境（真实事件，低频；非「打开设置面板」）。
  if (selectedProvider() === 'adspower') probeAds();
});
window.aidcpEdge.getStatus().then(render);
