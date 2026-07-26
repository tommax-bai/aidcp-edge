'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeProxyInput } = require('./ads-proxy-config.cjs');
const { safeStorageAvailable, writePrivateJsonAtomic } = require('./customer-auth-security.cjs');

const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

function normalizeAuthorityProxy(proxyConfig) {
  const normalized = normalizeProxyInput({
    proxyType: proxyConfig && proxyConfig.proxy_type,
    proxyHost: proxyConfig && proxyConfig.proxy_host,
    proxyPort: proxyConfig && proxyConfig.proxy_port,
    proxyUser: proxyConfig && proxyConfig.proxy_user,
    proxyPassword: proxyConfig && proxyConfig.proxy_password,
  });
  if (!normalized.ok || normalized.noProxy) {
    return { ok: false, error: '原环境代理配置不合法' };
  }
  return { ok: true, proxyConfig: normalized.proxyConfig };
}

function createAdsProxyAuthorityStore({
  directory,
  safeStorage,
  writeAtomic = writePrivateJsonAtomic,
  fsImpl = fs,
} = {}) {
  if (!directory) throw new TypeError('directory is required');

  function validateProfileId(profileId) {
    const value = String(profileId || '').trim();
    if (!PROFILE_ID_RE.test(value)) return null;
    return value;
  }

  function fileFor(profileId) {
    const digest = createHash('sha256').update(profileId, 'utf8').digest('hex');
    return path.join(directory, `${digest}.json`);
  }

  function load(profileId) {
    const userId = validateProfileId(profileId);
    if (!userId) return { ok: false, error: '环境 profile id 不合法' };
    const file = fileFor(userId);
    if (!fsImpl.existsSync(file)) return { ok: true, found: false };
    if (!safeStorageAvailable(safeStorage)) {
      return { ok: false, error: '系统安全存储不可用，无法读取原环境代理' };
    }
    try {
      const record = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      if (!record || record.version !== 1 || record.protection !== 'safeStorage'
        || typeof record.ciphertext !== 'string' || !record.ciphertext) {
        return { ok: false, error: '原环境代理加密记录格式无效' };
      }
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(record.ciphertext, 'base64')));
      if (!value || value.version !== 1 || value.userId !== userId) {
        return { ok: false, error: '原环境代理加密记录与环境不匹配' };
      }
      const normalized = normalizeAuthorityProxy(value.proxyConfig);
      if (!normalized.ok) return normalized;
      return { ok: true, found: true, proxyConfig: normalized.proxyConfig };
    } catch {
      return { ok: false, error: '原环境代理加密记录无法解密' };
    }
  }

  function save(profileId, proxyConfig) {
    const userId = validateProfileId(profileId);
    if (!userId) return { ok: false, error: '环境 profile id 不合法' };
    const normalized = normalizeAuthorityProxy(proxyConfig);
    if (!normalized.ok) return normalized;
    if (!safeStorageAvailable(safeStorage)) {
      return { ok: false, error: '系统安全存储不可用，无法保存原环境代理' };
    }
    try {
      const ciphertext = safeStorage.encryptString(JSON.stringify({
        version: 1,
        userId,
        proxyConfig: normalized.proxyConfig,
      }));
      writeAtomic(fileFor(userId), {
        version: 1,
        protection: 'safeStorage',
        ciphertext: ciphertext.toString('base64'),
      });
      return { ok: true };
    } catch {
      return { ok: false, error: '原环境代理加密保存失败' };
    }
  }

  function remove(profileId) {
    const userId = validateProfileId(profileId);
    if (!userId) return { ok: false, error: '环境 profile id 不合法' };
    try {
      fsImpl.unlinkSync(fileFor(userId));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return { ok: false, error: '原环境代理记录删除失败' };
    }
    return { ok: true };
  }

  return { load, save, remove };
}

module.exports = {
  createAdsProxyAuthorityStore,
  normalizeAuthorityProxy,
};
