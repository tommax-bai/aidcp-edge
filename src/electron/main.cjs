const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, Notification, shell, screen, safeStorage } = require('electron');
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
const {
  DEFAULT_BROWSER_COLD_STANDBY_ENABLED,
  DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS,
  DEFAULT_BROWSER_COLD_STANDBY_WARMUP_MS,
  normalizeColdStandbySettings,
  shouldEnterColdStandby,
  normalizeBrowserStandbyHint,
} = require('./browser-cold-standby.cjs');
const fleet = require('./fleet.cjs');
const {
  browserPersonaNoticeForStatus,
  browserPersonaNoticeKey,
} = require('./persona-notice.cjs');

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
// 稿件预览审批桥：渲染层动作经目标环境 core stdin → cloud WS → stdout 回执。
const publishApprovalPending = new Map(); // id -> { resolve, timer }
let publishApprovalSeq = 0;
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
// ── 云端环境选择（change edge-cloud-env-selector）─────────────────────────────
// 客户端连哪个云端由「设置里的选择」权威决定：界面选了就以界面为准（派生核心时显式覆盖继承来的
// AIDCP_CLOUD_URL）；界面留空则回落启动环境变量、再回落缺省 dev（对现有以环境变量启动的流程零回归）。
// 两个正式地址一处真源；custom 允许任意 ws(s):// 地址。dev=测试、ol=线上生产。
const CLOUD_ENV_URLS = { dev: 'ws://121.89.85.150:8787', ol: 'ws://123.56.253.183:8787' };
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
// 构建期烘焙的对外客户鉴权地址（change edge-client-customer-auth）：分发包用
// electron-builder `-c.extraMetadata.aidcpClientAuthUrl=https://…/capi` 注入，让分发的客户端「一装即带登录门」，
// 无需运营 / 客户手填环境变量。只读打包进 app 的 package.json；非法 / 缺失 → ''（登录门保持 opt-in 关闭，零回归）。
// dev(electron .) 下 getAppPath 是仓库根、package.json 无此字段 → 不受影响。
function readBakedClientAuthUrl() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    const v = String((pkg && pkg.aidcpClientAuthUrl) || '').trim();
    return /^https?:\/\//i.test(v) ? v.replace(/\/+$/, '') : '';
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
  // 浏览器并发（change browser-slot-scheduling）：两个上限都可在设置里显式给定，0 = 未设 = 自动。
  //  - browserSlotLimit：同时打开的浏览器数上限（槽位）。自动 = ⌊可用内存 ÷ 单环境估值⌋。
  //  - maxAccountLimit：可挂载的账号数上限。自动 = 2 × 槽位（1:2 缺省比例）。
  browserSlotLimit: 0,
  maxAccountLimit: 0,
  // 「开发者详情」（原始日志区）默认不展示，在设置抽屉里开关（客户版首屏零技术噪音）。
  devDetails: false,
  // 环境栏（fleet rail）收起态与上次选中环境（跨重启保留）。
  railCollapsed: true,
  selectedEnvId: '',
  // 对外客户鉴权登录门（change edge-client-customer-auth）：opt-in、默认不启用（零回归）。
  // clientAuthUrl 给完整 http(s):// 地址即启用；或 clientAuthEnabled=true 由云端主机派生客户鉴权地址。
  clientAuthUrl: '',
  clientAuthEnabled: false,
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
  normalizeColdStandbySettingsIntoSettings();
  normalizeSlotSettingsIntoSettings();
  // 花名册迁移（向后兼容）：旧单值 adsProfileId → 单元素花名册；镜像回写旧字段（回滚兼容）。
  settings.environments = fleet.migrateEnvironments(parsed && typeof parsed === 'object' ? { ...parsed, environments: settings.environments } : settings);
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
  if (settings.cloudEnvKey === 'custom' && !isWsUrl(settings.cloudUrlCustom)) settings.cloudEnvKey = '';
}

// 解析派生核心该连的云端：界面选择优先 > 启动环境变量 AIDCP_CLOUD_URL > 缺省 dev。
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
// 给客户端加一层「客户 name+key 登录」。**opt-in、零回归**：仅当配置了客户鉴权地址时启用登录门；
// 未配置（现有运营装机 / dev）行为与从前完全一致（无登录、无过滤）。地址解析：
//   ① 显式完整 URL：env AIDCP_CLIENT_AUTH_URL 或 settings.clientAuthUrl（http(s)://…）；
//   ② 显式启用（env AIDCP_CLIENT_AUTH_ENABLE=1 或 settings.clientAuthEnabled）→ 由云端 WS 主机派生
//      ws(s)://host:8787 → http(s)://host:8091（部署经 Nginx 反代时用 ① 给完整 URL）。
// 登录后：客户令牌存 userData/client-session.json（随 AIDCP_USER_DATA_DIR 多实例隔离）；
// 环境栏只显示云端按该客户下发的可见环境（与本地花名册求交，见 syncEnvHandles 的 allowedProfileIds 过滤）。
// 边缘只走 HTTP 到客户鉴权端口，**不改 WS 协议 / hello**（协议零改）。
const CLIENT_AUTH_DEFAULT_PORT = 8091;
let loginWindow = null;
let clientSession = null; // { token, name, expiresAt(ms) } | null
let allowedProfileIds = null; // Set<profileId> | null（null = 未 gated，不过滤）
let sessionTimer = null;
let proceededOnce = false;

function resolveClientAuthBase() {
  // 优先级：显式环境变量 / 设置里的完整地址 > 构建期烘焙地址（分发包）> 显式启用+云端主机派生。
  const explicit = String((process.env.AIDCP_CLIENT_AUTH_URL || '') || (settings && settings.clientAuthUrl) || '').trim();
  if (/^https?:\/\//i.test(explicit)) return explicit.replace(/\/+$/, '');
  if (BAKED_CLIENT_AUTH_URL) return BAKED_CLIENT_AUTH_URL;
  const enabled = process.env.AIDCP_CLIENT_AUTH_ENABLE === '1' || Boolean(settings && settings.clientAuthEnabled);
  if (!enabled) return '';
  const cloud = resolveCloudUrl().url;
  const m = /^wss?:\/\/([^/:]+)(?::(\d+))?/i.exec(String(cloud || '').trim());
  if (!m) return '';
  const scheme = /^wss:/i.test(cloud) ? 'https' : 'http';
  return `${scheme}://${m[1]}:${CLIENT_AUTH_DEFAULT_PORT}`;
}
function clientAuthEnabled() {
  return Boolean(resolveClientAuthBase());
}
function clientSessionFile() {
  return path.join(app.getPath('userData'), 'client-session.json');
}
function clientLoginPrefillFile() {
  return path.join(app.getPath('userData'), 'client-login-prefill.json');
}
function clientLoginPrefillEncryptionAvailable() {
  try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
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
    fs.writeFileSync(file, JSON.stringify({ version: 1, ciphertext: ciphertext.toString('base64') }), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort permissions on platforms that do not support them */ }
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
    const s = JSON.parse(fs.readFileSync(clientSessionFile(), 'utf8'));
    clientSession = s && typeof s.token === 'string' && s.token ? s : null;
  } catch {
    clientSession = null;
  }
}
function saveClientSession(s) {
  clientSession = s;
  try { fs.writeFileSync(clientSessionFile(), JSON.stringify(s), 'utf8'); } catch { /* best-effort */ }
}
function clearClientSession() {
  clientSession = null;
  try { fs.unlinkSync(clientSessionFile()); } catch { /* ignore */ }
  clearClientLoginPrefill();
}
function hasValidSession() {
  return Boolean(clientSession && clientSession.token && (!clientSession.expiresAt || Date.now() < clientSession.expiresAt));
}
async function clientAuthFetch(pathname, { method = 'GET', token, body } = {}) {
  const base = resolveClientAuthBase();
  if (!base) return { status: 0, ok: false, data: null };
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    // 有界超时：登录/刷新/拉可见环境都经此出口，refreshAllowedEnvironments 现随每次「刷新」列表调用——面板挂起时
    // 绝不能让裸 fetch 无限吊住按钮。超时按 status:0（非 401）处理：refreshAllowedEnvironments 据此保留上次已知集、
    // 不误登出、不清空（与网络抖动同路径）。
    const res = await fetch(base + pathname, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 忽略 */ }
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    return { status: 0, ok: false, data: null, error: String((e && e.message) || e) };
  }
}
// 拉该客户可见环境 → 设 allowedProfileIds。返回 false 表示会话已失效（401），由调用方决定登出。
async function refreshAllowedEnvironments() {
  if (!clientAuthEnabled() || !hasValidSession()) { allowedProfileIds = null; return true; }
  const r = await clientAuthFetch('/my-environments', { token: clientSession.token });
  if (r.status === 401) return false;
  if (r.ok && r.data && Array.isArray(r.data.environments)) {
    allowedProfileIds = new Set(r.data.environments.map((e) => String((e && e.envKey) || '')).filter(Boolean));
  } else if (allowedProfileIds == null) {
    allowedProfileIds = new Set(); // 首次拉取失败 → fail-closed 空集（不误显他人环境）；已建立则保留上次已知
  }
  return true;
}

async function attachClientEnvironmentToCurrentUser({ userId, name, platform } = {}) {
  const envKey = String(userId || '').trim();
  if (!envKey || !clientAuthEnabled() || !hasValidSession()) return { ok: true, attached: false };
  const r = await clientAuthFetch('/environments', {
    method: 'POST',
    token: clientSession.token,
    body: { envKey, label: String(name || '').trim(), platform: normalizePlatform(platform) },
  });
  if (r.status === 401) {
    onSessionInvalid();
    return { ok: false, attached: false, error: '客户端登录已失效，新环境已创建但未能分配给当前用户，请重新登录后在后台分配。' };
  }
  if (!r.ok) {
    const detail = r.error ? `（${r.error}）` : '';
    return { ok: false, attached: false, error: `新环境已创建，但分配给当前用户失败${detail}。` };
  }
  if (!(allowedProfileIds instanceof Set)) allowedProfileIds = new Set();
  allowedProfileIds.add(envKey);
  return { ok: true, attached: true };
}

function withClientAttachment(result, attach) {
  if (!result || !result.ok || !attach || attach.ok) {
    return attach && attach.attached ? { ...result, assignedToCurrentClient: true } : result;
  }
  return {
    ...result,
    assignedToCurrentClient: false,
    visibilityWarning: attach.error || '新环境已创建，但分配给当前用户失败，刷新后可能暂不可见。',
  };
}
// 会话失效（登出 / 被停用 / 令牌过期）：清会话 + 拆掉所有环境 handle（停在跑子进程）+ 关主窗 + 回登录门。
function onSessionInvalid() {
  clearClientSession();
  allowedProfileIds = new Set();
  try { syncEnvHandles(); } catch { /* ignore */ } // wanted 为空 → 移除并 SIGTERM 全部环境
  if (mainWindow) { try { mainWindow.close(); } catch { /* ignore */ } mainWindow = null; }
  createLoginWindow();
}
function createLoginWindow() {
  if (loginWindow) { try { loginWindow.show(); loginWindow.focus(); } catch { /* ignore */ } return; }
  loginWindow = new BrowserWindow({
    width: 820,
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
  if (clientAuthEnabled() && hasValidSession()) {
    const ok = await refreshAllowedEnvironments();
    if (!ok) { clearClientSession(); allowedProfileIds = new Set(); createLoginWindow(); return; }
  } else {
    allowedProfileIds = null; // 未 gated：不过滤
  }
  syncEnvHandles();
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
        lastMessage: '就绪。点右下角「启动」开始自动运营。',
        ...presencePatch('就绪，等你点「启动」'),
      });
    }
  }
  if (settings.provider === 'adspower' && envs.size === 0) broadcastFleet();
  if (!mainWindow) createWindow();
  if (!proceededOnce) {
    proceededOnce = true;
    createTray();
    void reconcileRunningProfiles();
    startSessionMaintenance();
  }
}
// 会话维护：滑动续签 + 定时复核可见范围（管理员增删环境即时生效）；失效即登出回登录门。
function startSessionMaintenance() {
  if (sessionTimer) return;
  sessionTimer = setInterval(async () => {
    if (!clientAuthEnabled() || !hasValidSession()) return;
    if (clientSession.expiresAt && clientSession.expiresAt - Date.now() < 5 * 60_000) {
      const rr = await clientAuthFetch('/auth/refresh', { method: 'POST', token: clientSession.token });
      if (rr.status === 200 && rr.data && rr.data.token) {
        saveClientSession({ token: rr.data.token, name: clientSession.name, expiresAt: Date.now() + (Number(rr.data.expiresIn) || 900) * 1000 });
      } else if (rr.status === 401) { onSessionInvalid(); return; }
    }
    const ok = await refreshAllowedEnvironments();
    if (!ok) { onSessionInvalid(); return; }
    syncEnvHandles();
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
  settings.maxAccountLimit = fleet.normalizeSlotLimit(settings.maxAccountLimit);
  slotCapacityCache = 0;
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
  if (nick === String(handle.name || '')) return; // 幂等去抖：名已一致不发
  if (handle.renamingTo === nick) return; // 同名改名在途，不重复发
  handle.renamingTo = nick;
  try {
    const ads = resolveAdsOpts({});
    const writeApi = createAdsWriteApi({ apiBase: ads.apiBase, apiKey: ads.apiKey });
    const r = await writeApi.renameProfile({ userId, name: nick }, ads);
    if (r && r.ok) {
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
    risk: 'normal',
    edge: 'stopped',
    lastMessage: '边缘进程尚未运行。',
    edgeFailure: null,
    updatedAt: new Date().toISOString(),
    account: null,
    presence: { text: '等待启动…', at: new Date().toISOString() },
    publish: null,
    publishPreview: null,
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
    // 本环境核心本次实际被派生去连的云端 key（change edge-cloud-env-selector）：''=未启动/未知。
    // 界面据此与「目标云端」比对，运行中且不一致即显示「待重启生效」（红线：显示=实际连接）。
    connectedCloudKey: '',
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
    coldStandbyTimer: null,
    coldStandbyWakeAt: 0,
    coldStandbyActive: false,
    coldStandbyPending: false,
    // 最短持有时长（change standby-covers-idle-waits）：上次唤醒完成的时刻 + 一个「持有满足后重新判定」
    // 的定时器。被 min_hold 拦下时**绝不能把提示丢掉**——否则一次拦截就把该环境永久留在开启态、
    // 再也不会让出槽位（外层 !decision.ok 分支对「不在待机中」的普通 skip 是直接 return、什么都不做的）。
    coldStandbyLastWokenAt: 0,
    coldStandbyHoldTimer: null,
    // 正在原地重建浏览器（change browser-slot-scheduling）。唤醒是异步有界的：待机态只在核心回报
    // lifecycle.woken 后才解除，绝不在下发唤醒的那一刻就乐观标成已醒。
    coldStandbyWaking: false,
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
    // 按登录客户可见范围过滤（change edge-client-customer-auth）：allowedProfileIds 为 null 时不过滤（未 gated）；
    // 为 Set 时只保留归属当前客户的环境——非本客户环境不建 handle、不显示、不启动。cascadeIndex 用连续序号（错峰）。
    let idx = 0;
    settings.environments.forEach((env) => {
      if (allowedProfileIds && !allowedProfileIds.has(env.profileId)) return;
      const envId = fleet.envIdForProfile(env.profileId);
      wanted.set(envId, { envId, kind: 'adspower', profileId: env.profileId, name: env.name, platform: env.platform, cascadeIndex: idx++ });
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
    cloudEnv: cloudSelectionView(), // 目标云端（当前选择解析出的地址 + 友好名，change edge-cloud-env-selector）
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

// ── 浏览器槽位池 + 串行启动队列（change browser-slot-scheduling）──
//
// 同机能同时开几个浏览器由**内存**顶死（每个 headful 环境约 700MB；AdsPower 本身不限并发）。
// 所有会打开浏览器的动作——续场恢复 / 冷待机唤醒 / 崩溃重起 / 手动任务 / 排期任务——都必须排这一条队：
// **起完一个再起下一个**，而且内存准入闸就长在队列里，任何路径都绕不过去。
//
// 旧行为的两个洞：① 准入闸只在「全部启动」按钮上调（单启 / 唤醒 / 重起全部绕过）；② 冷待机唤醒定时器
// 零抖动——撞日额的账号会在上海零点**同一秒**一起冷启，没有任何东西拦得住。
const launchQueue = fleet.createSerialLaunchQueue({
  spacingMs: Number(process.env.AIDCP_FLEET_STAGGER_MS) > 0 ? Number(process.env.AIDCP_FLEET_STAGGER_MS) : undefined,
  logger: (m) => console.log(m),
});
const PER_ENV_BYTES = Number(process.env.AIDCP_PER_ENV_MB) > 0
  ? Number(process.env.AIDCP_PER_ENV_MB) * 1024 * 1024
  : fleet.PER_ENV_BYTES_DEFAULT;
let slotCapacityCache = 0;
let slotViewCache = null;
/**
 * 两个上限的当前取值（界面设置 > 启动环境变量 > 按可用内存自动推）。
 *
 * 自动值按**进程启动时**的可用内存算一次并缓存：边启动边算会随内存下降而自我缩水（起到第 3 个时
 * 剩余内存已被前 2 个吃掉，算出来的上限反而变小）。设置一改即作废缓存、立刻重算。
 */
function slotSettingsView() {
  if (!slotViewCache) {
    const usableBytes = fleet.usableMemoryBytes();
    slotViewCache = fleet.resolveSlotSettings({
      freeBytes: usableBytes,
      perEnvBytes: PER_ENV_BYTES,
      slotSetting: settings.browserSlotLimit,
      slotEnv: Number(process.env.AIDCP_BROWSER_SLOTS) || 0,
      maxAccountsSetting: settings.maxAccountLimit,
    });
    slotViewCache.usableMB = Math.round(usableBytes / (1024 * 1024));
    slotCapacityCache = slotViewCache.capacity;
    console.log(
      `[slots] 槽位上限 ${slotViewCache.capacity}（${slotViewCache.capacitySource}；可用内存约 ${slotViewCache.usableMB}MB、` +
        `单环境约 ${slotViewCache.perEnvMB}MB，自动推算 ${slotViewCache.autoCapacity}）· ` +
        `账号上限 ${slotViewCache.maxAccounts}（${slotViewCache.maxAccountsSource}）`,
    );
    if (slotViewCache.maxAccountsExceedsRatio) {
      console.warn(
        `[slots] ⚠ 账号上限 ${slotViewCache.maxAccounts} 超过 ${slotViewCache.capacity} 槽位对应的 1:2 上限 ` +
          `${slotViewCache.autoMaxAccounts}：部分账号可能长期排不到浏览器槽位。`,
      );
    }
  }
  return slotViewCache;
}
function slotCapacity() {
  return slotSettingsView().capacity;
}
function maxAccounts() {
  return slotSettingsView().maxAccounts;
}
/** 当前真正占着浏览器的环境数：有核心子进程 且 不在冷待机（待机中浏览器已被释放、槽位已还回池子）。 */
function occupiedSlots() {
  let n = 0;
  for (const h of envs.values()) {
    if (h.child && !h.coldStandbyActive && !h.removed) n += 1;
  }
  return n;
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
 * 内存 / 槽位准入。**队列内部统一过闸，任何开浏览器的路径都不得绕过。**
 * 不通过即诚实拒绝——绝不静默超额拉起（换页抖动 / OOM 杀掉某个浏览器，看起来就成了「莫名其妙的不稳定」）。
 */
function admitBrowserSlot(handle, { force = false } = {}) {
  if (force) return { ok: true };
  const cap = slotCapacity();
  const used = occupiedSlots();
  if (used >= cap) {
    return { ok: false, reason: 'slots_full', message: `槽位已满（${used}/${cap}）：需等其它账号进入待机让出槽位` };
  }
  const admission = fleet.ramAdmission({
    plannedCount: 1,
    freeBytes: fleet.usableMemoryBytes(),
    perEnvBytes: PER_ENV_BYTES,
  });
  if (!admission.ok) {
    return {
      ok: false,
      reason: 'ram',
      message: `本机可用内存不足（需约 ${admission.requiredMB}MB，可用 ${admission.freeMB}MB）`,
    };
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
    console.log(`[slots] ${handle.envId} 告知核心「这次没轮到」（${detail}）：仍在队列中，浏览器继续起`);
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

const DAILY_USAGE_ACTIONS = ['view', 'like', 'collect', 'comment', 'follow', 'publish'];
const DAILY_USAGE_WINDOWS = ['session', 'minute', 'hour', 'day'];

function cleanCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cleanOptionalCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
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

function cleanInspirationSummary(input) {
  const source = input && typeof input === 'object' ? input : null;
  if (!source) return null;
  const count = cleanOptionalCount(source.count);
  if (!count || count <= 0) return null;
  const out = { count };
  const sourceLikeCount = cleanOptionalCount(source.sourceLikeCount);
  if (sourceLikeCount !== null && sourceLikeCount > 0) out.sourceLikeCount = sourceLikeCount;
  return out;
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
  const inspirationSummary = cleanInspirationSummary(input.inspirationSummary);
  const firstPost = input.firstPost && typeof input.firstPost === 'object'
    && ['searching', 'generating'].includes(input.firstPost.state)
    && typeof input.firstPost.viewed === 'number' && Number.isFinite(input.firstPost.viewed)
    && typeof input.firstPost.startedAt === 'number' && Number.isFinite(input.firstPost.startedAt)
    ? {
        state: input.firstPost.state,
        viewed: cleanCount(input.firstPost.viewed),
        target: 20,
        startedAt: input.firstPost.startedAt,
        ...(typeof input.firstPost.sourceId === 'string' && input.firstPost.sourceId ? { sourceId: input.firstPost.sourceId } : {}),
      }
    : null;
  const out = {
    asOf,
    totals,
    saturated: saturatedActions(totals, quotas, input.saturated),
  };
  if (['conservative', 'normal', 'aggressive'].includes(input.quotaLevel)) out.quotaLevel = input.quotaLevel;
  if (quotas) out.quotas = quotas;
  if (inspirationSummary) out.inspirationSummary = inspirationSummary;
  if (firstPost) out.firstPost = firstPost;
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
    width: 820,
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
    trayTemplate.push({ label: '退出登录', click: () => { if (clientSession && clientSession.token) void clientAuthFetch('/logout', { method: 'POST', token: clientSession.token }); onSessionInvalid(); } });
  }
  trayTemplate.push({ label: '退出', click: quitApp });
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate));
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

function clearColdStandbyTimer(handle) {
  if (!handle) return;
  if (handle.coldStandbyTimer) clearTimeout(handle.coldStandbyTimer);
  handle.coldStandbyTimer = null;
  handle.coldStandbyWakeAt = 0;
  handle.coldStandbyPending = false;
  handle.coldStandbyActive = false;
  handle.coldStandbyWaking = false;
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
  handle.coldStandbyPending = false;
  handle.coldStandbyActive = true;
  // 浏览器关掉了 = 一个槽位空出来了：立刻叫等槽位队列的队头，别让它白等到下一次重扫。
  setTimeout(() => drainSlotWaiters(), 0);
  const hint = handle.status.browserStandby && handle.status.browserStandby.hint;
  const decision = shouldEnterColdStandby({
    status: { ...handle.status, edge: 'running', cloud: 'connected', session: 'resting' },
    flags: { ...coldStandbyFlags(handle), closePending: false, pausePending: false },
    hint,
    settings: normalizeColdStandbySettings(settings, process.env),
    now: Date.now(),
  });
  if (decision.ok) scheduleColdStandbyWake(handle, decision);
  updateStatus(handle, {
    edge: 'running',
    cloud: 'connected',
    session: 'resting',
    overlayBlocked: false,
    browserStandby: coldStandbyStatus('sleeping', hint, decision.ok ? {
      wakeDelayMs: decision.wakeDelayMs,
      warmupMs: decision.warmupMs,
    } : { reason: decision.reason }),
    lastMessage: '浏览器已关闭进入冷待机，云端连接保持中。',
    ...presencePatch('长时间等待中，浏览器已关闭，云端连接保持中'),
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
  if (handle.coldStandbyTimer) clearTimeout(handle.coldStandbyTimer);
  handle.coldStandbyWakeAt = decision.hint.wakeAt;
  handle.coldStandbyTimer = setTimeout(() => {
    handle.coldStandbyTimer = null;
    wakeColdStandby(handle, 'scheduled_wake');
  }, decision.wakeDelayMs);
  if (handle.coldStandbyTimer && typeof handle.coldStandbyTimer.unref === 'function') handle.coldStandbyTimer.unref();
}

/**
 * 唤醒失败后重挂自唤醒定时器（退避 1min → 2min → 5min 封顶）。
 *
 * `wakeColdStandby` 一进门就把待机定时器清了。旧版失败时不还——于是**一次唤醒失败 = 这个环境永久停摆**：
 * 它既没有自唤醒定时器，核心那边的唤醒闩也永久置位（再不会向外壳请求），云端的任务全部打空。
 * 退避是刚性的：AdsPower 真坏掉时，绝不 60s 一次地无限重敲它。
 */
function rearmWakeAfterFailure(handle) {
  if (!handle || handle.removed || isQuitting) return;
  if (handle.coldStandbyTimer) clearTimeout(handle.coldStandbyTimer);
  handle.wakeRetryStreak = Math.min((handle.wakeRetryStreak || 0) + 1, 3);
  const delayMs = [60_000, 120_000, 300_000][handle.wakeRetryStreak - 1];
  handle.coldStandbyTimer = setTimeout(() => {
    handle.coldStandbyTimer = null;
    wakeColdStandby(handle, 'wake_retry');
  }, delayMs);
  if (typeof handle.coldStandbyTimer.unref === 'function') handle.coldStandbyTimer.unref();
  console.log(`[standby] ${handle.envId} 唤醒失败，${Math.round(delayMs / 1000)}s 后自动重试（仍保持待机）`);
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
  if (!handle || (!handle.coldStandbyActive && !handle.coldStandbyPending)) return;
  if (handle.coldStandbyWaking) return; // 幂等：已在唤醒中，绝不重开第二个浏览器
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
    const child = handle.child;
    // 带任务的唤醒（云端有活等着）优先于到点的普通唤醒。
    const kind = reason === 'cloud_command' ? 'task' : 'resume';
    void launchQueue.enqueue({
      key: `${handle.envId}:wake`,
      kind,
      run: () =>
        new Promise((resolve) => {
          if (handle.child !== child || handle.removed || isQuitting) {
            handle.coldStandbyWaking = false;
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
            onColdStandbyWakeFailed(handle, `唤醒超时（${LAUNCH_READY_TIMEOUT_MS}ms）`);
            finish(false);
          }, LAUNCH_READY_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
          handle.wakeSettle = finish;
          const sent = sendCoreLifecycle(handle, 'wake', (error) => {
            if (handle.child !== child) return;
            onColdStandbyWakeFailed(handle, `唤醒指令未送达：${error.message}`);
            finish(false);
          });
          if (!sent) {
            onColdStandbyWakeFailed(handle, '核心进程 IPC 不可用');
            finish(false);
          }
        }),
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
  handle.coldStandbyWaking = false;
  if (typeof handle.wakeSettle === 'function') handle.wakeSettle(true); // 放行启动队列的下一个
  handle.coldStandbyPending = false;
  handle.coldStandbyActive = false;
  handle.wakeRetryStreak = 0;
  handle.wakeDeadlineAt = 0;
  clearWakeDeadline(handle);
  clearSlotWaiting(handle);
  clearColdStandbyTimer(handle);
  // 最短持有时长的起点：从「浏览器真的重建好了」这一刻起算，而非下发唤醒那一刻——否则冷启那 30–45s
  // 会被算进持有期，闸就形同虚设。必须在 clearColdStandbyTimer 之后写（它会清掉 hold timer，但不碰这个时刻）。
  handle.coldStandbyLastWokenAt = Date.now();
  updateStatus(handle, {
    edge: 'running',
    session: 'running',
    browserStandby: coldStandbyStatus('awake', handle.status.browserStandby && handle.status.browserStandby.hint, {}),
    lastMessage: '已从待机唤醒：浏览器已重建，引擎与云端连接全程未断。',
    ...presencePatch('运行中'),
    ...clearEdgeFailurePatch(handle),
  });
}

/**
 * 唤醒失败：**留在待机态**（可再次唤醒），并如实告知。
 * 绝不把一个没起来的浏览器标成已就绪——那正是「静默假成功」。
 */
function onColdStandbyWakeFailed(handle, reason) {
  if (!handle) return;
  handle.coldStandbyWaking = false;
  if (typeof handle.wakeSettle === 'function') handle.wakeSettle(false); // 放行启动队列的下一个
  handle.coldStandbyPending = false;
  handle.coldStandbyActive = true; // 仍在待机：浏览器没起来
  // 核心必须当场知道结论，否则它在浏览器闸上空转满 180s 唤醒死线（旧版：外壳一言不发）。
  denyWakeNow(handle, `wake_failed:${reason}`);
  // 待机定时器在 wakeColdStandby 里被清掉了，这里**必须还回去**——不还，这个环境此后再无任何
  // 自唤醒路径，会一直待机到天荒地老（一次唤醒失败 = 永久停摆）。
  rearmWakeAfterFailure(handle);
  updateStatus(handle, {
    browserStandby: coldStandbyStatus('sleeping', handle.status.browserStandby && handle.status.browserStandby.hint, {
      reason: `wake_failed:${reason}`,
    }),
    lastMessage: `唤醒失败：${reason}。仍保持待机，可再次唤醒。`,
    ...presencePatch('待机中（唤醒失败）'),
  });
}

/**
 * 启动一个环境（change browser-slot-scheduling）：**经串行启动队列**——起完一个再起下一个，
 * 内存 / 槽位准入闸长在队列里，绕不过去。
 *
 * kind 决定队列优先级：manual（手动任务）> task（带任务的唤醒）> resume（普通续场恢复）。
 */
function startEdge(handle, { kind = 'resume', force = false } = {}) {
  if (!handle || handle.child || handle.removed || handle.stopRequested || isQuitting) return;
  if (handle.status.session === 'paused') return;
  if (handle.launchQueued) return; // 已在队列里：绝不重复入队、绝不开出第二个浏览器
  handle.launchQueued = true;
  clearRespawnTimer(handle);
  clearColdStandbyTimer(handle);
  const cap = slotCapacity();
  updateStatus(handle, {
    edge: 'starting',
    lastMessage: `排队等待启动槽位（当前 ${occupiedSlots()}/${cap} 个浏览器在跑）…`,
    ...presencePatch('排队等待启动…'),
  });
  void launchQueue.enqueue({
    key: handle.envId,
    kind,
    run: async () => {
      handle.launchQueued = false;
      // 轮到它时再复核取消闸：排队期间可能已被暂停 / 移出 / 退出。
      if (!handle || handle.child || handle.removed || handle.stopRequested || isQuitting) return false;
      if (handle.status.session === 'paused') return false;
      const forceLaunch = force || Boolean(handle.forceLaunch);
      handle.forceLaunch = false; // 一次性：force 只对这一次启动有效，绝不粘在环境上永久免检
      const admitted = admitBrowserSlot(handle, { force: forceLaunch });
      if (!admitted.ok) {
        // 槽位/内存不够 → **进等槽位队列**，绝不丢弃这次启动请求，也绝不判失败。
        //
        // 挂 12 个账号、只有 6 个槽位，本来就该有 6 个在等——等别人进冷待机让出槽位再顶上，
        // 这正是 1:2 能成立的前提。旧版在这里直接丢弃请求、环境永久趴在 warning 态，
        // 后来槽位空出来也没人去取，等于把 1:2 废掉了（多挂的账号一天都跑不了）。
        parkForSlot(handle, admitted);
        return false;
      }
      clearSlotWaiting(handle);
      clearWakeDeadline(handle);
      return await spawnEdgeChild(handle);
    },
  });
}

/**
 * spawn 一个环境的核心子进程（非 detached，随外壳退出终止）。身份闸在此强制执行。
 *
 * 返回一个在环境**真正就绪**（云端已连上）或诚实失败时才 settle 的 promise——串行启动队列靠它
 * 实现「起完一个再起下一个」；不等就绪就放行下一个，10 个环境仍会几乎同时冷启、把内存打爆。
 */
function spawnEdgeChild(handle) {
  if (!handle || handle.child || handle.removed || handle.stopRequested || isQuitting) return false;
  if (handle.status.session === 'paused') return false;
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

  // 云端环境注入（change edge-cloud-env-selector）：界面已显式选择时，在**合并之后**覆盖继承来的
  // AIDCP_CLOUD_URL（必须在此、而非塞进 providerEnv：合并 { ...providerEnv, ...processEnv } 会让继承值压过）；
  // 未选择则不动、沿用继承 / 缺省（零回归）。stamp 本次实际连接的云端 key，供界面「当前云端」显示与实际一致。
  const cloudSel = resolveCloudUrl();
  if (cloudSel.fromSelection) spawnEnv.AIDCP_CLOUD_URL = cloudSel.url;
  const resolvedCloudKey = cloudSel.fromSelection
    ? cloudSel.key
    : cloudKeyForUrl(String(process.env.AIDCP_CLOUD_URL || '').trim() || DEFAULT_CLOUD_URL);
  handle.connectedCloudKey = resolvedCloudKey;
  // Facebook 真浏览/点赞只对 dev 生效。必须放在两路 env 合并与云端解析之后，避免外壳遗留 on/shadow
  // 泄漏到 ol/custom；所有 Facebook 分身共享此策略，不再按分身单独放行。
  spawnEnv.AIDCP_FB_BROWSE_AUTO = fleet.facebookBrowseModeFor({
    platform: handle.platform,
    cloudEnvKey: resolvedCloudKey,
  });

  handle.browserParkingReady = false;
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
    // 新核心 = 还没连上过云端，哪怕上一个核心连上过（change honest-first-connect-label）。不复位这一位，
    // 崩溃重起 / 显式重启的整个冷启动窗口会顶着上一轮的「连过」资格，被讲成「正在重新连接」。
    cloudEverConnected: false,
    browserStandby: null,
    publish: null,
    publishPreview: null,
    respawnGaveUp: false,
    connectedCloudKey: handle.connectedCloudKey || '',
    lastMessage: '正在启动 aidcp-edge…',
    ...presencePatch('正在启动引擎…'),
    ...clearEdgeFailurePatch(handle),
  });

  child.stdout.on('data', (chunk) => handleEdgeOutput(handle, chunk.toString()));
  child.stderr.on('data', (chunk) => handleEdgeOutput(handle, chunk.toString(), true));
  child.on('message', (message) => {
    if (handle.child !== child || !message || typeof message !== 'object') return;
    if (message.type === 'lifecycle.standby') {
      onColdStandbyAck(handle);
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
    if (message.type === 'lifecycle.paused') {
      clearColdStandbyTimer(handle);
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
      clearColdStandbyTimer(handle);
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
    settleLaunchReady(handle, false); // 起不来：立刻放行启动队列的下一个，绝不占着队列干等
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
  // 终局判定挂 'close'（非 'exit'）：Node 只保证 'close' 在 stdio 全部 drain 后触发、且必在 'exit' 之后；
  // 'exit' 可能早于末尾 stdout/stderr 'data'，那样内核缺失退出时 kernelMissThisRun/neededKernel 尚未由
  // handleEdgeLogLine 写入 → 被误判为硬失败、弹出本 change 意在消除的启动失败通知。改挂 'close' 后，
  // 「SunBrowser <N> is not ready」等末行必已处理完，内核缺失分类可靠。（spawn 失败无 'close'，由上方 'error'
  // 经 handle.child===child 互斥兜底；核心不派生继承 stdio 的孙进程，'close' 及时触发；退出应用的有界等待
  // 读 handle.child、'close' 仅晚 'exit' 数毫秒，远在 ~10s 预算内。）
  child.on('close', (code, signal) => {
    if (handle.child !== child) return; // 已被 'error' 处理器接管
    settleLaunchReady(handle, false); // 进程没了：放行启动队列的下一个
    const wasClosing = handle.closePending;
    const wasParked = handle.coreParked;
    const wasPausing = handle.pausePending;
    const wasRestarting = handle.restartPending;
    const wasColdStandby = handle.coldStandbyPending || handle.coldStandbyActive;
    handle.child = undefined;
    // 核心退出 = 它的浏览器也没了 = 槽位空出来了：立刻叫队头（停止 / 暂停 / 崩溃都算）。
    setTimeout(() => drainSlotWaiters(), 0);
    handle.browserParkingReady = false;
    handle.browserPersonaNoticeState = null;
    resetPersonaNoticeGrace(handle);
    // 主动重启、暂停驻留、冷待机、显式关闭、移出花名册、退出应用都是「有意停止」，不算异常。
    const intentional = isQuitting || wasRestarting || wasPausing || wasParked || wasColdStandby || wasClosing || handle.removed;
    handle.pausePending = false;
    handle.coreParked = false;
    handle.closePending = false;
    const exitedAbnormally = !intentional && (signal != null || (code != null && code !== 0));
    const message = exitMessage(code, signal);
    if (handle.removed) return; // 已摘除的环境不再投影状态

    if (wasColdStandby && !isQuitting && !wasRestarting && !wasPausing && !wasParked && !wasClosing) {
      handle.coldStandbyPending = false;
      handle.coldStandbyActive = true;
      updateStatus(handle, {
        edge: 'stopped',
        session: 'resting',
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
      lastMessage: envInUse
        ? inUseMsg
        : wasClosing
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

    // 有意重启：旧进程退出后按当前设置起新流程（经错峰队列）。退出应用途中绝不再起。
    if (handle.restartPending) {
      handle.restartPending = false;
      if (!isQuitting) void queueLifecycle(() => startFlowForEnv(handle));
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
  // CLI-first：运行时生命周期（起停 / 就绪 / 内核）统一走随包 CLI。先暂存随包模板 + 解析 cliEntry
  // （无论最终复用已在跑的 daemon 还是新起，内核预检都要 cliEntry），再由 ensureRuntime 用 `ads status`
  // 判活：已在跑则复用（adopted）、否则 `ads start`（embedded）。
  // 注：判活读 CLI 自身 pid/store（我方 daemon / 本包上次所起），不探测独立运行的 AdsPower 桌面端——
  //   硬切换自包含形态本不依赖桌面端；若外部桌面端占端口，属超范围的共存冲突，由运营侧收敛。
  // 1. 首启暂存随包模板到可写目录（打包态 Resources 只读）。
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

  // 2. 起内嵌运行时（`ads status` 已在跑则复用、否则 `ads start -k <key>`）。
  if (handle) updateStatus(handle, { auth: 'checking', lastMessage: '正在启动内置指纹浏览器运行时…', ...presencePatch('正在准备浏览器运行时…') });
  const apiKey = resolveAdsApiKey('');
  // 就绪判定走 CLI `ads status`（staging 已把其判活从 `ps|grep "node"` 换成 process.kill(pid,0)，故在
  // Electron 宿主下也可靠——服务进程名是 Electron 二进制而非 "node"，旧的 grep 会漏判、新的存在性探测不受影响）。
  const rt = await adsRuntime.ensureRuntime({
    cliEntry,
    execPath: process.execPath,
    apiKey,
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
    execPath: process.execPath,
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
// 我们自己先前起的服务也没下内核，adopted 直接放行会撞 browser/start「SunBrowser 148 is not ready」）。
// 内核走随包 **CLI**（get-kernel-list / download-kernel）——staging 修好 isRunning 判活后，CLI 命令在
// Electron 宿主下可靠；download-kernel 非 TTY 下逐轮吐 `Kernel progress: N% [state]`，经 onProgress 上进度条。
async function ensureAdsRuntimeAndKernel(handle) {
  const svc = await ensureAdsServiceOnce(handle);
  if (!svc.ok) return svc;
  // 该环境所需内核版本：优先上次 browser/start 诚实报出的版本（handle.neededKernel）——AdsPower profile
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
    // 记下已成功确保就绪的内核版本（已在盘 or 刚下完）。若之后 browser/start 仍报该版本 not ready，
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
  // 服务全局单飞 + 内核按版本单飞（见 ensureAdsServiceOnce / ensureKernelOnce），无需再叠一层全局 once。
  const prep = await ensureAdsRuntimeAndKernel(handle);
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
  clearColdStandbyTimer(handle);
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
  clearColdStandbyTimer(handle);
  // cloudEverConnected 复位：正要换核心，新核心没连过（change honest-first-connect-label）。
  updateStatus(handle, { cloud: 'disconnected', cloudEverConnected: false, session: 'running', respawnGaveUp: false, lastMessage: message, ...presencePatch('正在重启引擎…'), ...clearEdgeFailurePatch(handle), ...patch });
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
  if (message.startsWith('[publish-approval-reply]')) {
    handlePublishApprovalReply(message.slice('[publish-approval-reply]'.length).trim());
    return;
  }
  appendEdgeLog(handle.envId, message, isError); // 落文件（排障回溯，独立于下方状态判断）
  // AdsPower profile 可绑 ≠ DEFAULT_KERNEL 的内核；browser/start 会诚实报「SunBrowser <N> is not ready」。
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
  const next = { edge: halting ? 'warning' : 'running', lastMessage: message };
  if (!halting && handle.status.edgeFailure) next.edgeFailure = null;
  if (message.includes('[browser-parking] awaiting-login')) {
    // adspower 首登有界等待门（change adspower-first-login-wait-gate）：核心在等操作者扫码登录、浏览器与 CDP 仍在。
    // 诚实呈现「待登录」，绝不加任何 respawn 抑制（核心不退出，respawn 本就不触发；超时走干净停止码亦不重起）。
    next.auth = 'login required';
    next.presence = { text: '请在浏览器里扫码登录', at: new Date().toISOString() };
  }
  if (message.includes('已连接云端') || message.includes('已握手') || message.includes('云端已重连')) {
    next.cloud = 'connected';
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
  if (message.includes('连接失败') || message.includes('WS 已关闭') || message.includes('启动失败')) next.cloud = 'disconnected';
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
  const evt = handle.uiEvents.push(message);
  let standbyHint = null;
  if (evt) {
    if (evt.account) {
      // 账号标签兜底链：平台昵称（navigate 身份路径才有）> AdsPower 环境名 > 渲染层再兜尾4位。
      const name = evt.account.name || handle.name || '';
      handle.status.account = { id: evt.account.id, name, source: evt.account.name ? 'xhs' : 'env' };
      // 身份确立 = 登录态权威信号（核心读不出登录身份会诚实退出、不会走到这行），据此翻登录态。
      // adspower 路径此前无人写 'logged in'（cookie 门是 self 专属），人设闸因此永不开——修于本 change。
      next.auth = 'logged in';
      refreshSameAccountWarnings();
      // 环境名跟随真实昵称（change edge-adspower-name-follows-nickname）：读到平台真实昵称（evt.account.name
      // 非空 = source 'xhs'）且与 AdsPower 环境名不一致时，经写客户端改名封装把该环境名改成昵称。
      // 幂等去抖（名已一致不发）+ 诚实降级（写失败保持原名、不重试风暴、不阻塞浏览闭环）；fire-and-forget，
      // 不 await（受写客户端 ≥1.1s 串行节流，不阻塞消息处理）。
      if (evt.account.name) maybeRenameEnvToNickname(handle, evt.account.name);
    }
    // 人设绑定态（change persona-bound-tristate）：云端 true / false 都下发，双向采纳——云端是单写方，
    // 解绑必须能传下来（否则客户端会一直显示「已设置」，而云端早已按未绑停了这个号）。
    if (typeof evt.personaBound === 'boolean') next.personaBound = evt.personaBound;
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
    if (evt.loopStage !== undefined) next.loopStage = evt.loopStage;
    // 阻断浮层（登录/验证码/未知阻断）待人工处理：核心成对信号驱动（`popup` 置真 / `popup_cleared`
    // 或会话结束或有成功互动 置假），使该环境在环境栏浮顶为「需人工」而非绿色在线（红线：多环境跨窗
    // 盯验证码正是本控制台的核心目的）。
    if (evt.type === 'popup') next.overlayBlocked = true;
    else if (evt.type === 'popup_cleared' || evt.type === 'session_end' || evt.statsDelta) next.overlayBlocked = false;
  }
  updateStatus(handle, next);
  if (standbyHint) applyBrowserStandbyHint(handle, standbyHint);
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
  clearColdStandbyTimer(handle);
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
  // kernelPrep 显式清零：若在内核缺失 respawn 退避窗口内暂停，会 clearRespawnTimer 掐掉唯一会清 kernelPrep 的
  // 预检重启，残留 pending 会让机器级全局进度条永久显示「正在下载内核 N…0%」（实则无下载在进行）。
  updateStatus(handle, {
    edge: 'stopped',
    session: 'paused',
    overlayBlocked: false,
    kernelPrep: null,
    lastMessage: '已暂停自动启动；当前没有运行中的边缘进程。',
    ...presencePatch('已暂停，随时可以恢复'),
    ...clearEdgeFailurePatch(handle),
  });
}

function resumeEdge(handle) {
  if (!handle) return;
  handle.stopRequested = false;
  clearRespawnTimer(handle);
  clearColdStandbyTimer(handle);
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

/**
 * 无核心子进程时的诚实关闭核实（红线：绝不零回收假报已关）。该 profile 的浏览器由外部 AdsPower 运行时
 * 托管、会在核心死亡（如暂停驻留期崩溃）后存活。经**只读** browser/local-active 查其是否真的不在跑：
 * 确认不在跑才判「已关闭」；仍在跑则如实报「浏览器仍在运行、恢复接管后再关」；查不动则如实报「无法确认」。
 * 外壳只读 ads-local-api 边界不破：这里只读、不发停止；真关闭仍由（恢复后的）核心权威执行。
 */
async function confirmOwnedProfileClosedFromShell(handle) {
  updateStatus(handle, {
    lastMessage: '正在确认浏览器是否已关闭…',
    ...presencePatch('正在确认浏览器状态…'),
  });
  const res = await adsApi.listActiveProfiles(resolveAdsOpts()).catch(() => null);
  // 期间被启动 / 恢复 / 移出（start/resume 会把 stopRequested 复位为 false）：交给新流程，勿覆盖更新后的状态。
  if (handle.child || handle.removed || !handle.stopRequested) return;
  // 仅在拿到**结构良好**的在跑分身列表时才据其判定；code:0 但 data.list 缺失/非数组不算「确认为空」，
  // 绝不把不完整列表当已关（红线：不完整列表 ≠ 已关，防孤儿浏览器被假报已关）。
  const active =
    res && res.ok && res.listWellFormed && Array.isArray(res.activeUserIds) ? res.activeUserIds : null;
  if (active && active.includes(handle.profileId)) {
    // 分身确在跑但无核心可关：诚实报未关（保持暂停——浏览器开着、自动运营停着），引导恢复接管后再关。
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
  updateStatus(handle, {
    edge: 'warning',
    session: 'paused',
    lastMessage: '无法确认浏览器关闭状态；可点「恢复」接管后再关闭，或重启客户端。',
    ...edgeFailurePatch('无法确认浏览器关闭状态'),
    ...presencePatch('关闭状态未能确认'),
  });
}

function closeEdge(handle) {
  if (!handle || handle.closePending || handle.status.session === 'closed') return;
  handle.restartPending = false;
  handle.stopRequested = true;
  stopLoginPoller();
  clearRespawnTimer(handle);
  clearColdStandbyTimer(handle);
  if (!handle.child) {
    handle.coreParked = false;
    // 无核心子进程：adspower 分身浏览器由外部运行时托管、会在核心死亡后存活。MUST NOT 零回收假报已关——
    // 经**只读** browser/local-active 诚实核实后再判定；确认不在跑才判已关，仍在跑/查不动都如实回报。
    if (handle.kind === 'adspower' && handle.profileId) {
      void confirmOwnedProfileClosedFromShell(handle);
      return;
    }
    updateStatus(handle, {
      edge: 'stopped',
      cloud: 'disconnected',
      session: 'closed',
      overlayBlocked: false,
      kernelPrep: null, // 同 pauseEdge：清掉退避窗口内被掐断的内核缺失 respawn 残留的 pending 进度条
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
 * 「全部启动」：全部未在跑环境进**串行启动队列**（起完一个再起下一个）；装不下的**进等槽位队列**。
 *
 * 注意（change browser-slot-scheduling）：真正的准入闸在启动队列里、每个环境逐个过——**没有任何路径
 * 能绕过它**（旧版这道闸只长在这一个按钮上，单启 / 唤醒 / 崩溃重起全部绕过去了）。
 *
 * 这里**不再整批拦阻**：挂 12 个账号、只有 6 个槽位，正确结果是「起 6 个、另 6 个排队等槽位」，
 * 而不是「一个都不给起」。哪些起得来由逐个过的准入闸说了算，起不来的不丢弃、进等槽位队列。
 * （force 仍保留：运维明确要求越过内存闸时逐个 force 放行。）
 */
function startAllEnvs({ force = false } = {}) {
  const paused = [...envs.values()].filter((h) => h.child && h.status.session === 'paused' && !h.removed);
  const targets = [...envs.values()].filter((h) => !h.child && !h.removed);
  if (targets.length === 0 && paused.length === 0) return { ok: true, queued: 0 };
  const cap = slotCapacity();
  // 账号上限（缺省 = 2 × 槽位，可在设置里改）：超过即存在「永远排不上」的风险，必须诚实告警而非静默接受。
  const accountCap = maxAccounts();
  const configured = [...envs.values()].filter((h) => !h.removed).length;
  if (configured > accountCap) {
    console.warn(
      `[slots] ⚠ 已配置 ${configured} 个环境，超过账号上限 ${accountCap}（${cap} 槽位）：` +
        '部分账号可能长期排不到浏览器槽位。',
    );
  }
  paused.forEach((h) => resumeEdge(h));
  // force = 运维明确要求越过内存闸超额拉起。经 handle 上的一次性标记传到队列里的准入闸
  // （启动流程中间隔着 AdsPower 运行时准备等好几层，不值得为它一路加参数）。
  targets.forEach((h, i) => {
    if (force) h.forceLaunch = true;
    queueStartEnv(h, i + 1);
  });
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
ipcMain.handle('settings:get', () => ({
  ...settings,
  adsDownloadUrl: ADS_DOWNLOAD_URL,
  cloudEnv: cloudSelectionView(),
  // 浏览器并发：把**算出来的**两个上限连同来源一起给界面，让它能如实说「自动推算 N」还是「你设的 N」，
  // 而不是让渲染层自己再算一遍（两处各算一遍必然漂移）。
  slots: {
    ...slotSettingsView(),
    occupied: occupiedSlots(),
    configured: [...envs.values()].filter((h) => !h.removed).length,
  },
  appVersion: app.getVersion(),
}));

// 对外客户鉴权（change edge-client-customer-auth）：登录窗口调 login；主进程做 HTTP，成功后拉可见环境 + 建主窗 + 关登录窗。
ipcMain.handle('client-auth:login', async (_event, creds) => {
  const name = String((creds && creds.name) || '').trim();
  const key = String((creds && creds.key) || '');
  if (!name || !key) return { ok: false, reason: 'invalid_credentials' };
  const r = await clientAuthFetch('/login', { method: 'POST', body: { name, key } });
  if (r.status === 200 && r.data && r.data.token) {
    const ttl = Number(r.data.expiresIn) || 900;
    saveClientLoginPrefill({ name, key });
    saveClientSession({ token: r.data.token, name, expiresAt: Date.now() + ttl * 1000 });
    await proceedAfterAuth();
    if (loginWindow) { try { loginWindow.close(); } catch { /* ignore */ } loginWindow = null; }
    return { ok: true };
  }
  if (r.status === 429) return { ok: false, reason: 'rate_limited', retryAfter: (r.data && r.data.retryAfter) || 30 };
  if (r.status === 0) return { ok: false, reason: 'network' };
  // 登录侧 401 一律不可区分（防枚举）；停用在受保护请求侧才显现。
  return { ok: false, reason: 'invalid_credentials' };
});
ipcMain.handle('client-auth:logout', async () => {
  if (clientSession && clientSession.token) {
    void clientAuthFetch('/logout', { method: 'POST', token: clientSession.token });
  }
  onSessionInvalid();
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
ipcMain.handle('settings:save', async (_event, patch) => {
  const beforeIds = new Set((settings.environments || []).map((e) => e.profileId).filter(Boolean));
  const res = saveSettings(patch);
  // 自动归属（change edge-client-customer-auth）：登录态下新增的环境归当前客户,并乐观即时可见。
  // 只对「本次新出现的 profileId」登记；已有环境不重复。这里必须 await：否则创建成功后紧接着刷新可见集时，
  // 云端归属可能尚未写入，登录态列表会按旧 scope 过滤掉刚创建的环境。
  const attachErrors = [];
  if (clientAuthEnabled() && hasValidSession() && allowedProfileIds) {
    for (const env of settings.environments) {
      if (env.profileId && !beforeIds.has(env.profileId)) {
        const attach = await attachClientEnvironmentToCurrentUser({
          userId: env.profileId,
          name: env.name,
          platform: env.platform,
        });
        if (!attach.ok) attachErrors.push(attach.error || '分配给当前用户失败');
      }
    }
  }
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
    // 并发上限改了要立刻回给界面**重算后的**值（缓存已在归一时作废）——否则界面还显示旧的推算数。
    slots: {
      ...slotSettingsView(),
      occupied: occupiedSlots(),
      configured: [...envs.values()].filter((h) => !h.removed).length,
    },
    saveOk: res.ok && attachErrors.length === 0,
    saveError: res.error || attachErrors[0],
  };
});
// 「全部重启并连接新云端」（change edge-cloud-env-selector）：切换云端后显式把全部在跑 / 退避中的环境
// 有序重启，使其按新选择重新解析云端地址连接——避免部分环境连旧云、部分连新云的裂脑。
ipcMain.handle('cloud:restartAll', () => {
  const targets = [...envs.values()].filter((h) => (h.child || h.respawnTimer) && !h.removed);
  for (const h of targets) stopAndRestart(h, '正在按新云端重启边缘进程…');
  return { ok: true, restarted: targets.length, cloudEnv: cloudSelectionView() };
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
ipcMain.handle('publish:approval', (_event, envId, payload) => {
  const requestId = String(payload && payload.requestId || '').trim();
  const approved = payload && payload.approved;
  const contentVersion = payload && payload.contentVersion;
  if (!/^publish-\d+$/.test(requestId) || typeof approved !== 'boolean') {
    return { ok: false, reason: 'invalid_request' };
  }
  if (contentVersion !== undefined && (!Number.isInteger(contentVersion) || contentVersion < 0)) {
    return { ok: false, reason: 'invalid_version' };
  }
  return sendPublishApprovalCommand(envId, {
    requestId,
    approved,
    contentVersion: contentVersion === undefined ? 0 : contentVersion,
  });
});
// 预览内删除某张配图（change client-preview-image-delete）。云端才是权限 / 版本 / 只删不注入 /
// 最后一张不可删的权威；这里只做入参形状校验 + 成功后就地刷新预览真态。
ipcMain.handle('publish:image-remove', async (_event, envId, payload) => {
  const requestId = String((payload && payload.requestId) || '').trim();
  const imageUrl = typeof (payload && payload.imageUrl) === 'string' ? payload.imageUrl.trim() : '';
  const contentVersion = payload && payload.contentVersion;
  if (!/^publish-\d+$/.test(requestId) || !imageUrl) {
    return { ok: false, reason: 'invalid_request' };
  }
  if (!Number.isInteger(contentVersion) || contentVersion < 0) {
    return { ok: false, reason: 'invalid_version' };
  }
  const result = await sendPublishClientCommand(envId, 'publish.draft_image_remove', {
    requestId,
    contentVersion,
    imageUrl,
  });
  if (result && result.ok) {
    const recordId = Number(requestId.slice('publish-'.length));
    applyPublishPreviewImages(envId, recordId, result.images, result.contentVersion);
  }
  return result;
});

async function delegatedTaskRequest(envId, pathname, options = {}) {
  const handle = resolveHandle(envId);
  if (!handle || !handle.profileId) return { ok: false, status: 400, error: 'selected_environment_required' };
  if (!clientAuthEnabled() || !hasValidSession()) return { ok: false, status: 401, error: 'client_session_required' };
  const suffix = pathname.includes('?') ? '&' : '?';
  const scopedPath = options.includeEnvQuery
    ? `${pathname}${suffix}envKey=${encodeURIComponent(handle.profileId)}`
    : pathname;
  const r = await clientAuthFetch(scopedPath, {
    method: options.method || 'GET',
    token: clientSession.token,
    ...(options.body ? { body: { ...options.body, envKey: handle.profileId } } : {}),
  });
  if (r.status === 401) return { ok: false, status: 401, error: 'client_session_expired' };
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: (r.data && (r.data.message || r.data.error)) || r.error || 'request_failed',
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
  const result = await adsApi.listProfiles(resolveAdsOpts(opts));
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
    result.physicalUserIds = (result.profiles || []).map((p) => p && p.userId).filter((id) => id && knownIds.has(id));
    result.profiles = (result.profiles || []).filter((p) => p && allowedProfileIds.has(p.userId));
  }
  return result;
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
  // 账号上限是**唯一**该硬性拒绝的地方（change browser-slot-scheduling）：
  // 槽位不够只是「现在轮不到你」——该排队；账号挂满了才是「这台机器不该再多带一个」——该拒绝。
  // 上限可在设置里改，所以这不是死路，运维知道该去哪调。
  const accountCap = maxAccounts();
  const configured = [...envs.values()].filter((h) => !h.removed).length;
  if (configured >= accountCap) {
    return {
      ok: false,
      error: `已挂载 ${configured} 个账号，达到上限 ${accountCap}（${slotCapacity()} 个浏览器槽位 × 2）。`
        + '如确要再挂，请到设置「浏览器并发」里调高「最多挂载账号数」——但超出后部分账号可能长期排不到槽位。',
    };
  }
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
      const result = await createEnvironmentWithGroupRecovery({
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
      if (result && result.ok) {
        const attach = await attachClientEnvironmentToCurrentUser({
          userId: result.userId,
          name: result.name,
          platform: result.platform || platform,
        });
        return withClientAttachment(result, attach);
      }
      return result;
    }

    const created = [];
    const attachErrors = [];
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
        name: result.name,
        template: result.template,
        platform: result.platform,
      });
      const attach = await attachClientEnvironmentToCurrentUser({
        userId: result.userId,
        name: result.name,
        platform: result.platform || platform,
      });
      if (!attach.ok) attachErrors.push(`第 ${i + 1} 行：${attach.error || '分配给当前用户失败'}`);
    }
    return {
      ok: true,
      userId: created.length === 1 ? created[0].userId : undefined,
      // 单账号导入自动选中时带回真名，供渲染层入册用真名（change edge-env-name-live-sync）。
      name: created.length === 1 ? created[0].name : undefined,
      template: (opts && opts.templateKey) || '',
      platform,
      created,
      createdCount: created.length,
      assignedToCurrentClient: attachErrors.length === 0 && created.length > 0 && clientAuthEnabled() && hasValidSession(),
      visibilityWarning: attachErrors.length
        ? `已创建 ${created.length} 个环境，但有 ${attachErrors.length} 个未能分配给当前用户，刷新后可能暂不可见。`
        : undefined,
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
    // 登录门前置门控（change edge-client-customer-auth）：启用且无有效会话 → 只显示登录门，
    // 不连云、不建主窗、不 syncEnvHandles；登录成功由 IPC 回调走 proceedAfterAuth()。未 gated 或已登录 → 正常流程。
    if (clientAuthEnabled() && !hasValidSession()) {
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
