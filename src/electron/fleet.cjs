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

const os = require('node:os');
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
  const platform = platformRaw === 'facebook' || platformRaw === 'fb'
    ? 'facebook'
    : platformRaw === 'wechat_channels' || platformRaw === 'wechat-channels' || platformRaw === 'wechat'
      ? 'wechat_channels'
      : 'xiaohongshu';
  return {
    profileId,
    name: typeof raw.name === 'string' ? raw.name : '',
    platform,
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

/**
 * headful 单环境内存估值。运营实测口径 ~700MB（change browser-slot-scheduling；旧值 1GB 是没量过的
 * 设计缺省，偏保守会白白少开 2–3 个环境）。可用 AIDCP_PER_ENV_MB 覆盖。
 */
const PER_ENV_BYTES_DEFAULT = 700 * 1024 * 1024;

// ── 可用内存读数 ────────────────────────────────────────────────────────────────
//
// 红线：**不要用 os.freemem() 当「可用内存」**。它只统计完全空闲的物理页；macOS / Linux 都会把
// 绝大部分空闲内存拿去做文件缓存（inactive / page cache），这些页随时可回收、却不计入 freemem。
// 后果不是少开几个浏览器，而是**整台机器一个浏览器都开不了**：一台 16GB、系统自报可用 48% 的 Mac，
// os.freemem() 只报 ~220MB < 单环境 700MB → 每一条开浏览器路径都被内存闸拦死。
// （browser-slot-scheduling 把内存闸从「只在全部启动、可 force 越过」收成「全路径必经、无绕过口」
//  之后，这个一直存在的错误读数才第一次真的把机器锁死。）
//
// 正确读法按平台取「可回收后真正能用的量」：
//   linux  → /proc/meminfo 的 MemAvailable（内核自己算好的，最权威）
//   darwin → vm_stat 的 free + inactive + speculative（inactive 是干净可回收的文件缓存）
//   其它   → 回落 os.freemem()（宁可保守拦阻，也不假装内存充裕）

/** 读数缓存 TTL：准入闸每次开浏览器都会问一次，别每次都 spawn 一个 vm_stat。 */
const MEM_READ_TTL_MS = 3_000;

/**
 * 给操作系统与外壳自身留的余量：准入闸放行「最后一个」浏览器时，不该把机器压到一点余地都没有
 * （macOS 会转而狂压缩 / 换页，表现成「莫名其妙的卡顿与掉浏览器」）。AIDCP_MEM_RESERVE_MB 可覆盖，
 * 设 0 即不留。
 */
const MEM_RESERVE_BYTES_DEFAULT = 512 * 1024 * 1024;

/** 解析 `vm_stat` 输出 → 可用字节数。纯函数，供单测直接喂样本。解析失败返回 0（调用方回落）。 */
function parseVmStatAvailableBytes(text) {
  const s = String(text || '');
  const pageSize = Number(/page size of (\d+) bytes/.exec(s)?.[1]) || 4096;
  const pages = (label) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(s)?.[1]) || 0;
  const free = pages('free');
  const inactive = pages('inactive');
  const speculative = pages('speculative');
  if (free + inactive + speculative <= 0) return 0;
  return (free + inactive + speculative) * pageSize;
}

/** 解析 `/proc/meminfo` → MemAvailable 字节数。纯函数。解析失败返回 0（调用方回落）。 */
function parseMemAvailableBytes(text) {
  const kb = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(String(text || ''))?.[1]) || 0;
  return kb > 0 ? kb * 1024 : 0;
}

let memCache = { at: -Infinity, bytes: 0 };

/**
 * 本机**真实可用内存**（含可回收缓存），带 TTL 缓存。deps 可注入，供单测脱离真机。
 * 任何平台探测失败一律回落 os.freemem()——读数只能偏保守，绝不能假装内存充裕。
 */
function availableMemoryBytes(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const platform = deps.platform || process.platform;
  const freemem = typeof deps.freemem === 'function' ? deps.freemem : os.freemem;
  const exec = typeof deps.exec === 'function' ? deps.exec : null;
  const readFile = typeof deps.readFile === 'function' ? deps.readFile : null;
  const cache = deps.cache || memCache;

  const t = now();
  if (cache.bytes > 0 && t - cache.at < MEM_READ_TTL_MS) return cache.bytes;

  let bytes = 0;
  try {
    if (platform === 'linux') {
      const read = readFile || ((p) => require('node:fs').readFileSync(p, 'utf8'));
      bytes = parseMemAvailableBytes(read('/proc/meminfo'));
    } else if (platform === 'darwin') {
      const run = exec || ((cmd) => require('node:child_process').execFileSync(cmd, { encoding: 'utf8', timeout: 2_000 }));
      bytes = parseVmStatAvailableBytes(run('vm_stat'));
    }
  } catch {
    bytes = 0; // 探测失败 → 回落
  }
  if (!(bytes > 0)) bytes = Math.max(0, Number(freemem()) || 0);

  cache.at = t;
  cache.bytes = bytes;
  return bytes;
}

/** 扣掉给系统留的余量后、真正可拿来开浏览器的内存。 */
function usableMemoryBytes(deps = {}) {
  const envReserve = Number(process.env.AIDCP_MEM_RESERVE_MB);
  const reserve = Number.isFinite(envReserve) && envReserve >= 0
    ? envReserve * 1024 * 1024
    : MEM_RESERVE_BYTES_DEFAULT;
  return Math.max(0, availableMemoryBytes(deps) - reserve);
}

/** 并行槽位 : 可设置账号数 = 1:2（用户定案）。 */
const ACCOUNTS_PER_SLOT = 2;

/**
 * 槽位/内存不够时该怎么办：**一律排队等，谁都不判失败。**
 *
 * 「槽位被别人占着」不是一个失败原因，它是一个**排队**原因。判失败的判据只能是「结构上做不到」，
 * 绝不能是「你是谁」。上一版按「有没有人在死线上等」分流（task/manual → 判失败），是把
 * **「有人在等」**误当成了**「所以这次该失败」**——两者毫无因果关系：一个排在队里的任务，
 * 和一个不可能完成的任务，是两件完全不同的事。
 *
 * 调用方的死线（云端 acquire 计时器）当然是真实约束，但它只决定 **什么时候回话**，
 * **绝不决定要不要把浏览器开起来**：死线到了就诚实告诉调用方「这次没轮到你，稍后自动重试」，
 * 而那台浏览器**照常继续起、环境照常留在队列里**——它正是下一次重试要命中的东西。
 * 撤销唤醒是双输：这次没做成，下次还得从冷启重来。
 *
 * 因此这里没有 policy 函数可写。判据只剩两条，都不在这个热路径上：
 *  · 结构性拒绝 = 挂载账号数超上限（配置期的闸，见外壳 ads:createEnv）；
 *  · 诚实失败 = 调用方自己的死线到了 / 唤醒真的失败（浏览器起不来）。
 */

/**
 * 等槽位队列 FIFO：按入队时刻排。
 *
 * **严格先来后到，不设优先级**。带死线的唤醒在 12 账号的机器上是**连续到达**的——一旦让它们插队，
 * 1:2 里多挂的那一半（纯等待者）会被无限期挤到后面、永远排不上，而且没有任何告警会说这件事。
 * 死线只决定「什么时候回话」，不换取「插到别人前面」。
 */
function orderSlotWaiters(waiters) {
  return [...(waiters || [])].sort((a, b) => (a.slotWaitingSince || 0) - (b.slotWaitingSince || 0));
}

/**
 * 槽位上限 = ⌊可用内存 ÷ 单环境估值⌋（change browser-slot-scheduling）。
 *
 * 同机能同时开几个浏览器，是**内存**顶死的（AdsPower 本身不限并发）。槽位就是这个物理事实的名字。
 * override（AIDCP_BROWSER_SLOTS）优先，供运维在实测后收口。至少 1——0 槽位等于整台机器停摆。
 */
function resolveSlotCapacity({ freeBytes, perEnvBytes = PER_ENV_BYTES_DEFAULT, override } = {}) {
  const forced = Math.floor(Number(override) || 0);
  if (forced > 0) return forced;
  const per = Math.max(1, Math.floor(Number(perEnvBytes) || PER_ENV_BYTES_DEFAULT));
  const free = Math.max(0, Number(freeBytes) || 0);
  return Math.max(1, Math.floor(free / per));
}

/** 可设置账号数上限 = 2 × 槽位（超过即存在「永远排不上」的风险，必须诚实告警）。 */
function maxAccountsForSlots(slots) {
  return Math.max(0, Math.floor(Number(slots) || 0)) * ACCOUNTS_PER_SLOT;
}

/**
 * 两个上限的最终取值（界面可设，change browser-slot-scheduling 追加）。
 *
 * 优先级 **界面设置 > 启动环境变量 > 按内存自动推**——与云端环境选择同一套口径（界面是权威，env 只是
 * 没界面时的兜底）。0 / 空 = 未设 = 自动，绝不解读成「上限 0」（那等于整机停摆）。
 *
 * 两个数是不同的事实，各自独立可设：**槽位**是物理上限（同时开几个浏览器，由内存顶死），**账号上限**
 * 是排班上限（挂几个账号，靠冷待机轮流用槽位）。1:2 是缺省比例、不是物理常数——可以设高，但设高了就
 * 存在「部分账号长期排不到槽位」的风险，必须诚实告警（`maxAccountsExceedsRatio`），MUST NOT 静默接受。
 */
function resolveSlotSettings({
  freeBytes,
  perEnvBytes = PER_ENV_BYTES_DEFAULT,
  slotSetting,
  slotEnv,
  maxAccountsSetting,
} = {}) {
  const per = Math.max(1, Math.floor(Number(perEnvBytes) || PER_ENV_BYTES_DEFAULT));
  const autoCapacity = resolveSlotCapacity({ freeBytes, perEnvBytes: per });
  const fromSetting = normalizeSlotLimit(slotSetting);
  const fromEnv = Math.floor(Number(slotEnv) || 0);
  const capacity = fromSetting > 0 ? fromSetting : fromEnv > 0 ? fromEnv : autoCapacity;
  const autoMaxAccounts = maxAccountsForSlots(capacity);
  const maxSetting = normalizeSlotLimit(maxAccountsSetting);
  const maxAccounts = maxSetting > 0 ? maxSetting : autoMaxAccounts;
  return {
    capacity,
    capacitySource: fromSetting > 0 ? 'setting' : fromEnv > 0 ? 'env' : 'auto',
    autoCapacity,
    maxAccounts,
    maxAccountsSource: maxSetting > 0 ? 'setting' : 'auto',
    autoMaxAccounts,
    maxAccountsExceedsRatio: maxAccounts > autoMaxAccounts,
    perEnvMB: Math.round(per / (1024 * 1024)),
  };
}

/** 界面输入归一：空 / 非数 / ≤0 → 0（= 自动）；上界 64，防手滑多打一个零把机器拖垮。 */
function normalizeSlotLimit(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(64, n);
}

/**
 * 串行启动队列（change browser-slot-scheduling）：**所有会打开浏览器的动作**都排这一条队——
 * 自动续场恢复、冷待机唤醒、崩溃重起、手动任务、排期任务。
 *
 * 与旧的 createStaggerQueue 的关键区别：那条只保证「相邻**开始**间隔 ≥1.1s」，10 个环境仍会几乎同时
 * 冷启、把内存打爆。这条是**起完一个再起下一个**——run() 要等到环境真正就绪（浏览器起来 + 云端连上）
 * 或诚实失败才 resolve。用户明确否决了抖动错峰方案，选了这个确定性的做法。
 *
 * 优先级：手动任务 > 带任务的唤醒 > 普通续场恢复；同级 FIFO。
 * 死线：排队等待**计入**调用方的唤醒死线。轮到它时若已超死线，立刻诚实失败——绝不再花 90 秒去启动一个
 * 早已没人等的浏览器。
 */
const LAUNCH_PRIORITY = { manual: 3, task: 2, resume: 1 };

function createSerialLaunchQueue(opts = {}) {
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // AdsPower 本地 API ~1req/s：即便串行，相邻启动之间也保留最小间隔。
  const spacingMs = Number.isFinite(opts.spacingMs) ? opts.spacingMs : DEFAULT_STAGGER_MS;
  const logger = opts.logger || (() => {});
  const queue = [];
  let running = false;
  let lastStartAt = -Infinity;
  let order = 0;

  function enqueue({ key, kind = 'resume', deadlineAt, run }) {
    return new Promise((resolve) => {
      queue.push({
        key,
        priority: LAUNCH_PRIORITY[kind] || LAUNCH_PRIORITY.resume,
        kind,
        deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : Infinity,
        order: order++,
        run,
        resolve,
      });
      void drain();
    });
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
        const item = queue.shift();
        // 死线已过：绝不再启动一个没人等的浏览器（它会白占一个槽位）。
        if (now() >= item.deadlineAt) {
          logger(`[launch-queue] 放弃 ${item.key}（${item.kind}）：排队期间已超唤醒死线`);
          item.resolve({ ok: false, reason: 'deadline_exceeded' });
          continue;
        }
        const wait = lastStartAt + spacingMs - now();
        if (wait > 0) await sleep(wait);
        lastStartAt = now();
        logger(`[launch-queue] 启动 ${item.key}（${item.kind}），队列剩余 ${queue.length}`);
        try {
          // 起完一个再起下一个：run() 必须等到真正就绪 / 诚实失败才 resolve。
          const ok = await item.run();
          item.resolve({ ok: ok !== false, reason: ok === false ? 'launch_failed' : undefined });
        } catch (e) {
          // 一个环境启动失败绝不阻塞队列中其余环境。
          logger(`[launch-queue] ${item.key} 启动失败：${(e && e.message) || String(e)}`);
          item.resolve({ ok: false, reason: (e && e.message) || String(e) });
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue,
    pendingCount: () => queue.length,
    isRunning: () => running,
  };
}

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

// ─────────────────────────────────────────────────────────────────────────────
// 核心日志行的语义分类（change honest-core-log-severity）
//
// 背景红线：**「这行走了哪根管子」是传输事实，不是语义事实。** Node 的 console.warn / console.error
// 一律写 stderr，核心里有 30+ 条良性的诊断 / 进度 / 排队说明走这条路。外壳曾把 stderr 整条通道硬认成
// 「出错了」（edge: isError ? 'warning' : 'running'），于是每来一条良性 warn 就把环境徽标染红、讲出
// 「引擎已停止，请查看详情或重新启动」——而核心根本没停，下一行正常日志一到又翻回绿。
//
// 判据必须是**结构性**的：核心里每条致命路径都**必然退出进程**（启动失败 → process.exit(1)；
// 身份确立失败 → terminateNow()；CDP 终态 / 云端重连耗尽 → requestShutdown()），而外壳的
// child.on('close') 异常退出分支才是权威判据——core 自己的注释写得很清楚：「致命启动失败立即非零退出，
// 让桌面外壳的 edgeProcess.on('exit') 立刻看见」。所以日志行**不需要**去猜谁是错误。
//
// 唯一的例外是「核心还活着、但已经没法继续、必须人来」——CDP 输入控制不可用且浏览器是复用的外部浏览器
// 时，核心打印一行说明后直接 return、不退出。这一类必须仍能翻红，否则「边缘在线但浏览器驱不动」的哑状态
// 就没人报了。故留一份**核心自己写的终态措辞白名单**（不是「看着像不像错误」的猜测）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这行日志是否是核心**自己声明**的终态 —— 「我要停了」或「我没法继续、需要人工介入」。
 *
 * 只有这类行配把边缘进程徽标翻成异常态（呈现层据此讲「引擎已停止 / 运行异常 / 需处理」）。
 * 它是一份**白名单**：匹配的是核心源码里写死的那几句终态措辞，而不是对任意散文做「像不像错误」的猜测。
 * 白名单里的每一句，核心要么随即退出（此时外壳退出处的权威判据也会红，本函数只是让红早到几百毫秒、
 * 不会造成**持久**的假红），要么活着但明确要求人工介入（CDP 输入控制不可用 → 复用外部浏览器分支）。
 *
 * MUST NOT 依据该行走 stdout 还是 stderr 判定 —— 通道不承载语义。
 * 纯函数、可单测。
 */
function declaresCoreHalt(line) {
  const raw = String(line || '');
  if (!raw) return false;
  return (
    // 核心活着但驱不动浏览器、要求人工重启（唯一「不退出」的终态；见 src/main.ts cdp.control_unavailable）
    /CDP 输入控制不可用/.test(raw) ||
    // 以下各句核心随即退出；退出处仍是权威判据，这里只是让红早到
    /CDP 重连不可恢复/.test(raw) ||
    /诚实下线/.test(raw) ||
    /回收退出/.test(raw) ||
    /身份确立失败/.test(raw) ||
    /^\[aidcp-edge\] 启动失败[:：]/.test(raw)
  );
}

/**
 * 这行日志能否作为**失败归因候选** —— 即核心真的异常退出时，呈现给运营的那句「失败原因」。
 *
 * 回归前这里被 isError 短路（`if (!isError && !FAILURE_RE.test(raw)) return;`）：任何一条良性 stderr
 * 都会被记成 lastEdgeFailureLine，于是核心**真出事**时，界面给的归因是最后那条**无关**的良性 warn。
 * 现在一律按内容判定，并显式排除几类「引擎照跑、不构成运行失败」的行：
 *   - 诊断 / 观测日志（自称只观测、不改行为）
 *   - 遥测上报 / 回传失败（发不出去一条事件而已，引擎照跑）
 *   - 排队 / 租约抑制（资源暂时被占是机器行为，不是失败 —— 失败判据只能是结构上做不到）
 *
 * 纯函数、可单测。
 */
function isFailureShapedLine(line) {
  const raw = String(line || '');
  if (!raw) return false;
  const benign =
    /\[publish-submit-diag\]/.test(raw) ||
    /上报失败|回传失败/.test(raw) ||
    /给不出浏览器槽位/.test(raw) ||
    /租约抑制/.test(raw);
  if (benign) return false;
  return /(启动失败|失败|不可达|not allowed|being used|no_target|code=-?\d+)/i.test(raw);
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
  createSerialLaunchQueue,
  resolveSlotCapacity,
  maxAccountsForSlots,
  resolveSlotSettings,
  normalizeSlotLimit,
  ACCOUNTS_PER_SLOT,
  LAUNCH_PRIORITY,
  orderSlotWaiters,
  ramAdmission,
  availableMemoryBytes,
  usableMemoryBytes,
  parseVmStatAvailableBytes,
  parseMemAvailableBytes,
  MEM_RESERVE_BYTES_DEFAULT,
  duplicateAccountGroups,
  decideRespawn,
  classifyAdsInUse,
  declaresCoreHalt,
  isFailureShapedLine,
  imageTempNamespace,
};
