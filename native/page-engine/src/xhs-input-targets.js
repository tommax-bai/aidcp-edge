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
  // 段落数是**换行的结构证据**：引擎拿它判「裸回车有没有真的把段落拆出来」。
  // 富文本优先按 innerText 数 —— 那是浏览器真实渲染出来的换行（<br> 与块级子节点都算），
  // 与 readEditor 读回的正文是同一份文本，两边口径因此一致。
  // 只按块级子节点数会漏两类现场：段落靠 <br> 分隔（一个块都没有）、首段是裸文本节点
  // （块数比真实段落数少一）—— 两种都会把「N 段」读成「1 段」，让引擎误判成段落丢失。
  const paragraphCount=(el)=>{
    if('value' in el)return String(el.value||'').split('\n').filter((line)=>line.trim().length>0).length;
    const flat=typeof el.innerText==='string'?el.innerText:'';
    if(flat)return flat.split('\n').filter((line)=>line.trim().length>0).length;
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
  // ── 话题候选与话题真 token ─────────────────────────────────────────────────
  // 选择器与判据整套移植自退役实现（`src/flows/publish-command-handlers.ts::runAddTopic`
  // 与 `src/flows/publish-post.ts::committedTopicPill`），那是**实机校准过**的，
  // 不在这里自创。
  const normTopic=(value)=>String(value??'').replace(/^#+/,'').replace(/\s+/g,'').toLowerCase();
  // 建议下拉里的目标项。**只认两种**：文本以关键词开头的真候选，或「新建话题」那一项。
  // 都不成立时 MUST 报没找到、由调用方不点 —— 随便点一个会给稿子贴上一个无关话题，
  // 而那是不可逆的（贴上去之后没有任何一步会去撤）。
  if(kind==='topic_candidate'){
    const wanted=normTopic(req.value);
    if(!wanted)return {found:false};
    const box=first(['.tippy-box[role="tooltip"]']);
    if(!box)return {found:false,dropdown:false};
    const items=all('#creator-editor-topic-container .item,.item',box).filter(visible);
    if(!items.length)return {found:false,dropdown:true};
    const isCreate=(el)=>/新建话题/.test(text(el,200));
    const exact=items.find((el)=>!isCreate(el)&&normTopic(text(el,200)).indexOf(wanted)===0);
    const create=items.find(isCreate);
    const target=exact||create;
    if(!target)return {found:false,dropdown:true};
    return {found:true,dropdown:true,matched:exact?'exact':'create',...geometry(target)};
  }
  // 话题**真的贴上了没有**。判据是正文里生成了真 token（`a.tiptap-topic[data-topic]`），
  // 不是「整段正文里搜得到这几个字」—— 后者读回的正是我们自己刚打进去的那串 `#关键词`，
  // 属自证循环：用输入证明输入生效。纯文本 `#关键词`（打了字但没从候选提交）明确判 false。
  // 比对前先剔除隐藏后缀 `span.content-hide`（「[话题]#」），并做**精确相等**而非子串 ——
  // 子串会把已存在的「#考研数学」误判成「考研」已贴上。
  if(kind==='topic_committed'){
    const wanted=normTopic(req.value);
    if(!wanted)return {found:true,committed:false};
    const editor=publishField('content')||document;
    const pills=all('a.tiptap-topic,a[data-topic]',editor);
    const committed=pills.some((pill)=>{
      // 隐藏后缀按选择器直取，**不能**走 `first()` —— 那一条按可见性过滤，
      // 而这个 span 恰恰是隐藏的，过滤之后永远取不到、后缀也就永远剔不掉。
      const hidden=pill.querySelector?pill.querySelector('.content-hide'):null;
      let raw=pill.textContent||'';
      if(hidden&&hidden.textContent)raw=raw.replace(hidden.textContent,'');
      let name='';
      const attr=pill.getAttribute&&pill.getAttribute('data-topic');
      if(attr){try{name=normTopic(JSON.parse(attr).name);}catch{name='';}}
      return name===wanted||normTopic(raw)===wanted;
    });
    return {found:true,committed,pills:pills.length};
  }
  // 配图预览位的**身份读数**。只回身份、不回判定 —— 判定要「写之前」与「写之后」两次读数
  // 才做得出来，而一次调用只看得见当下这一次。
  //
  // 为什么需要它：上传的判据原本是「那个序号位上有预览图」，而**上一次留下的残留预览同样满足**，
  // 于是一次根本没生效的上传照样回确认。绑定要的是「这一张是这次传上去的」。
  //
  // 身份取图片地址的 **长度 + FNV-1a 摘要**，不回地址本身：调用方只需要判等，
  // 送出原地址既无必要、又把页面内容漏进 IPC。摘要碰撞只会让「新图」被读成「还是旧的」，
  // 方向是悲观的（回未确认），不会假成功。
  // 地址读不到时 **MUST NOT 发明身份**：照实标 `blank`，由调用方按「读不出来」处置 ——
  // 空串之间彼此相等，把它当身份会让两张读不出地址的图互相冒充。
  if(kind==='publish_previews'){
    const fnv=(value)=>{
      let h=0x811c9dc5;
      for(let i=0;i<value.length;i+=1){h^=value.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
      return h.toString(16).padStart(8,'0');
    };
    // 选择器与命令路由里上传 / 设封面那一支**逐字一致**：两处对不上的话，
    // 「第 N 个预览位」在两边指的就不是同一张图，判定会悄悄错位。
    const previews=all('.img-preview-area img,img[id*="creator-preview"],[class*="preview"] img,[class*="upload"] img').filter(visible);
    return {found:true,count:previews.length,items:previews.slice(0,64).map((el,i)=>{
      const src=String((el.getAttribute&&el.getAttribute('src'))||el.src||'');
      return src?{index:i,id:`${src.length.toString(16)}:${fnv(src)}`,blank:false}:{index:i,id:'',blank:true};
    })};
  }
  // 详情浮层的关闭控件。`overlay` 与 `found` 是两件事：浮层不在（无需关）与浮层在但关闭控件
  // 没认出来（关不掉），调用方要分开处置。
  if(kind==='detail_close'){
    const modal=detailRoot();
    if(!modal)return {found:false,overlay:false};
    const close=first(['[class*="close"]','button[aria-label*="关闭"]'],modal);
    return close?{found:true,overlay:true,...geometry(close)}:{found:false,overlay:true};
  }
  // 评论到达确认。**两条独立证据，缺一不可**：
  // ① 结构必要条件 —— 平台在提交成功后会把编辑器清空（退役实现就是靠它，切到原生引擎时丢了）；
  // ② 正文出现在评论区里。
  // 只留 ② 的话，剩下的就是一条宽松子串扫描，而**我们自己刚写进去的那份正文就在页面上**：
  // 富文本编辑器的 textContent 是活的，它但凡落在某个 class 含 comment 的容器里（或某个这样的
  // 容器把它包在内），扫描读到的就是自己写的东西 —— 自证循环，从此恒真。今天挡住它的只是
  // 一个没有任何用例断言过的 DOM 嵌套巧合。故这里主动把「与编辑器有包含关系」的元素剔出扫描面：
  // 编辑器自身与其子树是污染源，编辑器的**祖先**同样会把编辑器的文本一起收进来。
  // 细粒度的评论条目与编辑器互不包含，证据不受影响。
  // 编辑器读不到时 `editorCleared` **缺席**（不写 false）：「读不到」与「读到了、没清空」
  // 是两态，压成一态就等于替调用方判了「没发出去」。
  if(kind==='comment_ack'){
    const wanted=norm(req.text||'',500);
    const root=detailRoot()||document;
    const editor=commentEditor();
    const contaminated=(el)=>Boolean(editor)&&(el.contains(editor)||editor.contains(el));
    const appeared=Boolean(wanted)&&all('[class*="comment"]',root)
      .filter((el)=>!contaminated(el))
      .some((el)=>text(el,32000).includes(wanted));
    if(!editor)return {found:true,appeared};
    return {found:true,appeared,editorCleared:norm(readEditor(editor),32000)===''};
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
