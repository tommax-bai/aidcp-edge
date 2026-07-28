  const commentPendingApproval=/(待审核|待审批|待批准|等待(?:管理员)?(?:审核|审批|批准)|(?:管理员)?(?:审核|批准)后(?:才)?可见|通过后(?:才)?可见|需(?:要|经)?管理员(?:审核|批准)|pending review|pending approval|awaiting (?:admin(?:istrator)? )?approval|needs? admin(?:istrator)? approval|visible (?:once|after) approved|will be visible (?:once|after))/i;
  const commentActionProbe=()=>{
    const root=actionRoot();
    if(!root)return {ok:false,reason:'target_not_found'};
    if(participationGate())return {ok:false,reason:'pending_group_approval'};
    let actions=associatedFirstPostCommentActions(root);
    if(!actions.length&&!isFirstPostTarget(String(p.noteId||''))){
      const region=exclusiveArticleRegion(root);
      actions=region
        ?firstPostCommentActions(region).filter((button)=>closestArticle(button)===null)
        :[];
    }
    if(actions.length!==1)return {ok:false,reason:actions.length?'ambiguous_target':'editor_not_found'};
    const target=point(actions[0]);
    return target?{ok:true,...target}:{ok:false,reason:'editor_not_found'};
  };
  const commentEditorProbe=()=>{
    const root=actionRoot();
    if(!root)return {ok:false,reason:'target_not_found'};
    if(participationGate())return {ok:false,reason:'pending_group_approval'};
    const allEditors=all('[contenteditable="true"][role="textbox"],textarea[aria-label],textarea').filter(visible).filter((el)=>{
      const raw=`${label(el)} ${text(el,256)}`.toLowerCase();
      return /评论|留言|comment|bình luận|coment|输入回答|answer/.test(raw);
    });
    let editors=isFirstPostTarget(String(p.noteId||''))
      ?allEditors.filter((el)=>root.contains(el))
      :allEditors.filter((el)=>closestArticle(el)===root);
    if(!editors.length&&!isFirstPostTarget(String(p.noteId||''))){
      const region=exclusiveArticleRegion(root);
      const outside=region?allEditors.filter((el)=>region.contains(el)&&closestArticle(el)===null):[];
      editors=outside.length===1?outside:[];
    }
    if(editors.length!==1)return {ok:false,reason:editors.length?'ambiguous_target':'editor_not_found'};
    const editor=editors[0];
    const target=point(editor);
    const value='value' in editor?String(editor.value||''):norm(editor.innerText||editor.textContent||'',32000);
    if(!p.focus)return {ok:Boolean(target),...(target||{}),reason:target?undefined:'editor_not_found',value,noteId:permalinkOf(root)||String(p.noteId||'')};
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
    return {ok:Boolean(target),...(target||{}),reason:target?undefined:'editor_not_found',value,noteId:permalinkOf(root)||String(p.noteId||''),focused,selected};
  };
  const commentAckProbe=()=>{
    const root=actionRoot();
    if(!root)return {ok:false,reason:'target_not_found',confirmed:false,pending:false,rejected:false,inFlight:false};
    const value=norm(p.text||'',32000);
    const ownId=String(p.accountId||'');
    let pending=false,rejected=false,inFlight=false;
    for(const row of all('[role="article"],article',root).filter(visible)){
      if(row===root)continue;
      const raw=text(row,8000);
      if(!raw.includes(value))continue;
      if(!carriesOwnIdentity(row,ownId))continue;
      const status=raw.split(value).join(' ');
      pending=pending||commentPendingApproval.test(status);
      rejected=rejected||/已拒绝|被拒绝|遭拒绝|已(?:被)?驳回|查看反馈|查看意见反馈|đã từ chối|bị từ chối|xem phản hồi|\brejected\b|\bdeclined\b|was not approved|see feedback|view feedback/i.test(status);
      inFlight=inFlight||/发布中|發佈中|发送中|發送中|đang đăng|đang gửi|\bposting\b|\bsending\b/i.test(status);
      const serverId=hasServerCommentId(row);
      const controls=all('button,[role="button"],a[role="button"]',row).filter(visible).map((el)=>label(el));
      const acknowledged=controls.some((raw)=>/^(赞|讚|点赞|按赞|like|thích)$/i.test(raw))
        &&controls.some((raw)=>/^(回复|回覆|reply|trả lời|phản hồi)$/i.test(raw));
      // 在飞（「发布中 / đang đăng」）与待审 / 被拒一样否决确认：id 判据按 provenance 放宽后，
      // 这一道把「平台自己说还在发」的行挡在成功之外，绝不 over-confirm。
      if(!pending&&!rejected&&!inFlight&&(serverId||acknowledged))return {ok:true,confirmed:true,pending:false,rejected:false,inFlight:false};
    }
    pending=pending||participationGate();
    return {ok:true,confirmed:false,pending,rejected,inFlight};
  };
