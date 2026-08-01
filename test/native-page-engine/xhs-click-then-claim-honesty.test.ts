import assert from 'node:assert/strict';
import test from 'node:test';
import { installXhsDom, runXhsRouter as run, type RouterResult } from './xhs-dom-fixture.js';

/**
 * 「点了就算成功」这一族的两条（缺口清单 E13 / E14，change `restore-native-xiaohongshu-action-honesty` H.1）。
 *
 * 两条同形：**回报的是自己做了什么，声称的是平台发生了什么**。
 *  · feed 刷新：找到含「刷新」二字的控件 → 点 → 睡 900ms → 无条件回当前卡片。
 *    点到别的元素 / 点了没重载 / 重载了内容没变，三种都兑现成「已换新批」。
 *  · 通知分类浏览：点分类栏 → 睡 500ms → 无条件回「已看过」。
 *    点在包裹容器上 / 栏没切 / 切了列表没换，三种都兑现成「已清零」。
 *
 * 两条的危害都不是报错，而是**闭环空转且看不出来**：上游据此认为自己在前进，
 * 于是重复读同一批、或让未读一直挂着，而日志里每一条都是成功。
 *
 * 本组只钉「会错报成功」那一面：判据不成立时 MUST NOT 出现确认终局。
 * 方向诚实的悲观回执（该成功却回未确认）不在这里加护栏 —— 红线针对的是静默假成功。
 */

const EXPLORE_URL = 'https://www.xiaohongshu.com/explore';
const NOTIFICATION_URL = 'https://www.xiaohongshu.com/notification';

function receiptOf(result: RouterResult, where: string): Record<string, unknown> {
  assert.equal(result.output.kind, 'action_receipt', `${where}: 终局应当是动作回执`);
  return result.output.value;
}

// ── E13 · feed 刷新必须证明「换了一批」 ───────────────────────────────────────

/** 三张卡的信息流。`ids` 决定这一批是哪几篇。 */
function feedHtml(ids: string[]): string {
  const cards = ids
    .map((id) => `<section class="note-item"><a href="/explore/${id}">笔记 ${id}</a></section>`)
    .join('');
  return `<main><button id="refresh">刷新</button><div id="feed">${cards}</div></main>`;
}

function installFeed(ids: string[]) {
  const fixture = installXhsDom(feedHtml(ids), EXPLORE_URL);
  const clicked: string[] = [];
  fixture.dom.window.document.addEventListener(
    'click',
    (event) => clicked.push((event.target as Element).id || ''),
    true,
  );
  return { ...fixture, clicked };
}

/** 点刷新后把信息流换成另一批（平台真的重载了）。 */
function refreshInto(fixture: ReturnType<typeof installFeed>, ids: string[]): void {
  const { document } = fixture.dom.window;
  document.getElementById('refresh')!.addEventListener('click', () => {
    document.getElementById('feed')!.innerHTML = ids
      .map((id) => `<section class="note-item"><a href="/explore/${id}">笔记 ${id}</a></section>`)
      .join('');
  });
}

test('E13 点了刷新但这一批没换 —— 回未确认，绝不把旧卡片当新批', async () => {
  // 最要命的现场：控件点着了、页面纹丝不动。旧实现在这里回 confirmed + 当前卡片，
  // 于是上游按「新批」扣预算、去重之后无内容可读、再次触发刷新，如此往复到看门狗判空转。
  const fixture = installFeed(['n1', 'n2', 'n3']);

  const result = await run({ kind: 'feed_refresh', params: {} });

  assert.ok(fixture.clicked.includes('refresh'), '刷新控件本身要真点到，否则这条测的是别的失败');
  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(receiptOf(result, '刷新未换批').reason, 'refresh_batch_unchanged');
});

test('E13 真的换了一批才算确认', async () => {
  const fixture = installFeed(['n1', 'n2', 'n3']);
  refreshInto(fixture, ['n7', 'n8', 'n9']);

  const result = await run({ kind: 'feed_refresh', params: {} });

  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'page_cards');
  const cards = (result.output.value as { cards: { noteId?: string }[] }).cards;
  assert.deepEqual(
    cards.map((card) => card.noteId),
    ['n7', 'n8', 'n9'],
    '回的必须是刷新之后的那一批',
  );
});

test('E13 读不到卡片与「读到了、还是原来那批」是两态', async () => {
  // 刷新后页面上一张卡都读不出来：那是「不知道换没换」，不是「确实没换」。
  // 压成一态会让上游没法分辨该重试还是该停手。
  const fixture = installFeed(['n1', 'n2']);
  const { document } = fixture.dom.window;
  document.getElementById('refresh')!.addEventListener('click', () => {
    document.getElementById('feed')!.innerHTML = '';
  });

  const result = await run({ kind: 'feed_refresh', params: {} });

  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(receiptOf(result, '刷新后读不到卡片').reason, 'refresh_cards_unreadable');
});

// ── E14 · 通知分类浏览必须证明「那一类真切过去了」 ───────────────────────────

/**
 * 通知页：三个分类栏各带未读角标，内容区是当前显示那一类的行。
 * `active` 指定哪一栏处于激活态；`wrapperActive` 把激活态放在**包裹容器**上而不是叶子栏上
 * ——那正是当初不敢用这条信号的原因，要有用例钉住它不算数。
 */
function notificationHtml(
  badges: { comment: number; like: number; follow: number },
  rows: string[],
  options: { active?: string; wrapperActive?: string } = {},
): string {
  const tab = (label: string, count: number) =>
    `<div class="tab-item${options.active === label ? ' is-active' : ''}" id="tab-${label}">`
    + `${label}${count > 0 ? `<span class="badge">${count}</span>` : ''}</div>`;
  const wrap = (label: string, count: number) =>
    options.wrapperActive === label
      ? `<div class="tabs-wrapper is-active">${tab(label, count)}</div>`
      : tab(label, count);
  const body = rows.map((row) => `<div class="container">${row}</div>`).join('');
  return `<main>
    <div class="tabs">${wrap('评论和@', badges.comment)}${wrap('赞和收藏', badges.like)}${wrap('新增关注', badges.follow)}</div>
    <div class="tabs-content-container">${body}</div>
  </main>`;
}

function installNotifications(
  badges: { comment: number; like: number; follow: number },
  rows: string[],
  options: { active?: string; wrapperActive?: string } = {},
) {
  const fixture = installXhsDom(notificationHtml(badges, rows, options), NOTIFICATION_URL);
  const clicked: string[] = [];
  fixture.dom.window.document.addEventListener(
    'click',
    (event) => clicked.push((event.target as Element).id || ''),
    true,
  );
  return { ...fixture, clicked };
}

test('E14 分类栏点着了但那一类没切过去 —— 回未确认，绝不记成已清零', async () => {
  // 角标还挂着、列表一行没变：唯一发生过的事就是「我们点了一下」。
  const fixture = installNotifications({ comment: 0, like: 4, follow: 0 }, ['某人赞了你的笔记']);

  const result = await run({ kind: 'notification_browse_likes', params: {} });

  assert.ok(fixture.clicked.includes('tab-赞和收藏'), '分类栏本身要真点到');
  assert.equal(result.effectPhase, 'not_started');
  const receipt = (result.output.value as { receipt: Record<string, unknown> }).receipt;
  assert.equal(receipt.ok, false, '云端只有 ok===true 才判该类已处理 —— 这里绝不能是 true');
  assert.equal(receipt.reason, 'notification_category_unconfirmed');
});

test('E14 未读角标归零 = 平台受理了这次消费', async () => {
  const fixture = installNotifications({ comment: 0, like: 4, follow: 0 }, ['某人赞了你的笔记']);
  const { document } = fixture.dom.window;
  document.getElementById('tab-赞和收藏')!.addEventListener('click', () => {
    document.querySelector('#tab-赞和收藏 .badge')!.remove();
  });

  const result = await run({ kind: 'notification_browse_likes', params: {} });

  const receipt = (result.output.value as { receipt: Record<string, unknown> }).receipt;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.reason, 'viewed');
});

test('E14 叶子分类栏的激活态是直接证据 —— 它坐实的是「现在就在这一类上」', async () => {
  // 角标本来就是 0（没有可消费的未读）时，剩下唯一能证明「切过去了」的就是这条。
  installNotifications({ comment: 0, like: 0, follow: 0 }, [], { active: '赞和收藏' });

  const result = await run({ kind: 'notification_browse_likes', params: {} });

  const receipt = (result.output.value as { receipt: Record<string, unknown> }).receipt;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.reason, 'viewed');
});

test('E14 激活态长在包裹容器上 MUST NOT 算数', async () => {
  // 这正是当初把这条信号整个弃用的理由：包裹容器同样带激活态类名，拿它当证据等于没判据。
  // 判据只读**叶子**分类栏，所以这里必须仍然回未确认 —— 否则「收紧后重新启用」就是句空话。
  installNotifications({ comment: 0, like: 0, follow: 0 }, [], { wrapperActive: '赞和收藏' });

  const result = await run({ kind: 'notification_browse_likes', params: {} });

  assert.equal(result.effectPhase, 'not_started');
  const receipt = (result.output.value as { receipt: Record<string, unknown> }).receipt;
  assert.equal(receipt.ok, false);
  assert.equal(receipt.reason, 'notification_category_unconfirmed');
});

test('E14 评论类没确认切栏时 MUST NOT 把列表当成本类的结果送上去', async () => {
  // 评论类的成功终局是 items，云端凭 items 到达即结案。栏没切时读到的是**另一类**的行，
  // 送上去会污染到达去重与发送者名册 —— 所以这里必须是失败终局、且不带 items。
  const fixture = installNotifications({ comment: 3, like: 0, follow: 0 }, ['某人关注了你']);

  const result = await run({ kind: 'notification_browse_comments', params: {} });

  assert.ok(fixture.clicked.includes('tab-评论和@'));
  assert.equal(result.effectPhase, 'not_started');
  assert.equal(result.output.kind, 'action_receipt', '未确认时绝不能回 notification_items');
  assert.equal(receiptOf(result, '评论类未确认').reason, 'notification_category_unconfirmed');
});
