  // ── 阻断现场结构化采集（change blocking-overlay-dom-capture）──────────────────────────
  //
  // 目的：阻断弹窗随机出现，处置完现场就没了。本段在**已判出阻断类别之后**把现场结构留下来，
  // 供后续独立开发（认出弹窗 / 点中其中按钮）照着写，不必再等下一次真机复现。
  //
  // 三条硬边界，全部是红线而非偏好：
  //  ① **只读**：不点击、不改页、不导航。采集是留证，不是处置。
  //  ② **不回喂判定**：入选口径刻意比判定口径宽（不要求带 iframe、不要求无关闭控件、
  //     不要求达到判定尺寸阈值）——真实限流弹窗普遍不满足这三者中的任意一项。放宽的最坏
  //     后果只是多存一条无用样本，而非任何账号状态变化。判定输入仍只是既有整页文本 + iframe src。
  //  ③ **有界**：探针按固定周期反复运行且受命令超时预算约束，而探测超时按 sticky 保持上一状态
  //     ——无上限的 outerHTML 在 FB 这种页面上能到 MB 级，会把探测拖成超时，等于**阻断监测失明**。
  //     这是本段唯一可能反向损害生产行为的路径，故用固定上限而非经验值堵死。
  //
  // 关于「超时」：本段是同步 DOM 遍历，同步 JS 无法自我中断，故时间上限由**节点访问预算**
  // 代行（MAX_VISITS）。这是刻意的取舍，不是遗漏——异步分片会让采集跨越页面变化，采到的
  // 现场就不再是同一时刻的现场。
  const OVERLAY_CAPTURE_LIMITS={
    containers:5,        // 入选容器数上限（按面积降序取前 N）
    clickables:30,       // 每容器可点击子元素上限
    htmlBytes:20000,     // 每容器 HTML 原文字节上限
    totalBytes:64000,    // 单次采集总字节上限
    visits:4000,         // 节点访问预算（同步遍历的时间上限代行）
    iframeSrcs:5,
  };
  const overlayCaptureId=()=>{
    // MUST NOT 由页面内容派生（如文案哈希）：同一形态的弹窗会反复出现，内容派生的标识会把
    // 多次独立采集折叠成一条，样本表上看就是「这个弹窗只出现过一次」。
    let rand='';
    try{
      if(window.crypto&&typeof window.crypto.getRandomValues==='function'){
        const buf=new Uint8Array(8);
        window.crypto.getRandomValues(buf);
        rand=Array.from(buf).map((b)=>b.toString(16).padStart(2,'0')).join('');
      }
    }catch(_){/* 安全上下文缺失时回落，下面兜底 */}
    if(!rand)rand=Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,10);
    return 'ovc_'+Date.now().toString(36)+'_'+rand.slice(0,16);
  };
  const captureBlockingOverlays=(kind)=>{
    const captureId=overlayCaptureId();
    // captureId 在入口即生成：采集失败时也带得出标识，否则告警既查不到样本、也无从得知曾采到过。
    const base={captureId,kind:String(kind||''),capturedAt:Date.now(),url:String(location.href||'')};
    try{
      const limits=OVERLAY_CAPTURE_LIMITS;
      let visits=0;
      let totalBytes=0;
      let budgetHit=false;
      const spend=(n)=>{visits+=n;if(visits>limits.visits)budgetHit=true;return !budgetHit;};
      const vw=window.innerWidth||1024;
      const vh=window.innerHeight||768;
      const rectOf=(el)=>{
        const r=el.getBoundingClientRect();
        return {x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};
      };
      const styleOf=(el)=>{
        const s=window.getComputedStyle?getComputedStyle(el):null;
        return s?{position:s.position,zIndex:s.zIndex,opacity:s.opacity}:undefined;
      };
      const testId=(el)=>{
        // FB 的 class 是混淆的、每次发版都变；role / aria / data-testid 才是跨改版稳定的那部分。
        const attr=el.getAttribute&&(el.getAttribute('data-testid')||el.getAttribute('data-pagelet'));
        return attr?norm(attr,120):undefined;
      };
      const pathOf=(el)=>{
        const parts=[];
        let cur=el;
        for(let depth=0;cur&&cur.nodeType===1&&depth<5;depth+=1,cur=cur.parentElement){
          const tag=String(cur.tagName||'').toLowerCase();
          if(!tag)break;
          let seg=tag;
          if(cur.id)seg+='#'+norm(cur.id,60);
          const role=cur.getAttribute&&cur.getAttribute('role');
          if(role)seg+='[role='+norm(role,40)+']';
          const tid=testId(cur);
          if(tid)seg+='[testid='+tid+']';
          parts.unshift(seg);
          if(cur.id)break;
        }
        return parts.join(' > ');
      };
      const iframesIn=(el)=>{
        if(!el.querySelectorAll)return [];
        return Array.from(el.querySelectorAll('iframe')).slice(0,limits.iframeSrcs)
          .map((f)=>norm((f.getAttribute&&f.getAttribute('src'))||f.src||'',200))
          .filter(Boolean);
      };
      const CLICKABLE_SELECTOR='a,button,[role="button"],[role="link"],[role="menuitem"],[role="tab"],input[type="submit"],input[type="button"],[tabindex]:not([tabindex="-1"])';
      const clickablesIn=(el)=>{
        const out=[];
        let truncated=false;
        if(!el.querySelectorAll)return {items:out,truncated};
        const nodes=Array.from(el.querySelectorAll(CLICKABLE_SELECTOR));
        spend(nodes.length);
        for(const node of nodes){
          if(out.length>=limits.clickables){truncated=true;break;}
          if(budgetHit){truncated=true;break;}
          if(!visible(node))continue;
          // 位置尺寸是硬要求：同一平台上不同部位所需的点击方式不同（部分部位只有元素点击
          // 有效，部分只有坐标点击有效），事先无法判断新形态属于哪一类，两种方式所需的
          // 信息都必须留全。只留文字的记录，后续写动作时会当场卡住。
          out.push({
            tag:String(node.tagName||'').toLowerCase(),
            role:(node.getAttribute&&node.getAttribute('role'))||undefined,
            text:text(node,120)||undefined,
            label:label(node,120)||undefined,
            testId:testId(node),
            rect:rectOf(node),
            disabled:Boolean(node.disabled||(node.getAttribute&&node.getAttribute('aria-disabled')==='true'))||undefined,
          });
        }
        return {items:out,truncated};
      };

      // 候选集合刻意分两路取，且两路都有界：
      //  ① 语义路——对话框角色 / aria-modal，这是 FB 阻断弹窗的主力形态；
      //  ② 版式路——body 近层子孙里定位为 fixed/absolute 且面积够大的浮层，兜住没有语义标记的那些。
      // 不做全文档 getComputedStyle 扫描：那在 FB 这种页面上就是把探测拖垮的做法。
      const semantic=Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"]'));
      spend(semantic.length);
      const layout=[];
      const body=document.body;
      if(body&&body.children){
        const shallow=[];
        for(const child of Array.from(body.children).slice(0,60)){
          shallow.push(child);
          if(child.children)for(const g of Array.from(child.children).slice(0,20))shallow.push(g);
        }
        spend(shallow.length);
        for(const el of shallow){
          if(budgetHit)break;
          const s=window.getComputedStyle?getComputedStyle(el):null;
          if(!s)continue;
          if(s.position!=='fixed'&&s.position!=='absolute')continue;
          const r=el.getBoundingClientRect();
          if(r.width<200||r.height<80)continue;
          if((r.width*r.height)<(vw*vh*0.02))continue;
          layout.push(el);
        }
      }

      const seen=[];
      const picked=[];
      for(const el of semantic.concat(layout)){
        if(!el||seen.indexOf(el)>=0)continue;
        seen.push(el);
        if(!visible(el))continue;
        picked.push(el);
      }
      picked.sort((a,b)=>{
        const ar=a.getBoundingClientRect();
        const br=b.getBoundingClientRect();
        return (br.width*br.height)-(ar.width*ar.height);
      });

      const containers=[];
      let containersTruncated=picked.length>limits.containers;
      for(const el of picked.slice(0,limits.containers)){
        if(budgetHit){containersTruncated=true;break;}
        const srcs=iframesIn(el);
        const clicks=clickablesIn(el);
        let html='';
        let htmlTruncated=false;
        try{
          const raw=String(el.outerHTML||'');
          const budget=Math.max(0,Math.min(limits.htmlBytes,limits.totalBytes-totalBytes));
          if(raw.length>budget){html=raw.slice(0,budget);htmlTruncated=true;}
          else html=raw;
          totalBytes+=html.length;
        }catch(_){htmlTruncated=true;}
        containers.push({
          tag:String(el.tagName||'').toLowerCase(),
          id:el.id||undefined,
          className:norm(el.className&&typeof el.className==='string'?el.className:'',240)||undefined,
          role:(el.getAttribute&&el.getAttribute('role'))||undefined,
          ariaModal:(el.getAttribute&&el.getAttribute('aria-modal'))||undefined,
          ariaLabel:(el.getAttribute&&el.getAttribute('aria-label'))?norm(el.getAttribute('aria-label'),200):undefined,
          testId:testId(el),
          path:pathOf(el)||undefined,
          rect:rectOf(el),
          style:styleOf(el),
          text:text(el,600)||undefined,
          hasIframe:srcs.length>0,
          iframeSrcs:srcs.length?srcs:undefined,
          clickables:clicks.items,
          clickablesTruncated:clicks.truncated||undefined,
          html:html||undefined,
          htmlTruncated:htmlTruncated||undefined,
        });
      }

      // 快照层的 truncated 是**逐容器标记的上卷**，不是另一套判据：任一容器的原文或子元素清单
      // 被截断，快照层就得标出来。少了这一卷，消费方必须遍历每个容器才知道这份样本是不是完整的
      // ——而「看起来完整」正是截断类缺陷最容易骗过人的地方。
      const anyContainerTruncated=containers.some((c)=>c.htmlTruncated||c.clickablesTruncated);
      // 三态诚实：MUST NOT 用同一个空结果同时表示「确实没有」与「没能采到」。
      // 空容器 + status='none_visible' = 采集跑通了、页面上确实没有符合口径的可见容器。
      return Object.assign(base,{
        status:containers.length>0?'captured':'none_visible',
        viewport:{width:vw,height:vh},
        inFrame:window.top!==window.self||undefined,
        seenCount:picked.length,
        containers,
        truncated:(containersTruncated||budgetHit||anyContainerTruncated||totalBytes>=limits.totalBytes)||undefined,
        budgetExhausted:budgetHit||undefined,
      });
    }catch(err){
      // 采集失败绝不逸出到阻断探针：既有阻断上报必须照常发出，内容与本段引入前逐字一致。
      return Object.assign(base,{
        status:'failed',
        reason:norm(err&&err.message?err.message:String(err),200)||'capture_failed',
        containers:[],
      });
    }
  };
