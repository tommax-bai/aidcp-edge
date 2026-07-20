import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEnvironmentMaintenance } = require('../../src/electron/environment-maintenance.cjs') as {
  createEnvironmentMaintenance(deps: Record<string, unknown>): { runOnce(): Promise<Record<string, unknown>> };
};

function memoryStore(initial: Record<string, unknown> = {}) {
  let state = { version: 1, installationId: '', outbox: [], ...initial };
  return {
    load: () => structuredClone(state),
    save: (next: typeof state) => { state = structuredClone(next); },
    view: () => structuredClone(state),
  };
}

test('environment maintenance pulls over HTTP, stops locally, deletes AdsPower, then receipts success', async () => {
  const store = memoryStore();
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const effects: string[] = [];
  const maintenance = createEnvironmentMaintenance({
    stateStore: store,
    randomUUID: (() => { let n = 0; return () => `stable-${++n}`; })(),
    listEnvironments: async () => [{ envKey: 'profile-1', environmentName: '运营环境一' }],
    stopEnvironment: async (envKey: string) => { effects.push(`stop:${envKey}`); },
    deleteEnvironment: async (envKey: string) => { effects.push(`delete:${envKey}`); },
    clientFetch: async (path: string, options: Record<string, unknown>) => {
      calls.push({ path, options });
      if (path.endsWith('/poll')) return { ok: true, status: 200, data: { deletions: [{
        requestId: 'request-1', version: 1, envKey: 'profile-1', cleanupReady: true,
      }] } };
      if (path.endsWith('/claim')) return { ok: true, status: 200, data: { deletion: {
        requestId: 'request-1', version: 1, envKey: 'profile-1', state: 'deleting',
      } } };
      effects.push('receipt');
      return { ok: true, status: 200, data: { deletion: { state: 'deleted' } } };
    },
    logger: { warn() {} },
  });

  assert.deepEqual(await maintenance.runOnce(), { ok: true, deletionCount: 1 });
  assert.deepEqual(effects, ['stop:profile-1', 'delete:profile-1', 'receipt']);
  assert.deepEqual(store.view().outbox, []);
  assert.deepEqual(calls.map((call) => call.path), [
    '/environment-maintenance/poll',
    '/environment-maintenance/deletions/request-1/claim',
    '/environment-maintenance/deletions/request-1/result',
  ]);
  const resultBody = calls[2]?.options.body as Record<string, unknown>;
  assert.equal(calls[2]?.options.method, 'PUT');
  assert.equal(calls[2]?.options.idempotencyKey, 'stable-2');
  assert.equal(resultBody.status, 'succeeded');
  assert.equal(resultBody.resultKind, 'deleted');
  assert.equal(resultBody.version, 1);
  assert.equal(resultBody.installationId, 'stable-1');
});

test('environment maintenance reports AdsPower failure honestly and does not fake deleted', async () => {
  const store = memoryStore({ installationId: 'installation-1' });
  const resultBodies: Array<Record<string, unknown>> = [];
  const maintenance = createEnvironmentMaintenance({
    stateStore: store,
    randomUUID: () => 'result-1',
    listEnvironments: async () => [{ envKey: 'profile-risk', environmentName: '风险环境' }],
    stopEnvironment: async () => undefined,
    deleteEnvironment: async () => { throw new Error('AdsPower code=-1'); },
    clientFetch: async (path: string, options: Record<string, unknown>) => {
      if (path.endsWith('/poll')) return { ok: true, status: 200, data: { deletions: [{
        requestId: 'request-risk', version: 1, envKey: 'profile-risk', cleanupReady: true,
      }] } };
      if (path.endsWith('/claim')) return { ok: true, status: 200, data: { deletion: {
        requestId: 'request-risk', version: 1, envKey: 'profile-risk', state: 'deleting',
      } } };
      resultBodies.push(options.body as Record<string, unknown>);
      return { ok: true, status: 200, data: { deletion: { state: 'delete_failed' } } };
    },
    logger: { warn() {} },
  });

  await maintenance.runOnce();
  assert.equal(resultBodies[0]?.status, 'failed');
  assert.match(String(resultBodies[0]?.error), /AdsPower code=-1/);
  assert.deepEqual(store.view().outbox, []);
});

test('environment maintenance receipts already_missing only when AdsPower verification proves absence', async () => {
  const store = memoryStore({ installationId: 'installation-1' });
  const resultBodies: Array<Record<string, unknown>> = [];
  const maintenance = createEnvironmentMaintenance({
    stateStore: store,
    randomUUID: () => 'result-absent',
    listEnvironments: async () => [{ envKey: 'profile-absent', environmentName: '已缺失环境' }],
    stopEnvironment: async () => undefined,
    deleteEnvironment: async () => ({ ok: true, alreadyAbsent: true }),
    clientFetch: async (path: string, options: Record<string, unknown>) => {
      if (path.endsWith('/poll')) return { ok: true, status: 200, data: { deletions: [{
        requestId: 'request-absent', version: 1, envKey: 'profile-absent', cleanupReady: true,
      }] } };
      if (path.endsWith('/claim')) return { ok: true, status: 200, data: { deletion: {
        requestId: 'request-absent', version: 1, envKey: 'profile-absent', state: 'deleting',
      } } };
      resultBodies.push(options.body as Record<string, unknown>);
      return { ok: true, status: 200, data: { deletion: { state: 'deleted' } } };
    },
    logger: { warn() {} },
  });
  await maintenance.runOnce();
  assert.equal(resultBodies[0]?.status, 'succeeded');
  assert.equal(resultBodies[0]?.resultKind, 'already_missing');
});

test('environment maintenance flushes durable result outbox before the next poll', async () => {
  const store = memoryStore({ installationId: 'installation-1', outbox: [{
    requestId: 'request-1', version: 1, envKey: 'profile-1', resultKey: 'result-1',
    phase: 'result_ready', status: 'succeeded', resultKind: 'already_missing',
  }] });
  const paths: string[] = [];
  const maintenance = createEnvironmentMaintenance({
    stateStore: store,
    listEnvironments: async () => [],
    stopEnvironment: async () => undefined,
    deleteEnvironment: async () => undefined,
    clientFetch: async (path: string) => {
      paths.push(path);
      if (path.endsWith('/result')) return { ok: true, status: 200, data: {} };
      return { ok: false, status: 503, data: null };
    },
    logger: { warn() {} },
  });
  await maintenance.runOnce();
  assert.equal(paths[0], '/environment-maintenance/deletions/request-1/result');
  assert.deepEqual(store.view().outbox, []);
});

test('claimed outbox keeps the deleted local env in poll roster so restart recovery cannot lose responsibility', async () => {
  const store = memoryStore({ installationId: 'installation-1', outbox: [{
    requestId: 'request-1', version: 1, envKey: 'profile-removed', environmentName: '已移除环境',
    resultKey: 'result-1', phase: 'claimed',
  }] });
  let pollBody: Record<string, unknown> | undefined;
  let deleteCalls = 0;
  const maintenance = createEnvironmentMaintenance({
    stateStore: store,
    listEnvironments: async () => [],
    stopEnvironment: async () => undefined,
    deleteEnvironment: async () => { deleteCalls += 1; return { ok: true, alreadyAbsent: true }; },
    clientFetch: async (path: string, options: Record<string, unknown>) => {
      if (path.endsWith('/poll')) {
        pollBody = options.body as Record<string, unknown>;
        return { ok: true, status: 200, data: { deletions: [{
          requestId: 'request-1', version: 1, envKey: 'profile-removed', cleanupReady: true,
        }] } };
      }
      return { ok: true, status: 200, data: { deletion: { state: 'deleted' } } };
    },
    logger: { warn() {} },
  });
  await maintenance.runOnce();
  assert.deepEqual(pollBody?.environments, [{ envKey: 'profile-removed', environmentName: '已移除环境' }]);
  assert.equal(deleteCalls, 1);
  assert.deepEqual(store.view().outbox, []);
});
