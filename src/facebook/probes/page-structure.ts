import { evalRaw, type BrowseCdp } from '../../browse/cdp-util.js';

export type FacebookSurfaceType =
  | 'home'
  | 'page'
  | 'group'
  | 'group_post'
  | 'page_post'
  | 'search'
  | 'login'
  | 'checkpoint'
  | 'unknown';

export type FacebookPermalinkKind = 'group_post' | 'page_post' | 'story' | 'unknown';

export interface FacebookPermalinkCandidate {
  href: string;
  kind: FacebookPermalinkKind;
}

export interface FacebookPostStructureCandidate {
  index: number;
  role: string | null;
  textLength: number;
  authorLinkCount: number;
  commentEditorCount: number;
  commentControlCount: number;
  expandControlCount: number;
  hasCommentRegion: boolean;
  top: number;
  bottom: number;
  permalinkCandidates: FacebookPermalinkCandidate[];
}

export interface FacebookMembershipSignals {
  joinVisible: boolean;
  joinedVisible: boolean;
  pendingVisible: boolean;
  questionVisible: boolean;
}

export interface FacebookVirtualizationObservation {
  viewportHeight: number;
  scrollHeight: number;
  articleCount: number;
  likelyVirtualized: boolean;
}

export interface FacebookPageStructureSummary {
  href: string;
  surface: FacebookSurfaceType;
  articleCount: number;
  commentEditorCount: number;
  permalinkCandidates: FacebookPermalinkCandidate[];
  postCandidates: FacebookPostStructureCandidate[];
  membership: FacebookMembershipSignals;
  virtualization: FacebookVirtualizationObservation;
}

export function classifyFacebookSurface(href: string): FacebookSurfaceType {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return 'unknown';
  }
  const path = url.pathname.toLowerCase();
  if (path.includes('/checkpoint')) return 'checkpoint';
  if (path.includes('/login') || path.includes('/recover')) return 'login';
  if (path.startsWith('/search/')) return 'search';
  if (/^\/groups\/[^/]+\/posts\/[^/]+/.test(path) || (path.startsWith('/groups/') && url.searchParams.has('multi_permalinks'))) {
    return 'group_post';
  }
  if (path.startsWith('/groups/')) return 'group';
  if (/\/posts\/[^/]+/.test(path) || path.includes('/permalink.php') || url.searchParams.has('story_fbid')) return 'page_post';
  if (path === '/' || path === '/home.php') return 'home';
  if (path.split('/').filter(Boolean).length === 1) return 'page';
  return 'unknown';
}

export function classifyFacebookPermalink(href: string): FacebookPermalinkKind {
  try {
    const url = new URL(href, 'https://www.facebook.com/');
    const path = url.pathname.toLowerCase();
    if (/^\/groups\/[^/]+\/posts\/[^/]+/.test(path) || (path.startsWith('/groups/') && url.searchParams.has('multi_permalinks'))) {
      return 'group_post';
    }
    if (/\/posts\/[^/]+/.test(path) || path.includes('/permalink.php')) return 'page_post';
    if (url.searchParams.has('story_fbid')) return 'story';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function sanitizeFacebookPermalinkHref(href: string): string {
  const url = new URL(href, 'https://www.facebook.com/');
  const kind = classifyFacebookPermalink(url.href);
  const clean = new URL(url.origin + url.pathname);
  clean.hash = '';
  clean.pathname = clean.pathname.replace(/\/+$/, '') || '/';
  if (kind === 'group_post' && url.searchParams.has('multi_permalinks')) {
    clean.searchParams.set('multi_permalinks', url.searchParams.get('multi_permalinks') ?? '');
  } else if (kind === 'story') {
    if (url.searchParams.has('story_fbid')) clean.searchParams.set('story_fbid', url.searchParams.get('story_fbid') ?? '');
    if (url.searchParams.has('id')) clean.searchParams.set('id', url.searchParams.get('id') ?? '');
  } else if (url.pathname.toLowerCase().includes('/permalink.php')) {
    if (url.searchParams.has('story_fbid')) clean.searchParams.set('story_fbid', url.searchParams.get('story_fbid') ?? '');
    if (url.searchParams.has('id')) clean.searchParams.set('id', url.searchParams.get('id') ?? '');
  }
  return clean.href;
}

export function normalizeFacebookPermalinks(hrefs: string[]): FacebookPermalinkCandidate[] {
  const out: FacebookPermalinkCandidate[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    let normalized: string;
    let kind: FacebookPermalinkKind;
    try {
      const url = new URL(href, 'https://www.facebook.com/');
      kind = classifyFacebookPermalink(url.href);
      if (kind === 'unknown') continue;
      normalized = sanitizeFacebookPermalinkHref(url.href);
    } catch {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ href: normalized, kind });
  }
  return out;
}

const PAGE_STRUCTURE_SCAN_JS = String.raw`(function(){
  function visible(el){
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    var s = window.getComputedStyle ? getComputedStyle(el) : null;
    return r.width > 0 && r.height > 0 && (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01));
  }
  function text(el){ return String((el && el.innerText) || (el && el.textContent) || '').replace(/\s+/g, ' ').trim(); }
  function hrefOf(a){ try { return new URL(a.getAttribute('href') || a.href || '', location.href).href; } catch(e) { return ''; } }
  function isPermalink(h){
    return /\/groups\/[^/]+\/posts\/[^/?#]+/i.test(h) ||
      /\/posts\/[^/?#]+/i.test(h) ||
      /\/permalink\.php/i.test(h) ||
      /[?&](story_fbid|multi_permalinks)=/i.test(h);
  }
  function collectPermalinks(root){
    var links = [];
    var anchors = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
    for (var i = 0; i < anchors.length && links.length < 30; i++) {
      var h = hrefOf(anchors[i]);
      if (h && isPermalink(h)) links.push(h);
    }
    return Array.from(new Set(links));
  }
  function countTextControls(root, re){
    var n = 0;
    var nodes = root.querySelectorAll ? root.querySelectorAll('a,button,[role="button"],span,div') : [];
    for (var i = 0; i < nodes.length; i++) {
      if (visible(nodes[i]) && re.test(text(nodes[i]))) n++;
    }
    return n;
  }
  var articles = Array.from(document.querySelectorAll('[role="article"], article')).filter(visible).slice(0, 12);
  var postCandidates = articles.map(function(article, index){
    var box = article.getBoundingClientRect();
    var editors = Array.from(article.querySelectorAll('[contenteditable="true"][role="textbox"]')).filter(visible);
    var commentControls = countTextControls(article, /^(评论|发表评论|回复|Comment|Reply)$/i);
    var expandControls = countTextControls(article, /(查看更多|展开|See more|View more)/i);
    var commentRegion = article.querySelector('[aria-label*="评论"],[aria-label*="Comment"],[role="textbox"]');
    var authorLinks = Array.from(article.querySelectorAll('a[href]')).filter(function(a){
      var h = hrefOf(a);
      return visible(a) && h && !isPermalink(h) && text(a).length > 0;
    });
    return {
      index: index,
      role: article.getAttribute('role') || null,
      textLength: text(article).length,
      authorLinkCount: authorLinks.length,
      commentEditorCount: editors.length,
      commentControlCount: commentControls,
      expandControlCount: expandControls,
      hasCommentRegion: !!commentRegion,
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      permalinkHrefs: collectPermalinks(article)
    };
  });
  var bodyText = text(document.body);
  var hrefs = collectPermalinks(document).slice(0, 50);
  var editorCount = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).filter(visible).length;
  return JSON.stringify({
    href: location.href,
    articleCount: articles.length,
    commentEditorCount: editorCount,
    permalinkHrefs: hrefs,
    postCandidates: postCandidates,
    membership: {
      joinVisible: /(加入小组|Join group|\bJoin\b)/i.test(bodyText),
      joinedVisible: /(已加入|Joined)/i.test(bodyText),
      pendingVisible: /(待批准|Pending)/i.test(bodyText),
      questionVisible: /(回答问题|Answer questions)/i.test(bodyText)
    },
    virtualization: {
      viewportHeight: window.innerHeight || 0,
      scrollHeight: Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0),
      articleCount: articles.length,
      likelyVirtualized: articles.length > 0 && Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0) > (window.innerHeight || 1) * 2
    }
  });
})()`;

interface RawPostCandidate extends Omit<FacebookPostStructureCandidate, 'permalinkCandidates'> {
  permalinkHrefs?: string[];
}

interface RawPageStructure {
  href: string;
  articleCount: number;
  commentEditorCount: number;
  permalinkHrefs?: string[];
  postCandidates?: RawPostCandidate[];
  membership: FacebookMembershipSignals;
  virtualization: FacebookVirtualizationObservation;
}

export function normalizeFacebookPageStructure(raw: RawPageStructure): FacebookPageStructureSummary {
  return {
    href: raw.href,
    surface: classifyFacebookSurface(raw.href),
    articleCount: raw.articleCount,
    commentEditorCount: raw.commentEditorCount,
    permalinkCandidates: normalizeFacebookPermalinks(raw.permalinkHrefs ?? []),
    postCandidates: (raw.postCandidates ?? []).map((p) => {
      const { permalinkHrefs: _permalinkHrefs, ...safe } = p;
      void _permalinkHrefs;
      return {
        ...safe,
        permalinkCandidates: normalizeFacebookPermalinks(p.permalinkHrefs ?? []),
      };
    }),
    membership: raw.membership,
    virtualization: raw.virtualization,
  };
}

export async function collectFacebookPageStructure(cdp: BrowseCdp): Promise<FacebookPageStructureSummary> {
  const raw = await evalRaw<string>(cdp, PAGE_STRUCTURE_SCAN_JS);
  return normalizeFacebookPageStructure(JSON.parse(raw) as RawPageStructure);
}
