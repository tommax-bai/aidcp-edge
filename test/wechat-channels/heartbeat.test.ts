import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  InteractionSyncAckPayload,
  InteractionSyncBatchPayload,
  InteractionSyncRequestPayload,
} from '../../src/comm/protocol.js';
import type { InteractionTransport } from '../../src/platform/interaction-connector.js';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import type { WechatAuthCoordinator } from '../../src/wechat-channels/auth-session.js';
import { WechatChannelsConnector } from '../../src/wechat-channels/connector.js';
import type { WechatCapabilityState } from '../../src/wechat-channels/feature-flags.js';
import { WechatRuntimeStateStore } from '../../src/wechat-channels/state-store.js';

const HEARTBEAT_LINE = '[wechat-channels] api-sync heartbeat';
const T0 = 1_700_000_000_000;
const SCOPE = { envKey: 'env-a', accountId: 'finder-a', browserProfileId: 'profile-a' } as const;

// A matched ack for whatever batch the connector published — the checkpoint batch an idle dm tick
// emits (empty threads/messages, cursor unchanged). This is the proven Cloud round-trip the beat rides.
function accepted(batch: InteractionSyncBatchPayload): InteractionSyncAckPayload {
  return {
    batchId: batch.batchId,
    envKey: batch.envKey,
    accountId: batch.accountId,
    platform: 'wechat_channels',
    channel: batch.channel,
    scopeExternalId: batch.scopeExternalId,
    status: 'accepted',
    cursorAfter: batch.cursorAfter,
    persisted: { threads: batch.threads.length, messages: batch.messages.length },
    errorCode: null,
    receivedAt: batch.observedAt,
  };
}

function dmRequest(): InteractionSyncRequestPayload {
  return {
    requestId: 'req-dm',
    envKey: SCOPE.envKey,
    accountId: SCOPE.accountId,
    platform: 'wechat_channels',
    channel: 'dm',
    scopeExternalId: null,
    reason: 'user_requested',
    requestedAt: T0,
  };
}

// getSnapshot shape the connector reads for identity + capabilities gating.
function authStub(): WechatAuthCoordinator {
  return {
    getSnapshot: () => ({
      state: 'api_only_running', status: 'active', browserState: 'closed', reasonCode: null,
      accountId: SCOPE.accountId, identity: { externalId: SCOPE.accountId, displayName: 'Finder A' },
      identityMatches: true, checkedAt: T0,
    }),
    getSession: () => ({ cookies: [], userAgent: 'ua', acquiredAt: T0 }),
    markApiFailure: () => {},
    onChange: () => () => {},
  } as unknown as WechatAuthCoordinator;
}

function dmOnlyCapabilities(): WechatCapabilityState {
  return {
    effective: () => ({ commentsRead: false, commentsReply: false, dmRead: true, dmSendText: false, dmSendImage: false }),
  } as unknown as WechatCapabilityState;
}

async function withConnector(
  run: (ctx: {
    connector: WechatChannelsConnector;
    logs: string[];
    setClock: (ms: number) => void;
    beats: () => number;
  }) => Promise<void>,
  opts: { publishSyncBatch?: InteractionTransport['publishSyncBatch'] } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-heartbeat-'));
  try {
    let clock = T0;
    const logs: string[] = [];
    const state = new WechatRuntimeStateStore(SCOPE, root);
    const connector = new WechatChannelsConnector({
      envKey: SCOPE.envKey,
      accountId: SCOPE.accountId,
      state,
      nowImpl: () => clock,
      logImpl: (message) => logs.push(message),
      // Idle dm tick: one page, no sessions/messages, no more pages -> exactly one checkpoint publish.
      api: {
        listDmUpdates: async () => ({ sessions: [], messages: [], nextCursor: null, hasMore: false }),
      } as unknown as WechatChannelsApiClient,
      auth: authStub(),
      capabilities: dmOnlyCapabilities(),
      transport: {
        publishAuthStatus: () => {},
        publishSyncBatch: opts.publishSyncBatch ?? (async (batch) => accepted(batch)),
      } as InteractionTransport,
      // No repeating timers: start() still runs one scheduled comment+dm pass, which is all we drive.
      commentSyncIntervalMs: 0,
      dmSyncIntervalMs: 0,
    });
    await run({
      connector,
      logs,
      setClock: (ms) => { clock = ms; },
      beats: () => logs.filter((line) => line === HEARTBEAT_LINE).length,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('api-sync heartbeat: a proven Cloud round-trip beats once, throttled well under the stale window', async () => {
  await withConnector(async ({ connector, setClock, beats }) => {
    // start() runs the initial scheduled dm sync -> idle checkpoint publish -> matched ack -> first beat.
    await connector.start();
    assert.equal(beats(), 1, 'first proven round-trip must beat immediately');

    // A second round-trip 30s later is inside the throttle window -> no extra beat.
    setClock(T0 + 30_000);
    await connector.sync(dmRequest());
    assert.equal(beats(), 1, 'a round-trip inside the throttle window must not add a beat');

    // Past the throttle interval (60s) the next round-trip beats again — cadence stays far under the
    // renderer's 5-minute stale threshold, so the fleet projection never goes stale while alive.
    setClock(T0 + 61_000);
    await connector.sync(dmRequest());
    assert.equal(beats(), 2, 'a round-trip past the throttle window must beat again');

    await connector.stop();
  });
});

test('api-sync heartbeat: a failed Cloud round-trip (half-open link) does NOT beat', async () => {
  // The batch ack times out / never returns: publishBatch throws before emitHeartbeat, so no beat is
  // logged. This is the honesty backstop — a link that cannot round-trip must not read as alive.
  await withConnector(async ({ connector, logs, beats }) => {
    await connector.start();
    assert.equal(beats(), 0, 'no matched ack -> no liveness beat');
    // The failure still surfaces as the safe scheduled-sync diagnostic, keeping the path observable.
    assert.ok(logs.some((line) => line.includes('scheduled dm sync stopped safely')));
    await connector.stop();
  }, { publishSyncBatch: async () => { throw new Error('cloud ack timeout'); } });
});
