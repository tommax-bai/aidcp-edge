const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, Notification, shell, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { hasXhsCookie, launchChrome } = require('./chrome-launcher.cjs');
const { createAdsLocalApi } = require('./ads-local-api.cjs');
const { createAdsWriteApi } = require('./ads-write-api.cjs');
const adsRuntime = require('./ads-runtime.cjs');
const adsFingerprint = require('./ads-fingerprint.cjs');
const { normalizePlatform } = require('./ads-create-flow.cjs');
const { normalizeProxyInput } = require('./ads-proxy-config.cjs');
const {
  ENV_GROUP_NAME,
  createEnvGroupResolver,
  createEnvironmentWithGroupRecovery,
} = require('./ads-create-env-service.cjs');
const {
  parseFacebookAccountImport,
  profileNameForFacebookImport,
} = require('./facebook-account-import.cjs');
const os = require('node:os');
const { createUiEventStream, mergeStats } = require('./ui-events.cjs');
const {
  DEFAULT_PARKING_MODE,
  normalizeParkingMode,
  computeBrowserParkingPlan,
  parkingEnv,
} = require('./browser-parking.cjs');
const fleet = require('./fleet.cjs');
const {
  browserPersonaNoticeForStatus,
  browserPersonaNoticeKey,
} = require('./persona-notice.cjs');

// 主进程侧 AdsPower 只读客户端（探测 + 环境列表 + 在跑分身对账）。单例持有本进程内**唯一**串行节流（1req/s）。
// 与核心子进程内的 AdsPowerProvider 节流各自独立（跨进程无法共享内存队列，见 ads-local-api.cjs 头注）。
const adsApi = createAdsLocalApi({});

let mainWindow;
let tray;
let loginPoller; // self（本机 Chrome）登录门专用；self 为单环境遗留路径，全局一份即可
// 建号自助人设 stdin/stdout 桥（change edge-persona-keyword-generation）：
// persona.generate/persist 带 correlation id 下发 core，core 经 [persona-reply] 行回执，按 id 命中 pending。
// pending 全局一份（id 全局唯一）；命令只写「当前选中环境」的子进程 stdin。
const personaPending = new Map(); // id -> { resolve, timer }
let personaSeq = 0;
let isQuitting = false;
// 优雅全停已完成、允许本次 quit 直落（before-quit 二次进入不再拦截）。
let quitFinal = false;
let quitStopAllInFlight = false;
// 运行时确保后解析出的 Local API base（非默认端口时覆盖 AIDCP_ADS_API_BASE 喂核心）；
// 这是主进程读写 + 全部核心子进程的**单一 base 权威**（P0-A：resolveAdsOpts 亦优先采用它，
// 杜绝「解析出非 50325 端口、主进程却仍发 50325」的串台）。未确保前保持 null，回落 settings.adsApiBase 或核心默认 50325。
let adsServiceBase = null;

// AdsPower 官方下载页（客户端「下载 AdsPower」按钮外链）。
const ADS_DOWNLOAD_URL = 'https://www.adspower.net/download';

// ── 边端日志落文件（排障用）──────────────────────────────────────────────
// 核心子进程 stdout/stderr 除了进 UI 活动流，再逐行 append 到 userData/logs/edge.log，
// 便于事后精确复盘。多环境下同一文件、每行带 [envId] 前缀（交织输出仍可按环境筛）。
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
function appendEdgeLog(envId, line, isError) {
  const s = ensureEdgeLogStream();
  if (!s) return;
  try {
    s.write(`${new Date().toISOString()} ${isError ? 'ERR' : '   '} [${envId}] ${line}\n`);
  } catch { /* ignore */ }
}

// 桌面客户端浏览器 provider 设置（持久化到 userData/settings.json）：
//  - provider='adspower'（默认）：核心进程经 AdsPower 本地 API 托管指纹浏览器；多环境（edge-multi-environment-fleet）
//    下以 environments 花名册（[{profileId,name,platform}]）声明并行环境，每环境一个受监督子进程。
//  - provider='self'：自起本机真实指纹 Chrome（等价旧桌面行为，固定 9222 + cookie 轮询登录门；单环境遗留路径）。
// 旧单值 adsProfileId/adsProfileName/platform 向后兼容加载为单元素花名册，并保持镜像回写（回滚兼容）。
// 敏感值（apiKey）只落本机 userData、随用户机器，不进仓库 / 不外发。
const DEFAULT_SETTINGS = {
  provider: 'adspower',
  environments: [],
  adsProfileId: '',
  adsApiKey: '',
  adsApiBase: '',
  adsProfileName: '',
  platform: 'xiaohongshu',
  // 浏览器窗口停放：默认主屏停放（窗口停在主屏可靠可见的背景位、不抢焦点，不用最小化/headless）。
  browserParkingMode: DEFAULT_PARKING_MODE,
  // 「开发者详情」（原始日志区）默认不展示，在设置抽屉里开关（客户版首屏零技术噪音）。
  devDetails: false,
  // 环境栏（fleet rail）收起态与上次选中环境（跨重启保留）。
  railCollapsed: true,
  selectedEnvId: '',
};
let settings = { ...DEFAULT_SETTINGS };

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    parsed = {};
  }
  settings = { ...DEFAULT_SETTINGS, ...parsed };
  if (settings.provider !== 'self' && settings.provider !== 'adspower') settings.provider = 'adspower';
  settings.browserParkingMode = normalizeParkingMode(settings.browserParkingMode);
  // 花名册迁移（向后兼容）：旧单值 adsProfileId → 单元素花名册；镜像回写旧字段（回滚兼容）。
  settings.environments = fleet.migrateEnvironments(parsed && typeof parsed === 'object' ? { ...parsed, environments: settings.environments } : settings);
  applyLegacyMirror();
  return settings;
}

// 把花名册首成员镜像回旧单值字段（回滚兼容）。**platform 只在 adspower 模式镜像**：self（本机 Chrome）
// 模式的 platform 是独立设置，绝不被 adspower 花名册的 environments[0]（可能是 facebook）污染而错注平台。
function applyLegacyMirror() {
  const mirror = fleet.legacyMirrorOf(settings.environments);
  settings.adsProfileId = mirror.adsProfileId;
  settings.adsProfileName = mirror.adsProfileName;
  if (settings.provider === 'adspower') settings.platform = mirror.platform;
}

// 返回 { ok, error }：写盘成功 ok=true；失败 ok=false 并带 error 文案。
// 红线（绝不静默假成功）：写盘失败时当次仍用内存设置继续跑，但 MUST 把「未持久化」如实回报给上层 / UI，
// 绝不谎报保存成功——否则用户以为已存、重启后配置丢失却毫无提示。
function saveSettings(patch) {
  const p = { ...(patch || {}) };
  // 花名册来源二选一：显式 environments 优先；否则旧 adsProfileId 补丁（旧渲染层/单环境语义）转单元素花名册。
  if (Array.isArray(p.environments)) {
    p.environments = fleet.normalizeEnvironments(p.environments);
  } else if (Object.prototype.hasOwnProperty.call(p, 'adsProfileId')) {
    const single = fleet.normalizeEnvironment({
      profileId: p.adsProfileId,
      name: p.adsProfileName !== undefined ? p.adsProfileName : settings.adsProfileName,
      platform: p.platform !== undefined ? p.platform : settings.platform,
    });
    p.environments = single ? [single] : [];
  }
  settings = { ...settings, ...p };
  if (settings.provider !== 'self' && settings.provider !== 'adspower') settings.provider = 'adspower';
  settings.browserParkingMode = normalizeParkingMode(settings.browserParkingMode);
  settings.environments = fleet.normalizeEnvironments(settings.environments);
  applyLegacyMirror();
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true };
  } catch (error) {
    console.error('[aidcp-edge] settings 写入失败:', error?.message);
    return { ok: false, error: error?.message || '未知错误' };
  }
}

function currentParkingPlan(mode = settings.browserParkingMode) {
  let displays = [];
  let primary;
  try {
    displays = screen.getAllDisplays();
    primary = screen.getPrimaryDisplay();
  } catch {
    displays = [];
    primary = null;
  }
  return computeBrowserParkingPlan(mode, displays, primary);
}

// 每环境停放注入：按环境在花名册中的序号做窗口错位（级联偏移），使多个 headful 窗口不完全叠死、
// 行↔窗口按加入顺序可对应（同名/同色受平台限制做不到，见「打开窗口」的诚实文案）。
const ENV_WINDOW_CASCADE_PX = 36;
function buildBrowserParkingEnv(cascadeIndex = 0) {
  const plan = currentParkingPlan();
  if (cascadeIndex > 0) {
    const dx = cascadeIndex * ENV_WINDOW_CASCADE_PX;
    plan.bounds = { ...plan.bounds, left: plan.bounds.left + dx, top: plan.bounds.top + dx };
    plan.launchPosition = { left: plan.launchPosition.left + dx, top: plan.launchPosition.top + dx };
    plan.visibleBounds = { ...plan.visibleBounds, left: plan.visibleBounds.left + dx, top: plan.visibleBounds.top + dx };
  }
  return parkingEnv(plan);
}

// self（本机 Chrome）遗留路径的 provider env（单环境）。'self' 在前、被 ...process.env 覆盖 →
// 外部显式设 AIDCP_BROWSER_PROVIDER 等仍是逃生阀、优先生效。
function buildSelfProviderEnv() {
  return {
    ...buildBrowserParkingEnv(0),
    AIDCP_BROWSER_PROVIDER: 'self',
    AIDCP_PLATFORM: normalizePlatform(settings.platform),
  };
}

// 随包内置的共享 AdsPower 凭据（数据文件 `ads-runtime.json`，可轮换、绝不硬编码进 .cjs）：
// 打包态从 process.resourcesPath 读，开发态从 appRoot/resources 读。缺失/损坏返回空串（诚实回落）。
let bakedAdsRuntimeConfigCache;
function resolveBakedAdsRuntimeConfig() {
  if (bakedAdsRuntimeConfigCache !== undefined) return bakedAdsRuntimeConfigCache;
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'ads-runtime.json') : null,
    path.join(app.getAppPath(), 'resources', 'ads-runtime.json'),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        bakedAdsRuntimeConfigCache = cfg && typeof cfg === 'object' ? cfg : {};
        return bakedAdsRuntimeConfigCache;
      }
    } catch {
      /* best-effort：坏文件当未配置，诚实回落到 settings/env/空 */
    }
  }
  bakedAdsRuntimeConfigCache = {};
  return bakedAdsRuntimeConfigCache;
}

// 单一 api-key 解析器（优先级：表单当前值 > 本机设置 > 环境变量 > 随包内置默认）。
// 空串表示彻底缺失——上游据此诚实报错，MUST NOT 静默假成功。
function resolveAdsApiKey(formKey) {
  const form = formKey && String(formKey).trim();
  if (form) return form;
  if (settings.adsApiKey) return settings.adsApiKey;
  if (process.env.AIDCP_ADS_API_KEY) return String(process.env.AIDCP_ADS_API_KEY);
  const baked = resolveBakedAdsRuntimeConfig().adsApiKey;
  return baked && String(baked).trim() ? String(baked).trim() : '';
}

// adspower 每环境通用注入（不含身份键；身份由 fleet.buildEnvSpawnEnv 注入并守闸）。
function buildAdsProviderEnv(handle) {
  const env = {
    ...buildBrowserParkingEnv(handle ? handle.cascadeIndex : 0),
  };
  const apiKey = resolveAdsApiKey('');
  if (apiKey) env.AIDCP_ADS_API_KEY = apiKey;
  if (adsServiceBase) env.AIDCP_ADS_API_BASE = adsServiceBase;
  else if (settings.adsApiBase) env.AIDCP_ADS_API_BASE = settings.adsApiBase;
  return env;
}

// 解析只读调用的 base/key：优先用渲染层传入的**当前表单值**（支持「新填 key 未保存即刷新」而不陷回环），
// 表单未带该字段才回落。base 优先级（P0-A）：表单 > 运行时解析出的 adsServiceBase > 持久化 settings > 核心默认。
// apiKey 走单一解析器（含随包内置默认），只用于本次请求头、不落日志 / 不写文件。
function resolveAdsOpts(formOpts) {
  const o = formOpts || {};
  const apiBase = (o.apiBase && String(o.apiBase).trim()) || adsServiceBase || settings.adsApiBase || undefined;
  const formKey = Object.prototype.hasOwnProperty.call(o, 'apiKey') ? String(o.apiKey).trim() : '';
  const apiKey = resolveAdsApiKey(formKey);
  const out = {};
  if (apiBase) out.apiBase = apiBase;
  if (apiKey) out.apiKey = apiKey;
  if (o.groupId) out.groupId = o.groupId;
  return out;
}

// 「打开 AdsPower 新建环境」best-effort：AdsPower 不公开直达其内部「新建浏览器」tab 的深链，
// 故只能尝试拉起 / 聚焦客户端；起不来（未装 / 应用名不符）诚实退回打开官方页面。面板另有引导文案。
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
  void shell.openExternal(ADS_DOWNLOAD_URL);
  return { launched: false };
}

// ── 多环境注册表（edge-multi-environment-fleet）──────────────────────────
// 每环境 = 一个 AdsPower 分身 = 一个受监督子进程 = 一条云端连接；envId=ads-<分身id>（唯一 + 稳定）。
// self（本机 Chrome）为单环境遗留路径，占一个 envId='self' 的 handle。

/** 单环境状态投影模板（形状与旧单环境 status 逐位一致，渲染层零迁移）。 */
function makeStatus(provider) {
  return {
    provider,
    cloud: 'disconnected',
    auth: 'checking',
    session: 'idle',
    stats: { views: 0, likes: 0, collects: 0, comments: 0, follows: 0, publishes: 0 },
    dailyUsage: null,
    risk: 'normal',
    edge: 'stopped',
    lastMessage: '边缘进程尚未运行。',
    edgeFailure: null,
    updatedAt: new Date().toISOString(),
    account: null,
    presence: { text: '等待启动…', at: new Date().toISOString() },
    publish: null,
    kernelPrep: null,
    lastPublish: null,
    // 多环境新增（旧渲染层忽略即可）：有界重起放弃终态 + 同账号铺多环境告警 + 阻断浮层待人工。
    respawnGaveUp: false,
    sameAccountWarning: null,
    // 核心遇登录/验证码/未知阻断弹窗、已本地暂停等待人工处理（红线：绝不呈现为在线健康）。
    // 由核心成对信号驱动：`检测到X弹窗，暂停操作`(置真) / `阻断弹窗已清除，恢复浏览`(置假)。
    overlayBlocked: false,
    // 已绑人设信号（change persona-wizard-onboarding-fixes）：云端仅在已绑时下发（sticky true），
    // 渲染层据此把徽标翻「已设置」并跳过向导。按环境隔离（账号级信号）。
    personaBound: false,
  };
}

/** envId -> EnvHandle。EnvHandle 持子进程句柄 + 冻结身份 + 状态投影 + 每环境解析器/意图标志/重起计数。 */
const envs = new Map();
let selectedEnvId = '';

function makeEnvHandle({ envId, kind, profileId, name, platform, cascadeIndex }) {
  return {
    envId,
    kind, // 'adspower' | 'self'
    profileId: profileId || '',
    name: name || '',
    platform: platform || 'xiaohongshu',
    cascadeIndex: cascadeIndex || 0,
    child: undefined,
    status: makeStatus(kind === 'self' ? 'self' : 'adspower'),
    // 每环境各一份日志→UI 事件解析器（交织 stdout 按 envId 归属，绝不串号）。
    uiEvents: createUiEventStream(),
    browserParkingReady: false,
    browserPersonaNoticeState: null,
    // 人设横幅判定宽限（同 renderer 弹窗宽限）：记下首次「登录+连云」时刻 + 到点复评定时器，
    // 避免刚连云、personaBound(sticky true) 尚未到达的空窗里误给已设置账号推横幅。
    personaNoticeReadySince: 0,
    personaNoticeTimer: null,
    restartPending: false,
    pausePending: false,
    coreParked: false,
    closePending: false,
    removed: false,
    // 排队启动期间被暂停/移出/退出的取消闸：queued start（尚无子进程、SIGTERM 无处可发）据此在
    // startEdge 处诚实放弃拉起，杜绝「暂停/退出被排队启动覆盖」与孤儿子进程。
    stopRequested: false,
    lastEdgeFailureLine: '',
    respawnStreak: 0,
    respawnTimer: null,
    gaveUp: false,
    spawnedAtMs: 0,
    browserAlreadyRunning: false,
  };
}

function selectedHandle() {
  return envs.get(selectedEnvId) || envs.values().next().value;
}

/** 依当前 settings 同步注册表：新增环境建 handle、被移出花名册的环境有序停止并摘除、序号重排。 */
function syncEnvHandles() {
  const wanted = new Map(); // envId -> spec
  if (settings.provider === 'self') {
    wanted.set('self', { envId: 'self', kind: 'self', profileId: '', name: '本机 Chrome', platform: settings.platform, cascadeIndex: 0 });
  } else {
    settings.environments.forEach((env, i) => {
      const envId = fleet.envIdForProfile(env.profileId);
      wanted.set(envId, { envId, kind: 'adspower', profileId: env.profileId, name: env.name, platform: env.platform, cascadeIndex: i });
    });
  }
  // 摘除不再需要的环境：在跑的先有意停止（removed + stopRequested 使退出回调 / 排队启动都按「有意」
  // 处理——不告警、不重起、queued start 到点也不再拉起，杜绝孤儿）。
  for (const [envId, handle] of envs) {
    if (wanted.has(envId)) continue;
    handle.removed = true;
    handle.stopRequested = true;
    clearRespawnTimer(handle);
    if (handle.child) {
      queueLifecycle(() => { try { handle.child?.kill('SIGTERM'); } catch { /* ignore */ } });
    }
    envs.delete(envId);
  }
  // 建新 / 更新元数据（既有 handle 的运行态保留）。
  for (const [envId, spec] of wanted) {
    const existing = envs.get(envId);
    if (existing) {
      existing.name = spec.name;
      existing.platform = spec.platform;
      existing.cascadeIndex = spec.cascadeIndex;
    } else {
      const handle = makeEnvHandle(spec);
      // 环境名现成可得：未启动前就点亮账号标签（登录后被真实身份覆盖）。
      if (spec.kind === 'adspower' && spec.profileId) {
        handle.status.account = { id: spec.profileId, name: spec.name || '', source: 'env' };
      }
      envs.set(envId, handle);
    }
  }
  if (!envs.has(selectedEnvId)) {
    const first = envs.keys().next();
    selectedEnvId = first.done ? '' : first.value;
  }
  // 花名册变更后重算同账号告警：某一重复环境被移出后，幸存兄弟的告警必须随之撤下，
  // 否则会留一个「幽灵需处理项」（脉冲 + 计入待处理 + 混进引导队列）直到别的环境再发身份事件。
  refreshSameAccountWarnings();
  broadcastFleet();
}

/** fleet 快照（花名册 + 各环境状态 + 选中项），供渲染层建栏/全量对齐。 */
function fleetSnapshot() {
  return {
    provider: settings.provider,
    selectedEnvId,
    railCollapsed: Boolean(settings.railCollapsed),
    environments: [...envs.values()].map((h) => ({
      envId: h.envId,
      kind: h.kind,
      profileId: h.profileId,
      name: h.name,
      platform: h.platform,
      status: { ...h.status, envId: h.envId, envName: h.name },
    })),
  };
}

function broadcastFleet() {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('fleet:update', fleetSnapshot());
  });
}

// ── 生命周期错峰串行队列（AdsPower ~1req/s；启动/停止/重登统一走此口）──
const lifecycleQueue = fleet.createStaggerQueue({
  spacingMs: Number(process.env.AIDCP_FLEET_STAGGER_MS) > 0 ? Number(process.env.AIDCP_FLEET_STAGGER_MS) : undefined,
});
function queueLifecycle(fn) {
  return lifecycleQueue.enqueue(fn);
}

// ── 每环境有界重起（复用 respawn-policy 语义；CJS 副本见 fleet.cjs，parity 用例锁一致）──
const RESPAWN_OPTS = {
  maxConsecutiveFailures: Number(process.env.AIDCP_EDGE_RESPAWN_MAX ?? 5),
  backoffBaseMs: Number(process.env.AIDCP_EDGE_RESPAWN_BACKOFF_BASE_MS ?? 1_000),
  backoffMaxMs: Number(process.env.AIDCP_EDGE_RESPAWN_BACKOFF_MAX_MS ?? 30_000),
  healthyUptimeMs: Number(process.env.AIDCP_EDGE_RESPAWN_HEALTHY_UPTIME_MS ?? 60_000),
};
function clearRespawnTimer(handle) {
  if (handle.respawnTimer) {
    clearTimeout(handle.respawnTimer);
    handle.respawnTimer = null;
  }
}

// ── 轻量 UI 状态持久化（与用户设置分文件；只存展示性历史，按 envId 分桶）──
let uiState = { byEnv: {} };
function uiStateFile() {
  return path.join(app.getPath('userData'), 'ui-state.json');
}

function loadUiState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(uiStateFile(), 'utf8'));
    if (parsed && parsed.byEnv && typeof parsed.byEnv === 'object') {
      uiState = { byEnv: parsed.byEnv };
    } else if (parsed && parsed.lastPublish && typeof parsed.lastPublish.title === 'string') {
      // 旧单环境形状：归入迁移后的首个环境（无环境则挂 self）。
      const first = envs.keys().next();
      const legacyEnvId = first.done ? 'self' : first.value;
      uiState = { byEnv: { [legacyEnvId]: { lastPublish: { title: parsed.lastPublish.title, at: parsed.lastPublish.at || null } } } };
    }
  } catch {
    /* 无历史/坏文件按空处理 */
  }
  for (const handle of envs.values()) {
    const saved = uiState.byEnv[handle.envId];
    if (saved && saved.lastPublish && typeof saved.lastPublish.title === 'string') {
      handle.status.lastPublish = { title: saved.lastPublish.title, at: saved.lastPublish.at || null };
    }
  }
}

function saveUiState() {
  try {
    for (const handle of envs.values()) {
      if (handle.status.lastPublish) {
        uiState.byEnv[handle.envId] = { lastPublish: handle.status.lastPublish };
      }
    }
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(uiStateFile(), JSON.stringify(uiState, null, 2), 'utf8');
  } catch (error) {
    console.error('[aidcp-edge] ui-state 写入失败:', error?.message); // 展示性历史，写失败不阻断
  }
}

// Windows 叠加窗控随风控状态染色（mac 红绿灯为系统绘制、无需管）。仅对**选中环境**生效。
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

const DAILY_USAGE_ACTIONS = ['view', 'like', 'collect', 'comment', 'follow', 'publish'];
const DAILY_USAGE_WINDOWS = ['session', 'minute', 'hour', 'day'];

function cleanCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cleanRequiredCounts(input) {
  const source = input && typeof input === 'object' ? input : {};
  const counts = {};
  for (const action of DAILY_USAGE_ACTIONS) counts[action] = cleanCount(source[action]);
  return counts;
}

function cleanOptionalCounts(input) {
  const source = input && typeof input === 'object' ? input : null;
  if (!source) return null;
  const counts = {};
  for (const action of DAILY_USAGE_ACTIONS) {
    if (typeof source[action] === 'number' && Number.isFinite(source[action])) {
      counts[action] = cleanCount(source[action]);
    }
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

function saturatedActions(totals, quotas, explicit) {
  const set = new Set(Array.isArray(explicit) ? explicit.filter((a) => DAILY_USAGE_ACTIONS.includes(a)) : []);
  if (quotas) {
    for (const action of DAILY_USAGE_ACTIONS) {
      if (typeof quotas[action] === 'number' && cleanCount(totals[action]) >= cleanCount(quotas[action])) {
        set.add(action);
      }
    }
  }
  return [...set];
}

function normalizeUsageWindow(input) {
  if (!input || typeof input !== 'object' || !input.totals || typeof input.totals !== 'object') return null;
  const totals = cleanOptionalCounts(input.totals);
  if (!totals) return null;
  const quotas = cleanOptionalCounts(input.quotas);
  const out = {
    totals,
    saturated: saturatedActions(totals, quotas, input.saturated),
  };
  if (typeof input.active === 'boolean') out.active = input.active;
  if (typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)) out.startedAt = input.startedAt;
  if (typeof input.windowMs === 'number' && Number.isFinite(input.windowMs) && input.windowMs > 0) out.windowMs = Math.floor(input.windowMs);
  if (typeof input.expiresAt === 'number' && Number.isFinite(input.expiresAt)) out.expiresAt = input.expiresAt;
  if (typeof input.refreshAt === 'number' && Number.isFinite(input.refreshAt)) out.refreshAt = input.refreshAt;
  if (typeof input.releaseAt === 'number' && Number.isFinite(input.releaseAt)) out.releaseAt = input.releaseAt;
  if (quotas) out.quotas = quotas;
  return out;
}

function normalizeUsageWindows(input) {
  if (!input || typeof input !== 'object') return null;
  const windows = {};
  for (const name of DAILY_USAGE_WINDOWS) {
    const window = normalizeUsageWindow(input[name]);
    if (window) windows[name] = window;
  }
  return Object.keys(windows).length > 0 ? windows : null;
}

function normalizeDailyUsage(input) {
  if (!input || typeof input !== 'object') return null;
  const asOf = typeof input.asOf === 'number' && Number.isFinite(input.asOf)
    ? new Date(input.asOf).toISOString()
    : new Date().toISOString();
  const totals = cleanRequiredCounts(input.totals);
  const quotas = cleanOptionalCounts(input.quotas);
  const windows = normalizeUsageWindows(input.windows);
  const out = {
    asOf,
    totals,
    saturated: saturatedActions(totals, quotas, input.saturated),
  };
  if (['conservative', 'normal', 'aggressive'].includes(input.quotaLevel)) out.quotaLevel = input.quotaLevel;
  if (quotas) out.quotas = quotas;
  if (windows) out.windows = windows;
  return out;
}

function statsFromDailyUsage(usage) {
  const totals = usage?.totals || {};
  return mergeStats(null, {
    views: cleanCount(totals.view),
    likes: cleanCount(totals.like),
    collects: cleanCount(totals.collect),
    comments: cleanCount(totals.comment),
    follows: cleanCount(totals.follow),
    publishes: cleanCount(totals.publish),
  });
}

function bumpDailyUsage(usage, action, delta) {
  const amount = cleanCount(delta);
  if (!usage || !DAILY_USAGE_ACTIONS.includes(action) || amount <= 0) return usage || null;
  const totals = { ...cleanRequiredCounts(usage.totals) };
  totals[action] = cleanCount(totals[action]) + amount;
  const quotas = cleanOptionalCounts(usage.quotas);
  const windows = bumpDailyUsageWindows(usage.windows, action, amount);
  return {
    ...usage,
    asOf: new Date().toISOString(),
    totals,
    ...(quotas ? { quotas } : {}),
    saturated: saturatedActions(totals, quotas, usage.saturated),
    ...(windows ? { windows } : {}),
  };
}

function bumpDailyUsageWindows(input, action, amount) {
  if (!input || typeof input !== 'object') return null;
  const windows = {};
  for (const name of DAILY_USAGE_WINDOWS) {
    const window = normalizeUsageWindow(input[name]);
    if (!window) continue;
    const hasAction =
      Object.prototype.hasOwnProperty.call(window.totals, action) ||
      (window.quotas && Object.prototype.hasOwnProperty.call(window.quotas, action));
    if (!hasAction) {
      windows[name] = window;
      continue;
    }
    const totals = { ...window.totals, [action]: cleanCount(window.totals[action]) + amount };
    const quotas = cleanOptionalCounts(window.quotas);
    const now = Date.now();
    const expired = typeof window.expiresAt === 'number' && Number.isFinite(window.expiresAt) && window.expiresAt <= now;
    const baseTotals = expired && typeof window.windowMs === 'number'
      ? Object.fromEntries(DAILY_USAGE_ACTIONS.map((name) => [name, name === action ? amount : 0]))
      : totals;
    windows[name] = {
      ...window,
      totals: baseTotals,
      ...(expired && typeof window.windowMs === 'number'
        ? { startedAt: now - window.windowMs, expiresAt: now + window.windowMs }
        : {}),
      ...(quotas ? { quotas } : {}),
      saturated: saturatedActions(baseTotals, quotas, expired ? [] : window.saturated),
    };
  }
  return Object.keys(windows).length > 0 ? windows : null;
}

/** 每环境状态合并 + 广播（status:update 带 envId 路由键；渲染层按键归属，绝不串号）。 */
function updateStatus(handle, patch) {
  // 计数补丁先跟现值合并成**完整** stats 再落（修老 bug：Object.assign 先把 stats 整体
  // 替换成局部补丁，随后的合并对象已被替换 → 未提及的计数被清空、渲染层出现空数字）。
  const full = patch.stats ? { ...patch, stats: mergeStats(handle.status.stats, patch.stats) } : patch;
  Object.assign(handle.status, full, { updatedAt: new Date().toISOString() });
  syncBrowserPersonaNotice(handle);
  if (patch.risk && handle.envId === selectedEnvId) applyOverlayTone(patch.risk);
  if (full.lastPublish) saveUiState();
  const payload = { ...handle.status, envId: handle.envId, envName: handle.name };
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('status:update', payload);
  });
}

// 在场感更新的便捷封装：文案 + 现在时刻。
function presencePatch(text) {
  return { presence: { text, at: new Date().toISOString() } };
}

function clearEdgeFailurePatch(handle) {
  handle.lastEdgeFailureLine = '';
  return { edgeFailure: null };
}

function exitMessage(code, signal) {
  return `边缘进程已退出${code === null ? '' : `（code ${code}`}${signal ? ` ${signal}` : ''}${code === null ? '' : '）'}。`;
}

function conciseFailureLine(message) {
  const raw = String(message || '').trim();
  if (!raw || /^at\s/.test(raw) || /^\(?node:/.test(raw)) return '';
  let summary = raw
    .replace(/\s+/g, ' ')
    .replace(/^\[aidcp-edge\]\s*/, '')
    .replace(/^启动失败:\s*Error:\s*/, '启动失败：')
    .replace(/^Error:\s*/, '')
    .replace(/\[aidcp-edge\]\s*/g, '');
  if (!summary || /^at\s/.test(summary)) return '';
  if (summary.length > 520) summary = `${summary.slice(0, 517)}...`;
  return summary;
}

function rememberEdgeFailureCandidate(handle, message, isError) {
  const raw = String(message || '');
  if (!isError && !/(启动失败|失败|不可达|not allowed|being used|no_target|code=-?\d+)/i.test(raw)) return;
  const summary = conciseFailureLine(raw);
  if (summary) handle.lastEdgeFailureLine = summary;
}

function edgeFailurePatch(summary, extra = {}) {
  const clean = conciseFailureLine(summary) || String(summary || '').trim();
  if (!clean) return { edgeFailure: null };
  return {
    edgeFailure: {
      summary: clean,
      at: new Date().toISOString(),
      ...extra,
    },
  };
}

function abnormalExitFailurePatch(handle, code, signal) {
  return edgeFailurePatch(handle.lastEdgeFailureLine || exitMessage(code, signal), {
    exitCode: code ?? null,
    signal: signal ?? null,
  });
}

// 活动流条目单独走 ui:activity 通道（无界流不塞进 status 对象）；带 envId 路由键。
function broadcastActivity(handle, entry) {
  const payload = { ...entry, envId: handle.envId };
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('ui:activity', payload);
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

function surfaceNotification(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch {
    /* best-effort */
  }
}

const BROWSER_PERMISSION_LABELS = {
  geolocation: '地理位置',
  media: '摄像头/麦克风',
  midi: 'MIDI 设备',
  midiSysex: 'MIDI 设备',
  hid: 'HID 设备',
  serial: '串口设备',
  bluetooth: '蓝牙设备',
  usb: 'USB 设备',
  'clipboard-read': '剪贴板读取',
};
const BROWSER_PERMISSION_ALLOWLIST = new Set(['fullscreen', 'pointerLock']);
const permissionNoticeAt = new Map();

function installPermissionPolicy(win) {
  try {
    win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const allow = BROWSER_PERMISSION_ALLOWLIST.has(permission);
      if (!allow) {
        const label = BROWSER_PERMISSION_LABELS[permission] || permission || '未知权限';
        const origin = details && details.requestingUrl ? String(details.requestingUrl).slice(0, 120) : '当前页面';
        const key = `${permission}:${origin}`;
        const now = Date.now();
        if (now - (permissionNoticeAt.get(key) || 0) > 60_000) {
          permissionNoticeAt.set(key, now);
          surfaceNotification('已拦截浏览器授权请求', `${origin} 请求访问「${label}」，客户端已默认拒绝。`);
        }
      }
      callback(allow);
    });
  } catch (error) {
    console.error('[aidcp-edge] 安装浏览器权限处理失败:', error?.message || error);
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
    width: 820,
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

  installPermissionPolicy(mainWindow);
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
    { label: '显示浏览器窗口', click: () => { void sendBrowserParkingCommand(selectedHandle(), 'browser.show'); } },
    { label: '重置浏览器位置', click: () => { void sendBrowserParkingCommand(selectedHandle(), 'browser.park'); } },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]));
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

function writeBrowserControlCommand(handle, type, payload) {
  if (!handle || !handle.child || !handle.browserParkingReady || !handle.child.stdin || handle.child.stdin.destroyed) {
    return { ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' };
  }
  try {
    const message = payload === undefined ? { type } : { type, payload };
    handle.child.stdin.write(`${JSON.stringify(message)}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || '发送浏览器控制指令失败' };
  }
}

// 人设横幅判定宽限期（同 renderer 弹窗宽限，理由一致）：账号刚登录+连云的空窗里，云端「已绑人设」
// 信号可能还没到，此刻按未绑推横幅会误扰已设置的账号。宽限内先不推、挂到点复评；宽限到点仍未绑才推。
const PERSONA_NOTICE_GRACE_MS = 6000;

function personaNoticeReady(handle) {
  const s = handle.status || {};
  return s.auth === 'logged in' && s.cloud === 'connected';
}

function resetPersonaNoticeGrace(handle) {
  if (!handle) return;
  handle.personaNoticeReadySince = 0;
  if (handle.personaNoticeTimer) { clearTimeout(handle.personaNoticeTimer); handle.personaNoticeTimer = null; }
}

function syncBrowserPersonaNotice(handle, force = false) {
  if (!handle || !handle.browserParkingReady) return;
  const ready = personaNoticeReady(handle);
  if (!ready) handle.personaNoticeReadySince = 0;
  else if (!handle.personaNoticeReadySince) handle.personaNoticeReadySince = Date.now();

  let notice = browserPersonaNoticeForStatus(handle.status, handle.name);
  if (notice.active && ready) {
    const elapsed = Date.now() - handle.personaNoticeReadySince;
    if (elapsed < PERSONA_NOTICE_GRACE_MS) {
      notice = { active: false }; // 宽限内先不推横幅（已设置账号会在此窗口内翻成已绑而永不被推）
      if (!handle.personaNoticeTimer) {
        handle.personaNoticeTimer = setTimeout(() => {
          handle.personaNoticeTimer = null;
          if (handle.removed || !handle.child) return;
          syncBrowserPersonaNotice(handle);
        }, Math.max(0, PERSONA_NOTICE_GRACE_MS - elapsed));
      }
    }
  }
  const stateKey = browserPersonaNoticeKey(notice);
  if (!force && handle.browserPersonaNoticeState === stateKey) return;
  const result = writeBrowserControlCommand(handle, 'browser.personaNotice', notice);
  if (result.ok) handle.browserPersonaNoticeState = stateKey;
}

function sendBrowserParkingCommand(handle, type) {
  const sent = writeBrowserControlCommand(handle, type);
  if (!sent.ok) return sent;
  try {
    // 「尽力抬前」诚实边界：外壳只能请求核心把窗口前置/归位，无法保证系统真把它抬到最前，
    // 故回执带窗口所在的定位提示、绝不宣称「已抬到最前」。
    const plan = currentParkingPlan();
    const where = plan.effectiveMode === 'offscreen'
      ? '窗口平时完全移出屏幕，请稍候其自动归位'
      : plan.effectiveMode === 'edge-strip'
        ? '窗口平时停放在屏幕边缘'
        : plan.effectiveMode === 'parking-display'
          ? '窗口平时停放在副屏'
          : '窗口平时停放在主屏背景位';
    return { ok: true, hint: `已向该环境发出窗口${type === 'browser.show' ? '前置' : '归位'}请求；若未见弹出，${where}，也可在系统窗口切换器里按名字找到它。` };
  } catch (error) {
    return { ok: false, error: error?.message || '发送浏览器控制指令失败' };
  }
}

// 建号自助人设：把带 correlation id 的 persona 命令写进**目标环境**（envId 路由，缺省选中环境）的 core stdin，
// 返回按 [persona-reply] 命中的 Promise。不 gate 在 browserParkingReady（persona 与 parking 独立）。
// 红线（跨账号误绑）：persist 必须打到「草稿所属环境」的子进程，不能因中途切换环境把 A 的人设写进 B 的账号。
function sendPersonaCommand(envId, type, payload) {
  return new Promise((resolve) => {
    // 严格路由（红线：跨账号误绑）：显式给了 envId 就**只**打那个环境，绝不回落选中环境——
    // 否则草稿所属环境在 persist 在途时被移出花名册，会把人设写进当前选中的另一个账号。
    // 缺省（undefined，单环境/local）才回落选中环境（向后兼容）。
    const handle = envId ? envs.get(envId) : selectedHandle();
    if (!handle || !handle.child || !handle.child.stdin || handle.child.stdin.destroyed) {
      resolve({ ok: false, reason: 'edge_not_running' });
      return;
    }
    const id = `persona-${++personaSeq}-${Date.now()}`;
    // 略长于 core 侧 190s WS 超时，容 core 在 WS 超时后仍回执诚实失败。
    const timer = setTimeout(() => {
      personaPending.delete(id);
      resolve({ ok: false, reason: 'edge_request_timeout' });
    }, 200_000);
    personaPending.set(id, { resolve, timer });
    try {
      handle.child.stdin.write(`${JSON.stringify({ type, id, payload })}\n`);
    } catch (error) {
      clearTimeout(timer);
      personaPending.delete(id);
      resolve({ ok: false, reason: 'edge_write_failed' });
    }
  });
}

// core 回执行 `[persona-reply] {id, ok, payload?, error?}`：按 id 命中 pending resolve。
function handlePersonaReply(jsonText) {
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return;
  }
  const entry = obj && obj.id ? personaPending.get(obj.id) : undefined;
  if (!entry) return;
  clearTimeout(entry.timer);
  personaPending.delete(obj.id);
  if (obj.ok && obj.payload && typeof obj.payload === 'object') {
    entry.resolve(obj.payload);
  } else {
    entry.resolve({ ok: false, reason: 'edge_request_failed', detail: obj.error });
  }
}

/** 同账号铺多环境检测（云端会合并风控/配额、发布只定向最早那条边缘）：状态变更后全量重算。 */
function refreshSameAccountWarnings() {
  const entries = [...envs.values()]
    .filter((h) => h.status.account && h.status.account.source !== 'env') // 只认登录读出的真实身份
    .map((h) => ({ envId: h.envId, accountId: h.status.account.id }));
  const dupEnvIds = new Set(fleet.duplicateAccountGroups(entries).flatMap((g) => g.envIds));
  for (const handle of envs.values()) {
    const shouldWarn = dupEnvIds.has(handle.envId);
    const isWarned = Boolean(handle.status.sameAccountWarning);
    if (shouldWarn === isWarned) continue;
    updateStatus(handle, {
      sameAccountWarning: shouldWarn
        ? { message: '该环境与另一环境登录了同一账号：云端会合并两者的风控与配额预算、发布只定向最早连接的那条边缘。请改为一个环境一个独立账号。' }
        : null,
    });
  }
}

/** 有界重起调度尾（exit / spawn-error 两处共用）：respawn → 退避后经错峰队列重起（再校验取消闸）。 */
function scheduleRespawnIfNeeded(handle, decision) {
  if (decision.action !== 'respawn' || isQuitting) return;
  handle.respawnTimer = setTimeout(() => {
    handle.respawnTimer = null;
    if (isQuitting || handle.removed || handle.child || handle.stopRequested) return;
    void queueLifecycle(() => startFlowForEnv(handle));
  }, decision.delayMs || 0);
  if (handle.respawnTimer && typeof handle.respawnTimer.unref === 'function') handle.respawnTimer.unref();
}

/**
 * 把窄生命周期意图送到该环境自己的 core。pause 交付失败绝不回落 SIGTERM——SIGTERM 是最终关闭，
 * 若拿它伪装暂停会再次关掉浏览器。异步 send 失败也按目标 handle 原位回报，不串环境。
 */
function sendCoreLifecycle(handle, command, onError) {
  const child = handle && handle.child;
  const fail = (error) => {
    if (typeof onError === 'function') onError(error instanceof Error ? error : new Error(String(error)));
  };
  if (!child || typeof child.send !== 'function' || child.connected === false) {
    fail(new Error('核心进程 IPC 不可用'));
    return false;
  }
  try {
    child.send({ type: `lifecycle.${command}` }, (error) => {
      if (error && handle.child === child) fail(error);
    });
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

/** spawn 一个环境的核心子进程（非 detached，随外壳退出终止）。身份闸在此强制执行。 */
function startEdge(handle) {
  // 取消闸（红线）：排队等待期间被退出 / 移出 / 暂停的启动到点也绝不拉起子进程——
  // 否则退出期会 spawn 孤儿 Chrome（gracefulStopAllAndQuit 已快照 SIGTERM 集、抓不到它），
  // 或把用户的暂停 / 移出静默覆盖回运行。
  if (!handle || handle.child || handle.removed || handle.stopRequested || isQuitting) return;
  if (handle.status.session === 'paused') return;
  clearRespawnTimer(handle);
  // 打包后用 Electron 自带的 Node 运行预编译产物（ELECTRON_RUN_AS_NODE），
  // 不依赖目标机装 Node/npx/tsx。entry 为 build:dist 编译出的 dist/main.js。
  const appRoot = app.getAppPath();
  const edgeEntry = path.join(appRoot, 'dist', 'main.js');
  // 打包后 appRoot 是 app.asar 文件；spawn cwd 必须是真目录，否则 macOS 抛 ENOTDIR，
  // 核心进程根本起不来、浏览器无法启动（本地 dev 因 appRoot 为真目录不触发）。
  const edgeCwd = appRoot.endsWith('.asar') ? path.dirname(appRoot) : appRoot;
  let spawnEnv;
  if (handle.kind === 'adspower') {
    // 身份闸（红线）：冻结 env 注入唯一稳定身份；无法派生（缺分身 id）则诚实拒绝，绝不回落主机名。
    const built = fleet.buildEnvSpawnEnv({
      environment: { profileId: handle.profileId, name: handle.name, platform: handle.platform },
      processEnv: process.env,
      providerEnv: buildAdsProviderEnv(handle),
    });
    if (!built.ok) {
      updateStatus(handle, {
        auth: 'config required',
        edge: 'stopped',
        session: 'idle',
        lastMessage: built.reason,
        ...edgeFailurePatch(built.reason),
        ...presencePatch('身份不完整，已拒绝启动'),
      });
      return;
    }
    // 同 edgeId 已在跑（理论上被花名册去重挡住；此为最后闸）：拒绝二次 spawn 防云端互踢。
    const dupRunning = [...envs.values()].some((h) => h !== handle && h.child && h.envId === built.envId);
    if (dupRunning) {
      updateStatus(handle, {
        edge: 'stopped',
        session: 'idle',
        lastMessage: '同一分身已有环境在运行，拒绝重复启动（同 edgeId 的第二条连接会被云端互踢）。',
        ...presencePatch('分身已在其它环境运行'),
      });
      return;
    }
    spawnEnv = { ...built.env, ELECTRON_RUN_AS_NODE: '1' };
  } else {
    // self 遗留路径：维持旧合并次序（provider env 在前、被 ...process.env 覆盖 → 外部显式设置仍是逃生阀）。
    spawnEnv = { ...buildSelfProviderEnv(), ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  }

  handle.browserParkingReady = false;
  handle.browserPersonaNoticeState = null;
  resetPersonaNoticeGrace(handle);
  handle.browserAlreadyRunning = false;
  handle.coreParked = false;
  handle.closePending = false;
  handle.spawnedAtMs = Date.now();
  // 换会话重置已绑人设信号（change persona-badge-preconnect-neutral）：云端只在为真时下发 personaBound、从不发 false，
  // 若上一会话该环境曾已绑、随后被解绑再重启，stale-true 会残留成误显示「已设置」——每次启动清零、待新会话权威信号重建。
  handle.status.personaBound = false;
  const child = spawn(process.execPath, [edgeEntry], {
    cwd: edgeCwd,
    env: spawnEnv,
    // 第四路 IPC 专用于本地生命周期意图；persona/browser parking 既有 stdin 协议保持不变。
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  handle.child = child;

  // 发布卡在途状态随核心（重）启动清零（edge-companion-ui 8.1 评审修正）：离线窗口内的审批变化
  // （拒绝/失败）推送会如实丢失，旧 pending/approved 卡若不清会永久滞留成陈卡；真在候审/已批的
  // 草稿由重连后的云端 hello 快照重新推回。lastPublish 历史态不清（持久数据）。
  updateStatus(handle, {
    edge: 'starting',
    session: 'running',
    publish: null,
    respawnGaveUp: false,
    lastMessage: '正在启动 aidcp-edge…',
    ...presencePatch('正在启动引擎…'),
    ...clearEdgeFailurePatch(handle),
  });

  child.stdout.on('data', (chunk) => handleEdgeOutput(handle, chunk.toString()));
  child.stderr.on('data', (chunk) => handleEdgeOutput(handle, chunk.toString(), true));
  child.on('message', (message) => {
    if (handle.child !== child || !message || typeof message !== 'object') return;
    if (message.type === 'lifecycle.paused') {
      handle.pausePending = false;
      handle.coreParked = true;
      updateStatus(handle, {
        edge: 'stopped',
        cloud: 'disconnected',
        session: 'paused',
        overlayBlocked: false,
        lastMessage: '已暂停自动运营，浏览器保持打开。',
        ...presencePatch('已暂停，浏览器保持打开'),
        ...clearEdgeFailurePatch(handle),
      });
      return;
    }
    if (message.type === 'lifecycle.close_failed') {
      handle.closePending = false;
      handle.pausePending = false;
      handle.coreParked = true;
      handle.stopRequested = true;
      updateStatus(handle, {
        edge: 'stopped',
        cloud: 'disconnected',
        session: 'paused',
        lastMessage: '浏览器关闭状态未能确认，仍按暂停处理；可重试关闭。',
        ...edgeFailurePatch('浏览器关闭状态未能确认'),
        ...presencePatch('关闭未确认，仍保持暂停'),
      });
    }
  });
  // spawn 失败（EAGAIN 多环境 fork 压力 / ENOENT 产物缺失）：'error' 事件无监听会被 EventEmitter
  // 重抛为未捕获异常 → 整个监督者进程崩、连累全部兄弟环境（破坏崩溃隔离）；即便 Electron 幸存，
  // 'error' 后不发 'exit'，handle.child 永远钉住 → 该环境卡死在 starting、重起/放弃永不触发（静默假成功）。
  // 故必须挂 'error'：诚实呈现失败 + 走同一条有界重起/放弃路径。exit 与 error 用 `handle.child===child`
  // 互斥，谁先触发谁处理、另一个 no-op。
  child.on('error', (err) => {
    if (handle.child !== child) return;
    handle.child = undefined;
    handle.browserParkingReady = false;
    handle.browserPersonaNoticeState = null;
    resetPersonaNoticeGrace(handle);
    const msg = (err && err.message) || String(err);
    appendEdgeLog(handle.envId, `spawn error: ${msg}`, true);
    if (handle.removed) return;
    const decision = isQuitting
      ? { action: 'stop', streak: handle.respawnStreak }
      : fleet.decideRespawn(
          { exitCode: 1, uptimeMs: Date.now() - handle.spawnedAtMs, prevStreak: handle.respawnStreak, shuttingDown: isQuitting },
          RESPAWN_OPTS,
        );
    handle.respawnStreak = decision.streak;
    const gaveUp = decision.action === 'give-up';
    const willRespawn = decision.action === 'respawn';
    if (gaveUp) handle.gaveUp = true;
    updateStatus(handle, {
      edge: 'warning',
      cloud: 'disconnected',
      session: 'idle',
      risk: 'normal',
      // adspower 的登录态由身份确立事件写入（本次进程已死）→ 诚实复位待检测；self 由 cookie 门自管。
      ...(handle.kind === 'adspower' ? { auth: 'checking' } : {}),
      overlayBlocked: false,
      respawnGaveUp: gaveUp,
      lastMessage: `核心进程启动失败：${msg}`
        + (gaveUp ? ` 连续失败已达上限（${RESPAWN_OPTS.maxConsecutiveFailures} 次），已放弃自动重启。`
          : willRespawn ? ` 将在 ${Math.round((decision.delayMs || 0) / 1000)}s 后自动重试。` : ''),
      ...edgeFailurePatch(`核心进程启动失败：${msg}`),
      ...presencePatch(gaveUp ? '错误 · 已放弃自动重启' : '启动失败，稍后重试'),
    });
    if (decision.streak === 1 || gaveUp) {
      surfaceFailure(`AIDCP Edge${handle.name ? `（${handle.name}）` : ''} 启动失败`, `核心进程无法启动：${msg}`);
    }
    scheduleRespawnIfNeeded(handle, decision);
  });
  child.on('exit', (code, signal) => {
    if (handle.child !== child) return; // 已被 'error' 处理器接管
    const wasClosing = handle.closePending;
    const wasParked = handle.coreParked;
    const wasPausing = handle.pausePending;
    const wasRestarting = handle.restartPending;
    handle.child = undefined;
    handle.browserParkingReady = false;
    handle.browserPersonaNoticeState = null;
    resetPersonaNoticeGrace(handle);
    // 主动重启、暂停驻留、显式关闭、移出花名册、退出应用都是「有意停止」，不算异常。
    const intentional = isQuitting || wasRestarting || wasPausing || wasParked || wasClosing || handle.removed;
    handle.pausePending = false;
    handle.coreParked = false;
    handle.closePending = false;
    const exitedAbnormally = !intentional && (signal != null || (code != null && code !== 0));
    const message = exitMessage(code, signal);
    if (handle.removed) return; // 已摘除的环境不再投影状态

    // 有界重起决策（仅对异常退出计入；有意停止一律 stop）。
    const decision = exitedAbnormally
      ? fleet.decideRespawn(
          { exitCode: signal != null && code == null ? null : code, uptimeMs: Date.now() - handle.spawnedAtMs, prevStreak: handle.respawnStreak, shuttingDown: isQuitting },
          RESPAWN_OPTS,
        )
      : { action: 'stop', streak: 0 };
    handle.respawnStreak = decision.streak;

    const willRespawn = decision.action === 'respawn';
    const gaveUp = decision.action === 'give-up';
    if (gaveUp) handle.gaveUp = true;

    updateStatus(handle, {
      edge: exitedAbnormally ? 'warning' : 'stopped',
      cloud: 'disconnected',
      session: wasClosing
        ? 'closed'
        : wasRestarting
          ? 'running'
          : (handle.status.session === 'paused' || wasPausing || wasParked ? 'paused' : 'idle'),
      // 核心已退出 = 无在跑会话：把本地日志派生的 risk 徽标复位 normal（该徽标是日志关键词启发、非权威，
      // 真风控由云端单写），杜绝上一会话残留的「⚠」把徽标跨会话卡在「警戒」。
      risk: 'normal',
      // 同理诚实复位 adspower 登录态（由身份事件写入、随进程死亡失效）；self 由 cookie 门自管。
      ...(handle.kind === 'adspower' ? { auth: 'checking' } : {}),
      overlayBlocked: false,
      respawnGaveUp: gaveUp,
      lastMessage: wasClosing
        ? '浏览器已关闭。'
        : gaveUp
        ? `${message} 连续失败已达上限（${RESPAWN_OPTS.maxConsecutiveFailures} 次），已放弃自动重启，请人工排查后点「启动」重试。`
        : willRespawn
          ? `${message} 将在 ${Math.round((decision.delayMs || 0) / 1000)}s 后自动重启（第 ${decision.streak}/${RESPAWN_OPTS.maxConsecutiveFailures} 次）。`
          : message,
      ...presencePatch(
        wasClosing
          ? '已关闭浏览器'
          : wasRestarting
            ? '正在重启引擎…'
            : gaveUp
          ? '错误 · 已放弃自动重启'
          : willRespawn
            ? '异常退出，稍后自动重启'
            : (handle.status.session === 'paused' || wasPausing || wasParked)
              ? '已暂停，随时可以恢复'
              : '引擎已停止',
      ),
      ...(exitedAbnormally ? abnormalExitFailurePatch(handle, code, signal) : clearEdgeFailurePatch(handle)),
    });

    // 红线：异常退出不静默——首次失败与放弃时弹系统通知（重起风暴中间不刷屏，状态行已如实呈现）。
    if (exitedAbnormally && (decision.streak === 1 || gaveUp)) {
      const adspowerHint = handle.kind === 'adspower'
        ? '请在该分身的浏览器窗口登录后，点击「重新登录」重试；并确认分身 ID 正确、指纹浏览器已就绪。'
        : '请打开窗口查看日志 / 重新登录或重连云端。';
      surfaceFailure(
        `AIDCP Edge${handle.name ? `（${handle.name}）` : ''} ${gaveUp ? '已放弃自动重启' : '已停止运行'}`,
        `${message}${handle.status.edgeFailure && handle.status.edgeFailure.summary ? `原因：${handle.status.edgeFailure.summary}。` : ''}${adspowerHint}`,
      );
    }

    scheduleRespawnIfNeeded(handle, decision);

    // 有意重启：旧进程退出后按当前设置起新流程（经错峰队列）。退出应用途中绝不再起。
    if (handle.restartPending) {
      handle.restartPending = false;
      if (!isQuitting) void queueLifecycle(() => startFlowForEnv(handle));
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
// 固定 9222 起 Chrome → 轮询 cookie 确认已登录小红书 → 再起核心。adspower 模式不走此路。
async function checkLoginAndStart(handle) {
  try {
    const loggedIn = await hasXhsCookie();
    if (loggedIn) {
      stopLoginPoller();
      updateStatus(handle, { auth: 'logged in', lastMessage: '已检测到小红书登录，正在启动 aidcp-edge…', ...clearEdgeFailurePatch(handle) });
      startEdge(handle);
      return true;
    }
    updateStatus(handle, {
      auth: 'login required',
      session: 'idle',
      lastMessage: '请在刚打开的 Chrome 窗口中登录 xiaohongshu.com。',
      ...presencePatch('等你登录小红书后继续'),
    });
    return false;
  } catch (error) {
    updateStatus(handle, { auth: 'checking', lastMessage: `正在等待 Chrome CDP：${error.message}` });
    return false;
  }
}

async function launchChromeAndGateEdge(handle) {
  updateStatus(handle, { provider: 'self', ...clearEdgeFailurePatch(handle) });
  const launched = await launchChrome(app, { launchPosition: currentParkingPlan().launchPosition });
  if (!launched.ok) {
    updateStatus(handle, {
      auth: 'chrome missing',
      edge: 'stopped',
      session: 'idle',
      lastMessage: launched.error,
      ...edgeFailurePatch(launched.error || '未找到 Google Chrome，请安装后重启。'),
    });
    // 红线：Chrome 缺失诚实暴露，不静默装作在跑。
    surfaceFailure('AIDCP Edge 无法启动', launched.error || '未找到 Google Chrome，请安装后重启。');
    return;
  }
  updateStatus(handle, { auth: 'checking', lastMessage: `Chrome 已启动，配置目录：${launched.profilePath}`, ...clearEdgeFailurePatch(handle) });
  const loggedIn = await checkLoginAndStart(handle);
  if (!loggedIn && !loginPoller) {
    loginPoller = setInterval(() => { void checkLoginAndStart(handle); }, 5000);
  }
}

// 起核心前确保 AdsPower 运行时就绪 + 所需浏览器内核已下载（change edge-bundled-adspower-cli-runtime）。
// 多环境下运行时/内核为**整机共享**：同一时刻只跑一次预检（in-flight 单飞），后续环境等同一结果；
// settle 后清除，下次启动重新探测（运行时可能中途退出，不缓存陈旧结论）。
// 红线：任何失败诚实回报 + 弹窗、返回 { ok:false }，MUST NOT 起核心。
let adsServiceInFlight = null;
let adsPrepInFlight = null;

// 服务确保（单飞，跨 create-env / 启动 / 代理 / 删除去重）：确保指纹浏览器 LocalAPI 服务就绪、
// 确立单一 base 权威。**不下载内核**——元数据类操作（新建环境等）只需服务就绪。
// 返回 { ok, mode:'adopted'|'embedded', base?, cliEntry?, error? }。handle 可空（无 UI 上下文时不打状态）。
function ensureAdsServiceOnce(handle) {
  if (adsServiceInFlight) return adsServiceInFlight;
  adsServiceInFlight = ensureAdsService(handle).finally(() => {
    adsServiceInFlight = null;
  });
  return adsServiceInFlight;
}

// 首启把随包只读模板暂存到用户可写目录（打包态 Resources 只读、App Translocation 下尤甚，
// 而 CLI 要往自身 cwd/ 写）。版本戳（app 版本 + CLI 版本）不符即清旧重拷，避免升级后旧副本遮挡新运行时。
// 开发态无 resourcesPath / 无模板则跳过（resolveCliEntry 的 node_modules 候选直解）。
function stageAdsRuntimeIfNeeded() {
  try {
    if (!process.resourcesPath) return { ok: true, skipped: 'dev' };
    const src = path.join(process.resourcesPath, 'adspower-browser');
    if (!fs.existsSync(src)) return { ok: true, skipped: 'no-template' };
    const destRoot = path.join(app.getPath('userData'), 'ads-runtime');
    const dest = path.join(destRoot, 'adspower-browser');
    const stampPath = path.join(destRoot, 'stage.json');
    let pkgVersion = '';
    try { pkgVersion = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version || ''; } catch { /* best-effort */ }
    const wantStamp = JSON.stringify({ appVersion: app.getVersion(), pkgVersion });
    let haveStamp = '';
    try { haveStamp = fs.readFileSync(stampPath, 'utf8'); } catch { /* 无戳即视为需暂存 */ }
    if (fs.existsSync(dest) && haveStamp === wantStamp) return { ok: true, staged: false };
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(destRoot, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    fs.writeFileSync(stampPath, wantStamp);
    return { ok: true, staged: true };
  } catch (e) {
    return { ok: false, error: `指纹浏览器运行时暂存失败：${(e && e.message) || String(e)}` };
  }
}

async function ensureAdsService(handle) {
  adsServiceBase = null;
  // 1. 服务已可达则复用（外部 AdsPower / 已在跑的 CLI daemon）；其自管内核，不在此预检。
  const probe = await adsApi.status(resolveAdsOpts()).catch(() => null);
  if (probe && probe.ok) return { ok: true, mode: 'adopted' };

  // 2. 服务未就绪 → 首启暂存随包模板到可写目录，再拉起随包运行时。
  const staged = stageAdsRuntimeIfNeeded();
  if (!staged.ok) {
    if (handle) {
      updateStatus(handle, {
        auth: 'config required',
        edge: 'stopped',
        session: 'idle',
        lastMessage: staged.error,
        ...edgeFailurePatch(staged.error),
        ...presencePatch('运行时暂存失败'),
      });
    }
    return { ok: false, error: staged.error };
  }
  const cliEntry = adsRuntime.resolveCliEntry({
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    userDataPath: app.getPath('userData'),
  });
  if (!cliEntry) {
    // 硬切换：无随包运行时且服务未就绪 = 诚实硬停，绝不「继续尝试」去连一个不存在的 50325。
    const error = '指纹浏览器运行时未就绪：未随包运行时且本机无可达的指纹浏览器服务';
    if (handle) {
      updateStatus(handle, {
        auth: 'config required',
        edge: 'stopped',
        session: 'idle',
        lastMessage: error,
        ...edgeFailurePatch(error),
        ...presencePatch('运行时未就绪'),
      });
    }
    return { ok: false, error };
  }

  // 3. 起内嵌运行时（`ads status` 已在跑则复用、否则 `ads start -k <key>`）。
  if (handle) updateStatus(handle, { auth: 'checking', lastMessage: '正在启动内置指纹浏览器运行时…', ...presencePatch('正在准备浏览器运行时…') });
  const apiKey = resolveAdsApiKey('');
  // 就绪判定用 HTTP LocalAPI /status（权威可靠）——不依赖 `ads status`（Electron Node 20 下 fork 起服务后
  // 其 pid/store 写入可能未完成、误报未在跑，但 HTTP 正常）。
  const rt = await adsRuntime.ensureRuntime({
    cliEntry,
    execPath: process.execPath,
    apiKey,
    isReady: async () => {
      const p = await adsApi.status(resolveAdsOpts()).catch(() => null);
      return !!(p && p.ok);
    },
  });
  if (!rt.ok) {
    if (handle) {
      updateStatus(handle, {
        auth: 'config required',
        edge: 'stopped',
        session: 'idle',
        kernelPrep: null,
        lastMessage: `内置指纹浏览器运行时启动失败：${rt.error}`,
        ...edgeFailurePatch(rt.error || '内置指纹浏览器运行时启动失败'),
        ...presencePatch('运行时启动失败'),
      });
      surfaceFailure('AIDCP Edge 无法启动', `内置指纹浏览器运行时启动失败：${rt.error || '未知错误'}`);
    }
    return { ok: false, error: rt.error };
  }
  adsServiceBase = rt.base; // P0-A：运行时解析出的实际端口即单一 base 权威
  return { ok: true, mode: 'embedded', base: rt.base, cliEntry };
}

function ensureAdsRuntimeAndKernelOnce(handle) {
  if (adsPrepInFlight) return adsPrepInFlight;
  adsPrepInFlight = ensureAdsRuntimeAndKernel(handle).finally(() => {
    adsPrepInFlight = null;
  });
  return adsPrepInFlight;
}

// 启动浏览器前的完整确保 = 服务确保 + （仅内嵌形态）内核预检。
// 复用外部/已在跑的服务时其自管内核，跳过预检（保持迁移期行为）。
async function ensureAdsRuntimeAndKernel(handle) {
  const svc = await ensureAdsServiceOnce(handle);
  if (!svc.ok) return svc;
  // 内核预检必须在启动浏览器前跑，无论服务是刚起的（embedded）还是已在跑的（adopted）——
  // 我们自己先前起的服务（如「选已有环境」拉列表时起的）也没下内核，adopted 直接放行会撞
  // browser/start「SunBrowser 148 is not ready」。adopted 时 svc 不带 cliEntry，这里补解析。
  const kernelCli = svc.cliEntry || adsRuntime.resolveCliEntry({
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    userDataPath: app.getPath('userData'),
  });
  if (!kernelCli) {
    // 无随包运行时可管内核（纯外部自管形态）——放行，由外部服务自管内核（迁移期）。
    return { ok: true, mode: svc.mode };
  }

  // 条件式内核预检（缺则带进度下载、下完才放行；已下则秒过）
  const version = adsFingerprint.DEFAULT_KERNEL;
  if (handle) appendEdgeLog(handle.envId, `检查浏览器内核 ${version} 就绪情况（缺则首次下载约 750MB）…`);
  let loggedDownloadStart = false;
  const kres = await adsRuntime.ensureKernel({
    cliEntry: kernelCli,
    execPath: process.execPath,
    version,
    onProgress: ({ percent, state }) => {
      if (!handle) return;
      if (!loggedDownloadStart && (state === 'downloading' || state === 'installing')) {
        loggedDownloadStart = true;
        appendEdgeLog(handle.envId, `开始下载浏览器内核 ${version}（约 750MB，仅首次；带进度条）…`);
      }
      updateStatus(handle, {
        kernelPrep: { state, percent, version },
        lastMessage: `正在下载浏览器内核 ${version}（约 750MB，仅首次）… ${percent}%`,
        ...presencePatch(`准备浏览器内核 ${percent}%`),
      });
    },
  });
  if (handle) {
    if (kres.ok) {
      appendEdgeLog(handle.envId, kres.alreadyPresent ? `浏览器内核 ${version} 已就绪` : `浏览器内核 ${version} 下载完成`);
    } else {
      appendEdgeLog(handle.envId, `浏览器内核 ${version} 准备失败：${kres.error || ''}`, true);
      // 诊断：把 get-kernel-list / download-kernel 的原始输出落日志（截断），便于定位真机差异。
      const raw = (kres.raw || '').toString().slice(0, 1500);
      const rawErr = (kres.rawErr || '').toString().slice(0, 500);
      if (raw) appendEdgeLog(handle.envId, `内核命令原始输出(截断): ${raw}`, true);
      if (rawErr) appendEdgeLog(handle.envId, `内核命令 stderr(截断): ${rawErr}`, true);
    }
  }
  if (!kres.ok) {
    if (handle) {
      updateStatus(handle, {
        edge: 'stopped',
        session: 'idle',
        kernelPrep: { state: 'failed', percent: 0, version },
        lastMessage: `浏览器内核准备失败：${kres.error}`,
        ...edgeFailurePatch(kres.error || '浏览器内核准备失败'),
        ...presencePatch('内核准备失败，可重试'),
      });
      surfaceFailure('AIDCP Edge 无法启动', `浏览器内核准备失败：${kres.error || '未知错误'}`);
    }
    return { ok: false, error: kres.error };
  }
  if (handle) updateStatus(handle, { kernelPrep: null, ...clearEdgeFailurePatch(handle) });
  return { ok: true, mode: svc.mode, base: svc.base };
}

// adspower（AdsPower 指纹浏览器）路径：不自起本机 Chrome、不做 9222 cookie 轮询；
// 浏览器启动 / 登录态 / 身份确立全由核心进程经 AdsPower 本地 API 完成（未登录 → 核心诚实非零退出并弹窗）。
async function startAdsPowerFlow(handle) {
  updateStatus(handle, { provider: 'adspower', ...clearEdgeFailurePatch(handle) });
  if (!handle.profileId || !handle.profileId.trim()) {
    // 缺分身 ID 无法启动：诚实提示待配置，不静默假装在跑。
    updateStatus(handle, {
      auth: 'config required',
      edge: 'stopped',
      session: 'idle',
      lastMessage: '请在「浏览器」设置中加入至少一个环境，然后点击「启动」。',
      ...presencePatch('等待完成初始设置'),
    });
    return;
  }
  updateStatus(handle, {
    auth: 'checking',
    lastMessage: handle.browserAlreadyRunning
      ? '该分身浏览器已在运行，正在接管（不重复拉起）…'
      : '正在启动指纹浏览器…',
    // 环境名现成可得：启动即点亮标题带账号标签，不用等核心身份确立。
    ...(handle.name ? { account: { id: handle.profileId, name: handle.name, source: 'env' } } : {}),
    ...clearEdgeFailurePatch(handle),
  });
  // 起核心前确保运行时 + 内核就绪；失败已诚实呈现，绝不带核心进注定失败的启动。
  const prep = await ensureAdsRuntimeAndKernelOnce(handle);
  if (!prep.ok) return;
  // 运行时/内核准备可长达数分钟（首启下载）；这期间被暂停/移出/退出则诚实放弃，不再拉起子进程。
  // （startEdge 亦有同一取消闸兜底；此处提前返回避免多余「正在启动」状态残留。）
  if (handle.removed || handle.stopRequested || isQuitting || handle.status.session === 'paused') return;
  startEdge(handle);
}

// 按环境分派启动流程（不做队列；调用方决定是否经错峰队列进入）。
function startFlowForEnv(handle) {
  if (!handle) return;
  if (handle.kind === 'self') {
    return launchChromeAndGateEdge(handle);
  }
  return startAdsPowerFlow(handle);
}

/** 手动/排队启动入口：清放弃终态（人工重试口）+ 清取消闸 + 错峰入队。 */
function queueStartEnv(handle, queuePosition) {
  if (!handle || handle.child) return;
  handle.gaveUp = false;
  handle.respawnStreak = 0;
  handle.stopRequested = false; // 显式启动意图：解除任何在途取消闸
  clearRespawnTimer(handle);
  updateStatus(handle, {
    edge: 'starting',
    respawnGaveUp: false,
    lastMessage: queuePosition ? `已排队错峰启动（第 ${queuePosition} 位，相邻间隔约 1.1s）…` : '已排队错峰启动…',
    ...presencePatch('排队启动中…'),
  });
  void queueLifecycle(() => startFlowForEnv(handle));
}

// 有序重启：停登录轮询；若核心在跑则 SIGTERM 之，其 exit 回调据 restartPending 起新流程；
// 无在跑核心时直接错峰入队。供「保存设置」「恢复」「重新登录」三处复用。
function stopAndRestart(handle, message, patch = {}) {
  if (!handle) return;
  stopLoginPoller();
  handle.gaveUp = false;
  handle.respawnStreak = 0;
  handle.stopRequested = false; // 显式重启意图：解除任何在途取消闸
  clearRespawnTimer(handle);
  updateStatus(handle, { cloud: 'disconnected', session: 'running', respawnGaveUp: false, lastMessage: message, ...presencePatch('正在重启引擎…'), ...clearEdgeFailurePatch(handle), ...patch });
  if (handle.child) {
    handle.restartPending = true;
    void queueLifecycle(() => { try { handle.child?.kill('SIGTERM'); } catch { /* ignore */ } });
  } else {
    void queueLifecycle(() => startFlowForEnv(handle));
  }
}

function handleEdgeOutput(handle, text, isError = false) {
  // 一个 chunk 可能带多行：逐行处理，让活动流 / 计数按真实行数走（旧法整块只算一次）。
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) handleEdgeLogLine(handle, line, isError);
}

function handleEdgeLogLine(handle, message, isError = false) {
  // 建号自助人设回执：早拦截，按 id 命中 pending，不当普通日志/状态行处理。
  if (message.startsWith('[persona-reply]')) {
    handlePersonaReply(message.slice('[persona-reply]'.length).trim());
    return;
  }
  appendEdgeLog(handle.envId, message, isError); // 落文件（排障回溯，独立于下方状态判断）
  if (message.includes('[browser-parking] control-ready')) {
    handle.browserParkingReady = true;
    handle.browserPersonaNoticeState = null;
    syncBrowserPersonaNotice(handle, true);
  }
  // 核心正被有意停止 / 已暂停 / 已退出：其关闭期 stdout/stderr 只作为日志行展示，绝不据以翻转
  // edge / session / risk 徽标，也不产 UI 事件。正常在跑时才做状态推断。
  const stopping = isQuitting || handle.restartPending || handle.pausePending || handle.removed || !handle.child || handle.status.session === 'paused';
  if (!stopping) rememberEdgeFailureCandidate(handle, message, isError);
  if (stopping) {
    if (!handle.removed) updateStatus(handle, { lastMessage: message });
    return;
  }
  const next = { edge: isError ? 'warning' : 'running', lastMessage: message };
  if (!isError && handle.status.edgeFailure) next.edgeFailure = null;
  if (message.includes('已连接云端') || message.includes('已握手') || message.includes('云端已重连')) next.cloud = 'connected';
  if (message.includes('连接失败') || message.includes('WS 已关闭') || message.includes('启动失败')) next.cloud = 'disconnected';
  if (message.includes('云端重连中')) next.cloud = 'disconnected';
  if (message.includes('云端重连耗尽')) {
    next.edge = 'warning';
    next.cloud = 'disconnected';
    next.session = 'idle';
    next.presence = { text: '云端重连失败，等待重启', at: new Date().toISOString() };
  }
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

  // 健康运行达阈值 → 连续失败预算清零（respawn-policy 的健康信号在退出时按 uptime 判，这里无需处理）。

  // UI 事件（活动流 / 在场感 / 发布卡 / 账号身份 / 计数）统一走该环境自己的 ui-events 实例：
  // 结构化 [ui-event] 行优先，中文日志行映射兜底；计数只认 ✓ 成功行。
  const evt = handle.uiEvents.push(message);
  if (evt) {
    if (evt.account) {
      // 账号标签兜底链：平台昵称（navigate 身份路径才有）> AdsPower 环境名 > 渲染层再兜尾4位。
      const name = evt.account.name || handle.name || '';
      handle.status.account = { id: evt.account.id, name, source: evt.account.name ? 'xhs' : 'env' };
      // 身份确立 = 登录态权威信号（核心读不出登录身份会诚实退出、不会走到这行），据此翻登录态。
      // adspower 路径此前无人写 'logged in'（cookie 门是 self 专属），人设闸因此永不开——修于本 change。
      next.auth = 'logged in';
      refreshSameAccountWarnings();
    }
    // 已绑人设信号（change persona-wizard-onboarding-fixes）：云端仅在已绑时下发（sticky true）。
    if (evt.personaBound === true) next.personaBound = true;
    if (evt.presence) next.presence = { text: evt.presence, at: new Date().toISOString() };
    if (evt.publish && evt.publish.state) {
      next.publish = { ...evt.publish, at: new Date().toISOString() };
      // 发布成功即更新「最近一次发布」并落盘（发布卡常驻的历史态，重启不丢）。
      if (evt.publish.state === 'published') {
        const baseStats = next.stats ? mergeStats(handle.status.stats, next.stats) : handle.status.stats;
        next.stats = { ...(next.stats || {}), publishes: cleanCount(baseStats.publishes) + 1 };
        next.dailyUsage = bumpDailyUsage(next.dailyUsage || handle.status.dailyUsage, 'publish', 1);
      }
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
    if (evt.dailyUsage) {
      const dailyUsage = normalizeDailyUsage(evt.dailyUsage);
      if (dailyUsage) {
        next.dailyUsage = dailyUsage;
        next.stats = statsFromDailyUsage(dailyUsage);
      }
    }
    if (evt.statsDelta) {
      const d = evt.statsDelta;
      const baseStats = next.stats ? mergeStats(handle.status.stats, next.stats) : handle.status.stats;
      let dailyUsage = next.dailyUsage || handle.status.dailyUsage;
      next.stats = {
        ...(next.stats || {}),
        ...(d.views ? { views: cleanCount(baseStats.views) + cleanCount(d.views) } : {}),
        ...(d.likes ? { likes: cleanCount(baseStats.likes) + cleanCount(d.likes) } : {}),
        ...(d.collects ? { collects: cleanCount(baseStats.collects) + cleanCount(d.collects) } : {}),
        ...(d.comments ? { comments: cleanCount(baseStats.comments) + cleanCount(d.comments) } : {}),
        ...(d.follows ? { follows: cleanCount(baseStats.follows) + cleanCount(d.follows) } : {}),
        ...(d.publishes ? { publishes: cleanCount(baseStats.publishes) + cleanCount(d.publishes) } : {}),
      };
      if (d.views) dailyUsage = bumpDailyUsage(dailyUsage, 'view', d.views);
      if (d.likes) dailyUsage = bumpDailyUsage(dailyUsage, 'like', d.likes);
      if (d.collects) dailyUsage = bumpDailyUsage(dailyUsage, 'collect', d.collects);
      if (d.comments) dailyUsage = bumpDailyUsage(dailyUsage, 'comment', d.comments);
      if (d.follows) dailyUsage = bumpDailyUsage(dailyUsage, 'follow', d.follows);
      if (d.publishes) dailyUsage = bumpDailyUsage(dailyUsage, 'publish', d.publishes);
      if (dailyUsage) next.dailyUsage = dailyUsage;
    }
    if (evt.sentence) {
      broadcastActivity(handle, {
        ts: new Date().toISOString(),
        type: evt.type || 'info',
        sentence: evt.sentence,
        ...(evt.loopStage !== undefined ? { loopStage: evt.loopStage } : {}),
      });
    }
    if (evt.loopStage !== undefined) next.loopStage = evt.loopStage;
    // 阻断浮层（登录/验证码/未知阻断）待人工处理：核心成对信号驱动（`popup` 置真 / `popup_cleared`
    // 或会话结束或有成功互动 置假），使该环境在环境栏浮顶为「需人工」而非绿色在线（红线：多环境跨窗
    // 盯验证码正是本控制台的核心目的）。
    if (evt.type === 'popup') next.overlayBlocked = true;
    else if (evt.type === 'popup_cleared' || evt.type === 'session_end' || evt.statsDelta) next.overlayBlocked = false;
  }
  updateStatus(handle, next);
}

function pauseEdge(handle) {
  if (!handle) return;
  if (handle.coreParked || handle.pausePending) return;
  // 暂停取消任何在途重启/重起，并置取消闸：排队等待中的启动（尚无子进程、SIGTERM 无处可发）到点
  // 也不再拉起，杜绝「暂停被排队启动静默覆盖回运行」。
  handle.restartPending = false;
  handle.stopRequested = true;
  stopLoginPoller(); // self 路径的 5s 登录轮询若在跑，暂停期间应停（否则空转、每 tick 被取消闸挡下）
  clearRespawnTimer(handle);
  if (handle.child) {
    const child = handle.child;
    const previousSession = handle.status.session;
    handle.pausePending = true;
    updateStatus(handle, {
      session: 'paused',
      overlayBlocked: false,
      lastMessage: '正在暂停自动运营，浏览器将保持打开…',
      ...presencePatch('正在暂停，浏览器将保持打开'),
      ...clearEdgeFailurePatch(handle),
    });
    sendCoreLifecycle(handle, 'pause', (error) => {
      if (handle.child !== child) return;
      handle.pausePending = false;
      handle.stopRequested = false;
      updateStatus(handle, {
        edge: 'warning',
        session: previousSession === 'paused' ? 'running' : previousSession,
        lastMessage: `暂停失败：${error.message}。自动运营可能仍在运行，浏览器未被关闭。`,
        ...edgeFailurePatch(`暂停失败：${error.message}`),
        ...presencePatch('暂停请求未送达，请重试'),
      });
    });
    return;
  }
  // 无核心（如重起退避窗口）只暂停后续拉起；此时没有可被误关的 owned browser 句柄。
  updateStatus(handle, {
    edge: 'stopped',
    session: 'paused',
    overlayBlocked: false,
    lastMessage: '已暂停自动启动；当前没有运行中的边缘进程。',
    ...presencePatch('已暂停，随时可以恢复'),
    ...clearEdgeFailurePatch(handle),
  });
}

function resumeEdge(handle) {
  if (!handle) return;
  handle.stopRequested = false;
  clearRespawnTimer(handle);
  if (handle.child && (handle.coreParked || handle.pausePending || handle.status.session === 'paused')) {
    const child = handle.child;
    handle.restartPending = true;
    updateStatus(handle, {
      edge: 'starting',
      cloud: 'disconnected',
      session: 'running',
      lastMessage: '正在复用已打开的浏览器恢复自动运营…',
      ...presencePatch('正在恢复引擎…'),
      ...clearEdgeFailurePatch(handle),
    });
    sendCoreLifecycle(handle, 'resume', (error) => {
      if (handle.child !== child) return;
      handle.restartPending = false;
      handle.pausePending = false;
      handle.coreParked = true;
      handle.stopRequested = true;
      updateStatus(handle, {
        edge: 'stopped',
        session: 'paused',
        lastMessage: `恢复失败：${error.message}。浏览器仍保持打开。`,
        ...edgeFailurePatch(`恢复失败：${error.message}`),
        ...presencePatch('恢复请求未送达，仍保持暂停'),
      });
    });
    return;
  }
  stopAndRestart(handle, '已请求恢复，正在按当前浏览器设置重启边缘进程。');
}

function closeEdge(handle) {
  if (!handle || handle.closePending || handle.status.session === 'closed') return;
  handle.restartPending = false;
  handle.stopRequested = true;
  stopLoginPoller();
  clearRespawnTimer(handle);
  if (!handle.child) {
    handle.coreParked = false;
    updateStatus(handle, {
      edge: 'stopped',
      cloud: 'disconnected',
      session: 'closed',
      overlayBlocked: false,
      lastMessage: '浏览器已关闭。',
      ...presencePatch('已关闭浏览器'),
      ...clearEdgeFailurePatch(handle),
    });
    return;
  }

  const child = handle.child;
  const previousSession = handle.status.session;
  handle.closePending = true;
  updateStatus(handle, {
    lastMessage: '正在关闭浏览器并确认回收…',
    ...presencePatch('正在关闭浏览器…'),
    ...clearEdgeFailurePatch(handle),
  });
  sendCoreLifecycle(handle, 'close', (error) => {
    if (handle.child !== child) return;
    handle.closePending = false;
    handle.stopRequested = previousSession === 'paused';
    updateStatus(handle, {
      edge: handle.coreParked ? 'stopped' : 'warning',
      session: previousSession,
      lastMessage: `关闭失败：${error.message}。浏览器关闭状态未确认。`,
      ...edgeFailurePatch(`关闭失败：${error.message}`),
      ...presencePatch(previousSession === 'paused' ? '关闭失败，仍保持暂停' : '关闭请求未送达'),
    });
  });
}

function relogin(handle) {
  stopAndRestart(handle, '已请求重新登录，正在按当前浏览器设置重启边缘进程。');
  return handle ? handle.status : null;
}

/**
 * 「全部启动」：内存上限预检（headful 每环境 ~1GB vs 本机可用）→ 超限诚实拦阻（force 才放行）→
 * 对全部未在跑环境错峰入队。返回 { ok, queued } 或 { ok:false, reason:'ram', ... }。
 */
function startAllEnvs({ force = false } = {}) {
  const paused = [...envs.values()].filter((h) => h.child && h.status.session === 'paused' && !h.removed);
  const targets = [...envs.values()].filter((h) => !h.child && !h.removed);
  if (targets.length === 0 && paused.length === 0) return { ok: true, queued: 0 };
  const admission = fleet.ramAdmission({ plannedCount: targets.length, freeBytes: os.freemem() });
  if (!admission.ok && !force) {
    return {
      ok: false,
      reason: 'ram',
      requiredMB: admission.requiredMB,
      freeMB: admission.freeMB,
      plannedCount: targets.length,
    };
  }
  paused.forEach((h) => resumeEdge(h));
  targets.forEach((h, i) => queueStartEnv(h, i + 1));
  const all = [...paused, ...targets];
  return { ok: true, queued: all.length, envIds: all.map((h) => h.envId) };
}

/** 「全部停止」（不退出应用）：全部在跑环境按暂停语义错峰停止；处于重起退避窗口（无子进程）的环境
 * 也置暂停 + 清重起定时器，杜绝「全部停止后某个崩溃环境几秒后自行复活」的静默矛盾。 */
function stopAllEnvs() {
  const running = [...envs.values()].filter((h) => h.child && h.status.session !== 'paused' && !h.pausePending);
  const backoff = [...envs.values()].filter((h) => !h.child && h.respawnTimer && !h.removed);
  for (const h of running) pauseEdge(h);
  for (const h of backoff) pauseEdge(h); // clearRespawnTimer + stopRequested 在 pauseEdge 内
  return { ok: true, stopped: running.length + backoff.length };
}

/** 应用退出：对全部在跑环境经串行队列有序 SIGTERM + 有界等待确认退出，不留孤儿。 */
async function gracefulStopAllAndQuit() {
  if (quitStopAllInFlight) return;
  quitStopAllInFlight = true;
  isQuitting = true;
  stopLoginPoller();
  for (const handle of envs.values()) clearRespawnTimer(handle);
  const running = [...envs.values()].filter((h) => h.child);
  for (const handle of running) {
    await queueLifecycle(() => {
      try {
        handle.child?.kill('SIGTERM');
      } catch { /* ignore */ }
    });
  }
  // 有界等待（迭代计数限界，最多 ~10s）：等核心的诚实关机（browser/stop + 确认浏览器死）跑完。
  for (let i = 0; i < 100; i++) {
    if (![...envs.values()].some((h) => h.child)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  quitFinal = true;
  app.quit();
}

function quitApp() {
  app.quit(); // 经 before-quit 统一走优雅全停
}

/** 外壳重启对账：经 browser/active 探已在运行的分身——启动时接管、不重复拉起（防孤儿/防互踢）。 */
async function reconcileRunningProfiles() {
  if (settings.provider !== 'adspower' || envs.size === 0) return;
  const res = await adsApi.listActiveProfiles(resolveAdsOpts()).catch(() => null);
  if (!res || !res.ok) return; // 无法对账（服务未起等）：不猜测、维持默认「未运行」呈现
  const active = new Set(res.activeUserIds);
  for (const handle of envs.values()) {
    if (handle.kind !== 'adspower' || !handle.profileId || handle.child) continue;
    if (!active.has(handle.profileId)) continue;
    handle.browserAlreadyRunning = true;
    updateStatus(handle, {
      lastMessage: '检测到该分身浏览器已在运行（可能为上次会话遗留）；点「启动」将直接接管，不会重复拉起。',
      ...presencePatch('分身浏览器已在运行，待接管'),
    });
  }
}

// ── IPC（全部控制通道带 envId 路由键；缺省落到当前选中环境，兼容旧渲染层）──

function resolveHandle(envId) {
  return (envId && envs.get(envId)) || selectedHandle();
}

function statusOf(handle) {
  if (!handle) return { ...makeStatus(settings.provider), envId: '', envName: '' };
  return { ...handle.status, envId: handle.envId, envName: handle.name };
}

ipcMain.handle('status:get', (_event, envId) => statusOf(resolveHandle(envId)));
ipcMain.handle('edge:pause', (_event, envId) => {
  const handle = resolveHandle(envId);
  pauseEdge(handle);
  return statusOf(handle);
});
ipcMain.handle('edge:resume', (_event, envId) => {
  const handle = resolveHandle(envId);
  resumeEdge(handle);
  return statusOf(handle);
});
ipcMain.handle('edge:close', (_event, envId) => {
  const handle = resolveHandle(envId);
  closeEdge(handle);
  return statusOf(handle);
});
ipcMain.handle('auth:relogin', (_event, envId) => {
  const handle = resolveHandle(envId);
  relogin(handle);
  return statusOf(handle);
});
ipcMain.handle('settings:get', () => ({ ...settings, adsDownloadUrl: ADS_DOWNLOAD_URL }));
ipcMain.handle('settings:save', (_event, patch) => {
  const res = saveSettings(patch);
  syncEnvHandles(); // 花名册变更即同步注册表（新环境建行、移出的有序停止）
  // 保存只持久化、**不打断**在跑的核心（应用改动经显式 edge:restart「按新设置重启」）。
  const handle = selectedHandle();
  if (handle) {
    updateStatus(handle, {
      provider: settings.provider,
      lastMessage: res.ok ? '浏览器设置已保存。' : '设置已应用（本次生效），但写入本地失败，重启应用后可能丢失。',
    });
  }
  return { ...settings, adsDownloadUrl: ADS_DOWNLOAD_URL, saveOk: res.ok, saveError: res.error };
});
// 悬浮「启动」：目标环境未跑则错峰启动；已在跑则不重复启动。
ipcMain.handle('edge:start', (_event, envId) => {
  const handle = resolveHandle(envId);
  if (handle && !handle.child) queueStartEnv(handle);
  return statusOf(handle);
});
// 「按新设置重启」：显式应用已保存的设置到在跑核心（有序重启，不由保存隐式打断）。
ipcMain.handle('edge:restart', (_event, envId) => {
  const handle = resolveHandle(envId);
  stopAndRestart(handle, '正在按新设置重启边缘进程…');
  return statusOf(handle);
});
// ── fleet 控制面 ──
ipcMain.handle('fleet:get', () => fleetSnapshot());
ipcMain.handle('fleet:select', (_event, envId) => {
  if (envId && envs.has(envId)) {
    selectedEnvId = envId;
    saveSettings({ selectedEnvId: envId });
    applyOverlayTone(selectedHandle()?.status.risk || 'normal');
    broadcastFleet();
  }
  return fleetSnapshot();
});
ipcMain.handle('fleet:startAll', (_event, opts) => startAllEnvs(opts || {}));
ipcMain.handle('fleet:stopAll', () => stopAllEnvs());
ipcMain.handle('fleet:setRailCollapsed', (_event, collapsed) => {
  saveSettings({ railCollapsed: Boolean(collapsed) });
  return { ok: true };
});
// 「打开飞书 ↗」：纯导航（拉起飞书客户端），不是审批操作——审批授权只在飞书内完成。
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
ipcMain.handle('browser:showDriven', (_event, envId) => sendBrowserParkingCommand(resolveHandle(envId), 'browser.show'));
ipcMain.handle('browser:resetParking', (_event, envId) => sendBrowserParkingCommand(resolveHandle(envId), 'browser.park'));
// 建号自助人设（change edge-persona-keyword-generation）：渲染层选关键词 → 云端生成草稿 / 确认落库。
// envId 路由（多环境）：草稿属哪个环境就 persist 到哪个环境，杜绝中途切换环境把人设写进别的账号。
ipcMain.handle('persona:generate', (_event, envId, payload) => sendPersonaCommand(envId, 'persona.generate', payload));
ipcMain.handle('persona:persist', async (_event, envId, payload) => {
  const result = await sendPersonaCommand(envId, 'persona.persist', payload);
  if (result && result.ok === true) {
    const handle = envId ? envs.get(envId) : selectedHandle();
    if (handle) updateStatus(handle, { personaBound: true });
  }
  return result;
});
ipcMain.handle('notify:show', (_event, payload) => {
  const title = payload && typeof payload.title === 'string' ? payload.title : 'AIDCP Edge';
  const body = payload && typeof payload.body === 'string' ? payload.body : '';
  surfaceNotification(title, body);
  return { ok: true };
});
// AdsPower 只读探测 / 拉取（主进程侧，渲染层不直连本地 API）。opts 可带渲染层当前表单 apiKey/apiBase/groupId。
ipcMain.handle('ads:status', (_event, opts) => adsApi.status(resolveAdsOpts(opts)));
// 「选择已有环境」拉分身列表：先确保服务就绪（冷机会启动随包运行时），再拉列表——
// 否则裸抛「本地 API 不可达(fetch failed)」。确保失败则诚实回错（面板据此提示手动填分身 ID）。
ipcMain.handle('ads:listProfiles', async (_event, opts) => {
  const svc = await ensureAdsServiceOnce(null);
  if (!svc.ok) return { ok: false, error: `指纹浏览器运行时未就绪：${svc.error || '未知错误'}` };
  return adsApi.listProfiles(resolveAdsOpts(opts));
});
ipcMain.handle('ads:openCreate', () => openAdsClient());

// ── 「创建环境」程序化建号（change adspower-auto-create-env）：写客户端 allowlist + 指纹引擎 + 编排 ──
const envGroupResolver = createEnvGroupResolver({ adsApi, groupName: ENV_GROUP_NAME });
let adsCreateInFlight = false; // 进程级单飞互斥（防连点双建）

function templateLabel(t) {
  const osName = t.os === 'windows' ? 'Windows' : t.os === 'macos' ? 'Mac' : t.os;
  return `${osName} · ${t.hardwareConcurrency}核 ${t.deviceMemory}G`;
}

// 整机模板清单（供渲染层下拉，一处真源）。
ipcMain.handle('ads:templates', () =>
  adsFingerprint.DEVICE_TEMPLATES.map((t) => ({ key: t.key, label: templateLabel(t) })),
);

// 程序化建一个指纹环境。opts: { templateKey, apiKey?, apiBase?, proxy?, facebookAccountImport? }。
// 代理可选（缺省 no_proxy）；FB 支持批量账号导入（每行一个环境，共用同一份代理输入）。
ipcMain.handle('ads:createEnv', async (_event, opts) => {
  if (adsCreateInFlight) return { ok: false, error: '创建进行中，请等当前创建完成' };
  adsCreateInFlight = true;
  try {
    // 先确保指纹浏览器服务就绪（仅服务、不下内核）——冷机不再裸抛 group/create 的 fetch failed。
    const svc = await ensureAdsServiceOnce(null);
    if (!svc.ok) {
      return { ok: false, error: `指纹浏览器运行时未就绪：${svc.error || '未知错误'}`, retryable: true };
    }
    const ads = resolveAdsOpts(opts);
    const platform = normalizePlatform(opts && opts.platform);
    const importText = platform === 'facebook' ? (opts && opts.facebookAccountImport) : '';
    const parsedImport = parseFacebookAccountImport(importText);
    if (!parsedImport.ok) return { ok: false, error: parsedImport.error };
    // 凭据只内存（deps），绝不落 settings；写客户端错误层已脱敏。
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    const entries = parsedImport.entries || [];
    if (entries.length === 0) {
      return await createEnvironmentWithGroupRecovery({
        writeApi,
        adsApi,
        fingerprint: adsFingerprint,
        adsOpts: ads,
        templateKey: (opts && opts.templateKey) || '',
        intendedAccountLabel: opts && opts.intendedAccountLabel,
        machineLabel: os.hostname(),
        platform,
        proxy: opts && opts.proxy, // 原始表单输入；归一/校验在 create-flow 的归一层做
        groupResolver: envGroupResolver,
      });
    }

    const created = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const result = await createEnvironmentWithGroupRecovery({
        writeApi,
        adsApi,
        fingerprint: adsFingerprint,
        adsOpts: ads,
        templateKey: (opts && opts.templateKey) || '',
        intendedAccountLabel: '',
        machineLabel: os.hostname(),
        platform,
        name: profileNameForFacebookImport(entry, i),
        accountImport: entry,
        proxy: opts && opts.proxy, // 批量导入的每个环境共用同一份代理输入
        groupResolver: envGroupResolver,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: `第 ${i + 1} 行创建失败：${result.error || '未知错误'}`,
          created,
        };
      }
      created.push({
        userId: result.userId,
        template: result.template,
        platform: result.platform,
      });
    }
    return {
      ok: true,
      userId: created.length === 1 ? created[0].userId : undefined,
      template: (opts && opts.templateKey) || '',
      platform,
      created,
      createdCount: created.length,
    };
  } catch (e) {
    return { ok: false, error: `创建失败：${(e && e.message) || String(e)}` };
  } finally {
    adsCreateInFlight = false;
  }
});

// 改已有环境代理（edge-client-proxy-platform-persona-ux）：归一层校验 → 写客户端受限 user/update
// （body 只含 user_id + user_proxy_config 两键）。密码只内存流转、不落盘、日志已脱敏。
ipcMain.handle('ads:updateEnvProxy', async (_event, opts) => {
  const userId = opts && opts.userId;
  if (!userId) return { ok: false, error: '缺 userId' };
  const norm = normalizeProxyInput((opts && opts.proxy) || {});
  if (!norm.ok) return { ok: false, error: `代理输入不合法：${norm.error}` };
  try {
    const svc = await ensureAdsServiceOnce(null);
    if (!svc.ok) return { ok: false, error: `指纹浏览器运行时未就绪：${svc.error || '未知错误'}`, retryable: true };
    const ads = resolveAdsOpts(opts);
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    const r = await writeApi.updateProfileProxy({ userId: String(userId), proxyConfig: norm.proxyConfig }, ads);
    if (r && r.ok === false && /being used|being opened|is open|正在使用|已打开/i.test(String(r.error || ''))) {
      return { ok: false, error: '该环境正在使用中，无法修改代理；请先关闭该环境后重试。' };
    }
    if (r && r.ok) return { ok: true, noProxy: norm.noProxy };
    return r;
  } catch (e) {
    return { ok: false, error: `修改代理失败：${(e && e.message) || String(e)}` };
  }
});

// 删除环境（C3 放宽为 UI 确认删）：仅由渲染层逐个显式二次确认触发；本处不自动、不批量。
ipcMain.handle('ads:deleteEnv', async (_event, opts) => {
  const userId = opts && opts.userId;
  if (!userId) return { ok: false, error: '缺 userId' };
  try {
    const svc = await ensureAdsServiceOnce(null);
    if (!svc.ok) return { ok: false, error: `指纹浏览器运行时未就绪：${svc.error || '未知错误'}`, retryable: true };
    const ads = resolveAdsOpts(opts);
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    const r = await writeApi.deleteProfile(String(userId), ads);
    // 环境正打开/被占用时服务端拒删，原始报错含空 user 列表([])且暴露方案名——转中性友好文案。
    if (r && r.ok === false && /being used|being opened|cannot be deleted|is open|正在使用|已打开/i.test(String(r.error || ''))) {
      return { ok: false, error: '该环境正在使用中（可能已在其它设备或窗口打开），无法删除；请先关闭该环境后重试。' };
    }
    return r;
  } catch (e) {
    return { ok: false, error: `删除失败：${(e && e.message) || String(e)}` };
  }
});

// 单实例锁（edge-multi-environment-fleet 语义重写）：一台机只跑**一个监督者**，其下并行托管 N 个环境。
// 第二个监督者实例会与第一个抢环境子进程与浏览器（同 edgeId 双拉 → 云端互踢），故仍然拒绝；
// 多账号并行请在已运行的这个实例里把多个环境加入花名册。
if (!app.requestSingleInstanceLock()) {
  try {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'AIDCP Edge 已在运行',
      '本机已有一个 AIDCP Edge 监督者在运行（一台机一个监督者、其下可并行托管多个环境）。请在已运行的窗口里把要跑的环境加入花名册，不要重复启动应用。',
    );
  } catch {
    /* best-effort */
  }
  app.quit();
} else {
  // 又有人想开第二个：Electron 通知已运行实例——把窗口拉到前台 + 通知。
  app.on('second-instance', () => {
    surfaceFailure('AIDCP Edge 已在运行', '已有一个 AIDCP Edge 监督者在运行，已切到该窗口。多环境请在环境栏 / 设置里加入并行运行。');
  });

  app.whenReady().then(() => {
    loadSettings();
    if (settings.selectedEnvId) selectedEnvId = settings.selectedEnvId;
    syncEnvHandles();
    loadUiState();
    // 不自动启动任务（用户手动点「启动」才开跑）。只做一次轻量预检：
    // 缺配置时把「待配置」引导亮出来，配置齐备则诚实呈现「就绪」。
    for (const handle of envs.values()) {
      if (handle.kind === 'adspower' && !handle.profileId) {
        updateStatus(handle, {
          auth: 'config required',
          lastMessage: '待配置：请在设置中加入浏览器环境后点「启动」。',
          ...presencePatch('等待完成初始设置'),
        });
      } else {
        updateStatus(handle, {
          lastMessage: '就绪。点右下角「启动」开始自动运营。',
          ...presencePatch('就绪，等你点「启动」'),
        });
      }
    }
    if (settings.provider === 'adspower' && envs.size === 0) {
      // 空花名册：无 handle 可投影，广播 fleet 快照让渲染层呈现「待加入环境」空态。
      broadcastFleet();
    }
    createWindow();
    createTray();
    // 外壳重启对账（异步 best-effort）：已在运行的分身如实标出，启动时接管、不重复拉起。
    void reconcileRunningProfiles();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow?.show();
    });
  });
}

// 监督者级兜底：多环境下监督者进程是全部环境 UI/控制的单点。未捕获异常若让进程崩溃，会连累
// 全部在跑兄弟环境（破坏崩溃隔离——子进程的云端工作虽独立，但外壳一崩用户就失去可见/可控）。
// 故兜住未捕获异常/拒绝：落文件 + 弹一次通知，绝不静默、也绝不整体退出。子进程各自的 'error'/'exit'
// 已单独诚实处理其失败，这里只防外壳自身的意外崩溃。
process.on('uncaughtException', (err) => {
  try { appendEdgeLog('supervisor', `uncaughtException: ${(err && err.stack) || err}`, true); } catch { /* ignore */ }
  try { surfaceFailure('AIDCP Edge 监督者遇到内部错误', `已记录并继续运行其余环境：${(err && err.message) || err}`); } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  try { appendEdgeLog('supervisor', `unhandledRejection: ${(reason && reason.stack) || reason}`, true); } catch { /* ignore */ }
});

app.on('before-quit', (event) => {
  if (quitFinal) return; // 优雅全停已完成，放行退出
  isQuitting = true;
  const anyRunning = [...envs.values()].some((h) => h.child);
  if (!anyRunning) {
    quitFinal = true;
    return;
  }
  // 有在跑环境：拦下本次退出，先优雅全停（错峰 SIGTERM + 有界等待），完成后再真正退出。
  event.preventDefault();
  void gracefulStopAllAndQuit();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
