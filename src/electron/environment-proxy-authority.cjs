'use strict';

const { isIP } = require('node:net');
const { normalizeProxyInput, canonicalProxyInput } = require('./ads-proxy-config.cjs');

function cloudAuthorityForProxyInput(proxyInput) {
  const normalized = normalizeProxyInput(proxyInput || {});
  if (!normalized.ok) return { ok: false, error: `代理输入不合法：${normalized.error}` };
  if (normalized.noProxy) {
    return { ok: true, noProxy: true, authority: { state: 'no_proxy' }, proxyConfig: null };
  }
  const cfg = normalized.proxyConfig;
  return {
    ok: true,
    noProxy: false,
    authority: {
      state: 'configured',
      proxyType: cfg.proxy_type,
      proxyHost: cfg.proxy_host,
      proxyPort: Number(cfg.proxy_port),
      proxyUser: cfg.proxy_user || '',
      proxyPassword: cfg.proxy_password || '',
    },
    proxyConfig: cfg,
  };
}

function normalizeCloudProxyAuthorityRecord(value, expectedProfileId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'proxy_authority_malformed' };
  }
  const profileId = String(value.envKey || '').trim();
  const expected = String(expectedProfileId || '').trim();
  const revision = Number(value.revision);
  const recoverableRevision = profileId && profileId === expected
    && Number.isInteger(revision) && revision > 0
    ? revision
    : null;
  const malformed = () => ({
    ok: false,
    reason: 'proxy_authority_malformed',
    ...(recoverableRevision ? { currentRevision: recoverableRevision } : {}),
  });
  const authority = value.authority;
  if (!profileId || profileId !== expected || !Number.isInteger(revision) || revision < 1
    || !authority || typeof authority !== 'object' || Array.isArray(authority)) {
    return malformed();
  }
  if (authority.state === 'no_proxy') {
    if (Object.keys(authority).length !== 1) return malformed();
    return {
      ok: true,
      noProxy: true,
      profileId,
      revision,
      proxyConfig: null,
      proxy: { proxyType: 'no_proxy' },
    };
  }
  if (authority.state !== 'configured') return malformed();
  const configuredKeys = ['state', 'proxyType', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyPassword'];
  if (Object.keys(authority).some((key) => !configuredKeys.includes(key))
    || typeof authority.proxyType !== 'string'
    || typeof authority.proxyHost !== 'string'
    || typeof authority.proxyPort !== 'number'
    || typeof authority.proxyUser !== 'string'
    || typeof authority.proxyPassword !== 'string') {
    return malformed();
  }
  const normalized = normalizeProxyInput({
    proxyType: authority.proxyType,
    proxyHost: authority.proxyHost,
    proxyPort: authority.proxyPort,
    proxyUser: authority.proxyUser,
    proxyPassword: authority.proxyPassword,
  });
  if (!normalized.ok || normalized.noProxy) return malformed();
  return {
    ok: true,
    noProxy: false,
    profileId,
    revision,
    proxyConfig: normalized.proxyConfig,
    proxy: canonicalProxyInput(normalized.proxyConfig),
  };
}

function adsNoProxyAuthorityView(value, expectedProfileId) {
  const profileId = String(expectedProfileId || '').trim();
  if (!profileId || !value || value.ok !== true || value.noProxy !== true) return null;
  return {
    ok: true,
    noProxy: true,
    profileId,
    revision: null,
    proxyConfig: null,
    proxy: { proxyType: 'no_proxy' },
    source: 'ads_no_proxy',
  };
}

function proxyEditorRepairView(value) {
  const revision = Number(value && value.currentRevision);
  return {
    ok: true,
    noProxy: false,
    repairRequired: true,
    proxy: {
      proxyType: 'http',
      proxyHost: '',
      proxyPort: '',
      proxyUser: '',
      proxyPassword: '',
    },
    ...(Number.isInteger(revision) && revision > 0 ? { currentRevision: revision } : {}),
  };
}

function normalizeHostForLoopback(host) {
  const value = String(host || '').trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
  return value;
}

function isLoopbackProxyConfig(proxyConfig) {
  const normalized = normalizeProxyInput({
    proxyType: proxyConfig && proxyConfig.proxy_type,
    proxyHost: proxyConfig && proxyConfig.proxy_host,
    proxyPort: proxyConfig && proxyConfig.proxy_port,
    proxyUser: proxyConfig && proxyConfig.proxy_user,
    proxyPassword: proxyConfig && proxyConfig.proxy_password,
  });
  if (!normalized.ok || normalized.noProxy) return true;
  const host = normalizeHostForLoopback(normalized.proxyConfig.proxy_host);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || host === '0:0:0:0:0:0:0:1' || host.startsWith('::ffff:127.')) {
    return true;
  }
  if (isIP(host) === 4) {
    const first = Number(host.split('.')[0]);
    return first === 127 || host === '0.0.0.0';
  }
  return false;
}

function migrationAuthorityFromLocalRecord(localRecord) {
  if (!localRecord || localRecord.ok !== true) {
    return { ok: false, reason: 'local_proxy_authority_unavailable' };
  }
  if (!localRecord.found) return { ok: false, reason: 'proxy_authority_uninitialized' };
  if (isLoopbackProxyConfig(localRecord.proxyConfig)) {
    return { ok: false, reason: 'local_proxy_authority_loopback_rejected' };
  }
  const canonical = canonicalProxyInput(localRecord.proxyConfig);
  return cloudAuthorityForProxyInput(canonical);
}

module.exports = {
  adsNoProxyAuthorityView,
  cloudAuthorityForProxyInput,
  isLoopbackProxyConfig,
  migrationAuthorityFromLocalRecord,
  normalizeCloudProxyAuthorityRecord,
  proxyEditorRepairView,
};
