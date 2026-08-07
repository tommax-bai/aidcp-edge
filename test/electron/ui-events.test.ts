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
  browserIndependent?: boolean;
  statsDelta?: { views?: number; likes?: number; collects?: number; comments?: number; follows?: number; publishes?: number };
  publish?: { state: string; title?: string; code?: string };
  account?: { id: string; name?: string };
}
const { createUiEventStream, mergeStats } = require('../../src/electron/ui-events.cjs') as {
  createUiEventStream: () => { push: (line: string) => UiEvent | null };
  mergeStats: (prev: Record<string, number> | null, patch: Record<string, number> | null) => Record<string, number>;
};

test('结构化 [ui-event] 行优先直接采用', () => {
  const s = createUiEventStream();
  const evt = s.push('[ui-event] {"kind":"publish","publish":{"state":"pending","title":"秋日城市漫步 · 5 家宝藏咖啡馆"}}');
  assert.ok(evt);
  assert.equal(evt.kind, 'publish');
  assert.equal(evt.publish?.state, 'pending');
  assert.match(evt.publish?.title ?? '', /秋日城市漫步/);
});

test('结构化事件只在显式声明时保留浏览器无关执行证据', () => {
  const s = createUiEventStream();
  const evt = s.push('[ui-event] {"kind":"presence","loopStage":"control","browserIndependent":true}');
  assert.equal(evt?.loopStage, 'control');
  assert.equal(evt?.browserIndependent, true);
});

test('结构化 publish 行 → 同步在场感，进度区跟随发布状态刷新', () => {
  const s = createUiEventStream();
  const pending = s.push('[ui-event] {"kind":"publish","publish":{"state":"pending","title":"秋日城市漫步"}}');
  assert.match(pending?.presence ?? '', /飞书/);
  assert.match(pending?.presence ?? '', /等你确认/);
  assert.equal(pending?.loopStage, 'write');

  const done = s.push('[ui-event] {"kind":"publish","publish":{"state":"published","title":"秋日城市漫步"}}');
  assert.match(done?.presence ?? '', /已发布/);
  assert.match(done?.presence ?? '', /回到浏览/);
  assert.equal(done?.loopStage, 'write');
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

test('账号身份行无昵称 → 叙述不暴露长 id（in-place 读取常态）', () => {
  const s = createUiEventStream();
  const evt = s.push('[aidcp-edge] 账号身份已确立: 66cd1d4f000000001d0314ee [source=login]');
  assert.equal(evt?.account?.id, '66cd1d4f000000001d0314ee');
  assert.equal(evt?.account?.name, '');
  assert.ok(!(evt?.sentence ?? '').includes('66cd1d4f'), '句子里绝不出现长 id');
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

test('Facebook confirmed like 只认结构化事件，旧日志行不重复计数', () => {
  const s = createUiEventStream();
  assert.equal(s.push('[fb-like] ✓ 点赞成功（按钮状态已翻转）'), null);
  const evt = s.push('[ui-event] {"kind":"activity","type":"like","sentence":"点了个赞","statsDelta":{"likes":1}}');
  assert.deepEqual(evt?.statsDelta, { likes: 1 });
});

test('✓ 收藏成功 / ✓ 评论发布成功 / ✓ 评论点赞成功 → 各自计数', () => {
  const s = createUiEventStream();
  assert.deepEqual(s.push('[browse] ✓ 收藏成功 (1, 2)')?.statsDelta, { collects: 1 });
  const comment = s.push('[browse] ✓ 评论发布成功（编辑器清空 + 自己的评论行出现，耗时 3s）');
  assert.deepEqual(comment?.statsDelta, { comments: 1 });
  assert.equal(comment?.loopStage, 'comment');
  assert.deepEqual(s.push('[browse] ✓ 评论点赞成功 (anchor=c1)')?.statsDelta, { likes: 1 });
  assert.deepEqual(s.push('[browse] ✓ 关注成功')?.statsDelta, { follows: 1 });
});

test('红线：失败行绝不计数（旧 substring 匹配的已知误计全部修正）', () => {
  const s = createUiEventStream();
  // 旧法 includes('like') → 失败行也计赞
  assert.equal(s.push('[browse] ⚠ comment_like 点击后状态未变化 (href=x)'), null);
  // 旧法 includes('提取内容') → 失败行计浏览
  assert.equal(s.push('[browse] note.open: 提取内容失败：timeout'), null);
  // 旧法 includes('like') → 命令下发（尚未执行）就计赞
  assert.equal(s.push('[browse] 命令: xiaohongshu.note.like (noteId=n1)'), null);
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
  assert.equal(s.push('[browse] 命令: xiaohongshu.feed.scroll (continue)')?.loopStage, 'feed');
  assert.equal(s.push('[browse] 命令: xiaohongshu.note.open (index=2, noteId=n)')?.loopStage, 'select');
  assert.equal(s.push('[browse] 命令: xiaohongshu.note.comment (noteId=n1)')?.loopStage, 'comment');
  assert.equal(s.push('[browse] 命令: navigation.back (browse_next, target=feed)')?.loopStage, 'return');
  assert.equal(s.push('[browse] 浏览循环结束')?.loopStage, null);
});

test('浏览循环结束带续场时间 → 活动流说明休息后继续', () => {
  const s = createUiEventStream();
  const evt = s.push('[browse] 浏览循环结束，预计休息约 2 分钟后继续');
  assert.equal(evt?.type, 'session_end');
  assert.equal(evt?.sentence, '这一轮浏览结束，约 2 分钟后继续');
  assert.match(evt?.presence ?? '', /休息约 2 分钟后会继续/);
  assert.equal(evt?.loopStage, null);
});

test('未识别行 → null（只进开发者详情）', () => {
  const s = createUiEventStream();
  assert.equal(s.push('[aidcp-edge] 节点身份 edgeId=e1 [source=env]'), null);
  assert.equal(s.push(''), null);
});

test('回归：局部计数补丁绝不清空其他计数（今日小结空数字 bug）', () => {
  const prev = { views: 3, likes: 5, collects: 2, comments: 1, follows: 4, publishes: 1 };
  assert.deepEqual(mergeStats(prev, { views: 4 }), {
    views: 4,
    likes: 5,
    collects: 2,
    comments: 1,
    follows: 4,
    publishes: 1,
  });
  // 缺字段 / 非法值一律兜 0，绝不把 undefined 漏进渲染层
  assert.deepEqual(mergeStats(null, { likes: 1 }), {
    views: 0,
    likes: 1,
    collects: 0,
    comments: 0,
    follows: 0,
    publishes: 0,
  });
  assert.deepEqual(mergeStats({ views: Number.NaN }, null), {
    views: 0,
    likes: 0,
    collects: 0,
    comments: 0,
    follows: 0,
    publishes: 0,
  });
});

test('结构化 lastPublish 行（云端快照回填）→ 透传并截断标题', () => {
  const s = createUiEventStream();
  const evt = s.push(
    '[ui-event] {"kind":"lastPublish","lastPublish":{"title":"这是一个特别特别长需要被截断的上次发布笔记标题超过三十个字符的示例标题","at":1730000000000}}',
  ) as (UiEvent & { lastPublish?: { title: string; at: number } }) | null;
  assert.ok(evt);
  assert.equal(evt.kind, 'lastPublish');
  assert.equal(evt.lastPublish?.at, 1730000000000);
  assert.ok((evt.lastPublish?.title ?? '').length <= 31, '标题按 30 字截断（含省略号）');
  assert.ok((evt.lastPublish?.title ?? '').endsWith('…'));
  assert.equal(evt.sentence, undefined, 'lastPublish 不产活动流句子（不是刚发生的事件）');
  assert.equal(evt.statsDelta, undefined, 'lastPublish 不计数');
});

test('结构化 FB 写动作行原样透传（解析器对新 type 不作枚举校验）', () => {
  const s = createUiEventStream();
  // change facebook-write-action-visibility：FB 走结构化层，解析器只要求 kind 是 string、其余透传。
  // 本例证明新增 type 无需改解析器；红线断言（待批准不计数）压在发射器侧的 comment-handler 测试里。
  const evt = s.push(
    '[ui-event] {"kind":"activity","type":"comment_pending","sentence":"评论待管理员批准，还没显示出来：「请问还招人吗」","loopStage":"interact"}',
  );
  assert.ok(evt);
  assert.equal(evt.kind, 'activity');
  assert.equal(evt.type, 'comment_pending');
  assert.equal(evt.sentence, '评论待管理员批准，还没显示出来：「请问还招人吗」');
  assert.equal(evt.statsDelta, undefined, '待批准绝不计数——发射器不带，解析器也不得凭空补');
});
