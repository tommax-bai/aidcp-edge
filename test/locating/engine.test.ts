import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom } from '../helpers.js';
import { AnchorCache, LocatingEngine } from '../../src/locating/index.js';
import type {
  ActionExecutor,
  ActionRequest,
  Anchor,
  DomProvider,
  ElementDescriptor,
  ElementSelector,
  PostValidator,
  PromotionResult,
  SelectionResult,
} from '../../src/locating/index.js';
import { CloudElementSelector } from '../../src/client/cloud-selector.js';
import type { EdgeClient } from '../../src/client/edge-client.js';
import { TaskTakeoverError, abortForTakeover } from '../../src/execution/takeover.js';

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

// ---- change lease-strict-preemption 第 4 节：取消点 ----

/** 记账探针：接管作废必须是"零页面副作用"，缓存写入也算副作用（记账会随之漂移） */
class SpyCache extends AnchorCache {
  readonly writes: string[] = [];
  override stage(anchor: Anchor): boolean {
    this.writes.push('stage');
    return super.stage(anchor);
  }
  override confirmStaged(actionId: string): PromotionResult {
    this.writes.push('confirmStaged');
    return super.confirmStaged(actionId);
  }
  override recordHit(actionId: string): void {
    this.writes.push('recordHit');
    super.recordHit(actionId);
  }
}

test('云端选元素在飞时被接管 → 就地作废抛 TaskTakeoverError，不等满 200s、零页面副作用', async () => {
  const { document } = buildDom(`<button aria-label="关注" data-id="follow1">关注</button>`);
  const executor = new FakeExecutor();
  const cache = new SpyCache();

  // 桩按 EdgeClient.request 的 signal 契约：**永不 resolve**（模拟云端仍在 thinking，绝不真等 200s），
  // 只有 abort 能作废它，且 reject 用 signal.reason。
  let selectSent!: () => void;
  const selectInFlight = new Promise<void>((r) => {
    selectSent = r;
  });
  const hangingClient = {
    request(_type: string, _payload: unknown, _timeoutMs?: number, signal?: AbortSignal): Promise<never> {
      selectSent();
      return new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };

  const engine = new LocatingEngine({
    dom: new LiveDom(document),
    executor,
    selector: new CloudElementSelector(hangingClient as unknown as EdgeClient),
    validator: new FakeValidator(() => true), // 一旦被吞成"继续往下走"，这里会把它染成假成功
    cache,
  });

  const controller = new AbortController();
  const started = Date.now();
  const pending = engine.resolveAndAct(
    { actionId: 'follow', op: 'click', goal: '关注作者' },
    { checkpoint: () => {}, signal: controller.signal },
  );

  await selectInFlight; // 等到请求真的在飞（不是 abort 抢在发出之前）
  abortForTakeover(controller);

  await assert.rejects(
    pending,
    (err: unknown) => err instanceof TaskTakeoverError,
    '被接管 MUST 原样抛出；吞成 llm_error 会让引擎回 escalated(llm_unavailable)——把一次让路谎报成模型不可用',
  );
  assert.ok(Date.now() - started < 2_000, '必须毫秒级作废在飞请求，绝不空等 200s 超时');
  assert.equal(executor.calls.length, 0, '接管发生在页面写之前：零执行');
  assert.deepEqual(cache.writes, [], '零页面副作用作废：缓存记账也不得发生');
});

test('取消点恰好两处（进守卫前 / 每轮重试边界）：execute → validate 之间是禁区', async () => {
  const { document } = buildDom(`
    <button aria-label="关注" data-id="decoy">关注</button>
    <button aria-label="关注作者" data-id="real">关注作者</button>
  `);
  let followed = false;
  let checkpoints = 0;
  const atExecute: number[] = [];
  const atValidate: number[] = [];

  const executor: ActionExecutor = {
    execute(_op: ActionRequest['op'], el: ElementDescriptor): void {
      atExecute.push(checkpoints); // 页面已被写的那一刻，取消点计数
      if (el.attributes['data-id'] === 'real') followed = true;
    },
  };
  const validator: PostValidator = {
    validate(): boolean {
      atValidate.push(checkpoints); // 后置校验读到的计数：与上面相等 ⇒ 中间一格取消点都没有
      return followed;
    },
  };

  const cache = new AnchorCache();
  cache.put({ actionId: 'follow', role: 'button', text: '关注', textMatch: 'exact' }); // 误命中 decoy
  const selector = new FakeSelector((els) => {
    const real = els.find((e) => e.attributes['data-id'] === 'real')!;
    return { index: real.index, element: real, reason: 'llm_selected' };
  });

  const engine = new LocatingEngine({ dom: new LiveDom(document), executor, selector, validator, cache });
  const res = await engine.resolveAndAct(
    { actionId: 'follow', op: 'click', goal: '关注作者' },
    { checkpoint: () => void checkpoints++ },
  );

  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2, '第一轮缓存误命中被校验拦下，第二轮走 LLM');
  assert.equal(checkpoints, 3, '取消点只有两类位置：进守卫前 1 次 + 每轮重试边界 2 次');
  assert.deepEqual(atExecute, [2, 3], '每轮的取消点都落在这一轮的写动作发出之前');
  assert.deepEqual(
    atValidate,
    atExecute,
    'execute 返回到 validate 返回之间 MUST NOT 有取消点：那个窗口取消 = 把一次可能已生效的写当成没发生（且缓存记账在校验之后，会一并漂移）',
  );
});
