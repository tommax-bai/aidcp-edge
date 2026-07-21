import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeTargetIds,
  createProxyReassignmentPlan,
  proxyReassignmentFailure,
  validateProxyTargetScope,
  executeProxyReassignmentPlan,
} = require('../../src/electron/ads-proxy-reassignment.cjs') as {
  normalizeTargetIds: (ids: unknown) => { ok: boolean; userIds?: string[]; error?: string };
  createProxyReassignmentPlan: (input: Record<string, unknown>) => {
    ok: boolean;
    plan?: Array<{ userId: string; targetIndex: number; proxy: Record<string, string> }>;
    proxyCount?: number;
    targetCount?: number;
    error?: string;
  };
  proxyReassignmentFailure: (updated: string[], failedIndex: number, reason: string, total: number) => {
    ok: boolean;
    updatedCount: number;
    updatedUserIds: string[];
    failedIndex: number;
    notAttemptedCount: number;
    partial: boolean;
    error: string;
  };
  validateProxyTargetScope: (input: Record<string, unknown>) => { ok: boolean; userIds?: string[]; error?: string };
  executeProxyReassignmentPlan: (input: Record<string, unknown>) => Promise<{
    ok: boolean;
    updatedCount?: number;
    updatedUserIds?: string[];
    failedIndex?: number;
    notAttemptedCount?: number;
    partial?: boolean;
    error?: string;
  }>;
};

test('normalizeTargetIds: 空、空 ID 与重复目标在计划前拒绝', () => {
  for (const input of [[], ['a', ''], ['a', 'a']]) {
    const result = normalizeTargetIds(input);
    assert.equal(result.ok, false);
  }
});

test('createProxyReassignmentPlan: 五个明确目标按 A/B/A/B/A 轮询', () => {
  const result = createProxyReassignmentPlan({
    userIds: ['u1', 'u2', 'u3', 'u4', 'u5'],
    proxyType: 'http',
    proxyText: 'proxy-a:8001\nproxy-b:8002',
  });
  assert.equal(result.ok, true);
  assert.equal(result.targetCount, 5);
  assert.equal(result.proxyCount, 2);
  assert.deepEqual(result.plan?.map((item) => item.userId), ['u1', 'u2', 'u3', 'u4', 'u5']);
  assert.deepEqual(result.plan?.map((item) => item.proxy.proxyHost), [
    'proxy-a', 'proxy-b', 'proxy-a', 'proxy-b', 'proxy-a',
  ]);
});

test('createProxyReassignmentPlan: 后置坏代理不会产出部分计划且不泄密', () => {
  const result = createProxyReassignmentPlan({
    userIds: ['u1', 'u2'],
    proxyType: 'https',
    proxyText: 'ok.example:443\nbad.example:70000:secret-user:secret-pass',
  });
  assert.equal(result.ok, false);
  assert.equal(result.plan, undefined);
  assert.match(String(result.error), /第 2 条代理.*端口/);
  assert.doesNotMatch(String(result.error), /bad\.example|secret-user|secret-pass/);
});

test('createProxyReassignmentPlan: 显式无代理为每个目标生成独立清除计划', () => {
  const result = createProxyReassignmentPlan({
    userIds: ['u1', 'u2'],
    proxyType: 'no_proxy',
    proxyText: '',
  });
  assert.equal(result.ok, true);
  assert.equal(result.proxyCount, 0);
  assert.deepEqual(result.plan?.map((item) => item.proxy), [
    { proxyType: 'no_proxy' },
    { proxyType: 'no_proxy' },
  ]);
  assert.notEqual(result.plan?.[0].proxy, result.plan?.[1].proxy);
});

test('proxyReassignmentFailure: 保留成功、失败与未执行真相', () => {
  const result = proxyReassignmentFailure(['u1', 'u2'], 3, '环境正在使用中', 5);
  assert.equal(result.ok, false);
  assert.equal(result.updatedCount, 2);
  assert.deepEqual(result.updatedUserIds, ['u1', 'u2']);
  assert.equal(result.failedIndex, 3);
  assert.equal(result.notAttemptedCount, 2);
  assert.equal(result.partial, true);
  assert.match(result.error, /第 3 个环境.*正在使用/);
});

test('validateProxyTargetScope: 过期会话不复用旧范围，外部目标整批拒绝', () => {
  const stale = validateProxyTargetScope({
    userIds: ['u1'], authEnabled: true, sessionValid: false, allowedProfileIds: new Set(['u1']),
  });
  assert.equal(stale.ok, false);
  assert.match(String(stale.error), /登录已失效/);

  const foreign = validateProxyTargetScope({
    userIds: ['u1', 'foreign'], authEnabled: true, sessionValid: true, allowedProfileIds: new Set(['u1']),
  });
  assert.equal(foreign.ok, false);
  assert.match(String(foreign.error), /不属于当前账号/);

  const local = validateProxyTargetScope({
    userIds: ['u1', 'foreign'], authEnabled: false, sessionValid: false, allowedProfileIds: null,
  });
  assert.deepEqual(local, { ok: true, userIds: ['u1', 'foreign'] });
});

test('executeProxyReassignmentPlan: 串行到首个失败即停止并返回真实部分回执', async () => {
  const calls: string[] = [];
  const progress: Array<{ completedCount: number; totalCount: number }> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const result = await executeProxyReassignmentPlan({
    plan: ['u1', 'u2', 'u3', 'u4'].map((userId) => ({ userId, proxy: { proxyType: 'http' } })),
    isActive: () => false,
    updateOne: async (item: { userId: string }) => {
      calls.push(item.userId);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return item.userId === 'u3' ? { ok: false, error: 'AdsPower 拒绝' } : { ok: true };
    },
    onProgress: (value: { completedCount: number; totalCount: number }) => progress.push(value),
  });
  assert.deepEqual(calls, ['u1', 'u2', 'u3']);
  assert.equal(maxConcurrent, 1);
  assert.equal(result.updatedCount, 2);
  assert.equal(result.failedIndex, 3);
  assert.equal(result.notAttemptedCount, 1);
  assert.equal(result.partial, true);
  assert.deepEqual(progress, [
    { completedCount: 1, totalCount: 4 },
    { completedCount: 2, totalCount: 4 },
  ], '只在逐项写入明确成功后推进，失败项不得提前计数');
});

test('executeProxyReassignmentPlan: 进度观察异常不改写已经成功的代理结果', async () => {
  const result = await executeProxyReassignmentPlan({
    plan: [{ userId: 'u1', proxy: { proxyType: 'http' } }],
    updateOne: async () => ({ ok: true }),
    onProgress: () => { throw new Error('renderer closed'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.updatedCount, 1);
});

test('executeProxyReassignmentPlan: 后置目标变为运行时不写它及后续项', async () => {
  const calls: string[] = [];
  const result = await executeProxyReassignmentPlan({
    plan: ['u1', 'u2', 'u3'].map((userId) => ({ userId, proxy: { proxyType: 'http' } })),
    isActive: (userId: string) => userId === 'u2',
    updateOne: async (item: { userId: string }) => { calls.push(item.userId); return { ok: true }; },
  });
  assert.deepEqual(calls, ['u1']);
  assert.equal(result.updatedCount, 1);
  assert.equal(result.failedIndex, 2);
  assert.equal(result.notAttemptedCount, 1);
});
