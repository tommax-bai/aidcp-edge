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
  const articleBody=(root)=>{
    const witness=first(['[data-ad-rendering-role="story_message"]','[data-ad-preview="message"]','[data-ad-comet-preview="message"]'],root);
    if(witness)return text(witness,12000);
    const candidates=all('div[dir="auto"]',root).filter(visible).map((el)=>text(el,12000)).filter((value)=>value.length>1);
    return candidates.sort((a,b)=>b.length-a.length)[0]||'';
  };
  const neutralLike=/^\s*(?:(?:给.+的帖子)?\s*(?:留下心情|赞一个|点赞|讚|like|react|reaccionar|me gusta|thích)|bày tỏ cảm xúc thích(?: về bài viết của .+)?|bay to cam xuc thich(?: ve bai viet cua .+)?)\s*$/i;
  const unlike=/(取消赞|收回赞|收回|移除心情|移除赞|已赞|remove like|unlike|undo|gỡ thích|bỏ thích)/i;
  const reactedWord=/^\s*(赞|讚|大赞|超赞|like|love|care|haha|wow|me gusta|me encanta|thích)\s*$/i;
  const reactionPickerLabel=/^\s*(?:给.+的帖子)?\s*(?:留下心情|react|reaccionar)\s*$/i;
  const pickerLike=/^\s*(赞|讚|like|me gusta|thích)\s*$/i;
  const pickerReaction=/^\s*(赞|讚|like|love|care|haha|wow|sad|angry|me gusta|me encanta|thích|yêu thích|thương thương|buồn|phẫn nộ)\s*$/i;
  const reelComment=/(发表评论|發表評論|写评论|寫留言|评论.+帖子|comment|write a comment|comment.+post|comentar|viết bình luận|bình luận(?: về bài viết của .+)?|binh luan(?: ve bai viet cua .+)?)/i;
  const reelLikeExcluded=/(share|chia sẻ|chia se|分享|reply|trả lời|tra loi|回复|回覆|menu|更多|next|previous|下一|上一|pause|play|播放|暂停)/i;
  const explicitReactionWitness=(button)=>{
    if(!button||!visible(button))return '';
    const accessible=label(button);
    const rendered=text(button,256);
    const numeric=/\d/.test(rendered);
    if(unlike.test(accessible)||unlike.test(rendered))return 'unlike_label';
    if(button.getAttribute('aria-pressed')==='true')return 'aria_pressed';
    if(button.getAttribute('aria-checked')==='true')return 'aria_checked';
    if(!numeric&&reactionPickerLabel.test(accessible)&&reactedWord.test(rendered))return 'reacted_text';
    if(!neutralLike.test(accessible)&&!numeric&&reactedWord.test(accessible))return 'reacted_label';
    return '';
  };
  const reactionState=(button)=>{
    if(!button||!visible(button))return '';
    const accessible=label(button);
    const rendered=text(button,256);
    if(explicitReactionWitness(button))return 'reacted';
    if(neutralLike.test(accessible)||neutralLike.test(rendered))return 'neutral';
    return '';
  };
  const reactionButton=(root)=>{
    const buttons=all('button,[role="button"]',root).filter(visible);
    return buttons.find((button)=>/^(赞|讚|like|me gusta|thích)(\b|\s|$)/i.test(label(button)))||null;
  };
  const commentEditor=(root=document)=>all('[contenteditable="true"][role="textbox"],textarea[aria-label],textarea',root).filter(visible).find((el)=>{
    const raw=label(el).toLowerCase();
    return /评论|留言|comment|bình luận|coment|输入回答|answer/.test(raw)||el.getAttribute('role')==='textbox';
  })||null;
  const participationGate=()=>{
    const dialogs=all('[role="dialog"]').filter(visible);
    const expression=/申请参与|请求参与|参与此(?:小组|群)|贡献(?:内容)?给?(?:此|这个)?(?:小组|群)|参与问题|同意(?:此|该|小组|群).{0,4}规则|同意群规|request to participate|participation question|answer questions to participate|contribute to (?:this|the) group|agree to the group rules|待审核|pending review/i;
    return dialogs.some((dialog)=>expression.test(text(dialog,4000)));
  };
  const consentProbe=()=>{
    const body=text(document.body,5000);
    const path=location.pathname.toLowerCase();
    const frames=all('iframe').map((frame)=>String(frame.getAttribute('src')||frame.src||'')).join('\n');
    const captcha=/captcha|recaptcha|fbsbx\.com\/captcha/i.test(frames)
      ||/进行人机身份验证|人机身份验证|captcha|recaptcha|prove you(?:'|’)re human|confirm you(?:'|’)re human|verify you(?:'|’)re human/i.test(body);
    const loginPath=/\/login|\/recover|\/two_step_verification/i.test(path);
    const cookieCopy=/cookie\s*政策|cookie\s*policy|允许\s*facebook\s*使用\s*cookie|允许使用\s*cookie|使用\s*cookie|allow\s+the\s+use\s+of\s+cookies|use\s+of\s+cookies|allow\s+all\s+cookies|允许所有\s*cookie/i.test(body);
    const scope=first(['[role="dialog"]','[aria-modal="true"]'])||document;
    const buttons=all('button,[role="button"],a[role="button"],div[aria-label],span[aria-label]',scope).filter(visible);
    const acceptAll=buttons.filter((el)=>/^(允许所有\s*cookie|允许全部\s*cookie|接受所有\s*cookie|同意所有\s*cookie|允许\s*facebook\s*使用\s*cookie|允许使用\s*cookie|allow\s+all\s+cookies|accept\s+all\s+cookies|allow\s+the\s+use\s+of\s+cookies)$/i.test(label(el)));
    const necessaryOnly=buttons.filter((el)=>/^(仅允许必要\s*cookie|只允许必要\s*cookie|仅接受必要\s*cookie|拒绝非必要\s*cookie|only\s+allow\s+essential\s+cookies|decline\s+optional\s+cookies|refuse\s+non-?essential\s+cookies)$/i.test(label(el)));
    const present=cookieCopy&&!captcha&&!loginPath;
    return {
      present,
      acceptAll:present&&acceptAll.length===1?point(acceptAll[0]):null,
      necessaryOnly:present&&necessaryOnly.length===1?point(necessaryOnly[0]):null,
      acceptAllAmbiguous:acceptAll.length>1,
      necessaryOnlyAmbiguous:necessaryOnly.length>1,
    };
  };
  const blockingProbe=()=>{
    const body=text(document.body,5000);
    const bodyLower=body.toLowerCase();
    const href=String(location.href).toLowerCase();
    const frames=all('iframe').map((frame)=>String(frame.getAttribute('src')||frame.src||'')).join('\n').toLowerCase();
    if(
      frames.includes('fbsbx.com/captcha')
      ||frames.includes('google.com/recaptcha')
      ||/进行人机身份验证|人机身份验证|captcha|recaptcha|prove you(?:'|’)re human|confirm you(?:'|’)re human|verify you(?:'|’)re human/i.test(body)
    )return {kind:'captcha',text:body};
    const consent=consentProbe();
    if(
      href.includes('/login')
      ||href.includes('/recover')
      ||href.includes('/two_step_verification')
      ||(!consent.present&&/登录 facebook|登录或注册|log in to facebook|forgot password|account recovery|账号恢复|找回账号/i.test(body))
    )return {kind:'login',text:body};
    if(href.includes('/checkpoint')||/security check|security checkpoint|安全检查|安全验证/i.test(body)){
      return {kind:'unknown',text:body};
    }
    if(
      href.includes('/help/contact')
      ||/temporarily blocked|action blocked|we limit how often you can do this|misusing this feature|you can.?t use this feature right now|going too fast|this feature is( ?n.?t| not) available|your account is restricted|we restrict certain content and actions|暂时被限制|功能暂时不可用|此功能暂时无法使用|你暂时无法使用|操作被封锁/i.test(bodyLower)
      ||['我们限制了你发帖','我们限制了您发帖','执行其他操作的频率'].some((phrase)=>body.includes(phrase))
    )return {kind:'unknown',text:body};
    return {kind:'none',text:''};
  };
  const blocker=(probe)=>{
    if(probe.kind==='login')return 'login_required';
    if(probe.kind==='captcha')return 'blocked_by_captcha';
    if(probe.kind==='unknown')return 'blocked_by_unknown';
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
  const feedProbe=()=>{
    const output=feedCards();
    const scope=first(['div[role="feed"]','[role="main"]','main'])||document.body;
    const loading=Boolean(scope&&scope.querySelector('[role="progressbar"],[aria-busy="true"]'));
    const articleCount=reelSurface()?0:topArticles().length;
    const timeOrigin=Number(performance&&performance.timeOrigin);
    const elapsedMs=Number.isFinite(timeOrigin)?Date.now()-timeOrigin:0;
    const documentAgeMs=Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.floor(Number.isFinite(elapsedMs)?elapsedMs:0)));
    let explicitEmpty=false;
    for(const node of all('div,section',scope||document)){
      const raw=text(node,600);
      if(raw.length<15)continue;
      const clean=raw.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const title=/no more posts|there are no posts|khong con bai viet nao|khong co bai viet nao|没有更多帖子|没有帖子/i.test(clean);
      const hint=/add friends|them ban be|添加好友/i.test(clean)&&/feed|bang feed|动态消息|信息流/i.test(clean);
      if(title&&hint){explicitEmpty=true;break;}
    }
    return {kind:'feed_probe',value:{
      cards:output.value.cards,
      documentGeneration:output.value.documentGeneration,
      listKind:output.value.listKind,
      listState:output.value.listState,
      loading,
      articleCount,
      explicitEmpty,
      url:String(location.href).slice(0,4096),
      surface:classify(),
      scrollY:Number(window.scrollY)||0,
      innerWidth:Number(window.innerWidth)||0,
      innerHeight:Number(window.innerHeight)||0,
      scrollHeight:Number(document.documentElement&&document.documentElement.scrollHeight)||0,
      documentAgeMs,
    }};
  };
  const feedHomeTarget=()=>{
    const banner=first(['[role="banner"]'])||document;
    const candidates=all('a[href]',banner).filter(visible).filter((anchor)=>{
      try{
        const url=new URL(anchor.href||anchor.getAttribute('href')||'',location.origin);
        return (url.hostname==='facebook.com'||url.hostname.endsWith('.facebook.com'))&&url.pathname==='/'&&!url.search;
      }catch{return false;}
    });
    if(!candidates.length)return {ok:false,reason:'no_home_link'};
    const rect=candidates[0].getBoundingClientRect();
    return {ok:true,cx:rect.left+rect.width/2,cy:rect.top+rect.height/2};
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
    if(expected&&reelSurface()){
      const active=activeReel();
      if(active.ok&&postId(active.noteId)===postId(expected))return active.root;
      return null;
    }
    if(expected)return exactArticle(expected);
    return first(['[role="dialog"] [role="article"]','main [role="article"]','main article'])||null;
  };
  const expectedActiveReel=()=>{
    const expected=String(p.noteId||'');
    const active=activeReel();
    if(!active.ok)return {ok:false,reason:active.reason==='ambiguous_target'?'ambiguous_target':'target_not_found'};
    if(!expected||postId(active.noteId)!==postId(expected))return {ok:false,reason:'target_not_found',noteId:active.noteId};
    return active;
  };
  const reelAssociated=(active,element)=>{
    if(!active||!element||!visible(element))return false;
    const target=element.getBoundingClientRect();
    const viewportWidth=window.innerWidth||0;
    const viewportHeight=window.innerHeight||0;
    if(target.bottom<=0||target.top>=viewportHeight||target.right<=0||target.left>=viewportWidth)return false;
    const video=active.videoRect;
    if(target.top<video.top-60||target.bottom>video.bottom+60||target.left<video.left-180||target.right>video.right+240)return false;
    const distance=rectDistance(target,video);
    if(distance>280)return false;
    const otherDistances=all('video').filter((candidate)=>candidate!==active.video).map((candidate)=>candidate.getBoundingClientRect())
      .filter((rect)=>viewportArea(rect)>0).map((rect)=>rectDistance(target,rect));
    return !otherDistances.some((other)=>other+12<distance);
  };
  const reelLikeAssociated=(active,element)=>{
    if(!reelAssociated(active,element))return false;
    const target=element.getBoundingClientRect();
    const video=active.videoRect;
    if(target.width<32||target.width>84||target.height<32||target.height>90)return false;
    if(target.left<video.right-20||target.left>video.right+125)return false;
    if(target.top<video.top-10||target.bottom>video.bottom+20)return false;
    const source=`${label(element)} ${text(element,256)}`;
    if(reelComment.test(source)||reelLikeExcluded.test(source))return false;
    let context='';
    for(let parent=element.parentElement,depth=0;parent&&depth<4;parent=parent.parentElement,depth++){
      context+=` ${String(parent.getAttribute&&parent.getAttribute('aria-label')||'')}`;
    }
    return !reelComment.test(context)&&!reelLikeExcluded.test(context);
  };
  const reelLikeTarget=()=>{
    const active=expectedActiveReel();
    if(!active.ok)return active;
    const matches=all('button,[role="button"],[role="radio"]').filter((button)=>
      reelLikeAssociated(active,button)&&Boolean(reactionState(button))
    );
    if(matches.length!==1)return {
      ok:false,
      reason:matches.length?'ambiguous_target':'like_button_not_found',
      noteId:active.noteId,
    };
    const button=matches[0];
    return {
      ok:true,
      active,
      button,
      state:reactionState(button),
      noteId:active.noteId,
      observation:{
        ...actionEvidence(active.root),
        listKey:active.noteId,
        reactionText:norm(text(button,96)||label(button,96),128)||undefined,
      },
    };
  };
  const reelLikeMarker='data-aidcp-native-reel-like-target';
  const reelLikeCommitState='__aidcpNativeReelLikeCommit';
  const likeProbe=()=>{
    if(String(p.noteId||'')&&reelSurface()){
      const target=reelLikeTarget();
      if(!target.ok)return {ok:false,reason:target.reason,noteId:target.noteId};
      const coordinates=point(target.button);
      return {
        ok:Boolean(coordinates),
        ...(coordinates||{}),
        reason:coordinates?undefined:'like_button_not_found',
        noteId:target.noteId,
        already:target.state==='reacted',
        observation:target.observation,
      };
    }
    const root=actionRoot();
    if(!root)return {ok:false,reason:'target_not_found'};
    const button=reactionButton(root);
    if(!button)return {ok:false,reason:'like_button_not_found',noteId:permalinkOf(root)||String(p.noteId||'')};
    const target=point(button);
    return {
      ok:Boolean(target),
      ...(target||{}),
      reason:target?undefined:'like_button_not_found',
      noteId:permalinkOf(root)||String(p.noteId||''),
      already:pressed(button)||/取消赞|remove like|unlike/i.test(label(button)),
      observation:actionEvidence(root),
    };
  };
  const likePrimaryCommit=()=>{
    window[reelLikeCommitState]=undefined;
    const target=reelLikeTarget();
    if(!target.ok)return {ok:false,reason:target.reason,noteId:target.noteId,clicked:false};
    all(`[${reelLikeMarker}]`).forEach((element)=>element.removeAttribute(reelLikeMarker));
    target.button.setAttribute(reelLikeMarker,postId(target.noteId));
    window[reelLikeCommitState]={noteId:target.noteId,videoKey:target.active.videoKey};
    if(target.state==='reacted')return {
      ok:true,
      noteId:target.noteId,
      already:true,
      clicked:false,
      observation:target.observation,
    };
    try{
      target.button.click();
      return {
        ok:true,
        noteId:target.noteId,
        already:false,
        clicked:true,
        observation:target.observation,
      };
    }catch{
      return {
        ok:false,
        reason:'like_dispatch_failed',
        noteId:target.noteId,
        already:false,
        clicked:false,
        observation:target.observation,
      };
    }
  };
  const likeVerify=()=>{
    const active=expectedActiveReel();
    if(!active.ok)return {ok:false,reason:active.reason,noteId:active.noteId,selected:false};
    const commit=window[reelLikeCommitState];
    if(!commit||commit.noteId!==active.noteId||commit.videoKey!==active.videoKey){
      return {ok:false,reason:'reel_moved',noteId:active.noteId,selected:false};
    }
    const marker=postId(active.noteId);
    const marked=all(`[${reelLikeMarker}]`).filter((button)=>
      button.getAttribute(reelLikeMarker)===marker&&reelLikeAssociated(active,button)
    );
    if(marked.length!==1)return {
      ok:false,
      reason:marked.length?'ambiguous_target':'target_not_found',
      noteId:active.noteId,
      selected:false,
    };
    const button=marked[0];
    const witness=explicitReactionWitness(button);
    return {ok:true,noteId:active.noteId,selected:Boolean(witness),...(witness?{witness}:{})};
  };
  const likePickerProbe=()=>{
    if(String(p.noteId||'')&&reelSurface()){
      const active=expectedActiveReel();
      if(!active.ok)return {ok:false,reason:active.reason};
      const commit=window[reelLikeCommitState];
      if(!commit||commit.noteId!==active.noteId||commit.videoKey!==active.videoKey){
        return {ok:false,reason:'reel_moved'};
      }
      const marker=postId(active.noteId);
      const primaries=all(`[${reelLikeMarker}]`).filter((button)=>
        button.getAttribute(reelLikeMarker)===marker&&reelLikeAssociated(active,button)
      );
      if(primaries.length!==1)return {ok:false,reason:primaries.length?'ambiguous_target':'like_primary_target_lost'};
      const primaryRect=primaries[0].getBoundingClientRect();
      const pickers=all('[role="menu"],[role="listbox"],[role="dialog"]').filter(visible).map((container)=>{
        const items=all('[role="menuitemradio"],[role="menuitem"],[role="option"],button,[role="button"]',container)
          .filter(visible).filter((item)=>pickerReaction.test(label(item)));
        const likes=items.filter((item)=>pickerLike.test(label(item)));
        return {container,items,likes};
      }).filter((candidate)=>
        candidate.items.length>=2
        && candidate.likes.length===1
        && rectDistance(candidate.container.getBoundingClientRect(),primaryRect)<=320
      );
      if(pickers.length!==1)return {ok:false,reason:pickers.length?'ambiguous_target':'like_picker_not_found'};
      const target=point(pickers[0].likes[0]);
      if(!target)return {ok:false,reason:'like_picker_not_found'};
      const viewportWidth=window.innerWidth||0;
      const viewportHeight=window.innerHeight||0;
      if(target.cx<0||target.cy<0||target.cx>viewportWidth||target.cy>viewportHeight){
        return {ok:false,reason:'like_picker_offscreen'};
      }
      return {ok:true,...target};
    }
    const candidates=all('[role="menuitemradio"],[role="menuitem"],[role="option"],button,[role="button"]').filter(visible)
      .filter((el)=>pickerLike.test(label(el)))
      .filter((el)=>Boolean(el.closest('[role="menu"],[role="listbox"],[role="dialog"]'))||!el.closest('[role="article"],article'));
    if(candidates.length!==1)return {ok:false,reason:candidates.length?'ambiguous_target':'like_picker_not_found'};
    const target=point(candidates[0]);
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'like_picker_not_found'};
  };
  const followControl=(element)=>{
    const rendered=text(element,256);
    const accessible=label(element);
    const source=accessible||rendered;
    const match=source.match(/^(following|follow|已关注|關注中|关注|關注|đang theo dõi|theo dõi|dang theo doi|theo doi)\s*(.*)$/i);
    if(!match)return null;
    const token=match[1].toLowerCase();
    const state=/^(following|已关注|關注中|đang theo dõi|dang theo doi)$/i.test(token)?'following':'follow';
    return {element,state,author:norm(match[2],200),accessible,rendered};
  };
  const exactVisibleText=(value)=>all('a,span,div').filter((element)=>{
    if(!visible(element)||text(element,200)!==value)return false;
    return !Array.from(element.children||[]).some((child)=>text(child,200)===value);
  });
  const reelFollowTarget=()=>{
    const active=expectedActiveReel();
    if(!active.ok)return active;
    const candidates=all('button,[role="button"]').filter((element)=>reelAssociated(active,element))
      .map(followControl).filter(Boolean).filter((candidate)=>{
        if(!candidate.author)return false;
        const targetRect=candidate.element.getBoundingClientRect();
        return exactVisibleText(candidate.author).filter((author)=>
          rectDistance(author.getBoundingClientRect(),targetRect)<=260
        ).length===1;
      });
    if(candidates.length!==1)return {
      ok:false,
      reason:candidates.length?'ambiguous_target':'follow_button_not_found',
      noteId:active.noteId,
    };
    return {ok:true,active,candidate:candidates[0],noteId:active.noteId};
  };
  const followProbe=()=>{
    if(String(p.noteId||'')&&reelSurface()){
      const target=reelFollowTarget();
      if(!target.ok)return {ok:false,reason:target.reason,noteId:target.noteId};
      if(target.candidate.state==='following')return {
        ok:true,
        already:true,
        noteId:target.noteId,
        videoKey:target.active.videoKey,
        author:target.candidate.author,
      };
      const coordinates=point(target.candidate.element);
      return {
        ok:Boolean(coordinates),
        ...(coordinates||{}),
        reason:coordinates?undefined:'follow_button_not_found',
        already:false,
        noteId:target.noteId,
        videoKey:target.active.videoKey,
        author:target.candidate.author,
      };
    }
    const root=actionRoot();
    if(!root)return {ok:false,reason:'target_not_found'};
    const buttons=all('button,[role="button"]',root).filter(visible);
    const follows=buttons.filter((el)=>/^(关注|follow|theo dõi)$/i.test(label(el)));
    const already=buttons.some((el)=>/已关注|following|đang theo dõi/i.test(label(el)));
    if(already)return {ok:true,already:true,noteId:String(p.noteId||'')};
    if(follows.length!==1)return {ok:false,reason:follows.length?'ambiguous_target':'follow_button_not_found'};
    const target=point(follows[0]);
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'follow_button_not_found',already:false,noteId:String(p.noteId||'')};
  };
  const commentEditorProbe=()=>{
    const root=actionRoot();
    if(!root)return {ok:false,reason:'target_not_found'};
    if(participationGate())return {ok:false,reason:'pending_group_approval'};
    const allEditors=all('[contenteditable="true"][role="textbox"],textarea[aria-label],textarea').filter(visible).filter((el)=>{
      const raw=`${label(el)} ${text(el,256)}`.toLowerCase();
      return /评论|留言|comment|bình luận|coment|输入回答|answer/.test(raw);
    });
    let editors=allEditors.filter((el)=>closestArticle(el)===root);
    if(!editors.length){
      const region=exclusiveArticleRegion(root);
      const outside=region?allEditors.filter((el)=>region.contains(el)&&closestArticle(el)===null):[];
      editors=outside.length===1?outside:[];
    }
    if(editors.length!==1)return {ok:false,reason:editors.length?'ambiguous_target':'editor_not_found'};
    const editor=editors[0];
    const target=point(editor);
    const value='value' in editor?String(editor.value||''):norm(editor.innerText||editor.textContent||'',32000);
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'editor_not_found',value,noteId:permalinkOf(root)||String(p.noteId||'')};
  };
  const commentAckProbe=()=>{
    const root=actionRoot();
    if(!root)return {ok:false,reason:'target_not_found',confirmed:false,pending:false,rejected:false,inFlight:false};
    const value=norm(p.text||'',32000);
    const ownId=String(p.accountId||'');
    let pending=false,rejected=false,inFlight=false;
    for(const row of all('[role="article"],article',root).filter(visible)){
      if(row===root)continue;
      const raw=text(row,8000);
      if(!raw.includes(value))continue;
      const own=all('a[href]',row).some((link)=>{
        try{
          const url=new URL(link.href||link.getAttribute('href')||'',location.origin);
          const id=url.searchParams.get('id')||(url.pathname.match(/\/people\/[^/]+\/(\d{5,})/)||[])[1]||'';
          return id===ownId;
        }catch{return false;}
      });
      if(!own)continue;
      const status=raw.split(value).join(' ');
      pending=pending||/待审核|待审批|待批准|等待(?:管理员)?(?:审核|审批|批准)|pending review|pending approval|awaiting (?:admin(?:istrator)? )?approval/i.test(status);
      rejected=rejected||/已拒绝|被拒绝|遭拒绝|已(?:被)?驳回|查看反馈|查看意见反馈|đã từ chối|bị từ chối|xem phản hồi|\brejected\b|\bdeclined\b|was not approved|see feedback|view feedback/i.test(status);
      inFlight=inFlight||/发布中|發佈中|发送中|發送中|đang đăng|đang gửi|\bposting\b|\bsending\b/i.test(status);
      const serverId=all('a[href*="comment_id="]',row).some((link)=>{
        try{
          const id=new URL(link.href||link.getAttribute('href')||'',location.origin).searchParams.get('comment_id')||'';
          return /^Y29tbWVudD/.test(id)&&!/^client/i.test(id);
        }catch{return false;}
      });
      const controls=all('button,[role="button"],a[role="button"]',row).filter(visible).map((el)=>label(el));
      const acknowledged=controls.some((raw)=>/^(赞|讚|点赞|按赞|like|thích)$/i.test(raw))
        &&controls.some((raw)=>/^(回复|回覆|reply|trả lời|phản hồi)$/i.test(raw));
      if(!pending&&!rejected&&(serverId||acknowledged))return {ok:true,confirmed:true,pending:false,rejected:false,inFlight:false};
    }
    pending=pending||participationGate();
    return {ok:true,confirmed:false,pending,rejected,inFlight};
  };
  const joinProbe=()=>{
    const context=joinContext();
    const observation=context.observation;
    const candidates=context.candidates.filter((item)=>item.kind==='join'&&item.inTargetScope);
    const target=candidates.length===1?point(candidates[0].el):null;
    return {
      observation,
      joined:observation.membershipSignals.length>0&&candidates.length===0,
      pending:Boolean(observation.pendingRequest),
      questionnaire:Boolean(observation.questionnaireRequired),
      found:Boolean(target),
      ambiguous:context.scope.ambiguous||candidates.length>1,
      ...(target||{}),
    };
  };
  const publishEntryProbe=()=>{
    const candidates=all('button,[role="button"],div[role="button"]',document).filter(visible).filter((el)=>/what(?:'s| is) on your mind|你在想什么|create post|发帖|tạo bài viết/i.test(label(el)+' '+text(el,256)));
    if(candidates.length!==1)return {ok:false,reason:candidates.length?'ambiguous_target':'composer_entry_not_found'};
    const target=point(candidates[0]);
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'composer_entry_not_found'};
  };
  const publishEditorProbe=()=>{
    const root=first(['[role="dialog"]','[aria-modal="true"]']);
    if(!root)return {ok:false,reason:'composer_not_open'};
    const editors=all('[contenteditable="true"][role="textbox"],[contenteditable="true"],textarea',root).filter(visible);
    if(editors.length!==1)return {ok:false,reason:editors.length?'ambiguous_target':'composer_editor_not_found'};
    const editor=editors[0];
    const target=point(editor);
    const value='value' in editor?String(editor.value||''):norm(editor.innerText||editor.textContent||'',32000);
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'composer_editor_not_found',value};
  };
  const publishSubmitProbe=()=>{
    const root=first(['[role="dialog"]','[aria-modal="true"]']);
    if(!root)return {ok:false,reason:'composer_not_open',composerOpen:false};
    const candidates=all('button,[role="button"]',root).filter(visible).filter((el)=>/^(发布|post|发帖|đăng)$/i.test(label(el)));
    if(candidates.length!==1)return {ok:false,reason:candidates.length?'ambiguous_target':'submit_not_found',composerOpen:true};
    const button=candidates[0];
    const target=point(button);
    const disabled=Boolean(button.disabled||button.getAttribute('aria-disabled')==='true');
    return {ok:Boolean(target)&&!disabled,...(target||{}),reason:disabled?'submit_disabled':target?undefined:'submit_not_found',composerOpen:true,disabled};
  };
  const groupIdFromValue=(value)=>{
    const raw=String(value||'');
    const hit=raw.match(/(?:facebook\.com)?\/groups\/([^/?#\s"'<>]+)/i);
    if(!hit||!hit[1])return '';
    try{return decodeURIComponent(hit[1]).trim().toLowerCase();}catch{return String(hit[1]).trim().toLowerCase();}
  };
  const groupIdFromElement=(el)=>{
    if(!el||!el.attributes)return '';
    for(const attr of Array.from(el.attributes)){
      const groupId=groupIdFromValue(attr&&attr.value);
      if(groupId)return groupId;
    }
    return '';
  };
  const hasForeignGroupRef=(root,groupId)=>{
    if(!root||!groupId)return false;
    return [root,...all('*',root)].some((node)=>{
      const referenced=groupIdFromElement(node);
      return Boolean(referenced&&referenced!==groupId);
    });
  };
  const targetGroupScope=(groupId,main)=>{
    if(!groupId||!main)return {region:null,ambiguous:false,heading:null};
    const headings=all('h1,[role="heading"][aria-level="1"]',main).filter(visible);
    const blocks=[];
    for(const heading of headings){
      let region=heading;
      let atMain=false;
      while(region&&region!==main){
        const parent=region.parentElement;
        if(!parent)break;
        if(hasForeignGroupRef(parent,groupId)){
          if(parent===main)atMain=true;
          break;
        }
        region=parent;
      }
      if(region===main)atMain=true;
      if(region===heading&&hasForeignGroupRef(region,groupId))continue;
      blocks.push({region,heading,atMain});
    }
    if(blocks.length===1)return {region:blocks[0].region,ambiguous:false,heading:blocks[0].heading};
    const topLevel=blocks.filter((item)=>item.atMain);
    if(topLevel.length===1)return {region:topLevel[0].region,ambiguous:false,heading:topLevel[0].heading};
    return {region:null,ambiguous:blocks.length>1,heading:null};
  };
  const JOIN_LABELS=['join group','join','加入小组','加入群组','加入社团','加入','tham gia','únete','unirte','participar','entrar al grupo','entrar no grupo','gabung','bergabung','เข้าร่วม','rejoindre','beitreten','iscriviti','вступить','присоединиться','참여','가입','انضمام','انضم','sertai'];
  const MEMBER_LABELS=['joined','leave group','已加入','退出小组','退出群组','退出社团','đã tham gia','rời nhóm','salir del grupo','keluar dari grup','quitter le groupe','gruppe verlassen','ออกจากกลุ่ม','已是成员','你已加入'];
  const PENDING_LABELS=['pending','request sent','cancel request','待批准','已申请','待审批','待审核','取消请求','取消加入请求','取消申请','已发送请求','đang chờ','hủy yêu cầu','solicitud enviada','cancelar solicitud','menunggu','batalkan permintaan','demande envoyée','annuler la demande','anfrage gesendet','รอการอนุมัติ','요청 보냄','요청됨','requested'];
  const QUESTION_LABELS=['membership questions','answer questions','answer these questions','questions to join','required question','回答问题','入群问题','必答','加入前请回答','trả lời câu hỏi','responde las preguntas','preguntas de membresía','jawab pertanyaan','répondez aux questions','beantworte die fragen','ตอบคำถาม'];
  const includesAny=(raw,values)=>{
    const normalized=norm(raw,512).toLowerCase();
    return Boolean(normalized)&&values.some((value)=>normalized.includes(value));
  };
  const joinKind=(raw)=>{
    if(includesAny(raw,MEMBER_LABELS))return 'joined';
    if(includesAny(raw,PENDING_LABELS))return 'pending';
    if(includesAny(raw,JOIN_LABELS))return 'join';
    return 'other';
  };
  const joinContext=()=>{
    const path=location.pathname.split('/').filter(Boolean);
    let groupId=path[0]&&path[0].toLowerCase()==='groups'?path[1]||null:null;
    if(groupId){try{groupId=decodeURIComponent(groupId).trim().toLowerCase();}catch{groupId=String(groupId).trim().toLowerCase();}}
    const main=first(['[role="main"]','main'])||document.body;
    const scope=targetGroupScope(groupId,main);
    const candidates=all('button,[role="button"],a[role="button"]').filter(visible).map((el)=>{
      const raw=label(el,256);
      return {
        el,
        raw,
        kind:joinKind(raw),
        inTargetScope:Boolean(scope.region&&scope.region.contains(el)&&!hasForeignGroupRef(el,groupId)),
      };
    });
    const scoped=candidates.filter((item)=>item.inTargetScope);
    const mainCta=scoped.find((item)=>item.kind==='join')||scoped.find((item)=>item.kind!=='other');
    const signals=scoped.filter((item)=>item.kind==='joined').map((item)=>item.raw).slice(0,16);
    const modal=first(['[role="dialog"]','[aria-modal="true"]']);
    const modalText=text(modal,1000);
    const headerText=text(scope.heading,1000);
    const blocking=blockingProbe();
    const observation={
      groupUrl:groupId?`https://www.facebook.com/groups/${groupId}`:undefined,
      pageUrl:String(location.href).slice(0,4096),
      title:text(scope.heading,200)||undefined,
      mainCtaText:mainCta&&mainCta.raw||null,
      mainCtaAria:mainCta&&label(mainCta.el,256)||null,
      headerText:headerText||null,
      modalText:modalText||null,
      membershipSignals:signals,
      loginRequired:blocking.kind==='login',
      captchaDetected:blocking.kind==='captcha',
      questionnaireRequired:includesAny(`${modalText} ${headerText}`,QUESTION_LABELS),
      pendingRequest:scoped.some((item)=>item.kind==='pending'),
      actionNodeCount:candidates.length,
      documentReady:document.readyState,
      composerPresent:Boolean(commentEditor(main)),
      joinCtaPresent:scoped.some((item)=>item.kind==='join'),
      targetGroupId:groupId,
      scopeResolved:Boolean(scope.region),
      outOfScopeJoinCount:candidates.filter((item)=>item.kind==='join'&&!item.inTargetScope).length,
      ctaCandidates:candidates.slice(0,50).map((item)=>({text:item.raw||null,kind:item.kind,inTargetScope:item.inTargetScope})),
    };
    return {observation,candidates,scope};
  };
  const joinObservation=()=>joinContext().observation;
  const joinActuation=()=>{
    const blocking=blockingProbe();
    if(blocking.kind==='login')return {clicked:false,reason:'login_required'};
    if(blocking.kind==='captcha')return {clicked:false,reason:'blocked_by_captcha'};
    if(blocking.kind==='unknown')return {clicked:false,reason:'blocked_by_unknown'};
    const context=joinContext();
    if(!context.scope.region)return {clicked:false,reason:context.scope.ambiguous?'ambiguous_target':'scope_unresolved'};
    const candidates=context.candidates.filter((item)=>item.inTargetScope&&item.kind==='join');
    if(candidates.length===0)return {clicked:false,reason:'no_target_in_scope'};
    if(candidates.length>1)return {clicked:false,reason:'ambiguous_target'};
    const target=candidates[0].el;
    if(target.disabled||target.getAttribute('aria-disabled')==='true'||target.getAttribute('disabled')!==null)return {clicked:false,reason:'disabled'};
    try{target.click();return {clicked:true};}catch{return {clicked:false,reason:'click_failed'};}
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

  const blocking=blockingProbe();
  const blocked=blocker(blocking);
  if(!['identity_read','page_probe','consent_probe','feed_probe','feed_home_target','like_probe','like_primary_commit','like_verify','like_picker_probe','follow_probe','comment_editor_probe','comment_ack_probe','join_probe','join_click','publish_entry_probe','publish_editor_probe','publish_submit_probe','reel_probe','reel_next_target','reel_cards'].includes(kind)&&blocked){
    return fail(kind||'page',blocked);
  }
  if(kind==='identity_read')return done(identity());
  if(kind==='consent_probe')return done({kind:'consent_probe',value:consentProbe()});
  if(kind==='feed_probe')return done(feedProbe());
  if(kind==='feed_home_target')return done({kind:'point_target',value:feedHomeTarget()});
  if(kind==='like_probe')return done({kind:'like_probe',value:likeProbe()});
  if(kind==='like_primary_commit')return done({kind:'like_commit',value:likePrimaryCommit()});
  if(kind==='like_verify')return done({kind:'like_verify',value:likeVerify()});
  if(kind==='like_picker_probe')return done({kind:'point_target',value:likePickerProbe()});
  if(kind==='follow_probe')return done({kind:'follow_probe',value:followProbe()});
  if(kind==='comment_editor_probe')return done({kind:'text_target',value:commentEditorProbe()});
  if(kind==='comment_ack_probe')return done({kind:'comment_ack_probe',value:commentAckProbe()});
  if(kind==='join_probe')return done({kind:'join_probe',value:joinProbe()});
  if(kind==='join_click')return done({kind:'join_click',value:joinActuation()});
  if(kind==='publish_entry_probe')return done({kind:'point_target',value:publishEntryProbe()});
  if(kind==='publish_editor_probe')return done({kind:'text_target',value:publishEditorProbe()});
  if(kind==='publish_submit_probe')return done({kind:'publish_submit_probe',value:publishSubmitProbe()});
  if(kind==='reel_probe')return done({kind:'reel_probe',value:reelProbeValue(activeReel())});
  if(kind==='reel_next_target')return done({kind:'reel_next_target',value:reelNextTarget()});
  if(kind==='reel_cards')return done(feedCards());
  if(kind==='page_probe'){
    const surface=classify();
    const cards=topArticles().length;
    const probedKind=blocking.kind==='captcha'?'captcha':blocking.kind==='login'?'login':blocking.kind==='unknown'?'unknown':surface==='home'?'home':surface==='search'?'search':surface.endsWith('_post')?'note_detail':surface==='login'?'login':'unknown';
    return done({kind:'page_probe',value:{
      targetId:'',
      origin:location.origin,
      path:location.pathname,
      readyState:['loading','interactive','complete'].includes(document.readyState)?document.readyState:'unknown',
      pageKind:probedKind,
      blockingKind:blocking.kind,
      blockingText:blocking.text?blocking.text.slice(0,1000):undefined,
      signals:{feedCardCount:cards,noteDetailCount:surface.endsWith('_post')?1:0,loginWallCount:blocking.kind==='login'?1:0,captchaSignalCount:blocking.kind==='captcha'?1:0,dialogCount:all('[role="dialog"],[aria-modal="true"]').filter(visible).length,profileSignalCount:surface==='page'?1:0,notificationSignalCount:0,publishSignalCount:0,errorSignalCount:blocking.kind==='unknown'?1:0,mainCount:all('main,[role="main"]').length},
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
    return verified?done(action('comment',true,undefined,{noteId:String(p.noteId||'')})):ambiguous('comment','verification_ambiguous',{noteId:String(p.noteId||'')});
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
    const member=before.membershipSignals.length>0;
    if(member)return done(action('join_group',false,'already_member',{groupUrl,clicked:false,groupObservation:before}));
    if(before.questionnaireRequired)return fail('join_group','questionnaire_required');
    if(before.pendingRequest)return done(action('join_group',false,'pending',{groupUrl,clicked:false,groupObservation:before}));
    if(!p.click)return done(action('join_group',false,'observation_only',{groupUrl,clicked:false,groupObservation:before}));
    if(!before.scopeResolved)return fail('join_group','not_ready');
    const actuation=joinActuation();
    if(!actuation.clicked){
      if(['scope_unresolved','no_target_in_scope','ambiguous_target'].includes(actuation.reason))return fail('join_group','not_ready');
      return fail('join_group','no_button');
    }
    await sleep(900);
    const after=joinObservation();
    if(after.loginRequired)return ambiguous('join_group','login_required',{groupUrl,clicked:true,groupObservation:before,postObservation:after});
    if(after.captchaDetected)return ambiguous('join_group','blocked_by_captcha',{groupUrl,clicked:true,groupObservation:before,postObservation:after});
    if(after.pendingRequest)return done(action('join_group',false,'pending',{groupUrl,clicked:true,groupObservation:before,postObservation:after}));
    if(after.questionnaireRequired)return done(action('join_group',false,'questionnaire_required',{groupUrl,clicked:true,groupObservation:before,postObservation:after}));
    const joined=after.membershipSignals.length>0||(!before.composerPresent&&after.composerPresent&&!after.joinCtaPresent);
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
