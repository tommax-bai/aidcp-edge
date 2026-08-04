import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverLifecycleIpcAcknowledged } from '../../src/client/runtime-posture.js';

test('acknowledged lifecycle IPC resolves only after the send callback succeeds', async () => {
  const sent: Record<string, unknown>[] = [];
  let acknowledge!: (error: Error | null) => void;
  const delivery = deliverLifecycleIpcAcknowledged({
    connected: true,
    send: (payload: Record<string, unknown>, callback?: (error: Error | null) => void) => {
      sent.push(payload);
      acknowledge = callback!;
    },
  }, { type: 'lifecycle.browser_closed' });

  let settled = false;
  void delivery.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  acknowledge(null);
  assert.equal(await delivery, true);
  assert.deepEqual(sent, [{ type: 'lifecycle.browser_closed' }]);
});

test('acknowledged lifecycle IPC fails closed when the channel rejects or is unavailable', async () => {
  assert.equal(await deliverLifecycleIpcAcknowledged({ connected: false }, { type: 'x' }), false);
  assert.equal(await deliverLifecycleIpcAcknowledged({
    connected: true,
    send: (_payload: Record<string, unknown>, callback?: (error: Error | null) => void) => {
      callback?.(new Error('closed'));
    },
  }, { type: 'x' }), false);
});
