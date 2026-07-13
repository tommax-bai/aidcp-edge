import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeFacebookPostMediaReadOnly } from '../../src/facebook/probes/post-media-probe.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

class FakeMediaProbeCdp implements BrowseCdp {
  attached = true;
  mouseReleased = false;

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
      this.mouseReleased = true;
      this.attached = false;
      return {} as T;
    }
    if (method === 'Runtime.evaluate') {
      return {
        result: {
          value: JSON.stringify({ found: this.attached, x: this.attached ? 100 : null, y: this.attached ? 120 : null }),
        },
      } as T;
    }
    return {} as T;
  }
}

test('Facebook post media probe attaches and removes without submit', async () => {
  const cdp = new FakeMediaProbeCdp();
  const result = await probeFacebookPostMediaReadOnly(
    cdp,
    { upload: async () => ({ ok: true }) } as never,
    { imageUrl: 'https://cdn.example.com/probe.jpg', sleep: async () => {} },
  );

  assert.deepEqual(result, {
    ok: true,
    submitted: false,
    attachmentObserved: true,
    removalControlFound: true,
    removed: true,
  });
  assert.equal(cdp.mouseReleased, true);
});

test('Facebook post media probe returns uploader failure without clicking', async () => {
  const cdp = new FakeMediaProbeCdp();
  const result = await probeFacebookPostMediaReadOnly(
    cdp,
    { upload: async () => ({ ok: false, error: 'image_not_attached' }) } as never,
    { imageUrl: 'https://cdn.example.com/probe.jpg', sleep: async () => {} },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'image_not_attached');
  assert.equal(cdp.mouseReleased, false);
});
