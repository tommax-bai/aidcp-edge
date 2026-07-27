import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFacebookPermalink,
  classifyFacebookSurface,
  collectFacebookPageStructure,
  normalizeFacebookPageStructure,
  sanitizeFacebookPermalinkHref,
} from '../../src/facebook/probes/page-structure.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

function fakeCdp(raw: unknown): BrowseCdp {
  return {
    send: async () => ({ result: { value: JSON.stringify(raw) } }) as never,
  };
}

const baseRaw = {
  href: 'https://www.facebook.com/groups/facepagerusers/posts/1234567890/',
  articleCount: 1,
  commentEditorCount: 1,
  permalinkHrefs: [
    '/groups/facepagerusers/posts/1234567890/',
    'https://www.facebook.com/groups/1109299026882957/?multi_permalinks=1769888790823974&hoisted_section_header_type=recently_seen&__cft__[0]=SECRET_CONTEXT&__tn__=%2CO%2CP-R',
    'https://www.facebook.com/search/posts/?q=links',
    'https://www.facebook.com/Meta/posts/833823022640243/',
  ],
  postCandidates: [{
    index: 0,
    role: 'article',
    textLength: 240,
    authorLinkCount: 2,
    commentEditorCount: 1,
    commentControlCount: 2,
    expandControlCount: 1,
    hasCommentRegion: true,
    top: 120,
    bottom: 760,
    permalinkHrefs: [
      '/groups/facepagerusers/posts/1234567890/',
      'https://www.facebook.com/Meta/posts/833823022640243/#',
    ],
  }],
  membership: {
    joinVisible: true,
    joinedVisible: false,
    pendingVisible: false,
    questionVisible: false,
  },
  virtualization: {
    viewportHeight: 932,
    scrollHeight: 3100,
    articleCount: 1,
    likelyVirtualized: true,
  },
};

test('classifyFacebookSurface: URL-first Page, Group, post, search, and blocking surfaces', () => {
  assert.equal(classifyFacebookSurface('https://www.facebook.com/groups/foo'), 'group');
  assert.equal(classifyFacebookSurface('https://www.facebook.com/groups/foo/posts/123/'), 'group_post');
  assert.equal(classifyFacebookSurface('https://www.facebook.com/groups/1/?multi_permalinks=2'), 'group_post');
  assert.equal(classifyFacebookSurface('https://www.facebook.com/Meta/posts/833823022640243/'), 'page_post');
  assert.equal(classifyFacebookSurface('https://www.facebook.com/watch/?v=4525277067786120&ref=watch_permalink'), 'page_post');
  assert.equal(classifyFacebookSurface('https://www.facebook.com/reel/1234567890/'), 'page_post');
  assert.equal(classifyFacebookSurface('https://www.facebook.com/search/posts/?q=x'), 'search');
  assert.equal(classifyFacebookSurface('https://www.facebook.com/login/?next=x'), 'login');
  assert.equal(classifyFacebookSurface('https://www.facebook.com/checkpoint/123'), 'checkpoint');
});

test('classifyFacebookPermalink: keeps only post-like permalink candidates', () => {
  assert.equal(classifyFacebookPermalink('https://www.facebook.com/groups/foo/posts/123/'), 'group_post');
  assert.equal(classifyFacebookPermalink('https://www.facebook.com/groups/1/?multi_permalinks=2'), 'group_post');
  assert.equal(classifyFacebookPermalink('https://www.facebook.com/Meta/posts/833823022640243/'), 'page_post');
  assert.equal(classifyFacebookPermalink('https://www.facebook.com/story.php?story_fbid=1&id=2'), 'story');
  assert.equal(classifyFacebookPermalink('https://www.facebook.com/watch/?v=4525277067786120&ref=watch_permalink'), 'page_post');
  assert.equal(classifyFacebookPermalink('https://www.facebook.com/reel/1234567890/'), 'page_post');
  assert.equal(classifyFacebookPermalink('https://www.facebook.com/search/posts/?q=x'), 'unknown');
});

test('sanitizeFacebookPermalinkHref: strips tracking query and hash data', () => {
  assert.equal(
    sanitizeFacebookPermalinkHref('https://www.facebook.com/groups/1109299026882957/?multi_permalinks=1769888790823974&__cft__[0]=SECRET_CONTEXT&__tn__=%2CO%2CP-R'),
    'https://www.facebook.com/groups/1109299026882957?multi_permalinks=1769888790823974',
  );
  assert.equal(
    sanitizeFacebookPermalinkHref('https://www.facebook.com/Meta/posts/833823022640243/#comments'),
    'https://www.facebook.com/Meta/posts/833823022640243',
  );
  assert.equal(
    sanitizeFacebookPermalinkHref('https://www.facebook.com/watch/?v=4525277067786120&notif_id=123&ref=watch_permalink'),
    'https://www.facebook.com/watch?v=4525277067786120',
  );
});

test('normalizeFacebookPageStructure: summarizes structure without raw post text or tracking URLs', () => {
  const summary = normalizeFacebookPageStructure(baseRaw);
  const serialized = JSON.stringify(summary);
  assert.equal(summary.surface, 'group_post');
  assert.equal(summary.articleCount, 1);
  assert.equal(summary.commentEditorCount, 1);
  assert.equal(summary.membership.joinVisible, true);
  assert.equal(summary.virtualization.likelyVirtualized, true);
  assert.deepEqual(summary.permalinkCandidates.map((c) => c.kind), ['group_post', 'group_post', 'page_post']);
  assert.equal(summary.postCandidates[0].hasCommentRegion, true);
  assert.equal(summary.postCandidates[0].expandControlCount, 1);
  assert.equal(serialized.includes('real post body'), false);
  assert.equal(serialized.includes('permalinkHrefs'), false);
  assert.equal(serialized.includes('__cft__'), false);
  assert.equal(serialized.includes('SECRET_CONTEXT'), false);
});

test('normalizeFacebookPageStructure: accepts a React-recovered non-article group-post candidate', () => {
  const summary = normalizeFacebookPageStructure({
    ...baseRaw,
    href: 'https://www.facebook.com/groups/1707108103609680',
    articleCount: 0,
    postCandidates: [{
      index: 0,
      role: null,
      textLength: 516,
      authorLinkCount: 1,
      commentEditorCount: 1,
      commentControlCount: 1,
      expandControlCount: 0,
      hasCommentRegion: true,
      top: 47,
      bottom: 273,
      permalinkHrefs: [
        'https://www.facebook.com/groups/1707108103609680/posts/1733009847686172/?__cft__[0]=SECRET_CONTEXT#comments',
      ],
    }],
  });

  assert.equal(summary.postCandidates[0].role, null);
  assert.equal(summary.postCandidates[0].hasCommentRegion, true);
  assert.deepEqual(summary.postCandidates[0].permalinkCandidates, [{
    href: 'https://www.facebook.com/groups/1707108103609680/posts/1733009847686172',
    kind: 'group_post',
  }]);
});

test('collectFacebookPageStructure: parses CDP JSON and classifies current surface', async () => {
  const summary = await collectFacebookPageStructure(fakeCdp(baseRaw));
  assert.equal(summary.surface, 'group_post');
  assert.equal(summary.postCandidates[0].permalinkCandidates[0].kind, 'group_post');
});
