import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeOlUpdateConfig, createAutoUpdateService, UPDATE_CHECK_INTERVAL_MS } = require('../../src/electron/auto-update.cjs');

function fakeUpdater(isUpdateAvailable = false) {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    listeners,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    feed: null as unknown,
    checks: 0,
    downloads: 0,
    installs: 0,
    on(event: string, listener: (...args: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) || []), listener]);
    },
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) || []) listener(...args);
    },
    setFeedURL(feed: unknown) { this.feed = feed; },
    async checkForUpdates() { this.checks += 1; return { isUpdateAvailable, updateInfo: { version: '9.9.9' } }; },
    async downloadUpdate() { this.downloads += 1; return ['downloaded']; },
    quitAndInstall() { this.installs += 1; },
  };
}

test('only a packaged macOS app with baked OL HTTPS metadata enables updates', () => {
  const valid = normalizeOlUpdateConfig({
    isPackaged: true,
    platform: 'darwin',
    channel: 'ol',
    url: 'https://updates.example.com/ol/stable',
  });
  assert.deepEqual(valid, { enabled: true, channel: 'ol', url: 'https://updates.example.com/ol/stable/' });

  for (const config of [
    { isPackaged: false, platform: 'darwin', channel: 'ol', url: 'https://updates.example.com/ol/' },
    { isPackaged: true, platform: 'win32', channel: 'ol', url: 'https://updates.example.com/ol/' },
    { isPackaged: true, platform: 'darwin', channel: 'dev', url: 'https://updates.example.com/ol/' },
    { isPackaged: true, platform: 'darwin', channel: 'ol', url: 'http://updates.example.com/ol/' },
  ]) {
    assert.equal(normalizeOlUpdateConfig(config).enabled, false);
  }
});

test('checking is delayed, throttled by one active request, and never auto-downloads', async () => {
  const updater = fakeUpdater();
  const scheduled: Array<{ kind: string; fn: () => void; delay: number }> = [];
  const timers = {
    setTimeout(fn: () => void, delay: number) { const timer = { unref() {} }; scheduled.push({ kind: 'timeout', fn, delay }); return timer; },
    setInterval(fn: () => void, delay: number) { const timer = { unref() {} }; scheduled.push({ kind: 'interval', fn, delay }); return timer; },
    clearTimeout() {},
    clearInterval() {},
  };
  const available: string[] = [];
  const service = createAutoUpdateService({
    autoUpdater: updater,
    config: { isPackaged: true, platform: 'darwin', channel: 'ol', url: 'https://updates.example.com/ol/' },
    timers,
    onAvailable: (info: { version: string }) => available.push(info.version),
  });

  assert.equal(service.enabled, true);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.deepEqual(updater.feed, { provider: 'generic', url: 'https://updates.example.com/ol/' });
  assert.equal(service.start(), true);
  assert.equal(service.start(), false);
  assert.equal(scheduled[1].delay, UPDATE_CHECK_INTERVAL_MS);

  scheduled[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 0);

  updater.emit('update-available', { version: '9.9.9' });
  assert.deepEqual(available, ['9.9.9']);
  await service.downloadUpdate();
  assert.equal(updater.downloads, 1);
});

test('errors remain observable and installation occurs only by explicit call', async () => {
  const updater = fakeUpdater();
  const errors: string[] = [];
  const service = createAutoUpdateService({
    autoUpdater: updater,
    config: { isPackaged: true, platform: 'darwin', channel: 'ol', url: 'https://updates.example.com/ol/' },
    onError: ({ phase, error }: { phase: string; error: Error }) => errors.push(`${phase}:${error.message}`),
  });
  updater.emit('error', new Error('bad manifest'));
  assert.deepEqual(errors, ['updater:bad manifest']);
  assert.equal(updater.installs, 0);
  assert.equal(service.quitAndInstall(), true);
  assert.equal(updater.installs, 1);
});

test('a user-triggered check exposes availability without starting a download', async () => {
  const updater = fakeUpdater(true);
  const service = createAutoUpdateService({
    autoUpdater: updater,
    config: { isPackaged: true, platform: 'darwin', channel: 'ol', url: 'https://updates.example.com/ol/' },
  });

  const result = await service.checkForUpdates();
  assert.equal(result?.isUpdateAvailable, true);
  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 0, 'checking manually must not bypass the explicit download confirmation');
});
