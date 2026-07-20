import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCoreBootstrapSupervisor } = require('../../src/electron/core-bootstrap.cjs');

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test('core bootstrap has its own bounded concurrency and never needs a browser-slot input', async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const supervisor = createCoreBootstrapSupervisor({ concurrency: 2 });
  for (const key of ['a', 'b', 'c', 'd']) {
    supervisor.enqueue({
      key,
      cancelled: () => false,
      start: () => new Promise<boolean>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releases.push(() => { active -= 1; resolve(true); });
      }),
    });
  }
  await flush();
  assert.equal(maxActive, 2);
  releases.shift()?.();
  releases.shift()?.();
  await flush();
  assert.equal(maxActive, 2);
  releases.splice(0).forEach((release) => release());
  await flush();
});

test('core bootstrap retries with jittered exponential backoff and opens a per-env circuit', async () => {
  const timers: Array<{ fn: () => void; delay: number }> = [];
  let clock = 10_000;
  let calls = 0;
  const supervisor = createCoreBootstrapSupervisor({
    concurrency: 1,
    baseBackoffMs: 100,
    maxFailures: 2,
    circuitCooldownMs: 5_000,
    random: () => 0.5,
    now: () => clock,
    setTimer: (fn: () => void, delay: number) => {
      timers.push({ fn, delay });
      return { unref() {} };
    },
    clearTimer: () => undefined,
  });
  supervisor.enqueue({ key: 'a', cancelled: () => false, start: async () => { calls += 1; return false; } });
  await flush();
  assert.equal(timers[0]?.delay, 100);
  timers.shift()?.fn();
  await flush();
  assert.equal(calls, 2);
  assert.equal(timers[0]?.delay, 5_000);
  assert.equal(supervisor.snapshot('a')?.circuitUntil, 15_000);
  clock = 15_000;
  timers.shift()?.fn();
  await flush();
  assert.equal(calls, 3);
});

test('core bootstrap cancellation removes pending retries for only that environment', async () => {
  const timers: Array<{ fn: () => void; delay: number }> = [];
  const supervisor = createCoreBootstrapSupervisor({
    setTimer: (fn: () => void, delay: number) => {
      timers.push({ fn, delay });
      return { unref() {} };
    },
    clearTimer: () => undefined,
  });
  supervisor.enqueue({ key: 'removed', cancelled: () => false, start: async () => false });
  await flush();
  assert.equal(timers.length, 1);
  supervisor.remove('removed');
  assert.equal(supervisor.snapshot('removed'), null);
});
