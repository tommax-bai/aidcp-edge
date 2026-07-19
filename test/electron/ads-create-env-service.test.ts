import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const service = require('../../src/electron/ads-create-env-service.cjs') as {
  ENV_GROUP_NAME: string;
  createEnvGroupResolver: (deps: {
    adsApi: {
      listGroups: (opts?: unknown) => Promise<{
        ok: boolean;
        groups?: Array<{ groupId: string; groupName: string }>;
        error?: string;
      }>;
    };
    groupName?: string;
  }) => {
    ensureEnvGroup: (
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

test('ENV_GROUP_NAME is the operator-provisioned aidcp group', () => {
  assert.equal(ENV_GROUP_NAME, 'aidcp');
});

test('isDeletedOrArchivedGroupError only matches group deleted/archived failures', () => {
  assert.equal(isDeletedOrArchivedGroupError('group is deleted or archived'), true);
  assert.equal(isDeletedOrArchivedGroupError('Group has been Archived'), true);
  assert.equal(isDeletedOrArchivedGroupError('quota exceeded'), false);
  assert.equal(isDeletedOrArchivedGroupError('profile is archived'), false);
});

test('createEnvironmentWithGroupRecovery assigns every supported platform to the pre-provisioned aidcp group', async () => {
  let listCalls = 0;
  const adsApi = {
    listGroups: async () => {
      listCalls += 1;
      return { ok: true, groups: [{ groupId: 'g-aidcp', groupName: ENV_GROUP_NAME }] };
    },
  };
  const resolver = createEnvGroupResolver({ adsApi });
  const captured: Array<Record<string, unknown>> = [];

  for (const platform of ['xiaohongshu', 'facebook', 'wechat_channels']) {
    const result = await createEnvironmentWithGroupRecovery({
      writeApi: {},
      adsApi,
      fingerprint: {},
      osFamilyKey: 'windows',
      machineLabel: 'mac-01',
      platform,
      groupResolver: resolver,
      createFlowFactory: () => ({
        createEnvironment: async (arg: Record<string, unknown>) => {
          captured.push(arg);
          return { ok: true, userId: `u-${platform}` };
        },
      }),
    });
    assert.equal(result.ok, true);
  }

  assert.equal(listCalls, 1, 'resolved group id is cached across platform-neutral creates');
  assert.deepEqual(captured.map((arg) => arg.groupId), ['g-aidcp', 'g-aidcp', 'g-aidcp']);
  assert.deepEqual(captured.map((arg) => arg.platform), ['xiaohongshu', 'facebook', 'wechat_channels']);
});

test('createEnvGroupResolver preserves a group/list failure and does not invent a group', async () => {
  let listedOpts: Record<string, unknown> | undefined;
  const resolver = createEnvGroupResolver({
    adsApi: {
      listGroups: async (opts) => {
        listedOpts = opts as Record<string, unknown>;
        return { ok: false, error: '拉取分组失败：无权限' };
      },
    },
  });

  const result = await resolver.ensureEnvGroup({ apiBase: 'http://local.adspower.net:50325' });

  assert.deepEqual(result, { ok: false, error: '拉取分组失败：无权限' });
  assert.equal(listedOpts?.groupName, 'aidcp');
  assert.equal(listedOpts?.apiBase, 'http://local.adspower.net:50325');
  assert.equal(resolver.getCachedEnvGroupId(), null);
});

test('createEnvironmentWithGroupRecovery stops before user/create when the pre-provisioned group is missing', async () => {
  let flowCalls = 0;
  const adsApi = {
    listGroups: async () => ({ ok: true, groups: [{ groupId: 'other', groupName: '其他分组' }] }),
  };

  const result = await createEnvironmentWithGroupRecovery({
    writeApi: {},
    adsApi,
    fingerprint: {},
    groupResolver: createEnvGroupResolver({ adsApi }),
    createFlowFactory: () => ({
      createEnvironment: async () => {
        flowCalls += 1;
        return { ok: true, userId: 'unexpected' };
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.match(String(result.error), /预置 AdsPower 分组“aidcp”/);
  assert.match(String(result.error), /API Key 与分组权限/);
  assert.equal(flowCalls, 0);
});

test('createEnvironmentWithGroupRecovery clears a stale cache and retries once with a newly resolved aidcp group', async () => {
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
  const resolver = createEnvGroupResolver({ adsApi });
  const groupIds: string[] = [];

  const result = await createEnvironmentWithGroupRecovery({
    writeApi: {},
    adsApi,
    fingerprint: {},
    osFamilyKey: 'windows',
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

test('createEnvironmentWithGroupRecovery does not create or retry when no replacement aidcp group is visible', async () => {
  let listCalls = 0;
  const adsApi = {
    listGroups: async () => {
      listCalls += 1;
      return { ok: true, groups: [{ groupId: 'old', groupName: ENV_GROUP_NAME }] };
    },
  };
  const groupIds: string[] = [];

  const result = await createEnvironmentWithGroupRecovery({
    writeApi: {},
    adsApi,
    fingerprint: {},
    osFamilyKey: 'windows',
    machineLabel: 'mac-01',
    groupResolver: createEnvGroupResolver({ adsApi }),
    createFlowFactory: flowFactory([{ ok: false, error: 'group is deleted or archived' }], groupIds),
  });

  assert.deepEqual(groupIds, ['old']);
  assert.equal(listCalls, 2);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /预置 AdsPower 分组“aidcp”/);
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
    writeApi: {},
    adsApi,
    fingerprint: {},
    osFamilyKey: 'windows',
    machineLabel: 'mac-01',
    groupResolver: createEnvGroupResolver({ adsApi }),
    createFlowFactory: flowFactory([{ ok: false, error: 'quota exceeded' }], groupIds),
  });

  assert.deepEqual(groupIds, ['g1']);
  assert.equal(listCalls, 1);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /quota exceeded/);
});

test('createEnvironmentWithGroupRecovery passes import payload into create flow', async () => {
  let captured: Record<string, unknown> | undefined;
  const adsApi = {
    listGroups: async () => ({ ok: true, groups: [{ groupId: 'g1', groupName: ENV_GROUP_NAME }] }),
  };
  const accountImport = { username: 'a@example.com', cookie: 'cookie-json' };
  const result = await createEnvironmentWithGroupRecovery({
    writeApi: {},
    adsApi,
    fingerprint: {},
    osFamilyKey: 'windows',
    machineLabel: 'mac-01',
    platform: 'facebook',
    name: 'Facebook import 1',
    accountImport,
    groupResolver: createEnvGroupResolver({ adsApi }),
    createFlowFactory: () => ({
      createEnvironment: async (arg: Record<string, unknown>) => {
        captured = arg;
        return { ok: true, userId: 'u-fb' };
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(captured?.name, 'Facebook import 1');
  assert.deepEqual(captured?.accountImport, accountImport);
  assert.equal(captured?.platform, 'facebook');
});
