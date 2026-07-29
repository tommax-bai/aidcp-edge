import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installXhsDom } from './xhs-dom-fixture.js';

/**
 * 小红书写动作特化用的页面判据分片（change `restore-native-actuation-humanization-and-locating` §8）。
 *
 * 为什么必须有这一组：Rust 侧的假 CDP 用例只做**字符串匹配**——它把分片当不透明字符串塞进
 * `Runtime.evaluate` 的表达式里，从不执行它。分片里一个语法错误、一个字段名写错，
 * Rust 全套仍然全绿，只有真机上才现形。这一组把分片真的在 jsdom 里跑一遍，
 * 并逐字段核对 Rust 侧要读的那些键（`found` / `match` / `focused` / `value` / `plainValue` /
 * `cleared` / `x` / `y` / `paragraphs` / `appeared` / `text` / `newlines` / `atEnd`）。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(
  resolve(repoRoot, 'native/page-engine/src/xhs-input-targets.js'),
  'utf8',
);

type TargetRequest = {
  kind: string;
  op?: string;
  noteId?: string;
  fieldType?: string;
  text?: string;
};

type TargetResult = Record<string, unknown>;

const runInputTargets = Function(`return (${source})`)() as (
  request: TargetRequest,
) => TargetResult;

const DETAIL_HTML = `<!doctype html><html><body>
  <div class="note-detail-mask">
    <a href="https://www.xiaohongshu.com/explore/65f2ab01">笔记</a>
    <textarea placeholder="说点什么"></textarea>
    <button>发送</button>
    <div class="comment-list"><div class="comment-item">别人的评论</div></div>
  </div>
</body></html>`;

const PUBLISH_HTML = `<!doctype html><html><body>
  <input placeholder="填写标题会有更多赞哦~" />
  <div contenteditable="true"><p></p></div>
</body></html>`;

test('评论编辑器：定位 / 几何 / 清场 / 回读四个 op 都按 Rust 侧读的字段名作答', () => {
  installXhsDom(DETAIL_HTML, 'https://www.xiaohongshu.com/explore/65f2ab01');
  const editor = document.querySelector('textarea') as HTMLTextAreaElement;
  editor.value = '上一条的残文';

  const probed = runInputTargets({ kind: 'comment_editor', op: 'probe' });
  assert.equal(probed.found, true);
  assert.equal(probed.plainValue, true, '受控框必须被标成 plainValue —— 换行写法由它决定');
  assert.equal(probed.value, '上一条的残文');
  assert.equal(typeof probed.x, 'number');
  assert.equal(typeof probed.y, 'number');

  const cleared = runInputTargets({ kind: 'comment_editor', op: 'clear' });
  assert.equal(cleared.cleared, true);
  assert.equal(editor.value, '', '清场必须真的把残文抹掉，否则会与本条拼在一起发出去');

  const focused = runInputTargets({ kind: 'comment_editor', op: 'focus' });
  assert.equal(focused.focused, true);
  assert.equal(focused.value, '');
});

test('目标笔记闸：地址里的笔记 id 对得上才放行，对不上如实报不匹配', () => {
  installXhsDom(DETAIL_HTML, 'https://www.xiaohongshu.com/explore/65f2ab01');
  assert.equal(runInputTargets({ kind: 'note_guard', noteId: '65f2ab01' }).match, true);
  assert.equal(runInputTargets({ kind: 'note_guard', noteId: '65f2ab99' }).match, false);
  // 没点名笔记时不设闸（与注入路由同口径）。
  assert.equal(runInputTargets({ kind: 'note_guard' }).match, true);
});

test('提交控件与提交后确认：找不到就诚实报 found=false，不拿别的元素充数', () => {
  installXhsDom(DETAIL_HTML, 'https://www.xiaohongshu.com/explore/65f2ab01');
  const submit = runInputTargets({ kind: 'comment_submit' });
  assert.equal(submit.found, true);
  assert.equal(typeof submit.x, 'number');

  assert.equal(
    runInputTargets({ kind: 'comment_ack', text: '别人的评论' }).appeared,
    true,
  );
  assert.equal(
    runInputTargets({ kind: 'comment_ack', text: '本条还没出现' }).appeared,
    false,
  );

  installXhsDom('<!doctype html><html><body><div></div></body></html>');
  assert.equal(runInputTargets({ kind: 'comment_submit' }).found, false);
});

test('发布字段：标题走受控框、正文走富文本，两者的换行写法由 plainValue 分流', () => {
  installXhsDom(PUBLISH_HTML, 'https://creator.xiaohongshu.com/publish/publish');
  const title = runInputTargets({ kind: 'publish_field', op: 'probe', fieldType: 'title' });
  assert.equal(title.found, true);
  assert.equal(title.plainValue, true);

  const content = runInputTargets({ kind: 'publish_field', op: 'probe', fieldType: 'content' });
  assert.equal(content.found, true);
  assert.equal(content.plainValue, false, '富文本正文必须走裸回车，绝不能被当成受控框');
});

test('归尾探针：换行数按顶层块推、读不到目标时 found=false 而不是假装读到了', () => {
  installXhsDom(PUBLISH_HTML, 'https://creator.xiaohongshu.com/publish/publish');
  const editor = document.querySelector('[contenteditable="true"]') as HTMLElement;
  editor.innerHTML = '<p>第一段</p><p>第二段</p>';

  const state = runInputTargets({ kind: 'content_caret_state', fieldType: 'content' });
  assert.equal(state.found, true);
  assert.equal(state.newlines, 1, '两个顶层块 = 一个换行');
  assert.equal(typeof state.atEnd, 'boolean');
  assert.equal(typeof state.text, 'string');

  installXhsDom('<!doctype html><html><body><div></div></body></html>');
  const missing = runInputTargets({ kind: 'content_caret_state', fieldType: 'content' });
  assert.equal(missing.found, false);
  assert.equal(missing.newlines, 0);
  assert.equal(missing.atEnd, false);
});
