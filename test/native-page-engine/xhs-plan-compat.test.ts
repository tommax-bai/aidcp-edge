import assert from 'node:assert/strict';
import test from 'node:test';
import { installXhsDom, runXhsRouter as run } from './xhs-dom-fixture.js';

/**
 * v1 有序步骤（`plan.response`）兼容路径的滚动步骤（change restore-native-xiaohongshu-action-honesty，任务 2.8）。
 *
 * 这条路径**仍有活跃产出方**（云端规划器的模型兜底可自由产出 scroll 步骤，CLI 也能直接下发），
 * 故不删；但结果必须按实测位移回报——原来是无条件 `success`，滚不动也报成功。
 */

function stubScroll(dom: ReturnType<typeof installXhsDom>['dom'], moves: boolean): void {
  let position = 0;
  Object.defineProperty(dom.window.document.documentElement, 'scrollTop', {
    configurable: true,
    get: () => position,
    set: (next: number) => { position = Number(next) || 0; },
  });
  (dom.window as unknown as { scrollBy: (x?: number, y?: number) => void }).scrollBy = (_x, y) => {
    if (moves) position += Number(y) || 0;
  };
}

function firstResult(result: { output: { value: Record<string, unknown> } }): Record<string, unknown> {
  const results = (result.output.value.results ?? []) as Array<Record<string, unknown>>;
  return results[0] ?? {};
}

test('2.8 兼容路径的滚动步骤按实测位移回报', async () => {
  const { dom } = installXhsDom('<main><section class="note-item"><a href="/explore/n1">卡片</a></section></main>');
  stubScroll(dom, true);

  const result = await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'page.scroll', op: 'scroll', value: 500 }] },
  });

  const step = firstResult(result);
  assert.equal(step.ok, true);
  assert.equal(step.outcome, 'success');
  assert.equal(step.reason, 'scrolled=500px', '回报的必须是实测位移，不是「下发了就算成功」');
});

test('2.8 滚不动的页面上滚动步骤诚实回非成功', async () => {
  const { dom } = installXhsDom('<main><div>已到底，怎么滚都不动</div></main>');
  stubScroll(dom, false);

  const result = await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'page.scroll', op: 'scroll', value: 500 }] },
  });

  const step = firstResult(result);
  assert.equal(step.ok, false);
  assert.equal(step.outcome, 'escalated', 'outcome 只能取协议里那四个值，不得新造');
  assert.equal(step.reason, 'no_scroll');
});

test('2.8 找不到目标的步骤仍回 no_target，不被顺手改掉', async () => {
  installXhsDom('<main><div>页面上没有任何互动控件</div></main>');
  const result = await run({
    kind: 'plan_execute',
    params: { steps: [{ actionId: 'note.follow_button', op: 'click' }] },
  });
  const step = firstResult(result);
  assert.equal(step.ok, false);
  assert.equal(step.outcome, 'no_target');
});
