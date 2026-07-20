const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function cleanError(error) {
  return String((error && error.message) || error || 'unknown_error')
    .replace(/(authorization|bearer|token|api[_ -]?key|cookie)\s*[=:]?\s*[^\s,;]+/ig, '$1=***')
    .slice(0, 1000);
}

function createFileMaintenanceStateStore(file) {
  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        version: 1,
        installationId: typeof raw.installationId === 'string' ? raw.installationId : '',
        outbox: Array.isArray(raw.outbox) ? raw.outbox.filter((item) => item && typeof item.requestId === 'string') : [],
      };
    } catch {
      return { version: 1, installationId: '', outbox: [] };
    }
  }
  function save(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX filesystem */ }
  }
  return { load, save };
}

/**
 * Cloud desired-state maintenance over customer-auth HTTP. This is deliberately independent from
 * EdgeClient/WebSocket active commands: normal client state is pulled, while browser automation remains pushed.
 */
function createEnvironmentMaintenance({
  stateStore,
  clientFetch,
  listEnvironments,
  stopEnvironment,
  deleteEnvironment,
  onUnauthorized = () => undefined,
  logger = console,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  let running = false;

  function loadState() {
    const state = stateStore.load();
    if (!state.installationId) {
      state.installationId = randomUUID();
      stateStore.save(state); // 无稳定安装身份就绝不轮询/认领。
    }
    return state;
  }

  function saveState(state) {
    stateStore.save({ version: 1, installationId: state.installationId, outbox: state.outbox });
  }

  async function submitResult(state, receipt) {
    if (receipt.phase !== 'result_ready') return false;
    if (!Number.isInteger(receipt.version) || receipt.version < 1) return false;
    const response = await clientFetch(
      `/environment-maintenance/deletions/${encodeURIComponent(receipt.requestId)}/result`,
      {
        method: 'PUT',
        idempotencyKey: receipt.resultKey,
        body: {
          installationId: state.installationId,
          version: receipt.version,
          status: receipt.status,
          ...(receipt.resultKind ? { resultKind: receipt.resultKind } : {}),
          ...(receipt.error ? { error: receipt.error } : {}),
        },
      },
    );
    if (response.status === 401) onUnauthorized();
    if (!response.ok) return false;
    state.outbox = state.outbox.filter((item) => item.requestId !== receipt.requestId);
    saveState(state);
    return true;
  }

  async function executeClaimed(state, receipt) {
    try {
      await stopEnvironment(receipt.envKey);
      const result = await deleteEnvironment(receipt.envKey);
      receipt.status = 'succeeded';
      receipt.resultKind = result && result.alreadyAbsent ? 'already_missing' : 'deleted';
      delete receipt.error;
    } catch (error) {
      receipt.status = 'failed';
      delete receipt.resultKind;
      receipt.error = cleanError(error);
      logger.warn(`[aidcp-edge] 环境删除失败 env=${receipt.envKey}: ${receipt.error}`);
    }
    receipt.phase = 'result_ready';
    saveState(state); // AdsPower 已有终态后先可靠落盘，再尝试 Cloud 回执。
    await submitResult(state, receipt);
  }

  async function runOnce() {
    if (running) return { ok: false, reason: 'already_running' };
    running = true;
    try {
      const state = loadState();
      for (const receipt of [...state.outbox]) {
        if (receipt.phase === 'result_ready') await submitResult(state, receipt);
      }
      const rosterByEnv = new Map((await listEnvironments()).map((environment) => ({
        envKey: String(environment.envKey || '').trim(),
        environmentName: String(environment.environmentName || '').trim() || null,
      })).filter((environment) => environment.envKey).map((environment) => [environment.envKey, environment]));
      // AdsPower 已删后本地花名册会先移除环境；durable outbox 仍是本 installation 的权威维护责任。
      // 把它继续带进观测，避免“Ads 已删、Cloud 回执前崩溃且超过新鲜窗”后永远无法恢复 claim。
      for (const receipt of state.outbox) {
        if (!receipt.envKey || rosterByEnv.has(receipt.envKey)) continue;
        rosterByEnv.set(receipt.envKey, { envKey: receipt.envKey, environmentName: receipt.environmentName || null });
      }
      const roster = [...rosterByEnv.values()];
      const poll = await clientFetch('/environment-maintenance/poll', {
        method: 'POST', body: { installationId: state.installationId, environments: roster },
      });
      if (poll.status === 401) onUnauthorized();
      if (!poll.ok || !poll.data || !Array.isArray(poll.data.deletions)) {
        return { ok: false, reason: 'poll_failed', status: poll.status };
      }
      for (const deletion of poll.data.deletions) {
        if (!deletion || !deletion.cleanupReady) continue;
        let receipt = state.outbox.find((item) => item.requestId === deletion.requestId);
        if (receipt && (!Number.isInteger(receipt.version) || receipt.version < 1)
          && Number.isInteger(deletion.version) && deletion.version >= 1) {
          receipt.version = deletion.version;
          saveState(state);
        }
        if (receipt && receipt.phase === 'claimed') {
          await executeClaimed(state, receipt);
          continue;
        }
        if (receipt && receipt.phase === 'result_ready') {
          await submitResult(state, receipt);
          continue;
        }
        if (receipt) continue;
        if (!Number.isInteger(deletion.version) || deletion.version < 1) {
          logger.warn('[aidcp-edge] 环境删除轮询结果缺少有效版本，已拒绝认领');
          continue;
        }
        const claim = await clientFetch(
          `/environment-maintenance/deletions/${encodeURIComponent(deletion.requestId)}/claim`,
          { method: 'POST', body: { installationId: state.installationId, version: deletion.version } },
        );
        if (claim.status === 401) onUnauthorized();
        if (!claim.ok || !claim.data || !claim.data.deletion) continue;
        const confirmed = claim.data.deletion;
        if (confirmed.requestId !== deletion.requestId || confirmed.envKey !== deletion.envKey
          || confirmed.version !== deletion.version) {
          logger.warn('[aidcp-edge] 环境删除认领响应目标不一致，已拒绝执行');
          continue;
        }
        receipt = {
          requestId: confirmed.requestId,
          version: confirmed.version,
          envKey: confirmed.envKey,
          environmentName: confirmed.environmentName || null,
          resultKey: randomUUID(),
          phase: 'claimed',
        };
        state.outbox.push(receipt);
        saveState(state); // 认领后、AdsPower 写前先持久化，崩溃可恢复。
        await executeClaimed(state, receipt);
      }
      return { ok: true, deletionCount: poll.data.deletions.length };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}

module.exports = { createEnvironmentMaintenance, createFileMaintenanceStateStore, cleanError };
