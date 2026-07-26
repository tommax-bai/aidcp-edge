import { FACEBOOK_REACTION_CONTROL_HELPERS_JS } from './cta-labels.js';
import { POST_IDENTITY_JS } from './post-identity-core.js';

export {
  canonicalFacebookFeedVideoPostId,
  canonicalFacebookReelPostId,
  canonicalPostId,
  POST_IDENTITY_JS,
} from './post-identity-core.js';

/**
 * Facebook feed 的页内多布局抽象（扫描 / 就地深读 / 点赞 / 评论共用）。
 *
 * 语义化布局仍优先使用 `[role=feed] > [role=article]`；轻量正文卡沿用 story-message 边界。轻量视频
 * 则从数字 `data-video-id` 向上做有界查找，只有同一最小根内恰好一个视频、作者/正文和一组帖级
 * 点赞/评论动作时才成立。该 helper 同时拥有卡边界与身份，扫描、深读、动作和验证不可各自猜测。
 */
export const FB_FEED_LAYOUT_HELPERS_JS = `
  ${FACEBOOK_REACTION_CONTROL_HELPERS_JS}
  var fbFeedStorySelector='[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-ad-rendering-role="story_message"]';
  var fbFeedAuthorSelector='h2 a[href],h3 a[href],h4 a[href]';
  function fbFeedVisible(el){ if(!el||!el.getBoundingClientRect) return false; var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) return false; var s=window.getComputedStyle?getComputedStyle(el):null; return !s||(s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity||'1')>0.01); }
  function fbFeedContains(root,el){ return root===document ? !!(document.documentElement&&document.documentElement.contains(el)) : !!(root&&root.contains&&root.contains(el)); }
  function fbFeedText(el){ return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\\s+/g,' ').trim(); }
  function fbFeedVideoIds(card){
    if(!card||!card.querySelectorAll) return [];
    var nodes=Array.prototype.slice.call(card.querySelectorAll('[data-video-id]'));
    if(card.matches&&card.matches('[data-video-id]')) nodes.unshift(card);
    var ids=[];
    for(var i=0;i<nodes.length;i++){ var id=String(nodes[i].getAttribute('data-video-id')||'').trim();
      if(!/^\\d+$/.test(id)||ids.indexOf(id)>=0) continue; ids.push(id); }
    return ids;
  }
  function fbFeedPostActionCounts(card){
    return {likes:fbCtaPostReactionControls(card).length,comments:fbCtaPostCommentControls(card).length};
  }
  /** 严格视频证据只描述同一卡片内的事实；不按祖先顺序借用邻卡作者或动作。 */
  function fbFeedStrictVideoEvidence(card){
    if(!card||!card.querySelectorAll) return null;
    var ids=fbFeedVideoIds(card); if(ids.length!==1) return null;
    var videos=card.querySelectorAll('video'); if(videos.length!==1) return null;
    var author=card.querySelector(fbFeedAuthorSelector), story=card.querySelector(fbFeedStorySelector);
    if(!author&&!story) return null;
    var actions=fbFeedPostActionCounts(card); if(actions.likes!==1||actions.comments!==1) return null;
    return {videoId:ids[0],video:videos[0]};
  }
  function fbFeedOwnCanonicalLinks(card){
    if(!card||!card.querySelectorAll) return [];
    var links=card.querySelectorAll('a[href]'), out=[];
    for(var i=0;i<links.length;i++){ var el=links[i];
      var nested=el.closest?el.closest('[role="article"],article'):null; if(nested&&nested!==card) continue;
      var raw=String(el.getAttribute('href')||'').trim(); if(!raw) continue;
      var id=fbCanonicalPostId(raw); if(!id) continue;
      var absolute=''; try{ absolute=new URL(raw,location.href).href; }catch(e){ continue; }
      out.push({id:id,href:absolute});
    }
    return out;
  }
  /** 卡身份/可开链接同源：严格视频可用 data-video-id 补齐，但显式身份冲突时失败关闭。 */
  function fbFeedCardIdentity(card){
    var links=fbFeedOwnCanonicalLinks(card), strict=fbFeedStrictVideoEvidence(card);
    if(!strict) return links.length>0?{postId:links[0].id,noteId:links[0].href,isStrictVideo:false,video:null}:null;
    var ids=[]; for(var i=0;i<links.length;i++){ if(ids.indexOf(links[i].id)<0) ids.push(links[i].id); }
    var videoPostId='fb:'+strict.videoId;
    if(ids.length>1||(ids.length===1&&ids[0]!==videoPostId)) return null;
    var noteId='https://www.facebook.com/watch?v='+encodeURIComponent(strict.videoId);
    if(ids.length===1){ for(var j=0;j<links.length;j++){ if(links[j].id===videoPostId){ noteId=links[j].href; break; } } }
    return {postId:videoPostId,noteId:noteId,isStrictVideo:true,video:strict.video};
  }
  function fbFeedCardPostId(card){ var identity=fbFeedCardIdentity(card); return identity?identity.postId:null; }
  function fbFeedCardPermalink(card){ var identity=fbFeedCardIdentity(card); return identity?identity.noteId:null; }
  function fbFeedSemanticCards(root,includeHidden){
    var base=root||document; var arts=base.querySelectorAll('[role="article"],article'); var out=[];
    for(var i=0;i<arts.length;i++){ var a=arts[i]; if(!includeHidden&&!fbFeedVisible(a)) continue;
      var parent=a.parentElement&&a.parentElement.closest?a.parentElement.closest('[role="article"],article'):null;
      if(parent&&fbFeedContains(base,parent)) continue;                                      // 嵌套评论 article
      out.push(a); }
    return out; }
  function fbFeedFallbackCards(root,includeHidden){
    var base=root||document; var seeds=base.querySelectorAll(fbFeedStorySelector); var found=[];
    for(var i=0;i<seeds.length;i++){ var seed=seeds[i]; if(!includeHidden&&!fbFeedVisible(seed)) continue;
      if(seed.closest&&seed.closest('div[role="feed"]')) continue;                         // 真 feed 走语义化路径
      var cur=seed;
      while(cur&&cur!==document.body&&cur!==document.documentElement&&cur!==base){
        if(cur!==seed&&cur.querySelector&&cur.querySelector(fbFeedAuthorSelector)) break;
        cur=cur.parentElement;
      }
      if(cur===base&&cur.querySelector&&!cur.querySelector(fbFeedAuthorSelector)) cur=null;
      if(!cur||cur===document.body||cur===document.documentElement||!fbFeedContains(base,cur)) continue;
      if(!includeHidden&&!fbFeedVisible(cur)) continue;
      if(found.indexOf(cur)<0) found.push(cur); }
    // 分享/重复 story-message 可能先得到嵌套候选；只保留最外层卡，避免一帖多卡与跨卡误归因。
    var top=[];
    for(var j=0;j<found.length;j++){ var nested=false;
      for(var k=0;k<found.length;k++){ if(j!==k&&found[k].contains(found[j])){ nested=true; break; } }
      if(!nested) top.push(found[j]); }
    top.sort(function(a,b){ if(a===b) return 0; var p=a.compareDocumentPosition(b); return (p&Node.DOCUMENT_POSITION_FOLLOWING)?-1:1; });
    return top; }
  function fbFeedVideoCards(root,includeHidden){
    var base=root||document, seeds=base.querySelectorAll('[data-video-id]'), found=[];
    for(var i=0;i<seeds.length;i++){ var seed=seeds[i], raw=String(seed.getAttribute('data-video-id')||'').trim(); if(!/^\\d+$/.test(raw)) continue;
      var semantic=seed.closest?seed.closest('[role="article"],article'):null;
      if(semantic&&fbFeedContains(base,semantic)) continue;                         // 已由语义卡路径承载
      var cur=seed, depth=0, hit=null;
      while(cur&&cur!==base&&cur!==document.body&&cur!==document.documentElement&&depth<24){
        if(cur.matches&&cur.matches('[role="main"],main,[role="feed"]')) break;
        if(cur.querySelector&&cur.querySelector('[role="article"],article')) break; // 不跨入邻接语义卡容器借证据
        var evidence=fbFeedStrictVideoEvidence(cur);
        if(evidence&&evidence.videoId===raw){ hit=cur; break; }
        cur=cur.parentElement; depth++;
      }
      if(!hit||(!includeHidden&&!fbFeedVisible(hit))||found.indexOf(hit)>=0) continue;
      found.push(hit);
    }
    found.sort(function(a,b){ if(a===b) return 0; var p=a.compareDocumentPosition(b); return (p&Node.DOCUMENT_POSITION_FOLLOWING)?-1:1; });
    return found;
  }
  function fbFeedMergeCards(primary,secondary){
    var out=primary.slice();
    for(var i=0;i<secondary.length;i++){ var card=secondary[i], overlap=false;
      for(var j=0;j<out.length;j++){ if(out[j]===card||out[j].contains(card)||card.contains(out[j])){ overlap=true; break; } }
      if(!overlap) out.push(card);
    }
    out.sort(function(a,b){ if(a===b) return 0; var p=a.compareDocumentPosition(b); return (p&Node.DOCUMENT_POSITION_FOLLOWING)?-1:1; });
    return out;
  }
  function fbFeedTopCards(root){
    var base=root||document;
    if(base===document){
      var feeds=document.querySelectorAll('div[role="feed"]');
      for(var i=0;i<feeds.length;i++){ if(!fbFeedVisible(feeds[i])) continue;
        return fbFeedMergeCards(fbFeedSemanticCards(feeds[i],false),fbFeedVideoCards(feeds[i],false)); }
      var videos=fbFeedVideoCards(document,false), fallback=fbFeedFallbackCards(document,false);
      var light=fbFeedMergeCards(videos,fallback); if(light.length>0) return light;
      return fbFeedSemanticCards(document,false);                                      // permalink 单帖页
    }
    var semantic=fbFeedSemanticCards(base,false), videos=fbFeedVideoCards(base,false);
    var merged=fbFeedMergeCards(semantic,videos); if(merged.length>0) return merged;
    return fbFeedFallbackCards(base,false); }
  function fbFeedClosestCard(el){
    if(!el) return null;
    var semantic=el.closest?el.closest('[role="article"],article'):null; if(semantic) return semantic;
    var videos=fbFeedVideoCards(document,true), videoHit=null;
    for(var v=0;v<videos.length;v++){ if(videos[v]===el||videos[v].contains(el)){ if(!videoHit||videoHit.contains(videos[v])) videoHit=videos[v]; } }
    if(videoHit) return videoHit;
    var fallback=fbFeedFallbackCards(document,true); var hit=null;
    for(var i=0;i<fallback.length;i++){ if(fallback[i]===el||fallback[i].contains(el)){ if(!hit||hit.contains(fallback[i])) hit=fallback[i]; } }
    return hit; }
  function fbFeedHasFallbackCard(root){ var base=root||document; return fbFeedVideoCards(base,false).length>0||fbFeedFallbackCards(base,false).length>0; }
  function fbFeedIsFallbackCard(el){ return fbFeedVideoCards(document,true).indexOf(el)>=0||fbFeedFallbackCards(document,true).indexOf(el)>=0; }
  function fbFeedAllPhysicalCards(root){
    var base=root||document; var out=Array.prototype.slice.call(base.querySelectorAll('[role="article"],article'));
    var videos=fbFeedVideoCards(base,true); for(var v=0;v<videos.length;v++){ if(out.indexOf(videos[v])<0) out.push(videos[v]); }
    var fallback=fbFeedFallbackCards(base,true); for(var i=0;i<fallback.length;i++){ if(out.indexOf(fallback[i])<0) out.push(fallback[i]); }
    return out; }
`;

/**
 * 页内三段式目标解析助手（like / comment 共用）。命名统一 `fbTgt*` 前缀，
 * 避免与各执行器自己的页内助手（fbVis / fbVisible / fbText…）重名。
 *
 * 三段式（design §3）：
 *  1. **作用域**：可见 `[role=dialog]`（取**最后打开的**，不是 querySelector 第一个）→ 否则 `div[role=feed]`
 *     → 否则 document（permalink 全页态）。document 只是作用域，**不是** DOM 序回落——身份匹配仍是硬条件。
 *  2. **顶层候选**：共享 feed-layout helper 给出的顶层卡（语义 article 或轻量 story-message 卡）。
 *  3. **身份匹配**：候选卡的 own-level canonical 链接派生的 postId 与命令 postId 相等。
 *
 * 卡的 canonical 链接 = **DOM 序里第一个可派生出 id 的 own-level 锚**（与 feed 扫卡产出 noteId 的规则同源：
 * 卡头时间戳 permalink 在正文/分享附件之前）——这样云端拿到的 noteId 与页内解析出的身份**必然同源**，
 * 分享子树里的「别人帖子的链接」永远排在卡头链接之后、抢不到身份。
 *
 * 兜底（URL 佐证的单帖态，**不是** DOM 序回落）：作用域内**恰好一张**顶层 article、它**派生不出任何身份**、
 * 且当前页 URL 的身份**等于**命令身份 → 认它为目标（我们就在这帖的 permalink 页上，页上只有这一帖）。
 */
export const FB_TARGET_HELPERS_JS = `${POST_IDENTITY_JS}${FB_FEED_LAYOUT_HELPERS_JS}
  function fbTgtVisible(el){ return fbFeedVisible(el); }
  function fbTgtClosestArticle(el){ return fbFeedClosestCard(el); }
  /** 卡身份：DOM 序首个 own-level（不在嵌套评论 article 内）且可派生 id 的锚。派生不出 → null。 */
  function fbTgtArticlePostId(a){ return fbFeedCardPostId(a); }
  function fbTgtTopArticles(root){ return fbFeedTopCards(root||document); }
  /**
   * 作用域根：最后打开的、**且真的含帖**的可见 dialog → 否则含帖的可见 feed → 否则 document。
   * 「含帖」这道闸不可省：FB 页面上常年挂着聊天 / cookie 同意 / 发帖 composer 之类的 [role=dialog]，
   * 无条件取最后一个可见 dialog 会让作用域落在一个**没有任何帖子**的弹层里 → 目标永远解析不到 → 点赞
   * 与评论双双永久失败（对抗性评审用真实执行器复现）。
   */
  function fbTgtScopeRoot(){
    var dialogs=document.querySelectorAll('[role="dialog"]');
    for(var i=dialogs.length-1;i>=0;i--){
      if(fbTgtVisible(dialogs[i]) && fbTgtTopArticles(dialogs[i]).length>0) return dialogs[i];
    }
    var feeds=document.querySelectorAll('div[role="feed"]');
    for(var j=0;j<feeds.length;j++){
      if(fbTgtVisible(feeds[j]) && fbTgtTopArticles(feeds[j]).length>0) return feeds[j];
    }
    return document; }
  /** 三段式解析：{status:'ok'|'no_target'|'ambiguous_target', el}。绝不回落 DOM 序第一张。 */
  function fbTgtResolve(targetId){
    if(!targetId) return {status:'no_target', el:null};
    var root=fbTgtScopeRoot(); var arts=fbTgtTopArticles(root); var hits=[];
    for(var i=0;i<arts.length;i++){ if(fbTgtArticlePostId(arts[i])===targetId) hits.push(arts[i]); }
    if(hits.length===1) return {status:'ok', el:hits[0]};
    if(hits.length>1) return {status:'ambiguous_target', el:null};
    if(arts.length===1 && fbTgtArticlePostId(arts[0])===null && fbCanonicalPostId(location.href)===targetId){
      return {status:'ok', el:arts[0]};                                                 // URL 佐证的单帖态
    }
    return {status:'no_target', el:null}; }
  /** 该 article 是否**携带**目标身份（own-level 锚里有任一锚派生出 targetId）。 */
  function fbTgtArticleCarriesId(article, targetId){ return !!targetId&&fbFeedCardPostId(article)===targetId; }
  /**
   * 目标帖的**排他区域**：从目标 article 向上爬，直到祖先里混进**任何别的顶层帖**（按**整个 document** 算，
   * 不只是作用域内）或爬到作用域根为止。该区域内、不属于任何 article 的节点（典型：帖子的评论输入框被 FB
   * 渲染在 article 之外、同一帖容器之内）**只可能**属于目标帖。
   *
   * 两道钳制缺一不可（都是对抗性评审在真实注入产物上复现出来的评错帖路径）：
   *  - **污染源按整个 document 算**：只按作用域内算的话，弹层里只有目标这一张帖 → others 为空 → 一路爬到 body
   *    → 背后 feed 里**别人帖子**的评论框也被纳入。
   *  - **绝不爬出作用域根**：同上。
   * 区域退化成 body / documentElement 而页面上还有别的帖 → 返回 null（宁可 editor_not_found，绝不放开全文档）。
   */
  function fbTgtExclusiveRegion(article){
    if(!article) return null;
    var scope=fbTgtScopeRoot();
    var rootEl=(scope===document)?(document.body||document.documentElement):scope;
    if(!rootEl||!rootEl.contains(article)) return null;
    // 污染源 = 全文档里**除目标外的所有** [role=article]（**含 0 尺寸 / 隐藏**）。绝不用「可见顶层帖」——
    // 一张 0 尺寸 / 折叠 / 动画中的旁帖若因不可见被漏算，区域会一路爬到 body、把它的评论框纳入 → 评错帖
    // （round-2 对抗性评审在真实注入产物上复现）。这里排他性证明要的是「区域内**物理上**没有第二张帖」，
    // 与可见性无关。
    var allArts=fbFeedAllPhysicalCards(document);
    var others=[]; for(var i=0;i<allArts.length;i++){ var a=allArts[i];
      if(a===article || article.contains(a) || a.contains(article)) continue;            // 目标自身 / 其嵌套评论 / 其祖先不算污染
      others.push(a); }
    var region=article;
    while(region!==rootEl && region.parentElement){
      var p=region.parentElement;
      if(p!==rootEl && !rootEl.contains(p)) break;                                       // 不得爬出作用域根
      var polluted=false;
      for(var j=0;j<others.length;j++){ if(p.contains(others[j])){ polluted=true; break; } }
      if(polluted) break;
      region=p;
    }
    // 区域退化成 body / documentElement 而文档里**还有别的帖**（others 已含隐藏帖）→ 拒（宁可
    // editor_not_found，绝不放开全文档）。用 others.length 而非 allArts.length：后者含目标自己的嵌套评论
    // article，会把「本帖评论框渲染在 article 外、页面上就这一张帖」的正常场景误杀成 editor_not_found。
    if(others.length>0 && (region===document.body || region===document.documentElement)) return null;
    return region; }
`;
