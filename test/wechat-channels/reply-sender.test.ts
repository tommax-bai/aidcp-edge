import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InteractionReplySendPayload } from '../../src/comm/protocol.js';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import type { WechatAuthCoordinator } from '../../src/wechat-channels/auth-session.js';
import { WechatChannelsError } from '../../src/wechat-channels/error-classifier.js';
import { WechatReplySender } from '../../src/wechat-channels/reply-sender.js';
import { WechatRuntimeStateStore } from '../../src/wechat-channels/state-store.js';
import type { WechatSessionMaterial } from '../../src/wechat-channels/types.js';

const SCOPE = { envKey: 'env-a', accountId: 'finder-a', browserProfileId: 'profile-a' };
const SESSION: WechatSessionMaterial = {
  cookies: [{ name: 'session', value: 'secret', domain: '.channels.weixin.qq.com' }],
  userAgent: 'ua',
  acquiredAt: 1,
};
const NOW = 1_700_000_000_000;

function command(channel: 'comment' | 'dm', keyChar = 'a'): InteractionReplySendPayload {
  return {
    jobId: `job-${channel}`,
    attemptId: `attempt-${channel}`,
    idempotencyKey: keyChar.repeat(64),
    envKey: SCOPE.envKey,
    accountId: SCOPE.accountId,
    platform: 'wechat_channels',
    channel,
    target: {
      threadExternalId: channel === 'comment' ? 'comment-root-1' : 'dm-thread-1',
      inboundMessageExternalId: 'inbound-1',
      parentExternalId: channel === 'comment' ? 'comment-root-1' : null,
    },
    content: { type: 'text', text: '谢谢你的留言' },
    expiresAt: NOW + 60_000,
  };
}

function activeAuth(overrides: { verifyIdentity?: () => Promise<boolean>; reasonCode?: 'WECHAT_IDENTITY_MISMATCH' } = {}): WechatAuthCoordinator {
  return {
    verifyIdentity: overrides.verifyIdentity ?? (async () => true),
    getSession: () => SESSION,
    getSnapshot: () => ({
      state: 'api_only_running',
      status: 'active',
      browserState: 'closed',
      reasonCode: overrides.reasonCode ?? null,
      accountId: SCOPE.accountId,
      identity: { externalId: SCOPE.accountId, displayName: 'Finder A' },
      identityMatches: !overrides.reasonCode,
      checkedAt: NOW,
    }),
    markApiFailure: () => {},
  } as unknown as WechatAuthCoordinator;
}

async function withState(run: (state: WechatRuntimeStateStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-reply-'));
  try {
    const state = new WechatRuntimeStateStore(SCOPE, root);
    await state.putThreadSource('comment', 'comment-root-1', 'post-1');
    await run(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sender(
  state: WechatRuntimeStateStore,
  api: WechatChannelsApiClient,
  auth = activeAuth(),
): WechatReplySender {
  return new WechatReplySender({
    envKey: SCOPE.envKey,
    accountId: SCOPE.accountId,
    api,
    auth,
    state,
    getCapabilities: () => ({ commentsRead: true, commentsReply: true, dmRead: true, dmSendText: true, dmSendImage: false }),
    nowImpl: () => NOW,
  });
}

test('wechat reply: platform ack confirms once; duplicate command reuses durable result without another write', async () => {
  await withState(async (state) => {
    let sends = 0;
    const api = {
      sendComment: async (_session: unknown, input: { postExternalId: string; parentExternalId: string; text: string }) => {
        sends++;
        assert.deepEqual(input, {
          postExternalId: 'post-1',
          parentExternalId: 'comment-root-1',
          text: '谢谢你的留言',
        });
        return { accepted: true, externalMessageId: 'reply-1' };
      },
    } as unknown as WechatChannelsApiClient;
    const replies = sender(state, api);
    const first = await replies.send(command('comment'));
    const replay = await replies.send(command('comment'));
    const wrongScopeReplay = await replies.send({ ...command('comment'), envKey: 'other-env' });

    assert.equal(first.status, 'confirmed');
    assert.equal(first.verification, 'platform_ack');
    assert.equal(first.externalMessageId, 'reply-1');
    assert.deepEqual(replay, first);
    assert.equal(wrongScopeReplay.errorCode, 'INTERACTION_SCOPE_MISMATCH');
    assert.equal(sends, 1);
  });
});

test('wechat reply: lost write response is confirmed only by a unique bounded history lookup', async () => {
  await withState(async (state) => {
    let sends = 0;
    let historyReads = 0;
    const api = {
      sendDmText: async () => {
        sends++;
        throw new WechatChannelsError('transient_network', 'dmSendText', 'response lost', true, null, true);
      },
      listDmHistory: async () => {
        historyReads++;
        return {
          items: [{
            externalId: 'dm-reply-1',
            threadExternalId: 'dm-thread-1',
            direction: 'outbound',
            messageType: 'text',
            contentText: '谢谢你的留言',
            attachmentMeta: null,
            lifecycle: 'active',
            createdAt: NOW,
            platformType: 'text',
          }],
          nextCursor: null,
          hasMore: false,
        };
      },
    } as unknown as WechatChannelsApiClient;

    const result = await sender(state, api).send(command('dm'));

    assert.equal(result.status, 'confirmed');
    assert.equal(result.verification, 'history_lookup');
    assert.equal(result.externalMessageId, 'dm-reply-1');
    assert.equal(sends, 1);
    assert.equal(historyReads, 1);
  });
});

test('wechat reply: unresolved timeout stays ambiguous and restart/replay never reissues the platform write', async () => {
  await withState(async (state) => {
    let sends = 0;
    const api = {
      sendDmText: async () => {
        sends++;
        throw new WechatChannelsError('transient_network', 'dmSendText', 'response lost', true, null, true);
      },
      listDmHistory: async () => ({ items: [], nextCursor: null, hasMore: false }),
    } as unknown as WechatChannelsApiClient;
    const firstSender = sender(state, api);
    const first = await firstSender.send(command('dm', 'b'));
    const afterRestart = sender(state, api);
    const replay = await afterRestart.send(command('dm', 'b'));

    assert.equal(first.status, 'ambiguous');
    assert.equal(first.verification, 'not_verified');
    assert.equal(first.errorCode, 'INTERACTION_UPSTREAM_UNAVAILABLE');
    assert.deepEqual(replay, first);
    assert.equal(sends, 1);
  });
});

test('wechat reply: invalid scope, expired command, disabled capability, and identity mismatch fail before write', async () => {
  await withState(async (state) => {
    let sends = 0;
    const api = { sendDmText: async () => { sends++; return { accepted: true, externalMessageId: 'unexpected' }; } } as unknown as WechatChannelsApiClient;

    const badScope = { ...command('dm', 'c'), envKey: 'other-env' };
    assert.equal((await sender(state, api).send(badScope)).errorCode, 'INTERACTION_SCOPE_MISMATCH');

    const expired = { ...command('dm', 'd'), attemptId: 'attempt-expired', expiresAt: NOW };
    assert.equal((await sender(state, api).send(expired)).errorCategory, 'expired_command');

    const disabled = new WechatReplySender({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      api,
      auth: activeAuth(),
      state,
      getCapabilities: () => ({ commentsRead: true, commentsReply: true, dmRead: true, dmSendText: false, dmSendImage: false }),
      nowImpl: () => NOW,
    });
    const disabledCommand = { ...command('dm', 'e'), attemptId: 'attempt-disabled' };
    assert.equal((await disabled.send(disabledCommand)).errorCode, 'INTERACTION_FEATURE_DISABLED');

    const identityCommand = { ...command('dm', 'f'), attemptId: 'attempt-identity' };
    const identityResult = await sender(
      state,
      api,
      activeAuth({ verifyIdentity: async () => false, reasonCode: 'WECHAT_IDENTITY_MISMATCH' }),
    ).send(identityCommand);
    assert.equal(identityResult.errorCode, 'WECHAT_IDENTITY_MISMATCH');
    assert.equal(sends, 0);
  });
});

test('wechat reply: one attempt id cannot be rebound to a different idempotency key', async () => {
  await withState(async (state) => {
    let sends = 0;
    const api = {
      sendDmText: async () => {
        sends++;
        return { accepted: true, externalMessageId: `message-${sends}` };
      },
    } as unknown as WechatChannelsApiClient;
    const replies = sender(state, api);
    const first = command('dm', '1');
    const conflicting = { ...first, idempotencyKey: '2'.repeat(64) };

    assert.equal((await replies.send(first)).status, 'confirmed');
    const conflict = await replies.send(conflicting);
    assert.equal(conflict.status, 'failed');
    assert.equal(conflict.errorCategory, 'invalid_command');
    assert.equal(sends, 1);
  });
});
