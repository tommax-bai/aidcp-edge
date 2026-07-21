import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';

// 陪伴式主界面冒烟（edge-companion-ui）：标题带健康合成 / 设置抽屉 / 在场感诚实态 /
// 活动流 / 发布卡与稿件预览动作 —— 用真实 index.html + ui-logic.js + renderer.js 在 jsdom 里驱动。
const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const environmentDisplayNameSrc = readFileSync(join(electronDir, 'renderer/environment-display-name.cjs'), 'utf8');
const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
const contentWorkspaceSrc = readFileSync(join(electronDir, 'renderer/content-workspace.js'), 'utf8');
const publishReviewLogicSrc = readFileSync(join(electronDir, 'renderer/publish-review-logic.js'), 'utf8');
const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');
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
  if (typeof window.HTMLDialogElement.prototype.showModal !== 'function') {
    window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function close(returnValue = '') {
      this.returnValue = returnValue;
      this.removeAttribute('open');
      this.dispatchEvent(new window.Event('close'));
    };
  }
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
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' }] }),
    adsOpenCreate: () => ({ launched: true }),
    ...apiOver,
  };
  window.eval(environmentDisplayNameSrc);
  window.eval(uiLogicSrc);
  window.eval(contentWorkspaceSrc);
  window.eval(publishReviewLogicSrc);
  window.eval(rendererSrc);
  for (let i = 0; i < 5; i++) await tick();
  return { w: window, pushStatus, pushActivity };
}

const $ = (w: DOMWindow, sel: string) => w.document.querySelector(sel) as unknown as HTMLElement;
const hidden = (el: HTMLElement) => el.classList.contains('hidden');

const TASK_ID = '11111111-1111-4111-8111-111111111111';
function delegatedDraftReceipt(action: string, version = 0) {
  return {
    ok: true,
    data: {
      task: { id: TASK_ID, version, action, status: 'awaiting_confirmation' },
      confirmation: {
        title: '请确认用户委托任务', accountName: '晚风手作', platformLabel: '小红书', capability: 'supported',
        actionLabel: action, target: '1', attempts: '1', schedule: '立即执行', approval: '公开写操作保留人审', priority: '普通',
      },
    },
  };
}

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
  assert.equal($(w, '#health-label').textContent, '需处理');
  assert.ok($(w, '#health-pill').classList.contains('attention'));
  pushStatus(makeStatus({ edge: 'warning' }));
  assert.equal($(w, '#health-label').textContent, '异常');
  assert.ok($(w, '#health-pill').classList.contains('error'));
});

test('异常退出详情在客户端内持久展示，且不把堆栈塞进主界面', async () => {
  const summary = '启动失败：AdsPower browser-profile/start 失败：code=-1 msg=[k1e0ero8] is being used by [tommax.bai@gmail.com] and is not allowed to open';
  const { w } = await boot({
    edge: 'warning',
    cloud: 'disconnected',
    session: 'idle',
    lastMessage: 'at async main (file:///dist/main.js:102:44)',
    edgeFailure: { summary, at: new Date().toISOString(), exitCode: 1 },
  });
  assert.equal(hidden($(w, '#edge-failure')), false, '异常详情应在主界面可见');
  assert.match($(w, '#edge-failure-text').textContent ?? '', /browser-profile\/start 失败/);
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

test('健康明细浮层只展示客户会话、自动化、浏览器与账号保护', async () => {
  const { w } = await boot();
  assert.equal(hidden($(w, '#health-pop')), true, '默认收起');
  $(w, '#health-pill').dispatchEvent(new w.Event('click'));
  assert.equal(hidden($(w, '#health-pop')), false);
  const text = $(w, '#health-pop').textContent || '';
  assert.ok(text.includes('客户会话'));
  assert.ok(text.includes('自动化'));
  assert.ok(text.includes('浏览器'));
  assert.ok(text.includes('账号保护'));
  assert.equal(text.includes('客户端核心'), false);
  assert.equal(text.includes('云端连接'), false);
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

test('待配置 → 首屏主动步骤，点「环境管理」直达左栏管理面板', async () => {
  const { w } = await boot({ auth: 'config required', edge: 'stopped', session: 'idle' });
  assert.equal(hidden($(w, '#login-guide')), false, '待配置应出主动步骤');
  assert.equal(hidden($(w, '#notice-action')), false);
  assert.equal($(w, '#notice-action').textContent?.trim(), '环境管理');
  $(w, '#notice-action').dispatchEvent(new w.Event('click'));
  assert.equal($(w, '#env-add-panel').classList.contains('open'), true);
});

// ── 在场感：动效只由真实事件驱动 ──
test('运行中 + 新鲜事件 → 在场感动效开、新鲜度走字', async () => {
  const { w } = await boot({
    dailyUsage: {
      totals: { view: 3, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
      quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
    },
  });
  assert.ok($(w, '#presence-text').classList.contains('shimmer'));
  assert.match($(w, '#presence-text').textContent ?? '', /正在认真读/);
  assert.match($(w, '#presence-fresh').textContent ?? '', /刚刚更新/);
  assert.equal(hidden($(w, '#runtime-guidance')), false);
  assert.equal($(w, '#runtime-guidance').dataset.mode, 'running');
  assert.equal($(w, '#runtime-guidance-kicker').textContent, '正在理解目标人群喜欢什么');
  assert.equal($(w, '#runtime-guidance-title').textContent, '正在缩小创作方向。');
  assert.match($(w, '#runtime-guidance-value').textContent ?? '', /刷首页不是漫无目的/);
  assert.equal(hidden($(w, '#runtime-guidance-flow')), true, '普通运行态隐藏重复的三段流程');
  assert.equal($(w, '#runtime-guidance-flow').textContent, '');
  const runningSteps = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-step')) as HTMLElement[];
  const runningConnectors = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-connector')) as HTMLElement[];
  assert.equal(runningSteps.length, 0);
  assert.equal(runningConnectors.length, 0);
  assert.equal(hidden($(w, '#runtime-guidance-progress')), false);
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /正在查看第 3 条推荐内容/);
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /3\/150/);
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /进展实时记录/);
  assert.equal($(w, '#runtime-guidance-progress .rg-progress-meta').classList.contains('has-outcome'), false);
  assert.equal($(w, '#runtime-guidance-progress .rg-progress-track').getAttribute('aria-valuenow'), '3');
  assert.equal(($(w, '#runtime-guidance-progress .rg-progress-fill') as HTMLElement).style.width, '2%');
  assert.equal(w.document.querySelector('#loop'), null, '运行态不保留七段详细步骤');
  assert.equal(w.document.querySelector('.rg-loop-toggle'), null, '运行态不提供查看运行步骤入口');
  assert.match($(w, '#runtime-guidance-mascot').getAttribute('src') ?? '', /mascot-task-execution/);
  assert.equal($(w, '#runtime-guidance-mascot').classList.contains('animate'), false);
  assert.match(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-main/);
  assert.match(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-mascot/);
  assert.doesNotMatch(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-mascot\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(rendererCss, /\.rg-mascot\.animate\s*\{[^}]*animation:/s);
  assert.doesNotMatch(rendererCss, /@keyframes rg-mascot-/);
  assert.match(rendererCss, /\.persona-growth\.play \.pg-mascot\s*\{\s*animation:\s*pg-mascot-scale/);
  assert.doesNotMatch(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-main::before/);
  assert.match(rendererCss, /\.rg-progress\s*\{/);
  assert.match(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-progress\s*\{[\s\S]*border-top: 1px solid rgba\(156, 178, 205, 0\.28\);/);
  assert.match(rendererCss, /\.rg-progress-meta\.has-outcome \{ color: #22805c; \}/);
  assert.match(rendererCss, /@media \(max-width: 620px\) \{[\s\S]*\.rg-progress-head \{ align-items: flex-start; flex-wrap: wrap; \}[\s\S]*\.rg-progress-meta \{ width: 100%; justify-content: flex-start; text-align: left; \}/);
  assert.match(rendererSrc, /browse: '<svg[\s\S]*<path d="M9 9 5 5l1\.8 11\.7/);
  assert.match(rendererSrc, /match: '<svg[\s\S]*<path d="M7 3H5/);
  assert.doesNotMatch(rendererSrc, /browse: '<svg[\s\S]*m4 4 7\.1 17/);
  assert.doesNotMatch(rendererSrc, /match: '<svg[\s\S]*m8\.5 12\.2 2\.2 2\.2 4\.8-5\.1/);
  assert.doesNotMatch(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-flow-step/);
  assert.match(rendererSrc, /connector\.className = 'rg-flow-connector';/);
  assert.match(rendererCss, /\.rg-flow-connector\.flow-active::before/);
  assert.match(rendererCss, /\.rg-flow-connector\.flow-active::after/);
  assert.match(rendererCss, /@keyframes rg-flow-spark/);
  assert.match(rendererCss, /--rg-step-line-active-start: rgba\(72, 118, 238, 0\.92\);/);
  assert.match(rendererCss, /--rg-step-line-active-end: rgba\(111, 154, 246, 0\.9\);/);
  assert.match(rendererCss, /\.rg-flow\s*\{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*gap: 8px;/);
  assert.match(rendererCss, /\.rg-flow-step:nth-child\(1\) \{ grid-column: 1; grid-row: 1; \}/);
  assert.match(rendererCss, /\.rg-flow-step:nth-child\(3\) \{ grid-column: 2; grid-row: 1; \}/);
  assert.match(rendererCss, /\.rg-flow-step:nth-child\(5\) \{ grid-column: 3; grid-row: 1; \}/);
  assert.match(rendererCss, /\.rg-flow-connector\s*\{[\s\S]*justify-self: end;[\s\S]*width: 28px;[\s\S]*transform: translateX\(4px\);/);
  assert.match(rendererCss, /\.rg-flow-connector:nth-child\(2\) \{ grid-column: 1; grid-row: 1; \}/);
  assert.match(rendererCss, /\.rg-flow-connector:nth-child\(4\) \{ grid-column: 2; grid-row: 1; \}/);
  assert.match(rendererCss, /--rg-step-spark-size: 5px;/);
  assert.match(rendererCss, /\.rg-flow-connector\.flow-active::after\s*\{[\s\S]*top: 6\.5px;[\s\S]*left: 0;/);
  assert.match(rendererCss, /4% \{ left: 0; transform: translateX\(-50%\) scale\(\.82\); opacity: \.9; \}/);
  assert.match(rendererCss, /88% \{ left: 100%; transform: translateX\(-50%\) scale\(\.88\); opacity: \.9; \}/);
  assert.match(rendererCss, /96% \{ left: 100%; transform: translateX\(-50%\) scale\(\.88\); opacity: 0; \}/);
  assert.match(rendererCss, /100% \{ left: 0; transform: translateX\(-50%\) scale\(\.82\); opacity: 0; \}/);
  assert.match(rendererCss, /\.rg-flow \{ gap: 5px; \}/);
  assert.match(rendererCss, /\.rg-flow-connector \{ width: 20px; transform: translateX\(3px\); \}/);
  assert.doesNotMatch(rendererCss, /minmax\((?:36|20)px, \.(?:32|24)fr\)/);
  assert.doesNotMatch(rendererCss, /--rg-step-(?:line-width|line-right|spark-right|spark-travel):/);
  assert.doesNotMatch(rendererSrc, /查看运行步骤|收起运行步骤|loopDetailsOpen|renderLoop/);
  assert.doesNotMatch(rendererCss, /rg-loop-toggle|\.loop-step|\.loop-sep/);
});

test('返回推荐流时顶部流光显示创作方向，真实更新时间保持不变', async () => {
  const { w } = await boot({
    presence: { text: '返回推荐流，继续逛…', at: new Date().toISOString() },
  });
  assert.equal($(w, '#presence-text').textContent, '正在缩小创作方向。');
  assert.equal($(w, '#presence-text').classList.contains('shimmer'), true);
  assert.match($(w, '#presence-fresh').textContent ?? '', /刚刚更新/);
});

test('首帖流程周期刷新原位更新内容，不重建连接器打断圆点行程', async () => {
  const now = Date.now();
  const { w, pushStatus } = await boot({
    dailyUsage: {
      totals: { view: 3 },
      firstPost: { state: 'searching', viewed: 3, target: 20, startedAt: now },
    },
  });
  const flow = $(w, '#runtime-guidance-flow');
  const stepsBefore = Array.from(flow.querySelectorAll('.rg-flow-step'));
  const connectorsBefore = Array.from(flow.querySelectorAll('.rg-flow-connector'));

  pushStatus(makeStatus({
    dailyUsage: {
      totals: { view: 4 },
      firstPost: { state: 'searching', viewed: 4, target: 20, startedAt: now },
    },
  }));

  const stepsAfter = Array.from(flow.querySelectorAll('.rg-flow-step'));
  const connectorsAfter = Array.from(flow.querySelectorAll('.rg-flow-connector'));
  assert.equal(stepsAfter.length, 3);
  assert.equal(connectorsAfter.length, 2);
  assert.strictEqual(stepsAfter[0], stepsBefore[0], '阶段节点应原位更新');
  assert.strictEqual(connectorsAfter[0], connectorsBefore[0], '第一条连接器不得因状态刷新重建');
  assert.strictEqual(connectorsAfter[1], connectorsBefore[1], '第二条连接器不得因状态刷新重建');
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /正在观察第 4 条推荐内容/);
  assert.ok(connectorsAfter[0].classList.contains('flow-active'));
  assert.equal(connectorsAfter[1].classList.contains('flow-active'), false);
  assert.match(rendererSrc, /const canReuseFlowNodes = existingFlowNodes\.length === expectedFlowNodeCount/);
  assert.match(rendererSrc, /if \(!canReuseFlowNodes\) \{\s*fields\.runtimeGuidanceFlow\.replaceChildren\(\);/);
  assert.match(rendererSrc, /connector\.classList\.toggle\('flow-active', activeFlow \|\| activeDayFlow\);/);
});

test('第一篇作品引导：开始创作前连接线在搜索与生成态都使用橙色语义', async () => {
  const now = Date.now();
  const { w, pushStatus } = await boot({
    dailyUsage: {
      totals: { view: 0 },
      firstPost: { state: 'searching', viewed: 0, target: 20, startedAt: now },
    },
  });
  assert.equal($(w, '#runtime-guidance').dataset.mode, 'first-post');
  assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /开始创作/);
  const searchingConnectors = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-connector')) as HTMLElement[];
  assert.equal(searchingConnectors.length, 2);
  assert.equal(searchingConnectors[1].classList.contains('flow-active'), false, '搜索阶段第二条连接器虽未运动，也不得回退为灰色');
  assert.match(rendererCss, /\.runtime-guidance\[data-mode="first-post"\] \.rg-flow-connector:nth-child\(4\)\s*\{[\s\S]*--rg-step-line: rgba\(216, 139, 34, 0\.58\);[\s\S]*--rg-step-line-active-start: rgba\(216, 139, 34, 0\.92\);[\s\S]*--rg-step-line-active-end: rgba\(232, 164, 55, 0\.86\);[\s\S]*--rg-step-spark-ring: rgba\(216, 139, 34, 0\.22\);[\s\S]*--rg-step-spark-glow: rgba\(216, 139, 34, 0\.48\);/);

  pushStatus(makeStatus({
    dailyUsage: {
      totals: { view: 14 },
      firstPost: { state: 'generating', viewed: 14, target: 20, startedAt: now - 60_000, sourceId: 'note-1' },
    },
  }));
  assert.equal($(w, '#runtime-guidance').dataset.mode, 'first-post');
  const generatingConnectors = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-connector')) as HTMLElement[];
  assert.equal(generatingConnectors.length, 2);
  assert.ok(generatingConnectors[1].classList.contains('flow-active'), '生成阶段第二条连接器使用同一组橙色动态变量');
  assert.equal(generatingConnectors[1].dataset.toState, 'current');
  assert.match(rendererCss, /@media \(max-width: 430px\) \{[\s\S]*\.rg-flow-connector \{ width: 20px; transform: translateX\(3px\); \}/, '窄屏沿用同一连接器节点与颜色变量');
});

test('运行中 + 今日已有浏览累计 → 获得感进度使用账号今日累计，不被当前窗口 0 覆盖', async () => {
  const { w } = await boot({
    dailyUsage: {
      totals: { view: 95, like: 4, collect: 2, comment: 0, follow: 0, publish: 0 },
      quotas: { view: 120, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
      inspirationSummary: { count: 3 },
      windows: {
        session: {
          active: true,
          totals: { view: 0, collect: 0 },
          quotas: { view: 20 },
        },
      },
    },
  });
  assert.equal(hidden($(w, '#runtime-guidance')), false);
  assert.equal($(w, '#runtime-guidance').dataset.mode, 'running');
  assert.equal(hidden($(w, '#runtime-guidance-flow')), true);
  assert.equal($(w, '#runtime-guidance-flow').textContent, '');
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /正在查看第 95 条推荐内容/);
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /95\/120/);
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /已记录 3 条创作灵感/);
  assert.ok($(w, '#runtime-guidance-progress .rg-progress-meta').classList.contains('has-outcome'));
  assert.doesNotMatch($(w, '#runtime-guidance-progress').textContent ?? '', /0\/120/);
  assert.equal($(w, '#runtime-guidance-progress .rg-progress-track').getAttribute('aria-valuenow'), '95');
  assert.equal(($(w, '#runtime-guidance-progress .rg-progress-fill') as HTMLElement).style.width, '79%');
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

test('外部占用拒启后关闭：显示本机自动化已关，不冒充占用端浏览器已关', async () => {
  const at = new Date().toISOString();
  const { w } = await boot({
    edge: 'stopped',
    cloud: 'disconnected',
    session: 'closed',
    automationState: 'stopped',
    browserState: 'closed',
    closeScope: 'local_automation_only',
    presence: { text: '本机自动化已关闭；占用端浏览器未受影响', at },
  });
  assert.equal($(w, '#presence-text').textContent, '本机自动化已关闭；占用端浏览器未受影响');
  assert.doesNotMatch($(w, '#presence-text').textContent ?? '', /^已关闭浏览器$/);
});

test('运行中 + 事件过期 + 阶段计划完成 → 说明自然间隔的成果与继续时间', async () => {
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
    assert.equal(hidden($(w, '.presence')), false, '间隔说明出现时仍保留第一块在场感');
    assert.equal(w.document.querySelector('#loop'), null, '小时间隔不保留七段详细步骤');
    assert.equal(w.document.querySelector('.rg-loop-toggle'), null, '小时间隔不提供查看运行步骤入口');
    assert.equal(hidden($(w, '#runtime-guidance')), false);
    assert.equal($(w, '#runtime-guidance').dataset.mode, 'hour');
    assert.match($(w, '#runtime-guidance-title').textContent ?? '', /先让平台认识你一点/);
    assert.match($(w, '#runtime-guidance-value').textContent ?? '', /自然节奏/);
    assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /浏览与互动/);
    assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /38 条首页内容已观察/);
    const hourSteps = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-step')) as HTMLElement[];
    const hourConnectors = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-connector')) as HTMLElement[];
    assert.equal(hourSteps.length, 3);
    assert.equal(hourConnectors.length, 2);
    assert.ok(hourConnectors[0].classList.contains('flow-active'), '小时间隔：浏览成果 → 自然间隔需要动态推进');
    assert.ok(hourConnectors[1].classList.contains('flow-active'), '小时间隔：自然间隔 → 继续寻找灵感需要动态推进');
    assert.match(rendererCss, /\.runtime-guidance\[data-mode="session"\] \.rg-flow,[\s\S]*--rg-step-line-active-start: rgba\(63, 154, 163, 0\.92\);[\s\S]*--rg-step-line-active-end: rgba\(104, 183, 189, 0\.88\);/);
    assert.match(rendererSrc, /pause: '<svg[\s\S]*<path d="M2 6c\.6\.5/);
    assert.equal(hidden($(w, '#runtime-guidance-progress')), false);
    assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /本轮已查看 38 条推荐内容/);
    assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /38\/150/);
    assert.equal(hidden($(w, '#runtime-guidance-resume')), true);
    assert.equal(hidden($(w, '#runtime-guidance-note')), true);
    assert.match($(w, '#runtime-guidance-mascot').getAttribute('src') ?? '', /mascot-monitoring/);
  } finally {
    w.Date.now = originalNow;
  }
});

test('本轮等待缺少浏览配额字段时仍渲染自然间隔进度卡', async () => {
  const now = 1730000000000;
  const stale = new Date(now - 21_000).toISOString();
  const { w, pushStatus } = await boot();
  const originalNow = w.Date.now;
  w.Date.now = () => now;
  try {
    pushStatus(makeStatus({
      session: 'resting',
      presence: { text: '这一轮已经完成，稍作等待后会自动继续', at: stale },
      dailyUsage: {
        asOf: now,
        totals: { view: 12, collect: 2 },
        windows: {
          session: {
            active: true,
            releaseAt: now + 8 * 60_000,
            totals: { view: 12, collect: 2 },
          },
        },
      },
    }));
    assert.equal(hidden($(w, '.presence')), false, '完整进度卡出现时仍保留第一块在场感');
    assert.equal($(w, '#presence-fresh').textContent, '约 8 分钟后自动继续');
    assert.equal(w.document.querySelector('#loop'), null, '场次间隔不保留七段详细步骤');
    assert.equal(w.document.querySelector('.rg-loop-toggle'), null, '场次间隔不提供查看运行步骤入口');
    assert.equal(hidden($(w, '#runtime-guidance')), false);
    assert.equal($(w, '#runtime-guidance').dataset.mode, 'session');
    assert.equal($(w, '#runtime-guidance-title').textContent, '先整理一下刚才发现的方向。');
    assert.match($(w, '#runtime-guidance-value').textContent ?? '', /自然节奏/);
    assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /2 条灵感已记录/);
    assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /让账号信号更清晰/);
    assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /推荐内容更聚焦/);
    const sessionSteps = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-step')) as HTMLElement[];
    const sessionConnectors = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-connector')) as HTMLElement[];
    assert.equal(sessionSteps.length, 3);
    assert.equal(sessionConnectors.length, 2);
    assert.ok(sessionConnectors[0].classList.contains('flow-active'), '场次间隔：浏览成果 → 自然间隔需要动态推进');
    assert.ok(sessionConnectors[1].classList.contains('flow-active'), '场次间隔：自然间隔 → 继续寻找灵感需要动态推进');
    assert.equal(hidden($(w, '#runtime-guidance-progress')), false);
    assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /本轮已查看 12 条推荐内容/);
    assert.doesNotMatch($(w, '#runtime-guidance-progress').textContent ?? '', /12\/20/);
    assert.equal(hidden($(w, '#runtime-guidance-resume')), true);
    assert.equal(hidden($(w, '#runtime-guidance-note')), true);
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
  assert.equal((rows[0] as HTMLElement).querySelector('.ev-subject')?.textContent, '「秋日漫步」');
});

test('单项评论节奏完成时不展示全局浏览间隔，今日进展仍保留', async () => {
  const now = 1730000000000;
  const stale = new Date(now - 6 * 60_000).toISOString();
  const { w, pushStatus } = await boot();
  const originalNow = w.Date.now;
  w.Date.now = () => now;
  try {
    pushStatus(makeStatus({
      session: 'resting',
      presence: { text: '旧事件', at: stale },
      dailyUsage: {
        asOf: now,
        totals: { view: 7, comment: 1 },
        quotas: { view: 150, comment: 8 },
        saturated: [],
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
    }));
    assert.equal(hidden($(w, '#runtime-guidance')), true);
    assert.equal(hidden($(w, '#daily-summary')), false);
    assert.equal($(w, '#comments').textContent, '1');
  } finally {
    w.Date.now = originalNow;
  }
});

// ── 发布卡：卡片入口 + 预览内动作 ──
test('发布卡候审：可见、第三节点琥珀，提示从稿件预览处理', async () => {
  const at = new Date(Date.now() - 3 * 60_000).toISOString();
  const { w } = await boot({ publish: { state: 'pending', title: '秋日城市漫步', at } });
  const card = $(w, '#pub-card');
  assert.equal(hidden(card), false);
  assert.equal(card.dataset.pubMode, 'flow');
  assert.equal(card.dataset.pubState, 'pending');
  assert.ok(
    Array.from(card.querySelectorAll('button')).every((button) => button.hidden && button.disabled),
    '旧发布卡没有可操作按钮，轮播箭头也必须保持隐藏',
  );
  assert.match($(w, '#pub-title').textContent ?? '', /秋日城市漫步/);
  assert.match($(w, '#pub-corner').textContent ?? '', /已等 3 分钟/);
  const steps = Array.from(card.querySelectorAll('.j-step'));
  assert.ok((steps[2] as HTMLElement).classList.contains('cur'));
  assert.match($(w, '#pub-foot').textContent ?? '', /稿件预览/);
  assert.ok(!($(w, '#pub-foot').textContent ?? '').includes('再次提醒'), '未收到再提醒事件绝不谎称');
});

test('HTTP overview 候审摘要：无内联 preview 仍显示审批入口并拉取 #161 完整稿件', async () => {
  const now = Date.parse('2026-07-20T17:25:54+08:00');
  const listCalls: unknown[][] = [];
  const detailCalls: unknown[][] = [];
  const listItem = {
    id: 161,
    platform: 'xiaohongshu',
    kind: 'generated',
    title: '商汤开源全能视觉模型MoT架构解析',
    contentPreview: '待审正文摘要',
    topics: ['视觉模型'],
    images: ['https://cdn.example.com/161.jpg'],
    contentVersion: 0,
    updatedAt: now,
    publishMode: 'immediate',
    publishTime: null,
  };
  const { w } = await boot({
    envId: 'u1',
    publish: null,
    publishPreview: null,
  }, {
    getEnvironmentOverview: async (envId: string) => ({
      ok: true,
      data: {
        data: {
          envKey: envId,
          dailyUsage: { asOf: now, totals: { view: 0, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 } },
          currentPublishState: {
            state: 'pending',
            code: '#161',
            title: '商汤开源全能视觉模型MoT架构解析',
            at: now,
          },
          lastPublished: null,
        },
        meta: { asOf: now },
      },
    }),
    publishDraftList: async (...args: unknown[]) => {
      listCalls.push(args);
      return { ok: true, data: { items: [listItem], total: 1, limit: 12, offset: 0 } };
    },
    publishDraftGet: async (...args: unknown[]) => {
      detailCalls.push(args);
      return { ok: true, data: { item: { ...listItem, content: '商汤开源模型的完整待审正文' } } };
    },
    publishScheduleOccupiedHours: async () => ({ ok: true, data: { occupiedTimes: [] } }),
  });

  const link = $(w, '#pub-preview-link');
  assert.equal($(w, '#pub-card').dataset.pubState, 'pending');
  assert.match($(w, '#pub-card').textContent ?? '', /商汤开源全能视觉模型MoT架构解析/);
  assert.equal(hidden(link), false, '待审摘要不能只显示等你确认却藏掉审批入口');
  assert.equal(link.textContent, '查看稿件 ↗');

  link.dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();

  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), true);
  assert.equal(listCalls[0][0], 'u1');
  assert.equal((listCalls[0][1] as { limit: number }).limit, 12);
  assert.equal((listCalls[0][1] as { offset: number }).offset, 0);
  assert.equal(detailCalls[0][0], 'u1');
  assert.equal(detailCalls[0][1], 161);
  assert.equal($(w, '#publish-preview-title').textContent, '商汤开源全能视觉模型MoT架构解析');
  assert.match($(w, '#publish-preview-content').textContent ?? '', /完整待审正文/);
  assert.equal(hidden($(w, '#publish-preview-actions')), false);
  assert.equal($(w, '#publish-preview-approve').textContent, '批准并发布');
  assert.equal($(w, '#publish-preview-cancel').textContent, '取消');
});

test('洗稿稿件审核：展示成品并通过既有审批 RPC 直接发布，不创建委托任务', async () => {
  const approvalCalls: unknown[][] = [];
  const delegatedCalls: unknown[] = [];
  const { w } = await boot({
    envId: 'u1',
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
  }, {
    publishApproval: async (...args: unknown[]) => {
      approvalCalls.push(args);
      return { ok: true, state: 'approved' };
    },
    delegatedTaskDraft: async (_envId: unknown, payload: unknown) => {
      delegatedCalls.push(payload);
      return delegatedDraftReceipt('approve_candidate');
    },
  });
  assert.equal(hidden($(w, '#pub-preview-link')), false);
  assert.equal($(w, '#pub-preview-link').textContent, '查看稿件 ↗');
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  assert.ok($(w, '#publish-preview-panel').classList.contains('open'));
  assert.equal($(w, '#publish-preview-kind').textContent, '洗稿稿件');
  assert.equal($(w, '#publish-preview-title').textContent, '洗稿标题');
  const previewContent = $(w, '#publish-preview-content');
  const gallery = previewContent.querySelector('.publish-preview-gallery-section') as HTMLElement;
  const noteTitle = $(w, '#publish-preview-title');
  const body = previewContent.querySelector('.publish-preview-body') as HTMLElement;
  assert.ok((gallery.compareDocumentPosition(noteTitle) & w.Node.DOCUMENT_POSITION_FOLLOWING) !== 0, '配图应位于标题之前');
  assert.ok((noteTitle.compareDocumentPosition(body) & w.Node.DOCUMENT_POSITION_FOLLOWING) !== 0, '标题应位于正文之前');
  assert.match($(w, '#publish-preview-content').textContent ?? '', /第一段正文/);
  assert.match($(w, '#publish-preview-content').textContent ?? '', /#生活方式/);
  assert.equal($(w, '#publish-preview-content img').getAttribute('src'), 'https://cdn.example.com/1.jpg');
  assert.doesNotMatch($(w, '#publish-preview-content').textContent ?? '', /原稿|作者|链接/);
  assert.equal(hidden($(w, '#publish-preview-actions')), false);
  assert.equal($(w, '#publish-preview-approve').textContent, '批准并发布');
  assert.equal($(w, '#publish-preview-cancel').textContent, '取消');
  $(w, '#publish-preview-approve').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0][0], 'u1');
  const approvalPayload = approvalCalls[0][1] as {
    requestId: string;
    approved: boolean;
    contentVersion: number;
    publishMode: string;
    publishTime: number | null;
  };
  assert.equal(approvalPayload.requestId, 'publish-89');
  assert.equal(approvalPayload.approved, true);
  assert.equal(approvalPayload.contentVersion, 0);
  assert.equal(approvalPayload.publishMode, 'immediate');
  assert.equal(approvalPayload.publishTime, null);
  assert.equal(delegatedCalls.length, 0, '审核页即时审批不得降级为异步委托任务');
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), false, '云端受理后关闭审核页');
  assert.equal($(w, '#pub-card').dataset.pubState, 'approved');
  assert.equal(($(w, '#delegated-confirm') as unknown as HTMLDialogElement).open, false);
});

test('小红书单稿显示定时入口，快捷按钮只选时间并按小时跳过 08:15 占用', async () => {
  const now = Date.parse('2026-07-20T20:00:00+08:00');
  const approvalCalls: unknown[][] = [];
  const { w } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: '单稿快捷排期', code: '#190', at: new Date(now).toISOString() },
    publishPreview: {
      recordId: 190,
      platform: 'xiaohongshu',
      kind: 'generated',
      title: '单稿快捷排期',
      content: '只选择时间，不自动批准。',
      topics: [],
      images: ['https://cdn.example.com/190.jpg'],
      contentVersion: 1,
      updatedAt: now,
    },
  }, {
    publishScheduleOccupiedHours: async () => ({
      ok: true,
      data: { occupiedTimes: [Date.parse('2026-07-21T08:15:00+08:00')] },
    }),
    publishApproval: async (...args: unknown[]) => {
      approvalCalls.push(args);
      return { ok: true, state: 'approved' };
    },
  });
  w.Date.now = () => now;

  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  const scheduled = w.document.querySelector('input[name="publish-plan-mode"][value="scheduled"]') as HTMLInputElement;
  assert.ok(scheduled, '单稿详情必须展示定时发布入口');
  scheduled.checked = true;
  scheduled.dispatchEvent(new w.Event('change'));
  const time = w.document.querySelector('.publish-plan-time input') as HTMLInputElement;
  time.value = '2026-07-20T21:00';
  time.dispatchEvent(new w.Event('input'));

  const free = w.document.querySelector('[data-publish-time-shortcut="free"]') as HTMLButtonElement;
  const peak = w.document.querySelector('[data-publish-time-shortcut="peak"]') as HTMLButtonElement;
  assert.equal(free.textContent, '下个空闲时段');
  assert.equal(peak.textContent, '下个热门时段');
  assert.equal(free.disabled, false);
  free.dispatchEvent(new w.Event('click'));
  assert.equal(time.value, '2026-07-21T12:00', '08:15 占用整个早上档，应跳到 12:00');
  assert.equal(approvalCalls.length, 0, '快捷按钮不得提交审批');
  peak.dispatchEvent(new w.Event('click'));
  assert.equal(time.value, '2026-07-21T18:00', '再次点击应以当前选择为游标前进');
  assert.equal(approvalCalls.length, 0);
});

test('稿件审核配图：双击查看大图，关闭层级与删图入口互不干扰', async () => {
  const firstUrl = 'https://cdn.example.com/lightbox-1.jpg';
  const secondUrl = 'https://cdn.example.com/lightbox-2.jpg';
  const { w, pushStatus } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: '配图核对稿', code: '#189', at: new Date().toISOString() },
    publishPreview: {
      recordId: 189,
      code: '#189',
      kind: 'rewrite',
      title: '配图核对稿',
      content: '核对图片细节后再发布',
      topics: [],
      images: [firstUrl, secondUrl],
      contentVersion: 2,
      updatedAt: Date.now(),
    },
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));

  const dialog = $(w, '#publish-preview-image-lightbox') as unknown as HTMLDialogElement;
  const firstImage = $(w, '#publish-preview-content img');
  firstImage.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(dialog.open, false, '单击缩略图不得打开大图');

  firstImage.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(dialog.open, true);
  assert.equal($(w, '#publish-preview-image-lightbox-image').getAttribute('src'), firstUrl);
  assert.equal($(w, '#publish-preview-image-lightbox-image').getAttribute('alt'), '配图 1 大图');

  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(dialog.open, false, '第一次 Escape 只关闭大图');
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), true, '底层稿件审核保持打开');
  assert.equal($(w, '#publish-preview-image-lightbox-image').getAttribute('src'), null, '关闭后清理旧图片引用');

  firstImage.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  $(w, '#publish-preview-image-lightbox-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(dialog.open, false, '关闭按钮可退出大图');

  firstImage.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  dialog.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(dialog.open, false, '点击图片外的 dialog 遮罩可退出大图');

  firstImage.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  $(w, '#publish-preview-image-lightbox figure').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(dialog.open, false, '点击大图留白区可退出大图');

  const deleteButton = $(w, '#publish-preview-content .publish-preview-image-delete');
  deleteButton.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(dialog.open, false, '删图入口不得误开大图');
  assert.ok($(w, '#publish-preview-content .publish-preview-image-confirm'), '删图仍进入既有二次确认');
  $(w, '#publish-preview-content .publish-preview-image-confirm-cancel')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  const refreshedImage = $(w, '#publish-preview-content img');
  refreshedImage.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(dialog.open, true);
  pushStatus(makeStatus({
    envId: 'u1',
    publish: { state: 'pending', title: '另一篇稿件', code: '#190', at: new Date().toISOString() },
    publishPreview: {
      recordId: 190,
      code: '#190',
      kind: 'rewrite',
      title: '另一篇稿件',
      content: '新稿件正文',
      topics: [],
      images: ['https://cdn.example.com/lightbox-new.jpg'],
      contentVersion: 0,
      updatedAt: Date.now(),
    },
  }));
  assert.equal(dialog.open, false, '切换稿件真态时关闭旧图');
  assert.equal($(w, '#publish-preview-image-lightbox-image').getAttribute('src'), null);
  refreshedImage.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(dialog.open, false, '旧 Cloud 单稿快照的过期缩略图不得重新打开');

  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), false, '大图已关闭后 Escape 仍按既有语义退出稿件审核');

  assert.match(rendererCss, /\.publish-preview-image-lightbox img\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(rendererCss, /\.publish-preview-image img\s*\{[^}]*cursor:\s*zoom-in/s);
});

test('洗稿稿件审核：点击取消直接提交驳回决定并携带当前版本', async () => {
  const approvalCalls: unknown[][] = [];
  const delegatedCalls: unknown[] = [];
  const { w } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: '洗稿标题', code: '#90', at: new Date().toISOString() },
    publishPreview: {
      recordId: 90,
      code: '#90',
      kind: 'rewrite',
      title: '洗稿标题',
      content: '正文',
      topics: [],
      images: [],
      contentVersion: 1,
      updatedAt: Date.now(),
    },
  }, {
    publishApproval: async (...args: unknown[]) => {
      approvalCalls.push(args);
      return { ok: true, state: 'rejected' };
    },
    delegatedTaskDraft: async (_envId: unknown, payload: unknown) => { delegatedCalls.push(payload); return delegatedDraftReceipt('reject_candidate'); },
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  assert.ok($(w, '#publish-preview-panel').classList.contains('open'));
  $(w, '#publish-preview-cancel').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0][0], 'u1');
  const approvalPayload = approvalCalls[0][1] as { requestId: string; approved: boolean; contentVersion: number };
  assert.equal(approvalPayload.requestId, 'publish-90');
  assert.equal(approvalPayload.approved, false);
  assert.equal(approvalPayload.contentVersion, 1);
  assert.equal('publishMode' in approvalPayload, false, '取消不得夹带发布计划');
  assert.equal('publishTime' in approvalPayload, false, '取消不得夹带发布时间');
  assert.equal(delegatedCalls.length, 0);
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), false);
  assert.equal($(w, '#pub-card').dataset.pubState, 'rejected');
});

test('多条待审批稿按灵感池卡片展示，批准时可定时发布并继续处理剩余稿件', async () => {
  const now = Date.parse('2026-07-20T20:00:00+08:00');
  const scheduledInput = '2026-07-21T08:00';
  const scheduledAt = Date.parse(`${scheduledInput}:00+08:00`);
  const listItems = [
    {
      id: 101, platform: 'xiaohongshu', kind: 'rewrite', title: '第一条待审', contentPreview: '第一条摘要',
      topics: ['一'], images: ['https://img/1.jpg'], contentVersion: 2, updatedAt: now,
      publishMode: 'immediate', publishTime: null,
    },
    {
      id: 102, platform: 'xiaohongshu', kind: 'generated', title: '第二条待审', contentPreview: '第二条摘要',
      topics: ['二'], images: ['https://img/2.jpg'], contentVersion: 4, updatedAt: now,
      publishMode: 'immediate', publishTime: null,
    },
  ];
  const approvalCalls: unknown[][] = [];
  let listCalls = 0;
  const { w } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: '第二条待审', code: '#102', at: new Date().toISOString() },
    publishPreview: { recordId: 102, ...listItems[1], content: '第二条完整正文' },
  }, {
    publishDraftList: async () => {
      listCalls += 1;
      return { ok: true, data: { items: listItems, total: 2, limit: 12, offset: 0 } };
    },
    publishDraftGet: async (_envId: string, id: number) => ({
      ok: true,
      data: { item: { ...listItems.find((item) => item.id === id), content: `${id} 的完整正文` } },
    }),
    publishScheduleOccupiedHours: async () => ({ ok: true, data: { occupiedTimes: [] } }),
    publishApproval: async (...args: unknown[]) => {
      approvalCalls.push(args);
      return { ok: true, state: 'approved', currentVersion: 5 };
    },
  });
  w.Date.now = () => now;

  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(w.document.querySelectorAll('.publish-draft-card').length, 2);
  assert.match($(w, '#publish-preview-content').textContent ?? '', /第一条待审/);
  assert.match($(w, '#publish-preview-content').textContent ?? '', /第二条待审/);
  assert.equal(hidden($(w, '#publish-preview-actions')), true, '列表态不允许误批未选中的稿件');

  (w.document.querySelector('[data-publish-draft-id="102"]') as HTMLElement).dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal($(w, '#publish-preview-title').textContent, '第二条待审');
  assert.match($(w, '#publish-preview-content').textContent ?? '', /102 的完整正文/);
  const scheduled = w.document.querySelector('input[name="publish-plan-mode"][value="scheduled"]') as HTMLInputElement;
  scheduled.checked = true;
  scheduled.dispatchEvent(new w.Event('change'));
  const time = w.document.querySelector('.publish-plan-time input') as HTMLInputElement;
  time.value = '';
  time.dispatchEvent(new w.Event('input'));
  assert.equal((w.document.querySelector('#publish-preview-approve') as HTMLButtonElement).disabled, true);
  assert.match($(w, '#publish-preview-action-hint').textContent ?? '', /请选择定时发布时间/);
  time.value = scheduledInput;
  time.dispatchEvent(new w.Event('input'));
  assert.equal($(w, '#publish-preview-approve').textContent, '批准并定时发布');
  assert.equal((w.document.querySelector('#publish-preview-approve') as HTMLButtonElement).disabled, false);

  $(w, '#publish-preview-approve').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  await tick();
  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0][0], 'u1');
  const sent = approvalCalls[0][1] as Record<string, unknown>;
  assert.equal(sent.requestId, 'publish-102');
  assert.equal(sent.approved, true);
  assert.equal(sent.contentVersion, 4);
  assert.equal(sent.publishMode, 'scheduled');
  assert.equal(sent.publishTime, scheduledAt);
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), true, '还有稿件时审核页保持打开');
  assert.equal($(w, '#publish-preview-title').textContent, '第一条待审', '数据库状态延迟时 handled 集也会滤掉刚处理的稿件');
  assert.ok(listCalls >= 2, '审批成功后重新读取权威待审列表');
  const nextScheduled = w.document.querySelector('input[name="publish-plan-mode"][value="scheduled"]') as HTMLInputElement;
  nextScheduled.checked = true;
  nextScheduled.dispatchEvent(new w.Event('change'));
  const nextTime = w.document.querySelector('.publish-plan-time input') as HTMLInputElement;
  nextTime.value = '2026-07-20T21:00';
  nextTime.dispatchEvent(new w.Event('input'));
  (w.document.querySelector('[data-publish-time-shortcut="free"]') as HTMLButtonElement)
    .dispatchEvent(new w.Event('click'));
  assert.equal(nextTime.value, '2026-07-21T12:00', '刚受理的 08:00 排期在 Cloud 回写前也应由会话保留避让');
});

test('定时发布与日期时间控件交互保持稿件阅读位置', async () => {
  const now = Date.now();
  const item = {
    id: 201,
    platform: 'xiaohongshu',
    kind: 'generated',
    title: '长稿待审',
    contentPreview: '需要滚动阅读的摘要',
    content: '需要滚动阅读的完整正文',
    topics: ['滚动位置'],
    images: ['https://img/201.jpg'],
    contentVersion: 3,
    updatedAt: now,
    publishMode: 'immediate',
    publishTime: null,
  };
  const { w } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: item.title, code: '#201', at: new Date().toISOString() },
    publishPreview: { recordId: 201, ...item },
  }, {
    publishDraftList: async () => ({ ok: true, data: { items: [item], total: 1, limit: 12, offset: 0 } }),
    publishDraftGet: async () => ({ ok: true, data: { item } }),
  });

  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  await tick();

  const panel = $(w, '#publish-preview-panel');
  const titleBefore = $(w, '#publish-preview-title');
  const scheduled = w.document.querySelector('input[name="publish-plan-mode"][value="scheduled"]') as HTMLInputElement;
  panel.scrollTop = 360;
  scheduled.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  panel.scrollTop = 0;
  scheduled.checked = true;
  scheduled.dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick();

  assert.equal(panel.scrollTop, 360, '切换定时发布后保持审核容器位置');
  assert.equal($(w, '#publish-preview-title'), titleBefore, '切换发布模式不得重建整份稿件详情');
  const timeRow = w.document.querySelector('.publish-plan-time') as HTMLElement;
  assert.equal(timeRow.classList.contains('hidden'), false);

  const time = timeRow.querySelector('input') as HTMLInputElement;
  panel.scrollTop = 420;
  time.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  panel.scrollTop = 0;
  time.dispatchEvent(new w.Event('click', { bubbles: true }));
  await tick();
  assert.equal(panel.scrollTop, 420, '打开日期时间选择器后保持审核容器位置');

  const scheduledInput = new Date(now + 2 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
  panel.scrollTop = 480;
  time.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  panel.scrollTop = 0;
  time.value = scheduledInput;
  time.dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick();
  assert.equal(panel.scrollTop, 480, '修改定时时间后保持审核容器位置');
  assert.equal((w.document.querySelector('#publish-preview-approve') as HTMLButtonElement).disabled, false);
});

test('旧 Cloud 不提供待审批列表端点时回落单稿快照', async () => {
  const { w } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: '兼容稿件', code: '#77', at: new Date().toISOString() },
    publishPreview: {
      recordId: 77,
      kind: 'rewrite',
      title: '兼容稿件',
      content: '旧 Cloud 快照正文',
      topics: [],
      images: [],
      contentVersion: 2,
      updatedAt: Date.now(),
    },
  }, {
    publishDraftList: async () => ({ ok: false, status: 404, error: 'request_failed' }),
    publishDraftGet: async () => ({ ok: false, status: 404, error: 'request_failed' }),
  });

  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal($(w, '#publish-preview-title').textContent, '兼容稿件');
  assert.match($(w, '#publish-preview-content').textContent ?? '', /旧 Cloud 快照正文/);
  assert.equal(hidden($(w, '#publish-preview-actions')), false);
  assert.equal((w.document.querySelector('[data-publish-time-shortcut="free"]') as HTMLButtonElement).disabled, true);
  assert.match($(w, '.publish-plan-shortcut-hint').textContent ?? '', /暂时无法判断空闲时段/);
});

test('账号切换会使旧账号在途待审列表应答失效', async () => {
  let releaseList: ((value: unknown) => void) | undefined;
  const { w, pushStatus } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: '账号 A 最新稿', code: '#1', at: new Date().toISOString() },
    publishPreview: { recordId: 1, kind: 'rewrite', title: '账号 A 最新稿', content: 'A', topics: [], images: [], contentVersion: 0 },
  }, {
    publishDraftList: () => new Promise((resolve) => { releaseList = resolve; }),
    publishDraftGet: async () => ({ ok: false, status: 404 }),
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  await tick();
  pushStatus(makeStatus({
    envId: 'u2',
    account: { id: 'acct-2', name: '账号 B' },
    publish: { state: 'pending', title: '账号 B 稿件', code: '#2', at: new Date().toISOString() },
    publishPreview: { recordId: 2, kind: 'rewrite', title: '账号 B 稿件', content: 'B', topics: [], images: [], contentVersion: 0 },
  }));
  await tick();
  (w.document.querySelector('.rail-row[data-env-id="u2"]') as HTMLElement).dispatchEvent(new w.Event('click'));
  await tick();
  releaseList?.({
    ok: true,
    data: { items: [{ id: 9, kind: 'rewrite', title: '账号 A 陈旧应答', contentPreview: 'stale', images: [], topics: [] }], total: 1 },
  });
  await tick();
  await tick();
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), false);
  assert.doesNotMatch($(w, '#publish-preview-content').textContent ?? '', /账号 A 陈旧应答/);
  assert.equal($(w, '#pub-title').textContent, '账号 B 稿件');
});

test('洗稿稿件审核：云端拒绝时保持页面与待审真态并显示具名原因', async () => {
  const delegatedCalls: unknown[] = [];
  const { w } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: '洗稿标题', code: '#91', at: new Date().toISOString() },
    publishPreview: {
      recordId: 91,
      code: '#91',
      kind: 'rewrite',
      title: '洗稿标题',
      content: '正文',
      topics: [],
      images: [],
      contentVersion: 2,
      updatedAt: Date.now(),
    },
  }, {
    publishApproval: async () => ({ ok: false, reason: 'version_stale', currentVersion: 3 }),
    delegatedTaskDraft: async (_envId: unknown, payload: unknown) => { delegatedCalls.push(payload); return delegatedDraftReceipt('approve_candidate'); },
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  $(w, '#publish-preview-approve').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(delegatedCalls.length, 0);
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), true, '审批未受理必须保留审核页');
  assert.match($(w, '#publish-preview-action-hint').textContent ?? '', /稿件已更新/);
  assert.equal($(w, '#pub-card').dataset.pubState, 'pending', '失败不得本地伪造审批状态');
  assert.equal(($(w, '#publish-preview-approve') as unknown as HTMLButtonElement).disabled, false);
  assert.equal(($(w, '#publish-preview-cancel') as unknown as HTMLButtonElement).disabled, false);
});

test('洗稿稿件审核：旧账号审批应答不得改写切换后的账号稿件状态', async () => {
  let releaseApproval: ((value: unknown) => void) | undefined;
  const { w, pushStatus } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: '账号 A 稿件', code: '#91', at: new Date().toISOString() },
    publishPreview: {
      recordId: 91,
      code: '#91',
      kind: 'rewrite',
      title: '账号 A 稿件',
      content: 'A 正文',
      topics: [],
      images: [],
      contentVersion: 0,
      updatedAt: Date.now(),
    },
  }, {
    publishApproval: () => new Promise((resolve) => { releaseApproval = resolve; }),
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  $(w, '#publish-preview-approve').dispatchEvent(new w.Event('click'));
  await tick();
  pushStatus(makeStatus({
    envId: 'u2',
    account: { id: 'acct-2', name: '账号 B' },
    publish: { state: 'pending', title: '账号 B 稿件', code: '#92', at: new Date().toISOString() },
    publishPreview: {
      recordId: 92,
      code: '#92',
      kind: 'rewrite',
      title: '账号 B 稿件',
      content: 'B 正文',
      topics: [],
      images: [],
      contentVersion: 0,
      updatedAt: Date.now(),
    },
  }));
  await tick();
  (w.document.querySelector('.rail-row[data-env-id="u2"]') as unknown as HTMLElement)
    .dispatchEvent(new w.Event('click'));
  await tick();
  releaseApproval?.({ ok: true, state: 'approved' });
  await tick();
  await tick();
  assert.equal($(w, '#pub-card').dataset.pubState, 'pending');
  assert.equal($(w, '#pub-title').textContent, '账号 B 稿件');
});

test('稿件审核页关闭后清空未提交的删图确认态', async () => {
  const { w } = await boot({
    envId: 'u1',
    publish: { state: 'pending', title: '多图稿件', code: '#91', at: new Date().toISOString() },
    publishPreview: {
      recordId: 91,
      code: '#91',
      kind: 'rewrite',
      title: '多图稿件',
      content: '正文',
      topics: [],
      images: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
      contentVersion: 0,
      updatedAt: Date.now(),
    },
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  (w.document.querySelector('.publish-preview-image-delete') as unknown as HTMLButtonElement)
    .dispatchEvent(new w.Event('click'));
  assert.ok(w.document.querySelector('.publish-preview-image-confirm'));
  $(w, '#content-workspace-close').dispatchEvent(new w.Event('click'));
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  assert.equal(w.document.querySelector('.publish-preview-image-confirm'), null);
});

test('发布卡已通过 → 第四节点平静色 + 无需操作', async () => {
  const { w } = await boot({ publish: { state: 'approved', title: 't', at: new Date().toISOString() } });
  assert.equal($(w, '#pub-card').dataset.pubState, 'approved');
  const steps = Array.from($(w, '#pub-card').querySelectorAll('.j-step'));
  assert.ok((steps[3] as HTMLElement).classList.contains('cur'));
  assert.ok((steps[3] as HTMLElement).classList.contains('calm'));
  assert.match($(w, '#pub-foot').textContent ?? '', /无需操作/);
});

test('发布卡已提交待确认 → 本次稿件压过旧历史、自动展开且不冒充已发布', async () => {
  const now = Date.now();
  const { w } = await boot({
    publish: { state: 'submitted', title: '4090跑122B大模型实测对比', code: '#160', at: new Date(now - 90_000).toISOString() },
    lastPublish: { title: 'Claude被封 企业AI稳才是核心', at: new Date(now - 7 * 86_400_000).toISOString() },
  });
  const card = $(w, '#pub-card');
  assert.equal(card.dataset.pubState, 'submitted');
  assert.equal(card.dataset.pubMode, 'submitted');
  assert.equal(card.classList.contains('collapsed'), false, '未确认结果必须自动展开');
  assert.equal($(w, '#pub-head').textContent, '已提交，平台确认中');
  assert.match($(w, '#pub-title').textContent ?? '', /4090跑122B/);
  assert.doesNotMatch($(w, '#pub-title').textContent ?? '', /Claude被封/);
  assert.match($(w, '#pub-meta').textContent ?? '', /#160/);
  const steps = Array.from(card.querySelectorAll('.j-step'));
  assert.ok((steps[3] as HTMLElement).classList.contains('cur'));
  assert.ok((steps[3] as HTMLElement).classList.contains('calm'));
  assert.equal((steps[3].querySelector('.j-lab') as HTMLElement).textContent, '确认结果');
  assert.doesNotMatch(`${$(w, '#pub-head').textContent} ${$(w, '#pub-foot').textContent}`, /已发布/);
  assert.match($(w, '#activity-stream').textContent ?? '', /已提交，待链接确认/);
});

test('发布终态 → 折进活动流 + 卡片常驻转「上次发布」', async () => {
  const { w, pushStatus } = await boot({ publish: { state: 'pending', title: '秋日漫步', at: new Date().toISOString() } });
  pushStatus(makeStatus({ publish: { state: 'published', title: '秋日漫步', at: new Date().toISOString() } }));
  assert.equal(hidden($(w, '#pub-card')), false, '卡片常驻不消失');
  assert.equal($(w, '#pub-card').dataset.pubMode, 'last');
  assert.equal($(w, '#pub-head').textContent, '上次发布');
  assert.match($(w, '#pub-title').textContent ?? '', /秋日漫步/);
  assert.equal(w.document.querySelector('#pub-link'), null, '不再展示打开飞书入口');
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
  assert.equal(card.dataset.pubMode, 'empty');
  assert.ok(card.classList.contains('empty'));
  assert.match($(w, '#pub-title').textContent ?? '', /还没有发布过/);
  assert.ok(
    Array.from(card.querySelectorAll('button')).every((button) => button.hidden && button.disabled),
    '空态同样没有可操作按钮',
  );
  assert.equal(w.document.querySelector('#pub-link'), null, '空态也不展示打开飞书入口');
  assert.ok(card.querySelector('#pub-thumb'), '封面占位常在（空态为淡化默认形态）');
  assert.match($(w, '#pub-meta').textContent ?? '', /编号 —/, '编号默认形态');
  assert.ok($(w, '#pub-foot').querySelector('b'), '脚注关键词加粗');
  assert.match($(w, '#pub-foot').textContent ?? '', /确认后才会发布/);
  assert.ok(!($(w, '#pub-foot').textContent ?? '').includes('**'), '加粗标记不外露');
  const dots = Array.from(card.querySelectorAll('.j-step'));
  assert.ok(dots.every((el) => (el as HTMLElement).classList.contains('todo')), '幽灵旅程全 todo');
  assert.match(rendererCss, /\.pub\[data-pub-mode="empty"\] \.pub-thumb/);
  assert.match(rendererCss, /\.pub\[data-pub-mode="last"\] \.pub-thumb/);
  assert.match(rendererCss, /\.pub\[data-pub-state="approved"\] \.pub-thumb/);
});

test('发布卡常驻：带本地历史 → 直接呈现上次发布', async () => {
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const { w } = await boot({ lastPublish: { title: '上周的咖啡馆合集', at } });
  assert.equal($(w, '#pub-card').dataset.pubMode, 'last');
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

test('今日进展位于「今天做了这些」活动流标题上方', async () => {
  const { w } = await boot();
  const summary = $(w, '#daily-summary');
  const streamHead = $(w, '.stream-h');
  assert.equal(streamHead.textContent, '今天做了这些');
  assert.ok(summary.compareDocumentPosition(streamHead) & w.Node.DOCUMENT_POSITION_FOLLOWING);
});

test('今日浏览完成即展示今日完成价值卡和任务完成标签', async () => {
  const { w, pushStatus } = await boot();
  const originalNow = w.Date.now;
  const now = 1730000000000;
  w.Date.now = () => now;
  try {
    pushStatus(makeStatus({
      session: 'resting',
      presence: { text: '这一轮已经完成，稍作等待后会自动继续', at: new Date(now - 38_000).toISOString() },
      dailyUsage: {
        asOf: now,
        quotaLevel: 'normal',
        totals: { view: 300, like: 16, collect: 9, comment: 4, follow: 0, publish: 0 },
        quotas: { view: 300, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
        saturated: ['view'],
        inspirationSummary: { count: 3, sourceLikeCount: 12_345 },
        windows: {
          day: {
            startedAt: now - 8 * 60 * 60_000,
            windowMs: 24 * 60 * 60_000,
            expiresAt: now + 8 * 60 * 60_000,
            totals: { view: 300, like: 16, collect: 9, comment: 4, follow: 0, publish: 0 },
            quotas: { view: 300, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
            saturated: ['view'],
          },
        },
      },
    }));
    assert.equal($(w, '#presence-text').textContent, '今日内容探索已经完成');
    assert.equal($(w, '#presence-fresh').textContent, '预计约 8 小时后开启新一天计划');
    assert.equal(hidden($(w, '#runtime-guidance')), false);
    assert.equal($(w, '#runtime-guidance').dataset.mode, 'day');
    assert.equal($(w, '#runtime-guidance-kicker').textContent, '探索完成');
    assert.match($(w, '#runtime-guidance-title').textContent ?? '', /明天继续/);
    assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /今日浏览计划已完成/);
    assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /继续寻找灵感/);
    const daySteps = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-step')) as HTMLElement[];
    const dayConnectors = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-connector')) as HTMLElement[];
    assert.equal(daySteps.length, 3);
    assert.equal(dayConnectors.length, 2);
    assert.ok(dayConnectors[0].classList.contains('flow-active'), '今日完成：浏览与互动 → 自然沉淀需要动态连接');
    assert.ok(dayConnectors[1].classList.contains('flow-active'), '今日完成：自然沉淀 → 继续寻找灵感需要动态连接');
    assert.equal(dayConnectors.some((connector) => connector.classList.contains('flow-complete')), false);
    assert.equal(w.document.querySelector('#loop'), null, '今日完成不保留七段详细步骤');
    assert.equal(w.document.querySelector('.rg-loop-toggle'), null, '今日完成不提供查看运行步骤入口');
    assert.match(daySteps[0].querySelector('.rg-flow-icon')?.innerHTML ?? '', /<circle cx="12" cy="12" r="9"/);
    assert.match(daySteps[1].querySelector('.rg-flow-icon')?.innerHTML ?? '', /m19 21-7-4-7 4V5/);
    assert.match(daySteps[2].querySelector('.rg-flow-icon')?.innerHTML ?? '', /M12 2v8/);
    assert.equal(hidden($(w, '#runtime-guidance-progress')), true);
    assert.equal(hidden($(w, '#runtime-guidance-resume')), true);
    assert.equal(hidden($(w, '#runtime-guidance-harvest')), false);
    assert.match($(w, '#runtime-guidance-harvest').textContent ?? '', /本轮收获已保存/);
    assert.match($(w, '#runtime-guidance-harvest').textContent ?? '', /3 条创作灵感/);
    assert.match($(w, '#runtime-guidance-harvest').textContent ?? '', /来源热度 1\.2 万赞/);
    assert.equal(w.document.querySelectorAll('#runtime-guidance-harvest b').length, 2);
    assert.match(rendererCss, /\.rg-harvest\s*\{/);
    assert.match(rendererSrc, /harvest: '<svg[\s\S]*<path d="m19 21-7-4-7 4V5/);
    assert.match(rendererSrc, /harvest: '<svg[\s\S]*<path d="m9 10 2 2 4-4"/);
    assert.match(rendererCss, /\.runtime-guidance\[data-mode="day"\] \.rg-flow\s*\{[\s\S]*--rg-step-next: #22a875;/);
    assert.match(rendererCss, /\.runtime-guidance\[data-mode="day"\] \.rg-flow\s*\{[\s\S]*--rg-step-line-active-start: rgba\(34, 168, 117, 0\.78\);[\s\S]*--rg-step-line-active-end: rgba\(34, 168, 117, 0\.56\);/);
    assert.match(rendererCss, /\.rg-flow-copy small \{[\s\S]*color: var\(--rg-step-detail\);/);
    assert.doesNotMatch(rendererCss, /\.runtime-guidance\[data-mode="day"\] \.rg-flow-step\.next \.rg-flow-copy small/);
    assert.equal($(w, '#usage-limit').textContent, '今日任务已完成');
    assert.ok($(w, '#usage-limit').classList.contains('complete'));
  } finally {
    w.Date.now = originalNow;
  }
});

test('生命周期控制收进今日进展，不再悬浮遮挡活动流', async () => {
  const { w } = await boot();
  const actions = $(w, '#daily-summary .summary-actions');
  assert.ok(actions.contains($(w, '#session-fab')));
  assert.ok(actions.contains($(w, '#session-close')));
  assert.ok(actions.contains($(w, '#updated-at')));
  assert.match(rendererCss, /\.summary-actions\s*\{/);
  assert.doesNotMatch(rendererCss, /\.fab-group\s*\{[^}]*position:\s*fixed/s);
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
  assert.equal($(w, '#usage-limit').textContent, '今日点赞计划已完成');
  assert.match($(w, '#usage-limit').title ?? '', /点赞：近 1 分钟、今日计划已完成/);
  assert.doesNotMatch($(w, '#usage-limit').title ?? '', /发帖/);
  assert.ok($(w, '#usage-limit').classList.contains('complete'));
  assert.ok(!$(w, '#usage-limit').classList.contains('hit'));
  assert.equal($(w, '#quota-toggle').getAttribute('aria-label'), '展开今日节奏');
  assert.equal($(w, '#quota-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal($(w, '#quota-toggle-label').textContent, '展开');
  assert.equal($(w, '#quota-toggle').classList.contains('open'), false);
  assert.ok($(w, '#quota-toggle .quota-toggle-icon'));
  assert.ok($(w, '#quota-windows').classList.contains('hidden'), 'collapsed card should only show daily totals');
  $(w, '#daily-summary').click();
  await tick();
  assert.equal($(w, '#quota-toggle').getAttribute('aria-label'), '收起今日节奏');
  assert.equal($(w, '#quota-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal($(w, '#quota-toggle-label').textContent, '收起');
  assert.equal($(w, '#quota-toggle').classList.contains('open'), true);
  assert.match(rendererCss, /\.quota-toggle\.open \.quota-toggle-icon/);
  assert.ok(!$(w, '#quota-windows').classList.contains('hidden'));
  assert.equal(w.document.querySelectorAll('.quota-window-detail').length, 4);
  assert.equal(w.document.querySelectorAll('.qwd-row').length, 24);
  const windowDetails = Array.from(w.document.querySelectorAll('.quota-window-detail')) as unknown as HTMLElement[];
  assert.match(windowDetails[0].textContent ?? '', /本轮计划/);
  assert.match(windowDetails[0].textContent ?? '', /剩余 10 分钟/);
  assert.match(windowDetails[0].textContent ?? '', /11:33 开始 · 预计 11:43 结束/);
  assert.match(windowDetails[1].textContent ?? '', /近 1 分钟/);
  assert.match(windowDetails[2].textContent ?? '', /近 1 小时/);
  assert.match(windowDetails[3].textContent ?? '', /今日计划/);
  assert.doesNotMatch($(w, '#quota-windows').textContent ?? '', /当前节奏|阶段节奏/);
  assert.ok(!windowDetails[1].classList.contains('complete'), 'like completion should not complete the minute card');
  assert.ok(!windowDetails[3].classList.contains('complete'), 'supporting action completion should not complete the day card');
  const minuteState = windowDetails[1].querySelector('.qwd-head strong') as HTMLElement;
  const dayState = windowDetails[3].querySelector('.qwd-head strong') as HTMLElement;
  assert.equal(minuteState.textContent, '完成 1项');
  assert.equal(dayState.textContent, '完成 2项');
  assert.ok(minuteState.classList.contains('has-completions'));
  assert.ok(dayState.classList.contains('has-completions'));
  const sessionRows = Array.from(windowDetails[0].querySelectorAll('.qwd-row')) as unknown as HTMLElement[];
  const minuteRows = Array.from(windowDetails[1].querySelectorAll('.qwd-row')) as unknown as HTMLElement[];
  const dayRows = Array.from(windowDetails[3].querySelectorAll('.qwd-row')) as unknown as HTMLElement[];
  assert.match(sessionRows[0].textContent ?? '', /浏览\s*2/);
  assert.doesNotMatch(sessionRows[0].textContent ?? '', /最多|\//);
  assert.equal(sessionRows[0].querySelector('i'), null, 'uncapped session row should not render cap progress');
  assert.match(sessionRows[1].textContent ?? '', /点赞\s*1\s*最多 10/);
  assert.ok(sessionRows[1].querySelector('i'), 'capped session row should keep supplied progress');
  assert.ok(!minuteRows[1].classList.contains('complete'), 'completed like row should stay neutral');
  assert.ok(!minuteRows[1].classList.contains('near'), 'completed like row should not create a near-limit cue');
  assert.ok(!dayRows[1].classList.contains('complete'), 'completed like row should stay neutral');
  assert.ok(!dayRows[5].classList.contains('complete'), 'completed publish row should stay neutral');
  assert.match(windowDetails[1].textContent ?? '', /点赞\s*3\s*最多 3/);
  assert.doesNotMatch(windowDetails[1].textContent ?? '', /\d+\/\d+/);
  assert.match(windowDetails[2].textContent ?? '', /浏览\s*10\s*最多 60/);
  assert.match($(w, '#quota-windows').textContent ?? '', /继续/);
  assert.match(rendererCss, /\.quota-windows\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(rendererCss, /@media \(max-width: 620px\)[\s\S]*?\.quota-windows\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(rendererCss, /\.qwd-head strong\.has-completions[\s\S]*?color:\s*var\(--good-fg\)/);
  // 慢启动问号中的数据表是用户明确请求的「曲线限额」说明；陪伴式用语红线仍约束卡片常驻文案，
  // 不把按需展开的数值帮助表算进来。
  const summaryCopy = $(w, '#daily-summary').cloneNode(true) as HTMLElement;
  summaryCopy.querySelector('#slow-start-help-panel')?.remove();
  assert.doesNotMatch(summaryCopy.textContent ?? '', /已达|上限|额度|释放|已满/);
  assert.equal($(w, '#views').textContent, '10');
  assert.equal($(w, '#likes').textContent, '3');
  assert.equal($(w, '#follows').textContent, '2');
  assert.equal($(w, '#publishes').textContent, '1');
  assert.equal($(w, '#likes-cap').textContent, '/3');
  assert.ok($(w, '#likes').closest('.kpi')?.classList.contains('complete'));
  assert.ok($(w, '#publishes').closest('.kpi')?.classList.contains('complete'));
  w.Date.now = originalNow;
});

test('今日进展：只有浏览完成时窗口卡片和浏览行进入完成态', async () => {
  const { w, pushStatus } = await boot();
  const originalNow = w.Date.now;
  const now = 1730000002000;
  w.Date.now = () => now;
  try {
    pushStatus(makeStatus({
      dailyUsage: {
        asOf: now,
        quotaLevel: 'normal',
        totals: { view: 8, like: 0 },
        quotas: { view: 8, like: 3 },
        saturated: ['view'],
        windows: {
          day: {
            startedAt: now - 3600000,
            expiresAt: now + 3600000,
            totals: { view: 8, like: 0 },
            quotas: { view: 8, like: 3 },
            saturated: ['view'],
          },
        },
      },
    }));
    $(w, '#daily-summary').click();
    await tick();

    const dayDetail = w.document.querySelector('.quota-window-detail') as HTMLElement;
    const dayState = dayDetail.querySelector('.qwd-head strong') as HTMLElement;
    const rows = Array.from(dayDetail.querySelectorAll('.qwd-row')) as unknown as HTMLElement[];
    assert.ok(dayDetail.classList.contains('complete'));
    assert.equal(dayState.textContent, '完成 1项');
    assert.ok(dayState.classList.contains('has-completions'));
    assert.ok(rows[0].classList.contains('complete'), 'completed view row should use completion styling');
    assert.ok(!rows[1].classList.contains('complete'), 'incomplete supporting row should remain neutral');
  } finally {
    w.Date.now = originalNow;
  }
});

test('今日进展：本轮未开始或缺少时间时不编造剩余时间和结束时间', async () => {
  const now = 1730000002000;
  const { w, pushStatus } = await boot();
  const originalNow = w.Date.now;
  w.Date.now = () => now;
  try {
    const dailyBase = {
      asOf: now,
      totals: { view: 2, like: 0 },
      quotas: { view: 150, like: 50 },
      saturated: [],
    };
    pushStatus(makeStatus({
      dailyUsage: {
        ...dailyBase,
        windows: {
          session: {
            active: false,
            startedAt: now - 120000,
            expiresAt: now + 480000,
            totals: { view: 2, like: 0 },
            quotas: { like: 5 },
            saturated: [],
          },
        },
      },
    }));
    $(w, '#daily-summary').click();
    await tick();
    let sessionDetail = w.document.querySelector('.quota-window-detail') as HTMLElement;
    assert.match(sessionDetail.textContent ?? '', /等待开始/);
    assert.doesNotMatch(sessionDetail.textContent ?? '', /剩余|预计.*结束/);

    pushStatus(makeStatus({
      dailyUsage: {
        ...dailyBase,
        windows: {
          session: {
            active: true,
            expiresAt: now + 480000,
            totals: { view: 2, like: 0 },
            quotas: { like: 5 },
            saturated: [],
          },
        },
      },
    }));
    sessionDetail = w.document.querySelector('.quota-window-detail') as HTMLElement;
    assert.match(sessionDetail.textContent ?? '', /进行中/);
    assert.doesNotMatch(sessionDetail.textContent ?? '', /剩余|预计.*结束/);
  } finally {
    w.Date.now = originalNow;
  }
});

test('今日进展：多个完成项只按浏览、点赞、收藏、评论、关注、发帖的顺序展示一个', async () => {
  const { w, pushStatus } = await boot();
  const originalNow = w.Date.now;
  const now = 1730000002000;
  w.Date.now = () => now;
  const actions = [
    { action: 'view', label: '浏览', text: '今日任务已完成' },
    { action: 'like', label: '点赞', text: '今日点赞计划已完成' },
    { action: 'collect', label: '收藏', text: '今日收藏计划已完成' },
    { action: 'comment', label: '评论', text: '今日评论计划已完成' },
    { action: 'follow', label: '关注', text: '今日关注计划已完成' },
    { action: 'publish', label: '发帖', text: '今日发帖计划已完成' },
  ];
  try {
    for (let index = 0; index < actions.length; index += 1) {
      const completed = actions.slice(index);
      const totals = Object.fromEntries(actions.map((item) => [item.action, completed.some((entry) => entry.action === item.action) ? 1 : 0]));
      const quotas = Object.fromEntries(actions.map((item) => [item.action, 1]));
      const saturated = completed.map((item) => item.action);
      pushStatus(makeStatus({
        dailyUsage: {
          asOf: now,
          quotaLevel: 'normal',
          totals,
          quotas,
          saturated,
          windows: {
            day: {
              startedAt: now - 3600000,
              windowMs: 86400000,
              expiresAt: now + 3600000,
              totals,
              quotas,
              saturated,
            },
          },
        },
      }));
      assert.equal($(w, '#usage-limit').textContent, actions[index].text);
      assert.match($(w, '#usage-limit').title ?? '', new RegExp(`^${actions[index].label}：`));
    }
  } finally {
    w.Date.now = originalNow;
  }
});

test('今日进展：旧版今日配额同时完成多项时也只展示最高优先级', async () => {
  const { w, pushStatus } = await boot();
  pushStatus(makeStatus({
    dailyUsage: {
      asOf: 1730000001000,
      quotaLevel: 'normal',
      totals: { view: 0, like: 3, collect: 1, comment: 0, follow: 0, publish: 1 },
      quotas: { view: 150, like: 3, collect: 1, comment: 8, follow: 15, publish: 1 },
      saturated: ['like', 'collect', 'publish'],
    },
  }));
  assert.equal($(w, '#usage-limit').textContent, '今日点赞计划已完成');
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
  assert.equal($(w, '#pub-bar-label').textContent, '发布过的 AI 写好的笔记');
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

test('审批到来 → 自动展开；审批落地（仍在运行）→ 收起为「已发布：标题」薄条', async () => {
  const { w, pushStatus } = await boot(); // running + empty → collapsed
  pushStatus(makeStatus({ publish: { state: 'pending', title: '秋日漫步', at: new Date().toISOString() } }));
  const card = $(w, '#pub-card');
  assert.ok(!card.classList.contains('collapsed'), '在途审批必须展开');
  assert.equal(hidden($(w, '#pub-bar')), true);
  pushStatus(makeStatus({ publish: { state: 'published', title: '秋日漫步', at: new Date().toISOString() } }));
  assert.ok(card.classList.contains('collapsed'), '审批落地后收回薄条');
  assert.equal($(w, '#pub-bar-label').textContent, '已发布：秋日漫步');
  assert.doesNotMatch($(w, '#pub-bar-sum').textContent ?? '', /上次发布/);
});

test('已发布历史即使未运行也默认收起为薄条', async () => {
  const { w } = await boot({
    edge: 'stopped',
    session: 'idle',
    lastPublish: { title: '上周的咖啡馆合集', at: new Date().toISOString() },
  });
  assert.ok($(w, '#pub-card').classList.contains('collapsed'));
  assert.equal(hidden($(w, '#pub-bar')), false);
  assert.equal($(w, '#pub-bar-label').textContent, '已发布：上周的咖啡馆合集');
});

test('未运行空态默认收起；点击可展开；真实发布流程到来仍自动展开', async () => {
  const { w, pushStatus } = await boot({ edge: 'stopped', session: 'idle' });
  const card = $(w, '#pub-card');
  assert.ok(card.classList.contains('collapsed'), '未运行空态也应默认收起');
  assert.equal(hidden($(w, '#pub-bar')), false, '空态薄条可见');
  assert.equal($(w, '#pub-bar-label').textContent, '发布过的 AI 写好的笔记');
  assert.match($(w, '#pub-bar-sum').textContent ?? '', /还没有发布过内容/);

  $(w, '#pub-bar').dispatchEvent(new w.Event('click'));
  assert.ok(!card.classList.contains('collapsed'), '点击薄条后展开空态旅程');
  assert.match($(w, '#pub-meta').textContent ?? '', /等待第一条笔记/);

  $(w, '#pub-head-row').dispatchEvent(new w.Event('click'));
  assert.ok(card.classList.contains('collapsed'), '点击卡头可再次收起');

  pushStatus(makeStatus({
    edge: 'stopped',
    session: 'idle',
    publish: { state: 'pending', title: '秋日漫步', at: new Date().toISOString() },
  }));
  assert.ok(!card.classList.contains('collapsed'), '真实发布流程到来必须自动展开');
  assert.equal(hidden($(w, '#pub-bar')), true);
});

test('委派入口收进状态区右侧浮层，默认不占主列并同步可访问状态', async () => {
  let listCalls = 0;
  const { w } = await boot({ envId: 'u1' }, {
    delegatedTaskList: async () => {
      listCalls += 1;
      return { ok: true, data: { tasks: [] } };
    },
  });
  const presence = $(w, '.presence');
  const trigger = $(w, '#delegated-trigger') as unknown as HTMLButtonElement;
  const popover = $(w, '#delegated-card');
  assert.equal(presence.contains(trigger), true, '入口应在当前状态行最右侧');
  assert.equal(presence.contains(popover), true, '浮层应锚定状态行，而不是主列常驻卡片');
  assert.equal(hidden(popover), true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(popover.getAttribute('aria-hidden'), 'true');
  assert.doesNotMatch(html, /class="delegated-card"/, '旧常驻大卡片样式入口应移除');
  assert.match(rendererCss, /\.delegated-popover\s*\{[^}]*position:\s*absolute/s);
  assert.match(rendererCss, /max-height:\s*min\(560px, calc\(100vh - 132px\)\)/);
  assert.match(rendererCss, /\.delegated-body\s*\{[^}]*overflow-y:\s*auto/s);

  const callsBeforeOpen = listCalls;
  trigger.click();
  await tick();
  assert.equal(hidden(popover), false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(popover.getAttribute('aria-hidden'), 'false');
  assert.equal(w.document.activeElement, $(w, '#delegated-close'));
  assert.ok(listCalls > callsBeforeOpen, '打开浮层应刷新当前环境任务');

  trigger.click();
  assert.equal(hidden(popover), true, '再次点击入口应关闭');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(w.document.activeElement, trigger);
});

test('委派浮层支持关闭按钮、外部点击和 Escape，Escape 后焦点回入口', async () => {
  const { w } = await boot({}, {
    delegatedTaskList: async () => ({ ok: true, data: { tasks: [] } }),
  });
  const trigger = $(w, '#delegated-trigger') as unknown as HTMLButtonElement;
  const popover = $(w, '#delegated-card');
  trigger.click();
  ($(w, '#delegated-close') as unknown as HTMLButtonElement).click();
  assert.equal(hidden(popover), true, '关闭按钮应收起浮层');

  trigger.click();
  w.document.body.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(hidden(popover), true, '点击浮层外部应收起');

  trigger.click();
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(hidden(popover), true, 'Escape 应收起');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(w.document.activeElement, trigger, 'Escape 关闭后焦点应回到入口');
});

test('当前环境有未结束委派时入口只显示克制蓝点和真实任务数量', async () => {
  const { w } = await boot({ envId: 'u1' }, {
    delegatedTaskList: async () => ({
      ok: true,
      data: { tasks: [
        { id: TASK_ID, status: 'executing', action: 'comment_batch', progress: {}, targetSuccessCount: 3, maxAttempts: 6 },
        { id: '22222222-2222-4222-8222-222222222222', status: 'completed', action: 'publish_post', progress: {}, targetSuccessCount: 1, maxAttempts: 2 },
      ] },
    }),
  });
  const trigger = $(w, '#delegated-trigger') as unknown as HTMLButtonElement;
  trigger.click();
  await tick();
  assert.equal(hidden($(w, '#delegated-indicator')), false);
  assert.match(trigger.getAttribute('aria-label') ?? '', /1 个未结束任务/);
  assert.match(rendererCss, /\.delegated-indicator\s*\{[^}]*background:\s*var\(--accent\)/s);
});

test('切换当前环境会关闭委派浮层并清空旧环境任务指示', async () => {
  const statusA = makeStatus({ envId: 'u1', account: { id: 'u1', name: '晚风手作' } });
  const statusB = makeStatus({ envId: 'u2', account: { id: 'u2', name: '山野咖啡' } });
  const { w } = await boot({}, {
    fleetGet: async () => ({
      environments: [
        { envId: 'u1', name: '晚风手作', platform: 'xiaohongshu', status: statusA },
        { envId: 'u2', name: '山野咖啡', platform: 'xiaohongshu', status: statusB },
      ],
      selectedEnvId: 'u1',
    }),
    delegatedTaskList: async (envId: unknown) => ({
      ok: true,
      data: { tasks: envId === 'u1' ? [{ id: TASK_ID, status: 'queued', action: 'comment_batch', progress: {}, targetSuccessCount: 3, maxAttempts: 6 }] : [] },
    }),
  });
  const trigger = $(w, '#delegated-trigger') as unknown as HTMLButtonElement;
  trigger.click();
  await tick();
  assert.equal(hidden($(w, '#delegated-card')), false);
  assert.equal(hidden($(w, '#delegated-indicator')), false);

  ($(w, '[data-env-id="u2"]') as unknown as HTMLElement).click();
  assert.equal(hidden($(w, '#delegated-card')), true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(hidden($(w, '#delegated-indicator')), true, '切换后不得短暂沿用旧环境指示');
});

test('用户委托快捷入口绑定当前选中环境，先确认再排队并展示真实进度', async () => {
  const drafts: unknown[][] = [];
  const actions: unknown[][] = [];
  const status = makeStatus({ envId: 'u1', account: { id: 'u1', name: '晚风手作' } });
  const { w } = await boot({}, {
    fleetGet: async () => ({
      environments: [{ envId: 'u1', name: '晚风手作', platform: 'xiaohongshu', status }],
      selectedEnvId: 'u1',
    }),
    delegatedTaskList: async (envId: unknown) => ({
      ok: true,
      data: { tasks: [{
        id: TASK_ID, version: 3, action: 'comment_batch', status: 'partially_completed',
        targetSuccessCount: 5, maxAttempts: 8,
        progress: { successCount: 3, attemptCount: 8, skippedCount: 3, failureCount: 2 },
        terminalOutcome: { message: '候选不足，平台验证成功 3/5。' },
        envId,
      }] },
    }),
    delegatedTaskDraft: async (...args: unknown[]) => { drafts.push(args); return delegatedDraftReceipt('comment_batch'); },
    delegatedTaskAction: async (...args: unknown[]) => { actions.push(args); return { ok: true, data: { task: { id: TASK_ID } } }; },
  });
  assert.match($(w, '#delegated-list').textContent ?? '', /成功 3\/5/);
  assert.match($(w, '#delegated-list').textContent ?? '', /尝试 8\/8/);
  assert.match($(w, '#delegated-list').textContent ?? '', /候选不足/);

  ($(w, '#delegated-count') as unknown as HTMLInputElement).value = '5';
  ($(w, '[data-delegated-action="comment_batch"]') as unknown as HTMLButtonElement).click();
  await tick();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0][0], 'u1');
  const payload = drafts[0][1] as { action: string; targetSuccessCount: number; maxAttempts: number };
  assert.equal(payload.action, 'comment_batch');
  assert.equal(payload.targetSuccessCount, 5);
  assert.equal(payload.maxAttempts, 10);
  assert.equal(($(w, '#delegated-confirm') as unknown as HTMLDialogElement).open, true);
  assert.equal(actions.length, 0, '确认前不排队');
  ($(w, '#delegated-confirm-submit') as unknown as HTMLButtonElement).click();
  await tick();
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].slice(0, 3), ['u1', TASK_ID, 'confirm']);
});

test('Facebook 当前环境明确禁用今日灵感快捷入口，不暗示已开放', async () => {
  const status = makeStatus({ envId: 'fb1', account: { id: 'fb1', name: 'FB Beta' } });
  const { w } = await boot({}, {
    fleetGet: async () => ({
      environments: [{ envId: 'fb1', name: 'FB Beta', platform: 'facebook', status }],
      selectedEnvId: 'fb1',
    }),
    delegatedTaskList: async () => ({ ok: true, data: { tasks: [] } }),
  });
  const inspiration = $(w, '[data-delegated-action="publish_from_inspiration"]') as unknown as HTMLButtonElement;
  assert.equal(inspiration.disabled, true);
  assert.match(inspiration.title, /尚未完成平台化创作模板/);
});

// ── 三段价值流程不再附带七段详细步骤 ──
test('运行步骤入口与七段详细步骤从 DOM、脚本和样式中彻底移除', async () => {
  const { w } = await boot();
  assert.equal(w.document.querySelector('#loop'), null);
  assert.equal(w.document.querySelector('.rg-loop-toggle'), null);
  assert.doesNotMatch(html, /id="loop"|查看运行步骤|收起运行步骤/);
  assert.doesNotMatch(rendererSrc, /loopDetailsOpen|renderLoop|查看运行步骤|收起运行步骤/);
  assert.doesNotMatch(rendererCss, /rg-loop-toggle|\.loop-step|\.loop-sep/);
});

// ── 稿件预览逐张删配图（change client-preview-image-delete）──
const IMGS3 = ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg', 'https://cdn.example.com/3.jpg'];

function previewStatus(images: string[], over: Record<string, unknown> = {}) {
  return {
    publish: { state: 'pending', title: '洗稿标题', code: '#89', at: new Date().toISOString() },
    publishPreview: {
      recordId: 89,
      code: '#89',
      kind: 'rewrite',
      title: '洗稿标题',
      content: '正文',
      topics: [],
      images,
      contentVersion: 0,
      updatedAt: Date.now(),
    },
    ...over,
  };
}

const deleteBtns = (w: DOMWindow) =>
  Array.from(w.document.querySelectorAll('.publish-preview-image-delete')) as unknown as HTMLButtonElement[];
const imgSrcs = (w: DOMWindow) =>
  Array.from(w.document.querySelectorAll('#publish-preview-content img')).map((el) =>
    (el as unknown as HTMLImageElement).getAttribute('src'),
  );

test('删配图：待审多图 → 二次确认后生成版本锁定的修改任务，任务确认前不改稿', async () => {
  const calls: unknown[] = [];
  const { w } = await boot(previewStatus(IMGS3, { envId: 'u1' }), {
    delegatedTaskDraft: async (_envId: unknown, payload: unknown) => {
      calls.push(payload);
      return delegatedDraftReceipt('modify_candidate');
    },
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  assert.equal(deleteBtns(w).length, 3, '三张图各有删除角标');
  assert.equal(deleteBtns(w)[1].getAttribute('aria-label'), '删除配图 2');

  // 点角标：只进确认态，绝不单击即删。
  deleteBtns(w)[1].dispatchEvent(new w.Event('click'));
  await tick();
  assert.equal(calls.length, 0, '未确认前绝不提交');
  const confirmOk = w.document.querySelector('.publish-preview-image-confirm-ok') as unknown as HTMLButtonElement;
  assert.ok(confirmOk, '出现就地二次确认');
  assert.deepEqual(imgSrcs(w), IMGS3, '确认前不乐观移除缩略图');

  confirmOk.dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(calls.length, 1);
  const sent = calls[0] as { action: string; targetConstraints: { candidateId: string; candidateVersion: number; images: string[] } };
  assert.equal(sent.action, 'modify_candidate');
  assert.equal(sent.targetConstraints.candidateId, '89');
  assert.equal(sent.targetConstraints.candidateVersion, 0);
  assert.deepEqual(Array.from(sent.targetConstraints.images), [IMGS3[0], IMGS3[2]]);
  assert.equal(($(w, '#delegated-confirm') as unknown as HTMLDialogElement).open, true);
  assert.deepEqual(imgSrcs(w), IMGS3, '确认和 worker 执行前绝不乐观改稿');
});

test('删配图：只剩一张 → 无删除入口 + 明示至少保留一张', async () => {
  const { w } = await boot(previewStatus([IMGS3[0]]), { publishImageRemove: async () => ({ ok: true }) });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  assert.equal(deleteBtns(w).length, 0, '最后一张不给删除入口');
  assert.match($(w, '#publish-preview-content').textContent ?? '', /至少保留一张配图/);
});

test('删配图：非待审稿件（已通过）不显示删除入口', async () => {
  const { w } = await boot(
    previewStatus(IMGS3, { publish: { state: 'approved', title: '洗稿标题', code: '#89', at: new Date().toISOString() } }),
    { publishImageRemove: async () => ({ ok: true }) },
  );
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  assert.equal(deleteBtns(w).length, 0);
});

test('删配图：删除在途时发布/取消一并禁用（防拿旧版本号去审批）', async () => {
  const gate: { release?: (v: unknown) => void } = {};
  const { w } = await boot(previewStatus(IMGS3, { envId: 'u1' }), {
    delegatedTaskDraft: () => new Promise((r) => { gate.release = r; }),
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  deleteBtns(w)[0].dispatchEvent(new w.Event('click'));
  await tick();
  (w.document.querySelector('.publish-preview-image-confirm-ok') as unknown as HTMLButtonElement)
    .dispatchEvent(new w.Event('click'));
  await tick();
  assert.equal(($(w, '#publish-preview-approve') as unknown as HTMLButtonElement).disabled, true);
  assert.equal(($(w, '#publish-preview-cancel') as unknown as HTMLButtonElement).disabled, true);
  gate.release?.(delegatedDraftReceipt('modify_candidate'));
  await tick();
  await tick();
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), false);
  assert.equal(($(w, '#delegated-confirm') as unknown as HTMLDialogElement).open, true);
});

test('删配图：云端拒绝 → 该张仍在界面上 + 诚实拒因，绝无成功措辞', async () => {
  const { w } = await boot(previewStatus(IMGS3, { envId: 'u1' }), {
    delegatedTaskDraft: async () => ({ ok: false, error: 'version_stale' }),
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  deleteBtns(w)[1].dispatchEvent(new w.Event('click'));
  await tick();
  (w.document.querySelector('.publish-preview-image-confirm-ok') as unknown as HTMLButtonElement)
    .dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.deepEqual(imgSrcs(w), IMGS3, '失败后该张仍在，绝不抹掉');
  const text = $(w, '#publish-preview-content').textContent ?? '';
  assert.match(text, /未能创建修改任务/);
  assert.doesNotMatch(text, /已删除|删除成功/);
});

// ── 指标格按平台投影（change platform-honest-usage-metrics）────────────────────
// 客户端只渲染云端真给了的键。这几条钉的是「屏幕上多一格 / 少一格」，全都不报错。
const kpi = (w: DOMWindow, action: string) => $(w, `.kpi[data-action="${action}"]`);
const kpiVisible = (w: DOMWindow, action: string) => !kpi(w, action).classList.contains('hidden');

test('FB 形状：收藏 / 关注整格不渲染（不是渲染一个诚实的 0），加群格出现', async () => {
  const { w } = await boot({
    dailyUsage: {
      // 云端按平台投影后的真实形状：无 collect / follow，有 join_group。
      totals: { view: 12, like: 3, comment: 1, publish: 0, join_group: 2 },
      quotas: { view: 150, like: 50, comment: 8, publish: 1, join_group: 3 },
    },
  });
  assert.equal(kpiVisible(w, 'collect'), false, 'FB 没有收藏这个概念 ⇒ 整格不画');
  assert.equal(kpiVisible(w, 'follow'), false, 'FB 没有关注执行器 ⇒ 整格不画');
  assert.equal(kpiVisible(w, 'join_group'), true, '加群是 FB 真做、真烧配额的动作');
  assert.equal($(w, '#joins').textContent, '2');
  assert.equal($(w, '#joins-cap').textContent, '/3');
  for (const action of ['view', 'like', 'comment', 'publish']) {
    assert.equal(kpiVisible(w, action), true, `${action} 照常显示`);
  }
});

test('小红书形状：六格逐位如常，且 MUST NOT 长出加群格（首要回归判据）', async () => {
  const { w } = await boot({
    dailyUsage: {
      totals: { view: 12, like: 3, collect: 2, comment: 1, follow: 1, publish: 0 },
      quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
    },
  });
  for (const action of ['view', 'like', 'collect', 'comment', 'follow', 'publish']) {
    assert.equal(kpiVisible(w, action), true, `${action} 必须照常显示`);
  }
  assert.equal(kpiVisible(w, 'join_group'), false, '小红书没有群 ⇒ 绝不出现加群格');
  assert.equal($(w, '#collects').textContent, '2');
  assert.equal($(w, '#collects-cap').textContent, '/25');
});

test('小红书首页用发布进度摘要替代单稿卡，待确认优先并可进入完整队列', async () => {
  let queueCalls = 0;
  const stages = [
    { key: 'source', label: '开始创作', state: 'completed', summary: '开始创作：已完成' },
    { key: 'content', label: '正文与配图', state: 'completed', summary: '正文与配图：已完成', progress: { current: 3, total: 3 } },
    { key: 'approval', label: '发布确认', state: 'waiting_human', summary: '发布确认：待你确认' },
    { key: 'dispatch', label: '发布结果', state: 'pending', summary: '发布结果：等待发布' },
  ];
  const { w, pushStatus } = await boot({ envId: 'env-home' }, {
    publishQueueGet: async () => {
      queueCalls += 1;
      return ({
      ok: true,
      data: {
        data: {
          envKey: 'u1',
          summary: { inProgress: 3, waitingForYou: 1, cancellable: 1 },
          tasks: [{
            id: 'task-home', title: '下一条排队笔记', action: '参考创作', status: 'queued', statusLabel: '排队中',
            cancelRequested: false, version: 2, createdAt: Date.now(), updatedAt: Date.now(), notBefore: Date.now(),
          }],
          active: [{
            id: 'publish:88', recordId: 88, title: '先确认这条城市散步笔记', sourceTitle: null,
            kind: 'persisted', startedAt: Date.now(), status: 'waiting_approval', statusLabel: '等待你确认', stages,
          }, {
            id: 'run:89', recordId: null, title: '正在写的咖啡地图', sourceTitle: null,
            kind: 'autonomous', startedAt: Date.now(), status: 'generating', statusLabel: '创作中', stages: stages.map((stage) => ({ ...stage, state: stage.key === 'content' ? 'running' : stage.key === 'source' ? 'completed' : 'pending' })),
          }],
          recent: [],
        },
        meta: { requestId: 'home-queue', asOf: Date.now() },
      },
      });
    },
    publishQueueCancel: async () => ({ ok: false, error: 'not_used' }),
    publishDraftList: async () => ({ ok: true, data: { items: [], total: 0 } }),
    publishDraftGet: async () => ({ ok: false, error: 'not_used' }),
  });
  pushStatus(makeStatus({ envId: 'env-home' }));
  await tick(); await tick(); await tick();
  assert.ok(queueCalls > 0, '首页初始化应读取当前小红书环境队列');
  const card = $(w, '#pub-card');
  assert.equal(card.dataset.pubState, 'pending');
  assert.match(card.textContent ?? '', /1 条笔记等你确认/);
  assert.match(card.textContent ?? '', /先确认这条城市散步笔记/);
  assert.match($(w, '#pub-queue-link').textContent ?? '', /查看全部进度/);
  assert.equal(hidden($(w, '#pub-queue-link')), false);
  assert.equal($(w, '#pub-title').getAttribute('aria-live'), 'polite');

  const previous = $(w, '#pub-carousel-prev') as unknown as HTMLButtonElement;
  const next = $(w, '#pub-carousel-next') as unknown as HTMLButtonElement;
  assert.equal(previous.tagName, 'BUTTON', '原生按钮保留 Enter / Space 键盘激活语义');
  assert.equal(previous.type, 'button');
  assert.equal(next.tagName, 'BUTTON', '原生按钮保留 Enter / Space 键盘激活语义');
  assert.equal(next.type, 'button');
  assert.equal(previous.hidden, false);
  assert.equal(previous.disabled, false);
  assert.equal(next.hidden, false);
  assert.equal(next.disabled, false);
  assert.equal(previous.getAttribute('aria-controls'), 'pub-carousel-content');
  assert.match(previous.getAttribute('aria-label') ?? '', /下一条排队笔记/);
  assert.match(next.getAttribute('aria-label') ?? '', /正在写的咖啡地图/);
  assert.equal($(w, '#pub-corner').textContent, '1 / 3');

  next.click();
  assert.equal($(w, '#pub-title').textContent, '正在写的咖啡地图');
  assert.equal($(w, '#pub-meta').textContent, '创作中');
  assert.equal($(w, '#pub-corner').textContent, '2 / 3');

  next.click();
  assert.equal($(w, '#pub-title').textContent, '下一条排队笔记');
  assert.equal($(w, '#pub-meta').textContent, '参考创作 · 排队中');
  assert.equal($(w, '#pub-corner').textContent, '3 / 3');
  assert.equal(w.document.querySelectorAll('#pub-steps .j-step.todo').length, 4, '排队任务不应伪造详细阶段');

  next.click();
  assert.equal($(w, '#pub-title').textContent, '先确认这条城市散步笔记', '末项向右应循环到首项');
  previous.click();
  assert.equal($(w, '#pub-title').textContent, '下一条排队笔记', '首项向左应循环到末项');
  assert.match(rendererCss, /\.pub-carousel-prev\s*\{\s*left:\s*0/);
  assert.match(rendererCss, /\.pub-carousel-next\s*\{\s*right:\s*0/);
  assert.match(rendererCss, /\.pub-carousel-nav:hover:not\(:disabled\)/);
  assert.match(rendererCss, /\.pub-carousel-nav:focus-visible/);
  assert.match(rendererCss, /\.pub-carousel-nav\[hidden\]\s*\{\s*display:\s*none/);

  $(w, '#pub-queue-link').click();
  await tick(); await tick();
  assert.equal(hidden($(w, '#content-workspace')), false);
  assert.equal(hidden($(w, '#publish-queue-view')), false);
  assert.match($(w, '#publish-queue-content').textContent ?? '', /3 条内容正在路上/);
});

test('小红书首页发布稿切换按稳定身份保持，切换账号复位，单稿时移除箭头焦点', async () => {
  const stages = [
    { key: 'source', label: '开始创作', state: 'completed', summary: '开始创作：已完成' },
    { key: 'content', label: '正文与配图', state: 'running', summary: '正文与配图：创作中' },
    { key: 'approval', label: '发布确认', state: 'pending', summary: '发布确认：未开始' },
    { key: 'dispatch', label: '发布结果', state: 'pending', summary: '发布结果：未开始' },
  ];
  const journey = (id: string, title: string, status: string, statusLabel: string) => ({
    id, recordId: null, title, sourceTitle: null, kind: 'autonomous', startedAt: Date.now(),
    status, statusLabel, stages,
  });
  const task = (id: string, title: string) => ({
    id, title, action: '参考创作', status: 'queued', statusLabel: '排队中', cancelRequested: false,
    version: 1, createdAt: Date.now(), updatedAt: Date.now(), notBefore: Date.now(),
  });
  const queues: Record<string, { summary: Record<string, number>; tasks: unknown[]; active: unknown[]; recent: unknown[] }> = {
    u1: {
      summary: { inProgress: 3, waitingForYou: 1, cancellable: 1 },
      active: [
        journey('publish:a1', '账号 A 待确认稿', 'waiting_approval', '等待你确认'),
        journey('run:a2', '账号 A 创作稿', 'generating', '创作中'),
      ],
      tasks: [task('task:a3', '账号 A 排队稿')],
      recent: [],
    },
    u2: {
      summary: { inProgress: 2, waitingForYou: 1, cancellable: 1 },
      active: [journey('publish:b1', '账号 B 待确认稿', 'waiting_approval', '等待你确认')],
      tasks: [task('task:b2', '账号 B 排队稿')],
      recent: [],
    },
  };
  const statusA = makeStatus({ envId: 'u1', account: { id: 'u1', name: '账号 A' } });
  const statusB = makeStatus({ envId: 'u2', account: { id: 'u2', name: '账号 B' } });
  const { w } = await boot({}, {
    fleetGet: async () => ({
      environments: [
        { envId: 'u1', name: '账号 A', platform: 'xiaohongshu', status: statusA },
        { envId: 'u2', name: '账号 B', platform: 'xiaohongshu', status: statusB },
      ],
      selectedEnvId: 'u1',
    }),
    publishQueueGet: async (envId: string) => ({
      ok: true,
      data: { data: queues[envId], meta: { requestId: `queue-${envId}`, asOf: Date.now() } },
    }),
  });

  const previous = $(w, '#pub-carousel-prev') as unknown as HTMLButtonElement;
  const next = $(w, '#pub-carousel-next') as unknown as HTMLButtonElement;
  assert.equal($(w, '#pub-title').textContent, '账号 A 待确认稿');
  next.click();
  assert.equal($(w, '#pub-title').textContent, '账号 A 创作稿');

  ($(w, '[data-env-id="u2"]') as unknown as HTMLElement).click();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal($(w, '#pub-title').textContent, '账号 B 待确认稿');
  ($(w, '[data-env-id="u1"]') as unknown as HTMLElement).click();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal($(w, '#pub-title').textContent, '账号 A 待确认稿', '切回账号后应从该账号优先项开始');

  next.click();
  queues.u1.active[1] = journey('run:a2', '账号 A 创作稿（已刷新）', 'generating', '创作中');
  w.dispatchEvent(new w.Event('focus'));
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal($(w, '#pub-title').textContent, '账号 A 创作稿（已刷新）', '刷新后按稳定任务身份保留当前项');
  assert.equal($(w, '#pub-corner').textContent, '2 / 3');

  next.focus();
  assert.equal(w.document.activeElement, next);
  queues.u1.active = [journey('publish:a1', '账号 A 待确认稿', 'waiting_approval', '等待你确认')];
  queues.u1.tasks = [];
  queues.u1.summary = { inProgress: 1, waitingForYou: 1, cancellable: 0 };
  w.dispatchEvent(new w.Event('focus'));
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal($(w, '#pub-title').textContent, '账号 A 待确认稿', '当前项离队后回到真实首项');
  assert.equal(previous.hidden, true);
  assert.equal(previous.disabled, true);
  assert.equal(next.hidden, true);
  assert.equal(next.disabled, true);
  assert.equal(w.document.activeElement, $(w, '#pub-head-row'), '箭头消失时焦点回到仍可操作的卡片标题');
});

test('供给的 0 照显，缺席才隐藏（两者是两件事）', async () => {
  const { w } = await boot({
    dailyUsage: { totals: { view: 0, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 } },
  });
  assert.equal(kpiVisible(w, 'collect'), true, '0 = 今天还没收藏，必须照显');
  assert.equal($(w, '#collects').textContent, '0');
});

test('还没收到云端用量 ⇒ 回落本机六格（保持现状），加群无本机来源故不出现', async () => {
  const { w } = await boot({ dailyUsage: undefined });
  for (const action of ['view', 'like', 'collect', 'comment', 'follow', 'publish']) {
    assert.equal(kpiVisible(w, action), true, `${action} 回落本机计数`);
  }
  assert.equal(kpiVisible(w, 'join_group'), false);
});

test('布局不得依赖固定格数：分隔线来自间隙透底，不来自 :first-child / :nth-child', async () => {
  // :nth-child 数的是 DOM 位置、不管 display:none ⇒ 隐藏格子后边框会错位到错误的格子上。
  assert.doesNotMatch(rendererCss, /\.kpi:first-child\s*\{[^}]*border-left/);
  assert.doesNotMatch(rendererCss, /\.kpi:nth-child/);
  assert.doesNotMatch(rendererCss, /grid-template-columns:\s*repeat\(6,/);
});
