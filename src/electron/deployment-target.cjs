'use strict';

const DEPLOYMENT_TARGET_CATALOG = Object.freeze({
  dev: Object.freeze({
    key: 'dev',
    label: 'DEV（测试）',
    customerAuthBaseUrl: 'http://121.89.85.150:8088/capi',
    automationWebSocketUrl: 'ws://121.89.85.150:8787',
  }),
  ol: Object.freeze({
    key: 'ol',
    label: 'OL（正式）',
    customerAuthBaseUrl: 'https://aidcp.tommax.cc/capi',
    automationWebSocketUrl: 'ws://123.56.253.183:8787',
  }),
});

function isDeploymentTarget(value) {
  return value === 'dev' || value === 'ol';
}

function migrateDeploymentTarget({ deploymentTarget, legacyCloudEnvKey, bakedDefault } = {}) {
  if (isDeploymentTarget(deploymentTarget)) return deploymentTarget;
  if (isDeploymentTarget(legacyCloudEnvKey)) return legacyCloudEnvKey;
  if (isDeploymentTarget(bakedDefault)) return bakedDefault;
  return 'dev';
}

function deploymentTargetConfig(value) {
  if (!isDeploymentTarget(value)) return null;
  return DEPLOYMENT_TARGET_CATALOG[value];
}

function deploymentTargetView(value) {
  const target = deploymentTargetConfig(value);
  if (!target) return null;
  return {
    key: target.key,
    label: target.label,
    automationUrl: target.automationWebSocketUrl,
    dataApiUrl: target.customerAuthBaseUrl,
  };
}

function targetForKnownCustomerAuthUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  for (const target of Object.values(DEPLOYMENT_TARGET_CATALOG)) {
    if (target.customerAuthBaseUrl === url) return target.key;
  }
  return null;
}

module.exports = {
  DEPLOYMENT_TARGET_CATALOG,
  isDeploymentTarget,
  migrateDeploymentTarget,
  deploymentTargetConfig,
  deploymentTargetView,
  targetForKnownCustomerAuthUrl,
};
