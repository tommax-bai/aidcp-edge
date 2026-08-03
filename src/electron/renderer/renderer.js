// 陪伴式主界面渲染层（edge-companion-ui）。
// 纯视图逻辑（健康合成 / 在场感动效门 / 发布卡状态机）在 ui-logic.js（window.uiLogic，可单测）；
// 本文件只做 DOM 粘合。设置表单 / 悬浮三态 FAB 的既有逻辑原样保留（仅 DOM 迁入设置抽屉）。
const uiLogic = window.uiLogic;
const publishReviewLogic = window.publishReviewLogic;

const fields = {
  dailySummary: document.querySelector('#daily-summary'),
  slowStartRow: document.querySelector('#slow-start-row'),
  slowStartToggleWrap: document.querySelector('#slow-start-toggle-wrap'),
  slowStartToggle: document.querySelector('#slow-start-toggle'),
  slowStartBadge: document.querySelector('#slow-start-badge'),
  slowStartReason: document.querySelector('#slow-start-reason'),
  facebookPersonaModeRow: document.querySelector('#facebook-persona-mode-row'),
  facebookPersonaModeToggleWrap: document.querySelector('#facebook-persona-mode-toggle-wrap'),
  facebookPersonaModeToggle: document.querySelector('#facebook-persona-mode-toggle'),
  facebookPersonaModeBadge: document.querySelector('#facebook-persona-mode-badge'),
  facebookPersonaModeReason: document.querySelector('#facebook-persona-mode-reason'),
  facebookRuleModeRow: document.querySelector('#facebook-rule-mode-row'),
  facebookRuleModeToggleWrap: document.querySelector('#facebook-rule-mode-toggle-wrap'),
  facebookRuleModeToggle: document.querySelector('#facebook-rule-mode-toggle'),
  facebookRuleModeBadge: document.querySelector('#facebook-rule-mode-badge'),
  facebookRuleModeReason: document.querySelector('#facebook-rule-mode-reason'),
  facebookConsumptionModeRow: document.querySelector('#facebook-consumption-mode-row'),
  facebookConsumptionModeToggleWrap: document.querySelector('#facebook-consumption-mode-toggle-wrap'),
  facebookConsumptionModeToggle: document.querySelector('#facebook-consumption-mode-toggle'),
  facebookConsumptionModeBadge: document.querySelector('#facebook-consumption-mode-badge'),
  facebookConsumptionModeReason: document.querySelector('#facebook-consumption-mode-reason'),
  facebookOperationPolicyRow: document.querySelector('#facebook-operation-policy-row'),
  facebookOperationModeSelect: document.querySelector('#facebook-operation-mode-select'),
  facebookPrimarySurfaceSelect: document.querySelector('#facebook-primary-surface-select'),
  facebookOperationPolicyStatus: document.querySelector('#facebook-operation-policy-status'),
  riskRecoveryRow: document.querySelector('#risk-recovery-row'),
  riskRecoveryButton: document.querySelector('#risk-recovery-button'),
  riskRecoveryFeedback: document.querySelector('#risk-recovery-feedback'),
  riskRecoveryConfirm: document.querySelector('#risk-recovery-confirm'),
  riskRecoveryConfirmClose: document.querySelector('#risk-recovery-confirm-close'),
  riskRecoveryConfirmEnv: document.querySelector('#risk-recovery-confirm-env'),
  riskRecoveryConfirmCancel: document.querySelector('#risk-recovery-confirm-cancel'),
  riskRecoveryConfirmSubmit: document.querySelector('#risk-recovery-confirm-submit'),
  auth: document.querySelector('#auth-status'),
  cloud: document.querySelector('#cloud-status'),
  engineLinkDiagnostic: document.querySelector('#engine-link-diagnostic'),
  session: document.querySelector('#session-state'),
  browser: document.querySelector('#browser-state'),
  risk: document.querySelector('#risk-status'),
  edge: document.querySelector('#edge-state'),
  views: document.querySelector('#views'),
  searches: document.querySelector('#searches'),
  likes: document.querySelector('#likes'),
  collects: document.querySelector('#collects'),
  comments: document.querySelector('#comments'),
  follows: document.querySelector('#follows'),
  publishes: document.querySelector('#publishes'),
  joins: document.querySelector('#joins'),
  usageSource: document.querySelector('#usage-source'),
  usageLimit: document.querySelector('#usage-limit'),
  quotaToggle: document.querySelector('#quota-toggle'),
  quotaToggleLabel: document.querySelector('#quota-toggle-label'),
  quotaWindows: document.querySelector('#quota-windows'),
  updatedAt: document.querySelector('#updated-at'),
  usageCaps: {
    view: document.querySelector('#views-cap'),
    search: document.querySelector('#searches-cap'),
    like: document.querySelector('#likes-cap'),
    collect: document.querySelector('#collects-cap'),
    comment: document.querySelector('#comments-cap'),
    follow: document.querySelector('#follows-cap'),
    publish: document.querySelector('#publishes-cap'),
    join_group: document.querySelector('#joins-cap'),
  },
  usageBars: {
    view: document.querySelector('#views-bar'),
    search: document.querySelector('#searches-bar'),
    like: document.querySelector('#likes-bar'),
    collect: document.querySelector('#collects-bar'),
    comment: document.querySelector('#comments-bar'),
    follow: document.querySelector('#follows-bar'),
    publish: document.querySelector('#publishes-bar'),
    join_group: document.querySelector('#joins-bar'),
  },
  lastMessage: document.querySelector('#last-message'),
  commandDiagnosticList: document.querySelector('#command-diagnostic-list'),
  commandDiagnosticEmpty: document.querySelector('#command-diagnostic-empty'),
  sessionFab: document.querySelector('#session-fab'),
  firstEnvironmentStartGuide: document.querySelector('#first-environment-start-guide'),
  firstEnvironmentStartGuideClose: document.querySelector('#first-environment-start-guide-close'),
  contentRuntimeToggle: document.querySelector('#content-runtime-toggle'),
  sessionClose: document.querySelector('#session-close'),
  clientSessionFoot: document.querySelector('#client-session-foot'),
  clientSessionName: document.querySelector('#client-session-name'),
  clientLogout: document.querySelector('#client-logout'),
  loginGuide: document.querySelector('#login-guide'),
  noticeTitle: document.querySelector('#notice-title'),
  noticeBody: document.querySelector('#notice-body'),
  noticeAction: document.querySelector('#notice-action'),
  edgeFailure: document.querySelector('#edge-failure'),
  edgeFailureText: document.querySelector('#edge-failure-text'),
  subtitle: document.querySelector('#subtitle'),
  // 陪伴式新增
  titlebar: document.querySelector('#titlebar'),
  firstUseBrandTitle: document.querySelector('#first-use-brand-title'),
  firstUseBrandSubtitle: document.querySelector('#first-use-brand-subtitle'),
  environmentRosterLoading: document.querySelector('#environment-roster-loading'),
  environmentRosterLoadingTitle: document.querySelector('#environment-roster-loading-title'),
  environmentRosterLoadingCopy: document.querySelector('#environment-roster-loading-copy'),
  environmentRosterRetry: document.querySelector('#environment-roster-retry'),
  environmentOnboarding: document.querySelector('#environment-onboarding'),
  environmentOnboardingCreate: document.querySelector('#environment-onboarding-create'),
  environmentWorkspaces: Array.from(document.querySelectorAll(
    '#legacy-workspace, #interaction-workspace, #content-workspace, #environment-schedule-workspace',
  )),
  acctAva: document.querySelector('#acct-ava'),
  acctName: document.querySelector('#acct-name'),
  acctPlat: document.querySelector('#acct-plat'),
  proxyRuntimeChip: document.querySelector('#proxy-runtime-chip'),
  proxyRuntimeLabel: document.querySelector('#proxy-runtime-label'),
  proxyRuntimePop: document.querySelector('#proxy-runtime-pop'),
  proxyRuntimeState: document.querySelector('#proxy-runtime-state'),
  proxyRuntimeConfig: document.querySelector('#proxy-runtime-config'),
  proxyRuntimeCheckedAt: document.querySelector('#proxy-runtime-checked-at'),
  proxyRuntimeBytes: document.querySelector('#proxy-runtime-bytes'),
  authLabel: document.querySelector('#auth-label'),
  healthPill: document.querySelector('#health-pill'),
  healthLabel: document.querySelector('#health-label'),
  healthPop: document.querySelector('#health-pop'),
  healthDetail: document.querySelector('#health-detail'),
  gear: document.querySelector('#gear'),
  // 标题带常驻「当前云端」chip（change edge-cloud-env-selector）
  cloudEnvChip: document.querySelector('#cloud-env-chip'),
  cloudEnvChipLabel: document.querySelector('#cloud-env-chip-label'),
  presence: document.querySelector('.presence'),
  presenceText: document.querySelector('#presence-text'),
  presenceFresh: document.querySelector('#presence-fresh'),
  presenceCore: document.querySelector('#presence-core'),
  runtimeGuidance: document.querySelector('#runtime-guidance'),
  runtimeGuidanceKicker: document.querySelector('#runtime-guidance-kicker'),
  runtimeGuidanceTitle: document.querySelector('#runtime-guidance-title'),
  runtimeGuidanceValue: document.querySelector('#runtime-guidance-value'),
  runtimeGuidanceValueText: document.querySelector('#runtime-guidance-value-text'),
  runtimeGuidanceDetail: document.querySelector('#runtime-guidance-detail'),
  runtimeGuidanceMascot: document.querySelector('#runtime-guidance-mascot'),
  runtimeGuidanceFlow: document.querySelector('#runtime-guidance-flow'),
  runtimeGuidanceProgress: document.querySelector('#runtime-guidance-progress'),
  runtimeGuidanceHarvest: document.querySelector('#runtime-guidance-harvest'),
  runtimeGuidanceResume: document.querySelector('#runtime-guidance-resume'),
  runtimeGuidanceNote: document.querySelector('#runtime-guidance-note'),
  kernelPrep: document.querySelector('#kernel-prep'),
  kernelPrepLabel: document.querySelector('#kernel-prep-label'),
  kernelPrepPct: document.querySelector('#kernel-prep-pct'),
  kernelPrepBar: document.querySelector('#kernel-prep-bar'),
  stream: document.querySelector('#activity-stream'),
  streamEmpty: document.querySelector('#stream-empty'),
  pubCard: document.querySelector('#pub-card'),
  pubHeadRow: document.querySelector('#pub-head-row'),
  pubKicker: document.querySelector('#pub-kicker'),
  pubHead: document.querySelector('#pub-head'),
  pubCount: document.querySelector('#pub-count'),
  pubCorner: document.querySelector('#pub-corner'),
  pubTitle: document.querySelector('#pub-title'),
  pubThumb: document.querySelector('#pub-thumb'),
  pubMeta: document.querySelector('#pub-meta'),
  pubSteps: document.querySelector('#pub-steps'),
  pubFoot: document.querySelector('#pub-foot'),
  pubMain: document.querySelector('#pub-main'),
  pubBar: document.querySelector('#pub-bar'),
  pubBarLabel: document.querySelector('#pub-bar-label'),
  pubBarSum: document.querySelector('#pub-bar-sum'),
  pubCarouselPrev: document.querySelector('#pub-carousel-prev'),
  pubCarouselNext: document.querySelector('#pub-carousel-next'),
  pubQueueLink: document.querySelector('#pub-queue-link'),
  pubPreviewLink: document.querySelector('#pub-preview-link'),
  publishPreviewPanel: document.querySelector('#publish-preview-panel'),
  publishPreviewKind: document.querySelector('#publish-preview-kind'),
  publishPreviewTitle: null,
  publishPreviewContent: document.querySelector('#publish-preview-content'),
  publishPreviewActions: document.querySelector('#publish-preview-actions'),
  publishPreviewActionHint: document.querySelector('#publish-preview-action-hint'),
  publishPreviewApprove: document.querySelector('#publish-preview-approve'),
  publishPreviewCancel: document.querySelector('#publish-preview-cancel'),
  publishPreviewImageLightbox: document.querySelector('#publish-preview-image-lightbox'),
  publishPreviewImageLightboxImage: document.querySelector('#publish-preview-image-lightbox-image'),
  publishPreviewImageLightboxCaption: document.querySelector('#publish-preview-image-lightbox-caption'),
  publishPreviewImageLightboxClose: document.querySelector('#publish-preview-image-lightbox-close'),
  delegatedTrigger: document.querySelector('#delegated-trigger'),
  delegatedIndicator: document.querySelector('#delegated-indicator'),
  delegatedCard: document.querySelector('#delegated-card'),
  delegatedClose: document.querySelector('#delegated-close'),
  delegatedCount: document.querySelector('#delegated-count'),
  delegatedSchedule: document.querySelector('#delegated-schedule'),
  delegatedPriority: document.querySelector('#delegated-priority'),
  delegatedRefresh: document.querySelector('#delegated-refresh'),
  delegatedMessage: document.querySelector('#delegated-message'),
  delegatedList: document.querySelector('#delegated-list'),
  delegatedActionButtons: Array.from(document.querySelectorAll('[data-delegated-action]')),
  delegatedConfirm: document.querySelector('#delegated-confirm'),
  delegatedConfirmTitle: document.querySelector('#delegated-confirm-title'),
  delegatedConfirmFacts: document.querySelector('#delegated-confirm-facts'),
  delegatedConfirmBoundary: document.querySelector('#delegated-confirm-boundary'),
  delegatedConfirmSubmit: document.querySelector('#delegated-confirm-submit'),
  drawer: document.querySelector('#drawer'),
  drawerMask: document.querySelector('#drawer-mask'),
  drawerClose: document.querySelector('#drawer-close'),
  lightsPad: document.querySelector('.tb-lights-pad'),
  winctlPad: document.querySelector('.tb-winctl-pad'),
  // 多环境 fleet（edge-multi-environment-fleet / edge-fleet-rail-env-management）
  fleetRow: document.querySelector('#fleet-row'),
  envRail: document.querySelector('#env-rail'),
  railToggle: document.querySelector('#rail-toggle'),
  railBadge: document.querySelector('#rail-badge'),
  railList: document.querySelector('#rail-list'),
  railCount: document.querySelector('#rail-count'),
  railPlatformFilters: Array.from(document.querySelectorAll('[data-rail-platform]')),
  railFacebookPersonaFill: document.querySelector('#rail-facebook-persona-fill'),
  railFacebookPersonaSubmit: document.querySelector('#rail-facebook-persona-submit'),
  railFacebookPersonaStatus: document.querySelector('#rail-facebook-persona-status'),
  railAdd: document.querySelector('#rail-add'),
  railFootAdd: document.querySelector('#rail-foot-add'),
  railSum: document.querySelector('#rail-sum'),
  railSumRun: document.querySelector('#rail-sum-run'),
  railSumAttn: document.querySelector('#rail-sum-attn'),
  railSumIdle: document.querySelector('#rail-sum-idle'),
  railCapacity: document.querySelector('#rail-capacity'),
  railGuide: document.querySelector('#rail-guide'),
  railStartAll: document.querySelector('#rail-start-all'),
  railCloseAll: document.querySelector('#rail-close-all'),
  railMsg: document.querySelector('#rail-msg'),
  guidePanel: document.querySelector('#guide-panel'),
  guideTitle: document.querySelector('#guide-title'),
  guideBody: document.querySelector('#guide-body'),
  guideOpen: document.querySelector('#guide-open'),
  guideDone: document.querySelector('#guide-done'),
  guideSkip: document.querySelector('#guide-skip'),
  guideExit: document.querySelector('#guide-exit'),
  guideHint: document.querySelector('#guide-hint'),
  sameAccountWarn: document.querySelector('#same-account-warn'),
  sameAccountText: document.querySelector('#same-account-text'),
  // 添加/创建环境面板（edge-fleet-rail-env-management）
  envAddPanel: document.querySelector('#env-add-panel'),
  envAddMask: document.querySelector('#env-add-mask'),
  envAddClose: document.querySelector('#env-add-close'),
  envTabJoin: document.querySelector('#env-tab-join'),
  envTabCreate: document.querySelector('#env-tab-create'),
  envTabJoinBody: document.querySelector('#env-tab-join-body'),
  envTabCreateBody: document.querySelector('#env-tab-create-body'),
  envCreateCancel: document.querySelector('#env-create-cancel'),
  adsBatchProxyToggle: document.querySelector('#ads-batch-proxy-toggle'),
  adsBatchProxyPanel: document.querySelector('#ads-batch-proxy-panel'),
  adsBatchProxyCount: document.querySelector('#ads-batch-proxy-count'),
  adsBatchProxyType: document.querySelector('#ads-batch-proxy-type'),
  adsBatchProxyText: document.querySelector('#ads-batch-proxy-text'),
  adsBatchProxyPreview: document.querySelector('#ads-batch-proxy-preview'),
  adsBatchProxyProgress: document.querySelector('#ads-batch-proxy-progress'),
  adsBatchProxyProgressLabel: document.querySelector('#ads-batch-proxy-progress-label'),
  adsBatchProxyProgressBar: document.querySelector('#ads-batch-proxy-progress-bar'),
  adsBatchProxyMsg: document.querySelector('#ads-batch-proxy-msg'),
  adsBatchProxyCancel: document.querySelector('#ads-batch-proxy-cancel'),
  adsBatchProxySave: document.querySelector('#ads-batch-proxy-save'),
  adsManualAdd: document.querySelector('#ads-manual-add'),
  // 账号人设浮层（edge-fleet-rail-env-management；重设计于 edge-client-proxy-platform-persona-ux）
  personaPop: document.querySelector('#persona-pop'),
  personaMask: document.querySelector('#persona-mask'),
  personaClose: document.querySelector('#persona-close'),
  personaHeadTitle: document.querySelector('#persona-head-title'),
  personaPopEnv: document.querySelector('#persona-pop-env'),
  personaAva: document.querySelector('#persona-ava'),
  personaPlat: document.querySelector('#persona-plat'),
  // 环境代理编辑浮层（edge-client-proxy-platform-persona-ux）
  proxyPop: document.querySelector('#proxy-pop'),
  proxyMask: document.querySelector('#proxy-mask'),
  proxyClose: document.querySelector('#proxy-close'),
  proxyPopEnv: document.querySelector('#proxy-pop-env'),
  proxyPopCurrent: document.querySelector('#proxy-pop-current'),
  proxyPopType: document.querySelector('#proxy-pop-type'),
  proxyPopDetail: document.querySelector('#proxy-pop-detail'),
  proxyPopHost: document.querySelector('#proxy-pop-host'),
  proxyPopPort: document.querySelector('#proxy-pop-port'),
  proxyPopUser: document.querySelector('#proxy-pop-user'),
  proxyPopPass: document.querySelector('#proxy-pop-pass'),
  proxyPopQuick: document.querySelector('#proxy-pop-quick'),
  proxyPopMsg: document.querySelector('#proxy-pop-msg'),
  proxySave: document.querySelector('#proxy-save'),
};

// 视频号互动工作区使用独立 renderer 模块；旧测试桩/旧包未加载该模块时安全降级为原工作区。
const interactionWorkspace = window.InteractionWorkspace?.create({
  root: document.querySelector('#interaction-workspace'),
  legacyRoot: document.querySelector('#legacy-workspace'),
  shell: document.querySelector('.shell'),
  api: window.aidcpEdge,
  testResetRoot: document.querySelector('#interaction-test-reset'),
  onLifecycleAction: runSessionLifecycle,
  onLifecycleStatus: routeStatus,
}) || null;

// 灵感库与稿件审核共用同一主窗口内容页栈；全局标题栏、环境栏和健康状态仍由现有应用壳持有。
const contentWorkspace = window.ContentWorkspace?.create({
  root: document.querySelector('#content-workspace'),
  legacyRoot: document.querySelector('#legacy-workspace'),
  dashboardRoot: document.querySelector('#xhs-environment-dashboard'),
  legacyRuntimeRoot: document.querySelector('#legacy-runtime-body'),
  interactionRoot: document.querySelector('#interaction-workspace'),
  shell: document.querySelector('.shell'),
  api: window.aidcpEdge,
}) || null;
const contentWorkspaceRoot = document.querySelector('#content-workspace');

async function handleWorkspaceRuntimeAction(action) {
  if (action === 'start') {
    // 复用真实启动按钮：保存、首次引导清理、平台闸与在途锁均保持单一实现。
    fields.sessionFab?.click();
    return;
  }
  if (action === 'close') {
    if (fields.sessionClose?.dataset.lifecycleAction === 'close') fields.sessionClose.click();
    else {
      const next = await runSessionLifecycle('close', currentEnvId());
      if (next) routeStatus(next);
    }
    return;
  }
  if (action !== 'browser-open' && action !== 'browser-close') return;
  const expected = action === 'browser-open' ? 'open' : 'close';
  if (fields.sessionClose?.dataset.browserAction === expected) {
    fields.sessionClose.click();
    return;
  }
  const next = action === 'browser-open'
    ? await window.aidcpEdge.browserOpen?.(currentEnvId())
    : await window.aidcpEdge.browserClose?.(currentEnvId());
  if (next) routeStatus(next);
}

// 排期属于当前小红书环境首页：入口与详情都不挂到内容首页，也不创建全局导航项。
const environmentSchedule = window.EnvironmentSchedule?.create({
  root: document.querySelector('#environment-schedule-workspace'),
  entry: document.querySelector('#environment-schedule-entry'),
  legacyRoot: document.querySelector('#legacy-workspace'),
  interactionRoot: document.querySelector('#interaction-workspace'),
  contentRoot: contentWorkspaceRoot,
  shell: document.querySelector('.shell'),
  api: window.aidcpEdge,
  onRuntimeAction: (action) => { void handleWorkspaceRuntimeAction(action); },
}) || null;

contentWorkspaceRoot?.addEventListener('publish-queue:update', () => {
  if (currentStatus) renderPublish(currentStatus, Date.now());
});
contentWorkspaceRoot?.addEventListener('publish-queue:review', () => {
  openPublishPreview(true);
});
contentWorkspaceRoot?.addEventListener('content-workspace:draft', (event) => {
  openPublishPreview(true);
  const recordId = Number(event.detail?.recordId);
  if (Number.isInteger(recordId) && recordId > 0) void selectPublishDraft(recordId);
});
contentWorkspaceRoot?.addEventListener('content-workspace:runtime-action', async (event) => {
  await handleWorkspaceRuntimeAction(event.detail?.action);
});
function syncInteractionWorkspace() {
  if (!interactionWorkspace) return;
  const selected = fleetView.envs.get(fleetView.selected);
  const display = resolveEnvironmentDisplayName(selected);
  interactionWorkspace.selectEnvironment(selected ? {
    envKey: selected.profileId || selected.envId,
    runtimeEnvId: selected.envId,
    platform: normPlatform(selected.platform),
    label: display.name,
    connectivity: selected.status && selected.status.cloud,
    edge: selected.status && selected.status.edge,
    session: selected.status && selected.status.session,
  } : null);
}

function syncContentWorkspace(status = currentStatus) {
  const selected = fleetView.envs.get(fleetView.selected);
  const envId = currentEnvId() || (status && status.envId);
  const display = resolveEnvironmentDisplayName(selected, status);
  const environment = envId ? {
    envId,
    label: display.name || '当前账号',
    platform: selectedEnvPlatform(),
  } : null;
  contentWorkspace?.setEnvironment(environment);
  // 环境首页模式已确定后再同步首启高亮，确保它落在 XHS 价值首页的可见代理按钮上。
  syncFirstEnvironmentStartGuide();
  contentWorkspace?.setRuntime?.({
    automationState: status?.automationState || status?.automation || 'stopped',
    browserState: status?.browserState || 'closed',
    dailyUsage: status?.dailyUsage || null,
    guideActive: Boolean(fields.firstEnvironmentStartGuide
      && !fields.firstEnvironmentStartGuide.classList.contains('hidden')),
  });
  environmentSchedule?.setEnvironment(environment);
  environmentSchedule?.setRuntime({
    automationState: status?.automationState || status?.automation || 'stopped',
    browserState: status?.browserState || 'closed',
    dailyUsage: status?.dailyUsage || null,
  });
}

const settingsUi = {
  useChrome: document.querySelector('#use-chrome'),
  adsConfig: document.querySelector('#ads-config'),
  adsProfile: document.querySelector('#ads-profile'),
  adsProfileDisplay: document.querySelector('#ads-profile-display'),
  adsManual: document.querySelector('#ads-manual'),
  adsApiKey: document.querySelector('#ads-apikey'),
  adsApiBase: document.querySelector('#ads-apibase'),
  systemProxyUpstream: document.querySelector('#system-proxy-upstream'),
  systemProxyUpstreamHint: document.querySelector('#system-proxy-upstream-hint'),
  adsAdvancedToggle: document.querySelector('#ads-advanced-toggle'),
  adsAdvanced: document.querySelector('#ads-advanced'),
  // 设置抽屉里的「指纹浏览器高级设置」折叠（API 地址/Key）——与上面 join 面板的手动分身 ID 折叠是两处。
  adsAdvanced2Toggle: document.querySelector('#ads-advanced2-toggle'),
  adsAdvanced2: document.querySelector('#ads-advanced2'),
  adsEnvList: document.querySelector('#ads-env-list'),
  adsManualAdd: document.querySelector('#ads-manual-add'),
  adsRefresh: document.querySelector('#ads-refresh'),
  adsEnvMsg: document.querySelector('#ads-env-msg'),
  adsCreate: document.querySelector('#ads-create'),
  adsTemplate: document.querySelector('#ads-template'),
  adsTemplateField: document.querySelector('#ads-template-field'),
  adsPlatform: document.querySelector('#ads-platform'),
  adsPlatformButtons: Array.from(document.querySelectorAll('[data-create-platform]')),
  adsFbCreateMode: document.querySelector('#ads-fb-create-mode'),
  adsFbCreateModeField: document.querySelector('#ads-fb-create-mode-field'),
  // 运行方式四选一 + 全局免审：仅 Facebook 展示。
  adsFbRunMode: document.querySelector('#ads-fb-run-mode'),
  adsFbRunModeField: document.querySelector('#ads-fb-run-mode-field'),
  adsFbRunModeWrap: document.querySelector('#ads-fb-run-mode-wrap'),
  adsFbPrimarySurface: document.querySelector('#ads-fb-primary-surface'),
  adsFbPrimarySurfaceField: document.querySelector('#ads-fb-primary-surface-field'),
  adsFbApproval: document.querySelector('#ads-fb-approval'),
  adsFbImportWrap: document.querySelector('#ads-fb-import-wrap'),
  adsFbImport: document.querySelector('#ads-fb-import'),
  adsFbImportRequirement: document.querySelector('#ads-fb-import-requirement'),
  adsFbBatchAccountHelp: document.querySelector('#ads-fb-batch-account-help'),
  adsCreateMsg: document.querySelector('#ads-create-msg'),
  // 新建环境的可选代理区块（edge-client-proxy-platform-persona-ux）
  adsProxyType: document.querySelector('#ads-proxy-type'),
  adsProxyToggle: document.querySelector('#ads-proxy-toggle'),
  adsProxyConfig: document.querySelector('#ads-proxy-config'),
  adsProxySummary: document.querySelector('#ads-proxy-summary'),
  adsProxyDetail: document.querySelector('#ads-proxy-detail'),
  adsProxyHost: document.querySelector('#ads-proxy-host'),
  adsProxyPort: document.querySelector('#ads-proxy-port'),
  adsProxyUser: document.querySelector('#ads-proxy-user'),
  adsProxyPass: document.querySelector('#ads-proxy-pass'),
  adsProxyBatchWrap: document.querySelector('#ads-proxy-batch-wrap'),
  adsProxyBatch: document.querySelector('#ads-proxy-batch'),
  adsSingleProxyHelp: document.querySelector('#ads-single-proxy-help'),
  adsBatchProxyHelp: document.querySelector('#ads-batch-proxy-help'),
  parkingButtons: Array.from(document.querySelectorAll('.parking-btn')),
  browserShow: document.querySelector('#browser-show'),
  browserResetParking: document.querySelector('#browser-reset-parking'),
  browserColdStandby: document.querySelector('#browser-cold-standby'),
  // 浏览器并发卡（change browser-slot-scheduling）
  slotLimit: document.querySelector('#slot-limit'),
  maxQueuedStartLimit: document.querySelector('#max-queued-start-limit'),
  slotsHint: document.querySelector('#slots-hint'),
  slotsWarn: document.querySelector('#slots-warn'),
  applyRestart: document.querySelector('#apply-restart'),
  msg: document.querySelector('#settings-msg'),
  // 云端环境卡（change edge-cloud-env-selector）
  cloudEnvButtons: Array.from(document.querySelectorAll('.cloud-env-btn')),
  cloudEnvCustomField: document.querySelector('#cloud-env-custom-field'),
  cloudUrlCustom: document.querySelector('#cloud-url-custom'),
  clientAuthUrlCustom: document.querySelector('#client-auth-url-custom'),
  cloudEnvCurrent: document.querySelector('#cloud-env-current'),
  cloudEnvHint: document.querySelector('#cloud-env-hint'),
  cloudRestartAll: document.querySelector('#cloud-restart-all'),
};
// 云端环境展示名（一处；与主进程 CLOUD_ENV_LABELS 对齐）。
const CLOUD_ENV_LABELS = { dev: 'dev', ol: 'ol（线上）', custom: '自定义', '': '默认' };
const PARKING_MODES = new Set(['primary-screen', 'parking-display', 'edge-strip', 'offscreen']);

// 状态码保持英文（供 CSS 上色 + main 侧判断），展示文案在此本地化。className 仍用原始码不动色。
const STATUS_LABELS = {
  clientSession: { ready: '已登录', signed_out: '未登录', expired: '已过期' },
  auth: {
    checking: '检测中',
    'login required': '需登录',
    'logged in': '已登录',
    'chrome missing': '缺少 Chrome',
    'config required': '待配置',
  },
  cloud: { disconnected: '未连接', connected: '已连接' },
  session: { idle: '待命', running: '进行中', resting: '等待下一轮', paused: '已暂停', closed: '已关闭' },
  risk: { normal: '正常', warned: '需放慢', restricted: '受限制', frozen: '已冻结' },
  edge: { stopped: '已停止', starting: '启动中', running: '运行中', warning: '异常' },
  core: { stopped: '未连接', starting: '启动中', online: '在线', restarting: '重启中', error: '异常' },
  engineLink: { disconnected: '未连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', error: '异常' },
  cloudAxis: { connecting: '连接中', connected: '已连接', reconnecting: '重连中', offline: '离线' },
  automation: { stopped: '未启动', starting: '启动中', ready: '待任务', running: '运行中', waiting_resource: '排队中', pausing: '暂停中', paused: '已暂停', stopping: '关闭中', error: '异常' },
  browser: { closed: '已关闭', queued: '排队中', starting: '启动中', ready: '已就绪', blocked: '需处理', closing: '关闭中', releasing: '关闭中', error: '异常' },
};

const SUBTITLE = {
  adspower: '数据管理可直接使用；开始自动化时才连接引擎并按需打开指纹浏览器。',
  self: '数据管理可直接使用；开始自动化时才连接引擎并按需打开本机 Chrome。',
};

let currentStatus;
let publishPreviewActionBusy = false;
const PUBLISH_DRAFT_PAGE_SIZE = 12;
const publishDraftReview = {
  envId: null,
  page: 1,
  scrollTop: 0,
  total: 0,
  items: [],
  loaded: false,
  loading: false,
  error: '',
  selected: null,
  requestEpoch: 0,
  planRecordId: null,
  publishMode: 'immediate',
  publishTimeInput: '',
  editing: false,
  editFeedback: '',
  refinementScope: 'whole',
  refinementInstruction: '',
  selectedImageUrl: '',
  selectedTextSelection: null,
  activeRefinement: null,
  mutationBusy: false,
  handledByEnv: new Map(),
  scheduleAvailabilityByEnv: new Map(),
  scheduleAvailabilityEpochByEnv: new Map(),
  scheduleReservationsByAccount: new Map(),
};
let publishDraftRefinementPollTimer = null;
// 云端环境（change edge-cloud-env-selector）：本地已选 key + 主进程解析出的目标云端视图（含友好名）。
let cloudSelKey = '';
let targetCloud = { key: '', label: '默认', url: '' };
// ── 多环境 fleet 视图态（edge-multi-environment-fleet）──
// 状态 / 活动按 envId 归属；右侧主区域只呈现「当前选中环境」的投影（内容与交互不变）。
// 无 envId 的旧形状（单环境主进程 / 测试桩）归 '__local__'，环境栏对其隐藏——零回归。
const fleetView = {
  rosterPhase: 'loading', // loading / ready / error；只有全量 fleet 快照可把未知收敛成空或非空
  authoritativeEnvIds: new Set(), // 最近一次全量快照中的精确 envId；状态推送不能替代首次创建交接证据
  envs: new Map(), // envId -> { envId, name, platform, status }
  order: [], // 花名册顺序
  selected: null, // 当前选中 envId
  shownEnv: null, // 独占召回完成后位于 AIDCP 正后方的 envId（null=无）；与右侧当前选中环境相互独立
  browserRecallEpoch: 0, // renderer 侧最后一次头像双击代际；迟到 IPC 结果不得覆盖较新的用户意图
  collapsed: true, // 环境栏默认收起为窄图标条
  platformFilter: 'all', // 平台分类筛选为会话内视图态；每次启动默认全部，不落设置
  closeAllPending: false, // 只表达批量关闭 IPC 在途；逐环境终态仍由真实状态投影
  buffers: new Map(), // envId -> [{ entry, cls }]（每环境活动流缓冲，≤200 条，绝不串号）
  logs: new Map(), // envId -> { entries:[{time,message}], last }（每环境开发者原始日志，绝不串号）
  guided: null, // 引导处理态 { done:Set, current }
  lastRailSig: '', // 环境栏 DOM 变更签名（每秒 stale 重估时避免无谓重建，见 renderRail）
  lastRailSel: null, // 上次渲染时的选中 envId：只有「选中真的变了」才把选中行滚进视野，绝不与用户手滚打架
  lastRailCollapsed: null, // 上次渲染时的收 / 展态：行高体系不同，旧滚动位在新布局里没有意义
  slots: null,
};
// 登录后的环境列表要先按当前账号完成本地花名册同步，再允许 fleet 快照决定 empty / ready。
// 启动同步期间收到的推送只保留最后一份；同步完成后主动 fleetGet，避免采纳登录初期的空快照。
let environmentRosterBootstrapPending = true;
let bufferedEnvironmentRosterSnapshot = null;
let environmentRosterBootstrapEpoch = 0;
function currentEnvId() {
  return fleetView.selected && fleetView.selected !== '__local__' ? fleetView.selected : undefined;
}
function routeSelKey() {
  return fleetView.selected || '__local__';
}
// 用户正在编辑设置表单时不被状态推送回填覆盖（避免边打字边被清空）。
let editingProvider = null;
// 设置是否相对「已应用/已保存」有改动。核心在跑且 dirty 时才显示「按新设置重启」；
// 系统前置代理开关例外：选择会立即持久化给离线预检，运行代际差异由 proxyMode 单独判断。
// 「保存」按钮已并入「启动」——启动时先存再起，故无独立保存按钮。
let dirty = false;
// 选中环境的 AdsPower 环境名（随设置持久化，作标题带账号标签兜底）。
let selectedProfileName = '';
// 运行花名册：除可见名外保留系统名影子与 Cloud 同步态，空人工输入可可靠恢复系统名。
// 按 profileId 去重（同一分身 MUST NOT 重复加入，防 edgeId 撞车）；持久化为 settings.environments。
let roster = [];
// 昵称写入等待态按 envId 隔离：页面先乐观显示，但在主进程确认落盘前不得冒充“已保存”。
const manualNicknamePendingEnvIds = new Set();
// 客户归属环境默认入册的持久 opt-out；只在 main 明确标记 assignmentScoped 的列表上读写。
let clientRosterExcludedEnvIds = new Set();
let lastAssignmentScoped = false;
// 最近一次拉取的环境列表（roster 变更后就地重刷成员标记，无需重新拉取）。
let lastProfiles = [];
let batchProxyMode = false;
let batchProxySelectedIds = new Set();
let batchProxyPreviewEpoch = 0;
let batchProxyRequestSequence = 0;
let batchProxyActiveRequest = null;
let proxyQuickParseEpoch = 0;
let environmentCreateInFlight = false;
let pendingFirstEnvironmentHandoff = null; // { profileId }；设置花名册 + fleet 双重确认后才关环境管理
let firstEnvironmentStartGuideEnvId = null; // renderer 会话内一次性态，不持久化、不跨环境
function normalizeRosterList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String((raw && (raw.profileId !== undefined ? raw.profileId : raw.userId)) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const member = { profileId: id, name: (raw && raw.name) || '', platform: normPlatform(raw && raw.platform) };
    if (raw && typeof raw.systemName === 'string' && raw.systemName.trim()) member.systemName = raw.systemName.trim();
    if (raw && raw.nameSource === 'manual') {
      member.nameSource = 'manual';
      if (raw.nameSyncState === 'synced' || raw.nameSyncState === 'unsynced') member.nameSyncState = raw.nameSyncState;
    }
    out.push(member);
  }
  return out;
}
function rosterHas(profileId) {
  return roster.some((m) => m.profileId === profileId);
}
// change edge-environment-platform-select：当前选中环境的运行时平台（同步进 settings.platform，启动时注入核心）。
let selectedPlatform = 'xiaohongshu';
function normPlatform(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === 'wechat_channels' || v === 'wechat-channels' || v === 'wechat' || v === 'channels') return 'wechat_channels';
  if (v === 'facebook' || v === 'fb') return 'facebook';
  return 'xiaohongshu';
}
function platformLabel(p) {
  const platform = normPlatform(p);
  if (platform === 'wechat_channels') return '视频号';
  return platform === 'facebook' ? 'Facebook' : '小红书';
}
function updateFacebookImportVisibility() {
  const facebook = normPlatform(settingsUi.adsPlatform && settingsUi.adsPlatform.value) === 'facebook';
  if (!facebook && settingsUi.adsFbCreateMode) settingsUi.adsFbCreateMode.value = 'single';
  // 离开 Facebook 就把运行方式与免审复位，避免残留选择在切回时或经其它平台提交时被携带。
  if (!facebook) {
    if (settingsUi.adsFbRunMode) settingsUi.adsFbRunMode.value = 'normal';
    if (settingsUi.adsFbPrimarySurface) settingsUi.adsFbPrimarySurface.value = 'reels';
    if (settingsUi.adsFbApproval) settingsUi.adsFbApproval.checked = false;
  }
  const batch = facebook && settingsUi.adsFbCreateMode && settingsUi.adsFbCreateMode.value === 'batch';
  settingsUi.adsFbCreateModeField?.classList.toggle('hidden', !facebook);
  settingsUi.adsFbCreateMode?.classList.toggle('hidden', !facebook);
  settingsUi.adsFbRunModeField?.classList.toggle('hidden', !facebook);
  settingsUi.adsFbRunMode?.classList.toggle('hidden', !facebook);
  settingsUi.adsFbPrimarySurfaceField?.classList.toggle('hidden', !facebook);
  settingsUi.adsFbPrimarySurface?.classList.toggle('hidden', !facebook);
  settingsUi.adsFbRunModeWrap?.classList.toggle('hidden', !facebook);
  settingsUi.adsFbImportWrap?.classList.toggle('hidden', !facebook);
  settingsUi.adsTemplateField?.classList.toggle('hidden', Boolean(batch));
  settingsUi.adsTemplate?.classList.toggle('hidden', Boolean(batch));
  settingsUi.adsFbBatchAccountHelp?.classList.toggle('hidden', !batch);
  settingsUi.adsSingleProxyHelp?.classList.toggle('hidden', Boolean(batch));
  settingsUi.adsBatchProxyHelp?.classList.toggle('hidden', !batch);
  if (settingsUi.adsFbImportRequirement) {
    settingsUi.adsFbImportRequirement.textContent = batch ? '必填' : '可选';
    settingsUi.adsFbImportRequirement.classList.toggle('req', Boolean(batch));
    settingsUi.adsFbImportRequirement.classList.toggle('opt', !batch);
  }
  if (settingsUi.adsFbImport) settingsUi.adsFbImport.rows = batch ? 7 : 4;
  const noProxy = !settingsUi.adsProxyType || settingsUi.adsProxyType.value === 'no_proxy';
  settingsUi.adsProxyDetail?.classList.toggle('hidden', Boolean(batch) || noProxy);
  settingsUi.adsProxyBatchWrap?.classList.toggle('hidden', !batch || noProxy);
  syncCreatePlatformCards();
  syncCreateProxySummary();
  syncCreateButtonLabel();
}

function syncCreatePlatformCards() {
  const selected = normPlatform(settingsUi.adsPlatform && settingsUi.adsPlatform.value);
  for (const button of settingsUi.adsPlatformButtons || []) {
    const active = button.dataset.createPlatform === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  }
}

function setCreateProxyExpanded(expanded) {
  if (!settingsUi.adsProxyConfig || !settingsUi.adsProxyToggle) return;
  settingsUi.adsProxyConfig.classList.toggle('hidden', !expanded);
  settingsUi.adsProxyToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  const action = settingsUi.adsProxyToggle.querySelector('.create-proxy-action');
  if (action) action.textContent = expanded ? '收起⌃' : '配置 ›';
}

function syncCreateProxySummary() {
  if (!settingsUi.adsProxySummary) return;
  const type = settingsUi.adsProxyType ? settingsUi.adsProxyType.value : 'no_proxy';
  const labels = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' };
  settingsUi.adsProxySummary.textContent = type === 'no_proxy'
    ? '默认无代理；创建后也可以在环境列表中配置'
    : `已选择 ${labels[type] || type} 代理；请在下方填写连接信息`;
}

function createUsesBatchMode() {
  return normPlatform(settingsUi.adsPlatform && settingsUi.adsPlatform.value) === 'facebook'
    && settingsUi.adsFbCreateMode && settingsUi.adsFbCreateMode.value === 'batch';
}

function syncCreateButtonLabel() {
  if (!settingsUi.adsCreate) return;
  const batch = createUsesBatchMode();
  settingsUi.adsCreate.textContent = environmentCreateInFlight
    ? batch ? '正在批量创建…' : '正在创建…'
    : batch ? '批量创建' : '创建环境';
}

function setEnvironmentCreateBusy(busy) {
  environmentCreateInFlight = Boolean(busy);
  fields.envAddPanel?.classList.toggle('is-creating', environmentCreateInFlight);
  if (fields.envAddClose) fields.envAddClose.disabled = environmentCreateInFlight;
  if (fields.envTabJoin) fields.envTabJoin.disabled = environmentCreateInFlight;
  if (fields.envTabCreate) fields.envTabCreate.disabled = environmentCreateInFlight;
  if (fields.envCreateCancel) fields.envCreateCancel.disabled = environmentCreateInFlight;
  if (settingsUi.adsCreate) settingsUi.adsCreate.disabled = environmentCreateInFlight;
  syncCreateButtonLabel();
}
const LOG_RETENTION_MS = 2 * 60 * 1000; // 开发者详情原始日志保留 2 分钟
let quotaDetailsOpen = false;
/**
 * 慢启动写反馈（change slow-start-optimistic-feedback）：按 envKey 隔离，允许 A 环境等待云端时
 * 切到 B 环境继续操作，绝不把 A 的目标态 / 错误串过去。权威状态仍只在 env.status.dailyUsage；
 * 这里的 pending 只表达「请求在途」，error 只表达最近一次写失败。
 */
const slowStartFeedbackByEnv = new Map();

/**
 * 慢启动管理统一使用 customer-auth HTTP，按 envKey 隔离。自动化 WebSocket 快照可展示运行用量，
 * 但不再决定管理开关是否可读写。
 * 三种态：{ kind:'loading' }（读在途）/ { kind:'ok', slowStart, dayQuotas }（读到真态，或写入回执覆盖）/
 * { kind:'error', message }（够不到云端，就地如实展示，绝不静默吞）。
 * PUT 回执会覆盖本缓存；所有请求都有独立 loading / ok / error 状态。
 */
const slowStartHttpByEnv = new Map();

// 新 UI 的运行方式只认 Cloud unified operation policy。缓存只保存 readback 投影和请求反馈，
// 不落 localStorage/settings，也不复制规则/消费节奏数字。
const facebookOperationPolicyHttpByEnv = new Map();
const facebookOperationPolicyFeedbackByEnv = new Map();

// Facebook 规则模式配置只由 customer-auth HTTP 读写。按 envKey 隔离读真态与写反馈，
// 下面两份旧缓存仅供已发布规则模式兼容与“规则模式免人设”呈现；新模式 UI 不再使用它们。
const facebookRuleModeHttpByEnv = new Map();
const facebookRuleModeFeedbackByEnv = new Map();

// Cloud 环境风险管理真态统一由 customer-auth HTTP 提供；自动化引擎是否连接不参与读取/恢复闸。
const environmentRiskHttpByEnv = new Map();
const environmentRiskFetchInFlight = new Set();
const environmentRiskFeedbackByEnv = new Map();
let environmentRiskConfirmContext = null;
const ENVIRONMENT_RISK_TTL_MS = 15_000;
const ENVIRONMENT_RISK_RETRY_MS = 5_000;
const ENVIRONMENT_RISK_STATUSES = new Set(['normal', 'warned', 'restricted', 'frozen']);
const ENVIRONMENT_RISK_RECOVERY_POLL_DELAYS_MS = [0, 250, 500, 1000, 1500];

// 客户首页业务概览：单一来源为 customer-auth HTTP。自动化状态只用于触发失效重拉，绝不写入本缓存。
const environmentOverviewByEnv = new Map();
const environmentOverviewInFlight = new Set();
const environmentOverviewRefreshTimers = new Map();
const environmentOverviewAutomationSigByEnv = new Map();
const ENVIRONMENT_OVERVIEW_TTL_MS = 30_000;
const ENVIRONMENT_OVERVIEW_RETRY_MS = 5_000;
const ENVIRONMENT_OVERVIEW_POLL_MS = 60_000;
const ENVIRONMENT_OVERVIEW_MIN_REFRESH_MS = 5_000;

function environmentOverviewSupported() {
  return Boolean(window.aidcpEdge && typeof window.aidcpEdge.getEnvironmentOverview === 'function');
}

function environmentOverviewError(result, fallback = '暂时无法读取') {
  const raw = result && result.data && result.data.error;
  return String((result && result.data && result.data.message)
    || (raw && typeof raw === 'object' && (raw.message || raw.code))
    || (typeof raw === 'string' && raw)
    || (result && result.error)
    || fallback);
}

function normalizeEnvironmentOverview(result, expectedEnvKey) {
  const data = result && result.ok && result.data && result.data.data;
  const meta = result && result.data && result.data.meta;
  if (!data || data.envKey !== expectedEnvKey || !data.dailyUsage
      || !data.dailyUsage.totals || typeof data.dailyUsage.totals !== 'object') return null;
  const current = data.currentPublishState;
  if (current !== null && current !== undefined) {
    if (!current || !['pending', 'approved', 'submitted'].includes(current.state)
        || typeof current.code !== 'string' || !Number.isFinite(Number(current.at))) return null;
  }
  const last = data.lastPublished;
  if (last !== null && last !== undefined) {
    if (!last || typeof last.title !== 'string' || !last.title.trim() || !Number.isFinite(Number(last.at))) return null;
  }
  const asOf = Number(meta && meta.asOf);
  if (!Number.isFinite(asOf)) return null;
  return {
    dailyUsage: data.dailyUsage,
    publish: current ? {
      state: current.state,
      code: current.code,
      ...(typeof current.title === 'string' && current.title.trim() ? { title: current.title.trim() } : {}),
      at: new Date(Number(current.at)).toISOString(),
    } : null,
    lastPublish: last ? { title: last.title.trim(), at: new Date(Number(last.at)).toISOString() } : null,
    asOf,
  };
}

async function ensureEnvironmentOverview(envId, { force = false } = {}) {
  if (!environmentOverviewSupported() || !envId || envId === '__local__' || environmentOverviewInFlight.has(envId)) return;
  const env = fleetView.envs.get(envId);
  if (!env) return;
  const envKey = slowStartEnvKey(env);
  if (!envKey) return;
  const existing = environmentOverviewByEnv.get(envId);
  const now = Date.now();
  if (existing && Number(existing.retryAfter || 0) > now) return;
  if (force && existing && now - Number(existing.requestedAt || existing.fetchedAt || 0) < ENVIRONMENT_OVERVIEW_MIN_REFRESH_MS) return;
  if (!force && existing && existing.kind === 'ok' && now - Number(existing.fetchedAt || 0) < ENVIRONMENT_OVERVIEW_TTL_MS) return;
  environmentOverviewInFlight.add(envId);
  if (!existing || existing.kind !== 'ok') environmentOverviewByEnv.set(envId, { kind: 'loading', requestedAt: now });
  else environmentOverviewByEnv.set(envId, { ...existing, refreshing: true, requestedAt: now });
  if (fleetView.selected === envId && env.status) render(env.status);
  try {
    const result = await window.aidcpEdge.getEnvironmentOverview(envId);
    const normalized = normalizeEnvironmentOverview(result, envKey);
    if (!normalized) throw new Error(environmentOverviewError(result, 'Cloud 未返回可用的环境概览'));
    environmentOverviewByEnv.set(envId, {
      kind: 'ok', ...normalized, fetchedAt: Date.now(), requestedAt: now, stale: false, refreshing: false,
    });
  } catch (err) {
    const message = String((err && err.message) || err || '暂时无法读取');
    if (existing && existing.kind === 'ok') {
      environmentOverviewByEnv.set(envId, {
        ...existing, stale: true, refreshing: false, error: message, retryAfter: Date.now() + ENVIRONMENT_OVERVIEW_RETRY_MS,
      });
    } else {
      environmentOverviewByEnv.set(envId, {
        kind: 'error', error: message, requestedAt: now, retryAfter: Date.now() + ENVIRONMENT_OVERVIEW_RETRY_MS,
      });
    }
  } finally {
    environmentOverviewInFlight.delete(envId);
    const latest = fleetView.envs.get(envId);
    if (fleetView.selected === envId && latest && latest.status) render(latest.status);
  }
}

function scheduleEnvironmentOverviewRefresh(envId) {
  if (!environmentOverviewSupported() || !envId || envId === '__local__') return;
  const old = environmentOverviewRefreshTimers.get(envId);
  if (old) clearTimeout(old);
  environmentOverviewRefreshTimers.set(envId, setTimeout(() => {
    environmentOverviewRefreshTimers.delete(envId);
    void ensureEnvironmentOverview(envId, { force: true });
  }, 750));
}

function slowStartEnvKey(env) {
  return String((env && (env.profileId || env.envId)) || '').trim();
}

/**
 * 触发一次不依赖边缘的 env-scoped 慢启动读，落 slowStartHttpByEnv 后就地重绘。幂等：读在途 / 已读到即不重复发。
 * 够不到云端由 getSlowStart 的成败表达，**绝不新增任何浏览器 / 环境在线闸**（那正是 DEFECT 3 的病灶形状）。
 */
async function ensureSlowStartHttpFetch(envKey) {
  if (!envKey) return;
  if (!window.aidcpEdge || typeof window.aidcpEdge.getSlowStart !== 'function') return;
  const existing = slowStartHttpByEnv.get(envKey);
  if (existing && (existing.kind === 'loading' || existing.kind === 'ok')) return;
  slowStartHttpByEnv.set(envKey, { kind: 'loading' });
  let next;
  try {
    const res = await window.aidcpEdge.getSlowStart({ envKey });
    if (res && res.ok) {
      const payload = res.data && res.data.data;
      next = payload && payload.slowStart && typeof payload.slowStart === 'object'
        ? { kind: 'ok', slowStart: payload.slowStart, dayQuotas: payload.dayQuotas && typeof payload.dayQuotas === 'object' ? payload.dayQuotas : null }
        : { kind: 'error', message: '云端已返回，但未带回慢启动状态' };
    } else {
      const rawError = res && res.data && res.data.error;
      next = { kind: 'error', message: String((res && res.data && res.data.message)
        || (rawError && typeof rawError === 'object' && (rawError.message || rawError.code))
        || (typeof rawError === 'string' && rawError)
        || (res && res.error)
        || '暂时无法读取慢启动状态') };
    }
  } catch (err) {
    next = { kind: 'error', message: `读取失败：${(err && err.message) || err}` };
  }
  slowStartHttpByEnv.set(envKey, next);
  const context = selectedSlowStartContext();
  if (context && context.envKey === envKey) {
    if (next.kind === 'ok' && context.env?.status?.dailyUsage) {
      const dailyUsage = {
        ...context.env.status.dailyUsage,
        slowStart: next.slowStart,
        ...(next.dayQuotas ? { quotas: { ...next.dayQuotas } } : {}),
      };
      if (next.dayQuotas && dailyUsage.windows && typeof dailyUsage.windows === 'object') {
        dailyUsage.windows = {
          ...dailyUsage.windows,
          day: {
            ...(dailyUsage.windows.day && typeof dailyUsage.windows.day === 'object'
              ? dailyUsage.windows.day
              : {}),
            quotas: { ...next.dayQuotas },
          },
        };
      }
      context.env.status = { ...context.env.status, dailyUsage };
      render(context.env.status);
    } else {
      renderSlowStart((context.env && context.env.status) || currentStatus);
      renderFacebookOperationPolicy();
    }
  }
}

const FACEBOOK_OPERATION_BASE_MODES = new Set(['persona', 'rule', 'consumption']);
const FACEBOOK_PRIMARY_SURFACES = new Set(['feed', 'reels']);
const FACEBOOK_OPERATION_EFFECTIVE_MODES = new Set([
  'persona', 'slow_start', 'rule', 'consumption', 'blocked',
]);
const FACEBOOK_SLOW_START_STATES = new Set(['active', 'off', 'graduated', 'unknown']);

function hasExactObjectKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function facebookOperationPolicyError(res, fallback = '暂时无法读取运行方式') {
  const rawError = res && res.data && res.data.error;
  return String((res && res.data && res.data.message)
    || (rawError && typeof rawError === 'object' && (rawError.message || rawError.code))
    || (typeof rawError === 'string' && rawError)
    || (res && res.error)
    || fallback);
}

function normalizeFacebookOperationPolicyResponse(res, expectedEnvKey) {
  const payload = res && res.ok && res.data && res.data.data;
  const policy = payload && payload.facebookOperationPolicy;
  if (!hasExactObjectKeys(payload, ['envKey', 'facebookOperationPolicy'])
      || payload.envKey !== expectedEnvKey
      || !hasExactObjectKeys(policy, [
        'primarySurface', 'surfaceRevision', 'baseMode', 'effectiveMode',
        'policyRevision', 'slowStart', 'blocker',
      ])
      || !FACEBOOK_PRIMARY_SURFACES.has(policy.primarySurface)
      || !Number.isSafeInteger(policy.surfaceRevision) || policy.surfaceRevision < 1
      || !FACEBOOK_OPERATION_BASE_MODES.has(policy.baseMode)
      || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
      || (policy.effectiveMode !== null
        && !FACEBOOK_OPERATION_EFFECTIVE_MODES.has(policy.effectiveMode))
      || !hasExactObjectKeys(policy.slowStart, ['state'])
      || !FACEBOOK_SLOW_START_STATES.has(policy.slowStart.state)
      || (policy.blocker !== null && typeof policy.blocker !== 'string')) return null;
  return {
    primarySurface: policy.primarySurface,
    surfaceRevision: policy.surfaceRevision,
    baseMode: policy.baseMode,
    effectiveMode: policy.effectiveMode,
    policyRevision: policy.policyRevision,
    slowStart: { state: policy.slowStart.state },
    blocker: policy.blocker,
  };
}

function selectedFacebookOperationPolicyContext() {
  const context = selectedSlowStartContext();
  return context && selectedEnvPlatform() === 'facebook' ? context : null;
}

function selectedModeFromFacebookOperationPolicy(policy) {
  if (!policy) return null;
  if (policy.slowStart.state === 'active' || policy.effectiveMode === 'slow_start') {
    return 'slow_start';
  }
  return policy.baseMode;
}

async function ensureFacebookOperationPolicyHttpFetch(
  envKey,
  { force = false, preserveConfirmed = false } = {},
) {
  if (!envKey || !window.aidcpEdge
      || typeof window.aidcpEdge.getFacebookOperationPolicy !== 'function') return;
  const existing = facebookOperationPolicyHttpByEnv.get(envKey);
  if (!force && existing && (existing.kind === 'loading' || existing.kind === 'ok')) return;
  const retainExisting = preserveConfirmed && existing?.kind === 'ok';
  if (!retainExisting) facebookOperationPolicyHttpByEnv.set(envKey, { kind: 'loading' });
  let next;
  try {
    const res = await window.aidcpEdge.getFacebookOperationPolicy({ envKey });
    const config = normalizeFacebookOperationPolicyResponse(res, envKey);
    next = config
      ? { kind: 'ok', config }
      : { kind: 'error', message: facebookOperationPolicyError(res) };
  } catch (err) {
    next = { kind: 'error', message: `读取失败：${(err && err.message) || err}` };
  }
  // 写失败后的后台复读不能先抹掉最后确认态。GET 成功时再原子替换；GET 也失败则继续保留
  // 已确认 revision，并由写反馈显示本次失败，避免把短暂不可达冒充“模式未知”。
  if (next.kind === 'ok' || !retainExisting) {
    facebookOperationPolicyHttpByEnv.set(envKey, next);
  }
  const context = selectedFacebookOperationPolicyContext();
  if (context && context.envKey === envKey) renderFacebookOperationPolicy();
  syncPersonaPresentationForRuleMode(envKey);
}

function facebookRuleModeError(res, fallback = '暂时无法读取规则模式配置') {
  const rawError = res && res.data && res.data.error;
  return String((res && res.data && res.data.message)
    || (rawError && typeof rawError === 'object' && (rawError.message || rawError.code))
    || (typeof rawError === 'string' && rawError)
    || (res && res.error)
    || fallback);
}

function normalizeFacebookRuleModeResponse(res, expectedEnvKey) {
  const payload = res && res.ok && res.data && res.data.data;
  const config = payload && payload.facebookRuleMode;
  if (!payload || payload.envKey !== expectedEnvKey || !config || typeof config !== 'object'
      || typeof config.enabled !== 'boolean' || typeof config.definitionId !== 'string'
      || !config.definitionId.trim() || !Number.isInteger(config.definitionVersion)
      || (config.updatedAt !== null && typeof config.updatedAt !== 'string')) return null;
  return {
    enabled: config.enabled,
    definitionId: config.definitionId,
    definitionVersion: config.definitionVersion,
    updatedAt: config.updatedAt,
  };
}

async function ensureFacebookRuleModeHttpFetch(envKey) {
  if (!envKey || !window.aidcpEdge || typeof window.aidcpEdge.getFacebookRuleMode !== 'function') return;
  const existing = facebookRuleModeHttpByEnv.get(envKey);
  if (existing && (existing.kind === 'loading' || existing.kind === 'ok')) return;
  facebookRuleModeHttpByEnv.set(envKey, { kind: 'loading' });
  let next;
  try {
    const res = await window.aidcpEdge.getFacebookRuleMode({ envKey });
    const config = normalizeFacebookRuleModeResponse(res, envKey);
    next = config
      ? { kind: 'ok', config }
      : { kind: 'error', message: facebookRuleModeError(res) };
  } catch (err) {
    next = { kind: 'error', message: `读取失败：${(err && err.message) || err}` };
  }
  facebookRuleModeHttpByEnv.set(envKey, next);
  const context = selectedFacebookRuleModeContext();
  if (context && context.envKey === envKey) renderFacebookRuleMode();
  // 规则模式真态一到就重评人设呈现（change facebook-rule-mode-without-persona）：未绑人设 + 规则模式已开启
  // 是「按规则运行」，不是「待补人设」。读回来之前 maybePromptPersonaSetup 会先按住不弹，这里是它的续跳点。
  syncPersonaPresentationForRuleMode(envKey);
}

/** 规则模式配置读到之后，把依赖它的人设呈现（左栏图标 + 人设浮层徽标/文案/弹窗）重算一次。 */
function syncPersonaPresentationForRuleMode(envKey) {
  if (!envKey) return;
  const affected = [...fleetView.envs.values()].some((env) => slowStartEnvKey(env) === envKey);
  if (!affected) return;
  fleetView.lastRailSig = ''; // 人设图标口径随之变化，强制重建一次左栏
  renderRail();
  const env = fleetView.envs.get(currentEnvId());
  if (!env || slowStartEnvKey(env) !== envKey || !personaAppliesToEnvironment(env)) return;
  updatePersonaGate(env.status || currentStatus || null);
}

/**
 * 该环境**已读到的**云端权威规则模式配置；loading / 读失败 / 从未读过一律返回 null（未知）。
 * 未知交给纯逻辑按「未启用」处理——绝不把「还没读到」当成「已启用」。
 */
function authoritativeFacebookRuleMode(envKey) {
  const operationPolicy = envKey && facebookOperationPolicyHttpByEnv.get(envKey);
  if (operationPolicy && operationPolicy.kind === 'ok') {
    return { enabled: operationPolicy.config.baseMode === 'rule' };
  }
  const http = envKey && facebookRuleModeHttpByEnv.get(envKey);
  return http && http.kind === 'ok' ? http.config : null;
}

/** 某环境此刻是否应呈现为「按规则运行、未绑人设」（change facebook-rule-mode-without-persona）。 */
function personaRuleModeWithoutPersona(env, status) {
  if (!env) return false;
  const state = status || env.status || null;
  return uiLogic.facebookRuleModeWithoutPersona({
    platform: normPlatform(env.platform),
    personaBound: state && typeof state.personaBound === 'boolean' ? state.personaBound : null,
    ruleMode: authoritativeFacebookRuleMode(slowStartEnvKey(env)),
  });
}

/**
 * 规则模式事实还没到（且这个客户端确实读得到）→ 人设弹窗/通知先按住不发。
 *
 * 这一小段窗口里我们还不知道这个「云端确认未绑」的 Facebook 账号是不是正按规则运行，宁可晚弹也不误弹。
 * 非 Facebook、老客户端（没有这个读能力）、以及已经读到结果（成功或失败）都逐字走既有路径，不受影响。
 */
function facebookRuleModePendingForPersona(env) {
  if (!env || normPlatform(env.platform) !== 'facebook') return false;
  if (window.aidcpEdge && typeof window.aidcpEdge.getFacebookOperationPolicy === 'function') {
    const envKey = slowStartEnvKey(env);
    if (!envKey) return false;
    const operationPolicy = facebookOperationPolicyHttpByEnv.get(envKey);
    if (operationPolicy && (operationPolicy.kind === 'ok' || operationPolicy.kind === 'error')) {
      return false;
    }
    void ensureFacebookOperationPolicyHttpFetch(envKey);
    return true;
  }
  if (!window.aidcpEdge || typeof window.aidcpEdge.getFacebookRuleMode !== 'function') return false;
  const envKey = slowStartEnvKey(env);
  if (!envKey) return false;
  const http = facebookRuleModeHttpByEnv.get(envKey);
  if (http && (http.kind === 'ok' || http.kind === 'error')) return false;
  void ensureFacebookRuleModeHttpFetch(envKey);
  return true;
}

function selectedSlowStartContext() {
  const selectedKey = fleetView.selected;
  const env = selectedKey && fleetView.envs.get(selectedKey);
  const envKey = slowStartEnvKey(env);
  if (env && envKey && selectedKey !== '__local__') return { selectedKey, env, envKey };

  const selectedProfileId = settingsUi.adsProfile && settingsUi.adsProfile.value.trim();
  if (selectedProfileId) {
    return {
      selectedKey: selectedProfileId,
      env: { envId: selectedProfileId, profileId: selectedProfileId, platform: selectedPlatform, status: currentStatus },
      envKey: selectedProfileId,
    };
  }
  return env && envKey ? { selectedKey, env, envKey } : null;
}

function selectedFacebookRuleModeContext() {
  const context = selectedSlowStartContext();
  return context && selectedEnvPlatform() === 'facebook' ? context : null;
}

function selectedEnvironmentRiskContext() {
  const selectedKey = fleetView.selected;
  const env = selectedKey && fleetView.envs.get(selectedKey);
  const envKey = slowStartEnvKey(env);
  // 旧单环境状态形状没有 env.platform；选中环境可安全回落当前设置的平台，非选中环境绝不猜。
  const rawPlatform = String((env && env.platform) || '').trim();
  const platform = rawPlatform ? normPlatform(rawPlatform) : selectedEnvPlatform();
  if (!env || !envKey || selectedKey === '__local__' || platform !== 'facebook') return null;
  return { selectedKey, env, envKey };
}

function effectiveEnvironmentStatus(env, status) {
  let base = status || {};
  if (environmentOverviewSupported() && env && env.envId !== '__local__') {
    const overview = environmentOverviewByEnv.get(env.envId);
    if (overview && overview.kind === 'ok') {
      base = {
        ...base,
        dailyUsage: overview.dailyUsage,
        publish: overview.publish,
        lastPublish: overview.lastPublish,
        publishPreview: null,
        environmentOverview: {
          confirmed: true,
          stale: Boolean(overview.stale),
          refreshing: Boolean(overview.refreshing),
          asOf: overview.asOf,
          error: overview.error || null,
        },
      };
    } else {
      // 首次请求完成前/失败且无缓存：显式清掉本地引擎投影，防止假 0 与“从未发布”冒充云端事实。
      base = {
        ...base,
        dailyUsage: null,
        publish: null,
        lastPublish: null,
        publishPreview: null,
        environmentOverview: {
          confirmed: false,
          loading: !overview || overview.kind === 'loading',
          error: overview && overview.kind === 'error' ? overview.error : null,
        },
      };
    }
  }
  const rawPlatform = String((env && env.platform) || '').trim();
  const platform = rawPlatform
    ? normPlatform(rawPlatform)
    : (env && env.envId === fleetView.selected ? selectedEnvPlatform() : '');
  if (!env || platform !== 'facebook') return base;
  const envKey = slowStartEnvKey(env);
  const cached = envKey && environmentRiskHttpByEnv.get(envKey);
  if (!cached || cached.kind !== 'ok' || !ENVIRONMENT_RISK_STATUSES.has(cached.status)) return base;
  return { ...base, risk: cached.status };
}

function selectedEffectiveEnvironmentStatus(status) {
  const env = fleetView.selected && fleetView.envs.get(fleetView.selected);
  return effectiveEnvironmentStatus(env, status);
}

async function ensureEnvironmentRiskHttpFetch(envKey) {
  if (!envKey || environmentRiskFetchInFlight.has(envKey)) return;
  if (!window.aidcpEdge || typeof window.aidcpEdge.getEnvironmentRisk !== 'function') return;
  const existing = environmentRiskHttpByEnv.get(envKey);
  const now = Date.now();
  if (existing && Number(existing.retryAfter) > now) return;
  if (existing && existing.kind === 'ok' && now - Number(existing.fetchedAt || 0) < ENVIRONMENT_RISK_TTL_MS) return;
  environmentRiskFetchInFlight.add(envKey);
  try {
    const res = await window.aidcpEdge.getEnvironmentRisk({ envKey });
    const payload = res && res.ok && res.data && res.data.data;
    if (!payload || payload.envKey !== envKey || !ENVIRONMENT_RISK_STATUSES.has(payload.status)) {
      const message = String((res && res.error) || '云端未返回可用的风险状态');
      if (existing && existing.kind === 'ok') {
        environmentRiskHttpByEnv.set(envKey, { ...existing, retryAfter: Date.now() + ENVIRONMENT_RISK_RETRY_MS });
      } else {
        environmentRiskHttpByEnv.set(envKey, { kind: 'error', message, retryAfter: Date.now() + ENVIRONMENT_RISK_RETRY_MS });
      }
    } else {
      environmentRiskHttpByEnv.set(envKey, {
        kind: 'ok',
        status: payload.status,
        statusSince: payload.statusSince,
        updatedAt: payload.updatedAt,
        fetchedAt: Date.now(),
      });
    }
  } catch (err) {
    if (existing && existing.kind === 'ok') {
      environmentRiskHttpByEnv.set(envKey, { ...existing, retryAfter: Date.now() + ENVIRONMENT_RISK_RETRY_MS });
    } else {
      environmentRiskHttpByEnv.set(envKey, {
        kind: 'error', message: String((err && err.message) || err || '读取失败'), retryAfter: Date.now() + ENVIRONMENT_RISK_RETRY_MS,
      });
    }
  } finally {
    environmentRiskFetchInFlight.delete(envKey);
  }
  const context = selectedEnvironmentRiskContext();
  if (context && context.envKey === envKey) {
    render(context.env.status || currentStatus || {});
    // env-scoped HTTP 是停止环境的风险真态来源；主区域与环境栏必须在同一回执上同步收敛。
    renderRail();
  }
}

function hideSlowStartRow() {
  if (!fields.slowStartRow) return;
  fields.slowStartRow.classList.add('hidden');
  fields.slowStartRow.classList.remove('is-stale', 'is-pending');
  fields.slowStartRow.removeAttribute('aria-busy');
  if (fields.slowStartToggle) fields.slowStartToggle.indeterminate = false;
}

// 慢启动占位（change slow-start-offline-toggle）：既不是禁用理由、也不冒充某个真态。两处用它：env-scoped 读在途
// （'正在读取慢启动状态…'）；该构建未提供不依赖边缘的读时的退化态（'启动环境…'，绝不卡死在读中）。读毕由
// ensureSlowStartHttpFetch 重绘为真态 / binding_unknown / 读失败。
function renderSlowStartPlaceholder(text) {
  fields.slowStartRow.classList.remove('hidden', 'is-stale', 'is-pending');
  fields.slowStartRow.removeAttribute('aria-busy');
  if (fields.slowStartToggle) {
    fields.slowStartToggle.checked = false;
    fields.slowStartToggle.indeterminate = true;
    fields.slowStartToggle.disabled = true;
  }
  if (fields.slowStartBadge) {
    fields.slowStartBadge.textContent = '';
    fields.slowStartBadge.className = 'acct-age hidden';
  }
  if (fields.slowStartReason) {
    fields.slowStartReason.textContent = text;
    fields.slowStartReason.className = 'parking-hint';
  }
}

// 慢启动 env-scoped 读失败（够不到云端）：整行可见、就地如实说明，绝不静默吞。读不到真态即无从渲染可信开关，
// 故禁用是 ESSENTIAL（不知道现在是开是关，不能给一个会撒谎的勾选框）——这与被摘掉的「内核在线闸」形状不同。
function renderSlowStartHttpError(message) {
  fields.slowStartRow.classList.remove('hidden', 'is-stale', 'is-pending');
  fields.slowStartRow.removeAttribute('aria-busy');
  if (fields.slowStartToggle) {
    fields.slowStartToggle.checked = false;
    fields.slowStartToggle.indeterminate = true;
    fields.slowStartToggle.disabled = true;
  }
  if (fields.slowStartBadge) {
    fields.slowStartBadge.textContent = '';
    fields.slowStartBadge.className = 'acct-age hidden';
  }
  if (fields.slowStartReason) {
    fields.slowStartReason.textContent = message || '暂时无法读取慢启动状态，请稍后重试';
    fields.slowStartReason.className = 'parking-hint is-error';
  }
}

// 平台占位：mac 红绿灯内嵌预留左侧；Windows 叠加窗控预留右侧。其余平台两侧归零。
(function initPlatformPads() {
  const platform = (navigator.platform || '').toLowerCase();
  const isMac = platform.includes('mac');
  const isWin = platform.includes('win');
  if (!isMac && fields.lightsPad) fields.lightsPad.classList.add('none');
  if (isWin && fields.winctlPad) fields.winctlPad.classList.add('win');
})();

function setBadge(element, field, value) {
  element.textContent = STATUS_LABELS[field]?.[value] ?? value;
  element.className = `badge ${value}`;
}

/**
 * 客户端指标表（change platform-honest-usage-metrics）。
 *
 * 这里列的是「**可能**出现的格子」，不是「一定出现的格子」——**哪些真出现由云端投影决定**：云端按平台
 * 声明摘掉该平台结构上做不到的动作（例如 FB 没有收藏），客户端只渲染云端真给了的键。
 * 客户端 MUST NOT 自己按平台判：它拿不到权威平台值（本地环境标签会错标，见 backlog 90.8）。
 *
 * `stat` = 无云端用量载荷时的本机回落来源。`join_group` 是 null：加群没有本机计数来源，故在「云端还没
 * 发过用量」的那段时间里它不出现——那正是本 change 之前的现状（fail-safe 方向 = 保持现状）。
 */
const USAGE_ITEMS = [
  { action: 'view', stat: 'views', value: fields.views, label: '浏览' },
  // 搜索只有 Cloud 消费 actuated=true 终态后才是真事实；绝不从本机日志回落补数。
  { action: 'search', stat: null, value: fields.searches, label: '搜索' },
  { action: 'like', stat: 'likes', value: fields.likes, label: '点赞' },
  { action: 'collect', stat: 'collects', value: fields.collects, label: '收藏' },
  { action: 'comment', stat: 'comments', value: fields.comments, label: '评论' },
  { action: 'follow', stat: 'follows', value: fields.follows, label: '关注' },
  { action: 'publish', stat: 'publishes', value: fields.publishes, label: '发帖' },
  { action: 'join_group', stat: null, value: fields.joins, label: '加群' },
];

const QUOTA_WINDOWS = [
  { key: 'session', label: '本轮计划' },
  { key: 'minute', label: '近 1 分钟' },
  { key: 'hour', label: '近 1 小时' },
  { key: 'day', label: '今日计划' },
];

const QUOTA_LEVEL_LABELS = {
  conservative: '稳妥节奏',
  normal: '均衡节奏',
  aggressive: '积极节奏',
};

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function parseUsageTime(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  if (Number.isFinite(parsed)) return parsed;
  return Date.parse(fallback || '') || Date.now();
}

function parseOptionalTime(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeHint(at, now) {
  const diff = at - now;
  if (diff > 0) {
    const seconds = Math.ceil(diff / 1000);
    if (seconds < 90) return `约 ${seconds} 秒后`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 90) return `约 ${minutes} 分钟后`;
    const hours = Math.ceil(minutes / 60);
    if (hours < 24) return `约 ${hours} 小时后`;
  }
  return new Date(at).toLocaleTimeString();
}

function refreshMeta(refreshAt, now) {
  if (refreshAt === null) return '等待下一轮';
  if (refreshAt > now) return `${timeHint(refreshAt, now)}进入下一轮`;
  return '正在准备下一轮';
}

function clockTime(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function sessionRemainingState(expiresAt, now) {
  if (expiresAt === null || expiresAt <= now) return null;
  const seconds = Math.ceil((expiresAt - now) / 1000);
  if (seconds < 90) return `剩余 ${seconds} 秒`;
  return `剩余 ${Math.ceil(seconds / 60)} 分钟`;
}

function usageView(status) {
  const daily = status.dailyUsage;
  const hasDaily = Boolean(daily && daily.totals && typeof daily.totals === 'object');
  const overview = status.environmentOverview || null;
  const managedByOverview = Boolean(overview);
  const stats = status.stats || {};
  const totals = {};
  // 「这个账号该有哪些格子」（change platform-honest-usage-metrics）：
  //   - 有云端用量 ⇒ 云端**真给了**的键就是全部答案。判据是键在不在，**不是值大不大**——
  //     供给的 0 是真实的「今天还没做」、必须照显；缺席才是「这个平台没有这个动作」。
  //   - 还没收到云端用量 ⇒ 回落本机六格（= 本 change 之前的现状；加群无本机来源故不出现）。
  const supplied = new Set();
  for (const item of USAGE_ITEMS) {
    if (hasDaily) {
      if (!Object.prototype.hasOwnProperty.call(daily.totals, item.action)) continue;
      supplied.add(item.action);
      totals[item.action] = count(daily.totals[item.action]);
    } else if (!managedByOverview && item.stat) {
      supplied.add(item.action);
      totals[item.action] = count(stats[item.stat]);
    } else if (managedByOverview && item.stat) {
      // 首次 HTTP 结果到达前保留稳定格位，但值用破折号，绝不把“未知”画成 0。
      supplied.add(item.action);
    }
  }
  const quotas = daily && daily.quotas && typeof daily.quotas === 'object' ? daily.quotas : null;
  return {
    hasDaily,
    managedByOverview,
    confirmed: hasDaily,
    overview,
    supplied,
    quotaLevel: daily?.quotaLevel,
    asOf: hasDaily ? parseUsageTime(daily.asOf, status.updatedAt) : parseUsageTime(status.updatedAt, status.updatedAt),
    totals,
    quotas,
    saturated: new Set(Array.isArray(daily?.saturated) ? daily.saturated : []),
    windows: daily && daily.windows && typeof daily.windows === 'object' ? daily.windows : null,
  };
}

function renderUsageItem(item, usage) {
  const card = item.value.closest('.kpi');
  // 云端没给这个指标 = 这个平台结构上没有这个动作 ⇒ **整格不画**（change platform-honest-usage-metrics）。
  // 不是画一个诚实的 0：FB 的「收藏 0」不是观测、是云端对一个不存在的动作物化出来的常量，
  // 它读作「今天还没收藏」、暗示明天会有数字，而真相是「这个平台没有收藏」。
  if (!usage.supplied.has(item.action)) {
    if (card) {
      card.classList.add('hidden');
      card.classList.remove('has-limit', 'near', 'complete');
      card.removeAttribute('title');
    }
    return;
  }
  if (card) card.classList.remove('hidden');
  if (usage.managedByOverview && !usage.confirmed) {
    item.value.textContent = '—';
    item.value.classList.remove('zero');
    const capEl = fields.usageCaps[item.action];
    const barEl = fields.usageBars[item.action];
    if (capEl) capEl.textContent = '';
    if (barEl) barEl.style.width = '0%';
    if (card) {
      card.classList.remove('has-limit', 'near', 'complete');
      card.title = usage.overview?.loading ? '正在读取账号今日数据' : '暂时无法读取账号今日数据';
    }
    return;
  }
  const used = count(usage.totals[item.action]);
  const cap = usage.quotas && typeof usage.quotas[item.action] === 'number' ? count(usage.quotas[item.action]) : null;
  const capEl = fields.usageCaps[item.action];
  const barEl = fields.usageBars[item.action];
  const hasCap = cap !== null;
  const saturated = hasCap && (usage.saturated.has(item.action) || used >= cap);
  const ratio = hasCap ? (cap > 0 ? Math.min(1, used / cap) : 1) : 0;

  item.value.textContent = usage.managedByOverview && !usage.confirmed ? '—' : used;
  item.value.classList.toggle('zero', (!usage.managedByOverview || usage.confirmed) && used === 0);
  if (capEl) capEl.textContent = hasCap ? `/${cap}` : '';
  if (barEl) barEl.style.width = hasCap ? `${Math.round(ratio * 100)}%` : '0%';
  if (card) {
    card.classList.toggle('has-limit', hasCap);
    card.classList.toggle('near', hasCap && !saturated && ratio >= 0.8);
    card.classList.toggle('complete', saturated);
    card.title = hasCap ? `${item.label} ${used}/${cap}${saturated ? '，今日计划已完成' : ''}` : `${item.label} ${used}`;
  }
}

function quotaCompletionSummary(windowViews) {
  const byAction = new Map();
  for (const window of windowViews) {
    for (const entry of window.rows.filter((row) => row.complete)) {
      const current = byAction.get(entry.action) || { action: entry.action, label: entry.label, windows: [] };
      if (!current.windows.some((item) => item.key === window.key)) current.windows.push({ key: window.key, label: window.label });
      byAction.set(entry.action, current);
    }
  }
  const selected = USAGE_ITEMS.map((item) => byAction.get(item.action)).find(Boolean);
  if (!selected) return null;
  const dailyComplete = selected.windows.some((window) => window.key === 'day');
  const text = dailyComplete
    ? (selected.action === 'view' ? '今日任务已完成' : `今日${selected.label}计划已完成`)
    : `${selected.label}完成一轮`;
  const title = `${selected.label}：${selected.windows.map((window) => window.label).join('、')}已完成`;
  return { text, title };
}

function usageProgressLabel(usage) {
  const windowViews = quotaWindowViews(usage);
  if (windowViews.length > 0) {
    const complete = quotaCompletionSummary(windowViews);
    if (complete) return { tone: 'complete', text: complete.text, title: complete.title };
    return { tone: 'ok', text: '按计划进行中' };
  }
  if (!usage.quotas) return null;
  const limited = [];
  for (const item of USAGE_ITEMS) {
    const cap = typeof usage.quotas[item.action] === 'number' ? count(usage.quotas[item.action]) : null;
    if (cap === null) continue;
    const used = count(usage.totals[item.action]);
    if (usage.saturated.has(item.action) || used >= cap) limited.push(item.label);
  }
  const selected = limited[0];
  return selected
    ? { tone: 'complete', text: selected === '浏览' ? '今日任务已完成' : `今日${selected}计划已完成` }
    : { tone: 'ok', text: '按计划进行中' };
}

function quotaWindowViewsAt(usage, now) {
  const windows = usage.windows;
  if (!windows || typeof windows !== 'object') return [];
  return QUOTA_WINDOWS.map((item) => quotaWindowView(item, windows[item.key], now))
    .filter(Boolean);
}

function quotaWindowViews(usage) {
  return quotaWindowViewsAt(usage, Date.now());
}

function quotaWindowView(item, window, now) {
  if (!window || typeof window !== 'object') return null;
  const totals = window.totals && typeof window.totals === 'object' ? window.totals : {};
  const quotas = window.quotas && typeof window.quotas === 'object' ? window.quotas : {};
  const saturated = new Set(Array.isArray(window.saturated) ? window.saturated : []);
  const active = item.key === 'session' ? window.active !== false : true;
  const startedAt = parseOptionalTime(window.startedAt);
  const expiresAt = parseOptionalTime(window.expiresAt);
  const refreshAt = parseOptionalTime(window.refreshAt);
  const releaseAt = parseOptionalTime(window.releaseAt);
  const expired = (item.key === 'minute' || item.key === 'hour') && expiresAt !== null && expiresAt <= now;
  const rows = [];
  const capped = [];
  for (const usageItem of USAGE_ITEMS) {
    const hasTotal = Object.prototype.hasOwnProperty.call(totals, usageItem.action);
    const hasCap = typeof quotas[usageItem.action] === 'number';
    if (!hasTotal && !hasCap) continue;
    const used = count(totals[usageItem.action]);
    const cap = hasCap ? count(quotas[usageItem.action]) : null;
    const ratio = cap !== null ? (cap > 0 ? Math.min(1, used / cap) : 1) : 0;
    const complete = !expired && active && cap !== null && (saturated.has(usageItem.action) || used >= cap);
    const row = { ...usageItem, used, cap, ratio, complete, hasCap };
    rows.push(row);
    if (hasCap) capped.push(row);
  }
  if (rows.length === 0) return null;
  const completedRows = rows.filter((entry) => entry.complete);
  const completed = completedRows.length;
  const viewComplete = completedRows.some((entry) => entry.action === 'view');
  const worst = capped.reduce((best, entry) => (!best || entry.ratio > best.ratio ? entry : best), null);
  const incompleteWorst = capped
    .filter((entry) => !entry.complete)
    .reduce((best, entry) => (!best || entry.ratio > best.ratio ? entry : best), null);
  const ratio = !expired && active ? (incompleteWorst?.ratio ?? 0) : 0;
  const tone = expired || !active ? 'idle' : viewComplete ? 'complete' : ratio >= 0.8 ? 'near' : 'ok';
  const hasSessionTiming = item.key === 'session'
    && active
    && startedAt !== null
    && expiresAt !== null
    && expiresAt > now;
  const sessionRemaining = hasSessionTiming ? sessionRemainingState(expiresAt, now) : null;
  const state = expired
    ? '准备下一轮'
    : !active
      ? '等待开始'
      : completed > 0
        ? `完成 ${completed}项`
        : sessionRemaining
          ?? (ratio >= 0.8
            ? (item.key === 'minute' || item.key === 'hour' ? '接近休息' : '接近完成')
            : (item.key === 'minute' || item.key === 'hour' ? '节奏正常' : '进行中'));
  const baseMeta = worst ? `${worst.label} ${worst.used} · 最多 ${worst.cap}` : '持续记录中';
  const sessionMeta = hasSessionTiming
    ? `${clockTime(startedAt)} 开始 · 预计 ${clockTime(expiresAt)} 结束`
    : null;
  const scopeMeta = item.key === 'minute' || item.key === 'hour'
    ? '随时间滚动更新'
    : item.key === 'day'
      ? '今天 00:00 至今'
      : null;
  const meta = expired
    ? refreshMeta(refreshAt, now)
    : (completed > 0 && releaseAt !== null && releaseAt > now
      ? `${baseMeta} · ${timeHint(releaseAt, now)}继续`
      : sessionMeta ?? scopeMeta ?? baseMeta);
  return {
    key: item.key,
    label: item.label,
    tone,
    state,
    meta,
    ratio,
    completed,
    expired,
    rows,
    title: `${item.label}: ${state}${rows.length > 0 ? ` · ${rows.map((entry) => `${entry.label} ${entry.used}${entry.cap === null ? '' : `，最多 ${entry.cap}`}`).join(' · ')}` : ''}`,
  };
}

function renderQuotaWindows(usage) {
  if (!fields.quotaWindows) return;
  const windows = quotaWindowViews(usage);
  const expanded = quotaDetailsOpen && windows.length > 0;
  fields.dailySummary?.classList.toggle('expanded', expanded);
  if (fields.quotaToggle) {
    fields.quotaToggle.classList.toggle('open', expanded);
    fields.quotaToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    fields.quotaToggle.setAttribute('aria-label', expanded ? '收起今日节奏' : '展开今日节奏');
  }
  if (fields.quotaToggleLabel) fields.quotaToggleLabel.textContent = expanded ? '收起' : '展开';
  if (windows.length === 0 || !quotaDetailsOpen) {
    fields.quotaWindows.className = 'quota-windows hidden';
    fields.quotaWindows.innerHTML = '';
    return;
  }
  fields.quotaWindows.className = 'quota-windows';
  fields.quotaWindows.innerHTML = windows.map((window) => {
    const rows = window.rows.map((entry) => {
      const pct = entry.cap !== null ? Math.round(entry.ratio * 100) : 0;
      const cap = entry.cap !== null ? `<small>最多 ${escapeHtml(entry.cap)}</small>` : '';
      const progress = entry.cap !== null ? `<i><em style="width:${pct}%"></em></i>` : '';
      const rowTone = entry.complete && entry.action === 'view'
        ? 'complete'
        : !entry.complete && entry.ratio >= 0.8 && entry.cap !== null
          ? 'near'
          : '';
      return `
        <div class="qwd-row ${rowTone}">
          <span>${escapeHtml(entry.label)}</span>
          <b>${escapeHtml(entry.used)}${cap}</b>
          ${progress}
        </div>`;
    }).join('');
    return `
      <div class="quota-window-detail ${window.tone}" title="${escapeHtml(window.title)}">
        <div class="qwd-head">
          <span>${escapeHtml(window.label)}</span>
          <strong class="${window.completed > 0 ? 'has-completions' : ''}">${escapeHtml(window.state)}</strong>
        </div>
        <small>${escapeHtml(window.meta)}</small>
        <div class="qwd-rows">${rows}</div>
      </div>`;
  }).join('');
}

function renderUsageSummary(status) {
  if (fields.dailySummary) fields.dailySummary.dataset.platform = selectedEnvPlatform() || 'unknown';
  const usage = usageView(status);
  fields.usageSource.textContent = usage.hasDaily
    ? `${usage.overview?.stale ? '账号今日 · 缓存' : '账号今日'}${usage.quotaLevel ? ` · ${QUOTA_LEVEL_LABELS[usage.quotaLevel] || usage.quotaLevel}` : ''}`
    : usage.managedByOverview
      ? (usage.overview?.loading ? '获取中' : '暂时无法获取')
      : '本机实时';
  fields.usageSource.title = usage.overview?.error
    ? `最近刷新失败：${usage.overview.error}`
    : usage.overview?.refreshing ? '正在刷新云端数据' : '';
  const limit = usageProgressLabel(usage);
  if (fields.usageLimit) {
    fields.usageLimit.textContent = limit ? limit.text : '';
    fields.usageLimit.className = limit ? `summary-limit ${limit.tone}` : 'summary-limit hidden';
    fields.usageLimit.title = limit ? limit.title || limit.text : '';
  }
  for (const item of USAGE_ITEMS) renderUsageItem(item, usage);
  renderQuotaWindows(usage);
  renderSlowStart(status);
  renderFacebookOperationPolicy();
  renderEnvironmentRiskRecovery(status);
  fields.updatedAt.textContent = usage.managedByOverview && !usage.confirmed
    ? '—'
    : new Date(usage.overview?.asOf || usage.asOf).toLocaleTimeString();
}

function hideEnvironmentRiskRecovery() {
  fields.riskRecoveryRow?.classList.add('hidden');
  if (fields.riskRecoveryButton) {
    fields.riskRecoveryButton.disabled = false;
    fields.riskRecoveryButton.textContent = '解除受限';
  }
  if (fields.riskRecoveryFeedback) {
    fields.riskRecoveryFeedback.textContent = '';
    fields.riskRecoveryFeedback.classList.add('hidden');
  }
}

function closeEnvironmentRiskRecoveryConfirm(returnValue = 'cancel') {
  environmentRiskConfirmContext = null;
  if (fields.riskRecoveryConfirm?.open) fields.riskRecoveryConfirm.close(returnValue);
}

function openEnvironmentRiskRecoveryConfirm() {
  const context = selectedEnvironmentRiskContext();
  if (!context || !fields.riskRecoveryConfirm || typeof fields.riskRecoveryConfirm.showModal !== 'function') return;
  if (!window.aidcpEdge || typeof window.aidcpEdge.recoverEnvironmentRisk !== 'function') return;
  const status = effectiveEnvironmentStatus(context.env, context.env.status || currentStatus);
  if (!status || status.risk !== 'restricted') return;
  if (environmentRiskFeedbackByEnv.get(context.envKey)?.kind === 'pending') return;
  if (fields.riskRecoveryConfirm.open) fields.riskRecoveryConfirm.close('replace');
  environmentRiskConfirmContext = { selectedKey: context.selectedKey, envKey: context.envKey };
  if (fields.riskRecoveryConfirmEnv) fields.riskRecoveryConfirmEnv.textContent = railDisplayName(context.env);
  fields.riskRecoveryConfirm.showModal();
}

/** 当前选中 Facebook 环境的一行式恢复入口；状态必须来自 live snapshot 或 env-scoped Cloud 读。 */
function renderEnvironmentRiskRecovery(status) {
  if (!fields.riskRecoveryRow) return;
  const context = selectedEnvironmentRiskContext();
  if (!context) {
    closeEnvironmentRiskRecoveryConfirm();
    hideEnvironmentRiskRecovery();
    return;
  }
  if (environmentRiskConfirmContext && environmentRiskConfirmContext.envKey !== context.envKey) {
    closeEnvironmentRiskRecoveryConfirm('environment_changed');
  }
  void ensureEnvironmentRiskHttpFetch(context.envKey);
  const effective = effectiveEnvironmentStatus(context.env, status);
  const visible = effective && effective.risk === 'restricted';
  if (!visible) {
    closeEnvironmentRiskRecoveryConfirm('state_changed');
    const previous = environmentRiskFeedbackByEnv.get(context.envKey);
    if (!previous || previous.kind !== 'pending') environmentRiskFeedbackByEnv.delete(context.envKey);
    hideEnvironmentRiskRecovery();
    return;
  }
  fields.riskRecoveryRow.classList.remove('hidden');
  const feedback = environmentRiskFeedbackByEnv.get(context.envKey);
  const pending = feedback && feedback.kind === 'pending';
  if (fields.riskRecoveryButton) {
    fields.riskRecoveryButton.disabled = Boolean(pending);
    fields.riskRecoveryButton.textContent = pending ? '解除中…' : '解除受限';
  }
  if (fields.riskRecoveryFeedback) {
    const message = feedback && (feedback.kind === 'error' || feedback.kind === 'pending')
      ? String(feedback.message || '')
      : '';
    fields.riskRecoveryFeedback.textContent = message;
    fields.riskRecoveryFeedback.classList.toggle('hidden', !message);
  }
}

/**
 * 环境级慢启动脚注行：只切 hidden / checked / disabled / textContent，
 * 绝不建元素（静态节点，本 section 不在任何 innerHTML 重建范围内）。
 * 纯逻辑在 uiLogic.slowStartLine —— 字段缺省 → 整行不渲染（绝不默认 off，照 personaBound 三态判例）。
 */
function renderSlowStart(status) {
  if (!fields.slowStartRow) return;
  const context = selectedSlowStartContext();
  // change slow-start-facebook-curve-tooltip：产品入口只属于明确的 Facebook 环境。
  // 不借 eligible / reason 猜平台；小红书即使收到历史 slowStart 投影也必须整行隐藏。
  if (!context || selectedEnvPlatform() !== 'facebook') {
    hideSlowStartRow();
    return;
  }
  // 管理开关始终走 env-scoped HTTP；引擎已连接也不会切回 WebSocket 快照作为写入依据。
  if (!window.aidcpEdge || typeof window.aidcpEdge.getSlowStart !== 'function') {
    renderSlowStartPlaceholder('请登录客户端后读取 Cloud 慢启动状态');
    return;
  }
  const http = slowStartHttpByEnv.get(context.envKey);
  if (http && http.kind === 'ok') {
    applySlowStartView(window.uiLogic.slowStartLine({ slowStart: http.slowStart }, 'offline', 'http'), context);
    return;
  }
  if (http && http.kind === 'error') {
    renderSlowStartHttpError(http.message);
    return;
  }
  void ensureSlowStartHttpFetch(context.envKey);
  renderSlowStartPlaceholder('正在读取慢启动状态…');
}

/**
 * 把一个已解析的慢启动视图（来自快照或 HTTP 读，二选一整体采用、绝不逐字段拼）落到静态节点上。
 * pending（本地在途写）覆盖一切；否则渲染真态徽章 + 开关 + reason（用量陈旧 / 不可用原因 / 写失败）。
 */
function applySlowStartView(view, context) {
  const feedback = slowStartFeedbackByEnv.get(context.envKey);
  const pending = feedback && feedback.kind === 'pending' ? feedback : null;
  fields.slowStartRow.classList.remove('hidden');
  fields.slowStartRow.classList.toggle('is-stale', Boolean(view.stale) && !pending);
  fields.slowStartRow.classList.toggle('is-pending', Boolean(pending));
  if (pending) fields.slowStartRow.setAttribute('aria-busy', 'true');
  else fields.slowStartRow.removeAttribute('aria-busy');

  // pending 是明确的本地临时态：展示用户的目标动作，但不冒充云端已经生效，也不推算 day / quota。
  if (pending) {
    if (fields.slowStartToggle) {
      fields.slowStartToggle.checked = Boolean(pending.enabled);
      fields.slowStartToggle.indeterminate = false;
      fields.slowStartToggle.disabled = true;
    }
    if (fields.slowStartBadge) {
      fields.slowStartBadge.textContent = pending.enabled ? '慢启动 · 正在开启…' : '慢启动 · 正在关闭…';
      fields.slowStartBadge.className = 'acct-age is-pending';
    }
    if (fields.slowStartReason) {
      fields.slowStartReason.textContent = '正在等待云端确认，请稍候';
      fields.slowStartReason.className = 'parking-hint slow-start-feedback';
    }
    return;
  }

  if (fields.slowStartToggle) {
    fields.slowStartToggle.checked = Boolean(view.checked);
    fields.slowStartToggle.indeterminate = false;
    fields.slowStartToggle.disabled = Boolean(view.disabled);
  }
  if (fields.slowStartBadge) {
    fields.slowStartBadge.textContent = view.badge || '';
    fields.slowStartBadge.className = view.badge
      ? `acct-age${view.tone === 'graduated' ? ' is-graduated' : ''}`
      : 'acct-age hidden';
  }
  if (fields.slowStartReason) {
    const error = feedback && feedback.kind === 'error' ? feedback.message : '';
    const reason = error || view.reason || '';
    fields.slowStartReason.textContent = reason;
    fields.slowStartReason.className = reason
      ? `parking-hint${error ? ' is-error' : ''}`
      : 'parking-hint hidden';
  }
}

function hideFacebookPersonaModeRow() {
  if (!fields.facebookPersonaModeRow) return;
  fields.facebookPersonaModeRow.classList.add('hidden');
  fields.facebookPersonaModeRow.classList.remove('is-pending');
  fields.facebookPersonaModeRow.removeAttribute('aria-busy');
  if (fields.facebookPersonaModeToggle) fields.facebookPersonaModeToggle.indeterminate = false;
}

function hideFacebookRuleModeRow() {
  if (!fields.facebookRuleModeRow) return;
  fields.facebookRuleModeRow.classList.add('hidden');
  fields.facebookRuleModeRow.classList.remove('is-pending');
  fields.facebookRuleModeRow.removeAttribute('aria-busy');
  if (fields.facebookRuleModeToggle) fields.facebookRuleModeToggle.indeterminate = false;
}

function renderFacebookRuleModeUnknown(message, error = false) {
  if (!fields.facebookRuleModeRow) return;
  fields.facebookRuleModeRow.classList.remove('hidden', 'is-pending');
  fields.facebookRuleModeRow.removeAttribute('aria-busy');
  if (fields.facebookRuleModeToggle) {
    fields.facebookRuleModeToggle.checked = false;
    fields.facebookRuleModeToggle.indeterminate = true;
    fields.facebookRuleModeToggle.disabled = true;
  }
  if (fields.facebookRuleModeBadge) {
    fields.facebookRuleModeBadge.textContent = '';
    fields.facebookRuleModeBadge.className = 'acct-age rule-mode-badge hidden';
  }
  if (fields.facebookRuleModeReason) {
    fields.facebookRuleModeReason.textContent = message;
    fields.facebookRuleModeReason.className = `parking-hint${error ? ' is-error' : ''}`;
  }
}

function renderFacebookRuleMode() {
  if (!fields.facebookRuleModeRow) return;
  const context = selectedFacebookRuleModeContext();
  if (!context) {
    hideFacebookRuleModeRow();
    return;
  }
  if (!window.aidcpEdge || typeof window.aidcpEdge.getFacebookRuleMode !== 'function') {
    renderFacebookRuleModeUnknown('请登录客户端后读取 Cloud 规则模式配置');
    return;
  }
  const http = facebookRuleModeHttpByEnv.get(context.envKey);
  if (http && http.kind === 'ok') {
    const feedback = facebookRuleModeFeedbackByEnv.get(context.envKey);
    const pending = feedback && feedback.kind === 'pending' ? feedback : null;
    fields.facebookRuleModeRow.classList.remove('hidden');
    fields.facebookRuleModeRow.classList.toggle('is-pending', Boolean(pending));
    if (pending) fields.facebookRuleModeRow.setAttribute('aria-busy', 'true');
    else fields.facebookRuleModeRow.removeAttribute('aria-busy');

    const enabled = pending ? Boolean(pending.enabled) : Boolean(http.config.enabled);
    const writerUnavailable = typeof window.aidcpEdge.setFacebookRuleMode !== 'function';
    if (fields.facebookRuleModeToggle) {
      fields.facebookRuleModeToggle.checked = enabled;
      fields.facebookRuleModeToggle.indeterminate = false;
      fields.facebookRuleModeToggle.disabled = Boolean(pending) || writerUnavailable;
    }
    if (fields.facebookRuleModeBadge) {
      fields.facebookRuleModeBadge.textContent = pending
        ? (enabled ? '规则模式 · 正在开启…' : '规则模式 · 正在关闭…')
        : (enabled ? '规则模式 · 配置已开启' : '规则模式 · 配置已关闭');
      fields.facebookRuleModeBadge.className = pending
        ? 'acct-age rule-mode-badge is-pending'
        : `acct-age rule-mode-badge${enabled ? ' is-enabled' : ''}`;
    }
    if (fields.facebookRuleModeReason) {
      const error = feedback && feedback.kind === 'error' ? String(feedback.message || '') : '';
      const text = pending
        ? '正在等待 Cloud 确认，请稍候'
        : error || (writerUnavailable ? '当前客户端无法修改规则模式配置' : '');
      fields.facebookRuleModeReason.textContent = text;
      fields.facebookRuleModeReason.className = text
        ? `parking-hint${error || writerUnavailable ? ' is-error' : ' slow-start-feedback'}`
        : 'parking-hint hidden';
    }
    return;
  }
  if (http && http.kind === 'error') {
    renderFacebookRuleModeUnknown(http.message || '暂时无法读取规则模式配置，请稍后重试', true);
    return;
  }
  void ensureFacebookRuleModeHttpFetch(context.envKey);
  renderFacebookRuleModeUnknown('正在读取规则模式配置…');
}

function hideFacebookConsumptionModeRow() {
  if (!fields.facebookConsumptionModeRow) return;
  fields.facebookConsumptionModeRow.classList.add('hidden');
  fields.facebookConsumptionModeRow.classList.remove('is-pending');
  fields.facebookConsumptionModeRow.removeAttribute('aria-busy');
  if (fields.facebookConsumptionModeToggle) {
    fields.facebookConsumptionModeToggle.checked = false;
    fields.facebookConsumptionModeToggle.indeterminate = false;
  }
}

function setLegacyOperationModeUnknown(message, error = false) {
  const context = selectedFacebookOperationPolicyContext();
  const slowStartHttp = context && slowStartHttpByEnv.get(context.envKey);
  if (context && slowStartHttp?.kind === 'ok') {
    applySlowStartView(
      window.uiLogic.slowStartLine({ slowStart: slowStartHttp.slowStart }, 'offline', 'http'),
      context,
    );
  }
  const rows = [
    {
      mode: 'persona',
      row: fields.facebookPersonaModeRow,
      toggle: fields.facebookPersonaModeToggle,
      badge: fields.facebookPersonaModeBadge,
      reason: fields.facebookPersonaModeReason,
      badgeClass: 'acct-age rule-mode-badge',
    },
    {
      mode: 'slow_start',
      row: fields.slowStartRow,
      toggle: fields.slowStartToggle,
      badge: fields.slowStartBadge,
      reason: fields.slowStartReason,
      badgeClass: 'acct-age',
    },
    {
      mode: 'rule',
      row: fields.facebookRuleModeRow,
      toggle: fields.facebookRuleModeToggle,
      badge: fields.facebookRuleModeBadge,
      reason: fields.facebookRuleModeReason,
      badgeClass: 'acct-age rule-mode-badge',
    },
    {
      mode: 'consumption',
      row: fields.facebookConsumptionModeRow,
      toggle: fields.facebookConsumptionModeToggle,
      badge: fields.facebookConsumptionModeBadge,
      reason: fields.facebookConsumptionModeReason,
      badgeClass: 'acct-age rule-mode-badge consumption-mode-badge',
    },
  ];
  for (const item of rows) {
    if (!item.row) continue;
    const preserveSlowStartDetail = item.mode === 'slow_start'
      && slowStartHttp?.kind === 'ok';
    item.row.classList.remove('hidden', 'is-pending');
    item.row.removeAttribute('aria-busy');
    if (item.toggle) {
      if (!preserveSlowStartDetail) {
        item.toggle.checked = false;
        item.toggle.indeterminate = true;
      }
      item.toggle.disabled = true;
    }
    if (item.badge && !preserveSlowStartDetail) {
      item.badge.textContent = '';
      item.badge.className = `${item.badgeClass} hidden`;
    }
    if (item.reason) {
      const detailReason = preserveSlowStartDetail
        ? String(item.reason.textContent || '').trim()
        : '';
      item.reason.textContent = error && detailReason
        ? `${detailReason} · ${message}`
        : detailReason || message;
      item.reason.className = `parking-hint${error ? ' is-error' : ''}`;
    }
  }
}

function operationModeBadgeText({ mode, selectedMode, config, pending }) {
  const label = mode === 'persona'
    ? '普通人设'
    : mode === 'slow_start'
      ? '冷启动'
      : mode === 'rule'
        ? '规则模式'
        : '消费模式';
  if (pending && pending.mode === mode) return `${label} · 等待 Cloud 确认…`;
  if (selectedMode === mode) return `${label} · ${pending ? '当前已选择' : '已选择'}`;
  if (mode !== 'slow_start' && selectedMode === 'slow_start' && config.baseMode === mode) {
    return `${label} · 冷启动优先（暂停）`;
  }
  return `${label} · 未选择`;
}

function applyLegacyFacebookOperationPolicyView(config, context) {
  const feedback = facebookOperationPolicyFeedbackByEnv.get(context.envKey);
  const pending = feedback && feedback.kind === 'pending' ? feedback : null;
  // radio 的 change 事件触发前浏览器会先切换 DOM；这里始终用最后一份 Cloud 确认真态把它恢复。
  // 目标模式只进入 pending 文案，绝不在写后回读前成为选中态。
  const selectedMode = selectedModeFromFacebookOperationPolicy(config);
  const writerUnavailable = !window.aidcpEdge
    || typeof window.aidcpEdge.setFacebookOperationPolicy !== 'function';
  const slowStartHttp = slowStartHttpByEnv.get(context.envKey);
  const slowStartDetailAvailable = slowStartHttp?.kind === 'ok';
  const slowStartDetailMatchesPolicy = slowStartDetailAvailable
    && slowStartHttp.slowStart?.state === config.slowStart.state;
  const slowStartDetailView = slowStartDetailAvailable
    ? window.uiLogic.slowStartLine({ slowStart: slowStartHttp.slowStart }, 'offline', 'http')
    : null;
  if (slowStartDetailView) applySlowStartView(slowStartDetailView, context);
  const rowItems = [
    {
      mode: 'persona',
      row: fields.facebookPersonaModeRow,
      toggle: fields.facebookPersonaModeToggle,
      badge: fields.facebookPersonaModeBadge,
      reason: fields.facebookPersonaModeReason,
      badgeClass: 'acct-age rule-mode-badge',
    },
    {
      mode: 'slow_start',
      row: fields.slowStartRow,
      toggle: fields.slowStartToggle,
      badge: fields.slowStartBadge,
      reason: fields.slowStartReason,
      badgeClass: 'acct-age',
    },
    {
      mode: 'rule',
      row: fields.facebookRuleModeRow,
      toggle: fields.facebookRuleModeToggle,
      badge: fields.facebookRuleModeBadge,
      reason: fields.facebookRuleModeReason,
      badgeClass: 'acct-age rule-mode-badge',
    },
    {
      mode: 'consumption',
      row: fields.facebookConsumptionModeRow,
      toggle: fields.facebookConsumptionModeToggle,
      badge: fields.facebookConsumptionModeBadge,
      reason: fields.facebookConsumptionModeReason,
      badgeClass: 'acct-age rule-mode-badge consumption-mode-badge',
    },
  ];

  for (const item of rowItems) {
    if (!item.row) continue;
    const isSlowStart = item.mode === 'slow_start';
    // renderSlowStart 已先根据详细 Cloud 回包计算资格闸；统一模式层只负责互斥选择，
    // 不能把 platform_unsupported 等真实禁用条件重新放开。
    const slowStartSafetyDisabled = isSlowStart
      && (!slowStartDetailView || Boolean(slowStartDetailView.disabled));
    item.row.classList.remove('hidden');
    item.row.classList.toggle('is-pending', Boolean(pending));
    if (pending) item.row.setAttribute('aria-busy', 'true');
    else item.row.removeAttribute('aria-busy');
    if (item.toggle) {
      item.toggle.checked = selectedMode === item.mode;
      item.toggle.indeterminate = false;
      item.toggle.disabled = Boolean(pending) || writerUnavailable || slowStartSafetyDisabled;
    }

    // operation policy 决定互斥选择；状态一致时保留慢启动详情读的“第几天/已毕业/资格”等丰富真态。
    const preserveSlowStartBadge = isSlowStart
      && !pending
      && slowStartDetailMatchesPolicy;
    if (item.badge && !preserveSlowStartBadge) {
      const enabled = selectedMode === item.mode;
      const pendingTarget = Boolean(pending && pending.mode === item.mode);
      item.badge.textContent = operationModeBadgeText({
        mode: item.mode,
        selectedMode,
        config,
        pending,
      });
      item.badge.className = pendingTarget
        ? `${item.badgeClass} is-pending`
        : `${item.badgeClass}${enabled ? ' is-enabled' : ''}`;
    }

    const writeError = feedback && feedback.kind === 'error'
      ? String(feedback.message || '')
      : '';
    const preserveSlowStartReason = preserveSlowStartBadge
      && !writeError
      && !config.blocker
      && !writerUnavailable;
    if (item.reason && !preserveSlowStartReason) {
      const paused = item.mode !== 'slow_start'
        && selectedMode === 'slow_start'
        && config.baseMode === item.mode
        ? `冷启动当前优先，${
          item.mode === 'persona' ? '普通人设' : item.mode === 'rule' ? '规则' : '消费'
        }基础模式暂停`
        : '';
      const text = pending
        ? (pending.mode === item.mode ? '正在等待 Cloud 回读确认，请稍候' : '')
        : writeError || config.blocker || paused
          || (writerUnavailable ? '当前客户端无法修改运行方式' : '');
      item.reason.textContent = text;
      item.reason.className = text
        ? `parking-hint${writeError || config.blocker || writerUnavailable ? ' is-error' : ' slow-start-feedback'}`
        : 'parking-hint hidden';
    }
  }
}

function hideLegacyFacebookOperationModeRows() {
  hideFacebookPersonaModeRow();
  hideFacebookRuleModeRow();
  hideFacebookConsumptionModeRow();
  fields.slowStartToggleWrap?.classList.add('hidden');
}

function setOperationModeUnknown(message, error = false) {
  hideLegacyFacebookOperationModeRows();
  const context = selectedFacebookOperationPolicyContext();
  fields.facebookOperationPolicyRow?.classList.toggle('hidden', !context);
  fields.facebookOperationPolicyRow?.classList.remove('is-pending');
  fields.facebookOperationPolicyRow?.removeAttribute('aria-busy');
  if (fields.facebookOperationModeSelect) fields.facebookOperationModeSelect.disabled = true;
  if (fields.facebookPrimarySurfaceSelect) fields.facebookPrimarySurfaceSelect.disabled = true;
  if (fields.facebookOperationPolicyStatus) {
    fields.facebookOperationPolicyStatus.textContent = context ? message : '';
    fields.facebookOperationPolicyStatus.className = context
      ? `parking-hint${error ? ' is-error' : ''}`
      : 'parking-hint hidden';
  }
}

function applyFacebookOperationPolicyView(config, context) {
  hideLegacyFacebookOperationModeRows();
  const feedback = facebookOperationPolicyFeedbackByEnv.get(context.envKey);
  const pending = feedback?.kind === 'pending' ? feedback : null;
  const error = feedback?.kind === 'error' ? String(feedback.message || '') : '';
  const modeUnavailable = !window.aidcpEdge
    || typeof window.aidcpEdge.setFacebookOperationPolicy !== 'function';
  const surfaceUnavailable = !window.aidcpEdge
    || typeof window.aidcpEdge.setFacebookPrimarySurface !== 'function';
  const selectedMode = selectedModeFromFacebookOperationPolicy(config);

  fields.facebookOperationPolicyRow?.classList.remove('hidden');
  fields.facebookOperationPolicyRow?.classList.toggle('is-pending', Boolean(pending));
  if (pending) fields.facebookOperationPolicyRow?.setAttribute('aria-busy', 'true');
  else fields.facebookOperationPolicyRow?.removeAttribute('aria-busy');
  if (fields.facebookOperationModeSelect) {
    fields.facebookOperationModeSelect.value = selectedMode;
    fields.facebookOperationModeSelect.disabled = Boolean(pending) || modeUnavailable;
  }
  if (fields.facebookPrimarySurfaceSelect) {
    fields.facebookPrimarySurfaceSelect.value = config.primarySurface;
    fields.facebookPrimarySurfaceSelect.disabled = Boolean(pending) || surfaceUnavailable;
  }
  if (fields.facebookOperationPolicyStatus) {
    const text = pending
      ? '正在等待 Cloud 回读确认…'
      : error || config.blocker
        || (modeUnavailable || surfaceUnavailable ? '当前客户端无法修改运行方式或主浏览入口' : '');
    fields.facebookOperationPolicyStatus.textContent = text;
    fields.facebookOperationPolicyStatus.className = text
      ? `parking-hint${error || config.blocker || modeUnavailable || surfaceUnavailable ? ' is-error' : ''}`
      : 'parking-hint hidden';
  }
}

function renderFacebookOperationPolicy() {
  const context = selectedFacebookOperationPolicyContext();
  if (!context) {
    hideLegacyFacebookOperationModeRows();
    fields.facebookOperationPolicyRow?.classList.add('hidden');
    return;
  }
  if (!window.aidcpEdge
      || typeof window.aidcpEdge.getFacebookOperationPolicy !== 'function') {
    setOperationModeUnknown('请登录客户端后读取 Cloud 运行方式');
    return;
  }
  const http = facebookOperationPolicyHttpByEnv.get(context.envKey);
  if (http && http.kind === 'ok') {
    applyFacebookOperationPolicyView(http.config, context);
    return;
  }
  if (http && http.kind === 'error') {
    setOperationModeUnknown(http.message || '暂时无法读取运行方式，请稍后重试', true);
    return;
  }
  void ensureFacebookOperationPolicyHttpFetch(context.envKey);
  setOperationModeUnknown('正在读取 Cloud 运行方式…');
}

// ─── 开发者详情：原始日志（滚动保留 + 连续去重；按 envId 分桶，绝不跨环境串号/相邻误吞）───
function logBucket(envKey) {
  let b = fleetView.logs.get(envKey);
  if (!b) { b = { entries: [], last: '' }; fleetView.logs.set(envKey, b); }
  return b;
}

// 记录某环境一行原始日志（供所有环境调用，含未选中环境；只有选中环境时才刷 DOM）。
function recordLog(envKey, message) {
  if (!message) return;
  const b = logBucket(envKey);
  if (message === b.last) return; // 连续去重按本环境桶判，绝不因别环境的相同末行而误吞
  b.last = message;
  const now = Date.now();
  b.entries.push({ time: now, message });
  const cutoff = now - LOG_RETENTION_MS;
  while (b.entries.length > 0 && b.entries[0].time < cutoff) b.entries.shift();
  if (envKey === routeSelKey()) renderLog();
}

function renderLog() {
  const b = fleetView.logs.get(routeSelKey());
  fields.lastMessage.innerHTML = (b ? b.entries : []).map((entry) => {
    const time = new Date(entry.time).toLocaleTimeString();
    return `<div class="log-entry"><span class="log-time">${time}</span> ${escapeHtml(entry.message)}</div>`;
  }).join('');
  fields.lastMessage.scrollTop = fields.lastMessage.scrollHeight;
}

const COMMAND_DIAGNOSTIC_RETENTION_MS = 30 * 60 * 1000;
const COMMAND_DIAGNOSTIC_STAGES = {
  received: '已收到',
  rejected: '已拒绝',
  dispatched: '已交给执行器',
  completed: '步骤已完成',
  failed: '步骤失败',
};
const COMMAND_DIAGNOSTIC_REASONS = {
  operation_unclassified: '未登记的命令',
  capability_not_negotiated: '能力未协商',
  extension_not_negotiated: '扩展能力未协商',
  payload_invalid: '命令载荷不合法',
  handler_unavailable: '本地处理器不可用',
  step_failed: '至少一个步骤失败',
};
const COMMAND_DIAGNOSTIC_LABELS = {
  'plan.response': '顺序步骤',
  'session.end': '结束浏览',
  'browse.next': '浏览下一条',
  'browse.scroll': '页面滚动',
  'note.open': '打开内容',
  'note.close': '关闭内容',
  'search.execute': '关键词搜索',
  'page.scroll': '页面滚动',
  'feed.refresh': '刷新信息流',
  'pacing.update': '更新节奏',
  'interaction.like': '点赞',
  'interaction.collect': '收藏',
  'interaction.follow': '关注',
  'interaction.comment': '评论',
  'interaction.like_comment': '评论点赞',
  'group.join': '群组加入',
  'publish.request': '发布请求',
  'publish.command': '发布步骤',
  'edge.task.acquire': '申请写租约',
  'edge.task.release': '释放写租约',
  'captcha.assist.capture': '验证码采集',
  'captcha.assist.click': '验证码协助',
  'interaction.reply.send': '发送互动回复',
};

function safeCommandDiagnostics(status, now) {
  const entries = Array.isArray(status && status.commandDiagnostics) ? status.commandDiagnostics : [];
  return entries.filter((entry) => entry && typeof entry === 'object'
    && typeof entry.key === 'string' && /^[a-f0-9]{8}$/.test(entry.key)
    && typeof entry.type === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(entry.type)
    && Object.prototype.hasOwnProperty.call(COMMAND_DIAGNOSTIC_STAGES, entry.stage)
    && typeof entry.summary === 'string' && entry.summary.length > 0 && entry.summary.length <= 160
    && !/[\r\n]/.test(entry.summary)
    && Number.isFinite(entry.updatedAt)
    && entry.updatedAt >= now - COMMAND_DIAGNOSTIC_RETENTION_MS
    && entry.updatedAt <= now + 60_000)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50);
}

function renderCommandDiagnostics(status, now = Date.now()) {
  if (!fields.commandDiagnosticList) return;
  const entries = safeCommandDiagnostics(status, now);
  if (entries.length === 0) {
    fields.commandDiagnosticList.innerHTML = '<p id="command-diagnostic-empty" class="command-diagnostic-empty">当前环境暂无引擎命令</p>';
    fields.commandDiagnosticEmpty = fields.commandDiagnosticList.querySelector('#command-diagnostic-empty');
    return;
  }
  fields.commandDiagnosticList.innerHTML = entries.map((entry) => {
    const reelsEntry = entry.type === 'page.scroll'
      && (entry.summary === '进入 Reels 主浏览' || entry.summary === '信息流结束，进入 Reels');
    const label = reelsEntry ? '进入 Reels' : (COMMAND_DIAGNOSTIC_LABELS[entry.type] || entry.type);
    const stage = COMMAND_DIAGNOSTIC_STAGES[entry.stage];
    const reason = typeof entry.reason === 'string' ? COMMAND_DIAGNOSTIC_REASONS[entry.reason] : '';
    const detail = reason ? `${entry.summary} · ${reason}` : entry.summary;
    const time = new Date(entry.updatedAt).toLocaleTimeString();
    return `<article class="command-diagnostic-item" role="listitem" data-command-key="${escapeHtml(entry.key)}" data-command-stage="${escapeHtml(entry.stage)}">
      <div class="command-diagnostic-row"><strong>${escapeHtml(label)}</strong><span class="command-diagnostic-stage ${escapeHtml(entry.stage)}">${escapeHtml(stage)}</span><time>${escapeHtml(time)}</time></div>
      <p>${escapeHtml(detail)}</p>
      <code>${escapeHtml(entry.type)} · #${escapeHtml(entry.key)}</code>
    </article>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── 用户委托任务：当前选中环境快捷入口 + 结构化确认 + 真实进度 ───
const DELEGATED_ACTION_LABELS = {
  comment_batch: '完成有效评论',
  comment_curated: '评论指定精选内容',
  facebook_group_comment: 'Facebook 群组评论',
  publish_post: '发布一篇稿件',
  publish_from_inspiration: '参考今日灵感发布',
  generate_candidates: '生成候选稿（不发布）',
  approve_candidate: '批准候选稿',
  reject_candidate: '驳回候选稿',
  modify_candidate: '修改候选稿',
};
const DELEGATED_STATUS_LABELS = {
  draft: '草稿', awaiting_confirmation: '待确认', queued: '已排队', planning: '规划中',
  waiting_approval: '等待人审', executing: '执行中', partially_completed: '部分完成', completed: '已完成',
  deferred: '已推迟', cancelled: '已取消', failed: '失败',
};
let pendingDelegatedTask = null;
let pendingDelegatedEnvId = null;
let delegatedLoading = false;
let delegatedPopoverOpen = false;
let delegatedActiveCount = 0;
const DELEGATED_TERMINAL_STATUSES = new Set(['completed', 'partially_completed', 'cancelled', 'failed']);

function syncDelegatedTriggerLabel() {
  if (!fields.delegatedTrigger) return;
  const action = delegatedPopoverOpen ? '关闭' : '打开';
  const active = delegatedActiveCount > 0 ? `，${delegatedActiveCount} 个未结束任务` : '';
  fields.delegatedTrigger.setAttribute('aria-label', `${action}委派任务${active}`);
}

function syncDelegatedTriggerTasks(tasks) {
  delegatedActiveCount = Array.isArray(tasks)
    ? tasks.filter((task) => task && !DELEGATED_TERMINAL_STATUSES.has(String(task.status || ''))).length
    : 0;
  fields.delegatedIndicator?.classList.toggle('hidden', delegatedActiveCount === 0);
  syncDelegatedTriggerLabel();
}

function setDelegatedPopoverOpen(open, restoreFocus = false) {
  if (!fields.delegatedCard || !fields.delegatedTrigger) return;
  delegatedPopoverOpen = Boolean(open);
  fields.delegatedCard.classList.toggle('hidden', !delegatedPopoverOpen);
  fields.delegatedCard.setAttribute('aria-hidden', delegatedPopoverOpen ? 'false' : 'true');
  fields.delegatedTrigger.setAttribute('aria-expanded', delegatedPopoverOpen ? 'true' : 'false');
  syncDelegatedTriggerLabel();
  if (delegatedPopoverOpen) {
    fields.delegatedClose?.focus();
    void refreshDelegatedTasks(false);
  } else if (restoreFocus) {
    fields.delegatedTrigger.focus();
  }
}

function closeDelegatedPopover(restoreFocus = false) {
  setDelegatedPopoverOpen(false, restoreFocus);
}

function setDelegatedMessage(text, error = false) {
  if (!fields.delegatedMessage) return;
  fields.delegatedMessage.textContent = text || '';
  fields.delegatedMessage.classList.toggle('error', Boolean(error));
}

function delegatedErrorText(result) {
  const code = result && result.error;
  if (code === 'client_session_required' || code === 'client_session_expired') return '请先登录客户账号后使用委托任务。';
  if (code === 'selected_environment_required') return '请先选择一个指纹浏览器环境。';
  if (code === 'environment_not_owned') return '当前环境不属于已登录客户，不能创建任务。';
  return code ? `任务请求未完成：${code}` : '任务请求未完成，请稍后重试。';
}

function renderDelegatedTasks(tasks) {
  if (!fields.delegatedList) return;
  syncDelegatedTriggerTasks(tasks);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    fields.delegatedList.innerHTML = '<span class="delegated-empty">当前环境暂无委托任务</span>';
    return;
  }
  fields.delegatedList.replaceChildren();
  tasks.slice(0, 8).forEach((task) => {
    const row = document.createElement('div');
    row.className = 'delegated-task';
    const status = String(task.status || '');
    const progress = task.progress || {};
    const top = document.createElement('div');
    top.className = 'delegated-task-top';
    const title = document.createElement('strong');
    title.textContent = DELEGATED_ACTION_LABELS[task.action] || task.action || '委托任务';
    const badge = document.createElement('span');
    badge.className = `delegated-task-status ${status}`;
    badge.textContent = DELEGATED_STATUS_LABELS[status] || status;
    top.append(title, badge);
    row.appendChild(top);
    appendPreviewText(
      row,
      `成功 ${progress.successCount || 0}/${task.targetSuccessCount || 0} · 尝试 ${progress.attemptCount || 0}/${task.maxAttempts || 0} · 跳过 ${progress.skippedCount || 0} · 失败 ${progress.failureCount || 0}`,
      'delegated-task-progress',
    );
    if (task.terminalOutcome && task.terminalOutcome.message) {
      appendPreviewText(row, task.terminalOutcome.message, 'delegated-task-reason');
    }
    const terminal = DELEGATED_TERMINAL_STATUSES.has(status);
    if (!terminal) {
      const controls = document.createElement('div');
      controls.className = 'delegated-task-controls';
      const addControl = (action, label) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', () => { void controlDelegatedTask(task, action); });
        controls.appendChild(btn);
      };
      if (status === 'deferred') addControl('resume', '继续');
      else if (status !== 'awaiting_confirmation') addControl('pause', '完成当前安全动作后暂停');
      addControl('cancel', '取消未执行部分');
      row.appendChild(controls);
    }
    fields.delegatedList.appendChild(row);
  });
}

async function refreshDelegatedTasks(silent = false, envId = currentEnvId()) {
  if (!fields.delegatedList || !envId || delegatedLoading || typeof window.aidcpEdge.delegatedTaskList !== 'function') return;
  delegatedLoading = true;
  if (!silent) setDelegatedMessage('正在刷新任务…');
  try {
    const result = await window.aidcpEdge.delegatedTaskList(envId);
    if (!result || !result.ok) {
      if (!silent) setDelegatedMessage(delegatedErrorText(result), true);
      return;
    }
    if (envId !== currentEnvId()) return;
    renderDelegatedTasks(result.data && result.data.tasks);
    if (!silent) setDelegatedMessage('已刷新当前环境的真实任务状态。');
  } finally {
    delegatedLoading = false;
  }
}

function showDelegatedConfirmation(receipt, envId) {
  if (!receipt || !receipt.task || !receipt.confirmation || !fields.delegatedConfirm) return;
  if (fields.delegatedConfirm.open) fields.delegatedConfirm.close('replace');
  pendingDelegatedTask = receipt.task;
  pendingDelegatedEnvId = envId;
  const c = receipt.confirmation;
  fields.delegatedConfirmTitle.textContent = c.title || '请确认用户委托任务';
  const facts = [
    ['账号', c.accountName], ['平台', `${c.platformLabel}${c.capability === 'beta' ? '（Beta）' : ''}`],
    ['动作', c.actionLabel], ['成功目标', c.target], ['尝试上限', c.attempts],
    ['执行窗口', c.schedule], ['人审', c.approval], ['优先级', c.priority], ['任务编号', receipt.task.id],
  ];
  fields.delegatedConfirmFacts.replaceChildren();
  facts.forEach(([label, value]) => {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value || '—';
    fields.delegatedConfirmFacts.append(dt, dd);
  });
  fields.delegatedConfirmBoundary.textContent = c.capabilityReason ? `Beta 边界：${c.capabilityReason}` : '';
  fields.delegatedConfirmBoundary.classList.toggle('hidden', !c.capabilityReason);
  fields.delegatedConfirm.showModal();
}

async function draftDelegatedTask(action, targetConstraints = {}, opts = {}) {
  const envId = opts.envId || currentEnvId();
  if (!envId || typeof window.aidcpEdge.delegatedTaskDraft !== 'function') {
    setDelegatedMessage('请先选择一个环境。', true);
    return false;
  }
  if (action === 'publish_from_inspiration' && selectedEnvPlatform() === 'facebook') {
    setDelegatedMessage('Facebook Beta 尚未开放“参考今日灵感发稿”；需先完成平台化模板、语言和素材策略。', true);
    return false;
  }
  const countInput = Number(fields.delegatedCount && fields.delegatedCount.value);
  const target = opts.targetSuccessCount || (action === 'comment_batch' || action === 'generate_candidates'
    ? Math.max(1, Math.min(20, Number.isInteger(countInput) ? countInput : 1))
    : 1);
  const scheduleMode = (fields.delegatedSchedule && fields.delegatedSchedule.value) || 'immediate';
  const payload = {
    action,
    targetSuccessCount: target,
    maxAttempts: opts.maxAttempts || (action === 'comment_batch' ? Math.max(target, target * 2) : action === 'generate_candidates' ? target : 2),
    deadlineAt: Date.now() + 24 * 60 * 60 * 1000,
    executionWindow: { mode: scheduleMode },
    sourceConstraints: opts.sourceConstraints || {},
    targetConstraints,
    approvalMode: action === 'generate_candidates' ? 'draft_only' : 'review',
    priority: fields.delegatedPriority && fields.delegatedPriority.checked ? 'high' : 'normal',
    sourceRef: `edge:${envId}:${action}:${Math.floor(Date.now() / 60000)}`,
  };
  setDelegatedMessage('正在提交…');
  const result = await window.aidcpEdge.delegatedTaskDraft(envId, payload);
  if (!result || !result.ok) {
    setDelegatedMessage(delegatedErrorText(result), true);
    return false;
  }
  // 结构化精确入口（edge 快捷入口）无可推断歧义 → 云端直接确认入队，不再出「请确认用户委托任务」卡；
  // 结果由飞书结果卡按真实验证结果回报。仅当云端仍回未确认态（自然语言路径，edge 不会命中）才展示确认卡。
  const task = result.data && result.data.task;
  if (result.data && (result.data.autoQueued || (task && task.status && task.status !== 'awaiting_confirmation'))) {
    pendingDelegatedTask = null;
    const shortId = task && task.id ? String(task.id).slice(0, 8) : '—';
    setDelegatedMessage(`已排队（任务 ${shortId}…）；只按真实验证结果计数，非平台成功回执。`);
    void refreshDelegatedTasks(true, envId);
    return true;
  }
  showDelegatedConfirmation(result.data, envId);
  setDelegatedMessage('任务尚未执行，请核对确认卡。');
  return true;
}

async function controlDelegatedTask(task, action) {
  const envId = currentEnvId();
  if (!envId || typeof window.aidcpEdge.delegatedTaskAction !== 'function') return;
  setDelegatedMessage('正在更新任务…');
  const result = await window.aidcpEdge.delegatedTaskAction(envId, task.id, action, task.version);
  if (!result || !result.ok) {
    setDelegatedMessage(delegatedErrorText(result), true);
    return;
  }
  setDelegatedMessage(action === 'pause' ? '已请求在当前安全动作结束后暂停。' : action === 'cancel' ? '已取消尚未执行的剩余部分。' : '任务已继续排队。');
  await refreshDelegatedTasks(true, envId);
}

fields.delegatedActionButtons.forEach((button) => button.addEventListener('click', () => {
  void draftDelegatedTask(button.dataset.delegatedAction);
}));
fields.delegatedTrigger?.addEventListener('click', () => {
  setDelegatedPopoverOpen(!delegatedPopoverOpen, delegatedPopoverOpen);
});
fields.delegatedClose?.addEventListener('click', () => { closeDelegatedPopover(true); });
fields.delegatedRefresh?.addEventListener('click', () => { void refreshDelegatedTasks(false); });
document.addEventListener('click', (event) => {
  if (!delegatedPopoverOpen || fields.delegatedConfirm?.open) return;
  const target = event.target;
  if (fields.delegatedTrigger?.contains(target) || fields.delegatedCard?.contains(target)) return;
  closeDelegatedPopover(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !delegatedPopoverOpen || fields.delegatedConfirm?.open) return;
  event.preventDefault();
  closeDelegatedPopover(true);
});
fields.delegatedConfirmSubmit?.addEventListener('click', async () => {
  if (!pendingDelegatedTask || !pendingDelegatedEnvId || fields.delegatedConfirmSubmit.disabled) return;
  fields.delegatedConfirmSubmit.disabled = true;
  const result = await window.aidcpEdge.delegatedTaskAction(
    pendingDelegatedEnvId,
    pendingDelegatedTask.id,
    'confirm',
    pendingDelegatedTask.version,
  );
  fields.delegatedConfirmSubmit.disabled = false;
  if (!result || !result.ok) {
    setDelegatedMessage(delegatedErrorText(result), true);
    return;
  }
  const envId = pendingDelegatedEnvId;
  fields.delegatedConfirm.close();
  pendingDelegatedTask = null;
  pendingDelegatedEnvId = null;
  setDelegatedMessage('任务已确认并排队；后续只按真实验证结果计数。');
  await refreshDelegatedTasks(true, envId);
});
fields.delegatedConfirm?.addEventListener('close', () => {
  if (fields.delegatedConfirm.returnValue === 'cancel') {
    pendingDelegatedTask = null;
    pendingDelegatedEnvId = null;
  }
});

// 当前选中环境的平台（fleet 环境优先，回落 settings 平台）——顶栏/登录提示/人设浮层共用。
function selectedEnvPlatform() {
  const env = fleetView.envs.get(fleetView.selected);
  return normPlatform((env && env.platform) || selectedPlatform);
}

function personaAppliesToEnvironment(env) {
  if (!env) return true;
  if (env.status && env.status.personaApplicable === false) return false;
  return normPlatform(env.platform) !== 'wechat_channels';
}

function syncDelegatedActionAvailability() {
  const facebook = selectedEnvPlatform() === 'facebook';
  fields.delegatedActionButtons.forEach((button) => {
    const blocked = facebook && button.dataset.delegatedAction === 'publish_from_inspiration';
    button.disabled = blocked;
    button.title = blocked ? 'Facebook Beta 尚未完成平台化创作模板、语言和素材策略' : '';
  });
}

// ─── 阻塞动作主动步骤（需登录 / 待配置）───
function renderNotice(status) {
  let title = '';
  let body = '';
  let action = false;
  if (status.auth === 'login required') {
    title = '需要登录';
    body = selectedEnvPlatform() === 'facebook'
      ? '请在打开的浏览器窗口中登录 facebook.com，检测到登录后会自动继续。'
      : '请在刚打开的 Chrome 窗口中登录 xiaohongshu.com，检测到登录后会自动继续。';
  } else if (status.auth === 'config required') {
    title = '先完成一次设置';
    body = '选择一个浏览器环境（或手动填写分身 ID），之后就不用再管了。';
    action = true;
  }
  const show = Boolean(title);
  fields.loginGuide.classList.toggle('hidden', !show);
  if (show) {
    fields.noticeTitle.textContent = title;
    fields.noticeBody.textContent = body;
    fields.noticeAction.classList.toggle('hidden', !action);
  }
}

function failureSummary(status) {
  const summary = status && status.edgeFailure && status.edgeFailure.summary;
  return typeof summary === 'string' ? summary.trim() : '';
}

function renderEdgeFailure(status) {
  const summary = failureSummary(status);
  const show = Boolean(summary) && (status.edge === 'warning' || status.auth === 'chrome missing');
  fields.edgeFailure.classList.toggle('hidden', !show);
  fields.edgeFailureText.textContent = show ? summary : '';
}

// ─── 标题带：账号身份 + 平台标识（随选中环境）+ 健康合成 + 风控染色 ───
function renderTitlebar(status) {
  const plat = selectedEnvPlatform();
  const fb = plat === 'facebook';
  const wechat = plat === 'wechat_channels';
  const acct = status && status.account;
  const selected = fleetView.envs.get(fleetView.selected);
  const display = resolveEnvironmentDisplayName(selected, status);
  const nick = (display.name || '').replace(/^@/, '');
  // 解析器的环境尾号只在连账号 ID 也未知时兜底；账号 ID 已知则保留标题栏既有「账号 …尾4位」语义。
  const titleName = display.source === 'fallback' && acct && acct.id ? '' : nick;
  if (titleName || (acct && acct.id)) {
    // 只有真实平台昵称带 @；人工昵称与 AdsPower 环境名都只是客户端环境显示名，不冒充平台身份。
    const isPlatNick = titleName && display.source === 'platform';
    fields.acctName.textContent = titleName ? (isPlatNick ? `@${titleName}` : titleName) : `账号 …${String(acct.id).slice(-4)}`;
    fields.acctAva.textContent = titleName ? titleName.slice(0, 1) : (fb ? 'f' : wechat ? '视' : '书');
  } else {
    // 无账号信息时按平台给默认身份占位（此前写死小红书，FB 环境也顶着「书」——问题 3）。
    fields.acctAva.textContent = fb ? 'f' : wechat ? '视' : '书';
    fields.acctName.textContent = fb ? 'Facebook 账号' : wechat ? '视频号账号' : '小红书账号';
  }
  fields.acctAva.classList.toggle('plat-facebook', fb);
  fields.acctAva.classList.toggle('plat-wechat', wechat);
  if (fields.acctPlat) {
    fields.acctPlat.textContent = platformLabel(plat);
    fields.acctPlat.classList.toggle('plat-facebook', fb);
    fields.acctPlat.classList.toggle('plat-wechat', wechat);
  }
  if (fields.authLabel) fields.authLabel.textContent = '客户会话';
  renderProxyRuntime(status, fb);
  const health = uiLogic.synthesizeHealth(status);
  fields.healthLabel.textContent = health.label;
  fields.healthPill.className = `health-pill nodrag ${health.code}`;
  fields.healthDetail.textContent = failureSummary(status) || health.detail || '';
  fields.titlebar.className = `titlebar tone-${uiLogic.bandTone(status)}`;
}

function selectedProxyConfiguration(status) {
  const selected = fleetView.envs.get(fleetView.selected);
  const profileId = String((selected && (selected.profileId || selected.envId)) || '').trim();
  const profile = lastProfiles.find((item) => item && String(item.userId) === profileId);
  const chained = status && status.proxyMode === 'system_then_environment';
  if (!profile) return { known: false, summary: chained ? '系统代理 → 环境代理（配置待读取）' : '配置待读取' };
  const config = profile.proxyConfig || {};
  const directSummary = profile.proxy || (config.noProxy ? '无代理配置' : '代理配置已保存');
  return {
    known: true,
    noProxy: config.noProxy === true,
    summary: chained ? `系统代理 → ${directSummary}` : directSummary,
  };
}

function renderProxyRuntime(status, facebook) {
  if (!fields.proxyRuntimeChip || !fields.proxyRuntimePop) return;
  fields.proxyRuntimeChip.classList.toggle('hidden', !facebook);
  if (!facebook) {
    fields.proxyRuntimePop.classList.add('hidden');
    fields.proxyRuntimePop.setAttribute('aria-hidden', 'true');
    fields.proxyRuntimeChip.setAttribute('aria-expanded', 'false');
    return;
  }
  const view = uiLogic.proxyRuntimeView(
    status && status.proxyRuntime,
    selectedProxyConfiguration(status),
    status && status.proxyPreflight,
  );
  fields.proxyRuntimeChip.className = `proxy-runtime-chip nodrag ${view.tone}`;
  fields.proxyRuntimeLabel.textContent = view.compact;
  fields.proxyRuntimeChip.title = `${view.label}；本次会话接收流量 ${view.bytes}`;
  fields.proxyRuntimeState.textContent = view.label;
  fields.proxyRuntimeConfig.textContent = view.configuration;
  fields.proxyRuntimeCheckedAt.textContent = view.checkedAt
    ? new Date(view.checkedAt).toLocaleString('zh-CN', { hour12: false })
    : '尚未检测';
  fields.proxyRuntimeBytes.textContent = view.bytes;
}

// ─── 运行价值说明：浏览目标 / 自然间隔 / 今日成果，全部来自真实在场与窗口数据。───
const RUNTIME_GUIDANCE_MASCOTS = {
  'task-execution': './assets/mascot-task-execution-512.png',
  monitoring: './assets/mascot-monitoring-512.png',
  celebration: './assets/mascot-celebration-512.png',
};
const RUNTIME_GUIDANCE_ICONS = {
  browse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9 5 5l1.8 11.7L10 13.6l2.4 5.4 3-1.3-2.4-5.4h4.4L9 9Z"/><path d="M7.2 2.2 8 5.1"/><path d="m5.1 8-2.9-.8"/><path d="M14 4.1 12 6"/><path d="m6 12-1.9 2"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5s2.5 2 5 2 2.5-2 5-2c1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2c1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2c1.3 0 1.9.5 2.5 1"/></svg>',
  match: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3H5a2 2 0 0 0-2 2v2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="11" cy="11" r="4"/><path d="m15 15 4 4"/></svg>',
  create: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  circleCheck: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.3 2.4 2.4 4.8-5.1"/></svg>',
  bookmarkCheck: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"/><path d="m9 10 2 2 4-4"/></svg>',
  sunrise: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>',
  harvest: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"/><path d="m9 10 2 2 4-4"/></svg>',
};

function renderRuntimeGuidanceProgress(progress) {
  if (!fields.runtimeGuidanceProgress) return;
  fields.runtimeGuidanceProgress.replaceChildren();
  fields.runtimeGuidanceProgress.classList.toggle('hidden', !progress);
  if (!progress) return;

  const current = Math.max(0, Number(progress.current) || 0);
  const target = Math.max(0, Number(progress.target) || 0);
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const head = document.createElement('div');
  head.className = 'rg-progress-head';
  const title = document.createElement('span');
  title.className = 'rg-progress-title';
  title.textContent = progress.title || '';
  const meta = document.createElement('span');
  meta.className = 'rg-progress-meta';
  meta.classList.toggle('has-outcome', Boolean(progress.hasOutcome));
  meta.textContent = [progress.counter, progress.meta].filter(Boolean).join(' · ');
  head.append(title, meta);

  const track = document.createElement('div');
  track.className = 'rg-progress-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', '探索进度');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(target));
  track.setAttribute('aria-valuenow', String(Math.min(current, target || current)));
  const fill = document.createElement('span');
  fill.className = 'rg-progress-fill';
  fill.style.width = `${percent}%`;
  track.append(fill);

  fields.runtimeGuidanceProgress.append(head, track);
}

function renderRuntimeGuidanceHarvest(harvest) {
  if (!fields.runtimeGuidanceHarvest) return;
  fields.runtimeGuidanceHarvest.replaceChildren();
  fields.runtimeGuidanceHarvest.classList.toggle('hidden', !harvest);
  if (!harvest) return;

  const icon = document.createElement('span');
  icon.className = 'rg-harvest-icon';
  icon.innerHTML = RUNTIME_GUIDANCE_ICONS.harvest;
  const copy = document.createElement('span');
  copy.className = 'rg-harvest-copy';
  const title = document.createElement('strong');
  title.className = 'rg-harvest-title';
  title.textContent = harvest.title || '本轮收获已保存';
  const body = document.createElement('span');
  body.className = 'rg-harvest-body';
  const count = document.createElement('b');
  count.textContent = harvest.countText || '';
  body.append(document.createTextNode('已记录 '), count);
  if (harvest.hasHeat && harvest.heatText) {
    const heat = document.createElement('b');
    heat.textContent = harvest.heatText;
    body.append(document.createTextNode(' · 来源热度 '), heat);
  } else {
    body.append(document.createTextNode('，明天继续从这里创作'));
  }
  copy.append(title, body);
  fields.runtimeGuidanceHarvest.append(icon, copy);
}

function renderRuntimeGuidance(status, nowMs) {
  const view = uiLogic.runtimeGuidanceView(status, nowMs, selectedEnvPlatform());
  if (!fields.runtimeGuidance) return view;
  if (!view) {
    fields.runtimeGuidance.className = 'runtime-guidance hidden';
    delete fields.runtimeGuidance.dataset.mode;
    renderRuntimeGuidanceProgress(null);
    renderRuntimeGuidanceHarvest(null);
    return null;
  }
  fields.runtimeGuidance.className = 'runtime-guidance';
  fields.runtimeGuidance.dataset.mode = view.mode;
  fields.runtimeGuidanceKicker.textContent = view.kicker || '';
  fields.runtimeGuidanceTitle.textContent = view.title || '';
  fields.runtimeGuidanceValueText.textContent = view.value || '';
  fields.runtimeGuidanceValue.classList.toggle('hidden', !view.value);
  fields.runtimeGuidanceDetail.textContent = view.detail || '';
  fields.runtimeGuidanceDetail.classList.toggle('hidden', !view.detail);
  fields.runtimeGuidanceResume.textContent = view.resume || '';
  fields.runtimeGuidanceResume.classList.toggle('hidden', !view.resume);
  fields.runtimeGuidanceNote.textContent = view.note || '';
  fields.runtimeGuidanceNote.classList.toggle('hidden', !view.note);
  renderRuntimeGuidanceProgress(view.progress || null);
  renderRuntimeGuidanceHarvest(view.harvest || null);
  fields.runtimeGuidanceMascot.src = RUNTIME_GUIDANCE_MASCOTS[view.mascot] || '';
  fields.runtimeGuidanceMascot.classList.toggle('animate', Boolean(view.animate));

  const steps = Array.isArray(view.steps) ? view.steps : [];
  fields.runtimeGuidanceFlow.classList.toggle('hidden', steps.length === 0);
  const expectedFlowNodeCount = steps.length > 0 ? (steps.length * 2) - 1 : 0;
  const existingFlowNodes = Array.from(fields.runtimeGuidanceFlow.children);
  const canReuseFlowNodes = existingFlowNodes.length === expectedFlowNodeCount
    && existingFlowNodes.every((node, index) => (
      index % 2 === 0
        ? node.classList.contains('rg-flow-step')
          && node.querySelector('.rg-flow-icon')
          && node.querySelector('.rg-flow-copy strong')
          && node.querySelector('.rg-flow-copy small')
        : node.classList.contains('rg-flow-connector')
    ));
  if (!canReuseFlowNodes) {
    fields.runtimeGuidanceFlow.replaceChildren();
    for (let index = 0; index < steps.length; index += 1) {
      const el = document.createElement('div');
      el.className = 'rg-flow-step';
      const icon = document.createElement('span');
      icon.className = 'rg-flow-icon';
      const copy = document.createElement('span');
      copy.className = 'rg-flow-copy';
      const label = document.createElement('strong');
      const detail = document.createElement('small');
      copy.append(label, detail);
      el.append(icon, copy);
      fields.runtimeGuidanceFlow.appendChild(el);
      if (index < steps.length - 1) {
        const connector = document.createElement('span');
        connector.className = 'rg-flow-connector';
        connector.setAttribute('aria-hidden', 'true');
        fields.runtimeGuidanceFlow.appendChild(connector);
      }
    }
  }
  const flowNodes = fields.runtimeGuidanceFlow.children;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const state = step.state || 'next';
    const nextState = steps[index + 1] && (steps[index + 1].state || 'next');
    const el = flowNodes[index * 2];
    el.className = `rg-flow-step ${state}`;
    el.dataset.stepIndex = String(index);
    const icon = el.querySelector('.rg-flow-icon');
    const iconKey = step.icon || '';
    if (icon.dataset.icon !== iconKey) {
      icon.dataset.icon = iconKey;
      icon.innerHTML = RUNTIME_GUIDANCE_ICONS[iconKey] || '';
    }
    const label = el.querySelector('.rg-flow-copy strong');
    const detail = el.querySelector('.rg-flow-copy small');
    if (label.textContent !== (step.label || '')) label.textContent = step.label || '';
    if (detail.textContent !== (step.detail || '')) detail.textContent = step.detail || '';
    if (nextState) {
      const activeFlow = (state === 'current' && (nextState === 'current' || nextState === 'done' || nextState === 'next'))
        || (state === 'done' && nextState === 'current');
      const activeDayFlow = view.mode === 'day' && state === 'done' && (nextState === 'done' || nextState === 'next');
      const completeFlow = state === 'done' && (nextState === 'done' || nextState === 'next');
      const connector = flowNodes[(index * 2) + 1];
      connector.dataset.fromState = state;
      connector.dataset.toState = nextState;
      connector.classList.toggle('flow-active', activeFlow || activeDayFlow);
      connector.classList.toggle('flow-complete', !(activeFlow || activeDayFlow) && completeFlow);
    }
  }
  return view;
}

// ─── 在场感行（动效只由真实事件驱动；诚实待命）───
function renderPresence(status, nowMs) {
  fields.presence?.classList.remove('hidden');
  const view = uiLogic.presenceView(status, nowMs);
  const guidanceOwnsShimmer = view.animate && fields.runtimeGuidance?.dataset.mode === 'running';
  fields.presenceText.textContent = view.text;
  fields.presenceText.classList.remove('shimmer');
  fields.runtimeGuidanceTitle?.classList.toggle('shimmer', guidanceOwnsShimmer);
  fields.presenceCore.classList.toggle('live', view.animate);
  fields.presenceFresh.textContent = view.fresh || '';
}

// ─── 发布卡（常驻四态：flow 进行中 / submitted 平台确认中 / last 上次发布 / empty 从未发布）───
// 终态折流的去重签名按 envId 分桶（多环境下 A 的终态签名绝不吞掉 B 的折流）。
const lastPublishSigByEnv = new Map();
// 用户点薄条的临时展开（进行中审批到来 / 会话停止 / 切换环境时自动复位）。
let pubManualOpen = false;
let pubCarouselEnvId = null;
let pubCarouselItemKey = null;

function resetPubCarouselSelection() {
  pubCarouselEnvId = null;
  pubCarouselItemKey = null;
}

function pubCarouselEntries(data) {
  const active = Array.isArray(data?.active) ? data.active : [];
  const waiting = active.filter((item) => item?.status === 'waiting_approval');
  const otherActive = active.filter((item) => item?.status !== 'waiting_approval');
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const inProgress = [
    ...waiting.map((item) => ({ key: `active:${item.id}`, kind: 'active', item })),
    ...otherActive.map((item) => ({ key: `active:${item.id}`, kind: 'active', item })),
    ...tasks.map((item) => ({ key: `task:${item.id}`, kind: 'task', item })),
  ];
  if (inProgress.length > 0) return inProgress;
  const recent = Array.isArray(data?.recent) ? data.recent : [];
  return recent.map((item) => ({ key: `recent:${item.id}`, kind: 'recent', item }));
}

function resolvePubCarousel(queueState) {
  const envId = String(queueState?.envId || '');
  if (pubCarouselEnvId !== envId) {
    pubCarouselEnvId = envId;
    pubCarouselItemKey = null;
  }
  const entries = pubCarouselEntries(queueState?.data);
  let index = entries.findIndex((entry) => entry.key === pubCarouselItemKey);
  if (index < 0) index = 0;
  const selected = entries[index] || null;
  pubCarouselItemKey = selected?.key || null;
  return { entries, index: selected ? index : -1, selected };
}

function pubCarouselEntryTitle(entry) {
  return String(entry?.item?.title || '未命名内容');
}

function setPubActionVisibility(button, visible) {
  if (!button) return;
  button.classList.toggle('hidden', !visible);
  button.hidden = !visible;
  button.disabled = !visible;
}

function hidePubCarouselControls() {
  const controls = [fields.pubCarouselPrev, fields.pubCarouselNext].filter(Boolean);
  if (controls.includes(document.activeElement)) fields.pubHeadRow?.focus();
  fields.pubMain?.classList.remove('has-carousel');
  for (const button of controls) {
    button.hidden = true;
    button.disabled = true;
    button.removeAttribute('title');
  }
}

function syncPubCarouselControls(entries, index, collapsed) {
  if (!Array.isArray(entries) || entries.length <= 1 || index < 0 || collapsed) {
    hidePubCarouselControls();
    return;
  }
  const previous = entries[(index - 1 + entries.length) % entries.length];
  const next = entries[(index + 1) % entries.length];
  const previousLabel = `上一条发布内容：${pubCarouselEntryTitle(previous)}`;
  const nextLabel = `下一条发布内容：${pubCarouselEntryTitle(next)}`;
  fields.pubMain?.classList.add('has-carousel');
  for (const [button, label] of [
    [fields.pubCarouselPrev, previousLabel],
    [fields.pubCarouselNext, nextLabel],
  ]) {
    if (!button) continue;
    button.hidden = false;
    button.disabled = false;
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

function movePubCarousel(delta) {
  if (!Number.isInteger(delta) || delta === 0 || selectedEnvPlatform() !== 'xiaohongshu') return;
  const queueState = contentWorkspace?.publishQueueSnapshot?.();
  if (!queueState?.data) return;
  const { entries, index } = resolvePubCarousel(queueState);
  if (entries.length <= 1 || index < 0) return;
  pubCarouselItemKey = entries[(index + delta + entries.length) % entries.length].key;
  if (currentStatus) renderPublish(currentStatus, Date.now());
}

function renderXhsPublishQueueDock(status) {
  if (selectedEnvPlatform() !== 'xiaohongshu' || !contentWorkspace?.publishQueueSnapshot) return false;
  const queueState = contentWorkspace.publishQueueSnapshot();
  if (!queueState || queueState.kind === 'unsupported') return false;

  fields.pubCard.dataset.platform = 'xiaohongshu';
  fields.pubCard.classList.remove('hidden', 'empty', 'single-surface');
  fields.pubCard.classList.add('queue-surface');
  fields.pubKicker.classList.remove('hidden');
  fields.pubKicker.textContent = '发布进度';
  fields.pubCount.classList.add('hidden');
  fields.pubCount.classList.remove('attention');
  fields.pubMeta.classList.remove('chip', 'attention');
  setPubActionVisibility(fields.pubQueueLink, false);
  setPubActionVisibility(fields.pubPreviewLink, false);
  if (queueState.kind === 'loading' || queueState.kind === 'idle') {
    hidePubCarouselControls();
    fields.pubCard.classList.remove('collapsed');
    fields.pubCard.dataset.pubMode = 'loading';
    fields.pubCard.dataset.pubState = 'loading';
    fields.pubBar.classList.add('hidden');
    fields.pubMain.classList.remove('folded');
    fields.pubHead.textContent = '正在读取发布进度';
    fields.pubCorner.textContent = '';
    fields.pubTitle.textContent = '正在整理当前账号的发布队列';
    fields.pubTitle.classList.remove('muted');
    fields.pubMeta.textContent = '排队、创作和发布结果均以 Cloud 真态为准';
    fields.pubFoot.textContent = '浏览器未启动也可以读取，稍候会自动更新。';
    fields.pubSteps.querySelectorAll('.j-step').forEach((step) => {
      step.className = 'j-step todo';
      const detail = step.querySelector('.j-state');
      if (detail) detail.textContent = '';
    });
    return true;
  }
  if (queueState.kind === 'error' || !queueState.data) {
    hidePubCarouselControls();
    fields.pubCard.classList.remove('collapsed');
    fields.pubCard.dataset.pubMode = 'loading';
    fields.pubCard.dataset.pubState = 'error';
    fields.pubBar.classList.add('hidden');
    fields.pubMain.classList.remove('folded');
    fields.pubHead.textContent = '暂时无法读取发布进度';
    fields.pubCorner.textContent = '';
    fields.pubTitle.textContent = '—';
    fields.pubTitle.classList.add('muted');
    fields.pubMeta.textContent = '当前不会把未知状态显示成空队列';
    fields.pubFoot.textContent = queueState.error || '请稍后重试。';
    fields.pubSteps.querySelectorAll('.j-step').forEach((step) => {
      step.className = 'j-step todo';
      const detail = step.querySelector('.j-state');
      if (detail) detail.textContent = '';
    });
    return true;
  }

  const data = queueState.data;
  const carousel = resolvePubCarousel(queueState);
  const priority = carousel.selected?.item || null;
  const active = carousel.selected?.kind === 'active' ? priority : null;
  const task = carousel.selected?.kind === 'task' ? priority : null;
  const recent = carousel.selected?.kind === 'recent' ? priority : null;
  const hasWork = data.summary.inProgress > 0;
  const evidenceUnavailable = Boolean(active?.dispatchEvidenceUnavailable);
  const waitingCount = Number.isFinite(data.summary.waitingForYou) ? data.summary.waitingForYou : null;
  // 只有系统处理中时默认显示紧凑摘要；一旦需要客户处理立即展开。
  const collapsed = !evidenceUnavailable && waitingCount === 0 && !pubManualOpen;
  fields.pubCard.classList.toggle('collapsed', collapsed);
  fields.pubCard.classList.toggle('empty', !hasWork && !recent);
  fields.pubCard.dataset.pubMode = hasWork ? 'queue' : recent ? 'last' : 'empty';
  fields.pubCard.dataset.pubState = evidenceUnavailable
    ? 'evidence_unavailable'
    : active?.status === 'waiting_approval'
    ? 'pending'
    : active || task
      ? 'processing'
      : recent?.status || 'empty';
  fields.pubBar.classList.toggle('hidden', !collapsed);
  fields.pubMain.classList.toggle('folded', collapsed);
  fields.pubBarLabel.textContent = '发布进度';
  fields.pubBarSum.textContent = evidenceUnavailable
    ? '下发状态暂不可用'
    : waitingCount > 0
    ? `${hasWork ? `${data.summary.inProgress} 条进行中 · ` : ''}${waitingCount} 条待确认`
    : hasWork
      ? `${data.summary.inProgress} 条进行中`
      : recent
        ? recent.statusLabel
        : '暂无进行中';
  fields.pubHead.textContent = evidenceUnavailable
    ? '下发状态暂不可用'
    : active?.status === 'waiting_approval'
    ? '需要你确认'
    : active
      ? 'AI 正在处理'
      : task
        ? '等待开始创作'
        : recent
          ? '最近发布结果'
          : '暂无进行中';
  const summaryCount = evidenceUnavailable
    ? '下发状态暂不可用'
    : waitingCount > 0
    ? `${waitingCount} 条待确认`
    : hasWork
      ? `${data.summary.inProgress} 条进行中`
      : '';
  fields.pubCount.textContent = summaryCount;
  fields.pubCount.classList.toggle('hidden', !summaryCount);
  fields.pubCount.classList.toggle('attention', evidenceUnavailable || waitingCount > 0);
  const freshness = queueState.refreshing ? '同步中' : queueState.stale ? '稍早数据' : '';
  const position = carousel.entries.length > 1 ? `${carousel.index + 1} / ${carousel.entries.length}` : '';
  fields.pubCorner.textContent = [freshness, position].filter(Boolean).join(' · ');
  fields.pubCorner.classList.toggle('hot', evidenceUnavailable || waitingCount > 0);
  fields.pubTitle.textContent = priority?.title || '暂无进行中的发布任务';
  fields.pubTitle.classList.toggle('muted', !priority);
  fields.pubMeta.textContent = task
    ? `${task.action} · ${task.statusLabel}`
    : active
      ? active.statusLabel
      : recent
        ? recent.statusLabel
        : '开始一次创作后，进度会显示在这里';
  fields.pubMeta.classList.toggle('chip', Boolean(priority));
  fields.pubMeta.classList.toggle('attention', !evidenceUnavailable && active?.status === 'waiting_approval');
  fields.pubFoot.textContent = evidenceUnavailable
    ? 'Cloud 暂时无法确认下发证据；这里不会显示等待发布、正在发布或未下发。'
    : waitingCount > 0
    ? '先确认内容，再进入发布；其它任务会继续在后台处理。'
    : hasWork
      ? `${data.summary.inProgress} 条内容正在排队或创作，你可以离开此页。`
      : recent?.status === 'submitted'
        ? '平台已经受理，正在确认公开结果，请勿重复操作。'
        : recent
          ? '这是 Cloud 最近确认的结果，点击可查看完整发布进度。'
          : '当前账号暂时没有进行中的发布任务。';

  const defaultLabels = ['开始创作', '正文与配图', '发布确认', '发布结果'];
  const stages = Array.isArray((active || recent)?.stages) ? (active || recent).stages : [];
  fields.pubSteps.querySelectorAll('.j-step').forEach((step, index) => {
    const stage = stages[index];
    const state = !stage
      ? 'todo'
      : stage.state === 'completed' || stage.state === 'skipped'
        ? 'done'
        : ['running', 'retrying', 'waiting_human', 'failed', 'partial', 'evidence_unavailable'].includes(stage.state)
          ? 'cur'
          : 'todo';
    step.className = `j-step ${state}${stage?.state === 'running' ? ' calm' : ''} is-${stage?.state || 'pending'}`;
    const label = step.querySelector('.j-lab');
    const stageLabel = stage?.label || defaultLabels[index];
    if (label) label.textContent = stageLabel;
    const progress = stage?.progress
      ? ` · ${Math.max(0, stage.progress.current)}/${Math.max(0, stage.progress.total)}`
      : '';
    const stateText = stage
      ? `${String(stage.summary || '').replace(`${stageLabel}：`, '') || '状态未知'}${progress}`
      : '未开始';
    const detail = step.querySelector('.j-state');
    if (detail) detail.textContent = stateText;
    step.setAttribute('aria-label', `${stageLabel}，${stateText}`);
  });
  setPubActionVisibility(fields.pubQueueLink, true);
  setPubActionVisibility(
    fields.pubPreviewLink,
    active?.status === 'waiting_approval' && !evidenceUnavailable && publishDraftQueueSupported(),
  );
  fields.pubPreviewLink.textContent = '审核稿件';
  syncPubCarouselControls(carousel.entries, carousel.index, collapsed);
  syncPublishPreviewActions(status);
  return true;
}

function facebookPublishMetaLabel(view, status) {
  if (view.mode === 'flow') return status.publish?.state === 'approved' ? '等待提交' : '等待发布审批';
  if (view.mode === 'submitted') return '平台确认中';
  if (view.mode === 'last') return '已发布';
  return '尚无内容';
}

function renderPublish(status, nowMs) {
  const platform = selectedEnvPlatform();
  const facebook = platform === 'facebook';
  fields.pubCard.dataset.platform = platform || 'unknown';
  if (renderXhsPublishQueueDock(status)) return;
  fields.pubCard.classList.remove('queue-surface');
  fields.pubCard.classList.toggle('single-surface', facebook);
  fields.pubKicker.classList.toggle('hidden', !facebook);
  fields.pubKicker.textContent = facebook ? '内容发布' : '发布进度';
  fields.pubCount.classList.add('hidden');
  fields.pubCount.classList.remove('attention');
  fields.pubMeta.classList.remove('chip', 'attention');
  fields.pubSteps.querySelectorAll('.j-state').forEach((detail) => { detail.textContent = ''; });
  hidePubCarouselControls();
  setPubActionVisibility(fields.pubQueueLink, false);
  const overview = status && status.environmentOverview;
  if (overview && !overview.confirmed) {
    const loading = Boolean(overview.loading);
    fields.pubCard.classList.remove('hidden', 'empty', 'collapsed');
    fields.pubCard.dataset.pubMode = 'loading';
    fields.pubCard.dataset.pubState = loading ? 'loading' : 'error';
    fields.pubBar.classList.add('hidden');
    fields.pubMain.classList.remove('folded');
    fields.pubHead.textContent = loading ? '正在读取发布记录' : '暂时无法读取发布记录';
    fields.pubCorner.textContent = '';
    fields.pubCorner.classList.remove('hot');
    fields.pubTitle.textContent = '—';
    fields.pubTitle.classList.add('muted');
    fields.pubMeta.textContent = facebook ? '状态暂未确认' : '尚未取得云端确认数据';
    fields.pubMeta.classList.toggle('chip', facebook);
    fields.pubFoot.textContent = loading ? '正在从云端获取' : '请稍后重试，当前不会把未知显示成未发布';
    setPubActionVisibility(fields.pubPreviewLink, false);
    fields.pubSteps.querySelectorAll('.j-step').forEach((step) => { step.className = 'j-step todo'; });
    return;
  }
  const view = uiLogic.publishView(status.publish, status.lastPublish, nowMs, platform);
  const preview = status && status.publishPreview && typeof status.publishPreview === 'object'
    ? status.publishPreview
    : null;
  // 终态折流 + 去重已收口到 absorbPublishTerminal（在 routeStatus 里对每个环境跑，含未选中环境），
  // 这里只负责发布卡的视觉渲染，绝不再自己 prependActivity（否则选中环境会重复记一条）。
  fields.pubCard.classList.remove('hidden'); // 常驻
  fields.pubCard.classList.toggle('empty', view.mode === 'empty');
  fields.pubCard.dataset.pubMode = view.mode;
  fields.pubCard.dataset.pubState = status.publish && status.publish.state ? status.publish.state : view.mode;
  // 收展：flow / submitted 永远展开；已发布历史与空态默认收起（点击薄条可临时展开）。
  const dock = uiLogic.publishDock(view, status, pubManualOpen);
  if (view.mode === 'flow' || view.mode === 'submitted') pubManualOpen = false; // 新流程状态到来自动展开并复位手动态
  fields.pubCard.classList.toggle('collapsed', dock.collapsed);
  fields.pubBar.classList.toggle('hidden', !dock.collapsed);
  fields.pubMain.classList.toggle('folded', dock.collapsed);
  fields.pubBarLabel.textContent = dock.label || (facebook ? 'Facebook 内容发布' : '发布过的 AI 写好的笔记');
  fields.pubBarSum.textContent = dock.summary || '';
  fields.pubHead.textContent = view.head;
  fields.pubCorner.textContent = view.corner;
  fields.pubCorner.classList.toggle('hot', Boolean(view.cornerHot));
  fields.pubTitle.textContent = view.title || (preview && preview.title) || (facebook ? '一条待发布内容' : '（新笔记）');
  fields.pubTitle.classList.toggle('muted', view.mode === 'empty');
  // 编号默认形态：无真编号时以「—」占位（云端飞书卡印上 requestId 后自动点亮真编号）；编号值带灰底小片（设计稿）。
  fields.pubMeta.textContent = '';
  if (facebook) {
    fields.pubMeta.textContent = facebookPublishMetaLabel(view, status);
    fields.pubMeta.classList.add('chip');
  } else {
    const previewMeta = preview && view.mode === 'flow'
      ? `${preview.kind === 'rewrite' ? '洗稿稿件' : 'AI 稿件'} · 正文 ${String(preview.content || '').length} 字 · 配图 ${Array.isArray(preview.images) ? preview.images.length : 0} 张 · 编号 `
      : (view.mode === 'empty' ? '等待第一条笔记 · 编号 ' : '图文笔记 · 编号 ');
    fields.pubMeta.appendChild(document.createTextNode(previewMeta));
    const codeChip = document.createElement('span');
    codeChip.className = 'no';
    codeChip.textContent = view.code || (preview && preview.code) || '—';
    fields.pubMeta.appendChild(codeChip);
  }
  renderFootRich(fields.pubFoot, view.foot); // 固定模板内 **…** 加粗，破掉整片灰
  const previewEntryVisible = view.mode === 'flow' && publishDraftEntryAvailable(status);
  setPubActionVisibility(fields.pubPreviewLink, previewEntryVisible);
  fields.pubPreviewLink.textContent = facebook ? '查看内容 ↗' : '查看稿件 ↗';
  syncPublishPreviewActions(status);
  const steps = fields.pubSteps.querySelectorAll('.j-step');
  view.stepStates.forEach((state, i) => {
    const el = steps[i];
    if (!el) return;
    el.className = `j-step ${state}${state === 'cur' && view.curCalm ? ' calm' : ''}`;
    const label = el.querySelector('.j-lab');
    if (label && Array.isArray(view.steps) && view.steps[i]) label.textContent = view.steps[i];
  });
}

const PUBLISH_PREVIEW_STATES = {
  pending: '待确认',
  reminded: '待确认',
  approved: '已通过，等待发布',
  submitted: '已提交，待链接确认',
  published: '已发布',
  rejected: '已驳回',
  failed: '发布失败',
};

function publishPreviewActionReason(reason) {
  switch (reason) {
    case 'version_stale': return '稿件已更新，请关闭后重新查看。';
    case 'account_offline': return '账号当前不在线，暂时无法发布。';
    case 'already_decided': return '这份稿件已被处理。';
    case 'not_pending': return '这份稿件已不在待确认状态。';
    case 'account_mismatch': return '当前环境与稿件账号不一致。';
    case 'account_unavailable': return '登录状态异常，请重新登录。';
    case 'invalid_publish_plan': return '发布方式不完整，请重新选择。';
    case 'schedule_platform_unsupported': return '当前平台暂不支持定时发布。';
    case 'schedule_time_required': return '请选择定时发布时间。';
    case 'schedule_time_out_of_range': return '定时时间需在未来 1 小时至 14 天内。';
    case 'schedule_update_rejected': return '发布计划未能保存，请刷新稿件后重试。';
    case 'edge_not_running': return '引擎未运行，暂时无法提交。';
    case 'edge_request_timeout':
    case 'edge_request_failed':
    case 'request_failed': return '暂时没能连上云端，请稍后重试。';
    default: return '操作未完成，请稍后重试。';
  }
}

// 删配图拒因（change client-preview-image-delete）：云端拒因逐条译成人话，绝不用成功措辞掩盖失败。
function publishPreviewImageRemoveReason(reason) {
  switch (reason) {
    case 'last_image': return '至少保留一张配图。';
    case 'image_not_found': return '这张配图已经不在稿件里了。';
    case 'version_stale': return '稿件已更新，请关闭后重新查看。';
    case 'already_decided': return '这份稿件已被处理，无法再修改。';
    case 'not_pending': return '这份稿件已不在待确认状态。';
    case 'account_mismatch': return '当前环境与稿件账号不一致。';
    case 'account_unavailable': return '登录状态异常，请重新登录。';
    case 'edge_not_running':
    case 'edge_request_timeout':
    case 'edge_request_failed': return '暂时没能连上云端，请稍后重试。';
    default: return '删除未完成，请稍后重试。';
  }
}

// 待确认删除的那张配图 URL。存模块级而非 DOM：抽屉每帧云端快照到达时整体重建，
// 只存 DOM 的确认态会被下一次心跳抹掉。
let publishPreviewPendingDeleteUrl = null;

document.querySelector('#content-workspace')?.addEventListener('content-workspace:leave', (event) => {
  if (event.detail?.page !== 'draft') return;
  publishPreviewPendingDeleteUrl = null;
  publishPreviewImageRemoveHint = '';
  publishDraftReview.selected = null;
  publishDraftReview.planRecordId = null;
  publishDraftReview.requestEpoch += 1;
  publishDraftReview.activeRefinement = null;
  publishDraftReview.mutationBusy = false;
  if (publishDraftRefinementPollTimer) clearTimeout(publishDraftRefinementPollTimer);
  publishDraftRefinementPollTimer = null;
});

function normalizePublishDraft(raw) {
  return publishReviewLogic.normalizeDraft(raw);
}

function publishDraftHandledSet(envId) {
  if (!publishDraftReview.handledByEnv.has(envId)) publishDraftReview.handledByEnv.set(envId, new Set());
  return publishDraftReview.handledByEnv.get(envId);
}

function publishScheduleEnvKey(envId) {
  return envId || '__local__';
}

function publishScheduleAccountKey(status = currentStatus, envId = status?.envId) {
  const accountId = status?.envId === envId ? String(status?.account?.id || '').trim() : '';
  return accountId ? `account:${accountId}` : `env:${publishScheduleEnvKey(envId)}`;
}

function publishScheduleReservationSet(accountKey) {
  if (!publishDraftReview.scheduleReservationsByAccount.has(accountKey)) {
    publishDraftReview.scheduleReservationsByAccount.set(accountKey, new Set());
  }
  return publishDraftReview.scheduleReservationsByAccount.get(accountKey);
}

function publishScheduleAvailability(envId = publishDraftReview.envId) {
  return publishDraftReview.scheduleAvailabilityByEnv.get(publishScheduleEnvKey(envId))
    || { status: 'unavailable', occupiedTimes: [] };
}

function publishScheduleOccupiedTimes(envId = publishDraftReview.envId) {
  const availability = publishScheduleAvailability(envId);
  const reservations = publishScheduleReservationSet(publishScheduleAccountKey(currentStatus, envId));
  return [...new Set([...availability.occupiedTimes, ...reservations])];
}

function syncPublishScheduleShortcutAvailability() {
  const peakButton = fields.publishPreviewContent?.querySelector('[data-publish-time-shortcut="peak"]');
  const freeButton = fields.publishPreviewContent?.querySelector('[data-publish-time-shortcut="free"]');
  const availabilityHint = fields.publishPreviewContent?.querySelector('.publish-plan-shortcut-hint');
  if (!peakButton || !freeButton || !availabilityHint) return;
  const availability = publishScheduleAvailability();
  peakButton.disabled = publishPreviewActionBusy;
  freeButton.disabled = publishPreviewActionBusy || availability.status !== 'ready';
  freeButton.title = availability.status === 'loading'
    ? '正在读取已安排时段'
    : availability.status === 'ready'
      ? '跳过当前账号同一小时已有的定时安排'
      : '暂时无法判断空闲时段';
  const base = '热门时段：每天 08:00、12:00、18:00。快捷按钮只选择时间，仍需点击批准。';
  availabilityHint.textContent = availability.status === 'loading'
    ? `${base} 正在读取已安排时段…`
    : availability.status === 'ready'
      ? base
      : `${base} 暂时无法判断空闲时段。`;
}

async function loadPublishScheduleOccupiedHours(envId) {
  const key = publishScheduleEnvKey(envId);
  const epoch = (publishDraftReview.scheduleAvailabilityEpochByEnv.get(key) || 0) + 1;
  publishDraftReview.scheduleAvailabilityEpochByEnv.set(key, epoch);
  publishDraftReview.scheduleAvailabilityByEnv.set(key, { status: 'loading', occupiedTimes: [] });
  syncPublishScheduleShortcutAvailability();
  const api = window.aidcpEdge?.publishScheduleOccupiedHours;
  if (typeof api !== 'function') {
    publishDraftReview.scheduleAvailabilityByEnv.set(key, { status: 'unavailable', occupiedTimes: [] });
    syncPublishScheduleShortcutAvailability();
    return;
  }
  let response;
  try {
    response = await api(envId);
  } catch {
    response = { ok: false };
  }
  if (publishDraftReview.scheduleAvailabilityEpochByEnv.get(key) !== epoch) return;
  const occupiedTimes = response?.data?.occupiedTimes;
  const valid = response?.ok === true
    && Array.isArray(occupiedTimes)
    && occupiedTimes.every((timestamp) => Number.isFinite(timestamp));
  publishDraftReview.scheduleAvailabilityByEnv.set(key, valid
    ? { status: 'ready', occupiedTimes: occupiedTimes.slice() }
    : { status: 'unavailable', occupiedTimes: [] });
  if (publishScheduleEnvKey(publishDraftReview.envId) === key) syncPublishScheduleShortcutAvailability();
}

function resetPublishDraftReview(envId) {
  if (publishDraftReview.envId === envId) return;
  publishDraftReview.requestEpoch += 1;
  publishDraftReview.envId = envId || null;
  publishDraftReview.page = 1;
  publishDraftReview.scrollTop = 0;
  publishDraftReview.total = 0;
  publishDraftReview.items = [];
  publishDraftReview.loaded = false;
  publishDraftReview.loading = false;
  publishDraftReview.error = '';
  publishDraftReview.selected = null;
  publishDraftReview.planRecordId = null;
  publishDraftReview.publishMode = 'immediate';
  publishDraftReview.publishTimeInput = '';
  publishDraftReview.editing = false;
  publishDraftReview.editFeedback = '';
  publishDraftReview.refinementScope = 'whole';
  publishDraftReview.refinementInstruction = '';
  publishDraftReview.selectedImageUrl = '';
  publishDraftReview.selectedTextSelection = null;
  publishDraftReview.activeRefinement = null;
  publishDraftReview.mutationBusy = false;
  if (publishDraftRefinementPollTimer) clearTimeout(publishDraftRefinementPollTimer);
  publishDraftRefinementPollTimer = null;
}

function activePublishPreview(status = currentStatus) {
  if (publishDraftReview.selected && publishDraftReview.envId === status?.envId) {
    return publishDraftReview.selected;
  }
  return status?.publishPreview ? normalizePublishDraft(status.publishPreview) : null;
}

function publishDraftQueueSupported() {
  return typeof window.aidcpEdge?.publishDraftList === 'function'
    && typeof window.aidcpEdge?.publishDraftGet === 'function';
}

function publishDraftEntryAvailable(status) {
  if (status?.publishPreview) return true;
  const state = status?.publish?.state;
  return publishDraftQueueSupported() && (state === 'pending' || state === 'reminded');
}

function initializePublishPlan(preview) {
  if (!preview || publishDraftReview.planRecordId === preview.recordId) return;
  publishDraftReview.planRecordId = preview.recordId;
  const scheduled = preview.platform === 'xiaohongshu' && preview.publishMode === 'scheduled';
  publishDraftReview.publishMode = scheduled ? 'scheduled' : 'immediate';
  publishDraftReview.publishTimeInput = scheduled && Number.isFinite(preview.publishTime)
    ? publishReviewLogic.toShanghaiInput(preview.publishTime)
    : publishReviewLogic.defaultScheduledInput(Date.now());
}

function publishPreviewIsPending(status) {
  if (publishDraftReview.selected && publishDraftReview.envId === status?.envId) {
    return !publishDraftHandledSet(publishDraftReview.envId).has(publishDraftReview.selected.recordId);
  }
  const state = status && status.publish && status.publish.state;
  return Boolean(status && status.publishPreview && (state === 'pending' || state === 'reminded'));
}

function syncPublishPreviewActions(status) {
  if (!fields.publishPreviewActions) return;
  const pending = publishPreviewIsPending(status);
  const preview = activePublishPreview(status);
  if (pending) initializePublishPlan(preview);
  const plan = pending && preview
    ? publishReviewLogic.validatePlan(
        preview.platform,
        publishDraftReview.publishMode,
        publishDraftReview.publishTimeInput,
        Date.now(),
      )
    : null;
  fields.publishPreviewActions.classList.toggle('hidden', !pending && !publishPreviewActionBusy);
  const disabled = publishPreviewActionBusy || publishDraftReview.mutationBusy || !pending;
  fields.publishPreviewApprove.disabled = disabled || Boolean(plan && !plan.ok);
  fields.publishPreviewCancel.disabled = disabled;
  fields.publishPreviewApprove.textContent = publishDraftReview.publishMode === 'scheduled' ? '批准并定时发布' : '批准并发布';
  if (publishPreviewActionBusy) {
    fields.publishPreviewActionHint.textContent = '正在提交，请稍候…';
  } else if (plan && !plan.ok) {
    fields.publishPreviewActionHint.textContent = publishPreviewActionReason(plan.reason);
  } else if (pending) {
    fields.publishPreviewActionHint.textContent = '批准会按上方发布方式执行；取消不会发布';
  }
  syncPublishScheduleShortcutAvailability();
}

function appendPreviewText(parent, text, className) {
  const el = document.createElement('div');
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function publishDraftMutationMessage(response, fallback = '操作没有完成，原稿未变化。') {
  const reason = response?.reason || response?.error;
  if (reason === 'version_conflict') return '稿件已经有新版本，已为你刷新，请在最新内容上继续。';
  if (reason === 'refinement_already_active') return '这份稿件已有一个调整任务正在进行，请等待它完成。';
  if (reason === 'invalid_selection') return '所选内容已经变化，请重新选择后再试。';
  if (reason === 'not_pending') return '这份稿件已不再等待确认，不能继续修改。';
  return typeof response?.error === 'string' && response.error !== 'request_failed' ? response.error : fallback;
}

function publishDraftScopeLabel(scope) {
  return ({
    whole: '全局调整', body: '只改正文', images: '全部图片', selected_image: '选中图片', selected_text: '选中文字',
  })[scope] || '调整';
}

function capturePublishDraftTextSelection(bodyElement, preview) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!bodyElement.contains(range.commonAncestorContainer)) return null;
  const prefixRange = range.cloneRange();
  prefixRange.selectNodeContents(bodyElement);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const start = prefixRange.toString().length;
  const text = range.toString();
  const end = start + text.length;
  if (!text || preview.content.slice(start, end) !== text) return null;
  return { start, end, text };
}

function schedulePublishDraftRefinementPoll(recordId, jobId, delay = 1_800) {
  if (publishDraftRefinementPollTimer) clearTimeout(publishDraftRefinementPollTimer);
  publishDraftRefinementPollTimer = setTimeout(() => {
    publishDraftRefinementPollTimer = null;
    void loadPublishDraftRefinement(recordId, jobId);
  }, delay);
}

async function loadPublishDraftRefinement(recordId, jobId) {
  const envId = publishDraftReview.envId;
  if (!envId || !Number.isInteger(recordId) || typeof window.aidcpEdge?.publishDraftRefinementGet !== 'function') return;
  let response;
  try {
    response = await window.aidcpEdge.publishDraftRefinementGet(envId, recordId, jobId || 'latest');
  } catch {
    response = { ok: false, error: 'request_failed' };
  }
  if (envId !== publishDraftReview.envId || publishDraftReview.selected?.recordId !== recordId) return;
  const job = response?.ok ? response.data?.data?.job : null;
  if (!job || job.recordId !== recordId) {
    publishDraftReview.editFeedback = publishDraftMutationMessage(response, '暂时无法刷新调整过程，原稿未变化。');
    renderPublishPreviewContent(currentStatus);
    return;
  }
  publishDraftReview.activeRefinement = job;
  renderPublishPreviewContent(currentStatus);
  if (job.status === 'queued' || job.status === 'running') {
    schedulePublishDraftRefinementPoll(recordId, job.id);
    return;
  }
  if (job.status === 'completed') {
    publishDraftReview.editFeedback = '调整已完成，已写回新的可编辑版本。';
    await selectPublishDraft(recordId);
    contentWorkspace?.refreshHome?.();
  } else {
    publishDraftReview.editFeedback = job.error?.message || '调整没有完成，原稿保持不变。';
  }
}

async function submitPublishDraftEdit(preview, values) {
  if (publishDraftReview.mutationBusy || typeof window.aidcpEdge?.publishDraftEdit !== 'function') return;
  publishDraftReview.mutationBusy = true;
  publishDraftReview.editFeedback = '正在保存修改…';
  renderPublishPreviewContent(currentStatus);
  let response;
  try {
    response = await window.aidcpEdge.publishDraftEdit(publishDraftReview.envId, preview.recordId, {
      expectedVersion: preview.contentVersion,
      title: values.title,
      content: values.content,
      topics: values.topics,
    });
  } catch {
    response = { ok: false, error: 'request_failed' };
  }
  publishDraftReview.mutationBusy = false;
  if (!response?.ok) {
    publishDraftReview.editFeedback = publishDraftMutationMessage(response, '保存失败，原稿未变化。');
    if (response?.reason === 'version_conflict') await selectPublishDraft(preview.recordId);
    else renderPublishPreviewContent(currentStatus);
    return;
  }
  const item = response.data?.data?.item;
  if (!item || item.id !== preview.recordId || !Number.isInteger(item.contentVersion)) {
    publishDraftReview.editFeedback = 'Cloud 返回的稿件状态不完整，已重新读取。';
    await selectPublishDraft(preview.recordId);
    return;
  }
  publishDraftReview.selected = normalizePublishDraft({ ...preview, ...item, recordId: item.id });
  publishDraftReview.editing = false;
  publishDraftReview.editFeedback = '修改已保存；仍是草稿，不会自动发布。';
  renderPublishPreviewContent(currentStatus);
  contentWorkspace?.refreshHome?.();
}

async function submitPublishDraftRefinement(preview) {
  if (publishDraftReview.mutationBusy || typeof window.aidcpEdge?.publishDraftRefine !== 'function') return;
  const scope = publishDraftReview.refinementScope;
  const instruction = publishDraftReview.refinementInstruction.trim();
  let selection = null;
  if (scope === 'selected_image') {
    if (!publishDraftReview.selectedImageUrl) {
      publishDraftReview.editFeedback = '请先在上方配图区选择一张图片。';
      renderPublishPreviewContent(currentStatus);
      return;
    }
    selection = { imageUrl: publishDraftReview.selectedImageUrl };
  } else if (scope === 'selected_text') {
    if (!publishDraftReview.selectedTextSelection) {
      publishDraftReview.editFeedback = '请先在正文中选中要调整的文字。';
      renderPublishPreviewContent(currentStatus);
      return;
    }
    selection = publishDraftReview.selectedTextSelection;
  }
  if (!instruction) {
    publishDraftReview.editFeedback = '请写下希望如何调整。';
    renderPublishPreviewContent(currentStatus);
    return;
  }
  publishDraftReview.mutationBusy = true;
  publishDraftReview.editFeedback = '正在创建调整任务…';
  renderPublishPreviewContent(currentStatus);
  let response;
  try {
    response = await window.aidcpEdge.publishDraftRefine(publishDraftReview.envId, preview.recordId, {
      expectedVersion: preview.contentVersion,
      scope,
      instruction,
      ...(selection ? { selection } : {}),
    });
  } catch {
    response = { ok: false, error: 'request_failed' };
  }
  publishDraftReview.mutationBusy = false;
  if (!response?.ok) {
    publishDraftReview.editFeedback = publishDraftMutationMessage(response, '调整任务没有创建，原稿未变化。');
    if (response?.reason === 'version_conflict') await selectPublishDraft(preview.recordId);
    else renderPublishPreviewContent(currentStatus);
    return;
  }
  const job = response.data?.data?.job;
  if (!job || job.recordId !== preview.recordId || !job.id) {
    publishDraftReview.editFeedback = '调整任务回执不完整，原稿尚未变化。';
    renderPublishPreviewContent(currentStatus);
    return;
  }
  publishDraftReview.activeRefinement = job;
  publishDraftReview.editFeedback = '调整任务已开始；过程中仍可查看原稿，但暂不能提交其它修改。';
  renderPublishPreviewContent(currentStatus);
  schedulePublishDraftRefinementPoll(preview.recordId, job.id, 900);
  contentWorkspace?.refreshHome?.();
}

function appendPublishDraftRefinementProgress(parent, job) {
  if (!job) return;
  const section = document.createElement('section');
  section.className = 'draft-refinement-progress';
  const head = document.createElement('div');
  head.className = 'draft-refinement-progress-head';
  appendPreviewText(head, '实时工作过程');
  appendPreviewText(head, job.status === 'completed' ? '调整完成' : job.status === 'failed' ? '调整未完成' : '持续更新中');
  section.appendChild(head);
  const list = document.createElement('div');
  list.className = 'draft-refinement-timeline';
  const progress = Array.isArray(job.progress) ? job.progress : [];
  progress.forEach((item) => {
    const row = document.createElement('div');
    row.className = `draft-refinement-step ${item.status === 'running' ? 'current' : 'completed'}`;
    appendPreviewText(row, item.status === 'running' ? '●' : '✓', 'draft-refinement-step-mark');
    const copy = document.createElement('div');
    const base = String(item.stage || '处理').replace(/(?:中|完成)$/, '');
    appendPreviewText(copy, item.status === 'running' ? `${base}中...` : `${base}完成`, 'draft-refinement-step-label');
    appendPreviewText(copy, item.summary || '正在处理当前调整要求。', 'draft-refinement-step-summary');
    row.appendChild(copy);
    list.appendChild(row);
  });
  if (progress.length === 0) appendPreviewText(list, '任务已进入队列，正在准备第一步。', 'publish-preview-empty');
  section.appendChild(list);
  parent.appendChild(section);
}

function appendPublishDraftEditing(parent, preview) {
  const section = document.createElement('section');
  section.className = 'draft-edit-panel';
  const heading = document.createElement('div');
  heading.className = 'draft-edit-heading';
  appendPreviewText(heading, '编辑当前草稿');
  appendPreviewText(heading, '保存后生成一个新版本，仍不会自动发布');
  section.appendChild(heading);
  const title = document.createElement('input');
  title.type = 'text';
  title.value = preview.title || '';
  title.maxLength = 100;
  title.setAttribute('aria-label', '稿件标题');
  const content = document.createElement('textarea');
  content.value = preview.content || '';
  content.setAttribute('aria-label', '稿件正文');
  const topics = document.createElement('input');
  topics.type = 'text';
  topics.value = (preview.topics || []).map((topic) => `#${String(topic).replace(/^#/, '')}`).join(' ');
  topics.setAttribute('aria-label', '稿件话题');
  topics.placeholder = '#话题一 #话题二';
  section.append(title, content, topics);
  const actions = document.createElement('div');
  actions.className = 'draft-edit-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'cw-button secondary'; cancel.textContent = '取消编辑';
  cancel.disabled = publishDraftReview.mutationBusy;
  cancel.addEventListener('click', () => { publishDraftReview.editing = false; renderPublishPreviewContent(currentStatus); });
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'cw-button primary'; save.textContent = publishDraftReview.mutationBusy ? '保存中…' : '保存修改';
  save.disabled = publishDraftReview.mutationBusy;
  save.addEventListener('click', () => {
    const nextTopics = topics.value.split(/[\s,，#]+/).map((item) => item.trim()).filter(Boolean);
    if (!title.value.trim() || !content.value.trim()) {
      publishDraftReview.editFeedback = '标题和正文不能为空。';
      renderPublishPreviewContent(currentStatus);
      return;
    }
    void submitPublishDraftEdit(preview, { title: title.value.trim(), content: content.value.trim(), topics: nextTopics });
  });
  actions.append(cancel, save);
  section.appendChild(actions);
  parent.appendChild(section);
}

function appendPublishDraftControls(parent, preview) {
  if (!publishPreviewIsPending(currentStatus)) return;
  const section = document.createElement('section');
  section.className = 'draft-refinement-panel';
  const head = document.createElement('div');
  head.className = 'draft-refinement-head';
  const copy = document.createElement('span');
  appendPreviewText(copy, '继续调整这份草稿');
  appendPreviewText(copy, '可以直接编辑，也可以给 AI 一个明确范围的指令');
  const edit = document.createElement('button');
  edit.type = 'button'; edit.className = 'cw-button secondary'; edit.textContent = '直接编辑';
  edit.disabled = publishDraftReview.mutationBusy || Boolean(publishDraftReview.activeRefinement && ['queued', 'running'].includes(publishDraftReview.activeRefinement.status));
  edit.addEventListener('click', () => { publishDraftReview.editing = true; renderPublishPreviewContent(currentStatus); });
  head.append(copy, edit);
  section.appendChild(head);
  const scopes = document.createElement('div');
  scopes.className = 'draft-refinement-scopes';
  for (const scope of ['whole', 'body', 'images', 'selected_image', 'selected_text']) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = publishDraftScopeLabel(scope);
    button.classList.toggle('active', publishDraftReview.refinementScope === scope);
    button.disabled = publishDraftReview.mutationBusy;
    button.addEventListener('click', () => {
      publishDraftReview.refinementScope = scope;
      publishDraftReview.editFeedback = '';
      renderPublishPreviewContent(currentStatus);
    });
    scopes.appendChild(button);
  }
  section.appendChild(scopes);
  const instruction = document.createElement('textarea');
  instruction.className = 'draft-refinement-instruction';
  instruction.placeholder = publishDraftReview.refinementScope === 'selected_text'
    ? '例如：这段更口语一些，保留原意'
    : publishDraftReview.refinementScope === 'selected_image'
      ? '例如：这张图更生活化，减少棚拍感'
      : '告诉 AI 希望如何调整…';
  instruction.maxLength = 1000;
  instruction.value = publishDraftReview.refinementInstruction;
  instruction.disabled = publishDraftReview.mutationBusy;
  instruction.addEventListener('input', () => { publishDraftReview.refinementInstruction = instruction.value; });
  section.appendChild(instruction);
  if (publishDraftReview.refinementScope === 'selected_image') {
    appendPreviewText(section, publishDraftReview.selectedImageUrl ? '已选择 1 张图片；再次点击其它图片可切换。' : '请先点击上方要调整的那张图片。', 'draft-refinement-selection');
  } else if (publishDraftReview.refinementScope === 'selected_text') {
    const selected = publishDraftReview.selectedTextSelection;
    appendPreviewText(section, selected ? `已选择：${selected.text.slice(0, 48)}${selected.text.length > 48 ? '…' : ''}` : '请在上方正文中拖选要调整的文字。', 'draft-refinement-selection');
  }
  const actions = document.createElement('div');
  actions.className = 'draft-edit-actions';
  appendPreviewText(actions, '只会写回当前待审稿 · 不会自动发布', 'draft-refinement-boundary');
  const submit = document.createElement('button');
  submit.type = 'button'; submit.className = 'cw-button primary';
  submit.textContent = publishDraftReview.mutationBusy ? '正在提交…' : '开始调整';
  submit.disabled = publishDraftReview.mutationBusy || Boolean(publishDraftReview.activeRefinement && ['queued', 'running'].includes(publishDraftReview.activeRefinement.status));
  submit.addEventListener('click', () => { void submitPublishDraftRefinement(preview); });
  actions.appendChild(submit);
  section.appendChild(actions);
  if (publishDraftReview.editFeedback) appendPreviewText(section, publishDraftReview.editFeedback, 'draft-refinement-feedback');
  parent.appendChild(section);
  appendPublishDraftRefinementProgress(parent, publishDraftReview.activeRefinement);
}

// 上一次删配图失败的原因（诚实呈现；成功后清空）。同样存模块级——抽屉每帧重建。
let publishPreviewImageRemoveHint = '';

function resetPublishPreviewImageLightbox() {
  if (!fields.publishPreviewImageLightbox) return;
  fields.publishPreviewImageLightbox.removeAttribute('data-record-id');
  fields.publishPreviewImageLightbox.removeAttribute('data-image-url');
  fields.publishPreviewImageLightboxImage?.removeAttribute('src');
  if (fields.publishPreviewImageLightboxImage) fields.publishPreviewImageLightboxImage.alt = '';
  if (fields.publishPreviewImageLightboxCaption) fields.publishPreviewImageLightboxCaption.textContent = '';
}

function closePublishPreviewImageLightbox() {
  if (!fields.publishPreviewImageLightbox) return;
  if (fields.publishPreviewImageLightbox.open) {
    fields.publishPreviewImageLightbox.close();
    return;
  }
  resetPublishPreviewImageLightbox();
}

function publishPreviewImageLightboxContext(preview, status = currentStatus) {
  // 旧 Cloud 没有列表/详情 RPC 时，selected 是打开页面当下的单稿快照；后续 status 才是继续推进的真态。
  // 新 Cloud 有队列 RPC 时则以当前钻取的 selected 为准，避免后台最新稿心跳误关正在看的另一篇稿件。
  return publishDraftQueueSupported()
    ? preview
    : (status?.publishPreview ? normalizePublishDraft(status.publishPreview) : null);
}

function openPublishPreviewImageLightbox(url, index, preview) {
  if (!fields.publishPreviewImageLightbox || !fields.publishPreviewImageLightboxImage) return;
  const currentPreview = publishPreviewImageLightboxContext(preview);
  const isCurrentImage = String(currentPreview?.recordId ?? '') === String(preview?.recordId ?? '')
    && Array.isArray(currentPreview?.images)
    && currentPreview.images.some((candidate) => String(candidate) === url);
  if (!isCurrentImage) return;
  const label = `配图 ${index + 1} 大图`;
  fields.publishPreviewImageLightbox.dataset.recordId = String(preview?.recordId ?? '');
  fields.publishPreviewImageLightbox.dataset.imageUrl = url;
  fields.publishPreviewImageLightboxImage.src = url;
  fields.publishPreviewImageLightboxImage.alt = label;
  if (fields.publishPreviewImageLightboxCaption) fields.publishPreviewImageLightboxCaption.textContent = label;
  if (!fields.publishPreviewImageLightbox.open) fields.publishPreviewImageLightbox.showModal();
}

function syncPublishPreviewImageLightbox(preview, status) {
  if (!fields.publishPreviewImageLightbox?.open) return;
  const currentPreview = publishPreviewImageLightboxContext(preview, status);
  const recordMatches = fields.publishPreviewImageLightbox.dataset.recordId === String(currentPreview?.recordId ?? '');
  const imageUrl = fields.publishPreviewImageLightbox.dataset.imageUrl || '';
  const imageStillPresent = Array.isArray(currentPreview?.images)
    && currentPreview.images.some((url) => String(url) === imageUrl);
  if (!recordMatches || !imageStillPresent) closePublishPreviewImageLightbox();
}

function repaintPublishPreview() {
  if (fields.publishPreviewPanel && (contentWorkspace?.isDraftOpen() || fields.publishPreviewPanel.classList.contains('open'))) {
    renderPublishPreviewContent(currentStatus);
  }
}

/** 给一张缩略图挂删除入口：常态是右上角 × 角标，点一下切成就地二次确认（绝不单击即删）。 */
function appendPublishPreviewImageDelete(item, url, index) {
  const confirming = publishPreviewPendingDeleteUrl === url;
  if (confirming) {
    const confirm = document.createElement('div');
    confirm.className = 'publish-preview-image-confirm';
    appendPreviewText(confirm, '删除这张？', 'publish-preview-image-confirm-text');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'publish-preview-image-confirm-ok';
    ok.textContent = '删除';
    ok.disabled = publishPreviewActionBusy;
    ok.addEventListener('click', () => { void submitPublishPreviewImageRemove(url); });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'publish-preview-image-confirm-cancel';
    cancel.textContent = '取消';
    cancel.disabled = publishPreviewActionBusy;
    cancel.addEventListener('click', () => {
      publishPreviewPendingDeleteUrl = null;
      repaintPublishPreview();
    });
    confirm.appendChild(ok);
    confirm.appendChild(cancel);
    item.appendChild(confirm);
    item.classList.add('confirming');
    return;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'publish-preview-image-delete';
  btn.textContent = '×';
  btn.title = '删除该张配图';
  btn.setAttribute('aria-label', `删除配图 ${index + 1}`);
  btn.disabled = publishPreviewActionBusy;
  btn.addEventListener('click', () => {
    publishPreviewPendingDeleteUrl = url;
    publishPreviewImageRemoveHint = '';
    repaintPublishPreview();
  });
  item.appendChild(btn);
}

/**
 * 删除一张配图：非乐观——不先行移除缩略图，等云端应答后按写后真态重绘。
 * 删除在途时复用 publishPreviewActionBusy，把「发布 / 取消 / 其余角标」一并禁用：
 * 否则用户能在删除在途时点发布，云端会拿旧版本号去审批而撞版本闸，看到一个莫名其妙的失败。
 */
async function submitPublishPreviewImageRemove(url) {
  const preview = activePublishPreview(currentStatus);
  if (!preview || publishPreviewActionBusy) return;
  if (typeof window.aidcpEdge.delegatedTaskDraft !== 'function') {
    publishPreviewImageRemoveHint = '当前客户端不支持委托修改稿件。';
    publishPreviewPendingDeleteUrl = null;
    repaintPublishPreview();
    return;
  }
  publishPreviewActionBusy = true;
  publishPreviewImageRemoveHint = '';
  syncPublishPreviewActions(currentStatus);
  repaintPublishPreview();

  let created = false;
  try {
    created = await draftDelegatedTask(
      'modify_candidate',
      {
        candidateId: String(preview.recordId),
        candidateVersion: Number.isInteger(preview.contentVersion) ? preview.contentVersion : 0,
        images: (Array.isArray(preview.images) ? preview.images : []).filter((item) => item !== url),
      },
      { envId: currentStatus.envId, targetSuccessCount: 1, maxAttempts: 1 },
    );
  } catch {
    created = false;
  }
  publishPreviewActionBusy = false;
  publishPreviewPendingDeleteUrl = null;
  if (!created) {
    publishPreviewImageRemoveHint = '未能创建修改任务，配图未删除。';
    syncPublishPreviewActions(currentStatus);
    repaintPublishPreview();
    return;
  }
  closePublishPreview();
}

function renderPublishDraftMessage(title, detail, retry) {
  fields.publishPreviewKind.textContent = '待审批稿件';
  fields.publishPreviewContent.replaceChildren();
  const state = document.createElement('div');
  state.className = 'cw-state';
  appendPreviewText(state, title, 'publish-draft-state-title');
  appendPreviewText(state, detail, 'publish-draft-state-detail');
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cw-button secondary';
    button.textContent = '重新读取';
    button.addEventListener('click', () => { void loadPublishDraftList(); });
    state.appendChild(button);
  }
  fields.publishPreviewContent.appendChild(state);
  fields.publishPreviewActions.classList.add('hidden');
}

function renderPublishDraftList() {
  fields.publishPreviewKind.textContent = `待审批稿件 · ${publishDraftReview.total} 条`;
  fields.publishPreviewContent.replaceChildren();
  fields.publishPreviewActions.classList.add('hidden');

  const intro = document.createElement('div');
  intro.className = 'publish-draft-list-intro';
  appendPreviewText(intro, '逐条查看后批准或取消', 'publish-draft-list-title');
  appendPreviewText(intro, '卡片只展示当前账号的待审批内容，打开后可选择立即发布或定时发布。', 'publish-draft-list-copy');
  fields.publishPreviewContent.appendChild(intro);

  const list = document.createElement('div');
  list.className = 'publish-draft-list curated-list';
  for (const item of publishDraftReview.items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'curated-card publish-draft-card';
    card.dataset.publishDraftId = String(item.recordId);
    const imageUrl = item.images.map((value) => String(value || '').trim()).find(Boolean);
    if (imageUrl) {
      const image = document.createElement('img');
      image.className = 'curated-card-image';
      image.src = imageUrl;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      card.appendChild(image);
    } else {
      appendPreviewText(card, '文字', 'curated-card-image placeholder');
    }
    const copy = document.createElement('span');
    copy.className = 'curated-card-copy';
    const top = document.createElement('span');
    top.className = 'curated-card-top';
    const title = document.createElement('strong');
    title.textContent = item.title || '未命名稿件';
    const badge = document.createElement('em');
    badge.className = 'ready';
    badge.textContent = item.publishMode === 'scheduled' ? '已设定时' : '待审批';
    top.append(title, badge);
    copy.appendChild(top);
    appendPreviewText(copy, item.contentPreview || '打开查看完整正文', 'curated-card-body');
    const updatedAt = Number.isFinite(item.updatedAt) && item.updatedAt > 0
      ? new Date(item.updatedAt).toLocaleString()
      : '更新时间未知';
    appendPreviewText(
      copy,
      `${item.kind === 'rewrite' ? '参考创作' : 'AI 创作'} · ${item.images.length} 张图 · v${item.contentVersion} · ${updatedAt}`,
      'curated-card-meta',
    );
    card.appendChild(copy);
    card.addEventListener('click', () => {
      publishDraftReview.scrollTop = fields.publishPreviewPanel.scrollTop;
      void selectPublishDraft(item.recordId);
    });
    list.appendChild(card);
  }
  fields.publishPreviewContent.appendChild(list);

  const pages = Math.max(1, Math.ceil(publishDraftReview.total / PUBLISH_DRAFT_PAGE_SIZE));
  if (pages > 1) {
    const pagination = document.createElement('div');
    pagination.className = 'cw-pagination';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.textContent = '上一页';
    previous.disabled = publishDraftReview.page <= 1;
    previous.addEventListener('click', () => {
      publishDraftReview.page -= 1;
      publishDraftReview.scrollTop = 0;
      void loadPublishDraftList();
    });
    appendPreviewText(pagination, `第 ${publishDraftReview.page} / ${pages} 页`);
    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = '下一页';
    next.disabled = publishDraftReview.page >= pages;
    next.addEventListener('click', () => {
      publishDraftReview.page += 1;
      publishDraftReview.scrollTop = 0;
      void loadPublishDraftList();
    });
    pagination.prepend(previous);
    pagination.appendChild(next);
    fields.publishPreviewContent.appendChild(pagination);
  }
  fields.publishPreviewPanel.scrollTop = publishDraftReview.scrollTop;
}

async function selectPublishDraft(recordId) {
  const envId = publishDraftReview.envId;
  if (!envId || !Number.isInteger(recordId) || recordId <= 0) return;
  const changedRecord = publishDraftReview.selected?.recordId !== recordId;
  if (changedRecord) {
    publishDraftReview.editing = false;
    publishDraftReview.editFeedback = '';
    publishDraftReview.refinementScope = 'whole';
    publishDraftReview.refinementInstruction = '';
    publishDraftReview.selectedImageUrl = '';
    publishDraftReview.selectedTextSelection = null;
    publishDraftReview.activeRefinement = null;
    if (publishDraftRefinementPollTimer) clearTimeout(publishDraftRefinementPollTimer);
    publishDraftRefinementPollTimer = null;
  }
  const epoch = ++publishDraftReview.requestEpoch;
  publishDraftReview.loading = true;
  publishDraftReview.error = '';
  renderPublishPreviewContent(currentStatus);
  let response;
  try {
    response = await window.aidcpEdge.publishDraftGet(envId, recordId);
  } catch {
    response = { ok: false, error: 'request_failed' };
  }
  if (epoch !== publishDraftReview.requestEpoch || envId !== publishDraftReview.envId) return;
  publishDraftReview.loading = false;
  if (!response || response.ok !== true || !response.data?.item) {
    publishDraftReview.error = response?.error || response?.reason || 'request_failed';
    renderPublishPreviewContent(currentStatus);
    return;
  }
  publishDraftReview.selected = normalizePublishDraft(response.data.item);
  publishDraftReview.planRecordId = null;
  initializePublishPlan(publishDraftReview.selected);
  renderPublishPreviewContent(currentStatus);
  const summary = publishDraftReview.items.find((item) => item.recordId === recordId)?.refinement;
  if (summary?.id && changedRecord) void loadPublishDraftRefinement(recordId, summary.id);
}

function useSinglePreviewFallback() {
  const fallback = currentStatus?.publishPreview ? normalizePublishDraft(currentStatus.publishPreview) : null;
  publishDraftReview.loading = false;
  publishDraftReview.loaded = true;
  publishDraftReview.error = '';
  publishDraftReview.items = fallback ? [fallback] : [];
  publishDraftReview.total = fallback ? 1 : 0;
  publishDraftReview.selected = fallback;
  publishDraftReview.planRecordId = null;
  initializePublishPlan(fallback);
  renderPublishPreviewContent(currentStatus);
}

async function loadPublishDraftList() {
  const envId = currentStatus?.envId || currentEnvId();
  if (!envId) {
    useSinglePreviewFallback();
    return;
  }
  resetPublishDraftReview(envId);
  const epoch = ++publishDraftReview.requestEpoch;
  publishDraftReview.loading = true;
  publishDraftReview.error = '';
  publishDraftReview.selected = null;
  publishDraftReview.planRecordId = null;
  renderPublishPreviewContent(currentStatus);

  if (typeof window.aidcpEdge?.publishDraftList !== 'function'
    || typeof window.aidcpEdge?.publishDraftGet !== 'function') {
    useSinglePreviewFallback();
    return;
  }

  let response;
  try {
    response = await window.aidcpEdge.publishDraftList(envId, {
      limit: PUBLISH_DRAFT_PAGE_SIZE,
      offset: (publishDraftReview.page - 1) * PUBLISH_DRAFT_PAGE_SIZE,
    });
  } catch {
    response = { ok: false, error: 'request_failed' };
  }
  if (epoch !== publishDraftReview.requestEpoch || envId !== publishDraftReview.envId) return;
  publishDraftReview.loading = false;
  publishDraftReview.loaded = true;
  if (!response || response.ok !== true || !Array.isArray(response.data?.items)) {
    if ((response?.status === 404 || response?.status === 501 || response?.error === 'pending_drafts_unavailable')
      && currentStatus?.publishPreview) {
      useSinglePreviewFallback();
      return;
    }
    publishDraftReview.error = response?.error || response?.reason || 'request_failed';
    renderPublishPreviewContent(currentStatus);
    return;
  }

  const handled = publishDraftHandledSet(envId);
  const rawItems = response.data.items.map(normalizePublishDraft).filter((item) => item.recordId > 0);
  const handledHere = rawItems.filter((item) => handled.has(item.recordId));
  publishDraftReview.items = rawItems.filter((item) => !handled.has(item.recordId));
  publishDraftReview.total = Math.max(0, Number(response.data.total || 0) - handledHere.length);

  if (publishDraftReview.items.length === 0 && publishDraftReview.total > 0 && publishDraftReview.page > 1) {
    publishDraftReview.page -= 1;
    await loadPublishDraftList();
    return;
  }
  if (publishDraftReview.total === 1 && publishDraftReview.items.length === 1) {
    await selectPublishDraft(publishDraftReview.items[0].recordId);
    return;
  }
  renderPublishPreviewContent(currentStatus);
}

function restorePublishPreviewScrollTop(scrollTop) {
  const panel = fields.publishPreviewPanel;
  if (!panel || !Number.isFinite(scrollTop)) return;
  const restore = () => {
    if (fields.publishPreviewPanel === panel && !panel.classList.contains('hidden')) {
      panel.scrollTop = scrollTop;
    }
  };
  restore();
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(restore);
  } else {
    window.setTimeout(restore, 0);
  }
}

function appendPublishPlanControls(parent, preview) {
  const section = document.createElement('section');
  section.className = 'publish-preview-section publish-plan-section';
  appendPreviewText(section, '批准后的发布方式', 'publish-preview-label');
  const choices = document.createElement('div');
  choices.className = 'publish-plan-choices';
  let syncControls = () => {};
  let timeRow = null;
  let timeInput = null;
  let updateTime = () => {};

  const addChoice = (mode, label, disabled = false) => {
    const choice = document.createElement('label');
    choice.className = 'publish-plan-choice';
    choice.classList.toggle('disabled', disabled);
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'publish-plan-mode';
    input.value = mode;
    input.checked = publishDraftReview.publishMode === mode;
    input.disabled = disabled || publishPreviewActionBusy;
    let interactionScrollTop = null;
    const captureScroll = () => {
      interactionScrollTop = fields.publishPreviewPanel?.scrollTop ?? 0;
    };
    choice.addEventListener('pointerdown', captureScroll);
    choice.addEventListener('mousedown', captureScroll);
    input.addEventListener('change', () => {
      if (!input.checked) return;
      const scrollTop = interactionScrollTop ?? fields.publishPreviewPanel?.scrollTop ?? 0;
      publishDraftReview.publishMode = mode;
      if (mode === 'scheduled' && !publishDraftReview.publishTimeInput) {
        publishDraftReview.publishTimeInput = publishReviewLogic.defaultScheduledInput(Date.now());
      }
      syncControls();
      restorePublishPreviewScrollTop(scrollTop);
      interactionScrollTop = null;
    });
    choice.append(input, document.createTextNode(label));
    choices.appendChild(choice);
  };
  addChoice('immediate', '批准后立即发布');
  addChoice('scheduled', '定时发布', preview.platform !== 'xiaohongshu');
  section.appendChild(choices);

  if (preview.platform !== 'xiaohongshu') {
    appendPreviewText(section, '当前平台暂不支持原生定时发布。', 'publish-preview-hint');
  } else {
    timeRow = document.createElement('div');
    timeRow.className = 'publish-plan-time';
    const caption = document.createElement('label');
    caption.textContent = '发布时间（北京时间）';
    const input = document.createElement('input');
    timeInput = input;
    input.id = `publish-plan-time-${preview.recordId}`;
    caption.htmlFor = input.id;
    input.type = 'datetime-local';
    input.value = publishDraftReview.publishTimeInput;
    input.min = publishReviewLogic.defaultScheduledInput(Date.now());
    input.max = publishReviewLogic.toShanghaiInput(Date.now() + 14 * 24 * 60 * 60 * 1000);
    input.disabled = publishPreviewActionBusy;
    let interactionScrollTop = null;
    const captureScroll = () => {
      interactionScrollTop = fields.publishPreviewPanel?.scrollTop ?? 0;
    };
    const restoreScroll = () => {
      restorePublishPreviewScrollTop(interactionScrollTop ?? fields.publishPreviewPanel?.scrollTop ?? 0);
    };
    input.addEventListener('pointerdown', captureScroll);
    input.addEventListener('mousedown', captureScroll);
    input.addEventListener('keydown', captureScroll);
    input.addEventListener('focus', restoreScroll);
    input.addEventListener('click', restoreScroll);
    const hint = document.createElement('span');
    hint.className = 'publish-preview-hint';
    updateTime = (preserveScroll = false) => {
      publishDraftReview.publishTimeInput = input.value;
      const plan = publishReviewLogic.validatePlan(preview.platform, 'scheduled', input.value, Date.now());
      hint.textContent = plan.ok ? '需在未来 1 小时至 14 天内。' : publishPreviewActionReason(plan.reason);
      hint.classList.toggle('publish-preview-hint-warn', !plan.ok);
      syncPublishPreviewActions(currentStatus);
      if (preserveScroll) restoreScroll();
    };
    input.addEventListener('input', () => updateTime(true));
    input.addEventListener('change', () => {
      updateTime(true);
      interactionScrollTop = null;
    });
    input.addEventListener('blur', () => { interactionScrollTop = null; });
    const shortcuts = document.createElement('div');
    shortcuts.className = 'publish-plan-shortcuts';
    const addShortcut = (kind, label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'publish-plan-shortcut';
      button.dataset.publishTimeShortcut = kind;
      button.textContent = label;
      button.disabled = publishPreviewActionBusy || (kind === 'free' && publishScheduleAvailability().status !== 'ready');
      button.addEventListener('click', () => {
        const scrollTop = fields.publishPreviewPanel?.scrollTop ?? 0;
        const occupiedTimes = kind === 'free' ? publishScheduleOccupiedTimes() : [];
        const nextInput = publishReviewLogic.nextPeakScheduledInput(input.value, occupiedTimes, Date.now());
        if (!nextInput) {
          hint.textContent = kind === 'free' ? '未来 14 天内没有空闲热门时段。' : '未来 14 天内没有可选热门时段。';
          hint.classList.add('publish-preview-hint-warn');
          restorePublishPreviewScrollTop(scrollTop);
          return;
        }
        input.value = nextInput;
        updateTime(false);
        restorePublishPreviewScrollTop(scrollTop);
      });
      shortcuts.appendChild(button);
    };
    addShortcut('peak', '下个热门时段');
    addShortcut('free', '下个空闲时段');
    const shortcutHint = document.createElement('span');
    shortcutHint.className = 'publish-preview-hint publish-plan-shortcut-hint';
    timeRow.append(caption, input, shortcuts, hint, shortcutHint);
    section.appendChild(timeRow);
  }
  syncControls = () => {
    const scheduled = publishDraftReview.publishMode === 'scheduled';
    if (timeRow) timeRow.classList.toggle('hidden', !scheduled);
    if (timeInput && scheduled) {
      if (timeInput.value !== publishDraftReview.publishTimeInput) {
        timeInput.value = publishDraftReview.publishTimeInput;
      }
      updateTime(false);
    } else {
      syncPublishPreviewActions(currentStatus);
    }
  };
  syncControls();
  parent.appendChild(section);
  syncPublishScheduleShortcutAvailability();
}

function renderPublishPreviewContent(status) {
  if (!fields.publishPreviewContent) return;
  const reviewActive = publishDraftReview.envId === status?.envId;
  if (reviewActive && publishDraftReview.loading) {
    closePublishPreviewImageLightbox();
    renderPublishDraftMessage('正在读取待审批稿件', '只会显示当前账号仍待处理的内容。', false);
    return;
  }
  if (reviewActive && publishDraftReview.error) {
    closePublishPreviewImageLightbox();
    renderPublishDraftMessage('暂时无法读取稿件', '请检查连接后重试，当前没有执行任何审批。', true);
    return;
  }
  if (reviewActive && publishDraftReview.loaded && !publishDraftReview.selected) {
    closePublishPreviewImageLightbox();
    if (publishDraftReview.total === 0 || publishDraftReview.items.length === 0) {
      renderPublishDraftMessage('没有待审批稿件', '新稿件生成后会出现在这里。', false);
      return;
    }
    renderPublishDraftList();
    return;
  }
  const preview = activePublishPreview(status);
  syncPublishPreviewImageLightbox(preview, status);
  if (!preview) {
    renderPublishDraftMessage('没有待审批稿件', '新稿件生成后会出现在这里。', false);
    return;
  }
  initializePublishPlan(preview);
  fields.publishPreviewKind.textContent = preview.kind === 'rewrite' ? '洗稿稿件' : 'AI 稿件';
  fields.publishPreviewContent.replaceChildren();

  if (publishDraftReview.selected && publishDraftReview.total > 1) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'publish-draft-back';
    back.textContent = '‹ 返回待审批列表';
    back.addEventListener('click', () => {
      publishDraftReview.selected = null;
      publishDraftReview.planRecordId = null;
      renderPublishPreviewContent(currentStatus);
    });
    fields.publishPreviewContent.appendChild(back);
  }

  // 按小红书稿件阅读顺序：先看配图，再看标题、状态、正文和话题。
  const images = Array.isArray(preview.images) ? preview.images : [];
  const imagesSection = document.createElement('section');
  imagesSection.className = 'publish-preview-section publish-preview-gallery-section';
  appendPreviewText(imagesSection, `配图（${images.length} 张）`, 'publish-preview-label publish-preview-gallery-label');
  if (images.length === 0) {
    appendPreviewText(imagesSection, '暂无可用配图', 'publish-preview-empty');
  } else {
    // 可删条件：稿件待确认 且 至少 2 张（最后一张不可删——无图的图文帖会被发布链路诚实判失败）。
    const canDelete = publishPreviewIsPending(status) && images.length >= 2;
    const imageWrap = document.createElement('div');
    imageWrap.className = 'publish-preview-images';
    imageWrap.dataset.count = String(images.length);
    images.forEach((url, index) => {
      const item = document.createElement('div');
      item.className = 'publish-preview-image';
      item.classList.toggle('refinement-selectable', publishDraftReview.refinementScope === 'selected_image');
      item.classList.toggle('refinement-selected', publishDraftReview.selectedImageUrl === String(url));
      const img = document.createElement('img');
      img.src = String(url);
      img.alt = `配图 ${index + 1}，双击查看大图`;
      img.title = '双击查看大图';
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.addEventListener('dblclick', () => {
        openPublishPreviewImageLightbox(String(url), index, preview);
      });
      img.addEventListener('click', () => {
        if (publishDraftReview.refinementScope !== 'selected_image' || publishDraftReview.mutationBusy) return;
        publishDraftReview.selectedImageUrl = String(url);
        publishDraftReview.editFeedback = '';
        renderPublishPreviewContent(currentStatus);
      });
      img.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openPublishPreviewImageLightbox(String(url), index, preview);
      });
      img.addEventListener('error', () => item.classList.add('failed'), { once: true });
      item.appendChild(img);
      appendPreviewText(item, '图片暂不可用', 'publish-preview-image-fallback');
      if (canDelete) appendPublishPreviewImageDelete(item, String(url), index);
      imageWrap.appendChild(item);
    });
    imagesSection.appendChild(imageWrap);
    if (canDelete) {
      appendPreviewText(imagesSection, '点右上角 × 可删除该张配图（只能删、不能加）', 'publish-preview-hint');
    } else if (images.length === 1 && publishPreviewIsPending(status)) {
      appendPreviewText(imagesSection, '至少保留一张配图', 'publish-preview-hint');
    }
    if (publishPreviewImageRemoveHint) {
      appendPreviewText(imagesSection, publishPreviewImageRemoveHint, 'publish-preview-hint publish-preview-hint-warn');
    }
  }
  fields.publishPreviewContent.appendChild(imagesSection);

  const noteTitle = document.createElement('h2');
  noteTitle.id = 'publish-preview-title';
  noteTitle.className = 'publish-preview-note-title';
  noteTitle.textContent = preview.title || '未命名稿件';
  fields.publishPreviewTitle = noteTitle;
  fields.publishPreviewContent.appendChild(noteTitle);

  const state = publishDraftReview.selected
    ? 'pending'
    : status.publish && status.publish.state ? status.publish.state : 'pending';
  const statusRow = document.createElement('div');
  statusRow.className = 'publish-preview-status';
  const stateText = document.createElement('span');
  stateText.className = 'publish-preview-state';
  stateText.textContent = PUBLISH_PREVIEW_STATES[state] || state;
  statusRow.appendChild(stateText);
  const metaText = document.createElement('span');
  const version = Number.isInteger(preview.contentVersion) ? preview.contentVersion : 0;
  const updatedAt = Number.isFinite(preview.updatedAt) ? new Date(preview.updatedAt).toLocaleString() : '';
  metaText.textContent = `${preview.code || `P-${preview.recordId}`} · v${version}${updatedAt ? ` · 更新于 ${updatedAt}` : ''}`;
  statusRow.appendChild(metaText);
  fields.publishPreviewContent.appendChild(statusRow);

  if (version > 0) {
    appendPreviewText(
      fields.publishPreviewContent,
      `这份稿件已在管理后台修改至 v${version}；原飞书审核卡片可能已失效，请以管理后台当前稿件为准。`,
      'publish-preview-version',
    );
  }

  const bodySection = document.createElement('section');
  bodySection.className = 'publish-preview-section';
  appendPreviewText(bodySection, '正文', 'publish-preview-label');
  const bodyContent = appendPreviewText(bodySection, typeof preview.content === 'string' && preview.content ? preview.content : '暂无正文', 'publish-preview-body');
  bodyContent.classList.toggle('refinement-selectable', publishDraftReview.refinementScope === 'selected_text');
  const captureText = () => {
    if (publishDraftReview.refinementScope !== 'selected_text') return;
    const selected = capturePublishDraftTextSelection(bodyContent, preview);
    if (selected) {
      publishDraftReview.selectedTextSelection = selected;
      publishDraftReview.editFeedback = '';
    }
  };
  bodyContent.addEventListener('mouseup', captureText);
  bodyContent.addEventListener('keyup', captureText);
  fields.publishPreviewContent.appendChild(bodySection);

  const topicsSection = document.createElement('section');
  topicsSection.className = 'publish-preview-section';
  appendPreviewText(topicsSection, '话题', 'publish-preview-label');
  const topics = Array.isArray(preview.topics) ? preview.topics.filter((topic) => String(topic).trim()) : [];
  if (topics.length === 0) {
    appendPreviewText(topicsSection, '暂无话题', 'publish-preview-empty');
  } else {
    const topicWrap = document.createElement('div');
    topicWrap.className = 'publish-preview-topics';
    topics.forEach((topic) => appendPreviewText(topicWrap, `#${String(topic).replace(/^#/, '')}`, 'publish-preview-topic'));
    topicsSection.appendChild(topicWrap);
  }
  fields.publishPreviewContent.appendChild(topicsSection);

  const audit = preview.imageReferenceAudit;
  if (audit && audit.requestedCount > 0) {
    const auditSection = document.createElement('section');
    auditSection.className = 'publish-preview-section';
    const statusLabel = audit.status === 'used'
      ? '图片模型已实际使用参考图生成'
      : audit.status === 'unsupported'
        ? '当前图片厂商不支持参考图，已按文本生成'
        : audit.status === 'unavailable'
          ? '参考图不可用，已按文本生成'
          : '本次未使用参考图，已按文本生成';
    appendPreviewText(auditSection, `配图说明：参考图 ${audit.requestedCount} 张；${statusLabel}。`, 'publish-preview-empty');
    fields.publishPreviewContent.appendChild(auditSection);
  }
  if (publishDraftReview.editing) appendPublishDraftEditing(fields.publishPreviewContent, preview);
  else appendPublishDraftControls(fields.publishPreviewContent, preview);
  if (publishPreviewIsPending(status)) appendPublishPlanControls(fields.publishPreviewContent, preview);
  syncPublishPreviewActions(status);
}

function openPublishPreview(fromQueue = false) {
  const queueWaiting = contentWorkspace?.publishQueueSnapshot?.()?.data?.summary?.waitingForYou > 0;
  if (!currentStatus || (!fromQueue && !queueWaiting && !publishDraftEntryAvailable(currentStatus))) return;
  environmentSchedule?.close();
  syncContentWorkspace(currentStatus);
  resetPublishDraftReview(currentStatus.envId || currentEnvId());
  if (contentWorkspace) {
    contentWorkspace.openDraft();
  } else {
    // 旧测试桩/旧包未加载 content-workspace.js 时的安全降级。
    document.querySelector('#content-workspace')?.classList.remove('hidden');
    document.querySelector('#legacy-workspace')?.classList.add('hidden');
    fields.publishPreviewPanel.classList.remove('hidden');
    fields.publishPreviewPanel.classList.add('open');
    fields.publishPreviewPanel.setAttribute('aria-hidden', 'false');
  }
  void loadPublishDraftList();
  void loadPublishScheduleOccupiedHours(currentStatus.envId || currentEnvId());
}

function openFullPublishQueue() {
  if (!currentStatus || selectedEnvPlatform() !== 'xiaohongshu' || !contentWorkspace?.openPublishQueue) return;
  environmentSchedule?.close();
  syncContentWorkspace(currentStatus);
  contentWorkspace.openPublishQueue();
}

function closePublishPreview() {
  closePublishPreviewImageLightbox();
  if (contentWorkspace?.isDraftOpen()) {
    contentWorkspace.close();
  }
  fields.publishPreviewPanel.classList.remove('open');
  fields.publishPreviewPanel.classList.add('hidden');
  fields.publishPreviewPanel.setAttribute('aria-hidden', 'true');
  // 关抽屉即丢弃未提交的删除确认态与上一次拒因（下次打开是干净的）。
  publishPreviewPendingDeleteUrl = null;
  publishPreviewImageRemoveHint = '';
  publishDraftReview.selected = null;
  publishDraftReview.planRecordId = null;
}

fields.pubPreviewLink.addEventListener('click', () => openPublishPreview(false));
fields.pubQueueLink?.addEventListener('click', openFullPublishQueue);
fields.pubCarouselPrev?.addEventListener('click', () => movePubCarousel(-1));
fields.pubCarouselNext?.addEventListener('click', () => movePubCarousel(1));
async function submitPublishPreviewAction(approved) {
  const preview = activePublishPreview(currentStatus);
  if (!preview || publishPreviewActionBusy) return;
  const actionEnvId = currentStatus.envId;
  const actionRecordId = preview.recordId;
  const actionScheduleAccountKey = publishScheduleAccountKey(currentStatus, actionEnvId);
  const publishApproval = window.aidcpEdge && window.aidcpEdge.publishApproval;
  if (typeof publishApproval !== 'function') {
    fields.publishPreviewActionHint.textContent = '当前客户端不支持应用内审批。';
    return;
  }
  const plan = approved
    ? publishReviewLogic.validatePlan(
        preview.platform,
        publishDraftReview.publishMode,
        publishDraftReview.publishTimeInput,
        Date.now(),
      )
    : null;
  if (plan && !plan.ok) {
    fields.publishPreviewActionHint.textContent = publishPreviewActionReason(plan.reason);
    syncPublishPreviewActions(currentStatus);
    return;
  }
  publishPreviewActionBusy = true;
  syncPublishPreviewActions(currentStatus);
  let result;
  try {
    result = await publishApproval(actionEnvId, {
      requestId: `publish-${preview.recordId}`,
      approved,
      contentVersion: Number.isInteger(preview.contentVersion) ? preview.contentVersion : 0,
      ...(approved ? { publishMode: plan.publishMode, publishTime: plan.publishTime } : {}),
    });
  } catch {
    result = { ok: false, reason: 'request_failed' };
  }
  publishPreviewActionBusy = false;
  const actionStillCurrent = currentStatus
    && currentStatus.envId === actionEnvId
    && Number(activePublishPreview(currentStatus)?.recordId) === Number(actionRecordId);
  if (!actionStillCurrent) {
    // 账号/稿件已切换：云端决定仍以 RPC 真结果为准，但旧应答不得改写或关闭新账号的审核页。
    syncPublishPreviewActions(currentStatus);
    return;
  }
  if (!result || result.ok !== true) {
    syncPublishPreviewActions(currentStatus);
    fields.publishPreviewActionHint.textContent = publishPreviewActionReason(result && result.reason);
    return;
  }
  if (approved && plan?.publishMode === 'scheduled' && Number.isFinite(plan.publishTime)) {
    publishScheduleReservationSet(actionScheduleAccountKey).add(plan.publishTime);
  }
  const nextState = result.state || (approved ? 'approved' : 'rejected');
  publishDraftHandledSet(actionEnvId).add(Number(actionRecordId));
  if (Number(currentStatus.publishPreview?.recordId) === Number(actionRecordId)) {
    currentStatus = {
      ...currentStatus,
      publish: {
        ...(currentStatus.publish || {}),
        state: nextState,
        // 授权的下发进度（change publish-approval-signal-to-database）：让稿件卡把「已批准·待下发」
        // 与「待审批」区分开。旧云端不带这两个字段 → 保持缺省，卡片行为与今天完全一致。
        dispatchState: typeof result.dispatchState === 'string' ? result.dispatchState : undefined,
        dispatchBlockedReason: typeof result.dispatchBlockedReason === 'string' ? result.dispatchBlockedReason : undefined,
        title: currentStatus.publish?.title || preview.title,
        at: new Date().toISOString(),
      },
    };
  }
  renderPublish(currentStatus, Date.now());
  if (typeof window.aidcpEdge?.publishDraftList === 'function') {
    publishDraftReview.selected = null;
    publishDraftReview.planRecordId = null;
    await loadPublishDraftList();
  } else {
    closePublishPreview();
  }
}
fields.publishPreviewApprove.addEventListener('click', () => { void submitPublishPreviewAction(true); });
fields.publishPreviewCancel.addEventListener('click', () => { void submitPublishPreviewAction(false); });
fields.publishPreviewImageLightboxClose?.addEventListener('click', closePublishPreviewImageLightbox);
fields.publishPreviewImageLightbox?.addEventListener('click', (event) => {
  const figure = fields.publishPreviewImageLightbox.querySelector('figure');
  if (event.target === fields.publishPreviewImageLightbox || event.target === figure) {
    closePublishPreviewImageLightbox();
  }
});
fields.publishPreviewImageLightbox?.addEventListener('close', resetPublishPreviewImageLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (fields.publishPreviewImageLightbox?.open) {
    e.preventDefault();
    closePublishPreviewImageLightbox();
    return;
  }
  if (fields.publishPreviewPanel.classList.contains('open')) closePublishPreview();
});

// foot 富文本：仅解析固定文案模板里的 **加粗** 标记（无任何插值，无注入面）。
function renderFootRich(el, text) {
  el.textContent = '';
  String(text).split(/\*\*(.+?)\*\*/g).forEach((seg, i) => {
    if (!seg) return;
    if (i % 2 === 1) {
      const b = document.createElement('b');
      b.textContent = seg;
      el.appendChild(b);
    } else {
      el.appendChild(document.createTextNode(seg));
    }
  });
}

// 收起薄条：点击临时展开（再点卡头收回）；键盘可达。
function togglePubManual() {
  pubManualOpen = !pubManualOpen;
  if (currentStatus) renderPublish(currentStatus, Date.now());
}
function collapsePubManual() {
  if (!pubManualOpen) return;
  pubManualOpen = false;
  if (currentStatus) renderPublish(currentStatus, Date.now());
}
fields.pubBar.addEventListener('click', togglePubManual);
fields.pubBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') togglePubManual();
});
fields.pubHeadRow.addEventListener('click', collapsePubManual);
fields.pubHeadRow.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') collapsePubManual();
});

// ─── 叙述式活动流（环形 ≤200 条，最新在上）───
const STREAM_MAX = 200;
// 事件类型 → 图标字 + 色调（给纯文字流加视觉锚点；这是类型记号，不是 App 图标）。
// 未命中回落 ['·','ic-sys']——这里**不是**过滤器，新类型少了记号只是掉成灰点、条目照常上屏。
// `_pending` / `_failed` 变体**有意与本族共用记号**：句子已经承载真相，逐档换记号只是噪声。
const EV_ICONS = [
  [/^(like|comment_like)$/, ['赞', 'ic-like']],
  [/^follow$/, ['关', 'ic-follow']],
  [/^collect$/, ['藏', 'ic-collect']],
  [/^(comment|comment_pending|comment_failed)$/, ['评', 'ic-comment']],
  [/^(join_group|join_pending|join_failed)$/, ['群', 'ic-join']],
  [/^(search|search_failed)$/, ['搜', 'ic-search']],
  [/^(note_open|feed_video_view|reel_view|images|profile_read)$/, ['读', 'ic-read']],
  [/^popup/, ['注', 'ic-warn']],
  [/^publish/, ['发', 'ic-pub']],
];
function evIcon(type) {
  for (const [re, spec] of EV_ICONS) if (re.test(type || '')) return spec;
  return ['·', 'ic-sys'];
}
function appendActivitySentence(element, sentence) {
  const text = String(sentence || '');
  const match = text.match(/^(.*?)(「[^」]+」)(.*)$/);
  if (!match) {
    element.textContent = text;
    return;
  }
  element.append(document.createTextNode(match[1]));
  const subject = document.createElement('span');
  subject.className = 'ev-subject';
  subject.textContent = match[2];
  element.append(subject, document.createTextNode(match[3]));
}
function domPrependActivity(entry, extraClass) {
  if (!entry || !entry.sentence) return;
  if (fields.streamEmpty) fields.streamEmpty.classList.add('hidden');
  const row = document.createElement('div');
  row.className = `ev${extraClass ? ` ${extraClass}` : ''}`;
  row.dataset.ts = entry.ts || new Date().toISOString();
  const t = document.createElement('span');
  t.className = 'ev-t';
  t.textContent = uiLogic.relTime(Date.parse(row.dataset.ts), Date.now());
  const [glyph, iconCls] = evIcon(entry.type);
  const ic = document.createElement('span');
  ic.className = `ev-ic ${iconCls}`;
  ic.textContent = glyph;
  const x = document.createElement('span');
  x.className = 'ev-x';
  appendActivitySentence(x, entry.sentence);
  row.appendChild(t);
  row.appendChild(ic);
  row.appendChild(x);
  fields.stream.insertBefore(row, fields.stream.firstChild);
  while (fields.stream.querySelectorAll('.ev').length > STREAM_MAX) {
    const evs = fields.stream.querySelectorAll('.ev');
    evs[evs.length - 1].remove();
  }
}

// 每环境活动缓冲（旧→新，≤200 条）：切换环境时按缓冲重建流，绝不串号。
function bufferActivity(envKey, entry, cls) {
  const arr = fleetView.buffers.get(envKey) || [];
  arr.push({ entry, cls });
  while (arr.length > STREAM_MAX) arr.shift();
  fleetView.buffers.set(envKey, arr);
}

/** 面向「当前选中环境」的活动追加（渲染层内部合成的条目也经此入缓冲）。 */
function prependActivity(entry, extraClass) {
  if (!entry || !entry.sentence) return;
  bufferActivity(routeSelKey(), entry, extraClass);
  domPrependActivity(entry, extraClass);
}

/** 主进程活动广播入口：按 entry.envId 归属；非选中环境只进缓冲、不上屏。 */
function routeActivity(entry) {
  if (!entry || !entry.sentence) return;
  const key = entry.envId || routeSelKey();
  bufferActivity(key, entry, undefined);
  if (key === routeSelKey()) domPrependActivity(entry);
}

/** 切换环境后按缓冲整体重建活动流 DOM（旧→新逐条前插 → 最新在上）。 */
function rebuildActivityStream() {
  fields.stream.querySelectorAll('.ev').forEach((row) => row.remove());
  const arr = fleetView.buffers.get(routeSelKey()) || [];
  if (fields.streamEmpty) fields.streamEmpty.classList.toggle('hidden', arr.length > 0);
  for (const item of arr) domPrependActivity(item.entry, item.cls);
}

// 每秒走字：在场感新鲜度 / 发布卡等待时长 / 活动流相对时间（真实时间，不造活跃）。
setInterval(() => {
  if (!currentStatus) return;
  const now = Date.now();
  renderUsageSummary(currentStatus);
  renderRuntimeGuidance(currentStatus, now);
  renderPresence(currentStatus, now);
  renderPublish(currentStatus, now);
  fields.stream.querySelectorAll('.ev').forEach((row) => {
    const ts = Date.parse(row.dataset.ts || '');
    if (Number.isFinite(ts)) row.querySelector('.ev-t').textContent = uiLogic.relTime(ts, now);
  });
  renderRail(); // 失联（stale）判定依赖走钟，每秒重估状态环
}, 1000);

// 委托进度来自云端持久任务投影，不复用本地探索状态。低频轮询只读当前选中环境，
// 让 waiting_approval / 部分完成 / 失败等真实结果无需用户手动刷新即可回到卡片。
setInterval(() => {
  void refreshDelegatedTasks(true);
}, 15_000);

// 客户首页概览是普通 Web 拉取：选中环境低频刷新；浏览器聚焦时补一跳。与自动化 WS 生命周期无关。
setInterval(() => {
  if (fleetView.selected) void ensureEnvironmentOverview(fleetView.selected, { force: true });
}, ENVIRONMENT_OVERVIEW_POLL_MS);
window.addEventListener('focus', () => {
  if (fleetView.selected) void ensureEnvironmentOverview(fleetView.selected, { force: true });
});

function toggleQuotaDetails() {
  quotaDetailsOpen = !quotaDetailsOpen;
  if (quotaDetailsOpen && fleetView.selected) {
    void ensureEnvironmentOverview(fleetView.selected, { force: true });
  }
  if (currentStatus) renderUsageSummary(currentStatus);
}

fields.dailySummary?.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  toggleQuotaDetails();
});

// 环境级慢启动脚注行：**必须自己 stopPropagation**。
// 上面这条整卡点击委托只认 closest('button')，而 checkbox / label 都不是 button →
// 不拦的话点勾选框会连带展开/收起「今日节奏」。更难看的是 <label> 包 <input> 时点文字会合成
// 两次冒泡 → 切换两次 → 净效果为零；直接点滑块只冒泡一次 → 切换一次。**同一控件点在不同位置
// 行为不同，人工点测会当「偶发」放过**。照 quotaToggle 的做法在本控件上拦住，
// **不要**去放宽上面那条委托的判据（那会波及卡内其它元素）。
fields.slowStartToggleWrap?.addEventListener('click', (event) => {
  event.stopPropagation();
});
fields.facebookPersonaModeToggleWrap?.addEventListener('click', (event) => {
  event.stopPropagation();
});
fields.facebookPersonaModeToggle?.addEventListener('change', (event) => {
  event.stopPropagation();
  void submitFacebookOperationMode('persona', Boolean(event.target.checked));
});
fields.slowStartToggle?.addEventListener('change', (event) => {
  event.stopPropagation();
  void submitFacebookOperationMode('slow_start', Boolean(event.target.checked));
});
fields.facebookRuleModeToggleWrap?.addEventListener('click', (event) => {
  event.stopPropagation();
});
fields.facebookRuleModeToggle?.addEventListener('change', (event) => {
  event.stopPropagation();
  void submitFacebookOperationMode('rule', Boolean(event.target.checked));
});
fields.facebookConsumptionModeToggleWrap?.addEventListener('click', (event) => {
  event.stopPropagation();
});
fields.facebookConsumptionModeToggle?.addEventListener('change', (event) => {
  event.stopPropagation();
  void submitFacebookOperationMode('consumption', Boolean(event.target.checked));
});
fields.facebookOperationModeSelect?.addEventListener('change', (event) => {
  event.stopPropagation();
  void submitFacebookOperationMode(String(event.target.value || ''), true);
});
fields.facebookPrimarySurfaceSelect?.addEventListener('change', (event) => {
  event.stopPropagation();
  void submitFacebookPrimarySurface(String(event.target.value || ''));
});

fields.riskRecoveryButton?.addEventListener('click', (event) => {
  event.stopPropagation();
  openEnvironmentRiskRecoveryConfirm();
});

fields.riskRecoveryConfirmClose?.addEventListener('click', () => closeEnvironmentRiskRecoveryConfirm());
fields.riskRecoveryConfirmCancel?.addEventListener('click', () => closeEnvironmentRiskRecoveryConfirm());
fields.riskRecoveryConfirm?.addEventListener('cancel', () => { environmentRiskConfirmContext = null; });
fields.riskRecoveryConfirm?.addEventListener('close', () => { environmentRiskConfirmContext = null; });
fields.riskRecoveryConfirmSubmit?.addEventListener('click', () => {
  const expected = environmentRiskConfirmContext;
  closeEnvironmentRiskRecoveryConfirm('confirmed');
  void submitEnvironmentRiskRecovery(expected);
});

function environmentRiskRecoveryError(result, fallback = '解除失败，请确认网络和账号状态后重试') {
  const payload = result && result.data && result.data.data;
  if (payload && payload.state === 'refused') return '账号当前已不是受限状态，Cloud 已拒绝本次解除';
  if (payload && payload.state === 'failed') return `解除执行失败：${payload.reason || 'Cloud 未返回原因'}`;
  if (payload && payload.state === 'unknown') return 'Cloud 未找到这条解除命令，请刷新账号状态后重试';
  const rawError = result && result.data && result.data.error;
  return String((result && result.data && result.data.message)
    || (rawError && typeof rawError === 'object' && (rawError.message || rawError.code))
    || (typeof rawError === 'string' && rawError)
    || (result && result.error)
    || fallback);
}

function applyEnvironmentRiskRecoveryReceipt(envKey, env, receipt) {
  if (!receipt || receipt.envKey !== envKey || receipt.state !== 'applied' || receipt.status !== 'normal') return false;
  environmentRiskHttpByEnv.set(envKey, {
    kind: 'ok',
    status: receipt.status,
    statusSince: receipt.statusSince,
    updatedAt: receipt.updatedAt,
    fetchedAt: Date.now(),
  });
  env.status = { ...(env.status || {}), risk: receipt.status };
  environmentRiskFeedbackByEnv.delete(envKey);
  return true;
}

function environmentRiskRecoveryCommandIsPending(envKey, commandId) {
  const pending = environmentRiskFeedbackByEnv.get(envKey);
  return Boolean(pending && pending.kind === 'pending' && pending.commandId === commandId);
}

async function pollEnvironmentRiskRecovery({ selectedKey, env, envKey }, commandId) {
  if (!window.aidcpEdge || typeof window.aidcpEdge.getEnvironmentRiskRecoveryResult !== 'function') {
    environmentRiskFeedbackByEnv.set(envKey, {
      kind: 'error',
      message: '客户端缺少解除结果查询能力；命令可能仍在 Cloud 处理中，请刷新状态确认',
    });
    return;
  }
  for (const delayMs of ENVIRONMENT_RISK_RECOVERY_POLL_DELAYS_MS) {
    if (!environmentRiskRecoveryCommandIsPending(envKey, commandId)) return;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (!environmentRiskRecoveryCommandIsPending(envKey, commandId)) return;
    let result;
    try {
      result = await window.aidcpEdge.getEnvironmentRiskRecoveryResult({ envKey, commandId });
    } catch (err) {
      if (!environmentRiskRecoveryCommandIsPending(envKey, commandId)) return;
      environmentRiskFeedbackByEnv.set(envKey, {
        kind: 'error',
        message: `解除结果查询失败：${(err && err.message) || err}`,
      });
      return;
    }
    if (!environmentRiskRecoveryCommandIsPending(envKey, commandId)) return;
    const receipt = result && result.data && result.data.data;
    if (!receipt || receipt.envKey !== envKey || receipt.commandId !== commandId) {
      environmentRiskFeedbackByEnv.set(envKey, {
        kind: 'error',
        message: 'Cloud 返回了不匹配的解除结果，已拒绝更新当前环境',
      });
      return;
    }
    if (result.ok && receipt.state === 'processing') continue;
    if (result.ok && result.status === 200 && applyEnvironmentRiskRecoveryReceipt(envKey, env, receipt)) return;
    environmentRiskFeedbackByEnv.set(envKey, {
      kind: 'error',
      message: environmentRiskRecoveryError(result),
    });
    return;
  }
  environmentRiskFeedbackByEnv.set(envKey, {
    kind: 'pending',
    commandId,
    message: '解除命令已受理，但 Cloud 尚未确认完成；请稍后刷新账号状态',
  });
  if (fleetView.selected === selectedKey) render(env.status || currentStatus);
}

async function submitEnvironmentRiskRecovery(expected) {
  const context = selectedEnvironmentRiskContext();
  if (!context || !window.aidcpEdge || typeof window.aidcpEdge.recoverEnvironmentRisk !== 'function') return;
  if (!expected || expected.selectedKey !== context.selectedKey || expected.envKey !== context.envKey) {
    render(context.env.status || currentStatus || {});
    return;
  }
  const status = effectiveEnvironmentStatus(context.env, context.env.status || currentStatus);
  if (!status || status.risk !== 'restricted') return;

  const { selectedKey, env, envKey } = context;
  if (environmentRiskFeedbackByEnv.get(envKey)?.kind === 'pending') return;
  environmentRiskFeedbackByEnv.set(envKey, { kind: 'pending' });
  if (fleetView.selected === selectedKey) render(env.status || currentStatus);

  const settleError = (message) => {
    environmentRiskFeedbackByEnv.set(envKey, { kind: 'error', message: String(message || '解除失败') });
  };

  try {
    const res = await window.aidcpEdge.recoverEnvironmentRisk({ envKey });
    const receipt = res && res.ok && res.data && res.data.data;
    if (res && res.ok && res.status === 202 && receipt && receipt.envKey === envKey
        && receipt.state === 'processing' && typeof receipt.commandId === 'string' && receipt.commandId) {
      environmentRiskFeedbackByEnv.set(envKey, { kind: 'pending', commandId: receipt.commandId });
      await pollEnvironmentRiskRecovery({ selectedKey, env, envKey }, receipt.commandId);
      return;
    }
    if (!res || !res.ok || res.status !== 200 || !applyEnvironmentRiskRecoveryReceipt(envKey, env, receipt)) {
      settleError(environmentRiskRecoveryError(res));
      return;
    }
  } catch (err) {
    settleError(`解除失败：${(err && err.message) || err}`);
  } finally {
    if (fleetView.selected === selectedKey) render(env.status || currentStatus);
    renderRail();
  }
}

/**
 * 提交 Facebook 统一运行方式：只传 envKey + expectedRevision + mode。
 * 规则/消费节奏与账号选择留在 Cloud；失败必须回读权威真态，不能把本地目标态冒充已生效。
 */
async function submitFacebookOperationMode(mode, enabled) {
  const context = selectedFacebookOperationPolicyContext();
  if (!context || !window.aidcpEdge
      || typeof window.aidcpEdge.setFacebookOperationPolicy !== 'function') return;
  const { envKey } = context;
  const http = facebookOperationPolicyHttpByEnv.get(envKey);
  if (!http || http.kind !== 'ok') return;
  const existing = facebookOperationPolicyFeedbackByEnv.get(envKey);
  if (existing && existing.kind === 'pending') return;
  const currentMode = selectedModeFromFacebookOperationPolicy(http.config);
  if (!enabled && currentMode !== mode) {
    renderFacebookOperationPolicy();
    return;
  }
  const requestedMode = enabled ? mode : 'persona';
  if (requestedMode === currentMode) {
    renderFacebookOperationPolicy();
    return;
  }

  facebookOperationPolicyFeedbackByEnv.set(envKey, {
    kind: 'pending',
    mode: requestedMode,
  });
  renderFacebookOperationPolicy();

  const settleError = (message) => {
    facebookOperationPolicyFeedbackByEnv.set(envKey, {
      kind: 'error',
      message: String(message || '设置失败'),
    });
    // CAS 冲突或异常回包后在后台复读，但 UI 始终保留最后确认 revision；新 GET 成功前不得
    // 把旧选择抹成 unknown，更不能把本次目标态冒充已经生效。
    const current = selectedFacebookOperationPolicyContext();
    if (current && current.envKey === envKey) renderFacebookOperationPolicy();
    void ensureFacebookOperationPolicyHttpFetch(envKey, {
      force: true,
      preserveConfirmed: true,
    });
  };

  try {
    const res = await window.aidcpEdge.setFacebookOperationPolicy({
      envKey,
      expectedRevision: http.config.policyRevision,
      mode: requestedMode,
    });
    const config = normalizeFacebookOperationPolicyResponse(res, envKey);
    if (!config || selectedModeFromFacebookOperationPolicy(config) !== requestedMode) {
      settleError(facebookOperationPolicyError(
        res,
        res && res.ok
          ? 'Cloud 已返回，但运行方式回读与本次选择不一致，请稍后重试'
          : '设置失败',
      ));
      return;
    }
    facebookOperationPolicyFeedbackByEnv.delete(envKey);
    facebookOperationPolicyHttpByEnv.set(envKey, { kind: 'ok', config });
    // 慢启动详情与旧规则兼容呈现都必须重读，不能把切换前缓存继续当作新模式真态。
    slowStartHttpByEnv.delete(envKey);
    facebookRuleModeHttpByEnv.delete(envKey);
    void ensureSlowStartHttpFetch(envKey);
    syncPersonaPresentationForRuleMode(envKey);
    const current = selectedFacebookOperationPolicyContext();
    if (current && current.envKey === envKey) {
      renderSlowStart((current.env && current.env.status) || currentStatus);
      renderFacebookOperationPolicy();
    }
  } catch (err) {
    settleError(`设置失败：${(err && err.message) || err}`);
  }
}

async function submitFacebookPrimarySurface(primarySurface) {
  const context = selectedFacebookOperationPolicyContext();
  if (!context || !FACEBOOK_PRIMARY_SURFACES.has(primarySurface)
      || !window.aidcpEdge
      || typeof window.aidcpEdge.setFacebookPrimarySurface !== 'function') return;
  const { envKey } = context;
  const http = facebookOperationPolicyHttpByEnv.get(envKey);
  if (!http || http.kind !== 'ok') return;
  const existing = facebookOperationPolicyFeedbackByEnv.get(envKey);
  if (existing?.kind === 'pending') return;
  if (http.config.primarySurface === primarySurface) {
    renderFacebookOperationPolicy();
    return;
  }

  facebookOperationPolicyFeedbackByEnv.set(envKey, {
    kind: 'pending',
    primarySurface,
  });
  renderFacebookOperationPolicy();

  const settleError = (message) => {
    facebookOperationPolicyFeedbackByEnv.set(envKey, {
      kind: 'error',
      message: String(message || '设置失败'),
    });
    const current = selectedFacebookOperationPolicyContext();
    if (current && current.envKey === envKey) renderFacebookOperationPolicy();
    void ensureFacebookOperationPolicyHttpFetch(envKey, {
      force: true,
      preserveConfirmed: true,
    });
  };

  try {
    const res = await window.aidcpEdge.setFacebookPrimarySurface({
      envKey,
      expectedRevision: http.config.surfaceRevision,
      primarySurface,
    });
    const config = normalizeFacebookOperationPolicyResponse(res, envKey);
    if (!config || config.primarySurface !== primarySurface) {
      settleError(facebookOperationPolicyError(
        res,
        res && res.ok
          ? 'Cloud 已返回，但主浏览入口回读与本次选择不一致，请稍后重试'
          : '设置失败',
      ));
      return;
    }
    facebookOperationPolicyFeedbackByEnv.delete(envKey);
    facebookOperationPolicyHttpByEnv.set(envKey, { kind: 'ok', config });
    const current = selectedFacebookOperationPolicyContext();
    if (current && current.envKey === envKey) renderFacebookOperationPolicy();
  } catch (err) {
    settleError(`设置失败：${(err && err.message) || err}`);
  }
}

// 旧慢启动/规则写函数仅保留给历史行为测试与兼容路径；当前模式区事件统一走 submitFacebookOperationMode。
async function submitSlowStart(enabled) {
  const context = selectedSlowStartContext();
  if (!context) return;
  const { selectedKey, env, envKey } = context;
  const existing = slowStartFeedbackByEnv.get(envKey);
  if (existing && existing.kind === 'pending') return;

  slowStartFeedbackByEnv.set(envKey, { kind: 'pending', enabled });
  // change 发生后、第一次 await 之前立即上屏，慢网络下也不会出现「点了没反应」。
  renderSlowStart(env.status || currentStatus);

  const settleError = (message) => {
    slowStartFeedbackByEnv.set(envKey, { kind: 'error', message: String(message || '设置失败') });
    if (fleetView.selected === selectedKey) renderSlowStart(env.status || currentStatus);
  };

  try {
    const res = await window.aidcpEdge.setSlowStart({ envKey, enabled });
    if (!res || !res.ok) {
      // 回滚由未被篡改的权威 env.status 重绘；错误独立保留，不能再被 finally 吞掉。
      const rawError = res && res.data && res.data.error;
      const err = (res && res.data && res.data.message)
        || (rawError && typeof rawError === 'object' && (rawError.message || rawError.code))
        || (typeof rawError === 'string' && rawError)
        || (res && res.error)
        || '设置失败';
      settleError(err);
      return;
    }

    // 成功回执本身就是云端写后真态：立即收敛，不再傻等下一次 ui.snapshot（最长 60s）。
    // 只转交 slowStart / dayQuotas，绝不本地推算 day、binding 或计划量。
    const receipt = res.data && res.data.data;
    if (!receipt || !receipt.slowStart || typeof receipt.slowStart !== 'object') {
      settleError('云端已返回，但未带回最新慢启动状态，请稍后重试');
      return;
    }

    slowStartFeedbackByEnv.delete(envKey);
    const dayQuotas = receipt.dayQuotas && typeof receipt.dayQuotas === 'object' ? receipt.dayQuotas : null;
    // 回执对**发起环境**在写入瞬间权威（change slow-start-offline-toggle，D3 优先级③）：写进 HTTP/receipt 缓存，
    // 使**没有活快照**的环境（离线写入）也当场呈现为**已生效**，绝不显示「已保存 / 待本机应用」二态。
    slowStartHttpByEnv.set(envKey, { kind: 'ok', slowStart: receipt.slowStart, dayQuotas });
    // 有活快照的同一 env 对象 → 把回执并进快照（快照来源优先，且带用量计数轴 + 当日上限当场更新）。
    // **不逐字段跨源拼**：慢启动真态整块换成回执的，用量计数仍来自快照——两条独立的轴，不是同一 datum 的合并。
    if (fleetView.envs.get(selectedKey) === env && env.status && env.status.dailyUsage) {
      const dailyUsage = {
        ...env.status.dailyUsage,
        slowStart: receipt.slowStart,
        ...(dayQuotas ? { quotas: { ...dayQuotas } } : {}),
      };
      if (dayQuotas && dailyUsage.windows && typeof dailyUsage.windows === 'object') {
        dailyUsage.windows = {
          ...dailyUsage.windows,
          day: {
            ...(dailyUsage.windows.day && typeof dailyUsage.windows.day === 'object' ? dailyUsage.windows.day : {}),
            quotas: { ...dayQuotas },
          },
        };
      }
      env.status = { ...env.status, dailyUsage };
    }
    // 仍在看同一 env（按 envKey，非对象身份）即重绘：无活快照时靠上面的 HTTP/回执缓存以 HTTP 来源渲染真态。
    const ctxNow = selectedSlowStartContext();
    if (ctxNow && ctxNow.envKey === envKey) render((ctxNow.env && ctxNow.env.status) || currentStatus);
  } catch (err) {
    settleError(`设置失败：${(err && err.message) || err}`);
  }
}

async function submitFacebookRuleMode(enabled) {
  const context = selectedFacebookRuleModeContext();
  if (!context || !window.aidcpEdge || typeof window.aidcpEdge.setFacebookRuleMode !== 'function') return;
  const { envKey } = context;
  const http = facebookRuleModeHttpByEnv.get(envKey);
  if (!http || http.kind !== 'ok') return;
  const existing = facebookRuleModeFeedbackByEnv.get(envKey);
  if (existing && existing.kind === 'pending') return;

  facebookRuleModeFeedbackByEnv.set(envKey, { kind: 'pending', enabled });
  renderFacebookRuleMode();

  const settleError = (message) => {
    facebookRuleModeFeedbackByEnv.set(envKey, {
      kind: 'error',
      message: String(message || '设置失败'),
    });
    const current = selectedFacebookRuleModeContext();
    if (current && current.envKey === envKey) renderFacebookRuleMode();
  };

  try {
    const res = await window.aidcpEdge.setFacebookRuleMode({ envKey, enabled });
    const config = normalizeFacebookRuleModeResponse(res, envKey);
    if (!config) {
      settleError(facebookRuleModeError(
        res,
        res && res.ok
          ? 'Cloud 已返回，但未带回完整规则模式配置，请稍后重试'
          : '设置失败',
      ));
      return;
    }
    facebookRuleModeFeedbackByEnv.delete(envKey);
    facebookRuleModeHttpByEnv.set(envKey, { kind: 'ok', config });
    const current = selectedFacebookRuleModeContext();
    if (current && current.envKey === envKey) renderFacebookRuleMode();
  } catch (err) {
    settleError(`设置失败：${(err && err.message) || err}`);
  }
}
fields.quotaToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleQuotaDetails();
});

// ─── 健康明细浮层 ───
fields.healthPill.addEventListener('click', (event) => {
  event.stopPropagation();
  fields.healthPop.classList.toggle('hidden');
});
fields.proxyRuntimeChip?.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = fields.proxyRuntimePop.classList.contains('hidden');
  fields.proxyRuntimePop.classList.toggle('hidden', !opening);
  fields.proxyRuntimePop.setAttribute('aria-hidden', opening ? 'false' : 'true');
  fields.proxyRuntimeChip.setAttribute('aria-expanded', opening ? 'true' : 'false');
});
document.addEventListener('click', (event) => {
  if (!fields.healthPop.classList.contains('hidden') && !fields.healthPop.contains(event.target)) {
    fields.healthPop.classList.add('hidden');
  }
  if (fields.proxyRuntimePop && !fields.proxyRuntimePop.classList.contains('hidden')
    && !fields.proxyRuntimePop.contains(event.target) && !fields.proxyRuntimeChip.contains(event.target)) {
    fields.proxyRuntimePop.classList.add('hidden');
    fields.proxyRuntimePop.setAttribute('aria-hidden', 'true');
    fields.proxyRuntimeChip.setAttribute('aria-expanded', 'false');
  }
});

// ─── 设置抽屉 ───
function openDrawer() {
  fields.drawer.classList.add('open');
  fields.drawer.setAttribute('aria-hidden', 'false');
  fields.drawerMask.classList.remove('hidden');
}
function closeDrawer() {
  fields.drawer.classList.remove('open');
  fields.drawer.setAttribute('aria-hidden', 'true');
  fields.drawerMask.classList.add('hidden');
}
fields.gear.addEventListener('click', openDrawer);
fields.drawerClose.addEventListener('click', closeDrawer);
fields.drawerMask.addEventListener('click', closeDrawer);

// ─── 环境管理（左栏管理入口拉起）───
function openEnvAddPanel(tab) {
  if (!fields.envAddPanel) return;
  // 必须移除 hidden（.hidden 是 !important、否则面板被钉死 display:none，只见遮罩不见内容）。
  fields.envAddPanel.classList.remove('hidden');
  fields.envAddPanel.classList.add('open');
  fields.envAddPanel.setAttribute('aria-hidden', 'false');
  fields.envAddMask?.classList.remove('hidden');
  switchEnvTab(tab || 'join');
  // 打开即探一次 AdsPower 可用性并列环境（真实事件、低频）。
  if (selectedProvider() === 'adspower') probeAds();
  if (fields.adsTemplate) populateTemplates();
}
function closeEnvAddPanel() {
  if (!fields.envAddPanel) return;
  if (environmentCreateInFlight) {
    setCreateMsg('正在创建环境，请勿关闭客户端…', false);
    return;
  }
  exitBatchProxyMode({ clearText: true });
  fields.envAddPanel.classList.remove('open');
  fields.envAddPanel.classList.add('hidden');
  fields.envAddPanel.setAttribute('aria-hidden', 'true');
  fields.envAddMask?.classList.add('hidden');
}
function switchEnvTab(tab, force) {
  if (environmentCreateInFlight && force !== true) return;
  const join = tab !== 'create';
  if (!join && batchProxyMode) exitBatchProxyMode({ clearText: true });
  fields.envTabJoin?.classList.toggle('active', join);
  fields.envTabCreate?.classList.toggle('active', !join);
  fields.envTabJoin?.setAttribute('aria-selected', join ? 'true' : 'false');
  fields.envTabCreate?.setAttribute('aria-selected', join ? 'false' : 'true');
  fields.envTabJoinBody?.classList.toggle('hidden', !join);
  fields.envTabCreateBody?.classList.toggle('hidden', join);
}
function defaultEnvironmentManagementTab() {
  return railEnvList().length === 0 ? 'create' : 'join';
}
fields.railAdd?.addEventListener('click', () => openEnvAddPanel(defaultEnvironmentManagementTab()));
fields.railFootAdd?.addEventListener('click', () => openEnvAddPanel('join'));
fields.environmentOnboardingCreate?.addEventListener('click', () => openEnvAddPanel('create'));
fields.envAddClose?.addEventListener('click', closeEnvAddPanel);
fields.envAddMask?.addEventListener('click', closeEnvAddPanel);
fields.envTabJoin?.addEventListener('click', () => switchEnvTab('join'));
fields.envTabCreate?.addEventListener('click', () => switchEnvTab('create'));
fields.envCreateCancel?.addEventListener('click', closeEnvAddPanel);
// 待配置引导直达环境管理（不再去设置抽屉）。
fields.noticeAction.addEventListener('click', () => openEnvAddPanel('join'));

// ─── 账号人设浮层（左栏行内人设图标拉起，对「该行环境」做人设）───
// 打开即把该环境设为选中（右侧陪伴视图 + 状态随之切过去），使人设向导的 gate（登录+连云）与草稿归属
// 都锚定这个环境（persist 打回它，绝不跨账号）。头部身份锚点（头像 + 平台小标）把这个事实可视化。
function openPersonaPop(envId, reason = 'manual') {
  if (!fields.personaPop) return;
  if (envId && envId !== fleetView.selected && fleetView.envs.has(envId)) selectEnv(envId);
  const env = fleetView.envs.get(fleetView.selected);
  if (reason !== 'bulk' && !personaAppliesToEnvironment(env)) {
    closePersonaPop(true);
    return;
  }
  const label = resolveEnvironmentDisplayName(env).name;
  const bulk = reason === 'bulk';
  if (fields.personaHeadTitle) fields.personaHeadTitle.textContent = bulk ? '批量设置人设' : '账号人设';
  if (fields.personaPopEnv) fields.personaPopEnv.textContent = bulk ? '· 未设置的 Facebook 账号' : label ? `· ${label}` : '';
  const plat = bulk ? 'facebook' : selectedEnvPlatform();
  const fb = plat === 'facebook';
  if (fields.personaAva) fields.personaAva.textContent = label ? label.slice(0, 1) : '✦';
  if (fields.personaPlat) {
    fields.personaPlat.textContent = platformLabel(plat);
    fields.personaPlat.classList.toggle('plat-facebook', fb);
  }
  fields.personaPop.classList.toggle('plat-facebook', fb);
  fields.personaPop.classList.remove('hidden'); // .hidden 是 !important，必须移除否则只见遮罩不见内容
  fields.personaPop.classList.add('open');
  fields.personaPop.setAttribute('aria-hidden', 'false');
  fields.personaMask?.classList.remove('hidden');
  // 记下「谁弹的」：只有系统自动弹的窗才允许在权威「已绑」到达时被自动收起（见 updatePersonaGate）。
  personaPopOpenReason = bulk ? 'bulk' : reason === 'auto' ? 'auto' : 'manual';
  personaPopOpenEnvId = bulk ? '__facebook_bulk__' : currentEnvId() || envId || null;
  // 批量模板仍是纯本地预览；单账号始终刷新云端真态。该请求不依赖环境 core，停止状态也会进入摘要/向导。
  if (bulk) updatePersonaGate((env && env.status) || null);
  else void loadPersonaView(personaPopOpenEnvId);
}
function openFacebookBulkPersona() {
  const target = filteredRailEnvList()[0] || railEnvList().find((env) => normPlatform(env && env.platform) === 'facebook');
  if (target && target.envId !== fleetView.selected) selectEnv(target.envId);
  personaBulkFillMode = true;
  personaUpdateMode = false;
  personaLocallyBound = false;
  clearPersonaDraft();
  personaWritingLanguageSelections.delete('__facebook_bulk__');
  personaWritingLanguageDirty.delete('__facebook_bulk__');
  if (fields.railFacebookPersonaStatus) fields.railFacebookPersonaStatus.textContent = '';
  openPersonaPop(target && target.envId, 'bulk');
}
function closePersonaPop(force) {
  if (!fields.personaPop) return;
  // 生成在途时误点遮罩不整层关闭（结果会丢在看不见的地方）；× 与「去启动」仍可强制关。
  if (personaInFlight && force !== true) {
    setPersonaMsg('正在生成人设…完成后可关闭。', false);
    return;
  }
  fields.personaPop.classList.remove('open');
  fields.personaPop.classList.add('hidden');
  fields.personaPop.setAttribute('aria-hidden', 'true');
  fields.personaMask?.classList.add('hidden');
  personaPopOpenReason = null;
  personaPopOpenEnvId = null;
  personaBulkFillMode = false;
  if (fields.personaHeadTitle) fields.personaHeadTitle.textContent = '账号人设';
  if (isPersonaGrowthActive()) {
    clearPersonaGrowth();
    personaUi.boundNote?.classList.remove('hidden');
    syncPersonaFoot('hidden');
  }
}
fields.personaClose?.addEventListener('click', () => closePersonaPop(true));
fields.personaMask?.addEventListener('click', () => closePersonaPop(false));
// Escape 关最上层浮层（人设 / 代理 / 添加环境）。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (fields.personaPop && fields.personaPop.classList.contains('open')) closePersonaPop(false);
  else if (fields.proxyPop && fields.proxyPop.classList.contains('open')) closeProxyPop();
  else if (fields.envAddPanel && fields.envAddPanel.classList.contains('open')) closeEnvAddPanel();
});

// ─── 开发者详情：默认不展示，设置抽屉里开关（persisted）───
const devSection = document.querySelector('#dev-section');
const devToggle = document.querySelector('#dev-toggle');
function applyDevVisible(v) {
  devSection.classList.toggle('hidden', !v);
  devToggle.checked = Boolean(v);
}
devToggle.addEventListener('change', () => {
  applyDevVisible(devToggle.checked);
  window.aidcpEdge.saveSettings({ devDetails: devToggle.checked }); // 独立持久化，不打断运行中的自动化引擎
});

// 主控制只表达自动化生命周期；手动浏览器仅在自动化未启动时作为登录/检查入口。
let renderedFabEnvId = null;
function clearFirstEnvironmentStartGuide() {
  firstEnvironmentStartGuideEnvId = null;
  fields.firstEnvironmentStartGuide?.classList.add('hidden');
  fields.sessionFab?.classList.remove('first-environment-start-target');
  fields.sessionFab?.removeAttribute('aria-describedby');
  fields.contentRuntimeToggle?.classList.remove('first-environment-start-target');
  fields.contentRuntimeToggle?.removeAttribute('aria-describedby');
}

function syncFirstEnvironmentStartGuide() {
  const guideEnvId = firstEnvironmentStartGuideEnvId;
  if (!guideEnvId) {
    clearFirstEnvironmentStartGuide();
    return;
  }
  const selectedMatches = currentEnvId() === guideEnvId;
  const renderedMatches = renderedFabEnvId === guideEnvId;
  if (!selectedMatches) {
    clearFirstEnvironmentStartGuide();
    return;
  }
  // 新环境可能已进 fleet、但自己的首个 status 尚未到。此时保留候选但不复用上一环境的按钮动作。
  if (!renderedMatches) {
    fields.firstEnvironmentStartGuide?.classList.add('hidden');
    fields.sessionFab?.classList.remove('first-environment-start-target');
    fields.sessionFab?.removeAttribute('aria-describedby');
    fields.contentRuntimeToggle?.classList.remove('first-environment-start-target');
    fields.contentRuntimeToggle?.removeAttribute('aria-describedby');
    return;
  }
  if (fields.sessionFab?.dataset.action !== 'start') {
    clearFirstEnvironmentStartGuide();
    return;
  }
  fields.firstEnvironmentStartGuide?.classList.remove('hidden');
  fields.sessionFab?.classList.add('first-environment-start-target');
  fields.sessionFab?.setAttribute('aria-describedby', 'first-environment-start-guide');
  const xhsDashboardVisible = selectedEnvPlatform() === 'xiaohongshu'
    && !document.querySelector('#xhs-environment-dashboard')?.classList.contains('hidden');
  fields.contentRuntimeToggle?.classList.toggle('first-environment-start-target', xhsDashboardVisible);
  if (xhsDashboardVisible) fields.contentRuntimeToggle?.setAttribute('aria-describedby', 'first-environment-start-guide');
  else fields.contentRuntimeToggle?.removeAttribute('aria-describedby');
}

function armFirstEnvironmentStartGuide(envId) {
  firstEnvironmentStartGuideEnvId = envId || null;
  syncFirstEnvironmentStartGuide();
}

function renderFab(status) {
  const fab = fields.sessionFab;
  const automation = status.automationState
    || (status.session === 'paused' ? 'paused' : (status.session === 'running' || status.session === 'resting') ? 'running' : 'stopped');
  const running = ['starting', 'ready', 'running', 'waiting_resource'].includes(automation);
  const paused = automation === 'paused';
  const pending = automation === 'pausing' || automation === 'stopping';
  const text = running ? '暂停' : paused ? '恢复' : '启动';
  const cls = running ? 'pause' : 'start';
  const action = running ? 'pause' : paused ? 'resume' : 'start';
  const preserveFirstStartTarget = fab.classList.contains('first-environment-start-target');
  fab.textContent = text;
  fab.setAttribute('aria-label', `${text}自动化`);
  // 普通状态重绘不移除再添加引导 class，避免有限三次的光环动画被无意义地重新计时。
  fab.className = `fab ${cls}${preserveFirstStartTarget ? ' first-environment-start-target' : ''}`;
  fab.dataset.action = action;
  renderedFabEnvId = currentEnvId() || (status && status.envId) || null;
  fab.disabled = pending;
  if (fields.sessionClose) {
    const browser = status.browserState || (status.browserStandby ? 'closed' : status.edge === 'running' ? 'ready' : 'closed');
    const closed = browser === 'closed' || browser === 'error';
    const browserPending = browser === 'queued' || browser === 'starting' || browser === 'closing' || browser === 'releasing';
    // error 仍代表本机启动意图为 enabled，只是引擎已终态失败；保留「关闭」让操作者能明确结束本机意图。
    const automationActive = automation !== 'stopped';
    fields.sessionClose.classList.remove('hidden');
    fields.sessionClose.textContent = automationActive
      ? '关闭'
      : browserPending
        ? (browser === 'closing' || browser === 'releasing' ? '浏览器关闭中' : '浏览器开启中')
        : '浏览器';
    const secondaryLabel = automationActive
      ? (automation === 'stopping' ? '正在关闭自动化' : '关闭自动化')
      : browserPending ? '浏览器处理中' : browser === 'error' ? '重新打开浏览器' : closed ? '打开浏览器' : '关闭浏览器';
    fields.sessionClose.setAttribute('aria-label', secondaryLabel);
    fields.sessionClose.title = secondaryLabel;
    fields.sessionClose.dataset.lifecycleAction = automationActive ? 'close' : '';
    fields.sessionClose.dataset.browserAction = automationActive ? '' : (closed ? 'open' : 'close');
    fields.sessionClose.disabled = pending || (!automationActive && browserPending);
  }
  syncFirstEnvironmentStartGuide();
}

// 内嵌运行时首启内核准备进度条：仅在 kernelPrep 处于下载/安装态时显示；null/完成/失败态隐藏（失败走 edge-failure 呈现）。
function renderKernelPrep(status) {
  if (!fields.kernelPrep) return;
  const kp = status.kernelPrep;
  const active = kp && (kp.state === 'pending' || kp.state === 'downloading' || kp.state === 'installing');
  fields.kernelPrep.classList.toggle('hidden', !active);
  if (!active) return;
  const pct = Math.max(0, Math.min(100, Number(kp.percent) || 0));
  const stateLabel = kp.state === 'installing' ? '正在安装浏览器内核' : '正在下载浏览器内核';
  fields.kernelPrepLabel.textContent = `${stateLabel} ${kp.version || ''}…`.trim();
  fields.kernelPrepPct.textContent = `${pct}%`;
  fields.kernelPrepBar.style.width = `${pct}%`;
}

// 内核首启进度条为「机器级」全局呈现：任一环境在下载/安装内核即显示其进度，与当前选中环境无关。
// （内核是机器共享资源、首启通常只一个环境在下；下载环境若非选中，旧逻辑会让用户看不到任何进度。）
function renderKernelPrepGlobal() {
  let active = null;
  for (const env of fleetView.envs.values()) {
    const kp = env.status && env.status.kernelPrep;
    if (kp && (kp.state === 'pending' || kp.state === 'downloading' || kp.state === 'installing')) {
      active = env.status;
      break;
    }
  }
  renderKernelPrep(active || { kernelPrep: null });
}

function render(status) {
  if (fleetView.selected) void ensureEnvironmentOverview(fleetView.selected);
  status = selectedEffectiveEnvironmentStatus(status);
  currentStatus = status;
  syncDelegatedActionAvailability();
  const now = Date.now();
  setBadge(fields.auth, 'clientSession', status.clientSessionState || 'ready');
  setBadge(fields.cloud, 'engineLink', status.engineLinkState || (status.cloud === 'connected' ? 'connected' : 'disconnected'));
  setBadge(fields.engineLinkDiagnostic, 'engineLink', status.engineLinkState || (status.cloud === 'connected' ? 'connected' : 'disconnected'));
  setBadge(fields.session, 'automation', status.automationState || (status.session === 'running' ? 'running' : status.session === 'paused' ? 'paused' : 'stopped'));
  setBadge(fields.browser, 'browser', status.browserState || 'closed');
  setBadge(fields.risk, 'risk', status.risk);
  setBadge(fields.edge, 'core', status.coreState || (status.edge === 'running' ? 'online' : status.edge === 'starting' ? 'starting' : status.edge === 'warning' ? 'error' : 'stopped'));
  renderUsageSummary(status); // 各计数一律 ?? 0 兜底（旧形状 / 部分补丁都不出空数字）
  // 原始日志记录已移到 routeStatus（按 envId 分桶、覆盖未选中环境）；此处仅刷当前环境的日志 DOM。
  renderLog();
  renderCommandDiagnostics(status, now);
  renderEdgeFailure(status);
  renderTitlebar(status);
  renderRuntimeGuidance(status, now);
  renderPresence(status, now);
  // 内核首启进度条改由 renderKernelPrepGlobal 全局驱动（内核机器级共享、下载环境未必是当前选中环境）；
  // 此处不再按选中环境渲染，避免选中的非下载环境把进度条误藏。
  renderPublish(status, now);
  if (contentWorkspace?.isDraftOpen() || fields.publishPreviewPanel.classList.contains('open')) renderPublishPreviewContent(status);
  renderFab(status);
  renderNotice(status);
  renderSameAccount(status); // 同账号铺多环境告警（多环境 fleet；无告警字段时隐藏，零回归）
  updateSystemProxyUpstreamHint(status);
  updateApplyRestart(); // 依「dirty && 自动化引擎在跑」决定是否显示「按新设置重启」
  updateCloudPending(); // 云端环境（change edge-cloud-env-selector）：随状态心跳刷「当前云端 / 待重启生效」
  if (status.provider && SUBTITLE[status.provider]) fields.subtitle.textContent = SUBTITLE[status.provider];
  // 表单未在编辑时，让 provider 分段跟随实际运行 provider。
  if (status.provider && !editingProvider) applyProviderSelection(status.provider);
  const selectedPersonaApplicable = personaAppliesToEnvironment(fleetView.envs.get(fleetView.selected));
  if (selectedPersonaApplicable) {
    updatePersonaGate(status); // 建号人设只依赖客户会话与 HTTP 权威绑定，不依赖自动化引擎/浏览器
  } else {
    clearPersonaPromptForCurrentEnv();
    if (fields.personaPop?.classList.contains('open') && personaPopOpenReason !== 'bulk') closePersonaPop(true);
  }
  syncInteractionWorkspace();
  syncContentWorkspace(status);
}

// ─── 多环境 fleet：状态路由 / 环境栏 / 引导处理 / 全部启动（edge-multi-environment-fleet）───

function renderSameAccount(status) {
  if (!fields.sameAccountWarn) return;
  const warn = status && status.sameAccountWarning;
  fields.sameAccountWarn.classList.toggle('hidden', !warn);
  if (warn && fields.sameAccountText) fields.sameAccountText.textContent = warn.message || '';
}

/** 主进程状态推送入口：按 envId 归属到对应环境；仅选中环境上屏。无 envId 的旧形状归 '__local__'。 */
function routeStatus(status) {
  if (!status) return;
  const key = status.envId || '__local__';
  let env = fleetView.envs.get(key);
  if (env && env.status) {
    const incomingAt = Date.parse(status.updatedAt || '');
    const currentAt = Date.parse(env.status.updatedAt || '');
    // status:update 推送可能先于 lifecycle IPC 的返回值到达。旧回执不得把环境状态和原始日志
    // 倒放回较早阶段；旧包无时间戳 / 非法时间戳仍按兼容路径接收。
    if (Number.isFinite(incomingAt) && Number.isFinite(currentAt) && incomingAt < currentAt) return;
  }
  if (!env) {
    env = { envId: key, name: status.envName || '', platform: '', status };
    fleetView.envs.set(key, env);
    if (!fleetView.order.includes(key)) fleetView.order.push(key);
  } else {
    env.status = status;
    // 人工昵称一旦落库，运行态心跳里的系统名称只能作为身份事实，不能回写覆盖人工展示名。
    if (status.envName && env.nameSource !== 'manual') env.name = status.envName;
  }
  if (!fleetView.selected) fleetView.selected = key;
  if (environmentOverviewSupported() && key !== '__local__') {
    const signature = JSON.stringify({
      publish: status.publish && {
        state: status.publish.state, code: status.publish.code, title: status.publish.title, at: status.publish.at,
      },
      stats: status.stats || null,
    });
    const previous = environmentOverviewAutomationSigByEnv.get(key);
    environmentOverviewAutomationSigByEnv.set(key, signature);
    if (previous !== undefined && previous !== signature) scheduleEnvironmentOverviewRefresh(key);
  }
  // 原始日志与发布终态折流对**每个**环境记录（含未选中）：未选中环境的日志进其桶、发布终态折进其活动缓冲，
  // 切过去时历史完整、绝不丢，也绝不串到别的环境。
  recordLog(key, status.lastMessage);
  const effective = effectiveEnvironmentStatus(env, status);
  // 新客户端的发布历史只认 HTTP 概览；本地自动化终态只负责使概览失效，不直接写业务历史。
  if (!environmentOverviewSupported() || key === '__local__' || effective.environmentOverview?.confirmed) {
    absorbPublishTerminal(key, effective);
  }
  if (fleetView.selected === key) render(status);
  renderKernelPrepGlobal(); // 内核首启进度条全局呈现，不受「仅选中环境上屏」限制
  renderRail();
  maybeAdvanceGuide();
  updateStartAllProgress(); // 「全部启动」进度随各环境起来实时推进 k/N
}

// 发布终态（published/rejected/failed）折一条叙述进**该环境**的活动缓冲，按签名去重（每环境独立）。
// 覆盖未选中环境（渲染层的 renderPublish 只跑选中环境，会漏掉后台环境的发布叙述）。
function absorbPublishTerminal(envKey, status) {
  if (!status || !status.publish || !window.uiLogic) return;
  const env = fleetView.envs.get(envKey);
  const platform = normPlatform((env && env.platform) || (envKey === fleetView.selected ? selectedPlatform : ''));
  const view = uiLogic.publishView(status.publish, status.lastPublish, Date.now(), platform);
  if (!view.collapsed) { lastPublishSigByEnv.set(envKey, `${status.publish.state}:${status.publish.title || ''}`); return; }
  const sig = `${status.publish.state}:${status.publish.title || ''}`;
  if (sig === (lastPublishSigByEnv.get(envKey) || '')) return;
  lastPublishSigByEnv.set(envKey, sig);
  const entry = {
    ts: status.publish.at || new Date().toISOString(),
    type: `publish_${view.collapsed.type}`,
    sentence: view.collapsed.sentence,
  };
  const cls = view.collapsed.type === 'published' ? 'pub-done' : 'pub-muted';
  bufferActivity(envKey, entry, cls);
  if (envKey === routeSelKey()) domPrependActivity(entry, cls);
}

/** fleet 快照（花名册 + 各环境状态 + 选中项）全量对齐：建行 / 摘行 / 同步选中与收展。 */
function applyFleetSnapshot(snap) {
  if (!snap || !Array.isArray(snap.environments)) return;
  fleetView.rosterPhase = 'ready';
  const prevSelectedPlat = selectedEnvPlatform();
  const known = new Set();
  fleetView.order = [];
  for (const e of snap.environments) {
    if (!e || !e.envId) continue;
    known.add(e.envId);
    fleetView.order.push(e.envId);
    const existing = fleetView.envs.get(e.envId);
    if (existing) {
      // 昵称持久化在途时，旧 fleet 快照不得把乐观名字弹回；成功/失败回执会各自收敛到权威结果。
      if (!manualNicknamePendingEnvIds.has(e.envId)) {
        existing.name = e.name || existing.name;
        existing.systemName = e.systemName || existing.systemName;
        existing.nameSource = e.nameSource === 'manual' ? 'manual' : undefined;
        existing.nameSyncState = existing.nameSource
          && (e.nameSyncState === 'synced' || e.nameSyncState === 'unsynced') ? e.nameSyncState : undefined;
      }
      existing.platform = e.platform || existing.platform;
      existing.profileId = e.profileId || existing.profileId;
      if (e.status) existing.status = e.status;
    } else {
      fleetView.envs.set(e.envId, {
        envId: e.envId,
        profileId: e.profileId || '',
        name: e.name || '',
        systemName: e.systemName || '',
        nameSource: e.nameSource === 'manual' ? 'manual' : undefined,
        nameSyncState: e.nameSource === 'manual'
          && (e.nameSyncState === 'synced' || e.nameSyncState === 'unsynced') ? e.nameSyncState : undefined,
        platform: e.platform || '',
        status: e.status,
      });
    }
  }
  for (const key of [...fleetView.envs.keys()]) {
    if (known.has(key)) continue;
    const goneEnvKey = slowStartEnvKey(fleetView.envs.get(key));
    slowStartFeedbackByEnv.delete(goneEnvKey);
    slowStartHttpByEnv.delete(goneEnvKey); // change slow-start-offline-toggle：连同慢启动 HTTP/回执缓存一并清
    facebookOperationPolicyFeedbackByEnv.delete(goneEnvKey);
    facebookOperationPolicyHttpByEnv.delete(goneEnvKey);
    facebookRuleModeFeedbackByEnv.delete(goneEnvKey);
    facebookRuleModeHttpByEnv.delete(goneEnvKey);
    environmentRiskHttpByEnv.delete(goneEnvKey);
    environmentRiskFeedbackByEnv.delete(goneEnvKey);
    manualNicknamePendingEnvIds.delete(key);
    environmentRiskFetchInFlight.delete(goneEnvKey);
    environmentOverviewByEnv.delete(key);
    environmentOverviewInFlight.delete(key);
    environmentOverviewAutomationSigByEnv.delete(key);
    const overviewTimer = environmentOverviewRefreshTimers.get(key);
    if (overviewTimer) clearTimeout(overviewTimer);
    environmentOverviewRefreshTimers.delete(key);
    fleetView.envs.delete(key); // 快照为准（含 '__local__' 占位）
    // 连同该环境的所有渲染层缓冲一并清（否则同一分身移出再加回会重放上一会话的陈旧活动 + 吞掉新发布折流，
    // 还有全会话内存泄漏）。
    fleetView.buffers.delete(key);
    fleetView.logs.delete(key);
    lastPublishSigByEnv.delete(key);
    if (fleetView.shownEnv === key) fleetView.shownEnv = null;
  }
  fleetView.authoritativeEnvIds = known;
  if (typeof snap.railCollapsed === 'boolean') fleetView.collapsed = snap.railCollapsed;
  if (snap.slots && typeof snap.slots === 'object') fleetView.slots = snap.slots;
  const prevSelected = fleetView.selected;
  if (snap.selectedEnvId && fleetView.envs.has(snap.selectedEnvId)) fleetView.selected = snap.selectedEnvId;
  if (!fleetView.selected || !fleetView.envs.has(fleetView.selected)) fleetView.selected = fleetView.order[0] || null;
  if (fleetView.selected !== prevSelected) {
    if (firstEnvironmentStartGuideEnvId && firstEnvironmentStartGuideEnvId !== fleetView.selected) {
      clearFirstEnvironmentStartGuide();
    }
    closeDelegatedPopover(false);
    syncDelegatedTriggerTasks([]);
    const nextEnv = fleetView.envs.get(fleetView.selected);
    if (!personaAppliesToEnvironment(nextEnv) && fields.personaPop?.classList.contains('open')) closePersonaPop(true);
  }
  if (fleetView.selected && fleetView.selected !== prevSelected) {
    pubManualOpen = false;
    resetPubCarouselSelection();
    closePublishPreview();
    resetPersonaDraft();
    const env = fleetView.envs.get(fleetView.selected);
    if (env && env.status) render(env.status);
    rebuildActivityStream();
    void refreshDelegatedTasks(true, fleetView.selected);
    void ensureEnvironmentOverview(fleetView.selected, { force: true });
  } else if (selectedEnvPlatform() !== prevSelectedPlat) {
    resetPubCarouselSelection();
    // 选中未变但其平台变了（如「改平台」落盘回推）：立即刷标题带等平台标识，不等下一次状态心跳。
    const env = fleetView.envs.get(fleetView.selected);
    if (env && env.status) render(env.status);
  }
  // 即使新环境尚无 status，也必须原子切成它自己的 loading workspace，不能短暂复用上一账号内容。
  syncInteractionWorkspace();
  syncContentWorkspace(fleetView.envs.get(fleetView.selected)?.status);
  // 云端环境（change edge-cloud-env-selector）：目标云端随快照更新；刷新 chip / 当前连接 / 待重启。
  if (snap.cloudEnv) targetCloud = snap.cloudEnv;
  updateCloudPending();
  renderRail();
  completePendingFirstEnvironmentHandoff();
}

async function refreshAuthoritativeFleet(options) {
  if (!window.aidcpEdge || typeof window.aidcpEdge.fleetGet !== 'function') return false;
  const showLoading = Boolean(options && options.showLoading);
  const allowEmpty = !options || options.allowEmpty !== false;
  if (showLoading) {
    fleetView.rosterPhase = 'loading';
    fleetView.lastRailSig = '';
    renderRail();
  }
  try {
    const snapshot = await window.aidcpEdge.fleetGet();
    if (!snapshot || !Array.isArray(snapshot.environments)) throw new Error('invalid_fleet_snapshot');
    // 账号环境同步未成功时，本地空花名册仍是未知态，不能冒充“当前账号确实没有环境”。
    if (!allowEmpty && snapshot.environments.length === 0) throw new Error('environment_roster_unresolved');
    applyFleetSnapshot(snapshot);
    return true;
  } catch {
    if (showLoading) {
      fleetView.rosterPhase = 'error';
      fleetView.lastRailSig = '';
      renderRail();
    }
    return false;
  }
}

function routeFleetSnapshot(snapshot) {
  if (environmentRosterBootstrapPending) {
    if (snapshot && Array.isArray(snapshot.environments)) bufferedEnvironmentRosterSnapshot = snapshot;
    return;
  }
  applyFleetSnapshot(snapshot);
}

async function bootstrapEnvironmentRoster() {
  const epoch = ++environmentRosterBootstrapEpoch;
  let accountRosterResolved = true;
  let initialStatusRequested = false;
  const requestInitialStatus = () => {
    if (initialStatusRequested) return;
    initialStatusRequested = true;
    void window.aidcpEdge.getStatus().then(routeStatus).catch(() => {});
  };
  environmentRosterBootstrapPending = true;
  bufferedEnvironmentRosterSnapshot = null;
  fleetView.rosterPhase = 'loading';
  fleetView.lastRailSig = '';
  renderRail();

  try {
    const settings = await window.aidcpEdge.getSettings();
    if (epoch !== environmentRosterBootstrapEpoch) return;
    applySettings(settings);
    // 首个状态投影必须晚于 settings（平台 / 环境身份），但无需阻塞账号环境同步。
    requestInitialStatus();
    // 客户归属环境会在完整 AdsPower 列表返回后进入本地运行花名册。必须等这一步完成，
    // 才能用 fleet 空数组判断新用户；探测失败时，最终非空 fleet 仍可恢复日常态，空 fleet 则保持未知。
    if (selectedProvider() === 'adspower') accountRosterResolved = await probeAds();
  } catch {
    // 设置 / 本地探测失败不在这里猜空态；下面仍读取 fleet，由现有 error 路径决定是否可重试。
    accountRosterResolved = false;
    requestInitialStatus();
  }
  if (epoch !== environmentRosterBootstrapEpoch) return;

  // 丢弃账号环境同步前的缓存；fleetGet 返回的是同步完成后的当前全量快照。
  bufferedEnvironmentRosterSnapshot = null;
  const resolved = await refreshAuthoritativeFleet({ showLoading: true, allowEmpty: accountRosterResolved });
  if (epoch !== environmentRosterBootstrapEpoch) return;
  const buffered = bufferedEnvironmentRosterSnapshot;
  environmentRosterBootstrapPending = false;
  bufferedEnvironmentRosterSnapshot = null;
  // fleetGet 在途期间到达的推送更新更晚，最后应用；读取失败则保持既有 error 状态。
  if (buffered && Array.isArray(buffered.environments)
    && (accountRosterResolved || buffered.environments.length > 0)) applyFleetSnapshot(buffered);
  else if (!resolved) renderRail();
}

fields.environmentRosterRetry?.addEventListener('click', () => {
  void bootstrapEnvironmentRoster();
});

/** 点选环境：右侧主区域整体切到该环境的陪伴视图（状态 + 活动流 + 发布卡投影一起换，绝不残留）。 */
function selectEnv(envId) {
  if (!envId || !fleetView.envs.has(envId) || envId === fleetView.selected) return;
  if (firstEnvironmentStartGuideEnvId && firstEnvironmentStartGuideEnvId !== envId) clearFirstEnvironmentStartGuide();
  closeDelegatedPopover(false);
  syncDelegatedTriggerTasks([]);
  fleetView.selected = envId;
  pubManualOpen = false;
  resetPubCarouselSelection();
  closePublishPreview();
  resetPersonaDraft(); // 人设向导每环境独立：切换即清草稿，绝不把 A 的草稿误确认到 B
  if (!personaAppliesToEnvironment(fleetView.envs.get(envId)) && fields.personaPop?.classList.contains('open')) closePersonaPop(true);
  syncInteractionWorkspace();
  syncContentWorkspace(fleetView.envs.get(envId)?.status);
  window.aidcpEdge.fleetSelect?.(envId);
  const env = fleetView.envs.get(envId);
  if (env && env.status) render(env.status);
  rebuildActivityStream();
  renderRail();
  void refreshDelegatedTasks(true, envId);
  void ensureEnvironmentOverview(envId, { force: true });
}

function authoritativeFleetEnvironmentForProfile(profileId) {
  const target = String(profileId || '').trim();
  if (!target) return null;
  for (const env of fleetView.envs.values()) {
    if (!env || !fleetView.authoritativeEnvIds.has(env.envId)) continue;
    if (env.profileId === target || env.envId === target || env.envId === `ads-${target}`) return env;
  }
  return null;
}

function completePendingFirstEnvironmentHandoff() {
  const pending = pendingFirstEnvironmentHandoff;
  if (!pending || environmentCreateInFlight || fleetView.rosterPhase !== 'ready') return false;
  if (!rosterHas(pending.profileId)) return false;
  const env = authoritativeFleetEnvironmentForProfile(pending.profileId);
  if (!env) return false;
  pendingFirstEnvironmentHandoff = null;
  if (fleetView.selected !== env.envId) selectEnv(env.envId);
  if (!env.status) renderedFabEnvId = null;
  closeEnvAddPanel();
  armFirstEnvironmentStartGuide(env.envId);
  return true;
}

function railEnvList() {
  return fleetView.order
    .filter((id) => id !== '__local__')
    .map((id) => fleetView.envs.get(id))
    .filter(Boolean)
    .map((env) => ({ ...env, status: effectiveEnvironmentStatus(env, env.status) }));
}

function filteredRailEnvList() {
  const list = railEnvList();
  if (fleetView.platformFilter === 'all') return list;
  return list.filter((env) => normPlatform(env && env.platform) === fleetView.platformFilter);
}

// 保留现有左栏分组框架，只按 ui-logic 的单一 railGroup 真相归组；不再从 level/session 二次猜测。
const isRailGroup = (key) => (row) => !row.needsAction && row.railGroup === key;
const RAIL_GROUPS = [
  { key: 'attn', title: '需要处理', crit: true, has: (r) => r.needsAction },
  { key: 'running', title: '运行中', crit: false, has: isRailGroup('running') },
  { key: 'ready', title: '待任务', crit: false, has: isRailGroup('ready') },
  { key: 'starting', title: '启动中', crit: false, has: isRailGroup('starting') },
  { key: 'queued', title: '排队中', crit: false, has: isRailGroup('queued') },
  { key: 'standby', title: '待机中', crit: false, has: isRailGroup('standby') },
  { key: 'paused', title: '暂停', crit: false, has: isRailGroup('paused') },
  { key: 'offline', title: '离线', crit: false, has: isRailGroup('offline') },
];

// 当前环境身份锚点统一从这里取「显示名 + 来源」。ui-logic.js 是可单测的唯一规则实现；
// renderer 只保留旧包/测试桩未加载新版 uiLogic 时的等价兜底。
function resolveEnvironmentDisplayName(row, status) {
  const candidate = row
    ? { ...row, status: status || row.status }
    : { envId: status && status.envId, status };
  if (window.uiLogic && typeof uiLogic.resolveEnvironmentDisplayName === 'function') {
    return uiLogic.resolveEnvironmentDisplayName(candidate);
  }
  const acct = candidate && candidate.status && candidate.status.account;
  const manualName = candidate && candidate.nameSource === 'manual' && candidate.name ? String(candidate.name) : '';
  const realNick = acct && acct.source !== 'env' && acct.name ? String(acct.name) : '';
  const environmentName = (candidate && (candidate.name || (candidate.status && candidate.status.envName)))
    || (acct && acct.source === 'env' && acct.name ? String(acct.name) : '');
  const envId = candidate && candidate.envId != null ? String(candidate.envId) : '';
  if (manualName) return { name: manualName, source: 'manual' };
  if (realNick) return { name: realNick, source: 'platform' };
  if (environmentName) return { name: String(environmentName), source: 'environment' };
  return { name: envId ? `环境 …${envId.slice(-4)}` : '', source: 'fallback' };
}

function railDisplayName(row) {
  return resolveEnvironmentDisplayName(row).name;
}

let environmentShellState = null;
function syncEnvironmentShellState(state) {
  const loading = state === 'loading';
  const error = state === 'error';
  const empty = state === 'empty';
  const environmentScopedSuppressed = state !== 'ready';
  document.body.classList.toggle('environment-roster-loading', loading);
  document.body.classList.toggle('environment-roster-error', error);
  document.body.classList.toggle('environment-roster-empty', empty);
  fields.environmentRosterLoading?.setAttribute('aria-hidden', loading || error ? 'false' : 'true');
  fields.environmentOnboarding?.setAttribute('aria-hidden', empty ? 'false' : 'true');
  for (const workspace of fields.environmentWorkspaces || []) {
    workspace.classList.toggle('environment-roster-suppressed', environmentScopedSuppressed);
  }
  if (fields.firstUseBrandTitle) {
    fields.firstUseBrandTitle.textContent = loading ? '正在准备' : error ? '读取失败' : '开始使用';
  }
  if (fields.firstUseBrandSubtitle) {
    fields.firstUseBrandSubtitle.textContent = loading ? '同步运行环境' : error ? '请重新读取' : '创建运行环境';
  }
  if (fields.environmentRosterLoadingTitle) {
    fields.environmentRosterLoadingTitle.textContent = error ? '暂时无法读取运行环境' : '正在准备你的工作区';
  }
  if (fields.environmentRosterLoadingCopy) {
    fields.environmentRosterLoadingCopy.textContent = error
      ? '当前无法确认账号下有哪些环境。请重新读取，系统不会把未知状态显示成空环境。'
      : '正在同步当前账号的运行环境，请稍候。';
  }
  fields.environmentRosterRetry?.classList.toggle('hidden', !error);
  if (environmentShellState === state) return;
  const previousState = environmentShellState;
  environmentShellState = state;
  if (environmentScopedSuppressed) {
    // CSS 负责整块隐藏；这里同步环境级浮层的可访问状态，避免恢复后重现旧环境上下文。
    fields.healthPop?.classList.add('hidden');
    fields.proxyRuntimePop?.classList.add('hidden');
    fields.proxyRuntimePop?.setAttribute('aria-hidden', 'true');
    fields.proxyRuntimeChip?.setAttribute('aria-expanded', 'false');
    closeDelegatedPopover(false);
    closePublishPreview();
    if (fields.personaPop?.classList.contains('open')) closePersonaPop(true);
    if (fields.proxyPop?.classList.contains('open')) closeProxyPop();
    contentWorkspace?.close?.();
    return;
  }
  // 第一个环境可能先进入花名册、稍后才收到状态。退出引导时至少用真实环境身份和保守离线态
  // 覆盖旧环境残影，等该环境自己的快照到达后再按正常 render() 更新。
  if (previousState && previousState !== 'ready' && fleetView.selected) {
    const selected = fleetView.envs.get(fleetView.selected);
    if (selected && !selected.status) {
      renderTitlebar({ auth: 'checking', cloud: 'disconnected', session: 'idle', risk: 'normal', edge: 'stopped' });
    }
  }
}

function renderRail() {
  if (!fields.envRail || !window.uiLogic || typeof uiLogic.fleetRailModel !== 'function') return;
  const allList = railEnvList();
  const list = filteredRailEnvList();
  // 环境栏常驻显示（用户要求「左边栏默认展示」）：名册为空也保留栏、露出「＋ 添加环境」入口，
  // 不再按有无环境显隐（此前空名册整栏 hidden，新实例进来完全看不到添加入口）。
  const show = true;
  if (fleetView.rosterPhase !== 'ready') {
    const rosterState = fleetView.rosterPhase === 'error' ? 'error' : 'loading';
    syncEnvironmentShellState(rosterState);
    // 名册未决时不能展示环境数量、占位行或管理入口：这些都会被误读为真实花名册。
    // 整栏隐藏，待账号同步与权威 fleet 快照完成后再原子恢复为空态或日常态。
    fields.envRail.classList.add('hidden');
    fields.envRail.classList.remove('collapsed', 'expanded', 'empty-roster', 'roster-loading');
    fields.fleetRow?.classList.remove('with-rail');
    if (fields.railCount) fields.railCount.textContent = '';
    const sig = `roster:${rosterState}`;
    if (fleetView.lastRailSig === sig) return;
    fleetView.lastRailSig = sig;
    fields.railList.replaceChildren();
    return;
  }
  const rosterEmpty = allList.length === 0;
  syncEnvironmentShellState(rosterEmpty ? 'empty' : 'ready');
  const empty = list.length === 0;
  // 名册空时本次渲染强制展开（把空态提示与添加入口露出来），但不落库、不覆盖用户已保存的收起偏好；
  // 一旦有环境即回落 fleetView.collapsed（默认收起为窄图标条）。
  const collapsed = rosterEmpty ? false : fleetView.collapsed;
  fields.envRail.classList.toggle('hidden', !show);
  fields.envRail.classList.remove('roster-loading');
  fields.fleetRow?.classList.toggle('with-rail', show);
  const model = uiLogic.fleetRailModel(list, Date.now());
  const fullModel = fleetView.platformFilter === 'all' ? model : uiLogic.fleetRailModel(allList, Date.now());
  // 头像三态清理：仅在浏览器确已不在（环境移出 / 核心非运行）时撤销「已显示」相位。
  // 绝不按 level 清——attention（验证码浮层、云端瞬断、风控受限等，核心仍在跑、浏览器仍可控）
  // 必须保留 shown，否则盯验证码的环境永远回不到「归位」态（第三态不可达）。以 status.edge 为准。
  if (fleetView.shownEnv) {
    const shownRow = fullModel.rows.find((r) => r.envId === fleetView.shownEnv);
    const edgeAlive = shownRow && shownRow.status && (shownRow.status.edge === 'running' || shownRow.status.edge === 'starting');
    if (!edgeAlive) fleetView.shownEnv = null;
  }
  const counts = {
    run: model.rows.filter(isRailGroup('running')).length,
    attn: model.pendingCount,
    idle: model.rows.filter((r) => !r.needsAction && r.railGroup !== 'running').length,
  };
  // 变更签名：每秒 stale 重估会反复调本函数，但只有模型真变时才重建 DOM——否则 innerHTML='' 会每秒
  // 打断 1.6s 脉冲动画（视觉抖动）、把行焦点甩回 <body>、并吞掉跨 tick 的点击手势。
  const sig = JSON.stringify({
    show,
    rosterEmpty,
    empty,
    collapsed,
    selected: fleetView.selected,
    shown: fleetView.shownEnv,
    guided: Boolean(fleetView.guided),
    platformFilter: fleetView.platformFilter,
    closeAllPending: fleetView.closeAllPending,
    globalPendingCount: fullModel.pendingCount,
    counts,
    slots: fleetView.slots,
    // platform 必须进签名：改平台后行才会重建上色（漏掉则签名未变、UI 停留旧平台）。
    rows: model.rows.map((r) => [r.envId, r.level, r.state, r.railGroup, r.needsAction, railDisplayName(r), r.nameSource,
      r.nameSyncState, manualNicknamePendingEnvIds.has(r.envId), r.label, r.detail, r.queuePosition,
      Boolean(r.status && r.status.personaBound), normPlatform(r.platform),
      // 规则模式真态是异步读回来的：不进签名，人设图标就会停留在读到之前的「未设置」口径。
      personaRuleModeWithoutPersona(r, r.status)]),
  });
  if (sig === fleetView.lastRailSig) return;
  fleetView.lastRailSig = sig;
  fields.envRail.classList.toggle('collapsed', collapsed);
  fields.envRail.classList.toggle('expanded', !collapsed);
  fields.envRail.classList.toggle('empty-roster', rosterEmpty);
  if (fields.railToggle) {
    // 箭头是内联 SVG（默认朝左=收起方向）；收起态水平翻转指向展开方向，不再切字符。
    fields.railToggle.classList.toggle('flip', collapsed);
    fields.railToggle.title = collapsed ? '展开环境列表' : '收起环境列表';
    fields.railToggle.setAttribute('aria-label', fields.railToggle.title);
  }
  if (fields.railCount) fields.railCount.textContent = String(list.length);
  if (fields.railCapacity) {
    const publicSlots = fleetView.slots && fleetView.slots.public;
    const transient = fleetView.slots && fleetView.slots.transient;
    fields.railCapacity.textContent = publicSlots && transient
      ? `公共浏览器 ${publicSlots.occupied}/${publicSlots.capacity} · 临时通道 ${transient.occupied}/${transient.capacity}`
      : '';
  }
  for (const button of fields.railPlatformFilters || []) {
    const active = button.dataset.railPlatform === fleetView.platformFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  fields.railFacebookPersonaFill?.classList.toggle('hidden', fleetView.platformFilter !== 'facebook');
  if (fields.railSum) fields.railSum.classList.toggle('hidden', collapsed);
  if (fields.railSumRun) fields.railSumRun.textContent = `▶ ${counts.run}`;
  if (fields.railSumAttn) fields.railSumAttn.textContent = `⚠ ${counts.attn}`;
  if (fields.railSumIdle) fields.railSumIdle.textContent = `○ ${counts.idle}`;
  if (fields.railSumRun) fields.railSumRun.title = '正在执行任务';
  if (fields.railSumIdle) fields.railSumIdle.title = '当前未执行任务（含待任务、启动、排队、待机、暂停和离线）';
  if (fields.railBadge) {
    fields.railBadge.textContent = String(fullModel.pendingCount);
    fields.railBadge.classList.toggle('hidden', fullModel.pendingCount === 0);
  }
  if (fields.railGuide) {
    fields.railGuide.classList.toggle('hidden', fullModel.pendingCount === 0 && !fleetView.guided);
    fields.railGuide.textContent = fullModel.pendingCount > 0 ? `引导处理（${fullModel.pendingCount}）` : '引导处理';
  }
  if (fields.railStartAll) {
    fields.railStartAll.disabled = empty || fleetView.closeAllPending;
    fields.railStartAll.title = empty ? '当前分类暂无可开始的自动化' : `为当前分类的 ${list.length} 个环境开始自动化`;
  }
  if (fields.railCloseAll) {
    fields.railCloseAll.disabled = empty || fleetView.closeAllPending;
    fields.railCloseAll.textContent = fleetView.closeAllPending ? '关闭请求中…' : '全部关闭';
    fields.railCloseAll.title = empty ? '当前分类暂无可关闭的环境' : `关闭当前分类的 ${list.length} 个环境`;
  }
  if (!fields.railList) return;
  // 列表现在是栏内定高滚动区：签名一变就整块重建，重建会把滚动位清零。不接管的话，用户往下滚去看后面的
  // 环境时，任何一个环境的状态心跳都会把他甩回顶部。收↔展换的是行高体系（窄图标 vs 宽行），旧滚动位在
  // 新布局里没有意义 → 那一次不还原，改用「把选中行滚进视野」兜底。
  const layoutChanged = collapsed !== fleetView.lastRailCollapsed;
  const selChanged = fleetView.selected !== fleetView.lastRailSel;
  const prevScroll = layoutChanged ? 0 : fields.railList.scrollTop; // 必须在清空之前读（清空后恒为 0）
  fleetView.lastRailCollapsed = collapsed;
  fleetView.lastRailSel = fleetView.selected;
  fields.railList.innerHTML = '';
  if (rosterEmpty) {
    // 空名册空态：这是创建按钮，不是假环境；不挂 envId / 平台头像 / 状态点，也不冒充离线行。
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'rail-empty';
    cta.innerHTML = '<span class="rail-empty-icon" aria-hidden="true">＋</span><span class="rail-empty-title">创建第一个运行环境</span><span class="rail-empty-copy">创建后可在这里切换环境并查看状态</span>';
    cta.addEventListener('click', () => openEnvAddPanel('create'));
    fields.railList.appendChild(cta);
    return; // 空态无可滚内容，滚动位天然为 0
  }
  if (empty) {
    const emptyState = document.createElement('div');
    emptyState.className = 'rail-filter-empty';
    emptyState.textContent = `暂无${platformLabel(fleetView.platformFilter)}环境`;
    fields.railList.appendChild(emptyState);
    return;
  }
  for (const g of RAIL_GROUPS) {
    const groupRows = model.rows.filter(g.has);
    if (groupRows.length === 0) continue;
    const head = document.createElement('div');
    head.className = `rail-group${g.crit ? ' crit' : ''}`;
    head.innerHTML = `${g.title} <span class="n">${groupRows.length}</span>`;
    fields.railList.appendChild(head);
    for (const row of groupRows) fields.railList.appendChild(makeRailRow(row));
  }
  // ① 先还原滚动位：内容变矮（环境被移出）时浏览器自动把赋值夹回 [0, max]，不会悬空成空白。
  fields.railList.scrollTop = prevScroll;
  // ② 再按需把选中行滚进视野：只在选中真的变了、或收展换了布局时做。选中变更的三个入口
  //    （selectEnv / 引导流 showGuideStep / 快照恢复 applyFleetSnapshot）最后都落到这里，一处收口即可；
  //    绝不每次重建都滚——那会跟用户的手动滚动打架。
  if (selChanged || layoutChanged) scrollRailRowIntoView(fields.railList.querySelector('.rail-row.selected'));
}

/** 把某一行滚进环境栏视野（只滚列表容器自己）。
 * 不用 element.scrollIntoView：它会连带滚动所有可滚祖先（文档本身仍可滚），整页会跟着抖一下；
 * 且 jsdom 里根本没有这个方法（裸调会在渲染层抛异常、连带打死整套无头渲染测试）。
 * 这里只改容器 scrollTop，浏览器自动夹在 [0, max]；行已完整可见则一动不动。 */
function scrollRailRowIntoView(row) {
  const list = fields.railList;
  if (!list || !row || list.clientHeight === 0) return; // 尚未布局（高度 0）时不做无意义计算
  const lr = list.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  if (rr.top >= lr.top && rr.bottom <= lr.bottom) return; // 已完整可见
  const pad = 6; // 留一点呼吸位，别贴边
  list.scrollTop += rr.top < lr.top ? rr.top - lr.top - pad : rr.bottom - lr.bottom + pad;
}

function makeRailRow(row) {
  const btn = document.createElement('div');
  const isSelected = row.envId === fleetView.selected;
  const isShown = row.envId === fleetView.shownEnv;
  btn.className = `rail-row lv-${row.level} state-${row.state} plat-${normPlatform(row.platform)}${row.needsAction ? ' pulse' : ''}${isSelected ? ' selected' : ''}${isShown ? ' shown' : ''}`;
  btn.dataset.envId = row.envId;
  btn.tabIndex = 0;
  btn.setAttribute('role', 'button');
  const displayName = railDisplayName(row);
  // 单击只选中，双击头像始终召回；shown 与 selected 独立，避免把选中切换冒充物理窗口归位。
  const nextHint = isShown
    ? '浏览器已在 AIDCP 后方；双击头像可重新召回'
    : '单击选中；双击头像召回浏览器';
  const queueText = row.state === 'queued' && Number.isInteger(row.queuePosition) ? ` #${row.queuePosition}` : '';
  const reasonText = row.detail && row.detail !== row.label ? ` · ${row.detail}` : '';
  btn.title = `${displayName} · ${row.label}${queueText}${reasonText} · ${nextHint}`;
  const ava = document.createElement('span');
  ava.className = 'rail-ava';
  ava.textContent = displayName.slice(0, 1);
  ava.title = '双击召回浏览器';
  if (row.state === 'queued' && Number.isInteger(row.queuePosition)) {
    const queueBadge = document.createElement('span');
    queueBadge.className = 'rail-queue-badge';
    queueBadge.textContent = String(row.queuePosition);
    queueBadge.setAttribute('aria-label', `排队第 ${row.queuePosition} 位`);
    ava.appendChild(queueBadge);
  }
  btn.appendChild(ava);
  const meta = document.createElement('span');
  meta.className = 'rail-meta';
  // 昵称行：昵称 + 人设图标（点击弹独立浮层做人设）
  const nameLine = document.createElement('span');
  nameLine.className = 'rail-nameline';
  const nameEl = document.createElement('span');
  const manualName = row.nameSource === 'manual';
  const pendingName = manualNicknamePendingEnvIds.has(row.envId);
  const unsyncedName = manualName && row.nameSyncState === 'unsynced';
  nameEl.className = `rail-name${manualName ? ' manual' : ''}${pendingName ? ' pending' : ''}${unsyncedName ? ' unsynced' : ''}`;
  nameEl.textContent = displayName;
  nameEl.title = pendingName ? '人工昵称 · 正在保存'
    : unsyncedName ? '人工昵称 · 尚未同步到云端，将在登录后重试'
      : manualName ? '人工昵称 · 双击修改' : '双击修改环境昵称';
  if (pendingName) nameEl.setAttribute('aria-busy', 'true');
  let nameClickTimer = null;
  nameEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.detail > 1) {
      if (nameClickTimer) clearTimeout(nameClickTimer);
      nameClickTimer = null;
      return;
    }
    // 昵称单击与整行一致，只做选择；短暂等待第二击，避免双击编辑同时触发环境切换。
    if (nameClickTimer) clearTimeout(nameClickTimer);
    nameClickTimer = setTimeout(() => {
      nameClickTimer = null;
      selectEnv(row.envId);
    }, 220);
  });
  nameEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (nameClickTimer) clearTimeout(nameClickTimer);
    nameClickTimer = null;
    beginRailNameEdit(row, nameEl);
  });
  nameLine.appendChild(nameEl);
  if (personaAppliesToEnvironment(row)) {
    const bound = Boolean(row.status && row.status.personaBound);
    // 第四种呈现（change facebook-rule-mode-without-persona）：云端确认未绑 + 该环境规则模式已开启 →
    // 「按规则运行、未绑人设」。既不说「未设置（点击设置）」（那是催运营做无用功），也不冒充已设置。
    const ruleModeUnbound = !bound && personaRuleModeWithoutPersona(row, row.status);
    const pIcon = document.createElement('button');
    pIcon.type = 'button';
    pIcon.className = `rail-persona${bound ? ' set' : ruleModeUnbound ? ' rule-mode' : ''}`;
    pIcon.textContent = '✦';
    pIcon.title = bound
      ? '账号人设：已设置（点击查看 / 调整）'
      : ruleModeUnbound
        ? '账号人设：未绑定 · 该环境按规则模式运行，无需补人设（点击查看 / 设置）'
        : '账号人设：未设置（点击设置）';
    pIcon.setAttribute('aria-label', pIcon.title);
    pIcon.addEventListener('click', (e) => { e.stopPropagation(); openPersonaPop(row.envId); });
    nameLine.appendChild(pIcon);
  }
  meta.appendChild(nameLine);
  // 状态行：状态点 + 文案
  const stateEl = document.createElement('span');
  stateEl.className = 'rail-state';
  const dot = document.createElement('span');
  dot.className = 'rail-dot';
  stateEl.appendChild(dot);
  stateEl.appendChild(document.createTextNode(row.label));
  if (row.state === 'queued' && Number.isInteger(row.queuePosition)) {
    const queuePosition = document.createElement('span');
    queuePosition.className = 'rail-queue-position';
    queuePosition.textContent = `#${row.queuePosition}`;
    queuePosition.setAttribute('aria-label', `排队第 ${row.queuePosition} 位`);
    stateEl.appendChild(queuePosition);
  }
  if (row.detail) stateEl.title = row.detail;
  meta.appendChild(stateEl);
  btn.appendChild(meta);
  let rowClickTimer = null;
  btn.addEventListener('click', (e) => {
    if (e.detail > 1) {
      if (rowClickTimer) clearTimeout(rowClickTimer);
      rowClickTimer = null;
      return;
    }
    // 第一击不能立刻重绘环境栏，否则会替换头像 DOM，使浏览器无法在同一节点上完成 dblclick。
    if (rowClickTimer) clearTimeout(rowClickTimer);
    rowClickTimer = setTimeout(() => {
      rowClickTimer = null;
      selectEnv(row.envId); // 单击只选中；已选中时是 no-op，绝不控制浏览器窗口。
    }, 220);
  });
  ava.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (rowClickTimer) clearTimeout(rowClickTimer);
    rowClickTimer = null;
    void onRailAvatarRecall(row.envId);
  });
  btn.addEventListener('keydown', (e) => {
    // 只在整行本身聚焦时响应键盘：焦点在行内的人设 ✦ 按钮上时 e.target≠btn，放行让按钮原生激活（开人设浮层），
    // 否则本处 preventDefault 会吞掉按钮激活、还把三态切换误触发在人设图标上。
    if (e.target !== btn) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectEnv(row.envId); }
  });
  return btn;
}

/** 昵称乐观变化后，只重绘环境身份锚点；不重跑生命周期或业务状态副作用。 */
function refreshEnvironmentIdentityAnchors(envId) {
  fleetView.lastRailSig = '';
  renderRail();
  if (lastProfiles.length > 0 && fields.envAddPanel?.classList.contains('open')) {
    populateEnvs(lastProfiles);
    if (batchProxyMode) void refreshBatchProxyPreview();
  }
  if (!envId || fleetView.selected !== envId) return;
  const env = fleetView.envs.get(envId);
  const status = env && effectiveEnvironmentStatus(env, env.status || currentStatus);
  if (status) {
    renderTitlebar(status);
    syncInteractionWorkspace();
    syncContentWorkspace(status);
  }
  if (env && fields.personaPop && fields.personaPop.classList.contains('open')
    && fields.personaHeadTitle && fields.personaHeadTitle.textContent !== '批量设置人设') {
    const label = resolveEnvironmentDisplayName(env, status).name;
    if (fields.personaPopEnv) fields.personaPopEnv.textContent = label ? `· ${label}` : '';
    if (fields.personaAva) fields.personaAva.textContent = label ? label.slice(0, 1) : '✦';
  }
  if (env && fleetView.guided && fleetView.guided.current === envId && fields.guideTitle
    && fields.guidePanel && !fields.guidePanel.classList.contains('hidden')) {
    const q = guideQueue();
    const target = q.find((item) => item.envId === envId);
    if (target) fields.guideTitle.textContent = `引导处理（剩 ${q.length} 个）：${resolveEnvironmentDisplayName(env, status).name}`;
  }
}

/** 左栏昵称就地编辑：先乐观显示，再等待主进程原子持久化；失败恢复原昵称与来源。 */
function beginRailNameEdit(row, nameEl) {
  if (manualNicknamePendingEnvIds.has(row.envId)) {
    setRailMsg('该环境昵称正在保存，请等待确认。');
    return;
  }
  const profileId = String((row && row.profileId) || '').trim();
  const member = roster.find((item) => item.profileId === profileId);
  if (!member) {
    setRailMsg('该环境尚未加入，暂不能修改昵称。');
    return;
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rail-name-editor';
  input.value = railDisplayName(row);
  const originalNickname = input.value.trim();
  input.maxLength = 80;
  input.setAttribute('aria-label', '修改环境昵称');
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const closeEditor = () => refreshEnvironmentIdentityAnchors(row.envId);
  const commit = async () => {
    if (settled) return;
    settled = true;
    const nickname = input.value.trim();
    if (nickname === originalNickname) {
      closeEditor();
      return;
    }
    if (!nickname && member.nameSource !== 'manual') {
      closeEditor();
      return;
    }

    const previousMember = { ...member };
    const envBefore = fleetView.envs.get(row.envId);
    const previousEnv = envBefore ? { ...envBefore } : null;
    const liveAccount = envBefore && envBefore.status && envBefore.status.account;
    const liveSystemName = liveAccount && liveAccount.source !== 'env' && liveAccount.name
      ? String(liveAccount.name).trim() : '';
    const systemName = String(member.systemName || (envBefore && envBefore.systemName) || liveSystemName
      || (member.nameSource !== 'manual' ? member.name : '') || '').trim();
    const optimisticName = nickname || systemName;

    manualNicknamePendingEnvIds.add(row.envId);
    member.name = optimisticName;
    if (systemName) member.systemName = systemName;
    if (nickname) {
      member.nameSource = 'manual';
      member.nameSyncState = 'unsynced';
    } else {
      delete member.nameSource;
      delete member.nameSyncState;
    }
    if (settingsUi.adsProfile.value.trim() === member.profileId) selectedProfileName = optimisticName;
    if (envBefore) {
      envBefore.name = optimisticName;
      if (systemName) envBefore.systemName = systemName;
      if (nickname) {
        envBefore.nameSource = 'manual';
        envBefore.nameSyncState = 'unsynced';
      } else {
        delete envBefore.nameSource;
        delete envBefore.nameSyncState;
      }
    }
    closeEditor();
    setRailMsg(nickname ? `正在保存人工昵称「${nickname}」…` : '正在清除人工昵称并恢复系统昵称…');

    let saved;
    try {
      if (!window.aidcpEdge || typeof window.aidcpEdge.saveEnvironmentNickname !== 'function') {
        throw new Error('当前客户端未加载昵称保存能力，请重启客户端后再试。');
      }
      saved = await window.aidcpEdge.saveEnvironmentNickname({ profileId, nickname });
    } catch (error) {
      saved = { ok: false, error: error && error.message ? error.message : '昵称保存请求失败。' };
    }
    if (!saved || saved.ok !== true) {
      const currentMember = roster.find((item) => item.profileId === profileId);
      if (currentMember) {
        Object.assign(currentMember, previousMember);
        if (!previousMember.systemName) delete currentMember.systemName;
        if (!previousMember.nameSource) delete currentMember.nameSource;
        if (!previousMember.nameSyncState) delete currentMember.nameSyncState;
      }
      const currentEnv = fleetView.envs.get(row.envId);
      if (currentEnv && previousEnv) {
        Object.assign(currentEnv, previousEnv);
        if (!previousEnv.systemName) delete currentEnv.systemName;
        if (!previousEnv.nameSource) delete currentEnv.nameSource;
        if (!previousEnv.nameSyncState) delete currentEnv.nameSyncState;
      }
      if (settingsUi.adsProfile.value.trim() === profileId) selectedProfileName = previousMember.name;
      manualNicknamePendingEnvIds.delete(row.envId);
      refreshEnvironmentIdentityAnchors(row.envId);
      setRailMsg(`昵称保存失败，已恢复「${previousMember.name || railDisplayName(row)}」：${saved && saved.error ? saved.error : '未知错误'}`);
      return;
    }
    const confirmed = saved.environment || {};
    const confirmedManual = confirmed.nameSource === 'manual' || (Boolean(nickname) && !saved.environment);
    const currentMember = roster.find((item) => item.profileId === profileId);
    const currentEnv = fleetView.envs.get(row.envId);
    if (currentMember) {
      currentMember.name = confirmed.name || optimisticName;
      if (confirmed.systemName) currentMember.systemName = confirmed.systemName;
      if (confirmedManual) currentMember.nameSource = 'manual';
      else delete currentMember.nameSource;
      if (confirmed.nameSyncState) currentMember.nameSyncState = confirmed.nameSyncState;
      else if (confirmedManual) currentMember.nameSyncState = 'synced';
      else delete currentMember.nameSyncState;
    }
    if (currentEnv) {
      currentEnv.name = confirmed.name || optimisticName;
      if (confirmed.systemName) currentEnv.systemName = confirmed.systemName;
      if (confirmedManual) currentEnv.nameSource = 'manual';
      else delete currentEnv.nameSource;
      if (confirmed.nameSyncState) currentEnv.nameSyncState = confirmed.nameSyncState;
      else if (confirmedManual) currentEnv.nameSyncState = 'synced';
      else delete currentEnv.nameSyncState;
    }
    if (settingsUi.adsProfile.value.trim() === profileId) selectedProfileName = confirmed.name || optimisticName;
    manualNicknamePendingEnvIds.delete(row.envId);
    refreshEnvironmentIdentityAnchors(row.envId);
    setRailMsg(nickname
      ? `已保存人工昵称「${confirmed.name || nickname}」，后续系统更新不会覆盖。`
      : `已清除人工昵称，恢复系统昵称「${confirmed.name || optimisticName || '未获取昵称'}」。`);
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      settled = true;
      closeEditor();
    }
  });
  input.addEventListener('blur', () => { void commit(); });
}

// 环境头像三态已收敛为双击独占召回：主进程把其他可控浏览器按各自配置归位，再把目标放到 AIDCP 正后方。
// 单击环境行只做选择；同一头像重复双击仍是召回，绝不反向触发目标归位。
// 引导登录仍调用 showDrivenBrowser，浏览器保持前台供人工处理，不进入本互斥编排。
async function onRailAvatarRecall(envId) {
  if (!envId || !fleetView.envs.has(envId)) return;
  const epoch = ++fleetView.browserRecallEpoch;
  if (envId !== fleetView.selected) selectEnv(envId);
  const api = window.aidcpEdge.recallExclusiveBrowser;
  if (typeof api !== 'function') return;
  try {
    const r = await api(envId);
    if (epoch !== fleetView.browserRecallEpoch || (r && r.superseded)) return;
    if (r && r.ok) {
      fleetView.shownEnv = envId;
      const failures = Array.isArray(r.parkFailures) ? r.parkFailures : [];
      const count = Number.isInteger(r.parkFailureCount) ? r.parkFailureCount : failures.length;
      const names = failures.map((failure) => String(failure?.name || failure?.envId || '')).filter(Boolean);
      setRailMsg(count > 0
        ? `目标浏览器已调出，但 ${count} 个其他环境未能归位${names.length > 0 ? `：${names.join('、')}` : ''}`
        : '');
      renderRail();
    } else {
      if (r && r.otherParkingAttempted) fleetView.shownEnv = null;
      setRailMsg(`显示浏览器失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`);
      renderRail();
    }
  } catch (e) {
    if (epoch !== fleetView.browserRecallEpoch) return;
    setRailMsg(`显示浏览器失败：${(e && e.message) || e}`);
  }
}

function setRailMsg(text) {
  if (fields.railMsg) fields.railMsg.textContent = text || '';
}

fields.railToggle?.addEventListener('click', () => {
  fleetView.collapsed = !fleetView.collapsed;
  window.aidcpEdge.fleetSetRailCollapsed?.(fleetView.collapsed);
  renderRail();
});

for (const button of fields.railPlatformFilters || []) {
  button.addEventListener('click', () => {
    const next = button.dataset.railPlatform || 'all';
    if (next === fleetView.platformFilter) return;
    fleetView.platformFilter = next;
    fleetView.lastRailSig = '';
    const visible = filteredRailEnvList();
    if (visible.length > 0 && !visible.some((env) => env.envId === fleetView.selected)) {
      selectEnv(visible[0].envId);
    } else {
      renderRail();
    }
  });
}

fields.railFacebookPersonaSubmit?.addEventListener('click', () => openFacebookBulkPersona());

// ── 「全部开始自动化」：每个环境按需启动引擎，浏览器执行器进入有界槽位/启动队列 ──
async function doStartAll() {
  const api = window.aidcpEdge.fleetStartAll;
  if (typeof api !== 'function') return;
  const envIds = filteredRailEnvList().map((env) => env.envId);
  if (envIds.length === 0) {
    setRailMsg('当前分类没有可开始自动化的环境。');
    return;
  }
  const res = await api({ envIds });
  if (res && res.ok) {
    if (res.queued > 0 && Array.isArray(res.envIds)) {
      fleetView.startAll = {
        ids: res.envIds,
        total: res.queued,
        controlOnly: Number(res.controlOnly) || 0,
        rejected: Number(res.rejected) || 0,
        queueLimit: Number(res.queueLimit) || 0,
      };
      updateStartAllProgress();
    } else if (res.queued > 0) {
      setRailMsg(`已为 ${res.queued} 个环境排队开始自动化（浏览器执行器错峰取得）。`); // 旧主进程无 envIds 时兜底
    } else if (Number(res.controlOnly) > 0) {
      setRailMsg(`${res.controlOnly} 个自动化引擎正在等待浏览器执行槽位。`);
    } else if (Number(res.rejected) > 0) {
      setRailMsg(`浏览器执行队列已满，本次有 ${res.rejected} 个环境未加入自动化（排队上限 ${res.queueLimit}）。`);
    } else {
      setRailMsg('没有待开始的自动化。');
    }
  }
}

// 「全部关闭」与单环境关闭共享 stopAutomation 真语义；这里只提交当前平台筛选范围，
// 主进程仍会用实时句柄二次收口。回执只表示已受理，逐环境终态继续看状态行。
async function doCloseAll() {
  const api = window.aidcpEdge.fleetCloseAll;
  if (typeof api !== 'function' || fleetView.closeAllPending) return;
  const envIds = filteredRailEnvList().map((env) => env.envId);
  if (envIds.length === 0) {
    setRailMsg('当前分类没有可关闭的环境。');
    return;
  }
  fleetView.closeAllPending = true;
  fleetView.lastRailSig = '';
  setRailMsg(`正在关闭 ${envIds.length} 个环境…`);
  renderRail();
  try {
    const res = await api({ envIds });
    if (res && res.ok) {
      const accepted = Number(res.accepted) || 0;
      setRailMsg(accepted > 0
        ? `已受理 ${accepted} 个环境的关闭请求，请查看各环境状态。`
        : '没有仍可关闭的环境。');
    } else {
      setRailMsg(`全部关闭失败：${(res && res.error) || '请求未被主进程受理'}`);
    }
  } catch (e) {
    setRailMsg(`全部关闭失败：${(e && e.message) || e}`);
  } finally {
    fleetView.closeAllPending = false;
    fleetView.lastRailSig = '';
    renderRail();
  }
}

// 「全部开始自动化」实时进度（如实呈现 k/N）：随各环境状态推送重算已起数，全起后收尾。
// 精确「下一个 Ns 后」倒计时依赖错峰队列时序（未透传渲染层），当前以每行「第 N 位」传达顺序。
function updateStartAllProgress() {
  const sa = fleetView.startAll;
  if (!sa) return;
  const launched = sa.ids.filter((id) => {
    const e = fleetView.envs.get(id);
    return e && e.status && typeof uiLogic.batchStartReady === 'function' && uiLogic.batchStartReady(e.status);
  }).length;
  if (launched >= sa.total) {
    const suffix = sa.controlOnly > 0
      ? `；另 ${sa.controlOnly} 个自动化引擎已连接，浏览器暂未入队`
      : sa.rejected > 0
        ? `；另 ${sa.rejected} 个未加入自动化请求`
        : '';
    setRailMsg(`已有 ${sa.total} 个环境开始自动化${suffix}。`);
    fleetView.startAll = null;
    return;
  }
  setRailMsg(`自动化启动中 ${launched}/${sa.total} · 其余 ${sa.total - launched} 个正在启动或排队${sa.controlOnly > 0 ? ` · ${sa.controlOnly} 个自动化引擎已连接` : ''}${sa.rejected > 0 ? ` · ${sa.rejected} 个未加入` : ''}…`);
}
fields.railStartAll?.addEventListener('click', () => { void doStartAll(); });
fields.railCloseAll?.addEventListener('click', () => { void doCloseAll(); });

// ── 引导式登录 / 验证码流：待处理环境排队、一次引导一个；新到项实时并入（队列每步重算）──
function guideQueue() {
  if (!fleetView.guided) return [];
  const model = uiLogic.fleetRailModel(railEnvList(), Date.now());
  return model.rows.filter((r) => r.needsAction && !fleetView.guided.done.has(r.envId));
}

function setGuideHint(text) {
  if (!fields.guideHint) return;
  fields.guideHint.textContent = text || '';
  fields.guideHint.classList.toggle('hidden', !text);
}

function exitGuide(message) {
  fleetView.guided = null;
  fields.guidePanel?.classList.add('hidden');
  setGuideHint(message || '');
  renderRail();
}

function showGuideStep() {
  const q = guideQueue();
  if (q.length === 0) {
    exitGuide('全部待处理环境已处理完成。');
    return;
  }
  const target = q[0];
  fleetView.guided.current = target.envId;
  selectEnv(target.envId);
  // 引导目标若本就是当前选中项，selectEnv 会早退（不重建、不滚动）——这里补一次「确保可见」，
  // 否则正在引导的那一行可能停在滚动区外、用户对着看不见的行找不到北。幂等：已完整可见就不动。
  scrollRailRowIntoView(fields.railList?.querySelector('.rail-row.selected'));
  const displayName = resolveEnvironmentDisplayName(target).name;
  if (fields.guideTitle) fields.guideTitle.textContent = `引导处理（剩 ${q.length} 个）：${displayName}`;
  if (fields.guideBody) {
    fields.guideBody.textContent = `当前状态：${target.label}。点「打开窗口」找到它的浏览器窗口，在窗口里完成登录 / 验证码后点「完成 · 重检」。`;
  }
  fields.guidePanel?.classList.remove('hidden');
}

function startGuide() {
  fleetView.guided = { done: new Set(), current: null };
  setGuideHint('');
  showGuideStep();
}

/** 状态推送后：当前引导中的环境**真正恢复**（核心在跑且不再需处理）→ 自动续跑并前进到下一个。
 * 红线修正：绝不在 relogin 重启的 checking/starting/stopped 瞬态（needsAction 短暂为 false）误判已恢复
 * ——那会把「登录其实没完成」的环境错误退休、永久踢出引导队列。只认「edge 在跑且不需处理」这个正向成功信号。 */
function maybeAdvanceGuide() {
  if (!fleetView.guided || !fleetView.guided.current) return;
  const env = fleetView.envs.get(fleetView.guided.current);
  if (!env) { // 环境被移出花名册：视为完成，前进
    fleetView.guided.done.add(fleetView.guided.current);
    showGuideStep();
    return;
  }
  const lv = uiLogic.fleetLevel(env.status, Date.now());
  const recovered = !lv.needsAction && env.status && env.status.edge === 'running';
  if (recovered) {
    fleetView.guided.done.add(fleetView.guided.current);
    setGuideHint(`「${resolveEnvironmentDisplayName(env).name || env.envId}」已恢复（${lv.label}），前进到下一个。`);
    showGuideStep();
  }
}

fields.railGuide?.addEventListener('click', startGuide);
fields.guideExit?.addEventListener('click', () => exitGuide(''));
fields.guideSkip?.addEventListener('click', () => {
  if (!fleetView.guided || !fleetView.guided.current) return;
  fleetView.guided.done.add(fleetView.guided.current);
  showGuideStep();
});
fields.guideOpen?.addEventListener('click', async () => {
  const envId = fleetView.guided && fleetView.guided.current;
  if (!envId || typeof window.aidcpEdge.showDrivenBrowser !== 'function') return;
  const r = await window.aidcpEdge.showDrivenBrowser(envId);
  // 诚实红线：抬不动 / 无法保证抬前时告知窗口所在，绝不假装已抬前。
  setGuideHint(r && r.ok ? '' : `打开窗口失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`);
});
fields.guideDone?.addEventListener('click', async () => {
  const envId = fleetView.guided && fleetView.guided.current;
  if (!envId || typeof window.aidcpEdge.relogin !== 'function') return;
  setGuideHint('已触发该环境重新登录 / 重检，恢复后会自动前进到下一个…');
  await window.aidcpEdge.relogin(envId);
});

// ─── Browser provider settings（既有逻辑原样保留，DOM 已迁入抽屉）───

function applyProviderSelection(provider) {
  const isChrome = provider === 'self';
  // 开关：开=本机 Chrome(self)，关=默认内置 AdsPower。AdsPower 环境卡仅在关(=adspower)时显示。
  settingsUi.useChrome.checked = isChrome;
  settingsUi.adsConfig.classList.toggle('hidden', isChrome);
}

function updateSystemProxyUpstreamHint(status = currentStatus) {
  if (!settingsUi.systemProxyUpstreamHint || !settingsUi.systemProxyUpstream) return;
  const enabled = settingsUi.systemProxyUpstream.checked;
  const actualChained = status && status.proxyMode === 'system_then_environment';
  const running = Boolean(status) && status.edge !== 'stopped' && status.edge !== 'warning';
  const chainNotApplicable = status && status.proxyChainApplicable === false;
  if (running && !chainNotApplicable && enabled !== actualChained) {
    settingsUi.systemProxyUpstreamHint.textContent = enabled
      ? '已选择双跳；当前运行中的环境仍为直连环境代理，需按新设置重启后生效。'
      : '已选择直连；当前运行中的环境仍在使用双跳，需按新设置重启后生效。';
    return;
  }
  if (!enabled) {
    settingsUi.systemProxyUpstreamHint.textContent = '关闭：浏览器直接连接环境代理。';
    return;
  }
  if (chainNotApplicable) {
    settingsUi.systemProxyUpstreamHint.textContent = '开启：当前环境未配置代理，双跳不适用；浏览器按无代理方式连接。';
    return;
  }
  const state = status && status.proxyChain && status.proxyChain.state;
  if (state === 'starting') {
    settingsUi.systemProxyUpstreamHint.textContent = '正在建立：系统代理 → 环境代理。';
  } else if (state === 'ready') {
    settingsUi.systemProxyUpstreamHint.textContent = '双跳中继已就绪；最终出口仍以浏览器实际出口检测为准。';
  } else if (state === 'unavailable') {
    settingsUi.systemProxyUpstreamHint.textContent = '双跳中继不可用；自动化启动会被阻止，请检查系统代理和环境代理。';
  } else {
    settingsUi.systemProxyUpstreamHint.textContent = '开启：系统代理 → 环境代理；仅支持 macOS 固定 HTTP/HTTPS/SOCKS5 代理，PAC/WPAD 暂不支持。';
  }
}

// 普通 dirty 设置或“目标代理模式 != 当前运行代际实际模式”且核心在跑时显示重启入口。
function updateApplyRestart() {
  const running = Boolean(currentStatus) && currentStatus.edge !== 'stopped' && currentStatus.edge !== 'warning';
  const proxyModePending = running
    && selectedProvider() === 'adspower'
    && Boolean(settingsUi.systemProxyUpstream)
    && currentStatus.proxyChainApplicable !== false
    && settingsUi.systemProxyUpstream.checked !== (currentStatus.proxyMode === 'system_then_environment');
  settingsUi.applyRestart.classList.toggle('hidden', !(running && (dirty || proxyModePending)));
}

function markDirty() {
  dirty = true;
  updateApplyRestart();
}

// 保存前把「手动填写的分身 ID」并入花名册（兜底路径也是一个成员；重复 id 不复加）。
function rosterForSave() {
  const val = settingsUi.adsProfile.value.trim();
  const list = roster.map((m) => ({ ...m }));
  if (val && !list.some((m) => m.profileId === val)) {
    list.push({ profileId: val, name: selectedProfileName, platform: selectedPlatform });
  }
  return list;
}

// 保存当前表单设置（供「启动」「按新设置重启」复用；无独立保存按钮）。返回 saveSettings 结果。
async function saveCurrentSettings() {
  const provider = selectedProvider();
  const environments = rosterForSave();
  const saved = await window.aidcpEdge.saveSettings({
    provider,
    browserParkingMode: selectedParkingMode(),
    browserColdStandbyEnabled: Boolean(settingsUi.browserColdStandby && settingsUi.browserColdStandby.checked),
    systemProxyUpstreamEnabled: Boolean(settingsUi.systemProxyUpstream && settingsUi.systemProxyUpstream.checked),
    adsProfileId: settingsUi.adsProfile.value.trim(),
    adsProfileName: selectedProfileName,
    platform: selectedPlatform,
    adsApiKey: settingsUi.adsApiKey.value,
    adsApiBase: settingsUi.adsApiBase.value.trim(),
    environments,
  });
  roster = normalizeRosterList((saved && saved.environments) || environments);
  refreshRosterMarks();
  dirty = false;
  // 表单已落盘 = 与持久化/在跑设置一致：解除「编辑中不回填」闩锁，让后续状态推送可再跟随实际 provider。
  // （否则点过一次 provider 分段后，render 的「跟随实际 provider」分支被永久旁路，段选可能与在跑 provider 不符。）
  editingProvider = null;
  updateApplyRestart();
  return saved;
}

// 重启类动作（恢复 / 重新登录）前的落盘闸：这些动作都会按【持久化设置】重起核心进程，
// 而选环境 / 改 provider 等只改了本地表单（markDirty）、未落盘。若有未保存改动则先存再重启，
// 否则核心会按旧设置重起——用户「暂停中切换的新环境」不生效（暂停态下「按新设置重启」按钮隐藏、
// 「恢复」是唯一控件，故必须在此吸收未保存改动）。返回 true=可继续；false=因缺分身 ID 被拦下、调用方应中止。
async function persistDirtyBeforeRestart(okMessage) {
  if (!dirty) return true;
  if (selectedProvider() === 'adspower' && !settingsUi.adsProfile.value.trim()) {
    promptMissingAdsProfile();
    return false;
  }
  const saved = await saveCurrentSettings();
  settingsUi.msg.textContent = saved && saved.saveOk === false
    ? `设置本次生效但写盘失败：${saved.saveError || ''}（重启应用后可能丢失）`
    : okMessage;
  return true;
}

function selectedProvider() {
  return settingsUi.useChrome.checked ? 'self' : 'adspower';
}

function selectedParkingMode() {
  const active = settingsUi.parkingButtons.find((btn) => btn.classList.contains('active'));
  const mode = active && active.dataset ? active.dataset.mode : '';
  return PARKING_MODES.has(mode) ? mode : 'primary-screen';
}

function applyParkingSelection(mode) {
  const safe = PARKING_MODES.has(mode) ? mode : 'primary-screen';
  for (const btn of settingsUi.parkingButtons) {
    btn.classList.toggle('active', btn.dataset.mode === safe);
  }
}

function promptMissingAdsProfile() {
  settingsUi.msg.textContent = '请先打开左栏“环境管理”并加入至少一个环境。';
  setRailMsg('请先在“环境管理”中加入至少一个环境。');
  openEnvAddPanel('join'); // 环境管理已搬到左栏：直达添加面板，不再去设置抽屉
}

// 分身 ID 只读展示：默认由选中环境带出；手动模式时改由输入框承载。
function updateProfileDisplay() {
  const v = settingsUi.adsProfile.value.trim();
  settingsUi.adsProfileDisplay.textContent = v || '（请从上方选择一个环境）';
  settingsUi.adsProfileDisplay.classList.toggle('empty', !v);
}

// ─── 云端环境（change edge-cloud-env-selector）───
function isWsUrl(u) {
  return /^wss?:\/\//i.test(String(u || '').trim());
}
function isHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || '').trim());
}
// 反映已选 key 到分段按钮 + 自定义输入框显隐（不触发保存）。
function applyCloudSelectionUi() {
  for (const btn of settingsUi.cloudEnvButtons) {
    btn.classList.toggle('active', btn.dataset && btn.dataset.cloud === cloudSelKey);
  }
  settingsUi.cloudEnvCustomField.classList.toggle('hidden', cloudSelKey !== 'custom');
}
// 把某选择落盘（custom 先校验地址；非法则诚实提示、不保存、不注入垃圾）。返回 saved（或 {ok:false}）。
async function persistCloudSelection() {
  const key = cloudSelKey;
  const custom = settingsUi.cloudUrlCustom.value.trim();
  const dataApi = settingsUi.clientAuthUrlCustom.value.trim();
  if (key === 'custom' && !isWsUrl(custom)) {
    settingsUi.cloudEnvHint.textContent = '自动化 WebSocket 地址需以 ws:// 或 wss:// 开头。';
    return { ok: false };
  }
  if (key === 'custom' && !isHttpUrl(dataApi)) {
    settingsUi.cloudEnvHint.textContent = '客户数据 API 地址需以 http:// 或 https:// 开头。';
    return { ok: false };
  }
  const saved = await window.aidcpEdge.saveSettings({
    cloudEnvKey: key,
    cloudUrlCustom: custom,
    clientAuthUrl: key === 'custom' ? dataApi : '',
  });
  // 主进程归一化可能把非法 custom 降级为 ''（未选择）；以回执为准回填。
  cloudSelKey = (saved && typeof saved.cloudEnvKey === 'string') ? saved.cloudEnvKey : key;
  if (saved && saved.cloudEnv) targetCloud = saved.cloudEnv;
  applyCloudSelectionUi();
  updateCloudPending();
  return saved;
}
// 选择云端目标：数据 API 按请求生效；只有正在运行的自动化引擎需要显式重绑 WebSocket。
async function selectCloudEnv(key) {
  if (key === 'ol' && cloudSelKey !== 'ol') {
    if (!window.confirm('将数据请求和自动化目标切换到线上生产环境 ol，确认切换？\n（不会启动已停止的自动化或浏览器）')) return;
  }
  cloudSelKey = key;
  applyCloudSelectionUi();
  if (key === 'custom') {
    // 等用户填地址再落盘：仅展开输入框、聚焦；不立即保存空地址。
    settingsUi.cloudUrlCustom.focus();
    settingsUi.cloudEnvHint.textContent = '分别填写客户数据 API 与自动化 WebSocket 地址后保存。';
    if (!isWsUrl(settingsUi.cloudUrlCustom.value) || !isHttpUrl(settingsUi.clientAuthUrlCustom.value)) { updateCloudPending(); return; }
  }
  const saved = await persistCloudSelection();
  if (saved && saved.ok !== false) {
    settingsUi.cloudEnvHint.textContent = `数据请求已切到「${targetCloud.label}」；运行中的自动化引擎可执行重绑，停止中的下次启动生效。`;
  }
}
// 逐环境比较实际 Cloud、目标 Cloud 和重绑失败；部分成功绝不冒充全量成功。
function updateCloudPending() {
  const target = targetCloud || { key: '', label: '默认' };
  const running = [...fleetView.envs.values()].filter(
    (e) => e.status && (e.status.coreState === 'online' || e.status.coreState === 'starting'
      || e.status.edge === 'running' || e.status.edge === 'starting'),
  );
  const pendingRows = running.filter((e) => (e.status.connectedCloudKey && e.status.connectedCloudKey !== target.key)
    || (e.status.cloudRebind && e.status.cloudRebind.state === 'pending'));
  const failedRows = running.filter((e) => e.status.cloudRebind && e.status.cloudRebind.state === 'failed');
  const pending = pendingRows.length > 0;
  const actualKeys = [...new Set(running.map((e) => e.status.connectedCloudKey).filter(Boolean))];
  const liveLabel = actualKeys.length === 0
    ? '未连接'
    : actualKeys.length === 1
      ? (CLOUD_ENV_LABELS[actualKeys[0]] || actualKeys[0])
      : `多目标（${actualKeys.map((key) => CLOUD_ENV_LABELS[key] || key).join(' / ')}）`;
  if (settingsUi.cloudEnvCurrent) {
    settingsUi.cloudEnvCurrent.textContent = failedRows.length > 0
      ? `${liveLabel} → 目标 ${target.label}（${failedRows.length} 个重绑失败）`
      : pending
        ? `${liveLabel} → 目标 ${target.label}（${pendingRows.length} 个待重绑）`
        : (actualKeys.length ? liveLabel : target.label || '默认');
    settingsUi.cloudEnvCurrent.classList.toggle('ol', !pending && actualKeys.length === 1 && actualKeys[0] === 'ol');
  }
  if (settingsUi.cloudRestartAll) settingsUi.cloudRestartAll.classList.toggle('hidden', !pending);
  if (fields.cloudEnvChipLabel) {
    fields.cloudEnvChipLabel.textContent = failedRows.length > 0
      ? `Cloud ${target.label}·${failedRows.length} 失败`
      : pending
        ? `Cloud ${target.label}·待重绑 ${pendingRows.length}`
        : `Cloud ${actualKeys.length ? liveLabel : target.label || '默认'}`;
  }
  if (fields.cloudEnvChip) {
    fields.cloudEnvChip.classList.toggle('ol', !pending && (actualKeys[0] || target.key) === 'ol');
    fields.cloudEnvChip.classList.toggle('pending', pending);
  }
}

function applySettings(s) {
  if (!s) return;
  // settings.personaPromptGraceMs 已废弃（change persona-bound-tristate 删除了整套宽限期机制：弹窗不再靠
  // 「等多久算未绑」去猜，而是只由云端权威的 personaBound===false 触发）。旧设置里残留该键时静默忽略。
  selectedProfileName = s.adsProfileName || '';
  selectedPlatform = normPlatform(s.platform);
  // 花名册：新形状 environments 优先；旧单值 adsProfileId 向后兼容加载为单元素花名册。
  roster = Array.isArray(s.environments) && s.environments.length > 0
    ? normalizeRosterList(s.environments)
    : normalizeRosterList(s.adsProfileId ? [{ profileId: s.adsProfileId, name: s.adsProfileName, platform: s.platform }] : []);
  clientRosterExcludedEnvIds = new Set(
    (Array.isArray(s.clientRosterExcludedEnvIds) ? s.clientRosterExcludedEnvIds : [])
      .map((envKey) => String(envKey || '').trim())
      .filter(Boolean),
  );
  if (typeof s.railCollapsed === 'boolean') fleetView.collapsed = s.railCollapsed;
  applyDevVisible(Boolean(s.devDetails));
  settingsUi.adsProfile.value = s.adsProfileId || '';
  settingsUi.adsApiKey.value = s.adsApiKey || '';
  settingsUi.adsApiBase.value = s.adsApiBase || '';
  applyParkingSelection(s.browserParkingMode || 'primary-screen');
  if (settingsUi.browserColdStandby) settingsUi.browserColdStandby.checked = s.browserColdStandbyEnabled !== false;
  if (settingsUi.systemProxyUpstream) settingsUi.systemProxyUpstream.checked = s.systemProxyUpstreamEnabled === true;
  updateSystemProxyUpstreamHint();
  // 浏览器并发（change browser-slot-scheduling）：0 = 自动 → 输入框留空，让占位文案说清自动是怎么算的。
  if (settingsUi.slotLimit) settingsUi.slotLimit.value = Number(s.browserSlotLimit) > 0 ? String(s.browserSlotLimit) : '';
  if (settingsUi.maxQueuedStartLimit) settingsUi.maxQueuedStartLimit.value = Number(s.maxQueuedStartLimit) > 0 ? String(s.maxQueuedStartLimit) : '';
  applySlotsView(s.slots);
  updateProfileDisplay();
  // 云端环境（change edge-cloud-env-selector）：回填已选 key、自定义地址、目标云端视图。
  cloudSelKey = typeof s.cloudEnvKey === 'string' ? s.cloudEnvKey : '';
  settingsUi.cloudUrlCustom.value = s.cloudUrlCustom || '';
  settingsUi.clientAuthUrlCustom.value = s.clientAuthUrl || '';
  if (s.cloudEnv) targetCloud = s.cloudEnv;
  applyCloudSelectionUi();
  updateCloudPending();
  editingProvider = null;
  dirty = false;
  applyProviderSelection(s.provider || 'adspower');
  updateApplyRestart();
}

// ── 浏览器并发卡（change browser-slot-scheduling）────────────────────────────────
// 两个上限的**算出来的**取值一律由主进程给（settings.slots），渲染层只显示、绝不自己再算一遍——
// 两处各算一遍必然漂移，界面说 5 个槽位、实际闸放行 3 个，是最难查的一类不一致。
function applySlotsView(view) {
  if (!settingsUi.slotsHint || !view) return;
  const capSrc = view.capacitySource === 'setting'
    ? '你设定'
    : view.capacitySource === 'env'
      ? '启动参数'
      : `自动推算（可用内存约 ${view.usableMB}MB ÷ 单环境约 ${view.perEnvMB}MB）`;
  const queueSrc = view.maxQueuedStartsSource === 'setting' ? '你设定' : '自动（并发 × 2）';
  settingsUi.slotsHint.textContent =
    `浏览器并发 ${view.capacity}（${capSrc}）· 启动排队上限 ${view.maxQueuedStarts}（${queueSrc}）· `
    + `此刻 ${view.occupied} 个在执行、${view.queued} 个等待启动、已创建 ${view.configured} 个环境。环境数量不受限制。`;
  const warns = [];
  if (Number(view.queued) >= Number(view.maxQueuedStarts)) {
    warns.push(`⚠ 启动排队已满（${view.queued}/${view.maxQueuedStarts}）；新的启动请求需稍后重试。`);
  }
  if (settingsUi.slotsWarn) {
    settingsUi.slotsWarn.textContent = warns.join('　');
    settingsUi.slotsWarn.classList.toggle('hidden', warns.length === 0);
  }
}

// 空 / 非数 / ≤0 → 0（= 自动）；上界 64（与主进程 fleet.normalizeSlotLimit 同口径，权威仍在主进程）。
function readSlotInput(el) {
  const n = Math.floor(Number((el && el.value) || 0));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(64, n);
}

// 并发上限即改即存：这是壳层的闸，不动在跑核心，所以不走 dirty / 「按新设置重启」那条路。
async function persistSlotLimits() {
  const saved = await window.aidcpEdge.saveSettings({
    browserSlotLimit: readSlotInput(settingsUi.slotLimit),
    maxQueuedStartLimit: readSlotInput(settingsUi.maxQueuedStartLimit),
  });
  if (!saved) return;
  if (settingsUi.slotLimit) settingsUi.slotLimit.value = Number(saved.browserSlotLimit) > 0 ? String(saved.browserSlotLimit) : '';
  if (settingsUi.maxQueuedStartLimit) settingsUi.maxQueuedStartLimit.value = Number(saved.maxQueuedStartLimit) > 0 ? String(saved.maxQueuedStartLimit) : '';
  applySlotsView(saved.slots);
}
settingsUi.slotLimit?.addEventListener('change', () => { void persistSlotLimits(); });
settingsUi.maxQueuedStartLimit?.addEventListener('change', () => { void persistSlotLimits(); });

// 云端环境卡交互（change edge-cloud-env-selector）
for (const btn of settingsUi.cloudEnvButtons) {
  btn.addEventListener('click', () => {
    const key = btn.dataset && btn.dataset.cloud;
    if (key === 'dev' || key === 'ol' || key === 'custom') void selectCloudEnv(key);
  });
}
// 自定义地址填好后（change/blur）落盘（仅当当前是 custom）。
settingsUi.cloudUrlCustom.addEventListener('change', () => {
  if (cloudSelKey !== 'custom') return;
  void persistCloudSelection().then((saved) => {
    if (saved && saved.ok !== false) {
      settingsUi.cloudEnvHint.textContent = `数据请求已切到「${targetCloud.label}」；运行中的自动化引擎可执行重绑。`;
    }
  });
});
settingsUi.clientAuthUrlCustom.addEventListener('change', () => {
  if (cloudSelKey !== 'custom') return;
  void persistCloudSelection();
});
// 兼容旧 API 名，仅重绑运行中的自动化 WebSocket；不启动引擎或浏览器。
settingsUi.cloudRestartAll.addEventListener('click', async () => {
  settingsUi.cloudRestartAll.disabled = true;
  try {
    const r = await window.aidcpEdge.cloudRestartAll?.();
    settingsUi.cloudEnvHint.textContent = r && r.ok
      ? `${r.rebound} 个运行中的自动化引擎已重绑「${(r.cloudEnv && r.cloudEnv.label) || targetCloud.label}」；${r.skipped || 0} 个停止中的环境将在下次启动时生效。`
      : r
        ? `引擎重绑完成 ${r.rebound || 0}/${r.accepted || 0}；${r.failed || 0} 个失败，请查看各环境状态后重试。`
        : '自动化引擎重绑请求失败，请重试。';
  } finally {
    settingsUi.cloudRestartAll.disabled = false;
  }
});
// 标题带「当前云端」chip 点击 → 打开设置抽屉（去切换）。
fields.cloudEnvChip?.addEventListener('click', openDrawer);

settingsUi.useChrome.addEventListener('change', () => {
  const provider = selectedProvider();
  editingProvider = provider;
  markDirty();
  applyProviderSelection(provider);
  if (provider === 'adspower') probeAds(); // 切回 AdsPower 即探一次可用性并列环境
});

// 加环境面板里的「手动填分身 ID」折叠。
settingsUi.adsAdvancedToggle.addEventListener('click', () => {
  const hidden = settingsUi.adsAdvanced.classList.toggle('hidden');
  settingsUi.adsAdvancedToggle.textContent = hidden ? '手动填分身 ID ▾' : '手动填分身 ID ▴';
});

// 设置抽屉里的「指纹浏览器高级设置」折叠（API 地址/Key）。
settingsUi.adsAdvanced2Toggle?.addEventListener('click', () => {
  const hidden = settingsUi.adsAdvanced2.classList.toggle('hidden');
  settingsUi.adsAdvanced2Toggle.textContent = hidden ? '指纹浏览器高级设置 ▾' : '指纹浏览器高级设置 ▴';
});

// 手动分身 ID 折叠；需要手动兜底时（探测未就绪 / 拉取失败）自动展开，免得用户去找。
function openAdvanced() {
  settingsUi.adsAdvanced.classList.remove('hidden');
  settingsUi.adsAdvancedToggle.textContent = '手动填分身 ID ▴';
}

// 「手动填写」开关：开=显示手敲输入框 + 加入按钮；关=用选中环境的值（只读展示）。
settingsUi.adsManual.addEventListener('change', () => {
  const manual = settingsUi.adsManual.checked;
  settingsUi.adsProfile.classList.toggle('hidden', !manual);
  settingsUi.adsManualAdd?.classList.toggle('hidden', !manual);
  settingsUi.adsProfileDisplay.classList.toggle('hidden', manual);
  if (manual) settingsUi.adsProfile.focus();
  else updateProfileDisplay();
});
settingsUi.adsProfile.addEventListener('input', () => {
  selectedProfileName = ''; // 手填 id 对不上环境名，不冒认
  selectedPlatform = 'xiaohongshu'; // 手填 id 平台未知 → 回落小红书（与历史一致，零回归）；需 FB 则经环境列表选中
  updateProfileDisplay();
});
// 「加入这个分身 ID」：把手敲 id 作为一个花名册成员加入并落盘（兜底路径，列表拉不到时用）。
settingsUi.adsManualAdd?.addEventListener('click', () => {
  const id = settingsUi.adsProfile.value.trim();
  if (!id) { setEnvMsg('请先填写分身 ID。', true); return; }
  if (rosterHas(id)) { setEnvMsg(`「${id}」已加入。`, false); return; }
  roster.push({ profileId: id, name: '', platform: 'xiaohongshu' });
  settingsUi.adsProfile.value = '';
  refreshRosterMarks();
  setEnvMsg(`已加入分身 ID「${id}」，在左栏可见并可启动。`, false);
  void persistRoster();
});
settingsUi.adsApiBase.addEventListener('input', markDirty);
settingsUi.adsApiKey.addEventListener('input', markDirty);
for (const btn of settingsUi.parkingButtons) {
  btn.addEventListener('click', () => {
    applyParkingSelection(btn.dataset.mode);
    markDirty();
  });
}

async function runBrowserRecovery(action) {
  const api = action === 'show' ? window.aidcpEdge.showDrivenBrowser : window.aidcpEdge.resetBrowserParking;
  if (typeof api !== 'function') return;
  const label = action === 'show' ? '显示浏览器' : '重置浏览器位置';
  try {
    const r = await api(currentEnvId());
    // 诚实边界：成功只表示指令被接受，保持安静；失败才展示原因，绝不宣称已抬到最前。
    settingsUi.msg.textContent = r && r.ok ? '' : `${label}失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`;
  } catch (e) {
    settingsUi.msg.textContent = `${label}失败：${(e && e.message) || e}`;
  }
}
settingsUi.browserShow.addEventListener('click', () => runBrowserRecovery('show'));
settingsUi.browserResetParking.addEventListener('click', () => runBrowserRecovery('reset'));
settingsUi.browserColdStandby?.addEventListener('change', markDirty);
settingsUi.systemProxyUpstream?.addEventListener('change', async () => {
  const enabled = settingsUi.systemProxyUpstream.checked;
  updateSystemProxyUpstreamHint();
  updateApplyRestart();
  settingsUi.systemProxyUpstream.disabled = true;
  try {
    const saved = await window.aidcpEdge.saveSettings({ systemProxyUpstreamEnabled: enabled });
    if (saved && saved.saveOk === false) {
      settingsUi.msg.textContent =
        `代理模式本次已应用，但写盘失败：${saved.saveError || '未知错误'}。重启应用后可能恢复原设置。`;
    }
  } catch (error) {
    // IPC 未受理时恢复到变更前的可见选择，避免界面声称一个主进程从未采用的模式。
    settingsUi.systemProxyUpstream.checked = !enabled;
    settingsUi.msg.textContent = `代理模式保存失败：${(error && error.message) || error}`;
  } finally {
    settingsUi.systemProxyUpstream.disabled = false;
    updateSystemProxyUpstreamHint();
    updateApplyRestart();
  }
});

// ─── AdsPower 探测 / 环境列表 / 新建入口 ───

// 只读调用带上「当前表单值」（调用级）：支持「新填 API Key 未保存即刷新」而不陷回环。
function formAdsOpts() {
  return {
    apiBase: settingsUi.adsApiBase.value.trim(),
    apiKey: settingsUi.adsApiKey.value,
  };
}

function setEnvMsg(text, isError) {
  settingsUi.adsEnvMsg.textContent = text || '';
  settingsUi.adsEnvMsg.className = `ads-env-msg${isError ? ' error' : ''}`;
}

// 静默探测本地 API（根级 /status）以填充环境列表：可达→列环境；不可达→诚实提示于环境行、不禁死流程
// （启动时应用会自动拉起内置 AdsPower 运行时；此处不再有可见「检测」按钮/状态徽标）。
async function probeAds() {
  try {
    const r = await window.aidcpEdge.adsStatus(formAdsOpts());
    if (r && r.ok) {
      if (settingsUi.adsEnvMsg.classList.contains('error')) setEnvMsg('', false);
      return await refreshEnvs(); // 就绪即自动列出环境；启动判空必须等待当前账号花名册同步完成
    } else {
      setEnvMsg(
        `暂未连接到本地指纹浏览器服务${r && r.error ? '（' + r.error + '）' : ''}。启动后应用会自动拉起内置运行时；也可在下方手动填写分身 ID。`,
        true,
      );
      openAdvanced();
      return false;
    }
  } catch {
    setEnvMsg('检测本地指纹浏览器服务失败。', true);
    return false;
  }
}

// 选中某环境：把其 user_id（非 serial_number）设为将写入的分身 ID，并高亮该行；顺手记环境名作账号标签
// 与该环境的平台（platform，来自其 remark；同步进 settings 供启动注入 AIDCP_PLATFORM）。
// 多环境（edge-multi-environment-fleet）：选中即**加入运行花名册**（多选累积）；已在花名册的成员
// 再点只切换当前值、诚实提示已加入，MUST NOT 重复出现两次（防 edgeId 撞车）。
// profileName 保留 AdsPower 原始环境名用于新成员入册；displayName 仅供当前客户端界面提示。
function selectProfile(userId, itemEl, profileName, platform, displayName = profileName) {
  const label = displayName || profileName || userId;
  settingsUi.adsProfile.value = userId;
  selectedProfileName = displayName || profileName || '';
  selectedPlatform = normPlatform(platform);
  let added = false;
  if (userId && !rosterHas(userId)) {
    roster.push({ profileId: userId, name: profileName || '', platform: normPlatform(platform) });
    if (lastAssignmentScoped) clientRosterExcludedEnvIds.delete(userId);
    added = true;
  } else if (userId) {
    setEnvMsg(`「${label}」已加入。`, false);
  }
  updateProfileDisplay();
  settingsUi.adsEnvList.querySelectorAll('.ads-env-item').forEach((el) => el.classList.remove('selected'));
  if (itemEl) itemEl.classList.add('selected');
  refreshRosterMarks();
  // 加入即落盘（根治「加入后左栏不显示」）：main 据此 syncEnvHandles + 广播花名册 → 左栏立刻出现该环境的离线行。
  if (added) {
    setEnvMsg(`已加入「${label}」，在左栏可见并可启动。`, false);
    const persisted = persistRoster();
    void persisted.then((saved) => {
      if (saved && saved.saveOk === false) {
        setEnvMsg(`已移入「${label}」（本次生效），但写盘失败：${saved.saveError || '未知错误'}。重启后可能丢失。`, true);
      }
    });
    return persisted;
  }
  return Promise.resolve();
}

// 从花名册移出一个成员；若其恰为当前分身 ID，则回落到剩余首个成员（或清空）。
function removeFromRoster(profileId, { remember = true } = {}) {
  roster = roster.filter((m) => m.profileId !== profileId);
  if (remember && lastAssignmentScoped
    && lastProfiles.some((p) => p && p.userId === profileId && !p.offboardPending)) {
    clientRosterExcludedEnvIds.add(profileId);
  }
  if (settingsUi.adsProfile.value.trim() === profileId) {
    const next = roster[0];
    settingsUi.adsProfile.value = next ? next.profileId : '';
    selectedProfileName = next ? next.name : '';
    selectedPlatform = next ? normPlatform(next.platform) : 'xiaohongshu';
    updateProfileDisplay();
  }
  refreshRosterMarks();
  if (remember) setEnvMsg('已移出；环境归属不变，可随时再次加入。', false);
  const persisted = persistRoster(); // 移出即落盘：main 有序停止并摘除该环境、左栏随即撤下
  if (remember) {
    void persisted.then((saved) => {
      if (saved && saved.saveOk === false) {
        setEnvMsg(`已移出（本次生效），但写盘失败：${saved.saveError || '未知错误'}。重启后可能恢复。`, true);
      }
    });
  }
  return persisted;
}

// 把当前花名册直接落盘（加入/移出即时生效，不必等「启动」）。main 的 syncEnvHandles 会据此建行/摘行。
async function persistRoster() {
  if (!window.aidcpEdge || typeof window.aidcpEdge.saveSettings !== 'function') return;
  const environments = roster.map((m) => ({
    profileId: m.profileId,
    name: m.name,
    ...(m.systemName ? { systemName: m.systemName } : {}),
    platform: m.platform,
    ...(m.nameSource === 'manual' ? { nameSource: 'manual' } : {}),
    ...(m.nameSource === 'manual' && m.nameSyncState ? { nameSyncState: m.nameSyncState } : {}),
  }));
  try {
    const saved = await window.aidcpEdge.saveSettings({
      environments,
      clientRosterExcludedEnvIds: [...clientRosterExcludedEnvIds],
    });
    if (saved && Array.isArray(saved.environments)) roster = normalizeRosterList(saved.environments);
    if (saved && Array.isArray(saved.clientRosterExcludedEnvIds)) {
      clientRosterExcludedEnvIds = new Set(saved.clientRosterExcludedEnvIds.map((envKey) => String(envKey || '').trim()).filter(Boolean));
    }
    refreshRosterMarks();
    return saved;
  } catch {
    return null; // 下次「启动」的 saveCurrentSettings 会再落一次；调用方不得据此声称已持久化。
  }
}

// 程序化建号的 gated 路径由 main 完成权威入册与落盘；renderer 的 roster 仍是调用前快照。
// 创建成功后从 settings:get 回读 main 真态再重画“已加入”，不把 envKey 二次提交、也不重复落盘。
async function syncRosterFromMainSettings() {
  if (!window.aidcpEdge || typeof window.aidcpEdge.getSettings !== 'function') return false;
  try {
    const latest = await window.aidcpEdge.getSettings();
    if (!latest || !Array.isArray(latest.environments)) return false;
    roster = normalizeRosterList(latest.environments);
    clientRosterExcludedEnvIds = new Set(
      (Array.isArray(latest.clientRosterExcludedEnvIds) ? latest.clientRosterExcludedEnvIds : [])
        .map((envKey) => String(envKey || '').trim())
        .filter(Boolean),
    );
    refreshRosterMarks();
    return true;
  } catch {
    return false;
  }
}

// 刷新时剔除孤儿：花名册里 profileId 已不在**本机物理分身列表**中的成员（AdsPower profile 已删除、本地残留）自动移出。
// 参数 liveIds = 本机物理存在的全部分身 id（gated 时由 main 的 physicalUserIds 提供、非按云端可见集收窄的显示列表——
// 降范围≠物理删除，绝不把降范围环境当孤儿销毁）。**只应在「成功且完整」的拉取后调用**（调用点 refreshEnvs 已守
// r.ok && !r.truncated）——否则一次失败/截断的拉取会把在跑的花名册误判成全体孤儿清空（红线：不因缺数据自残）。返回移出的条数。
function pruneOrphanRoster(liveIds) {
  const live = new Set((liveIds || []).filter(Boolean));
  // 二道防御（截断闸之外）：一个环境都没取到（疑似后端「成功但空」的偶发响应，而非账号真空）时绝不剔——
  // 否则会把整份在用花名册全判成孤儿清空。宁可漏剔孤儿、绝不误删在用环境（红线：不因缺数据自残）。
  if (live.size === 0) return 0;
  const orphanIds = roster.filter((m) => m.profileId && !live.has(m.profileId)).map((m) => m.profileId);
  if (orphanIds.length === 0) return 0;
  const drop = new Set(orphanIds);
  roster = roster.filter((m) => !drop.has(m.profileId));
  // 当前选中的分身正是被剔的孤儿 → 回落到剩余首个成员（或清空），与 removeFromRoster 一致。
  if (drop.has(settingsUi.adsProfile.value.trim())) {
    const next = roster[0];
    settingsUi.adsProfile.value = next ? next.profileId : '';
    selectedProfileName = next ? next.name : '';
    selectedPlatform = next ? normPlatform(next.platform) : 'xiaohongshu';
    updateProfileDisplay();
  }
  return orphanIds.length;
}

// 拉列表时以 AdsPower 实时名回填花名册成员名（change edge-env-name-live-sync）：治「加入那一刻拍下、
// 此后永不更新」导致左栏展示名与添加面板显示的真名漂移（新建即空名 / 手填空名 / AdsPower 端改名三源）。
// 只覆盖**本次列表在场、实时名非空、且与现存名不同**的成员；返回改动数、不自行落盘（由 refreshEnvs 统一落一次，
// 杜绝与 pruneOrphanRoster 的双落盘竞态）。人工昵称是明确例外，列表实时名不得覆盖。
// **缺数据不自残**：本函数只在 refreshEnvs 的 `!r.truncated` 守卫下调用，空实时名从不回填（不因缺数据误清 / 误改）。
function reconcileRosterNames(profiles) {
  const liveName = new Map();
  for (const p of profiles || []) {
    if (p && p.userId && p.name) liveName.set(String(p.userId), p.name);
  }
  if (liveName.size === 0) return 0; // 二道防御：一个带名环境都没取到时绝不回填（同 pruneOrphanRoster 的空列表守卫）
  let changed = 0;
  for (const m of roster) {
    if (m.nameSource === 'manual') continue;
    const live = liveName.get(String(m.profileId));
    if (live && live !== m.name) { m.name = live; changed += 1; }
  }
  if (changed > 0) {
    // 当前选中分身的名字同步更新，保持旧单值镜像 adsProfileName 与花名册一致（saveCurrentSettings 会写该镜像）。
    const selectedId = settingsUi.adsProfile.value.trim();
    const selectedMember = roster.find((m) => m.profileId === selectedId);
    const selLive = selectedMember && selectedMember.nameSource !== 'manual' ? liveName.get(selectedId) : '';
    if (selLive) selectedProfileName = selLive;
  }
  return changed;
}

// 客户模式：完整非空列表已经由 main 按权威归属收窄，可安全把未排除的本机归属环境默认移入花名册。
// 只改花名册/排除草稿，不自行落盘；refreshEnvs 将名字、孤儿、默认移入合并为一次 save。
function reconcileAssignedRoster(profiles) {
  if (!lastAssignmentScoped || !Array.isArray(profiles) || profiles.length === 0) {
    return { added: [], exclusionsChanged: false };
  }
  const visibleIds = new Set(profiles.map((p) => String((p && p.userId) || '').trim()).filter(Boolean));
  const beforeExclusions = clientRosterExcludedEnvIds.size;
  clientRosterExcludedEnvIds = new Set([...clientRosterExcludedEnvIds].filter((envKey) => visibleIds.has(envKey)));
  const exclusionsChanged = clientRosterExcludedEnvIds.size !== beforeExclusions;
  const added = [];
  for (const prof of profiles) {
    const envKey = String((prof && prof.userId) || '').trim();
    if (!envKey || prof.offboardPending || rosterHas(envKey) || clientRosterExcludedEnvIds.has(envKey)) continue;
    roster.push({ profileId: envKey, name: prof.name || '', platform: normPlatform(prof.platform) });
    added.push(prof.name || envKey);
  }
  if (added.length > 0 && !settingsUi.adsProfile.value.trim()) {
    const first = roster[0];
    settingsUi.adsProfile.value = first ? first.profileId : '';
    selectedProfileName = first ? first.name : '';
    selectedPlatform = first ? normPlatform(first.platform) : 'xiaohongshu';
    updateProfileDisplay();
  }
  return { added, exclusionsChanged };
}

// roster 变更后就地重刷环境列表的成员标记（不重新拉取）。
function refreshRosterMarks() {
  if (lastProfiles.length > 0) populateEnvs(lastProfiles);
}

// 核心是否在跑（自动选中的闸：在跑时绝不替用户改配置）。
function coreRunning() {
  return Boolean(currentStatus) && currentStatus.edge !== 'stopped' && currentStatus.edge !== 'warning';
}

function profileRuntimeForManagement(userId) {
  const env = [...fleetView.envs.values()].find((item) => item && item.profileId === userId);
  const status = env && env.status;
  if (!status) return { active: false, label: '状态未知' };
  const automation = status.automationState;
  const browser = status.browserState;
  const active = (automation && !['stopped', 'error'].includes(automation))
    || (browser && !['closed', 'error'].includes(browser))
    || ['running', 'starting'].includes(status.edge);
  if (active) {
    const starting = ['starting', 'waiting_resource'].includes(automation) || status.edge === 'starting';
    return { active: true, label: starting ? '启动中' : '运行中' };
  }
  if (status.edge === 'stopped' || automation === 'stopped' || browser === 'closed') {
    return { active: false, label: '已关闭' };
  }
  return { active: false, label: '状态未知' };
}

function environmentManagementDisplayName(profile, knownMember) {
  const profileId = String((profile && profile.userId) || '').trim();
  const member = knownMember || roster.find((item) => item.profileId === profileId);
  const fleetEnvironment = authoritativeFleetEnvironmentForProfile(profileId);
  const rawName = String((profile && (profile.name || profile.username)) || '').trim();
  const candidate = fleetEnvironment
    ? {
      ...fleetEnvironment,
      status: effectiveEnvironmentStatus(fleetEnvironment, fleetEnvironment.status),
    }
    : {
      ...(member || {}),
      envId: profileId ? `ads-${profileId}` : '',
      profileId,
    };
  if (member && member.nameSource === 'manual') {
    candidate.name = member.name;
    candidate.nameSource = 'manual';
  } else if (!candidate.name && rawName) {
    candidate.name = rawName;
  }
  return resolveEnvironmentDisplayName(candidate).name || rawName || profileId || '(未命名)';
}

function profileActiveForProxy(userId) {
  return profileRuntimeForManagement(userId).active;
}

function selectedBatchProxyIds() {
  // Set 保留用户勾选顺序；不从可能随状态分组或刷新重排的视图重新推导。
  return Array.from(batchProxySelectedIds);
}

function setBatchProxyMsg(text, isError) {
  if (!fields.adsBatchProxyMsg) return;
  fields.adsBatchProxyMsg.textContent = text || '';
  fields.adsBatchProxyMsg.classList.toggle('error', Boolean(isError));
}

function resetBatchProxyProgress() {
  batchProxyActiveRequest = null;
  fields.adsBatchProxyProgress?.classList.add('hidden');
  if (fields.adsBatchProxyProgressLabel) fields.adsBatchProxyProgressLabel.textContent = '已完成 0/0';
  if (fields.adsBatchProxyProgressBar) {
    fields.adsBatchProxyProgressBar.max = 1;
    fields.adsBatchProxyProgressBar.value = 0;
  }
}

function renderBatchProxyProgress(completedCount, totalCount, { running = false } = {}) {
  const total = Math.max(1, Number(totalCount) || 1);
  const completed = Math.min(total, Math.max(0, Number(completedCount) || 0));
  fields.adsBatchProxyProgress?.classList.remove('hidden');
  if (fields.adsBatchProxyProgressLabel) {
    fields.adsBatchProxyProgressLabel.textContent = `${running ? '正在按顺序修改… ' : ''}已完成 ${completed}/${total}`;
  }
  if (fields.adsBatchProxyProgressBar) {
    fields.adsBatchProxyProgressBar.max = total;
    fields.adsBatchProxyProgressBar.value = completed;
  }
}

function setBatchProxyBusy(busy) {
  if (fields.adsBatchProxyToggle) fields.adsBatchProxyToggle.disabled = busy;
  if (fields.adsBatchProxyCancel) fields.adsBatchProxyCancel.disabled = busy;
  if (fields.adsBatchProxyType) fields.adsBatchProxyType.disabled = busy;
  if (fields.adsBatchProxyText) {
    fields.adsBatchProxyText.disabled = busy || (fields.adsBatchProxyType && fields.adsBatchProxyType.value === 'no_proxy');
  }
  for (const check of document.querySelectorAll('.ads-env-check')) {
    if (busy) check.disabled = true;
  }
}

function nextBatchProxyRequestId() {
  batchProxyRequestSequence += 1;
  return `proxy-${Date.now().toString(36)}-${batchProxyRequestSequence.toString(36)}`;
}

function handleBatchProxyProgress(progress) {
  const active = batchProxyActiveRequest;
  if (!active || !progress || progress.requestId !== active.requestId) return;
  const completed = Number(progress.completedCount);
  const total = Number(progress.totalCount);
  if (!Number.isInteger(completed) || !Number.isInteger(total)
    || total !== active.total || completed <= active.completed || completed > total) return;
  active.completed = completed;
  renderBatchProxyProgress(completed, total, { running: true });
}

function exitBatchProxyMode({ clearText = false } = {}) {
  batchProxyMode = false;
  batchProxySelectedIds = new Set();
  batchProxyPreviewEpoch += 1;
  fields.adsBatchProxyPanel?.classList.add('hidden');
  if (fields.adsBatchProxyToggle) fields.adsBatchProxyToggle.textContent = '批量代理';
  if (fields.adsBatchProxyCount) fields.adsBatchProxyCount.textContent = '已选择 0 个环境';
  if (fields.adsBatchProxyPreview) fields.adsBatchProxyPreview.textContent = '选择环境并输入代理后显示分配摘要。';
  if (fields.adsBatchProxySave) {
    fields.adsBatchProxySave.disabled = true;
    fields.adsBatchProxySave.textContent = '确认修改';
  }
  setBatchProxyBusy(false);
  resetBatchProxyProgress();
  setBatchProxyMsg('', false);
  if (clearText && fields.adsBatchProxyText) fields.adsBatchProxyText.value = '';
  if (lastProfiles.length > 0) populateEnvs(lastProfiles);
}

function enterBatchProxyMode() {
  batchProxyMode = true;
  batchProxySelectedIds = new Set();
  fields.adsBatchProxyPanel?.classList.remove('hidden');
  if (fields.adsBatchProxyToggle) fields.adsBatchProxyToggle.textContent = '取消批量';
  if (fields.adsBatchProxyType && fields.adsBatchProxyType.value === 'no_proxy') {
    fields.adsBatchProxyText.value = '';
    fields.adsBatchProxyText.disabled = true;
  }
  resetBatchProxyProgress();
  populateEnvs(lastProfiles);
  void refreshBatchProxyPreview();
}

async function refreshBatchProxyPreview() {
  if (!batchProxyMode) return;
  if (batchProxyActiveRequest) return;
  resetBatchProxyProgress();
  const epoch = ++batchProxyPreviewEpoch;
  const userIds = selectedBatchProxyIds();
  const type = fields.adsBatchProxyType ? fields.adsBatchProxyType.value : 'http';
  const text = fields.adsBatchProxyText ? fields.adsBatchProxyText.value : '';
  if (fields.adsBatchProxyCount) fields.adsBatchProxyCount.textContent = `已选择 ${userIds.length} 个环境`;
  if (fields.adsBatchProxySave) {
    fields.adsBatchProxySave.disabled = true;
    fields.adsBatchProxySave.textContent = userIds.length > 0 ? `确认修改 ${userIds.length} 个` : '确认修改';
  }
  setBatchProxyMsg('', false);
  if (userIds.length === 0) {
    if (fields.adsBatchProxyPreview) fields.adsBatchProxyPreview.textContent = '请先选择环境；运行中的环境不可修改。';
    return;
  }
  if (type !== 'no_proxy' && !text.trim()) {
    if (fields.adsBatchProxyPreview) fields.adsBatchProxyPreview.textContent = '粘贴代理后显示分配摘要。';
    return;
  }
  if (!window.aidcpEdge || typeof window.aidcpEdge.adsParseProxyLines !== 'function') {
    setBatchProxyMsg('当前客户端未加载代理解析能力，请重启后重试。', true);
    return;
  }
  const parsed = await window.aidcpEdge.adsParseProxyLines({ proxyType: type, proxyText: text });
  if (epoch !== batchProxyPreviewEpoch || !batchProxyMode) return;
  if (!parsed || !parsed.ok) {
    if (fields.adsBatchProxyPreview) fields.adsBatchProxyPreview.textContent = '代理资料尚未通过校验。';
    setBatchProxyMsg((parsed && parsed.error) || '代理格式不正确。', true);
    return;
  }
  if (parsed.noProxy) {
    if (fields.adsBatchProxyPreview) fields.adsBatchProxyPreview.textContent = `将清除 ${userIds.length} 个环境的代理配置。`;
  } else {
    const proxies = Array.isArray(parsed.proxies) ? parsed.proxies : [];
    if (proxies.length === 0) {
      if (fields.adsBatchProxyPreview) fields.adsBatchProxyPreview.textContent = '代理资料尚未通过校验。';
      setBatchProxyMsg('代理解析结果不完整，请重试。', true);
      return;
    }
    const profileById = new Map(lastProfiles.map((profile) => [profile.userId, profile]));
    const sample = userIds.slice(0, 4).map((userId, index) => {
      const profile = profileById.get(userId);
      const proxy = proxies[index % proxies.length];
      return `${profile ? environmentManagementDisplayName(profile) : userId} → ${proxy.proxyHost}:${proxy.proxyPort}`;
    });
    const reusedCount = Math.max(0, userIds.length - proxies.length);
    const reuse = reusedCount > 0 ? ` · 其中 ${reusedCount} 个环境复用代理` : '';
    if (fields.adsBatchProxyPreview) {
      fields.adsBatchProxyPreview.textContent = `${userIds.length} 个环境 · ${proxies.length} 条代理${reuse}\n${sample.join('\n')}${userIds.length > sample.length ? '\n…' : ''}`;
    }
  }
  if (fields.adsBatchProxySave) fields.adsBatchProxySave.disabled = false;
}

fields.adsBatchProxyToggle?.addEventListener('click', () => {
  if (batchProxyMode) exitBatchProxyMode({ clearText: true });
  else enterBatchProxyMode();
});
fields.adsBatchProxyCancel?.addEventListener('click', () => exitBatchProxyMode({ clearText: true }));
fields.adsBatchProxyType?.addEventListener('change', () => {
  const noProxy = fields.adsBatchProxyType.value === 'no_proxy';
  fields.adsBatchProxyText.disabled = noProxy;
  if (noProxy) fields.adsBatchProxyText.value = '';
  void refreshBatchProxyPreview();
});
fields.adsBatchProxyText?.addEventListener('input', () => { void refreshBatchProxyPreview(); });
fields.adsBatchProxySave?.addEventListener('click', async () => {
  if (!batchProxyMode || !window.aidcpEdge || typeof window.aidcpEdge.adsUpdateEnvProxies !== 'function') return;
  const userIds = selectedBatchProxyIds();
  if (userIds.length === 0) return;
  const requestId = nextBatchProxyRequestId();
  batchProxyActiveRequest = { requestId, total: userIds.length, completed: 0 };
  setBatchProxyBusy(true);
  fields.adsBatchProxySave.disabled = true;
  renderBatchProxyProgress(0, userIds.length, { running: true });
  setBatchProxyMsg('', false);
  try {
    const result = await window.aidcpEdge.adsUpdateEnvProxies({
      ...formAdsOpts(),
      requestId,
      userIds,
      proxyType: fields.adsBatchProxyType.value,
      proxyText: fields.adsBatchProxyText.value,
    });
    if (result && result.ok) {
      const count = result.updatedCount || userIds.length;
      exitBatchProxyMode({ clearText: true });
      await refreshEnvs({ suppressAutoJoin: true });
      setEnvMsg(`已更新 ${count} 个环境的代理配置，下次启动生效。`, false);
      return;
    }
    const completed = result && Number.isInteger(result.updatedCount)
      ? result.updatedCount
      : batchProxyActiveRequest && batchProxyActiveRequest.requestId === requestId
        ? batchProxyActiveRequest.completed
        : 0;
    renderBatchProxyProgress(completed, userIds.length);
    const counts = result && Number.isInteger(result.updatedCount) && Number.isInteger(result.notAttemptedCount)
      ? `；已更新 ${result.updatedCount} 个，${result.notAttemptedCount} 个未执行。`
      : '';
    setBatchProxyMsg(`修改失败：${(result && result.error) || '未知错误'}；已完成 ${completed}/${userIds.length}${counts}`, true);
    if (result && result.updatedCount > 0) await refreshEnvs({ suppressAutoJoin: true });
  } catch (error) {
    const completed = batchProxyActiveRequest && batchProxyActiveRequest.requestId === requestId
      ? batchProxyActiveRequest.completed
      : 0;
    renderBatchProxyProgress(completed, userIds.length);
    setBatchProxyMsg(`修改失败：${(error && error.message) || error}；已完成 ${completed}/${userIds.length}`, true);
  } finally {
    if (batchProxyActiveRequest && batchProxyActiveRequest.requestId === requestId) batchProxyActiveRequest = null;
    if (batchProxyMode) {
      setBatchProxyBusy(false);
      populateEnvs(lastProfiles);
      if (fields.adsBatchProxySave) fields.adsBatchProxySave.disabled = false;
    }
  }
});

// 每行删除按钮：点两次确认（第一次「删」→「确认删除?」armed 态，4s 自动收回；第二次才真删）。
// 删除不可恢复（若已登录账号其登录态一并丢失）——故绝不一次点就删、绝不自动/批量（C3 放宽为 UI 确认删）。
function makeDeleteBtn(prof, displayName) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ads-env-del';
  const cleanupPending = Boolean(prof.offboardPending);
  btn.textContent = cleanupPending ? '继续清理' : '删';
  let armed = false;
  let timer = null;
  const disarm = () => {
    armed = false;
    btn.textContent = cleanupPending ? '继续清理' : '删';
    btn.classList.remove('armed');
    if (timer) { clearTimeout(timer); timer = null; }
  };
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // 不触发行选中
    if (!armed) {
      armed = true;
      btn.textContent = cleanupPending ? '确认继续清理?' : '确认删除?';
      btn.classList.add('armed');
      btn.title = cleanupPending
        ? `继续核对「${displayName}」的 Edge 清密文结果；Cloud 确认前不会物理删除`
        : `永久删除「${displayName}」，不可恢复；视频号环境会先撤权并清除 Edge 登录密文`;
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    if (!window.aidcpEdge || typeof window.aidcpEdge.adsDeleteEnv !== 'function') return;
    btn.disabled = true;
    setEnvMsg(`正在删除「${displayName}」…`, false);
    try {
      const r = await window.aidcpEdge.adsDeleteEnv({ ...formAdsOpts(), userId: prof.userId });
      if (r && r.ok && r.cleanupPending) {
        setEnvMsg(r.message || `已撤销「${displayName}」的访问，等待设备确认清理。`, false);
        btn.disabled = false;
        await refreshEnvs({ suppressAutoJoin: true });
      } else if (r && r.ok) {
        setEnvMsg(`已删除环境「${displayName}」。`, false);
        // 删除云端 profile 成功后一并把它从本地运行花名册移出——否则本地残留成「谁都删不掉」的孤儿：
        // 移出按钮只在云端实时列表里的环境行上出现，profile 一删该行随即消失、再无移除入口（刷新剔孤儿是补救）。
        if (rosterHas(prof.userId)) removeFromRoster(prof.userId, { remember: false });
        refreshEnvs({ suppressAutoJoin: true }); // 删除后不触发「唯一环境自动加入」（否则会静默拉进无关的剩余环境，评审 Finding 1）
      } else {
        setEnvMsg(`删除失败：${(r && r.error) || '未知错误'}`, true);
        btn.disabled = false;
      }
    } catch {
      btn.disabled = false;
    }
  });
  return btn;
}

// 直接把环境铺成可点行（非下拉）。每行：名称 + 序号/分组/代理配置/user_id + 成员标记/移出 + 删除按钮。
// 多选（edge-multi-environment-fleet）：点行 = 加入运行花名册（已加入的行带「已加入」标记与「移出」钮）。
// 返回 { autoSelected }：恰好一个环境、花名册为空、核心未在跑、且调用方 allowAutoJoin 放行时自动加入（spec：
// 唯一环境自动加入花名册；多环境不代选、已有成员不覆盖、在跑不动配置；删除/剔孤儿后的刷新不放行，见 refreshEnvs）。
// 注：这里 MUST NOT 把「不在本次云端列表里的花名册成员」当作已删除渲染成可移除的残留行——本次列表可能是
// 偶发的 success-but-empty 或截断（>1000）结果，误标会把在用环境说成已删除并给一键移出（自残）。孤儿的自动
// 清理只由 refreshEnvs→pruneOrphanRoster 在「成功且完整且非空」时做；边角（空/截断）宁可留孤儿、不误删。
function populateEnvs(profiles, allowAutoJoin = false) {
  lastProfiles = Array.isArray(profiles) ? profiles : [];
  if (currentStatus) renderProxyRuntime(currentStatus, selectedEnvPlatform() === 'facebook');
  const list = settingsUi.adsEnvList;
  const current = settingsUi.adsProfile.value.trim();
  list.innerHTML = '';
  if (!profiles.length) {
    const empty = document.createElement('p');
    empty.className = 'ads-env-empty';
    empty.textContent = '未找到环境，可手动填写分身 ID 或新建环境。';
    list.appendChild(empty);
    return { autoSelected: null };
  }
  let firstItem = null;
  let currentSelected = null;
  for (const prof of profiles) {
    // 平台显示优先级：花名册成员的人工标注（settings 持久化）> 列表推断（remark 权威 / 兜底信号）。
    const member = roster.find((m) => m.profileId === prof.userId);
    const displayName = environmentManagementDisplayName(prof, member);
    const displayPlat = normPlatform(member ? member.platform : prof.platform);
    const inferred = !member && prof.platformSource && prof.platformSource !== 'remark';
    const runtime = profileRuntimeForManagement(prof.userId);
    const item = document.createElement('div');
    item.className = 'ads-env-item';
    const batchDisabled = Boolean(prof.offboardPending) || runtime.active;
    if (batchProxyMode) {
      item.classList.add('batch-select');
      if (batchDisabled) item.classList.add('batch-disabled');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'ads-env-check';
      check.setAttribute('aria-label', `选择 ${displayName}`);
      check.checked = batchProxySelectedIds.has(prof.userId);
      check.disabled = batchDisabled;
      check.title = batchDisabled ? '该环境正在使用或清理中，请先关闭后再修改代理' : '选择该环境';
      check.addEventListener('click', (event) => event.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked) batchProxySelectedIds.add(prof.userId);
        else batchProxySelectedIds.delete(prof.userId);
        void refreshBatchProxyPreview();
      });
      item.appendChild(check);
    }
    const text = document.createElement('div');
    text.className = 'env-text';
    const name = document.createElement('div');
    name.className = 'env-name';
    const platChip = document.createElement('span');
    platChip.className = `env-plat plat-${displayPlat}${inferred ? ' inferred' : ''}`;
    platChip.textContent = platformLabel(displayPlat) + (inferred ? '?' : '');
    platChip.title = inferred
      ? (prof.platformSource === 'fallback'
        ? '平台未标注，默认按小红书；如不对可点「改平台」修正'
        : '平台由环境信息推断；如不对可点「改平台」修正')
      : '该环境的运行平台';
    name.appendChild(platChip);
    name.appendChild(document.createTextNode(displayName));
    const meta = document.createElement('div');
    meta.className = 'env-meta';
    const bits = [];
    if (prof.serialNumber) bits.push('#' + prof.serialNumber);
    if (prof.groupName) bits.push(prof.groupName);
    bits.push(runtime.label);
    bits.push(prof.proxy || '无代理配置');
    bits.push(prof.userId);
    meta.textContent = bits.join(' · ');
    text.appendChild(name);
    text.appendChild(meta);
    item.appendChild(text);
    if (batchProxyMode) {
      const state = document.createElement('span');
      state.className = 'env-member-badge';
      state.textContent = batchDisabled ? '请先关闭' : (rosterHas(prof.userId) ? '已加入' : '未加入');
      item.appendChild(state);
    } else if (prof.offboardPending) {
      const badge = document.createElement('span');
      badge.className = 'env-member-badge';
      badge.textContent = prof.offboardPending.state === 'tombstoned' ? '待物理清理' : '已撤权·清理中';
      item.appendChild(badge);
    } else if (prof.userId && rosterHas(prof.userId)) {
      const badge = document.createElement('span');
      badge.className = 'env-member-badge';
      badge.textContent = '已加入';
      item.appendChild(badge);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'ads-env-remove';
      removeBtn.textContent = '移出';
      removeBtn.title = '移出环境列表（不删除环境本身）';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromRoster(prof.userId);
      });
      item.appendChild(removeBtn);
    } else {
      const badge = document.createElement('span');
      badge.className = 'env-member-badge unjoined';
      badge.textContent = '未加入';
      item.appendChild(badge);
      const joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.className = 'ads-env-join';
      joinBtn.textContent = '加入';
      joinBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void selectProfile(prof.userId, item, prof.name || prof.username || '', prof.platform, displayName);
      });
      item.appendChild(joinBtn);
    }
    if (!batchProxyMode && !prof.offboardPending) item.appendChild(makePlatformBtn(prof, displayPlat, displayName));
    if (!batchProxyMode && !prof.offboardPending) item.appendChild(makeProxyBtn(prof, displayName));
    if (!batchProxyMode) item.appendChild(makeDeleteBtn(prof, displayName));
    if (!batchProxyMode && !prof.offboardPending) {
      item.addEventListener('click', () => {
        void selectProfile(
          prof.userId,
          item,
          prof.name || prof.username || '',
          member ? member.platform : prof.platform,
          displayName,
        );
      });
    }
    if (!batchProxyMode && prof.userId && prof.userId === current) {
      item.classList.add('selected');
      currentSelected = displayName;
    }
    if (!firstItem) firstItem = item;
    list.appendChild(item);
  }
  // 唯一环境自动加入（首次列出的便利）：仅当调用方 allowAutoJoin 放行。删除/剔孤儿后触发的刷新绝不放行，
  // 否则会把一个无关的剩余环境静默拉进运行队列（评审 Finding 1 回归）。
  if (!batchProxyMode && !lastAssignmentScoped && allowAutoJoin && profiles.length === 1 && !profiles[0].offboardPending
    && !current && roster.length === 0 && profiles[0].userId && !coreRunning()) {
    void selectProfile(profiles[0].userId, firstItem, profiles[0].name, profiles[0].platform);
    return { autoSelected: profiles[0].name || profiles[0].userId };
  }
  return { autoSelected: null, currentSelected };
}

// 显式改平台入口（edge-client-proxy-platform-persona-ux）：纠正无 remark 标注环境的误推断。
// 人工选择写进花名册成员（settings 持久化）并覆盖推断；remark 有标注的环境同样可覆盖显示/启动平台
// （启动注入以 settings 花名册为准）。非成员先就地改显示，加入花名册时随之持久化。
function makePlatformBtn(prof, displayPlat, displayName) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ads-env-plat-switch';
  btn.textContent = '改平台';
  btn.title = '切换该环境的运行平台（小红书 ↔ Facebook）';
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // 不触发行选中
    const next = normPlatform(displayPlat) === 'facebook' ? 'xiaohongshu' : 'facebook';
    prof.platform = next;
    prof.platformSource = 'manual';
    const member = roster.find((m) => m.profileId === prof.userId);
    if (member) { member.platform = next; void persistRoster(); }
    if (settingsUi.adsProfile.value.trim() === prof.userId) selectedPlatform = next;
    refreshRosterMarks(); // lastProfiles 就地更新，重绘列表行
    setEnvMsg(`已把「${displayName}」标为 ${platformLabel(next)}${member ? '（已保存，下次启动生效）' : '（加入后随启动生效）'}。`, false);
  });
  return btn;
}

// 每行「代理」编辑入口：点击后只按该环境精确读取完整配置（密码仅当前内存态），再经受限 user/update 保存。
function makeProxyBtn(prof, displayName) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ads-env-proxy';
  btn.textContent = '代理';
  btn.title = `查看 / 修改该环境的代理（当前：${prof.proxy || '无代理配置'}）`;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // 不触发行选中
    if (!window.aidcpEdge || typeof window.aidcpEdge.adsGetEnvProxy !== 'function') {
      setEnvMsg('当前客户端不支持读取完整代理配置，请升级后重试。', true);
      return;
    }
    btn.disabled = true;
    setEnvMsg(`正在读取「${displayName}」的代理配置…`, false);
    try {
      const r = await window.aidcpEdge.adsGetEnvProxy({ ...formAdsOpts(), userId: prof.userId });
      if (!r || !r.ok) {
        setEnvMsg(`读取代理配置失败：${(r && r.error) || '未知错误'}`, true);
        return;
      }
      if (!lastProfiles.some((item) => item && item.userId === prof.userId)) {
        setEnvMsg('目标环境已不在当前列表，已丢弃本次代理读取结果。', true);
        return;
      }
      openProxyPop(prof, { ...(r.proxy || {}), noProxy: r.noProxy === true }, displayName);
      if (r.repairRequired) {
        setProxyPopMsg(r.readWarning || '当前代理配置无法读取，请重新填写并覆盖。', true);
      }
      setEnvMsg('', false);
    } catch (err) {
      setEnvMsg(`读取代理配置失败：${(err && err.message) || err}`, true);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

// 拉取环境列表；失败诚实降级为手敲（疑似鉴权失败提示已用当前填写值、别叫用户重填已填的框）。
async function refreshEnvs(opts) {
  const suppressAutoJoin = Boolean(opts && opts.suppressAutoJoin);
  settingsUi.adsRefresh.disabled = true;
  setEnvMsg('正在拉取指纹浏览器环境…', false);
  try {
    const r = await window.aidcpEdge.adsListProfiles(formAdsOpts());
    if (!r || !r.ok) {
      const authHint = r && r.authLikely
        ? '：疑似开启了 API 校验；若已在「高级设置」里填了 API Key，本次刷新已用当前填写值，请确认 Key 正确后重试'
        : '';
      setEnvMsg(`拉取环境失败${r && r.error ? '（' + r.error + '）' : ''}${authHint}。可在下方手动填写分身 ID。`, true);
      openAdvanced();
      return false;
    }
    const profiles = r.profiles || [];
    lastAssignmentScoped = Boolean(r.assignmentScoped);
    // 拉列表时以实时名回填花名册成员名（change edge-env-name-live-sync），治左栏展示名与添加面板漂移。
    // **先回填、再剔孤儿、最后归属默认入册**，三类草稿合并为一次落盘。
    // 同守 !r.truncated：截断/不全的拉取绝不回填（不因缺数据误改在用环境名）。
    const renamedCount = r.truncated ? 0 : reconcileRosterNames(profiles);
    // 刷新即清理孤儿：花名册里在本机指纹浏览器已不存在的环境（AdsPower profile 已删、本地残留）自动移出。
    // 安全闸：仅在成功拉取（本分支即 r.ok）且列表**完整**（!r.truncated）时剔——拉取失败已走上面 !r.ok 分支；
    // 截断时列表不全（成员可能在未显示的后续页），绝不剔，杜绝「一次不全的拉取把整份花名册误清空」。
    // 孤儿判据按「本机物理是否还在」（change edge-client-env-scope-and-logout）：gated 时 profiles 已按云端可见集收窄，
    // 若拿它剔孤儿会把「云端降范围但本机仍在」的环境误当云端已删而销毁花名册项+破坏再授权自动恢复；故用 main 另带的
    // physicalUserIds（本机全部物理分身 id）；未 gated 时该字段缺省、回落用 profiles 自身 id（与旧行为逐字一致）。
    const physicalIds = Array.isArray(r.physicalUserIds) ? r.physicalUserIds : profiles.map((p) => p.userId).filter(Boolean);
    const prunedCount = r.truncated ? 0 : pruneOrphanRoster(physicalIds);
    // 客户模式默认移入只接受成功、完整且非空的权威收窄结果；截断/空响应保持花名册和排除集合原样。
    const assigned = r.truncated ? { added: [], exclusionsChanged: false } : reconcileAssignedRoster(profiles);
    const saved = renamedCount > 0 || prunedCount > 0 || assigned.added.length > 0 || assigned.exclusionsChanged
      ? await persistRoster()
      : null;
    // 删除后刷新（suppressAutoJoin）或本轮剔了孤儿（prunedCount>0，花名册刚被动清空）时绝不自动加入——
    // 否则「唯一环境自动加入」会把一个无关的剩余环境静默拉进运行队列（评审 Finding 1）。
    const allowAutoJoin = !lastAssignmentScoped && !suppressAutoJoin && prunedCount === 0;
    const { autoSelected, currentSelected } = populateEnvs(profiles, allowAutoJoin);
    const extra = r.truncated ? '（环境较多，仅显示前若干条，可用分组精简）' : '';
    const cleaned = prunedCount > 0 ? `已清理 ${prunedCount} 个云端已删除的残留环境。` : '';
    const autoHint = assigned.added.length > 0
      ? saved && saved.saveOk === false
        ? `已加入 ${assigned.added.length} 个环境（未自动启动），但写盘失败：${saved.saveError || '未知错误'}。`
        : `已加入 ${assigned.added.length} 个环境（未自动启动）。`
      : autoSelected
        ? `已自动加入唯一环境「${autoSelected}」。`
      : currentSelected
        ? `已选中「${currentSelected}」。`
        : lastAssignmentScoped
          ? '已移出的环境可再次加入。'
          : '点选或点击“加入”即可加入环境。';
    setEnvMsg(`已加载 ${profiles.length} 个环境${extra}。${cleaned}${autoHint}`, false);
    return true;
  } catch (e) {
    setEnvMsg(`拉取环境失败（${e && e.message ? e.message : e}）。可在下方手动填写分身 ID。`, true);
    openAdvanced();
    return false;
  } finally {
    settingsUi.adsRefresh.disabled = false;
  }
}

settingsUi.adsRefresh.addEventListener('click', refreshEnvs);
// 创建提示行（与环境列表提示分开，避免互相覆盖）。
function setCreateMsg(text, isError) {
  if (!settingsUi.adsCreateMsg) return;
  settingsUi.adsCreateMsg.textContent = text;
  settingsUi.adsCreateMsg.classList.toggle('error', !!isError);
}

// 操作系统下拉：复用旧 adsTemplates IPC 名称，内容已是 OS family。
async function populateTemplates() {
  if (!settingsUi.adsTemplate || !window.aidcpEdge || typeof window.aidcpEdge.adsTemplates !== 'function') return;
  try {
    const list = await window.aidcpEdge.adsTemplates();
    if (!Array.isArray(list) || !list.length) return;
    settingsUi.adsTemplate.innerHTML = '';
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t.key;
      opt.textContent = t.label || t.key;
      settingsUi.adsTemplate.appendChild(opt);
    }
  } catch {
    /* 静默：操作系统选项拉取失败不影响其它 */
  }
}
populateTemplates();
updateFacebookImportVisibility();
if (settingsUi.adsPlatform) settingsUi.adsPlatform.addEventListener('change', updateFacebookImportVisibility);
if (settingsUi.adsFbCreateMode) settingsUi.adsFbCreateMode.addEventListener('change', updateFacebookImportVisibility);
for (const button of settingsUi.adsPlatformButtons || []) {
  button.addEventListener('click', () => {
    if (environmentCreateInFlight || !settingsUi.adsPlatform) return;
    settingsUi.adsPlatform.value = button.dataset.createPlatform || 'xiaohongshu';
    settingsUi.adsPlatform.dispatchEvent(new Event('change', { bubbles: true }));
  });
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const buttons = settingsUi.adsPlatformButtons || [];
    const index = buttons.indexOf(button);
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = buttons[(index + delta + buttons.length) % buttons.length];
    next?.click();
    next?.focus();
  });
}
settingsUi.adsProxyToggle?.addEventListener('click', () => {
  if (environmentCreateInFlight) return;
  setCreateProxyExpanded(settingsUi.adsProxyToggle.getAttribute('aria-expanded') !== 'true');
});

// ── 代理表单（edge-client-proxy-platform-persona-ux）：新建可选区块 + 已有环境编辑浮层共用读值/校验 ──
// 主校验在主进程归一层（ads-proxy-config），前端只做「选了类型必须填 host/port」的即时反馈。
function readProxyForm(ui) {
  return {
    proxyType: ui.type ? ui.type.value : 'no_proxy',
    proxyHost: ui.host ? ui.host.value.trim() : '',
    proxyPort: ui.port ? ui.port.value.trim() : '',
    proxyUser: ui.user ? ui.user.value.trim() : '',
    proxyPassword: ui.pass ? ui.pass.value : '',
  };
}
function quickProxyCheck(p) {
  if (p.proxyType === 'no_proxy') return '';
  if (!p.proxyHost) return '请填写代理地址';
  if (!/^\d+$/.test(p.proxyPort) || Number(p.proxyPort) < 1 || Number(p.proxyPort) > 65535) return '端口须为 1-65535 的整数';
  if (p.proxyPassword && !p.proxyUser) return '填了密码就必须填用户名';
  return '';
}
const createProxyUi = {
  type: settingsUi.adsProxyType,
  host: settingsUi.adsProxyHost,
  port: settingsUi.adsProxyPort,
  user: settingsUi.adsProxyUser,
  pass: settingsUi.adsProxyPass,
};
function resetCreateProxyForm() {
  if (createProxyUi.type) createProxyUi.type.value = 'no_proxy';
  for (const k of ['host', 'port', 'user', 'pass']) if (createProxyUi[k]) createProxyUi[k].value = '';
  if (settingsUi.adsProxyBatch) settingsUi.adsProxyBatch.value = '';
  if (settingsUi.adsFbPrimarySurface) settingsUi.adsFbPrimarySurface.value = 'reels';
  setCreateProxyExpanded(false);
  updateFacebookImportVisibility();
}
settingsUi.adsProxyType?.addEventListener('change', () => {
  if (settingsUi.adsProxyType.value !== 'no_proxy') setCreateProxyExpanded(true);
  updateFacebookImportVisibility();
});

// 运行方式四选一 + 全局免审。Edge 只提交模式，规则/消费节奏始终由 Cloud 保存和解释。
// 只在 Facebook 时组装这些意图；其它平台一个键都不带 —— 主进程对非 Facebook 的携带一律整请求拒绝。
const CREATE_RUN_MODES = ['normal', 'cold_start', 'rule', 'consumption'];
function readFacebookCreationIntents(platform) {
  if (platform !== 'facebook') return {};
  const raw = settingsUi.adsFbRunMode ? String(settingsUi.adsFbRunMode.value || '') : '';
  const runMode = CREATE_RUN_MODES.includes(raw) ? raw : 'normal';
  const rawSurface = settingsUi.adsFbPrimarySurface
    ? String(settingsUi.adsFbPrimarySurface.value || '')
    : '';
  const primarySurface = FACEBOOK_PRIMARY_SURFACES.has(rawSurface) ? rawSurface : 'reels';
  const autoApprove = Boolean(settingsUi.adsFbApproval && settingsUi.adsFbApproval.checked);
  return {
    facebookRunMode: runMode,
    facebookPrimarySurface: primarySurface,
    ...(autoApprove ? { commentApprovalMode: 'auto_approve_all' } : {}),
  };
}

/**
 * 创建回执里的运行方式 / 免审说明。非乐观：只有主进程带回「已确认」才敢说已配置；
 * 未选冷启动时如实说明该环境未配置慢启动，不追加任何风险告警。
 */
function facebookCreateConfigHint(receipt) {
  const mode = receipt && receipt.runMode;
  if (!CREATE_RUN_MODES.includes(mode)) return '';
  const parts = [];
  if (receipt.operationModeConfigured !== true) {
    parts.push('运行方式尚未获得 Cloud 回读确认。');
  }
  if (receipt.primarySurfaceConfigured !== true) {
    parts.push('主浏览入口尚未获得 Cloud 回读确认。');
  }
  if (mode === 'cold_start') {
    parts.push(receipt.slowStartConfigured === true
      ? '已按冷启动为该环境配置慢启动（只收紧每日操作额度，不改变操作速度）。'
      : '冷启动的慢启动尚未获得云端确认。');
  } else {
    parts.push('该环境未配置慢启动。');
    if (mode === 'rule') {
      parts.push(receipt.ruleModeConfigured === true
        ? '已按规则运行方式为该环境配置规则模式。'
        : '规则模式尚未获得云端确认。');
    } else if (mode === 'consumption') {
      parts.push(receipt.consumptionModeConfigured === true
        ? '已按消费运行方式为该环境配置消费模式；节奏由 Cloud 管理。'
        : '消费模式尚未获得云端确认。');
    }
  }
  if (receipt.commentApprovalConfigured === true) {
    parts.push('全局免审已配置（只免去评论提交前的第二次人工审核）。');
  } else if (receipt.commentApprovalConfigured === false) {
    parts.push('全局免审尚未获得云端确认。');
  }
  return parts.join('');
}

// 「创建环境」程序化建号：单建挑 OS family；Facebook 批量由主进程逐账号随机 OS family、代理按行轮询。
settingsUi.adsCreate.addEventListener('click', async () => {
  const platform = normPlatform(settingsUi.adsPlatform && settingsUi.adsPlatform.value);
  const batch = platform === 'facebook'
    && settingsUi.adsFbCreateMode
    && settingsUi.adsFbCreateMode.value === 'batch';
  // 当前账号的权威 fleet 已确认为空，就属于首次引导候选。本机 settings 可能保留其他账号的
  // 历史环境，不能用它否定当前账号的零环境状态；未知 / 失败状态仍绝不冒充新用户。
  const firstEnvironmentCreationCandidate = !batch
    && fleetView.rosterPhase === 'ready'
    && railEnvList().length === 0;
  const osFamilyKey = settingsUi.adsTemplate && settingsUi.adsTemplate.value;
  if (!batch && !osFamilyKey) return setCreateMsg('请先选择操作系统', true);
  if (!window.aidcpEdge || typeof window.aidcpEdge.adsCreateEnv !== 'function') return;
  const facebookAccountImport = platform === 'facebook' && settingsUi.adsFbImport
    ? settingsUi.adsFbImport.value
    : '';
  if (batch && !facebookAccountImport.trim()) {
    return setCreateMsg('批量新建请至少粘贴一条 Facebook 账号资料。', true);
  }
  const proxyType = settingsUi.adsProxyType ? settingsUi.adsProxyType.value : 'no_proxy';
  const proxy = batch ? null : readProxyForm(createProxyUi);
  const proxyErr = batch ? '' : quickProxyCheck(proxy);
  if (proxyErr) return setCreateMsg(`代理输入不完整：${proxyErr}。`, true);
  const facebookProxyBatch = batch && proxyType !== 'no_proxy' && settingsUi.adsProxyBatch
    ? settingsUi.adsProxyBatch.value
    : '';
  if (batch && proxyType !== 'no_proxy' && !facebookProxyBatch.trim()) {
    return setCreateMsg('已选择代理类型，请至少粘贴一条代理资料。', true);
  }
  const withProxy = proxyType !== 'no_proxy';
  setEnvironmentCreateBusy(true);
  const batchCount = facebookAccountImport.split(/\r?\n/).filter((line) => line.trim()).length;
  setCreateMsg(batch ? `正在批量创建 ${batchCount} 个环境，请勿关闭客户端…` : '正在创建环境…', false);
  try {
    // 同一份意图供单个与批量共用；批量时主进程对本批全部环境一致生效。
    const facebookCreationIntents = readFacebookCreationIntents(platform);
    const payload = batch
      ? {
          ...formAdsOpts(),
          creationMode: 'batch',
          osFamilyKey: '',
          platform,
          batchProxyType: proxyType,
          facebookAccountImport,
          facebookProxyBatch,
          ...facebookCreationIntents,
        }
      : {
          ...formAdsOpts(),
          creationMode: 'single',
          osFamilyKey,
          platform,
          proxy,
          facebookAccountImport,
          ...facebookCreationIntents,
        };
    const r = await window.aidcpEdge.adsCreateEnv(payload);
    if (r && r.ok) {
      // 新建即选中时，带上刚起好的环境名（回执 name）与平台（回执 platform 优先，回落表单选择）。
      // 带回真名根治「新建即空名」——否则左栏回落「环境 …末4位」、与添加面板显示的真名不一致
      // （change edge-env-name-live-sync）。
      if (r.userId && !r.requiresAdminAssignment && !r.assignmentHandledByMain && !coreRunning()) {
        await selectProfile(r.userId, null, r.name || '', r.platform || platform);
      }
      if (r.rosterJoinedByMain) await syncRosterFromMainSettings();
      if (
        firstEnvironmentCreationCandidate
        && r.userId
        && !r.requiresAdminAssignment
        && (r.rosterJoinedByMain || !r.assignmentHandledByMain)
      ) {
        pendingFirstEnvironmentHandoff = { profileId: r.userId };
      }
      const selectedHint = r.rosterJoinedByMain
        ? '已分配到当前账号并加入运行环境；需要启动时请在环境栏操作。'
        : r.requiresAdminAssignment
        ? '管理员分配前不会加入环境。'
        : r.assignmentHandledByMain
          ? '已分配到当前账号，但本次未加入运行环境，请按提示处理。'
          : r.userId && !coreRunning() ? '已自动选中，可直接点「启动」。' : '点上方「刷新」可看到它。';
      const createdCount = Number(r.createdCount || (Array.isArray(r.created) ? r.created.length : 0));
      const countHint = batch
        ? `已创建 ${createdCount} 个环境。`
        : createdCount > 1 ? `已创建 ${createdCount} 个环境。` : `已创建环境（${r.osFamily || r.template || osFamilyKey}）。`;
      if (createdCount > 0 && settingsUi.adsFbImport) settingsUi.adsFbImport.value = '';
      if (batch && createdCount > 0 && settingsUi.adsProxyBatch) settingsUi.adsProxyBatch.value = '';
      const proxyHint = batch && withProxy
        ? '代理已按粘贴顺序轮询分配并随建号写入。'
        : withProxy ? '代理已随建号写入。' : '未配代理，可稍后在环境行「代理」里补配。';
      const configHint = facebookCreateConfigHint(r);
      const visibilityHint = r.visibilityWarning ? r.visibilityWarning : '';
      setCreateMsg(
        `${countHint}${selectedHint}${proxyHint}${configHint}${visibilityHint}`,
        Boolean(r.visibilityWarning),
      );
      resetCreateProxyForm();
      await refreshEnvs();
      if (!batch && r.userId && rosterHas(r.userId)) {
        const createdProfile = lastProfiles.find((profile) => profile && profile.userId === r.userId);
        const createdName = r.name || (createdProfile && createdProfile.name) || r.userId;
        if (pendingFirstEnvironmentHandoff && pendingFirstEnvironmentHandoff.profileId === r.userId) {
          setCreateMsg(`已自动选中「${createdName}」，正在同步到主界面…`, false);
          await refreshAuthoritativeFleet({ showLoading: false });
        } else {
          setEnvMsg(`已选中「${createdName}」。环境已创建并加入环境栏，未启动前显示为离线。`, false);
          switchEnvTab('join', true);
        }
      }
    } else {
      const extra = r && r.violations && r.violations.length ? '（' + r.violations.join('；') + '）' : '';
      const createdCount = Number(r && (r.createdCount || (Array.isArray(r.created) ? r.created.length : 0)) || 0);
      const prefix = createdCount > 0 ? '批量创建未完成' : '创建失败';
      setCreateMsg(`${prefix}：${(r && r.error) || '未知错误'}${extra}。`, true);
      if (createdCount > 0) await refreshEnvs();
    }
  } catch (error) {
    setCreateMsg(`创建失败：${(error && error.message) || error || '未知错误'}。`, true);
  } finally {
    setEnvironmentCreateBusy(false);
    completePendingFirstEnvironmentHandoff();
  }
});

// ── 环境代理编辑浮层：预填精确目标读取结果（含内存态密码），保存 = 整体替换、下次启动生效 ──
const PROXY_TYPE_OPTIONS = new Set(['http', 'https', 'socks5']);
let proxyPopTarget = null; // { userId, name }
function setProxyPopMsg(text, isError) {
  if (!fields.proxyPopMsg) return;
  fields.proxyPopMsg.textContent = text || '';
  fields.proxyPopMsg.classList.toggle('error', Boolean(isError));
}
function syncProxyPopDetail() {
  fields.proxyPopDetail?.classList.toggle('hidden', fields.proxyPopType && fields.proxyPopType.value === 'no_proxy');
}
async function parseProxyQuickPaste() {
  const proxyText = fields.proxyPopQuick ? fields.proxyPopQuick.value.trim() : '';
  if (!proxyText) return;
  const epoch = ++proxyQuickParseEpoch;
  if (!fields.proxyPopType || fields.proxyPopType.value === 'no_proxy') {
    setProxyPopMsg('请先选择 HTTP、HTTPS 或 SOCKS5。', true);
    return;
  }
  if (!window.aidcpEdge || typeof window.aidcpEdge.adsParseProxyLines !== 'function') {
    setProxyPopMsg('当前客户端未加载代理解析能力，请重启后重试。', true);
    return;
  }
  const parsed = await window.aidcpEdge.adsParseProxyLines({
    proxyType: fields.proxyPopType.value,
    proxyText,
  });
  if (epoch !== proxyQuickParseEpoch || !proxyPopTarget
    || fields.proxyPopQuick.value.trim() !== proxyText) return;
  if (!parsed || !parsed.ok) {
    setProxyPopMsg((parsed && parsed.error) || '代理格式不正确。', true);
    return;
  }
  if (!Array.isArray(parsed.proxies) || parsed.proxies.length !== 1) {
    setProxyPopMsg('单个环境请只粘贴一条代理。', true);
    return;
  }
  const proxy = parsed.proxies[0];
  fields.proxyPopHost.value = proxy.proxyHost || '';
  fields.proxyPopPort.value = proxy.proxyPort || '';
  fields.proxyPopUser.value = proxy.proxyUser || '';
  fields.proxyPopPass.value = proxy.proxyPassword || '';
  setProxyPopMsg('已解析并填入，可继续修改后保存。', false);
}
function openProxyPop(prof, proxyConfig, displayName) {
  if (!fields.proxyPop) return;
  proxyQuickParseEpoch += 1;
  proxyPopTarget = { userId: prof.userId, name: displayName };
  if (fields.proxyPopEnv) fields.proxyPopEnv.textContent = `· ${proxyPopTarget.name}`;
  // 当前配置如实呈现（含 UI 下拉表达不了的代理厂商类型——保存会整体替换，这行让用户知道在替换什么）。
  if (fields.proxyPopCurrent) fields.proxyPopCurrent.textContent = `当前：${prof.proxy || '无代理配置'}`;
  const cfg = proxyConfig || {};
  if (fields.proxyPopType) {
    fields.proxyPopType.value = !cfg.noProxy && PROXY_TYPE_OPTIONS.has(cfg.proxyType) ? cfg.proxyType : 'no_proxy';
  }
  if (fields.proxyPopHost) fields.proxyPopHost.value = cfg.noProxy ? '' : (cfg.proxyHost || '');
  if (fields.proxyPopPort) fields.proxyPopPort.value = cfg.noProxy ? '' : (cfg.proxyPort || '');
  if (fields.proxyPopUser) fields.proxyPopUser.value = cfg.noProxy ? '' : (cfg.proxyUser || '');
  if (fields.proxyPopPass) fields.proxyPopPass.value = cfg.noProxy ? '' : (cfg.proxyPassword || '');
  if (fields.proxyPopQuick) fields.proxyPopQuick.value = '';
  syncProxyPopDetail();
  setProxyPopMsg('', false);
  fields.proxyPop.classList.remove('hidden');
  fields.proxyPop.classList.add('open');
  fields.proxyPop.setAttribute('aria-hidden', 'false');
  fields.proxyMask?.classList.remove('hidden');
}
function closeProxyPop() {
  if (!fields.proxyPop) return;
  proxyQuickParseEpoch += 1;
  proxyPopTarget = null;
  if (fields.proxyPopQuick) fields.proxyPopQuick.value = '';
  fields.proxyPop.classList.remove('open');
  fields.proxyPop.classList.add('hidden');
  fields.proxyPop.setAttribute('aria-hidden', 'true');
  fields.proxyMask?.classList.add('hidden');
}
fields.proxyClose?.addEventListener('click', closeProxyPop);
fields.proxyMask?.addEventListener('click', closeProxyPop);
fields.proxyPopType?.addEventListener('change', () => {
  syncProxyPopDetail();
  if (fields.proxyPopQuick && fields.proxyPopQuick.value.trim()) void parseProxyQuickPaste();
});
fields.proxyPopQuick?.addEventListener('paste', () => setTimeout(() => { void parseProxyQuickPaste(); }, 0));
fields.proxyPopQuick?.addEventListener('change', () => { void parseProxyQuickPaste(); });
fields.proxySave?.addEventListener('click', async () => {
  if (!proxyPopTarget || !window.aidcpEdge || typeof window.aidcpEdge.adsUpdateEnvProxy !== 'function') return;
  const proxy = readProxyForm({
    type: fields.proxyPopType,
    host: fields.proxyPopHost,
    port: fields.proxyPopPort,
    user: fields.proxyPopUser,
    pass: fields.proxyPopPass,
  });
  const err = quickProxyCheck(proxy);
  if (err) return setProxyPopMsg(err, true);
  fields.proxySave.disabled = true;
  setProxyPopMsg('正在保存…', false);
  try {
    const r = await window.aidcpEdge.adsUpdateEnvProxy({ ...formAdsOpts(), userId: proxyPopTarget.userId, proxy });
    if (r && r.ok) {
      const targetName = proxyPopTarget.name;
      closeProxyPop();
      await refreshEnvs({ suppressAutoJoin: true });
      setEnvMsg(`已更新「${targetName}」的代理（${proxy.proxyType === 'no_proxy' ? '已清除代理' : proxy.proxyType}），下次启动该环境生效。`, false);
    } else {
      setProxyPopMsg(`保存失败：${(r && r.error) || '未知错误'}`, true);
    }
  } catch (e) {
    setProxyPopMsg(`保存失败：${(e && e.message) || e}`, true);
  } finally {
    if (fields.proxySave) fields.proxySave.disabled = false;
  }
});

// 「按新设置重启」：先保存当前设置，再显式重启把改动应用到运行中的自动化引擎。
settingsUi.applyRestart.addEventListener('click', async () => {
  settingsUi.applyRestart.disabled = true;
  try {
    const saved = await saveCurrentSettings();
    if (saved && saved.saveOk === false) {
      settingsUi.msg.textContent = `设置本次生效但写盘失败：${saved.saveError || ''}（重启应用后可能丢失）`;
    }
    const next = await window.aidcpEdge.restart(currentEnvId());
    if (next) routeStatus(next);
  } finally {
    settingsUi.applyRestart.disabled = false;
  }
});

// 单环境生命周期的唯一 renderer 出口：旧工作区与视频号 InteractionWorkspace 共用，确保“启动”始终先保存设置。
async function runSessionLifecycle(action, envId = currentEnvId()) {
  if (action === 'resume') {
    // 恢复 = 重建自动化引擎。若暂停期间改过浏览器设置，先落盘再恢复，否则会按旧设置启动。
    if (!(await persistDirtyBeforeRestart('设置已保存，正在按新设置恢复…'))) return null;
    return window.aidcpEdge.resume(envId);
  }
  if (action === 'start') {
    // 启动 = 先保存当前设置再启动（保存并入启动，无独立保存按钮）。
    if (selectedProvider() === 'adspower' && !settingsUi.adsProfile.value.trim() && roster.length === 0) {
      promptMissingAdsProfile();
      return null;
    }
    const saved = await saveCurrentSettings();
    settingsUi.msg.textContent = saved && saved.saveOk === false
      ? `设置本次生效但写盘失败：${saved.saveError || ''}（重启应用后可能丢失）`
      : '设置已保存，正在开始自动化；浏览器将按需申请槽位…';
    return window.aidcpEdge.start(envId);
  }
  if (action === 'pause') return window.aidcpEdge.pause(envId);
  if (action === 'close') return window.aidcpEdge.close(envId);
  return null;
}

// 今日进展会话按钮：三态触发 恢复 / 启动（=先保存再启动） / 暂停。无独立「保存」按钮。
fields.firstEnvironmentStartGuideClose?.addEventListener('click', clearFirstEnvironmentStartGuide);
fields.sessionFab.addEventListener('click', async () => {
  const action = fields.sessionFab.dataset.action;
  if (action === 'start') clearFirstEnvironmentStartGuide();
  fields.sessionFab.disabled = true;
  try {
    const next = await runSessionLifecycle(action, currentEnvId());
    if (next) routeStatus(next);
  } finally {
    if (currentStatus) renderFab(currentStatus);
    else fields.sessionFab.disabled = false;
  }
});

fields.sessionClose?.addEventListener('click', async () => {
  fields.sessionClose.disabled = true;
  fields.sessionFab.disabled = true;
  try {
    if (fields.sessionClose.dataset.lifecycleAction === 'close') {
      const next = await window.aidcpEdge.close(currentEnvId());
      if (next) routeStatus(next);
      return;
    }
    const action = fields.sessionClose.dataset.browserAction;
    if (action === 'open') {
      fields.sessionClose.textContent = '浏览器开启中';
      fields.sessionClose.setAttribute('aria-label', '正在打开浏览器');
      fields.sessionClose.title = '正在打开浏览器';
    }
    const next = action === 'open'
      ? await window.aidcpEdge.browserOpen?.(currentEnvId())
      : await window.aidcpEdge.browserClose?.(currentEnvId());
    if (next) routeStatus(next);
  } finally {
    if (currentStatus) renderFab(currentStatus);
    else {
      fields.sessionClose.disabled = false;
      fields.sessionFab.disabled = false;
    }
  }
});

// 窗口内「退出登录」入口（change edge-client-env-scope-and-logout）：取代原 per-环境「重新登录」按钮。
// 作用=退出当前 name+key 客户端登录、回登录门重新登录账号，复用既有 clientLogout（清会话→拆全部环境→回登录门）。
// 仅客户鉴权启用时露出（clientAuthEnabled 为假=内部/运营构建时不出现，=零回归）。点击走二次确认（arm→「确认退出?」
// 4s 回退→再点才真登出），因为登出会停掉全部在跑环境。
// 注：通知巡视引导流的「重检」仍走 window.aidcpEdge.relogin（renderer 上文 triggerGuideRecheck 一带），是另一条路径、保留不变。
(async function initClientLogoutEntry() {
  if (!fields.clientLogout || !window.aidcpEdge || typeof window.aidcpEdge.clientSession !== 'function') return;
  let sess = null;
  try { sess = await window.aidcpEdge.clientSession(); } catch { /* 未启用/取不到 → 保持隐藏 */ }
  if (!sess || !sess.enabled) return; // 未启用客户鉴权：入口不显示
  if (fields.clientSessionName) fields.clientSessionName.textContent = sess.name ? `当前客户：${sess.name}` : '';
  fields.clientSessionFoot?.classList.remove('hidden');
  let armed = false;
  let timer = null;
  const disarm = () => {
    armed = false;
    fields.clientLogout.textContent = '退出登录';
    fields.clientLogout.classList.remove('armed');
    if (timer) { clearTimeout(timer); timer = null; }
  };
  fields.clientLogout.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      fields.clientLogout.textContent = '确认退出?';
      fields.clientLogout.classList.add('armed');
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    fields.clientLogout.disabled = true;
    try {
      await window.aidcpEdge.clientLogout(); // 清会话→拆环境→关主窗→回登录门（主进程 onSessionInvalid 接管）
    } catch {
      fields.clientLogout.disabled = false;
    }
  });
})();

const PERSONA_CONTENT_GROUPS = [
  { title: '招聘求职', items: ['骑手外卖', '蓝领零工', '数据标注', '自有兼职', '在校实习'] },
  { title: '生活记录', items: ['生活剪影', '婚礼准备'] },
  { title: '时尚', items: ['潮流玩具', '潮流活动', '鞋靴', '配饰', '发型', '箱包'] },
  { title: '影视综艺', items: ['舞蹈欣赏', '综艺娱乐'] },
  { title: '美食', items: ['美食测评', '美食 VLOG', '野外烹饪', '美食探店'] },
  { title: '情感', items: ['励志鸡汤', '情感故事', '心理学', '情感知识'] },
  { title: '美妆', items: ['美甲', '护肤', '身体护理', '香水'] },
  { title: '教育', items: ['校园教育', '家庭教育', '留学教育', '校园生活'] },
  { title: '家居家装', items: ['家居好物', '住宅装修', '居家经验', '园艺插花', '建筑分享'] },
  { title: '社科资讯', items: ['军事', '科学科普', '法律知识', '民生', '历史'] },
  { title: '兴趣才艺', items: ['手工 DIY', '文玩文创', '指玩', '益智玩具', '战术装备'] },
  { title: '亲子', items: ['孕产经验', '萌娃', '孕期穿搭', '亲子早教', '亲子好物', '母婴日常', '育儿经验'] },
  { title: '科技数码', items: ['影音设备', '手机平板', '智能家居', '前沿科技', '电脑', '智能穿戴', '数码搭配', '玩机攻略'] },
  { title: '旅游', items: ['旅游攻略'] },
  { title: '城市出行', items: ['话剧喜剧', '线下游戏', '购物体验', '展览分享', '公园游玩'] },
  { title: '医疗与健身', items: ['健康养生', '健身饮食', '体态矫正', '燃脂减肥', '减肥健康'] },
  { title: '宠物', items: ['养猫日常', '狗狗日常', '水族类', '爬行两栖', '家养宠物'] },
  { title: '二次元', items: ['宅玩', '同人衍生', '动漫'] },
  { title: '摄影', items: ['摄影器材', '摄影作品', '摄影技巧'] },
  { title: '人文艺术', items: ['文学阅读', '艺术绘画', '艺术活动', '戏剧', '艺术设计'] },
  { title: '汽车', items: ['摩托车', '看车选买', '二手车选买', '汽车知识', '新能源智能'] },
  { title: '商业财经', items: ['财经解读', '金融理财', '楼市资讯'] },
  { title: '搞笑', items: ['日常搞笑', '小剧场'] },
  { title: '音乐', items: ['原创音乐', '音乐演出', '乐器大师'] },
  { title: '游戏', items: ['手机游戏', '竞技游戏', '网络游戏', '主机游戏'] },
  { title: '体育运动', items: ['篮球', '滑雪', '跑步', '垂钓', '徒步', '游泳', '骑行', '滑板', '足球', '飞盘', '露营', '水上活动', '极限运动'] },
  { title: '个人管理', items: ['星座', '职场干货'] },
];
const PERSONA_CONTENT_PREFERENCE_LIMIT = 24;
const PERSONA_CONTENT_LIMIT_MESSAGE = '最多选择 24 个内容偏好，请先取消一个再选择';

function renderPersonaContentGroups() {
  const host = document.querySelector('#persona-content-groups');
  if (!host) return;
  host.innerHTML = '';
  PERSONA_CONTENT_GROUPS.forEach((group, idx) => {
    const rowId = `persona-custom-row-${idx}`;
    const section = document.createElement('section');
    section.className = 'persona-pref-group';

    const head = document.createElement('div');
    head.className = 'persona-pref-head';
    const title = document.createElement('strong');
    title.className = 'persona-pref-title';
    title.textContent = group.title;
    head.append(title);
    section.appendChild(head);

    const chips = document.createElement('div');
    chips.className = 'persona-kw-group';
    chips.dataset.dim = 'content';
    chips.dataset.category = group.title;
    chips.dataset.select = 'multi';
    chips.setAttribute('aria-describedby', 'persona-content-limit-msg');
    for (const item of group.items) {
      const btn = document.createElement('button');
      btn.className = 'kw-btn';
      btn.type = 'button';
      btn.dataset.kw = item;
      btn.textContent = item;
      chips.appendChild(btn);
    }
    // 自定义加号排在该类目所有预设选项之后（网格最后一格）；不是 .kw-btn，不参与选中/计数。
    const add = document.createElement('button');
    add.className = 'persona-add-custom';
    add.type = 'button';
    // 可见加号由 CSS 几何线条绘制，避免系统字体的 + 字形基线导致偏心；可访问名称保留在 aria-label。
    add.title = `自定义${group.title}偏好`;
    add.setAttribute('aria-label', `自定义${group.title}偏好`);
    add.setAttribute('aria-expanded', 'false'); // 展开态用于无障碍：指向下方就地输入框
    add.setAttribute('aria-controls', rowId);
    chips.appendChild(add);
    section.appendChild(chips);

    const custom = document.createElement('div');
    custom.id = rowId;
    custom.className = 'persona-custom-row hidden';
    const input = document.createElement('input');
    input.className = 'persona-custom-input';
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = `添加${group.title}偏好`;
    input.autocomplete = 'off';
    const confirm = document.createElement('button');
    confirm.className = 'secondary small persona-custom-add';
    confirm.type = 'button';
    confirm.textContent = '添加';
    custom.append(input, confirm);
    section.appendChild(custom);
    host.appendChild(section);
  });
}

renderPersonaContentGroups();

// ─── 建号自助人设向导（change edge-persona-keyword-generation；重设计于 edge-client-proxy-platform-persona-ux）───
// 行为契约不变：闸三态语义 / 状态推送绝不重置已选关键词与草稿 / 草稿环境锚定 / 诚实失败展示。
const personaUi = {
  stateBadge: document.querySelector('#persona-state-badge'),
  hint: document.querySelector('#persona-hint'),
  boundNote: document.querySelector('#persona-bound-note'),
  currentName: document.querySelector('#persona-current-name'),
  currentRole: document.querySelector('#persona-current-role'),
  currentBackground: document.querySelector('#persona-current-background'),
  currentTone: document.querySelector('#persona-current-tone'),
  currentLanguage: document.querySelector('#persona-current-language'),
  currentLike: document.querySelector('#persona-current-like'),
  currentTags: document.querySelector('#persona-current-tags'),
  currentDetails: document.querySelector('#persona-current-details'),
  currentYaml: document.querySelector('#persona-current-yaml'),
  update: document.querySelector('#persona-update'),
  wizardBody: document.querySelector('#persona-wizard-body'),
  kwGroups: Array.from(document.querySelectorAll('.persona-kw-group:not([data-dim="language"])')),
  languageCard: document.querySelector('#persona-language-card'),
  languageGroup: document.querySelector('#persona-language-group'),
  languageHelp: document.querySelector('#persona-language-help'),
  likeAffinityGroup: document.querySelector('.persona-kw-group[data-dim="like-affinity"]'),
  generate: document.querySelector('#persona-generate'),
  msg: document.querySelector('#persona-msg'),
  draft: document.querySelector('#persona-draft'),
  draftSummary: document.querySelector('#persona-draft-summary'),
  draftBody: document.querySelector('#persona-draft-body'),
  regenerate: document.querySelector('#persona-regenerate'),
  confirm: document.querySelector('#persona-confirm'),
  growth: document.querySelector('#persona-growth'),
  growthStart: document.querySelector('#persona-growth-start'),
  // 重设计新增：空态面板 / 两步指示 / 阶段容器 / 骨架 / 关键词摘要条
  empty: document.querySelector('#persona-empty'),
  emptyTitle: document.querySelector('#persona-empty-title'),
  emptySub: document.querySelector('#persona-empty-sub'),
  emptyAction: document.querySelector('#persona-empty-action'),
  steps: document.querySelector('#persona-steps'),
  stagePick: document.querySelector('#persona-stage-pick'),
  stagePreview: document.querySelector('#persona-stage-preview'),
  skeleton: document.querySelector('#persona-skeleton'),
  kwSummary: document.querySelector('#persona-kw-summary'),
  kwSummaryText: document.querySelector('#persona-kw-summary-text'),
  contentGroups: document.querySelector('#persona-content-groups'),
  contentCount: document.querySelector('#persona-content-count'),
  contentLimitMsg: document.querySelector('#persona-content-limit-msg'),
};
let personaReady = false; // 当前环境的 customer-auth 人设作用域已就绪（与浏览器/core 运行状态无关）
let personaDraftYaml = ''; // 当前草稿 soulYaml（确认时提交）
let personaDraftSummary = null; // 当前草稿可读摘要（保存后立即投影，不等状态心跳）
let personaDraftWritingLanguage = null; // 草稿对应的 FB 发言语言（persist 成功前不覆盖权威状态）
let personaLocallyBound = false; // 本会话确认成功后即视为已绑（personaBound 信号要等下次 hello 才到）
let personaDraftEnvId; // 草稿所属环境（多环境：persist MUST 打回生成时那个账号，不随后续切换环境漂移）
let personaStage = 'pick'; // 两步向导阶段：pick（选关键词）| preview（预览确认）
let personaInFlight = false; // 生成请求在途（骨架 + 按钮禁用 + 遮罩误点不关层）
let personaGrowthEnvId = null; // 本次刚确认成功的人设所属环境；只让该环境出现一次成长引导
let personaPersistPendingEnvId = null; // persist IPC 收敛中的环境；main 可能先推 personaBound=true，期间不得把自动弹窗收走
let personaUpdateMode = false; // 已绑账号手动进入更新流程：生成新草稿，确认后覆盖当前人设
let personaBulkFillMode = false; // FB 分类批量模板：客户端构建一份人设，Cloud 只筛缺失账号并原样写入
const personaPrompted = new Set();
const personaWritingLanguageSelections = new Map(); // envId -> zh-CN | en | vi；切环境不串号
const personaWritingLanguageDirty = new Set(); // 用户正在编辑的环境；状态心跳不得覆盖未确认选择
const personaViewsByEnv = new Map(); // envId -> { requestId, phase, state?, persona?, reason? }；晚返回不得串环境
let personaViewRequestId = 0;
let personaContentLimitFeedbackTimer = null;
// 人设弹窗触发判据（change persona-bound-tristate）：**只由云端权威的「未绑」触发**。
//
// 旧实现按「!bound」触发，而 bound=false 同时承载了两个互斥的含义——「云端说没有」和「云端还没说」。
// 于是只能拿一个 6 秒宽限去猜，猜错就给已设置人设的账号弹向导。历史上修了三次（加宽限、bound 时清去重集、
// 移出环境时清 since），每次都只封住当时那条路径；只要再出现一条把信号归零的新路径（核心重启 / 冷待机
// 唤醒 / 环境移出再加回），就复发一次——而 `personaUnboundSince` 的两处清理还写在只有「未绑」才走得到的
// 分支里，等于死代码，宽限期在第二次之后根本不再生效，弹窗变成必然。
//
// 现在三态：true=已绑 / false=云端确认未绑 / null|undefined=未知。触发条件是 `=== false` —— 一个只有云端
// 能写入的值。「没收到信号」在类型上是未知，而未知永不满足触发条件。于是无论将来新增多少条重置路径，
// 它们最坏只能把状态打回「未知」，而不会打成「未绑」。宽限期机制随之整体删除：它是那个错误推断的载体。
let personaPopOpenReason = null; // manual | auto | bulk：只自动收起「系统误弹」的窗
let personaPopOpenEnvId = null;

// 底部操作栏按阶段/形态切换主 CTA：向导态 pick=「生成人设」、preview=「重新生成 + 确认使用」；
// 空态/已绑态收起全部按钮（空态面板自带「去启动」）。
function syncPersonaFoot(mode) {
  const wizard = mode === 'wizard';
  const growth = mode === 'growth';
  const inPick = personaStage === 'pick';
  // 更新流程复用同一套向导按钮，只改文案：让「这次是覆盖已有人设」在按钮上就看得见。
  if (personaUi.generate) personaUi.generate.textContent = personaBulkFillMode ? '生成人设' : personaUpdateMode ? '生成新草稿' : '生成人设';
  if (personaUi.confirm) personaUi.confirm.textContent = personaBulkFillMode ? '确认批量设置' : personaUpdateMode ? '确认更新' : '确认使用';
  personaUi.generate?.classList.toggle('hidden', !wizard || !inPick);
  personaUi.regenerate?.classList.toggle('hidden', !wizard || inPick);
  personaUi.confirm?.classList.toggle('hidden', !wizard || inPick);
  personaUi.growthStart?.classList.toggle('hidden', !growth);
}

function isPersonaGrowthActive() {
  const envId = currentEnvId() || '__local__';
  return Boolean(personaGrowthEnvId && personaGrowthEnvId === envId);
}

function playPersonaGrowthAnimation() {
  if (!personaUi.growth) return;
  personaUi.growth.classList.remove('play');
  // 强制重启一次性动画；只在展示成长引导时触发，不在日常 bound 状态循环。
  void personaUi.growth.offsetWidth;
  personaUi.growth.classList.add('play');
}

function showPersonaGrowth(envId) {
  personaGrowthEnvId = envId || currentEnvId() || '__local__';
  personaUi.growth?.classList.remove('hidden');
  personaUi.boundNote?.classList.add('hidden');
  syncPersonaFoot('growth');
  setPersonaMsg('', false);
  playPersonaGrowthAnimation();
}

function projectFirstPostStart(envId) {
  const key = envId || currentEnvId() || '__local__';
  const env = fleetView.envs.get(key);
  if (!env || !env.status) return;
  const dailyUsage = env.status.dailyUsage && typeof env.status.dailyUsage === 'object'
    ? env.status.dailyUsage
    : { asOf: Date.now(), totals: {} };
  env.status = {
    ...env.status,
    dailyUsage: {
      ...dailyUsage,
      firstPost: { state: 'searching', viewed: 0, target: 20, startedAt: Date.now() },
    },
  };
  if (fleetView.selected === key) render(env.status);
}

function clearPersonaGrowth() {
  personaGrowthEnvId = null;
  personaUi.growth?.classList.add('hidden');
  personaUi.growth?.classList.remove('play');
  personaUi.growthStart?.classList.add('hidden');
}

function setPersonaStage(stage) {
  personaStage = stage === 'preview' ? 'preview' : 'pick';
  personaUi.stagePick?.classList.toggle('hidden', personaStage !== 'pick');
  personaUi.stagePreview?.classList.toggle('hidden', personaStage !== 'preview');
  if (personaUi.steps) {
    personaUi.steps.querySelectorAll('.j-step').forEach((el) => {
      const s = el.dataset.stage;
      el.className = `j-step${s === personaStage ? ' cur' : s === 'pick' && personaStage === 'preview' ? ' done' : ''}`;
    });
  }
  const wizardVisible = personaUi.wizardBody && !personaUi.wizardBody.classList.contains('hidden');
  syncPersonaFoot(wizardVisible ? 'wizard' : 'hidden');
}

function updateKwSummary(keywords) {
  if (personaUi.kwSummaryText) personaUi.kwSummaryText.textContent = `偏好：${keywords.join(' · ')}`;
}
// 「改关键词」：回到第一步；草稿保留（回来还能确认）。
personaUi.kwSummary?.addEventListener('click', () => setPersonaStage('pick'));

// 空态动作：普通读取错误原地重试；只有 Cloud 明确说未建立绑定时，才显式打开浏览器完成首次登录。
personaUi.emptyAction?.addEventListener('click', () => {
  if (personaUi.emptyAction.dataset.personaAction === 'retry') {
    void loadPersonaView(personaPopOpenEnvId || currentEnvId());
    return;
  }
  closePersonaPop(true);
  void window.aidcpEdge.browserOpen?.(currentEnvId());
});

personaUi.growthStart?.addEventListener('click', () => {
  const action = fields.sessionFab && fields.sessionFab.dataset.action;
  clearPersonaGrowth();
  closePersonaPop(true);
  if (action === 'start' || action === 'resume') fields.sessionFab.click();
});

// 只清草稿本身（更新流程复用：进更新模式时要清掉上一次的草稿，但绝不能连「已绑」态一起清掉）。
function clearPersonaDraft() {
  personaDraftYaml = '';
  personaDraftSummary = null;
  personaDraftWritingLanguage = null;
  personaDraftEnvId = undefined;
  personaUi.draft?.classList.add('hidden');
  personaUi.skeleton?.classList.add('hidden');
  setPersonaStage('pick'); // 草稿已清，预览页无意义：切回第一步
}

// 切换环境时清空人设草稿（向导是每环境独立的）：绝不让 A 生成的草稿留在界面上被误确认到 B 的账号。
// 同时清本会话「已绑」态与更新模式（都是账号级、随环境切换失效，等新环境自己的权威信号）。
function resetPersonaDraft() {
  clearPersonaDraft();
  personaLocallyBound = false;
  personaUpdateMode = false;
  clearPersonaGrowth();
}

const PERSONA_GEN_FAIL = {
  generation_failed: '生成失败（模型未产出可用结果），请重试。',
  persona_invalid: '生成结果不合规，请重试。',
  input_too_large: '关键词太多或太长，请精简后重试。',
  no_keywords: '请先选择关键词。',
  missing_idempotency_key: '内部错误（缺幂等键），请重试。',
  edge_not_running: '旧版核心通道未运行；请升级客户端或重试 Cloud 直连。',
  edge_request_timeout: '生成超时，请重试。',
  edge_request_failed: '与云端通信失败，请检查连接后重试。',
  cloud_unreachable: '暂时连不上云端，请检查网络后重试。',
  request_failed: '云端未受理人设生成，请稍后重试。',
  invalid_request: '人设参数不合法，请重新选择后再试。',
  unavailable: '云端暂不支持人设生成，请稍后再试。',
  unknown_account: '账号身份未就绪，请确认已扫码登录。',
  writing_language_required: '请先选择发言语言。',
  writing_language_invalid: '发言语言无效，请重新选择。',
  writing_language_not_supported: '当前平台不支持发言语言设置。',
  tone_required: '请先选择语气调性。',
  content_preferences_required: '请至少选择一项内容偏好。',
  like_affinity_invalid: '点赞倾向无效，请重新选择。',
};
const PERSONA_PERSIST_FAIL = {
  unknown_account: '账号身份未就绪（云端未建号），请稍后重试。',
  persona_required: '人设为空，无法保存。',
  persona_invalid: '人设格式无效，请重新生成。',
  edge_request_failed: '与云端通信失败，请重试。',
  edge_request_timeout: '保存超时，请重试。',
  cloud_unreachable: '暂时连不上云端，请检查网络后重试。',
  request_failed: '云端未受理保存，请稍后重试。',
  persist_failed: '云端保存失败，现有人设未改变，请重试。',
  input_too_large: '人设内容过长，未保存。',
  invalid_request: '人设内容不合法，未保存。',
  unavailable: '云端暂不支持，请稍后再试。',
};

function setPersonaMsg(text, isError) {
  if (!personaUi.msg) return;
  personaUi.msg.textContent = text || '';
  personaUi.msg.classList.toggle('error', Boolean(isError));
}

function setPersonaBadge(text, variant) {
  if (!personaUi.stateBadge) return;
  personaUi.stateBadge.textContent = text;
  personaUi.stateBadge.className = `badge${variant ? ' ' + variant : ''}`;
}

function personaFailureText(reason) {
  const copy = {
    binding_unknown: ['首次启动并登录一次', '这个环境还没有建立云端账号绑定。首次登录成功后，即使以后停止引擎，也能在这里查看和修改人设。'],
    environment_not_owned: ['当前账号无权访问', '该环境不在当前登录客户的可见范围内。'],
    binding_conflict: ['账号绑定存在冲突', '该环境的账号归属需要管理员处理，当前不会读取或覆盖人设。'],
    binding_unavailable: ['账号绑定暂不可用', '云端暂时无法确认这个环境对应的账号，请稍后重试。'],
    unknown_account: ['账号尚未就绪', '云端还没有这个账号的有效记录，请稍后重试。'],
    persona_invalid: ['当前人设无法读取', '云端保存的人设格式异常，当前不会用模板或旧数据冒充。'],
    INTERACTION_AUTH_REQUIRED: ['登录状态已失效', '请重新登录客户端后再查看人设。'],
    cloud_unreachable: ['暂时连不上云端', '请检查网络后重试；这不要求启动环境引擎。'],
    persona_unavailable: ['人设服务暂不可用', '云端暂未提供人设管理能力，请稍后重试。'],
  };
  return copy[reason] || ['人设加载失败', '暂时无法读取云端人设，请稍后重试。'];
}

function renderCurrentPersona(persona) {
  const summary = persona && persona.summary && typeof persona.summary === 'object' ? persona.summary : {};
  if (personaUi.currentName) personaUi.currentName.textContent = summary.name || '已设置人设';
  if (personaUi.currentRole) personaUi.currentRole.textContent = summary.role || '后续浏览与发布会使用这份人设';
  if (personaUi.currentBackground) {
    personaUi.currentBackground.textContent = summary.background || '';
    personaUi.currentBackground.classList.toggle('hidden', !summary.background);
  }
  if (personaUi.currentTone) personaUi.currentTone.textContent = summary.tone || '—';
  if (personaUi.currentLanguage) {
    personaUi.currentLanguage.textContent = PERSONA_WRITING_LANGUAGES[summary.writingLanguage]?.label || '跟随平台';
  }
  if (personaUi.currentLike) personaUi.currentLike.textContent = PERSONA_LIKE_AFFINITIES[summary.likeAffinity]?.label || '正常';
  if (personaUi.currentTags) {
    personaUi.currentTags.replaceChildren();
    const tags = [...new Set([
      ...(Array.isArray(summary.primaryInterests) ? summary.primaryInterests : []),
      ...(Array.isArray(summary.secondaryInterests) ? summary.secondaryInterests : []),
      ...(Array.isArray(summary.seedKeywords) ? summary.seedKeywords : []),
    ])].slice(0, 10);
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.textContent = tag;
      personaUi.currentTags.appendChild(chip);
    }
  }
  if (personaUi.currentYaml) personaUi.currentYaml.textContent = persona?.soulYaml || '';
  if (personaUi.currentDetails) {
    personaUi.currentDetails.classList.toggle('hidden', !persona?.soulYaml);
    personaUi.currentDetails.open = false;
  }
}

function prefillPersonaFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return;
  const interests = new Set([
    ...(Array.isArray(summary.primaryInterests) ? summary.primaryInterests : []),
    ...(Array.isArray(summary.secondaryInterests) ? summary.secondaryInterests : []),
    ...(Array.isArray(summary.seedKeywords) ? summary.seedKeywords : []),
  ]);
  for (const group of personaUi.kwGroups) {
    const dim = group.dataset.dim;
    for (const button of group.querySelectorAll('.kw-btn')) {
      const active = dim === 'tone'
        ? button.dataset.kw === summary.tone
        : dim === 'like-affinity'
          ? button.dataset.likeAffinity === (summary.likeAffinity || 'normal')
          : dim === 'content' && interests.has(button.dataset.kw);
      button.classList.toggle('active', active);
    }
    syncKwGroupState(group);
  }
  const envId = currentEnvId() || '__local__';
  if (PERSONA_WRITING_LANGUAGES[summary.writingLanguage]) {
    personaWritingLanguageSelections.set(envId, summary.writingLanguage);
    personaWritingLanguageDirty.add(envId);
  } else {
    personaWritingLanguageSelections.delete(envId);
    personaWritingLanguageDirty.delete(envId);
  }
  syncPersonaWritingLanguage((fleetView.envs.get(currentEnvId()) || {}).status || currentStatus || null);
}

async function loadPersonaView(envId) {
  const targetEnvId = envId || currentEnvId();
  if (!targetEnvId || !window.aidcpEdge || typeof window.aidcpEdge.personaGet !== 'function') {
    if (targetEnvId) personaViewsByEnv.set(targetEnvId, { phase: 'error', reason: 'persona_unavailable' });
    updatePersonaGate((fleetView.envs.get(targetEnvId) || {}).status || currentStatus || null);
    return;
  }
  const requestId = ++personaViewRequestId;
  personaViewsByEnv.set(targetEnvId, { requestId, phase: 'loading' });
  if (personaPopOpenEnvId === targetEnvId) {
    updatePersonaGate((fleetView.envs.get(targetEnvId) || {}).status || null);
  }
  let result;
  try {
    result = await window.aidcpEdge.personaGet(targetEnvId);
  } catch (error) {
    result = { ok: false, reason: 'cloud_unreachable', message: String((error && error.message) || error || '') };
  }
  const pending = personaViewsByEnv.get(targetEnvId);
  if (!pending || pending.requestId !== requestId) return;
  if (result && result.ok && (result.state === 'missing' || result.state === 'configured')) {
    personaViewsByEnv.set(targetEnvId, {
      requestId,
      phase: 'loaded',
      state: result.state,
      persona: result.persona || null,
    });
  } else {
    personaViewsByEnv.set(targetEnvId, {
      requestId,
      phase: 'error',
      reason: (result && result.reason) || 'request_failed',
      message: result && result.message,
    });
  }
  // A 的晚返回只更新 A 的缓存；弹窗已切到 B 或已关闭时绝不投影到当前画面。
  if (fields.personaPop?.classList.contains('open') && personaPopOpenEnvId === targetEnvId) {
    updatePersonaGate((fleetView.envs.get(targetEnvId) || {}).status || null);
  }
}

function renderCloudPersonaGate(status, view) {
  const targetEnvId = personaPopOpenEnvId || currentEnvId() || '__local__';
  personaUi.growth?.classList.add('hidden');
  personaUi.emptyAction?.classList.add('hidden');
  if (personaUi.emptyAction) personaUi.emptyAction.dataset.personaAction = '';

  if (view.phase === 'loading') {
    personaReady = false;
    personaUi.boundNote?.classList.add('hidden');
    personaUi.wizardBody?.classList.add('hidden');
    personaUi.empty?.classList.remove('hidden');
    if (personaUi.emptyTitle) personaUi.emptyTitle.textContent = '正在读取云端人设…';
    if (personaUi.emptySub) personaUi.emptySub.textContent = '无需启动环境，请稍候。';
    setPersonaBadge('读取中', 'checking');
    syncPersonaFoot('hidden');
    return;
  }

  if (view.phase === 'error') {
    personaReady = false;
    personaUi.boundNote?.classList.add('hidden');
    personaUi.wizardBody?.classList.add('hidden');
    personaUi.empty?.classList.remove('hidden');
    const [title, detail] = personaFailureText(view.reason);
    if (personaUi.emptyTitle) personaUi.emptyTitle.textContent = title;
    if (personaUi.emptySub) personaUi.emptySub.textContent = view.message || detail;
    if (personaUi.emptyAction) {
      personaUi.emptyAction.classList.remove('hidden');
      personaUi.emptyAction.dataset.personaAction = view.reason === 'binding_unknown' ? 'browser' : 'retry';
      personaUi.emptyAction.textContent = view.reason === 'binding_unknown' ? '打开浏览器完成首次登录' : '重试';
    }
    setPersonaBadge(view.reason === 'binding_unknown' ? '待绑定' : '暂不可用', 'checking');
    syncPersonaFoot('hidden');
    return;
  }

  personaReady = true;
  personaUi.empty?.classList.add('hidden');
  if (view.state === 'configured') {
    const updating = personaUpdateMode;
    const growthActive = !updating && isPersonaGrowthActive();
    renderCurrentPersona(view.persona);
    personaUi.boundNote?.classList.toggle('hidden', growthActive);
    personaUi.growth?.classList.toggle('hidden', !growthActive);
    personaUi.wizardBody?.classList.toggle('hidden', !updating);
    setPersonaBadge(updating ? '待更新' : '已设置', updating ? 'warning' : 'normal');
    clearPersonaPromptForCurrentEnv();
    if (personaUi.hint && updating) {
      personaUi.hint.textContent = '重新选择偏好并生成新草稿，确认后覆盖当前账号的人设；保存失败不会影响上方现有人设。';
    }
    syncPersonaFoot(growthActive ? 'growth' : updating ? 'wizard' : 'hidden');
    if (personaUi.generate) personaUi.generate.disabled = personaInFlight;
    const persistSettling = personaPersistPendingEnvId === targetEnvId;
    if (personaPopOpenReason === 'auto' && !persistSettling && !growthActive) closePersonaPop(true);
    return;
  }

  personaLocallyBound = false;
  personaUi.boundNote?.classList.add('hidden');
  personaUi.wizardBody?.classList.remove('hidden');
  // 未绑 + 规则模式已开启 → 徽标说「按规则运行」、正文说清它为何不需要人设；向导仍留着（运营想补也能补），
  // 但绝不再用「确认后账号才会开始自动运营」这种把它说成没跑起来的文案。
  // 走到这里的前提就是云端权威读回了「没有人设」（读不到会走上面的 error 分支），所以此处按确认未绑判定，
  // 不再等状态心跳里的 personaBound——两者同源，等它只会让这一屏先误说一次「未设置」。
  const ruleModeUnbound = personaRuleModeWithoutPersona(
    fleetView.envs.get(targetEnvId),
    { ...(status && typeof status === 'object' ? status : {}), personaBound: false },
  );
  setPersonaBadge(
    personaDraftYaml ? '待确认' : ruleModeUnbound ? uiLogic.RULE_MODE_WITHOUT_PERSONA_BADGE : '未设置',
    personaDraftYaml ? 'warning' : 'checking',
  );
  if (personaUi.generate) personaUi.generate.disabled = personaInFlight;
  if (personaUi.hint) {
    const preferences = selectedEnvPlatform() === 'facebook'
      ? '发言语言、语气、点赞倾向和内容偏好'
      : '语气、点赞倾向和内容偏好';
    personaUi.hint.textContent = ruleModeUnbound
      ? uiLogic.RULE_MODE_WITHOUT_PERSONA_NOTE
      : `设置${preferences}，自动生成这个账号的人设；确认后账号才会开始自动运营。`;
  }
  syncPersonaFoot('wizard');
  if (status?.personaBound === false) maybePromptPersonaSetup(status);
}

function personaPromptKey(status) {
  const envId = currentEnvId() || '__local__';
  const accountId = status && status.account && status.account.id ? status.account.id : envId;
  return `${envId}:${accountId}`;
}

function clearPersonaPromptForCurrentEnv() {
  const prefix = `${currentEnvId() || '__local__'}:`;
  for (const key of [...personaPrompted]) {
    if (key.startsWith(prefix)) personaPrompted.delete(key);
  }
}

// 只在云端权威地说「这个账号没有人设」时才弹。调用方已保证 status.personaBound === false。
function maybePromptPersonaSetup(status) {
  const promptEnv = fleetView.envs.get(currentEnvId());
  if (!personaAppliesToEnvironment(promptEnv)) return;
  // 规则模式免人设（change facebook-rule-mode-without-persona）：这个账号没有人设、但正按规则运行 →
  // 既不弹向导也不发补人设通知。补一份规则模式根本不读的人设是纯空转，通知本身也会误导成「它没跑起来」。
  if (personaRuleModeWithoutPersona(promptEnv, status)) return;
  // 规则模式事实还没读回来：先按住这一次判定（不记入已提醒集），等真态到达再由续跳点重评。
  if (facebookRuleModePendingForPersona(promptEnv)) return;
  const key = personaPromptKey(status);
  if (personaPrompted.has(key)) return;
  personaPrompted.add(key);
  const envId = currentEnvId();
  const env = fleetView.envs.get(envId);
  const label = resolveEnvironmentDisplayName(env, status).name || '当前账号';
  try {
    const notifyResult = window.aidcpEdge.notify?.({
      title: '需要设置账号人设',
      body: `${label} 已登录但还没有人设，设置后才会开始自动运营。`,
    });
    if (notifyResult && typeof notifyResult.catch === 'function') notifyResult.catch(() => undefined);
  } catch {
    /* old preload without notify */
  }
  if (!fields.personaPop || !fields.personaPop.classList.contains('open')) openPersonaPop(envId, 'auto');
}

function collectPersonaKeywords() {
  const out = [];
  for (const group of personaUi.kwGroups) {
    const selected = Array.from(group.querySelectorAll('.kw-btn.active'))
      .map((b) => b.dataset.kw)
      .filter(Boolean);
    if (!selected.length) continue;
    if (group.dataset.dim === 'content' && group.dataset.category) out.push(group.dataset.category);
    out.push(...selected);
  }
  return [...new Set(out)];
}

function collectFacebookPersonaTemplateSelection() {
  const tone = personaUi.kwGroups
    .find((group) => group.dataset.dim === 'tone')
    ?.querySelector('.kw-btn.active')?.dataset.kw || '';
  const contentGroups = personaUi.kwGroups.filter((group) => group.dataset.dim === 'content');
  const contentPreferences = [...new Set(contentGroups.flatMap((group) =>
    Array.from(group.querySelectorAll('.kw-btn.active')).map((button) => button.dataset.kw).filter(Boolean)))];
  const contentCategories = [...new Set(contentGroups
    .filter((group) => group.querySelector('.kw-btn.active'))
    .map((group) => group.dataset.category)
    .filter(Boolean))];
  return {
    tone,
    writingLanguage: collectPersonaWritingLanguage(),
    likeAffinity: collectPersonaLikeAffinity().key,
    contentPreferences,
    contentCategories,
  };
}

const PERSONA_LIKE_AFFINITIES = {
  normal: { key: 'normal', label: '正常', token: 'like_affinity:normal' },
  like_more: { key: 'like_more', label: '喜欢', token: 'like_affinity:like_more' },
  like_most: { key: 'like_most', label: '更喜欢', token: 'like_affinity:like_most' },
};

const PERSONA_WRITING_LANGUAGES = {
  'zh-CN': { label: '中文' },
  en: { label: '英文' },
  vi: { label: '越南语' },
};

function syncPersonaWritingLanguage(status) {
  const facebook = personaBulkFillMode || selectedEnvPlatform() === 'facebook';
  personaUi.languageCard?.classList.toggle('hidden', !facebook);
  if (!facebook || !personaUi.languageGroup) return;

  const envId = personaWritingLanguageKey();
  const authoritative = status && status.personaWritingLanguage;
  if (!personaBulkFillMode && !personaWritingLanguageDirty.has(envId)) {
    if (PERSONA_WRITING_LANGUAGES[authoritative]) personaWritingLanguageSelections.set(envId, authoritative);
    else personaWritingLanguageSelections.delete(envId);
  }
  const selected = personaWritingLanguageSelections.get(envId) || null;
  personaUi.languageGroup.querySelectorAll('.kw-btn').forEach((button) => {
    const active = button.dataset.writingLanguage === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (personaUi.languageHelp) {
    personaUi.languageHelp.textContent = personaBulkFillMode
      ? '这项语言会写入同一份人设，并用于所有本次补齐的 Facebook 账号。'
      : status?.personaBound === true && status.personaWritingLanguage === null && !selected
      ? '当前人设尚未设置发言语言；更新人设时请选择，之后的 Facebook 帖子和评论将使用该语言。'
      : '用于这个 Facebook 账号后续生成的帖子和评论，不改变 Facebook 界面语言。';
  }
}

function personaWritingLanguageKey() {
  return personaBulkFillMode ? '__facebook_bulk__' : currentEnvId() || '__local__';
}

function collectPersonaWritingLanguage() {
  return personaWritingLanguageSelections.get(personaWritingLanguageKey()) || null;
}

function collectPersonaLikeAffinity() {
  const selected = personaUi.likeAffinityGroup?.querySelector('.kw-btn.active');
  const key = selected?.dataset.likeAffinity;
  return PERSONA_LIKE_AFFINITIES[key] || PERSONA_LIKE_AFFINITIES.normal;
}

function newIdempotencyKey() {
  return `persona-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// 已绑账号手动进入更新流程：保持「已绑」为真（生成失败也绝不把账号显示成未设置），只是把向导重新打开。
function beginPersonaUpdate() {
  personaUpdateMode = true;
  personaLocallyBound = true; // 更新期间本地锚住已绑：状态推送不得把向导藏回去，也不得触发未设置提醒
  clearPersonaDraft();
  const currentView = personaViewsByEnv.get(currentEnvId() || '__local__');
  prefillPersonaFromSummary(currentView?.state === 'configured' ? currentView.persona?.summary : null);
  const env = fleetView.envs.get(currentEnvId());
  updatePersonaGate((env && env.status) || currentStatus || null);
  setPersonaMsg('重新选择偏好并生成新草稿；确认后会覆盖当前人设。', false);
}
personaUi.update?.addEventListener('click', beginPersonaUpdate);

// onboarding 三态：客户会话 ready 后直接按 HTTP/花名册权威绑定态工作，不依赖自动化引擎或浏览器。
// 只改 disabled/显隐/面板文案，绝不触碰已选关键词与草稿（状态推送不重置向导进度）。
function updatePersonaGate(status) {
  syncPersonaWritingLanguage(status);
  if (personaBulkFillMode) {
    personaReady = true;
    personaUi.growth?.classList.add('hidden');
    personaUi.boundNote?.classList.add('hidden');
    personaUi.empty?.classList.add('hidden');
    personaUi.wizardBody?.classList.remove('hidden');
    setPersonaBadge(personaDraftYaml ? '待确认' : '选择人设', personaDraftYaml ? 'warning' : 'checking');
    if (personaUi.hint) {
      personaUi.hint.textContent = '选择发言语言、语气、点赞倾向和内容偏好；确认后，云端只把这一份完全相同的人设添加给尚未设置的 Facebook 账号。';
    }
    if (personaUi.generate) personaUi.generate.disabled = personaInFlight;
    syncPersonaFoot('wizard');
    return;
  }
  const openView = fields.personaPop?.classList.contains('open') && personaPopOpenEnvId
    ? personaViewsByEnv.get(personaPopOpenEnvId)
    : null;
  if (openView) {
    // 兼容正在运行的旧 core 信号：自动向导若刚读到 missing、随后 WS 明确上报已设置，立即复读一次
    // customer-auth 真态；最终仍以环境接口的结果决定是否收起，不直接拿状态心跳覆盖摘要。
    if (personaPopOpenReason === 'auto' && openView.phase === 'loaded'
        && openView.state === 'missing' && status?.personaBound === true) {
      void loadPersonaView(personaPopOpenEnvId);
      return;
    }
    renderCloudPersonaGate(status, openView);
    return;
  }
  const sessionReady = Boolean(status && status.clientSessionState === 'ready');
  const loggedIn = sessionReady;
  const browserOpen = Boolean(status && (status.browserState === 'ready'
    || (!status.browserState && status.edge === 'running' && !status.browserStandby)));
  personaReady = sessionReady;

  // 绑定态三态（change persona-bound-tristate）：true=云端确认已绑 / false=云端确认未绑 / 未知=还没收到。
  // known 只要求客户会话可用且权威绑定信号已到；自动化引擎连接不参与数据管理闸。
  const authoritative = personaReady && typeof (status && status.personaBound) === 'boolean';
  const bound = (authoritative && status.personaBound === true) || (personaReady && personaLocallyBound);
  // 「云端确认未绑」是弹窗与「未设置」徽标的**唯一**依据；未知既不弹窗、也不谎称未设置。
  const knownUnbound = authoritative && status.personaBound === false && !personaLocallyBound;
  const known = bound || knownUnbound;
  // 已绑账号手动点「更新人设」：保持已绑为真（生成失败也绝不显示成未设置），但把向导重新打开。
  const updatingBound = bound && personaUpdateMode;
  const growthActive = bound && !updatingBound && isPersonaGrowthActive();
  const popEnvId = personaPopOpenEnvId || currentEnvId() || '__local__';
  const persistSettling = Boolean(personaPersistPendingEnvId && personaPersistPendingEnvId === popEnvId);

  // 五形态显隐一处收口：刚绑=成长引导 / 已绑=绿卡 / 已绑且更新中=向导 / 未就绪=空态面板 / 已连且确认未绑=向导。
  if (personaUi.growth) personaUi.growth.classList.toggle('hidden', !growthActive);
  if (personaUi.boundNote) personaUi.boundNote.classList.toggle('hidden', !bound || growthActive || updatingBound);
  if (personaUi.wizardBody) personaUi.wizardBody.classList.toggle('hidden', (bound && !updatingBound) || !known);
  if (personaUi.empty) personaUi.empty.classList.toggle('hidden', bound || known);

  // ① 已绑人设：默认显示「已设置」并收起向导；手动进入更新时保留已绑态但打开向导，确认后覆盖当前人设。
  if (bound) {
    setPersonaBadge(updatingBound ? '待更新' : '已设置', updatingBound ? 'warning' : 'normal');
    clearPersonaPromptForCurrentEnv();
    // 纵深防御：万一还有别的路径把窗自动弹了出来，权威「已绑」一到就把它收起来（只收系统自动弹的，
    // 用户手动打开查看/更新的绝不替他关掉）。
    if (
      fields.personaPop
      && fields.personaPop.classList.contains('open')
      && personaPopOpenReason === 'auto'
      && !persistSettling
      && !growthActive
      && (!personaPopOpenEnvId || personaPopOpenEnvId === (currentEnvId() || '__local__'))
    ) {
      closePersonaPop(true);
    }
    if (!updatingBound) {
      syncPersonaFoot(growthActive ? 'growth' : 'hidden');
      return;
    }
    // 更新中：继续往下走到向导分支（③），但绝不改徽标、绝不弹提醒。
  }
  // 未绑或未知：徽标区分——云端权威说未绑=「未设置」；信号未到=「待启动」（宁缺毋假，不谎称未设置）。
  // 第四种（change facebook-rule-mode-without-persona）：确认未绑 + 该环境规则模式已开启=「按规则运行」，
  // 它既不是待补人设，也不是已绑。规则模式真态未读到时按未启用处理，逐字回到既有三态。
  // 本会话刚生成的「待确认」草稿态不被状态推送覆盖。
  const ruleModeUnbound = knownUnbound
    && personaRuleModeWithoutPersona(fleetView.envs.get(currentEnvId()), status);
  if (!bound && personaUi.stateBadge && personaUi.stateBadge.textContent !== '待确认') {
    setPersonaBadge(
      ruleModeUnbound ? uiLogic.RULE_MODE_WITHOUT_PERSONA_BADGE : knownUnbound ? '未设置' : '待绑定',
      'checking',
    );
  }

  // ② 闸未就绪（未登录 / 未连云 / 权威信号还没到）：空态面板，绝不弹窗。
  if (!known) {
    if (personaUi.emptyTitle) personaUi.emptyTitle.textContent = loggedIn ? '正在读取云端账号绑定…' : '需要完成一次浏览器登录';
    if (personaUi.emptySub) {
      personaUi.emptySub.textContent = loggedIn
        ? '账号绑定读取完成后会显示人设状态；不要求启动自动化或持续打开浏览器。'
        : browserOpen
          ? '请在已打开的浏览器窗口完成登录；绑定落云后可关闭浏览器继续管理人设。'
          : '请显式打开浏览器完成首次登录；绑定落云后无需保持浏览器运行。';
    }
    if (personaUi.emptyAction) {
      personaUi.emptyAction.classList.toggle('hidden', loggedIn); // 连云中无需动作
      personaUi.emptyAction.textContent = '打开浏览器完成登录';
    }
    syncPersonaFoot('hidden');
    return;
  }

  // ③ 云端权威确认未绑（或已绑但手动进入更新）：向导可用；确认时复用同一条 persist 路径覆盖。
  if (personaUi.generate) personaUi.generate.disabled = personaInFlight || !personaReady;
  if (personaUi.hint) {
    const preferences = selectedEnvPlatform() === 'facebook'
      ? '发言语言、语气、点赞倾向和内容偏好'
      : '语气、点赞倾向和内容偏好';
    personaUi.hint.textContent = updatingBound
      ? `重新选择${preferences}并生成新草稿，确认后会覆盖当前账号的人设；生成失败不会影响现有人设。`
      : ruleModeUnbound
        ? uiLogic.RULE_MODE_WITHOUT_PERSONA_NOTE
        : `设置${preferences}，自动生成这个账号的人设；确认后账号才会开始自动运营。`;
  }
  syncPersonaFoot('wizard');
  // 自动弹窗只对「云端权威说未绑」的账号；已绑账号手动进入更新时绝不再弹、也绝不发未设置通知。
  if (!bound) maybePromptPersonaSetup(status);
}

function personaContentPreferenceCount() {
  return personaUi.kwGroups
    .filter((group) => group.dataset.dim === 'content')
    .reduce((sum, group) => sum + group.querySelectorAll('.kw-btn.active').length, 0);
}

function clearPersonaContentLimitFeedback() {
  if (personaContentLimitFeedbackTimer) {
    clearTimeout(personaContentLimitFeedbackTimer);
    personaContentLimitFeedbackTimer = null;
  }
  personaUi.contentGroups?.querySelectorAll('.limit-rejected').forEach((element) => element.classList.remove('limit-rejected'));
  personaUi.contentGroups?.querySelectorAll('[aria-invalid="true"]').forEach((element) => element.removeAttribute('aria-invalid'));
  if (personaUi.contentLimitMsg) {
    personaUi.contentLimitMsg.textContent = '';
    personaUi.contentLimitMsg.classList.remove('active');
  }
}

function showPersonaContentLimitFeedback(control, row) {
  if (personaContentLimitFeedbackTimer) clearTimeout(personaContentLimitFeedbackTimer);
  personaUi.contentGroups?.querySelectorAll('.limit-rejected').forEach((element) => element.classList.remove('limit-rejected'));
  personaUi.contentGroups?.querySelectorAll('[aria-invalid="true"]').forEach((element) => element.removeAttribute('aria-invalid'));
  for (const element of [control, row].filter(Boolean)) {
    element.classList.add('limit-rejected');
    element.setAttribute('aria-invalid', 'true');
  }
  if (personaUi.contentLimitMsg) {
    personaUi.contentLimitMsg.textContent = PERSONA_CONTENT_LIMIT_MESSAGE;
    personaUi.contentLimitMsg.classList.add('active');
  }
  personaContentLimitFeedbackTimer = setTimeout(() => {
    for (const element of [control, row].filter(Boolean)) {
      element.classList.remove('limit-rejected');
      element.removeAttribute('aria-invalid');
    }
    personaContentLimitFeedbackTimer = null;
  }, 1200);
}

// 关键词 toggle：单选组互斥；内容偏好最多 24 个，第 25 次点击原位拒绝且不污染选择集。
function syncKwGroupState(group) {
  group.querySelectorAll('.kw-btn').forEach((b) => b.setAttribute('aria-pressed', b.classList.contains('active') ? 'true' : 'false'));
  if (personaUi.contentCount) {
    const n = personaContentPreferenceCount();
    personaUi.contentCount.textContent = `已选 ${n}/${PERSONA_CONTENT_PREFERENCE_LIMIT}`;
    personaUi.contentCount.classList.toggle('at-limit', n >= PERSONA_CONTENT_PREFERENCE_LIMIT);
  }
}
personaUi.kwGroups.forEach((group) => {
  const single = group.dataset.select === 'single';
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.kw-btn');
    if (!btn || !group.contains(btn)) return;
    if (single) {
      group.querySelectorAll('.kw-btn').forEach((b) => b.classList.toggle('active', b === btn));
    } else if (btn.classList.contains('active')) {
      btn.classList.remove('active');
      clearPersonaContentLimitFeedback();
    } else if (personaContentPreferenceCount() >= PERSONA_CONTENT_PREFERENCE_LIMIT) {
      showPersonaContentLimitFeedback(btn);
      syncKwGroupState(group);
      return;
    } else {
      btn.classList.add('active');
      clearPersonaContentLimitFeedback();
    }
    syncKwGroupState(group);
  });
  syncKwGroupState(group);
});

personaUi.languageGroup?.addEventListener('click', (event) => {
  const button = event.target.closest('.kw-btn');
  if (!button || !personaUi.languageGroup.contains(button)) return;
  const writingLanguage = button.dataset.writingLanguage;
  if (!PERSONA_WRITING_LANGUAGES[writingLanguage]) return;
  const envId = personaWritingLanguageKey();
  personaWritingLanguageSelections.set(envId, writingLanguage);
  personaWritingLanguageDirty.add(envId);
  syncPersonaWritingLanguage((fleetView.envs.get(currentEnvId()) || {}).status || currentStatus || null);
});

function addCustomPreference(group, value, row, input) {
  const name = (value || '').trim();
  if (!name) return { ok: false, reason: 'empty' };
  const normalized = name.slice(0, 40);
  const existing = Array.from(group.querySelectorAll('.kw-btn')).find((b) => b.dataset.kw === normalized);
  if (existing) {
    if (!existing.classList.contains('active') && personaContentPreferenceCount() >= PERSONA_CONTENT_PREFERENCE_LIMIT) {
      showPersonaContentLimitFeedback(existing, row);
      input?.focus();
      return { ok: false, reason: 'limit' };
    }
    existing.classList.add('active');
    clearPersonaContentLimitFeedback();
    syncKwGroupState(group);
    return { ok: true };
  }
  if (personaContentPreferenceCount() >= PERSONA_CONTENT_PREFERENCE_LIMIT) {
    showPersonaContentLimitFeedback(input, row);
    input?.focus();
    return { ok: false, reason: 'limit' };
  }
  const btn = document.createElement('button');
  btn.className = 'kw-btn active custom';
  btn.type = 'button';
  btn.dataset.kw = normalized;
  btn.textContent = normalized;
  // 插到「+」加号之前，让加号始终排在最后一格。
  const addBtn = group.querySelector('.persona-add-custom');
  if (addBtn) group.insertBefore(btn, addBtn);
  else group.appendChild(btn);
  clearPersonaContentLimitFeedback();
  syncKwGroupState(group);
  return { ok: true };
}

document.querySelectorAll('.persona-pref-group').forEach((section) => {
  const add = section.querySelector('.persona-add-custom');
  const row = section.querySelector('.persona-custom-row');
  const input = section.querySelector('.persona-custom-input');
  const confirm = section.querySelector('.persona-custom-add');
  const group = section.querySelector('.persona-kw-group');
  add?.addEventListener('click', () => {
    row?.classList.toggle('hidden');
    const open = Boolean(row && !row.classList.contains('hidden'));
    add.setAttribute('aria-expanded', String(open));
    if (open) input?.focus();
  });
  const submit = () => {
    if (!group || !input) return;
    const result = addCustomPreference(group, input.value, row, input);
    if (!result.ok && result.reason === 'limit') return;
    input.value = '';
    row?.classList.add('hidden');
    // 收起输入框时把焦点交还加号（否则焦点落到 body、键盘用户丢失位置）。
    add?.setAttribute('aria-expanded', 'false');
    add?.focus();
  };
  confirm?.addEventListener('click', submit);
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
});

async function runPersonaGenerate() {
  if (!personaReady) return setPersonaMsg('云端人设暂未就绪，请重试读取。', true);
  const bulk = personaBulkFillMode;
  const keywordSelections = collectPersonaKeywords();
  if (!keywordSelections.length) return setPersonaMsg('请先选择关键词', true);
  const facebook = bulk || selectedEnvPlatform() === 'facebook';
  const writingLanguage = facebook ? collectPersonaWritingLanguage() : null;
  if (facebook && !writingLanguage) return setPersonaMsg('请先选择发言语言', true);
  const likeAffinity = collectPersonaLikeAffinity();
  const requestSelections = [...keywordSelections, likeAffinity.token];
  if (!window.aidcpEdge || (bulk
    ? typeof window.aidcpEdge.facebookPersonaTemplatePreview !== 'function'
    : typeof window.aidcpEdge.personaGenerate !== 'function')) return;
  personaInFlight = true;
  // 预先切到预览页：让「结果会出现在哪」提前可见，生成中该处呈现骨架。
  updateKwSummary([
    ...keywordSelections,
    ...(facebook ? [`发言语言：${PERSONA_WRITING_LANGUAGES[writingLanguage].label}`] : []),
    `点赞倾向：${likeAffinity.label}`,
  ]);
  setPersonaStage('preview');
  personaUi.skeleton?.classList.remove('hidden');
  personaUi.draft?.classList.add('hidden');
  personaUi.generate.disabled = true;
  if (personaUi.regenerate) { personaUi.regenerate.disabled = true; personaUi.regenerate.textContent = '正在生成…'; }
  if (personaUi.confirm) personaUi.confirm.disabled = true;
  setPersonaMsg(bulk ? '正在根据你的选择生成人设预览…' : personaUpdateMode ? '正在生成新人设…（可能需要十几秒）' : '正在生成人设…（可能需要十几秒）', false);
  const genEnvId = bulk ? '__facebook_bulk__' : currentEnvId(); // 单账号草稿仍锁定目标环境；批量模板不绑定账号
  try {
    let r;
    if (bulk) {
      r = await window.aidcpEdge.facebookPersonaTemplatePreview(collectFacebookPersonaTemplateSelection());
    } else {
      const request = { keywordSelections: requestSelections, idempotencyKey: newIdempotencyKey() };
      if (facebook) request.writingLanguage = writingLanguage;
      r = await window.aidcpEdge.personaGenerate(genEnvId, request);
    }
    if (r && r.ok && r.soulYaml) {
      personaDraftYaml = r.soulYaml;
      personaDraftSummary = r.summary || null;
      personaDraftWritingLanguage = writingLanguage;
      personaDraftEnvId = genEnvId;
      // 信息层级：identitySummary（给人看的人设）升为标题；原始 YAML 收进折叠。
      if (personaUi.draftSummary) personaUi.draftSummary.textContent = r.identitySummary || '已生成人设';
      if (personaUi.draftBody) personaUi.draftBody.textContent = r.soulYaml;
      personaUi.draft?.classList.remove('hidden');
      setPersonaBadge('待确认', 'warning');
      setPersonaMsg(
        bulk
          ? '已生成一份批量人设；确认后，尚未设置的 Facebook 账号都会使用这份完全相同的人设。'
          : personaUpdateMode
          ? '已生成新草稿，确认后会覆盖当前人设；不满意可「重新生成」。'
          : '已生成草稿，确认后即绑定；不满意可「重新生成」。',
        false,
      );
    } else {
      personaDraftYaml = '';
      personaDraftSummary = null;
      personaDraftWritingLanguage = null;
      personaUi.draft?.classList.add('hidden');
      setPersonaStage('pick'); // 失败诚实回到选关键词，错误在底栏警示条如实展示
      setPersonaMsg(PERSONA_GEN_FAIL[(r && r.reason) || ''] || `生成失败：${(r && r.reason) || '未知'}`, true);
    }
  } finally {
    personaInFlight = false;
    personaUi.skeleton?.classList.add('hidden');
    personaUi.generate.disabled = !personaReady;
    if (personaUi.regenerate) { personaUi.regenerate.disabled = false; personaUi.regenerate.textContent = '重新生成'; }
    if (personaUi.confirm) personaUi.confirm.disabled = false;
  }
}

personaUi.generate?.addEventListener('click', runPersonaGenerate);
personaUi.regenerate?.addEventListener('click', runPersonaGenerate);

personaUi.confirm?.addEventListener('click', async () => {
  if (!personaDraftYaml) return;
  if (personaBulkFillMode) {
    if (!window.aidcpEdge || typeof window.aidcpEdge.facebookPersonaFillSelected !== 'function') return;
    personaUi.confirm.disabled = true;
    setPersonaMsg('正在提交所选人设…', false);
    try {
      const result = await window.aidcpEdge.facebookPersonaFillSelected(personaDraftYaml);
      if (result && result.ok && result.accepted) {
        setPersonaBadge('已安排', 'normal');
        personaUi.wizardBody?.classList.add('hidden');
        syncPersonaFoot('hidden');
        setPersonaMsg('云端已受理：只筛选尚未设置的人设账号，并使用你刚确认的同一份人设。', false);
        if (fields.railFacebookPersonaStatus) fields.railFacebookPersonaStatus.textContent = '所选人设已交由云端补齐未设置账号。';
        personaDraftYaml = '';
        personaDraftWritingLanguage = null;
        closePersonaPop(true);
      } else {
        setPersonaMsg((result && result.message) || '提交失败，请稍后重试。', true);
      }
    } catch (error) {
      setPersonaMsg(`提交失败：${(error && error.message) || error || '请稍后重试'}`, true);
    } finally {
      personaUi.confirm.disabled = false;
    }
    return;
  }
  if (!window.aidcpEdge || typeof window.aidcpEdge.personaPersist !== 'function') return;
  const wasUpdate = personaUpdateMode;
  const persistEnvId = personaDraftEnvId || currentEnvId() || '__local__';
  const persistedYaml = personaDraftYaml;
  const persistedSummary = personaDraftSummary;
  personaPersistPendingEnvId = persistEnvId;
  personaUi.confirm.disabled = true;
  setPersonaMsg(wasUpdate ? '正在更新人设…' : '正在保存人设…', false);
  try {
    // 打回草稿所属环境（personaDraftEnvId），不是「当前选中环境」——防中途切换环境把 A 的人设写进 B 的账号。
    const r = await window.aidcpEdge.personaPersist(personaDraftEnvId, { soulYaml: personaDraftYaml });
    if (r && r.ok) {
      // 确认成功即本地视为已绑（personaBound 信号要等下次 hello 才到）：立即折叠向导为「已设置」态。
      personaLocallyBound = true;
      personaUpdateMode = false;
      setPersonaBadge('已设置', 'normal');
      const growthEnvId = personaDraftEnvId || currentEnvId() || '__local__';
      if (personaDraftWritingLanguage) {
        personaWritingLanguageSelections.set(growthEnvId, personaDraftWritingLanguage);
        personaWritingLanguageDirty.delete(growthEnvId);
        const targetEnv = fleetView.envs.get(growthEnvId);
        if (targetEnv?.status) targetEnv.status.personaWritingLanguage = personaDraftWritingLanguage;
      }
      personaDraftYaml = '';
      personaDraftSummary = null;
      personaDraftWritingLanguage = null;
      personaUi.draft?.classList.add('hidden');
      personaUi.wizardBody?.classList.add('hidden');
      const savedPersona = r.persona || {
        soulYaml: persistedYaml,
        summary: persistedSummary || {},
        updatedAt: null,
      };
      personaViewsByEnv.set(persistEnvId, {
        requestId: ++personaViewRequestId,
        phase: 'loaded',
        state: 'configured',
        persona: savedPersona,
      });
      if (wasUpdate || r.firstPostOnboarding !== true) {
        // 更新既有人设：这个号本来就在跑，不该再出「开始运营」的成长引导——收回已设置绿卡即可。
        updatePersonaGate((fleetView.envs.get(persistEnvId) || {}).status || currentStatus || null);
        setPersonaMsg(wasUpdate ? '人设已更新，后续浏览 / 发布会使用新人设。' : '人设已保存，后续浏览 / 发布会使用这份人设。', false);
        if (
          personaPopOpenReason === 'auto'
          && (!personaPopOpenEnvId || personaPopOpenEnvId === persistEnvId)
        ) closePersonaPop(true);
      } else {
        projectFirstPostStart(growthEnvId);
        showPersonaGrowth(growthEnvId);
      }
    } else {
      setPersonaMsg(PERSONA_PERSIST_FAIL[(r && r.reason) || ''] || `保存失败：${(r && r.reason) || '未知'}`, true);
    }
  } finally {
    if (personaPersistPendingEnvId === persistEnvId) personaPersistPendingEnvId = null;
    personaUi.confirm.disabled = false;
  }
});

// ─── 启动接线 ───
// 状态 / 活动按 envId 路由（无 envId 的旧形状归 '__local__'，行为与单环境逐位一致）。
window.aidcpEdge.onStatusUpdate(routeStatus);
// 活动流条目（旧版主进程无此通道时安全跳过——渲染层对旧形状降级不炸）。
window.aidcpEdge.onActivity?.(routeActivity);
// fleet 快照通道（多环境花名册 / 选中项 / 收展；旧主进程无此通道时安全跳过）。
window.aidcpEdge.onFleetUpdate?.(routeFleetSnapshot);
// 批量代理进度只接受当前请求；main 仅在逐项写入明确成功后发送。
window.aidcpEdge.onEnvProxyBatchProgress?.(handleBatchProxyProgress);
if (typeof window.aidcpEdge.fleetGet === 'function') {
  void bootstrapEnvironmentRoster();
} else {
  // 旧主进程没有 fleet API：逐字保留原有单环境启动顺序，不让兼容路径永久卡在 loading。
  window.aidcpEdge.getSettings().then((settings) => {
    applySettings(settings);
    if (selectedProvider() === 'adspower') probeAds();
  });
  window.aidcpEdge.getStatus().then(routeStatus);
  environmentRosterBootstrapPending = false;
  fleetView.rosterPhase = 'ready';
  fleetView.lastRailSig = '';
  renderRail();
}
