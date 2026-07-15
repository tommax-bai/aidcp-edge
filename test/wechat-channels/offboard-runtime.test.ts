import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EdgeClient } from '../../src/client/edge-client.js';
import {
  makeEnvelope,
  type Envelope,
  type InteractionOffboardAckPayload,
  type InteractionOffboardCommandPayload,
} from '../../src/comm/protocol.js';
import type { WechatAuthCoordinator } from '../../src/wechat-channels/auth-session.js';
import type { CdpWechatChannelsBrowserSidecar } from '../../src/wechat-channels/browser-sidecar.js';
import type { WechatChannelsConnector } from '../../src/wechat-channels/connector.js';
import { handleInteractionCommand } from '../../src/wechat-channels/runtime.js';
import { WechatRuntimeStateStore } from '../../src/wechat-channels/state-store.js';

const now = 1_700_000_000_000;

test('offboard runtime durably claims, drains, clears credentials, closes sidecar and replays until exact ack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-offboard-runtime-'));
  try {
    const state = new WechatRuntimeStateStore({ envKey: 'env-a', accountId: 'finder-a', browserProfileId: 'profile-a' }, root);
    const order: string[] = [];
    let drainEntered!: () => void;
    let releaseDrain!: () => void;
    const entered = new Promise<void>((resolve) => { drainEntered = resolve; });
    const drainBarrier = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const command: InteractionOffboardCommandPayload = {
      offboardId: 'offboard-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
      reason: 'environment_unbind', requestedAt: now, expiresAt: now + 86_400_000,
    };
    const deps = {
      client: { send: () => {} } as unknown as EdgeClient,
      connector: {
        getAuthStatus: () => ({ envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels' }),
        stop: async () => { order.push('stop-and-drain'); drainEntered(); await drainBarrier; },
      } as unknown as WechatChannelsConnector,
      state,
      auth: { clear: async () => { order.push('clear-encrypted-session'); } } as unknown as WechatAuthCoordinator,
      sidecar: { close: async () => { order.push('close-sidecar'); } } as unknown as CdpWechatChannelsBrowserSidecar,
      flushReplyResultOutbox: async () => {},
      flushOffboardResultOutbox: async () => { order.push('flush-durable-result'); },
      offboardFlights: new Map<string, Promise<void>>(),
    };
    const envelope = makeEnvelope('interaction.offboard.command', 'offboard-envelope-1', now, command) as
      Envelope<InteractionOffboardCommandPayload>;
    const first = handleInteractionCommand(deps, envelope);
    await entered;
    const concurrentDuplicate = handleInteractionCommand(deps, envelope);
    releaseDrain();
    await Promise.all([first, concurrentDuplicate]);
    assert.deepEqual(order.slice(0, 3), [
      'stop-and-drain', 'clear-encrypted-session', 'close-sidecar',
    ]);
    assert.equal(order.filter((item) => item === 'flush-durable-result').length, 2);
    assert.equal((await state.pendingOffboardResults()).length, 1);
    await handleInteractionCommand(deps, envelope);
    assert.equal(order.filter((item) => item === 'stop-and-drain').length, 1);
    assert.equal(order.filter((item) => item === 'clear-encrypted-session').length, 1);
    assert.equal(order.filter((item) => item === 'close-sidecar').length, 1,
      'duplicate command must replay without repeating credential deletion');
    await handleInteractionCommand(deps, makeEnvelope('interaction.offboard.ack', 'offboard-result-1', now + 2, {
      offboardId: command.offboardId, envKey: command.envKey, accountId: command.accountId,
      platform: 'wechat_channels', status: 'accepted', errorCode: null, receivedAt: now + 2,
    }) as Envelope<InteractionOffboardAckPayload>);
    assert.deepEqual(await state.pendingOffboardResults(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
