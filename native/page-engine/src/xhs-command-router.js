async function(input){
  'use strict';
  const kind=String(input.kind||'');
  const p=input.params&&typeof input.params==='object'?input.params:{};
  const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
  // 截断按 code point，不按 UTF-16：按 UTF-16 切会在 emoji 的代理对中间劈开，
  // 留下半个字符（下游渲染成乱码）。
  const clip=(raw,n)=>{
    if(raw.length<=n)return raw;
    const points=Array.from(raw);
    return points.length>n?points.slice(0,n).join(''):raw;
  };
  const norm=(v,n=2000)=>clip(String(v??'').replace(/\s+/g,' ').trim(),n);
  // 字段级截断：超长时补一个可见的省略号，让「被截断了」这件事在下游看得见。
  const cut=(value,n)=>{
    const raw=String(value??'');
    const kept=clip(raw,n);
    return kept===raw?raw:kept+'…';
  };
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
  // ── 「已生效」三态判据（共享扇出点）──────────────────────────────────────
  // 旧实现是一条裸子串正则：类名里出现 active / selected / liked / collected / followed
  // 任一**片段**即判已生效。两个后果：① `not-selected` / `unliked` 这类**否定形**被读成正证据；
  // ② 「读不到状态」与「读到未生效」被压成同一个 false —— 期望值为「关」时于是变成
  // 「没有任何证据也算达成」。现在恒回三态：'on' 明确已生效 / 'off' 明确未生效 / '' 读不到。
  // **'' MUST NOT 塌成 'off'**：读不到时该点还是该诚实回未确认，由各调用点自己判，不在这里替它决定。
  const STATE_FRAGMENTS=['active','selected','liked','collected','followed','checked'];
  // 否定形前缀：`not-selected` / `de-selected` 这类带分隔符的，以及 `unliked` / `inactive`
  // 这类直接粘连的，都是**反证据**，绝不是正证据。
  const NEGATION_SEGMENTS=['not','non','no','un','in','de','dis','off','cancel','remove','clear'];
  // 计数 / 标签容器：`liked-count`、`collected-num` 说的是「多少人赞过」，不是「我赞过」。
  const COUNTER_SEGMENTS=['count','counter','cnt','num','number','total','sum','label','text'];
  // 中文否定：文本回显类证据里，「不公开」含「公开」、「取消关注」含「关注」——
  // 裸 includes 会把反证据读成正证据，所以文本证据要看紧挨着的前缀。
  const NEGATION_TEXT=['不','非','未','无','否','取消','关闭'];
  // 语义类名判据：片段须是完整的 class token，或被连字符 / 下划线包裹（容忍 BEM 与前缀），
  // 绝不做子串匹配——混淆构建里随便一个随机串都可能偶然含 active。
  const classStateOf=(el)=>{
    const raw=el&&el.getAttribute&&el.getAttribute('class');
    if(!raw||typeof raw!=='string')return '';
    let negative='';
    for(const token of raw.toLowerCase().split(/\s+/)){
      if(!token)continue;
      const parts=token.split(/[-_]+/).filter(Boolean);
      for(let i=0;i<parts.length;i++){
        const part=parts[i];
        // `unliked` / `inactive`：前缀直接粘在片段上，是明确的未生效。
        if(NEGATION_SEGMENTS.some((prefix)=>part.startsWith(prefix)&&STATE_FRAGMENTS.includes(part.slice(prefix.length)))){negative='off';continue;}
        if(!STATE_FRAGMENTS.includes(part))continue;
        // `liked-count`：计数容器，与自身状态无关，读不到就是读不到。
        if(COUNTER_SEGMENTS.includes(parts[i+1]||''))continue;
        // `not-selected`：分隔符形态的否定，同样是未生效。
        if(NEGATION_SEGMENTS.includes(parts[i-1]||'')){negative='off';continue;}
        return 'on';
      }
    }
    return negative;
  };
  // 属性白名单：这些属性一旦**出现**就是两态可读的——等于真值即 'on'，其余取值即 'off'。
  const STATE_ATTRS=[['aria-pressed',['true']],['aria-checked',['true']],['aria-selected',['true']],['aria-current',['true','page']],['data-active',['true']],['data-selected',['true']],['data-cover',['true']]];
  const SWITCH_SELECTOR='input[type="checkbox"],input[type="radio"],[role="switch"],[role="checkbox"]';
  const stateOf=(el)=>{
    if(!el||!el.getAttribute)return '';
    // ① 真表单控件的选中位最权威（其余 input 的 checked 恒为 false，不能当状态读）。
    if(el.tagName==='INPUT'&&/^(checkbox|radio)$/i.test(String(el.type||'')))return el.checked?'on':'off';
    // ② 无障碍 / 站点稳定属性。
    let attrState='';
    for(const [name,truthy] of STATE_ATTRS){
      const raw=el.getAttribute(name);
      if(raw===null||raw===undefined)continue;
      if(truthy.includes(String(raw)))return 'on';
      attrState='off';
    }
    if(attrState)return attrState;
    // ③ 语义类名：最弱的一层，读不到就如实回读不到。
    return classStateOf(el);
  };
  // 薄布尔包装，给不需要区分「读不到」的调用点用：**只有明确 'on' 才算已生效**。
  const selected=(el)=>stateOf(el)==='on';
  // 有界祖先回溯：状态 / 回显常落在包裹容器上，但「往上找」必须有界且只认真正的行 / 项容器
  // ——停在任意 div 上就等于把「这块区域看起来是激活态」当成「我这次操作生效了」。
  // `exclude` 用来挡自证：把自己刚点的候选项圈进来的容器，它的文本恒含目标值，不是证据。
  const rowOf=(el,selectors,levels=3,exclude)=>{
    let node=el&&el.parentElement;
    for(let i=0;node&&i<levels;i++){
      if(exclude&&node.contains&&node.contains(exclude))return null;
      if(selectors.some((selector)=>node.matches&&node.matches(selector)))return node;
      node=node.parentElement;
    }
    return null;
  };
  // 文本回显证据：目标值出现在容器文本里才算，但紧挨着的中文否定前缀一律排除。
  const echoes=(haystack,needle)=>{
    const value=norm(needle,1000);
    if(!value)return false;
    const body=norm(haystack,4000);
    for(let at=body.indexOf(value);at>=0;at=body.indexOf(value,at+1)){
      const before=body.slice(Math.max(0,at-2),at);
      if(!NEGATION_TEXT.some((word)=>before.endsWith(word)))return true;
    }
    return false;
  };
  // 互动栏（详情页里赞 / 收藏 / 评论那一条）。它常比笔记本体晚一拍渲染（总结流式重排 / 卡片回收），
  // 定位前有界等一等，避免在渲染完成前误报「找不到互动栏」。
  const ENGAGE_BAR_SELECTORS=['.interactions.engage-bar','.engage-bar','[class*="engage-bar"]'];
  // 图标状态位：赞 / 收藏的当下状态写在 <svg><use xlink:href="#like|#liked"> 上，不在文案里。
  const iconState=(el)=>{
    if(!el||!el.querySelectorAll)return '';
    return Array.from(el.querySelectorAll('use')).map((use)=>String(use.getAttribute('xlink:href')||use.getAttribute('href')||'')).join(' ');
  };
  // 关注按钮的两种上下文：笔记浮层作者区、作者主页；裸 .follow-button 兜底两者。
  const FOLLOW_SELECTORS=['.note-detail-mask .author-wrapper .follow-button','.author-wrapper .follow-button','.user-info .follow-button','.user-page .follow-button','[class*="author"] [class*="follow-button"]','button.follow-button','.follow-button'];
  const followedState=(el)=>{
    if(!el)return false;
    if(el.getAttribute('aria-pressed')==='true')return true;
    return /已关注|互相关注|互关|following/i.test(text(el,64));
  };
  // 真可编辑判据：`dispatchInput` 对非受控元素直接改 textContent，写进普通 div 之后再回读
  // 必然「一致」——那是自证，不是证据。只有受控框与 contenteditable 才有回读价值。
  const editable=(el)=>{
    if(!el)return false;
    if('value' in el)return true;
    if(el.isContentEditable===true)return true;
    const flag=el.getAttribute&&el.getAttribute('contenteditable');
    return typeof flag==='string'&&/^(|true|plaintext-only)$/i.test(flag);
  };
  // v1 兼容步骤的重试上限。「这一次没确认」与「连续失败到顶、判平台系统性改版」必须可区分，
  // 而可区分的前提是真的重试过——回报的 attempts 得是实测次数，不是硬写的 1。
  const COMPAT_MAX_ATTEMPTS=3;
  // v1 兼容步骤的后置判据：与主路径同源的硬判据，而不是宽松类名激活态。
  // 赞 / 收藏读图标状态位（翻转可能落在包裹容器上，故做有限层级回溯）；关注读关注态文案 / 按下态；
  // 评论输入框的业务结果是「它拿到了焦点」——旧实现在这一支上无条件回成功，点不着也报 ok。
  const compatVerifier=(actionId)=>{
    // 图标状态位可能挂在被点元素的父层（点中的常是文案 span，图标在同级）：有界回溯两层。
    // 回溯只对图标这条硬信号开——文案类判据一往上走就会把邻居的文字一起收进来，越走越假。
    const iconVerifier=(on)=>(el)=>{
      let node=el;
      for(let i=0;node&&i<=2;i++){
        if(iconState(node).includes(on))return true;
        if(node.getAttribute&&node.getAttribute('aria-pressed')==='true')return true;
        node=node.parentElement;
      }
      return false;
    };
    if(actionId==='note.like_button')return iconVerifier('liked');
    if(actionId==='note.collect_button')return iconVerifier('collected');
    if(actionId==='note.follow_button')return (el)=>followedState(el);
    if(actionId==='note.comment_input')return (el)=>Boolean(el)&&document.activeElement===el;
    return (el)=>selected(el);
  };
  const action=(name,ok,reason,extra={})=>({kind:'action_receipt',value:{action:name,ok,...(reason?{reason}:{}),...extra}});
  // 回执 + 随行观测：一条命令只能回一个输出，但有的终局既要让云端动作角色结案，
  // 又必须把本次真看到的东西一并送到（翻页新图 / 分类栏通知条目）。二选一都会静默丢掉另一半。
  const observed=(receipt,observation)=>({kind:'action_receipt_with_observation',value:{receipt:receipt.value,...(observation||{})}});
  const done=(output,effectPhase='confirmed')=>({effectPhase,output});
  // 有界轮询：在窗口内反复复采，命中即返回（快路径省时），超时返回 false。
  // 取代「固定睡一觉后单次采样」——那种采样点常落在状态翻转窗口正中间，把已生效的动作误报为未生效。
  const waitFor=async(check,timeoutMs=1500,stepMs=60)=>{
    const deadline=Date.now()+Math.max(0,Number(timeoutMs)||0);
    for(;;){
      let hit=false;
      try{hit=Boolean(check());}catch{hit=false;}
      if(hit)return true;
      if(Date.now()>=deadline)return false;
      await sleep(stepMs);
    }
  };
  // ── 发布定时真态 ──────────────────────────────────────────────────────────
  // 「定时发布」同时会出现在设置行标签和最终提交按钮上。设置行只从非提交控件中找，
  // 再要求同一有界行里确有可读开关；提交按钮则反过来只认真正的 button / role=button / a 叶子。
  // 两者绝不共用 findByWords：全页文本回落会把标签当按钮，或者把按钮当开关。
  const scheduleContext=()=>{
    const labels=all('label,span,p,div').filter(visible).filter((el)=>{
      if(el.closest&&el.closest('button,[role="button"],a'))return false;
      return /^定时发布(?:[:：])?$/.test(text(el,32).replace(/\s+/g,''));
    });
    const controlSelectors=[SWITCH_SELECTOR,'[class*="switch-simulator" i]','[class*="checkbox" i]'];
    for(const label of labels){
      const roots=[];
      const scoped=label.closest&&label.closest('[class*="post-time-wrapper" i],[class*="custom-switch-wrapper" i],[class*="form" i],[class*="item" i],[class*="row" i]');
      if(scoped)roots.push(scoped);
      if(label.parentElement)roots.push(label.parentElement);
      if(label.parentElement&&label.parentElement.parentElement)roots.push(label.parentElement.parentElement);
      for(const root of roots){
        const controls=[];
        if(root.matches&&controlSelectors.some((selector)=>root.matches(selector))&&visible(root))controls.push(root);
        controls.push(...controlSelectors.flatMap((selector)=>all(selector,root).filter(visible)));
        const control=controls.find((candidate)=>Boolean(stateOf(candidate)))||controls[0]||null;
        if(!control)continue;
        const fields=all('input',root).filter((candidate)=>visible(candidate)&&!/^(checkbox|radio)$/i.test(String(candidate.type||'')));
        const field=fields.find((candidate)=>/时间|日期|date|time/i.test(String(candidate.placeholder||'')+' '+String(candidate.getAttribute('aria-label')||'')+' '+String(candidate.type||'')))||fields[0]||null;
        return {label,root,control,field};
      }
    }
    return {label:labels[0]||null,root:null,control:null,field:null};
  };
  const scheduleMinute=(field)=>String(field&&('value' in field?field.value:field.getAttribute&&field.getAttribute('value'))||'').trim().replace('T',' ').slice(0,16);
  const beijingMinute=(epoch)=>{
    const date=new Date(Number(epoch));
    if(!Number.isFinite(date.getTime()))return '';
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
    const part=(kind)=>parts.find((entry)=>entry.type===kind)?.value||'';
    const value=part('year')+'-'+part('month')+'-'+part('day')+' '+part('hour')+':'+part('minute');
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)?value:'';
  };
  const submitLeaves=(label)=>{
    const candidates=all('button,[role="button"],a').filter(visible)
      .filter((el)=>text(el,32)===label&&!/暂存|离开|草稿/.test(text(el,32)));
    return candidates.filter((el)=>!candidates.some((other)=>other!==el&&el.contains&&el.contains(other)));
  };
  const engageBar=async(root)=>{
    const pick=()=>first(ENGAGE_BAR_SELECTORS,root);
    const early=pick();
    if(early)return early;
    await waitFor(()=>Boolean(pick()),1200,80);
    return pick();
  };
  const fail=(name,reason)=>done(action(name,false,reason),'not_started');
  const ambiguous=(name,reason)=>done(action(name,false,reason),'ambiguous');
  // 编辑器读写口径：受控框读 value，contenteditable 读文本节点（与 dispatchInput 的两条分支一一对应）。
  const readEditor=(el)=>'value' in el?String(el.value||''):String((el&&(el.innerText||el.textContent))||'');
  // 清场闸：输入是在光标处追加，上一次留下的残文不清干净就会与本条拼在一起发出去。
  const clearEditor=(el)=>{dispatchInput(el,'');return norm(readEditor(el),32000)==='';};
  // 分段写入：正文一段、联系方式串码另起一段，各自整段写入（段界保留，便于后续换成逐字/整段插入两条通道）。
  const appendEditor=(el,segment)=>{dispatchInput(el,readEditor(el)+segment);};
  // 按 code point 切块：按 UTF-16 切会把代理对劈成两半（emoji 变问号）。
  const chunksOf=(value,size)=>{const points=Array.from(String(value||''));const parts=[];for(let i=0;i<points.length;i+=size)parts.push(points.slice(i,i+size).join(''));return parts;};
  const pressEnter=(el)=>{
    if(el.focus)el.focus();
    for(const type of ['keydown','keypress','keyup'])el.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,composed:true}));
  };
  // 光标归尾：后续内容都在光标处继续写，光标停在中间会把话题 / @ 插进正文里。
  const cursorToEnd=(el)=>{
    try{
      if('value' in el&&typeof el.setSelectionRange==='function'){const end=String(el.value||'').length;el.setSelectionRange(end,end);return;}
      const selection=window.getSelection&&window.getSelection();
      if(!selection||!document.createRange)return;
      const range=document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }catch{}
  };
  // 相似度（字符二元组 Dice 系数，线性开销）：编辑器的空白规整 / 全半角替换是无害改写，
  // 严格等值会把它们误杀；但内容缺失会显著拉低系数，阈值仍拦得住「只写进去一半」。
  const similarity=(a,b)=>{
    if(a===b)return 1;
    if(!a||!b)return 0;
    const grams=(value)=>{const map=new Map();for(let i=0;i<value.length-1;i++){const gram=value.slice(i,i+2);map.set(gram,(map.get(gram)||0)+1);}return map;};
    const left=grams(a);const right=grams(b);
    let shared=0;let total=0;
    for(const [gram,n] of left){total+=n;shared+=Math.min(n,right.get(gram)||0);}
    for(const [,n] of right)total+=n;
    return total?2*shared/total:0;
  };
  // 笔记级访问限制 / 错误页判据：容器机械信号（与页型分类 PageKind::Error 同一组类名）+ 退役实现的词库。
  // 错误页地址同样是 /explore/<id>，所以「地址里解析得出笔记 id」永远不能当成打开成功。
  const ERROR_PAGE_SELECTOR='[class*="not-found"],[class*="notFound"],[class*="error-page"],[class*="errorPage"]';
  const ACCESS_LIMIT_PHRASES=['当前笔记暂时无法浏览','请打开小红书App扫码查看','小红书如何扫码'];
  const noteUnavailable=(root)=>{
    if(all(ERROR_PAGE_SELECTOR).some(visible))return true;
    const scope=root&&root!==document?root:(document.body||document);
    const body=text(scope,6000);
    return ACCESS_LIMIT_PHRASES.some((phrase)=>body.includes(phrase));
  };

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
    // swiper loop 会复制首尾图片，复制片不是真图——上报它等于把同一张图重复灌给云端参考图。
    const images=all('img',root).filter((img)=>visible(img)&&!(img.closest&&img.closest('.swiper-slide-duplicate'))).map((img,index)=>({
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
      // 与关注动作逐字镜像同一套具名候选与判定：对「会被判已关注」的同一元素返回 true，
      // 会去点击（未关注）的返回 false；读不到按钮也返回 false，让云端回退主页评估流程。
      authorFollowed:followedState(first(FOLLOW_SELECTORS,root)||first(FOLLOW_SELECTORS)),
      // 诚实置空：仅当地址栏确含访问令牌时才作为真实可点链接上报，否则不带——绝不用打不开的裸链充数。
      url:String(location.href).includes('xsec_token=')?String(location.href).slice(0,4096):undefined,images,comments,
    }};
  };
  // 正面详情证据：详情容器存在 + 标题 / 正文 / 图片至少一项非空。三项皆空 = 空壳，不算打开成功。
  const confirmedDetail=()=>{
    const root=detailRoot();
    if(!root||noteUnavailable(root))return null;
    const output=detail();
    const value=output.value;
    return value.title||value.content||(value.images&&value.images.length)?output:null;
  };
  const profile=()=>{
    const id=(location.pathname.match(/\/user\/profile\/([A-Za-z0-9]+)/)||[])[1]||norm(p.authorId||'',256);
    const nickname=first(['[class*="user-name"]','[class*="nickname"]','h1']);
    const stats=all('[class*="data"],[class*="count"],[class*="info"] span').filter(visible).map((el)=>text(el,80));
    return {kind:'profile_detail',value:{authorId:id,postsCount:count(stats[0]),followersCount:count(stats[1]),likesCollects:count(stats[2]),extracted:Boolean(id),nickname:text(nickname,200)||undefined,url:String(location.href).slice(0,4096)}};
  };
  // 通知行的两级容器结构（分类内容区 > 行容器）出自真机 dump。
  // 不再按模糊 class 猜 + 收纳裸 <li>：那会把头像行、侧栏菜单项一起当成通知行。
  const notificationRows=()=>all('.tabs-content-container > .container,.tabs-content-container > div > .container,[class*="tabs-content"] > [class*="container"]').filter(visible);
  const notificationItems=(expected)=>{
    const items=[];
    for(const row of notificationRows()){
      const author=first(['.user-info a[href*="/user/profile/"]','[class*="user-info"] a','a[href*="/user/profile/"]:not([class*="avatar"])'],row);
      const href=author&&author.href||'';
      // 字段级上限（昵称 40 / 正文 200 / 笔记标题 80），不再统一走整行 blob 量级。
      const fromUser=cut(text(author,400),40);
      const fromUserId=(href.match(/\/user\/profile\/([A-Za-z0-9]+)/)||[])[1]||undefined;
      // 正文只取正文容器：缺失就发空串。回落成整行文本会把「昵称 + 动作标签 + 时间」
      // 一起当正文送出去，还会把时间灌进云端的回退去重键、使同一条通知每次都算新的。
      const content=cut(text(first(['.interaction-content','[class*="interaction-content"]'],row),4000),200);
      const raw=text(row,2200);
      // 赞和收藏是同一栏两类：按行内动作文案区分，别一栏之内全标成赞。
      const kindGuess=expected==='like'
        ?(/收藏/.test(raw)?'collect':'like')
        :(expected||(/关注/.test(raw)?'follow':/收藏/.test(raw)?'collect':/赞/.test(raw)?'like':/提到|@/.test(raw)?'mention':'comment'));
      // 无逐条身份的互动行诚实跳过：昵称与主页 ID 都拿不到就没有联系人可言，
      // 造一个占位昵称出来会被云端当成真实身份写进名册、还参与去重键。
      if(kindGuess!=='comment'&&kindGuess!=='mention'&&!fromUser&&!fromUserId)continue;
      // 去重键必须逐条稳定：绝不用发送者主页链——同一个人的多条通知会被折叠成一条丢掉。
      // 拿不到逐条身份就留空，让云端走它自己的回退口径，而不是在这里造一个假的稳定键。
      const noteLink=first(['a[href*="/explore/"]','a[href*="/discovery/item/"]'],row);
      const itemKey=norm(row.getAttribute('note-id')||row.getAttribute('data-note-id')||row.getAttribute('data-id')||noteIdFrom(noteLink&&noteLink.href||''),256);
      items.push({kind:kindGuess,fromUser,fromUserId,content,noteTitle:cut(text(first(['[class*="note-title"]','[class*="title"]'],row),400),80)||undefined,itemKey:itemKey||undefined});
      if(items.length>=100)break;
    }
    // 批次序号不在这里造：墙钟毫秒每条上报都不同，同一波未读的多次上报因此关联不上。
    // 唯一合法来源是未读「无→有」翻转时取的单调序号，归未读监测体。
    return {kind:'notification_items',value:{items}};
  };
  // 分类栏是真机标定的叶子节点（class 含 tab-item）。包裹容器（tab 列表 / 吸顶条 / 内容区）
  // 同样带 tab 字样，它的拼接文本会把一类的角标数字泄漏给另一类，点它更等于没切栏。
  const LEAF_TAB_SELECTOR='[class*="tab-item"]';
  const leafTabs=()=>all(LEAF_TAB_SELECTOR).filter((el)=>visible(el)&&!el.querySelector(LEAF_TAB_SELECTOR));
  // 严格文本判据（长度上限用于容纳角标数字），不做全页三级文本回落：
  // 页面上任何含「赞 / 关注 / 评论」的按钮、笔记卡片、侧栏项都不该被当成分类栏。
  const TAB_MATCHERS={
    comment:(value)=>value==='评论和@'||(value.indexOf('评论')===0&&value.indexOf('@')>=0)||(value.length<=24&&/^(comments?|mentions?)\b/i.test(value)),
    like:(value)=>(value.length<=8&&/赞|收藏/.test(value))||(value.length<=24&&/^(likes?|collect(s|ions?)?)\b/i.test(value)),
    follow:(value)=>(value.length<=8&&/关注/.test(value))||(value.length<=24&&/^(follow(s|ers|ing)?|new followers?)\b/i.test(value)),
  };
  const notificationTab=(category)=>{
    const match=TAB_MATCHERS[category];
    return leafTabs().find((el)=>match(text(el,64)))||null;
  };
  // 每类的未读角标只认该叶子分类栏内部的「纯数字叶子」（1–3 位）。
  // 整页正文正则会把笔记赞数 / 粉丝数 / 页面 chrome 里的计数当成未读；
  // 带单位的「1.2万」不是条数，不折算；读不到就是 0，绝不「解析不出就当 1」。
  const tabBadgeCount=(tab)=>{
    if(!tab)return 0;
    for(const leaf of all('*',tab)){
      if(leaf.childElementCount>0||!visible(leaf))continue;
      const raw=text(leaf,16);
      if(/^[0-9]{1,3}$/.test(raw))return Number(raw);
    }
    return 0;
  };
  const notificationHome=()=>({kind:'notification_home',value:{
    comments:tabBadgeCount(notificationTab('comment')),
    likes:tabBadgeCount(notificationTab('like')),
    follows:tabBadgeCount(notificationTab('follow')),
  }});
  // 清零循环：滚到底 / 直到不再出新行（连续 2 轮行数不增即判到底），硬上限取
  // max(云端下发的滚动预算, 12) 轮作有界兜底。固定滚几屏在未读多于一屏时会留下未清项，
  // 破坏「清零」前提；而云端下发的预算必须真参与上限，否则它就是个没人读的悬空参数。
  const sweepNotificationList=async()=>{
    const bound=Math.min(100,Math.max(12,Math.floor(Number(p.scrollMax)||0)));
    const scroller=first(['.tabs-content-container','[class*="tabs-content"]']);
    const step=Math.max(320,Math.round((Number(window.innerHeight)||Number(innerHeight)||800)*0.8));
    const scrollOnce=()=>{
      if(scroller&&typeof scroller.scrollBy==='function'&&scroller.scrollHeight>scroller.clientHeight){scroller.scrollBy(0,step);return;}
      window.scrollBy(0,step);
    };
    let previous=notificationRows().length;
    let stable=0;
    for(let round=0;round<bound;round++){
      scrollOnce();
      // 每轮留出加载等待，但一出新行就立刻进入下一轮（不做固定睡眠空等）。
      await waitFor(()=>notificationRows().length>previous,600,60);
      const now=notificationRows().length;
      if(now>previous){previous=now;stable=0;continue;}
      stable+=1;
      if(stable>=2)break;
    }
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
  // 刷新的业务结果是**feed 换了一批**，不是「刷新按钮被点了一下」（缺口登记 E13）。
  // 原实现点完睡 900ms 直接回当前卡片，三种情况一律兑现成成功：文字匹配点到别的元素、
  // 点着了但没重载、重载了但内容没变。后果不是报错而是**浏览闭环空转且看不出来** ——
  // 上游以为换了新批，于是重复读同一批、按新批扣预算，日志里每一条都是成功。
  // 判据取批次首部的 id 序列（`cards()` 本就带 noteId）：点前记基线、点后有界轮询等它变。
  if(kind==='feed_refresh'){
    // 首部足够定批：整表比对会被尾部懒加载追加的卡片搅成「变了」，而那与「回顶换新批」无关。
    const BATCH_HEAD=5;
    const batchHead=()=>cards().value.cards.slice(0,BATCH_HEAD).map((card)=>card.noteId||'').join('|');
    const before=batchHead();
    const refresh=findByWords(['刷新','refresh']);
    if(!refresh)return fail('refresh','refresh_control_not_found');
    if(!click(refresh))return fail('refresh','refresh_control_not_actuated');
    // 有界轮询而不是固定睡一觉：睡太短会把还在加载的新批读成「没换」，睡太长纯浪费。
    const changed=await waitFor(()=>{const now=batchHead();return Boolean(now)&&now!==before;},3000,150);
    if(!changed){
      const now=batchHead();
      // 三态分开：读不到卡片（探针瞎了 / 页面没渲染出来）与「读到了、还是原来那批」不是一回事。
      // 前者是「不知道」，后者是「确实没换」，压成一态会让上游没法分辨该重试还是该停手。
      // 两者都 MUST NOT 回成功 —— 平台真的没有新内容时，「没有新批」就是实话。
      return ambiguous('refresh',now?'refresh_batch_unchanged':'refresh_cards_unreadable');
    }
    return done(cards());
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
    for(const filter of filters){
      const opener=findByWords(['筛选','filter']);
      if(!opener)return fail('search','search_filter_control_not_found');
      click(opener);
      await sleep(200);
      const locate=()=>findByWords(filter.words);
      const target=locate();
      if(!target)return fail('search','search_filter_value_not_found');
      // 「读不到状态」MUST NOT 当成已选中而跳过点击：旧判据一旦假阳性就连点都不点，
      // 却把**未筛选**的结果当成筛过的返回（云端据此选评论目标，日志里看不出任何降级痕迹）。
      // 只有明确读到 'on' 才允许跳过点击。
      if(!selected(target)&&!click(target))return ambiguous('search','search_filter_unconfirmed');
      // 有界轮询等选中态翻转，每轮重解析目标（筛选面板常整体重渲染，旧引用会停在被替换掉的节点上）。
      if(!(await waitFor(()=>selected(locate()),1200,60)))return ambiguous('search','search_filter_unconfirmed');
    }
    return done(cards());
  }
  if(kind==='note_open'){
    // ① 幂等早退（已有详情容器，或地址就是被点名的那条笔记）：同样要过正面详情证据这一关，
    // 否则停在错误页 / 空壳页时会被当成「已在目标笔记」直接回详情——而详情上报即云端浏览计数。
    if((detailRoot()||(p.noteId&&noteIdFrom(location.href)===p.noteId))&&exactNote()){
      if(noteUnavailable(detailRoot()))return fail('open_note','note_unavailable');
      const already=confirmedDetail();
      return already?done(already):ambiguous('open_note','detail_evidence_missing');
    }
    if(p.surface==='feed')return fail('open_note','capability_unsupported');
    const candidates=cardNodes();
    const hit=p.noteId?candidates.find((node)=>noteIdFrom((node.matches('a')?node:first(['a[href]'],node)||{}).href)===p.noteId):candidates[Number(p.index)||0];
    if(!hit)return fail('open_note','target_not_found');
    click(hit.matches('a')?hit:(first(['a[href]'],hit)||hit));await sleep(900);
    // ② 点击后的判据同样只认正面证据：错误页语义命中即诚实失败，未确认打开一律不产出 note_detail。
    if(noteUnavailable(detailRoot()))return ambiguous('open_note','note_unavailable');
    if(!detailRoot())return ambiguous('open_note','detail_not_confirmed');
    const opened=confirmedDetail();
    return opened?done(opened):ambiguous('open_note','detail_evidence_missing');
  }
  if(kind==='note_close'){
    const root=detailRoot();if(!root)return fail('close','detail_not_open');
    const close=first(['[class*="close"]','button[aria-label*="关闭"]','button[title*="关闭"]'],root)||findByWords(['关闭','close'],root);
    if(!close)return fail('close','close_control_not_found');
    click(close);await sleep(350);return detailRoot()?ambiguous('close','detail_still_open'):done(action('close',true));
  }
  if(kind==='navigation_back'){
    // 「返回」的语义是回到来源列表并确认列表真可用，不是按浏览器后退键
    // （后退会回踩过期的详情路由并触发平台的访问限制弹窗）。
    // 严格的 feed 判据：`/explore` 本身算列表，`/explore/<笔记 id>` 是详情页，不算
    // ——松判据会把详情页当 feed，扫不到卡后边云互等。
    const onListUrl=()=>/^\/explore\/?$/.test(location.pathname)||/^\/(search|search_result\w*)/.test(location.pathname);
    const listReady=()=>onListUrl()&&cardNodes().length>0;
    const modal=detailRoot();
    if(modal){const close=first(['[class*="close"]','button[aria-label*="关闭"]','button[title*="关闭"]'],modal);if(close)click(close);}
    if(!listReady()){
      // 先给刚关掉的浮层一点重绘时间，真回到列表就不必再导航。
      await waitFor(listReady,600,80);
    }
    if(!listReady()){
      const target=p.targetPage==='search'&&/^\/(search|search_result\w*)/.test(location.pathname)?location.href:'/explore';
      try{location.assign(target);}catch{}
      // 落地后轮询等真扫到可见卡片（与卡片上报同口径）；固定睡一觉后瞬时判断会把
      // 「重渲染还没完成」误报成「列表为空」。
      await waitFor(listReady,2500,150);
    }
    // 回执 ok 由「观察到的列表面真可用」推导，绝不硬编码为真——云端读的就是这个 ok。
    // 动作名用云端角色关联键的规范名 `back`（宿主的规范名表与退役实现都是它）：
    // 回执名对不上，云端就会当成未知失败动作处理，诚实回执反而落空。
    if(!listReady())return ambiguous('back','list_not_confirmed');
    return done(action('back',true,'list_ready'));
  }
  if(kind==='note_browse_images'){
    // 终局恒为「回执 + 随行观测」：云端深读角色按动作名 browse_images 精确匹配才清等待表，
    // 只回详情会让它一直挂着；而翻页中新加载的图片又是云端参考图刷新与观测笔记的唯一来源。
    const receiptOnly=(ok,reason,phase)=>done(observed(action('browse_images',ok,reason,{noteId:p.noteId})),phase);
    if(!exactNote())return receiptOnly(false,'note_page_mismatch','not_started');
    const root=detailRoot()||document;
    // 真图张数：swiper loop 会复制首尾，复制片不算真图。
    const realSlides=()=>all('.swiper-slide:not(.swiper-slide-duplicate)',root);
    // 图序标记：优先读轮播激活片的下标，读不到退到「首张可见图的地址」。两者都没变 = 图序没真前进。
    const progressMark=()=>{
      const slides=realSlides();
      const index=slides.findIndex((slide)=>slide.classList&&slide.classList.contains('swiper-slide-active'));
      if(index>=0)return 'slide:'+index;
      const img=all('img',root).filter(visible)[0];
      return 'img:'+String(img&&(img.currentSrc||img.src)||'');
    };
    // 每一步都重新解析翻页控件：翻页后它常被整体替换或移出可见区，
    // 循环外只取一次的旧引用点不动，而调用方无从知晓（实际前进恒为 0 却回报请求张数）。
    const nextArrow=()=>first(['.arrow-controller.right:not(.forbidden):not(.disabled)','.swiper-button-next:not(.swiper-button-disabled)','[class*="arrow"][class*="right"]:not(.forbidden)','button[aria-label*="下一"]'],root);
    const total=realSlides().length;
    if(total<=0&&!nextArrow())return receiptOnly(false,'no_target','not_started');
    const requested=Math.min(20,Math.max(1,Number(p.count)||1));
    // 目标张数受真实图数封顶：n 张图最多只能前进 n-1 次。
    const limit=total>0?Math.min(requested,Math.max(0,total-1)):requested;
    let viewed=0;
    let stop='';
    for(let i=0;i<limit;i++){
      const arrow=nextArrow();
      if(!arrow){stop='exhausted';break;}
      const before=progressMark();
      if(!click(arrow)){stop='not_actuated';break;}
      // 点得动 ≠ 翻得动：只有图序真前进才计一张。
      if(!(await waitFor(()=>progressMark()!==before,1200,50))){stop='no_advance';break;}
      viewed+=1;
      await sleep(220);
    }
    if(viewed<=0){
      // 没有下一张可翻（单图笔记 / 已在末张）是良性终局，如实回 0；
      // 控件在却点不动 / 翻不动，是诚实失败，绝不回报请求张数。
      if(stop==='not_actuated')return receiptOnly(false,'no_target','not_started');
      if(stop==='no_advance')return receiptOnly(false,'no_advance','ambiguous');
    }
    const snapshot=detail();
    const images=snapshot.value.images||[];
    // 抽不到图就不带随行快照：绝不用一份空快照去覆盖云端已有的参考图。
    return done(observed(
      action('browse_images',true,'browsed='+viewed,{noteId:p.noteId}),
      images.length?{noteDetail:{...snapshot.value,refreshOnly:true}}:undefined,
    ));
  }
  if(kind==='note_scroll_comments'){
    if(!exactNote())return fail('scroll_comments','note_page_mismatch');
    const root=detailRoot()||document;
    const scroller=first(['[class*="comment-list"]','[class*="comments"]','[class*="detail"]'],root)||document.scrollingElement;
    const positionOf=()=>Number(scroller&&scroller.scrollTop||0)||Number(window.scrollY||0);
    // 滚动后页面上真实可见的评论条数（云端 comment-reviewer 按此记「已读评论数」），
    // 不是「下发了几步就报几条」。
    // 逐个选择器试，取第一个真数出条目的那个：几个选择器求并集会把「评论行」与
    // 「评论行里的正文块」重复计一次，回报的条数就比页面上多出一倍。
    const commentRows=()=>{
      for(const selector of ['[class*="comment-item"]','[class*="commentItem"]','[class*="comment"] [class*="content"]']){
        const rows=all(selector,root).filter(visible);
        if(rows.length)return rows;
      }
      return [];
    };
    const steps=Math.min(20,Math.max(1,Number(p.count)||1));
    let moved=false;
    for(let i=0;i<steps;i++){
      const before=positionOf();
      if(scroller&&scroller.scrollBy)scroller.scrollBy({top:500,behavior:'smooth'});else window.scrollBy(0,500);
      // 有界等待落定 + 新评论加载；位置没变就是到底/不可滚，停手而不是继续空转。
      if(!(await waitFor(()=>positionOf()!==before,700,50)))break;
      moved=true;
      await sleep(150);
    }
    // 未发生任何位移 = 没滚动成功，诚实回 no_scroll（旧实现把位移塞进观测字符串、ok 恒真）。
    if(!moved)return ambiguous('scroll_comments','no_scroll');
    const visibleRows=commentRows().length;
    return done(action('scroll_comments',true,'scrolled='+visibleRows,{noteId:p.noteId,observation:{articleIndex:visibleRows}}));
  }
  if(kind==='profile_open'){
    if(/\/user\/profile\//.test(location.pathname)&&(!p.authorId||location.pathname.includes('/'+String(p.authorId))))return done(profile());
    const author=first(['.note-detail-mask a[href*="/user/profile/"]','[class*="author"] a[href*="/user/profile/"]','a[href*="/user/profile/"]']);
    if(!author)return fail('open_profile','profile_target_not_found');const targetId=(String(author.href||'').match(/\/user\/profile\/([A-Za-z0-9_-]+)/)||[])[1]||'';if(p.authorId&&targetId!==p.authorId)return fail('open_profile','profile_target_mismatch');click(author);await sleep(900);if(!/\/user\/profile\//.test(location.pathname)||p.authorId&&!location.pathname.includes('/'+String(p.authorId)))return ambiguous('open_profile','profile_navigation_unconfirmed');return done(profile());
  }
  if(kind==='notification_open'){
    // 动作名用云端 / 宿主的规范名（open_notifications），不是命令 kind：名字对不上，
    // 云端既不结案、还会把它当未知失败动作处理。
    const onNotificationPage=()=>/\/(notification|notice)/.test(location.pathname);
    if(!onNotificationPage()){
      const link=first(['a[href*="/notification"]','a[href*="/notice"]'])||findByWords(['通知','消息','notification']);
      if(!link)return fail('open_notifications','notification_entry_not_found');
      if(!click(link))return fail('open_notifications','notification_entry_not_actuated');
      await waitFor(onNotificationPage,1800,120);
      if(!onNotificationPage())return ambiguous('open_notifications','notification_navigation_unconfirmed');
    }
    // 「读不到分类栏」与「三栏都是 0」必须可区分：云端把计数 ≤0 当成该类已清零直接跳过，
    // 读不到时若回一份全 0 的读数，整条巡视会静默什么都不做。
    if(!leafTabs().length)await waitFor(()=>leafTabs().length>0,1500,120);
    if(!leafTabs().length)return ambiguous('open_notifications','notification_tabs_not_found');
    return done(notificationHome());
  }
  if(kind==='notification_browse_comments'||kind==='notification_browse_likes'||kind==='notification_browse_follows'){
    const category=kind.endsWith('likes')?'like':kind.endsWith('follows')?'follow':'comment';
    // 规范动作名：云端两个分类浏览角色按 browse_notification_likes / _follows 精确匹配，
    // 且只有 ok===true 才判该类已处理。
    const actionName=category==='like'?'browse_notification_likes':category==='follow'?'browse_notification_follows':'browse_notification_comments';
    // 「评论和@」这一类的成功终局仍是 notification_items（云端凭 items 到达即结案，
    // 没有任何角色等它的回执）；只有失败时才需要一个诚实的失败终局。
    const missed=(reason)=>category==='comment'
      ?fail(actionName,reason)
      :done(observed(action(actionName,false,reason)),'not_started');
    const tab=notificationTab(category);
    // 分类栏没命中就是「没有这个目标」：诚实 no_target 才能暴露选择器漂移。
    // 绝不退化成「点页面上第一个含赞 / 关注字样的元素」——那多半是包裹容器或笔记卡片，
    // 点了等于没切栏，却会被当成看过了。
    if(!tab)return missed('no_target');
    // 这条命令的业务结果是**那一类真的切过去了**，不是「分类栏被点了一下」（缺口登记 E14）。
    // `click()` 返回真只证明派发成功：点在包裹容器上、点着了但栏没切、栏切了但列表没换，
    // 三种都会被原实现兑现成「已看过、已清零」。所以点前先取基线、点后要平台自己给出的证据。
    const rowsKey=()=>notificationRows().slice(0,3).map((row)=>text(row,120)).join('|');
    const badgeBefore=tabBadgeCount(tab);
    const rowsBefore=rowsKey();
    if(!click(tab))return missed('tab_not_actuated');
    // 三条独立证据，任一成立即可，且都是**平台产出的**、不是我们自己刚做的那个动作：
    //  ① 叶子分类栏处于激活态 —— 直接坐实「现在就在这一类上」。读的是共享的三态判据 `stateOf`
    //     （整词分段匹配 + 否定形拒绝 + 读不到如实回读不到），**不是**上面注释里点名禁掉的裸子串匹配；
    //     且只读 `notificationTab()` 选出的**叶子**元素，包裹容器不参与（包裹容器同样带激活态类名，
    //     那正是当初不敢用它的原因 —— 判据收紧之后这条证据才重新可用）。
    //  ② 该类未读角标归零（原本有未读 ⇒ 平台受理了这次消费）。
    //  ③ 可见列表换了（栏确实切过去了）。
    const switched=async()=>await waitFor(()=>{
      const current=notificationTab(category);
      if(current&&stateOf(current)==='on')return true;
      if(current&&badgeBefore>0&&tabBadgeCount(current)===0)return true;
      const now=rowsKey();
      return Boolean(now)&&now!==rowsBefore;
    },2500,150);
    if(category==='comment'){
      // 评论类的成功终局是 items，云端凭 items 到达即结案 —— 所以**没确认切栏就绝不回 items**：
      // 栏没切时读到的是另一类的行，那会污染到达去重与发送者名册。
      if(!await switched())return missed('notification_category_unconfirmed');
      await sweepNotificationList();
      return done(notificationItems(category));
    }
    // 「看一眼」两类：清零是首要目的，发送者抽取只是清零的旁路只读输出——
    // 抽不出来只少一份名册增量，绝不反过来毙掉清零回执。
    // 但「在不在这一类上」必须有证据：证不出来就诚实回未确认，别把一次没生效的点击记成已处理。
    if(!await switched())return missed('notification_category_unconfirmed');
    let items=[];
    try{items=notificationItems(category).value.items;}catch(error){items=[];}
    return done(observed(action(actionName,true,'viewed'),items.length?{notificationItems:{items}}:undefined));
  }
  if(kind==='notification_back_home'){
    const home=first(['a[href="/explore"]','a[href*="/explore"]'])||findByWords(['首页','发现','home']);if(!home)return fail('notification_back_home','home_entry_not_found');click(home);await sleep(700);return /\/explore/.test(location.pathname)?done(cards()):ambiguous('notification_back_home','home_navigation_unconfirmed');
  }
  if(kind==='interaction_like'||kind==='interaction_collect'||kind==='interaction_follow'){
    const name=kind.replace('interaction_','');
    if(!exactNote())return fail(name,'note_page_mismatch');
    const root=detailRoot()||document;
    if(name==='follow'){
      if(p.authorId){const author=first(['a[href*="/user/profile/"]'],root);const seen=(String(author&&author.href||location.href).match(/\/user\/profile\/([A-Za-z0-9_-]+)/)||[])[1]||'';if(!seen||seen!==p.authorId)return fail(name,'author_identity_mismatch');}
      const control=first(FOLLOW_SELECTORS,root)||first(FOLLOW_SELECTORS);
      // 找不到具名关注按钮就诚实报找不到；绝不退化成「点页面上第一个含『关注』二字的元素」
      //（关注数标签、导航项都含这两个字）。
      if(!control)return done(action(name,false,'control_not_found',{noteId:p.noteId,observation:{surface:'no_btn'}}),'not_started');
      // 目标状态本就达成 = 良性 no-op 成功；云端据 reason 区分真实新关注与 no-op（不计配额、不计冷却）。
      if(followedState(control))return done(action(name,true,'already_followed',{noteId:p.noteId}));
      if(!click(control))return done(action(name,false,'control_not_actuated',{noteId:p.noteId}),'not_started');
      // 后置校验必须新写：旧实现点完只睡一觉就无条件报成功，等于没有后置校验。
      const flipped=await waitFor(()=>{const now=first(FOLLOW_SELECTORS,root)||first(FOLLOW_SELECTORS);return Boolean(now&&followedState(now));},1500,60);
      return flipped?done(action(name,true,undefined,{noteId:p.noteId})):ambiguous(name,'state_unchanged');
    }
    // 点赞 / 收藏：作用域限定在详情页互动栏内。互动栏不暴露任何无障碍语义
    //（无 aria-label、无 role=button、无「点赞」文本，图标是纯 SVG、计数是裸数字），
    // 唯一稳定可读的锚点是手写语义 class；按文本找只会命中评论区 / 反向控件 / 聚合计数。
    const bar=await engageBar(root);
    if(!bar)return done(action(name,false,'control_not_found',{noteId:p.noteId,observation:{surface:'no_bar'}}),'not_started');
    const spec=name==='like'?{selectors:['.like-wrapper','[class*="like-wrapper"]'],on:'liked',doneReason:'already_liked'}
                            :{selectors:['.collect-wrapper','[class*="collect-wrapper"]'],on:'collected',doneReason:'already_collected'};
    const locate=()=>first(spec.selectors,bar);
    const control=locate();
    if(!control)return done(action(name,false,'control_not_found',{noteId:p.noteId,observation:{surface:'no_btn'}}),'not_started');
    // 状态位读图标本身（svg use 的 #like→#liked / #collect→#collected），不看文案：
    // 平台上「已」字文案随处可见（已关注 / 已读…），把它当成功证据必然误报。
    const engaged=(el)=>iconState(el).includes(spec.on)||el.getAttribute('aria-pressed')==='true';
    if(engaged(control))return done(action(name,true,spec.doneReason,{noteId:p.noteId}));
    if(!click(control))return done(action(name,false,'control_not_actuated',{noteId:p.noteId}),'not_started');
    // 有界轮询等状态位翻转（真机多在 300–600ms 翻转，上限 1500ms）：
    // 固定睡 450ms 后单次采样正好落在翻转窗口中间，会把已生效的互动误报成未生效。
    const flipped=await waitFor(()=>{const now=locate();return Boolean(now&&engaged(now));},1500,60);
    return flipped?done(action(name,true,undefined,{noteId:p.noteId})):ambiguous(name,'state_unchanged');
  }
  if(kind==='interaction_comment'){
    if(!exactNote())return fail('comment','note_page_mismatch');
    const root=detailRoot()||document;
    const editor=first(['textarea','[contenteditable="true"]','input[placeholder*="评论"]'],root);
    if(!editor)return fail('comment','comment_editor_not_found');
    const body=norm(p.text,32000);
    if(!body)return fail('comment','comment_text_empty');
    const contactCode=norm(p.groupChatCode,2000);
    // 清场闸：残文清不干净就诚实终止，绝不带着上一条的半截评论拼接发出。
    if(!clearEditor(editor))return fail('comment','editor_not_clean');
    // 审=发：人审看到的终稿是「正文 + 换行 + 联系方式串码」。两段分别写入，段界即两段的分工
    // （后续换成「正文逐字派发 + 串码整段插入」两条通道时，段界不变）。
    for(const segment of contactCode?[body,'\n'+contactCode]:[body]){appendEditor(editor,segment);await sleep(60);}
    await sleep(100);
    // 回读校验覆盖合成后的完整文本：正文与串码都必须在，且串码在正文之后（不许丢、不许换序）。
    // 只比两段各自的存在与先后、不比分隔符的渲染形态（contenteditable 可能把换行渲染成 <br>）。
    const readBack=norm(readEditor(editor),32000);
    const bodyAt=readBack.indexOf(body);
    const codeAt=contactCode?readBack.indexOf(contactCode):bodyAt;
    if(bodyAt<0)return fail('comment','comment_readback_mismatch');
    if(codeAt<0)return fail('comment','comment_contact_code_missing');
    if(codeAt<bodyAt)return fail('comment','comment_readback_mismatch');
    const submit=findByWords(['发送','发布','submit'],root);
    if(!submit)return fail('comment','comment_submit_not_found');
    // click 在控件不可见时什么都不做——那是「未提交」，必须与「已提交、结果未知」区分开。
    if(!click(submit))return fail('comment','comment_submit_not_actuated');
    await sleep(800);
    const appeared=all('[class*="comment"]',root).some((el)=>text(el,32000).includes(norm(body,500)));
    // 提交动作已派发：分不清就报「已提交、结果未知」，绝不谎报未提交（上游据此写去重、不重投，防重复评论）。
    return appeared?done(action('comment',true,undefined,{noteId:p.noteId})):ambiguous('comment','submitted_unconfirmed');
  }
  if(kind==='interaction_like_comment'){
    // 动作名规范化为云端的关联键 `comment_like`：云端按这个名字才写风控事实、扣评论赞配额，
    // 回执名对不上就既不记账也不结案（失败时还会被当未知动作、在详情页上补发一次列表滚动）。
    if(!exactNote())return fail('comment_like','note_page_mismatch');
    const anchor=all('[data-comment-id],[data-id],[id]',detailRoot()||document).find((el)=>String(el.getAttribute('data-comment-id')||el.getAttribute('data-id')||el.id||'')===String(p.commentAnchorId||''));
    if(!anchor)return fail('comment_like','comment_target_not_found');
    // 控件优先取评论行内的具名点赞容器（与详情页互动栏同一套手写语义 class）；
    // 行内文本查找只作兜底——它会命中「赞 12」这类计数标签。
    const locate=()=>first(['.like-wrapper','[class*="like-wrapper"]'],anchor)||findByWords(['赞','like'],anchor);
    const control=locate();
    if(!control)return fail('comment_like','control_not_found');
    // 状态位读图标（svg use 的 #like→#liked），与详情页赞 / 收藏走同一条硬判据。
    // 评论行容器上带 active / selected 的类名到处都是，绝不能当「这条评论我赞过了」的证据：
    // 那会在**没有点击**的前提下回 already_active，换来一条假的「评论赞已确认」+ 一次真实配额消耗。
    const engaged=(el)=>Boolean(el&&(iconState(el).includes('liked')||el.getAttribute('aria-pressed')==='true'));
    if(engaged(control))return done(action('comment_like',true,'already_active',{noteId:p.noteId}));
    // click 返回假 = 控件不可见、压根没点着；旧实现把这个返回值丢掉、当成已点。
    if(!click(control))return done(action('comment_like',false,'control_not_actuated',{noteId:p.noteId}),'not_started');
    // 有界轮询等状态位翻转（真机 300–600ms）：固定睡 350ms 后单次采样正落在翻转窗口中间。
    const flipped=await waitFor(()=>engaged(locate()),1500,60);
    return flipped?done(action('comment_like',true,undefined,{noteId:p.noteId})):ambiguous('comment_like','postcondition_unconfirmed');
  }
  if(kind==='plan_execute'){
    const results=[];
    const map={'note.like_button':['赞','like'],'note.collect_button':['收藏','collect'],'note.follow_button':['关注','follow'],'note.comment_input':['评论','comment'],'page.scroll':[]};
    for(const step of p.steps||[]){
    if(step.actionId==='page.scroll'){
      // 兼容路径仍有活跃产出方（云端规划器的 LLM 兜底可自由产出 scroll 步骤），故不删；
      // 但结果必须按实测位移回报，不再无条件 success。
      const scroller=document.scrollingElement||document.documentElement;
      const before=Number(scroller&&scroller.scrollTop||0)||Number(window.scrollY||0);
      window.scrollBy(0,Math.max(200,Number(step.value)||500));
      await waitFor(()=>(Number(scroller&&scroller.scrollTop||0)||Number(window.scrollY||0))!==before,700,50);
      const after=Number(scroller&&scroller.scrollTop||0)||Number(window.scrollY||0);
      const moved=after!==before;
      results.push({actionId:step.actionId,ok:moved,outcome:moved?'success':'escalated',attempts:1,reason:moved?('scrolled='+Math.abs(after-before)+'px'):'no_scroll'});
      continue;
    }
    const locate=()=>findByWords(map[step.actionId]||[]);
    const el=locate();
    if(!el){results.push({actionId:step.actionId,ok:false,outcome:'no_target',attempts:1,reason:'allowlisted_target_not_found'});continue;}
    if(step.op==='input'){
      // 自证闸：非可编辑元素上 dispatchInput 直接改 textContent，回读必然等于写入值
      // ——那不是证据，是把自己刚写进去的东西再读一遍（顺带把页面上某个 div 的文字覆盖掉）。
      if(!editable(el)){results.push({actionId:step.actionId,ok:false,outcome:'no_target',attempts:1,reason:'allowlisted_target_not_found'});continue;}
      let target=el;let attempts=0;let ok=false;
      while(attempts<COMPAT_MAX_ATTEMPTS){
        attempts+=1;
        dispatchInput(target,String(step.value||''));
        const read='value' in target?String(target.value||''):text(target,32000);
        if(norm(read,32000)===norm(step.value,32000)){ok=true;break;}
        await sleep(120);
        target=locate()||target;
      }
      results.push({actionId:step.actionId,ok,outcome:ok?'success':'escalated',attempts,reason:ok?'confirmed':'input_readback_mismatch'});
      continue;
    }
    // 点击支：判据换成与主路径同源的硬判据（图标状态位 / 关注文案 / 焦点落位），
    // 不再用宽松类名激活态，`note.comment_input` 也不再无条件 ok。
    const verify=compatVerifier(step.actionId);
    let target=el;let attempts=0;let ok=false;let actuated=false;
    while(attempts<COMPAT_MAX_ATTEMPTS){
      attempts+=1;
      if(click(target)){
        actuated=true;
        if(await waitFor(()=>{const now=locate();return Boolean(now&&verify(now));},900,60)){ok=true;break;}
      }
      await sleep(150);
      target=locate()||target;
    }
    // 「这一次没看到结果」与「连续重试到顶、判定平台系统性改版」不是一回事。
    // 旧实现硬写 attempts:1 却报 escalated，回报的是请求形状而不是实测过程，
    // 上游无从区分「该重试」与「该停手报改版」。现在 attempts 如实回报，
    // 且只有把重试打满仍未确认才配叫 escalated。
    results.push({
      actionId:step.actionId,
      ok,
      outcome:ok?'success':(actuated?'escalated':'no_target'),
      attempts,
      reason:ok?'confirmed':(actuated?'postcondition_unconfirmed':'target_not_actuated'),
    });
    }
    return done({kind:'plan_results',value:{results}});
  }
  if(kind==='publish_select_mode'){
    const ready=()=>Boolean(first(['input[type="file"][accept*="image"]','input[placeholder*="标题"]','textarea[placeholder*="正文"]','[contenteditable="true"]']));
    if(ready())return done(action('select_mode',true,'already_active'));
    const mode=findByWords(['上传图文','图文','image']);if(!mode)return fail('select_mode','publish_mode_not_found');click(mode);await sleep(500);return ready()?done(action('select_mode',true)):ambiguous('select_mode','publish_mode_unconfirmed');
  }
  if(kind==='publish_fill_field'){
    const field=p.fieldType==='title'?first(['input[placeholder*="标题"]','textarea[placeholder*="标题"]','input[class*="title"]']):first(['[contenteditable="true"]','textarea[placeholder*="正文"]','textarea[placeholder*="描述"]']);
    if(!field)return fail('fill_field','publish_field_not_found');
    const target=String(p.value||'');
    // 清场：内容是在光标处增量写入的，上一次留下的残文不清干净就会与本次拼在一起发出去。
    if(!clearEditor(field))return fail('fill_field','publish_field_not_clean');
    const plainValueField='value' in field;
    const paragraphs=target.split('\n');
    for(let i=0;i<paragraphs.length;i++){
      if(i>0){
        // 每个换行单独派发一次回车。派发之后立刻复读：换行没落到内容里就补写一个，
        // 宁可段落结构不理想，也绝不把正文丢掉半截。
        pressEnter(field);
        if(readEditor(field).split('\n').length<=i)appendEditor(field,'\n');
      }
      // 增量写入而非一次性赋值：让编辑器自己的输入处理逐段跑起来。
      for(const chunk of chunksOf(paragraphs[i],24)){
        appendEditor(field,chunk);
        await sleep(20);
      }
    }
    const wanted=norm(target,32000);
    const head=Array.from(wanted).slice(0,20).join('');
    const expectedParagraphs=paragraphs.filter((line)=>line.trim().length>0).length;
    // 有界确认（编辑器常在下一帧才把内容规整完，写完立刻单次读会把已生效的写入判成失败）：
    // ① 已写内容以目标开头——被截了半截 / 写进了别的框都会在这里露馅；
    // ② 语义相似度达阈值——编辑器做的空白规整、全半角替换是无害改写，严格等值会误杀；
    // ③ 受控框（value 语义）里换行是明确的，段落数必须对得上。
    const settled=await waitFor(()=>{
      const read=norm(readEditor(field),32000);
      if(!read||(head&&read.indexOf(head)!==0))return false;
      if(plainValueField&&expectedParagraphs>1){
        if(String(field.value||'').split('\n').filter((line)=>line.trim().length>0).length<expectedParagraphs)return false;
      }
      return read===wanted||similarity(read,wanted)>=0.9;
    },2000,80);
    if(!settled){
      // 失败清场：留着半截草稿会被下一次填写拼上，或被提交原样发出去。
      clearEditor(field);
      return ambiguous('fill_field','publish_field_readback_mismatch');
    }
    // 光标归尾：后续的话题 / @ 候选都是在光标处继续写的，光标不在尾部会插到正文中间。
    cursorToEnd(field);
    return done(action('fill_field',true));
  }
  if(kind==='publish_add_with_candidate'){
    const candidateWords=(p.candidates||[]).concat([String(p.value||'')]);
    if(p.candidateKind==='topic'||p.candidateKind==='mention'){
      const editor=first(['[contenteditable="true"]','textarea[placeholder*="正文"]']);if(!editor)return fail('add_with_candidate','publish_editor_not_found');const prefix=p.candidateKind==='topic'?'#':'@';const value=prefix+String(p.value||'');const before='value' in editor?String(editor.value||''):text(editor,32000);dispatchInput(editor,(before+' '+value).trim());await sleep(300);const candidate=findByWords(candidateWords);if(!candidate)return fail('add_with_candidate','publish_candidate_not_found');click(candidate);await sleep(200);const read='value' in editor?String(editor.value||''):text(editor,32000);return norm(read,32000).includes(norm(p.value,1000))?done(action('add_with_candidate',true)):ambiguous('add_with_candidate','publish_candidate_unconfirmed');
    }
    const entryWords=p.candidateKind==='location'?['地点','位置','location']:p.candidateKind==='collection'?['合集','专辑','collection']:[String(p.candidateKind||'')];
    const entry=findByWords(entryWords);
    if(!entry)return fail('add_with_candidate','publish_candidate_entry_not_found');
    click(entry);
    await sleep(300);
    const locate=()=>findByWords(candidateWords);
    const candidate=locate();
    if(!candidate)return fail('add_with_candidate','publish_candidate_not_found');
    if(!click(candidate))return ambiguous('add_with_candidate','publish_candidate_unconfirmed');
    // 入口行回显（选中的地点 / 合集名写回入口那一行）是独立于「候选项自己长什么样」的证据，
    // 但回溯必须有界、且不能把候选列表本身圈进来：候选项文本恒等于目标值，
    // 拿它当证据就是自证——点开列表即「确认成功」。旧写法的 `.closest(…,'div')` 正是这个形态。
    const echoRoot=entry.contains&&entry.contains(candidate)?null:(rowOf(entry,['[role="button"]','label','[class*="item"]','[class*="option"]','[class*="field"]'],3,candidate)||entry);
    const confirmed=await waitFor(()=>{
      if(selected(locate()))return true;
      return Boolean(echoRoot&&echoes(text(echoRoot,2000),p.value));
    },1000,60);
    return confirmed?done(action('add_with_candidate',true)):ambiguous('add_with_candidate','publish_candidate_unconfirmed');
  }
  if(kind==='publish_set_option'){
    const kindWords={visibility:['可见范围','谁可以看','visibility'],comment_permission:['评论权限','允许评论','comment'],save_permission:['保存权限','允许保存','save'],declaration_ai:['AI创作','AI生成','AI'],declaration_ad:['商业合作','广告','ad'],declaration_origin:['原创声明','原创','original']}[p.optionKind]||[String(p.optionKind||'')];
    const label=findByWords(kindWords);if(!label)return fail('set_option','publish_option_not_found');const row=label.closest('label,[role="switch"],[role="checkbox"],[class*="item"],[class*="option"]')||label.parentElement||label;
    const booleanValue=['true','false'].includes(String(p.optionValue));
    if(booleanValue){
      const desired=String(p.optionValue)==='true';
      // `||row` 兜底已删。它的形态是：找不到真正的开关控件时拿整行（往往就是个 div）冒充，
      // 而 div 上几乎必然读不到状态；旧判据把「读不到」压成 false，于是**期望值为「关」时
      // `false===false` 直接回「本来就是关的、成功」，连点都不点**——没有证据被当成了证据。
      // 现在：找不到开关就诚实报找不到。
      const locate=()=>first([SWITCH_SELECTOR],row)||(row&&row.matches&&row.matches(SWITCH_SELECTOR)&&visible(row)?row:null);
      const control=locate();
      if(!control)return fail('set_option','publish_option_not_found');
      const state=stateOf(control);
      // 只有**读到明确状态**且恰好等于期望值才允许早退；读不到（''）一律去点。
      if(state&&(state==='on')===desired)return done(action('set_option',true,'already_active'));
      if(!click(control))return fail('set_option','publish_option_unconfirmed');
      const settled=await waitFor(()=>{
        const next=stateOf(locate());
        return Boolean(next)&&(next==='on')===desired;
      },1200,60);
      return settled?done(action('set_option',true)):ambiguous('set_option','publish_option_unconfirmed');
    }
    click(row);
    await sleep(250);
    const locate=()=>findByWords([String(p.optionValue||'')]);
    const target=locate();
    if(!target)return fail('set_option','publish_option_value_not_found');
    if(!selected(target)&&!click(target))return ambiguous('set_option','publish_option_unconfirmed');
    // 取值行的回显同样要挡自证：候选浮层若渲染在这一行里，行文本恒含目标值。
    // 另外用 `echoes` 而非裸 includes——行上写着「不公开」时，`includes('公开')` 恒真，
    // 那是反证据不是回显。
    const echoRoot=row&&row.contains&&row.contains(target)?null:row;
    const settled=await waitFor(()=>{
      if(selected(locate()))return true;
      return Boolean(echoRoot&&echoes(text(echoRoot,2000),p.optionValue));
    },1200,60);
    return settled?done(action('set_option',true)):ambiguous('set_option','publish_option_unconfirmed');
  }
  if(kind==='publish_set_schedule'){
    const wanted=beijingMinute(p.publishTime);
    if(!wanted)return fail('set_schedule','invalid_schedule_time');
    let schedule=scheduleContext();
    if(!schedule.control)return fail('set_schedule','schedule_control_not_found');
    const before=stateOf(schedule.control);
    // 读不到状态绝不猜：尤其不能把「读不到」当 off，再靠自己的一次 click 猜它已经 on。
    if(!before)return fail('set_schedule','schedule_control_not_found');
    if(before==='off'){
      if(!click(schedule.control))return ambiguous('set_schedule','schedule_readback_mismatch');
      const enabled=await waitFor(()=>{
        const next=scheduleContext();
        return Boolean(next.control)&&stateOf(next.control)==='on';
      },1500,60);
      if(!enabled)return ambiguous('set_schedule','schedule_readback_mismatch');
    }
    // 已经是 on 时保持幂等，绝不再点一次把它关掉。开关翻转后页面会重绘时间框，必须重新解析。
    schedule=scheduleContext();
    if(!schedule.control||stateOf(schedule.control)!=='on')return ambiguous('set_schedule','schedule_readback_mismatch');
    if(!schedule.field)return fail('set_schedule','schedule_input_not_found');
    const writeValue=String(schedule.field.type||'').toLowerCase()==='datetime-local'?wanted.replace(' ','T'):wanted;
    dispatchInput(schedule.field,writeValue);
    if(schedule.field.blur)schedule.field.blur();
    // 三项正证据必须在同一个有界窗口内同时成立：开关仍开、目标分钟逐字相等、
    // 精确「定时发布」叶子提交控件唯一可解析。只回读自己刚写的小时前缀不算平台接受。
    const confirmed=await waitFor(()=>{
      const next=scheduleContext();
      return Boolean(next.control)&&stateOf(next.control)==='on'&&Boolean(next.field)
        &&scheduleMinute(next.field)===wanted&&submitLeaves('定时发布').length===1;
    },1500,60);
    return confirmed?done(action('set_schedule',true)):ambiguous('set_schedule','schedule_readback_mismatch');
  }
  if(kind==='publish_submit'){
    const receipt=(value,phase)=>done({kind:'publish_receipt',value:{recordId:Number(p.recordId),seq:Number(p.seq),kind:'submit',...value}},phase);
    // 期望模式由 Native 会话真态注入，不接受 Cloud 自报，也不在页面写 marker。
    // unknown 说明本会话没有确认进入这张发布页，猜 immediate 会把一次恢复/重连变成立即发布。
    const expectedMode=String(p.expectedScheduleMode||'');
    if(expectedMode!=='immediate'&&expectedMode!=='scheduled')return receipt({ok:false,submitDispatched:false,error:'publish_mode_unconfirmed'},'not_started');
    const schedule=scheduleContext();
    const actualState=stateOf(schedule.control);
    const expectedState=expectedMode==='scheduled'?'on':'off';
    if(!actualState||actualState!==expectedState)return receipt({ok:false,submitDispatched:false,error:'publish_mode_unconfirmed'},'not_started');
    if(expectedMode==='scheduled'){
      const wanted=beijingMinute(p.expectedScheduleTime);
      if(!wanted||!schedule.field||scheduleMinute(schedule.field)!==wanted)return receipt({ok:false,submitDispatched:false,error:'publish_mode_unconfirmed'},'not_started');
    }
    // 模式已复读后只取与之逐字对应的真实提交控件。不得再把两种文案混在一起按横坐标取最右。
    const label=expectedMode==='scheduled'?'定时发布':'发布';
    const leaves=submitLeaves(label);
    const submit=leaves.length===1?leaves[0]:null;
    // 没找到目标就压根没点：submitDispatched 必须保持假，否则云端按「已提交」不重投 → 稿子静默丢失。
    if(!submit)return receipt({ok:false,submitDispatched:false,error:'publish_submit_not_found'},'not_started');
    if(submit.disabled||submit.getAttribute('aria-disabled')==='true')return receipt({ok:false,submitDispatched:false,error:'publish_submit_disabled'},'not_started');
    // 后置校验只认页面上的成功文案这条正证据。地址判据被明令删除：抢占方 / 恢复导航会在
    // 提交窗口内把发布页导走，一篇可能根本没发出去的稿会因此被记成已发布。
    const SUCCESS_COPY=/发布成功|发布中|笔记已发布|笔记发布成功|成功发布|稍后可在/;
    const toastHit=()=>all('[class*="toast"],[class*="message"],[class*="notice"],[class*="tip"],[class*="success"],[class*="result"],[role="alert"],[role="status"]').filter(visible).some((el)=>SUCCESS_COPY.test(text(el,800)));
    const bodyHit=()=>SUCCESS_COPY.test(text(document.body,20000));
    // 绑定本次提交：点击前就在页面上的同款文案不是本次的证据（草稿箱文案、历史提示都可能含它）。
    const copyBefore=bodyHit();
    if(!click(submit))return receipt({ok:false,submitDispatched:false,error:'publish_submit_not_actuated'},'not_started');
    // 提交点已跨过：15s 有界轮询，只认正证据；未确认也必须如实带上「已派发」。
    const confirmed=await waitFor(()=>toastHit()||(!copyBefore&&bodyHit()),15000,500);
    return confirmed
      ?receipt({ok:true,submitDispatched:true,postUrl:String(location.href).slice(0,4096)},'confirmed')
      :receipt({ok:false,submitDispatched:true,error:'post_validate_failed'},'ambiguous');
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
  if(kind==='publish_set_cover'){
    const previews=all('.img-preview-area img,img[id*="creator-preview"],[class*="preview"] img,[class*="upload"] img').filter(visible);
    const index=Math.max(0,Number(p.imageIndex)||0);const preview=previews[index];if(!preview)return fail(kind.replace('publish_',''),'preview_not_found');
    // 图块容器：有界回溯 + 只认真正的图片项容器。旧写法选择器末项是任意 `div`，
    // 实际会停在最近的祖先 div 上——图区是轮播结构，那层容器带「当前显示」类名，
    // 于是「这张图正在显示」被读成「这张图已是封面」，连「设为封面」都不点就回成功。
    const tile=rowOf(preview,['[class*="preview-item"]','[class*="previewItem"]','[class*="img-item"]','[class*="image-item"]','[class*="upload-item"]','[class*="photo-item"]','li'],3)||preview;
    // 封面证据必须**同时**说清两件事：说的是封面，且它是已生效态。轮播的「当前显示」与
    // 点一下就出现的选中外观都不算——前者与封面无关，后者是自证。
    // 文本兜底 /已.*封面|封面.*已/ 一并删除：同一份路由在点赞那条路径上自己写了
    // 「平台上『已』字文案随处可见，把它当成功证据必然误报」。
    const coverConfirmed=(el)=>{
      if(!el||!el.getAttribute)return false;
      if(String(el.getAttribute('data-cover')||'')==='true')return true;
      return String(el.getAttribute('class')||'').toLowerCase().split(/\s+/).some((token)=>{
        const parts=token.split(/[-_]+/).filter(Boolean);
        return parts.includes('cover')&&parts.some((part)=>STATE_FRAGMENTS.includes(part));
      });
    };
    const covered=()=>coverConfirmed(tile)||coverConfirmed(preview);
    if(covered())return done(action('set_cover',true,'already_active'));
    if(!click(tile))return fail('set_cover','publish_cover_unconfirmed');
    await sleep(200);
    // 只认精确动作文案「设为封面」；裸「封面」会命中区块标题、说明文字一类。
    const cover=findByWords(['设为封面']);
    // 找不到 / 点不着封面入口就是压根没设过：诚实回未开始，绝不靠外观判据补一个成功。
    if(!cover||!click(cover))return fail('set_cover','publish_cover_unconfirmed');
    return await waitFor(covered,1200,60)?done(action('set_cover',true)):ambiguous('set_cover','publish_cover_unconfirmed');
  }
  return fail(kind||'unknown','unsupported_command');
}
