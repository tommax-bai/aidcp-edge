import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookFeedReader, parseFacebookCount } from '../../src/facebook/feed-reader.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

/** CDP 桩：FEED_SCAN（含 permalinkHrefs）返回预置原始 article 数组。 */
function scanCdp(rawArticles: unknown[]): BrowseCdp {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params?.expression ?? '');
      if (expr.includes('permalinkHrefs')) {
        return { result: { value: JSON.stringify(rawArticles) } } as never;
      }
      return { result: { value: JSON.stringify(true) } } as never;
    },
  };
}

test('parseFacebookCount: 千分位/K/M/万/空/非数字', () => {
  assert.equal(parseFacebookCount('3,829'), 3829);
  assert.equal(parseFacebookCount('1.2K'), 1200);
  assert.equal(parseFacebookCount('3.4M'), 3_400_000);
  assert.equal(parseFacebookCount('1.2万'), 12000);
  assert.equal(parseFacebookCount('999'), 999);
  assert.equal(parseFacebookCount(''), 0);
  assert.equal(parseFacebookCount(null), 0);
  assert.equal(parseFacebookCount('赞'), 0);
});

test('fb-feed: 跳过未水合空壳 + 无 permalink 卡，映射字段，去重', async () => {
  const cdp = scanCdp([
    { hydrated: false }, // 虚拟化空壳 → 跳过
    {
      hydrated: true,
      author: 'Alice',
      textPreview: 'hello world',
      reactionText: '3,829',
      permalinkHrefs: ['https://www.facebook.com/alice/posts/pfbid0ABC?foo=1'],
      hasVideo: false,
    },
    {
      hydrated: true,
      author: 'Bob',
      textPreview: '',
      reactionText: null,
      permalinkHrefs: ['https://www.facebook.com/bob/posts/pfbid0XYZ'],
      hasVideo: true,
    },
    { hydrated: true, author: 'NoLink', permalinkHrefs: [] }, // 无可开链接 → 跳过（诚实）
    { hydrated: true, author: 'Dup', permalinkHrefs: ['https://www.facebook.com/alice/posts/pfbid0ABC'] }, // 同 permalink → 去重
  ]);
  const reader = new FacebookFeedReader({ cdp, sleep: async () => {} });
  const cards = await reader.scanCards();

  assert.equal(cards.length, 2, '只保留 2 张已水合、带 permalink、去重后的卡片');
  const alice = cards[0];
  assert.equal(alice.author, 'Alice');
  assert.equal(alice.textPreview, 'hello world');
  assert.equal(alice.reactionCount, 3829);
  assert.equal(alice.isVideo, false);
  assert.equal(alice.noteId, 'https://www.facebook.com/alice/posts/pfbid0ABC', 'permalink 规范化去 query');
  // FacebookFeedCard 无 collect 字段——绝不臆造收藏（FB 无收藏概念）。
  assert.ok(!('collectCount' in alice) && !('collect' in alice));

  const bob = cards[1];
  assert.equal(bob.reactionCount, 0, '反应数抓不到诚实置 0');
  assert.equal(bob.isVideo, true);
});

test('fb-feed: 扫描异常/非数组 → 空数组（绝不臆造卡片）', async () => {
  const cdp: BrowseCdp = {
    send: async () => {
      throw new Error('cdp boom');
    },
  };
  const reader = new FacebookFeedReader({ cdp, sleep: async () => {} });
  const cards = await reader.scanCards();
  assert.deepEqual(cards, []);
});
