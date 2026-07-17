import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 纯视图逻辑单测（edge-companion-ui）：健康合成 / 在场感动效门 / 发布卡状态机 / 相对时间。
const require = createRequire(import.meta.url);

interface Health { code: string; label: string; detail: string }
interface PresenceV { text: string; animate: boolean; fresh: string }
interface RuntimeGuidanceV {
  mode: 'running' | 'session' | 'hour' | 'day' | 'first-post';
  mascot: string;
  animate: boolean;
  kicker: string;
  title: string;
  value?: string;
  detail: string;
  resume: string;
  note?: string;
  harvest?: { title: string; countText: string; heatText: string; hasHeat: boolean } | null;
  progress?: { current: number; target: number; percent: number; title: string; counter: string; meta: string } | null;
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
  publishView: (p: Record<string, unknown> | null, last: Record<string, unknown> | null, now: number) => PublishV;
  publishDock: (v: PublishV, s: Record<string, unknown>, manualOpen: boolean) => PublishDockV;
  railDisplayName: (row: Record<string, unknown>) => string;
  slowStartLine: (dailyUsage: Record<string, unknown> | null | undefined, connState: string) => SlowStartV;
  PRESENCE_FRESH_MS: number;
};

interface SlowStartV {
  visible: boolean;
  checked?: boolean;
  disabled?: boolean;
  stale?: boolean;
  badge?: string;
  tone?: string;
  reason?: string;
}

function st(over: Record<string, unknown> = {}) {
  return {
    auth: 'logged in',
    cloud: 'connected',
    // 一个正常在跑的环境，按定义就是**连上过**的。基线带上这一位，下面「云端掉线 → 需处理」那条断言
    // 才真的在测「断线」；否则它测的是「从没连上过」，而那是启动，不是故障。
    cloudEverConnected: true,
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

// ── 首次连接 ≠ 断线重连（change honest-first-connect-label）──
// 冷启动窗口的真实形状：核心一打印日志 edge 就被翻成 running，spawn 时 session 已乐观写成 running，
// 而核心 main() 里连云端排在「起浏览器 → CDP attach → 登录闸」之后——于是 cloud 还是 disconnected。
// 这三者凑齐正好命中断连分支。它必须被读成「还在启动」，而不是「连接掉了」。
test('健康合成：本轮核心从没连上过云端 → 是启动中，绝不冒充「正在重新连接」', () => {
  const booting = uiLogic.synthesizeHealth(
    st({ edge: 'running', session: 'running', cloud: 'disconnected', cloudEverConnected: false }),
  );
  assert.equal(booting.code, 'ready');
  assert.doesNotMatch(booting.label, /重新连接/); // 「重」断言了一次从未发生过的连接
  assert.match(booting.label, /启动/);
});

test('健康合成：连上过之后掉线 → 才是真的「正在重新连接」', () => {
  const dropped = uiLogic.synthesizeHealth(
    st({ edge: 'running', session: 'running', cloud: 'disconnected', cloudEverConnected: true }),
  );
  assert.equal(dropped.code, 'attention');
  assert.match(dropped.label, /正在重新连接/);
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

// 用户实况（change presence-terminal-honesty）：会话仍报运行中、动作文案还在新鲜期内、当日浏览额度已跑满。
// 修前这一格里在场感照播「顺路去作者主页看看…」+「刚刚更新」，同屏的探索进度卡却已经在说「今天先到这里」。
test('在场感：运行中 + 动作文案仍新鲜 + 当日额度已满 → 终态压过中途动作文案', () => {
  const now = Date.now();
  const status = st({
    presence: { text: '顺路去作者主页看看…', at: new Date(now - 2 * 60_000).toISOString() },
    dailyUsage: {
      windows: {
        day: {
          expiresAt: now + 9 * 60 * 60_000,
          totals: { view: 300, like: 16, collect: 9, comment: 4, follow: 0, publish: 0 },
          quotas: { view: 300, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
          saturated: ['view'],
        },
      },
    },
  });
  const v = uiLogic.presenceView(status, now);
  assert.equal(v.text, '今日内容探索已经完成');
  assert.equal(v.animate, false);
  // 同一份数据下两块 UI 必须同口径，绝不同屏互相打脸（进度卡说今天先到这里、在场感说顺路去作者主页）。
  assert.equal(uiLogic.runtimeGuidanceView(status, now)?.mode, 'day');
});

// 额度未满 + 动作文案过了「正在做」那条线：文案保留（要知道最后推进到哪一步），但动效与「刚刚更新」撤掉。
// 这一格就是「执行端已做完、球在云端」（进主页后要过一次大模型定夺是否关注）的真实处境。
test('在场感：额度未满 + 动作文案已过 1 分钟 → 保留文案但如实说已等待、绝不自称今日完成', () => {
  const now = Date.now();
  const v = uiLogic.presenceView(st({ presence: { text: '顺路去作者主页看看…', at: new Date(now - 2 * 60_000).toISOString() } }), now);
  assert.equal(v.text, '顺路去作者主页看看…');
  assert.equal(v.animate, false);
  assert.equal(v.fresh, '已等待 · 2 分钟');
  assert.doesNotMatch(v.text, /完成/);
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
    dailyUsage: {
      totals: { view: 12, collect: 2 },
      quotas: { view: 150 },
      windows: {
        session: {
          active: true,
          totals: { view: 12, collect: 2 },
          quotas: { view: 20 },
        },
      },
    },
  }), now);
  assert.equal(v?.mode, 'running');
  assert.equal(v?.mascot, 'task-execution');
  assert.equal(v?.animate, true);
  assert.equal(v?.kicker, '正在理解目标人群喜欢什么');
  assert.equal(v?.title, '正在缩小创作方向。');
  assert.equal(v?.value, '刷首页不是漫无目的，而是在寻找目标人群已经验证过的方向。');
  assert.deepEqual(v?.steps.map((step) => [step.label, step.detail]), [
    ['浏览与互动', '正在查看第 12 条'],
    ['判断匹配度', '2 条进入候选'],
    ['继续寻找灵感', '持续筛选中'],
  ]);
  assert.deepEqual(v?.progress, {
    current: 12,
    target: 150,
    percent: 8,
    title: '正在查看第 12 条推荐内容',
    counter: '12/150',
    meta: '进展实时记录',
  });
});

test('运行价值说明：日常进度分母来自今日目标时，分子也使用今日浏览累计', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    presence: { text: '正在继续浏览…', at: new Date(now - 10_000).toISOString() },
    dailyUsage: {
      totals: { view: 95, collect: 2 },
      quotas: { view: 120 },
      windows: {
        session: {
          active: true,
          totals: { view: 0, collect: 0 },
          quotas: { view: 20 },
        },
      },
    },
  }), now);
  assert.equal(v?.mode, 'running');
  assert.deepEqual(v?.steps.map((step) => [step.label, step.detail]), [
    ['浏览与互动', '正在查看第 95 条'],
    ['判断匹配度', '2 条进入候选'],
    ['继续寻找灵感', '持续筛选中'],
  ]);
  assert.deepEqual(v?.progress, {
    current: 95,
    target: 120,
    percent: 79,
    title: '正在查看第 95 条推荐内容',
    counter: '95/120',
    meta: '进展实时记录',
  });
});

test('第一篇作品引导：首轮单独显示 0/20，不从今日计划推断', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    presence: { text: '正在继续浏览…', at: new Date(now - 10_000).toISOString() },
    dailyUsage: {
      totals: { view: 95 },
      quotas: { view: 120 },
      firstPost: { state: 'searching', viewed: 0, target: 20, startedAt: now },
      windows: {
        session: {
          active: true,
          totals: { view: 7, collect: 0 },
          quotas: { view: 12 },
        },
      },
    },
  }), now);
  assert.equal(v?.mode, 'first-post');
  assert.equal(v?.animate, false);
  assert.match(v?.value ?? '', /不是漫无目的/);
  assert.deepEqual(v?.steps.map((step) => step.label), ['看趋势', '找匹配', '开始创作']);
  assert.deepEqual(v?.progress, {
    current: 0,
    target: 20,
    percent: 0,
    title: '首轮观察刚刚开始',
    counter: '0/20',
    meta: '通常筛出 1 条灵感',
  });
});

test('第一篇作品引导：命中灵感后进入一次性生成态，不承诺浏览 20 条必定成功', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    dailyUsage: {
      totals: { view: 14 },
      firstPost: { state: 'generating', viewed: 14, target: 20, startedAt: now - 60_000, sourceId: 'note-1' },
    },
  }), now);
  assert.equal(v?.mode, 'first-post');
  assert.equal(v?.mascot, 'celebration');
  assert.equal(v?.animate, true);
  assert.match(v?.title ?? '', /正在生成/);
  assert.deepEqual(v?.steps.map((step) => step.state), ['done', 'done', 'current']);
  assert.deepEqual(v?.progress, {
    current: 14,
    target: 20,
    percent: 70,
    title: '已从 14 条推荐内容中找到灵感',
    counter: '14/20',
    meta: '已找到 1 条灵感',
  });
  assert.match(v?.note ?? '', /确认发布/);
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
  assert.deepEqual(v?.progress, {
    current: 12,
    target: 12,
    percent: 100,
    title: '本轮已查看 12 条推荐内容',
    counter: '12/12',
    meta: '进展已记录',
  });
  assert.equal(v?.resume, '');
  assert.equal(v?.note, '');
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
  assert.deepEqual(v?.progress, {
    current: 12,
    target: 12,
    percent: 0,
    title: '本轮已查看 12 条推荐内容',
    counter: '',
    meta: '进展已记录',
  });
  assert.equal(v?.resume, '');
  assert.equal(v?.note, '');
});

test('运行价值说明：单项互动完成不升级为全局浏览间隔', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    session: 'resting',
    presence: { text: '旧事件', at: new Date(now - 6 * 60_000).toISOString() },
    dailyUsage: {
      inspirationSummary: { count: 3, sourceLikeCount: 12_345 },
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

test('运行价值说明：今日浏览计划完成后展示今日成果', () => {
  const now = Date.now();
  const v = uiLogic.runtimeGuidanceView(st({
    session: 'resting',
    presence: { text: '旧事件', at: new Date(now - 6 * 60_000).toISOString() },
    dailyUsage: {
      inspirationSummary: { count: 3, sourceLikeCount: 12_345 },
      windows: {
        day: {
          expiresAt: now + 8 * 60 * 60_000,
          totals: { view: 300, like: 16, collect: 9, comment: 4, follow: 0, publish: 0 },
          quotas: { view: 300, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
          saturated: ['view'],
        },
      },
    },
  }), now);
  assert.equal(v?.mode, 'day');
  assert.equal(v?.mascot, 'celebration');
  assert.equal(v?.kicker, '探索完成');
  assert.match(v?.title ?? '', /明天继续/);
  assert.equal(v?.steps[0].detail, '今日浏览计划已完成');
  assert.equal(v?.resume, '');
  assert.deepEqual(v?.harvest, {
    title: '本轮收获已保存',
    countText: '3 条创作灵感',
    heatText: '1.2 万赞',
    hasHeat: true,
  });
});

test('在场感：今日完成顶部保留开启新一天预计时间', () => {
  const now = Date.now();
  const v = uiLogic.presenceView(st({
    session: 'resting',
    presence: { text: '旧事件', at: new Date(now - 6 * 60_000).toISOString() },
    dailyUsage: {
      inspirationSummary: { count: 3, sourceLikeCount: 12_345 },
      windows: {
        day: {
          expiresAt: now + 9 * 60 * 60_000,
          totals: { view: 300, like: 16, collect: 9, comment: 4, follow: 0, publish: 0 },
          quotas: { view: 300, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
          saturated: ['view'],
        },
      },
    },
  }), now);
  assert.equal(v.text, '今日内容探索已经完成');
  assert.equal(v.fresh, '预计约 9 小时后开启新一天计划');
});

test('在场感：本轮等待缺少完整进度卡时仍展示预计等待时间', () => {
  const now = Date.now();
  const v = uiLogic.presenceView(st({
    session: 'resting',
    presence: { text: '这一轮已经完成，稍作等待后会自动继续', at: new Date(now - 38_000).toISOString() },
    dailyUsage: {
      windows: {
        session: {
          active: true,
          releaseAt: now + 28 * 60_000,
          totals: {},
        },
      },
    },
  }), now);
  assert.equal(v.animate, false);
  assert.match(v.text, /这一轮已经完成/);
  assert.equal(v.fresh, '约 28 分钟后自动继续');
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

test('发布卡收起态：已发布历史与空态均默认收起，手动打开时展开', () => {
  const now = Date.now();
  const last = uiLogic.publishView(null, { title: '秋日漫步', at: new Date(now - 3_600_000).toISOString() }, now);
  const dock = uiLogic.publishDock(last, { edge: 'stopped', session: 'idle' }, false);
  assert.equal(dock.collapsed, true);
  assert.equal(dock.label, '已发布：秋日漫步');
  assert.match(dock.summary, /小时前/);
  const empty = uiLogic.publishView(null, null, now);
  for (const status of [
    { edge: 'running', session: 'running' },
    { edge: 'stopped', session: 'idle' },
    { edge: 'running', session: 'paused' },
  ]) {
    const emptyDock = uiLogic.publishDock(empty, status, false);
    assert.equal(emptyDock.collapsed, true, '空态默认收起不依赖运行状态');
    assert.equal(emptyDock.label, '发布过的 AI 写好的笔记');
    assert.equal(emptyDock.summary, '还没有发布过内容');
  }
  const openedEmptyDock = uiLogic.publishDock(empty, { edge: 'stopped', session: 'idle' }, true);
  assert.equal(openedEmptyDock.collapsed, false, '用户手动打开后临时展开');
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

// ── change account-level-slow-start：慢启动脚注行 ──
// 每条用例都对着一个具体的谎（未知当成关 / 没压说成在压 / 毕业静默消失 / 断连当成已关闭）。

const usage = (slowStart: Record<string, unknown> | undefined) => ({ asOf: '2026-07-17T00:00:00.000Z', totals: {}, ...(slowStart ? { slowStart } : {}) });

test('slowStartLine：字段缺省 = 未知（云端还没说）→ 整行不渲染，绝不默认成「关」', () => {
  // 照 personaBound 三态判例：显示一个没勾的框，等于替云端回答了「这个号没在养」。
  assert.equal(uiLogic.slowStartLine(usage(undefined), 'online').visible, false);
  assert.equal(uiLogic.slowStartLine(null, 'online').visible, false);
  assert.equal(uiLogic.slowStartLine(undefined, 'online').visible, false);
});

test('slowStartLine：active + binding=true → 「慢启动 · 第 3/7 天」', () => {
  const v = uiLogic.slowStartLine(usage({ state: 'active', day: 3, totalDays: 7, binding: true, eligible: true }), 'online');
  assert.equal(v.visible, true);
  assert.equal(v.checked, true);
  assert.equal(v.disabled, false);
  assert.equal(v.badge, '慢启动 · 第 3/7 天');
});

test('slowStartLine：active + binding=false → 明说「当前档位已更严，不额外限制」', () => {
  // 慢启动语义是 min(曲线, 档位)，档位数字面板可热编辑 → 勾了却一格没压是真实可达的状态。
  // 让「没变」成为一个被明说的态，而不是一个看起来像 bug 的沉默。
  const v = uiLogic.slowStartLine(usage({ state: 'active', day: 5, totalDays: 7, binding: false, eligible: true }), 'online');
  assert.equal(v.badge, '慢启动 · 第 5/7 天 · 当前档位已更严，不额外限制');
  assert.doesNotMatch(v.badge!, /压低|正在限制/, 'MUST NOT 宣称正在压低配额');
});

test('slowStartLine：毕业态显式告知放开日期，绝不静默消失', () => {
  // 第 8 天 clamp 自动失效而库里开关仍为真。若徽章静默消失，运营不知道限额是哪天放开的
  // ——而那正是最该被告知的时刻。
  const since = Date.UTC(2026, 6, 10, 0, 0);
  const v = uiLogic.slowStartLine(usage({ state: 'graduated', totalDays: 7, since, eligible: true }), 'online');
  assert.equal(v.visible, true);
  assert.equal(v.tone, 'graduated');
  assert.match(v.badge!, /慢启动 · 已完成（\d+ 月 \d+ 日起按正常档位执行）/);
});

test('slowStartLine：eligible=false → 禁用 + 按 reason 如实说明（三个原因各一条）', () => {
  const cases: Array<[string, RegExp]> = [
    ['platform_unsupported', /该平台暂不支持/],
    ['platform_unknown', /平台待确认/],
    ['globally_disabled', /全局停用/],
  ];
  for (const [reason, expect] of cases) {
    const v = uiLogic.slowStartLine(usage({ state: 'off', totalDays: 7, eligible: false, ineligibleReason: reason }), 'online');
    assert.equal(v.disabled, true, `${reason} 必须禁用勾选`);
    assert.match(v.reason!, expect);
  }
});

test('slowStartLine：断连 → 灰化 + 「可能已过期」，MUST NOT 渲染成「已关闭」', () => {
  // 断连时字段不会变缺省（主进程 if (evt.dailyUsage) 不清空）→ 只是停止更新。
  const v = uiLogic.slowStartLine(usage({ state: 'active', day: 2, totalDays: 7, binding: true, eligible: true }), 'offline');
  assert.equal(v.visible, true);
  assert.equal(v.checked, true, '断连不得把开关显示成未勾');
  assert.equal(v.stale, true);
  assert.equal(v.disabled, true, '断连时开关禁用（状态本就搭在云端推送上）');
  assert.match(v.reason!, /云端已断开/);
});

test('slowStartLine：off 态不显徽章、开关未勾', () => {
  const v = uiLogic.slowStartLine(usage({ state: 'off', totalDays: 7, eligible: true }), 'online');
  assert.equal(v.visible, true);
  assert.equal(v.checked, false);
  assert.equal(v.badge, '');
});

test('slowStartLine：跨天 —— 天数一律用云端下发的 day，绝不本地推算', () => {
  // 本地推算就是第二个事实源，必然与 clamp 漂移（「显示的 ≠ 生效的」）。
  for (const day of [1, 4, 7]) {
    const v = uiLogic.slowStartLine(usage({ state: 'active', day, totalDays: 7, binding: true, eligible: true }), 'online');
    assert.equal(v.badge, `慢启动 · 第 ${day}/7 天`);
  }
});

test('slowStartLine：文案红线 —— 全域不出现「新账号」、不暗示动作更慢', () => {
  // 系统只知道它连上我们多少天，不知道它多老（cookie 导入的三年老号同样会被勾上）。
  // clamp 只返回配额数字、完全不进 pacing → 不得暗示「更像真人 / 动作更慢」。
  const all = [
    uiLogic.slowStartLine(usage({ state: 'active', day: 1, totalDays: 7, binding: true, eligible: true }), 'online'),
    uiLogic.slowStartLine(usage({ state: 'active', day: 5, totalDays: 7, binding: false, eligible: true }), 'online'),
    uiLogic.slowStartLine(usage({ state: 'graduated', totalDays: 7, since: Date.UTC(2026, 6, 10), eligible: true }), 'online'),
    uiLogic.slowStartLine(usage({ state: 'off', totalDays: 7, eligible: false, ineligibleReason: 'platform_unknown' }), 'offline'),
  ];
  for (const v of all) {
    const text = `${v.badge ?? ''}${v.reason ?? ''}`;
    assert.doesNotMatch(text, /新账号/);
    assert.doesNotMatch(text, /更慢|更像真人|拟人/);
    // 本行渲染进 #daily-summary，受该卡既有陪伴式口径约束（用「计划」不用配额术语）。
    // companion-ui.test.ts 有一条断言守着整卡文本；这里把同一条口径钉在产出文案上，
    // 让违规在写文案的地方就红，而不是在一条看起来无关的旧用例里红。
    assert.doesNotMatch(text, /已达|上限|额度|释放|已满/);
  }
});
