  const feedLikeOperationAttribute='data-aidcp-native-feed-like';
  const directCardControl=(card,control)=>Boolean(card&&control&&card.contains(control)&&closestArticle(control)===card);
  const insideReactionSummary=(card,control)=>{
    const toolbar=control&&control.closest&&control.closest('[role="toolbar"]');
    return Boolean(toolbar&&card.contains(toolbar));
  };
  const feedLikeCommentControls=(card)=>all('[role="button"][aria-label],button[aria-label]',card)
    .filter((control)=>directCardControl(card,control)&&visible(control)&&!insideReactionSummary(card,control))
    .filter((control)=>postComment.test(label(control))||postComment.test(text(control,256)));
  const sharesPostCommentBar=(card,control)=>{
    if(!card||!control||insideReactionSummary(card,control))return false;
    for(let parent=control.parentElement,depth=0;parent&&depth<6;parent=parent.parentElement,depth++){
      if(!card.contains(parent))return false;
      if(parent===card)break;
      const comments=feedLikeCommentControls(card).filter((candidate)=>parent.contains(candidate));
      if(comments.length===1)return true;
    }
    return false;
  };
  const feedLikeReactionState=(card,control)=>{
    if(!directCardControl(card,control)||!visible(control)||insideReactionSummary(card,control))return '';
    const rawLabel=label(control);
    const rawText=text(control,256);
    const numeric=/\d/.test(rawText);
    const selected=control.getAttribute('aria-pressed')==='true'||control.getAttribute('aria-checked')==='true';
    let state='';
    if(unlike.test(rawLabel)||unlike.test(rawText))state='reacted';
    else if(neutralLike.test(rawLabel)||neutralLike.test(rawText)){
      state=selected||(reactionPickerLabel.test(rawLabel)&&!numeric&&reactedWord.test(rawText))?'reacted':'neutral';
    }else if(!numeric&&reactedWord.test(rawLabel))state='reacted';
    return state&&sharesPostCommentBar(card,control)?state:'';
  };
  const feedLikeReactionControls=(card)=>all('[role="button"][aria-label],[role="radio"][aria-label],button[aria-label]',card)
    .map((control)=>({control,state:feedLikeReactionState(card,control)}))
    .filter((candidate)=>Boolean(candidate.state));
  const exactArticles=(expected)=>{
    const expectedId=postId(expected)||String(expected||'');
    if(!expectedId)return [];
    return topArticles().filter((article)=>{
      const href=permalinkOf(article);
      return href&&(href===expected||postId(href)===expectedId);
    });
  };
  const feedLikeTarget=()=>{
    const expected=String(p.noteId||'');
    const matches=exactArticles(expected);
    if(matches.length!==1)return {ok:false,reason:matches.length?'ambiguous_target':'target_not_found'};
    const root=matches[0];
    const controls=feedLikeReactionControls(root);
    if(controls.length!==1)return {
      ok:false,
      reason:controls.length?'ambiguous_target':'like_button_not_found',
      noteId:permalinkOf(root)||expected,
    };
    const selected=controls[0];
    const rect=selected.control.getBoundingClientRect();
    const viewportWidth=Number(window.innerWidth)||0;
    const viewportHeight=Number(window.innerHeight)||0;
    const inViewport=rect.left>=0&&rect.top>=0&&rect.right<=viewportWidth&&rect.bottom<=viewportHeight;
    return {
      ok:true,
      root,
      control:selected.control,
      state:selected.state,
      noteId:permalinkOf(root)||expected,
      cx:rect.left+rect.width/2,
      cy:rect.top+rect.height/2,
      top:rect.top,
      bottom:rect.bottom,
      viewportHeight,
      inViewport,
      observation:actionEvidence(root),
    };
  };
  const feedLikeTargetValue=(target)=>({
    ok:Boolean(target&&target.ok),
    ...(target&&target.reason?{reason:target.reason}:{}),
    ...(target&&target.noteId?{noteId:target.noteId}:{}),
    ...(target&&target.state?{state:target.state}:{}),
    ...(target&&Number.isFinite(target.cx)?{cx:target.cx}:{}),
    ...(target&&Number.isFinite(target.cy)?{cy:target.cy}:{}),
    ...(target&&Number.isFinite(target.top)?{top:target.top}:{}),
    ...(target&&Number.isFinite(target.bottom)?{bottom:target.bottom}:{}),
    ...(target&&Number.isFinite(target.viewportHeight)?{viewportHeight:target.viewportHeight}:{}),
    inViewport:Boolean(target&&target.inViewport),
    ...(target&&target.observation?{observation:target.observation}:{}),
  });
  const feedLikeOperationRoot=(operationId)=>{
    const matches=all(`[${feedLikeOperationAttribute}]`).filter((node)=>
      node.getAttribute(feedLikeOperationAttribute)===String(operationId||'')
    );
    return matches.length===1?matches[0]:null;
  };
  const feedLikeVerify=()=>{
    const operationId=String(p.operationId||'');
    const operation=window.__aidcpNativeFeedLikeOperation;
    if(!operationId||!operation||operation.operationId!==operationId)return {state:'target_lost'};
    const root=feedLikeOperationRoot(operationId);
    if(!root)return {state:'target_lost'};
    const expected=String(p.noteId||operation.noteId||'');
    if(postId(permalinkOf(root))!==postId(expected))return {state:'identity_mismatch'};
    const controls=feedLikeReactionControls(root);
    if(controls.length!==1)return {state:'control_missing'};
    const freshPicker=Array.isArray(operation.pickerContainersBefore)
      &&feedLikePickerContainers().some((container)=>!operation.pickerContainersBefore.includes(container));
    return {
      state:controls[0].state==='reacted'?'confirmed':freshPicker?'picker_open':'pending',
      noteId:permalinkOf(root)||expected,
      observation:actionEvidence(root),
    };
  };
  const feedLikePickerContainers=()=>all('[role="dialog"],[role="menu"],[role="listbox"],[aria-label*="Reaction"],[aria-label*="反应"],[aria-label*="心情"]')
    .filter(visible);
  const feedLikeCommit=()=>{
    const operationId=String(p.operationId||'');
    if(!operationId)return {started:false,already:false,reason:'operation_id_missing'};
    for(const stale of all(`[${feedLikeOperationAttribute}]`))stale.removeAttribute(feedLikeOperationAttribute);
    delete window.__aidcpNativeFeedLikeOperation;
    const pickerContainersBefore=feedLikePickerContainers();
    const blocked=blocker(blockingProbe());
    if(blocked)return {started:false,already:false,reason:blocked};
    if(consentProbe().present)return {started:false,already:false,reason:'blocked_by_consent'};
    const target=feedLikeTarget();
    if(!target.ok)return {
      started:false,
      already:false,
      reason:target.reason,
      ...(target.noteId?{noteId:target.noteId}:{}),
    };
    if(target.state==='reacted')return {
      started:false,
      already:true,
      noteId:target.noteId,
      observation:target.observation,
    };
    if(!target.inViewport)return {
      started:false,
      already:false,
      reason:'target_not_visible',
      noteId:target.noteId,
      observation:target.observation,
    };
    target.root.setAttribute(feedLikeOperationAttribute,operationId);
    window.__aidcpNativeFeedLikeOperation={
      operationId,
      noteId:String(p.noteId||''),
      pickerContainersBefore,
    };
    try{
      target.control.click();
    }catch{
      target.root.removeAttribute(feedLikeOperationAttribute);
      delete window.__aidcpNativeFeedLikeOperation;
      return {started:false,already:false,reason:'like_dispatch_failed',noteId:target.noteId,observation:target.observation};
    }
    return {started:true,already:false,noteId:target.noteId,observation:target.observation};
  };
  const feedLikePickerProbe=()=>{
    const operationId=String(p.operationId||'');
    const root=feedLikeOperationRoot(operationId);
    const operation=window.__aidcpNativeFeedLikeOperation;
    if(!root||!operation||operation.operationId!==operationId)return {ok:false,reason:'operation_not_found'};
    const blocked=blocker(blockingProbe());
    if(blocked)return {ok:false,reason:blocked};
    if(consentProbe().present)return {ok:false,reason:'blocked_by_consent'};
    const expected=String(p.noteId||operation.noteId||'');
    if(postId(permalinkOf(root))!==postId(expected))return {ok:false,reason:'operation_not_found'};
    const controls=feedLikeReactionControls(root);
    if(controls.length!==1)return {ok:false,reason:'like_button_not_found'};
    if(controls[0].state==='reacted')return {ok:false,reason:'already_reacted'};
    const primary=controls[0].control.getBoundingClientRect();
    const reactionish=/(赞|讚|Like|大爱|Love|哈哈|Haha|哇|Wow|加油|Care|怒|Angry|悲伤|Sad|Me gusta|Thích)/i;
    const likeOnly=/^(赞|讚|Like|Me gusta|Thích)$/i;
    const containers=feedLikePickerContainers()
      .filter((container)=>!operation.pickerContainersBefore.includes(container))
      .map((container)=>{
        const items=all('[role="menuitemradio"][aria-label],[role="menuitem"][aria-label],[role="option"][aria-label],[role="button"][aria-label],button[aria-label]',container)
          .filter(visible)
          .filter((item)=>reactionish.test(label(item)));
        const likes=items.filter((item)=>likeOnly.test(label(item)));
        return {items,likes};
      })
      .filter((candidate)=>candidate.items.length>=2&&candidate.likes.length===1);
    if(containers.length!==1)return {ok:false,reason:containers.length?'ambiguous_target':'like_picker_not_found'};
    const rect=containers[0].likes[0].getBoundingClientRect();
    const cx=rect.left+rect.width/2;
    const cy=rect.top+rect.height/2;
    const viewportWidth=Number(window.innerWidth)||0;
    const viewportHeight=Number(window.innerHeight)||0;
    if(cx<0||cy<0||cx>viewportWidth||cy>viewportHeight)return {ok:false,reason:'like_picker_offscreen'};
    return {
      ok:true,
      cx,
      cy,
      fromX:primary.left+primary.width/2,
      fromY:primary.top+primary.height/2,
    };
  };
  const feedLikeClear=()=>{
    const operationId=String(p.operationId||'');
    for(const root of all(`[${feedLikeOperationAttribute}]`)){
      if(root.getAttribute(feedLikeOperationAttribute)===operationId)root.removeAttribute(feedLikeOperationAttribute);
    }
    if(window.__aidcpNativeFeedLikeOperation&&window.__aidcpNativeFeedLikeOperation.operationId===operationId){
      delete window.__aidcpNativeFeedLikeOperation;
    }
    return {cleared:true};
  };
