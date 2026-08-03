  const neutralLike=/^\s*(?:(?:给.+的帖子)?\s*(?:留下心情|赞一个|点赞|讚|like|react|reaccionar|me gusta|thích|j['’]aime)|bày tỏ cảm xúc thích(?: về bài viết của .+)?|bay to cam xuc thich(?: ve bai viet cua .+)?)\s*$/i;
  const unlike=/(取消赞|收回赞|收回|移除心情|移除赞|已赞|remove like|unlike|undo|gỡ thích|bỏ thích)/i;
  const reactedWord=/^\s*(赞|讚|大赞|超赞|like|love|care|haha|wow|me gusta|me encanta|thích|j['’]aime|j['’]adore|wouah|triste|grrr)\s*$/i;
  const reactionPickerLabel=/^\s*(?:给.+的帖子)?\s*(?:留下心情|react|reaccionar|réagir)\s*$/i;
  const pickerLike=/^\s*(赞|讚|like|me gusta|thích|j['’]aime)\s*$/i;
  const pickerReaction=/^\s*(赞|讚|like|love|care|haha|wow|sad|angry|me gusta|me encanta|thích|yêu thích|thương thương|buồn|phẫn nộ|j['’]aime|j['’]adore|wouah|triste|grrr)\s*$/i;
  const postComment=/(发表评论|發表評論|写评论|寫留言|评论.+帖子|comment|write a comment|comment.+post|comentar|viết bình luận|bình luận(?: về bài viết của .+)?|binh luan(?: ve bai viet cua .+)?)/i;
  const explicitReactionWitness=(button)=>{
    if(!button||!visible(button))return '';
    const accessible=label(button);
    const rendered=text(button,256);
    const numeric=/\d/.test(rendered);
    if(unlike.test(accessible)||unlike.test(rendered))return 'unlike_label';
    if(button.getAttribute('aria-pressed')==='true')return 'aria_pressed';
    if(button.getAttribute('aria-checked')==='true')return 'aria_checked';
    if(!numeric&&reactionPickerLabel.test(accessible)&&reactedWord.test(rendered))return 'reacted_text';
    if(!neutralLike.test(accessible)&&!numeric&&reactedWord.test(accessible))return 'reacted_label';
    return '';
  };
  const reactionState=(button)=>{
    if(!button||!visible(button))return '';
    const accessible=label(button);
    const rendered=text(button,256);
    if(explicitReactionWitness(button))return 'reacted';
    if(neutralLike.test(accessible)||neutralLike.test(rendered))return 'neutral';
    return '';
  };
  const reactionButton=(root)=>{
    const buttons=all('button,[role="button"]',root).filter(visible);
    return buttons.find((button)=>/^(赞|讚|like|me gusta|thích|j['’]aime)(\b|\s|$)/i.test(label(button)))||null;
  };
  // 反应汇总语义的标签前缀（去变音符后的形态）。与 reactionButton 的锚点分开维护：
  // 那一个必须继续选中可切换的中性控件（点它 = 赞），这一个只用于读数、绝不派发点击。
  const reactionCountPrefix=/^(?:赞|讚|like|me gusta|thich|bay to cam xuc thich|j['’]aime)/i;
  /**
   * 反应计数见证（只读数）。判据是两条**合取**：
   *   ① accessible label 或渲染文本里至少有一个数字；
   *   ② accessible label 去变音符后带反应汇总语义。
   * 只判①会把「3 条评论」「分享 12 次」这类带数字的中性控件误采；
   * 只判②会选中 DOM 序第一个的无文案纯 toggle（label 就是「赞」、innerText 为空），
   * 于是取值退回标签、再被计数解析器塌成 0 —— 这正是互动热度恒为 0 的机制。
   * 两条都不满足就继续往下找；一个都没有就返回空串 = 未观测（绝不臆造 0）。
   * 取值口径沿用退役实现：渲染文案优先，文案为空才退回标签。
   */
  const reactionCountWitness=(root)=>{
    const buttons=all('[role="button"][aria-label],button[aria-label]',root||document).filter(visible);
    for(const button of buttons){
      const accessible=label(button,96);
      const rendered=text(button,96);
      if(!/\d/.test(`${accessible} ${rendered}`))continue;
      if(!reactionCountPrefix.test(fold(accessible)))continue;
      return rendered||accessible;
    }
    return '';
  };
