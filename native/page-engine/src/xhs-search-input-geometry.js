(mode=>{
  const visible=(el)=>{
    if(!el||!el.getBoundingClientRect)return false;
    const r=el.getBoundingClientRect();
    const s=getComputedStyle(el);
    return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0.05;
  };
  const selectors=[
    'textarea[name="aiSearchTextarea"]',
    'textarea#search-input',
    'textarea#search-input-in-feeds',
    '#search-input',
    '#search-input-in-feeds',
    'input#search-input',
    '.search-area-in-header textarea',
    '.search-box-in-content textarea',
    '[class*="search"] textarea',
    'input[placeholder*="搜索"]',
    'input[placeholder*="search"]',
    'input[type="search"]',
    '[class*="search"] input'
  ];
  let el=null;
  for(const selector of selectors){
    el=[...document.querySelectorAll(selector)].find(visible);
    if(el)break;
  }
  if(!el)return {found:false,focused:false,value:''};
  const r=el.getBoundingClientRect();
  if(mode==='geometry')return {found:true,x:r.left+r.width/2,y:r.top+r.height/2};
  el.scrollIntoView&&el.scrollIntoView({block:'center',inline:'center'});
  try{el.focus();}catch{}
  if(mode==='focus-clear'&&document.activeElement===el){
    try{
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const descriptor=Object.getOwnPropertyDescriptor(proto,'value');
      if(descriptor&&descriptor.set)descriptor.set.call(el,'');else el.value='';
      el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    }catch{}
  }
  return {
    found:true,
    focused:document.activeElement===el,
    value:String('value' in el?el.value:el.textContent||'')
  };
})
