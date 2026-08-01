import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installXhsDom, runXhsRouter as run } from './xhs-dom-fixture.js';

/**
 * 兼容步骤路径的「升级结论必须带实测次数」合约（change
 * restore-native-actuation-humanization-and-locating，任务 1.6）。
 *
 * 立论**不是**「全文件不得出现 escalated + attempts:1」——那会把一条已被属主具名裁定为
 * 正确的行为判红（滚动步没有校验重试循环，滚不动是结构性到底，见下面最后一条用例）。
 * 立论是：**凡是经过校验重试循环得出的升级结论，回报的次数必须是实测出来的**。
 * 「这一次没看到结果」与「连续重试到顶、判平台系统性改版」是两件事，上游要据此决定
 * 重试还是停手；硬写 1 等于把请求形状当成实测过程回报，两件事从此不可区分。
 *
 * 本文件**不改被测文件**（`native/page-engine/src/xhs-command-router.js` 归
 * `restore-native-xiaohongshu-action-honesty`），只在本 change 的测试目录里立合约。
 *
 * 时间线诚实说明：本条的「先红后绿」窗口**没有走成** —— 实现侧的修正由单写区属主先落
 * （`aidcp-edge 52a2110`），本文件是事后补的回归保护。判别力由变异实测坐实：把任一处
 * `attempts` 改回硬写 1，对应用例当场转红。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 校验重试循环的上限（被测文件里的 `COMPAT_MAX_ATTEMPTS`）。这里独立写死，不从被测源码里取——
 *  拿被测常量当尺子量被测行为，等于让它自己给自己打分。 */
const EXPECTED_RETRY_CAP = 3;

/** 每一条走「点击 + 后置校验」重试循环的兼容步骤，以及一份让它**永远确认不上**的页面。 */
const CLICK_STEPS: Array<{ actionId: string; html: string }> = [
  // 图标状态位永远停在未生效：赞点了、状态位不翻。
  { actionId: 'note.like_button', html: '<div class="like-icon-off">赞</div>' },
  { actionId: 'note.collect_button', html: '<div class="collect-icon-off">收藏</div>' },
  // 文案永远停在「关注」，不会变成「已关注」。
  { actionId: 'note.follow_button', html: '<div class="follow-btn">关注</div>' },
  // 评论输入框的业务结果是「它拿到了焦点」；这里是个普通 div，点了也不会成为 activeElement。
  { actionId: 'note.comment_input', html: '<div class="comment-entry">评论</div>' },
];

function firstResult(result: { output: { value: Record<string, unknown> } }): Record<string, unknown> {
  const results = (result.output.value.results ?? []) as Array<Record<string, unknown>>;
  return results[0] ?? {};
}

for (const { actionId, html } of CLICK_STEPS) {
  test(`1.6 ${actionId} 确认不上时的升级结论带实测重试次数`, async () => {
    installXhsDom(`<main>${html}</main>`);

    const result = await run({
      kind: 'plan_execute',
      params: { steps: [{ actionId, op: 'click' }] },
    });

    const step = firstResult(result);
    assert.equal(step.ok, false);
    assert.equal(step.outcome, 'escalated', '点出去了但一直确认不上，才配叫升级');
    assert.equal(
      step.attempts,
      EXPECTED_RETRY_CAP,
      '升级的前提是重试打满；回报 1 等于把请求形状当实测过程，上游无从区分「该重试」与「该停手」',
    );
  });
}

test('1.6 输入步确认不上时的升级结论同样带实测重试次数', async () => {
  // 平台把写进去的内容吃掉：回读恒等于原样，与写入值永远对不上。
  const { dom } = installXhsDom('<div contenteditable="true">评论</div>');
  const box = dom.window.document.querySelector('[contenteditable]')!;
  Object.defineProperty(box, 'textContent', {
    configurable: true,
    get: () => '评论',
    set: () => {},
  });

  const result = await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'note.comment_input', op: 'input', value: '这条正文写不进去' }] },
  });

  const step = firstResult(result);
  assert.equal(step.ok, false);
  assert.equal(step.outcome, 'escalated');
  assert.equal(step.reason, 'input_readback_mismatch');
  assert.equal(step.attempts, EXPECTED_RETRY_CAP, '同上：升级必须是重试打满之后的结论');
});

test('1.6 一次就成的输入步回报 1 —— 次数是量出来的，不是两个常量之一', async () => {
  installXhsDom('<div contenteditable="true">评论</div>');

  const result = await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'note.comment_input', op: 'input', value: '这条写得进去' }] },
  });

  const step = firstResult(result);
  assert.equal(step.ok, true);
  assert.equal(step.outcome, 'success');
  assert.equal(step.attempts, 1, '把 attempts 硬写成上限同样是回报请求形状，方向相反而已');
});

test('1.6 找不到目标的步骤仍回 no_target —— 那不是「升级」，别顺手统一成一档', async () => {
  installXhsDom('<main><div>页面上没有任何互动控件</div></main>');

  const result = await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'note.like_button', op: 'click' }] },
  });

  const step = firstResult(result);
  assert.equal(step.ok, false);
  assert.equal(step.outcome, 'no_target');
});

test('1.6 滚动步是唯一允许「升级 + 次数为 1」的一支，且它确实没有校验重试循环', async () => {
  // 具名例外，由单写区属主裁定「有意未动」：滚不动是**结构性**到底——同一页面上再滚两次
  // 不会有不同结果，所以这一支根本没有重试循环，1 就是它真实的尝试次数。
  const { dom } = installXhsDom('<main><div>已到底，怎么滚都不动</div></main>');
  let position = 0;
  Object.defineProperty(dom.window.document.documentElement, 'scrollTop', {
    configurable: true,
    get: () => position,
    set: (next: number) => { position = Number(next) || 0; },
  });
  (dom.window as unknown as { scrollBy: (x?: number, y?: number) => void }).scrollBy = () => {};

  const result = await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'page.scroll', op: 'scroll', value: 500 }] },
  });

  const step = firstResult(result);
  assert.equal(step.outcome, 'escalated');
  assert.equal(step.attempts, 1);
  assert.equal(step.reason, 'no_scroll');
});

test('1.6 上面驱动的步骤集合覆盖被测文件的整张白名单', async () => {
  // 完整性腿：新增一条白名单步骤而不给它写用例时，这里必须响亮失败——否则「升级必须带实测次数」
  // 这条合约会在新分支上悄悄缺席，而整套用例看起来仍然全绿。
  const source = await readFile(resolve(repoRoot, 'native/page-engine/src/xhs-command-router.js'), 'utf8');
  const declaration = source.match(/const map=\{[^}]*\};/);
  assert.ok(declaration, '白名单声明没解析出来：此处 MUST 响亮失败，绝不能退化成「空集 == 空集」恒真');

  const allowlisted = new Set(
    Array.from(declaration[0].matchAll(/'([^']+)':/g), (hit) => hit[1]),
  );
  assert.ok(allowlisted.size >= 5, `白名单只解析出 ${allowlisted.size} 条，正则大概率已经失配`);
  assert.ok(allowlisted.has('page.scroll'), '锚点缺席：解析结果不可信');

  const driven = new Set([...CLICK_STEPS.map((step) => step.actionId), 'page.scroll']);
  assert.deepEqual(
    [...allowlisted].sort(),
    [...driven].sort(),
    '白名单与本文件驱动的步骤集合必须逐条对齐',
  );
});
