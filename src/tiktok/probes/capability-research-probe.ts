import { evalJson, type BrowseCdp } from '../../browse/cdp-util.js';
import {
  TikTokInteractionProbe,
  type TikTokBlockReason,
  type TikTokLoginState,
} from './interaction-probe.js';

export type TikTokResearchSurface =
  | 'for_you'
  | 'following'
  | 'profile'
  | 'video_detail'
  | 'live'
  | 'messages'
  | 'search'
  | 'tag'
  | 'music'
  | 'other';

export type TikTokEntryKind =
  | 'for_you'
  | 'following'
  | 'profile'
  | 'search'
  | 'tag'
  | 'music'
  | 'messages'
  | 'notifications'
  | 'live';

export type TikTokShadowStatus = 'shadow_ready' | 'missing' | 'ambiguous';
export type TikTokShadowState = 'active' | 'inactive' | 'unknown';

export interface TikTokEntryInventory {
  candidateCount: number;
  status: 'present' | 'missing' | 'ambiguous';
}

export interface TikTokShadowControl {
  candidateCount: number;
  status: TikTokShadowStatus;
  state: TikTokShadowState;
}

export interface TikTokCapabilityPageSnapshot {
  surface: TikTokResearchSurface;
  uiLocale: string;
  langAttribute: string;
  hydrated: boolean;
  entries: Record<TikTokEntryKind, TikTokEntryInventory>;
  social: {
    follow: TikTokShadowControl;
    collect: TikTokShadowControl;
    share: TikTokShadowControl;
  };
  replyLanguage: 'unconfigured';
  replyBlocked: true;
}

export interface TikTokCapabilityResearchSnapshot extends TikTokCapabilityPageSnapshot {
  blockReason: TikTokBlockReason;
  loginState: TikTokLoginState;
  currentVideoId?: string;
  currentVideoAmbiguous: boolean;
}

export const TIKTOK_CAPABILITY_PAGE_JS = String.raw`(() => {/*aidcp:tiktok-capability-research*/
  var vw=Math.max(1,window.innerWidth||document.documentElement.clientWidth||1280);
  var vh=Math.max(1,window.innerHeight||document.documentElement.clientHeight||800);
  function visible(el){
    if(!el||!el.getBoundingClientRect)return false;
    var r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>1&&r.height>1&&r.bottom>0&&r.top<vh&&r.right>0&&r.left<vw&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';
  }
  function surface(){
    var p=String(location.pathname||'/');
    if(p==='/foryou')return 'for_you';
    if(p==='/following')return 'following';
    if(/^\/@[^/]+\/video\/\d+/.test(p))return 'video_detail';
    if(/^\/@[^/]+/.test(p))return 'profile';
    if(/^\/live(?:\/|$)/.test(p))return 'live';
    if(/^\/messages(?:\/|$)/.test(p))return 'messages';
    if(/^\/search(?:\/|$)/.test(p))return 'search';
    if(/^\/tag(?:\/|$)/.test(p))return 'tag';
    if(/^\/music(?:\/|$)/.test(p))return 'music';
    return 'other';
  }
  function unique(nodes){return Array.from(new Set(nodes)).filter(visible);}
  function inventory(nodes){
    var count=unique(nodes).length;
    return {candidateCount:count,status:count===0?'missing':count===1?'present':'ambiguous'};
  }
  function selectAll(selector){try{return Array.from(document.querySelectorAll(selector));}catch(e){return [];}}
  function matching(selector,pattern){
    return selectAll(selector).filter(function(el){
      var hay=[el.getAttribute('data-e2e')||'',el.getAttribute('aria-label')||'',el.getAttribute('placeholder')||''].join(' ');
      return pattern.test(hay);
    });
  }
  var entries={
    for_you:inventory(selectAll('[data-e2e="nav-for-you"],a[href="/foryou"]')),
    following:inventory(selectAll('[data-e2e="nav-following"],a[href="/following"]')),
    profile:inventory(selectAll('a[data-e2e="nav-profile"][href],a[data-e2e="nav-profile-link"][href]')),
    search:inventory(
      selectAll('a[href^="/search"],[data-e2e*="search" i],[role="searchbox"]')
        .concat(matching('input[placeholder],[aria-label]',/search|tìm kiếm|搜索|搜尋/i))
    ),
    tag:inventory(selectAll('a[href^="/tag/"]')),
    music:inventory(selectAll('a[href^="/music/"]')),
    messages:inventory(
      selectAll('a[href^="/messages"],[data-e2e*="message" i]')
        .concat(matching('[aria-label]',/message|tin nhắn|消息|訊息/i))
    ),
    notifications:inventory(
      selectAll('[data-e2e*="notification" i],[data-e2e*="inbox" i]')
        .concat(matching('[aria-label]',/notification|activity|hộp thư|thông báo|通知|收件箱/i))
    ),
    live:inventory(selectAll('a[href^="/live"],[data-e2e*="live" i]'))
  };
  function shadow(selector){
    var nodes=unique(selectAll(selector));
    var state='unknown';
    if(nodes.length===1){
      var pressed=nodes[0].getAttribute('aria-pressed');
      if(pressed==='true')state='active';
      else if(pressed==='false')state='inactive';
    }
    return {
      candidateCount:nodes.length,
      status:nodes.length===0?'missing':nodes.length===1?'shadow_ready':'ambiguous',
      state:state
    };
  }
  var host=String(location.hostname||'').toLowerCase();
  var isTikTok=host==='tiktok.com'||host.endsWith('.tiktok.com');
  var semanticCount=Object.keys(entries).reduce(function(sum,key){return sum+entries[key].candidateCount;},0);
  var hasVideo=unique(selectAll('video,[data-e2e="recommend-list-item-container"],[data-e2e="browse-video"],[data-e2e="video-detail"]')).length>0;
  return JSON.stringify({
    surface:surface(),
    uiLocale:String(navigator.language||''),
    langAttribute:String(document.documentElement.lang||''),
    hydrated:isTikTok&&(semanticCount>0||hasVideo),
    entries:entries,
    social:{
      follow:shadow('[data-e2e="feed-follow"]'),
      collect:shadow('[data-e2e="favorite-icon"]'),
      share:shadow('[data-e2e="share-icon"]')
    },
    replyLanguage:'unconfigured',
    replyBlocked:true
  });
})()`;

const TIKTOK_OWN_PROFILE_URL_JS = String.raw`(() => {/*aidcp:tiktok-own-profile-url*/
  var vw=Math.max(1,window.innerWidth||document.documentElement.clientWidth||1280);
  var vh=Math.max(1,window.innerHeight||document.documentElement.clientHeight||800);
  function visible(el){
    if(!el||!el.getBoundingClientRect)return false;
    var r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>1&&r.height>1&&r.bottom>0&&r.top<vh&&r.right>0&&r.left<vw&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';
  }
  var nodes=Array.from(document.querySelectorAll('a[data-e2e="nav-profile"][href]')).filter(visible);
  if(nodes.length!==1)return JSON.stringify({status:nodes.length===0?'missing':'ambiguous'});
  try{
    var url=new URL(nodes[0].getAttribute('href')||'',location.href);
    var host=String(url.hostname||'').toLowerCase();
    if(!(host==='tiktok.com'||host.endsWith('.tiktok.com'))||!/^\/@[^/]+(?:\/|$)/.test(url.pathname)){
      return JSON.stringify({status:'invalid'});
    }
    return JSON.stringify({status:'ready',href:url.origin+url.pathname});
  }catch(e){
    return JSON.stringify({status:'invalid'});
  }
})()`;

export const TIKTOK_OFFICIAL_API_READINESS = Object.freeze({
  source: 'official_documentation',
  capabilities: Object.freeze({
    loginKit: 'documented',
    displayApi: 'documented',
    uploadDraft: 'documented',
    directPost: 'documented',
    creatorInfo: 'documented',
    publishStatusAndWebhooks: 'documented',
  }),
  localConfiguration: 'not_checked',
  credentialsAccessed: false,
  networkCallsExecuted: false,
} as const);

export class TikTokCapabilityResearchProbe {
  constructor(private readonly cdp: BrowseCdp) {}

  async inspect(): Promise<TikTokCapabilityResearchSnapshot> {
    const [page, interaction] = await Promise.all([
      evalJson<TikTokCapabilityPageSnapshot>(this.cdp, TIKTOK_CAPABILITY_PAGE_JS),
      new TikTokInteractionProbe(this.cdp).inspect(),
    ]);
    const stableForYouTarget =
      page.surface !== 'for_you' || Boolean(interaction.current && !interaction.currentAmbiguous);
    return {
      ...page,
      hydrated: page.hydrated && stableForYouTarget,
      blockReason: interaction.blockReason,
      loginState: interaction.loginState,
      currentVideoId: interaction.current?.videoId,
      currentVideoAmbiguous: interaction.currentAmbiguous,
    };
  }

  async discoverOwnProfileUrl(): Promise<
    { status: 'ready'; href: string } | { status: 'missing' | 'ambiguous' | 'invalid' }
  > {
    return evalJson(this.cdp, TIKTOK_OWN_PROFILE_URL_JS);
  }
}
