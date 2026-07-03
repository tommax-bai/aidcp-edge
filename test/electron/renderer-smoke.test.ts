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
const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');

// renderer 装了 1s 走字 interval：测试结束统一 close 掉所有 jsdom window，防止句柄挂住测试进程。
const openWindows: DOMWindow[] = [];
after(() => {
  for (const w of openWindows) w.close();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

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
  start: () => Promise<unknown>;
  restart: () => Promise<unknown>;
  relogin: () => Promise<unknown>;
  openAdsDownload: () => void;
  adsStatus: (opts?: unknown) => Promise<{ ok: boolean; error?: string }>;
  adsListProfiles: (opts?: unknown) => Promise<unknown>;
  adsOpenCreate: () => { launched: boolean } | Promise<{ launched: boolean }>;
  adsTemplates: () => Promise<Array<{ key: string; label: string }>>;
  adsCreateEnv: (opts?: unknown) => Promise<{ ok: boolean; template?: string; error?: string }>;
  adsDeleteEnv: (opts?: unknown) => Promise<{ ok: boolean; error?: string }>;
}

function makeStub(overrides: Partial<Stub> = {}): Stub {
  const settings = { provider: 'adspower', adsProfileId: '', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'https://x' };
  return {
    onStatusUpdate: () => undefined,
    getStatus: async () => makeStatus(),
    getSettings: async () => settings,
    saveSettings: async () => ({ ...settings, saveOk: true }),
    pause: async () => makeStatus({ session: 'paused' }),
    resume: async () => makeStatus({ session: 'running', edge: 'running' }),
    start: async () => makeStatus({ edge: 'starting', session: 'running' }),
    restart: async () => makeStatus({ edge: 'starting', session: 'running' }),
    relogin: async () => makeStatus(),
    openAdsDownload: () => undefined,
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    adsOpenCreate: () => ({ launched: true }),
    adsTemplates: async () => [{ key: 'win11-intel', label: 'Windows · 8核 8G' }],
    adsCreateEnv: async () => ({ ok: true, template: 'win11-intel' }),
    adsDeleteEnv: async () => ({ ok: true }),
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
  for (const s of ['浏览器环境', 'AdsPower 状态', '检测', '刷新', '手动填写', '高级设置', '创建环境', '下载 AdsPower']) {
    assert.ok(html.includes(s), `index.html 应含「${s}」`);
  }
});

test('探测就绪 → 徽标已就绪 + 自动列出环境（无需先点刷新）', async () => {
  const w = await boot(makeStub({
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: '无代理配置' }] }),
  }));
  assert.equal($(w, '#ads-probe-badge').textContent, '已就绪');
  const items = $$(w, '.ads-env-item');
  assert.equal(items.length, 1, '就绪后应自动列出环境行');
  assert.match(items[0].textContent ?? '', /甲/);
});

test('探测不可达 → 未就绪 + 诚实提示，不禁死', async () => {
  const w = await boot(makeStub({ adsStatus: async () => ({ ok: false, error: 'ECONNREFUSED' }) }));
  assert.equal($(w, '#ads-probe-badge').textContent, '未就绪');
  assert.match($(w, '#ads-env-msg').textContent ?? '', /未检测到 AdsPower 本地 API/);
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
  $$(w, '.ads-env-item')[0].dispatchEvent(new w.Event('click')); // 选环境带出分身 ID
  $(w, '#session-fab').dispatchEvent(new w.Event('click')); // 悬浮「启动」
  await tick();
  await tick();
  assert.deepEqual(calls, ['save', 'start'], '启动应先 save 再 start');
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
  assert.match($(w, '#settings-msg').textContent ?? '', /请先选择一个环境/);
});

test('运行中改设置 → 出现「按新设置重启」，点击先存再重启', async () => {
  const calls: string[] = [];
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'running', session: 'running' }),
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' }] }),
    saveSettings: async () => { calls.push('save'); return { provider: 'adspower', adsProfileId: 'u1', saveOk: true }; },
    restart: async () => { calls.push('restart'); return makeStatus({ edge: 'starting' }); },
  }));
  assert.equal(hidden($(w, '#apply-restart')), true, '未改动时不显示「按新设置重启」');
  $$(w, '.ads-env-item')[0].dispatchEvent(new w.Event('click')); // 改选环境 → dirty
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

test('悬浮 fab 三态：停止→启动 / 运行→暂停 / 暂停→恢复', async () => {
  const stopped = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'stopped' }) }));
  assert.equal($(stopped, '#session-fab').textContent, '启动');
  const running = await boot(makeStub({ getStatus: async () => makeStatus({ edge: 'running', session: 'running' }) }));
  assert.equal($(running, '#session-fab').textContent, '暂停');
  const paused = await boot(makeStub({ getStatus: async () => makeStatus({ session: 'paused' }) }));
  assert.equal($(paused, '#session-fab').textContent, '恢复');
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

test('重新登录：有未保存改动时先存再重新登录（与恢复同类修复）', async () => {
  const calls: string[] = [];
  const w = await boot(makeStub({
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u_new', serialNumber: '2', name: '乙', groupName: 'g', proxy: 'p' }] }),
    saveSettings: async () => { calls.push('save'); return { provider: 'adspower', adsProfileId: 'u_new', saveOk: true }; },
    relogin: async () => { calls.push('relogin'); return makeStatus(); },
  }));
  $$(w, '.ads-env-item')[0].dispatchEvent(new w.Event('click')); // 改选环境 → dirty
  $(w, '#relogin').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.deepEqual(calls, ['save', 'relogin'], '重新登录前应先落盘改动');
});

test('保存后解除 provider 编辑闩锁：状态推送可再跟随实际 provider（回归）', async () => {
  let pushCb: (s: unknown) => void = () => undefined;
  const w = await boot(makeStub({
    getStatus: async () => makeStatus({ edge: 'stopped', provider: 'adspower' }),
    onStatusUpdate: (cb) => { pushCb = cb; },
    adsListProfiles: async () => ({ ok: true, profiles: [{ userId: 'u1', serialNumber: '1', name: '甲', groupName: 'g', proxy: 'p' }] }),
    start: async () => makeStatus({ edge: 'starting', session: 'running', provider: 'adspower' }),
  }));
  // 点一次 provider 分段 → editingProvider 上闩
  $(w, '#prov-adspower').dispatchEvent(new w.Event('click'));
  await tick();
  // 选环境 + 启动（= 先 save 再 start）：save 里解闩
  $$(w, '.ads-env-item')[0].dispatchEvent(new w.Event('click'));
  $(w, '#session-fab').dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  // 之后一条状态推送报 provider=self → 段选应跟随（若闩未解，段会卡在 adspower）
  pushCb(makeStatus({ provider: 'self', edge: 'running', session: 'running' }));
  assert.ok($(w, '#prov-self').classList.contains('active'), '保存后应解闩，段选跟随实际 provider=self');
  assert.equal(hidden($(w, '#ads-config')), true, 'self 下应隐藏 AdsPower 配置块');
});
