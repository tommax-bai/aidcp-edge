import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, type DOMWindow } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const fixtureDir = join(here, '../fixtures/wechat-channels-interaction');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
const interactionSrc = readFileSync(join(electronDir, 'renderer/interaction-workspace.js'), 'utf8');
const publishReviewLogicSrc = readFileSync(join(electronDir, 'renderer/publish-review-logic.js'), 'utf8');
const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');
const stylesSrc = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');
const listFixture = JSON.parse(readFileSync(join(fixtureDir, 'interaction-list-response.json'), 'utf8'));
const commentFixture = JSON.parse(readFileSync(join(fixtureDir, 'comment-detail-response.json'), 'utf8'));
const dmFixture = JSON.parse(readFileSync(join(fixtureDir, 'dm-detail-ambiguous-response.json'), 'utf8'));

const openWindows: DOMWindow[] = [];
after(() => openWindows.forEach((window) => window.close()));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await tick();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function status(envKey: string, label: string) {
  return {
    envId: envKey,
    envName: label,
    auth: 'logged in',
    cloud: 'connected',
    session: 'running',
    risk: 'normal',
    edge: 'running',
    stats: { views: 0, likes: 0, collects: 0, comments: 0, follows: 0, publishes: 0 },
    provider: 'adspower',
    lastMessage: '',
    updatedAt: new Date().toISOString(),
    account: { id: `account-${envKey}`, name: label },
    presence: { text: '正在同步视频号互动', at: new Date().toISOString() },
    publish: null,
  };
}

function scopeEnvelope(base: any, envKey: string, label = '示例') {
  const envelope = clone(base);
  envelope.data.envKey = envKey;
  envelope.data.accountId = `account-${envKey}`;
  if (Array.isArray(envelope.data.items)) {
    envelope.data.items.forEach((item: any) => {
      item.participantName = `${label}${item.channel === 'dm' ? '私信用户' : '观众'}`;
    });
  }
  if (envelope.data.thread) {
    envelope.data.thread.envKey = envKey;
    envelope.data.thread.accountId = `account-${envKey}`;
    envelope.data.thread.participant.displayName = `${label}${envelope.data.thread.channel === 'dm' ? '私信用户' : '观众'}`;
  }
  return envelope;
}

function apiResult(envelope: any) {
  return { status: 200, ok: true, data: envelope };
}

function apiError(code: string, message: string, statusCode = 409) {
  return {
    status: statusCode,
    ok: false,
    data: { error: { code, message, requestId: 'test-error', retryable: false } },
  };
}

function jobResult(envKey: string, job: any) {
  return apiResult({
    data: { envKey, accountId: `account-${envKey}`, platform: 'wechat_channels', job: clone(job) },
    meta: { requestId: 'test-job', asOf: Date.now() },
  });
}

interface BootOptions {
  envKey?: string;
  label?: string;
  platform?: string;
  api?: Record<string, any>;
  listPollDelayMs?: number;
}

interface BootHandle {
  window: DOMWindow;
  pushFleet: (snapshot: any) => void;
  pushStatus: (status: any) => void;
  calls: Record<string, any[]>;
}

async function boot(options: BootOptions = {}): Promise<BootHandle> {
  const envKey = options.envKey || 'env_wc_demo';
  const label = options.label || '轻享生活号';
  const platform = options.platform || 'wechat_channels';
  const currentStatus = status(envKey, label);
  const calls: Record<string, any[]> = {
    list: [], detail: [], cancel: [], save: [], approve: [], send: [], regenerate: [], ignore: [], escalate: [],
    sync: [], reset: [], reopen: [], browser: [], readControls: [], notify: [],
  };
  let pushFleet: (snapshot: any) => void = () => undefined;
  let pushStatus: (status: any) => void = () => undefined;
  const defaultApi: Record<string, any> = {
    onStatusUpdate: (callback: (next: any) => void) => { pushStatus = callback; },
    onActivity: () => undefined,
    onFleetUpdate: (callback: (snapshot: any) => void) => { pushFleet = callback; },
    getStatus: async () => currentStatus,
    getSettings: async () => ({
      provider: 'adspower', adsProfileId: envKey, adsProfileName: label, adsApiKey: '', adsApiBase: '',
      environments: [{ profileId: envKey, name: label, platform }], railCollapsed: true, adsDownloadUrl: 'https://example.invalid',
    }),
    saveSettings: async (patch: any) => ({ ...patch, saveOk: true }),
    fleetGet: async () => ({
      provider: 'adspower', selectedEnvId: envKey, railCollapsed: true,
      environments: [{ envId: envKey, kind: 'adspower', profileId: envKey, name: label, platform, status: currentStatus }],
    }),
    fleetSelect: async () => ({}),
    fleetSetRailCollapsed: async () => ({ ok: true }),
    fleetStartAll: async () => ({ ok: true }),
    fleetStopAll: async () => ({ ok: true }),
    pause: async () => currentStatus,
    resume: async () => currentStatus,
    close: async () => currentStatus,
    start: async () => currentStatus,
    restart: async () => currentStatus,
    relogin: async () => currentStatus,
    getStatusForEnv: async () => currentStatus,
    clientSession: async () => ({ enabled: true, name: 'fixture-user' }),
    adsStatus: async () => ({ ok: false, error: 'fixture' }),
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    adsTemplates: async () => [],
    interactionList: async (args: any) => {
      calls.list.push(args);
      const envelope = scopeEnvelope(listFixture, args.envKey, args.envKey === envKey ? '示例' : args.envKey);
      envelope.data.items = envelope.data.items.filter((item: any) => {
        if (args.channel && item.channel !== args.channel) return false;
        if (args.state === 'sent') return item.jobState === 'sent';
        if (args.state === 'pending') return !['sent', 'ignored', 'escalated'].includes(item.jobState);
        return true;
      });
      return apiResult(envelope);
    },
    interactionDetail: async (args: any) => {
      calls.detail.push(args);
      return apiResult(scopeEnvelope(args.threadId.includes('_dm_') ? dmFixture : commentFixture, args.envKey, '示例'));
    },
    interactionUpdateDraft: async (args: any) => {
      calls.save.push(args);
      const detail = scopeEnvelope(commentFixture, args.envKey).data;
      detail.replyJob.finalText = args.finalText;
      detail.replyJob.version = args.expectedVersion + 1;
      return jobResult(args.envKey, detail.replyJob);
    },
    interactionApprove: async (args: any) => {
      calls.approve.push(args);
      const job = scopeEnvelope(commentFixture, args.envKey).data.replyJob;
      job.state = 'approved';
      job.version = args.expectedVersion + 1;
      return jobResult(args.envKey, job);
    },
    interactionSend: async (args: any) => {
      calls.send.push(args);
      const job = scopeEnvelope(commentFixture, args.envKey).data.replyJob;
      job.state = 'queued';
      job.version = args.expectedVersion + 1;
      return jobResult(args.envKey, job);
    },
    interactionRegenerate: async (args: any) => {
      calls.regenerate.push(args);
      return jobResult(args.envKey, scopeEnvelope(commentFixture, args.envKey).data.replyJob);
    },
    interactionIgnore: async (args: any) => {
      calls.ignore.push(args);
      return jobResult(args.envKey, { ...scopeEnvelope(commentFixture, args.envKey).data.replyJob, state: 'ignored', version: args.expectedVersion + 1 });
    },
    interactionEscalate: async (args: any) => {
      calls.escalate.push(args);
      return jobResult(args.envKey, { ...scopeEnvelope(commentFixture, args.envKey).data.replyJob, state: 'escalated', version: args.expectedVersion + 1 });
    },
    interactionSync: async (args: any) => {
      calls.sync.push(args);
      return apiResult({ data: { envKey: args.envKey, accountId: `account-${args.envKey}`, acceptedAt: Date.now() }, meta: { requestId: 'sync', asOf: Date.now() } });
    },
    interactionTestReset: async (args: any) => {
      calls.reset.push(args);
      return apiResult({
        data: { envKey: args.envKey, accountId: `account-${args.envKey}`, channel: args.channel,
          action: 'test_reset', actionRequestId: `reset-${args.channel}`, status: 'accepted',
          deleted: { threads: 1, syncBatches: 1, syncCursors: 1 } },
        meta: { requestId: 'test-reset', asOf: Date.now() },
      });
    },
    interactionReopenAuth: async (args: any) => {
      calls.reopen.push(args);
      return apiResult({ data: { envKey: args.envKey, accountId: `account-${args.envKey}`, acceptedAt: Date.now() }, meta: { requestId: 'reopen', asOf: Date.now() } });
    },
    interactionOpenLocalBrowser: async (args: any) => {
      calls.browser.push(args);
      return { status: 200, ok: true, data: { envKey: args.envKey, opened: true } };
    },
    interactionUpdateReadControls: async (args: any) => {
      calls.readControls.push(args);
      const auth = clone(listFixture.data.auth);
      auth.runtimeControls.storedVersion = args.expectedVersion + 1;
      auth.runtimeControls.applicationStatus = 'pending';
      auth.runtimeControls.stored.commentsReadEnabled = args.commentsReadEnabled;
      auth.runtimeControls.stored.dmReadEnabled = args.dmReadEnabled;
      return apiResult({
        data: {
          envKey: args.envKey,
          accountId: `account-${args.envKey}`,
          platform: 'wechat_channels',
          auth,
          replyConfig: clone(listFixture.data.replyConfig),
          edgeDelivery: { status: 'enqueued', delivered: 1 },
        },
        meta: { requestId: 'read-controls', asOf: Date.now() },
      });
    },
    interactionNotify: async (args: any) => { calls.notify.push(args); return { ok: true }; },
    interactionCancelReads: async (key: string) => { calls.cancel.push(key); return { ok: true, cancelled: 1 }; },
  };
  const api = { ...defaultApi, ...(options.api || {}) };
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://fixture.local/' });
  const { window } = dom;
  if (options.listPollDelayMs !== undefined) {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: any[]) =>
      nativeSetTimeout(handler, delay === 3_000 || delay === 15_000 ? options.listPollDelayMs : delay, ...args)) as typeof window.setTimeout;
  }
  openWindows.push(window);
  (window as any).aidcpEdge = api;
  window.eval(uiLogicSrc);
  window.eval(interactionSrc);
  window.eval(publishReviewLogicSrc);
  window.eval(rendererSrc);
  await flush();
  return { window, pushFleet, pushStatus, calls };
}

const $ = (window: DOMWindow, selector: string) => window.document.querySelector(selector) as HTMLElement;
const hidden = (element: HTMLElement) => element.classList.contains('hidden');

// 收件箱不再默认选中任何一条；详情数据要经客户显式点击后才加载。
// 凡是断言详情内容的用例都得先经这里点一下 —— 这正是客户实际的操作路径。
async function openThread(window: DOMWindow, threadId?: string): Promise<HTMLElement> {
  const item = $(window, threadId ? `[data-thread-id="${threadId}"]` : '.iw-list-item');
  assert.ok(item, `列表里应有可点开的互动：${threadId ?? '第一条'}`);
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  return item;
}

test('XHS / Facebook 保留原 workspace；视频号只替换右侧且不占左侧环境栏', async () => {
  for (const platform of ['xiaohongshu', 'facebook']) {
    const { window } = await boot({ platform, envKey: `env-${platform}` });
    assert.equal(hidden($(window, '#legacy-workspace')), false, `${platform} 应保留原工作区`);
    assert.equal(hidden($(window, '#interaction-workspace')), true, `${platform} 不应显示视频号工作区`);
  }

  const { window } = await boot();
  assert.equal(hidden($(window, '#legacy-workspace')), true);
  assert.equal(hidden($(window, '#interaction-workspace')), false);
  assert.ok($(window, '#env-rail'), '左侧环境栏仍存在');
  assert.equal($(window, '#interaction-workspace').contains($(window, '#env-rail')), false, '互动工作区不能吞掉左栏');
  assert.match($(window, '#acct-name').textContent || '', /轻享生活号/);
  assert.equal($(window, '#acct-plat').textContent, '视频号');
  assert.match($(window, '#iw-title').textContent || '', /已绑定：示例视频号/);
  assert.equal($(window, '#iw-engine-status').textContent, '引擎：已连接');
  assert.equal($(window, '#iw-auth-status').textContent, '视频号：鉴权通过');
  assert.match($(window, '#iw-browser').textContent || '', /自动化浏览器：后台模式/);
  assert.match($(window, '#iw-list').textContent || '', /示例观众/);
  await openThread(window);
  assert.match($(window, '#iw-detail').textContent || '', /模板 template_comment_thanks · v1/);
  assert.match($(window, '#iw-detail').textContent || '', /配置版本 1/);
});

test('820x720 单列互动布局使用主列整体滚动，不再把详情裁在固定高度之外', () => {
  assert.match(stylesSrc, /\.shell\.interaction-mode[\s\S]*min-height:\s*calc\(100vh - 46px\);[\s\S]*overflow:\s*visible;/);
  assert.match(stylesSrc, /\.interaction-workspace[\s\S]*min-height:\s*calc\(100vh - 70px\);/);
  assert.match(stylesSrc, /@container \(max-width: 640px\)[\s\S]*\.iw-inbox \{ display: flex; flex: none; flex-direction: column; overflow: visible; \}/);
  assert.doesNotMatch(stylesSrc, /\.shell\.interaction-mode[\s\S]{0,260}\n\s*height:\s*calc\(100vh - 46px\);/);
});

test('窄 viewport 不覆盖 workspace 容器断点，仍放得下双栏时列表不被拉成通栏', () => {
  assert.match(stylesSrc, /@container \(max-width: 640px\)[\s\S]*\.iw-inbox \{ display: flex; flex: none; flex-direction: column; overflow: visible; \}/);
  assert.match(stylesSrc, /@supports not \(container-type: inline-size\) \{\s*@media \(max-width: 700px\) \{[\s\S]*\.iw-inbox \{ display: flex; flex: none; flex-direction: column; overflow: visible; \}/);
  assert.doesNotMatch(stylesSrc, /\n@media \(max-width: 700px\) \{\s*\.iw-inbox/);
});

test('视频号互动使用 profileId 作为 Cloud envKey，不混用本机 ads- 环境行 ID', async () => {
  const lifecycleCalls: string[] = [];
  const { window, pushFleet, calls } = await boot({
    api: {
      pause: async (runtimeEnvId: string) => {
        lifecycleCalls.push(runtimeEnvId);
        return { ...status(runtimeEnvId, '视频号环境'), session: 'paused' };
      },
    },
  });
  pushFleet({
    provider: 'adspower', selectedEnvId: 'ads-k1eoujd8', railCollapsed: true,
    environments: [{
      envId: 'ads-k1eoujd8', profileId: 'k1eoujd8', kind: 'adspower', name: '视频号环境', platform: 'wechat_channels',
      status: { ...status('ads-k1eoujd8', '视频号环境'), account: { id: 'k1eoujd8', name: '', source: 'env' } },
    }],
  });
  await flush();

  assert.equal(calls.list.at(-1).envKey, 'k1eoujd8');
  assert.notEqual(calls.list.at(-1).envKey, 'ads-k1eoujd8');

  $(window, '#iw-lifecycle').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.deepEqual(lifecycleCalls, ['ads-k1eoujd8'], '本机生命周期动作仍必须路由 runtime envId');
  // 只断言发送侧参数不足以钉住这条链路：作用域守卫拿本机口径的回包去比云端 envKey 时会抛，
  // 异常被 catch 吞成失败提示，发送侧断言照样绿。必须一并断言用户看到的结论。
  assert.equal($(window, '#iw-sync-status')?.textContent, '已请求暂停当前环境。',
    '动作已真执行，MUST NOT 谎报失败');
});

test('缺少本机运行时标识时拒绝生命周期动作，绝不回落成 envKey 打到别的环境', async () => {
  const lifecycleCalls: string[] = [];
  const { window, pushFleet } = await boot({
    api: {
      pause: async (runtimeEnvId: string) => {
        lifecycleCalls.push(runtimeEnvId);
        return { ...status(runtimeEnvId, '视频号环境'), session: 'paused' };
      },
    },
  });
  // envId 缺失 → workspace 拿不到本机运行时标识。回落成 envKey 会让主进程查表落空、
  // 静默改对当前选中的另一个环境执行动作，故必须诚实拒绝。
  pushFleet({
    provider: 'adspower', selectedEnvId: '', railCollapsed: true,
    environments: [{
      envId: '', profileId: 'k1eoujd8', kind: 'adspower', name: '视频号环境', platform: 'wechat_channels',
      status: { ...status('', '视频号环境'), account: { id: 'k1eoujd8', name: '', source: 'env' } },
    }],
  });
  await flush();

  $(window, '#iw-lifecycle').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.deepEqual(lifecycleCalls, [], '标识缺失 MUST NOT 向本机通道发出请求');
});

test('本地打开浏览器不依赖引擎在线或视频号鉴权，也不冒充鉴权成功', async () => {
  const browserCalls: any[] = [];
  const browserList = clone(listFixture);
  browserList.data.auth.status = 'login_required';
  browserList.data.auth.browserState = 'unavailable';
  const current = await boot({
    api: {
      interactionList: async (args: any) => apiResult(scopeEnvelope(browserList, args.envKey)),
      interactionOpenLocalBrowser: async (args: any) => {
        browserCalls.push(args);
        return { status: 200, ok: true, data: { envKey: args.envKey, opened: true } };
      },
    },
  });
  const stopped = status('env_wc_demo', '轻享生活号');
  stopped.edge = 'stopped';
  stopped.cloud = 'disconnected';
  stopped.session = 'closed';
  current.pushFleet({
    provider: 'adspower', selectedEnvId: 'env_wc_demo', railCollapsed: true,
    environments: [{
      envId: 'env_wc_demo', kind: 'adspower', profileId: 'env_wc_demo', name: '轻享生活号',
      platform: 'wechat_channels', status: stopped,
    }],
  });
  await flush();

  const control = $(current.window, '#iw-browser-control') as HTMLButtonElement;
  assert.equal(hidden(control), false);
  assert.equal(control.disabled, false);
  assert.equal($(current.window, '#iw-engine-status').textContent, '引擎：未启动');
  assert.equal($(current.window, '#iw-auth-status').textContent, '视频号：等待登录');
  assert.equal($(current.window, '#iw-browser').textContent, '自动化浏览器：暂不可用');

  control.dispatchEvent(new current.window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(browserCalls.length, 1);
  assert.equal(browserCalls[0].envKey, 'env_wc_demo');
  assert.deepEqual(Object.keys(browserCalls[0]), ['envKey'], 'renderer 只能提交 envKey，不能传 URL/profile/token');
  assert.match($(current.window, '#iw-browser-help').textContent || '', /本地浏览器已打开/);
  assert.match($(current.window, '#iw-browser-help').textContent || '', /未改变引擎状态/);
  assert.equal($(current.window, '#iw-engine-status').textContent, '引擎：未启动', '打开浏览器不得启动引擎');
  assert.equal($(current.window, '#iw-auth-status').textContent, '视频号：等待登录', '打开浏览器不得冒充鉴权成功');
  assert.equal(control.textContent, '打开浏览器', '人工查看只提供打开，不把按钮改成引擎侧关闭动作');
});

test('视频号工作区按 XHS 状态矩阵显示恢复与暂停态关闭，并只路由当前 envKey', async () => {
  const lifecycleCalls: Array<[string, string]> = [];
  let startAllCalls = 0;
  let stopAllCalls = 0;
  let settingsSaveCalls = 0;
  const lifecycleStatus = (envKey: string, edge: string, session: string) => ({
    ...status(envKey, '轻享生活号'), edge, session,
  });
  const { window, pushFleet } = await boot({
    api: {
      fleetStartAll: async () => { startAllCalls += 1; return { ok: true }; },
      fleetStopAll: async () => { stopAllCalls += 1; return { ok: true }; },
      saveSettings: async (patch: any) => { settingsSaveCalls += 1; return { ...patch, saveOk: true }; },
      start: async (envKey: string) => {
        lifecycleCalls.push(['start', envKey]);
        return lifecycleStatus(envKey, 'starting', 'running');
      },
      pause: async (envKey: string) => {
        lifecycleCalls.push(['pause', envKey]);
        return lifecycleStatus(envKey, 'running', 'paused');
      },
      resume: async (envKey: string) => {
        lifecycleCalls.push(['resume', envKey]);
        return lifecycleStatus(envKey, 'running', 'running');
      },
      close: async (envKey: string) => {
        lifecycleCalls.push(['close', envKey]);
        return lifecycleStatus(envKey, 'stopped', 'closed');
      },
    },
  });
  const lifecycle = $(window, '#iw-lifecycle') as HTMLButtonElement;
  const close = $(window, '#iw-close') as HTMLButtonElement;
  const stopped = lifecycleStatus('env_wc_demo', 'stopped', 'closed');
  pushFleet({
    provider: 'adspower', selectedEnvId: 'env_wc_demo', railCollapsed: true,
    environments: [{ envId: 'env_wc_demo', name: '轻享生活号', platform: 'wechat_channels', status: stopped }],
  });
  await flush();

  assert.equal(hidden(lifecycle), false, '视频号右侧工作区必须直接露出生命周期入口');
  assert.equal(lifecycle.textContent, '启动');
  assert.equal(hidden(close), true, '未暂停时不显示关闭');
  close.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.deepEqual(lifecycleCalls, [], '非暂停态即使被程序化触发也不得关闭');
  lifecycle.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.deepEqual(lifecycleCalls, [['start', 'env_wc_demo']]);
  assert.equal(lifecycle.textContent, '暂停', 'starting 状态继续允许用户暂停');

  lifecycle.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.deepEqual(lifecycleCalls, [['start', 'env_wc_demo'], ['pause', 'env_wc_demo']]);
  assert.equal(lifecycle.textContent, '恢复');
  assert.equal(hidden(close), false, '暂停后同时显示恢复与关闭');

  close.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.deepEqual(lifecycleCalls, [
    ['start', 'env_wc_demo'], ['pause', 'env_wc_demo'], ['close', 'env_wc_demo'],
  ]);
  assert.equal(lifecycle.textContent, '启动', '关闭回传真态后回到启动');
  assert.equal(hidden(close), true);

  pushFleet({
    provider: 'adspower', selectedEnvId: 'env_wc_demo', railCollapsed: true,
    environments: [{ envId: 'env_wc_demo', name: '轻享生活号', platform: 'wechat_channels', status: lifecycleStatus('env_wc_demo', 'stopped', 'paused') }],
  });
  await flush();
  assert.equal(lifecycle.textContent, '恢复', 'paused 优先级与 XHS 一致，即使 edge 已停止仍可恢复或关闭');
  assert.equal(hidden(close), false);
  lifecycle.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.deepEqual(lifecycleCalls.at(-1), ['resume', 'env_wc_demo']);
  assert.equal(lifecycle.textContent, '暂停');
  assert.equal(startAllCalls, 0, '单环境入口不得退化成全部启动');
  assert.equal(stopAllCalls, 0, '单环境关闭不得退化成全部停止');
  assert.equal(settingsSaveCalls, 1, '视频号启动必须复用先保存设置再启动的单环境链路');
});

test('开发者详情开关在视频号工作区仍展示当前环境日志', async () => {
  const saved: any[] = [];
  const { window, pushStatus } = await boot({
    api: { saveSettings: async (patch: any) => { saved.push(patch); return { ...patch, saveOk: true }; } },
  });
  const dev = $(window, '#dev-section');
  const toggle = $(window, '#dev-toggle') as HTMLInputElement;
  assert.equal(hidden(dev), true, '默认隐藏语义不变');
  assert.equal($(window, '#legacy-workspace').contains(dev), false, '开发者详情不能被 legacy workspace 的显隐吞掉');

  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  pushStatus({ ...status('env_wc_demo', '轻享生活号'), lastMessage: '视频号当前环境日志' });
  await flush();

  assert.equal(hidden($(window, '#interaction-workspace')), false);
  assert.equal(hidden(dev), false, '视频号工作区与开发者详情应同时可见');
  assert.match($(window, '#last-message').textContent || '', /视频号当前环境日志/);
  assert.ok(saved.some((patch) => patch.devDetails === true), '开发者详情开关继续持久化');
});

test('首次授权、错号恢复和账号开关待应用都有明确且 fail-closed 的引导', async () => {
  const loginList = clone(listFixture);
  loginList.data.items = [];
  loginList.data.auth.status = 'login_required';
  loginList.data.auth.identity = null;
  loginList.data.auth.runtimeControls.edgeAppliedVersion = null;
  loginList.data.auth.runtimeControls.applicationStatus = 'pending';
  const first = await boot({
    label: '春日手作号',
    api: { interactionList: async () => apiResult(loginList) },
  });
  assert.match($(first.window, '#iw-title').textContent || '', /等待首次登录/);
  assert.match($(first.window, '#iw-summary').textContent || '', /春日手作号/);
  assert.match($(first.window, '#iw-summary').textContent || '', /无需填写内部账号 ID/);
  assert.equal($(first.window, '#iw-auth-status').textContent, '视频号：等待登录');
  assert.equal(hidden($(first.window, '#iw-reauth')), false);

  const mismatchList = clone(listFixture);
  const mismatchDetail = clone(commentFixture);
  for (const fixture of [mismatchList, mismatchDetail]) {
    fixture.data.auth.status = 'reauth_required';
    fixture.data.auth.reasonCode = 'WECHAT_IDENTITY_MISMATCH';
  }
  const mismatch = await boot({
    api: {
      interactionList: async () => apiResult(mismatchList),
      interactionDetail: async () => apiResult(mismatchDetail),
    },
  });
  assert.match($(mismatch.window, '#iw-title').textContent || '', /另一个视频号/);
  assert.match($(mismatch.window, '#iw-summary').textContent || '', /示例视频号/);
  assert.match($(mismatch.window, '#iw-summary').textContent || '', /历史内容仍可查看/);
  assert.equal($(mismatch.window, '#iw-auth-status').textContent, '视频号：账号不匹配');
  await openThread(mismatch.window);
  assert.equal((mismatch.window.document.querySelector('[data-iw-action="approve"]') as HTMLButtonElement).disabled, true);

  const pendingList = clone(listFixture);
  const pendingDetail = clone(commentFixture);
  for (const fixture of [pendingList, pendingDetail]) {
    fixture.data.auth.runtimeControls.storedVersion = 8;
    fixture.data.auth.runtimeControls.edgeAppliedVersion = 7;
    fixture.data.auth.runtimeControls.applicationStatus = 'pending';
  }
  const pending = await boot({
    api: {
      interactionList: async () => apiResult(pendingList),
      interactionDetail: async () => apiResult(pendingDetail),
    },
  });
  assert.match($(pending.window, '#iw-title').textContent || '', /互动收取尚未生效/);
  assert.match($(pending.window, '#iw-read-apply').textContent || '', /Cloud 已保存 v8，等待本机应用/);
  await openThread(pending.window);
  assert.match($(pending.window, '#iw-detail').textContent || '', /尚未回报应用同一版本/);
  assert.equal((pending.window.document.querySelector('[data-iw-action="approve"]') as HTMLButtonElement).disabled, true);
});

test('tabs / 搜索 / 空态 / 错态 / ambiguous 都使用冻结 fixture 的诚实状态', async () => {
  const { window } = await boot();
  const search = $(window, '#iw-search') as HTMLInputElement;
  search.value = '不存在的昵称';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match($(window, '#iw-list').textContent || '', /当前已加载内容中没有匹配项/);

  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  $(window, '[data-interaction-tab="replied"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.match($(window, '#iw-list').textContent || '', /当前没有已确认回复记录/);

  $(window, '[data-interaction-tab="dm"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  await openThread(window);
  assert.match($(window, '#iw-detail').textContent || '', /平台结果待核验/);
  assert.match($(window, '#iw-detail').textContent || '', /不会自动重复发送/);
  assert.doesNotMatch($(window, '#iw-detail').textContent || '', /平台已确认发送/);

  const errorBoot = await boot({
    api: { interactionList: async () => apiError('INTERACTION_UPSTREAM_UNAVAILABLE', 'offline', 503) },
  });
  assert.match($(errorBoot.window, '#iw-list-error').textContent || '', /Cloud 暂时不可达/);
  assert.match($(errorBoot.window, '#iw-list').textContent || '', /收取状态待确认/);
  assert.match($(errorBoot.window, '#iw-list').textContent || '', /不能据此判断是否没有互动/);
});

test('meta.asOf 只表示 API 快照；缺失或非法 syncFreshness 均按未知失败关闭', async () => {
  const legacyList = clone(listFixture);
  const legacyDetail = clone(commentFixture);
  delete legacyList.data.syncFreshness;
  delete legacyDetail.data.syncFreshness;
  legacyList.meta.asOf = Date.now();
  legacyDetail.meta.asOf = Date.now();
  const legacy = await boot({
    api: {
      interactionList: async () => apiResult(legacyList),
      interactionDetail: async () => apiResult(legacyDetail),
    },
  });
  assert.match($(legacy.window, '#iw-title').textContent || '', /等待首次成功同步/);
  assert.match($(legacy.window, '#iw-sync-status').textContent || '', /同步状态待确认/);
  assert.match($(legacy.window, '#iw-as-of').textContent || '', /同步时间待确认/);
  assert.doesNotMatch($(legacy.window, '#iw-as-of').textContent || '', /数据时间/);
  assert.doesNotMatch($(legacy.window, '#iw-sync-status').textContent || '', /同步正常/);
  await openThread(legacy.window);
  assert.match($(legacy.window, '#iw-detail').textContent || '', /最近同步 同步时间待确认/);

  const invalidList = clone(listFixture);
  const invalidDetail = clone(commentFixture);
  invalidList.data.syncFreshness.comment = { observedAt: Date.now() };
  invalidDetail.data.syncFreshness.comment = { observedAt: Date.now() };
  const invalid = await boot({
    api: {
      interactionList: async () => apiResult(invalidList),
      interactionDetail: async () => apiResult(invalidDetail),
    },
  });
  assert.match($(invalid.window, '#iw-sync-status').textContent || '', /同步状态待确认/);
  assert.match($(invalid.window, '#iw-as-of').textContent || '', /同步时间待确认/);
});

test('分渠道证据决定真实空态，一个渠道成功不能替另一个渠道背书', async () => {
  const oneChannelList = clone(listFixture);
  const oneChannelComment = clone(commentFixture);
  const oneChannelDm = clone(dmFixture);
  for (const fixture of [oneChannelList, oneChannelComment, oneChannelDm]) {
    fixture.data.syncFreshness.dm = null;
  }
  const { window } = await boot({
    api: {
      interactionList: async (args: any) => {
        const envelope = scopeEnvelope(oneChannelList, args.envKey);
        envelope.data.items = args.channel ? [] : envelope.data.items;
        return apiResult(envelope);
      },
      interactionDetail: async (args: any) => apiResult(scopeEnvelope(
        args.threadId.includes('_dm_') ? oneChannelDm : oneChannelComment,
        args.envKey,
      )),
    },
  });
  assert.match($(window, '#iw-sync-status').textContent || '', /私信尚未成功同步/);

  $(window, '[data-interaction-tab="dm"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.match($(window, '#iw-list').textContent || '', /私信尚未成功同步/);
  assert.doesNotMatch($(window, '#iw-list').textContent || '', /当前没有私信会话/);

  $(window, '[data-interaction-tab="comment"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.match($(window, '#iw-list').textContent || '', /当前没有评论互动/);
});

test('页面刷新不洗新历史同步时间，明显未来的设备时间显示校准警告', async () => {
  const observedAt = Date.now() - 2 * 60_000;
  const historicalList = clone(listFixture);
  const historicalDetail = clone(commentFixture);
  for (const fixture of [historicalList, historicalDetail]) {
    fixture.meta.asOf = Date.now();
    fixture.data.syncFreshness.comment = { observedAt, receivedAt: observedAt + 100 };
    fixture.data.syncFreshness.dm = { observedAt, receivedAt: observedAt + 100 };
  }
  const historical = await boot({
    api: {
      interactionList: async () => apiResult(historicalList),
      interactionDetail: async () => apiResult(historicalDetail),
    },
  });
  assert.match($(historical.window, '#iw-as-of').textContent || '', /2 分钟前/);
  assert.doesNotMatch($(historical.window, '#iw-as-of').textContent || '', /数据时间/);

  const receivedAt = Date.now();
  const skewedList = clone(listFixture);
  const skewedDetail = clone(commentFixture);
  for (const fixture of [skewedList, skewedDetail]) {
    fixture.data.syncFreshness.comment = { observedAt: receivedAt + 6 * 60_000, receivedAt };
    fixture.data.syncFreshness.dm = { observedAt: receivedAt + 6 * 60_000, receivedAt };
  }
  const skewed = await boot({
    api: {
      interactionList: async () => apiResult(skewedList),
      interactionDetail: async () => apiResult(skewedDetail),
    },
  });
  assert.match($(skewed.window, '#iw-sync-status').textContent || '', /设备时间待校准/);
  assert.match($(skewed.window, '#iw-as-of').textContent || '', /Cloud .*收到/);
});

test('同环境迟到的旧详情响应不会让已读回的同步证据倒退', async () => {
  const current = Date.now() - 2 * 60_000;
  const older = current - 8 * 60_000;
  const newestList = clone(listFixture);
  const staleDetail = clone(commentFixture);
  for (const channel of ['comment', 'dm']) {
    newestList.data.syncFreshness[channel] = { observedAt: current, receivedAt: current + 100 };
    staleDetail.data.syncFreshness[channel] = { observedAt: older, receivedAt: older + 100 };
  }
  const { window } = await boot({
    api: {
      interactionList: async () => apiResult(newestList),
      interactionDetail: async () => apiResult(staleDetail),
    },
  });
  assert.match($(window, '#iw-as-of').textContent || '', /2 分钟前/);
});

test('局部刷新 accepted 不冒充完成，只有目标渠道 receivedAt 推进才确认成功', async () => {
  let observedAt = Date.now() - 60_000;
  let receivedAt = observedAt + 100;
  const response = (base: any, envKey: string, channel?: string) => {
    const envelope = scopeEnvelope(base, envKey);
    envelope.data.syncFreshness.comment = { observedAt, receivedAt };
    envelope.data.syncFreshness.dm = { observedAt, receivedAt };
    if (channel) envelope.data.items = [];
    return envelope;
  };
  const { window } = await boot({
    api: {
      interactionList: async (args: any) => apiResult(response(listFixture, args.envKey, args.channel)),
      interactionDetail: async (args: any) => apiResult(response(commentFixture, args.envKey)),
    },
  });
  $(window, '[data-interaction-tab="comment"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  $(window, '#iw-sync').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 850));
  await flush();
  assert.match($(window, '#iw-sync-status').textContent || '', /已受理，尚未确认同步完成/);

  observedAt += 5_000;
  receivedAt += 5_000;
  $(window, '#iw-sync').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 850));
  await flush();
  assert.match($(window, '#iw-sync-status').textContent || '', /本次同步已有成功结果/);
  assert.match($(window, '#iw-list').textContent || '', /当前没有评论互动/);
});

test('页面提供总开关、评论和私信收取开关，只提交读取字段并显示存储/应用/有效状态', async () => {
  const { window, calls } = await boot();
  const all = $(window, '#iw-read-all') as HTMLInputElement;
  const comment = $(window, '#iw-read-comment') as HTMLInputElement;
  const dm = $(window, '#iw-read-dm') as HTMLInputElement;
  assert.equal(all.checked, true);
  assert.equal(comment.checked, true);
  assert.equal(dm.checked, true);
  assert.match($(window, '#iw-read-comment-status').textContent || '', /正在收取/);
  assert.match($(window, '#iw-read-dm-status').textContent || '', /正在收取/);
  assert.match($(window, '#iw-read-apply').textContent || '', /Cloud 已保存 v7，本机已应用同一版本/);

  comment.checked = false;
  comment.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(clone(calls.readControls), [{
    envKey: 'env_wc_demo', expectedVersion: 7, commentsReadEnabled: false, dmReadEnabled: true,
  }]);
  assert.deepEqual(Object.keys(calls.readControls[0]).sort(), ['commentsReadEnabled', 'dmReadEnabled', 'envKey', 'expectedVersion']);
  assert.equal((window.document.querySelector('#iw-read-comment') as HTMLInputElement).checked, false);
  assert.match($(window, '#iw-read-comment-status').textContent || '', /已关闭/);
  assert.match($(window, '#iw-read-dm-status').textContent || '', /等待本机应用/);

  const conflict = await boot({
    api: { interactionUpdateReadControls: async () => apiError('INTERACTION_VERSION_CONFLICT', 'version conflict') },
  });
  const conflictDm = $(conflict.window, '#iw-read-dm') as HTMLInputElement;
  conflictDm.checked = false;
  conflictDm.dispatchEvent(new conflict.window.Event('change', { bubbles: true }));
  await flush();
  assert.match($(conflict.window, '#iw-read-error').textContent || '', /已在别处更新/);
  assert.equal((conflict.window.document.querySelector('#iw-read-dm') as HTMLInputElement).checked, true, '冲突后恢复服务端已知值');
});

test('读取开关待本机应用时继续轮询，应用成功后自动恢复有效状态', async () => {
  let listCount = 0;
  const current = await boot({
    listPollDelayMs: 10,
    api: {
      interactionList: async () => {
        listCount += 1;
        const envelope = clone(listFixture);
        if (listCount === 1) {
          envelope.data.auth.runtimeControls.storedVersion = 8;
          envelope.data.auth.runtimeControls.edgeAppliedVersion = 7;
          envelope.data.auth.runtimeControls.applicationStatus = 'pending';
        }
        return apiResult(envelope);
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await flush();
  assert.ok(listCount >= 2, '待应用状态必须继续获取 Cloud 投影，不能陷入停止轮询');
  assert.match($(current.window, '#iw-read-apply').textContent || '', /本机已应用同一版本/);
  assert.match($(current.window, '#iw-read-comment-status').textContent || '', /正在收取/);
  current.window.close();
});

// wechat-read-controls-offline-toggle：环境未启动（核心子进程离线）时读取开关必须仍可编辑。
// 这条写入经主进程直发 Cloud HTTP，不经过该环境核心子进程；Cloud 无 Edge 在线时按 CAS 落库并回
// edgeDelivery.status='deferred'，下次 hello 由欢迎信封快照收敛。渲染层曾用 connectivity 把它拦下 = 假阻断。
//
// ⚠️ 复现只能用「已停止 / 从未启动」的环境（connectivity !== 'connected'）。冷待机（浏览器关、核心仍在线）
// 的 cloud 仍是 'connected'，开关本就可编辑——用应用内「关闭浏览器」按钮去试会看到一切正常、误判成复现不了。

// deferred / enqueued 两种投递回包：auth 一律回 applicationStatus='pending'（离线保存结构上不可能报 applied）。
function readDeliveryApi(deliveryStatus: 'enqueued' | 'deferred') {
  return {
    interactionUpdateReadControls: async (args: any) => {
      const auth = clone(listFixture.data.auth);
      auth.runtimeControls.storedVersion = args.expectedVersion + 1;
      auth.runtimeControls.applicationStatus = 'pending';
      auth.runtimeControls.stored.commentsReadEnabled = args.commentsReadEnabled;
      auth.runtimeControls.stored.dmReadEnabled = args.dmReadEnabled;
      return apiResult({
        data: {
          envKey: args.envKey, accountId: `account-${args.envKey}`, platform: 'wechat_channels',
          auth, replyConfig: clone(listFixture.data.replyConfig),
          edgeDelivery: { status: deliveryStatus, delivered: deliveryStatus === 'enqueued' ? 1 : 0 },
        },
        meta: { requestId: 'read-controls', asOf: Date.now() },
      });
    },
  };
}

// 从一个连着的环境 boot（走通首屏），再切到一个已停止的环境：切到不同 envKey 会走
// freshState + loadList 路径（stale 先真、被一次成功 loadList 无条件清掉），正是客户从环境栏点选停止号的真实时序。
async function bootThenSelectStoppedEnv(apiOverride: Record<string, any> = {}): Promise<BootHandle> {
  const handle = await boot({ envKey: 'env_connected', label: '在线号', api: apiOverride });
  const stopped = status('env_stopped', '停止号');
  stopped.cloud = 'disconnected';
  stopped.edge = 'stopped';
  stopped.session = 'stopped';
  handle.pushFleet({
    provider: 'adspower', selectedEnvId: 'env_stopped', railCollapsed: true,
    environments: [
      { envId: 'env_connected', kind: 'adspower', profileId: 'env_connected', name: '在线号', platform: 'wechat_channels', status: status('env_connected', '在线号') },
      { envId: 'env_stopped', kind: 'adspower', profileId: 'env_stopped', name: '停止号', platform: 'wechat_channels', status: stopped },
    ],
  });
  await flush();
  return handle;
}

test('环境已停止（connectivity 非 connected）读取开关仍可编辑并真的携 expectedVersion 写入 Cloud', async () => {
  const { window, calls } = await bootThenSelectStoppedEnv();
  const all = $(window, '#iw-read-all') as HTMLInputElement;
  const comment = $(window, '#iw-read-comment') as HTMLInputElement;
  const dm = $(window, '#iw-read-dm') as HTMLInputElement;
  // ⑥ 钉死决策 3 的暗路：停止态环境在一次成功 loadList 之后 stale===false、开关可编辑。
  // 若哪天 loadList 成功不再无条件清 stale，这三条断言会当场红，而不是让开关悄悄变回灰的。
  assert.equal(all.disabled, false, '停止态环境总开关必须可编辑（stale 已被成功 loadList 清掉）');
  assert.equal(comment.disabled, false, '停止态环境评论开关必须可编辑');
  assert.equal(dm.disabled, false, '停止态环境私信开关必须可编辑');

  comment.checked = false;
  comment.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(calls.readControls.length, 1, '① 切换必须真的发出 read-controls 请求，MUST NOT 被本地拦下');
  assert.equal(calls.readControls[0].envKey, 'env_stopped');
  assert.equal(calls.readControls[0].expectedVersion, 7, '必须携 stored 的 expectedVersion 走 CAS');
  assert.equal(calls.readControls[0].commentsReadEnabled, false);
});

test('离线保存回 deferred → 持久显示待生效，不冒充已生效，且与 enqueued 措辞可区分', async () => {
  const deferred = await bootThenSelectStoppedEnv(readDeliveryApi('deferred'));
  const comment = $(deferred.window, '#iw-read-comment') as HTMLInputElement;
  comment.checked = false;
  comment.dispatchEvent(new deferred.window.Event('change', { bubbles: true }));
  await flush();
  const deferredText = $(deferred.window, '#iw-read-apply').textContent || '';
  // ② 持久落点：#iw-read-apply 属读取设置区、非一次性 actionNotice 位（后者被 10+ 无关动作清空）。
  assert.match(deferredText, /待该环境下次连接后生效（需要启动该环境）/, 'deferred 必须持久显示待生效并指明需启动该环境');
  assert.doesNotMatch(deferredText, /已应用|已生效/, 'MUST NOT 把离线保存冒充为已应用/已生效');

  // ③ 呈现落在持久位：一次仍处停止态的状态心跳（edge stopped→starting）触发重渲染后仍在。
  const beat = status('env_stopped', '停止号');
  beat.cloud = 'disconnected';
  beat.edge = 'starting';
  beat.session = 'stopped';
  deferred.pushFleet({
    provider: 'adspower', selectedEnvId: 'env_stopped', railCollapsed: true,
    environments: [{ envId: 'env_stopped', kind: 'adspower', profileId: 'env_stopped', name: '停止号', platform: 'wechat_channels', status: beat }],
  });
  await flush();
  assert.match($(deferred.window, '#iw-read-apply').textContent || '', /待该环境下次连接后生效/, 'deferred 呈现 MUST NOT 因随后其他操作而消失');

  // enqueued 与 deferred 措辞必须可区分：enqueued 走默认「等待本机应用」分支。
  const enqueued = await bootThenSelectStoppedEnv(readDeliveryApi('enqueued'));
  const enqComment = $(enqueued.window, '#iw-read-comment') as HTMLInputElement;
  enqComment.checked = false;
  enqComment.dispatchEvent(new enqueued.window.Event('change', { bubbles: true }));
  await flush();
  const enqueuedText = $(enqueued.window, '#iw-read-apply').textContent || '';
  assert.match(enqueuedText, /等待本机应用/, 'enqueued 读作已保存、等待本机应用');
  assert.notEqual(deferredText, enqueuedText, 'deferred 与 enqueued 措辞必须可区分');
});

test('冷待机（connectivity=connected + browserState=closed + status=active）保持可编辑——防 1.2 顺手摘掉 status', async () => {
  // 默认 boot 即冷待机形态：fixture auth.status=active、browserState=closed，fleet status.cloud=connected。
  const { window, calls } = await boot();
  assert.match($(window, '#iw-browser').textContent || '', /自动化浏览器：后台模式/, '前提：这是浏览器已关闭的后台运行态');
  const comment = $(window, '#iw-read-comment') as HTMLInputElement;
  assert.equal(comment.disabled, false, 'browserState=closed 且 status=active 必须仍可编辑');
  comment.checked = false;
  comment.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(calls.readControls.length, 1, '冷待机保存必须真的发出请求');
  // 冷待机保存回 enqueued（默认 harness）：持久位 readApply 走默认待应用分支，不冒充已生效。
  const applyText = $(window, '#iw-read-apply').textContent || '';
  assert.match(applyText, /等待本机应用/);
  assert.doesNotMatch(applyText, /待该环境下次连接后生效/, 'enqueued 不应显示 deferred 专属措辞');
});

test('授权态非 active 或数据 stale 时读取开关仍禁用', async () => {
  // status 非 active：授权态才是那道闸，本 change 明确保留它。
  const reauth = await boot({
    api: {
      interactionList: async (args: any) => {
        const envelope = scopeEnvelope(listFixture, args.envKey, '示例');
        envelope.data.auth.status = 'reauth_required';
        return apiResult(envelope);
      },
    },
  });
  assert.equal(($(reauth.window, '#iw-read-comment') as HTMLInputElement).disabled, true, 'status 非 active 必须禁用');
  assert.equal(($(reauth.window, '#iw-read-dm') as HTMLInputElement).disabled, true);
  reauth.window.close();

  // stale：正拿上次成功数据顶着（storedVersion 可能已落后），携它发 CAS 有版本冲突风险，故仍拦。
  // 拦法是把三个开关 disabled——用户无从触发；这也是 `!state.stale` 必须留在 editable 里的理由。
  const { window, pushFleet } = await boot();
  assert.equal(($(window, '#iw-read-comment') as HTMLInputElement).disabled, false, '前提：连着时可编辑');
  const off = status('env_wc_demo', '轻享生活号');
  off.cloud = 'disconnected';
  pushFleet({
    provider: 'adspower', selectedEnvId: 'env_wc_demo', railCollapsed: true,
    environments: [{ envId: 'env_wc_demo', kind: 'adspower', profileId: 'env_wc_demo', name: '轻享生活号', platform: 'wechat_channels', status: off }],
  });
  await flush();
  assert.equal(($(window, '#iw-read-all') as HTMLInputElement).disabled, true, '同环境掉线致 stale 时总开关必须禁用');
  assert.equal(($(window, '#iw-read-comment') as HTMLInputElement).disabled, true, '同环境掉线致 stale 时评论开关必须禁用');
  assert.equal(($(window, '#iw-read-dm') as HTMLInputElement).disabled, true, '同环境掉线致 stale 时私信开关必须禁用');
});

test('首次互动状态查询失败后自动重试，人工查看按钮不依赖 Cloud 浏览器状态', async () => {
  let listCount = 0;
  const current = await boot({
    listPollDelayMs: 10,
    api: {
      interactionList: async (args: any) => {
        listCount += 1;
        if (listCount === 1) return apiError('INTERACTION_VALIDATION_FAILED', 'state 不合法。', 422);
        const envelope = scopeEnvelope(listFixture, args.envKey);
        envelope.data.auth.browserState = 'closed';
        return apiResult(envelope);
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  await flush();

  assert.ok(listCount >= 2, '首次查询失败时必须继续获取 Cloud 投影，不能永久停在待确认');
  assert.match($(current.window, '#iw-browser').textContent || '', /自动化浏览器：后台模式/);
  assert.equal(($(current.window, '#iw-browser-control') as HTMLButtonElement).textContent, '打开浏览器');
  assert.equal(hidden($(current.window, '#iw-browser-control')), false);
  current.window.close();
});

test('关闭、待应用和平台读取能力未就绪时，标题、空态和局部刷新都说明真实原因', async () => {
  for (const scenario of ['off', 'pending', 'capability'] as const) {
    const list = clone(listFixture);
    list.data.items = [];
    if (scenario === 'off') {
      list.data.auth.runtimeControls.stored.commentsReadEnabled = false;
      list.data.auth.runtimeControls.stored.dmReadEnabled = false;
    } else if (scenario === 'pending') {
      list.data.auth.runtimeControls.storedVersion = 8;
      list.data.auth.runtimeControls.edgeAppliedVersion = 7;
      list.data.auth.runtimeControls.applicationStatus = 'pending';
    } else {
      list.data.auth.capabilities.commentsRead = false;
      list.data.auth.capabilities.dmRead = false;
    }
    const current = await boot({ api: { interactionList: async () => apiResult(list) } });
    const expected = scenario === 'off' ? /互动收取已关闭/ : /互动收取尚未生效/;
    assert.match($(current.window, '#iw-title').textContent || '', expected);
    assert.equal(($(current.window, '#iw-sync') as HTMLButtonElement).disabled, true);
    assert.match($(current.window, '#iw-list').textContent || '', scenario === 'off'
      ? /请先开启评论或私信收取/
      : scenario === 'pending' ? /等待 Edge 应用同一版本/ : /读取能力/);
  }
});

test('发送能力只阻止发送；配置缺失只阻止依赖配置的动作，忽略和转人工仍可用', async () => {
  const noSendList = clone(listFixture);
  const noSendDetail = clone(commentFixture);
  noSendList.data.auth.capabilities.commentsReply = false;
  noSendDetail.data.auth.capabilities.commentsReply = false;
  const noSend = await boot({
    api: {
      interactionList: async () => apiResult(noSendList),
      interactionDetail: async () => apiResult(noSendDetail),
    },
  });
  await openThread(noSend.window);
  for (const action of ['approve', 'regenerate', 'ignore', 'escalate']) {
    assert.equal((noSend.window.document.querySelector(`[data-iw-action="${action}"]`) as HTMLButtonElement).disabled, false, `${action} 不应被发送能力误伤`);
  }
  const textarea = $(noSend.window, '#iw-final-text') as HTMLTextAreaElement;
  textarea.value = '仍可保存的修改';
  textarea.dispatchEvent(new noSend.window.Event('input', { bubbles: true }));
  assert.equal((noSend.window.document.querySelector('[data-iw-action="save"]') as HTMLButtonElement).disabled, false);
  $(noSend.window, '[data-iw-action="approve"]').dispatchEvent(new noSend.window.Event('click', { bubbles: true }));
  await flush();
  assert.equal((noSend.window.document.querySelector('[data-iw-action="send"]') as HTMLButtonElement).disabled, true);
  assert.match($(noSend.window, '#iw-detail').textContent || '', /只有发送被禁用/);

  const missingList = clone(listFixture);
  const missingDetail = clone(commentFixture);
  for (const fixture of [missingList, missingDetail]) {
    fixture.data.replyConfig = { status: 'missing', draftVersion: null, publishedVersion: null };
  }
  const missing = await boot({
    api: {
      interactionList: async () => apiResult(missingList),
      interactionDetail: async () => apiResult(missingDetail),
    },
  });
  assert.match($(missing.window, '#iw-config-status').textContent || '', /尚未创建回复配置/);
  await openThread(missing.window);
  assert.equal((missing.window.document.querySelector('[data-iw-action="approve"]') as HTMLButtonElement).disabled, true);
  assert.equal((missing.window.document.querySelector('[data-iw-action="regenerate"]') as HTMLButtonElement).disabled, true);
  assert.equal((missing.window.document.querySelector('[data-iw-action="ignore"]') as HTMLButtonElement).disabled, false);
  assert.equal((missing.window.document.querySelector('[data-iw-action="escalate"]') as HTMLButtonElement).disabled, false);
  $(missing.window, '#iw-config-help').dispatchEvent(new missing.window.Event('click', { bubbles: true }));
  assert.match($(missing.window, '#iw-config-guidance').textContent || '', /管理后台点击“创建安全草稿”/);
  assert.match($(missing.window, '#iw-config-guidance').textContent || '', /不会自动开启回复或发送/);
});

test('平台能力拒绝不会被误报为客户登录没有互动权限', async () => {
  const current = await boot({
    api: {
      interactionRegenerate: async () => apiError('INTERACTION_PERMISSION_DENIED', '平台当前未确认回复能力。', 403),
    },
  });
  await openThread(current.window);
  $(current.window, '[data-iw-action="regenerate"]').dispatchEvent(new current.window.Event('click', { bubbles: true }));
  await flush();
  const copy = $(current.window, '.iw-action-error').textContent || '';
  assert.match(copy, /平台尚未确认当前操作所需的渠道能力/);
  assert.doesNotMatch(copy, /当前登录没有查看或操作/);
});

test('未读提醒按环境建立无通知基线，之后每个新 messageId 最多提醒一次', async () => {
  const callsByEnv = new Map<string, number>();
  let exposeNewMessage = false;
  const { window, pushFleet, calls } = await boot({
    envKey: 'env_A',
    api: {
      interactionList: async (args: any) => {
        const count = (callsByEnv.get(args.envKey) || 0) + 1;
        callsByEnv.set(args.envKey, count);
        const envelope = scopeEnvelope(listFixture, args.envKey, args.envKey);
        envelope.data.items = [envelope.data.items[0]];
        if (args.envKey === 'env_A' && exposeNewMessage) {
          envelope.data.items.push({
            ...clone(envelope.data.items[0]),
            threadId: 'thread_comment_101',
            messageId: 'msg_comment_101',
            participantName: 'A 新观众',
            previewText: '这是刷新后新增的评论',
            unread: true,
          });
        }
        return apiResult(envelope);
      },
    },
  });
  assert.equal(calls.notify.length, 0, '首屏历史未读只建基线，不弹系统提醒');
  assert.match($(window, '#iw-unread-badge').textContent || '', /1 条未读/);

  exposeNewMessage = true;
  $(window, '#iw-sync').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 850));
  await flush();
  assert.deepEqual(clone(calls.notify), [{ envKey: 'env_A', channel: 'comment', count: 1 }]);
  assert.match($(window, '#iw-unread-badge').textContent || '', /2 条未读/);

  $(window, '#iw-sync').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 850));
  await flush();
  assert.equal(calls.notify.length, 1, '相同 messageId 刷新不得重复提醒');

  pushFleet({
    provider: 'adspower', selectedEnvId: 'env_B', railCollapsed: true,
    environments: [{ envId: 'env_B', name: '账号 B', platform: 'wechat_channels', status: status('env_B', '账号 B') }],
  });
  await flush();
  assert.equal(calls.notify.length, 1, '切换到新环境的首屏也只建自己的基线');
  assert.match($(window, '#iw-unread-badge').textContent || '', /1 条未读/);
});

test('列表方向键可达并移动焦点，窄屏样式折叠为单栏且保留 focus ring', async () => {
  const { window } = await boot();
  const list = $(window, '#iw-list');
  // 列表级下没有选中项：第一次 ArrowDown MUST 落到第一条，不能跳过它
  list.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await flush();
  const first = $(window, '[data-thread-id="thread_comment_100"]');
  assert.equal(first.getAttribute('aria-selected'), 'true');
  assert.equal(window.document.activeElement, first);

  list.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await flush();
  const selected = $(window, '[data-thread-id="thread_dm_200"]');
  assert.equal(selected.getAttribute('aria-selected'), 'true');
  assert.equal(window.document.activeElement, selected);
  assert.match($(window, '#iw-detail').textContent || '', /平台结果待核验/);

  const css = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');
  assert.match(css, /\.iw-list-item:focus-visible[\s\S]*outline: 2px solid var\(--accent\)/);
  assert.match(css, /@container \(max-width: 640px\)[\s\S]*\.iw-inbox \{ display: flex; flex: none; flex-direction: column; overflow: visible; \}/);
  assert.match(css, /@supports not \(container-type: inline-size\)[\s\S]*@media \(max-width: 700px\)[\s\S]*\.iw-inbox \{ display: flex; flex: none; flex-direction: column/);
});

test('环境 A→B 原子切换：取消 A 读取且迟到响应不能覆盖 B', async () => {
  let resolveA!: (value: any) => void;
  const delayedA = new Promise((resolve) => { resolveA = resolve; });
  const listCalls: string[] = [];
  const { window, pushFleet, calls } = await boot({
    envKey: 'env_A',
    label: '账号 A',
    api: {
      interactionList: async (args: any) => {
        listCalls.push(args.envKey);
        if (args.envKey === 'env_A') return delayedA;
        return apiResult(scopeEnvelope(listFixture, args.envKey, '账号 B'));
      },
      interactionDetail: async (args: any) => apiResult(scopeEnvelope(commentFixture, args.envKey, '账号 B')),
    },
  });
  assert.match($(window, '#iw-list-meta').textContent || '', /正在加载/);

  const bStatus = status('env_B', '账号 B');
  pushFleet({
    provider: 'adspower', selectedEnvId: 'env_B', railCollapsed: true,
    environments: [
      { envId: 'env_A', name: '账号 A', platform: 'wechat_channels', status: status('env_A', '账号 A') },
      { envId: 'env_B', name: '账号 B', platform: 'wechat_channels', status: bStatus },
    ],
  });
  await flush();
  assert.match($(window, '#iw-list').textContent || '', /账号 B观众/);
  assert.ok(calls.cancel.includes('env_A'), '切换时应请求取消 A 的读取');

  resolveA(apiResult(scopeEnvelope(listFixture, 'env_A', '账号 A')));
  await flush();
  assert.match($(window, '#iw-list').textContent || '', /账号 B观众/);
  assert.doesNotMatch($(window, '#iw-list').textContent || '', /账号 A观众/);
  assert.deepEqual(listCalls, ['env_A', 'env_B']);
});

test('批准/发送防双击，带 expectedVersion；queued 绝不冒充平台发送成功', async () => {
  let approveCount = 0;
  let sendCount = 0;
  let resolveApprove!: (value: any) => void;
  let resolveSend!: (value: any) => void;
  const approvePending = new Promise((resolve) => { resolveApprove = resolve; });
  const sendPending = new Promise((resolve) => { resolveSend = resolve; });
  const { window } = await boot({
    api: {
      interactionApprove: async () => { approveCount += 1; return approvePending; },
      interactionSend: async () => { sendCount += 1; return sendPending; },
    },
  });
  await openThread(window);

  const approve = $(window, '[data-iw-action="approve"]');
  approve.dispatchEvent(new window.Event('click', { bubbles: true }));
  approve.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(approveCount, 1);
  const approvedJob = clone(commentFixture.data.replyJob);
  approvedJob.state = 'approved';
  approvedJob.version = 4;
  resolveApprove(jobResult('env_wc_demo', approvedJob));
  await flush();
  assert.match($(window, '#iw-detail').textContent || '', /回复已批准，尚未发送/);

  const send = $(window, '[data-iw-action="send"]');
  send.dispatchEvent(new window.Event('click', { bubbles: true }));
  send.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(sendCount, 1);
  const queuedJob = clone(approvedJob);
  queuedJob.state = 'queued';
  queuedJob.version = 5;
  resolveSend(jobResult('env_wc_demo', queuedJob));
  await flush();
  assert.match($(window, '#iw-detail').textContent || '', /Cloud 已受理并进入发送队列/);
  assert.doesNotMatch($(window, '#iw-detail').textContent || '', /平台已确认发送/);
});

test('发送错误区分 Cloud 本地限制与真实平台限流', async () => {
  for (const [code, expected, excluded] of [
    ['INTERACTION_RATE_LIMITED', /Cloud 本地发送限制/, /平台正在限流/],
    ['WECHAT_RATE_LIMITED', /平台正在限流/, /Cloud 本地发送限制/],
  ] as const) {
    const handle = await boot({
      api: { interactionSend: async () => apiError(code, 'rate limited', 429) },
    });
    await openThread(handle.window);
    const approve = handle.window.document.querySelector('[data-iw-action="approve"]') as HTMLButtonElement;
    approve.dispatchEvent(new handle.window.Event('click', { bubbles: true }));
    await flush();
    const send = handle.window.document.querySelector('[data-iw-action="send"]') as HTMLButtonElement;
    send.dispatchEvent(new handle.window.Event('click', { bubbles: true }));
    await flush();
    const text = $(handle.window, '#iw-detail').textContent || '';
    assert.match(text, expected);
    assert.doesNotMatch(text, excluded);
  }
});

test('CAS 冲突保留输入并给出刷新入口；reauth 保留历史但禁写', async () => {
  const conflict = await boot({
    api: { interactionApprove: async () => apiError('INTERACTION_VERSION_CONFLICT', 'version conflict') },
  });
  await openThread(conflict.window);
  const textarea = $(conflict.window, '#iw-final-text') as HTMLTextAreaElement;
  textarea.value = '我尚未保存的修改';
  textarea.dispatchEvent(new conflict.window.Event('input', { bubbles: true }));
  $(conflict.window, '[data-iw-action="approve"]').dispatchEvent(new conflict.window.Event('click', { bubbles: true }));
  await flush();
  assert.match($(conflict.window, '#iw-detail').textContent || '', /已在别处更新/);
  assert.equal(($(conflict.window, '#iw-final-text') as HTMLTextAreaElement).value, '我尚未保存的修改');
  assert.ok($(conflict.window, '[data-iw-action="refresh-detail"]'));

  const reauthList = clone(listFixture);
  const reauthDetail = clone(commentFixture);
  reauthList.data.auth.status = 'reauth_required';
  reauthList.data.auth.browserState = 'closed';
  reauthDetail.data.auth.status = 'reauth_required';
  reauthDetail.data.auth.browserState = 'closed';
  let reopenArgs: any = null;
  const reauth = await boot({
    api: {
      interactionList: async () => apiResult(reauthList),
      interactionDetail: async () => apiResult(reauthDetail),
      interactionReopenAuth: async (args: any) => {
        reopenArgs = args;
        return apiResult({ data: { envKey: args.envKey, accountId: 'acct_wc_demo', acceptedAt: Date.now() }, meta: { requestId: 'reauth', asOf: Date.now() } });
      },
    },
  });
  assert.match($(reauth.window, '#iw-title').textContent || '', /需要重新登录/);
  await openThread(reauth.window);
  assert.match($(reauth.window, '#iw-detail').textContent || '', /这个视频很有帮助/);
  assert.equal(($(reauth.window, '#iw-final-text') as HTMLTextAreaElement).disabled, true);
  assert.equal(hidden($(reauth.window, '#iw-reauth')), false);
  $(reauth.window, '#iw-reauth').dispatchEvent(new reauth.window.Event('click', { bubbles: true }));
  await flush();
  assert.match($(reauth.window, '#iw-sync-status').textContent || '', /仍需等待平台登录状态确认/);
  assert.match($(reauth.window, '#iw-title').textContent || '', /需要重新登录/);
  assert.equal(reauth.window.document.querySelectorAll('[data-iw-action="approve"]:not([disabled])').length, 0);
  assert.equal(reauthList.data.items.length, 2, '登录失效不能清掉历史 fixture');
  assert.match(reopenArgs.idempotencyKey, /^interaction-reauth-/);
});

test('测试数据入口默认隐藏，开启后点击即直接调用重置 IPC（无二次确认弹窗）', async () => {
  const disabled = await boot();
  assert.equal(hidden($(disabled.window, '#interaction-test-reset')), true);

  const enabledList = clone(listFixture);
  enabledList.data.testTools = { dataResetEnabled: true };
  const enabled = await boot({
    api: { interactionList: async (args: any) => apiResult(scopeEnvelope(enabledList, args.envKey)) },
  });
  const toggle = $(enabled.window, '#dev-toggle') as HTMLInputElement;
  toggle.checked = true;
  toggle.dispatchEvent(new enabled.window.Event('change', { bubbles: true }));
  assert.equal(hidden($(enabled.window, '#dev-section')), false);
  assert.equal(hidden($(enabled.window, '#interaction-test-reset')), false);
  // Electron 不支持 window.prompt（调用即抛错），改为点击直接生效，不再有输入确认词的二次弹窗。
  $(enabled.window, '[data-test-reset-channel="comment"]').dispatchEvent(new enabled.window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(enabled.calls.reset.length, 1);
  assert.equal(enabled.calls.reset[0].channel, 'comment');
  assert.match($(enabled.window, '#interaction-test-reset-status').textContent || '', /已清空，正在从微信平台重新拉取/);
});

test('确认开发环境评论重置后只清本地评论视图并等待真实重拉', async () => {
  const enabledList = clone(listFixture);
  enabledList.data.testTools = { dataResetEnabled: true };
  const handle = await boot({
    api: { interactionList: async (args: any) => apiResult(scopeEnvelope(enabledList, args.envKey)) },
  });
  $(handle.window, '[data-test-reset-channel="comment"]').dispatchEvent(new handle.window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(handle.calls.reset.length, 1);
  assert.equal(handle.calls.reset[0].channel, 'comment');
  assert.match(handle.calls.reset[0].idempotencyKey, /^interaction-test-reset-comment-/);
  assert.match($(handle.window, '#interaction-test-reset-status').textContent || '', /已清空，正在从微信平台重新拉取/);
});

test('测试重置区分安全拒绝与 Cloud 已清空但 Edge 未收到', async () => {
  const enabledList = clone(listFixture);
  enabledList.data.testTools = { dataResetEnabled: true };
  const safety = await boot({
    api: {
      interactionList: async (args: any) => apiResult(scopeEnvelope(enabledList, args.envKey)),
      interactionTestReset: async () => apiError('INTERACTION_STATE_CONFLICT', '该渠道已有回复发送记录，不能重置。'),
    },
  });
  $(safety.window, '[data-test-reset-channel="comment"]').dispatchEvent(new safety.window.Event('click', { bubbles: true }));
  await flush();
  assert.match($(safety.window, '#interaction-test-reset-status').textContent || '', /已有回复发送记录/);

  const partial = await boot({
    api: {
      interactionList: async (args: any) => apiResult(scopeEnvelope(enabledList, args.envKey)),
      interactionTestReset: async () => apiError('INTERACTION_TEST_RESET_PARTIAL', 'partial', 503),
    },
  });
  $(partial.window, '[data-test-reset-channel="dm"]').dispatchEvent(new partial.window.Event('click', { bubbles: true }));
  await flush();
  assert.match($(partial.window, '#interaction-test-reset-status').textContent || '', /Cloud 私信副本已清空，但自动重新拉取没有启动/);
});

test('Cloud 离线局部刷新保留已读历史并标记上次成功数据', async () => {
  let syncOffline = false;
  const { window } = await boot({
    api: {
      interactionSync: async () => {
        syncOffline = true;
        return { status: 0, ok: false, data: null, error: 'offline' };
      },
    },
  });
  assert.match($(window, '#iw-list').textContent || '', /示例观众/);
  const successfulTime = ($(window, '#iw-as-of').textContent || '').replace(/^最近成功 · /, '');
  $(window, '#iw-sync').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(syncOffline, true);
  assert.match($(window, '#iw-list').textContent || '', /示例观众/);
  assert.match($(window, '#iw-summary').textContent || '', /上次成功数据/);
  assert.match($(window, '#iw-as-of').textContent || '', /^上次成功/);
  assert.match($(window, '#iw-as-of').textContent || '', new RegExp(successfulTime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Cloud offline/stale 禁止 save/approve/send，成功刷新后才恢复写动作', async () => {
  const { window, pushFleet, calls } = await boot({
    api: {
      interactionSync: async () => ({ status: 0, ok: false, data: null, error: 'offline' }),
    },
  });
  await openThread(window);

  const textarea = $(window, '#iw-final-text') as HTMLTextAreaElement;
  textarea.value = '离线期间不得提交的修改';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(($(window, '[data-iw-action="save"]') as HTMLButtonElement).disabled, false);

  $(window, '#iw-sync').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(($(window, '#iw-final-text') as HTMLTextAreaElement).disabled, true, 'stale 时编辑器必须锁定');
  assert.match($(window, '#iw-detail').textContent || '', /刷新成功前写操作已禁用/);
  const staleSave = $(window, '[data-iw-action="save"]') as HTMLButtonElement;
  const staleApprove = $(window, '[data-iw-action="approve"]') as HTMLButtonElement;
  assert.equal(staleSave.disabled, true, 'stale 时 save 明确 disabled');
  assert.equal(staleApprove.disabled, true, 'stale 时 approve 不可用');
  staleSave.dispatchEvent(new window.Event('click', { bubbles: true }));
  staleApprove.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(calls.save.length, 0, 'disabled 之外 handler guard 也必须拦 save');
  assert.equal(calls.approve.length, 0, 'disabled 之外 handler guard 也必须拦 approve');

  $(window, '[data-iw-action="refresh-detail"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(($(window, '#iw-final-text') as HTMLTextAreaElement).disabled, false, '成功刷新当前详情后恢复编辑');
  assert.equal(($(window, '[data-iw-action="approve"]') as HTMLButtonElement).disabled, false, '成功刷新后恢复 approve');
  const recoveredTextarea = $(window, '#iw-final-text') as HTMLTextAreaElement;
  recoveredTextarea.value = 'Cloud 恢复后的可提交修改';
  recoveredTextarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  $(window, '[data-iw-action="approve"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(calls.save.length, 1, '恢复后保存修改可正常发出');
  assert.equal(calls.approve.length, 1, '恢复后批准可正常发出');

  const disconnected = status('env_wc_demo', '轻享生活号');
  disconnected.cloud = 'disconnected';
  pushFleet({
    provider: 'adspower', selectedEnvId: 'env_wc_demo', railCollapsed: true,
    environments: [{ envId: 'env_wc_demo', kind: 'adspower', profileId: 'env_wc_demo', name: '轻享生活号', platform: 'wechat_channels', status: disconnected }],
  });
  await flush();
  const send = $(window, '[data-iw-action="send"]') as HTMLButtonElement;
  assert.equal(send.disabled, true, '显式 Cloud disconnected 时 send 不可用');
  send.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(calls.send.length, 0, 'disabled 之外 handler guard 也必须拦 send');
});

test('双列主从布局：不默认选中或预取，右列显示选择提示且每一条都点得开', async () => {
  const { window, calls } = await boot();

  // 不默认选中：左列没有选中项，右列显示选择提示，也 MUST NOT 预取详情。
  const detail = $(window, '#iw-detail');
  assert.equal(detail.hasAttribute('hidden'), false, '双列布局右侧详情列必须常驻');
  assert.match(detail.textContent || '', /选择一条互动查看详情/);
  assert.equal(calls.detail.length, 0, '没点开就不该请求详情');
  assert.equal(window.document.querySelectorAll('[aria-selected="true"]').length, 0);

  const list = $(window, '#iw-list');
  list.scrollTop = 42;
  const ids = Array.from(window.document.querySelectorAll('[data-thread-id]'))
    .map((node) => (node as HTMLElement).dataset.threadId as string);
  assert.ok(ids.length >= 2, 'fixture 应有多条互动');
  for (const id of ids) {
    await openThread(window, id);
    assert.equal($(window, '#iw-detail').hasAttribute('hidden'), false, `${id} 的详情应在右列显示`);
    assert.ok($(window, '#iw-list').isConnected, '详情打开时左列列表 DOM 必须保留');
    $(window, '[data-iw-action="close-detail"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    assert.match($(window, '#iw-detail').textContent || '', /选择一条互动查看详情/, `${id} 关闭后右列应恢复选择提示`);
    assert.equal(list.scrollTop, 42, `${id} 关闭后左列滚动位置必须保留`);
  }
});

test('关闭图标与 Esc 都回到列表级并清空选中；列表只呈现摘要不带正文', async () => {
  const { window } = await boot();

  await openThread(window, 'thread_comment_100');
  assert.equal($(window, '#iw-detail').hasAttribute('hidden'), false);
  assert.ok($(window, '[data-iw-action="refresh-detail"]').classList.contains('iw-iconbtn'), '刷新已图标化');
  // 图标只是外形：无障碍名称必须还在，MUST NOT 只靠图形传达用途
  assert.equal($(window, '[data-iw-action="refresh-detail"]').getAttribute('aria-label'), '刷新状态');
  assert.ok($(window, '[data-iw-action="close-detail"]').getAttribute('aria-label'));

  $(window, '#interaction-workspace').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  assert.equal($(window, '#iw-detail').hasAttribute('hidden'), false, 'Esc 后右侧详情列仍应保留');
  assert.match($(window, '#iw-detail').textContent || '', /选择一条互动查看详情/);
  assert.equal(window.document.querySelectorAll('[aria-selected="true"]').length, 0, 'Esc 后不应残留选中');

  // 列表只呈现摘要：昵称/时间/来源在，消息正文只在详情级
  const list = $(window, '#iw-list');
  assert.equal(window.document.querySelectorAll('.iw-item-preview').length, 0, '列表 MUST NOT 渲染正文预览行');
  assert.match(list.textContent || '', /示例观众/, '昵称仍在');
  assert.doesNotMatch(list.textContent || '', /这个视频很有帮助/, '正文只属于详情级');
});

test('宽屏收件箱是双列且详情不再覆盖列表，窄工作区仍回退单列', () => {
  const css = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');
  assert.match(css, /\.iw-inbox \{[\s\S]{0,160}grid-template-columns: minmax\(248px, \.78fr\) minmax\(330px, 1\.42fr\);/);
  assert.doesNotMatch(css, /\.iw-detail \{[\s\S]{0,120}position: absolute;/, '详情不得再绝对定位覆盖左列');
  assert.match(css, /@container \(max-width: 640px\)[\s\S]*\.iw-inbox \{ display: flex; flex: none; flex-direction: column; overflow: visible; \}/);
});

test('interaction workspace keeps polling while auth recovery is required and renders closed browser truthfully', async () => {
  const closed = await boot({
    api: {
      interactionList: async (args: any) => {
        const envelope = scopeEnvelope(listFixture, args.envKey);
        envelope.data.auth.status = 'login_required';
        envelope.data.auth.reasonCode = 'WECHAT_AUTH_REQUIRED';
        envelope.data.auth.browserState = 'closed';
        return apiResult(envelope);
      },
    },
  });
  assert.equal($(closed.window, '#iw-browser').textContent, '自动化浏览器：已关闭');
  closed.window.close();

  let listCount = 0;
  const current = await boot({
    listPollDelayMs: 10,
    api: {
      interactionList: async (args: any) => {
        listCount += 1;
        const envelope = scopeEnvelope(listFixture, args.envKey);
        envelope.data.auth.browserState = 'closed';
        if (listCount === 1) {
          envelope.data.auth.status = 'login_required';
          envelope.data.auth.reasonCode = 'WECHAT_AUTH_REQUIRED';
        }
        return apiResult(envelope);
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  await flush();

  assert.ok(listCount >= 2, 'login_required must continue polling the Cloud projection');
  assert.equal($(current.window, '#iw-browser').textContent, '自动化浏览器：后台模式');
  assert.match($(current.window, '#iw-auth-status').textContent || '', /鉴权通过/);
  current.window.close();
});

test('interaction workspace keeps polling when all read controls are disabled', async () => {
  let listCount = 0;
  const current = await boot({
    listPollDelayMs: 10,
    api: {
      interactionList: async (args: any) => {
        listCount += 1;
        const envelope = scopeEnvelope(listFixture, args.envKey);
        envelope.data.auth.runtimeControls.stored.commentsReadEnabled = false;
        envelope.data.auth.runtimeControls.stored.dmReadEnabled = false;
        return apiResult(envelope);
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  await flush();

  assert.ok(listCount >= 2, 'disabled reads must not freeze browser and auth status polling');
  current.window.close();
});
