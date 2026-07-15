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
