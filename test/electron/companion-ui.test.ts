import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';

// 陪伴式主界面冒烟（edge-companion-ui）：标题带健康合成 / 设置抽屉 / 在场感诚实态 /
// 活动流 / 发布卡纯展示零按钮 —— 用真实 index.html + ui-logic.js + renderer.js 在 jsdom 里驱动。
const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const uiLogicSrc = readFileSync(join(electronDir, 'renderer/ui-logic.js'), 'utf8');
const rendererSrc = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');

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
    stats: { views: 3, likes: 1, collects: 0, comments: 0 },
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
    start: async () => makeStatus(),
    restart: async () => makeStatus(),
    relogin: async () => makeStatus(),
    openAdsDownload: () => undefined,
    openFeishu: async () => ({ ok: true }),
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

// ── 标题带：身份 + 健康合成 + 风控染色 ──
test('标题带展示账号身份与健康结论', async () => {
  const { w } = await boot();
  assert.equal($(w, '#acct-name').textContent, '@晚风手作');
  assert.equal($(w, '#acct-ava').textContent, '晚');
  assert.match($(w, '#health-label').textContent ?? '', /运行中/);
  assert.ok($(w, '#titlebar').classList.contains('tone-normal'));
});

test('风控警戒 → 标题带染琥珀；异常 → 健康药丸「需要注意」', async () => {
  const { w, pushStatus } = await boot();
  pushStatus(makeStatus({ risk: 'warned' }));
  assert.ok($(w, '#titlebar').classList.contains('tone-warned'));
  pushStatus(makeStatus({ edge: 'warning' }));
  assert.equal($(w, '#health-label').textContent, '需要注意');
  assert.ok($(w, '#health-pill').classList.contains('attention'));
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

test('待配置 → 首屏主动步骤，点「去设置」直达抽屉', async () => {
  const { w } = await boot({ auth: 'config required', edge: 'stopped', session: 'idle' });
  assert.equal(hidden($(w, '#login-guide')), false, '待配置应出主动步骤');
  assert.equal(hidden($(w, '#notice-action')), false);
  $(w, '#notice-action').dispatchEvent(new w.Event('click'));
  assert.equal($(w, '#drawer').classList.contains('open'), true);
});

// ── 在场感：动效只由真实事件驱动 ──
test('运行中 + 新鲜事件 → 在场感动效开、新鲜度走字', async () => {
  const { w } = await boot();
  assert.ok($(w, '#presence-text').classList.contains('shimmer'));
  assert.match($(w, '#presence-text').textContent ?? '', /正在认真读/);
  assert.match($(w, '#presence-fresh').textContent ?? '', /刚刚更新/);
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
});

// ── 发布卡：纯展示零按钮 ──
test('发布卡候审：可见、第三节点琥珀、卡内零按钮（审批只在飞书）', async () => {
  const at = new Date(Date.now() - 3 * 60_000).toISOString();
  const { w } = await boot({ publish: { state: 'pending', title: '秋日城市漫步', at } });
  const card = $(w, '#pub-card');
  assert.equal(hidden(card), false);
  assert.equal(card.querySelectorAll('button').length, 0, '发布卡 MUST 零按钮');
  assert.match($(w, '#pub-title').textContent ?? '', /秋日城市漫步/);
  assert.match($(w, '#pub-corner').textContent ?? '', /已等 3 分钟/);
  const steps = Array.from(card.querySelectorAll('.j-step'));
  assert.ok((steps[2] as HTMLElement).classList.contains('cur'));
  assert.match($(w, '#pub-foot').textContent ?? '', /飞书/);
  assert.ok(!($(w, '#pub-foot').textContent ?? '').includes('再次提醒'), '未收到再提醒事件绝不谎称');
});

test('发布卡已通过 → 第四节点平静色 + 无需操作', async () => {
  const { w } = await boot({ publish: { state: 'approved', title: 't', at: new Date().toISOString() } });
  const steps = Array.from($(w, '#pub-card').querySelectorAll('.j-step'));
  assert.ok((steps[3] as HTMLElement).classList.contains('cur'));
  assert.ok((steps[3] as HTMLElement).classList.contains('calm'));
  assert.match($(w, '#pub-foot').textContent ?? '', /无需操作/);
});

test('发布终态 → 卡片收起、折进活动流（拒绝不渲染成失败）', async () => {
  const { w, pushStatus } = await boot({ publish: { state: 'pending', title: '秋日漫步', at: new Date().toISOString() } });
  pushStatus(makeStatus({ publish: { state: 'published', title: '秋日漫步', at: new Date().toISOString() } }));
  assert.equal(hidden($(w, '#pub-card')), true, '发布后卡片收起');
  assert.match($(w, '#activity-stream').textContent ?? '', /已发布/);
  // 再推一次同状态：按签名去重，不重复记
  pushStatus(makeStatus({ publish: { state: 'published', title: '秋日漫步', at: new Date().toISOString() } }));
  const doneRows = Array.from(w.document.querySelectorAll('#activity-stream .ev.pub-done'));
  assert.equal(doneRows.length, 1);
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

// ── 循环 chip ──
test('循环 chip 随阶段点亮，停止时全灭', async () => {
  const { w, pushStatus } = await boot({ loopStage: 'read' });
  const on = () => Array.from(w.document.querySelectorAll('.loop-step.on')).map((el) => (el as HTMLElement).dataset.stage);
  assert.deepEqual(on(), ['read']);
  pushStatus(makeStatus({ loopStage: 'interact' }));
  assert.deepEqual(on(), ['interact']);
  pushStatus(makeStatus({ edge: 'stopped', session: 'idle' }));
  assert.deepEqual(on(), [], '停止时不点亮任何阶段');
});
