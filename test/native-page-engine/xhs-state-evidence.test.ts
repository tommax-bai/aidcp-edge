import assert from 'node:assert/strict';
import test from 'node:test';
import { installXhsDom, runXhsRouter as run, type RouterResult } from './xhs-dom-fixture.js';

/**
 * 「已生效」判据的证据强度（change restore-native-xiaohongshu-action-honesty，任务 H.2 / H.3 / H.4）。
 *
 * 被修的是两个**共享扇出点**：旧实现只要元素类名里出现 active / selected / liked / collected /
 * followed 任一子串就判「已生效」，于是
 *  ① 否定形（`not-selected` / `unliked`）被读成正证据；
 *  ② 「读不到状态」与「读到未生效」压成同一个 false —— 期望值为「关」时变成
 *    「没有任何证据也算达成」，连点都不点就回成功。
 * 七个决策点全部据此回 ok=true / 相位 confirmed，而这七处此前**零测试覆盖**。
 *
 * 这一组只钉「会错报成功」的那一面：判据不成立时 MUST NOT 出现确认终局。
 * 方向诚实的悲观回执（该成功却回未确认）不在这里加护栏——红线针对的是静默假成功。
 */

const SEARCH_URL = 'https://www.xiaohongshu.com/search_result?keyword=%E5%92%96%E5%95%A1';
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';
const NOTE_URL = 'https://www.xiaohongshu.com/explore/n1';

type Receipt = Record<string, unknown>;

function receiptOf(result: RouterResult, where: string): Receipt {
  assert.equal(result.output.kind, 'action_receipt', `${where}: 终局应当是动作回执`);
  return result.output.value;
}

/** 记录整页派发到的点击目标（id），用来钉「到底点没点」。 */
function trackClicks(dom: ReturnType<typeof installXhsDom>['dom']): string[] {
  const clicked: string[] = [];
  dom.window.document.addEventListener(
    'click',
    (event) => { clicked.push((event.target as Element).id || (event.target as Element).className); },
    true,
  );
  return clicked;
}

// ── 共享判据 × 搜索筛选确认（最高频消费点，每次评论支线搜索都跑）────────────────

function installSearchPage(chipClass: string): ReturnType<typeof installXhsDom>['dom'] {
  const { dom } = installXhsDom(
    `<main>
       <button id="opener">筛选</button>
       <div class="${chipClass}" id="chip">最多点赞</div>
       <section class="note-item"><a href="/explore/s1"><span class="title">卡片</span></a></section>
     </main>`,
    SEARCH_URL,
  );
  return dom;
}

test('H.4 否定形类名（not-selected）不再被读成正证据，筛选项必须真被点上', async () => {
  const dom = installSearchPage('filter-item not-selected');
  const clicked = trackClicks(dom);
  dom.window.document.querySelector('#chip')?.addEventListener('click', (event) => {
    (event.currentTarget as Element).setAttribute('class', 'filter-item selected');
  });

  const result = await run({ kind: 'search_execute', params: { keyword: '咖啡', sort: 'most_liked' } });

  assert.ok(clicked.includes('chip'), '`not-selected` 是反证据：旧判据把它当成已选中，连点都不点');
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'page_cards');
});

test('H.2 筛选状态读不到时不返回卡片，诚实回未确认', async () => {
  // 判据不成立就 `return done(cards())` 是最高频的那条假成功：云端按最多收藏 / 一天内下发，
  // 拿回来的却是未筛选的首页序结果，日志里看不出任何降级痕迹。
  const dom = installSearchPage('chip');
  const clicked = trackClicks(dom);

  const result = await run({ kind: 'search_execute', params: { keyword: '咖啡', sort: 'most_liked' } });

  assert.ok(clicked.includes('chip'), '读不到状态时必须去点，不能当成「本来就选上了」');
  assert.notEqual(result.output.kind, 'page_cards', '筛选没确认却把卡片当筛过的返回 = 静默假成功');
  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(receiptOf(result, '筛选未确认').reason, 'search_filter_unconfirmed');
});

test('H.4 真已选中的筛选项不重复点击', async () => {
  const dom = installSearchPage('filter-item selected');
  const clicked = trackClicks(dom);

  const result = await run({ kind: 'search_execute', params: { keyword: '咖啡', sort: 'most_liked' } });

  assert.equal(clicked.includes('chip'), false, '明确读到 on 时的早退是对的，不该被一并改掉');
  assert.equal(result.output.kind, 'page_cards');
});

// ── 发布布尔开关（三个对外可见的平台合规声明走这条路）────────────────────────

function installOptionRow(inner: string): ReturnType<typeof installXhsDom>['dom'] {
  const { dom } = installXhsDom(
    `<main><div class="option-item">${inner}</div></main>`,
    PUBLISH_URL,
  );
  return dom;
}

test('H.2 期望值为「关」而状态读不到时仍然会去点，不再「没证据 = 达成」', async () => {
  // 旧写法 `selected(control)===desired`：读不到压成 false，desired=false ⇒ `false===false`
  // ⇒ 直接回 already_active / ok=true，连开关都不碰。这是静默假成功最纯粹的形态。
  const dom = installOptionRow('<span id="label">AI创作</span><div role="switch" id="switch">开关</div>');
  const clicked = trackClicks(dom);

  const result = await run({
    kind: 'publish_set_option',
    params: { recordId: 1, seq: 3, optionKind: 'declaration_ai', optionValue: 'false' },
  });

  assert.ok(clicked.includes('switch'), '读不到状态 ⇒ 必须去点，绝不当成已达成');
  assert.equal(result.effectPhase, 'ambiguous');
  const receipt = receiptOf(result, '开关未确认');
  assert.equal(receipt.ok, false);
  assert.equal(receipt.reason, 'publish_option_unconfirmed');
});

test('H.4 真开关按真实状态位收敛到期望值', async () => {
  const dom = installOptionRow('<span id="label">AI创作</span><input type="checkbox" id="switch" checked>');

  const result = await run({
    kind: 'publish_set_option',
    params: { recordId: 1, seq: 3, optionKind: 'declaration_ai', optionValue: 'false' },
  });

  assert.equal((dom.window.document.querySelector('#switch') as HTMLInputElement).checked, false);
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(receiptOf(result, '开关已收敛').ok, true);
});

test('H.2 行内没有真开关控件时诚实报找不到，不拿整行冒充开关', async () => {
  const dom = installOptionRow('<span id="label">AI创作</span><span id="hint">请阅读声明规范</span>');
  const clicked = trackClicks(dom);

  const result = await run({
    kind: 'publish_set_option',
    params: { recordId: 1, seq: 3, optionKind: 'declaration_ai', optionValue: 'false' },
  });

  assert.deepEqual(clicked, [], '`||row` 兜底拿整行 div 当开关，读不到状态还回成功');
  assert.equal(result.effectPhase, 'not_started');
  assert.equal(receiptOf(result, '无开关控件').reason, 'publish_option_not_found');
});

test('H.2 取值行写着「不公开」不得被当成「公开」已生效的回显', async () => {
  const { dom } = installXhsDom(
    `<main>
       <div class="option-item" id="row"><span id="label">可见范围</span><div class="current">不公开</div></div>
       <div class="dropdown"><span id="opt">公开</span></div>
     </main>`,
    PUBLISH_URL,
  );
  const clicked = trackClicks(dom);

  const result = await run({
    kind: 'publish_set_option',
    params: { recordId: 1, seq: 4, optionKind: 'visibility', optionValue: '公开' },
  });

  assert.ok(clicked.includes('opt'), '取值项仍要真点');
  assert.equal(result.effectPhase, 'ambiguous', '裸 includes 会把「不公开」读成「公开」——那是反证据');
  assert.equal(receiptOf(result, '取值未确认').reason, 'publish_option_unconfirmed');
});

// ── 设为封面（今天云端不下发，通电即生效的潜伏项）──────────────────────────

test('H.3 轮播「当前显示」的类名不再让设封面跳过点击', async () => {
  // 图区是轮播结构：旧写法往上找容器时最后一项是任意 `div`，会停在带「当前显示」类名的
  // 那层上，`selected(tile)` 于是恒真 ⇒ 连「设为封面」都不点就回 ok=true / confirmed。
  const { dom } = installXhsDom(
    `<main>
       <div class="img-preview-area">
         <div class="preview-item swiper-slide-active" id="slide"><img src="one.jpg"></div>
       </div>
       <button id="set-cover">设为封面</button>
     </main>`,
    PUBLISH_URL,
  );
  const clicked = trackClicks(dom);

  const result = await run({ kind: 'publish_set_cover', params: { recordId: 1, seq: 5, imageIndex: 0 } });

  assert.ok(clicked.includes('set-cover'), '「这张图正在显示」不是「这张图已是封面」');
  assert.equal(result.effectPhase, 'ambiguous', '没有封面专属标记就没有封面证据');
  assert.equal(receiptOf(result, '封面未确认').reason, 'publish_cover_unconfirmed');
});

// ── 详情页给别人的评论点赞（今天云端不产出候选，通电即生效的潜伏项）──────────

function installCommentRow(): ReturnType<typeof installXhsDom>['dom'] {
  const { dom } = installXhsDom(
    `<main><div class="note-detail-mask">
       <div class="comment-item active" data-comment-id="c1" id="row">
         <span class="like-wrapper active" id="like"><svg><use xlink:href="#like"></use></svg><span class="count">赞 3</span></span>
       </div>
     </div></main>`,
    NOTE_URL,
  );
  return dom;
}

test('H.3 评论行带 active 类名但图标未翻时不得早退成 already_active', async () => {
  // 旧判据：类名含 active ⇒ 回 ok=true / already_active、**不点击**。云端据此写风控事实、
  // 扣评论赞配额、把该评论归档进语料库，而页面上什么都没发生。
  const dom = installCommentRow();
  const clicked = trackClicks(dom);
  dom.window.document.querySelector('#like')?.addEventListener('click', (event) => {
    (event.currentTarget as Element).querySelector('use')?.setAttribute('xlink:href', '#liked');
  });

  const result = await run({
    kind: 'interaction_like_comment',
    params: { noteId: 'n1', commentAnchorId: 'c1' },
  });

  assert.ok(clicked.includes('like'), '类名激活态不是「这条评论我赞过了」的证据，必须真点');
  const receipt = receiptOf(result, '评论赞');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.reason, undefined, '真点上的赞不该带 already_active（那是 no-op 的标记）');
});

test('H.3 评论赞图标始终不翻时回未确认，不靠类名提成成功', async () => {
  const dom = installCommentRow();
  const clicked = trackClicks(dom);

  const result = await run({
    kind: 'interaction_like_comment',
    params: { noteId: 'n1', commentAnchorId: 'c1' },
  });

  assert.ok(clicked.includes('like'));
  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(receiptOf(result, '评论赞未翻转').reason, 'postcondition_unconfirmed');
});

// ── v1 兼容步骤（潜伏假成功：今天云端把 action.result 当纯观测丢掉）──────────

function firstStep(result: RouterResult): Record<string, unknown> {
  const results = (result.output.value.results ?? []) as Array<Record<string, unknown>>;
  return results[0] ?? {};
}

test('H.2 兼容点击步骤改读图标状态位；单次尝试不得报升级', async () => {
  installXhsDom(
    '<main><div class="engage" id="wrap"><span id="like" class="like-wrapper active">赞</span></div></main>',
    NOTE_URL,
  );

  const result = await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'note.like_button', op: 'click' }] },
  });

  const step = firstStep(result);
  assert.equal(step.ok, false, '类名含 active 不是点赞生效的证据');
  assert.equal(step.outcome, 'escalated');
  assert.equal(
    step.attempts,
    3,
    '「这一次没看到结果」与「重试到顶、判平台系统性改版」是两回事：报升级就得真重试过',
  );
});

test('H.2 兼容点击步骤在状态位真翻转时一次成功', async () => {
  const { dom } = installXhsDom(
    '<main><span id="like" class="like-wrapper"><svg><use xlink:href="#like"></use></svg>赞</span></main>',
    NOTE_URL,
  );
  dom.window.document.querySelector('#like')?.addEventListener('click', (event) => {
    (event.currentTarget as Element).querySelector('use')?.setAttribute('xlink:href', '#liked');
  });

  const step = firstStep(await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'note.like_button', op: 'click' }] },
  }));
  assert.equal(step.ok, true);
  assert.equal(step.outcome, 'success');
  assert.equal(step.attempts, 1);
});

test('H.2 兼容路径的评论输入框不再无条件回成功', async () => {
  // 旧写法：`ok = selected(el) || step.actionId==='note.comment_input'` —— 只要步骤是评论框，
  // 无论页面发生了什么都 ok=true / success，click 返回假（压根没点着）也照报成功。
  const { dom } = installXhsDom(
    '<main><div id="editor" contenteditable="true" tabindex="0">评论</div></main>',
    NOTE_URL,
  );

  const blind = firstStep(await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'note.comment_input', op: 'click' }] },
  }));
  assert.equal(blind.ok, false, '点评论框的业务结果是它拿到焦点，没有结果就不是成功');

  dom.window.document.querySelector('#editor')?.addEventListener('click', (event) => {
    (event.currentTarget as HTMLElement).focus();
  });
  const focused = firstStep(await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'note.comment_input', op: 'click' }] },
  }));
  assert.equal(focused.ok, true);
  assert.equal(focused.outcome, 'success');
});

// ── 发布地点 / 合集候选 ──────────────────────────────────────────────────────

test('H.2 候选列表被圈在入口容器里时不得靠「行文本含目标值」自证', async () => {
  // 候选项文本恒等于目标值：往上找容器时把候选列表一并圈进来，`text(row).includes(value)`
  // 就变成「点开列表即确认成功」。
  const { dom } = installXhsDom(
    `<main><div class="field-item" id="field">
       <button id="entry">地点</button>
       <div class="dropdown"><span id="cand">上海中心大厦</span></div>
     </div></main>`,
    PUBLISH_URL,
  );
  const clicked = trackClicks(dom);

  const blind = await run({
    kind: 'publish_add_with_candidate',
    params: { recordId: 1, seq: 6, candidateKind: 'location', value: '上海中心大厦' },
  });
  assert.ok(clicked.includes('cand'), '候选项仍要真点');
  assert.equal(blind.effectPhase, 'ambiguous');
  assert.equal(receiptOf(blind, '候选自证').reason, 'publish_candidate_unconfirmed');

  dom.window.document.querySelector('#cand')?.addEventListener('click', (event) => {
    (event.currentTarget as Element).setAttribute('aria-selected', 'true');
  });
  const confirmed = await run({
    kind: 'publish_add_with_candidate',
    params: { recordId: 1, seq: 7, candidateKind: 'location', value: '上海中心大厦' },
  });
  assert.equal(confirmed.effectPhase, 'confirmed');
  assert.equal(receiptOf(confirmed, '候选已选中').ok, true);
});
