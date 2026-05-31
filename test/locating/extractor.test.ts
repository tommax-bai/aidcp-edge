import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom } from '../helpers.js';
import { extractInteractiveElements } from '../../src/locating/index.js';

test('抽取可见可交互元素，排除隐藏元素', () => {
  const { document } = buildDom(`
    <button aria-label="点赞">赞</button>
    <a href="/x">链接</a>
    <input type="text" placeholder="搜索" />
    <button aria-hidden="true" aria-label="隐藏A">x</button>
    <button style="display:none" aria-label="隐藏B">y</button>
    <span>纯文本不可交互</span>
  `);
  const els = extractInteractiveElements(document);
  assert.equal(els.length, 3, '应只抽取 3 个可见可交互元素');

  const roles = els.map((e) => e.role).sort();
  assert.deepEqual(roles, ['button', 'link', 'textbox']);

  const like = els.find((e) => e.role === 'button');
  assert.equal(like?.text, '点赞', 'aria-label 应作为可访问名');

  for (const e of els) {
    assert.match(e.path, /^\/.*\[\d+\]/, 'path 应为 tag[n] 结构路径');
  }
});

test('作用域消歧：信息流中只抽取目标卡片内的元素', () => {
  const { document } = buildDom(`
    <div role="article">
      <h3>笔记A</h3>
      <button data-id="likeA" aria-label="点赞">赞</button>
    </div>
    <div role="article">
      <h3>笔记B</h3>
      <button data-id="likeB" aria-label="点赞">赞</button>
    </div>
  `);

  const inA = extractInteractiveElements(document, { role: 'article', containsText: '笔记A' });
  assert.equal(inA.length, 1, '作用域内应只有一个点赞按钮');
  assert.equal(inA[0].attributes['data-id'], 'likeA', '应锁定到笔记A的按钮');
  assert.ok(inA[0].scopePath, '作用域内元素应带 scopePath');

  const inB = extractInteractiveElements(document, { role: 'article', containsText: '笔记B' });
  assert.equal(inB[0].attributes['data-id'], 'likeB');
});

test('作用域不存在时返回空清单', () => {
  const { document } = buildDom(`<button aria-label="点赞">赞</button>`);
  const els = extractInteractiveElements(document, { role: 'article', containsText: '不存在' });
  assert.equal(els.length, 0);
});
