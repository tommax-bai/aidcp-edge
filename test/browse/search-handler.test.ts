import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSearch, applySearchFilters } from '../../src/browse/search-handler.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

function fakeCdp(handler: (method: string, params: Record<string, unknown>) => unknown): {
  cdp: BrowseCdp;
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const cdp: BrowseCdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return handler(method, params) as never;
    },
  };
  return { cdp, calls };
}

test('executeSearch: 聚焦 → 逐字符输入 → 回车', async () => {
  const { cdp, calls } = fakeCdp((method) => {
    if (method === 'Runtime.evaluate') return { result: { value: true } };
    return {};
  });
  await executeSearch('奶茶', { cdp, sleep: async () => {}, random: () => 0.5 });

  // 逐字符拟人化输入：每个字符一次 Input.insertText，拼接应等于关键词
  const inserts = calls.filter((c) => c.method === 'Input.insertText');
  assert.equal(inserts.length, 2, '逐字符输入「奶茶」应为 2 次');
  assert.equal(inserts.map((c) => c.params.text).join(''), '奶茶');

  const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
  assert.ok(keys.some((k) => k.params.key === 'Enter'));
});

test('executeSearch: 搜索框未找到时抛错', async () => {
  const { cdp } = fakeCdp((method) => {
    if (method === 'Runtime.evaluate') return { result: { value: false } };
    return {};
  });
  await assert.rejects(
    () => executeSearch('奶茶', { cdp, sleep: async () => {} }),
    /搜索框未找到/,
  );
});

test('applySearchFilters: 控件存在（找到文案坐标）→ 排序+时间都点到、返回 applied', async () => {
  const { cdp, calls } = fakeCdp((method) => {
    if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ x: 120, y: 60 }) } };
    return {};
  });
  const r = await applySearchFilters(
    { sort: 'most_collected', timeWindow: 'one_day' },
    { cdp, sleep: async () => {}, random: () => 0.5 },
  );
  assert.equal(r.sortApplied, true);
  assert.equal(r.timeApplied, true);
  assert.ok(calls.some((c) => c.method === 'Input.dispatchMouseEvent'), '应有拟人化点击派发');
});

test('applySearchFilters: 控件找不到（坐标 null）→ honest applied=false（不假点）', async () => {
  const { cdp } = fakeCdp((method) => {
    if (method === 'Runtime.evaluate') return { result: { value: null } };
    return {};
  });
  const r = await applySearchFilters(
    { sort: 'most_collected', timeWindow: 'one_day' },
    { cdp, sleep: async () => {}, random: () => 0.5 },
  );
  assert.equal(r.sortApplied, false);
  assert.equal(r.timeApplied, false);
});

test('applySearchFilters: 时间项藏在 hover 展开的「筛选」面板内 → hover 展开(不 click 筛选)后点时间项，honest applied=true', async () => {
  // 场景：排序 tab 行内可点（pass1 命中）；「一天内」只有在「筛选」被 hover 展开后才可见。
  // 回归红线：pass2 必须 hover「筛选」把面板展开，绝不 click「筛选」本体（老 bug：hover 开→click 又收→时间项永远点不到）。
  let filterHovered = false;
  const { cdp, calls } = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('筛选')) {
        filterHovered = true; // 一旦定位/hover 过「筛选」，面板展开、时间项转为可见
        return { result: { value: JSON.stringify({ x: 200, y: 40 }) } };
      }
      if (expr.includes('最多收藏')) return { result: { value: JSON.stringify({ x: 120, y: 40 }) } };
      if (expr.includes('一天内')) return { result: { value: filterHovered ? JSON.stringify({ x: 210, y: 130 }) : null } };
      return { result: { value: null } };
    }
    return {};
  });
  const r = await applySearchFilters(
    { sort: 'most_collected', timeWindow: 'one_day' },
    { cdp, sleep: async () => {}, random: () => 0.5 },
  );
  assert.equal(r.sortApplied, true);
  assert.equal(r.timeApplied, true, '时间项应在 hover 展开面板后被点到');

  const presses = calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  assert.equal(presses.length, 2, '只应有「排序 tab + 时间项」两次点击——「筛选」靠 hover 展开、不 click（老 bug 会多一次 click 筛选）');
  const onFilter = presses.filter((p) => Math.abs(Number(p.params.x) - 200) < 8 && Math.abs(Number(p.params.y) - 40) < 8);
  assert.equal(onFilter.length, 0, '绝不 click「筛选」控件本体（避免 hover 开→click 又收起面板）');
});

test('applySearchFilters: 无 sort/timeWindow → no-op，不评估页面', async () => {
  const { cdp, calls } = fakeCdp(() => ({ result: { value: null } }));
  const r = await applySearchFilters({}, { cdp, sleep: async () => {} });
  assert.deepEqual(r, { sortApplied: false, timeApplied: false });
  assert.equal(calls.length, 0);
});
