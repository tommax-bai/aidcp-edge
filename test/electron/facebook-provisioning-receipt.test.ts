import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  provisioningFacebookOperationPolicy,
  provisioningCommittedFacebookOperationPolicy,
  provisioningOperationModeMatches,
  provisioningPrimarySurfaceMatches,
} = require_('../../src/electron/facebook-provisioning-receipt.cjs');

type Mode = 'persona' | 'slow_start' | 'rule' | 'consumption';

function policyFor(mode: Mode, revision = 7) {
  return {
    primarySurface: 'reels',
    surfaceRevision: 1,
    baseMode: mode === 'slow_start' ? 'consumption' : mode,
    effectiveMode: null,
    policyRevision: revision,
    slowStart: { state: mode === 'slow_start' ? 'active' : 'off' },
    blocker: null,
  };
}

function projection(envKey: string, mode: Mode) {
  return {
    envKey,
    facebookOperationPolicy: policyFor(mode),
  };
}

function success(envKey: string, mode: Mode, idempotent = false) {
  return {
    ok: true,
    status: idempotent ? 200 : 201,
    data: {
      data: {
        environment: {
          envKey,
          label: 'FB',
          platform: 'facebook',
          source: 'admin',
          assignedAt: 1_700_000_000_000,
        },
        idempotent,
        facebookOperationPolicy: policyFor(mode),
      },
    },
  };
}

test('provisioning success accepts only the complete committed customer projection', () => {
  for (const mode of ['persona', 'slow_start', 'rule', 'consumption'] as const) {
    const policy = provisioningFacebookOperationPolicy(success('env-1', mode), 'env-1');
    assert.ok(policy);
    assert.equal(provisioningOperationModeMatches(policy, mode), true);
    assert.equal(provisioningPrimarySurfaceMatches(policy, 'reels'), true);
  }

  const incomplete: any = success('env-1', 'rule');
  delete incomplete.data.data.facebookOperationPolicy.effectiveMode;
  assert.equal(provisioningFacebookOperationPolicy(incomplete, 'env-1'), null);

  const unknownSlowStart: any = success('env-1', 'rule');
  unknownSlowStart.data.data.facebookOperationPolicy.slowStart.state = 'unknown';
  assert.equal(provisioningFacebookOperationPolicy(unknownSlowStart, 'env-1'), null);

  const zeroRevision: any = success('env-1', 'rule');
  zeroRevision.data.data.facebookOperationPolicy.policyRevision = 0;
  assert.equal(provisioningFacebookOperationPolicy(zeroRevision, 'env-1'), null);

  const wrongStatus: any = success('env-1', 'rule');
  wrongStatus.status = 200;
  assert.equal(provisioningFacebookOperationPolicy(wrongStatus, 'env-1'), null);
});

test('post-commit provisioning failures require the named status and exact current DTO', () => {
  for (const [reason, status] of [
    ['operation_policy_refresh_unavailable', 503],
    ['intent_operation_mode_mismatch', 409],
    ['intent_primary_surface_mismatch', 409],
  ] as const) {
    const current = provisioningCommittedFacebookOperationPolicy({
      ok: false,
      status,
      data: {
        error: reason,
        current: projection('env-1', 'consumption'),
      },
    }, 'env-1');
    assert.deepEqual(current, {
      reason,
      policy: policyFor('consumption'),
    });
  }

  assert.equal(provisioningCommittedFacebookOperationPolicy({
    ok: false,
    status: 503,
    data: {
      error: 'operation_policy_refresh_unavailable',
      current: {
        ...projection('env-1', 'rule'),
        unexpected: true,
      },
    },
  }, 'env-1'), null);

  assert.equal(provisioningCommittedFacebookOperationPolicy({
    ok: false,
    status: 409,
    data: {
      error: 'intent_operation_mode_mismatch',
      current: projection('other-env', 'rule'),
    },
  }, 'env-1'), null);
});

test('mode matching validates base, lifecycle and effective-mode consistency', () => {
  assert.equal(provisioningOperationModeMatches(policyFor('slow_start'), 'slow_start'), true);
  assert.equal(provisioningOperationModeMatches(policyFor('consumption'), 'consumption'), true);
  assert.equal(provisioningOperationModeMatches(policyFor('rule'), 'consumption'), false);

  // 旧版云端对 slow_start 写 persona 基线：混版期客户端仍须认为配置成功。
  const legacySlowStart: any = policyFor('slow_start');
  legacySlowStart.baseMode = 'persona';
  assert.equal(provisioningOperationModeMatches(legacySlowStart, 'slow_start'), true);

  const ruleBasedSlowStart: any = policyFor('slow_start');
  ruleBasedSlowStart.baseMode = 'rule';
  assert.equal(provisioningOperationModeMatches(ruleBasedSlowStart, 'slow_start'), false);

  const inconsistent: any = policyFor('rule');
  inconsistent.effectiveMode = 'consumption';
  assert.equal(provisioningOperationModeMatches(inconsistent, 'rule'), false);
});
