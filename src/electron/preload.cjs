const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aidcpEdge', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  pause: () => ipcRenderer.invoke('edge:pause'),
  resume: () => ipcRenderer.invoke('edge:resume'),
  start: () => ipcRenderer.invoke('edge:start'),
  restart: () => ipcRenderer.invoke('edge:restart'),
  relogin: () => ipcRenderer.invoke('auth:relogin'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  openAdsDownload: () => ipcRenderer.invoke('browser:openAdsDownload'),
  // AdsPower 只读探测 / 拉取 / 打开新建入口。opts 可带当前表单 { apiKey, apiBase, groupId }（调用级、不持久化）。
  adsStatus: (opts) => ipcRenderer.invoke('ads:status', opts),
  adsListProfiles: (opts) => ipcRenderer.invoke('ads:listProfiles', opts),
  adsOpenCreate: () => ipcRenderer.invoke('ads:openCreate'),
  onStatusUpdate: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status:update', listener);
    return () => ipcRenderer.removeListener('status:update', listener);
  },
});