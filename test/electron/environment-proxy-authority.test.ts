import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  adsNoProxyAuthorityView,
  cloudAuthorityForProxyInput,
  isLoopbackProxyConfig,
  migrationAuthorityFromLocalRecord,
  normalizeCloudProxyAuthorityRecord,
  proxyEditorRepairView,
} = require('../../src/electron/environment-proxy-authority.cjs') as {
  adsNoProxyAuthorityView: (input: Record<string, unknown>, profileId: string) => Record<string, any> | null;
  cloudAuthorityForProxyInput: (input: Record<string, unknown>) => Record<string, any>;
  isLoopbackProxyConfig: (input: Record<string, unknown>) => boolean;
  migrationAuthorityFromLocalRecord: (input: Record<string, unknown>) => Record<string, any>;
  normalizeCloudProxyAuthorityRecord: (input: Record<string, unknown>, profileId: string) => Record<string, any>;
  proxyEditorRepairView: (input: Record<string, unknown>) => Record<string, any>;
};

test('AdsPower exact read may classify only explicit no_proxy without importing route fields', () => {
  assert.deepEqual(adsNoProxyAuthorityView({
    ok: true,
    noProxy: true,
    proxy: {
      proxyType: 'no_proxy',
      proxyHost: 'must-not-project',
      proxyUser: 'must-not-project',
      proxyPassword: 'must-not-project',
    },
  }, 'profile-1'), {
    ok: true,
    noProxy: true,
    profileId: 'profile-1',
    revision: null,
    proxyConfig: null,
    proxy: { proxyType: 'no_proxy' },
    source: 'ads_no_proxy',
  });
  assert.equal(adsNoProxyAuthorityView({
    ok: true,
    noProxy: false,
    proxy: {
      proxyType: 'http',
      proxyHost: 'proxy.example',
      proxyPort: '8080',
      proxyUser: 'alice',
      proxyPassword: 'secret',
    },
  }, 'profile-1'), null);
  assert.equal(adsNoProxyAuthorityView({ ok: false, noProxy: true }, 'profile-1'), null);
});

test('proxy input maps to explicit Cloud configured/no_proxy authority', () => {
  assert.deepEqual(cloudAuthorityForProxyInput({ proxyType: 'no_proxy' }), {
    ok: true,
    noProxy: true,
    authority: { state: 'no_proxy' },
    proxyConfig: null,
  });
  const configured = cloudAuthorityForProxyInput({
    proxyType: 'SOCKS5',
    proxyHost: 'proxy.example',
    proxyPort: '1080',
    proxyUser: 'alice',
    proxyPassword: 'secret',
  });
  assert.equal(configured.ok, true);
  assert.deepEqual(configured.authority, {
    state: 'configured',
    proxyType: 'socks5',
    proxyHost: 'proxy.example',
    proxyPort: 1080,
    proxyUser: 'alice',
    proxyPassword: 'secret',
  });
});

test('Cloud record validation binds the exact profile and revision', () => {
  const record = normalizeCloudProxyAuthorityRecord({
    envKey: 'profile-1',
    revision: 4,
    authority: {
      state: 'configured',
      proxyType: 'http',
      proxyHost: 'proxy.example',
      proxyPort: 8080,
      proxyUser: '',
      proxyPassword: '',
    },
  }, 'profile-1');
  assert.equal(record.ok, true);
  assert.equal(record.revision, 4);
  assert.equal(record.proxyConfig.proxy_port, '8080');
  assert.equal(normalizeCloudProxyAuthorityRecord({
    envKey: 'other',
    revision: 4,
    authority: {
      state: 'configured',
      proxyType: 'http',
      proxyHost: 'proxy.example',
      proxyPort: 8080,
      proxyUser: '',
      proxyPassword: '',
    },
  }, 'profile-1').ok, false);
  assert.equal(normalizeCloudProxyAuthorityRecord({
    envKey: 'profile-1',
    revision: 4,
    authority: {
      state: 'configured',
      proxyType: 'http',
      proxyHost: 'proxy.example',
      proxyPort: 8080,
    },
  }, 'profile-1').currentRevision, 4);
  assert.equal(normalizeCloudProxyAuthorityRecord({
    envKey: 'profile-1',
    revision: 0,
    authority: { state: 'no_proxy' },
  }, 'profile-1').currentRevision, undefined);
});

test('proxy editor repair view is blank and preserves only a valid CAS revision', () => {
  assert.deepEqual(proxyEditorRepairView({
    currentRevision: 4,
    authority: {
      proxyHost: 'must-not-project',
      proxyUser: 'must-not-project',
      proxyPassword: 'must-not-project',
    },
  }), {
    ok: true,
    noProxy: false,
    repairRequired: true,
    proxy: {
      proxyType: 'http',
      proxyHost: '',
      proxyPort: '',
      proxyUser: '',
      proxyPassword: '',
    },
    currentRevision: 4,
  });
  assert.equal(proxyEditorRepairView({ currentRevision: 0 }).currentRevision, undefined);
});

test('local migration accepts only a valid non-loopback original proxy', () => {
  for (const host of [
    '127.0.0.1', '127.9.8.7', 'localhost', 'api.localhost', '::1', '[::1]', '::ffff:127.0.0.1', '0.0.0.0',
  ]) {
    assert.equal(isLoopbackProxyConfig({
      proxy_type: 'http',
      proxy_host: host,
      proxy_port: '7890',
    }), true, host);
  }
  const rejected = migrationAuthorityFromLocalRecord({
    ok: true,
    found: true,
    proxyConfig: { proxy_type: 'http', proxy_host: '127.0.0.1', proxy_port: '56718' },
  });
  assert.deepEqual(rejected, { ok: false, reason: 'local_proxy_authority_loopback_rejected' });
  const migrated = migrationAuthorityFromLocalRecord({
    ok: true,
    found: true,
    proxyConfig: {
      proxy_type: 'https',
      proxy_host: 'proxy.example',
      proxy_port: '8443',
      proxy_user: 'alice',
      proxy_password: 'secret',
    },
  });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.authority.proxyHost, 'proxy.example');
});
