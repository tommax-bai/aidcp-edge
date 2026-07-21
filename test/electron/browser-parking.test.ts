import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parking = require('../../src/electron/browser-parking.cjs') as {
  DEFAULT_PARKING_MODE: string;
  normalizeParkingMode: (value: unknown) => string;
  computeBrowserParkingPlan: (mode: string, displays: unknown[], primary: unknown) => {
    requestedMode: string;
    effectiveMode: string;
    reason: string;
    bounds: { left: number; top: number; width: number; height: number };
    fallbackBounds: { left: number; top: number; width: number; height: number };
    visibleBounds: { left: number; top: number; width: number; height: number };
    launchPosition: { left: number; top: number };
  };
  clientAlignedBrowserBounds: (
    clientBounds: { x: number; y: number; width: number; height: number },
    display: unknown,
  ) => { left: number; top: number; width: number; height: number } | null;
  parkingEnv: (plan: unknown) => Record<string, string>;
};

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const secondary = { id: 2, workArea: { x: 1920, y: 0, width: 1600, height: 900 } };

test('primary-screen is the default and invalid values normalize to it', () => {
  assert.equal(parking.DEFAULT_PARKING_MODE, 'primary-screen');
  assert.equal(parking.normalizeParkingMode('primary-screen'), 'primary-screen');
  assert.equal(parking.normalizeParkingMode('offscreen'), 'offscreen');
  assert.equal(parking.normalizeParkingMode('bogus'), 'primary-screen');
  assert.equal(parking.normalizeParkingMode(undefined), 'primary-screen');
});

test('primary-screen parks fully on the primary display and shows centered', () => {
  const plan = parking.computeBrowserParkingPlan('primary-screen', [primary], primary);
  assert.equal(plan.effectiveMode, 'primary-screen');
  // 背景位：右对齐但完全在屏内（left+width=1920≤屏宽），顶部近上沿——操作系统必然认账。
  assert.deepEqual(plan.bounds, { left: 480, top: 40, width: 1440, height: 980 });
  // 抬前/兜底位：居中于主屏工作区。
  assert.deepEqual(plan.visibleBounds, { left: 240, top: 50, width: 1440, height: 980 });
  assert.deepEqual(plan.fallbackBounds, plan.visibleBounds);
});

test('avatar show centers the fixed browser rectangle on the live AIDCP window', () => {
  assert.deepEqual(
    parking.clientAlignedBrowserBounds({ x: 38, y: 22, width: 1432, height: 1145 }, primary),
    { left: 34, top: 100, width: 1440, height: 980 },
  );
});

test('client-aligned bounds use the matching display and clamp only at its work-area edge', () => {
  assert.deepEqual(
    parking.clientAlignedBrowserBounds({ x: 2000, y: 20, width: 1200, height: 800 }, secondary),
    { left: 1920, top: 0, width: 1440, height: 900 },
  );
});

test('parking-display targets a secondary display when available', () => {
  const plan = parking.computeBrowserParkingPlan('parking-display', [primary, secondary], primary);
  assert.equal(plan.effectiveMode, 'parking-display');
  assert.deepEqual(plan.bounds, { left: 1920, top: 0, width: 1440, height: 980 });
  assert.deepEqual(plan.launchPosition, { left: 3600, top: 0 }, '启动暂存位必须越过最右侧副屏');
});

test('parking-display falls back to the default (primary-screen) without a secondary display', () => {
  const plan = parking.computeBrowserParkingPlan('parking-display', [primary], primary);
  assert.equal(plan.effectiveMode, 'primary-screen');
  assert.equal(plan.reason, 'no_secondary_display');
  // effectiveMode 与 bounds 一致（都是 primary-screen），不再各说各话。
  assert.deepEqual(plan.bounds, { left: 480, top: 40, width: 1440, height: 980 });
});

test('offscreen is fully beyond the primary display right edge', () => {
  const plan = parking.computeBrowserParkingPlan('offscreen', [primary], primary);
  assert.equal(plan.effectiveMode, 'offscreen');
  assert.equal(plan.bounds.left, 2000);
});

test('parkingEnv serializes bounds and launch position', () => {
  const plan = parking.computeBrowserParkingPlan('edge-strip', [primary], primary);
  const env = parking.parkingEnv(plan);
  assert.equal(env.AIDCP_BROWSER_PARKING_MODE, 'edge-strip');
  assert.equal(env.AIDCP_BROWSER_PARKING_LAUNCH_POSITION, '2000,0');
  assert.deepEqual(JSON.parse(env.AIDCP_BROWSER_PARKING_BOUNDS), plan.bounds);
  assert.equal(plan.bounds.left, 1902, '最终 edge-strip 停放位与屏外启动暂存位保持独立');
});
