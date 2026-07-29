(request=>{
  const req=request&&typeof request==='object'?request:{};
  const kind=String(req.kind||'');
  const op=String(req.op||'probe');
  const clip=(raw,n)=>{
    if(raw.length<=n)return raw;
    const points=Array.from(raw);
    return points.length>n?points.slice(0,n).join(''):raw;
  };
  const norm=(v,n=32000)=>clip(String(v??'').replace(/\s+/g,' ').trim(),n);
  const visible=(el)=>{
    if(!el||!el.getBoundingClientRect)return false;
    const r=el.getBoundingClientRect();
    const s=window.getComputedStyle?getComputedStyle(el):null;
    return r.width>1&&r.height>1&&(!s||(s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0.05));
  };
  const all=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const first=(selectors,root=document)=>{
    for(const selector of selectors){
      const hit=all(selector,root).find(visible);
      if(hit)return hit;
    }
    return null;
  };
  const text=(el,n=2000)=>norm(el&&(el.innerText||el.textContent||(el.getAttribute&&el.getAttribute('aria-label'))),n);
  const detailRoot=()=>first(['.note-detail-mask','.note-container','#noteContainer','[class*="note-detail"]','[class*="noteDetail"]','[role="dialog"]']);
  const noteIdFrom=(value)=>{
    const hit=String(value||'').match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
    return hit?hit[1]:'';
  };
  const findByWords=(words,root=document)=>{
    const expected=words.map((word)=>String(word).toLowerCase()).filter(Boolean);
    for(const selector of ['button,[role="button"],a','span','div']){
      const hit=all(selector,root).filter(visible).find((el)=>expected.some((word)=>text(el,100).toLowerCase().includes(word)));
      if(hit)return hit;
    }
    return null;
  };
  const readEditor=(el)=>'value' in el?String(el.value||''):String((el&&(el.innerText||el.textContent))||'');
  const geometry=(el)=>{const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};};
  const miss=()=>({found:false,focused:false,value:'',plainValue:false,x:0,y:0,paragraphs:0});
  const viewport=()=>{
    const doc=document.documentElement||{};
    return {w:Number(window.innerWidth)||Number(doc.clientWidth)||0,h:Number(window.innerHeight)||Number(doc.clientHeight)||0};
  };
  // 可滚区矩形与视口的**交集**中心，不是矩形几何中心：内层滚动容器常比视口高，
  // 它的几何中心可能落在视口外，而滚轮事件按视口坐标派发 —— 派到视口外等于没派。
  const visibleCenter=(el)=>{
    const v=viewport();
    if(!(v.w>0&&v.h>0))return null;
    if(!el)return {x:v.w/2,y:v.h/2};
    const r=el.getBoundingClientRect();
    const left=Math.max(0,r.left),top=Math.max(0,r.top);
    const right=Math.min(v.w,r.right),bottom=Math.min(v.h,r.bottom);
    if(!(right-left>2&&bottom-top>2))return null;
    return {x:(left+right)/2,y:(top+bottom)/2};
  };
  // 真·可滚判据：内容溢出**且**该轴的 overflow 是滚动语义。只看 scrollHeight>clientHeight
  // 会把「内容溢出但 overflow:visible」的容器当成滚动容器，于是位置读的是恒为 0 的 scrollTop、
  // 而真正在滚的是窗口 —— 一次真实的翻页会被读成「没动」（把成功压成失败，同样是不诚实）。
  const scrollable=(el)=>{
    if(!el||!el.getBoundingClientRect)return false;
    if(!(Number(el.scrollHeight||0)-Number(el.clientHeight||0)>4))return false;
    const s=window.getComputedStyle?getComputedStyle(el):null;
    if(!s)return true;
    const overflow=String(s.overflowY||s.overflow||'');
    return overflow==='auto'||overflow==='scroll'||overflow==='overlay';
  };
  const pickScroller=(selectors,root=document)=>{
    for(const selector of selectors){
      const hit=all(selector,root).filter(visible).find(scrollable);
      if(hit)return hit;
    }
    return null;
  };
  const windowArea=()=>{
    const center=visibleCenter(null);
    if(!center)return null;
    const doc=document.scrollingElement||document.documentElement;
    const v=viewport();
    const position=Number(window.scrollY||0)||Number((doc&&doc.scrollTop)||0)||0;
    const total=Number((doc&&doc.scrollHeight)||0);
    return {scroller:'window',position,viewportHeight:v.h,atBottom:total>0&&position+v.h>=total-24,...center};
  };
  const elementArea=(el)=>{
    const center=visibleCenter(el);
    if(!center)return null;
    const position=Number(el.scrollTop||0);
    const total=Number(el.scrollHeight||0);
    const client=Number(el.clientHeight||0);
    return {scroller:'element',position,viewportHeight:viewport().h,atBottom:total>0&&position+client>=total-24,...center};
  };
  // 宽 / 窄两套布局下可滚元素不同（可能是内层容器、也可能就是窗口），所以坐标与位置一律
  // **实测解析**，不写死视口中心、更不写死某个平台的常量。解析不出来时 found=false ——
  // 「读不到」与「没滚动」是两态，调用方不得把前者当后者。
  const scrollArea=(selectors,root=document)=>{
    const el=pickScroller(selectors,root);
    const resolved=(el?elementArea(el):null)||windowArea();
    if(!resolved)return {found:false};
    return {found:true,windowPosition:Number(window.scrollY||0),...resolved};
  };
  const commentRows=(root)=>{
    // 逐个选择器试，取第一个真数出条目的那个：几个选择器求并集会把「评论行」与
    // 「评论行里的正文块」重复计一次，回报的条数就比页面上多出一倍。
    for(const selector of ['[class*="comment-item"]','[class*="commentItem"]','[class*="comment"] [class*="content"]']){
      const rows=all(selector,root).filter(visible);
      if(rows.length)return rows;
    }
    return [];
  };
  // 清场：受控框走原型 value setter，contenteditable 走 textContent，再补合成 input/change。
  // 这是「把残文抹掉」，不是「把内容写进去」——内容一律走硬件级逐字/分块输入。
  const clearEditor=(el)=>{
    try{
      if('value' in el){
        const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        const descriptor=Object.getOwnPropertyDescriptor(proto,'value');
        if(descriptor&&descriptor.set)descriptor.set.call(el,'');else el.value='';
      }else{
        el.textContent='';
      }
      for(const type of ['input','change'])el.dispatchEvent(new Event(type,{bubbles:true,composed:true}));
    }catch{}
    return norm(readEditor(el))==='';
  };
  const cursorToEnd=(el)=>{
    try{
      if('value' in el&&typeof el.setSelectionRange==='function'){const end=String(el.value||'').length;el.setSelectionRange(end,end);return true;}
      const selection=window.getSelection&&window.getSelection();
      if(!selection||!document.createRange)return false;
      const range=document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }catch{return false;}
  };
  const paragraphCount=(el)=>{
    if('value' in el)return String(el.value||'').split('\n').filter((line)=>line.trim().length>0).length;
    const blocks=Array.from(el.children||[]).filter((child)=>/^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(child.tagName||''));
    if(blocks.length)return blocks.filter((block)=>text(block,4000).length>0).length;
    return text(el,32000)?1:0;
  };
  const commentEditor=()=>first(['textarea','[contenteditable="true"]','input[placeholder*="评论"]'],detailRoot()||document);
  const publishField=(fieldType)=>fieldType==='title'
    ?first(['input[placeholder*="标题"]','textarea[placeholder*="标题"]','input[class*="title"]'])
    :first(['[contenteditable="true"]','textarea[placeholder*="正文"]','textarea[placeholder*="描述"]']);
  const respond=(el)=>{
    if(!el)return miss();
    if(op==='clear'){
      const cleared=clearEditor(el);
      return {found:true,focused:document.activeElement===el,value:readEditor(el),plainValue:'value' in el,cleared,...geometry(el),paragraphs:paragraphCount(el)};
    }
    if(op==='focus'){
      try{el.focus();}catch{}
      cursorToEnd(el);
      return {found:true,focused:document.activeElement===el,value:readEditor(el),plainValue:'value' in el,...geometry(el),paragraphs:paragraphCount(el)};
    }
    if(op==='cursor_to_end'){
      const moved=cursorToEnd(el);
      return {found:true,focused:document.activeElement===el,value:readEditor(el),plainValue:'value' in el,cursorAtEnd:moved,...geometry(el),paragraphs:paragraphCount(el)};
    }
    return {found:true,focused:document.activeElement===el,value:readEditor(el),plainValue:'value' in el,...geometry(el),paragraphs:paragraphCount(el)};
  };

  // 目标笔记闸：地址 / 详情容器解析出的笔记 id 必须与被点名的那条一致。
  if(kind==='note_guard'){
    const current=noteIdFrom(location.href)||noteIdFrom((first(['.note-detail-mask a[href*="/explore/"]','[class*="note-detail"] a[href*="/explore/"]'])||{}).href);
    const wanted=norm(req.noteId||'',256);
    return {found:true,match:!wanted||(Boolean(current)&&current===wanted),noteId:current||''};
  }
  if(kind==='comment_editor')return respond(commentEditor());
  if(kind==='publish_field')return respond(publishField(String(req.fieldType||'content')));
  if(kind==='comment_submit'){
    const submit=findByWords(['发送','发布','submit'],detailRoot()||document);
    return submit?{found:true,...geometry(submit)}:miss();
  }
  // feed 翻页的可滚区。选择器只用来**优先**认内层滚动容器；一个都不成立就回落到窗口，
  // 两条路都给出实测坐标与实测位置。
  if(kind==='feed_scroll_area'){
    return scrollArea(['#exploreFeeds','[class*="feeds-page"]','[class*="feeds-container"]','[class*="feed-container"]','main']);
  }
  // 详情页评论区的可滚区 + 当前页面上真实可见的评论条数。
  if(kind==='comment_scroll_area'){
    const root=detailRoot()||document;
    const area=scrollArea(['[class*="comment-list"]','[class*="comments"]','[class*="detail"]'],root);
    return {...area,rows:commentRows(root).length};
  }
  // 详情浮层的关闭控件。`overlay` 与 `found` 是两件事：浮层不在（无需关）与浮层在但关闭控件
  // 没认出来（关不掉），调用方要分开处置。
  if(kind==='detail_close'){
    const modal=detailRoot();
    if(!modal)return {found:false,overlay:false};
    const close=first(['[class*="close"]','button[aria-label*="关闭"]'],modal);
    return close?{found:true,overlay:true,...geometry(close)}:{found:false,overlay:true};
  }
  if(kind==='comment_ack'){
    const wanted=norm(req.text||'',500);
    const root=detailRoot()||document;
    return {found:true,appeared:Boolean(wanted)&&all('[class*="comment"]',root).some((el)=>text(el,32000).includes(wanted))};
  }
  // 换行后的归尾状态。ProseMirror 的选区落在末段 <p> 内，与外层容器的末端 Range
  // 视觉等价但边界容器不同，**不能**用严格边界相等判断；正确语义是「光标在最后一个顶层块内，
  // 且从光标到该块末端没有实际文本」。读不到时探针就地把选区折叠到末尾，供下一轮再确认。
  if(kind==='content_caret_state'){
    const el=publishField(String(req.fieldType||'content'));
    if(!el)return {found:false,text:'',newlines:0,atEnd:false};
    const raw=el.innerText||el.textContent||'';
    const value=norm(raw);
    const directBlocks=Array.from(el.children||[]).filter((child)=>/^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(child.tagName||'')).length;
    const brCount=el.querySelectorAll?el.querySelectorAll('br').length:0;
    let newlines=Math.max(Math.max(0,directBlocks-1),brCount);
    if('value' in el)newlines=Math.max(newlines,String(el.value||'').split('\n').length-1);
    const selection=window.getSelection?window.getSelection():null;
    const lastBlock=el.lastElementChild||el;
    let atEnd=false;
    try{
      if('value' in el){
        atEnd=Number(el.selectionStart)===String(el.value||'').length;
      }else if(selection&&selection.rangeCount>0&&selection.isCollapsed&&el.contains(selection.anchorNode)){
        const anchor=selection.anchorNode;
        const inLastBlock=lastBlock===el?el.contains(anchor):(lastBlock===anchor||lastBlock.contains(anchor));
        if(inLastBlock){
          const tail=document.createRange();
          tail.setStart(anchor,selection.anchorOffset);
          tail.setEnd(lastBlock,lastBlock.childNodes.length);
          atEnd=tail.toString().replace(/[\u200B\uFEFF]/g,'')==='';
        }
      }
    }catch{}
    if(!atEnd)cursorToEnd(el);
    return {found:true,text:value,newlines,atEnd};
  }
  return miss();
})
