import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { InteractionSyncRequestPayload } from '../../src/comm/protocol.js';
import type { InteractionTransport } from '../../src/platform/interaction-connector.js';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import type { WechatAuthCoordinator } from '../../src/wechat-channels/auth-session.js';
import { WechatChannelsConnector } from '../../src/wechat-channels/connector.js';
import type { WechatCapabilityState } from '../../src/wechat-channels/feature-flags.js';
import { validateInteractionSyncRequest } from '../../src/wechat-channels/protocol-validation.js';
import { WechatRuntimeStateStore } from '../../src/wechat-channels/state-store.js';
import type { WechatCommentWriteContext } from '../../src/wechat-channels/types.js';

const scope = { envKey: 'env-a', accountId: 'acct-a', browserProfileId: 'profile-a' };
const writeContext: WechatCommentWriteContext = {
  levelTwoComment: [], commentId: 'comment-target', commentNickname: 'Synthetic',
  commentContent: 'synthetic', commentHeadurl: '', commentCreatetime: '1700000000',
  commentLikeCount: 0, lastBuff: '', downContinueFlag: 0, visibleFlag: 1,
  readFlag: true, displayFlag: 1, username: 'synthetic-user', blacklistFlag: 0, likeFlag: 0,
};

function resetRequest(channel: 'comment' | 'dm' = 'comment'): InteractionSyncRequestPayload {
  return {
    requestId: `reset-${channel}`, envKey: scope.envKey, accountId: scope.accountId,
    platform: 'wechat_channels', channel, scopeExternalId: null, reason: 'test_reset', requestedAt: 10,
  };
}

test('test_reset is strictly validated as a negotiated sync reason', () => {
  assert.deepEqual(validateInteractionSyncRequest(resetRequest()), resetRequest());
  assert.throws(() => validateInteractionSyncRequest({ ...resetRequest(), reason: 'delete_everything' }),
    /payload\.reason/);
});

test('runtime state reset clears only the selected read channel and persists the result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-test-reset-'));
  try {
    const state = new WechatRuntimeStateStore(scope, root);
    await state.commitCheckpoint('comment', null, { cursor: 'comment-global', batchId: 'comment-batch', updatedAt: 1 });
    await state.commitCheckpoint('comment', 'post-a', { cursor: 'comment-post', batchId: 'comment-post-batch', updatedAt: 2 });
    await state.commitCheckpoint('dm', null, { cursor: 'dm-global', batchId: 'dm-batch', updatedAt: 3 });
    await state.putThreadSource('comment', 'comment-thread', 'post-a');
    await state.putThreadSource('dm', 'dm-thread', null);
    await state.putCommentWriteContexts([writeContext]);

    const persisted = new WechatRuntimeStateStore(scope, root);
    assert.deepEqual(await persisted.getCommentWriteContext('comment-target'), writeContext);
    assert.deepEqual(await persisted.resetReadState('comment'), {
      checkpoints: 2, threadSources: 1, commentWriteContexts: 1,
    });
    const reloaded = new WechatRuntimeStateStore(scope, root);
    assert.equal((await reloaded.getCheckpoint('comment', null)).cursor, null);
    assert.equal((await reloaded.getCheckpoint('comment', 'post-a')).cursor, null);
    assert.equal(await reloaded.getThreadSource('comment', 'comment-thread'), undefined);
    assert.equal(await reloaded.getCommentWriteContext('comment-target'), undefined);
    assert.equal((await reloaded.getCheckpoint('dm', null)).cursor, 'dm-global');
    assert.equal(await reloaded.getThreadSource('dm', 'dm-thread'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('connector resets state inside the channel sync lock before rereading', async () => {
  const events: string[] = [];
  const state = {
    resetReadState: async (channel: string) => { events.push(`reset:${channel}`); return { checkpoints: 1, threadSources: 1 }; },
  } as unknown as WechatRuntimeStateStore;
  const auth = {
    getSnapshot: () => ({ status: 'active', browserState: 'closed', identityMatches: true,
      identity: { externalId: 'finder-a', displayName: 'A' }, checkedAt: 1, reasonCode: null }),
    markApiFailure: () => undefined,
  } as unknown as WechatAuthCoordinator;
  const capabilities = {
    effective: () => ({ commentsRead: true, commentsReply: false, dmRead: true, dmSendText: false, dmSendImage: false }),
    getRemoteControls: () => ({ version: 1 }),
  } as unknown as WechatCapabilityState;
  const connector = new WechatChannelsConnector({
    envKey: scope.envKey, accountId: scope.accountId, state, auth, capabilities,
    api: {} as WechatChannelsApiClient, transport: {} as InteractionTransport,
  });
  (connector as unknown as { comments: { sync: (request: InteractionSyncRequestPayload) => Promise<void> } }).comments = {
    sync: async () => { events.push('sync:comment'); },
  };

  await connector.sync(resetRequest('comment'));
  assert.deepEqual(events, ['reset:comment', 'sync:comment']);
});
