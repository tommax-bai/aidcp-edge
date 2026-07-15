import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InteractionReplySendPayload, InteractionSyncBatchPayload } from '../../src/comm/protocol.js';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import {
  DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS,
  WechatCapabilityState,
  WechatEndpointCircuitBreaker,
  wechatChannelsFeatureFlagsFromEnv,
} from '../../src/wechat-channels/feature-flags.js';
import {
  InteractionProtocolValidationError,
  validateInteractionAuthStatus,
  validateInteractionReplySend,
  validateInteractionSyncBatch,
} from '../../src/wechat-channels/protocol-validation.js';
import { assertWriteProbeGate, WechatChannelsProbeRunner } from '../../src/wechat-channels/probes/black-box-probe.js';
import { WechatRuntimeStateStore } from '../../src/wechat-channels/state-store.js';
import type { WechatSessionMaterial } from '../../src/wechat-channels/types.js';

test('wechat flags: every private capability and write gate defaults off', () => {
  assert.deepEqual(wechatChannelsFeatureFlagsFromEnv({}), DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS);
  const state = new WechatCapabilityState(DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS, new WechatEndpointCircuitBreaker());
  state.markProbePassed('commentsRead');
  state.markProbePassed('commentsReply');
  state.markProbePassed('dmRead');
  state.markProbePassed('dmSendText');
  assert.deepEqual(state.effective({ authActive: true, identityMatches: true }), {
    commentsRead: false,
    commentsReply: false,
    dmRead: false,
    dmSendText: false,
    dmSendImage: false,
  });
});

test('wechat flags: build, auth, identity, probes, kill switches, and endpoint breaker all gate effective capability', () => {
  const flags = {
    ...DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS,
    interactionEnabled: true,
    writeEnabled: true,
    accountWriteEnabled: true,
    commentsReadEnabled: true,
    commentsReplyEnabled: true,
    dmReadEnabled: true,
    dmSendTextEnabled: true,
    commentWriteProbeVerified: true,
    dmWriteProbeVerified: true,
  };
  const breaker = new WechatEndpointCircuitBreaker();
  const state = new WechatCapabilityState(flags, breaker);
  for (const capability of ['commentsRead', 'commentsReply', 'dmRead', 'dmSendText'] as const) {
    state.markProbePassed(capability);
  }
  assert.deepEqual(state.effective({ authActive: true, identityMatches: true }), {
    commentsRead: true,
    commentsReply: true,
    dmRead: true,
    dmSendText: true,
    dmSendImage: false,
  });

  breaker.open('dmHistory');
  assert.deepEqual(state.effective({ authActive: true, identityMatches: true }), {
    commentsRead: true,
    commentsReply: true,
    dmRead: false,
    dmSendText: false,
    dmSendImage: false,
  });
  assert.equal(state.effective({ authActive: true, identityMatches: false }).commentsRead, false);

  const killed = new WechatCapabilityState({ ...flags, accountKillSwitch: true }, new WechatEndpointCircuitBreaker());
  killed.markProbePassed('commentsRead');
  assert.equal(killed.effective({ authActive: true, identityMatches: true }).commentsRead, false);
});

test('wechat contract validator: strict frozen payloads reject extra fields, scope aliases, images, and unsafe raw values', () => {
  const auth = {
    envKey: 'env-a',
    accountId: 'finder-a',
    platform: 'wechat_channels',
    status: 'active',
    browserState: 'closed',
    capabilities: { commentsRead: true, commentsReply: false, dmRead: true, dmSendText: false, dmSendImage: false },
    identity: { externalId: 'finder-a', displayName: 'Finder A', identityHash: `sha256:${'a'.repeat(64)}` },
    checkedAt: 1,
    reasonCode: null,
  };
  assert.deepEqual(validateInteractionAuthStatus(auth), auth);
  assert.throws(
    () => validateInteractionAuthStatus({ ...auth, cookie: 'secret' }),
    InteractionProtocolValidationError,
  );
  assert.throws(
    () => validateInteractionAuthStatus({ ...auth, capabilities: { ...auth.capabilities, dmSendImage: true } }),
    InteractionProtocolValidationError,
  );

  const reply: InteractionReplySendPayload = {
    jobId: 'job-1',
    attemptId: 'attempt-1',
    idempotencyKey: 'b'.repeat(64),
    envKey: 'env-a',
    accountId: 'finder-a',
    platform: 'wechat_channels',
    channel: 'dm',
    target: { threadExternalId: 'thread-1', inboundMessageExternalId: 'm-1', parentExternalId: null },
    content: { type: 'text', text: 'hello' },
    expiresAt: 2,
  };
  assert.deepEqual(validateInteractionReplySend(reply), reply);
  assert.throws(
    () => validateInteractionReplySend({ ...reply, platform: 'wechat-channels' }),
    InteractionProtocolValidationError,
  );
  assert.throws(
    () => validateInteractionReplySend({ ...reply, content: { type: 'image', text: 'https://example.invalid/a.jpg' } }),
    InteractionProtocolValidationError,
  );

  const batch: InteractionSyncBatchPayload = {
    batchId: 'batch-1',
    requestId: null,
    envKey: 'env-a',
    accountId: 'finder-a',
    platform: 'wechat_channels',
    channel: 'dm',
    scopeExternalId: 'thread-1',
    cursorBefore: null,
    cursorAfter: null,
    hasMore: false,
    threads: [],
    messages: [{
      externalThreadId: 'thread-1',
      externalMessageId: 'm-1',
      direction: 'inbound',
      externalParentId: null,
      externalRootId: null,
      messageType: 'unknown',
      contentText: null,
      attachmentMeta: null,
      lifecycle: 'active',
      platformCreatedAt: 1,
      rawMetaSanitized: { platformType: 'voice' },
    }],
    observedAt: 1,
  };
  assert.deepEqual(validateInteractionSyncBatch(batch), batch);
  assert.throws(
    () => validateInteractionSyncBatch({
      ...batch,
      messages: [{ ...batch.messages[0], rawMetaSanitized: { cookie: { value: 'secret' } } }],
    }),
    InteractionProtocolValidationError,
  );
});

test('wechat write probes: exact disposable target approval is mandatory and no implicit target is accepted', () => {
  assert.throws(
    () => assertWriteProbeGate({ channel: 'comment', targetExternalId: 'post-1', approval: undefined }),
    /WRITE_PROBE_GATED/,
  );
  assert.throws(
    () => assertWriteProbeGate({ channel: 'comment', targetExternalId: 'post-1', approval: 'approved' }),
    /WRITE_PROBE_GATED/,
  );
  assert.deepEqual(
    assertWriteProbeGate({
      channel: 'comment',
      targetExternalId: 'post-1',
      approval: 'approved-disposable-comment-target:post-1',
    }),
    { targetExternalId: 'post-1' },
  );
});

test('wechat read probes: capabilities open independently while unverified writes remain gated', async () => {
  const flags = {
    ...DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS,
    interactionEnabled: true,
    commentsReadEnabled: true,
    commentsReplyEnabled: true,
    dmReadEnabled: true,
    dmSendTextEnabled: true,
  };
  const breaker = new WechatEndpointCircuitBreaker();
  const state = new WechatCapabilityState(flags, breaker);
  const api = {
    listPosts: async () => ({
      items: [{ externalId: 'post-1', title: null, coverUrl: null, updatedAt: 1 }],
      nextCursor: null,
      hasMore: false,
    }),
    listComments: async () => ({ items: [], nextCursor: null, hasMore: false }),
    listDmSessions: async () => { throw new Error('DM schema unavailable'); },
  } as unknown as WechatChannelsApiClient;
  const runner = new WechatChannelsProbeRunner({ api, flags, capabilityState: state });
  const session: WechatSessionMaterial = {
    cookies: [{ name: 'session', value: 'secret', domain: '.channels.weixin.qq.com' }],
    userAgent: 'ua',
    acquiredAt: 1,
  };

  assert.equal(await runner.probeEnabledReads(session), true);
  assert.deepEqual(state.effective({ authActive: true, identityMatches: true }), {
    commentsRead: true,
    commentsReply: false,
    dmRead: false,
    dmSendText: false,
    dmSendImage: false,
  });
  assert.deepEqual(runner.snapshot().map((result) => [result.capability, result.status]), [
    ['commentsRead', 'passed'],
    ['commentsReply', 'gated'],
    ['dmRead', 'failed'],
  ]);
});

test('wechat runtime state: checkpoints and reply keys are isolated by account as well as environment/profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-state-'));
  try {
    const accountA = new WechatRuntimeStateStore({ envKey: 'env-a', accountId: 'finder-a', browserProfileId: 'profile-a' }, root);
    const accountB = new WechatRuntimeStateStore({ envKey: 'env-a', accountId: 'finder-b', browserProfileId: 'profile-a' }, root);
    await accountA.commitCheckpoint('comment', 'post-1', { cursor: 'cursor-a', batchId: 'batch-a', updatedAt: 1 });
    assert.equal((await accountB.getCheckpoint('comment', 'post-1')).cursor, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
