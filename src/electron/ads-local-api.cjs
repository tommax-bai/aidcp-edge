// AdsPower 本地 API 的**主进程侧只读客户端**（探测可用性 + 拉取浏览器环境列表）。
//
// 为什么单独一份（不复用核心 src/cdp/browser-provider.ts 的 api<T>()）：
//  - 进程边界：面板探测/拉取在 Electron 主进程（main.cjs）发起，而核心 AdsPowerProvider 及其 1req/s 节流
//    （实例私有字段 lastApiAt）跑在 main.cjs 用 spawn 拉起的**独立子进程**里——两进程堆内存不通，无法共享节流；
//    且 main.cjs 是 CommonJS、核心产物是 ESM，require 也复用不了（比照 chrome-launcher.cjs 与 cdp/chrome-launcher.ts 并存）。
//    更何况探测常发生在核心尚未 spawn 之时（分身 ID 为空则根本不起核心）。故本模块**自持一套独立节流**，这是唯一可行形态。
//  - URL 前缀：核心 api<T>() 把 `/api/v1/` 前缀写死；而健康检查在**根级** `/status`（不在 /api/v1 下），
//    若套用会打到不存在的 /api/v1/status → 404 → 谎报「不可达」。故本模块**逐端点显式拼 URL**。
//
// 红线：只读（仅 /status 与 user/list），MUST NOT 触碰 browser/start|stop|active；探测/拉取失败诚实回报、不假成功。
// 敏感值：apiKey 只用于本次请求的 Authorization 头，不落日志、不写文件。

const ADS_MIN_INTERVAL_MS = 1100; // 本地 API 限速 1req/s，留余量串行节流（与核心同规格、但独立实例）
const DEFAULT_ADS_BASE = 'http://local.adspower.net:50325';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10; // 上限，避免超大环境量拉不停；超限如实标 truncated

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建一个主进程侧的 AdsPower 只读客户端（单例持有一条串行节流）。
 * @param {{ apiBase?: string, apiKey?: string, fetchImpl?: typeof fetch, nowImpl?: () => number, sleepImpl?: (ms:number)=>Promise<void> }} deps
 */
function createAdsLocalApi(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.nowImpl || (() => Date.now());
  const sleep = deps.sleepImpl || defaultSleep;
  // 主进程内**唯一**串行节流闸门：所有只读调用过这里，按 ≥1.1s 间隔发出。
  let lastApiAt = 0;

  async function throttle() {
    if (lastApiAt !== 0) {
      const wait = ADS_MIN_INTERVAL_MS - (now() - lastApiAt);
      if (wait > 0) await sleep(wait);
    }
  }
  function markCalled() {
    lastApiAt = now();
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

  /**
   * 健康检查：GET {base}/status（**根级**，不带 /api/v1 前缀，通常免鉴权）。
   * 不 throw：可达返回 { ok:true }，不可达/异常返回 { ok:false, error }（供面板分档提示）。
   */
  async function status(opts) {
    await throttle();
    const url = `${baseOf(opts)}/status`;
    let res;
    try {
      res = await fetchImpl(url, { headers: authHeaders(opts) });
    } catch (e) {
      markCalled();
      return { ok: false, error: `未检测到 AdsPower 本地 API：${(e && e.message) || String(e)}` };
    }
    markCalled();
    if (!res.ok) {
      // 收到响应但非 2xx：本地 API 端口有人应答但异常（非「不可达」）。如实标 HTTP 码。
      return { ok: false, error: `AdsPower 本地 API 响应异常（HTTP ${res.status}）` };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body && typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: `AdsPower 本地 API 返回 code=${body.code} ${body.msg || ''}`.trim() };
    }
    return { ok: true };
  }

  /**
   * 拉取浏览器环境：GET {base}/api/v1/user/list（分页，可选 group_id；开 API 校验时带 Bearer）。
   * 不 throw：成功返回 { ok:true, profiles:[...], truncated }，失败返回 { ok:false, error, authLikely }。
   * 归一化：user_id 是写入分身 ID 字段的唯一值（下游 browser/start 只认它）；serial_number/name 仅供展示。
   */
  async function listProfiles(opts = {}) {
    const base = baseOf(opts);
    const headers = authHeaders(opts);
    const pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : DEFAULT_PAGE_SIZE;
    const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : DEFAULT_MAX_PAGES;
    const profiles = [];
    let total;
    for (let page = 1; page <= maxPages; page++) {
      await throttle();
      const qs = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
      if (opts.groupId) qs.set('group_id', String(opts.groupId));
      const url = `${base}/api/v1/user/list?${qs.toString()}`;
      let res;
      try {
        res = await fetchImpl(url, { headers });
      } catch (e) {
        markCalled();
        return { ok: false, error: `拉取环境失败：本地 API 不可达（${(e && e.message) || String(e)}）` };
      }
      markCalled();
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

  return { status, listProfiles, ADS_MIN_INTERVAL_MS };
}

// user/list 单项归一化。user_id=写入分身 ID 的唯一值；serial_number（UI 序号）/name/代理配置仅供展示。
function normalizeProfile(it) {
  it = it || {};
  return {
    userId: it.user_id != null ? String(it.user_id) : '', // ← 唯一分身 ID，写入 adsProfileId
    serialNumber: it.serial_number != null ? String(it.serial_number) : '', // 仅展示，MUST NOT 写入 adsProfileId
    name: it.name || it.username || '',
    groupName: it.group_name || '',
    proxy: summarizeProxy(it), // 代理**配置**摘要（非实测出口 IP）
  };
}

// 代理配置摘要：user/list 返回的是代理**配置**（proxy 类型/host + 配置 ip/ip_country），
// 对无代理/动态分配代理可能为空/占位——**非实测出口 IP**（实测以 AdsPower『检测代理』为准）。
function summarizeProxy(it) {
  const cfg = it.user_proxy_config || it.proxy_config || {};
  const type = cfg.proxy_type || cfg.proxy_soft || '';
  const host = cfg.proxy_host || '';
  const ip = it.ip || cfg.ip || '';
  const country = it.ip_country || cfg.ip_country || '';
  const parts = [];
  if (type && type !== 'noproxy') parts.push(type);
  if (host) parts.push(host);
  if (ip) parts.push(`ip=${ip}`);
  if (country) parts.push(country);
  return parts.length ? parts.join(' · ') : '无代理配置';
}

module.exports = { createAdsLocalApi, normalizeProfile, ADS_MIN_INTERVAL_MS, DEFAULT_ADS_BASE };
