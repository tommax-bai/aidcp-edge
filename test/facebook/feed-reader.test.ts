import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookFeedReader, parseFacebookCount } from '../../src/facebook/feed-reader.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { OverlayMonitor } from '../../src/browse/overlay-monitor.js';

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
    {
      hydrated: true,
      author: 'Josi',
      textPreview: 'Spiaggia libera',
      reactionText: '1.2K',
      permalinkHrefs: ['https://www.facebook.com/watch/?v=4525277067786120&notif_id=123&ref=watch_permalink'],
      hasVideo: true,
    },
    { hydrated: true, author: 'NoLink', permalinkHrefs: [] }, // 无可开链接 → 跳过（诚实）
    { hydrated: true, author: 'Dup', permalinkHrefs: ['https://www.facebook.com/alice/posts/pfbid0ABC'] }, // 同 permalink → 去重
  ]);
  const reader = new FacebookFeedReader({ cdp, sleep: async () => {} });
  const cards = await reader.scanCards();

  assert.equal(cards.length, 3, '只保留已水合、带 permalink、去重后的卡片，含 watch 视频帖');
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

  const watch = cards[2];
  assert.equal(watch.author, 'Josi');
  assert.equal(watch.noteId, 'https://www.facebook.com/watch?v=4525277067786120', 'watch 视频帖只保留 v 参数');
  assert.equal(watch.reactionCount, 1200);
  assert.equal(watch.isVideo, true);
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

test('fb-feed: 默认滚动走 650px 多帧手势，wheel 生效后不再补 scrollBy', async () => {
  let scrollY = 0;
  const wheels: Array<Record<string, unknown>> = [];
  let fallbackCalls = 0;
  const cdp: BrowseCdp = {
    send: async (method, params: Record<string, unknown> = {}) => {
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mouseWheel') {
          wheels.push(params);
          scrollY += Number(params.deltaY);
        }
        return {} as never;
      }
      if (method !== 'Runtime.evaluate') return {} as never;
      const expression = String(params.expression ?? '');
      if (expression.includes('window.scrollBy')) {
        fallbackCalls += 1;
        return { result: { value: true } } as never;
      }
      if (expression.includes('window.innerWidth')) {
        return { result: { value: JSON.stringify({ w: 1280, h: 800 }) } } as never;
      }
      if (expression.includes('window.scrollY')) {
        return { result: { value: JSON.stringify({ y: scrollY }) } } as never;
      }
      return { result: { value: JSON.stringify(true) } } as never;
    },
  };
  const reader = new FacebookFeedReader({ cdp, random: () => 0.5, sleep: async () => {} });
  await reader.scrollNext();

  assert.ok(wheels.length >= 8 && wheels.length <= 15, `wheel 帧数 ${wheels.length}`);
  assert.equal(wheels.reduce((sum, wheel) => sum + Number(wheel.deltaY), 0), 650);
  assert.equal(fallbackCalls, 0);
});

// ─────────────────────────── 幂等 ensureFeed（Q4）───────────────────────────

/** SURFACE_PROBE 返回预置 surface；记录 Page.navigate 调用；其它 evaluate 返回 false。 */
function surfaceCdp(
  surface: { href: string; hasFeed: boolean; hydratedArticles: number; dialogOpen: boolean },
  navs: string[],
): BrowseCdp {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.navigate') {
        navs.push(String(params?.url ?? ''));
        return {} as never;
      }
      if (method !== 'Runtime.evaluate') return {} as never;
      const e = String(params?.expression ?? '');
      if (e.includes('dialogOpen')) return { result: { value: JSON.stringify(surface) } } as never;
      return { result: { value: JSON.stringify(false) } } as never;
    },
  };
}

test('ensureFeed 幂等：已在首页且有 feed、无 dialog → 不导航', async () => {
  const navs: string[] = [];
  const reader = new FacebookFeedReader({
    cdp: surfaceCdp({ href: 'https://www.facebook.com/', hasFeed: true, hydratedArticles: 2, dialogOpen: false }, navs),
    sleep: async () => {},
  });
  const r = await reader.ensureFeed('https://www.facebook.com/');
  assert.equal(r.ok, true);
  assert.deepEqual(navs, [], '已在首页不重新导航（消掉滚动重置回归）');
});

test('ensureFeed 幂等：已在首页有 feed、但挂着瞬时/良性 dialog → 仍不导航（不因良性浮层整页重载）', async () => {
  // 真机根因：FB 首页常挂瞬时 [role=dialog]（聊天弹窗/加载态/通知提示），旧判据「有 dialog 就判非目标→整页导航」
  // 导致每条 scroll 命令都整页重载、feed 被钉回第一屏（timeOrigin 每 ~8s 重置）。既在正确列表面且 feed 在场即为在目标。
  const navs: string[] = [];
  const reader = new FacebookFeedReader({
    cdp: surfaceCdp({ href: 'https://www.facebook.com/', hasFeed: true, hydratedArticles: 3, dialogOpen: true }, navs),
    sleep: async () => {},
  });
  const r = await reader.ensureFeed('https://www.facebook.com/');
  assert.equal(r.ok, true);
  assert.deepEqual(navs, [], '良性 dialog 不触发整页重载（消掉「一直刷新」churn）');
});

test('ensureFeed 幂等：在详情页（page_post）→ 导航回目标 feed', async () => {
  const navs: string[] = [];
  const reader = new FacebookFeedReader({
    cdp: surfaceCdp({ href: 'https://www.facebook.com/x/posts/pfbid0Z', hasFeed: false, hydratedArticles: 0, dialogOpen: false }, navs),
    sleep: async () => {},
  });
  const r = await reader.ensureFeed('https://www.facebook.com/');
  assert.equal(r.ok, true);
  assert.deepEqual(navs, ['https://www.facebook.com/']);
});

test('ensureFeed 幂等：搜索页放行搜索、不被带回首页', async () => {
  const navs: string[] = [];
  const searchUrl = 'https://www.facebook.com/search/posts/?q=Puerto+Rico';
  const reader = new FacebookFeedReader({
    cdp: surfaceCdp({ href: searchUrl, hasFeed: true, hydratedArticles: 1, dialogOpen: false }, navs),
    sleep: async () => {},
  });
  const r = await reader.ensureFeed(searchUrl);
  assert.equal(r.ok, true);
  assert.deepEqual(navs, [], '搜索页 surface 匹配则不导航');
});

test('ensureFeed 红线：已在首页但验证码浮层在 → blocked_by_captcha 且不导航（fail-closed 不因省导航而漏）', async () => {
  const navs: string[] = [];
  const overlayMonitor = { probeNow: async () => 'captcha' } as unknown as OverlayMonitor;
  const reader = new FacebookFeedReader({
    cdp: surfaceCdp({ href: 'https://www.facebook.com/', hasFeed: true, hydratedArticles: 1, dialogOpen: false }, navs),
    overlayMonitor,
    sleep: async () => {},
  });
  const r = await reader.ensureFeed('https://www.facebook.com/');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked_by_captcha');
  assert.deepEqual(navs, [], '不导航路径仍复检验证码');
});

// ─────────────────────────── loading-aware 累积判稳（Q1）───────────────────────────

const RAW_ABC = {
  hydrated: true,
  author: 'Alice',
  textPreview: 'hi',
  reactionText: null,
  permalinkHrefs: ['https://www.facebook.com/alice/posts/pfbid0ABC'],
  hasVideo: false,
};
const NOTE_ABC = 'https://www.facebook.com/alice/posts/pfbid0ABC';

/** 按轮脚本化 scanCards（permalinkHrefs）与 loading（progressbar）；loading 调用后进入下一轮。 */
function settleCdp(rounds: Array<{ scan: unknown[]; loading: boolean }>): BrowseCdp {
  let round = 0;
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const e = String(params?.expression ?? '');
      const r = rounds[Math.min(round, rounds.length - 1)];
      if (e.includes('permalinkHrefs')) return { result: { value: JSON.stringify(r.scan) } } as never;
      if (e.includes('progressbar')) {
        const loading = r.loading;
        round++;
        return { result: { value: JSON.stringify(loading) } } as never;
      }
      return { result: { value: JSON.stringify(false) } } as never;
    },
  };
}

test('settleCards：集合连续两轮相等且无 loading 才上报（loading 是单向继续等否决票）', async () => {
  const reader = new FacebookFeedReader({
    cdp: settleCdp([
      { scan: [RAW_ABC], loading: true }, // 有卡但 loading → 等
      { scan: [RAW_ABC], loading: true }, // 集合已稳但仍 loading → 继续等
      { scan: [RAW_ABC], loading: false }, // 稳 + 无 loading → 上报
    ]),
    sleep: async () => {},
  });
  const r = await reader.settleCards({ wallClockMs: 6_000, roundMs: 100 });
  assert.equal(r.degraded, false);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].noteId, NOTE_ABC);
});

test('settleCards：触达 wall-clock 仍 loading 但有真卡 → 照实上报 + degraded（非假成功）', async () => {
  const reader = new FacebookFeedReader({
    cdp: settleCdp([{ scan: [RAW_ABC], loading: true }]),
    sleep: async () => {},
  });
  const r = await reader.settleCards({ wallClockMs: 200, roundMs: 100 }); // maxRounds=2
  assert.equal(r.degraded, true);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].noteId, NOTE_ABC);
});

test('settleCards：触达上限 0 卡 + 仍 loading → feed_still_loading 可重试（不报空批）', async () => {
  const reader = new FacebookFeedReader({
    cdp: settleCdp([{ scan: [], loading: true }]),
    sleep: async () => {},
  });
  const r = await reader.settleCards({ wallClockMs: 200, roundMs: 100 });
  assert.equal(r.cards.length, 0);
  assert.equal(r.reason, 'feed_still_loading');
});

test('settleCards：触达上限 0 真卡（只有空壳）+ 无 loading → no_feed（空壳绝不当卡）', async () => {
  const reader = new FacebookFeedReader({
    cdp: settleCdp([{ scan: [{ hydrated: false }], loading: false }]),
    sleep: async () => {},
  });
  const r = await reader.settleCards({ wallClockMs: 200, roundMs: 100 });
  assert.equal(r.cards.length, 0);
  assert.equal(r.reason, 'no_feed');
});

// ─────────────────────────── 首页图标点击换批（Q3）───────────────────────────

test('clickHomeAndScrollTop：找到首页锚点 → ok；找不到 → no_home_link', async () => {
  const okReader = new FacebookFeedReader({
    cdp: { send: async () => ({ result: { value: JSON.stringify({ ok: true }) } }) } as unknown as BrowseCdp,
    sleep: async () => {},
  });
  assert.deepEqual(await okReader.clickHomeAndScrollTop(), { ok: true });

  const noReader = new FacebookFeedReader({
    cdp: { send: async () => ({ result: { value: JSON.stringify({ ok: false, reason: 'no_home_link' }) } }) } as unknown as BrowseCdp,
    sleep: async () => {},
  });
  assert.deepEqual(await noReader.clickHomeAndScrollTop(), { ok: false, reason: 'no_home_link' });
});
