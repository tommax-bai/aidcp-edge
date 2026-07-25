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
  const topArticles=()=>{
    const nodes=all('[role="article"],article').filter(visible);
    return nodes.filter((node)=>!node.parentElement||!node.parentElement.closest('[role="article"],article'));
  };
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
    if(!noteId)return {ok:false,reason:'no_active_identity'};
    return {
      ok:true,
      noteId,
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
    const buttons=all('[role="button"],button').filter(visible).map((button)=>({
      button,
      rect:button.getBoundingClientRect(),
      label:label(button),
    })).filter((candidate)=>{
      const target=candidate.rect;
      return target.width>=36&&target.width<=68
        &&target.height>=36&&target.height<=68
        &&target.left>Math.max((window.innerWidth||0)*0.8,rect.right+120)
        &&target.right<=(window.innerWidth||0)+2
        &&target.top>=Math.max(64,rect.top+(rect.bottom-rect.top)*0.25)
        &&target.bottom<=Math.min(window.innerHeight||0,rect.bottom-(rect.bottom-rect.top)*0.12)
        &&candidate.button.getAttribute('aria-disabled')!=='true'
        &&!candidate.button.disabled;
    }).sort((left,right)=>left.rect.top-right.rect.top);
    const labelled=buttons.filter((candidate)=>next.test(candidate.label)&&!previous.test(candidate.label));
    if(labelled.length>1)return {...reelProbeValue(active),found:false,ambiguous:true};
    let target=labelled.length===1?labelled[0]:null;
    if(!target){
      const unknown=buttons.filter((candidate)=>!previous.test(candidate.label));
      if(unknown.length===2)target=unknown[1];
      else return {...reelProbeValue(active),found:false,ambiguous:unknown.length>1};
    }
    return {
      ...reelProbeValue(active),
      found:true,
      ambiguous:false,
      cx:target.rect.left+target.rect.width/2,
      cy:target.rect.top+target.rect.height/2,
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
  const articleAuthor=(root)=>{
    const link=first(['h2 a[href]','h3 a[href]','h4 a[href]','a[role="link"][href*="/people/"]','a[role="link"][href*="profile.php"]'],root);
    return {name:text(link,200),href:link&&link.href||''};
  };
  const articleBody=(root)=>{
    const witness=first(['[data-ad-rendering-role="story_message"]','[data-ad-preview="message"]','[data-ad-comet-preview="message"]'],root);
    if(witness)return text(witness,12000);
    const candidates=all('div[dir="auto"]',root).filter(visible).map((el)=>text(el,12000)).filter((value)=>value.length>1);
    return candidates.sort((a,b)=>b.length-a.length)[0]||'';
  };
  const reactionButton=(root)=>{
    const buttons=all('button,[role="button"]',root).filter(visible);
    return buttons.find((button)=>/^(赞|讚|like|me gusta|thích)(\b|\s|$)/i.test(label(button)))||null;
  };
  const commentEditor=(root=document)=>all('[contenteditable="true"][role="textbox"],textarea[aria-label],textarea',root).filter(visible).find((el)=>{
    const raw=label(el).toLowerCase();
    return /评论|留言|comment|write a comment|viết bình luận|bình luận/.test(raw)||el.getAttribute('role')==='textbox';
  })||null;
  const acceptConsent=()=>{
    const scope=first(['[role="dialog"]','[aria-modal="true"]'])||document;
    const candidates=all('button,[role="button"],a[role="button"]',scope).filter(visible);
    const target=candidates.find((el)=>/^(allow all cookies|accept all|allow essential and optional cookies|接受所有|允许所有|同意|cho phép tất cả)$/i.test(label(el)));
    return target?click(target):false;
  };
  const blocker=()=>{
    const body=text(document.body,5000);
    if(classify()==='login'||/log in to facebook|登录 facebook|登入 facebook/i.test(body))return 'login_required';
    if(classify()==='checkpoint'||/security check|captcha|验证码|安全检查/i.test(body))return 'blocked_by_captcha';
    return '';
  };
  const cardOf=(article,index,preferredHref='')=>{
    const href=cleanPermalink(preferredHref)||permalinkOf(article);
    const id=postId(href);
    if(!href||!id)return null;
    const author=articleAuthor(article);
    const body=articleBody(article)||(preferredHref?text(article,12000):'');
    const reaction=reactionButton(article);
    return {
      index,
      title:body.slice(0,200),
      author:author.name||undefined,
      likeCount:count(text(reaction,96)||label(reaction,96)),
      collectCount:0,
      coverDesc:body.slice(0,200)||undefined,
      noteId:href,
      isVideo:Boolean(first(['video'],article)||/\/videos\/|\/reel\/|\/watch/.test(href)),
    };
  };
  const feedCards=()=>{
    const cards=[];
    const seen=new Set();
    const active=reelSurface()?activeReel():null;
    const articles=active&&active.ok&&active.root?[active.root]:reelSurface()?[]:topArticles();
    for(const article of articles){
      const card=cardOf(article,cards.length,active&&active.ok?active.noteId:'');
      const id=card&&postId(card.noteId);
      if(!card||!id||seen.has(id))continue;
      seen.add(id);
      cards.push(card);
      if(cards.length>=60)break;
    }
    const listKind=reelSurface()?'reels':'feed';
    const generation=[
      location.pathname,
      active&&active.ok?active.videoKey:'',
      cards.length,
      ...cards.slice(-8).map((card)=>card.noteId),
    ].join('|').slice(0,256);
    return {kind:'page_cards',value:{
      cards,
      documentGeneration:generation,
      listKind,
      listState:cards.length?'ready':(listKind==='reels'?Boolean(active&&active.reason!=='no_active_video'):topArticles().length)?'present_unreportable':'empty',
    }};
  };
  const comments=(root)=>{
    const out=[];
    for(const article of all('[role="article"],article',root).filter(visible)){
      if(article===root)continue;
      const value=articleBody(article)||text(article,1000);
      if(value&&!out.includes(value))out.push(value);
      if(out.length>=50)break;
    }
    return out;
  };
  const noteDetail=(root,href)=>{
    const author=articleAuthor(root);
    const body=articleBody(root);
    const reaction=reactionButton(root);
    const images=all('img',root).filter(visible).map((img,index)=>({
      index,
      url:String(img.currentSrc||img.src||'').slice(0,4096),
      width:Number(img.naturalWidth||img.width)||undefined,
      height:Number(img.naturalHeight||img.height)||undefined,
      alt:norm(img.alt||'',200)||undefined,
    })).filter((image)=>/^https?:/.test(image.url)).slice(0,20);
    return {kind:'note_detail',value:{
      noteId:href||cleanPermalink(location.href)||norm(p.noteId,256),
      title:body.slice(0,200),
      content:body,
      mediaType:first(['video'],root)?'video':'image_text',
      author:author.name||undefined,
      authorId:(author.href.match(/[?&]id=(\d{5,})/)||author.href.match(/\/people\/[^/]+\/(\d{5,})/)||[])[1]||undefined,
      likeCount:count(text(reaction,96)||label(reaction,96)),
      collectCount:0,
      url:String(location.href).slice(0,4096),
      images,
      comments:comments(root),
    }};
  };
  const currentDetail=()=>{
    const expected=String(p.noteId||p.url||'');
    const exact=expected?exactArticle(expected):null;
    const root=exact||first(['[role="dialog"] [role="article"]','[role="dialog"]','main [role="article"]','main article'])||document.querySelector('main')||document.body;
    return noteDetail(root,permalinkOf(root)||cleanPermalink(location.href)||expected);
  };
  const actionEvidence=(root)=>{
    const author=articleAuthor(root);
    const body=articleBody(root);
    const reaction=reactionButton(root);
    return {
      surface:root.closest('[role="dialog"]')?'detail':'feed',
      listKey:permalinkOf(root)||undefined,
      author:author.name||undefined,
      textPreviewHead:body.slice(0,500)||undefined,
      reactionText:norm(text(reaction,96)||label(reaction,96),128)||undefined,
      articleIndex:Math.max(0,topArticles().indexOf(root)),
    };
  };
  const actionRoot=()=>{
    const expected=String(p.noteId||'');
    return (expected&&exactArticle(expected))||first(['[role="dialog"] [role="article"]','main [role="article"]','main article'])||null;
  };
  const joinObservation=()=>{
    const body=text(document.body,10000);
    const candidates=all('button,[role="button"],a[role="button"]').filter(visible).map((el)=>{
      const raw=label(el,256);
      const lower=raw.toLowerCase();
      const joined=/已加入|joined|member|退出小组|leave group|đã tham gia/i.test(raw);
      const join=!joined&&/^(?:加入|加入小组|join(?: group)?|tham gia)$/i.test(raw);
      const pending=/待审核|pending|request sent/i.test(raw);
      return {el,raw,kind:join?'join':joined?'joined':pending?'pending':'other',inTargetScope:!el.closest('nav,header,aside,[role="navigation"],[role="banner"],[role="complementary"]')};
    });
    const path=location.pathname.split('/').filter(Boolean);
    const groupId=path[0]&&path[0].toLowerCase()==='groups'?path[1]||null:null;
    const main=first(['[role="main"]','main'])||document.body;
    const heading=first(['h1','[role="heading"][aria-level="1"]'],main);
    const scoped=candidates.filter((item)=>item.inTargetScope);
    const mainCta=scoped.find((item)=>item.kind!=='other');
    const signals=scoped.filter((item)=>item.kind==='joined').map((item)=>item.raw).slice(0,16);
    return {
      groupUrl:groupId?`https://www.facebook.com/groups/${groupId}`:undefined,
      pageUrl:String(location.href).slice(0,4096),
      title:text(heading,200)||undefined,
      mainCtaText:mainCta&&mainCta.raw||null,
      mainCtaAria:mainCta&&label(mainCta.el,256)||null,
      headerText:text(heading,1000)||null,
      modalText:text(first(['[role="dialog"]','[aria-modal="true"]']),1000)||null,
      membershipSignals:signals,
      loginRequired:classify()==='login',
      captchaDetected:classify()==='checkpoint'||/captcha|验证码|安全检查/i.test(body),
      questionnaireRequired:/回答问题|answer questions|membership questions/i.test(body),
      pendingRequest:scoped.some((item)=>item.kind==='pending'),
      actionNodeCount:candidates.length,
      documentReady:document.readyState,
      composerPresent:Boolean(commentEditor(main)),
      joinCtaPresent:scoped.some((item)=>item.kind==='join'),
      targetGroupId:groupId,
      scopeResolved:Boolean(groupId&&main),
      outOfScopeJoinCount:candidates.filter((item)=>item.kind==='join'&&!item.inTargetScope).length,
      ctaCandidates:candidates.slice(0,50).map((item)=>({text:item.raw||null,kind:item.kind,inTargetScope:item.inTargetScope})),
    };
  };
  const identity=()=>{
    const cookieId=/^\d{5,}$/.test(String(p.cookieUserId||''))?String(p.cookieUserId):'';
    const anchors=all('a[href*="profile.php?id="],a[href*="/people/"],a[href="/me"],a[href^="/me/"]').map((anchor)=>{
      const href=String(anchor.href||anchor.getAttribute('href')||'');
      const id=(href.match(/[?&]id=(\d{5,})/)||href.match(/\/people\/[^/]+\/(\d{5,})/)||[])[1]||'';
      return {anchor,href,id};
    });
    const candidates=Array.from(new Set(anchors.map((item)=>item.id).filter(Boolean)));
    if(!cookieId&&candidates.length!==1)return {kind:'identity_receipt',value:{ok:false,reason:candidates.length?'facebook identity candidates conflict':'facebook stable numeric id candidate was not found'}};
    const accountId=cookieId||candidates[0];
    const own=anchors.find((item)=>item.id===accountId||/\/me\/?$/.test(new URL(item.href,location.origin).pathname));
    let displayName=own&&norm(own.anchor.getAttribute('aria-label')||text(own.anchor,200),200)||'';
    displayName=displayName.replace(/\s*(?:的大?头像|的大頭貼|的时间线|的時間線|['’‘]s\s+(?:profile picture|profile photo|avatar|timeline))\s*$/i,'').trim();
    if(/^(facebook|home|profile|your profile|首页|主页|个人主页|菜单)$/i.test(displayName))displayName='';
    return {kind:'identity_receipt',value:{ok:true,accountId,displayName:displayName||undefined,source:cookieId?'cookie':'profile-link'}};
  };

  acceptConsent();
  const blocked=blocker();
  if(!['identity_read','page_probe','reel_probe','reel_next_target','reel_cards'].includes(kind)&&blocked){
    return fail(kind||'page',blocked);
  }
  if(kind==='identity_read')return done(identity());
  if(kind==='reel_probe')return done({kind:'reel_probe',value:reelProbeValue(activeReel())});
  if(kind==='reel_next_target')return done({kind:'reel_next_target',value:reelNextTarget()});
  if(kind==='reel_cards')return done(feedCards());
  if(kind==='page_probe'){
    const surface=classify();
    const cards=topArticles().length;
    const probedKind=blocked==='blocked_by_captcha'?'captcha':blocked==='login_required'?'login':surface==='home'?'home':surface==='search'?'search':surface.endsWith('_post')?'note_detail':surface==='login'?'login':surface==='checkpoint'?'captcha':'unknown';
    return done({kind:'page_probe',value:{
      targetId:'',
      origin:location.origin,
      path:location.pathname,
      readyState:['loading','interactive','complete'].includes(document.readyState)?document.readyState:'unknown',
      pageKind:probedKind,
      signals:{feedCardCount:cards,noteDetailCount:surface.endsWith('_post')?1:0,loginWallCount:surface==='login'?1:0,captchaSignalCount:surface==='checkpoint'?1:0,dialogCount:all('[role="dialog"],[aria-modal="true"]').filter(visible).length,profileSignalCount:surface==='page'?1:0,notificationSignalCount:0,publishSignalCount:0,errorSignalCount:0,mainCount:all('main,[role="main"]').length},
    }});
  }
  if(kind==='session_stop')return done(action('session_stop',true));
  if(kind==='browse_scroll'||kind==='page_scroll'||kind==='browse_next'){
    if(reelSurface()&&p.reason!=='initial_scan'&&p.reason!=='empty_feed_reels_fallback'){
      return fail('scroll','native_reels_actuator_required');
    }
    if(p.reason!=='initial_scan'){
      const before=window.scrollY;
      window.scrollBy({top:Math.max(420,Math.round((window.innerHeight||800)*0.8)),behavior:'smooth'});
      await sleep(450);
      const output=feedCards();
      output.value.movement={before,after:window.scrollY,moved:window.scrollY!==before,atBottom:window.scrollY+(window.innerHeight||0)>=document.documentElement.scrollHeight-8};
      return done(output);
    }
    return done(feedCards());
  }
  if(kind==='feed_refresh')return done(feedCards());
  if(kind==='search_execute'){
    if(!p.container)return fail('search','permission_gated');
    const output=feedCards();
    const heading=first(['main h1','[role="main"] h1','[role="heading"][aria-level="1"]']);
    output.value.containerName=text(heading,200)||undefined;
    return done(output);
  }
  if(kind==='note_open'){
    if(p.surface==='feed'){
      const root=actionRoot();
      if(!root)return fail('open','target_not_found');
      return done(noteDetail(root,permalinkOf(root)||String(p.noteId||'')));
    }
    return done(currentDetail());
  }
  if(kind==='note_close'||kind==='navigation_back'){
    history.back();
    return done(action('back',true));
  }
  if(kind==='note_browse_images'){
    const root=actionRoot()||document;
    const buttons=all('button,[role="button"]',root).filter(visible).filter((el)=>/next|下一|下一个/i.test(label(el)));
    let moved=0;for(let i=0;i<Math.min(Number(p.count)||1,20)&&buttons[0];i++){if(click(buttons[0]))moved++;await sleep(250);}
    return done(action('browse_images',moved>0,moved?'confirmed':'next_not_found',{noteId:String(p.noteId||'')}));
  }
  if(kind==='note_scroll_comments'){
    const root=actionRoot()||document;
    root.scrollIntoView&&root.scrollIntoView({block:'start'});
    window.scrollBy({top:Math.max(300,Math.round((window.innerHeight||800)*0.6)),behavior:'smooth'});
    await sleep(350);
    const candidates=comments(root).map((value,index)=>({anchorId:`comment-${index}`,text:value}));
    return done(action('scroll_comments',true,undefined,{noteId:String(p.noteId||''),candidates}));
  }
  if(kind==='profile_open'){
    const root=actionRoot()||document;
    const author=articleAuthor(root);
    const currentId=(location.href.match(/[?&]id=(\d{5,})/)||location.href.match(/\/people\/[^/]+\/(\d{5,})/)||[])[1]||String(p.authorId||'');
    const body=text(document.body,5000);
    return done({kind:'profile_detail',value:{authorId:currentId,postsCount:count((body.match(/([0-9.,KM万]+)\s*(?:posts|帖子)/i)||[])[1]),followersCount:count((body.match(/([0-9.,KM万]+)\s*(?:followers|粉丝)/i)||[])[1]),extracted:Boolean(currentId),nickname:author.name||text(first(['h1']),200)||undefined,url:String(location.href).slice(0,4096)}});
  }
  if(kind==='interaction_like'){
    const root=actionRoot();if(!root)return fail('like','target_not_found');
    const button=reactionButton(root);if(!button)return fail('like','like_button_not_found');
    const observation=actionEvidence(root);
    if(pressed(button)||/取消赞|remove like|unlike/i.test(label(button)))return done(action('like',true,'already_liked',{noteId:permalinkOf(root),observation}));
    if(!click(button))return fail('like','like_dispatch_failed');
    await sleep(350);
    const ok=pressed(button)||/取消赞|remove like|unlike/i.test(label(button));
    return ok?done(action('like',true,undefined,{noteId:permalinkOf(root),observation})):ambiguous('like','like_unconfirmed',{noteId:permalinkOf(root),observation});
  }
  if(kind==='interaction_follow'){
    const root=actionRoot()||document;
    const buttons=all('button,[role="button"]',root).filter(visible);
    const button=buttons.find((el)=>/^(关注|follow|theo dõi)$/i.test(label(el)));
    if(!button){
      const already=buttons.find((el)=>/已关注|following|đang theo dõi/i.test(label(el)));
      return already?done(action('follow',true,'already_following',{noteId:String(p.noteId||'')})):fail('follow','follow_button_not_found');
    }
    if(!click(button))return fail('follow','follow_dispatch_failed');
    await sleep(350);
    const ok=/已关注|following|đang theo dõi/i.test(label(button))||!visible(button);
    return ok?done(action('follow',true,undefined,{noteId:String(p.noteId||'')})):ambiguous('follow','follow_unconfirmed',{noteId:String(p.noteId||'')});
  }
  if(kind==='interaction_comment'){
    const root=actionRoot()||document;
    const editor=commentEditor(root);if(!editor)return fail('comment','editor_not_found');
    const value=String(p.text||'');if(!value)return fail('comment','comment_text_empty');
    if(!fill(editor,value))return fail('comment','editor_fill_failed');
    const read='value' in editor?String(editor.value||''):text(editor,32000);
    if(norm(read,32000)!==norm(value,32000))return fail('comment','editor_readback_mismatch');
    const submit=all('button,[role="button"]',root).filter(visible).find((el)=>/^(发布|评论|comment|post|send|gửi)$/i.test(label(el)));
    let dispatched=false;
    if(submit&&!submit.disabled&&submit.getAttribute('aria-disabled')!=='true')dispatched=click(submit);
    else{
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
      editor.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true}));
      dispatched=true;
    }
    if(!dispatched)return fail('comment','comment_dispatch_failed');
    await sleep(700);
    const verified=all('[role="article"],article',root).some((el)=>{
      if(!text(el,4000).includes(value))return false;
      return all('a[href*="comment_id="]',el).some((link)=>{
        try{
          const id=new URL(link.href||link.getAttribute('href')||'',location.origin).searchParams.get('comment_id')||'';
          return /^Y29tbWVudD/.test(id)&&!/^client/i.test(id);
        }catch{return false;}
      });
    });
    return verified?done(action('comment',true,undefined,{noteId:String(p.noteId||'')})):ambiguous('comment','comment_verification_ambiguous',{noteId:String(p.noteId||'')});
  }
  if(kind==='interaction_like_comment'){
    const target=document.getElementById(String(p.commentAnchorId||''));if(!target)return fail('comment_like','comment_anchor_not_found');
    const button=all('button,[role="button"]',target).filter(visible).find((el)=>/^(赞|like|thích)/i.test(label(el)));if(!button)return fail('comment_like','comment_like_button_not_found');
    if(pressed(button))return done(action('comment_like',true,'already_liked',{noteId:String(p.noteId||'')}));
    if(!click(button))return fail('comment_like','comment_like_dispatch_failed');await sleep(300);
    return pressed(button)?done(action('comment_like',true,undefined,{noteId:String(p.noteId||'')})):ambiguous('comment_like','comment_like_unconfirmed',{noteId:String(p.noteId||'')});
  }
  if(kind==='group_join'){
    const before=joinObservation();
    const groupUrl=before.groupUrl||String(p.groupUrl||'');
    const member=before.membershipSignals.length>0||(before.composerPresent&&!before.joinCtaPresent);
    if(member)return done(action('join_group',false,'already_member',{groupUrl,clicked:false,groupObservation:before}));
    if(before.questionnaireRequired)return fail('join_group','questionnaire_required');
    if(before.pendingRequest)return done(action('join_group',false,'pending',{groupUrl,clicked:false,groupObservation:before}));
    if(!p.click)return done(action('join_group',false,'observation_only',{groupUrl,clicked:false,groupObservation:before}));
    if(!before.scopeResolved)return fail('join_group','not_ready');
    const candidates=all('button,[role="button"],a[role="button"]').filter(visible).filter((el)=>/^(?:加入|加入小组|join(?: group)?|tham gia)$/i.test(label(el))&&!el.closest('nav,header,aside,[role="navigation"],[role="banner"],[role="complementary"]'));
    if(candidates.length!==1)return fail('join_group',candidates.length?'not_ready':'no_button');
    if(!click(candidates[0]))return fail('join_group','no_button');
    await sleep(900);
    const after=joinObservation();
    const joined=after.membershipSignals.length>0||(after.composerPresent&&!after.joinCtaPresent);
    return joined?done(action('join_group',true,undefined,{groupUrl,clicked:true,groupObservation:before,postObservation:after})):ambiguous('join_group','join_verification_ambiguous',{groupUrl,clicked:true,groupObservation:before,postObservation:after});
  }
  if(kind==='publish_navigate_entry'){
    const entry=all('button,[role="button"],div[role="button"]',document).filter(visible).find((el)=>/what(?:'s| is) on your mind|你在想什么|create post|发帖|tạo bài viết/i.test(label(el)+' '+text(el,256)));
    if(!entry)return fail('navigate_entry','composer_entry_not_found');
    click(entry);await sleep(350);
    return first(['[role="dialog"] [contenteditable="true"]','[role="dialog"] textarea'])?done(action('navigate_entry',true)):ambiguous('navigate_entry','composer_unconfirmed');
  }
  if(kind==='publish_select_mode'){
    if(p.optionKind!=='target'||p.optionValue!=='facebook_personal_timeline')return fail('select_mode','unsupported_target');
    return done(action('select_mode',true,'facebook_composer'));
  }
  if(kind==='publish_fill_field'){
    const root=first(['[role="dialog"]','[aria-modal="true"]'])||document;
    const editor=first(['[contenteditable="true"][role="textbox"]','[contenteditable="true"]','textarea'],root);
    if(!editor)return fail('fill_field','composer_editor_not_found');
    if(p.fieldType==='title')return done(action('fill_field',true,'facebook_title_not_separate'));
    if(!String(p.value||'').trim())return fail('fill_field','empty_content');
    fill(editor,String(p.value||''));
    const read='value' in editor?String(editor.value||''):text(editor,32000);
    return norm(read,32000)===norm(p.value,32000)?done(action('fill_field',true)):ambiguous('fill_field','composer_readback_mismatch');
  }
  if(kind==='publish_upload_image'){
    const previews=all('[role="dialog"] img,form img').filter(visible).filter((img)=>/^blob:|^https?:/.test(String(img.src||'')));
    return previews.length?done(action('upload_image',true)):ambiguous('upload_image','media_preview_unconfirmed');
  }
  if(kind==='publish_set_cover'||kind==='publish_add_with_candidate'||kind==='publish_set_option'||kind==='publish_set_schedule')return fail(kind.replace('publish_',''),'kind_not_implemented');
  if(kind==='publish_submit'){
    const root=first(['[role="dialog"]','[aria-modal="true"]'])||document;
    const submit=all('button,[role="button"]',root).filter(visible).find((el)=>/^(发布|post|đăng)$/i.test(label(el)));
    if(!submit||submit.disabled||submit.getAttribute('aria-disabled')==='true')return fail('submit','publish_submit_not_ready');
    if(!click(submit))return fail('submit','publish_submit_failed');
    await sleep(900);
    const closed=!document.contains(root)||!visible(root);
    return done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:'submit',ok:closed,submitDispatched:true,error:closed?undefined:'publish_submit_unconfirmed'}},closed?'confirmed':'ambiguous');
  }
  if(kind==='publish_capture_post_id'){
    const current=cleanPermalink(location.href);
    const candidates=topArticles().map((article)=>({href:permalinkOf(article),body:articleBody(article)})).filter((item)=>item.href);
    const expected=norm(p.scheduledTitle,2000);
    const matched=expected?candidates.filter((item)=>norm(item.body,2000).includes(expected)):candidates.slice(0,1);
    const href=current||(matched.length===1?matched[0].href:'');
    return done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:'capture_post_id',ok:Boolean(href),value:postId(href)||undefined,postUrl:href||undefined,error:href?undefined:'publish_evidence_not_found'}});
  }
  if(kind==='publish_capture_scheduled'||kind==='publish_reconcile_scheduled'){
    return done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:kind.replace('publish_',''),ok:false,error:'kind_not_implemented'}},'not_started');
  }
  return fail(kind||'unknown','unsupported_command');
}
