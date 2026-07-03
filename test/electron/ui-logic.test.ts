import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 纯视图逻辑单测（edge-companion-ui）：健康合成 / 在场感动效门 / 发布卡状态机 / 相对时间。
const require = createRequire(import.meta.url);

interface Health { code: string; label: string; detail: string }
interface PresenceV { text: string; animate: boolean; fresh: string }
interface PublishV {
  mode: string;
  collapsed: { type: string; sentence: string } | null;
  showLink?: boolean;
  title?: string;
  head?: string;
  corner?: string;
  cornerHot?: boolean;
  stepStates?: string[];
  curCalm?: boolean;
  foot?: string;
}
const uiLogic = require('../../src/electron/renderer/ui-logic.js') as {
  relTime: (from: number, now: number) => string;
  synthesizeHealth: (s: Record<string, unknown>) => Health;
  bandTone: (s: Record<string, unknown>) => string;
  detailRows: (s: Record<string, unknown>) => Array<{ key: string; label: string; value: string }>;
  presenceView: (s: Record<string, unknown>, now: number) => PresenceV;
  loopIndex: (stage: string) => number;
  publishView: (p: Record<string, unknown> | null, last: Record<string, unknown> | null, now: number) => PublishV;
  PRESENCE_FRESH_MS: number;
};

function st(over: Record<string, unknown> = {}) {
  return {
    auth: 'logged in',
    cloud: 'connected',
    session: 'running',
    risk: 'normal',
    edge: 'running',
    presence: { text: '正在认真读一篇笔记…', at: new Date().toISOString() },
    ...over,
  };
}

// ── 健康合成 ──
test('健康合成：正常运行 → 运行中', () => {
  const h = uiLogic.synthesizeHealth(st());
  assert.equal(h.code, 'running');
  assert.match(h.label, /运行中/);
});

test('健康合成：任一路异常 → 需要注意', () => {
  assert.equal(uiLogic.synthesizeHealth(st({ auth: 'login required' })).code, 'attention');
  assert.equal(uiLogic.synthesizeHealth(st({ auth: 'config required' })).code, 'attention');
  assert.equal(uiLogic.synthesizeHealth(st({ edge: 'warning' })).code, 'attention');
  assert.equal(uiLogic.synthesizeHealth(st({ risk: 'frozen' })).code, 'attention');
  assert.equal(uiLogic.synthesizeHealth(st({ cloud: 'disconnected' })).code, 'attention');
});

test('健康合成：暂停 / 启动中 / 停止', () => {
  assert.equal(uiLogic.synthesizeHealth(st({ session: 'paused', edge: 'stopped' })).code, 'paused');
  assert.equal(uiLogic.synthesizeHealth(st({ edge: 'starting', session: 'running', cloud: 'disconnected' })).code, 'ready');
  assert.equal(uiLogic.synthesizeHealth(st({ edge: 'stopped', session: 'idle', cloud: 'disconnected' })).code, 'ready');
});

test('标题带色调随风控状态', () => {
  assert.equal(uiLogic.bandTone(st()), 'normal');
  assert.equal(uiLogic.bandTone(st({ risk: 'warned' })), 'warned');
  assert.equal(uiLogic.bandTone(st({ risk: 'restricted' })), 'danger');
  assert.equal(uiLogic.bandTone(st({ risk: 'frozen' })), 'danger');
});

test('五路明细用人话（内部词不外露）', () => {
  const rows = uiLogic.detailRows(st({ edge: 'running' }));
  const edgeRow = rows.find((r) => r.key === 'edge');
  assert.equal(edgeRow?.label, '本机引擎');
  const riskRow = rows.find((r) => r.key === 'risk');
  assert.equal(riskRow?.label, '账号保护');
});

// ── 在场感动效门（红线：绝不用动效盖住停滞会话）──
test('在场感：运行中 + 事件新鲜 → 动效开、文案为当前动作', () => {
  const now = Date.now();
  const v = uiLogic.presenceView(st({ presence: { text: '正在认真读「x」…', at: new Date(now - 10_000).toISOString() } }), now);
  assert.equal(v.animate, true);
  assert.match(v.text, /正在认真读/);
  assert.match(v.fresh, /秒前/);
});

test('在场感：运行中但事件过期（>5min）→ 动效关、如实说没有新动态', () => {
  const now = Date.now();
  const v = uiLogic.presenceView(st({ presence: { text: '正在认真读「x」…', at: new Date(now - 6 * 60_000).toISOString() } }), now);
  assert.equal(v.animate, false);
  assert.match(v.text, /没有新动态/);
});

test('在场感：暂停 / 停止 / 需登录 → 静态诚实文案', () => {
  const now = Date.now();
  const paused = uiLogic.presenceView(st({ session: 'paused', edge: 'stopped', presence: { text: 'x', at: new Date(now - 8000).toISOString() } }), now);
  assert.equal(paused.animate, false);
  assert.match(paused.fresh, /状态更新/, '暂停态也要有时间戳、不留大空白');
  const stopped = uiLogic.presenceView(st({ edge: 'stopped', session: 'idle' }), now);
  assert.equal(stopped.animate, false);
  assert.match(stopped.text, /待命/);
  const login = uiLogic.presenceView(st({ auth: 'login required', edge: 'stopped', session: 'idle' }), now);
  assert.match(login.text, /登录/);
});

// ── 发布卡状态机（只读投影）──
test('发布卡：候审 → 第三节点琥珀、脚注指向飞书、绝无「已再提醒」', () => {
  const now = Date.now();
  const v = uiLogic.publishView({ state: 'pending', title: '秋日漫步', at: new Date(now - 3 * 60_000).toISOString() }, null, now);
  assert.equal(v.mode, 'flow');
  assert.deepEqual(v.stepStates, ['done', 'done', 'cur', 'todo']);
  assert.match(v.corner ?? '', /已等 3 分钟/);
  assert.equal(v.cornerHot, false);
  assert.match(v.foot ?? '', /飞书/);
  assert.ok(!(v.foot ?? '').includes('再次提醒'), '未收到再提醒事件绝不谎称已提醒');
});

test('发布卡：等超 30 分钟 → 时长琥珀化，仍不谎称已提醒（宁缺毋假）', () => {
  const now = Date.now();
  const v = uiLogic.publishView({ state: 'pending', title: 't', at: new Date(now - 34 * 60_000).toISOString() }, null, now);
  assert.equal(v.cornerHot, true);
  assert.ok(!(v.foot ?? '').includes('再次提醒'));
});

test('发布卡：收到明确再提醒事件 → 才展示「已在飞书再次提醒」', () => {
  const now = Date.now();
  const v = uiLogic.publishView({ state: 'reminded', title: 't', at: new Date(now - 34 * 60_000).toISOString() }, null, now);
  assert.match(v.foot ?? '', /再次提醒/);
});

test('发布卡：已通过 → 第四节点平静色 + 明示无需操作', () => {
  const v = uiLogic.publishView({ state: 'approved', title: 't', at: new Date().toISOString() }, null, Date.now());
  assert.deepEqual(v.stepStates, ['done', 'done', 'done', 'cur']);
  assert.equal(v.curCalm, true);
  assert.match(v.foot ?? '', /无需操作/);
});

test('发布卡：已发布 → 折进活动流 + 卡片转「上次发布」（常驻）', () => {
  const now = Date.now();
  const pub = uiLogic.publishView({ state: 'published', title: '秋日漫步', at: new Date(now - 2 * 3_600_000).toISOString() }, null, now);
  assert.equal(pub.mode, 'last');
  assert.match(pub.collapsed?.sentence ?? '', /已发布/);
  assert.equal(pub.head, '上次发布');
  assert.match(pub.corner ?? '', /小时前/);
  assert.deepEqual(pub.stepStates, ['done', 'done', 'done', 'done']);
  assert.equal(pub.showLink, false, '历史态不放「打开飞书」');
});

test('发布卡：拒绝 → 折进活动流（不渲染成失败）+ 回落上次发布/空态', () => {
  const now = Date.now();
  const rej = uiLogic.publishView({ state: 'rejected', at: new Date(now).toISOString() }, { title: '旧文', at: new Date(now - 86_400_000).toISOString() }, now);
  assert.match(rej.collapsed?.sentence ?? '', /暂不发布/);
  assert.ok(!(rej.collapsed?.sentence ?? '').includes('失败'), '拒绝不渲染成失败');
  assert.equal(rej.mode, 'last');
  assert.equal(rej.title, '旧文');
  const rejEmpty = uiLogic.publishView({ state: 'rejected', at: new Date(now).toISOString() }, null, now);
  assert.equal(rejEmpty.mode, 'empty');
});

test('发布卡常驻：无进行中有历史 → last；两者皆无 → empty 幽灵旅程', () => {
  const now = Date.now();
  const last = uiLogic.publishView(null, { title: '秋日漫步', at: new Date(now - 3 * 86_400_000).toISOString() }, now);
  assert.equal(last.mode, 'last');
  assert.match(last.corner ?? '', /天前/);
  const empty = uiLogic.publishView(null, null, now);
  assert.equal(empty.mode, 'empty');
  assert.deepEqual(empty.stepStates, ['todo', 'todo', 'todo', 'todo']);
  assert.match(empty.title ?? '', /还没有发布过/);
  assert.equal(empty.showLink, false);
});

test('相对时间走字', () => {
  const now = Date.now();
  assert.equal(uiLogic.relTime(now - 1000, now), '刚刚');
  assert.equal(uiLogic.relTime(now - 30_000, now), '30 秒前');
  assert.equal(uiLogic.relTime(now - 5 * 60_000, now), '5 分钟前');
});
