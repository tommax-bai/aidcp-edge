import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProcessFacebookTotpBroker,
  type FacebookTotpBrokerChannel,
} from '../../src/cdp/facebook-totp-broker.js';

class FakeTotpChannel extends EventEmitter {
  connected = true;
  sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }
}

test('Facebook TOTP broker sends only server epoch and resolves the correlated projected value', async () => {
  const channel = new FakeTotpChannel();
  const broker = createProcessFacebookTotpBroker(
    channel as unknown as FacebookTotpBrokerChannel,
    1000,
  );
  const pending = broker.request(1_770_000_001_000);
  const request = channel.sent[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(request).sort(), ['requestId', 'serverEpochMs', 'type']);
  assert.equal(request.type, 'facebook-totp.request');
  assert.equal(request.serverEpochMs, 1_770_000_001_000);
  assert.equal(Object.hasOwn(request, 'profileId'), false);
  assert.equal(Object.hasOwn(request, 'profile_id'), false);

  channel.emit('message', {
    type: 'facebook-totp.response',
    requestId: 'other',
    ok: true,
    code: '111111',
    windowStartMs: 1_770_000_000_000,
    windowEndMs: 1_770_000_030_000,
  });
  channel.emit('message', {
    type: 'facebook-totp.response',
    requestId: request.requestId,
    ok: true,
    code: '287082',
    windowStartMs: 1_770_000_000_000,
    windowEndMs: 1_770_000_030_000,
  });
  assert.deepEqual(await pending, {
    code: '287082',
    windowStartMs: 1_770_000_000_000,
    windowEndMs: 1_770_000_030_000,
  });
  assert.equal(channel.listenerCount('message'), 0);
});

test('Facebook TOTP broker rejects malformed server time before IPC', async () => {
  const channel = new FakeTotpChannel();
  const broker = createProcessFacebookTotpBroker(
    channel as unknown as FacebookTotpBrokerChannel,
    1000,
  );
  await assert.rejects(broker.request(Number.NaN), /request invalid/);
  await assert.rejects(broker.request(1.5), /request invalid/);
  await assert.rejects(broker.request(-1), /request invalid/);
  assert.equal(channel.sent.length, 0);
});

test('Facebook TOTP broker exposes only stable parent failure reasons', async () => {
  const channel = new FakeTotpChannel();
  const broker = createProcessFacebookTotpBroker(
    channel as unknown as FacebookTotpBrokerChannel,
    1000,
  );
  const pending = broker.request(1_770_000_001_000);
  const request = channel.sent[0] as { requestId: string };
  channel.emit('message', {
    type: 'facebook-totp.response',
    requestId: request.requestId,
    ok: false,
    reason: 'password=should-not-cross fakey=secret',
  });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /totp_broker_rejected/);
    assert.doesNotMatch(error.message, /password|fakey|secret/);
    return true;
  });
});

test('Facebook TOTP broker rejects success responses with extra raw credential fields', async () => {
  const channel = new FakeTotpChannel();
  const broker = createProcessFacebookTotpBroker(
    channel as unknown as FacebookTotpBrokerChannel,
    1000,
  );
  const pending = broker.request(1_770_000_001_000);
  const request = channel.sent[0] as { requestId: string };
  channel.emit('message', {
    type: 'facebook-totp.response',
    requestId: request.requestId,
    ok: true,
    code: '287082',
    windowStartMs: 1_770_000_000_000,
    windowEndMs: 1_770_000_030_000,
    password: 'must-not-cross-password',
    fakey: 'must-not-cross-key',
    cookie: 'must-not-cross-cookie',
  });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, '[aidcp-edge] Facebook TOTP broker response invalid');
    return true;
  });
});
