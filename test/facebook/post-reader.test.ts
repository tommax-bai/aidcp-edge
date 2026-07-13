import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookPostReader, navigateFacebookPost } from '../../src/facebook/post-reader.js';
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

test('Facebook 详情：article 晚水合超过 8 轮仍等待并成功抽取', async () => {
  let structureReads = 0;
  const cdp = {
    send: async (method: string) => {
      if (method === 'Page.navigate') return {};
      structureReads++;
      if (structureReads <= 9) {
        return {
          result: {
            value: JSON.stringify({
              href: 'https://www.facebook.com/posts/pfbid123',
              articleCount: 0,
              commentEditorCount: 0,
              permalinkHrefs: [],
              postCandidates: [],
              membership: { joinVisible: false, joinedVisible: false, pendingVisible: false, questionVisible: false },
              virtualization: { viewportHeight: 900, scrollHeight: 900, articleCount: 0, likelyVirtualized: false },
            }),
          },
        };
      }
      if (structureReads === 10) {
        return {
          result: {
            value: JSON.stringify({
              href: 'https://www.facebook.com/posts/pfbid123',
              articleCount: 1,
              commentEditorCount: 0,
              permalinkHrefs: ['https://www.facebook.com/posts/pfbid123'],
              postCandidates: [],
              membership: { joinVisible: false, joinedVisible: false, pendingVisible: false, questionVisible: false },
              virtualization: { viewportHeight: 900, scrollHeight: 900, articleCount: 1, likelyVirtualized: false },
            }),
          },
        };
      }
      return {
        result: {
          value: JSON.stringify({
            body: 'late hydrated post',
            comments: [],
            reactionText: '赞 3',
            commentText: '评论 1',
            author: 'Author',
            isVideo: false,
          }),
        },
      };
    },
  } as unknown as BrowseCdp;

  const reader = new FacebookPostReader({ cdp, sleep: async () => {} });
  const result = await reader.openAndRead('https://www.facebook.com/posts/pfbid123');

  assert.equal(result.ok, true);
  assert.equal(result.body, 'late hydrated post');
  assert.equal(structureReads, 11);
});
