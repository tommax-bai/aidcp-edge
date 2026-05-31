import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSearch } from '../../src/browse/search-handler.js';
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
