import { evalJson, type BrowseCdp, dispatchClick, type RandomFn, defaultRandom } from '../../browse/cdp-util.js';

export const TIKTOK_START_URL = 'https://www.tiktok.com/foryou';

export type TikTokBlockReason =
  | 'none'
  | 'not_tiktok'
  | 'login_required'
  | 'challenge'
  | 'access_restricted';

export type TikTokLoginState = 'logged_in' | 'logged_out' | 'unknown';
export type TikTokLikeState = 'liked' | 'unliked' | 'unknown';

export interface TikTokVideoTarget {
  videoId: string;
  authorHandle: string;
  path: string;
  centerX: number;
  centerY: number;
  top: number;
  bottom: number;
  visibleRatio: number;
}

export interface TikTokControlTarget {
  found: boolean;
  ambiguous: boolean;
  centerX?: number;
  centerY?: number;
  state?: TikTokLikeState;
  evidence?: string;
}

export interface TikTokEditorTarget {
  found: boolean;
  ambiguous: boolean;
  textLength?: number;
}

export interface TikTokPageSnapshot {
  host: string;
  path: string;
  blockReason: TikTokBlockReason;
  loginState: TikTokLoginState;
  current?: TikTokVideoTarget;
  currentAmbiguous: boolean;
  visibleVideoIds: string[];
  scrollTop: number;
  like: TikTokControlTarget;
  commentOpener: TikTokControlTarget;
  editor: TikTokEditorTarget;
}

export interface TikTokSafeSnapshot {
  host: string;
  path: string;
  blockReason: TikTokBlockReason;
  loginState: TikTokLoginState;
  current?: Pick<TikTokVideoTarget, 'videoId' | 'authorHandle' | 'path'>;
  currentAmbiguous: boolean;
  visibleVideoIds: string[];
  scrollTop: number;
  like: Pick<TikTokControlTarget, 'found' | 'ambiguous' | 'state' | 'evidence'>;
  commentOpener: Pick<TikTokControlTarget, 'found' | 'ambiguous'>;
  editor: TikTokEditorTarget;
}

export const TIKTOK_PAGE_SNAPSHOT_JS = String.raw`(function(){/*aidcp:tiktok-page-snapshot*/
  var vw=Math.max(1,window.innerWidth||document.documentElement.clientWidth||1280);
  var vh=Math.max(1,window.innerHeight||document.documentElement.clientHeight||800);
  function rectOf(el){try{return el&&el.getBoundingClientRect?el.getBoundingClientRect():null;}catch(e){return null;}}
  function visible(el){var r=rectOf(el);if(!r||r.width<2||r.height<2||r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw)return false;var s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}
  function ratio(r){if(!r||r.width<=0||r.height<=0)return 0;var w=Math.max(0,Math.min(r.right,vw)-Math.max(r.left,0));var h=Math.max(0,Math.min(r.bottom,vh)-Math.max(r.top,0));return Math.max(0,Math.min(1,(w*h)/(r.width*r.height)));}
  function parseVideo(href){try{var u=new URL(href,location.href);var m=u.pathname.match(/^\/@([^/]+)\/video\/(\d+)/i);return m?{videoId:m[2],authorHandle:decodeURIComponent(m[1]),path:u.pathname}:null;}catch(e){return null;}}
  function rootFor(el){return (el&&el.closest&&el.closest('[data-e2e="recommend-list-item-container"],[data-e2e="browse-video"],[data-e2e="video-detail"],article,section'))||(el&&el.parentElement)||document.body;}
  function authorFor(root){
    var links=Array.prototype.slice.call((root||document).querySelectorAll('a[data-e2e="video-author-avatar"][href],a[href^="/@"]'));
    for(var i=0;i<links.length;i++){try{var u=new URL(links[i].getAttribute('href')||'',location.href),m=u.pathname.match(/^\/@([^/]+)/);if(m)return decodeURIComponent(m[1]);}catch(e){}}
    return '';
  }
  function reactVideoId(root){
    if(!root)return '';
    var queue=[],seen=new Set(),steps=0;
    Object.keys(root).filter(function(key){return /^__reactFiber\$/.test(key);}).forEach(function(key){try{queue.push(root[key]);}catch(e){}});
    function valid(value){return /^\d{12,24}$/.test(String(value||''));}
    while(queue.length&&steps++<180){
      var node=queue.shift();if(!node||typeof node!=='object'||seen.has(node))continue;seen.add(node);
      var props=[];try{props.push(node.pendingProps,node.memoizedProps);}catch(e){}
      for(var pi=0;pi<props.length;pi++){
        var p=props[pi];if(!p||typeof p!=='object')continue;
        var item=p.item||(p.itemInfo&&p.itemInfo.itemStruct)||p.itemStruct||p.aweme;
        var ids=[item&&item.id,item&&item.awemeId,p.awemeId,p.videoId,p.itemId,p.id];
        for(var ii=0;ii<ids.length;ii++)if(valid(ids[ii]))return String(ids[ii]);
      }
      try{if(node.return)queue.push(node.return);if(node.child)queue.push(node.child);if(node.sibling)queue.push(node.sibling);}catch(e){}
    }
    return '';
  }
  function videoLink(root,video){
    var links=Array.prototype.slice.call((root||document).querySelectorAll('a[href*="/video/"]'));
    if(video&&video.closest){var own=video.closest('a[href*="/video/"]');if(own)links.unshift(own);}
    for(var i=0;i<links.length;i++){var p=parseVideo(links[i].getAttribute('href')||'');if(p)return p;}
    var id=reactVideoId(root),author=authorFor(root);
    if(id&&author)return {videoId:id,authorHandle:author,path:'/@'+author+'/video/'+id};
    return null;
  }
  var candidates=[];
  function addCandidate(parsed,r,vis){
    if(!parsed||!r||r.width<2||r.height<2||vis<=0)return;
    candidates.push({videoId:parsed.videoId,authorHandle:parsed.authorHandle,path:parsed.path,centerX:Math.round(r.left+r.width/2),centerY:Math.round(r.top+r.height/2),top:Math.round(r.top),bottom:Math.round(r.bottom),visibleRatio:Math.round(vis*1000)/1000,score:vis*1000-Math.abs((r.top+r.height/2)-(vh/2))});
  }
  var videos=Array.prototype.slice.call(document.querySelectorAll('video'));
  for(var vi=0;vi<videos.length;vi++){
    var video=videos[vi],vr=rectOf(video),vis=ratio(vr);if(vis<=0)continue;
    var root=rootFor(video),parsed=videoLink(root,video);
    if(!parsed){
      var allLinks=Array.prototype.slice.call(document.querySelectorAll('a[href*="/video/"]'));
      for(var li=0;li<allLinks.length;li++){
        var lr=rectOf(allLinks[li]);if(!lr)continue;
        var overlap=!(lr.right<vr.left||lr.left>vr.right||lr.bottom<vr.top||lr.top>vr.bottom);
        if(overlap){parsed=parseVideo(allLinks[li].getAttribute('href')||'');if(parsed)break;}
      }
    }
    addCandidate(parsed,vr,vis);
  }
  var locationVideo=parseVideo(location.href);
  if(locationVideo&&!candidates.some(function(c){return c.videoId===locationVideo.videoId;})){
    var detailEl=document.querySelector('video,[data-e2e="browse-video"],[data-e2e="video-detail"],main')||document.body;
    var dr=rectOf(detailEl)||{left:0,top:0,right:vw,bottom:vh,width:vw,height:vh};
    addCandidate(locationVideo,dr,Math.max(0.5,ratio(dr)));
  }
  if(candidates.length===0){
    var fallbackLinks=Array.prototype.slice.call(document.querySelectorAll('a[href*="/video/"]'));
    for(var fi=0;fi<fallbackLinks.length;fi++){var fr=rectOf(fallbackLinks[fi]);if(visible(fallbackLinks[fi]))addCandidate(parseVideo(fallbackLinks[fi].getAttribute('href')||''),fr,ratio(fr));}
  }
  var byId={};
  for(var ci=0;ci<candidates.length;ci++){var c=candidates[ci];if(!byId[c.videoId]||byId[c.videoId].score<c.score)byId[c.videoId]=c;}
  var unique=Object.keys(byId).map(function(id){return byId[id];}).sort(function(a,b){return b.score-a.score;});
  var current=unique[0]||null;
  var currentAmbiguous=!!(current&&unique[1]&&current.visibleRatio>=0.35&&unique[1].visibleRatio>=0.35&&Math.abs(current.visibleRatio-unique[1].visibleRatio)<0.2);

  var bodyText=String((document.body&&document.body.innerText)||'').slice(0,6000);
  var host=String(location.hostname||'').toLowerCase();
  var path=String(location.pathname||'/').slice(0,220);
  var isTikTok=host==='tiktok.com'||host.endsWith('.tiktok.com');
  var challengePath=/(?:captcha|challenge|verify|security-check)/i.test(path);
  var challengeNode=Array.prototype.slice.call(document.querySelectorAll('iframe[src*="captcha" i],[data-e2e*="captcha" i],[id*="captcha" i],[class*="captcha" i]')).some(visible);
  var challengeText=/(verify to continue|complete the puzzle|drag the slider|security check|安全验证|完成验证|拖动滑块|访问过于频繁)/i.test(bodyText);
  var loginPath=/^\/(?:login|signup)(?:\/|$)/i.test(path);
  var loginNode=Array.prototype.slice.call(document.querySelectorAll('input[type="password"],[data-e2e*="login-modal" i],form[action*="login" i]')).some(visible);
  var restricted=/(couldn.?t load page|page not available|access denied|something went wrong|暂时无法访问|页面不可用|访问受限)/i.test(bodyText);
  var loggedInNode=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="nav-profile"],[data-e2e="profile-icon"],[data-e2e="nav-profile-link"],a[data-e2e*="profile" i]')).some(visible);
  var loggedOutNode=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="top-login-button"],[data-e2e="login-button"]')).some(visible);
  var blockReason=!isTikTok?'not_tiktok':((challengePath||challengeNode||challengeText)?'challenge':((loginPath||loginNode)?'login_required':(restricted?'access_restricted':'none')));
  var loginState=loggedInNode?'logged_in':((loginPath||loginNode||loggedOutNode)?'logged_out':'unknown');

  function controlLabel(el){return [el.getAttribute('aria-label')||'',el.getAttribute('title')||'',el.getAttribute('data-e2e')||'',String(el.textContent||'').trim().slice(0,80)].join(' ').trim();}
  function withinCurrent(el){if(!current)return false;var r=rectOf(el);if(!r)return false;var cy=r.top+r.height/2;return cy>=current.top-100&&cy<=current.bottom+100;}
  function controls(kind){
    var nodes=Array.prototype.slice.call(document.querySelectorAll('button,[role="button"]'));
    var out=[];
    for(var i=0;i<nodes.length;i++){
      var el=nodes[i];if(!visible(el)||!withinCurrent(el))continue;
      var label=controlLabel(el),e2e=String(el.getAttribute('data-e2e')||'');
      var ok=kind==='like'?(/(?:^|[-_])like(?:[-_]|$)/i.test(e2e)||/(?:^|\b)(?:like|unlike)(?:\b|$)|点赞|按赞|讚|喜歡|取消点赞|取消讚|取消喜歡/i.test(label)):(/(?:^|[-_])comment(?:[-_]|$)/i.test(e2e)||/(?:^|\b)(?:comment|comments)(?:\b|$)|评论|評論/i.test(label));
      if(!ok)continue;
      if(kind==='comment'&&/(?:comment-input|submit|post|send)|发送|發佈|发布/i.test(e2e+' '+label))continue;
      if(out.indexOf(el)<0)out.push(el);
    }
    return out;
  }
  function point(el){var r=rectOf(el);return r?{centerX:Math.round(r.left+r.width/2),centerY:Math.round(r.top+r.height/2)}:{};}
  function likeState(el){
    if(!el)return {state:'unknown',evidence:'missing'};
    var label=controlLabel(el),pressed=el.getAttribute('aria-pressed'),liked=el.getAttribute('data-liked');
    if(pressed==='true'||liked==='true'||/(unlike|remove like|bỏ thích video|取消点赞|取消讚|取消喜歡|已点赞|已按赞)/i.test(label))return {state:'liked',evidence:pressed==='true'?'aria_pressed':(liked==='true'?'data_liked':'label_unlike')};
    var colors=[];var icon=el.querySelector('svg,path');
    if(icon){colors.push(icon.getAttribute('fill')||'',icon.getAttribute('stroke')||'');try{var cs=getComputedStyle(icon);colors.push(cs.color||'',cs.fill||'');}catch(e){}}
    if(colors.some(function(v){return /#fe2c55|rgb\(254\s*,\s*44\s*,\s*85\)/i.test(v);}))return {state:'liked',evidence:'icon_color'};
    if(pressed==='false'||liked==='false'||/(^|\b)like(?: video)?($|\b)|^thích video|点赞|按赞|讚|喜歡/i.test(label))return {state:'unliked',evidence:pressed==='false'?'aria_pressed_false':(liked==='false'?'data_liked_false':'label_like')};
    return {state:'unknown',evidence:'unclassified'};
  }
  var likeNodes=controls('like'),commentNodes=controls('comment');
  var like={found:likeNodes.length===1,ambiguous:likeNodes.length>1};
  if(likeNodes.length===1){var lp=point(likeNodes[0]),ls=likeState(likeNodes[0]);like.centerX=lp.centerX;like.centerY=lp.centerY;like.state=ls.state;like.evidence=ls.evidence;}
  var commentOpener={found:commentNodes.length===1,ambiguous:commentNodes.length>1};
  if(commentNodes.length===1){var cp=point(commentNodes[0]);commentOpener.centerX=cp.centerX;commentOpener.centerY=cp.centerY;}

  function editorNodes(){
    var nodes=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-input"] [contenteditable="true"],[data-e2e="comment-input"] textarea,[contenteditable="true"],textarea'));
    return nodes.filter(function(el){if(!visible(el))return false;var label=[el.getAttribute('aria-label')||'',el.getAttribute('placeholder')||'',el.getAttribute('data-placeholder')||'',(el.parentElement&&el.parentElement.getAttribute('data-e2e'))||''].join(' ');var inComment=!!(el.closest&&el.closest('[data-e2e*="comment" i],[class*="comment" i]'));var isSearch=!!(el.closest&&el.closest('[data-e2e*="search" i],[role="search"]'));return !isSearch&&(inComment||/(comment|评论|評論)/i.test(label));}).filter(function(el,idx,arr){return arr.indexOf(el)===idx;});
  }
  var editors=editorNodes();
  var editor={found:editors.length===1,ambiguous:editors.length>1};
  if(editors.length===1){var ev='value' in editors[0]?String(editors[0].value||''):String(editors[0].textContent||'');editor.textLength=ev.length;}
  var tops=[window.scrollY||0,(document.scrollingElement&&document.scrollingElement.scrollTop)||0];
  Array.prototype.slice.call(document.querySelectorAll('main,[data-e2e*="recommend-list" i],[class*="scroll" i]')).slice(0,30).forEach(function(el){if(typeof el.scrollTop==='number')tops.push(el.scrollTop);});
  return JSON.stringify({host:host,path:path,blockReason:blockReason,loginState:loginState,current:current?{videoId:current.videoId,authorHandle:current.authorHandle,path:current.path,centerX:current.centerX,centerY:current.centerY,top:current.top,bottom:current.bottom,visibleRatio:current.visibleRatio}:undefined,currentAmbiguous:currentAmbiguous,visibleVideoIds:unique.map(function(v){return v.videoId;}).slice(0,12),scrollTop:Math.round(Math.max.apply(Math,tops)),like:like,commentOpener:commentOpener,editor:editor});
})()`;

const TIKTOK_EDITOR_FOCUS_JS = String.raw`(function(){/*aidcp:tiktok-editor-focus*/
  var vw=Math.max(1,window.innerWidth||document.documentElement.clientWidth||1280),vh=Math.max(1,window.innerHeight||document.documentElement.clientHeight||800);
  function visible(el){if(!el||!el.getBoundingClientRect)return false;var r=el.getBoundingClientRect();if(r.width<2||r.height<2||r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw)return false;var s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden';}
  var nodes=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-input"] [contenteditable="true"],[data-e2e="comment-input"] textarea,[contenteditable="true"],textarea')).filter(function(el){if(!visible(el))return false;var label=[el.getAttribute('aria-label')||'',el.getAttribute('placeholder')||'',el.getAttribute('data-placeholder')||'',(el.parentElement&&el.parentElement.getAttribute('data-e2e'))||''].join(' ');var inComment=!!(el.closest&&el.closest('[data-e2e*="comment" i],[class*="comment" i]'));var isSearch=!!(el.closest&&el.closest('[data-e2e*="search" i],[role="search"]'));return !isSearch&&(inComment||/(comment|评论|評論)/i.test(label));});
  nodes=nodes.filter(function(el,idx,arr){return arr.indexOf(el)===idx;});
  if(nodes.length!==1)return JSON.stringify({ok:false,reason:nodes.length>1?'ambiguous':'editor_not_found'});
  var el=nodes[0],value='value' in el?String(el.value||''):String(el.textContent||'');
  if(value.length>0)return JSON.stringify({ok:false,reason:'editor_not_empty',textLength:value.length});
  el.focus();
  return JSON.stringify({ok:document.activeElement===el,reason:document.activeElement===el?undefined:'focus_failed',textLength:0});
})()`;

function buildEditorVerifyJs(expected: string): string {
  return String.raw`(function(){/*aidcp:tiktok-editor-verify*/
    var expected=${JSON.stringify(expected)};
    var vw=Math.max(1,window.innerWidth||document.documentElement.clientWidth||1280),vh=Math.max(1,window.innerHeight||document.documentElement.clientHeight||800);
    function visible(el){if(!el||!el.getBoundingClientRect)return false;var r=el.getBoundingClientRect();if(r.width<2||r.height<2||r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw)return false;var s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden';}
    var nodes=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-input"] [contenteditable="true"],[data-e2e="comment-input"] textarea,[contenteditable="true"],textarea')).filter(function(el){if(!visible(el))return false;var label=[el.getAttribute('aria-label')||'',el.getAttribute('placeholder')||'',el.getAttribute('data-placeholder')||'',(el.parentElement&&el.parentElement.getAttribute('data-e2e'))||''].join(' ');var inComment=!!(el.closest&&el.closest('[data-e2e*="comment" i],[class*="comment" i]'));var isSearch=!!(el.closest&&el.closest('[data-e2e*="search" i],[role="search"]'));return !isSearch&&(inComment||/(comment|评论|評論)/i.test(label));});
    nodes=nodes.filter(function(el,idx,arr){return arr.indexOf(el)===idx;});
    if(nodes.length!==1)return JSON.stringify({matches:false,textLength:0,reason:nodes.length>1?'ambiguous':'editor_not_found'});
    var value='value' in nodes[0]?String(nodes[0].value||''):String(nodes[0].textContent||'');
    return JSON.stringify({matches:value===expected,textLength:value.length});
  })()`;
}

export async function readTikTokPageSnapshot(cdp: BrowseCdp): Promise<TikTokPageSnapshot> {
  return evalJson<TikTokPageSnapshot>(cdp, TIKTOK_PAGE_SNAPSHOT_JS);
}

export function toTikTokSafeSnapshot(snapshot: TikTokPageSnapshot): TikTokSafeSnapshot {
  return {
    host: snapshot.host,
    path: snapshot.path,
    blockReason: snapshot.blockReason,
    loginState: snapshot.loginState,
    current: snapshot.current
      ? {
          videoId: snapshot.current.videoId,
          authorHandle: snapshot.current.authorHandle,
          path: snapshot.current.path,
        }
      : undefined,
    currentAmbiguous: snapshot.currentAmbiguous,
    visibleVideoIds: [...snapshot.visibleVideoIds],
    scrollTop: snapshot.scrollTop,
    like: {
      found: snapshot.like.found,
      ambiguous: snapshot.like.ambiguous,
      state: snapshot.like.state,
      evidence: snapshot.like.evidence,
    },
    commentOpener: {
      found: snapshot.commentOpener.found,
      ambiguous: snapshot.commentOpener.ambiguous,
    },
    editor: { ...snapshot.editor },
  };
}

export function isTikTokTargetUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'tiktok.com' || host.endsWith('.tiktok.com');
  } catch {
    return false;
  }
}

export function hasExactAdsPowerProfileMarker(
  targets: Array<{ type?: string; url?: string }>,
  profileId: string,
): boolean {
  return targets.some((target) => {
    if (target.type !== 'page') return false;
    try {
      const url = new URL(String(target.url ?? ''));
      return url.hostname === 'start.adspower.net' && url.searchParams.get('id') === profileId;
    } catch {
      return false;
    }
  });
}

export function isRealLikeAuthorized(
  profileId: string,
  execute: boolean,
  confirmedProfile: string | undefined,
): boolean {
  return execute && confirmedProfile === profileId;
}

export type TikTokBrowseStatus = 'browsed' | 'no_change' | 'blocked' | 'target_missing' | 'ambiguous' | 'input_failed';
export interface TikTokBrowseResult {
  status: TikTokBrowseStatus;
  executed: boolean;
  beforeVideoId?: string;
  afterVideoId?: string;
  reason?: string;
}

export type TikTokLikeStatus =
  | 'shadow'
  | 'gated'
  | 'already_liked'
  | 'ui_confirmed'
  | 'ambiguous'
  | 'blocked'
  | 'target_missing';
export interface TikTokLikeResult {
  status: TikTokLikeStatus;
  executed: boolean;
  videoId?: string;
  beforeState?: TikTokLikeState;
  afterState?: TikTokLikeState;
  confirmation: 'none' | 'ui_only';
  reason?: string;
}

export type TikTokCommentStatus =
  | 'filled_not_submitted'
  | 'blocked'
  | 'target_missing'
  | 'ambiguous'
  | 'editor_not_found'
  | 'editor_not_empty'
  | 'focus_failed'
  | 'target_changed'
  | 'invalid_text'
  | 'fill_unconfirmed';
export interface TikTokCommentResult {
  status: TikTokCommentStatus;
  executed: boolean;
  videoId?: string;
  textLength: number;
  matched: boolean;
  submitted: false;
  reason?: string;
}

export interface TikTokInteractionProbeOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: RandomFn;
  settleRounds?: number;
  settleIntervalMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class TikTokInteractionProbe {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: RandomFn;
  private readonly settleRounds: number;
  private readonly settleIntervalMs: number;

  constructor(
    private readonly cdp: BrowseCdp,
    options: TikTokInteractionProbeOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? defaultRandom;
    this.settleRounds = options.settleRounds ?? 12;
    this.settleIntervalMs = options.settleIntervalMs ?? 350;
  }

  inspect(): Promise<TikTokPageSnapshot> {
    return readTikTokPageSnapshot(this.cdp);
  }

  async browseNext(): Promise<TikTokBrowseResult> {
    const before = await this.inspect();
    if (before.blockReason !== 'none') {
      return { status: 'blocked', executed: false, reason: before.blockReason };
    }
    if (before.currentAmbiguous) {
      return { status: 'ambiguous', executed: false, reason: 'current_video_ambiguous' };
    }
    if (!before.current) {
      return { status: 'target_missing', executed: false, reason: 'current_video_missing' };
    }
    const beforeVideoId = before.current.videoId;
    const changedResult = async (): Promise<TikTokBrowseResult | null> => {
      for (let round = 0; round < this.settleRounds; round++) {
        await this.sleep(this.settleIntervalMs);
        const after = await this.inspect();
        if (after.blockReason !== 'none') {
          return { status: 'blocked', executed: true, beforeVideoId, reason: after.blockReason };
        }
        const changed =
          after.current?.videoId !== beforeVideoId ||
          after.scrollTop !== before.scrollTop ||
          !sameIds(after.visibleVideoIds, before.visibleVideoIds);
        if (changed) {
          return {
            status: 'browsed',
            executed: true,
            beforeVideoId,
            afterVideoId: after.current?.videoId,
          };
        }
      }
      return null;
    };

    try {
      const key = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 };
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      const moved = await changedResult();
      if (moved) return moved;
    } catch {
      // Match the existing Facebook Reels probe: a failed/unchanged key attempt falls through to wheel.
    }

    try {
      const deltaY = 70 + Math.floor(this.random() * 31);
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: before.current.centerX,
        y: Math.max(80, Math.min(before.current.centerY, before.current.bottom - 30)),
        deltaX: 0,
        deltaY,
      });
      const moved = await changedResult();
      if (moved) return moved;
    } catch (error) {
      return { status: 'input_failed', executed: true, beforeVideoId, reason: error instanceof Error ? error.message : String(error) };
    }
    return {
      status: 'no_change',
      executed: true,
      beforeVideoId,
      afterVideoId: beforeVideoId,
    };
  }

  async likeCurrent(options: {
    profileId: string;
    execute: boolean;
    confirmedProfile?: string;
  }): Promise<TikTokLikeResult> {
    const before = await this.inspect();
    if (before.blockReason !== 'none') {
      return { status: 'blocked', executed: false, confirmation: 'none', reason: before.blockReason };
    }
    if (before.loginState !== 'logged_in') {
      return { status: 'blocked', executed: false, confirmation: 'none', reason: `login_${before.loginState}` };
    }
    if (!before.current) {
      return { status: 'target_missing', executed: false, confirmation: 'none', reason: 'current_video_missing' };
    }
    if (before.currentAmbiguous || before.like.ambiguous) {
      return {
        status: 'ambiguous',
        executed: false,
        videoId: before.current.videoId,
        confirmation: 'none',
        reason: 'target_or_like_control_ambiguous',
      };
    }
    if (!before.like.found || before.like.state === 'unknown') {
      return {
        status: 'ambiguous',
        executed: false,
        videoId: before.current.videoId,
        beforeState: before.like.state,
        confirmation: 'none',
        reason: before.like.found ? 'like_state_unknown' : 'like_control_missing',
      };
    }
    if (before.like.state === 'liked') {
      return {
        status: 'already_liked',
        executed: false,
        videoId: before.current.videoId,
        beforeState: 'liked',
        afterState: 'liked',
        confirmation: 'ui_only',
      };
    }
    if (!options.execute) {
      return {
        status: 'shadow',
        executed: false,
        videoId: before.current.videoId,
        beforeState: 'unliked',
        confirmation: 'none',
      };
    }
    if (!isRealLikeAuthorized(options.profileId, options.execute, options.confirmedProfile)) {
      return {
        status: 'gated',
        executed: false,
        videoId: before.current.videoId,
        beforeState: 'unliked',
        confirmation: 'none',
        reason: 'profile_confirmation_mismatch',
      };
    }
    if (before.like.centerX === undefined || before.like.centerY === undefined) {
      return {
        status: 'ambiguous',
        executed: false,
        videoId: before.current.videoId,
        beforeState: 'unliked',
        confirmation: 'none',
        reason: 'like_coordinates_missing',
      };
    }

    await dispatchClick(this.cdp, before.like.centerX, before.like.centerY, {
      random: this.random,
      sleep: this.sleep,
    });

    let after = before;
    for (let round = 0; round < this.settleRounds; round++) {
      await this.sleep(this.settleIntervalMs);
      after = await this.inspect();
      if (after.blockReason !== 'none') break;
      if (after.current?.videoId !== before.current.videoId || after.currentAmbiguous || after.like.ambiguous) {
        return {
          status: 'ambiguous',
          executed: true,
          videoId: before.current.videoId,
          beforeState: 'unliked',
          afterState: after.like.state,
          confirmation: 'none',
          reason: 'target_changed_after_click',
        };
      }
      if (after.like.state === 'liked') {
        return {
          status: 'ui_confirmed',
          executed: true,
          videoId: before.current.videoId,
          beforeState: 'unliked',
          afterState: 'liked',
          confirmation: 'ui_only',
        };
      }
    }
    return {
      status: 'ambiguous',
      executed: true,
      videoId: before.current.videoId,
      beforeState: 'unliked',
      afterState: after.like.state,
      confirmation: 'none',
      reason: after.blockReason !== 'none' ? after.blockReason : 'like_state_not_confirmed',
    };
  }

  async fillCommentDraft(text: string): Promise<TikTokCommentResult> {
    const inputText = text.trim();
    if (!inputText || inputText.length > 120 || /[\r\n]/.test(inputText)) {
      return {
        status: 'invalid_text',
        executed: false,
        textLength: inputText.length,
        matched: false,
        submitted: false,
        reason: 'comment_probe_requires_single_line_1_to_120_chars',
      };
    }
    let snapshot = await this.inspect();
    if (snapshot.blockReason !== 'none') {
      return {
        status: 'blocked',
        executed: false,
        textLength: inputText.length,
        matched: false,
        submitted: false,
        reason: snapshot.blockReason,
      };
    }
    if (snapshot.loginState !== 'logged_in') {
      return {
        status: 'blocked',
        executed: false,
        textLength: inputText.length,
        matched: false,
        submitted: false,
        reason: `login_${snapshot.loginState}`,
      };
    }
    if (!snapshot.current) {
      return {
        status: 'target_missing',
        executed: false,
        textLength: inputText.length,
        matched: false,
        submitted: false,
        reason: 'current_video_missing',
      };
    }
    const videoId = snapshot.current.videoId;
    if (snapshot.currentAmbiguous) {
      return {
        status: 'ambiguous',
        executed: false,
        videoId,
        textLength: inputText.length,
        matched: false,
        submitted: false,
        reason: 'current_video_ambiguous',
      };
    }

    if (!snapshot.editor.found) {
      if (snapshot.editor.ambiguous || snapshot.commentOpener.ambiguous) {
        return {
          status: 'ambiguous',
          executed: false,
          videoId,
          textLength: inputText.length,
          matched: false,
          submitted: false,
          reason: 'editor_or_comment_control_ambiguous',
        };
      }
      if (
        !snapshot.commentOpener.found ||
        snapshot.commentOpener.centerX === undefined ||
        snapshot.commentOpener.centerY === undefined
      ) {
        return {
          status: 'editor_not_found',
          executed: false,
          videoId,
          textLength: inputText.length,
          matched: false,
          submitted: false,
          reason: 'comment_opener_missing',
        };
      }
      await dispatchClick(this.cdp, snapshot.commentOpener.centerX, snapshot.commentOpener.centerY, {
        random: this.random,
        sleep: this.sleep,
      });
      for (let round = 0; round < this.settleRounds; round++) {
        await this.sleep(this.settleIntervalMs);
        snapshot = await this.inspect();
        if (snapshot.blockReason !== 'none') {
          return {
            status: 'blocked',
            executed: true,
            videoId,
            textLength: inputText.length,
            matched: false,
            submitted: false,
            reason: snapshot.blockReason,
          };
        }
        if (snapshot.current?.videoId !== videoId || snapshot.currentAmbiguous) {
          return {
            status: 'target_changed',
            executed: true,
            videoId,
            textLength: inputText.length,
            matched: false,
            submitted: false,
            reason: 'target_changed_while_opening_comments',
          };
        }
        if (snapshot.editor.found || snapshot.editor.ambiguous) break;
      }
    }

    if (snapshot.editor.ambiguous) {
      return {
        status: 'ambiguous',
        executed: false,
        videoId,
        textLength: inputText.length,
        matched: false,
        submitted: false,
        reason: 'comment_editor_ambiguous',
      };
    }
    if (!snapshot.editor.found) {
      return {
        status: 'editor_not_found',
        executed: false,
        videoId,
        textLength: inputText.length,
        matched: false,
        submitted: false,
      };
    }
    if ((snapshot.editor.textLength ?? 0) > 0) {
      return {
        status: 'editor_not_empty',
        executed: false,
        videoId,
        textLength: inputText.length,
        matched: false,
        submitted: false,
        reason: `existing_draft_length_${snapshot.editor.textLength}`,
      };
    }

    const focused = await evalJson<{ ok: boolean; reason?: string; textLength?: number }>(this.cdp, TIKTOK_EDITOR_FOCUS_JS);
    if (!focused.ok) {
      const status: TikTokCommentStatus =
        focused.reason === 'editor_not_empty'
          ? 'editor_not_empty'
          : focused.reason === 'editor_not_found'
            ? 'editor_not_found'
            : focused.reason === 'ambiguous'
              ? 'ambiguous'
              : 'focus_failed';
      return {
        status,
        executed: false,
        videoId,
        textLength: inputText.length,
        matched: false,
        submitted: false,
        reason: focused.reason,
      };
    }

    const beforeInput = await this.inspect();
    if (beforeInput.current?.videoId !== videoId || beforeInput.currentAmbiguous || beforeInput.blockReason !== 'none') {
      return {
        status: 'target_changed',
        executed: false,
        videoId,
        textLength: inputText.length,
        matched: false,
        submitted: false,
        reason: 'target_changed_before_input',
      };
    }

    await this.cdp.send('Input.insertText', { text: inputText });
    const verified = await evalJson<{ matches: boolean; textLength: number; reason?: string }>(
      this.cdp,
      buildEditorVerifyJs(inputText),
    );
    return {
      status: verified.matches ? 'filled_not_submitted' : 'fill_unconfirmed',
      executed: true,
      videoId,
      textLength: verified.textLength,
      matched: verified.matches,
      submitted: false,
      reason: verified.reason,
    };
  }
}
