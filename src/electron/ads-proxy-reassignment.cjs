const { parseProxyLines } = require('./ads-proxy-config.cjs');

const NO_PROXY_INPUT = Object.freeze({ proxyType: 'no_proxy' });

function normalizeTargetIds(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { ok: false, error: '请至少选择一个环境' };
  }
  const normalized = userIds.map((value) => String(value || '').trim());
  if (normalized.some((value) => !value)) {
    return { ok: false, error: '批量目标包含无效环境 ID' };
  }
  if (new Set(normalized).size !== normalized.length) {
    return { ok: false, error: '批量目标包含重复环境' };
  }
  return { ok: true, userIds: normalized };
}

function createProxyReassignmentPlan({ userIds, proxyType, proxyText } = {}) {
  const targets = normalizeTargetIds(userIds);
  if (!targets.ok) return targets;
  const parsed = parseProxyLines({ proxyType, proxyText });
  if (!parsed.ok) return parsed;
  const plan = targets.userIds.map((userId, index) => ({
    userId,
    targetIndex: index + 1,
    proxy: parsed.noProxy
      ? { ...NO_PROXY_INPUT }
      : { ...parsed.proxies[index % parsed.proxies.length] },
  }));
  return {
    ok: true,
    plan,
    targetCount: plan.length,
    proxyCount: parsed.proxies.length,
    noProxy: parsed.noProxy,
  };
}

function proxyReassignmentFailure(updatedUserIds, failedIndex, reason, totalCount) {
  const updated = Array.isArray(updatedUserIds) ? updatedUserIds.map(String) : [];
  const index = Math.max(1, Number(failedIndex) || 1);
  const total = Math.max(index, Number(totalCount) || index);
  return {
    ok: false,
    error: `第 ${index} 个环境修改失败：${reason || '未知错误'}`,
    updatedUserIds: updated,
    updatedCount: updated.length,
    failedIndex: index,
    notAttemptedCount: Math.max(0, total - index),
    partial: updated.length > 0,
  };
}

function validateProxyTargetScope({ userIds, authEnabled, sessionValid, allowedProfileIds } = {}) {
  const targets = normalizeTargetIds(userIds);
  if (!targets.ok) return targets;
  if (!authEnabled) return targets;
  if (!sessionValid || !(allowedProfileIds instanceof Set)) {
    return { ok: false, error: '登录已失效，请重新登录客户端。' };
  }
  if (targets.userIds.some((userId) => !allowedProfileIds.has(userId))) {
    return { ok: false, error: '所选环境不属于当前账号或已失去访问权限。' };
  }
  return targets;
}

async function executeProxyReassignmentPlan({ plan, isActive, updateOne } = {}) {
  if (!Array.isArray(plan) || plan.length === 0 || typeof updateOne !== 'function') {
    return { ok: false, error: '批量代理计划不合法' };
  }
  const activeCheck = typeof isActive === 'function' ? isActive : () => false;
  const updatedUserIds = [];
  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index];
    if (activeCheck(item.userId)) {
      return proxyReassignmentFailure(
        updatedUserIds, index + 1, '该环境正在使用中；请先关闭后重试。', plan.length,
      );
    }
    let result;
    try {
      result = await updateOne(item, index);
    } catch {
      result = { ok: false, error: '代理更新遇到内部错误' };
    }
    if (!result || !result.ok) {
      return proxyReassignmentFailure(
        updatedUserIds, index + 1, (result && result.error) || 'AdsPower 未接受代理更新', plan.length,
      );
    }
    updatedUserIds.push(item.userId);
  }
  return { ok: true, updatedUserIds, updatedCount: updatedUserIds.length };
}

module.exports = {
  normalizeTargetIds,
  createProxyReassignmentPlan,
  proxyReassignmentFailure,
  validateProxyTargetScope,
  executeProxyReassignmentPlan,
};
