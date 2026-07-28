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

/**
 * 真机形态：帖级动作栏里先出现一个**无文案的中性点赞控件**（aria-label 就是「赞」），
 * 数字只挂在同帖的反应汇总控件上。两者不是一类东西：前者是可切换的 toggle，后者不是。
 */
function card(actionBar: string, permalink = '/groups/1/posts/2'): string {
  return `
    <main>
      <div role="article">
        <h2><a href="${permalink}">Author</a></h2>
        <div data-ad-rendering-role="story_message">post body</div>
        <div role="toolbar">${actionBar}</div>
      </div>
    </main>
  `;
}

async function firstCardLikeCount(): Promise<unknown> {
  const result = await run({ kind: 'browse_scroll', params: { reason: 'initial_scan' } });
  const cards = result.output.value.cards as { likeCount: number }[];
  assert.equal(cards.length, 1, 'fixture must project exactly one card');
  return cards[0]!.likeCount;
}

test('a numberless neutral toggle never hides the reaction summary count', async () => {
  install(card(`
    <div role="button" aria-label="赞"></div>
    <div role="button" aria-label="赞：1.2万">1.2万</div>
    <div role="button" aria-label="评论">评论</div>
  `));

  assert.equal(await firstCardLikeCount(), 12_000);
});

test('an action button that carries the number in the same control is still the witness', async () => {
  install(card(`
    <div role="button" aria-label="Thích">866</div>
    <div role="button" aria-label="Thích: 825 người">825</div>
  `));

  assert.equal(await firstCardLikeCount(), 866, 'DOM 序第一个满足两条合取的控件即见证');
});

test('K scale summaries parse exactly like the retired count parser', async () => {
  install(card(`
    <div role="button" aria-label="赞"></div>
    <div role="button" aria-label="Like: 1.2K">1.2K</div>
  `));

  assert.equal(await firstCardLikeCount(), 1_200);
});

test('a measured zero stays zero rather than being dropped', async () => {
  install(card(`
    <div role="button" aria-label="赞"></div>
    <div role="button" aria-label="赞：0">0</div>
  `));

  assert.equal(await firstCardLikeCount(), 0);
});

test('a neutral control with no digits anywhere yields no count witness', async () => {
  install(card(`
    <div role="button" aria-label="赞"></div>
    <div role="button" aria-label="评论">评论</div>
  `));

  assert.equal(await firstCardLikeCount(), 0, '未观测目前仍塌成 0（协议标记见 tasks 1.3/1.4）');
});

test('a digit-bearing control without reaction semantics is never mistaken for the count', async () => {
  install(card(`
    <div role="button" aria-label="赞"></div>
    <div role="button" aria-label="3 条评论">3 条评论</div>
    <div role="button" aria-label="分享 12 次">分享 12 次</div>
  `));

  assert.equal(await firstCardLikeCount(), 0, '含数字但非反应语义的控件绝不采信');
});

test('decomposed Vietnamese labels resolve to the same count as the precomposed form', async () => {
  const precomposed = 'Thích';
  const decomposed = 'Thích';
  assert.notEqual(precomposed, decomposed, 'fixture must really use the NFD form');

  install(card(`
    <div role="button" aria-label="${decomposed}"></div>
    <div role="button" aria-label="${decomposed}: 825 người">825</div>
  `));
  assert.equal(await firstCardLikeCount(), 825);

  install(card(`
    <div role="button" aria-label="${precomposed}"></div>
    <div role="button" aria-label="${precomposed}: 825 người">825</div>
  `));
  assert.equal(await firstCardLikeCount(), 825);
});

test('a decomposed Vietnamese neutral control with no digits still yields nothing', async () => {
  install(card(`
    <div role="button" aria-label="Thích"></div>
    <div role="button" aria-label="Bình luận">Bình luận</div>
  `));

  assert.equal(await firstCardLikeCount(), 0);
});

test('the note detail payload reads the count through the same witness', async () => {
  install(`
    <main>
      <div role="article">
        <h2><a href="/groups/1/posts/2">Author</a></h2>
        <div data-ad-rendering-role="story_message">post body</div>
        <div role="toolbar">
          <div role="button" aria-label="赞"></div>
          <div role="button" aria-label="赞：3,829">3,829</div>
        </div>
      </div>
    </main>
  `, 'https://www.facebook.com/groups/1/posts/2');

  const detail = (await run({ kind: 'note_open', params: {} })).output.value;
  assert.equal(detail.likeCount, 3_829);
});

test('the like actuator locator is left byte-for-byte alone', async () => {
  const fragment = await readFile(
    resolve(repoRoot, 'native/page-engine/src/facebook-router/08-reaction-semantics.js'),
    'utf8',
  );
  assert.ok(
    fragment.includes(
      `  const reactionButton=(root)=>{\n`
      + `    const buttons=all('button,[role="button"]',root).filter(visible);\n`
      + `    return buttons.find((button)=>/^(赞|讚|like|me gusta|thích)(\\b|\\s|$)/i.test(label(button)))||null;\n`
      + `  };\n`,
    ),
    '读数改造 MUST NOT 动点赞执行器的定位器',
  );
  assert.ok(
    !/likeCount:count\(text\(reaction/.test(
      await readFile(resolve(repoRoot, 'native/page-engine/src/facebook-router/20-feed.js'), 'utf8'),
    ),
    '读数路径不得再复用点赞 toggle 定位器',
  );
});
