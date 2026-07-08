import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom } from '../helpers.js';
import {
  extractNoteContent,
  extractNoteImages,
  extractPublishedAtText,
  parseCount,
  extractTags,
  textWithNewlines,
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

// 回归 4.2 + 4.3：正文位于布局变体（note-scroller/note-content，无字面 #detail-desc）——
// f8712f5 收紧后这类真长文会被抽空（假阴性）；拓宽 NOTE_BODY_SELECTORS 后应抽到非空且不泄漏标题。
// 同一 fixture 验证点赞数两遍扫描：不被靠前的含 'like' 子串无关元素(entry-like-tip)抢占。
const VARIANT_LAYOUT_HTML = `
  <div class="note-detail-mask">
    <div class="note-container">
      <div class="title">长文测评：这款相机到底值不值</div>
      <div class="note-scroller">
        <div class="note-content">
          <span class="note-text">说实话用了三个月，成像非常惊艳，续航也够用，强烈推荐给入门玩家。</span>
        </div>
      </div>
      <div class="author-wrapper"><span class="name">器材老饕</span></div>
      <div class="footer">
        <span class="entry-like-tip">999</span>
        <span class="comment-wrapper">88</span>
        <span class="collect-wrapper">66</span>
        <span class="like-wrapper">123</span>
      </div>
    </div>
  </div>`;

test('extractNoteContent: 布局变体(note-scroller/note-content，无 #detail-desc) 正文仍抽到非空且不泄漏标题', async () => {
  const c = await extractNoteContent(domProviderFrom(VARIANT_LAYOUT_HTML));
  assert.match(c.body, /成像非常惊艳/, '布局变体下正文应抽到非空');
  assert.ok(!c.body.includes('刚刚'), '正文不应混入发布时间"刚刚"');
  assert.ok(!c.body.startsWith('长文测评'), '正文不应以标题开头（无标题泄漏）');
});

// 换行保真回归（curated_content.body 生产实测 0/64 含换行的根因）：正文不得走 \s+ 单行压缩。
// XHS 正文两种形态都要活到 body：字面 \n（pre-wrap 渲染常态）与 <br> 标签（textContent 下连空格都不留）。
test('extractNoteContent: 正文保留字面换行（pre-wrap 形态）', async () => {
  const html = `
    <div class="note-detail-mask">
      <div id="detail-title">分段笔记</div>
      <div id="detail-desc">第一段开头
第二段继续

第四行（隔一个空行）</div>
    </div>`;
  const c = await extractNoteContent(domProviderFrom(html));
  assert.equal(c.body, '第一段开头\n第二段继续\n\n第四行（隔一个空行）');
});

test('extractNoteContent: 正文 <br> 映射为换行', async () => {
  const html = `
    <div class="note-detail-mask">
      <div id="detail-desc">第一行<br>第二行<br><br>第三段</div>
    </div>`;
  const c = await extractNoteContent(domProviderFrom(html));
  assert.equal(c.body, '第一行\n第二行\n\n第三段');
});

test('textWithNewlines: 块级边界成换行、行内空白压缩、空行至多留一个', () => {
  const { document } = buildDom(
    `<div id="x"><p>甲  乙</p><p>丙</p><span>丁</span><br><br><br><span>戊</span></div>`,
  );
  const el = document.getElementById('x') as Element;
  assert.equal(textWithNewlines(el), '甲 乙\n\n丙\n丁\n\n戊');
});

test('countNear(点赞数): 两遍扫描优先 like-wrapper 精确容器，不被含 like 子串的无关元素抢占', async () => {
  const c = await extractNoteContent(domProviderFrom(VARIANT_LAYOUT_HTML));
  assert.equal(c.likes, 123, 'likes 应取 like-wrapper(123)，而非靠前的 entry-like-tip(999)');
  assert.equal(c.collects, 66);
  assert.equal(c.comments, 88);
});
// change feed-hot-lead-group-comment：发布时刻抽取双向断言。发布时刻位于正文列底部日期容器
// （.bottom-container > .date），与标题/正文同处一片区——必须抽到原始串，且正文【不含】该日期串
// （隔离于 NOTE_BODY_SELECTORS，守 f8712f5 红线）。
const DATED_MODAL_HTML = `
  <div class="note-detail-mask">
    <div id="noteContainer">
      <div id="detail-title">超好喝的奶茶推荐</div>
      <div class="note-content">
        <div class="note-scroller">
          <div id="detail-desc">这家店真的绝了，强烈安利大家去试试</div>
          <div class="bottom-container">
            <span class="date">编辑于 3小时前 广东</span>
          </div>
        </div>
      </div>
      <div class="author-wrapper"><span class="name">小红薯达人</span></div>
      <div class="footer">
        <span class="like-wrapper">1.2w</span>
        <span class="collect-wrapper">3456</span>
        <span class="comment-wrapper">789</span>
      </div>
    </div>
  </div>`;

test('extractNoteContent: 详情含日期节点时抽到 publishedAtText，且正文不含该日期串', async () => {
  const c = await extractNoteContent(domProviderFrom(DATED_MODAL_HTML));
  assert.equal(c.publishedAtText, '编辑于 3小时前 广东', '应抽到正文列底部日期原始串');
  assert.match(c.body, /强烈安利/, '正文应抽到非空');
  assert.ok(!c.body.includes('3小时前'), '正文不应混入发布时刻（隔离于日期容器）');
  assert.ok(!c.body.includes('编辑于'), '正文不应混入日期前缀');
});

test('extractNoteContent: 无日期节点时 publishedAtText 为 undefined、正文不受影响', async () => {
  const noDate = DATED_MODAL_HTML.replace(
    /<div class="bottom-container">[\s\S]*?<\/div>/,
    '',
  );
  const c = await extractNoteContent(domProviderFrom(noDate));
  assert.equal(c.publishedAtText, undefined, '无日期节点应诚实置空、绝不臆造');
  assert.match(c.body, /强烈安利/, '正文仍正常抽取');
});

test('extractPublishedAtText: 跳过落在正文文本容器内的候选（隔离 denylist）', () => {
  // 若日期串误落在正文文本容器 #detail-desc 内，抽取器应跳过、不把正文首段当发布时刻。
  const { document } = buildDom(`
    <div class="note-detail-mask">
      <div id="noteContainer">
        <div id="detail-desc"><span class="date">正文里恰好有个 .date 节点</span></div>
      </div>
    </div>`);
  const container = document.querySelector('.note-detail-mask') as Element;
  assert.equal(extractPublishedAtText(container), undefined);
});

test('extractNoteImages: keeps note carousel images ordered, deduped, and filtered', () => {
  const { document } = buildDom(`
    <div class="note-detail-mask">
      <div class="swiper-slide"><img class="note-slider-img" src="//img.xhs/a.jpg" width="1080" height="1440" alt="first image"></div>
      <div class="swiper-slide"><img class="note-slider-img" src="https://img.xhs/b.jpg"></div>
      <div class="swiper-slide"><img class="note-slider-img" src="https://img.xhs/a.jpg"></div>
      <div class="swiper-slide swiper-slide-duplicate"><img class="note-slider-img" src="https://img.xhs/clone.jpg"></div>
      <div class="author-wrapper"><img src="https://img.xhs/avatar.jpg"></div>
      <div class="swiper-slide"><img class="emoji" src="https://img.xhs/emoji.png"></div>
      <div class="swiper-slide"><img class="note-slider-img" src="data:image/png;base64,abc"></div>
      <div class="swiper-slide"><img class="note-slider-img" src="blob:https://xhs/abc"></div>
      <div class="media-box"><img srcset="https://img.xhs/c-small.jpg 1x, https://img.xhs/c-large.jpg 2x"></div>
    </div>`);
  const root = document.querySelector('.note-detail-mask') as Element;

  assert.deepEqual(extractNoteImages(root), [
    { index: 0, url: 'https://img.xhs/a.jpg', width: 1080, height: 1440, alt: 'first image' },
    { index: 1, url: 'https://img.xhs/b.jpg' },
    { index: 2, url: 'https://img.xhs/c-small.jpg' },
  ]);
});
