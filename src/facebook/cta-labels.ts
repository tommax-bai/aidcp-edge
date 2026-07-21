/**
 * Facebook 反应（点赞）按钮的多语言 aria-label / 文案匹配。
 *
 * 背景（真机探针 docs/facebook-browse-and-like-loop-probe-findings.md §「Action bar / LIKE DISAMBIGUATION」）：
 *  - 帖级「点赞动作」按钮 = `[role=button][aria-label="留下心情"]` 或
 *    `[aria-label="给<作者>的帖子留下心情"]`（zh-CN），**文案为空**；单击即「赞/Like」。
 *    它与「赞：N」反应【计数汇总】按钮、以及反应项「给<作者>的帖子留下心情：赞」不同——后两者不是 toggle。
 *  - 已赞态确切串真机未拿到（留待 shadow task 8.2 收紧）；已知：react 后该按钮的**空文案会变成反应词**
 *    （中文实测变「赞」蓝字），或 aria-label 变「取消赞 / Remove Like」类「撤销」串。
 *
 * 本模块把这些判定做成：① Node 侧纯函数（可脱浏览器单测）；② 可注入进 in-page IIFE 的正则源串
 * （like 执行器用它在页面内定位/校验）。aria-label 是主锚点，绝不用自由文本命中（避免 feed 正文里的
 * 「Like」误配，见 comment-executor 的 CHROME 噪声）。多语言覆盖 zh-CN / zh-TW / en / es（本项目现役界面语言）。
 *
 * 红线：不确定即判「未反应」——绝不把「不确定」当「已赞」冒充成功（MUST NOT 静默假成功）。
 */

/** 中性「点赞动作」按钮的 aria-label（点它 = 赞）。锚点，不含数字计数串，也不含「：赞」反应项后缀。 */
export const NEUTRAL_LIKE_LABEL_SOURCE =
  '^\\s*(?:(?:给.+的帖子)?\\s*(?:留下心情|赞一个|点赞|讚|Like|React|Reaccionar|Me gusta|Thích)|Bày tỏ cảm xúc Thích(?: về bài viết của .+)?|Bay to cam xuc Thich(?: ve bai viet cua .+)?)\\s*$';
/** 帖级动作栏里的「评论」按钮 aria-label（前缀匹配）：帖级 react 按钮的同栏必含它，评论级 react 无。 */
export const COMMENT_LABEL_SOURCE = '(发表评论|發表評論|写评论|寫留言|评论.+帖子|Comment|Write a comment|Comment.+post|Comentar|Viết bình luận|Bình luận(?: về bài viết của .+)?|Binh luan(?: ve bai viet cua .+)?)';
/** 已反应后按钮呈现的「反应词」文案（空→非空，蓝字激活）。 */
export const REACTED_WORD_SOURCE = '^\\s*(赞|讚|大赞|超赞|Like|Love|Care|Haha|Wow|Me gusta|Me encanta|Thích)\\s*$';
/** 「撤销反应」串（其存在 = 当前已赞，最可靠的跨语言已赞信号）。 */
export const UNREACT_LABEL_SOURCE = '(取消赞|收回赞|收回|移除心情|移除赞|已赞|Remove Like|Unlike|Undo|Gỡ Thích|Bỏ thích)';
/** 点开反应选择器的中性标签；只有这类标签变出反应词文本时，文本才能作为已反应证据。 */
export const REACTION_PICKER_LABEL_SOURCE = '^\\s*(?:给.+的帖子)?\\s*(?:留下心情|React|Reaccionar)\\s*$';

/**
 * 页内共享的帖级反应控件分类器。
 *
 * Facebook 的本地化 UI 有两种都真实存在的计数布局：汇总按钮自己显示数字，或真正的点赞动作
 * 按钮在同一按钮内显示数字。因此数字只能描述呈现，不能单独决定“动作/汇总”。Feed 身份与 like
 * 执行器注入同一份 helper，避免扫描能认、执行器不能点（或反之）的漂移。
 */
export const FACEBOOK_REACTION_CONTROL_HELPERS_JS = `
  var fbCtaNeutralLikeRe=new RegExp(${JSON.stringify(NEUTRAL_LIKE_LABEL_SOURCE)},'i');
  var fbCtaCommentRe=new RegExp(${JSON.stringify(COMMENT_LABEL_SOURCE)},'i');
  var fbCtaReactedWordRe=new RegExp(${JSON.stringify(REACTED_WORD_SOURCE)},'i');
  var fbCtaUnreactRe=new RegExp(${JSON.stringify(UNREACT_LABEL_SOURCE)},'i');
  var fbCtaReactionPickerRe=new RegExp(${JSON.stringify(REACTION_PICKER_LABEL_SOURCE)},'i');
  function fbCtaLabel(el){ return String((el&&el.getAttribute&&el.getAttribute('aria-label'))||'').replace(/\\s+/g,' ').trim(); }
  function fbCtaText(el){ return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\\s+/g,' ').trim(); }
  function fbCtaMatches(re,el){ return re.test(fbCtaLabel(el))||re.test(fbCtaText(el)); }
  function fbCtaVisible(el){ if(!el||!el.getBoundingClientRect) return false; var r=el.getBoundingClientRect();
    if(r.width<=0||r.height<=0) return false; var s=window.getComputedStyle?getComputedStyle(el):null;
    return !s||(s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity||'1')>0.01); }
  function fbCtaBelongsToCard(card,el){
    if(!card||!el||!card.contains(el)) return false;
    var nested=el.closest?el.closest('[role="article"],article'):null;
    if(card.matches&&card.matches('[role="article"],article')) return nested===card;
    return !nested;
  }
  function fbCtaInsideSummaryToolbar(card,el){
    var toolbar=el&&el.closest?el.closest('[role="toolbar"]'):null;
    return !!(toolbar&&card&&card.contains(toolbar));
  }
  function fbCtaPostCommentControls(card){
    var out=[], controls=card&&card.querySelectorAll?card.querySelectorAll('[role="button"][aria-label],button[aria-label]'):[];
    for(var i=0;i<controls.length;i++){ var el=controls[i];
      if(!fbCtaBelongsToCard(card,el)||!fbCtaVisible(el)||fbCtaInsideSummaryToolbar(card,el)) continue;
      if(fbCtaMatches(fbCtaCommentRe,el)) out.push(el);
    }
    return out;
  }
  function fbCtaSharesPostCommentBar(card,btn){
    if(!card||!btn||fbCtaInsideSummaryToolbar(card,btn)) return false;
    var p=btn.parentElement;
    for(var depth=0;depth<6&&p;depth++,p=p.parentElement){
      if(!card.contains(p)) return false;
      var controls=p.querySelectorAll('[role="button"][aria-label],button[aria-label]'), comments=0;
      for(var i=0;i<controls.length;i++){ var el=controls[i];
        if(!fbCtaBelongsToCard(card,el)||!fbCtaVisible(el)||fbCtaInsideSummaryToolbar(card,el)) continue;
        if(fbCtaMatches(fbCtaCommentRe,el)) comments++;
      }
      if(comments===1) return true;
      if(p===card) break;
    }
    return false;
  }
  function fbCtaReactionState(card,el){
    if(!fbCtaBelongsToCard(card,el)||!fbCtaVisible(el)||fbCtaInsideSummaryToolbar(card,el)) return '';
    var label=fbCtaLabel(el), text=fbCtaText(el), numeric=/\\d/.test(text), state='';
    var selected=String(el.getAttribute&&el.getAttribute('aria-pressed')||'')==='true'||String(el.getAttribute&&el.getAttribute('aria-checked')||'')==='true';
    if(fbCtaUnreactRe.test(label)||fbCtaUnreactRe.test(text)) state='reacted';
    else if(fbCtaNeutralLikeRe.test(label)||fbCtaNeutralLikeRe.test(text)) state=(selected||(fbCtaReactionPickerRe.test(label)&&!numeric&&fbCtaReactedWordRe.test(text)))?'reacted':'neutral';
    else if(!numeric&&fbCtaReactedWordRe.test(label)) state='reacted';
    if(!state||!fbCtaSharesPostCommentBar(card,el)) return '';
    return state;
  }
  function fbCtaPostReactionControls(card){
    var out=[], controls=card&&card.querySelectorAll?card.querySelectorAll('[role="button"][aria-label],[role="radio"][aria-label],button[aria-label]'):[];
    for(var i=0;i<controls.length;i++){ var state=fbCtaReactionState(card,controls[i]);
      if(state) out.push({el:controls[i],state:state}); }
    return out;
  }
`;

const NEUTRAL_LIKE_RE = new RegExp(NEUTRAL_LIKE_LABEL_SOURCE, 'i');
const COMMENT_RE = new RegExp(COMMENT_LABEL_SOURCE, 'i');
const REACTED_WORD_RE = new RegExp(REACTED_WORD_SOURCE, 'i');
const UNREACT_RE = new RegExp(UNREACT_LABEL_SOURCE, 'i');
const REACTION_PICKER_RE = new RegExp(REACTION_PICKER_LABEL_SOURCE, 'i');

function norm(s: string | null | undefined): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 该 aria-label 是否为「中性点赞动作」按钮（点它 = 赞）。 */
export function isNeutralLikeLabel(label: string | null | undefined): boolean {
  return NEUTRAL_LIKE_RE.test(norm(label));
}

/** 该 aria-label 是否为帖级「评论」按钮（用于把帖级 react 与评论级 react 区分）。 */
export function isCommentLabel(label: string | null | undefined): boolean {
  return COMMENT_RE.test(norm(label));
}

/**
 * 根据点击后重读到的按钮 {aria-label, text} 判定是否「已赞」——正向信号才算，绝不「变了就算」。
 * 已赞 iff：撤销串命中（aria-label/text 含 取消赞/Remove Like/…），或 反应词文案出现（空→「赞」等激活词）。
 *
 * 【数字守卫】反应【计数汇总】按钮 aria-label 亦是「赞/Like」但带**数字文案**（如「3,829」），它不是点赞 toggle
 * （探针 §Action bar item①）；必须排除，否则会把「任何已有反应的帖子」误判为已赞（同 feed-reader 的 /\d/ 守卫）。
 */
export function isReactedState(label: string | null | undefined, text: string | null | undefined): boolean {
  const l = norm(label);
  const t = norm(text);
  const numeric = /\d/.test(t);
  if (UNREACT_RE.test(l) || UNREACT_RE.test(t)) return true;
  // 反应计数汇总按钮（aria-label 是反应词 + 数字文案）→ 非 toggle，绝不当已赞。
  if (numeric && REACTED_WORD_RE.test(l)) return false;
  // 「留下心情」中性按钮点后文案由空变反应词（zh 实测变「赞」，非数字）——正向信号。
  if (!numeric && REACTION_PICKER_RE.test(l) && REACTED_WORD_RE.test(t)) return true;
  // aria-label 由中性词翻成反应/撤销词（非中性、命中反应词、文案非数字）。
  if (!NEUTRAL_LIKE_RE.test(l) && !numeric && REACTED_WORD_RE.test(l)) return true;
  return false;
}
