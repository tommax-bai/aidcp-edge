import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InteractionReplySendPayload, InteractionSyncBatchPayload } from '../../src/comm/protocol.js';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import {
  DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS,
  WECHAT_DEV_UNVERIFIED_WRITE_TOKEN,
  WechatCapabilityState,
  WechatEndpointCircuitBreaker,
  wechatChannelsFeatureFlagsFromEnv,
} from '../../src/wechat-channels/feature-flags.js';
import {
  InteractionProtocolValidationError,
  validateInteractionAuthStatus,
  validateInteractionBrowserControl,
  validateInteractionOffboardAck,
  validateInteractionOffboardCommand,
  validateInteractionOffboardResult,
  validateInteractionReplyReconcile,
  validateInteractionReplyReconcileResult,
  validateInteractionReplyResultAck,
  validateInteractionReplySend,
  validateInteractionSyncBatch,
} from '../../src/wechat-channels/protocol-validation.js';
import { assertWriteProbeGate, WechatChannelsProbeRunner } from '../../src/wechat-channels/probes/black-box-probe.js';
import { WechatRuntimeStateStore } from '../../src/wechat-channels/state-store.js';
import type { WechatSessionMaterial } from '../../src/wechat-channels/types.js';

test('wechat flags: missing Cloud controls keeps every effective capability off', () => {
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

test('wechat flags: the exact dev test token bypasses per-channel write controls and prior probe evidence', () => {
  const parsed = wechatChannelsFeatureFlagsFromEnv({
    AIDCP_WECHAT_UNVERIFIED_WRITE_TEST_MODE: WECHAT_DEV_UNVERIFIED_WRITE_TOKEN,
  });
  assert.equal(parsed.unverifiedWriteTestMode, true);
  assert.equal(wechatChannelsFeatureFlagsFromEnv({
    AIDCP_WECHAT_UNVERIFIED_WRITE_TEST_MODE: '1',
  }).unverifiedWriteTestMode, false);

  const breaker = new WechatEndpointCircuitBreaker();
  const state = new WechatCapabilityState(parsed, breaker);
  state.applyRemoteControls({
    accountId: 'env-a', envKey: 'env-a', version: 1,
    commentsReadEnabled: true, commentsReplyEnabled: false,
    dmReadEnabled: true, dmSendTextEnabled: false, dmSendImageEnabled: false,
  }, { accountId: 'env-a', envKey: 'env-a' });
  state.markProbePassed('commentsRead');
  state.markProbePassed('dmRead');

  assert.deepEqual(state.effective({ authActive: true, identityMatches: true }), {
    commentsRead: true,
    commentsReply: true,
    dmRead: true,
    dmSendText: true,
    dmSendImage: false,
  });
  assert.equal(state.effective({ authActive: false, identityMatches: true }).commentsReply, false);
  assert.equal(state.effective({ authActive: true, identityMatches: false }).dmSendText, false);
  state.applyRemoteControls({
    accountId: 'env-a', envKey: 'env-a', version: 2,
    commentsReadEnabled: false, commentsReplyEnabled: false,
    dmReadEnabled: false, dmSendTextEnabled: false, dmSendImageEnabled: false,
  }, { accountId: 'env-a', envKey: 'env-a' });
  assert.equal(state.effective({ authActive: true, identityMatches: true }).commentsReply, false);
  assert.equal(state.effective({ authActive: true, identityMatches: true }).dmSendText, false);

  state.applyRemoteControls({
    accountId: 'env-a', envKey: 'env-a', version: 3,
    commentsReadEnabled: true, commentsReplyEnabled: false,
    dmReadEnabled: true, dmSendTextEnabled: false, dmSendImageEnabled: false,
  }, { accountId: 'env-a', envKey: 'env-a' });
  breaker.open('commentCreate');
  assert.equal(state.effective({ authActive: true, identityMatches: true }).commentsReply, false);
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
  assert.equal(state.applyRemoteControls({
    accountId: 'env-a', envKey: 'env-a', version: 3,
    commentsReadEnabled: true, commentsReplyEnabled: true,
    dmReadEnabled: true, dmSendTextEnabled: true, dmSendImageEnabled: false,
  }, { accountId: 'env-a', envKey: 'env-a' }), true);
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
  killed.applyRemoteControls({
    accountId: 'env-a', envKey: 'env-a', version: 3,
    commentsReadEnabled: true, commentsReplyEnabled: true,
    dmReadEnabled: true, dmSendTextEnabled: true, dmSendImageEnabled: false,
  }, { accountId: 'env-a', envKey: 'env-a' });
  killed.markProbePassed('commentsRead');
  assert.equal(killed.effective({ authActive: true, identityMatches: true }).commentsRead, false);
});

test('wechat runtime controls: wrong scope and stale versions never change the accepted snapshot', () => {
  const state = new WechatCapabilityState(DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS, new WechatEndpointCircuitBreaker());
  const v4 = {
    accountId: 'env-a', envKey: 'env-a', version: 4,
    commentsReadEnabled: true, commentsReplyEnabled: false,
    dmReadEnabled: false, dmSendTextEnabled: false, dmSendImageEnabled: false as const,
  };
  assert.equal(state.applyRemoteControls(v4, { accountId: 'env-a', envKey: 'env-a' }), true);
  assert.equal(state.applyRemoteControls({ ...v4, accountId: 'env-b', version: 5 }, { accountId: 'env-a', envKey: 'env-a' }), false);
  assert.equal(state.applyRemoteControls({ ...v4, commentsReadEnabled: false, version: 3 }, { accountId: 'env-a', envKey: 'env-a' }), false);
  assert.equal(state.applyRemoteControls({ ...v4, commentsReadEnabled: false }, { accountId: 'env-a', envKey: 'env-a' }), false);
  assert.equal(state.applyRemoteControls({ ...v4, commentsReadEnabled: 'false' } as unknown as typeof v4,
    { accountId: 'env-a', envKey: 'env-a' }), false);
  assert.equal(state.applyRemoteControls(v4, { accountId: 'env-a', envKey: 'env-a' }), true,
    'an identical same-version welcome/update is idempotent');
  assert.deepEqual(state.getRemoteControls(), v4);
  state.resetRemoteControls();
  assert.equal(state.getRemoteControls(), undefined);
});

test('wechat contract validator: strict frozen payloads reject extra fields, scope aliases, images, and unsafe raw values', () => {
  const auth = {
    envKey: 'env-a',
    accountId: 'finder-a',
    platform: 'wechat_channels',
    status: 'active',
    browserState: 'closed',
    capabilities: { commentsRead: true, commentsReply: false, dmRead: true, dmSendText: false, dmSendImage: false },
    runtimeControlsVersion: 4,
    identity: { externalId: 'finder-a', displayName: 'Finder A', identityHash: `sha256:${'a'.repeat(64)}` },
    checkedAt: 1,
    reasonCode: null,
  };
  assert.deepEqual(validateInteractionAuthStatus(auth), auth);
  assert.deepEqual(
    validateInteractionAuthStatus({
      ...auth,
      status: 'reauth_required',
      browserState: 'unavailable',
      reasonCode: 'INTERACTION_BROWSER_PROFILE_IN_USE',
    }),
    {
      ...auth,
      status: 'reauth_required',
      browserState: 'unavailable',
      reasonCode: 'INTERACTION_BROWSER_PROFILE_IN_USE',
    },
  );
  assert.throws(
    () => validateInteractionAuthStatus({ ...auth, reasonCode: 'invented' }),
    InteractionProtocolValidationError,
  );
  assert.throws(
    () => validateInteractionAuthStatus({ ...auth, ownerHint: 'raw-owner@example.com' }),
    InteractionProtocolValidationError,
  );
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

test('wechat contract validator: recovery/offboard payloads are exact and body-free', () => {
  const reply = {
    jobId: 'job-1', attemptId: 'attempt-1', idempotencyKey: 'b'.repeat(64),
    envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels' as const, channel: 'dm' as const,
    target: { threadExternalId: 'thread-1', inboundMessageExternalId: 'm-1', parentExternalId: null },
    content: { type: 'text' as const, text: 'hello' }, expiresAt: 100,
  };
  assert.deepEqual(validateInteractionReplyResultAck({
    jobId: reply.jobId, attemptId: reply.attemptId, idempotencyKey: reply.idempotencyKey,
    envKey: reply.envKey, accountId: reply.accountId, platform: 'wechat_channels',
    status: 'accepted', errorCode: null, receivedAt: 2,
  }).status, 'accepted');
  assert.deepEqual(validateInteractionReplyReconcile({
    reconcileId: 'reconcile-1', envKey: reply.envKey, accountId: reply.accountId, platform: 'wechat_channels',
    attempts: [{ cloudStatus: 'dispatched', command: reply }], requestedAt: 2,
  }).attempts[0].command, reply);
  assert.equal(validateInteractionReplyReconcileResult({
    reconcileId: 'reconcile-1', envKey: reply.envKey, accountId: reply.accountId, platform: 'wechat_channels',
    attempts: [{ jobId: reply.jobId, attemptId: reply.attemptId, idempotencyKey: reply.idempotencyKey,
      state: 'not_found', observedAt: 3 }], finishedAt: 3,
  }).attempts[0].state, 'not_found');
  const command = validateInteractionOffboardCommand({
    offboardId: 'offboard-1', envKey: reply.envKey, accountId: reply.accountId, platform: 'wechat_channels',
    reason: 'environment_unbind', requestedAt: 4, expiresAt: 100,
  });
  assert.equal(command.reason, 'environment_unbind');
  assert.equal(validateInteractionOffboardResult({
    offboardId: command.offboardId, envKey: command.envKey, accountId: command.accountId,
    platform: 'wechat_channels', status: 'cleared', errorCode: null, finishedAt: 5,
  }).status, 'cleared');
  assert.equal(validateInteractionOffboardAck({
    offboardId: command.offboardId, envKey: command.envKey, accountId: command.accountId,
    platform: 'wechat_channels', status: 'duplicate', errorCode: null, receivedAt: 6,
  }).status, 'duplicate');
  assert.throws(() => validateInteractionOffboardCommand({ ...command, credential: 'secret' }),
    InteractionProtocolValidationError);
});

test('wechat contract validator: browser control accepts only exact scope and open/close actions', () => {
  const command = {
    requestId: 'browser-control-1',
    envKey: 'env-a',
    accountId: 'finder-a',
    platform: 'wechat_channels' as const,
    action: 'open' as const,
    requestedAt: 7,
  };
  assert.deepEqual(validateInteractionBrowserControl(command), command);
  assert.throws(
    () => validateInteractionBrowserControl({ ...command, action: 'focus' }),
    InteractionProtocolValidationError,
  );
  assert.throws(
    () => validateInteractionBrowserControl({ ...command, cookie: 'secret' }),
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
  breaker.open('postList');
  breaker.open('commentList');
  const state = new WechatCapabilityState(flags, breaker);
  state.applyRemoteControls({
    accountId: 'env-a', envKey: 'env-a', version: 1,
    commentsReadEnabled: true, commentsReplyEnabled: true,
    dmReadEnabled: true, dmSendTextEnabled: true, dmSendImageEnabled: false,
  }, { accountId: 'env-a', envKey: 'env-a' });
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
    requestContext: { version: 1, aid: 'aid-test', pageUrl: 'https://channels.weixin.qq.com/platform/post/list', commonBody: { logFinderId: 'finder-test', logFinderUin: 'uin-test', rawKeyBuff: 'raw-key-test', pluginSessionId: null, reqScene: 7, scene: 7 }, headers: { fingerprintDeviceId: 'device-test', wechatUin: 'uin-test' } },
  };

  assert.deepEqual(await runner.probeEnabledReads(session), { ok: true });
  assert.equal(breaker.isOpen('postList'), false);
  assert.equal(breaker.isOpen('commentList'), false);
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

test('wechat endpoint breaker expires by TTL and omits expired endpoints from snapshots', () => {
  let now = 100;
  const breaker = new WechatEndpointCircuitBreaker({ ttlMs: 10, nowImpl: () => now });
  breaker.open('postList');
  assert.equal(breaker.isOpen('postList'), true);
  assert.equal(breaker.capabilityAvailable('commentsRead'), false);
  assert.deepEqual(breaker.snapshot(), ['postList']);

  now = 110;
  assert.equal(breaker.isOpen('postList'), false);
  assert.equal(breaker.capabilityAvailable('commentsRead'), true);
  assert.deepEqual(breaker.snapshot(), []);

  breaker.open('commentList');
  breaker.reset();
  assert.deepEqual(breaker.snapshot(), []);
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
