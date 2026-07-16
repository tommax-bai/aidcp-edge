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
