  const blocking=blockingProbe();
  const blocked=blocker(blocking);
  if(!['identity_read','page_probe','auth_probe','auth_focus_guard','auth_totp_readback','auth_postcondition','consent_probe','feed_probe','identity_candidates','feed_home_target','feed_recovery_target','feed_like_target_probe','feed_like_commit','feed_like_verify','feed_like_picker_probe','feed_like_clear','like_probe','like_primary_commit','like_verify','like_picker_probe','follow_probe','comment_action_probe','comment_editor_probe','comment_ack_probe','join_probe','join_click','first_post_group_root_probe','publish_home_probe','publish_entry_probe','publish_editor_probe','publish_bound_editor_probe','publish_upload_target_probe','publish_upload_preview_probe','publish_submit_probe','publish_submitted_probe','reel_probe','reel_next_target','reel_cards'].includes(kind)&&blocked){
    return fail(kind||'page',blocked);
  }
  if(kind==='auth_probe')return done({kind:'facebook_auth_observation',value:await authProbeBase(true)});
  if(kind==='auth_focus_guard')return done(await authFocusGuard());
  if(kind==='auth_totp_readback')return done(await authTotpReadback());
  if(kind==='auth_postcondition')return done(await authPostcondition());
  if(kind==='identity_read')return done(identity());
  if(kind==='consent_probe')return done({kind:'consent_probe',value:consentProbe()});
  if(kind==='feed_probe')return done(await feedProbe());
  if(kind==='identity_candidates')return done(identityCandidates());
  if(kind==='feed_home_target')return done({kind:'point_target',value:feedHomeTarget()});
  if(kind==='feed_recovery_target')return done({kind:'point_target',value:feedRecoveryTarget()});
  if(kind==='feed_like_target_probe')return done({kind:'feed_like_target_probe',value:feedLikeTargetValue(feedLikeTarget())});
  if(kind==='feed_like_commit')return done({kind:'feed_like_commit',value:feedLikeCommit()});
  if(kind==='feed_like_verify')return done({kind:'feed_like_verify',value:feedLikeVerify()});
  if(kind==='feed_like_picker_probe')return done({kind:'feed_like_picker_probe',value:feedLikePickerProbe()});
  if(kind==='feed_like_clear')return done({kind:'feed_like_clear',value:feedLikeClear()});
  if(kind==='like_probe')return done({kind:'like_probe',value:likeProbe()});
  if(kind==='like_primary_commit')return done({kind:'like_commit',value:likePrimaryCommit()});
  if(kind==='like_verify')return done({kind:'like_verify',value:likeVerify()});
  if(kind==='like_picker_probe')return done({kind:'point_target',value:likePickerProbe()});
  if(kind==='follow_probe')return done({kind:'follow_probe',value:followProbe()});
  if(kind==='comment_action_probe')return done({kind:'point_target',value:commentActionProbe()});
  if(kind==='comment_editor_probe')return done({kind:'text_target',value:commentEditorProbe()});
  if(kind==='comment_ack_probe')return done({kind:'comment_ack_probe',value:commentAckProbe()});
  if(kind==='join_probe')return done({kind:'join_probe',value:joinProbe()});
  if(kind==='join_click')return done({kind:'join_click',value:joinActuation()});
  if(kind==='first_post_group_root_probe')return done({kind:'first_post_group_root_probe',value:firstPostGroupRootProbe()});
  if(kind==='publish_home_probe')return done({kind:'publish_home_probe',value:publishHomeProbe()});
  if(kind==='publish_entry_probe')return done({kind:'point_target',value:publishEntryProbe()});
  if(kind==='publish_editor_probe')return done({kind:'text_target',value:publishEditorProbe()});
  if(kind==='publish_bound_editor_probe')return done({kind:'text_target',value:publishBoundEditorProbe()});
  if(kind==='publish_upload_target_probe')return done({kind:'point_target',value:publishUploadTargetProbe()});
  if(kind==='publish_upload_preview_probe')return done({kind:'point_target',value:publishUploadPreviewProbe()});
  if(kind==='publish_submit_probe')return done({kind:'publish_submit_probe',value:publishSubmitProbe()});
  if(kind==='publish_submitted_probe')return done({kind:'publish_submitted_probe',value:publishSubmittedProbe()});
  if(kind==='reel_probe')return done({kind:'reel_probe',value:reelProbeValue(activeReel())});
  if(kind==='reel_next_target')return done({kind:'reel_next_target',value:reelNextTarget()});
  if(kind==='reel_cards')return done(await feedCards());
  if(kind==='page_probe'){
    const surface=classify();
    const cards=topArticles().length;
    const probedKind=blocking.kind==='captcha'?'captcha':blocking.kind==='login'?'login':blocking.kind==='unknown'?'unknown':surface==='home'?'home':surface==='search'?'search':surface.endsWith('_post')?'note_detail':surface==='login'?'login':'unknown';
    return done({kind:'page_probe',value:{
      targetId:'',
      origin:location.origin,
      path:location.pathname,
      readyState:['loading','interactive','complete'].includes(document.readyState)?document.readyState:'unknown',
      pageKind:probedKind,
      blockingKind:blocking.kind,
      blockingText:blocking.text?blocking.text.slice(0,1000):undefined,
      signals:{feedCardCount:cards,noteDetailCount:surface.endsWith('_post')?1:0,loginWallCount:blocking.kind==='login'?1:0,captchaSignalCount:blocking.kind==='captcha'?1:0,dialogCount:all('[role="dialog"],[aria-modal="true"]').filter(visible).length,profileSignalCount:surface==='page'?1:0,notificationSignalCount:0,publishSignalCount:0,errorSignalCount:blocking.kind==='unknown'?1:0,mainCount:all('main,[role="main"]').length},
    }});
  }
  if(kind==='session_stop')return done(action('session_stop',true));
  if(kind==='browse_scroll'||kind==='page_scroll'||kind==='browse_next'){
    const reelsEntryReason=p.reason==='facebook_reels_primary'||p.reason==='empty_feed_reels_fallback';
    if(reelSurface()&&p.reason!=='initial_scan'&&!reelsEntryReason){
      return fail('scroll','native_reels_actuator_required');
    }
    if(p.reason!=='initial_scan'){
      const firstPostProbe=p.reason==='first_commentable_group_post_probe';
      if(firstPostProbe&&!firstPostGroupRootMatches(p.container)){
        return done(firstPostTargetContextMismatchCards());
      }
      // 滚动与位移/到底回报都必须落在**真正在滚的那个元素**上（20-feed.js `feedScrollNode`）。
      // 群页有一类版式文档本身不滚，照滚窗口 ⇒ 位移恒 0、到底恒真，Native 的「没动且到底」判据
      // 从第一轮起就成立，四轮下滚预算实际只跑一轮——首帖没找到就直接放弃。窗口真的会滚时行为不变。
      const before=feedScrollBy(Math.max(420,Math.round((window.innerHeight||800)*0.8)));
      await sleep(450);
      if(firstPostProbe)await sleep(2000);
      if(firstPostProbe&&!firstPostGroupRootMatches(p.container)){
        return done(firstPostTargetContextMismatchCards());
      }
      const output=firstPostProbe?await firstPostCards():await feedCards();
      if(firstPostProbe&&!firstPostGroupRootMatches(p.container)){
        return done(firstPostTargetContextMismatchCards());
      }
      output.value.movement=feedScrollMovement(before);
      return done(output);
    }
    return done(await feedCards());
  }
  if(kind==='feed_refresh'){
    if(p.reason!=='first_commentable_group_post_probe')return done(await feedCards());
    if(!firstPostGroupRootMatches(p.container,true))return done(firstPostTargetContextMismatchCards());
    const output=await firstPostCards();
    return done(firstPostGroupRootMatches(p.container,true)?output:firstPostTargetContextMismatchCards());
  }
  if(kind==='search_execute'){
    if(!p.container)return fail('search','permission_gated');
    const output=await feedCards();
    const heading=first(['main h1','[role="main"] h1','[role="heading"][aria-level="1"]']);
    output.value.containerName=text(heading,200)||undefined;
    return done(output);
  }
  if(kind==='note_open'){
    if(p.surface==='feed'){
      const root=actionRoot();
      // 动作名用云端角色关联的规范名 open_note（既不是消息名 note.open、也不是裸 open）：回错名不会报错，
      // 只会让云端 open_note 专属的清理（评论迁移标志、评论支线时钟）永远等不到匹配。
      if(!root)return fail('open_note','target_not_found');
      const read=await inlineExpandRead(root);
      if(!read.ok)return fail('open_note',read.reason);
      return done(noteDetail(root,permalinkOf(root)||String(p.noteId||''),read.body));
    }
    // 用途为「导航」的开帖由引擎侧真导航完成，页面规则里不该再有它的归宿。
    // 缺面别参数就把当前页详情回上去，等于页面没动却报开成功 —— 诚实报找不到目标。
    if(p.purpose==='navigate')return fail('open','target_not_found');
    return done(currentDetail());
  }
  if(kind==='note_close'||kind==='navigation_back'){
    history.back();
    return done(action('back',true));
  }
  if(kind==='note_browse_images'){
    const root=actionRoot()||document;
    const buttons=all('button,[role="button"]',root).filter(visible).filter((el)=>/next|下一|下一个/i.test(label(el)));
    let moved=0;for(let i=0;i<Math.min(Number(p.count)||1,20)&&buttons[0];i++){if(click(buttons[0]))moved++;await sleep(250);}
    return done(action('browse_images',moved>0,moved?'confirmed':'next_not_found',{noteId:String(p.noteId||'')}));
  }
  if(kind==='note_scroll_comments'){
    const root=actionRoot()||document;
    root.scrollIntoView&&root.scrollIntoView({block:'start'});
    window.scrollBy({top:Math.max(300,Math.round((window.innerHeight||800)*0.6)),behavior:'smooth'});
    await sleep(350);
    const candidates=comments(root).map((value,index)=>({anchorId:`comment-${index}`,text:value}));
    return done(action('scroll_comments',true,undefined,{noteId:String(p.noteId||''),candidates}));
  }
  if(kind==='profile_open'){
    const root=actionRoot()||document;
    const author=articleAuthor(root);
    const currentId=(location.href.match(/[?&]id=(\d{5,})/)||location.href.match(/\/people\/[^/]+\/(\d{5,})/)||[])[1]||String(p.authorId||'');
    const body=text(document.body,5000);
    return done({kind:'profile_detail',value:{authorId:currentId,postsCount:count((body.match(/([0-9.,KM万]+)\s*(?:posts|帖子)/i)||[])[1]),followersCount:count((body.match(/([0-9.,KM万]+)\s*(?:followers|粉丝)/i)||[])[1]),extracted:Boolean(currentId),nickname:author.name||text(first(['h1']),200)||undefined,url:String(location.href).slice(0,4096)}});
  }
  if(kind==='interaction_like'){
    const root=actionRoot();if(!root)return fail('like','target_not_found');
    const button=reactionButton(root);if(!button)return fail('like','like_button_not_found');
    const observation=actionEvidence(root);
    if(pressed(button)||/取消赞|remove like|unlike/i.test(label(button)))return done(action('like',true,'already_liked',{noteId:permalinkOf(root),observation}));
    if(!click(button))return fail('like','like_dispatch_failed');
    await sleep(350);
    const ok=pressed(button)||/取消赞|remove like|unlike/i.test(label(button));
    return ok?done(action('like',true,undefined,{noteId:permalinkOf(root),observation})):ambiguous('like','like_unconfirmed',{noteId:permalinkOf(root),observation});
  }
  if(kind==='interaction_follow'){
    const root=actionRoot()||document;
    const buttons=all('button,[role="button"]',root).filter(visible);
    const button=buttons.find((el)=>/^(关注|follow|theo dõi)$/i.test(label(el)));
    if(!button){
      const already=buttons.find((el)=>/已关注|following|đang theo dõi/i.test(label(el)));
      return already?done(action('follow',true,'already_following',{noteId:String(p.noteId||'')})):fail('follow','follow_button_not_found');
    }
    if(!click(button))return fail('follow','follow_dispatch_failed');
    await sleep(350);
    const ok=/已关注|following|đang theo dõi/i.test(label(button))||!visible(button);
    return ok?done(action('follow',true,undefined,{noteId:String(p.noteId||'')})):ambiguous('follow','follow_unconfirmed',{noteId:String(p.noteId||'')});
  }
  if(kind==='interaction_comment'){
    const root=actionRoot()||document;
    const editor=commentEditor(root);if(!editor)return fail('comment','editor_not_found');
    const value=String(p.text||'');if(!value)return fail('comment','comment_text_empty');
    if(!fill(editor,value))return fail('comment','editor_fill_failed');
    const read='value' in editor?String(editor.value||''):text(editor,32000);
    if(norm(read,32000)!==norm(value,32000))return fail('comment','editor_readback_mismatch');
    const submit=all('button,[role="button"]',root).filter(visible).find((el)=>/^(发布|评论|comment|post|send|gửi)$/i.test(label(el)));
    let dispatched=false;
    if(submit&&!submit.disabled&&submit.getAttribute('aria-disabled')!=='true')dispatched=click(submit);
    else{
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
      editor.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true}));
      dispatched=true;
    }
    if(!dispatched)return fail('comment','comment_dispatch_failed');
    await sleep(700);
    const verified=all('[role="article"],article',root).some((el)=>{
      if(!text(el,4000).includes(value))return false;
      return hasServerCommentId(el);
    });
    return verified?done(action('comment',true,undefined,{noteId:String(p.noteId||'')})):ambiguous('comment','verification_ambiguous',{noteId:String(p.noteId||'')});
  }
  if(kind==='interaction_like_comment'){
    const target=document.getElementById(String(p.commentAnchorId||''));if(!target)return fail('comment_like','comment_anchor_not_found');
    const button=all('button,[role="button"]',target).filter(visible).find((el)=>/^(赞|like|thích)/i.test(label(el)));if(!button)return fail('comment_like','comment_like_button_not_found');
    if(pressed(button))return done(action('comment_like',true,'already_liked',{noteId:String(p.noteId||'')}));
    if(!click(button))return fail('comment_like','comment_like_dispatch_failed');await sleep(300);
    return pressed(button)?done(action('comment_like',true,undefined,{noteId:String(p.noteId||'')})):ambiguous('comment_like','comment_like_unconfirmed',{noteId:String(p.noteId||'')});
  }
  if(kind==='group_join'){
    const before=joinObservation();
    const groupUrl=before.groupUrl||String(p.groupUrl||'');
    const member=before.membershipSignals.length>0;
    if(member)return done(action('join_group',false,'already_member',{groupUrl,clicked:false,groupObservation:before}));
    if(before.questionnaireRequired)return fail('join_group','questionnaire_required');
    if(before.pendingRequest)return done(action('join_group',false,'pending',{groupUrl,clicked:false,groupObservation:before}));
    if(!p.click)return done(action('join_group',false,'observation_only',{groupUrl,clicked:false,groupObservation:before}));
    if(!before.scopeResolved)return fail('join_group','not_ready');
    const actuation=joinActuation();
    if(!actuation.clicked){
      if(['scope_unresolved','no_target_in_scope','ambiguous_target'].includes(actuation.reason))return fail('join_group','not_ready');
      return fail('join_group','no_button');
    }
    await sleep(900);
    const after=joinObservation();
    if(after.loginRequired)return ambiguous('join_group','login_required',{groupUrl,clicked:true,groupObservation:before,postObservation:after});
    if(after.captchaDetected)return ambiguous('join_group','blocked_by_captcha',{groupUrl,clicked:true,groupObservation:before,postObservation:after});
    if(after.pendingRequest)return done(action('join_group',false,'pending',{groupUrl,clicked:true,groupObservation:before,postObservation:after}));
    if(after.questionnaireRequired)return done(action('join_group',false,'questionnaire_required',{groupUrl,clicked:true,groupObservation:before,postObservation:after}));
    const joined=after.membershipSignals.length>0||(!before.composerPresent&&after.composerPresent&&!after.joinCtaPresent);
    return joined?done(action('join_group',true,undefined,{groupUrl,clicked:true,groupObservation:before,postObservation:after})):ambiguous('join_group','join_verification_ambiguous',{groupUrl,clicked:true,groupObservation:before,postObservation:after});
  }
  if(kind==='publish_set_cover'||kind==='publish_add_with_candidate'||kind==='publish_set_option'||kind==='publish_set_schedule')return fail(kind.replace('publish_',''),'kind_not_implemented');
  if(kind==='publish_capture_post_id'){
    const current=cleanPermalink(location.href);
    const candidates=topArticles().map((article)=>({href:permalinkOf(article),body:articleBody(article)})).filter((item)=>item.href);
    const expected=norm(p.scheduledTitle,2000);
    const matched=expected?candidates.filter((item)=>norm(item.body,2000).includes(expected)):candidates.slice(0,1);
    const href=current||(matched.length===1?matched[0].href:'');
    return done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:'capture_post_id',ok:Boolean(href),value:postId(href)||undefined,postUrl:href||undefined,error:href?undefined:'publish_evidence_not_found'}});
  }
  if(kind==='publish_capture_scheduled'||kind==='publish_reconcile_scheduled'){
    return done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:kind.replace('publish_',''),ok:false,error:'kind_not_implemented'}},'not_started');
  }
  return fail(kind||'unknown','unsupported_command');
}
