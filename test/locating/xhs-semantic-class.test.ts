import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom } from '../helpers.js';
import {
  extractInteractiveElements,
  matchSemanticClass,
  matchAnchor,
  AnchorCache,
  LocatingEngine,
} from '../../src/locating/index.js';
import type {
  Anchor,
  ActionExecutor,
  ActionRequest,
  DomProvider,
  ElementDescriptor,
  ElementSelector,
  PostValidator,
  SelectionResult,
} from '../../src/locating/index.js';
import {
  XHS_LIKE_ACTION_ID,
  XHS_LIKE_ANCHOR_HINT,
  XHS_LIKE_CLASS_HINT,
} from '../../src/flows/anchors.js';

/**
 * 模拟小红书真实 DOM：无 aria-label、无 role=button、无"点赞"文字，
 * 心形是纯 SVG，计数是裸数字。唯一稳定锚点是手写语义 class \`like-wrapper\`。
 * 结构：section.note-item > div.footer > div.author-wrapper > span.like-wrapper
 */
const XHS_NOTE_HTML = `
  <section class="note-item css-1a2b3c">
    <div class="footer css-9z8y7x">
      <div class="author-wrapper css-q1w2e3">
        <span class="like-wrapper css-r4t5y6">
          <svg viewBox="0 0 24 24" class="icon css-heart"><path d="M12 21s-7-5-9-9"/></svg>
          <span class="count css-zzz">128</span>
        </span>
        <span class="comment-wrapper css-c0mm3nt">
          <svg viewBox="0 0 24 24" class="icon"><path d="M2 2h20"/></svg>
          <span class="count">36</span>
        </span>
        <span class="collect-wrapper css-c0ll">
          <svg viewBox="0 0 24 24"><path d="M5 5h14"/></svg>
          <span class="count">9</span>
        </span>
      </div>
    </div>
  </section>
`;

// ————————————— extractor：按语义 class 识别可交互元素 —————————————

test('XHS 风格 DOM（无 aria/role/text）：extractor 通过语义 class 抽出互动控件', () => {
  const { document } = buildDom(XHS_NOTE_HTML);
  const els = extractInteractiveElements(document);

  // like / comment / collect 三个 wrapper 都应被白名单识别为可交互
  const hints = els.map((e) => e.classHint).filter(Boolean).sort();
  assert.deepEqual(hints, ['collect-wrapper', 'comment-wrapper', 'like-wrapper']);

  const like = els.find((e) => e.classHint === 'like-wrapper');
  assert.ok(like, '应抽到 like-wrapper');
  assert.equal(like!.tag, 'span', '点赞控件是 span（非 button）');
  assert.equal(like!.role, 'generic', '无 role：推导为 generic');
  // 反混淆：不应把随机/混淆 class 当作语义，attributes 里也不含原始 class
  assert.equal(like!.attributes['class'], undefined, '不应透传原始 class');
});

test('反混淆：仅纯混淆 class 的元素不被当作可交互（不信任任意 class）', () => {
  const { document } = buildDom(`
    <div class="css-1a2b3c random-9f8e7d"><span class="count">1</span></div>
    <span class="foobar-wrapper css-xyz">不是已知语义</span>
  `);
  const els = extractInteractiveElements(document);
  assert.equal(els.length, 0, '无白名单语义 class 的混淆元素不应被抽取');
});

test('matchSemanticClass：白名单精确边界匹配，容忍 BEM/前缀，拒绝子串误命中', () => {
  const { document } = buildDom(`
    <span id="a" class="like-wrapper css-1"></span>
    <span id="b" class="note-footer__like-wrapper"></span>
    <span id="c" class="xhs-like-wrapper--active"></span>
    <span id="d" class="dislike-wrappers"></span>
    <span id="e" class="css-likewrapper"></span>
  `);
  const get = (id: string) => document.getElementById(id)!;
  assert.equal(matchSemanticClass(get('a')), 'like-wrapper');
  assert.equal(matchSemanticClass(get('b')), 'like-wrapper', 'BEM 前缀应命中');
  assert.equal(matchSemanticClass(get('c')), 'like-wrapper', '前缀+修饰符应命中');
  assert.equal(matchSemanticClass(get('d')), null, '子串 dislike-wrappers 不应误命中');
  assert.equal(matchSemanticClass(get('e')), null, '无分隔的 likewrapper 不应误命中');
});

// ————————————— matcher：classHint 信号在无 aria/role/text 时命中 —————————————

test('matcher：仅靠语义 classHint 即可唯一命中点赞控件', () => {
  const { document } = buildDom(XHS_NOTE_HTML);
  const els = extractInteractiveElements(document);

  // 复用真实点赞锚点（role=button/text=点赞 在 XHS 上都落空，仅 classHint 命中）
  const anchor: Anchor = { actionId: XHS_LIKE_ACTION_ID, ...XHS_LIKE_ANCHOR_HINT };
  const r = matchAnchor(anchor, els);

  assert.equal(r.status, 'hit', '语义 class 命中应判 hit，而非 miss/ambiguous');
  assert.equal(r.element!.classHint, 'like-wrapper');
  assert.ok(r.confidence >= 0.6, `置信度应达标，实际 ${r.confidence}`);
  assert.ok(r.margin >= 0.15, '与 comment/collect 应有足够分差');
});

// ————————————— 端到端：定位引擎找到 span.like-wrapper 并点击，校验通过 —————————————

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

test('端到端：缓存锚点(classHint) → 引擎定位 span.like-wrapper → 点击 → 翻转 liked → success(cache)', async () => {
  const { document } = buildDom(XHS_NOTE_HTML);
  let liked = false;

  // 真实点赞：点击 like-wrapper 后页面给容器加 liked 类
  const executor = new FakeExecutor((el) => {
    if (el.classHint === 'like-wrapper') {
      const like = document.querySelector('.like-wrapper')!;
      like.setAttribute('class', like.getAttribute('class') + ' liked');
      liked = true;
    }
  });

  const cache = new AnchorCache();
  cache.put({ actionId: XHS_LIKE_ACTION_ID, ...XHS_LIKE_ANCHOR_HINT });

  const engine = new LocatingEngine({
    dom: new LiveDom(document),
    executor,
    selector: noopSelector,
    validator: new FakeValidator(() => liked),
    cache,
  });

  const res = await engine.resolveAndAct({
    actionId: XHS_LIKE_ACTION_ID,
    op: 'click',
    goal: '点赞当前这条小红书笔记',
  });

  assert.equal(res.ok, true, '应成功');
  assert.equal(res.source, 'cache');
  assert.equal(res.element!.classHint, 'like-wrapper', '定位到的应是点赞控件');
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].element.classHint, 'like-wrapper');
});

test('端到端：无缓存 → 选择器按 classHint 选中 like-wrapper（不误选 comment/collect）', async () => {
  const { document } = buildDom(XHS_NOTE_HTML);
  let liked = false;
  const executor = new FakeExecutor((el) => {
    if (el.classHint === 'like-wrapper') liked = true;
  });

  // 模拟 LLM：只能看到 classHint，据此选点赞控件
  const selector = new FakeSelector((els) => {
    const like = els.find((e) => e.classHint === 'like-wrapper');
    return like
      ? { index: like.index, element: like, reason: 'llm_selected' }
      : { index: null, reason: 'none' };
  });

  const engine = new LocatingEngine({
    dom: new LiveDom(document),
    executor,
    selector,
    validator: new FakeValidator(() => liked),
    cache: new AnchorCache(),
  });

  const res = await engine.resolveAndAct({
    actionId: XHS_LIKE_ACTION_ID,
    op: 'click',
    goal: '点赞（无障碍属性缺失，按语义类名 ' + XHS_LIKE_CLASS_HINT + ' 定位）',
  });

  assert.equal(res.ok, true);
  assert.equal(res.source, 'llm');
  assert.equal(executor.calls.at(-1)!.element.classHint, 'like-wrapper');
});
