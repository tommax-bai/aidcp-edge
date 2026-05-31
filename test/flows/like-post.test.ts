import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom } from '../helpers.js';
import { AnchorCache } from '../../src/locating/index.js';
import type {
  ActionExecutor,
  ActionRequest,
  DomProvider,
  ElementDescriptor,
  ElementSelector,
  SelectionResult,
} from '../../src/locating/index.js';
import {
  likePost,
  LikePostValidator,
  isLikedElement,
  buildLikeRequest,
} from '../../src/flows/like-post.js';
import { XHS_LIKE_ACTION_ID } from '../../src/flows/anchors.js';

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

const noopSelector = new FakeSelector(() => ({ index: null, reason: 'none' }));

// ————————————— LikePostValidator / isLikedElement 单元 —————————————

test('isLikedElement: aria-pressed=true 视为已点赞', () => {
  const { document } = buildDom(`<button aria-label="点赞" aria-pressed="true">赞</button>`);
  const btn = document.querySelector('button')!;
  assert.equal(isLikedElement(btn), true);
});

test('isLikedElement: 未点赞态返回 false', () => {
  const { document } = buildDom(`<button aria-label="点赞" aria-pressed="false">赞</button>`);
  const btn = document.querySelector('button')!;
  assert.equal(isLikedElement(btn), false);
});

test('isLikedElement: 祖先容器 liked 类名也算已点赞', () => {
  const { document } = buildDom(
    `<div class="like-wrap liked"><span class="heart" aria-label="点赞"></span></div>`,
  );
  const span = document.querySelector('span')!;
  assert.equal(isLikedElement(span), true);
});

test('LikePostValidator: DOM 中存在已翻转的点赞控件 → 通过', () => {
  const { document } = buildDom(
    `<button aria-label="点赞" aria-pressed="true">12</button>`,
  );
  const v = new LikePostValidator();
  assert.equal(v.validate(buildLikeRequest(), document), true);
});

test('LikePostValidator: 无任何已点赞控件 → 不通过', () => {
  const { document } = buildDom(
    `<button aria-label="点赞" aria-pressed="false">12</button>`,
  );
  const v = new LikePostValidator();
  assert.equal(v.validate(buildLikeRequest(), document), false);
});

// ————————————— 端到端：缓存命中 + 点击翻转点赞态 —————————————

test('点赞流程：缓存命中，点击后 aria-pressed 翻转 → success(cache)', async () => {
  const { document } = buildDom(
    `<button aria-label="点赞" data-id="like1" aria-pressed="false">赞 12</button>`,
  );
  const executor = new FakeExecutor((el) => {
    if (el.attributes['data-id'] === 'like1') {
      const btn = document.querySelector('[data-id="like1"]')!;
      btn.setAttribute('aria-pressed', 'true'); // 真实页面点赞后属性翻转
    }
  });
  const cache = new AnchorCache();
  cache.put({
    actionId: XHS_LIKE_ACTION_ID,
    role: 'button',
    text: '点赞',
    textMatch: 'contains',
    attributes: { 'aria-label': '点赞' },
  });

  const res = await likePost({
    dom: new LiveDom(document),
    executor,
    selector: noopSelector,
    cache,
  });

  assert.equal(res.ok, true);
  assert.equal(res.source, 'cache');
  assert.equal(res.actionId, XHS_LIKE_ACTION_ID);
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].op, 'click');
});

// ————————————— 端到端：无缓存，云端选择器兜底，点击加 liked 类 —————————————

test('点赞流程：无缓存走选择器，点击后加 liked 类 → success(llm)', async () => {
  const { document } = buildDom(`
    <button aria-label="评论" data-id="comment">评论</button>
    <button aria-label="点赞" data-id="like1">赞</button>
  `);
  const executor = new FakeExecutor((el) => {
    if (el.attributes['data-id'] === 'like1') {
      document.querySelector('[data-id="like1"]')!.setAttribute('class', 'liked');
    }
  });
  const selector = new FakeSelector((els) => {
    const like = els.find((e) => e.attributes['data-id'] === 'like1');
    return like
      ? { index: like.index, element: like, reason: 'cloud_selected' }
      : { index: null, reason: 'none' };
  });

  const res = await likePost({
    dom: new LiveDom(document),
    executor,
    selector,
    cache: new AnchorCache(),
  });

  assert.equal(res.ok, true);
  assert.equal(res.source, 'llm');
  assert.equal(executor.calls.at(-1)!.element.attributes['data-id'], 'like1');
});

// ————————————— 端到端：点击不翻转点赞态 → 不静默成功 —————————————

test('点赞流程：点击未翻转点赞态 → escalated（绝不伪造成功）', async () => {
  const { document } = buildDom(
    `<button aria-label="点赞" data-id="like1" aria-pressed="false">赞</button>`,
  );
  const executor = new FakeExecutor(); // 点了但页面没翻转
  const cache = new AnchorCache();
  cache.put({
    actionId: XHS_LIKE_ACTION_ID,
    role: 'button',
    text: '点赞',
    textMatch: 'contains',
    attributes: { 'aria-label': '点赞' },
  });

  const res = await likePost(
    { dom: new LiveDom(document), executor, selector: noopSelector, cache },
    { maxAttempts: 2 },
  );

  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'escalated');
  assert.ok(executor.calls.length >= 1);
});

test('buildLikeRequest: actionId/op/anchorHint 正确', () => {
  const req = buildLikeRequest();
  assert.equal(req.actionId, XHS_LIKE_ACTION_ID);
  assert.equal(req.op, 'click');
  assert.equal(req.anchorHint?.role, 'button');
});