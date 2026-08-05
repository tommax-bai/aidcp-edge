// 小红书**退出类命令**的行为契约测试：通知中心返回首页（`notification_back_home`）
// 与关闭详情浮层（`note_close`）。（change native-page-engine-production-cutover 任务 4.6）
//
// 立项理由：这两条此前**都没有任何行为测试**。实测覆盖：
//   · `notification_back_home` —— Rust 侧 `NativeCommand::` 变体统计零命中；TS 侧唯一提到它的是
//     `runtime-contracts-command-receipts.test.ts`，那是「声明的回执与可达发出点对账」、不碰行为。
//     既有的 `xhs-notification-parity.test.ts` 覆盖了开通知中心与三个分类栏，唯独没覆盖「回去」那一步。
//   · `note_close` —— 两侧**全仓零命中**，连声明对账里都没有。
//
// 两条为什么归在一起、又为什么值得单独设防：它们都是**出口**，而出口的假成功不体现在自己身上，
// 体现在它之后的每一条命令上 —— 会话以为自己回到了列表，实际还停在通知页 / 还开着详情浮层，
// 于是下一轮扫描扫的是错的表面，而回执一路都说没问题。
//
// 两条都走注入路由（引擎侧 `_ => evaluate_router`），所以行为契约锁在
// `native/page-engine/src/xhs-command-router.js` 的规则脚本本身，与
// `xhs-notification-parity.test.ts` 同一套 jsdom 夹具口径：可见性由夹具逐元素给定、真有两态。
// 断言锁的是**产出的三态**，不是某个选择器字符串；选择器变了只需换夹具。

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

const HIDDEN_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
const VISIBLE_RECT = { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 };

const NOTIFICATION_URL = 'https://www.xiaohongshu.com/notification';

/** 与通知平价用例同口径：几何按夹具给定，隐藏祖先下的元素真拿到零盒。 */
function install(html: string, url = NOTIFICATION_URL): JSDOM {
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    innerHeight: 800,
  });
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
  const win = dom.window as unknown as Record<string, unknown>;
  win.scrollBy = () => undefined;
  win.scrollTo = () => undefined;
  return dom;
}

/**
 * jsdom 不实现真实导航，所以「点了首页入口页面就换了」必须由夹具显式接出来。
 * 刻意用 `history.pushState` 而不是直接改 location：前者会让 `location.pathname` 真的变，
 * 后者在 jsdom 里是不可写的。**只有挂了这个钩子的用例才代表「跳成了」** ——
 * 不挂就是「点了但没跳」，那正是本文件最要紧的一条负例。
 */
function navigateOnClick(dom: JSDOM, selector: string, to: string): { clicks: number } {
  const counter = { clicks: 0 };
  const el = dom.window.document.querySelector(selector);
  el?.addEventListener('click', () => {
    counter.clicks += 1;
    dom.window.history.pushState({}, '', to);
  });
  return counter;
}

/** 只记点击、不导航：用来断言「找不到入口时一次都没点」。 */
function countClicks(dom: JSDOM): { clicks: number } {
  const counter = { clicks: 0 };
  dom.window.document.addEventListener('click', () => {
    counter.clicks += 1;
  }, true);
  return counter;
}

function receipt(result: RouterResult): Record<string, unknown> {
  assert.equal(result.output.kind, 'action_receipt', '非成功终局必须回动作回执');
  return result.output.value;
}

const FEED_URL = 'https://www.xiaohongshu.com/explore';

/**
 * 通知页外壳：三个叶子分类栏 + 可选未读角标（角标是栏内的纯数字叶子，真机校准口径）。
 * 角标带上，是为了让「回通知首页」的成功终局能断到**具体读数**——只断「回了个通知读数」
 * 而不断数字，栏与数字错位这类漂移就漏过去了。
 */
function notificationShell(badges: { comments?: string; likes?: string; follows?: string } = {}): string {
  const cell = (label: string, badge?: string) =>
    `<div class="reds-tab-item tab-item">${label}${badge === undefined ? '' : `<span class="count">${badge}</span>`}</div>`;
  return `
  <div class="notification-page">
    <nav class="reds-tabs">
      ${cell('评论和@', badges.comments)}
      ${cell('赞和收藏', badges.likes)}
      ${cell('新增关注', badges.follows)}
    </nav>
  </div>
`;
}

// 笔记 id 用真实形状（24 位十六进制）。**不要用 `note-a` 这种带连字符的占位**：
// 路由的 id 提取正则是 `[A-Za-z0-9]+`，连字符会把两个不同 id 都截成同一个前缀，
// 两张卡随后被按 key 去重成一张 —— 那样用例测的是夹具的缺陷，不是实现的行为。
const NOTE_ID_A = '65f1a2b3c4d5e6f708192a3b';
const NOTE_ID_B = '65f1a2b3c4d5e6f708192a3c';

const FEED_CARDS = `
  <section class="note-item" data-note-id="${NOTE_ID_A}">
    <a href="/explore/${NOTE_ID_A}"><span class="title">第一条</span></a>
    <span class="author">作者甲</span>
  </section>
  <section class="note-item" data-note-id="${NOTE_ID_B}">
    <a href="/explore/${NOTE_ID_B}"><span class="title">第二条</span></a>
    <span class="author">作者乙</span>
  </section>
`;

// 这条命令的「首页」指的是**通知页的分类栏那一层**，不是信息流首页：云端一类看完后靠这一步
// 重报的三栏未读挑下一类，回信息流是巡视收尾之后由 `navigation_back` 单独做的另一步。
// 本文件原先把它当成「回信息流」来守，守得很严——守错了目的地：实现导航到 /explore 并回一屏
// 信息流卡片，云端永远等不到重读结果，循环在第一类处理完后静默停摆，而每一层回执都仍是成功的。
// 所以下面的用例既守三态，也守**目的地**。

test('★ 一类看完后回通知首页：已在通知页就直接重报三栏，一次都不点', async () => {
  // 分类浏览只切栏、不离页 —— 这是正常路径，此时任何点击都是多余动作。
  const dom = install(`<body>${notificationShell({ comments: '2', likes: '48' })}</body>`);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'notification_back_home', params: {} });

  assert.equal(counter.clicks, 0, '已经在通知页上，不该再点任何入口');
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'notification_home');
  assert.deepEqual(result.output.value, { comments: 2, likes: 48, follows: 0 });
});

test('★ 页面上就算有首页入口与信息流卡片，也不得回信息流', async () => {
  // 本次回归的守卫用例：原实现正是在这里点了 /explore 走人、并把一屏卡片当成终局。
  const dom = install(`<body>
    <a href="/explore" id="home">首页</a>
    ${notificationShell({ comments: '2' })}
    ${FEED_CARDS}
  </body>`);
  const counter = navigateOnClick(dom, '#home', '/explore');

  const result = await runRouter({ kind: 'notification_back_home', params: {} });

  assert.equal(counter.clicks, 0, '「回通知首页」不是回信息流，首页入口一次都不该被点');
  assert.equal(result.output.kind, 'notification_home');
  assert.notEqual(result.output.kind, 'page_cards');
});

test('不在通知页且找不到通知入口时诚实回未开始，且一次都没点', async () => {
  const dom = install(`<body>${FEED_CARDS}</body>`, FEED_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'notification_back_home', params: {} });

  assert.equal(result.effectPhase, 'not_started');
  const value = receipt(result);
  // 动作名必须是云端等待的规范名：云端把它列在巡视命令集合里，失败回执是恢复通道的入口之一，
  // 名字对不上就没人来解巡视的暂停开关。
  assert.equal(value.action, 'notification_back_home');
  assert.equal(value.ok, false);
  assert.equal(value.reason, 'notification_entry_not_found');
  // 「没找到」必须意味着**什么都没动**：先点了再说找不到，页面已经被改过了。
  assert.equal(counter.clicks, 0);
});

test('通知入口存在但不可见时同样是未开始，不当成找到了', async () => {
  const dom = install(`<body>
    <div style="display:none"><a href="/notification">消息</a></div>
    ${FEED_CARDS}
  </body>`, FEED_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'notification_back_home', params: {} });

  assert.equal(result.effectPhase, 'not_started');
  assert.equal(receipt(result).reason, 'notification_entry_not_found');
  assert.equal(counter.clicks, 0);
});

test('点中通知入口并真的跳回通知页才算确认，并带回三栏读数', async () => {
  const dom = install(`<body>
    <a href="/notification" id="entry">消息</a>
    ${notificationShell({ likes: '48', follows: '1' })}
  </body>`, FEED_URL);
  const counter = navigateOnClick(dom, '#entry', '/notification');

  const result = await runRouter({ kind: 'notification_back_home', params: {} });

  assert.equal(counter.clicks, 1);
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'notification_home');
  assert.deepEqual(result.output.value, { comments: 0, likes: 48, follows: 1 });
});

test('★ 点了但页面没跳回通知页时是 ambiguous，绝不回确认', async () => {
  // 红线用例：点击派发成功 ≠ 回到了通知页。
  // 这一支若被写成成功，云端会拿一份不知从哪读来的读数去挑下一类。
  const dom = install(`<body>
    <a href="/notification" id="entry">消息</a>
    ${FEED_CARDS}
  </body>`, FEED_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'notification_back_home', params: {} });

  assert.equal(counter.clicks, 1, '入口可见时必须真的点一次');
  assert.equal(result.effectPhase, 'ambiguous');
  assert.notEqual(result.effectPhase, 'confirmed');
  const value = receipt(result);
  assert.equal(value.action, 'notification_back_home');
  assert.equal(value.ok, false);
  assert.equal(value.reason, 'notification_navigation_unconfirmed');
  // 未确认时不得夹带读数。
  assert.equal(result.output.kind, 'action_receipt');
});

test('★ 落在通知页但分类栏读不到时回未确认，绝不用全 0 冒充「三栏已清零」', async () => {
  // 云端把某栏计数 ≤ 0 当成该类已清零直接跳过 —— 一份全 0 的读数会让整趟巡视
  // 把一次读取失败静默兑现成「已经清完了」。
  install('<body><div class="notification-page">加载中…</div></body>');

  const result = await runRouter({ kind: 'notification_back_home', params: {} });

  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(result.output.kind, 'action_receipt');
  const value = receipt(result);
  assert.equal(value.action, 'notification_back_home');
  assert.equal(value.ok, false);
  assert.equal(value.reason, 'notification_tabs_not_found');
  assert.ok(!('comments' in value), '未确认的产出里不得出现任何三栏读数');
});

test('用文字识别到的通知入口走同一条三态判据', async () => {
  // 入口不带 /notification 链接、只有文案时仍应可达（findByWords 分支），
  // 但「跳没跳成」的判据不变 —— 识别方式变宽，成功判据不许跟着变宽。
  const dom = install(`<body>
    <div id="entry" role="button">消息</div>
    ${FEED_CARDS}
  </body>`, FEED_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'notification_back_home', params: {} });

  assert.equal(counter.clicks, 1);
  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(receipt(result).reason, 'notification_navigation_unconfirmed');
});

// ── note_close：关闭详情浮层 ───────────────────────────────────────────────
//
// 三态与返回首页同构：没开 / 找不到关闭控件 / 点了但浮层还在。
// 额外锁一件 CLAUDE.md §2 点名过的事：**回执里的动作名是云端角色等待的规范名 `close`**，
// 不是协议消息名 `note.close`、也不是引擎命令名 `note_close`。名字对不上的后果不是报错，
// 是角色永远等不到回执、调度器把它当未知失败动作继续下发。

const DETAIL_URL = 'https://www.xiaohongshu.com/explore/65f1a2b3c4d5e6f708192a3b';

/** 详情浮层夹具。`removeOnClick` 为真时，点击关闭控件会真把浮层摘掉（＝关成了）。 */
function detailHtml(options: { closeControl?: 'class' | 'aria' | 'words' | 'none' } = {}): string {
  const kind = options.closeControl ?? 'class';
  const control = kind === 'none'
    ? ''
    : kind === 'class'
      ? '<div class="close-box" id="close">×</div>'
      : kind === 'aria'
        ? '<button aria-label="关闭当前笔记" id="close"></button>'
        : '<div role="button" id="close">关闭</div>';
  return `<div class="note-detail-mask" id="detail">${control}<div class="content">正文</div></div>`;
}

function removeDetailOnClick(dom: JSDOM): { clicks: number } {
  const counter = { clicks: 0 };
  dom.window.document.querySelector('#close')?.addEventListener('click', () => {
    counter.clicks += 1;
    dom.window.document.querySelector('#detail')?.remove();
  });
  return counter;
}

test('详情浮层根本没开时诚实回未开始，且一次都没点', async () => {
  const dom = install('<body><section class="note-item">列表</section></body>', DETAIL_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'note_close', params: {} });

  assert.equal(result.effectPhase, 'not_started');
  const value = receipt(result);
  assert.equal(value.action, 'close', '动作名必须是云端角色等待的规范名 close');
  assert.equal(value.ok, false);
  assert.equal(value.reason, 'detail_not_open');
  assert.equal(counter.clicks, 0);
});

test('浮层开着但找不到关闭控件时诚实回未开始，不乱点浮层里别的东西', async () => {
  const dom = install(`<body>${detailHtml({ closeControl: 'none' })}</body>`, DETAIL_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'note_close', params: {} });

  assert.equal(result.effectPhase, 'not_started');
  assert.equal(receipt(result).reason, 'close_control_not_found');
  // 关不掉时**不许**退而求其次点点别的：那正是「不认识的浮层被破坏性关闭」那类事故。
  assert.equal(counter.clicks, 0);
});

test('点中关闭控件且浮层真消失才算确认', async () => {
  const dom = install(`<body>${detailHtml()}</body>`, DETAIL_URL);
  const counter = removeDetailOnClick(dom);

  const result = await runRouter({ kind: 'note_close', params: {} });

  assert.equal(counter.clicks, 1);
  assert.equal(result.effectPhase, 'confirmed');
  const value = receipt(result);
  assert.equal(value.action, 'close');
  assert.equal(value.ok, true);
});

test('★ 点了但浮层还在时是 ambiguous，绝不回确认', async () => {
  // 红线：点击派发成功 ≠ 浮层关掉了。写成成功的话，后续 feed 扫描会在还开着的浮层背后跑。
  const dom = install(`<body>${detailHtml()}</body>`, DETAIL_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'note_close', params: {} });

  assert.equal(counter.clicks, 1, '控件可见时必须真的点一次');
  assert.equal(result.effectPhase, 'ambiguous');
  assert.notEqual(result.effectPhase, 'confirmed');
  const value = receipt(result);
  assert.equal(value.action, 'close');
  assert.equal(value.ok, false);
  assert.equal(value.reason, 'detail_still_open');
});

test('aria 与纯文案两种关闭控件走同一条三态判据', async () => {
  for (const closeControl of ['aria', 'words'] as const) {
    const dom = install(`<body>${detailHtml({ closeControl })}</body>`, DETAIL_URL);
    const counter = removeDetailOnClick(dom);

    const result = await runRouter({ kind: 'note_close', params: {} });

    assert.equal(counter.clicks, 1, `${closeControl} 控件应被点到`);
    assert.equal(result.effectPhase, 'confirmed', `${closeControl} 控件关成后应确认`);
  }
});

// ── profile_open：打开作者主页 ────────────────────────────────────────────
//
// 补测理由：此前只有宿主路由层的用例（`browse-session.test.ts` 走的是信封与命令映射），
// **没有任何页面行为断言** —— 「到底打开了谁的主页」这件事脱机无人守。
//
// 它比另外两条多一态：**精确目标绑定**。云端指定了 authorId 时，页面上找到的作者链接
// 若不是那个人，MUST NOT 点下去 —— 点错人的后果不是本条命令失败，是后续关注 / 读粉丝数
// 全部记在别人账上。所以「找到了但不是要找的那个」必须与「没找到」一样是未开始终局。

const PROFILE_A = 'author0001aaaa';
const PROFILE_B = 'author0002bbbb';

function profileLinkHtml(authorId: string): string {
  return `<div class="author"><a href="/user/profile/${authorId}" id="author">作者甲</a></div>`;
}

function navigateProfileOnClick(dom: JSDOM, authorId: string): { clicks: number } {
  const counter = { clicks: 0 };
  dom.window.document.querySelector('#author')?.addEventListener('click', () => {
    counter.clicks += 1;
    dom.window.history.pushState({}, '', `/user/profile/${authorId}`);
  });
  return counter;
}

test('页面上没有作者入口时诚实回未开始，且一次都没点', async () => {
  const dom = install('<body><div class="note-detail-mask">正文</div></body>', DETAIL_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'profile_open', params: { authorId: PROFILE_A } });

  assert.equal(result.effectPhase, 'not_started');
  const value = receipt(result);
  assert.equal(value.action, 'open_profile', '动作名必须是规范名 open_profile');
  assert.equal(value.ok, false);
  assert.equal(value.reason, 'profile_target_not_found');
  assert.equal(counter.clicks, 0);
});

test('★ 找到的作者不是云端指定的那一个时绝不点下去', async () => {
  // 红线：点错人不会让本条命令失败，只会让后续关注 / 读粉丝数全部记到别人账上。
  const dom = install(`<body><div class="note-detail-mask">${profileLinkHtml(PROFILE_B)}</div></body>`, DETAIL_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'profile_open', params: { authorId: PROFILE_A } });

  assert.equal(result.effectPhase, 'not_started');
  const value = receipt(result);
  assert.equal(value.reason, 'profile_target_mismatch');
  // 「不是要找的那个」与「没找到」区分开，但**都必须一下都没点**。
  assert.equal(counter.clicks, 0);
});

test('点中指定作者并真的跳到他的主页才算确认', async () => {
  const dom = install(`<body><div class="note-detail-mask">${profileLinkHtml(PROFILE_A)}</div></body>`, DETAIL_URL);
  const counter = navigateProfileOnClick(dom, PROFILE_A);

  const result = await runRouter({ kind: 'profile_open', params: { authorId: PROFILE_A } });

  assert.equal(counter.clicks, 1);
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'profile_detail');
  assert.equal(result.output.value.authorId, PROFILE_A);
});

test('★ 点了但没跳到主页时是 ambiguous，绝不回确认', async () => {
  const dom = install(`<body><div class="note-detail-mask">${profileLinkHtml(PROFILE_A)}</div></body>`, DETAIL_URL);
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'profile_open', params: { authorId: PROFILE_A } });

  assert.equal(counter.clicks, 1);
  assert.equal(result.effectPhase, 'ambiguous');
  assert.notEqual(result.effectPhase, 'confirmed');
  const value = receipt(result);
  assert.equal(value.action, 'open_profile');
  assert.equal(value.reason, 'profile_navigation_unconfirmed');
});

test('★ 跳到了主页但跳错了人时同样不确认', async () => {
  // 这一条与上一条是两个不同的失败：路径确实进了 /user/profile/，但不是指定的那个人。
  // 若只判「是不是主页路径」，跳错人会被当成成功。
  const dom = install(`<body><div class="note-detail-mask">${profileLinkHtml(PROFILE_A)}</div></body>`, DETAIL_URL);
  const counter = navigateProfileOnClick(dom, PROFILE_B);

  const result = await runRouter({ kind: 'profile_open', params: { authorId: PROFILE_A } });

  assert.equal(counter.clicks, 1);
  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(receipt(result).reason, 'profile_navigation_unconfirmed');
});

test('已经站在指定作者主页上时直接回详情，不再多点一次', async () => {
  const dom = install(
    `<body><h1>作者甲</h1><div class="user-data"><span>12</span><span>340</span><span>56</span></div></body>`,
    `https://www.xiaohongshu.com/user/profile/${PROFILE_A}`,
  );
  const counter = countClicks(dom);

  const result = await runRouter({ kind: 'profile_open', params: { authorId: PROFILE_A } });

  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'profile_detail');
  assert.equal(result.output.value.authorId, PROFILE_A);
  assert.equal(counter.clicks, 0, '已经在目标页时不该再点任何东西');
});
