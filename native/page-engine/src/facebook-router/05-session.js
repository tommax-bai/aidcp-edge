  const commentEditor=(root=document)=>root?all('[contenteditable="true"][role="textbox"],textarea[aria-label],textarea',root).filter(visible).find((el)=>{
    const raw=label(el).toLowerCase();
    return /评论|留言|comment|bình luận|coment|输入回答|answer/.test(raw)||el.getAttribute('role')==='textbox';
  })||null:null;
  const participationGate=()=>{
    const dialogs=all('[role="dialog"]').filter(visible);
    const expression=/申请参与|请求参与|参与此(?:小组|群)|贡献(?:内容)?给?(?:此|这个)?(?:小组|群)|参与问题|同意(?:此|该|小组|群).{0,4}规则|同意群规|request to participate|participation question|answer questions to participate|contribute to (?:this|the) group|agree to the group rules|待审核|pending review/i;
    return dialogs.some((dialog)=>expression.test(text(dialog,4000)));
  };
  // cookie 政策文案判据。既用于「页面上有没有同意条」，也用于界定按钮采集框——
  // 采集框必须由同意语义自身界定，不能由「是不是对话框」界定。
  const consentCookieCopy=/cookie\s*政策|cookie\s*policy|允许\s*facebook\s*使用\s*cookie|允许使用\s*cookie|使用\s*cookie|allow\s+the\s+use\s+of\s+cookies|use\s+of\s+cookies|allow\s+all\s+cookies|允许所有\s*cookie/i;
  const consentAcceptAllLabel=/^(允许所有\s*cookie|允许全部\s*cookie|接受所有\s*cookie|同意所有\s*cookie|允许\s*facebook\s*使用\s*cookie|允许使用\s*cookie|allow\s+all\s+cookies|accept\s+all\s+cookies|allow\s+the\s+use\s+of\s+cookies)$/i;
  const consentNecessaryOnlyLabel=/^(仅允许必要\s*cookie|只允许必要\s*cookie|仅接受必要\s*cookie|拒绝非必要\s*cookie|only\s+allow\s+essential\s+cookies|decline\s+optional\s+cookies|refuse\s+non-?essential\s+cookies)$/i;
  const consentProbe=()=>{
    const body=text(document.body,5000);
    const path=location.pathname.toLowerCase();
    const frames=all('iframe').map((frame)=>String(frame.getAttribute('src')||frame.src||'')).join('\n');
    const captcha=/captcha|recaptcha|fbsbx\.com\/captcha/i.test(frames)
      ||/进行人机身份验证|人机身份验证|captcha|recaptcha|prove you(?:'|’)re human|confirm you(?:'|’)re human|verify you(?:'|’)re human/i.test(body);
    const loginPath=/\/login|\/recover|\/two_step_verification/i.test(path);
    const cookieCopy=consentCookieCopy.test(body);
    // 只有**自身文本命中 cookie 文案**的可见容器才配当采集框；否则在整个 document 上采集。
    // 真实同意条常是非对话框的底部横幅，而首页常年挂着与同意无关的良性对话框（聊天弹窗 / 加载浮层）——
    // 按「首个可见对话框」收窄会让两个点位永远采不到，于是「有同意条但按钮都是空」，
    // 评论 / 点赞 / 发帖 / 加群 / 滚动 / 刷新会被同一条阻断结论全部误杀。
    const scope=all('[role="dialog"],[aria-modal="true"]').filter(visible)
      .find((container)=>consentCookieCopy.test(text(container,5000)))||document;
    const buttons=all('button,[role="button"],a[role="button"],div[aria-label],span[aria-label]',scope).filter(visible);
    const acceptAll=buttons.filter((el)=>consentAcceptAllLabel.test(label(el)));
    const necessaryOnly=buttons.filter((el)=>consentNecessaryOnlyLabel.test(label(el)));
    // 存在性判定的第四条合取项：至少有一个可点的接受按钮。缺了它，
    // 「cookie 文案在页但按钮词表全 miss」会被判成同意条阻断而不是放行；
    // 同时带 cookie 文案的登录墙也会因 present 假真而拿不到 login_required。
    const present=cookieCopy&&(acceptAll.length>0||necessaryOnly.length>0)&&!captcha&&!loginPath;
    return {
      present,
      acceptAll:present&&acceptAll.length===1?point(acceptAll[0]):null,
      necessaryOnly:present&&necessaryOnly.length===1?point(necessaryOnly[0]):null,
      acceptAllAmbiguous:acceptAll.length>1,
      necessaryOnlyAmbiguous:necessaryOnly.length>1,
    };
  };
  const blockingProbe=()=>{
    const body=text(document.body,5000);
    const bodyLower=body.toLowerCase();
    const href=String(location.href).toLowerCase();
    const frames=all('iframe').map((frame)=>String(frame.getAttribute('src')||frame.src||'')).join('\n').toLowerCase();
    if(
      frames.includes('fbsbx.com/captcha')
      ||frames.includes('google.com/recaptcha')
      ||/进行人机身份验证|人机身份验证|captcha|recaptcha|prove you(?:'|’)re human|confirm you(?:'|’)re human|verify you(?:'|’)re human/i.test(body)
    )return {kind:'captcha',text:body};
    const consent=consentProbe();
    if(
      href.includes('/login')
      ||href.includes('/recover')
      ||href.includes('/two_step_verification')
      ||(!consent.present&&/登录 facebook|登录或注册|log in to facebook|forgot password|account recovery|账号恢复|找回账号/i.test(body))
    )return {kind:'login',text:body};
    if(href.includes('/checkpoint')||/security check|security checkpoint|安全检查|安全验证/i.test(body)){
      return {kind:'unknown',text:body};
    }
    if(
      href.includes('/help/contact')
      ||/temporarily blocked|action blocked|we limit how often you can do this|misusing this feature|you can.?t use this feature right now|going too fast|this feature is( ?n.?t| not) available|your account is restricted|we restrict certain content and actions|暂时被限制|功能暂时不可用|此功能暂时无法使用|你暂时无法使用|操作被封锁/i.test(bodyLower)
      ||['我们限制了你发帖','我们限制了您发帖','执行其他操作的频率'].some((phrase)=>body.includes(phrase))
    )return {kind:'unknown',text:body};
    return {kind:'none',text:''};
  };
  const blocker=(probe)=>{
    if(probe.kind==='login')return 'login_required';
    if(probe.kind==='captcha')return 'blocked_by_captcha';
    if(probe.kind==='unknown')return 'blocked_by_unknown';
    return '';
  };
