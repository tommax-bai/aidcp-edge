import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldOpenCard,
  RELEVANT_KEYWORDS,
  IRRELEVANT_PATTERNS,
  MIN_LIKES,
} from '../../src/browse/card-filter.js';
import type { NoteCard } from '../../src/browse/feed-scroller.js';

function card(over: Partial<NoteCard>): NoteCard {
  return { position: 0, centerX: 0, centerY: 0, ...over };
}

test('card-filter: 导出的配置非空且类型正确', () => {
  assert.ok(Array.isArray(RELEVANT_KEYWORDS) && RELEVANT_KEYWORDS.length > 0);
  assert.ok(Array.isArray(IRRELEVANT_PATTERNS) && IRRELEVANT_PATTERNS.length > 0);
  assert.ok(IRRELEVANT_PATTERNS.every((re) => re instanceof RegExp));
  assert.equal(typeof MIN_LIKES, 'number');
});

test('card-filter: likes 低于阈值直接跳过', () => {
  const r = shouldOpenCard(card({ likes: '12', title: 'AI 大模型' }));
  assert.equal(r.open, false);
  assert.equal(r.reason, 'likes=12');
});

test('card-filter: likes 达到阈值且标题相关则打开', () => {
  const r = shouldOpenCard(card({ likes: '1.2w', title: 'LLM 推理优化' }));
  assert.equal(r.open, true);
});

test('card-filter: 明显无关标题（游戏）被跳过', () => {
  const r = shouldOpenCard(card({ title: '原神新角色抽卡攻略', likes: '999' }));
  assert.equal(r.open, false);
  assert.equal(r.reason, '原神新角色抽卡攻略');
});

test('card-filter: 明显无关标题（美食）被跳过', () => {
  const r = shouldOpenCard(card({ title: '探店！这家奶茶绝了' }));
  assert.equal(r.open, false);
});

test('card-filter: 无关模式但命中相关关键词则放行（误放优先）', () => {
  // 命中"游戏"(IRRELEVANT) 但也命中"AI"(RELEVANT) → 放行
  const r = shouldOpenCard(card({ title: '用 AI 做游戏开发的工程实践' }));
  assert.equal(r.open, true);
});

test('card-filter: 相关标题（技术）放行', () => {
  for (const title of ['vLLM 部署实战', 'RAG 检索增强生成', '一个开源 Agent 框架', 'Prompt 工程技巧']) {
    assert.equal(shouldOpenCard(card({ title })).open, true, title);
  }
});

test('card-filter: 无标题无 likes → 放行（无法判定）', () => {
  const r = shouldOpenCard(card({}));
  assert.equal(r.open, true);
});

test('card-filter: 中性无关标题（既不命中相关也不命中无关）→ 放行', () => {
  // "今天天气真好" 不命中任何无关模式 → 保守放行
  const r = shouldOpenCard(card({ title: '今天天气真好啊' }));
  assert.equal(r.open, true);
});

test('card-filter: likes 优先于标题（低赞相关标题也跳过）', () => {
  const r = shouldOpenCard(card({ likes: '5', title: 'AI 大模型' }));
  assert.equal(r.open, false);
  assert.equal(r.reason, 'likes=5');
});

test('card-filter: 空字符串标题视为无标题 → 放行', () => {
  const r = shouldOpenCard(card({ title: '   ' }));
  assert.equal(r.open, true);
});
