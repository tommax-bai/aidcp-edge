import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';
import { createRequire } from 'node:module';

// 多环境 fleet 主界面（edge-multi-environment-fleet）：环境栏 / envId 路由不串号 / 切换环境整体切换 /
// 引导处理流 / 全部启动内存拦阻 —— 用真实 index.html + ui-logic.js + renderer.js 在 jsdom 里驱动。
const require = createRequire(import.meta.url);
const uiLogic = require('../../src/electron/renderer/ui-logic.js') as {
  fleetLevel: (s: unknown, now: number) => { level: string; needsAction: boolean; label: string };
  fleetRailModel: (l: unknown[], now: number) => { rows: Array<{ envId: string; level: string; needsAction: boolean }>; pendingCount: number };
  FLEET_STALE_MS: number;
};

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const rendererCss = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');

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
    stats: { views: 0, likes: 0, collects: 0, comments: 0, follows: 0, publishes: 0 },
    provider: 'adspower',
    lastMessage: '',
    updatedAt: new Date().toISOString(),
    account: null,
    presence: { text: '…', at: new Date().toISOString() },
    publish: null,
    ...over,
  };
}

interface BootHandles {
  w: DOMWindow;
  pushStatus: (s: unknown) => void;
  pushActivity: (e: unknown) => void;
  pushFleet: (snap: unknown) => void;
  calls: Record<string, unknown[]>;
}

async function boot(apiOver: Record<string, unknown> = {}, settingsOver: Record<string, unknown> = {}): Promise<BootHandles> {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  openWindows.push(window);
  let pushStatus: (s: unknown) => void = () => undefined;
  let pushActivity: (e: unknown) => void = () => undefined;
  let pushFleet: (snap: unknown) => void = () => undefined;
  const calls: Record<string, unknown[]> = { relogin: [], showDriven: [], resetParking: [], startAll: [], select: [], close: [], notify: [], start: [], resume: [] };
  const settings = {
    provider: 'adspower',
    adsProfileId: 'p1',
    adsProfileName: '环境一',
    environments: [
      { profileId: 'p1', name: '环境一', platform: 'xiaohongshu' },
      { profileId: 'p2', name: '环境二', platform: 'xiaohongshu' },
    ],
    adsApiKey: '',
    adsApiBase: '',
    railCollapsed: true,
    adsDownloadUrl: 'https://x',
    ...settingsOver,
  };
  (window as unknown as { aidcpEdge: unknown }).aidcpEdge = {
    onStatusUpdate: (cb: (s: unknown) => void) => { pushStatus = cb; },
    onActivity: (cb: (e: unknown) => void) => { pushActivity = cb; },
    onFleetUpdate: (cb: (snap: unknown) => void) => { pushFleet = cb; },
    getStatus: async () => makeStatus({ envId: 'ads-p1', envName: '环境一' }),
    getSettings: async () => settings,
    saveSettings: async (patch: Record<string, unknown>) => ({ ...settings, ...patch, saveOk: true }),
    fleetGet: async () => ({
      provider: 'adspower',
      selectedEnvId: 'ads-p1',
      railCollapsed: true,
      environments: [
        { envId: 'ads-p1', kind: 'adspower', profileId: 'p1', name: '环境一', platform: 'xiaohongshu', status: makeStatus({ envId: 'ads-p1', envName: '环境一' }) },
        { envId: 'ads-p2', kind: 'adspower', profileId: 'p2', name: '环境二', platform: 'xiaohongshu', status: makeStatus({ envId: 'ads-p2', envName: '环境二', edge: 'stopped', session: 'idle' }) },
      ],
    }),
    fleetSelect: async (envId: string) => { calls.select.push(envId); return {}; },
    fleetSetRailCollapsed: async () => ({ ok: true }),
    fleetStartAll: async (opts: unknown) => { calls.startAll.push(opts); return { ok: true, queued: 2 }; },
    fleetStopAll: async () => ({ ok: true }),
    relogin: async (envId: string) => { calls.relogin.push(envId); return makeStatus({ envId }); },
    notify: async (payload: unknown) => { calls.notify.push(payload); return { ok: true }; },
    showDrivenBrowser: async (envId: string) => { calls.showDriven.push(envId); return { ok: true, hint: '已请求前置；窗口平时停放在屏幕边缘。' }; },
    resetBrowserParking: async (envId: string) => { calls.resetParking.push(envId); return { ok: true }; },
    pause: async () => makeStatus(),
    resume: async (envId: string) => { calls.resume.push(envId); return makeStatus({ envId }); },
    close: async (envId: string) => { calls.close.push(envId); return makeStatus({ envId, edge: 'stopped', cloud: 'disconnected', session: 'closed' }); },
    start: async (envId: string) => { calls.start.push(envId); return makeStatus({ envId }); },
    restart: async () => makeStatus(),
    adsStatus: async () => ({ ok: false, error: 'not running' }),
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    adsTemplates: async () => [],
    openFeishu: async () => ({ ok: true }),
    ...apiOver,
  };
  const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
  const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');
  window.eval(uiLogicSrc);
  window.eval(rendererSrc);
  await tick();
  await tick();
  return { w: window, pushStatus, pushActivity, pushFleet, calls };
}

// ── 纯逻辑：状态环分级 / 排序 / 失联 ──

test('fleetLevel：失联（心跳超阈值）绝不呈现为在线', () => {
  const now = Date.now();
  const fresh = uiLogic.fleetLevel({ edge: 'running', session: 'running', cloud: 'connected', updatedAt: new Date(now - 1000).toISOString() }, now);
  assert.equal(fresh.level, 'running');
  const stale = uiLogic.fleetLevel({ edge: 'running', session: 'running', cloud: 'connected', updatedAt: new Date(now - uiLogic.FLEET_STALE_MS - 1000).toISOString() }, now);
  assert.equal(stale.level, 'stale');
  assert.equal(stale.label, '失联');
});

// change honest-first-connect-label：环境栏存在的理由是「一眼看出谁真的需要我」。把每一次正常冷启动
// 都染成琥珀「需要你处理」并浮到顶部，会让这个信号和真正待人工的登录 / 验证码 / 风控受限混作一谈。
test('fleetLevel：冷启动窗口留在 launching，绝不冒充需要人工', () => {
  const now = Date.now();
  const booting = uiLogic.fleetLevel(
    { edge: 'running', session: 'running', cloud: 'disconnected', cloudEverConnected: false, updatedAt: new Date(now).toISOString() },
    now,
  );
  assert.equal(booting.level, 'launching');
  assert.equal(booting.needsAction, false); // 正常启动不是待办事项
  assert.equal(booting.label, '启动中');
});

test('fleetLevel：连上过之后掉线才升为需处理的「正在重新连接」', () => {
  const now = Date.now();
  const dropped = uiLogic.fleetLevel(
    { edge: 'running', session: 'running', cloud: 'disconnected', cloudEverConnected: true, updatedAt: new Date(now).toISOString() },
    now,
  );
  assert.equal(dropped.level, 'attention');
  assert.equal(dropped.needsAction, true);
  assert.equal(dropped.label, '正在重新连接');
});

test('fleetLevel：放弃重启和冻结为 error；账号重复运行为 attention', () => {
  const now = Date.now();
  assert.equal(uiLogic.fleetLevel({ respawnGaveUp: true, edge: 'stopped' }, now).level, 'error');
  assert.equal(uiLogic.fleetLevel({ risk: 'frozen', edge: 'running' }, now).level, 'error');
  const warn = uiLogic.fleetLevel({ edge: 'stopped', session: 'idle', sameAccountWarning: { message: 'x' } }, now);
  assert.equal(warn.level, 'attention');
  assert.equal(warn.needsAction, true);
  assert.equal(warn.label, '账号重复运行');
});

test('fleetLevel：暂停与关闭同属离线组但标签明确区分', () => {
  const now = Date.now();
  const paused = uiLogic.fleetLevel({ edge: 'stopped', session: 'paused' }, now);
  const closed = uiLogic.fleetLevel({ edge: 'stopped', session: 'closed' }, now);
  assert.equal(paused.level, 'offline');
  assert.equal(paused.label, '已暂停');
  assert.equal(closed.level, 'offline');
  assert.equal(closed.label, '已关闭');
});

test('红线：阻断浮层（验证码/登录墙）即便 edge 仍 running 也判需处理，绝不呈现为绿色在线', () => {
  const now = Date.now();
  // 核心遇验证码本地暂停：edge/session 仍 running、risk 至多 warned，若不专门判会绿色在线（漏盯验证码）。
  const blocked = uiLogic.fleetLevel({ edge: 'running', session: 'running', cloud: 'connected', overlayBlocked: true, updatedAt: new Date(now).toISOString() }, now);
  assert.equal(blocked.level, 'attention');
  assert.equal(blocked.needsAction, true);
  assert.match(blocked.label, /处理/);
  // 清除后回到在线
  const cleared = uiLogic.fleetLevel({ edge: 'running', session: 'running', cloud: 'connected', overlayBlocked: false, updatedAt: new Date(now).toISOString() }, now);
  assert.equal(cleared.level, 'running');
});

test('fleetRailModel：需处理浮顶、同级保持花名册序、待处理计数正确', () => {
  const now = Date.now();
  const model = uiLogic.fleetRailModel([
    { envId: 'a', name: 'A', status: makeStatus({ updatedAt: new Date(now).toISOString() }) },
    { envId: 'b', name: 'B', status: makeStatus({ auth: 'login required', edge: 'stopped', updatedAt: new Date(now).toISOString() }) },
    { envId: 'c', name: 'C', status: makeStatus({ edge: 'warning', updatedAt: new Date(now).toISOString() }) },
  ], now);
  assert.deepEqual(model.rows.map((r) => r.envId), ['c', 'b', 'a'], 'error > attention > running');
  assert.equal(model.pendingCount, 2);
});

// ── DOM：环境栏 / 路由不串号 / 切换整体切换 ──

test('环境栏：fleet 快照建行、默认收起、点选切换主区域并回写选中', async () => {
  const { w, calls } = await boot();
  const rail = w.document.querySelector('#env-rail')!;
  assert.equal(rail.classList.contains('hidden'), false, '有环境时环境栏可见');
  assert.equal(rail.classList.contains('collapsed'), true, '默认收起为窄图标条');
  const rows = w.document.querySelectorAll('.rail-row');
  assert.equal(rows.length, 2);
  // 选中环境一时标题带显示其账号标签
  assert.match(w.document.querySelector('#acct-name')!.textContent!, /环境一|小红书账号/);
  // 点选环境二 → fleetSelect 回写 + 行选中态
  const rowB = [...rows].find((r) => (r as HTMLElement).dataset.envId === 'ads-p2') as HTMLElement;
  rowB.click();
  await tick();
  assert.deepEqual(calls.select, ['ads-p2']);
  assert.equal(
    (w.document.querySelector('.rail-row[data-env-id="ads-p2"]') as HTMLElement).classList.contains('selected'),
    true,
  );
});

test('环境头像三态：①未选中→选中 ②再点→抬前显示（shown 态）③再点→归位（撤 shown）', async () => {
  const { w, calls, pushStatus } = await boot();
  // 抬前/归位只对在跑环境有意义（离线环境的显示态会被清）：先让环境二在运行。
  pushStatus(makeStatus({ envId: 'ads-p2', envName: '环境二' }));
  await tick();
  const rowOf = (id: string) => w.document.querySelector(`.rail-row[data-env-id="${id}"]`) as HTMLElement;
  // ① 未选中 → 仅选中，绝不触发浏览器指令
  rowOf('ads-p2').click();
  await tick();
  assert.ok(calls.select.includes('ads-p2'));
  assert.equal(rowOf('ads-p2').classList.contains('selected'), true);
  assert.equal(calls.showDriven.length, 0, '仅选中不抬浏览器');
  // ② 已选中 → 抬前显示该环境浏览器，行进入 shown 态
  rowOf('ads-p2').click();
  await tick();
  assert.deepEqual(calls.showDriven, ['ads-p2'], '第二次点击抬前该环境浏览器');
  assert.equal(rowOf('ads-p2').classList.contains('shown'), true, '抬前后行进入 shown 态');
  // ③ 已显示 → 归位，撤 shown
  rowOf('ads-p2').click();
  await tick();
  assert.deepEqual(calls.resetParking, ['ads-p2'], '第三次点击让该环境浏览器归位');
  assert.equal(rowOf('ads-p2').classList.contains('shown'), false, '归位后撤 shown 态');
  // 切到另一个环境即重置三态相位（shownEnv 清空）
  rowOf('ads-p1').click();
  await tick();
  assert.equal(rowOf('ads-p2').classList.contains('shown'), false);
});

test('环境头像三态：验证码浮层态（core 仍在跑）保留 shown，第三态仍可归位', async () => {
  const { w, calls, pushStatus } = await boot();
  const rowOf = (id: string) => w.document.querySelector(`.rail-row[data-env-id="${id}"]`) as HTMLElement;
  pushStatus(makeStatus({ envId: 'ads-p2', envName: '环境二' }));
  await tick();
  rowOf('ads-p2').click(); await tick(); // 选中
  rowOf('ads-p2').click(); await tick(); // 抬前 → shown
  assert.deepEqual(calls.showDriven, ['ads-p2']);
  assert.equal(rowOf('ads-p2').classList.contains('shown'), true);
  // 进入验证码浮层态：needsAction/attention 但 core 仍 running、浏览器仍可控 → 不得清 shown。
  pushStatus(makeStatus({ envId: 'ads-p2', envName: '环境二', overlayBlocked: true }));
  await tick();
  assert.equal(rowOf('ads-p2').classList.contains('shown'), true, 'attention 态（core 在跑）保留 shown，否则盯验证码环境的第三态不可达');
  // 第三态可达：再点 → 归位（resetBrowserParking），而非又一次抬前。
  rowOf('ads-p2').click(); await tick();
  assert.deepEqual(calls.resetParking, ['ads-p2'], 'attention 态第三次点击应归位而非再次抬前');
  assert.equal(rowOf('ads-p2').classList.contains('shown'), false);
});

test('环境头像三态：键盘落在人设 ✦ 图标上不触发浏览器抬前/归位', async () => {
  const { w, calls, pushStatus } = await boot();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一' }));
  await tick();
  const pIcon = (w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-persona') as HTMLElement);
  // ads-p1 已是选中环境；焦点在其 ✦ 上按 Enter：整行 keydown 必须放行（e.target≠行），绝不触发三态切换。
  pIcon.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  assert.equal(calls.showDriven.length, 0, '键盘落在 ✦ 上不得抬前浏览器');
  assert.equal(calls.resetParking.length, 0, '键盘落在 ✦ 上不得归位浏览器');
});

test('人设弹窗：账号已绑人设时绝不自动弹', async () => {
  const { w, calls, pushStatus } = await boot();
  await tick();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: true }));
  await tick();
  assert.equal(w.document.querySelector('#persona-pop')!.classList.contains('open'), false, '已绑账号不得自动弹出人设浮层');
  assert.equal(calls.notify.length, 0, '已绑账号不得发通知');
});

test('人设浮层：已绑账号可手动进入更新流程，确认后覆盖当前人设', async () => {
  const calls: Record<string, unknown[]> = { gen: [], persist: [] };
  const { w, pushStatus } = await boot({
    personaGenerate: async (envId: string, payload: { keywordSelections: string[] }) => {
      calls.gen.push({ envId, payload });
      return { ok: true, soulYaml: 'identity:\n  name: "新人设"', identitySummary: '新人设' };
    },
    personaPersist: async (envId: string, payload: { soulYaml: string }) => {
      calls.persist.push({ envId, payload });
      return { ok: true };
    },
  });
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: true }));
  await tick();

  (w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-bound-note')!.classList.contains('hidden'), false, '已绑账号先显示已设置卡片');
  (w.document.querySelector('#persona-update') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-wizard-body')!.classList.contains('hidden'), false, '点击更新后显示向导');
  assert.equal(w.document.querySelector('#persona-bound-note')!.classList.contains('hidden'), true, '更新中隐藏已设置卡片');
  assert.equal(w.document.querySelector('#persona-state-badge')!.textContent, '待更新');
  assert.match(w.document.querySelector('#persona-hint')!.textContent || '', /覆盖当前账号的人设/);
  assert.equal((w.document.querySelector('#persona-generate') as HTMLElement).textContent, '生成新草稿');

  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: true }));
  await tick();
  assert.equal(w.document.querySelector('#persona-wizard-body')!.classList.contains('hidden'), false, '更新中收到已绑状态推送不得把向导藏回去');

  (w.document.querySelector('.persona-kw-group[data-dim="content"][data-category="招聘求职"] .kw-btn') as HTMLElement).click();
  (w.document.querySelector('#persona-generate') as HTMLElement).click();
  await tick();
  assert.deepEqual((calls.gen[0] as { envId: string }).envId, 'ads-p1');
  assert.equal(w.document.querySelector('#persona-draft-summary')!.textContent, '新人设');
  assert.equal((w.document.querySelector('#persona-confirm') as HTMLElement).textContent, '确认更新');

  (w.document.querySelector('#persona-confirm') as HTMLElement).click();
  await tick();
  assert.deepEqual((calls.persist[0] as { envId: string }).envId, 'ads-p1');
  assert.match((calls.persist[0] as { payload: { soulYaml: string } }).payload.soulYaml, /新人设/);
  assert.equal(w.document.querySelector('#persona-wizard-body')!.classList.contains('hidden'), true, '确认更新后收起向导');
  assert.equal(w.document.querySelector('#persona-bound-note')!.classList.contains('hidden'), false, '确认更新后回到已设置卡片（不再出「开始运营」成长引导）');
  assert.match(w.document.querySelector('#persona-msg')!.textContent || '', /人设已更新/);
});

test('红线：并发环境的状态与活动按 envId 归属，切换环境不残留、不串号', async () => {
  const { w, pushStatus, pushActivity } = await boot();
  // 环境一：3 个浏览计数；环境二：99 个（若串号立刻可见）
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', stats: { views: 3, likes: 0, collects: 0, comments: 0, follows: 0, publishes: 0 } }));
  pushStatus(makeStatus({ envId: 'ads-p2', envName: '环境二', stats: { views: 99, likes: 0, collects: 0, comments: 0, follows: 0, publishes: 0 } }));
  pushActivity({ ts: new Date().toISOString(), type: 'like', sentence: '环境一给「A」点了赞', envId: 'ads-p1' });
  pushActivity({ ts: new Date().toISOString(), type: 'like', sentence: '环境二给「B」点了赞', envId: 'ads-p2' });
  await tick();
  // 当前选中环境一：只见环境一的计数与活动
  assert.equal(w.document.querySelector('#views')!.textContent, '3');
  const stream1 = w.document.querySelector('#activity-stream')!.textContent!;
  assert.match(stream1, /环境一给/);
  assert.doesNotMatch(stream1, /环境二给/, '环境二的活动 MUST NOT 混入环境一的流');
  // 切到环境二：整块投影切换、不残留环境一数据
  ([...w.document.querySelectorAll('.rail-row')].find((r) => (r as HTMLElement).dataset.envId === 'ads-p2') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#views')!.textContent, '99');
  const stream2 = w.document.querySelector('#activity-stream')!.textContent!;
  assert.match(stream2, /环境二给/);
  assert.doesNotMatch(stream2, /环境一给/, '切换后环境一的活动 MUST NOT 残留');
});

test('无 envId 的旧形状 / 空名册 → 单环境统计不变、环境栏常驻显示并给添加入口', async () => {
  const { w, pushStatus } = await boot({
    fleetGet: undefined,
    onFleetUpdate: undefined,
    getStatus: async () => makeStatus(),
  }, { environments: [], adsProfileId: 'u1' });
  pushStatus(makeStatus({ stats: { views: 7, likes: 0, collects: 0, comments: 0, follows: 0, publishes: 0 } }));
  await tick();
  assert.equal(w.document.querySelector('#views')!.textContent, '7', '单环境统计不变');
  const rail = w.document.querySelector('#env-rail')!;
  // 环境栏常驻显示（用户要求「左边栏默认展示」）：空名册也保留栏、强制展开、露出添加入口。
  assert.equal(rail.classList.contains('hidden'), false, '空名册也常驻显示环境栏');
  assert.equal(rail.classList.contains('expanded'), true, '空名册强制展开露出空态');
  assert.equal(w.document.querySelectorAll('.rail-row').length, 0, '空名册无环境行');
  assert.ok(w.document.querySelector('#rail-list .rail-empty'), '空态给「添加第一个环境」入口');
});

test('待处理徽标 + 需处理浮顶：需登录环境脉冲并计入徽标', async () => {
  const { w, pushStatus } = await boot();
  pushStatus(makeStatus({ envId: 'ads-p2', envName: '环境二', auth: 'login required', edge: 'stopped', session: 'idle' }));
  await tick();
  const badge = w.document.querySelector('#rail-badge')!;
  assert.equal(badge.classList.contains('hidden'), false);
  assert.equal(badge.textContent, '1');
  const firstRow = w.document.querySelector('.rail-row') as HTMLElement;
  assert.equal(firstRow.dataset.envId, 'ads-p2', '需处理环境浮顶');
  assert.equal(firstRow.classList.contains('pulse'), true, '需处理项状态环脉冲');
});

test('引导处理流：排队一次一个、打开窗口带诚实提示、恢复后自动前进直至完成', async () => {
  const { w, pushStatus, calls } = await boot();
  // 两个环境都需要登录
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', auth: 'login required', edge: 'stopped', session: 'idle' }));
  pushStatus(makeStatus({ envId: 'ads-p2', envName: '环境二', auth: 'login required', edge: 'stopped', session: 'idle' }));
  await tick();
  // 展开环境栏并进入引导
  (w.document.querySelector('#rail-toggle') as HTMLElement).click();
  const guideBtn = w.document.querySelector('#rail-guide') as HTMLElement;
  assert.equal(guideBtn.classList.contains('hidden'), false);
  guideBtn.click();
  await tick();
  const panel = w.document.querySelector('#guide-panel')!;
  assert.equal(panel.classList.contains('hidden'), false);
  assert.match(w.document.querySelector('#guide-title')!.textContent!, /剩 2 个/);
  // 打开窗口 → 诚实提示（不宣称已抬到最前）
  (w.document.querySelector('#guide-open') as HTMLElement).click();
  await tick();
  assert.equal(calls.showDriven.length, 1);
  assert.match(w.document.querySelector('#guide-hint')!.textContent!, /屏幕边缘|前置/);
  // 完成 · 重检 → 触发该环境 relogin
  (w.document.querySelector('#guide-done') as HTMLElement).click();
  await tick();
  assert.equal(calls.relogin.length, 1);
  // 该环境恢复 → 自动前进到下一个
  const firstEnv = calls.relogin[0] as string;
  pushStatus(makeStatus({ envId: firstEnv, envName: '环境一', auth: 'logged in', edge: 'running', session: 'running' }));
  await tick();
  assert.match(w.document.querySelector('#guide-title')!.textContent!, /剩 1 个/, '恢复后自动前进');
  // 第二个也恢复 → 引导完成收起
  const remaining = firstEnv === 'ads-p1' ? 'ads-p2' : 'ads-p1';
  pushStatus(makeStatus({ envId: remaining, envName: '环境二', auth: 'logged in', edge: 'running', session: 'running' }));
  await tick();
  assert.equal(w.document.querySelector('#guide-panel')!.classList.contains('hidden'), true);
  assert.match(w.document.querySelector('#guide-hint')!.textContent!, /处理完成/);
});

test('红线：引导流绝不在 relogin 重启瞬态误判已恢复而永久踢出未完成登录的环境', async () => {
  const { w, pushStatus, calls } = await boot();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', auth: 'login required', edge: 'stopped', session: 'idle' }));
  await tick();
  (w.document.querySelector('#rail-toggle') as HTMLElement).click();
  (w.document.querySelector('#rail-guide') as HTMLElement).click();
  await tick();
  assert.match(w.document.querySelector('#guide-title')!.textContent!, /剩 1 个/);
  (w.document.querySelector('#guide-done') as HTMLElement).click(); // 触发 relogin
  await tick();
  assert.equal(calls.relogin.length, 1);
  // relogin 重启瞬态：checking / starting / stopped —— needsAction 会短暂为 false，但 edge!=='running'，绝不退休
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', auth: 'checking', edge: 'stopped', session: 'idle' }));
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', auth: 'checking', edge: 'starting', session: 'running' }));
  await tick();
  assert.equal(w.document.querySelector('#guide-panel')!.classList.contains('hidden'), false, '瞬态不得让引导收起');
  assert.match(w.document.querySelector('#guide-title')!.textContent!, /剩 1 个/, '瞬态绝不误判已恢复');
  // 核心起来后仍需登录（登录其实没完成）→ 环境必须仍在引导队列、绝不被永久踢出
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', auth: 'login required', edge: 'running', session: 'running' }));
  await tick();
  assert.match(w.document.querySelector('#guide-title')!.textContent!, /剩 1 个/, '仍需登录 → 仍在队列');
  // 真正登录完成（edge running + 不需处理）→ 才退休、引导完成
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', auth: 'logged in', edge: 'running', session: 'running', cloud: 'connected' }));
  await tick();
  assert.equal(w.document.querySelector('#guide-panel')!.classList.contains('hidden'), true, '真恢复才收起');
});

test('红线：人设草稿绑定生成时的环境，中途切换环境后确认仍打回原环境（绝不跨账号误绑）', async () => {
  const calls: Record<string, unknown[]> = { gen: [], persist: [] };
  const { w } = await boot({
    personaGenerate: async (envId: string) => { calls.gen.push(envId); return { ok: true, soulYaml: 'soul: A', identitySummary: 'A 人设' }; },
    personaPersist: async (envId: string) => { calls.persist.push(envId); return { ok: true, firstPostOnboarding: true }; },
    // personaBound:false = 云端权威说未绑（向导只对权威未绑的账号开放；未知态出空态面板，见三态用例）。
    getStatus: async () => makeStatus({ envId: 'ads-p1', envName: '环境一', auth: 'logged in', cloud: 'connected', personaBound: false }),
  });
  // 环境一登录+连云 → 可生成
  (w as unknown as { pushStatus?: unknown }); // noop
  const gen = w.document.querySelector('#persona-generate') as HTMLButtonElement;
  // 选一个单选关键词组的项，令生成通过校验
  (w.document.querySelector('.persona-kw-group[data-dim="content"][data-category="招聘求职"] .kw-btn') as HTMLElement).click();
  // 不再手动放行：boot 首个 status 已 logged in+connected+权威未绑，闸必须自然打开（回归主进程 auth 链路的渲染侧契约）
  assert.equal(gen.disabled, false, '登录+连云+权威未绑后生成按钮必须自然可点（gate 不得永久 disabled）');
  gen.click();
  await tick();
  assert.deepEqual(calls.gen, ['ads-p1'], '生成打到当前环境');
  // 切到环境二
  ([...w.document.querySelectorAll('.rail-row')].find((r) => (r as HTMLElement).dataset.envId === 'ads-p2') as HTMLElement).click();
  await tick();
  // 切换后草稿被清（向导每环境独立），确认按钮此时无草稿 → 不会误 persist 到环境二
  (w.document.querySelector('#persona-confirm') as HTMLElement).click();
  await tick();
  assert.equal(calls.persist.length, 0, '切换环境清空草稿后，确认不再向任何环境写入（绝不误绑环境二）');
});

test('全部启动：内存预检超限 → 诚实拦阻出确认；确认后 force 放行', async () => {
  let callCount = 0;
  const { w } = await boot({
    fleetStartAll: async (opts: { force?: boolean } | undefined) => {
      callCount += 1;
      if (!opts || !opts.force) return { ok: false, reason: 'ram', requiredMB: 4096, freeMB: 2048, plannedCount: 4 };
      return { ok: true, queued: 4, envIds: ['ads-p1', 'ads-p2', 'ads-a', 'ads-b'] };
    },
  });
  (w.document.querySelector('#rail-toggle') as HTMLElement).click();
  (w.document.querySelector('#rail-start-all') as HTMLElement).click();
  await tick();
  const confirm = w.document.querySelector('#rail-ram-confirm')!;
  assert.equal(confirm.classList.contains('hidden'), false, '超限必须先诚实拦阻');
  assert.match(w.document.querySelector('#rail-ram-text')!.textContent!, /4096.*2048|可能不足/);
  (w.document.querySelector('#rail-ram-force') as HTMLElement).click();
  await tick();
  assert.equal(callCount, 2, 'force 二次调用');
  assert.equal(confirm.classList.contains('hidden'), true);
  // 实时进度：如实呈现 k/N（k=已 running 的目标环境数）而非静态一句话。
  assert.match(w.document.querySelector('#rail-msg')!.textContent!, /启动中 \d\/4|已错峰排队启动 4/);
});

test('同账号告警：选中环境带 sameAccountWarning → 主区域出告警条', async () => {
  const { w, pushStatus } = await boot();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', sameAccountWarning: { message: '该环境与另一环境登录了同一账号。' } }));
  await tick();
  const warn = w.document.querySelector('#same-account-warn')!;
  assert.equal(warn.classList.contains('hidden'), false);
  assert.match(w.document.querySelector('#same-account-text')!.textContent!, /同一账号/);
  // 告警解除即隐藏
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', sameAccountWarning: null }));
  await tick();
  assert.equal(warn.classList.contains('hidden'), true);
});

// ── 花名册多选（adspower-desktop-env-picker MODIFIED）──

test('花名册：点选多个环境累积加入、重复点选诚实提示已加入、可移出', async () => {
  const { w } = await boot({
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({
      ok: true,
      profiles: [
        { userId: 'p1', name: '环境一', serialNumber: '1', groupName: '', proxy: '', platform: 'xiaohongshu' },
        { userId: 'p2', name: '环境二', serialNumber: '2', groupName: '', proxy: '', platform: 'xiaohongshu' },
        { userId: 'p3', name: '环境三', serialNumber: '3', groupName: '', proxy: '', platform: 'xiaohongshu' },
      ],
    }),
  }, { environments: [{ profileId: 'p1', name: '环境一', platform: 'xiaohongshu' }] });
  await tick();
  await tick();
  const items = w.document.querySelectorAll('.ads-env-item');
  assert.equal(items.length, 3);
  // p1 已是成员：带「已加入」标记
  assert.match(items[0].textContent!, /已加入/);
  // 点选 p3 → 加入花名册
  (items[2] as HTMLElement).click();
  await tick();
  const itemsAfter = w.document.querySelectorAll('.ads-env-item');
  assert.match(itemsAfter[2].textContent!, /已加入/, '点选即加入花名册');
  // 重复点选 p3 → 诚实提示已在花名册、不重复加入
  (w.document.querySelectorAll('.ads-env-item')[2] as HTMLElement).click();
  await tick();
  assert.match(w.document.querySelector('#ads-env-msg')!.textContent!, /已在运行花名册/);
  // 移出 p3
  const removeBtn = w.document.querySelectorAll('.ads-env-item')[2].querySelector('.ads-env-remove') as HTMLElement;
  removeBtn.click();
  await tick();
  assert.doesNotMatch(w.document.querySelectorAll('.ads-env-item')[2].textContent!, /已加入/, '移出后成员标记消失');
});

test('根治 #1：加入环境即时落盘（saveSettings 带 environments），main 据此建行 → 左栏立即出现', async () => {
  const saves: Array<Record<string, unknown>> = [];
  const { w } = await boot({
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'pX', name: '新环境', serialNumber: '9', groupName: '', proxy: '', platform: 'xiaohongshu' }] }),
    saveSettings: async (patch: Record<string, unknown>) => { saves.push(patch); return { ...patch, saveOk: true, environments: patch.environments }; },
  }, { environments: [], adsProfileId: '', adsProfileName: '' });
  await tick();
  await tick();
  (w.document.querySelectorAll('.ads-env-item')[0] as HTMLElement).click(); // 加入
  await tick();
  await tick();
  // 关键：加入即落盘 environments（旧 bug：只改本地花名册没落盘 → 左栏永不出现）。
  const envSave = saves.find((p) => Array.isArray(p.environments) && (p.environments as Array<{ profileId: string }>).some((e) => e.profileId === 'pX'));
  assert.ok(envSave, '加入环境必须立即 saveSettings 带 environments（含 pX）');
});

test('环境栏「＋」打开添加面板；设置抽屉已精简（环境列表 / 人设向导不在抽屉里）', async () => {
  const { w } = await boot();
  // 左栏「＋ 添加环境」拉起独立浮层
  assert.equal(w.document.querySelector('#env-add-panel')!.classList.contains('open'), false);
  (w.document.querySelector('#rail-add') as HTMLElement).click();
  const panel = w.document.querySelector('#env-add-panel')!;
  assert.equal(panel.classList.contains('open'), true, '「＋」打开添加环境面板');
  assert.equal(panel.classList.contains('hidden'), false, '打开必须移除 hidden（.hidden 是 !important，否则只见遮罩不见内容）');
  // 环境列表与人设向导都在左栏浮层里，不在设置抽屉 #drawer 里
  const drawer = w.document.querySelector('#drawer')!;
  assert.equal(drawer.contains(w.document.querySelector('#ads-env-list')), false, '环境列表不在设置抽屉');
  assert.equal(drawer.contains(w.document.querySelector('#persona-wizard-body')), false, '人设向导不在设置抽屉');
  // 人设向导在人设浮层里
  assert.equal(w.document.querySelector('#persona-pop')!.contains(w.document.querySelector('#persona-wizard-body')), true);
});

test('人设图标：点击左栏行内人设图标 → 选中该环境并打开人设浮层', async () => {
  const { w, calls } = await boot();
  const rows = w.document.querySelectorAll('.rail-row');
  assert.ok(rows.length >= 2);
  const rowB = [...rows].find((r) => (r as HTMLElement).dataset.envId === 'ads-p2') as HTMLElement;
  const pIcon = rowB.querySelector('.rail-persona') as HTMLElement;
  assert.ok(pIcon, '每行昵称后应有人设图标');
  pIcon.click();
  await tick();
  const pop = w.document.querySelector('#persona-pop')!;
  assert.equal(pop.classList.contains('open'), true, '点人设图标打开人设浮层');
  assert.equal(pop.classList.contains('hidden'), false, '打开必须移除 hidden（否则只见遮罩不见内容）');
  assert.deepEqual(calls.select, ['ads-p2'], '打开人设即把该环境设为选中（浮层作用于它）');
});

// ── change edge-client-proxy-platform-persona-ux：平台化 UI + 人设浮层重设计 ──

test('平台标识：FB 环境行染平台类、顶栏徽标随选中环境切换、改平台后 rail 重建（签名含 platform）', async () => {
  const { w, pushStatus, pushFleet } = await boot();
  const snap = (p1Plat: string) => ({
    provider: 'adspower',
    selectedEnvId: 'ads-p1',
    railCollapsed: true,
    environments: [
      { envId: 'ads-p1', kind: 'adspower', profileId: 'p1', name: '环境一', platform: p1Plat, status: makeStatus({ envId: 'ads-p1', envName: '环境一' }) },
      { envId: 'ads-p2', kind: 'adspower', profileId: 'p2', name: '环境二', platform: 'xiaohongshu', status: makeStatus({ envId: 'ads-p2', envName: '环境二', edge: 'stopped', session: 'idle' }) },
    ],
  });
  pushFleet(snap('facebook'));
  await tick();
  const rowOf = (id: string) => [...w.document.querySelectorAll('.rail-row')].find((r) => (r as HTMLElement).dataset.envId === id) as HTMLElement;
  assert.ok(rowOf('ads-p1').className.includes('plat-facebook'), 'FB 环境行带 plat-facebook 类');
  assert.ok(rowOf('ads-p2').className.includes('plat-xiaohongshu'), '小红书环境行带 plat-xiaohongshu 类');
  assert.ok(rendererCss.includes('.rail-row.selected { background: var(--accent-soft); border-left-color: var(--accent); }'), '选中态统一使用交互蓝，不复用平台红');
  assert.ok(rendererCss.includes('.env-rail.collapsed .rail-row.plat-xiaohongshu .rail-ava { background: linear-gradient(135deg, #ff5773, var(--coral)); color: #fff; }'), '收起态小红书头像保持平台红实色');
  assert.ok(rendererCss.includes('.env-rail.collapsed .rail-row.plat-facebook .rail-ava { background: linear-gradient(135deg, #4a99ff, var(--plat-fb)); color: #fff; }'), '收起态 Facebook 头像保持平台蓝实色');
  assert.ok(rendererCss.includes('.env-rail.collapsed .rail-ava::after {'), '收起态用头像右下角状态点表达运行状态');
  assert.ok(rendererCss.includes('.env-rail.collapsed .rail-row.selected::before,'), '收起态选中环境使用单层蓝色侧边标记');
  assert.doesNotMatch(rendererCss, /rail-ringblink|--ring/, '收起态不再用多层状态色环包围头像');
  // 顶栏身份区随选中环境（ads-p1 = FB）切换文案与配色，健康浮层登录行同步
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一' }));
  await tick();
  assert.equal(w.document.querySelector('#acct-plat')!.textContent, 'Facebook');
  assert.equal(w.document.querySelector('#acct-plat')!.classList.contains('plat-facebook'), true);
  assert.equal(w.document.querySelector('#auth-label')!.textContent, 'Facebook 登录');
  (rowOf('ads-p1').querySelector('.rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-plat')!.textContent, 'Facebook', 'FB 环境的人设浮层必须显示 Facebook');
  assert.equal(w.document.querySelector('#persona-plat')!.classList.contains('plat-facebook'), true, 'FB 人设平台签保留平台蓝类');
  assert.equal(w.document.querySelector('#persona-pop')!.classList.contains('plat-facebook'), true, 'FB 人设头像保留平台蓝类');
  (w.document.querySelector('#persona-close') as HTMLElement).click();
  // 平台变化必须触发 rail 重建（platform 在变更签名里；漏掉则 UI 停留旧平台）
  pushFleet(snap('xiaohongshu'));
  await tick();
  assert.ok(rowOf('ads-p1').className.includes('plat-xiaohongshu'), '改平台后 rail 行重建为新平台类');
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一' }));
  await tick();
  assert.equal(w.document.querySelector('#acct-plat')!.textContent, '小红书');
  assert.equal(w.document.querySelector('#acct-plat')!.classList.contains('plat-facebook'), false);
  (rowOf('ads-p1').querySelector('.rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-plat')!.textContent, '小红书', '小红书环境的人设浮层不得残留 Facebook 文案');
  assert.equal(w.document.querySelector('#persona-plat')!.classList.contains('plat-facebook'), false, '小红书平台签不得残留 FB 类');
  assert.equal(w.document.querySelector('#persona-pop')!.classList.contains('plat-facebook'), false, '小红书人设头像不得残留 FB 类');
});

test('人设浮层：未就绪环境出空态面板（向导收起）；生成后进预览页、「改关键词」回第一步草稿保留', async () => {
  const calls: Record<string, unknown[]> = { persist: [] };
  const { w, pushStatus } = await boot({
    personaGenerate: async () => ({ ok: true, soulYaml: 'soul: X', identitySummary: 'X 人设' }),
    personaPersist: async (envId: string) => { calls.persist.push(envId); return { ok: true, firstPostOnboarding: true }; },
  });
  const rowOf = (id: string) => [...w.document.querySelectorAll('.rail-row')].find((r) => (r as HTMLElement).dataset.envId === id) as HTMLElement;
  // 环境二未启动未登录：打开其人设浮层 → 空态面板 + 「待启动」徽标 + 向导收起
  pushStatus(makeStatus({ envId: 'ads-p2', envName: '环境二', auth: 'checking', cloud: 'disconnected', edge: 'stopped', session: 'idle' }));
  await tick();
  (rowOf('ads-p2').querySelector('.rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-empty')!.classList.contains('hidden'), false, '未就绪显示空态面板');
  assert.equal(w.document.querySelector('#persona-wizard-body')!.classList.contains('hidden'), true, '未就绪收起向导');
  assert.equal(w.document.querySelector('#persona-state-badge')!.textContent, '待启动');
  assert.equal((w.document.querySelector('#persona-empty-action') as HTMLElement).textContent, '去启动');
  // 切回已登录+连云、且云端权威说未绑的环境一 → 向导可用
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: false }));
  await tick();
  (rowOf('ads-p1').querySelector('.rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-wizard-body')!.classList.contains('hidden'), false);
  assert.equal(w.document.querySelector('#persona-empty')!.classList.contains('hidden'), true);
  // 选关键词生成 → 切到预览页、identitySummary 升为标题
  (w.document.querySelector('.persona-kw-group[data-dim="content"][data-category="招聘求职"] .kw-btn') as HTMLElement).click();
  (w.document.querySelector('#persona-generate') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-stage-preview')!.classList.contains('hidden'), false, '生成后进入预览页');
  assert.equal(w.document.querySelector('#persona-draft')!.classList.contains('hidden'), false);
  assert.equal(w.document.querySelector('#persona-draft-summary')!.textContent, 'X 人设');
  // 「改关键词」回第一步：草稿保留，确认仍能打回生成时环境
  (w.document.querySelector('#persona-kw-summary') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-stage-pick')!.classList.contains('hidden'), false, '回到选关键词');
  (w.document.querySelector('#persona-confirm') as HTMLElement).click();
  await tick();
  assert.deepEqual(calls.persist, ['ads-p1'], '草稿未因回退丢失，确认仍打回生成时环境');
  assert.equal(w.document.querySelector('#persona-growth')!.classList.contains('hidden'), false, '确认成功后展示一次成长引导');
  assert.match(w.document.querySelector('#persona-growth')!.textContent || '', /容易被看见的内容灵感/);
  assert.equal(w.document.querySelector('#persona-bound-note')!.classList.contains('hidden'), true, '成长引导期间不同时显示已设置卡片');
  assert.match(w.document.querySelector('#persona-growth')!.textContent || '', /看趋势[\s\S]*找匹配[\s\S]*开始创作/);
  assert.match(w.document.querySelector('#persona-growth')!.textContent || '', /通常筛出\s*1 条/);
  assert.equal(w.document.querySelector('#persona-growth-start')!.classList.contains('hidden'), false, '底部 CTA 切到开始找灵感');
  assert.equal(w.document.querySelector('#persona-growth-start')!.textContent, '开始找灵感');
  assert.match(w.document.querySelector('#runtime-guidance-progress')!.textContent || '', /0\/20/, '弹窗背后的获得感卡立即显示首轮 0/20');
});

test('人设成长引导：点击开始找灵感复用现有启动按钮并关闭浮层', async () => {
  const { w, calls, pushStatus } = await boot({
    getStatus: async () => makeStatus({ envId: 'ads-p1', envName: '环境一', edge: 'stopped', session: 'idle', auth: 'logged in', cloud: 'connected', personaBound: false }),
    personaGenerate: async () => ({ ok: true, soulYaml: 'soul: Start', identitySummary: 'Start 人设' }),
    personaPersist: async () => ({ ok: true, firstPostOnboarding: true }),
  });
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', edge: 'stopped', session: 'idle', auth: 'logged in', cloud: 'connected', personaBound: false }));
  await tick();

  (w.document.querySelector('.persona-kw-group[data-dim="content"][data-category="招聘求职"] .kw-btn') as HTMLElement).click();
  (w.document.querySelector('#persona-generate') as HTMLElement).click();
  await tick();
  (w.document.querySelector('#persona-confirm') as HTMLElement).click();
  await tick();

  const start = w.document.querySelector('#persona-growth-start') as HTMLElement;
  assert.equal(start.classList.contains('hidden'), false);
  start.click();
  await tick();

  assert.deepEqual(calls.start, ['ads-p1'], '开始找灵感走现有 session-fab 启动链路');
  assert.equal(w.document.querySelector('#persona-pop')!.classList.contains('open'), false, '点击后关闭人设浮层');
  assert.equal(w.document.querySelector('#persona-growth')!.classList.contains('hidden'), true, '成长引导只出现一次');
});

test('人设成长引导：personaBound 状态先于 persist 回执到达时弹窗仍保持并展示首作卡', async () => {
  let pushBoundStatus: () => void = () => undefined;
  const { w, pushStatus } = await boot({
    getStatus: async () => makeStatus({ envId: 'ads-p1', envName: '环境一', auth: 'logged in', cloud: 'connected', personaBound: false }),
    personaGenerate: async () => ({ ok: true, soulYaml: 'soul: Race', identitySummary: 'Race 人设' }),
    personaPersist: async () => {
      pushBoundStatus(); // 复现真实 main IPC：先 updateStatus(personaBound=true)，再把 persist 结果回 renderer。
      await tick();
      return { ok: true, firstPostOnboarding: true };
    },
  });
  pushBoundStatus = () => pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: true }));
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: false }));
  await tick();

  (w.document.querySelector('.persona-kw-group[data-dim="content"][data-category="招聘求职"] .kw-btn') as HTMLElement).click();
  (w.document.querySelector('#persona-generate') as HTMLElement).click();
  await tick();
  (w.document.querySelector('#persona-confirm') as HTMLElement).click();
  await tick();
  await tick();

  assert.equal(w.document.querySelector('#persona-pop')!.classList.contains('open'), true, '先到的绑定态不得关闭正在收敛的首次引导');
  assert.equal(w.document.querySelector('#persona-growth')!.classList.contains('hidden'), false, 'persist 回执到达后必须展示首作卡');

  pushBoundStatus(); // 后续心跳仍会携带 personaBound=true，也不得把正在阅读的首作卡收走。
  await tick();
  assert.equal(w.document.querySelector('#persona-pop')!.classList.contains('open'), true, '首作卡活跃期间后续绑定态不得关闭弹窗');
});

test('人设成长引导：沿用旧庆祝吉祥物，撒花与缩放均为一次性且支持 reduced motion', () => {
  assert.match(html, /mascot-celebration-512\.png/);
  assert.match(rendererCss, /\.persona-growth\.play \.pg-mascot\s*\{\s*animation:\s*pg-mascot-scale 800ms[^;]*both;/);
  assert.match(rendererCss, /@keyframes pg-mascot-scale\s*\{[\s\S]*scale\(1\.09\)[\s\S]*\}/);
  assert.doesNotMatch(rendererCss, /\.persona-growth\.play \.pg-mascot[^}]*infinite/);
  assert.match(rendererCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.persona-growth\.play \.pg-mascot\s*\{[\s\S]*animation:\s*none;/);
  assert.match(rendererCss, /\.pg-step-icon\s*\{[^}]*color:\s*#2d8fa4;[^}]*\}/);
  assert.doesNotMatch(rendererCss, /\.pg-step-icon\s*\{[^}]*background:/);
});

test('人设成长引导：云端未创建首次引导时不重复展示', async () => {
  const { w, pushStatus } = await boot({
    personaGenerate: async () => ({ ok: true, soulYaml: 'soul: Existing', identitySummary: 'Existing 人设' }),
    personaPersist: async () => ({ ok: true, firstPostOnboarding: false }),
  });
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: false }));
  await tick();
  (w.document.querySelector('.persona-kw-group[data-dim="content"][data-category="招聘求职"] .kw-btn') as HTMLElement).click();
  (w.document.querySelector('#persona-generate') as HTMLElement).click();
  await tick();
  (w.document.querySelector('#persona-confirm') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-growth')!.classList.contains('hidden'), true);
  assert.equal(w.document.querySelector('#persona-bound-note')!.classList.contains('hidden'), false);
});

test('暂停态显式关闭只路由当前选中环境并切到已关闭', async () => {
  const { w, pushStatus, calls } = await boot();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', edge: 'stopped', cloud: 'disconnected', session: 'paused' }));
  await tick();
  const close = w.document.querySelector('#session-close') as HTMLElement;
  assert.equal(close.classList.contains('hidden'), false);
  close.click();
  await tick();
  await tick();
  assert.deepEqual(calls.close, ['ads-p1']);
  assert.equal(w.document.querySelector('#session-fab')!.textContent, '启动');
  assert.equal(close.classList.contains('hidden'), true);
});

// ── 人设弹窗三态（change persona-bound-tristate）────────────────────────────────────────────
// 红线：弹窗只能由云端权威的「未绑」触发。「信号还没到」必须是一个独立的「未知」态，绝不当成未绑——
// 旧实现把两者压成同一个 false，靠 6 秒宽限去猜，已设置人设的账号被反复误弹（真机：工程师大白）。

test('人设浮层：权威信号未到（未知态）时**永不**自动弹，也不发通知', async () => {
  const { w, calls } = await boot(); // 已登录 + 已连云，但 personaBound 缺省 = 云端还没说
  await tick();
  await new Promise((r) => setTimeout(r, 300)); // 等再久也不该弹：未知不是未绑，没有任何计时器会把它翻成未绑
  assert.equal(w.document.querySelector('#persona-pop')!.classList.contains('open'), false, '未知态不得自动弹出人设浮层');
  assert.equal(calls.notify.length, 0, '未知态不得发系统通知');
  assert.equal(w.document.querySelector('#persona-state-badge')!.textContent, '待启动', '未知态徽标须为「待启动」，绝不谎称「未设置」');
});

test('人设浮层：已绑账号在核心重启后（绑定态回落未知）绝不被误弹', async () => {
  // 真机复发链：冷待机唤醒 → 核心重启 → 外壳把 personaBound 归零 → 渲染层若把「未知」当「未绑」就误弹。
  const { w, calls, pushStatus } = await boot();
  await tick();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: true })); // 首次会话：云端说已绑
  await tick();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: null })); // 核心重启：回落未知
  await tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(w.document.querySelector('#persona-pop')!.classList.contains('open'), false, '重启后的未知态绝不得弹窗');
  assert.equal(calls.notify.length, 0, '重启后的未知态绝不得发通知');
});

test('人设浮层：系统误弹的窗在权威「已绑」到达时自动收起（用户手动打开的不动）', async () => {
  const { w, pushStatus } = await boot();
  await tick();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: false })); // 云端权威说未绑 → 自动弹
  await tick();
  const pop = w.document.querySelector('#persona-pop')!;
  assert.equal(pop.classList.contains('open'), true, '权威未绑应自动弹出');

  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: true })); // 权威改口：其实已绑
  await tick();
  assert.equal(pop.classList.contains('open'), false, '自动弹出的窗应在权威「已绑」到达时自动收起');
});

test('人设浮层：云端权威说未绑 → 自动弹出并通知；偏好面板为语气调性 + 内容偏好，招聘求职置顶且支持自定义', async () => {
  const generateCalls: Array<{ envId: string; payload: { keywordSelections: string[] } }> = [];
  const { w, calls, pushStatus } = await boot({
    personaGenerate: async (envId: string, payload: { keywordSelections: string[] }) => {
      generateCalls.push({ envId, payload });
      return { ok: true, soulYaml: 'soul: custom', identitySummary: '自定义人设' };
    },
  });
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: false }));
  await tick();

  const pop = w.document.querySelector('#persona-pop')!;
  assert.equal(pop.classList.contains('open'), true, '云端权威说未绑 → 应自动弹出人设浮层');
  assert.equal(calls.notify.length, 1, '权威未绑账号应发一次系统通知');
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: false }));
  await tick();
  assert.equal(calls.notify.length, 1, '重复状态更新不得刷通知');

  const cards = [...w.document.querySelectorAll('#persona-stage-pick .persona-card')];
  assert.match(cards[0].textContent || '', /语气调性/, '语气调性必须是第一个面板');
  assert.match(cards[1].textContent || '', /内容偏好/, '内容偏好必须是第二个面板');
  assert.match(rendererCss, /\.persona-pop \{[\s\S]*--persona-accent: #1496a5;/, '人设浮层必须使用吉祥物青绿局部令牌');
  assert.match(rendererCss, /\.persona-kw-group \.kw-btn \{[\s\S]*font-weight: 500;/, '选择项字重应低于区块标题');
  assert.doesNotMatch(rendererCss, /\.persona-pref-group \.kw-btn:not\(\.active\)::before\s*\{[^}]*content:\s*["']\+["']/, '内容项加号不得依赖字体字形');
  const firstGroup = w.document.querySelector('.persona-pref-group')!;
  assert.match(firstGroup.textContent || '', /招聘求职/);
  for (const item of ['骑手外卖', '蓝领零工', '数据标注', '自有兼职', '在校实习']) {
    assert.match(firstGroup.textContent || '', new RegExp(item));
  }

  const addCustom = firstGroup.querySelector('.persona-add-custom') as HTMLElement;
  assert.equal(addCustom.textContent, '', '自定义入口的可见加号交由 CSS 几何绘制');
  assert.match(addCustom.getAttribute('aria-label') || '', /自定义招聘求职偏好/, '几何加号仍须保留可访问名称');
  addCustom.click();
  const customInput = firstGroup.querySelector('.persona-custom-input') as HTMLInputElement;
  customInput.value = '直播招聘';
  (firstGroup.querySelector('.persona-custom-add') as HTMLElement).click();
  assert.match(firstGroup.textContent || '', /直播招聘/, '自定义偏好应出现在当前分组');

  (w.document.querySelector('.persona-kw-group[data-dim="tone"] .kw-btn') as HTMLElement).click();
  (w.document.querySelector('#persona-generate') as HTMLElement).click();
  await tick();
  assert.equal(generateCalls.length, 1);
  assert.deepEqual(generateCalls[0].payload.keywordSelections.includes('招聘求职'), true, '选择内容偏好时应带上行业标题');
  assert.deepEqual(generateCalls[0].payload.keywordSelections.includes('直播招聘'), true, '自定义兴趣应进入生成关键词');
});

// ═══ 环境栏定高 + 栏内滚动（edge-rail-fixed-height-scroll）═══
// index.html 外链 styles.css，jsdom 不会去取；把真实样式表注入成 <style> 后 jsdom 会解析级联，
// 于是断言的是「这条规则真的命中了这个元素」，而不只是「文件里有这段文本」。
function cssWindow(): DOMWindow {
  const dom = new JSDOM(html);
  const { window } = dom;
  openWindows.push(window);
  const style = window.document.createElement('style');
  style.textContent = rendererCss;
  window.document.head.appendChild(style);
  return window;
}

// jsdom 没有布局：scrollTop 只是元素上存的一个数，永远不会被夹回 0。真浏览器在列表被清空
// （innerHTML=''）时会把滚动位夹回 0 —— 只补这一条行为，否则「重建后仍是 120」在完全没写保位
// 代码时也会假绿（判别性已实测：无实现 after=0 / 有实现 after=120）。
function stubScrollable(win: DOMWindow, el: Element) {
  let top = 0;
  const writes: number[] = [];
  const innerHTMLDesc = Object.getOwnPropertyDescriptor(win.Element.prototype, 'innerHTML')!;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Number(v) || 0; writes.push(top); },
  });
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return innerHTMLDesc.get!.call(this); },
    set(v: string) { innerHTMLDesc.set!.call(this, v); top = 0; },
  });
  return { writes };
}

test('环境栏定高：有高度上限，环境多了只在列表区滚（不再撑长整页、把栏尾顶出视野）', () => {
  const w = cssWindow();
  const d = w.document;
  const rail = d.querySelector('#env-rail') as HTMLElement;
  const railCs = w.getComputedStyle(rail);
  assert.ok(
    (railCs.height && railCs.height !== 'auto') || (railCs.maxHeight && railCs.maxHeight !== 'none'),
    '环境栏必须有高度上限；只剩 min-height 时内容会把整页撑长，列表的 overflow 永不触发',
  );
  assert.equal(railCs.position, 'sticky', '主列滚动时环境栏须钉住不动');
  assert.equal(railCs.flexDirection, 'column', '栏内竖排：头 / 汇总 / 列表 / 栏尾');
  const listCs = w.getComputedStyle(d.querySelector('#rail-list') as HTMLElement);
  assert.equal(listCs.overflowY, 'auto', '溢出必须由列表区自己滚');
  assert.equal(listCs.overscrollBehavior, 'contain', '滚到底不得把整页一起带滚');
  assert.equal(listCs.flexGrow, '1', '列表区吃掉剩余高度');
  // min-height:0 是红线：列表宁可被压到 0，也绝不能把栏尾挤到 sticky 栏的底边以下——
  // 那片区域滚多少页都够不着（「全部启动」「引导处理」永久失联）。
  assert.ok(['0', '0px'].includes(listCs.minHeight), '列表须 min-height:0，否则不收缩、滚不起来，且会把栏尾顶出视口');
});

test('环境栏结构：只有环境列表是滚动容器，栏头与栏尾不落进去（永远够得着）', async () => {
  const { w } = await boot();
  const d = w.document;
  const rail = d.querySelector('#env-rail') as HTMLElement;
  const list = d.querySelector('#rail-list') as HTMLElement;
  assert.equal(list.parentElement, rail, '列表须是环境栏的直接子节点，否则 flex 高度链断、滚不起来');
  for (const id of ['#rail-add', '#rail-toggle', '#rail-guide', '#rail-start-all', '#rail-msg', '#rail-foot-add']) {
    const el = d.querySelector(id) as HTMLElement;
    assert.ok(rail.contains(el), `${id} 仍在环境栏内`);
    assert.equal(list.contains(el), false, `${id} MUST NOT 落进滚动容器，否则环境一多就被滚出视野`);
  }
});

test('环境栏滚动保位：状态变化触发重建时，用户滚到的位置不被甩回顶部', async () => {
  const { w, pushStatus } = await boot();
  const list = w.document.querySelector('#rail-list') as HTMLElement;
  const scroll = stubScrollable(w, list);
  list.scrollTop = 120;
  assert.equal(w.document.querySelectorAll('.rail-row').length, 2);
  pushStatus(makeStatus({ envId: 'ads-p2', envName: '环境二' })); // 环境二 离线→运行：签名变、列表重建
  await tick();
  assert.equal(w.document.querySelectorAll('.rail-row').length, 2, '确已重建');
  assert.equal(list.scrollTop, 120, '重建后必须把滚动位放回原处');
  assert.ok(scroll.writes.includes(120), '须是显式写回，而非碰巧没动过');
});

test('环境栏不打扰用户：模型没变的每秒重估不重建、不动滚动位', async () => {
  const { w, pushStatus } = await boot();
  const list = w.document.querySelector('#rail-list') as HTMLElement;
  const scroll = stubScrollable(w, list);
  list.scrollTop = 90;
  const before = w.document.querySelector('.rail-row') as HTMLElement;
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一' })); // 与初始快照同级：签名不变
  await tick();
  assert.equal(w.document.querySelector('.rail-row'), before, '签名未变不得重建 DOM');
  assert.equal(list.scrollTop, 90, '不得在用户滚动途中改掉位置');
  assert.deepEqual(scroll.writes, [90], '除用户那一次外不应有多余写入');
});
