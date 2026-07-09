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

const { parseRemark, DEFAULT_PLATFORM } = require('./ads-create-flow.cjs');

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
  // 主进程内**唯一**串行节流闸门：所有只读请求经 throttledFetch 排进同一条链，
  // 把「等间隔 → fetch → 记时」作为**不可重入单元**串行执行。
  // 为什么要队列而非仅一个时间戳：面板「检测」「刷新」是两个独立按钮、各自的 in-flight 禁用管不到对方，
  // 自动探测（加载/切分段/保存前）也会与手动刷新并发；若只读 lastApiAt 决定等多久，两个并发调用会同读旧值、
  // 都欠等、几乎同时发 fetch → 撞破 1req/s、把好连接自伤成假失败。队列把它们真正串行开、间隔 ≥1.1s。
  let lastApiAt = 0;
  let chain = Promise.resolve();

  function throttledFetch(url, headers) {
    const run = chain.then(async () => {
      if (lastApiAt !== 0) {
        const wait = ADS_MIN_INTERVAL_MS - (now() - lastApiAt);
        if (wait > 0) await sleep(wait);
      }
      try {
        return await fetchImpl(url, { headers });
      } finally {
        lastApiAt = now();
      }
    });
    // 断开 rejection、只为链能继续（本次结果仍由 run 返回给调用方）。
    chain = run.then(() => undefined, () => undefined);
    return run;
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
   * 拉取分组：GET {base}/api/v1/group/list（只读，供「创建环境」定位/复用专用分组）。
   * 不 throw：成功 { ok:true, groups:[{groupId, groupName}] }，失败 { ok:false, error }。
   */
  async function listGroups(opts = {}) {
    const base = baseOf(opts);
    const url = `${base}/api/v1/group/list?page=1&page_size=1000`;
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
   * 对账当前**本机已打开**的浏览器分身：GET {base}/api/v1/browser/local-active（只读）。
   * 用途（edge-multi-environment-fleet）：外壳重启时 spawn 前对账已在运行的分身——已在运行则接管、
   * 不重复拉起（防孤儿 + 防同 edgeId 第二连接被云端互踢）。
   * 不 throw：成功 { ok:true, activeUserIds:[...] }，失败 { ok:false, error }（调用方按「无法对账」诚实处理）。
   */
  async function listActiveProfiles(opts = {}) {
    const url = `${baseOf(opts)}/api/v1/browser/local-active`;
    let res;
    try {
      res = await throttledFetch(url, authHeaders(opts));
    } catch (e) {
      return { ok: false, error: `对账在跑分身失败：本地 API 不可达（${(e && e.message) || String(e)}）` };
    }
    if (!res.ok) {
      return { ok: false, error: `对账在跑分身失败（HTTP ${res.status}）` };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: '对账在跑分身失败：本地 API 响应非 JSON' };
    }
    if (typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: `对账在跑分身失败：code=${body.code} ${body.msg || ''}`.trim() };
    }
    const data = body.data || {};
    const list = Array.isArray(data.list) ? data.list : [];
    const activeUserIds = list
      .map((it) => (it && it.user_id != null ? String(it.user_id) : ''))
      .filter(Boolean);
    return { ok: true, activeUserIds };
  }

  return { status, listProfiles, listGroups, listActiveProfiles, ADS_MIN_INTERVAL_MS };
}

// user/list 单项归一化。user_id=写入分身 ID 的唯一值；serial_number（UI 序号）/name/代理配置仅供展示。
function normalizeProfile(it) {
  it = it || {};
  // change edge-environment-platform-select：从 remark 解出该环境的平台（旧环境无 plat → 回落 xiaohongshu）。
  const meta = parseRemark(it.remark);
  return {
    userId: it.user_id != null ? String(it.user_id) : '', // ← 唯一分身 ID，写入 adsProfileId
    serialNumber: it.serial_number != null ? String(it.serial_number) : '', // 仅展示，MUST NOT 写入 adsProfileId
    name: it.name || it.username || '',
    groupName: it.group_name || '',
    platform: meta ? meta.platform : DEFAULT_PLATFORM, // 每环境平台（展示 + 选中时同步进 settings 供启动注入）
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
  // 真机 no_proxy 环境的 proxy_type = 'no_proxy'（带下划线）；兼容 noproxy/no-proxy 各写法当作无代理。
  const isNoProxy = !type || /^no[_-]?proxy$/i.test(type);
  const parts = [];
  if (!isNoProxy) parts.push(type);
  if (host) parts.push(host);
  if (ip) parts.push(`ip=${ip}`);
  if (country) parts.push(country);
  return parts.length ? parts.join(' · ') : '无代理配置';
}

module.exports = { createAdsLocalApi, normalizeProfile, ADS_MIN_INTERVAL_MS, DEFAULT_ADS_BASE };
