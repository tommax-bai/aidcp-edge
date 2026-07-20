import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACEBOOK_STARTUP_IDENTITY_HYDRATE_MS,
  startupIdentityReadPolicy,
} from '../../src/platform/index.js';

test('startupIdentityReadPolicy: Facebook AdsPower opts into bounded page bootstrap', () => {
  assert.deepEqual(startupIdentityReadPolicy('facebook', 'adspower'), {
    allowNavigate: true,
    hydrateTimeoutMs: FACEBOOK_STARTUP_IDENTITY_HYDRATE_MS,
  });
});

test('startupIdentityReadPolicy: XHS AdsPower remains navigation-free and self keeps reader defaults', () => {
  assert.deepEqual(startupIdentityReadPolicy('xiaohongshu', 'adspower'), { allowNavigate: false });
  assert.deepEqual(startupIdentityReadPolicy('xiaohongshu', 'self'), {});
});
