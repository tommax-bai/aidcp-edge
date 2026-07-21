const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aidcpEdge', {
  // 控制 IPC 全部带可选 envId 路由键（edge-multi-environment-fleet）：缺省作用于当前选中环境（兼容旧调用）。
  getStatus: (envId) => ipcRenderer.invoke('status:get', envId),
  pause: (envId) => ipcRenderer.invoke('edge:pause', envId),
  resume: (envId) => ipcRenderer.invoke('edge:resume', envId),
  close: (envId) => ipcRenderer.invoke('edge:close', envId),
  browserOpen: (envId) => ipcRenderer.invoke('browser:open', envId),
  browserClose: (envId) => ipcRenderer.invoke('browser:close', envId),
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
  saveEnvironmentNickname: (args) => ipcRenderer.invoke('fleet:setManualNickname', args),
  fleetStartAll: (opts) => ipcRenderer.invoke('fleet:startAll', opts),
  fleetStopAll: () => ipcRenderer.invoke('fleet:stopAll'),
  fleetCloseAll: (opts) => ipcRenderer.invoke('fleet:closeAll', opts),
  // Facebook 批量人设：主进程本地构建模板；确认后 Cloud 只筛目标并原样补齐。
  facebookPersonaTemplatePreview: (selection) => ipcRenderer.invoke('persona:preview-facebook-template', selection),
  facebookPersonaFillSelected: (soulYaml) => ipcRenderer.invoke('persona:fill-facebook-selected', soulYaml),
  // 云端环境：兼容旧方法名，主进程执行的是 core transport rebind，不重启 core/浏览器。
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
  // 「创建环境」程序化建号：OS family 清单 + 建一个环境（可选 proxy 表单输入，缺省 no_proxy）。
  adsTemplates: () => ipcRenderer.invoke('ads:templates'),
  adsCreateEnv: (opts) => ipcRenderer.invoke('ads:createEnv', opts),
  // 删除环境（仅由界面逐个二次确认触发）：opts { userId, apiKey?, apiBase? }。
  adsDeleteEnv: (opts) => ipcRenderer.invoke('ads:deleteEnv', opts),
  // 精确读取一个可见环境的完整代理配置；主进程按客户环境范围校验，不暴露任意本地 API。
  adsGetEnvProxy: (opts) => ipcRenderer.invoke('ads:getEnvProxy', opts),
  // 改已有环境代理（仅改 user_proxy_config，受限 user/update）：opts { userId, proxy, apiKey?, apiBase? }。
  adsUpdateEnvProxy: (opts) => ipcRenderer.invoke('ads:updateEnvProxy', opts),
  // 账号人设（change offline-account-persona-management）：只交本地 envId，main 权威换成 envKey 后直连
  // customer-auth。读取 / 生成 / 保存均不依赖该环境的 core 或浏览器是否运行。
  personaGet: (envId) => ipcRenderer.invoke('persona:get', envId),
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
  // 稿件预览内的发布/取消审批动作（Electron main 经 customer-auth HTTP 发起；不依赖自动化引擎/浏览器）。
  publishApproval: (envId, payload) => ipcRenderer.invoke('publish:approval', envId, payload),
  // 待审批稿列表/详情：main 固定客户接口路径并注入当前环境，renderer 不能提交 URL/token/accountId。
  publishDraftList: (envId, options) => ipcRenderer.invoke('publish-draft:list', envId, options),
  publishDraftGet: (envId, id) => ipcRenderer.invoke('publish-draft:get', envId, id),
  publishScheduleOccupiedHours: (envId) => ipcRenderer.invoke('publish-schedule:occupied-hours', envId),
  // 今日进展与最近发布：始终由 main 通过 customer-auth HTTP 拉取，不依赖自动化引擎或浏览器。
  getEnvironmentOverview: (envId) => ipcRenderer.invoke('environment-overview:get', envId),
  // 稿件预览内删除某张配图（同一条链路；云端持权限 / 版本 / 只删不注入 / 最后一张不可删的权威）。
  publishImageRemove: (envId, payload) => ipcRenderer.invoke('publish:image-remove', envId, payload),
  // 用户委托任务：主进程把 envId 收口成该环境的 profileId；渲染层拿不到客户令牌、也不能改 accountId。
  delegatedTaskList: (envId) => ipcRenderer.invoke('delegated-task:list', envId),
  delegatedTaskDraft: (envId, payload) => ipcRenderer.invoke('delegated-task:draft', envId, payload),
  delegatedTaskAction: (envId, taskId, action, version) =>
    ipcRenderer.invoke('delegated-task:action', envId, taskId, action, version),
  // 当前账号灵感库：主进程固定 customer-auth 路径并注入所选环境；renderer 不能传 URL/token/accountId。
  curatedSummary: (envId) => ipcRenderer.invoke('curated:summary', envId),
  curatedList: (envId, options) => ipcRenderer.invoke('curated:list', envId, options),
  curatedGet: (envId, id) => ipcRenderer.invoke('curated:get', envId, id),
  curatedCreatePost: (envId, id, useReferenceImages) =>
    ipcRenderer.invoke('curated:create-post', envId, id, useReferenceImages),
  // 对外客户鉴权（change edge-client-customer-auth）：登录窗口用 clientLogin；主界面/托盘用 clientLogout。
  // 主进程做实际 HTTP，渲染层不直连网络（避免 CORS / 凭据落渲染层）。
  clientLogin: (creds) => ipcRenderer.invoke('client-auth:login', creds),
  clientLogout: () => ipcRenderer.invoke('client-auth:logout'),
  clientSession: () => ipcRenderer.invoke('client-auth:session'),
  clientLoginPrefill: () => ipcRenderer.invoke('client-auth:prefill'),
  clearClientLoginPrefill: () => ipcRenderer.invoke('client-auth:prefill:clear'),
  // 视频号互动工作区：逐端点具名 IPC。renderer 只能提交冻结 DTO，不能传 URL/method/header/token。
  interactionList: (args) => ipcRenderer.invoke('interaction:list', args),
  interactionDetail: (args) => ipcRenderer.invoke('interaction:detail', args),
  interactionUpdateDraft: (args) => ipcRenderer.invoke('interaction:draft:update', args),
  interactionApprove: (args) => ipcRenderer.invoke('interaction:approve', args),
  interactionSend: (args) => ipcRenderer.invoke('interaction:send', args),
  interactionRegenerate: (args) => ipcRenderer.invoke('interaction:regenerate', args),
  interactionIgnore: (args) => ipcRenderer.invoke('interaction:ignore', args),
  interactionEscalate: (args) => ipcRenderer.invoke('interaction:escalate', args),
  interactionSync: (args) => ipcRenderer.invoke('interaction:sync', args),
  interactionTestReset: (args) => ipcRenderer.invoke('interaction:test-reset', args),
  interactionReopenAuth: (args) => ipcRenderer.invoke('interaction:auth:reopen', args),
  interactionBrowserControl: (args) => ipcRenderer.invoke('interaction:browser:control', args),
  // 本机人工查看：只交 envKey；profile / URL / LocalAPI / 凭据全部由 main 权威派生。
  interactionOpenLocalBrowser: (args) => ipcRenderer.invoke('interaction:browser:open-local', args),
  interactionUpdateReadControls: (args) => ipcRenderer.invoke('interaction:read-controls:update', args),
  interactionNotify: (args) => ipcRenderer.invoke('interaction:notify', args),
  interactionCancelReads: (envKey) => ipcRenderer.invoke('interaction:reads:cancel', { envKey }),
  // 环境级慢启动：只传 envKey + enabled，客户端永不提交 accountId。
  setSlowStart: (args) => ipcRenderer.invoke('slow-start:set', args),
  // 不依赖边缘的慢启动读（change slow-start-offline-toggle）：没有活快照时用它把这一行渲染出来。
  getSlowStart: (args) => ipcRenderer.invoke('slow-start:get', args),
  getEnvironmentRisk: (args) => ipcRenderer.invoke('environment-risk:get', args),
  recoverEnvironmentRisk: (args) => ipcRenderer.invoke('environment-risk:recover', args),
});
