'use strict';

const { isIP } = require('node:net');

const STATES = new Set(['pending', 'verified', 'same_as_host', 'unavailable', 'stale']);

function normalizeIp(value) {
  let candidate = String(value || '').trim();
  if (!candidate) return '';
  if (candidate.startsWith('[')) {
    const closing = candidate.indexOf(']');
    if (closing > 0) candidate = candidate.slice(1, closing);
  }
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const mapped = candidate.slice(7);
    if (isIP(mapped) === 4) candidate = mapped;
  }
  return isIP(candidate) ? candidate.toLowerCase() : '';
}

/** 核心 stdout → fleet 的最小 allowlist；拒绝把任意结构化字段带进渲染层。 */
function normalizeProxyRuntime(value) {
  if (!value || typeof value !== 'object') return null;
  const state = STATES.has(value.state) ? value.state : null;
  if (!state) return null;
  const bytes = Number(value.sessionReceivedBytes);
  const generation = Number(value.generation);
  const normalizedGeneration = Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
  if (state === 'stale') {
    return {
      state,
      generation: normalizedGeneration,
      sessionReceivedBytes: 0,
    };
  }
  const checkedAtMs = typeof value.checkedAt === 'string' ? Date.parse(value.checkedAt) : NaN;
  const browserIp = normalizeIp(value.browserIp);
  const directIp = normalizeIp(value.directIp);
  return {
    state,
    generation: normalizedGeneration,
    sessionReceivedBytes: Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0,
    ...(browserIp ? { browserIp } : {}),
    ...(directIp ? { directIp } : {}),
    ...(Number.isFinite(checkedAtMs) ? { checkedAt: new Date(checkedAtMs).toISOString() } : {}),
  };
}

function invalidateProxyRuntime(value) {
  const current = normalizeProxyRuntime(value);
  if (!current) return null;
  return {
    state: 'stale',
    generation: current.generation,
    sessionReceivedBytes: 0,
  };
}

module.exports = { invalidateProxyRuntime, normalizeProxyRuntime };
