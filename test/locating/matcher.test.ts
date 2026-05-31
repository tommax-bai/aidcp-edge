import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAnchor } from '../../src/locating/index.js';
import type { Anchor, ElementDescriptor } from '../../src/locating/index.js';

function el(index: number, role: string, text: string, attributes: Record<string, string> = {}): ElementDescriptor {
  return { index, role, tag: 'button', text, attributes, clickable: true, path: `/button[${index + 1}]` };
}

test('唯一高置信度 → hit', () => {
  const anchor: Anchor = { actionId: 'follow', role: 'button', text: '关注', textMatch: 'exact' };
  const els = [el(0, 'button', '关注'), el(1, 'button', '收藏'), el(2, 'link', '更多')];
  const r = matchAnchor(anchor, els);
  assert.equal(r.status, 'hit');
  assert.equal(r.element?.index, 0);
  assert.ok(r.confidence >= 0.6);
  assert.ok(r.margin >= 0.15);
});

test('多个等价候选 → ambiguous（防静默误命中）', () => {
  const anchor: Anchor = { actionId: 'like', role: 'button', text: '点赞', textMatch: 'contains' };
  const els = [el(0, 'button', '点赞'), el(1, 'button', '点赞')];
  const r = matchAnchor(anchor, els);
  assert.equal(r.status, 'ambiguous', '并列候选应判 ambiguous 而非随便点一个');
  assert.equal(r.candidates.length, 2);
});

test('信号都不匹配 → miss', () => {
  const anchor: Anchor = { actionId: 'pub', role: 'button', text: '发布', textMatch: 'exact' };
  const els = [el(0, 'link', '首页'), el(1, 'textbox', '搜索框')];
  const r = matchAnchor(anchor, els);
  assert.equal(r.status, 'miss');
  assert.ok(r.confidence < 0.6);
});

test('稳定属性提升唯一性，打破并列', () => {
  const anchor: Anchor = {
    actionId: 'send',
    role: 'button',
    text: '发送',
    textMatch: 'exact',
    attributes: { 'data-testid': 'dm-send' },
  };
  const els = [
    el(0, 'button', '发送', { 'data-testid': 'dm-send' }),
    el(1, 'button', '发送', { 'data-testid': 'comment-send' }),
  ];
  const r = matchAnchor(anchor, els);
  assert.equal(r.status, 'hit');
  assert.equal(r.element?.attributes['data-testid'], 'dm-send');
});

test('空清单 → miss', () => {
  const anchor: Anchor = { actionId: 'x', role: 'button', text: '关注' };
  const r = matchAnchor(anchor, []);
  assert.equal(r.status, 'miss');
});
