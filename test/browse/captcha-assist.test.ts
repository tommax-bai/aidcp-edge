import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaAssistHandler } from '../../src/browse/captcha-assist.js';
import type { BrowseCdp, OverlayKind, OverlayMonitor } from '../../src/browse/index.js';
import type { MessageType } from '../../src/comm/protocol.js';

class FakeCdp implements BrowseCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  constructor(private readonly opts: { overlayRect?: { x: number; y: number; width: number; height: number } } = {}) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression ?? '');
      if (expression.includes('deviceScaleFactor')) {
        return { result: { value: { width: 1000, height: 800, deviceScaleFactor: 2, url: 'https://xhs.test/explore' } } } as T;
      }
      return {
        result: {
          value: {
            kind: 'captcha',
            firstDetectedUrl: 'https://xhs.test/explore',
            capturedAt: 100,
            text: '安全验证',
            dom: {
              tag: 'div',
              className: 'captcha-modal',
              rect: this.opts.overlayRect ?? { x: 100, y: 100, width: 200, height: 100 },
              matchReasons: ['captcha_text'],
            },
            candidates: [],
          },
        },
      } as T;
    }
    if (method === 'Page.captureScreenshot') {
      return { data: 'screenshot-base64' } as T;
    }
    return {} as T;
  }
}

class FakeMonitor implements OverlayMonitor {
  readonly state: OverlayKind = 'captcha';
  constructor(private readonly probes: OverlayKind[]) {}
  async probeNow(): Promise<OverlayKind> {
    return this.probes.shift() ?? 'captcha';
  }
  start(): void {}
  stop(): void {}
}

class FakeClient {
  readonly sent: Array<{ type: MessageType; payload: unknown; id?: string }> = [];
  send<T>(type: MessageType, payload: T, id?: string): void {
    this.sent.push({ type, payload, id });
  }
}

test('captcha assist capture: fresh blocking overlay → cropped screenshot snapshot', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    getAccountId: () => 'acc-1',
    overlayMonitor: new FakeMonitor(['captcha']),
    now: () => 1000,
    idGen: () => 'snap-1',
    sleep: async () => {},
    logger: () => {},
  });

  await handler.handle('captcha.assist.capture', { incidentId: 'cap-1', reason: 'refresh', quality: 80 });

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].type, 'captcha.assist.snapshot');
  const snapshot = client.sent[0].payload as {
    snapshotId: string;
    edgeId: string;
    accountId: string;
    crop: { x: number; y: number; width: number; height: number };
    image: { mime: string; data: string };
  };
  assert.equal(snapshot.snapshotId, 'snap-1');
  assert.equal(snapshot.edgeId, 'edge-1');
  assert.equal(snapshot.accountId, 'acc-1');
  assert.deepEqual(snapshot.crop, { x: 76, y: 76, width: 248, height: 148 });
  assert.equal(snapshot.image.mime, 'image/jpeg');
  assert.equal(snapshot.image.data, 'screenshot-base64');
  const screenshotCall = cdp.calls.find((call) => call.method === 'Page.captureScreenshot');
  assert.deepEqual((screenshotCall?.params?.clip as Record<string, unknown>), { x: 76, y: 76, width: 248, height: 148, scale: 1 });
});

test('captcha assist capture: fresh probe says not blocked → not_blocked + risk.captcha_cleared', async () => {
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp: new FakeCdp(),
    client,
    edgeId: 'edge-1',
    getAccountId: () => 'acc-1',
    overlayMonitor: new FakeMonitor(['none']),
    now: () => 2000,
    sleep: async () => {},
    logger: () => {},
  });

  await handler.handle('captcha.assist.capture', { incidentId: 'cap-2' });

  assert.deepEqual(client.sent.map((item) => item.type), ['captcha.assist.click_result', 'risk.captcha_cleared']);
  assert.equal((client.sent[0].payload as { status: string }).status, 'not_blocked');
});

test('captcha assist click: normalized points map to viewport coordinates and cleared emits risk.captcha_cleared', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    getAccountId: () => 'acc-1',
    overlayMonitor: new FakeMonitor(['captcha', 'none']),
    now: () => 3000,
    idGen: () => 'snap-click',
    sleep: async () => {},
    logger: () => {},
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'cap-3', quality: 80 });
  client.sent.length = 0;

  await handler.handle('captcha.assist.click', {
    incidentId: 'cap-3',
    snapshotId: 'snap-click',
    points: [{ x: 0.5, y: 0.5 }],
    settleMs: 1,
  });

  const pressed = cdp.calls.find(
    (call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed',
  );
  assert.equal(pressed?.params?.x, 200);
  assert.equal(pressed?.params?.y, 150);
  assert.deepEqual(client.sent.map((item) => item.type), ['captcha.assist.click_result', 'risk.captcha_cleared']);
  assert.equal((client.sent[0].payload as { status: string }).status, 'cleared');
});
