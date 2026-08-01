import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';

// 桌面外壳渲染层无头冒烟：用真实 index.html + ui-logic.js + renderer.js，在 jsdom 里注入 window.aidcpEdge 桩，
// 验证 AdsPower 探测 / 环境直接列表 / 点选带出 / 手动开关 / 高级折叠 / 保存不重启 / 悬浮三态 fab 等接线。
const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const styles = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');

test('客户端主体、活动流和开发者日志仅隐藏纵向滚动条', () => {
  const rule = styles.match(
    /html::-webkit-scrollbar:vertical,\s*body::-webkit-scrollbar:vertical,\s*\.stream-wrap::-webkit-scrollbar:vertical,\s*\.dev pre::-webkit-scrollbar:vertical\s*\{([^}]*)\}/s,
  );
  assert.ok(rule, '三个目标区域及文档滚动根必须共用纵向限定规则');
  assert.match(rule[1], /width:\s*0;/, '纵向轨道宽度必须归零');
  assert.doesNotMatch(rule[1], /height|display|scrollbar-width/, '不得连带隐藏或改变横向滚动条');
  assert.match(styles, /\.stream-wrap\s*\{[^}]*overflow-y:\s*auto;/s, '活动流必须继续原生纵向滚动');
  assert.match(styles, /\.dev pre\s*\{[^}]*overflow-y:\s*auto;/s, '开发者日志必须继续原生纵向滚动');
  assert.match(styles, /\.command-diagnostic-list::-webkit-scrollbar:vertical\s*\{[^}]*width:\s*0;/s, '命令列表只隐藏纵向滚动条');
  assert.match(styles, /\.command-diagnostic-list\s*\{[^}]*overflow-y:\s*auto;/s, '命令列表必须继续原生纵向滚动');
});
const environmentDisplayNameSrc = readFileSync(join(electronDir, 'renderer/environment-display-name.cjs'), 'utf8');
const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
const publishReviewLogicSrc = readFileSync(join(electronDir, 'renderer/publish-review-logic.js'), 'utf8');
const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');

// renderer 装了 1s 走字 interval：测试结束统一 close 掉所有 jsdom window，防止句柄挂住测试进程。
const openWindows: DOMWindow[] = [];
after(() => {
  for (const w of openWindows) w.close();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeStatus(over: Record<string, unknown> = {}) {
  return {
    clientSessionState: 'ready',
    auth: 'checking',
    cloud: 'disconnected',
    session: 'idle',
    risk: 'normal',
    edge: 'stopped',
    stats: { views: 0, likes: 0, collects: 0 },
    provider: 'adspower',
    lastMessage: '',
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

interface Stub {
  onStatusUpdate: (cb: (s: unknown) => void) => void;
  onFleetUpdate?: (cb: (snapshot: unknown) => void) => void;
  getStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  pause: () => Promise<unknown>;
  resume: () => Promise<unknown>;
  close: () => Promise<unknown>;
  browserOpen: () => Promise<unknown>;
  browserClose: () => Promise<unknown>;
  start: () => Promise<unknown>;
  restart: () => Promise<unknown>;
  relogin: () => Promise<unknown>;
  openAdsDownload: () => void;
  showDrivenBrowser: (envId?: string, opts?: { keepClientForeground?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  resetBrowserParking: () => Promise<{ ok: boolean; error?: string }>;
  adsStatus: (opts?: unknown) => Promise<{ ok: boolean; error?: string }>;
  adsListProfiles: (opts?: unknown) => Promise<unknown>;
  adsParseProxyLines: (opts?: unknown) => Promise<unknown>;
  adsUpdateEnvProxies: (opts?: unknown) => Promise<unknown>;
  adsOpenCreate: () => { launched: boolean } | Promise<{ launched: boolean }>;
  adsTemplates: () => Promise<Array<{ key: string; label: string }>>;
  adsCreateEnv: (opts?: unknown) => Promise<{ ok: boolean; userId?: string; name?: string; template?: string; osFamily?: string; error?: string; createdCount?: number; created?: unknown[]; platform?: string; visibilityWarning?: string; requiresAdminAssignment?: boolean; assignmentHandledByMain?: boolean; rosterJoinedByMain?: boolean; runMode?: string; operationModeConfigured?: boolean; slowStartConfigured?: boolean; ruleModeConfigured?: boolean; consumptionModeConfigured?: boolean; commentApprovalConfigured?: boolean }>;
  adsDeleteEnv: (opts?: unknown) => Promise<{ ok: boolean; error?: string; cleanupPending?: boolean; message?: string }>;
  adsGetEnvProxy: (opts?: unknown) => Promise<{ ok: boolean; noProxy?: boolean; proxy?: Record<string, unknown>; error?: string }>;
  adsUpdateEnvProxy: (opts?: unknown) => Promise<{ ok: boolean; error?: string }>;
  setSlowStart: (opts: { envKey: string; enabled: boolean }) => Promise<unknown>;
  // 不依赖边缘的慢启动读（change slow-start-offline-toggle）：可选——不提供即模拟老客户端退化路径。
  getSlowStart?: (opts: { envKey: string }) => Promise<unknown>;
  setFacebookOperationPolicy?: (opts: {
    envKey: string;
    expectedRevision: number;
    mode: 'persona' | 'slow_start' | 'rule' | 'consumption';
  }) => Promise<unknown>;
  getFacebookOperationPolicy?: (opts: { envKey: string }) => Promise<unknown>;
  setFacebookPrimarySurface?: (opts: {
    envKey: string;
    expectedRevision: number;
    primarySurface: 'feed' | 'reels';
  }) => Promise<unknown>;
  setFacebookRuleMode?: (opts: { envKey: string; enabled: boolean }) => Promise<unknown>;
  getFacebookRuleMode?: (opts: { envKey: string }) => Promise<unknown>;
  getEnvironmentRisk?: (opts: { envKey: string }) => Promise<unknown>;
  recoverEnvironmentRisk?: (opts: { envKey: string }) => Promise<unknown>;
  getEnvironmentRiskRecoveryResult?: (opts: { envKey: string; commandId: string }) => Promise<unknown>;
  getEnvironmentOverview?: (envId: string) => Promise<unknown>;
  fleetGet?: () => Promise<unknown>;
  fleetSelect?: (envId: string) => Promise<unknown>;
}

test('客户首页概览：自动化与浏览器均停止时仍通过 HTTP 展示今日进展和最近发布', async () => {
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({
      envId: 'p1', edge: 'stopped', session: 'idle', browserState: 'closed', stats: { views: 999 },
    }),
    getEnvironmentOverview: async (envId) => ({
      ok: true,
      data: {
        data: {
          envKey: envId,
          dailyUsage: {
            asOf: 1_721_277_200_000,
            totals: { view: 17, search: 2, like: 2, collect: 1, comment: 3, follow: 0, publish: 1 },
            quotas: { view: 35, search: 10, like: 6, collect: 3, comment: 1, follow: 2, publish: 1 },
          },
          currentPublishState: null,
          lastPublished: { title: '云端确认的上一篇', at: 1_721_200_000_000 },
        },
        meta: { asOf: 1_721_277_200_000 },
      },
    }),
  }));
  for (let i = 0; i < 4; i++) await tick();
  assert.equal($(w, '#views').textContent, '17', '不得回落本机事件计数 999');
  assert.equal($(w, '#searches').textContent, '2', '浏览器/引擎停止时仍展示 HTTP 确认搜索次数');
  assert.equal($(w, '#searches-cap').textContent, '/10');
  assert.match($(w, '#usage-source').textContent || '', /账号今日/);
  assert.match($(w, '#pub-card').textContent || '', /云端确认的上一篇/);
});

test('客户首页概览：重启后 submitted 覆盖本地旧 lastPublish', async () => {
  const requestedEnvIds: string[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({
      envId: 'ads-k1e0awu5',
      publish: null,
      lastPublish: { title: 'Claude被封 企业AI稳才是核心', at: '2026-07-13T05:53:27.047Z' },
    }),
    getEnvironmentOverview: async (envId) => {
      requestedEnvIds.push(envId);
      return {
        ok: true,
        data: {
          data: {
            envKey: envId,
            dailyUsage: { asOf: 1_752_989_057_000, totals: { view: 0, like: 0, collect: 0, comment: 0, follow: 0, publish: 1 } },
            currentPublishState: {
              state: 'submitted',
              code: '#160',
              title: '4090跑122B大模型实测对比',
              at: 1_752_989_057_000,
            },
            lastPublished: { title: 'Claude被封 企业AI稳才是核心', at: 1_752_378_807_047 },
          },
          meta: { asOf: 1_752_989_057_000 },
        },
      };
    },
  }));
  for (let i = 0; i < 4; i++) await tick();

  const card = $(w, '#pub-card');
  assert.deepEqual(requestedEnvIds, ['ads-k1e0awu5']);
  assert.equal(card.dataset.pubState, 'submitted');
  assert.equal(card.dataset.pubMode, 'submitted');
  assert.match(card.textContent || '', /4090跑122B大模型实测对比/);
  assert.match(card.textContent || '', /已提交，平台确认中/);
  assert.doesNotMatch(card.textContent || '', /Claude被封 企业AI稳才是核心/);
  assert.doesNotMatch(card.textContent || '', /已发布/);
});

test('客户首页概览：首次 HTTP 失败不显示假 0 或“还没有发布过”', async () => {
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ envId: 'p1', stats: { views: 0, likes: 0, collects: 0 } }),
    getEnvironmentOverview: async () => ({ ok: false, status: 503, error: 'request_failed' }),
  }));
  for (let i = 0; i < 4; i++) await tick();
  assert.equal($(w, '#views').textContent, '—');
  assert.match($(w, '#usage-source').textContent || '', /暂时无法获取/);
  assert.match($(w, '#pub-card').textContent || '', /暂时无法读取发布记录/);
  assert.doesNotMatch($(w, '#pub-card').textContent || '', /还没有发布过/);
});

test('客户首页概览：刷新失败保留上次确认数据并标记缓存', async () => {
  let calls = 0;
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ envId: 'p1' }),
    getEnvironmentOverview: async (envId) => {
      calls += 1;
      if (calls > 1) throw new Error('network_down');
      return {
        ok: true,
        data: {
          data: {
            envKey: envId,
            dailyUsage: { asOf: 1_721_277_200_000, totals: { view: 23, like: 0, collect: 0, comment: 0, follow: 0, publish: 1 } },
            currentPublishState: null,
            lastPublished: { title: '保留的已确认记录', at: 1_721_200_000_000 },
          },
          meta: { asOf: 1_721_277_200_000 },
        },
      };
    },
  }));
  for (let i = 0; i < 4; i++) await tick();
  const realNow = w.Date.now();
  w.Date.now = () => realNow + 6_000;
  w.dispatchEvent(new w.Event('focus'));
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(calls >= 2);
  assert.equal($(w, '#views').textContent, '23');
  assert.match($(w, '#usage-source').textContent || '', /缓存/);
  assert.match($(w, '#pub-card').textContent || '', /保留的已确认记录/);
});

function makeStub(overrides: Partial<Stub> = {}): Stub {
  const settings = { provider: 'adspower', adsProfileId: '', adsApiKey: '', adsApiBase: '', browserParkingMode: 'edge-strip', adsDownloadUrl: 'https://x' };
  return {
    onStatusUpdate: () => undefined,
    getStatus: async () => makeStatus(),
    getSettings: async () => settings,
    saveSettings: async () => ({ ...settings, saveOk: true }),
    pause: async () => makeStatus({ session: 'paused' }),
    resume: async () => makeStatus({ session: 'running', edge: 'running' }),
    close: async () => makeStatus({ session: 'closed', edge: 'stopped', cloud: 'disconnected' }),
    browserOpen: async () => makeStatus({ session: 'paused', edge: 'running', cloud: 'connected', automationState: 'paused', browserState: 'ready' }),
    browserClose: async () => makeStatus({ session: 'paused', edge: 'running', cloud: 'connected', automationState: 'paused', browserState: 'closed' }),
    start: async () => makeStatus({ edge: 'starting', session: 'running' }),
    restart: async () => makeStatus({ edge: 'starting', session: 'running' }),
    relogin: async () => makeStatus(),
    openAdsDownload: () => undefined,
    showDrivenBrowser: async () => ({ ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' }),
    resetBrowserParking: async () => ({ ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' }),
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    adsParseProxyLines: async () => ({ ok: false, error: '测试桩未配置代理解析' }),
    adsUpdateEnvProxies: async () => ({ ok: true, updatedCount: 0 }),
    adsOpenCreate: () => ({ launched: true }),
    adsTemplates: async () => [{ key: 'windows', label: 'Windows' }, { key: 'macos', label: 'macOS' }],
    adsCreateEnv: async () => ({ ok: true, osFamily: 'windows' }),
    adsDeleteEnv: async () => ({ ok: true }),
    adsGetEnvProxy: async () => ({ ok: false, error: '测试桩未配置精确代理读取' }),
    adsUpdateEnvProxy: async () => ({ ok: true }),
    setSlowStart: async () => ({ ok: false, data: { message: '测试桩未配置慢启动写入' } }),
    ...overrides,
  };
}

async function boot(stub: Stub): Promise<DOMWindow> {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  openWindows.push(window);
  // jsdom 还没有完整实现 <dialog>；补齐真实浏览器会提供的最小 open/close 语义，供渲染接线测试。
  Object.defineProperty(window.HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(window.HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function close(this: HTMLDialogElement, returnValue = '') {
      this.returnValue = returnValue;
      this.removeAttribute('open');
      this.dispatchEvent(new window.Event('close'));
    },
  });
  (window as unknown as { aidcpEdge: Stub }).aidcpEdge = stub;
  window.eval(environmentDisplayNameSrc);
  window.eval(uiLogicSrc); // 纯视图逻辑先注入（真实加载顺序同 index.html 的 <script> 顺序）
  window.eval(publishReviewLogicSrc);
  window.eval(rendererSrc);
  for (let i = 0; i < 5; i++) await tick(); // flush getSettings→probe→auto refreshEnvs 链
  return window;
}

const $ = (w: DOMWindow, sel: string) => w.document.querySelector(sel) as unknown as HTMLElement;
const $$ = (w: DOMWindow, sel: string) => Array.from(w.document.querySelectorAll(sel)) as unknown as HTMLElement[];
const hidden = (el: HTMLElement) => el.classList.contains('hidden');

test('中文化：新增控件文案齐全', () => {
  // 环境管理与人设已搬到左栏浮层；设置抽屉只剩浏览器引擎 + 窗口停放 + 开发者开关。
  for (const s of ['浏览器引擎', '本机 Chrome', '环境管理', '新建环境', '批量代理', '刷新', '手动填写', '创建环境', '账号人设', '窗口停放', '主屏停放', '副屏停放', '边缘停放', '完全移出', '指纹浏览器高级设置']) {
    assert.ok(html.includes(s), `index.html 应含「${s}」`);
  }
});

test('开发者详情：旧状态为空态，结构化命令展示诚实阶段且不进入活动流', async () => {
  const legacy = await boot(makeStub({ getStatus: async () => makeStatus() }));
  assert.match($(legacy, '#command-diagnostic-list').textContent || '', /当前环境暂无引擎命令/);

  const now = Date.now();
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({
      envId: 'env-command-a',
      envName: '环境 A',
      commandDiagnostics: [{
        key: '1234abcd',
        type: 'interaction.comment',
        stage: 'dispatched',
        summary: '评论正文 8 字',
        receivedAt: now - 1_000,
        updatedAt: now,
      }],
    }),
  }));
  const item = w.document.querySelector('[data-command-key="1234abcd"]') as unknown as HTMLElement;
  assert.ok(item);
  assert.match(item.textContent || '', /评论/);
  assert.match(item.textContent || '', /已交给执行器/);
  assert.match(item.textContent || '', /评论正文 8 字/);
  assert.match($(w, '#dev-section').textContent || '', /不代表平台成功/);
  assert.doesNotMatch($(w, '#activity-stream').textContent || '', /已交给执行器|interaction\.comment/);
});

test('开发者详情：命令按当前环境隔离，非法或过期状态不渲染', async () => {
  let pushStatus: ((status: unknown) => void) | undefined;
  const now = Date.now();
  const statusFor = (envId: string, key: string, summary: string) => makeStatus({
    envId,
    envName: `环境 ${envId}`,
    commandDiagnostics: [{
      key,
      type: envId === 'A' ? 'browse.next' : 'publish.command',
      stage: envId === 'A' ? 'dispatched' : 'rejected',
      summary,
      receivedAt: now - 1_000,
      updatedAt: now,
    }, {
      key: 'ffffffff',
      type: 'search.execute',
      stage: 'received',
      summary: '过期命令',
      receivedAt: now - 31 * 60 * 1_000,
      updatedAt: now - 31 * 60 * 1_000,
    }, {
      key: 'bad-key',
      type: 'search.execute',
      stage: 'received',
      summary: '非法命令',
      receivedAt: now,
      updatedAt: now,
    }],
  });
  const w = await boot(makeStub({
    onStatusUpdate: (cb) => { pushStatus = cb; },
    getStatus: async () => statusFor('A', 'aaaaaaaa', 'A 环境命令'),
  }));
  assert.match($(w, '#command-diagnostic-list').textContent || '', /A 环境命令/);
  assert.doesNotMatch($(w, '#command-diagnostic-list').textContent || '', /过期命令|非法命令/);

  pushStatus?.(statusFor('B', 'bbbbbbbb', 'B 环境命令'));
  await tick();
  assert.match($(w, '#command-diagnostic-list').textContent || '', /A 环境命令/);
  assert.doesNotMatch($(w, '#command-diagnostic-list').textContent || '', /B 环境命令/);

  const rowB = w.document.querySelector('.rail-row[data-env-id="B"]') as unknown as HTMLElement;
  assert.ok(rowB);
  rowB.dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.match($(w, '#command-diagnostic-list').textContent || '', /B 环境命令/);
  assert.doesNotMatch($(w, '#command-diagnostic-list').textContent || '', /A 环境命令/);
});

test('探测就绪 → 静默自动列出环境（无徽标、无需先点刷新）', async () => {
  const w = await boot(makeStub({
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: '无代理配置' }] }),
  }));
  const items = $$(w, '.ads-env-item');
  assert.equal(items.length, 1, '就绪后应自动列出环境行');
  assert.match(items[0].textContent ?? '', /甲/);
});

test('环境代理编辑：遮罩预填现有密码，只改 host 后仍原样提交密码', async () => {
  let readArgs: Record<string, unknown> | undefined;
  let submitted: Record<string, unknown> | undefined;
  const w = await boot(makeStub({
    adsListProfiles: async () => ({
      ok: true,
      profiles: [{
        userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'socks5 · old.example',
        proxyConfig: {
          noProxy: false,
          proxyType: 'socks5',
          proxyHost: 'old.example',
          proxyPort: '1080',
          proxyUser: 'alice',
        },
      }],
    }),
    adsGetEnvProxy: async (opts) => {
      readArgs = opts as Record<string, unknown>;
      return {
        ok: true,
        noProxy: false,
        proxy: {
          proxyType: 'socks5',
          proxyHost: 'old.example',
          proxyPort: '1080',
          proxyUser: 'alice',
          proxyPassword: 'S3cr3t!',
        },
      };
    },
    adsUpdateEnvProxy: async (opts) => {
      submitted = opts as Record<string, unknown>;
      return { ok: true };
    },
  }));

  $$(w, '.ads-env-proxy')[0].click();
  await tick();
  assert.equal(readArgs?.userId, 'u1', '必须按点击行的精确 userId 读取密码');
  const password = $(w, '#proxy-pop-pass') as HTMLInputElement;
  assert.equal(password.type, 'password', '密码应预填但保持遮罩显示');
  assert.equal(password.value, 'S3cr3t!');

  ($(w, '#proxy-pop-host') as HTMLInputElement).value = 'new.example';
  $(w, '#proxy-save').click();
  await tick();

  assert.equal(submitted?.userId, 'u1');
  assert.deepEqual(JSON.parse(JSON.stringify(submitted?.proxy)), {
    proxyType: 'socks5',
    proxyHost: 'new.example',
    proxyPort: '1080',
    proxyUser: 'alice',
    proxyPassword: 'S3cr3t!',
  });
});

test('环境代理编辑：精确读取失败时保持浮层关闭并展示真实原因', async () => {
  const w = await boot(makeStub({
    adsListProfiles: async () => ({
      ok: true,
      profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'socks5 · old.example' }],
    }),
    adsGetEnvProxy: async () => ({ ok: false, error: '该环境不属于当前客户，已拒绝读取代理配置。' }),
  }));
  $$(w, '.ads-env-proxy')[0].click();
  await tick();
  assert.ok($(w, '#proxy-pop').classList.contains('hidden'));
  assert.match($(w, '#ads-env-msg').textContent || '', /不属于当前客户/);
});

test('探测不可达 → 环境行诚实提示（无徽标），不禁死', async () => {
  const w = await boot(makeStub({ adsStatus: async () => ({ ok: false, error: 'ECONNREFUSED' }) }));
  assert.match($(w, '#ads-env-msg').textContent ?? '', /暂未连接到本地指纹浏览器服务/);
});

test('点选环境行 → 分身 ID 带出 user_id（非 serial_number）', async () => {
  const w = await boot(makeStub({
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u_long', serialNumber: '7', name: '甲', groupName: 'g', proxy: 'p' }] }),
  }));
  const item = $$(w, '.ads-env-item')[0];
  item.dispatchEvent(new w.Event('click'));
  assert.equal(($(w, '#ads-profile') as HTMLInputElement).value, 'u_long');
  assert.match($(w, '#ads-profile-display').textContent ?? '', /u_long/);
  assert.ok(item.classList.contains('selected'));
});

test('手动填写开关：开→显示输入框、隐藏只读展示', async () => {
  const w = await boot(makeStub());
  const chk = $(w, '#ads-manual') as HTMLInputElement;
  chk.checked = true;
  chk.dispatchEvent(new w.Event('change'));
  assert.equal(hidden($(w, '#ads-profile')), false);
  assert.equal(hidden($(w, '#ads-profile-display')), true);
});

test('高级设置默认折叠，点开展开', async () => {
  const w = await boot(makeStub());
  assert.equal(hidden($(w, '#ads-advanced')), true);
  $(w, '#ads-advanced-toggle').dispatchEvent(new w.Event('click'));
  assert.equal(hidden($(w, '#ads-advanced')), false);
});

test('分身 ID / 手动填写 收在「高级设置」内（结构）', () => {
  const dom = new JSDOM(html);
  const adv = dom.window.document.querySelector('#ads-advanced');
  assert.ok(adv?.querySelector('#ads-profile'), '#ads-profile 应在 #ads-advanced 内');
  assert.ok(adv?.querySelector('#ads-manual'), '#ads-manual 应在 #ads-advanced 内');
  assert.ok(adv?.querySelector('#ads-profile-display'), '#ads-profile-display 应在 #ads-advanced 内');
});

test('拉取失败 → 自动展开「高级设置」让手动填写可达', async () => {
  const w = await boot(makeStub({ adsListProfiles: async () => ({ ok: false, error: 'x' }) }));
  assert.equal(hidden($(w, '#ads-advanced')), false, '拉取失败应自动展开高级设置');
});

test('刷新失败(401)：诚实降级 + 提示已用当前填写值', async () => {
  const w = await boot(makeStub({
    adsListProfiles: async () => ({ ok: false, authLikely: true, error: 'HTTP 401' }),
  }));
  assert.match($(w, '#ads-env-msg').textContent ?? '', /本次刷新已用当前填写值/);
  assert.match($(w, '#ads-env-msg').textContent ?? '', /手动填写/);
});

test('无独立「保存」按钮；启动 = 先保存再启动', async () => {
  const calls: string[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' }] }),
    saveSettings: async () => { calls.push('save'); return { provider: 'adspower', adsProfileId: 'u1', saveOk: true }; },
    start: async () => { calls.push('start'); return makeStatus({ edge: 'starting', session: 'running' }); },
  }));
  assert.equal(w.document.querySelector('#save-settings'), null, '不应有独立「保存」按钮');
  $$(w, '.ads-env-item')[0].dispatchEvent(new w.Event('click')); // 加入环境 → 即时落盘（extra save，根治「加入后左栏不显示」）
  await tick();
  $(w, '#session-fab').dispatchEvent(new w.Event('click')); // 悬浮「启动」
  await tick();
  await tick();
  // 加入环境已即时落盘一次；启动再 save + start。收口契约：启动前必先 save。
  assert.deepEqual(calls.slice(-2), ['save', 'start'], '启动应先 save 再 start');
  assert.ok(calls.filter((c) => c === 'save').length >= 1);
});

test('启动前未选环境/未填分身 → 诚实提示，不 save 不 start', async () => {
  const calls: string[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }),
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    saveSettings: async () => { calls.push('save'); return { saveOk: true }; },
    start: async () => { calls.push('start'); return makeStatus(); },
  }));
  $(w, '#session-fab').dispatchEvent(new w.Event('click'));
  await tick();
  assert.deepEqual(calls, []);
  assert.match($(w, '#settings-msg').textContent ?? '', /环境管理/);
  assert.equal($(w, '#env-add-panel').classList.contains('open'), true, '提示应打开环境管理，避免启动按钮像没反应');
});

test('运行中改设置（窗口停放）→ 出现「按新设置重启」，点击先存再重启', async () => {
  // 环境增删已即时落盘（不走「按新设置重启」）；该按钮现用于 provider/窗口停放等仍需重启在跑核心的改动。
  const calls: string[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'running', session: 'running' }),
    saveSettings: async () => { calls.push('save'); return { provider: 'adspower', saveOk: true }; },
    restart: async () => { calls.push('restart'); return makeStatus({ edge: 'starting' }); },
  }));
  assert.equal(hidden($(w, '#apply-restart')), true, '未改动时不显示「按新设置重启」');
  $(w, '#parking-offscreen').dispatchEvent(new w.Event('click')); // 改窗口停放 → dirty
  assert.equal(hidden($(w, '#apply-restart')), false, '改动 + 运行中 → 显示');
  $(w, '#apply-restart').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.deepEqual(calls, ['save', 'restart'], '重启应先 save 再 restart');
});

test('self 模式：无分身校验，启动直接先存再起', async () => {
  const calls: string[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped', provider: 'self' }),
    getSettings: async () => ({ provider: 'self', adsProfileId: '', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x' }),
    saveSettings: async () => { calls.push('save'); return { provider: 'self', saveOk: true }; },
    start: async () => { calls.push('start'); return makeStatus({ provider: 'self', edge: 'starting' }); },
  }));
  $(w, '#session-fab').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.deepEqual(calls, ['save', 'start']);
});

test('窗口停放：旧设置缺值时默认主屏停放', async () => {
  const w = await boot(makeStub({
    getSettings: async () => ({ provider: 'adspower', adsProfileId: '', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x' }),
  }));
  assert.ok($(w, '#parking-primary-screen').classList.contains('active'));
});

test('窗口停放：选择完全移出后保存带 browserParkingMode', async () => {
  let savedPatch: { browserParkingMode?: string } = {};
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped', provider: 'self' }),
    getSettings: async () => ({ provider: 'self', adsProfileId: '', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x' }),
    saveSettings: async (patch) => { savedPatch = patch as { browserParkingMode?: string }; return { provider: 'self', saveOk: true }; },
    start: async () => makeStatus({ provider: 'self', edge: 'starting' }),
  }));
  $(w, '#parking-offscreen').dispatchEvent(new w.Event('click'));
  $(w, '#session-fab').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(savedPatch.browserParkingMode, 'offscreen');
});

test('冷待机开关：旧设置缺值时默认开启，保存时带 browserColdStandbyEnabled', async () => {
  let savedPatch: { browserColdStandbyEnabled?: boolean } = {};
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped', provider: 'self' }),
    getSettings: async () => ({ provider: 'self', adsProfileId: '', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x' }),
    saveSettings: async (patch) => { savedPatch = patch as { browserColdStandbyEnabled?: boolean }; return { provider: 'self', saveOk: true }; },
    start: async () => makeStatus({ provider: 'self', edge: 'starting' }),
  }));
  const toggle = $(w, '#browser-cold-standby') as HTMLInputElement;
  assert.equal(toggle.checked, true);
  toggle.checked = false;
  toggle.dispatchEvent(new w.Event('change'));
  $(w, '#session-fab').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(savedPatch.browserColdStandbyEnabled, false);
});

test('系统代理前置跳板默认关闭，离线切换立即保存并呈现双跳状态', async () => {
  const savedPatches: Array<{ systemProxyUpstreamEnabled?: boolean }> = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped', proxyChain: { state: 'ready' } }),
    getSettings: async () => ({
      provider: 'adspower',
      adsProfileId: 'u1',
      adsProfileName: '测试环境',
      environments: [{ profileId: 'u1', name: '测试环境', platform: 'xiaohongshu' }],
      adsApiKey: '',
      adsApiBase: '',
      adsDownloadUrl: 'x',
      systemProxyUpstreamEnabled: false,
    }),
    saveSettings: async (patch) => {
      savedPatches.push(patch as { systemProxyUpstreamEnabled?: boolean });
      return { provider: 'adspower', saveOk: true };
    },
    start: async () => makeStatus({ provider: 'adspower', edge: 'starting' }),
  }));
  const toggle = $(w, '#system-proxy-upstream') as HTMLInputElement;
  assert.equal(toggle.checked, false);
  assert.match($(w, '#system-proxy-upstream-hint').textContent ?? '', /直接连接环境代理/);
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change'));
  assert.match($(w, '#system-proxy-upstream-hint').textContent ?? '', /双跳中继已就绪/);
  await tick();
  assert.equal(savedPatches.at(-1)?.systemProxyUpstreamEnabled, true, '离线预检前必须先保存可见开关');
  $(w, '#session-fab').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(savedPatches.at(-1)?.systemProxyUpstreamEnabled, true);
});

test('系统代理前置跳板运行中立即保存目标模式，但实际模式保持到显式重启', async () => {
  const savedModes: boolean[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({
      edge: 'running',
      session: 'running',
      proxyMode: 'direct',
      proxyChain: null,
    }),
    getSettings: async () => ({
      provider: 'adspower',
      adsProfileId: 'u1',
      adsProfileName: '测试环境',
      environments: [{ profileId: 'u1', name: '测试环境', platform: 'facebook' }],
      adsApiKey: '',
      adsApiBase: '',
      adsDownloadUrl: 'x',
      systemProxyUpstreamEnabled: false,
    }),
    saveSettings: async (patch) => {
      savedModes.push(Boolean((patch as { systemProxyUpstreamEnabled?: boolean }).systemProxyUpstreamEnabled));
      return { provider: 'adspower', saveOk: true };
    },
  }));
  const toggle = $(w, '#system-proxy-upstream') as HTMLInputElement;
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change'));
  await tick();
  assert.deepEqual(savedModes, [true]);
  assert.equal(hidden($(w, '#apply-restart')), false, '目标双跳与当前直连代际不同时必须要求重启');
  assert.match($(w, '#system-proxy-upstream-hint').textContent ?? '', /当前运行中的环境仍为直连环境代理/);

  toggle.checked = false;
  toggle.dispatchEvent(new w.Event('change'));
  await tick();
  assert.deepEqual(savedModes, [true, false]);
  assert.equal(hidden($(w, '#apply-restart')), true, '切回当前代际实际模式后不应继续伪报待重启');
});

test('系统代理前置跳板对无代理环境不适用且不误报待重启', async () => {
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({
      edge: 'running',
      session: 'running',
      proxyMode: 'direct',
      proxyChainApplicable: false,
      proxyChain: null,
    }),
    getSettings: async () => ({
      provider: 'adspower',
      adsProfileId: 'u1',
      adsProfileName: '无代理环境',
      environments: [{ profileId: 'u1', name: '无代理环境', platform: 'facebook' }],
      adsApiKey: '',
      adsApiBase: '',
      adsDownloadUrl: 'x',
      systemProxyUpstreamEnabled: true,
    }),
    adsListProfiles: async () => ({
      ok: true,
      profiles: [{
        userId: 'u1',
        serialNumber: '1',
        name: '无代理环境',
        groupName: 'g',
        proxy: '无代理配置',
        proxyConfig: { noProxy: true },
      }],
    }),
  }));
  assert.equal(($(
    w,
    '#system-proxy-upstream',
  ) as HTMLInputElement).checked, true);
  assert.equal(hidden($(w, '#apply-restart')), true);
  assert.match($(w, '#system-proxy-upstream-hint').textContent ?? '', /当前环境未配置代理，双跳不适用/);
});

test('窗口停放：无可控浏览器时显示浏览器诚实失败', async () => {
  const w = await boot(makeStub({
    showDrivenBrowser: async () => ({ ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' }),
  }));
  $(w, '#browser-show').dispatchEvent(new w.Event('click'));
  await tick();
  assert.match($(w, '#settings-msg').textContent ?? '', /引擎未运行或浏览器尚未就绪，请先启动引擎再操作/);
});

test('今日进展生命周期控制：自动化和浏览器使用独立动作', async () => {
  const stopped = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'stopped' }) }));
  assert.equal($(stopped, '#rail-start-all').textContent, '全部启动');
  assert.equal($(stopped, '#session-fab').textContent, '启动');
  const closed = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'stopped', session: 'closed' }) }));
  assert.equal($(closed, '#session-fab').textContent, '启动');
  assert.equal($(closed, '#session-close').textContent, '浏览器');
  assert.equal($(closed, '#session-close').getAttribute('aria-label'), '打开浏览器');
  const running = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'running', session: 'running' }) }));
  assert.equal($(running, '#session-fab').textContent, '暂停');
  const resting = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'running', session: 'resting' }) }));
  assert.equal($(resting, '#session-fab').textContent, '暂停');
  const paused = await boot(makeStub({ getStatus: async () => makeStatus({ session: 'paused' }) }));
  assert.equal($(paused, '#session-fab').textContent, '恢复');
  assert.equal($(paused, '#session-close').textContent, '关闭');
  assert.equal($(paused, '#session-close').getAttribute('aria-label'), '关闭自动化');
  assert.ok(!$(paused, '#session-close').classList.contains('hidden'));
  const terminalError = await boot(makeStub({
    getStatus: async () => makeStatus({
      edge: 'warning', cloud: 'disconnected', automationState: 'error', browserState: 'error',
    }),
  }));
  assert.equal($(terminalError, '#session-fab').textContent, '启动');
  assert.equal($(terminalError, '#session-close').textContent, '关闭');
  assert.equal($(terminalError, '#session-close').getAttribute('aria-label'), '关闭自动化');
  assert.equal(($(terminalError, '#session-close') as HTMLElement).dataset.lifecycleAction, 'close');
  assert.equal(($(terminalError, '#session-close') as HTMLElement).dataset.browserAction, '');
  const executorError = await boot(makeStub({
    getStatus: async () => makeStatus({
      edge: 'running', coreState: 'online', cloud: 'connected', cloudState: 'connected', browserState: 'error',
    }),
  }));
  assert.equal($(executorError, '#session-close').textContent, '浏览器');
  assert.equal($(executorError, '#session-close').getAttribute('aria-label'), '重新打开浏览器');
  assert.equal(($(executorError, '#session-close') as HTMLElement).dataset.browserAction, 'open');
});

test('自动化终态错误点击关闭：结束本机自动化，不误走浏览器重开', async () => {
  let lifecycleCloses = 0;
  let browserOpens = 0;
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({
      edge: 'warning', cloud: 'disconnected', automationState: 'error', browserState: 'error',
    }),
    close: async () => {
      lifecycleCloses++;
      return makeStatus({
        edge: 'stopped', cloud: 'disconnected', session: 'closed', automationState: 'stopped', browserState: 'closed',
      });
    },
    browserOpen: async () => {
      browserOpens++;
      return makeStatus();
    },
  }));
  $(w, '#session-close').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(lifecycleCloses, 1);
  assert.equal(browserOpens, 0);
  assert.equal($(w, '#session-fab').textContent, '启动');
  assert.equal($(w, '#session-close').textContent, '浏览器');
});

test('自动化暂停态点击关闭：调用自动化关闭，不走浏览器辅助动作', async () => {
  let lifecycleCloses = 0;
  let browserCloses = 0;
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ session: 'paused', edge: 'stopped', cloud: 'disconnected', automationState: 'paused', browserState: 'closed' }),
    close: async () => { lifecycleCloses++; return makeStatus({ session: 'closed', edge: 'stopped', cloud: 'disconnected', automationState: 'stopped', browserState: 'closed' }); },
    browserClose: async () => { browserCloses++; return makeStatus(); },
  }));
  $(w, '#session-close').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(lifecycleCloses, 1);
  assert.equal(browserCloses, 0);
  assert.equal($(w, '#session-fab').textContent, '启动');
  assert.equal($(w, '#session-close').textContent, '浏览器');
  assert.equal($(w, '#session-close').getAttribute('aria-label'), '打开浏览器');
});

test('程序化建号：填充操作系统下拉、点「创建环境」→ 传选中 OS family、成功提示 + 刷新', async () => {
  let sentOsFamily = '';
  const w = await boot(makeStub({
    adsCreateEnv: async (opts) => {
      sentOsFamily = (opts as { osFamilyKey?: string }).osFamilyKey ?? '';
      return { ok: true, osFamily: sentOsFamily };
    },
  }));
  for (let i = 0; i < 3; i++) await tick(); // flush populateTemplates()
  const sel = $(w, '#ads-template') as unknown as HTMLSelectElement;
  assert.ok(sel.options.length >= 1, '操作系统下拉应被填充');
  assert.equal(sel.value, 'windows');

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(sentOsFamily, 'windows', '应把选中 OS family 传给 adsCreateEnv');
  assert.match($(w, '#ads-create-msg').textContent ?? '', /已创建环境/);
});

test('新增环境可选择视频号，并以 wechat_channels 创建、入册和持久化', async () => {
  let sent: Record<string, unknown> = {};
  let savedEnvironments: Array<{ profileId: string; name: string; platform: string }> = [];
  const w = await boot(makeStub({
    adsCreateEnv: async (opts) => {
      sent = opts as Record<string, unknown>;
      return { ok: true, userId: 'u_wechat', name: '视频号环境', osFamily: 'windows', platform: 'wechat_channels' };
    },
    saveSettings: async (patch) => {
      savedEnvironments = ((patch as { environments?: Array<{ profileId: string; name: string; platform: string }> }).environments || []);
      return { provider: 'adspower', environments: savedEnvironments, saveOk: true };
    },
  }));
  for (let i = 0; i < 3; i++) await tick();

  const platform = $(w, '#ads-platform') as HTMLSelectElement;
  assert.ok(Array.from(platform.options).some((option) => option.value === 'wechat_channels' && option.textContent === '视频号'));
  platform.value = 'wechat_channels';
  platform.dispatchEvent(new w.Event('change'));
  assert.ok($(w, '#ads-fb-import-wrap').classList.contains('hidden'), '视频号不显示 Facebook 一次性凭据框');
  assert.ok($(w, '#ads-fb-create-mode').classList.contains('hidden'), '视频号不显示 Facebook 批量入口');
  assert.ok($(w, '#ads-fb-run-mode-field').classList.contains('hidden'), '视频号不显示运行方式');
  assert.ok($(w, '#ads-fb-run-mode-wrap').classList.contains('hidden'), '视频号不显示全局免审');

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sent.platform, 'wechat_channels');
  assert.equal(sent.facebookAccountImport, '');
  assert.equal('facebookRunMode' in sent, false, '视频号提交不得携带运行方式');
  assert.equal('commentApprovalMode' in sent, false, '视频号提交不得携带免审意图');
  assert.equal(savedEnvironments.length, 1);
  assert.equal(savedEnvironments[0]?.profileId, 'u_wechat');
  assert.equal(savedEnvironments[0]?.name, '视频号环境');
  assert.equal(savedEnvironments[0]?.platform, 'wechat_channels');
  assert.equal(($(w, '#ads-profile') as HTMLInputElement).value, 'u_wechat');
  assert.match($(w, '#ads-create-msg').textContent ?? '', /已自动选中/);
});

test('Facebook 批量新建：显式模式、隐藏操作系统下拉、多行账号代理透传且成功回执不泄密', async () => {
  let sent: Record<string, unknown> = {};
  const secretLine = 'a@example.com----pw-secret----KEYSECRET----c_user=100000000000001; xs=TOKEN';
  const proxySecret = 'proxy.example:8080:proxy-user:proxy-pass';
  const w = await boot(makeStub({
    adsCreateEnv: async (opts) => {
      sent = opts as Record<string, unknown>;
      return {
        ok: true,
        createdCount: 2,
        created: [{ userId: 'u1', osFamily: 'windows' }, { userId: 'u2', osFamily: 'macos' }],
        platform: 'facebook',
        creationMode: 'batch',
        runMode: 'cold_start',
        operationModeConfigured: true,
        slowStartConfigured: true,
      };
    },
  }));
  for (let i = 0; i < 3; i++) await tick();
  assert.ok($(w, '#ads-fb-import-wrap').classList.contains('hidden'), '默认小红书不显示导入框');
  assert.ok($(w, '#ads-fb-create-mode').classList.contains('hidden'), '默认小红书不显示批量入口');

  const platform = $(w, '#ads-platform') as HTMLSelectElement;
  platform.value = 'facebook';
  platform.dispatchEvent(new w.Event('change'));
  assert.ok(!$(w, '#ads-fb-import-wrap').classList.contains('hidden'), 'Facebook 平台显示导入框');
  const facebookImportPlaceholder = ($(w, '#ads-fb-import') as HTMLTextAreaElement).placeholder;
  assert.match(facebookImportPlaceholder, /每行自动识别一种受支持格式/);
  assert.match(facebookImportPlaceholder, /uid\|password\|cookie\|access_token\|email\|timestamp/);
  assert.match(facebookImportPlaceholder, /uid\|password\|2FA\|email\|cookie\|access_token/);
  assert.match($(w, '#ads-fb-account-format-help').textContent ?? '', /未知或有歧义的格式会拒绝/);
  assert.match($(w, '#ads-fb-account-format-help').textContent ?? '', /Access Token.*不会导入或保存/);
  assert.doesNotMatch(
    $(w, '#ads-fb-account-format-help').textContent ?? '',
    /慢启动/,
    '账号格式说明不得再声称创建默认开启慢启动',
  );
  assert.ok(!$(w, '#ads-fb-create-mode').classList.contains('hidden'), 'Facebook 平台显示创建方式');
  assert.ok(!$(w, '#ads-template').classList.contains('hidden'), 'Facebook 单个新建仍显示操作系统');

  const mode = $(w, '#ads-fb-create-mode') as HTMLSelectElement;
  mode.value = 'batch';
  mode.dispatchEvent(new w.Event('change'));
  assert.ok($(w, '#ads-template').classList.contains('hidden'), '批量新建不可选择操作系统');
  assert.equal($(w, '#ads-create').textContent, '批量创建');
  assert.match($(w, '#ads-fb-import-requirement').textContent ?? '', /必填/);
  const runMode = $(w, '#ads-fb-run-mode') as HTMLSelectElement;
  runMode.value = 'cold_start';
  runMode.dispatchEvent(new w.Event('change'));
  ($(w, '#ads-fb-import') as HTMLTextAreaElement).value = `${secretLine}\n${secretLine}`;
  const proxyType = $(w, '#ads-proxy-type') as HTMLSelectElement;
  proxyType.value = 'socks5';
  proxyType.dispatchEvent(new w.Event('change'));
  assert.ok(!$(w, '#ads-proxy-batch-wrap').classList.contains('hidden'), '批量代理输入在选定类型后显示');
  ($(w, '#ads-proxy-batch') as HTMLTextAreaElement).value = `${proxySecret}\nproxy-b.example:8081`;

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(sent.platform, 'facebook');
  assert.equal(sent.creationMode, 'batch');
  assert.equal(sent.osFamilyKey, '', '批量模式不把渲染层 OS family 值交给主进程');
  assert.equal(sent.facebookAccountImport, `${secretLine}\n${secretLine}`);
  assert.equal(sent.batchProxyType, 'socks5');
  assert.equal(sent.facebookProxyBatch, `${proxySecret}\nproxy-b.example:8081`);
  assert.equal(sent.facebookRunMode, 'cold_start', '批量提交携带本批统一的运行方式');
  assert.equal('commentApprovalMode' in sent, false, '未勾选免审时不得携带审批模式字段');
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.match(msg, /已创建 2 个环境/);
  assert.match(msg, /轮询分配/);
  assert.match(msg, /已按冷启动为该环境配置慢启动.*只收紧每日操作额度.*不改变操作速度/);
  assert.doesNotMatch(msg, /a@example.com|pw-secret|KEYSECRET|TOKEN|proxy-user|proxy-pass/);
  assert.equal(($(w, '#ads-fb-import') as HTMLTextAreaElement).value, '', '成功后清空一次性输入');
  assert.equal(($(w, '#ads-proxy-batch') as HTMLTextAreaElement).value, '', '成功后清空一次性代理输入');
});

test('Facebook 批量部分失败：刷新已建环境并保留一次性输入供核对', async () => {
  let listCalls = 0;
  const accountSecret = 'a@example.com----pw-secret----KEYSECRET----c_user=100000000000001; xs=TOKEN';
  const proxySecret = 'proxy.example:8080:proxy-user:proxy-pass';
  const w = await boot(makeStub({
    adsListProfiles: async () => {
      listCalls += 1;
      return { ok: true, profiles: [] };
    },
    adsCreateEnv: async () => ({
      ok: false,
      error: '第 2 个账号创建失败：AdsPower 暂不可用；已创建 1 个环境，后续账号尚未创建',
      createdCount: 1,
      created: [{ userId: 'u1', osFamily: 'windows' }],
      failedIndex: 2,
      partial: true,
    }),
  }));
  const initialListCalls = listCalls;
  const platform = $(w, '#ads-platform') as HTMLSelectElement;
  platform.value = 'facebook';
  platform.dispatchEvent(new w.Event('change'));
  const mode = $(w, '#ads-fb-create-mode') as HTMLSelectElement;
  mode.value = 'batch';
  mode.dispatchEvent(new w.Event('change'));
  ($(w, '#ads-fb-import') as HTMLTextAreaElement).value = `${accountSecret}\n${accountSecret}`;
  const proxyType = $(w, '#ads-proxy-type') as HTMLSelectElement;
  proxyType.value = 'http';
  proxyType.dispatchEvent(new w.Event('change'));
  ($(w, '#ads-proxy-batch') as HTMLTextAreaElement).value = proxySecret;

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.match(msg, /批量创建未完成.*已创建 1 个环境/);
  assert.doesNotMatch(msg, /a@example.com|pw-secret|KEYSECRET|TOKEN|proxy-user|proxy-pass/);
  assert.equal(($(w, '#ads-fb-import') as HTMLTextAreaElement).value, `${accountSecret}\n${accountSecret}`);
  assert.equal(($(w, '#ads-proxy-batch') as HTMLTextAreaElement).value, proxySecret);
  assert.ok(listCalls > initialListCalls, '部分成功后刷新环境列表');
});

// ── 运行方式四选一 + 全局免审 ──

async function bootFacebookCreate(stub: Stub): Promise<DOMWindow> {
  const w = await boot(stub);
  for (let i = 0; i < 3; i++) await tick();
  const platform = $(w, '#ads-platform') as HTMLSelectElement;
  platform.value = 'facebook';
  platform.dispatchEvent(new w.Event('change'));
  return w;
}

test('运行方式和主浏览入口：只在 Facebook 出现，默认普通 + Reels', async () => {
  const w = await boot(makeStub());
  for (let i = 0; i < 3; i++) await tick();
  assert.ok($(w, '#ads-fb-run-mode-field').classList.contains('hidden'), '小红书不展示运行方式');
  assert.ok($(w, '#ads-fb-primary-surface-field').classList.contains('hidden'), '小红书不展示主浏览入口');
  assert.ok($(w, '#ads-fb-run-mode-wrap').classList.contains('hidden'), '小红书不展示免审入口');

  const platform = $(w, '#ads-platform') as HTMLSelectElement;
  platform.value = 'facebook';
  platform.dispatchEvent(new w.Event('change'));
  assert.ok(!$(w, '#ads-fb-run-mode-field').classList.contains('hidden'), 'Facebook 展示运行方式');
  assert.ok(!$(w, '#ads-fb-primary-surface-field').classList.contains('hidden'), 'Facebook 展示主浏览入口');
  assert.ok(!$(w, '#ads-fb-run-mode-wrap').classList.contains('hidden'), 'Facebook 展示免审入口');

  const runMode = $(w, '#ads-fb-run-mode') as HTMLSelectElement;
  assert.deepEqual(
    Array.from(runMode.options).map((option) => option.value),
    ['normal', 'cold_start', 'rule', 'consumption'],
  );
  assert.deepEqual(
    Array.from(runMode.options).map((option) => option.textContent),
    ['普通', '冷启动', '规则', '消费'],
  );
  assert.equal(runMode.multiple, false, '同一时刻只能选中一种运行方式');
  assert.equal(runMode.value, 'normal', '默认普通：不再写死慢启动');
  const surface = $(w, '#ads-fb-primary-surface') as HTMLSelectElement;
  assert.deepEqual(Array.from(surface.options).map((option) => option.value), ['feed', 'reels']);
  assert.equal(surface.value, 'reels', '新建 Facebook 环境默认 Reels');
  assert.equal(($(w, '#ads-fb-approval') as HTMLInputElement).checked, false, '全局免审默认关闭');

  // 未选冷启动不得追加解释性告警或 Tooltip：说明文字与选择无关，控件也不带 title。
  const helpBefore = $(w, '#ads-fb-run-mode-help').textContent;
  for (const value of ['rule', 'consumption', 'normal']) {
    runMode.value = value;
    runMode.dispatchEvent(new w.Event('change'));
    assert.equal($(w, '#ads-fb-run-mode-help').textContent, helpBefore, '运行方式说明不随选择变化');
    assert.equal(w.document.querySelectorAll('#ads-fb-run-mode-wrap [title], #ads-fb-run-mode-field [title]').length, 0);
    assert.equal($(w, '#ads-create-msg').textContent, '', '选择运行方式本身不产生任何提示');
  }
});

test('运行方式：默认普通提交不带任何开启意图，回执如实说明未配置慢启动', async () => {
  let sent: Record<string, unknown> = {};
  const w = await bootFacebookCreate(makeStub({
    adsCreateEnv: async (opts) => {
      sent = opts as Record<string, unknown>;
      return {
        ok: true,
        userId: 'u_normal',
        osFamily: 'windows',
        platform: 'facebook',
        runMode: 'normal',
        operationModeConfigured: true,
        assignmentHandledByMain: true,
        rosterJoinedByMain: true,
      };
    },
  }));
  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sent.facebookRunMode, 'normal');
  assert.equal(sent.facebookPrimarySurface, 'reels');
  assert.equal('slowStartEnabled' in sent, false, '普通不提交慢启动开启意图');
  assert.equal('facebookRuleModeEnabled' in sent, false, '普通不提交规则模式开启意图');
  assert.equal('commentApprovalMode' in sent, false, '未勾选免审不提交扩权意图');
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.match(msg, /该环境未配置慢启动。/);
  assert.doesNotMatch(msg, /默认开启慢启动/, '不得沿用旧的默认开启说法');
  assert.doesNotMatch(msg, /免审/, '未勾选免审时回执不出现任何免审声明');
  assert.doesNotMatch(msg, /规则模式/);
});

test('运行方式：选规则提交规则模式意图且不提交慢启动，回执分别如实呈现', async () => {
  let sent: Record<string, unknown> = {};
  const w = await bootFacebookCreate(makeStub({
    adsCreateEnv: async (opts) => {
      sent = opts as Record<string, unknown>;
      return {
        ok: true,
        userId: 'u_rule',
        osFamily: 'windows',
        platform: 'facebook',
        runMode: 'rule',
        operationModeConfigured: true,
        ruleModeConfigured: true,
        assignmentHandledByMain: true,
        rosterJoinedByMain: true,
      };
    },
  }));
  const runMode = $(w, '#ads-fb-run-mode') as HTMLSelectElement;
  runMode.value = 'rule';
  runMode.dispatchEvent(new w.Event('change'));
  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sent.facebookRunMode, 'rule');
  assert.equal('slowStartEnabled' in sent, false);
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.match(msg, /该环境未配置慢启动。/);
  assert.match(msg, /已按规则运行方式为该环境配置规则模式。/);
});

test('运行方式：选消费只提交消费模式意图，回执不在 Edge 展示或保存节奏数字', async () => {
  let sent: Record<string, unknown> = {};
  const w = await bootFacebookCreate(makeStub({
    adsCreateEnv: async (opts) => {
      sent = opts as Record<string, unknown>;
      return {
        ok: true,
        userId: 'u_consumption',
        osFamily: 'windows',
        platform: 'facebook',
        runMode: 'consumption',
        operationModeConfigured: true,
        consumptionModeConfigured: true,
        assignmentHandledByMain: true,
        rosterJoinedByMain: true,
      };
    },
  }));
  const runMode = $(w, '#ads-fb-run-mode') as HTMLSelectElement;
  runMode.value = 'consumption';
  runMode.dispatchEvent(new w.Event('change'));
  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sent.facebookRunMode, 'consumption');
  assert.equal('slowStartEnabled' in sent, false);
  assert.equal('facebookRuleModeEnabled' in sent, false);
  assert.equal('viewsPerLike' in sent, false);
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.match(msg, /已按消费运行方式为该环境配置消费模式/);
  assert.match(msg, /节奏由 Cloud 管理/);
  assert.doesNotMatch(msg, /每浏览|每.*点赞|5|2/);
});

test('全局免审：批量勾选一次对全批一致生效，云端确认后才标记已配置', async () => {
  let sent: Record<string, unknown> = {};
  const w = await bootFacebookCreate(makeStub({
    adsCreateEnv: async (opts) => {
      sent = opts as Record<string, unknown>;
      return {
        ok: true,
        createdCount: 3,
        created: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }],
        platform: 'facebook',
        runMode: 'normal',
        operationModeConfigured: true,
        commentApprovalConfigured: true,
      };
    },
  }));
  const mode = $(w, '#ads-fb-create-mode') as HTMLSelectElement;
  mode.value = 'batch';
  mode.dispatchEvent(new w.Event('change'));
  assert.ok(!$(w, '#ads-fb-run-mode-wrap').classList.contains('hidden'), '批量同样使用同一个免审勾选');
  const approval = $(w, '#ads-fb-approval') as HTMLInputElement;
  approval.checked = true;
  ($(w, '#ads-fb-import') as HTMLTextAreaElement).value = 'a@example.com----pw----2fa----cookie\nb@example.com----pw----2fa----cookie\nc@example.com----pw----2fa----cookie';

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sent.creationMode, 'batch');
  assert.equal(sent.commentApprovalMode, 'auto_approve_all', '整批共用同一个免审意图');
  assert.equal(sent.facebookRunMode, 'normal');
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.match(msg, /全局免审已配置（只免去评论提交前的第二次人工审核）。/);
  assert.doesNotMatch(msg, /风险|配额|去重/, '免审文案不得暗示放宽这些安全闸');
});

test('云端未确认：回执区分本地创建与各项配置，不宣称任何一项已生效', async () => {
  const w = await bootFacebookCreate(makeStub({
    adsCreateEnv: async () => ({
      ok: true,
      userId: 'u_pending',
      osFamily: 'windows',
      platform: 'facebook',
      runMode: 'cold_start',
      slowStartConfigured: false,
      commentApprovalConfigured: false,
      createdLocally: true,
      assignedToCurrentClient: false,
      requiresAdminAssignment: true,
      assignmentHandledByMain: true,
      rosterJoinedByMain: false,
      visibilityWarning: '环境已在本机创建，但自动分配未完成（云端未确认归属；慢启动、全局免审未确认），因此未加入运行环境。请重试或由管理员分配。',
    }),
  }));
  const runMode = $(w, '#ads-fb-run-mode') as HTMLSelectElement;
  runMode.value = 'cold_start';
  runMode.dispatchEvent(new w.Event('change'));
  ($(w, '#ads-fb-approval') as HTMLInputElement).checked = true;
  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.match(msg, /环境已在本机创建/);
  assert.match(msg, /冷启动的慢启动尚未获得云端确认。/);
  assert.match(msg, /全局免审尚未获得云端确认。/);
  assert.doesNotMatch(msg, /已配置慢启动/);
  assert.doesNotMatch(msg, /全局免审已配置/);
  assert.ok($(w, '#ads-create-msg').classList.contains('error'), '未确认必须以异常态呈现');
});

test('其它平台：切回小红书复位运行方式与免审，提交不携带任何相关键', async () => {
  let sent: Record<string, unknown> = {};
  const w = await bootFacebookCreate(makeStub({
    adsCreateEnv: async (opts) => {
      sent = opts as Record<string, unknown>;
      return { ok: true, userId: 'u_xhs', osFamily: 'windows', platform: 'xiaohongshu' };
    },
  }));
  const runMode = $(w, '#ads-fb-run-mode') as HTMLSelectElement;
  runMode.value = 'rule';
  runMode.dispatchEvent(new w.Event('change'));
  ($(w, '#ads-fb-approval') as HTMLInputElement).checked = true;

  const platform = $(w, '#ads-platform') as HTMLSelectElement;
  platform.value = 'xiaohongshu';
  platform.dispatchEvent(new w.Event('change'));
  assert.ok($(w, '#ads-fb-run-mode-field').classList.contains('hidden'));
  assert.ok($(w, '#ads-fb-run-mode-wrap').classList.contains('hidden'));
  assert.equal(runMode.value, 'normal', '离开 Facebook 复位运行方式');
  assert.equal(($(w, '#ads-fb-primary-surface') as HTMLSelectElement).value, 'reels', '离开 Facebook 复位主浏览入口');
  assert.equal(($(w, '#ads-fb-approval') as HTMLInputElement).checked, false, '离开 Facebook 复位免审');

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sent.platform, 'xiaohongshu');
  for (const key of ['facebookRunMode', 'facebookPrimarySurface', 'slowStartEnabled', 'facebookRuleModeEnabled', 'commentApprovalMode']) {
    assert.equal(key in sent, false, `非 Facebook 提交不得携带 ${key}`);
  }
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.doesNotMatch(msg, /慢启动|规则模式|免审/, '其它平台回执不出现运行方式相关声明');
});

test('程序化建号成功返回 userId → 自动选中新环境，启动可直接保存并开跑', async () => {
  const calls: string[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }),
    adsListProfiles: async () => ({
      ok: true,
      profiles: [
        { userId: 'u_old', serialNumber: '1', name: '旧环境', groupName: 'g', proxy: 'p' },
        { userId: 'u_new', serialNumber: '2', name: '新环境', groupName: 'g', proxy: 'p' },
      ],
    }),
    adsCreateEnv: async () => ({ ok: true, userId: 'u_new', osFamily: 'windows' }),
    saveSettings: async (patch) => {
      calls.push(`save:${(patch as { adsProfileId?: string }).adsProfileId || ''}`);
      return { provider: 'adspower', adsProfileId: 'u_new', saveOk: true };
    },
    start: async () => {
      calls.push('start');
      return makeStatus({ edge: 'starting', session: 'running' });
    },
  }));
  for (let i = 0; i < 3; i++) await tick();

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(($(w, '#ads-profile') as HTMLInputElement).value, 'u_new');
  assert.match($(w, '#ads-create-msg').textContent ?? '', /已自动选中/);
  assert.match($(w, '#ads-env-msg').textContent ?? '', /已选中「新环境」/);

  $(w, '#session-fab').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 3; i++) await tick();
  // 建号后自动加入即时落盘一次（environments 补丁、无 adsProfileId → 'save:'）；启动再 save:u_new + start。
  assert.deepEqual(calls.slice(-2), ['save:u_new', 'start']);
});

test('程序化建号失败：诚实提示', async () => {
  const w = await boot(makeStub({ adsCreateEnv: async () => ({ ok: false, error: 'code=-1 quota' }) }));
  for (let i = 0; i < 3; i++) await tick();
  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 3; i++) await tick();
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.match(msg, /创建失败/);
  assert.match(msg, /quota/);
});

test('删除环境：点两次确认（第一次仅 armed、第二次才删）', async () => {
  let deletedId = '';
  const w = await boot(makeStub({
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: '无代理配置' }] }),
    adsDeleteEnv: async (opts) => { deletedId = (opts as { userId?: string }).userId ?? ''; return { ok: true }; },
  }));
  const del = $(w, '.ads-env-del') as unknown as HTMLButtonElement;
  assert.ok(del, '每行应有删除按钮');
  del.dispatchEvent(new w.Event('click')); // 第一次：仅 armed
  await tick();
  assert.equal(deletedId, '', '第一次点击不应删除');
  assert.match(del.textContent ?? '', /确认删除/);
  del.dispatchEvent(new w.Event('click')); // 第二次：真删
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(deletedId, 'u1', '第二次点击才删除该环境');
});

test('视频号解绑清理中：不冒充已删除、不移出花名册，可继续轮询', async () => {
  const saves: Array<Record<string, unknown>> = [];
  let calls = 0;
  const w = await boot(makeStub({
    getSettings: async () => ({
      provider: 'adspower', adsProfileId: 'u1', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x',
      environments: [{ profileId: 'u1', name: '视频号甲', platform: 'wechat_channels' }],
    }),
    adsListProfiles: async () => ({
      ok: true,
      physicalUserIds: ['u1'],
      profiles: [{ userId: 'u1', name: '视频号甲', platform: 'wechat_channels',
        offboardPending: { state: 'pending_edge', offboardId: 'off-1' } }],
    }),
    adsDeleteEnv: async () => { calls += 1; return { ok: true, cleanupPending: true, message: '已撤销访问，等待设备确认清理。' }; },
    saveSettings: async (patch) => { saves.push(patch as Record<string, unknown>); return { provider: 'adspower', saveOk: true }; },
  }));
  assert.match($(w, '.env-member-badge').textContent ?? '', /已撤权|清理/);
  const del = $(w, '.ads-env-del') as unknown as HTMLButtonElement;
  assert.match(del.textContent ?? '', /继续清理/);
  del.dispatchEvent(new w.Event('click'));
  await tick();
  del.dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(calls, 1);
  assert.equal(saves.filter((p) => Array.isArray(p.environments)).length, 0,
    'Cloud 未 tombstone 时 renderer 不得移除花名册冒充清理完成');
});

test('删除环境：删云端成功后自动移出本地花名册（不留孤儿）', async () => {
  const saves: Array<Record<string, unknown>> = [];
  let deletedId = '';
  // 有状态云端桩：删除真从列表移除（模拟真实——删了云端 profile 后 listProfiles 不再返回它）。
  // 两个环境避开「唯一环境 + 花名册空 → 自动加入」把被删项又加回来的干扰。
  let cloud = [
    { userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' },
    { userId: 'u2', serialNumber: '2', name: '乙', groupName: 'g', proxy: 'p' },
  ];
  const w = await boot(makeStub({
    getSettings: async () => ({ provider: 'adspower', adsProfileId: 'u1', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x',
      environments: [
        { profileId: 'u1', name: '甲', platform: 'xiaohongshu' },
        { profileId: 'u2', name: '乙', platform: 'xiaohongshu' },
      ] }),
    adsListProfiles: async () => ({ ok: true, truncated: false, profiles: cloud }),
    adsDeleteEnv: async (opts) => { deletedId = (opts as { userId?: string }).userId ?? ''; cloud = cloud.filter((p) => p.userId !== deletedId); return { ok: true }; },
    saveSettings: async (patch) => { saves.push(patch as Record<string, unknown>); return { provider: 'adspower', saveOk: true }; },
  }));
  const del = ($$(w, '.ads-env-del')[0]) as unknown as HTMLButtonElement; // 甲(u1) 那行的删除
  del.dispatchEvent(new w.Event('click')); // armed
  await tick();
  del.dispatchEvent(new w.Event('click')); // 真删
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(deletedId, 'u1', '应删除该云端环境');
  const envSaves = saves.filter((p) => Array.isArray(p.environments));
  assert.ok(envSaves.length >= 1, '删除后应落盘花名册');
  const last = envSaves[envSaves.length - 1].environments as Array<{ profileId: string }>;
  assert.ok(!last.some((e) => e.profileId === 'u1'), '删除的环境应已从本地花名册移出（不留孤儿）');
  assert.ok(last.some((e) => e.profileId === 'u2'), '其它环境应保留在花名册');
});

test('刷新：花名册里云端已删的孤儿被自动清理', async () => {
  const saves: Array<Record<string, unknown>> = [];
  const w = await boot(makeStub({
    getSettings: async () => ({ provider: 'adspower', adsProfileId: 'u1', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x',
      environments: [
        { profileId: 'orphan', name: '孤儿', platform: 'facebook' },
        { profileId: 'u1', name: '甲', platform: 'xiaohongshu' },
      ] }),
    adsListProfiles: async () => ({ ok: true, truncated: false, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' }] }),
    saveSettings: async (patch) => { saves.push(patch as Record<string, unknown>); return { provider: 'adspower', saveOk: true }; },
  }));
  for (let i = 0; i < 4; i++) await tick();
  const envSaves = saves.filter((p) => Array.isArray(p.environments));
  assert.ok(envSaves.length >= 1, '刷新检测到孤儿后应落盘花名册');
  const last = envSaves[envSaves.length - 1].environments as Array<{ profileId: string }>;
  assert.ok(!last.some((e) => e.profileId === 'orphan'), '孤儿（云端已删）应被清理');
  assert.ok(last.some((e) => e.profileId === 'u1'), '仍在云端的环境应保留');
  assert.match($(w, '#ads-env-msg').textContent ?? '', /已清理 1 个/);
});

test('刷新安全闸：列表被截断时绝不剔孤儿（防一次不全的拉取误清空花名册）', async () => {
  const saves: Array<Record<string, unknown>> = [];
  const w = await boot(makeStub({
    getSettings: async () => ({ provider: 'adspower', adsProfileId: 'u1', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x',
      environments: [
        { profileId: 'on-later-page', name: '在后续页', platform: 'facebook' },
        { profileId: 'u1', name: '甲', platform: 'xiaohongshu' },
      ] }),
    adsListProfiles: async () => ({ ok: true, truncated: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' }] }),
    saveSettings: async (patch) => { saves.push(patch as Record<string, unknown>); return { provider: 'adspower', saveOk: true }; },
  }));
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!saves.some((p) => Array.isArray(p.environments)), '截断的拉取绝不应改写花名册（绝不剔孤儿）');
  assert.doesNotMatch($(w, '#ads-env-msg').textContent ?? '', /已清理/);
});

test('刷新安全闸：云端返回空列表（疑似后端空响应）时绝不剔孤儿', async () => {
  const saves: Array<Record<string, unknown>> = [];
  await boot(makeStub({
    getSettings: async () => ({ provider: 'adspower', adsProfileId: 'u1', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x',
      environments: [
        { profileId: 'u1', name: '甲', platform: 'xiaohongshu' },
        { profileId: 'u2', name: '乙', platform: 'facebook' },
      ] }),
    adsListProfiles: async () => ({ ok: true, truncated: false, profiles: [] }),
    saveSettings: async (patch) => { saves.push(patch as Record<string, unknown>); return { provider: 'adspower', saveOk: true }; },
  }));
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!saves.some((p) => Array.isArray(p.environments)), '一个环境都没取到时绝不应清空花名册（宁漏剔、不误删）');
});

test('删除唯一环境后不静默自动加入无关的剩余环境（回归 Finding 1）', async () => {
  const saves: Array<Record<string, unknown>> = [];
  let cloud = [
    { userId: 'X', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' },
    { userId: 'Y', serialNumber: '2', name: '乙', groupName: 'g', proxy: 'p' },
  ];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }),
    getSettings: async () => ({ provider: 'adspower', adsProfileId: 'X', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x',
      environments: [{ profileId: 'X', name: '甲', platform: 'xiaohongshu' }] }), // 花名册只有 X；Y 从未加入
    adsListProfiles: async () => ({ ok: true, truncated: false, profiles: cloud }),
    adsDeleteEnv: async (opts) => { const id = (opts as { userId?: string }).userId; cloud = cloud.filter((p) => p.userId !== id); return { ok: true }; },
    saveSettings: async (patch) => { saves.push(patch as Record<string, unknown>); return { provider: 'adspower', saveOk: true }; },
  }));
  const del = ($$(w, '.ads-env-del')[0]) as unknown as HTMLButtonElement; // 甲(X) 那行（列表首行）
  del.dispatchEvent(new w.Event('click')); // armed
  await tick();
  del.dispatchEvent(new w.Event('click')); // 真删 X
  for (let i = 0; i < 6; i++) await tick();
  const envSaves = saves.filter((p) => Array.isArray(p.environments));
  for (const p of envSaves) {
    assert.ok(!(p.environments as Array<{ profileId: string }>).some((e) => e.profileId === 'Y'), '删除唯一环境不应把无关的剩余环境 Y 自动拉进花名册');
  }
});

test('首次列出唯一环境仍自动加入花名册（allowAutoJoin 合法路径保留）', async () => {
  const saves: Array<Record<string, unknown>> = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }),
    getSettings: async () => ({ provider: 'adspower', adsProfileId: '', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x' }), // 无 environments → 花名册空
    adsListProfiles: async () => ({ ok: true, truncated: false, profiles: [{ userId: 'only1', serialNumber: '1', name: '唯一', groupName: 'g', proxy: 'p' }] }),
    saveSettings: async (patch) => { saves.push(patch as Record<string, unknown>); return { provider: 'adspower', saveOk: true }; },
  }));
  for (let i = 0; i < 4; i++) await tick();
  assert.match($(w, '#ads-env-msg').textContent ?? '', /已自动加入唯一环境/);
  const envSaves = saves.filter((p) => Array.isArray(p.environments));
  assert.ok(envSaves.some((p) => (p.environments as Array<{ profileId: string }>).some((e) => e.profileId === 'only1')), '唯一环境应被自动加入花名册');
});

test('客户归属环境默认全部移入且不启动；手动移出持久保留、再次点选恢复', async () => {
  const saves: Array<Record<string, unknown>> = [];
  let starts = 0;
  let state: Record<string, unknown> = {
    provider: 'adspower', adsProfileId: '', adsProfileName: '', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x',
    environments: [], clientRosterExcludedEnvIds: [],
  };
  const profiles = [
    { userId: 'owned-1', serialNumber: '1', name: '归属甲', groupName: 'g', proxy: 'p', platform: 'xiaohongshu' },
    { userId: 'owned-2', serialNumber: '2', name: '归属乙', groupName: 'g', proxy: 'p', platform: 'facebook' },
  ];
  const w = await boot(makeStub({
    getSettings: async () => state,
    getStatus: async () => makeStatus({ edge: 'running', session: 'running' }),
    start: async () => { starts += 1; return makeStatus({ edge: 'starting' }); },
    adsListProfiles: async () => ({ ok: true, assignmentScoped: true, truncated: false, profiles }),
    saveSettings: async (patch) => {
      const p = patch as Record<string, unknown>;
      saves.push(p);
      state = { ...state, ...p, saveOk: true };
      return state;
    },
  }));
  for (let i = 0; i < 4; i++) await tick();
  const latestEnvs = state.environments as Array<{ profileId: string }>;
  assert.deepEqual(Array.from(latestEnvs, (e) => e.profileId), ['owned-1', 'owned-2'], '完整权威归属列表默认全部移入');
  assert.equal(starts, 0, '默认移入只建离线行，绝不自动启动');
  assert.match($(w, '#ads-env-msg').textContent ?? '', /已加入 2 个环境.*未自动启动/);

  const secondRemove = $$(w, '.ads-env-item')[1].querySelector('.ads-env-remove') as HTMLElement;
  secondRemove.click();
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual(Array.from(state.environments as Array<{ profileId: string }>, (e) => e.profileId), ['owned-1']);
  assert.deepEqual(Array.from(state.clientRosterExcludedEnvIds as string[]), ['owned-2'], '手动移出写入持久排除集合');

  ($(w, '#ads-refresh') as HTMLButtonElement).click();
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(Array.from(state.environments as Array<{ profileId: string }>, (e) => e.profileId), ['owned-1'], '普通刷新不得把手动移出项加回');

  $$(w, '.ads-env-item')[1].click();
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual(Array.from(state.environments as Array<{ profileId: string }>, (e) => e.profileId), ['owned-1', 'owned-2']);
  assert.deepEqual(Array.from(state.clientRosterExcludedEnvIds as string[]), [], '显式再次移入撤销排除');
  assert.ok(saves.length >= 3, '默认移入、手动移出和再次移入都应即时落盘');
});

test('客户归属列表截断或空响应不默认移入；非客户多环境仍不代选', async () => {
  for (const result of [
    { ok: true, assignmentScoped: true, truncated: true, profiles: [{ userId: 'p1', name: '甲' }] },
    { ok: true, assignmentScoped: true, truncated: false, profiles: [] },
    { ok: true, truncated: false, profiles: [{ userId: 'p1', name: '甲' }, { userId: 'p2', name: '乙' }] },
  ]) {
    const saves: Array<Record<string, unknown>> = [];
    await boot(makeStub({
      getSettings: async () => ({ provider: 'adspower', adsProfileId: '', adsApiKey: '', adsApiBase: '', environments: [] }),
      adsListProfiles: async () => result,
      saveSettings: async (patch) => { saves.push(patch as Record<string, unknown>); return { saveOk: true, environments: [] }; },
    }));
    assert.ok(!saves.some((p) => Array.isArray(p.environments)), '不完整客户列表 / 非客户多环境不得默认改写花名册');
  }
});

test('空响应安全闸（红线）：整份花名册都不在本次云端列表时，绝不把在用环境渲染成可移除的残留行', async () => {
  // 撤销残留行渲染后的回归守卫：success-but-empty 的偶发响应下，不得把活着的环境误标成已删除+给一键移出。
  const w = await boot(makeStub({
    getSettings: async () => ({ provider: 'adspower', adsProfileId: 'A', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'x',
      environments: [
        { profileId: 'A', name: '在用甲', platform: 'facebook' },
        { profileId: 'B', name: '在用乙', platform: 'xiaohongshu' },
      ] }),
    adsListProfiles: async () => ({ ok: true, truncated: false, profiles: [] }), // 偶发空响应（非账号真空）
  }));
  for (let i = 0; i < 4; i++) await tick();
  assert.equal($$(w, '.ads-env-orphan').length, 0, '空响应下绝不渲染任何「残留/已删除」行（否则误标在用环境）');
});

test('防限速：刷新在途禁用按钮，完成后恢复', async () => {
  let resolveList: (v: unknown) => void = () => undefined;
  const pending = new Promise((res) => { resolveList = res; });
  const w = await boot(makeStub({ adsListProfiles: () => pending as Promise<unknown> }));
  const btn = $(w, '#ads-refresh') as HTMLButtonElement;
  btn.dispatchEvent(new w.Event('click'));
  assert.equal(btn.disabled, true);
  resolveList({ ok: true, profiles: [] });
  await tick();
  await tick();
  assert.equal(btn.disabled, false);
});

test('暂停中切换环境 → 恢复：先存再恢复（回归：新环境不被旧持久化设置覆盖）', async () => {
  const calls: string[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ session: 'paused', edge: 'stopped' }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u_new', serialNumber: '2', name: '乙', groupName: 'g', proxy: 'p' }] }),
    saveSettings: async () => { calls.push('save'); return { provider: 'adspower', adsProfileId: 'u_new', saveOk: true }; },
    resume: async () => { calls.push('resume'); return makeStatus({ session: 'running', edge: 'running' }); },
  }));
  assert.equal($(w, '#session-fab').textContent, '恢复', '暂停态 fab 应为「恢复」');
  $$(w, '.ads-env-item')[0].dispatchEvent(new w.Event('click')); // 暂停中切换环境 → dirty
  $(w, '#session-fab').dispatchEvent(new w.Event('click')); // 点「恢复」
  await tick();
  await tick();
  assert.deepEqual(calls, ['save', 'resume'], '恢复前应先落盘新环境，再恢复');
});

test('暂停中未改动 → 恢复：直接恢复，不多余落盘', async () => {
  const calls: string[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ session: 'paused', edge: 'stopped' }),
    saveSettings: async () => { calls.push('save'); return { saveOk: true }; },
    resume: async () => { calls.push('resume'); return makeStatus({ session: 'running', edge: 'running' }); },
  }));
  $(w, '#session-fab').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.deepEqual(calls, ['resume'], '无改动时恢复不应触发 save');
});

test('保存后解除 provider 编辑闩锁：状态推送可再跟随实际 provider（回归）', async () => {
  let pushCb: (s: unknown) => void = () => undefined;
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped', provider: 'adspower' }),
    onStatusUpdate: (cb) => { pushCb = cb; },
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' }] }),
    start: async () => makeStatus({ edge: 'starting', session: 'running', provider: 'adspower' }),
  }));
  // 拨动一次浏览器开关 → editingProvider 上闩（开→关，回到 adspower 但已标记编辑中）
  const sw = $(w, '#use-chrome') as unknown as { checked: boolean };
  sw.checked = true; $(w, '#use-chrome').dispatchEvent(new w.Event('change'));
  sw.checked = false; $(w, '#use-chrome').dispatchEvent(new w.Event('change'));
  await tick();
  // 选环境 + 启动（= 先 save 再 start）：save 里解闩
  $$(w, '.ads-env-item')[0].dispatchEvent(new w.Event('click'));
  $(w, '#session-fab').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  // 之后一条状态推送报 provider=self → 开关应跟随（若闩未解，会卡在 adspower/未勾）
  pushCb(makeStatus({ provider: 'self', edge: 'running', session: 'running' }));
  assert.ok(($(w, '#use-chrome') as unknown as { checked: boolean }).checked, '保存后应解闩，开关跟随实际 provider=self');
  assert.equal(hidden($(w, '#ads-config')), true, 'self 下应隐藏 AdsPower 配置块');
});

// ── 环境展示名保真（change edge-env-name-live-sync）：治左栏展示名与添加面板对同一环境显示不同名字 ──

const savedEnvsOf = (calls: Array<Record<string, unknown>>, profileId: string) =>
  calls
    .map((p) => (p && (p.environments as Array<{ profileId?: string; name?: string; nameSource?: string }>)) || [])
    .flat()
    .filter((e) => e && e.profileId === profileId);

test('创建环境：回执带回真名 → 花名册落盘真名（不再空名 → 左栏与面板一致）', async () => {
  const saved: Array<Record<string, unknown>> = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }), // coreRunning=false → 新建即自动选中
    adsStatus: async () => ({ ok: true }),
    // 新建后紧接着的自动刷新里 user/list 尚未带出新环境（传播延迟）——正是需要「回执带名」兜住的场景
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    adsTemplates: async () => [{ key: 'windows', label: 'Windows' }],
    adsCreateEnv: async () => ({ ok: true, userId: 'newu', name: '我的新环境', platform: 'xiaohongshu', osFamily: 'windows' }),
    saveSettings: async (patch: unknown) => { saved.push((patch as Record<string, unknown>) || {}); return { provider: 'adspower', ...(patch as object), saveOk: true }; },
  }));
  (($(w, '#ads-template')) as unknown as { value: string }).value = 'windows';
  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 6; i++) await tick();
  const persisted = savedEnvsOf(saved, 'newu');
  assert.ok(persisted.length > 0, '创建后应把新环境落盘进花名册');
  assert.ok(persisted.every((e) => e.name === '我的新环境'), '落盘的新环境名应为真名而非空串');
  assert.match($(w, '#ads-profile-display').textContent ?? '', /newu/, '只读展示应带出新环境 user_id');
});

test('拉列表回填：花名册空名成员用 user/list 实时名补齐并落盘', async () => {
  const saved: Array<Record<string, unknown>> = [];
  await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }),
    adsStatus: async () => ({ ok: true }),
    getSettings: async () => ({ provider: 'adspower', adsProfileId: 'p1', adsProfileName: '', adsApiKey: '', adsApiBase: '', browserParkingMode: 'edge-strip', environments: [{ profileId: 'p1', name: '', platform: 'xiaohongshu' }] }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'p1', name: '真名甲', serialNumber: '1', proxy: 'x' }] }),
    saveSettings: async (patch: unknown) => { saved.push((patch as Record<string, unknown>) || {}); return { provider: 'adspower', ...(patch as object), saveOk: true }; },
  }));
  for (let i = 0; i < 6; i++) await tick();
  const persisted = savedEnvsOf(saved, 'p1');
  assert.ok(persisted.length > 0, '回填应触发一次落盘');
  assert.ok(persisted.some((e) => e.name === '真名甲'), '空名成员应被回填为 user/list 实时名');
});

test('拉列表回填：人工昵称保持最高优先级，不被 user/list 实时名覆盖', async () => {
  const saved: Array<Record<string, unknown>> = [];
  await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }),
    adsStatus: async () => ({ ok: true }),
    getSettings: async () => ({
      provider: 'adspower',
      adsProfileId: 'p1',
      adsProfileName: '运营重点号',
      adsApiKey: '',
      adsApiBase: '',
      browserParkingMode: 'edge-strip',
      environments: [{ profileId: 'p1', name: '运营重点号', platform: 'xiaohongshu', nameSource: 'manual' }],
    }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'p1', name: '平台实时名', serialNumber: '1', proxy: 'x' }] }),
    saveSettings: async (patch: unknown) => { saved.push((patch as Record<string, unknown>) || {}); return { provider: 'adspower', ...(patch as object), saveOk: true }; },
  }));
  for (let i = 0; i < 6; i++) await tick();
  const persisted = savedEnvsOf(saved, 'p1');
  assert.equal(persisted.some((e) => e.name === '平台实时名'), false, '实时列表名不得覆盖人工昵称');
});

test('拉列表回填：截断结果绝不回填（不因缺数据误改在用环境名）', async () => {
  const saved: Array<Record<string, unknown>> = [];
  await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }),
    adsStatus: async () => ({ ok: true }),
    getSettings: async () => ({ provider: 'adspower', adsProfileId: 'p1', adsProfileName: '', adsApiKey: '', adsApiBase: '', browserParkingMode: 'edge-strip', environments: [{ profileId: 'p1', name: '', platform: 'xiaohongshu' }] }),
    adsListProfiles: async () => ({ ok: true, truncated: true, profiles: [{ userId: 'p1', name: '真名甲', serialNumber: '1', proxy: 'x' }] }),
    saveSettings: async (patch: unknown) => { saved.push((patch as Record<string, unknown>) || {}); return { provider: 'adspower', ...(patch as object), saveOk: true }; },
  }));
  for (let i = 0; i < 6; i++) await tick();
  const reconciled = savedEnvsOf(saved, 'p1').some((e) => e.name === '真名甲');
  assert.equal(reconciled, false, '截断拉取不得回填名字（缺数据不自残）');
});

// ── change account-level-slow-start：慢启动脚注行接线 ──

function slowStartStub(overrides: Partial<Stub> = {}, platform = 'facebook'): Stub {
  const getStatus = overrides.getStatus || (async () => makeStatus());
  const baseGetSlowStart = overrides.getSlowStart || (async ({ envKey }: { envKey: string }) => {
    const status = await getStatus() as { dailyUsage?: { slowStart?: unknown; quotas?: unknown } | null };
    const slowStart = status.dailyUsage?.slowStart;
    return slowStart && typeof slowStart === 'object'
      ? { ok: true, data: { data: { envKey, slowStart, dayQuotas: status.dailyUsage?.quotas || null } } }
      : { ok: false, data: { message: '云端未返回慢启动状态' } };
  });
  const latestSlowStartResponses = new Map<string, unknown>();
  let policyRevision = 3;
  const getSlowStart = async (args: { envKey: string }) => {
    if (latestSlowStartResponses.has(args.envKey)) {
      return latestSlowStartResponses.get(args.envKey);
    }
    const response = await baseGetSlowStart(args);
    latestSlowStartResponses.set(args.envKey, response);
    return response;
  };
  const getFacebookOperationPolicy = overrides.getFacebookOperationPolicy
    || (async ({ envKey }: { envKey: string }) => {
      const slow = await getSlowStart({ envKey }) as {
        ok?: boolean;
        data?: { data?: { slowStart?: { state?: string } } };
      };
      if (!slow?.ok || !slow.data?.data?.slowStart) return slow;
      const mode = slow.data.data.slowStart.state === 'active' ? 'slow_start' : 'persona';
      return facebookOperationPolicyReceipt(envKey, mode, policyRevision);
    });
  let stub: Stub;
  const setFacebookOperationPolicy = overrides.setFacebookOperationPolicy
    || (async (args: {
      envKey: string;
      expectedRevision: number;
      mode: 'persona' | 'slow_start' | 'rule' | 'consumption';
    }) => {
      if (args.mode === 'slow_start' || args.mode === 'persona') {
        const result = await stub.setSlowStart({
          envKey: args.envKey,
          enabled: args.mode === 'slow_start',
        });
        if (!(result as { ok?: boolean })?.ok) return result;
        latestSlowStartResponses.set(args.envKey, result);
      }
      policyRevision = args.expectedRevision + 1;
      return facebookOperationPolicyReceipt(args.envKey, args.mode, policyRevision);
    });
  stub = makeStub({
    ...overrides,
    getSettings: overrides.getSettings || (async () => ({
      provider: 'adspower', adsProfileId: '', adsApiKey: '', adsApiBase: '',
      browserParkingMode: 'edge-strip', adsDownloadUrl: 'https://x', platform,
    })),
    getStatus,
    getSlowStart,
    getFacebookOperationPolicy,
    setFacebookOperationPolicy,
  });
  return stub;
}

test('慢启动行：静态节点在 #daily-summary 内、#quota-windows 之后', () => {
  const dom = new JSDOM(html);
  const summary = dom.window.document.querySelector('#daily-summary');
  const row = summary?.querySelector('#slow-start-row');
  assert.ok(row, '#slow-start-row 应在 #daily-summary 内');
  assert.ok(row?.querySelector('#slow-start-toggle'), '勾选框应是静态节点（JS 只切 hidden/checked，不建元素）');
  // 对比 #quota-windows：windows 为空时整块 hidden + 清空，而慢启动正是「启动新号之前」要设的。
  const windows = summary?.querySelector('#quota-windows');
  assert.ok(windows && row && windows.compareDocumentPosition(row) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    '慢启动行应排在 #quota-windows 之后');
});

test('慢启动行：常驻说明明确设置跟随环境与当前账号档位', () => {
  const copy = new JSDOM(html).window.document.querySelector('.slow-start-copy')?.textContent?.trim();
  assert.equal(copy, '设置跟随当前环境。开启后头 7 天按曲线逐日放开量，7天后按当前账号档位运行。');
});

test('解除受限行：位于今日进展底部且只有一个恢复主动作与一个问号说明', () => {
  const dom = new JSDOM(html);
  const summary = dom.window.document.querySelector('#daily-summary');
  const slowStart = summary?.querySelector('#slow-start-row');
  const row = summary?.querySelector('#risk-recovery-row');
  assert.ok(row, '#risk-recovery-row 应为 #daily-summary 内的静态轻量行');
  assert.ok(slowStart && row && slowStart.compareDocumentPosition(row) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    '解除受限行应排在慢启动之后，不占标题区');
  assert.equal(row?.querySelector('.risk-recovery-state'), null, '状态已在健康/明细/环境栏展示，轻量行不得重复占位');
  assert.equal(row?.querySelector('#risk-recovery-button')?.textContent?.trim(), '解除受限');
  assert.equal(row?.querySelectorAll('.risk-recovery-button').length, 1, '只有一个恢复主动作');
  const help = row?.querySelector('#risk-recovery-help-trigger');
  assert.equal(help?.tagName, 'BUTTON');
  assert.match(help?.getAttribute('aria-label') || '', /账号受限说明/);
  const helpText = row?.querySelector('#risk-recovery-help-panel')?.textContent || '';
  assert.match(helpText, /Facebook 安全检查/);
  assert.match(helpText, /只针对当前环境/);
  assert.match(helpText, /再次标记受限/);
  assert.match(styles, /.risk-recovery-row\s*\{[^}]*display:\s*flex;[^}]*border-top:/s);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*?\.risk-recovery-help-panel\s*\{[^}]*right:\s*-8px;/s);
});

test('解除受限确认：使用紧凑应用 dialog，不再调用系统确认框', () => {
  const dom = new JSDOM(html);
  const dialog = dom.window.document.querySelector('#risk-recovery-confirm');
  assert.equal(dialog?.tagName, 'DIALOG');
  assert.equal(dialog?.querySelector('#risk-recovery-confirm-title')?.textContent?.trim(), '确认解除受限？');
  assert.match(dialog?.querySelector('#risk-recovery-confirm-boundary')?.textContent || '', /只解除 AIDCP.*不代表 Facebook/s);
  assert.equal(dialog?.querySelector('#risk-recovery-confirm-cancel')?.textContent?.trim(), '暂不解除');
  assert.equal(dialog?.querySelector('#risk-recovery-confirm-submit')?.textContent?.trim(), '确认解除');
  assert.ok(dialog?.querySelector('[aria-label="关闭解除受限确认"]'));
  assert.match(styles, /\.risk-recovery-confirm\s*\{[^}]*width:\s*min\(410px,[^}]*border-radius:\s*18px;/s);
  assert.match(styles, /\.risk-recovery-confirm::backdrop\s*\{[^}]*background:[^}]*backdrop-filter:\s*blur\(3px\);/s);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*?\.risk-recovery-confirm-actions button\s*\{[^}]*flex:\s*1;/s);
  assert.doesNotMatch(rendererSrc, /window\.confirm\(\s*['"]确认解除/, '解除受限不得再回退系统确认框');
});

test('精选详情宽屏两列分别原生滚动并在窄屏恢复单列文档流', () => {
  assert.match(styles, /\.content-workspace\.curated-detail-mode\s*\{[^}]*height:\s*calc\(100vh - 78px\);[^}]*min-height:\s*0;/s);
  assert.match(styles, /\.content-workspace\.curated-detail-mode\s+\.cw-header\s*\{[^}]*position:\s*sticky;[^}]*top:\s*46px;[^}]*flex:\s*0 0 auto;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 26px;[^}]*padding:\s*6px 9px;/s);
  assert.match(styles, /\.content-workspace\.curated-detail-mode\s+\.cw-kicker,\s*\.content-workspace\.curated-detail-mode\s+\.cw-heading p\s*\{[^}]*display:\s*none;/s);
  assert.match(styles, /\.content-workspace\.curated-detail-mode\s+\.cw-icon-button\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px;/s);
  assert.match(styles, /\.curated-detail-media,\s*\.curated-detail-copy\s*\{[^}]*padding-bottom:\s*12px;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
  assert.match(styles, /\.curated-detail-media,\s*\.curated-detail-copy\s*\{[^}]*scrollbar-gutter:\s*auto;[^}]*scrollbar-width:\s*none;/s);
  assert.match(styles, /\.curated-detail-media::\-webkit-scrollbar,\s*\.curated-detail-copy::\-webkit-scrollbar\s*\{[^}]*display:\s*none;[^}]*width:\s*0;[^}]*height:\s*0;/s);
  assert.match(styles, /\.curated-card-top strong\s*\{[^}]*font-family:\s*system-ui,\s*"Apple Color Emoji",\s*"Segoe UI Emoji",\s*"Segoe UI Symbol",\s*"Noto Color Emoji",\s*-apple-system,\s*"Segoe UI",\s*Roboto,\s*Ubuntu,\s*Cantarell,\s*"Noto Sans",\s*sans-serif,\s*BlinkMacSystemFont,\s*"Helvetica Neue",\s*Arial,\s*"PingFang SC",\s*"PingFang TC",\s*"PingFang HK",\s*"Microsoft Yahei",\s*"Microsoft JhengHei";[^}]*font-size:\s*16px;[^}]*font-weight:\s*700;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.curated-card-top em\s*\{[^}]*font-family:\s*system-ui,\s*"Apple Color Emoji",\s*"Segoe UI Emoji",\s*"Segoe UI Symbol",\s*"Noto Color Emoji",\s*-apple-system,\s*"Segoe UI",\s*Roboto,\s*Ubuntu,\s*Cantarell,\s*"Noto Sans",\s*sans-serif,\s*BlinkMacSystemFont,\s*"Helvetica Neue",\s*Arial,\s*"PingFang SC",\s*"PingFang TC",\s*"PingFang HK",\s*"Microsoft Yahei",\s*"Microsoft JhengHei";[^}]*font-size:\s*11px;[^}]*font-weight:\s*700;/s);
  assert.match(styles, /\.curated-detail-badge\s*\{[^}]*font-size:\s*9\.5px;[^}]*font-weight:\s*700;/s);
  assert.match(styles, /\.curated-card-body\s*\{[^}]*font-family:\s*system-ui,\s*"Apple Color Emoji",\s*"Segoe UI Emoji",\s*"Segoe UI Symbol",\s*"Noto Color Emoji",\s*-apple-system,\s*"Segoe UI",\s*Roboto,\s*Ubuntu,\s*Cantarell,\s*"Noto Sans",\s*sans-serif,\s*BlinkMacSystemFont,\s*"Helvetica Neue",\s*Arial,\s*"PingFang SC",\s*"PingFang TC",\s*"PingFang HK",\s*"Microsoft Yahei",\s*"Microsoft JhengHei";[^}]*font-size:\s*14px;[^}]*font-weight:\s*400;[^}]*line-height:\s*1\.5;[^}]*-webkit-line-clamp:\s*2;/s);
  assert.match(styles, /\.curated-detail-body\s*\{[^}]*font-family:\s*system-ui,\s*"Apple Color Emoji",\s*"Segoe UI Emoji",\s*"Segoe UI Symbol",\s*"Noto Color Emoji",\s*-apple-system,\s*"Segoe UI",\s*Roboto,\s*Ubuntu,\s*Cantarell,\s*"Noto Sans",\s*sans-serif,\s*BlinkMacSystemFont,\s*"Helvetica Neue",\s*Arial,\s*"PingFang SC",\s*"PingFang TC",\s*"PingFang HK",\s*"Microsoft Yahei",\s*"Microsoft JhengHei";[^}]*font-size:\s*16px;[^}]*font-weight:\s*400;[^}]*line-height:\s*1\.8;[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(styles, /@media \(max-width:\s*680px\)[\s\S]*?\.curated-detail-media,\s*\.curated-detail-copy\s*\{[^}]*padding-bottom:\s*0;[^}]*overflow:\s*visible;/s);
});

test('慢启动帮助：问号可聚焦，hover/focus 展示 7×6 Facebook 曲线限额表', () => {
  const dom = new JSDOM(html);
  const trigger = dom.window.document.querySelector('#slow-start-help-trigger');
  const panel = dom.window.document.querySelector('#slow-start-help-panel');
  assert.equal(trigger?.tagName, 'BUTTON');
  assert.equal(trigger?.getAttribute('type'), 'button');
  assert.match(trigger?.getAttribute('aria-label') || '', /Facebook 慢启动 7 天限额/);
  assert.match(panel?.querySelector('strong')?.textContent || '', /Facebook 慢启动曲线限额/);
  assert.match(styles, /\.slow-start-row\s*\{[^}]*margin-top:\s*0; padding-top:\s*0;/s);
  assert.match(styles, /\.slow-start-row\s+\.switch-track\s*\{[^}]*width:\s*30px; height:\s*16\.5px;/s);
  assert.match(styles, /\.slow-start-row\s+\.switch-thumb\s*\{[^}]*width:\s*13\.5px; height:\s*13\.5px;/s);
  assert.match(styles, /\.slow-start-help-trigger\s*\{[^}]*top:\s*3px;[^}]*width:\s*14px; height:\s*14px;[^}]*font-size:\s*10px;/s);
  assert.match(styles, /\.slow-start-help-panel\s*\{[^}]*left:\s*-120px;/s);
  assert.match(styles, /\.slow-start-help:hover\s+\.slow-start-help-panel/);
  assert.match(styles, /\.slow-start-help:focus-within\s+\.slow-start-help-panel/);

  const rows = Array.from(panel?.querySelectorAll('tbody tr') || []).map((row) =>
    Array.from(row.children).map((cell) => cell.textContent?.trim()),
  );
  assert.deepEqual(rows, [
    ['第 1 天', '20', '2', '0', '1', '0', '0'],
    ['第 2 天', '25', '3', '0', '1', '0', '0'],
    ['第 3 天', '35', '6', '1', '2', '0', '1'],
    ['第 4 天', '40', '8', '2', '2', '0', '1'],
    ['第 5 天', '50', '12', '3', '3', '1', '2'],
    ['第 6 天', '60', '15', '4', '4', '1', '2'],
    ['第 7 天', '70', '18', '5', '5', '1', '3'],
  ]);
});

test('慢启动 HTTP 未返回状态 → 显示读取失败且绝不默认成「关」', async () => {
  const w = await boot(slowStartStub({ getStatus: async () => makeStatus({ edge: 'running', session: 'running', cloud: 'connected' }) }));
  assert.ok(!hidden($(w, '#slow-start-row')));
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.indeterminate, true, '读取失败不得显示成已关闭');
  assert.match($(w, '#slow-start-reason').textContent || '', /未返回慢启动状态/);
});

// 能力缺失时仍展示慢启动详情占位，不默认成「关」、不卡在「正在读取」。
test('慢启动行：Facebook 环境未启动 + 无 env-scoped 读能力 → 显示未知占位', async () => {
  const w = await boot(makeStub({
    getSettings: async () => ({
      provider: 'adspower',
      adsProfileId: 'fb_env',
      adsProfileName: 'FB 环境',
      adsApiKey: '',
      adsApiBase: '',
      browserParkingMode: 'edge-strip',
      adsDownloadUrl: 'https://x',
      platform: 'facebook',
      environments: [{ profileId: 'fb_env', name: 'FB 环境', platform: 'facebook' }],
    }),
    getStatus: async () => makeStatus({ edge: 'stopped', session: 'idle', cloud: 'disconnected' }),
    // 刻意不提供 getSlowStart。
  }));
  assert.ok(!hidden($(w, '#slow-start-row')));
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.indeterminate, true, '未知态必须用 indeterminate，不能显示成已关闭');
  assert.match($(w, '#slow-start-reason').textContent || '', /登录客户端后读取 Cloud 慢启动状态/);
});

// 停止的环境（内核未运行、无云链路，dailyUsage=null）+ 有绑定 → 经不依赖边缘的 env-scoped 读渲染真态，
// **开关可点**（离线可改）。**验收必须用已停止的环境**——冷待机（cloud=connected）本来就能点，用它测会假绿（task 7.1）。
function stoppedFbEnv(getSlowStart: Stub['getSlowStart'], overrides: Partial<Stub> = {}): Stub {
  return slowStartStub({
    getSettings: async () => ({
      provider: 'adspower', adsProfileId: 'fb_env', adsProfileName: 'FB 环境', adsApiKey: '', adsApiBase: '',
      browserParkingMode: 'edge-strip', adsDownloadUrl: 'https://x', platform: 'facebook',
      environments: [{ profileId: 'fb_env', name: 'FB 环境', platform: 'facebook' }],
    }),
    getStatus: async () => makeStatus({ envId: 'fb_env', edge: 'stopped', session: 'idle', cloud: 'disconnected', dailyUsage: null }),
    getSlowStart,
    ...overrides,
  });
}

function stoppedRestrictedFbEnv(overrides: Partial<Stub> = {}): Stub {
  const status = makeStatus({ envId: 'fb_env', edge: 'stopped', session: 'idle', cloud: 'disconnected', dailyUsage: null });
  return makeStub({
    getSettings: async () => ({
      provider: 'adspower', adsProfileId: 'fb_env', adsProfileName: 'FB 环境', adsApiKey: '', adsApiBase: '',
      browserParkingMode: 'edge-strip', adsDownloadUrl: 'https://x', platform: 'facebook',
      environments: [{ profileId: 'fb_env', name: 'FB 环境', platform: 'facebook' }],
    }),
    getStatus: async () => status,
    adsListProfiles: async () => ({
      ok: true,
      physicalUserIds: ['fb_env'],
      profiles: [{
        userId: 'fb_env', serialNumber: '1', name: 'FB 环境', groupName: '', proxy: '', platform: 'facebook',
      }],
    }),
    fleetGet: async () => ({
      selectedEnvId: 'fb_env', railCollapsed: false,
      environments: [{ envId: 'fb_env', profileId: 'fb_env', name: 'FB 环境', platform: 'facebook', status }],
    }),
    fleetSelect: async () => ({}),
    getEnvironmentRisk: async ({ envKey }) => ({
      ok: true,
      data: { data: { envKey, status: 'restricted', statusSince: 1000, updatedAt: 2000 } },
    }),
    ...overrides,
  });
}

test('解除受限：停止的 Facebook 环境显示三字主状态并保留完整账号受限原因', async () => {
  const riskReads: unknown[] = [];
  const w = await boot(stoppedRestrictedFbEnv({
    getEnvironmentRisk: async (args) => {
      riskReads.push(args);
      return { ok: true, data: { data: { envKey: args.envKey, status: 'restricted', statusSince: 1000, updatedAt: 2000 } } };
    },
  }));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(riskReads.length, 1);
  assert.equal((riskReads[0] as { envKey?: string }).envKey, 'fb_env');
  assert.ok(!hidden($(w, '#risk-recovery-row')));
  assert.equal($(w, '#health-label').textContent, '受限制');
  assert.equal($(w, '#risk-status').textContent, '受限制');
  assert.match($(w, '#health-detail').textContent || '', /账号受限/, '主状态缩短后完整原因仍在独立详情');
  const railRow = $(w, '.rail-row.selected');
  assert.match(railRow.textContent || '', /受限制/, '左栏主状态遵守三字上限');
  assert.match(railRow.getAttribute('title') || '', /账号受限/, '完整原因仍可读取，不因缩短主状态而丢失');
});

test('解除受限：应用弹层展示环境；取消/关闭/Escape 不请求；确认后等 Cloud normal 才隐藏', async () => {
  const recovery = deferred<unknown>();
  const calls: unknown[] = [];
  const w = await boot(stoppedRestrictedFbEnv({
    recoverEnvironmentRisk: async (args) => { calls.push(args); return recovery.promise; },
  }));
  for (let i = 0; i < 5; i++) await tick();
  const button = $(w, '#risk-recovery-button') as unknown as HTMLButtonElement;
  const dialog = $(w, '#risk-recovery-confirm') as unknown as HTMLDialogElement;

  button.click();
  await tick();
  assert.equal(dialog.open, true);
  assert.equal($(w, '#risk-recovery-confirm-env').textContent, 'FB 环境');
  assert.deepEqual(calls, [], '打开弹层不得请求 Cloud');
  $(w, '#risk-recovery-confirm-cancel').click();
  assert.equal(dialog.open, false);
  assert.deepEqual(calls, [], '取消确认不得请求 Cloud');
  assert.ok(!hidden($(w, '#risk-recovery-row')));

  button.click();
  $(w, '#risk-recovery-confirm-close').click();
  assert.equal(dialog.open, false);
  assert.deepEqual(calls, [], '关闭按钮不得请求 Cloud');

  button.click();
  dialog.dispatchEvent(new w.Event('cancel', { cancelable: true }));
  dialog.close('cancel');
  $(w, '#risk-recovery-confirm-submit').click();
  await tick();
  assert.deepEqual(calls, [], 'Escape/cancel 事件必须清空待确认上下文');

  button.click();
  $(w, '#risk-recovery-confirm-submit').click();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { envKey?: string }).envKey, 'fb_env');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '解除中…');
  assert.ok(!hidden($(w, '#risk-recovery-row')), 'Cloud 回执前不得乐观清掉 restricted');

  recovery.resolve({
    status: 200,
    ok: true,
    data: { data: {
      envKey: 'fb_env',
      commandId: 'cmd-direct',
      state: 'applied',
      status: 'normal',
      statusSince: 3000,
      updatedAt: 3000,
      changed: true,
      resumedEdges: 1,
    } },
  });
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(hidden($(w, '#risk-recovery-row')), 'Cloud 写后 normal 到达后才隐藏');
});

test('解除受限：202 后只轮询同环境同 command，applied 写后 normal 到达才清除', async () => {
  const submissions: unknown[] = [];
  const polls: unknown[] = [];
  const w = await boot(stoppedRestrictedFbEnv({
    recoverEnvironmentRisk: async (args) => {
      submissions.push(args);
      return {
        status: 202,
        ok: true,
        data: { data: { envKey: 'fb_env', commandId: 'cmd-41', state: 'processing' } },
      };
    },
    getEnvironmentRiskRecoveryResult: async (args) => {
      polls.push(args);
      return {
        status: 200,
        ok: true,
        data: { data: {
          envKey: 'fb_env',
          commandId: 'cmd-41',
          state: 'applied',
          status: 'normal',
          statusSince: 3000,
          updatedAt: 3000,
          changed: true,
          resumedEdges: 2,
        } },
      };
    },
  }));
  for (let i = 0; i < 5; i++) await tick();
  ($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).click();
  $(w, '#risk-recovery-confirm-submit').click();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(
    submissions.map((args) => ({ ...(args as Record<string, unknown>) })),
    [{ envKey: 'fb_env' }],
  );
  assert.deepEqual(
    polls.map((args) => ({ ...(args as Record<string, unknown>) })),
    [{ envKey: 'fb_env', commandId: 'cmd-41' }],
  );
  assert.ok(hidden($(w, '#risk-recovery-row')), '202 受理本身不清除；同 command 的 applied normal 才清除');
});

test('解除受限：refused 即使携带 status normal 也不得清除 restricted', async () => {
  const w = await boot(stoppedRestrictedFbEnv({
    recoverEnvironmentRisk: async () => ({
      status: 409,
      ok: false,
      data: { data: {
        envKey: 'fb_env',
        commandId: 'cmd-refused',
        state: 'refused',
        status: 'normal',
        reason: 'not_restricted',
      } },
    }),
  }));
  for (let i = 0; i < 5; i++) await tick();
  ($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).click();
  $(w, '#risk-recovery-confirm-submit').click();
  for (let i = 0; i < 3; i++) await tick();
  assert.ok(!hidden($(w, '#risk-recovery-row')));
  assert.equal($(w, '#health-label').textContent, '受限制');
  assert.equal($(w, '#risk-status').textContent, '受限制');
  assert.match($(w, '#risk-recovery-feedback').textContent || '', /Cloud 已拒绝/);
  assert.equal(($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).disabled, false);
});

test('解除受限：环境移除并以同 envKey 启动新命令后，旧轮询回执不得覆盖新 pending', async () => {
  const oldPoll = deferred<unknown>();
  const newPoll = deferred<unknown>();
  let pushFleet: ((snapshot: unknown) => void) | undefined;
  let submissionCount = 0;
  const status = makeStatus({
    envId: 'fb_env', edge: 'stopped', session: 'idle', cloud: 'disconnected', dailyUsage: null,
  });
  const fleetSnapshot = {
    selectedEnvId: 'fb_env',
    railCollapsed: false,
    environments: [{
      envId: 'fb_env', profileId: 'fb_env', name: 'FB 环境', platform: 'facebook', status,
    }],
  };
  const w = await boot(stoppedRestrictedFbEnv({
    onFleetUpdate: (cb) => { pushFleet = cb; },
    recoverEnvironmentRisk: async () => {
      submissionCount += 1;
      const commandId = submissionCount === 1 ? 'cmd-old' : 'cmd-new';
      return {
        status: 202,
        ok: true,
        data: { data: { envKey: 'fb_env', commandId, state: 'processing' } },
      };
    },
    getEnvironmentRiskRecoveryResult: async ({ commandId }) => (
      commandId === 'cmd-old' ? oldPoll.promise : newPoll.promise
    ),
  }));
  for (let i = 0; i < 5; i++) await tick();

  ($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).click();
  $(w, '#risk-recovery-confirm-submit').click();
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(submissionCount, 1);

  pushFleet?.({ selectedEnvId: null, railCollapsed: false, environments: [] });
  await tick();
  pushFleet?.(fleetSnapshot);
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!hidden($(w, '#risk-recovery-row')));

  ($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).click();
  $(w, '#risk-recovery-confirm-submit').click();
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(submissionCount, 2);
  assert.equal(($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).disabled, true);

  oldPoll.resolve({
    status: 200,
    ok: true,
    data: { data: {
      envKey: 'fb_env',
      commandId: 'cmd-old',
      state: 'applied',
      status: 'normal',
      changed: true,
      resumedEdges: 1,
    } },
  });
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!hidden($(w, '#risk-recovery-row')), '旧 applied normal 不得写回同 envKey 的新一轮状态');
  assert.equal($(w, '#health-label').textContent, '受限制');
  assert.equal($(w, '#risk-status').textContent, '受限制');
  assert.equal(($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).disabled, true, '新 command pending 不得被旧回执删除');
  assert.equal($(w, '#risk-recovery-feedback').textContent, '');

  newPoll.resolve({
    status: 200,
    ok: true,
    data: { data: {
      envKey: 'fb_env',
      commandId: 'cmd-new',
      state: 'applied',
      status: 'normal',
      changed: true,
      resumedEdges: 1,
    } },
  });
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(hidden($(w, '#risk-recovery-row')), '只有当前新 command 的 applied normal 可以清除 restricted');
});

test('解除受限：不匹配的轮询结果不得清除 restricted', async () => {
  const w = await boot(stoppedRestrictedFbEnv({
    recoverEnvironmentRisk: async () => ({
      status: 202,
      ok: true,
      data: { data: { envKey: 'fb_env', commandId: 'cmd-41', state: 'processing' } },
    }),
    getEnvironmentRiskRecoveryResult: async () => ({
      status: 200,
      ok: true,
      data: { data: {
        envKey: 'fb_env',
        commandId: 'another-command',
        state: 'applied',
        status: 'normal',
        changed: true,
        resumedEdges: 1,
      } },
    }),
  }));
  for (let i = 0; i < 5; i++) await tick();
  ($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).click();
  $(w, '#risk-recovery-confirm-submit').click();
  for (let i = 0; i < 6; i++) await tick();
  assert.ok(!hidden($(w, '#risk-recovery-row')));
  assert.match($(w, '#risk-recovery-feedback').textContent || '', /不匹配/);
  assert.equal(($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).disabled, false);
});

test('解除受限：Cloud 失败保留受限行并展示原位错误', async () => {
  const w = await boot(stoppedRestrictedFbEnv({
    recoverEnvironmentRisk: async () => ({ ok: false, data: { error: 'environment_risk_unavailable', message: '暂时够不到云端' } }),
  }));
  for (let i = 0; i < 5; i++) await tick();
  ($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).click();
  $(w, '#risk-recovery-confirm-submit').click();
  for (let i = 0; i < 3; i++) await tick();
  assert.ok(!hidden($(w, '#risk-recovery-row')));
  assert.equal(($(w, '#risk-recovery-button') as unknown as HTMLButtonElement).disabled, false);
  assert.match($(w, '#risk-recovery-feedback').textContent || '', /够不到云端/);
});

test('解除受限：风险读缓存和按钮随环境切换隔离，不从 A 串到 B', async () => {
  const reads: string[] = [];
  const recoverCalls: string[] = [];
  const statusFor = (envId: string) => makeStatus({ envId, envName: envId, edge: 'stopped', cloud: 'disconnected' });
  const w = await boot(makeStub({
    getStatus: async () => statusFor('a'),
    getSettings: async () => ({
      provider: 'adspower', adsProfileId: 'a', adsApiKey: '', adsApiBase: '', browserParkingMode: 'edge-strip',
      environments: [{ profileId: 'a', name: '环境 A', platform: 'facebook' }, { profileId: 'b', name: '环境 B', platform: 'facebook' }],
    }),
    fleetGet: async () => ({
      selectedEnvId: 'a', railCollapsed: false,
      environments: [
        { envId: 'a', profileId: 'a', name: '环境 A', platform: 'facebook', status: statusFor('a') },
        { envId: 'b', profileId: 'b', name: '环境 B', platform: 'facebook', status: statusFor('b') },
      ],
    }),
    fleetSelect: async () => ({}),
    getEnvironmentRisk: async ({ envKey }) => {
      reads.push(envKey);
      return { ok: true, data: { data: {
        envKey, status: envKey === 'a' ? 'restricted' : 'normal', statusSince: 1000, updatedAt: 2000,
      } } };
    },
    recoverEnvironmentRisk: async ({ envKey }) => {
      recoverCalls.push(envKey);
      return {
        status: 200,
        ok: true,
        data: { data: {
          envKey,
          commandId: 'cmd-env-switch',
          state: 'applied',
          status: 'normal',
          changed: true,
          resumedEdges: 1,
        } },
      };
    },
  }));
  for (let i = 0; i < 6; i++) await tick();
  assert.ok(!hidden($(w, '#risk-recovery-row')), 'A restricted → 显示');
  $(w, '#risk-recovery-button').click();
  assert.equal(($(w, '#risk-recovery-confirm') as unknown as HTMLDialogElement).open, true);
  assert.equal($(w, '#risk-recovery-confirm-env').textContent, '环境 A');
  $(w, '.rail-row[data-env-id="b"]').click();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(($(w, '#risk-recovery-confirm') as unknown as HTMLDialogElement).open, false, '切环境必须关闭旧环境确认层');
  $(w, '#risk-recovery-confirm-submit').click();
  await tick();
  assert.deepEqual(recoverCalls, [], '旧弹层即使被脚本触发确认也不得跨环境请求');
  assert.ok(hidden($(w, '#risk-recovery-row')), 'B normal → 隐藏');
  $(w, '.rail-row[data-env-id="a"]').click();
  await tick();
  assert.ok(!hidden($(w, '#risk-recovery-row')), '切回 A 仍使用 A 自己的 restricted 真态');
  assert.deepEqual([...new Set(reads)].sort(), ['a', 'b']);
});

test('慢启动行：停止的环境经 env-scoped 读渲染真态、开关可点（change slow-start-offline-toggle）', async () => {
  const w = await boot(stoppedFbEnv(async () => ({
    ok: true,
    data: { data: { envKey: 'fb_env', slowStart: { state: 'active', day: 3, totalDays: 7, binding: true, eligible: true }, dayQuotas: { view: 35 } } },
  })));
  for (let i = 0; i < 4; i++) await tick(); // flush 异步 HTTP 读 + 重绘
  assert.ok(!hidden($(w, '#slow-start-row')));
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  assert.equal(toggle.disabled, false, '离线（已停止）也可改——这次写根本不经过环境内核');
  assert.equal(toggle.indeterminate, false);
  assert.equal(toggle.checked, true);
  assert.match($(w, '#slow-start-badge').textContent || '', /慢启动 · 第 3\/7 天/);
});

test('慢启动行：binding_unknown + active → 环境配置保持勾选可操作，不冒充账号已生效', async () => {
  const w = await boot(stoppedFbEnv(async () => ({
    ok: true,
    data: { data: { envKey: 'fb_env', slowStart: {
      state: 'active', day: 2, totalDays: 7, since: Date.now(), eligible: false, ineligibleReason: 'binding_unknown',
    } } },
  })));
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!hidden($(w, '#slow-start-row')));
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, true);
  const reason = $(w, '#slow-start-reason').textContent || '';
  assert.match(reason, /设置跟随当前环境/);
  assert.match(reason, /登录账号后/);
  assert.doesNotMatch($(w, '#slow-start-badge').textContent || '', /档位已更严|不额外限制/);
});

test('慢启动行：binding_unknown + off → 未绑定环境可在登录前预先开启', async () => {
  const calls: unknown[] = [];
  const stub = stoppedFbEnv(async () => ({
    ok: true,
    data: { data: { envKey: 'fb_env', slowStart: {
      state: 'off', totalDays: 7, eligible: false, ineligibleReason: 'binding_unknown',
    } } },
  })) as Stub & { setSlowStart?: (args: unknown) => Promise<unknown> };
  stub.setSlowStart = async (args: unknown) => { calls.push(args); return { ok: false, error: 'test_stop' }; };
  const w = await boot(stub);
  for (let i = 0; i < 4; i++) await tick();
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, false);
  toggle.click();
  await tick();
  assert.equal(JSON.stringify(calls), JSON.stringify([{ envKey: 'fb_env', enabled: true }]));
});

test('慢启动行：env-scoped 读够不到云端 → 就地如实展示失败，绝不静默吞', async () => {
  const w = await boot(stoppedFbEnv(async () => ({ ok: false, data: { error: 'edge_unreachable', message: '暂时够不到云端' } })));
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!hidden($(w, '#slow-start-row')));
  assert.match($(w, '#slow-start-reason').textContent || '', /够不到云端/);
  assert.ok($(w, '#slow-start-reason').classList.contains('is-error'));
});

test('慢启动行：停止的环境离线写入成功 → 呈现为已生效，不显示「已保存/待应用」', async () => {
  const w = await boot(stoppedFbEnv(async () => ({
    ok: true,
    data: { data: { envKey: 'fb_env', slowStart: { state: 'off', totalDays: 7, eligible: true }, dayQuotas: { view: 70 } } },
  }), {
    // 离线写入成功：回执带回 active 真态。
    setSlowStart: async () => ({
      ok: true,
      data: { data: { envKey: 'fb_env', slowStart: { state: 'active', day: 1, totalDays: 7, since: Date.now(), binding: true, eligible: true }, dayQuotas: { view: 20 } } },
    }),
  }));
  for (let i = 0; i < 4; i++) await tick();
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  assert.equal(toggle.checked, false, '读到 off 真态');
  assert.equal(toggle.disabled, false, '停止的环境开关照常可点');
  // 离线写入成功 → 当场呈现为已生效（勾上、有徽章），绝无「已保存/待应用」二态。
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(toggle.checked, true, '离线写入成功后呈现为已生效');
  assert.equal(toggle.disabled, false);
  assert.equal($(w, '#slow-start-row').classList.contains('is-pending'), false);
  assert.match($(w, '#slow-start-badge').textContent || '', /慢启动 · 第 1\/7 天/);
  const flat = `${$(w, '#slow-start-badge').textContent || ''}${$(w, '#slow-start-reason').textContent || ''}`;
  assert.doesNotMatch(flat, /已保存|待应用|待下发/);
});

test('慢启动行：active 态渲染徽章与勾选', async () => {
  const w = await boot(slowStartStub({
    getStatus: async () => makeStatus({
      cloud: 'connected',
      dailyUsage: { asOf: new Date().toISOString(), totals: {}, slowStart: { state: 'active', day: 3, totalDays: 7, binding: true, eligible: true } },
    }),
  }));
  assert.ok(!hidden($(w, '#slow-start-row')));
  assert.equal(($(w, '#slow-start-toggle') as unknown as HTMLInputElement).checked, true);
  assert.match($(w, '#slow-start-badge').textContent || '', /慢启动 · 第 3\/7 天/);
});

test('慢启动行：小红书即使收到 active 快照也整行隐藏', async () => {
  const w = await boot(slowStartStub({
    getStatus: async () => makeStatus({
      cloud: 'connected',
      dailyUsage: { asOf: new Date().toISOString(), totals: {}, slowStart: { state: 'active', day: 3, totalDays: 7, binding: true, eligible: true } },
    }),
  }, 'xiaohongshu'));
  assert.ok(hidden($(w, '#slow-start-row')));
  assert.equal($(w, '#slow-start-row').getAttribute('aria-busy'), null);
});

test('慢启动行：binding=false 如实标注「不额外限制」，不宣称在压低配额', async () => {
  const w = await boot(slowStartStub({
    getStatus: async () => makeStatus({
      cloud: 'connected',
      dailyUsage: { asOf: new Date().toISOString(), totals: {}, slowStart: { state: 'active', day: 5, totalDays: 7, binding: false, eligible: true } },
    }),
  }));
  assert.match($(w, '#slow-start-badge').textContent || '', /当前档位已更严，不额外限制/);
});

test('慢启动行：eligible=false → 勾选禁用 + 如实说明', async () => {
  const w = await boot(slowStartStub({
    getStatus: async () => makeStatus({
      cloud: 'connected',
      dailyUsage: { asOf: new Date().toISOString(), totals: {}, slowStart: { state: 'off', totalDays: 7, eligible: false, ineligibleReason: 'platform_unsupported' } },
    }),
  }));
  assert.equal(($(w, '#slow-start-toggle') as unknown as HTMLInputElement).disabled, true);
  assert.match($(w, '#slow-start-reason').textContent || '', /该平台暂不支持/);
});

test('慢启动行：开启等待期间保留普通人设，成功回执才对齐真态与今日计划', async () => {
  const write = deferred<unknown>();
  let pushStatus: ((status: unknown) => void) | undefined;
  const initial = makeStatus({
    cloud: 'connected',
    dailyUsage: {
      asOf: new Date().toISOString(),
      totals: { view: 3 },
      quotas: { view: 80 },
      windows: { day: { totals: { view: 3 }, quotas: { view: 80 }, saturated: [] } },
      slowStart: { state: 'off', totalDays: 7, eligible: true },
    },
  });
  const w = await boot(slowStartStub({
    onStatusUpdate: (cb) => { pushStatus = cb; },
    getStatus: async () => initial,
    setSlowStart: async () => write.promise,
  }));
  const mode = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  const policyRow = $(w, '#facebook-operation-policy-row');
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;

  mode.value = 'slow_start';
  mode.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(mode.value, 'persona', 'pending 时不得乐观选中冷启动');
  assert.equal(mode.disabled, true);
  assert.equal(policyRow.getAttribute('aria-busy'), 'true');
  assert.ok(policyRow.classList.contains('is-pending'));
  assert.doesNotMatch($(w, '#slow-start-badge').textContent || '', /第 1\/7 天/, 'pending 不得本地冒充 D1');
  assert.match($(w, '#facebook-operation-policy-status').textContent || '', /等待 Cloud 回读确认/);

  pushStatus?.(initial); // PUT 仍在途时到达写前旧快照
  await tick();
  assert.equal(mode.value, 'persona', '写入在途必须持续显示旧 Cloud 确认态');
  assert.ok(policyRow.classList.contains('is-pending'), '旧快照不得清掉等待态');

  write.resolve({
    ok: true,
    data: {
      data: {
        envKey: '__local__',
        slowStart: { state: 'active', day: 1, totalDays: 7, since: Date.now(), binding: true, eligible: true },
        dayQuotas: { view: 20 },
      },
    },
  });
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(policyRow.hasAttribute('aria-busy'), false);
  assert.equal(policyRow.classList.contains('is-pending'), false);
  assert.equal(mode.value, 'slow_start');
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  assert.match($(w, '#slow-start-badge').textContent || '', /慢启动 · 第 1\/7 天/);
  assert.equal($(w, '#views-cap').textContent, '/20', '成功回执的 dayQuotas 应当场更新，不等下一次快照');
});

test('慢启动行：选择普通人设失败后保留权威开启态，并保留云端失败原因', async () => {
  const w = await boot(slowStartStub({
    getStatus: async () => makeStatus({
      cloud: 'connected',
      dailyUsage: {
        asOf: new Date().toISOString(),
        totals: { view: 3 },
        quotas: { view: 20 },
        slowStart: { state: 'active', day: 3, totalDays: 7, binding: true, eligible: true },
      },
    }),
    setSlowStart: async () => ({ ok: false, data: { error: { code: 'EDGE_OFFLINE', message: '该环境当前未连接，暂时无法更改。' } } }),
  }));
  const mode = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  mode.value = 'persona';
  mode.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(mode.value, 'slow_start');
  assert.equal(toggle.checked, true, 'pending 时仍显示权威 slow_start');
  assert.match($(w, '#facebook-operation-policy-status').textContent || '', /等待 Cloud 回读确认/);

  for (let i = 0; i < 3; i++) await tick();
  assert.equal(toggle.checked, true, '失败后必须回到未被篡改的权威 active 状态');
  assert.equal(toggle.disabled, false);
  assert.equal($(w, '#slow-start-row').classList.contains('is-pending'), false);
  assert.match($(w, '#slow-start-badge').textContent || '', /第 3\/7 天/);
  assert.match($(w, '#facebook-operation-policy-status').textContent || '', /当前未连接/);
  assert.ok($(w, '#facebook-operation-policy-status').classList.contains('is-error'));
});

test('慢启动行：A 环境写入反馈不串到 B，A 回执也不改写当前 B', async () => {
  const writeA = deferred<unknown>();
  let pushStatus: ((status: unknown) => void) | undefined;
  const statusFor = (envId: string, state: 'off' | 'active') => makeStatus({
    envId,
    envName: `环境 ${envId}`,
    cloud: 'connected',
    edge: 'running',
    session: 'running',
    updatedAt: new Date().toISOString(),
    dailyUsage: {
      asOf: new Date().toISOString(),
      totals: { view: 1 },
      quotas: { view: state === 'active' ? 20 : 80 },
      slowStart: state === 'active'
        ? { state: 'active', day: 1, totalDays: 7, binding: true, eligible: true }
        : { state: 'off', totalDays: 7, eligible: true },
    },
  });
  const w = await boot(slowStartStub({
    onStatusUpdate: (cb) => { pushStatus = cb; },
    getStatus: async () => statusFor('A', 'off'),
    setSlowStart: async ({ envKey }) => envKey === 'A' ? writeA.promise : ({ ok: false }),
  }));
  const mode = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  mode.value = 'slow_start';
  mode.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(mode.value, 'persona', 'A 写入在途仍显示 A 的确认态');
  assert.match($(w, '#facebook-operation-policy-status').textContent || '', /等待 Cloud 回读确认/);

  pushStatus?.(statusFor('B', 'off'));
  await tick();
  const rowB = w.document.querySelector('.rail-row[data-env-id="B"]') as unknown as HTMLElement;
  assert.ok(rowB, 'B 环境应进入左栏');
  rowB.dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.equal($(w, '#facebook-operation-policy-row').classList.contains('is-pending'), false);
  assert.equal(mode.value, 'persona');
  assert.equal(toggle.checked, false);
  assert.doesNotMatch($(w, '#slow-start-reason').textContent || '', /等待云端确认/);

  writeA.resolve({
    ok: true,
    data: { data: { envKey: 'A', slowStart: { state: 'active', day: 1, totalDays: 7, binding: true, eligible: true }, dayQuotas: { view: 20 } } },
  });
  await tick();
  assert.equal(mode.value, 'persona');
  assert.equal(toggle.checked, false, 'A 回执到达时当前 B 仍应保持 off');

  const rowA = w.document.querySelector('.rail-row[data-env-id="A"]') as unknown as HTMLElement;
  rowA.dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.equal(mode.value, 'slow_start');
  assert.equal(toggle.checked, true, '切回 A 后应看到 A 的成功写后真态');
  assert.match($(w, '#slow-start-badge').textContent || '', /第 1\/7 天/);
});

// 这条守的是 design D8 点名的那个坑：整卡点击委托只认 closest('button')，checkbox / label 都不是
// button → 不 stopPropagation 就会点勾选框连带展开/收起「今日节奏」。更难看的是 <label> 包 <input>
// 时点文字合成两次冒泡 → 切换两次 → 净效果为零，而直接点滑块只冒泡一次 → 切换一次。
// **同一控件点在不同位置行为不同，人工点测会当「偶发」放过**。
test('慢启动行：点勾选框 MUST NOT 连带展开/收起「今日节奏」', async () => {
  const w = await boot(slowStartStub({
    getStatus: async () => makeStatus({
      cloud: 'connected',
      dailyUsage: {
        asOf: new Date().toISOString(),
        totals: { view: 3 },
        windows: { day: { totals: { view: 3 }, quotas: { view: 20 }, saturated: [] } },
        slowStart: { state: 'off', totalDays: 7, eligible: true },
      },
    }),
  }));
  const summary = $(w, '#daily-summary');
  const before = summary.classList.contains('expanded');
  // 点包住 input 的 <label>（最容易出双次冒泡的那个位置）
  $(w, '#slow-start-toggle-wrap').dispatchEvent(new w.Event('click', { bubbles: true }));
  await tick();
  assert.equal(summary.classList.contains('expanded'), before, '点慢启动开关不得改变今日节奏的展开态');
});

// ── unified Facebook operation policy：冷启动 > 规则 > 消费 > 人设 ──

function facebookOperationPolicyReceipt(
  envKey: string,
  mode: 'persona' | 'slow_start' | 'rule' | 'consumption',
  policyRevision = 3,
  primarySurface: 'feed' | 'reels' = 'reels',
  surfaceRevision = 1,
) {
  return {
    ok: true,
    data: {
      data: {
        envKey,
        facebookOperationPolicy: {
          primarySurface,
          surfaceRevision,
          baseMode: mode === 'slow_start' ? 'persona' : mode,
          effectiveMode: mode,
          policyRevision,
          slowStart: { state: mode === 'slow_start' ? 'active' : 'off' },
          blocker: null,
        },
      },
    },
  };
}

function facebookRuleModeStub(overrides: Partial<Stub> = {}, platform = 'facebook'): Stub {
  return slowStartStub({
    getFacebookOperationPolicy: async ({ envKey }) =>
      facebookOperationPolicyReceipt(envKey, 'persona'),
    setFacebookOperationPolicy: async ({ envKey, expectedRevision, mode }) =>
      facebookOperationPolicyReceipt(envKey, mode, expectedRevision + 1),
    setFacebookPrimarySurface: async ({ envKey, expectedRevision, primarySurface }) =>
      facebookOperationPolicyReceipt(envKey, 'persona', 3, primarySurface, expectedRevision + 1),
    ...overrides,
  }, platform);
}

test('运行方式：停止的 Facebook 环境仍读取 Cloud 配置，非 Facebook 整行隐藏', async () => {
  const calls: string[] = [];
  const w = await boot(facebookRuleModeStub({
    getStatus: async () => makeStatus({
      envId: 'fb-stopped',
      edge: 'stopped',
      session: 'idle',
      browserState: 'closed',
    }),
    getFacebookOperationPolicy: async ({ envKey }) => {
      calls.push(envKey);
      return facebookOperationPolicyReceipt(envKey, 'rule');
    },
  }));
  const row = $(w, '#facebook-operation-policy-row');
  const select = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  assert.ok(!hidden(row));
  assert.equal(select.value, 'rule');
  assert.equal(select.disabled, false);
  assert.equal(calls.length, 1, '停止环境仍只需一次 env-scoped HTTP 读');

  let nonFacebookReads = 0;
  const xhs = await boot(facebookRuleModeStub({
    getFacebookOperationPolicy: async ({ envKey }) => {
      nonFacebookReads += 1;
      return facebookOperationPolicyReceipt(envKey, 'rule');
    },
  }, 'xiaohongshu'));
  assert.ok(hidden($(xhs, '#facebook-operation-policy-row')));
  assert.equal(nonFacebookReads, 0, '非 Facebook 不应触发规则模式读取');
});

test('运行方式：读取失败或不完整回包保持 unknown，绝不伪造默认值', async () => {
  const failed = await boot(facebookRuleModeStub({
    getFacebookOperationPolicy: async () => ({ ok: false, data: { error: 'binding_unknown' } }),
  }));
  const failedSelect = $(failed, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  assert.equal(failedSelect.disabled, true);
  assert.match($(failed, '#facebook-operation-policy-status').textContent || '', /binding_unknown/);

  const incomplete = await boot(facebookRuleModeStub({
    getFacebookOperationPolicy: async ({ envKey }) => ({
      ok: true,
      data: { data: { envKey, facebookOperationPolicy: { baseMode: 'persona' } } },
    }),
  }));
  const incompleteSelect = $(incomplete, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  assert.equal(incompleteSelect.disabled, true);
  assert.match($(incomplete, '#facebook-operation-policy-status').textContent || '', /暂时无法读取/);

  const cadenceLeaked: any = facebookOperationPolicyReceipt('__local__', 'consumption');
  cadenceLeaked.data.data.facebookOperationPolicy.viewsPerLike = 5;
  const nonCadenceFree = await boot(facebookRuleModeStub({
    getFacebookOperationPolicy: async () => cadenceLeaked,
  }));
  const consumptionSelect = $(nonCadenceFree, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  assert.equal(consumptionSelect.disabled, true);
  assert.match($(nonCadenceFree, '#facebook-operation-policy-status').textContent || '', /暂时无法读取/);
});

test('运行方式：写入中保留最后确认的普通人设，完整 Cloud 回执后才切到规则', async () => {
  const write = deferred<unknown>();
  let writtenEnvKey = '';
  const w = await boot(facebookRuleModeStub({
    setFacebookOperationPolicy: async (args) => {
      writtenEnvKey = args.envKey;
      return write.promise;
    },
  }));
  const select = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  const row = $(w, '#facebook-operation-policy-row');
  assert.equal(select.value, 'persona');

  select.value = 'rule';
  select.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(select.value, 'persona', 'pending 时必须恢复最后一份 Cloud 确认态');
  assert.equal(select.disabled, true);
  assert.equal(row.getAttribute('aria-busy'), 'true');
  assert.match($(w, '#facebook-operation-policy-status').textContent || '', /等待 Cloud 回读确认/);
  assert.ok(writtenEnvKey);

  write.resolve(facebookOperationPolicyReceipt(writtenEnvKey, 'rule', 4));
  await tick();
  assert.equal(select.value, 'rule');
  assert.equal(select.disabled, false);
  assert.equal(row.hasAttribute('aria-busy'), false);
});

test('消费模式行：与冷启动/规则互斥，写入只带 envKey、revision、mode 并以 Cloud 回读收敛', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const w = await boot(facebookRuleModeStub({
    setFacebookOperationPolicy: async (args) => {
      writes.push(args);
      return facebookOperationPolicyReceipt(args.envKey, args.mode, args.expectedRevision + 1);
    },
  }));
  const select = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  assert.equal(select.value, 'persona');

  select.value = 'consumption';
  select.dispatchEvent(new w.Event('change', { bubbles: true }));
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(writes[0]?.envKey, '__local__');
  assert.equal(writes[0]?.expectedRevision, 3);
  assert.equal(writes[0]?.mode, 'consumption');
  assert.deepEqual(Object.keys(writes[0] || {}).sort(), ['envKey', 'expectedRevision', 'mode']);
  assert.equal(select.value, 'consumption');

  select.value = 'persona';
  select.dispatchEvent(new w.Event('change', { bubbles: true }));
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(writes[1]?.expectedRevision, 4);
  assert.equal(writes[1]?.mode, 'persona');
  assert.equal(select.value, 'persona');
});

test('主浏览入口：Reels/Feed 独立 CAS，修改时保持运行方式不变', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const w = await boot(facebookRuleModeStub({
    getFacebookOperationPolicy: async ({ envKey }) =>
      facebookOperationPolicyReceipt(envKey, 'consumption', 8, 'reels', 3),
    setFacebookPrimarySurface: async (args) => {
      writes.push(args);
      return facebookOperationPolicyReceipt(
        args.envKey,
        'consumption',
        8,
        args.primarySurface,
        args.expectedRevision + 1,
      );
    },
  }));
  const mode = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  const surface = $(w, '#facebook-primary-surface-select') as unknown as HTMLSelectElement;
  assert.equal(mode.value, 'consumption');
  assert.equal(surface.value, 'reels');

  surface.value = 'feed';
  surface.dispatchEvent(new w.Event('change', { bubbles: true }));
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(
    JSON.stringify(writes),
    JSON.stringify([{ envKey: '__local__', expectedRevision: 3, primarySurface: 'feed' }]),
  );
  assert.equal(surface.value, 'feed');
  assert.equal(mode.value, 'consumption');
});

test('运行方式：Cloud 的 active slow-start 在四选一中胜出', async () => {
  const w = await boot(facebookRuleModeStub({
    getFacebookOperationPolicy: async ({ envKey }) => ({
      ok: true,
      data: {
        data: {
          envKey,
          facebookOperationPolicy: {
            primarySurface: 'reels',
            surfaceRevision: 1,
            baseMode: 'rule',
            effectiveMode: 'slow_start',
            policyRevision: 9,
            slowStart: { state: 'active' },
            blocker: null,
          },
        },
      },
    }),
  }));
  const select = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  assert.equal(select.value, 'slow_start');
});

test('运行方式：未绑定环境以 active 锚点确认冷启动，不要求伪造 effectiveMode', async () => {
  const w = await boot(facebookRuleModeStub({
    setFacebookOperationPolicy: async ({ envKey, expectedRevision }) => ({
      ok: true,
      data: {
        data: {
          envKey,
          facebookOperationPolicy: {
            primarySurface: 'reels',
            surfaceRevision: 1,
            baseMode: 'persona',
            effectiveMode: null,
            policyRevision: expectedRevision + 1,
            slowStart: { state: 'active' },
            blocker: null,
          },
        },
      },
    }),
  }));
  const select = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;

  select.value = 'slow_start';
  select.dispatchEvent(new w.Event('change', { bubbles: true }));
  for (let i = 0; i < 3; i++) await tick();

  assert.equal(select.value, 'slow_start');
  assert.doesNotMatch($(w, '#facebook-operation-policy-status').textContent || '', /回读与本次选择不一致/);
});

test('运行方式：写失败或成功回执不完整时保留最近 Cloud 真态并后台复读', async () => {
  for (const response of [
    { ok: false, data: { error: { code: 'binding_conflict', message: '环境绑定冲突' } } },
    { ok: true, data: { data: { envKey: '__local__', facebookOperationPolicy: { baseMode: 'rule' } } } },
  ]) {
    const refresh = deferred<unknown>();
    let reads = 0;
    const w = await boot(facebookRuleModeStub({
      getFacebookOperationPolicy: async ({ envKey }) => {
        reads += 1;
        return reads === 1
          ? facebookOperationPolicyReceipt(envKey, 'persona')
          : refresh.promise;
      },
      setFacebookOperationPolicy: async () => response,
    }));
    const select = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
    select.value = 'rule';
    select.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick();
    assert.equal(select.value, 'persona', '失败后的后台 GET 在途时仍保留最后确认态');
    assert.equal(select.disabled, false);
    assert.equal($(w, '#facebook-operation-policy-row').hasAttribute('aria-busy'), false);
    assert.ok($(w, '#facebook-operation-policy-status').classList.contains('is-error'));
    refresh.resolve(facebookOperationPolicyReceipt('__local__', 'persona'));
    await tick();
  }
});

test('运行方式：A 写入期间切到 B，A 晚到回执不改写 B', async () => {
  const writeA = deferred<unknown>();
  let pushStatus: ((status: unknown) => void) | undefined;
  const configs = new Map([['A', false], ['B', false]]);
  const statusFor = (envId: string) => makeStatus({
    envId,
    envName: `环境 ${envId}`,
    cloud: 'connected',
    edge: 'stopped',
    session: 'idle',
    updatedAt: new Date().toISOString(),
  });
  const w = await boot(facebookRuleModeStub({
    onStatusUpdate: (cb) => { pushStatus = cb; },
    getStatus: async () => statusFor('A'),
    getFacebookOperationPolicy: async ({ envKey }) =>
      facebookOperationPolicyReceipt(envKey, configs.get(envKey) ? 'rule' : 'persona'),
    setFacebookOperationPolicy: async ({ envKey, mode, expectedRevision }) => {
      if (envKey === 'A') return writeA.promise;
      configs.set(envKey, mode === 'rule');
      return facebookOperationPolicyReceipt(envKey, mode, expectedRevision + 1);
    },
  }));
  const select = $(w, '#facebook-operation-mode-select') as unknown as HTMLSelectElement;
  select.value = 'rule';
  select.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.match($(w, '#facebook-operation-policy-status').textContent || '', /等待 Cloud 回读确认/);

  pushStatus?.(statusFor('B'));
  await tick();
  const rowB = w.document.querySelector('.rail-row[data-env-id="B"]') as unknown as HTMLElement;
  assert.ok(rowB);
  rowB.dispatchEvent(new w.Event('click', { bubbles: true }));
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(select.value, 'persona');
  assert.equal($(w, '#facebook-operation-policy-row').classList.contains('is-pending'), false);

  configs.set('A', true);
  writeA.resolve(facebookOperationPolicyReceipt('A', 'rule', 4));
  await tick();
  assert.equal(select.value, 'persona', 'A 晚到回执不得改写当前 B');

  const rowA = w.document.querySelector('.rail-row[data-env-id="A"]') as unknown as HTMLElement;
  rowA.dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.equal(select.value, 'rule', '切回 A 才显示 A 的写后真态');
});

test('规则模式行：点击开关不连带展开今日节奏', async () => {
  const w = await boot(facebookRuleModeStub());
  const summary = $(w, '#daily-summary');
  const before = summary.classList.contains('expanded');
  $(w, '#facebook-rule-mode-toggle-wrap').dispatchEvent(new w.Event('click', { bubbles: true }));
  await tick();
  assert.equal(summary.classList.contains('expanded'), before);
});
