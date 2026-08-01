  const facebookAuthSignalPrefix='aidcp:facebook-auth:v1:';
  const facebookAuthCredentialFillGraceMs=1500;
  const authDigest=async(value)=>{
    const bytes=new TextEncoder().encode(String(value||''));
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(digest),(byte)=>byte.toString(16).padStart(2,'0')).join('');
  };
  const authDocumentGeneration=async()=>{
    const timeOrigin=Number(window.performance&&window.performance.timeOrigin)||0;
    const urlState=`${location.origin}${location.pathname}${location.search}`;
    return `v1:${await authDigest(`${Math.round(timeOrigin)}\n${urlState}`)}`;
  };
  const authTopHit=(el)=>{
    const target=point(el);
    if(!target||target.cx<0||target.cy<0||target.cx>(window.innerWidth||0)||target.cy>(window.innerHeight||0))return false;
    const hit=document.elementFromPoint&&document.elementFromPoint(target.cx,target.cy);
    return Boolean(hit&&(hit===el||el.contains(hit)));
  };
  const authElementEvidence=(el,includeGeometry=true)=>{
    if(!el)return '';
    const path=[];
    let current=el;
    for(let depth=0;current&&current!==document&&depth<10;depth++){
      const parent=current.parentElement;
      const siblings=parent?Array.from(parent.children).filter((node)=>node.tagName===current.tagName):[current];
      path.unshift(`${String(current.tagName||'').toLowerCase()}:${Math.max(0,siblings.indexOf(current))}`);
      current=parent;
    }
    const evidence=[
      path.join('/'),
      norm(el.getAttribute&&el.getAttribute('role'),64),
      norm(el.getAttribute&&el.getAttribute('name'),64),
      norm(el.getAttribute&&el.getAttribute('type'),32),
      norm(el.getAttribute&&el.getAttribute('aria-label'),128),
    ];
    if(includeGeometry){
      const rect=el.getBoundingClientRect();
      evidence.push([rect.left,rect.top,rect.width,rect.height].map((value)=>Math.round(Number(value)||0)).join(','));
    }
    return evidence.join('|');
  };
  const authTotpElementEvidence=(el)=>authElementEvidence(el,false);
  const authObservation=async(signal,candidate,reason,extra={})=>{
    const documentGeneration=await authDocumentGeneration();
    if(!candidate){
      return {
        signal,
        documentGeneration,
        ...(reason?{reason}:{}),
        ...extra,
      };
    }
    const stableTotpTarget=signal==='totp_entry_ready'
      ||signal==='totp_refresh_required'
      ||signal==='totp_submit_ready';
    const candidateKey=await authDigest(stableTotpTarget
      ?authTotpElementEvidence(candidate)
      :authElementEvidence(candidate));
    const signalEvidence=[
      String(p.targetId||''),
      documentGeneration,
      signal,
      candidateKey,
    ];
    if(signal==='totp_refresh_required')signalEvidence.push(String(candidate.value||''));
    const signalId=`${facebookAuthSignalPrefix}${await authDigest(signalEvidence.join('\n'))}`;
    const target=point(candidate);
    return {
      signal,
      signalId,
      documentGeneration,
      candidate:{candidateKey,cx:target.cx,cy:target.cy},
      ...(reason?{reason}:{}),
      ...extra,
    };
  };
  const authUnique=(elements)=>{
    const candidates=[...new Set(elements.filter(visible))];
    if(candidates.length!==1)return {candidate:null,reason:candidates.length===0?'auth_target_not_found':'auth_target_ambiguous'};
    if(!authTopHit(candidates[0]))return {candidate:null,reason:'auth_target_not_topmost'};
    return {candidate:candidates[0],reason:''};
  };
  const authButtons=(root)=>all('button,[role="button"],input[type="submit"]',root).filter(visible);
  const authTargetDisabled=(candidate)=>Boolean(
    candidate
    &&(
      candidate.disabled
      ||candidate.hasAttribute('disabled')
      ||String(candidate.getAttribute('aria-disabled')||'').toLowerCase()==='true'
    )
  );
  const authFormOwner=(candidate)=>candidate&&(candidate.form||candidate.closest('form'));
  const authSharesNonRootScope=(input,candidate)=>{
    if(candidate&&candidate.contains(input))return false;
    const inputForm=authFormOwner(input);
    const candidateForm=authFormOwner(candidate);
    if(candidateForm&&candidateForm!==inputForm)return false;
    const inputDialog=input&&input.closest('[role="dialog"],[aria-modal="true"]');
    const candidateDialog=candidate&&candidate.closest('[role="dialog"],[aria-modal="true"]');
    if(inputDialog!==candidateDialog&&(inputDialog||candidateDialog))return false;
    let scope=input&&input.parentElement;
    while(scope&&scope!==document.body&&scope!==document.documentElement){
      if(scope.contains(candidate))return true;
      scope=scope.parentElement;
    }
    return false;
  };
  const authTotpSubmitInventory=()=>[...new Set(
    all('button,[role="button"],input[type="submit"]',document).filter((button)=>
      /^(continue|继续|繼續)$/i.test(label(button))
    )
  )];
  const authTotpSubmitTarget=(input)=>{
    const inventory=authTotpSubmitInventory();
    const candidates=inventory.filter(visible);
    if(candidates.length!==1){
      const reason=candidates.length>1
        ?'auth_target_ambiguous'
        :inventory.length>0?'auth_target_not_visible':'auth_target_not_found';
      return {candidate:null,reason,inventory};
    }
    const candidate=candidates[0];
    if(!authSharesNonRootScope(input,candidate)){
      return {candidate:null,reason:'auth_target_out_of_scope',inventory};
    }
    if(authTargetDisabled(candidate)){
      return {candidate:null,reason:'auth_target_disabled',inventory};
    }
    if(!authTopHit(candidate))return {candidate:null,reason:'auth_target_not_topmost',inventory};
    return {candidate,reason:'',inventory};
  };
  const authTotpContext=()=>(
    /\/two_step_verification\/two_factor\/?/i.test(location.pathname)
    ||/two-factor authentication|authentication app|enter (?:the )?(?:login|security) code|双重验证|双重驗證|验证码|驗證碼/i.test(text(document.body,5000))
  );
  const authEditableInput=(input)=>Boolean(input&&!input.disabled&&!input.readOnly);
  const authAssociatedLabelText=(input)=>Array.from((input&&input.labels)||[])
    .map((associated)=>text(associated,512))
    .join(' ');
  const authTotpMeaning=(raw)=>/\bcode\b|验证码|驗證碼/i.test(String(raw||''));
  const authTotpInputCandidates=()=>{
    const specific=all([
      'input[autocomplete="one-time-code"]',
      'input[name="approvals_code"]',
      'input[inputmode="numeric"]',
    ].join(',')).filter(visible).filter(authEditableInput);
    if(specific.length)return [...new Set(specific)];
    if(!authTotpContext())return [];
    return all('input[type="text"],input:not([type])').filter(visible).filter(authEditableInput).filter((input)=>{
      const raw=[
        label(input),
        input.getAttribute('placeholder')||'',
        authAssociatedLabelText(input),
      ].join(' ');
      return authTotpMeaning(raw);
    });
  };
  const authTotpInput=()=>{
    const candidates=authTotpInputCandidates();
    return candidates.length===1?candidates[0]:null;
  };
  const authServerEpochMs=async()=>{
    const fetcher=window.fetch;
    if(typeof fetcher!=='function')return {status:'unavailable'};
    try{
      const started=Number(window.performance&&window.performance.now&&window.performance.now());
      const response=await fetcher.call(window,`${location.origin}/`,{
        method:'HEAD',
        credentials:'include',
        cache:'no-store',
        redirect:'follow',
      });
      const finished=Number(window.performance&&window.performance.now&&window.performance.now());
      const raw=response&&response.headers&&response.headers.get&&response.headers.get('date');
      const epoch=Date.parse(String(raw||''));
      if(!Number.isFinite(epoch)||epoch<=0||!Number.isFinite(started)||!Number.isFinite(finished)){
        return {status:'unavailable'};
      }
      const lower=Math.round(epoch);
      const upper=lower+999+Math.ceil(Math.max(0,finished-started));
      if(Math.floor(lower/30000)!==Math.floor(upper/30000)){
        return {status:'retry'};
      }
      return {status:'ok',epochMs:upper};
    }catch{
      return {status:'unavailable'};
    }
  };
  const authLoginObservation=async()=>{
    const visibleForms=all('form').filter(visible);
    const fieldForms=visibleForms.filter((form)=>
      all('input[name="email"],input[type="email"],input#email,input[name="pass"][type="password"],input[type="password"]',form)
        .some(visible)
    );
    if(fieldForms.length===0)return authObservation('none',null,'login_form_hydrating');
    if(fieldForms.length!==1)return authObservation('blocked_unknown',null,'login_form_ambiguous');
    const form=fieldForms[0];
    const emails=[...new Set(all('input[name="email"],input[type="email"],input#email',form).filter(visible))];
    const passwords=[...new Set(all('input[name="pass"][type="password"],input[type="password"]',form).filter(visible))];
    if(emails.length>1||passwords.length>1)return authObservation('blocked_unknown',null,'login_fields_ambiguous');
    if(emails.length!==1||passwords.length!==1)return authObservation('none',null,'login_fields_hydrating');
    if(!String(emails[0].value||'').trim()||!String(passwords[0].value||'')){
      const documentAge=Number(window.performance&&window.performance.now&&window.performance.now());
      if(Number.isFinite(documentAge)&&documentAge<facebookAuthCredentialFillGraceMs){
        return authObservation('none',null,'credential_fill_pending');
      }
      return authObservation('manual_login_required',null,'credential_fill_unavailable');
    }
    const submit=authUnique(authButtons(form).filter((button)=>{
      const raw=label(button);
      return button.getAttribute('name')==='login'
        ||button.getAttribute('data-testid')==='royal_login_button'
        ||/^(log in|login|登录|登入)$/i.test(raw);
    }));
    if(!submit.candidate)return authObservation('blocked_unknown',null,submit.reason);
    return authObservation('login_submit_ready',submit.candidate);
  };
  const authTotpObservation=async(sampleServerTime=true)=>{
    const candidates=authTotpInputCandidates();
    if(candidates.length!==1){
      return candidates.length
        ?authObservation('blocked_unknown',null,'totp_input_ambiguous')
        :authObservation('none',null,'totp_input_hydrating');
    }
    const input=candidates[0];
    const value=String(input.value||'').trim();
    const serverTime=sampleServerTime?await authServerEpochMs():{status:'skipped'};
    if(serverTime.status==='retry'){
      return authObservation('none',null,'facebook_server_time_window_ambiguous');
    }
    if(serverTime.status==='unavailable'){
      return authObservation('blocked_unknown',null,'facebook_server_time_unavailable');
    }
    const serverEpochMs=serverTime.status==='ok'?serverTime.epochMs:null;
    const time=serverEpochMs===null?{}:{serverEpochMs};
    if(value===''){
      if(!authTopHit(input))return authObservation('blocked_unknown',null,'auth_target_not_topmost',time);
      return authObservation('totp_entry_ready',input,undefined,time);
    }
    if(!/^\d{6}$/.test(value)){
      if(!authTopHit(input))return authObservation('blocked_unknown',null,'auth_target_not_topmost',time);
      return authObservation('totp_refresh_required',input,undefined,time);
    }
    const start=Number(p.enteredTotpWindowStartUnixMs);
    const end=Number(p.enteredTotpWindowEndUnixMs);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end-start!==30000){
      if(!authTopHit(input))return authObservation('blocked_unknown',null,'auth_target_not_topmost',time);
      return authObservation('totp_refresh_required',input,'entered_totp_window_unavailable',time);
    }
    if(serverEpochMs!==null&&(serverEpochMs<start||serverEpochMs>=end||end-serverEpochMs<10000)){
      if(!authTopHit(input))return authObservation('blocked_unknown',null,'auth_target_not_topmost',time);
      return authObservation('totp_refresh_required',input,undefined,time);
    }
    const submit=authTotpSubmitTarget(input);
    if(!submit.candidate){
      return [
        'auth_target_not_found',
        'auth_target_not_visible',
        'auth_target_disabled',
      ].includes(submit.reason)
        ?authObservation('none',null,'totp_submit_hydrating',time)
        :authObservation('blocked_unknown',null,submit.reason,time);
    }
    return authObservation('totp_submit_ready',submit.candidate,undefined,time);
  };
  const authWarningObservation=async()=>{
    const warningPattern=/we suspect automated behavior on your account/i;
    if(!warningPattern.test(text(document.body,8000)))return null;
    const matchingScopes=all('[role="dialog"],[aria-modal="true"],main,[role="main"]')
      .filter(visible)
      .filter((scope)=>warningPattern.test(text(scope,5000)));
    const scopes=matchingScopes.filter((scope)=>
      !matchingScopes.some((nested)=>nested!==scope&&scope.contains(nested))
    );
    if(scopes.length===0)return authObservation('blocked_unknown',null,'automation_warning_scope_unavailable');
    if(scopes.length!==1)return authObservation('blocked_unknown',null,'automation_warning_scope_ambiguous');
    const dismiss=authUnique(authButtons(scopes[0]).filter((button)=>/^dismiss$/i.test(label(button))));
    return dismiss.candidate
      ?authObservation('automation_warning_dismiss',dismiss.candidate)
      :authObservation('blocked_unknown',null,dismiss.reason||'automation_warning_target_unavailable');
  };
  const authPushObservation=async()=>{
    const dialogs=all('[role="alertdialog"]').filter(visible).filter((dialog)=>
      /^push notifications request$/i.test(norm(dialog.getAttribute('aria-label'),128))
    );
    if(dialogs.length===0)return null;
    if(dialogs.length!==1)return authObservation('blocked_unknown',null,'push_blocker_ambiguous');
    const close=authUnique(authButtons(dialogs[0]).filter((button)=>/^close$/i.test(label(button))));
    return close.candidate
      ?authObservation('push_blocker_close',close.candidate)
      :authObservation('blocked_unknown',null,close.reason||'push_blocker_target_unavailable');
  };
  const authRememberObservation=async()=>{
    const dialogs=all('[role="dialog"],[aria-modal="true"]').filter(visible).filter((dialog)=>
      /(?:^|\s)remember password\??(?:\s|$)/i.test(text(dialog,3000))
    );
    if(dialogs.length===0)return null;
    if(dialogs.length!==1)return authObservation('blocked_unknown',null,'remember_password_ambiguous');
    const ok=authUnique(authButtons(dialogs[0]).filter((button)=>/^ok$/i.test(label(button))));
    return ok.candidate
      ?authObservation('remember_password_confirm',ok.candidate)
      :authObservation('blocked_unknown',null,ok.reason||'remember_password_target_unavailable');
  };
  const authProbeBase=async(sampleServerTime=true)=>{
    const blocking=blockingProbe();
    if(blocking.kind==='captcha'){
      return authObservation('blocked_human_verification',null,'human_verification_required');
    }
    const body=text(document.body,8000);
    if(/incorrect password|invalid password|code you entered is incorrect|invalid (?:login|security) code|密码不正确|验证码不正确|驗證碼不正確/i.test(body)){
      return authObservation('blocked_unknown',null,'facebook_auth_rejected');
    }
    if(
      /temporarily blocked|action blocked|we limit how often you can do this|misusing this feature|you can.?t use this feature right now|going too fast|this feature is( ?n.?t| not) available|your account is restricted|we restrict certain content and actions|暂时被限制|功能暂时不可用|此功能暂时无法使用|你暂时无法使用|操作被封锁/i.test(body)
      ||['我们限制了你发帖','我们限制了您发帖','执行其他操作的频率'].some((phrase)=>body.includes(phrase))
    ){
      return authObservation('blocked_unknown',null,'unsupported_facebook_auth_state');
    }
    const warning=await authWarningObservation();
    if(warning){
      if(
        warning.signal==='automation_warning_dismiss'
        &&Boolean(p.authenticated)
        &&!Boolean(p.allowAuthActions)
      )return authObservation('authenticated');
      return warning;
    }
    if(/\/checkpoint|\/recover|\/identify|\/login\/device-based|\/disabled/i.test(location.pathname)){
      return authObservation('blocked_unknown',null,'unsupported_facebook_checkpoint');
    }
    if(blocking.kind==='unknown'){
      return authObservation('blocked_unknown',null,'unsupported_facebook_auth_state');
    }
    const push=await authPushObservation();
    if(push){
      if(
        push.signal==='push_blocker_close'
        &&Boolean(p.authenticated)
        &&!Boolean(p.allowAuthActions)
      )return authObservation('authenticated');
      return push;
    }
    const remember=await authRememberObservation();
    if(remember){
      if(
        remember.signal==='remember_password_confirm'
        &&Boolean(p.authenticated)
        &&!Boolean(p.allowAuthActions)
      )return authObservation('authenticated');
      return remember;
    }
    if(authTotpContext())return authTotpObservation(sampleServerTime);
    const loginPath=/\/login\/?$|\/login\.php/i.test(location.pathname);
    const hasLoginForm=all('input[type="password"]').some(visible);
    if(loginPath||hasLoginForm)return authLoginObservation();
    if(blocking.kind==='login'){
      return authObservation('blocked_unknown',null,'unsupported_facebook_auth_state');
    }
    if(Boolean(p.authenticated))return authObservation('authenticated');
    return authObservation('none');
  };
  const authFocusGuard=async()=>{
    const input=authTotpInput();
    if(!input||(await authDocumentGeneration())!==String(p.documentGeneration||'')){
      return {kind:'text_target',value:{ok:false,focused:false}};
    }
    const candidateKey=await authDigest(authTotpElementEvidence(input));
    return {
      kind:'text_target',
      value:{
        ok:candidateKey===String(p.candidateKey||''),
        focused:document.activeElement===input,
      },
    };
  };
  const authTotpReadback=async()=>{
    const input=authTotpInput();
    if(!input||(await authDocumentGeneration())!==String(p.documentGeneration||'')){
      return {kind:'auth_totp_readback',value:{bound:false,empty:false,length:0,matches:false}};
    }
    const candidateKey=await authDigest(authTotpElementEvidence(input));
    const value=String(input.value||'');
    return {
      kind:'auth_totp_readback',
      value:{
        bound:candidateKey===String(p.candidateKey||''),
        empty:value.length===0,
        length:value.length,
        matches:typeof p.expectedCode==='string'&&value===p.expectedCode,
      },
    };
  };
  const authPostcondition=async()=>{
    const expectedDocument=String(p.documentGeneration||'');
    const expectedSignal=String(p.expectedSignal||'');
    const expectedCandidateKey=String(p.candidateKey||'');
    const documentChanged=(await authDocumentGeneration())!==expectedDocument;
    if(documentChanged){
      return {
        kind:'facebook_auth_postcondition',
        value:{satisfied:true,documentChanged:true,signalGone:false},
      };
    }
    let candidateKey=null;
    let determinate=true;
    if(expectedSignal==='login_submit_ready'){
      const forms=all('form').filter(visible).filter((form)=>{
        const emails=all('input[name="email"],input[type="email"],input#email',form).filter(visible);
        const passwords=all('input[name="pass"][type="password"],input[type="password"]',form).filter(visible);
        return emails.length>0||passwords.length>0;
      });
      if(forms.length>1){
        determinate=false;
      }else if(forms.length===1){
        const emails=all('input[name="email"],input[type="email"],input#email',forms[0]).filter(visible);
        const passwords=all('input[name="pass"][type="password"],input[type="password"]',forms[0]).filter(visible);
        if(emails.length!==1||passwords.length!==1){
          determinate=false;
        }else{
          const submit=authUnique(authButtons(forms[0]).filter((button)=>
            button.getAttribute('name')==='login'
            ||button.getAttribute('data-testid')==='royal_login_button'
            ||/^(log in|login|登录|登入)$/i.test(label(button))
          ));
          // A post-click loading cover keeps the old target structurally present. It is not
          // evidence that the signal disappeared, so let the bounded verifier poll again.
          if(submit.reason==='auth_target_ambiguous'||submit.reason==='auth_target_not_topmost')determinate=false;
          if(submit.candidate)candidateKey=await authDigest(authElementEvidence(submit.candidate));
        }
      }
    }else if(expectedSignal==='totp_submit_ready'){
      const inputs=authTotpInputCandidates();
      if(inputs.length>1){
        determinate=false;
      }else if(inputs.length===1){
        if(!/^\d{6}$/.test(String(inputs[0].value||'').trim())){
          determinate=false;
        }else{
          const submit=authTotpSubmitTarget(inputs[0]);
          const originalStillPresent=(await Promise.all(
            submit.inventory.map((candidate)=>authDigest(authTotpElementEvidence(candidate)))
          )).includes(expectedCandidateKey);
          if([
            'auth_target_ambiguous',
            'auth_target_not_topmost',
            'auth_target_out_of_scope',
            'auth_target_not_visible',
            'auth_target_disabled',
          ].includes(submit.reason))determinate=false;
          if(originalStillPresent){
            candidateKey=expectedCandidateKey;
          }else if(submit.candidate){
            candidateKey=await authDigest(authTotpElementEvidence(submit.candidate));
          }
        }
      }
    }else if([
      'automation_warning_dismiss',
      'push_blocker_close',
      'remember_password_confirm',
    ].includes(expectedSignal)){
      const current=expectedSignal==='automation_warning_dismiss'
        ?await authWarningObservation()
        :expectedSignal==='push_blocker_close'
          ?await authPushObservation()
          :await authRememberObservation();
      if(current&&current.signal==='blocked_unknown'){
        determinate=false;
      }else if(current&&current.signal===expectedSignal){
        candidateKey=current.candidate&&current.candidate.candidateKey||null;
      }
    }else{
      determinate=false;
    }
    const signalGone=determinate&&candidateKey!==expectedCandidateKey;
    return {
      kind:'facebook_auth_postcondition',
      value:{
        satisfied:signalGone,
        documentChanged:false,
        signalGone,
      },
    };
  };
