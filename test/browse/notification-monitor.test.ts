import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CdpNotificationMonitor, buildNotificationBadgeJs, buildNotificationHomeJs, buildNotificationItemsJs } from '../../src/browse/notification-monitor.js';
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

/** 在真实 DOM 上跑首页 per-tab 计数探测 JS（不绕过选择器）。 */
function probeHome(tabsHtml: string): { comments: number; likes: number; follows: number } {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${tabsHtml}</body></html>`, { runScripts: 'outside-only' });
  (dom.window as unknown as { Element: { prototype: { getClientRects: () => unknown } } }).Element.prototype.getClientRects =
    function () { return [{ width: 8, height: 8 }]; };
  return JSON.parse(dom.window.eval(buildNotificationHomeJs()) as string);
}

// 猜测的真实分类 tab 结构（待真机校准 item a）：reds- 命名，标签文字 + 条件渲染的数字角标。
const TABS_ALL_READ =
  '<div role="tab" class="reds-tab-item"><span>评论和@</span></div>' +
  '<div role="tab" class="reds-tab-item"><span>赞和收藏</span></div>' +
  '<div role="tab" class="reds-tab-item"><span>新增关注</span></div>';
const TABS_COMMENTS_2 =
  '<div role="tab" class="reds-tab-item"><span>评论和@</span><span class="reds-badge">2</span></div>' +
  '<div role="tab" class="reds-tab-item"><span>赞和收藏</span></div>' +
  '<div role="tab" class="reds-tab-item"><span>新增关注</span></div>';
// 角标位仅常驻 reds-icon（无真实数字角标）：旧宽选择器 [class*="red"] 会命中它 + isNaN→1 假报「未读1」。
const TABS_ICON_ONLY =
  '<div role="tab" class="reds-tab-item"><span>评论和@</span><svg class="reds-icon"><use href="#dot"></use></svg></div>' +
  '<div role="tab" class="reds-tab-item"><span>赞和收藏</span></div>' +
  '<div role="tab" class="reds-tab-item"><span>新增关注</span></div>';

test('buildNotificationHomeJs: 全已读（无数字角标）→ 三类全 0（不靠 class 猜，诚实无未读）', () => {
  assert.deepEqual(probeHome(TABS_ALL_READ), { comments: 0, likes: 0, follows: 0 });
});

test('buildNotificationHomeJs: 评论 tab 有数字角标 2 → comments:2，其余 0', () => {
  assert.deepEqual(probeHome(TABS_COMMENTS_2), { comments: 2, likes: 0, follows: 0 });
});

test('buildNotificationHomeJs: 角标位仅常驻 reds-icon → 全 0（回归 6.5.3 假阳性，绝不再 isNaN→1）', () => {
  assert.deepEqual(probeHome(TABS_ICON_ONLY), { comments: 0, likes: 0, follows: 0 });
});

test('buildNotificationHomeJs(NM-3): tab 内多位数字子文本(时间戳/子计数)不被当角标 → 0（叶子+≤3位守卫）', () => {
  const html =
    '<div role="tab" class="reds-tab-item"><span>评论和@</span><span class="time">1430</span></div>' +
    '<div role="tab" class="reds-tab-item"><span>赞和收藏</span></div>' +
    '<div role="tab" class="reds-tab-item"><span>新增关注</span></div>';
  assert.deepEqual(probeHome(html), { comments: 0, likes: 0, follows: 0 });
});

test('buildNotificationHomeJs: 页面 chrome 里的「赞」按钮(非 tab)带数字 → 不被误读（只扫真实 tab）', () => {
  // NB-2 回归：旧码全页扫 a/span/div，会从点赞/侧栏按钮误读 badge。新码只扫 [role=tab],[class*=tab]。
  const html =
    '<a class="like-wrapper"><span>赞</span><span class="count">99</span></a>' +
    '<div role="tab" class="reds-tab-item"><span>赞和收藏</span></div>';
  assert.deepEqual(probeHome(html), { comments: 0, likes: 0, follows: 0 });
});

interface RawItem { kind: string; fromUser: string; content: string; noteTitle?: string; itemKey?: string }
/** 在真实 DOM 上跑「评论和@」列表抽取 JS（不绕过选择器）。 */
function probeItems(listHtml: string): RawItem[] {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${listHtml}</body></html>`, { runScripts: 'outside-only' });
  return JSON.parse(dom.window.eval(buildNotificationItemsJs()) as string);
}

test('buildNotificationItemsJs(NCQ-1): 正文子选择器缺失 → content 空串（绝不回退整行 textContent 成 blob）', () => {
  const items = probeItems('<div class="notification-list"><div class="item"><span class="user-name">张三</span>评论了你的笔记 3分钟前</div></div>');
  assert.equal(items.length, 1);
  assert.equal(items[0].fromUser, '张三');
  assert.equal(items[0].content, '', '无正文元素时发空串（由云端非空过滤丢弃），不把整行糊进来');
});

test('buildNotificationItemsJs(NB-5): itemKey 取非 profile 链；仅 profile 链则留空', () => {
  const withNote = probeItems(
    '<div class="comment-list"><div class="item">' +
    '<a href="/user/profile/u1" class="user-name">李四</a><span>回复了你</span>' +
    '<div class="content">说得对</div><a href="/explore/note456">查看笔记</a></div></div>',
  );
  assert.equal(withNote[0].itemKey, '/explore/note456', 'itemKey 应取非 profile 的稳定链接');
  const onlyProfile = probeItems(
    '<div class="comment-list"><div class="item">' +
    '<a href="/user/profile/u1" class="user-name">李四</a><span>回复了你</span>' +
    '<div class="content">说得对</div></div></div>',
  );
  assert.equal(onlyProfile[0].itemKey, undefined, '仅 profile 链 → itemKey 留空，交云端回退 用户名|正文 去重键');
});

test('buildNotificationItemsJs(NCQ-2): 超长正文按 code-point 截断 + 省略号，绝不劈裂 emoji 代理对', () => {
  const longBody = 'x'.repeat(199) + '😀tail'; // 第 200 个 code point 是 emoji（代理对）
  const items = probeItems(
    '<div class="comment-list"><div class="item"><span>评论</span>' +
    `<div class="content">${longBody}</div></div></div>`,
  );
  const c = items[0].content;
  assert.equal([...c].length, 201, '200 个 code point + 省略号');
  assert.ok(c.endsWith('😀…'), 'emoji 完整保留在边界、随后省略号');
  assert.ok(!c.includes('�'), '绝无半个代理对导致的替换字符');
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
