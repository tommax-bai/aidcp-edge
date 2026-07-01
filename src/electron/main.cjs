const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, Notification, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { hasXhsCookie, launchChrome } = require('./chrome-launcher.cjs');
const { createAdsLocalApi } = require('./ads-local-api.cjs');

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

// AdsPower 官方下载页（客户端「下载 AdsPower」按钮外链）。
const ADS_DOWNLOAD_URL = 'https://www.adspower.net/download';

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
  const apiBase = (o.apiBase && String(o.apiBase).trim()) || settings.adsApiBase || undefined;
  const apiKey = Object.prototype.hasOwnProperty.call(o, 'apiKey') ? o.apiKey : settings.adsApiKey;
  const out = {};
  if (apiBase) out.apiBase = apiBase;
  if (apiKey) out.apiKey = apiKey;
  if (o.groupId) out.groupId = o.groupId;
  return out;
}

// 「打开 AdsPower 新建环境」best-effort：AdsPower 不公开直达其内部「新建浏览器」tab 的深链，
// 故只能尝试拉起 / 聚焦客户端；起不来（未装 / 应用名不符）诚实退回打开官方页面。面板另有引导文案。
function openAdsClient() {
  try {
    if (process.platform === 'darwin') {
      const child = spawn('open', ['-a', 'AdsPower Global'], { stdio: 'ignore', detached: true });
      let fellBack = false;
      const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        void shell.openExternal(ADS_DOWNLOAD_URL);
      };
      child.on('error', fallback);
      child.on('exit', (code) => {
        if (code !== 0) fallback();
      });
      return { launched: true };
    }
  } catch {
    /* 落到下面的官网兜底 */
  }
  // 非 macOS 或拉起异常：诚实退回官方页面（非直达新建页）。
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
  },
  risk: 'normal',
  edge: 'stopped',
  lastMessage: '边缘进程尚未运行。',
  updatedAt: new Date().toISOString(),
};

function updateStatus(patch) {
  Object.assign(status, patch, { updatedAt: new Date().toISOString() });
  if (patch.stats) {
    status.stats = { ...status.stats, ...patch.stats };
  }
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('status:update', status);
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    title: 'AIDCP Edge',
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

  updateStatus({ edge: 'starting', session: 'running', lastMessage: '正在启动 aidcp-edge…' });

  edgeProcess.stdout.on('data', (chunk) => handleEdgeOutput(chunk.toString()));
  edgeProcess.stderr.on('data', (chunk) => handleEdgeOutput(chunk.toString(), true));
  edgeProcess.on('exit', (code, signal) => {
    edgeProcess = undefined;
    // 主动重启（保存设置后按新 provider 起）与退出应用一样是「有意停止」，不算异常、不弹窗。
    const intentional = isQuitting || restartPending;
    const exitedAbnormally = !intentional && (signal != null || (code != null && code !== 0));
    updateStatus({
      edge: exitedAbnormally ? 'warning' : 'stopped',
      cloud: 'disconnected',
      session: status.session === 'paused' ? 'paused' : 'idle',
      lastMessage: `边缘进程已退出${code === null ? '' : `（code ${code}`}${signal ? ` ${signal}` : ''}${code === null ? '' : '）'}。`,
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
    });
    return;
  }
  updateStatus({ auth: 'checking', lastMessage: '正在通过 AdsPower 启动指纹浏览器…' });
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
  updateStatus({ cloud: 'disconnected', session: 'running', lastMessage: message, ...patch });
  if (edgeProcess) {
    restartPending = true;
    edgeProcess.kill('SIGTERM');
  } else {
    startFlow();
  }
}

function handleEdgeOutput(text, isError = false) {
  const message = text.trim();
  if (!message) return;
  const next = { edge: isError ? 'warning' : 'running', lastMessage: message };
  if (message.includes('已连接云端') || message.includes('已握手')) next.cloud = 'connected';
  if (message.includes('连接失败') || message.includes('WS 已关闭') || message.includes('启动失败')) next.cloud = 'disconnected';
  if (message.includes('自动浏览已启动') || message.includes('启动自动浏览循环')) next.session = 'running';
  if (message.includes('浏览循环结束') || message.includes('session.end')) next.session = 'idle';
  if (message.includes('上报') || message.includes('提取内容')) next.stats = { views: status.stats.views + 1 };
  if (message.includes('点赞成功') || message.includes('like')) next.stats = { ...(next.stats || {}), likes: status.stats.likes + 1 };
  if (message.includes('收藏成功') || message.includes('collect')) next.stats = { ...(next.stats || {}), collects: status.stats.collects + 1 };
  if (message.includes('风控拒绝') || message.includes('risk_error') || message.includes('⚠')) next.risk = 'warned';
  updateStatus(next);
}

function pauseEdge() {
  // 暂停取消任何在途重启：否则核心退出回调会据 restartPending 复活它，把用户的暂停覆盖回运行。
  restartPending = false;
  updateStatus({ session: 'paused', lastMessage: '已请求暂停，后台边缘进程将在安全点停止。' });
  if (edgeProcess) {
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
  stopAndRestart(
    res.ok ? '设置已保存，正在按新配置重启…' : '设置已应用（本次生效），但写入本地失败，重启应用后可能丢失。',
    { provider: settings.provider },
  );
  return { ...settings, adsDownloadUrl: ADS_DOWNLOAD_URL, saveOk: res.ok, saveError: res.error };
});
ipcMain.handle('browser:openAdsDownload', () => {
  void shell.openExternal(ADS_DOWNLOAD_URL);
  return true;
});
// AdsPower 只读探测 / 拉取（主进程侧，渲染层不直连本地 API）。opts 可带渲染层当前表单 apiKey/apiBase/groupId。
ipcMain.handle('ads:status', (_event, opts) => adsApi.status(resolveAdsOpts(opts)));
ipcMain.handle('ads:listProfiles', (_event, opts) => adsApi.listProfiles(resolveAdsOpts(opts)));
ipcMain.handle('ads:openCreate', () => openAdsClient());

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
    updateStatus({ provider: settings.provider });
    createWindow();
    createTray();
    startFlow();
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