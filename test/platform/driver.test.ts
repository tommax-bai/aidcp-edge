import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPlatformCapability,
  delegatedActionSupportForPlatform,
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

test('selectPlatformDriver: wechat_channels registers API-only interaction capabilities', () => {
  assert.equal(normalizePlatformId('wechat-channels'), 'wechat_channels');
  const driver = selectPlatformDriver({ env: { AIDCP_PLATFORM: 'wechat_channels' } as NodeJS.ProcessEnv });
  assert.equal(driver.platform, 'wechat_channels');
  assert.equal(driver.runtimeKind, 'interaction');
  assert.equal(driver.capabilities.includes('interaction.comment.read'), true);
  assert.equal(driver.capabilities.includes('interaction.dm.send_image'), false);
  assert.equal(driver.capabilities.includes('browse'), false);
  assert.equal(driver.edgeCapabilities.includes('interaction_inbox_v1'), true);
  assert.equal(driver.edgeCapabilities.includes('interaction_reply_recovery_v1'), true);
  assert.equal(driver.edgeCapabilities.includes('interaction_offboarding_v1'), true);
  assert.equal(driver.isAllowedTargetUrl('https://channels.weixin.qq.com/platform/post/list'), true);
  assert.equal(driver.isAllowedTargetUrl('https://www.xiaohongshu.com/explore'), false);
});

test('selectPlatformDriver: facebook declares browse/interact (co-landed with FacebookBrowseSession)', () => {
  const driver = selectPlatformDriver({ env: { AIDCP_PLATFORM: 'facebook' } as NodeJS.ProcessEnv });
  assert.equal(driver.platform, 'facebook');
  assert.equal(driver.app, 'facebook');
  assert.equal(driver.defaultStartUrl, 'https://www.facebook.com/');
  assert.equal(driver.attachUrlIncludes, 'facebook.com');
  // change facebook-feed-inline-browse：'inline_targeting' 声明「本构建能处理 note.open{surface:'feed'} + feed 两段点赞」，
  // 供云端版本偏斜闸只对声明该位的边缘开 inline 旗标（默认全关 = 逐位等于今天）。
  assert.deepEqual(driver.edgeCapabilities, ['locating', 'cdp', 'inline_targeting']);
  // change facebook-browse-and-like-loop：'browse'/'interact' 已声明——但仅因 FacebookBrowseSession 在同一 change
  // 原子同落（co-landing），装配闸据此解析到 FB 浏览会话而非小红书 BrowseSession。'comment'/'join' 为既有能力。
  // change facebook-post-publish：'publish' 与 FacebookPublishExecutor 同落，不能裸声明。
  assert.deepEqual(driver.capabilities, ['identity', 'overlay', 'browse', 'comment', 'join', 'publish', 'interact']);
  assert.equal(driver.capabilities.includes('browse'), true);
  assert.equal(driver.isAllowedTargetUrl('https://www.facebook.com/groups/example'), true);
  assert.equal(driver.isAllowedTargetUrl('https://m.facebook.com/story.php?story_fbid=1'), true);
  assert.equal(driver.isAllowedTargetUrl('https://www.xiaohongshu.com/explore'), false);
});

test('normalizePlatformId: unknown platform values fail honestly', () => {
  assert.throws(() => normalizePlatformId('instagram'), /unsupported AIDCP_PLATFORM/);
});

test('delegated actions: xiaohongshu supports phase-1 scope and rejects Facebook-only group action', () => {
  assert.deepEqual(delegatedActionSupportForPlatform('xiaohongshu', 'comment_batch'), { level: 'supported' });
  assert.deepEqual(delegatedActionSupportForPlatform('xiaohongshu', 'publish_from_inspiration'), {
    level: 'supported',
  });
  assert.deepEqual(delegatedActionSupportForPlatform('xiaohongshu', 'facebook_group_comment'), {
    level: 'unsupported',
    reason: 'facebook_only',
  });
});

test('delegated actions: Facebook remains beta and does not advertise unsupported arbitrary creation/targeting', () => {
  assert.deepEqual(delegatedActionSupportForPlatform('facebook', 'publish_post'), {
    level: 'beta',
    reason: 'real_machine_and_client_capability_gate',
    runtimeGate: 'facebook_publish_capability',
  });
  assert.equal(delegatedActionSupportForPlatform('facebook', 'facebook_group_comment').level, 'beta');
  assert.deepEqual(delegatedActionSupportForPlatform('facebook', 'publish_from_inspiration'), {
    level: 'unsupported',
    reason: 'facebook_creation_template_language_media_strategy_not_ready',
  });
  assert.deepEqual(delegatedActionSupportForPlatform('facebook', 'comment_curated'), {
    level: 'unsupported',
    reason: 'arbitrary_facebook_post_targeting_not_supported',
  });
});

test('delegated actions: wechat_channels advertises no outbound delegation capability', () => {
  const inboundOnlyActions = [
    'comment_batch',
    'publish_post',
    'publish_from_inspiration',
    'comment_curated',
    'generate_candidates',
    'approve_candidate',
    'reject_candidate',
    'modify_candidate',
  ] as const;

  for (const action of inboundOnlyActions) {
    assert.deepEqual(delegatedActionSupportForPlatform('wechat_channels', action), {
      level: 'unsupported',
      reason: 'inbound_interaction_only',
    });
  }
  assert.deepEqual(delegatedActionSupportForPlatform('wechat_channels', 'facebook_group_comment'), {
    level: 'unsupported',
    reason: 'facebook_only',
  });
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
