import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigateFacebookPost } from '../../src/facebook/post-reader.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

test('Facebook 详情：Page.navigate 超时后用 Runtime.evaluate 脚本导航兜底', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === 'Page.navigate') throw new Error('CDP 命令超时: Page.navigate');
      return {};
    },
  } as unknown as BrowseCdp;

  const result = await navigateFacebookPost(cdp, 'https://www.facebook.com/groups/demo/posts/pfbid123', (m) => logs.push(m));

  assert.equal(result, 'runtime.assign');
  assert.deepEqual(calls.map((c) => c.method), ['Page.navigate', 'Runtime.evaluate']);
  assert.match(String(calls[1].params.expression), /window\.location\.assign/);
  assert.ok(logs.some((m) => m.includes('脚本导航兜底已派发')));
});

test('Facebook 详情：两种导航都失败时仍诚实失败', async () => {
  const cdp = {
    send: async (method: string) => {
      throw new Error(`failed:${method}`);
    },
  } as unknown as BrowseCdp;

  await assert.rejects(
    navigateFacebookPost(cdp, 'https://www.facebook.com/posts/pfbid123'),
    /failed:Page\.navigate/,
  );
});
