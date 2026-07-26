import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createAdsProxyAuthorityStore,
} = require('../../src/electron/ads-proxy-authority-store.cjs') as {
  createAdsProxyAuthorityStore: (opts: Record<string, unknown>) => {
    load: (profileId: string) => Record<string, any>;
    save: (profileId: string, proxyConfig: Record<string, unknown>) => Record<string, any>;
    remove: (profileId: string) => Record<string, any>;
  };
};

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('not sealed');
      return text.slice('sealed:'.length);
    },
  };
}

function withStore(run: (ctx: { directory: string; store: ReturnType<typeof createAdsProxyAuthorityStore> }) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidcp-proxy-authority-'));
  try {
    const directory = path.join(root, 'proxy-authorities');
    run({ directory, store: createAdsProxyAuthorityStore({ directory, safeStorage: fakeSafeStorage() }) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('代理权威只持久化 safeStorage 密文，且可精确读回认证字段', () => withStore(({ directory, store }) => {
  const proxyConfig = {
    proxy_soft: 'other',
    proxy_type: 'socks5',
    proxy_host: '171.245.99.71',
    proxy_port: '19983',
    proxy_user: 'NZIsg',
    proxy_password: 'lxqht',
  };
  assert.deepEqual(store.save('profile-1', proxyConfig), { ok: true });
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  const persisted = fs.readFileSync(path.join(directory, files[0]), 'utf8');
  assert.doesNotMatch(persisted, /171\.245\.99\.71|NZIsg|lxqht|profile-1/);
  assert.deepEqual(store.load('profile-1'), { ok: true, found: true, proxyConfig });
}));

test('safeStorage 不可用时拒绝保存，不降级明文', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidcp-proxy-authority-'));
  try {
    const directory = path.join(root, 'proxy-authorities');
    const store = createAdsProxyAuthorityStore({ directory, safeStorage: fakeSafeStorage(false) });
    const result = store.save('profile-1', {
      proxy_soft: 'other',
      proxy_type: 'http',
      proxy_host: '127.0.0.2',
      proxy_port: '8080',
    });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(directory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('明确无代理可按 profile 精确删除密文，即使 safeStorage 暂不可用', () => withStore(({ directory, store }) => {
  assert.equal(store.save('profile-1', {
    proxy_soft: 'other',
    proxy_type: 'http',
    proxy_host: 'proxy.example',
    proxy_port: '8080',
  }).ok, true);
  const unavailable = createAdsProxyAuthorityStore({ directory, safeStorage: fakeSafeStorage(false) });
  assert.deepEqual(unavailable.remove('profile-1'), { ok: true });
  assert.deepEqual(unavailable.load('profile-1'), { ok: true, found: false });
}));

test('损坏密文诚实失败且错误不回显文件内容', () => withStore(({ directory, store }) => {
  assert.equal(store.save('profile-1', {
    proxy_soft: 'other',
    proxy_type: 'https',
    proxy_host: 'proxy.example',
    proxy_port: '443',
    proxy_user: 'secret-user',
    proxy_password: 'secret-pass',
  }).ok, true);
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  fs.writeFileSync(file, '{"version":1,"protection":"safeStorage","ciphertext":"bm90LXNlYWxlZA=="}');
  const result = store.load('profile-1');
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-user|secret-pass/);
}));
