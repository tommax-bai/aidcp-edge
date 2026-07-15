import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  InteractionOffboardCommandPayload,
  InteractionReplyResultPayload,
  InteractionReplySendPayload,
} from '../../src/comm/protocol.js';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import type { WechatAuthCoordinator } from '../../src/wechat-channels/auth-session.js';
import { WechatChannelsError } from '../../src/wechat-channels/error-classifier.js';
import { runtimeStatePath } from '../../src/wechat-channels/local-paths.js';
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

function ambiguousResultFor(pending: InteractionReplySendPayload): InteractionReplyResultPayload {
  return {
    jobId: pending.jobId,
    attemptId: pending.attemptId,
    idempotencyKey: pending.idempotencyKey,
    envKey: pending.envKey,
    accountId: pending.accountId,
    platform: 'wechat_channels',
    channel: pending.channel,
    status: 'ambiguous',
    externalMessageId: null,
    errorCategory: 'transient_network',
    errorCode: 'INTERACTION_UPSTREAM_UNAVAILABLE',
    verification: 'not_verified',
    retryAfterMs: null,
    finishedAt: NOW,
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

async function withState(run: (state: WechatRuntimeStateStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-reply-'));
  try {
    const state = new WechatRuntimeStateStore(SCOPE, root);
    await state.putThreadSource('comment', 'comment-root-1', 'post-1');
    await run(state, root);
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

test('wechat reply: durable result outbox survives restart and clears only on an exact accepted Cloud ack', async () => {
  await withState(async (state, root) => {
    const api = { sendDmText: async () => ({ accepted: true, externalMessageId: 'reply-outbox-1' }) } as unknown as WechatChannelsApiClient;
    const result = await sender(state, api).send(command('dm', '7'));
    const restarted = new WechatRuntimeStateStore(SCOPE, root);
    assert.deepEqual(await restarted.pendingReplyResults(), [result]);
    assert.equal(await restarted.acknowledgeReplyResult({
      jobId: result.jobId, attemptId: result.attemptId, idempotencyKey: result.idempotencyKey,
      envKey: result.envKey, accountId: 'foreign-account', platform: 'wechat_channels',
      status: 'accepted', errorCode: null, receivedAt: NOW,
    }), false);
    assert.equal((await restarted.pendingReplyResults()).length, 1);
    assert.equal(await restarted.acknowledgeReplyResult({
      jobId: result.jobId, attemptId: result.attemptId, idempotencyKey: result.idempotencyKey,
      envKey: result.envKey, accountId: result.accountId, platform: 'wechat_channels',
      status: 'rejected', errorCode: 'INTERACTION_STATE_CONFLICT', receivedAt: NOW,
    }), false);
    assert.equal(await restarted.acknowledgeReplyResult({
      jobId: result.jobId, attemptId: result.attemptId, idempotencyKey: result.idempotencyKey,
      envKey: result.envKey, accountId: result.accountId, platform: 'wechat_channels',
      status: 'accepted', errorCode: null, receivedAt: NOW,
    }), true);
    assert.deepEqual(await restarted.pendingReplyResults(), []);
  });
});

test('wechat reply: reconciliation never turns a missing or merely claimed attempt into a platform write', async () => {
  await withState(async (state) => {
    let sends = 0;
    const api = { sendDmText: async () => { sends++; return { accepted: true, externalMessageId: 'must-not-send' }; } } as unknown as WechatChannelsApiClient;
    const replies = sender(state, api);
    const missing = command('dm', '3');
    assert.equal(await replies.reconcile(missing), 'not_found');
    await state.claimReplyExecution(missing.idempotencyKey, missing.attemptId, NOW);
    assert.equal(await replies.reconcile(missing), 'result_replayed');
    const pending = await state.pendingReplyResults();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'failed');
    assert.equal(sends, 0);
  });
});

test('wechat offboard: cleanup result is durable and duplicate command is replayed until exact Cloud ack', async () => {
  await withState(async (state, root) => {
    const command: InteractionOffboardCommandPayload = {
      offboardId: 'offboard-1', envKey: SCOPE.envKey, accountId: SCOPE.accountId,
      platform: 'wechat_channels', reason: 'environment_unbind', requestedAt: NOW, expiresAt: NOW + 86_400_000,
    };
    assert.deepEqual(await state.claimOffboard(command, NOW), { status: 'claimed' });
    const result = { offboardId: command.offboardId, envKey: command.envKey, accountId: command.accountId,
      platform: 'wechat_channels' as const, status: 'cleared' as const, errorCode: null, finishedAt: NOW };
    await state.completeOffboard(command, result, NOW);
    const restarted = new WechatRuntimeStateStore(SCOPE, root);
    assert.deepEqual(await restarted.pendingOffboardResults(), [result]);
    assert.equal((await restarted.claimOffboard(command, NOW)).status, 'completed');
    assert.equal(await restarted.acknowledgeOffboard({ offboardId: result.offboardId, envKey: result.envKey,
      accountId: result.accountId, platform: 'wechat_channels', status: 'accepted', errorCode: null,
      receivedAt: NOW }), true);
    assert.deepEqual(await restarted.pendingOffboardResults(), []);
    assert.equal(await restarted.isOffboarded(), true);
  });
});

test('wechat reply: concurrent duplicate commands share one in-process platform send', async () => {
  await withState(async (state) => {
    let sends = 0;
    let verifications = 0;
    let releaseVerification!: () => void;
    let firstVerificationEntered!: () => void;
    const verificationBarrier = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const entered = new Promise<void>((resolve) => { firstVerificationEntered = resolve; });
    const api = {
      sendDmText: async () => {
        sends++;
        return { accepted: true, externalMessageId: `mock-${sends}` };
      },
    } as unknown as WechatChannelsApiClient;
    const auth = activeAuth({
      verifyIdentity: async () => {
        verifications++;
        firstVerificationEntered();
        await verificationBarrier;
        return true;
      },
    });
    const firstSender = sender(state, api, auth);
    const secondSender = sender(state, api, auth);
    const duplicate = command('dm', '0');

    const first = firstSender.send(duplicate);
    const second = secondSender.send(duplicate);
    await entered;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(verifications, 1, 'the duplicate must join before pre-send verification');
    releaseVerification();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(firstResult.externalMessageId, 'mock-1');
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

test('wechat reply: durable executing state reconciles after restart and never reissues the platform write', async () => {
  await withState(async (state, root) => {
    const pending = command('dm', '9');
    const executingResult = ambiguousResultFor(pending);
    assert.deepEqual(
      await state.claimReplyExecution(pending.idempotencyKey, pending.attemptId, NOW),
      { status: 'claimed' },
    );
    assert.equal(
      (await state.markReplyExecuting(pending.idempotencyKey, pending.attemptId, executingResult, NOW)).status,
      'started',
    );

    let sends = 0;
    let historyReads = 0;
    const api = {
      sendDmText: async () => {
        sends++;
        return { accepted: true, externalMessageId: 'must-not-send' };
      },
      listDmHistory: async () => {
        historyReads++;
        return { items: [], nextCursor: null, hasMore: false };
      },
    } as unknown as WechatChannelsApiClient;
    const restartedState = new WechatRuntimeStateStore(SCOPE, root);
    const recovered = await sender(restartedState, api).send(pending);

    assert.equal(recovered.status, 'ambiguous');
    assert.equal(recovered.verification, 'not_verified');
    assert.equal(historyReads, 1);
    assert.equal(sends, 0);
  });
});

test('wechat reply: version-1 completed records migrate without replaying the platform write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-reply-v1-'));
  try {
    const pending = command('dm', '5');
    const result = ambiguousResultFor(pending);
    const path = runtimeStatePath(root, SCOPE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      version: 1,
      checkpoints: {},
      replies: {
        [pending.idempotencyKey]: { attemptId: pending.attemptId, result, updatedAt: NOW },
      },
      attempts: { [pending.attemptId]: pending.idempotencyKey },
      threadSources: {},
    })}\n`, 'utf8');
    let sends = 0;
    const api = {
      sendDmText: async () => {
        sends++;
        return { accepted: true, externalMessageId: 'must-not-send' };
      },
    } as unknown as WechatChannelsApiClient;

    const replay = await sender(new WechatRuntimeStateStore(SCOPE, root), api).send(pending);

    assert.deepEqual(replay, result);
    assert.equal(sends, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wechat reply: durable claimed state can resume once because no platform write was admitted', async () => {
  await withState(async (state, root) => {
    const pending = command('dm', '8');
    assert.deepEqual(
      await state.claimReplyExecution(pending.idempotencyKey, pending.attemptId, NOW),
      { status: 'claimed' },
    );
    let sends = 0;
    const api = {
      sendDmText: async () => {
        sends++;
        return { accepted: true, externalMessageId: 'resumed-1' };
      },
    } as unknown as WechatChannelsApiClient;
    const restartedState = new WechatRuntimeStateStore(SCOPE, root);

    const recovered = await sender(restartedState, api).send(pending);

    assert.equal(recovered.status, 'confirmed');
    assert.equal(recovered.externalMessageId, 'resumed-1');
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

test('wechat reply: concurrent keys bind one attempt atomically before either platform write', async () => {
  await withState(async (state) => {
    let sends = 0;
    let releaseVerification!: () => void;
    let verificationEntered!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const entered = new Promise<void>((resolve) => { verificationEntered = resolve; });
    const api = {
      sendDmText: async () => {
        sends++;
        return { accepted: true, externalMessageId: `message-${sends}` };
      },
    } as unknown as WechatChannelsApiClient;
    const replies = sender(state, api, activeAuth({
      verifyIdentity: async () => {
        verificationEntered();
        await barrier;
        return true;
      },
    }));
    const first = command('dm', '6');
    const conflicting = { ...first, idempotencyKey: '7'.repeat(64) };

    const firstResult = replies.send(first);
    await entered;
    const conflictResult = await replies.send(conflicting);
    assert.equal(conflictResult.status, 'failed');
    assert.equal(conflictResult.errorCategory, 'invalid_command');
    releaseVerification();
    assert.equal((await firstResult).status, 'confirmed');
    assert.equal(sends, 1);
  });
});
