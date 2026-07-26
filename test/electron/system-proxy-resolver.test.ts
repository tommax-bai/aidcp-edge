import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const resolver = require('../../src/electron/system-proxy-resolver.cjs') as {
  parseScutilProxy(text: string): Record<string, unknown>;
  resolveMacSystemProxy(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

test('system proxy resolver prefers SOCKS5 and treats HTTPS web proxy as HTTP CONNECT', () => {
  const both = resolver.parseScutilProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 8080
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 8443
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 1080
  ProxyAutoConfigEnable : 0
}`);
  assert.deepEqual(both, {
    ok: true,
    proxy: { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080' },
    source: 'socks5',
  });

  const secureWebOnly = resolver.parseScutilProxy(`
<dictionary> {
  HTTPSEnable : 1
  HTTPSProxy : proxy.local
  HTTPSPort : 7890
}`);
  assert.deepEqual(secureWebOnly, {
    ok: true,
    proxy: { proxyType: 'http', proxyHost: 'proxy.local', proxyPort: '7890' },
    source: 'https_web',
  });
});

test('system proxy resolver rejects PAC, WPAD, missing and invalid fixed endpoints', () => {
  assert.deepEqual(
    resolver.parseScutilProxy('ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://secret/pac'),
    { ok: false, reason: 'system_proxy_pac_unsupported' },
  );
  assert.deepEqual(
    resolver.parseScutilProxy('ProxyAutoDiscoveryEnable : 1'),
    { ok: false, reason: 'system_proxy_wpad_unsupported' },
  );
  assert.deepEqual(
    resolver.parseScutilProxy('HTTPEnable : 0'),
    { ok: false, reason: 'system_proxy_not_configured' },
  );
  assert.deepEqual(
    resolver.parseScutilProxy('HTTPEnable : 1\nHTTPProxy : http://bad.example\nHTTPPort : 99999'),
    { ok: false, reason: 'system_proxy_config_invalid' },
  );
});

test('resolveMacSystemProxy uses bounded scutil and returns stable errors only', async () => {
  let call: Record<string, unknown> | undefined;
  const ok = await resolver.resolveMacSystemProxy({
    platform: 'darwin',
    execFileImpl: (command: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string) => void) => {
      call = { command, args, options };
      callback(null, 'SOCKSEnable : 1\nSOCKSProxy : localhost\nSOCKSPort : 7890');
    },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(call?.args, ['--proxy']);
  assert.equal(call?.command, '/usr/sbin/scutil');

  const failed = await resolver.resolveMacSystemProxy({
    platform: 'darwin',
    execFileImpl: (_command: string, _args: string[], _options: Record<string, unknown>, callback: (error: Error) => void) => {
      callback(new Error('sensitive failure body'));
    },
  });
  assert.deepEqual(failed, { ok: false, reason: 'system_proxy_read_failed' });
  assert.deepEqual(
    await resolver.resolveMacSystemProxy({ platform: 'linux' }),
    { ok: false, reason: 'system_proxy_platform_unsupported' },
  );
});
