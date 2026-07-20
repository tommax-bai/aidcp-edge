'use strict';

/**
 * Browser-independent client-core bootstrap supervisor.
 *
 * This queue is intentionally separate from browser slots and the AdsPower lifecycle queue. A failed
 * environment backs off independently; repeated failures open only that environment's circuit.
 */
function createCoreBootstrapSupervisor({
  concurrency = 3,
  baseBackoffMs = 1_000,
  maxBackoffMs = 60_000,
  maxFailures = 5,
  circuitCooldownMs = 5 * 60_000,
  random = Math.random,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 3;
  const states = new Map();
  const pending = [];
  let active = 0;

  function stateFor(key) {
    let state = states.get(key);
    if (!state) {
      state = { failures: 0, running: false, queued: false, timer: null, circuitUntil: 0, lastError: '' };
      states.set(key, state);
    }
    return state;
  }

  function retryDelay(failures) {
    const exponential = Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.max(0, failures - 1)));
    const jitter = 0.75 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.5;
    return Math.max(1, Math.round(exponential * jitter));
  }

  function drain() {
    while (active < limit && pending.length > 0) {
      const job = pending.shift();
      const state = stateFor(job.key);
      state.queued = false;
      if (state.running || job.cancelled()) continue;
      if (state.circuitUntil > now()) {
        schedule(job, state.circuitUntil - now());
        continue;
      }
      state.running = true;
      active += 1;
      Promise.resolve()
        .then(job.start)
        .then((ok) => {
          if (ok) {
            state.failures = 0;
            state.circuitUntil = 0;
            state.lastError = '';
            return;
          }
          throw new Error('core_bootstrap_not_ready');
        })
        .catch((error) => {
          state.failures += 1;
          state.lastError = String((error && error.message) || error || 'core_bootstrap_failed');
          if (state.failures >= maxFailures) {
            state.circuitUntil = now() + circuitCooldownMs;
            state.failures = 0;
            schedule(job, circuitCooldownMs);
          } else {
            schedule(job, retryDelay(state.failures));
          }
        })
        .finally(() => {
          state.running = false;
          active -= 1;
          drain();
        });
    }
  }

  function schedule(job, delayMs) {
    const state = stateFor(job.key);
    if (state.timer || job.cancelled()) return;
    state.timer = setTimer(() => {
      state.timer = null;
      enqueue(job);
    }, Math.max(1, delayMs));
    if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
  }

  function enqueue(job) {
    const key = String(job && job.key || '').trim();
    if (!key || typeof job.start !== 'function') return false;
    const normalized = {
      key,
      start: job.start,
      cancelled: typeof job.cancelled === 'function' ? job.cancelled : () => false,
    };
    const state = stateFor(key);
    if (state.running || state.queued || state.timer || normalized.cancelled()) return false;
    state.queued = true;
    pending.push(normalized);
    drain();
    return true;
  }

  function remove(key) {
    const normalized = String(key || '').trim();
    const state = states.get(normalized);
    if (!state) return;
    if (state.timer) clearTimer(state.timer);
    states.delete(normalized);
    for (const job of pending) {
      if (job.key === normalized) job.cancelled = () => true;
    }
  }

  function snapshot(key) {
    const state = states.get(String(key || '').trim());
    if (!state) return null;
    return {
      failures: state.failures,
      running: state.running,
      queued: state.queued,
      retryScheduled: Boolean(state.timer),
      circuitUntil: state.circuitUntil,
      lastError: state.lastError,
    };
  }

  return { enqueue, remove, snapshot, retryDelay };
}

module.exports = { createCoreBootstrapSupervisor };
