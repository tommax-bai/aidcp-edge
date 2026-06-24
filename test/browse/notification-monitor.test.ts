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

// 真机校准（2026-06-24 活页面 dump）的真实分类 tab 结构：
//   div.reds-tab-item.tab-item > div.badge-container > span(标签) + div(角标数字) | 空槽<!---->
const tab = (label: string, badge?: string, active = false) =>
  `<div class="reds-tab-item tab-item${active ? ' active' : ''}"><div class="badge-container">` +
  `<span>${label}</span>${badge != null ? `<div class="reds-badge">${badge}</div>` : '<!---->'}</div></div>`;
const TABS_ALL_READ = tab('评论和@') + tab('赞和收藏') + tab('新增关注');
const TABS_LIKES_1 = tab('评论和@') + tab('赞和收藏', '1', true) + tab('新增关注');
// 角标位仅常驻 reds-icon（无真实数字角标）：旧宽选择器 [class*="red"] 会命中它 + isNaN→1 假报「未读1」。
const TABS_ICON_ONLY =
  '<div class="reds-tab-item tab-item"><div class="badge-container"><span>评论和@</span>' +
  '<svg class="reds-icon"><use href="#dot"></use></svg></div></div>' + tab('赞和收藏') + tab('新增关注');

test('buildNotificationHomeJs: 全已读（无数字角标）→ 三类全 0（不靠 class 猜，诚实无未读）', () => {
  assert.deepEqual(probeHome(TABS_ALL_READ), { comments: 0, likes: 0, follows: 0 });
});

test('buildNotificationHomeJs: 赞和收藏有真实数字角标 1 → likes:1，其余 0（真机 dump 结构）', () => {
  assert.deepEqual(probeHome(TABS_LIKES_1), { comments: 0, likes: 1, follows: 0 });
});

test('buildNotificationHomeJs: 角标位仅常驻 reds-icon → 全 0（回归 6.5.3 假阳性，绝不再 isNaN→1）', () => {
  assert.deepEqual(probeHome(TABS_ICON_ONLY), { comments: 0, likes: 0, follows: 0 });
});

test('buildNotificationHomeJs(NM-3): tab 内多位数字子文本(时间戳/子计数)不被当角标 → 0（叶子+≤3位守卫）', () => {
  const html =
    '<div class="reds-tab-item tab-item"><div class="badge-container"><span>评论和@</span><span class="time">1430</span></div></div>' +
    tab('赞和收藏') + tab('新增关注');
  assert.deepEqual(probeHome(html), { comments: 0, likes: 0, follows: 0 });
});

test('buildNotificationHomeJs(NM-2): 真实包裹容器 reds-tabs-list 不被当 tab → 角标不跨类泄漏', () => {
  // 真机 dump：reds-tabs-list / sticky-tab 也含 [class*="tab"]、拼接文本=三标签。旧 [class*="tab"] 选择器会把
  // 赞类角标泄漏给评论类。新选择器收到 [class*="tab-item"]（包裹无此 class）→ 杜绝泄漏。
  const html =
    '<div class="reds-sticky-box sticky sticky-tab"><div class="tertiary left reds-tabs-list">' +
    TABS_LIKES_1 + '</div></div>';
  assert.deepEqual(probeHome(html), { comments: 0, likes: 1, follows: 0 }, '只 likes:1，评论/关注不被泄漏污染');
});

test('buildNotificationHomeJs: 页面 chrome 里的「赞」按钮(非 tab)带数字 → 不被误读（只扫真实 tab-item）', () => {
  const html =
    '<a class="like-wrapper"><span>赞</span><span class="count">99</span></a>' + tab('赞和收藏', '2');
  assert.deepEqual(probeHome(html), { comments: 0, likes: 2, follows: 0 });
});

interface RawItem { kind: string; fromUser: string; content: string; itemKey?: string }
/** 在真实 DOM 上跑「评论和@」列表抽取 JS（不绕过选择器）。 */
function probeItems(listHtml: string): RawItem[] {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${listHtml}</body></html>`, { runScripts: 'outside-only' });
  return JSON.parse(dom.window.eval(buildNotificationItemsJs()) as string);
}

// 真机校准（2026-06-24）的真实评论行：div.tabs-content-container > div.container[note-id?]
//   a.user-avatar(空文本) + div.main>div.info>(div.user-info>a 昵称 / span 动作 / span.interaction-time / div.interaction-content 正文)
const row = (o: { user: string; action: string; time?: string; content?: string; noteId?: string; extraLink?: string }) =>
  `<div class="container"${o.noteId ? ` note-id="${o.noteId}"` : ''}>` +
  `<a class="user-avatar" href="/user/profile/u_${o.user}"></a>` +
  '<div class="main"><div class="info">' +
  `<div class="user-info"><a href="/user/profile/u_${o.user}">${o.user}</a></div>` +
  `<span>${o.action}</span>` +
  (o.time ? `<span class="interaction-time">${o.time}</span>` : '') +
  (o.content != null ? `<div class="interaction-content">${o.content}</div>` : '') +
  (o.extraLink ? `<a href="${o.extraLink}">查看</a>` : '') +
  '</div></div></div>';
const list = (...rows: string[]) => `<div class="tabs-content-container">${rows.join('')}</div>`;

test('buildNotificationItemsJs: 真实行结构 → 昵称取 .user-info a（非空文本头像）、正文取 .interaction-content', () => {
  const items = probeItems(list(row({ user: 'Scott309', action: '评论了你的笔记', time: '2天前', content: '再把 dp 设 2 试一下呢' })));
  assert.equal(items.length, 1, '只抽 1 行（不被 a.user-avatar/avatar-item 头像污染成多行）');
  assert.equal(items[0].fromUser, 'Scott309', '昵称取 .user-info a，不是空文本的 a.user-avatar');
  assert.equal(items[0].content, '再把 dp 设 2 试一下呢', '正文取 .interaction-content，不含时间');
  assert.equal(items[0].kind, 'comment');
});

test('buildNotificationItemsJs(NCQ-1): 无 .interaction-content → content 空串（绝不回退整行成 blob）', () => {
  const items = probeItems(list(row({ user: '张三', action: '评论了你的笔记', time: '3分钟前' })));
  assert.equal(items.length, 1);
  assert.equal(items[0].fromUser, '张三');
  assert.equal(items[0].content, '', '无正文元素时发空串（由云端非空过滤丢弃），不把整行糊进来');
});

test('buildNotificationItemsJs(NB-5): itemKey 取 note-id 属性 / 非 profile 链；仅 profile 链则留空', () => {
  const withNoteId = probeItems(list(row({ user: '李四', action: '评论了你的笔记', content: '说得对', noteId: '6248abc' })));
  assert.equal(withNoteId[0].itemKey, '6248abc', 'note-id 属性优先作 itemKey');
  const withLink = probeItems(list(row({ user: '李四', action: '回复了你的评论', content: '说得对', extraLink: '/explore/note456' })));
  assert.equal(withLink[0].itemKey, '/explore/note456', '无 note-id 时取非 profile 链');
  const onlyProfile = probeItems(list(row({ user: '李四', action: '回复了你的评论', content: '说得对' })));
  assert.equal(onlyProfile[0].itemKey, undefined, '仅 profile 链 → 留空，交云端回退 用户名|正文 去重键');
});

test('buildNotificationItemsJs(NCQ-2): 超长正文按 code-point 截断 + 省略号，绝不劈裂 emoji 代理对', () => {
  const longBody = 'x'.repeat(199) + '😀tail'; // 第 200 个 code point 是 emoji（代理对）
  const items = probeItems(list(row({ user: '阿强', action: '评论了你的笔记', content: longBody })));
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
