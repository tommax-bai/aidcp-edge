'use strict';

const FACEBOOK_OPERATION_MODES = new Set([
  'persona',
  'slow_start',
  'rule',
  'consumption',
]);
const FACEBOOK_BASE_MODES = new Set(['persona', 'rule', 'consumption']);
const FACEBOOK_EFFECTIVE_MODES = new Set([
  'persona',
  'slow_start',
  'rule',
  'consumption',
  'blocked',
]);
const COMMITTED_FAILURE_STATUS = Object.freeze({
  operation_policy_refresh_unavailable: 503,
  intent_operation_mode_mismatch: 409,
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function normalizeProvisioningPolicy(policy) {
  if (
    !hasExactKeys(policy, [
      'baseMode',
      'effectiveMode',
      'policyRevision',
      'slowStart',
      'blocker',
    ])
    || !FACEBOOK_BASE_MODES.has(policy.baseMode)
    || (
      policy.effectiveMode !== null
      && !FACEBOOK_EFFECTIVE_MODES.has(policy.effectiveMode)
    )
    || !Number.isSafeInteger(policy.policyRevision)
    || policy.policyRevision < 1
    || !hasExactKeys(policy.slowStart, ['state'])
    || (policy.slowStart.state !== 'active' && policy.slowStart.state !== 'off')
    || (policy.blocker !== null && typeof policy.blocker !== 'string')
  ) {
    return null;
  }
  return {
    baseMode: policy.baseMode,
    effectiveMode: policy.effectiveMode,
    policyRevision: policy.policyRevision,
    slowStart: { state: policy.slowStart.state },
    blocker: policy.blocker,
  };
}

function normalizeProvisioningProjection(projection, expectedEnvKey) {
  if (
    !hasExactKeys(projection, ['envKey', 'facebookOperationPolicy'])
    || projection.envKey !== expectedEnvKey
  ) {
    return null;
  }
  return normalizeProvisioningPolicy(projection.facebookOperationPolicy);
}

function validProvisionedEnvironment(environment, expectedEnvKey) {
  return hasExactKeys(environment, ['envKey', 'label', 'platform', 'source', 'assignedAt'])
    && environment.envKey === expectedEnvKey
    && (environment.label === null || typeof environment.label === 'string')
    && environment.platform === 'facebook'
    && environment.source === 'admin'
    && Number.isSafeInteger(environment.assignedAt)
    && environment.assignedAt > 0;
}

function provisioningFacebookOperationPolicy(response, expectedEnvKey) {
  const payload = response && response.ok === true && response.data && response.data.data;
  if (
    !hasExactKeys(payload, ['environment', 'idempotent', 'facebookOperationPolicy'])
    || typeof payload.idempotent !== 'boolean'
    || response.status !== (payload.idempotent ? 200 : 201)
    || !validProvisionedEnvironment(payload.environment, expectedEnvKey)
  ) {
    return null;
  }
  return normalizeProvisioningProjection({
    envKey: payload.environment.envKey,
    facebookOperationPolicy: payload.facebookOperationPolicy,
  }, expectedEnvKey);
}

function provisioningCommittedFacebookOperationPolicy(response, expectedEnvKey) {
  const error = response && response.ok === false && response.data && response.data.error;
  const expectedStatus = COMMITTED_FAILURE_STATUS[error];
  if (
    expectedStatus === undefined
    || response.status !== expectedStatus
    || !hasExactKeys(response.data, ['error', 'current'])
  ) {
    return null;
  }
  const policy = normalizeProvisioningProjection(response.data.current, expectedEnvKey);
  return policy ? { reason: error, policy } : null;
}

function provisioningOperationModeMatches(policy, requestedMode) {
  if (!policy || !FACEBOOK_OPERATION_MODES.has(requestedMode)) return false;
  if (requestedMode === 'slow_start') {
    return policy.baseMode === 'persona'
      && policy.slowStart.state === 'active'
      && (
        policy.effectiveMode === null
        || policy.effectiveMode === 'slow_start'
        || policy.effectiveMode === 'blocked'
      );
  }
  return policy.slowStart.state === 'off'
    && policy.baseMode === requestedMode
    && (
      policy.effectiveMode === null
      || policy.effectiveMode === requestedMode
      || policy.effectiveMode === 'blocked'
    );
}

module.exports = {
  FACEBOOK_OPERATION_MODES,
  provisioningFacebookOperationPolicy,
  provisioningCommittedFacebookOperationPolicy,
  provisioningOperationModeMatches,
};
