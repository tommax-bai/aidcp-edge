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
