import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, type DOMWindow } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const workspaceSrc = readFileSync(join(electronDir, 'renderer/content-workspace.js'), 'utf8');
const openWindows: DOMWindow[] = [];
after(() => openWindows.forEach((window) => window.close()));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush(times = 5) { for (let i = 0; i < times; i += 1) await tick(); }
const $ = (window: DOMWindow, selector: string) => window.document.querySelector(selector) as unknown as HTMLElement;
const hidden = (element: HTMLElement) => element.classList.contains('hidden');

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    contentType: 'image_text',
    title: '城市散步的灵感',
    bodyPreview: '从下班后的二十分钟开始，重新认识熟悉的街区。',
    author: '作者甲',
    topics: ['生活方式'],
    likeCount: null,
    collectCount: 0,
    commentCount: 8,
    botLiked: false,
    botCollected: true,
    referenceImages: [{ index: 0, sourceUrl: 'https://img.test/a.jpg', captureStatus: 'url_only', capturedAt: 1 }],
    creatable: true,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return { ...listItem(), body: '第一段正文\n第二段正文', firstSeenAt: 1, countsCapturedAt: null, ...overrides };
}

function boot(api: Record<string, unknown>) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  openWindows.push(window);
  window.eval(workspaceSrc);
  const factory = (window as unknown as { ContentWorkspace: { create(options: unknown): any } }).ContentWorkspace;
  const controller = factory.create({
    root: $(window, '#content-workspace'),
    legacyRoot: $(window, '#legacy-workspace'),
    interactionRoot: $(window, '#interaction-workspace'),
    shell: $(window, '.shell'),
    api,
  });
  return { window, controller };
}

test('标题栏灵感入口显示权威汇总，储备条只按精选总数并丢弃旧账号迟到回包', async () => {
  let resolveA: ((value: unknown) => void) | undefined;
  const pendingA = new Promise((resolve) => { resolveA = resolve; });
  const summaryCalls: string[] = [];
  const { window, controller } = boot({
    curatedSummary: async (envId: string) => {
      summaryCalls.push(envId);
      if (envId === 'env-a') return pendingA;
      return { ok: true, data: { total: 36, referenceDraftCount: 7 } };
    },
  });

  controller.setEnvironment({ envId: 'env-a', label: '账号 A' });
  assert.equal($(window, '#content-library-entry-count').textContent, '—');
  assert.equal($(window, '#content-library-entry-draft-count').textContent, '—');
  controller.setEnvironment({ envId: 'env-b', label: '账号 B' });
  await flush();
  assert.deepEqual(summaryCalls, ['env-a', 'env-b']);
  assert.equal($(window, '#content-library-entry-count').textContent, '36');
  assert.equal($(window, '#content-library-entry-draft-count').textContent, '7');
  assert.equal($(window, '#content-library-entry').style.getPropertyValue('--inspiration-fill'), '100%');
  assert.ok($(window, '#content-library-entry').classList.contains('is-rich'));
  assert.match($(window, '#content-library-entry').getAttribute('aria-label') ?? '', /灵感 36.*已成稿 7/);

  resolveA?.({ ok: true, data: { total: 24, referenceDraftCount: 99 } });
  await flush();
  assert.equal($(window, '#content-library-entry-count').textContent, '36');
  assert.equal($(window, '#content-library-entry-draft-count').textContent, '7');
  assert.equal($(window, '#content-library-entry').parentElement?.id, 'titlebar');
});

test('标题栏普通储备为蓝色区间，成稿数不驱动条宽', async () => {
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: true, data: { total: 24, referenceDraftCount: 700 } }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作' });
  await flush();
  assert.equal($(window, '#content-library-entry').style.getPropertyValue('--inspiration-fill'), '80%');
  assert.equal($(window, '#content-library-entry').classList.contains('is-rich'), false);
  assert.equal($(window, '#content-library-entry-draft-count').textContent, '700');
});

test('同窗口灵感库分页、筛选与详情返回恢复列表状态', async () => {
  const listCalls: Array<{ envId: string; options: { mode: string; limit: number; offset: number } }> = [];
  const { window, controller } = boot({
    curatedList: async (envId: string, options: { mode: string; limit: number; offset: number }) => {
      listCalls.push({ envId, options: JSON.parse(JSON.stringify(options)) });
      return { ok: true, data: { items: [listItem({ id: options.offset + 7, title: `第 ${options.offset / 12 + 1} 页灵感` })], total: 25 } };
    },
    curatedGet: async (_envId: string, id: number) => ({ ok: true, data: { item: detail({ id, title: `详情 ${id}` }) } }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', inspirationCount: 25 });
  $(window, '#content-library-entry').dispatchEvent(new window.Event('click'));
  await flush();

  assert.equal(hidden($(window, '#content-workspace')), false);
  assert.equal(hidden($(window, '#legacy-workspace')), true);
  assert.match($(window, '#content-workspace-meta').textContent ?? '', /晚风手作/);
  assert.match($(window, '#curated-list').textContent ?? '', /第 1 页灵感/);
  assert.deepEqual(listCalls[0], { envId: 'env-a', options: { mode: 'creatable', limit: 12, offset: 0 } });

  $(window, '#curated-next').dispatchEvent(new window.Event('click'));
  await flush();
  assert.match($(window, '#curated-page').textContent ?? '', /第 2 \/ 3 页/);
  assert.equal(listCalls[1].options.offset, 12);
  const list = $(window, '#curated-list');
  list.scrollTop = 73;
  (list.querySelector('.curated-card') as HTMLElement).dispatchEvent(new window.Event('click'));
  await flush();
  assert.equal(controller.currentPage(), 'detail');
  assert.match($(window, '#curated-detail').textContent ?? '', /详情 19/);

  $(window, '#content-workspace-back').dispatchEvent(new window.Event('click'));
  assert.equal(controller.currentPage(), 'library');
  assert.match($(window, '#curated-page').textContent ?? '', /第 2 \/ 3 页/);
  assert.equal($(window, '#curated-list').scrollTop, 73);

  ($(window, '[data-curated-mode="all"]')).dispatchEvent(new window.Event('click'));
  await flush();
  assert.deepEqual(listCalls.at(-1)?.options, { mode: 'all', limit: 12, offset: 0 });
});

test('无参考图时禁用图文模式，文字参照只呈现诚实排队回执', async () => {
  const createCalls: unknown[][] = [];
  const item = listItem({ referenceImages: [] });
  const { window, controller } = boot({
    curatedList: async () => ({ ok: true, data: { items: [item], total: 1 } }),
    curatedGet: async () => ({ ok: true, data: { item: detail({ referenceImages: [] }) } }),
    curatedCreatePost: async (...args: unknown[]) => {
      createCalls.push(args);
      return { ok: true, data: { task: { id: '12345678-1234-4234-8234-123456789012', status: 'queued' } } };
    },
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', inspirationCount: 1 });
  controller.openLibrary();
  await flush();
  ($(window, '.curated-card')).dispatchEvent(new window.Event('click'));
  await flush();
  ($(window, '.curated-detail-actions .cw-button')).dispatchEvent(new window.Event('click'));

  const modes = Array.from(window.document.querySelectorAll('.curated-mode-card')) as HTMLButtonElement[];
  assert.equal(modes[0].disabled, true, '没有参考图时图文模式不可选');
  assert.equal(modes[1].getAttribute('aria-pressed'), 'true', '自动回落为文字参照');
  ($(window, '#curated-create .cw-button.primary')).dispatchEvent(new window.Event('click'));
  await flush(8);
  assert.deepEqual(createCalls, [['env-a', 7, false]]);
  const receipt = $(window, '.curated-create-message').textContent ?? '';
  assert.match(receipt, /已排队创作/);
  assert.match(receipt, /不代表已经生成或发布/);
  assert.doesNotMatch(receipt, /发布成功|稿件已生成/);
});

test('切账号丢弃旧请求，稿件审核在账号切换时关闭且不残留', async () => {
  let resolveA: ((value: unknown) => void) | undefined;
  const pendingA = new Promise((resolve) => { resolveA = resolve; });
  const { window, controller } = boot({
    curatedList: async (envId: string) => envId === 'env-a'
      ? pendingA
      : { ok: true, data: { items: [listItem({ title: 'B 的灵感' })], total: 1 } },
  });
  controller.setEnvironment({ envId: 'env-a', label: '账号 A', inspirationCount: 1 });
  controller.openLibrary();
  await flush(2);
  controller.setEnvironment({ envId: 'env-b', label: '账号 B', inspirationCount: 1 });
  await flush(4);
  resolveA?.({ ok: true, data: { items: [listItem({ title: 'A 的迟到灵感' })], total: 1 } });
  await flush(4);
  const text = $(window, '#curated-list').textContent ?? '';
  assert.match(text, /B 的灵感/);
  assert.doesNotMatch(text, /A 的迟到灵感/);

  controller.openDraft();
  assert.equal(controller.isDraftOpen(), true);
  assert.ok($(window, '#publish-preview-panel').classList.contains('open'));
  controller.setEnvironment({ envId: 'env-c', label: '账号 C', inspirationCount: 0 });
  assert.equal(controller.isDraftOpen(), false);
  assert.equal(hidden($(window, '#content-workspace')), true);
  assert.equal(hidden($(window, '#legacy-workspace')), false);
});

test('稿件审核占满主内容区，返回/关闭不影响主窗口壳', () => {
  const { window, controller } = boot({});
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', inspirationCount: 2 });
  controller.openDraft();
  assert.equal(hidden($(window, '#content-workspace')), false);
  assert.equal(hidden($(window, '#legacy-workspace')), true);
  assert.ok($(window, '.shell').classList.contains('content-mode'));
  assert.match($(window, '#content-workspace-title').textContent ?? '', /稿件审核/);
  assert.equal($(window, '#publish-preview-panel').getAttribute('aria-hidden'), 'false');
  $(window, '#content-workspace-close').dispatchEvent(new window.Event('click'));
  assert.equal(hidden($(window, '#content-workspace')), true);
  assert.equal(hidden($(window, '#legacy-workspace')), false);
});

// ── review 修复回归（每条都先在未修版本上验证过会红）──

test('排队请求在途时离开创作页，不把忙碌锁留死（回来仍可再次提交）', async () => {
  const deferred: { resolve?: (value: unknown) => void } = {};
  let calls = 0;
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: true, data: { total: 1, referenceDraftCount: 0 } }),
    curatedList: async () => ({ ok: true, data: { items: [listItem()], total: 1, limit: 12, offset: 0 } }),
    curatedGet: async () => ({ ok: true, data: { item: detail() } }),
    curatedCreatePost: async () => {
      calls += 1;
      return new Promise((resolve) => { deferred.resolve = resolve; });
    },
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作' });
  controller.openLibrary();
  await flush();
  $(window, '.curated-card').dispatchEvent(new window.Event('click'));
  await flush();
  $(window, '.curated-detail-actions .cw-button.primary').dispatchEvent(new window.Event('click'));
  await flush();

  $(window, '.curated-create .cw-button.primary').dispatchEvent(new window.Event('click'));
  await flush();
  assert.equal(calls, 1, '第一次提交应已发出');

  // 请求还在途中就返回详情页——旧实现在此把 createBusy 永久留成 true。
  $(window, '#content-workspace-back').dispatchEvent(new window.Event('click'));
  await flush();
  deferred.resolve?.({ ok: true, data: { triggered: true, created: true, task: { id: 'task-abcdefgh', status: 'queued', version: 1 } } });
  await flush();

  // 再次进入创作页：按钮必须可用，而不是卡在禁用的「正在排队…」。
  $(window, '.curated-detail-actions .cw-button.primary').dispatchEvent(new window.Event('click'));
  await flush();
  const submit = $(window, '.curated-create .cw-button.primary') as HTMLButtonElement;
  assert.equal(submit.disabled, false, '离开创作页后忙碌锁必须已解除');
  assert.doesNotMatch(submit.textContent ?? '', /正在排队/);
  submit.dispatchEvent(new window.Event('click'));
  await flush();
  assert.equal(calls, 2, '解锁后必须能真的再次提交');
});

test('已受理但已越过 queued 的任务如实报「已受理」，绝不谎报失败把人推去重复提交', async () => {
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: true, data: { total: 1, referenceDraftCount: 0 } }),
    curatedList: async () => ({ ok: true, data: { items: [listItem()], total: 1, limit: 12, offset: 0 } }),
    curatedGet: async () => ({ ok: true, data: { item: detail() } }),
    // 同一分钟内重复提交 → 服务端按去重键收敛到上一条、此刻已在执行的任务。
    curatedCreatePost: async () => ({
      ok: true,
      data: { triggered: true, created: false, task: { id: 'task-abcdefgh', status: 'executing', version: 3 } },
    }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作' });
  controller.openLibrary();
  await flush();
  $(window, '.curated-card').dispatchEvent(new window.Event('click'));
  await flush();
  $(window, '.curated-detail-actions .cw-button.primary').dispatchEvent(new window.Event('click'));
  await flush();
  $(window, '.curated-create .cw-button.primary').dispatchEvent(new window.Event('click'));
  await flush();

  const message = $(window, '.curated-create-message');
  assert.doesNotMatch(message.textContent ?? '', /没有返回已排队任务|未按成功处理/, '已受理的任务绝不能报成失败');
  assert.equal(message.classList.contains('error'), false);
  assert.match(message.textContent ?? '', /已在执行/);
});

test('切账号时详情页与创作页的迟到回包一律丢弃（不只列表页）', async () => {
  const detailDeferred: { resolve?: (value: unknown) => void } = {};
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: true, data: { total: 1, referenceDraftCount: 0 } }),
    curatedList: async () => ({ ok: true, data: { items: [listItem()], total: 1, limit: 12, offset: 0 } }),
    curatedGet: async () => new Promise((resolve) => { detailDeferred.resolve = resolve; }),
    curatedCreatePost: async () => ({ ok: true, data: { triggered: true, created: true, task: { id: 'task-x', status: 'queued', version: 1 } } }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '账号 A' });
  controller.openLibrary();
  await flush();
  $(window, '.curated-card').dispatchEvent(new window.Event('click'));
  await flush();

  // 详情还在途 → 切到账号 B → A 的详情回包必须不得渲染到 B 名下。
  controller.setEnvironment({ envId: 'env-b', label: '账号 B' });
  await flush();
  detailDeferred.resolve?.({ ok: true, data: { item: detail({ title: 'A 账号的私有灵感' }) } });
  await flush();
  assert.doesNotMatch(window.document.body.textContent ?? '', /A 账号的私有灵感/, '旧账号详情绝不能渲染到新账号下');
  assert.match($(window, '#content-workspace-meta').textContent ?? '', /账号 B/);
});

test('汇总读失败时标题栏说失败而不是永远「加载中」，储备条与真实 0 条可区分', async () => {
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: false, status: 503, error: 'curated_content_unavailable', reason: 'curated_content_unavailable' }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作' });
  await flush();
  const entry = $(window, '#content-library-entry');
  const label = entry.getAttribute('aria-label') ?? '';
  assert.doesNotMatch(label, /加载中/, '读失败后不得永远宣称加载中');
  assert.match(label, /读取失败/);
  assert.equal(entry.getAttribute('aria-busy'), 'false');
  assert.equal(entry.classList.contains('is-unknown'), true, '未知必须与真实 0 条可区分');
  assert.equal($(window, '#content-library-entry-count').textContent, '—');
});

test('真实 0 条精选不得被画成「未知」', async () => {
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: true, data: { total: 0, referenceDraftCount: 0 } }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作' });
  await flush();
  const entry = $(window, '#content-library-entry');
  assert.equal(entry.classList.contains('is-unknown'), false, '真实 0 是已知值，不是未知');
  assert.match(entry.getAttribute('aria-label') ?? '', /灵感 0/);
  assert.equal($(window, '#content-library-entry-count').textContent, '0');
});

test('状态心跳不得把首页从开着的灵感库底下掀出来（两个工作区共享首页显隐）', async () => {
  // 真机复现：非视频号账号每次心跳都会让互动工作区走 setVisible(false)，
  // 旧实现在那里无条件归还首页 → 灵感库开着时首页被一次次掀开。
  const interactionSrc = readFileSync(join(electronDir, 'renderer/interaction-workspace.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  openWindows.push(window);
  window.eval(interactionSrc);
  window.eval(workspaceSrc);

  const interaction = (window as unknown as { InteractionWorkspace: { create(o: unknown): any } }).InteractionWorkspace.create({
    root: $(window, '#interaction-workspace'),
    legacyRoot: $(window, '#legacy-workspace'),
    shell: $(window, '.shell'),
    api: {},
  });
  const content = (window as unknown as { ContentWorkspace: { create(o: unknown): any } }).ContentWorkspace.create({
    root: $(window, '#content-workspace'),
    legacyRoot: $(window, '#legacy-workspace'),
    interactionRoot: $(window, '#interaction-workspace'),
    shell: $(window, '.shell'),
    api: { curatedSummary: async () => ({ ok: true, data: { total: 3, referenceDraftCount: 1 } }) },
  });
  assert.ok(interaction && content);

  const env = { envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' };
  content.setEnvironment(env);
  content.openDraft();
  assert.equal(hidden($(window, '#legacy-workspace')), true, '前置条件：灵感库/稿件审核开着时首页应藏起');

  // 模拟一次状态心跳：render() 的真实顺序是先同步互动工作区、再同步内容工作区。
  for (let i = 0; i < 3; i += 1) {
    interaction.selectEnvironment({ envKey: 'env-a', platform: 'xiaohongshu', connectivity: 'connected' });
    content.setEnvironment(env);
    await flush(1);
    assert.equal(hidden($(window, '#legacy-workspace')), true, `第 ${i + 1} 次心跳后首页仍必须藏着`);
    assert.equal(hidden($(window, '#content-workspace')), false, '内容工作区必须仍开着');
  }
});
