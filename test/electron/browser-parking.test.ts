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
  };
  parkingEnv: (plan: unknown) => Record<string, string>;
};

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const secondary = { id: 2, workArea: { x: 1920, y: 0, width: 1600, height: 900 } };

test('normalizeParkingMode defaults invalid values to edge-strip', () => {
  assert.equal(parking.normalizeParkingMode('offscreen'), 'offscreen');
  assert.equal(parking.normalizeParkingMode('bogus'), 'edge-strip');
  assert.equal(parking.normalizeParkingMode(undefined), 'edge-strip');
});

test('parking-display targets a secondary display when available', () => {
  const plan = parking.computeBrowserParkingPlan('parking-display', [primary, secondary], primary);
  assert.equal(plan.effectiveMode, 'parking-display');
  assert.deepEqual(plan.bounds, { left: 1920, top: 0, width: 1440, height: 980 });
});

test('parking-display falls back to edge-strip without secondary display', () => {
  const plan = parking.computeBrowserParkingPlan('parking-display', [primary], primary);
  assert.equal(plan.effectiveMode, 'edge-strip');
  assert.equal(plan.reason, 'no_secondary_display');
  assert.deepEqual(plan.bounds, { left: 1902, top: 0, width: 1440, height: 980 });
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
  assert.equal(env.AIDCP_BROWSER_PARKING_LAUNCH_POSITION, '1902,0');
  assert.deepEqual(JSON.parse(env.AIDCP_BROWSER_PARKING_BOUNDS), plan.bounds);
});
