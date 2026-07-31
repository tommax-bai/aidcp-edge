'use strict';

const STATES = new Set(['active', 'stale']);

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
  return {
    state,
    generation: normalizedGeneration,
    sessionReceivedBytes: Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0,
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
