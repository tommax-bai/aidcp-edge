import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom } from '../helpers.js';
import {
  extractInteractiveElements,
  findScope,
  matchAnchor,
  AnchorCache,
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
  XHS_NOTE_SCOPE,
} from '../../src/flows/anchors.js';
import { buildLikeRequest, likePost } from '../../src/flows/like-post.js';

function xhsCard(i: number): string {
  return `
    <section class="note-item css-${i}">
      <div class="footer">
        <div class="author-wrapper">
          <span class="like-wrapper css-l${i}"><svg></svg><span class="count">${i}</span></span>
          <span class="comment-wrapper"><svg></svg><span class="count">${i}</span></span>
        </div>
      </div>
    </section>`;
}

function exploreWithModalHtml(cardCount: number): string {
  const feed = Array.from({ length: cardCount }, (_, i) => xhsCard(i)).join('');
  const modal = `
    <div class="note-detail-mask css-mask">
      <div class="note-container">
        <div class="footer">
          <div class="author-wrapper">
            <span class="like-wrapper css-active" data-id="modal-like"><svg></svg><span class="count">999</span></span>
            <span class="comment-wrapper"><svg></svg><span class="count">12</span></span>
          </div>
        </div>
      </div>
    </div>`;
  return `<div class="feeds-container">${feed}</div>${modal}`;
}

test('findScope: CSS selector hits note-detail modal (over role/text)', () => {
  const { document } = buildDom(exploreWithModalHtml(18));
  const el = findScope(document, XHS_NOTE_SCOPE);
  assert.ok(el, 'should hit modal container');
  assert.match(el!.getAttribute('class') || '', /note-detail-mask/);
});

test('findScope: comma candidates, hit first existing container', () => {
  const { document } = buildDom(
    `<div class="note-container"><span class="like-wrapper">x</span></div>`,
  );
  const el = findScope(document, { selector: '.not-there, [class*="note-container"]' });
  assert.ok(el);
  assert.match(el!.getAttribute('class') || '', /note-container/);
});

test('findScope: invalid selector does not throw, falls back to role', () => {
  const { document } = buildDom(`<div role="article" data-k="v">A</div>`);
  const el = findScope(document, { selector: '::: bad(', role: 'article' });
  assert.ok(el, 'invalid selector ignored, role fallback');
  assert.equal(el!.getAttribute('role'), 'article');
});

test('scoped extract: 18 cards + modal, scoped to modal -> only 1 like-wrapper', () => {
  const { document } = buildDom(exploreWithModalHtml(18));

  const all = extractInteractiveElements(document);
  const allLikes = all.filter((e) => e.classHint === 'like-wrapper');
  assert.equal(allLikes.length, 19, 'whole page has 19 like-wrapper (incl. modal)');

  const scoped = extractInteractiveElements(document, XHS_NOTE_SCOPE);
  const scopedLikes = scoped.filter((e) => e.classHint === 'like-wrapper');
  assert.equal(scopedLikes.length, 1, 'scoped -> only 1 like-wrapper in modal');
  assert.equal(scopedLikes[0].attributes['data-id'], 'modal-like');
  assert.ok(scopedLikes[0].scopePath, 'scoped element should carry scopePath');
});

test('scoped extract: scopeFallback=root degrades to whole page when no modal', () => {
  // Single feed card with NO note-detail/container modal markup at all.
  const { document } = buildDom(`
    <section class="feed-card">
      <div class="footer">
        <div class="author-wrapper">
          <span class="like-wrapper css-x"><svg></svg><span class="count">3</span></span>
        </div>
      </div>
    </section>
  `);

  const strict = extractInteractiveElements(document, XHS_NOTE_SCOPE);
  assert.equal(strict.length, 0, 'strict scope: no container -> empty');

  const fallback = extractInteractiveElements(document, XHS_NOTE_SCOPE, {
    scopeFallback: 'root',
  });
  const likes = fallback.filter((e) => e.classHint === 'like-wrapper');
  assert.equal(likes.length, 1, 'scopeFallback=root -> degrade to whole page');
});

test('matcher: after scoped extract, like-wrapper hits uniquely', () => {
  const { document } = buildDom(exploreWithModalHtml(18));
  const scoped = extractInteractiveElements(document, XHS_NOTE_SCOPE);
  const anchor: Anchor = { actionId: XHS_LIKE_ACTION_ID, ...XHS_LIKE_ANCHOR_HINT };
  const r = matchAnchor(anchor, scoped);
  assert.equal(r.status, 'hit', 'scoped -> unique hit');
  assert.equal(r.element!.classHint, 'like-wrapper');
});

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

test('buildLikeRequest: anchorHint carries note-modal scope', () => {
  const req = buildLikeRequest();
  assert.ok(req.anchorHint?.scope?.selector, 'like request should carry scope selector');
  assert.match(req.anchorHint!.scope!.selector!, /note-detail-mask/);
});

test('e2e: explore + modal, selector only sees the single modal like-wrapper', async () => {
  const { document } = buildDom(exploreWithModalHtml(18));
  let likedId: string | undefined;

  const executor = new FakeExecutor((el) => {
    if (el.classHint === 'like-wrapper') likedId = el.attributes['data-id'];
  });

  const selector = new FakeSelector((els) => {
    const likes = els.filter((e) => e.classHint === 'like-wrapper');
    assert.equal(likes.length, 1, 'selector should receive exactly 1 like-wrapper after scoping');
    const like = likes[0];
    return { index: like.index, element: like, reason: 'cloud_selected' };
  });

  const res = await likePost({
    dom: new LiveDom(document),
    executor,
    selector,
    cache: new AnchorCache(),
    validator: new FakeValidator(() => likedId === 'modal-like'),
  });

  assert.equal(res.ok, true);
  assert.equal(likedId, 'modal-like', 'should click the modal note like control');
});