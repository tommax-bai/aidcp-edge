  const reelLikeExcluded=/(share|chia sẻ|chia se|分享|reply|trả lời|tra loi|回复|回覆|menu|更多|next|previous|下一|上一|pause|play|播放|暂停)/i;
  const reelReactionState=(button)=>{
    const accessible=label(button);
    const rendered=text(button,256);
    if(/^\s*赞\s*$/.test(accessible)){
      if(unlike.test(rendered)||button.getAttribute('aria-pressed')==='true'||button.getAttribute('aria-checked')==='true'){
        return 'reacted';
      }
      return /\d/.test(rendered)?'neutral':'';
    }
    return reactionState(button);
  };
  const actionEvidence=(root)=>{
    const author=articleAuthor(root);
    const body=articleBody(root);
    const reaction=reactionButton(root);
    return {
      surface:root.closest('[role="dialog"]')?'detail':'feed',
      listKey:permalinkOf(root)||undefined,
      author:author.name||undefined,
      textPreviewHead:body.slice(0,500)||undefined,
      reactionText:norm(text(reaction,96)||label(reaction,96),128)||undefined,
      articleIndex:Math.max(0,topArticles().indexOf(root)),
    };
  };
  const actionRoot=()=>{
    const expected=String(p.noteId||'');
    if(isFirstPostTarget(expected))return boundFirstPostRoot(expected);
    if(expected&&reelSurface()){
      const active=activeReel();
      if(active.ok&&postId(active.noteId)===postId(expected))return active.root;
      return null;
    }
    if(expected)return exactArticle(expected);
    return first(['[role="dialog"] [role="article"]','main [role="article"]','main article'])||null;
  };
  const expectedActiveReel=()=>{
    const expected=String(p.noteId||'');
    const active=activeReel();
    if(!active.ok)return {ok:false,reason:active.reason==='ambiguous_target'?'ambiguous_target':'target_not_found'};
    if(!expected||postId(active.noteId)!==postId(expected))return {ok:false,reason:'target_not_found',noteId:active.noteId};
    return active;
  };
  const reelAssociated=(active,element)=>{
    if(!active||!element||!visible(element))return false;
    const target=element.getBoundingClientRect();
    const viewportWidth=window.innerWidth||0;
    const viewportHeight=window.innerHeight||0;
    if(target.bottom<=0||target.top>=viewportHeight||target.right<=0||target.left>=viewportWidth)return false;
    const video=active.videoRect;
    if(target.top<video.top-60||target.bottom>video.bottom+60||target.left<video.left-180||target.right>video.right+240)return false;
    const distance=rectDistance(target,video);
    if(distance>280)return false;
    const otherDistances=all('video').filter((candidate)=>candidate!==active.video).map((candidate)=>candidate.getBoundingClientRect())
      .filter((rect)=>viewportArea(rect)>0).map((rect)=>rectDistance(target,rect));
    return !otherDistances.some((other)=>other+12<distance);
  };
  const reelLikeAssociated=(active,element)=>{
    if(!reelAssociated(active,element))return false;
    const target=element.getBoundingClientRect();
    const video=active.videoRect;
    if(target.width<32||target.width>84||target.height<32||target.height>90)return false;
    if(target.left<video.right-20||target.left>video.right+125)return false;
    if(target.top<video.top-10||target.bottom>video.bottom+20)return false;
    const source=`${label(element)} ${text(element,256)}`;
    if(postComment.test(source)||reelLikeExcluded.test(source))return false;
    let context='';
    for(let parent=element.parentElement,depth=0;parent&&depth<4;parent=parent.parentElement,depth++){
      context+=` ${String(parent.getAttribute&&parent.getAttribute('aria-label')||'')}`;
    }
    return !postComment.test(context)&&!reelLikeExcluded.test(context);
  };
  const reelReactionPickerItem=(element)=>{
    if(element.closest('[role="menu"],[role="listbox"]'))return true;
    const dialog=element.closest('[role="dialog"]');
    if(!dialog)return false;
    const items=all('[role="menuitemradio"],[role="menuitem"],[role="option"],button,[role="button"]',dialog)
      .filter(visible).filter((item)=>pickerReaction.test(label(item)));
    return items.length>=2;
  };
  const reelLikeTarget=()=>{
    const active=expectedActiveReel();
    if(!active.ok)return active;
    const matches=all('button,[role="button"],[role="radio"]').filter((button)=>
      !reelReactionPickerItem(button)&&reelLikeAssociated(active,button)&&Boolean(reelReactionState(button))
    );
    if(matches.length!==1)return {
      ok:false,
      reason:matches.length?'ambiguous_target':'like_button_not_found',
      noteId:active.noteId,
    };
    const button=matches[0];
    return {
      ok:true,
      active,
      button,
      state:reelReactionState(button),
      noteId:active.noteId,
      observation:{
        ...actionEvidence(active.root),
        listKey:active.noteId,
        reactionText:norm(text(button,96)||label(button,96),128)||undefined,
      },
    };
  };
  const likeProbe=()=>{
    if(String(p.noteId||'')&&reelSurface()){
      const target=reelLikeTarget();
      if(!target.ok)return {ok:false,reason:target.reason,noteId:target.noteId};
      const coordinates=point(target.button);
      return {
        ok:Boolean(coordinates),
        ...(coordinates||{}),
        reason:coordinates?undefined:'like_button_not_found',
        noteId:target.noteId,
        already:target.state==='reacted',
        observation:target.observation,
      };
    }
    const root=actionRoot();
    if(!root)return {ok:false,reason:'target_not_found'};
    const button=reactionButton(root);
    if(!button)return {ok:false,reason:'like_button_not_found',noteId:permalinkOf(root)||String(p.noteId||'')};
    const target=point(button);
    return {
      ok:Boolean(target),
      ...(target||{}),
      reason:target?undefined:'like_button_not_found',
      noteId:permalinkOf(root)||String(p.noteId||''),
      already:pressed(button)||/取消赞|remove like|unlike/i.test(label(button)),
      observation:actionEvidence(root),
    };
  };
  const likePrimaryCommit=()=>{
    const target=reelLikeTarget();
    if(!target.ok)return {ok:false,reason:target.reason,noteId:target.noteId,clicked:false};
    if(target.state==='reacted')return {
      ok:true,
      noteId:target.noteId,
      already:true,
      clicked:false,
      observation:target.observation,
    };
    try{
      target.button.click();
      return {
        ok:true,
        noteId:target.noteId,
        already:false,
        clicked:true,
        observation:target.observation,
      };
    }catch{
      return {
        ok:false,
        reason:'like_dispatch_failed',
        noteId:target.noteId,
        already:false,
        clicked:false,
        observation:target.observation,
      };
    }
  };
  const likeVerify=()=>{
    const target=reelLikeTarget();
    if(!target.ok)return {ok:false,reason:target.reason,noteId:target.noteId,selected:false};
    const witness=explicitReactionWitness(target.button);
    return {ok:true,noteId:target.noteId,selected:Boolean(witness),...(witness?{witness}:{})};
  };
  const likePickerProbe=()=>{
    if(String(p.noteId||'')&&reelSurface()){
      const primary=reelLikeTarget();
      if(!primary.ok)return {
        ok:false,
        reason:primary.reason==='ambiguous_target'?'ambiguous_target':'like_primary_target_lost',
      };
      const primaryRect=primary.button.getBoundingClientRect();
      const pickers=all('[role="menu"],[role="listbox"],[role="dialog"]').filter(visible).map((container)=>{
        const items=all('[role="menuitemradio"],[role="menuitem"],[role="option"],button,[role="button"]',container)
          .filter(visible).filter((item)=>pickerReaction.test(label(item)));
        const likes=items.filter((item)=>pickerLike.test(label(item)));
        return {container,items,likes};
      }).filter((candidate)=>
        candidate.items.length>=2
        && candidate.likes.length===1
        && rectDistance(candidate.container.getBoundingClientRect(),primaryRect)<=320
      );
      if(pickers.length!==1)return {ok:false,reason:pickers.length?'ambiguous_target':'like_picker_not_found'};
      const target=point(pickers[0].likes[0]);
      if(!target)return {ok:false,reason:'like_picker_not_found'};
      const viewportWidth=window.innerWidth||0;
      const viewportHeight=window.innerHeight||0;
      if(target.cx<0||target.cy<0||target.cx>viewportWidth||target.cy>viewportHeight){
        return {ok:false,reason:'like_picker_offscreen'};
      }
      return {ok:true,...target};
    }
    const candidates=all('[role="menuitemradio"],[role="menuitem"],[role="option"],button,[role="button"]').filter(visible)
      .filter((el)=>pickerLike.test(label(el)))
      .filter((el)=>Boolean(el.closest('[role="menu"],[role="listbox"],[role="dialog"]'))||!el.closest('[role="article"],article'));
    if(candidates.length!==1)return {ok:false,reason:candidates.length?'ambiguous_target':'like_picker_not_found'};
    const target=point(candidates[0]);
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'like_picker_not_found'};
  };
  const followControl=(element)=>{
    const rendered=text(element,256);
    const accessible=label(element);
    const source=accessible||rendered;
    const match=source.match(/^(ne plus suivre|suivi(?:\(e\))?|suivre|following|follow|已关注|關注中|关注|關注|đang theo dõi|theo dõi|dang theo doi|theo doi)\s*(.*)$/i);
    if(!match)return null;
    const token=match[1].toLowerCase();
    const state=/^(ne plus suivre|suivi(?:\(e\))?|following|已关注|關注中|đang theo dõi|dang theo doi)$/i.test(token)?'following':'follow';
    return {element,state,author:norm(match[2],200),accessible,rendered};
  };
  const exactVisibleText=(value)=>all('a,span,div').filter((element)=>{
    if(!visible(element)||text(element,200)!==value)return false;
    return !Array.from(element.children||[]).some((child)=>text(child,200)===value);
  });
  const reelFollowTarget=()=>{
    const active=expectedActiveReel();
    if(!active.ok)return active;
    const candidates=all('button,[role="button"]').filter((element)=>reelAssociated(active,element))
      .map(followControl).filter(Boolean).filter((candidate)=>{
        if(!candidate.author)return false;
        const targetRect=candidate.element.getBoundingClientRect();
        return exactVisibleText(candidate.author).filter((author)=>
          rectDistance(author.getBoundingClientRect(),targetRect)<=260
        ).length===1;
      });
    if(candidates.length!==1)return {
      ok:false,
      reason:candidates.length?'ambiguous_target':'follow_button_not_found',
      noteId:active.noteId,
    };
    return {ok:true,active,candidate:candidates[0],noteId:active.noteId};
  };
  const followProbe=()=>{
    if(String(p.noteId||'')&&reelSurface()){
      const target=reelFollowTarget();
      if(!target.ok)return {ok:false,reason:target.reason,noteId:target.noteId};
      if(target.candidate.state==='following')return {
        ok:true,
        already:true,
        noteId:target.noteId,
        author:target.candidate.author,
      };
      const coordinates=point(target.candidate.element);
      return {
        ok:Boolean(coordinates),
        ...(coordinates||{}),
        reason:coordinates?undefined:'follow_button_not_found',
        already:false,
        noteId:target.noteId,
        author:target.candidate.author,
      };
    }
    const root=actionRoot();
    if(!root)return {ok:false,reason:'target_not_found'};
    const buttons=all('button,[role="button"]',root).filter(visible);
    const follows=buttons.filter((el)=>/^(关注|follow|theo dõi)$/i.test(label(el)));
    const already=buttons.some((el)=>/已关注|following|đang theo dõi/i.test(label(el)));
    if(already)return {ok:true,already:true,noteId:String(p.noteId||'')};
    if(follows.length!==1)return {ok:false,reason:follows.length?'ambiguous_target':'follow_button_not_found'};
    const target=point(follows[0]);
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'follow_button_not_found',already:false,noteId:String(p.noteId||'')};
  };
