'use strict';

const https = require('node:https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { normalizeProxyInput } = require('./ads-proxy-config.cjs');

const DEFAULT_TARGET_URL = 'https://www.facebook.com/';
// 探测只发一次、不重试，所以这个窗口就是「抖动能不能被熬过去」的唯一余量：窗口内恢复 = 本次启动照常，
// 窗口不够 = 一次抖动直接判成一次启动失败。放宽到 25s 换的就是这个——代价只落在**失败**路径上
// （链路正常时首字节 1~2s 就回来了，成功不会因此变慢），且串行启动队列里一个卡满的环境会挡住后面的。
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_TTL_MS = 2 * 60_000;

function proxyUrlForConfig(proxy) {
  const normalized = normalizeProxyInput(proxy || {});
  if (!normalized.ok) return { ok: false, reason: 'config_invalid' };
  if (normalized.noProxy) return { ok: true, noProxy: true };
  const cfg = normalized.proxyConfig;
  const protocol = cfg.proxy_type === 'socks5' ? 'socks5:' : `${cfg.proxy_type}:`;
  const url = new URL(`${protocol}//proxy.invalid`);
  url.hostname = cfg.proxy_host;
  url.port = cfg.proxy_port;
  if (cfg.proxy_user) url.username = cfg.proxy_user;
  if (cfg.proxy_password) url.password = cfg.proxy_password;
  return { ok: true, noProxy: false, proxyType: cfg.proxy_type, url };
}

function defaultAgentFactory(proxyType, proxyUrl) {
  if (proxyType === 'socks5') return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

function reasonForError(error) {
  const code = String(error && error.code || '').toUpperCase();
  const message = String(error && error.message || '').toLowerCase();
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || message.includes('timeout')) return 'timeout';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host_unresolved';
  if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'EPROTO' || message.includes('wrong version number')) {
    return 'protocol_mismatch';
  }
  if (message.includes('407') || message.includes('proxy authentication')) return 'authentication_failed';
  if (message.includes('proxy connection') || message.includes('connect')) return 'proxy_connect_failed';
  return 'request_failed';
}

/**
 * 「同一次探测原样重来，有没有可能得到不同结果」——只有答「有可能」的失败配消费重排预算。
 *
 * 列进来的都是**重来必然同样结果**的：凭据或配置本身不对（重排只会反复打代理商的认证）、
 * 系统前置代理压根没配或类型不受支持、环境代理权威读不出或已换版本、中继二进制不存在。
 *
 * 实现刻意用**不可恢复白名单**，而不是列一张可恢复白名单：任何没被显式列进来的原因——包括
 * 将来新增的、以及此刻还没人见过的——都落进可恢复。反过来做就是本仓明令禁止的兜底桶：把没
 * 认出来的原因折进一个已有的终局名，跨层传下去就成了「这件事做不到」，而没有任何作者做过这
 * 个决定。两种错判的代价也不对等——错判成可恢复只是多探两次，错判成不可恢复是把一个本来能
 * 起来的环境判死。
 */
const NON_RECOVERABLE_PREFLIGHT_REASONS = new Set([
  // 凭据 / 代理配置本身
  'config_invalid',
  'protocol_mismatch',
  'authentication_failed',
  'environment_proxy_missing',
  // 系统前置代理：没配、类型不支持、与环境代理撞成同一端点
  'system_proxy_not_configured',
  'system_proxy_pac_unsupported',
  'system_proxy_wpad_unsupported',
  'system_proxy_platform_unsupported',
  'system_proxy_config_invalid',
  'proxy_chain_duplicate_hop',
  // 环境代理权威
  'proxy_authority_unavailable',
  'proxy_authority_uninitialized',
  'proxy_authority_revision_changed',
  'proxy_authority_malformed',
  'local_proxy_authority_unavailable',
  'local_proxy_authority_loopback_rejected',
  // 中继二进制不存在：重来同样不存在
  'proxy_chain_binary_missing',
]);

/** true = 值得重排再试一次；false = 重来必然同样结果，当场终结。未知原因一律 true（见上方注释）。 */
function preflightFailureIsRecoverable(reason) {
  return !NON_RECOVERABLE_PREFLIGHT_REASONS.has(String(reason || ''));
}

/** 默认重排预算与递增间隔（宿主可覆盖；设 max=0 逐字退回「确定失败当场终结」的旧行为）。 */
const DEFAULT_REQUEUE_MAX = 2;
const DEFAULT_REQUEUE_DELAYS_MS = [20_000, 60_000];

/**
 * 预检确定失败的处置决策 —— **纯函数**，宿主只做薄接线。
 *
 * 刻意抽出闭包外：宿主那段是 Electron 主进程的大闭包，对它只能扫源码文本，而文本断言扫不出
 * 「这道闸真的会拦」——现实形态的削弱（把重排改成无条件、把预算判反、把不可恢复也放进重排）
 * 在那种断言下会全部存活。做成纯函数后，用例驱动真实现并逐项断言三条出口，删掉任何一条当场红。
 *
 * 三条出口互不重叠：
 *   · terminate/config    重来必然同样结果 ⇒ 当场终结，不消费预算
 *   · requeue             可恢复且预算未尽 ⇒ 重排，返回这是第几次与该等多久
 *   · terminate/exhausted 可恢复但预算已尽 ⇒ 终结，且回执必须写成「试了 probes 次没通」
 */
function decideProxyPreflightFailure({ reason, requeuesUsed, maxRequeues, delaysMs } = {}) {
  const max = Number.isFinite(maxRequeues) && maxRequeues >= 0 ? Math.floor(maxRequeues) : DEFAULT_REQUEUE_MAX;
  const used = Number.isFinite(requeuesUsed) && requeuesUsed > 0 ? Math.floor(requeuesUsed) : 0;
  // 预算 0 ＝ 重排通道整个关掉的回滚旋钮 ⇒ 走 config 出口而非 exhausted：回滚要连**回执措辞**一起
  // 退回旧行为，否则运营会在一个本该「什么都没变」的回滚后读到一句新造的「重试预算耗尽」。
  if (max === 0 || !preflightFailureIsRecoverable(reason)) {
    return { action: 'terminate', terminal: 'config', reason };
  }
  if (used >= max) {
    return { action: 'terminate', terminal: 'exhausted', reason, probes: used + 1 };
  }
  const delays = Array.isArray(delaysMs) && delaysMs.length > 0 ? delaysMs : DEFAULT_REQUEUE_DELAYS_MS;
  const attempt = used + 1;
  return {
    action: 'requeue',
    reason,
    attempt,
    maxRequeues: max,
    delayMs: delays[Math.min(attempt - 1, delays.length - 1)],
  };
}

/**
 * 使用 AdsPower 已保存的代理发起一次不含身份信息的 Facebook HEAD 请求。
 * 返回值只含固定枚举，不回传 URL、host、用户名、密码或底层错误正文。
 */
async function preflightFacebookProxy(proxy, options = {}) {
  const checkedAt = new Date((options.now || Date.now)()).toISOString();
  const parsed = proxyUrlForConfig(proxy);
  if (!parsed.ok) return { state: 'unavailable', checkedAt, reason: parsed.reason };
  if (parsed.noProxy) return { state: 'skipped', checkedAt, reason: 'no_proxy' };

  const targetUrl = String(options.targetUrl || DEFAULT_TARGET_URL);
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const requestImpl = options.requestImpl || https.request;
  let agent;
  try {
    agent = (options.agentFactory || defaultAgentFactory)(parsed.proxyType, parsed.url);
  } catch {
    return { state: 'unknown', checkedAt, reason: 'detector_unavailable' };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, checkedAt });
    };
    let request;
    const timer = setTimeout(() => {
      const error = new Error('proxy_preflight_timeout');
      error.code = 'ETIMEDOUT';
      request?.destroy?.(error);
      finish({ state: 'unavailable', reason: 'timeout' });
    }, timeoutMs);
    timer.unref?.();

    try {
      request = requestImpl(targetUrl, {
        method: 'HEAD',
        agent,
        headers: {
          accept: '*/*',
          connection: 'close',
          'user-agent': 'AIDCP-Proxy-Preflight/1.0',
        },
      }, (response) => {
        response.resume?.();
        if (Number(response.statusCode) === 407) {
          finish({ state: 'unavailable', reason: 'authentication_failed' });
          return;
        }
        finish({ state: 'available', reason: 'facebook_reachable' });
      });
      request.once('error', (error) => {
        finish({ state: 'unavailable', reason: reasonForError(error) });
      });
      request.end();
    } catch {
      finish({ state: 'unknown', reason: 'detector_unavailable' });
    }
  });
}

function publicSnapshot(result) {
  if (!result || typeof result !== 'object') return null;
  const allowed = new Set(['checking', 'available', 'unavailable', 'unknown', 'skipped']);
  if (!allowed.has(result.state)) return null;
  return {
    state: result.state,
    ...(typeof result.checkedAt === 'string' ? { checkedAt: result.checkedAt } : {}),
    ...(Number.isInteger(result.authorityRevision) && result.authorityRevision > 0
      ? { authorityRevision: result.authorityRevision }
      : {}),
  };
}

/** 每环境内存单飞 + 短时缓存；entries 永不保存代理配置或认证信息。 */
function createProxyPreflightController(options = {}) {
  if (typeof options.readProxy !== 'function') throw new TypeError('readProxy is required');
  const readProxy = options.readProxy;
  const probe = options.probe || preflightFacebookProxy;
  const now = options.now || Date.now;
  const ttlMs = Math.max(1_000, Number(options.ttlMs) || DEFAULT_TTL_MS);
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => undefined;
  const entries = new Map();

  const notify = (envId, result) => {
    try { onUpdate(envId, publicSnapshot(result)); } catch { /* 状态投影失败不得改变检测结论 */ }
  };

  function invalidate(envId) {
    const key = String(envId || '');
    if (!key) return;
    entries.delete(key);
    notify(key, null);
  }

  function freshResult(entry, authorityRevision) {
    if (!entry || !entry.result || entry.result.state === 'unknown') return null;
    if (Number.isInteger(authorityRevision) && entry.authorityRevision !== authorityRevision) return null;
    return entry.expiresAt > now() ? entry.result : null;
  }

  function ensure({ envId, profileId, proxyConfig, authorityRevision }) {
    const key = String(envId || '').trim();
    const id = String(profileId || '').trim();
    const requestedRevision = Number.isInteger(authorityRevision) && authorityRevision > 0
      ? authorityRevision
      : null;
    if (!key || !id) {
      return Promise.resolve({ state: 'unknown', checkedAt: new Date(now()).toISOString(), reason: 'profile_config_unavailable' });
    }
    const current = entries.get(key);
    if (current?.promise && current.authorityRevision === requestedRevision) return current.promise;
    const fresh = freshResult(current, requestedRevision);
    if (fresh) return Promise.resolve(fresh);

    notify(key, { state: 'checking' });
    let promise;
    promise = (async () => {
      let result;
      try {
        const config = proxyConfig || await readProxy(id);
        const resolvedRevision = requestedRevision
          || (Number.isInteger(config && config.revision) && config.revision > 0 ? config.revision : null);
        if (!config || config.ok !== true) {
          result = config && config.blocking === true
            ? {
                state: 'unavailable',
                checkedAt: new Date(now()).toISOString(),
                reason: String(config.reason || 'profile_config_unavailable'),
              }
            : { state: 'unknown', checkedAt: new Date(now()).toISOString(), reason: 'profile_config_unavailable' };
        } else if (config.noProxy) {
          result = { state: 'skipped', checkedAt: new Date(now()).toISOString(), reason: 'no_proxy' };
        } else {
          result = await probe(config.proxy, { now });
        }
        if (resolvedRevision) result = { ...result, authorityRevision: resolvedRevision };
      } catch {
        result = { state: 'unknown', checkedAt: new Date(now()).toISOString(), reason: 'detector_unavailable' };
      }
      if (entries.get(key)?.promise !== promise) {
        return { state: 'unknown', checkedAt: new Date(now()).toISOString(), reason: 'superseded' };
      }
      entries.set(key, {
        result,
        authorityRevision: result.authorityRevision || requestedRevision,
        expiresAt: result.state === 'unknown' ? now() : now() + ttlMs,
      });
      notify(key, result);
      return result;
    })();
    entries.set(key, { promise, authorityRevision: requestedRevision });
    return promise;
  }

  function snapshot(envId) {
    const entry = entries.get(String(envId || ''));
    if (entry?.promise) return { state: 'checking' };
    return publicSnapshot(entry?.result);
  }

  return { ensure, invalidate, snapshot };
}

module.exports = {
  DEFAULT_TARGET_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  DEFAULT_REQUEUE_DELAYS_MS,
  DEFAULT_REQUEUE_MAX,
  NON_RECOVERABLE_PREFLIGHT_REASONS,
  createProxyPreflightController,
  decideProxyPreflightFailure,
  preflightFacebookProxy,
  preflightFailureIsRecoverable,
  publicSnapshot,
  proxyUrlForConfig,
  reasonForError,
};
