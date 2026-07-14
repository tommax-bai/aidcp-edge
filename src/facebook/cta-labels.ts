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
  '^\\s*(?:给.+的帖子)?\\s*(留下心情|赞一个|点赞|讚|Like|React|Reaccionar|Me gusta)\\s*$';
/** 帖级动作栏里的「评论」按钮 aria-label（前缀匹配）：帖级 react 按钮的同栏必含它，评论级 react 无。 */
export const COMMENT_LABEL_SOURCE = '(发表评论|發表評論|写评论|寫留言|评论.+帖子|Comment|Write a comment|Comment.+post|Comentar)';
/** 已反应后按钮呈现的「反应词」文案（空→非空，蓝字激活）。 */
export const REACTED_WORD_SOURCE = '^\\s*(赞|讚|大赞|超赞|Like|Love|Care|Haha|Wow|Me gusta|Me encanta)\\s*$';
/** 「撤销反应」串（其存在 = 当前已赞，最可靠的跨语言已赞信号）。 */
export const UNREACT_LABEL_SOURCE = '(取消赞|收回赞|收回|移除心情|移除赞|已赞|Remove Like|Unlike|Undo)';

const NEUTRAL_LIKE_RE = new RegExp(NEUTRAL_LIKE_LABEL_SOURCE, 'i');
const COMMENT_RE = new RegExp(COMMENT_LABEL_SOURCE, 'i');
const REACTED_WORD_RE = new RegExp(REACTED_WORD_SOURCE, 'i');
const UNREACT_RE = new RegExp(UNREACT_LABEL_SOURCE, 'i');

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
  if (!numeric && REACTED_WORD_RE.test(t)) return true;
  // aria-label 由中性词翻成反应/撤销词（非中性、命中反应词、文案非数字）。
  if (!NEUTRAL_LIKE_RE.test(l) && !numeric && REACTED_WORD_RE.test(l)) return true;
  return false;
}
