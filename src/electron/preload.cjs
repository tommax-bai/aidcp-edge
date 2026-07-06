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
  showDrivenBrowser: () => ipcRenderer.invoke('browser:showDriven'),
  resetBrowserParking: () => ipcRenderer.invoke('browser:resetParking'),
  // AdsPower 只读探测 / 拉取 / 打开新建入口。opts 可带当前表单 { apiKey, apiBase, groupId }（调用级、不持久化）。
  adsStatus: (opts) => ipcRenderer.invoke('ads:status', opts),
  adsListProfiles: (opts) => ipcRenderer.invoke('ads:listProfiles', opts),
  adsOpenCreate: () => ipcRenderer.invoke('ads:openCreate'),
  // 「创建环境」程序化建号：整机模板清单 + 建一个环境（代理不碰，默认 no_proxy）。
  adsTemplates: () => ipcRenderer.invoke('ads:templates'),
  adsCreateEnv: (opts) => ipcRenderer.invoke('ads:createEnv', opts),
  // 删除环境（仅由界面逐个二次确认触发）：opts { userId, apiKey?, apiBase? }。
  adsDeleteEnv: (opts) => ipcRenderer.invoke('ads:deleteEnv', opts),
  onStatusUpdate: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status:update', listener);
    return () => ipcRenderer.removeListener('status:update', listener);
  },
  // 活动流条目（一句人话 + 时间戳 + 类型），与 status 分道：无界流不塞进状态对象。
  onActivity: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('ui:activity', listener);
    return () => ipcRenderer.removeListener('ui:activity', listener);
  },
  // 「打开飞书 ↗」纯导航深链（不是审批操作）；拉不起返回 { ok:false }，渲染层降级纯文字。
  openFeishu: () => ipcRenderer.invoke('feishu:open'),
});
