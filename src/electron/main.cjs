const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, Notification } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { hasXhsCookie, launchChrome } = require('./chrome-launcher.cjs');

let mainWindow;
let tray;
let edgeProcess;
let loginPoller;
let isQuitting = false;

const status = {
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
  lastMessage: 'Edge is not running.',
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
    'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="%232563eb"/><text x="16" y="21" font-size="14" font-family="Arial" text-anchor="middle" fill="white">AE</text></svg>',
  );
  tray = new Tray(icon);
  tray.setToolTip('AIDCP Edge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow?.show() },
    { label: 'Hide', click: () => mainWindow?.hide() },
    { type: 'separator' },
    { label: 'Quit', click: quitApp },
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
  edgeProcess = spawn(process.execPath, [edgeEntry], {
    cwd: appRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  updateStatus({ edge: 'starting', session: 'running', lastMessage: 'Starting aidcp-edge...' });

  edgeProcess.stdout.on('data', (chunk) => handleEdgeOutput(chunk.toString()));
  edgeProcess.stderr.on('data', (chunk) => handleEdgeOutput(chunk.toString(), true));
  edgeProcess.on('exit', (code, signal) => {
    edgeProcess = undefined;
    const exitedAbnormally = !isQuitting && (signal != null || (code != null && code !== 0));
    updateStatus({
      edge: exitedAbnormally ? 'warning' : 'stopped',
      cloud: 'disconnected',
      session: status.session === 'paused' ? 'paused' : 'idle',
      lastMessage: `Edge exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.`,
    });
    // 红线：异常退出（含连云失败致诚实非零退出）不静默——主动弹窗 + 系统通知。
    if (exitedAbnormally) {
      surfaceFailure(
        'AIDCP Edge 已停止运行',
        `边缘进程异常退出${code === null ? '' : `（code ${code}`}${signal ? ` ${signal}` : ''}${code === null ? '' : '）'}。请打开窗口查看日志/重新登录或重连云端。`,
      );
    }
  });
}

function stopLoginPoller() {
  if (loginPoller) {
    clearInterval(loginPoller);
    loginPoller = undefined;
  }
}

async function checkLoginAndStart() {
  try {
    const loggedIn = await hasXhsCookie();
    if (loggedIn) {
      stopLoginPoller();
      updateStatus({ auth: 'logged in', lastMessage: 'Xiaohongshu login detected. Starting aidcp-edge...' });
      startEdge();
      return true;
    }
    updateStatus({
      auth: 'login required',
      session: 'idle',
      lastMessage: 'Please log in to xiaohongshu.com in the Chrome window that just opened.',
    });
    return false;
  } catch (error) {
    updateStatus({ auth: 'checking', lastMessage: `Waiting for Chrome CDP: ${error.message}` });
    return false;
  }
}

async function launchChromeAndGateEdge() {
  const launched = await launchChrome(app);
  if (!launched.ok) {
    updateStatus({ auth: 'chrome missing', edge: 'stopped', lastMessage: launched.error });
    // 红线：Chrome 缺失诚实暴露，不静默装作在跑。
    surfaceFailure('AIDCP Edge 无法启动', launched.error || '未找到 Google Chrome，请安装后重启。');
    return;
  }
  updateStatus({ auth: 'checking', lastMessage: `Chrome launched with profile: ${launched.profilePath}` });
  const loggedIn = await checkLoginAndStart();
  if (!loggedIn && !loginPoller) {
    loginPoller = setInterval(checkLoginAndStart, 5000);
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
  updateStatus({ session: 'paused', lastMessage: 'Pause requested. Background edge process will stop at a safe point.' });
  if (edgeProcess) {
    edgeProcess.kill('SIGTERM');
  }
}

function resumeEdge() {
  updateStatus({ session: 'running', lastMessage: 'Resume requested. Restarting background edge process.' });
  checkLoginAndStart();
}

function relogin() {
  pauseEdge();
  stopLoginPoller();
  launchChromeAndGateEdge();
  return status;
}

function quitApp() {
  isQuitting = true;
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
    createWindow();
    createTray();
    launchChromeAndGateEdge();
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