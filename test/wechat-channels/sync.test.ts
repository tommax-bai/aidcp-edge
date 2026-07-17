import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  InteractionSyncAckPayload,
  InteractionSyncBatchPayload,
  InteractionSyncRequestPayload,
} from '../../src/comm/protocol.js';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import { WechatCommentSynchronizer } from '../../src/wechat-channels/comment-sync.js';
import { WechatDmSynchronizer } from '../../src/wechat-channels/dm-sync.js';
import { WechatChannelsError } from '../../src/wechat-channels/error-classifier.js';
import { WechatRuntimeStateStore } from '../../src/wechat-channels/state-store.js';
import { stableBatchId } from '../../src/wechat-channels/sync-common.js';
import type {
  WechatComment,
  WechatDmMessage,
  WechatDmSession,
  WechatPost,
  WechatSessionMaterial,
} from '../../src/wechat-channels/types.js';

const SCOPE = { envKey: 'env-a', accountId: 'finder-a', browserProfileId: 'profile-a' };
const SESSION: WechatSessionMaterial = {
  cookies: [{ name: 'session', value: 'secret', domain: '.channels.weixin.qq.com' }],
  userAgent: 'ua',
  acquiredAt: 1,
  requestContext: { version: 1, aid: 'aid-test', pageUrl: 'https://channels.weixin.qq.com/platform/post/list', commonBody: { logFinderId: 'finder-test', logFinderUin: 'uin-test', rawKeyBuff: 'raw-key-test', pluginSessionId: null, reqScene: 7, scene: 7 }, headers: { fingerprintDeviceId: 'device-test', wechatUin: 'uin-test' } },
};

function request(channel: 'comment' | 'dm', scopeExternalId: string | null): InteractionSyncRequestPayload {
  return {
    requestId: `request-${channel}`,
    envKey: SCOPE.envKey,
    accountId: SCOPE.accountId,
    platform: 'wechat_channels',
    channel,
    scopeExternalId,
    reason: 'user_requested',
    requestedAt: 1_700_000_000_000,
  };
}

function accepted(batch: InteractionSyncBatchPayload, status: 'accepted' | 'duplicate' = 'accepted'): InteractionSyncAckPayload {
  return {
    batchId: batch.batchId,
    envKey: batch.envKey,
    accountId: batch.accountId,
    platform: 'wechat_channels',
    channel: batch.channel,
    scopeExternalId: batch.scopeExternalId,
    status,
    cursorAfter: batch.cursorAfter,
    persisted: { threads: batch.threads.length, messages: batch.messages.length },
    errorCode: null,
    receivedAt: 1_700_000_000_001,
  };
}

async function withState(run: (state: WechatRuntimeStateStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-sync-'));
  try {
    await run(new WechatRuntimeStateStore(SCOPE, root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function comment(id: string, input: Partial<WechatComment> = {}): WechatComment {
  return {
    externalId: id,
    postExternalId: 'post-1',
    rootExternalId: id,
    parentExternalId: null,
    participant: { externalId: `user-${id}`, displayName: `User ${id}`, avatarUrl: null },
    contentText: `text-${id}`,
    lifecycle: 'active',
    createdAt: 1_700_000_000_000,
    likeCount: null,
    replies: [],
    ...input,
  };
}

test('wechat sync: batch replay identity is stable across a new trigger request id', () => {
  const base = {
    requestId: 'request-a' as string | null,
    envKey: SCOPE.envKey,
    accountId: SCOPE.accountId,
    platform: 'wechat_channels' as const,
    channel: 'comment' as const,
    scopeExternalId: 'post-1',
    cursorBefore: null,
    cursorAfter: 'cursor-1',
    hasMore: true,
    threads: [],
    messages: [],
  };
  assert.equal(stableBatchId(base), stableBatchId({ ...base, requestId: 'request-recovery' }));
});

test('wechat comment sync: nested hierarchy is flattened and checkpoint advances only after exact ack', async () => {
  await withState(async (state) => {
    const batches: InteractionSyncBatchPayload[] = [];
    const root = comment('root-1', {
      createdAt: 1_699_999_900_000,
      replies: [comment('reply-1', {
        rootExternalId: 'root-1',
        parentExternalId: 'root-1',
        participant: { externalId: SCOPE.accountId, displayName: 'Finder A', avatarUrl: null },
      })],
    });
    const api = {
      listComments: async () => ({ items: [root, root], nextCursor: 'cursor-1', hasMore: false }),
    } as unknown as WechatChannelsApiClient;
    const sync = new WechatCommentSynchronizer({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      api,
      state,
      getSession: () => SESSION,
      getOwnIdentityExternalId: () => SCOPE.accountId,
      publishBatch: async (batch) => {
        batches.push(batch);
        assert.equal((await state.getCheckpoint('comment', 'post-1')).cursor, null);
        return accepted(batch, 'duplicate');
      },
      nowImpl: () => 1_700_000_000_002,
    });

    await sync.sync(request('comment', 'post-1'));

    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].messages.map((message) => message.externalMessageId), ['root-1', 'reply-1']);
    assert.equal(batches[0].messages[1].externalParentId, 'root-1');
    assert.equal(batches[0].messages[1].externalRootId, 'root-1');
    assert.deepEqual(batches[0].messages.map((message) => message.direction), ['inbound', 'outbound']);
    assert.equal(batches[0].threads[0].updatedAt, root.createdAt);
    assert.notEqual(batches[0].threads[0].updatedAt, request('comment', 'post-1').requestedAt);
    assert.equal((await state.getCheckpoint('comment', 'post-1')).cursor, 'cursor-1');
    assert.equal(await state.getThreadSource('comment', 'root-1'), 'post-1');
  });
});

test('wechat comment sync: rejected/mismatched ack and repeated cursor keep the old checkpoint', async () => {
  await withState(async (state) => {
    const api = {
      listComments: async () => ({ items: [comment('root-1')], nextCursor: 'cursor-1', hasMore: false }),
    } as unknown as WechatChannelsApiClient;
    const mismatch = new WechatCommentSynchronizer({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      api,
      state,
      getSession: () => SESSION,
      getOwnIdentityExternalId: () => SCOPE.accountId,
      publishBatch: async (batch) => ({ ...accepted(batch), cursorAfter: 'wrong-cursor' }),
    });
    await assert.rejects(() => mismatch.sync(request('comment', 'post-1')), WechatChannelsError);
    assert.equal((await state.getCheckpoint('comment', 'post-1')).cursor, null);

    const loopingApi = {
      listComments: async () => ({ items: [comment('root-2')], nextCursor: null, hasMore: true }),
    } as unknown as WechatChannelsApiClient;
    let publishes = 0;
    const looping = new WechatCommentSynchronizer({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      api: loopingApi,
      state,
      getSession: () => SESSION,
      getOwnIdentityExternalId: () => SCOPE.accountId,
      publishBatch: async (batch) => {
        publishes++;
        return accepted(batch);
      },
    });
    await assert.rejects(
      () => looping.sync(request('comment', 'post-1')),
      (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed',
    );
    assert.equal(publishes, 0);
    assert.equal((await state.getCheckpoint('comment', 'post-1')).cursor, null);
  });
});

test('wechat comment sync: post and comment pagination are both exhausted with durable checkpoints', async () => {
  await withState(async (state) => {
    const postPages: Record<string, { items: WechatPost[]; nextCursor: string | null; hasMore: boolean }> = {
      first: { items: [{ externalId: 'post-1', title: 'One', coverUrl: null, updatedAt: 1 }], nextCursor: 'posts-2', hasMore: true },
      'posts-2': { items: [{ externalId: 'post-2', title: 'Two', coverUrl: null, updatedAt: 2 }], nextCursor: null, hasMore: false },
    };
    const api = {
      listPosts: async (_session: unknown, cursor: string | null) => postPages[cursor ?? 'first'],
      listComments: async (_session: unknown, postId: string) => ({
        items: [comment(`comment-${postId}`, { postExternalId: postId })],
        nextCursor: null,
        hasMore: false,
      }),
    } as unknown as WechatChannelsApiClient;
    const batches: InteractionSyncBatchPayload[] = [];
    const sync = new WechatCommentSynchronizer({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      api,
      state,
      getSession: () => SESSION,
      getOwnIdentityExternalId: () => SCOPE.accountId,
      publishBatch: async (batch) => {
        batches.push(batch);
        return accepted(batch);
      },
    });

    await sync.sync(request('comment', null));

    assert.deepEqual(batches.map((batch) => batch.scopeExternalId), ['post-1', 'post-2']);
    assert.equal((await state.getCheckpoint('comment', null)).cursor, null);
    assert.ok((await state.getCheckpoint('comment', null)).updatedAt > 0);
  });
});

function dmMessage(id: string, input: Partial<WechatDmMessage> = {}): WechatDmMessage {
  return {
    externalId: id,
    threadExternalId: 'thread-1',
    direction: 'inbound',
    messageType: 'text',
    contentText: `text-${id}`,
    attachmentMeta: null,
    lifecycle: 'active',
    createdAt: 1_700_000_000_000,
    platformType: 'text',
    ...input,
  };
}

test('wechat dm sync: scoped pages use message time and omit an empty unknown-time thread while advancing checkpoint', async () => {
  await withState(async (state) => {
    const batches: InteractionSyncBatchPayload[] = [];
    const api = {
      getDmParticipantInfo: async () => [],
      listDmHistory: async (_session: unknown, _threadId: string, cursor: string | null) => cursor === null
        ? {
            items: [
              dmMessage('scoped-1', { createdAt: 1_699_999_900_100 }),
              dmMessage('scoped-2', { createdAt: 1_699_999_900_200 }),
            ],
            nextCursor: 'scoped-page-2',
            hasMore: true,
          }
        : { items: [], nextCursor: 'scoped-finished', hasMore: false },
    } as unknown as WechatChannelsApiClient;
    const sync = new WechatDmSynchronizer({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      api,
      state,
      getSession: () => SESSION,
      getOwnIdentityExternalId: () => SCOPE.accountId,
      publishBatch: async (batch) => {
        batches.push(batch);
        return accepted(batch);
      },
      nowImpl: () => 1_700_000_000_002,
    });

    await sync.sync(request('dm', 'thread-1'));

    assert.equal(batches[0].threads[0].updatedAt, 1_699_999_900_200);
    assert.notEqual(batches[0].threads[0].updatedAt, request('dm', 'thread-1').requestedAt);
    assert.deepEqual(batches[1].threads, []);
    assert.deepEqual(batches[1].messages, []);
    assert.equal((await state.getCheckpoint('dm', 'thread-1')).cursor, 'scoped-finished');
    assert.equal((await state.getCheckpoint('dm', 'thread-1')).batchId, batches[1].batchId);
  });
});

test('wechat dm sync: global history pagination groups sessions and preserves unknown messages', async () => {
  await withState(async (state) => {
    const sessions: WechatDmSession[] = [{
      externalId: 'thread-1',
      participant: { externalId: 'peer-1', displayName: 'Peer', avatarUrl: null },
      updatedAt: 1_700_000_000_000,
    }];
    const api = {
      listDmUpdates: async (_session: unknown, cursor: string | null) => cursor === null
        ? {
            sessions,
            messages: [dmMessage('m-1'), dmMessage('m-1')],
            nextCursor: 'history-2',
            hasMore: true,
          }
        : {
            sessions,
            messages: [dmMessage('m-2', { messageType: 'unknown', contentText: null, platformType: 'voice_card_v9' })],
            nextCursor: 'incremental-3',
            hasMore: false,
          },
    } as unknown as WechatChannelsApiClient;
    const batches: InteractionSyncBatchPayload[] = [];
    const sync = new WechatDmSynchronizer({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      api,
      state,
      getSession: () => SESSION,
      getOwnIdentityExternalId: () => SCOPE.accountId,
      publishBatch: async (batch) => {
        batches.push(batch);
        return accepted(batch);
      },
    });

    await sync.sync(request('dm', null));

    assert.equal(batches.length, 4);
    assert.deepEqual(batches.flatMap((batch) => batch.messages.map((message) => message.externalMessageId)), ['m-1', 'm-2']);
    assert.equal(batches[2].messages[0].messageType, 'unknown');
    assert.equal(batches[2].messages[0].rawMetaSanitized.platformType, 'voice_card_v9');
    assert.equal(batches[3].scopeExternalId, null);
    assert.deepEqual(batches[3].threads, []);
    assert.deepEqual(batches[3].messages, []);
    assert.equal((await state.getCheckpoint('dm', 'thread-1')).cursor, 'incremental-3');
    assert.equal((await state.getCheckpoint('dm', null)).cursor, 'incremental-3');
    assert.equal((await state.getCheckpoint('dm', null)).batchId, batches[3].batchId);
  });
});

test('wechat dm sync: session-info enriches a history-only participant before the batch is published', async () => {
  await withState(async (state) => {
    const api = {
      listDmUpdates: async () => ({
        sessions: [{
          externalId: 'thread-1',
          participant: { externalId: 'peer-1', displayName: null, avatarUrl: null },
          updatedAt: 1_700_000_000_000,
        }],
        messages: [dmMessage('m-1')],
        nextCursor: null,
        hasMore: false,
      }),
      getDmParticipantInfo: async (_session: unknown, sessionIds: string[]) => {
        assert.deepEqual(sessionIds, ['thread-1']);
        return [{
          sessionExternalId: 'thread-1',
          participant: { externalId: 'peer-1', displayName: '客户昵称', avatarUrl: 'https://example.invalid/avatar' },
        }];
      },
    } as unknown as WechatChannelsApiClient;
    const batches: InteractionSyncBatchPayload[] = [];
    const sync = new WechatDmSynchronizer({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      api,
      state,
      getSession: () => SESSION,
      getOwnIdentityExternalId: () => SCOPE.accountId,
      publishBatch: async (batch) => {
        batches.push(batch);
        return accepted(batch);
      },
    });

    await sync.sync(request('dm', null));

    assert.equal(batches[0].threads[0].participant?.displayName, '客户昵称');
    assert.equal(batches[0].threads[0].participant?.avatarUrl, 'https://example.invalid/avatar');
  });
});

test('wechat dm sync: an observed empty session page publishes a Cloud-visible zero-item checkpoint batch', async () => {
  await withState(async (state) => {
    const api = {
      listDmUpdates: async () => ({ sessions: [], messages: [], nextCursor: 'incremental-1', hasMore: false }),
    } as unknown as WechatChannelsApiClient;
    const batches: InteractionSyncBatchPayload[] = [];
    const sync = new WechatDmSynchronizer({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      api,
      state,
      getSession: () => SESSION,
      getOwnIdentityExternalId: () => SCOPE.accountId,
      publishBatch: async (batch) => {
        batches.push(batch);
        return accepted(batch);
      },
    });

    await sync.sync(request('dm', null));

    assert.equal(batches.length, 1);
    assert.equal(batches[0].scopeExternalId, null);
    assert.deepEqual(batches[0].threads, []);
    assert.deepEqual(batches[0].messages, []);
    assert.equal((await state.getCheckpoint('dm', null)).cursor, 'incremental-1');
    assert.equal((await state.getCheckpoint('dm', null)).batchId, batches[0].batchId);
  });
});
