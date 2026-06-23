import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CdpNotificationMonitor, buildNotificationBadgeJs } from '../../src/browse/notification-monitor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

/**
 * 在真实 DOM 上跑实际的未读探测 JS（不绕过选择器）。
 * jsdom 无布局：把 getClientRects 桩成"有尺寸"，让可见性判定通过——
 * 真假阳性的区分靠"跳过图标 svg"的结构判据，不靠可见性，故此桩不影响结论。
 */
function probeDom(entryHtml: string): { unread: boolean; count: number } {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${entryHtml}</body></html>`, { runScripts: 'outside-only' });
  (dom.window as unknown as { Element: { prototype: { getClientRects: () => unknown } } }).Element.prototype.getClientRects =
    function () { return [{ width: 8, height: 8 }]; };
  return JSON.parse(dom.window.eval(buildNotificationBadgeJs()) as string);
}

// 真机校准（2026-06-23）抓到的通知入口真实结构：badge-container + reds-icon 常驻，未读角标条件渲染进容器。
const ENTRY_NO_UNREAD =
  '<a title="通知" class="link-wrapper bottom-channel" href="/notification">' +
  '<div class="badge-container"><svg class="reds-icon text-active" width="24" height="24"><use xlink:href="#notification"></use></svg><!----></div>' +
  '<span class="text channel">通知</span></a>';
const ENTRY_NUMBERED =
  '<a title="通知" href="/notification"><div class="badge-container">' +
  '<svg class="reds-icon"><use xlink:href="#notification"></use></svg><div class="reds-badge">3</div></div>' +
  '<span class="text channel">通知</span></a>';
const ENTRY_DOT =
  '<a title="通知" href="/notification"><div class="badge-container">' +
  '<svg class="reds-icon"><use xlink:href="#notification"></use></svg><div class="reds-badge dot"></div></div>' +
  '<span class="text channel">通知</span></a>';

test('buildNotificationBadgeJs: 真实无未读结构 → unread:false（不把常驻 badge-container/reds-icon 误判为未读）', () => {
  // 回归：旧版宽选择器 [class*="badge"]/[class*="red"] 会命中常驻容器/图标 → 没通知也判有未读 → 反复跳通知页。
  assert.deepEqual(probeDom(ENTRY_NO_UNREAD), { unread: false, count: 0 });
});

test('buildNotificationBadgeJs: 数字角标 → unread:true 且 count 取数字', () => {
  assert.deepEqual(probeDom(ENTRY_NUMBERED), { unread: true, count: 3 });
});

test('buildNotificationBadgeJs: 红点(无数字)角标 → unread:true count:0（红点也算未读，不漏真通知）', () => {
  assert.deepEqual(probeDom(ENTRY_DOT), { unread: true, count: 0 });
});

test('buildNotificationBadgeJs: 无通知入口 → unread:false（保守，不误报）', () => {
  assert.deepEqual(probeDom('<div class="something">no entry here</div>'), { unread: false, count: 0 });
});

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
