import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import { readFacebookRouterSource } from './facebook-router-source.js';

/**
 * 取根与取用层的诚实归因（`harden-native-engine-runtime-contracts` 7.1 / 7.2 / 7.5①②）。
 *
 * 导航瞬间 `document.body` 可能还没挂上，而页面规则里有多处 `... || document.body` 兜底。
 * 取用函数过去对空 root 零防护：直接对 `null` 调 `querySelectorAll` 当场抛 TypeError，
 * 而**写命令遇到任何规则错误都会被判「可能已做」**——一次没有有效根的遍历，
 * 绝不能变成一次「说不定点过了」。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const routerSource = await readFacebookRouterSource(repoRoot);
const sharedSource = await readFile(
  resolve(repoRoot, 'native/page-engine/src/facebook-router/00-shared.js'),
  'utf8',
);

const run = Function(`return (${routerSource})`)() as (
  input: { kind: string; params: Record<string, unknown> },
) => Promise<{ effectPhase: string; output: { kind: string; value: Record<string, unknown> } }>;

/**
 * 只取共享片段并让它把取用函数交出来。片段本身不闭合外层函数（由分派片段收尾），
 * 所以这里补一个 `return` 与右括号即可拿到真实源码里的 `all` / `first`，
 * 而不是在测试里重抄一份实现。
 */
const takeShared = Function(`return (${sharedSource}\n  return { all, first };\n})`)() as (
  input: { kind: string; params: Record<string, unknown> },
) => Promise<{
  all: (selector: string, root?: unknown) => unknown[];
  first: (selectors: string[], root?: unknown) => unknown;
}>;

function install(html: string, url = 'https://www.facebook.com/'): JSDOM {
  const dom = new JSDOM(html, { url });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    innerHeight: 800,
    innerWidth: 1_440,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(dom.window, 'scrollBy', { configurable: true, value: () => undefined });
  return dom;
}

test('取用函数收到空 root 时回可归因的空结果，不抛异常', async () => {
  const dom = install('<main><div role="article"><div dir="auto">post</div></div></main>');
  const { all, first } = await takeShared({ kind: 'noop', params: {} });

  // `null` 是真正的空根（`... || document.body` 在导航瞬间就会给出它）：
  // 缺省参数只对 undefined 生效，兜不住它，所以防护必须落在取用层。
  for (const emptyRoot of [null, {}, 'not-a-node', 0]) {
    assert.deepEqual(all('div', emptyRoot), [], `all() with ${String(emptyRoot)}`);
    assert.equal(first(['div'], emptyRoot), null, `first() with ${String(emptyRoot)}`);
  }
  // 有效根照旧工作：防护不许把正常取用也一并掐掉。
  assert.equal(all('div', dom.window.document).length > 0, true);
  assert.notEqual(first(['div[dir="auto"]'], dom.window.document), null);
  // 省略 root 仍回落到 document（缺省参数语义没被防护改掉）。
  assert.equal(all('div').length > 0, true);
  assert.equal(all('div', undefined).length > 0, true);
});

test('导航瞬间没有有效根时，开帖回诚实的找不到目标而不是抛异常', async () => {
  const dom = install('<main><div role="article"><div dir="auto">post</div></div></main>');
  // 模拟导航瞬间：文档还在，但 body 已经被换掉、主容器尚未挂上。
  dom.window.document.documentElement.removeChild(dom.window.document.body);
  assert.equal(dom.window.document.body, null, 'jsdom 必须真的把 body 摘掉，否则这条用例是空转');

  const result = await run({ kind: 'note_open', params: { noteId: 'https://www.facebook.com/posts/1' } });
  assert.equal(result.output.kind, 'action_receipt');
  assert.equal(result.output.value.action, 'open');
  assert.equal(result.output.value.ok, false);
  assert.equal(result.output.value.reason, 'target_not_found');
});

test('有有效根时开帖仍然回详情（防护不许改变正常路径）', async () => {
  install(
    '<main><div role="article"><div dir="auto">hello world</div>'
    + '<a href="https://www.facebook.com/posts/1">link</a></div></main>',
    'https://www.facebook.com/posts/1',
  );
  const result = await run({ kind: 'note_open', params: { noteId: 'https://www.facebook.com/posts/1' } });
  assert.equal(result.output.kind, 'note_detail');
});
