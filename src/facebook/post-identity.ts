/**
 * Facebook 规范帖子身份（canonical post identity）+ 三段式目标解析的**唯一**来源。
 *
 * 为什么要有这一层（change facebook-note-scoped-targeting）：
 * 旧实现把「点哪张卡 / 评哪张卡」建立在「某个链接的 URL」上——key 既不唯一（一卡多链接）、不稳定
 * （一帖多形态：`/groups/g/posts/p` 与 `/groups/g/?multi_permalinks=p` 是同一帖）、也不排他（别人的卡里
 * 也可能出现你的链接）；而且两处派生逻辑语义不一致（like-executor 的局部 postKey 丢 multi_permalinks，
 * page-structure 的 sanitize 保留它）→ 同群两个 multi_permalinks 帖撞成同一个 key，即使在详情页也会锁错卡。
 *
 * 红线（本文件兑现）：
 *  - **派生失败返回 null，绝不返回空串**：空串对任何坏 href 都相等，会让「匹配不到」退化成「又点第一张卡」。
 *  - **绝不 DOM 序回落**：解析出 0 个 → no_target，同层 >1 个 → ambiguous_target，恰好 1 个才动手。
 *  - **评论链接不是帖身份**：带 comment_id / reply_comment_id 的 href 一律 null。
 *  - **嵌套（评论）article 内的链接不参与卡身份派生**。
 */

/**
 * 从任意 Facebook 链接派生规范帖子身份 `fb:<postId>`；派生不出返回 `null`。
 *
 * **两道闸**：
 *  ① **形状白名单**——只有「帖子 permalink 形状」的链接才配派生帖身份（与 feed 扫卡挑 noteId 的谓词同源）。
 *     否则 FB 卡头的**作者主页链接** `/people/<slug>/pfbid…/`（2022 后无自定义用户名的账号大量是这形态）
 *     也会派生出一个 id，且它在 DOM 序上排在时间戳 permalink **之前** → 卡身份变成「作者身份」→ 该作者的
 *     每一张卡都永久解析不到目标（对抗性评审在真实注入产物上复现）。同理排除 `/photos/pfbid…`。
 *  ② **postId 全局唯一即身份**——不带 container。FB 的 post fbid / pfbid / 视频 id 本就全局唯一，container
 *     对唯一性零贡献，却会制造**同一帖两个身份**：`/Meta/posts/X`（container=主页 slug）与
 *     `/permalink.php?story_fbid=X&id=<主页数字 id>`（container=数字 id）是同一帖却不相等 → 确定性 no_target。
 *     去掉 container 后，同一帖的所有形态（群帖 posts / multi_permalinks / permalink、主页帖 posts /
 *     permalink.php / story.php、视频 videos / watch）**必然**收敛到同一个 id。
 *
 * postId 优先级：`/posts/<id>` → `/permalink/<id>` → `story_fbid` → `multi_permalinks` → 路径中的 `pfbid…` 段
 * → `/videos/<id>` / `/reel/<id>` / `/watch?v=<id>`（视频帖也是 feed 卡，不派生身份等于砍掉视频帖的点赞能力）。
 *
 * ⚠️ 本函数**必须自包含**：只用 `URL` / 正则 / 数组，绝不引用任何模块作用域标识符——
 * 它的函数体经 `toString()` 原样注入页面（见 POST_IDENTITY_JS），页内与 Node 侧共用**同一份实现**，
 * 结构上杜绝「两份实现漂移」（parity 由 test/facebook/post-identity.test.ts 对拍守）。
 */
export function canonicalPostId(href: string | null | undefined): string | null {
  const raw = String(href ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, 'https://www.facebook.com/');
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // 评论 permalink 标识的是**评论**、不是帖子——绝不拿它冒充帖身份。
  if (url.searchParams.has('comment_id') || url.searchParams.has('reply_comment_id')) return null;

  const path = url.pathname;
  const lowerPath = path.toLowerCase();
  // ① 形状白名单：不是帖子 permalink 形状的链接（作者主页 / 群主页 / 图片 / 好友列表…）一律不派生身份。
  const postShaped =
    /\/posts\/[^/?#]+/.test(lowerPath) ||
    /\/permalink\/[^/?#]+/.test(lowerPath) ||
    /\/permalink\.php/.test(lowerPath) ||
    /\/story\.php/.test(lowerPath) ||
    /\/videos\/[^/?#]+/.test(lowerPath) ||
    /\/reel\/[^/?#]+/.test(lowerPath) ||
    ((lowerPath === '/watch' || lowerPath === '/watch/') && url.searchParams.has('v')) ||
    url.searchParams.has('story_fbid') ||
    url.searchParams.has('multi_permalinks');
  if (!postShaped) return null;

  const segs = path.split('/').filter(function (s) {
    return s.length > 0;
  });
  const lower = segs.map(function (s) {
    return s.toLowerCase();
  });

  let postId = '';
  const iPosts = lower.indexOf('posts');
  const iPermalink = lower.indexOf('permalink');
  if (iPosts >= 0 && segs[iPosts + 1]) postId = segs[iPosts + 1];
  else if (iPermalink >= 0 && segs[iPermalink + 1]) postId = segs[iPermalink + 1];
  else if (url.searchParams.get('story_fbid')) postId = String(url.searchParams.get('story_fbid'));
  else if (url.searchParams.get('multi_permalinks')) postId = String(url.searchParams.get('multi_permalinks'));
  if (!postId) {
    for (let i = 0; i < segs.length; i++) {
      if (/^pfbid[A-Za-z0-9]+$/.test(segs[i])) {
        postId = segs[i];
        break;
      }
    }
  }
  if (!postId) {
    const iVideos = lower.indexOf('videos');
    const iReel = lower.indexOf('reel');
    if (iVideos >= 0 && segs[iVideos + 1]) postId = segs[iVideos + 1];
    else if (iReel >= 0 && segs[iReel + 1]) postId = segs[iReel + 1];
    else if (lower[0] === 'watch' && url.searchParams.get('v')) postId = String(url.searchParams.get('v'));
  }
  if (!postId) return null;

  return 'fb:' + postId;
}

/**
 * 页内版身份派生：**同一份实现**注入页面（不是第二份拷贝）。
 * 页内以 `fbCanonicalPostId(href)` 调用；派生不出返回 null。
 */
export const POST_IDENTITY_JS = `var fbCanonicalPostId = ${canonicalPostId.toString()};`;

/**
 * 页内三段式目标解析助手（like / comment 共用）。命名统一 `fbTgt*` 前缀，
 * 避免与各执行器自己的页内助手（fbVis / fbVisible / fbText…）重名。
 *
 * 三段式（design §3）：
 *  1. **作用域**：可见 `[role=dialog]`（取**最后打开的**，不是 querySelector 第一个）→ 否则 `div[role=feed]`
 *     → 否则 document（permalink 全页态）。document 只是作用域，**不是** DOM 序回落——身份匹配仍是硬条件。
 *  2. **顶层候选**：祖先链上没有别的 `[role=article]` 的 article（排除嵌套的评论 article）。
 *  3. **身份匹配**：候选卡的 canonical 链接派生的 postId 与命令 postId 相等。
 *
 * 卡的 canonical 链接 = **DOM 序里第一个可派生出 id 的 own-level 锚**（与 feed 扫卡产出 noteId 的规则同源：
 * 卡头时间戳 permalink 在正文/分享附件之前）——这样云端拿到的 noteId 与页内解析出的身份**必然同源**，
 * 分享子树里的「别人帖子的链接」永远排在卡头链接之后、抢不到身份。
 *
 * 兜底（URL 佐证的单帖态，**不是** DOM 序回落）：作用域内**恰好一张**顶层 article、它**派生不出任何身份**、
 * 且当前页 URL 的身份**等于**命令身份 → 认它为目标（我们就在这帖的 permalink 页上，页上只有这一帖）。
 */
export const FB_TARGET_HELPERS_JS = `${POST_IDENTITY_JS}
  function fbTgtVisible(el){ if(!el||!el.getBoundingClientRect) return false; var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) return false; var s=window.getComputedStyle?getComputedStyle(el):null; return !s||(s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity||'1')>0.01); }
  function fbTgtClosestArticle(el){ return (el&&el.closest)?el.closest('[role="article"], article'):null; }
  /** 卡身份：DOM 序首个 own-level（不在嵌套评论 article 内）且可派生 id 的锚。派生不出 → null。 */
  function fbTgtArticlePostId(a){ if(!a||!a.querySelectorAll) return null;
    var links=a.querySelectorAll('a[href]');
    for(var i=0;i<links.length;i++){ var el=links[i];
      if(fbTgtClosestArticle(el)!==a) continue;                       // 嵌套评论 article 里的链接不参与卡身份
      var raw=String(el.getAttribute('href')||'').trim(); if(!raw) continue;
      var id=fbCanonicalPostId(raw); if(id) return id;
    }
    return null; }
  function fbTgtTopArticles(root){
    var arts=(root||document).querySelectorAll('[role="article"], article'); var out=[];
    for(var i=0;i<arts.length;i++){ var a=arts[i]; if(!fbTgtVisible(a)) continue;
      if(a.parentElement && fbTgtClosestArticle(a.parentElement)) continue;             // 嵌套（评论）article
      out.push(a); }
    return out; }
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
  function fbTgtArticleCarriesId(article, targetId){
    if(!article||!targetId||!article.querySelectorAll) return false;
    var links=article.querySelectorAll('a[href]');
    for(var i=0;i<links.length;i++){ var el=links[i];
      if(fbTgtClosestArticle(el)!==article) continue;
      if(fbCanonicalPostId(String(el.getAttribute('href')||'').trim())===targetId) return true;
    }
    return false; }
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
    var tops=fbTgtTopArticles(document);                                                 // 污染源 = 全文档的顶层帖
    var others=[]; for(var i=0;i<tops.length;i++){ if(tops[i]!==article) others.push(tops[i]); }
    var region=article;
    while(region!==rootEl && region.parentElement){
      var p=region.parentElement;
      if(p!==rootEl && !rootEl.contains(p)) break;                                       // 不得爬出作用域根
      var polluted=false;
      for(var j=0;j<others.length;j++){ if(p.contains(others[j])){ polluted=true; break; } }
      if(polluted) break;
      region=p;
    }
    if(others.length>0 && (region===document.body || region===document.documentElement)) return null;
    return region; }
`;
