import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import { readFacebookRouterSource } from './facebook-router-source.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFacebookRouterSource(repoRoot);
const run = Function(`return (${source})`)() as (
  input: { kind: string; params: Record<string, unknown> },
) => Promise<{ effectPhase: string; output: { kind: string; value: Record<string, unknown> } }>;

function install(html: string, url = 'https://www.facebook.com/'): JSDOM {
  const dom = new JSDOM(html, { url });
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1_440 });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 800 });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    getSelection: dom.window.getSelection.bind(dom.window),
    innerHeight: 800,
    innerWidth: 1_440,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: () => undefined });
  Object.defineProperty(dom.window, 'scrollBy', { value: () => undefined });
  return dom;
}

function setRect(element: Element, rect: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }),
  });
}

test('Facebook Group Join probe returns bounded not-ready data while navigation has no body', async () => {
  const dom = install('', 'https://www.facebook.com/groups/tuyendung.dongvan');
  dom.window.document.documentElement.remove();
  assert.equal(dom.window.document.body, null);

  const result = await run({ kind: 'join_probe', params: {} });
  assert.equal(result.output.kind, 'join_probe');
  assert.equal(result.output.value.found, false);
  assert.equal(result.output.value.joined, false);
  assert.equal(
    (result.output.value.observation as Record<string, unknown>).composerPresent,
    false,
  );
});

test('Facebook feed projection keeps canonical permalink identity and bounded page facts', async () => {
  install(`
    <main>
      <article role="article">
        <h2><a href="/people/Alice/123456/">Alice</a></h2>
        <div data-ad-rendering-role="story_message">A useful Agent note</div>
        <a href="/Alice/posts/pfbidABC/">2h</a>
        <button aria-label="Like 1.2K">Like 1.2K</button>
      </article>
    </main>
  `);
  const result = await run({ kind: 'browse_scroll', params: { reason: 'initial_scan' } });
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'page_cards');
  const cards = result.output.value.cards as Array<Record<string, unknown>>;
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.noteId, 'https://www.facebook.com/Alice/posts/pfbidABC');
  assert.equal(cards[0]?.author, 'Alice');
  assert.equal(cards[0]?.likeCount, 1_200);
});

test('Facebook first-post scroll settles for two seconds before probing hydrated cards', async () => {
  const dom = install(`
    <main>
      <div role="feed"></div>
    </main>
  `, 'https://www.facebook.com/groups/945390701793119');
  const waits: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    waits.push(Number(delay));
    if (delay === 2_000) {
      dom.window.document.querySelector('[role="feed"]')!.innerHTML = `
        <article role="article">
          <h2><a href="/people/Alice/123456/">Alice</a></h2>
          <div data-ad-rendering-role="story_message">Hydrated after scrolling</div>
          <a href="/groups/945390701793119/posts/333/">2h</a>
          <button aria-label="Comment">Comment</button>
        </article>
      `;
    }
    callback();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;

  try {
    const result = await run({
      kind: 'browse_scroll',
      params: { reason: 'first_commentable_group_post_probe' },
    });
    assert.deepEqual(waits, [450, 2_000]);
    const cards = result.output.value.cards as Array<Record<string, unknown>>;
    assert.equal(cards.length, 1);
    assert.equal(
      cards[0]?.noteId,
      'https://www.facebook.com/groups/945390701793119/posts/333',
    );

    waits.length = 0;
    await run({ kind: 'browse_scroll', params: { reason: 'coverage_scan' } });
    assert.deepEqual(waits, [450]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('Facebook first-post binds a Vietnamese commentable container without a permalink', async () => {
  const dom = install(`
    <main>
      <div role="feed">
        <section id="post">
          <h2><a href="/groups/718145812202687/user/100014995179767/">Việt Nhật Hà Nam</a></h2>
          <a href="/groups/718145812202687?__cft__[0]=tracking#?chc">2 giờ</a>
          <div data-ad-rendering-role="story_message">HONDA VIỆT NAM TUYỂN DỤNG 100 CÔNG NHÂN</div>
          <button aria-label="Viết bình luận">Viết bình luận</button>
          <div id="editor" role="textbox" contenteditable="true" aria-label="Viết bình luận công khai…"></div>
        </section>
      </div>
    </main>
  `, 'https://www.facebook.com/groups/718145812202687');
  setRect(dom.window.document.querySelector('#post')!, { left: 120, top: 675, right: 800, bottom: 1_450 });
  setRect(dom.window.document.querySelector('#editor')!, { left: 175, top: 1_354, right: 760, bottom: 1_398 });

  const selected = await run({
    kind: 'feed_refresh',
    params: { reason: 'first_commentable_group_post_probe' },
  });
  const cards = selected.output.value.cards as Array<Record<string, unknown>>;
  assert.equal(cards.length, 1);
  const targetRef = String(cards[0]?.noteId);
  assert.match(targetRef, /^aidcp:facebook-group-feed-post:v1:[0-9a-f]{64}$/);
  assert.doesNotMatch(targetRef, /^https?:/);

  const detail = await run({
    kind: 'note_open',
    params: { noteId: targetRef, surface: 'feed' },
  });
  assert.equal(detail.output.kind, 'note_detail');
  assert.equal(detail.output.value.noteId, targetRef);
  assert.equal(detail.output.value.content, 'HONDA VIỆT NAM TUYỂN DỤNG 100 CÔNG NHÂN');

  const editor = await run({
    kind: 'comment_editor_probe',
    params: { noteId: targetRef },
  });
  assert.equal(editor.output.value.ok, true);
  assert.equal(editor.output.value.noteId, targetRef);

  dom.window.document.querySelector('[data-ad-rendering-role="story_message"]')!.textContent =
    'Facebook recycled this container for another post';
  const moved = await run({
    kind: 'comment_editor_probe',
    params: { noteId: targetRef },
  });
  assert.equal(moved.output.value.ok, false);
  assert.equal(moved.output.value.reason, 'target_not_found');
});

test('Facebook first-post returns comment-action coordinates without invoking DOM click', async () => {
  const dom = install(`
    <main>
      <div role="feed">
        <section id="post">
          <h2><a href="/groups/718145812202687/user/100014995179767/">Việt Nhật Hà Nam</a></h2>
          <div data-ad-rendering-role="story_message">Editor requires a trusted pointer gesture</div>
          <button id="comment-action" aria-label="Viết bình luận">Viết bình luận</button>
          <button aria-label="Bình luận bằng nhãn dán avatar">Avatar</button>
          <button aria-label="Bình luận bằng file GIF">GIF</button>
          <button aria-label="Bình luận bằng nhãn dán">Sticker</button>
        </section>
      </div>
    </main>
  `, 'https://www.facebook.com/groups/718145812202687');
  const post = dom.window.document.querySelector('#post')!;
  const action = dom.window.document.querySelector('#comment-action') as HTMLButtonElement;
  setRect(post, { left: 120, top: 675, right: 800, bottom: 1_450 });
  setRect(action, { left: 180, top: 1_320, right: 420, bottom: 1_372 });
  for (const [index, decoy] of Array.from(post.querySelectorAll('button:not(#comment-action)')).entries()) {
    setRect(decoy, {
      left: 440 + index * 60,
      top: 1_320,
      right: 490 + index * 60,
      bottom: 1_372,
    });
  }
  let domClicks = 0;
  action.click = () => {
    domClicks += 1;
  };

  const selected = await run({
    kind: 'feed_refresh',
    params: { reason: 'first_commentable_group_post_probe' },
  });
  const cards = selected.output.value.cards as Array<Record<string, unknown>>;
  assert.equal(cards.length, 1);
  const targetRef = String(cards[0]?.noteId);
  assert.match(targetRef, /^aidcp:facebook-group-feed-post:v1:[0-9a-f]{64}$/);
  assert.equal(domClicks, 0);

  const point = await run({
    kind: 'comment_action_probe',
    params: { noteId: targetRef },
  });
  assert.equal(point.output.kind, 'point_target');
  assert.deepEqual(point.output.value, {
    ok: true,
    cx: 300,
    cy: 1_346,
  });
  assert.equal(domClicks, 0);
});

test('Facebook first-post rejects an in-place boundary with multiple peer editors', async () => {
  install(`
    <main>
      <div role="feed">
        <section>
          <h2><a href="/groups/718145812202687/user/100014995179767/">Việt Nhật Hà Nam</a></h2>
          <div data-ad-rendering-role="story_message">One post body</div>
          <div role="textbox" contenteditable="true" aria-label="Viết bình luận công khai…"></div>
          <div role="textbox" contenteditable="true" aria-label="Viết bình luận công khai…"></div>
        </section>
      </div>
    </main>
  `, 'https://www.facebook.com/groups/718145812202687');

  const selected = await run({
    kind: 'feed_refresh',
    params: { reason: 'first_commentable_group_post_probe' },
  });
  assert.deepEqual(selected.output.value.cards, []);
  assert.equal(selected.output.value.selectionReason, 'ambiguous_target');
});

test('Facebook first-post hydration keeps the existing four-scroll bound', async () => {
  const runtime = await readFile(
    resolve(repoRoot, 'native/page-engine/src/facebook/runtime.rs'),
    'utf8',
  );
  assert.match(runtime, /const FIRST_POST_SCROLL_ROUNDS: usize = 4;/);
});

test('Facebook Feed probe distinguishes loading and visible unreportable articles from explicit empty', async () => {
  install(`
    <main>
      <div role="feed" aria-busy="true">
        <article role="article">
          <h2><a href="/people/Alice/123456/">Alice</a></h2>
          <div data-ad-rendering-role="story_message">Visible but permalink not hydrated yet</div>
        </article>
        <div role="progressbar"></div>
      </div>
    </main>
  `);
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { timeOrigin: Date.now() - 10_000.75 },
  });
  try {
    const result = await run({ kind: 'feed_probe', params: {} });
    assert.equal(result.output.kind, 'feed_probe');
    assert.equal(result.output.value.loading, true);
    assert.equal(result.output.value.articleCount, 1);
    assert.equal(result.output.value.explicitEmpty, false);
    assert.equal(result.output.value.explicitEnd, false);
    assert.deepEqual(result.output.value.cards, []);
    assert.equal(Number.isSafeInteger(result.output.value.documentAgeMs), true);
    assert.ok(Number(result.output.value.documentAgeMs) >= 10_000);
  } finally {
    assert.ok(originalPerformance);
    Object.defineProperty(globalThis, 'performance', originalPerformance);
  }
});

test('Facebook Feed probe locates the exact Vietnamese recovery control without DOM click', async () => {
  const dom = install(`
    <main>
      <button id="feed-recovery">Đi đến Bảng feed</button>
      <button>Đi đến Bảng feed khác</button>
    </main>
  `);
  const recovery = dom.window.document.querySelector('#feed-recovery') as HTMLButtonElement;
  setRect(recovery, { left: 420, top: 300, right: 660, bottom: 360 });
  let domClicks = 0;
  recovery.click = () => {
    domClicks += 1;
  };

  const feed = await run({ kind: 'feed_probe', params: {} });
  assert.deepEqual(feed.output.value.feedRecoveryTarget, {
    ok: true,
    cx: 540,
    cy: 330,
  });
  const refreshed = await run({ kind: 'feed_recovery_target', params: {} });
  assert.equal(refreshed.output.kind, 'point_target');
  assert.deepEqual(refreshed.output.value, {
    ok: true,
    cx: 540,
    cy: 330,
  });
  assert.equal(domClicks, 0);
});

test('Facebook Feed recovery target rejects near text, duplicate exact controls, and offscreen points', async () => {
  install('<main><button>Đi đến Bảng feed khác</button></main>');
  const nearResult = await run({ kind: 'feed_recovery_target', params: {} });
  assert.deepEqual(nearResult.output.value, {
    ok: false,
    reason: 'no_feed_recovery_target',
  });

  install(`
    <main>
      <button>Đi đến Bảng feed</button>
      <a href="/">Đi đến Bảng feed</a>
    </main>
  `);
  const duplicateResult = await run({ kind: 'feed_recovery_target', params: {} });
  assert.deepEqual(duplicateResult.output.value, {
    ok: false,
    reason: 'ambiguous_feed_recovery_target',
  });

  const offscreen = install('<main><button id="offscreen">Đi đến Bảng feed</button></main>');
  setRect(offscreen.window.document.querySelector('#offscreen')!, {
    left: 420,
    top: 900,
    right: 660,
    bottom: 960,
  });
  const offscreenResult = await run({ kind: 'feed_recovery_target', params: {} });
  assert.deepEqual(offscreenResult.output.value, {
    ok: false,
    reason: 'feed_recovery_target_out_of_view',
  });
});

test('Facebook Feed probe separates a visible end marker from the stronger empty-home marker', async () => {
  install(`
    <main>
      <div role="feed">
        <article role="article">
          <h2><a href="/people/Alice/123456/">Alice</a></h2>
          <div data-ad-rendering-role="story_message">Previously visible Feed content</div>
          <a href="/Alice/posts/pfbidABC/">2h</a>
        </article>
        <section>Không còn bài viết nào trong bảng feed này.</section>
      </div>
    </main>
  `);

  const result = await run({ kind: 'feed_probe', params: {} });
  assert.equal(result.output.value.explicitEnd, true);
  assert.equal(result.output.value.explicitEmpty, false);
});

test('Facebook Reels probe and cards bind to one active video identity', async () => {
  const dom = install(`
    <main>
      <article role="article">
        <h2><a href="/people/Alice/123456/">Alice</a></h2>
        <div data-ad-rendering-role="story_message">Active Reel summary</div>
        <a href="/reel/777/">timestamp</a>
        <video src="https://cdn.example/reel-777.mp4"></video>
      </article>
    </main>
  `, 'https://www.facebook.com/reel/777');
  const video = dom.window.document.querySelector('video')!;
  setRect(video, { left: 280, top: 80, right: 980, bottom: 760 });

  const probe = await run({ kind: 'reel_probe', params: {} });
  assert.equal(probe.output.kind, 'reel_probe');
  assert.equal(probe.output.value.ok, true);
  assert.equal(probe.output.value.noteId, 'https://www.facebook.com/reel/777');
  assert.match(String(probe.output.value.videoKey), /reel-777\.mp4@element:1$/);

  const cardsResult = await run({ kind: 'reel_cards', params: {} });
  assert.equal(cardsResult.output.value.listKind, 'reels');
  const cards = cardsResult.output.value.cards as Array<Record<string, unknown>>;
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.noteId, 'https://www.facebook.com/reel/777');
  assert.equal(cards[0]?.title, 'Active Reel summary');
});

test('Facebook Reels route identity projects one card without a permalink-bearing article', async () => {
  const dom = install(`
    <main>
      <div id="active-reel">
        <video src="https://cdn.example/reel-1528556722142425.mp4"></video>
        <a href="/reel/hashtag/?q=%23agents">#agents</a>
        <a href="/reel/hashtag/?q=%23automation">#automation</a>
        <a href="/reel/hashtag/?q=%23agents">#agents duplicate</a>
      </div>
    </main>
  `, 'https://www.facebook.com/reel/1528556722142425');
  setRect(dom.window.document.querySelector('video')!, { left: 557, top: 72, right: 959, bottom: 786 });

  const probe = await run({ kind: 'reel_probe', params: {} });
  assert.equal(probe.output.value.ok, true);
  assert.equal(probe.output.value.noteId, 'https://www.facebook.com/reel/1528556722142425');

  const cardsResult = await run({ kind: 'reel_cards', params: {} });
  assert.equal(cardsResult.output.value.listKind, 'reels');
  assert.equal(cardsResult.output.value.listState, 'ready');
  const cards = cardsResult.output.value.cards as Array<Record<string, unknown>>;
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.noteId, 'https://www.facebook.com/reel/1528556722142425');
  assert.equal(cards[0]?.isVideo, true);
});

test('Facebook Reels anonymous landing video is targetable but not reportable', async () => {
  const dom = install(`
    <main>
      <div>
        <video src="https://cdn.example/unknown-reel.mp4"></video>
        <a href="/reel/hashtag/?q=%23agents">#agents</a>
        <a href="/reel/hashtag/?q=%23automation">#automation</a>
      </div>
    </main>
  `, 'https://www.facebook.com/reel/');
  setRect(dom.window.document.querySelector('video')!, { left: 557, top: 72, right: 959, bottom: 786 });

  const probe = await run({ kind: 'reel_probe', params: {} });
  assert.equal(probe.output.value.ok, true);
  assert.equal(probe.output.value.noteId, undefined);
  assert.match(String(probe.output.value.videoKey), /unknown-reel\.mp4@element:1$/);
  assert.deepEqual(probe.output.value.videoRect, { left: 557, top: 72, right: 959, bottom: 786 });

  const cardsResult = await run({ kind: 'reel_cards', params: {} });
  assert.deepEqual(cardsResult.output.value.cards, []);
  assert.equal(cardsResult.output.value.listState, 'present_unreportable');
});

test('Facebook Reels probe fails closed when the active video is ambiguous', async () => {
  const dom = install(`
    <main>
      <article role="article"><a href="/reel/777/">one</a><video src="one.mp4"></video></article>
      <article role="article"><a href="/reel/778/">two</a><video src="two.mp4"></video></article>
    </main>
  `, 'https://www.facebook.com/reels/');
  for (const video of dom.window.document.querySelectorAll('video')) {
    setRect(video, { left: 280, top: 80, right: 980, bottom: 760 });
  }

  const probe = await run({ kind: 'reel_probe', params: {} });

  assert.deepEqual(probe.output.value, { ok: false, reason: 'ambiguous_target' });
});

test('Facebook Reels next target is constrained beside the active video', async () => {
  const dom = install(`
    <main>
      <article role="article"><a href="/reel/777/">one</a><video src="one.mp4"></video></article>
      <button id="previous" aria-label="Previous" aria-disabled="true"></button>
      <button id="next" aria-label="Next"></button>
    </main>
  `, 'https://www.facebook.com/reel/777');
  setRect(dom.window.document.querySelector('video')!, { left: 220, top: 80, right: 980, bottom: 760 });
  setRect(dom.window.document.querySelector('#previous')!, { left: 1_230, top: 280, right: 1_278, bottom: 328 });
  setRect(dom.window.document.querySelector('#next')!, { left: 1_230, top: 360, right: 1_278, bottom: 408 });

  const target = await run({ kind: 'reel_next_target', params: {} });

  assert.equal(target.output.value.ok, true);
  assert.equal(target.output.value.found, true);
  assert.equal(target.output.value.ambiguous, false);
  assert.equal(target.output.value.axis, 'vertical');
  assert.equal(target.output.value.label, 'Next');
  assert.equal(target.output.value.noteId, 'https://www.facebook.com/reel/777');
});

test('Facebook Reels next target resolves a horizontal rail around the active video', async () => {
  const dom = install(`
    <main>
      <article role="article"><a href="/reel/777/">one</a><video src="one.mp4"></video></article>
      <button id="previous" aria-label="Previous"></button>
      <button id="next" aria-label="Next"></button>
    </main>
  `, 'https://www.facebook.com/reel/777');
  setRect(dom.window.document.querySelector('video')!, { left: 400, top: 80, right: 1_040, bottom: 760 });
  setRect(dom.window.document.querySelector('#previous')!, { left: 280, top: 376, right: 328, bottom: 424 });
  setRect(dom.window.document.querySelector('#next')!, { left: 1_112, top: 376, right: 1_160, bottom: 424 });

  const target = await run({ kind: 'reel_next_target', params: {} });

  assert.equal(target.output.value.ok, true);
  assert.equal(target.output.value.found, true);
  assert.equal(target.output.value.ambiguous, false);
  assert.equal(target.output.value.axis, 'horizontal');
  assert.equal(target.output.value.label, 'Next');
  assert.equal(target.output.value.cx, 1_136);
  assert.equal(target.output.value.cy, 400);
});

test('Facebook Reels next target rejects competing vertical and horizontal rails', async () => {
  const dom = install(`
    <main>
      <article role="article"><a href="/reel/777/">one</a><video src="one.mp4"></video></article>
      <button id="vertical-previous" aria-label="Previous"></button>
      <button id="vertical-next" aria-label="Next"></button>
      <button id="horizontal-previous" aria-label="Previous"></button>
      <button id="horizontal-next" aria-label="Next"></button>
    </main>
  `, 'https://www.facebook.com/reel/777');
  setRect(dom.window.document.querySelector('video')!, { left: 400, top: 80, right: 1_040, bottom: 760 });
  setRect(dom.window.document.querySelector('#vertical-previous')!, { left: 1_230, top: 280, right: 1_278, bottom: 328 });
  setRect(dom.window.document.querySelector('#vertical-next')!, { left: 1_230, top: 360, right: 1_278, bottom: 408 });
  setRect(dom.window.document.querySelector('#horizontal-previous')!, { left: 280, top: 376, right: 328, bottom: 424 });
  setRect(dom.window.document.querySelector('#horizontal-next')!, { left: 1_112, top: 376, right: 1_160, bottom: 424 });

  const target = await run({ kind: 'reel_next_target', params: {} });

  assert.equal(target.output.value.ok, true);
  assert.equal(target.output.value.found, false);
  assert.equal(target.output.value.ambiguous, true);
  assert.equal(target.output.value.axis, undefined);
});

test('Facebook Reels page.scroll refuses the document-scroll fallback', async () => {
  const dom = install(`
    <main><article role="article"><a href="/reel/777/">one</a><video src="one.mp4"></video></article></main>
  `, 'https://www.facebook.com/reel/777');
  setRect(dom.window.document.querySelector('video')!, { left: 280, top: 80, right: 980, bottom: 760 });
  let documentScrolls = 0;
  Object.defineProperty(dom.window, 'scrollBy', { value: () => { documentScrolls += 1; } });

  const result = await run({ kind: 'page_scroll', params: { reason: 'feed_scroll' } });

  assert.equal(result.effectPhase, 'not_started');
  assert.equal(result.output.value.reason, 'native_reels_actuator_required');
  assert.equal(documentScrolls, 0);
});

test('Facebook Native identity treats c_user as authoritative over other feed profile links', async () => {
  install(`
    <nav><a href="/people/Self/123456/" aria-label="Self's profile picture"></a></nav>
    <main><article role="article"><a href="/people/Other/999999/">Other</a></article></main>
  `);
  const result = await run({ kind: 'identity_read', params: { cookieUserId: '123456' } });
  assert.equal(result.output.kind, 'identity_receipt');
  assert.deepEqual(result.output.value, {
    ok: true,
    accountId: '123456',
    displayName: 'Self',
    source: 'cookie',
  });
});

test('Facebook search refuses missing container and reads only a container result page', async () => {
  install('<main><h1>Agent Builders</h1></main>', 'https://www.facebook.com/groups/42/search/?q=agent');
  const denied = await run({ kind: 'search_execute', params: { keyword: 'agent' } });
  assert.equal(denied.effectPhase, 'not_started');
  assert.equal(denied.output.value.reason, 'permission_gated');

  install(`
    <main>
      <h1>Agent Builders</h1>
      <article role="article">
        <div data-ad-rendering-role="story_message">Agent result</div>
        <a href="/groups/42/posts/9001/">permalink</a>
      </article>
    </main>
  `, 'https://www.facebook.com/groups/42/search/?q=agent');
  const result = await run({
    kind: 'search_execute',
    params: { keyword: 'agent', container: 'https://www.facebook.com/groups/42' },
  });
  assert.equal(result.output.kind, 'page_cards');
  assert.equal(result.output.value.containerName, 'Agent Builders');
  const cards = result.output.value.cards as Array<Record<string, unknown>>;
  assert.equal(cards[0]?.noteId, 'https://www.facebook.com/groups/42/posts/9001');
});

test('Facebook comment requires readback and a server-acknowledged visible postcondition', async () => {
  const dom = install(`
    <main>
      <article role="article" id="post">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
        <div role="textbox" contenteditable="true" aria-label="Write a comment"></div>
      </article>
    </main>
  `, 'https://www.facebook.com/Alice/posts/pfbidABC');
  const editor = dom.window.document.querySelector('[contenteditable="true"]')!;
  editor.addEventListener('keydown', () => {
    const row = dom.window.document.createElement('article');
    row.setAttribute('role', 'article');
    row.innerHTML = '<span>Thoughtful reply</span><a href="?comment_id=Y29tbWVudDoxMjM=">timestamp</a>';
    dom.window.document.querySelector('#post')?.append(row);
  });
  const result = await run({
    kind: 'interaction_comment',
    params: { noteId: 'https://www.facebook.com/Alice/posts/pfbidABC', text: 'Thoughtful reply' },
  });
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.value.action, 'comment');
  assert.equal(result.output.value.ok, true);
});

test('Facebook ambiguous comment keeps the Cloud idempotency reason', async () => {
  install(`
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
        <div role="textbox" contenteditable="true" aria-label="Write a comment"></div>
      </article>
    </main>
  `, 'https://www.facebook.com/Alice/posts/pfbidABC');
  const result = await run({
    kind: 'interaction_comment',
    params: { noteId: 'https://www.facebook.com/Alice/posts/pfbidABC', text: 'Unacknowledged reply' },
  });
  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(result.output.value.reason, 'verification_ambiguous');
});

test('Facebook exact-target like never falls back to the first visible post', async () => {
  const dom = install(`
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidOTHER/">permalink</a>
        <button aria-label="Like">Like</button>
      </article>
    </main>
  `);
  let clicks = 0;
  dom.window.document.querySelector('button')?.addEventListener('click', () => { clicks += 1; });
  const result = await run({
    kind: 'interaction_like',
    params: { noteId: 'https://www.facebook.com/Alice/posts/pfbidMISSING' },
  });
  assert.equal(result.effectPhase, 'not_started');
  assert.equal(result.output.value.reason, 'target_not_found');
  assert.equal(clicks, 0);
});

test('Facebook Native action probes return only exact trusted targets', async () => {
  install(`
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
        <button aria-label="Like">Like</button>
        <div role="textbox" contenteditable="true" aria-label="Write a comment"></div>
      </article>
    </main>
  `);
  const like = await run({
    kind: 'like_probe',
    params: { noteId: 'https://www.facebook.com/Alice/posts/pfbidABC' },
  });
  assert.equal(like.output.kind, 'like_probe');
  assert.equal(like.output.value.ok, true);
  assert.equal(like.output.value.cx, 50);
  assert.equal(like.output.value.cy, 20);

  const editor = await run({
    kind: 'comment_editor_probe',
    params: { noteId: 'https://www.facebook.com/Alice/posts/pfbidABC' },
  });
  assert.equal(editor.output.kind, 'text_target');
  assert.equal(editor.output.value.ok, true);
  assert.equal(editor.output.value.value, '');
});

test('Facebook Feed Like keeps numeric summaries separate from the direct action control', async () => {
  install(`
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
        <button role="button" aria-label="1.2K reactions">1.2K</button>
        <div>
          <button role="button" aria-label="留下心情">44</button>
          <button role="button" aria-label="发表评论">9</button>
        </div>
      </article>
    </main>
  `);

  const target = await run({
    kind: 'feed_like_target_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidABC',
      operationId: 'feed-like-1',
    },
  });

  assert.equal(target.output.value.ok, true);
  assert.equal(target.output.value.state, 'neutral');
});

test('Facebook reaction picker ignores the original post Like control', async () => {
  install(`
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
        <button aria-label="Like">Like</button>
      </article>
      <div role="dialog" aria-label="Reactions">
        <button role="menuitemradio" aria-label="Like">Like</button>
        <button role="menuitemradio" aria-label="Love">Love</button>
      </div>
    </main>
  `);
  const picker = await run({ kind: 'like_picker_probe', params: {} });
  assert.equal(picker.output.value.ok, true);
  assert.equal(picker.output.value.cx, 50);
  assert.equal(picker.output.value.cy, 20);
});

test('Facebook Native Reel probes bind sibling multilingual like and author-qualified follow controls', async () => {
  const dom = install(`
    <main>
      <section id="reel-stage">
        <div id="video-root"><video src="https://cdn.example/reel-777.mp4"></video></div>
        <div id="action-rail">
          <button id="like" aria-label="Bày tỏ cảm xúc Thích bài viết của Re Su">Thích</button>
          <a id="author">Re Su</a>
          <button id="follow" aria-label="关注Re Su">关注</button>
        </div>
      </section>
    </main>
  `, 'https://www.facebook.com/reel/777');
  setRect(dom.window.document.querySelector('video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(dom.window.document.querySelector('#like')!, { left: 980, top: 500, right: 1_040, bottom: 550 });
  setRect(dom.window.document.querySelector('#author')!, { left: 590, top: 650, right: 680, bottom: 690 });
  setRect(dom.window.document.querySelector('#follow')!, { left: 690, top: 650, right: 770, bottom: 690 });

  const like = await run({
    kind: 'like_probe',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(like.output.value.ok, true);
  assert.equal(like.output.value.noteId, 'https://www.facebook.com/reel/777');

  const follow = await run({
    kind: 'follow_probe',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(follow.output.value.ok, true);
  assert.equal(follow.output.value.already, false);
  assert.equal(follow.output.value.noteId, 'https://www.facebook.com/reel/777');
});

test('Facebook Native Reel primary Like accepts the proven localized labels in the active action rail', async () => {
  for (const [locale, accessibleName, renderedText] of [
    ['zh-CN', '赞', '44'],
    ['zh-TW', '讚', '44'],
    ['en', 'Like', '44'],
    ['es', 'Me gusta', '44'],
    ['vi', 'Thích', '44'],
  ]) {
    const dom = install(`
      <main>
        <video id="video" src="https://cdn.example/reel-777.mp4"></video>
        <button id="like" aria-label="${accessibleName}">${renderedText}</button>
      </main>
    `, 'https://www.facebook.com/reel/777');
    const video = dom.window.document.querySelector('#video')!;
    const button = dom.window.document.querySelector('#like')!;
    setRect(video, { left: 500, top: 70, right: 940, bottom: 780 });
    setRect(button, { left: 980, top: 500, right: 1_040, bottom: 550 });
    button.addEventListener('click', () => {
      button.setAttribute('aria-pressed', 'true');
    });

    const probe = await run({
      kind: 'like_probe',
      params: { noteId: 'https://www.facebook.com/reel/777' },
    });
    assert.equal(probe.output.value.ok, true, locale);
    assert.equal(probe.output.value.already, false, locale);

    const committed = await run({
      kind: 'like_primary_commit',
      params: { noteId: 'https://www.facebook.com/reel/777' },
    });
    assert.equal(committed.output.value.clicked, true, locale);

    const verified = await run({
      kind: 'like_verify',
      params: { noteId: 'https://www.facebook.com/reel/777' },
    });
    assert.equal(verified.output.value.selected, true, locale);
  }
});

test('Facebook Native Reel bare zh-CN Like needs numeric content and active-video geometry', async () => {
  const dom = install(`
    <main>
      <video id="video" src="https://cdn.example/reel-777.mp4"></video>
      <button id="no-count" aria-label="赞">赞</button>
      <button id="off-rail" aria-label="赞">44</button>
      <button id="unknown" aria-label="支持">44</button>
    </main>
  `, 'https://www.facebook.com/reel/777');
  setRect(dom.window.document.querySelector('#video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(dom.window.document.querySelector('#no-count')!, { left: 980, top: 500, right: 1_040, bottom: 550 });
  setRect(dom.window.document.querySelector('#off-rail')!, { left: 1_180, top: 570, right: 1_240, bottom: 620 });
  setRect(dom.window.document.querySelector('#unknown')!, { left: 980, top: 640, right: 1_040, bottom: 690 });

  const probe = await run({
    kind: 'like_probe',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });

  assert.equal(probe.output.value.ok, false);
  assert.equal(probe.output.value.reason, 'like_button_not_found');
});

test('Facebook Native Reel probes reject ambiguous sibling controls', async () => {
  const dom = install(`
    <main>
      <div id="video-root"><video src="https://cdn.example/reel-777.mp4"></video></div>
      <div id="action-rail">
        <button id="like-a" aria-label="留下心情">赞</button>
        <button id="like-b" aria-label="Bày tỏ cảm xúc Thích">Thích</button>
      </div>
    </main>
  `, 'https://www.facebook.com/reel/777');
  setRect(dom.window.document.querySelector('video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(dom.window.document.querySelector('#like-a')!, { left: 980, top: 500, right: 1_040, bottom: 550 });
  setRect(dom.window.document.querySelector('#like-b')!, { left: 980, top: 570, right: 1_040, bottom: 620 });

  const like = await run({
    kind: 'like_probe',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(like.output.value.ok, false);
  assert.equal(like.output.value.reason, 'ambiguous_target');
});

test('Facebook Native Reel like excludes a lone comment reaction and dispatches zero clicks', async () => {
  const dom = install(`
    <main>
      <video id="video" src="https://cdn.example/reel-777.mp4"></video>
      <section aria-label="Comments">
        <button id="comment-like" aria-label="Like">Like</button>
      </section>
    </main>
  `, 'https://www.facebook.com/reel/777');
  const commentLike = dom.window.document.querySelector('#comment-like')!;
  let clicks = 0;
  commentLike.addEventListener('click', () => { clicks += 1; });
  setRect(dom.window.document.querySelector('#video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(commentLike, { left: 980, top: 500, right: 1_040, bottom: 550 });

  const committed = await run({
    kind: 'like_primary_commit',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(committed.output.value.ok, false);
  assert.equal(committed.output.value.reason, 'like_button_not_found');
  assert.equal(committed.output.value.clicked, false);
  assert.equal(clicks, 0);
});

test('Facebook Native Reel like ignores generic active CSS as a selected-state witness', async () => {
  const dom = install(`
    <main>
      <video id="video" src="https://cdn.example/reel-777.mp4"></video>
      <button id="like" class="active" aria-label="Like">Like</button>
    </main>
  `, 'https://www.facebook.com/reel/777');
  const like = dom.window.document.querySelector('#like')!;
  let clicks = 0;
  like.addEventListener('click', () => { clicks += 1; });
  setRect(dom.window.document.querySelector('#video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(like, { left: 980, top: 500, right: 1_040, bottom: 550 });

  const probe = await run({
    kind: 'like_probe',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(probe.output.value.ok, true);
  assert.equal(probe.output.value.already, false);

  const committed = await run({
    kind: 'like_primary_commit',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(committed.output.value.already, false);
  assert.equal(committed.output.value.clicked, true);
  assert.equal(clicks, 1);

  const verified = await run({
    kind: 'like_verify',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(verified.output.value.ok, true);
  assert.equal(verified.output.value.selected, false);
  assert.equal(verified.output.value.witness, undefined);
});

test('Facebook Native Reel like fresh commit and verify remain bound to the same Reel', async () => {
  const dom = install(`
    <main>
      <div id="video-root"><video src="https://cdn.example/reel-777.mp4"></video></div>
      <div id="action-rail">
        <button id="like" aria-label="留下心情" aria-pressed="false"></button>
      </div>
    </main>
  `, 'https://www.facebook.com/reel/777');
  const button = dom.window.document.querySelector('#like')!;
  setRect(dom.window.document.querySelector('video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(button, { left: 980, top: 500, right: 1_040, bottom: 550 });
  button.addEventListener('click', () => {
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label', '取消赞');
  });

  const committed = await run({
    kind: 'like_primary_commit',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(committed.output.kind, 'like_commit');
  assert.equal(committed.output.value.ok, true);
  assert.equal(committed.output.value.clicked, true);
  assert.equal(committed.output.value.noteId, 'https://www.facebook.com/reel/777');

  const verified = await run({
    kind: 'like_verify',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(verified.output.kind, 'like_verify');
  assert.equal(verified.output.value.ok, true);
  assert.equal(verified.output.value.selected, true);
});

test('Facebook Native Reel like verification rejects same-route active video movement', async () => {
  const dom = install(`
    <main>
      <div id="video-root"><video id="before" src="https://cdn.example/reel-777.mp4"></video></div>
      <button id="like" aria-label="留下心情"></button>
    </main>
  `, 'https://www.facebook.com/reel/777');
  const before = dom.window.document.querySelector('#before')!;
  const like = dom.window.document.querySelector('#like')!;
  setRect(before, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(like, { left: 980, top: 500, right: 1_040, bottom: 550 });

  const committed = await run({
    kind: 'like_primary_commit',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(committed.output.value.clicked, true);

  const after = dom.window.document.createElement('video');
  after.src = 'https://cdn.example/reel-777.mp4';
  before.replaceWith(after);
  setRect(after, { left: 500, top: 70, right: 940, bottom: 780 });

  const verified = await run({
    kind: 'like_verify',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(verified.output.value.ok, false);
  assert.equal(verified.output.value.reason, 'reel_moved');
  assert.equal(verified.output.value.selected, false);
});

test('Facebook Native Reel like verification rejects a primary control leaving the action rail', async () => {
  const dom = install(`
    <main>
      <video id="video" src="https://cdn.example/reel-777.mp4"></video>
      <button id="like" aria-label="留下心情"></button>
    </main>
  `, 'https://www.facebook.com/reel/777');
  const like = dom.window.document.querySelector('#like')!;
  setRect(dom.window.document.querySelector('#video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(like, { left: 980, top: 500, right: 1_040, bottom: 550 });

  const committed = await run({
    kind: 'like_primary_commit',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(committed.output.value.clicked, true);

  setRect(like, { left: 600, top: 500, right: 660, bottom: 550 });
  const verified = await run({
    kind: 'like_verify',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(verified.output.value.ok, false);
  assert.equal(verified.output.value.reason, 'target_not_found');

  const picker = await run({
    kind: 'like_picker_probe',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(picker.output.value.ok, false);
  assert.equal(picker.output.value.reason, 'like_primary_target_lost');
});

test('Facebook Native Reel picker probe is scoped to one visible multi-reaction picker', async () => {
  const dom = install(`
    <main>
      <div id="video-root"><video src="https://cdn.example/reel-777.mp4"></video></div>
      <button id="decoy" aria-label="Like">Like</button>
      <div id="action-rail">
        <button id="primary" aria-label="留下心情"></button>
      </div>
    </main>
  `, 'https://www.facebook.com/reel/777');
  const primary = dom.window.document.querySelector('#primary')!;
  setRect(dom.window.document.querySelector('video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(primary, { left: 980, top: 500, right: 1_040, bottom: 550 });
  setRect(dom.window.document.querySelector('#decoy')!, { left: 100, top: 100, right: 160, bottom: 140 });
  primary.addEventListener('click', () => {
    const picker = dom.window.document.createElement('div');
    picker.id = 'picker';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Reactions');
    picker.innerHTML = `
      <button id="picker-like" role="menuitemradio" aria-label="Like">Like</button>
      <button id="picker-love" role="menuitemradio" aria-label="Love">Love</button>
    `;
    dom.window.document.querySelector('main')?.append(picker);
    setRect(picker, { left: 900, top: 420, right: 1_120, bottom: 620 });
    setRect(picker.querySelector('#picker-like')!, { left: 930, top: 460, right: 980, bottom: 510 });
    setRect(picker.querySelector('#picker-love')!, { left: 990, top: 460, right: 1_040, bottom: 510 });
  });

  const committed = await run({
    kind: 'like_primary_commit',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(committed.output.value.clicked, true);

  const picker = await run({
    kind: 'like_picker_probe',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(picker.output.value.ok, true);
  assert.equal(picker.output.value.cx, 955);
  assert.equal(picker.output.value.cy, 485);
});

test('Facebook Native Reel follow probe recognizes already-following author labels without clicking', async () => {
  const dom = install(`
    <main>
      <div id="video-root"><video src="https://cdn.example/reel-777.mp4"></video></div>
      <a id="author">Re Su</a>
      <button id="following" aria-label="Đang theo dõi Re Su">Đang theo dõi</button>
    </main>
  `, 'https://www.facebook.com/reel/777');
  setRect(dom.window.document.querySelector('video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(dom.window.document.querySelector('#author')!, { left: 590, top: 650, right: 680, bottom: 690 });
  setRect(dom.window.document.querySelector('#following')!, { left: 690, top: 650, right: 800, bottom: 690 });

  const follow = await run({
    kind: 'follow_probe',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(follow.output.value.ok, true);
  assert.equal(follow.output.value.already, true);
  assert.equal(follow.output.value.noteId, 'https://www.facebook.com/reel/777');
  assert.equal(follow.output.value.author, 'Re Su');
  assert.match(String(follow.output.value.videoKey), /reel-777\.mp4@element:/);
});

test('Facebook Native Reel follow probe retains every author-qualified locale and state family', async () => {
  for (const [accessibleName, already] of [
    ['Follow Re Su', false],
    ['关注Re Su', false],
    ['關注 Re Su', false],
    ['Theo dõi Re Su', false],
    ['Theo doi Re Su', false],
    ['Following Re Su', true],
    ['已关注 Re Su', true],
    ['關注中 Re Su', true],
    ['Đang theo dõi Re Su', true],
    ['Dang theo doi Re Su', true],
  ] as const) {
    const dom = install(`
      <main>
        <video id="video" src="https://cdn.example/reel-777.mp4"></video>
        <a id="author">Re Su</a>
        <button id="follow" aria-label="${accessibleName}">${accessibleName}</button>
      </main>
    `, 'https://www.facebook.com/reel/777');
    setRect(dom.window.document.querySelector('#video')!, { left: 500, top: 70, right: 940, bottom: 780 });
    setRect(dom.window.document.querySelector('#author')!, { left: 590, top: 650, right: 680, bottom: 690 });
    setRect(dom.window.document.querySelector('#follow')!, { left: 690, top: 650, right: 830, bottom: 690 });

    const result = await run({
      kind: 'follow_probe',
      params: { noteId: 'https://www.facebook.com/reel/777' },
    });
    assert.equal(result.output.value.ok, true, accessibleName);
    assert.equal(result.output.value.already, already, accessibleName);
    assert.equal(result.output.value.author, 'Re Su', accessibleName);
  }
});

test('Facebook Native Reel follow rejects a bare CTA without a unique author witness', async () => {
  const dom = install(`
    <main>
      <video id="video" src="https://cdn.example/reel-777.mp4"></video>
      <button id="follow" aria-label="Follow">Follow</button>
    </main>
  `, 'https://www.facebook.com/reel/777');
  setRect(dom.window.document.querySelector('#video')!, { left: 500, top: 70, right: 940, bottom: 780 });
  setRect(dom.window.document.querySelector('#follow')!, { left: 690, top: 650, right: 770, bottom: 690 });

  const follow = await run({
    kind: 'follow_probe',
    params: { noteId: 'https://www.facebook.com/reel/777' },
  });
  assert.equal(follow.output.value.ok, false);
  assert.equal(follow.output.value.reason, 'follow_button_not_found');
});

test('Facebook comment editor accepts one exclusive sibling editor and rejects nested reply editors', async () => {
  const dom = install(`
    <main>
      <section class="post-container">
        <article role="article">
          <a href="/Alice/posts/pfbidABC/">permalink</a>
          <article role="article">
            <a href="/Alice/posts/pfbidABC/?comment_id=9">comment</a>
            <div id="reply" role="textbox" contenteditable="true" aria-label="Write a comment"></div>
          </article>
        </article>
        <div id="composer" role="textbox" contenteditable="true" aria-label="Write a comment"></div>
      </section>
    </main>
  `);
  setRect(dom.window.document.querySelector('#reply')!, { left: 10, top: 10, right: 110, bottom: 50 });
  setRect(dom.window.document.querySelector('#composer')!, { left: 200, top: 100, right: 500, bottom: 140 });
  const editor = await run({
    kind: 'comment_editor_probe',
    params: { noteId: 'https://www.facebook.com/Alice/posts/pfbidABC' },
  });
  assert.equal(editor.output.value.ok, true);
  assert.equal(editor.output.value.cx, 350);
  assert.equal(editor.output.value.cy, 120);
});

test('Facebook comment editor reports a visible participation gate before typing', async () => {
  install(`
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
        <div role="textbox" contenteditable="true" aria-label="Comentar"></div>
      </article>
      <div role="dialog">Answer questions to participate</div>
    </main>
  `);
  const editor = await run({
    kind: 'comment_editor_probe',
    params: { noteId: 'https://www.facebook.com/Alice/posts/pfbidABC' },
  });
  assert.equal(editor.output.value.ok, false);
  assert.equal(editor.output.value.reason, 'pending_group_approval');
});

test('Facebook comment acknowledgement is scoped to the bound account and server evidence', async () => {
  install(`
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
        <article role="article">
          <a href="/profile.php?id=61591824155856">Gi Vo</a>
          <span>Thoughtful reply</span>
          <a href="?comment_id=Y29tbWVudDoxMjM=">timestamp</a>
        </article>
      </article>
    </main>
  `);
  const own = await run({
    kind: 'comment_ack_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidABC',
      text: 'Thoughtful reply',
      accountId: '61591824155856',
    },
  });
  assert.equal(own.output.value.confirmed, true);

  const other = await run({
    kind: 'comment_ack_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidABC',
      text: 'Thoughtful reply',
      accountId: '99999999999999',
    },
  });
  assert.equal(other.output.value.confirmed, false);
});

test('Facebook comment acknowledgement accepts a numeric server comment id and still rejects client placeholders', async () => {
  // 真机（2026-07-28，越南语群 feed 就地首帖评论）：Enter+73ms 是 `client:<uuid>` 占位，
  // Enter+4.29s 换成纯数字 1531497545657803 且刷新后仍在；「回复」控件 3 分钟内始终未出现，
  // 故 like+reply 兜底也不成立——只认 base64 形态时该评论永远确认不了（假失败，且照样打去重烧掉目标帖）。
  const row = (commentId: string): string => `
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
        <article role="article">
          <a href="/groups/600322513093927/user/61591934100810/">Hi He</a>
          <span>Thoughtful reply</span>
          <a href="?comment_id=${commentId}">timestamp</a>
        </article>
      </article>
    </main>
  `;
  const probe = async (): Promise<boolean> => {
    const result = await run({
      kind: 'comment_ack_probe',
      params: {
        noteId: 'https://www.facebook.com/Alice/posts/pfbidABC',
        text: 'Thoughtful reply',
        accountId: '61591934100810',
      },
    });
    return result.output.value.confirmed === true;
  };

  install(row('1531497545657803'));
  assert.equal(await probe(), true, '纯数字服务器 id 必须判为已确认');

  install(row('client%3A46fd0dfd-c6b0-4bb5-9444-5232a49192e2'));
  assert.equal(await probe(), false, '客户端乐观占位绝不判成功');

  install(row('46fd0dfd-c6b0-4bb5-9444-5232a49192e2'));
  assert.equal(await probe(), false, '裸 UUID 占位绝不判成功');
});

test('Facebook comment acknowledgement retains the retired pending-approval vocabulary', async () => {
  for (const status of [
    '待审核',
    '待审批',
    '待批准',
    '等待审核',
    '等待管理员批准',
    '需管理员批准',
    '需经管理员审核',
    '管理员审核后才可见',
    '管理员批准后可见',
    '通过后可见',
    'pending review',
    'pending approval',
    'awaiting admin approval',
    'awaiting administrator approval',
    'will be visible once approved',
    'will be visible after',
    'need admin approval',
    'needs administrator approval',
    'visible after approved',
  ]) {
    install(`
      <main>
        <article role="article">
          <a href="/Alice/posts/pfbidABC/">permalink</a>
          <article role="article">
            <a href="/profile.php?id=61591824155856">Gi Vo</a>
            <span>Thoughtful reply</span>
            <span>${status}</span>
          </article>
        </article>
      </main>
    `);
    const result = await run({
      kind: 'comment_ack_probe',
      params: {
        noteId: 'https://www.facebook.com/Alice/posts/pfbidABC',
        text: 'Thoughtful reply',
        accountId: '61591824155856',
      },
    });
    assert.equal(result.output.value.confirmed, false, status);
    assert.equal(result.output.value.pending, true, status);
  }
});

test('Facebook comment editor and acknowledgement retain localized editor and control families', async () => {
  for (const editorLabel of [
    '写评论',
    '留言',
    'Write a comment',
    'Bình luận',
    'Comentar',
    '输入回答',
    'Answer',
  ]) {
    install(`
      <main>
        <article role="article">
          <a href="/Alice/posts/pfbidABC/">permalink</a>
          <div role="textbox" contenteditable="true" aria-label="${editorLabel}"></div>
        </article>
      </main>
    `);
    const editor = await run({
      kind: 'comment_editor_probe',
      params: { noteId: 'https://www.facebook.com/Alice/posts/pfbidABC' },
    });
    assert.equal(editor.output.value.ok, true, editorLabel);
  }

  const likeLabels = ['赞', '讚', '点赞', '按赞', 'Like', 'Thích'];
  const replyLabels = ['回复', '回覆', 'Reply', 'Trả lời', 'Phản hồi'];
  for (let index = 0; index < Math.max(likeLabels.length, replyLabels.length); index += 1) {
    const likeLabel = likeLabels[index % likeLabels.length]!;
    const replyLabel = replyLabels[index % replyLabels.length]!;
    install(`
      <main>
        <article role="article">
          <a href="/Alice/posts/pfbidABC/">permalink</a>
          <article role="article">
            <a href="/profile.php?id=61591824155856">Gi Vo</a>
            <span>Thoughtful reply</span>
            <button aria-label="${likeLabel}"></button>
            <button aria-label="${replyLabel}"></button>
          </article>
        </article>
      </main>
    `);
    const acknowledgement = await run({
      kind: 'comment_ack_probe',
      params: {
        noteId: 'https://www.facebook.com/Alice/posts/pfbidABC',
        text: 'Thoughtful reply',
        accountId: '61591824155856',
      },
    });
    assert.equal(acknowledgement.output.value.confirmed, true, `${likeLabel}/${replyLabel}`);
  }
});

test('Facebook comment acknowledgement retains rejected and in-flight locale families', async () => {
  const rejectedLabels = [
    '已拒绝',
    '被拒绝',
    '遭拒绝',
    '已驳回',
    '已被驳回',
    '查看反馈',
    '查看意见反馈',
    'Đã từ chối',
    'Bị từ chối',
    'Xem phản hồi',
    'Rejected',
    'Declined',
    'was not approved',
    'See feedback',
    'View feedback',
  ];
  const inFlightLabels = [
    '发布中',
    '發佈中',
    '发送中',
    '發送中',
    'Đang đăng',
    'Đang gửi',
    'Posting',
    'Sending',
  ];
  for (const [status, expected] of [
    ...rejectedLabels.map((status) => [status, 'rejected'] as const),
    ...inFlightLabels.map((status) => [status, 'inFlight'] as const),
  ]) {
    install(`
      <main>
        <article role="article">
          <a href="/Alice/posts/pfbidABC/">permalink</a>
          <article role="article">
            <a href="/profile.php?id=61591824155856">Gi Vo</a>
            <span>Thoughtful reply</span>
            <span>${status}</span>
          </article>
        </article>
      </main>
    `);
    const result = await run({
      kind: 'comment_ack_probe',
      params: {
        noteId: 'https://www.facebook.com/Alice/posts/pfbidABC',
        text: 'Thoughtful reply',
        accountId: '61591824155856',
      },
    });
    assert.equal(result.output.value.confirmed, false, status);
    assert.equal(result.output.value[expected], true, status);
  }
});

test('Facebook comment acknowledgement does not read pending words from the submitted body', async () => {
  const submitted = 'A note about pending approval';
  install(`
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
        <article role="article">
          <a href="/profile.php?id=61591824155856">Gi Vo</a>
          <span>${submitted}</span>
          <a href="?comment_id=Y29tbWVudDoxMjM=">timestamp</a>
        </article>
      </article>
    </main>
  `);

  const result = await run({
    kind: 'comment_ack_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidABC',
      text: submitted,
      accountId: '61591824155856',
    },
  });

  assert.equal(result.output.value.confirmed, true);
  assert.equal(result.output.value.pending, false);
});

test('Facebook comment acknowledgement ignores lifecycle words outside the own scoped row', async () => {
  install(`
    <main>
      <article role="article">
        <a href="/Alice/posts/pfbidABC/">permalink</a>
      </article>
      <aside>Another comment was rejected. View feedback.</aside>
    </main>
  `);
  const result = await run({
    kind: 'comment_ack_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidABC',
      text: 'Thoughtful reply',
      accountId: '61591824155856',
    },
  });
  assert.equal(result.output.value.confirmed, false);
  assert.equal(result.output.value.rejected, false);
  assert.equal(result.output.value.pending, false);
});

test('Facebook page probe reports captcha from semantic page evidence', async () => {
  install('<main><div>Security check — please complete captcha</div></main>');
  const result = await run({ kind: 'page_probe', params: {} });
  assert.equal(result.output.kind, 'page_probe');
  assert.equal(result.output.value.pageKind, 'captcha');
});

test('Facebook page probe distinguishes generic checkpoint and throttle from captcha', async () => {
  install('<main><div>Security checkpoint: confirm this login</div></main>', 'https://www.facebook.com/checkpoint/123');
  const checkpoint = await run({ kind: 'page_probe', params: {} });
  assert.equal(checkpoint.output.value.pageKind, 'unknown');
  assert.equal(checkpoint.output.value.blockingKind, 'unknown');
  assert.match(String(checkpoint.output.value.blockingText), /Security checkpoint/);
  assert.equal((checkpoint.output.value.signals as Record<string, unknown>).captchaSignalCount, 0);

  install('<main><div>We limit how often you can do this. Please try again later.</div></main>');
  const throttle = await run({ kind: 'page_probe', params: {} });
  assert.equal(throttle.output.value.blockingKind, 'unknown');
  assert.match(String(throttle.output.value.blockingText), /limit how often/);
});

test('Facebook consent probe preserves accept-all and necessary-only as distinct unique targets', async () => {
  install(`
    <main>
      <div role="dialog">
        <p>We use cookies. Read our Cookie Policy.</p>
        <button aria-label="Allow all cookies">Allow all cookies</button>
        <button aria-label="Only allow essential cookies">Only allow essential cookies</button>
      </div>
    </main>
  `);
  const result = await run({ kind: 'consent_probe', params: {} });
  assert.equal(result.output.kind, 'consent_probe');
  assert.equal(result.output.value.present, true);
  assert.deepEqual(result.output.value.acceptAll, { cx: 50, cy: 20 });
  assert.deepEqual(result.output.value.necessaryOnly, { cx: 50, cy: 20 });
  assert.equal(result.output.value.acceptAllAmbiguous, false);
  assert.equal(result.output.value.necessaryOnlyAmbiguous, false);
});

test('Facebook consent probe retains every evidence-backed action label', async () => {
  const acceptAllLabels = [
    '允许所有 Cookie',
    '允许全部 Cookie',
    '接受所有 Cookie',
    '同意所有 Cookie',
    '允许 Facebook 使用 Cookie',
    '允许使用 Cookie',
    'Allow all cookies',
    'Accept all cookies',
    'Allow the use of cookies',
  ];
  const necessaryOnlyLabels = [
    '仅允许必要 Cookie',
    '只允许必要 Cookie',
    '仅接受必要 Cookie',
    '拒绝非必要 Cookie',
    'Only allow essential cookies',
    'Decline optional cookies',
    'Refuse non-essential cookies',
    'Refuse nonessential cookies',
  ];
  for (const label of acceptAllLabels) {
    install(`
      <main><div role="dialog">
        <p>Read our Cookie Policy.</p>
        <button aria-label="${label}">${label}</button>
      </div></main>
    `);
    const result = await run({ kind: 'consent_probe', params: {} });
    assert.equal(result.output.value.present, true, label);
    assert.deepEqual(result.output.value.acceptAll, { cx: 50, cy: 20 }, label);
  }
  for (const label of necessaryOnlyLabels) {
    install(`
      <main><div role="dialog">
        <p>Read our Cookie Policy.</p>
        <button aria-label="${label}">${label}</button>
      </div></main>
    `);
    const result = await run({ kind: 'consent_probe', params: {} });
    assert.equal(result.output.value.present, true, label);
    assert.deepEqual(result.output.value.necessaryOnly, { cx: 50, cy: 20 }, label);
  }
});

test('Facebook group join clicks only one in-scope CTA and verifies membership afterwards', async () => {
  const dom = install(`
    <nav><button aria-label="Join">navigation decoy</button></nav>
    <main><section><h1>Agent Builders</h1><button id="join" aria-label="Join">Join</button></section></main>
  `, 'https://www.facebook.com/groups/42');
  dom.window.document.querySelector('#join')?.addEventListener('click', (event) => {
    (event.currentTarget as Element).setAttribute('aria-label', 'Joined');
  });
  const result = await run({
    kind: 'group_join',
    params: { groupUrl: 'https://www.facebook.com/groups/42', click: true },
  });
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.value.action, 'join_group');
  assert.equal(result.output.value.ok, true);
  assert.equal(result.output.value.clicked, true);
  assert.equal((result.output.value.postObservation as Record<string, unknown>).targetGroupId, '42');
});

test('Facebook group join never selects a recommended-group CTA when the target group is pending', async () => {
  install(`
    <main>
      <section id="target-group">
        <h1>Agent Builders</h1>
        <button aria-label="Pending">Pending</button>
      </section>
      <section id="recommended-group">
        <h2>Suggested Group</h2>
        <a href="/groups/99"><span>Suggested Group</span></a>
        <button id="wrong-join" aria-label="Join">Join</button>
      </section>
    </main>
  `, 'https://www.facebook.com/groups/42');
  const probe = await run({ kind: 'join_probe', params: {} });
  assert.equal(probe.output.value.pending, true);
  assert.equal(probe.output.value.found, false);
  assert.equal((probe.output.value.observation as Record<string, unknown>).outOfScopeJoinCount, 1);
});

test('Facebook join scope treats the target header numeric members link as a vanity-group alias', async () => {
  install(`
    <main>
      <section id="target-group">
        <div>
          <h1>TUYỂN DỤNG VIỆC LÀM KCN ĐỒNG VĂN</h1>
          <a href="/groups/1611255345558924/members/">3,902 位成员</a>
        </div>
        <div><button aria-label="已加入">已加入</button></div>
      </section>
      <section data-navigation-payload="/groups/99">
        <h2>Suggested Group</h2>
        <button aria-label="加入小组">加入小组</button>
      </section>
    </main>
  `, 'https://www.facebook.com/groups/tuyendung.dongvan');

  const probe = await run({ kind: 'join_probe', params: {} });
  const observation = probe.output.value.observation as Record<string, unknown>;
  const candidates = observation.ctaCandidates as Array<Record<string, unknown>>;

  assert.equal(probe.output.value.joined, true);
  assert.deepEqual(observation.membershipSignals, ['已加入']);
  assert.equal(candidates.find((item) => item.text === '已加入')?.inTargetScope, true);
  assert.equal(candidates.find((item) => item.text === '加入小组')?.inTargetScope, false);
});

test('Facebook join scope does not learn a numeric alias from a recommendation at main level', async () => {
  install(`
    <main>
      <section id="target-group">
        <h1>Agent Builders</h1>
        <button aria-label="Pending">Pending</button>
      </section>
      <section id="recommended-group">
        <a href="/groups/99/members/">99 members</a>
        <button aria-label="Join group">Join group</button>
      </section>
    </main>
  `, 'https://www.facebook.com/groups/42');

  const probe = await run({ kind: 'join_probe', params: {} });

  assert.equal(probe.output.value.pending, true);
  assert.equal(probe.output.value.found, false);
  assert.equal((probe.output.value.observation as Record<string, unknown>).outOfScopeJoinCount, 1);
});

test('Facebook join scope rejects an attribute-encoded recommendation decoy outside the target header', async () => {
  install(`
    <main>
      <section id="target-group">
        <h1>Agent Builders</h1>
        <button aria-label="Pending">Pending</button>
      </section>
      <section id="recommended-group" data-navigation-payload="/groups/99">
        <h2>Suggested Group</h2>
        <button aria-label="Join group">Join group</button>
      </section>
    </main>
  `, 'https://www.facebook.com/groups/42');

  const probe = await run({ kind: 'join_probe', params: {} });

  assert.equal(probe.output.value.pending, true);
  assert.equal(probe.output.value.found, false);
  assert.equal(probe.output.value.ambiguous, false);
  assert.equal((probe.output.value.observation as Record<string, unknown>).scopeResolved, true);
  assert.equal((probe.output.value.observation as Record<string, unknown>).outOfScopeJoinCount, 1);
});

test('Facebook join scope fails closed when symmetric primary headings make the target region ambiguous', async () => {
  install(`
    <main>
      <section><h1>Agent Builders</h1><button aria-label="Join group">Join group</button></section>
      <section><h1>Agent Builders mirror</h1><button aria-label="Join group">Join group</button></section>
    </main>
  `, 'https://www.facebook.com/groups/42');

  const probe = await run({ kind: 'join_probe', params: {} });

  assert.equal(probe.output.value.found, false);
  assert.equal(probe.output.value.ambiguous, true);
  assert.equal((probe.output.value.observation as Record<string, unknown>).scopeResolved, false);
});

test('Facebook join actuation freshly resolves and invokes the React-owned in-scope element', async () => {
  const dom = install(`
    <main><section><h1>Agent Builders</h1><button id="join" aria-label="Join group">Join group</button></section></main>
  `, 'https://www.facebook.com/groups/42');
  const button = dom.window.document.querySelector('#join')!;
  let invoked = 0;
  button.addEventListener('click', () => {
    invoked += 1;
    button.setAttribute('aria-label', 'Joined');
    button.textContent = 'Joined';
  });

  const initial = await run({ kind: 'join_probe', params: {} });
  assert.equal(initial.output.value.found, true);

  const clicked = await run({ kind: 'join_click', params: {} });

  assert.equal(clicked.output.kind, 'join_click');
  assert.equal(clicked.output.value.clicked, true);
  assert.equal(invoked, 1);
  const after = await run({ kind: 'join_probe', params: {} });
  assert.equal(after.output.value.joined, true);
});

test('Facebook join actuation reports no target and never clicks an out-of-scope recommendation', async () => {
  const dom = install(`
    <main>
      <section><h1>Agent Builders</h1><button aria-label="Pending">Pending</button></section>
      <section data-navigation-payload="/groups/99">
        <h2>Suggested Group</h2><button id="wrong" aria-label="Join group">Join group</button>
      </section>
    </main>
  `, 'https://www.facebook.com/groups/42');
  let wrongClicks = 0;
  dom.window.document.querySelector('#wrong')?.addEventListener('click', () => { wrongClicks += 1; });

  const result = await run({ kind: 'join_click', params: {} });

  assert.equal(result.output.kind, 'join_click');
  assert.equal(result.output.value.clicked, false);
  assert.equal(result.output.value.reason, 'no_target_in_scope');
  assert.equal(wrongClicks, 0);
});

test('Facebook join probe does not let a simultaneous in-scope member label override Join', async () => {
  install(`
    <main><section>
      <h1>Agent Builders</h1>
      <button aria-label="Joined">Joined</button>
      <button aria-label="Join group">Join group</button>
    </section></main>
  `, 'https://www.facebook.com/groups/42');

  const result = await run({ kind: 'join_probe', params: {} });

  assert.equal(result.output.value.joined, false);
  assert.equal(result.output.value.found, true);
  assert.equal((result.output.value.observation as Record<string, unknown>).joinCtaPresent, true);
});

test('Facebook join classifies pending before a structural composer transition', async () => {
  const dom = install(`
    <main><section><h1>Agent Builders</h1><button id="join" aria-label="Join group">Join group</button></section></main>
  `, 'https://www.facebook.com/groups/42');
  dom.window.document.querySelector('#join')?.addEventListener('click', (event) => {
    const button = event.currentTarget as Element;
    button.setAttribute('aria-label', 'Pending');
    button.textContent = 'Pending';
    const composer = dom.window.document.createElement('div');
    composer.setAttribute('role', 'textbox');
    composer.setAttribute('contenteditable', 'true');
    dom.window.document.querySelector('section')?.append(composer);
  });

  const result = await run({
    kind: 'group_join',
    params: { groupUrl: 'https://www.facebook.com/groups/42', click: true },
  });

  assert.equal(result.output.value.ok, false);
  assert.equal(result.output.value.reason, 'pending');
  assert.equal(result.output.value.clicked, true);
});

test('Facebook group join preserves login and captcha blockers without actuation', async () => {
  install(`
    <main><form action="/login">Log in to Facebook<input name="email"><input name="pass" type="password"></form></main>
  `, 'https://www.facebook.com/groups/42');
  const login = await run({
    kind: 'group_join',
    params: { groupUrl: 'https://www.facebook.com/groups/42', click: true },
  });
  assert.equal(login.output.value.reason, 'login_required');

  install(`
    <main><div role="dialog">Security check CAPTCHA</div></main>
  `, 'https://www.facebook.com/groups/42');
  const captcha = await run({
    kind: 'group_join',
    params: { groupUrl: 'https://www.facebook.com/groups/42', click: true },
  });
  assert.equal(captcha.output.value.reason, 'blocked_by_captcha');
});

test('Facebook group join retains every localized membership state family', async () => {
  const joinLabels = [
    'join group', 'join', '加入小组', '加入群组', '加入社团', '加入', 'tham gia', 'únete',
    'unirte', 'participar', 'entrar al grupo', 'entrar no grupo', 'gabung', 'bergabung',
    'เข้าร่วม', 'rejoindre', 'beitreten', 'iscriviti', 'вступить', 'присоединиться', '참여',
    '가입', 'انضمام', 'انضم', 'sertai',
  ];
  const memberLabels = [
    'joined', 'leave group', '已加入', '退出小组', '退出群组', '退出社团', 'đã tham gia',
    'rời nhóm', 'salir del grupo', 'keluar dari grup', 'quitter le groupe', 'gruppe verlassen',
    'ออกจากกลุ่ม', '已是成员', '你已加入',
  ];
  const pendingLabels = [
    'pending', 'request sent', 'cancel request', '待批准', '已申请', '待审批', '待审核',
    '取消请求', '取消加入请求', '取消申请', '已发送请求', 'đang chờ', 'hủy yêu cầu',
    'solicitud enviada', 'cancelar solicitud', 'menunggu', 'batalkan permintaan',
    'demande envoyée', 'annuler la demande', 'anfrage gesendet', 'รอการอนุมัติ', '요청 보냄',
    '요청됨', 'requested',
  ];
  const questionLabels = [
    'membership questions', 'answer questions', 'answer these questions', 'questions to join',
    'required question', '回答问题', '入群问题', '必答', '加入前请回答', 'trả lời câu hỏi',
    'responde las preguntas', 'preguntas de membresía', 'jawab pertanyaan',
    'répondez aux questions', 'beantworte die fragen', 'ตอบคำถาม',
  ];

  for (const label of joinLabels) {
    install(`
      <main><section><h1>Agent Builders</h1><button aria-label="${label}">${label}</button></section></main>
    `, 'https://www.facebook.com/groups/42');
    const result = await run({ kind: 'join_probe', params: {} });
    assert.equal(result.output.value.found, true, label);
    assert.equal((result.output.value.observation as Record<string, unknown>).joinCtaPresent, true, label);
  }
  for (const label of memberLabels) {
    install(`
      <main><section><h1>Agent Builders</h1><button aria-label="${label}">${label}</button></section></main>
    `, 'https://www.facebook.com/groups/42');
    const result = await run({ kind: 'join_probe', params: {} });
    assert.equal(result.output.value.joined, true, label);
  }
  for (const label of pendingLabels) {
    install(`
      <main><section><h1>Agent Builders</h1><button aria-label="${label}">${label}</button></section></main>
    `, 'https://www.facebook.com/groups/42');
    const result = await run({ kind: 'join_probe', params: {} });
    assert.equal(result.output.value.pending, true, label);
  }
  for (const label of questionLabels) {
    install(`
      <main>
        <section><h1>Agent Builders</h1></section>
        <div role="dialog">${label}</div>
      </main>
    `, 'https://www.facebook.com/groups/42');
    const result = await run({ kind: 'join_probe', params: {} });
    assert.equal(result.output.value.questionnaire, true, label);
  }
});

test('Facebook join probe does not treat a pre-existing public composer as membership', async () => {
  install(`
    <main>
      <section>
        <h1>Public Agent Builders</h1>
        <button aria-label="Join">Join</button>
        <div role="textbox" contenteditable="true" aria-label="Write a comment"></div>
      </section>
    </main>
  `, 'https://www.facebook.com/groups/42');
  const result = await run({ kind: 'join_probe', params: {} });
  assert.equal(result.output.kind, 'join_probe');
  assert.equal(result.output.value.joined, false);
  assert.equal(result.output.value.found, true);
  assert.equal((result.output.value.observation as Record<string, unknown>).composerPresent, true);
});

test('Facebook publish entry probe retains every retired localized label family', async () => {
  for (const accessibleName of [
    "What's on your mind",
    'Create post',
    'Create a post',
    'Write something',
    '写点什么',
    '你在想什么',
    '创建帖子',
    'Tianxing Bai，分享你的新鲜事吧！',
    'Bạn đang nghĩ gì',
    'Crear publicación',
    'Crear una publicación',
    'Post something',
  ]) {
    install(`<main><button aria-label="${accessibleName}"></button></main>`);
    const result = await run({ kind: 'publish_entry_probe', params: {} });
    assert.equal(result.output.kind, 'point_target', accessibleName);
    assert.equal(result.output.value.ok, true, accessibleName);
  }
});

test('Facebook publish home probe uses visible structural and blocking state from one snapshot', async () => {
  install(`
    <main style="display:none"></main>
    <div role="dialog">Account notice</div>
  `);
  const blocked = await run({ kind: 'publish_home_probe', params: {} });
  assert.equal(blocked.output.kind, 'publish_home_probe');
  assert.equal(blocked.output.value.mainVisible, false);
  assert.equal(blocked.output.value.editorReady, false);
  assert.equal(blocked.output.value.blockingDialog, true);

  install(`
    <main>
      <div role="dialog">
        <div role="textbox" contenteditable="true" aria-label="写点什么"></div>
      </div>
    </main>
  `);
  const composer = await run({ kind: 'publish_home_probe', params: {} });
  assert.equal(composer.output.value.mainVisible, true);
  assert.equal(composer.output.value.editorReady, true);
  assert.equal(composer.output.value.blockingDialog, false);
});

test('Facebook publish probes keep editor and submit locale families capability-scoped', async () => {
  for (const editorLabel of [
    "What's on your mind",
    'Create a public post',
    'Write something',
    '写点什么',
    '在想什么',
    'Bạn đang nghĩ gì',
    'Qué estás pensando',
    'Publicación',
  ]) {
    install(`
      <main><div role="dialog">
        <div role="textbox" contenteditable="true" aria-label="${editorLabel}"></div>
      </div></main>
    `);
    const result = await run({ kind: 'publish_editor_probe', params: {} });
    assert.equal(result.output.value.ok, true, editorLabel);
  }

  for (const submitLabel of ['Post', '发布', '發佈', '发帖', 'Đăng', 'Publicar', 'Compartir']) {
    install(`
      <main><div role="dialog">
        <div role="textbox" contenteditable="true"></div>
        <button aria-label="${submitLabel}"></button>
      </div></main>
    `);
    const result = await run({ kind: 'publish_submit_probe', params: {} });
    assert.equal(result.output.kind, 'publish_submit_probe', submitLabel);
    assert.equal(result.output.value.ok, true, submitLabel);
    assert.equal(result.output.value.disabled, false, submitLabel);
  }
});

test('Facebook publish submitted probe retains composer-close and localized state witnesses', async () => {
  for (const submittedState of [
    'Your post is being processed',
    'Your post has been shared',
    'Post shared',
    '已发布',
    '发布中',
    '發佈中',
    'Đã đăng',
    'Publicación compartida',
  ]) {
    install(`
      <main>
        <div role="dialog"><div role="textbox" contenteditable="true"></div></div>
        <div role="status">${submittedState}</div>
      </main>
    `);
    const result = await run({ kind: 'publish_submitted_probe', params: {} });
    assert.equal(result.output.value.confirmed, true, submittedState);
    assert.equal(result.output.value.witness, 'submitted_state', submittedState);
  }

  install('<main><div role="status">Home feed</div></main>');
  const closed = await run({ kind: 'publish_submitted_probe', params: {} });
  assert.equal(closed.output.value.confirmed, true);
  assert.equal(closed.output.value.witness, 'composer_closed');

  install('<main><div role="dialog"><div role="textbox" contenteditable="true"></div></div></main>');
  const open = await run({ kind: 'publish_submitted_probe', params: {} });
  assert.equal(open.output.value.confirmed, false);
  assert.equal(open.output.value.witness, undefined);
});

test('Facebook publish entry and submit probes reject decoys, ambiguity, and disabled controls', async () => {
  install(`
    <main>
      <button aria-label="Write a comment">Create post comment</button>
      <button aria-label="Tianxing Bai，分享你的新鲜事吧！"></button>
    </main>
  `);
  const entry = await run({ kind: 'publish_entry_probe', params: {} });
  assert.equal(entry.output.value.ok, true);

  install(`
    <main>
      <button aria-label="Create post"></button>
      <button aria-label="Create post"></button>
    </main>
  `);
  const ambiguous = await run({ kind: 'publish_entry_probe', params: {} });
  assert.equal(ambiguous.output.value.ok, false);
  assert.equal(ambiguous.output.value.reason, 'ambiguous_target');

  install(`
    <main>
      <button aria-label="Create post"></button>
      <button>Write something with a much longer rendered label</button>
    </main>
  `);
  const differentlyScored = await run({ kind: 'publish_entry_probe', params: {} });
  assert.equal(differentlyScored.output.value.ok, false);
  assert.equal(differentlyScored.output.value.reason, 'ambiguous_target');

  install(`
    <main><div role="dialog">
      <div role="textbox" contenteditable="true"></div>
      <button aria-label="Publicar" aria-disabled="true"></button>
    </div></main>
  `);
  const disabled = await run({ kind: 'publish_submit_probe', params: {} });
  assert.equal(disabled.output.value.ok, false);
  assert.equal(disabled.output.value.reason, 'submit_disabled');
});

test('Facebook publish entry canonicalizes a semantic region to its one real composer control', async () => {
  const dom = install(`
    <main>
      <div role="region" aria-label="创建帖子">
        <a role="link" aria-label="Tianxing Bai timeline"></a>
        <div role="button">Tianxing Bai，分享你的新鲜事吧！</div>
        <div role="button">直播视频</div>
        <div role="button">照片/视频</div>
        <div role="button">感受/活动</div>
      </div>
    </main>
  `);
  const region = dom.window.document.querySelector('[role="region"]')!;
  const composer = dom.window.document.querySelectorAll('[role="button"]')[0]!;
  setRect(region, { left: 20, top: 40, right: 1_000, bottom: 240 });
  setRect(composer, { left: 240, top: 100, right: 840, bottom: 160 });

  const entry = await run({ kind: 'publish_entry_probe', params: {} });
  assert.equal(entry.output.value.ok, true);
  assert.equal(entry.output.value.cx, 540);
  assert.equal(entry.output.value.cy, 130);
});

test('Facebook publish entry deduplicates matching label evidence inside one actionable control', async () => {
  const dom = install(`
    <main>
      <div role="region" aria-label="创建帖子">
        <button><span aria-label="Tianxing Bai，分享你的新鲜事吧！"></span></button>
      </div>
    </main>
  `);
  const button = dom.window.document.querySelector('button')!;
  setRect(button, { left: 300, top: 80, right: 900, bottom: 140 });

  const entry = await run({ kind: 'publish_entry_probe', params: {} });
  assert.equal(entry.output.value.ok, true);
  assert.equal(entry.output.value.cx, 600);
  assert.equal(entry.output.value.cy, 110);
});

test('Facebook publish entry preserves ambiguity for multiple real controls in one semantic region', async () => {
  install(`
    <main>
      <div role="region" aria-label="创建帖子">
        <button aria-label="Create post"></button>
        <button>Write something</button>
      </div>
    </main>
  `);

  const entry = await run({ kind: 'publish_entry_probe', params: {} });
  assert.equal(entry.output.value.ok, false);
  assert.equal(entry.output.value.reason, 'ambiguous_target');
});

test('Facebook publish entry does not click a matching non-actionable container without a real control', async () => {
  install('<main><div role="region" aria-label="创建帖子">Tianxing Bai，分享你的新鲜事吧！</div></main>');

  const entry = await run({ kind: 'publish_entry_probe', params: {} });
  assert.equal(entry.output.value.ok, false);
  assert.equal(entry.output.value.reason, 'composer_entry_not_found');
});

test('Facebook publish keeps unsupported generic atoms honest and captures one matching post', async () => {
  install('<main><div role="dialog"><div role="textbox" contenteditable="true"></div></div></main>');
  const wrongTarget = await run({
    kind: 'publish_select_mode',
    params: { recordId: 8, seq: 1, optionKind: 'target', optionValue: 'facebook_group' },
  });
  assert.equal(wrongTarget.effectPhase, 'not_started');
  assert.equal(wrongTarget.output.value.reason, 'unsupported_command');

  const unsupported = await run({
    kind: 'publish_set_schedule',
    params: { recordId: 8, seq: 2, publishTime: Date.now() + 60_000 },
  });
  assert.equal(unsupported.effectPhase, 'not_started');
  assert.equal(unsupported.output.value.reason, 'kind_not_implemented');

  install(`
    <main>
      <article role="article">
        <div data-ad-rendering-role="story_message">Unique launch copy</div>
        <a href="/Alice/posts/pfbidNew/">timestamp</a>
      </article>
    </main>
  `);
  const capture = await run({
    kind: 'publish_capture_post_id',
    params: { recordId: 8, seq: 3, scheduledTitle: 'Unique launch copy' },
  });
  assert.equal(capture.output.kind, 'publish_receipt');
  assert.equal(capture.output.value.ok, true);
  assert.equal(capture.output.value.postUrl, 'https://www.facebook.com/Alice/posts/pfbidNew');
});

test('Facebook publish focus probe binds and selects the exact composer editor', async () => {
  const dom = install(`
    <div role="dialog">
      <div aria-label="Create a post"></div>
      <div id="composer" contenteditable="true" role="textbox">stale draft</div>
    </div>
    <input id="decoy" value="wrong target">
  `);
  const result = await run({
    kind: 'publish_editor_probe',
    params: { focus: true, selectContents: true },
  });
  assert.equal(result.output.value.ok, true);
  assert.equal(result.output.value.focused, true);
  assert.equal(result.output.value.selected, true);
  assert.equal(dom.window.document.activeElement?.id, 'composer');
  assert.equal(dom.window.getSelection()?.toString(), 'stale draft');
});

test('Facebook publish rebinds upload and text to the foreground composer generation', async () => {
  const dom = install(`
    <div id="old" role="dialog">
      <img alt="profile" src="https://cdn.example/avatar.jpg">
      <input id="old-file" type="file" accept="image/*">
      <div id="old-editor" contenteditable="true" role="textbox">old draft</div>
    </div>
    <div id="foreground" role="dialog">
      <img alt="01-d67d8818448efe4c.jpg" src="blob:https://www.facebook.com/new-preview">
      <input id="foreground-file" type="file" accept="image/*">
      <div id="foreground-editor" contenteditable="true" role="textbox"></div>
    </div>
  `);

  const editor = await run({
    kind: 'publish_editor_probe',
    params: { focus: true, selectContents: false },
  });
  assert.equal(editor.output.value.ok, true);
  assert.equal(dom.window.document.activeElement?.id, 'foreground-editor');

  const uploadTarget = await run({ kind: 'publish_upload_target_probe', params: {} });
  assert.equal(uploadTarget.output.value.ok, true);
  assert.equal(dom.window.document.querySelector('#old-file')?.hasAttribute('data-aidcp-publish-file-input'), false);
  assert.equal(
    dom.window.document.querySelector('#foreground-file')?.getAttribute('data-aidcp-publish-file-input'),
    'current',
  );

  const preview = await run({
    kind: 'publish_upload_preview_probe',
    params: { fileName: '01-d67d8818448efe4c.jpg' },
  });
  assert.equal(preview.output.value.ok, true);
});

test('Facebook publish never accepts an avatar or another filename as the uploaded preview', async () => {
  install(`
    <div role="dialog">
      <img alt="profile" src="https://cdn.example/avatar.jpg">
      <img alt="another.jpg" src="blob:https://www.facebook.com/another-preview">
      <input type="file" accept="image/*">
      <div contenteditable="true" role="textbox"></div>
    </div>
  `);

  const preview = await run({
    kind: 'publish_upload_preview_probe',
    params: { fileName: '01-d67d8818448efe4c.jpg' },
  });
  assert.equal(preview.output.value.ok, false);
  assert.equal(preview.output.value.reason, 'media_preview_unconfirmed');
});

test('Facebook publish refuses two non-overlapping visible composers as ambiguous', async () => {
  const dom = install(`
    <div id="left" role="dialog"><div contenteditable="true" role="textbox"></div></div>
    <div id="right" role="dialog"><div contenteditable="true" role="textbox"></div></div>
  `);
  setRect(dom.window.document.querySelector('#left')!, { left: 0, top: 0, right: 500, bottom: 500 });
  setRect(dom.window.document.querySelector('#right')!, { left: 700, top: 0, right: 1_200, bottom: 500 });

  const result = await run({ kind: 'publish_editor_probe', params: {} });
  assert.equal(result.output.value.ok, false);
  assert.equal(result.output.value.reason, 'ambiguous_target');
});

test('Facebook comment focus probe reports failure instead of typing through a wrong active element', async () => {
  const dom = install(`
    <article role="article">
      <a href="/groups/42/posts/7">post</a>
      <div id="comment" contenteditable="true" role="textbox" aria-label="Write a comment"></div>
    </article>
    <input id="decoy">
  `, 'https://www.facebook.com/groups/42/posts/7');
  const editor = dom.window.document.querySelector('#comment') as HTMLElement;
  const decoy = dom.window.document.querySelector('#decoy') as HTMLInputElement;
  decoy.focus();
  Object.defineProperty(editor, 'focus', { configurable: true, value: () => undefined });
  Object.defineProperty(editor, 'click', { configurable: true, value: () => undefined });

  const result = await run({
    kind: 'comment_editor_probe',
    params: {
      noteId: 'https://www.facebook.com/groups/42/posts/7',
      focus: true,
      selectContents: true,
    },
  });
  assert.equal(result.output.value.ok, true);
  assert.equal(result.output.value.focused, false);
  assert.equal(result.output.value.selected, false);
  assert.equal(dom.window.document.activeElement?.id, 'decoy');
});

test('Facebook feed probe measures scroll from the element that actually scrolls', async () => {
  // 真机（2026-07-28 越南语群页水合期）：document.documentElement.scrollHeight === innerHeight、
  // window.scrollY 恒 0，真正的滚动条在 feed 的祖先 div 上（scrollHeight 2511 / clientHeight 803）。
  // 照读窗口坐标 ⇒ 位移恒 0、near-bottom 恒真，引擎从第一次探测就以为 feed 已到底。
  install(`
    <main>
      <div id="scroller" style="overflow-y: auto">
        <div role="feed"><div role="article"><a href="/Alice/posts/pfbidABC/">p</a></div></div>
      </div>
    </main>
  `);
  const scroller = document.getElementById('scroller') as HTMLElement;
  Object.defineProperty(scroller, 'scrollHeight', { value: 2511, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 803, configurable: true });
  scroller.scrollTop = 316;
  const probe = await run({ kind: 'feed_probe', params: {} });
  assert.equal(probe.output.value.scrollY, 316, 'scrollY 必须来自真正在滚的容器');
  assert.equal(probe.output.value.scrollHeight, 2511, 'scrollHeight 必须来自真正在滚的容器');
});

test('Facebook first-post probe scrolls and measures the element that actually scrolls', async () => {
  // 与上一条同源（change restore-facebook-post-join-comment-continuity）：位移**测量**已改读真正在滚的
  // 容器，但首帖探测走的滚动分支当时仍在滚窗口 + 读窗口坐标，于是 moved 恒 false、atBottom 恒真，
  // Native 的「没动且到底」判据从第一轮起就成立 —— 四轮下滚预算实际只跑一轮，首帖找不到就放弃。
  const dom = install(`
    <main>
      <div id="scroller" style="overflow-y: auto">
        <div role="feed"><div role="article"><a href="/Alice/posts/pfbidABC/">p</a></div></div>
      </div>
    </main>
  `, 'https://www.facebook.com/groups/945390701793119');
  const scroller = document.getElementById('scroller') as HTMLElement;
  Object.defineProperty(scroller, 'scrollHeight', { value: 2511, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 803, configurable: true });
  let windowScrolls = 0;
  Object.defineProperty(dom.window, 'scrollBy', { value: () => { windowScrolls += 1; } });

  const result = await run({
    kind: 'browse_scroll',
    params: { reason: 'first_commentable_group_post_probe' },
  });

  const movement = result.output.value.movement as {
    before: number; after: number; moved: boolean; atBottom: boolean;
  };
  assert.equal(windowScrolls, 0, '文档不滚时绝不滚窗口');
  assert.equal(movement.before, 0);
  assert.ok(movement.after > 0, '位移必须来自真正在滚的容器');
  assert.equal(movement.moved, true);
  assert.equal(movement.atBottom, false, '容器远未到底时不得判到底');
});

test('Facebook scroll keeps window coordinates when the document itself scrolls', async () => {
  const dom = install(`
    <main><div role="feed"><div role="article"><a href="/Alice/posts/pfbidXYZ/">p</a></div></div></main>
  `, 'https://www.facebook.com/groups/945390701793119');
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: 5_000, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: 800, configurable: true });
  let windowScrolls = 0;
  Object.defineProperty(dom.window, 'scrollBy', { value: () => { windowScrolls += 1; } });

  const result = await run({ kind: 'browse_scroll', params: { reason: 'coverage_scan' } });

  const movement = result.output.value.movement as { before: number; moved: boolean; atBottom: boolean };
  assert.equal(windowScrolls, 1, '文档可滚时仍走窗口分支');
  assert.equal(movement.before, 0);
  assert.equal(movement.moved, false, 'window.scrollY 未变 ⇒ 如实回报没动');
  assert.equal(movement.atBottom, false);
});

test('Facebook feed recovery target is located without DOM actuation', async () => {
  const dom = install(`
    <main>
      <div role="main"><span>Trang chủ</span><button id="go">Đi đến Bảng feed</button></div>
    </main>
  `);
  let domClicks = 0;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'click', {
    configurable: true,
    value: () => { domClicks += 1; },
  });
  setRect(document.getElementById('go')!, { left: 600, top: 400, right: 760, bottom: 440 });

  const result = await run({ kind: 'feed_recovery_target', params: {} });

  assert.equal(result.output.kind, 'point_target');
  assert.equal(result.output.value.ok, true);
  assert.equal(result.output.value.cx, 680);
  assert.equal(result.output.value.cy, 420);
  assert.equal(domClicks, 0, 'JS 只给坐标，真实点击必须由 Native CDP 完成');
});

test('Facebook feed recovery target fails closed on近似文案/多目标/离屏', async () => {
  // 近似但不等值的文案：规范化后必须不匹配，绝不放宽成模糊命中。
  install('<main><div role="main"><button>Đi đến Bảng tin</button></div></main>');
  assert.equal(
    (await run({ kind: 'feed_recovery_target', params: {} })).output.value.reason,
    'no_feed_recovery_target',
  );

  const many = install(`
    <main><div role="main">
      <button id="a">Đi đến Bảng feed</button><button id="b">Đi đến Bảng feed</button>
    </div></main>
  `);
  setRect(many.window.document.getElementById('a')!, { left: 10, top: 10, right: 90, bottom: 40 });
  setRect(many.window.document.getElementById('b')!, { left: 10, top: 60, right: 90, bottom: 90 });
  assert.equal(
    (await run({ kind: 'feed_recovery_target', params: {} })).output.value.reason,
    'ambiguous_feed_recovery_target',
  );

  const off = install('<main><div role="main"><button id="c">Đi đến Bảng feed</button></div></main>');
  setRect(off.window.document.getElementById('c')!, { left: 10, top: 4_000, right: 90, bottom: 4_040 });
  assert.equal(
    (await run({ kind: 'feed_recovery_target', params: {} })).output.value.reason,
    'feed_recovery_target_out_of_view',
  );
});
