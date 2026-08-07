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
  createProxyPreflightController,
  preflightFacebookProxy,
  publicSnapshot,
  proxyUrlForConfig,
  reasonForError,
};
