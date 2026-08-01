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
  /** 话题候选 / 话题真 token 的目标词。 */
  value?: string;
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

test('到达确认的第二条证据：编辑器有没有被平台清空，三态如实作答（H.1）', () => {
  installXhsDom(DETAIL_HTML, 'https://www.xiaohongshu.com/explore/65f2ab01');
  const editor = document.querySelector('textarea') as HTMLTextAreaElement;

  editor.value = '';
  assert.equal(
    runInputTargets({ kind: 'comment_ack', text: '别人的评论' }).editorCleared,
    true,
    '平台在提交成功后会把编辑器清空 —— 这是确认的结构必要条件',
  );

  editor.value = '这条还躺在编辑器里';
  assert.equal(
    runInputTargets({ kind: 'comment_ack', text: '别人的评论' }).editorCleared,
    false,
  );

  // 编辑器压根定位不到：这一条**读不到**，键必须缺席。写成 false 就等于把「不知道」
  // 说成「读到了、没清空」——调用方拿它当确定的坏消息，病因就此指错方向。
  installXhsDom(
    `<!doctype html><html><body><div class="note-detail-mask">
      <div class="comment-list"><div class="comment-item">别人的评论</div></div>
    </div></body></html>`,
    'https://www.xiaohongshu.com/explore/65f2ab01',
  );
  const blind = runInputTargets({ kind: 'comment_ack', text: '别人的评论' });
  assert.equal('editorCleared' in blind, false, '读不到时 MUST 缺席，绝不塌成 false');
  assert.equal(blind.appeared, true);
});

test('到达确认不许扫到编辑器里那份还没发出去的正文（H.1 的自证循环）', () => {
  // 现场：富文本评论框被包在一个 class 含 comment 的容器里 —— 这在真实页面上完全正常。
  // 编辑器的 textContent 是活的，所以「本次正文」在**提交之前**就已经在扫描面里了。
  // 剔除编辑器及其祖先之前，这一场会回 appeared:true：一条根本没发出去的评论被判确认。
  installXhsDom(
    `<!doctype html><html><body><div class="note-detail-mask">
      <div class="comment-input-wrapper">
        <div contenteditable="true">这条正文还没发出去</div>
      </div>
      <div class="comment-list"></div>
    </div></body></html>`,
    'https://www.xiaohongshu.com/explore/65f2ab01',
  );

  const probed = runInputTargets({ kind: 'comment_ack', text: '这条正文还没发出去' });
  assert.equal(probed.appeared, false, '扫到的是自己刚写进去的那份 = 自证，不是证据');
  assert.equal(probed.editorCleared, false, '编辑器里还躺着内容，结构必要条件同样不成立');

  // 反向对照：同一段文字真的出现在评论区里时，证据照常成立 —— 剔除的是污染源，不是证据本身。
  const list = document.querySelector('.comment-list') as HTMLElement;
  list.innerHTML = '<div class="comment-item">这条正文还没发出去</div>';
  assert.equal(
    runInputTargets({ kind: 'comment_ack', text: '这条正文还没发出去' }).appeared,
    true,
  );
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

test('富文本正文的段落数按真实渲染出来的换行数，<br> 分隔与裸首段都不许被读成一段', () => {
  // 引擎拿 `paragraphs` 当「裸回车有没有真的拆出段落」的结构证据。这个数字被低估的后果
  // 不是少一层保护，而是**把一次成功的写入判成段落丢失**（内容真在，却清场重来）。
  // 只按块级子节点数会漏两类真实结构：段落靠 <br> 分隔（一个块都没有）、
  // 首段是裸文本节点（块数比真实段落数少一）。
  installXhsDom(PUBLISH_HTML, 'https://creator.xiaohongshu.com/publish/publish');
  const editor = document.querySelector('[contenteditable="true"]') as HTMLElement;

  // jsdom 不实现 innerText（浏览器里它才是「渲染出来的文本」）；这里按浏览器语义补上。
  const asRendered = (value: string) => {
    Object.defineProperty(editor, 'innerText', { configurable: true, value });
  };

  editor.innerHTML = '第一段<br>第二段';
  asRendered('第一段\n第二段');
  assert.equal(
    runInputTargets({ kind: 'publish_field', op: 'probe', fieldType: 'content' }).paragraphs,
    2,
    '<br> 分隔的两段被读成一段 ⇒ 引擎会把一次成功的写入判成段落丢失',
  );

  editor.innerHTML = '第一段<div>第二段</div>';
  asRendered('第一段\n第二段');
  assert.equal(
    runInputTargets({ kind: 'publish_field', op: 'probe', fieldType: 'content' }).paragraphs,
    2,
    '首段是裸文本节点时块数比真实段落数少一',
  );
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

const FEED_HTML = `<!doctype html><html><body>
  <div id="exploreFeeds" style="overflow-y:auto"><section>卡片</section></div>
</body></html>`;

/** 让某个元素在 jsdom 里“真的可滚”：jsdom 的 scrollHeight / clientHeight 恒为 0。 */
function makeScrollable(el: Element, scrollHeight: number, clientHeight: number, scrollTop: number): void {
  for (const [name, value] of [
    ['scrollHeight', scrollHeight],
    ['clientHeight', clientHeight],
    ['scrollTop', scrollTop],
  ] as const) {
    Object.defineProperty(el, name, { configurable: true, value });
  }
}

test('feed 可滚区：认出内层滚动容器时，坐标取它与视口的交集中心、位置取它的 scrollTop', () => {
  const fixture = installXhsDom(FEED_HTML, 'https://www.xiaohongshu.com/explore');
  const feed = document.querySelector('#exploreFeeds') as HTMLElement;
  makeScrollable(feed, 4000, 700, 320);
  // 容器比视口高：几何中心落在视口外，取交集中心才落得进去。
  fixture.setRect(feed, { x: 100, y: -200, width: 600, height: 4000 });

  const area = runInputTargets({ kind: 'feed_scroll_area' }) as Record<string, number | string | boolean>;
  assert.equal(area.found, true);
  assert.equal(area.scroller, 'element');
  assert.equal(area.position, 320, '位置必须读该可滚元素自己的 scrollTop');
  assert.equal(area.x, 400, '交集横向中心 = (100+700)/2');
  const viewportHeight = Number(area.viewportHeight);
  assert.ok(viewportHeight > 0);
  // 交集纵向 = [0, min(视口高, 3800)]，中心即其一半。
  assert.equal(area.y, Math.min(viewportHeight, 3800) / 2);
});

test('feed 可滚区：没有真正可滚的内层容器时回落到窗口，仍给出实测坐标与实测位置', () => {
  installXhsDom('<!doctype html><html><body><div id="exploreFeeds"><section>卡片</section></div></body></html>');
  // 内容溢出但 overflow:visible —— 真正在滚的是窗口，绝不能把它当滚动容器
  // （那样位置读的是恒为 0 的 scrollTop，一次真实翻页会被读成「没动」）。
  makeScrollable(document.querySelector('#exploreFeeds') as HTMLElement, 4000, 700, 0);
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 512 });

  const area = runInputTargets({ kind: 'feed_scroll_area' }) as Record<string, number | string | boolean>;
  assert.equal(area.found, true);
  assert.equal(area.scroller, 'window');
  assert.equal(area.position, 512);
  assert.equal(area.x, window.innerWidth / 2);
  assert.equal(area.y, window.innerHeight / 2);
});

test('评论可滚区：几何 + 位置 + 页面上真实可见的评论行数一并给出', () => {
  const fixture = installXhsDom(
    `<!doctype html><html><body><div class="note-detail-mask">
       <div class="comment-list" style="overflow-y:scroll">
         <div class="comment-item">一</div><div class="comment-item">二</div><div class="comment-item">三</div>
       </div>
     </div></body></html>`,
    'https://www.xiaohongshu.com/explore/65f2ab01',
  );
  const list = document.querySelector('.comment-list') as HTMLElement;
  makeScrollable(list, 2400, 500, 180);
  fixture.setRect(list, { x: 40, y: 60, width: 400, height: 500 });

  const area = runInputTargets({ kind: 'comment_scroll_area' }) as Record<string, number | string | boolean>;
  assert.equal(area.found, true);
  assert.equal(area.position, 180);
  assert.equal(area.rows, 3, '行数按页面上真实可见的评论条数，不按下发步数');
  assert.equal(area.x, 240);
  assert.equal(area.y, 310);
});

test('详情浮层关闭控件：「浮层不在」与「浮层在但控件没认出来」是两态', () => {
  installXhsDom(
    `<!doctype html><html><body><div class="note-detail-mask">
       <button aria-label="关闭">×</button>
     </div></body></html>`,
    'https://www.xiaohongshu.com/explore/65f2ab01',
  );
  const closable = runInputTargets({ kind: 'detail_close' });
  assert.equal(closable.overlay, true);
  assert.equal(closable.found, true);
  assert.equal(typeof closable.x, 'number');

  installXhsDom(
    '<!doctype html><html><body><div class="note-detail-mask"><span>正文</span></div></body></html>',
    'https://www.xiaohongshu.com/explore/65f2ab01',
  );
  const stuck = runInputTargets({ kind: 'detail_close' });
  assert.equal(stuck.overlay, true, '浮层在场必须如实说，否则调用方以为无需关');
  assert.equal(stuck.found, false, '关不掉就报关不掉，不拿别的元素充数');

  installXhsDom('<!doctype html><html><body><div>首页</div></body></html>');
  const none = runInputTargets({ kind: 'detail_close' });
  assert.equal(none.overlay, false);
  assert.equal(none.found, false);
});

test('话题候选：只认精确候选或「新建话题」，认不出就报没找到、绝不让调用方乱点', () => {
  const dropdown = (items: string) => `<!doctype html><html><body>
    <div contenteditable="true"><p>正文</p></div>
    <div class="tippy-box" role="tooltip"><div id="creator-editor-topic-container">${items}</div></div>
  </body></html>`;

  installXhsDom(dropdown('<div class="item">#考研 12万浏览</div>'), 'https://creator.xiaohongshu.com/publish/publish');
  const exact = runInputTargets({ kind: 'topic_candidate', value: '考研' });
  assert.equal(exact.found, true);
  assert.equal(exact.matched, 'exact');
  assert.equal(typeof exact.x, 'number');

  // 只有「新建话题」时用它兜底 —— 那正是这个词还不存在的正常情形。
  installXhsDom(dropdown('<div class="item">新建话题 考研</div>'), 'https://creator.xiaohongshu.com/publish/publish');
  assert.equal(runInputTargets({ kind: 'topic_candidate', value: '考研' }).matched, 'create');

  // 下拉里全是无关词：MUST 报没找到。点其中任何一个都会给稿子贴上一个**撤不回来**的无关话题。
  installXhsDom(
    dropdown('<div class="item">#雅思 3万浏览</div><div class="item">#托福 1万浏览</div>'),
    'https://creator.xiaohongshu.com/publish/publish',
  );
  const missed = runInputTargets({ kind: 'topic_candidate', value: '考研' });
  assert.equal(missed.found, false);
  assert.equal(missed.dropdown, true, '「下拉没弹出来」与「弹了但没有目标项」是两态');

  // 下拉压根没弹：与上一态分开。
  installXhsDom('<!doctype html><html><body><div contenteditable="true"></div></body></html>', 'https://creator.xiaohongshu.com/publish/publish');
  assert.equal(runInputTargets({ kind: 'topic_candidate', value: '考研' }).dropdown, false);
});

test('话题真 token：纯文本 #关键词 判 false，精确相等而非子串（H.1 同族的自证循环）', () => {
  const page = (body: string) => `<!doctype html><html><body>
    <div contenteditable="true">${body}</div>
  </body></html>`;
  const url = 'https://creator.xiaohongshu.com/publish/publish';

  // ① 用户打了字但没从候选提交：正文里只有纯文本。**这正是旧判据会读成成功的那一场**——
  //    它读回的是自己刚写进去的东西。
  installXhsDom(page('<p>正文 #考研</p>'), url);
  assert.equal(runInputTargets({ kind: 'topic_committed', value: '考研' }).committed, false);

  // ② 真 token（带 data-topic），并剔除隐藏后缀 span.content-hide 再比。
  installXhsDom(
    page('<p>正文 <a class="tiptap-topic" data-topic=\'{"name":"考研"}\'>#考研<span class="content-hide">[话题]#</span></a></p>'),
    url,
  );
  assert.equal(runInputTargets({ kind: 'topic_committed', value: '考研' }).committed, true);

  // ③ 精确相等而非子串：已存在的「#考研数学」不得让「考研」判成已贴上。
  installXhsDom(
    page('<p>正文 <a class="tiptap-topic" data-topic=\'{"name":"考研数学"}\'>#考研数学<span class="content-hide">[话题]#</span></a></p>'),
    url,
  );
  assert.equal(
    runInputTargets({ kind: 'topic_committed', value: '考研' }).committed,
    false,
    '子串会把「#考研数学」误判成「考研」已贴上',
  );

  // ④ data-topic 不是合法 JSON 时回落到文本比对，不整条判死。
  installXhsDom(page('<p><a class="tiptap-topic" data-topic="{坏JSON">#考研</a></p>'), url);
  assert.equal(runInputTargets({ kind: 'topic_committed', value: '考研' }).committed, true);
});
