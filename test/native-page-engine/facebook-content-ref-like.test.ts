/**
 * change generalize-facebook-content-derived-post-identity — 按内容派生引用重定位（点赞路径）。
 *
 * 群组帖在零交互下拿不到任何平台地址（2026-07-29 真机：6/6 卡为 0）。这类卡改由内容派生的
 * 会话内引用成卡后，点赞是它唯一能做的动作——按钮就在卡里，不需要地址。
 * 这里守的是重定位的三种结局必须各自诚实：命中唯一且证据复校通过才动手；页面上不止一个挂着
 * 同一引用 ⇒ 不知道是哪张，不动手；元素还在但证据变了（虚拟化把节点复用给了别的帖子）⇒
 * 快照过期，绝不解析到「现在占着这个位置」的那条上。
 */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import { readFacebookRouterSource } from './facebook-router-source.js';

type RouterResult = {
  effectPhase: string;
  output: { kind: string; value: Record<string, unknown> };
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

/** 越南语群组帖的形态：有作者、有正文、有互动栏，**没有任何可接受的平台地址**。 */
function permalinklessCard(body: string): string {
  return `
    <article role="article" id="card">
      <h2><a href="/people/VietNhat/100014995179767/">Việt Nhật Hà Nam</a></h2>
      <div data-ad-rendering-role="story_message">${body}</div>
      <div role="toolbar"><button id="summary" aria-label="Like">42</button></div>
      <div id="post-actions">
        <button id="primary" aria-label="React"></button>
        <button aria-label="Comment">Comment</button>
      </div>
    </article>
  `;
}

async function issuedRef(): Promise<string> {
  const probe = await run({ kind: 'feed_probe', params: {} });
  const cards = probe.output.value.cards as Array<Record<string, unknown>>;
  assert.equal(cards.length, 1, '取不到平台地址的卡必须成卡，而不是被整张丢掉');
  assert.equal(cards[0]?.noteIdKind, 'content_ref', '身份分档必须显式回传');
  const ref = String(cards[0]?.noteId);
  assert.match(ref, /^aidcp:facebook-group-feed-post:v1:[0-9a-f]{64}$/);
  return ref;
}

test('会话内引用能重定位到那张卡，并按按钮状态确认点赞', async () => {
  const dom = install(`<main><div role="feed">${permalinklessCard('HONDA VIỆT NAM TUYỂN DỤNG')}</div></main>`);
  const ref = await issuedRef();

  const target = await run({ kind: 'feed_like_target_probe', params: { noteId: ref } });
  assert.equal(target.output.value.ok, true, '引用应重定位到唯一那张卡');
  assert.equal(target.output.value.noteId, ref, '问的是哪条就答哪条：不得中途换身份');

  let primaryClicks = 0;
  dom.window.document.querySelector('#primary')?.addEventListener('click', (event) => {
    primaryClicks += 1;
    (event.currentTarget as Element).setAttribute('aria-label', 'Remove Like');
  });
  const commit = await run({ kind: 'feed_like_commit', params: { noteId: ref, operationId: 'op-1' } });
  assert.equal(commit.output.value.started, true);
  assert.equal(primaryClicks, 1);

  const verify = await run({ kind: 'feed_like_verify', params: { noteId: ref, operationId: 'op-1' } });
  assert.equal(verify.output.value.state, 'confirmed', '成败以按钮状态变化为准，不做 id 比对');
});

test('证据变了（节点被复用给别的帖子）⇒ 快照过期，绝不解析到别的卡', async () => {
  const dom = install(`<main><div role="feed">${permalinklessCard('HONDA VIỆT NAM TUYỂN DỤNG')}</div></main>`);
  const ref = await issuedRef();

  dom.window.document.querySelector('[data-ad-rendering-role="story_message"]')!.textContent =
    'Facebook 把这个容器复用给了另一条帖子';

  const target = await run({ kind: 'feed_like_target_probe', params: { noteId: ref } });
  assert.equal(target.output.value.ok, false);
  assert.equal(target.output.value.reason, 'stale_target');

  let primaryClicks = 0;
  dom.window.document.querySelector('#primary')?.addEventListener('click', () => { primaryClicks += 1; });
  const commit = await run({ kind: 'feed_like_commit', params: { noteId: ref, operationId: 'op-2' } });
  assert.equal(commit.output.value.started, false);
  assert.equal(commit.output.value.reason, 'stale_target');
  assert.equal(primaryClicks, 0, '证据不符时绝不动手');
});

test('同一引用命中多个元素 ⇒ ambiguous，不动手', async () => {
  const dom = install(`<main><div role="feed">${permalinklessCard('HONDA VIỆT NAM TUYỂN DỤNG')}</div></main>`);
  const ref = await issuedRef();

  // 虚拟化把带标记的容器复制了一份：此刻「引用指哪张」已不可判定。
  const original = dom.window.document.querySelector('#card')!;
  const clone = original.cloneNode(true) as Element;
  clone.id = 'card-clone';
  original.parentElement!.appendChild(clone);

  const target = await run({ kind: 'feed_like_target_probe', params: { noteId: ref } });
  assert.equal(target.output.value.ok, false);
  assert.equal(target.output.value.reason, 'ambiguous_target');
});
