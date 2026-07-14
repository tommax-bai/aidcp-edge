import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 纯视图逻辑单测（edge-companion-ui）：健康合成 / 在场感动效门 / 发布卡状态机 / 相对时间。
const require = createRequire(import.meta.url);

interface Health { code: string; label: string; detail: string }
interface PresenceV { text: string; animate: boolean; fresh: string }
interface RuntimeGuidanceV {
  mode: 'running' | 'session' | 'hour' | 'day';
  mascot: string;
  animate: boolean;
  kicker: string;
  title: string;
  value?: string;
  detail: string;
  resume: string;
  note?: string;
  steps: Array<{ label: string; detail: string; state: string }>;
}
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
interface PublishDockV { collapsed: boolean; label: string; summary: string }
const uiLogic = require('../../src/electron/renderer/ui-logic.js') as {
  relTime: (from: number, now: number) => string;
  synthesizeHealth: (s: Record<string, unknown>) => Health;
  bandTone: (s: Record<string, unknown>) => string;
  detailRows: (s: Record<string, unknown>) => Array<{ key: string; label: string; value: string }>;
  presenceView: (s: Record<string, unknown>, now: number) => PresenceV;
  runtimeGuidanceView: (s: Record<string, unknown>, now: number) => RuntimeGuidanceV | null;
  loopIndex: (stage: string) => number;
  publishView: (p: Record<string, unknown> | null, last: Record<string, unknown> | null, now: number) => PublishV;
  publishDock: (v: PublishV, s: Record<string, unknown>, manualOpen: boolean) => PublishDockV;
  railDisplayName: (row: Record<string, unknown>) => string;
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

test('健康合成：可恢复状态需要协助，真正中断状态为错误', () => {
  assert.equal(uiLogic.synthesizeHealth(st({ auth: 'login required' })).code, 'attention');
  assert.equal(uiLogic.synthesizeHealth(st({ auth: 'config required' })).code, 'attention');
  assert.equal(uiLogic.synthesizeHealth(st({ edge: 'warning' })).code, 'error');
  assert.equal(uiLogic.synthesizeHealth(st({ risk: 'frozen' })).code, 'error');
  assert.equal(uiLogic.synthesizeHealth(st({ cloud: 'disconnected' })).code, 'attention');
  assert.equal(uiLogic.synthesizeHealth(st({ risk: 'restricted' })).code, 'attention');
});

test('健康合成：暂停 / 启动中 / 停止', () => {
  assert.equal(uiLogic.synthesizeHealth(st({ session: 'paused', edge: 'stopped' })).code, 'paused');
  const closed = uiLogic.synthesizeHealth(st({ session: 'closed', edge: 'stopped', cloud: 'disconnected' }));
  assert.equal(closed.label, '已关闭');
  assert.match(closed.detail, /启动/);
  const resting = uiLogic.synthesizeHealth(st({ session: 'resting', edge: 'running' }));
  assert.equal(resting.code, 'paused');
  assert.match(resting.label, /等待下一轮/);
  assert.equal(uiLogic.synthesizeHealth(st({ edge: 'starting', session: 'running', cloud: 'disconnected' })).code, 'ready');
  assert.equal(uiLogic.synthesizeHealth(st({ edge: 'stopped', session: 'idle', cloud: 'disconnected' })).code, 'ready');
});

test('标题带色调随风控状态', () => {
  assert.equal(uiLogic.bandTone(st()), 'normal');
  assert.equal(uiLogic.bandTone(st({ risk: 'warned' })), 'warned');
  assert.equal(uiLogic.bandTone(st({ risk: 'restricted' })), 'warned');
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

test('在场感：运行中但事件过期 + 当前阶段完成 → 文案说明成果和预计继续时间', () => {
  const now = Date.now();
  const v = uiLogic.presenceView(st({
    presence: { text: '正在继续浏览…', at: new Date(now - 6 * 60_000).toISOString() },
    dailyUsage: {
      totals: { view: 38, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
      saturated: [],
      windows: {
        hour: {
          startedAt: now - 24 * 60_000,
          windowMs: 3_600_000,
          expiresAt: now + 36 * 60_000,
          releaseAt: now + 36 * 60_000,
          totals: { view: 38, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
          quotas: { view: 38, like: 3, collect: 2, comment: 1, follow: 1, publish: 1 },
          saturated: ['view'],
        },
      },
    },
  }), now);
  assert.equal(v.animate, false);
  assert.match(v.text, /这一小时的探索告一段落/);
  assert.match(v.fresh, /约 36 分钟后自动继续/);
});

test('运行价值说明：新鲜浏览事件先说明正在寻找内容灵感', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    presence: { text: '正在认真读「x」…', at: new Date(now - 10_000).toISOString() },
  }), now);
  assert.equal(v?.mode, 'running');
  assert.equal(v?.mascot, 'task-execution');
  assert.equal(v?.animate, true);
  assert.equal(v?.kicker, '为你探索');
  assert.match(v?.title ?? '', /内容灵感/);
  assert.equal(v?.detail, '观察平台推荐的内容，寻找正在上升的话题。');
});

test('运行价值说明：本轮浏览完成才展示自然间隔与三步说明', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    session: 'resting',
    presence: { text: '旧事件', at: new Date(now - 6 * 60_000).toISOString() },
    dailyUsage: {
      windows: {
        session: {
          active: true,
          releaseAt: now + 42 * 60_000,
          totals: { view: 12, like: 1, collect: 2 },
          quotas: { view: 12, like: 3 },
          saturated: ['view'],
        },
      },
    },
  }), now);
  assert.equal(v?.mode, 'session');
  assert.equal(v?.mascot, 'monitoring');
  assert.equal(v?.animate, false);
  assert.match(v?.title ?? '', /整理/);
  assert.match(v?.value ?? '', /自然节奏/);
  assert.deepEqual(v?.steps.map((step) => step.label), ['浏览与互动', '留出自然间隔', '继续寻找灵感']);
  assert.equal(v?.steps[0].detail, '2 条灵感已记录');
  assert.match(v?.resume ?? '', /约 42 分钟后自动继续/);
  assert.equal(v?.note, '本轮进展已记录');
});

test('运行价值说明：本轮等待缺少浏览配额字段时仍展示完整进度', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    session: 'resting',
    presence: { text: '这一轮已经完成，稍作等待后会自动继续', at: new Date(now - 21_000).toISOString() },
    dailyUsage: {
      totals: { view: 12, collect: 2 },
      windows: {
        session: {
          active: true,
          releaseAt: now + 8 * 60_000,
          totals: { view: 12, collect: 2 },
        },
      },
    },
  }), now);
  assert.equal(v?.mode, 'session');
  assert.equal(v?.title, '先整理一下刚才发现的方向。');
  assert.equal(v?.value, '停一停不是失去进度，而是为下一轮寻找留出自然节奏。');
  assert.deepEqual(v?.steps.map((step) => [step.label, step.detail]), [
    ['浏览与互动', '2 条灵感已记录'],
    ['留出自然间隔', '让账号信号更清晰'],
    ['继续寻找灵感', '推荐内容更聚焦'],
  ]);
  assert.equal(v?.resume, '约 8 分钟后自动继续');
  assert.equal(v?.note, '本轮进展已记录');
});

test('运行价值说明：单项互动完成不升级为全局浏览间隔', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    session: 'resting',
    presence: { text: '旧事件', at: new Date(now - 6 * 60_000).toISOString() },
    dailyUsage: {
      windows: {
        hour: {
          expiresAt: now + 30 * 60_000,
          releaseAt: now + 30 * 60_000,
          totals: { view: 7, comment: 1 },
          quotas: { view: 8, comment: 1 },
          saturated: ['comment'],
        },
      },
    },
  }), now);
  assert.equal(v, null);
});

test('运行价值说明：所有今日计划完成后才展示今日成果', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    session: 'resting',
    presence: { text: '旧事件', at: new Date(now - 6 * 60_000).toISOString() },
    dailyUsage: {
      windows: {
        day: {
          expiresAt: now + 8 * 60 * 60_000,
          totals: { view: 20, like: 3, collect: 2 },
          quotas: { view: 20, like: 3, collect: 2 },
          saturated: ['view', 'like', 'collect'],
        },
      },
    },
  }), now);
  assert.equal(v?.mode, 'day');
  assert.equal(v?.mascot, 'celebration');
  assert.match(v?.title ?? '', /明天继续/);
  assert.match(v?.steps[0].detail ?? '', /3 项今日计划已完成/);
});

test('在场感：过期限额窗口不再解释为当前上限休息', () => {
  const now = Date.now();
  const v = uiLogic.presenceView(st({
    presence: { text: '正在继续浏览…', at: new Date(now - 6 * 60_000).toISOString() },
    dailyUsage: {
      totals: { view: 8, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
      saturated: [],
      windows: {
        minute: {
          startedAt: now - 2 * 60_000,
          windowMs: 60_000,
          expiresAt: now - 60_000,
          releaseAt: now + 30_000,
          totals: { view: 8, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
          quotas: { view: 8, like: 3, collect: 2, comment: 1, follow: 1, publish: 1 },
          saturated: ['view'],
        },
      },
    },
  }), now);
  assert.equal(v.animate, false);
  assert.match(v.text, /没有新动态/);
});

test('在场感：没有上限数字时不臆造限额休息原因', () => {
  const now = Date.now();
  const v = uiLogic.presenceView(st({
    presence: { text: '正在继续浏览…', at: new Date(now - 6 * 60_000).toISOString() },
    dailyUsage: {
      totals: { view: 8, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
      saturated: [],
      windows: {
        hour: {
          startedAt: now - 10 * 60_000,
          windowMs: 3_600_000,
          expiresAt: now + 50 * 60_000,
          releaseAt: now + 36 * 60_000,
          totals: { view: 8, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
          saturated: ['view'],
        },
      },
    },
  }), now);
  assert.equal(v.animate, false);
  assert.match(v.text, /没有新动态/);
});

test('在场感：暂停 / 停止 / 需登录 → 静态诚实文案', () => {
  const now = Date.now();
  const paused = uiLogic.presenceView(st({ session: 'paused', edge: 'stopped', presence: { text: 'x', at: new Date(now - 8000).toISOString() } }), now);
  assert.equal(paused.animate, false);
  assert.match(paused.fresh, /状态更新/, '暂停态也要有时间戳、不留大空白');
  const closed = uiLogic.presenceView(st({ session: 'closed', edge: 'stopped', presence: { text: 'x', at: new Date(now - 8000).toISOString() } }), now);
  assert.equal(closed.animate, false);
  assert.match(closed.text, /已关闭浏览器/);
  const resting = uiLogic.presenceView(st({ session: 'resting', presence: { text: '旧的技术休息文案', at: new Date(now - 8000).toISOString() } }), now);
  assert.equal(resting.animate, false);
  assert.match(resting.text, /这一轮已经完成/);
  const stopped = uiLogic.presenceView(st({ edge: 'stopped', session: 'idle' }), now);
  assert.equal(stopped.animate, false);
  assert.match(stopped.text, /待命/);
  const login = uiLogic.presenceView(st({ auth: 'login required', edge: 'stopped', session: 'idle' }), now);
  assert.match(login.text, /登录/);
});

// ── 发布卡状态机（只读投影）──
test('发布卡：候审 → 第三节点琥珀、脚注指向稿件预览、绝无「已再提醒」', () => {
  const now = Date.now();
  const v = uiLogic.publishView({ state: 'pending', title: '秋日漫步', at: new Date(now - 3 * 60_000).toISOString() }, null, now);
  assert.equal(v.mode, 'flow');
  assert.deepEqual(v.stepStates, ['done', 'done', 'cur', 'todo']);
  assert.match(v.corner ?? '', /已等 3 分钟/);
  assert.equal(v.cornerHot, false);
  assert.match(v.foot ?? '', /稿件预览/);
  assert.ok(!(v.foot ?? '').includes('再次提醒'), '未收到再提醒事件绝不谎称已提醒');
});

test('发布卡：等超 30 分钟 → 时长琥珀化，仍不谎称已提醒（宁缺毋假）', () => {
  const now = Date.now();
  const v = uiLogic.publishView({ state: 'pending', title: 't', at: new Date(now - 34 * 60_000).toISOString() }, null, now);
  assert.equal(v.cornerHot, true);
  assert.ok(!(v.foot ?? '').includes('再次提醒'));
});

test('发布卡：收到明确再提醒事件 → 仍提示稿件待确认', () => {
  const now = Date.now();
  const v = uiLogic.publishView({ state: 'reminded', title: 't', at: new Date(now - 34 * 60_000).toISOString() }, null, now);
  assert.match(v.foot ?? '', /稿件仍待确认/);
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
  assert.equal(pub.showLink, false, '卡片不再展示打开飞书入口');
});

test('发布卡：已提交但链接待确认 → 折进活动流，不伪造为上次发布', () => {
  const now = Date.now();
  const submitted = uiLogic.publishView({ state: 'submitted', title: '秋日漫步', at: new Date(now).toISOString() }, null, now);
  assert.match(submitted.collapsed?.sentence ?? '', /已提交，待链接确认/);
  assert.equal(submitted.mode, 'empty');
  assert.ok(!(submitted.collapsed?.sentence ?? '').includes('已发布'));
});

test('发布卡：拒绝 → 折进活动流（不渲染成失败）+ 回落上次发布/空态', () => {
  const now = Date.now();
  const rej = uiLogic.publishView({ state: 'rejected', at: new Date(now).toISOString() }, { title: '旧文', at: new Date(now - 86_400_000).toISOString() }, now);
  assert.match(rej.collapsed?.sentence ?? '', /取消发布/);
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
  assert.equal(empty.showLink, false, '空态也不展示打开飞书入口');
  assert.match(empty.foot ?? '', /\*\*发布 \/ 取消\*\*/, '只加粗「发布 / 取消」');
  assert.ok(!(empty.foot ?? '').includes('**通过后才会发布**'), '其余不加粗');
});

test('发布卡收起态：已发布历史默认收起为「已发布：标题」', () => {
  const now = Date.now();
  const last = uiLogic.publishView(null, { title: '秋日漫步', at: new Date(now - 3_600_000).toISOString() }, now);
  const dock = uiLogic.publishDock(last, { edge: 'stopped', session: 'idle' }, false);
  assert.equal(dock.collapsed, true);
  assert.equal(dock.label, '已发布：秋日漫步');
  assert.match(dock.summary, /小时前/);
  const empty = uiLogic.publishView(null, null, now);
  const emptyDock = uiLogic.publishDock(empty, { edge: 'stopped', session: 'idle' }, false);
  assert.equal(emptyDock.collapsed, false, '空态未运行时仍展开');
});

test('相对时间走字', () => {
  const now = Date.now();
  assert.equal(uiLogic.relTime(now - 1000, now), '刚刚');
  assert.equal(uiLogic.relTime(now - 30_000, now), '30 秒前');
  assert.equal(uiLogic.relTime(now - 5 * 60_000, now), '5 分钟前');
});

// ── 左栏显示名优先级（change edge-adspower-name-follows-nickname）：真实昵称 → 花名册/环境名 → 末4位 ──
test('railDisplayName：真实昵称优先于花名册名（实时名回填成模板名也不遮蔽已知昵称）', () => {
  // 回归场景：reconcileRosterNames 把花名册名刷成 AdsPower 模板名，但真实昵称已读到（source!=='env'）→ 显示昵称。
  const row = { envId: 'ads-abcd1234', name: 'win11-intel', status: { account: { id: 'u1', name: '大白', source: 'xhs' } } };
  assert.equal(uiLogic.railDisplayName(row), '大白');
});
test('railDisplayName：未读到真实昵称（source=env）→ 回落花名册/环境名', () => {
  const row = { envId: 'ads-abcd1234', name: 'win11-intel', status: { account: { id: 'u1', name: 'win11-intel', source: 'env' } } };
  assert.equal(uiLogic.railDisplayName(row), 'win11-intel', 'source=env 不是登录读出的真实身份，不算昵称档');
});
test('railDisplayName：既无真实昵称也无环境名 → 「环境 …末4位」兜底', () => {
  const row = { envId: 'ads-abcd1234', name: '', status: {} };
  assert.equal(uiLogic.railDisplayName(row), '环境 …1234');
});
