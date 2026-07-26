import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  canonicalFacebookFeedVideoPostId,
  canonicalFacebookReelPostId,
  canonicalPostId,
  FB_TARGET_HELPERS_JS,
  POST_IDENTITY_JS,
} from '../../src/facebook/post-identity.js';
import {
  canonicalFacebookFeedVideoPostId as coreCanonicalFacebookFeedVideoPostId,
  canonicalFacebookReelPostId as coreCanonicalFacebookReelPostId,
  canonicalPostId as coreCanonicalPostId,
  POST_IDENTITY_JS as CORE_POST_IDENTITY_JS,
} from '../../src/facebook/post-identity-core.js';

/**
 * 规范帖子身份 `fb:<postId>`（change facebook-note-scoped-targeting）。
 *
 * 核心不变量：
 *  - 同一帖的**多种链接形态**派生同一个 id（posts / multi_permalinks / permalink.php / videos vs watch）。
 *  - 同群**不同帖**派生**不同** id（旧 postKey 丢 multi_permalinks → 撞键 → 详情页也会锁错卡）。
 *  - 派生失败返回 **null**（不是空串——空串对任何坏 href 都相等，会让「匹配不到」退化成「点第一张卡」）。
 *  - 评论 permalink（带 comment_id）不是帖身份；**作者主页 / 图片链接也不是**（形状白名单）。
 */

test('post-identity compatibility façade re-exports the production-safe implementations', () => {
  assert.equal(canonicalPostId, coreCanonicalPostId);
  assert.equal(canonicalFacebookReelPostId, coreCanonicalFacebookReelPostId);
  assert.equal(canonicalFacebookFeedVideoPostId, coreCanonicalFacebookFeedVideoPostId);
  assert.equal(POST_IDENTITY_JS, CORE_POST_IDENTITY_JS);
});

test('canonicalPostId: 群帖 posts 形态与 multi_permalinks 形态是同一帖（一帖多形态）', () => {
  const viaPosts = canonicalPostId('https://www.facebook.com/groups/1109299026882957/posts/1769888790823974/');
  const viaMulti = canonicalPostId(
    'https://www.facebook.com/groups/1109299026882957/?multi_permalinks=1769888790823974&__cft__[0]=SECRET&__tn__=%2CO',
  );
  assert.equal(viaPosts, 'fb:1769888790823974');
  assert.equal(viaMulti, viaPosts, '同一帖的两种链接形态必须派生同一身份');
});

test('canonicalPostId: 同群两个 multi_permalinks 帖不撞键（旧 postKey 会撞 → 详情页锁错卡）', () => {
  const a = canonicalPostId('https://www.facebook.com/groups/111/?multi_permalinks=1001');
  const b = canonicalPostId('https://www.facebook.com/groups/111/?multi_permalinks=1002');
  assert.ok(a && b);
  assert.notEqual(a, b, '同群两个 multi_permalinks 帖必须是两个身份');
});

test('canonicalPostId: 主页帖 posts 形态与 permalink.php 形态是同一帖', () => {
  const viaPosts = canonicalPostId('https://www.facebook.com/100064860875397/posts/833823022640243/');
  const viaPermalink = canonicalPostId('https://www.facebook.com/permalink.php?story_fbid=833823022640243&id=100064860875397');
  assert.equal(viaPosts, 'fb:833823022640243');
  assert.equal(viaPermalink, viaPosts);
});

test('canonicalPostId: pfbid / reel / watch / videos 也可派生（视频帖同样是 feed 卡，不派生=砍掉点赞能力）', () => {
  assert.equal(
    canonicalPostId('https://www.facebook.com/lai.oifong.7/posts/pfbid02jYCajznmdpP7ypC1LSUqoz?__cft__[0]=x'),
    'fb:pfbid02jYCajznmdpP7ypC1LSUqoz',
  );
  assert.equal(canonicalPostId('https://www.facebook.com/reel/1234567890/'), 'fb:1234567890');
  assert.equal(canonicalPostId('https://www.facebook.com/watch/?v=4525277067786120&ref=watch_permalink'), 'fb:4525277067786120');
  // 同一条视频帖的两种形态收敛到同一身份（身份不含 container，就没有「主页 slug vs 主页数字 id」这种同帖两身份）。
  assert.equal(canonicalPostId('https://www.facebook.com/Meta/videos/999/'), 'fb:999');
  assert.equal(canonicalPostId('https://www.facebook.com/watch/?v=999'), 'fb:999');
});

test('canonicalFacebookReelPostId: 只接受精确 Facebook Reel 身份', () => {
  assert.equal(canonicalFacebookReelPostId('https://www.facebook.com/reel/1234567890/'), 'fb:1234567890');
  for (const uncanonical of [
    'https://evil.example/reel/1234567890',
    'https://www.facebook.com/reel/hashtag',
    'https://www.facebook.com/reel/audio',
    'https://www.facebook.com/reel/music',
    'https://www.facebook.com/reel/topics',
    'https://www.facebook.com/reel/1234567890?ref=share',
    'https://www.facebook.com/Example/posts/1234567890',
  ]) {
    assert.equal(canonicalFacebookReelPostId(uncanonical), null, uncanonical);
  }
});

test('canonicalPostId: 坏 href / 非帖链接 → null（绝不返回空串）', () => {
  for (const bad of [
    'javascript:void(0)',
    '#',
    '',
    '   ',
    'https://www.facebook.com/lai.oifong.7/', // 作者主页链接
    'https://www.facebook.com/groups/111/', // 群主页链接
    'https://www.facebook.com/profile.php?id=100000123456789', // 个人主页
    'not a url at all ///',
  ]) {
    assert.equal(canonicalPostId(bad), null, `坏/非帖链接必须 null：${bad}`);
  }
  assert.equal(canonicalPostId(null), null);
  assert.equal(canonicalPostId(undefined), null);
});

test('canonicalPostId: 评论 permalink（comment_id / reply_comment_id）不是帖身份 → null', () => {
  assert.equal(canonicalPostId('https://www.facebook.com/groups/111/posts/222/?comment_id=333'), null);
  assert.equal(canonicalPostId('https://www.facebook.com/groups/111/posts/222/?comment_id=333&reply_comment_id=444'), null);
});

test('canonicalPostId: postId 大小写敏感（pfbid 是 base62）', () => {
  assert.notEqual(canonicalPostId('https://www.facebook.com/g/posts/pfbidAA'), canonicalPostId('https://www.facebook.com/g/posts/pfbidaa'));
});

/**
 * 【对抗性评审复现的能力杀手】FB 卡头 DOM 序是「头像链接 → 作者名链接 → 时间戳 permalink」。
 * 2022 后无自定义用户名的账号，其主页链接形态是 `/people/<slug>/pfbid…/`——若身份派生只看「路径里有 pfbid 段」，
 * 作者链接就会**抢在**时间戳 permalink 之前派生出一个 id，卡身份变成「作者身份」→ 该作者的每张卡永久解析不到目标
 * （点赞 no_target、评论 editor_not_found，确定性、每次都失败）。形状白名单必须把这类链接判成 null。
 */
test('canonicalPostId: 作者主页 / 图片 等非帖形状链接 → null（绝不把作者身份当帖身份）', () => {
  for (const authorish of [
    'https://www.facebook.com/people/Nguyen-Van-A/pfbid02Xk9aBcDeF/',
    'https://www.facebook.com/alice/photos/pfbid02abc/123456/',
    'https://www.facebook.com/photo/?fbid=123&set=a.456',
    'https://www.facebook.com/groups/111/members',
    'https://www.facebook.com/groups/111/user/100000123/',
  ]) {
    assert.equal(canonicalPostId(authorish), null, `非帖形状必须 null：${authorish}`);
  }
  // 而同一张卡上的时间戳 permalink 照常派生。
  assert.equal(canonicalPostId('https://www.facebook.com/groups/111/posts/pfbid0POST/'), 'fb:pfbid0POST');
});

test('canonicalPostId: 主页帖的 vanity 形态与 permalink.php 形态收敛到同一身份（身份不含 container）', () => {
  // 旧口径 fb:<container>:<postId> 会把 fb:meta:X 与 fb:100064860875397:X 判成两帖 → 确定性 no_target。
  assert.equal(
    canonicalPostId('https://www.facebook.com/Meta/posts/pfbid02abc/'),
    canonicalPostId('https://www.facebook.com/permalink.php?story_fbid=pfbid02abc&id=100064860875397'),
  );
});

/**
 * 单一实现守卫：页内注入的 `fbCanonicalPostId` 就是 TS 的 `canonicalPostId` 本体（toString 注入）。
 * 若有人在函数体里引用了模块作用域标识符（import 的常量/正则），页内会 ReferenceError 或行为漂移——
 * 本用例当场炸掉；否则「页内派生不出身份」会静默退化成 no_target，谁也不会发现。
 */
test('POST_IDENTITY_JS: 页内实现与 TS 实现逐条对拍（结构上不可能漂移）', () => {
  const inPage = new Function('href', `${POST_IDENTITY_JS} return fbCanonicalPostId(href);`) as (
    href: unknown,
  ) => string | null;
  const fixtures = [
    'https://www.facebook.com/groups/111/posts/222/',
    'https://www.facebook.com/groups/111/?multi_permalinks=222',
    'https://www.facebook.com/groups/111/permalink/222/',
    'https://www.facebook.com/permalink.php?story_fbid=222&id=111',
    'https://www.facebook.com/Meta/posts/833823022640243/#comments',
    'https://www.facebook.com/lai.oifong.7/posts/pfbid02jYCaj?__cft__[0]=x',
    'https://www.facebook.com/watch/?v=4525277067786120',
    'https://www.facebook.com/reel/123/',
    'https://www.facebook.com/groups/111/posts/222/?comment_id=333',
    'javascript:void(0)',
    '#',
    '',
    'https://www.facebook.com/lai.oifong.7/',
    'https://www.facebook.com/people/Nguyen-Van-A/pfbid02Xk9aBcDeF/',
    'https://www.facebook.com/alice/photos/pfbid02abc/123456/',
    '/groups/111/posts/222/', // 相对链接（DOM 里 getAttribute('href') 常是相对的）
  ];
  for (const href of fixtures) {
    assert.equal(inPage(href), canonicalPostId(href), `页内/Node 实现必须逐条一致：${href}`);
  }
});

test('FB_TARGET_HELPERS_JS: 相邻轻量视频按同一 data-video-id 精确解析，冲突卡不回落 DOM 序', () => {
  const card = (id: string, explicit = '') =>
    `<section id="card-${id}"><h4><a href="/author-${id}">Author ${id}</a></h4>${explicit}` +
    `<div data-ad-rendering-role="story_message">video ${id}</div><div data-video-id="${id}"><video></video></div>` +
    '<div role="button" aria-label="Thích"></div><div role="button" aria-label="Viết bình luận"></div></section>';
  const dom = new JSDOM(
    `<!doctype html><body><div role="feed">${card('101')}${card('202')}${card('303', '<a href="/watch/?v=999">time</a>')}</div></body>`,
    { runScripts: 'outside-only', url: 'https://www.facebook.com/' },
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() { return { left: 10, top: 100, right: 690, bottom: 500, width: 680, height: 400 }; },
  });
  const result = JSON.parse(String(dom.window.eval(`(function(){${FB_TARGET_HELPERS_JS}
    var one=fbTgtResolve('fb:101'), two=fbTgtResolve('fb:202'), mismatch=fbTgtResolve('fb:303');
    return JSON.stringify({one:one.status==='ok'?one.el.id:one.status,two:two.status==='ok'?two.el.id:two.status,mismatch:mismatch.status});
  })()`)));

  assert.deepEqual(result, { one: 'card-101', two: 'card-202', mismatch: 'no_target' });
});
