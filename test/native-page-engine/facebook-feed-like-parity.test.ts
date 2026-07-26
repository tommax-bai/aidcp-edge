import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import { readFacebookRouterSource } from './facebook-router-source.js';

type RouterResult = {
  effectPhase: string;
  output: {
    kind: string;
    value: Record<string, unknown>;
  };
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFacebookRouterSource(repoRoot);
const run = Function(`return (${source})`)() as (
  input: { kind: string; params: Record<string, unknown> },
) => Promise<RouterResult>;

function install(html: string): JSDOM {
  const dom = new JSDOM(html, { url: 'https://www.facebook.com/' });
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
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }),
  });
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

function feedCard(postId = 'pfbidTARGET', prefix = 'target'): string {
  return `
    <article role="article" id="${prefix}-card">
      <a href="/Alice/posts/${postId}/">timestamp</a>
      <div role="toolbar"><button id="${prefix}-summary" aria-label="Like">42</button></div>
      <button id="${prefix}-loose-decoy" aria-label="Like">Like</button>
      <div id="${prefix}-post-actions">
        <button id="${prefix}-primary" aria-label="React"></button>
        <button aria-label="Comment">Comment</button>
      </div>
    </article>
  `;
}

test('Feed like fresh commit invokes the exact post React control, not the reaction-count decoy', async () => {
  const dom = install(`
    <main><div role="feed">
      ${feedCard('pfbidFIRST', 'first')}
      ${feedCard()}
    </div></main>
  `);
  let firstClicks = 0;
  let targetSummaryClicks = 0;
  let targetLooseClicks = 0;
  let targetPrimaryClicks = 0;
  dom.window.document.querySelector('#first-primary')?.addEventListener('click', () => { firstClicks += 1; });
  dom.window.document.querySelector('#target-summary')?.addEventListener('click', () => { targetSummaryClicks += 1; });
  dom.window.document.querySelector('#target-loose-decoy')?.addEventListener('click', () => { targetLooseClicks += 1; });
  dom.window.document.querySelector('#target-primary')?.addEventListener('click', (event) => {
    targetPrimaryClicks += 1;
    (event.currentTarget as Element).setAttribute('aria-label', 'Remove Like');
  });

  const commit = await run({
    kind: 'feed_like_commit',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-1',
    },
  });

  assert.equal(commit.output.kind, 'feed_like_commit');
  assert.equal(commit.output.value.started, true);
  assert.equal(commit.output.value.already, false);
  assert.equal(firstClicks, 0);
  assert.equal(targetSummaryClicks, 0);
  assert.equal(targetLooseClicks, 0);
  assert.equal(targetPrimaryClicks, 1);

  const verify = await run({
    kind: 'feed_like_verify',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-1',
    },
  });
  assert.equal(verify.output.kind, 'feed_like_verify');
  assert.equal(verify.output.value.state, 'confirmed');

  const picker = await run({
    kind: 'feed_like_picker_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-1',
    },
  });
  assert.equal(picker.output.value.ok, false);
  assert.equal(picker.output.value.reason, 'already_reacted');
});

test('Feed like verification never rebinds to a replacement card with the same identity', async () => {
  const dom = install(`<main><div role="feed">${feedCard()}</div></main>`);
  const primary = dom.window.document.querySelector('#target-primary')!;
  primary.addEventListener('click', () => undefined);

  const commit = await run({
    kind: 'feed_like_commit',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-virtualized',
    },
  });
  assert.equal(commit.output.value.started, true);

  const oldCard = dom.window.document.querySelector('#target-card')!;
  oldCard.insertAdjacentHTML('afterend', feedCard().replace('id="target-card"', 'id="replacement-card"')
    .replace('id="target-primary"', 'id="replacement-primary"')
    .replace('aria-label="React"', 'aria-label="Remove Like"'));
  oldCard.remove();

  const verify = await run({
    kind: 'feed_like_verify',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-virtualized',
    },
  });
  assert.equal(verify.output.value.state, 'target_lost');
});

test('Feed like verification reports identity change on the tagged card', async () => {
  const dom = install(`<main><div role="feed">${feedCard()}</div></main>`);
  dom.window.document.querySelector('#target-primary')?.addEventListener('click', () => undefined);

  const commit = await run({
    kind: 'feed_like_commit',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-recycled',
    },
  });
  assert.equal(commit.output.value.started, true);
  dom.window.document.querySelector('#target-card a')?.setAttribute('href', '/Alice/posts/pfbidOTHER/');
  dom.window.document.querySelector('#target-primary')?.setAttribute('aria-label', 'Remove Like');

  const verify = await run({
    kind: 'feed_like_verify',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-recycled',
    },
  });
  assert.equal(verify.output.value.state, 'identity_mismatch');
});

test('Feed like fresh commit rejects duplicate exact identities without clicking either card', async () => {
  const dom = install(`
    <main><div role="feed">
      ${feedCard('pfbidTARGET', 'duplicate-one')}
      ${feedCard('pfbidTARGET', 'duplicate-two')}
    </div></main>
  `);
  let clicks = 0;
  for (const primary of dom.window.document.querySelectorAll('[id$="-primary"]')) {
    primary.addEventListener('click', () => { clicks += 1; });
  }

  const commit = await run({
    kind: 'feed_like_commit',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-duplicate',
    },
  });
  assert.equal(commit.output.value.started, false);
  assert.equal(commit.output.value.reason, 'ambiguous_target');
  assert.equal(clicks, 0);
});

test('Feed like commit refuses an offscreen primary control before the engine scrolls it', async () => {
  const dom = install(`<main><div role="feed">${feedCard()}</div></main>`);
  const primary = dom.window.document.querySelector('#target-primary')!;
  setRect(primary, { left: 200, top: 900, right: 320, bottom: 940 });
  let clicks = 0;
  primary.addEventListener('click', () => { clicks += 1; });

  const target = await run({
    kind: 'feed_like_target_probe',
    params: { noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET' },
  });
  assert.equal(target.output.value.ok, true);
  assert.equal(target.output.value.inViewport, false);

  const commit = await run({
    kind: 'feed_like_commit',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-offscreen',
    },
  });
  assert.equal(commit.output.value.started, false);
  assert.equal(commit.output.value.reason, 'target_not_visible');
  assert.equal(clicks, 0);
});

test('Feed like fresh commit rechecks blockers before invoking the DOM control', async () => {
  const dom = install(`
    <main>
      <div>Security check — please complete captcha</div>
      <div role="feed">${feedCard()}</div>
    </main>
  `);
  let clicks = 0;
  dom.window.document.querySelector('#target-primary')?.addEventListener('click', () => { clicks += 1; });

  const commit = await run({
    kind: 'feed_like_commit',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-blocked',
    },
  });
  assert.equal(commit.output.value.started, false);
  assert.equal(commit.output.value.reason, 'blocked_by_captcha');
  assert.equal(clicks, 0);
});

test('Feed picker probe rejects a reaction dialog that predates the target commit', async () => {
  const dom = install(`
    <main><div role="feed">${feedCard()}</div></main>
    <div role="dialog" aria-label="Reactions">
      <button role="menuitemradio" aria-label="Like">Like</button>
      <button role="menuitemradio" aria-label="Love">Love</button>
    </div>
  `);
  dom.window.document.querySelector('#target-primary')?.addEventListener('click', () => undefined);
  const commit = await run({
    kind: 'feed_like_commit',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-stale-picker',
    },
  });
  assert.equal(commit.output.value.started, true);

  const picker = await run({
    kind: 'feed_like_picker_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-stale-picker',
    },
  });
  assert.equal(picker.output.value.ok, false);
  assert.equal(picker.output.value.reason, 'like_picker_not_found');
});

test('Feed picker probe ignores Feed decoys and rejects offscreen or ambiguous picker targets', async () => {
  const dom = install(`
    <main><div role="feed">${feedCard()}</div></main>
  `);
  dom.window.document.querySelector('#target-primary')?.addEventListener('click', () => {
    dom.window.document.body.insertAdjacentHTML('beforeend', `
      <div role="dialog" aria-label="Reactions" id="picker-one">
        <button role="menuitemradio" aria-label="Like" id="picker-like">Like</button>
        <button role="menuitemradio" aria-label="Love">Love</button>
      </div>
    `);
  });
  const commit = await run({
    kind: 'feed_like_commit',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-picker',
    },
  });
  assert.equal(commit.output.value.started, true);

  const opened = await run({
    kind: 'feed_like_verify',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-picker',
    },
  });
  assert.equal(opened.output.value.state, 'picker_open');

  const wrongOperation = await run({
    kind: 'feed_like_picker_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'another-operation',
    },
  });
  assert.equal(wrongOperation.output.value.ok, false);
  assert.equal(wrongOperation.output.value.reason, 'operation_not_found');

  dom.window.document.body.insertAdjacentHTML('beforeend', '<aside id="fresh-blocker">Please complete captcha</aside>');
  const blocked = await run({
    kind: 'feed_like_picker_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-picker',
    },
  });
  assert.equal(blocked.output.value.ok, false);
  assert.equal(blocked.output.value.reason, 'blocked_by_captcha');
  dom.window.document.querySelector('#fresh-blocker')?.remove();

  setRect(dom.window.document.querySelector('#picker-like')!, {
    left: 1_500,
    top: 20,
    right: 1_560,
    bottom: 80,
  });

  const offscreen = await run({
    kind: 'feed_like_picker_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-picker',
    },
  });
  assert.equal(offscreen.output.kind, 'feed_like_picker_probe');
  assert.equal(offscreen.output.value.ok, false);
  assert.equal(offscreen.output.value.reason, 'like_picker_offscreen');

  setRect(dom.window.document.querySelector('#picker-like')!, {
    left: 300,
    top: 20,
    right: 360,
    bottom: 80,
  });
  dom.window.document.body.insertAdjacentHTML('beforeend', `
    <div role="dialog" aria-label="Reactions">
      <button role="menuitemradio" aria-label="Like">Like</button>
      <button role="menuitemradio" aria-label="Love">Love</button>
    </div>
  `);

  const ambiguous = await run({
    kind: 'feed_like_picker_probe',
    params: {
      noteId: 'https://www.facebook.com/Alice/posts/pfbidTARGET',
      operationId: 'feed-like-picker',
    },
  });
  assert.equal(ambiguous.output.value.ok, false);
  assert.equal(ambiguous.output.value.reason, 'ambiguous_target');
});
