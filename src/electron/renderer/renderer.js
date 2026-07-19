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
  auth: document.querySelector('#auth-status'),
  cloud: document.querySelector('#cloud-status'),
  session: document.querySelector('#session-state'),
  risk: document.querySelector('#risk-status'),
  edge: document.querySelector('#edge-state'),
  views: document.querySelector('#views'),
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
    like: document.querySelector('#likes-cap'),
    collect: document.querySelector('#collects-cap'),
    comment: document.querySelector('#comments-cap'),
    follow: document.querySelector('#follows-cap'),
    publish: document.querySelector('#publishes-cap'),
    join_group: document.querySelector('#joins-cap'),
  },
  usageBars: {
    view: document.querySelector('#views-bar'),
    like: document.querySelector('#likes-bar'),
    collect: document.querySelector('#collects-bar'),
    comment: document.querySelector('#comments-bar'),
    follow: document.querySelector('#follows-bar'),
    publish: document.querySelector('#publishes-bar'),
    join_group: document.querySelector('#joins-bar'),
  },
  lastMessage: document.querySelector('#last-message'),
  sessionFab: document.querySelector('#session-fab'),
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
  acctAva: document.querySelector('#acct-ava'),
  acctName: document.querySelector('#acct-name'),
  acctPlat: document.querySelector('#acct-plat'),
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
  pubHead: document.querySelector('#pub-head'),
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
  pubPreviewLink: document.querySelector('#pub-preview-link'),
  publishPreviewPanel: document.querySelector('#publish-preview-panel'),
  publishPreviewKind: document.querySelector('#publish-preview-kind'),
  publishPreviewTitle: null,
  publishPreviewContent: document.querySelector('#publish-preview-content'),
  publishPreviewActions: document.querySelector('#publish-preview-actions'),
  publishPreviewActionHint: document.querySelector('#publish-preview-action-hint'),
  publishPreviewApprove: document.querySelector('#publish-preview-approve'),
  publishPreviewCancel: document.querySelector('#publish-preview-cancel'),
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
  railAdd: document.querySelector('#rail-add'),
  railFootAdd: document.querySelector('#rail-foot-add'),
  railSum: document.querySelector('#rail-sum'),
  railSumRun: document.querySelector('#rail-sum-run'),
  railSumAttn: document.querySelector('#rail-sum-attn'),
  railSumIdle: document.querySelector('#rail-sum-idle'),
  railGuide: document.querySelector('#rail-guide'),
  railStartAll: document.querySelector('#rail-start-all'),
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
  adsManualAdd: document.querySelector('#ads-manual-add'),
  // 账号人设浮层（edge-fleet-rail-env-management；重设计于 edge-client-proxy-platform-persona-ux）
  personaPop: document.querySelector('#persona-pop'),
  personaMask: document.querySelector('#persona-mask'),
  personaClose: document.querySelector('#persona-close'),
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
  interactionRoot: document.querySelector('#interaction-workspace'),
  shell: document.querySelector('.shell'),
  api: window.aidcpEdge,
}) || null;

function syncInteractionWorkspace() {
  if (!interactionWorkspace) return;
  const selected = fleetView.envs.get(fleetView.selected);
  interactionWorkspace.selectEnvironment(selected ? {
    envKey: selected.profileId || selected.envId,
    runtimeEnvId: selected.envId,
    platform: normPlatform(selected.platform),
    label: selected.name || '',
    connectivity: selected.status && selected.status.cloud,
    edge: selected.status && selected.status.edge,
    session: selected.status && selected.status.session,
  } : null);
}

function syncContentWorkspace(status = currentStatus) {
  if (!contentWorkspace) return;
  const selected = fleetView.envs.get(fleetView.selected);
  const envId = currentEnvId() || (status && status.envId);
  contentWorkspace.setEnvironment(envId ? {
    envId,
    label: (status && status.account && status.account.name) || (selected && selected.name) || '当前账号',
    platform: selectedEnvPlatform(),
  } : null);
}

const settingsUi = {
  useChrome: document.querySelector('#use-chrome'),
  adsConfig: document.querySelector('#ads-config'),
  adsProfile: document.querySelector('#ads-profile'),
  adsProfileDisplay: document.querySelector('#ads-profile-display'),
  adsManual: document.querySelector('#ads-manual'),
  adsApiKey: document.querySelector('#ads-apikey'),
  adsApiBase: document.querySelector('#ads-apibase'),
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
  adsPlatform: document.querySelector('#ads-platform'),
  adsFbCreateMode: document.querySelector('#ads-fb-create-mode'),
  adsFbImportWrap: document.querySelector('#ads-fb-import-wrap'),
  adsFbImport: document.querySelector('#ads-fb-import'),
  adsFbImportRequirement: document.querySelector('#ads-fb-import-requirement'),
  adsFbBatchAccountHelp: document.querySelector('#ads-fb-batch-account-help'),
  adsCreateMsg: document.querySelector('#ads-create-msg'),
  // 新建环境的可选代理区块（edge-client-proxy-platform-persona-ux）
  adsProxyType: document.querySelector('#ads-proxy-type'),
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
  cloudEnvCurrent: document.querySelector('#cloud-env-current'),
  cloudEnvHint: document.querySelector('#cloud-env-hint'),
  cloudRestartAll: document.querySelector('#cloud-restart-all'),
};
// 云端环境展示名（一处；与主进程 CLOUD_ENV_LABELS 对齐）。
const CLOUD_ENV_LABELS = { dev: 'dev', ol: 'ol（线上）', custom: '自定义', '': '默认' };
const PARKING_MODES = new Set(['primary-screen', 'parking-display', 'edge-strip', 'offscreen']);

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
  session: { idle: '待命', running: '进行中', resting: '等待下一轮', paused: '已暂停', closed: '已关闭' },
  risk: { normal: '正常', warned: '谨慎放慢', restricted: '受限', frozen: '已冻结' },
  edge: { stopped: '已停止', starting: '启动中', running: '运行中', warning: '异常' },
};

const SUBTITLE = {
  adspower: '内置指纹浏览器托管，每个分身独立指纹与 IP，规避同机多账号关联。',
  self: '本机 Chrome 以持久化配置启动，用于小红书登录与自动运营。',
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
  handledByEnv: new Map(),
};
// 云端环境（change edge-cloud-env-selector）：本地已选 key + 主进程解析出的目标云端视图（含友好名）。
let cloudSelKey = '';
let targetCloud = { key: '', label: '默认', url: '' };
// ── 多环境 fleet 视图态（edge-multi-environment-fleet）──
// 状态 / 活动按 envId 归属；右侧主区域只呈现「当前选中环境」的投影（内容与交互不变）。
// 无 envId 的旧形状（单环境主进程 / 测试桩）归 '__local__'，环境栏对其隐藏——零回归。
const fleetView = {
  envs: new Map(), // envId -> { envId, name, platform, status }
  order: [], // 花名册顺序
  selected: null, // 当前选中 envId
  shownEnv: null, // 头像三态：已把浏览器抬到主屏前台的那个 envId（null=无）。切换选中即清，见 selectEnv
  collapsed: true, // 环境栏默认收起为窄图标条
  platformFilter: 'all', // 平台分类筛选为会话内视图态；每次启动默认全部，不落设置
  buffers: new Map(), // envId -> [{ entry, cls }]（每环境活动流缓冲，≤200 条，绝不串号）
  logs: new Map(), // envId -> { entries:[{time,message}], last }（每环境开发者原始日志，绝不串号）
  guided: null, // 引导处理态 { done:Set, current }
  lastRailSig: '', // 环境栏 DOM 变更签名（每秒 stale 重估时避免无谓重建，见 renderRail）
  lastRailSel: null, // 上次渲染时的选中 envId：只有「选中真的变了」才把选中行滚进视野，绝不与用户手滚打架
  lastRailCollapsed: null, // 上次渲染时的收 / 展态：行高体系不同，旧滚动位在新布局里没有意义
};
function currentEnvId() {
  return fleetView.selected && fleetView.selected !== '__local__' ? fleetView.selected : undefined;
}
function routeSelKey() {
  return fleetView.selected || '__local__';
}
// 用户正在编辑设置表单时不被状态推送回填覆盖（避免边打字边被清空）。
let editingProvider = null;
// 设置是否相对「已应用/已保存」有改动。核心在跑且 dirty 时才显示「按新设置重启」；
// 「保存」按钮已并入「启动」——启动时先存再起，故无独立保存按钮。
let dirty = false;
// 选中环境的 AdsPower 环境名（随设置持久化，作标题带账号标签兜底）。
let selectedProfileName = '';
// 运行花名册（edge-multi-environment-fleet）：多选加入的环境成员 [{profileId, name, platform}]，
// 按 profileId 去重（同一分身 MUST NOT 重复加入，防 edgeId 撞车）；持久化为 settings.environments。
let roster = [];
// 客户归属环境默认入册的持久 opt-out；只在 main 明确标记 assignmentScoped 的列表上读写。
let clientRosterExcludedEnvIds = new Set();
let lastAssignmentScoped = false;
// 最近一次拉取的环境列表（roster 变更后就地重刷成员标记，无需重新拉取）。
let lastProfiles = [];
function normalizeRosterList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String((raw && (raw.profileId !== undefined ? raw.profileId : raw.userId)) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ profileId: id, name: (raw && raw.name) || '', platform: normPlatform(raw && raw.platform) });
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
  const batch = facebook && settingsUi.adsFbCreateMode && settingsUi.adsFbCreateMode.value === 'batch';
  settingsUi.adsFbCreateMode?.classList.toggle('hidden', !facebook);
  settingsUi.adsFbImportWrap?.classList.toggle('hidden', !facebook);
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
  if (settingsUi.adsCreate) settingsUi.adsCreate.textContent = batch ? '批量创建' : '创建环境';
  const noProxy = !settingsUi.adsProxyType || settingsUi.adsProxyType.value === 'no_proxy';
  settingsUi.adsProxyDetail?.classList.toggle('hidden', Boolean(batch) || noProxy);
  settingsUi.adsProxyBatchWrap?.classList.toggle('hidden', !batch || noProxy);
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
 * 不依赖边缘的慢启动读缓存（change slow-start-offline-toggle），按 envKey 隔离。存放**纯云端真态**，
 * 供**没有活快照**（从未启动 / 已停止，dailyUsage 为 null）的环境渲染慢启动这一行——binding_unknown 可见性的前置。
 * 三种态：{ kind:'loading' }（读在途）/ { kind:'ok', slowStart, dayQuotas }（读到真态，或写入回执覆盖）/
 * { kind:'error', message }（够不到云端，就地如实展示，绝不静默吞）。
 * **来源优先级（D3，规则非巧合）**：有活快照 → 快照治理；无活快照 → 本缓存（HTTP 读）；PUT 回执 → 对发起环境权威
 * （写成功即写入本缓存）。三者同源于云端 slowStartView，**MUST NOT 逐字段合并**——整体采用其一。
 */
const slowStartHttpByEnv = new Map();

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
  if (context && context.envKey === envKey) renderSlowStart((context.env && context.env.status) || currentStatus);
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
 * 声明摘掉该平台结构上做不到的动作（FB 没有收藏、没有关注执行器），客户端只渲染云端真给了的键。
 * 客户端 MUST NOT 自己按平台判：它拿不到权威平台值（本地环境标签会错标，见 backlog 90.8）。
 *
 * `stat` = 无云端用量载荷时的本机回落来源。`join_group` 是 null：加群没有本机计数来源，故在「云端还没
 * 发过用量」的那段时间里它不出现——那正是本 change 之前的现状（fail-safe 方向 = 保持现状）。
 */
const USAGE_ITEMS = [
  { action: 'view', stat: 'views', value: fields.views, label: '浏览' },
  { action: 'like', stat: 'likes', value: fields.likes, label: '点赞' },
  { action: 'collect', stat: 'collects', value: fields.collects, label: '收藏' },
  { action: 'comment', stat: 'comments', value: fields.comments, label: '评论' },
  { action: 'follow', stat: 'follows', value: fields.follows, label: '关注' },
  { action: 'publish', stat: 'publishes', value: fields.publishes, label: '发帖' },
  { action: 'join_group', stat: null, value: fields.joins, label: '加群' },
];

const QUOTA_WINDOWS = [
  { key: 'session', label: '本轮计划' },
  { key: 'minute', label: '当前节奏' },
  { key: 'hour', label: '阶段节奏' },
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

function usageView(status) {
  const daily = status.dailyUsage;
  const hasDaily = Boolean(daily && daily.totals && typeof daily.totals === 'object');
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
    } else if (item.stat) {
      supplied.add(item.action);
      totals[item.action] = count(stats[item.stat]);
    }
  }
  const quotas = daily && daily.quotas && typeof daily.quotas === 'object' ? daily.quotas : null;
  return {
    hasDaily,
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
  const used = count(usage.totals[item.action]);
  const cap = usage.quotas && typeof usage.quotas[item.action] === 'number' ? count(usage.quotas[item.action]) : null;
  const capEl = fields.usageCaps[item.action];
  const barEl = fields.usageBars[item.action];
  const hasCap = cap !== null;
  const saturated = hasCap && (usage.saturated.has(item.action) || used >= cap);
  const ratio = hasCap ? (cap > 0 ? Math.min(1, used / cap) : 1) : 0;

  item.value.textContent = used;
  item.value.classList.toggle('zero', used === 0);
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
  const completed = rows.filter((entry) => entry.complete).length;
  const worst = capped.reduce((best, entry) => (!best || entry.ratio > best.ratio ? entry : best), null);
  const ratio = !expired && active ? (worst?.ratio ?? 0) : 0;
  const tone = expired || !active ? 'idle' : completed > 0 ? 'complete' : ratio >= 0.8 ? 'near' : 'ok';
  const state = expired ? '准备下一轮' : !active ? '等待开始' : completed > 0 ? `完成 ${completed}项` : ratio >= 0.8 ? '接近完成' : '进行中';
  const baseMeta = worst ? `${worst.label} ${worst.used}/${worst.cap}` : '持续记录中';
  const meta = expired
    ? refreshMeta(refreshAt, now)
    : (completed > 0 && releaseAt !== null && releaseAt > now ? `${baseMeta} · ${timeHint(releaseAt, now)}继续` : baseMeta);
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
    title: `${item.label}: ${state}${rows.length > 0 ? ` · ${rows.map((entry) => `${entry.label} ${entry.used}/${entry.cap ?? '-'}`).join(' · ')}` : ''}`,
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
      const value = entry.cap !== null ? `${entry.used}/${entry.cap}` : `${entry.used}/-`;
      return `
        <div class="qwd-row ${entry.complete ? 'complete' : entry.ratio >= 0.8 && entry.cap !== null ? 'near' : ''}">
          <span>${escapeHtml(entry.label)}</span>
          <b>${escapeHtml(value)}</b>
          <i><em style="width:${pct}%"></em></i>
        </div>`;
    }).join('');
    return `
      <div class="quota-window-detail ${window.tone}" title="${escapeHtml(window.title)}">
        <div class="qwd-head">
          <span>${escapeHtml(window.label)}</span>
          <strong>${escapeHtml(window.state)}</strong>
        </div>
        <small>${escapeHtml(window.meta)}</small>
        <div class="qwd-rows">${rows}</div>
      </div>`;
  }).join('');
}

function renderUsageSummary(status) {
  const usage = usageView(status);
  fields.usageSource.textContent = usage.hasDaily
    ? `账号今日${usage.quotaLevel ? ` · ${QUOTA_LEVEL_LABELS[usage.quotaLevel] || usage.quotaLevel}` : ''}`
    : '本机实时';
  const limit = usageProgressLabel(usage);
  if (fields.usageLimit) {
    fields.usageLimit.textContent = limit ? limit.text : '';
    fields.usageLimit.className = limit ? `summary-limit ${limit.tone}` : 'summary-limit hidden';
    fields.usageLimit.title = limit ? limit.title || limit.text : '';
  }
  for (const item of USAGE_ITEMS) renderUsageItem(item, usage);
  renderQuotaWindows(usage);
  renderSlowStart(status);
  fields.updatedAt.textContent = new Date(usage.asOf).toLocaleTimeString();
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
  const connState = status && status.cloud === 'connected' ? 'online' : 'offline';
  // 来源优先级（change slow-start-offline-toggle，D3）：① 有活快照 → 快照治理（同时带用量计数）。
  const snapshotView = window.uiLogic.slowStartLine(status && status.dailyUsage, connState, 'snapshot');
  if (snapshotView.visible) {
    applySlowStartView(snapshotView, context);
    return;
  }
  // 云端已连接但快照尚未带来 slowStart（瞬态）→ 快照马上就到，先隐藏，绝不冗余 HTTP 读（否则连着的号也去打一次读）。
  if (connState !== 'offline') {
    hideSlowStartRow();
    return;
  }
  // ② 边缘离线（从未启动 / 已停止，dailyUsage 为 null）→ 用不依赖边缘的 env-scoped 读填这一行。
  //    这是 binding_unknown 可见性的**前置**——真正让它「什么都不显示」的是「没有 payload ⇒ 整行不渲染」，不是文案表缺键。
  if (!window.aidcpEdge || typeof window.aidcpEdge.getSlowStart !== 'function') {
    // 该构建未提供不依赖边缘的读（老客户端）→ 退回旧占位，绝不卡在「正在读取」。
    renderSlowStartPlaceholder('启动环境并连接云端后同步慢启动状态');
    return;
  }
  const http = slowStartHttpByEnv.get(context.envKey);
  if (http && http.kind === 'ok') {
    applySlowStartView(window.uiLogic.slowStartLine({ slowStart: http.slowStart }, connState, 'http'), context);
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
  const acct = status.account;
  if (acct && (acct.name || acct.id)) {
    // 标签兜底链：平台昵称（@ 前缀）> AdsPower 环境名（平铺，不冒充平台昵称）> 账号 …尾4位。
    const nick = (acct.name || '').replace(/^@/, '');
    const isPlatNick = nick && acct.source !== 'env';
    fields.acctName.textContent = nick ? (isPlatNick ? `@${nick}` : nick) : `账号 …${String(acct.id).slice(-4)}`;
    fields.acctAva.textContent = nick ? nick.slice(0, 1) : (fb ? 'f' : wechat ? '视' : '书');
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
  if (fields.authLabel) fields.authLabel.textContent = fb ? 'Facebook 登录' : wechat ? '视频号登录' : '小红书登录';
  const health = uiLogic.synthesizeHealth(status);
  fields.healthLabel.textContent = health.label;
  fields.healthPill.className = `health-pill nodrag ${health.code}`;
  fields.healthDetail.textContent = failureSummary(status) || health.detail || '';
  fields.titlebar.className = `titlebar tone-${uiLogic.bandTone(status)}`;
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
  const view = uiLogic.runtimeGuidanceView(status, nowMs);
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
  fields.presenceText.textContent = view.text;
  fields.presenceText.classList.toggle('shimmer', view.animate);
  fields.presenceCore.classList.toggle('live', view.animate);
  fields.presenceFresh.textContent = view.fresh || '';
}

// ─── 发布卡（常驻三态：flow 进行中 / last 上次发布 / empty 从未发布；审批在预览内完成）───
// 终态折流的去重签名按 envId 分桶（多环境下 A 的终态签名绝不吞掉 B 的折流）。
const lastPublishSigByEnv = new Map();
// 用户点薄条的临时展开（进行中审批到来 / 会话停止 / 切换环境时自动复位）。
let pubManualOpen = false;
function renderPublish(status, nowMs) {
  const view = uiLogic.publishView(status.publish, status.lastPublish, nowMs);
  const preview = status && status.publishPreview && typeof status.publishPreview === 'object'
    ? status.publishPreview
    : null;
  // 终态折流 + 去重已收口到 absorbPublishTerminal（在 routeStatus 里对每个环境跑，含未选中环境），
  // 这里只负责发布卡的视觉渲染，绝不再自己 prependActivity（否则选中环境会重复记一条）。
  fields.pubCard.classList.remove('hidden'); // 常驻
  fields.pubCard.classList.toggle('empty', view.mode === 'empty');
  fields.pubCard.dataset.pubMode = view.mode;
  fields.pubCard.dataset.pubState = status.publish && status.publish.state ? status.publish.state : view.mode;
  // 收展：flow 永远展开；已发布历史与空态默认收起（点击薄条可临时展开）。
  const dock = uiLogic.publishDock(view, status, pubManualOpen);
  if (view.mode === 'flow') pubManualOpen = false; // 新审批到来自动展开并复位手动态
  fields.pubCard.classList.toggle('collapsed', dock.collapsed);
  fields.pubBar.classList.toggle('hidden', !dock.collapsed);
  fields.pubMain.classList.toggle('folded', dock.collapsed);
  fields.pubBarLabel.textContent = dock.label || '发布过的 AI 写好的笔记';
  fields.pubBarSum.textContent = dock.summary || '';
  fields.pubHead.textContent = view.head;
  fields.pubCorner.textContent = view.corner;
  fields.pubCorner.classList.toggle('hot', Boolean(view.cornerHot));
  fields.pubTitle.textContent = view.title || (preview && preview.title) || '（新笔记）';
  fields.pubTitle.classList.toggle('muted', view.mode === 'empty');
  // 编号默认形态：无真编号时以「—」占位（云端飞书卡印上 requestId 后自动点亮真编号）；编号值带灰底小片（设计稿）。
  fields.pubMeta.textContent = '';
  const previewMeta = preview && view.mode === 'flow'
    ? `${preview.kind === 'rewrite' ? '洗稿稿件' : 'AI 稿件'} · 正文 ${String(preview.content || '').length} 字 · 配图 ${Array.isArray(preview.images) ? preview.images.length : 0} 张 · 编号 `
    : (view.mode === 'empty' ? '等待第一条笔记 · 编号 ' : '图文笔记 · 编号 ');
  fields.pubMeta.appendChild(document.createTextNode(previewMeta));
  const codeChip = document.createElement('span');
  codeChip.className = 'no';
  codeChip.textContent = view.code || (preview && preview.code) || '—';
  fields.pubMeta.appendChild(codeChip);
  renderFootRich(fields.pubFoot, view.foot); // 固定模板内 **…** 加粗，破掉整片灰
  fields.pubPreviewLink.classList.toggle('hidden', !(preview && view.mode === 'flow'));
  syncPublishPreviewActions(status);
  const steps = fields.pubSteps.querySelectorAll('.j-step');
  view.stepStates.forEach((state, i) => {
    const el = steps[i];
    if (!el) return;
    el.className = `j-step ${state}${state === 'cur' && view.curCalm ? ' calm' : ''}`;
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
});

function normalizePublishDraft(raw) {
  return publishReviewLogic.normalizeDraft(raw);
}

function publishDraftHandledSet(envId) {
  if (!publishDraftReview.handledByEnv.has(envId)) publishDraftReview.handledByEnv.set(envId, new Set());
  return publishDraftReview.handledByEnv.get(envId);
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
}

function activePublishPreview(status = currentStatus) {
  if (publishDraftReview.selected && publishDraftReview.envId === status?.envId) {
    return publishDraftReview.selected;
  }
  return status?.publishPreview ? normalizePublishDraft(status.publishPreview) : null;
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
  const disabled = publishPreviewActionBusy || !pending;
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
}

function appendPreviewText(parent, text, className) {
  const el = document.createElement('div');
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

// 上一次删配图失败的原因（诚实呈现；成功后清空）。同样存模块级——抽屉每帧重建。
let publishPreviewImageRemoveHint = '';

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
    timeRow = document.createElement('label');
    timeRow.className = 'publish-plan-time';
    const caption = document.createElement('span');
    caption.textContent = '发布时间（北京时间）';
    const input = document.createElement('input');
    timeInput = input;
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
    timeRow.append(caption, input, hint);
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
}

function renderPublishPreviewContent(status) {
  if (!fields.publishPreviewContent) return;
  const reviewActive = publishDraftReview.envId === status?.envId;
  if (reviewActive && publishDraftReview.loading) {
    renderPublishDraftMessage('正在读取待审批稿件', '只会显示当前账号仍待处理的内容。', false);
    return;
  }
  if (reviewActive && publishDraftReview.error) {
    renderPublishDraftMessage('暂时无法读取稿件', '请检查连接后重试，当前没有执行任何审批。', true);
    return;
  }
  if (reviewActive && publishDraftReview.loaded && !publishDraftReview.selected) {
    if (publishDraftReview.total === 0 || publishDraftReview.items.length === 0) {
      renderPublishDraftMessage('没有待审批稿件', '新稿件生成后会出现在这里。', false);
      return;
    }
    renderPublishDraftList();
    return;
  }
  const preview = activePublishPreview(status);
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
      const img = document.createElement('img');
      img.src = String(url);
      img.alt = `配图 ${index + 1}`;
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
  appendPreviewText(bodySection, typeof preview.content === 'string' && preview.content ? preview.content : '暂无正文', 'publish-preview-body');
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
  if (publishPreviewIsPending(status)) appendPublishPlanControls(fields.publishPreviewContent, preview);
  syncPublishPreviewActions(status);
}

function openPublishPreview() {
  if (!currentStatus || !currentStatus.publishPreview) return;
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
}

function closePublishPreview() {
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

fields.pubPreviewLink.addEventListener('click', openPublishPreview);
fields.pubPreviewLink.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openPublishPreview();
  }
});
async function submitPublishPreviewAction(approved) {
  const preview = activePublishPreview(currentStatus);
  if (!preview || publishPreviewActionBusy) return;
  const actionEnvId = currentStatus.envId;
  const actionRecordId = preview.recordId;
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
  const nextState = result.state || (approved ? 'approved' : 'rejected');
  publishDraftHandledSet(actionEnvId).add(Number(actionRecordId));
  if (Number(currentStatus.publishPreview?.recordId) === Number(actionRecordId)) {
    currentStatus = {
      ...currentStatus,
      publish: {
        ...(currentStatus.publish || {}),
        state: nextState,
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fields.publishPreviewPanel.classList.contains('open')) closePublishPreview();
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
  [/^(like|comment_like|follow)$/, ['赞', 'ic-like']],
  [/^collect$/, ['藏', 'ic-collect']],
  [/^(comment|comment_pending|comment_failed)$/, ['评', 'ic-comment']],
  [/^(join_group|join_pending|join_failed)$/, ['群', 'ic-join']],
  [/^(search|search_failed)$/, ['搜', 'ic-search']],
  [/^(note_open|images|profile_read)$/, ['读', 'ic-read']],
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

function toggleQuotaDetails() {
  quotaDetailsOpen = !quotaDetailsOpen;
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
fields.slowStartToggle?.addEventListener('change', (event) => {
  event.stopPropagation();
  void submitSlowStart(Boolean(event.target.checked));
});

/**
 * 提交环境级慢启动开关：只传 envKey + enabled，客户端不提交 accountId。
 * 失败**必须把开关拨回去 + 如实说明**——留在「已勾」而库里没写，就是用界面撒谎；
 * 而这个谎的代价是运营以为号在被养、实际在按满额度跑。
 */
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
fields.quotaToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleQuotaDetails();
});

// ─── 健康明细浮层 ───
fields.healthPill.addEventListener('click', (event) => {
  event.stopPropagation();
  fields.healthPop.classList.toggle('hidden');
});
document.addEventListener('click', (event) => {
  if (!fields.healthPop.classList.contains('hidden') && !fields.healthPop.contains(event.target)) {
    fields.healthPop.classList.add('hidden');
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

// ─── 添加/创建环境面板（左栏「＋」拉起）───
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
  fields.envAddPanel.classList.remove('open');
  fields.envAddPanel.classList.add('hidden');
  fields.envAddPanel.setAttribute('aria-hidden', 'true');
  fields.envAddMask?.classList.add('hidden');
}
function switchEnvTab(tab) {
  const join = tab !== 'create';
  fields.envTabJoin?.classList.toggle('active', join);
  fields.envTabCreate?.classList.toggle('active', !join);
  fields.envTabJoinBody?.classList.toggle('hidden', !join);
  fields.envTabCreateBody?.classList.toggle('hidden', join);
}
fields.railAdd?.addEventListener('click', () => openEnvAddPanel('join'));
fields.railFootAdd?.addEventListener('click', () => openEnvAddPanel('join'));
fields.envAddClose?.addEventListener('click', closeEnvAddPanel);
fields.envAddMask?.addEventListener('click', closeEnvAddPanel);
fields.envTabJoin?.addEventListener('click', () => switchEnvTab('join'));
fields.envTabCreate?.addEventListener('click', () => switchEnvTab('create'));
// 待配置引导的「添加环境」按钮直达左栏加环境面板（不再去设置抽屉）。
fields.noticeAction.addEventListener('click', () => openEnvAddPanel('join'));

// ─── 账号人设浮层（左栏行内人设图标拉起，对「该行环境」做人设）───
// 打开即把该环境设为选中（右侧陪伴视图 + 状态随之切过去），使人设向导的 gate（登录+连云）与草稿归属
// 都锚定这个环境（persist 打回它，绝不跨账号）。头部身份锚点（头像 + 平台小标）把这个事实可视化。
function openPersonaPop(envId, reason = 'manual') {
  if (!fields.personaPop) return;
  if (envId && envId !== fleetView.selected && fleetView.envs.has(envId)) selectEnv(envId);
  const env = fleetView.envs.get(fleetView.selected);
  const label = env && (env.name || (env.status && env.status.account && env.status.account.name)) || '';
  if (fields.personaPopEnv) fields.personaPopEnv.textContent = label ? `· ${label}` : '';
  const plat = selectedEnvPlatform();
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
  personaPopOpenReason = reason === 'auto' ? 'auto' : 'manual';
  personaPopOpenEnvId = currentEnvId() || envId || null;
  // 用目标环境**自身**的状态评闸：此前用 currentStatus，目标环境尚无状态推送时会拿上一环境的状态误开闸。
  updatePersonaGate((env && env.status) || null);
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
  window.aidcpEdge.saveSettings({ devDetails: devToggle.checked }); // 独立持久化，不打断在跑核心
});

// 今日进展内的会话控制：已暂停→关闭+恢复 / 已关闭或停止→启动 / 其余（运行·启动中）→暂停。
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
  if (fields.sessionClose) fields.sessionClose.classList.toggle('hidden', status.session !== 'paused');
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
  currentStatus = status;
  syncDelegatedActionAvailability();
  const now = Date.now();
  setBadge(fields.auth, 'auth', status.auth);
  setBadge(fields.cloud, 'cloud', status.cloud);
  setBadge(fields.session, 'session', status.session);
  setBadge(fields.risk, 'risk', status.risk);
  setBadge(fields.edge, 'edge', status.edge);
  renderUsageSummary(status); // 各计数一律 ?? 0 兜底（旧形状 / 部分补丁都不出空数字）
  // 原始日志记录已移到 routeStatus（按 envId 分桶、覆盖未选中环境）；此处仅刷当前环境的日志 DOM。
  renderLog();
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
  updateApplyRestart(); // 依「dirty && 核心在跑」决定是否显示「按新设置重启」
  updateCloudPending(); // 云端环境（change edge-cloud-env-selector）：随状态心跳刷「当前云端 / 待重启生效」
  if (status.provider && SUBTITLE[status.provider]) fields.subtitle.textContent = SUBTITLE[status.provider];
  // 表单未在编辑时，让 provider 分段跟随实际运行 provider。
  if (status.provider && !editingProvider) applyProviderSelection(status.provider);
  updatePersonaGate(status); // 建号人设：仅登录+云端已连接才可生成（不触碰已选关键词/草稿，避免状态推送重置向导）
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
  if (!env) {
    env = { envId: key, name: status.envName || '', platform: '', status };
    fleetView.envs.set(key, env);
    if (!fleetView.order.includes(key)) fleetView.order.push(key);
  } else {
    env.status = status;
    if (status.envName) env.name = status.envName;
  }
  if (!fleetView.selected) fleetView.selected = key;
  // 原始日志与发布终态折流对**每个**环境记录（含未选中）：未选中环境的日志进其桶、发布终态折进其活动缓冲，
  // 切过去时历史完整、绝不丢，也绝不串到别的环境。
  recordLog(key, status.lastMessage);
  absorbPublishTerminal(key, status);
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
  const view = uiLogic.publishView(status.publish, status.lastPublish, Date.now());
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
  const prevSelectedPlat = selectedEnvPlatform();
  const known = new Set();
  fleetView.order = [];
  for (const e of snap.environments) {
    if (!e || !e.envId) continue;
    known.add(e.envId);
    fleetView.order.push(e.envId);
    const existing = fleetView.envs.get(e.envId);
    if (existing) {
      existing.name = e.name || existing.name;
      existing.platform = e.platform || existing.platform;
      existing.profileId = e.profileId || existing.profileId;
      if (e.status) existing.status = e.status;
    } else {
      fleetView.envs.set(e.envId, {
        envId: e.envId, profileId: e.profileId || '', name: e.name || '', platform: e.platform || '', status: e.status,
      });
    }
  }
  for (const key of [...fleetView.envs.keys()]) {
    if (known.has(key)) continue;
    const goneEnvKey = slowStartEnvKey(fleetView.envs.get(key));
    slowStartFeedbackByEnv.delete(goneEnvKey);
    slowStartHttpByEnv.delete(goneEnvKey); // change slow-start-offline-toggle：连同慢启动 HTTP/回执缓存一并清
    fleetView.envs.delete(key); // 快照为准（含 '__local__' 占位）
    // 连同该环境的所有渲染层缓冲一并清（否则同一分身移出再加回会重放上一会话的陈旧活动 + 吞掉新发布折流，
    // 还有全会话内存泄漏）。
    fleetView.buffers.delete(key);
    fleetView.logs.delete(key);
    lastPublishSigByEnv.delete(key);
    if (fleetView.shownEnv === key) fleetView.shownEnv = null;
  }
  if (typeof snap.railCollapsed === 'boolean') fleetView.collapsed = snap.railCollapsed;
  const prevSelected = fleetView.selected;
  if (snap.selectedEnvId && fleetView.envs.has(snap.selectedEnvId)) fleetView.selected = snap.selectedEnvId;
  if (!fleetView.selected || !fleetView.envs.has(fleetView.selected)) fleetView.selected = fleetView.order[0] || null;
  if (fleetView.selected !== prevSelected) {
    closeDelegatedPopover(false);
    syncDelegatedTriggerTasks([]);
  }
  if (fleetView.selected && fleetView.selected !== prevSelected) {
    pubManualOpen = false;
    closePublishPreview();
    resetPersonaDraft();
    const env = fleetView.envs.get(fleetView.selected);
    if (env && env.status) render(env.status);
    rebuildActivityStream();
    void refreshDelegatedTasks(true, fleetView.selected);
  } else if (selectedEnvPlatform() !== prevSelectedPlat) {
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
}

/** 点选环境：右侧主区域整体切到该环境的陪伴视图（状态 + 活动流 + 发布卡投影一起换，绝不残留）。 */
function selectEnv(envId) {
  if (!envId || !fleetView.envs.has(envId) || envId === fleetView.selected) return;
  closeDelegatedPopover(false);
  syncDelegatedTriggerTasks([]);
  fleetView.selected = envId;
  fleetView.shownEnv = null; // 切到另一个环境：头像三态从头开始，绝不留着旧环境的「已显示」指针
  pubManualOpen = false;
  closePublishPreview();
  resetPersonaDraft(); // 人设向导每环境独立：切换即清草稿，绝不把 A 的草稿误确认到 B
  syncInteractionWorkspace();
  syncContentWorkspace(fleetView.envs.get(envId)?.status);
  window.aidcpEdge.fleetSelect?.(envId);
  const env = fleetView.envs.get(envId);
  if (env && env.status) render(env.status);
  rebuildActivityStream();
  renderRail();
  void refreshDelegatedTasks(true, envId);
}

function railEnvList() {
  return fleetView.order
    .filter((id) => id !== '__local__')
    .map((id) => fleetView.envs.get(id))
    .filter(Boolean);
}

function filteredRailEnvList() {
  const list = railEnvList();
  if (fleetView.platformFilter === 'all') return list;
  return list.filter((env) => normPlatform(env && env.platform) === fleetView.platformFilter);
}

// 需处理浮顶，其后普通状态明确分为运行中 / 暂停 / 离线。级别归组一处收口。
const isPausedRailRow = (r) => !r.needsAction && r.status && r.status.session === 'paused';
const isRunningRailRow = (r) => !r.needsAction && !isPausedRailRow(r) && (r.level === 'running' || r.level === 'launching');
const isOfflineRailRow = (r) => !r.needsAction && !isPausedRailRow(r) && (r.level === 'offline' || r.level === 'stale');
const RAIL_GROUPS = [
  { key: 'attn', title: '需要处理', crit: true, has: (r) => r.needsAction },
  { key: 'run', title: '运行中', crit: false, has: isRunningRailRow },
  { key: 'paused', title: '暂停', crit: false, has: isPausedRailRow },
  { key: 'offline', title: '离线', crit: false, has: isOfflineRailRow },
];

// 显示优先级（真实昵称 → 花名册/环境名 → 末4位）的**唯一实现**在 ui-logic.js（可单测），此处委托；
// uiLogic 未加载时用同逻辑内联兜底，行为逐位一致（change edge-adspower-name-follows-nickname）。
function railDisplayName(row) {
  if (window.uiLogic && typeof uiLogic.railDisplayName === 'function') return uiLogic.railDisplayName(row);
  const acct = row && row.status && row.status.account;
  const realNick = acct && acct.source !== 'env' && acct.name ? String(acct.name) : '';
  const envId = row && row.envId != null ? String(row.envId) : '';
  return realNick || (row && row.name) || (acct && acct.name) || `环境 …${envId.slice(-4)}`;
}

function renderRail() {
  if (!fields.envRail || !window.uiLogic || typeof uiLogic.fleetRailModel !== 'function') return;
  const allList = railEnvList();
  const list = filteredRailEnvList();
  // 环境栏常驻显示（用户要求「左边栏默认展示」）：名册为空也保留栏、露出「＋ 添加环境」入口，
  // 不再按有无环境显隐（此前空名册整栏 hidden，新实例进来完全看不到添加入口）。
  const show = true;
  const rosterEmpty = allList.length === 0;
  const empty = list.length === 0;
  // 名册空时本次渲染强制展开（把空态提示与添加入口露出来），但不落库、不覆盖用户已保存的收起偏好；
  // 一旦有环境即回落 fleetView.collapsed（默认收起为窄图标条）。
  const collapsed = rosterEmpty ? false : fleetView.collapsed;
  fields.envRail.classList.toggle('hidden', !show);
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
    run: model.rows.filter(isRunningRailRow).length,
    attn: model.pendingCount,
    idle: model.rows.filter((r) => isPausedRailRow(r) || isOfflineRailRow(r)).length,
  };
  // 变更签名：每秒 stale 重估会反复调本函数，但只有模型真变时才重建 DOM——否则 innerHTML='' 会每秒
  // 打断 1.6s 脉冲动画（视觉抖动）、把行焦点甩回 <body>、并吞掉跨 tick 的点击手势。
  const sig = JSON.stringify({
    show,
    empty,
    collapsed,
    selected: fleetView.selected,
    shown: fleetView.shownEnv,
    guided: Boolean(fleetView.guided),
    platformFilter: fleetView.platformFilter,
    globalPendingCount: fullModel.pendingCount,
    counts,
    // platform 必须进签名：改平台后行才会重建上色（漏掉则签名未变、UI 停留旧平台）。
    rows: model.rows.map((r) => [r.envId, r.level, r.needsAction, railDisplayName(r), r.label, Boolean(r.status && r.status.personaBound), normPlatform(r.platform)]),
  });
  if (sig === fleetView.lastRailSig) return;
  fleetView.lastRailSig = sig;
  fields.envRail.classList.toggle('collapsed', collapsed);
  fields.envRail.classList.toggle('expanded', !collapsed);
  if (fields.railToggle) {
    // 箭头是内联 SVG（默认朝左=收起方向）；收起态水平翻转指向展开方向，不再切字符。
    fields.railToggle.classList.toggle('flip', collapsed);
    fields.railToggle.title = collapsed ? '展开环境列表' : '收起环境列表';
    fields.railToggle.setAttribute('aria-label', fields.railToggle.title);
  }
  if (fields.railCount) fields.railCount.textContent = String(list.length);
  for (const button of fields.railPlatformFilters || []) {
    const active = button.dataset.railPlatform === fleetView.platformFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (fields.railSum) fields.railSum.classList.toggle('hidden', collapsed);
  if (fields.railSumRun) fields.railSumRun.textContent = `▶ ${counts.run}`;
  if (fields.railSumAttn) fields.railSumAttn.textContent = `⚠ ${counts.attn}`;
  if (fields.railSumIdle) fields.railSumIdle.textContent = `⏸ ${counts.idle}`;
  if (fields.railBadge) {
    fields.railBadge.textContent = String(fullModel.pendingCount);
    fields.railBadge.classList.toggle('hidden', fullModel.pendingCount === 0);
  }
  if (fields.railGuide) {
    fields.railGuide.classList.toggle('hidden', fullModel.pendingCount === 0 && !fleetView.guided);
    fields.railGuide.textContent = fullModel.pendingCount > 0 ? `引导处理（${fullModel.pendingCount}）` : '引导处理';
  }
  if (fields.railStartAll) {
    fields.railStartAll.disabled = empty;
    fields.railStartAll.title = empty ? '当前分类暂无可启动环境' : `启动当前分类的 ${list.length} 个环境`;
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
    // 空名册空态：直接给一个「添加第一个环境」按钮（点开加入 / 新建面板），别让用户找那个小「＋」。
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'rail-empty';
    cta.textContent = '＋ 添加第一个环境';
    cta.addEventListener('click', () => openEnvAddPanel('join'));
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
  btn.className = `rail-row lv-${row.level} plat-${normPlatform(row.platform)}${row.needsAction ? ' pulse' : ''}${isSelected ? ' selected' : ''}${isShown ? ' shown' : ''}`;
  btn.dataset.envId = row.envId;
  btn.tabIndex = 0;
  btn.setAttribute('role', 'button');
  const displayName = railDisplayName(row);
  // 收起态悬停出名字与状态 + 头像三态的下一步提示（收起态整卡即头像；点整卡=点头像）。
  const nextHint = !isSelected
    ? '点击选中'
    : isShown
      ? '再次点击：浏览器归位'
      : '再次点击：把浏览器抬到主屏前台';
  btn.title = `${displayName} · ${row.label} · ${nextHint}`;
  const ava = document.createElement('span');
  ava.className = 'rail-ava';
  ava.textContent = displayName.slice(0, 1);
  btn.appendChild(ava);
  const meta = document.createElement('span');
  meta.className = 'rail-meta';
  // 昵称行：昵称 + 人设图标（点击弹独立浮层做人设）
  const nameLine = document.createElement('span');
  nameLine.className = 'rail-nameline';
  const nameEl = document.createElement('span');
  nameEl.className = 'rail-name';
  nameEl.textContent = displayName;
  nameEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    void showRailBrowser(row.envId);
  });
  nameLine.appendChild(nameEl);
  const bound = Boolean(row.status && row.status.personaBound);
  const pIcon = document.createElement('button');
  pIcon.type = 'button';
  pIcon.className = `rail-persona${bound ? ' set' : ''}`;
  pIcon.textContent = '✦';
  pIcon.title = bound ? '账号人设：已设置（点击查看 / 调整）' : '账号人设：未设置（点击设置）';
  pIcon.setAttribute('aria-label', pIcon.title);
  pIcon.addEventListener('click', (e) => { e.stopPropagation(); openPersonaPop(row.envId); });
  nameLine.appendChild(pIcon);
  meta.appendChild(nameLine);
  // 状态行：状态点 + 文案
  const stateEl = document.createElement('span');
  stateEl.className = 'rail-state';
  const dot = document.createElement('span');
  dot.className = 'rail-dot';
  stateEl.appendChild(dot);
  stateEl.appendChild(document.createTextNode(row.label));
  meta.appendChild(stateEl);
  btn.appendChild(meta);
  btn.addEventListener('click', (e) => {
    // A physical double-click emits click(detail=1), click(detail=2), then dblclick.
    // Only the first click may advance the ordinary three-state control; otherwise an
    // already-selected row would show and immediately re-park the browser.
    if (e.detail > 1) return;
    void onRailRowActivate(row.envId);
  });
  btn.addEventListener('keydown', (e) => {
    // 只在整行本身聚焦时响应键盘：焦点在行内的人设 ✦ 按钮上时 e.target≠btn，放行让按钮原生激活（开人设浮层），
    // 否则本处 preventDefault 会吞掉按钮激活、还把三态切换误触发在人设图标上。
    if (e.target !== btn) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRailRowActivate(row.envId); }
  });
  return btn;
}

// 环境头像三态（用户要求）：①未选中→选中（红高亮）②已选中且浏览器未抬前→把浏览器抬到主屏前台并聚焦
// ③已抬前→让浏览器归位（回背景停放位）。②③复用既有 showDrivenBrowser / resetBrowserParking 通道。
// 诚实边界：指令失败（引擎未起 / 浏览器未就绪）绝不推进相位，把回执文案如实显示在环境栏消息位。
// 人设 ✦ 图标自带 stopPropagation（见 makeRailRow），不会误触发本三态。
async function onRailRowActivate(envId) {
  if (!envId || !fleetView.envs.has(envId)) return;
  if (envId !== fleetView.selected) { selectEnv(envId); return; } // ① 选中
  const showing = fleetView.shownEnv !== envId; // 目标动作：未显示→显示；已显示→归位
  const api = showing ? window.aidcpEdge.showDrivenBrowser : window.aidcpEdge.resetBrowserParking;
  if (typeof api !== 'function') return;
  const label = showing ? '显示浏览器' : '浏览器归位';
  try {
    const r = await api(envId);
    if (r && r.ok) {
      fleetView.shownEnv = showing ? envId : null; // 仅成功才推进相位
      setRailMsg(r.hint || `${label}指令已发送。`);
      renderRail();
    } else {
      setRailMsg(`${label}失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`);
    }
  } catch (e) {
    setRailMsg(`${label}失败：${(e && e.message) || e}`);
  }
}

async function showRailBrowser(envId) {
  if (!envId || !fleetView.envs.has(envId)) return;
  if (envId !== fleetView.selected) selectEnv(envId);
  if (fleetView.shownEnv === envId) return;
  const api = window.aidcpEdge.showDrivenBrowser;
  if (typeof api !== 'function') return;
  try {
    const r = await api(envId);
    if (r && r.ok) {
      fleetView.shownEnv = envId;
      setRailMsg(r.hint || '显示浏览器指令已发送。');
      renderRail();
    } else {
      setRailMsg(`显示浏览器失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`);
    }
  } catch (e) {
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

// ── 「全部启动」：主进程按有界启动排队接收；环境数量本身不受限制 ──
async function doStartAll() {
  const api = window.aidcpEdge.fleetStartAll;
  if (typeof api !== 'function') return;
  const envIds = filteredRailEnvList().map((env) => env.envId);
  if (envIds.length === 0) {
    setRailMsg('当前分类没有可启动的环境。');
    return;
  }
  const res = await api({ envIds });
  if (res && res.ok) {
    if (res.queued > 0 && Array.isArray(res.envIds)) {
      fleetView.startAll = {
        ids: res.envIds,
        total: res.queued,
        rejected: Number(res.rejected) || 0,
        queueLimit: Number(res.queueLimit) || 0,
      };
      updateStartAllProgress();
    } else if (res.queued > 0) {
      setRailMsg(`已错峰排队启动 ${res.queued} 个环境（相邻间隔约 1.1s）。`); // 旧主进程无 envIds 时兜底
    } else if (Number(res.rejected) > 0) {
      setRailMsg(`启动排队已满，本次有 ${res.rejected} 个环境未加入（排队上限 ${res.queueLimit}）。`);
    } else {
      setRailMsg('没有待启动的环境。');
    }
  }
}

// 「全部启动」实时进度（如实呈现 k/N，不是一句静态提示）：随各环境状态推送重算已起数，全起后收尾。
// 精确「下一个 Ns 后」倒计时依赖错峰队列时序（未透传渲染层），当前以每行「第 N 位」传达顺序。
function updateStartAllProgress() {
  const sa = fleetView.startAll;
  if (!sa) return;
  const launched = sa.ids.filter((id) => {
    const e = fleetView.envs.get(id);
    return e && e.status && e.status.edge === 'running';
  }).length;
  if (launched >= sa.total) {
    setRailMsg(sa.rejected > 0
      ? `已启动 ${sa.total} 个；另 ${sa.rejected} 个因启动排队已满未加入，可稍后重试。`
      : `已全部启动（${sa.total}/${sa.total}）。`);
    fleetView.startAll = null;
    return;
  }
  setRailMsg(`启动中 ${launched}/${sa.total} · 其余 ${sa.total - launched} 个错峰排队${sa.rejected > 0 ? ` · ${sa.rejected} 个未加入` : ''}…`);
}
fields.railStartAll?.addEventListener('click', () => { void doStartAll(); });

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
  const displayName = target.name || `环境 …${String(target.envId).slice(-4)}`;
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
    setGuideHint(`「${env.name || env.envId}」已恢复（${lv.label}），前进到下一个。`);
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
  setGuideHint(r && r.ok ? (r.hint || '已请求把该环境的浏览器窗口前置。') : `打开窗口失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`);
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

// dirty 且核心在跑（非停止/异常）时才显示「按新设置重启」——把已改设置显式应用到在跑核心。
function updateApplyRestart() {
  const running = Boolean(currentStatus) && currentStatus.edge !== 'stopped' && currentStatus.edge !== 'warning';
  settingsUi.applyRestart.classList.toggle('hidden', !(dirty && running));
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
  settingsUi.msg.textContent = '请先在左栏「＋ 添加环境」加入至少一个环境。';
  setRailMsg('请先「＋ 添加环境」加入至少一个环境。');
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
  if (key === 'custom' && !isWsUrl(custom)) {
    settingsUi.cloudEnvHint.textContent = '自定义地址需以 ws:// 或 wss:// 开头。';
    return { ok: false };
  }
  const saved = await window.aidcpEdge.saveSettings({ cloudEnvKey: key, cloudUrlCustom: custom });
  // 主进程归一化可能把非法 custom 降级为 ''（未选择）；以回执为准回填。
  cloudSelKey = (saved && typeof saved.cloudEnvKey === 'string') ? saved.cloudEnvKey : key;
  if (saved && saved.cloudEnv) targetCloud = saved.cloudEnv;
  applyCloudSelectionUi();
  updateCloudPending();
  return saved;
}
// 选择某云端：ol 需二次确认；确认/落盘成功后提示需重启在跑环境生效。
async function selectCloudEnv(key) {
  if (key === 'ol' && cloudSelKey !== 'ol') {
    if (!window.confirm('将连接线上生产云端 ol，确认切换？\n（切换后需重启运行中的环境才生效）')) return;
  }
  cloudSelKey = key;
  applyCloudSelectionUi();
  if (key === 'custom') {
    // 等用户填地址再落盘：仅展开输入框、聚焦；不立即保存空地址。
    settingsUi.cloudUrlCustom.focus();
    settingsUi.cloudEnvHint.textContent = '填写 ws:// 或 wss:// 地址后自动保存。';
    if (!isWsUrl(settingsUi.cloudUrlCustom.value)) { updateCloudPending(); return; }
  }
  const saved = await persistCloudSelection();
  if (saved && saved.ok !== false) {
    settingsUi.cloudEnvHint.textContent = `云端已切到「${targetCloud.label}」，需重启运行中的环境才生效。`;
  }
}
// 依「运行中环境实际连接的云端」与「目标云端」比对，刷新 chip / 当前连接 / 待重启按钮。
// 红线：显示=实际连接；已切未重启显示为「待重启生效」，绝不显示成已生效。
function updateCloudPending() {
  const target = targetCloud || { key: '', label: '默认' };
  const running = [...fleetView.envs.values()].filter(
    (e) => e.status && (e.status.edge === 'running' || e.status.edge === 'starting') && e.status.connectedCloudKey,
  );
  const pending = running.some((e) => e.status.connectedCloudKey !== target.key);
  // 当前实际连接：有在跑环境取其一的 live key；否则显示目标（下次启动将用）。
  const liveKey = running.length ? running[0].status.connectedCloudKey : target.key;
  if (settingsUi.cloudEnvCurrent) {
    settingsUi.cloudEnvCurrent.textContent = pending
      ? `${CLOUD_ENV_LABELS[liveKey] || liveKey || '默认'} → 目标 ${target.label}（待重启生效）`
      : (CLOUD_ENV_LABELS[liveKey] || target.label || '默认');
    settingsUi.cloudEnvCurrent.classList.toggle('ol', (pending ? liveKey : target.key) === 'ol');
  }
  if (settingsUi.cloudRestartAll) settingsUi.cloudRestartAll.classList.toggle('hidden', !pending);
  // 标题带 chip：运行中显示 live、否则显示目标；待重启加后缀与 pending 态；ol 醒目色。
  if (fields.cloudEnvChipLabel) {
    fields.cloudEnvChipLabel.textContent = pending
      ? `云端 ${CLOUD_ENV_LABELS[liveKey] || '默认'}·待重启`
      : `云端 ${CLOUD_ENV_LABELS[liveKey] || target.label || '默认'}`;
  }
  if (fields.cloudEnvChip) {
    fields.cloudEnvChip.classList.toggle('ol', (pending ? liveKey : target.key) === 'ol');
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
  // 浏览器并发（change browser-slot-scheduling）：0 = 自动 → 输入框留空，让占位文案说清自动是怎么算的。
  if (settingsUi.slotLimit) settingsUi.slotLimit.value = Number(s.browserSlotLimit) > 0 ? String(s.browserSlotLimit) : '';
  if (settingsUi.maxQueuedStartLimit) settingsUi.maxQueuedStartLimit.value = Number(s.maxQueuedStartLimit) > 0 ? String(s.maxQueuedStartLimit) : '';
  applySlotsView(s.slots);
  updateProfileDisplay();
  // 云端环境（change edge-cloud-env-selector）：回填已选 key、自定义地址、目标云端视图。
  cloudSelKey = typeof s.cloudEnvKey === 'string' ? s.cloudEnvKey : '';
  settingsUi.cloudUrlCustom.value = s.cloudUrlCustom || '';
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
      settingsUi.cloudEnvHint.textContent = `云端已切到「${targetCloud.label}」，需重启运行中的环境才生效。`;
    }
  });
});
// 「全部重启并连接新云端」：有序重启全部在跑环境，使其按新选择重连。
settingsUi.cloudRestartAll.addEventListener('click', async () => {
  settingsUi.cloudRestartAll.disabled = true;
  try {
    const r = await window.aidcpEdge.cloudRestartAll?.();
    settingsUi.cloudEnvHint.textContent = r && r.ok
      ? `已请求重启 ${r.restarted} 个环境并连接「${(r.cloudEnv && r.cloudEnv.label) || targetCloud.label}」…`
      : '重启请求失败，请重试。';
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
  if (rosterHas(id)) { setEnvMsg(`「${id}」已在运行花名册中。`, false); return; }
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
    // 诚实边界：外壳只能「尽力抬前」，成功回执带窗口所在提示（r.hint），绝不宣称已抬到最前。
    settingsUi.msg.textContent = r && r.ok ? (r.hint || `${label}指令已发送。`) : `${label}失败：${(r && r.error) || '引擎未运行或浏览器尚未就绪'}`;
  } catch (e) {
    settingsUi.msg.textContent = `${label}失败：${(e && e.message) || e}`;
  }
}
settingsUi.browserShow.addEventListener('click', () => runBrowserRecovery('show'));
settingsUi.browserResetParking.addEventListener('click', () => runBrowserRecovery('reset'));
settingsUi.browserColdStandby?.addEventListener('change', markDirty);

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
      refreshEnvs(); // 就绪即自动列出环境，无需先点刷新
    } else {
      setEnvMsg(
        `暂未连接到本地指纹浏览器服务${r && r.error ? '（' + r.error + '）' : ''}。启动后应用会自动拉起内置运行时；也可在「高级设置」打开「手动填写」直接填分身 ID。`,
        true,
      );
      openAdvanced();
    }
  } catch {
    setEnvMsg('检测本地指纹浏览器服务失败。', true);
  }
}

// 选中某环境：把其 user_id（非 serial_number）设为将写入的分身 ID，并高亮该行；顺手记环境名作账号标签
// 与该环境的平台（platform，来自其 remark；同步进 settings 供启动注入 AIDCP_PLATFORM）。
// 多环境（edge-multi-environment-fleet）：选中即**加入运行花名册**（多选累积）；已在花名册的成员
// 再点只切换当前值、诚实提示已加入，MUST NOT 重复出现两次（防 edgeId 撞车）。
function selectProfile(userId, itemEl, profileName, platform) {
  settingsUi.adsProfile.value = userId;
  selectedProfileName = profileName || '';
  selectedPlatform = normPlatform(platform);
  let added = false;
  if (userId && !rosterHas(userId)) {
    roster.push({ profileId: userId, name: profileName || '', platform: normPlatform(platform) });
    if (lastAssignmentScoped) clientRosterExcludedEnvIds.delete(userId);
    added = true;
  } else if (userId) {
    setEnvMsg(`「${profileName || userId}」已在运行花名册中。`, false);
  }
  updateProfileDisplay();
  settingsUi.adsEnvList.querySelectorAll('.ads-env-item').forEach((el) => el.classList.remove('selected'));
  if (itemEl) itemEl.classList.add('selected');
  refreshRosterMarks();
  // 加入即落盘（根治「加入后左栏不显示」）：main 据此 syncEnvHandles + 广播花名册 → 左栏立刻出现该环境的离线行。
  if (added) {
    setEnvMsg(`已加入「${profileName || userId}」，在左栏可见并可启动。`, false);
    const persisted = persistRoster();
    void persisted.then((saved) => {
      if (saved && saved.saveOk === false) {
        setEnvMsg(`已移入「${profileName || userId}」（本次生效），但写盘失败：${saved.saveError || '未知错误'}。重启后可能丢失。`, true);
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
  if (remember) setEnvMsg('已移出运行环境；归属不变，可随时再次点选移入。', false);
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
  const environments = roster.map((m) => ({ profileId: m.profileId, name: m.name, platform: m.platform }));
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
// 杜绝与 pruneOrphanRoster 的双落盘竞态）。名字为纯展示字段，无「人工标注优先」问题（对比 platform）。
// **缺数据不自残**：本函数只在 refreshEnvs 的 `!r.truncated` 守卫下调用，空实时名从不回填（不因缺数据误清 / 误改）。
function reconcileRosterNames(profiles) {
  const liveName = new Map();
  for (const p of profiles || []) {
    if (p && p.userId && p.name) liveName.set(String(p.userId), p.name);
  }
  if (liveName.size === 0) return 0; // 二道防御：一个带名环境都没取到时绝不回填（同 pruneOrphanRoster 的空列表守卫）
  let changed = 0;
  for (const m of roster) {
    const live = liveName.get(String(m.profileId));
    if (live && live !== m.name) { m.name = live; changed += 1; }
  }
  if (changed > 0) {
    // 当前选中分身的名字同步更新，保持旧单值镜像 adsProfileName 与花名册一致（saveCurrentSettings 会写该镜像）。
    const selLive = liveName.get(settingsUi.adsProfile.value.trim());
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

// 每行删除按钮：点两次确认（第一次「删」→「确认删除?」armed 态，4s 自动收回；第二次才真删）。
// 删除不可恢复（若已登录账号其登录态一并丢失）——故绝不一次点就删、绝不自动/批量（C3 放宽为 UI 确认删）。
function makeDeleteBtn(prof) {
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
        ? `继续核对「${prof.name || prof.userId}」的 Edge 清密文结果；Cloud 确认前不会物理删除`
        : `永久删除「${prof.name || prof.userId}」，不可恢复；视频号环境会先撤权并清除 Edge 登录密文`;
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    if (!window.aidcpEdge || typeof window.aidcpEdge.adsDeleteEnv !== 'function') return;
    btn.disabled = true;
    setEnvMsg(`正在删除「${prof.name || prof.userId}」…`, false);
    try {
      const r = await window.aidcpEdge.adsDeleteEnv({ ...formAdsOpts(), userId: prof.userId });
      if (r && r.ok && r.cleanupPending) {
        setEnvMsg(r.message || `已撤销「${prof.name || prof.userId}」的访问，等待设备确认清理。`, false);
        btn.disabled = false;
        await refreshEnvs({ suppressAutoJoin: true });
      } else if (r && r.ok) {
        setEnvMsg(`已删除环境「${prof.name || prof.userId}」。`, false);
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
  const list = settingsUi.adsEnvList;
  const current = settingsUi.adsProfile.value.trim();
  list.innerHTML = '';
  if (!profiles.length) {
    const empty = document.createElement('p');
    empty.className = 'ads-env-empty';
    empty.textContent = '（未找到环境，可在「高级设置」打开「手动填写」填分身 ID）';
    list.appendChild(empty);
    return { autoSelected: null };
  }
  let firstItem = null;
  let currentSelected = null;
  for (const prof of profiles) {
    // 平台显示优先级：花名册成员的人工标注（settings 持久化）> 列表推断（remark 权威 / 兜底信号）。
    const member = roster.find((m) => m.profileId === prof.userId);
    const displayPlat = normPlatform(member ? member.platform : prof.platform);
    const inferred = !member && prof.platformSource && prof.platformSource !== 'remark';
    const item = document.createElement('div');
    item.className = 'ads-env-item';
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
    name.appendChild(document.createTextNode(prof.name || '(未命名)'));
    const meta = document.createElement('div');
    meta.className = 'env-meta';
    const bits = [];
    if (prof.serialNumber) bits.push('#' + prof.serialNumber);
    if (prof.groupName) bits.push(prof.groupName);
    bits.push(prof.proxy || '无代理配置');
    bits.push(prof.userId);
    meta.textContent = bits.join(' · ');
    text.appendChild(name);
    text.appendChild(meta);
    item.appendChild(text);
    if (prof.offboardPending) {
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
      removeBtn.title = '从运行花名册移出（不删除环境本身）';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromRoster(prof.userId);
      });
      item.appendChild(removeBtn);
    }
    if (!prof.offboardPending) item.appendChild(makePlatformBtn(prof, displayPlat));
    if (!prof.offboardPending) item.appendChild(makeProxyBtn(prof));
    item.appendChild(makeDeleteBtn(prof));
    if (!prof.offboardPending) {
      item.addEventListener('click', () => { void selectProfile(prof.userId, item, prof.name, member ? member.platform : prof.platform); });
    }
    if (prof.userId && prof.userId === current) {
      item.classList.add('selected');
      currentSelected = prof.name || prof.userId;
    }
    if (!firstItem) firstItem = item;
    list.appendChild(item);
  }
  // 唯一环境自动加入（首次列出的便利）：仅当调用方 allowAutoJoin 放行。删除/剔孤儿后触发的刷新绝不放行，
  // 否则会把一个无关的剩余环境静默拉进运行队列（评审 Finding 1 回归）。
  if (!lastAssignmentScoped && allowAutoJoin && profiles.length === 1 && !profiles[0].offboardPending
    && !current && roster.length === 0 && profiles[0].userId && !coreRunning()) {
    void selectProfile(profiles[0].userId, firstItem, profiles[0].name, profiles[0].platform);
    return { autoSelected: profiles[0].name || profiles[0].userId };
  }
  return { autoSelected: null, currentSelected };
}

// 显式改平台入口（edge-client-proxy-platform-persona-ux）：纠正无 remark 标注环境的误推断。
// 人工选择写进花名册成员（settings 持久化）并覆盖推断；remark 有标注的环境同样可覆盖显示/启动平台
// （启动注入以 settings 花名册为准）。非成员先就地改显示，加入花名册时随之持久化。
function makePlatformBtn(prof, displayPlat) {
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
    setEnvMsg(`已把「${prof.name || prof.userId}」标为 ${platformLabel(next)}${member ? '（已保存，下次启动生效）' : '（加入花名册后随启动生效）'}。`, false);
  });
  return btn;
}

// 每行「代理」编辑入口：读回非密字段预填，保存经受限 user/update 下发（详见 openProxyPop）。
function makeProxyBtn(prof) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ads-env-proxy';
  btn.textContent = '代理';
  btn.title = `查看 / 修改该环境的代理（当前：${prof.proxy || '无代理配置'}）`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // 不触发行选中
    openProxyPop(prof);
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
      setEnvMsg(`拉取环境失败${r && r.error ? '（' + r.error + '）' : ''}${authHint}。可在「高级设置」打开「手动填写」填分身 ID。`, true);
      openAdvanced();
      return;
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
        ? `已默认移入 ${assigned.added.length} 个归属环境（本次展示、未自动启动），但写盘失败：${saved.saveError || '未知错误'}。`
        : `已默认移入 ${assigned.added.length} 个归属环境（仅展示，未自动启动）。`
      : autoSelected
        ? `已自动加入唯一环境「${autoSelected}」。`
      : currentSelected
        ? `已选中「${currentSelected}」。`
        : lastAssignmentScoped
          ? '已手动移出的归属环境可再次点选移入。'
          : '点选环境即加入运行花名册（可多选并行运行）。';
    setEnvMsg(`已加载 ${profiles.length} 个环境${extra}。${cleaned}${autoHint}`, false);
  } catch (e) {
    setEnvMsg(`拉取环境失败（${e && e.message ? e.message : e}）。可在「高级设置」打开「手动填写」填分身 ID。`, true);
    openAdvanced();
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
  updateFacebookImportVisibility();
}
settingsUi.adsProxyType?.addEventListener('change', () => {
  updateFacebookImportVisibility();
});

// 「创建环境」程序化建号：单建挑 OS family；Facebook 批量由主进程逐账号随机 OS family、代理按行轮询。
settingsUi.adsCreate.addEventListener('click', async () => {
  const platform = normPlatform(settingsUi.adsPlatform && settingsUi.adsPlatform.value);
  const batch = platform === 'facebook'
    && settingsUi.adsFbCreateMode
    && settingsUi.adsFbCreateMode.value === 'batch';
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
  settingsUi.adsCreate.disabled = true;
  const batchCount = facebookAccountImport.split(/\r?\n/).filter((line) => line.trim()).length;
  setCreateMsg(batch ? `正在批量创建 ${batchCount} 个环境，请勿关闭客户端…` : '正在创建环境…', false);
  try {
    const payload = batch
      ? {
          ...formAdsOpts(),
          creationMode: 'batch',
          osFamilyKey: '',
          platform,
          batchProxyType: proxyType,
          facebookAccountImport,
          facebookProxyBatch,
        }
      : {
          ...formAdsOpts(),
          creationMode: 'single',
          osFamilyKey,
          platform,
          proxy,
          facebookAccountImport,
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
      const selectedHint = r.rosterJoinedByMain
        ? '已分配到当前账号并加入运行环境；需要启动时请在环境栏操作。'
        : r.requiresAdminAssignment
        ? '管理员分配前不会加入运行花名册。'
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
      const slowStartHint = r.slowStartConfigured === true
        ? 'Facebook 环境已默认开启慢启动（只收紧每日操作额度，不改变操作速度）。'
        : '';
      const visibilityHint = r.visibilityWarning ? r.visibilityWarning : '';
      setCreateMsg(`${countHint}${selectedHint}${proxyHint}${slowStartHint}${visibilityHint}`, Boolean(r.visibilityWarning));
      resetCreateProxyForm();
      await refreshEnvs();
    } else {
      const extra = r && r.violations && r.violations.length ? '（' + r.violations.join('；') + '）' : '';
      const createdCount = Number(r && (r.createdCount || (Array.isArray(r.created) ? r.created.length : 0)) || 0);
      const prefix = createdCount > 0 ? '批量创建未完成' : '创建失败';
      setCreateMsg(`${prefix}：${(r && r.error) || '未知错误'}${extra}。`, true);
      if (createdCount > 0) await refreshEnvs();
    }
  } finally {
    settingsUi.adsCreate.disabled = false;
  }
});

// ── 环境代理编辑浮层：预填非密字段（list 不回传密码），保存 = 整体替换、下次启动生效 ──
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
function openProxyPop(prof) {
  if (!fields.proxyPop) return;
  proxyPopTarget = { userId: prof.userId, name: prof.name || prof.userId };
  if (fields.proxyPopEnv) fields.proxyPopEnv.textContent = `· ${proxyPopTarget.name}`;
  // 当前配置如实呈现（含 UI 下拉表达不了的代理厂商类型——保存会整体替换，这行让用户知道在替换什么）。
  if (fields.proxyPopCurrent) fields.proxyPopCurrent.textContent = `当前：${prof.proxy || '无代理配置'}`;
  const cfg = prof.proxyConfig || {};
  if (fields.proxyPopType) {
    fields.proxyPopType.value = !cfg.noProxy && PROXY_TYPE_OPTIONS.has(cfg.proxyType) ? cfg.proxyType : 'no_proxy';
  }
  if (fields.proxyPopHost) fields.proxyPopHost.value = cfg.noProxy ? '' : (cfg.proxyHost || '');
  if (fields.proxyPopPort) fields.proxyPopPort.value = cfg.noProxy ? '' : (cfg.proxyPort || '');
  if (fields.proxyPopUser) fields.proxyPopUser.value = cfg.noProxy ? '' : (cfg.proxyUser || '');
  if (fields.proxyPopPass) fields.proxyPopPass.value = ''; // 密码绝不回显
  syncProxyPopDetail();
  setProxyPopMsg('', false);
  fields.proxyPop.classList.remove('hidden');
  fields.proxyPop.classList.add('open');
  fields.proxyPop.setAttribute('aria-hidden', 'false');
  fields.proxyMask?.classList.remove('hidden');
}
function closeProxyPop() {
  if (!fields.proxyPop) return;
  proxyPopTarget = null;
  fields.proxyPop.classList.remove('open');
  fields.proxyPop.classList.add('hidden');
  fields.proxyPop.setAttribute('aria-hidden', 'true');
  fields.proxyMask?.classList.add('hidden');
}
fields.proxyClose?.addEventListener('click', closeProxyPop);
fields.proxyMask?.addEventListener('click', closeProxyPop);
fields.proxyPopType?.addEventListener('change', syncProxyPopDetail);
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
      setEnvMsg(`已更新「${proxyPopTarget.name}」的代理（${proxy.proxyType === 'no_proxy' ? '已清除代理' : proxy.proxyType}），下次启动该环境生效。`, false);
      closeProxyPop();
      refreshEnvs();
    } else {
      setProxyPopMsg(`保存失败：${(r && r.error) || '未知错误'}`, true);
    }
  } catch (e) {
    setProxyPopMsg(`保存失败：${(e && e.message) || e}`, true);
  } finally {
    if (fields.proxySave) fields.proxySave.disabled = false;
  }
});

// 「按新设置重启」：先保存当前设置，再显式重启把改动应用到在跑核心（dirty && 在跑时才出现）。
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
    // 恢复 = 重启核心。若暂停期间改过浏览器设置（如切换了环境），先落盘再重启，否则会按旧设置重起。
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
      : '设置已保存，正在启动…';
    return window.aidcpEdge.start(envId);
  }
  if (action === 'pause') return window.aidcpEdge.pause(envId);
  if (action === 'close') return window.aidcpEdge.close(envId);
  return null;
}

// 今日进展会话按钮：三态触发 恢复 / 启动（=先保存再启动） / 暂停。无独立「保存」按钮。
fields.sessionFab.addEventListener('click', async () => {
  const action = fields.sessionFab.dataset.action;
  fields.sessionFab.disabled = true;
  try {
    const next = await runSessionLifecycle(action, currentEnvId());
    if (next) routeStatus(next);
  } finally {
    fields.sessionFab.disabled = false;
  }
});

fields.sessionClose?.addEventListener('click', async () => {
  fields.sessionClose.disabled = true;
  fields.sessionFab.disabled = true;
  try {
    const next = await window.aidcpEdge.close(currentEnvId());
    if (next) routeStatus(next);
  } finally {
    fields.sessionClose.disabled = false;
    fields.sessionFab.disabled = false;
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
  update: document.querySelector('#persona-update'),
  wizardBody: document.querySelector('#persona-wizard-body'),
  kwGroups: Array.from(document.querySelectorAll('.persona-kw-group')),
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
  contentCount: document.querySelector('#persona-content-count'),
};
let personaReady = false; // 已登录 + 云端已连接才可生成
let personaDraftYaml = ''; // 当前草稿 soulYaml（确认时提交）
let personaLocallyBound = false; // 本会话确认成功后即视为已绑（personaBound 信号要等下次 hello 才到）
let personaDraftEnvId; // 草稿所属环境（多环境：persist MUST 打回生成时那个账号，不随后续切换环境漂移）
let personaStage = 'pick'; // 两步向导阶段：pick（选关键词）| preview（预览确认）
let personaInFlight = false; // 生成请求在途（骨架 + 按钮禁用 + 遮罩误点不关层）
let personaGrowthEnvId = null; // 本次刚确认成功的人设所属环境；只让该环境出现一次成长引导
let personaPersistPendingEnvId = null; // persist IPC 收敛中的环境；main 可能先推 personaBound=true，期间不得把自动弹窗收走
let personaUpdateMode = false; // 已绑账号手动进入更新流程：生成新草稿，确认后覆盖当前人设
const personaPrompted = new Set();
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
let personaPopOpenReason = null; // manual | auto：只自动收起「系统误弹」的窗，不动用户手动打开的
let personaPopOpenEnvId = null;

// 底部操作栏按阶段/形态切换主 CTA：向导态 pick=「生成人设」、preview=「重新生成 + 确认使用」；
// 空态/已绑态收起全部按钮（空态面板自带「去启动」）。
function syncPersonaFoot(mode) {
  const wizard = mode === 'wizard';
  const growth = mode === 'growth';
  const inPick = personaStage === 'pick';
  // 更新流程复用同一套向导按钮，只改文案：让「这次是覆盖已有人设」在按钮上就看得见。
  if (personaUi.generate) personaUi.generate.textContent = personaUpdateMode ? '生成新草稿' : '生成人设';
  if (personaUi.confirm) personaUi.confirm.textContent = personaUpdateMode ? '确认更新' : '确认使用';
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

// 空态「去启动 / 打开浏览器窗口」：复用既有 FAB 三态与浏览器前置流程，不新增 IPC。
personaUi.emptyAction?.addEventListener('click', () => {
  closePersonaPop(true);
  const action = fields.sessionFab && fields.sessionFab.dataset.action;
  if (action === 'start' || action === 'resume') fields.sessionFab.click();
  else window.aidcpEdge.showDrivenBrowser?.(currentEnvId()); // 已在运行（等登录）：抬浏览器窗口去登录
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
  edge_not_running: '引擎未运行，请先启动。',
  edge_request_timeout: '生成超时，请重试。',
  edge_request_failed: '与云端通信失败，请检查连接后重试。',
  unavailable: '云端暂不支持人设生成，请稍后再试。',
  unknown_account: '账号身份未就绪，请确认已扫码登录。',
};
const PERSONA_PERSIST_FAIL = {
  unknown_account: '账号身份未就绪（云端未建号），请稍后重试。',
  persona_required: '人设为空，无法保存。',
  persona_invalid: '人设格式无效，请重新生成。',
  edge_request_failed: '与云端通信失败，请重试。',
  edge_request_timeout: '保存超时，请重试。',
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
  const key = personaPromptKey(status);
  if (personaPrompted.has(key)) return;
  personaPrompted.add(key);
  const envId = currentEnvId();
  const env = fleetView.envs.get(envId);
  const label = (env && (env.name || (env.status && env.status.account && env.status.account.name))) || '当前账号';
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

const PERSONA_LIKE_AFFINITIES = {
  normal: { label: '正常', token: 'like_affinity:normal' },
  like_more: { label: '喜欢', token: 'like_affinity:like_more' },
  like_most: { label: '更喜欢', token: 'like_affinity:like_most' },
};

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
  const env = fleetView.envs.get(currentEnvId());
  updatePersonaGate((env && env.status) || currentStatus || null);
  setPersonaMsg('重新选择偏好并生成新草稿；确认后会覆盖当前人设。', false);
}
personaUi.update?.addEventListener('click', beginPersonaUpdate);

// onboarding 三态（change persona-wizard-onboarding-fixes）：已绑→已设置跳过 / 未绑未连→空态面板 / 未绑已连→启用向导。
// 只改 disabled/显隐/面板文案，绝不触碰已选关键词与草稿（状态推送不重置向导进度）。
function updatePersonaGate(status) {
  const loggedIn = Boolean(status && status.auth === 'logged in');
  const connected = Boolean(status && status.cloud === 'connected');
  personaReady = loggedIn && connected;

  // 绑定态三态（change persona-bound-tristate）：true=云端确认已绑 / false=云端确认未绑 / 未知=还没收到。
  // known 必须同时要求「已连云」和「权威信号已到」——只要信号没到，一律按未知处理（宁缺毋假）。
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
  // 本会话刚生成的「待确认」草稿态不被状态推送覆盖。
  if (!bound && personaUi.stateBadge && personaUi.stateBadge.textContent !== '待确认') {
    setPersonaBadge(knownUnbound ? '未设置' : '待启动', 'checking');
  }

  // ② 闸未就绪（未登录 / 未连云 / 权威信号还没到）：空态面板，绝不弹窗。
  if (!known) {
    const running = Boolean(status && (status.edge === 'running' || status.edge === 'starting'));
    if (personaUi.emptyTitle) personaUi.emptyTitle.textContent = loggedIn ? '正在连接云端…' : '先启动并登录这个账号';
    if (personaUi.emptySub) {
      personaUi.emptySub.textContent = loggedIn
        ? '连上云端后会显示该账号的人设状态，未设置可在此生成。'
        : running
          ? '环境已在运行：请在它的浏览器窗口里完成登录，登录后这里就能生成人设。'
          : '启动该环境并在浏览器里登录后，这里就能为它生成人设。';
    }
    if (personaUi.emptyAction) {
      personaUi.emptyAction.classList.toggle('hidden', loggedIn); // 连云中无需动作
      personaUi.emptyAction.textContent = running ? '打开浏览器窗口' : '去启动';
    }
    syncPersonaFoot('hidden');
    return;
  }

  // ③ 云端权威确认未绑（或已绑但手动进入更新）：向导可用；确认时复用同一条 persist 路径覆盖。
  if (personaUi.generate) personaUi.generate.disabled = personaInFlight || !personaReady;
  if (personaUi.hint) {
    personaUi.hint.textContent = updatingBound
      ? '重新选择偏好并生成新草稿，确认后会覆盖当前账号的人设；生成失败不会影响现有人设。'
      : '设置语气、点赞倾向和内容偏好，自动生成这个账号的人设；确认后账号才会开始自动运营。';
  }
  syncPersonaFoot('wizard');
  // 自动弹窗只对「云端权威说未绑」的账号；已绑账号手动进入更新时绝不再弹、也绝不发未设置通知。
  if (!bound) maybePromptPersonaSetup(status);
}

// 关键词 toggle：单选组互斥、多选组可叠加；同步 aria-pressed 与「已选 n」计数。
function syncKwGroupState(group) {
  group.querySelectorAll('.kw-btn').forEach((b) => b.setAttribute('aria-pressed', b.classList.contains('active') ? 'true' : 'false'));
  if (personaUi.contentCount) {
    const n = personaUi.kwGroups
      .filter((g) => g.dataset.dim === 'content')
      .reduce((sum, g) => sum + g.querySelectorAll('.kw-btn.active').length, 0);
    personaUi.contentCount.textContent = n ? `已选 ${n}` : '';
  }
}
personaUi.kwGroups.forEach((group) => {
  const single = group.dataset.select === 'single';
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.kw-btn');
    if (!btn || !group.contains(btn)) return;
    if (single) {
      group.querySelectorAll('.kw-btn').forEach((b) => b.classList.toggle('active', b === btn));
    } else {
      btn.classList.toggle('active');
    }
    syncKwGroupState(group);
  });
  syncKwGroupState(group);
});

function addCustomPreference(group, value) {
  const name = (value || '').trim();
  if (!name) return;
  const normalized = name.slice(0, 40);
  const existing = Array.from(group.querySelectorAll('.kw-btn')).find((b) => b.dataset.kw === normalized);
  if (existing) {
    existing.classList.add('active');
    syncKwGroupState(group);
    return;
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
  syncKwGroupState(group);
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
    addCustomPreference(group, input.value);
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
  if (!personaReady) return setPersonaMsg('请先启动该环境并在浏览器里登录', true);
  const keywordSelections = collectPersonaKeywords();
  if (!keywordSelections.length) return setPersonaMsg('请先选择关键词', true);
  const likeAffinity = collectPersonaLikeAffinity();
  const requestSelections = [...keywordSelections, likeAffinity.token];
  if (!window.aidcpEdge || typeof window.aidcpEdge.personaGenerate !== 'function') return;
  personaInFlight = true;
  // 预先切到预览页：让「结果会出现在哪」提前可见，生成中该处呈现骨架。
  updateKwSummary([...keywordSelections, `点赞倾向：${likeAffinity.label}`]);
  setPersonaStage('preview');
  personaUi.skeleton?.classList.remove('hidden');
  personaUi.draft?.classList.add('hidden');
  personaUi.generate.disabled = true;
  if (personaUi.regenerate) { personaUi.regenerate.disabled = true; personaUi.regenerate.textContent = '正在生成…'; }
  if (personaUi.confirm) personaUi.confirm.disabled = true;
  setPersonaMsg(personaUpdateMode ? '正在生成新人设…（可能需要十几秒）' : '正在生成人设…（可能需要十几秒）', false);
  const genEnvId = currentEnvId(); // 生成时锁定目标环境；persist 打回它，绝不随后续切换漂移
  try {
    const r = await window.aidcpEdge.personaGenerate(genEnvId, { keywordSelections: requestSelections, idempotencyKey: newIdempotencyKey() });
    if (r && r.ok && r.soulYaml) {
      personaDraftYaml = r.soulYaml;
      personaDraftEnvId = genEnvId;
      // 信息层级：identitySummary（给人看的人设）升为标题；原始 YAML 收进折叠。
      if (personaUi.draftSummary) personaUi.draftSummary.textContent = r.identitySummary || '已生成人设';
      if (personaUi.draftBody) personaUi.draftBody.textContent = r.soulYaml;
      personaUi.draft?.classList.remove('hidden');
      setPersonaBadge('待确认', 'warning');
      setPersonaMsg(
        personaUpdateMode
          ? '已生成新草稿，确认后会覆盖当前人设；不满意可「重新生成」。'
          : '已生成草稿，确认后即绑定；不满意可「重新生成」。',
        false,
      );
    } else {
      personaDraftYaml = '';
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
  if (!window.aidcpEdge || typeof window.aidcpEdge.personaPersist !== 'function') return;
  const wasUpdate = personaUpdateMode;
  const persistEnvId = personaDraftEnvId || currentEnvId() || '__local__';
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
      personaDraftYaml = '';
      personaUi.draft?.classList.add('hidden');
      personaUi.wizardBody?.classList.add('hidden');
      if (wasUpdate || r.firstPostOnboarding !== true) {
        // 更新既有人设：这个号本来就在跑，不该再出「开始运营」的成长引导——收回已设置绿卡即可。
        personaUi.boundNote?.classList.remove('hidden');
        syncPersonaFoot('hidden');
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
window.aidcpEdge.onFleetUpdate?.(applyFleetSnapshot);
window.aidcpEdge.getSettings().then((s) => {
  applySettings(s);
  // 面板加载时若为 AdsPower 模式即探一次并自动列环境（真实事件，低频；非「打开设置面板」）。
  if (selectedProvider() === 'adspower') probeAds();
});
window.aidcpEdge.getStatus().then(routeStatus);
if (typeof window.aidcpEdge.fleetGet === 'function') {
  window.aidcpEdge.fleetGet().then(applyFleetSnapshot).catch(() => undefined);
}
