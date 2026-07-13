'use strict';

// OL 自动更新只在已打包的 macOS 分发包中启用。更新源由打包元数据固定，绝不从
// 运行时 cloud 设置推导；这样用户把业务连接切到 dev/custom 也不会改变二进制供应链。
const UPDATE_FIRST_CHECK_DELAY_MS = 15_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function normalizeOlUpdateConfig({ isPackaged, platform, channel, url } = {}) {
  if (!isPackaged || platform !== 'darwin' || String(channel || '').trim() !== 'ol') {
    return { enabled: false, reason: 'not_ol_packaged_macos' };
  }

  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      return { enabled: false, reason: 'invalid_update_url' };
    }
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
    return { enabled: true, channel: 'ol', url: parsed.toString() };
  } catch {
    return { enabled: false, reason: 'invalid_update_url' };
  }
}

function withUnref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * 将 electron-updater 包装为无 UI、副作用可注入的状态机。主进程负责展示中文提示并决定
 * 何时安装；此处只保证不自动下载、不自动重启、检查不重入及所有错误如实上报。
 */
function createAutoUpdateService({
  autoUpdater,
  config,
  timers = global,
  onAvailable = () => {},
  onProgress = () => {},
  onDownloaded = () => {},
  onError = () => {},
  onNotAvailable = () => {},
  initialDelayMs = UPDATE_FIRST_CHECK_DELAY_MS,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
} = {}) {
  const normalized = config && typeof config.enabled === 'boolean'
    ? config
    : normalizeOlUpdateConfig(config);
  const disabled = {
    enabled: false,
    config: normalized,
    start: () => false,
    stop: () => {},
    checkForUpdates: async () => null,
    downloadUpdate: async () => null,
    quitAndInstall: () => false,
  };
  if (!normalized.enabled || !autoUpdater) return disabled;

  let checking = false;
  let downloading = false;
  let started = false;
  let firstCheckTimer = null;
  let intervalTimer = null;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: normalized.url });

  function reportError(phase, error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error || 'unknown update error'));
    onError({ phase, error: normalizedError });
  }

  autoUpdater.on('update-available', (info) => onAvailable(info));
  autoUpdater.on('update-not-available', (info) => onNotAvailable(info));
  autoUpdater.on('download-progress', (progress) => onProgress(progress));
  autoUpdater.on('update-downloaded', (info) => onDownloaded(info));
  autoUpdater.on('error', (error) => reportError('updater', error));

  async function checkForUpdates() {
    if (checking || downloading) return null;
    checking = true;
    try {
      return await autoUpdater.checkForUpdates();
    } catch (error) {
      reportError('check', error);
      return null;
    } finally {
      checking = false;
    }
  }

  async function downloadUpdate() {
    if (downloading) return null;
    downloading = true;
    try {
      return await autoUpdater.downloadUpdate();
    } catch (error) {
      reportError('download', error);
      return null;
    } finally {
      downloading = false;
    }
  }

  function start() {
    if (started) return false;
    started = true;
    firstCheckTimer = withUnref(timers.setTimeout(() => { void checkForUpdates(); }, initialDelayMs));
    intervalTimer = withUnref(timers.setInterval(() => { void checkForUpdates(); }, intervalMs));
    return true;
  }

  function stop() {
    if (firstCheckTimer) timers.clearTimeout(firstCheckTimer);
    if (intervalTimer) timers.clearInterval(intervalTimer);
    firstCheckTimer = null;
    intervalTimer = null;
    started = false;
  }

  return {
    enabled: true,
    config: normalized,
    start,
    stop,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall: () => {
      autoUpdater.quitAndInstall();
      return true;
    },
  };
}

module.exports = {
  UPDATE_FIRST_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  normalizeOlUpdateConfig,
  createAutoUpdateService,
};
