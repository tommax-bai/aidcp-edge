  /**
   * 成卡（change generalize-facebook-content-derived-post-identity）。
   *
   * 拿得到平台永久链接 ⇒ 身份是 `permalink`，与今天逐位一致。
   * 拿不到 ⇒ **不再整张丢掉**，改签发内容派生的会话内引用（复用群组首帖那套证据 + 摘要 + DOM 标记机制）。
   * 2026-07-29 真机：群组帖在零交互下拿不到任何可接受地址（6/6 卡为 0），整条浏览链路因此 100% 阻塞。
   *
   * 红线：两类身份必须**显式分档**回传。消费方按分档判能力，绝不能靠正则匹配字符串形态去猜——
   * 漏判一处就是把会话内引用当地址用。
   */
  /** feed 是否正在加载（与 feedProbe 的 loading 同源判据，抽出来供成卡判定共用）。 */
  const feedLoading=()=>{
    const scope=first(['div[role="feed"]','[role="main"]','main'])||document.body;
    return Boolean(scope&&scope.querySelector('[role="progressbar"],[aria-busy="true"]'));
  };
  const cardOf=async(article,index,preferredHref='')=>{
    const href=cleanPermalink(preferredHref)||permalinkOf(article);
    const id=postId(href);
    const author=articleAuthor(article);
    const body=articleBody(article)||(preferredHref?text(article,12000):'');
    const base={
      index,
      title:body.slice(0,200),
      author:author.name||undefined,
      likeCount:count(reactionCountWitness(article)),
      collectCount:0,
      coverDesc:body.slice(0,200)||undefined,
    };
    if(href&&id)return {
      ...base,
      noteId:href,
      noteIdKind:'permalink',
      isVideo:Boolean(first(['video'],article)||/\/videos\/|\/reel\/|\/watch/.test(href)),
    };
    // 加载中一律不签发引用：此刻永久链接**可能只是还没水合**。先发一个内容引用、等链接出来再发一次
    // 平台身份，同一条帖子就会被上报两次、浏览也被记两次。宁可这一轮不报（下一轮判稳后自然会有），
    // 也不制造重复身份。（既有用例 facebook-router-contract「区分加载中 / 可见不可上报 / 明确空态」守住这条。）
    if(feedLoading())return null;
    const evidence=firstPostEvidence(article);
    if(!evidence)return null;                        // 证据不足以成立 ⇒ 仍然不成卡，绝不臆造身份
    // 已绑过且证据未变 ⇒ 直接复用，跳过摘要计算。判稳期每 500ms 就要重扫一次，
    // 群组帖那种「整屏都没有平台地址」的页面上，不复用等于每半秒把全屏卡片重新哈希一遍。
    const existingRef=article.getAttribute&&article.getAttribute('data-aidcp-native-first-post-target');
    if(existingRef){
      const state=firstPostTargetState();
      const record=state&&state.targets instanceof Map?state.targets.get(existingRef):null;
      if(record&&record.root===article&&record.evidence===evidence.value)return {
        ...base,
        noteId:existingRef,
        noteIdKind:'content_ref',
        isVideo:Boolean(first(['video'],article)),
      };
    }
    const bound=await bindFirstPostTarget(article,evidence);
    if(!bound.ok)return null;                        // 歧义 / 绑定失败 ⇒ 不成卡
    return {
      ...base,
      noteId:bound.targetRef,
      noteIdKind:'content_ref',
      isVideo:Boolean(first(['video'],article)),
    };
  };
  /** 去重键：永久链接走规范化 id（同帖不同链接形态要归一）；会话内引用本身即已是摘要，直接用。 */
  const cardDedupeKey=(card)=>!card?'':card.noteIdKind==='content_ref'?String(card.noteId||''):postId(card.noteId);
  // 身份候选筛选（change acquire-facebook-feed-post-identity-by-hover）。
  // Facebook 把帖子地址扣在 DOM 之外：一张卡里有几个指向站点根路径的链接，只有**时间戳**那个
  // 在可信指针落上去之后才换出真地址（2026-07-29 越南语首页实测：可信指针 5/5、页面内合成事件 0/8）。
  // 同卡的其余同形链接是「用链接实现的按钮」（如隐藏此帖，实测 36×36 含图标带无障碍标签、悬停后不变），
  // 本就没有目的地，试它纯浪费。故按形状区分：时间戳是扁长的纯文字链接（实测 124×15、卡顶部、无标签）。
  // 宁可漏筛（多试一次）也不误筛（永远试不到）——阈值取宽松侧。
  //
  // **只按高度分，不按宽高比分**（2026-07-29 两台真机标定）：时间戳高度恒 15，隐藏按钮 36，
  // 高度是稳定判据；而宽度随时间戳文案长短变（Xu Nu 124px / Vo Tu 32px，比例 8.3 vs 2.1），
  // 一旦按比例筛，短文案那台会把时间戳整个筛掉、采集恒零命中。
  const IDENTITY_CANDIDATE_MAX_HEIGHT_PX=24;
  const IDENTITY_CANDIDATE_MIN_WIDTH_PX=8;
  const IDENTITY_CANDIDATE_VIEWPORT_MARGIN_PX=70;
  const IDENTITY_CANDIDATE_LIMIT=24;
  const cardHasIdentity=(article)=>Boolean(postId(permalinkOf(article)));
  const isIdentityCandidate=(anchor)=>{
    if(!anchor||!visible(anchor))return false;
    if(anchor.getAttribute('aria-label'))return false;      // 带无障碍标签的是控件，不是时间戳
    if(anchor.querySelector('svg,img'))return false;        // 含图标的是控件
    if(!text(anchor,64))return false;                       // 时间戳有文字（虽被打散），控件没有
    let path='';
    try{path=new URL(anchor.href||anchor.getAttribute('href')||'',location.origin).pathname;}catch{return false;}
    if(path!=='/')return false;                             // 已有真地址或纯锚点的都不是候选
    const rect=anchor.getBoundingClientRect();
    if(rect.height>IDENTITY_CANDIDATE_MAX_HEIGHT_PX)return false;
    if(rect.width<IDENTITY_CANDIDATE_MIN_WIDTH_PX)return false;
    const centerY=rect.top+rect.height/2;
    const viewportHeight=Number(window.innerHeight)||0;
    // 视口外悬停实测无效，直接不产出，避免引擎白跑一次移动
    return centerY>=IDENTITY_CANDIDATE_VIEWPORT_MARGIN_PX&&centerY<=viewportHeight-IDENTITY_CANDIDATE_VIEWPORT_MARGIN_PX;
  };
  const identityCandidates=()=>{
    const candidates=[];
    let resolved=0;
    const articles=reelSurface()?[]:topArticles();
    articles.forEach((article,cardIndex)=>{
      if(cardHasIdentity(article)){resolved+=1;return;}     // 地址一经换出即持久，已有的不再采集
      for(const anchor of all('a[href]',article)){
        if(candidates.length>=IDENTITY_CANDIDATE_LIMIT)return;
        if(!isIdentityCandidate(anchor))continue;
        const rect=anchor.getBoundingClientRect();
        candidates.push({
          cardIndex,
          x:Math.round(rect.left+rect.width/2),
          y:Math.round(rect.top+rect.height/2),
        });
      }
    });
    return {kind:'identity_candidates',value:{
      candidates,
      cardCount:articles.length,
      resolvedCount:resolved,
    }};
  };
  const feedCards=async()=>{
    const cards=[];
    const seen=new Set();
    const active=reelSurface()?activeReel():null;
    const articles=active&&active.ok&&active.root?[active.root]:reelSurface()?[]:topArticles();
    for(const article of articles){
      const card=await cardOf(article,cards.length,active&&active.ok?active.noteId:'');
      const id=cardDedupeKey(card);
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
      // 「有物理卡」一律以水合证据为准（hydratedCards），不数空壳——与 feedProbe 的 articleCount 同源，
      // 否则一处严一处宽，present_unreportable 会拿假依据授权切 Reels。
      listState:cards.length?'ready':(listKind==='reels'?Boolean(active&&active.reason!=='no_active_video'):hydratedCards().length)?'present_unreportable':'empty',
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
      const card=await cardOf(root,0,canonical);
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
      likeCount:count(reactionCountWitness(root)),
      collectCount:0,
      coverDesc:evidence.body.slice(0,200)||undefined,
      noteId:bound.targetRef,
      isVideo:Boolean(first(['video'],root)),
    }};
  };
  const firstPostCards=async()=>{
    const base=await feedCards();
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
  // 返回承担滚动的那个元素；null 表示由窗口/文档承担（绝大多数版式）。
  const feedScrollNode=()=>{
    const doc=document.scrollingElement||document.documentElement;
    if(doc&&doc.scrollHeight-doc.clientHeight>1)return null;
    const anchor=first(['div[role="feed"]','[role="main"]','main'])||document.body;
    for(let node=anchor;node&&node!==document.documentElement;node=node.parentElement){
      if(node.scrollHeight-node.clientHeight<=1)continue;
      let overflowY='';
      try{overflowY=getComputedStyle(node).overflowY||'';}catch{}
      if(!/(auto|scroll|overlay)/.test(overflowY))continue;
      return node;
    }
    return null;
  };
  const feedScrollMetrics=()=>{
    const node=feedScrollNode();
    if(node)return {scrollY:Number(node.scrollTop)||0,scrollHeight:Number(node.scrollHeight)||0};
    const doc=document.scrollingElement||document.documentElement;
    return {scrollY:Number(window.scrollY)||0,scrollHeight:Number(doc&&doc.scrollHeight)||0};
  };
  // 实际滚动也必须落在同一个元素上：只改测量口径而仍然滚窗口，位移依旧恒 0。
  // 返回滚动前的位置，供随后的位移/到底回报使用。
  const feedScrollBy=(delta)=>{
    const node=feedScrollNode();
    if(node){
      const before=Number(node.scrollTop)||0;
      if(typeof node.scrollBy==='function')node.scrollBy({top:delta,behavior:'smooth'});
      else node.scrollTop=before+delta;
      return before;
    }
    const before=Number(window.scrollY)||0;
    window.scrollBy({top:delta,behavior:'smooth'});
    return before;
  };
  const feedScrollMovement=(before)=>{
    const node=feedScrollNode();
    if(node){
      const after=Number(node.scrollTop)||0;
      return {
        before,
        after,
        moved:after!==before,
        atBottom:after+(Number(node.clientHeight)||0)>=(Number(node.scrollHeight)||0)-8,
      };
    }
    const after=Number(window.scrollY)||0;
    return {
      before,
      after,
      moved:after!==before,
      atBottom:after+(Number(window.innerHeight)||0)>=document.documentElement.scrollHeight-8,
    };
  };
  // 越南语空白/阻塞页实测恢复入口。这里只做唯一目标定位；真实点击必须由 Native CDP 完成。
  const feedRecoveryTarget=()=>{
    const actionText=(value)=>norm(value,256)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'')
      .replace(/[đĐ]/g,'d')
      .toLowerCase();
    const candidates=all('a[href],button,[role="button"]')
      .filter(visible)
      .filter((node)=>[label(node,256),text(node,256)].some((value)=>actionText(value)==='di den bang feed'));
    if(!candidates.length)return {ok:false,reason:'no_feed_recovery_target'};
    if(candidates.length!==1)return {ok:false,reason:'ambiguous_feed_recovery_target'};
    const rect=candidates[0].getBoundingClientRect();
    const cx=rect.left+rect.width/2;
    const cy=rect.top+rect.height/2;
    if(cx<0||cy<0||cx>Number(window.innerWidth)||cy>Number(window.innerHeight)){
      return {ok:false,reason:'feed_recovery_target_out_of_view'};
    }
    return {ok:true,cx,cy};
  };
  const feedProbe=async()=>{
    const output=await feedCards();
    const scope=first(['div[role="feed"]','[role="main"]','main'])||document.body;
    const scrollMetrics=feedScrollMetrics();
    const loading=Boolean(scope&&scope.querySelector('[role="progressbar"],[aria-busy="true"]'));
    // 只数已水合的卡。虚拟化占位壳有高度、可见、但无作者也无正文——它不是「有内容读不出来」的证据。
    const articleCount=reelSurface()?0:hydratedCards().length;
    const timeOrigin=Number(performance&&performance.timeOrigin);
    const elapsedMs=Number.isFinite(timeOrigin)?Date.now()-timeOrigin:0;
    const documentAgeMs=Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.floor(Number.isFinite(elapsedMs)?elapsedMs:0)));
    let explicitEmpty=false,explicitEnd=false;
    for(const node of all('div,section',scope||document)){
      if(!visible(node))continue;
      const raw=text(node,600);
      if(raw.length<15)continue;
      const clean=fold(raw).toLowerCase();
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
      feedRecoveryTarget:feedRecoveryTarget(),
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
  // 就地展开读的调参。量级沿用已退役的 TypeScript 就地读实现，不另起一套。
  const EXPAND_CONTROL_TEXT=/(查看更多|查看全文|展开|顯示更多|See more|View more|Ver más|Mostrar más|Voir plus|Xem thêm)/i;
  const EXPAND_SHORTCUT_RATIO=1.2;
  const EXPAND_SHORTCUT_MIN_DELTA=30;
  const EXPAND_SETTLE_MS=400;
  const EXPAND_POLL_ROUNDS=6;
  const EXPAND_POLL_MS=300;
  // 就地读的正文容器：只认目标卡自己的 message 容器，绝不落到嵌套评论的同名容器上。
  const messageContainer=(root)=>{
    for(const candidate of all(MESSAGE_CONTAINER_SEL,root)){
      if(closestArticle(candidate)===root)return candidate;
    }
    return null;
  };
  // 锚定展开控件：目标卡 message 容器内、[role=button]、非 <a>（导航链接不是就地展开）、可见、文案命中展开词。
  // 文案只作最后一道判据；结构（作用域 + 非链接 + 可点）才是主判据。
  const expandControl=(root)=>{
    const scope=messageContainer(root)||root;
    for(const el of all('[role="button"]',scope)){
      if(el.tagName==='A'||(el.closest&&el.closest('a')))continue;
      if(closestArticle(el)!==root)continue;
      if(!visible(el))continue;
      if(EXPAND_CONTROL_TEXT.test(text(el,256)))return el;
    }
    return null;
  };
  const articleIndexOf=(root)=>topArticles().indexOf(root);
  const readContext=(root)=>({
    href:String(location.href),
    dialogs:all('[role="dialog"],[aria-modal="true"]').filter(visible).length,
    index:articleIndexOf(root),
  });
  const contextChanged=(before,after)=>
    before.href!==after.href||before.dialogs!==after.dialogs||before.index!==after.index;
  /**
   * feed 面就地读全文：判捷径 → 必要时点锚定展开控件 → 有界轮询等正文变长 → 展开前后校验环境未变。
   *
   * 三条诚实终态（MUST NOT 静默假成功）：
   *  - 点了展开但正文长度未增 → expand_no_effect（不上报详情，云端不记这次浏览）；
   *  - 环境变化（URL / 弹层数 / 目标卡序号）→ context_changed，交 Rust 回落详情导航；
   *  - 无展开控件的短帖读到什么算什么（正常成功，非 no_target）。
   */
  const inlineExpandRead=async(root)=>{
    const message=messageContainer(root);
    const innerOf=()=>norm(message?message.innerText||'':articleBody(root),12000);
    const fullOf=()=>norm(message?message.textContent||'':'',12000);
    const baseInner=innerOf();
    const baseFull=fullOf();
    // 捷径判据：textContent 显著长于 innerText ⇒ 全文已在 DOM 内、只是被视觉截断，无需点击。
    // 双守卫（比例 + 绝对差）避免折叠帖（两者约等）被误判成捷径。
    if(baseInner.length>0
      &&baseFull.length>baseInner.length*EXPAND_SHORTCUT_RATIO
      &&baseFull.length-baseInner.length>EXPAND_SHORTCUT_MIN_DELTA){
      return {ok:true,body:baseFull,mode:'shortcut'};
    }
    const control=expandControl(root);
    if(!control)return {ok:true,body:baseInner||articleBody(root),mode:'short_post'};
    const before=readContext(root);
    let clicked=false;
    try{control.click();clicked=true;}catch{clicked=false;}
    if(!clicked)return {ok:false,reason:'expand_dispatch_failed'};
    await sleep(EXPAND_SETTLE_MS);
    let grown=innerOf();
    for(let round=0;round<EXPAND_POLL_ROUNDS&&grown.length<=baseInner.length;round++){
      await sleep(EXPAND_POLL_MS);
      if(!root.isConnected)break;
      grown=innerOf();
    }
    if(!root.isConnected)return {ok:false,reason:'stale_target'};
    if(contextChanged(before,readContext(root)))return {ok:false,reason:'context_changed'};
    if(grown.length<=baseInner.length)return {ok:false,reason:'expand_no_effect'};
    return {ok:true,body:grown,mode:'expanded'};
  };
  const noteDetail=(root,href,bodyOverride)=>{
    const author=articleAuthor(root);
    const body=typeof bodyOverride==='string'&&bodyOverride?bodyOverride:articleBody(root);
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
      likeCount:count(reactionCountWitness(root)),
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
    // 兜底链一路到 document.body 仍可能落空（导航瞬间 body 尚未挂上）。
    // 把空根交给详情遍历，过去是当场抛异常；现在诚实报找不到目标，绝不把「读不到」说成一次已完成的开帖。
    if(!root||typeof root.querySelectorAll!=='function')return action('open',false,'target_not_found');
    return noteDetail(root,permalinkOf(root)||cleanPermalink(location.href)||expected);
  };
