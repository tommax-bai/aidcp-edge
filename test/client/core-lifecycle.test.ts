import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoreLifecycleController, parseCoreLifecycleCommand } from '../../src/client/core-lifecycle.js';

function harness() {
  let deactivations = 0;
  let browserCloses = 0;
  let pausedAcks = 0;
  const exits: number[] = [];
  const logs: string[] = [];
  const controller = new CoreLifecycleController({
    deactivate: async () => { deactivations++; },
    closeOwnedBrowser: async () => { browserCloses++; return true; },
    exit: (code) => { exits.push(code); },
    onPaused: () => { pausedAcks++; },
    logger: (message) => { logs.push(message); },
  });
  return {
    controller,
    get deactivations() { return deactivations; },
    get browserCloses() { return browserCloses; },
    get pausedAcks() { return pausedAcks; },
    exits,
    logs,
  };
}

test('core lifecycle parser accepts only local pause/resume/close messages', () => {
  assert.equal(parseCoreLifecycleCommand({ type: 'lifecycle.pause' }), 'pause');
  assert.equal(parseCoreLifecycleCommand({ type: 'lifecycle.resume' }), 'resume');
  assert.equal(parseCoreLifecycleCommand({ type: 'lifecycle.close' }), 'close');
  assert.equal(parseCoreLifecycleCommand({ type: 'persona.generate' }), null);
  assert.equal(parseCoreLifecycleCommand('lifecycle.pause'), null);
});

test('pause deactivates once, acknowledges pause, and never closes or exits', async () => {
  const h = harness();
  await h.controller.request('pause');
  await h.controller.request('pause');
  assert.equal(h.controller.state, 'paused');
  assert.equal(h.deactivations, 1);
  assert.equal(h.browserCloses, 0);
  assert.equal(h.pausedAcks, 2);
  assert.deepEqual(h.exits, []);
});

test('explicit close after pause reuses deactivation then closes and exits', async () => {
  const h = harness();
  await h.controller.request('pause');
  await h.controller.request('close');
  assert.equal(h.deactivations, 1);
  assert.equal(h.browserCloses, 1);
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.controller.state, 'finished');
});

test('resume after pause exits without closing the retained browser', async () => {
  const h = harness();
  await h.controller.request('pause');
  await h.controller.request('resume');
  assert.equal(h.deactivations, 1);
  assert.equal(h.browserCloses, 0);
  assert.deepEqual(h.exits, [0]);
});

test('terminal shutdown still closes the browser and preserves exit code', async () => {
  const h = harness();
  await h.controller.shutdown({ exitCode: 75, reason: 'cdp_unrecoverable', preserveBrowser: false });
  assert.equal(h.deactivations, 1);
  assert.equal(h.browserCloses, 1);
  assert.deepEqual(h.exits, [75]);
});

test('explicit close without confirmation stays paused and does not claim exit', async () => {
  let closeFailed = 0;
  const exits: number[] = [];
  const controller = new CoreLifecycleController({
    deactivate: async () => undefined,
    closeOwnedBrowser: async () => false,
    exit: (code) => { exits.push(code); },
    onCloseFailed: () => { closeFailed++; },
  });
  await controller.request('close');
  assert.equal(controller.state, 'paused');
  assert.equal(closeFailed, 1);
  assert.deepEqual(exits, []);
});

test('rapid pause then close is serialized and cannot double-deactivate', async () => {
  const h = harness();
  await Promise.all([h.controller.request('pause'), h.controller.request('close')]);
  assert.equal(h.deactivations, 1);
  assert.equal(h.browserCloses, 1);
  assert.deepEqual(h.exits, [0]);
});
