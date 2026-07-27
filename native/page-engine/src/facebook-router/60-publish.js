  const publishEntryLabel=/(what('|’)s on your mind|create post|create a post|write something|写点什么|在想什么|创建帖子|分享你的新鲜事|bạn đang nghĩ gì|crear publicación|crear una publicación|post something)/i;
  const publishEditorLabel=/(what('|’)s on your mind|create a public post|write something|写点什么|在想什么|bạn đang nghĩ gì|qué estás pensando|publicación)/i;
  const publishSubmitLabel=/^(post|发布|發佈|发帖|đăng|publicar|compartir)$/i;
  const publishSubmittedLabel=/(your post is being processed|your post has been shared|post shared|已发布|发布中|發佈中|đã đăng|publicación compartida)/i;
  const publishControlNoise=/(comment|评论|reply|回复)/i;
  const publishEntryActionable='button,[role="button"],a[role="link"]';
  const publishVisible=(el)=>{
    if(!visible(el))return false;
    const rect=el.getBoundingClientRect();
    return rect.right>0&&rect.bottom>0&&rect.left<(window.innerWidth||0)&&rect.top<(window.innerHeight||0);
  };
  const publishLabel=(el)=>norm(el&&el.getAttribute&&(
    el.getAttribute('aria-label')
    ||el.getAttribute('data-placeholder')
    ||el.getAttribute('placeholder')
    ||el.getAttribute('title')
  ),512);
  const publishDialogs=()=>all('[role="dialog"],[aria-modal="true"]',document).filter(publishVisible);
  const publishDialog=()=>publishDialogs()[0]||null;
  const publishEditorCandidates=(root)=>{
    if(!root)return [];
    const editors=all('[contenteditable="true"][role="textbox"],[contenteditable="true"],textarea',root).filter(publishVisible);
    const localized=editors.filter((editor)=>{
      const source=`${publishLabel(editor)} ${text(editor,512)}`;
      return publishEditorLabel.test(source)&&!publishControlNoise.test(source);
    });
    return localized.length?localized:editors;
  };
  const publishHomeProbe=()=>{
    const dialogs=publishDialogs();
    const editorCandidates=publishEditorCandidates(dialogs[0]||null);
    const editor=editorCandidates.length===1?editorCandidates[0]:null;
    return {
      href:String(location.href||''),
      readyState:String(document.readyState||''),
      mainVisible:all('main,[role="main"]',document).some(publishVisible),
      editorReady:Boolean(editor),
      blockingDialog:dialogs.some((dialog)=>!editor||!dialog.contains(editor)),
      credentialInput:all('input[type="password"],input[type="email"]',document).some(publishVisible),
    };
  };
  const publishEntryProbe=()=>{
    const nodes=all('[role="region"][aria-label],button,[role="button"],div[aria-label],span[aria-label],a[role="link"]',document).filter(publishVisible);
    const seen=new Set();
    const candidates=[];
    const addCandidate=(target)=>{
      if(!target||!publishVisible(target)||seen.has(target))return;
      if(target.closest&&target.closest('[role="menu"]'))return;
      if(publishControlNoise.test(`${publishLabel(target)} ${text(target,512)}`))return;
      seen.add(target);
      candidates.push(target);
    };
    for(const element of nodes){
      if(element.closest&&element.closest('[role="menu"]'))continue;
      const accessible=publishLabel(element);
      const rendered=text(element,512);
      const source=`${accessible} ${rendered}`;
      if(!publishEntryLabel.test(source)||publishControlNoise.test(source))continue;
      const target=element.matches&&element.matches(publishEntryActionable)
        ?element
        :(element.closest&&element.closest(publishEntryActionable));
      if(target){
        addCandidate(target);
        continue;
      }
      for(const descendant of all(publishEntryActionable,element)){
        const descendantSource=`${publishLabel(descendant)} ${text(descendant,512)}`;
        if(publishEntryLabel.test(descendantSource)&&!publishControlNoise.test(descendantSource)){
          addCandidate(descendant);
        }
      }
    }
    if(!candidates.length)return {ok:false,reason:'composer_entry_not_found'};
    if(candidates.length!==1)return {ok:false,reason:'ambiguous_target'};
    const target=point(candidates[0]);
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'composer_entry_not_found'};
  };
  const publishEditorProbe=()=>{
    const root=publishDialog();
    if(!root)return {ok:false,reason:'composer_not_open'};
    const candidates=publishEditorCandidates(root);
    if(candidates.length!==1)return {ok:false,reason:candidates.length?'ambiguous_target':'composer_editor_not_found'};
    const editor=candidates[0];
    const target=point(editor);
    const value='value' in editor?String(editor.value||''):norm(editor.innerText||editor.textContent||'',32000);
    if(!p.focus)return {ok:Boolean(target),...(target||{}),reason:target?undefined:'composer_editor_not_found',value};
    editor.scrollIntoView&&editor.scrollIntoView({block:'center',inline:'center'});
    try{editor.focus();editor.click&&editor.click();editor.focus();}catch{}
    const focused=document.activeElement===editor;
    let selected=false;
    if(focused&&p.selectContents){
      try{
        if(typeof editor.select==='function'){editor.select();selected=true;}
        else{
          const range=document.createRange();range.selectNodeContents(editor);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);selected=true;
        }
      }catch{}
    }
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'composer_editor_not_found',value,focused,selected};
  };
  const publishSubmitProbe=()=>{
    const root=publishDialog();
    if(!root)return {ok:false,reason:'composer_not_open',composerOpen:false};
    const seen=new Set();
    const candidates=[];
    for(const element of all('button,[role="button"],div[aria-label],span[aria-label]',root).filter(publishVisible)){
      if(!publishSubmitLabel.test(publishLabel(element)||text(element,128)))continue;
      const target=element.matches&&element.matches('button,[role="button"]')
        ?element
        :(element.closest&&element.closest('button,[role="button"]'))||element;
      if(!publishVisible(target)||seen.has(target))continue;
      seen.add(target);
      candidates.push(target);
    }
    if(candidates.length!==1)return {ok:false,reason:candidates.length?'ambiguous_target':'submit_not_found',composerOpen:true};
    const button=candidates[0];
    const target=point(button);
    const disabled=Boolean(
      button.disabled
      ||button.getAttribute('aria-disabled')==='true'
      ||button.getAttribute('disabled')!==null
      ||/disabled/i.test(String(button.className||''))
    );
    return {ok:Boolean(target)&&!disabled,...(target||{}),reason:disabled?'submit_disabled':target?undefined:'submit_not_found',composerOpen:true,disabled};
  };
  const publishSubmittedProbe=()=>{
    const composer=publishDialog();
    if(!composer)return {confirmed:true,witness:'composer_closed'};
    const submitted=publishSubmittedLabel.test(text(document.body,16000));
    return {confirmed:submitted,...(submitted?{witness:'submitted_state'}:{})};
  };
