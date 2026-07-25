import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(resolve(repoRoot, 'native/page-engine/src/facebook-command-router.js'), 'utf8');
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

test('Facebook page probe reports captcha from semantic page evidence', async () => {
  install('<main><div>Security check — please complete captcha</div></main>');
  const result = await run({ kind: 'page_probe', params: {} });
  assert.equal(result.output.kind, 'page_probe');
  assert.equal(result.output.value.pageKind, 'captcha');
});

test('Facebook group join clicks only one in-scope CTA and verifies membership afterwards', async () => {
  const dom = install(`
    <nav><button aria-label="Join">navigation decoy</button></nav>
    <main><h1>Agent Builders</h1><button id="join" aria-label="Join">Join</button></main>
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
