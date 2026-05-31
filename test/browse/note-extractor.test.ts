import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom } from '../helpers.js';
import {
  extractNoteContent,
  parseCount,
  extractTags,
} from '../../src/browse/note-extractor.js';
import type { DomProvider } from '../../src/locating/engine.js';

test('parseCount: 解析中文计数惯例', () => {
  assert.equal(parseCount('1.2w'), 12000);
  assert.equal(parseCount('1.2万'), 12000);
  assert.equal(parseCount('1万'), 10000);
  assert.equal(parseCount('999'), 999);
  assert.equal(parseCount('3.5k'), 3500);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('10万+'), 100000);
  assert.equal(parseCount(''), 0);
  assert.equal(parseCount(null), 0);
  assert.equal(parseCount('赞'), 0);
});

test('extractTags: 抽取 #标签# 并去重', () => {
  assert.deepEqual(extractTags('好物分享 #美食# #旅行# 正文 #美食#'), ['美食', '旅行']);
  assert.deepEqual(extractTags('无标签文本'), []);
});

function domProviderFrom(html: string): DomProvider {
  const { document } = buildDom(html);
  return { getRoot: () => document };
}

const MODAL_HTML = `
  <div class="note-detail-mask">
    <div id="noteContainer">
      <div id="detail-title">超好喝的奶茶推荐 #奶茶# #探店#</div>
      <div id="detail-desc">这家店真的绝了，强烈安利大家去试试 #种草#</div>
      <div class="author-wrapper"><span class="name">小红薯达人</span></div>
      <div class="footer">
        <span class="like-wrapper">1.2w</span>
        <span class="collect-wrapper">3456</span>
        <span class="comment-wrapper">789</span>
      </div>
    </div>
  </div>`;

test('extractNoteContent: 从 modal 提取结构化内容', async () => {
  const dom = domProviderFrom(MODAL_HTML);
  const c = await extractNoteContent(dom);
  assert.equal(c.title, '超好喝的奶茶推荐 #奶茶# #探店#');
  assert.match(c.body, /强烈安利/);
  assert.equal(c.author, '小红薯达人');
  assert.equal(c.likes, 12000);
  assert.equal(c.collects, 3456);
  assert.equal(c.comments, 789);
  assert.ok(c.tags.includes('奶茶'));
  assert.ok(c.tags.includes('探店'));
  assert.equal(c.isLiked, false);
});

test('extractNoteContent: 检测已点赞态', async () => {
  const liked = MODAL_HTML.replace(
    '<span class="like-wrapper">1.2w</span>',
    '<span class="like-wrapper liked">1.2w</span>',
  );
  const c = await extractNoteContent(domProviderFrom(liked));
  assert.equal(c.isLiked, true);
});

test('extractNoteContent: 无 modal 时降级整页抽取', async () => {
  const html = `<div id="detail-title">单页笔记</div><div class="desc">正文</div>`;
  const c = await extractNoteContent(domProviderFrom(html));
  assert.equal(c.title, '单页笔记');
  assert.equal(c.body, '正文');
});
