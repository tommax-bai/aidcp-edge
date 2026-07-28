import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import {
  installXhsDom,
  runXhsRouter as run,
  runXhsSearchInput as runSearchInput,
} from './xhs-dom-fixture.js';

/**
 * 夹具（task 1.12）：几何不再钉死在原型上，改由 `installXhsDom` 按元素解析
 * （用例可用 `setRect` / `data-test-rect` 指定，脱档与 display:none 元素为零几何），
 * 使注入脚本的可见性判定在测试里真有两态。
 */
function install(html: string, url = 'https://www.xiaohongshu.com/explore'): JSDOM {
  return installXhsDom(html, url).dom;
}

test('extracts bounded feed cards without accepting a selector from the caller', async () => {
  install('<main><section class="note-item"><a href="/explore/n1"><span class="title"> Coffee   walk </span></a><span class="author">Alice</span><span class="like">1.2万</span></section></main>');
  const result = await run({ kind: 'browse_scroll', params: { reason: 'initial_scan' } });
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'page_cards');
  const cards = result.output.value.cards as Array<Record<string, unknown>>;
  assert.equal(cards[0]?.noteId, 'n1');
  assert.equal(cards[0]?.title, 'Coffee walk');
  assert.equal(cards[0]?.likeCount, 12_000);
});

test('accepts search_result_ai for the requested keyword and reads cards without resubmitting', async () => {
  install(
    '<main><section class="note-item"><a href="/explore/searchn1"><span class="title">AI Agent result</span></a></section></main>',
    'https://www.xiaohongshu.com/search_result_ai?keyword=AI%20Agent%E5%AE%9E%E6%88%98',
  );
  const result = await run({ kind: 'search_execute', params: { keyword: 'AI Agent实战' } });
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'page_cards');
  const cards = result.output.value.cards as Array<Record<string, unknown>>;
  assert.equal(cards[0]?.noteId, 'searchn1');
});

test('search input helper selects the visible instance and confirms exact focus before clearing', () => {
  const dom = install(`
    <textarea name="aiSearchTextarea" id="hidden" style="display:none">hidden value</textarea>
    <textarea name="aiSearchTextarea" id="visible">stale query</textarea>
  `);
  const geometry = runSearchInput('geometry');
  assert.equal(geometry.found, true);
  assert.equal(typeof geometry.x, 'number');

  const cleared = runSearchInput('focus-clear');
  assert.deepEqual(cleared, { found: true, focused: true, value: '' });
  assert.equal(dom.window.document.activeElement?.id, 'visible');
  assert.equal((dom.window.document.querySelector('#visible') as HTMLTextAreaElement).value, '');
  assert.equal((dom.window.document.querySelector('#hidden') as HTMLTextAreaElement).value, 'hidden value');
});

test('binds an interaction to the current note and verifies the changed state', async () => {
  // 互动栏按真机形态搭：无 aria-label、无 role=button、无「点赞」文本，
  // 状态位写在图标的 <use xlink:href> 上（#like → #liked），计数是裸数字。
  // 评论区自带同款控件 —— 放进夹具是为了钉住「作用域限定在互动栏内」，
  // 它一旦被点到就说明作用域又松回去了（真机实测过「卡片 311 赞 vs 详情 1 赞」这类误读）。
  const dom = install(
    `<main><div class="note-detail-mask">
       <div class="interactions engage-bar">
         <span class="like-wrapper" id="like"><svg><use xlink:href="#like"></use></svg><span class="count">311</span></span>
       </div>
       <div class="comments-container">
         <div class="comment-item"><span class="like-wrapper" id="comment-like"><svg><use xlink:href="#like"></use></svg><span class="count">1</span></span></div>
       </div>
     </div></main>`,
    'https://www.xiaohongshu.com/explore/n1',
  );
  dom.window.document.querySelector('#like')?.addEventListener('click', (event) => {
    (event.currentTarget as Element).querySelector('use')?.setAttribute('xlink:href', '#liked');
  });
  dom.window.document.querySelector('#comment-like')?.addEventListener('click', () => {
    throw new Error('comment-section like control must never be actuated by interaction_like');
  });
  const result = await run({ kind: 'interaction_like', params: { noteId: 'n1' } });
  assert.equal(result.effectPhase, 'confirmed');
  assert.deepEqual(result.output.value, { action: 'like', ok: true, noteId: 'n1' });

  const mismatch = await run({ kind: 'interaction_like', params: { noteId: 'another' } });
  assert.equal(mismatch.effectPhase, 'not_started');
  assert.equal(mismatch.output.value.reason, 'note_page_mismatch');
});

test('fails closed when publish field readback does not have a target', async () => {
  install('<main><div>creator</div></main>', 'https://creator.xiaohongshu.com/publish/publish');
  const result = await run({
    kind: 'publish_fill_field',
    params: { recordId: 1, seq: 2, fieldType: 'title', value: 'Bound title' },
  });
  assert.equal(result.effectPhase, 'not_started');
  assert.equal(result.output.value.ok, false);
  assert.equal(result.output.value.reason, 'publish_field_not_found');
});

test('selects the exact uploaded preview index and requires cover-active evidence', async () => {
  const dom = install(`
    <main>
      <div class="preview-item"><img src="one.jpg"></div>
      <div class="preview-item" id="target"><img src="two.jpg"></div>
      <button>设为封面</button>
    </main>
  `, 'https://creator.xiaohongshu.com/publish/publish');
  dom.window.document.querySelector('#target')?.addEventListener('click', (event) => {
    (event.currentTarget as Element).setAttribute('data-active', 'true');
  });
  const result = await run({
    kind: 'publish_set_cover',
    params: { recordId: 1, seq: 4, imageIndex: 1 },
  });
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.value.action, 'set_cover');
  assert.equal(result.output.value.ok, true);

  const missing = await run({
    kind: 'publish_set_cover',
    params: { recordId: 1, seq: 5, imageIndex: 3 },
  });
  assert.equal(missing.effectPhase, 'not_started');
  assert.equal(missing.output.value.reason, 'preview_not_found');
});

test('scheduled capture requires one exact title, scheduled state, platform id, and target time', async () => {
  const publishTime = new Date(2026, 6, 22, 18, 45).getTime();
  install(`
    <main>
      <div class="note-card" data-note-id="scheduled-1">
        <span class="title">Exact title</span><span>定时发布 18:45</span>
      </div>
      <div class="note-card" data-note-id="scheduled-2">
        <span class="title">Other title</span><span>定时发布 18:45</span>
      </div>
    </main>
  `, 'https://creator.xiaohongshu.com/new/note-manager');
  const result = await run({
    kind: 'publish_capture_scheduled',
    params: { recordId: 1, seq: 8, scheduledTitle: 'Exact title', publishTime },
  });
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.value.ok, true);
  assert.equal(result.output.value.value, 'scheduled-1');

  const missing = await run({
    kind: 'publish_capture_scheduled',
    params: { recordId: 1, seq: 9, scheduledTitle: 'Missing title', publishTime },
  });
  assert.equal(missing.effectPhase, 'not_started');
  assert.equal(missing.output.value.error, 'scheduled_record_not_found');
});
