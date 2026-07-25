const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, Notification, shell, screen, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  CustomerAuthResponseError,
  readBoundedJsonResponse,
  safeStorageAvailable,
  sealClientSession,
  unsealClientSession,
  isEncryptedClientSessionRecord,
  writePrivateJsonAtomic,
} = require('./customer-auth-security.cjs');
const { restoreClientAuthAtStartup } = require('./client-startup-auth.cjs');
const { hasXhsCookie, launchChrome } = require('./chrome-launcher.cjs');
const { createAdsLocalApi } = require('./ads-local-api.cjs');
const { readWithRuntimeRecovery } = require('./ads-read-runtime.cjs');
const { createAdsWriteApi } = require('./ads-write-api.cjs');
const adsRuntime = require('./ads-runtime.cjs');
const adsRuntimeStage = require('./ads-runtime-stage.cjs');
const adsFingerprint = require('./ads-fingerprint.cjs');
const { normalizePlatform } = require('./ads-create-flow.cjs');
const { normalizeProxyInput, parseProxyLines } = require('./ads-proxy-config.cjs');
const {
  createProxyReassignmentPlan,
  proxyReassignmentFailure,
  validateProxyTargetScope,
  executeProxyReassignmentPlan,
} = require('./ads-proxy-reassignment.cjs');
const {
  ENV_GROUP_NAME,
  createEnvGroupResolver,
  createEnvironmentWithGroupRecovery,
} = require('./ads-create-env-service.cjs');
const {
  parseFacebookAccountImport,
  profileNameForFacebookImport,
} = require('./facebook-account-import.cjs');
const {
  createFacebookBatchPlan,
  failedFacebookBatchReceipt,
} = require('./facebook-batch-create.cjs');
const {
  buildFacebookSelectedPersona,
  requestFacebookSelectedPersonaFill,
} = require('./facebook-persona-auto-fill.cjs');
const os = require('node:os');
const { createUiEventStream, mergeStats } = require('./ui-events.cjs');
const commandDiagnostics = require('./command-diagnostics.cjs');
const { normalizeProxyRuntime } = require('./proxy-runtime.cjs');
const { createProxyPreflightController } = require('./proxy-preflight.cjs');
const {
  DEFAULT_PARKING_MODE,
  normalizeParkingMode,
  computeBrowserParkingPlan,
  clientAlignedBrowserBounds,
  parkingEnv,
} = require('./browser-parking.cjs');
const {
  DEFAULT_BROWSER_COLD_STANDBY_ENABLED,
  DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS,
  DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS,
  normalizeColdStandbySettings,
  shouldEnterColdStandby,
  normalizeBrowserStandbyHint,
} = require('./browser-cold-standby.cjs');
const fleet = require('./fleet.cjs');
const { createCoreBootstrapSupervisor } = require('./core-bootstrap.cjs');
const {
  browserPersonaNoticeForStatus,
  browserPersonaNoticeKey,
} = require('./persona-notice.cjs');
const { validatePersonaKeywordSelections } = require('./persona-request-validation.cjs');
const { resolveTrayIconPath } = require('./tray-icon.cjs');
const { verifyNativePageEngineArtifact } = require('./native-page-engine-artifact.cjs');

// ── 实例级 userData 隔离（change edge-multi-instance-userdata-isolation）──────
// 同机并行多个监督者（如一个连 dev、一个连 ol）时，各实例需独立的单实例锁 /
// 设置(名册) / 界面状态 / 日志 / 内置运行时落地目录——它们全部从 userData 派生。
// 设了 AIDCP_USER_DATA_DIR 就把 userData 指到该目录；未设则用默认目录、行为逐字不变（零回归）。
// 必须在 requestSingleInstanceLock() 与任何 app.getPath('userData') 之前设置：锁文件落在 userData，
// 且所有 userData 派生路径读取均为 whenReady 之后的懒调用，故模块顶部此处即满足顺序约束。
{
  const instanceUserDataDir = (process.env.AIDCP_USER_DATA_DIR || '').trim();
  if (instanceUserDataDir) {
    app.setPath('userData', instanceUserDataDir);
  }
}

// 主进程侧 AdsPower 客户端（探测 + 环境列表 + 在跑分身对账 + 具名人工查看打开）。
// 单例持有本进程内**唯一**串行节流（1req/s）；人工查看只开放 V2 browser-profile/start，不开放 stop / 通用写入口。
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
// 稿件预览审批桥：渲染层动作经目标环境 core stdin → cloud WS → stdout 回执。
const publishApprovalPending = new Map(); // id -> { resolve, timer }
let publishApprovalSeq = 0;
// 环境头像“显示在 AIDCP 下方”桥：core 完成 setBounds + bringToFront 后回一条关联回执，
// Electron 再把自己的主窗抬回最前。固定 sleep 会与不同机器/CDP 时序竞态，故只认具名完成回执。
const browserShowPending = new Map(); // id -> { envId, resolve, timer }
const BROWSER_PARKING_REPLY_PREFIX = '[browser-parking-reply]';
const BROWSER_SHOW_COMPLETION_TIMEOUT_MS = 3000;
let isQuitting = false;
// 优雅全停已完成、允许本次 quit 直落（before-quit 二次进入不再拦截）。
let quitFinal = false;
let quitStopAllInFlight = false;
// 运行时确保后解析出的 Local API base（非默认端口时覆盖 AIDCP_ADS_API_BASE 喂核心）；
// 这是主进程读写 + 全部核心子进程的**单一 base 权威**（P0-A：resolveAdsOpts 亦优先采用它，
// 杜绝「解析出非 50325 端口、主进程却仍发 50325」的串台）。未确保前保持 null，回落 settings.adsApiBase 或核心默认 50325。
let adsServiceBase = null;
// 本次 Electron 进程已启动或接管的 Ads CLI daemon；真正退出时必须有界 stop。
let managedAdsRuntime = null;
// 每个 Electron 会话第一次成功建立托管运行时前，先经 CLI 自身 status/stop 清理登记 daemon。
// 只有 ensureRuntime 成功后才提交该标记；预热半途失败时，真实动作仍会重试而不是接管半成品。
let adsRuntimeSessionResetComplete = false;

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
// ── 云端目标选择 ───────────────────────────────────────────────────────────────
// 正式环境把 request-scoped 客户数据 API 与自动化 WebSocket 作为两个独立端点映射；custom 也分别配置。
// AIDCP_CLOUD_URL 只代表自动化通道，绝不被解释成“客户端全局云端连接”。
const CLOUD_ENV_URLS = { dev: 'ws://121.89.85.150:8787', ol: 'ws://123.56.253.183:8787' };
const CLIENT_AUTH_ENV_URLS = { dev: 'http://121.89.85.150:8088/capi', ol: 'https://aidcp.tommax.cc/capi' };
// 构建期烘焙的缺省云端环境：分发包用 electron-builder `-c.extraMetadata.aidcpCloudDefaultEnv=ol`
// 注入 'dev' | 'ol'，让「无界面选择、无启动环境变量」时连指定云（如线上分发包默认 ol）。
// 普通开发 / CI 包不带此字段 → '' → 沿用历史缺省 dev（零回归）。只读打包进 app 的 package.json；
// 读失败或字段非法即回落 ''。dev(electron .) 下 getAppPath 是仓库根、package.json 无此字段 → 不受影响。
function readBakedDefaultCloudEnv() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    const v = String((pkg && pkg.aidcpCloudDefaultEnv) || '').trim();
    return v === 'dev' || v === 'ol' ? v : '';
  } catch {
    return '';
  }
}
const BAKED_DEFAULT_CLOUD_ENV = readBakedDefaultCloudEnv();
function normalizeClientAuthUrl(value) {
  const v = String(value || '').trim();
  return /^https?:\/\//i.test(v) ? v.replace(/\/+$/, '') : '';
}
// 构建期烘焙的对外客户鉴权地址（change edge-client-customer-auth）：分发包用
// electron-builder `-c.extraMetadata.aidcpClientAuthUrl=https://…/capi` 注入，让分发的客户端「一装即带登录门」，
// 无需运营 / 客户手填环境变量。只读打包进 app 的 package.json；非法 / 缺失 → ''，随后按 dev/ol 环境默认地址启用登录门。
// dev(electron .) 下 getAppPath 是仓库根、package.json 无此字段 → 不受影响。
function readBakedClientAuthUrl() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    const v = String((pkg && pkg.aidcpClientAuthUrl) || '').trim();
    return normalizeClientAuthUrl(v);
  } catch {
    return '';
  }
}
const BAKED_CLIENT_AUTH_URL = readBakedClientAuthUrl();
const DEFAULT_CLOUD_URL = CLOUD_ENV_URLS[BAKED_DEFAULT_CLOUD_ENV] || CLOUD_ENV_URLS.dev;
const CLOUD_ENV_LABELS = { dev: 'dev', ol: 'ol（线上）', custom: '自定义', '': '默认' };
function isWsUrl(u) {
  return /^wss?:\/\//i.test(String(u || '').trim());
}
// 地址 → 展示 key（供「当前连的是哪个云」常驻显示；未知地址归 custom、空归 ''）。
function cloudKeyForUrl(url) {
  const u = String(url || '').trim();
  if (u === CLOUD_ENV_URLS.dev) return 'dev';
  if (u === CLOUD_ENV_URLS.ol) return 'ol';
  return u ? 'custom' : '';
}

const DEFAULT_SETTINGS = {
  provider: 'adspower',
  environments: [],
  // 客户归属环境默认入册后的显式 opt-out。owner 由主进程绑定当前登录客户，renderer 只能提交 envKey 集合。
  clientRosterExclusionOwner: '',
  clientRosterExcludedEnvIds: [],
  adsProfileId: '',
  adsApiKey: '',
  adsApiBase: '',
  adsProfileName: '',
  platform: 'xiaohongshu',
  // 云端环境选择（change edge-cloud-env-selector）：'' = 未选择（跟随启动环境变量 / 缺省 dev，零回归）；
  // 'dev' | 'ol' 用映射地址；'custom' 用 cloudUrlCustom。
  cloudEnvKey: '',
  cloudUrlCustom: '',
  // 浏览器窗口停放：默认主屏停放（窗口停在主屏可靠可见的背景位、不抢焦点，不用最小化/headless）。
  browserParkingMode: DEFAULT_PARKING_MODE,
  // 长等待冷待机：默认开启；由云端给确定性长等待 hint，壳本地二次判断后关闭浏览器并预热恢复。
  browserColdStandbyEnabled: DEFAULT_BROWSER_COLD_STANDBY_ENABLED,
  browserColdStandbyMinWaitMs: DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS,
  browserColdStandbyWarmupMs: DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS,
  // 浏览器调度（change browser-slot-scheduling）：两个上限都可在设置里显式给定，0 = 未设 = 自动。
  //  - browserSlotLimit：同时执行的浏览器数上限。自动 = ⌊Edge 启动时可用内存快照 ÷ 单环境估值⌋。
  //  - maxQueuedStartLimit：尚未执行的启动/唤醒请求上限。自动 = 2 × 浏览器并发。
  // 环境创建数量与这两个运行容量解耦，不设上限。
  browserSlotLimit: 0,
  maxQueuedStartLimit: 0,
  // 「开发者详情」（原始日志区）默认不展示，在设置抽屉里开关（客户版首屏零技术噪音）。
  devDetails: false,
  // 环境栏（fleet rail）收起态与上次选中环境（跨重启保留）。
  railCollapsed: true,
  selectedEnvId: '',
  // 对外客户鉴权登录门：dev/ol 默认启用；clientAuthUrl 给完整 http(s):// 地址时覆盖默认地址。
  // clientAuthEnabled=true 仅用于 custom 云端由主机派生客户鉴权地址。
  clientAuthUrl: '',
  clientAuthEnabled: false,
  // 仅保存 Cloud 已受理的解绑清理游标与短期清理凭证。该凭证只在 Electron main 中使用，
  // settings:get 会剥离；Cloud tombstone 前绝不物理删除本地环境。
  pendingInteractionOffboards: [],
};
let settings = { ...DEFAULT_SETTINGS };

const INTERACTION_OFFBOARD_STATES = new Set(['pending_edge', 'dispatched', 'tombstoned', 'purged']);
const INTERACTION_OFFBOARD_REASONS = new Set(['environment_unbind', 'customer_terminated', 'admin_revoked']);
function normalizePendingInteractionOffboards(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const offboardId = String((raw && raw.offboardId) || '').trim();
    const envKey = String((raw && raw.envKey) || '').trim();
    const accountId = String((raw && raw.accountId) || '').trim();
    const state = String((raw && raw.state) || '').trim();
    const reason = String((raw && raw.reason) || '').trim();
    if (!offboardId || !envKey || !accountId || seen.has(offboardId)
      || !INTERACTION_OFFBOARD_STATES.has(state) || !INTERACTION_OFFBOARD_REASONS.has(reason)) continue;
    seen.add(offboardId);
    out.push({
      offboardId,
      envKey,
      accountId,
      state,
      reason,
      requestedAt: Math.max(0, Number(raw.requestedAt) || 0),
      purgeDueAt: Math.max(0, Number(raw.purgeDueAt) || 0),
      platform: normalizePlatform(raw.platform),
      cleanupGrant: typeof raw.cleanupGrant === 'string' ? raw.cleanupGrant.trim() : '',
      cleanupGrantExpiresAt: Math.max(0, Number(raw.cleanupGrantExpiresAt) || 0),
      cleanupEdgeId: typeof raw.cleanupEdgeId === 'string' ? raw.cleanupEdgeId.trim() : '',
    });
  }
  return out;
}

function normalizeClientRosterExcludedEnvIds(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const envKey = String(raw || '').trim();
    if (!envKey || seen.has(envKey)) continue;
    seen.add(envKey);
    out.push(envKey);
  }
  return out;
}

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
  normalizeColdStandbySettingsIntoSettings();
  normalizeSlotSettingsIntoSettings();
  // 花名册迁移（向后兼容）：旧单值 adsProfileId → 单元素花名册；镜像回写旧字段（回滚兼容）。
  settings.environments = fleet.migrateEnvironments(parsed && typeof parsed === 'object' ? { ...parsed, environments: settings.environments } : settings);
  settings.pendingInteractionOffboards = normalizePendingInteractionOffboards(settings.pendingInteractionOffboards);
  settings.clientRosterExclusionOwner = String(settings.clientRosterExclusionOwner || '').trim();
  settings.clientRosterExcludedEnvIds = normalizeClientRosterExcludedEnvIds(settings.clientRosterExcludedEnvIds);
  applyLegacyMirror();
  normalizeCloudSettings();
  return settings;
}

// 归一化云端选择（loadSettings / saveSettings 共用）：非法 key 归 ''；custom 地址去空白；
// custom 选了但地址非法 → 降级为「未选择」，绝不注入垃圾地址（诚实回落，不静默连坏地址）。
function normalizeCloudSettings() {
  const key = settings.cloudEnvKey;
  if (key !== 'dev' && key !== 'ol' && key !== 'custom') settings.cloudEnvKey = '';
  settings.cloudUrlCustom = String(settings.cloudUrlCustom || '').trim();
  settings.clientAuthUrl = normalizeClientAuthUrl(settings.clientAuthUrl);
  if (
    settings.cloudEnvKey === 'custom'
    && (!isWsUrl(settings.cloudUrlCustom) || !settings.clientAuthUrl)
  ) settings.cloudEnvKey = '';
}

// 解析自动化引擎应连接的 WebSocket：界面选择优先 > 启动环境变量 AIDCP_CLOUD_URL > 缺省 dev。
// fromSelection=true 时派生处 MUST 在合并之后显式覆盖继承来的 AIDCP_CLOUD_URL（否则被 processEnv 同名值压过）；
// false 时不注入、沿用继承 / 缺省（零回归）。
function resolveCloudUrl() {
  const key = settings.cloudEnvKey;
  if (key === 'dev' || key === 'ol') return { url: CLOUD_ENV_URLS[key], key, fromSelection: true };
  if (key === 'custom' && isWsUrl(settings.cloudUrlCustom)) {
    return { url: settings.cloudUrlCustom.trim(), key: 'custom', fromSelection: true };
  }
  const env = String(process.env.AIDCP_CLOUD_URL || '').trim();
  if (env) return { url: env, key: cloudKeyForUrl(env), fromSelection: false };
  // 无界面选择、无启动环境变量：回落到构建期烘焙的缺省环境。
  // 烘焙缺省（ol/dev）必须像「界面选择」一样显式下发给核心（fromSelection:true）——否则核心自身
  // 回落 dev，造成「界面显示 ol、实连 dev」（违反 change edge-cloud-env-selector「显示须等于实际连接」红线）。
  // 未烘焙（普通包，BAKED_DEFAULT_CLOUD_ENV==''）→ 保持历史缺省、不显式注入（零回归）。
  if (BAKED_DEFAULT_CLOUD_ENV === 'dev' || BAKED_DEFAULT_CLOUD_ENV === 'ol') {
    return { url: CLOUD_ENV_URLS[BAKED_DEFAULT_CLOUD_ENV], key: BAKED_DEFAULT_CLOUD_ENV, fromSelection: true };
  }
  return { url: DEFAULT_CLOUD_URL, key: 'dev', fromSelection: false };
}

// 供界面常驻显示「目标云端」（当前选择解析出的地址 + 友好名）。
function cloudSelectionView() {
  const r = resolveCloudUrl();
  return { key: r.key, url: r.url, label: CLOUD_ENV_LABELS[r.key] || r.key || '默认', fromSelection: r.fromSelection };
}

// ── 对外客户鉴权登录门（change edge-client-customer-auth）─────────────────────
// 给客户端加一层「客户 name+key 登录」。dev/ol 默认启用登录门；custom 云端仍需显式 URL 或显式派生开关。地址解析：
//   ① 显式完整 URL：env AIDCP_CLIENT_AUTH_URL 或 settings.clientAuthUrl（http(s)://…）；
//   ② 打包 URL：electron-builder extraMetadata.aidcpClientAuthUrl；
//   ③ 官方 dev/ol 默认地址；
//   ④ 显式启用（env AIDCP_CLIENT_AUTH_ENABLE=1 或 settings.clientAuthEnabled）→ 由云端 WS 主机派生
//      ws(s)://host:8787 → http(s)://host:8091（部署经 Nginx 反代时用 ① 给完整 URL）。
// 登录后：客户令牌存 userData/client-session.json（随 AIDCP_USER_DATA_DIR 多实例隔离）；
// 环境栏只显示云端按该客户下发的可见环境（与本地花名册求交，见 syncEnvHandles 的 allowedProfileIds 过滤）。
// 边缘只走 HTTP 到客户鉴权端口，**不改 WS 协议 / hello**（协议零改）。
const CLIENT_AUTH_DEFAULT_PORT = 8091;
let loginWindow = null;
let clientSession = null; // { token, name, expiresAt(ms) } | null
let allowedProfileIds = null; // Set<profileId> | null（null = 未 gated，不过滤）
let allowedEnvironmentPlatforms = new Map(); // envKey -> Cloud 权威 platform；绝不采信 renderer 自报
let allowedEnvironmentControlStates = new Map(); // envKey -> Cloud 权威 binding/persona 投影；不含 accountId
let sessionTimer = null;
let proceededOnce = false;
const CLIENT_SESSION_REFRESH_WINDOW_MS = 5 * 60_000;
// Ordinary Edge children are on-demand automation engines. This supervisor remains only for the
// short-lived, capability-restricted offboard cleanup worker.
const coreBootstrapSupervisor = createCoreBootstrapSupervisor({
  concurrency: Number(process.env.AIDCP_CORE_BOOTSTRAP_CONCURRENCY) || 3,
});

function deriveClientAuthBaseFromCloudUrl(cloud) {
  const m = /^wss?:\/\/([^/:]+)(?::(\d+))?/i.exec(String(cloud || '').trim());
  if (!m) return '';
  const scheme = /^wss:/i.test(cloud) ? 'https' : 'http';
  return `${scheme}://${m[1]}:${CLIENT_AUTH_DEFAULT_PORT}`;
}

function resolveClientAuthBase() {
  // 优先级：显式完整 URL > 构建期烘焙地址 > dev/ol 默认地址 > 显式启用+云端主机派生。
  const explicit = normalizeClientAuthUrl((process.env.AIDCP_CLIENT_AUTH_URL || '') || (settings && settings.clientAuthUrl) || '');
  if (explicit) return explicit;
  if (BAKED_CLIENT_AUTH_URL) return BAKED_CLIENT_AUTH_URL;
  const cloud = resolveCloudUrl();
  const envDefault = CLIENT_AUTH_ENV_URLS[cloud.key];
  if (envDefault) return envDefault;
  const enabled = process.env.AIDCP_CLIENT_AUTH_ENABLE === '1' || Boolean(settings && settings.clientAuthEnabled);
  if (!enabled) return '';
  return deriveClientAuthBaseFromCloudUrl(cloud.url);
}
function clientAuthEnabled() {
  return Boolean(resolveClientAuthBase());
}

function cloudTargetView() {
  const automation = cloudSelectionView();
  return {
    key: automation.key,
    label: automation.label,
    automationUrl: automation.url,
    dataApiUrl: resolveClientAuthBase(),
    fromSelection: automation.fromSelection,
  };
}
function clientSessionFile() {
  return path.join(app.getPath('userData'), 'client-session.json');
}
function clientLoginPrefillFile() {
  return path.join(app.getPath('userData'), 'client-login-prefill.json');
}
function clientLoginPrefillEncryptionAvailable() {
  return safeStorageAvailable(safeStorage);
}
function loadClientLoginPrefill() {
  if (!clientLoginPrefillEncryptionAvailable()) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(clientLoginPrefillFile(), 'utf8'));
    if (!stored || typeof stored.ciphertext !== 'string' || !stored.ciphertext) return null;
    const value = JSON.parse(safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64')));
    if (!value || typeof value.name !== 'string' || !value.name.trim() || typeof value.key !== 'string' || !value.key) return null;
    return { name: value.name, key: value.key };
  } catch {
    return null;
  }
}
function saveClientLoginPrefill({ name, key } = {}) {
  const normalizedName = String(name || '').trim();
  const normalizedKey = String(key || '');
  if (!normalizedName || !normalizedKey || !clientLoginPrefillEncryptionAvailable()) return false;
  try {
    const ciphertext = safeStorage.encryptString(JSON.stringify({ name: normalizedName, key: normalizedKey }));
    const file = clientLoginPrefillFile();
    writePrivateJsonAtomic(file, { version: 1, ciphertext: ciphertext.toString('base64') });
    return true;
  } catch {
    return false;
  }
}
function clearClientLoginPrefill() {
  try { fs.unlinkSync(clientLoginPrefillFile()); } catch { /* already absent / best-effort */ }
}
function loadClientSession() {
  try {
    const file = clientSessionFile();
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const s = unsealClientSession(stored, safeStorage);
    clientSession = s && typeof s.token === 'string' && s.token ? s : null;
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort on filesystems without POSIX modes */ }
    if (clientSession && safeStorageAvailable(safeStorage) && !isEncryptedClientSessionRecord(stored)) {
      saveClientSession(clientSession); // 旧明文/0600 fallback 在系统加密可用时立即迁移。
    }
  } catch {
    clientSession = null;
  }
}
function saveClientSession(s) {
  clientSession = s;
  try { writePrivateJsonAtomic(clientSessionFile(), sealClientSession(s, safeStorage)); } catch { /* best-effort */ }
}
function clearClientSessionRecord() {
  clientSession = null;
  try { fs.unlinkSync(clientSessionFile()); } catch { /* ignore */ }
}
function clearClientSession() {
  clearClientSessionRecord();
  clearClientLoginPrefill();
}
function hasValidSession() {
  return Boolean(clientSession && clientSession.token && (!clientSession.expiresAt || Date.now() < clientSession.expiresAt));
}
// 启动恢复与定时维护共用同一续签闸：缓存令牌可能在启动时仍有效，却早于首次 4 分钟维护到期。
// 非 401 的瞬时失败不销毁仍有效的会话；若请求返回时本地已过期，则立即走统一失效流程。
async function refreshClientSessionInternal(invalidateOnFailure) {
  if (!clientAuthEnabled()) return true;
  if (!hasValidSession()) {
    if (invalidateOnFailure) onSessionInvalid();
    return false;
  }
  if (!clientSession.expiresAt
    || clientSession.expiresAt - Date.now() >= CLIENT_SESSION_REFRESH_WINDOW_MS) return true;
  const rr = await clientAuthFetch('/auth/refresh', { method: 'POST', token: clientSession.token });
  if (rr.status === 200 && rr.data && rr.data.token) {
    saveClientSession({
      token: rr.data.token,
      name: clientSession.name,
      expiresAt: Date.now() + (Number(rr.data.expiresIn) || 900) * 1000,
    });
    return true;
  }
  if (rr.status === 401 || !hasValidSession()) {
    if (invalidateOnFailure) onSessionInvalid();
    return false;
  }
  return true;
}
async function refreshClientSessionIfNeeded() {
  return refreshClientSessionInternal(true);
}
async function clientAuthFetch(pathname, {
  method = 'GET', token, body, idempotencyKey, signal, timeoutMs = 12000,
} = {}) {
  const base = resolveClientAuthBase();
  if (!base) return { status: 0, ok: false, data: null };
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  try {
    // 有界超时：登录/刷新/拉可见环境都经此出口，refreshAllowedEnvironments 现随每次「刷新」列表调用——面板挂起时
    // 绝不能让裸 fetch 无限吊住按钮。超时按 status:0（非 401）处理：refreshAllowedEnvironments 据此保留上次已知集、
    // 不误登出、不清空（与网络抖动同路径）。
    const boundedTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 200000
      ? timeoutMs
      : 12000;
    const timeoutOptions = { signal: AbortSignal.timeout(boundedTimeoutMs) };
    const requestSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutOptions.signal])
      : signal || timeoutOptions.signal;
    const res = await fetch(base + pathname, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: requestSignal,
    });
    let data = null;
    try {
      data = await readBoundedJsonResponse(res);
    } catch (error) {
      if (error instanceof CustomerAuthResponseError) {
        return {
          status: 502,
          ok: false,
          data: {
            error: {
              code: 'WECHAT_SCHEMA_CHANGED',
              message: error.code === 'CUSTOMER_AUTH_RESPONSE_TOO_LARGE'
                ? 'customer-auth 响应超过本地安全上限，已拒绝解析。'
                : 'customer-auth 响应格式不合法，已拒绝解析。',
              requestId: `edge-customer-auth-${Date.now().toString(36)}`,
              retryable: false,
              details: { reason: error.code, ...(error.details || {}) },
            },
          },
          error: error.code,
        };
      }
      throw error;
    }
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    return { status: 0, ok: false, data: null, error: String((e && e.message) || e) };
  }
}

async function establishClientSession(creds) {
  const name = String((creds && creds.name) || '').trim();
  const key = String((creds && creds.key) || '');
  if (!name || !key) return { ok: false, reason: 'invalid_credentials' };
  const r = await clientAuthFetch('/login', { method: 'POST', body: { name, key } });
  if (r.status === 200 && r.data && r.data.token) {
    const ttl = Number(r.data.expiresIn) || 900;
    saveClientLoginPrefill({ name, key });
    saveClientSession({ token: r.data.token, name, expiresAt: Date.now() + ttl * 1000 });
    return { ok: true };
  }
  if (r.status === 429) return { ok: false, reason: 'rate_limited', retryAfter: (r.data && r.data.retryAfter) || 30 };
  if (r.status === 0) return { ok: false, reason: 'network' };
  // 登录侧 401 一律不可区分（防枚举）；停用同样只表现为凭据拒绝。
  return { ok: false, reason: 'invalid_credentials' };
}

const CONTROL_BOOTSTRAP_REASON_ZH = {
  environment_not_owned: '当前客户无权访问该环境',
  binding_unknown: '该环境尚未成功上报过登录账号',
  binding_conflict: '该环境的账号绑定存在跨客户冲突',
  binding_unavailable: '云端账号绑定暂时不可用',
};

/**
 * 浏览器缺席启动的唯一账号来源：customer-auth 的 ownership + persistent binding 联接。
 * renderer、本地环境名/profileId/旧日志一律不参与；任何结构异常都 fail-closed。
 */
async function resolveControlBootstrap(handle) {
  if (!handle || handle.kind !== 'adspower') {
    return { ok: false, reason: 'unsupported_environment', message: '该环境类型暂不支持无浏览器控制面启动' };
  }
  if (!clientAuthEnabled()) {
    return { ok: false, reason: 'client_auth_disabled', message: '客户鉴权未配置，无法可信确认环境账号' };
  }
  if (!hasValidSession()) {
    return { ok: false, reason: 'client_session_missing', message: '客户登录已失效，无法可信确认环境账号' };
  }
  const envKey = String(handle.profileId || '').trim();
  if (!envKey) return { ok: false, reason: 'invalid_environment', message: '环境缺少分身 ID' };
  const response = await clientAuthFetch(`/environments/${encodeURIComponent(envKey)}/control-bootstrap`, {
    token: clientSession.token,
  });
  if (response.status === 401) onSessionInvalid();
  if (!response.ok) {
    const reason = response.data && typeof response.data.error === 'string'
      ? response.data.error
      : response.status === 0 ? 'cloud_unreachable' : 'bootstrap_rejected';
    return {
      ok: false,
      reason,
      message: CONTROL_BOOTSTRAP_REASON_ZH[reason]
        || (reason === 'cloud_unreachable' ? '暂时无法连接账号绑定服务' : '云端拒绝控制面账号引导'),
    };
  }
  const data = response.data && response.data.data;
  const returnedEnvKey = data && typeof data.envKey === 'string' ? data.envKey.trim() : '';
  const accountId = data && typeof data.accountId === 'string' ? data.accountId.trim() : '';
  if (returnedEnvKey !== envKey || !accountId || accountId.length > 256 || /[\u0000-\u001f\u007f]/.test(accountId)) {
    return { ok: false, reason: 'bootstrap_schema_invalid', message: '云端控制面引导响应不合法，已拒绝使用' };
  }
  return { ok: true, envKey, accountId };
}

// ── 视频号 InteractionWorkspace customer-auth bridge ────────────────────────
// renderer 只能调用下方具名 IPC；路径、方法、query、body 与幂等 header 全部由主进程组装。
// 这里不暴露通用 URL/fetch，也不把客户 token 或 Cloud 原始请求能力交给 renderer。
const INTERACTION_CHANNELS = new Set(['comment', 'dm']);
const INTERACTION_LIST_STATES = new Set(['pending', 'sent']);
const WECHAT_CHANNELS_INSPECTION_URL = 'https://channels.weixin.qq.com/platform/post/list';
const interactionReadControllers = new Map(); // envKey -> Set<AbortController>（仅取消 list/detail 读请求）

function interactionLocalError(code, message, status = 400, details) {
  return {
    status,
    ok: false,
    data: {
      error: {
        code,
        message,
        requestId: `edge-ipc-${Date.now().toString(36)}`,
        retryable: status === 0 || status >= 500,
        ...(details ? { details } : {}),
      },
    },
  };
}

function interactionObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是对象');
  return value;
}

function interactionArgs(value, allowedKeys) {
  const object = interactionObject(value);
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) throw new Error(`不支持的参数：${key}`);
  }
  return object;
}

function interactionId(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} 不合法`);
  return text;
}

function interactionOptionalString(value, label, maxLength) {
  if (value == null || value === '') return null;
  const text = String(value);
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} 不合法`);
  return text;
}

function interactionExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error('expectedVersion 不合法');
  return value;
}

function interactionBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
  return value;
}

function interactionLimit(value) {
  if (value == null) return 30;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('limit 必须在 1 到 100 之间');
  return value;
}

function interactionIdempotencyKey(value) {
  const text = String(value == null ? '' : value);
  if (text.length < 8 || text.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error('Idempotency-Key 不合法');
  return text;
}

function interactionQuery(params, keys) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (keys.has(key) && value != null && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

function trackInteractionRead(envKey, controller) {
  let set = interactionReadControllers.get(envKey);
  if (!set) { set = new Set(); interactionReadControllers.set(envKey, set); }
  set.add(controller);
  return () => {
    set.delete(controller);
    if (set.size === 0) interactionReadControllers.delete(envKey);
  };
}

function cancelInteractionReads(envKey) {
  const set = interactionReadControllers.get(envKey);
  if (!set) return 0;
  let count = 0;
  for (const controller of set) {
    count += 1;
    try { controller.abort(); } catch { /* already settled */ }
  }
  interactionReadControllers.delete(envKey);
  return count;
}

async function interactionCustomerRequest({
  envKey, pathname, method = 'GET', body, idempotencyKey, cancellable = false, timeoutMs,
}) {
  if (!clientAuthEnabled()) return interactionLocalError('INTERACTION_FEATURE_DISABLED', '当前构建未启用 customer-auth API。', 503);
  if (!hasValidSession()) return interactionLocalError('INTERACTION_AUTH_REQUIRED', '客户端登录已失效。', 401);
  const controller = cancellable ? new AbortController() : null;
  const cleanup = controller ? trackInteractionRead(envKey, controller) : () => undefined;
  try {
    const result = await clientAuthFetch(pathname, {
      method,
      token: clientSession.token,
      body,
      idempotencyKey,
      signal: controller && controller.signal,
      timeoutMs,
    });
    if (result.status === 401) {
      // customer-auth token 失效沿用既有安全机制回登录门；平台 reauth 则由 API data.auth 表达，不走此分支。
      onSessionInvalid();
      return result;
    }
    if (result.ok) {
      const responseEnvKey = result.data && result.data.data && result.data.data.envKey;
      if (responseEnvKey !== envKey) {
        return interactionLocalError('INTERACTION_SCOPE_MISMATCH', 'Cloud 响应环境与请求环境不一致，已拒绝转交 renderer。', 502);
      }
    }
    return result;
  } finally {
    cleanup();
  }
}

async function handleInteractionIpc(handler) {
  try {
    return await handler();
  } catch (error) {
    return interactionLocalError('INTERACTION_VALIDATION_FAILED', String((error && error.message) || error || '参数不合法'), 400);
  }
}
// 拉该客户可见环境 → 设 allowedProfileIds。返回 false 表示会话已失效（401），由调用方决定登出。
async function refreshAllowedEnvironments() {
  if (!clientAuthEnabled() || !hasValidSession()) {
    allowedProfileIds = null;
    allowedEnvironmentPlatforms = new Map();
    allowedEnvironmentControlStates = new Map();
    return true;
  }
  const r = await clientAuthFetch('/my-environments', { token: clientSession.token });
  if (r.status === 401) return false;
  if (r.ok && r.data && Array.isArray(r.data.environments)) {
    allowedProfileIds = new Set(r.data.environments.map((e) => String((e && e.envKey) || '')).filter(Boolean));
    allowedEnvironmentPlatforms = new Map(r.data.environments
      .map((e) => [String((e && e.envKey) || '').trim(), normalizePlatform(e && e.platform)])
      .filter(([envKey]) => Boolean(envKey)));
    allowedEnvironmentControlStates = new Map(r.data.environments
      .map((e) => {
        const envKey = String((e && e.envKey) || '').trim();
        return [envKey, {
          bindingState: String((e && e.bindingState) || 'binding_unavailable'),
          personaState: String((e && e.personaState) || 'unavailable'),
          personaBound: e && typeof e.personaBound === 'boolean' ? e.personaBound : null,
        }];
      })
      .filter(([envKey]) => Boolean(envKey)));
  } else if (allowedProfileIds == null) {
    allowedProfileIds = new Set(); // 首次拉取失败 → fail-closed 空集（不误显他人环境）；已建立则保留上次已知
    allowedEnvironmentPlatforms = new Map();
    allowedEnvironmentControlStates = new Map();
  }
  return true;
}

function withAuthoritativeAssignmentNotice(result, detail) {
  if (!result || !result.ok || !clientAuthEnabled()) return result;
  return {
    ...result,
    createdLocally: true,
    assignedToCurrentClient: false,
    requiresAdminAssignment: true,
    assignmentHandledByMain: true,
    rosterJoinedByMain: false,
    visibilityWarning: `环境已在本机创建，但自动分配未完成${detail ? `（${detail}）` : ''}，因此未加入运行环境。请重试或由管理员分配。`,
  };
}

async function createEnvironmentProvisioningIntent() {
  if (!clientAuthEnabled()) return { ok: true, required: false };
  if (!hasValidSession()) {
    onSessionInvalid();
    return { ok: false, error: '客户端登录已失效' };
  }
  const response = await clientAuthFetch('/environment-provisioning/intents', {
    method: 'POST',
    token: clientSession.token,
    body: {},
  });
  if (response.status === 401) {
    onSessionInvalid();
    return { ok: false, error: '客户端登录已失效' };
  }
  const data = response && response.data && response.data.data;
  if (!response.ok || !data || typeof data.intentId !== 'string' || !data.intentId
    || typeof data.proof !== 'string' || !data.proof) {
    const reason = response && response.data && response.data.error;
    return { ok: false, error: `云端归属准备失败${reason ? `：${reason}` : ''}` };
  }
  return { ok: true, required: true, intentId: data.intentId, proof: data.proof };
}

function addProvisionedEnvironmentToRoster(result) {
  const environment = fleet.normalizeEnvironment({
    profileId: result && result.userId,
    name: (result && result.name) || '',
    platform: (result && result.platform) || 'xiaohongshu',
  });
  if (!environment) return { ok: false, error: '新环境缺少有效分身 ID' };
  const existing = fleet.normalizeEnvironments(settings.environments || []);
  const next = existing.some((item) => item.profileId === environment.profileId)
    ? existing.map((item) => item.profileId === environment.profileId ? { ...item, ...environment } : item)
    : [...existing, environment];
  const saved = saveSettings({ environments: next });
  if (!saved.ok) {
    // saveSettings 会先更新内存再尝试落盘；写盘失败必须把内存花名册也回滚，
    // 否则 UI 说“未加入”但本轮其实已经生成 handle，构成假失败/重启漂移。
    settings.environments = existing;
    applyLegacyMirror();
    return saved;
  }
  syncEnvHandles();
  broadcastFleet();
  return saved;
}

async function finalizeCreatedEnvironmentAssignment(result, intent, { slowStartEnabled = false } = {}) {
  if (!result || !result.ok) return result;
  const pendingResult = slowStartEnabled
    ? { ...result, slowStartConfigured: false }
    : result;
  if (!intent || !intent.required) {
    return slowStartEnabled
      ? {
          ...pendingResult,
          visibilityWarning: '环境已在本机创建，但当前构建未启用 Cloud 客户归属，Facebook 慢启动未配置。',
        }
      : result;
  }
  let response = null;
  // 完成端点幂等：仅网络/服务端瞬时失败原样重试一次；4xx 具名拒绝不盲重试。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await clientAuthFetch('/environment-provisioning/complete', {
      method: 'POST',
      token: clientSession && clientSession.token,
      body: {
        intentId: intent.intentId,
        proof: intent.proof,
        envKey: String(result.userId || '').trim(),
        label: String(result.name || '').trim() || null,
        platform: normalizePlatform(result.platform),
        ...(slowStartEnabled ? { slowStartEnabled: true } : {}),
      },
    });
    if (response.ok || (response.status > 0 && response.status < 500)) break;
  }
  if (response && response.status === 401) {
    onSessionInvalid();
    return withAuthoritativeAssignmentNotice(
      pendingResult,
      `客户端登录已失效${slowStartEnabled ? '；Facebook 慢启动未确认' : ''}`,
    );
  }
  if (!response || !response.ok) {
    const reason = response && response.data && response.data.error;
    return withAuthoritativeAssignmentNotice(
      pendingResult,
      `${reason || '云端未确认归属'}${slowStartEnabled ? '；Facebook 慢启动未确认' : ''}`,
    );
  }
  const confirmedResult = slowStartEnabled
    ? { ...result, slowStartConfigured: true }
    : result;

  const refreshed = await refreshAllowedEnvironments();
  if (!refreshed || !(allowedProfileIds instanceof Set) || !allowedProfileIds.has(String(result.userId || '').trim())) {
    return {
      ...withAuthoritativeAssignmentNotice(confirmedResult, '权威环境清单尚未确认'),
      assignedToCurrentClient: true,
      requiresAdminAssignment: false,
      visibilityWarning: '环境已分配到当前账号，但权威环境清单尚未刷新，因此本次未加入运行环境。请稍后刷新后加入。',
    };
  }
  const saved = addProvisionedEnvironmentToRoster(result);
  if (!saved.ok) {
    return {
      ...confirmedResult,
      createdLocally: true,
      assignedToCurrentClient: true,
      requiresAdminAssignment: false,
      assignmentHandledByMain: true,
      rosterJoinedByMain: false,
      visibilityWarning: `环境已分配到当前账号，但本地运行花名册保存失败（${saved.error || '未知错误'}）。请刷新后重新加入。`,
    };
  }
  return {
    ...confirmedResult,
    createdLocally: true,
    assignedToCurrentClient: true,
    requiresAdminAssignment: false,
    assignmentHandledByMain: true,
    rosterJoinedByMain: true,
  };
}
async function validateExistingClientSessionForStartup() {
  const sessionReady = await refreshClientSessionInternal(false);
  if (!sessionReady || !hasValidSession()) return false;
  const scopeReady = await refreshAllowedEnvironments();
  return scopeReady && hasValidSession();
}
async function prepareClientAuthForStartup() {
  return restoreClientAuthAtStartup({
    enabled: clientAuthEnabled(),
    hasValidSession,
    validateExistingSession: validateExistingClientSessionForStartup,
    loadSavedCredentials: loadClientLoginPrefill,
    clearSessionPreservingCredentials: clearClientSessionRecord,
    clearSessionAndCredentials: clearClientSession,
    loginWithCredentials: establishClientSession,
  });
}
// 会话失效：清短期 session、拆掉环境并回登录门；显式退出才同时忘记加密登录凭据。
function onSessionInvalid({ forgetCredentials = false } = {}) {
  if (forgetCredentials) clearClientSession();
  else clearClientSessionRecord();
  allowedProfileIds = new Set();
  allowedEnvironmentPlatforms = new Map();
  allowedEnvironmentControlStates = new Map();
  try { syncEnvHandles(); } catch { /* ignore */ } // wanted 为空 → 移除并 SIGTERM 全部环境
  if (mainWindow) { try { mainWindow.close(); } catch { /* ignore */ } mainWindow = null; }
  createLoginWindow();
}

let legacyManualAliasSyncPromise = null;
/** 升级前本地人工名的有界补同步：最多 20 个并行、单请求 5 秒；失败保留本地值并显式标为 unsynced。 */
function syncUnsyncedManualAliases() {
  if (legacyManualAliasSyncPromise || !clientAuthEnabled() || !hasValidSession()) {
    return legacyManualAliasSyncPromise || Promise.resolve();
  }
  const candidates = fleet.normalizeEnvironments(settings.environments || [])
    .filter((environment) => environment.nameSource === 'manual'
      && environment.nameSyncState !== 'synced'
      && (!allowedProfileIds || allowedProfileIds.has(environment.profileId)))
    .slice(0, 20);
  if (candidates.length === 0) return Promise.resolve();
  legacyManualAliasSyncPromise = Promise.all(candidates.map(async (environment) => {
    const response = await clientAuthFetch(`/environments/${encodeURIComponent(environment.profileId)}/operator-alias`, {
      method: 'PUT', token: clientSession && clientSession.token,
      body: { alias: environment.name }, timeoutMs: 5000,
    });
    return { environment, response };
  })).then((results) => {
    if (results.some(({ response }) => response.status === 401)) {
      onSessionInvalid();
      return;
    }
    let changed = false;
    const byProfile = new Map(results.map((result) => [result.environment.profileId, result]));
    const environments = fleet.normalizeEnvironments(settings.environments || []).map((current) => {
      const result = byProfile.get(current.profileId);
      if (!result || current.nameSource !== 'manual' || current.name !== result.environment.name) return current;
      const nextState = result.response.ok ? 'synced' : 'unsynced';
      if (current.nameSyncState === nextState) return current;
      changed = true;
      return { ...current, nameSyncState: nextState };
    });
    if (!changed) return;
    const saved = saveSettings({ environments });
    if (!saved.ok) console.warn(`[aidcp-edge] 人工昵称同步状态写入失败：${saved.error || '未知错误'}`);
    syncEnvHandles();
  }).finally(() => { legacyManualAliasSyncPromise = null; });
  return legacyManualAliasSyncPromise;
}
function createLoginWindow() {
  if (loginWindow) { try { loginWindow.show(); loginWindow.focus(); } catch { /* ignore */ } return; }
  loginWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    title: 'AIDCP',
    backgroundColor: '#F5F7FA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWindow.on('closed', () => { loginWindow = null; });
}
// 登录成功 / 已有会话后的正常启动流程（原 whenReady 主体收拢于此，便于登录门前置门控 + 登录后续跑）。
async function proceedAfterAuth() {
  if (clientAuthEnabled()) {
    if (!hasValidSession()) { onSessionInvalid(); return; }
    const sessionReady = await refreshClientSessionIfNeeded();
    if (!sessionReady) return;
    const ok = await refreshAllowedEnvironments();
    if (!ok) { onSessionInvalid(); return; }
    const owner = String((clientSession && clientSession.name) || '').trim();
    if (settings.clientRosterExclusionOwner !== owner) {
      // 同机切换客户时绝不继承上一客户的手动移出选择；首次升级也在此把排除集合绑定到当前客户。
      saveSettings({ clientRosterExclusionOwner: owner, clientRosterExcludedEnvIds: [] });
    }
  } else {
    allowedProfileIds = null; // 未 gated：不过滤
  }
  syncEnvHandles();
  void syncUnsyncedManualAliases();
  void retryPendingInteractionOffboards();
  loadUiState();
  // 一次性轻量预检：缺配置亮「待配置」，齐备则「就绪」。
  for (const handle of envs.values()) {
    if (handle.kind === 'adspower' && !handle.profileId) {
      updateStatus(handle, {
        auth: 'config required',
        lastMessage: '待配置：请在设置中加入浏览器环境后点「启动」。',
        ...presencePatch('等待完成初始设置'),
      });
    } else {
      updateStatus(handle, {
        lastMessage: '客户端已就绪；数据管理可直接使用。点“开始自动化”后再连接引擎并准备浏览器。',
        ...presencePatch('客户端已就绪，等待开始自动化'),
      });
    }
  }
  enforceOwnedAutomationEngines();
  if (settings.provider === 'adspower' && envs.size === 0) broadcastFleet();
  if (!mainWindow) createWindow();
  if (!proceededOnce) {
    proceededOnce = true;
    createTray();
    // 客户核心启动不得隐式启动 AdsPower 或下载内核。provider 探测延后到显式浏览器/自动化意图；
    // self 遗留模式无 AdsPower 生命周期，仍保留只读 Chrome 对账。
    if (settings.provider !== 'adspower') {
      void reconcileRunningProfiles();
    }
    startSessionMaintenance();
  }
}
// 会话维护：滑动续签 + 定时复核可见范围（管理员增删环境即时生效）；失效即登出回登录门。
function startSessionMaintenance() {
  if (sessionTimer) return;
  sessionTimer = setInterval(async () => {
    if (!clientAuthEnabled()) return;
    const sessionReady = await refreshClientSessionIfNeeded();
    if (!sessionReady) return;
    const ok = await refreshAllowedEnvironments();
    if (!ok) { onSessionInvalid(); return; }
    syncEnvHandles();
    void syncUnsyncedManualAliases();
    enforceOwnedAutomationEngines();
    void retryPendingInteractionOffboards();
  }, 4 * 60_000);
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
  normalizeColdStandbySettingsIntoSettings();
  normalizeSlotSettingsIntoSettings();
  settings.environments = fleet.normalizeEnvironments(settings.environments);
  settings.pendingInteractionOffboards = normalizePendingInteractionOffboards(settings.pendingInteractionOffboards);
  settings.clientRosterExclusionOwner = String(settings.clientRosterExclusionOwner || '').trim();
  settings.clientRosterExcludedEnvIds = normalizeClientRosterExcludedEnvIds(settings.clientRosterExcludedEnvIds);
  applyLegacyMirror();
  normalizeCloudSettings();
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true };
  } catch (error) {
    console.error('[aidcp-edge] settings 写入失败:', error?.message);
    return { ok: false, error: error?.message || '未知错误' };
  }
}

function normalizeColdStandbySettingsIntoSettings() {
  const normalized = normalizeColdStandbySettings(settings, process.env);
  settings.browserColdStandbyEnabled = normalized.enabled;
  settings.browserColdStandbyMinWaitMs = normalized.minWaitMs;
  settings.browserColdStandbyWarmupMs = normalized.warmupMs;
}

// 浏览器并发两个上限的归一（0 = 自动）。改动即作废槽位缓存——设置改了就该立刻生效，
// 不该等下次开应用（缓存的存在是为了不让「边启动边算」随内存下降自我缩水，不是为了钉死用户的选择）。
function normalizeSlotSettingsIntoSettings() {
  settings.browserSlotLimit = fleet.normalizeSlotLimit(settings.browserSlotLimit);
  settings.maxQueuedStartLimit = fleet.normalizeSlotLimit(settings.maxQueuedStartLimit);
  // 旧字段语义是「环境创建硬上限」，与当前「启动排队上限」不同，不能静默迁移成新限制。
  delete settings.maxAccountLimit;
  slotViewCache = null;
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

// 解析只读/写调用的 base/key：托管运行时已建立时，其 CLI 实际上报 base 是单一权威；只有尚未建立时
// 才允许渲染层当前表单值（支持诊断「新填未保存即刷新」）或持久化设置回落。
// base 优先级（P0-A）：运行时 adsServiceBase > 表单 > 持久化 settings > 核心默认。
// apiKey 走单一解析器（含随包内置默认），只用于本次请求头、不落日志 / 不写文件。
function resolveAdsOpts(formOpts) {
  const o = formOpts || {};
  const apiBase = adsServiceBase || (o.apiBase && String(o.apiBase).trim()) || settings.adsApiBase || undefined;
  const formKey = Object.prototype.hasOwnProperty.call(o, 'apiKey') ? String(o.apiKey).trim() : '';
  const apiKey = resolveAdsApiKey(formKey);
  const out = {};
  if (apiBase) out.apiBase = apiBase;
  if (apiKey) out.apiKey = apiKey;
  if (o.groupId) out.groupId = o.groupId;
  return out;
}

// 环境名跟随真实昵称（change edge-adspower-name-follows-nickname）：某 adspower 环境登录读出真实平台昵称后，
// 若其 AdsPower 环境名与昵称不一致，则经写客户端改名封装把 AdsPower 名改成昵称，让左栏 / 添加面板 / 直接打开
// 指纹浏览器客户端三处显示名一致（存量环境随下次登录渐进改到位）。铁律：
//  - **只改 adspower 环境**（self 无 profileId、无 AdsPower 名）；缺 profileId / 空昵称一律不发。
//  - **幂等去抖**：昵称已等于当前已知名（handle.name）即跳过、绝不重复发 user/update。
//  - **在途去重**：同名改名在飞时不重复发（handle.renamingTo 标记）。
//  - **诚实降级**：写失败（不可达 / code≠0 / 撞限速）保持原名、记一次可观测日志、不重试风暴、不阻塞浏览闭环；
//    下次该环境再产生身份事件时自然再试。绝不把改名失败伪装成成功。
//  - fire-and-forget：调用方不 await；写客户端 ≥1.1s 串行节流保证不与核心本地 API 同秒并发。
async function maybeRenameEnvToNickname(handle, nickname) {
  if (!handle || handle.kind !== 'adspower') return;
  const userId = handle.profileId && String(handle.profileId).trim();
  if (!userId) return;
  const nick = nickname == null ? '' : String(nickname).trim();
  if (!nick) return;
  // 人工昵称期间系统刷新只推进影子值，供用户清空人工输入时恢复；绝不覆盖可见人工名或改 AdsPower 名。
  if (handle.nameSource === 'manual') {
    if (nick !== String(handle.systemName || '')) {
      const environments = fleet.normalizeEnvironments(settings.environments || []).map((environment) =>
        environment.profileId === userId ? { ...environment, systemName: nick } : environment);
      const saved = saveSettings({ environments });
      if (saved.ok) {
        handle.systemName = nick;
        broadcastFleet();
      } else {
        console.warn(`[aidcp-edge] 系统昵称影子写入失败（人工名仍保留）：${userId} → ${saved.error || '未知错误'}`);
      }
    }
    return;
  }
  if (nick === String(handle.name || '')) return; // 幂等去抖：名已一致不发
  if (handle.renamingTo === nick) return; // 同名改名在途，不重复发
  handle.renamingTo = nick;
  try {
    const ads = resolveAdsOpts({});
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    const r = await writeApi.renameProfile({ userId, name: nick }, ads);
    if (r && r.ok) {
      // 请求在人工编辑前已经发出也不能回头覆盖本地人工名；外部写已无法撤销，但左栏/花名册仍以人工名为准。
      if (handle.nameSource === 'manual') return;
      // 本地花名册名同步（令下次 user/list 回填与 reconcileRosterNames 一致、单写、不双落盘竞态）。
      handle.name = nick;
      if (handle.status && handle.status.account) handle.status.account.name = nick;
      console.log(`[aidcp-edge] 环境名跟随昵称：已把 ${userId} 改名为「${nick}」`);
    } else {
      // 诚实降级：保持原名，记一次可观测日志，不重试风暴、不阻塞浏览。
      console.warn(`[aidcp-edge] 环境名跟随昵称失败（保持原名，后续再试）：${userId} → ${(r && r.error) || '未知错误'}`);
    }
  } catch (e) {
    console.warn(`[aidcp-edge] 环境名跟随昵称异常（保持原名，不影响浏览）：${(e && e.message) || String(e)}`);
  } finally {
    if (handle.renamingTo === nick) handle.renamingTo = undefined;
  }
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
    // 本轮核心是否**曾经**连上过云端（change honest-first-connect-label）。呈现层据此区分两种截然不同的处境：
    // 「还没连上」（冷启动的正常一步）vs「连上过又断了」（只有后者配叫「重新连接」）。缺了这个事实，
    // `cloud !== 'connected'` 会把整个浏览器冷启动窗口讲成断线重连——把「还没」读成「否」。
    cloudEverConnected: false,
    auth: 'checking',
    session: 'idle',
    stats: { views: 0, likes: 0, collects: 0, comments: 0, follows: 0, publishes: 0 },
    dailyUsage: null,
    browserStandby: null,
    loopStage: null,
    loopStageGeneration: 0,
    loopStageBrowserIndependent: false,
    risk: 'normal',
    edge: 'stopped',
    lastMessage: '客户端已就绪；自动化尚未启动。',
    commandDiagnostics: [],
    edgeFailure: null,
    updatedAt: new Date().toISOString(),
    account: null,
    presence: { text: '数据管理可用，等待开始自动化', at: new Date().toISOString() },
    publish: null,
    publishPreview: null,
    // 浏览器启动前的短时代理可用性预检；与 proxyRuntime（浏览器实际出口证据）严格分开。
    proxyPreflight: null,
    kernelPrep: null,
    lastPublish: null,
    // 多环境新增（旧渲染层忽略即可）：有界重起放弃终态 + 同账号铺多环境告警 + 阻断浮层待人工。
    respawnGaveUp: false,
    sameAccountWarning: null,
    // 核心遇登录/验证码/未知阻断弹窗、已本地暂停等待人工处理（红线：绝不呈现为在线健康）。
    // 由核心成对信号驱动：`检测到X弹窗，暂停操作`(置真) / `阻断弹窗已清除，恢复浏览`(置假)。
    overlayBlocked: false,
    // 人设绑定态（change persona-bound-tristate）：**三态** true=云端确认已绑 / false=云端确认未绑 /
    // null=未知（云端还没说）。默认 null 而非 false 是这条 bug 的要害——默认 false 等于「有罪推定」，
    // 任何一次重启把它归零，渲染层就会在快照到达前把已设置人设的账号判成未设置并弹向导。
    // 按环境隔离（账号级信号）。
    personaBound: null,
    // Facebook 人设公开写作语言：undefined=Cloud 尚未投影；null=存量人设缺字段；字符串=权威值。
    personaWritingLanguage: undefined,
    // 本环境核心本次实际被派生去连的云端 key（change edge-cloud-env-selector）：''=未启动/未知。
    // 界面据此与「目标云端」比对，运行中且不一致即显示「待重启生效」（红线：显示=实际连接）。
    connectedCloudKey: '',
    targetCloudKey: '',
    cloudRebind: null,
  };
}

/** envId -> EnvHandle。EnvHandle 持子进程句柄 + 冻结身份 + 状态投影 + 每环境解析器/意图标志/重起计数。 */
const envs = new Map();
let selectedEnvId = '';
let selectedProxyPreflightTimer = null;

const proxyPreflight = createProxyPreflightController({
  readProxy: (profileId) => readAdsWithRuntime({}, (resolved) => adsApi.getProfileProxyConfig({
    ...resolved,
    profileId,
  })),
  onUpdate: (envId, snapshot) => {
    const handle = envs.get(envId);
    if (!handle || handle.removed) return;
    updateStatus(handle, { proxyPreflight: snapshot });
  },
});

function browserAbsentForProxyPreflight(handle) {
  return Boolean(handle && (!handle.child
    || handle.coldStandbyActive
    || handle.coldStandbyPending
    || handle.controlPlaneOnly));
}

function eligibleForProxyPreflight(handle) {
  return Boolean(handle
    && !handle.removed
    && !isQuitting
    && handle.kind === 'adspower'
    && normalizePlatform(handle.platform) === 'facebook'
    && handle.profileId
    && browserAbsentForProxyPreflight(handle));
}

function ensureProxyPreflight(handle) {
  if (!eligibleForProxyPreflight(handle)) {
    return Promise.resolve({ state: 'skipped', reason: 'not_applicable' });
  }
  return proxyPreflight.ensure({ envId: handle.envId, profileId: handle.profileId });
}

function scheduleSelectedProxyPreflight(handle) {
  if (selectedProxyPreflightTimer) clearTimeout(selectedProxyPreflightTimer);
  selectedProxyPreflightTimer = null;
  if (!eligibleForProxyPreflight(handle)) return;
  const envId = handle.envId;
  selectedProxyPreflightTimer = setTimeout(() => {
    selectedProxyPreflightTimer = null;
    const current = envs.get(envId);
    if (selectedEnvId !== envId || !eligibleForProxyPreflight(current)) return;
    void ensureProxyPreflight(current);
  }, 300);
  selectedProxyPreflightTimer.unref?.();
}

function proxyPreflightFailureText(reason) {
  switch (reason) {
    case 'protocol_mismatch': return '代理类型可能配置错误';
    case 'authentication_failed': return '代理账号或密码未通过认证';
    case 'timeout': return '代理连接超时';
    case 'connection_refused': return '代理拒绝连接';
    case 'host_unresolved': return '代理地址无法解析';
    case 'config_invalid': return '代理配置不完整';
    default: return '代理当前不可用';
  }
}

function stopStartForProxyFailure(handle, result) {
  const reason = proxyPreflightFailureText(result && result.reason);
  updateStatus(handle, {
    edge: 'stopped',
    session: 'idle',
    lastMessage: `自动化未启动：${reason}。请修改代理后重试。`,
    ...edgeFailurePatch(reason),
    ...presencePatch('代理不可用，自动化未启动'),
  });
}

function makeEnvHandle({ envId, kind, profileId, name, systemName, nameSource, nameSyncState, platform, cascadeIndex }) {
  return {
    envId,
    kind, // 'adspower' | 'self'
    profileId: profileId || '',
    name: name || '',
    systemName: systemName || '',
    nameSource: nameSource === 'manual' ? 'manual' : undefined,
    nameSyncState: nameSource === 'manual' && (nameSyncState === 'synced' || nameSyncState === 'unsynced')
      ? nameSyncState : undefined,
    platform: platform || 'xiaohongshu',
    cascadeIndex: cascadeIndex || 0,
    child: undefined,
    spawnCloudKey: '',
    cloudRebindPending: null,
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
    automationPaused: false,
    automationIntent: 'stopped', // 'stopped' | 'enabled' | 'paused'
    engineStopReason: '',
    resumeAfterStop: false,
    // Resume and browser wake are serialized: when automation is paused in browser standby,
    // first clear the core's pause latch, then open the browser through the normal slot queue.
    resumeWakePending: false,
    cleanupManual: false,
    coreParked: false,
    closePending: false,
    removed: false,
    // 排队启动期间被暂停/移出/退出的取消闸：queued start（尚无子进程、SIGTERM 无处可发）据此在
    // startEdge 处诚实放弃拉起，杜绝「暂停/退出被排队启动覆盖」与孤儿子进程。
    stopRequested: false,
    // 已获准进入启动调度、但尚未进入浏览器执行态。它是有界「启动排队」的唯一成员资格标记；
    // 与已创建多少环境无关，同一环境重复请求也不会重复占排队名额。
    lifecycleGeneration: 0,
    lifecycleGenerationReason: 'initial',
    startQueueReserved: false,
    startFlowQueued: false,
    startFlowGeneration: 0,
    launchGeneration: 0,
    wakeGeneration: 0,
    lastEdgeFailureLine: '',
    respawnStreak: 0,
    respawnTimer: null,
    gaveUp: false,
    spawnedAtMs: 0,
    browserAlreadyRunning: false,
    browserStateUnconfirmed: false,
    browserOpenPending: false,
    coldStandbyTimer: null,
    coldStandbyWakeAt: 0,
    coldStandbyActive: false,
    coldStandbyPending: false,
    // 控制面与浏览器槽位解耦：核心/Cloud 已上线但浏览器从未启动。只有 lifecycle.standby ack 后
    // controlPlaneBootstrapped 才为真，握手前退出不得被误洗成“正常待机退出”。
    controlPlaneOnly: false,
    controlPlaneBootstrapped: false,
    controlPlaneStarting: false,
    // 最短持有时长（change standby-covers-idle-waits）：上次唤醒完成的时刻 + 一个「持有满足后重新判定」
    // 的定时器。被 min_hold 拦下时**绝不能把提示丢掉**——否则一次拦截就把该环境永久留在开启态、
    // 再也不会让出槽位（外层 !decision.ok 分支对「不在待机中」的普通 skip 是直接 return、什么都不做的）。
    coldStandbyLastWokenAt: 0,
    coldStandbyHoldTimer: null,
    // 正在原地重建浏览器（change browser-slot-scheduling）。唤醒是异步有界的：待机态只在核心回报
    // lifecycle.woken 后才解除，绝不在下发唤醒的那一刻就乐观标成已醒。
    coldStandbyWaking: false,
    // Capacity-1 machine-wide lane for short-lived browser sidecars. This is orthogonal to the
    // persistent execution-slot pool and guarded by lifecycle generation.
    transientBrowserQueued: false,
    transientBrowserQueueKey: null,
    transientBrowserActive: false,
    transientBrowserLeaseGeneration: 0,
    transientBrowserRequestId: null,
    transientBrowserLeaseSettle: null,
    transientBrowserLeaseTimer: null,
    // Structured interaction-runtime truth; never infer API-only running from a historical login.
    interactionRuntime: null,
  };
}

function selectedHandle() {
  return envs.get(selectedEnvId) || envs.values().next().value;
}

function pendingOffboardForEnv(envKey) {
  return (settings.pendingInteractionOffboards || []).find((item) => item.envKey === envKey) || null;
}

function pendingOffboardEnvKeys() {
  return new Set((settings.pendingInteractionOffboards || [])
    .filter((item) => item.state !== 'purged')
    .map((item) => item.envKey));
}

/** 依当前 settings 同步注册表：新增环境建 handle、被移出花名册的环境有序停止并摘除、序号重排。 */
function syncEnvHandles() {
  const wanted = new Map(); // envId -> spec
  if (settings.provider === 'self') {
    wanted.set('self', { envId: 'self', kind: 'self', profileId: '', name: '本机 Chrome', platform: settings.platform, cascadeIndex: 0 });
  } else {
    // 按登录客户可见范围过滤（change edge-client-customer-auth）：allowedProfileIds 为 null 时不过滤（未 gated）；
    // 为 Set 时只保留归属当前客户的环境——非本客户环境不建 handle、不显示、不启动。cascadeIndex 用连续序号（错峰）。
    let idx = 0;
    const cleanupEnvKeys = pendingOffboardEnvKeys();
    settings.environments.forEach((env) => {
      if (allowedProfileIds && !allowedProfileIds.has(env.profileId) && !cleanupEnvKeys.has(env.profileId)) return;
      const envId = fleet.envIdForProfile(env.profileId);
      wanted.set(envId, {
        envId, kind: 'adspower', profileId: env.profileId, name: env.name, systemName: env.systemName,
        nameSource: env.nameSource, nameSyncState: env.nameSyncState, platform: env.platform,
        cascadeIndex: idx++, offboardCleanup: cleanupEnvKeys.has(env.profileId),
      });
    });
    // 不在运行花名册的环境也可能留有密文。Cloud 已受理解绑后，建立仅用于重连收取 offboard command 的 handle；
    // welcome.offboardPending 会让新版核心 fail-closed，不启动平台 connector、更不会盲写。
    for (const pending of settings.pendingInteractionOffboards || []) {
      if (pending.state === 'purged') continue;
      const envId = fleet.envIdForProfile(pending.envKey);
      if (wanted.has(envId)) continue;
      wanted.set(envId, {
        envId, kind: 'adspower', profileId: pending.envKey, name: '待清理环境', platform: pending.platform,
        cascadeIndex: idx++, offboardCleanup: true,
      });
    }
  }
  // 摘除不再需要的环境：在跑的先有意停止（removed + stopRequested 使退出回调 / 排队启动都按「有意」
  // 处理——不告警、不重起、queued start 到点也不再拉起，杜绝孤儿）。
  for (const [envId, handle] of envs) {
    if (wanted.has(envId)) continue;
    coreBootstrapSupervisor.remove(envId);
    handle.removed = true;
    handle.stopRequested = true;
    cancelQueuedTransientBrowser(handle, 'environment_removed');
    releaseStartQueue(handle);
    clearRespawnTimer(handle);
    if (handle.child) {
      queueLifecycle(() => { try { handle.child?.kill('SIGTERM'); } catch { /* ignore */ } });
    }
    proxyPreflight.invalidate(envId);
    envs.delete(envId);
  }
  // 建新 / 更新元数据（既有 handle 的运行态保留）。
  for (const [envId, spec] of wanted) {
    const existing = envs.get(envId);
    if (existing) {
      existing.name = spec.name;
      existing.systemName = spec.systemName || '';
      existing.nameSource = spec.nameSource === 'manual' ? 'manual' : undefined;
      existing.nameSyncState = existing.nameSource
        && (spec.nameSyncState === 'synced' || spec.nameSyncState === 'unsynced') ? spec.nameSyncState : undefined;
      existing.platform = spec.platform;
      existing.cascadeIndex = spec.cascadeIndex;
      existing.offboardCleanup = Boolean(spec.offboardCleanup);
      const controlState = allowedEnvironmentControlStates.get(spec.profileId);
      if (personaApplicable(existing) && controlState && typeof controlState.personaBound === 'boolean') {
        existing.status.personaBound = controlState.personaBound;
      } else if (!personaApplicable(existing)) {
        existing.status.personaBound = null;
      }
    } else {
      const handle = makeEnvHandle(spec);
      handle.offboardCleanup = Boolean(spec.offboardCleanup);
      // 环境名现成可得：未启动前就点亮账号标签（登录后被真实身份覆盖）。
      if (spec.kind === 'adspower' && spec.profileId) {
        handle.status.account = { id: spec.profileId, name: spec.name || '', source: 'env' };
      }
      const controlState = allowedEnvironmentControlStates.get(spec.profileId);
      if (personaApplicable(handle) && controlState && typeof controlState.personaBound === 'boolean') {
        handle.status.personaBound = controlState.personaBound;
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
  // 离线解绑恢复使用独立、受限、浏览器无关的 cleanup core；绝不进入普通浏览器启动队列。
  for (const handle of envs.values()) {
    if (!handle.offboardCleanup || handle.child || handle.cleanupManual) continue;
    coreBootstrapSupervisor.enqueue({
      key: handle.envId,
      cancelled: () => handle.removed || handle.cleanupManual || !pendingOffboardForEnv(handle.profileId),
      start: () => startRestrictedOffboardCleanupCore(handle),
    });
  }
}

/**
 * 客户会话只提供数据管理能力，不会在登录后自动启动自动化引擎。
 * 这里仅执行归属/绑定收紧：已经失去可信绑定的环境必须停止现有引擎；可信环境保持原状，
 * 等用户明确点击“开始自动化”后才进入引擎和浏览器启动队列。
 */
function enforceOwnedAutomationEngines() {
  if (!clientAuthEnabled() || !hasValidSession() || !(allowedProfileIds instanceof Set)) return;
  for (const handle of envs.values()) {
    if (!handle || handle.removed || handle.kind !== 'adspower' || handle.offboardCleanup) continue;
    const envKey = String(handle.profileId || '').trim();
    const controlState = allowedEnvironmentControlStates.get(envKey);
    const trustworthy = allowedProfileIds.has(envKey) && controlState && controlState.bindingState === 'bound';
    if (!trustworthy) {
      coreBootstrapSupervisor.remove(handle.envId);
      handle.automationIntent = 'stopped';
      handle.engineStopReason = 'binding_untrusted';
      handle.resumeAfterStop = false;
      // 归属仍在但绑定不可信：立刻停止自动化引擎；绝不猜账号，也不靠打开浏览器“修复”。
      if (handle.child) {
        handle.stopRequested = true;
        clearRespawnTimer(handle);
        try { handle.child.kill('SIGTERM'); } catch { /* best-effort */ }
      }
      const reason = controlState && controlState.bindingState
        ? CONTROL_BOOTSTRAP_REASON_ZH[controlState.bindingState] || '云端账号绑定暂不可用'
        : '云端账号绑定暂不可用';
      updateStatus(handle, {
        edge: 'stopped',
        cloud: 'disconnected',
        session: 'idle',
        lastMessage: `自动化未启动：${reason}。数据管理仍可继续使用。`,
        ...edgeFailurePatch(reason),
        ...presencePatch('账号绑定未确认，自动化已限制'),
      });
    }
  }
}

/** fleet 快照（花名册 + 各环境状态 + 选中项），供渲染层建栏/全量对齐。 */
function fleetSnapshot() {
  return {
    provider: settings.provider,
    selectedEnvId,
    railCollapsed: Boolean(settings.railCollapsed),
    cloudEnv: cloudSelectionView(), // compatibility: automation WebSocket target
    cloudTarget: cloudTargetView(), // structured data API + automation WebSocket target
    slots: {
      public: {
        capacity: slotCapacity(),
        occupied: occupiedSlots(),
        queued: queuedStartCount(),
      },
      transient: transientQueueSnapshot(),
    },
    environments: [...envs.values()].map((h) => ({
      envId: h.envId,
      kind: h.kind,
      profileId: h.profileId,
      name: h.name,
      systemName: h.systemName,
      nameSource: h.nameSource,
      nameSyncState: h.nameSyncState,
      platform: h.platform,
      status: statusOf(h),
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
function queueLifecycle(fn, key = null) {
  return lifecycleQueue.enqueue(fn, key);
}

// ── 浏览器执行槽位 + 有界串行启动队列（change browser-slot-scheduling）──
//
// 同机能同时开几个浏览器由**内存**顶死（每个 headful 环境约 700MB；AdsPower 本身不限并发）。
// 所有会打开浏览器的动作——续场恢复 / 冷待机唤醒 / 崩溃重起 / 手动任务 / 排期任务——都必须排这一条队：
// **起完一个再起下一个**；执行准入只比较启动时已确定的浏览器并发，不在任务热路径重读内存。
//
// 旧行为的两个洞：① 准入闸只在「全部启动」按钮上调（单启 / 唤醒 / 重起全部绕过）；② 冷待机唤醒定时器
// 零抖动——撞日额的账号会在上海零点**同一秒**一起冷启，没有任何东西拦得住。
const launchQueue = fleet.createSerialLaunchQueue({
  spacingMs: Number(process.env.AIDCP_FLEET_STAGGER_MS) > 0 ? Number(process.env.AIDCP_FLEET_STAGGER_MS) : undefined,
  logger: (m) => console.log(m),
});

// Machine-wide capacity-1 lane for short-lived browser sidecars. It is intentionally separate from
// the persistent execution-slot pool: API-only interaction runtimes may be running while their
// browser is closed, but every startup/auth sidecar workflow is still deterministic FIFO.
const transientBrowserQueue = fleet.createSerialLaunchQueue({
  spacingMs: 0,
  logger: (m) => console.log(m.replace('[launch-queue]', '[transient-browser]')),
});
const TRANSIENT_BROWSER_LEASE_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.AIDCP_TRANSIENT_BROWSER_LEASE_TIMEOUT_MS) || 7 * 60_000,
);

function usesTransientBrowserLane(handle) {
  return Boolean(handle && fleet.browserUsageModeForPlatform(handle.platform) === 'transient');
}

function personaApplicable(handle) {
  return Boolean(handle && fleet.personaApplicableForPlatform(handle.platform));
}

function transientQueueSnapshot() {
  const owner = [...envs.values()].find((handle) => handle.transientBrowserActive && !handle.removed);
  return {
    capacity: 1,
    occupied: owner ? 1 : 0,
    queued: [...envs.values()].filter((handle) => handle.transientBrowserQueued && !handle.removed).length,
    ownerEnvId: owner ? owner.envId : null,
  };
}

function sendTransientMessage(handle, payload) {
  const child = handle && handle.child;
  if (!child || !child.connected) return false;
  try {
    child.send(payload);
    return true;
  } catch {
    return false;
  }
}

function settleTransientBrowserLease(handle, reason, ok = true) {
  if (!handle || !handle.transientBrowserActive) return false;
  if (handle.transientBrowserLeaseTimer) clearTimeout(handle.transientBrowserLeaseTimer);
  handle.transientBrowserLeaseTimer = null;
  const settle = handle.transientBrowserLeaseSettle;
  handle.transientBrowserLeaseSettle = null;
  handle.transientBrowserActive = false;
  handle.transientBrowserLeaseGeneration = 0;
  handle.transientBrowserRequestId = null;
  if (typeof settle === 'function') settle(ok);
  console.log(`[transient-browser] 释放 ${handle.envId}（${reason}）`);
  broadcastFleet();
  return true;
}

function cancelQueuedTransientBrowser(handle, reason) {
  if (!handle || !handle.transientBrowserQueued) return false;
  const key = handle.transientBrowserQueueKey;
  const requestId = handle.transientBrowserRequestId;
  if (key) transientBrowserQueue.cancel(key);
  handle.transientBrowserQueued = false;
  handle.transientBrowserQueueKey = null;
  handle.transientBrowserRequestId = null;
  if (requestId && requestId !== 'startup') {
    sendTransientMessage(handle, {
      type: 'lifecycle.transient_browser_denied',
      requestId,
      generation: handle.lifecycleGeneration,
      reason,
    });
  }
  broadcastFleet();
  return true;
}

function awaitTransientBrowserRelease(handle, generation) {
  return new Promise((resolve) => {
    handle.transientBrowserLeaseSettle = resolve;
    handle.transientBrowserLeaseTimer = setTimeout(() => {
      if (!handle.transientBrowserActive || handle.transientBrowserLeaseGeneration !== generation) return;
      updateStatus(handle, {
        edge: 'warning',
        lastMessage: '临时浏览器通道占用超时；正在停止本环境并回收通道。',
        ...edgeFailurePatch('临时浏览器通道占用超时'),
        ...presencePatch('临时浏览器通道回收中'),
      });
      if (handle.child) {
        try { handle.child.kill('SIGTERM'); } catch { /* child close/exit owns final release */ }
      } else {
        settleTransientBrowserLease(handle, 'lease_timeout_without_child', false);
      }
    }, TRANSIENT_BROWSER_LEASE_TIMEOUT_MS);
    handle.transientBrowserLeaseTimer.unref?.();
  });
}

function enqueueTransientBrowserLane(handle, {
  generation = handle && handle.lifecycleGeneration,
  requestId = 'startup',
  startCore = false,
  reason = 'startup',
} = {}) {
  if (!handle || !isCurrentLifecycleGeneration(handle, generation) || handle.removed || handle.stopRequested || isQuitting) {
    return false;
  }
  if (handle.transientBrowserQueued || handle.transientBrowserActive) return true;
  const key = `${handle.envId}:transient:${generation}:${requestId}`;
  handle.transientBrowserQueued = true;
  handle.transientBrowserQueueKey = key;
  handle.transientBrowserRequestId = requestId;
  updateStatus(handle, {
    edge: handle.child ? 'running' : 'starting',
    loopStage: null,
    lastMessage: '排队等待临时浏览器通道…',
    ...presencePatch('排队中'),
    ...clearEdgeFailurePatch(handle),
  });
  broadcastFleet();
  void transientBrowserQueue.enqueue({
    key,
    kind: 'resume',
    run: async () => {
      if (!isCurrentLifecycleGeneration(handle, generation) || handle.removed || handle.stopRequested || isQuitting) {
        return false;
      }
      handle.transientBrowserQueued = false;
      handle.transientBrowserQueueKey = null;
      handle.transientBrowserActive = true;
      handle.transientBrowserLeaseGeneration = generation;
      handle.transientBrowserRequestId = requestId;
      updateStatus(handle, {
        edge: handle.child ? 'running' : 'starting',
        lastMessage: startCore ? '正在初始化视频号数据连接…' : '临时浏览器通道已取得，正在处理鉴权…',
        ...presencePatch(startCore ? '正在连接视频号…' : '正在处理视频号鉴权…'),
        ...clearEdgeFailurePatch(handle),
      });
      broadcastFleet();
      const released = awaitTransientBrowserRelease(handle, generation);
      if (startCore) {
        const started = spawnEdgeChild(handle, { generation, transientBrowserLease: true });
        if (!started) {
          settleTransientBrowserLease(handle, 'core_start_rejected', false);
          return false;
        }
        void Promise.resolve(started).catch(() => settleTransientBrowserLease(handle, 'core_start_failed', false));
      } else if (!sendTransientMessage(handle, {
        type: 'lifecycle.transient_browser_granted',
        requestId,
        generation,
      })) {
        settleTransientBrowserLease(handle, 'grant_send_failed', false);
        return false;
      }
      return await released;
    },
  }).then((result) => {
    if (handle.transientBrowserQueueKey === key) {
      handle.transientBrowserQueued = false;
      handle.transientBrowserQueueKey = null;
      handle.transientBrowserRequestId = null;
    }
    if (!result.ok && requestId !== 'startup') {
      sendTransientMessage(handle, {
        type: 'lifecycle.transient_browser_denied',
        requestId,
        generation,
        reason: result.reason || reason || 'cancelled',
      });
    }
    broadcastFleet();
  });
  return true;
}

function startTransientEnvironment(handle, generation = handle && handle.lifecycleGeneration) {
  if (!handle || handle.child || !usesTransientBrowserLane(handle)) return false;
  return enqueueTransientBrowserLane(handle, { generation, requestId: 'startup', startCore: true, reason: 'startup' });
}

function isCurrentLifecycleGeneration(handle, generation) {
  return Boolean(handle && Number.isInteger(generation) && handle.lifecycleGeneration === generation);
}

/**
 * 显式开始/暂停/关闭推进每环境操作代。尚未执行的旧队列项直接取消；已经执行的异步项在自己的
 * generation 闸处收尾，绝不能跨代清标记、重挂唤醒或再次打开浏览器。
 */
function advanceLifecycleGeneration(handle, reason) {
  if (!handle) return 0;
  handle.lifecycleGeneration = (Number(handle.lifecycleGeneration) || 0) + 1;
  handle.lifecycleGenerationReason = reason || 'unknown';
  if (handle.status) {
    handle.status.loopStage = null;
    handle.status.loopStageGeneration = handle.lifecycleGeneration;
    handle.status.loopStageBrowserIndependent = false;
  }
  lifecycleQueue.cancel?.(handle.envId);
  launchQueue.cancel?.(handle.envId);
  launchQueue.cancel?.(`${handle.envId}:wake`);
  cancelQueuedTransientBrowser(handle, reason || 'generation_changed');
  if (handle.transientBrowserActive && !handle.child) {
    settleTransientBrowserLease(handle, 'generation_changed_without_child', false);
  }
  if (typeof handle.wakeSettle === 'function') handle.wakeSettle(false);
  settleLaunchReady(handle, false);
  handle.startFlowQueued = false;
  handle.startFlowGeneration = 0;
  handle.launchQueued = false;
  handle.launchGeneration = 0;
  handle.controlPlaneStarting = false;
  handle.coldStandbyWaking = false;
  handle.wakeGeneration = 0;
  releaseStartQueue(handle);
  clearWakeDeadline(handle);
  return handle.lifecycleGeneration;
}

function ensureEnabledLifecycleGeneration(handle, reason) {
  if (!handle) return 0;
  if (handle.automationIntent !== 'enabled' || handle.stopRequested || handle.engineStopReason) {
    return advanceLifecycleGeneration(handle, reason);
  }
  return handle.lifecycleGeneration;
}

const PER_ENV_BYTES = Number(process.env.AIDCP_PER_ENV_MB) > 0
  ? Number(process.env.AIDCP_PER_ENV_MB) * 1024 * 1024
  : fleet.PER_ENV_BYTES_DEFAULT;
// 自动推算只允许在 Edge 外壳启动时取一次内存快照。任务启动后本身会吃内存；若热路径继续重读，
// 并发会随已经启动的任务持续缩水。设置改回「自动」时也复用本次进程的同一快照，不重新采样。
const STARTUP_USABLE_MEMORY_BYTES = fleet.usableMemoryBytes();
let slotViewCache = null;
/**
 * 两个上限的当前取值：浏览器并发（界面 > 启动参数 > 启动内存快照）+ 启动排队（界面 > 并发 × 2）。
 *
 * 设置一改只会用同一个启动快照重解配置；绝不重读内存。
 */
function slotSettingsView() {
  if (!slotViewCache) {
    slotViewCache = fleet.resolveSlotSettings({
      freeBytes: STARTUP_USABLE_MEMORY_BYTES,
      perEnvBytes: PER_ENV_BYTES,
      slotSetting: settings.browserSlotLimit,
      slotEnv: Number(process.env.AIDCP_BROWSER_SLOTS) || 0,
      maxQueuedStartsSetting: settings.maxQueuedStartLimit,
    });
    slotViewCache.usableMB = Math.round(STARTUP_USABLE_MEMORY_BYTES / (1024 * 1024));
    console.log(
      `[slots] 浏览器并发 ${slotViewCache.capacity}（${slotViewCache.capacitySource}；Edge 启动时可用内存约 ${slotViewCache.usableMB}MB、` +
        `单环境约 ${slotViewCache.perEnvMB}MB，自动推算 ${slotViewCache.autoCapacity}）· ` +
        `启动排队上限 ${slotViewCache.maxQueuedStarts}（${slotViewCache.maxQueuedStartsSource}）`,
    );
  }
  return slotViewCache;
}
function slotCapacity() {
  return slotSettingsView().capacity;
}
function maxQueuedStarts() {
  return slotSettingsView().maxQueuedStarts;
}
/** 当前真正占着浏览器的环境数：有核心子进程 且 不在冷待机（待机中浏览器已被释放、槽位已还回池子）。 */
function occupiedSlots() {
  let n = 0;
  for (const h of envs.values()) {
    // 初始 browser-absent 核心从未打开浏览器；coldStandbyPending 期间也不能虚占一个执行槽。
    if (h.child && !usesTransientBrowserLane(h) && !h.coldStandbyActive && !h.controlPlaneOnly && !h.removed) n += 1;
  }
  return n;
}

/** 当前已获准启动、但尚未进入浏览器执行态的环境数。成员资格按 handle 去重，杜绝重复请求重复占名额。 */
function queuedStartCount() {
  let count = 0;
  for (const handle of envs.values()) {
    if (!handle.startQueueReserved) continue;
    const executing = Boolean(handle.child && !handle.coldStandbyActive && !handle.coldStandbyPending);
    if (handle.removed || handle.stopRequested || handle.status.session === 'paused' || executing) {
      handle.startQueueReserved = false;
      continue;
    }
    count += 1;
  }
  return count;
}

function releaseStartQueue(handle) {
  if (handle) handle.startQueueReserved = false;
}

/**
 * 启动排队准入：只限制等待启动/唤醒的请求数，不限制已创建环境数，也不重新读取内存。
 * 同一环境已经在队列里时幂等成功。
 */
function reserveStartQueue(handle) {
  if (!handle) return { ok: false, reason: 'invalid_environment', message: '环境不存在' };
  const queued = queuedStartCount();
  const limit = maxQueuedStarts();
  const decision = fleet.startQueueAdmission({
    queuedCount: queued,
    limit,
    alreadyQueued: handle.startQueueReserved,
  });
  if (!decision.ok) {
    return {
      ok: false,
      reason: decision.reason,
      queued: decision.queued,
      limit: decision.limit,
      message: `启动排队已满（${decision.queued}/${decision.limit}）`,
    };
  }
  if (decision.added) handle.startQueueReserved = true;
  return decision;
}

function showStartQueueFull(handle, admission) {
  if (!handle) return;
  updateStatus(handle, {
    edge: handle.child ? handle.status.edge : 'idle',
    lastMessage: `${admission.message}，本次未加入；已有排队项进入执行后可重试。`,
    ...presencePatch('启动排队已满，等待重试'),
  });
}
/**
 * 单个环境从 spawn 到「云端已连上」的就绪预算。超时不杀进程——只是**放行队列里的下一个**，
 * 免得一个起不来的环境把整条启动队列堵死（有界是刚性要求）。
 */
const LAUNCH_READY_TIMEOUT_MS = Math.max(60_000, Number(process.env.AIDCP_LAUNCH_READY_TIMEOUT_MS) || 180_000);
/** 等这个环境真正就绪（浏览器起来 + 云端连上）或诚实失败。串行启动队列靠它「起完一个再起下一个」。 */
function awaitLaunchReady(handle) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      handle.launchReady = null;
      resolve(ok);
    };
    const timer = setTimeout(() => {
      console.warn(
        `[launch-queue] ${handle.envId} 未在 ${LAUNCH_READY_TIMEOUT_MS}ms 内就绪；放行队列下一个（不杀它，它可以继续自己起）`,
      );
      finish(false);
    }, LAUNCH_READY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    handle.launchReady = finish;
  });
}
function settleLaunchReady(handle, ok) {
  if (handle && typeof handle.launchReady === 'function') handle.launchReady(ok);
}

/**
 * 浏览器执行准入。只比较同时执行数与本次 Edge 进程已经确定的并发上限；任务热路径不得重读内存。
 */
function admitBrowserSlot(handle) {
  const cap = slotCapacity();
  const used = occupiedSlots();
  if (used >= cap) {
    return { ok: false, reason: 'slots_full', message: `浏览器并发已满（${used}/${cap}）：需等其它环境进入待机让出执行位` };
  }
  return { ok: true };
}

// ── 等槽位队列（change browser-slot-scheduling）──────────────────────────────────
//
// **「槽位被别人占着」不是失败原因，是排队原因。** 任何开浏览器的请求都进这条队，谁都不判失败。
//
// 关键分离（上一版就错在这里）：**调用方的死线只决定「什么时候回话」，绝不决定「要不要把浏览器开起来」。**
//
//   · 排队 = 机器行为。唤醒一旦发起，就一定走到「浏览器起来」或「浏览器真的起不来」。
//     绝不因为某个调用方等不及了，就把一台马上要起来的浏览器撤销掉——它正是下一次重试要命中的东西。
//     撤销是双输：这次没做成，下次还得从冷启重来。
//   · 死线到了 = 回话时机。诚实告诉调用方「这次没轮到你」（云端已按可恢复处理：归还小时格 + 格内重试），
//     **但环境留在队列里、浏览器继续起**。下一次重试大概率直接命中一个已经热好的浏览器。
//
// 上一版按「有没有人在死线上等」分流（有人等 → 当场判失败），把两件不同的事压成了一件；更糟的是那个
// 「失败」还是假的：外壳槽位拒绝时**一个字节都不回核心**，核心在浏览器闸上干等满 180s 唤醒死线，
// 云端早已超时走人——先把调用方吊死，再对着空气说失败，顺手把这个环境做成一块砖（不在队列里、
// 待机定时器被清掉不还、核心的唤醒闩永久置位 → 此后再不请求唤醒）。三个 bug 一起修。
//
// 排队 MUST NOT 变成静默：界面如实显示「排队等槽位 · 前面还有 k 个」，MUST NOT 显示成「唤醒失败」。
// FIFO 严格按入队时刻，**不设优先级**：带死线的唤醒是连续到达的，让它们插队 = 1:2 里多挂的那一半
// 被无限期挤到后面、永远排不上。死线只换「早点回话」，不换「插到别人前面」。

/** 等槽位重扫间隔：槽位释放会立即触发一次；这个定时器兜住「内存被别的进程放开」这类无事件的变化。 */
const SLOT_WAIT_RESCAN_MS = 15_000;
/**
 * 冷启地板：从零把一个浏览器起来的最短现实耗时（AdsPower start + CDP ready + 身份 + 云端握手）。
 * 调用方剩余预算低于它 → 我们**在第 0 秒就知道做不到**，当场诚实作答，绝不让它干等到自己超时。
 * （但仍然排队、仍然把浏览器起起来——见上面那条分离。）
 */
const COLD_START_FLOOR_MS = Math.max(1_000, Number(process.env.AIDCP_COLD_START_FLOOR_MS) || 30_000);
let slotWaitTimer = null;

/**
 * 当前在等槽位的环境，FIFO。
 *
 * 队列成员资格在这里**一处**判定：被暂停 / 停止 / 移出 / 已经起来了的，就地退出队列并清掉资历
 * ——不然一个暂停了几小时的环境再恢复时，会拿着几小时前的入队时刻直接空降队头，把一直在等的人挤掉。
 */
function slotWaiters() {
  const out = [];
  for (const h of envs.values()) {
    if (!h.slotWaitingSince) continue;
    const parked = h.coldStandbyActive || h.coldStandbyPending; // 待机中的核心还活着，但浏览器已关 = 不占槽位
    const running = h.child && !parked;
    if (h.removed || running || h.stopRequested || h.status.session === 'paused') {
      clearSlotWaiting(h);
      continue;
    }
    out.push(h);
  }
  return fleet.orderSlotWaiters(out);
}

/**
 * 进等槽位队列。已在队列里的保留原入队时刻——重扫不该让它丢掉排在前面的资历。
 *
 * `deadlineAt`（可选）= 有调用方在这个时刻之后就不要结果了。它**只**用来挂一个到点定时器，
 * 到点如实回一句「这次没轮到你」给核心；**环境不出队、唤醒不撤销、浏览器照常起**。
 */
function parkForSlot(handle, admitted) {
  if (!handle.slotWaitingSince) handle.slotWaitingSince = Date.now();
  handle.slotWaitReason = admitted.message;
  const ahead = slotWaiters().filter((h) => h.slotWaitingSince < handle.slotWaitingSince).length;
  const place = ahead > 0 ? `前面还有 ${ahead} 个` : '下一个就是它';
  console.log(`[slots] ${handle.envId} 排队等槽位（${place}）：${admitted.message}`);
  armWakeDeadline(handle, `${admitted.reason}:queued#${ahead + 1}`);
  // 待机中的环境（核心与云端连接都还在，只是浏览器关了）保持它的待机态——它并没有「停掉」，
  // 只是这次唤醒没抢到槽位；把它改写成 idle 会让界面看起来像整个环境掉了。
  const parked = handle.coldStandbyActive || handle.coldStandbyPending;
  updateStatus(handle, {
    ...(parked ? {} : { edge: 'idle', session: 'idle' }),
    lastMessage: `排队等槽位（${place}）：${admitted.message}。有账号进入待机让出槽位后会自动${parked ? '唤醒' : '启动'}。`,
    ...clearEdgeFailurePatch(handle),
    ...presencePatch(`排队等槽位（${place}）`),
  });
  startSlotWaitTimer();
}

/**
 * 到点告诉核心「这次没轮到你」——**只是回话，不是放弃**。
 *
 * 核心据此立刻让在等浏览器的动作诚实作答（云端拿到 `browser_wake_failed` 会归还小时格并在格内重试）。
 * 这个环境**仍在 FIFO 队列里**，浏览器该起还是会起；下一次重试大概率直接命中一个已经热好的浏览器。
 * 不发这条 = 核心在浏览器闸上空转满 180s 唤醒死线（旧版的真实行为）。
 */
function denyWakeNow(handle, detail) {
  clearWakeDeadline(handle);
  if (!handle.child) return;
  try {
    handle.child.send({ type: 'lifecycle.wake_denied', detail });
    const retained = Boolean(handle.slotWaitingSince || handle.startQueueReserved
      || handle.startFlowQueued || handle.launchQueued);
    console.log(retained
      ? `[slots] ${handle.envId} 告知核心「这次没轮到」（${detail}）：仍在权威队列中，浏览器轮到后继续起`
      : `[slots] ${handle.envId} 告知核心「这次没轮到」（${detail}）：本次未入队，将按退避计划重试`);
  } catch (error) {
    console.warn(`[slots] ${handle.envId} wake_denied 未送达：${error.message}`);
  }
}

/** 挂调用方死线的到点定时器。剩余预算已低于冷启地板 → 第 0 秒就作答（绝不让它干等到自己超时）。 */
function armWakeDeadline(handle, detail) {
  const deadlineAt = handle.wakeDeadlineAt;
  if (!deadlineAt) return;
  clearWakeDeadline(handle);
  const budgetMs = deadlineAt - Date.now();
  if (budgetMs < COLD_START_FLOOR_MS) {
    // 冷启至少要 30s，调用方却只剩这么点——**现在就知道做不到**，当场诚实作答。
    denyWakeNow(handle, budgetMs <= 0 ? `${detail}:deadline_passed` : `${detail}:deadline_below_cold_start`);
    return;
  }
  handle.wakeDeadlineTimer = setTimeout(() => denyWakeNow(handle, detail), budgetMs);
  if (typeof handle.wakeDeadlineTimer.unref === 'function') handle.wakeDeadlineTimer.unref();
}

function clearWakeDeadline(handle) {
  if (!handle || !handle.wakeDeadlineTimer) return;
  clearTimeout(handle.wakeDeadlineTimer);
  handle.wakeDeadlineTimer = null;
}

function clearSlotWaiting(handle) {
  if (!handle) return;
  handle.slotWaitingSince = 0;
  handle.slotWaitReason = '';
}

/**
 * 槽位可能空出来了 → 按 FIFO 放行队头。
 *
 * 一次只放一个：准入闸是按**当下**的内存算的，一口气把队列全放出去等于回到「10 个环境一起冷启」。
 * 队头过不了闸就整队停住（不许后面的插队）——先来的账号必须先上，否则它会被后来者反复挤掉、饿死。
 */
function drainSlotWaiters() {
  const waiting = slotWaiters();
  if (waiting.length === 0) {
    stopSlotWaitTimer();
    return;
  }
  const head = waiting[0];
  if (!admitBrowserSlot(head).ok) return; // 队头还进不来 → 整队继续等，绝不让后面的插队
  console.log(`[slots] 槽位空出来了 → 放行队头 ${head.envId}（还有 ${waiting.length - 1} 个在等）`);
  clearSlotWaiting(head);
  // 两种等法：核心还活着、只是待机中（浏览器已关）→ 原地唤醒；核心也没了 → 完整启动。
  // 用**存下来的原始 reason** 重新驱动唤醒：即使调用方的死线早就到了（我们已如实回过话），浏览器也要起——
  // 云端的下一次重试正等着命中它。
  if (head.child && (head.coldStandbyActive || head.coldStandbyPending)) wakeColdStandby(head, head.wakeReason || 'slot_available');
  else startEdge(head);
}

function startSlotWaitTimer() {
  if (slotWaitTimer) return;
  slotWaitTimer = setInterval(() => drainSlotWaiters(), SLOT_WAIT_RESCAN_MS);
  if (typeof slotWaitTimer.unref === 'function') slotWaitTimer.unref();
}

function stopSlotWaitTimer() {
  if (!slotWaitTimer) return;
  clearInterval(slotWaitTimer);
  slotWaitTimer = null;
}

// ── 每环境有界重起（复用 respawn-policy 语义；CJS 副本见 fleet.cjs，parity 用例锁一致）──
const RESPAWN_OPTS = {
  maxConsecutiveFailures: Number(process.env.AIDCP_EDGE_RESPAWN_MAX ?? 5),
  backoffBaseMs: Number(process.env.AIDCP_EDGE_RESPAWN_BACKOFF_BASE_MS ?? 1_000),
  backoffMaxMs: Number(process.env.AIDCP_EDGE_RESPAWN_BACKOFF_MAX_MS ?? 30_000),
  healthyUptimeMs: Number(process.env.AIDCP_EDGE_RESPAWN_HEALTHY_UPTIME_MS ?? 60_000),
};
// 护栏：AdsPower「同账号并发占用拒启」识别为不可重起终局（默认开）。关掉（'0'/'false'/'off'/'no'）
// 则退回把它按普通崩溃走有界重起的旧行为，供识别误伤时应急回退。
const ENV_IN_USE_TERMINAL = !['0', 'false', 'off', 'no'].includes(
  String(process.env.AIDCP_EDGE_ENV_IN_USE_TERMINAL ?? '').trim().toLowerCase(),
);
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
  normal: { color: '#ffffff', symbolColor: '#172238', height: 46 },
  warned: { color: '#fff8ec', symbolColor: '#5b4708', height: 46 },
  danger: { color: '#fff0f1', symbolColor: '#7f1d1d', height: 46 },
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

const {
  DAILY_USAGE_ACTIONS,
  cleanCount,
  cleanOptionalCount,
  cleanOptionalCounts,
  cleanSuppliedCounts,
  normalizeDailyUsage,
  bumpDailyUsage,
} = require('./daily-usage.cjs');

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

/** 每环境状态合并 + 广播（status:update 带 envId 路由键；渲染层按键归属，绝不串号）。 */
function updateStatus(handle, patch) {
  // 计数补丁先跟现值合并成**完整** stats 再落（修老 bug：Object.assign 先把 stats 整体
  // 替换成局部补丁，随后的合并对象已被替换 → 未提及的计数被清空、渲染层出现空数字）。
  let full = patch.stats ? { ...patch, stats: mergeStats(handle.status.stats, patch.stats) } : patch;
  if (full.loopStage === null && full.loopStageBrowserIndependent === undefined) {
    full = { ...full, loopStageBrowserIndependent: false };
  }
  Object.assign(handle.status, full, { updatedAt: new Date().toISOString() });
  syncBrowserPersonaNotice(handle);
  if (patch.risk && handle.envId === selectedEnvId) applyOverlayTone(patch.risk);
  if (full.lastPublish) saveUiState();
  // 增量状态与 fleet 全量快照必须共用同一份完整投影。渲染层会按 envId 整体替换
  // status；若这里仅展开原始 handle.status，下一次普通心跳就会丢掉四轴与权威
  // 队列位次，把正确的待机/排队状态重新兼容推断成运行/启动。
  const payload = statusOf(handle);
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

// 失败归因候选 = 核心真的异常退出时，呈现给运营的那句「失败原因」。
// 回归前这里按 isError 短路：走 stderr 的行**一律**被采信，于是任何一条良性 warn（诊断 / 遥测上报失败 /
// 槽位排队）都会覆盖掉 lastEdgeFailureLine —— 等核心真出事，界面给的归因是最后那条**无关**的良性 warn。
// 现在一律按内容判定（fleet.isFailureShapedLine，纯函数、带良性排除表），与该行走哪根管子无关。
function rememberEdgeFailureCandidate(handle, message) {
  const raw = String(message || '');
  if (!fleet.isFailureShapedLine(raw)) return;
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
// notifications 放行：客户端自身的状态提醒经本窗口发出，不该被拦（change browser-permission-prompt-defaults）；
// 设备类权限（定位/摄像头/麦克风等）仍默认拒绝。指纹浏览器的权限弹窗由其自身抑制、与本窗口策略无关。
const BROWSER_PERMISSION_ALLOWLIST = new Set(['fullscreen', 'pointerLock', 'notifications']);
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
      titleBarOverlay: { color: '#ffffff', symbolColor: '#172238', height: 46 },
    };
  }
  return {};
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
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
      if (!tray) {
        mainWindow.show();
        mainWindow.focus();
        surfaceFailure('AIDCP Edge 托盘不可用', '托盘入口未能创建，窗口将保持显示，避免监督者在后台不可发现。');
        return;
      }
      mainWindow.hide();
    }
  });
}

function createTray() {
  try {
    const iconPath = resolveTrayIconPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
    if (!fs.existsSync(iconPath)) throw new Error(`tray icon file not found: ${iconPath}`);
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error(`tray icon decoded empty: ${iconPath}`);

    tray = new Tray(icon);
    tray.setToolTip('AIDCP Edge');
    const trayTemplate = [
      { label: '显示窗口', click: () => mainWindow?.show() },
      { label: '隐藏窗口', click: () => mainWindow?.hide() },
      { type: 'separator' },
      { label: '显示浏览器窗口', click: () => { void sendBrowserParkingCommand(selectedHandle(), 'browser.show'); } },
      { label: '重置浏览器位置', click: () => { void sendBrowserParkingCommand(selectedHandle(), 'browser.park'); } },
      { type: 'separator' },
    ];
    // 对外客户登录态下提供「退出登录」（change edge-client-customer-auth）：停所有环境、回登录门,不改主界面。
    if (clientAuthEnabled()) {
      trayTemplate.push({ label: '退出登录', click: () => { if (clientSession && clientSession.token) void clientAuthFetch('/logout', { method: 'POST', token: clientSession.token }); onSessionInvalid({ forgetCredentials: true }); } });
    }
    trayTemplate.push({ label: '退出', click: quitApp });
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate));
    tray.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else mainWindow.show();
    });
    return true;
  } catch (error) {
    try { tray?.destroy(); } catch { /* best-effort */ }
    tray = undefined;
    const message = (error && error.message) || String(error);
    appendEdgeLog('supervisor', `tray unavailable: ${message}`, true);
    surfaceFailure('AIDCP Edge 托盘不可用', `托盘图标加载失败，窗口将保持显示：${message}`);
    return false;
  }
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
  if (!personaApplicable(handle)) {
    resetPersonaNoticeGrace(handle);
    handle.browserPersonaNoticeState = browserPersonaNoticeKey({ active: false });
    return;
  }
  const ready = personaNoticeReady(handle);
  if (!ready) handle.personaNoticeReadySince = 0;
  else if (!handle.personaNoticeReadySince) handle.personaNoticeReadySince = Date.now();

  let notice = browserPersonaNoticeForStatus(handle.status, handle);
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
  // 指令写入成功只证明目标核心已接受，不证明操作系统真的把窗口置顶。成功保持静默；
  // writeBrowserControlCommand 的失败仍原样返回给目标环境，绝不把受理包装成已完成。
  return { ok: true };
}

function focusAidcpAboveDrivenBrowser() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: 'AIDCP 主窗口已关闭，无法把它恢复到浏览器上方' };
  }
  try {
    if (typeof mainWindow.isMinimized === 'function' && mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (typeof mainWindow.moveTop === 'function') mainWindow.moveTop();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'AIDCP 主窗口恢复前台失败' };
  }
}

function handleBrowserParkingReply(handle, raw) {
  let reply;
  try {
    reply = JSON.parse(String(raw || ''));
  } catch {
    return false;
  }
  const id = reply && typeof reply.id === 'string' ? reply.id : '';
  const pending = id ? browserShowPending.get(id) : null;
  if (!pending || pending.envId !== handle?.envId) return false;
  browserShowPending.delete(id);
  clearTimeout(pending.timer);
  if (reply.ok !== true) {
    pending.resolve({ ok: false, error: String(reply.error || '浏览器窗口移动失败') });
    return true;
  }
  pending.resolve(focusAidcpAboveDrivenBrowser());
  return true;
}

function showDrivenBrowserBelowClient(handle) {
  if (!handle || !handle.child || !handle.browserParkingReady || !handle.child.stdin || handle.child.stdin.destroyed) {
    return Promise.resolve({ ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' });
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve({ ok: false, error: 'AIDCP 主窗口已关闭，无法计算浏览器正后方位置' });
  }
  let targetBounds;
  try {
    const clientBounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(clientBounds);
    targetBounds = clientAlignedBrowserBounds(clientBounds, display);
  } catch (error) {
    return Promise.resolve({ ok: false, error: error?.message || '读取 AIDCP 窗口位置失败' });
  }
  if (!targetBounds) {
    return Promise.resolve({ ok: false, error: 'AIDCP 窗口位置无效，未移动浏览器' });
  }
  const id = `browser-show-${crypto.randomUUID()}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      browserShowPending.delete(id);
      resolve({ ok: false, error: '浏览器窗口移动超时，AIDCP 未收到完成确认' });
    }, BROWSER_SHOW_COMPLETION_TIMEOUT_MS);
    browserShowPending.set(id, { envId: handle.envId, resolve, timer });
    const sent = writeBrowserControlCommand(handle, 'browser.show', { requestId: id, bounds: targetBounds });
    if (!sent.ok) {
      browserShowPending.delete(id);
      clearTimeout(timer);
      resolve(sent);
    }
  });
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

/**
 * 客户端发起的 publish RPC 统一出口（审批 / 删配图共用一张 pending 表与同一条回执前缀）。
 * 超时阶梯必须保持 35s > core 侧 30s：主进程若先超时，core 的诚实拒因就再也送不回来了。
 */
function sendPublishClientCommand(envId, type, payload) {
  return new Promise((resolve) => {
    const handle = envId ? envs.get(envId) : selectedHandle();
    if (!handle || !handle.child || !handle.child.stdin || handle.child.stdin.destroyed) {
      resolve({ ok: false, reason: 'edge_not_running' });
      return;
    }
    const id = `publish-approval-${++publishApprovalSeq}-${Date.now()}`;
    const timer = setTimeout(() => {
      publishApprovalPending.delete(id);
      resolve({ ok: false, reason: 'edge_request_timeout' });
    }, 35_000);
    publishApprovalPending.set(id, { resolve, timer });
    try {
      handle.child.stdin.write(`${JSON.stringify({ type, id, payload })}\n`);
    } catch {
      clearTimeout(timer);
      publishApprovalPending.delete(id);
      resolve({ ok: false, reason: 'edge_write_failed' });
    }
  });
}

function sendPublishApprovalCommand(envId, payload) {
  return sendPublishClientCommand(envId, 'publish.approval_action', payload);
}

/**
 * 删配图成功后就地更新该环境的稿件预览真态。
 *
 * MUST 在主进程改：status.publishPreview 的唯一写者是主进程，渲染层任何本地补丁都会被下一帧
 * status:update 广播整体顶掉（抽屉每帧重建）——只改渲染层的话，删掉的图过几秒会「长回来」。
 * 只在应答的 recordId 与当前预览一致时才写，防过期应答污染新草稿。
 */
function applyPublishPreviewImages(envId, recordId, images, contentVersion) {
  const handle = envId ? envs.get(envId) : selectedHandle();
  const preview = handle && handle.status ? handle.status.publishPreview : null;
  if (!preview || typeof preview !== 'object') return;
  if (Number(preview.recordId) !== Number(recordId)) return;
  if (!Array.isArray(images) || !Number.isInteger(contentVersion)) return;
  updateStatus(handle, {
    publishPreview: { ...preview, images: images.slice(), contentVersion },
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

function handlePublishApprovalReply(jsonText) {
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return;
  }
  const entry = obj && obj.id ? publishApprovalPending.get(obj.id) : undefined;
  if (!entry) return;
  clearTimeout(entry.timer);
  publishApprovalPending.delete(obj.id);
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
  if (decision.action !== 'respawn' || isQuitting || handle.automationIntent !== 'enabled') return;
  handle.respawnTimer = setTimeout(() => {
    handle.respawnTimer = null;
    if (isQuitting || handle.removed || handle.child || handle.stopRequested || handle.automationIntent !== 'enabled') return;
    void enqueueStartFlow(handle);
  }, decision.delayMs || 0);
  if (handle.respawnTimer && typeof handle.respawnTimer.unref === 'function') handle.respawnTimer.unref();
}

/**
 * 把窄生命周期意图送到该环境自己的自动化引擎。普通 lifecycle.pause 交付失败不冒充成功；
 * pause_and_exit / close 的调用方可按自身安全策略回落 SIGTERM。异步失败始终按目标 handle 原位回报。
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

function failPendingCoreRebind(handle, reason) {
  const pending = handle && handle.cloudRebindPending;
  if (!pending) return;
  clearTimeout(pending.timer);
  handle.cloudRebindPending = null;
  updateStatus(handle, {
    cloudRebind: { state: 'failed', targetKey: pending.targetKey, reason },
    lastMessage: `自动化引擎重绑失败：${reason}。浏览器状态未改变。`,
    ...presencePatch('自动化引擎重绑失败'),
  });
  pending.resolve({ ok: false, reason });
}

/** Rebind only a core's Cloud transport; browser/provider/CDP/slot state is intentionally absent. */
function requestCoreCloudRebind(handle, target) {
  return new Promise((resolve) => {
    const child = handle && handle.child;
    if (!child || typeof child.send !== 'function' || child.connected === false) {
      resolve({ ok: false, reason: 'core_offline' });
      return;
    }
    const requestId = `cloud-rebind-${crypto.randomUUID()}`;
    const timer = setTimeout(() => {
      if (!handle.cloudRebindPending || handle.cloudRebindPending.requestId !== requestId) return;
      handle.cloudRebindPending = null;
      updateStatus(handle, {
        cloudRebind: { state: 'failed', targetKey: target.key, reason: 'rebind_timeout' },
        lastMessage: `自动化引擎切换到 ${target.label || target.key} 超时；浏览器状态未改变。`,
        ...presencePatch('自动化引擎重绑超时'),
      });
      resolve({ ok: false, reason: 'rebind_timeout' });
    }, 45_000);
    if (typeof timer.unref === 'function') timer.unref();
    handle.cloudRebindPending = { requestId, targetKey: target.key, timer, resolve };
    updateStatus(handle, {
      targetCloudKey: target.key,
      cloudRebind: { state: 'pending', targetKey: target.key },
      lastMessage: `正在把自动化引擎重绑到 ${target.label || target.key}；浏览器状态与槽位保持不变。`,
      ...presencePatch('正在切换 Cloud 控制连接…'),
    });
    try {
      child.send({
        type: 'lifecycle.cloud_rebind',
        requestId,
        url: target.url,
        targetKey: target.key,
      }, (error) => {
        if (!error || handle.child !== child || handle.cloudRebindPending?.requestId !== requestId) return;
        clearTimeout(timer);
        handle.cloudRebindPending = null;
        updateStatus(handle, {
          cloudRebind: { state: 'failed', targetKey: target.key, reason: error.message },
          lastMessage: `自动化引擎重绑指令未送达：${error.message}。浏览器状态未改变。`,
          ...presencePatch('自动化引擎重绑未送达'),
        });
        resolve({ ok: false, reason: 'ipc_send_failed' });
      });
    } catch (error) {
      clearTimeout(timer);
      handle.cloudRebindPending = null;
      const reason = (error && error.message) || String(error);
      updateStatus(handle, {
        cloudRebind: { state: 'failed', targetKey: target.key, reason },
        lastMessage: `自动化引擎重绑指令未送达：${reason}。浏览器状态未改变。`,
        ...presencePatch('自动化引擎重绑未送达'),
      });
      resolve({ ok: false, reason: 'ipc_send_failed' });
    }
  });
}

function clearColdStandbyTimer(handle) {
  if (!handle) return;
  if (handle.coldStandbyTimer) clearTimeout(handle.coldStandbyTimer);
  handle.coldStandbyTimer = null;
  handle.coldStandbyWakeAt = 0;
  handle.coldStandbyPending = false;
  handle.coldStandbyActive = false;
  handle.coldStandbyWaking = false;
  handle.wakeGeneration = 0;
  clearColdStandbyHoldTimer(handle);
}

/** 清掉「最短持有时长满足后重新判定」的定时器。不清 coldStandbyLastWokenAt——那是唤醒时刻的事实、不是定时器。 */
function clearColdStandbyHoldTimer(handle) {
  if (!handle) return;
  if (handle.coldStandbyHoldTimer) clearTimeout(handle.coldStandbyHoldTimer);
  handle.coldStandbyHoldTimer = null;
}

function coldStandbyStatus(mode, hint, extra = {}) {
  const normalized = normalizeBrowserStandbyHint(hint);
  return {
    mode,
    ...(normalized ? { hint: normalized, wakeAt: normalized.wakeAt, reason: normalized.reason } : {}),
    ...extra,
    at: new Date().toISOString(),
  };
}

function coldStandbyFlags(handle) {
  return {
    hasChild: Boolean(handle.child),
    restartPending: handle.restartPending,
    pausePending: handle.pausePending,
    closePending: handle.closePending,
    coreParked: handle.coreParked,
    removed: handle.removed,
    stopRequested: handle.stopRequested,
  };
}

function applyBrowserStandbyHint(handle, rawHint) {
  if (!handle) return;
  const hint = normalizeBrowserStandbyHint(rawHint);
  const settingsView = normalizeColdStandbySettings(settings, process.env);
  // 重新判定 → 先撤掉上一次 min_hold 排的重判定时器（本次会按最新提示重排）。
  clearColdStandbyHoldTimer(handle);
  const decision = shouldEnterColdStandby({
    status: handle.status,
    flags: coldStandbyFlags(handle),
    hint,
    settings: settingsView,
    now: Date.now(),
    // 已在待机中的环境不受最短持有时长约束（它没有「刚醒来」这回事）——只有醒着的环境才谈得上「持有多久」。
    lastWokenAt: (handle.coldStandbyActive || handle.coldStandbyPending)
      ? undefined
      : (handle.coldStandbyLastWokenAt || undefined),
  });
  if (!decision.ok) {
    // 最短持有时长未满：**绝不能把这条提示丢掉**。外层那个 if 只处理「待机中」与「disabled」两种情形，
    // 普通 skip 是直接 return、什么都不做的——若在此丢弃，该环境就永远留在开启态、再也不会让出槽位
    // （云端 60s 周期链虽会再推，但那只是碰运气：提示内容不变时判定结果同样是 min_hold，直到某一跳恰好
    // 落在持有期之后。显式排一个到点重判的定时器才是确定性的）。
    if (decision.reason === 'min_hold') {
      const delay = Math.max(1_000, Math.ceil(decision.holdRemainingMs || 0));
      handle.coldStandbyHoldTimer = setTimeout(() => {
        handle.coldStandbyHoldTimer = null;
        applyBrowserStandbyHint(handle, hint);
      }, delay);
      if (typeof handle.coldStandbyHoldTimer.unref === 'function') handle.coldStandbyHoldTimer.unref();
      updateStatus(handle, {
        browserStandby: coldStandbyStatus('skipped', hint, { reason: 'min_hold', holdRemainingMs: delay }),
      });
      return;
    }
    if (handle.coldStandbyActive || handle.coldStandbyPending || decision.reason === 'disabled') {
      if (handle.coldStandbyActive || handle.coldStandbyPending) {
        wakeColdStandby(handle, decision.reason);
        return;
      }
      clearColdStandbyTimer(handle);
      updateStatus(handle, {
        browserStandby: coldStandbyStatus(decision.reason === 'disabled' ? 'disabled' : 'skipped', hint, { reason: decision.reason }),
      });
    }
    return;
  }
  if (handle.coldStandbyActive) {
    scheduleColdStandbyWake(handle, decision);
    updateStatus(handle, {
      browserStandby: coldStandbyStatus('sleeping', decision.hint, {
        wakeDelayMs: decision.wakeDelayMs,
        warmupMs: decision.warmupMs,
      }),
      ...presencePatch('长时间等待中，浏览器已关闭，云端连接保持中'),
    });
    return;
  }
  enterColdStandby(handle, decision);
}

function enterColdStandby(handle, decision) {
  if (!handle || !handle.child || handle.coldStandbyPending || handle.coldStandbyActive) return;
  clearColdStandbyTimer(handle);
  handle.coldStandbyPending = true;
  handle.coldStandbyWakeAt = decision.hint.wakeAt;
  updateStatus(handle, {
    session: 'resting',
    browserStandby: coldStandbyStatus('scheduled', decision.hint, {
      wakeDelayMs: decision.wakeDelayMs,
      warmupMs: decision.warmupMs,
    }),
    lastMessage: `预计等待约 ${Math.ceil(decision.remainingMs / 60_000)} 分钟，正在关闭浏览器进入冷待机…`,
    ...presencePatch('长时间等待，正在关闭浏览器冷待机…'),
    ...clearEdgeFailurePatch(handle),
  });
  const child = handle.child;
  sendCoreLifecycle(handle, 'standby', (error) => {
    if (handle.child !== child) return;
    clearColdStandbyTimer(handle);
    updateStatus(handle, {
      edge: 'warning',
      session: handle.status.session === 'resting' ? 'running' : handle.status.session,
      browserStandby: coldStandbyStatus('skipped', decision.hint, { reason: 'standby_failed' }),
      lastMessage: `冷待机失败：${error.message}。浏览器关闭状态未确认。`,
      ...edgeFailurePatch(`冷待机失败：${error.message}`),
      ...presencePatch('冷待机请求未送达'),
    });
  });
}

function onColdStandbyAck(handle) {
  if (!handle || !handle.coldStandbyPending) return;
  const bornBrowserAbsent = Boolean(handle.controlPlaneOnly);
  handle.coldStandbyPending = false;
  handle.coldStandbyActive = true;
  handle.closePending = false;
  if (handle.controlPlaneOnly) handle.controlPlaneBootstrapped = true;
  // 浏览器关掉了 = 一个槽位空出来了：立刻叫等槽位队列的队头，别让它白等到下一次重扫。
  setTimeout(() => drainSlotWaiters(), 0);
  const hint = handle.status.browserStandby && handle.status.browserStandby.hint;
  const decision = shouldEnterColdStandby({
    status: { ...handle.status, edge: 'running', cloud: 'connected', session: handle.automationPaused ? 'paused' : 'resting' },
    flags: { ...coldStandbyFlags(handle), closePending: false, pausePending: false },
    hint,
    settings: normalizeColdStandbySettings(settings, process.env),
    now: Date.now(),
  });
  if (decision.ok) scheduleColdStandbyWake(handle, decision);
  updateStatus(handle, {
    edge: 'running',
    cloud: 'connected',
    session: handle.automationPaused ? 'paused' : 'resting',
    loopStage: null,
    overlayBlocked: false,
    browserStandby: coldStandbyStatus('sleeping', hint, decision.ok ? {
      wakeDelayMs: decision.wakeDelayMs,
      warmupMs: decision.warmupMs,
    } : { reason: decision.reason }),
    lastMessage: bornBrowserAbsent
      ? '自动化引擎已连接；浏览器保持关闭，按需申请执行槽位。'
      : '浏览器已关闭；自动化引擎保持连接。',
    ...presencePatch(bornBrowserAbsent
      ? '自动化引擎已连接，浏览器已关闭'
      : '浏览器已关闭，自动化引擎已连接'),
    ...clearEdgeFailurePatch(handle),
  });
}

function updateColdStandbyCloudRecovery(handle, state, reason) {
  if (!handle || (!handle.coldStandbyPending && !handle.coldStandbyActive)) return;
  const hint = handle.status.browserStandby && handle.status.browserStandby.hint;
  const reconnected = state === 'reconnected';
  updateStatus(handle, {
    session: 'resting',
    ...(reconnected ? { cloud: 'connected' } : {}),
    overlayBlocked: false,
    browserStandby: coldStandbyStatus('sleeping', hint, {
      reason: reconnected ? 'cloud_reconnected' : 'cloud_reconnecting',
      ...(reason ? { detailReason: reason } : {}),
    }),
    lastMessage: reconnected
      ? '冷待机中，云端连接已恢复。'
      : '冷待机中，正在后台恢复云端连接；浏览器保持待机。',
    ...presencePatch(reconnected ? '长时间等待中，云端连接已恢复' : '长时间等待中，云端连接恢复中'),
    ...clearEdgeFailurePatch(handle),
  });
}

function scheduleColdStandbyWake(handle, decision) {
  if (!handle || !decision.ok) return;
  const generation = handle.lifecycleGeneration;
  if (handle.coldStandbyTimer) clearTimeout(handle.coldStandbyTimer);
  handle.coldStandbyWakeAt = decision.hint.wakeAt;
  handle.coldStandbyTimer = setTimeout(() => {
    handle.coldStandbyTimer = null;
    if (!isCurrentLifecycleGeneration(handle, generation) || handle.stopRequested) return;
    wakeColdStandby(handle, 'scheduled_wake');
  }, decision.wakeDelayMs);
  if (handle.coldStandbyTimer && typeof handle.coldStandbyTimer.unref === 'function') handle.coldStandbyTimer.unref();
}

/**
 * 唤醒未完成后重挂自唤醒定时器（退避 1min → 2min → 5min 封顶）。
 *
 * `wakeColdStandby` 一进门就把待机定时器清了。旧版失败时不还——于是**一次唤醒失败 = 这个环境永久停摆**：
 * 它既没有自唤醒定时器，核心那边的唤醒闩也永久置位（再不会向外壳请求），云端的任务全部打空。
 * 退避是刚性的：AdsPower 真坏掉时，绝不 60s 一次地无限重敲它。
 */
function rearmWakeRetry(handle, generation = handle && handle.lifecycleGeneration, retryCause = 'wake_failed') {
  if (!handle || handle.removed || handle.stopRequested || isQuitting
    || !isCurrentLifecycleGeneration(handle, generation)) return;
  if (handle.coldStandbyTimer) clearTimeout(handle.coldStandbyTimer);
  handle.wakeRetryStreak = Math.min((handle.wakeRetryStreak || 0) + 1, 3);
  const delayMs = [60_000, 120_000, 300_000][handle.wakeRetryStreak - 1];
  handle.coldStandbyTimer = setTimeout(() => {
    handle.coldStandbyTimer = null;
    if (!isCurrentLifecycleGeneration(handle, generation) || handle.stopRequested) return;
    wakeColdStandby(handle, 'wake_retry');
  }, delayMs);
  if (typeof handle.coldStandbyTimer.unref === 'function') handle.coldStandbyTimer.unref();
  const retryLabel = retryCause === 'start_queue_full' ? '启动排队已满' : '唤醒失败';
  console.log(`[standby] ${handle.envId} ${retryLabel}，${Math.round(delayMs / 1000)}s 后自动重试（仍保持待机）`);
}

/**
 * 冷待机唤醒（change browser-slot-scheduling）：**下发原地重建，不再 SIGTERM 核心重启整个进程**。
 *
 * 旧行为：resumeEdge 在浏览器已关时走不了快路径 → stopAndRestart → 杀核心 → 完整冷启，云端连接断一次
 * 重连一次、启动时间线整条重放。唤醒会变成高频动作（每小时都可能发生），不能每次都掀一次桌子。
 *
 * 待机态只在核心回报 `lifecycle.woken` 后才解除——绝不在下发的那一刻就乐观地把它标成已醒（那是假成功）。
 * 核心不在（IPC 不可用）才退回 stopAndRestart：那时确实只能冷启。
 */
function wakeColdStandby(handle, reason) {
  if (!handle || handle.stopRequested || (!handle.coldStandbyActive && !handle.coldStandbyPending)) return;
  if (handle.coldStandbyWaking) return; // 幂等：已在唤醒中，绝不重开第二个浏览器
  const generation = handle.lifecycleGeneration;
  const queueAdmission = reserveStartQueue(handle);
  if (!queueAdmission.ok) {
    handle.wakeReason = reason;
    denyWakeNow(handle, 'start_queue_full');
    updateStatus(handle, {
      browserStandby: coldStandbyStatus('sleeping', handle.status.browserStandby && handle.status.browserStandby.hint, {
        reason: 'start_queue_full',
      }),
      lastMessage: `${queueAdmission.message}，本次唤醒未加入；稍后自动重试。`,
      ...presencePatch('待机中（启动排队已满）'),
    });
    rearmWakeRetry(handle, generation, 'start_queue_full');
    return;
  }
  if (handle.coldStandbyTimer) clearTimeout(handle.coldStandbyTimer);
  handle.coldStandbyTimer = null;
  handle.stopRequested = false;
  handle.wakeReason = reason; // 排队后槽位空出来时，用原始 reason 重新驱动这次唤醒
  updateStatus(handle, {
    browserStandby: coldStandbyStatus('waking', handle.status.browserStandby && handle.status.browserStandby.hint, { reason }),
    lastMessage: reason === 'cloud_command'
      ? '冷待机期间收到新任务，正在提前恢复浏览器…'
      : '冷待机等待结束，正在提前恢复浏览器…',
    ...presencePatch('正在恢复浏览器…'),
    ...clearEdgeFailurePatch(handle),
  });

  // 待机中且核心还活着 → 原地重建（进程与云端连接不动），**经串行启动队列**。
  //
  // 为什么唤醒也要排队：重开浏览器就是开浏览器，一样吃 700MB。撞日额的账号唤醒定时器零抖动，会在
  // 上海零点**同一秒**全部到点——不排队就是所有账号一起冷启，机器直接被打爆。用户否决了抖动方案，
  // 这里用确定性的串行队列达到同样的削峰效果：逐个唤醒，起完一个再叫下一个。
  if (handle.child && (handle.coldStandbyActive || handle.coldStandbyPending)) {
    handle.coldStandbyWaking = true;
    handle.wakeGeneration = generation;
    const child = handle.child;
    // 带任务的唤醒（云端有活等着）优先于到点的普通唤醒。
    const kind = reason === 'cloud_command' ? 'task' : 'resume';
    void launchQueue.enqueue({
      key: `${handle.envId}:wake`,
      kind,
      run: async () => {
        if (!isCurrentLifecycleGeneration(handle, generation) || handle.stopRequested) return false;
        const preflight = await ensureProxyPreflight(handle);
        if (!isCurrentLifecycleGeneration(handle, generation) || handle.stopRequested) return false;
        if (preflight && preflight.state === 'unavailable') {
          onColdStandbyWakeFailed(handle, `代理预检未通过：${proxyPreflightFailureText(preflight.reason)}`, generation);
          return false;
        }
        return new Promise((resolve) => {
          if (!isCurrentLifecycleGeneration(handle, generation) || handle.child !== child
            || handle.removed || handle.stopRequested || isQuitting) {
            if (isCurrentLifecycleGeneration(handle, generation)) {
              handle.coldStandbyWaking = false;
              handle.wakeGeneration = 0;
              releaseStartQueue(handle);
            }
            resolve(false);
            return;
          }
          // 准入闸：唤醒同样不得绕过（「只是唤醒一下」不是超额开浏览器的理由）。
          const admitted = admitBrowserSlot(handle);
          if (!admitted.ok) {
            // **一律排队，谁都不判失败**——包括云端派了任务来唤醒的那种。
            // 槽位被占是「还没轮到你」，不是「这件事办不成」。若确有调用方在死线上等，
            // parkForSlot 里挂的死线定时器会到点如实回它一句「这次没轮到」（云端按可恢复处理、
            // 归还小时格并在格内重试），**但这个环境仍留在队列里，浏览器该起还是会起**——
            // 下一次重试正好命中它。撤销唤醒是双输：这次没做成，下次还得从冷启重来。
            handle.coldStandbyWaking = false;
            parkForSlot(handle, admitted);
            resolve(false);
            return;
          }
          clearSlotWaiting(handle);
          clearWakeDeadline(handle); // 抢到槽位了：死线定时器作废（真在起了，不该再回「没轮到」）
          let done = false;
          const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            handle.wakeSettle = null;
            resolve(ok);
          };
          const timer = setTimeout(() => {
            onColdStandbyWakeFailed(handle, `唤醒超时（${LAUNCH_READY_TIMEOUT_MS}ms）`, generation);
            finish(false);
          }, LAUNCH_READY_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
          handle.wakeSettle = finish;
          const sent = sendCoreLifecycle(handle, 'wake', (error) => {
            if (handle.child !== child || !isCurrentLifecycleGeneration(handle, generation)) return;
            onColdStandbyWakeFailed(handle, `唤醒指令未送达：${error.message}`, generation);
            finish(false);
          });
          if (!sent) {
            onColdStandbyWakeFailed(handle, '核心进程 IPC 不可用', generation);
            finish(false);
          }
        });
      },
    });
    return;
  }

  // 核心已经不在了：只能冷启（此路径下浏览器与进程都要重建）。
  handle.coldStandbyPending = false;
  handle.coldStandbyActive = false;
  resumeEdge(handle);
}

/** 核心已完成原地重建：解除待机态。 */
function onColdStandbyWoken(handle) {
  if (!handle) return;
  const generation = handle.wakeGeneration;
  if (!isCurrentLifecycleGeneration(handle, generation)) return;
  // 批量 / 单环境关闭可能与已送达的 wake 回执竞态；关闭意图优先，迟到的 woken 不得把状态翻回已打开。
  if (handle.stopRequested || handle.removed || isQuitting) {
    handle.browserOpenPending = false;
    releaseStartQueue(handle);
    handle.coldStandbyWaking = false;
    handle.wakeGeneration = 0;
    if (typeof handle.wakeSettle === 'function') handle.wakeSettle(false);
    return;
  }
  handle.browserOpenPending = false;
  releaseStartQueue(handle);
  handle.coldStandbyWaking = false;
  handle.wakeGeneration = 0;
  if (typeof handle.wakeSettle === 'function') handle.wakeSettle(true); // 放行启动队列的下一个
  handle.coldStandbyPending = false;
  handle.coldStandbyActive = false;
  handle.controlPlaneOnly = false;
  handle.controlPlaneBootstrapped = false;
  handle.executorFailure = null;
  handle.wakeRetryStreak = 0;
  handle.wakeDeadlineAt = 0;
  clearWakeDeadline(handle);
  clearSlotWaiting(handle);
  clearColdStandbyTimer(handle);
  // 最短持有时长的起点：从「浏览器真的重建好了」这一刻起算，而非下发唤醒那一刻——否则冷启那 30–45s
  // 会被算进持有期，闸就形同虚设。必须在 clearColdStandbyTimer 之后写（它会清掉 hold timer，但不碰这个时刻）。
  handle.coldStandbyLastWokenAt = Date.now();
  const manualBrowserOnly = handle.automationIntent === 'stopped';
  updateStatus(handle, {
    edge: 'running',
    session: manualBrowserOnly ? 'idle' : handle.automationPaused ? 'paused' : 'running',
    browserStandby: coldStandbyStatus('awake', handle.status.browserStandby && handle.status.browserStandby.hint, {}),
    lastMessage: manualBrowserOnly
      ? '浏览器已打开；自动化保持关闭。'
      : handle.automationPaused
      ? '浏览器已打开；自动化仍暂停。'
      : '浏览器已打开并恢复自动化。',
    ...presencePatch(manualBrowserOnly
      ? '浏览器已打开，自动化关闭'
      : handle.automationPaused ? '浏览器已打开，自动化暂停' : '自动化运行中'),
    ...clearEdgeFailurePatch(handle),
  });
}

/**
 * 唤醒失败：**留在待机态**（可再次唤醒），并如实告知。
 * 绝不把一个没起来的浏览器标成已就绪——那正是「静默假成功」。
 */
function onColdStandbyWakeFailed(handle, reason, expectedGeneration = handle && handle.wakeGeneration) {
  if (!handle || handle.stopRequested || !isCurrentLifecycleGeneration(handle, expectedGeneration)
    || handle.wakeGeneration !== expectedGeneration) return;
  handle.browserOpenPending = false;
  releaseStartQueue(handle);
  handle.coldStandbyWaking = false;
  handle.wakeGeneration = 0;
  if (typeof handle.wakeSettle === 'function') handle.wakeSettle(false); // 放行启动队列的下一个
  handle.coldStandbyPending = false;
  handle.coldStandbyActive = true; // 仍在待机：浏览器没起来
  // 核心必须当场知道结论，否则它在浏览器闸上空转满 180s 唤醒死线（旧版：外壳一言不发）。
  denyWakeNow(handle, `wake_failed:${reason}`);
  // 待机定时器在 wakeColdStandby 里被清掉了，这里**必须还回去**——不还，这个环境此后再无任何
  // 自唤醒路径，会一直待机到天荒地老（一次唤醒失败 = 永久停摆）。
  rearmWakeRetry(handle, expectedGeneration, 'wake_failed');
  // 这次浏览器没有起来，执行槽仍是空的：立即放行 FIFO 下一项。只靠 15s 重扫虽最终会恢复，
  // 但会把“第 5 个分身被占用”表现成后续环境长时间没有回复，正是启动调度需要消掉的空窗。
  setTimeout(() => drainSlotWaiters(), 0);
  updateStatus(handle, {
    browserStandby: coldStandbyStatus('sleeping', handle.status.browserStandby && handle.status.browserStandby.hint, {
      reason: `wake_failed:${reason}`,
    }),
    loopStage: null,
    lastMessage: `唤醒失败：${reason}。仍保持待机，可再次唤醒。`,
    ...presencePatch('待机中（唤醒失败）'),
  });
}

/**
 * 不占浏览器槽位地启动核心控制面。引导失败时保留原浏览器排队语义，绝不猜账号、绝不显示已连接。
 * retainStartQueueReservation=true 表示这个环境已经是有界浏览器等待队列的一员；核心上线不能偷释放名额。
 */
async function startBrowserAbsentCore(handle, {
  retainStartQueueReservation = false,
  slotAdmission = null,
  queueAdmission = null,
  generation = handle && handle.lifecycleGeneration,
} = {}) {
  if (!handle || !isCurrentLifecycleGeneration(handle, generation) || handle.child || handle.controlPlaneStarting
    || handle.removed || handle.stopRequested || isQuitting) return false;
  handle.controlPlaneStarting = true;
  try {
    const coreOnlyBootstrap = !slotAdmission && !queueAdmission;
    const bootstrap = await resolveControlBootstrap(handle);
    if (!isCurrentLifecycleGeneration(handle, generation) || handle.stopRequested) return false;
    if (!bootstrap.ok) {
      // 首次未绑定环境无法在浏览器缺席时可信确定平台账号，但这不改变已经取得的槽位排队资格。
      // 等槽位后走真实浏览器启动与身份确认；此刻只呈现排队，绝不把正常前置条件写成引擎异常。
      if (slotAdmission && bootstrap.reason === 'binding_unknown') {
        parkForSlot(handle, slotAdmission);
        return false;
      }
      if (!retainStartQueueReservation) releaseStartQueue(handle);
      const browserState = coreOnlyBootstrap
        ? '浏览器保持关闭'
        : queueAdmission && queueAdmission.message
        ? queueAdmission.message
        : slotAdmission && slotAdmission.message
          ? slotAdmission.message
          : '浏览器仍在等待可用槽位';
      updateStatus(handle, {
        edge: 'idle',
        cloud: 'disconnected',
        session: 'idle',
        loopStage: null,
        lastMessage: `${browserState}；自动化引擎未连接：${bootstrap.message}。`,
        ...edgeFailurePatch(`自动化引擎未连接：${bootstrap.message}`),
        ...presencePatch('自动化引擎未连接，浏览器保持关闭'),
      });
      return false;
    }

    handle.coldStandbyPending = true;
    handle.coldStandbyActive = false;
    handle.controlPlaneOnly = true;
    handle.controlPlaneBootstrapped = false;
    if (slotAdmission) {
      parkForSlot(handle, slotAdmission);
    } else {
      updateStatus(handle, {
        edge: 'starting',
        session: 'resting',
        loopStage: null,
        browserStandby: coldStandbyStatus('scheduled', null, { reason: 'start_queue_full' }),
        lastMessage: coreOnlyBootstrap
          ? '正在连接自动化引擎；浏览器保持关闭。'
          : `${queueAdmission?.message || '浏览器启动暂未入队'}；正在先连接自动化引擎。`,
        ...presencePatch(coreOnlyBootstrap ? '正在连接自动化引擎…' : '正在连接自动化引擎，浏览器暂未入队'),
        ...clearEdgeFailurePatch(handle),
      });
    }
    const started = spawnEdgeChild(handle, {
      controlBootstrap: bootstrap,
      retainStartQueueReservation,
      generation,
    });
    if (!started) {
      handle.coldStandbyPending = false;
      handle.controlPlaneOnly = false;
      handle.controlPlaneBootstrapped = false;
      if (!retainStartQueueReservation) releaseStartQueue(handle);
      return false;
    }
    return await started;
  } finally {
    if (isCurrentLifecycleGeneration(handle, generation)) handle.controlPlaneStarting = false;
  }
}

/**
 * Consume a Cloud-issued, use-once cleanup bootstrap and start a minimal browserless session.
 * Definitive grant failures enter manual handling; transient network failures stay inside the
 * independent core bootstrap supervisor and never fall back to queueStartEnv/provider/CDP.
 */
async function startRestrictedOffboardCleanupCore(handle) {
  if (!handle || handle.child || handle.removed || handle.cleanupManual || isQuitting) return false;
  const pending = pendingOffboardForEnv(handle.profileId);
  if (!pending || pending.state === 'tombstoned' || pending.state === 'purged') return true;
  const expectedEdgeId = fleet.envIdForProfile(pending.envKey);
  if (!pending.cleanupGrant || !pending.cleanupGrantExpiresAt || pending.cleanupEdgeId !== expectedEdgeId) {
    handle.cleanupManual = true;
    updateStatus(handle, {
      edge: 'warning',
      cloud: 'disconnected',
      session: 'resting',
      lastMessage: '离场清理缺少与本环境绑定的有效凭证；已停止自动恢复，请人工处理。浏览器保持关闭。',
      ...edgeFailurePatch('离场清理凭证缺失或环境不匹配'),
      ...presencePatch('离场清理需人工处理'),
    });
    return false;
  }
  if (pending.cleanupGrantExpiresAt <= Date.now()) {
    handle.cleanupManual = true;
    updateStatus(handle, {
      edge: 'warning',
      cloud: 'disconnected',
      session: 'resting',
      lastMessage: '离场清理凭证已过期；已停止自动恢复，请人工处理。浏览器保持关闭。',
      ...edgeFailurePatch('离场清理凭证已过期'),
      ...presencePatch('离场清理需人工处理'),
    });
    return false;
  }
  const response = await clientAuthFetch(`/offboarding/${encodeURIComponent(pending.offboardId)}/cleanup-bootstrap`, {
    method: 'POST',
    token: clientSession && clientSession.token,
    body: { cleanupGrant: pending.cleanupGrant, edgeId: expectedEdgeId },
  });
  const data = response.ok && response.data && response.data.data;
  if (!data || data.mode !== 'restricted_cleanup' || data.offboardId !== pending.offboardId
    || data.envKey !== pending.envKey || data.accountId !== pending.accountId || data.edgeId !== expectedEdgeId) {
    if (response.status === 401) onSessionInvalid();
    const definitive = response.status === 401 || response.status === 403 || response.status === 404
      || response.status === 409 || response.status === 410;
    if (definitive) handle.cleanupManual = true;
    updateStatus(handle, {
      edge: definitive ? 'warning' : 'starting',
      cloud: 'disconnected',
      session: 'resting',
      lastMessage: definitive
        ? `离场清理凭证被 Cloud 拒绝（${response.data?.error || response.status}）；请人工处理。浏览器保持关闭。`
        : '离场清理核心暂未连上 Cloud，将按独立核心退避重试；浏览器保持关闭。',
      ...(definitive ? edgeFailurePatch('离场清理凭证不可用') : clearEdgeFailurePatch(handle)),
      ...presencePatch(definitive ? '离场清理需人工处理' : '离场清理核心等待重连'),
    });
    return false;
  }
  handle.stopRequested = false;
  handle.controlPlaneOnly = true;
  handle.controlPlaneBootstrapped = false;
  handle.coldStandbyPending = true;
  handle.coldStandbyActive = false;
  return await spawnEdgeChild(handle, {
    controlBootstrap: { accountId: data.accountId },
    cleanupBootstrap: { offboardId: data.offboardId },
  });
}

/**
 * 启动一个环境（change browser-slot-scheduling）：**经串行启动队列**——起完一个再起下一个，
 * 内存 / 槽位准入闸长在队列里，绕不过去。
 *
 * kind 决定队列优先级：manual（手动任务）> task（带任务的唤醒）> resume（普通续场恢复）。
 */
function startEdge(handle, { kind = 'resume', generation = handle && handle.lifecycleGeneration } = {}) {
  if (!handle || !isCurrentLifecycleGeneration(handle, generation) || handle.child
    || handle.removed || handle.stopRequested || isQuitting) return;
  if (handle.status.session === 'paused') return;
  if (handle.launchQueued) return; // 已在队列里：绝不重复入队、绝不开出第二个浏览器
  const queueAdmission = reserveStartQueue(handle);
  if (!queueAdmission.ok) {
    showStartQueueFull(handle, queueAdmission);
    return false;
  }
  handle.launchQueued = true;
  handle.launchGeneration = generation;
  clearRespawnTimer(handle);
  clearColdStandbyTimer(handle);
  const cap = slotCapacity();
  updateStatus(handle, {
    edge: 'starting',
    loopStage: null,
    lastMessage: `排队等待启动槽位（当前 ${occupiedSlots()}/${cap} 个浏览器在跑）…`,
    ...presencePatch('排队等待启动…'),
  });
  void launchQueue.enqueue({
    key: handle.envId,
    kind,
    run: async () => {
      if (!isCurrentLifecycleGeneration(handle, generation)) return false;
      if (handle.launchGeneration === generation) {
        handle.launchQueued = false;
        handle.launchGeneration = 0;
      }
      // 轮到它时再复核取消闸：排队期间可能已被暂停 / 移出 / 退出。
      if (!handle || !isCurrentLifecycleGeneration(handle, generation) || handle.child
        || handle.removed || handle.stopRequested || isQuitting) {
        releaseStartQueue(handle);
        return false;
      }
      if (handle.status.session === 'paused') {
        releaseStartQueue(handle);
        return false;
      }
      const admitted = admitBrowserSlot(handle);
      if (!admitted.ok) {
        // 槽位/内存不够 → **进等槽位队列**，绝不丢弃这次启动请求，也绝不判失败。
        //
        // 挂 12 个账号、只有 6 个槽位，本来就该有 6 个在等——等别人进冷待机让出槽位再顶上，
        // 这正是 1:2 能成立的前提。旧版在这里直接丢弃请求、环境永久趴在 warning 态，
        // 后来槽位空出来也没人去取，等于把 1:2 废掉了（多挂的账号一天都跑不了）。
        return await startBrowserAbsentCore(handle, {
          retainStartQueueReservation: true,
          slotAdmission: admitted,
          generation,
        });
      }
      clearSlotWaiting(handle);
      clearWakeDeadline(handle);
      return await spawnEdgeChild(handle, { generation });
    },
  });
}

/**
 * spawn 一个环境的核心子进程（非 detached，随外壳退出终止）。身份闸在此强制执行。
 *
 * 返回一个在环境**真正就绪**（云端已连上）或诚实失败时才 settle 的 promise——串行启动队列靠它
 * 实现「起完一个再起下一个」；不等就绪就放行下一个，10 个环境仍会几乎同时冷启、把内存打爆。
 */
function spawnEdgeChild(handle, {
  controlBootstrap = null,
  cleanupBootstrap = null,
  retainStartQueueReservation = false,
  transientBrowserLease = false,
  generation = handle && handle.lifecycleGeneration,
} = {}) {
  if (!handle || !isCurrentLifecycleGeneration(handle, generation) || handle.child
    || handle.removed || handle.stopRequested || isQuitting) return false;
  if (handle.status.session === 'paused' && !controlBootstrap) return false;
  if (!controlBootstrap) {
    handle.controlPlaneOnly = false;
    handle.controlPlaneBootstrapped = false;
  }
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

  const nativeResourceDir = app.isPackaged
    ? path.join(process.resourcesPath, 'native-page-engine')
    : path.join(app.getAppPath(), 'build', 'native-page-engine', `${process.platform}-${process.arch}`);
  // XHS/Facebook 的常驻浏览器核心启动即需要 Native；WeChat API-only 核心可在开发态无 artifact 时运行，
  // 但 preelectron/package 路径有 artifact 时仍注入，供后续按需浏览器鉴权会话使用。
  const nativeArtifactRequiredAtSpawn = normalizePlatform(handle.platform) !== 'wechat_channels';
  if (nativeArtifactRequiredAtSpawn || app.isPackaged || fs.existsSync(nativeResourceDir)) {
    try {
      const artifact = verifyNativePageEngineArtifact(nativeResourceDir);
      spawnEnv.AIDCP_NATIVE_PAGE_ENGINE_BINARY = artifact.binaryPath;
    } catch (error) {
      const reason = `Native Page Engine 包校验失败：${error instanceof Error ? error.message : String(error)}`;
      updateStatus(handle, {
        edge: 'stopped',
        session: 'idle',
        lastMessage: reason,
        ...edgeFailurePatch(reason),
        ...presencePatch('页面引擎不可用'),
      });
      return;
    }
  }

  // 云端环境注入（change edge-cloud-env-selector）：界面已显式选择时，在**合并之后**覆盖继承来的
  // AIDCP_CLOUD_URL（必须在此、而非塞进 providerEnv：合并 { ...providerEnv, ...processEnv } 会让继承值压过）；
  // 未选择则不动、沿用继承 / 缺省（零回归）。这里只记录本次目标；实际 key 必须等 hello/welcome 成功后再确认。
  const cloudSel = resolveCloudUrl();
  if (cloudSel.fromSelection) spawnEnv.AIDCP_CLOUD_URL = cloudSel.url;
  const resolvedCloudKey = cloudSel.fromSelection
    ? cloudSel.key
    : cloudKeyForUrl(String(process.env.AIDCP_CLOUD_URL || '').trim() || DEFAULT_CLOUD_URL);
  handle.spawnCloudKey = resolvedCloudKey;
  // 出口探测复用与当前 dev/ol/custom 云选择一致的 Client Auth 公网基址。显式 env 仍可覆盖；
  // 不存在可用基址时不猜第三方服务，核心会诚实投影 unavailable。
  const clientAuthBase = resolveClientAuthBase();
  const explicitEgressProbe = normalizeClientAuthUrl(process.env.AIDCP_EGRESS_PROBE_URL || '');
  if (explicitEgressProbe) spawnEnv.AIDCP_EGRESS_PROBE_URL = explicitEgressProbe;
  else if (clientAuthBase) spawnEnv.AIDCP_EGRESS_PROBE_URL = `${clientAuthBase}/egress`;
  if (controlBootstrap) {
    // 与 AIDCP_ACCOUNT_ID 严格分离：后者会覆盖页面真实身份，绝不能承载可能陈旧的启动引导。
    spawnEnv.AIDCP_START_BROWSER_ABSENT = '1';
    spawnEnv.AIDCP_CONTROL_ACCOUNT_ID = controlBootstrap.accountId;
  }
  if (cleanupBootstrap) {
    spawnEnv.AIDCP_OFFBOARD_CLEANUP_ONLY = '1';
    spawnEnv.AIDCP_OFFBOARD_CLEANUP_ID = cleanupBootstrap.offboardId;
  }
  if (transientBrowserLease) {
    spawnEnv.AIDCP_TRANSIENT_BROWSER_LEASE = '1';
    spawnEnv.AIDCP_LIFECYCLE_GENERATION = String(generation);
  }
  if (handle.automationPaused) {
    spawnEnv.AIDCP_AUTOMATION_PAUSED_AT_START = '1';
  }

  handle.browserParkingReady = false;
  handle.executorFailure = null;
  handle.browserStateUnconfirmed = false;
  handle.browserPersonaNoticeState = null;
  resetPersonaNoticeGrace(handle);
  handle.browserAlreadyRunning = false;
  handle.coreParked = false;
  handle.closePending = false;
  // 每次真正拉起核心前清「本次运行遇内核缺失」标记：该标记只反映本 core run 是否撞过
  // 「SunBrowser <N> is not ready」，退出处据此把内核缺失退出识别为可恢复的「准备内核」而非失败。
  handle.kernelMissThisRun = false;
  // 同理清「本次运行遇同账号并发占用拒启」标记：只反映本 core run 是否撞过 in-use 拒启，退出处据此判终局。
  handle.envInUseThisRun = false;
  handle.envInUseHolder = null;
  handle.spawnedAtMs = Date.now();
  // 换会话把人设绑定态重置回**未知**（change persona-bound-tristate）：上一会话的 stale-true 不能残留成
  // 误显示「已设置」，但也绝不能归零成 false——那等于替云端宣布「未绑」，正是「已设置账号被反复误弹向导」
  // 的根因（每次冷待机唤醒都会重启核心、走到这一行）。重置成 null=未知，等新会话的权威信号重建。
  handle.status.personaBound = null;
  handle.status.personaWritingLanguage = undefined;
  handle.interactionRuntime = null;
  const child = spawn(process.execPath, [edgeEntry], {
    cwd: edgeCwd,
    env: spawnEnv,
    // 第四路 IPC 专用于本地生命周期意图；persona/browser parking 既有 stdin 协议保持不变。
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  handle.child = child;
  // 核心已进入执行态：从启动排队移出；后续由浏览器并发槽位计数，不再占等待容量。
  if (!retainStartQueueReservation) releaseStartQueue(handle);

  // 发布卡在途状态随核心（重）启动清零（edge-companion-ui 8.1 评审修正）：离线窗口内的审批变化
  // （拒绝/失败）推送会如实丢失，旧 pending/approved 卡若不清会永久滞留成陈卡；真在候审/已批的
  // 草稿由重连后的云端 hello 快照重新推回。lastPublish 历史态不清（持久数据）。
  updateStatus(handle, {
    edge: 'starting',
    session: handle.automationPaused ? 'paused' : (controlBootstrap ? 'resting' : 'running'),
    closeScope: null,
    // 新核心 = 还没连上过云端，哪怕上一个核心连上过（change honest-first-connect-label）。不复位这一位，
    // 崩溃重起 / 显式重启的整个冷启动窗口会顶着上一轮的「连过」资格，被讲成「正在重新连接」。
    cloudEverConnected: false,
    browserStandby: controlBootstrap
      ? coldStandbyStatus('scheduled', null, { reason: 'browser_absent_at_start' })
      : null,
    publish: null,
    publishPreview: null,
    proxyRuntime: null,
    respawnGaveUp: false,
    connectedCloudKey: '',
    targetCloudKey: resolvedCloudKey,
    cloudRebind: null,
    lastMessage: cleanupBootstrap
      ? '正在启动受限离场清理核心；浏览器保持关闭。'
      : transientBrowserLease
      ? '正在校验视频号会话并连接数据服务；仅在需要重新登录时打开浏览器。'
      : controlBootstrap
      ? '正在连接自动化引擎；浏览器保持关闭，等待执行槽位。'
      : '正在启动 aidcp-edge…',
    ...presencePatch(cleanupBootstrap
      ? '正在连接离场清理核心…'
      : transientBrowserLease ? '正在连接视频号…'
      : controlBootstrap ? '正在连接云端，浏览器等待槽位' : '正在启动引擎…'),
    ...clearEdgeFailurePatch(handle),
  });

  child.stdout.on('data', (chunk) => handleEdgeOutput(handle, chunk.toString(), false, generation));
  child.stderr.on('data', (chunk) => handleEdgeOutput(handle, chunk.toString(), true, generation));
  child.on('message', (message) => {
    if (handle.child !== child || !message || typeof message !== 'object') return;
    const currentGeneration = isCurrentLifecycleGeneration(handle, generation);
    // 暂停/关闭先推进操作代，再把终止指令交给旧代子进程。因此只放行与当前停止意图严格匹配的终局回执；
    // 其它旧代消息（任务阶段、唤醒、Cloud 状态等）仍一律丢弃，不能污染新一轮启动。
    const currentStopReply = !currentGeneration && handle.stopRequested && (
      (message.type === 'lifecycle.close_failed' && handle.engineStopReason === 'user_close')
      || (message.type === 'lifecycle.paused' && handle.engineStopReason === 'user_pause')
    );
    if (!currentGeneration && !currentStopReply) return;
    if (message.type === 'lifecycle.cloud_rebound' || message.type === 'lifecycle.cloud_rebind_failed') {
      const pending = handle.cloudRebindPending;
      if (!pending || message.requestId !== pending.requestId || message.targetKey !== pending.targetKey) return;
      clearTimeout(pending.timer);
      handle.cloudRebindPending = null;
      if (message.type === 'lifecycle.cloud_rebound' && message.ok === true) {
        handle.spawnCloudKey = pending.targetKey;
        updateStatus(handle, {
          cloud: 'connected',
          connectedCloudKey: pending.targetKey,
          targetCloudKey: pending.targetKey,
          cloudRebind: { state: 'connected', targetKey: pending.targetKey },
          lastMessage: `自动化引擎已连接 ${CLOUD_ENV_LABELS[pending.targetKey] || pending.targetKey}；浏览器状态未改变。`,
          ...presencePatch('Cloud 控制连接已切换'),
          ...clearEdgeFailurePatch(handle),
        });
        pending.resolve({ ok: true });
      } else {
        const reason = typeof message.reason === 'string' && message.reason ? message.reason : 'rebind_failed';
        updateStatus(handle, {
          cloud: 'disconnected',
          targetCloudKey: pending.targetKey,
          cloudRebind: { state: 'failed', targetKey: pending.targetKey, reason },
          lastMessage: `自动化引擎未能连接 ${CLOUD_ENV_LABELS[pending.targetKey] || pending.targetKey}：${reason}。浏览器状态未改变。`,
          ...presencePatch('自动化引擎重绑失败'),
        });
        pending.resolve({ ok: false, reason });
      }
      return;
    }
    if (message.type === 'lifecycle.transient_browser_requested') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const requestedGeneration = Number(message.generation);
      if (!usesTransientBrowserLane(handle) || !requestId || requestedGeneration !== generation) {
        sendTransientMessage(handle, {
          type: 'lifecycle.transient_browser_denied',
          requestId,
          generation,
          reason: 'not_applicable_or_stale',
        });
        return;
      }
      enqueueTransientBrowserLane(handle, {
        generation,
        requestId,
        startCore: false,
        reason: typeof message.reason === 'string' ? message.reason : 'browser_sidecar_open',
      });
      return;
    }
    if (message.type === 'lifecycle.transient_browser_released') {
      if (Number(message.generation) !== generation
          || handle.transientBrowserLeaseGeneration !== generation) return;
      settleTransientBrowserLease(
        handle,
        typeof message.reason === 'string' ? message.reason : 'child_released',
        true,
      );
      return;
    }
    if (message.type === 'lifecycle.interaction_runtime') {
      if (!usesTransientBrowserLane(handle)) return;
      const authStatus = ['active', 'login_required', 'reauth_required', 'challenge_required', 'degraded', 'disabled']
        .includes(message.authStatus) ? message.authStatus : 'disabled';
      const browserState = ['closed', 'opening', 'open', 'closing', 'unavailable']
        .includes(message.browserState) ? message.browserState : 'unavailable';
      const proofAt = Number(message.proofAt) || 0;
      handle.interactionRuntime = {
        authStatus,
        identityMatches: message.identityMatches === true,
        connectorStarted: message.connectorStarted === true,
        cloudNegotiated: message.cloudNegotiated === true,
        paused: message.paused === true,
        offboardPending: message.offboardPending === true,
        dataCapable: message.dataCapable === true,
        browserState,
        proofAt,
        updatedAt: Date.now(),
      };
      const provenRunning = authStatus === 'active'
        && handle.interactionRuntime.identityMatches
        && handle.interactionRuntime.connectorStarted
        && handle.interactionRuntime.cloudNegotiated
        && !handle.interactionRuntime.paused
        && !handle.interactionRuntime.offboardPending
        && handle.interactionRuntime.dataCapable
        && proofAt >= handle.spawnedAtMs;
      updateStatus(handle, {
        edge: 'running',
        auth: authStatus === 'active'
          ? 'logged in'
          : ['login_required', 'reauth_required', 'challenge_required'].includes(authStatus)
            ? 'login required'
            : 'checking',
        session: handle.interactionRuntime.paused ? 'paused' : 'running',
        ...(provenRunning ? {
          lastMessage: '视频号数据连接运行中；浏览器已关闭，不占公共浏览器槽位。',
          ...presencePatch('视频号运行中'),
          ...clearEdgeFailurePatch(handle),
        } : {}),
      });
      return;
    }
    if (message.type === 'lifecycle.standby') {
      onColdStandbyAck(handle);
      return;
    }
    if (message.type === 'lifecycle.executor_failed') {
      const reason = typeof message.reason === 'string' && message.reason ? message.reason : 'executor_failed';
      handle.executorFailure = reason;
      // The core initiated a browser-only teardown. Mark it pending so the following standby ack
      // releases the browser slot without treating the independently healthy core as stopped.
      if (message.teardown !== false) handle.coldStandbyPending = true;
      updateStatus(handle, {
        edge: 'running',
        browserStandby: coldStandbyStatus('scheduled', null, { reason }),
        lastMessage: `浏览器执行器异常：${reason}。正在释放浏览器资源；自动化引擎保持连接。`,
        ...presencePatch('浏览器执行器异常'),
      });
      return;
    }
    if (message.type === 'lifecycle.wake_requested') {
      // 核心带来的 deadlineAt = 有调用方（云端 acquire）在那个时刻之后就不要结果了。
      // 它**只**决定我们何时回话，不决定要不要开浏览器。取更早的那个：多个请求叠在同一次唤醒上时，
      // 最急的那个说了算（晚的那个自然也就被照顾到了）。
      const deadlineAt = Number(message.deadlineAt) || 0;
      if (deadlineAt > 0 && (!handle.wakeDeadlineAt || deadlineAt < handle.wakeDeadlineAt)) {
        handle.wakeDeadlineAt = deadlineAt;
        // 已经在等槽位队列里了 → 幂等更新死线，不重复入队（会白白丢掉排队资历）。
        if (handle.slotWaitingSince) armWakeDeadline(handle, 'slots_full:requeued');
      }
      wakeColdStandby(handle, 'cloud_command');
      return;
    }
    if (message.type === 'lifecycle.woken') {
      onColdStandbyWoken(handle);
      return;
    }
    if (message.type === 'lifecycle.wake_failed') {
      onColdStandbyWakeFailed(handle, message.reason || 'unknown');
      return;
    }
    if (message.type === 'lifecycle.standby_cloud_degraded') {
      updateColdStandbyCloudRecovery(handle, 'degraded', message.reason);
      return;
    }
    if (message.type === 'lifecycle.standby_cloud_reconnected') {
      updateColdStandbyCloudRecovery(handle, 'reconnected');
      return;
    }
    if (message.type === 'lifecycle.task_idle') {
      // 核心只证明任务/发布写者已在安全边界收敛；外壳重新走完整待机判定，绝不直接 close。
      // 无最新提示即 no-op；提示过时、最短持有未满、验证码/认证/新任务等均由既有双层安全闸拦截。
      updateStatus(handle, { loopStage: null });
      const standbyHint = handle.status.browserStandby && handle.status.browserStandby.hint;
      if (standbyHint) applyBrowserStandbyHint(handle, standbyHint);
      return;
    }
    if (message.type === 'lifecycle.paused') {
      handle.automationPaused = true;
      updateStatus(handle, {
        edge: 'stopping',
        session: 'paused',
        overlayBlocked: false,
        lastMessage: '自动化已暂停，正在断开自动化引擎并释放浏览器…',
        ...presencePatch('正在断开自动化引擎…'),
        ...clearEdgeFailurePatch(handle),
      });
      return;
    }
    if (message.type === 'lifecycle.resumed') {
      handle.pausePending = false;
      handle.automationPaused = false;
      const shouldWakeBrowser = handle.resumeWakePending;
      handle.resumeWakePending = false;
      updateStatus(handle, {
        edge: 'running',
        session: shouldWakeBrowser ? 'resting' : 'running',
        lastMessage: shouldWakeBrowser
          ? '自动化暂停已解除；正在按浏览器槽位恢复浏览器。'
          : '自动化已原地恢复；浏览器未重启。',
        ...presencePatch(shouldWakeBrowser ? '正在恢复浏览器…' : '自动化运行中'),
        ...clearEdgeFailurePatch(handle),
      });
      if (shouldWakeBrowser) wakeColdStandby(handle, 'user_resume');
      return;
    }
    if (message.type === 'lifecycle.offboard_cleanup_complete') {
      const pending = pendingOffboardForEnv(handle.profileId);
      if (!handle.offboardCleanup || !pending || message.offboardId !== pending.offboardId) return;
      // The use-once session has completed its only command. Never recycle it into a general core;
      // polling Cloud tombstone is an Electron customer-auth operation and remains browserless.
      handle.cleanupManual = true;
      updateStatus(handle, {
        edge: 'running',
        cloud: 'connected',
        session: 'resting',
        lastMessage: '离场清理已回报 Cloud，正在等待权威墓碑后删除本地环境；浏览器全程未启动。',
        ...presencePatch('离场清理已完成，等待 Cloud 确认'),
        ...clearEdgeFailurePatch(handle),
      });
      void reconcilePendingInteractionOffboard(pending, {}, 8).finally(() => {
        if (handle.child) {
          try { handle.child.kill('SIGTERM'); } catch { /* best-effort */ }
        }
      });
      return;
    }
    if (message.type === 'lifecycle.close_failed') {
      const cancelledResume = handle.resumeAfterStop && handle.automationIntent === 'enabled';
      clearColdStandbyTimer(handle);
      handle.coldStandbyPending = false;
      handle.closePending = false;
      handle.pausePending = false;
      // 核心已经停止自动化，只是浏览器关闭无法确认；结束“关闭中”而进入可重试的真实失败态。
      // 旧浏览器未确认关闭时绝不开新一代浏览器，因此“关闭后再启动”也在这里取消。
      handle.stopRequested = false;
      handle.engineStopReason = '';
      handle.resumeAfterStop = false;
      handle.automationIntent = 'stopped';
      handle.automationPaused = true;
      updateStatus(handle, {
        edge: 'warning',
        session: 'paused',
        loopStage: null,
        lastMessage: cancelledResume
          ? '浏览器关闭状态未能确认，本次重新启动已取消；请重试关闭。'
          : '浏览器关闭状态未能确认；自动化引擎仍连接，可重试关闭。',
        ...edgeFailurePatch('浏览器关闭状态未能确认'),
        ...presencePatch('浏览器关闭未确认'),
      });
      return;
    }
  });
  // spawn 失败（EAGAIN 多环境 fork 压力 / ENOENT 产物缺失）：'error' 事件无监听会被 EventEmitter
  // 重抛为未捕获异常 → 整个监督者进程崩、连累全部兄弟环境（破坏崩溃隔离）；即便 Electron 幸存，
  // 'error' 后不发 'exit'，handle.child 永远钉住 → 该环境卡死在 starting、重起/放弃永不触发（静默假成功）。
  // 故必须挂 'error'：诚实呈现失败 + 走同一条有界重起/放弃路径。exit 与 error 用 `handle.child===child`
  // 互斥，谁先触发谁处理、另一个 no-op。
  child.on('error', (err) => {
    if (handle.child !== child) return;
    const staleGeneration = !isCurrentLifecycleGeneration(handle, generation);
    failPendingCoreRebind(handle, `core_spawn_error:${(err && err.message) || String(err)}`);
    settleLaunchReady(handle, false); // 起不来：立刻放行启动队列的下一个，绝不占着队列干等
    handle.child = undefined;
    settleTransientBrowserLease(handle, 'core_spawn_error', false);
    handle.browserOpenPending = false;
    handle.coldStandbyPending = false;
    handle.controlPlaneOnly = false;
    handle.controlPlaneBootstrapped = false;
    handle.browserParkingReady = false;
    handle.browserPersonaNoticeState = null;
    resetPersonaNoticeGrace(handle);
    const msg = (err && err.message) || String(err);
    appendEdgeLog(handle.envId, `spawn error: ${msg}`, true);
    if (handle.removed) return;
    if (staleGeneration) {
      // 旧代 spawn 的迟到失败只代表旧子进程已收尾，不得消耗新代失败预算或挂自动重启。
      const shouldStartCurrent = !isQuitting && handle.automationIntent === 'enabled'
        && (handle.resumeAfterStop || handle.restartPending);
      handle.pausePending = false;
      handle.closePending = false;
      handle.restartPending = false;
      handle.resumeAfterStop = false;
      handle.browserStateUnconfirmed = false;
      if (shouldStartCurrent) {
        handle.stopRequested = false;
        handle.engineStopReason = '';
      }
      updateStatus(handle, {
        edge: shouldStartCurrent ? 'starting' : 'stopped',
        cloud: 'disconnected',
        session: shouldStartCurrent
          ? 'idle'
          : handle.automationIntent === 'paused' ? 'paused' : handle.automationIntent === 'stopped' ? 'closed' : 'idle',
        loopStage: null,
        risk: 'normal',
        ...(handle.kind === 'adspower' ? { auth: 'checking' } : {}),
        overlayBlocked: false,
        respawnGaveUp: false,
        lastMessage: shouldStartCurrent
          ? '上一轮启动已收尾，正在按当前操作重新启动…'
          : handle.automationIntent === 'paused'
            ? '自动化已暂停，引擎和浏览器已关闭；数据管理仍可继续使用。'
            : '自动化已关闭，引擎和浏览器已关闭；数据管理仍可继续使用。',
        ...presencePatch(shouldStartCurrent ? '正在重新启动…'
          : handle.automationIntent === 'paused' ? '自动化已暂停' : '自动化已关闭'),
        ...clearEdgeFailurePatch(handle),
      });
      setTimeout(() => drainSlotWaiters(), 0);
      if (shouldStartCurrent) queueStartEnv(handle);
      return;
    }
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
      loopStage: null,
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
  // 终局判定挂 'close'（非 'exit'）：Node 只保证 'close' 在 stdio 全部 drain 后触发、且必在 'exit' 之后；
  // 'exit' 可能早于末尾 stdout/stderr 'data'，那样内核缺失退出时 kernelMissThisRun/neededKernel 尚未由
  // handleEdgeLogLine 写入 → 被误判为硬失败、弹出本 change 意在消除的启动失败通知。改挂 'close' 后，
  // 「SunBrowser <N> is not ready」等末行必已处理完，内核缺失分类可靠。（spawn 失败无 'close'，由上方 'error'
  // 经 handle.child===child 互斥兜底；核心不派生继承 stdio 的孙进程，'close' 及时触发；退出应用的有界等待
  // 读 handle.child、'close' 仅晚 'exit' 数毫秒，远在 ~10s 预算内。）
  child.on('close', (code, signal) => {
    if (handle.child !== child) return; // 已被 'error' 处理器接管
    failPendingCoreRebind(handle, `core_exited:${code ?? signal ?? 'unknown'}`);
    settleLaunchReady(handle, false); // 进程没了：放行启动队列的下一个
    const wasClosing = handle.closePending;
    const wasParked = handle.coreParked;
    const wasPausing = handle.pausePending;
    const wasRestarting = handle.restartPending;
    const stopReason = handle.engineStopReason;
    const shouldResumeAfterStop = handle.resumeAfterStop && handle.automationIntent === 'enabled';
    // 初始 browser-absent 核心只有在发出 lifecycle.standby ack 后才算真正待机成功。若 Cloud hello
    // 失败即退出，pending 不能把它洗成“有意待机退出”——那会吞掉真实握手故障且永不重试。
    const controlPlaneNeverEstablished = handle.controlPlaneOnly && !handle.controlPlaneBootstrapped;
    const wasColdStandby = !controlPlaneNeverEstablished && (handle.coldStandbyPending || handle.coldStandbyActive);
    handle.child = undefined;
    settleTransientBrowserLease(handle, 'core_closed', false);
    handle.browserOpenPending = false;
    if (controlPlaneNeverEstablished) {
      handle.coldStandbyPending = false;
      handle.coldStandbyActive = false;
      handle.controlPlaneOnly = false;
      handle.controlPlaneBootstrapped = false;
    }
    // 核心退出 = 它的浏览器也没了 = 槽位空出来了：立刻叫队头（停止 / 暂停 / 崩溃都算）。
    setTimeout(() => drainSlotWaiters(), 0);
    handle.browserParkingReady = false;
    handle.browserPersonaNoticeState = null;
    resetPersonaNoticeGrace(handle);
    // 主动重启、自动化暂停/关闭、冷待机、浏览器关闭、移出花名册、退出应用都是「有意停止」，不算异常。
    const intentional = isQuitting || wasRestarting || wasPausing || wasParked || wasColdStandby || wasClosing
      || Boolean(stopReason) || handle.automationIntent !== 'enabled' || handle.removed;
    handle.pausePending = false;
    handle.coreParked = false;
    handle.closePending = false;
    const exitedAbnormally = !intentional && (signal != null || (code != null && code !== 0));
    handle.browserStateUnconfirmed = exitedAbnormally;
    const message = exitMessage(code, signal);
    if (handle.removed) return; // 已摘除的环境不再投影状态

    if (wasColdStandby && !isQuitting && !wasRestarting && !wasPausing && !wasParked && !wasClosing && !stopReason) {
      handle.coldStandbyPending = false;
      handle.coldStandbyActive = true;
      if (handle.offboardCleanup) {
        handle.cleanupManual = true;
        updateStatus(handle, {
          edge: 'warning',
          cloud: 'disconnected',
          session: 'resting',
          overlayBlocked: false,
          browserStandby: coldStandbyStatus('sleeping', null, { reason: 'cleanup_core_exited' }),
          lastMessage: '受限离场清理核心已退出；单次凭证不会复用，已转人工处理。浏览器保持关闭。',
          ...edgeFailurePatch('离场清理核心退出，单次凭证已停止复用'),
          ...presencePatch('离场清理需人工处理'),
        });
        return;
      }
      updateStatus(handle, {
        edge: 'stopped',
        session: 'resting',
        loopStage: null,
        overlayBlocked: false,
        browserStandby: coldStandbyStatus('sleeping', handle.status.browserStandby && handle.status.browserStandby.hint, {
          reason: 'core_exited_during_standby',
        }),
        lastMessage: '冷待机中，核心进程已退出；将等待唤醒时恢复浏览器。',
        ...presencePatch('长时间等待中，浏览器已关闭'),
        ...clearEdgeFailurePatch(handle),
      });
      return;
    }

    // 同账号并发占用拒启 = 不可重起终局：重起不会自愈（分身正被同账号在别处打开、不允许并发打开）。
    // 识别后强制停止、不进重起、不消耗连续失败预算。红线：本分支 MUST NOT 对该分身发起任何
    // browser/stop / OS 杀 / 调试附着——占用者是别处的活跃会话，绝不干扰（拒启本就未拿到浏览器句柄）。
    const envInUse = exitedAbnormally && handle.envInUseThisRun === true;
    const inUseHolder = handle.envInUseHolder ? `（AdsPower 账号 ${handle.envInUseHolder}）` : '';
    const inUseMsg = `环境被其它设备或窗口占用${inUseHolder}；已停止启动，请在占用它的一端关闭后再点「启动」重试。`;
    // 有界重起决策（仅对异常退出计入；有意停止 / 不可重起终局一律 stop）。
    const decision = envInUse
      ? { action: 'stop', streak: 0 }
      : exitedAbnormally
        ? fleet.decideRespawn(
            { exitCode: signal != null && code == null ? null : code, uptimeMs: Date.now() - handle.spawnedAtMs, prevStreak: handle.respawnStreak, shuttingDown: isQuitting },
            RESPAWN_OPTS,
          )
        : { action: 'stop', streak: 0 };
    handle.respawnStreak = decision.streak;

    const willRespawn = decision.action === 'respawn';
    const gaveUp = decision.action === 'give-up';
    if (gaveUp) handle.gaveUp = true;

    // 内核缺失退出 = 「所需内核尚未下载」的可恢复态：不弹失败、不置 edgeFailure、不惊扰运维，呈现「正在准备
    // 浏览器内核」，随后由 respawn 的预检下载正确内核并重启（全自动，无需人工）。守卫（红线：不静默掩盖真失败）：
    // 仅当决策仍是 respawn（未耗尽重试）、本次运行确因内核缺失退出、且该版本尚未被确保过时才如此；否则（已确保
    // 过该版本仍失败 / 重试耗尽）走下方正常失败呈现。下载本身失败在预检处已诚实暴露，不经此路。
    const neededKernelV = handle.neededKernel ? String(handle.neededKernel) : '';
    const kernelMissExit = exitedAbnormally && willRespawn && handle.kernelMissThisRun && neededKernelV
      && !(handle.kernelEnsuredVersions && handle.kernelEnsuredVersions.has(neededKernelV));
    if (kernelMissExit) {
      updateStatus(handle, {
        edge: 'starting',
        cloud: 'disconnected',
        session: handle.status.session === 'paused' ? 'paused' : 'idle',
        risk: 'normal',
        ...(handle.kind === 'adspower' ? { auth: 'checking' } : {}),
        overlayBlocked: false,
        respawnGaveUp: false,
        kernelPrep: { state: 'pending', percent: 0, version: neededKernelV },
        lastMessage: `检测到该环境需要浏览器内核 ${neededKernelV}，正在准备下载后自动重启…`,
        ...presencePatch(`准备浏览器内核 ${neededKernelV}…`),
        ...clearEdgeFailurePatch(handle),
      });
      scheduleRespawnIfNeeded(handle, decision); // 由预检下载内核后重启；不弹失败通知、不进入下方失败呈现
      return;
    }

    updateStatus(handle, {
      edge: exitedAbnormally ? 'warning' : 'stopped',
      cloud: 'disconnected',
      loopStage: null,
      session: stopReason === 'user_pause'
        ? 'paused'
        : stopReason === 'user_close' || stopReason === 'binding_untrusted'
          ? 'closed'
        : wasClosing
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
      lastMessage: envInUse
        ? inUseMsg
        : stopReason === 'user_pause'
        ? '自动化已暂停，引擎和浏览器已关闭；数据管理仍可继续使用。'
        : stopReason === 'user_close'
        ? '自动化已关闭，引擎和浏览器已关闭；数据管理仍可继续使用。'
        : stopReason === 'binding_untrusted'
        ? '账号绑定未确认，自动化引擎已停止；数据管理仍可继续使用。'
        : wasClosing
        ? '浏览器已关闭。'
        : gaveUp
        ? `${message} 连续失败已达上限（${RESPAWN_OPTS.maxConsecutiveFailures} 次），已放弃自动重启，请人工排查后点「启动」重试。`
        : willRespawn
          ? `${message} 将在 ${Math.round((decision.delayMs || 0) / 1000)}s 后自动重启（第 ${decision.streak}/${RESPAWN_OPTS.maxConsecutiveFailures} 次）。`
          : message,
      ...presencePatch(
        stopReason === 'user_pause'
          ? '自动化已暂停'
          : stopReason === 'user_close'
            ? '自动化已关闭'
            : stopReason === 'binding_untrusted'
              ? '账号绑定未确认，自动化已停止'
        : wasClosing
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
      ...(envInUse
        ? edgeFailurePatch(inUseMsg)
        : exitedAbnormally
          ? abnormalExitFailurePatch(handle, code, signal)
          : clearEdgeFailurePatch(handle)),
    });

    // 红线：异常退出不静默——首次失败 / 放弃 / 不可重起终局时弹一次系统通知（重起风暴中间不刷屏）。
    if (envInUse) {
      // 不可重起终局：给专门的「环境被占用」通知，不带「重新登录」这类误导性提示。
      surfaceFailure(`AIDCP Edge${handle.name ? `（${handle.name}）` : ''} 环境被占用`, inUseMsg);
    } else if (exitedAbnormally && (decision.streak === 1 || gaveUp)) {
      const adspowerHint = handle.kind === 'adspower'
        ? '请在该分身的浏览器窗口登录后，点击「重新登录」重试；并确认分身 ID 正确、指纹浏览器已就绪。'
        : '请打开窗口查看日志 / 重新登录或重连云端。';
      surfaceFailure(
        `AIDCP Edge${handle.name ? `（${handle.name}）` : ''} ${gaveUp ? '已放弃自动重启' : '已停止运行'}`,
        `${message}${handle.status.edgeFailure && handle.status.edgeFailure.summary ? `原因：${handle.status.edgeFailure.summary}。` : ''}${adspowerHint}`,
      );
    }

    scheduleRespawnIfNeeded(handle, decision);

    if (shouldResumeAfterStop && !isQuitting) {
      handle.stopRequested = false;
      handle.engineStopReason = '';
      handle.resumeAfterStop = false;
      updateStatus(handle, {
        edge: 'starting',
        session: 'idle',
        lastMessage: '正在重新连接自动化引擎并准备浏览器…',
        ...presencePatch('正在恢复自动化…'),
      });
      queueStartEnv(handle);
      return;
    }

    // 有意重启：旧进程退出后按当前设置起新流程（经错峰队列）。退出应用途中绝不再起。
    if (handle.restartPending) {
      handle.restartPending = false;
      if (!isQuitting) void enqueueStartFlow(handle);
    }
  });

  // 串行启动队列在此等待：起完一个（云端已连上）或诚实失败，才放行下一个。
  return awaitLaunchReady(handle);
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

// 起核心前确保 AdsPower 运行时就绪 + 该 profile 所需浏览器内核已下载（change edge-bundled-adspower-cli-runtime）。
// 服务为整机单例 → 全局单飞（ensureAdsServiceOnce）；内核为整机共享但**按版本**（不同 profile 可绑不同内核）
// → 按版本单飞（ensureKernelOnce）。均 settle 后清除、下次重探（运行时可能中途退出，不缓存陈旧结论）。
// 红线：任何失败诚实回报 + 弹窗、返回 { ok:false }，MUST NOT 起核心。
let adsServiceInFlight = null;
// 内核按版本单飞：同版本并发环境共享一次下载、不同版本各自确保，避免全局单飞把 147/148 串成同一结果。
const adsKernelInFlight = new Map(); // version(string) -> Promise<{ok,...}>

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

// 设置面板只读路径：已有 base 时直接读；冷机或真实传输失败时才 ensure CLI 并重读一次。
// 这避免每次面板刷新都执行 `ads status` 子进程，同时让 daemon 中途退出后能够自愈。
function readAdsWithRuntime(opts, read) {
  return readWithRuntimeRecovery({
    hasBase: () => Boolean(adsServiceBase),
    clearBase: () => { adsServiceBase = null; },
    ensure: () => ensureAdsServiceOnce(null),
    read: () => read(resolveAdsOpts(opts)),
  });
}

// 打包态从 Resources、开发态从当前 build/ads-runtime 取模板，按完整内容身份暂存到用户可写目录。
// 内容变化时先复制候选、再有界停旧 daemon、最后目录交换；失败回滚且不得继续接管旧 hook。
async function stageAdsRuntimeIfNeeded() {
  const source = adsRuntimeStage.resolveRuntimeTemplateSource({
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    isPackaged: app.isPackaged,
  });
  const execPath = adsRuntime.resolveRuntimeExecPath({ isPackaged: app.isPackaged });
  return adsRuntimeStage.stageRuntimeTemplate({
    source,
    destRoot: path.join(app.getPath('userData'), 'ads-runtime'),
    appVersion: app.getVersion(),
    stopExisting: ({ cliEntry }) => adsRuntime.stopRuntime({ cliEntry, execPath }),
  });
}

async function ensureAdsService(handle) {
  adsServiceBase = null;
  // CLI-first：运行时生命周期（起停 / 就绪 / 内核）统一走随包 CLI。先暂存随包模板 + 解析 cliEntry
  // （无论最终复用已在跑的 daemon 还是新起，内核预检都要 cliEntry），再由 ensureRuntime 用 `ads status`
  // 判活：已在跑则复用（adopted）、否则 `ads start`（embedded）。
  // 注：判活读 CLI 自身 pid/store（我方 daemon / 本包上次所起），不探测独立运行的 AdsPower 桌面端——
  //   硬切换自包含形态本不依赖桌面端；若外部桌面端占端口，属超范围的共存冲突，由运营侧收敛。
  // 1. 首启暂存随包模板到可写目录（打包态 Resources 只读）。
  const staged = await stageAdsRuntimeIfNeeded();
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

  // 2. 每个 Electron 会话第一次成功建立前，先经 CLI status/stop 有界清理登记 daemon；随后
  // `ads start -k <key>` 建立本会话新运行时。后续中途重探不重复 stop 健康 daemon。
  if (handle) updateStatus(handle, { auth: 'checking', lastMessage: '正在启动内置指纹浏览器运行时…', ...presencePatch('正在准备浏览器运行时…') });
  const apiKey = resolveAdsApiKey('');
  // 就绪判定走 CLI `ads status`（staging 已把其判活从 `ps|grep "node"` 换成 process.kill(pid,0)，故在
  // Electron 宿主下也可靠——服务进程名是 Electron 二进制而非 "node"，旧的 grep 会漏判、新的存在性探测不受影响）。
  const execPath = adsRuntime.resolveRuntimeExecPath({ isPackaged: app.isPackaged });
  const rt = await adsRuntime.ensureRuntime({
    cliEntry,
    execPath,
    apiKey,
    resetExisting: !adsRuntimeSessionResetComplete,
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
  adsRuntimeSessionResetComplete = true;
  adsServiceBase = rt.base; // P0-A：运行时解析出的实际端口即单一 base 权威
  managedAdsRuntime = { cliEntry, execPath };
  return { ok: true, mode: rt.alreadyRunning ? 'adopted' : 'embedded', base: rt.base, cliEntry };
}

// 内核确保（按版本单飞）：同一内核版本同一时刻只跑一次 get-kernel-list + download-kernel，
// 同版本并发环境等同一结果；不同版本各自并行、互不串扰。进度回调挂首个调用方的 handle，
// 全局进度条（renderKernelPrepGlobal）不挑环境仍会展示。
function ensureKernelOnce(version, cliEntry, handle) {
  const key = String(version);
  const existing = adsKernelInFlight.get(key);
  if (existing) return existing;
  const p = adsRuntime.ensureKernel({
    cliEntry,
    execPath: adsRuntime.resolveRuntimeExecPath({ isPackaged: app.isPackaged }),
    version,
    kernelType: 'Chrome',
    onProgress: ({ percent, state }) => {
      if (!handle) return;
      updateStatus(handle, {
        kernelPrep: { state: state === 'completed' ? 'installing' : state, percent, version },
        lastMessage: `正在下载浏览器内核 ${version}（约 750MB，仅首次）… ${percent}%`,
        ...presencePatch(`准备浏览器内核 ${percent}%`),
      });
    },
  }).finally(() => adsKernelInFlight.delete(key));
  adsKernelInFlight.set(key, p);
  return p;
}

// 启动浏览器前的完整确保 = 服务确保 + 内核预检（无论服务是刚起的还是已在跑的都要预检——
// 我们自己先前起的服务也没下内核，adopted 直接放行会撞 V2 browser-profile/start「SunBrowser 148 is not ready」）。
// 内核走随包 **CLI**（get-kernel-list / download-kernel）——staging 修好 isRunning 判活后，CLI 命令在
// Electron 宿主下可靠；download-kernel 非 TTY 下逐轮吐 `Kernel progress: N% [state]`，经 onProgress 上进度条。
async function ensureAdsRuntimeAndKernel(handle) {
  const svc = await ensureAdsServiceOnce(handle);
  if (!svc.ok) return svc;
  // 该环境所需内核版本：优先上次 browser-profile/start 诚实报出的版本（handle.neededKernel）——AdsPower profile
  // 可绑 ≠ DEFAULT_KERNEL 的内核（旧版/手工建/云端同步来的），且 LocalAPI user/list 不暴露该版本，故按
  // 启动报错「SunBrowser <N> is not ready」反应式确保（同 AdsPower CLI open-browser 的自愈做法）；否则默认。
  const version = (handle && handle.neededKernel) || adsFingerprint.DEFAULT_KERNEL;
  if (handle) appendEdgeLog(handle.envId, `检查浏览器内核 ${version} 就绪情况（缺则首次下载约 750MB）…`);
  const kres = await ensureKernelOnce(version, svc.cliEntry, handle);
  if (!kres.ok) {
    if (handle) {
      updateStatus(handle, {
        edge: 'stopped',
        session: 'idle',
        kernelPrep: { state: 'failed', percent: 0, version },
        lastMessage: `浏览器内核 ${version} 准备失败：${kres.error}`,
        ...edgeFailurePatch(kres.error || `浏览器内核 ${version} 准备失败`),
        ...presencePatch('内核准备失败，可重试'),
      });
      surfaceFailure('AIDCP Edge 无法启动', `浏览器内核 ${version} 准备失败：${kres.error || '未知错误'}`);
    }
    return { ok: false, error: kres.error };
  }
  if (handle) {
    // 记下已成功确保就绪的内核版本（已在盘 or 刚下完）。若之后 browser-profile/start 仍报该版本 not ready，
    // 属真异常（非「尚未下载」），不再当可恢复的内核准备处理——见 handleEdgeLogLine / 核心退出处的 kernelMissExit 守卫。
    if (!handle.kernelEnsuredVersions) handle.kernelEnsuredVersions = new Set();
    handle.kernelEnsuredVersions.add(String(version));
  }
  if (handle) appendEdgeLog(handle.envId, kres.alreadyPresent ? `浏览器内核 ${version} 已就绪` : `浏览器内核 ${version} 下载完成`);
  if (handle) updateStatus(handle, { kernelPrep: null, ...clearEdgeFailurePatch(handle) });
  return { ok: true, mode: svc.mode, base: svc.base };
}

// adspower（AdsPower 指纹浏览器）路径：不自起本机 Chrome、不做 9222 cookie 轮询；
// 浏览器启动 / 登录态 / 身份确立全由核心进程经 AdsPower 本地 API 完成（未登录 → 核心诚实非零退出并弹窗）。
async function startAdsPowerFlow(handle, generation = handle && handle.lifecycleGeneration) {
  if (!isCurrentLifecycleGeneration(handle, generation) || handle.stopRequested) return false;
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
  // 服务全局单飞 + 内核按版本单飞（见 ensureAdsServiceOnce / ensureKernelOnce），无需再叠一层全局 once。
  const prep = await ensureAdsRuntimeAndKernel(handle);
  if (!isCurrentLifecycleGeneration(handle, generation)) return false;
  if (!prep.ok) return;
  // 运行时/内核准备可长达数分钟（首启下载）；这期间被暂停/移出/退出则诚实放弃，不再拉起子进程。
  // （startEdge 亦有同一取消闸兜底；此处提前返回避免多余「正在启动」状态残留。）
  if (handle.removed || handle.stopRequested || isQuitting || handle.status.session === 'paused') return;
  const preflight = await ensureProxyPreflight(handle);
  if (!isCurrentLifecycleGeneration(handle, generation) || handle.removed || handle.stopRequested
    || isQuitting || handle.status.session === 'paused') return;
  if (preflight && preflight.state === 'unavailable') {
    stopStartForProxyFailure(handle, preflight);
    return;
  }
  startEdge(handle, { generation });
}

// 按环境分派启动流程（不做队列；调用方决定是否经错峰队列进入）。
function startFlowForEnv(handle, generation = handle && handle.lifecycleGeneration) {
  if (!handle || !isCurrentLifecycleGeneration(handle, generation) || handle.stopRequested) return;
  if (handle.kind === 'self') {
    return launchChromeAndGateEdge(handle);
  }
  if (usesTransientBrowserLane(handle)) return startTransientEnvironment(handle, generation);
  return startAdsPowerFlow(handle, generation);
}

/** 手动/排队启动入口：清放弃终态（人工重试口）+ 清取消闸 + 错峰入队。 */
function enqueueStartFlow(handle, generation = handle && handle.lifecycleGeneration) {
  if (!handle || !isCurrentLifecycleGeneration(handle, generation) || handle.startFlowQueued) return Boolean(handle);
  if (usesTransientBrowserLane(handle)) return startTransientEnvironment(handle, generation);
  const admission = reserveStartQueue(handle);
  if (!admission.ok) {
    showStartQueueFull(handle, admission);
    // 浏览器启动队列容量只限制浏览器等待者，不限制 Cloud 控制面数。未进浏览器队列的环境仍尝试
    // 用客户 ownership + persistent binding 启动 browser-absent 核心；失败也只保持诚实离线，绝不猜账号。
    void startBrowserAbsentCore(handle, { queueAdmission: admission, generation });
    return 'control-only';
  }
  handle.startFlowQueued = true;
  handle.startFlowGeneration = generation;
  void queueLifecycle(async () => {
    try {
      if (!isCurrentLifecycleGeneration(handle, generation) || handle.stopRequested) return false;
      return await startFlowForEnv(handle, generation);
    } finally {
      if (isCurrentLifecycleGeneration(handle, generation) && handle.startFlowGeneration === generation) {
        handle.startFlowQueued = false;
        handle.startFlowGeneration = 0;
        // startEdge 已接手时 launchQueued/slotWaiting 会保留名额；前置准备失败或取消则归还排队容量。
        if (!handle.child && !handle.launchQueued && !handle.slotWaitingSince && !handle.coldStandbyWaking) {
          releaseStartQueue(handle);
        }
      }
    }
  }, handle.envId);
  return true;
}

/** 手动/排队启动入口：清放弃终态（人工重试口）+ 清取消闸 + 有界错峰入队。 */
function queueStartEnv(handle, queuePosition) {
  if (!handle || handle.child) return false;
  const generation = ensureEnabledLifecycleGeneration(handle, 'user_start');
  if (handle.startFlowQueued || handle.launchQueued || handle.slotWaitingSince
      || handle.transientBrowserQueued || handle.transientBrowserActive) return true;
  handle.automationIntent = 'enabled';
  handle.engineStopReason = '';
  handle.resumeAfterStop = false;
  handle.automationPaused = false;
  handle.gaveUp = false;
  handle.respawnStreak = 0;
  handle.stopRequested = false; // 显式启动意图：解除任何在途取消闸
  clearRespawnTimer(handle);
  clearColdStandbyTimer(handle);
  const queued = enqueueStartFlow(handle, generation);
  if (!queued) return false;
  if (queued === 'control-only') return queued;
  updateStatus(handle, usesTransientBrowserLane(handle) ? {
    edge: 'starting',
    closeScope: null,
    loopStage: null,
    respawnGaveUp: false,
    lastMessage: '已进入临时通道队列；视频号将按顺序校验会话并连接数据服务。',
    ...presencePatch('排队中'),
  } : {
    edge: 'starting',
    closeScope: null,
    loopStage: null,
    respawnGaveUp: false,
    lastMessage: queuePosition ? `已排队错峰启动（第 ${queuePosition} 位，相邻间隔约 1.1s）…` : '已排队错峰启动…',
    ...presencePatch('排队启动中…'),
  });
  return true;
}

// 有序重启：停登录轮询；若核心在跑则 SIGTERM 之，其 exit 回调据 restartPending 起新流程；
// 无在跑核心时直接错峰入队。供「保存设置」「恢复」「重新登录」三处复用。
function stopAndRestart(handle, message, patch = {}) {
  if (!handle) return;
  stopLoginPoller();
  advanceLifecycleGeneration(handle, 'restart');
  handle.automationIntent = 'enabled';
  handle.engineStopReason = '';
  handle.resumeAfterStop = false;
  handle.gaveUp = false;
  handle.respawnStreak = 0;
  handle.stopRequested = false; // 显式重启意图：解除任何在途取消闸
  clearRespawnTimer(handle);
  clearColdStandbyTimer(handle);
  // cloudEverConnected 复位：正要换核心，新核心没连过（change honest-first-connect-label）。
  updateStatus(handle, { cloud: 'disconnected', cloudEverConnected: false, session: 'running', respawnGaveUp: false, lastMessage: message, ...presencePatch('正在重启引擎…'), ...clearEdgeFailurePatch(handle), ...patch });
  if (handle.child) {
    handle.restartPending = true;
    void queueLifecycle(() => { try { handle.child?.kill('SIGTERM'); } catch { /* ignore */ } });
  } else {
    void enqueueStartFlow(handle);
  }
}

function handleEdgeOutput(handle, text, isError = false, generation = handle && handle.lifecycleGeneration) {
  if (!isCurrentLifecycleGeneration(handle, generation)) return;
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
  if (message.startsWith('[publish-approval-reply]')) {
    handlePublishApprovalReply(message.slice('[publish-approval-reply]'.length).trim());
    return;
  }
  // 浏览器窗口完成回执只用于关联“浏览器先抬前 → AIDCP 再抬前”的顺序，不进入普通日志/UI 状态。
  if (message.startsWith(BROWSER_PARKING_REPLY_PREFIX)) {
    handleBrowserParkingReply(handle, message.slice(BROWSER_PARKING_REPLY_PREFIX.length).trim());
    return;
  }
  // 引擎命令诊断是核心本地生成的白名单结构化行：主进程再验一次形状，按环境合并进内存态。
  // 无论解析成功与否，原始 JSON 都不得进入 edge.log / renderer 原始日志；只留下固定安全痕迹。
  if (message.startsWith(commandDiagnostics.PREFIX)) {
    const receivedAt = Date.now();
    const event = commandDiagnostics.parseCommandDiagnosticLine(message, receivedAt);
    const trace = commandDiagnostics.commandDiagnosticTraceLine(event);
    appendEdgeLog(handle.envId, trace, isError);
    if (!event) {
      updateStatus(handle, { lastMessage: trace });
      return;
    }
    const entries = commandDiagnostics.mergeCommandDiagnostic(
      handle.status.commandDiagnostics,
      event,
      receivedAt,
    );
    updateStatus(handle, { commandDiagnostics: entries, lastMessage: trace });
    return;
  }
  // 代理运行事件带当前公网 IP，只属于内存态：落盘日志与开发者详情均只记“已更新”，不持久化 IP。
  const proxyRuntimeLine = message.includes('[ui-event]') && message.includes('"kind":"proxyRuntime"');
  const structuredMessage = message;
  if (proxyRuntimeLine) message = '[ui-event] proxyRuntime updated (redacted)';
  appendEdgeLog(handle.envId, message, isError);
  // AdsPower profile 可绑 ≠ DEFAULT_KERNEL 的内核；browser-profile/start 会诚实报「SunBrowser <N> is not ready」。
  // 该版本 LocalAPI（v2 browser-profile/list 亦然）不暴露，只能据启动报错反应式获知——同 AdsPower CLI 自愈。
  // UX 修（本次）：首次发现「内核尚未下载」不当启动失败，直接转「准备内核」进度态；不落失败候选、不翻
  // warning、不弹通知。核心随后退出，退出处据此走可恢复分支：respawn 的预检据 neededKernel 下载正确内核
  // 并重启。已确保过该版本仍 not ready = 真异常，不拦（走下方正常失败派生，红线：不静默掩盖真失败）。
  const kernelMiss = /SunBrowser (\d+) is not ready/.exec(message);
  if (kernelMiss && handle) {
    const v = kernelMiss[1];
    handle.neededKernel = v;
    const alreadyEnsured = handle.kernelEnsuredVersions && handle.kernelEnsuredVersions.has(v);
    const stoppingNow = isQuitting || handle.restartPending || handle.pausePending || handle.removed
      || !handle.child || handle.status.session === 'paused';
    if (!alreadyEnsured && !stoppingNow) {
      handle.kernelMissThisRun = true;
      updateStatus(handle, {
        edge: 'starting',
        kernelPrep: { state: 'pending', percent: 0, version: v },
        lastMessage: `检测到该环境需要浏览器内核 ${v}，正在准备下载…`,
        ...presencePatch(`准备浏览器内核 ${v}…`),
        ...clearEdgeFailurePatch(handle),
      });
      return; // 该行按「内核准备」处理，跳过失败候选记忆与 warning 派生
    }
  }
  if (message.includes('[browser-parking] control-ready')) {
    handle.browserParkingReady = true;
    handle.browserOpenPending = false;
    handle.browserPersonaNoticeState = null;
    syncBrowserPersonaNotice(handle, true);
  }
  // 核心正被有意停止 / 已暂停 / 已退出：其关闭期 stdout/stderr 只作为日志行展示，绝不据以翻转
  // edge / session / risk 徽标，也不产 UI 事件。正常在跑时才做状态推断。
  const stopping = isQuitting || handle.restartPending || handle.pausePending || handle.removed || !handle.child || handle.status.session === 'paused';
  if (!stopping) rememberEdgeFailureCandidate(handle, message);
  // AdsPower「同账号并发占用拒启」= 不可重起终局：该分身已被同一账号在别处打开、不允许并发打开，
  // 重起一万次也开不了。置标志，退出处（child.on('close')）据此强制停止、不进重起、不消耗失败预算，
  // 并呈现「环境被占用」而非通用文案。与缺内核特判同构（都靠退出处读本次运行标志）。
  if (!stopping && ENV_IN_USE_TERMINAL) {
    const inUse = fleet.classifyAdsInUse(message);
    if (inUse.inUse) {
      handle.envInUseThisRun = true;
      if (inUse.account) handle.envInUseHolder = inUse.account;
    }
  }
  if (stopping) {
    if (!handle.removed) updateStatus(handle, { lastMessage: message });
    return;
  }
  // 边缘进程徽标：MUST 按**内容**判定，MUST NOT 按输出通道判定（change honest-core-log-severity）。
  //
  // 回归前是 `edge: isError ? 'warning' : 'running'`，而 isError 只说明「这行走了 stderr」。Node 的
  // console.warn / console.error 一律写 stderr，核心里 30+ 条良性诊断（[publish-submit-diag] 观测日志、
  // 租约抑制说明、「外壳暂时给不出浏览器槽位…环境仍在等槽位队列里」）全走这根管子 —— 每来一条，这里就
  // 把徽标翻成 warning，呈现层随即讲出「异常 / 运行异常 / 引擎已停止，请查看详情或重新启动」，并给该环境
  // 加「需处理」角标、浮到环境栏顶部，与真正待人工的登录 / 验证码 / 风控受限混作一谈。核心根本没停：
  // 下一行正常日志一到又翻回 running —— 这就是运营看到的「发布时闪红、又秒恢复」。
  //
  // 现在只认核心**自己声明**的终态（fleet.declaresCoreHalt 白名单）。这样做是安全的，因为核心里每条
  // 致命路径都必然退出进程（启动失败 → process.exit(1)；身份确立失败 → terminateNow()；CDP 终态 /
  // 云端重连耗尽 → requestShutdown()），而 child.on('close') 的异常退出分支才是权威判据 —— 核心自己的
  // 注释写着「致命启动失败立即非零退出，让桌面外壳的 edgeProcess.on('exit') 立刻看见」。日志行只做预测、
  // 退出码才是权威；把预测调准，权威一分不动。白名单里保留「CDP 输入控制不可用」是因为那条是唯一
  // **不退出**的终态（核心活着但驱不动浏览器、要求人工重启），少了它「边缘在线但浏览器驱不动」就没人报。
  const halting = fleet.declaresCoreHalt(message);
  const next = { edge: halting ? 'warning' : 'running', lastMessage: proxyRuntimeLine ? '代理运行证据已更新' : message };
  if (!halting && handle.status.edgeFailure) next.edgeFailure = null;
  if (message.includes('[browser-parking] awaiting-login')) {
    // adspower 首登有界等待门（change adspower-first-login-wait-gate）：核心在等操作者扫码登录、浏览器与 CDP 仍在。
    // 诚实呈现「待登录」，绝不加任何 respawn 抑制（核心不退出，respawn 本就不触发；超时走干净停止码亦不重起）。
    next.auth = 'login required';
    next.presence = { text: '请在浏览器里扫码登录', at: new Date().toISOString() };
  }
  if (message.includes('已连接云端') || message.includes('已握手') || message.includes('云端已重连')) {
    next.cloud = 'connected';
    if (handle.spawnCloudKey) next.connectedCloudKey = handle.spawnCloudKey;
    // 本轮核心已确凿连上过云端：此后再断，才配讲「正在重新连接」（change honest-first-connect-label）。
    // 只在此置位、只在换核心时复位——冷待机唤醒不复位（云端连接全程未断，唤醒的是浏览器不是连接）。
    next.cloudEverConnected = true;
    // 连上就把「与云端连接中断」那句翻走（'云端已重连' 在翻译规则表里没有条目、不会自己被顶掉）。
    // 后续若有带在场感的事件，会在下面按事件覆盖，这里只保证不把断连文案挂死。
    next.presence = { text: '已连接云端，等待安排…', at: new Date().toISOString() };
    // 就绪信号（change browser-slot-scheduling）：串行启动队列等的就是这一刻——浏览器起来了、云端连上了。
    // 到此才放行队列里的下一个环境；不等就绪就放行，10 个环境仍会几乎同时冷启、把内存打爆。
    settleLaunchReady(handle, true);
  }
  // 云端**拒绝**握手（change risk-state-cross-process-integrity，task 9.1）：与「离线 / 连不上」
  // 是两回事，MUST 可区分呈现。连不上是网络或云端不在，重试有意义；被拒是云端看清本节点身份后的裁决
  // （平台不一致、缺 accountId 等），重试一万次答案不变。渲染成「与云端连接中断，正在重连…」
  // 会把运营推去查网络，而真正要做的事在别处。故这里单独一条分支，且**先于**下面的断连规则匹配。
  if (message.includes('云端拒绝本节点握手')) {
    next.cloud = 'disconnected';
    next.edge = 'warning';
    next.session = 'idle';
    next.presence = { text: '云端拒绝了这个节点，请看下方原因', at: new Date().toISOString() };
  } else if (message.includes('连接失败') || message.includes('WS 已关闭') || message.includes('启动失败')) next.cloud = 'disconnected';
  if (message.includes('云端重连中')) next.cloud = 'disconnected';
  // 断连时把在场感一起翻掉（change presence-terminal-honesty）：此前只翻云端徽标，在场感行仍挂着断连前
  // 的中途动作文案（如「顺路去作者主页看看…」）继续演——云端都断了，决策端不可能再推进任何一步。
  // 只认真正的云端断连信号，不含 '启动失败'（那是引擎起不来、另有文案）。
  if (message.includes('连接失败') || message.includes('WS 已关闭') || message.includes('云端重连中')) {
    next.presence = { text: '与云端连接中断，正在重连…', at: new Date().toISOString() };
  }
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
  const evt = handle.uiEvents.push(structuredMessage);
  let standbyHint = null;
  if (evt) {
    if (evt.account) {
      // 账号标签兜底链：已验证的平台昵称 > AdsPower 环境名 > 渲染层再兜尾4位。
      const name = evt.account.name || handle.name || '';
      handle.status.account = {
        id: evt.account.id,
        name,
        source: evt.account.name ? fleet.nicknameSourceForPlatform(handle.platform) : 'env',
      };
      // 身份确立 = 登录态权威信号（核心读不出登录身份会诚实退出、不会走到这行），据此翻登录态。
      // adspower 路径此前无人写 'logged in'（cookie 门是 self 专属），人设闸因此永不开——修于本 change。
      next.auth = 'logged in';
      refreshSameAccountWarnings();
      // 环境名跟随真实昵称（changes edge-adspower-name-follows-nickname / wechat-channels-env-name-follows-nickname）：
      // 读到非空平台真实昵称且与 AdsPower 环境名不一致时，经写客户端改名封装把该环境名改成昵称。
      // 幂等去抖（名已一致不发）+ 诚实降级（写失败保持原名、不重试风暴、不阻塞浏览闭环）；fire-and-forget，
      // 不 await（受写客户端 ≥1.1s 串行节流，不阻塞消息处理）。
      if (evt.account.name) maybeRenameEnvToNickname(handle, evt.account.name);
    }
    // 人设绑定态（change persona-bound-tristate）：云端 true / false 都下发，双向采纳——云端是单写方，
    // 解绑必须能传下来（否则客户端会一直显示「已设置」，而云端早已按未绑停了这个号）。
    if (personaApplicable(handle) && typeof evt.personaBound === 'boolean') next.personaBound = evt.personaBound;
    if (personaApplicable(handle) && Object.prototype.hasOwnProperty.call(evt, 'personaWritingLanguage')) {
      next.personaWritingLanguage = evt.personaWritingLanguage;
    }
    if (evt.proxyRuntime) {
      const proxyRuntime = normalizeProxyRuntime(evt.proxyRuntime);
      if (proxyRuntime) next.proxyRuntime = proxyRuntime;
    }
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
    if (evt.publishPreview && typeof evt.publishPreview === 'object') {
      next.publishPreview = evt.publishPreview;
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
    if (evt.browserStandby) {
      standbyHint = normalizeBrowserStandbyHint(evt.browserStandby);
      if (standbyHint) next.browserStandby = coldStandbyStatus('hint', standbyHint);
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
    if (evt.loopStage !== undefined) {
      next.loopStage = evt.loopStage;
      next.loopStageGeneration = handle.lifecycleGeneration;
      // loopStage 默认来自浏览器 feed/read/write/interact 阶段；只有结构化事件显式声明时才允许
      // 浏览器关闭仍投影为运行，不能把“任务正在等浏览器”冒充为执行中。
      next.loopStageBrowserIndependent = evt.loopStage !== null && evt.browserIndependent === true;
    }
    // 阻断浮层（登录/验证码/未知阻断）待人工处理：核心成对信号驱动（`popup` 置真 / `popup_cleared`
    // 或会话结束 置假），使该环境在环境栏浮顶为「需人工」而非绿色在线（红线：多环境跨窗盯验证码正是
    // 本控制台的核心目的）。
    //
    // change facebook-write-action-visibility：**移除了「任何成功互动（statsDelta）顺带置假」这条兜底**。
    // 它原是「显式清除信号还没有时」的权宜，但清除是**判断**、不是副作用：一次点赞只能证明那次点赞成功，
    // 证明不了验证码已经解决。留着它 = 被拦住的环境被一次无关动作抹回绿色，运营就此看不见该救哪台机器。
    // 两个平台此刻都已有显式成对信号（XHS 走中文兜底表的两条恢复信号；FB 走结构化 popup/popup_cleared），
    // 兜底已无存在理由。清除只认显式解除。
    if (evt.type === 'popup') next.overlayBlocked = true;
    else if (evt.type === 'popup_cleared' || evt.type === 'session_end') next.overlayBlocked = false;
  }
  updateStatus(handle, next);
  if (standbyHint) applyBrowserStandbyHint(handle, standbyHint);
}

function pauseEdge(handle) {
  if (!handle) return;
  if (handle.automationIntent === 'paused' || handle.pausePending) return;
  advanceLifecycleGeneration(handle, 'user_pause');
  // 暂停属于自动化通道生命周期：停止任务、断开引擎连接，并释放当前浏览器执行器。
  // 客户会话和所有 request-scoped HTTP 数据管理能力保持可用。
  handle.automationIntent = 'paused';
  handle.engineStopReason = 'user_pause';
  handle.resumeAfterStop = false;
  handle.stopRequested = true;
  clearColdStandbyTimer(handle);
  clearRespawnTimer(handle);
  handle.restartPending = false;
  handle.automationPaused = true;
  releaseStartQueue(handle);
  clearSlotWaiting(handle);
  if (handle.child) {
    const child = handle.child;
    handle.pausePending = true;
    updateStatus(handle, {
      edge: 'stopping',
      session: 'paused',
      loopStage: null,
      overlayBlocked: false,
      lastMessage: '正在暂停自动化并断开引擎；数据管理不受影响…',
      ...presencePatch('正在暂停并断开引擎…'),
      ...clearEdgeFailurePatch(handle),
    });
    sendCoreLifecycle(handle, 'pause_and_exit', (error) => {
      if (handle.child !== child) return;
      // IPC 已不可用时仍必须落实“暂停 = 引擎断开”；SIGTERM 走核心既有安全关闭路径。
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
      updateStatus(handle, {
        edge: 'stopping',
        session: 'paused',
        lastMessage: `暂停指令未送达（${error.message}），正在强制断开自动化引擎…`,
        ...presencePatch('正在强制断开自动化引擎…'),
      });
    });
    return;
  }
  handle.pausePending = false;
  updateStatus(handle, {
    edge: 'stopped',
    cloud: 'disconnected',
    session: 'paused',
    loopStage: null,
    overlayBlocked: false,
    lastMessage: '自动化已暂停，引擎未连接；数据管理仍可继续使用。',
    ...presencePatch('自动化已暂停'),
    ...clearEdgeFailurePatch(handle),
  });
}

function resumeEdge(handle) {
  if (!handle) return;
  const closingBeforeResume = Boolean(handle.child
    && (handle.pausePending || handle.stopRequested || handle.engineStopReason === 'user_close'));
  ensureEnabledLifecycleGeneration(handle, 'user_start');
  handle.automationIntent = 'enabled';
  handle.automationPaused = false;
  if (closingBeforeResume) {
    // pause/close 已进入安全退出，不尝试把同一进程“拉回来”；保持 stopRequested，待 close 后从新操作代启动。
    handle.resumeAfterStop = true;
    updateStatus(handle, {
      edge: 'starting',
      session: 'idle',
      loopStage: null,
      lastMessage: '关闭收尾中；引擎和浏览器关闭后将重新启动…',
      ...presencePatch('等待关闭收尾后重新启动…'),
      ...clearEdgeFailurePatch(handle),
    });
    return;
  }
  handle.engineStopReason = '';
  handle.stopRequested = false;
  handle.resumeAfterStop = false;
  if (handle.child && (handle.coldStandbyActive || handle.coldStandbyPending || handle.controlPlaneOnly)) {
    wakeColdStandby(handle, 'user_resume');
    return;
  }
  if (handle.child) {
    const child = handle.child;
    handle.pausePending = true;
    updateStatus(handle, {
      edge: 'running',
      session: 'running',
      lastMessage: '正在恢复自动化…',
      ...presencePatch('正在恢复自动化…'),
    });
    sendCoreLifecycle(handle, 'resume', (error) => {
      if (handle.child !== child) return;
      handle.pausePending = false;
      handle.automationIntent = 'paused';
      handle.automationPaused = true;
      updateStatus(handle, {
        edge: 'warning',
        session: 'paused',
        lastMessage: `恢复自动化失败：${error.message}。`,
        ...edgeFailurePatch(`恢复失败：${error.message}`),
        ...presencePatch('恢复请求未送达'),
      });
    });
    return;
  }
  updateStatus(handle, { session: 'idle' });
  queueStartEnv(handle);
}

/**
 * 无核心子进程时的诚实关闭核实（红线：绝不零回收假报已关）。该 profile 的浏览器由外部 AdsPower 运行时
 * 托管、会在核心死亡（如暂停驻留期崩溃）后存活。经**只读** V2 browser-profile/active 查其是否真的不在跑：
 * 确认不在跑才判「已关闭」；仍在跑则如实报「浏览器仍在运行、恢复接管后再关」；查不动则如实报「无法确认」。
 * 外壳只读 ads-local-api 边界不破：这里只读、不发停止；真关闭仍由（恢复后的）核心权威执行。
 */
async function confirmOwnedProfileClosedFromShell(handle) {
  updateStatus(handle, {
    lastMessage: '正在确认浏览器是否已关闭…',
    ...presencePatch('正在确认浏览器状态…'),
  });
  const res = await adsApi.listActiveProfiles({ ...resolveAdsOpts(), profileIds: [handle.profileId] }).catch(() => null);
  // 期间被启动 / 恢复 / 移出（start/resume 会把 stopRequested 复位为 false）：交给新流程，勿覆盖更新后的状态。
  if (handle.child || handle.removed || !handle.stopRequested) return;
  // 仅在拿到**结构良好**的在跑分身列表时才据其判定；code:0 但 data.list 缺失/非数组不算「确认为空」，
  // 绝不把不完整列表当已关（红线：不完整列表 ≠ 已关，防孤儿浏览器被假报已关）。
  const active =
    res && res.ok && res.listWellFormed && Array.isArray(res.activeUserIds) ? res.activeUserIds : null;
  if (active && active.includes(handle.profileId)) {
    // 分身确在跑但无核心可关：诚实报未关（保持暂停——浏览器开着、自动运营停着），引导恢复接管后再关。
    handle.browserStateUnconfirmed = true;
    updateStatus(handle, {
      edge: 'warning',
      session: 'paused',
      lastMessage: '浏览器仍在运行，但当前没有核心进程来关闭它；请点「恢复」接管后再关闭。',
      ...edgeFailurePatch('无核心进程可关闭浏览器，需恢复接管'),
      ...presencePatch('浏览器仍在运行，待接管后关闭'),
    });
    return;
  }
  if (active) {
    // 结构良好的列表里没有该分身 = 确认已关。
    handle.browserStateUnconfirmed = false;
    updateStatus(handle, {
      edge: 'stopped',
      cloud: 'disconnected',
      session: 'closed',
      overlayBlocked: false,
      kernelPrep: null,
      lastMessage: '浏览器已关闭。',
      ...presencePatch('已关闭浏览器'),
      ...clearEdgeFailurePatch(handle),
    });
    return;
  }
  // 拿不到结构良好的列表（不可达 / 响应不完整）：不确定，绝不假报已关。
  handle.browserStateUnconfirmed = true;
  updateStatus(handle, {
    edge: 'warning',
    session: 'paused',
    lastMessage: '无法确认浏览器关闭状态；可点「恢复」接管后再关闭，或重启客户端。',
    ...edgeFailurePatch('无法确认浏览器关闭状态'),
    ...presencePatch('关闭状态未能确认'),
  });
}

function stopAutomation(handle) {
  if (!handle || handle.removed) return;
  // 外部占用拒启发生在 browser-profile/start 返回句柄之前：本机从未拥有该浏览器。
  // 先冻结本轮事实，随后只收敛本机自动化意图；绝不能把远端 active 当成本机遗留浏览器去确认/接管/关闭。
  const externallyOccupiedBeforeAcquire = !handle.child && handle.envInUseThisRun === true;
  advanceLifecycleGeneration(handle, 'user_close');
  handle.automationIntent = 'stopped';
  handle.engineStopReason = 'user_close';
  handle.resumeAfterStop = false;
  handle.automationPaused = false;
  handle.stopRequested = true;
  handle.browserOpenPending = false;
  handle.restartPending = false;
  clearRespawnTimer(handle);
  clearColdStandbyTimer(handle);
  releaseStartQueue(handle);
  clearSlotWaiting(handle);
  if (!handle.child) {
    handle.pausePending = false;
    if (externallyOccupiedBeforeAcquire) {
      handle.browserStateUnconfirmed = false;
      handle.envInUseThisRun = false;
      handle.envInUseHolder = null;
    }
    updateStatus(handle, {
      edge: 'stopped',
      cloud: 'disconnected',
      session: 'closed',
      loopStage: null,
      closeScope: externallyOccupiedBeforeAcquire ? 'local_automation_only' : null,
      overlayBlocked: false,
      lastMessage: externallyOccupiedBeforeAcquire
        ? '本机自动化已关闭；占用端浏览器未被本机关闭或触碰，数据管理仍可继续使用。'
        : handle.kind === 'adspower'
        ? '自动化引擎已关闭，正在确认浏览器状态；数据管理仍可继续使用。'
        : '自动化已关闭；数据管理仍可继续使用。',
      ...presencePatch(
        externallyOccupiedBeforeAcquire
          ? '本机自动化已关闭；占用端浏览器未受影响'
          : handle.kind === 'adspower'
            ? '自动化已关闭，正在确认浏览器'
            : '自动化已关闭',
      ),
      ...clearEdgeFailurePatch(handle),
    });
    if (externallyOccupiedBeforeAcquire) return;
    if (handle.kind === 'adspower' && handle.profileId) void confirmOwnedProfileClosedFromShell(handle);
    return;
  }
  const child = handle.child;
  updateStatus(handle, {
    edge: 'stopping',
    session: 'closed',
    loopStage: null,
    overlayBlocked: false,
    lastMessage: '正在关闭自动化引擎和浏览器；数据管理不受影响…',
    ...presencePatch('正在关闭自动化…'),
    ...clearEdgeFailurePatch(handle),
  });
  sendCoreLifecycle(handle, 'close', (error) => {
    if (handle.child !== child) return;
    try { child.kill('SIGTERM'); } catch { /* best-effort */ }
    updateStatus(handle, {
      edge: 'stopping',
      lastMessage: `关闭指令未送达（${error.message}），正在终止自动化引擎…`,
      ...presencePatch('正在终止自动化引擎…'),
    });
  });
}

function closeBrowserExecutor(handle) {
  if (!handle || handle.closePending || handle.coldStandbyPending || handle.coldStandbyActive || handle.controlPlaneOnly) return;
  clearColdStandbyTimer(handle);
  if (!handle.child) {
    updateStatus(handle, {
      lastMessage: '自动化引擎当前未连接，无法确认外部浏览器状态；未执行隐式浏览器操作。',
      ...presencePatch('引擎未连接，浏览器状态未确认'),
    });
    return;
  }
  const child = handle.child;
  handle.closePending = true;
  handle.coldStandbyPending = true;
  handle.coldStandbyWakeAt = 0;
  updateStatus(handle, {
    browserStandby: coldStandbyStatus('scheduled', null, { reason: 'user_browser_close' }),
    lastMessage: '正在关闭浏览器执行器；自动化引擎保持连接…',
    ...presencePatch('正在关闭浏览器'),
    ...clearEdgeFailurePatch(handle),
  });
  sendCoreLifecycle(handle, 'standby', (error) => {
    if (handle.child !== child) return;
    handle.closePending = false;
    handle.coldStandbyPending = false;
    updateStatus(handle, {
      edge: 'warning',
      lastMessage: `浏览器关闭失败：${error.message}。自动化引擎未关闭。`,
      ...edgeFailurePatch(`浏览器关闭失败：${error.message}`),
      ...presencePatch('浏览器关闭请求未送达'),
    });
  });
}

function relogin(handle) {
  stopAndRestart(handle, '已请求重新登录，正在按当前浏览器设置重启边缘进程。');
  return handle ? handle.status : null;
}

/**
 * 「全部启动」：未运行环境进入**有界串行启动队列**；超出启动排队上限的环境本次不加入。
 *
 * 环境创建不受这两个上限影响；并发只约束同时执行数，排队上限只约束尚未执行的启动请求数。
 */
function startAllEnvs({ envIds } = {}) {
  // renderer 的筛选只决定“请求哪些”；主进程仍以实时句柄表求交集，已移出/伪造 ID 不能扩大启动范围。
  // envIds 未提供时兼容旧版 renderer 的全量调用；显式空数组则是零目标。
  const scoped = fleet.scopeFleetHandles([...envs.values()], envIds);
  const closing = scoped.filter((h) => h.child && (h.stopRequested || h.engineStopReason === 'user_close'));
  const paused = scoped.filter((h) => h.child && !closing.includes(h) && h.status.session === 'paused');
  const standby = scoped.filter((h) => h.child && !closing.includes(h) && h.status.session !== 'paused'
    && (h.coldStandbyActive || h.coldStandbyPending || h.controlPlaneOnly));
  const targets = scoped.filter((h) => !h.child);
  if (targets.length === 0 && closing.length === 0 && paused.length === 0 && standby.length === 0) {
    return { ok: true, queued: 0 };
  }
  [...closing, ...paused, ...standby].forEach((h) => resumeEdge(h));
  const accepted = [];
  const controlOnly = [];
  const rejected = [];
  targets.forEach((handle) => {
    const result = queueStartEnv(handle, accepted.length + 1);
    if (result === 'control-only') controlOnly.push(handle);
    else if (result) accepted.push(handle);
    else rejected.push(handle);
  });
  const all = [...closing, ...paused, ...standby, ...accepted];
  return {
    ok: true,
    queued: all.length,
    controlOnly: controlOnly.length,
    rejected: rejected.length,
    queueLimit: maxQueuedStarts(),
    envIds: all.map((h) => h.envId),
    controlOnlyEnvIds: controlOnly.map((h) => h.envId),
    rejectedEnvIds: rejected.map((h) => h.envId),
  };
}

/** 「全部停止」（不退出应用）：全部在跑环境按暂停语义错峰停止；处于重起退避窗口（无子进程）的环境
 * 也置暂停 + 清重起定时器，杜绝「全部停止后某个崩溃环境几秒后自行复活」的静默矛盾。 */
function stopAllEnvs() {
  const targets = [...envs.values()].filter((h) => !h.removed && h.automationIntent === 'enabled');
  for (const h of targets) pauseEdge(h);
  return { ok: true, stopped: targets.length };
}

/**
 * 「全部关闭」按 renderer 声明的筛选范围取实时句柄交集，再逐环境复用 stopAutomation。
 * accepted 只表示关闭请求已受理；浏览器是否真实关闭仍由各环境后续状态 / 本地只读确认给结论。
 */
function closeAllEnvs({ envIds } = {}) {
  const targets = fleet.scopeFleetHandles([...envs.values()], envIds)
    .filter((handle) => !handle.removed);
  for (const handle of targets) stopAutomation(handle);
  return { ok: true, accepted: targets.length, envIds: targets.map((handle) => handle.envId) };
}

async function stopManagedAdsRuntime() {
  const runtime = managedAdsRuntime;
  if (!runtime) return { ok: true, skipped: true };
  const stopped = await adsRuntime.stopRuntime(runtime).catch((error) => ({
    ok: false,
    error: (error && error.message) || String(error),
  }));
  if (!stopped.ok) appendEdgeLog('supervisor', `Ads CLI daemon 停止失败：${stopped.error}`, true);
  managedAdsRuntime = null;
  adsServiceBase = null;
  return stopped;
}

/** 应用退出：先停全部环境核心并等浏览器清理，再停止本次已管理的 Ads CLI daemon。 */
async function gracefulStopAllAndQuit() {
  if (quitStopAllInFlight) return;
  quitStopAllInFlight = true;
  isQuitting = true;
  if (selectedProxyPreflightTimer) clearTimeout(selectedProxyPreflightTimer);
  selectedProxyPreflightTimer = null;
  stopLoginPoller();
  for (const handle of envs.values()) {
    clearRespawnTimer(handle);
    clearColdStandbyTimer(handle);
  }
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
  await stopManagedAdsRuntime();
  quitFinal = true;
  app.quit();
}

function quitApp() {
  app.quit(); // 经 before-quit 统一走优雅全停
}

/** 外壳重启对账：逐 profile 经 V2 active + 已验证失联 CDP 探在跑分身——启动时接管、不重复拉起。 */
async function reconcileRunningProfiles() {
  if (settings.provider !== 'adspower' || envs.size === 0) return;
  const profileIds = [...envs.values()]
    .filter((handle) => handle.kind === 'adspower' && handle.profileId)
    .map((handle) => handle.profileId);
  const res = await adsApi.listActiveProfiles({ ...resolveAdsOpts(), profileIds }).catch(() => null);
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

function lifecycleAxes(handle) {
  const status = handle.status || {};
  const clientSessionState = clientAuthEnabled()
    ? (hasValidSession() ? 'ready' : 'signed_out')
    : 'ready';
  const coreState = handle.child
    ? (status.edge === 'starting' || handle.controlPlaneStarting ? 'starting' : 'online')
    : (handle.respawnTimer ? 'restarting' : (handle.gaveUp || status.respawnGaveUp ? 'error' : 'stopped'));
  const engineLinkState = status.cloud === 'connected'
    ? 'connected'
    : handle.child
      ? (status.cloudEverConnected ? 'reconnecting' : 'connecting')
      : (handle.gaveUp || status.respawnGaveUp ? 'error' : 'disconnected');
  // compatibility only: old renderers may still consume cloudState, but it is the automation-engine link,
  // not a global client-to-cloud connection or a prerequisite for HTTP data management.
  const cloudState = engineLinkState === 'disconnected' ? 'offline' : engineLinkState;
  const transientRuntime = usesTransientBrowserLane(handle) ? handle.interactionRuntime : null;
  const interactionProvenRunning = Boolean(transientRuntime
    && transientRuntime.authStatus === 'active'
    && transientRuntime.identityMatches
    && transientRuntime.connectorStarted
    && transientRuntime.cloudNegotiated
    && !transientRuntime.paused
    && !transientRuntime.offboardPending
    && transientRuntime.dataCapable
    && transientRuntime.proofAt >= handle.spawnedAtMs);
  const waitingForResource = handle.launchQueued || handle.startFlowQueued || handle.slotWaitingSince
    || handle.transientBrowserQueued;
  let browserState = status.overlayBlocked
    ? 'blocked'
    : handle.browserStateUnconfirmed
      ? 'error'
    : (handle.pausePending || (handle.engineStopReason === 'user_close' && handle.child))
    ? 'closing'
    : handle.browserOpenPending
    ? 'starting'
    : handle.coldStandbyWaking
    ? 'starting'
    : handle.executorFailure
      ? 'error'
    : (handle.slotWaitingSince || handle.startFlowQueued || (handle.launchQueued && !handle.controlPlaneOnly))
      ? 'queued'
      : (handle.coldStandbyActive || handle.coldStandbyPending || handle.controlPlaneOnly)
        ? 'closed'
        : handle.child
          ? (handle.browserParkingReady ? 'ready' : 'starting')
          : 'closed';
  if (usesTransientBrowserLane(handle)) {
    const sidecarState = transientRuntime && transientRuntime.browserState;
    browserState = handle.transientBrowserQueued
      ? 'queued'
      : sidecarState === 'opening'
        ? 'starting'
        : sidecarState === 'open'
          ? 'ready'
          : sidecarState === 'closing'
            ? 'closing'
            : sidecarState === 'unavailable'
              ? 'error'
              : 'closed';
  }
  const currentLoopRunning = Boolean(status.loopStage
    && status.loopStageGeneration === handle.lifecycleGeneration);
  const currentLoopExecutable = currentLoopRunning
    && (browserState === 'ready' || status.loopStageBrowserIndependent === true);
  let automationState = handle.resumeAfterStop && handle.child
    ? 'starting'
    : handle.pausePending && handle.automationIntent === 'enabled'
      ? 'starting'
      : handle.pausePending
        ? 'pausing'
        : handle.engineStopReason === 'user_close' && handle.child
          ? 'stopping'
          : handle.automationIntent === 'paused'
            ? 'paused'
            : handle.automationIntent === 'stopped'
              ? 'stopped'
              : waitingForResource
                ? 'waiting_resource'
                : (handle.gaveUp || status.respawnGaveUp || (status.edgeFailure && !handle.child))
                  ? 'error'
                  : handle.child && status.cloud === 'connected'
                    ? (currentLoopExecutable ? 'running' : 'ready')
                    : handle.child
                      ? 'starting'
                      : 'stopped';
  if (usesTransientBrowserLane(handle)) {
    automationState = handle.resumeAfterStop && handle.child
      ? 'starting'
      : handle.pausePending && handle.automationIntent === 'enabled'
        ? 'starting'
        : handle.pausePending
          ? 'pausing'
          : handle.engineStopReason === 'user_close' && handle.child
            ? 'stopping'
            : handle.automationIntent === 'paused' || (transientRuntime && transientRuntime.paused)
              ? 'paused'
              : handle.automationIntent === 'stopped'
                ? 'stopped'
                : handle.transientBrowserQueued
                  ? 'waiting_resource'
                  : handle.transientBrowserActive
                    ? 'starting'
                    : (handle.gaveUp || status.respawnGaveUp || (status.edgeFailure && !handle.child))
                      ? 'error'
                      : handle.child && status.cloud === 'connected'
                        ? (interactionProvenRunning ? 'running' : 'ready')
                        : handle.child
                          ? 'starting'
                          : 'stopped';
  }
  return { clientSessionState, engineLinkState, automationState, browserState, coreState, cloudState };
}

/**
 * The renderer may show an exact queue number only when the scheduler that owns
 * the current stage can prove it. An item already taken by a queue for execution
 * intentionally has no numeric waiting position.
 */
function lifecycleQueueProjection(handle) {
  if (!handle) return { queueStage: null, queuePosition: null };
  if (handle.transientBrowserQueued && handle.transientBrowserQueueKey) {
    return {
      queueStage: 'transient',
      queuePosition: transientBrowserQueue.pendingPosition(handle.transientBrowserQueueKey),
    };
  }
  if (handle.slotWaitingSince) {
    const position = slotWaiters().findIndex((waiting) => waiting === handle);
    return { queueStage: 'slot', queuePosition: position >= 0 ? position + 1 : null };
  }
  if (handle.launchQueued) {
    return { queueStage: 'launch', queuePosition: launchQueue.pendingPosition(handle.envId) };
  }
  if (handle.startFlowQueued) {
    return { queueStage: 'preparing', queuePosition: lifecycleQueue.pendingPosition(handle.envId) };
  }
  return { queueStage: null, queuePosition: null };
}

function statusOf(handle) {
  if (!handle) {
    return {
      ...makeStatus(settings.provider),
      envId: '',
      envName: '',
      clientSessionState: clientAuthEnabled() && !hasValidSession() ? 'signed_out' : 'ready',
      engineLinkState: 'disconnected',
      coreState: 'stopped',
      cloudState: 'offline',
      automationState: 'stopped',
      browserState: 'closed',
      queueStage: null,
      queuePosition: null,
      personaApplicable: true,
      browserUsageMode: 'persistent',
    };
  }
  handle.status.commandDiagnostics = commandDiagnostics.pruneCommandDiagnostics(
    handle.status.commandDiagnostics,
    Date.now(),
  );
  return {
    ...handle.status,
    ...lifecycleAxes(handle),
    ...lifecycleQueueProjection(handle),
    personaApplicable: personaApplicable(handle),
    browserUsageMode: fleet.browserUsageModeForPlatform(handle.platform),
    targetCloudKey: handle.status.targetCloudKey || cloudSelectionView().key,
    envId: handle.envId,
    envName: handle.name,
  };
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
  stopAutomation(handle);
  return statusOf(handle);
});
ipcMain.handle('browser:close', (_event, envId) => {
  const handle = resolveHandle(envId);
  closeBrowserExecutor(handle);
  return statusOf(handle);
});
ipcMain.handle('browser:open', (_event, envId) => {
  const handle = resolveHandle(envId);
  if (!handle || handle.removed) return statusOf(handle);
  if (handle.child) {
    if (handle.coldStandbyActive || handle.coldStandbyPending || handle.controlPlaneOnly) {
      wakeColdStandby(handle, 'user_browser_open');
    }
    return statusOf(handle);
  }
  // 手动打开浏览器是高级登录/验证/检查动作：允许临时连接引擎，但自动化意图仍保持关闭。
  handle.automationIntent = 'stopped';
  handle.engineStopReason = '';
  handle.resumeAfterStop = false;
  handle.automationPaused = true;
  handle.stopRequested = false;
  const controlState = allowedEnvironmentControlStates.get(String(handle.profileId || '').trim());
  if (controlState && controlState.bindingState === 'bound') {
    // 先回可见受理态，再做可能等待客户接口 / Cloud 握手的 bootstrap。IPC 不再把按钮挂到握手结束。
    handle.browserOpenPending = true;
    updateStatus(handle, {
      edge: 'starting',
      session: 'idle',
      lastMessage: '正在连接自动化引擎并打开浏览器；自动化保持关闭…',
      ...presencePatch('正在打开浏览器…'),
      ...clearEdgeFailurePatch(handle),
    });
    void startBrowserAbsentCore(handle).then((started) => {
      if (!handle.browserOpenPending) return;
      if (!started || handle.removed || handle.stopRequested || handle.automationIntent !== 'stopped' || !handle.child) {
        handle.browserOpenPending = false;
        updateStatus(handle, {});
        return;
      }
      wakeColdStandby(handle, 'user_browser_open');
    }).catch((error) => {
      if (!handle.browserOpenPending) return;
      handle.browserOpenPending = false;
      updateStatus(handle, {
        edge: 'warning',
        lastMessage: `打开浏览器失败：${error?.message || error}`,
        ...edgeFailurePatch(`打开浏览器失败：${error?.message || error}`),
        ...presencePatch('浏览器打开失败'),
      });
    });
    return statusOf(handle);
  }
  // 首次建立绑定必须显式打开真实页面。自动化保持关闭，只做 browser_lifecycle 启动；不由 Cloud 操作触发。
  updateStatus(handle, {
    edge: 'starting',
    session: 'idle',
    lastMessage: '正在打开浏览器完成首次登录；自动化保持关闭…',
    ...presencePatch('正在打开浏览器…'),
    ...clearEdgeFailurePatch(handle),
  });
  enqueueStartFlow(handle);
  return statusOf(handle);
});
ipcMain.handle('auth:relogin', (_event, envId) => {
  const handle = resolveHandle(envId);
  relogin(handle);
  return statusOf(handle);
});
ipcMain.handle('settings:get', () => ({
  ...settings,
  // Cleanup credentials and authoritative account bindings stay in Electron main. Renderer only
  // receives the minimum status cursor already projected through ads:listProfiles/fleet state.
  pendingInteractionOffboards: (settings.pendingInteractionOffboards || []).map((item) => ({
    offboardId: item.offboardId,
    envKey: item.envKey,
    state: item.state,
    reason: item.reason,
    requestedAt: item.requestedAt,
    purgeDueAt: item.purgeDueAt,
    platform: item.platform,
  })),
  adsDownloadUrl: ADS_DOWNLOAD_URL,
  cloudEnv: cloudSelectionView(),
  cloudTarget: cloudTargetView(),
  // 浏览器并发：把**算出来的**两个上限连同来源一起给界面，让它能如实说「自动推算 N」还是「你设的 N」，
  // 而不是让渲染层自己再算一遍（两处各算一遍必然漂移）。
  slots: {
    ...slotSettingsView(),
    occupied: occupiedSlots(),
    queued: queuedStartCount(),
    configured: [...envs.values()].filter((h) => !h.removed).length,
    transient: transientQueueSnapshot(),
  },
  appVersion: app.getVersion(),
}));

// 对外客户鉴权（change edge-client-customer-auth）：登录窗口调 login；主进程做 HTTP，成功后拉可见环境 + 建主窗 + 关登录窗。
ipcMain.handle('client-auth:login', async (_event, creds) => {
  const result = await establishClientSession(creds);
  if (result.ok) {
    await proceedAfterAuth();
    if (loginWindow) { try { loginWindow.close(); } catch { /* ignore */ } loginWindow = null; }
    return result;
  }
  return result;
});
ipcMain.handle('client-auth:logout', async () => {
  if (clientSession && clientSession.token) {
    void clientAuthFetch('/logout', { method: 'POST', token: clientSession.token });
  }
  onSessionInvalid({ forgetCredentials: true });
  return { ok: true };
});
ipcMain.handle('client-auth:session', () => ({
  enabled: clientAuthEnabled(),
  name: (clientSession && clientSession.name) || null,
}));
ipcMain.handle('client-auth:prefill', () => loadClientLoginPrefill());
ipcMain.handle('client-auth:prefill:clear', () => {
  clearClientLoginPrefill();
  return { ok: true };
});

// 视频号互动工作区具名 IPC。每个 handler 都锁定唯一 HTTP method/path 与参数白名单；
// renderer 无法传 URL、method、authorization/header 或任意 body。
ipcMain.handle('interaction:list', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'channel', 'state', 'cursor', 'limit']));
  const envKey = interactionId(args.envKey, 'envKey');
  const channel = args.channel == null ? null : String(args.channel);
  const state = args.state == null ? null : String(args.state);
  if (channel && !INTERACTION_CHANNELS.has(channel)) throw new Error('channel 不合法');
  if (state && !INTERACTION_LIST_STATES.has(state)) throw new Error('state 不合法');
  const cursor = interactionOptionalString(args.cursor, 'cursor', 4096);
  const limit = interactionLimit(args.limit);
  const query = interactionQuery({ channel, state, cursor, limit }, new Set(['channel', 'state', 'cursor', 'limit']));
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/interactions${query}`,
    cancellable: true,
  });
}));

ipcMain.handle('interaction:detail', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'threadId', 'cursor', 'limit']));
  const envKey = interactionId(args.envKey, 'envKey');
  const threadId = interactionId(args.threadId, 'threadId');
  const cursor = interactionOptionalString(args.cursor, 'cursor', 4096);
  interactionLimit(args.limit);
  const query = interactionQuery({ cursor }, new Set(['cursor']));
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/interactions/${encodeURIComponent(threadId)}${query}`,
    cancellable: true,
  });
}));

ipcMain.handle('interaction:draft:update', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'jobId', 'expectedVersion', 'finalText']));
  const envKey = interactionId(args.envKey, 'envKey');
  const jobId = interactionId(args.jobId, 'jobId');
  const expectedVersion = interactionExpectedVersion(args.expectedVersion);
  if (typeof args.finalText !== 'string' || !args.finalText.trim() || args.finalText.length > 4000) throw new Error('finalText 不合法');
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/replies/${encodeURIComponent(jobId)}/draft`,
    method: 'PUT',
    body: { expectedVersion, finalText: args.finalText },
  });
}));

// 环境级慢启动开关（change environment-level-slow-start）：**只提交 envKey + enabled**。
// 配置直接属于 envKey，未绑定账号也可预设；客户端永不提交 accountId。
//
// **原作者「边缘不在线就改不了不是缺陷」的论断已被用户裁定推翻**：慢启动真态是纯云端算的、写入执行体也在云端
// 配额计算内，边缘对这次写入没有任何参与——那道内核在线闸是 INCIDENTAL（这次写全程不经过环境内核子进程）。
// 故此处**MUST NOT**为「一致」在 IPC / interactionCustomerRequest 上新增任何浏览器 / 环境在线闸（那正是 DEFECT 3
// 的病灶形状）：够不够得着云端由 interactionCustomerRequest 自身的成败表达，失败复用既有按环境隔离的失败反馈。
ipcMain.handle('slow-start:set', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'enabled']));
  const envKey = interactionId(args.envKey, 'envKey');
  if (typeof args.enabled !== 'boolean') throw new Error('enabled 不合法');
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/slow-start`,
    method: 'PUT',
    body: { enabled: args.enabled },
  });
}));

// 不依赖边缘的慢启动读（change slow-start-offline-toggle）：让没有活快照（从未启动 / 已停止，dailyUsage 为 null）
// 的环境也能把慢启动这一行渲染出来——binding_unknown 可见性的前置。同样**不加**任何环境在线闸。
ipcMain.handle('slow-start:get', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/slow-start`,
    method: 'GET',
  });
}));

// Facebook 环境风险真态读 / 解除受限：renderer 只交 envKey；accountId、平台、目标状态、审计理由均由 Cloud 解析。
// 与慢启动读写同样不依赖环境内核在线，停止的环境也必须能看到并解除持久 restricted。
ipcMain.handle('environment-risk:get', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/risk-state`,
    method: 'GET',
  });
}));

ipcMain.handle('environment-risk:recover', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/risk-state/recover`,
    method: 'POST',
    body: {},
  });
}));

for (const action of ['approve', 'regenerate']) {
  ipcMain.handle(`interaction:${action}`, (_event, raw) => handleInteractionIpc(async () => {
    const args = interactionArgs(raw, new Set(['envKey', 'jobId', 'expectedVersion']));
    const envKey = interactionId(args.envKey, 'envKey');
    const jobId = interactionId(args.jobId, 'jobId');
    const expectedVersion = interactionExpectedVersion(args.expectedVersion);
    return interactionCustomerRequest({
      envKey,
      pathname: `/environments/${encodeURIComponent(envKey)}/replies/${encodeURIComponent(jobId)}/${action}`,
      method: 'POST',
      body: { expectedVersion },
    });
  }));
}

ipcMain.handle('interaction:send', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'jobId', 'expectedVersion', 'idempotencyKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  const jobId = interactionId(args.jobId, 'jobId');
  const expectedVersion = interactionExpectedVersion(args.expectedVersion);
  const idempotencyKey = interactionIdempotencyKey(args.idempotencyKey);
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/replies/${encodeURIComponent(jobId)}/send`,
    method: 'POST',
    body: { expectedVersion },
    idempotencyKey,
  });
}));

ipcMain.handle('interaction:ignore', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'messageId', 'expectedVersion']));
  const envKey = interactionId(args.envKey, 'envKey');
  const messageId = interactionId(args.messageId, 'messageId');
  const expectedVersion = interactionExpectedVersion(args.expectedVersion);
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/interactions/${encodeURIComponent(messageId)}/ignore`,
    method: 'POST',
    body: { expectedVersion },
  });
}));

ipcMain.handle('interaction:escalate', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'messageId', 'expectedVersion', 'reason']));
  const envKey = interactionId(args.envKey, 'envKey');
  const messageId = interactionId(args.messageId, 'messageId');
  const expectedVersion = interactionExpectedVersion(args.expectedVersion);
  const reason = String(args.reason == null ? '' : args.reason).trim();
  if (!reason || reason.length > 512 || /[\u0000-\u001f\u007f]/.test(reason)) throw new Error('reason 不合法');
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/interactions/${encodeURIComponent(messageId)}/escalate`,
    method: 'POST',
    body: { expectedVersion, reason },
  });
}));

ipcMain.handle('interaction:sync', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'channel', 'scopeExternalId', 'idempotencyKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  const channel = args.channel == null ? null : String(args.channel);
  if (channel && !INTERACTION_CHANNELS.has(channel)) throw new Error('channel 不合法');
  const scopeExternalId = args.scopeExternalId == null ? null : interactionId(args.scopeExternalId, 'scopeExternalId');
  const idempotencyKey = interactionIdempotencyKey(args.idempotencyKey);
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/interactions/sync`,
    method: 'POST',
    body: { channel, scopeExternalId },
    idempotencyKey,
  });
}));

ipcMain.handle('interaction:test-reset', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'channel', 'idempotencyKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  const channel = String(args.channel || '');
  if (!INTERACTION_CHANNELS.has(channel)) throw new Error('channel 不合法');
  const idempotencyKey = interactionIdempotencyKey(args.idempotencyKey);
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/interactions/test-reset`,
    method: 'POST',
    body: { channel },
    idempotencyKey,
  });
}));

ipcMain.handle('interaction:auth:reopen', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'idempotencyKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  const idempotencyKey = interactionIdempotencyKey(args.idempotencyKey);
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/interactions/auth/reopen`,
    method: 'POST',
    body: {},
    idempotencyKey,
  });
}));

ipcMain.handle('interaction:browser:control', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'action', 'idempotencyKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  const action = String(args.action || '');
  if (action !== 'open' && action !== 'close') throw new Error('action 不合法');
  const idempotencyKey = interactionIdempotencyKey(args.idempotencyKey);
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/interactions/browser`,
    method: 'POST',
    body: { action },
    idempotencyKey,
  });
}));

// 客户本机人工查看：只按 envKey 定位当前客户可见的视频号 AdsPower 分身，直接走本机 LocalAPI。
// 与上方 Cloud→Edge 的 auth sidecar 控制是两条不同能力：这里不要求 auth active / Edge 在线，
// 也绝不启动、恢复或附着核心。打开浏览器成功 ≠ 视频号鉴权成功，鉴权仍以 Interaction 投影为准。
ipcMain.handle('interaction:browser:open-local', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  if (!hasValidSession() || !(allowedProfileIds instanceof Set) || !allowedProfileIds.has(envKey)
    || allowedEnvironmentPlatforms.get(envKey) !== 'wechat_channels') {
    return interactionLocalError('INTERACTION_SCOPE_MISMATCH', '当前环境不属于本次登录客户，无法打开浏览器。', 403);
  }
  // 精确按 profileId 查本机句柄；MUST NOT 用 selectedHandle() 回落，否则环境切换竞态会误开另一个账号。
  const handle = [...envs.values()].find((candidate) => candidate
    && !candidate.removed
    && candidate.kind === 'adspower'
    && candidate.profileId === envKey
    && normalizePlatform(candidate.platform) === 'wechat_channels');
  if (!handle) {
    return interactionLocalError('INTERACTION_SCOPE_MISMATCH', '当前视频号环境不在本机，无法打开浏览器。', 403);
  }

  // 只准备本地运行时 / 内核，handle 故意传 null：不得把人工打开呈现成「引擎正在启动」或改写鉴权状态。
  const service = await ensureAdsServiceOnce(null);
  if (!service.ok) {
    return interactionLocalError('INTERACTION_UPSTREAM_UNAVAILABLE', `本地浏览器运行时未就绪：${service.error || '未知错误'}`, 503);
  }
  const kernelVersion = handle.neededKernel || adsFingerprint.DEFAULT_KERNEL;
  const kernel = await ensureKernelOnce(kernelVersion, service.cliEntry, null);
  if (!kernel.ok) {
    return interactionLocalError('INTERACTION_UPSTREAM_UNAVAILABLE', `浏览器内核 ${kernelVersion} 未就绪：${kernel.error || '未知错误'}`, 503);
  }
  const opened = await adsApi.openProfileForInspection({
    ...resolveAdsOpts(),
    userId: handle.profileId,
    startUrl: WECHAT_CHANNELS_INSPECTION_URL,
  });
  if (!opened.ok) {
    return interactionLocalError('INTERACTION_UPSTREAM_UNAVAILABLE', opened.error || '本地浏览器未能打开。', 503);
  }
  // 只记录浏览器已在跑，供用户之后显式点「启动」时走既有接管路径；此处本身不启动核心。
  handle.browserAlreadyRunning = true;
  return {
    status: 200,
    ok: true,
    data: { envKey, opened: true },
  };
}));

ipcMain.handle('interaction:read-controls:update', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'expectedVersion', 'commentsReadEnabled', 'dmReadEnabled']));
  const envKey = interactionId(args.envKey, 'envKey');
  const expectedVersion = interactionExpectedVersion(args.expectedVersion);
  const commentsReadEnabled = interactionBoolean(args.commentsReadEnabled, 'commentsReadEnabled');
  const dmReadEnabled = interactionBoolean(args.dmReadEnabled, 'dmReadEnabled');
  return interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/interactions/read-controls`,
    method: 'PUT',
    body: { expectedVersion, commentsReadEnabled, dmReadEnabled },
  });
}));

ipcMain.handle('interaction:notify', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey', 'channel', 'count']));
  const envKey = interactionId(args.envKey, 'envKey');
  const channel = String(args.channel || '');
  if (!INTERACTION_CHANNELS.has(channel) && channel !== 'mixed') throw new Error('channel 不合法');
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 100) throw new Error('count 不合法');
  if (!hasValidSession() || !(allowedProfileIds instanceof Set) || !allowedProfileIds.has(envKey)
    || allowedEnvironmentPlatforms.get(envKey) !== 'wechat_channels') {
    return interactionLocalError('INTERACTION_SCOPE_MISMATCH', '当前环境不可用，未显示互动提醒。', 403);
  }
  const subject = channel === 'comment' ? '条新评论' : channel === 'dm' ? '条新私信' : '条新互动';
  surfaceNotification('视频号有新互动', `${args.count} ${subject}等待查看`);
  return { status: 200, ok: true, data: { envKey, notified: true } };
}));

ipcMain.handle('interaction:reads:cancel', (_event, raw) => handleInteractionIpc(async () => {
  const args = interactionArgs(raw, new Set(['envKey']));
  const envKey = interactionId(args.envKey, 'envKey');
  return { ok: true, cancelled: cancelInteractionReads(envKey) };
}));

ipcMain.handle('settings:save', async (_event, patch) => {
  const safePatch = { ...(patch || {}) };
  // pending offboard 是主进程在 Cloud 202 回执后写入的恢复游标，renderer 不得伪造/覆盖。
  delete safePatch.pendingInteractionOffboards;
  // 排除集合 owner 只由当前有效客户会话派生，renderer 不得伪造身份或把选择带给另一客户。
  delete safePatch.clientRosterExclusionOwner;
  let scopeError;
  if (clientAuthEnabled() && hasValidSession() && allowedProfileIds instanceof Set) {
    if (Array.isArray(safePatch.environments)) {
      const requested = safePatch.environments;
      safePatch.environments = requested.filter((env) => env && allowedProfileIds.has(String(env.profileId || '').trim()));
      if (safePatch.environments.length !== requested.length) scopeError = '未获管理员分配的环境不能加入运行花名册。';
    }
    if (Object.prototype.hasOwnProperty.call(safePatch, 'adsProfileId')
      && safePatch.adsProfileId && !allowedProfileIds.has(String(safePatch.adsProfileId).trim())) {
      delete safePatch.adsProfileId;
      delete safePatch.adsProfileName;
      scopeError = '未获管理员分配的环境不能设为当前运行环境。';
    }
    if (Array.isArray(safePatch.clientRosterExcludedEnvIds)) {
      const requested = normalizeClientRosterExcludedEnvIds(safePatch.clientRosterExcludedEnvIds);
      safePatch.clientRosterExcludedEnvIds = requested.filter((envKey) => allowedProfileIds.has(envKey));
      safePatch.clientRosterExclusionOwner = String((clientSession && clientSession.name) || '').trim();
      if (safePatch.clientRosterExcludedEnvIds.length !== requested.length) {
        scopeError = scopeError || '未获管理员分配的环境不能保存为手动移出。';
      }
    }
  } else {
    // 无可信客户范围时不接受 renderer 写排除集合；非客户模式也不启用这套默认入册语义。
    delete safePatch.clientRosterExcludedEnvIds;
  }
  const res = saveSettings(safePatch);
  syncEnvHandles(); // 花名册变更即同步注册表（新环境建行、移出的有序停止）
  // 保存只持久化、**不打断**在跑的核心（应用改动经显式 edge:restart「按新设置重启」/「全部重启换云」）。
  const handle = selectedHandle();
  if (handle) {
    updateStatus(handle, {
      provider: settings.provider,
      lastMessage: res.ok ? '浏览器设置已保存。' : '设置已应用（本次生效），但写入本地失败，重启应用后可能丢失。',
    });
  }
  broadcastFleet(); // cloudEnv 目标云端可能已变，推快照让界面「当前云端」即时刷新（保存不打断在跑核心）
  return {
    ...settings,
    adsDownloadUrl: ADS_DOWNLOAD_URL,
    cloudEnv: cloudSelectionView(),
    cloudTarget: cloudTargetView(),
    // 并发上限改了要立刻回给界面**重算后的**值（缓存已在归一时作废）——否则界面还显示旧的推算数。
    slots: {
      ...slotSettingsView(),
      occupied: occupiedSlots(),
      queued: queuedStartCount(),
      configured: [...envs.values()].filter((h) => !h.removed).length,
      transient: transientQueueSnapshot(),
    },
    saveOk: res.ok && !scopeError,
    saveError: res.error || scopeError,
  };
});
// 兼容既有 preload 通道名，但仅重绑已经运行的自动化引擎：绝不因设置变更启动已停止的引擎或浏览器。
ipcMain.handle('cloud:restartAll', async () => {
  const target = cloudSelectionView();
  const targets = [...envs.values()].filter((h) => !h.removed && h.kind === 'adspower');
  const results = await Promise.all(targets.map(async (handle) => {
    if (handle.child) return requestCoreCloudRebind(handle, target);
    updateStatus(handle, {
      targetCloudKey: target.key,
      cloudRebind: { state: 'idle', targetKey: target.key },
      lastMessage: '自动化目标已保存；当前引擎未运行，将在下次开始自动化时生效。',
    });
    return { ok: true, skipped: true, reason: 'engine_not_running' };
  }));
  const activeResults = results.filter((result) => !result.skipped);
  const rebound = activeResults.filter((result) => result.ok).length;
  return {
    ok: rebound === activeResults.length,
    accepted: activeResults.length,
    rebound,
    skipped: results.length - activeResults.length,
    failed: activeResults.length - rebound,
    results: targets.map((handle, index) => ({ envId: handle.envId, ...results[index] })),
    cloudEnv: target,
  };
});
// 悬浮「启动」：目标环境未跑则错峰启动；已在跑则不重复启动。
ipcMain.handle('edge:start', (_event, envId) => {
  const handle = resolveHandle(envId);
  if (handle) {
    handle.automationIntent = 'enabled';
    handle.engineStopReason = '';
    handle.resumeAfterStop = false;
    handle.automationPaused = false;
    handle.stopRequested = false;
  }
  if (handle && handle.child && (handle.coldStandbyActive || handle.coldStandbyPending || handle.controlPlaneOnly)) {
    wakeColdStandby(handle, 'user_start');
  } else if (handle && !handle.child) {
    queueStartEnv(handle);
  }
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
    scheduleSelectedProxyPreflight(envs.get(envId));
  }
  return fleetSnapshot();
});
// 运营别名一致写：先落本地并让 renderer 保持 pending，再以客户令牌写 Cloud；Cloud 或最终本地确认任一步失败，
// 都恢复原花名册并返回真实原因。空白表示清除运营别名，回落系统昵称影子。
ipcMain.handle('fleet:setManualNickname', async (_event, raw) => {
  const profileId = String((raw && raw.profileId) || '').trim();
  const nickname = String((raw && raw.nickname) || '').trim();
  if (!profileId) return { ok: false, error: '环境标识为空，未保存昵称。' };
  if (nickname.length > 80) return { ok: false, error: '环境昵称不能超过 80 个字符。' };

  const previousEnvironments = fleet.normalizeEnvironments(settings.environments || []);
  const index = previousEnvironments.findIndex((environment) => environment.profileId === profileId);
  if (index < 0) return { ok: false, error: '该环境不在运行花名册中，未保存昵称。' };
  if (clientAuthEnabled() && allowedProfileIds instanceof Set && !allowedProfileIds.has(profileId)) {
    return { ok: false, error: '当前账号无权修改该环境昵称。' };
  }
  if (!clientAuthEnabled() || !hasValidSession()) {
    if (clientAuthEnabled()) onSessionInvalid();
    return { ok: false, error: '登录已失效或客户服务未启用，昵称未保存。' };
  }

  const previousEnvironment = previousEnvironments[index];
  const handle = [...envs.values()].find((candidate) => candidate.profileId === profileId);
  const liveSystemName = String(
    (handle && handle.status && handle.status.account && handle.status.account.source !== 'env'
      && handle.status.account.name) || (handle && handle.systemName) || '',
  ).trim();
  const nextEnvironment = fleet.environmentWithOperatorAlias(previousEnvironment, nickname, liveSystemName);
  if (!nextEnvironment) return { ok: false, error: '环境记录无效，昵称未保存。' };
  const nextEnvironments = previousEnvironments.map((environment, envIndex) =>
    envIndex === index ? nextEnvironment : environment);
  const saved = saveSettings({ environments: nextEnvironments });
  if (!saved.ok) {
    broadcastFleet();
    return { ok: false, error: saved.error || '本地设置写入失败。', environment: previousEnvironment };
  }

  syncEnvHandles();
  const response = await clientAuthFetch(`/environments/${encodeURIComponent(profileId)}/operator-alias`, {
    method: 'PUT', token: clientSession.token, body: { alias: nickname || null }, timeoutMs: 12000,
  });
  if (response.status === 401) onSessionInvalid();
  if (!response.ok || !response.data || !response.data.data) {
    const restored = saveSettings({ environments: previousEnvironments });
    syncEnvHandles();
    const reason = response.data && (response.data.error || response.data.reason);
    return {
      ok: false,
      error: `${reason || response.error || '云端昵称更新失败'}${restored.ok ? '' : `；本地恢复也失败：${restored.error || '未知错误'}`}`,
      environment: previousEnvironment,
    };
  }

  const confirmed = response.data.data;
  const confirmedName = confirmed.displayNameSource !== 'account_id' && String(confirmed.displayName || '').trim()
    ? String(confirmed.displayName).trim()
    : String(nextEnvironment.systemName || '').trim();
  const confirmedEnvironment = nickname
    ? { ...nextEnvironment, name: confirmedName || nickname, nameSource: 'manual', nameSyncState: 'synced' }
    : { ...nextEnvironment, name: confirmedName || nextEnvironment.name || '' };
  if (!nickname) {
    delete confirmedEnvironment.nameSource;
    delete confirmedEnvironment.nameSyncState;
  }
  const confirmedEnvironments = previousEnvironments.map((environment, envIndex) =>
    envIndex === index ? confirmedEnvironment : environment);
  const confirmedSave = saveSettings({ environments: confirmedEnvironments });
  if (!confirmedSave.ok) {
    const rollbackAlias = previousEnvironment.nameSource === 'manual' ? previousEnvironment.name : null;
    const cloudRollback = await clientAuthFetch(`/environments/${encodeURIComponent(profileId)}/operator-alias`, {
      method: 'PUT', token: clientSession && clientSession.token, body: { alias: rollbackAlias }, timeoutMs: 12000,
    });
    const localRollback = saveSettings({ environments: previousEnvironments });
    syncEnvHandles();
    return {
      ok: false,
      error: `本地昵称确认写入失败：${confirmedSave.error || '未知错误'}；云端回滚${cloudRollback.ok ? '成功' : '失败'}；本地恢复${localRollback.ok ? '成功' : '失败'}。`,
      environment: previousEnvironment,
    };
  }
  syncEnvHandles();
  const renamedHandle = [...envs.values()].find((candidate) => candidate.profileId === profileId);
  if (renamedHandle) syncBrowserPersonaNotice(renamedHandle, true);
  return { ok: true, environment: confirmedEnvironment };
});
ipcMain.handle('fleet:startAll', (_event, opts) => startAllEnvs(opts || {}));
ipcMain.handle('fleet:stopAll', () => stopAllEnvs());
ipcMain.handle('fleet:closeAll', (_event, opts) => closeAllEnvs(opts || {}));
ipcMain.handle('fleet:setRailCollapsed', (_event, collapsed) => {
  saveSettings({ railCollapsed: Boolean(collapsed) });
  return { ok: true };
});
ipcMain.handle('persona:preview-facebook-template', (_event, selection) =>
  buildFacebookSelectedPersona(selection));
ipcMain.handle('persona:fill-facebook-selected', async (_event, soulYaml) => {
  if (!clientAuthEnabled() || !hasValidSession()) {
    if (clientAuthEnabled()) onSessionInvalid();
    return { ok: false, error: 'client_session_required', message: '登录状态已失效，请重新登录后再试。' };
  }
  const outcome = await requestFacebookSelectedPersonaFill({
    request: clientAuthFetch,
    token: clientSession.token,
    idempotencyKey: `fb-selected-persona-${crypto.randomUUID()}`,
    soulYaml,
  });
  if (outcome.sessionExpired) onSessionInvalid();
  if (outcome.accepted) return { ok: true, accepted: true };
  return {
    ok: false,
    error: outcome.sessionExpired ? 'client_session_required' : 'selected_persona_fill_not_accepted',
    message: outcome.warning || '云端未受理，请稍后重试。',
  };
});
ipcMain.handle('browser:openAdsDownload', () => {
  void shell.openExternal(ADS_DOWNLOAD_URL);
  return true;
});
ipcMain.handle('browser:showDriven', (_event, envId, opts) => {
  const handle = resolveHandle(envId);
  return opts && opts.keepClientForeground === true
    ? showDrivenBrowserBelowClient(handle)
    : sendBrowserParkingCommand(handle, 'browser.show');
});
ipcMain.handle('browser:resetParking', (_event, envId) => sendBrowserParkingCommand(resolveHandle(envId), 'browser.park'));
// 账号人设（change offline-account-persona-management）：这三条具名 IPC 只接收本地 envId，并在 main
// 权威换成 profileId/envKey 后直连 customer-auth。浏览器与环境 core 不参与，因此停止状态也能读写；
// 老 core 的 persona WS handler 继续保留，兼容尚未升级的客户端版本。
function personaIpcEnv(envId) {
  const requestedEnvId = envId == null || envId === '' ? null : interactionId(envId, 'envId');
  const handle = requestedEnvId ? envs.get(requestedEnvId) : selectedHandle();
  if (!handle || handle.removed || handle.kind !== 'adspower') throw new Error('当前环境不支持人设管理');
  if (!personaApplicable(handle)) {
    const error = new Error('视频号不适用账号人设');
    error.code = 'not_applicable';
    throw error;
  }
  const envKey = interactionId(handle.profileId, 'envKey');
  return { handle, envKey };
}

function personaIpcFailure(response) {
  const data = response && response.data;
  const nested = data && data.error && typeof data.error === 'object' ? data.error : null;
  const reason = data && typeof data.reason === 'string'
    ? data.reason
    : data && typeof data.error === 'string'
      ? data.error
      : nested && typeof nested.code === 'string'
        ? nested.code
        : response && response.status === 0
          ? 'cloud_unreachable'
          : 'request_failed';
  const message = nested && typeof nested.message === 'string' ? nested.message : undefined;
  return { ok: false, reason, ...(message ? { message } : {}) };
}

async function handlePersonaIpc(handler) {
  try {
    return await handler();
  } catch (error) {
    return {
      ok: false,
      reason: error && error.code === 'not_applicable' ? 'not_applicable' : 'invalid_request',
      message: String((error && error.message) || error || '参数不合法'),
    };
  }
}

ipcMain.handle('persona:get', (_event, envId) => handlePersonaIpc(async () => {
  const { envKey } = personaIpcEnv(envId);
  const response = await interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/persona`,
  });
  if (!response.ok) return personaIpcFailure(response);
  const data = response.data && response.data.data;
  if (!data || (data.state !== 'missing' && data.state !== 'configured')) {
    return { ok: false, reason: 'response_invalid' };
  }
  return { ok: true, state: data.state, persona: data.persona || null };
}));

ipcMain.handle('persona:generate', (_event, envId, raw) => handlePersonaIpc(async () => {
  const args = interactionArgs(raw, new Set(['keywordSelections', 'writingLanguage', 'idempotencyKey']));
  const keywordValidation = validatePersonaKeywordSelections(args.keywordSelections);
  if (!keywordValidation.ok) return keywordValidation;
  const idempotencyKey = interactionIdempotencyKey(args.idempotencyKey);
  if (args.writingLanguage !== undefined && !['zh-CN', 'en', 'vi'].includes(args.writingLanguage)) {
    throw new Error('writingLanguage 不合法');
  }
  const { envKey } = personaIpcEnv(envId);
  const body = {
    keywordSelections: args.keywordSelections,
    ...(args.writingLanguage === undefined ? {} : { writingLanguage: args.writingLanguage }),
  };
  const response = await interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/persona/draft`,
    method: 'POST',
    body,
    idempotencyKey,
    timeoutMs: 200000,
  });
  if (!response.ok) return personaIpcFailure(response);
  const draft = response.data && response.data.data && response.data.data.draft;
  if (!draft || typeof draft.soulYaml !== 'string') return { ok: false, reason: 'response_invalid' };
  return { ok: true, soulYaml: draft.soulYaml, identitySummary: draft.identitySummary, summary: draft.summary };
}));

ipcMain.handle('persona:persist', (_event, envId, raw) => handlePersonaIpc(async () => {
  const args = interactionArgs(raw, new Set(['soulYaml']));
  if (typeof args.soulYaml !== 'string' || !args.soulYaml.trim()
      || Buffer.byteLength(args.soulYaml, 'utf8') > 32 * 1024) throw new Error('soulYaml 不合法');
  const { handle, envKey } = personaIpcEnv(envId);
  const response = await interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/persona`,
    method: 'PUT',
    body: { soulYaml: args.soulYaml },
  });
  if (!response.ok) return personaIpcFailure(response);
  const data = response.data && response.data.data;
  if (!data || data.state !== 'configured' || !data.persona) return { ok: false, reason: 'response_invalid' };
  updateStatus(handle, { personaBound: true });
  return {
    ok: true,
    state: data.state,
    persona: data.persona,
    firstPostOnboarding: data.firstPostOnboarding === true,
  };
}));
// 客户端审批是 Cloud 决策写，不是页面发布动作。renderer 只提交 envId + 窄 DTO；main 用客户会话和
// Cloud 权威 envKey→accountId 绑定直连 customer-auth。核心、浏览器、CDP 与槽位均不参与。
// 老版本 core 的 publish.approval_action WS handler 保留给兼容客户端，但新版桌面不再以核心是否在跑为前置。
ipcMain.handle('publish:approval', (_event, envId, payload) => handlePersonaIpc(async () => {
  const requestId = String(payload && payload.requestId || '').trim();
  const approved = payload && payload.approved;
  const contentVersion = payload && payload.contentVersion;
  if (!/^publish-\d+$/.test(requestId) || typeof approved !== 'boolean') {
    return { ok: false, reason: 'invalid_request' };
  }
  if (contentVersion !== undefined && (!Number.isInteger(contentVersion) || contentVersion < 0)) {
    return { ok: false, reason: 'invalid_version' };
  }
  const hasPublishMode = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'publishMode'));
  const hasPublishTime = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'publishTime'));
  if (!approved && (hasPublishMode || hasPublishTime)) return { ok: false, reason: 'invalid_request' };
  if (hasPublishMode !== hasPublishTime) return { ok: false, reason: 'invalid_publish_plan' };
  if (hasPublishMode) {
    const publishMode = payload.publishMode;
    const publishTime = payload.publishTime;
    if ((publishMode !== 'immediate' && publishMode !== 'scheduled')
      || (publishMode === 'immediate' && publishTime !== null)
      || (publishMode === 'scheduled' && (typeof publishTime !== 'number' || !Number.isFinite(publishTime)))) {
      return { ok: false, reason: 'invalid_publish_plan' };
    }
  }
  const { envKey } = personaIpcEnv(envId);
  const body = {
    requestId,
    approved,
    contentVersion: contentVersion === undefined ? 0 : contentVersion,
    ...(hasPublishMode ? { publishMode: payload.publishMode, publishTime: payload.publishTime } : {}),
  };
  const response = await interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/publish/approval`,
    method: 'POST',
    body,
  });
  if (!response.ok) return personaIpcFailure(response);
  const data = response.data && response.data.data;
  if (!data || data.envKey !== envKey || data.requestId !== requestId || data.ok !== true
      || (data.receipt !== 'accepted_pending_execution' && data.receipt !== 'rejected')) {
    return { ok: false, reason: 'response_invalid' };
  }
  return data;
}));
// 预览内删除某张配图（change client-preview-image-delete）。云端才是权限 / 版本 / 只删不注入 /
// 最后一张不可删的权威；这里只做入参形状校验 + 成功后就地刷新预览真态。
ipcMain.handle('publish:image-remove', (_event, envId, payload) => handlePersonaIpc(async () => {
  const requestId = String((payload && payload.requestId) || '').trim();
  const imageUrl = typeof (payload && payload.imageUrl) === 'string' ? payload.imageUrl.trim() : '';
  const contentVersion = payload && payload.contentVersion;
  if (!/^publish-\d+$/.test(requestId) || !imageUrl) {
    return { ok: false, reason: 'invalid_request' };
  }
  if (!Number.isInteger(contentVersion) || contentVersion < 0) {
    return { ok: false, reason: 'invalid_version' };
  }
  const { envKey } = personaIpcEnv(envId);
  const response = await interactionCustomerRequest({
    envKey,
    pathname: `/environments/${encodeURIComponent(envKey)}/publish/draft-image-remove`,
    method: 'POST',
    body: { requestId, contentVersion, imageUrl },
  });
  if (!response.ok) return personaIpcFailure(response);
  const result = response.data && response.data.data;
  if (!result || result.envKey !== envKey || result.requestId !== requestId || result.ok !== true
      || !Array.isArray(result.images) || !Number.isInteger(result.contentVersion)) {
    return { ok: false, reason: 'response_invalid' };
  }
  if (result && result.ok) {
    const recordId = Number(requestId.slice('publish-'.length));
    applyPublishPreviewImages(envId, recordId, result.images, result.contentVersion);
  }
  return result;
}));

async function delegatedTaskRequest(envId, pathname, options = {}) {
  const handle = resolveHandle(envId);
  if (!handle || !handle.profileId) return { ok: false, status: 400, error: 'selected_environment_required' };
  if (!clientAuthEnabled()) return { ok: false, status: 401, error: 'client_session_required' };
  if (!hasValidSession()) {
    onSessionInvalid();
    return { ok: false, status: 401, error: 'client_session_expired' };
  }
  const suffix = pathname.includes('?') ? '&' : '?';
  const scopedPath = options.includeEnvQuery
    ? `${pathname}${suffix}envKey=${encodeURIComponent(handle.profileId)}`
    : pathname;
  const r = await clientAuthFetch(scopedPath, {
    method: options.method || 'GET',
    token: clientSession.token,
    ...(options.body && options.includeEnvBody !== false
      ? { body: { ...options.body, envKey: handle.profileId } }
      : {}),
    ...(options.body && options.includeEnvBody === false
      ? { body: { ...options.body } }
      : {}),
  });
  if (r.status === 401) {
    onSessionInvalid();
    return { ok: false, status: 401, error: 'client_session_expired' };
  }
  if (!r.ok) {
    const responseError = r.data && r.data.error;
    return {
      ok: false,
      status: r.status,
      error: (r.data && r.data.message)
        || (typeof responseError === 'string' ? responseError : responseError && responseError.message)
        || r.error
        || 'request_failed',
      ...((r.data && typeof r.data.reason === 'string')
        ? { reason: r.data.reason }
        : typeof responseError === 'string'
          ? { reason: responseError }
          : (responseError && typeof responseError.code === 'string') ? { reason: responseError.code } : {}),
    };
  }
  return { ok: true, status: r.status, data: r.data };
}

ipcMain.handle('delegated-task:list', (_event, envId) =>
  delegatedTaskRequest(envId, '/delegated-tasks', { includeEnvQuery: true }));

ipcMain.handle('delegated-task:draft', (_event, envId, payload) =>
  delegatedTaskRequest(envId, '/delegated-tasks/draft', { method: 'POST', body: payload || {} }));

ipcMain.handle('delegated-task:action', (_event, envId, taskId, action, version) => {
  const allowed = new Set(['confirm', 'pause', 'resume', 'cancel']);
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId || !allowed.has(action)) return { ok: false, status: 400, error: 'invalid_task_action' };
  return delegatedTaskRequest(
    envId,
    `/delegated-tasks/${encodeURIComponent(normalizedTaskId)}/${action}`,
    { method: 'POST', body: Number.isInteger(version) ? { version } : {} },
  );
});

// 待审批稿只开放具名只读 IPC；envKey 仍由 main 从所选环境注入。
ipcMain.handle('publish-draft:list', (_event, envId, options) => {
  const raw = options && typeof options === 'object' ? options : {};
  const limit = raw.limit === undefined ? 12 : raw.limit;
  const offset = raw.offset === undefined ? 0 : raw.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50
    || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    return { ok: false, status: 400, error: 'invalid_publish_draft_pagination' };
  }
  return delegatedTaskRequest(
    envId,
    `/publish-drafts?limit=${limit}&offset=${offset}`,
    { includeEnvQuery: true },
  );
});

ipcMain.handle('publish-draft:get', (_event, envId, id) => {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'invalid_publish_draft_id' };
  return delegatedTaskRequest(envId, `/publish-drafts/${id}`, { includeEnvQuery: true });
});

// 待审稿编辑与 AI 调整只接受白名单 DTO。路径、envKey、客户令牌与账号绑定仍由 main/Cloud 权威注入。
ipcMain.handle('publish-draft:edit', (_event, envId, id, payload) => {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'invalid_publish_draft_id' };
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const allowed = new Set(['expectedVersion', 'title', 'content', 'topics']);
  const keys = raw ? Object.keys(raw) : [];
  const patchKeys = keys.filter((key) => key !== 'expectedVersion');
  if (!raw || keys.some((key) => !allowed.has(key)) || patchKeys.length === 0
      || !Number.isInteger(raw.expectedVersion) || raw.expectedVersion < 0
      || (raw.title !== undefined && (typeof raw.title !== 'string' || !raw.title.trim()))
      || (raw.content !== undefined && (typeof raw.content !== 'string' || !raw.content.trim()))
      || (raw.topics !== undefined && (!Array.isArray(raw.topics) || !raw.topics.every((topic) => typeof topic === 'string')))) {
    return { ok: false, status: 400, error: 'invalid_publish_draft_edit' };
  }
  const handle = resolveHandle(envId);
  if (!handle || !handle.profileId) return { ok: false, status: 400, error: 'selected_environment_required' };
  return delegatedTaskRequest(
    envId,
    `/environments/${encodeURIComponent(handle.profileId)}/publish-drafts/${id}`,
    { method: 'PATCH', body: raw, includeEnvBody: false },
  );
});

ipcMain.handle('publish-draft:refine', (_event, envId, id, payload) => {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'invalid_publish_draft_id' };
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const allowed = new Set(['expectedVersion', 'scope', 'instruction', 'selection']);
  const scopes = new Set(['whole', 'body', 'images', 'selected_image', 'selected_text']);
  const instruction = typeof raw?.instruction === 'string' ? raw.instruction.trim() : '';
  const selection = raw?.selection;
  const selectedTextValid = raw?.scope !== 'selected_text'
    || (selection && typeof selection === 'object' && !Array.isArray(selection)
      && Object.keys(selection).every((key) => ['start', 'end', 'text'].includes(key))
      && Number.isInteger(selection.start) && Number.isInteger(selection.end)
      && selection.start >= 0 && selection.end > selection.start && typeof selection.text === 'string');
  const selectedImageValid = raw?.scope !== 'selected_image'
    || (selection && typeof selection === 'object' && !Array.isArray(selection)
      && Object.keys(selection).length === 1 && typeof selection.imageUrl === 'string' && Boolean(selection.imageUrl.trim()));
  const selectionForbidden = raw && raw.scope !== 'selected_text' && raw.scope !== 'selected_image'
    && raw.selection !== undefined && raw.selection !== null;
  if (!raw || Object.keys(raw).some((key) => !allowed.has(key))
      || !Number.isInteger(raw.expectedVersion) || raw.expectedVersion < 0
      || !scopes.has(raw.scope) || !instruction || instruction.length > 1000
      || !selectedTextValid || !selectedImageValid || selectionForbidden) {
    return { ok: false, status: 400, error: 'invalid_publish_draft_refinement' };
  }
  const handle = resolveHandle(envId);
  if (!handle || !handle.profileId) return { ok: false, status: 400, error: 'selected_environment_required' };
  return delegatedTaskRequest(
    envId,
    `/environments/${encodeURIComponent(handle.profileId)}/publish-drafts/${id}/refinements`,
    { method: 'POST', body: { ...raw, instruction }, includeEnvBody: false },
  );
});

ipcMain.handle('publish-draft:refinement-get', (_event, envId, id, jobId = 'latest') => {
  const key = String(jobId || '').trim();
  if (!Number.isInteger(id) || id <= 0
      || (key !== 'latest' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))) {
    return { ok: false, status: 400, error: 'invalid_publish_draft_refinement_target' };
  }
  const handle = resolveHandle(envId);
  if (!handle || !handle.profileId) return { ok: false, status: 400, error: 'selected_environment_required' };
  return delegatedTaskRequest(
    envId,
    `/environments/${encodeURIComponent(handle.profileId)}/publish-drafts/${id}/refinements/${encodeURIComponent(key)}`,
  );
});

// 当前账号已被平台接受的定时小时；路径、客户令牌、envKey 与账号绑定均由 main/Cloud 收口。
ipcMain.handle('publish-schedule:occupied-hours', (_event, envId) =>
  delegatedTaskRequest(envId, '/publish-schedule/occupied-hours', { includeEnvQuery: true }));

// 客户首页概览只走 customer-auth HTTP：main 由本地 envId 解析 profileId，renderer 无法提交 URL/token/accountId。
// 这条读不检查 core、自动化连接或浏览器状态；这些运行组件不属于常规客户数据面的前置条件。
ipcMain.handle('environment-overview:get', (_event, envId) => {
  const handle = resolveHandle(envId);
  if (!handle || !handle.profileId) return { ok: false, status: 400, error: 'selected_environment_required' };
  return delegatedTaskRequest(
    envId,
    `/environments/${encodeURIComponent(handle.profileId)}/overview`,
  );
});

// 当前小红书环境账号的只读生效排期。renderer 只能给本地 envId；main 固定 customer-auth 路径，
// 不接受 URL/token/accountId，也不检查浏览器/core/自动化连接是否在线。
ipcMain.handle('environment-schedule:get', (_event, envId) => {
  const handle = resolveHandle(envId);
  if (!handle || !handle.profileId) return { ok: false, status: 400, error: 'selected_environment_required' };
  return delegatedTaskRequest(
    envId,
    `/environments/${encodeURIComponent(handle.profileId)}/schedule`,
  );
});

// 小红书发布队列走固定的 env-scoped customer-auth 路径；普通读取和取消均不依赖 core/浏览器在线。
ipcMain.handle('publish-queue:get', (_event, envId) => {
  const handle = resolveHandle(envId);
  if (!handle || !handle.profileId) return { ok: false, status: 400, error: 'selected_environment_required' };
  return delegatedTaskRequest(
    envId,
    `/environments/${encodeURIComponent(handle.profileId)}/publish-queue`,
  );
});

ipcMain.handle('publish-queue:cancel', (_event, envId, taskId, version) => {
  const handle = resolveHandle(envId);
  const normalizedTaskId = String(taskId || '').trim();
  if (!handle || !handle.profileId) return { ok: false, status: 400, error: 'selected_environment_required' };
  if (!normalizedTaskId || normalizedTaskId.length > 256 || /[\u0000-\u001f\u007f]/.test(normalizedTaskId)
      || !Number.isInteger(version) || version < 0) {
    return { ok: false, status: 400, error: 'invalid_publish_queue_cancel' };
  }
  return delegatedTaskRequest(
    envId,
    `/environments/${encodeURIComponent(handle.profileId)}/publish-queue/tasks/${encodeURIComponent(normalizedTaskId)}/cancel`,
    { method: 'POST', body: { version }, includeEnvBody: false },
  );
});

// 当前账号灵感库：四个具名 IPC 锁死 customer-auth 路径和方法；envId 只用于主进程查 profileId，
// renderer 不得提交 accountId/envKey/URL/token。所有参数先做窄形状校验，再复用逐请求归属校验出口。
ipcMain.handle('curated:summary', (_event, envId) =>
  delegatedTaskRequest(envId, '/curated-contents?mode=all&limit=1&offset=0', { includeEnvQuery: true }));

ipcMain.handle('curated:list', (_event, envId, options) => {
  const raw = options && typeof options === 'object' ? options : {};
  const mode = raw.mode === 'all'
    ? 'all'
    : raw.mode === 'created'
      ? 'created'
      : raw.mode === 'uncreated' || raw.mode === undefined
        ? 'uncreated'
        : null;
  const sort = raw.sort === 'weighted'
    ? 'weighted'
    : raw.sort === 'collects'
      ? 'collects'
      : raw.sort === 'likes'
        ? 'likes'
        : raw.sort === 'recent' || raw.sort === undefined
          ? (raw.sort || 'weighted')
          : null;
  const limit = raw.limit === undefined ? 20 : raw.limit;
  const offset = raw.offset === undefined ? 0 : raw.offset;
  if (!sort) return { ok: false, status: 400, error: 'invalid_curated_sort' };
  if (!mode || !Number.isInteger(limit) || limit < 1 || limit > 50
    || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    return { ok: false, status: 400, error: 'invalid_curated_pagination' };
  }
  const pathname = `/curated-contents?mode=${mode}&sort=${sort}&limit=${limit}&offset=${offset}`;
  return delegatedTaskRequest(envId, pathname, { includeEnvQuery: true });
});

ipcMain.handle('curated:get', (_event, envId, id) => {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'invalid_curated_id' };
  return delegatedTaskRequest(envId, `/curated-contents/${id}`, { includeEnvQuery: true });
});

ipcMain.handle('curated:create-post', (_event, envId, id, useReferenceImages) => {
  if (!Number.isInteger(id) || id <= 0 || typeof useReferenceImages !== 'boolean') {
    return { ok: false, status: 400, error: 'invalid_curated_create_request' };
  }
  return delegatedTaskRequest(
    envId,
    `/curated-contents/${id}/create-post`,
    { method: 'POST', body: { useReferenceImages } },
  );
});

ipcMain.handle('notify:show', (_event, payload) => {
  const title = payload && typeof payload.title === 'string' ? payload.title : 'AIDCP Edge';
  const body = payload && typeof payload.body === 'string' ? payload.body : '';
  surfaceNotification(title, body);
  return { ok: true };
});
// AdsPower 只读探测 / 拉取（主进程侧，渲染层不直连本地 API）。opts 可带渲染层当前表单 apiKey/apiBase/groupId。
ipcMain.handle('ads:status', (_event, opts) => readAdsWithRuntime(opts, (resolved) => adsApi.status(resolved)));
// 「选择已有环境」与 status 共享 cached-base fast path；仅冷机/传输失败时启动或重启随包运行时。
ipcMain.handle('ads:listProfiles', async (_event, opts) => {
  const result = await readAdsWithRuntime(opts, (resolved) => adsApi.listProfiles(resolved));
  // 按登录客户可见范围收窄「加入现有环境」**显示列表**（change edge-client-env-scope-and-logout，补 edge-client-customer-auth
  // 的漏）：此前该列表列出本机全部指纹环境、不分归属，把他人环境的名字/分组/代理/分身 ID 暴露给已登录客户，也让用户误加入
  // 永不启动的非归属环境。
  //   铁律（fail-closed，绝不 fail-open）：客户鉴权启用时 MUST NOT 把本机全量列表回给已登录客户——只有两种安全出口：
  //   ① 会话有效 → 先刷新可见集（用户点「刷新」的语义就是拉最新，后台刚分配的环境应即时出现），再按 allowedProfileIds
  //      收窄显示（语义与 syncEnvHandles 逐字对齐：Set 含空集=只显示零个，绝不因缺数据回落全量泄漏他人）。
  //   ② 会话已失效 / 刷新 401 / 刷新中会话翻失效（allowedProfileIds 被置 null）→ 诚实登出并回 {ok:false}，绝不回落全量。
  //      注意：令牌到期但未被清理时 hasValidSession() 为假而 allowedProfileIds 可能仍是旧 Set，若按「有 Set 就过滤」会
  //      放过这条 → 故这里对「gated 且无有效会话」一律登出，不复用旧集。
  //   只收窄**显示**：另带 physicalUserIds（本机物理存在的全部分身 id）给渲染层做孤儿剔除，令「云端降范围但本机仍在」的
  //   环境不被误当云端已删而销毁花名册项（物理删除才剔、降范围不剔）。null（未 gated）不收窄=零回归；ok:false 原样透传。
  if (result && result.ok && clientAuthEnabled()) {
    if (!hasValidSession()) { onSessionInvalid(); return { ok: false, error: '登录已失效，请重新登录客户端。' }; }
    const ok = await refreshAllowedEnvironments(); // 顺带拉最新可见集；401 → false
    if (!ok || !(allowedProfileIds instanceof Set)) { onSessionInvalid(); return { ok: false, error: '登录已失效，请重新登录客户端。' }; }
    // physicalUserIds 供渲染层孤儿剔除按物理存在判定，但**收窄到「渲染层已合法知晓的 id」= 花名册成员 ∪ 归属集**：
    // 绝不把他人环境的分身 id 透过 IPC 回渲染层（多租户同机时 result.profiles 此刻还是本机全量，直接 map 会带出他人 id；
    // 他人 id 一旦到渲染层，配合未按归属设闸的写出口即可删/改他人环境——写侧归属属既有缺口、专项跟进，本处先不新增泄漏面）。
    // foreign id 不在 roster/allowed、本就不与花名册成员相撞、不影响剔孤儿；降范围但本机仍在的环境仍在 roster 里、故不被误剔（保 MAJOR-2 修复）。
    const knownIds = new Set(allowedProfileIds);
    for (const e of settings.environments || []) { if (e && e.profileId) knownIds.add(e.profileId); }
    for (const pending of settings.pendingInteractionOffboards || []) knownIds.add(pending.envKey);
    result.physicalUserIds = (result.profiles || []).map((p) => p && p.userId).filter((id) => id && knownIds.has(id));
    result.profiles = (result.profiles || [])
      .filter((p) => p && (allowedProfileIds.has(p.userId) || Boolean(pendingOffboardForEnv(p.userId))))
      .map((p) => {
        const pending = pendingOffboardForEnv(p.userId);
        return pending ? { ...p, offboardPending: { state: pending.state, offboardId: pending.offboardId } } : p;
      });
    // 只在有效会话 + 权威归属刷新 + 本机列表收窄完成后给 renderer 这个可信信号。
    result.assignmentScoped = true;
  }
  return result;
});
ipcMain.handle('ads:openCreate', () => openAdsClient());

// ── 「创建环境」程序化建号（change adspower-auto-create-env）：写客户端 allowlist + 指纹引擎 + 编排 ──
const envGroupResolver = createEnvGroupResolver({ adsApi, groupName: ENV_GROUP_NAME });
let adsCreateInFlight = false; // 进程级单飞互斥（防连点双建）
let adsProxyWriteInFlight = false; // 单项/批量改代理共用单飞；不与创建交错写 AdsPower

function osFamilyLabel(t) {
  return t.label || (t.os === 'windows' ? 'Windows' : t.os === 'macos' ? 'macOS' : t.os);
}

// Back-compatible IPC name: the renderer consumes OS families through the old templates hook.
ipcMain.handle('ads:templates', () =>
  adsFingerprint.OS_FAMILIES.map((t) => ({ key: t.key, label: osFamilyLabel(t) })),
);

function safeCreatedEnvironment(finalized) {
  return {
    userId: finalized.userId,
    name: finalized.name,
    template: finalized.template,
    osFamily: finalized.osFamily,
    platform: finalized.platform,
    assignedToCurrentClient: finalized.assignedToCurrentClient,
    requiresAdminAssignment: finalized.requiresAdminAssignment,
    assignmentHandledByMain: finalized.assignmentHandledByMain,
    rosterJoinedByMain: finalized.rosterJoinedByMain,
    ...(typeof finalized.slowStartConfigured === 'boolean'
      ? { slowStartConfigured: finalized.slowStartConfigured }
      : {}),
    visibilityWarning: finalized.visibilityWarning,
  };
}

// 程序化建指纹环境。单建 opts: { osFamilyKey, platform, proxy?, facebookAccountImport? }；
// Facebook 批量另带 { creationMode:'batch', batchProxyType, facebookProxyBatch }。
ipcMain.handle('ads:createEnv', async (_event, opts) => {
  if (adsCreateInFlight || adsProxyWriteInFlight) return { ok: false, error: '环境写入进行中，请等当前操作完成' };
  adsCreateInFlight = true;
  try {
    const platform = normalizePlatform(opts && opts.platform);
    const creationMode = opts && opts.creationMode === 'batch' ? 'batch' : 'single';
    // 慢启动是 Facebook 专属的环境级每日额度约束；XHS / 视频号不提交这个概念。
    const slowStartEnabled = platform === 'facebook';
    if (creationMode === 'batch' && platform !== 'facebook') {
      return { ok: false, error: '批量新建当前仅支持 Facebook 环境' };
    }
    const importText = platform === 'facebook' ? (opts && opts.facebookAccountImport) : '';
    const parsedImport = parseFacebookAccountImport(importText);
    if (!parsedImport.ok) return { ok: false, error: parsedImport.error };
    const entries = parsedImport.entries || [];
    if (creationMode === 'single' && entries.length > 1) {
      return { ok: false, error: '单个新建只允许一条 Facebook 账号资料；多条请切换到「批量新建」' };
    }

    let batchPlan = null;
    if (creationMode === 'batch') {
      batchPlan = createFacebookBatchPlan({
        accountEntries: entries,
        proxyType: opts && opts.batchProxyType,
        proxyText: opts && opts.facebookProxyBatch,
        osFamilyKeys: adsFingerprint.OS_FAMILIES.map((family) => family.key),
      });
      if (!batchPlan.ok) return { ok: false, error: batchPlan.error };
    }

    // 环境创建数量与运行容量彻底解耦：浏览器并发只限制执行数，启动排队上限只限制启动/唤醒请求。
    // 单建和批量创建都不得在写入前拿运行容量做硬拒绝。

    // 先确保指纹浏览器服务就绪（仅服务、不下内核）——冷机不再裸抛 LocalAPI fetch failed。
    const svc = await ensureAdsServiceOnce(null);
    if (!svc.ok) {
      return { ok: false, error: `指纹浏览器运行时未就绪：${svc.error || '未知错误'}`, retryable: true };
    }
    const ads = resolveAdsOpts(opts);
    // 凭据只内存（deps），绝不落 settings；写客户端错误层已脱敏。
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    if (creationMode === 'single' && entries.length === 0) {
      const intent = await createEnvironmentProvisioningIntent();
      if (!intent.ok) return { ok: false, error: `${intent.error}，本次尚未创建本地环境。` };
      const result = await createEnvironmentWithGroupRecovery({
        writeApi,
        adsApi,
        fingerprint: adsFingerprint,
        adsOpts: ads,
        osFamilyKey: (opts && (opts.osFamilyKey || opts.templateKey)) || '',
        intendedAccountLabel: opts && opts.intendedAccountLabel,
        machineLabel: os.hostname(),
        platform,
        proxy: opts && opts.proxy, // 原始表单输入；归一/校验在 create-flow 的归一层做
        groupResolver: envGroupResolver,
      });
      if (result && result.ok) {
        return finalizeCreatedEnvironmentAssignment(result, intent, { slowStartEnabled });
      }
      return result;
    }

    const plan = creationMode === 'batch'
      ? batchPlan.plan
      : [{
          accountImport: entries[0],
          accountLine: 1,
          osFamilyKey: (opts && (opts.osFamilyKey || opts.templateKey)) || '',
          proxy: opts && opts.proxy,
        }];
    const created = [];
    for (let i = 0; i < plan.length; i += 1) {
      const item = plan[i];
      const intent = await createEnvironmentProvisioningIntent();
      if (!intent.ok) {
        return failedFacebookBatchReceipt(created, i + 1, `${intent.error}，该账号尚未创建本地环境`);
      }
      const result = await createEnvironmentWithGroupRecovery({
        writeApi,
        adsApi,
        fingerprint: adsFingerprint,
        adsOpts: ads,
        osFamilyKey: item.osFamilyKey,
        intendedAccountLabel: '',
        machineLabel: os.hostname(),
        platform,
        name: profileNameForFacebookImport(item.accountImport, i),
        accountImport: item.accountImport,
        proxy: item.proxy,
        groupResolver: envGroupResolver,
      });
      if (!result.ok) {
        return failedFacebookBatchReceipt(created, i + 1, result.error || '未知错误');
      }
      const finalized = await finalizeCreatedEnvironmentAssignment(result, intent, { slowStartEnabled });
      created.push(safeCreatedEnvironment(finalized));
    }
    const assignmentHandledByMain = clientAuthEnabled();
    const unassigned = assignmentHandledByMain
      ? created.filter((item) => item.requiresAdminAssignment || !item.rosterJoinedByMain)
      : [];
    const slowStartConfigured = platform === 'facebook'
      ? created.length > 0 && created.every((item) => item.slowStartConfigured === true)
      : undefined;
    const receipt = {
      ok: true,
      userId: creationMode === 'single' && created.length === 1 ? created[0].userId : undefined,
      // 单账号导入自动选中时带回真名，供渲染层入册用真名（change edge-env-name-live-sync）。
      name: creationMode === 'single' && created.length === 1 ? created[0].name : undefined,
      template: creationMode === 'single' && created.length === 1 ? (created[0].template || created[0].osFamily) : undefined,
      osFamily: creationMode === 'single' && created.length === 1 ? (created[0].osFamily || created[0].template) : undefined,
      platform,
      creationMode,
      created,
      createdCount: created.length,
      assignedToCurrentClient: assignmentHandledByMain ? unassigned.length === 0 : undefined,
      requiresAdminAssignment: created.some((item) => item.requiresAdminAssignment),
      assignmentHandledByMain,
      rosterJoinedByMain: assignmentHandledByMain ? unassigned.length === 0 : undefined,
      ...(platform === 'facebook' ? { slowStartConfigured } : {}),
      ...(unassigned.length > 0 ? {
        visibilityWarning: `${created.length - unassigned.length}/${created.length} 个环境已分配并加入运行环境；其余环境未完成权威确认，未加入运行环境且慢启动未确认。`,
      } : platform === 'facebook' && !slowStartConfigured ? {
        visibilityWarning: '环境已在本机创建，但 Facebook 慢启动未全部完成 Cloud 权威确认。',
      } : {}),
    };
    return receipt;
  } catch (e) {
    return { ok: false, error: `创建失败：${(e && e.message) || String(e)}` };
  } finally {
    adsCreateInFlight = false;
  }
});

// 精确读取一个环境的完整代理配置供编辑浮层回填。全量 ads:listProfiles 继续不含密码；客户模式
// 必须在当前有效会话的权威环境范围内，避免 renderer 用任意 userId 读取他人代理凭据。
ipcMain.handle('ads:getEnvProxy', async (_event, opts) => {
  const scope = await proxyTargetScope([opts && opts.userId]);
  if (!scope.ok) return { ...scope, status: scope.error && scope.error.includes('不属于') ? 403 : undefined };
  const userId = scope.userIds[0];
  return readAdsWithRuntime(opts, (resolved) => adsApi.getProfileProxyConfig({
    ...resolved,
    profileId: userId,
  }));
});

async function proxyTargetScope(userIds) {
  const initial = validateProxyTargetScope({ userIds, authEnabled: false });
  if (!initial.ok || !clientAuthEnabled()) return initial;
  if (!hasValidSession()) {
    onSessionInvalid();
    return { ok: false, error: '登录已失效，请重新登录客户端。' };
  }
  const refreshed = await refreshAllowedEnvironments();
  if (!refreshed || !(allowedProfileIds instanceof Set)) {
    onSessionInvalid();
    return { ok: false, error: '登录已失效，请重新登录客户端。' };
  }
  return validateProxyTargetScope({
    userIds: initial.userIds,
    authEnabled: true,
    sessionValid: hasValidSession(),
    allowedProfileIds,
  });
}

function proxyTargetActive(userId) {
  const handle = envs.get(fleet.envIdForProfile(String(userId)));
  return Boolean(handle && !handle.removed && (
    handle.child
    || handle.startQueueReserved
    || handle.startFlowQueued
    || handle.launchQueued
    || handle.slotWaitingSince
    || handle.controlPlaneStarting
    || handle.browserOpenPending
    || handle.coldStandbyWaking
  ));
}

function proxyUpdateError(result) {
  if (result && result.ok === false && /being used|being opened|is open|正在使用|已打开/i.test(String(result.error || ''))) {
    return '该环境正在使用中，无法修改代理；请先关闭该环境后重试。';
  }
  return (result && result.error) || '未知错误';
}

function batchProxyUpdateError(result) {
  const friendly = proxyUpdateError(result);
  if (/being used|being opened|is open|正在使用|已打开/i.test(friendly)) return friendly;
  if (result && result.code != null) return `AdsPower 拒绝代理更新（code=${result.code}）`;
  if (/服务不可达|响应非 JSON|HTTP\s*\d+/i.test(friendly)) return friendly;
  // AdsPower msg 是外部字符串，不能假设它绝不回显请求内容；批量回执宁可收窄为通用原因。
  return 'AdsPower 未接受代理更新';
}

function batchProxyProgressRequestId(opts) {
  const value = String((opts && opts.requestId) || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(value) ? value : '';
}

function emitBatchProxyProgress(event, requestId, completedCount, totalCount) {
  try {
    if (!event || !event.sender || event.sender.isDestroyed()) return;
    event.sender.send('ads:envProxyBatchProgress', { requestId, completedCount, totalCount });
  } catch {
    // renderer 关闭或订阅失败不改变已经确认的代理写入结果。
  }
}

function invalidateProxyEvidence(userId) {
  const envId = fleet.envIdForProfile(String(userId));
  proxyPreflight.invalidate(envId);
  const handle = envs.get(envId);
  if (handle && selectedEnvId === envId) scheduleSelectedProxyPreflight(handle);
}

// 快速粘贴只走具名纯解析 IPC；结果仍须经保存/批量写入口重新校验，绝不把 preview 当授权。
ipcMain.handle('ads:parseProxyLines', (_event, input) => parseProxyLines({
  proxyType: input && input.proxyType,
  proxyText: input && input.proxyText,
}));

// 改已有环境代理（edge-client-proxy-platform-persona-ux）：归属门禁 + 归一层校验 → 受限 user/update。
ipcMain.handle('ads:updateEnvProxy', async (_event, opts) => {
  const norm = normalizeProxyInput((opts && opts.proxy) || {});
  if (!norm.ok) return { ok: false, error: `代理输入不合法：${norm.error}` };
  if (adsProxyWriteInFlight || adsCreateInFlight) {
    return { ok: false, error: '环境写入进行中，请等当前操作完成。' };
  }
  adsProxyWriteInFlight = true;
  try {
    const scope = await proxyTargetScope([opts && opts.userId]);
    if (!scope.ok) return scope;
    const userId = scope.userIds[0];
    if (proxyTargetActive(userId)) {
      return { ok: false, error: '该环境正在使用中，无法修改代理；请先关闭该环境后重试。' };
    }
    const svc = await ensureAdsServiceOnce(null);
    if (!svc.ok) return { ok: false, error: `指纹浏览器运行时未就绪：${svc.error || '未知错误'}`, retryable: true };
    const ads = resolveAdsOpts(opts);
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    const r = await writeApi.updateProfileProxy({ userId: String(userId), proxyConfig: norm.proxyConfig }, ads);
    if (r && r.ok === false) return { ...r, error: proxyUpdateError(r) };
    if (r && r.ok) {
      invalidateProxyEvidence(userId);
      return { ok: true, noProxy: norm.noProxy };
    }
    return r;
  } catch (e) {
    return { ok: false, error: `修改代理失败：${(e && e.message) || String(e)}` };
  } finally {
    adsProxyWriteInFlight = false;
  }
});

ipcMain.handle('ads:updateEnvProxies', async (event, opts) => {
  const requestId = batchProxyProgressRequestId(opts);
  if (!requestId) return { ok: false, error: '批量请求标识不合法，请重试。' };
  const plan = createProxyReassignmentPlan({
    userIds: opts && opts.userIds,
    proxyType: opts && opts.proxyType,
    proxyText: opts && opts.proxyText,
  });
  if (!plan.ok) return plan;
  if (adsProxyWriteInFlight || adsCreateInFlight) {
    return { ok: false, error: '环境写入进行中，请等当前操作完成。' };
  }
  // 在第一个 await 之前占有锁；否则两个 IPC 可在权威范围刷新期间同时通过前置检查。
  adsProxyWriteInFlight = true;
  const updatedUserIds = [];
  try {
    const scope = await proxyTargetScope(plan.plan.map((item) => item.userId));
    if (!scope.ok) return scope;
    const activeIndex = plan.plan.findIndex((item) => proxyTargetActive(item.userId));
    if (activeIndex >= 0) {
      return proxyReassignmentFailure(
        [], activeIndex + 1, '该环境正在使用中；请先关闭后重试。', plan.plan.length,
      );
    }
    const svc = await ensureAdsServiceOnce(null);
    if (!svc.ok) {
      return {
        ok: false,
        error: `指纹浏览器运行时未就绪：${svc.error || '未知错误'}`,
        updatedUserIds: [],
        updatedCount: 0,
        notAttemptedCount: plan.plan.length,
        partial: false,
        retryable: true,
      };
    }
    const ads = resolveAdsOpts(opts);
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    const executed = await executeProxyReassignmentPlan({
      plan: plan.plan,
      // 写前逐项复核竞态；起点完整预校验不能替代状态随后变化。
      isActive: (userId) => proxyTargetActive(userId),
      updateOne: async (item) => {
        const norm = normalizeProxyInput(item.proxy);
        if (!norm.ok) return { ok: false, error: `代理输入不合法：${norm.error}` };
        const result = await writeApi.updateProfileProxy({ userId: item.userId, proxyConfig: norm.proxyConfig }, ads);
        if (!result || !result.ok) return { ok: false, error: batchProxyUpdateError(result) };
        return { ok: true };
      },
      onProgress: ({ completedCount, totalCount }) => {
        emitBatchProxyProgress(event, requestId, completedCount, totalCount);
      },
    });
    for (const userId of executed.updatedUserIds || []) {
      try { invalidateProxyEvidence(userId); } catch { /* 配置写入真相不因本地证据刷新失败被改写 */ }
    }
    if (!executed.ok) return executed;
    updatedUserIds.push(...executed.updatedUserIds);
    return {
      ok: true,
      updatedUserIds,
      updatedCount: updatedUserIds.length,
      proxyCount: plan.proxyCount,
      noProxy: plan.noProxy,
    };
  } catch {
    return proxyReassignmentFailure(
      updatedUserIds,
      updatedUserIds.length + 1,
      '代理更新遇到内部错误',
      plan.plan.length,
    );
  } finally {
    adsProxyWriteInFlight = false;
  }
});

function storePendingInteractionOffboard(offboard, platform) {
  const normalized = normalizePendingInteractionOffboards([{ ...offboard, platform }])[0];
  if (!normalized) return { ok: false, error: 'Cloud 返回的解绑状态不合法，已停止本地删除。' };
  const next = (settings.pendingInteractionOffboards || [])
    .filter((item) => item.offboardId !== normalized.offboardId && item.envKey !== normalized.envKey);
  next.push(normalized);
  const saved = saveSettings({ pendingInteractionOffboards: next });
  const handle = envs.get(fleet.envIdForProfile(normalized.envKey));
  if (saved.ok && handle) handle.cleanupManual = false;
  return saved.ok ? { ok: true, offboard: normalized } : { ok: false, error: '解绑已由 Cloud 受理，但本地恢复游标写入失败；为避免误删，已停止物理删除。' };
}

function updatePendingInteractionOffboard(offboard) {
  const current = pendingOffboardForEnv(offboard && offboard.envKey);
  return storePendingInteractionOffboard({
    ...(current || {}),
    ...(offboard || {}),
    cleanupGrant: (offboard && offboard.cleanupGrant) || (current && current.cleanupGrant),
    cleanupGrantExpiresAt: (offboard && offboard.cleanupGrantExpiresAt) || (current && current.cleanupGrantExpiresAt),
    cleanupEdgeId: (offboard && offboard.cleanupEdgeId) || (current && current.cleanupEdgeId),
  }, current && current.platform);
}

function finishLocalInteractionOffboard(envKey) {
  const nextPending = (settings.pendingInteractionOffboards || []).filter((item) => item.envKey !== envKey);
  const nextEnvironments = (settings.environments || []).filter((item) => item.profileId !== envKey);
  const saved = saveSettings({ pendingInteractionOffboards: nextPending, environments: nextEnvironments });
  syncEnvHandles();
  return saved;
}

function waitForOffboardPoll(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deletePhysicalEnvironmentAfterTombstone(envKey, opts) {
  const svc = await ensureAdsServiceOnce(null);
  if (!svc.ok) return { ok: false, cleanupPending: true, error: `设备清理待重试：指纹浏览器运行时未就绪（${svc.error || '未知错误'}）。` };
  const ads = resolveAdsOpts(opts);
  const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
  const result = await writeApi.deleteProfile(envKey, ads);
  const alreadyMissing = result && result.ok === false && /not found|not exist|does not exist|不存在/i.test(String(result.error || ''));
  if (result && result.ok === false && !alreadyMissing) {
    if (/being used|being opened|cannot be deleted|is open|正在使用|已打开/i.test(String(result.error || ''))) {
      return { ok: false, cleanupPending: true, error: 'Edge 已清除登录密文，但环境仍在使用中；请关闭窗口后继续清理。' };
    }
    return { ok: false, cleanupPending: true, error: `Edge 已清除登录密文，本地环境删除待重试：${result.error || '未知错误'}` };
  }
  const saved = finishLocalInteractionOffboard(envKey);
  if (!saved.ok) return { ok: false, cleanupPending: true, error: '物理环境已删除，但本地花名册清理未能持久化，请重试。' };
  return { ok: true, cleanupPending: false, deleted: true };
}

async function reconcilePendingInteractionOffboard(entry, opts, pollAttempts = 1) {
  let current = entry;
  for (let attempt = 0; attempt < Math.max(1, pollAttempts); attempt += 1) {
    const response = await clientAuthFetch(`/offboarding/${encodeURIComponent(current.offboardId)}`, {
      token: clientSession && clientSession.token,
    });
    if (response.status === 401) {
      onSessionInvalid();
      return { ok: false, cleanupPending: true, error: '客户端登录已失效；Cloud 解绑仍会继续，重新登录后可查看清理状态。' };
    }
    const data = response.ok && response.data && response.data.data;
    if (!data || data.offboardId !== current.offboardId || data.envKey !== current.envKey || data.accountId !== current.accountId) {
      if (attempt + 1 < pollAttempts) { await waitForOffboardPoll(400); continue; }
      return { ok: true, cleanupPending: true, offboard: current, message: '已撤销访问，等待 Edge 确认清理。' };
    }
    const stored = updatePendingInteractionOffboard(data);
    if (!stored.ok) return { ok: false, cleanupPending: true, error: stored.error };
    current = stored.offboard;
    if (current.state === 'tombstoned' || current.state === 'purged') {
      return deletePhysicalEnvironmentAfterTombstone(current.envKey, opts);
    }
    if (attempt + 1 < pollAttempts) await waitForOffboardPoll(400);
  }
  return { ok: true, cleanupPending: true, offboard: current, message: '已撤销访问，等待 Edge 确认清理。' };
}

let pendingOffboardRetryPromise = null;
function retryPendingInteractionOffboards() {
  if (pendingOffboardRetryPromise || !clientAuthEnabled() || !hasValidSession()) return pendingOffboardRetryPromise || Promise.resolve();
  pendingOffboardRetryPromise = (async () => {
    for (const entry of [...(settings.pendingInteractionOffboards || [])]) {
      await reconcilePendingInteractionOffboard(entry, {}, 1);
    }
  })().finally(() => { pendingOffboardRetryPromise = null; });
  return pendingOffboardRetryPromise;
}

// 删除环境：视频号客户环境必须先走 Cloud 权威解绑与 Edge 密文清除，Cloud tombstone 前禁止物理删除。
// 非视频号保持既有显式双确认删除，但客户登录态同样先校验 envKey 在权威 scope 中，不能操作他人环境。
ipcMain.handle('ads:deleteEnv', async (_event, opts) => {
  const userId = String((opts && opts.userId) || '').trim();
  if (!userId) return { ok: false, error: '缺 userId' };
  try {
    const pending = pendingOffboardForEnv(userId);
    if (clientAuthEnabled()) {
      if (!hasValidSession()) { onSessionInvalid(); return { ok: false, error: '登录已失效，请重新登录客户端。' }; }
      if (!pending && (!(allowedProfileIds instanceof Set) || !allowedProfileIds.has(userId))) {
        return { ok: false, status: 403, error: '该环境不属于当前客户，已拒绝操作。' };
      }
      const platform = pending ? pending.platform : allowedEnvironmentPlatforms.get(userId);
      if (pending || platform === 'wechat_channels') {
        let accepted = pending;
        if (!accepted) {
          const response = await clientAuthFetch(`/environments/${encodeURIComponent(userId)}`, {
            method: 'DELETE',
            token: clientSession.token,
            body: { edgeId: fleet.envIdForProfile(userId) },
          });
          if (response.status === 401) { onSessionInvalid(); return { ok: false, error: '登录已失效，请重新登录客户端。' }; }
          const data = response.ok && response.data && response.data.data;
          if (!data || data.envKey !== userId) {
            return { ok: false, error: `Cloud 未受理解绑，已停止本地删除（${(response.data && response.data.error) || response.error || response.status}）。` };
          }
          const stored = storePendingInteractionOffboard(data, platform);
          if (!stored.ok) return stored;
          accepted = stored.offboard;
          // Cloud 已在同一事务撤销访问；保留 cleanup-only handle 接收清密文命令，但从普通可见/可运行 scope 移除。
          allowedProfileIds.delete(userId);
          allowedEnvironmentPlatforms.delete(userId);
          syncEnvHandles();
        }
        return reconcilePendingInteractionOffboard(accepted, opts, 8);
      }
    }
    return deletePhysicalEnvironmentAfterTombstone(userId, opts);
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

  app.whenReady().then(async () => {
    loadSettings();
    loadClientSession();
    if (settings.selectedEnvId) selectedEnvId = settings.selectedEnvId;
    // activate（dock 点击 / 无窗）无条件注册一次，兼顾未登录（拉回登录门）与已登录（拉回主窗）两态。
    app.on('activate', () => {
      if (clientAuthEnabled() && !hasValidSession()) { createLoginWindow(); return; }
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow?.show();
    });
    // 启动鉴权只执行一次：有效 session 继续；无效 session 用 safeStorage 凭据自动登录一次；
    // 无凭据或失败才显示登录门。任何路径都在主窗和环境句柄建立前收口。
    const startupAuth = await prepareClientAuthForStartup();
    if (!startupAuth.ready) {
      createLoginWindow();
      return;
    }
    await proceedAfterAuth();
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
  const hasManagedAdsRuntime = Boolean(managedAdsRuntime);
  if (!anyRunning && !hasManagedAdsRuntime) {
    quitFinal = true;
    return;
  }
  // 有在跑环境或已管理 Ads CLI：拦下本次退出，完成有界清理后再真正退出。
  event.preventDefault();
  void gracefulStopAllAndQuit();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
