// AdsPower 本地 API 的主进程侧客户端与托管子进程 broker。
//
// 为什么单独一份（不复用核心 src/cdp/browser-provider.ts 的 api<T>()）：
//  - 进程边界：面板探测/拉取在 Electron 主进程发起，托管核心在独立子进程。子进程经私有 IPC
//    把受限 AdsPower 请求交回本模块，使两侧共享同一条 FIFO；非 Electron/CLI 调用仍由核心自行节流。
//  - URL 契约：健康检查在根级 `/status`，元数据仍有 V1，而浏览器生命周期是 V2；若套用统一前缀会
//    打到错误端点并谎报「不可达」。故本模块**逐端点显式拼 URL**。
//
// 红线：探测/拉取保持只读；唯一写例外是具名 openProfileForInspection（仅 V2 browser-profile/start、只接受
// 视频号助手固定域名），供客户本机人工查看。MUST NOT 暴露 browser/stop 或通用生命周期写入口。
// 所有调用共用本模块同一条串行节流；失败诚实回报、不假成功。
// 敏感值：apiKey 只用于本次请求的 Authorization 头，不落日志、不写文件。

const { parseRemark, DEFAULT_PLATFORM } = require('./ads-create-flow.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADS_MIN_INTERVAL_MS = 1100; // 本地 API 限速 1req/s，主进程与 managed child 共用并留余量
const DEFAULT_ADS_BASE = 'http://local.adspower.net:50325';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10; // 上限，避免超大环境量拉不停；超限如实标 truncated
const DEFAULT_ADS_CACHE_ROOT = path.join(os.homedir(), '.adspowerCli', 'source', 'cache');
const MAX_ORPHAN_CACHE_CANDIDATES = 8;
const ORPHAN_PROBE_TIMEOUT_MS = 2_000;
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const DEVTOOLS_BROWSER_PATH_RE = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/;
const BROKER_MAX_BATCH_SIZE = 2;
const BROKER_REQUEST_TIMEOUT_MS = 30_000;
const BROKER_OPERATION_KEYS = new Set(['version', 'method', 'path', 'query', 'body']);
const PROXY_CONFIG_KEYS = new Set([
  'proxy_soft',
  'proxy_type',
  'proxy_host',
  'proxy_port',
  'proxy_user',
  'proxy_password',
]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建一个主进程侧的 AdsPower LocalAPI 协调器（桌面运行时单例持有统一 FIFO）。
 * 除具名人工查看 openProfileForInspection 外，其余能力均为只读。
 * @param {{ apiBase?: string, apiKey?: string, fetchImpl?: typeof fetch, nowImpl?: () => number, sleepImpl?: (ms:number)=>Promise<void>, adsCacheRoot?: string, orphanProbeTimeoutMs?: number, logImpl?: (msg:string)=>void }} deps
 */
function createAdsLocalApi(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.nowImpl || (() => Date.now());
  const sleep = deps.sleepImpl || defaultSleep;
  const log = deps.logImpl || ((message) => console.log(message));
  const adsCacheRoot = path.resolve(deps.adsCacheRoot || DEFAULT_ADS_CACHE_ROOT);
  const orphanProbeTimeoutMs = Number(deps.orphanProbeTimeoutMs) > 0
    ? Math.floor(Number(deps.orphanProbeTimeoutMs))
    : ORPHAN_PROBE_TIMEOUT_MS;
  // 主进程内**唯一**串行节流闸门：所有只读、受限写入及 managed child 请求排进同一条链，
  // 把「等间隔 → fetch → 记时」作为**不可重入单元**串行执行。
  // 为什么要队列而非仅一个时间戳：面板「检测」「刷新」是两个独立按钮、各自的 in-flight 禁用管不到对方，
  // 自动探测（加载/切分段/保存前）也会与手动刷新并发；若只读 lastApiAt 决定等多久，两个并发调用会同读旧值、
  // 都欠等、几乎同时发 fetch → 撞破 1req/s、把好连接自伤成假失败。队列把它们真正串行开、间隔 ≥1.1s。
  let lastApiAt = 0;
  let chain = Promise.resolve();

  function throttledCore(fn) {
    const run = chain.then(async () => {
      if (lastApiAt !== 0) {
        const wait = ADS_MIN_INTERVAL_MS - (now() - lastApiAt);
        if (wait > 0) await sleep(wait);
      }
      try {
        return await fn();
      } finally {
        lastApiAt = now();
      }
    });
    // 断开 rejection、只为链能继续（本次结果仍由 run 返回给调用方）。
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function throttledFetch(url, headers) {
    return throttledCore(() => fetchImpl(url, { headers }));
  }
  // 通用请求（支持 POST/body），与 throttledFetch 共用同一条串行节流链。
  function throttledRequest(url, init) {
    return throttledCore(() => fetchImpl(url, init));
  }

  function baseOf(opts) {
    const b = (opts && opts.apiBase) || deps.apiBase || DEFAULT_ADS_BASE;
    return String(b).replace(/\/+$/, ''); // 去尾斜杠，避免 //status
  }
  // apiKey 优先取调用级（表单当前值），否则回落构造默认（持久化值）。
  function authHeaders(opts) {
    const key = opts && Object.prototype.hasOwnProperty.call(opts, 'apiKey') ? opts.apiKey : deps.apiKey;
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function hasOnlyKeys(value, allowed) {
    return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
  }

  function exactProfile(value, profileId) {
    return typeof value === 'string' && value === profileId;
  }

  function validProxyConfig(value) {
    if (!hasOnlyKeys(value, PROXY_CONFIG_KEYS)) return false;
    const port = String(value.proxy_port || '');
    const user = value.proxy_user == null ? '' : String(value.proxy_user);
    const password = value.proxy_password == null ? '' : String(value.proxy_password);
    return value.proxy_soft === 'other'
      && ['http', 'https', 'socks5'].includes(value.proxy_type)
      && typeof value.proxy_host === 'string' && value.proxy_host.length > 0 && value.proxy_host.length <= 1024
      && /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65_535
      && user.length <= 2048 && password.length <= 4096
      && (!password || Boolean(user));
  }

  function validateBrokerOperation(raw, profileId) {
    if (!hasOnlyKeys(raw, BROKER_OPERATION_KEYS)) return null;
    const version = raw.version;
    const method = raw.method;
    const requestPath = raw.path;
    const query = raw.query == null ? {} : raw.query;
    const body = raw.body == null ? {} : raw.body;
    if (!isRecord(query) || !isRecord(body)) return null;

    if (version === 'v2' && method === 'GET' && requestPath === 'browser-profile/active') {
      if (Object.keys(query).length !== 1 || !exactProfile(query.profile_id, profileId)
        || Object.keys(body).length !== 0) return null;
    } else if (version === 'v2' && method === 'POST' && requestPath === 'browser-profile/start') {
      const allowed = new Set(['profile_id', 'last_opened_tabs', 'ip_tab', 'headless', 'launch_args']);
      if (!hasOnlyKeys(body, allowed) || Object.keys(query).length !== 0
        || !exactProfile(body.profile_id, profileId)
        || !['0', '1'].includes(body.last_opened_tabs)
        || !['0', '1'].includes(body.ip_tab)
        || !['0', '1'].includes(body.headless)
        || !Array.isArray(body.launch_args) || body.launch_args.length > 32
        || body.launch_args.some((arg) => typeof arg !== 'string' || arg.length > 4096)) return null;
    } else if (version === 'v2' && method === 'POST' && requestPath === 'browser-profile/stop') {
      if (Object.keys(query).length !== 0 || Object.keys(body).length !== 1
        || !exactProfile(body.profile_id, profileId)) return null;
    } else if (version === 'v1' && method === 'POST' && requestPath === 'user/update') {
      if (Object.keys(query).length !== 0 || Object.keys(body).length !== 2
        || !exactProfile(body.user_id, profileId) || !validProxyConfig(body.user_proxy_config)) return null;
    } else if (version === 'v1' && method === 'GET' && requestPath === 'user/list') {
      const allowed = new Set(['user_id', 'page', 'page_size']);
      if (!hasOnlyKeys(query, allowed) || Object.keys(query).length !== 3
        || !exactProfile(query.user_id, profileId)
        || query.page !== '1' || query.page_size !== '10'
        || Object.keys(body).length !== 0) return null;
    } else {
      return null;
    }
    return { version, method, path: requestPath, query: { ...query }, body: { ...body } };
  }

  async function fetchBrokerOperation(operation, opts) {
    const qs = new URLSearchParams(operation.query).toString();
    const url = `${baseOf(opts)}/api/${operation.version}/${operation.path}${qs ? `?${qs}` : ''}`;
    const headers = {
      ...authHeaders(opts),
      ...(operation.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROKER_REQUEST_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(url, {
        method: operation.method,
        headers,
        ...(operation.method === 'POST' ? { body: JSON.stringify(operation.body) } : {}),
        signal: controller.signal,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        // Child classifies invalid JSON without exposing raw response text.
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Private managed-child broker. Validation happens before the shared FIFO and never accepts a
   * child-supplied base/key. A two-operation proxy update/readback batch remains one queue item.
   */
  async function brokerBatch(opts = {}) {
    const profileId = String(opts.profileId || '').trim();
    const operations = Array.isArray(opts.operations) ? opts.operations : [];
    if (!PROFILE_ID_RE.test(profileId) || operations.length < 1 || operations.length > BROKER_MAX_BATCH_SIZE) {
      return { ok: false, reason: 'invalid_broker_request' };
    }
    const validated = operations.map((operation) => validateBrokerOperation(operation, profileId));
    if (validated.some((operation) => !operation)) {
      return { ok: false, reason: 'invalid_broker_request' };
    }
    try {
      const responses = await throttledCore(async () => {
        if (typeof opts.isCancelled === 'function' && opts.isCancelled()) return null;
        const completed = [];
        for (let index = 0; index < validated.length; index += 1) {
          if (index > 0) await sleep(ADS_MIN_INTERVAL_MS);
          const response = await fetchBrokerOperation(validated[index], opts);
          completed.push(response);
          const body = isRecord(response.body) ? response.body : null;
          if (response.status < 200 || response.status >= 300 || typeof body?.code !== 'number' || body.code !== 0) {
            while (completed.length < validated.length) {
              completed.push({ status: 424, body: { code: -1, msg: 'batch_aborted' } });
            }
            break;
          }
        }
        return completed;
      });
      if (!responses) return { ok: false, reason: 'broker_cancelled' };
      return { ok: true, responses };
    } catch {
      return { ok: false, reason: 'ads_api_unavailable' };
    }
  }

  async function withTimeout(promise, timeoutMs, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        fetchImpl(url, { ...(init || {}), signal: controller.signal }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`CDP 探测超时（${timeoutMs}ms）`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function profileActive(opts, profileId) {
    const qs = new URLSearchParams({ profile_id: profileId });
    const url = `${baseOf(opts)}/api/v2/browser-profile/active?${qs.toString()}`;
    let res;
    try {
      res = await throttledFetch(url, authHeaders(opts));
    } catch (e) {
      return { ok: false, error: `查询分身 ${profileId} 状态失败：本地 API 不可达（${(e && e.message) || String(e)}）` };
    }
    if (!res.ok) return { ok: false, error: `查询分身 ${profileId} 状态失败（HTTP ${res.status}）` };
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: `查询分身 ${profileId} 状态失败：本地 API 响应非 JSON` };
    }
    if (body && typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: `查询分身 ${profileId} 状态失败：code=${body.code} ${body.msg || ''}`.trim() };
    }
    const data = body && body.data || {};
    const statusValue = String(data.status || '').trim().toLowerCase();
    if (statusValue !== 'active' && statusValue !== 'inactive') {
      return { ok: false, error: `查询分身 ${profileId} 状态失败：V2 active 返回未知状态 ${JSON.stringify(data.status)}` };
    }
    const debugPort = Number(data.debug_port);
    if (statusValue === 'active' && (!Number.isInteger(debugPort) || debugPort <= 0 || debugPort > 65535)) {
      return { ok: false, error: `查询分身 ${profileId} 状态失败：已报告 Active 但缺少有效 debug_port` };
    }
    return { ok: true, active: statusValue === 'active', debugPort: statusValue === 'active' ? debugPort : undefined };
  }

  /**
   * daemon 重启后 V2 registry 可能丢失，但 SunBrowser 仍在监听。只检查目标 profile 的有限 cache 候选，
   * 并要求 marker 的端口 + browser path 与 loopback /json/version 完全一致；绝不只凭端口接管。
   */
  async function findValidatedOrphanCdp(profileId) {
    if (!PROFILE_ID_RE.test(profileId)) return null;
    let entries;
    try {
      entries = fs.readdirSync(adsCacheRoot, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return null;
    }
    const prefix = `${profileId}_`;
    const candidates = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, MAX_ORPHAN_CACHE_CANDIDATES);
    const rootPrefix = `${adsCacheRoot}${path.sep}`;
    for (const entry of candidates) {
      const markerPath = path.resolve(adsCacheRoot, entry.name, 'DevToolsActivePort');
      if (!markerPath.startsWith(rootPrefix)) continue;
      let raw;
      try {
        const markerStat = fs.lstatSync(markerPath);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) continue;
        raw = fs.readFileSync(markerPath, 'utf8');
      } catch {
        continue;
      }
      const [portLine, browserPathLine] = raw.split(/\r?\n/);
      const port = Number(String(portLine || '').trim());
      const browserPath = String(browserPathLine || '').trim();
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || !DEVTOOLS_BROWSER_PATH_RE.test(browserPath)) continue;
      try {
        const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`, {}, orphanProbeTimeoutMs);
        if (!response.ok) continue;
        const version = await withTimeout(response.json(), orphanProbeTimeoutMs, 'CDP 响应');
        const ws = new URL(String(version && version.webSocketDebuggerUrl || ''));
        const hostname = ws.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
        if (ws.protocol !== 'ws:' || !loopback || Number(ws.port) !== port || ws.pathname !== browserPath) continue;
        return { host: '127.0.0.1', port };
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * 健康检查：GET {base}/status（**根级**，不带 /api/v1 前缀，通常免鉴权）。
   * 不 throw：可达返回 { ok:true }，不可达/异常返回 { ok:false, error }（供面板分档提示）。
   */
  async function status(opts) {
    const url = `${baseOf(opts)}/status`;
    let res;
    try {
      res = await throttledFetch(url, authHeaders(opts));
    } catch (e) {
      return { ok: false, error: `未检测到本地指纹浏览器服务：${(e && e.message) || String(e)}` };
    }
    if (!res.ok) {
      // 收到响应但非 2xx：本地 API 端口有人应答但异常（非「不可达」）。如实标 HTTP 码。
      return { ok: false, error: `本地指纹浏览器服务响应异常（HTTP ${res.status}）` };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body && typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: `本地指纹浏览器服务返回 code=${body.code} ${body.msg || ''}`.trim() };
    }
    return { ok: true };
  }

  /**
   * 拉取浏览器环境：GET {base}/api/v1/user/list（分页，可选 group_id；开 API 校验时带 Bearer）。
   * 不 throw：成功返回 { ok:true, profiles:[...], truncated }，失败返回 { ok:false, error, authLikely }。
   * 归一化：user_id 是写入分身 ID 字段的唯一值（下游 V2 browser-profile/start 只认它）；serial_number/name 仅供展示。
   */
  async function listProfiles(opts = {}) {
    const base = baseOf(opts);
    const headers = authHeaders(opts);
    const pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : DEFAULT_PAGE_SIZE;
    const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : DEFAULT_MAX_PAGES;
    const profiles = [];
    let total;
    for (let page = 1; page <= maxPages; page++) {
      const qs = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
      if (opts.groupId) qs.set('group_id', String(opts.groupId));
      const url = `${base}/api/v1/user/list?${qs.toString()}`;
      let res;
      try {
        res = await throttledFetch(url, headers);
      } catch (e) {
        return { ok: false, error: `拉取环境失败：本地 API 不可达（${(e && e.message) || String(e)}）` };
      }
      if (!res.ok) {
        const authLikely = res.status === 401 || res.status === 403;
        return {
          ok: false,
          authLikely,
          error: `拉取环境失败（HTTP ${res.status}）${authLikely ? '：疑似开启了 API 校验' : ''}`,
        };
      }
      let body;
      try {
        body = await res.json();
      } catch {
        return { ok: false, error: '拉取环境失败：本地 API 响应非 JSON' };
      }
      if (typeof body.code === 'number' && body.code !== 0) {
        const authLikely = /token|auth|api\s*key|校验|鉴权/i.test(body.msg || '');
        return { ok: false, authLikely, error: `拉取环境失败：code=${body.code} ${body.msg || ''}`.trim() };
      }
      const data = body.data || {};
      const list = Array.isArray(data.list) ? data.list : Array.isArray(data.data) ? data.data : [];
      for (const it of list) profiles.push(normalizeProfile(it));
      if (data.total != null) total = Number(data.total);
      if (list.length < pageSize) return { ok: true, profiles, truncated: false };
    }
    // 到达页数上限仍未取完：如实标 truncated（不静默截断）。
    const truncated = total == null || profiles.length < total;
    return { ok: true, profiles, truncated };
  }

  /**
   * 精确读取一个 profile 的代理配置，供 Electron 主进程首次引导原环境代理权威与编辑回填。
   *
   * 与 listProfiles 的边界不同：这里会把 proxy_password 返回给主进程调用方，但只挑代理所需字段；
   * AIDCP 建立加密权威后，预检与每次启动不再把可能暂留 GOST loopback 的 live profile 当作原代理。
   * 不返回 profile 其余原始数据。该方法只允许由主进程内部能力或具名、客户范围校验后的 IPC 调用；
   * 不得把原始本地 API 能力暴露给 preload/renderer，现有 normalizeProfile 仍剥离密码。
   */
  async function getProfileProxyConfig(opts = {}) {
    const profileId = String(opts.profileId || '').trim();
    if (!profileId) return { ok: false, error: '缺少 profileId' };
    const base = baseOf(opts);
    const qs = new URLSearchParams({ user_id: profileId, page: '1', page_size: '10' });
    const url = `${base}/api/v1/user/list?${qs.toString()}`;
    let res;
    try {
      res = await throttledFetch(url, authHeaders(opts));
    } catch {
      return { ok: false, error: '读取代理配置失败：本地 API 不可达' };
    }
    if (!res.ok) {
      const authLikely = res.status === 401 || res.status === 403;
      return {
        ok: false,
        authLikely,
        error: `读取代理配置失败（HTTP ${res.status}）${authLikely ? '：疑似开启了 API 校验' : ''}`,
      };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: '读取代理配置失败：本地 API 响应非 JSON' };
    }
    if (typeof body.code === 'number' && body.code !== 0) {
      const authLikely = /token|auth|api\s*key|校验|鉴权/i.test(body.msg || '');
      return { ok: false, authLikely, error: '读取代理配置失败：本地 API 拒绝请求' };
    }
    const data = body.data || {};
    const list = Array.isArray(data.list) ? data.list : Array.isArray(data.data) ? data.data : [];
    const item = list.find((candidate) => String(candidate && candidate.user_id || '') === profileId);
    if (!item) return { ok: false, error: '读取代理配置失败：未找到该环境' };
    const cfg = item.user_proxy_config || item.proxy_config || {};
    const proxyType = String(cfg.proxy_type || cfg.proxy_soft || '').trim().toLowerCase();
    const noProxy = isNoProxyType(proxyType);
    return {
      ok: true,
      noProxy,
      proxy: {
        proxyType: noProxy ? 'no_proxy' : proxyType,
        proxyHost: cfg.proxy_host != null ? String(cfg.proxy_host) : '',
        proxyPort: cfg.proxy_port != null ? String(cfg.proxy_port) : '',
        proxyUser: cfg.proxy_user != null ? String(cfg.proxy_user) : '',
        proxyPassword: cfg.proxy_password != null ? String(cfg.proxy_password) : '',
      },
    };
  }

  /**
   * 拉取分组：GET {base}/api/v1/group/list（只读，供「创建环境」精确定位预置分组）。
   * 不 throw：成功 { ok:true, groups:[{groupId, groupName}] }，失败 { ok:false, error }。
   */
  async function listGroups(opts = {}) {
    const base = baseOf(opts);
    const qs = new URLSearchParams({ page: '1', page_size: '1000' });
    if (opts.groupName) qs.set('group_name', String(opts.groupName));
    const url = `${base}/api/v1/group/list?${qs.toString()}`;
    let res;
    try {
      res = await throttledFetch(url, authHeaders(opts));
    } catch (e) {
      return { ok: false, error: `拉取分组失败：本地 API 不可达（${(e && e.message) || String(e)}）` };
    }
    if (!res.ok) {
      const authLikely = res.status === 401 || res.status === 403;
      return { ok: false, authLikely, error: `拉取分组失败（HTTP ${res.status}）` };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: '拉取分组失败：本地 API 响应非 JSON' };
    }
    if (typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: `拉取分组失败：code=${body.code} ${body.msg || ''}`.trim() };
    }
    const data = body.data || {};
    const list = Array.isArray(data.list) ? data.list : [];
    const groups = list.map((g) => ({
      groupId: g.group_id != null ? String(g.group_id) : '',
      groupName: g.group_name || '',
    }));
    return { ok: true, groups };
  }

  /**
   * 对账当前**本机已打开**的浏览器分身：逐个 GET {base}/api/v2/browser-profile/active（只读）。
   * 用途（edge-multi-environment-fleet）：外壳重启时 spawn 前对账已在运行的分身——已在运行则接管、
   * 不重复拉起（防孤儿 + 防同 edgeId 第二连接被云端互踢）。
   * 不 throw：成功 { ok:true, activeUserIds:[...] }，失败 { ok:false, error }（调用方按「无法对账」诚实处理）。
   */
  async function listActiveProfiles(opts = {}) {
    if (!Array.isArray(opts.profileIds)) {
      return { ok: false, error: '对账在跑分身失败：缺少已知环境 profile roster' };
    }
    const profileIds = [...new Set(opts.profileIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (profileIds.some((id) => !PROFILE_ID_RE.test(id))) {
      return { ok: false, error: '对账在跑分身失败：环境 profile id 不合法' };
    }
    const activeUserIds = [];
    for (const profileId of profileIds) {
      const state = await profileActive(opts, profileId);
      if (!state.ok) return { ok: false, error: `对账在跑分身失败：${state.error}` };
      if (state.active) {
        activeUserIds.push(profileId);
        continue;
      }
      const orphan = await findValidatedOrphanCdp(profileId);
      if (orphan) {
        activeUserIds.push(profileId);
        log(`[aidcp-edge] AdsPower V2 registry 未登记但已验证 profile=${profileId} 的 CDP ${orphan.port}，外壳接管失联浏览器`);
      }
    }
    return { ok: true, activeUserIds, listWellFormed: true };
  }

  /**
   * 打开/复用视频号助手分身供客户人工查看。这里只开放 V2 browser-profile/start：
   * - userId / startUrl 必须由 Electron main 的权威环境映射给出，renderer 不得直传这些底层参数；
   * - startUrl 再做一层 channels.weixin.qq.com HTTPS 限定，避免本地 IPC 退化成任意 URL 启动器；
   * - 已在跑（V2 Active 或已验证失联 CDP）直接复用；新启动恢复历史标签，避免人工查看破坏上下文；
   * - 返回有效 debug_port 才算成功，绝不把 code=0 但句柄缺失冒充已打开。
   */
  async function openProfileForInspection(opts = {}) {
    const userId = String(opts.userId || '').trim();
    if (!PROFILE_ID_RE.test(userId)) {
      return { ok: false, error: '打开浏览器失败：环境标识不合法' };
    }
    let startUrl;
    try {
      startUrl = new URL(String(opts.startUrl || ''));
    } catch {
      return { ok: false, error: '打开浏览器失败：视频号助手地址不合法' };
    }
    if (startUrl.protocol !== 'https:' || startUrl.hostname !== 'channels.weixin.qq.com') {
      return { ok: false, error: '打开浏览器失败：只允许打开视频号助手' };
    }
    const launchArgs = [
      '--window-size=1440,980',
      '--start-maximized',
      '--deny-permission-prompts',
      '--lang=zh-CN',
      startUrl.toString(),
    ];
    const state = await profileActive(opts, userId);
    if (!state.ok) return { ok: false, error: `打开浏览器失败：${state.error}` };
    if (state.active) return { ok: true, debugPort: state.debugPort };
    const orphan = await findValidatedOrphanCdp(userId);
    if (orphan) {
      log(`[aidcp-edge] AdsPower V2 registry 未登记但已验证 profile=${userId} 的 CDP ${orphan.port}，人工查看接管失联浏览器`);
      return { ok: true, debugPort: orphan.port };
    }
    const url = `${baseOf(opts)}/api/v2/browser-profile/start`;
    const payload = JSON.stringify({
      profile_id: userId,
      last_opened_tabs: '1',
      ip_tab: '0',
      headless: '0',
      launch_args: launchArgs,
    });
    let res;
    try {
      res = await throttledRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(opts) },
        body: payload,
      });
    } catch (e) {
      return { ok: false, error: `打开浏览器失败：本地服务不可达（${(e && e.message) || String(e)}）` };
    }
    if (!res.ok) return { ok: false, error: `打开浏览器失败（HTTP ${res.status}）` };
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: '打开浏览器失败：本地服务响应非 JSON' };
    }
    if (typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: `打开浏览器失败：code=${body.code} ${body.msg || ''}`.trim() };
    }
    const debugPort = Number(body && body.data && body.data.debug_port);
    if (!Number.isInteger(debugPort) || debugPort <= 0) {
      return { ok: false, error: '打开浏览器失败：本地服务未返回有效浏览器句柄' };
    }
    return { ok: true, debugPort };
  }

  /**
   * 取内核清单：GET {base}/api/v2/browser-profile/kernels?kernel_type=Chrome。
   * 直连 HTTP（绕开 CLI 的 `get-kernel-list`——Electron Node 20 下 `ads start` 未写 pid/store，
   * CLI 命令会误判「runtime not running」，但服务本身在监听、HTTP 正常）。
   * 不 throw：成功 { ok:true, list:[{kernel, kernel_type, is_downloaded}] }，失败 { ok:false, error }。
   */
  async function kernels(opts = {}) {
    const kt = (opts && opts.kernelType) || 'Chrome';
    const url = `${baseOf(opts)}/api/v2/browser-profile/kernels?kernel_type=${encodeURIComponent(kt)}`;
    let res;
    try {
      res = await throttledFetch(url, authHeaders(opts));
    } catch (e) {
      return { ok: false, error: `取内核列表失败：本地 API 不可达（${(e && e.message) || String(e)}）` };
    }
    if (!res.ok) return { ok: false, error: `取内核列表失败（HTTP ${res.status}）` };
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: '取内核列表失败：本地 API 响应非 JSON' };
    }
    if (typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: `取内核列表失败：code=${body.code} ${body.msg || ''}`.trim() };
    }
    const data = body.data || {};
    const list = Array.isArray(data.list) ? data.list : Array.isArray(data) ? data : [];
    return { ok: true, list };
  }

  /**
   * 触发/查询内核下载：POST {base}/api/v2/browser-profile/download-kernel {kernel_type, kernel_version}。
   * 幂等：首次触发下载，之后每次返回当前进度；轮询到 status='completed' 即完成。
   * 返回 { ok:true, status, progress }（progress 0-100；completed/installing 归 100）或 { ok:false, error }。
   */
  async function downloadKernel(opts = {}) {
    const payload = JSON.stringify({ kernel_type: (opts && opts.kernelType) || 'Chrome', kernel_version: String(opts && opts.version) });
    const url = `${baseOf(opts)}/api/v2/browser-profile/download-kernel`;
    let res;
    try {
      res = await throttledRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(opts) }, body: payload });
    } catch (e) {
      return { ok: false, error: `内核下载请求失败：本地 API 不可达（${(e && e.message) || String(e)}）` };
    }
    if (!res.ok) return { ok: false, error: `内核下载请求失败（HTTP ${res.status}）` };
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: '内核下载请求失败：本地 API 响应非 JSON' };
    }
    if (typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: `内核下载失败：code=${body.code} ${body.msg || ''}`.trim() };
    }
    const d = body.data || {};
    const status = d.status || 'pending';
    const progress = ['completed', 'installing'].includes(status) ? 100 : Math.max(0, Math.min(100, Number(d.progress) || 0));
    return { ok: true, status, progress };
  }

  return {
    status,
    listProfiles,
    getProfileProxyConfig,
    listGroups,
    listActiveProfiles,
    openProfileForInspection,
    kernels,
    downloadKernel,
    brokerBatch,
    enqueueRequest: throttledRequest,
    ADS_MIN_INTERVAL_MS,
  };
}

// user/list 单项归一化。user_id=写入分身 ID 的唯一值；serial_number（UI 序号）/name/代理配置仅供展示。
function normalizeProfile(it) {
  it = it || {};
  const { platform, platformSource } = inferPlatform(it);
  return {
    userId: it.user_id != null ? String(it.user_id) : '', // ← 唯一分身 ID，写入 adsProfileId
    serialNumber: it.serial_number != null ? String(it.serial_number) : '', // 仅展示，MUST NOT 写入 adsProfileId
    name: it.name || it.username || '',
    groupName: it.group_name || '',
    platform, // 每环境平台（展示 + 选中时同步进 settings 供启动注入）
    platformSource, // remark|domain|urls|keyword|fallback——UI 对非 remark 来源标注「推断」
    proxy: summarizeProxy(it), // 代理**配置**摘要（非实测出口 IP）
    proxyConfig: structuredProxy(it), // 全量列表只投影非敏感代理字段；密码须经精确 profile 读取
  };
}

// 平台兜底推断（change edge-client-proxy-platform-persona-ux，扩展 edge-environment-platform-select 的回落）：
// remark plat（权威，永远最高）→ domain_name 命中平台域名 → open_urls 任一命中 → 分组/名称关键词 → 回落 xhs。
// 纯只读：绝不因推断回写 remark；缺字段安全降级。误推断可在加入面板显式改平台纠正（存本机 settings）。
const FB_KEYWORD_RE = /facebook|\bfb\b|脸书/i;

function platformOfUrlish(s) {
  const v = String(s || '');
  if (!v) return '';
  if (/(facebook|fb)\.com/i.test(v)) return 'facebook';
  if (/xiaohongshu\.com/i.test(v)) return 'xiaohongshu';
  return '';
}

function inferPlatform(it) {
  it = it || {};
  const meta = parseRemark(it.remark);
  if (meta) return { platform: meta.platform, platformSource: 'remark' };

  const byDomain = platformOfUrlish(it.domain_name);
  if (byDomain) return { platform: byDomain, platformSource: 'domain' };

  const urls = Array.isArray(it.open_urls) ? it.open_urls : (typeof it.open_urls === 'string' && it.open_urls ? [it.open_urls] : []);
  for (const u of urls) {
    const byUrl = platformOfUrlish(u);
    if (byUrl) return { platform: byUrl, platformSource: 'urls' };
  }

  const label = `${it.group_name || ''} ${it.name || it.username || ''}`;
  if (FB_KEYWORD_RE.test(label)) return { platform: 'facebook', platformSource: 'keyword' };

  return { platform: DEFAULT_PLATFORM, platformSource: 'fallback' };
}

// 真机 no_proxy 环境的 proxy_type = 'no_proxy'（带下划线）；兼容 noproxy/no-proxy 各写法当作无代理。
function isNoProxyType(type) {
  return !type || /^no[_-]?proxy$/i.test(type);
}

// 代理配置摘要：user/list 返回的是代理**配置**（proxy 类型/host + 配置 ip/ip_country），
// 对无代理/动态分配代理可能为空/占位——**非实测出口 IP**（实测以 AdsPower『检测代理』为准）。
function summarizeProxy(it) {
  const cfg = it.user_proxy_config || it.proxy_config || {};
  const type = cfg.proxy_type || cfg.proxy_soft || '';
  const host = cfg.proxy_host || '';
  const ip = it.ip || cfg.ip || '';
  const country = it.ip_country || cfg.ip_country || '';
  const isNoProxy = isNoProxyType(type);
  const parts = [];
  if (!isNoProxy) parts.push(type);
  if (host) parts.push(host);
  if (ip) parts.push(`ip=${ip}`);
  if (country) parts.push(country);
  return parts.length ? parts.join(' · ') : '无代理配置';
}

// 全量列表的结构化代理投影。密码只允许经 getProfileProxyConfig 精确读取，绝不随列表批量进入 renderer。
function structuredProxy(it) {
  const cfg = (it && (it.user_proxy_config || it.proxy_config)) || {};
  const type = cfg.proxy_type || cfg.proxy_soft || '';
  const noProxy = isNoProxyType(type);
  return {
    noProxy,
    proxyType: noProxy ? '' : String(type || '').toLowerCase(),
    proxyHost: cfg.proxy_host != null ? String(cfg.proxy_host) : '',
    proxyPort: cfg.proxy_port != null ? String(cfg.proxy_port) : '',
    proxyUser: cfg.proxy_user != null ? String(cfg.proxy_user) : '',
  };
}

module.exports = { createAdsLocalApi, normalizeProfile, inferPlatform, ADS_MIN_INTERVAL_MS, DEFAULT_ADS_BASE };
