import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WECHAT_CONTROL_PLANE_HEARTBEAT_LINE,
  WechatControlPlaneHeartbeat,
} from '../../src/wechat-channels/control-plane-heartbeat.js';

type IntervalTimer = ReturnType<typeof setInterval>;

class FakeIntervals {
  callback?: () => void;
  cleared = 0;

  readonly setInterval = (callback: () => void): IntervalTimer => {
    this.callback = callback;
    return { unref() {} } as unknown as IntervalTimer;
  };

  readonly clearInterval = (): void => {
    this.cleared += 1;
    this.callback = undefined;
  };
}

test('control-plane heartbeat logs only after a matching pong and stops with runtime lifecycle', async () => {
  const timers = new FakeIntervals();
  const logs: string[] = [];
  let probes = 0;
  const heartbeat = new WechatControlPlaneHeartbeat({
    probe: async () => { probes += 1; return { type: 'pong' }; },
    logImpl: (line) => logs.push(line),
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });

  heartbeat.start();
  heartbeat.start();
  assert.ok(timers.callback, 'start must arm one periodic probe');
  await heartbeat.probeNow();
  assert.equal(probes, 1);
  assert.deepEqual(logs, [WECHAT_CONTROL_PLANE_HEARTBEAT_LINE]);

  heartbeat.stop();
  assert.equal(timers.cleared, 1);
  await heartbeat.probeNow();
  assert.equal(probes, 1, 'stopped heartbeat must not probe');
});

test('control-plane heartbeat stays silent for rejection and non-pong responses', async () => {
  const logs: string[] = [];
  const responses: Array<() => Promise<{ type: string }>> = [
    async () => { throw new Error('cloud unavailable with secret=must-not-log'); },
    async () => ({ type: 'error' }),
  ];
  const heartbeat = new WechatControlPlaneHeartbeat({
    probe: () => responses.shift()!(),
    logImpl: (line) => logs.push(line),
  });

  heartbeat.start();
  await heartbeat.probeNow();
  await heartbeat.probeNow();
  heartbeat.stop();
  assert.deepEqual(logs, [], 'failed proof must not refresh stdout-backed fleet liveness');
});

test('control-plane heartbeat suppresses overlap and ignores a pong that resolves after stop', async () => {
  const logs: string[] = [];
  let probes = 0;
  let resolveProbe!: (value: { type: string }) => void;
  const pending = new Promise<{ type: string }>((resolve) => { resolveProbe = resolve; });
  const heartbeat = new WechatControlPlaneHeartbeat({
    probe: () => { probes += 1; return pending; },
    logImpl: (line) => logs.push(line),
  });

  heartbeat.start();
  const first = heartbeat.probeNow();
  await heartbeat.probeNow();
  assert.equal(probes, 1, 'only one probe may be in flight');
  heartbeat.stop();
  resolveProbe({ type: 'pong' });
  await first;
  assert.deepEqual(logs, [], 'a late response from a stopped runtime is not fresh evidence');
});
