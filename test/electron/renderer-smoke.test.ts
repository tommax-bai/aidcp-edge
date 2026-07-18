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
const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
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
  getStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  pause: () => Promise<unknown>;
  resume: () => Promise<unknown>;
  close: () => Promise<unknown>;
  start: () => Promise<unknown>;
  restart: () => Promise<unknown>;
  relogin: () => Promise<unknown>;
  openAdsDownload: () => void;
  showDrivenBrowser: () => Promise<{ ok: boolean; error?: string }>;
  resetBrowserParking: () => Promise<{ ok: boolean; error?: string }>;
  adsStatus: (opts?: unknown) => Promise<{ ok: boolean; error?: string }>;
  adsListProfiles: (opts?: unknown) => Promise<unknown>;
  adsOpenCreate: () => { launched: boolean } | Promise<{ launched: boolean }>;
  adsTemplates: () => Promise<Array<{ key: string; label: string }>>;
  adsCreateEnv: (opts?: unknown) => Promise<{ ok: boolean; userId?: string; name?: string; template?: string; error?: string; createdCount?: number; created?: unknown[]; platform?: string; visibilityWarning?: string; requiresAdminAssignment?: boolean; assignmentHandledByMain?: boolean; rosterJoinedByMain?: boolean }>;
  adsDeleteEnv: (opts?: unknown) => Promise<{ ok: boolean; error?: string; cleanupPending?: boolean; message?: string }>;
  setSlowStart: (opts: { envKey: string; enabled: boolean }) => Promise<unknown>;
  // 不依赖边缘的慢启动读（change slow-start-offline-toggle）：可选——不提供即模拟老客户端退化路径。
  getSlowStart?: (opts: { envKey: string }) => Promise<unknown>;
}

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
    start: async () => makeStatus({ edge: 'starting', session: 'running' }),
    restart: async () => makeStatus({ edge: 'starting', session: 'running' }),
    relogin: async () => makeStatus(),
    openAdsDownload: () => undefined,
    showDrivenBrowser: async () => ({ ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' }),
    resetBrowserParking: async () => ({ ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' }),
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    adsOpenCreate: () => ({ launched: true }),
    adsTemplates: async () => [{ key: 'win11-intel', label: 'Windows · 8核 8G' }],
    adsCreateEnv: async () => ({ ok: true, template: 'win11-intel' }),
    adsDeleteEnv: async () => ({ ok: true }),
    setSlowStart: async () => ({ ok: false, data: { message: '测试桩未配置慢启动写入' } }),
    ...overrides,
  };
}

async function boot(stub: Stub): Promise<DOMWindow> {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  openWindows.push(window);
  (window as unknown as { aidcpEdge: Stub }).aidcpEdge = stub;
  window.eval(uiLogicSrc); // 纯视图逻辑先注入（真实加载顺序同 index.html 的 <script> 顺序）
  window.eval(rendererSrc);
  for (let i = 0; i < 5; i++) await tick(); // flush getSettings→probe→auto refreshEnvs 链
  return window;
}

const $ = (w: DOMWindow, sel: string) => w.document.querySelector(sel) as unknown as HTMLElement;
const $$ = (w: DOMWindow, sel: string) => Array.from(w.document.querySelectorAll(sel)) as unknown as HTMLElement[];
const hidden = (el: HTMLElement) => el.classList.contains('hidden');

test('中文化：新增控件文案齐全', () => {
  // 环境管理与人设已搬到左栏浮层；设置抽屉只剩浏览器引擎 + 窗口停放 + 开发者开关。
  for (const s of ['浏览器引擎', '本机 Chrome', '添加环境', '加入现有环境', '新建环境', '刷新', '手动填写', '创建环境', '账号人设', '窗口停放', '主屏停放', '副屏停放', '边缘停放', '完全移出', '指纹浏览器高级设置']) {
    assert.ok(html.includes(s), `index.html 应含「${s}」`);
  }
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
  assert.match($(w, '#settings-msg').textContent ?? '', /添加环境/);
  // 环境管理已搬到左栏：诚实提示直达「添加环境」面板（不再打开设置抽屉）。
  assert.equal($(w, '#env-add-panel').classList.contains('open'), true, '提示应打开添加环境面板，避免启动按钮像没反应');
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

test('窗口停放：无可控浏览器时显示浏览器诚实失败', async () => {
  const w = await boot(makeStub({
    showDrivenBrowser: async () => ({ ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' }),
  }));
  $(w, '#browser-show').dispatchEvent(new w.Event('click'));
  await tick();
  assert.match($(w, '#settings-msg').textContent ?? '', /引擎未运行或浏览器尚未就绪，请先启动引擎再操作/);
});

test('今日进展生命周期控制：关闭/停止→启动，运行→暂停，暂停→关闭+恢复', async () => {
  const stopped = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'stopped' }) }));
  assert.equal($(stopped, '#session-fab').textContent, '启动');
  const closed = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'stopped', session: 'closed' }) }));
  assert.equal($(closed, '#session-fab').textContent, '启动');
  assert.ok($(closed, '#session-close').classList.contains('hidden'));
  const running = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'running', session: 'running' }) }));
  assert.equal($(running, '#session-fab').textContent, '暂停');
  const resting = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'running', session: 'resting' }) }));
  assert.equal($(resting, '#session-fab').textContent, '暂停');
  const paused = await boot(makeStub({ getStatus: async () => makeStatus({ session: 'paused' }) }));
  assert.equal($(paused, '#session-fab').textContent, '恢复');
  assert.equal($(paused, '#session-close').textContent, '关闭');
  assert.ok(!$(paused, '#session-close').classList.contains('hidden'));
});

test('暂停态点击关闭：调用显式 close 并切到已关闭/启动', async () => {
  let closes = 0;
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ session: 'paused', edge: 'stopped' }),
    close: async () => { closes++; return makeStatus({ session: 'closed', edge: 'stopped', cloud: 'disconnected' }); },
  }));
  $(w, '#session-close').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(closes, 1);
  assert.equal($(w, '#session-fab').textContent, '启动');
  assert.ok($(w, '#session-close').classList.contains('hidden'));
});

test('程序化建号：填充模板下拉、点「创建环境」→ 传选中模板、成功提示 + 刷新', async () => {
  let sentTemplate = '';
  const w = await boot(makeStub({
    adsCreateEnv: async (opts) => {
      sentTemplate = (opts as { templateKey?: string }).templateKey ?? '';
      return { ok: true, template: sentTemplate };
    },
  }));
  for (let i = 0; i < 3; i++) await tick(); // flush populateTemplates()
  const sel = $(w, '#ads-template') as unknown as HTMLSelectElement;
  assert.ok(sel.options.length >= 1, '模板下拉应被填充');
  assert.equal(sel.value, 'win11-intel');

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(sentTemplate, 'win11-intel', '应把选中模板传给 adsCreateEnv');
  assert.match($(w, '#ads-create-msg').textContent ?? '', /已创建环境/);
});

test('新增环境可选择视频号，并以 wechat_channels 创建、入册和持久化', async () => {
  let sent: Record<string, unknown> = {};
  let savedEnvironments: Array<{ profileId: string; name: string; platform: string }> = [];
  const w = await boot(makeStub({
    adsCreateEnv: async (opts) => {
      sent = opts as Record<string, unknown>;
      return { ok: true, userId: 'u_wechat', name: '视频号环境', template: 'win11-intel', platform: 'wechat_channels' };
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

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sent.platform, 'wechat_channels');
  assert.equal(sent.facebookAccountImport, '');
  assert.equal(savedEnvironments.length, 1);
  assert.equal(savedEnvironments[0]?.profileId, 'u_wechat');
  assert.equal(savedEnvironments[0]?.name, '视频号环境');
  assert.equal(savedEnvironments[0]?.platform, 'wechat_channels');
  assert.equal(($(w, '#ads-profile') as HTMLInputElement).value, 'u_wechat');
  assert.match($(w, '#ads-create-msg').textContent ?? '', /已自动选中/);
});

test('Facebook 导入框：仅 Facebook 平台显示，创建时透传但提示不泄露账号资料', async () => {
  let sent: Record<string, unknown> = {};
  const secretLine = 'a@example.com----pw-secret----KEYSECRET----c_user=100000000000001; xs=TOKEN';
  const w = await boot(makeStub({
    adsCreateEnv: async (opts) => {
      sent = opts as Record<string, unknown>;
      return { ok: true, createdCount: 2, created: [{ userId: 'u1' }, { userId: 'u2' }], platform: 'facebook' };
    },
  }));
  for (let i = 0; i < 3; i++) await tick();
  assert.ok($(w, '#ads-fb-import-wrap').classList.contains('hidden'), '默认小红书不显示导入框');

  const platform = $(w, '#ads-platform') as HTMLSelectElement;
  platform.value = 'facebook';
  platform.dispatchEvent(new w.Event('change'));
  assert.ok(!$(w, '#ads-fb-import-wrap').classList.contains('hidden'), 'Facebook 平台显示导入框');
  ($(w, '#ads-fb-import') as HTMLTextAreaElement).value = `${secretLine}\n${secretLine}`;

  $(w, '#ads-create').dispatchEvent(new w.Event('click'));
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(sent.platform, 'facebook');
  assert.equal(sent.facebookAccountImport, `${secretLine}\n${secretLine}`);
  const msg = $(w, '#ads-create-msg').textContent ?? '';
  assert.match(msg, /已创建 2 个环境/);
  assert.doesNotMatch(msg, /a@example.com|pw-secret|KEYSECRET|TOKEN/);
  assert.equal(($(w, '#ads-fb-import') as HTMLTextAreaElement).value, '', '成功后清空一次性输入');
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
    adsCreateEnv: async () => ({ ok: true, userId: 'u_new', template: 'win11-intel' }),
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
    .map((p) => (p && (p.environments as Array<{ profileId?: string; name?: string }>)) || [])
    .flat()
    .filter((e) => e && e.profileId === profileId);

test('创建环境：回执带回真名 → 花名册落盘真名（不再空名 → 左栏与面板一致）', async () => {
  const saved: Array<Record<string, unknown>> = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped' }), // coreRunning=false → 新建即自动选中
    adsStatus: async () => ({ ok: true }),
    // 新建后紧接着的自动刷新里 user/list 尚未带出新环境（传播延迟）——正是需要「回执带名」兜住的场景
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    adsTemplates: async () => [{ key: 'win11-intel', label: 'Windows · 8核 8G' }],
    adsCreateEnv: async () => ({ ok: true, userId: 'newu', name: '我的新环境', platform: 'xiaohongshu', template: 'win11-intel' }),
    saveSettings: async (patch: unknown) => { saved.push((patch as Record<string, unknown>) || {}); return { provider: 'adspower', ...(patch as object), saveOk: true }; },
  }));
  (($(w, '#ads-template')) as unknown as { value: string }).value = 'win11-intel';
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
  return makeStub({
    getSettings: async () => ({
      provider: 'adspower', adsProfileId: '', adsApiKey: '', adsApiBase: '',
      browserParkingMode: 'edge-strip', adsDownloadUrl: 'https://x', platform,
    }),
    ...overrides,
  });
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

test('慢启动行：常驻说明使用新的 7 天/账号档位短文案', () => {
  const copy = new JSDOM(html).window.document.querySelector('.slow-start-copy')?.textContent?.trim();
  assert.equal(copy, '开启后头 7 天按曲线逐日放开量，7天后按账号档位运行。');
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

test('慢启动行：字段缺省 → 整行 hidden（绝不默认成「关」）', async () => {
  const w = await boot(slowStartStub({ getStatus: async () => makeStatus({ edge: 'running', session: 'running', cloud: 'connected' }) }));
  assert.ok(hidden($(w, '#slow-start-row')), '云端还没说 → 整行不渲染');
});

// 退化路径（老客户端未提供不依赖边缘的读）：仍展示入口、不默认成「关」，退回旧占位、绝不卡在「正在读取」。
test('慢启动行：Facebook 环境未启动 + 无 env-scoped 读能力（老客户端）→ 退回旧占位，不默认成「关」', async () => {
  const w = await boot(slowStartStub({
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
    // 刻意不提供 getSlowStart（模拟老客户端）。
  }));
  assert.ok(!hidden($(w, '#slow-start-row')));
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.indeterminate, true, '未知态必须用 indeterminate，不能显示成已关闭');
  assert.match($(w, '#slow-start-reason').textContent || '', /启动环境并连接云端后同步慢启动状态/);
});

// 停止的环境（内核未运行、无云链路，dailyUsage=null）+ 有绑定 → 经不依赖边缘的 env-scoped 读渲染真态，
// **开关可点**（离线可改）。**验收必须用已停止的环境**——冷待机（cloud=connected）本来就能点，用它测会假绿（task 7.1）。
function stoppedFbEnv(getSlowStart: Stub['getSlowStart']): Stub {
  return slowStartStub({
    getSettings: async () => ({
      provider: 'adspower', adsProfileId: 'fb_env', adsProfileName: 'FB 环境', adsApiKey: '', adsApiBase: '',
      browserParkingMode: 'edge-strip', adsDownloadUrl: 'https://x', platform: 'facebook',
      environments: [{ profileId: 'fb_env', name: 'FB 环境', platform: 'facebook' }],
    }),
    getStatus: async () => makeStatus({ envId: 'fb_env', edge: 'stopped', session: 'idle', cloud: 'disconnected', dailyUsage: null }),
    getSlowStart,
  });
}

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

test('慢启动行：binding_unknown → 整行可见、开关禁用、专属可行动文案（非泛化兜底、非整行隐藏）', async () => {
  const w = await boot(stoppedFbEnv(async () => ({
    ok: true,
    data: { data: { envKey: 'fb_env', slowStart: { eligible: false, ineligibleReason: 'binding_unknown' } } },
  })));
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!hidden($(w, '#slow-start-row')), 'MUST NOT 整行隐藏（与修复前一模一样）');
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  assert.equal(toggle.disabled, true);
  const reason = $(w, '#slow-start-reason').textContent || '';
  assert.match(reason, /尚未识别到该环境的账号/);
  assert.match(reason, /启动一次该环境/, '给出可行动的下一步');
  assert.notEqual(reason, '当前无法启用慢启动', '绝不落到泛化兜底');
});

test('慢启动行：env-scoped 读够不到云端 → 就地如实展示失败，绝不静默吞', async () => {
  const w = await boot(stoppedFbEnv(async () => ({ ok: false, data: { error: 'edge_unreachable', message: '暂时够不到云端' } })));
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!hidden($(w, '#slow-start-row')));
  assert.match($(w, '#slow-start-reason').textContent || '', /够不到云端/);
  assert.ok($(w, '#slow-start-reason').classList.contains('is-error'));
});

test('慢启动行：停止的环境离线写入成功 → 呈现为已生效，不显示「已保存/待应用」', async () => {
  const base = stoppedFbEnv(async () => ({
    ok: true,
    data: { data: { envKey: 'fb_env', slowStart: { state: 'off', totalDays: 7, eligible: true }, dayQuotas: { view: 70 } } },
  }));
  const w = await boot({
    ...base,
    // 离线写入成功：回执带回 active 真态。
    setSlowStart: async () => ({
      ok: true,
      data: { data: { envKey: 'fb_env', slowStart: { state: 'active', day: 1, totalDays: 7, since: Date.now(), binding: true, eligible: true }, dayQuotas: { view: 20 } } },
    }),
  });
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

test('慢启动行：开启后立即显示等待态，旧快照不回拨，成功回执当场对齐真态与今日计划', async () => {
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
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  const row = $(w, '#slow-start-row');

  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, true);
  assert.equal(row.getAttribute('aria-busy'), 'true');
  assert.ok(row.classList.contains('is-pending'));
  assert.match($(w, '#slow-start-badge').textContent || '', /正在开启/);
  assert.doesNotMatch($(w, '#slow-start-badge').textContent || '', /第 1\/7 天/, 'pending 不得本地冒充 D1');
  assert.match($(w, '#slow-start-reason').textContent || '', /等待云端确认/);

  pushStatus?.(initial); // PUT 仍在途时到达写前旧快照
  await tick();
  assert.equal(toggle.checked, true, '旧快照不得把目标开关拨回 off');
  assert.ok(row.classList.contains('is-pending'), '旧快照不得清掉等待态');

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
  await tick();
  assert.equal(row.hasAttribute('aria-busy'), false);
  assert.equal(row.classList.contains('is-pending'), false);
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  assert.match($(w, '#slow-start-badge').textContent || '', /慢启动 · 第 1\/7 天/);
  assert.equal($(w, '#views-cap').textContent, '/20', '成功回执的 dayQuotas 应当场更新，不等下一次快照');
});

test('慢启动行：关闭失败后回到权威开启态，并保留云端失败原因', async () => {
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
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  toggle.checked = false;
  toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.match($(w, '#slow-start-badge').textContent || '', /正在关闭/);

  await tick();
  assert.equal(toggle.checked, true, '失败后必须回到未被篡改的权威 active 状态');
  assert.equal(toggle.disabled, false);
  assert.equal($(w, '#slow-start-row').classList.contains('is-pending'), false);
  assert.match($(w, '#slow-start-badge').textContent || '', /第 3\/7 天/);
  assert.match($(w, '#slow-start-reason').textContent || '', /当前未连接/);
  assert.ok($(w, '#slow-start-reason').classList.contains('is-error'));
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
  const toggle = $(w, '#slow-start-toggle') as unknown as HTMLInputElement;
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.match($(w, '#slow-start-badge').textContent || '', /正在开启/);

  pushStatus?.(statusFor('B', 'off'));
  await tick();
  const rowB = w.document.querySelector('.rail-row[data-env-id="B"]') as unknown as HTMLElement;
  assert.ok(rowB, 'B 环境应进入左栏');
  rowB.dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.equal($(w, '#slow-start-row').classList.contains('is-pending'), false);
  assert.equal(toggle.checked, false);
  assert.doesNotMatch($(w, '#slow-start-reason').textContent || '', /等待云端确认/);

  writeA.resolve({
    ok: true,
    data: { data: { envKey: 'A', slowStart: { state: 'active', day: 1, totalDays: 7, binding: true, eligible: true }, dayQuotas: { view: 20 } } },
  });
  await tick();
  assert.equal(toggle.checked, false, 'A 回执到达时当前 B 仍应保持 off');

  const rowA = w.document.querySelector('.rail-row[data-env-id="A"]') as unknown as HTMLElement;
  rowA.dispatchEvent(new w.Event('click', { bubbles: true }));
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
