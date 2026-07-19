const { createCreateFlow } = require('./ads-create-flow.cjs');

const ENV_GROUP_NAME = 'aidcp';

function isDeletedOrArchivedGroupError(error) {
  const s = String(error || '').toLowerCase();
  return s.includes('group') && (s.includes('deleted') || s.includes('archived'));
}

function createEnvGroupResolver({ adsApi, groupName = ENV_GROUP_NAME } = {}) {
  if (!adsApi || typeof adsApi.listGroups !== 'function') {
    throw new Error('createEnvGroupResolver requires adsApi.listGroups');
  }

  let cachedEnvGroupId = null;

  function clearEnvGroupCache() {
    cachedEnvGroupId = null;
  }

  function getCachedEnvGroupId() {
    return cachedEnvGroupId;
  }

  function pickGroupId(result, skipGroupIds) {
    if (!result || !result.ok || !Array.isArray(result.groups)) return '';
    const skip = new Set((skipGroupIds || []).filter(Boolean).map(String));
    const picked = result.groups.find((g) => g && g.groupName === groupName && g.groupId && !skip.has(String(g.groupId)));
    return picked ? String(picked.groupId) : '';
  }

  async function ensureEnvGroup(adsOpts, opts = {}) {
    const skipGroupIds = (opts.skipGroupIds || []).filter(Boolean).map(String);
    if (cachedEnvGroupId && !skipGroupIds.includes(String(cachedEnvGroupId))) {
      return { ok: true, groupId: cachedEnvGroupId };
    }
    if (cachedEnvGroupId && skipGroupIds.includes(String(cachedEnvGroupId))) clearEnvGroupCache();

    const listed = await adsApi.listGroups({ ...(adsOpts || {}), groupName });
    if (!listed || !listed.ok) {
      return { ok: false, error: (listed && listed.error) || `无法读取预置 AdsPower 分组“${groupName}”` };
    }
    const gid = pickGroupId(listed, skipGroupIds);
    if (!gid) {
      return {
        ok: false,
        error: `当前 AIDCP 指纹运行时已就绪，但其账号或权限范围内未找到预置 AdsPower 分组“${groupName}”；请确认该分组建立在当前运行时使用的 AdsPower 账号中`,
      };
    }
    cachedEnvGroupId = gid;
    return { ok: true, groupId: gid };
  }

  return { ensureEnvGroup, clearEnvGroupCache, getCachedEnvGroupId };
}

async function createEnvironmentWithGroupRecovery({
  writeApi,
  adsApi,
  fingerprint,
  adsOpts,
  osFamilyKey,
  templateKey,
  intendedAccountLabel,
  machineLabel,
  platform,
  name,
  accountImport,
  proxy,
  groupResolver,
  createFlowFactory = createCreateFlow,
} = {}) {
  const resolver = groupResolver || createEnvGroupResolver({ adsApi });

  async function attempt(skipGroupIds = []) {
    const grp = await resolver.ensureEnvGroup(adsOpts, { skipGroupIds });
    if (!grp.ok) return { result: { ok: false, error: grp.error }, groupId: '' };

    const flow = createFlowFactory({ writeApi, fingerprint });
    const result = await flow.createEnvironment({
      osFamilyKey,
      templateKey,
      intendedAccountLabel,
      machineLabel,
      platform,
      name,
      accountImport,
      proxy,
      groupId: grp.groupId,
    });
    return { result, groupId: grp.groupId };
  }

  const first = await attempt();
  if (!first.result.ok && isDeletedOrArchivedGroupError(first.result.error)) {
    resolver.clearEnvGroupCache();
    const second = await attempt(first.groupId ? [first.groupId] : []);
    return second.result;
  }
  return first.result;
}

module.exports = {
  ENV_GROUP_NAME,
  createEnvGroupResolver,
  createEnvironmentWithGroupRecovery,
  isDeletedOrArchivedGroupError,
};
