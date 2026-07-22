(()=>{
  const visible=(el)=>{
    if(!el||!el.getBoundingClientRect)return false;
    const r=el.getBoundingClientRect();
    const s=getComputedStyle(el);
    return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0.05;
  };
  for(const selector of [
    'textarea[name="aiSearchTextarea"]',
    'textarea[placeholder*="搜索"]',
    'textarea[placeholder*="search"]',
    'input[type="search"]',
    'input[placeholder*="搜索"]',
    'input[placeholder*="search"]'
  ]){
    const el=[...document.querySelectorAll(selector)].find(visible);
    if(el){
      const r=el.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};
    }
  }
  return null;
})()
