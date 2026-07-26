  const identity=()=>{
    const cookieId=/^\d{5,}$/.test(String(p.cookieUserId||''))?String(p.cookieUserId):'';
    const anchors=all('a[href*="profile.php?id="],a[href*="/people/"],a[href="/me"],a[href^="/me/"]').map((anchor)=>{
      const href=String(anchor.href||anchor.getAttribute('href')||'');
      const id=(href.match(/[?&]id=(\d{5,})/)||href.match(/\/people\/[^/]+\/(\d{5,})/)||[])[1]||'';
      return {anchor,href,id};
    });
    const candidates=Array.from(new Set(anchors.map((item)=>item.id).filter(Boolean)));
    if(!cookieId&&candidates.length!==1)return {kind:'identity_receipt',value:{ok:false,reason:candidates.length?'facebook identity candidates conflict':'facebook stable numeric id candidate was not found'}};
    const accountId=cookieId||candidates[0];
    const own=anchors.find((item)=>item.id===accountId||/\/me\/?$/.test(new URL(item.href,location.origin).pathname));
    let displayName=own&&norm(own.anchor.getAttribute('aria-label')||text(own.anchor,200),200)||'';
    displayName=displayName.replace(/\s*(?:的大?头像|的大頭貼|的时间线|的時間線|['’‘]s\s+(?:profile picture|profile photo|avatar|timeline))\s*$/i,'').trim();
    if(/^(facebook|home|profile|your profile|首页|主页|个人主页|菜单)$/i.test(displayName))displayName='';
    return {kind:'identity_receipt',value:{ok:true,accountId,displayName:displayName||undefined,source:cookieId?'cookie':'profile-link'}};
  };
