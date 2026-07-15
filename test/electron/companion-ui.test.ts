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
const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
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
  window.eval(uiLogicSrc);
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
  assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /浏览与互动/);
  assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /正在查看第 3 条/);
  const runningSteps = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-step')) as HTMLElement[];
  const runningConnectors = Array.from(w.document.querySelectorAll('#runtime-guidance-flow .rg-flow-connector')) as HTMLElement[];
  assert.equal(runningSteps.length, 3);
  assert.equal(runningConnectors.length, 2);
  assert.ok(runningConnectors[0].classList.contains('flow-active'), '运行态：浏览与互动 → 判断匹配度需要动态推进');
  assert.ok(runningConnectors[1].classList.contains('flow-active'), '运行态：判断匹配度 → 继续寻找灵感需要动态推进');
  assert.equal(runningConnectors[1].dataset.toState, 'next', '第二条连接器显式关联继续寻找灵感阶段');
  assert.equal(hidden($(w, '#runtime-guidance-progress')), false);
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /正在查看第 3 条推荐内容/);
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /3\/150/);
  assert.equal($(w, '#runtime-guidance-progress .rg-progress-track').getAttribute('aria-valuenow'), '3');
  assert.equal(($(w, '#runtime-guidance-progress .rg-progress-fill') as HTMLElement).style.width, '2%');
  assert.equal(w.document.querySelector('#loop'), null, '运行态不保留七段详细步骤');
  assert.equal(w.document.querySelector('.rg-loop-toggle'), null, '运行态不提供查看运行步骤入口');
  assert.match($(w, '#runtime-guidance-mascot').getAttribute('src') ?? '', /mascot-task-execution/);
  assert.match(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-main/);
  assert.match(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-mascot/);
  assert.doesNotMatch(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-mascot\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-main::before/);
  assert.match(rendererCss, /\.rg-progress\s*\{/);
  assert.match(rendererSrc, /browse: '<svg[\s\S]*<path d="M9 9 5 5l1\.8 11\.7/);
  assert.match(rendererSrc, /match: '<svg[\s\S]*<path d="M7 3H5/);
  assert.doesNotMatch(rendererSrc, /browse: '<svg[\s\S]*m4 4 7\.1 17/);
  assert.doesNotMatch(rendererSrc, /match: '<svg[\s\S]*m8\.5 12\.2 2\.2 2\.2 4\.8-5\.1/);
  assert.match(rendererCss, /\.runtime-guidance\[data-mode="running"\] \.rg-flow-step\s*\{\s*--rg-step-color: var\(--rg-step-current\);/);
  assert.match(rendererSrc, /connector\.className = 'rg-flow-connector';/);
  assert.match(rendererCss, /\.rg-flow-connector\.flow-active::before/);
  assert.match(rendererCss, /\.rg-flow-connector\.flow-active::after/);
  assert.match(rendererCss, /@keyframes rg-flow-spark/);
  assert.match(rendererCss, /--rg-step-line-active-start: rgba\(72, 118, 238, 0\.92\);/);
  assert.match(rendererCss, /--rg-step-line-active-end: rgba\(111, 154, 246, 0\.9\);/);
  assert.match(rendererCss, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(36px, \.32fr\)\s*minmax\(0, 1fr\) minmax\(36px, \.32fr\)\s*minmax\(0, 1fr\);/);
  assert.match(rendererCss, /\.rg-flow-step:first-child \{ justify-self: start; \}/);
  assert.match(rendererCss, /\.rg-flow-step:last-child \{ justify-self: end; \}/);
  assert.match(rendererCss, /--rg-step-spark-size: 5px;/);
  assert.match(rendererCss, /\.rg-flow-connector\.flow-active::after\s*\{[\s\S]*top: 6\.5px;[\s\S]*left: 0;/);
  assert.match(rendererCss, /4% \{ left: 0; transform: translateX\(-50%\) scale\(\.82\); opacity: \.9; \}/);
  assert.match(rendererCss, /88% \{ left: 100%; transform: translateX\(-50%\) scale\(\.88\); opacity: \.9; \}/);
  assert.match(rendererCss, /96% \{ left: 100%; transform: translateX\(-50%\) scale\(\.88\); opacity: 0; \}/);
  assert.match(rendererCss, /100% \{ left: 0; transform: translateX\(-50%\) scale\(\.82\); opacity: 0; \}/);
  assert.match(rendererCss, /minmax\(0, 1fr\) minmax\(20px, \.24fr\)/);
  assert.doesNotMatch(rendererCss, /--rg-step-(?:line-width|line-right|spark-right|spark-travel):/);
  assert.doesNotMatch(rendererSrc, /查看运行步骤|收起运行步骤|loopDetailsOpen|renderLoop/);
  assert.doesNotMatch(rendererCss, /rg-loop-toggle|\.loop-step|\.loop-sep/);
});

test('获得感周期刷新原位更新内容，不重建连接器打断圆点行程', async () => {
  const { w, pushStatus } = await boot({
    dailyUsage: {
      totals: { view: 3, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
      quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
    },
  });
  const flow = $(w, '#runtime-guidance-flow');
  const stepsBefore = Array.from(flow.querySelectorAll('.rg-flow-step'));
  const connectorsBefore = Array.from(flow.querySelectorAll('.rg-flow-connector'));

  pushStatus(makeStatus({
    stats: { views: 4, likes: 1, collects: 0, comments: 0, follows: 0, publishes: 0 },
    dailyUsage: {
      totals: { view: 4, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
      quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
    },
  }));

  const stepsAfter = Array.from(flow.querySelectorAll('.rg-flow-step'));
  const connectorsAfter = Array.from(flow.querySelectorAll('.rg-flow-connector'));
  assert.equal(stepsAfter.length, 3);
  assert.equal(connectorsAfter.length, 2);
  assert.strictEqual(stepsAfter[0], stepsBefore[0], '阶段节点应原位更新');
  assert.strictEqual(connectorsAfter[0], connectorsBefore[0], '第一条连接器不得因状态刷新重建');
  assert.strictEqual(connectorsAfter[1], connectorsBefore[1], '第二条连接器不得因状态刷新重建');
  assert.match(flow.textContent ?? '', /正在查看第 4 条/, '原节点仍需刷新实时文案');
  assert.ok(connectorsAfter.every((connector) => connector.classList.contains('flow-active')));
  assert.match(rendererSrc, /const canReuseFlowNodes = existingFlowNodes\.length === expectedFlowNodeCount/);
  assert.match(rendererSrc, /if \(!canReuseFlowNodes\) \{\s*fields\.runtimeGuidanceFlow\.replaceChildren\(\);/);
  assert.match(rendererSrc, /connector\.classList\.toggle\('flow-active', activeFlow \|\| activeDayFlow\);/);
});

test('运行中 + 今日已有浏览累计 → 获得感进度使用账号今日累计，不被当前窗口 0 覆盖', async () => {
  const { w } = await boot({
    dailyUsage: {
      totals: { view: 95, like: 4, collect: 2, comment: 0, follow: 0, publish: 0 },
      quotas: { view: 120, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
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
  assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /正在查看第 95 条/);
  assert.match($(w, '#runtime-guidance-flow').textContent ?? '', /2 条进入候选/);
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /正在查看第 95 条推荐内容/);
  assert.match($(w, '#runtime-guidance-progress').textContent ?? '', /95\/120/);
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
  assert.equal(card.querySelectorAll('button').length, 0, '发布卡 MUST 零按钮');
  assert.match($(w, '#pub-title').textContent ?? '', /秋日城市漫步/);
  assert.match($(w, '#pub-corner').textContent ?? '', /已等 3 分钟/);
  const steps = Array.from(card.querySelectorAll('.j-step'));
  assert.ok((steps[2] as HTMLElement).classList.contains('cur'));
  assert.match($(w, '#pub-foot').textContent ?? '', /稿件预览/);
  assert.ok(!($(w, '#pub-foot').textContent ?? '').includes('再次提醒'), '未收到再提醒事件绝不谎称');
});

test('洗稿稿件预览：发布卡显示查看入口，打开抽屉展示正文/话题/配图且无原稿字段', async () => {
  const draftCalls: unknown[] = [];
  const actionCalls: unknown[] = [];
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
    delegatedTaskDraft: async (_envId: unknown, payload: unknown) => {
      draftCalls.push(payload);
      return delegatedDraftReceipt('approve_candidate');
    },
    delegatedTaskAction: async (...args: unknown[]) => { actionCalls.push(args); return { ok: true, data: { task: { id: TASK_ID } } }; },
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
  assert.equal($(w, '#publish-preview-approve').textContent, '发布');
  assert.equal($(w, '#publish-preview-cancel').textContent, '取消');
  $(w, '#publish-preview-approve').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(draftCalls.length, 1);
  const draft = draftCalls[0] as { action: string; targetConstraints: { candidateId: string; candidateVersion: number } };
  assert.equal(draft.action, 'approve_candidate');
  assert.equal(draft.targetConstraints.candidateId, '89');
  assert.equal(draft.targetConstraints.candidateVersion, 0);
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), false, '生成确认任务后关闭预览');
  assert.equal(($(w, '#delegated-confirm') as unknown as HTMLDialogElement).open, true, '公开写操作必须先展示结构化确认');
  assert.equal(actionCalls.length, 0, '确认前不得批准或下发发布');
  $(w, '#delegated-confirm-submit').dispatchEvent(new w.Event('click'));
  await tick();
  assert.equal(actionCalls.length, 1);
  const actionCall = actionCalls[0] as unknown[];
  assert.equal(actionCall[0], 'u1');
  assert.equal(actionCall[1], TASK_ID);
  assert.equal(actionCall[2], 'confirm');
});

test('洗稿稿件预览：点击取消先生成驳回确认任务，确认前不直接写稿件', async () => {
  const draftCalls: unknown[] = [];
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
    delegatedTaskDraft: async (_envId: unknown, payload: unknown) => { draftCalls.push(payload); return delegatedDraftReceipt('reject_candidate'); },
  });
  $(w, '#pub-preview-link').dispatchEvent(new w.Event('click'));
  assert.ok($(w, '#publish-preview-panel').classList.contains('open'));
  $(w, '#publish-preview-cancel').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(draftCalls.length, 1);
  const draft = draftCalls[0] as { action: string; targetConstraints: { candidateVersion: number } };
  assert.equal(draft.action, 'reject_candidate');
  assert.equal(draft.targetConstraints.candidateVersion, 1);
  assert.equal($(w, '#publish-preview-panel').classList.contains('open'), false);
  assert.equal(($(w, '#delegated-confirm') as unknown as HTMLDialogElement).open, true);
});

test('发布卡已通过 → 第四节点平静色 + 无需操作', async () => {
  const { w } = await boot({ publish: { state: 'approved', title: 't', at: new Date().toISOString() } });
  assert.equal($(w, '#pub-card').dataset.pubState, 'approved');
  const steps = Array.from($(w, '#pub-card').querySelectorAll('.j-step'));
  assert.ok((steps[3] as HTMLElement).classList.contains('cur'));
  assert.ok((steps[3] as HTMLElement).classList.contains('calm'));
  assert.match($(w, '#pub-foot').textContent ?? '', /无需操作/);
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
  assert.equal(card.querySelectorAll('button').length, 0, '空态同样零按钮');
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
  assert.match($(w, '#usage-limit').title ?? '', /点赞：当前节奏、今日计划已完成/);
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
