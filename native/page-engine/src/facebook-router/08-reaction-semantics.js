  const neutralLike=/^\s*(?:(?:给.+的帖子)?\s*(?:留下心情|赞一个|点赞|讚|like|react|reaccionar|me gusta|thích)|bày tỏ cảm xúc thích(?: về bài viết của .+)?|bay to cam xuc thich(?: ve bai viet cua .+)?)\s*$/i;
  const unlike=/(取消赞|收回赞|收回|移除心情|移除赞|已赞|remove like|unlike|undo|gỡ thích|bỏ thích)/i;
  const reactedWord=/^\s*(赞|讚|大赞|超赞|like|love|care|haha|wow|me gusta|me encanta|thích)\s*$/i;
  const reactionPickerLabel=/^\s*(?:给.+的帖子)?\s*(?:留下心情|react|reaccionar)\s*$/i;
  const pickerLike=/^\s*(赞|讚|like|me gusta|thích)\s*$/i;
  const pickerReaction=/^\s*(赞|讚|like|love|care|haha|wow|sad|angry|me gusta|me encanta|thích|yêu thích|thương thương|buồn|phẫn nộ)\s*$/i;
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
    return buttons.find((button)=>/^(赞|讚|like|me gusta|thích)(\b|\s|$)/i.test(label(button)))||null;
  };
