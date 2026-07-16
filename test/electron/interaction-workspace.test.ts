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
const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');
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
  const calls: Record<string, any[]> = { list: [], detail: [], cancel: [], save: [], approve: [], send: [], sync: [], reopen: [] };
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
    interactionRegenerate: async (args: any) => jobResult(args.envKey, scopeEnvelope(commentFixture, args.envKey).data.replyJob),
    interactionIgnore: async (args: any) => jobResult(args.envKey, { ...scopeEnvelope(commentFixture, args.envKey).data.replyJob, state: 'ignored', version: args.expectedVersion + 1 }),
    interactionEscalate: async (args: any) => jobResult(args.envKey, { ...scopeEnvelope(commentFixture, args.envKey).data.replyJob, state: 'escalated', version: args.expectedVersion + 1 }),
    interactionSync: async (args: any) => {
      calls.sync.push(args);
      return apiResult({ data: { envKey: args.envKey, accountId: `account-${args.envKey}`, acceptedAt: Date.now() }, meta: { requestId: 'sync', asOf: Date.now() } });
    },
    interactionReopenAuth: async (args: any) => {
      calls.reopen.push(args);
      return apiResult({ data: { envKey: args.envKey, accountId: `account-${args.envKey}`, acceptedAt: Date.now() }, meta: { requestId: 'reopen', asOf: Date.now() } });
    },
    interactionCancelReads: async (key: string) => { calls.cancel.push(key); return { ok: true, cancelled: 1 }; },
  };
  const api = { ...defaultApi, ...(options.api || {}) };
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://fixture.local/' });
  const { window } = dom;
  openWindows.push(window);
  (window as any).aidcpEdge = api;
  window.eval(uiLogicSrc);
  window.eval(interactionSrc);
  window.eval(rendererSrc);
  await flush();
  return { window, pushFleet, pushStatus, calls };
}

const $ = (window: DOMWindow, selector: string) => window.document.querySelector(selector) as HTMLElement;
const hidden = (element: HTMLElement) => element.classList.contains('hidden');

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
  assert.match($(window, '#iw-browser').textContent || '', /浏览器已关闭（正常）/);
  assert.match($(window, '#iw-list').textContent || '', /示例观众/);
  assert.match($(window, '#iw-detail').textContent || '', /模板 template_comment_thanks · v1/);
  assert.match($(window, '#iw-detail').textContent || '', /配置版本 1/);
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
  assert.match($(pending.window, '#iw-title').textContent || '', /账号开关等待本机应用/);
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
  assert.match($(window, '#iw-detail').textContent || '', /平台结果待核验/);
  assert.match($(window, '#iw-detail').textContent || '', /不会自动重复发送/);
  assert.doesNotMatch($(window, '#iw-detail').textContent || '', /平台已确认发送/);

  const errorBoot = await boot({
    api: { interactionList: async () => apiError('INTERACTION_UPSTREAM_UNAVAILABLE', 'offline', 503) },
  });
  assert.match($(errorBoot.window, '#iw-list-error').textContent || '', /Cloud 暂时不可达/);
  assert.match($(errorBoot.window, '#iw-list').textContent || '', /当前没有待处理互动/);
});

test('列表方向键可达并移动焦点，窄屏样式折叠为单栏且保留 focus ring', async () => {
  const { window } = await boot();
  const list = $(window, '#iw-list');
  list.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await flush();
  const selected = $(window, '[data-thread-id="thread_dm_200"]');
  assert.equal(selected.getAttribute('aria-selected'), 'true');
  assert.equal(window.document.activeElement, selected);
  assert.match($(window, '#iw-detail').textContent || '', /平台结果待核验/);

  const css = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');
  assert.match(css, /\.iw-list-item:focus-visible[\s\S]*outline: 2px solid var\(--accent\)/);
  assert.match(css, /@container \(max-width: 640px\)[\s\S]*\.iw-inbox \{ grid-template-columns: 1fr/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.iw-inbox \{ display: flex; flex: none; flex-direction: column/);
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

test('CAS 冲突保留输入并给出刷新入口；reauth 保留历史但禁写', async () => {
  const conflict = await boot({
    api: { interactionApprove: async () => apiError('INTERACTION_VERSION_CONFLICT', 'version conflict') },
  });
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
  $(window, '#iw-sync').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  assert.equal(syncOffline, true);
  assert.match($(window, '#iw-list').textContent || '', /示例观众/);
  assert.match($(window, '#iw-summary').textContent || '', /上次成功数据/);
});

test('Cloud offline/stale 禁止 save/approve/send，成功刷新后才恢复写动作', async () => {
  const { window, pushFleet, calls } = await boot({
    api: {
      interactionSync: async () => ({ status: 0, ok: false, data: null, error: 'offline' }),
    },
  });

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
