import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpModalController } from '../../src/browse/modal-controller.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

function fakeCdp(handler: (method: string, params: Record<string, unknown>) => unknown): {
  cdp: BrowseCdp;
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const cdp: BrowseCdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return handler(method, params) as never;
    },
  };
  return { cdp, calls };
}

test('isModalOpen: 返回 evaluate 的布尔结果', async () => {
  const { cdp } = fakeCdp(() => ({ result: { type: 'boolean', value: true } }));
  const ctrl = new CdpModalController(cdp);
  assert.equal(await ctrl.isModalOpen(), true);

  const { cdp: cdp2 } = fakeCdp(() => ({ result: { type: 'boolean', value: false } }));
  const ctrl2 = new CdpModalController(cdp2);
  assert.equal(await ctrl2.isModalOpen(), false);
});

test('waitForModal: 轮询直到打开', async () => {
  let n = 0;
  const { cdp } = fakeCdp(() => ({ result: { value: ++n >= 3 } }));
  const ctrl = new CdpModalController(cdp, {
    pollIntervalMs: 1,
    defaultTimeoutMs: 1000,
    sleep: async () => {},
  });
  assert.equal(await ctrl.waitForModal(), true);
  assert.ok(n >= 3);
});

test('waitForModal: 超时返回 false', async () => {
  let now = 0;
  const { cdp } = fakeCdp(() => ({ result: { value: false } }));
  const ctrl = new CdpModalController(cdp, {
    pollIntervalMs: 5,
    defaultTimeoutMs: 20,
    sleep: async () => { now += 10; },
    clock: () => now,
  });
  assert.equal(await ctrl.waitForModal(), false);
});

test('closeModal: 命中遮罩点击则不按 ESC', async () => {
  const { cdp, calls } = fakeCdp((method) => {
    if (method === 'Runtime.evaluate') return { result: { value: true } };
    return {};
  });
  const ctrl = new CdpModalController(cdp);
  await ctrl.closeModal();
  assert.ok(!calls.some((c) => c.method === 'Input.dispatchKeyEvent'));
});

test('closeModal: 未命中遮罩则兜底按 ESC', async () => {
  const { cdp, calls } = fakeCdp((method) => {
    if (method === 'Runtime.evaluate') return { result: { value: false } };
    return {};
  });
  const ctrl = new CdpModalController(cdp);
  await ctrl.closeModal();
  const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
  assert.ok(keys.length >= 2);
  assert.equal(keys[0].params.key, 'Escape');
});
