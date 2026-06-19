import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpNotificationMonitor } from '../../src/browse/notification-monitor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

/** 假 CDP：Runtime.evaluate 回传 ref.value（通知监测体期望 JSON 字符串 {unread,count}）；ref.throwIt 时抛。 */
function fakeCdp(ref: { value: unknown; throwIt?: boolean }): BrowseCdp {
  return {
    send: async () => {
      if (ref.throwIt) throw new Error('CDP boom');
      return { result: { value: ref.value } } as never;
    },
  };
}

/** 让 start() 的在途首个 tick 落定。 */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

test('NotificationMonitor.tick: 无→有 触发一次；计数变化(仍有)不重复触发', async () => {
  const ref = { value: JSON.stringify({ unread: false, count: 0 }) };
  const transitions: Array<[boolean, boolean]> = [];
  const monitor = new CdpNotificationMonitor(fakeCdp(ref));
  monitor.start((from, to) => transitions.push([from, to]));
  monitor.stop();
  await flush();
  transitions.length = 0; // 丢弃启动期噪声

  ref.value = JSON.stringify({ unread: true, count: 3 });
  await monitor.tick();
  assert.equal(monitor.state, true);
  assert.equal(monitor.lastCount, 3);

  // 仍是"有"、仅计数变 3→5：不应再次触发
  ref.value = JSON.stringify({ unread: true, count: 5 });
  await monitor.tick();
  assert.equal(monitor.lastCount, 5);
  assert.equal(transitions.length, 1, '计数变化但仍有未读，不应重复触发');
  assert.deepEqual(transitions[0], [false, true]);
});

test('NotificationMonitor.tick: 探测失败保持上次未读（sticky，绝不重置为 false）', async () => {
  const ref = { value: JSON.stringify({ unread: true, count: 2 }), throwIt: false };
  const monitor = new CdpNotificationMonitor(fakeCdp(ref));
  monitor.start();
  monitor.stop();
  await flush();

  await monitor.tick();
  assert.equal(monitor.state, true, '应先检测到未读');

  ref.throwIt = true; // 探测失败
  await monitor.tick();
  assert.equal(monitor.state, true, '探测失败必须保持上次未读，绝不重置为 false（不丢真通知）');
});

test('NotificationMonitor.nextEpoch: 单调递增（每波未读取唯一 epoch）', () => {
  const monitor = new CdpNotificationMonitor(fakeCdp({ value: JSON.stringify({ unread: false, count: 0 }) }));
  assert.equal(monitor.nextEpoch(), 1);
  assert.equal(monitor.nextEpoch(), 2);
  assert.equal(monitor.nextEpoch(), 3);
});
