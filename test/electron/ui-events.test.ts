import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// UI 事件解析单测（edge-companion-ui）：结构化优先、中文行映射兜底、计数只认 ✓ 成功行。
// CJS 模块经 createRequire 引入（同 ads-local-api.test.ts 模式）。
const require = createRequire(import.meta.url);

interface UiEvent {
  kind: string;
  type?: string;
  sentence?: string;
  presence?: string;
  loopStage?: string | null;
  statsDelta?: { views?: number; likes?: number; collects?: number; comments?: number };
  publish?: { state: string; title?: string; code?: string };
  account?: { id: string; name?: string };
}
const { createUiEventStream } = require('../../src/electron/ui-events.cjs') as {
  createUiEventStream: () => { push: (line: string) => UiEvent | null };
};

test('结构化 [ui-event] 行优先直接采用', () => {
  const s = createUiEventStream();
  const evt = s.push('[ui-event] {"kind":"publish","publish":{"state":"pending","title":"秋日城市漫步 · 5 家宝藏咖啡馆"}}');
  assert.ok(evt);
  assert.equal(evt.kind, 'publish');
  assert.equal(evt.publish?.state, 'pending');
  assert.match(evt.publish?.title ?? '', /秋日城市漫步/);
});

test('结构化行 JSON 坏了 → 走兜底映射而非抛错', () => {
  const s = createUiEventStream();
  assert.equal(s.push('[ui-event] {not-json'), null);
});

test('账号身份行 → identity 事件（id + 昵称）', () => {
  const s = createUiEventStream();
  const evt = s.push('[aidcp-edge] 账号身份已确立: acct-123 (晚风手作) [source=login]');
  assert.ok(evt);
  assert.equal(evt.kind, 'identity');
  assert.equal(evt.account?.id, 'acct-123');
  assert.equal(evt.account?.name, '晚风手作');
});

test('账号身份行无昵称 → 用 id 兜底', () => {
  const s = createUiEventStream();
  const evt = s.push('[aidcp-edge] 账号身份已确立: acct-9 [source=env-override]');
  assert.equal(evt?.account?.id, 'acct-9');
  assert.equal(evt?.account?.name, '');
});

test('连接云端 → 活动 + 在场感', () => {
  const s = createUiEventStream();
  const evt = s.push('[aidcp-edge] 已连接云端 ws://x:8787，等待命令 ...');
  assert.equal(evt?.type, 'connect');
  assert.ok(evt?.sentence);
  assert.ok(evt?.presence);
});

test('note.detail 上报 → 标题入叙述 + views+1 + 阅读阶段', () => {
  const s = createUiEventStream();
  const evt = s.push('[browse] note.open: 已上报 note.detail noteId=abc「秋日咖啡馆合集」 by 小鹿 👍12 ⭐3 正文:今天…');
  assert.ok(evt);
  assert.match(evt.sentence ?? '', /秋日咖啡馆合集/);
  assert.match(evt.presence ?? '', /正在认真读/);
  assert.equal(evt.loopStage, 'read');
  assert.deepEqual(evt.statsDelta, { views: 1 });
});

test('✓ 点赞成功 → likes+1，叙述带上最近笔记标题', () => {
  const s = createUiEventStream();
  s.push('[browse] note.open: 已上报 note.detail noteId=abc「露营装备清单」 by 小鹿 👍1 ⭐0 正文:x…');
  const evt = s.push('[browse] ✓ 点赞成功 (120, 340)');
  assert.deepEqual(evt?.statsDelta, { likes: 1 });
  assert.match(evt?.sentence ?? '', /露营装备清单/);
  assert.equal(evt?.loopStage, 'interact');
});

test('✓ 收藏成功 / ✓ 评论发布成功 / ✓ 评论点赞成功 → 各自计数', () => {
  const s = createUiEventStream();
  assert.deepEqual(s.push('[browse] ✓ 收藏成功 (1, 2)')?.statsDelta, { collects: 1 });
  assert.deepEqual(s.push('[browse] ✓ 评论发布成功（编辑器清空 + 自己的评论行出现，耗时 3s）')?.statsDelta, { comments: 1 });
  assert.deepEqual(s.push('[browse] ✓ 评论点赞成功 (anchor=c1)')?.statsDelta, { likes: 1 });
});

test('红线：失败行绝不计数（旧 substring 匹配的已知误计全部修正）', () => {
  const s = createUiEventStream();
  // 旧法 includes('like') → 失败行也计赞
  assert.equal(s.push('[browse] ⚠ comment_like 点击后状态未变化 (href=x)'), null);
  // 旧法 includes('提取内容') → 失败行计浏览
  assert.equal(s.push('[browse] note.open: 提取内容失败：timeout'), null);
  // 旧法 includes('like') → 命令下发（尚未执行）就计赞
  assert.equal(s.push('[browse] 命令: interaction.like (noteId=n1)'), null);
});

test('page.cards 上报 → 只更新在场感，不再计浏览数（旧法误计）', () => {
  const s = createUiEventStream();
  const evt = s.push('[browse] 已上报 6 张可见卡片 (page.cards): a,b,c');
  assert.equal(evt?.kind, 'presence');
  assert.equal(evt?.loopStage, 'feed');
  assert.equal(evt?.statsDelta, undefined);
  assert.equal(evt?.sentence, undefined);
});

test('风控弹窗如实呈现（不盖住阻断）', () => {
  const s = createUiEventStream();
  const evt = s.push('[browse] 检测到验证码弹窗，暂停操作，等待处理…');
  assert.equal(evt?.type, 'popup');
  assert.match(evt?.sentence ?? '', /验证码弹窗/);
  const cleared = s.push('[aidcp-edge] 阻断弹窗已清除，恢复浏览');
  assert.equal(cleared?.type, 'popup_cleared');
});

test('浏览循环阶段：scroll→feed / note.open→select / back→return / 结束→null', () => {
  const s = createUiEventStream();
  assert.equal(s.push('[browse] 命令: page.scroll (continue)')?.loopStage, 'feed');
  assert.equal(s.push('[browse] 命令: note.open (index=2, noteId=n)')?.loopStage, 'select');
  assert.equal(s.push('[browse] 命令: navigation.back (browse_next, target=feed)')?.loopStage, 'return');
  assert.equal(s.push('[browse] 浏览循环结束')?.loopStage, null);
});

test('未识别行 → null（只进开发者详情）', () => {
  const s = createUiEventStream();
  assert.equal(s.push('[aidcp-edge] 节点身份 edgeId=e1 [source=env]'), null);
  assert.equal(s.push(''), null);
});
