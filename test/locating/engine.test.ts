import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom } from '../helpers.js';
import { AnchorCache, LocatingEngine } from '../../src/locating/index.js';
import type {
  ActionExecutor,
  ActionRequest,
  DomProvider,
  ElementDescriptor,
  ElementSelector,
  PostValidator,
  SelectionResult,
} from '../../src/locating/index.js';

class LiveDom implements DomProvider {
  constructor(private readonly doc: Document) {}
  getRoot(): Document {
    return this.doc;
  }
}

class FakeExecutor implements ActionExecutor {
  readonly calls: { op: string; element: ElementDescriptor; value?: string }[] = [];
  constructor(private readonly onClick?: (el: ElementDescriptor) => void) {}
  execute(op: ActionRequest['op'], element: ElementDescriptor, value?: string): void {
    this.calls.push({ op, element, value });
    if (op === 'click' && this.onClick) this.onClick(element);
  }
}

class FakeSelector implements ElementSelector {
  constructor(private readonly pick: (els: ElementDescriptor[]) => SelectionResult) {}
  async select(_goal: string, els: ElementDescriptor[]): Promise<SelectionResult> {
    return this.pick(els);
  }
}

class FakeValidator implements PostValidator {
  constructor(private readonly fn: () => boolean) {}
  validate(): boolean {
    return this.fn();
  }
}

const noopSelector = new FakeSelector(() => ({ index: null, reason: 'none' }));

test('缓存命中 + 后置校验通过 → success(source=cache)', async () => {
  const { document } = buildDom(`<button aria-label="点赞" data-id="like1">赞</button>`);
  let liked = false;
  const executor = new FakeExecutor((el) => {
    if (el.attributes['data-id'] === 'like1') liked = true;
  });
  const cache = new AnchorCache();
  cache.put({ actionId: 'like', role: 'button', text: '点赞', textMatch: 'contains', attributes: { 'aria-label': '点赞' } });

  const engine = new LocatingEngine({
    dom: new LiveDom(document),
    executor,
    selector: noopSelector,
    validator: new FakeValidator(() => liked),
    cache,
  });

  const res = await engine.resolveAndAct({ actionId: 'like', op: 'click', goal: '点赞当前笔记' });
  assert.equal(res.ok, true);
  assert.equal(res.source, 'cache');
  assert.equal(res.attempts, 1);
  assert.equal(executor.calls.length, 1);
});

test('静默误命中防护：缓存命中但校验失败 → 自愈走 LLM 重定位成功', async () => {
  // 改版后：旧锚点唯一命中了一个"假关注"按钮，真正的关注按钮换了位置
  const { document } = buildDom(`
    <button aria-label="关注" data-id="decoy">关注</button>
    <button aria-label="关注作者" data-id="real">关注作者</button>
  `);
  let followed = false;
  const executor = new FakeExecutor((el) => {
    if (el.attributes['data-id'] === 'real') followed = true; // 只有点真按钮才生效
  });
  const cache = new AnchorCache();
  cache.put({ actionId: 'follow', role: 'button', text: '关注', textMatch: 'exact' });

  const selector = new FakeSelector((els) => {
    const real = els.find((e) => e.attributes['data-id'] === 'real');
    return real
      ? { index: real.index, element: real, reason: 'llm_selected' }
      : { index: null, reason: 'none' };
  });

  const engine = new LocatingEngine({
    dom: new LiveDom(document),
    executor,
    selector,
    validator: new FakeValidator(() => followed),
    cache,
  });

  const res = await engine.resolveAndAct({ actionId: 'follow', op: 'click', goal: '关注作者' });
  assert.equal(res.ok, true, '最终应成功');
  assert.equal(res.source, 'llm', '应由 LLM 重定位接管');
  assert.equal(res.attempts, 2, '第一次缓存误命中被校验拦下，第二次才成功');
  assert.equal(executor.calls.length, 2);
  // 第一次点的是 decoy（校验失败），不应被当成成功静默通过
  assert.equal(executor.calls[0].element.attributes['data-id'], 'decoy');
  assert.equal(executor.calls[1].element.attributes['data-id'], 'real');
});

test('系统性改版：连续校验失败到上限 → escalated(systemic_revision)，绝不静默成功', async () => {
  const { document } = buildDom(`<button aria-label="发布" data-id="pub">发布</button>`);
  const executor = new FakeExecutor();
  const selector = new FakeSelector((els) =>
    els.length ? { index: els[0].index, element: els[0], reason: 'llm_selected' } : { index: null, reason: 'none' },
  );
  const engine = new LocatingEngine(
    {
      dom: new LiveDom(document),
      executor,
      selector,
      validator: new FakeValidator(() => false), // 业务结果从未发生
      cache: new AnchorCache(),
    },
    { maxAttempts: 3 },
  );

  const res = await engine.resolveAndAct({ actionId: 'publish', op: 'click', goal: '发布笔记' });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'escalated');
  assert.equal(res.escalation, 'systemic_revision');
  assert.equal(res.attempts, 3);
  assert.equal(executor.calls.length, 3);
});

test('反污染回写：LLM 新锚点需连续确认才晋升主缓存', async () => {
  const { document } = buildDom(`<button aria-label="收藏" data-id="fav">收藏</button>`);
  let done = false;
  const executor = new FakeExecutor(() => {
    done = true;
  });
  const cache = new AnchorCache({ confirmThreshold: 2 });
  const selector = new FakeSelector((els) => ({ index: els[0].index, element: els[0], reason: 'llm_selected' }));
  const engine = new LocatingEngine({
    dom: new LiveDom(document),
    executor,
    selector,
    validator: new FakeValidator(() => done),
    cache,
  });

  const r1 = await engine.resolveAndAct({ actionId: 'fav', op: 'click', goal: '收藏笔记' });
  assert.equal(r1.ok, true);
  assert.equal(r1.source, 'llm');
  assert.equal(cache.get('fav'), undefined, '一次成功不应晋升主缓存（反污染）');
  assert.equal(cache.hasStaged('fav'), true);

  done = false;
  const r2 = await engine.resolveAndAct({ actionId: 'fav', op: 'click', goal: '收藏笔记' });
  assert.equal(r2.ok, true);
  assert.ok(cache.get('fav'), '第二次确认后晋升主缓存');
});

test('守卫层：偶现弹窗被清除后再继续主流程', async () => {
  const { document } = buildDom(`
    <div role="dialog" aria-modal="true" data-id="modal">
      <span>活动弹窗</span>
      <button aria-label="关闭" data-id="closebtn">关闭</button>
    </div>
    <button aria-label="点赞" data-id="like1">赞</button>
  `);
  let liked = false;
  const executor = new FakeExecutor((el) => {
    const id = el.attributes['data-id'];
    if (id === 'closebtn') document.querySelector('[data-id="modal"]')?.remove();
    if (id === 'like1') liked = true;
  });
  const cache = new AnchorCache();
  cache.put({ actionId: 'like', role: 'button', text: '点赞', textMatch: 'contains', attributes: { 'aria-label': '点赞' } });

  const engine = new LocatingEngine({
    dom: new LiveDom(document),
    executor,
    selector: noopSelector,
    validator: new FakeValidator(() => liked),
    cache,
  });

  const res = await engine.resolveAndAct({ actionId: 'like', op: 'click', goal: '点赞当前笔记' });
  assert.equal(res.ok, true);
  assert.equal(document.querySelector('[data-id="modal"]'), null, '弹窗应已被关闭');
  assert.equal(executor.calls[0].element.attributes['data-id'], 'closebtn', '先清障');
  assert.equal(executor.calls[1].element.attributes['data-id'], 'like1', '后执行主操作');
});

test('LLM 选不出且无缓存 → no_target（不伪造成功）', async () => {
  const { document } = buildDom(`<button aria-label="点赞" data-id="like1">赞</button>`);
  const executor = new FakeExecutor();
  const engine = new LocatingEngine(
    {
      dom: new LiveDom(document),
      executor,
      selector: noopSelector,
      validator: new FakeValidator(() => true),
      cache: new AnchorCache(),
    },
    { maxAttempts: 2 },
  );
  const res = await engine.resolveAndAct({ actionId: 'ghost', op: 'click', goal: '点击不存在的东西' });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'no_target');
  assert.equal(executor.calls.length, 0, '没定位到就不应执行任何操作');
});
