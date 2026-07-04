const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, Notification, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { hasXhsCookie, launchChrome } = require('./chrome-launcher.cjs');
const { createAdsLocalApi } = require('./ads-local-api.cjs');
const { createAdsWriteApi } = require('./ads-write-api.cjs');
const adsFingerprint = require('./ads-fingerprint.cjs');
const { createCreateFlow } = require('./ads-create-flow.cjs');
const os = require('node:os');
const { createUiEventStream, mergeStats } = require('./ui-events.cjs');

// 主进程侧 AdsPower 只读客户端（探测 + 环境列表）。单例持有本进程内**唯一**串行节流（1req/s）。
// 与核心子进程内的 AdsPowerProvider 节流各自独立（跨进程无法共享内存队列，见 ads-local-api.cjs 头注）。
const adsApi = createAdsLocalApi({});

let mainWindow;
let tray;
let edgeProcess;
let loginPoller;
let isQuitting = false;
// 保存后重启标记：SIGTERM 旧边缘进程后，其 exit 回调据此按新 provider 起，而非误判为异常退出弹窗。
let restartPending = false;
// 暂停触发的 SIGTERM 标记（一次性）：供退出回调把本次退出判为「有意停止」，不弹异常退出告警。
// 尤其治「核心启动窗口内点暂停」——此时核心的 SIGTERM handler 尚未安装，会被 signal 直接终止（signal!=null）
// 而被误判为异常退出。
let pausePending = false;

// AdsPower 官方下载页（客户端「下载 AdsPower」按钮外链）。
const ADS_DOWNLOAD_URL = 'https://www.adspower.net/download';

// ── 边端日志落文件（排障用）──────────────────────────────────────────────
// 核心子进程 stdout/stderr 除了进 UI 活动流，再逐行 append 到 userData/logs/edge.log，
// 便于事后精确复盘（筛选重试 / note.open 分支 / 离线等只在 UI 流一闪而过、无法回溯）。
// 单文件 + 到 ~5MB 轮转一次（.1 备份）；纯 tee，绝不参与状态判断、失败静默不影响核心。
let edgeLogStream;
function edgeLogFilePath() {
  return path.join(app.getPath('userData'), 'logs', 'edge.log');
}
function ensureEdgeLogStream() {
  if (edgeLogStream) return edgeLogStream;
  try {
    const file = edgeLogFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const st = fs.statSync(file);
      if (st.size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1'); // 轮转
    } catch { /* 无旧文件 */ }
    edgeLogStream = fs.createWriteStream(file, { flags: 'a' });
    edgeLogStream.on('error', () => { edgeLogStream = undefined; }); // 写失败即弃、不抛
  } catch {
    edgeLogStream = undefined;
  }
  return edgeLogStream;
}
function appendEdgeLog(line, isError) {
  const s = ensureEdgeLogStream();
  if (!s) return;
  try {
    s.write(`${new Date().toISOString()} ${isError ? 'ERR' : '   '} ${line}\n`);
  } catch { /* ignore */ }
}

// 桌面客户端浏览器 provider 设置（持久化到 userData/settings.json）：
//  - provider='adspower'（默认）：核心进程经 AdsPower 本地 API 托管指纹浏览器（每分身独立指纹/IP，防同机多账号关联）；
//    须填 adsProfileId（= AdsPower 分身 id / AIDCP_ADS_USER_ID），apiKey/apiBase 可选（AdsPower 可关 API 校验）。
//  - provider='self'：自起本机真实指纹 Chrome（等价旧桌面行为，固定 9222 + cookie 轮询登录门）。
// 敏感值（apiKey）只落本机 userData、随用户机器，不进仓库 / 不外发。
const DEFAULT_SETTINGS = {
  provider: 'adspower',
  adsProfileId: '',
  adsApiKey: '',
  adsApiBase: '',
  // 选中环境的 AdsPower 环境名（操作者自己起的分身名，如「Tmax」）：作标题带账号标签的兜底
  // （小红书昵称仅 navigate 身份路径可得；环境名桌面端现成可得、且通常就叫账号名）。
  adsProfileName: '',
  // 「开发者详情」（原始日志区）默认不展示，在设置抽屉里开关（客户版首屏零技术噪音）。
  devDetails: false,
};
let settings = { ...DEFAULT_SETTINGS };

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  if (settings.provider !== 'self' && settings.provider !== 'adspower') settings.provider = 'adspower';
  return settings;
}

// 返回 { ok, error }：写盘成功 ok=true；失败 ok=false 并带 error 文案。
// 红线（绝不静默假成功）：写盘失败时当次仍用内存设置继续跑，但 MUST 把「未持久化」如实回报给上层 / UI，
// 绝不谎报保存成功——否则用户以为已存、重启后配置丢失却毫无提示。
function saveSettings(patch) {
  settings = { ...settings, ...(patch || {}) };
  if (settings.provider !== 'self' && settings.provider !== 'adspower') settings.provider = 'adspower';
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true };
  } catch (error) {
    console.error('[aidcp-edge] settings 写入失败:', error?.message);
    return { ok: false, error: error?.message || '未知错误' };
  }
}

// 由当前设置推导注入给核心进程的 provider 相关 env。
// 'self' 在前、被 ...process.env 覆盖 → 外部显式设 AIDCP_BROWSER_PROVIDER 等仍是逃生阀、优先生效。
function buildProviderEnv() {
  if (settings.provider === 'self') return { AIDCP_BROWSER_PROVIDER: 'self' };
  const env = {
    AIDCP_BROWSER_PROVIDER: 'adspower',
    AIDCP_ADS_USER_ID: settings.adsProfileId,
  };
  if (settings.adsApiKey) env.AIDCP_ADS_API_KEY = settings.adsApiKey;
  if (settings.adsApiBase) env.AIDCP_ADS_API_BASE = settings.adsApiBase;
  return env;
}

// 解析只读调用的 base/key：优先用渲染层传入的**当前表单值**（支持「新填 key 未保存即刷新」而不陷回环），
// 表单未带该字段才回落持久化 settings。apiKey 只用于本次请求头、不落日志 / 不写文件。
function resolveAdsOpts(formOpts) {
  const o = formOpts || {};
  // apiKey / apiBase 同一套语义：表单当前值非空则用之，为空才回落持久化 settings（D5）。
  const apiBase = (o.apiBase && String(o.apiBase).trim()) || settings.adsApiBase || undefined;
  const formKey = Object.prototype.hasOwnProperty.call(o, 'apiKey') ? String(o.apiKey).trim() : '';
  const apiKey = formKey || settings.adsApiKey;
  const out = {};
  if (apiBase) out.apiBase = apiBase;
  if (apiKey) out.apiKey = apiKey;
  if (o.groupId) out.groupId = o.groupId;
  return out;
}

// 「打开 AdsPower 新建环境」best-effort：AdsPower 不公开直达其内部「新建浏览器」tab 的深链，
// 故只能尝试拉起 / 聚焦客户端；起不来（未装 / 应用名不符）诚实退回打开官方页面。面板另有引导文案。
// 返回 { launched }：true=真拉起了本机 AdsPower 客户端；false=退回打开了官网。异步等 `open -a` 结果，
// 让 launched 如实反映（避免面板对着官网却说「已打开 AdsPower」——复查确认的误导文案）。
async function openAdsClient() {
  if (process.platform === 'darwin') {
    const launched = await new Promise((resolve) => {
      try {
        const child = spawn('open', ['-a', 'AdsPower Global'], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
    if (launched) return { launched: true };
  }
  // 未装 / 拉起失败 / 非 macOS：诚实退回官方页面（非直达新建页）。
  void shell.openExternal(ADS_DOWNLOAD_URL);
  return { launched: false };
}

const status = {
  provider: 'adspower',
  cloud: 'disconnected',
  auth: 'checking',
  session: 'idle',
  stats: {
    views: 0,
    likes: 0,
    collects: 0,
    comments: 0,
  },
  risk: 'normal',
  edge: 'stopped',
  lastMessage: '边缘进程尚未运行。',
  updatedAt: new Date().toISOString(),
  // 陪伴式界面新增字段（形状兼容：旧字段全保留，旧渲染层忽略即可）。
  // account：账号身份（由核心「账号身份已确立」行带出，标题带展示）。
  account: null,
  // presence：在场感行（当前正在做什么 + 时间戳）；动效门在渲染层按新鲜度自持。
  presence: { text: '等待启动…', at: new Date().toISOString() },
  // publish：发布卡只读投影（pending/reminded/approved/published/rejected/failed）。
  publish: null,
  // lastPublish：最近一次成功发布 {title, at}（本地持久化，重启不丢；云端快照接入后以云端为准）。
  lastPublish: null,
};

// 轻量 UI 状态持久化（与用户设置分文件；只存展示性历史，如最近发布）。
function uiStateFile() {
  return path.join(app.getPath('userData'), 'ui-state.json');
}

function loadUiState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(uiStateFile(), 'utf8'));
    if (parsed && parsed.lastPublish && typeof parsed.lastPublish.title === 'string') {
      status.lastPublish = { title: parsed.lastPublish.title, at: parsed.lastPublish.at || null };
    }
  } catch {
    /* 无历史/坏文件按空处理 */
  }
}

function saveUiState() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(uiStateFile(), JSON.stringify({ lastPublish: status.lastPublish }, null, 2), 'utf8');
  } catch (error) {
    console.error('[aidcp-edge] ui-state 写入失败:', error?.message); // 展示性历史，写失败不阻断
  }
}

// 核心日志 → UI 事件（结构化优先、中文行映射兜底；计数迁入该模块并修正为仅 ✓ 成功行计数）。
const uiEvents = createUiEventStream();

// Windows 叠加窗控随风控状态染色（mac 红绿灯为系统绘制、无需管）。
// 仅 win32 且 overlay 存在时可调；Electron 在未启用 overlay 时会抛错，故 try/catch 包裹。
const OVERLAY_TONES = {
  normal: { color: '#eef4ff', symbolColor: '#1a2233', height: 46 },
  warned: { color: '#fdf3e0', symbolColor: '#5b4708', height: 46 },
  danger: { color: '#fde8e8', symbolColor: '#7f1d1d', height: 46 },
};

function applyOverlayTone(risk) {
  if (process.platform !== 'win32' || !mainWindow) return;
  const tone = risk === 'restricted' || risk === 'frozen' ? 'danger' : risk === 'warned' ? 'warned' : 'normal';
  try {
    mainWindow.setTitleBarOverlay(OVERLAY_TONES[tone]);
  } catch {
    /* overlay 未启用（如 env 强制默认框）时忽略 */
  }
}

function updateStatus(patch) {
  // 计数补丁先跟现值合并成**完整** stats 再落（修老 bug：Object.assign 先把 stats 整体
  // 替换成局部补丁，随后的合并对象已被替换 → 未提及的计数被清空、渲染层出现空数字）。
  const full = patch.stats ? { ...patch, stats: mergeStats(status.stats, patch.stats) } : patch;
  Object.assign(status, full, { updatedAt: new Date().toISOString() });
  if (patch.risk) applyOverlayTone(patch.risk);
  if (full.lastPublish) saveUiState();
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('status:update', status);
  });
}

// 在场感更新的便捷封装：文案 + 现在时刻。
function presencePatch(text) {
  return { presence: { text, at: new Date().toISOString() } };
}

// 活动流条目单独走 ui:activity 通道（无界流不塞进 status 对象）。
function broadcastActivity(entry) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('ui:activity', entry);
  });
}

// 红线「不静默假成功」：edge 崩溃 / Chrome 缺失 / 连云失败时，把窗口拉到前台 + 发系统通知，
// 让托盘最小化的运维立刻看见，而不是停在「运行中」外观空跑。仅暴露失败，不做任何重试/兜底。
function surfaceFailure(title, body) {
  try {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch {
    /* best-effort */
  }
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch {
    /* best-effort */
  }
}

// 自定义标题带的窗框选项：隐藏系统标题栏但保留**原生**窗控（mac 红绿灯内嵌 / Windows 叠加窗控）。
// 绝不用 frame:false（会丢原生关闭/缩放，非技术用户可能关不掉窗）。其余平台维持默认框。
function frameOptions() {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 16 } };
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#eef4ff', symbolColor: '#1a2233', height: 46 },
    };
  }
  return {};
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 640,
    minHeight: 520,
    title: 'AIDCP Edge',
    ...frameOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="%232563eb"/><g stroke="%23ffffff" stroke-opacity="0.5" stroke-width="1.4" stroke-linecap="round"><line x1="16" y1="16" x2="16" y2="7"/><line x1="16" y1="16" x2="8.2" y2="20.5"/><line x1="16" y1="16" x2="23.8" y2="20.5"/></g><circle cx="8.2" cy="20.5" r="2.4" fill="%23ffffff"/><circle cx="23.8" cy="20.5" r="2.4" fill="%23ffffff"/><circle cx="16" cy="7" r="2.6" fill="%23ff6b6b"/><circle cx="16" cy="16" r="4" fill="%23ffffff"/></svg>',
  );
  tray = new Tray(icon);
  tray.setToolTip('AIDCP Edge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => mainWindow?.show() },
    { label: '隐藏窗口', click: () => mainWindow?.hide() },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]));
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

function startEdge() {
  if (edgeProcess) return;
  // 打包后用 Electron 自带的 Node 运行预编译产物（ELECTRON_RUN_AS_NODE），
  // 不依赖目标机装 Node/npx/tsx。entry 为 build:dist 编译出的 dist/main.js。
  const appRoot = app.getAppPath();
  const edgeEntry = path.join(appRoot, 'dist', 'main.js');
  // 浏览器 provider 由桌面设置决定（默认 adspower：核心经 AdsPower 本地 API 托管指纹浏览器；
  // self：桌面自起 Chrome 流程 chrome-launcher.cjs 固定 9222）。provider env 在前、被 ...process.env
  // 覆盖 → 外部显式设置仍是逃生阀、优先生效。
  const wasAdspower = settings.provider === 'adspower';
  edgeProcess = spawn(process.execPath, [edgeEntry], {
    cwd: appRoot,
    env: { ...buildProviderEnv(), ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // 发布卡在途状态随核心（重）启动清零（edge-companion-ui 8.1 评审修正）：离线窗口内的审批变化
  // （拒绝/失败）推送会如实丢失，旧 pending/approved 卡若不清会永久滞留成陈卡；真在候审/已批的
  // 草稿由重连后的云端 hello 快照重新推回（pending/approved 可重建，终态不回放）。lastPublish
  // 历史态不清（持久数据，云端快照到位后以云端为准覆盖）。
  updateStatus({ edge: 'starting', session: 'running', publish: null, lastMessage: '正在启动 aidcp-edge…', ...presencePatch('正在启动引擎…') });

  edgeProcess.stdout.on('data', (chunk) => handleEdgeOutput(chunk.toString()));
  edgeProcess.stderr.on('data', (chunk) => handleEdgeOutput(chunk.toString(), true));
  edgeProcess.on('exit', (code, signal) => {
    edgeProcess = undefined;
    // 主动重启（保存设置后按新 provider 起）、暂停、退出应用都是「有意停止」，不算异常、不弹窗。
    // pausePending 一次性消费：治「启动窗口内点暂停」——handler 未装时被 SIGTERM 终止(signal!=null)本不是异常。
    const intentional = isQuitting || restartPending || pausePending;
    pausePending = false;
    const exitedAbnormally = !intentional && (signal != null || (code != null && code !== 0));
    updateStatus({
      edge: exitedAbnormally ? 'warning' : 'stopped',
      cloud: 'disconnected',
      session: status.session === 'paused' ? 'paused' : 'idle',
      // 核心已退出 = 无在跑会话：把本地日志派生的 risk 徽标复位 normal（该徽标是日志关键词启发、非权威，
      // 真风控由云端单写），杜绝上一会话残留的「⚠」把徽标跨会话卡在「警戒」。
      risk: 'normal',
      lastMessage: `边缘进程已退出${code === null ? '' : `（code ${code}`}${signal ? ` ${signal}` : ''}${code === null ? '' : '）'}。`,
      ...presencePatch(status.session === 'paused' ? '已暂停，随时可以恢复' : '引擎已停止'),
    });
    // 红线：异常退出（含连云失败 / adspower 未登录致诚实非零退出）不静默——主动弹窗 + 系统通知。
    if (exitedAbnormally) {
      // adspower 模式下最常见的诚实非零退出 = 分身未登录小红书导致身份确立失败（core exit 1）。
      const adspowerHint = wasAdspower
        ? '若使用 AdsPower：请在该分身的浏览器窗口登录小红书后，点击「重新登录」重试；并确认 AdsPower 客户端已运行、本地 API 已开启、分身 ID 正确。'
        : '请打开窗口查看日志 / 重新登录或重连云端。';
      surfaceFailure(
        'AIDCP Edge 已停止运行',
        `边缘进程异常退出${code === null ? '' : `（code ${code}`}${signal ? ` ${signal}` : ''}${code === null ? '' : '）'}。${adspowerHint}`,
      );
    }
    // 有意重启：旧进程退出后按当前设置起新流程。退出应用途中（isQuitting）绝不再起——
    // 否则会在关闭后留下孤儿核心 + 它拉起的浏览器。
    if (restartPending) {
      restartPending = false;
      if (!isQuitting) startFlow();
    }
  });
}

function stopLoginPoller() {
  if (loginPoller) {
    clearInterval(loginPoller);
    loginPoller = undefined;
  }
}

// 以下 checkLoginAndStart / launchChromeAndGateEdge 为 self（本机 Chrome）专属登录门：
// 固定 9222 起 Chrome → 轮询 cookie 确认已登录小红书 → 再起核心。adspower 模式不走此路（见 startAdsPowerFlow）。
async function checkLoginAndStart() {
  try {
    const loggedIn = await hasXhsCookie();
    if (loggedIn) {
      stopLoginPoller();
      updateStatus({ auth: 'logged in', lastMessage: '已检测到小红书登录，正在启动 aidcp-edge…' });
      startEdge();
      return true;
    }
    updateStatus({
      auth: 'login required',
      session: 'idle',
      lastMessage: '请在刚打开的 Chrome 窗口中登录 xiaohongshu.com。',
      ...presencePatch('等你登录小红书后继续'),
    });
    return false;
  } catch (error) {
    updateStatus({ auth: 'checking', lastMessage: `正在等待 Chrome CDP：${error.message}` });
    return false;
  }
}

async function launchChromeAndGateEdge() {
  updateStatus({ provider: 'self' });
  const launched = await launchChrome(app);
  if (!launched.ok) {
    // session 显式回 idle：stopAndRestart 曾乐观置 running，此处不清会残留绿色「运行中」与实际停止矛盾。
    updateStatus({ auth: 'chrome missing', edge: 'stopped', session: 'idle', lastMessage: launched.error });
    // 红线：Chrome 缺失诚实暴露，不静默装作在跑。
    surfaceFailure('AIDCP Edge 无法启动', launched.error || '未找到 Google Chrome，请安装后重启。');
    return;
  }
  updateStatus({ auth: 'checking', lastMessage: `Chrome 已启动，配置目录：${launched.profilePath}` });
  const loggedIn = await checkLoginAndStart();
  if (!loggedIn && !loginPoller) {
    loginPoller = setInterval(checkLoginAndStart, 5000);
  }
}

// adspower（AdsPower 指纹浏览器）路径：不自起本机 Chrome、不做 9222 cookie 轮询；
// 浏览器启动 / 登录态 / 身份确立全由核心进程经 AdsPower 本地 API 完成（未登录 → 核心诚实非零退出并弹窗）。
function startAdsPowerFlow() {
  updateStatus({ provider: 'adspower' });
  if (!settings.adsProfileId || !settings.adsProfileId.trim()) {
    // 缺分身 ID 无法启动：诚实提示待配置，不静默假装在跑。
    updateStatus({
      auth: 'config required',
      edge: 'stopped',
      session: 'idle',
      lastMessage: '请在「浏览器」设置中填写 AdsPower 分身 ID，然后点击「保存并启动」。',
      ...presencePatch('等待完成初始设置'),
    });
    return;
  }
  updateStatus({
    auth: 'checking',
    lastMessage: '正在通过 AdsPower 启动指纹浏览器…',
    // 环境名现成可得：启动即点亮标题带账号标签，不用等核心身份确立。
    ...(settings.adsProfileName ? { account: { id: settings.adsProfileId, name: settings.adsProfileName, source: 'env' } } : {}),
  });
  startEdge();
}

// 按当前 provider 设置分派启动流程。
function startFlow() {
  if (settings.provider === 'self') {
    launchChromeAndGateEdge();
  } else {
    startAdsPowerFlow();
  }
}

// 有序重启：停登录轮询；若核心在跑则 SIGTERM 之，其 exit 回调据 restartPending 起新流程（避免与
// startEdge 的「已在跑则跳过」相撞导致重启丢失）；无在跑核心时直接按当前 provider 起。
// 供「保存设置」「恢复」「重新登录」三处复用。
function stopAndRestart(message, patch = {}) {
  stopLoginPoller();
  updateStatus({ cloud: 'disconnected', session: 'running', lastMessage: message, ...presencePatch('正在重启引擎…'), ...patch });
  if (edgeProcess) {
    restartPending = true;
    edgeProcess.kill('SIGTERM');
  } else {
    startFlow();
  }
}

function handleEdgeOutput(text, isError = false) {
  // 一个 chunk 可能带多行：逐行处理，让活动流 / 计数按真实行数走（旧法整块只算一次）。
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) handleEdgeLogLine(line, isError);
}

function handleEdgeLogLine(message, isError = false) {
  appendEdgeLog(message, isError); // 落文件（排障回溯，独立于下方状态判断）
  // 核心正被有意停止 / 已暂停 / 已退出：其关闭期 stdout/stderr 只作为日志行展示，绝不据以翻转
  // edge / session / risk 徽标，也不产 UI 事件——否则关闭 chatter 会把「已暂停/已停止」闪回
  // 「运行中/异常」，或让在场感在停机后还「活着」。正常在跑时才做状态推断。
  const stopping = isQuitting || restartPending || pausePending || !edgeProcess || status.session === 'paused';
  if (stopping) {
    updateStatus({ lastMessage: message });
    return;
  }
  const next = { edge: isError ? 'warning' : 'running', lastMessage: message };
  if (message.includes('已连接云端') || message.includes('已握手')) next.cloud = 'connected';
  if (message.includes('连接失败') || message.includes('WS 已关闭') || message.includes('启动失败')) next.cloud = 'disconnected';
  if (
    message.includes('自动浏览已启动') ||
    message.includes('启动自动浏览循环') ||
    message.includes('启动命令驱动浏览循环') ||
    message.includes('唤醒重启浏览循环')
  ) {
    next.session = 'running';
  }
  if (message.includes('浏览循环结束')) {
    next.session = message.includes('后继续') ? 'resting' : 'idle';
  }
  if (message.includes('风控拒绝') || message.includes('risk_error') || message.includes('⚠')) next.risk = 'warned';

  // UI 事件（活动流 / 在场感 / 发布卡 / 账号身份 / 计数）统一走 ui-events 模块：
  // 结构化 [ui-event] 行优先，中文日志行映射兜底；计数只认 ✓ 成功行（见模块头注的偏离说明）。
  const evt = uiEvents.push(message);
  if (evt) {
    if (evt.account) {
      // 账号标签兜底链：小红书昵称（navigate 身份路径才有）> AdsPower 环境名 > 渲染层再兜尾4位。
      const name = evt.account.name || settings.adsProfileName || '';
      status.account = { id: evt.account.id, name, source: evt.account.name ? 'xhs' : 'env' };
    }
    if (evt.presence) next.presence = { text: evt.presence, at: new Date().toISOString() };
    if (evt.publish && evt.publish.state) {
      next.publish = { ...evt.publish, at: new Date().toISOString() };
      // 发布成功即更新「最近一次发布」并落盘（发布卡常驻的历史态，重启不丢）。
      if (evt.publish.state === 'published' && evt.publish.title) {
        next.lastPublish = { title: evt.publish.title, at: next.publish.at };
      }
    }
    if (evt.lastPublish && typeof evt.lastPublish.title === 'string' && evt.lastPublish.title) {
      // 云端快照回填「上次发布」（edge-companion-ui 8.1）：以云端为准覆盖本地 ui-state；
      // 只更新历史态，不折活动流、不计数（这不是「刚发生」的事件）。
      next.lastPublish = {
        title: evt.lastPublish.title,
        at: Number.isFinite(evt.lastPublish.at) ? new Date(evt.lastPublish.at).toISOString() : null,
      };
    }
    if (evt.statsDelta) {
      const d = evt.statsDelta;
      next.stats = {
        ...(next.stats || {}),
        ...(d.views ? { views: status.stats.views + d.views } : {}),
        ...(d.likes ? { likes: status.stats.likes + d.likes } : {}),
        ...(d.collects ? { collects: status.stats.collects + d.collects } : {}),
        ...(d.comments ? { comments: (status.stats.comments || 0) + d.comments } : {}),
      };
    }
    if (evt.sentence) {
      broadcastActivity({
        ts: new Date().toISOString(),
        type: evt.type || 'info',
        sentence: evt.sentence,
        ...(evt.loopStage !== undefined ? { loopStage: evt.loopStage } : {}),
      });
    }
    if (evt.loopStage !== undefined) next.loopStage = evt.loopStage;
  }
  updateStatus(next);
}

function pauseEdge() {
  // 暂停取消任何在途重启：否则核心退出回调会据 restartPending 复活它，把用户的暂停覆盖回运行。
  restartPending = false;
  updateStatus({ session: 'paused', lastMessage: '已请求暂停，后台边缘进程将在安全点停止。', ...presencePatch('已暂停，随时可以恢复') });
  if (edgeProcess) {
    // 暂停是「有意停止」：标记之，使其 SIGTERM 触发的退出不被误判为异常（尤其核心启动窗口内 handler 未装时）。
    pausePending = true;
    edgeProcess.kill('SIGTERM');
  }
}

function resumeEdge() {
  stopAndRestart('已请求恢复，正在按当前浏览器设置重启边缘进程。');
}

function relogin() {
  stopAndRestart('已请求重新登录，正在按当前浏览器设置重启边缘进程。');
  return status;
}

function quitApp() {
  isQuitting = true;
  restartPending = false; // 退出即作废任何在途重启，杜绝关闭后孤儿核心
  if (edgeProcess) {
    edgeProcess.kill('SIGTERM');
    edgeProcess = undefined;
  }
  stopLoginPoller();
  app.quit();
}

ipcMain.handle('status:get', () => status);
ipcMain.handle('edge:pause', () => {
  pauseEdge();
  return status;
});
ipcMain.handle('edge:resume', () => {
  resumeEdge();
  return status;
});
ipcMain.handle('auth:relogin', () => relogin());
ipcMain.handle('settings:get', () => ({ ...settings, adsDownloadUrl: ADS_DOWNLOAD_URL }));
ipcMain.handle('settings:save', (_event, patch) => {
  const res = saveSettings(patch);
  // 保存只持久化、**不打断**在跑的核心（应用改动经显式 edge:restart「按新设置重启」）。
  updateStatus({
    provider: settings.provider,
    lastMessage: res.ok ? '浏览器设置已保存。' : '设置已应用（本次生效），但写入本地失败，重启应用后可能丢失。',
  });
  return { ...settings, adsDownloadUrl: ADS_DOWNLOAD_URL, saveOk: res.ok, saveError: res.error };
});
// 悬浮「启动」：核心未跑则按当前设置启动；已在跑则不重复启动。
ipcMain.handle('edge:start', () => {
  if (!edgeProcess) startFlow();
  return status;
});
// 「按新设置重启」：显式应用已保存的设置到在跑核心（有序重启，不由保存隐式打断）。
ipcMain.handle('edge:restart', () => {
  stopAndRestart('正在按新设置重启边缘进程…');
  return status;
});
// 「打开飞书 ↗」：纯导航（拉起飞书客户端），不是审批操作——审批授权只在飞书内完成。
// 依次尝试 feishu:// 与 lark:// 协议；都拉不起则如实返回 ok:false，渲染层降级为纯文字。
ipcMain.handle('feishu:open', async () => {
  for (const url of ['feishu://', 'lark://']) {
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      /* 未注册该协议，试下一个 */
    }
  }
  return { ok: false };
});
ipcMain.handle('browser:openAdsDownload', () => {
  void shell.openExternal(ADS_DOWNLOAD_URL);
  return true;
});
// AdsPower 只读探测 / 拉取（主进程侧，渲染层不直连本地 API）。opts 可带渲染层当前表单 apiKey/apiBase/groupId。
ipcMain.handle('ads:status', (_event, opts) => adsApi.status(resolveAdsOpts(opts)));
ipcMain.handle('ads:listProfiles', (_event, opts) => adsApi.listProfiles(resolveAdsOpts(opts)));
ipcMain.handle('ads:openCreate', () => openAdsClient());

// ── 「创建环境」程序化建号（change adspower-auto-create-env）：写客户端 allowlist + 指纹引擎 + 编排 ──
const ENV_GROUP_NAME = 'aidcp-创建';
let cachedEnvGroupId = null;
let adsCreateInFlight = false; // 进程级单飞互斥（防连点双建）

function templateLabel(t) {
  const osName = t.os === 'windows' ? 'Windows' : t.os === 'macos' ? 'Mac' : t.os;
  return `${osName} · ${t.hardwareConcurrency}核 ${t.deviceMemory}G`;
}

// 定位/复用专用分组（先 group/list 查、没有则建、并发 repeat 再查一次）。
async function ensureEnvGroup(writeApi, adsOpts) {
  if (cachedEnvGroupId) return { ok: true, groupId: cachedEnvGroupId };
  const pick = (r) => (r.ok ? ((r.groups.find((g) => g.groupName === ENV_GROUP_NAME) || {}).groupId || '') : '');
  let gid = pick(await adsApi.listGroups(adsOpts));
  if (!gid) {
    const cr = await writeApi.createGroup(ENV_GROUP_NAME, adsOpts);
    gid = cr.ok ? cr.groupId : pick(await adsApi.listGroups(adsOpts));
    if (!gid) return { ok: false, error: cr.error || '无法定位/创建专用分组' };
  }
  cachedEnvGroupId = gid;
  return { ok: true, groupId: gid };
}

// 整机模板清单（供渲染层下拉，一处真源）。
ipcMain.handle('ads:templates', () =>
  adsFingerprint.DEVICE_TEMPLATES.map((t) => ({ key: t.key, label: templateLabel(t) })),
);

// 程序化建一个指纹环境。opts: { templateKey, apiKey?, apiBase? }。代理不碰（默认 no_proxy、手工配）。
ipcMain.handle('ads:createEnv', async (_event, opts) => {
  if (adsCreateInFlight) return { ok: false, error: '创建进行中，请等当前创建完成' };
  adsCreateInFlight = true;
  try {
    const ads = resolveAdsOpts(opts);
    // 凭据只内存（deps），绝不落 settings；写客户端错误层已脱敏。
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    const grp = await ensureEnvGroup(writeApi, ads);
    if (!grp.ok) return { ok: false, error: grp.error };
    const flow = createCreateFlow({ writeApi, fingerprint: adsFingerprint });
    return await flow.createEnvironment({
      templateKey: (opts && opts.templateKey) || '',
      intendedAccountLabel: opts && opts.intendedAccountLabel,
      machineLabel: os.hostname(),
      groupId: grp.groupId,
    });
  } catch (e) {
    return { ok: false, error: `创建失败：${(e && e.message) || String(e)}` };
  } finally {
    adsCreateInFlight = false;
  }
});

// 删除环境（C3 放宽为 UI 确认删）：仅由渲染层逐个显式二次确认触发；本处不自动、不批量。
ipcMain.handle('ads:deleteEnv', async (_event, opts) => {
  const userId = opts && opts.userId;
  if (!userId) return { ok: false, error: '缺 userId' };
  try {
    const ads = resolveAdsOpts(opts);
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    return await writeApi.deleteProfile(String(userId), ads);
  } catch (e) {
    return { ok: false, error: `删除失败：${(e && e.message) || String(e)}` };
  }
});

// 诚实拒绝同机多开（多账号多开隔离尚未实现，归 account-identity-from-login）：
// 当前第二个实例会接管第一个账号的浏览器（串号），故用单实例锁直接拒绝第二个，绝不静默接管。
// 锁随本实例退出自动释放，故「同一应用重启后重连自己的浏览器」不受影响。
if (!app.requestSingleInstanceLock()) {
  try {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'AIDCP Edge 已在运行',
      '本机已有一个 AIDCP Edge 在运行。多账号多开尚未支持，为避免账号串用，请先关闭已运行的实例再启动。',
    );
  } catch {
    /* best-effort */
  }
  app.quit();
} else {
  // 又有人想开第二个：Electron 通知已运行实例——把窗口拉到前台 + 通知，说明无需/不能多开。
  app.on('second-instance', () => {
    surfaceFailure('AIDCP Edge 已在运行', '已有一个 AIDCP Edge 在运行，已切到该窗口。多账号多开尚未支持。');
  });

  app.whenReady().then(() => {
    loadSettings();
    loadUiState();
    updateStatus({ provider: settings.provider });
    createWindow();
    createTray();
    // 不自动启动任务（用户手动点右下角「启动」才开跑）。只做一次轻量预检：
    // 缺配置时把「待配置」引导亮出来，配置齐备则诚实呈现「就绪」。
    if (settings.provider === 'adspower' && !(settings.adsProfileId || '').trim()) {
      updateStatus({
        auth: 'config required',
        lastMessage: '待配置：请在设置中选择浏览器环境后点「启动」。',
        ...presencePatch('等待完成初始设置'),
      });
    } else {
      updateStatus({
        lastMessage: '就绪。点右下角「启动」开始自动运营。',
        ...presencePatch('就绪，等你点「启动」'),
        // 默认态即选中上次用的账号：用持久化设置点亮标题带（不再依赖启动流程）。
        ...(settings.provider === 'adspower' && settings.adsProfileId
          ? { account: { id: settings.adsProfileId, name: settings.adsProfileName || '', source: 'env' } }
          : {}),
      });
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow?.show();
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
