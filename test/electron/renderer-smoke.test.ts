import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';

// 桌面外壳渲染层无头冒烟：用真实 index.html + renderer.js，在 jsdom 里注入 window.aidcpEdge 桩，
// 验证 AdsPower 探测 / 环境下拉 / 刷新降级 / 新建入口 / 按钮 in-flight 禁用 / 中文化等接线。
const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');

const tick = () => new Promise((r) => setTimeout(r, 0));

function defaultStatus() {
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
  };
}

interface Stub {
  onStatusUpdate: (cb: (s: unknown) => void) => void;
  getStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  pause: () => Promise<unknown>;
  resume: () => Promise<unknown>;
  relogin: () => Promise<unknown>;
  openAdsDownload: () => void;
  adsStatus: (opts?: unknown) => Promise<{ ok: boolean; error?: string }>;
  adsListProfiles: (opts?: unknown) => Promise<unknown>;
  adsOpenCreate: () => { launched: boolean } | Promise<{ launched: boolean }>;
}

function makeStub(overrides: Partial<Stub> = {}): Stub {
  const settings = { provider: 'adspower', adsProfileId: '', adsApiKey: '', adsApiBase: '', adsDownloadUrl: 'https://x' };
  return {
    onStatusUpdate: () => undefined,
    getStatus: async () => defaultStatus(),
    getSettings: async () => settings,
    saveSettings: async () => ({ ...settings, saveOk: true }),
    pause: async () => defaultStatus(),
    resume: async () => defaultStatus(),
    relogin: async () => defaultStatus(),
    openAdsDownload: () => undefined,
    adsStatus: async () => ({ ok: true }),
    adsListProfiles: async () => ({ ok: true, profiles: [] }),
    adsOpenCreate: () => ({ launched: true }),
    ...overrides,
  };
}

async function boot(stub: Stub): Promise<DOMWindow> {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  (window as unknown as { aidcpEdge: Stub }).aidcpEdge = stub;
  window.eval(rendererSrc);
  await tick();
  await tick(); // flush getSettings().then + on-load probe
  return window;
}

const $ = (w: DOMWindow, sel: string) => w.document.querySelector(sel) as unknown as HTMLElement;

test('中文化：新增控件文案齐全', () => {
  for (const s of ['浏览器环境', 'AdsPower 状态', '检测', '刷新', '打开 AdsPower 新建环境', '下载 AdsPower']) {
    assert.ok(html.includes(s), `index.html 应含「${s}」`);
  }
});

test('探测可达：徽标「已就绪」+ 英文码 connected 上色', async () => {
  const w = await boot(makeStub({ adsStatus: async () => ({ ok: true }) }));
  const badge = $(w, '#ads-probe-badge');
  assert.equal(badge.textContent, '已就绪');
  assert.match(badge.className, /\bconnected\b/); // className 保英文码供 CSS 上色
});

test('探测不可达：徽标「未就绪」+ 诚实提示未检测到，不禁死（手敲仍可用）', async () => {
  const w = await boot(makeStub({ adsStatus: async () => ({ ok: false, error: 'ECONNREFUSED' }) }));
  const badge = $(w, '#ads-probe-badge');
  assert.equal(badge.textContent, '未就绪');
  assert.match(badge.className, /\bwarning\b/);
  assert.match($(w, '#ads-env-msg').textContent ?? '', /未检测到 AdsPower 本地 API/);
  assert.equal(($(w, '#ads-profile') as HTMLInputElement).disabled, false); // 手敲兜底仍可用
});

test('刷新成功：下拉列出环境，选中写入 user_id（非 serial_number）', async () => {
  const w = await boot(makeStub({
    adsListProfiles: async () => ({
      ok: true,
      profiles: [{ userId: 'u_long_1', serialNumber: '7', name: '账号甲', groupName: '组1', proxy: 'socks5 · ip=1.2.3.4' }],
    }),
  }));
  ($(w, '#ads-refresh') as HTMLButtonElement).dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  const sel = $(w, '#ads-env-select') as HTMLSelectElement;
  const opt = Array.from(sel.options).find((o) => o.value === 'u_long_1');
  assert.ok(opt, '下拉应含 user_id 选项');
  assert.match(opt!.textContent ?? '', /账号甲/);
  assert.match(opt!.textContent ?? '', /#7/); // serial_number 仅展示
  // 选中即写入分身 ID = user_id
  sel.value = 'u_long_1';
  sel.dispatchEvent(new w.Event('change'));
  assert.equal(($(w, '#ads-profile') as HTMLInputElement).value, 'u_long_1');
});

test('刷新失败(401)：诚实降级为手敲 + 提示已用当前填写值、不叫重填', async () => {
  const w = await boot(makeStub({
    adsListProfiles: async () => ({ ok: false, authLikely: true, error: '拉取环境失败（HTTP 401）：疑似开启了 API 校验' }),
  }));
  ($(w, '#ads-refresh') as HTMLButtonElement).dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  const msg = $(w, '#ads-env-msg').textContent ?? '';
  assert.match(msg, /本次刷新已用当前填写值/);
  assert.match(msg, /手动填写分身 ID/);
  assert.equal(($(w, '#ads-profile') as HTMLInputElement).disabled, false);
});

test('打开新建环境：拉起客户端成功 → 文案「已打开 AdsPower 客户端」', async () => {
  let called = 0;
  const w = await boot(makeStub({ adsOpenCreate: () => { called += 1; return { launched: true }; } }));
  ($(w, '#ads-create') as HTMLAnchorElement).dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.equal(called, 1);
  assert.match($(w, '#ads-env-msg').textContent ?? '', /已打开 AdsPower 客户端/);
  assert.match($(w, '#ads-env-msg').textContent ?? '', /新建浏览器/);
});

test('打开新建环境：拉不起客户端 → 诚实文案「已打开 AdsPower 官网」', async () => {
  const w = await boot(makeStub({ adsOpenCreate: () => ({ launched: false }) }));
  ($(w, '#ads-create') as HTMLAnchorElement).dispatchEvent(new w.Event('click'));
  await tick();
  await tick();
  assert.match($(w, '#ads-env-msg').textContent ?? '', /已打开 AdsPower 官网/);
});

test('防限速：刷新在途禁用按钮，完成后恢复', async () => {
  let resolveList: (v: unknown) => void = () => undefined;
  const pending = new Promise((res) => { resolveList = res; });
  const w = await boot(makeStub({ adsListProfiles: () => pending as Promise<unknown> }));
  const btn = $(w, '#ads-refresh') as HTMLButtonElement;
  btn.dispatchEvent(new w.Event('click'));
  assert.equal(btn.disabled, true); // 同步：await 前已禁用
  resolveList({ ok: true, profiles: [] });
  await tick();
  await tick();
  assert.equal(btn.disabled, false);
});
