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

/** 云端投影给 FB 的形状：无 collect；search、Reel follow 与 join_group 真实存在。 */
const FB_TOTALS = { view: 12, search: 0, like: 3, comment: 1, follow: 2, publish: 0, join_group: 2 };

test('键清单与 protocol.ts 的单一来源一致（本文件是纯 JS、typecheck 抓不到这条漂移）', () => {
  assert.deepEqual(DAILY_USAGE_ACTIONS, ['view', 'search', 'like', 'collect', 'comment', 'follow', 'publish', 'join_group']);
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
  assert.equal(out.totals.follow, 2, 'Reel 关注共用 follow 指标，必须保留');
  assert.deepEqual(out.totals, FB_TOTALS);
});

test('供给的 0 是真实观测、必须留下（与「缺席」是两件事）', () => {
  const out = normalizeDailyUsage({ asOf: Date.now(), totals: { view: 0, search: 0 } });
  assert.ok(out);
  assert.ok('view' in out.totals, '0 = 今天还没浏览，必须照显');
  assert.equal(out.totals.view, 0);
  assert.equal(out.totals.search, 0, 'Cloud 明确供给 0 次搜索时必须显示，不能当字段缺席');
});

test('search 在 daily alias 与四窗口逐位穿透，旧载荷缺键时不凭空补 0', () => {
  const out = normalizeDailyUsage({
    asOf: Date.now(),
    totals: { search: 2 },
    quotas: { search: 10 },
    saturated: [],
    windows: {
      session: { active: true, totals: { search: 1 }, quotas: { search: 3 }, saturated: [] },
      minute: { totals: { search: 1 }, quotas: { search: 1 }, saturated: ['search'] },
      hour: { totals: { search: 2 }, quotas: { search: 4 }, saturated: [] },
      day: { totals: { search: 2 }, quotas: { search: 10 }, saturated: [] },
    },
  });
  assert.ok(out);
  assert.equal(out.totals.search, 2);
  const windows = out.windows as Record<string, { totals: Record<string, number>; quotas: Record<string, number> }>;
  assert.equal(windows.session.totals.search, 1);
  assert.equal(windows.minute.quotas.search, 1);
  assert.equal(windows.hour.totals.search, 2);
  assert.equal(windows.day.quotas.search, 10);

  const legacy = normalizeDailyUsage({ asOf: Date.now(), totals: { view: 1 }, quotas: { view: 35 } });
  assert.ok(legacy);
  assert.ok(!('search' in legacy.totals));
});

test('乐观累加 MUST NOT 把云端摘掉的键建回来（症状是收藏格闪回，≤60s 后又消失）', () => {
  const usage = normalizeDailyUsage({ asOf: Date.now(), totals: FB_TOTALS });
  const bumped = bumpDailyUsage(usage, 'like', 1);
  assert.ok(bumped);
  assert.equal(bumped.totals.like, 4, '点赞照常 +1');
  assert.ok(!('collect' in bumped.totals), '收藏 MUST NOT 被 like 事件顺手物化回来');
  assert.equal(bumped.totals.follow, 2, '点赞事件不得改写关注计数');
});

test('已存在的 Reel 关注指标可由新关注成功事件即时 +1', () => {
  const usage = normalizeDailyUsage({ asOf: Date.now(), totals: FB_TOTALS });
  const bumped = bumpDailyUsage(usage, 'follow', 1);
  assert.ok(bumped);
  assert.equal(bumped.totals.follow, 3);
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
