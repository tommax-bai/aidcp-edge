async function(input){
  'use strict';
  const kind=String(input.kind||'');
  const p=input.params&&typeof input.params==='object'?input.params:{};
  const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
  const norm=(value,max=2000)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,max);
  const visible=(el)=>{
    if(!el||!el.getBoundingClientRect)return false;
    const rect=el.getBoundingClientRect();
    const style=window.getComputedStyle?getComputedStyle(el):null;
    return rect.width>1&&rect.height>1&&(!style||(style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)>0.05));
  };
  const all=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const first=(selectors,root=document)=>{
    for(const selector of selectors){
      const hit=all(selector,root).find(visible);
      if(hit)return hit;
    }
    return null;
  };
  const text=(el,max=2000)=>norm(el&&(el.innerText||el.textContent||(el.getAttribute&&el.getAttribute('aria-label'))),max);
  const label=(el,max=256)=>norm(el&&((el.getAttribute&&el.getAttribute('aria-label'))||(el.getAttribute&&el.getAttribute('title'))||text(el,max)),max);
  const count=(value)=>{
    const raw=norm(value,96).toLowerCase().replace(/,/g,'');
    const hit=raw.match(/(\d+(?:\.\d+)?)\s*(k|m|万|萬|w)?/);
    if(!hit)return 0;
    const base=Number(hit[1])||0;
    return Math.max(0,Math.round(base*(hit[2]==='m'?1000000:hit[2]==='k'?1000:/^(万|萬|w)$/.test(hit[2]||'')?10000:1)));
  };
  const done=(output,effectPhase='confirmed')=>({effectPhase,output});
  const action=(name,ok,reason,extra={})=>({kind:'action_receipt',value:{action:name,ok,...(reason?{reason}:{}),...extra}});
  const fail=(name,reason)=>done(action(name,false,reason),'not_started');
  const ambiguous=(name,reason,extra={})=>done(action(name,false,reason,extra),'ambiguous');
  const click=(el)=>{
    if(!visible(el))return false;
    el.scrollIntoView&&el.scrollIntoView({block:'center',inline:'center'});
    try{el.click();return true;}catch{return false;}
  };
  const fill=(el,value)=>{
    if(!el)return false;
    el.focus();
    if('value' in el){
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const descriptor=Object.getOwnPropertyDescriptor(proto,'value');
      if(descriptor&&descriptor.set)descriptor.set.call(el,value);else el.value=value;
    }else{
      el.textContent=value;
    }
    for(const event of ['input','change'])el.dispatchEvent(new Event(event,{bubbles:true,composed:true}));
    return true;
  };
  const point=(el)=>{
    if(!visible(el))return null;
    const rect=el.getBoundingClientRect();
    return {cx:rect.left+rect.width/2,cy:rect.top+rect.height/2};
  };
  const pressed=(el)=>Boolean(el&&(
    el.getAttribute('aria-pressed')==='true'
    || el.getAttribute('aria-checked')==='true'
    || el.getAttribute('aria-selected')==='true'
    || /(^|\s)(selected|active|liked|followed)(\s|$)/i.test(String(el.className||''))
  ));
  const classify=()=>{
    const path=location.pathname.toLowerCase();
    if(path.includes('/checkpoint'))return 'checkpoint';
    if(path.includes('/login')||path.includes('/recover'))return 'login';
    if(path.startsWith('/search/'))return 'search';
    if(path==='/reels'||path.startsWith('/reels/'))return 'reels';
    if(/^\/groups\/[^/]+\/posts\/[^/]+/.test(path)||(path.startsWith('/groups/')&&new URL(location.href).searchParams.has('multi_permalinks')))return 'group_post';
    if(path.startsWith('/groups/'))return 'group';
    if(/\/posts\/[^/]+/.test(path)||path.includes('/permalink.php')||/\/videos\/[^/]+/.test(path)||/^\/reel\/[^/]+/.test(path)||path.startsWith('/watch'))return 'page_post';
    if(path==='/'||path==='/home.php')return 'home';
    return path.split('/').filter(Boolean).length===1?'page':'unknown';
  };
  const permalinkKind=(href)=>{
    try{
      const url=new URL(href,location.origin);
      const path=url.pathname.toLowerCase();
      if(/^\/groups\/[^/]+\/posts\/[^/]+/.test(path)||(path.startsWith('/groups/')&&url.searchParams.has('multi_permalinks')))return 'group_post';
      if(/\/posts\/[^/]+/.test(path)||path.includes('/permalink.php')||/\/videos\/[^/]+/.test(path)||reelIdFromPath(path)||((path==='/watch'||path==='/watch/')&&url.searchParams.has('v')))return 'page_post';
      if(url.searchParams.has('story_fbid'))return 'story';
    }catch{}
    return 'unknown';
  };
  const reelIdFromPath=(pathname)=>{
    const hit=String(pathname||'').match(/^\/reel\/([^/]+)/i);
    if(!hit)return '';
    const id=hit[1];
    return /^(?:hashtag|audio|music|topics?)$/i.test(id)?'':id;
  };
  const cleanPermalink=(href)=>{
    try{
      const url=new URL(href,location.origin);
      if(!(url.hostname==='facebook.com'||url.hostname.endsWith('.facebook.com')))return '';
      const kind=permalinkKind(url.href);
      if(kind==='unknown')return '';
      const clean=new URL(url.origin+url.pathname.replace(/\/+$/,''));
      if(kind==='group_post'&&url.searchParams.has('multi_permalinks'))clean.searchParams.set('multi_permalinks',url.searchParams.get('multi_permalinks')||'');
      else if(kind==='story'||url.pathname.toLowerCase().includes('/permalink.php')){
        if(url.searchParams.has('story_fbid'))clean.searchParams.set('story_fbid',url.searchParams.get('story_fbid')||'');
        if(url.searchParams.has('id'))clean.searchParams.set('id',url.searchParams.get('id')||'');
      }else if((url.pathname==='/watch'||url.pathname==='/watch/')&&url.searchParams.has('v'))clean.searchParams.set('v',url.searchParams.get('v')||'');
      return clean.href;
    }catch{return '';}
  };
  const postId=(href)=>{
    try{
      const url=new URL(href,location.origin);
      let hit=url.pathname.match(/^\/groups\/([^/]+)\/posts\/([^/]+)/i);if(hit)return `group:${hit[1]}:${hit[2]}`;
      if(url.pathname.startsWith('/groups/')&&url.searchParams.get('multi_permalinks'))return `group:${url.pathname.split('/')[2]}:${url.searchParams.get('multi_permalinks')}`;
      hit=url.pathname.match(/\/posts\/([^/]+)/i);if(hit)return `post:${hit[1]}`;
      hit=url.pathname.match(/\/videos\/([^/]+)/i);if(hit)return `video:${hit[1]}`;
      const reelId=reelIdFromPath(url.pathname);if(reelId)return `reel:${reelId}`;
      if(url.searchParams.get('story_fbid'))return `story:${url.searchParams.get('story_fbid')}`;
      if(url.searchParams.get('v'))return `video:${url.searchParams.get('v')}`;
    }catch{}
    return '';
  };
  const permalinkOf=(root)=>{
    const links=all('a[href]',root);
    for(const link of links){
      const href=cleanPermalink(link.href||link.getAttribute('href')||'');
      if(href)return href;
    }
    return '';
  };
  // 服务器已签发的评论 id 判据。判的是 provenance（平台点头没有），不是某一种编码：
  // 真机同时存在 base64 `comment:` 形态（Y29tbWVudD…）与纯数字形态（2026-07-28 越南语群 feed 就地评论，
  // Enter+73ms 是占位 `client:<uuid>`、Enter+4.29s 换成 1531497545657803 并刷新后仍在）。
  // 只认 base64 会让数字形态的已上墙评论永远确认不了 = 假失败（照样打去重、烧掉目标）。
  // 客户端占位一律拒绝：带 client 标记的、或裸 UUID 的都不算服务器确认。
  const clientPlaceholderCommentId=(id)=>/client/i.test(id)||/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
  const isServerCommentId=(value)=>{
    const id=String(value||'').trim();
    if(id.length<6)return false;
    if(clientPlaceholderCommentId(id))return false;
    return /^\d{6,}$/.test(id)||/^[A-Za-z0-9_+/=-]{10,}$/.test(id);
  };
  // 从一条链接里取出「这是谁」的数字身份。群 feed 里评论作者链接是 /groups/<gid>/user/<uid>/ 形态
  // （2026-07-28 真机：/groups/600322513093927/user/61591934100810/），只认 ?id= 与 /people/<name>/<id>
  // 会让群内评论的本人身份判据恒不成立 → 自己刚发的评论永远不被认作自己的 = 假失败。
  const identityFromHref=(href)=>{
    try{
      const url=new URL(href||'',location.origin);
      return url.searchParams.get('id')
        ||(url.pathname.match(/\/people\/[^/]+\/(\d{5,})/)||[])[1]
        ||(url.pathname.match(/\/groups\/[^/]+\/user\/(\d{5,})/)||[])[1]
        ||'';
    }catch{return '';}
  };
  const carriesOwnIdentity=(row,ownId)=>{
    const own=String(ownId||'').trim();
    if(!own)return false;
    return all('a[href]',row).some((link)=>identityFromHref(link.href||link.getAttribute('href')||'')===own);
  };
  const hasServerCommentId=(row)=>all('a[href*="comment_id="]',row).some((link)=>{
    try{
      return isServerCommentId(new URL(link.href||link.getAttribute('href')||'',location.origin).searchParams.get('comment_id')||'');
    }catch{return false;}
  });
  const firstPostTargetPrefix='aidcp:facebook-group-feed-post:v1:';
  const isFirstPostTarget=(value)=>new RegExp(`^${firstPostTargetPrefix}[0-9a-f]{64}$`).test(String(value||''));
  const firstPostGroupScope=()=>{
    const hit=location.pathname.match(/^\/groups\/([^/?#]+)/i);
    return hit?`${location.origin}/groups/${hit[1]}`:'';
  };
  const stableFirstPostLinkEvidence=(root)=>{
    const values=[];
    for(const link of all('a[href]',root)){
      try{
        const url=new URL(link.href||link.getAttribute('href')||'',location.origin);
        const path=url.pathname.replace(/\/+$/,'');
        if(/^\/groups\/[^/]+\/user\/[^/]+$/i.test(path)||/\/people\/[^/]+\/\d+$/i.test(path)){
          values.push(`author:${path.toLowerCase()}`);
          continue;
        }
        const profileId=url.searchParams.get('id');
        if(path.toLowerCase()==='/profile.php'&&profileId)values.push(`author:id:${profileId}`);
        const photoId=url.searchParams.get('fbid');
        if(photoId)values.push(`photo:${photoId}`);
        const videoId=(path.match(/\/videos\/([^/]+)/i)||[])[1]||url.searchParams.get('v');
        if(videoId)values.push(`video:${videoId}`);
      }catch{}
    }
    return [...new Set(values)].sort().join('|');
  };
  const firstPostBodyEvidence=(root)=>{
    const witness=first([
      '[data-ad-rendering-role="story_message"]',
      '[data-ad-preview="message"]',
      '[data-ad-comet-preview="message"]',
    ],root);
    if(witness)return text(witness,12000);
    const candidates=all('div[dir="auto"]',root).filter(visible).filter((element)=>{
      if(element.closest('[contenteditable="true"],textarea'))return false;
      const owner=closestArticle(element);
      return !owner||owner===root;
    }).map((element)=>text(element,12000)).filter((value)=>
      value.length>1&&!postComment.test(value)
    );
    return candidates.sort((left,right)=>right.length-left.length)[0]||'';
  };
  const firstPostEvidence=(root)=>{
    if(!root||!root.isConnected)return null;
    const scope=firstPostGroupScope();
    if(!scope)return null;
    const author=articleAuthor(root);
    const authorHref=(()=>{
      try{
        const url=new URL(author.href||'',location.origin);
        return `${url.pathname.replace(/\/+$/,'')}${url.searchParams.get('id')?`?id=${url.searchParams.get('id')}`:''}`;
      }catch{return '';}
    })();
    const body=firstPostBodyEvidence(root);
    const linkEvidence=stableFirstPostLinkEvidence(root);
    const mediaEvidence=all('img,video',root).filter(visible).map((element)=>{
      if(element.tagName==='VIDEO')return norm(
        element.getAttribute('data-video-id')||element.getAttribute('aria-label')||'',
        256,
      );
      return norm(element.alt||'',256);
    }).filter(Boolean).sort().join('|');
    const authorEvidence=authorHref||norm(author.name,200);
    const contentEvidence=body||linkEvidence||mediaEvidence;
    if(!authorEvidence||!contentEvidence)return null;
    return {
      value:[scope,authorEvidence,body,linkEvidence,mediaEvidence].join('\n'),
      author:author.name||undefined,
      body,
    };
  };
  const firstPostTargetRef=async(evidence)=>{
    const bytes=new TextEncoder().encode(evidence);
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const hex=Array.from(new Uint8Array(digest),(value)=>value.toString(16).padStart(2,'0')).join('');
    return `${firstPostTargetPrefix}${hex}`;
  };
  const firstPostTargetState=()=>{
    const scope=firstPostGroupScope();
    let state=window.__aidcpNativeFirstPostTargets;
    if(!state||state.scope!==scope||!(state.targets instanceof Map)){
      state={scope,targets:new Map()};
      window.__aidcpNativeFirstPostTargets=state;
    }
    return state;
  };
  const bindFirstPostTarget=async(root,evidence)=>{
    const targetRef=await firstPostTargetRef(evidence.value);
    const state=firstPostTargetState();
    const existing=state.targets.get(targetRef);
    if(existing&&existing.root!==root&&existing.root&&existing.root.isConnected){
      return {ok:false,reason:'ambiguous_target'};
    }
    for(const marked of all('[data-aidcp-native-first-post-target]')){
      if(marked!==root&&marked.getAttribute('data-aidcp-native-first-post-target')===targetRef){
        return {ok:false,reason:'ambiguous_target'};
      }
    }
    root.setAttribute('data-aidcp-native-first-post-target',targetRef);
    state.targets.set(targetRef,{root,evidence:evidence.value});
    return {ok:true,targetRef};
  };
  const boundFirstPostRoot=(targetRef)=>{
    if(!isFirstPostTarget(targetRef))return null;
    const state=window.__aidcpNativeFirstPostTargets;
    if(!state||state.scope!==firstPostGroupScope()||!(state.targets instanceof Map))return null;
    const record=state.targets.get(targetRef);
    if(!record||!record.root||!record.root.isConnected)return null;
    if(record.root.getAttribute('data-aidcp-native-first-post-target')!==targetRef)return null;
    const matches=all('[data-aidcp-native-first-post-target]').filter((root)=>
      root.isConnected&&root.getAttribute('data-aidcp-native-first-post-target')===targetRef
    );
    if(matches.length!==1||matches[0]!==record.root)return null;
    const current=firstPostEvidence(record.root);
    return current&&current.value===record.evidence?record.root:null;
  };
  // 帖子正文标记与作者链接：回落找卡的两个锚点，逐字对齐退役实现 src/facebook/post-identity.ts:22-23。
  const storyMessageSelector='[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-ad-rendering-role="story_message"]';
  const authorLinkSelector='h2 a[href],h3 a[href],h4 a[href]';
  // 水合证据：作者链接**或**正文标记（取或，不取与）。Facebook 的虚拟化 feed 会先渲染只占高度的空壳，
  // 只判可见性会把空壳当成真卡——那正是「有物理卡但读不出来」被假依据触发的成因。
  const hydratedCard=(el)=>Boolean(el&&el.querySelector&&(el.querySelector(authorLinkSelector)||el.querySelector(storyMessageSelector)));
  const semanticArticles=()=>{
    const nodes=all('[role="article"],article').filter(visible);
    return nodes.filter((node)=>!node.parentElement||!node.parentElement.closest('[role="article"],article'));
  };
  /**
   * 回落找卡（退役实现 post-identity.ts:87-106 的等价物）。Facebook 有一类版式既没有
   * `div[role="feed"]` 容器、`[role="article"]` 也只剩空壳（2026-07-29 越南语首页实测：feed 容器 0、
   * 语义卡 2 个且都是 286px 空壳、真实条目 11 个）。此路不依赖任何语义 role：以帖子正文标记为种子，
   * 向上走到第一个「自身之外且内部含作者链接」的祖先当卡边界。
   * 红线：走到 body / documentElement 仍无作者证据即**不成卡**，绝不回落到整页或 main —— 那是静默假成功。
   */
  const fallbackArticles=()=>{
    const found=[];
    for(const seed of all(storyMessageSelector)){
      if(!visible(seed))continue;
      if(seed.closest&&seed.closest('div[role="feed"]'))continue; // 真 feed 交语义路，避免一帖两卡
      let cur=seed;
      while(cur&&cur!==document.body&&cur!==document.documentElement){
        if(cur!==seed&&cur.querySelector&&cur.querySelector(authorLinkSelector))break;
        cur=cur.parentElement;
      }
      if(!cur||cur===document.body||cur===document.documentElement)continue;
      if(!visible(cur))continue;
      if(!found.includes(cur))found.push(cur);
    }
    // 分享 / 引用帖会让内层也命中正文标记；只留最外层，避免一帖两卡与跨卡误归因。
    return found.filter((node,index)=>!found.some((other,other_index)=>other_index!==index&&other.contains(node)));
  };
  const mergeArticles=(primary,secondary)=>{
    const out=primary.slice();
    for(const card of secondary){
      if(out.some((kept)=>kept===card||kept.contains(card)||card.contains(kept)))continue;
      out.push(card);
    }
    // 4 = DOCUMENT_POSITION_FOLLOWING。用字面量而非 Node.* ——注入脚本也跑在没有 Node 全局的
    // 求值环境里（jsdom 测试夹具即是），引用全局会当场 ReferenceError 把整条找卡打断。
    return out.sort((a,b)=>a===b?0:(a.compareDocumentPosition(b)&4)?-1:1);
  };
  // 发现宽、计数严：此处**不**加水合过滤——未水合的壳后续轮次可能水合，过早丢弃会让虚拟化列表少扫一批。
  // 「有物理卡」的判定另用 hydratedCard（见 20-feed.js 的 articleCount）。
  const topArticles=()=>mergeArticles(semanticArticles(),fallbackArticles());
  /** 已水合的卡 = 「有物理卡」的唯一判据（present_unreportable 的准入证据、articleCount 的口径）。 */
  const hydratedCards=()=>topArticles().filter(hydratedCard);
  const reelSurface=()=>{
    const path=location.pathname.toLowerCase();
    return classify()==='reels'||/^\/reel(?:\/|$)/.test(path);
  };
  const viewportArea=(rect)=>{
    const left=Math.max(0,rect.left);
    const top=Math.max(0,rect.top);
    const right=Math.min(window.innerWidth||0,rect.right);
    const bottom=Math.min(window.innerHeight||0,rect.bottom);
    return Math.max(0,right-left)*Math.max(0,bottom-top);
  };
  const rectDistance=(left,right)=>{
    const dx=Math.max(0,left.left-right.right,right.left-left.right);
    const dy=Math.max(0,left.top-right.bottom,right.top-left.bottom);
    return Math.sqrt(dx*dx+dy*dy);
  };
  const reelVideoKey=(video)=>{
    let state=window.__aidcpNativeReelVideoKeys;
    if(!state){
      state={seq:0,keys:new WeakMap()};
      window.__aidcpNativeReelVideoKeys=state;
    }
    let elementId=state.keys.get(video);
    if(!elementId){
      elementId=++state.seq;
      state.keys.set(video,elementId);
    }
    return `${String(video.currentSrc||video.src||video.poster||video.getAttribute('src')||'').slice(0,2048)}@element:${elementId}`;
  };
  const reelPermalinkOf=(root)=>{
    const matches=all('a[href]',root).map((link)=>cleanPermalink(link.href||link.getAttribute('href')||''))
      .filter((href)=>postId(href).startsWith('reel:'));
    return matches.length===1?matches[0]:'';
  };
  const activeReel=()=>{
    if(!reelSurface())return {ok:false,reason:'not_reel'};
    const videos=all('video').map((video,index)=>{
      const rect=video.getBoundingClientRect();
      return {
        video,
        index,
        rect,
        area:viewportArea(rect),
        distance:Math.abs((rect.top+rect.bottom)/2-(window.innerHeight||0)/2),
      };
    }).filter((candidate)=>candidate.area>0)
      .sort((left,right)=>right.area-left.area||left.distance-right.distance);
    if(!videos.length)return {ok:false,reason:'no_active_video'};
    if(videos.length>1&&Math.abs(videos[0].area-videos[1].area)<1&&Math.abs(videos[0].distance-videos[1].distance)<1){
      return {ok:false,reason:'ambiguous_target'};
    }
    const active=videos[0];
    let root=active.video.closest('[role="article"],article')||active.video.parentElement||active.video;
    let noteId=root&&reelPermalinkOf(root);
    for(let candidate=active.video.parentElement,depth=0;!noteId&&candidate&&depth<8;candidate=candidate.parentElement,depth++){
      const candidateId=reelPermalinkOf(candidate);
      if(candidateId){
        root=candidate;
        noteId=candidateId;
      }
    }
    const routeHref=cleanPermalink(location.href);
    noteId=noteId||routeHref;
    return {
      ok:true,
      ...(noteId?{noteId}:{}),
      videoKey:reelVideoKey(active.video),
      videoRect:{
        left:active.rect.left,
        top:active.rect.top,
        right:active.rect.right,
        bottom:active.rect.bottom,
      },
      root,
      video:active.video,
    };
  };
  const reelProbeValue=(probe)=>({
    ok:Boolean(probe&&probe.ok),
    ...(probe&&probe.reason?{reason:probe.reason}:{}),
    ...(probe&&probe.noteId?{noteId:probe.noteId}:{}),
    ...(probe&&probe.videoKey?{videoKey:probe.videoKey}:{}),
    ...(probe&&probe.videoRect?{videoRect:probe.videoRect}:{}),
  });
  const reelNextTarget=()=>{
    const active=activeReel();
    if(!active.ok)return {...reelProbeValue(active),found:false,ambiguous:active.reason==='ambiguous_target'};
    const rect=active.videoRect;
    const next=/(next|ti[eế]p theo|下一|下一个|下一張|下一张|往下)/i;
    const previous=/(previous|trước|上一|上一个|上一張|上一张|往上)/i;
    const down=/(arrow down|scroll down|move down|往下|向下)/i;
    const right=/(arrow right|scroll right|move right|往右|向右)/i;
    const buttons=all('[role="button"],button').filter(visible).map((button)=>({
      button,
      rect:button.getBoundingClientRect(),
      label:label(button),
      disabled:button.getAttribute('aria-disabled')==='true'||Boolean(button.disabled),
    })).filter((candidate)=>{
      const target=candidate.rect;
      return target.width>=36&&target.width<=68
        &&target.height>=36&&target.height<=68
        &&target.left>=-2
        &&target.right<=(window.innerWidth||0)+2
        &&target.top>=64
        &&target.bottom<=(window.innerHeight||0)+2;
    }).map((candidate)=>({
      ...candidate,
      cx:candidate.rect.left+candidate.rect.width/2,
      cy:candidate.rect.top+candidate.rect.height/2,
      role:next.test(candidate.label)&&!previous.test(candidate.label)
        ?'next'
        :previous.test(candidate.label)&&!next.test(candidate.label)?'previous':'unknown',
    }));
    const verticalMember=(candidate)=>
      candidate.rect.left>Math.max((window.innerWidth||0)*0.8,rect.right+120)
      &&candidate.rect.top>=Math.max(64,rect.top+(rect.bottom-rect.top)*0.2)
      &&candidate.rect.bottom<=Math.min(window.innerHeight||0,rect.bottom-(rect.bottom-rect.top)*0.08);
    const horizontalPrevious=(candidate)=>
      candidate.rect.right<rect.left-24
      &&candidate.cy>=rect.top+(rect.bottom-rect.top)*0.2
      &&candidate.cy<=rect.bottom-(rect.bottom-rect.top)*0.2;
    const horizontalNext=(candidate)=>
      candidate.rect.left>rect.right+24
      &&candidate.cy>=rect.top+(rect.bottom-rect.top)*0.2
      &&candidate.cy<=rect.bottom-(rect.bottom-rect.top)*0.2;
    const axisOf=(back,forward)=>{
      const horizontal=horizontalPrevious(back)&&horizontalNext(forward)&&Math.abs(back.cy-forward.cy)<=80;
      const vertical=verticalMember(back)&&verticalMember(forward)
        &&Math.abs(back.cx-forward.cx)<=40&&forward.cy>back.cy+16;
      return horizontal===vertical?'':horizontal?'horizontal':'vertical';
    };
    const previousButtons=buttons.filter((candidate)=>candidate.role==='previous');
    const nextButtons=buttons.filter((candidate)=>candidate.role==='next');
    const semanticPairs=[];
    for(const back of previousButtons){
      for(const forward of nextButtons){
        const axis=axisOf(back,forward);
        if(axis)semanticPairs.push({axis,target:forward});
      }
    }
    const uniquePairs=semanticPairs.filter((pair,index,list)=>
      list.findIndex((candidate)=>candidate.axis===pair.axis&&candidate.target.button===pair.target.button)===index
    );
    let choice=uniquePairs.length===1?uniquePairs[0]:null;
    if(uniquePairs.length>1){
      return {...reelProbeValue(active),found:false,ambiguous:true};
    }
    if(!choice&&nextButtons.length===1){
      const target=nextButtons[0];
      if(down.test(target.label)&&verticalMember(target))choice={axis:'vertical',target};
      else if(right.test(target.label)&&horizontalNext(target))choice={axis:'horizontal',target};
    }
    if(!choice){
      const unknown=buttons.filter((candidate)=>candidate.role==='unknown');
      const vertical=unknown.filter(verticalMember).sort((left,right)=>left.cy-right.cy);
      const horizontalLeft=unknown.filter(horizontalPrevious);
      const horizontalRight=unknown.filter(horizontalNext);
      const structural=[];
      if(vertical.length===2&&Math.abs(vertical[0].cx-vertical[1].cx)<=40){
        structural.push({axis:'vertical',target:vertical[1]});
      }
      if(horizontalLeft.length===1&&horizontalRight.length===1
        &&Math.abs(horizontalLeft[0].cy-horizontalRight[0].cy)<=80){
        structural.push({axis:'horizontal',target:horizontalRight[0]});
      }
      if(structural.length===1)choice=structural[0];
      else return {...reelProbeValue(active),found:false,ambiguous:structural.length>1};
    }
    const target=choice.target;
    if(target.disabled)return {
      ...reelProbeValue(active),
      axis:choice.axis,
      found:false,
      ambiguous:false,
      reason:'next_control_disabled',
    };
    return {
      ...reelProbeValue(active),
      axis:choice.axis,
      found:true,
      ambiguous:false,
      cx:target.cx,
      cy:target.cy,
      label:target.label,
    };
  };
  const exactArticle=(expected)=>{
    const expectedId=postId(expected)||String(expected||'');
    const matches=topArticles().filter((article)=>{
      const href=permalinkOf(article);
      return href&&(href===expected||postId(href)===expectedId);
    });
    return matches.length===1?matches[0]:null;
  };
  const closestArticle=(el)=>el&&el.closest?el.closest('[role="article"],article'):null;
  const targetScopeRoot=(article)=>{
    const dialogs=all('[role="dialog"],[aria-modal="true"]').filter(visible);
    for(let index=dialogs.length-1;index>=0;index--){
      if(dialogs[index].contains(article))return dialogs[index];
    }
    const feed=all('div[role="feed"]').find((candidate)=>candidate.contains(article));
    return feed||document;
  };
  const exclusiveArticleRegion=(article)=>{
    if(!article)return null;
    const scope=targetScopeRoot(article);
    const root=scope===document?(document.body||document.documentElement):scope;
    if(!root||!root.contains(article))return null;
    const others=all('[role="article"],article').filter((candidate)=>
      candidate!==article&&!article.contains(candidate)&&!candidate.contains(article)
    );
    let region=article;
    while(region!==root&&region.parentElement){
      const parent=region.parentElement;
      if(parent!==root&&!root.contains(parent))break;
      if(others.some((candidate)=>parent.contains(candidate)))break;
      region=parent;
    }
    if(others.length&&(region===document.body||region===document.documentElement))return null;
    return region;
  };
  const articleAuthor=(root)=>{
    const link=first(['h2 a[href]','h3 a[href]','h4 a[href]','a[role="link"][href*="/people/"]','a[role="link"][href*="profile.php"]'],root);
    return {name:text(link,200),href:link&&link.href||''};
  };
  const MESSAGE_CONTAINER_SEL='[data-ad-rendering-role="story_message"],[data-ad-preview="message"],[data-ad-comet-preview="message"]';
  const articleBody=(root)=>{
    const witness=first(MESSAGE_CONTAINER_SEL.split(','),root);
    if(witness)return text(witness,12000);
    const candidates=all('div[dir="auto"]',root).filter(visible).map((el)=>text(el,12000)).filter((value)=>value.length>1);
    return candidates.sort((a,b)=>b.length-a.length)[0]||'';
  };
