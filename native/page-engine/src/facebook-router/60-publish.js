  const publishEntryLabel=/(what('|’)s on your mind|create post|create a post|write something|写点什么|在想什么|创建帖子|分享你的新鲜事|bạn đang nghĩ gì|crear publicación|crear una publicación|post something)/i;
  const publishEditorLabel=/(what('|’)s on your mind|create a public post|write something|写点什么|在想什么|bạn đang nghĩ gì|qué estás pensando|publicación)/i;
  const publishSubmitLabel=/^(post|发布|發佈|发帖|đăng|publicar|compartir)$/i;
  const publishSubmittedLabel=/(your post is being processed|your post has been shared|post shared|已发布|发布中|發佈中|đã đăng|publicación compartida)/i;
  const publishControlNoise=/(comment|评论|reply|回复)/i;
  const publishEntryActionable='button,[role="button"],a[role="link"]';
  const publishDialogSelector='[role="dialog"],[aria-modal="true"]';
  const publishEditorBindingAttribute='data-aidcp-publish-editor';
  const publishFileBindingAttribute='data-aidcp-publish-file-input';
  const publishSubmitBindingAttribute='data-aidcp-publish-submit';
  const publishSubmitInFlightAttribute='data-aidcp-publish-submit-in-flight';
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
  const publishDialogs=()=>all(publishDialogSelector,document)
    .filter(publishVisible)
    .filter((dialog)=>!(dialog.parentElement&&dialog.parentElement.closest(publishDialogSelector)));
  const publishEditorCandidates=(root)=>{
    if(!root)return [];
    const editors=all('[contenteditable="true"][role="textbox"],[contenteditable="true"],textarea',root)
      .filter(publishVisible)
      .filter((editor)=>editor.closest&&editor.closest(publishDialogSelector)===root);
    const localized=editors.filter((editor)=>{
      const source=`${publishLabel(editor)} ${text(editor,512)}`;
      return publishEditorLabel.test(source)&&!publishControlNoise.test(source);
    });
    return localized.length?localized:editors;
  };
  const publishRectsOverlap=(left,right)=>{
    const a=left.getBoundingClientRect();
    const b=right.getBoundingClientRect();
    return Math.min(a.right,b.right)>Math.max(a.left,b.left)
      &&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top);
  };
  const publishComposerResolution=()=>{
    const candidates=publishDialogs()
      .map((root)=>({root,editors:publishEditorCandidates(root)}))
      .filter((candidate)=>candidate.editors.length===1)
      .map((candidate)=>({root:candidate.root,editor:candidate.editors[0]}));
    if(!candidates.length)return {ok:false,reason:'composer_not_open'};
    if(candidates.length===1)return {ok:true,...candidates[0]};
    const foreground=candidates[candidates.length-1];
    if(candidates.some((candidate)=>candidate!==foreground&&!publishRectsOverlap(candidate.root,foreground.root))){
      return {ok:false,reason:'ambiguous_target'};
    }
    if(typeof document.elementsFromPoint==='function'){
      const target=point(foreground.editor);
      const stack=target?document.elementsFromPoint(target.cx,target.cy):[];
      const topRoot=stack
        .map((element)=>element.closest&&element.closest(publishDialogSelector))
        .find((root)=>candidates.some((candidate)=>candidate.root===root));
      if(topRoot&&topRoot!==foreground.root)return {ok:false,reason:'ambiguous_target'};
    }
    return {ok:true,...foreground};
  };
  const publishDialog=()=>{
    const resolution=publishComposerResolution();
    return resolution.ok?resolution.root:null;
  };
  const publishUnbind=(attribute)=>{
    for(const element of all(`[${attribute}]`,document))element.removeAttribute(attribute);
  };
  const publishEditorValue=(editor)=>'value' in editor
    ?String(editor.value||'')
    :norm(editor.innerText||editor.textContent||'',32000);
  const publishHomeProbe=()=>{
    const dialogs=publishDialogs();
    const composer=publishComposerResolution();
    const editor=composer.ok?composer.editor:null;
    return {
      href:String(location.href||''),
      readyState:String(document.readyState||''),
      mainVisible:all('main,[role="main"]',document).some(publishVisible),
      editorReady:Boolean(editor),
      blockingDialog:dialogs.some((dialog)=>publishEditorCandidates(dialog).length===0),
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
    const composer=publishComposerResolution();
    if(!composer.ok)return {ok:false,reason:composer.reason};
    const editor=composer.editor;
    const target=point(editor);
    const value=publishEditorValue(editor);
    if(!p.focus)return {ok:Boolean(target),...(target||{}),reason:target?undefined:'composer_editor_not_found',value};
    publishUnbind(publishEditorBindingAttribute);
    editor.setAttribute(publishEditorBindingAttribute,'current');
    editor.scrollIntoView&&editor.scrollIntoView({block:'center',inline:'center'});
    try{editor.focus();editor.click&&editor.click();editor.focus();}catch{}
    const focused=document.activeElement===editor
      &&editor.getAttribute(publishEditorBindingAttribute)==='current';
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
  const publishBoundEditorProbe=()=>{
    const bound=all(`[${publishEditorBindingAttribute}="current"]`,document);
    if(bound.length!==1)return {ok:false,reason:bound.length?'ambiguous_target':'composer_target_lost',focused:false};
    const composer=publishComposerResolution();
    const editor=bound[0];
    if(!composer.ok||composer.editor!==editor)return {ok:false,reason:'composer_target_lost',focused:false};
    const target=point(editor);
    if(!target)return {ok:false,reason:'composer_editor_not_found',focused:false};
    if(p.focus){
      editor.scrollIntoView&&editor.scrollIntoView({block:'center',inline:'center'});
      try{editor.focus();editor.click&&editor.click();editor.focus();}catch{}
    }
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
    return {ok:true,...target,value:publishEditorValue(editor),focused,selected};
  };
  const publishUploadTargetProbe=()=>{
    const composer=publishComposerResolution();
    if(!composer.ok)return {ok:false,reason:composer.reason};
    const owned=all('input[type="file"]',composer.root)
      .filter((input)=>input.closest&&input.closest(publishDialogSelector)===composer.root);
    const imageInputs=owned.filter((input)=>/image/i.test(String(input.getAttribute('accept')||'')));
    const candidates=imageInputs.length?imageInputs:owned;
    if(candidates.length!==1)return {ok:false,reason:candidates.length?'ambiguous_target':'upload_input_not_found'};
    publishUnbind(publishFileBindingAttribute);
    candidates[0].setAttribute(publishFileBindingAttribute,'current');
    return {ok:true};
  };
  const publishUploadPreviewProbe=()=>{
    const composer=publishComposerResolution();
    if(!composer.ok)return {ok:false,reason:composer.reason};
    const expected=String(p.fileName||'');
    if(!expected)return {ok:false,reason:'media_preview_unconfirmed'};
    const previews=all('img',composer.root).filter(publishVisible).filter((image)=>{
      const src=String(image.getAttribute('src')||image.src||'');
      const alt=String(image.getAttribute('alt')||'');
      return src.startsWith('blob:')&&alt===expected;
    });
    return previews.length===1
      ?{ok:true}
      :{ok:false,reason:previews.length?'ambiguous_target':'media_preview_unconfirmed'};
  };
  const publishSubmitProbe=()=>{
    const composer=publishComposerResolution();
    if(!composer.ok)return {ok:false,reason:composer.reason,composerOpen:false};
    const root=composer.root;
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
    if(target&&!disabled&&p.bindTarget){
      publishUnbind(publishSubmitBindingAttribute);
      root.setAttribute(publishSubmitBindingAttribute,'current');
      document.body&&document.body.setAttribute(publishSubmitInFlightAttribute,'current');
    }
    return {ok:Boolean(target)&&!disabled,...(target||{}),reason:disabled?'submit_disabled':target?undefined:'submit_not_found',composerOpen:true,disabled};
  };
  const publishSubmittedProbe=()=>{
    const submitted=publishSubmittedLabel.test(text(document.body,16000));
    if(submitted){
      document.body&&document.body.removeAttribute(publishSubmitInFlightAttribute);
      return {confirmed:true,witness:'submitted_state'};
    }
    const inFlight=document.body&&document.body.getAttribute(publishSubmitInFlightAttribute)==='current';
    if(!inFlight){
      const composer=publishComposerResolution();
      return {confirmed:!composer.ok,...(!composer.ok?{witness:'composer_closed'}:{})};
    }
    const bound=all(`[${publishSubmitBindingAttribute}="current"]`,document);
    if(bound.length===0){
      document.body&&document.body.removeAttribute(publishSubmitInFlightAttribute);
      return {confirmed:true,witness:'composer_closed'};
    }
    if(bound.length>1)return {confirmed:false};
    if(!publishVisible(bound[0])){
      document.body&&document.body.removeAttribute(publishSubmitInFlightAttribute);
      return {confirmed:true,witness:'composer_closed'};
    }
    return {confirmed:false};
  };
