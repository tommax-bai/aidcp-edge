import assert from 'node:assert/strict';
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
    assert.deepEqual(result.output.value.cards, []);
    assert.equal(Number.isSafeInteger(result.output.value.documentAgeMs), true);
    assert.ok(Number(result.output.value.documentAgeMs) >= 10_000);
  } finally {
    assert.ok(originalPerformance);
    Object.defineProperty(globalThis, 'performance', originalPerformance);
  }
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

test('Facebook Reels hashtag navigation is not a post identity', async () => {
  const dom = install(`
    <main>
      <div>
        <video src="https://cdn.example/unknown-reel.mp4"></video>
        <a href="/reel/hashtag/?q=%23agents">#agents</a>
        <a href="/reel/hashtag/?q=%23automation">#automation</a>
      </div>
    </main>
  `, 'https://www.facebook.com/reels/');
  setRect(dom.window.document.querySelector('video')!, { left: 557, top: 72, right: 959, bottom: 786 });

  const probe = await run({ kind: 'reel_probe', params: {} });
  assert.deepEqual(probe.output.value, { ok: false, reason: 'no_active_identity' });

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
      <button id="previous" aria-label="Previous"></button>
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
  assert.equal(target.output.value.label, 'Next');
  assert.equal(target.output.value.noteId, 'https://www.facebook.com/reel/777');
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

test('Facebook publish submit is confirmed only after the composer closes', async () => {
  const dom = install(`
    <main>
      <div role="dialog" id="composer">
        <div role="textbox" contenteditable="true">Ready</div>
        <button id="submit" aria-label="Post">Post</button>
      </div>
    </main>
  `);
  dom.window.document.querySelector('#submit')?.addEventListener('click', () => {
    dom.window.document.querySelector('#composer')?.remove();
  });
  const result = await run({
    kind: 'publish_submit',
    params: { recordId: 7, seq: 9 },
  });
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'publish_receipt');
  assert.deepEqual(result.output.value, {
    recordId: 7,
    seq: 9,
    kind: 'submit',
    ok: true,
    submitDispatched: true,
    error: undefined,
  });
});

test('Facebook publish keeps unsupported generic atoms honest and captures one matching post', async () => {
  install('<main><div role="dialog"><div role="textbox" contenteditable="true"></div></div></main>');
  const wrongTarget = await run({
    kind: 'publish_select_mode',
    params: { recordId: 8, seq: 1, optionKind: 'target', optionValue: 'facebook_group' },
  });
  assert.equal(wrongTarget.effectPhase, 'not_started');
  assert.equal(wrongTarget.output.value.reason, 'unsupported_target');

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
