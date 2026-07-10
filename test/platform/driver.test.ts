import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPlatformCapability,
  normalizePlatformId,
  selectPlatformDriver,
  type PlatformDriver,
} from '../../src/platform/index.js';

test('selectPlatformDriver: unset platform defaults to xiaohongshu driver', () => {
  const driver = selectPlatformDriver({ env: {} as NodeJS.ProcessEnv });
  assert.equal(driver.platform, 'xiaohongshu');
  assert.equal(driver.app, 'xhs');
  assert.equal(driver.defaultStartUrl, 'https://www.xiaohongshu.com/explore');
  assert.equal(driver.attachUrlIncludes, 'xiaohongshu.com');
  assert.deepEqual(driver.edgeCapabilities, ['locating', 'cdp', 'like', 'browse']);
});

test('normalizePlatformId: xhs aliases resolve to xiaohongshu', () => {
  assert.equal(normalizePlatformId(undefined), 'xiaohongshu');
  assert.equal(normalizePlatformId('xhs'), 'xiaohongshu');
  assert.equal(normalizePlatformId('xiaohongshu'), 'xiaohongshu');
});

test('selectPlatformDriver: facebook declares browse/interact (co-landed with FacebookBrowseSession)', () => {
  const driver = selectPlatformDriver({ env: { AIDCP_PLATFORM: 'facebook' } as NodeJS.ProcessEnv });
  assert.equal(driver.platform, 'facebook');
  assert.equal(driver.app, 'facebook');
  assert.equal(driver.defaultStartUrl, 'https://www.facebook.com/');
  assert.equal(driver.attachUrlIncludes, 'facebook.com');
  assert.deepEqual(driver.edgeCapabilities, ['locating', 'cdp']);
  // change facebook-browse-and-like-loop：'browse'/'interact' 已声明——但仅因 FacebookBrowseSession 在同一 change
  // 原子同落（co-landing），装配闸据此解析到 FB 浏览会话而非小红书 BrowseSession。'comment'/'join' 为既有能力。
  assert.deepEqual(driver.capabilities, ['identity', 'overlay', 'browse', 'comment', 'join', 'interact']);
  assert.equal(driver.capabilities.includes('browse'), true);
  assert.equal(driver.isAllowedTargetUrl('https://www.facebook.com/groups/example'), true);
  assert.equal(driver.isAllowedTargetUrl('https://m.facebook.com/story.php?story_fbid=1'), true);
  assert.equal(driver.isAllowedTargetUrl('https://www.xiaohongshu.com/explore'), false);
});

test('normalizePlatformId: unknown platform values fail honestly', () => {
  assert.throws(() => normalizePlatformId('instagram'), /unsupported AIDCP_PLATFORM/);
});

test('assertPlatformCapability: missing capability does not fall back to xhs path', () => {
  const driver = {
    ...selectPlatformDriver({ env: {} as NodeJS.ProcessEnv }),
    capabilities: ['identity'],
  } as PlatformDriver;
  assert.throws(() => assertPlatformCapability(driver, 'publish'), /does not support capability=publish/);
});

test('xhs driver keeps shared runtime foundations outside src/xhs', async () => {
  const driverSource = await readFile(new URL('../../src/xhs/driver.ts', import.meta.url), 'utf8');
  assert.match(driverSource, /..\/cdp\/self-identity/);
  assert.match(driverSource, /..\/browse\/overlay-monitor/);
  assert.doesNotMatch(driverSource, /class\s+CdpClient|new\s+CdpClient|class\s+LocatingEngine|function\s+evalRaw/);
});
