// 小红书 Native 通知侧行为平价测试（change restore-native-xiaohongshu-action-honesty 任务 1.13–1.19）。
//
// 这些用例针对**注入页面的规则脚本本身**（xhs-command-router.js / xhs-page-probe.js），
// 锁的是行为契约，不是某个具体选择器字符串：
//   · 未读角标读三态（有 / 无 / 读不到），取可见入口、空槽不算未读、读不到 ≠ 无未读；
//   · 赞和收藏 / 新增关注两类以动作回执终局，动作名用云端角色等待的规范名；
//   · 评论和@ 栏滚到底、云端下发的滚动预算真参与上限；
//   · 通知首页三栏计数只认真实叶子分类栏里的纯数字角标；
//   · 分类栏点不到就诚实回未命中，不点包裹容器、不按类名激活态猜成功；
//   · 文本按 code point 截断、不劈裂 emoji 代理对；
//   · 上报里不含页面规则自造的墙钟批次序号。
//
// 夹具**不**在 HTMLElement.prototype 上钉死几何：可见性由夹具逐元素给定（display:none /
// visibility:hidden 的祖先或 data-rect="hidden" 一律零盒），使可见性判断在测试里真有两态。
// 注：行结构（.tabs-content-container > .container）与角标结构出自 2026-06-23 / 06-24 真机校准、
// 均标「须复核」（真机验收项 5.5 / 5.8）；用例断言的是产出结果，选择器变了只需换夹具。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type RouterResult = {
  effectPhase: string;
  output: { kind: string; value: Record<string, unknown> };
};

const routerSource = await readFile(resolve(repoRoot, 'native/page-engine/src/xhs-command-router.js'), 'utf8');
const runRouter = Function(`return (${routerSource})`)() as (
  input: { kind: string; params: Record<string, unknown> },
) => Promise<RouterResult>;

type ProbeResult = Record<string, unknown> & {
  notificationUnread?: { state: string; count: number };
};

const probeSource = await readFile(resolve(repoRoot, 'native/page-engine/src/xhs-page-probe.js'), 'utf8');
const runProbe = (): ProbeResult => Function(`return (${probeSource})`)() as ProbeResult;

const HIDDEN_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
const VISIBLE_RECT = { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 };

const NOTIFICATION_URL = 'https://www.xiaohongshu.com/notification';
const EXPLORE_URL = 'https://www.xiaohongshu.com/explore';

function install(html: string, url = NOTIFICATION_URL): JSDOM {
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  const win = dom.window as unknown as Record<string, unknown>;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    innerHeight: 800,
  });
  // 几何按夹具给定，而不是全局钉死：隐藏容器里的元素真拿到零盒。
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      let node: Element | null = this;
      while (node) {
        if (node.getAttribute && node.getAttribute('data-rect') === 'hidden') return { ...HIDDEN_RECT };
        const style = (node as unknown as { style?: CSSStyleDeclaration }).style;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return { ...HIDDEN_RECT };
        node = node.parentElement;
      }
      return { ...VISIBLE_RECT };
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  });
  win.scrollBy = () => undefined;
  win.scrollTo = () => undefined;
  return dom;
}

/**
 * 把「页面被滚动」这件事接出来，覆盖窗口滚动（scrollBy / scrollTo）与容器滚动
 * （scrollBy / scrollTo / 写 scrollTop）两种写法。
 * 刻意**不**接 scrollIntoView —— 它同时被点击助手用来把控件拉进视口，接了会让「点分类栏」
 * 也被算成一次滚动，用例就分不清「真滚了列表」和「只是点了个按钮」。
 */
function hookScroll(dom: JSDOM, onScroll: () => void): void {
  const win = dom.window as unknown as Record<string, unknown>;
  win.scrollBy = () => onScroll();
  win.scrollTo = () => onScroll();
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperty(proto, 'scrollBy', { configurable: true, value: () => onScroll() });
  Object.defineProperty(proto, 'scrollTo', { configurable: true, value: () => onScroll() });
  const tops = new WeakMap<object, number>();
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: object) {
      return tops.get(this) ?? 0;
    },
    set(this: object, value: number) {
      tops.set(this, Number(value) || 0);
      onScroll();
    },
  });
}

type TabName = 'comments' | 'likes' | 'follows';

const TAB_LABELS: Record<TabName, string> = {
  comments: '评论和@',
  likes: '赞和收藏',
  follows: '新增关注',
};

/**
 * 真机校准出的三个叶子分类栏。刻意不套 div 包裹容器（包裹容器的用例单列，见 1.17），
 * 用 <nav> 承载，避免夹具本身就把「包裹容器」塞进第一顺位。
 */
function tabsHtml(options: { active?: TabName; badges?: Partial<Record<TabName, string>> } = {}): string {
  const names: TabName[] = ['comments', 'likes', 'follows'];
  const cells = names.map((name) => {
    const badge = options.badges?.[name];
    const activeClass = options.active === name ? ' is-active' : '';
    const badgeHtml = badge === undefined ? '' : `<span class="count">${badge}</span>`;
    return `<div class="reds-tab-item tab-item${activeClass}" id="tab-${name}">${TAB_LABELS[name]}${badgeHtml}</div>`;
  });
  return `<nav class="reds-tabs">${cells.join('')}</nav>`;
}

/**
 * 通知行。同时带 `container`（真机校准的两级行结构）与 `notification-item`（当前实现的模糊 class），
 * 让「行选不中」这个另一条缺口（任务 1.9）不污染本文件用例的红因。
 */
function rowHtml(options: { userId: string; user?: string; content?: string; time?: string }): string {
  const user = options.user ?? `用户${options.userId}`;
  const content = options.content ?? `第 ${options.userId} 条通知正文`;
  const time = options.time ?? '2天前';
  return [
    '<div class="container notification-item">',
    `<div class="user-info"><a href="/user/profile/${options.userId}">${user}</a></div>`,
    `<div class="interaction-content">${content}</div>`,
    `<span class="interaction-time">${time}</span>`,
    '</div>',
  ].join('');
}

function notificationPage(options: {
  active?: TabName;
  badges?: Partial<Record<TabName, string>>;
  rows?: string[];
  chrome?: string;
} = {}): string {
  return [
    '<a class="nav-notification" href="/notification">通知</a>',
    options.chrome ?? '',
    tabsHtml({ active: options.active, badges: options.badges }),
    `<div class="tabs-content-container">${(options.rows ?? []).join('')}</div>`,
  ].join('');
}

function appendRow(dom: JSDOM, index: number): void {
  const list = dom.window.document.querySelector('.tabs-content-container');
  if (!list) return;
  list.insertAdjacentHTML('beforeend', rowHtml({ userId: `s${index}` }));
}

function receiptOf(result: RouterResult): Record<string, unknown> {
  return (result.output.value.receipt ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 任务 1.13 —— 未读角标读数（页面规则层，三态）
// ---------------------------------------------------------------------------

test('probe reads the visible notification entry across both layouts and carries the badge number', () => {
  // 宽（侧栏）与窄（底部）两个入口 DOM 同时存在，侧栏那个是隐藏的：读隐藏那个会漏报未读。
  install(
    `
      <nav class="side-bar" style="display:none">
        <a href="/notification"><div class="badge-container"><svg class="reds-icon"></svg><!----></div><span>通知</span></a>
      </nav>
      <nav class="bottom-bar">
        <a href="/notification"><div class="badge-container"><svg class="reds-icon"></svg><span class="count">3</span></div></a>
      </nav>
    `,
    EXPLORE_URL,
  );
  assert.deepEqual(runProbe().notificationUnread, { state: 'unread', count: 3 });
});

test('probe treats an always-present icon with an empty slot as no unread, and a numberless dot as unread', () => {
  install(
    '<nav class="bottom-bar"><a href="/notification"><div class="badge-container"><svg class="reds-icon"></svg><!----></div><span>通知</span></a></nav>',
    EXPLORE_URL,
  );
  assert.deepEqual(runProbe().notificationUnread, { state: 'clear', count: 0 });

  install(
    '<nav class="bottom-bar"><a href="/notification"><div class="badge-container"><svg class="reds-icon"></svg><span class="dot"></span></div></a></nav>',
    EXPLORE_URL,
  );
  assert.deepEqual(runProbe().notificationUnread, { state: 'unread', count: 0 });
});

test('probe reports an unknown unread state rather than "no unread" when the entry cannot be read', () => {
  install('<main><section class="note-item"><a href="/explore/n1">card</a></section></main>', EXPLORE_URL);
  assert.deepEqual(runProbe().notificationUnread, { state: 'unreadable', count: 0 });
});

// ---------------------------------------------------------------------------
// 任务 1.14 —— 赞和收藏 / 新增关注两类以动作回执终局
// ---------------------------------------------------------------------------

test('viewing the like/collect category terminates with the receipt the cloud role waits for', async () => {
  install(notificationPage({ active: 'likes', rows: [rowHtml({ userId: 'u1', content: '收藏了你的笔记' })] }));
  const result = await runRouter({ kind: 'notification_browse_likes', params: {} });

  assert.equal(result.output.kind, 'action_receipt_with_observation');
  const receipt = receiptOf(result);
  assert.equal(receipt.action, 'browse_notification_likes');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.reason, 'viewed');
  // 终局改回执后，联系人名册要的通知项仍须随本次命令到达云端。
  const observation = result.output.value.notificationItems as { items: unknown[] } | undefined;
  assert.ok(observation && observation.items.length === 1);
});

test('a failed sender extraction still returns the clearing receipt for new followers', async () => {
  // 分类栏点到了、栏也看完了，但一条发送者都抽不出来：抽取是清零的旁路输出，绝不能反过来毙掉清零回执。
  install(notificationPage({ active: 'follows', rows: [] }));
  const result = await runRouter({ kind: 'notification_browse_follows', params: {} });

  assert.equal(result.output.kind, 'action_receipt_with_observation');
  const receipt = receiptOf(result);
  assert.equal(receipt.action, 'browse_notification_follows');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.reason, 'viewed');
  const observation = result.output.value.notificationItems as { items: unknown[] } | undefined;
  assert.ok(observation === undefined || observation.items.length === 0);
});

// ---------------------------------------------------------------------------
// 任务 1.15 —— 评论和@ 栏滚到底 + 云端下发的滚动预算真参与上限
// ---------------------------------------------------------------------------

test('the comment-and-mention sweep covers rows that only load after scrolling', async () => {
  const dom = install(
    notificationPage({
      active: 'comments',
      rows: [rowHtml({ userId: 'c1' }), rowHtml({ userId: 'c2' })],
    }),
  );
  let grown = false;
  hookScroll(dom, () => {
    if (grown) return;
    grown = true;
    appendRow(dom, 3);
    appendRow(dom, 4);
  });

  const result = await runRouter({ kind: 'notification_browse_comments', params: { scrollMax: 4 } });

  assert.equal(result.output.kind, 'notification_items');
  const items = result.output.value.items as unknown[];
  assert.equal(items.length, 4);
});

test('the commanded scroll budget participates in the sweep loop bound', async () => {
  // 行数每轮都在长（永不收敛），停下来的只能是硬上限。硬上限的地板是 12 轮；
  // 下发预算 20 若真参与，产出行数必然超过 12 轮地板所能覆盖的 13 行。
  const dom = install(notificationPage({ active: 'comments', rows: [rowHtml({ userId: 'c0' })] }));
  let round = 0;
  hookScroll(dom, () => {
    round += 1;
    appendRow(dom, round);
  });

  const result = await runRouter({ kind: 'notification_browse_comments', params: { scrollMax: 20 } });

  const items = result.output.value.items as unknown[];
  assert.ok(
    items.length > 13,
    `commanded scroll budget should raise the loop bound above the floor; extracted ${items.length} rows`,
  );
});

// ---------------------------------------------------------------------------
// 任务 1.16 —— 通知首页三栏未读计数
// ---------------------------------------------------------------------------

test('per-tab unread counts come from the leaf tab badge, not from numbers elsewhere on the page', async () => {
  install(
    notificationPage({
      badges: { likes: '1' },
      chrome: '<div class="note-card">赞 312</div><div class="side-stat">关注 88</div>',
    }),
  );
  const result = await runRouter({ kind: 'notification_open', params: {} });

  assert.equal(result.output.kind, 'notification_home');
  assert.equal(result.output.value.likes, 1);
  assert.equal(result.output.value.comments, 0);
  assert.equal(result.output.value.follows, 0);
});

test('a unit-suffixed badge is not converted into a count of unread items', async () => {
  install(notificationPage({ badges: { likes: '1.2万' } }));
  const result = await runRouter({ kind: 'notification_open', params: {} });

  assert.equal(result.output.kind, 'notification_home');
  assert.equal(result.output.value.likes, 0);
});

test('tabs without a numeric badge report zero unread', async () => {
  install(notificationPage({}));
  const result = await runRouter({ kind: 'notification_open', params: {} });

  assert.equal(result.output.kind, 'notification_home');
  assert.deepEqual(
    { comments: result.output.value.comments, likes: result.output.value.likes, follows: result.output.value.follows },
    { comments: 0, likes: 0, follows: 0 },
  );
});

// ---------------------------------------------------------------------------
// 任务 1.17 —— 分类栏点击诚实回未命中
// ---------------------------------------------------------------------------

test('a category with no leaf tab is honestly reported as not found and nothing else is actuated', async () => {
  const dom = install(
    [
      '<a class="nav-notification" href="/notification">通知</a>',
      // 包裹容器：三个分类名的拼接文本 + 激活态类名。点它等于没切栏，激活态更不能当成功证据。
      '<div class="reds-tabs-list is-active">评论和@ 赞和收藏 新增关注</div>',
      '<div class="note-card">赞 312</div>',
      '<div class="side-entry">点赞</div>',
      '<div class="tabs-content-container"></div>',
    ].join(''),
  );
  const clicked: string[] = [];
  dom.window.document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element;
      clicked.push(String(target.getAttribute('class') || target.tagName));
    },
    true,
  );

  const result = await runRouter({ kind: 'notification_browse_likes', params: {} });

  assert.equal(result.output.kind, 'action_receipt_with_observation');
  const receipt = receiptOf(result);
  assert.equal(receipt.action, 'browse_notification_likes');
  assert.equal(receipt.ok, false);
  assert.equal(receipt.reason, 'no_target');
  assert.equal(result.effectPhase, 'not_started');
  assert.equal(result.output.value.notificationItems, undefined);
  assert.deepEqual(clicked, []);
});

// ---------------------------------------------------------------------------
// 任务 1.18 —— code point 安全截断
// ---------------------------------------------------------------------------

test('notification content is truncated on a code-point boundary with an ellipsis marker', async () => {
  // 第 200 个 code point 正好是一个 emoji（代理对）：按 UTF-16 切会留下半个字符。
  const content = `${'a'.repeat(199)}👍${'b'.repeat(60)}`;
  install(notificationPage({ active: 'comments', rows: [rowHtml({ userId: 'e1', content })] }));

  const result = await runRouter({ kind: 'notification_browse_comments', params: {} });
  const items = result.output.value.items as Array<Record<string, unknown>>;
  const emitted = String(items[0]?.content ?? '');

  assert.ok(Array.from(emitted).length <= 201, `content should stay within its field-scoped cap, got ${Array.from(emitted).length} code points`);
  assert.ok(emitted.endsWith('…'), 'a truncated field must carry a visible ellipsis marker');
  assert.ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emitted),
    'truncation must not leave a lone surrogate behind',
  );
});

// ---------------------------------------------------------------------------
// 任务 1.19 —— 上报不自造墙钟批次序号
// ---------------------------------------------------------------------------

test('notification list and notification home reports carry no page-minted batch sequence', async () => {
  install(notificationPage({ active: 'comments', rows: [rowHtml({ userId: 'b1' })] }));
  const list = await runRouter({ kind: 'notification_browse_comments', params: {} });
  assert.equal(list.output.kind, 'notification_items');
  assert.ok(!('epoch' in list.output.value), 'notification items must not mint their own batch sequence');

  install(notificationPage({}));
  const home = await runRouter({ kind: 'notification_open', params: {} });
  assert.equal(home.output.kind, 'notification_home');
  assert.ok(!('epoch' in home.output.value), 'notification home must not mint its own batch sequence');
});
