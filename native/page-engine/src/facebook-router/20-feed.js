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
