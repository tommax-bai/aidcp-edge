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
