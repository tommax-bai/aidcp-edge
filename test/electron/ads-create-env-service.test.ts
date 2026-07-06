import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const service = require('../../src/electron/ads-create-env-service.cjs') as {
  ENV_GROUP_NAME: string;
  createEnvGroupResolver: (deps: {
    adsApi: { listGroups: () => Promise<{ ok: boolean; groups?: Array<{ groupId: string; groupName: string }> }> };
    groupName?: string;
  }) => {
    ensureEnvGroup: (
      writeApi: { createGroup: (name: string) => Promise<{ ok: boolean; groupId?: string; error?: string }> },
      adsOpts?: unknown,
      opts?: { skipGroupIds?: string[] },
    ) => Promise<{ ok: boolean; groupId?: string; error?: string }>;
    clearEnvGroupCache: () => void;
    getCachedEnvGroupId: () => string | null;
  };
  createEnvironmentWithGroupRecovery: (deps: Record<string, unknown>) => Promise<{ ok: boolean; userId?: string; error?: string }>;
  isDeletedOrArchivedGroupError: (error: unknown) => boolean;
};

const { ENV_GROUP_NAME, createEnvGroupResolver, createEnvironmentWithGroupRecovery, isDeletedOrArchivedGroupError } = service;

function flowFactory(results: Array<{ ok: boolean; userId?: string; error?: string }>, groupIds: string[]) {
  return () => ({
    createEnvironment: async ({ groupId }: { groupId: string }) => {
      groupIds.push(groupId);
      return results.shift() || { ok: false, error: 'unexpected extra attempt' };
    },
  });
}

test('isDeletedOrArchivedGroupError only matches group deleted/archived failures', () => {
  assert.equal(isDeletedOrArchivedGroupError('group is deleted or archived'), true);
  assert.equal(isDeletedOrArchivedGroupError('Group has been Archived'), true);
  assert.equal(isDeletedOrArchivedGroupError('quota exceeded'), false);
  assert.equal(isDeletedOrArchivedGroupError('profile is archived'), false);
});

test('createEnvironmentWithGroupRecovery clears stale group cache and retries once with a newly resolved group', async () => {
  let listCalls = 0;
  const adsApi = {
    listGroups: async () => {
      listCalls += 1;
      if (listCalls === 1) return { ok: true, groups: [{ groupId: 'old', groupName: ENV_GROUP_NAME }] };
      return {
        ok: true,
        groups: [
          { groupId: 'old', groupName: ENV_GROUP_NAME },
          { groupId: 'new', groupName: ENV_GROUP_NAME },
        ],
      };
    },
  };
  const writeApi = {
    createGroup: async () => ({ ok: true, groupId: 'created' }),
  };
  const resolver = createEnvGroupResolver({ adsApi });
  const groupIds: string[] = [];

  const result = await createEnvironmentWithGroupRecovery({
    writeApi,
    adsApi,
    fingerprint: {},
    templateKey: 'win11-intel',
    machineLabel: 'mac-01',
    groupResolver: resolver,
    createFlowFactory: flowFactory(
      [
        { ok: false, error: 'group is deleted or archived' },
        { ok: true, userId: 'u-new' },
      ],
      groupIds,
    ),
  });

  assert.deepEqual(groupIds, ['old', 'new']);
  assert.equal(result.ok, true);
  assert.equal(result.userId, 'u-new');
  assert.equal(resolver.getCachedEnvGroupId(), 'new');
});

test('createEnvironmentWithGroupRecovery creates a dedicated group when no usable group exists after recovery', async () => {
  let listCalls = 0;
  const adsApi = {
    listGroups: async () => {
      listCalls += 1;
      if (listCalls === 1) return { ok: true, groups: [{ groupId: 'old', groupName: ENV_GROUP_NAME }] };
      return { ok: true, groups: [{ groupId: 'old', groupName: ENV_GROUP_NAME }] };
    },
  };
  const createdNames: string[] = [];
  const writeApi = {
    createGroup: async (name: string) => {
      createdNames.push(name);
      return { ok: true, groupId: 'created' };
    },
  };
  const groupIds: string[] = [];

  const result = await createEnvironmentWithGroupRecovery({
    writeApi,
    adsApi,
    fingerprint: {},
    templateKey: 'win11-intel',
    machineLabel: 'mac-01',
    groupResolver: createEnvGroupResolver({ adsApi }),
    createFlowFactory: flowFactory(
      [
        { ok: false, error: 'group is deleted or archived' },
        { ok: true, userId: 'u-created' },
      ],
      groupIds,
    ),
  });

  assert.deepEqual(groupIds, ['old', 'created']);
  assert.deepEqual(createdNames, [ENV_GROUP_NAME]);
  assert.equal(result.ok, true);
  assert.equal(result.userId, 'u-created');
});

test('createEnvironmentWithGroupRecovery does not retry unrelated create failures', async () => {
  let listCalls = 0;
  const adsApi = {
    listGroups: async () => {
      listCalls += 1;
      return { ok: true, groups: [{ groupId: 'g1', groupName: ENV_GROUP_NAME }] };
    },
  };
  const groupIds: string[] = [];

  const result = await createEnvironmentWithGroupRecovery({
    writeApi: { createGroup: async () => ({ ok: true, groupId: 'created' }) },
    adsApi,
    fingerprint: {},
    templateKey: 'win11-intel',
    machineLabel: 'mac-01',
    groupResolver: createEnvGroupResolver({ adsApi }),
    createFlowFactory: flowFactory([{ ok: false, error: 'quota exceeded' }], groupIds),
  });

  assert.deepEqual(groupIds, ['g1']);
  assert.equal(listCalls, 1);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /quota exceeded/);
});
