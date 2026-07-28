import assert from 'node:assert/strict';
import test from 'node:test';
import { installXhsDom, runXhsRouter as run, type RouterResult } from './xhs-dom-fixture.js';

/**
 * 小红书页面规则的「动作诚实」平价测试（change restore-native-xiaohongshu-action-honesty，任务 1.1–1.11）。
 *
 * 全部用例**当前应为红**：它们表征的是 2026-07-22 页面执行切到 Rust 引擎后
 * 小红书命令面的行为退化（退役 TypeScript 实现里做得到、迁移后做不到的那些）。
 * 参照书见 openspec/changes/restore-native-xiaohongshu-action-honesty/oracle.md。
 */

type Receipt = Record<string, unknown>;

/** 从命令输出里取动作回执：兼容 `action_receipt` 与（2.3a 决策的）`action_receipt_with_observation`。 */
function receiptOf(result: RouterResult): Receipt | null {
  const output = result.output;
  if (!output || typeof output !== 'object') return null;
  if (output.kind === 'action_receipt') return output.value;
  if (output.kind === 'action_receipt_with_observation') {
    const receipt = output.value?.receipt;
    return receipt && typeof receipt === 'object' ? (receipt as Receipt) : null;
  }
  return null;
}

function requireReceipt(result: RouterResult, where: string): Receipt {
  const receipt = receiptOf(result);
  assert.ok(
    receipt,
    `${where}: 终局必须是动作回执，实际输出 kind=${result.output?.kind}`,
  );
  return receipt as Receipt;
}

/** 解析 `browsed=N` / `scrolled=N` 这类云端要读的实测计数（deep-reader.ts:39 / comment-reviewer.ts:200）。 */
function parseReasonCount(reason: unknown, key: string): number | null {
  if (typeof reason !== 'string') return null;
  const hit = reason.match(new RegExp(`${key}=(\\d+)`));
  return hit ? Number(hit[1]) : null;
}

// ── 1.1 评论：联系方式串码必须随正文一起提交 ───────────────────────────────

test('1.1 提交给编辑器的评论文本同时含正文与联系方式串码', async () => {
  const { dom } = installXhsDom(
    `<main><div class="note-detail-mask">
       <div class="engage-bar active">
         <div class="content-edit"><span class="not-active">说点什么...</span></div>
         <p id="content-textarea" contenteditable="true"></p>
         <button id="submit" class="btn submit">发送</button>
       </div>
       <div class="comment-list"></div>
     </div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const doc = dom.window.document;
  const submittedTexts: string[] = [];
  doc.querySelector('#submit')?.addEventListener('click', () => {
    submittedTexts.push(doc.querySelector('#content-textarea')?.textContent ?? '');
  });

  await run({
    kind: 'interaction_comment',
    params: { noteId: 'n1', text: '这条评论正文', groupChatCode: '群聊暗号 ABC-8899' },
  });

  assert.equal(submittedTexts.length, 1, '应当只派发一次提交');
  const submitted = submittedTexts[0];
  assert.ok(submitted.includes('这条评论正文'), `提交文本缺正文：${submitted}`);
  assert.ok(
    submitted.includes('群聊暗号 ABC-8899'),
    `提交文本缺联系方式串码（审=发被破坏）：${submitted}`,
  );
});

// ── 1.2 开帖：错误页不得判成功 ─────────────────────────────────────────────

test('1.2 地址仍含笔记 id 但停在错误页时不得直接回详情', async () => {
  // 幂等早退路径（router:188）：地址里有笔记 id，但页面是 300031 错误页。
  installXhsDom(
    `<main><div class="error-page">当前笔记暂时无法浏览</div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const alreadyThere = await run({ kind: 'note_open', params: { noteId: 'n1' } });
  assert.notEqual(
    alreadyThere.output.kind,
    'note_detail',
    '错误页被当成「已在目标笔记」直接回了详情（云端收到详情即记一笔浏览）',
  );
  assert.notEqual(alreadyThere.effectPhase, 'confirmed', '错误页不得判 confirmed');
});

test('1.2 点开封面后弹出的是错误页容器时不得产出 note_detail', async () => {
  // 点击路径（router:194）：点封面后 SPA 就地弹出的是错误页容器。
  const { dom } = installXhsDom(
    `<main><section class="note-item"><a id="cover" href="/explore/n7">封面</a></section></main>`,
    'https://www.xiaohongshu.com/explore',
  );
  dom.window.document.querySelector('#cover')?.addEventListener('click', (event) => {
    event.preventDefault();
    const mask = dom.window.document.createElement('div');
    mask.className = 'note-detail-mask';
    mask.innerHTML = '<div class="error-page">当前笔记暂时无法浏览</div>';
    dom.window.document.body.appendChild(mask);
  });
  const afterClick = await run({ kind: 'note_open', params: { noteId: 'n7' } });
  assert.notEqual(
    afterClick.output.kind,
    'note_detail',
    '点开后是错误页容器，仍被当成打开成功',
  );
  assert.notEqual(afterClick.effectPhase, 'confirmed', '错误页不得判 confirmed');
});

// ── 1.3 开帖：详情容器在但三项皆空 → ambiguous ─────────────────────────────

test('1.3 详情容器存在但标题正文图片皆空时回 ambiguous 而非确认详情', async () => {
  installXhsDom(
    `<main><div class="note-detail-mask"><div class="note-scroller"></div></div></main>`,
    'https://www.xiaohongshu.com/explore/n2',
  );
  const result = await run({ kind: 'note_open', params: { noteId: 'n2' } });
  assert.equal(
    result.effectPhase,
    'ambiguous',
    '无任何正面详情证据（标题/正文/图片全空）却判成确认打开',
  );
  assert.notEqual(result.output.kind, 'note_detail', '未确认打开不得产出 note_detail');
});

// ── 1.4 / 1.5 / 1.11 看图 ──────────────────────────────────────────────────

interface CarouselFixture {
  dom: ReturnType<typeof installXhsDom>['dom'];
  advances: () => number;
}

/**
 * 造一个真实形态的图片轮播：`.swiper-slide`（含 swiper loop 复制的首尾）+ `.arrow-controller.right`。
 * 点右箭头把 `swiper-slide-active` 前移一张，并把新露出那张的图片 URL 真装上（模拟翻页中新加载的图）。
 */
function installCarousel(options: { slides: number; replaceArrowAfterFirstAdvance?: boolean }): CarouselFixture {
  const realSlides = Array.from({ length: options.slides }, (_, index) => {
    const active = index === 0 ? ' swiper-slide-active' : '';
    const src = index === 0 ? ` src="https://ci.xiaohongshu.com/img${index + 1}.jpg"` : '';
    return `<div class="swiper-slide${active}"><img data-src="https://ci.xiaohongshu.com/img${index + 1}.jpg"${src}></div>`;
  }).join('');
  const { dom } = installXhsDom(
    `<main><div class="note-detail-mask">
       <div id="detail-title" class="title">一篇有图的笔记</div>
       <div id="detail-desc">正文内容在这里</div>
       <div class="swiper">
         <div class="swiper-slide swiper-slide-duplicate"><img src="https://ci.xiaohongshu.com/dup-head.jpg"></div>
         ${realSlides}
         <div class="swiper-slide swiper-slide-duplicate"><img src="https://ci.xiaohongshu.com/dup-tail.jpg"></div>
       </div>
       <div id="next-arrow" class="arrow-controller right swiper-button-next">下一张</div>
     </div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const doc = dom.window.document;
  let advances = 0;
  const advance = (): void => {
    const slides = Array.from(
      doc.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate)'),
    );
    const index = slides.findIndex((slide) => slide.classList.contains('swiper-slide-active'));
    if (index < 0 || index + 1 >= slides.length) return;
    slides[index].classList.remove('swiper-slide-active');
    const next = slides[index + 1];
    next.classList.add('swiper-slide-active');
    const img = next.querySelector('img');
    if (img && !img.getAttribute('src')) img.setAttribute('src', img.getAttribute('data-src') ?? '');
    advances += 1;
  };
  const onArrowClick = (event: Event): void => {
    const arrow = event.currentTarget as Element;
    // 「已废」的替换件不再推进图序（表征：控件被换掉后旧引用点不动、新引用点了也不前进）
    if (!arrow.hasAttribute('data-spent')) advance();
    if (!options.replaceArrowAfterFirstAdvance) return;
    const replacement = arrow.cloneNode(true) as Element;
    replacement.setAttribute('data-spent', 'true');
    arrow.replaceWith(replacement);
    replacement.addEventListener('click', onArrowClick);
  };
  doc.querySelector('#next-arrow')?.addEventListener('click', onArrowClick);
  return { dom, advances: () => advances };
}

test('1.4 看图返回动作回执并带实测前进张数', async () => {
  const carousel = installCarousel({ slides: 4 });
  const result = await run({ kind: 'note_browse_images', params: { noteId: 'n1', count: 2 } });
  const receipt = requireReceipt(result, '看图命中轮播');
  assert.equal(receipt.action, 'browse_images', '云端深读角色按动作名 browse_images 精确匹配');
  assert.equal(receipt.ok, true);
  assert.ok(carousel.advances() > 0, '轮播图序一次都没真前进（控件没点动，却回了成功回执）');
  assert.equal(
    parseReasonCount(receipt.reason, 'browsed'),
    carousel.advances(),
    `回执张数须等于实测前进张数（实测 ${carousel.advances()}），reason=${String(receipt.reason)}`,
  );
});

test('1.4 无图片轮播时回 no_target 回执且不伪造图片快照', async () => {
  installXhsDom(
    `<main><div class="note-detail-mask"><div id="detail-title">纯文字笔记</div><div id="detail-desc">没有图</div></div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const noCarousel = await run({ kind: 'note_browse_images', params: { noteId: 'n1', count: 3 } });
  const noTarget = requireReceipt(noCarousel, '看图无轮播');
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.reason, 'no_target');
  assert.equal(noCarousel.effectPhase, 'not_started');
  assert.notEqual(noCarousel.output.kind, 'note_detail', '无轮播不得伪造图片快照');
});

test('1.5 翻页控件在首次前进后被替换 → 回执张数等于实际前进次数而非请求张数', async () => {
  const carousel = installCarousel({ slides: 5, replaceArrowAfterFirstAdvance: true });
  const result = await run({ kind: 'note_browse_images', params: { noteId: 'n1', count: 3 } });
  const receipt = requireReceipt(result, '看图控件被替换');
  const browsed = parseReasonCount(receipt.reason, 'browsed');
  assert.notEqual(browsed, 3, '绝不回报请求张数');
  assert.equal(
    carousel.advances(),
    1,
    `控件被替换后图序只可能前进一张（替换件不再推进），实际前进 ${carousel.advances()} 张`,
  );
  assert.equal(browsed, 1, `回执须回报实测的 1 张，reason=${String(receipt.reason)}`);
});

test('1.11 看图过程中新加载的图片随本次命令的唯一终局一并到达云端', async () => {
  const carousel = installCarousel({ slides: 4 });
  const result = await run({ kind: 'note_browse_images', params: { noteId: 'n1', count: 2 } });

  // 一条命令只有一个终局：单个 output，不是回执 + 详情两条。
  assert.deepEqual(Object.keys(result).sort(), ['effectPhase', 'output']);
  assert.equal(
    result.output.kind,
    'action_receipt_with_observation',
    '终局须是「回执 + 随行观测」，既不能只回详情（云端深读永久挂起），也不能丢掉图片证据',
  );
  const receipt = requireReceipt(result, '看图携带观测');
  assert.equal(receipt.action, 'browse_images');
  assert.equal(parseReasonCount(receipt.reason, 'browsed'), carousel.advances());

  const noteDetail = result.output.value.noteDetail as Record<string, unknown> | undefined;
  assert.ok(noteDetail, '成功翻图须随行携带详情快照（云端参考图刷新与观测笔记的唯一来源）');
  assert.equal(noteDetail.refreshOnly, true, '随行快照须标 refreshOnly，避免被当成一次新的浏览计数');
  assert.equal(noteDetail.noteId, 'n1');
  assert.ok(String(noteDetail.title ?? '').length > 0, '随行快照须是完整详情，不能只塞图片');
  const images = (noteDetail.images ?? []) as Array<{ url?: string }>;
  const urls = images.map((image) => String(image.url ?? ''));
  assert.ok(
    urls.some((url) => url.includes('img3.jpg')),
    `翻页中新加载出的图片未随回执到达云端：${urls.join(',')}`,
  );
});

// ── 1.6 返回列表 ───────────────────────────────────────────────────────────

test('1.6 返回后落在非列表面时动作回执 ok=false', async () => {
  installXhsDom(
    `<main><div class="user-page">作者主页，没有任何笔记卡片</div></main>`,
    'https://www.xiaohongshu.com/user/profile/u1',
  );
  const result = await run({ kind: 'navigation_back', params: {} });
  const receipt = requireReceipt(result, '返回列表');
  assert.equal(receipt.ok, false, '未回到可用列表面却回执恒真（云端读的是回执 ok）');
});

// ── 1.7 / 1.8 点赞 / 收藏 ──────────────────────────────────────────────────

test('1.7 只解析互动条内的具名点赞控件，不落到聚合赞数与反向控件上', async () => {
  const { dom } = installXhsDom(
    `<main><div class="note-detail-mask">
       <div class="interactions engage-bar">
         <span class="like-wrapper" id="engage-like"><svg class="like-icon"><use xlink:href="#like"></use></svg><span class="count">311</span></span>
         <span class="collect-wrapper" id="engage-collect"><svg><use xlink:href="#collect"></use></svg><span class="count">88</span></span>
       </div>
       <div class="comments">
         <div class="comment-item">
           <span class="like-wrapper" id="comment-like"><svg><use xlink:href="#like"></use></svg><span class="count">12</span></span>
         </div>
         <button id="undo-like">取消赞</button>
       </div>
     </div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const clicked: string[] = [];
  dom.window.document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element;
      clicked.push(target.id || target.className || target.tagName);
    },
    true,
  );

  await run({ kind: 'interaction_like', params: { noteId: 'n1' } });
  assert.ok(clicked.includes('engage-like'), `未点到互动条内的具名点赞控件，实点：${clicked.join(',')}`);
  assert.ok(!clicked.includes('undo-like'), `点到了含「取消赞」的反向控件：${clicked.join(',')}`);
  assert.ok(!clicked.includes('comment-like'), `点到了评论区的聚合赞控件：${clicked.join(',')}`);
});

test('1.7 互动条缺失时回 control_not_found', async () => {
  installXhsDom(
    `<main><div class="note-detail-mask">
       <div class="comments"><div class="comment-item"><span class="like-wrapper">赞 12</span></div></div>
     </div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const noBar = await run({ kind: 'interaction_like', params: { noteId: 'n1' } });
  const receipt = requireReceipt(noBar, '互动条缺失');
  assert.equal(receipt.ok, false);
  assert.equal(
    receipt.reason,
    'control_not_found',
    '互动条不在时应诚实报找不到控件，而不是退化到评论区的同名控件上',
  );
});

/** 互动条 + 一个具名 like-wrapper；`flipAfterMs` 到点后把图标状态位翻成 `#liked`。 */
function installLikeBar(options: { flipAfterMs?: number }): void {
  const { dom } = installXhsDom(
    `<main><div class="note-detail-mask">
       <div class="interactions engage-bar">
         <span class="like-wrapper" id="engage-like"><svg class="like-icon"><use xlink:href="#like"></use></svg><span class="count">点赞 311</span></span>
       </div>
     </div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const doc = dom.window.document;
  doc.querySelector('#engage-like')?.addEventListener('click', () => {
    if (options.flipAfterMs === undefined) return;
    setTimeout(() => {
      doc.querySelector('#engage-like use')?.setAttribute('xlink:href', '#liked');
    }, options.flipAfterMs);
  });
}

test('1.8 首次采样之后、有界窗口之内才翻转的点赞判成功', async () => {
  installLikeBar({ flipAfterMs: 700 });
  const flipped = await run({ kind: 'interaction_like', params: { noteId: 'n1' } });
  const flippedReceipt = requireReceipt(flipped, '有界窗口内翻转');
  assert.equal(
    flippedReceipt.ok,
    true,
    '真机翻转多在 300–600ms、上限 1500ms；固定睡 450ms 后单次采样会把已生效的点赞误报为未确认',
  );
});

test('1.8 全程不翻转回 ambiguous state_unchanged', async () => {
  installLikeBar({});
  const never = await run({ kind: 'interaction_like', params: { noteId: 'n1' } });
  const neverReceipt = requireReceipt(never, '全程不翻转');
  assert.equal(neverReceipt.ok, false);
  assert.equal(neverReceipt.reason, 'state_unchanged');
});

test('1.8 控件文本含「已」不得被提成成功', async () => {
  const { dom } = installXhsDom(
    `<main><div class="note-detail-mask">
       <div class="interactions engage-bar">
         <span class="collect-wrapper" id="engage-collect"><svg><use xlink:href="#collect"></use></svg><span class="label">收藏</span></span>
       </div>
     </div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const doc = dom.window.document;
  doc.querySelector('#engage-collect')?.addEventListener('click', () => {
    // 文案变了但图标状态位没翻 —— 平台上「已」字文案随处可见，不是收藏生效的证据
    const label = doc.querySelector('#engage-collect .label');
    if (label) label.textContent = '已收藏';
  });
  const result = await run({ kind: 'interaction_collect', params: { noteId: 'n1' } });
  const receipt = requireReceipt(result, '「已」字兜底');
  assert.notEqual(receipt.ok, true, '控件文本含「已」被当成收藏成功（唯一还能返回成功的路径，且必然误报）');
});

// ── 1.9 通知抽取 ───────────────────────────────────────────────────────────

const NOTIFICATION_TAB = '<button class="tab-item" id="tab-comments">评论和@</button>';

function installNotificationPage(bodyHtml: string): void {
  const { dom } = installXhsDom(
    `<main>${NOTIFICATION_TAB}${bodyHtml}</main>`,
    'https://www.xiaohongshu.com/notification',
  );
  dom.window.document.querySelector('#tab-comments')?.addEventListener('click', (event) => {
    (event.currentTarget as Element).setAttribute('data-active', 'true');
  });
}

function itemsOf(result: RouterResult): Array<Record<string, unknown>> {
  assert.equal(result.output.kind, 'notification_items', '「评论和@」终局仍是 notification_items 输出');
  return (result.output.value.items ?? []) as Array<Record<string, unknown>>;
}

test('1.9 通知行只取真实通知行，头像行与裸列表项不得混入', async () => {
  installNotificationPage(`
    <div class="tabs-content-container">
      <div class="container">
        <a class="user-avatar" href="/user/profile/u1"></a>
        <div class="user-info"><a href="/user/profile/u1">小明</a></div>
        <div class="interaction-hint">评论了你的笔记</div>
        <div class="interaction-content">第一条评论正文</div>
        <span class="interaction-time">3分钟前</span>
      </div>
      <div class="container">
        <a class="user-avatar" href="/user/profile/u1"></a>
        <div class="user-info"><a href="/user/profile/u1">小明</a></div>
        <div class="interaction-hint">评论了你的笔记</div>
        <div class="interaction-content">第二条评论正文</div>
        <span class="interaction-time">5分钟前</span>
      </div>
    </div>
    <ul class="side-nav"><li>侧栏项</li><li>另一个菜单</li></ul>
  `);
  const result = await run({ kind: 'notification_browse_comments', params: {} });
  const items = itemsOf(result);
  assert.deepEqual(
    items.map((item) => item.content),
    ['第一条评论正文', '第二条评论正文'],
    '行选择器命中了裸列表项 / 头像行，或漏掉了真实通知行',
  );
  assert.deepEqual(
    items.map((item) => item.fromUser),
    ['小明', '小明'],
  );
});

test('1.9 同一发送者的多条通知 itemKey 互不相同或为空', async () => {
  // 两行同时命中新旧两套行选择器，隔离出「去重键怎么取」这一处差异
  installNotificationPage(`
    <div class="tabs-content-container">
      <div class="container notification-item">
        <div class="user-info"><a href="/user/profile/u9">阿星</a></div>
        <div class="interaction-content">第一条</div><span class="interaction-time">3分钟前</span>
      </div>
      <div class="container notification-item">
        <div class="user-info"><a href="/user/profile/u9">阿星</a></div>
        <div class="interaction-content">第二条</div><span class="interaction-time">5分钟前</span>
      </div>
    </div>
  `);
  const items = itemsOf(await run({ kind: 'notification_browse_comments', params: {} }));
  assert.equal(items.length, 2);
  const keys = items.map((item) => String(item.itemKey ?? ''));
  assert.ok(
    keys.every((key) => key === '') || new Set(keys).size === 2,
    `同人两条评论的去重键撞成一个（会被云端折叠丢弃）：${keys.join(' | ')}`,
  );
});

test('1.9 无正文容器的通知行正文发空串，不回落整行文本', async () => {
  installNotificationPage(`
    <div class="tabs-content-container">
      <div class="container notification-item">
        <div class="user-info"><a href="/user/profile/u9">阿星</a></div>
        <div class="interaction-hint">赞了你的笔记</div>
        <span class="interaction-time">3分钟前</span>
      </div>
    </div>
  `);
  const items = itemsOf(await run({ kind: 'notification_browse_comments', params: {} }));
  assert.equal(items.length, 1);
  assert.equal(
    items[0].content,
    '',
    '正文容器缺失时回落成了「昵称+动作+时间」的整行文本（飞书 blob，且把时间灌进云端回退去重键）',
  );
});

// ── 1.10 滚动评论区 ────────────────────────────────────────────────────────

test('1.10 评论区未移动时动作回执 ok=false', async () => {
  const { dom } = installXhsDom(
    `<main><div class="note-detail-mask">
       <div class="comments" id="scroller">
         <div class="comment-item" id="comment-1">已经在底部了</div>
       </div>
     </div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const scroller = dom.window.document.querySelector('#scroller') as Element & {
    scrollBy?: (...args: unknown[]) => void;
  };
  // 已到底：怎么滚都不动
  Object.defineProperty(scroller, 'scrollTop', { get: () => 0, set: () => undefined, configurable: true });
  scroller.scrollBy = () => undefined;

  const result = await run({ kind: 'note_scroll_comments', params: { noteId: 'n1', count: 2 } });
  const receipt = requireReceipt(result, '评论区不可滚');
  assert.equal(receipt.ok, false, '未发生位移却回执恒真');
  assert.equal(receipt.reason, 'no_scroll');
});

test('1.10 回执里的评论条数等于滚动后实际可见条数，不是请求的步数', async () => {
  const { dom } = installXhsDom(
    `<main><div class="note-detail-mask">
       <div class="comments" id="scroller">
         <div class="comment-item" id="comment-1">评论一</div>
         <div class="comment-item" id="comment-2">评论二</div>
       </div>
     </div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  const doc = dom.window.document;
  const scroller = doc.querySelector('#scroller') as Element & { scrollBy?: (...args: unknown[]) => void };
  let position = 0;
  let loaded = false;
  const applyScroll = (delta: number): void => {
    position += delta;
    if (loaded) return;
    loaded = true;
    for (const index of [3, 4, 5]) {
      const row = doc.createElement('div');
      row.className = 'comment-item';
      row.id = `comment-${index}`;
      row.textContent = `评论${index}`;
      scroller.appendChild(row);
    }
  };
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => position,
    set: (value: number) => applyScroll(Number(value) - position),
    configurable: true,
  });
  scroller.scrollBy = (options?: unknown) => {
    const top =
      typeof options === 'number' ? options : Number((options as { top?: number } | undefined)?.top ?? 0);
    applyScroll(top || 500);
  };
  (dom.window as unknown as { scrollBy: (x?: number, y?: number) => void }).scrollBy = (_x, y) =>
    applyScroll(Number(y) || 500);

  const result = await run({ kind: 'note_scroll_comments', params: { noteId: 'n1', count: 2 } });
  const receipt = requireReceipt(result, '评论区已滚动');
  assert.equal(receipt.ok, true);
  const visibleRows = doc.querySelectorAll('#scroller .comment-item').length;
  assert.equal(visibleRows, 5, '夹具：滚动后共 5 条评论');
  assert.equal(
    parseReasonCount(receipt.reason, 'scrolled'),
    5,
    `回执须回报实测条数 5（云端 comment-reviewer 按 scrolled=N 记已读评论数），reason=${String(receipt.reason)}`,
  );
  assert.notEqual(parseReasonCount(receipt.reason, 'scrolled'), 2, '绝不回报请求的步数');
});
