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
  fleetLevel: (s: unknown, now: number) => { level: string; needsAction: boolean; label: string; state: string; railGroup: string; detail: string };
  fleetRailModel: (l: unknown[], now: number) => { rows: Array<{ envId: string; level: string; state: string; railGroup: string; needsAction: boolean }>; pendingCount: number };
  batchStartReady: (s: unknown) => boolean;
  synthesizeHealth: (s: unknown) => { label: string; detail: string };
  detailRows: (s: unknown) => Array<{ key: string; value: string }>;
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
    clientSessionState: 'ready',
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
  pushBatchProxyProgress: (progress: unknown) => void;
  calls: Record<string, unknown[]>;
}

async function boot(
  apiOver: Record<string, unknown> = {},
  settingsOver: Record<string, unknown> = {},
  globalsOver: Record<string, unknown> = {},
): Promise<BootHandles> {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  openWindows.push(window);
  let pushStatus: (s: unknown) => void = () => undefined;
  let pushActivity: (e: unknown) => void = () => undefined;
  let pushFleet: (snap: unknown) => void = () => undefined;
  let pushBatchProxyProgress: (progress: unknown) => void = () => undefined;
  const calls: Record<string, unknown[]> = { relogin: [], showDriven: [], showDrivenOptions: [], resetParking: [], startAll: [], closeAll: [], personaPreview: [], personaFill: [], select: [], close: [], browserOpen: [], browserClose: [], notify: [], start: [], resume: [], saveNickname: [], updateProxies: [] };
  const personaStatusByEnv = new Map<string, Record<string, unknown>>();
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
  Object.assign(window, globalsOver);
  (window as unknown as { aidcpEdge: unknown }).aidcpEdge = {
    onStatusUpdate: (cb: (s: unknown) => void) => {
      pushStatus = (status: unknown) => {
        if (status && typeof status === 'object') {
          const value = status as Record<string, unknown>;
          if (typeof value.envId === 'string') personaStatusByEnv.set(value.envId, value);
        }
        cb(status);
      };
    },
    onActivity: (cb: (e: unknown) => void) => { pushActivity = cb; },
    onFleetUpdate: (cb: (snap: unknown) => void) => { pushFleet = cb; },
    onEnvProxyBatchProgress: (cb: (progress: unknown) => void) => { pushBatchProxyProgress = cb; },
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
    saveEnvironmentNickname: async (args: { profileId: string; nickname: string }) => {
      calls.saveNickname.push(args);
      return { ok: true, environment: { profileId: args.profileId, name: args.nickname, nameSource: 'manual' } };
    },
    fleetSetRailCollapsed: async () => ({ ok: true }),
    fleetStartAll: async (opts: unknown) => { calls.startAll.push(opts); return { ok: true, queued: 2 }; },
    fleetStopAll: async () => ({ ok: true }),
    fleetCloseAll: async (opts: unknown) => { calls.closeAll.push(opts); return { ok: true, accepted: 2 }; },
    facebookPersonaTemplatePreview: async (selection: unknown) => {
      calls.personaPreview.push(selection);
      return { ok: true, soulYaml: 'selected-soul-yaml', identitySummary: '批量人设预览' };
    },
    facebookPersonaFillSelected: async (soulYaml: string) => {
      calls.personaFill.push(soulYaml);
      return { ok: true, accepted: true };
    },
    personaGet: async (envId: string) => {
      const status = personaStatusByEnv.get(envId);
      if (status?.personaBound === true) {
        return {
          ok: true,
          state: 'configured',
          persona: {
            soulYaml: 'identity:\n  name: "当前人设"',
            summary: {
              name: '当前人设', role: '内容创作者', background: '', tone: '真诚自然', writingLanguage: null,
              primaryInterests: ['内容创作'], secondaryInterests: [], seedKeywords: [], likeAffinity: 'normal',
            },
            updatedAt: null,
          },
        };
      }
      return { ok: true, state: 'missing', persona: null };
    },
    relogin: async (envId: string) => { calls.relogin.push(envId); return makeStatus({ envId }); },
    notify: async (payload: unknown) => { calls.notify.push(payload); return { ok: true }; },
    showDrivenBrowser: async (envId: string, opts?: unknown) => { calls.showDriven.push(envId); calls.showDrivenOptions.push(opts); return { ok: true }; },
    resetBrowserParking: async (envId: string) => { calls.resetParking.push(envId); return { ok: true }; },
    pause: async () => makeStatus(),
    resume: async (envId: string) => { calls.resume.push(envId); return makeStatus({ envId }); },
    close: async (envId: string) => { calls.close.push(envId); return makeStatus({ envId, edge: 'stopped', cloud: 'disconnected', session: 'closed' }); },
    browserOpen: async (envId: string) => {
      calls.browserOpen.push(envId);
      return makeStatus({ envId, edge: 'running', session: 'paused', coreState: 'online', cloudState: 'connected', automationState: 'paused', browserState: 'ready' });
    },
    browserClose: async (envId: string) => {
      calls.browserClose.push(envId);
      return makeStatus({ envId, edge: 'running', session: 'paused', coreState: 'online', cloudState: 'connected', automationState: 'paused', browserState: 'closed' });
    },
    start: async (envId: string) => { calls.start.push(envId); return makeStatus({ envId }); },
    restart: async () => makeStatus(),
    adsStatus: async () => ({ ok: false, error: 'not running' }),
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    adsGetEnvProxy: async () => ({ ok: true, noProxy: true, proxy: { proxyType: 'no_proxy' } }),
    adsParseProxyLines: async ({ proxyType, proxyText }: { proxyType?: string; proxyText?: string }) => {
      if (proxyType === 'no_proxy') return { ok: true, noProxy: true, proxies: [] };
      const proxies = String(proxyText || '').split(/\r?\n/).filter(Boolean).map((line) => {
        const [proxyHost, proxyPort, proxyUser = '', ...password] = line.split(':');
        return { proxyType, proxyHost, proxyPort, proxyUser, proxyPassword: password.join(':') };
      });
      return proxies.length > 0 ? { ok: true, noProxy: false, proxies } : { ok: false, error: '请至少粘贴一条代理资料' };
    },
    adsUpdateEnvProxy: async () => ({ ok: true }),
    adsUpdateEnvProxies: async (args: unknown) => {
      calls.updateProxies.push(args);
      const count = ((args as { userIds?: unknown[] }).userIds || []).length;
      return { ok: true, updatedCount: count };
    },
    adsTemplates: async () => [],
    openFeishu: async () => ({ ok: true }),
    ...apiOver,
  };
  const environmentDisplayNameSrc = readFileSync(join(electronDir, 'renderer/environment-display-name.cjs'), 'utf8');
  const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
  const publishReviewLogicSrc = readFileSync(join(electronDir, 'renderer/publish-review-logic.js'), 'utf8');
  const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');
  window.eval(environmentDisplayNameSrc);
  window.eval(uiLogicSrc);
  window.eval(publishReviewLogicSrc);
  window.eval(rendererSrc);
  await tick();
  await tick();
  return { w: window, pushStatus, pushActivity, pushFleet, pushBatchProxyProgress, calls };
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
  assert.equal(booting.label, '连接中');
});

test('fleetLevel：自动化状态统一使用无重复主体的短标签', () => {
  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  assert.equal(uiLogic.fleetLevel({ automationState: 'starting', updatedAt }, now).label, '启动中');
  assert.equal(uiLogic.fleetLevel({ automationState: 'ready', engineLinkState: 'connected', browserState: 'ready', updatedAt }, now).label, '待任务');
  assert.equal(uiLogic.fleetLevel({ automationState: 'running', engineLinkState: 'connected', updatedAt }, now).label, '运行中');
  assert.equal(uiLogic.fleetLevel({ automationState: 'error', updatedAt }, now).label, '异常');
});

test('fleetLevel：待任务与待机按浏览器占位区分，主状态最多三个汉字', () => {
  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  const ready = uiLogic.fleetLevel({ automationState: 'ready', engineLinkState: 'connected', browserState: 'ready', updatedAt }, now);
  const standby = uiLogic.fleetLevel({ automationState: 'ready', engineLinkState: 'connected', browserState: 'closed', updatedAt }, now);
  assert.deepEqual({ label: ready.label, state: ready.state, group: ready.railGroup }, { label: '待任务', state: 'ready', group: 'ready' });
  assert.deepEqual({ label: standby.label, state: standby.state, group: standby.railGroup }, { label: '待机中', state: 'standby', group: 'standby' });

  const statuses = [
    { automationState: 'running', engineLinkState: 'connected', browserState: 'ready' },
    { automationState: 'starting', engineLinkState: 'connecting', browserState: 'starting' },
    { automationState: 'waiting_resource', browserState: 'queued' },
    { automationState: 'paused', browserState: 'closed' },
    { automationState: 'stopped', browserState: 'closed' },
    { automationState: 'running', overlayBlocked: true },
    { automationState: 'stopped', auth: 'login required' },
    { automationState: 'stopped', sameAccountWarning: { message: 'duplicate' } },
  ];
  for (const status of statuses) {
    const label = uiLogic.fleetLevel({ ...status, updatedAt }, now).label;
    assert.ok([...label].length <= 3, `${label} 不得超过三个汉字`);
  }
});

test('batchStartReady：核心存活不等于启动完成，只认运行或可立即接任务', () => {
  assert.equal(uiLogic.batchStartReady({ edge: 'running', automationState: 'starting', engineLinkState: 'connecting', browserState: 'starting' }), false);
  assert.equal(uiLogic.batchStartReady({ edge: 'running', automationState: 'waiting_resource', engineLinkState: 'connected', browserState: 'queued' }), false);
  assert.equal(uiLogic.batchStartReady({ edge: 'running', automationState: 'ready', engineLinkState: 'connected', browserState: 'closed' }), false, '待机不占浏览器槽位，不冒充全部启动完成');
  assert.equal(uiLogic.batchStartReady({ edge: 'running', automationState: 'ready', engineLinkState: 'connected', browserState: 'ready' }), true);
  assert.equal(uiLogic.batchStartReady({ edge: 'running', automationState: 'running', engineLinkState: 'connected', browserState: 'closed' }), true, '浏览器无关任务运行时仍是真运行');
});

test('fleetLevel：连上过之后掉线才升为需处理的「重连中」', () => {
  const now = Date.now();
  const dropped = uiLogic.fleetLevel(
    { edge: 'running', session: 'running', cloud: 'disconnected', cloudEverConnected: true, updatedAt: new Date(now).toISOString() },
    now,
  );
  assert.equal(dropped.level, 'attention');
  assert.equal(dropped.needsAction, true);
  assert.equal(dropped.label, '重连中');
});

test('fleetLevel：放弃重启和冻结为 error；账号重复运行为 attention', () => {
  const now = Date.now();
  assert.equal(uiLogic.fleetLevel({ respawnGaveUp: true, edge: 'stopped' }, now).level, 'error');
  assert.equal(uiLogic.fleetLevel({ risk: 'frozen', edge: 'running' }, now).level, 'error');
  const warn = uiLogic.fleetLevel({ edge: 'stopped', session: 'idle', sameAccountWarning: { message: 'x' } }, now);
  assert.equal(warn.level, 'attention');
  assert.equal(warn.needsAction, true);
  assert.equal(warn.label, '有冲突');
  assert.equal(warn.detail, '账号重复运行');
});

test('restricted 在完整明细保留账号受限，环境栏使用三字主状态并保留原因', () => {
  const now = Date.now();
  const status = { risk: 'restricted', edge: 'stopped', session: 'idle', cloud: 'disconnected' };
  assert.equal(uiLogic.synthesizeHealth(status).label, '受限制');
  assert.match(uiLogic.synthesizeHealth(status).detail, /账号受限/);
  assert.equal(uiLogic.detailRows(status).find((row) => row.key === 'risk')?.value, '账号受限');
  assert.equal(uiLogic.fleetLevel(status, now).label, '受限制');
  assert.equal(uiLogic.fleetLevel(status, now).detail, '账号受限');
});

test('fleetLevel：暂停与关闭共享 offline 级别但标签明确区分，供渲染层拆组', () => {
  const now = Date.now();
  const paused = uiLogic.fleetLevel({ edge: 'stopped', session: 'paused' }, now);
  const closed = uiLogic.fleetLevel({ edge: 'stopped', session: 'closed' }, now);
  assert.equal(paused.level, 'offline');
  assert.equal(paused.label, '已暂停');
  assert.equal(closed.level, 'offline');
  assert.equal(closed.label, '未启动');
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

test('环境栏：现有框架按运行阶段分组，排队位次独立展示且每行只出现一次', async () => {
  const environments = [
    { envId: 'env-attn', name: '需处理环境', status: makeStatus({ envId: 'env-attn', overlayBlocked: true }) },
    { envId: 'env-running', name: '运行环境', status: makeStatus({ envId: 'env-running', automationState: 'running', engineLinkState: 'connected', browserState: 'ready' }) },
    { envId: 'env-ready', name: '待任务环境', status: makeStatus({ envId: 'env-ready', automationState: 'ready', engineLinkState: 'connected', browserState: 'ready' }) },
    { envId: 'env-starting', name: '启动环境', status: makeStatus({ envId: 'env-starting', automationState: 'starting', engineLinkState: 'connecting', browserState: 'starting' }) },
    { envId: 'env-queued', name: '排队环境', status: makeStatus({ envId: 'env-queued', automationState: 'waiting_resource', engineLinkState: 'disconnected', browserState: 'queued', queuePosition: 2 }) },
    { envId: 'env-standby', name: '待机环境', status: makeStatus({ envId: 'env-standby', automationState: 'ready', engineLinkState: 'connected', browserState: 'closed' }) },
    { envId: 'env-paused', name: '暂停环境', status: makeStatus({ envId: 'env-paused', session: 'paused', automationState: 'paused', browserState: 'closed' }) },
    { envId: 'env-offline', name: '离线环境', status: makeStatus({ envId: 'env-offline', edge: 'stopped', session: 'closed', automationState: 'stopped', engineLinkState: 'disconnected', browserState: 'closed' }) },
  ];
  const { w } = await boot({
    fleetGet: async () => ({
      provider: 'adspower',
      selectedEnvId: 'env-running',
      railCollapsed: false,
      environments,
    }),
  }, {
    railCollapsed: false,
    environments: environments.map((env) => ({ profileId: env.envId, name: env.name, platform: 'xiaohongshu' })),
  });

  const list = w.document.querySelector('#rail-list')!;
  const groupTitles = [...list.querySelectorAll('.rail-group')].map((group) => group.firstChild?.textContent?.trim());
  assert.deepEqual(groupTitles, ['需要处理', '运行中', '待任务', '启动中', '排队中', '待机中', '暂停', '离线']);
  assert.doesNotMatch(list.textContent || '', /暂停\s*·\s*离线/);

  const sequence = [...list.children].map((node) =>
    node.classList.contains('rail-group')
      ? `group:${node.firstChild?.textContent?.trim()}`
      : `row:${(node as HTMLElement).dataset.envId}`,
  );
  assert.deepEqual(sequence, [
    'group:需要处理', 'row:env-attn',
    'group:运行中', 'row:env-running',
    'group:待任务', 'row:env-ready',
    'group:启动中', 'row:env-starting',
    'group:排队中', 'row:env-queued',
    'group:待机中', 'row:env-standby',
    'group:暂停', 'row:env-paused',
    'group:离线', 'row:env-offline',
  ]);
  for (const env of environments) {
    assert.equal(list.querySelectorAll(`.rail-row[data-env-id="${env.envId}"]`).length, 1, `${env.name} 只属于一个分组`);
  }
  const queued = list.querySelector('.rail-row[data-env-id="env-queued"]') as HTMLElement;
  assert.equal(queued.classList.contains('state-queued'), true);
  assert.equal(queued.querySelector('.rail-queue-position')?.textContent, '#2', '展开态位次与三字状态分开显示');
  assert.equal(queued.querySelector('.rail-queue-badge')?.textContent, '2', '收起态复用同一结构化位次徽标');
  assert.match(queued.title, /排队中 #2/);
  assert.equal((list.querySelector('.rail-row[data-env-id="env-standby"]') as HTMLElement).classList.contains('state-standby'), true);
  assert.match(rendererCss, /\.rail-row\.state-queued \.rail-dot\s*\{[^}]*background:\s*transparent;[^}]*border:\s*1\.5px solid #3b6ff0;/s);
  assert.match(rendererCss, /\.rail-row\.state-standby \.rail-dot\s*\{[^}]*background:\s*transparent;[^}]*border:\s*1\.5px solid #16a34a;/s);
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
  assert.equal(
    (calls.showDrivenOptions[0] as { keepClientForeground?: boolean } | undefined)
      ?.keepClientForeground,
    true,
    '头像显示必须要求 AIDCP 最终保持在前',
  );
  assert.equal(rowOf('ads-p2').classList.contains('shown'), true, '抬前后行进入 shown 态');
  assert.equal(w.document.querySelector('#rail-msg')!.textContent, '', '窗口前置成功不展示说明文案');
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

test('环境昵称双击进入编辑并持久化人工来源，不同时触发浏览器三态', async () => {
  const saved: Array<{ profileId: string; nickname: string }> = [];
  const { w, calls } = await boot({
    saveEnvironmentNickname: async (args: { profileId: string; nickname: string }) => {
      saved.push(args);
      return { ok: true, environment: { profileId: args.profileId, name: args.nickname, nameSource: 'manual' } };
    },
  });
  const rowOf = (id: string) => w.document.querySelector(`.rail-row[data-env-id="${id}"]`) as HTMLElement;
  const nicknameOf = (id: string) => rowOf(id).querySelector('.rail-name') as HTMLElement;

  // 物理双击序列：第一击不得在第二击到来前抬浏览器，最终只进入编辑。
  nicknameOf('ads-p1').dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 1 }));
  nicknameOf('ads-p1').dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 2 }));
  nicknameOf('ads-p1').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  await tick();
  assert.deepEqual(calls.showDriven, []);
  assert.deepEqual(calls.resetParking, []);
  const input = rowOf('ads-p1').querySelector('.rail-name-editor') as HTMLInputElement;
  assert.ok(input, '双击后应原位出现昵称输入框');
  assert.equal(input.value, '环境一');

  input.value = '运营重点号';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await tick();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.profileId, 'p1');
  assert.equal(saved[0]?.nickname, '运营重点号');
  const rendered = nicknameOf('ads-p1');
  assert.equal(rendered.textContent, '运营重点号');
  assert.equal(rendered.classList.contains('manual'), true);
  assert.equal(rendered.classList.contains('pending'), false);
  assert.match(rendered.title, /人工昵称/);
  assert.match(w.document.querySelector('#rail-msg')?.textContent || '', /后续系统更新不会覆盖/);
});

test('昵称原值提交是纯 no-op，不把系统昵称误记为人工也不重复保存人工昵称', async () => {
  const saved: Array<{ profileId: string; nickname: string }> = [];
  const { w } = await boot({
    saveEnvironmentNickname: async (args: { profileId: string; nickname: string }) => {
      saved.push(args);
      return {
        ok: true,
        environment: {
          profileId: args.profileId,
          name: args.nickname,
          nameSource: 'manual',
          nameSyncState: 'synced',
        },
      };
    },
  });
  const rowOf = (id: string) => w.document.querySelector(`.rail-row[data-env-id="${id}"]`) as HTMLElement;
  const open = (id: string) => {
    (rowOf(id).querySelector('.rail-name') as HTMLElement)
      .dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    return rowOf(id).querySelector('.rail-name-editor') as HTMLInputElement;
  };

  let input = open('ads-p1');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await tick();
  let rendered = rowOf('ads-p1').querySelector('.rail-name') as HTMLElement;
  assert.equal(saved.length, 0, '系统昵称未变化时不得调用主进程/Cloud 保存');
  assert.equal(rendered.textContent, '环境一');
  assert.equal(rendered.classList.contains('manual'), false, '误触不得把系统昵称升级成人工来源');
  assert.equal(rendered.classList.contains('pending'), false);

  input = open('ads-p2');
  input.dispatchEvent(new w.FocusEvent('blur'));
  await tick();
  rendered = rowOf('ads-p2').querySelector('.rail-name') as HTMLElement;
  assert.equal(saved.length, 0, '系统昵称原值失焦也必须是 no-op');
  assert.equal(rendered.classList.contains('manual'), false);

  input = open('ads-p1');
  input.value = '运营重点号';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await tick();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.nickname, '运营重点号');

  input = open('ads-p1');
  input.value = '  运营重点号  ';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await tick();
  rendered = rowOf('ads-p1').querySelector('.rail-name') as HTMLElement;
  assert.equal(saved.length, 1, '人工昵称 trim 后未变化时不得重复保存');
  assert.equal(rendered.textContent, '运营重点号');
  assert.equal(rendered.classList.contains('manual'), true, '既有人工来源应原样保留');
  assert.equal(rendered.classList.contains('pending'), false);
});

test('人工昵称统一覆盖环境身份锚点，旧系统名心跳不得回写覆盖', async () => {
  const interactionSelections: unknown[] = [];
  const contentSelections: unknown[] = [];
  const platformStatus = makeStatus({
    envId: 'ads-p1',
    envName: 'Tianxing Bai',
    account: { id: 'fb-1', name: 'Tianxing Bai', source: 'facebook' },
    personaBound: true,
  });
  const manualEnvironment = {
    envId: 'ads-p1',
    kind: 'adspower',
    profileId: 'p1',
    name: 'Tianxing Bai1',
    nameSource: 'manual',
    platform: 'facebook',
    status: platformStatus,
  };
  const { w, calls, pushStatus } = await boot({
    getStatus: async () => platformStatus,
    fleetGet: async () => ({
      provider: 'adspower',
      selectedEnvId: 'ads-p1',
      railCollapsed: false,
      environments: [manualEnvironment],
    }),
  }, {
    adsProfileId: 'p1',
    adsProfileName: 'Tianxing Bai1',
    railCollapsed: false,
    environments: [{ profileId: 'p1', name: 'Tianxing Bai1', nameSource: 'manual', platform: 'facebook' }],
  }, {
    InteractionWorkspace: {
      create: () => ({ selectEnvironment: (value: unknown) => interactionSelections.push(value) }),
    },
    ContentWorkspace: {
      create: () => ({
        setEnvironment: (value: unknown) => contentSelections.push(value),
        isDraftOpen: () => false,
        openDraft: () => undefined,
        close: () => undefined,
      }),
    },
  });

  const railName = () => w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-name')?.textContent || '';
  assert.equal(railName(), 'Tianxing Bai1');
  assert.equal(w.document.querySelector('#acct-name')?.textContent, 'Tianxing Bai1', '人工昵称不是平台 handle，不加 @');
  assert.equal((interactionSelections.at(-1) as { label?: string })?.label, 'Tianxing Bai1');
  assert.equal((contentSelections.at(-1) as { label?: string })?.label, 'Tianxing Bai1');

  (w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-persona') as HTMLElement).click();
  assert.match(w.document.querySelector('#persona-pop-env')?.textContent || '', /Tianxing Bai1/);

  // 回归用户现场：运行态仍上报旧系统名 Tianxing Bai，也不能把人工昵称刷回去。
  pushStatus(makeStatus({
    ...platformStatus,
    envName: 'Tianxing Bai',
    personaBound: false,
  }));
  await tick();
  await tick();
  assert.equal(railName(), 'Tianxing Bai1');
  assert.equal(w.document.querySelector('#acct-name')?.textContent, 'Tianxing Bai1');
  assert.equal((interactionSelections.at(-1) as { label?: string })?.label, 'Tianxing Bai1');
  assert.equal((contentSelections.at(-1) as { label?: string })?.label, 'Tianxing Bai1');
  assert.match(String((calls.notify.at(-1) as { body?: string })?.body || ''), /Tianxing Bai1/);

  pushStatus(makeStatus({
    ...platformStatus,
    envName: 'Tianxing Bai',
    personaBound: false,
    auth: 'login required',
  }));
  await tick();
  (w.document.querySelector('#rail-guide') as HTMLElement).click();
  assert.match(w.document.querySelector('#guide-title')?.textContent || '', /Tianxing Bai1/);
});

test('环境昵称编辑支持 Escape 取消、空值清除人工名恢复系统名与失焦提交', async () => {
  const saved: Array<{ profileId: string; nickname: string }> = [];
  const { w } = await boot({
    saveEnvironmentNickname: async (args: { profileId: string; nickname: string }) => {
      saved.push(args);
      return { ok: true };
    },
  });
  const rowOf = (id: string) => w.document.querySelector(`.rail-row[data-env-id="${id}"]`) as HTMLElement;
  const open = (id: string) => {
    (rowOf(id).querySelector('.rail-name') as HTMLElement)
      .dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    return rowOf(id).querySelector('.rail-name-editor') as HTMLInputElement;
  };

  let input = open('ads-p1');
  input.value = '不会保存';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  await tick();
  assert.equal(saved.length, 0);
  assert.equal((rowOf('ads-p1').querySelector('.rail-name') as HTMLElement).textContent, '环境一');

  input = open('ads-p1');
  input.value = '临时人工名';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await tick();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal((rowOf('ads-p1').querySelector('.rail-name') as HTMLElement).textContent, '临时人工名');

  input = open('ads-p1');
  input.value = '   ';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await tick();
  await tick();
  assert.equal(saved.length, 2);
  assert.equal(saved[1]?.nickname, '');
  assert.equal((rowOf('ads-p1').querySelector('.rail-name') as HTMLElement).textContent, '环境一');
  assert.match(w.document.querySelector('#rail-msg')?.textContent || '', /已清除人工昵称.*恢复系统昵称/);

  input = open('ads-p2');
  input.value = '失焦保存号';
  input.dispatchEvent(new w.FocusEvent('blur'));
  await tick();
  await tick();
  assert.equal(saved.length, 3);
  assert.equal(saved[2]?.profileId, 'p2');
  assert.equal(saved[2]?.nickname, '失焦保存号');
});

test('人工昵称先乐观显示 pending，写盘失败后恢复原昵称与来源并提示原因', async () => {
  let finishSave: (value: unknown) => void = () => undefined;
  const saveResult = new Promise((resolve) => { finishSave = resolve; });
  const { w, pushFleet } = await boot({
    saveEnvironmentNickname: async () => saveResult,
  });
  const row = w.document.querySelector('.rail-row[data-env-id="ads-p1"]') as HTMLElement;
  (row.querySelector('.rail-name') as HTMLElement)
    .dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  const input = row.querySelector('.rail-name-editor') as HTMLInputElement;
  input.value = '本次人工名';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await tick();
  const pendingName = w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-name') as HTMLElement;
  assert.equal(pendingName.textContent, '本次人工名', '第一次 await 前应先乐观显示新昵称');
  assert.equal(w.document.querySelector('#acct-name')?.textContent, '本次人工名', '当前账号标题也应同步乐观更新');
  assert.equal(pendingName.classList.contains('pending'), true, '等待写盘期间必须与已保存态区分');
  assert.equal(pendingName.getAttribute('aria-busy'), 'true');
  assert.match(w.document.querySelector('#rail-msg')?.textContent || '', /正在保存/);

  pushFleet({
    provider: 'adspower',
    selectedEnvId: 'ads-p1',
    railCollapsed: false,
    environments: [{
      envId: 'ads-p1', profileId: 'p1', name: '环境一', platform: 'xiaohongshu',
      status: makeStatus({ envId: 'ads-p1', envName: '环境一' }),
    }],
  });
  await tick();
  assert.equal(
    w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-name')?.textContent,
    '本次人工名',
    'pending 期间旧 fleet 快照不得把乐观昵称弹回',
  );

  finishSave({ ok: false, error: '磁盘只读' });
  await tick();
  await tick();
  const rolledBack = w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-name') as HTMLElement;
  assert.equal(rolledBack.textContent, '环境一');
  assert.equal(w.document.querySelector('#acct-name')?.textContent, '环境一', '失败后当前账号标题也恢复原名');
  assert.equal(rolledBack.classList.contains('manual'), false, '原来源不是人工，失败后必须恢复来源');
  assert.equal(rolledBack.classList.contains('pending'), false);
  assert.match(w.document.querySelector('#rail-msg')?.textContent || '', /保存失败.*已恢复.*磁盘只读/);
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

test('Facebook 人设：发言语言只对 FB 展示、必选并按账号随生成请求提交', async () => {
  const requests: Array<{ envId: string; payload: { keywordSelections: string[]; writingLanguage?: string } }> = [];
  const status = makeStatus({ envId: 'ads-fb', envName: 'FB 账号', personaBound: false });
  const { w } = await boot({
    getStatus: async () => status,
    fleetGet: async () => ({
      provider: 'adspower',
      selectedEnvId: 'ads-fb',
      railCollapsed: false,
      environments: [{ envId: 'ads-fb', kind: 'adspower', profileId: 'fb', name: 'FB 账号', platform: 'facebook', status }],
    }),
    personaGenerate: async (envId: string, payload: { keywordSelections: string[]; writingLanguage?: string }) => {
      requests.push({ envId, payload });
      return { ok: true, soulYaml: 'writing_language: "en"', identitySummary: 'English persona' };
    },
  }, {
    adsProfileId: 'fb',
    adsProfileName: 'FB 账号',
    environments: [{ profileId: 'fb', name: 'FB 账号', platform: 'facebook' }],
  });

  (w.document.querySelector('.rail-row[data-env-id="ads-fb"] .rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-language-card')!.classList.contains('hidden'), false);
  assert.match(w.document.querySelector('#persona-language-help')!.textContent || '', /不改变 Facebook 界面语言/);

  (w.document.querySelector('.persona-kw-group[data-dim="content"] .kw-btn') as HTMLElement).click();
  (w.document.querySelector('#persona-generate') as HTMLButtonElement).click();
  await tick();
  assert.equal(requests.length, 0, '未选择发言语言不得请求云端生成');
  assert.match(w.document.querySelector('#persona-msg')!.textContent || '', /选择发言语言/);

  (w.document.querySelector('[data-writing-language="en"]') as HTMLElement).click();
  (w.document.querySelector('#persona-generate') as HTMLButtonElement).click();
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].envId, 'ads-fb');
  assert.equal(requests[0].payload.writingLanguage, 'en');
  assert.equal(requests[0].payload.keywordSelections.includes('en'), false, '结构化语言不得混进关键词数组');
  assert.match(w.document.querySelector('#persona-kw-summary-text')!.textContent || '', /发言语言：英文/);

  const { w: xhs } = await boot();
  (xhs.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(xhs.document.querySelector('#persona-language-card')!.classList.contains('hidden'), true, '小红书账号不得展示 FB 发言语言设置');
});

test('Facebook 人设：两个环境的未确认发言语言选择互不串号', async () => {
  const first = makeStatus({ envId: 'ads-fb1', envName: 'FB 一', personaBound: false });
  const second = makeStatus({ envId: 'ads-fb2', envName: 'FB 二', personaBound: false });
  const { w } = await boot({
    getStatus: async () => first,
    fleetGet: async () => ({
      provider: 'adspower', selectedEnvId: 'ads-fb1', railCollapsed: false,
      environments: [
        { envId: 'ads-fb1', kind: 'adspower', profileId: 'fb1', name: 'FB 一', platform: 'facebook', status: first },
        { envId: 'ads-fb2', kind: 'adspower', profileId: 'fb2', name: 'FB 二', platform: 'facebook', status: second },
      ],
    }),
  }, {
    adsProfileId: 'fb1',
    environments: [
      { profileId: 'fb1', name: 'FB 一', platform: 'facebook' },
      { profileId: 'fb2', name: 'FB 二', platform: 'facebook' },
    ],
  });

  (w.document.querySelector('.rail-row[data-env-id="ads-fb1"] .rail-persona') as HTMLElement).click();
  (w.document.querySelector('[data-writing-language="en"]') as HTMLElement).click();
  assert.equal(w.document.querySelector('[data-writing-language="en"]')!.classList.contains('active'), true);

  (w.document.querySelector('.rail-row[data-env-id="ads-fb2"] .rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelectorAll('#persona-language-group .kw-btn.active').length, 0, 'FB 二不得继承 FB 一未确认的英文选择');
  (w.document.querySelector('[data-writing-language="vi"]') as HTMLElement).click();

  (w.document.querySelector('.rail-row[data-env-id="ads-fb1"] .rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('[data-writing-language="en"]')!.classList.contains('active'), true, '切回 FB 一须恢复自己的英文选择');
  assert.equal(w.document.querySelector('[data-writing-language="vi"]')!.classList.contains('active'), false, 'FB 二的越南语不得串到 FB 一');
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
  assert.equal(w.document.querySelector('#persona-bound-note')!.classList.contains('hidden'), false, '更新中仍展示当前摘要，保存失败也不会抹掉现状');
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

test('人设浮层：引擎停止时展示当前摘要，更新失败仍保留原人设', async () => {
  const summary = {
    name: '林晓', role: '理性的职场观察者', background: '记录一线工作与真实选择。', tone: '专业理性',
    writingLanguage: null, primaryInterests: ['数据标注'], secondaryInterests: ['职场干货'],
    seedKeywords: ['工作选择'], likeAffinity: 'like_most',
  };
  const { w, pushStatus } = await boot({
    personaGet: async () => ({
      ok: true, state: 'configured',
      persona: { soulYaml: 'identity:\n  name: "林晓"', summary, updatedAt: '2026-07-20T00:00:00.000Z' },
    }),
    personaGenerate: async () => ({
      ok: true, soulYaml: 'identity:\n  name: "林晓二号"', identitySummary: '林晓二号', summary: { ...summary, name: '林晓二号' },
    }),
    personaPersist: async () => ({ ok: false, reason: 'persist_failed' }),
  });
  pushStatus(makeStatus({
    envId: 'ads-p1', envName: '环境一', edge: 'stopped', session: 'idle', cloud: 'disconnected', auth: 'checking',
  }));
  await tick();
  (w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-persona') as HTMLElement).click();
  await tick();

  assert.equal(w.document.querySelector('#persona-current-name')!.textContent, '林晓');
  assert.equal(w.document.querySelector('#persona-current-tone')!.textContent, '专业理性');
  assert.equal(w.document.querySelector('#persona-current-like')!.textContent, '更喜欢');
  assert.match(w.document.querySelector('#persona-current-tags')!.textContent || '', /数据标注/);
  assert.equal(w.document.querySelector('#persona-wizard-body')!.classList.contains('hidden'), true);

  (w.document.querySelector('#persona-update') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-bound-note')!.classList.contains('hidden'), false, '更新时原摘要继续可见');
  assert.equal(w.document.querySelector('.persona-kw-group[data-dim="tone"] [data-kw="专业理性"]')!.classList.contains('active'), true);
  assert.equal(w.document.querySelector('[data-kw="数据标注"]')!.classList.contains('active'), true, '可匹配的现有偏好应尽力预填');
  assert.equal(w.document.querySelector('[data-like-affinity="like_most"]')!.classList.contains('active'), true);

  (w.document.querySelector('#persona-generate') as HTMLElement).click();
  await tick();
  (w.document.querySelector('#persona-confirm') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-current-name')!.textContent, '林晓', '保存失败不得用新草稿覆盖当前摘要');
  assert.equal(w.document.querySelector('#persona-bound-note')!.classList.contains('hidden'), false);
  assert.match(w.document.querySelector('#persona-msg')!.textContent || '', /现有人设未改变/);
});

test('人设浮层：首次未绑定与普通读取失败使用不同空态', async () => {
  let reason = 'binding_unknown';
  const { w } = await boot({ personaGet: async () => ({ ok: false, reason }) });
  const icon = w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-persona') as HTMLElement;
  icon.click();
  await tick();
  assert.equal(w.document.querySelector('#persona-empty-title')!.textContent, '首次启动并登录一次');
  assert.equal(w.document.querySelector('#persona-state-badge')!.textContent, '待绑定');
  assert.equal(w.document.querySelector('#persona-empty-action')!.textContent, '打开浏览器完成首次登录');

  reason = 'cloud_unreachable';
  (w.document.querySelector('#persona-close') as HTMLElement).click();
  icon.click();
  await tick();
  assert.equal(w.document.querySelector('#persona-empty-title')!.textContent, '暂时连不上云端');
  assert.equal(w.document.querySelector('#persona-empty-action')!.textContent, '重试');
});

test('人设浮层：切换环境后丢弃前一个环境的晚返回', async () => {
  let resolveFirst!: (value: unknown) => void;
  let resolveSecond!: (value: unknown) => void;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const second = new Promise((resolve) => { resolveSecond = resolve; });
  const { w } = await boot({ personaGet: async (envId: string) => envId === 'ads-p1' ? first : second });
  (w.document.querySelector('.rail-row[data-env-id="ads-p1"] .rail-persona') as HTMLElement).click();
  (w.document.querySelector('.rail-row[data-env-id="ads-p2"] .rail-persona') as HTMLElement).click();
  resolveSecond({
    ok: true, state: 'configured',
    persona: { soulYaml: 'name: B', summary: { name: '环境 B 人设' }, updatedAt: null },
  });
  await tick();
  assert.equal(w.document.querySelector('#persona-current-name')!.textContent, '环境 B 人设');
  resolveFirst({
    ok: true, state: 'configured',
    persona: { soulYaml: 'name: A', summary: { name: '环境 A 人设' }, updatedAt: null },
  });
  await tick();
  assert.equal(w.document.querySelector('#persona-current-name')!.textContent, '环境 B 人设', 'A 的晚返回不得覆盖 B');
  assert.match(w.document.querySelector('#persona-pop-env')!.textContent || '', /环境二/);
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

test('无 envId 的旧形状 / 空名册 → 环境栏进入专用创建空态并直达新建环境', async () => {
  const { w, pushStatus } = await boot({
    fleetGet: undefined,
    onFleetUpdate: undefined,
    getStatus: async () => makeStatus(),
  }, { environments: [], adsProfileId: 'u1' });
  pushStatus(makeStatus({ stats: { views: 7, likes: 0, collects: 0, comments: 0, follows: 0, publishes: 0 } }));
  await tick();
  assert.equal(w.document.body.classList.contains('environment-roster-empty'), true, '右侧工作区必须与左栏共享零环境真态');
  const onboarding = w.document.querySelector('#environment-onboarding')!;
  assert.equal(onboarding.getAttribute('aria-hidden'), 'false');
  assert.match(onboarding.textContent || '', /创建环境[\s\S]*登录账号[\s\S]*开始运行/);
  assert.equal(onboarding.querySelectorAll('.environment-onboarding-steps > li').length, 3);
  const primary = w.document.querySelector('#environment-onboarding-create') as HTMLButtonElement;
  assert.equal(primary.tagName, 'BUTTON', '创建主操作使用原生按钮，键盘语义不另造');
  assert.equal(primary.type, 'button');
  for (const id of ['#legacy-workspace', '#interaction-workspace', '#content-workspace']) {
    assert.equal(w.document.querySelector(id)!.classList.contains('environment-roster-suppressed'), true, `${id} 由同一零环境状态原子收口`);
  }
  const rail = w.document.querySelector('#env-rail')!;
  // 环境栏常驻显示（用户要求「左边栏默认展示」）：空名册也保留栏、强制展开、露出添加入口。
  assert.equal(rail.classList.contains('hidden'), false, '空名册也常驻显示环境栏');
  assert.equal(rail.classList.contains('expanded'), true, '空名册强制展开露出空态');
  assert.equal(rail.classList.contains('empty-roster'), true, '只有权威全量花名册为空才进入首次空态');
  assert.equal(w.document.querySelectorAll('.rail-row').length, 0, '空名册无环境行');
  const empty = w.document.querySelector('#rail-list .rail-empty') as HTMLButtonElement;
  assert.ok(empty, '空态给「创建第一个运行环境」入口');
  assert.match(empty.textContent || '', /创建第一个运行环境/);
  assert.equal(empty.querySelector('.rail-dot'), null, '创建占位卡不伪装真实状态点');
  assert.equal(empty.querySelector('.env-ava'), null, '创建占位卡不伪装平台头像');
  primary.click();
  assert.equal(w.document.querySelector('#env-add-panel')!.classList.contains('open'), true);
  assert.equal(w.document.querySelector('#env-tab-create')!.classList.contains('active'), true, '右侧主按钮直达新建环境');
  assert.equal(w.document.querySelector('#env-tab-create-body')!.classList.contains('hidden'), false);
});

test('第一个真实环境进入权威花名册后退出整页引导并恢复环境身份', async () => {
  const { w, pushFleet } = await boot({
    fleetGet: async () => ({ provider: 'adspower', selectedEnvId: null, railCollapsed: false, environments: [] }),
    getStatus: async () => makeStatus({ lastMessage: 'environment_not_owned' }),
  }, { environments: [], adsProfileId: '' });
  assert.equal(w.document.body.classList.contains('environment-roster-empty'), true);
  assert.equal(w.document.querySelector('#environment-onboarding')!.getAttribute('aria-hidden'), 'false');

  pushFleet({
    provider: 'adspower',
    selectedEnvId: 'ads-first',
    railCollapsed: false,
    environments: [{
      envId: 'ads-first', profileId: 'first', name: '第一个环境', platform: 'facebook',
      status: makeStatus({ envId: 'ads-first', envName: '第一个环境', edge: 'stopped', session: 'idle' }),
    }],
  });
  await tick();
  assert.equal(w.document.body.classList.contains('environment-roster-empty'), false, '只在真实花名册出现环境后退出引导');
  assert.equal(w.document.querySelector('#environment-onboarding')!.getAttribute('aria-hidden'), 'true');
  for (const id of ['#legacy-workspace', '#interaction-workspace', '#content-workspace']) {
    assert.equal(w.document.querySelector(id)!.classList.contains('environment-roster-suppressed'), false, `${id} 恢复自己的正常显示状态`);
  }
  assert.match(w.document.querySelector('#acct-name')!.textContent || '', /第一个环境/);
  assert.equal(w.document.querySelector('#acct-plat')!.textContent, 'Facebook');
  assert.equal(w.document.querySelectorAll('.rail-row[data-env-id="ads-first"]').length, 1);
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

test('引导处理流：排队一次一个、窗口前置成功静默、恢复后自动前进直至完成', async () => {
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
  // 打开窗口成功后保持安静；失败才展示原因。
  (w.document.querySelector('#guide-open') as HTMLElement).click();
  await tick();
  assert.equal(calls.showDriven.length, 1);
  assert.equal(calls.showDrivenOptions[0], undefined, '登录引导仍需浏览器自身保持前台');
  assert.equal(w.document.querySelector('#guide-hint')!.textContent, '');
  assert.equal(w.document.querySelector('#guide-hint')!.classList.contains('hidden'), true);
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

test('全部启动：启动排队有界接收，超出部分如实提示且不再提供内存 force 绕过', async () => {
  let callCount = 0;
  const { w } = await boot({
    fleetStartAll: async () => {
      callCount += 1;
      return { ok: true, queued: 2, rejected: 2, queueLimit: 2, envIds: ['ads-p1', 'ads-p2'] };
    },
  });
  (w.document.querySelector('#rail-toggle') as HTMLElement).click();
  (w.document.querySelector('#rail-start-all') as HTMLElement).click();
  await tick();
  assert.equal(callCount, 1, '只发一次可审计的启动请求，不做 force 重试');
  assert.equal(w.document.querySelector('#rail-ram-confirm'), null, '动态内存确认与 force 入口应移除');
  assert.match(w.document.querySelector('#rail-msg')!.textContent!, /2 个未加入|另 2 个/);
});

test('全部启动进度：edge running 不提前计数，待任务或运行才完成', async () => {
  const starting = (envId: string) => makeStatus({
    envId,
    edge: 'running',
    automationState: 'starting',
    engineLinkState: 'connecting',
    browserState: 'starting',
  });
  const environments = [
    { envId: 'env-a', profileId: 'a', name: '环境 A', platform: 'xiaohongshu', status: starting('env-a') },
    { envId: 'env-b', profileId: 'b', name: '环境 B', platform: 'xiaohongshu', status: starting('env-b') },
  ];
  const { w, pushStatus } = await boot({
    fleetGet: async () => ({ provider: 'adspower', selectedEnvId: 'env-a', railCollapsed: false, environments }),
    fleetStartAll: async () => ({ ok: true, queued: 2, envIds: ['env-a', 'env-b'] }),
  }, {
    railCollapsed: false,
    environments: environments.map((env) => ({ profileId: env.profileId, name: env.name, platform: env.platform })),
  });

  (w.document.querySelector('#rail-start-all') as HTMLButtonElement).click();
  await tick();
  assert.match(w.document.querySelector('#rail-msg')!.textContent!, /0\/2/, '核心虽存活，启动/连接阶段仍是 0/2');

  pushStatus(makeStatus({ envId: 'env-a', automationState: 'ready', engineLinkState: 'connected', browserState: 'ready' }));
  await tick();
  assert.match(w.document.querySelector('#rail-msg')!.textContent!, /1\/2/, '浏览器就绪的待任务环境计入完成');

  pushStatus(makeStatus({ envId: 'env-b', automationState: 'running', engineLinkState: 'connected', browserState: 'closed' }));
  await tick();
  assert.match(w.document.querySelector('#rail-msg')!.textContent!, /2 个环境开始自动化/, '真实运行完成批次');
});

test('平台筛选：默认全部；切换后列表、计数、选中环境与全部启动范围同步', async () => {
  const environments = [
    { envId: 'ads-xhs', profileId: 'xhs', name: '小红书一', platform: 'xiaohongshu', status: makeStatus({ envId: 'ads-xhs', envName: '小红书一' }) },
    { envId: 'ads-fb', profileId: 'fb', name: 'Facebook 一', platform: 'fb', status: makeStatus({ envId: 'ads-fb', envName: 'Facebook 一' }) },
    { envId: 'ads-wc', profileId: 'wc', name: '视频号一', platform: 'wechat-channels', status: makeStatus({ envId: 'ads-wc', envName: '视频号一' }) },
  ];
  const { w, calls } = await boot({
    fleetGet: async () => ({ provider: 'adspower', selectedEnvId: 'ads-xhs', railCollapsed: false, environments }),
  });

  const buttons = (platform: string) => w.document.querySelector(`[data-rail-platform="${platform}"]`) as HTMLButtonElement;
  assert.equal(buttons('all').getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelectorAll('.rail-row').length, 3);
  assert.equal(w.document.querySelector('#rail-count')!.textContent, '3');

  (w.document.querySelector('#rail-start-all') as HTMLButtonElement).click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.startAll[0])), { envIds: ['ads-xhs', 'ads-fb', 'ads-wc'] }, '默认全部必须传完整花名册范围');

  buttons('facebook').click();
  await tick();
  assert.equal(w.document.querySelectorAll('.rail-row').length, 1);
  assert.equal((w.document.querySelector('.rail-row') as HTMLElement).dataset.envId, 'ads-fb');
  assert.equal(w.document.querySelector('#rail-count')!.textContent, '1');
  assert.deepEqual(calls.select.at(-1), 'ads-fb', '当前选中环境被过滤掉时切到首个可见环境');
  (w.document.querySelector('#rail-start-all') as HTMLButtonElement).click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.startAll[1])), { envIds: ['ads-fb'] }, 'Facebook 筛选不得启动其他平台');

  buttons('wechat_channels').click();
  await tick();
  assert.equal((w.document.querySelector('.rail-row') as HTMLElement).dataset.envId, 'ads-wc');
  assert.deepEqual(calls.select.at(-1), 'ads-wc');
  buttons('xiaohongshu').click();
  await tick();
  assert.equal((w.document.querySelector('.rail-row') as HTMLElement).dataset.envId, 'ads-xhs');
});

test('Facebook 筛选入口打开批量人设页面；人工选择预览后才提交同一模板', async () => {
  const previews: unknown[] = [];
  const fills: string[] = [];
  let singleGenerateCalls = 0;
  const { w } = await boot({
    fleetGet: async () => ({
      provider: 'adspower', selectedEnvId: 'ads-fb', railCollapsed: false,
      environments: [
        { envId: 'ads-fb', profileId: 'fb', name: 'Facebook', platform: 'facebook', status: makeStatus({ envId: 'ads-fb', personaBound: true }) },
      ],
    }),
    personaGenerate: async () => { singleGenerateCalls += 1; return { ok: false }; },
    facebookPersonaTemplatePreview: async (selection: unknown) => {
      previews.push(selection);
      return { ok: true, soulYaml: 'same-selected-soul', identitySummary: '同一份批量人设' };
    },
    facebookPersonaFillSelected: async (soulYaml: string) => {
      fills.push(soulYaml);
      return { ok: true, accepted: true };
    },
  });
  const wrap = w.document.querySelector('#rail-facebook-persona-fill') as HTMLElement;
  assert.equal(wrap.classList.contains('hidden'), true);
  (w.document.querySelector('[data-rail-platform="facebook"]') as HTMLButtonElement).click();
  await tick();
  assert.equal(wrap.classList.contains('hidden'), false);
  assert.equal(w.document.querySelector('#rail-facebook-persona-language'), null, '环境栏不再重复选择语言');

  (w.document.querySelector('#rail-facebook-persona-submit') as HTMLButtonElement).click();
  await tick();
  const pop = w.document.querySelector('#persona-pop') as HTMLElement;
  assert.equal(pop.classList.contains('hidden'), false);
  assert.match(w.document.querySelector('#persona-head-title')!.textContent!, /批量设置人设/);
  assert.match(w.document.querySelector('#persona-hint')!.textContent!, /同一份完全相同的人设|这一份完全相同的人设/);
  assert.equal(w.document.querySelector('#persona-bound-note')!.classList.contains('hidden'), true, '即使当前环境已有人设，批量模式仍展示选择页');

  (w.document.querySelector('.persona-kw-group[data-dim="tone"] .kw-btn') as HTMLButtonElement).click();
  (w.document.querySelector('#persona-language-group [data-writing-language="en"]') as HTMLButtonElement).click();
  (w.document.querySelector('.persona-kw-group[data-dim="content"] .kw-btn') as HTMLButtonElement).click();
  (w.document.querySelector('#persona-generate') as HTMLButtonElement).click();
  await tick();
  assert.equal(singleGenerateCalls, 0, '批量模式不得调用单账号/Cloud PersonaGenerator');
  assert.equal(previews.length, 1);
  const selected = previews[0] as { writingLanguage?: string; contentPreferences?: string[] };
  assert.equal(selected.writingLanguage, 'en');
  assert.ok((selected.contentPreferences || []).length > 0);
  assert.match(w.document.querySelector('#persona-draft-body')!.textContent!, /same-selected-soul/);

  (w.document.querySelector('#persona-confirm') as HTMLButtonElement).click();
  await tick();
  assert.deepEqual(fills, ['same-selected-soul']);
  assert.equal(pop.classList.contains('hidden'), true);
  assert.match(w.document.querySelector('#rail-facebook-persona-status')!.textContent!, /所选人设已交由云端/);
  (w.document.querySelector('[data-rail-platform="all"]') as HTMLButtonElement).click();
  await tick();
  assert.equal(wrap.classList.contains('hidden'), true);
});

test('批量人设确认失败留在人设页面诚实说明，不伪报已设置', async () => {
  const { w } = await boot({
    fleetGet: async () => ({ provider: 'adspower', selectedEnvId: 'ads-fb', railCollapsed: false, environments: [
      { envId: 'ads-fb', profileId: 'fb', name: 'Facebook', platform: 'facebook', status: makeStatus({ envId: 'ads-fb' }) },
    ] }),
    facebookPersonaTemplatePreview: async () => ({ ok: true, soulYaml: 'same-selected-soul', identitySummary: '预览' }),
    facebookPersonaFillSelected: async () => ({ ok: false, accepted: false, message: '云端暂时未受理，请稍后重试。' }),
  });
  (w.document.querySelector('[data-rail-platform="facebook"]') as HTMLButtonElement).click();
  await tick();
  (w.document.querySelector('#rail-facebook-persona-submit') as HTMLButtonElement).click();
  (w.document.querySelector('.persona-kw-group[data-dim="tone"] .kw-btn') as HTMLButtonElement).click();
  (w.document.querySelector('#persona-language-group [data-writing-language="zh-CN"]') as HTMLButtonElement).click();
  (w.document.querySelector('.persona-kw-group[data-dim="content"] .kw-btn') as HTMLButtonElement).click();
  (w.document.querySelector('#persona-generate') as HTMLButtonElement).click();
  await tick();
  (w.document.querySelector('#persona-confirm') as HTMLButtonElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-pop')!.classList.contains('hidden'), false);
  assert.match(w.document.querySelector('#persona-msg')!.textContent!, /云端暂时未受理/);
  assert.doesNotMatch(w.document.querySelector('#persona-state-badge')!.textContent!, /已设置/);
});

test('平台筛选：空分类显示空态并禁用全部启动，不发无目标请求', async () => {
  const { w, calls } = await boot({
    fleetGet: async () => ({
      provider: 'adspower',
      selectedEnvId: 'ads-p1',
      railCollapsed: false,
      environments: [
        { envId: 'ads-p1', profileId: 'p1', name: '环境一', platform: 'xiaohongshu', status: makeStatus({ envId: 'ads-p1' }) },
      ],
    }),
  });
  (w.document.querySelector('[data-rail-platform="wechat_channels"]') as HTMLButtonElement).click();
  await tick();
  assert.equal(w.document.querySelector('#env-rail')!.classList.contains('empty-roster'), false, '局部筛选空不是首次零环境');
  assert.equal(w.document.querySelectorAll('.rail-row').length, 0);
  assert.match(w.document.querySelector('.rail-filter-empty')!.textContent!, /暂无视频号环境/);
  const startAll = w.document.querySelector('#rail-start-all') as HTMLButtonElement;
  const closeAll = w.document.querySelector('#rail-close-all') as HTMLButtonElement;
  assert.equal(startAll.disabled, true);
  assert.equal(closeAll.disabled, true);
  startAll.click();
  await tick();
  assert.equal(calls.startAll.length, 0);
});

test('平台筛选：启动排队拒绝只发送当前分类的一次请求', async () => {
  const requests: Array<{ envIds?: string[] }> = [];
  const { w } = await boot({
    fleetGet: async () => ({
      provider: 'adspower',
      selectedEnvId: 'ads-xhs',
      railCollapsed: false,
      environments: [
        { envId: 'ads-xhs', profileId: 'xhs', name: '小红书', platform: 'xiaohongshu', status: makeStatus({ envId: 'ads-xhs' }) },
        { envId: 'ads-fb', profileId: 'fb', name: 'Facebook', platform: 'facebook', status: makeStatus({ envId: 'ads-fb' }) },
      ],
    }),
    fleetStartAll: async (opts: { envIds?: string[] }) => {
      requests.push(opts);
      return { ok: true, queued: 0, rejected: 1, queueLimit: 4, envIds: [], rejectedEnvIds: ['ads-fb'] };
    },
  });
  (w.document.querySelector('[data-rail-platform="facebook"]') as HTMLButtonElement).click();
  await tick();
  (w.document.querySelector('#rail-start-all') as HTMLButtonElement).click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { envIds: ['ads-fb'] },
  ]);
  assert.match(w.document.querySelector('#rail-msg')!.textContent!, /1 个环境未加入|排队已满/);
});

test('平台筛选：全部关闭只提交当前分类，处理中可见且回执不冒充终态完成', async () => {
  const requests: Array<{ envIds?: string[] }> = [];
  let settleClose: (value: { ok: boolean; accepted: number; envIds: string[] }) => void = () => {
    assert.fail('close-all promise was not installed');
  };
  const { w } = await boot({
    fleetGet: async () => ({
      provider: 'adspower',
      selectedEnvId: 'ads-xhs',
      railCollapsed: false,
      environments: [
        { envId: 'ads-xhs', profileId: 'xhs', name: '小红书', platform: 'xiaohongshu', status: makeStatus({ envId: 'ads-xhs' }) },
        { envId: 'ads-fb', profileId: 'fb', name: 'Facebook', platform: 'facebook', status: makeStatus({ envId: 'ads-fb' }) },
      ],
    }),
    fleetCloseAll: async (opts: { envIds?: string[] }) => {
      requests.push(opts);
      return new Promise((resolve) => { settleClose = resolve; });
    },
  });
  (w.document.querySelector('[data-rail-platform="facebook"]') as HTMLButtonElement).click();
  await tick();
  const closeAll = w.document.querySelector('#rail-close-all') as HTMLButtonElement;
  closeAll.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ envIds: ['ads-fb'] }]);
  assert.equal(closeAll.disabled, true);
  assert.equal(closeAll.textContent, '关闭请求中…');
  assert.match(w.document.querySelector('#rail-msg')!.textContent!, /正在关闭 1 个环境/);
  settleClose({ ok: true, accepted: 1, envIds: ['ads-fb'] });
  await tick();
  await tick();
  assert.equal(closeAll.disabled, false);
  assert.equal(closeAll.textContent, '全部关闭');
  assert.match(w.document.querySelector('#rail-msg')!.textContent!, /已受理 1 个环境的关闭请求/);
  assert.doesNotMatch(w.document.querySelector('#rail-msg')!.textContent!, /全部.*已关闭|关闭完成/);
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

test('环境管理：点选多个环境累积加入、重复点选提示已加入、可移出', async () => {
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
  assert.match(w.document.querySelector('#ads-env-msg')!.textContent!, /已加入/);
  assert.doesNotMatch(w.document.querySelector('#ads-env-msg')!.textContent!, /客户端|花名册/);
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

test('环境栏「管理」打开环境管理；设置抽屉已精简', async () => {
  const { w } = await boot();
  // 左栏「管理」拉起独立浮层。
  assert.equal(w.document.querySelector('#env-add-panel')!.classList.contains('open'), false);
  (w.document.querySelector('#rail-add') as HTMLElement).click();
  const panel = w.document.querySelector('#env-add-panel')!;
  assert.equal(panel.classList.contains('open'), true, '「管理」打开环境管理');
  assert.equal(panel.getAttribute('aria-label'), '环境管理');
  assert.equal(w.document.querySelector('#env-tab-join')!.textContent!.trim(), '环境');
  assert.equal(w.document.querySelector('#env-tab-create')!.textContent!.trim(), '新建环境');
  assert.equal(w.document.querySelector('#env-tab-join')!.getAttribute('role'), 'tab');
  assert.equal(w.document.querySelector('#env-tab-join')!.getAttribute('aria-selected'), 'true', '有环境时管理入口默认打开环境列表');
  assert.equal(panel.classList.contains('hidden'), false, '打开必须移除 hidden（.hidden 是 !important，否则只见遮罩不见内容）');
  // 环境列表与人设向导都在左栏浮层里，不在设置抽屉 #drawer 里
  const drawer = w.document.querySelector('#drawer')!;
  assert.equal(drawer.contains(w.document.querySelector('#ads-env-list')), false, '环境列表不在设置抽屉');
  assert.equal(drawer.contains(w.document.querySelector('#persona-wizard-body')), false, '人设向导不在设置抽屉');
  // 人设向导在人设浮层里
  assert.equal(w.document.querySelector('#persona-pop')!.contains(w.document.querySelector('#persona-wizard-body')), true);
});

test('新建环境：平台卡片驱动既有平台真源，代理详细字段默认折叠且可按需展开', async () => {
  const { w } = await boot();
  (w.document.querySelector('#env-tab-create') as HTMLButtonElement).click();
  const platform = w.document.querySelector('#ads-platform') as HTMLSelectElement;
  const facebook = w.document.querySelector('[data-create-platform="facebook"]') as HTMLButtonElement;
  assert.equal(platform.value, 'xiaohongshu');
  assert.equal(w.document.querySelector('[data-create-platform="xiaohongshu"]')!.getAttribute('aria-checked'), 'true');
  facebook.click();
  assert.equal(platform.value, 'facebook', '视觉卡片只写回既有 #ads-platform 真源');
  assert.equal(facebook.getAttribute('aria-checked'), 'true');
  assert.equal(w.document.querySelector('#ads-fb-create-mode-field')!.classList.contains('hidden'), false, 'FB 才展示创建方式');
  const proxyConfig = w.document.querySelector('#ads-proxy-config')!;
  const proxyToggle = w.document.querySelector('#ads-proxy-toggle') as HTMLButtonElement;
  assert.equal(proxyConfig.classList.contains('hidden'), true, '首次主路径不常驻空代理字段');
  proxyToggle.click();
  assert.equal(proxyConfig.classList.contains('hidden'), false);
  assert.equal(proxyToggle.getAttribute('aria-expanded'), 'true');
});

test('新建环境：创建中锁住切页与关闭，失败后保留输入和错误', async () => {
  let settle: ((value: unknown) => void) | undefined;
  const pending = new Promise((resolve) => { settle = resolve; });
  const { w } = await boot({
    fleetGet: async () => ({ provider: 'adspower', selectedEnvId: null, railCollapsed: true, environments: [] }),
    getStatus: async () => makeStatus({ edge: 'stopped', session: 'idle' }),
    adsStatus: async () => ({ ok: true }),
    adsCreateEnv: async () => pending,
    adsTemplates: async () => [{ key: 'windows', label: 'Windows' }],
  }, { environments: [], adsProfileId: '', adsProfileName: '' });
  (w.document.querySelector('.rail-empty') as HTMLButtonElement).click();
  await tick();
  const template = w.document.querySelector('#ads-template') as HTMLSelectElement;
  template.value = 'windows';
  const create = w.document.querySelector('#ads-create') as HTMLButtonElement;
  create.click();
  await tick();
  const panel = w.document.querySelector('#env-add-panel')!;
  assert.equal(panel.classList.contains('is-creating'), true);
  assert.equal(create.disabled, true);
  assert.match(create.textContent || '', /正在创建/);
  assert.equal((w.document.querySelector('#env-tab-join') as HTMLButtonElement).disabled, true);
  (w.document.querySelector('#env-add-mask') as HTMLElement).click();
  assert.equal(panel.classList.contains('open'), true, '不可取消请求在途时遮罩不得丢失上下文');
  settle?.({ ok: false, error: '本地环境服务暂不可用' });
  await tick();
  await tick();
  assert.equal(panel.classList.contains('is-creating'), false);
  assert.equal(template.value, 'windows', '失败保留用户输入');
  assert.match(w.document.querySelector('#ads-create-msg')!.textContent || '', /创建失败.*本地环境服务暂不可用/);
  assert.equal(w.document.querySelector('#env-tab-create')!.classList.contains('active'), true, '失败不切走创建页');
});

test('新建环境：单个创建成功并进入花名册后切回环境列表，提示真实离线边界', async () => {
  const { w } = await boot({
    fleetGet: async () => ({ provider: 'adspower', selectedEnvId: null, railCollapsed: true, environments: [] }),
    getStatus: async () => makeStatus({ edge: 'stopped', session: 'idle' }),
    adsStatus: async () => ({ ok: true }),
    adsCreateEnv: async () => ({ ok: true, userId: 'new-1', name: '新环境', platform: 'xiaohongshu', osFamily: 'Windows', createdCount: 1 }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'new-1', name: '新环境', serialNumber: '1', groupName: '', proxy: '', platform: 'xiaohongshu' }] }),
    adsTemplates: async () => [{ key: 'windows', label: 'Windows' }],
  }, { environments: [], adsProfileId: '', adsProfileName: '' });
  (w.document.querySelector('.rail-empty') as HTMLButtonElement).click();
  await tick();
  const template = w.document.querySelector('#ads-template') as HTMLSelectElement;
  template.value = 'windows';
  (w.document.querySelector('#ads-create') as HTMLButtonElement).click();
  await tick();
  await tick();
  await tick();
  assert.equal(w.document.querySelector('#env-tab-join')!.classList.contains('active'), true);
  assert.equal(w.document.querySelector('#env-tab-join-body')!.classList.contains('hidden'), false);
  assert.match(w.document.querySelector('#ads-env-msg')!.textContent || '', /已创建并加入环境栏.*离线/);
  assert.match(w.document.querySelector('#ads-env-list')!.textContent || '', /新环境/);
});

test('环境管理：默认无复选框，批量代理按勾选顺序冻结目标并去密预览', async () => {
  const profiles = [
    { userId: 'p1', name: '环境一', serialNumber: '1', groupName: '', proxy: 'old:1', platform: 'xiaohongshu' },
    { userId: 'p2', name: '环境二', serialNumber: '2', groupName: '', proxy: 'old:2', platform: 'xiaohongshu' },
    { userId: 'p3', name: '环境三', serialNumber: '3', groupName: '', proxy: '无代理配置', platform: 'facebook' },
    { userId: 'p4', name: '环境四', serialNumber: '4', groupName: '', proxy: '无代理配置', platform: 'facebook' },
  ];
  const { w, calls } = await boot({
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles }),
    adsParseProxyLines: async () => ({
      ok: true,
      noProxy: false,
      proxies: [
        { proxyType: 'https', proxyHost: 'a.example', proxyPort: '8001', proxyUser: 'user-a', proxyPassword: 'secret-a' },
        { proxyType: 'https', proxyHost: 'b.example', proxyPort: '8002', proxyUser: 'user-b', proxyPassword: 'secret-b' },
      ],
    }),
  });
  (w.document.querySelector('#rail-add') as HTMLElement).click();
  await tick();
  await tick();
  assert.equal(w.document.querySelectorAll('.ads-env-check').length, 0, '普通管理态不常驻复选框');
  const normalText = w.document.querySelector('#ads-env-list')!.textContent || '';
  assert.match(normalText, /已加入/);
  assert.match(normalText, /未加入/);
  assert.doesNotMatch(normalText, /已加入客户端|花名册/);

  (w.document.querySelector('#ads-batch-proxy-toggle') as HTMLElement).click();
  const draft = w.document.querySelector('#ads-batch-proxy-text') as HTMLTextAreaElement;
  draft.value = 'temporary.example:8000';
  (w.document.querySelector('#ads-batch-proxy-toggle') as HTMLElement).click();
  assert.equal(w.document.querySelectorAll('.ads-env-check').length, 0, '取消后复选框消失');
  assert.equal(draft.value, '', '取消后清空临时代理输入');
  assert.equal(w.document.querySelector('#ads-batch-proxy-panel')!.classList.contains('hidden'), true);

  (w.document.querySelector('#ads-batch-proxy-toggle') as HTMLElement).click();
  const rows = [...w.document.querySelectorAll('.ads-env-item')] as HTMLElement[];
  const checkFor = (name: string) => rows.find((row) => row.textContent?.includes(name))!.querySelector('.ads-env-check') as HTMLInputElement;
  assert.equal(checkFor('环境一').disabled, true, '运行中环境不可勾选');
  checkFor('环境三').click();
  checkFor('环境二').click();
  checkFor('环境四').click();
  const proxyText = w.document.querySelector('#ads-batch-proxy-text') as HTMLTextAreaElement;
  proxyText.value = 'a.example:8001:user-a:secret-a\nb.example:8002:user-b:secret-b';
  proxyText.dispatchEvent(new w.Event('input'));
  await tick();
  await tick();
  const preview = w.document.querySelector('#ads-batch-proxy-preview')!.textContent || '';
  assert.match(preview, /3 个环境 · 2 条代理 · 其中 1 个环境复用代理/);
  assert.doesNotMatch(preview, /循环复用/);
  assert.ok(preview.indexOf('环境三 → a.example:8001') < preview.indexOf('环境二 → b.example:8002'), '映射顺序来自勾选顺序');
  assert.doesNotMatch(preview, /user-a|secret-a|user-b|secret-b/);

  (w.document.querySelector('#ads-batch-proxy-save') as HTMLButtonElement).click();
  for (let i = 0; i < 4; i += 1) await tick();
  assert.deepEqual(Array.from((calls.updateProxies[0] as { userIds: string[] }).userIds), ['p3', 'p2', 'p4']);
  assert.equal(w.document.querySelectorAll('.ads-env-check').length, 0, '全部成功后退出批量态');
  assert.equal(proxyText.value, '', '全部成功后清空一次性代理输入');
  assert.match(w.document.querySelector('#ads-env-msg')!.textContent || '', /已更新 3 个环境.*下次启动生效/);
});

test('环境管理：批量代理进度只接受当前请求的单调成功计数，失败后保留真实进度', async () => {
  const profiles = [
    { userId: 'p2', name: '环境二', serialNumber: '2', groupName: '', proxy: 'old:2', platform: 'xiaohongshu' },
    { userId: 'p3', name: '环境三', serialNumber: '3', groupName: '', proxy: 'old:3', platform: 'facebook' },
  ];
  let submitted: Record<string, unknown> | undefined;
  let finishUpdate!: (value: unknown) => void;
  const pendingUpdate = new Promise((resolve) => { finishUpdate = resolve; });
  const { w, pushBatchProxyProgress } = await boot({
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles }),
    adsParseProxyLines: async () => ({
      ok: true,
      noProxy: false,
      proxies: [{ proxyType: 'http', proxyHost: 'a.example', proxyPort: '8001', proxyUser: '', proxyPassword: '' }],
    }),
    adsUpdateEnvProxies: async (args: Record<string, unknown>) => {
      submitted = args;
      return pendingUpdate;
    },
  });
  (w.document.querySelector('#rail-add') as HTMLElement).click();
  await tick();
  await tick();
  (w.document.querySelector('#ads-batch-proxy-toggle') as HTMLElement).click();
  for (const check of [...w.document.querySelectorAll('.ads-env-check')] as HTMLInputElement[]) check.click();
  const proxyText = w.document.querySelector('#ads-batch-proxy-text') as HTMLTextAreaElement;
  proxyText.value = 'a.example:8001';
  proxyText.dispatchEvent(new w.Event('input'));
  await tick();
  await tick();
  (w.document.querySelector('#ads-batch-proxy-save') as HTMLButtonElement).click();
  await tick();
  const requestId = String(submitted?.requestId || '');
  assert.match(requestId, /^proxy-[a-z0-9]+-[a-z0-9]+$/);
  const label = w.document.querySelector('#ads-batch-proxy-progress-label')!;
  const bar = w.document.querySelector('#ads-batch-proxy-progress-bar') as HTMLProgressElement;
  assert.equal(label.textContent, '正在按顺序修改… 已完成 0/2');
  assert.equal((w.document.querySelector('#ads-batch-proxy-cancel') as HTMLButtonElement).disabled, true);
  assert.equal(proxyText.disabled, true, '执行中冻结一次性输入，避免可见内容与已提交计划不一致');

  pushBatchProxyProgress({ requestId: 'proxy-old-1', completedCount: 2, totalCount: 2 });
  assert.equal(label.textContent, '正在按顺序修改… 已完成 0/2', '旧请求进度不覆盖当前操作');
  pushBatchProxyProgress({ requestId, completedCount: 1, totalCount: 2 });
  assert.equal(label.textContent, '正在按顺序修改… 已完成 1/2');
  assert.equal(bar.value, 1);
  assert.equal(bar.max, 2);
  pushBatchProxyProgress({ requestId, completedCount: 0, totalCount: 2 });
  assert.equal(label.textContent, '正在按顺序修改… 已完成 1/2', '倒退计数被忽略');

  finishUpdate({
    ok: false,
    error: '第 2 个环境修改失败：AdsPower 拒绝',
    updatedCount: 1,
    failedIndex: 2,
    notAttemptedCount: 0,
    partial: true,
  });
  for (let i = 0; i < 4; i += 1) await tick();
  assert.equal(label.textContent, '已完成 1/2');
  assert.equal((w.document.querySelector('#ads-batch-proxy-cancel') as HTMLButtonElement).disabled, false);
  assert.equal(proxyText.disabled, false);
  assert.match(w.document.querySelector('#ads-batch-proxy-msg')!.textContent || '', /已完成 1\/2/);
});

test('环境管理：批量代理部分失败保留选择和输入', async () => {
  const profiles = [
    { userId: 'p2', name: '环境二', serialNumber: '2', groupName: '', proxy: 'old:2', platform: 'xiaohongshu' },
    { userId: 'p3', name: '环境三', serialNumber: '3', groupName: '', proxy: 'old:3', platform: 'facebook' },
  ];
  const secretInput = 'a.example:8001:user-a:secret-a';
  const { w } = await boot({
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles }),
    adsParseProxyLines: async () => ({
      ok: true,
      noProxy: false,
      proxies: [{ proxyType: 'http', proxyHost: 'a.example', proxyPort: '8001', proxyUser: 'user-a', proxyPassword: 'secret-a' }],
    }),
    adsUpdateEnvProxies: async () => ({
      ok: false,
      error: '第 2 个环境修改失败：AdsPower 拒绝',
      updatedCount: 1,
      failedIndex: 2,
      notAttemptedCount: 0,
      partial: true,
    }),
  });
  (w.document.querySelector('#rail-add') as HTMLElement).click();
  await tick();
  await tick();
  (w.document.querySelector('#ads-batch-proxy-toggle') as HTMLElement).click();
  for (const check of [...w.document.querySelectorAll('.ads-env-check')] as HTMLInputElement[]) check.click();
  const proxyText = w.document.querySelector('#ads-batch-proxy-text') as HTMLTextAreaElement;
  proxyText.value = secretInput;
  proxyText.dispatchEvent(new w.Event('input'));
  await tick();
  (w.document.querySelector('#ads-batch-proxy-save') as HTMLButtonElement).click();
  for (let i = 0; i < 4; i += 1) await tick();
  assert.equal(proxyText.value, secretInput, '部分失败不清空输入');
  assert.equal(w.document.querySelectorAll('.ads-env-check:checked').length, 2, '部分失败保留目标');
  const msg = w.document.querySelector('#ads-batch-proxy-msg')!.textContent || '';
  assert.match(msg, /已更新 1 个/);
  assert.doesNotMatch(msg, /user-a|secret-a|a\.example/);
});

test('单环境代理：快速粘贴经共享解析后回填，不自动保存', async () => {
  let parseInput: unknown;
  let saveCalls = 0;
  const { w } = await boot({
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({
      ok: true,
      profiles: [{ userId: 'p2', name: '环境二', serialNumber: '2', groupName: '', proxy: '无代理配置', platform: 'xiaohongshu', proxyConfig: { noProxy: true } }],
    }),
    adsParseProxyLines: async (input: unknown) => {
      parseInput = input;
      return {
        ok: true,
        noProxy: false,
        proxies: [{ proxyType: 'https', proxyHost: '171.236.167.102', proxyPort: '37900', proxyUser: 'gyGn1', proxyPassword: 'pw:tail' }],
      };
    },
    adsUpdateEnvProxy: async () => { saveCalls += 1; return { ok: true }; },
  });
  (w.document.querySelector('#rail-add') as HTMLElement).click();
  await tick();
  await tick();
  (w.document.querySelector('.ads-env-proxy') as HTMLElement).click();
  await tick();
  const type = w.document.querySelector('#proxy-pop-type') as HTMLSelectElement;
  type.value = 'https';
  type.dispatchEvent(new w.Event('change'));
  const quick = w.document.querySelector('#proxy-pop-quick') as HTMLTextAreaElement;
  quick.value = '171.236.167.102:37900:gyGn1:pw:tail';
  quick.dispatchEvent(new w.Event('change'));
  await tick();
  assert.equal((parseInput as { proxyType: string }).proxyType, 'https');
  assert.equal((parseInput as { proxyText: string }).proxyText, '171.236.167.102:37900:gyGn1:pw:tail');
  assert.equal((w.document.querySelector('#proxy-pop-host') as HTMLInputElement).value, '171.236.167.102');
  assert.equal((w.document.querySelector('#proxy-pop-port') as HTMLInputElement).value, '37900');
  assert.equal((w.document.querySelector('#proxy-pop-user') as HTMLInputElement).value, 'gyGn1');
  assert.equal((w.document.querySelector('#proxy-pop-pass') as HTMLInputElement).value, 'pw:tail');
  assert.equal(saveCalls, 0, '解析只回填，仍须用户显式保存');
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
  assert.equal(w.document.querySelector('#auth-label')!.textContent, '客户会话');
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

test('平台标识：添加环境列表中的视频号标签复用状态栏绿色，不回落到小红书红色', async () => {
  const { w } = await boot({
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({
      ok: true,
      profiles: [{
        userId: 'wx1',
        name: '视频号环境',
        serialNumber: '75',
        groupName: 'aidcp',
        proxy: '',
        platform: 'wechat_channels',
      }],
    }),
  }, { environments: [], adsProfileId: '', adsProfileName: '' });
  await tick();
  await tick();

  const chip = w.document.querySelector('.ads-env-item .env-plat') as HTMLElement;
  assert.ok(chip, '添加环境列表应渲染平台标签');
  assert.equal(chip.textContent, '视频号');
  assert.equal(chip.classList.contains('plat-wechat_channels'), true, 'renderer 平台类必须保留规范 wechat_channels id');
  assert.match(
    rendererCss,
    /\.env-plat\.plat-wechat_channels\s*\{[^}]*color:\s*var\(--plat-wechat\);[^}]*background:\s*#[0-9a-f]{6};[^}]*\}/i,
    '视频号标签必须用状态栏同源 --plat-wechat 文字色和专用浅绿背景',
  );
});

test('人设浮层：引擎停止仍可读写；生成后进预览页、「改关键词」回第一步草稿保留', async () => {
  const calls: Record<string, unknown[]> = { persist: [] };
  const { w, pushStatus } = await boot({
    personaGenerate: async () => ({ ok: true, soulYaml: 'soul: X', identitySummary: 'X 人设' }),
    personaPersist: async (envId: string) => { calls.persist.push(envId); return { ok: true, firstPostOnboarding: true }; },
  });
  const rowOf = (id: string) => [...w.document.querySelectorAll('.rail-row')].find((r) => (r as HTMLElement).dataset.envId === id) as HTMLElement;
  // 环境二未启动：Cloud 已有环境绑定且确认人设缺失，仍直接开放向导，不再要求启动 core。
  pushStatus(makeStatus({ envId: 'ads-p2', envName: '环境二', auth: 'checking', cloud: 'disconnected', edge: 'stopped', session: 'idle' }));
  await tick();
  (rowOf('ads-p2').querySelector('.rail-persona') as HTMLElement).click();
  await tick();
  assert.equal(w.document.querySelector('#persona-empty')!.classList.contains('hidden'), true, '引擎停止不再显示启动闸');
  assert.equal(w.document.querySelector('#persona-wizard-body')!.classList.contains('hidden'), false, '引擎停止仍开放人设向导');
  assert.equal(w.document.querySelector('#persona-state-badge')!.textContent, '未设置');
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

test('人设成长引导：长时放大撒花后用长时流光强调首轮预期，且支持 reduced motion', () => {
  assert.match(html, /mascot-celebration-512\.png/);
  assert.match(html, /<span class="pg-confetti"[^>]*>[\s\S]*?(?:<i><\/i>){10}[\s\S]*?<\/span>/);
  assert.match(rendererCss, /\.persona-growth\.play \.pg-mascot\s*\{\s*animation:\s*pg-mascot-scale 2100ms[^;]*260ms both;/);
  assert.match(rendererCss, /@keyframes pg-mascot-scale\s*\{[\s\S]*scale\(1\.12\)[\s\S]*\}/);
  assert.match(rendererCss, /\.persona-growth\.play \.pg-confetti i\s*\{[^}]*animation-duration:\s*1250ms;[^}]*animation-delay:\s*calc\(300ms \+ var\(--pg-delay, 0ms\)\);/);
  assert.match(rendererCss, /\.pg-expectation::after\s*\{[^}]*width:\s*72%;/, '文字流光带应覆盖足够长的范围');
  assert.match(rendererCss, /\.persona-growth\.play \.pg-expectation::after\s*\{\s*animation:\s*pg-expectation-shimmer 5600ms[^;]*2680ms both;/);
  const shimmerFrames = rendererCss.match(/@keyframes pg-expectation-shimmer\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(shimmerFrames, /translateX/);
  assert.doesNotMatch(shimmerFrames, /translateY|scale\(/, '文字流光不得再做弹跳或缩放');
  assert.doesNotMatch(rendererCss, /\.persona-growth\.play \.pg-mascot[^}]*infinite/);
  assert.match(rendererCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.persona-growth\.play \.pg-mascot[\s\S]*\.persona-growth\.play \.pg-expectation::after\s*\{[\s\S]*animation:\s*none;/);
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

test('自动化暂停后关闭表达停止意图，不退化成独立浏览器操作', async () => {
  const { w, pushStatus, calls } = await boot();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', edge: 'stopped', cloud: 'disconnected', session: 'paused',
    coreState: 'stopped', cloudState: 'offline', automationState: 'paused', browserState: 'closed' }));
  await tick();
  const close = w.document.querySelector('#session-close') as HTMLElement;
  assert.equal(close.classList.contains('hidden'), false);
  close.click();
  await tick();
  await tick();
  assert.deepEqual(calls.browserClose, []);
  assert.deepEqual(calls.close, ['ads-p1']);
  assert.equal(w.document.querySelector('#session-fab')!.textContent, '启动');
  assert.equal(close.textContent, '浏览器');
  assert.equal(close.getAttribute('aria-label'), '打开浏览器');
});

test('任务已关闭时打开浏览器先显示处理中，不等待后台启动链返回', async () => {
  let settleOpen: (status: ReturnType<typeof makeStatus>) => void = () => {
    assert.fail('browser-open promise was not installed');
  };
  const { w, pushStatus, calls } = await boot({
    browserOpen: async (envId: string) => {
      calls.browserOpen.push(envId);
      return new Promise((resolve) => { settleOpen = resolve; });
    },
  });
  pushStatus(makeStatus({
    envId: 'ads-p1', envName: '环境一', edge: 'stopped', cloud: 'disconnected', session: 'closed',
    coreState: 'stopped', cloudState: 'offline', automationState: 'stopped', browserState: 'closed',
  }));
  await tick();
  const browser = w.document.querySelector('#session-close') as HTMLButtonElement;
  browser.click();
  assert.deepEqual(calls.browserOpen, ['ads-p1']);
  assert.equal(browser.disabled, true);
  assert.equal(browser.textContent, '浏览器开启中');
  assert.equal(browser.getAttribute('aria-label'), '正在打开浏览器');
  settleOpen(makeStatus({
    envId: 'ads-p1', envName: '环境一', edge: 'starting', cloud: 'disconnected', session: 'idle',
    coreState: 'starting', cloudState: 'connecting', automationState: 'stopped', browserState: 'starting',
  }));
  await tick();
  assert.equal(browser.disabled, true);
  assert.equal(browser.textContent, '浏览器开启中');
  pushStatus(makeStatus({
    envId: 'ads-p1', envName: '环境一', edge: 'running', cloud: 'connected', session: 'idle',
    coreState: 'online', cloudState: 'connected', automationState: 'stopped', browserState: 'ready',
  }));
  await tick();
  assert.equal(browser.disabled, false);
  assert.equal(browser.textContent, '浏览器');
  assert.equal(browser.getAttribute('aria-label'), '关闭浏览器');
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
  assert.equal(w.document.querySelector('#persona-state-badge')!.textContent, '待绑定', '未知态徽标须为「待绑定」，绝不谎称「未设置」');
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

test('人设浮层：云端权威说未绑 → 自动弹出并通知；偏好面板含三档点赞倾向且内容支持自定义', async () => {
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
  assert.match(cards[1].textContent || '', /发言语言/, 'Facebook 发言语言的固定位置必须在语气调性下方');
  assert.equal(cards[1].classList.contains('hidden'), true, '当前为小红书账号，发言语言面板必须隐藏');
  assert.match(cards[2].textContent || '', /点赞倾向/, '点赞倾向必须在平台语言面板之后');
  assert.match(cards[3].textContent || '', /内容偏好/, '内容偏好必须在点赞倾向之后');
  const affinityButtons = [...w.document.querySelectorAll('.persona-kw-group[data-dim="like-affinity"] .kw-btn')] as HTMLButtonElement[];
  assert.deepEqual(affinityButtons.map((button) => button.textContent), ['正常', '喜欢', '更喜欢']);
  assert.equal(affinityButtons[0].classList.contains('active'), true, '正常档必须默认选中');
  assert.match(cards[2].textContent || '', /不会强制点赞/, '面板必须解释倾向不是强制点赞');
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
  affinityButtons[2].click();
  assert.equal(affinityButtons[0].classList.contains('active'), false, '三档必须单选互斥');
  assert.equal(affinityButtons[2].classList.contains('active'), true);
  (w.document.querySelector('#persona-generate') as HTMLElement).click();
  await tick();
  assert.equal(generateCalls.length, 1);
  assert.deepEqual(generateCalls[0].payload.keywordSelections.includes('招聘求职'), true, '选择内容偏好时应带上行业标题');
  assert.deepEqual(generateCalls[0].payload.keywordSelections.includes('直播招聘'), true, '自定义兴趣应进入生成关键词');
  assert.deepEqual(generateCalls[0].payload.keywordSelections.includes('like_affinity:like_most'), true, '更喜欢档应以受控标记进入生成请求');
  assert.match(w.document.querySelector('#persona-kw-summary')!.textContent || '', /点赞倾向：更喜欢/, '预览摘要应显示中文档位');
});

test('人设浮层：内容偏好选满 24 项后原位拒绝第 25 项，取消后可继续选择和添加自定义项', async () => {
  const { w, pushStatus } = await boot();
  pushStatus(makeStatus({ envId: 'ads-p1', envName: '环境一', personaBound: false }));
  await tick();

  const contentButtons = [...w.document.querySelectorAll(
    '.persona-kw-group[data-dim="content"] .kw-btn:not(.custom)',
  )] as HTMLButtonElement[];
  assert.ok(contentButtons.length > 25, '测试目录应至少提供 25 个内容偏好');
  contentButtons.slice(0, 24).forEach((button) => button.click());

  const count = w.document.querySelector('#persona-content-count')!;
  const message = w.document.querySelector('#persona-content-limit-msg')!;
  assert.equal(count.textContent, '已选 24/24');
  assert.equal(count.classList.contains('at-limit'), true);

  contentButtons[24].click();
  assert.equal(w.document.querySelectorAll('.persona-kw-group[data-dim="content"] .kw-btn.active').length, 24);
  assert.equal(contentButtons[24].classList.contains('active'), false, '第 25 项不得进入选择集');
  assert.equal(contentButtons[24].classList.contains('limit-rejected'), true, '被拒绝的框应在原位标红');
  assert.equal(contentButtons[24].getAttribute('aria-invalid'), 'true');
  assert.equal(message.textContent, '最多选择 24 个内容偏好，请先取消一个再选择');
  assert.equal(message.classList.contains('active'), true);

  contentButtons[0].click();
  assert.equal(count.textContent, '已选 23/24');
  assert.equal(message.textContent, '', '取消任意已选项应清除限制提示');
  contentButtons[24].click();
  assert.equal(contentButtons[24].classList.contains('active'), true, '释放名额后可选择刚才被拒绝的项');
  assert.equal(count.textContent, '已选 24/24');

  const firstGroup = w.document.querySelector('.persona-pref-group')!;
  (firstGroup.querySelector('.persona-add-custom') as HTMLButtonElement).click();
  const input = firstGroup.querySelector('.persona-custom-input') as HTMLInputElement;
  const customRow = firstGroup.querySelector('.persona-custom-row')!;
  input.value = '直播招聘';
  (firstGroup.querySelector('.persona-custom-add') as HTMLButtonElement).click();
  assert.equal(input.value, '直播招聘', '达到上限时应保留用户输入');
  assert.equal(w.document.activeElement, input, '达到上限时焦点应留在输入框');
  assert.equal(customRow.classList.contains('hidden'), false, '达到上限时输入行不得收起');
  assert.equal(customRow.classList.contains('limit-rejected'), true, '自定义输入行应原位标红');
  assert.equal(firstGroup.querySelector('.kw-btn[data-kw="直播招聘"]'), null);

  contentButtons[1].click();
  (firstGroup.querySelector('.persona-custom-add') as HTMLButtonElement).click();
  const customButton = firstGroup.querySelector('.kw-btn.custom[data-kw="直播招聘"]');
  assert.ok(customButton?.classList.contains('active'), '释放名额后应成功添加自定义项');
  assert.equal(input.value, '');
  assert.equal(count.textContent, '已选 24/24');
  assert.equal(message.textContent, '');
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

test('首次空态样式：隐藏无意义筛选、汇总和批量运行区，但保留创建入口', () => {
  const w = cssWindow();
  const d = w.document;
  const rail = d.querySelector('#env-rail') as HTMLElement;
  rail.classList.remove('collapsed', 'hidden');
  rail.classList.add('expanded', 'empty-roster');
  d.querySelector('#rail-sum')!.classList.remove('hidden');
  assert.equal(w.getComputedStyle(d.querySelector('#rail-platform-filter') as HTMLElement).display, 'none');
  assert.equal(w.getComputedStyle(d.querySelector('#rail-sum') as HTMLElement).display, 'none');
  assert.equal(w.getComputedStyle(d.querySelector('.rail-foot') as HTMLElement).display, 'none');
  const empty = d.createElement('button');
  empty.className = 'rail-empty';
  d.querySelector('#rail-list')!.appendChild(empty);
  assert.notEqual(w.getComputedStyle(empty).display, 'none', '创建占位卡仍可见');
});

test('完整首次引导样式：旧环境工作区与身份不可见，只保留全局能力和创建主路径', () => {
  const w = cssWindow();
  const d = w.document;
  d.body.classList.add('environment-roster-empty');
  for (const workspace of d.querySelectorAll('#legacy-workspace, #interaction-workspace, #content-workspace')) {
    workspace.classList.add('environment-roster-suppressed');
  }
  assert.equal(w.getComputedStyle(d.querySelector('.acct') as HTMLElement).display, 'none', '旧环境身份不得显示');
  assert.equal(w.getComputedStyle(d.querySelector('#health-pill') as HTMLElement).display, 'none', '环境生命周期状态不得显示');
  assert.equal(w.getComputedStyle(d.querySelector('#legacy-workspace') as HTMLElement).display, 'none', '零值进展和内部原因码所在工作区整块隐藏');
  assert.equal(w.getComputedStyle(d.querySelector('#interaction-workspace') as HTMLElement).display, 'none');
  assert.equal(w.getComputedStyle(d.querySelector('#content-workspace') as HTMLElement).display, 'none');
  assert.equal(w.getComputedStyle(d.querySelector('#first-use-brand') as HTMLElement).display, 'flex', '标题栏改为中性首次使用身份');
  assert.equal(w.getComputedStyle(d.querySelector('#environment-onboarding') as HTMLElement).display, 'flex');
  assert.equal(w.getComputedStyle(d.querySelector('#cloud-env-chip') as HTMLElement).display === 'none', false, 'Cloud 环境仍是全局能力');
  assert.equal(w.getComputedStyle(d.querySelector('#gear') as HTMLElement).display === 'none', false, '设置仍可达');
  const create = d.querySelector('#environment-onboarding-create') as HTMLButtonElement;
  assert.equal(w.getComputedStyle(create).cursor, 'pointer');
  assert.match(rendererCss, /\.environment-onboarding-create:focus-visible\s*\{[^}]*outline:/s, '键盘焦点必须清晰可见');
  assert.match(rendererCss, /@media \(prefers-reduced-motion: reduce\)/, '减弱动态效果继续由全局规则保证');
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
