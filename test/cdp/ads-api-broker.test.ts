import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProcessAdsPowerApiBroker,
  type AdsPowerBrokerChannel,
} from '../../src/cdp/ads-api-broker.js';

class FakeBrokerChannel extends EventEmitter {
  connected = true;
  sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }

}

test('process AdsPower broker sends a bounded batch and resolves only its correlated response', async () => {
  const channel = new FakeBrokerChannel();
  const broker = createProcessAdsPowerApiBroker(channel as unknown as AdsPowerBrokerChannel, 1000);
  const pending = broker.request([
    {
      version: 'v1',
      method: 'POST',
      path: 'user/update',
      body: { user_id: 'k1', user_proxy_config: { proxy_password: 'private' } },
    },
    {
      version: 'v1',
      method: 'GET',
      path: 'user/list',
      query: { user_id: 'k1', page: '1', page_size: '10' },
    },
  ]);
  const request = channel.sent[0] as { type: string; requestId: string; operations: unknown[] };
  assert.equal(request.type, 'ads-api.request');
  assert.equal(request.operations.length, 2);

  channel.emit('message', { type: 'ads-api.response', requestId: 'other', ok: true, responses: [] });
  channel.emit('message', {
    type: 'ads-api.response',
    requestId: request.requestId,
    ok: true,
    responses: [
      { status: 200, body: { code: 0 } },
      { status: 200, body: { code: 0, data: { list: [] } } },
    ],
  });
  assert.deepEqual(await pending, [
    { status: 200, body: { code: 0 } },
    { status: 200, body: { code: 0, data: { list: [] } } },
  ]);
  assert.equal(channel.listenerCount('message'), 0);
});

test('process AdsPower broker exposes only stable parent rejection reasons', async () => {
  const channel = new FakeBrokerChannel();
  const broker = createProcessAdsPowerApiBroker(channel as unknown as AdsPowerBrokerChannel, 1000);
  const pending = broker.request([
    { version: 'v2', method: 'GET', path: 'browser-profile/active', query: { profile_id: 'k1' } },
  ]);
  const request = channel.sent[0] as { requestId: string };
  channel.emit('message', {
    type: 'ads-api.response',
    requestId: request.requestId,
    ok: false,
    reason: 'password=should-not-cross',
  });
  await assert.rejects(pending, /broker_rejected/);
});

test('process AdsPower broker rejects oversized batches before IPC', async () => {
  const channel = new FakeBrokerChannel();
  const broker = createProcessAdsPowerApiBroker(channel as unknown as AdsPowerBrokerChannel, 1000);
  const operation = {
    version: 'v2' as const,
    method: 'GET' as const,
    path: 'browser-profile/active',
    query: { profile_id: 'k1' },
  };
  await assert.rejects(broker.request([operation, operation, operation]), /batch size invalid/);
  assert.equal(channel.sent.length, 0);
});
