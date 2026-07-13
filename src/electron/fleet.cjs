/**
 * fleet.cjs — 多环境（edge-multi-environment-fleet）外壳侧纯决策层。
 *
 * 只放**可单测的纯逻辑**，不 require electron：
 *  - 设置迁移/归一：单值 adsProfileId ↔ 环境花名册 environments 列表（向后兼容加载）；
 *  - 每环境冻结 spawn env 构建 + 身份闸：无法派生唯一稳定 edgeId（ads-<分身id>）则拒绝，
 *    绝不让子进程回落 host-<主机名> 共享身份（云端会互踢串号）；
 *  - AdsPower 生命周期错峰串行队列（相邻 ≥1.1s，避开本机 ~1req/s 限频；单任务失败不阻塞队列）；
 *  - 「全部启动」内存上限预检（headful 每环境 ~1GB，超限诚实拦阻而非拖垮）；
 *  - 同账号铺多环境检测（云端会合并风控/配额预算，两行并非独立——必须告警）；
 *  - decideRespawn：与 src/supervise/respawn-policy.ts **语义逐位一致的 CJS 副本**
 *    （Electron 主进程是 CJS、无法 require 编译后的 ESM；由 test/electron/fleet.test.ts
 *    的 parity 用例锁住两份不漂移）。
 */
'use strict';

/** envId 公式（与核心 deriveEdgeId 的 adspower 分支同构；唯一 + 跨重启稳定）。 */
function envIdForProfile(profileId) {
  return `ads-${String(profileId).trim()}`;
}

/** 归一单个环境成员：{ profileId, name, platform }；profileId 空则返回 null。 */
function normalizeEnvironment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const profileId = String(raw.profileId ?? raw.userId ?? '').trim();
  if (!profileId) return null;
  const platformRaw = String(raw.platform ?? '').trim().toLowerCase();
  return {
    profileId,
    name: typeof raw.name === 'string' ? raw.name : '',
    platform: platformRaw === 'facebook' || platformRaw === 'fb' ? 'facebook' : 'xiaohongshu',
  };
}

/** 归一花名册：去非法项 + 按 profileId 去重（同一分身 MUST NOT 出现两次，防 edgeId 撞车）。 */
function normalizeEnvironments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const env = normalizeEnvironment(raw);
    if (!env || seen.has(env.profileId)) continue;
    seen.add(env.profileId);
    out.push(env);
  }
  return out;
}

/**
 * 设置迁移（向后兼容加载）：
 *  - 已有合法 environments 数组 → 用之（归一去重）；
 *  - 否则旧单值 adsProfileId 非空 → 兼容加载为单元素花名册（带旧环境名/平台）。
 * 返回新的 environments（不改入参）。
 */
function migrateEnvironments(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  if (Array.isArray(p.environments)) {
    const envs = normalizeEnvironments(p.environments);
    if (envs.length > 0 || String(p.adsProfileId ?? '').trim() === '') return envs;
  }
  const legacy = normalizeEnvironment({
    profileId: p.adsProfileId,
    name: p.adsProfileName,
    platform: p.platform,
  });
  return legacy ? [legacy] : [];
}

/** 花名册镜像回旧单值字段（回滚兼容：降级到旧版本仍能读到首个环境）。 */
function legacyMirrorOf(environments) {
  const first = Array.isArray(environments) && environments.length > 0 ? environments[0] : null;
  return {
    adsProfileId: first ? first.profileId : '',
    adsProfileName: first ? first.name : '',
    platform: first ? first.platform : 'xiaohongshu',
  };
}

/**
 * Facebook 自动浏览策略：只允许已解析为 dev 的 Facebook 子进程真浏览/点赞。
 * 此处刻意不读取 process.env，调用方会把结果写入最终 spawn env，以阻断外壳残留值泄漏到 ol/custom。
 */
function facebookBrowseModeFor({ platform, cloudEnvKey } = {}) {
  const normalizedPlatform = String(platform ?? '').trim().toLowerCase();
  const normalizedCloudEnvKey = String(cloudEnvKey ?? '').trim().toLowerCase();
  return (normalizedPlatform === 'facebook' || normalizedPlatform === 'fb') && normalizedCloudEnvKey === 'dev'
    ? 'on'
    : 'off';
}

/** spawn 时必须从继承环境里剔除的键：任何一个泄漏进多环境子进程都会让身份/端口被钉死而串号。 */
const ENV_KEYS_MUST_DROP = [
  'AIDCP_ACCOUNT_ID', // 身份由登录读出，绝不由启动方指派
  'AIDCP_EDGE_ID', // 外部设了会让 N 个环境同 edgeId → 云端互踢
  'AIDCP_ADS_USER_ID', // 外部残留会覆盖每环境注入值
  'AIDCP_ADS_USER_IDS',
  'AIDCP_CDP_PORT', // AdsPower 每分身动态返回调试端口
  'AIDCP_CHROME_PROFILE', // AdsPower 自管 user-data-dir
  'AIDCP_CDP_ALLOW_REUSE',
];

/**
 * 构建一个环境的冻结 spawn env。
 * 输入：{ environment, processEnv, providerEnv }
 *  - environment: { profileId, name, platform }（花名册成员）
 *  - processEnv: 外壳继承环境（拷贝后剔除身份/端口键；其余仍作逃生阀继承，如 AIDCP_CLOUD_URL）
 *  - providerEnv: 外壳按设置推导的通用注入（停放/平台/API base 等；平台会被环境自身 platform 覆盖）
 * 身份闸：profileId 为空 → 返回 { ok:false, reason }（诚实拒绝，绝不回落 host-<hostname>）。
 */
function buildEnvSpawnEnv({ environment, processEnv, providerEnv }) {
  const env = normalizeEnvironment(environment);
  if (!env) {
    return {
      ok: false,
      reason: '该环境缺少分身 ID，无法派生唯一稳定的边缘身份（将回落主机名共享身份），已拒绝启动。',
    };
  }
  const merged = { ...(providerEnv || {}), ...(processEnv || {}) };
  for (const key of ENV_KEYS_MUST_DROP) delete merged[key];
  merged.AIDCP_ADS_USER_ID = env.profileId; // 核心据此派生 AIDCP_EDGE_ID=ads-<分身id>
  merged.AIDCP_BROWSER_PROVIDER = 'adspower';
  merged.AIDCP_PLATFORM = env.platform;
  return { ok: true, env: merged, envId: envIdForProfile(env.profileId) };
}

/** AdsPower 本地 API 限频 ~1req/s → 错峰间隔取 1.1s（与 ads-local-api.cjs 同一口径）。 */
const DEFAULT_STAGGER_MS = 1100;

/**
 * 外壳级错峰串行队列：任务逐个执行、相邻任务**开始**间隔 ≥ spacingMs。
 * 单任务 throw 被吞成 { ok:false, error }（一个环境启动失败 MUST NOT 阻塞其余）。
 * 注入 now/sleep 便于单测；等待按「上次开始时刻 + spacing − now」一次算清，不循环轮询。
 */
function createStaggerQueue(opts = {}) {
  const spacingMs = Number.isFinite(opts.spacingMs) ? opts.spacingMs : DEFAULT_STAGGER_MS;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastStartAt = -Infinity;
  let chain = Promise.resolve();
  let pending = 0;

  function enqueue(fn) {
    pending += 1;
    const run = chain.then(async () => {
      const wait = lastStartAt + spacingMs - now();
      if (wait > 0) await sleep(wait);
      lastStartAt = now();
      try {
        return await fn();
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      } finally {
        pending -= 1;
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return { enqueue, pendingCount: () => pending };
}

/** headful 单环境内存估值（Phase 0 未实测前取设计缺省 ~1GB；实测后可在此收口调参）。 */
const PER_ENV_BYTES_DEFAULT = 1024 * 1024 * 1024;

/**
 * 「全部启动」内存上限预检：预计新增在跑数 × 单环境估值 是否超过本机可用内存。
 * 超限 → { ok:false }（调用方诚实拦阻/让运维确认），绝不静默超额拉起。
 */
function ramAdmission({ plannedCount, freeBytes, perEnvBytes = PER_ENV_BYTES_DEFAULT }) {
  const planned = Math.max(0, Math.floor(Number(plannedCount) || 0));
  const required = planned * perEnvBytes;
  const free = Math.max(0, Number(freeBytes) || 0);
  return {
    ok: required <= free,
    requiredBytes: required,
    freeBytes: free,
    requiredMB: Math.round(required / (1024 * 1024)),
    freeMB: Math.round(free / (1024 * 1024)),
  };
}

/**
 * 同账号铺多环境检测：输入 [{ envId, accountId }]，返回重复组 [{ accountId, envIds }]。
 * 云端对同账号多连接会合并风控/配额、发布只定向最早那条边缘——两行并非独立，必须告警。
 */
function duplicateAccountGroups(entries) {
  const byAccount = new Map();
  for (const e of entries || []) {
    const accountId = e && typeof e.accountId === 'string' ? e.accountId.trim() : '';
    if (!accountId || !e.envId) continue;
    if (!byAccount.has(accountId)) byAccount.set(accountId, []);
    byAccount.get(accountId).push(e.envId);
  }
  return [...byAccount.entries()]
    .filter(([, envIds]) => envIds.length > 1)
    .map(([accountId, envIds]) => ({ accountId, envIds }));
}

/**
 * 有界重起决策 —— 与 src/supervise/respawn-policy.ts 逐位同语义的 CJS 副本
 * （parity 由 test/electron/fleet.test.ts 锁住；改任一份必须同步另一份）。
 */
function decideRespawn(input, opts) {
  if (input.shuttingDown) return { action: 'stop', streak: input.prevStreak };
  const baseStreak = input.uptimeMs >= opts.healthyUptimeMs ? 0 : input.prevStreak;
  if (input.exitCode === 0) return { action: 'stop', streak: baseStreak };
  const streak = baseStreak + 1;
  if (streak > opts.maxConsecutiveFailures) return { action: 'give-up', streak };
  const delayMs = Math.min(opts.backoffMaxMs, opts.backoffBaseMs * 2 ** (streak - 1));
  return { action: 'respawn', delayMs, streak };
}

/**
 * 识别 AdsPower「同账号并发占用拒启」——该分身已被同一账号在别处（另一台机 / 另一实例 /
 * 桌面端窗口）打开、不允许并发打开（`browser/start` 返回 code≠0，msg 含
 * `is being used by [<account>] and is not allowed to open`）。这是**不可重起终局**：
 * 重起不会自愈，看护据此即刻诚实停止、不重试、不消耗失败预算。
 * 双命中闸（拒启签名 + `browser/start` 失败上下文）避免把无关「失败」串误判为终局。
 * 返回 `{ inUse, account }`；account 从 `is being used by [<account>]` 解析（解析不到则 undefined）。
 * 纯函数、可单测。
 */
function classifyAdsInUse(line) {
  const raw = String(line || '');
  // 拒启签名：AdsPower 英文原文（not allowed to open / is being used by）或中文本地化（正在使用 / 已打开）。
  const rejectSig = /not allowed to open|is being used by|being used|正在使用|已打开/i.test(raw);
  // 上下文闸：须是 browser/start 启动失败行，避免与无关「失败」串误命中（如连云失败）。
  const startCtx = /browser\/start|browser\.start|启动失败/i.test(raw);
  if (!rejectSig || !startCtx) return { inUse: false };
  const m = /is being used by\s*\[([^\]]+)\]/i.exec(raw);
  const account = m ? m[1].trim() : undefined;
  return { inUse: true, account };
}

/** 配图临时目录命名空间（与 src/main.ts 的 imageTempPrefix 同公式；见 fleet.test.ts 契约用例）。 */
function imageTempNamespace(edgeId) {
  const safe = String(edgeId || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  return safe || 'default';
}

module.exports = {
  DEFAULT_STAGGER_MS,
  PER_ENV_BYTES_DEFAULT,
  ENV_KEYS_MUST_DROP,
  envIdForProfile,
  normalizeEnvironment,
  normalizeEnvironments,
  migrateEnvironments,
  legacyMirrorOf,
  facebookBrowseModeFor,
  buildEnvSpawnEnv,
  createStaggerQueue,
  ramAdmission,
  duplicateAccountGroups,
  decideRespawn,
  classifyAdsInUse,
  imageTempNamespace,
};
