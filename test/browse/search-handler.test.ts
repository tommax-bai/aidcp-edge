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

// 诚实闸（change comment-search-nav-confirm）：executeSearch 返回「是否确认到达搜索结果页」。
// keyword 一致（change comment-keep-open-through-approval）：结果页 URL 的 keyword 参数须与本次词一致才认。
test('executeSearch: 确认导航到本次关键词的结果页（search_result_ai + keyword 一致）→ 返回 true', async () => {
  const { cdp } = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('location.href')) {
        // keyword=奶茶（编码）——与本次搜索词一致
        return { result: { value: 'https://www.xiaohongshu.com/search_result_ai?keyword=%E5%A5%B6%E8%8C%B6&source=web_explore_feed' } };
      }
      return { result: { value: true } };
    }
    return {};
  });
  const ok = await executeSearch('奶茶', { cdp, sleep: async () => {}, random: () => 0.5 });
  assert.equal(ok, true, '到达本次关键词的搜索结果页 MUST 返回 true');
});

// Bug C 守卫（change comment-keep-open-through-approval）：提交失败时浏览器赖在【旧关键词】结果页上，
// 只验页型会把旧页当本次成功、采错词的卡；keyword 不符 MUST 判未到达（诚实回 false）。
test('executeSearch: 停在旧关键词结果页（keyword 不符）→ 返回 false（关 Bug C）', async () => {
  const { cdp } = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('location.href')) {
        // 命令搜「奶茶」，却停在旧的「facebook外贸开发客户」结果页（真机实证的残留旧页）
        return { result: { value: 'https://www.xiaohongshu.com/search_result_ai?keyword=facebook%E5%A4%96%E8%B4%B8%E5%BC%80%E5%8F%91%E5%AE%A2%E6%88%B7' } };
      }
      if (expr.includes('getBoundingClientRect')) return { result: { value: null } }; // 提交按钮也定位不到 → 无从纠正
      return { result: { value: true } };
    }
    return {};
  });
  const ok = await executeSearch('奶茶', { cdp, sleep: async () => {}, random: () => 0.5 });
  assert.equal(ok, false, '停在旧关键词页 MUST 返回 false，绝不把旧页当本次搜索成功');
});

// 双重编码容错（真机 URL 观测到 keyword 双重编码 %25..）：解码后一致仍应认到达。
test('executeSearch: keyword 双重编码但解码后一致 → 返回 true', async () => {
  const { cdp } = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('location.href')) {
        // %25E5%25A5%25B6%25E8%258C%25B6 = 双重编码的「奶茶」
        return { result: { value: 'https://www.xiaohongshu.com/search_result_ai?keyword=%25E5%25A5%25B6%25E8%258C%25B6' } };
      }
      return { result: { value: true } };
    }
    return {};
  });
  const ok = await executeSearch('奶茶', { cdp, sleep: async () => {}, random: () => 0.5 });
  assert.equal(ok, true, '双重编码解码后与本次词一致 MUST 认到达');
});

test('executeSearch: 未确认导航（恒停 /explore、提交按钮找不到）→ 返回 false', async () => {
  const { cdp } = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('location.href')) {
        return { result: { value: 'https://www.xiaohongshu.com/explore' } };
      }
      if (expr.includes('getBoundingClientRect')) return { result: { value: null } }; // 提交按钮定位不到
      return { result: { value: true } }; // 搜索框可见 + 聚焦成功
    }
    return {};
  });
  const ok = await executeSearch('奶茶', { cdp, sleep: async () => {}, random: () => 0.5 });
  assert.equal(ok, false, '未跳转结果页（仍在 feed）MUST 返回 false，供调用方诚实回失败');
});

// ---------------------------------------------------------------------------
// applySearchFilters（task 5.4 重构：幂等应用 + 权威复核 + 有界重试，治「点击未提交的瞬态竞态」）
//
// 有状态页面桩：模拟真机行为——选项被真实按下（mousePressed 落在其坐标上）且「本次按下会提交」时才
// 进入已提交集合；提交信号 eval（体内含 commit-signals 标记）按已提交集合返回 {selected, trigger}，
// 触发器文案在任一项提交后由「筛选」翻成「已筛选」（真机法证 docs/xhs-layout-states.md §2.6.1）。
// ---------------------------------------------------------------------------

const POS: Record<string, { x: number; y: number }> = {
  最多收藏: { x: 120, y: 60 },
  一天内: { x: 210, y: 130 },
  筛选: { x: 300, y: 40 },
};

interface FilterPageModel {
  /** 该项第 nth 次被按下（1 起）是否真提交。默认恒 true。 */
  commitsOnPress?: (target: string, nth: number) => boolean;
  /** 选项是否要先 hover「筛选」触发器展开面板才可见（AI 搜索页形态）。默认 false=行内可见。 */
  optionsNeedPanel?: boolean;
  /** 预置已提交项（幂等场景）。 */
  preCommitted?: string[];
  /** 「瞬时高亮」模型：被按过的项 selected 读数恒 true，即便从未提交（触发器不翻转）。默认 false。 */
  stickyHighlight?: boolean;
}

function filterPageFake(model: FilterPageModel = {}) {
  const committed = new Set<string>(model.preCommitted ?? []);
  const presses: Record<string, number> = {};
  let panelOpen = !model.optionsNeedPanel;
  const { cdp, calls } = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      // 提交信号 eval（须先于按文案定位的分支匹配——其体内也嵌有引号文案）
      if (expr.includes('commit-signals')) {
        const target = ['最多收藏', '一天内'].find((t) => expr.includes(`"${t}"`)) ?? '';
        const selected = committed.has(target) || (model.stickyHighlight === true && (presses[target] ?? 0) > 0);
        const trigger = committed.size > 0 ? '已筛选' : '筛选';
        return { result: { value: JSON.stringify({ selected, trigger }) } };
      }
      // 触发器定位（hover 展开面板）：一旦定位过「筛选」，面板展开、选项转可见
      if (expr.includes('"筛选"')) {
        panelOpen = true;
        return { result: { value: JSON.stringify(POS['筛选']) } };
      }
      // 选项定位：行内（默认）恒可见；AI 页形态须面板展开后可见
      for (const t of ['最多收藏', '一天内']) {
        if (expr.includes(`"${t}"`)) {
          return { result: { value: panelOpen ? JSON.stringify(POS[t]) : null } };
        }
      }
      return { result: { value: null } };
    }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
      for (const [t, p] of Object.entries(POS)) {
        if (Math.abs(Number(params.x) - p.x) < 10 && Math.abs(Number(params.y) - p.y) < 10) {
          presses[t] = (presses[t] ?? 0) + 1;
          if (t !== '筛选' && (model.commitsOnPress ?? (() => true))(t, presses[t])) committed.add(t);
        }
      }
    }
    return {};
  });
  return { cdp, calls, presses: () => ({ ...presses }), committed };
}

const RUN = { sleep: async () => {}, random: () => 0.5 };

test('applySearchFilters: 首点即提交 → 排序+时间各恰好 1 次点击、返回 applied（权威复核通过）', async () => {
  const page = filterPageFake({ optionsNeedPanel: true });
  const r = await applySearchFilters({ sort: 'most_collected', timeWindow: 'one_day' }, { cdp: page.cdp, ...RUN });
  assert.equal(r.sortApplied, true);
  assert.equal(r.timeApplied, true);
  const p = page.presses();
  assert.equal(p['最多收藏'] ?? 0, 1, '提交即止，不重复点');
  assert.equal(p['一天内'] ?? 0, 1, '提交即止，不重复点');
  assert.equal(p['筛选'] ?? 0, 0, '「筛选」靠 hover 展开、绝不 click（防 hover 开→click 又收的老 bug）');
});

test('applySearchFilters: 控件找不到（坐标 null）→ honest applied=false、零点击（不假点）', async () => {
  const { cdp, calls } = fakeCdp((method) => {
    if (method === 'Runtime.evaluate') return { result: { value: null } };
    return {};
  });
  const r = await applySearchFilters({ sort: 'most_collected', timeWindow: 'one_day' }, { cdp, ...RUN });
  assert.equal(r.sortApplied, false);
  assert.equal(r.timeApplied, false);
  const presses = calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  assert.equal(presses.length, 0, '定位不到→不盲点');
});

test('applySearchFilters: 点击从未提交（真根因场景）→ 每项重试上限 3 次点击后诚实 false', async () => {
  const page = filterPageFake({ optionsNeedPanel: true, commitsOnPress: () => false });
  const r = await applySearchFilters({ sort: 'most_collected', timeWindow: 'one_day' }, { cdp: page.cdp, ...RUN });
  assert.equal(r.sortApplied, false, '未提交→不冒充已筛');
  assert.equal(r.timeApplied, false, '未提交→不冒充已筛');
  const p = page.presses();
  assert.equal(p['最多收藏'], 3, '有界重试：每项恰好 3 次尝试、不机关枪连点');
  assert.equal(p['一天内'], 3, '有界重试：每项恰好 3 次尝试、不机关枪连点');
});

test('applySearchFilters: 假阳性守卫——瞬时高亮 selected=true 但触发器未翻「已筛选」→ 判未提交、返回 false', async () => {
  // 真机法证：未提交的点击只留 CSS 级瞬时高亮，触发器文案不变；只信 selected 会假阳性。
  const page = filterPageFake({ optionsNeedPanel: true, commitsOnPress: () => false, stickyHighlight: true });
  const r = await applySearchFilters({ sort: 'most_collected', timeWindow: 'one_day' }, { cdp: page.cdp, ...RUN });
  assert.equal(r.sortApplied, false, '高亮在身但全页无任何筛选真提交→绝不上报成功');
  assert.equal(r.timeApplied, false, '高亮在身但全页无任何筛选真提交→绝不上报成功');
});

test('applySearchFilters: 已提交（幂等前查命中）→ 零点击直接返回 true', async () => {
  const page = filterPageFake({ optionsNeedPanel: true, preCommitted: ['最多收藏', '一天内'] });
  const r = await applySearchFilters({ sort: 'most_collected', timeWindow: 'one_day' }, { cdp: page.cdp, ...RUN });
  assert.equal(r.sortApplied, true);
  assert.equal(r.timeApplied, true);
  const p = page.presses();
  assert.equal(p['最多收藏'] ?? 0, 0, '已选中→跳过不重复点（幂等）');
  assert.equal(p['一天内'] ?? 0, 0, '已选中→跳过不重复点（幂等）');
});

test('applySearchFilters: 首点被瞬态竞态吞掉、第 2 点提交 → 重试补上、返回 true', async () => {
  const page = filterPageFake({ optionsNeedPanel: true, commitsOnPress: (_t, nth) => nth >= 2 });
  const r = await applySearchFilters({ sort: 'most_collected', timeWindow: 'one_day' }, { cdp: page.cdp, ...RUN });
  assert.equal(r.sortApplied, true, '重试应把被吞的点击补上');
  assert.equal(r.timeApplied, true, '重试应把被吞的点击补上');
  const p = page.presses();
  assert.equal(p['最多收藏'], 2, '第 2 次提交后即止');
  assert.equal(p['一天内'], 2, '第 2 次提交后即止');
});

test('applySearchFilters: 行内 tab 布局（无「筛选」面板、无触发器）→ selected 即准、正常应用', async () => {
  // trigger=null 的布局（经典页行内排序 tab）：无触发器翻转信号可用，以持久 selected 为准。
  const committed = new Set<string>();
  const presses: Record<string, number> = {};
  const { cdp } = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('commit-signals')) {
        const target = ['最多收藏', '一天内'].find((t) => expr.includes(`"${t}"`)) ?? '';
        return { result: { value: JSON.stringify({ selected: committed.has(target), trigger: null }) } };
      }
      if (expr.includes('"筛选"')) return { result: { value: null } }; // 无触发器
      for (const t of ['最多收藏', '一天内']) {
        if (expr.includes(`"${t}"`)) return { result: { value: JSON.stringify(POS[t]) } };
      }
      return { result: { value: null } };
    }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
      for (const [t, p] of Object.entries(POS)) {
        if (t !== '筛选' && Math.abs(Number(params.x) - p.x) < 10 && Math.abs(Number(params.y) - p.y) < 10) {
          presses[t] = (presses[t] ?? 0) + 1;
          committed.add(t);
        }
      }
    }
    return {};
  });
  const r = await applySearchFilters({ sort: 'most_collected', timeWindow: 'one_day' }, { cdp, ...RUN });
  assert.equal(r.sortApplied, true);
  assert.equal(r.timeApplied, true);
  assert.equal(presses['最多收藏'], 1);
  assert.equal(presses['一天内'], 1);
});

test('applySearchFilters: 无 sort/timeWindow → no-op，不评估页面', async () => {
  const { cdp, calls } = fakeCdp(() => ({ result: { value: null } }));
  const r = await applySearchFilters({}, { cdp, sleep: async () => {} });
  assert.deepEqual(r, { sortApplied: false, timeApplied: false });
  assert.equal(calls.length, 0);
});

test('applySearchFilters: explicit default sort/timeWindow are no-op success and do not touch the page', async () => {
  const { cdp, calls } = fakeCdp(() => {
    throw new Error('default filters should not evaluate the page');
  });
  const r = await applySearchFilters(
    { sort: 'comprehensive', timeWindow: 'all' },
    { cdp, sleep: async () => {}, logger: () => {} },
  );
  assert.deepEqual(r, { sortApplied: true, timeApplied: true });
  assert.equal(calls.length, 0);
});
