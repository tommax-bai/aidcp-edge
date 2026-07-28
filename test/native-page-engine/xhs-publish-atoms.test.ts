import assert from 'node:assert/strict';
import test from 'node:test';
import { installXhsDom, runXhsRouter as run } from './xhs-dom-fixture.js';

/**
 * 小红书发布原子的行为契约（change restore-native-xiaohongshu-action-honesty，任务 3.1 / 3.2）。
 *
 * 覆盖两条红线：
 *  · 正文填写——增量写入 + 每个换行独立派发回车 + 有界确认 + 失败清场，绝不留半截草稿；
 *  · 提交判据——只认页面上的成功文案，地址判据出局；「已派发未确认」必须如实带上已派发位，
 *    「压根没点」必须保持未派发位（谎报已派发 = 稿子静默丢失，谎报未派发 = 一稿两发）。
 * 参照书见 openspec/changes/restore-native-xiaohongshu-action-honesty/oracle.md ③。
 */

const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';

function receiptOf(result: { output: { kind: string; value: Record<string, unknown> } }): Record<string, unknown> {
  return result.output.value;
}

// ── 3.1 正文填写 ───────────────────────────────────────────────────────────

test('3.1 多段正文逐段写入，每个换行独立派发一次回车', async () => {
  const { dom } = installXhsDom(
    '<main><div id="body" contenteditable="true"></div></main>',
    PUBLISH_URL,
  );
  const enters: string[] = [];
  dom.window.document.querySelector('#body')?.addEventListener('keydown', (event) => {
    enters.push((event as KeyboardEvent).key);
  });
  const inputs: number[] = [];
  dom.window.document.querySelector('#body')?.addEventListener('input', () => {
    inputs.push(dom.window.document.querySelector('#body')?.textContent?.length ?? 0);
  });

  const result = await run({
    kind: 'publish_fill_field',
    params: { recordId: 1, seq: 2, fieldType: 'content', value: '第一段正文\n第二段正文\n第三段正文' },
  });

  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(receiptOf(result).ok, true);
  assert.equal(
    enters.filter((key) => key === 'Enter').length,
    2,
    '三段正文之间有两个换行，每个都必须独立派发一次回车',
  );
  // 增量写入：内容是一段段长出来的，不是一次性赋值。
  assert.ok(inputs.length > 3, `写入应当是增量的，实际只派发了 ${inputs.length} 次输入事件`);
  assert.equal(
    dom.window.document.querySelector('#body')?.textContent,
    '第一段正文\n第二段正文\n第三段正文',
  );
});

/** 装一个「会改写写入内容」的富文本编辑器：每次输入后按 rewrite 重写自己的内容。 */
function installRewritingEditor(rewrite: (written: string) => string): { body: Element } {
  const { dom } = installXhsDom('<main><div id="body" contenteditable="true"></div></main>', PUBLISH_URL);
  const body = dom.window.document.querySelector('#body') as Element;
  body.addEventListener('input', () => {
    const rewritten = rewrite(body.textContent ?? '');
    if (rewritten !== body.textContent) body.textContent = rewritten;
  });
  return { body };
}

test('3.1 编辑器把写入吞掉时诚实失败并清场，不留半截草稿', async () => {
  // 平台侧把写入截断：写进去的永远只有开头一小截。
  const { body } = installRewritingEditor((written) => written.slice(0, 6));

  const result = await run({
    kind: 'publish_fill_field',
    params: { recordId: 1, seq: 2, fieldType: 'content', value: '这是一段完整的正文内容，绝不能只写进去一小截' },
  });

  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(receiptOf(result).reason, 'publish_field_readback_mismatch');
  assert.equal(body.textContent, '', '失败必须清场：留着半截草稿会被下一次填写拼上，或被提交原样发出去');
});

test('3.1 编辑器做无害的标点改写时不判失败', async () => {
  // 编辑器把半角逗号换成全角：内容一个字没丢，严格等值却会把它判成失败。
  const { body } = installRewritingEditor((written) => written.replace(/,/g, '，'));
  const value = '今天去了这家新开的咖啡馆环境很不错味道也在线,推荐给喜欢安静的朋友们';

  const result = await run({
    kind: 'publish_fill_field',
    params: { recordId: 1, seq: 2, fieldType: 'content', value },
  });

  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(receiptOf(result).ok, true);
  assert.equal(body.textContent, value.replace(/,/g, '，'));
});

// ── 3.2 提交判据 ───────────────────────────────────────────────────────────

test('3.2 提交目标取严格文案的叶子按钮，不点包裹容器也不点暂存离开', async () => {
  const { dom } = installXhsDom(
    `<main>
       <div class="publish-bar" data-test-rect="400,60">
         <button id="save-draft" data-test-rect="80,40">暂存离开</button>
         <div id="submit-wrap" data-test-rect="120,40"><button id="submit" data-test-rect="80,40">发布</button></div>
       </div>
     </main>`,
    PUBLISH_URL,
  );
  const doc = dom.window.document;
  // 右侧的发布按钮：给它一个更大的横坐标，锁「取最靠右那个」。
  const rects = new Map<string, number>([['save-draft', 0], ['submit-wrap', 200], ['submit', 210]]);
  for (const [id, x] of rects) {
    const element = doc.querySelector(`#${id}`) as Element;
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x, y: 0, left: x, top: 0, right: x + 80, bottom: 40, width: 80, height: 40 }),
    });
  }
  const clicked: string[] = [];
  doc.addEventListener('click', (event) => { clicked.push((event.target as Element).id); }, true);
  doc.querySelector('#submit')?.addEventListener('click', () => {
    const toast = doc.createElement('div');
    toast.className = 'toast';
    toast.textContent = '发布成功';
    doc.body.appendChild(toast);
  });

  const result = await run({ kind: 'publish_submit', params: { recordId: 5, seq: 9 } });

  assert.deepEqual(clicked, ['submit'], `只应点中叶子发布按钮，实点：${clicked.join(',')}`);
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(receiptOf(result).ok, true);
  assert.equal(receiptOf(result).submitDispatched, true);
});

test('3.2 找不到发布按钮时已派发位保持假', async () => {
  installXhsDom('<main><button id="save">暂存离开</button></main>', PUBLISH_URL);
  const result = await run({ kind: 'publish_submit', params: { recordId: 5, seq: 9 } });
  assert.equal(result.effectPhase, 'not_started');
  assert.equal(receiptOf(result).ok, false);
  assert.equal(receiptOf(result).error, 'publish_submit_not_found');
  assert.equal(
    receiptOf(result).submitDispatched,
    false,
    '压根没点却报「已派发」，云端据此不重投 → 稿子静默丢失',
  );
});

test('3.2 地址像成功、页面上早有同款文案，都不算本次提交的成功证据', { timeout: 40_000 }, async () => {
  // 地址判据是已上膛的假成功：抢占方 / 恢复导航会在提交窗口内把发布页导走。
  // 点击前就在页面上的「发布成功」同样不是本次的证据（草稿箱提示、历史浮层都可能含它）。
  installXhsDom(
    `<main>
       <div class="draft-hint">上一篇发布成功</div>
       <button id="submit">发布</button>
     </main>`,
    'https://creator.xiaohongshu.com/publish/success?published=1',
  );

  const result = await run({ kind: 'publish_submit', params: { recordId: 5, seq: 9 } });

  assert.equal(receiptOf(result).ok, false, '地址与陈旧文案都不得被当成本次提交的成功证据');
  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(receiptOf(result).error, 'post_validate_failed');
  assert.equal(
    receiptOf(result).submitDispatched,
    true,
    '点已经发出去了：未确认必须如实带上已派发位，否则云端按提交前失败重投 → 双发',
  );
});
