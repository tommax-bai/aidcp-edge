// AdsPower 本地 API 的**主进程侧写客户端**（仅程序化建号/建组：`user/create` + `group/create`）。
//
// change adspower-auto-create-env（task 2）。与只读 `ads-local-api.cjs` **刻意分离**：
//  - 红线（M7，结构性守）：本客户端用**硬编码 allowlist** 只放行 `user/create` / `group/create` / `user/delete` / `user/update`。
//    任何 `browser/start|stop|active`（浏览器生命周期，核心子进程单写）路径在 `post()` 内**直接抛错**、
//    绝不发出——把「主进程绝不碰浏览器生命周期」从注释自觉升为**代码上不可能**（回归断言覆盖）。
//    注（C3 放宽）：`user/delete` 由原「禁一切程序化删」放宽为**允许、但仅由运维在界面上逐个显式确认触发**
//    （非自动 / 非批量 / 非 ledger 驱动，删前明确警示不可恢复）——ads-create-flow 内无删除，删除只走 UI 确认路径。
//    注（edge-client-proxy-platform-persona-ux / edge-adspower-name-follows-nickname 放宽）：`user/update`
//    **仅限改代理或改环境名两种用途**——只提供两个封装：`updateProfileProxy` 的 body 只构造
//    `{ user_id, user_proxy_config }` 两键、`renameProfile` 的 body 只构造 `{ user_id, name }` 两键；
//    fingerprint / remark / 分组一概不经此口，代理与名字亦互不混入对方 body
//    （放行 update ≠ 打开整张写面，回归断言分别覆盖两个封装的两键约束）。
//  - 节流：复用与只读侧同规格的 ≥1.1s **串行节流单链**（独立实例；跨进程无法共享，故各自一条）。
//  - 凭据（H3/D9）：POST body **绝不整体 stringify 进日志/错误**；不可达 / code≠0 的错误**不含 body**；
//    另导出 `redactSensitive()` 供调用方（main.cjs）在打印前脱敏 `proxy_user/proxy_password/Authorization`。
//  - 诚实失败：不可达 / 响应非 JSON / `code!==0` 一律返回 `{ ok:false, ... }`，MUST NOT 假成功。

const ADS_MIN_INTERVAL_MS = 1100; // 本地 API 限速 1req/s，留余量（与只读侧同规格、独立实例）
const DEFAULT_ADS_BASE = 'http://local.adspower.net:50325';

// 硬编码写 allowlist。新增写端点须显式加入并补回归断言。
// user/delete 允许，但调用方 MUST 仅由运维界面逐个显式确认触发（见头注 C3 放宽）。
// user/update 允许，但仅经 updateProfileProxy（改代理）/ renameProfile（改名）的各自两键 body（见头注放宽）。
const WRITE_ALLOWLIST = Object.freeze(['user/create', 'group/create', 'user/delete', 'user/update']);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 归一化端点路径：去首尾斜杠 + 去 `api/v1/` 前缀，得形如 `user/create`。 */
function normalizePath(path) {
  return String(path)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^api\/v1\//, '');
}

/**
 * 从任意对象浅+深拷贝出「可安全打印」版本：把敏感键的值替换为 '***'。
 * 用于调用方日志（本模块自身不打印 body）。
 */
function redactSensitive(value) {
  const SENSITIVE = /^(proxy_user|proxy_password|password|authorization|api_?key|token|cookie|fakey)$/i;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE.test(k) ? '***' : walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

/**
 * 创建主进程侧 AdsPower 写客户端（单例持有一条串行节流）。
 * @param {{ apiBase?: string, apiKey?: string, fetchImpl?: typeof fetch, nowImpl?: () => number, sleepImpl?: (ms:number)=>Promise<void> }} deps
 */
function createAdsWriteApi(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.nowImpl || (() => Date.now());
  const sleep = deps.sleepImpl || defaultSleep;

  // 与只读侧同形的不可重入串行节流单链（等间隔 → fetch → 记时）。
  let lastApiAt = 0;
  let chain = Promise.resolve();
  function throttledRequest(url, init) {
    const run = chain.then(async () => {
      if (lastApiAt !== 0) {
        const wait = ADS_MIN_INTERVAL_MS - (now() - lastApiAt);
        if (wait > 0) await sleep(wait);
      }
      try {
        return await fetchImpl(url, init);
      } finally {
        lastApiAt = now();
      }
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function baseOf(opts) {
    const b = (opts && opts.apiBase) || deps.apiBase || DEFAULT_ADS_BASE;
    return String(b).replace(/\/+$/, '');
  }
  function authHeaders(opts) {
    const key = opts && Object.prototype.hasOwnProperty.call(opts, 'apiKey') ? opts.apiKey : deps.apiKey;
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  /**
   * 发一个 allowlisted 写请求（POST + JSON body）。
   * @returns {Promise<{ ok: boolean, data?: any, code?: number, error?: string }>}
   * @throws 若 path 不在 allowlist（生命周期 / 删除 / 未知写端点）——**结构性拒绝、绝不发出**。
   */
  async function post(path, body, opts = {}) {
    const clean = normalizePath(path);
    if (!WRITE_ALLOWLIST.includes(clean)) {
      // 红线：不是「诚实失败返回」，而是**抛错**——调用这类端点是编程错误，须在测试/CI 暴露。
      throw new Error(
        `[ads-write] 禁止的写端点「${clean}」：allowlist 只放行 ${WRITE_ALLOWLIST.join(' / ')}。` +
          '浏览器生命周期（browser/start|stop|active）仍由核心子进程单写、绝不经此客户端。',
      );
    }
    const url = `${baseOf(opts)}/api/v1/${clean}`;
    const headers = { 'Content-Type': 'application/json', ...authHeaders(opts) };
    let res;
    try {
      res = await throttledRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      // 不含 body：诚实报不可达，不泄露 body 里的代理账密。
      return { ok: false, error: `本地指纹浏览器服务不可达（${clean}）：${e && e.message ? e.message : String(e)}` };
    }
    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: `指纹浏览器服务 ${clean} 响应非 JSON（HTTP ${res && res.status})` };
    }
    if (!json || json.code !== 0) {
      // 只带 code + msg，不带 body。
      return { ok: false, code: json ? json.code : undefined, error: (json && json.msg) || `code=${json && json.code}`, data: json && json.data };
    }
    return { ok: true, data: json.data };
  }

  /** 建组：返回 { ok, groupId? }。 */
  async function createGroup(groupName, opts) {
    const r = await post('group/create', { group_name: String(groupName) }, opts);
    if (!r.ok) return r;
    const gid = r.data && (r.data.group_id != null ? String(r.data.group_id) : undefined);
    return { ok: true, groupId: gid, data: r.data };
  }

  /**
   * 建号：入参已是构造好的 fingerprint_config / user_proxy_config（护栏/断言在上层做）。
   * 返回 { ok, userId? }。
   */
  async function createProfile({ groupId, name, fingerprintConfig, proxyConfig, remark, accountImport }, opts) {
    const body = {
      group_id: String(groupId),
      // 代理可选：上层（ads-create-flow 经归一层）填则下发，缺省 no_proxy 建号（与历史行为等价）。
      user_proxy_config: proxyConfig || { proxy_soft: 'no_proxy' },
      fingerprint_config: fingerprintConfig,
    };
    if (name) body.name = String(name);
    if (remark != null) body.remark = String(remark); // 承载意图账号/模板/机器（随 user/list 读回）
    if (accountImport) {
      const account = accountImport;
      if (account.domainName) body.domain_name = String(account.domainName);
      if (Array.isArray(account.openUrls) && account.openUrls.length) body.open_urls = account.openUrls.map(String);
      if (account.username) body.username = String(account.username);
      if (account.password) body.password = String(account.password);
      if (account.fakey) body.fakey = String(account.fakey);
      if (account.cookie) body.cookie = String(account.cookie);
      if (Array.isArray(account.repeatConfig) && account.repeatConfig.length) body.repeat_config = account.repeatConfig;
      if (account.ignoreCookieError != null) body.ignore_cookie_error = String(account.ignoreCookieError);
    }
    const r = await post('user/create', body, opts);
    if (!r.ok) return r;
    const uid = r.data && (r.data.id != null ? String(r.data.id) : r.data.user_id != null ? String(r.data.user_id) : undefined);
    return { ok: true, userId: uid, data: r.data };
  }

  /** 删除分身（allowlist 放行；调用方 MUST 仅由运维界面逐个显式确认触发、绝不自动/批量）。 */
  async function deleteProfile(userId, opts) {
    if (!userId) return { ok: false, error: '缺 user_id' };
    return post('user/delete', { user_ids: [String(userId)] }, opts);
  }

  /**
   * 改已有分身的代理（user/update 的**唯一**封装）。结构性约束：body 只构造
   * `{ user_id, user_proxy_config }` 两键、不接受/不透传其他字段——放行 update 仅为改代理。
   * @param {{ userId: string|number, proxyConfig: object }} args proxyConfig 须已经 ads-proxy-config 归一
   */
  async function updateProfileProxy({ userId, proxyConfig } = {}, opts) {
    if (!userId) return { ok: false, error: '缺 user_id' };
    if (!proxyConfig || typeof proxyConfig !== 'object' || !proxyConfig.proxy_soft) {
      return { ok: false, error: '缺 user_proxy_config（须经归一层构造）' };
    }
    return post('user/update', { user_id: String(userId), user_proxy_config: proxyConfig }, opts);
  }

  /**
   * 改已有分身的**环境名**（user/update 的第二个、也是仅有的另一个封装）。结构性约束：body 只构造
   * `{ user_id, name }` 两键、不接受/不透传任何其他字段——放行 update 仅为「改代理」或「改名」两用途，
   * 代理与名字互不混入对方 body（回归断言分别锁两个封装的键集）。缺 userId / 空 name 诚实拒绝、绝不发出。
   * @param {{ userId: string|number, name: string }} args
   */
  async function renameProfile({ userId, name } = {}, opts) {
    if (!userId) return { ok: false, error: '缺 user_id' };
    const nm = name == null ? '' : String(name).trim();
    if (!nm) return { ok: false, error: '缺环境名（空名不发改名）' };
    return post('user/update', { user_id: String(userId), name: nm }, opts);
  }

  return { post, createGroup, createProfile, deleteProfile, updateProfileProxy, renameProfile, redactSensitive, WRITE_ALLOWLIST: [...WRITE_ALLOWLIST], ADS_MIN_INTERVAL_MS };
}

module.exports = { createAdsWriteApi, redactSensitive, normalizePath, WRITE_ALLOWLIST: [...WRITE_ALLOWLIST], ADS_MIN_INTERVAL_MS, DEFAULT_ADS_BASE };
