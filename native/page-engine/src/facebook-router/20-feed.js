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
  const firstPostCommentEditors=(root=document)=>all(
    '[contenteditable="true"][role="textbox"],textarea[aria-label],textarea',
    root,
  ).filter(visible).filter((editor)=>{
    const raw=`${label(editor)} ${text(editor,256)}`;
    return postComment.test(raw)||editor.getAttribute('role')==='textbox';
  });
  const firstPostCommentActions=(root=document)=>all(
    'button,[role="button"],a[role="button"]',
    root,
  ).filter(visible).filter((button)=>{
    const raw=`${label(button)} ${text(button,256)}`;
    if(!postComment.test(raw))return false;
    return !/(?:avatar|gif|sticker|nhãn dán|nhan dan|emoji|photo|ảnh|anh|video)/i.test(raw);
  });
  const associatedFirstPostCommentActions=(root)=>firstPostCommentActions(root).filter((button)=>{
    const article=closestArticle(button);
    return !article||article===root;
  });
  const firstPostBoundary=(control,scope)=>{
    let article=closestArticle(control);
    while(article&&article.parentElement){
      const outer=article.parentElement.closest('[role="article"],article');
      if(!outer)break;
      article=outer;
    }
    if(article&&firstPostEvidence(article))return article;
    for(let root=control&&control.parentElement;root&&root!==scope&&root!==document.body;root=root.parentElement){
      if(firstPostEvidence(root))return root;
    }
    return null;
  };
  const firstPostBoundaryOrder=(left,right)=>{
    const l=left.getBoundingClientRect();
    const r=right.getBoundingClientRect();
    if(l.top!==r.top)return l.top-r.top;
    const relation=left.compareDocumentPosition(right);
    return relation&4?-1:relation&2?1:0;
  };
  const firstCommentableGroupPostCard=async()=>{
    if(classify()!=='group')return {card:null};
    const scope=first(['div[role="feed"]','[role="main"]','main'])||document.body;
    if(!scope)return {card:null};
    const controls=[...firstPostCommentEditors(scope),...firstPostCommentActions(scope)];
    const roots=[];
    for(const control of controls){
      const root=firstPostBoundary(control,scope);
      if(root&&!roots.includes(root))roots.push(root);
    }
    roots.sort(firstPostBoundaryOrder);
    const root=roots[0];
    if(!root)return {card:null};
    const evidence=firstPostEvidence(root);
    if(!evidence)return {card:null,reason:'target_context_mismatch'};
    const canonical=permalinkOf(root);
    if(canonical){
      const card=cardOf(root,0,canonical);
      return card?{card}:{card:null,reason:'target_context_mismatch'};
    }
    const editors=firstPostCommentEditors(root);
    if(editors.length>1)return {card:null,reason:'ambiguous_target'};
    if(editors.length===0){
      const actions=associatedFirstPostCommentActions(root);
      if(actions.length!==1)return {card:null,reason:actions.length?'ambiguous_target':'editor_not_found'};
    }
    const bound=await bindFirstPostTarget(root,evidence);
    if(!bound.ok)return {card:null,reason:bound.reason||'target_context_mismatch'};
    return {card:{
      index:0,
      title:evidence.body.slice(0,200),
      author:evidence.author,
      likeCount:count(text(reactionButton(root),96)||label(reactionButton(root),96)),
      collectCount:0,
      coverDesc:evidence.body.slice(0,200)||undefined,
      noteId:bound.targetRef,
      isVideo:Boolean(first(['video'],root)),
    }};
  };
  const firstPostCards=async()=>{
    const base=feedCards();
    const selected=await firstCommentableGroupPostCard();
    if(selected.card){
      base.value.cards=[selected.card];
      base.value.listState='ready';
      base.value.documentGeneration=[
        location.pathname,
        'first-commentable-group-post',
        selected.card.noteId,
      ].join('|').slice(0,256);
      return base;
    }
    if(selected.reason){
      base.value.cards=[];
      base.value.selectionReason=selected.reason;
      base.value.listState='present_unreportable';
      return base;
    }
    return base;
  };
  // 滚动位移/到底判据必须读**真正在滚的那个元素**。Facebook 有一类版式（2026-07-28 越南语群页实测）
  // 文档本身不滚：document.documentElement.scrollHeight === innerHeight、window.scrollY 恒 0，
  // 真正的滚动条在 feed 的一个祖先 div 上（overflow-y:auto，scrollHeight 2511 / clientHeight 803）。
  // 照读窗口坐标 ⇒ moved 恒 false、near_bottom 恒 true（scrollHeight-scrollY-innerHeight = 0 ≤ innerHeight），
  // 引擎从第一次探测起就认为"feed 已到底"、滚动回报 no_target。窗口真的会滚时行为不变。
  const feedScrollMetrics=()=>{
    const doc=document.scrollingElement||document.documentElement;
    const windowMetrics={scrollY:Number(window.scrollY)||0,scrollHeight:Number(doc&&doc.scrollHeight)||0};
    if(doc&&doc.scrollHeight-doc.clientHeight>1)return windowMetrics;
    const anchor=first(['div[role="feed"]','[role="main"]','main'])||document.body;
    for(let node=anchor;node&&node!==document.documentElement;node=node.parentElement){
      if(node.scrollHeight-node.clientHeight<=1)continue;
      let overflowY='';
      try{overflowY=getComputedStyle(node).overflowY||'';}catch{}
      if(!/(auto|scroll|overlay)/.test(overflowY))continue;
      return {scrollY:Number(node.scrollTop)||0,scrollHeight:Number(node.scrollHeight)||0};
    }
    return windowMetrics;
  };
  const feedProbe=()=>{
    const output=feedCards();
    const scope=first(['div[role="feed"]','[role="main"]','main'])||document.body;
    const scrollMetrics=feedScrollMetrics();
    const loading=Boolean(scope&&scope.querySelector('[role="progressbar"],[aria-busy="true"]'));
    const articleCount=reelSurface()?0:topArticles().length;
    const timeOrigin=Number(performance&&performance.timeOrigin);
    const elapsedMs=Number.isFinite(timeOrigin)?Date.now()-timeOrigin:0;
    const documentAgeMs=Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.floor(Number.isFinite(elapsedMs)?elapsedMs:0)));
    let explicitEmpty=false,explicitEnd=false;
    for(const node of all('div,section',scope||document)){
      if(!visible(node))continue;
      const raw=text(node,600);
      if(raw.length<15)continue;
      const clean=raw.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const title=/no more posts|there are no posts|khong con bai viet nao|khong co bai viet nao|没有更多帖子|没有帖子/i.test(clean);
      const hint=/add friends|them ban be|添加好友/i.test(clean)&&/feed|bang feed|动态消息|信息流/i.test(clean);
      if(title)explicitEnd=true;
      if(title&&hint)explicitEmpty=true;
      if(explicitEnd&&explicitEmpty)break;
    }
    return {kind:'feed_probe',value:{
      cards:output.value.cards,
      documentGeneration:output.value.documentGeneration,
      listKind:output.value.listKind,
      listState:output.value.listState,
      loading,
      articleCount,
      explicitEmpty,
      explicitEnd,
      url:String(location.href).slice(0,4096),
      surface:classify(),
      scrollY:scrollMetrics.scrollY,
      innerWidth:Number(window.innerWidth)||0,
      innerHeight:Number(window.innerHeight)||0,
      scrollHeight:scrollMetrics.scrollHeight,
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
