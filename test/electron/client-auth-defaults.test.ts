import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const target = require('../../src/electron/deployment-target.cjs') as {
  DEPLOYMENT_TARGET_CATALOG: Record<string, {
    key: string;
    label: string;
    customerAuthBaseUrl: string;
    automationWebSocketUrl: string;
  }>;
  isDeploymentTarget: (value: unknown) => boolean;
  migrateDeploymentTarget: (input?: Record<string, unknown>) => string;
  deploymentTargetConfig: (value: unknown) => Record<string, string> | null;
  deploymentTargetView: (value: unknown) => Record<string, string> | null;
  targetForKnownCustomerAuthUrl: (value: unknown) => string | null;
};
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const main = readFileSync(join(root, 'src/electron/main.cjs'), 'utf8');
const buildScript = readFileSync(join(root, 'scripts/build-desktop-macos.sh'), 'utf8');
const localOlBuild = readFileSync(join(root, 'scripts/build-desktop-macos-ol-arm64-common.sh'), 'utf8');
const buildWorkflow = readFileSync(join(root, '.github/workflows/build-desktop.yml'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');

function blockBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `missing block ${startNeedle} -> ${endNeedle}`);
  return source.slice(start, end);
}

test('DEV and OL each resolve a complete paired endpoint tuple', () => {
  assert.deepEqual(target.DEPLOYMENT_TARGET_CATALOG.dev, {
    key: 'dev',
    label: 'DEV（测试）',
    customerAuthBaseUrl: 'http://121.89.85.150:8088/capi',
    automationWebSocketUrl: 'ws://121.89.85.150:8787',
  });
  assert.deepEqual(target.DEPLOYMENT_TARGET_CATALOG.ol, {
    key: 'ol',
    label: 'OL（正式）',
    customerAuthBaseUrl: 'https://aidcp.tommax.cc/capi',
    automationWebSocketUrl: 'ws://123.56.253.183:8787',
  });
  assert.equal(Object.isFrozen(target.DEPLOYMENT_TARGET_CATALOG), true);
  assert.equal(Object.isFrozen(target.DEPLOYMENT_TARGET_CATALOG.dev), true);
});

test('target migration uses persisted target, official legacy key, package default, then DEV', () => {
  assert.equal(target.migrateDeploymentTarget({ deploymentTarget: 'ol', legacyCloudEnvKey: 'dev', bakedDefault: 'dev' }), 'ol');
  assert.equal(target.migrateDeploymentTarget({ deploymentTarget: 'custom', legacyCloudEnvKey: 'ol', bakedDefault: 'dev' }), 'ol');
  assert.equal(target.migrateDeploymentTarget({ legacyCloudEnvKey: 'custom', bakedDefault: 'ol' }), 'ol');
  assert.equal(target.migrateDeploymentTarget({ bakedDefault: 'unknown' }), 'dev');
  assert.equal(target.isDeploymentTarget('custom'), false);
  assert.equal(target.deploymentTargetConfig('custom'), null);
});

test('target views stay paired and legacy URL classification never accepts arbitrary endpoints', () => {
  assert.deepEqual(target.deploymentTargetView('dev'), {
    key: 'dev',
    label: 'DEV（测试）',
    automationUrl: 'ws://121.89.85.150:8787',
    dataApiUrl: 'http://121.89.85.150:8088/capi',
  });
  assert.equal(target.targetForKnownCustomerAuthUrl('https://aidcp.tommax.cc/capi/'), 'ol');
  assert.equal(target.targetForKnownCustomerAuthUrl('https://example.invalid/capi'), null);
});

test('official customer-auth and automation resolution only use the current target catalog', () => {
  const authResolver = blockBetween(main, 'function resolveClientAuthBase()', 'function clientAuthEnabled()');
  assert.match(authResolver, /deploymentTargetConfig\(settings\.deploymentTarget\)/);
  assert.doesNotMatch(authResolver, /clientAuthUrl|aidcpClientAuthUrl|AIDCP_CLIENT_AUTH_URL|process\.env/);

  const cloudResolver = blockBetween(main, 'function resolveCloudUrl()', 'function cloudSelectionView()');
  assert.match(cloudResolver, /deploymentTargetConfig\(settings\.deploymentTarget\)/);
  assert.match(cloudResolver, /throw new Error\('deployment_target_invalid'\)/);
  assert.doesNotMatch(cloudResolver, /process\.env|cloudUrlCustom|AIDCP_CLOUD_URL/);
});

test('desktop build paths no longer accept or bake an independent customer-auth URL', () => {
  for (const source of [buildScript, buildWorkflow, packageJson]) {
    assert.doesNotMatch(source, /AIDCP_CLIENT_AUTH_URL|client_auth_url|extraMetadata\.aidcpClientAuthUrl/);
  }
  assert.match(buildScript, /extraMetadata\.aidcpCloudDefaultEnv/);
  assert.match(localOlBuild, /aidcpCloudDefaultEnv !== 'ol'/);
  assert.match(localOlBuild, /hasOwnProperty\.call\(pkg, 'aidcpClientAuthUrl'\)/);
  assert.match(localOlBuild, /Packaged app must not contain aidcpClientAuthUrl/);
});
