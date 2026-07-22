async function(input){
  'use strict';
  const kind=String(input.kind||'');
  const p=input.params&&typeof input.params==='object'?input.params:{};
  const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
  const norm=(v,n=2000)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,n);
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
  const text=(el,n=2000)=>norm(el&&(el.innerText||el.textContent||el.getAttribute&&el.getAttribute('aria-label')),n);
  const count=(value)=>{
    const raw=norm(value,64).toLowerCase().replace(/,/g,'');
    const hit=raw.match(/([0-9]+(?:\.[0-9]+)?)\s*([万w千k]?)/i);
    if(!hit)return 0;
    const base=Number(hit[1])||0;
    const unit=hit[2];
    return Math.max(0,Math.round(base*(unit==='万'||unit==='w'?10000:unit==='千'||unit==='k'?1000:1)));
  };
  const noteIdFrom=(value)=>{
    const hit=String(value||'').match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
    return hit?hit[1]:'';
  };
  const dispatchInput=(el,value)=>{
    el.focus();
    if('value' in el){
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')&&Object.getOwnPropertyDescriptor(proto,'value').set;
      if(setter)setter.call(el,value);else el.value=value;
    }else{
      el.textContent=value;
    }
    for(const type of ['input','change'])el.dispatchEvent(new Event(type,{bubbles:true,composed:true}));
  };
  const click=(el)=>{
    if(!el||!visible(el))return false;
    el.scrollIntoView({block:'center',inline:'center'});
    el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:el.getBoundingClientRect().x+4,clientY:el.getBoundingClientRect().y+4}));
    el.click();
    return true;
  };
  const active=(el)=>Boolean(el&&(el.getAttribute('aria-pressed')==='true'||el.getAttribute('data-active')==='true'||/(active|selected|liked|collected|followed)/i.test(el.className||'')));
  const selected=(el)=>Boolean(el&&(active(el)||el.checked===true||['aria-checked','aria-selected','aria-current'].some((name)=>['true','page'].includes(String(el.getAttribute(name)||'')))||el.getAttribute('data-cover')==='true'));
  const action=(name,ok,reason,extra={})=>({kind:'action_receipt',value:{action:name,ok,...(reason?{reason}:{}),...extra}});
  const done=(output,effectPhase='confirmed')=>({effectPhase,output});
  const fail=(name,reason)=>done(action(name,false,reason),'not_started');
  const ambiguous=(name,reason)=>done(action(name,false,reason),'ambiguous');

  const cardNodes=()=>all('section.note-item,[class*="note-item"],a[href*="/explore/"],a[href*="/discovery/item/"]').filter(visible);
  const cards=()=>{
    const seen=new Set();
    const result=[];
    for(const node of cardNodes()){
      const root=node.matches('section,[class*="note-item"]')?node:(node.closest('section,[class*="note-item"]')||node);
      const link=root.matches('a[href]')?root:first(['a[href*="/explore/"]','a[href*="/discovery/item/"]'],root);
      const href=link&&link.href||'';
      const noteId=noteIdFrom(href)||norm(root.getAttribute('data-note-id')||'',256);
      const key=noteId||href||text(root,120);
      if(!key||seen.has(key))continue;
      seen.add(key);
      const titleEl=first(['[class*="title"]','.title','a[title]'],root);
      const authorEl=first(['[class*="author"]','a[href*="/user/profile/"]'],root);
      const likeEl=first(['[class*="like"]','[aria-label*="赞"]','[title*="赞"]'],root);
      const collectEl=first(['[class*="collect"]','[aria-label*="收藏"]','[title*="收藏"]'],root);
      const img=first(['img'],root);
      result.push({
        index:result.length,
        title:text(titleEl||root,200),
        author:authorEl?text(authorEl,200):undefined,
        likeCount:count(text(likeEl,64)),
        collectCount:count(text(collectEl,64)),
        coverDesc:img?norm(img.getAttribute('alt')||'',200):undefined,
        noteId:noteId||undefined,
        isVideo:Boolean(first(['video','[class*="play"]'],root)),
      });
      if(result.length>=60)break;
    }
    return {kind:'page_cards',value:{cards:result}};
  };
  const detailRoot=()=>first(['.note-detail-mask','.note-container','#noteContainer','[class*="note-detail"]','[class*="noteDetail"]','[role="dialog"]']);
  const detail=()=>{
    const root=detailRoot()||document;
    const currentId=noteIdFrom(location.href)||noteIdFrom((first(['a[href*="/explore/"]'],root)||{}).href);
    const titleEl=first(['#detail-title','[class*="title"]','h1'],root);
    const bodyEl=first(['#detail-desc','[class*="desc"]','[class*="content"]','article'],root);
    const authorEl=first(['a[href*="/user/profile/"]','[class*="author"]'],root);
    const authorHref=authorEl&&authorEl.href||'';
    const images=all('img',root).filter(visible).map((img,index)=>({
      index,
      url:String(img.currentSrc||img.src||'').slice(0,4096),
      width:Number(img.naturalWidth||img.width)||undefined,
      height:Number(img.naturalHeight||img.height)||undefined,
      alt:norm(img.alt||'',200)||undefined,
    })).filter((image)=>/^https?:/.test(image.url)).slice(0,20);
    const likes=first(['[class*="like"]','[aria-label*="赞"]'],root);
    const collects=first(['[class*="collect"]','[aria-label*="收藏"]'],root);
    const comments=all('[class*="comment"] [class*="content"],[class*="comment"] p',root).filter(visible).map((el)=>text(el,1000)).filter(Boolean).slice(0,50);
    return {kind:'note_detail',value:{
      noteId:currentId||norm(p.noteId||'',256),
      title:text(titleEl,200),content:text(bodyEl,12000),
      mediaType:first(['video'],root)?'video':'image_text',
      author:authorEl?text(authorEl,200):undefined,
      authorId:(authorHref.match(/\/user\/profile\/([A-Za-z0-9]+)/)||[])[1]||undefined,
      likeCount:count(text(likes,64)),collectCount:count(text(collects,64)),
      authorFollowed:active(first(['[class*="follow"]','button'],root)),
      url:String(location.href).slice(0,4096),images,comments,
    }};
  };
  const profile=()=>{
    const id=(location.pathname.match(/\/user\/profile\/([A-Za-z0-9]+)/)||[])[1]||norm(p.authorId||'',256);
    const nickname=first(['[class*="user-name"]','[class*="nickname"]','h1']);
    const stats=all('[class*="data"],[class*="count"],[class*="info"] span').filter(visible).map((el)=>text(el,80));
    return {kind:'profile_detail',value:{authorId:id,postsCount:count(stats[0]),followersCount:count(stats[1]),likesCollects:count(stats[2]),extracted:Boolean(id),nickname:text(nickname,200)||undefined,url:String(location.href).slice(0,4096)}};
  };
  const notificationItems=(expected)=>{
    const roots=all('[class*="notification-item"],[class*="notice-item"],[class*="message-item"],li').filter(visible);
    const items=roots.map((root)=>{
      const raw=text(root,2200); if(!raw)return null;
      const author=first(['a[href*="/user/profile/"]','[class*="user"]','[class*="name"]'],root);
      const href=author&&author.href||'';
      const kindGuess=expected||(/关注/.test(raw)?'follow':/收藏/.test(raw)?'collect':/赞/.test(raw)?'like':/提到|@/.test(raw)?'mention':'comment');
      return {kind:kindGuess,fromUser:text(author,200)||'unknown',fromUserId:(href.match(/\/user\/profile\/([A-Za-z0-9]+)/)||[])[1]||undefined,content:raw,noteTitle:text(first(['[class*="title"]'],root),200)||undefined,itemKey:norm(root.getAttribute('data-id')||href||raw,256)};
    }).filter(Boolean).slice(0,100);
    return {kind:'notification_items',value:{items,epoch:Date.now()}};
  };
  const notificationHome=()=>{
    const body=text(document.body,5000);
    const named=(word)=>{const hit=body.match(new RegExp(word+'[^0-9]{0,8}([0-9万w千k.]+)','i'));return hit?count(hit[1]):0;};
    return {kind:'notification_home',value:{comments:named('评论|comment'),likes:named('赞|like'),follows:named('关注|follow'),epoch:Date.now()}};
  };
  const exactNote=()=>{
    const current=noteIdFrom(location.href)||noteIdFrom((first(['.note-detail-mask a[href*="/explore/"]','[class*="note-detail"] a[href*="/explore/"]'])||{}).href);
    return !p.noteId||(Boolean(current)&&current===p.noteId);
  };
  const findByWords=(words,root=document)=>{
    const expected=words.map((word)=>String(word).toLowerCase()).filter(Boolean);
    for(const selector of ['button,[role="button"],a','span','div']){
      const hit=all(selector,root).filter(visible).find((el)=>expected.some((word)=>text(el,100).toLowerCase().includes(word)));
      if(hit)return hit;
    }
    return null;
  };

  if(kind==='session_stop')return done(action('session_stop',true));
  if(kind==='browse_next'||kind==='browse_scroll'||kind==='page_scroll'){
    if(p.reason==='initial_scan')return done(cards());
    const modal=detailRoot(); if(kind==='browse_next'&&modal){const close=first(['[class*="close"]','button[aria-label*="关闭"]'],modal);if(close)click(close);}
    const before=window.scrollY; window.scrollBy({top:Math.max(360,Math.round(innerHeight*0.78)),behavior:'smooth'}); await sleep(500);
    const output=cards(); output.value.movement={before,after:window.scrollY,moved:window.scrollY!==before,atBottom:window.scrollY+innerHeight>=document.documentElement.scrollHeight-24};
    return done(output);
  }
  if(kind==='feed_refresh'){
    const refresh=findByWords(['刷新','refresh']);
    if(!refresh)return fail('refresh','refresh_control_not_found');
    click(refresh);await sleep(900);return done(cards());
  }
  if(kind==='search_execute'){
    const decodeKeyword=(value)=>{let decoded=String(value||'');for(let i=0;i<2;i++){try{const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}catch{break;}}return norm(decoded,512);};
    const onRequestedResults=()=>{
      if(!/\/(search|search_result\w*)/.test(location.pathname))return false;
      const current=new URL(location.href).searchParams.get('keyword')||'';
      return decodeKeyword(current)===norm(p.keyword,512);
    };
    if(!onRequestedResults()){
      const inputEl=first(['textarea[name="aiSearchTextarea"]','textarea[placeholder*="搜索"]','textarea[placeholder*="search"]','input[type="search"]','input[placeholder*="搜索"]','input[placeholder*="search"]']);
      if(!inputEl)return fail('search','search_input_not_found');
      dispatchInput(inputEl,norm(p.keyword,512));
      inputEl.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
      inputEl.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
      await sleep(1500);
      if(!onRequestedResults())return ambiguous('search','search_navigation_unconfirmed');
    }
    const filters=[p.sort&&{words:{latest:['最新','latest'],most_liked:['最多点赞','点赞最多','most liked'],most_collected:['最多收藏','收藏最多','most collected'],most_commented:['最多评论','评论最多','most commented']}[p.sort]},p.timeWindow&&{words:{one_day:['一天内','24小时','one day'],one_week:['一周内','one week'],half_year:['半年内','half year']}[p.timeWindow]}].filter((item)=>item&&item.words);
    for(const filter of filters){const opener=findByWords(['筛选','filter']);if(!opener)return fail('search','search_filter_control_not_found');click(opener);await sleep(200);const target=findByWords(filter.words);if(!target)return fail('search','search_filter_value_not_found');if(!selected(target))click(target);await sleep(250);if(!selected(target))return ambiguous('search','search_filter_unconfirmed');}
    return done(cards());
  }
  if(kind==='note_open'){
    if((detailRoot()||noteIdFrom(location.href))&&exactNote())return done(detail());
    if(p.surface==='feed')return fail('open_note','capability_unsupported');
    const candidates=cardNodes();
    const hit=p.noteId?candidates.find((node)=>noteIdFrom((node.matches('a')?node:first(['a[href]'],node)||{}).href)===p.noteId):candidates[Number(p.index)||0];
    if(!hit)return fail('open_note','target_not_found');
    click(hit.matches('a')?hit:(first(['a[href]'],hit)||hit));await sleep(900);
    if(!detailRoot()&&!noteIdFrom(location.href))return ambiguous('open_note','detail_not_confirmed');
    return done(detail());
  }
  if(kind==='note_close'){
    const root=detailRoot();if(!root)return fail('close','detail_not_open');
    const close=first(['[class*="close"]','button[aria-label*="关闭"]','button[title*="关闭"]'],root)||findByWords(['关闭','close'],root);
    if(!close)return fail('close','close_control_not_found');
    click(close);await sleep(350);return detailRoot()?ambiguous('close','detail_still_open'):done(action('close',true));
  }
  if(kind==='navigation_back'){
    history.back();await sleep(800);return done(action('navigation_back',true),/\/(explore|search|search_result)/.test(location.pathname)?'confirmed':'ambiguous');
  }
  if(kind==='note_browse_images'){
    if(!exactNote())return fail('browse_images','note_page_mismatch');
    const root=detailRoot()||document;const next=first(['[class*="next"]','button[aria-label*="下一"]'],root)||findByWords(['下一张','next'],root);
    const iterations=Math.min(20,Math.max(1,Number(p.count)||1));for(let i=0;i<iterations&&next;i++){click(next);await sleep(250);}const out=detail();out.value.refreshOnly=true;return done(out);
  }
  if(kind==='note_scroll_comments'){
    if(!exactNote())return fail('scroll_comments','note_page_mismatch');
    const root=detailRoot()||document;const scroller=first(['[class*="comments"]','[class*="detail"]'],root)||document.scrollingElement;const before=scroller.scrollTop||window.scrollY;scroller.scrollBy?scroller.scrollBy({top:500,behavior:'smooth'}):window.scrollBy(0,500);await sleep(350);return done(action('scroll_comments',true,undefined,{noteId:p.noteId,observation:{articleIndex:Number(p.count)||1,reactionText:String((scroller.scrollTop||window.scrollY)!==before)}}));
  }
  if(kind==='profile_open'){
    if(/\/user\/profile\//.test(location.pathname)&&(!p.authorId||location.pathname.includes('/'+String(p.authorId))))return done(profile());
    const author=first(['.note-detail-mask a[href*="/user/profile/"]','[class*="author"] a[href*="/user/profile/"]','a[href*="/user/profile/"]']);
    if(!author)return fail('open_profile','profile_target_not_found');const targetId=(String(author.href||'').match(/\/user\/profile\/([A-Za-z0-9_-]+)/)||[])[1]||'';if(p.authorId&&targetId!==p.authorId)return fail('open_profile','profile_target_mismatch');click(author);await sleep(900);if(!/\/user\/profile\//.test(location.pathname)||p.authorId&&!location.pathname.includes('/'+String(p.authorId)))return ambiguous('open_profile','profile_navigation_unconfirmed');return done(profile());
  }
  if(kind==='notification_open'){
    const link=first(['a[href*="/notification"]','a[href*="/notice"]'])||findByWords(['通知','消息','notification']);if(!link)return fail('notification_open','notification_entry_not_found');click(link);await sleep(800);return /\/(notification|notice)/.test(location.pathname)?done(notificationHome()):ambiguous('notification_open','notification_navigation_unconfirmed');
  }
  if(kind==='notification_browse_comments'||kind==='notification_browse_likes'||kind==='notification_browse_follows'){
    const expected=kind.endsWith('likes')?'like':kind.endsWith('follows')?'follow':'comment';const tab=findByWords(expected==='like'?['赞和收藏','赞','like']:expected==='follow'?['新增关注','关注','follow']:['评论和@','评论','comment']);if(!tab)return fail(kind,'notification_tab_not_found');if(!selected(tab))click(tab);await sleep(500);return selected(tab)?done(notificationItems(expected)):ambiguous(kind,'notification_tab_unconfirmed');
  }
  if(kind==='notification_back_home'){
    const home=first(['a[href="/explore"]','a[href*="/explore"]'])||findByWords(['首页','发现','home']);if(!home)return fail('notification_back_home','home_entry_not_found');click(home);await sleep(700);return /\/explore/.test(location.pathname)?done(cards()):ambiguous('notification_back_home','home_navigation_unconfirmed');
  }
  if(kind==='interaction_like'||kind==='interaction_collect'||kind==='interaction_follow'){
    const name=kind.replace('interaction_','');if(!exactNote())return fail(name,'note_page_mismatch');const root=detailRoot()||document;
    if(name==='follow'&&p.authorId){const author=first(['a[href*="/user/profile/"]'],root);const observed=(String(author&&author.href||location.href).match(/\/user\/profile\/([A-Za-z0-9_-]+)/)||[])[1]||'';if(!observed||observed!==p.authorId)return fail(name,'author_identity_mismatch');}
    const words=name==='like'?['点赞','赞','like']:name==='collect'?['收藏','collect','save']:['关注','follow'];
    const control=findByWords(words,root);if(!control)return fail(name,'control_not_found');if(active(control))return done(action(name,true,'already_active',{noteId:p.noteId}));click(control);await sleep(450);return active(control)||text(control,100).includes('已')?done(action(name,true,undefined,{noteId:p.noteId})):ambiguous(name,'postcondition_unconfirmed');
  }
  if(kind==='interaction_comment'){
    if(!exactNote())return fail('comment','note_page_mismatch');const root=detailRoot()||document;const editor=first(['textarea','[contenteditable="true"]','input[placeholder*="评论"]'],root);if(!editor)return fail('comment','comment_editor_not_found');dispatchInput(editor,norm(p.text,32000));await sleep(100);if(!text(editor,32000).includes(norm(p.text,100))&&String(editor.value||'')!==String(p.text))return fail('comment','comment_readback_mismatch');const submit=findByWords(['发送','发布','submit'],root);if(!submit)return fail('comment','comment_submit_not_found');click(submit);await sleep(800);const appeared=all('[class*="comment"]',root).some((el)=>text(el,32000).includes(norm(p.text,500)));return appeared?done(action('comment',true,undefined,{noteId:p.noteId})):ambiguous('comment','comment_submit_unconfirmed');
  }
  if(kind==='interaction_like_comment'){
    if(!exactNote())return fail('like_comment','note_page_mismatch');const anchor=all('[data-comment-id],[data-id],[id]',detailRoot()||document).find((el)=>String(el.getAttribute('data-comment-id')||el.getAttribute('data-id')||el.id||'')===String(p.commentAnchorId||''));if(!anchor)return fail('like_comment','comment_target_not_found');const control=findByWords(['赞','like'],anchor);if(!control)return fail('like_comment','control_not_found');if(active(control))return done(action('like_comment',true,'already_active',{noteId:p.noteId}));click(control);await sleep(350);return active(control)?done(action('like_comment',true,undefined,{noteId:p.noteId})):ambiguous('like_comment','postcondition_unconfirmed');
  }
  if(kind==='plan_execute'){
    const results=[];for(const step of p.steps||[]){const map={'note.like_button':['赞','like'],'note.collect_button':['收藏','collect'],'note.follow_button':['关注','follow'],'note.comment_input':['评论','comment'],'page.scroll':[]};if(step.actionId==='page.scroll'){window.scrollBy(0,Math.max(200,Number(step.value)||500));results.push({actionId:step.actionId,ok:true,outcome:'success',attempts:1,reason:'confirmed'});continue;}const el=findByWords(map[step.actionId]||[]);if(!el){results.push({actionId:step.actionId,ok:false,outcome:'no_target',attempts:1,reason:'allowlisted_target_not_found'});continue;}if(step.op==='input'){dispatchInput(el,String(step.value||''));const read='value' in el?String(el.value||''):text(el,32000);const ok=norm(read,32000)===norm(step.value,32000);results.push({actionId:step.actionId,ok,outcome:ok?'success':'escalated',attempts:1,reason:ok?'confirmed':'input_readback_mismatch'});}else{click(el);await sleep(150);const ok=selected(el)||step.actionId==='note.comment_input';results.push({actionId:step.actionId,ok,outcome:ok?'success':'escalated',attempts:1,reason:ok?'confirmed':'postcondition_unconfirmed'});}}
    return done({kind:'plan_results',value:{results}});
  }
  if(kind==='publish_select_mode'){
    const ready=()=>Boolean(first(['input[type="file"][accept*="image"]','input[placeholder*="标题"]','textarea[placeholder*="正文"]','[contenteditable="true"]']));
    if(ready())return done(action('select_mode',true,'already_active'));
    const mode=findByWords(['上传图文','图文','image']);if(!mode)return fail('select_mode','publish_mode_not_found');click(mode);await sleep(500);return ready()?done(action('select_mode',true)):ambiguous('select_mode','publish_mode_unconfirmed');
  }
  if(kind==='publish_fill_field'){
    const field=p.fieldType==='title'?first(['input[placeholder*="标题"]','textarea[placeholder*="标题"]','input[class*="title"]']):first(['[contenteditable="true"]','textarea[placeholder*="正文"]','textarea[placeholder*="描述"]']);if(!field)return fail('fill_field','publish_field_not_found');dispatchInput(field,String(p.value||''));const read='value' in field?String(field.value||''):text(field,32000);return norm(read,32000)===norm(p.value,32000)?done(action('fill_field',true)):ambiguous('fill_field','publish_field_readback_mismatch');
  }
  if(kind==='publish_add_with_candidate'){
    const candidateWords=(p.candidates||[]).concat([String(p.value||'')]);
    if(p.candidateKind==='topic'||p.candidateKind==='mention'){
      const editor=first(['[contenteditable="true"]','textarea[placeholder*="正文"]']);if(!editor)return fail('add_with_candidate','publish_editor_not_found');const prefix=p.candidateKind==='topic'?'#':'@';const value=prefix+String(p.value||'');const before='value' in editor?String(editor.value||''):text(editor,32000);dispatchInput(editor,(before+' '+value).trim());await sleep(300);const candidate=findByWords(candidateWords);if(!candidate)return fail('add_with_candidate','publish_candidate_not_found');click(candidate);await sleep(200);const read='value' in editor?String(editor.value||''):text(editor,32000);return norm(read,32000).includes(norm(p.value,1000))?done(action('add_with_candidate',true)):ambiguous('add_with_candidate','publish_candidate_unconfirmed');
    }
    const entryWords=p.candidateKind==='location'?['地点','位置','location']:p.candidateKind==='collection'?['合集','专辑','collection']:[String(p.candidateKind||'')];
    const entry=findByWords(entryWords);if(!entry)return fail('add_with_candidate','publish_candidate_entry_not_found');click(entry);await sleep(300);const candidate=findByWords(candidateWords);if(!candidate)return fail('add_with_candidate','publish_candidate_not_found');click(candidate);await sleep(250);return selected(candidate)||text(entry.closest('[role="button"],label,div')||entry,500).includes(String(p.value||''))?done(action('add_with_candidate',true)):ambiguous('add_with_candidate','publish_candidate_unconfirmed');
  }
  if(kind==='publish_set_option'){
    const kindWords={visibility:['可见范围','谁可以看','visibility'],comment_permission:['评论权限','允许评论','comment'],save_permission:['保存权限','允许保存','save'],declaration_ai:['AI创作','AI生成','AI'],declaration_ad:['商业合作','广告','ad'],declaration_origin:['原创声明','原创','original']}[p.optionKind]||[String(p.optionKind||'')];
    const label=findByWords(kindWords);if(!label)return fail('set_option','publish_option_not_found');const row=label.closest('label,[role="switch"],[role="checkbox"],[class*="item"],[class*="option"]')||label.parentElement||label;
    const booleanValue=['true','false'].includes(String(p.optionValue));
    if(booleanValue){const desired=String(p.optionValue)==='true';const control=first(['input[type="checkbox"]','[role="switch"]','[role="checkbox"]'],row)||row;if(selected(control)===desired)return done(action('set_option',true,'already_active'));click(control);await sleep(250);return selected(control)===desired?done(action('set_option',true)):ambiguous('set_option','publish_option_unconfirmed');}
    click(row);await sleep(250);const target=findByWords([String(p.optionValue||'')]);if(!target)return fail('set_option','publish_option_value_not_found');if(!selected(target))click(target);await sleep(250);return selected(target)||text(row,500).includes(String(p.optionValue||''))?done(action('set_option',true)):ambiguous('set_option','publish_option_unconfirmed');
  }
  if(kind==='publish_set_schedule'){
    const schedule=findByWords(['定时发布','定时','schedule']);if(!schedule)return fail('set_schedule','schedule_control_not_found');click(schedule);await sleep(200);const field=first(['input[type="datetime-local"]','input[placeholder*="时间"]']);if(!field)return fail('set_schedule','schedule_input_not_found');const date=new Date(Number(p.publishTime));if(!Number.isFinite(date.getTime()))return fail('set_schedule','invalid_schedule_time');const local=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);dispatchInput(field,local);return String(field.value||'').startsWith(local.slice(0,13))?done(action('set_schedule',true)):ambiguous('set_schedule','schedule_readback_mismatch');
  }
  if(kind==='publish_submit'){
    const submit=findByWords(['发布','submit']);if(!submit)return fail('submit','publish_submit_not_found');if(submit.disabled||submit.getAttribute('aria-disabled')==='true')return fail('submit','publish_submit_disabled');click(submit);await sleep(1200);const success=/success|published|发布成功/i.test(location.href+' '+text(document.body,3000));return success?done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:'submit',ok:true,submitDispatched:true,postUrl:String(location.href).slice(0,4096)}}):done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:'submit',ok:false,submitDispatched:true,error:'publish_submit_unconfirmed'}},'ambiguous');
  }
  if(kind==='publish_capture_post_id'){
    const link=first(['a[href*="/explore/"]','a[href*="/discovery/item/"]']);const href=link&&link.href||location.href;const id=noteIdFrom(href)||norm((String(href).match(/[?&](?:note_id|id)=([^&]+)/)||[])[1]||'',256);return done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:'capture_post_id',ok:Boolean(id),value:id||undefined,postUrl:id?String(href).slice(0,4096):undefined,error:id?undefined:'publish_evidence_not_found'}});
  }
  if(kind==='publish_capture_scheduled'||kind==='publish_reconcile_scheduled'){
    const expectedTitle=norm(p.scheduledTitle,2000);const expectedId=norm(p.scheduledPlatformId,256);if(!expectedTitle&&!expectedId)return fail(kind.replace('publish_',''),'scheduled_identity_missing');
    const rows=all('[class*="note-card"],[class*="publish-item"],[class*="note-item"],tr').filter(visible);const matches=rows.filter((row)=>{const title=text(first(['[class*="title"]','[data-title]','a'],row),2000);const href=(first(['a[href]'],row)||{}).href||'';const id=norm(row.getAttribute('data-note-id')||row.getAttribute('data-id')||noteIdFrom(href),256);return (!expectedTitle||title===expectedTitle)&&(!expectedId||id===expectedId);});
    if(matches.length!==1)return done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:kind.replace('publish_',''),ok:false,error:matches.length?'scheduled_match_ambiguous':'scheduled_record_not_found'}},matches.length?'ambiguous':'not_started');
    const row=matches[0];const raw=text(row,4000);const href=(first(['a[href]'],row)||{}).href||'';const id=norm(row.getAttribute('data-note-id')||row.getAttribute('data-id')||noteIdFrom(href),256);const scheduled=/定时|待发布|scheduled/i.test(raw);let timeConfirmed=true;if(Number(p.publishTime)){const date=new Date(Number(p.publishTime));const hh=String(date.getHours()).padStart(2,'0');const mm=String(date.getMinutes()).padStart(2,'0');timeConfirmed=raw.includes(hh+':'+mm);}const ok=scheduled&&timeConfirmed&&Boolean(id);return done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:kind.replace('publish_',''),ok,value:id||undefined,postUrl:href||undefined,error:ok?undefined:!scheduled?'scheduled_state_unconfirmed':!timeConfirmed?'scheduled_time_unconfirmed':'scheduled_platform_id_unavailable'}});
  }
  if(kind==='publish_upload_image'||kind==='publish_set_cover'){
    const previews=all('.img-preview-area img,img[id*="creator-preview"],[class*="preview"] img,[class*="upload"] img').filter(visible);
    const index=Math.max(0,Number(p.imageIndex)||0);const preview=previews[index];if(!preview)return fail(kind.replace('publish_',''),'preview_not_found');
    if(kind==='publish_upload_image')return done(action('upload_image',true));
    const tile=preview.closest('[class*="preview"],[class*="item"],li,div')||preview;click(tile);await sleep(200);const cover=findByWords(['设为封面','封面']);if(cover&&!selected(tile)&&!selected(preview))click(cover);await sleep(250);return selected(tile)||selected(preview)||(cover&&/已.*封面|封面.*已/.test(text(cover,100)))?done(action('set_cover',true)):ambiguous('set_cover','publish_cover_unconfirmed');
  }
  return fail(kind||'unknown','unsupported_command');
}
