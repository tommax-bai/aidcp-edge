import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNeutralLikeLabel, isCommentLabel, isReactedState } from '../../src/facebook/cta-labels.js';

test('cta-labels: 中性点赞按钮 aria-label 多语言命中', () => {
  assert.equal(isNeutralLikeLabel('留下心情'), true);
  assert.equal(isNeutralLikeLabel('给Oi Fong的帖子留下心情'), true);
  assert.equal(isNeutralLikeLabel('点赞'), true);
  assert.equal(isNeutralLikeLabel('Like'), true);
  assert.equal(isNeutralLikeLabel('React'), true);
  assert.equal(isNeutralLikeLabel('Me gusta'), true);
  assert.equal(isNeutralLikeLabel('Thích'), true);
  assert.equal(isNeutralLikeLabel('J’aime'), true);
  assert.equal(isNeutralLikeLabel("J'aime"), true);
  assert.equal(isNeutralLikeLabel('Bày tỏ cảm xúc Thích về bài viết của Diệp Lâm Anh'), true);
  // 反应计数汇总按钮 aria-label「赞」（带数字文案）不是中性点赞按钮——不命中。
  assert.equal(isNeutralLikeLabel('赞：3,706位用户'), false);
  // 反应项/已反应展示不是中性 toggle，不能抢在真 toggle 前面被选中。
  assert.equal(isNeutralLikeLabel('给Oi Fong的帖子留下心情：赞'), false);
  assert.equal(isNeutralLikeLabel('J’aime cette vidéo'), false, '法语自由文本不能冒充精确 Like 控件');
  assert.equal(isNeutralLikeLabel(''), false);
});

test('cta-labels: 帖级「评论」按钮标签命中（排除评论级 react 用）', () => {
  assert.equal(isCommentLabel('发表评论'), true);
  assert.equal(isCommentLabel('发表评论：66'), true);
  assert.equal(isCommentLabel('评论Oi Fong的帖子'), true);
  assert.equal(isCommentLabel('Comment'), true);
  assert.equal(isCommentLabel('Viết bình luận'), true);
  assert.equal(isCommentLabel('Bình luận'), true);
  assert.equal(isCommentLabel('Bình luận về bài viết của Diệp Lâm Anh'), true);
  assert.equal(isCommentLabel('回复'), false, '回复/Reply 不算帖级评论按钮');
  assert.equal(isCommentLabel('Reply'), false);
});

test('cta-labels: 已反应态判定（正向信号才算，绝不「变了就算」）', () => {
  // 空文案变反应词（zh 实测留下心情→赞）。
  assert.equal(isReactedState('留下心情', '赞'), true);
  // 撤销串（最可靠跨语言已赞信号）。
  assert.equal(isReactedState('取消赞', ''), true);
  assert.equal(isReactedState('Remove Like', ''), true);
  assert.equal(isReactedState('Gỡ Thích', ''), true);
  assert.equal(isReactedState('Bỏ thích', ''), true);
  assert.equal(isReactedState('Thích', 'Thích'), false, '越南语未赞按钮本身显示 Thích，不能冒充已赞');
  assert.equal(isReactedState('Bày tỏ cảm xúc Thích về bài viết của Diệp Lâm Anh', 'Thích'), false);
  assert.equal(isReactedState('J’aime', 'J’aime'), false, '法语未赞按钮本身显示 J’aime，不能冒充已赞');
  assert.equal(isReactedState('Réagir', 'J’aime'), true, '法语反应选择器出现精确反应词是正向见证');
  // 仍是中性、文案空 → 未反应。
  assert.equal(isReactedState('留下心情', ''), false);
  assert.equal(isReactedState('Like', ''), false);
});

test('cta-labels: 反应【计数汇总】按钮（aria-label=赞 + 数字文案）绝不误判已赞（数字守卫）', () => {
  // 关键回归：任何已有反应的帖子都有此按钮；误判会让 like 永远 no-op / 假 already_liked。
  assert.equal(isReactedState('赞', '3,829'), false);
  assert.equal(isReactedState('赞', '1.2万'), false);
  assert.equal(isReactedState('Like', '3,706'), false);
  assert.equal(isReactedState('Thích', '27K'), false);
  assert.equal(isReactedState('J’aime', '44'), false);
  // 撤销串即使带数字仍算已赞（撤销优先）。
  assert.equal(isReactedState('取消赞', '3,829'), true);
});
