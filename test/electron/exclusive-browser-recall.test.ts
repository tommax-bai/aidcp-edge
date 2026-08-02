import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExclusiveBrowserRecallCoordinator } = require('../../src/electron/exclusive-browser-recall.cjs') as {
  createExclusiveBrowserRecallCoordinator: (deps: Record<string, unknown>) => {
    recall: (target: Handle | null) => Promise<Record<string, unknown>>;
  };
};

type Handle = { envId: string; name: string; ready?: boolean };

function coordinator(overrides: Record<string, unknown> = {}) {
  const handles: Handle[] = [
    { envId: 'env-a', name: '环境 A', ready: true },
    { envId: 'env-b', name: '环境 B', ready: true },
    { envId: 'env-c', name: '环境 C', ready: true },
    { envId: 'env-offline', name: '离线环境', ready: false },
  ];
  const events: string[] = [];
  const recall = createExclusiveBrowserRecallCoordinator({
    listHandles: () => handles,
    isControllable: (handle: Handle) => handle.ready === true,
    parkBrowser: async (handle: Handle) => { events.push(`park:${handle.envId}`); return { ok: true }; },
    showBrowser: async (handle: Handle) => { events.push(`show:${handle.envId}`); return { ok: true }; },
    idOf: (handle: Handle) => handle.envId,
    labelOf: (handle: Handle) => handle.name,
    ...overrides,
  }).recall;
  return { handles, events, recall };
}

test('exclusive recall parks every other controllable environment before showing the exact target', async () => {
  const { handles, events, recall } = coordinator();
  const result = await recall(handles[1]);
  assert.equal(result.ok, true);
  assert.equal(result.parkFailureCount, 0);
  assert.deepEqual(new Set(events.slice(0, -1)), new Set(['park:env-a', 'park:env-c']));
  assert.equal(events.at(-1), 'show:env-b', 'target show must be the final window operation');
  assert.equal(events.includes('park:env-b'), false, 'target is never parked by its own recall');
  assert.equal(events.includes('park:env-offline'), false, 'offline browsers are not started merely to park');
});

test('exclusive recall preserves target success and reports bounded non-target parking failures', async () => {
  const { handles, events, recall } = coordinator({
    parkBrowser: async (handle: Handle) => {
      events.push(`park:${handle.envId}`);
      return handle.envId === 'env-a' ? { ok: false, error: 'window manager denied move' } : { ok: true };
    },
  });
  const result = await recall(handles[1]);
  assert.equal(result.ok, true);
  assert.equal(result.parkFailureCount, 1);
  assert.deepEqual(result.parkFailures, [{
    envId: 'env-a',
    name: '环境 A',
    error: 'window manager denied move',
  }]);
  assert.equal(events.at(-1), 'show:env-b');
});

test('target show failure is distinct after non-target parking was attempted', async () => {
  const { handles, recall } = coordinator({
    showBrowser: async () => ({ ok: false, error: 'target setBounds failed' }),
  });
  const result = await recall(handles[1]);
  assert.deepEqual(result, {
    ok: false,
    error: 'target setBounds failed',
    otherParkingAttempted: true,
  });
});

test('rapid recalls serialize and the latest target wins without a stale renderer result', async () => {
  let releaseFirstShow: () => void = () => undefined;
  let firstShowStarted: () => void = () => undefined;
  const firstShowGate = new Promise<void>((resolve) => { releaseFirstShow = resolve; });
  const firstShowStartedGate = new Promise<void>((resolve) => { firstShowStarted = resolve; });
  const events: string[] = [];
  const { handles, recall } = coordinator({
    parkBrowser: async (handle: Handle) => { events.push(`park:${handle.envId}`); return { ok: true }; },
    showBrowser: async (handle: Handle) => {
      events.push(`show:${handle.envId}`);
      if (handle.envId === 'env-a') {
        firstShowStarted();
        await firstShowGate;
      }
      return { ok: true };
    },
  });

  const first = recall(handles[0]);
  await firstShowStartedGate;
  const second = recall(handles[1]);
  releaseFirstShow();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, { ok: false, superseded: true });
  assert.equal(secondResult.ok, true);
  assert.deepEqual(events.filter((event) => event.startsWith('show:')), ['show:env-a', 'show:env-b']);
  assert.equal(events.at(-1), 'show:env-b', 'serialized latest recall must establish the final layout');
});

test('uncontrollable target fails before any other browser is moved', async () => {
  const { handles, events, recall } = coordinator();
  const result = await recall(handles[3]);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /浏览器尚未就绪/);
  assert.deepEqual(events, []);
});
