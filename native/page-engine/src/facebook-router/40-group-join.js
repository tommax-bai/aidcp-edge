  const joinProbe=()=>{
    const context=joinContext();
    const observation=context.observation;
    const candidates=context.candidates.filter((item)=>item.kind==='join'&&item.inTargetScope);
    const target=candidates.length===1?point(candidates[0].el):null;
    return {
      observation,
      joined:observation.membershipSignals.length>0&&candidates.length===0,
      pending:Boolean(observation.pendingRequest),
      questionnaire:Boolean(observation.questionnaireRequired),
      found:Boolean(target),
      ambiguous:context.scope.ambiguous||candidates.length>1,
      ...(target||{}),
    };
  };
  const groupIdFromValue=(value)=>{
    const raw=String(value||'');
    const hit=raw.match(/(?:facebook\.com)?\/groups\/([^/?#\s"'<>]+)/i);
    if(!hit||!hit[1])return '';
    try{return decodeURIComponent(hit[1]).trim().toLowerCase();}catch{return String(hit[1]).trim().toLowerCase();}
  };
  const groupIdsFromElement=(el)=>{
    if(!el||!el.attributes)return [];
    const ids=[];
    for(const attr of Array.from(el.attributes)){
      const groupId=groupIdFromValue(attr&&attr.value);
      if(groupId&&!ids.includes(groupId))ids.push(groupId);
    }
    return ids;
  };
  const groupReferenceIds=(root)=>[root,...all('*',root)].flatMap(groupIdsFromElement);
  const memberReferenceIds=(root)=>[root,...all('a[href],[role="link"]',root)].flatMap((node)=>{
    if(!node||!node.attributes)return [];
    const ids=[];
    for(const attr of Array.from(node.attributes)){
      const raw=String(attr&&attr.value||'');
      if(!/\/groups\/[^/?#\s"'<>]+\/members(?:[/?#]|$)/i.test(raw))continue;
      const groupId=groupIdFromValue(raw);
      if(groupId&&!ids.includes(groupId))ids.push(groupId);
    }
    return ids;
  });
  const hasForeignGroupRef=(root,groupIds)=>{
    if(!root||!groupIds||groupIds.size===0)return false;
    return [root,...all('*',root)].some((node)=>{
      const referenced=groupIdsFromElement(node);
      return referenced.some((groupId)=>!groupIds.has(groupId));
    });
  };
  const targetGroupScope=(groupId,main)=>{
    if(!groupId||!main)return {region:null,ambiguous:false,heading:null,groupIds:new Set(groupId?[groupId]:[])};
    const headings=all('h1,[role="heading"][aria-level="1"]',main).filter(visible);
    const blocks=[];
    for(const heading of headings){
      const groupIds=new Set([groupId]);
      let region=heading;
      let atMain=false;
      while(region&&region!==main){
        const parent=region.parentElement;
        if(!parent)break;
        if(parent!==main){
          const references=[...new Set(groupReferenceIds(parent))];
          const numericMemberAliases=[...new Set(memberReferenceIds(parent))]
            .filter((candidate)=>candidate!==groupId&&/^\d+$/.test(candidate));
          if(numericMemberAliases.length===1
            && references.every((candidate)=>groupIds.has(candidate)||candidate===numericMemberAliases[0])){
            groupIds.add(numericMemberAliases[0]);
          }
        }
        if(hasForeignGroupRef(parent,groupIds)){
          if(parent===main)atMain=true;
          break;
        }
        region=parent;
      }
      if(region===main)atMain=true;
      if(region===heading&&hasForeignGroupRef(region,groupIds))continue;
      blocks.push({region,heading,atMain,groupIds});
    }
    if(blocks.length===1)return {region:blocks[0].region,ambiguous:false,heading:blocks[0].heading,groupIds:blocks[0].groupIds};
    const topLevel=blocks.filter((item)=>item.atMain);
    if(topLevel.length===1)return {region:topLevel[0].region,ambiguous:false,heading:topLevel[0].heading,groupIds:topLevel[0].groupIds};
    return {region:null,ambiguous:blocks.length>1,heading:null,groupIds:new Set([groupId])};
  };
  const JOIN_LABELS=['join group','join','加入小组','加入群组','加入社团','加入','tham gia','únete','unirte','participar','entrar al grupo','entrar no grupo','gabung','bergabung','เข้าร่วม','rejoindre','beitreten','iscriviti','вступить','присоединиться','참여','가입','انضمام','انضم','sertai'];
  const MEMBER_LABELS=['joined','leave group','已加入','退出小组','退出群组','退出社团','đã tham gia','rời nhóm','salir del grupo','keluar dari grup','quitter le groupe','gruppe verlassen','ออกจากกลุ่ม','已是成员','你已加入'];
  const PENDING_LABELS=['pending','request sent','cancel request','待批准','已申请','待审批','待审核','取消请求','取消加入请求','取消申请','已发送请求','đang chờ','hủy yêu cầu','solicitud enviada','cancelar solicitud','menunggu','batalkan permintaan','demande envoyée','annuler la demande','anfrage gesendet','รอการอนุมัติ','요청 보냄','요청됨','requested'];
  const QUESTION_LABELS=['membership questions','answer questions','answer these questions','questions to join','required question','回答问题','入群问题','必答','加入前请回答','trả lời câu hỏi','responde las preguntas','preguntas de membresía','jawab pertanyaan','répondez aux questions','beantworte die fragen','ตอบคำถาม'];
  const includesAny=(raw,values)=>{
    const normalized=norm(raw,512).toLowerCase();
    return Boolean(normalized)&&values.some((value)=>normalized.includes(value));
  };
  const joinKind=(raw)=>{
    if(includesAny(raw,MEMBER_LABELS))return 'joined';
    if(includesAny(raw,PENDING_LABELS))return 'pending';
    if(includesAny(raw,JOIN_LABELS))return 'join';
    return 'other';
  };
  const joinContext=()=>{
    const path=location.pathname.split('/').filter(Boolean);
    let groupId=path[0]&&path[0].toLowerCase()==='groups'?path[1]||null:null;
    if(groupId){try{groupId=decodeURIComponent(groupId).trim().toLowerCase();}catch{groupId=String(groupId).trim().toLowerCase();}}
    const main=first(['[role="main"]','main'])||document.body;
    const scope=targetGroupScope(groupId,main);
    const candidates=all('button,[role="button"],a[role="button"]').filter(visible).map((el)=>{
      const raw=label(el,256);
      return {
        el,
        raw,
        kind:joinKind(raw),
        inTargetScope:Boolean(scope.region&&scope.region.contains(el)&&!hasForeignGroupRef(el,scope.groupIds)),
      };
    });
    const scoped=candidates.filter((item)=>item.inTargetScope);
    const mainCta=scoped.find((item)=>item.kind==='join')||scoped.find((item)=>item.kind!=='other');
    const signals=scoped.filter((item)=>item.kind==='joined').map((item)=>item.raw).slice(0,16);
    const modal=first(['[role="dialog"]','[aria-modal="true"]']);
    const modalText=text(modal,1000);
    const headerText=text(scope.heading,1000);
    const blocking=blockingProbe();
    const observation={
      groupUrl:groupId?`https://www.facebook.com/groups/${groupId}`:undefined,
      pageUrl:String(location.href).slice(0,4096),
      title:text(scope.heading,200)||undefined,
      mainCtaText:mainCta&&mainCta.raw||null,
      mainCtaAria:mainCta&&label(mainCta.el,256)||null,
      headerText:headerText||null,
      modalText:modalText||null,
      membershipSignals:signals,
      loginRequired:blocking.kind==='login',
      captchaDetected:blocking.kind==='captcha',
      questionnaireRequired:includesAny(`${modalText} ${headerText}`,QUESTION_LABELS),
      pendingRequest:scoped.some((item)=>item.kind==='pending'),
      actionNodeCount:candidates.length,
      documentReady:document.readyState,
      composerPresent:Boolean(commentEditor(main)),
      joinCtaPresent:scoped.some((item)=>item.kind==='join'),
      targetGroupId:groupId,
      scopeResolved:Boolean(scope.region),
      outOfScopeJoinCount:candidates.filter((item)=>item.kind==='join'&&!item.inTargetScope).length,
      ctaCandidates:candidates.slice(0,50).map((item)=>({text:item.raw||null,kind:item.kind,inTargetScope:item.inTargetScope})),
    };
    return {observation,candidates,scope};
  };
  const joinObservation=()=>joinContext().observation;
  const joinActuation=()=>{
    const blocking=blockingProbe();
    if(blocking.kind==='login')return {clicked:false,reason:'login_required'};
    if(blocking.kind==='captcha')return {clicked:false,reason:'blocked_by_captcha'};
    if(blocking.kind==='unknown')return {clicked:false,reason:'blocked_by_unknown'};
    const context=joinContext();
    if(!context.scope.region)return {clicked:false,reason:context.scope.ambiguous?'ambiguous_target':'scope_unresolved'};
    const candidates=context.candidates.filter((item)=>item.inTargetScope&&item.kind==='join');
    if(candidates.length===0)return {clicked:false,reason:'no_target_in_scope'};
    if(candidates.length>1)return {clicked:false,reason:'ambiguous_target'};
    const target=candidates[0].el;
    if(target.disabled||target.getAttribute('aria-disabled')==='true'||target.getAttribute('disabled')!==null)return {clicked:false,reason:'disabled'};
    try{target.click();return {clicked:true};}catch{return {clicked:false,reason:'click_failed'};}
  };
