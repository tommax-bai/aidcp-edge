import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 今日进展载荷的清洗 / 归一 / 乐观累加（change platform-honest-usage-metrics）。
// 这几条钉的全是**不报错的**回归：症状只会出现在屏幕上（格子该没有的时候有了、该有的时候没有）。
const require_ = createRequire(import.meta.url);
const dailyUsage = require_(
  join(dirname(fileURLToPath(import.meta.url)), '../../src/electron/daily-usage.cjs'),
) as {
  DAILY_USAGE_ACTIONS: string[];
  cleanSuppliedCounts: (input: unknown) => Record<string, number>;
  normalizeDailyUsage: (input: unknown) => { totals: Record<string, number>; [k: string]: unknown } | null;
  bumpDailyUsage: (usage: unknown, action: string, delta: number) => { totals: Record<string, number> } | null;
};

const { DAILY_USAGE_ACTIONS, cleanSuppliedCounts, normalizeDailyUsage, bumpDailyUsage } = dailyUsage;

/** 云端投影给 FB 的形状：无 collect / follow（结构不支持），有 join_group。 */
const FB_TOTALS = { view: 12, like: 3, comment: 1, publish: 0, join_group: 2 };

test('键清单与 protocol.ts 的单一来源一致（本文件是纯 JS、typecheck 抓不到这条漂移）', () => {
  assert.deepEqual(DAILY_USAGE_ACTIONS, ['view', 'like', 'collect', 'comment', 'follow', 'publish', 'join_group']);
});

test('join_group 穿透清洗后仍在（漏加键的症状是「云端发了、界面不显示、没有任何报错」）', () => {
  const out = normalizeDailyUsage({ asOf: Date.now(), totals: FB_TOTALS });
  assert.ok(out);
  assert.equal(out.totals.join_group, 2, '加群计数必须活着走到渲染层');
});

test('缺席的键 MUST NOT 被物化成 0（这是「云端摘掉 → 客户端抹平回 0」那半个白做的 change）', () => {
  const out = normalizeDailyUsage({ asOf: Date.now(), totals: FB_TOTALS });
  assert.ok(out);
  assert.ok(!('collect' in out.totals), 'collect 缺席 = FB 没有收藏这个概念，必须保持缺席');
  assert.ok(!('follow' in out.totals), 'follow 缺席同理');
  assert.deepEqual(out.totals, FB_TOTALS);
});

test('供给的 0 是真实观测、必须留下（与「缺席」是两件事）', () => {
  const out = normalizeDailyUsage({ asOf: Date.now(), totals: { view: 0 } });
  assert.ok(out);
  assert.ok('view' in out.totals, '0 = 今天还没浏览，必须照显');
  assert.equal(out.totals.view, 0);
});

test('乐观累加 MUST NOT 把云端摘掉的键建回来（症状是收藏格闪回，≤60s 后又消失）', () => {
  const usage = normalizeDailyUsage({ asOf: Date.now(), totals: FB_TOTALS });
  const bumped = bumpDailyUsage(usage, 'like', 1);
  assert.ok(bumped);
  assert.equal(bumped.totals.like, 4, '点赞照常 +1');
  assert.ok(!('collect' in bumped.totals), '收藏 MUST NOT 被 like 事件顺手物化回来');
  assert.ok(!('follow' in bumped.totals), 'follow 同理');
});

test('乐观累加对「云端没给的那个动作本身」是 no-op，不新建键', () => {
  const usage = normalizeDailyUsage({ asOf: Date.now(), totals: FB_TOTALS });
  const bumped = bumpDailyUsage(usage, 'collect', 1);
  assert.ok(bumped);
  assert.ok(!('collect' in bumped.totals), 'FB 不可能真收藏；即使来了这种事件也绝不凭空造一格');
});

test('cleanSuppliedCounts：非数字 / 非法值当缺席，负数夹到 0', () => {
  assert.deepEqual(cleanSuppliedCounts({ view: 5, like: 'x', comment: NaN, follow: -3 }), { view: 5, follow: 0 });
  assert.deepEqual(cleanSuppliedCounts(null), {});
});
