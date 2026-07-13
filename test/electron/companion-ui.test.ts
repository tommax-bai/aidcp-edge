import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';

// 陪伴式主界面冒烟（edge-companion-ui）：标题带健康合成 / 设置抽屉 / 在场感诚实态 /
// 活动流 / 发布卡纯展示零按钮 —— 用真实 index.html + ui-logic.js + renderer.js 在 jsdom 里驱动。
const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');

const tick = () => new Promise((r) => setTimeout(r, 0));

const openWindows: DOMWindow[] = [];
after(() => {
  for (const w of openWindows) w.close();
});

function makeStatus(over: Record<string, unknown> = {}) {
  return {
    auth: 'logged in',
    cloud: 'connected',
    session: 'running',
    risk: 'normal',
    edge: 'running',
    stats: { views: 3, likes: 1, collects: 0, comments: 0, follows: 0, publishes: 0 },
    provider: 'adspower',
    lastMessage: '',
    updatedAt: new Date().toISOString(),
    account: { id: 'acct-1', name: '晚风手作' },
    presence: { text: '正在认真读「秋日漫步」…', at: new Date().toISOString() },
    publish: null,
    loopStage: 'read',
    ...over,
  };
}

interface BootHandles {
  w: DOMWindow;
  pushStatus: (s: unknown) => void;
  pushActivity: (e: unknown) => void;
}

async function boot(statusOver: Record<string, unknown> = {}, apiOver: Record<string, unknown> = {}): Promise<BootHandles> {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  openWindows.push(window);
  let pushStatus: (s: unknown) => void = () => undefined;
  let pushActivity: (e: unknown) => void = () => undefined;
  const settings = { provider: 'adspower', adsProfileId: 'u1', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'https://x' };
  (window as unknown as { aidcpEdge: unknown }).aidcpEdge = {
    onStatusUpdate: (cb: (s: unknown) => void) => { pushStatus = cb; },
    onActivity: (cb: (e: unknown) => void) => { pushActivity = cb; },
    getStatus: async () => makeStatus(statusOver),
    getSettings: async () => settings,
    saveSettings: async () => ({ ...settings, saveOk: true }),
    pause: async () => makeStatus({ session: 'paused' }),
    resume: async () => makeStatus(),
    close: async () => makeStatus({ session: 'closed', edge: 'stopped', cloud: 'disconnected' }),
    start: async () => makeStatus(),
    restart: async () => makeStatus(),
    relogin: async () => makeStatus(),
    openAdsDownload: () => undefined,
    openFeishu: async () => ({ ok: true }),
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' }] }),
    adsOpenCreate: () => ({ launched: true }),
    ...apiOver,
  };
  window.eval(uiLogicSrc);
  window.eval(rendererSrc);
  for (let i = 0; i < 5; i++) await tick();
  return { w: window, pushStatus, pushActivity };
}

const $ = (w: DOMWindow, sel: string) => w.document.querySelector(sel) as unknown as HTMLElement;
const hidden = (el: HTMLElement) => el.classList.contains('hidden');

// ── 标题带：身份 + 健康合成 + 风控染色 ──
test('标题带展示账号身份与健康结论', async () => {
  const { w } = await boot();
  assert.equal($(w, '#acct-name').textContent, '@晚风手作');
  assert.equal($(w, '#acct-ava').textContent, '晚');
  assert.match($(w, '#health-label').textContent ?? '', /运行中/);
  assert.ok($(w, '#titlebar').classList.contains('tone-normal'));
});

test('风控警戒与登录协助用琥珀；真正异常使用独立错误态', async () => {
  const { w, pushStatus } = await boot();
  pushStatus(makeStatus({ risk: 'warned' }));
  assert.ok($(w, '#titlebar').classList.contains('tone-warned'));
  pushStatus(makeStatus({ auth: 'login required', edge: 'stopped', session: 'idle' }));
  assert.equal($(w, '#health-label').textContent, '需要协助');
  assert.ok($(w, '#health-pill').classList.contains('attention'));
  pushStatus(makeStatus({ edge: 'warning' }));
  assert.equal($(w, '#health-label').textContent, '运行异常');
  assert.ok($(w, '#health-pill').classList.contains('error'));
});

test('异常退出详情在客户端内持久展示，且不把堆栈塞进主界面', async () => {
  const summary = '启动失败：AdsPower browser/start 失败：code=-1 msg=[k1e0ero8] is being used by [tommax.bai@gmail.com] and is not allowed to open';
  const { w } = await boot({
    edge: 'warning',
    cloud: 'disconnected',
    session: 'idle',
    lastMessage: 'at async main (file:///dist/main.js:102:44)',
    edgeFailure: { summary, at: new Date().toISOString(), exitCode: 1 },
  });
  assert.equal(hidden($(w, '#edge-failure')), false, '异常详情应在主界面可见');
  assert.match($(w, '#edge-failure-text').textContent ?? '', /browser\/start 失败/);
  assert.match($(w, '#edge-failure-text').textContent ?? '', /tommax\.bai@gmail\.com/);
  assert.doesNotMatch($(w, '#edge-failure').textContent ?? '', /at async/, '主界面不展示堆栈行');

  $(w, '#health-pill').dispatchEvent(new w.Event('click'));
  assert.match($(w, '#health-detail').textContent ?? '', /is being used/);
});

test('新启动状态会清除上一轮异常详情', async () => {
  const { w, pushStatus } = await boot({
    edge: 'warning',
    session: 'idle',
    edgeFailure: { summary: '启动失败：AdsPower API 不可达', at: new Date().toISOString(), exitCode: 1 },
  });
  assert.equal(hidden($(w, '#edge-failure')), false);
  pushStatus(makeStatus({ edge: 'starting', session: 'running', cloud: 'disconnected', edgeFailure: null }));
  assert.equal(hidden($(w, '#edge-failure')), true);
  assert.equal($(w, '#edge-failure-text').textContent, '');
});

test('健康明细浮层点开可见五路人话状态', async () => {
  const { w } = await boot();
  assert.equal(hidden($(w, '#health-pop')), true, '默认收起');
  $(w, '#health-pill').dispatchEvent(new w.Event('click'));
  assert.equal(hidden($(w, '#health-pop')), false);
  assert.ok($(w, '#health-pop').textContent?.includes('本机引擎'));
});

// ── 设置抽屉：稳态首屏无表单 ──
test('配置表单收进抽屉：稳态首屏不见「必填」，齿轮开合', async () => {
  const { w } = await boot();
  const drawer = $(w, '#drawer');
  assert.ok(drawer.contains($(w, '#ads-config')), '配置表单应在抽屉内');
  assert.equal(drawer.classList.contains('open'), false, '稳态默认收起');
  $(w, '#gear').dispatchEvent(new w.Event('click'));
  assert.equal(drawer.classList.contains('open'), true);
  $(w, '#drawer-close').dispatchEvent(new w.Event('click'));
  assert.equal(drawer.classList.contains('open'), false);
});

test('待配置 → 首屏主动步骤，点「添加环境」直达左栏添加面板', async () => {
  const { w } = await boot({ auth: 'config required', edge: 'stopped', session: 'idle' });
  assert.equal(hidden($(w, '#login-guide')), false, '待配置应出主动步骤');
  assert.equal(hidden($(w, '#notice-action')), false);
  $(w, '#notice-action').dispatchEvent(new w.Event('click'));
  // 环境管理已搬到左栏：主动步骤直达「添加环境」面板，不再去设置抽屉。
  assert.equal($(w, '#env-add-panel').classList.contains('open'), true);
});

// ── 在场感：动效只由真实事件驱动 ──
test('运行中 + 新鲜事件 → 在场感动效开、新鲜度走字', async () => {
  const { w } = await boot();
  assert.ok($(w, '#presence-text').classList.contains('shimmer'));
  assert.match($(w, '#presence-text').textContent ?? '', /正在认真读/);
  assert.match($(w, '#presence-fresh').textContent ?? '', /刚刚更新/);
});

test('红线：停止 / 事件过期时动效止息、如实待命', async () => {
  const stale = new Date(Date.now() - 6 * 60_000).toISOString();
  const { w, pushStatus } = await boot({ edge: 'stopped', session: 'idle', presence: { text: 'x', at: stale } });
  assert.equal($(w, '#presence-text').classList.contains('shimmer'), false);
  assert.match($(w, '#presence-text').textContent ?? '', /待命/);
  // 在跑但事件过期：不假装仍在忙
  pushStatus(makeStatus({ presence: { text: '正在认真读「x」…', at: stale } }));
  assert.equal($(w, '#presence-text').classList.contains('shimmer'), false);
  assert.match($(w, '#presence-text').textContent ?? '', /没有新动态/);
});

test('运行中 + 事件过期 + 阶段计划完成 → 在场感说明成果和预计继续时间', async () => {
  const now = 1730000000000;
  const stale = new Date(now - 6 * 60_000).toISOString();
  const { w, pushStatus } = await boot();
  const originalNow = w.Date.now;
  w.Date.now = () => now;
  try {
    pushStatus(makeStatus({
      presence: { text: '正在继续浏览…', at: stale },
      dailyUsage: {
        asOf: now,
        quotaLevel: 'normal',
        totals: { view: 38, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
        quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
        saturated: [],
        windows: {
          hour: {
            startedAt: now - 24 * 60_000,
            windowMs: 3_600_000,
            expiresAt: now + 36 * 60_000,
            releaseAt: now + 36 * 60_000,
            totals: { view: 38, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
            quotas: { view: 38, like: 13, collect: 7, comment: 2, follow: 4, publish: 1 },
            saturated: ['view'],
          },
        },
      },
    }));
    assert.equal($(w, '#presence-text').classList.contains('shimmer'), false);
    assert.match($(w, '#presence-text').textContent ?? '', /内容观察完成一轮/);
    assert.match($(w, '#presence-fresh').textContent ?? '', /先让平台认识你一点/);
    assert.match($(w, '#presence-fresh').textContent ?? '', /预计 36 分钟后继续/);
  } finally {
    w.Date.now = originalNow;
  }
});

// ── 活动流 ──
test('活动流：事件进流、最新在上、空态隐藏', async () => {
  const { w, pushActivity } = await boot();
  assert.equal(hidden($(w, '#stream-empty')), false, '无事件时展示空态');
  pushActivity({ ts: new Date().toISOString(), type: 'like', sentence: '给「露营装备」点了个赞' });
  pushActivity({ ts: new Date().toISOString(), type: 'note_open', sentence: '打开笔记「秋日漫步」' });
  assert.equal(hidden($(w, '#stream-empty')), true);
  const rows = Array.from(w.document.querySelectorAll('#activity-stream .ev'));
  assert.equal(rows.length, 2);
  assert.match((rows[0] as HTMLElement).textContent ?? '', /秋日漫步/, '最新在上');
});

// ── 发布卡：纯展示零按钮 ──
test('发布卡候审：可见、第三节点琥珀、卡内零按钮（审批只在飞书）', async () => {
  const at = new Date(Date.now() - 3 * 60_000).toISOString();
  const { w } = await boot({ publish: { state: 'pending', title: '秋日城市漫步', at } });
  const card = $(w, '#pub-card');
  assert.equal(hidden(card), false);
  assert.equal(card.querySelectorAll('button').length, 0, '发布卡 MUST 零按钮');
  assert.match($(w, '#pub-title').textContent ?? '', /秋日城市漫步/);
  assert.match($(w, '#pub-corner').textContent ?? '', /已等 3 分钟/);
  const steps = Array.from(card.querySelectorAll('.j-step'));
  assert.ok((steps[2] as HTMLElement).classList.contains('cur'));
  assert.match($(w, '#pub-foot').textContent ?? '', /飞书/);
  assert.ok(!($(w, '#pub-foot').textContent ?? '').includes('再次提醒'), '未收到再提醒事件绝不谎称');
});

test('洗稿稿件预览：发布卡显示查看入口，打开抽屉展示正文/话题/配图且无原稿字段', async () => {
  const { w } = await boot({
    publish: { state: 'pending', title: '洗稿标题', code: '#89', at: new Date().toISOString() },
    publishPreview: {
      recordId: 89,
      code: '#89',
      kind: 'rewrite',
      title: '洗稿标题',
      content: '第一段正文\n第二段正文',
      topics: ['生活方式', '周末去哪儿'],
      images: ['https://cdn.example.com/1.jpg'],
      contentVersion: 0,
      updatedAt: Date.now(),
    },
  });
  assert.equal(hidden($(w, '#pub-preview-link')), false);
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  assert.ok($(w, '#publish-preview-panel').classList.contains('open'));
  assert.equal($(w, '#publish-preview-kind').textContent, '洗稿稿件');
  assert.equal($(w, '#publish-preview-title').textContent, '洗稿标题');
  assert.match($(w, '#publish-preview-content').textContent ?? '', /第一段正文/);
  assert.match($(w, '#publish-preview-content').textContent ?? '', /#生活方式/);
  assert.equal($(w, '#publish-preview-content img').getAttribute('src'), 'https://cdn.example.com/1.jpg');
  assert.doesNotMatch($(w, '#publish-preview-content').textContent ?? '', /原稿|作者|链接/);
  $(w, '#publish-preview-close').dispatchEvent(new w.Event('click'));
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), false);
});

test('发布卡已通过 → 第四节点平静色 + 无需操作', async () => {
  const { w } = await boot({ publish: { state: 'approved', title: 't', at: new Date().toISOString() } });
  const steps = Array.from($(w, '#pub-card').querySelectorAll('.j-step'));
  assert.ok((steps[3] as HTMLElement).classList.contains('cur'));
  assert.ok((steps[3] as HTMLElement).classList.contains('calm'));
  assert.match($(w, '#pub-foot').textContent ?? '', /无需操作/);
});

test('发布终态 → 折进活动流 + 卡片常驻转「上次发布」', async () => {
  const { w, pushStatus } = await boot({ publish: { state: 'pending', title: '秋日漫步', at: new Date().toISOString() } });
  pushStatus(makeStatus({ publish: { state: 'published', title: '秋日漫步', at: new Date().toISOString() } }));
  assert.equal(hidden($(w, '#pub-card')), false, '卡片常驻不消失');
  assert.equal($(w, '#pub-head').textContent, '上次发布');
  assert.match($(w, '#pub-title').textContent ?? '', /秋日漫步/);
  assert.equal(hidden($(w, '#pub-link')), false, '「打开飞书」纯导航，历史态也在');
  assert.match($(w, '#activity-stream').textContent ?? '', /已发布/);
  // 再推一次同状态：按签名去重，不重复记
  pushStatus(makeStatus({ publish: { state: 'published', title: '秋日漫步', at: new Date().toISOString() } }));
  const doneRows = Array.from(w.document.querySelectorAll('#activity-stream .ev.pub-done'));
  assert.equal(doneRows.length, 1);
});

test('发布卡常驻：从未发布 → 空态幽灵旅程（同设计语言、零按钮）', async () => {
  const { w } = await boot(); // publish: null, lastPublish 无
  const card = $(w, '#pub-card');
  assert.equal(hidden(card), false, '空态也常驻');
  assert.ok(card.classList.contains('empty'));
  assert.match($(w, '#pub-title').textContent ?? '', /还没有发布过/);
  assert.equal(card.querySelectorAll('button').length, 0, '空态同样零按钮');
  assert.equal(hidden($(w, '#pub-link')), false, '空态也放蓝色「打开飞书」');
  assert.ok(card.querySelector('#pub-thumb'), '封面占位常在（空态为淡化默认形态）');
  assert.match($(w, '#pub-meta').textContent ?? '', /编号 —/, '编号默认形态');
  assert.ok($(w, '#pub-foot').querySelector('b'), '脚注关键词加粗');
  assert.match($(w, '#pub-foot').textContent ?? '', /通过后才会发布/);
  assert.ok(!($(w, '#pub-foot').textContent ?? '').includes('**'), '加粗标记不外露');
  const dots = Array.from(card.querySelectorAll('.j-step'));
  assert.ok(dots.every((el) => (el as HTMLElement).classList.contains('todo')), '幽灵旅程全 todo');
});

test('发布卡常驻：带本地历史 → 直接呈现上次发布', async () => {
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const { w } = await boot({ lastPublish: { title: '上周的咖啡馆合集', at } });
  assert.equal($(w, '#pub-head').textContent, '上次发布');
  assert.match($(w, '#pub-title').textContent ?? '', /咖啡馆合集/);
  assert.match($(w, '#pub-corner').textContent ?? '', /小时前/);
});

// ── 形状兼容：旧 status（无新增字段）不炸 ──
test('旧形状 status（无 presence/account/publish）→ 安全降级渲染', async () => {
  const { w, pushStatus } = await boot();
  pushStatus({
    auth: 'checking', cloud: 'disconnected', session: 'idle', risk: 'normal', edge: 'stopped',
    stats: { views: 0, likes: 0, collects: 0 }, provider: 'adspower',
    lastMessage: 'x', updatedAt: new Date().toISOString(),
  });
  assert.ok($(w, '#health-label').textContent, '健康药丸仍有结论');
  assert.equal($(w, '#comments').textContent, '0', '旧 stats 无 comments 兜底 0');
});

test('回归：今日进展数字永不为空（缺字段兜 0 + 零值弱化）', async () => {
  const { w, pushStatus } = await boot();
  // 只带 views 的残缺 stats（模拟老 bug 时代的坏状态）：其余计数展示 0 而不是空/undefined
  pushStatus(makeStatus({ stats: { views: 7 } }));
  assert.equal($(w, '#views').textContent, '7');
  assert.equal($(w, '#likes').textContent, '0');
  assert.equal($(w, '#collects').textContent, '0');
  assert.equal($(w, '#comments').textContent, '0');
  assert.equal($(w, '#follows').textContent, '0');
  assert.equal($(w, '#publishes').textContent, '0');
  assert.equal($(w, '#daily-summary .lbl').textContent, '今日进展');
  assert.ok($(w, '#usage-limit').classList.contains('hidden'), '本机实时没有权威计划数据，不展示完成判断');
  assert.ok($(w, '#likes').classList.contains('zero'), '零值应弱化显示');
  assert.ok(!$(w, '#views').classList.contains('zero'), '非零值不弱化');
});

test('今日进展：收到账号 dailyUsage 后优先显示账号今日，并标记已完成计划', async () => {
  const { w, pushStatus } = await boot();
  const originalNow = w.Date.now;
  w.Date.now = () => 1730000002000;
  pushStatus(makeStatus({
    stats: { views: 999, likes: 999, collects: 999, comments: 999, follows: 999, publishes: 999 },
    dailyUsage: {
      asOf: 1730000001000,
      quotaLevel: 'normal',
      totals: { view: 10, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
      quotas: { view: 150, like: 3, collect: 25, comment: 8, follow: 15, publish: 1 },
      saturated: ['like', 'publish'],
      windows: {
        session: {
          active: true,
          startedAt: 1730000000000,
          windowMs: 600000,
          expiresAt: 1730000600000,
          totals: { view: 2, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
          quotas: { like: 10, collect: 5, comment: 2, follow: 3 },
          saturated: [],
        },
        minute: {
          startedAt: 1729999941000,
          windowMs: 60000,
          expiresAt: 1730000061000,
          releaseAt: 1730000042000,
          totals: { view: 3, like: 3, collect: 0, comment: 0, follow: 0, publish: 0 },
          quotas: { view: 8, like: 3, collect: 2, comment: 1, follow: 1, publish: 1 },
          saturated: ['like'],
        },
        hour: {
          startedAt: 1729996401000,
          windowMs: 3600000,
          expiresAt: 1730003601000,
          totals: { view: 10, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
          quotas: { view: 60, like: 13, collect: 7, comment: 2, follow: 4, publish: 1 },
          saturated: [],
        },
        day: {
          startedAt: 1729958400000,
          windowMs: 86400000,
          expiresAt: 1730044800000,
          totals: { view: 10, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
          quotas: { view: 150, like: 3, collect: 25, comment: 8, follow: 15, publish: 1 },
          saturated: ['like', 'publish'],
        },
      },
    },
  }));
  assert.match($(w, '#usage-source').textContent ?? '', /账号今日/);
  assert.match($(w, '#usage-source').textContent ?? '', /均衡节奏/);
  assert.match($(w, '#usage-limit').textContent ?? '', /今日点赞\/发帖计划已完成/);
  assert.match($(w, '#usage-limit').title ?? '', /发帖：阶段节奏、今日计划已完成/);
  assert.ok($(w, '#usage-limit').classList.contains('complete'));
  assert.ok(!$(w, '#usage-limit').classList.contains('hit'));
  assert.equal($(w, '#quota-toggle').getAttribute('aria-label'), '查看今日节奏');
  assert.ok($(w, '#quota-windows').classList.contains('hidden'), 'collapsed card should only show daily totals');
  $(w, '#daily-summary').click();
  await tick();
  assert.equal($(w, '#quota-toggle').getAttribute('aria-label'), '收起今日节奏');
  assert.ok(!$(w, '#quota-windows').classList.contains('hidden'));
  assert.equal(w.document.querySelectorAll('.quota-window-detail').length, 4);
  assert.equal(w.document.querySelectorAll('.qwd-row').length, 24);
  assert.match($(w, '#quota-windows').textContent ?? '', /本轮计划/);
  assert.match($(w, '#quota-windows').textContent ?? '', /阶段节奏/);
  assert.match($(w, '#quota-windows').textContent ?? '', /2\/-/);
  assert.match($(w, '#quota-windows').textContent ?? '', /10\/60/);
  assert.match($(w, '#quota-windows').textContent ?? '', /继续/);
  assert.doesNotMatch($(w, '#daily-summary').textContent ?? '', /已达|上限|额度|释放|已满/);
  assert.equal($(w, '#views').textContent, '10');
  assert.equal($(w, '#likes').textContent, '3');
  assert.equal($(w, '#follows').textContent, '2');
  assert.equal($(w, '#publishes').textContent, '1');
  assert.equal($(w, '#likes-cap').textContent, '/3');
  assert.ok($(w, '#likes').closest('.kpi')?.classList.contains('complete'));
  assert.ok($(w, '#publishes').closest('.kpi')?.classList.contains('complete'));
  w.Date.now = originalNow;
});

test('今日进展：过期窗口不再作为当前计划完成展示', async () => {
  const now = 1730000120000;
  const { w, pushStatus } = await boot();
  const originalNow = w.Date.now;
  w.Date.now = () => now;
  try {
    pushStatus(makeStatus({
      dailyUsage: {
        asOf: now,
        quotaLevel: 'normal',
        totals: { view: 11, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
        quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
        saturated: [],
        windows: {
          minute: {
            startedAt: now - 120000,
            windowMs: 60000,
            expiresAt: now - 60000,
            refreshAt: now + 30000,
            totals: { view: 8, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
            quotas: { view: 8, like: 3, collect: 2, comment: 1, follow: 1, publish: 1 },
            saturated: ['view'],
          },
        },
      },
    }));
    assert.match($(w, '#usage-limit').textContent ?? '', /按计划进行中/);
    assert.ok(!$(w, '#usage-limit').classList.contains('complete'));
    $(w, '#daily-summary').click();
    await tick();
    assert.match($(w, '#quota-windows').textContent ?? '', /准备下一轮/);
    assert.match($(w, '#quota-windows').textContent ?? '', /约 30 秒后进入下一轮/);
  } finally {
    w.Date.now = originalNow;
  }
});

test('账号无昵称 → 标题带显示「账号 …尾4位」，绝不摆长 id', async () => {
  const { w } = await boot({ account: { id: '66cd1d4f000000001d0314ee', name: '' } });
  assert.equal($(w, '#acct-name').textContent, '账号 …14ee');
  assert.equal($(w, '#acct-ava').textContent, '书');
});

test('AdsPower 环境名作账号标签兜底：平铺展示、不加 @（不冒充小红书昵称）', async () => {
  const { w } = await boot({ account: { id: '66cd1d4f000000001d0314ee', name: 'Tmax', source: 'env' } });
  assert.equal($(w, '#acct-name').textContent, 'Tmax');
  assert.equal($(w, '#acct-ava').textContent, 'T');
});

test('选环境时环境名随设置持久化（adsProfileName）', async () => {
  const saves: Array<Record<string, unknown>> = [];
  const { w } = await boot({ edge: 'stopped', session: 'idle' }, {
    getStatus: async () => ({ auth: 'checking', cloud: 'disconnected', session: 'idle', risk: 'normal', edge: 'stopped', stats: { views: 0, likes: 0, collects: 0, comments: 0 }, provider: 'adspower', lastMessage: '', updatedAt: new Date().toISOString() }),
    getSettings: async () => ({ provider: 'adspower', adsProfileId: '', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x' }),
    adsListProfiles: async () => ({ ok: true, profiles: [
      { userId: 'u1', serialNumber: '1', name: 'Tmax', groupName: 'g', proxy: 'p' },
      { userId: 'u2', serialNumber: '2', name: '工程师大白', groupName: 'g', proxy: 'p' },
    ] }),
    saveSettings: async (patch: Record<string, unknown>) => { saves.push(patch); return { saveOk: true }; },
  });
  const items = Array.from(w.document.querySelectorAll('.ads-env-item'));
  (items[1] as HTMLElement).dispatchEvent(new w.Event('click')); // 选「工程师大白」
  $(w, '#session-fab').dispatchEvent(new w.Event('click')); // 启动 = 先存再起
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const saved = saves.find((p) => p.adsProfileId === 'u2');
  assert.equal(saved?.adsProfileName, '工程师大白', '保存的设置应带环境名');
});

test('暂停态：在场感带「状态更新 · N 前」时间戳，不留大空白', async () => {
  const at = new Date(Date.now() - 8000).toISOString();
  const { w } = await boot({ session: 'paused', edge: 'stopped', presence: { text: 'x', at } });
  assert.match($(w, '#presence-text').textContent ?? '', /已暂停/);
  assert.match($(w, '#presence-fresh').textContent ?? '', /状态更新/);
});

test('开发者详情默认不显示；设置抽屉开关打开并持久化', async () => {
  const saves: Array<Record<string, unknown>> = [];
  const { w } = await boot({}, {
    saveSettings: async (patch: Record<string, unknown>) => { saves.push(patch); return { saveOk: true }; },
  });
  assert.equal(hidden($(w, '#dev-section')), true, '默认隐藏');
  const toggle = $(w, '#dev-toggle') as HTMLInputElement;
  assert.ok($(w, '#drawer').contains(toggle), '开关在设置抽屉里');
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change'));
  assert.equal(hidden($(w, '#dev-section')), false, '打开后显示');
  assert.ok(saves.some((p) => p.devDetails === true), '开关状态应持久化');
});

test('活动流条目带类型记号（治纯文字墙）', async () => {
  const { w, pushActivity } = await boot();
  pushActivity({ ts: new Date().toISOString(), type: 'like', sentence: '点了个赞' });
  pushActivity({ ts: new Date().toISOString(), type: 'collect', sentence: '收藏了' });
  const ics = Array.from(w.document.querySelectorAll('#activity-stream .ev-ic'));
  assert.equal(ics.length, 2);
  assert.ok((ics[0] as HTMLElement).classList.contains('ic-collect'), '最新在上=收藏');
  assert.equal((ics[0] as HTMLElement).textContent, '藏');
});

// ── 发布卡收展（dock）──
test('运行中且无审批 → 发布卡自动收起为薄条；点击可临时展开', async () => {
  const { w } = await boot(); // running + empty
  const card = $(w, '#pub-card');
  assert.ok(card.classList.contains('collapsed'), '运行中空态应收起');
  assert.equal(hidden($(w, '#pub-bar')), false, '薄条可见');
  assert.match($(w, '#pub-bar-sum').textContent ?? '', /还没有发布过/);
  assert.ok($(w, '#pub-main').classList.contains('folded'));
  $(w, '#pub-bar').dispatchEvent(new w.Event('click'));
  assert.ok(!card.classList.contains('collapsed'), '点击薄条临时展开');
});

test('发布卡薄条展开后，点击卡头可收起', async () => {
  const { w } = await boot({ lastPublish: { title: '上周的咖啡馆合集', at: new Date().toISOString() } });
  const card = $(w, '#pub-card');
  assert.ok(card.classList.contains('collapsed'), '运行中上次发布应默认收起');
  $(w, '#pub-bar').dispatchEvent(new w.Event('click'));
  assert.ok(!card.classList.contains('collapsed'), '点击薄条展开');
  $(w, '#pub-head-row').dispatchEvent(new w.Event('click'));
  assert.ok(card.classList.contains('collapsed'), '点击卡头应收起');
});

test('审批到来 → 自动展开；审批落地（仍在运行）→ 再收起为「上次发布」薄条', async () => {
  const { w, pushStatus } = await boot(); // running + empty → collapsed
  pushStatus(makeStatus({ publish: { state: 'pending', title: '秋日漫步', at: new Date().toISOString() } }));
  const card = $(w, '#pub-card');
  assert.ok(!card.classList.contains('collapsed'), '在途审批必须展开');
  assert.equal(hidden($(w, '#pub-bar')), true);
  pushStatus(makeStatus({ publish: { state: 'published', title: '秋日漫步', at: new Date().toISOString() } }));
  assert.ok(card.classList.contains('collapsed'), '审批落地后收回薄条');
  assert.match($(w, '#pub-bar-sum').textContent ?? '', /上次发布/);
});

test('未运行时发布卡保持展开（空态旅程有引导价值）', async () => {
  const { w } = await boot({ edge: 'stopped', session: 'idle' });
  assert.ok(!$(w, '#pub-card').classList.contains('collapsed'));
  assert.equal(hidden($(w, '#pub-bar')), true);
});

// ── 循环 chip ──
test('循环 chip 随阶段点亮，停止时全灭', async () => {
  const { w, pushStatus } = await boot({ loopStage: 'read' });
  const on = () => Array.from(w.document.querySelectorAll('.loop-step.on')).map((el) => (el as HTMLElement).dataset.stage);
  assert.deepEqual(on(), ['read']);
  pushStatus(makeStatus({ loopStage: 'interact' }));
  assert.deepEqual(on(), ['interact']);
  pushStatus(makeStatus({ edge: 'stopped', session: 'idle' }));
  assert.deepEqual(on(), [], '停止时不点亮任何阶段');
});
