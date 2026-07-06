import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBrowserParking,
  browserParkingConfigFromEnv,
  showBrowserWindow,
} from '../../src/cdp/index.js';

function fakeCdp(probes: Array<{ hidden: boolean; visibility: string; w: number; h: number }>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Browser.setWindowBounds') return {};
      if (method === 'Runtime.evaluate') return { result: { value: probes.shift() } };
      return {};
    },
  };
  return { cdp: cdp as never, calls };
}

const env = {
  AIDCP_BROWSER_PARKING_MODE: 'offscreen',
  AIDCP_BROWSER_PARKING_EFFECTIVE_MODE: 'offscreen',
  AIDCP_BROWSER_PARKING_BOUNDS: JSON.stringify({ left: 2000, top: 0, width: 1440, height: 980 }),
  AIDCP_BROWSER_PARKING_FALLBACK_BOUNDS: JSON.stringify({ left: 1902, top: 0, width: 1440, height: 980 }),
  AIDCP_BROWSER_PARKING_VISIBLE_BOUNDS: JSON.stringify({ left: 80, top: 60, width: 1440, height: 980 }),
};

test('browserParkingConfigFromEnv parses valid config', () => {
  const cfg = browserParkingConfigFromEnv(env);
  assert.equal(cfg?.mode, 'offscreen');
  assert.equal(cfg?.bounds.left, 2000);
});

test('applyBrowserParking keeps configured bounds when visibility is valid', async () => {
  const cfg = browserParkingConfigFromEnv(env);
  const page = fakeCdp([{ hidden: false, visibility: 'visible', w: 1280, h: 720 }]);
  await applyBrowserParking(page.cdp, cfg, () => undefined);
  const sets = page.calls.filter((c) => c.method === 'Browser.setWindowBounds');
  assert.equal(sets.length, 1);
  assert.deepEqual((sets[0].params.bounds as Record<string, unknown>).left, 2000);
});

test('applyBrowserParking falls back when hidden after first placement', async () => {
  const cfg = browserParkingConfigFromEnv(env);
  const page = fakeCdp([
    { hidden: true, visibility: 'hidden', w: 1280, h: 720 },
    { hidden: false, visibility: 'visible', w: 1280, h: 720 },
  ]);
  await applyBrowserParking(page.cdp, cfg, () => undefined);
  const sets = page.calls.filter((c) => c.method === 'Browser.setWindowBounds');
  assert.equal(sets.length, 2);
  assert.deepEqual((sets[1].params.bounds as Record<string, unknown>).left, 1902);
});

test('showBrowserWindow moves to visible bounds', async () => {
  const cfg = browserParkingConfigFromEnv(env);
  const page = fakeCdp([]);
  await showBrowserWindow(page.cdp, cfg, () => undefined);
  const set = page.calls.find((c) => c.method === 'Browser.setWindowBounds');
  assert.deepEqual((set?.params.bounds as Record<string, unknown>).left, 80);
});
