const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aidcpEdge', {
  // 控制 IPC 全部带可选 envId 路由键（edge-multi-environment-fleet）：缺省作用于当前选中环境（兼容旧调用）。
  getStatus: (envId) => ipcRenderer.invoke('status:get', envId),
  pause: (envId) => ipcRenderer.invoke('edge:pause', envId),
  resume: (envId) => ipcRenderer.invoke('edge:resume', envId),
  close: (envId) => ipcRenderer.invoke('edge:close', envId),
  start: (envId) => ipcRenderer.invoke('edge:start', envId),
  restart: (envId) => ipcRenderer.invoke('edge:restart', envId),
  relogin: (envId) => ipcRenderer.invoke('auth:relogin', envId),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  openAdsDownload: () => ipcRenderer.invoke('browser:openAdsDownload'),
  showDrivenBrowser: (envId) => ipcRenderer.invoke('browser:showDriven', envId),
  resetBrowserParking: (envId) => ipcRenderer.invoke('browser:resetParking', envId),
  // 多环境 fleet 控制面：花名册快照 / 选中环境 / 全部启动（内存预检，force 放行）/ 全部停止 / 环境栏收展持久化。
  fleetGet: () => ipcRenderer.invoke('fleet:get'),
  fleetSelect: (envId) => ipcRenderer.invoke('fleet:select', envId),
  fleetStartAll: (opts) => ipcRenderer.invoke('fleet:startAll', opts),
  fleetStopAll: () => ipcRenderer.invoke('fleet:stopAll'),
  // 云端环境（change edge-cloud-env-selector）：切换云端后「全部重启并连接新云端」。
  cloudRestartAll: () => ipcRenderer.invoke('cloud:restartAll'),
  fleetSetRailCollapsed: (collapsed) => ipcRenderer.invoke('fleet:setRailCollapsed', collapsed),
  onFleetUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('fleet:update', listener);
    return () => ipcRenderer.removeListener('fleet:update', listener);
  },
  // AdsPower 只读探测 / 拉取 / 打开新建入口。opts 可带当前表单 { apiKey, apiBase, groupId }（调用级、不持久化）。
  adsStatus: (opts) => ipcRenderer.invoke('ads:status', opts),
  adsListProfiles: (opts) => ipcRenderer.invoke('ads:listProfiles', opts),
  adsOpenCreate: () => ipcRenderer.invoke('ads:openCreate'),
  // 「创建环境」程序化建号：整机模板清单 + 建一个环境（可选 proxy 表单输入，缺省 no_proxy）。
  adsTemplates: () => ipcRenderer.invoke('ads:templates'),
  adsCreateEnv: (opts) => ipcRenderer.invoke('ads:createEnv', opts),
  // 删除环境（仅由界面逐个二次确认触发）：opts { userId, apiKey?, apiBase? }。
  adsDeleteEnv: (opts) => ipcRenderer.invoke('ads:deleteEnv', opts),
  // 改已有环境代理（仅改 user_proxy_config，受限 user/update）：opts { userId, proxy, apiKey?, apiBase? }。
  adsUpdateEnvProxy: (opts) => ipcRenderer.invoke('ads:updateEnvProxy', opts),
  // 建号自助人设（change edge-persona-keyword-generation）：选关键词 → 云端生成草稿 / 确认落库。
  // 带 envId 路由（多环境）：打到草稿所属环境的 core，绝不因中途切换把人设写进别的账号。
  personaGenerate: (envId, opts) => ipcRenderer.invoke('persona:generate', envId, opts),
  personaPersist: (envId, opts) => ipcRenderer.invoke('persona:persist', envId, opts),
  notify: (payload) => ipcRenderer.invoke('notify:show', payload),
  onStatusUpdate: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status:update', listener);
    return () => ipcRenderer.removeListener('status:update', listener);
  },
  // 活动流条目（一句人话 + 时间戳 + 类型 + envId 路由键），与 status 分道：无界流不塞进状态对象。
  onActivity: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('ui:activity', listener);
    return () => ipcRenderer.removeListener('ui:activity', listener);
  },
  // 「打开飞书 ↗」纯导航深链（不是审批操作）；拉不起返回 { ok:false }，渲染层降级纯文字。
  openFeishu: () => ipcRenderer.invoke('feishu:open'),
});
