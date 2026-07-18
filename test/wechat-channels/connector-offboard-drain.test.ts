import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { InteractionReplySendPayload } from '../../src/comm/protocol.js';
import type { InteractionTransport } from '../../src/platform/interaction-connector.js';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import type { WechatAuthCoordinator } from '../../src/wechat-channels/auth-session.js';
import { WechatChannelsConnector } from '../../src/wechat-channels/connector.js';
import { WechatChannelsError } from '../../src/wechat-channels/error-classifier.js';
import type { WechatCapabilityState } from '../../src/wechat-channels/feature-flags.js';
import { WechatRuntimeStateStore } from '../../src/wechat-channels/state-store.js';

const now = 1_700_000_000_000;

test('offboard drain waits for an in-flight reply and rejects every later platform write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-drain-'));
  try {
    let capabilitiesOn = false;
    let sends = 0;
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const sendEntered = new Promise<void>((resolve) => { entered = resolve; });
    const state = new WechatRuntimeStateStore({ envKey: 'env-a', accountId: 'finder-a', browserProfileId: 'profile-a' }, root);
    const connector = new WechatChannelsConnector({
      envKey: 'env-a',
      accountId: 'finder-a',
      state,
      nowImpl: () => now,
      api: {
        sendDmText: async () => {
          sends++;
          entered();
          await barrier;
          return { accepted: true, externalMessageId: 'reply-1' };
        },
      } as unknown as WechatChannelsApiClient,
      auth: {
        getSnapshot: () => ({ state: 'api_only_running', status: 'active', browserState: 'closed', reasonCode: null,
          accountId: 'finder-a', identity: { externalId: 'finder-a', displayName: 'Finder A' },
          identityMatches: true, checkedAt: now }),
        getSession: () => ({ cookies: [], userAgent: 'ua', acquiredAt: now }),
        verifyIdentity: async () => true,
        markApiFailure: () => {},
        onChange: () => () => {},
      } as unknown as WechatAuthCoordinator,
      capabilities: {
        effective: () => capabilitiesOn
          ? { commentsRead: false, commentsReply: false, dmRead: true, dmSendText: true, dmSendImage: false }
          : { commentsRead: false, commentsReply: false, dmRead: false, dmSendText: false, dmSendImage: false },
      } as unknown as WechatCapabilityState,
      transport: { publishAuthStatus: () => {}, publishSyncBatch: async () => { throw new Error('unused'); } } as InteractionTransport,
      commentSyncIntervalMs: 0,
      dmSyncIntervalMs: 0,
    });
    await connector.start();
    capabilitiesOn = true;
    const command: InteractionReplySendPayload = {
      jobId: 'job-1', attemptId: 'attempt-1', idempotencyKey: 'a'.repeat(64),
      envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels', channel: 'dm',
      target: { threadExternalId: 'thread-1', inboundMessageExternalId: 'message-1', parentExternalId: null },
      content: { type: 'text', text: 'hello' }, expiresAt: now + 60_000,
    };
    const running = connector.send(command);
    await sendEntered;
    let stopped = false;
    const stopping = connector.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, 'stop must drain the already-running platform call');
    release();
    assert.equal((await running).status, 'confirmed');
    await stopping;
    assert.equal(stopped, true);
    const rejected = await connector.send({ ...command, attemptId: 'attempt-2', idempotencyKey: 'b'.repeat(64) });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.errorCode, 'INTERACTION_FEATURE_DISABLED');
    assert.equal(sends, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheduled sync logs only safe endpoint diagnostics for an expired platform session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-safe-log-'));
  try {
    const logs: string[] = [];
    const state = new WechatRuntimeStateStore({
      envKey: 'env-a',
      accountId: 'finder-a',
      browserProfileId: 'profile-a',
    }, root);
    const connector = new WechatChannelsConnector({
      envKey: 'env-a',
      accountId: 'finder-a',
      state,
      nowImpl: () => now,
      api: {
        listPosts: async () => {
          throw new WechatChannelsError(
            'auth_expired',
            'postList',
            'request failed with cookie-top-secret and response-body',
            false,
            null,
            true,
            200,
            300334,
          );
        },
      } as unknown as WechatChannelsApiClient,
      auth: {
        getSnapshot: () => ({
          state: 'api_only_running',
          status: 'active',
          browserState: 'closed',
          reasonCode: null,
          accountId: 'finder-a',
          identity: { externalId: 'finder-a', displayName: 'Finder A' },
          identityMatches: true,
          checkedAt: now,
        }),
        getSession: () => ({ cookies: [], userAgent: 'ua', acquiredAt: now }),
        markApiFailure: () => {},
        onChange: () => () => {},
      } as unknown as WechatAuthCoordinator,
      capabilities: {
        effective: () => ({
          commentsRead: true,
          commentsReply: false,
          dmRead: false,
          dmSendText: false,
          dmSendImage: false,
        }),
      } as unknown as WechatCapabilityState,
      transport: {
        publishAuthStatus: () => {},
        publishSyncBatch: async () => { throw new Error('unused'); },
      } as InteractionTransport,
      commentSyncIntervalMs: 0,
      dmSyncIntervalMs: 0,
      logImpl: (message) => logs.push(message),
    });

    await connector.start();
    await connector.stop();

    assert.ok(logs.some((line) => line.includes(
      'scheduled comment sync stopped safely: code=WECHAT_AUTH_REQUIRED endpoint=postList http_status=200 platform_code=300334',
    )));
    assert.doesNotMatch(logs.join('\n'), /cookie-top-secret|response-body|request failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
