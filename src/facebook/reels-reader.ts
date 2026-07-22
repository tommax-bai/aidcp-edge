/**
 * Facebook Reels list driver.
 *
 * Reels is not an article/feed DOM. The page keeps neighbouring videos mounted, so every read/write
 * starts by resolving the single video with the largest viewport intersection and binding it to the
 * canonical `/reel/<id>` route. Writes use the event mechanism proven for each Facebook control:
 * the primary React reaction control is activated against the freshly resolved in-page element, while
 * a reaction-picker item uses trusted CDP pointer input. Every write requires a same-Reel post-condition;
 * rounded counters never prove success. Forward navigation prefers trusted keyboard and wheel input
 * before the DOM button fallback, and every method must prove route/video movement.
 */

import { dispatchClick, evalJson, type BrowseCdp } from '../browse/cdp-util.js';
import type { FacebookLikeObservation, FacebookLikeResult } from './like-executor.js';
import {
  COMMENT_LABEL_SOURCE,
  NEUTRAL_LIKE_LABEL_SOURCE,
  REACTED_WORD_SOURCE,
  REACTION_PICKER_LABEL_SOURCE,
  UNREACT_LABEL_SOURCE,
} from './cta-labels.js';

export interface FacebookReelCard {
  noteId: string;
  summary: string;
  author?: string;
  reactionText?: string;
  videoKey: string;
}

export type FacebookReelsEntryResult =
  | { state: 'ready'; card: FacebookReelCard }
  | { state: 'route_ready'; href: string }
  | { state: 'failed'; reason: 'navigation_error' | 'route_unconfirmed' };

export interface FacebookReelsReaderDeps {
  cdp: BrowseCdp;
  sleep?: (ms: number) => Promise<void>;
  logger?: (message: string) => void;
  random?: () => number;
}

export interface FacebookReelsReaderOptions {
  settleRounds?: number;
  settleMs?: number;
  verifyRounds?: number;
  verifyMs?: number;
  navigationRounds?: number;
  navigationMs?: number;
}

const DEFAULTS: Required<FacebookReelsReaderOptions> = {
  settleRounds: 16,
  settleMs: 500,
  verifyRounds: 10,
  verifyMs: 250,
  navigationRounds: 6,
  navigationMs: 250,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const FACEBOOK_REELS_ENTRY_URL = 'https://www.facebook.com/reel/?s=tab';

const REEL_ROUTE_PROBE_JS = `(() => {
  /* __AIDCP_REEL_ROUTE_PROBE__ */
  try {
    const url = new URL(location.href);
    const hostOk = /(^|\\.)facebook\\.com$/i.test(url.hostname);
    const routeOk = /^\\/reel(?:\\/|$)/i.test(url.pathname);
    return JSON.stringify({ ok: hostOk && routeOk, href: url.href });
  } catch {
    return JSON.stringify({ ok: false, href: '' });
  }
})()`;

interface ReelProbe {
  ok: boolean;
  reason?: 'not_reel' | 'no_active_video' | 'ambiguous_target';
  noteId?: string;
  summary?: string;
  author?: string;
  reactionText?: string;
  videoKey?: string;
  videoRect?: { left: number; top: number; right: number; bottom: number };
}

interface ActionTarget extends ReelProbe {
  found?: boolean;
  ambiguous?: boolean;
  already?: boolean;
  cx?: number;
  cy?: number;
  label?: string;
  selected?: boolean;
  witness?: string;
}

interface ReelLikePrimaryCommit {
  ok?: boolean;
  noteId?: string;
  found?: boolean;
  ambiguous?: boolean;
  moved?: boolean;
  already?: boolean;
  clicked?: boolean;
}

interface ReelLikeVerify {
  ok?: boolean;
  noteId?: string;
  found?: boolean;
  ambiguous?: boolean;
  selected?: boolean;
  witness?: string;
}

interface ReelLikePickerTarget {
  status?: 'found' | 'missing' | 'ambiguous' | 'offscreen' | 'reel_moved' | 'target_lost' | 'target_ambiguous';
  noteId?: string;
  cx?: number;
  cy?: number;
  fromX?: number;
  fromY?: number;
}

export type FacebookReelFollowReason =
  | 'no_target'
  | 'ambiguous_target'
  | 'already_followed'
  | 'shadow'
  | 'state_unchanged'
  | 'verify_indeterminate'
  | 'nav_error';

export interface FacebookReelFollowResult {
  ok: boolean;
  reason?: FacebookReelFollowReason;
  /** Whether a trusted pointer click was actually dispatched. */
  executed: boolean;
}

export interface FacebookReelFollowTarget {
  ok: boolean;
  noteId?: string;
  found?: boolean;
  ambiguous?: boolean;
  author?: string;
  authorMatches?: number;
  state?: 'follow' | 'following';
  cx?: number;
  cy?: number;
  label?: string;
  text?: string;
}

function cleanSummary(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_500);
}

function reelCard(probe: ReelProbe): FacebookReelCard | null {
  if (!probe.ok || !probe.noteId || !probe.videoKey) return null;
  return {
    noteId: probe.noteId,
    summary: cleanSummary(probe.summary),
    videoKey: probe.videoKey,
    ...(cleanSummary(probe.author) ? { author: cleanSummary(probe.author) } : {}),
    ...(cleanSummary(probe.reactionText) ? { reactionText: cleanSummary(probe.reactionText) } : {}),
  };
}

function observation(card: FacebookReelCard): FacebookLikeObservation {
  return {
    noteId: card.noteId,
    surface: 'feed',
    articleIndex: 0,
    ...(card.author ? { author: card.author } : {}),
    ...(card.summary ? { textPreviewHead: card.summary.slice(0, 120) } : {}),
    ...(card.reactionText ? { reactionText: card.reactionText } : {}),
  };
}

/** Marker names intentionally remain in expressions: focused tests can script CDP without coupling to minified DOM text. */
export function buildReelProbeJs(): string {
  return String.raw`(function(){/*__AIDCP_REEL_PROBE__*/
  function text(el){return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\s+/g,' ').trim();}
  function visible(el){if(!el||!el.getBoundingClientRect)return false;var r=el.getBoundingClientRect();var s=getComputedStyle(el);return r.width>1&&r.height>1&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden';}
  function canonical(){try{var u=new URL(location.href);if(!/(^|\.)facebook\.com$/i.test(u.hostname))return '';var m=u.pathname.match(/^\/reel\/([^/?#]+)/i);return m?'https://www.facebook.com/reel/'+m[1]:'';}catch(e){return '';}}
  function area(r){var l=Math.max(0,r.left),t=Math.max(0,r.top),rr=Math.min(innerWidth,r.right),b=Math.min(innerHeight,r.bottom);return Math.max(0,rr-l)*Math.max(0,b-t);}
  function active(){var vs=Array.from(document.querySelectorAll('video')).map(function(v,i){var r=v.getBoundingClientRect();return {v:v,i:i,r:r,a:area(r),d:Math.abs((r.top+r.bottom)/2-innerHeight/2)};}).filter(function(x){return x.a>0;}).sort(function(a,b){return b.a-a.a||a.d-b.d;});if(!vs.length)return null;if(vs.length>1&&Math.abs(vs[0].a-vs[1].a)<1&&Math.abs(vs[0].d-vs[1].d)<1)return {ambiguous:true};return vs[0];}
  function videoKey(v){var w=window,state=w.__aidcpReelVideoKeyState;if(!state){state={seq:0,keys:new WeakMap()};w.__aidcpReelVideoKeyState=state;}var id=state.keys.get(v);if(!id){id=++state.seq;state.keys.set(v,id);}return (v.currentSrc||v.src||v.poster||v.getAttribute('src')||'')+'@element:'+id;}
  var neutralLike=new RegExp(${JSON.stringify(NEUTRAL_LIKE_LABEL_SOURCE)},'i'), commentLabel=new RegExp(${JSON.stringify(COMMENT_LABEL_SOURCE)},'i');
  function lineNoise(s){return neutralLike.test(s)||commentLabel.test(s)||/^(follow|following|theo doi|đang theo dõi|关注|已关注|audio|original audio|am thanh goc|原声|share)$/i.test(s);}
  var id=canonical();if(!id)return JSON.stringify({ok:false,reason:'not_reel'});var a=active();if(!a)return JSON.stringify({ok:false,reason:'no_active_video'});if(a.ambiguous)return JSON.stringify({ok:false,reason:'ambiguous_target'});
  var r=a.r, candidates=[];Array.from(document.querySelectorAll('[dir="auto"],span,div')).forEach(function(el){if(!visible(el)||el.children.length>6)return;var er=el.getBoundingClientRect(),s=text(el);if(s.length<2||s.length>1500||lineNoise(s))return;if(er.left>r.left+r.width*.68||er.top<r.top+r.height*.42||er.bottom>r.bottom+30)return;var nested=Array.from(el.children).some(function(c){return text(c)===s&&text(c).length>1;});if(nested)return;var score=s.length+(er.top-r.top)*.02-(Math.max(0,r.left-er.left))*0.01;candidates.push({s:s,score:score,el:el});});candidates.sort(function(x,y){return y.score-x.score;});
  var summary=candidates.length?candidates[0].s:'';var author='';if(candidates.length){var root=candidates[0].el.parentElement;for(var up=0;root&&up<5;up++,root=root.parentElement){var h=root.querySelector('h1 a,h2 a,h3 a,h4 a,a[role="link"]');var ht=text(h);if(ht&&ht!==summary&&ht.length<100){author=ht;break;}}}
  var key=videoKey(a.v);
  return JSON.stringify({ok:true,noteId:id,summary:summary,author:author,videoKey:key,videoRect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}});
})()`;
}

const REEL_PROBE_JS = buildReelProbeJs();

const REEL_LIKE_HELPERS_JS = String.raw`
  var aidcpReelNeutralLike=new RegExp(${JSON.stringify(NEUTRAL_LIKE_LABEL_SOURCE)},'i');
  var aidcpReelUnlike=new RegExp(${JSON.stringify(UNREACT_LABEL_SOURCE)},'i');
  var aidcpReelReactedWord=new RegExp(${JSON.stringify(REACTED_WORD_SOURCE)},'i');
  var aidcpReelPickerLabel=new RegExp(${JSON.stringify(REACTION_PICKER_LABEL_SOURCE)},'i');
  var aidcpReelComment=new RegExp(${JSON.stringify(COMMENT_LABEL_SOURCE)},'i');
  var aidcpReelExcluded=/(share|chia se|分享|menu|更多|next|previous|下一|上一|pause|play|播放|暂停)/i;
  function aidcpReelText(e){return String((e&&e.innerText)||(e&&e.textContent)||'').replace(/\s+/g,' ').trim();}
  function aidcpReelLabel(e){return String((e&&e.getAttribute&&e.getAttribute('aria-label'))||'').replace(/\s+/g,' ').trim();}
  function aidcpReelCanon(){try{var u=new URL(location.href),m=u.pathname.match(/^\/reel\/([^/?#]+)/i);return /(^|\.)facebook\.com$/i.test(u.hostname)&&m?'https://www.facebook.com/reel/'+m[1]:'';}catch(e){return '';}}
  function aidcpReelArea(r){return Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top));}
  function aidcpReelVisible(el){if(!el||!el.getBoundingClientRect)return false;var r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>1&&r.height>1&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||'1')>.01;}
  function aidcpReelSelectedWitness(el,label,text){
    if(aidcpReelUnlike.test(label)||aidcpReelUnlike.test(text))return 'unlike_label';
    if(String(el.getAttribute('aria-pressed')||'')==='true')return 'aria_pressed';
    if(String(el.getAttribute('aria-checked')||'')==='true')return 'aria_checked';
    var numeric=/\d/.test(text);
    if(!numeric&&aidcpReelPickerLabel.test(label)&&aidcpReelReactedWord.test(text))return 'reacted_text';
    if(!numeric&&!aidcpReelNeutralLike.test(label)&&aidcpReelReactedWord.test(label))return 'reacted_label';
    return '';
  }
  function aidcpReelActiveContext(){
    var id=aidcpReelCanon();if(!id)return {ok:false,noteId:'',found:false,reason:'not_reel'};
    var vs=Array.from(document.querySelectorAll('video')).map(function(v,i){var r=v.getBoundingClientRect();return {v:v,i:i,r:r,a:aidcpReelArea(r),d:Math.abs((r.top+r.bottom)/2-innerHeight/2)};}).filter(function(x){return x.a>0;}).sort(function(a,b){return b.a-a.a||a.d-b.d;});
    if(!vs.length)return {ok:false,noteId:id,found:false,reason:'no_active_video'};
    if(vs.length>1&&Math.abs(vs[0].a-vs[1].a)<1&&Math.abs(vs[0].d-vs[1].d)<1)return {ok:true,noteId:id,found:false,ambiguous:true};
    return {ok:true,noteId:id,found:true,ambiguous:false,active:vs[0]};
  }
  function aidcpReelTagged(runId){var tagged=Array.from(document.querySelectorAll('[data-aidcp-reel-like-target]')).filter(function(el){return el.getAttribute('data-aidcp-reel-like-target')===runId;});return tagged.length===1?tagged[0]:null;}
  function aidcpReelLikeContext(){
    var base=aidcpReelActiveContext();if(!base.ok||!base.found||base.ambiguous)return base;
    var id=base.noteId,active=base.active,r=active.r;
    var controls=Array.from(document.querySelectorAll('[role="button"],button')).map(function(el){var q=el.getBoundingClientRect(),label=aidcpReelLabel(el),text=aidcpReelText(el),source=label||text;return {el:el,q:q,label:label,text:text,source:source};}).filter(function(x){return aidcpReelVisible(x.el)&&x.q.width>=32&&x.q.width<=84&&x.q.height>=32&&x.q.height<=90&&x.q.left>=r.right-20&&x.q.left<=r.right+125&&x.q.top>=r.top-10&&x.q.bottom<=r.bottom+20&&!aidcpReelComment.test(x.source)&&!aidcpReelExcluded.test(x.source);});
    var supported=controls.filter(function(x){var witness=aidcpReelSelectedWitness(x.el,x.label,x.text);return !!witness||aidcpReelNeutralLike.test(x.label)||aidcpReelNeutralLike.test(x.text);});
    if(supported.length!==1)return {ok:true,noteId:id,found:false,ambiguous:supported.length>1,active:active};
    var x=supported[0],witness=aidcpReelSelectedWitness(x.el,x.label,x.text);
    return {ok:true,noteId:id,found:true,ambiguous:false,active:active,el:x.el,q:x.q,label:x.label,text:x.text,selected:!!witness,witness:witness,cx:x.q.left+x.q.width/2,cy:x.q.top+x.q.height/2};
  }
`;

export function buildReelLikeTargetJs(): string {
  return `(function(){/*__AIDCP_REEL_LIKE_TARGET__*/${REEL_LIKE_HELPERS_JS}
    var x=aidcpReelLikeContext();
    return JSON.stringify({ok:x.ok,noteId:x.noteId,found:x.found,ambiguous:!!x.ambiguous,already:!!x.selected,selected:!!x.selected,witness:x.witness||'',cx:x.cx,cy:x.cy});
  })()`;
}

function buildReelLikePrimaryCommitJs(expectedNoteId: string, runId: string): string {
  return `(function(){/*__AIDCP_REEL_LIKE_PRIMARY_COMMIT__*/${REEL_LIKE_HELPERS_JS}
    var x=aidcpReelLikeContext();
    if(x.noteId!==${JSON.stringify(expectedNoteId)})return JSON.stringify({ok:false,noteId:x.noteId,found:false,moved:true});
    if(!x.ok||!x.found||x.ambiguous||!x.el)return JSON.stringify({ok:!!x.ok,noteId:x.noteId,found:false,ambiguous:!!x.ambiguous});
    if(x.selected)return JSON.stringify({ok:true,noteId:x.noteId,found:true,already:true,clicked:false});
    try{Array.from(document.querySelectorAll('[data-aidcp-reel-like-target]')).forEach(function(el){el.removeAttribute('data-aidcp-reel-like-target');});x.el.setAttribute('data-aidcp-reel-like-target',${JSON.stringify(runId)});x.el.click();return JSON.stringify({ok:true,noteId:x.noteId,found:true,already:false,clicked:true});}
    catch(e){return JSON.stringify({ok:true,noteId:x.noteId,found:true,already:false,clicked:false});}
  })()`;
}

function buildReelLikeVerifyJs(expectedNoteId: string, runId: string): string {
  return `(function(){/*__AIDCP_REEL_LIKE_VERIFY__*/${REEL_LIKE_HELPERS_JS}
    var base=aidcpReelActiveContext();
    if(base.noteId!==${JSON.stringify(expectedNoteId)})return JSON.stringify({ok:false,noteId:base.noteId,found:false,moved:true});
    if(!base.ok||!base.found||base.ambiguous||!base.active)return JSON.stringify({ok:!!base.ok,noteId:base.noteId,found:false,ambiguous:!!base.ambiguous});
    var el=aidcpReelTagged(${JSON.stringify(runId)});if(!el||!aidcpReelVisible(el))return JSON.stringify({ok:true,noteId:base.noteId,found:false});
    var q=el.getBoundingClientRect(),r=base.active.r;
    if(q.width<32||q.width>84||q.height<32||q.height>90||q.left<r.right-20||q.left>r.right+125||q.top<r.top-10||q.bottom>r.bottom+20)return JSON.stringify({ok:true,noteId:base.noteId,found:false});
    var label=aidcpReelLabel(el),text=aidcpReelText(el),witness=aidcpReelSelectedWitness(el,label,text);
    return JSON.stringify({ok:true,noteId:base.noteId,found:true,ambiguous:false,selected:!!witness,witness:witness});
  })()`;
}

export function buildReelLikePickerTargetJs(expectedNoteId: string, runId: string): string {
  return `(function(){/*__AIDCP_REEL_LIKE_PICKER_TARGET__*/${REEL_LIKE_HELPERS_JS}
    var base=aidcpReelActiveContext();
    if(base.noteId!==${JSON.stringify(expectedNoteId)})return JSON.stringify({status:'reel_moved',noteId:base.noteId});
    if(!base.ok||!base.found||base.ambiguous||!base.active)return JSON.stringify({status:base.ambiguous?'target_ambiguous':'target_lost',noteId:base.noteId});
    var primary=aidcpReelTagged(${JSON.stringify(runId)});if(!primary||!aidcpReelVisible(primary))return JSON.stringify({status:'target_lost',noteId:base.noteId});
    var primaryRect=primary.getBoundingClientRect(),activeRect=base.active.r;
    if(primaryRect.left<activeRect.right-20||primaryRect.left>activeRect.right+125||primaryRect.top<activeRect.top-10||primaryRect.bottom>activeRect.bottom+20)return JSON.stringify({status:'target_lost',noteId:base.noteId});
    var reactionish=/(赞|讚|Like|Thích|Me gusta|Love|大爱|Care|加油|Haha|哈哈|Wow|哇|Sad|悲伤|Angry|怒)/i;
    var likeItem=/(?:^|[:：]\\s*)(赞|讚|Like|Thích|Me gusta)$/i;
    var vr=base.active.r,containers=Array.from(document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[aria-label*="Reaction" i],[aria-label*="反应"],[aria-label*="心情"]')).filter(aidcpReelVisible);
    var qualified=[];
    containers.forEach(function(container){
      var cr=container.getBoundingClientRect();
      if(cr.right<vr.left-180||cr.left>vr.right+260||cr.bottom<vr.top-120||cr.top>vr.bottom+120)return;
      var items=Array.from(container.querySelectorAll('[role="button"][aria-label],[role="radio"][aria-label],button[aria-label]')).filter(aidcpReelVisible);
      var reactions=items.filter(function(el){return reactionish.test(aidcpReelLabel(el));});
      var likes=items.filter(function(el){return likeItem.test(aidcpReelLabel(el));});
      if(reactions.length>=2&&likes.length===1)qualified.push({container:container,item:likes[0]});
    });
    qualified=qualified.filter(function(candidate){return !qualified.some(function(other){return other!==candidate&&candidate.container.contains(other.container);});});
    if(qualified.length===0)return JSON.stringify({status:'missing',noteId:base.noteId});
    if(qualified.length!==1)return JSON.stringify({status:'ambiguous',noteId:base.noteId});
    var q=qualified[0].item.getBoundingClientRect(),cx=Math.round(q.left+q.width/2),cy=Math.round(q.top+q.height/2),vw=innerWidth||0,vh=innerHeight||0;
    if(cx<0||cy<0||cx>vw||cy>vh)return JSON.stringify({status:'offscreen',noteId:base.noteId});
    return JSON.stringify({status:'found',noteId:base.noteId,cx:cx,cy:cy,fromX:Math.round(primaryRect.left+primaryRect.width/2),fromY:Math.round(primaryRect.top+primaryRect.height/2)});
  })()`;
}

function buildClearReelLikeTargetJs(runId: string): string {
  return `(function(){Array.from(document.querySelectorAll('[data-aidcp-reel-like-target]')).forEach(function(el){if(el.getAttribute('data-aidcp-reel-like-target')===${JSON.stringify(runId)})el.removeAttribute('data-aidcp-reel-like-target');});return JSON.stringify({ok:true});})()`;
}

/**
 * Resolve the active Reel's inline author Follow control without relying on DOM order.
 * The accessible label is authoritative for today's Facebook markup (for example
 * `关注Salon de Comolis` / `已关注Salon de Comolis`); the matching visible author text
 * and active-video geometry provide the independent association witness.
 */
export function buildReelFollowTargetJs(): string {
  return String.raw`(function(){/*__AIDCP_REEL_FOLLOW_TARGET__*/
  function text(el){return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\s+/g,' ').trim();}
  function label(el){return String((el&&el.getAttribute&&el.getAttribute('aria-label'))||'').replace(/\s+/g,' ').trim();}
  function visible(el){if(!el||!el.getBoundingClientRect)return false;var r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>1&&r.height>1&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden';}
  function canonical(){try{var u=new URL(location.href),m=u.pathname.match(/^\/reel\/([^/?#]+)/i);return /(^|\.)facebook\.com$/i.test(u.hostname)&&m?'https://www.facebook.com/reel/'+m[1]:'';}catch(e){return '';}}
  function area(r){var l=Math.max(0,r.left),t=Math.max(0,r.top),rr=Math.min(innerWidth,r.right),b=Math.min(innerHeight,r.bottom);return Math.max(0,rr-l)*Math.max(0,b-t);}
  function distance(a,b){var dx=Math.max(0,a.left-b.right,b.left-a.right),dy=Math.max(0,a.top-b.bottom,b.top-a.bottom);return Math.sqrt(dx*dx+dy*dy);}
  function leafExact(value){return Array.from(document.querySelectorAll('a,span,div')).filter(function(el){if(!visible(el)||text(el)!==value)return false;return !Array.from(el.children||[]).some(function(c){return text(c)===value;});});}
  function parseControl(el){var t=text(el),l=label(el),source=l||t,m=source.match(/^(following|follow|已关注|关注|đang theo dõi|theo dõi|dang theo doi|theo doi)\s*(.*)$/i);if(!m)return null;var token=m[1].toLowerCase(),author=String(m[2]||'').trim();var state=/^(following|已关注|đang theo dõi|dang theo doi)$/i.test(token)?'following':'follow';return {el:el,t:t,l:l,state:state,author:author};}
  var id=canonical();if(!id)return JSON.stringify({ok:false,found:false});
  var videos=Array.from(document.querySelectorAll('video')).map(function(v){var r=v.getBoundingClientRect();return {v:v,r:r,a:area(r),d:Math.abs((r.top+r.bottom)/2-innerHeight/2)};}).filter(function(x){return x.a>0;}).sort(function(a,b){return b.a-a.a||a.d-b.d;});
  if(!videos.length)return JSON.stringify({ok:false,noteId:id,found:false});
  if(videos.length>1&&Math.abs(videos[0].a-videos[1].a)<1&&Math.abs(videos[0].d-videos[1].d)<1)return JSON.stringify({ok:true,noteId:id,found:false,ambiguous:true});
  var vr=videos[0].r;
  var controls=Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible).map(parseControl).filter(Boolean).filter(function(x){var q=x.el.getBoundingClientRect();return q.top>=vr.top-30&&q.bottom<=vr.bottom+30&&q.left>=vr.left-80&&q.right<=vr.right+180;});
  var qualified=[];
  controls.forEach(function(x){var author=x.author;if(!author)return;var authors=leafExact(author),q=x.el.getBoundingClientRect(),near=authors.filter(function(a){return distance(a.getBoundingClientRect(),q)<=260;});if(near.length!==1)return;qualified.push({control:x,author:author,authorMatches:near.length});});
  if(qualified.length!==1)return JSON.stringify({ok:true,noteId:id,found:false,ambiguous:qualified.length>1});
  var selected=qualified[0],control=selected.control,q=control.el.getBoundingClientRect();
  return JSON.stringify({ok:true,noteId:id,found:true,ambiguous:false,author:selected.author,authorMatches:selected.authorMatches,state:control.state,cx:q.left+q.width/2,cy:q.top+q.height/2,label:control.l,text:control.t});
  })()`;
}

const REEL_FOLLOW_TARGET_JS = buildReelFollowTargetJs();

export function buildNextTargetJs(): string {
  return String.raw`(function(){/*__AIDCP_REEL_NEXT_TARGET__*/
  function text(e){return String((e&&e.getAttribute&&e.getAttribute('aria-label'))||(e&&e.innerText)||(e&&e.textContent)||'').replace(/\s+/g,' ').trim();}function canon(){try{var u=new URL(location.href),m=u.pathname.match(/^\/reel\/([^/?#]+)/i);return m?'https://www.facebook.com/reel/'+m[1]:'';}catch(e){return '';}}function ar(r){return Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top));}
  var vs=Array.from(document.querySelectorAll('video')).map(function(v,i){var r=v.getBoundingClientRect();return {v:v,i:i,r:r,a:ar(r),d:Math.abs((r.top+r.bottom)/2-innerHeight/2)};}).filter(function(x){return x.a>0;}).sort(function(a,b){return b.a-a.a||a.d-b.d;});if(!canon()||!vs.length)return JSON.stringify({ok:false,found:false});if(vs.length>1&&Math.abs(vs[0].a-vs[1].a)<1&&Math.abs(vs[0].d-vs[1].d)<1)return JSON.stringify({ok:true,found:false,ambiguous:true});var r=vs[0].r;
  var next=/(next|ti[eế]p theo|下一|下一个|下一張|下一张|往下)/i,previous=/(previous|trước|上一|上一个|上一張|上一张|往上)/i;
  var buttons=Array.from(document.querySelectorAll('[role="button"],button')).map(function(b){var q=b.getBoundingClientRect();return {b:b,q:q,label:text(b)};}).filter(function(x){return x.q.width>=36&&x.q.width<=68&&x.q.height>=36&&x.q.height<=68&&x.q.left>Math.max(innerWidth*.8,r.right+120)&&x.q.right<=innerWidth+2&&x.q.top>=Math.max(64,r.top+r.height*.25)&&x.q.bottom<=Math.min(innerHeight,r.bottom-r.height*.12)&&x.b.getAttribute('aria-disabled')!=='true'&&!x.b.disabled;}).sort(function(a,b){return a.q.top-b.q.top;});
  var labelled=buttons.filter(function(x){return next.test(x.label)&&!previous.test(x.label);});if(labelled.length>1)return JSON.stringify({ok:true,found:false,ambiguous:true});var target=labelled.length===1?labelled[0]:null;
  if(!target){var unknown=buttons.filter(function(x){return !previous.test(x.label);});if(unknown.length===2)target=unknown[1];else return JSON.stringify({ok:true,found:false,ambiguous:unknown.length>1});}
  return JSON.stringify({ok:true,found:true,ambiguous:false,cx:target.q.left+target.q.width/2,cy:target.q.top+target.q.height/2,label:target.label,noteId:canon(),videoKey:(vs[0].v.currentSrc||vs[0].v.src||'')+'@'+vs[0].i});
})()`;
}

const NEXT_TARGET_JS = buildNextTargetJs();

async function trustedClick(cdp: BrowseCdp, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function trustedArrowDown(cdp: BrowseCdp): Promise<void> {
  const key = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

async function trustedWheel(cdp: BrowseCdp, x: number, y: number, deltaY: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
}

export function randomReelWheelDistance(random: () => number = Math.random): number {
  const sample = Number(random());
  const bounded = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.min(100, 70 + Math.floor(bounded * 31));
}

function movedFrom(card: FacebookReelCard, previous: { noteId: string; videoKey: string }): boolean {
  return card.noteId !== previous.noteId || card.videoKey !== previous.videoKey;
}

export class FacebookReelsReader {
  private readonly cdp: BrowseCdp;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly random: () => number;
  private readonly opts: Required<FacebookReelsReaderOptions>;

  constructor(deps: FacebookReelsReaderDeps, options: FacebookReelsReaderOptions = {}) {
    this.cdp = deps.cdp;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.logger ?? (() => {});
    this.random = deps.random ?? Math.random;
    this.opts = { ...DEFAULTS, ...options };
  }

  async enter(): Promise<FacebookReelsEntryResult> {
    try {
      await this.cdp.send('Page.navigate', { url: FACEBOOK_REELS_ENTRY_URL });
    } catch (error) {
      this.log(`[fb-reels] 导航失败：${(error as Error).message}`);
      return { state: 'failed', reason: 'navigation_error' };
    }
    const card = await this.settleActive();
    if (card) return { state: 'ready', card };
    try {
      const route = await evalJson<{ ok?: boolean; href?: string }>(this.cdp, REEL_ROUTE_PROBE_JS);
      if (route?.ok && typeof route.href === 'string' && route.href) {
        this.log(`[fb-reels] Reels 路由已就绪，首卡仍在水合：${route.href}`);
        return { state: 'route_ready', href: route.href };
      }
    } catch (error) {
      this.log(`[fb-reels] Reels 路由复验失败：${(error as Error).message}`);
    }
    return { state: 'failed', reason: 'route_unconfirmed' };
  }

  async readActive(): Promise<FacebookReelCard | null> {
    try {
      return reelCard(await evalJson<ReelProbe>(this.cdp, REEL_PROBE_JS));
    } catch (error) {
      this.log(`[fb-reels] 活动视频探测失败：${(error as Error).message}`);
      return null;
    }
  }

  async settleActive(previous?: { noteId: string; videoKey: string }): Promise<FacebookReelCard | null> {
    for (let round = 0; round < this.opts.settleRounds; round++) {
      const card = await this.readActive();
      if (card && (!previous || card.noteId !== previous.noteId || card.videoKey !== previous.videoKey)) return card;
      if (round < this.opts.settleRounds - 1) await this.sleep(this.opts.settleMs);
    }
    return null;
  }

  private async waitForMovement(previous: { noteId: string; videoKey: string }): Promise<FacebookReelCard | null> {
    let videoMoved: FacebookReelCard | null = null;
    for (let round = 0; round < this.opts.navigationRounds; round++) {
      const card = await this.readActive();
      if (card && card.noteId !== previous.noteId) return card;
      if (card && card.videoKey !== previous.videoKey) videoMoved = card;
      if (round < this.opts.navigationRounds - 1) await this.sleep(this.opts.navigationMs);
    }
    return videoMoved;
  }

  /** Re-probe immediately before a fallback write; late movement wins and suppresses that write. */
  private async beforeFallback(previous: { noteId: string; videoKey: string }): Promise<{
    card: FacebookReelCard;
    moved: boolean;
    videoRect?: { left: number; top: number; right: number; bottom: number };
  } | null> {
    const probe = await this.readProbe();
    const card = probe ? reelCard(probe) : null;
    return card ? { card, moved: movedFrom(card, previous), ...(probe?.videoRect ? { videoRect: probe.videoRect } : {}) } : null;
  }

  async like(noteId: string, shadow: boolean): Promise<FacebookLikeResult> {
    let target: ActionTarget;
    try {
      target = await evalJson<ActionTarget>(this.cdp, buildReelLikeTargetJs());
    } catch {
      return { ok: false, reason: 'nav_error', executed: false };
    }
    if (!target.ok || !target.noteId || target.noteId !== noteId) return { ok: false, reason: 'no_target', executed: false };
    if (target.ambiguous) return { ok: false, reason: 'ambiguous_target', executed: false };
    if (!target.found) return { ok: false, reason: 'no_target', executed: false };
    const active = await this.readActive();
    if (!active || active.noteId !== noteId) return { ok: false, reason: 'no_target', executed: false };
    const obs = observation(active);
    if (target.already) return { ok: false, reason: 'already_liked', executed: false, observation: obs };
    if (shadow) return { ok: false, reason: 'shadow', executed: false, observation: obs };

    // Commit boundary: repeat active-Reel + supported-control resolution and activate that fresh DOM element.
    // Consuming the earlier probe's coordinates is unsafe: React hydration/layout may drift between probe and write,
    // and Facebook's primary reaction control accepts in-page activation more reliably than a raw pointer trio.
    const runId = `reel-like-${Date.now().toString(36)}-${Math.floor(this.random() * 1_000_000).toString(36)}`;
    let commit: ReelLikePrimaryCommit;
    try {
      commit = await evalJson<ReelLikePrimaryCommit>(this.cdp, buildReelLikePrimaryCommitJs(noteId, runId));
    } catch {
      return { ok: false, reason: 'nav_error', executed: false };
    }
    if (commit.moved || commit.noteId !== noteId) return { ok: false, reason: 'no_target', executed: false };
    if (commit.ambiguous) return { ok: false, reason: 'ambiguous_target', executed: false };
    if (commit.already) return { ok: false, reason: 'already_liked', executed: false, observation: obs };
    if (!commit.ok || !commit.found || !commit.clicked) return { ok: false, reason: 'no_target', executed: false };
    this.log('[fb-reels][like] commit=primary_dom_click');

    try {
      let pickerCommitted = false;
      let lastPickerStatus: ReelLikePickerTarget['status'] = 'missing';
      let verifyAfterPickerCommit = false;
      let round = 0;
      while (round < this.opts.verifyRounds || verifyAfterPickerCommit) {
        verifyAfterPickerCommit = false;
        try {
          const verify = await evalJson<ReelLikeVerify>(this.cdp, buildReelLikeVerifyJs(noteId, runId));
          if (verify.noteId !== noteId) {
            this.log('[fb-reels][like] terminal=verify_indeterminate detail=reel_moved');
            return { ok: false, reason: 'verify_indeterminate', executed: true };
          }
          if (!verify.ok || !verify.found || verify.ambiguous) {
            this.log(`[fb-reels][like] terminal=verify_indeterminate detail=${verify.ambiguous ? 'target_ambiguous' : 'target_lost'}`);
            return { ok: false, reason: 'verify_indeterminate', executed: true };
          }
          if (verify.selected) {
            const after = await this.readActive();
            this.log(`[fb-reels][like] success=${pickerCommitted ? 'picker_selected' : 'direct_selected'} witness=${verify.witness || 'selected'}`);
            return { ok: true, executed: true, observation: observation(after && after.noteId === noteId ? after : active) };
          }
        } catch {
          // bounded retry
        }

        // Some Reel layouts open the reaction picker instead of selecting Like. Commit its unique scoped
        // Like item at most once; never search the document for a bare Like control.
        if (!pickerCommitted) {
          try {
            const picker = await evalJson<ReelLikePickerTarget>(this.cdp, buildReelLikePickerTargetJs(noteId, runId));
            lastPickerStatus = picker.status ?? 'missing';
            if (picker.status === 'reel_moved' || picker.status === 'target_lost' || picker.status === 'target_ambiguous') {
              this.log(`[fb-reels][like] terminal=verify_indeterminate detail=picker_${picker.status}`);
              return { ok: false, reason: 'verify_indeterminate', executed: true };
            }
            if (
              picker.status === 'found' &&
              Number.isFinite(picker.cx) &&
              Number.isFinite(picker.cy) &&
              Number.isFinite(picker.fromX) &&
              Number.isFinite(picker.fromY)
            ) {
              try {
                await dispatchClick(this.cdp, Number(picker.cx), Number(picker.cy), {
                  from: { x: Number(picker.fromX), y: Number(picker.fromY) },
                  overshoot: false,
                  random: this.random,
                  sleep: this.sleep,
                });
              } catch {
                this.log('[fb-reels][like] terminal=verify_indeterminate detail=picker_dispatch_error');
                return { ok: false, reason: 'verify_indeterminate', executed: true };
              }
              pickerCommitted = true;
              verifyAfterPickerCommit = true;
              this.log('[fb-reels][like] commit=picker_pointer_click');
            }
          } catch {
            // Picker observation is optional and bounded; selected-state verification remains authoritative.
          }
        }

        round += 1;
        if (round < this.opts.verifyRounds || verifyAfterPickerCommit) await this.sleep(this.opts.verifyMs);
      }
      this.log(`[fb-reels][like] terminal=state_unchanged picker=${lastPickerStatus ?? 'missing'}`);
      return { ok: false, reason: 'state_unchanged', executed: true };
    } finally {
      try {
        await evalJson(this.cdp, buildClearReelLikeTargetJs(runId));
      } catch {
        // Best-effort transient marker cleanup; the unique run id prevents cross-command reuse.
      }
    }
  }

  async follow(noteId: string, shadow: boolean): Promise<FacebookReelFollowResult> {
    let target: FacebookReelFollowTarget;
    try {
      target = await evalJson<FacebookReelFollowTarget>(this.cdp, REEL_FOLLOW_TARGET_JS);
    } catch {
      return { ok: false, reason: 'nav_error', executed: false };
    }
    const invalid = this.followTargetFailure(target, noteId);
    if (invalid) return invalid;
    if (target.state === 'following') return { ok: true, reason: 'already_followed', executed: false };
    if (shadow) return { ok: false, reason: 'shadow', executed: false };

    // Fresh re-probe at the commit boundary: late Reel movement or markup ambiguity wins over the write.
    let fresh: FacebookReelFollowTarget;
    try {
      fresh = await evalJson<FacebookReelFollowTarget>(this.cdp, REEL_FOLLOW_TARGET_JS);
    } catch {
      return { ok: false, reason: 'nav_error', executed: false };
    }
    const freshInvalid = this.followTargetFailure(fresh, noteId);
    if (freshInvalid) return freshInvalid;
    if (fresh.author !== target.author) return { ok: false, reason: 'no_target', executed: false };
    if (fresh.state === 'following') return { ok: true, reason: 'already_followed', executed: false };
    if (!Number.isFinite(fresh.cx) || !Number.isFinite(fresh.cy)) return { ok: false, reason: 'no_target', executed: false };

    await trustedClick(this.cdp, Number(fresh.cx), Number(fresh.cy));
    for (let round = 0; round < this.opts.verifyRounds; round++) {
      try {
        const verify = await evalJson<FacebookReelFollowTarget>(this.cdp, REEL_FOLLOW_TARGET_JS);
        if (verify.noteId !== noteId || verify.author !== target.author || verify.ambiguous) {
          return { ok: false, reason: 'verify_indeterminate', executed: true };
        }
        if (verify.found && verify.authorMatches === 1 && verify.state === 'following') {
          return { ok: true, executed: true };
        }
      } catch {
        // bounded retry
      }
      if (round < this.opts.verifyRounds - 1) await this.sleep(this.opts.verifyMs);
    }
    return { ok: false, reason: 'state_unchanged', executed: true };
  }

  private followTargetFailure(
    target: FacebookReelFollowTarget,
    noteId: string,
  ): FacebookReelFollowResult | null {
    if (!target.ok || target.noteId !== noteId) return { ok: false, reason: 'no_target', executed: false };
    if (target.ambiguous) return { ok: false, reason: 'ambiguous_target', executed: false };
    if (!target.found || !target.author || target.authorMatches !== 1) {
      return { ok: false, reason: 'no_target', executed: false };
    }
    return null;
  }

  async next(): Promise<FacebookReelCard | null> {
    const before = await this.readActive();
    if (!before) {
      this.log('[fb-reels] 下一条失败 method=probe reason=no_active_reel');
      return null;
    }

    let fresh = await this.beforeFallback(before);
    if (!fresh) return null;
    if (fresh.moved) return fresh.card;
    try {
      await trustedArrowDown(this.cdp);
      const moved = await this.waitForMovement(before);
      if (moved) {
        this.log(`[fb-reels] 下一条成功 method=keyboard from=${before.noteId} to=${moved.noteId}`);
        return moved;
      }
      this.log('[fb-reels] 下一条未变化 method=keyboard reason=keyboard_unchanged');
    } catch (error) {
      this.log(`[fb-reels] 下一条输入失败 method=keyboard reason=${(error as Error).message}`);
    }

    fresh = await this.beforeFallback(before);
    if (!fresh) return null;
    if (fresh.moved) return fresh.card;
    const rect = fresh.videoRect;
    if (rect) {
      const deltaY = randomReelWheelDistance(this.random);
      try {
        await trustedWheel(this.cdp, (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2, deltaY);
        const moved = await this.waitForMovement(before);
        if (moved) {
          this.log(`[fb-reels] 下一条成功 method=wheel deltaY=${deltaY} from=${before.noteId} to=${moved.noteId}`);
          return moved;
        }
        this.log(`[fb-reels] 下一条未变化 method=wheel deltaY=${deltaY} reason=wheel_unchanged`);
      } catch (error) {
        this.log(`[fb-reels] 下一条输入失败 method=wheel deltaY=${deltaY} reason=${(error as Error).message}`);
      }
    } else {
      this.log('[fb-reels] 下一条跳过 method=wheel reason=no_active_video_rect');
    }

    fresh = await this.beforeFallback(before);
    if (!fresh) return null;
    if (fresh.moved) return fresh.card;
    let target: ActionTarget;
    try {
      target = await evalJson<ActionTarget>(this.cdp, NEXT_TARGET_JS);
    } catch (error) {
      this.log(`[fb-reels] 下一条探测失败 method=button reason=${(error as Error).message}`);
      return null;
    }
    if (target.ambiguous) {
      this.log('[fb-reels] 下一条失败 method=button reason=button_ambiguous');
      return null;
    }
    if (!target.ok || !target.found || target.noteId !== before.noteId || !Number.isFinite(target.cx) || !Number.isFinite(target.cy)) {
      const late = await this.readActive();
      if (late && movedFrom(late, before)) return late;
      this.log('[fb-reels] 下一条失败 method=button reason=button_no_target');
      return null;
    }
    await trustedClick(this.cdp, Number(target.cx), Number(target.cy));
    const moved = await this.waitForMovement(before);
    if (moved) {
      this.log(`[fb-reels] 下一条成功 method=button from=${before.noteId} to=${moved.noteId}`);
      return moved;
    }
    this.log('[fb-reels] 下一条失败 method=button reason=button_unchanged');
    return null;
  }

  private async readProbe(): Promise<ReelProbe | null> {
    try {
      return await evalJson<ReelProbe>(this.cdp, REEL_PROBE_JS);
    } catch {
      return null;
    }
  }
}
