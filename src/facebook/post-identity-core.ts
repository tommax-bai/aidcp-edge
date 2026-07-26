/**
 * Production-safe Facebook post identity helpers.
 *
 * This module must stay free of DOM helpers and injected page-rule imports because
 * Native orchestration depends on it in the production distribution.
 */

/**
 * Derive the canonical `fb:<postId>` identity from a Facebook permalink.
 *
 * This function must remain self-contained: `POST_IDENTITY_JS` injects the same
 * implementation into the remaining development-only page helpers.
 */
export function canonicalPostId(href: string | null | undefined): string | null {
  const raw = String(href ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, 'https://www.facebook.com/');
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.searchParams.has('comment_id') || url.searchParams.has('reply_comment_id')) return null;

  const path = url.pathname;
  const lowerPath = path.toLowerCase();
  const postShaped =
    /\/posts\/[^/?#]+/.test(lowerPath) ||
    /\/permalink\/[^/?#]+/.test(lowerPath) ||
    /\/permalink\.php/.test(lowerPath) ||
    /\/story\.php/.test(lowerPath) ||
    /\/videos\/[^/?#]+/.test(lowerPath) ||
    /\/reel\/[^/?#]+/.test(lowerPath) ||
    ((lowerPath === '/watch' || lowerPath === '/watch/') && url.searchParams.has('v')) ||
    url.searchParams.has('story_fbid') ||
    url.searchParams.has('multi_permalinks');
  if (!postShaped) return null;

  const segs = path.split('/').filter(function (s) {
    return s.length > 0;
  });
  const lower = segs.map(function (s) {
    return s.toLowerCase();
  });

  let postId = '';
  const iPosts = lower.indexOf('posts');
  const iPermalink = lower.indexOf('permalink');
  if (iPosts >= 0 && segs[iPosts + 1]) postId = segs[iPosts + 1];
  else if (iPermalink >= 0 && segs[iPermalink + 1]) postId = segs[iPermalink + 1];
  else if (url.searchParams.get('story_fbid')) postId = String(url.searchParams.get('story_fbid'));
  else if (url.searchParams.get('multi_permalinks')) postId = String(url.searchParams.get('multi_permalinks'));
  if (!postId) {
    for (let i = 0; i < segs.length; i++) {
      if (/^pfbid[A-Za-z0-9]+$/.test(segs[i])) {
        postId = segs[i];
        break;
      }
    }
  }
  if (!postId) {
    const iVideos = lower.indexOf('videos');
    const iReel = lower.indexOf('reel');
    if (iVideos >= 0 && segs[iVideos + 1]) postId = segs[iVideos + 1];
    else if (iReel >= 0 && segs[iReel + 1]) postId = segs[iReel + 1];
    else if (lower[0] === 'watch' && url.searchParams.get('v')) postId = String(url.searchParams.get('v'));
  }
  if (!postId) return null;

  return 'fb:' + postId;
}

/** Only accepts the canonical identity emitted by the dedicated Reels reader. */
export function canonicalFacebookReelPostId(noteId: string | undefined): string | null {
  if (!noteId) return null;
  try {
    const url = new URL(noteId);
    const match = url.pathname.match(/^\/reel\/([^/?#]+)\/?$/i);
    if (
      url.protocol !== 'https:'
      || url.hostname.toLowerCase() !== 'www.facebook.com'
      || url.search
      || url.hash
      || !match
      || /^(?:hashtag|audio|music|topics?)$/i.test(match[1])
    ) {
      return null;
    }
    return canonicalPostId(noteId);
  } catch {
    return null;
  }
}

/**
 * A Feed-video presentation needs a stricter URL boundary than general post targeting.
 * Keep Reels and non-canonical query shapes out even when they can yield a post id.
 */
export function canonicalFacebookFeedVideoPostId(noteId: string | undefined): string | null {
  if (!noteId) return null;
  try {
    const url = new URL(noteId);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'www.facebook.com' || url.hash) return null;
    const path = url.pathname;
    if (/^\/reel\//i.test(path)) return null;
    if (/^\/watch\/?$/i.test(path)) {
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== 'v' || !/^\d+$/.test(url.searchParams.get('v') ?? '')) return null;
    } else if (
      /\/(?:videos|posts|permalink)\/[^/?#]+\/?$/i.test(path)
    ) {
      if (url.search) return null;
    } else if (/^\/(?:permalink|story)\.php$/i.test(path)) {
      const id = url.searchParams.get('story_fbid');
      if (!id || ![...url.searchParams.keys()].every((key) => key === 'story_fbid' || key === 'id')) return null;
    } else {
      const multi = url.searchParams.get('multi_permalinks');
      if (!multi || ![...url.searchParams.keys()].every((key) => key === 'multi_permalinks')) return null;
    }
    return canonicalPostId(noteId);
  } catch {
    return null;
  }
}

/** The in-page form uses the exact canonical parser implementation. */
export const POST_IDENTITY_JS = `var fbCanonicalPostId = ${canonicalPostId.toString()};`;
