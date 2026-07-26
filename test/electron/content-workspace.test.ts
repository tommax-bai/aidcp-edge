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

function installClampedScroll(element: HTMLElement, max: number, initial = 0) {
  let scrollTop = Math.min(max, Math.max(0, initial));
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: max + 100 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.min(max, Math.max(0, Number(value))); },
    },
  });
  return () => scrollTop;
}

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

test('灵感列表与详情展示来源发布时间，未知或不可解析时绝不回落精选更新时间', async () => {
  const impossibleUpdatedAt = Date.parse('2099-12-31T23:59:00.000Z');
  const list = listItem({
    updatedAt: impossibleUpdatedAt,
    sourcePublishedAtText: '07-20',
    sourcePublishedAt: Date.parse('2026-07-19T16:00:00.000Z'),
    sourcePublishedAtPrecision: 'day',
    sourcePublishedAtStatus: 'parsed',
    sourcePublishedAtObservedAt: Date.parse('2026-07-21T07:30:00.000Z'),
  });
  const { window, controller } = boot({
    curatedList: async () => ({ ok: true, data: { items: [list], total: 1 } }),
    curatedGet: async () => ({
      ok: true,
      data: {
        item: detail({
          updatedAt: impossibleUpdatedAt,
          sourcePublishedAtText: '平台新格式',
          sourcePublishedAt: null,
          sourcePublishedAtPrecision: null,
          sourcePublishedAtStatus: 'unparseable',
          sourcePublishedAtObservedAt: Date.parse('2026-07-21T07:30:00.000Z'),
        }),
      },
    }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  controller.openLibrary();
  await flush();
  const listMeta = $(window, '.curated-card-meta').textContent ?? '';
  assert.match(listMeta, /作者甲 · 发布于 2026\/7\/20/);
  assert.doesNotMatch(listMeta, /2099/);

  $(window, '.curated-card').dispatchEvent(new window.Event('click'));
  await flush();
  const detailMeta = $(window, '.curated-detail-author').textContent ?? '';
  assert.match(detailMeta, /作者甲 · 发布于 平台新格式（未转换）/);
  assert.doesNotMatch(detailMeta, /2099/);
});

test('旧 Cloud 灵感响应缺少来源发布时间时明确显示未知', async () => {
  const { window, controller } = boot({
    curatedList: async () => ({ ok: true, data: { items: [listItem({ updatedAt: Date.parse('2099-12-31T23:59:00.000Z') })], total: 1 } }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  controller.openLibrary();
  await flush();
  const meta = $(window, '.curated-card-meta').textContent ?? '';
  assert.match(meta, /发布时间未知/);
  assert.doesNotMatch(meta, /2099/);
});

function queueStage(key: string, label: string, state: string, progress?: { current: number; total: number }) {
  const status = key === 'approval' && state === 'completed'
    ? '已确认'
    : key === 'approval' && state === 'waiting_human'
      ? '待你确认'
      : key === 'dispatch' && state === 'pending'
        ? '等待发布'
        : state === 'completed'
          ? '已完成'
          : '未开始';
  return { key, label, state, summary: `${label}：${status}`, ...(progress ? { progress } : {}) };
}

function queueJourney(overrides: Record<string, unknown> = {}) {
  return {
    id: 'publish:21', recordId: 21, title: '周末城市散步指南', sourceTitle: '下班后的二十分钟',
    kind: 'rewrite', startedAt: Date.now(), status: 'waiting_approval', statusLabel: '等待你确认',
    stages: [
      queueStage('source', '开始创作', 'completed'),
      queueStage('content', '正文与配图', 'completed', { current: 2, total: 4 }),
      queueStage('approval', '发布确认', 'waiting_human'),
      queueStage('dispatch', '发布结果', 'pending'),
    ],
    ...overrides,
  };
}

function queueTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-queue-1', title: '夏日通勤穿搭', action: '参考创作', status: 'queued', statusLabel: '排队中',
    cancelRequested: false, version: 3, createdAt: Date.now(), updatedAt: Date.now(), notBefore: Date.now(),
    ...overrides,
  };
}

function queueResponse(overrides: Record<string, unknown> = {}) {
  const data = {
    envKey: 'profile-a',
    summary: { inProgress: 2, waitingForYou: 1, cancellable: 1 },
    tasks: [queueTask()],
    active: [queueJourney()],
    recent: [queueJourney({
      id: 'publish:20', recordId: 20, title: '上一条平台已受理笔记', sourceTitle: null,
      status: 'submitted', statusLabel: '平台确认中，请勿重复操作',
      stages: [queueStage('source', '开始创作', 'completed'), queueStage('content', '正文与配图', 'completed'),
        queueStage('approval', '发布确认', 'completed'), queueStage('dispatch', '发布结果', 'completed')],
    })],
    ...overrides,
  };
  return { ok: true, data: { data, meta: { requestId: 'queue-request', asOf: Date.now() } } };
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

test('环境价值首页显示权威灵感汇总，并丢弃旧账号迟到回包', async () => {
  let resolveA: ((value: unknown) => void) | undefined;
  const pendingA = new Promise((resolve) => { resolveA = resolve; });
  const summaryCalls: string[] = [];
  const { window, controller } = boot({
    curatedSummary: async (envId: string) => {
      summaryCalls.push(envId);
      if (envId === 'env-a') return pendingA;
      return { ok: true, data: { total: 36, referenceDraftCount: 7 } };
    },
    curatedList: async () => ({ ok: true, data: { items: [], total: 0, referenceDraftCount: 0 } }),
    publishDraftList: async () => ({ ok: true, data: { items: [], total: 0 } }),
  });

  controller.setEnvironment({ envId: 'env-a', label: '账号 A', platform: 'xiaohongshu' });
  assert.equal($(window, '#content-home-inspiration-count').textContent, '—');
  controller.setEnvironment({ envId: 'env-b', label: '账号 B', platform: 'xiaohongshu' });
  await flush();
  assert.deepEqual(summaryCalls, ['env-a', 'env-b']);
  assert.equal($(window, '#content-home-inspiration-count').textContent, '36');
  assert.equal(window.document.querySelector('#content-library-entry'), null, '标题栏不再重复显示灵感池入口');

  resolveA?.({ ok: true, data: { total: 24, referenceDraftCount: 99 } });
  await flush();
  assert.equal($(window, '#content-home-inspiration-count').textContent, '36');
});

test('小红书环境直接展示价值首页，页内入口打开灵感二级页且其它平台恢复旧环境正文', async () => {
  const summaryCalls: string[] = [];
  const { window, controller } = boot({
    curatedSummary: async (envId: string) => {
      summaryCalls.push(envId);
      return { ok: true, data: { total: 8, referenceDraftCount: 2 } };
    },
    curatedList: async () => ({ ok: true, data: { items: [], total: 0, referenceDraftCount: 2 } }),
  });

  controller.setEnvironment({ envId: 'env-fb', label: 'Facebook 账号', platform: 'facebook' });
  await flush();
  assert.equal(window.document.querySelector('#content-library-entry'), null);
  assert.equal(hidden($(window, '#xhs-environment-dashboard')), true);
  assert.equal(hidden($(window, '#legacy-runtime-body')), false);
  assert.deepEqual(summaryCalls, []);
  controller.openLibrary();
  assert.equal(controller.currentPage(), 'home');

  controller.setEnvironment({ envId: 'env-wechat', label: '视频号账号', platform: 'wechat_channels' });
  await flush();
  assert.deepEqual(summaryCalls, []);

  controller.setEnvironment({ envId: 'env-xhs', label: '小红书账号', platform: 'xiaohongshu' });
  await flush();
  assert.equal(hidden($(window, '#xhs-environment-dashboard')), false);
  assert.equal(hidden($(window, '#legacy-runtime-body')), true);
  assert.equal(hidden($(window, '#content-workspace')), true);
  assert.equal($(window, '.shell').classList.contains('xhs-dashboard-mode'), true);
  assert.deepEqual(summaryCalls, ['env-xhs']);
  controller.openLibrary();
  await flush();
  assert.equal(controller.currentPage(), 'library');
  assert.equal(hidden($(window, '#content-workspace')), false);
  assert.equal($(window, '.shell').classList.contains('xhs-dashboard-mode'), false);
  assert.equal($(window, '.shell').classList.contains('content-mode'), true);
  assert.ok(summaryCalls.length >= 1);
  assert.equal(summaryCalls.every((envId) => envId === 'env-xhs'), true);
  const xhsSummaryCallCount = summaryCalls.length;

  controller.setEnvironment({ envId: 'env-fb', label: 'Facebook 账号', platform: 'facebook' });
  await flush();
  assert.equal(controller.currentPage(), 'home');
  assert.equal(hidden($(window, '#content-workspace')), true);
  assert.equal(hidden($(window, '#legacy-workspace')), false);
  assert.equal(hidden($(window, '#xhs-environment-dashboard')), true);
  assert.equal(hidden($(window, '#legacy-runtime-body')), false);
  assert.equal($(window, '.shell').classList.contains('xhs-dashboard-mode'), false);
  assert.equal(summaryCalls.length, xhsSummaryCallCount);
  assert.equal(summaryCalls.every((envId) => envId === 'env-xhs'), true);
});

test('环境价值首页把排期入口、真实灵感、来源成稿、工作过程和系统运行详情放在同一账号框架中', async () => {
  const source = listItem({ id: 7, title: '通勤显瘦穿搭公式', likeCount: 18_000, collectCount: 3_298 });
  const draft = {
    id: 42, platform: 'xiaohongshu', kind: 'rewrite', title: '梨形身材这样穿',
    contentPreview: '按当前人设重新表达的可编辑正文。', topics: ['通勤穿搭'], images: ['https://img.test/draft.jpg'],
    contentVersion: 3, updatedAt: Date.now(), publishMode: 'immediate', publishTime: null, sourceCuratedId: 7,
    refinement: { id: '00000000-0000-4000-8000-000000000057', scope: 'body', status: 'running', current: { stage: '判断', status: 'running', summary: '正在核对正文与当前人设的表达差异。' }, resultVersion: null, error: null },
  };
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: true, data: { total: 4, referenceDraftCount: 1 } }),
    curatedList: async () => ({ ok: true, data: { items: [source], total: 4 } }),
    publishDraftList: async () => ({ ok: true, data: { items: [draft], total: 1 } }),
    publishDraftRefinementGet: async () => ({
      ok: true,
      data: { data: { job: { id: draft.refinement.id, recordId: 42, expectedVersion: 3, scope: 'body', status: 'running', resultVersion: null, error: null,
        progress: [
          { seq: 1, stage: '计划', status: 'completed', summary: '已确认只调整正文。', at: 1 },
          { seq: 2, stage: '判断', status: 'waiting_human', summary: '正在核对正文与当前人设的表达差异。', at: 2 },
        ] } } },
    }),
    publishQueueGet: async () => queueResponse({ summary: { inProgress: 1, waitingForYou: 1, cancellable: 0 }, tasks: [], active: [], recent: [] }),
  });
  controller.setRuntime({
    automationState: 'running', browserState: 'ready', guideActive: false,
    dailyUsage: { totals: { view: 28, like: 4, collect: 2, comment: 1 } },
  });
  controller.setEnvironment({ envId: 'env-a', label: '小萝北', platform: 'xiaohongshu' });
  await flush(8);

  assert.equal(controller.currentPage(), 'home');
  assert.equal(hidden($(window, '#xhs-environment-dashboard')), false);
  assert.equal(hidden($(window, '#content-workspace')), true);
  assert.equal($(window, '#environment-schedule-entry').closest('#content-home-view') !== null, true);
  assert.equal($(window, '#content-home-inspiration-count').textContent, '4');
  assert.equal($(window, '#content-home-draft-count').textContent, '1');
  assert.match($(window, '#content-featured').textContent ?? '', /通勤显瘦穿搭公式.*AI 已基于它完成参考创作.*梨形身材这样穿/s);
  assert.match($(window, '#content-work-timeline').textContent ?? '', /计划完成.*已确认只调整正文.*判断中\.\.\./s);
  assert.doesNotMatch($(window, '#content-work-timeline').textContent ?? '', /生成中|确认中/);
  assert.match($(window, '#content-runtime-summary').textContent ?? '', /浏览 28 条.*点赞 4 条.*收藏 2 条/s);
  assert.equal(window.document.querySelectorAll('.content-runtime-stage').length, 4);
  assert.match($(window, '#content-runtime-metrics').textContent ?? '', /01.*发现内容.*28.*今日浏览.*—.*今日搜索/s);
  assert.match($(window, '#content-runtime-metrics').textContent ?? '', /02.*互动判断.*4.*今日点赞.*2.*今日收藏.*1.*今日评论/s);
  assert.match($(window, '#content-runtime-metrics').textContent ?? '', /03.*沉淀灵感.*4.*当前精选/s);
  assert.match($(window, '#content-runtime-metrics').textContent ?? '', /04.*内容创作.*1.*当前内容.*1.*进行中/s);
  assert.equal($(window, '#content-runtime-browser').textContent, '收起浏览器');
  assert.equal($(window, '#content-runtime-toggle').textContent, '关闭环境');
  assert.equal(window.document.querySelectorAll('.content-work-message').length, 2);
  assert.equal($(window, '#content-work-card').classList.contains('is-waiting'), true);
  assert.equal(window.document.querySelectorAll('.content-featured-metrics').length, 2);
  assert.equal($(window, '.content-reference-item .content-card-top em').textContent, '可创作');
  assert.match($(window, '.content-featured-card.source .content-featured-actions').textContent ?? '', /查看灵感.*开始创作/s);
  assert.match($(window, '.content-featured-card.output .content-featured-actions').textContent ?? '', /编辑成稿/);
});

test('价值首页保持视觉优先层级：无图用装饰封面，参考卡不退化成数据行，空闲过程仍有阶段预告', async () => {
  const source = listItem({
    id: 17,
    title: '无参考图但证据完整的灵感',
    bodyPreview: '标题、摘要和互动数字仍来自真实精选响应。',
    likeCount: 8932,
    collectCount: 2106,
    referenceImages: [],
  });
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: true, data: { total: 1, referenceDraftCount: 0 } }),
    curatedList: async () => ({ ok: true, data: { items: [source], total: 1 } }),
    curatedGet: async () => ({ ok: true, data: { item: detail({ ...source, body: '可用于参考创作的完整正文。' }) } }),
    publishDraftList: async () => ({ ok: true, data: { items: [], total: 0 } }),
    publishQueueGet: async () => queueResponse({ summary: { inProgress: 0, waitingForYou: 0, cancellable: 0 }, tasks: [], active: [], recent: [] }),
  });
  controller.setRuntime({ automationState: 'stopped', browserState: 'closed', guideActive: false });
  controller.setEnvironment({ envId: 'env-a', label: '小萝北', platform: 'xiaohongshu' });
  await flush(8);

  assert.match($(window, '#content-home-heading').textContent ?? '', /已收集 1 条精选灵感，等待发起创作/);
  assert.equal($(window, '#content-home-heading em').textContent, '1 条精选灵感');
  assert.equal($(window, '#content-work-status').textContent, '未启动');
  assert.equal(window.document.querySelectorAll('.content-featured-card .content-cover-fallback').length, 2);
  assert.match($(window, '.content-featured-card.source').textContent ?? '', /赞 8932.*藏 2106.*查看灵感.*开始创作/s);
  assert.match($(window, '.content-featured-card.output').textContent ?? '', /还没有关联草稿.*从它开始创作/s);
  assert.equal(window.document.querySelectorAll('.content-reference-item .content-reference-thumb.content-cover-fallback').length, 1);
  assert.match($(window, '.content-reference-item').textContent ?? '', /标题、摘要和互动数字仍来自真实精选响应。.*赞 8932.*藏 2106/s);
  assert.equal($(window, '.content-reference-item .content-card-top em').textContent, '可创作');
  const emptyDraftAction = $(window, '#content-mine-list .content-section-empty .cw-button');
  assert.equal(emptyDraftAction.textContent, '去看看灵感');
  assert.match($(window, '#content-mine-list .content-section-empty').textContent ?? '', /暂无正在进行的创作/);
  assert.ok($(window, '#content-mine-list .content-section-empty-live').classList.contains('is-idle'));
  emptyDraftAction.dispatchEvent(new window.Event('click'));
  await flush();
  assert.equal(controller.currentPage(), 'library');
  controller.openHome();
  await flush();
  assert.match($(window, '#content-work-empty').textContent ?? '', /计划与判断.*生成与调整.*检查与确认/s);
  assert.ok($(window, '#content-work-primary').classList.contains('primary'));
  ($(window, '.content-featured-card.source .content-featured-actions .cw-button:last-child')).dispatchEvent(new window.Event('click'));
  await flush();
  assert.equal(controller.currentPage(), 'create');
});

test('同窗口灵感库分页、筛选与详情返回恢复列表状态', async () => {
  const listCalls: Array<{ envId: string; options: { mode: string; sort: string; limit: number; offset: number } }> = [];
  const { window, controller } = boot({
    curatedList: async (envId: string, options: { mode: string; sort: string; limit: number; offset: number }) => {
      listCalls.push({ envId, options: JSON.parse(JSON.stringify(options)) });
      return { ok: true, data: { items: [listItem({ id: options.offset + 7, title: `第 ${options.offset / 12 + 1} 页灵感` })], total: 25 } };
    },
    curatedGet: async (_envId: string, id: number) => ({ ok: true, data: { item: detail({ id, title: `详情 ${id}` }) } }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu', inspirationCount: 25 });
  controller.openLibrary();
  await flush();

  assert.equal(hidden($(window, '#content-workspace')), false);
  assert.equal(hidden($(window, '#legacy-workspace')), true);
  assert.match($(window, '#content-workspace-meta').textContent ?? '', /晚风手作/);
  assert.match($(window, '#curated-list').textContent ?? '', /第 1 页灵感/);
  const libraryCalls = () => listCalls.filter((call) => call.options.limit === 12);
  assert.deepEqual(libraryCalls()[0], { envId: 'env-a', options: { mode: 'uncreated', sort: 'weighted', limit: 12, offset: 0 } });

  $(window, '#curated-next').dispatchEvent(new window.Event('click'));
  await flush();
  assert.match($(window, '#curated-page').textContent ?? '', /第 2 \/ 3 页/);
  assert.equal(libraryCalls()[1].options.offset, 12);
  const list = $(window, '#curated-list');
  list.scrollTop = 73;
  (list.querySelector('.curated-card') as HTMLElement).dispatchEvent(new window.Event('click'));
  await flush();
  assert.equal(controller.currentPage(), 'detail');
  assert.match($(window, '#curated-detail').textContent ?? '', /详情 19/);

  $(window, '.curated-detail-actions .cw-button.primary').dispatchEvent(new window.Event('click'));
  assert.equal(controller.currentPage(), 'create');
  assert.equal(hidden($(window, '#content-workspace-back')), false);
  assert.equal($(window, '#content-workspace-close').getAttribute('aria-label'), '返回灵感库');

  $(window, '#content-workspace-close').dispatchEvent(new window.Event('click'));
  assert.equal(controller.currentPage(), 'library');
  assert.equal(hidden($(window, '#content-workspace')), false);
  assert.equal($(window, '#content-workspace-close').getAttribute('aria-label'), '关闭内容工作区');
  assert.match($(window, '#curated-page').textContent ?? '', /第 2 \/ 3 页/);
  assert.equal($(window, '#curated-list').scrollTop, 73);

  ($(window, '[data-curated-mode="created"]')).dispatchEvent(new window.Event('click'));
  await flush();
  assert.deepEqual(listCalls.at(-1)?.options, { mode: 'created', sort: 'weighted', limit: 12, offset: 0 });

  ($(window, '[data-curated-mode="all"]')).dispatchEvent(new window.Event('click'));
  await flush();
  assert.deepEqual(listCalls.at(-1)?.options, { mode: 'all', sort: 'weighted', limit: 12, offset: 0 });

  $(window, '#content-workspace-close').dispatchEvent(new window.Event('click'));
  await flush();
  assert.equal(controller.currentPage(), 'home');
  assert.equal(hidden($(window, '#content-workspace')), true);
  assert.equal(hidden($(window, '#legacy-workspace')), false);
  assert.equal(hidden($(window, '#xhs-environment-dashboard')), false);
  assert.equal(window.document.querySelectorAll('[data-content-page="home"]').length, 0);
});

test('排序由服务端执行，切换时保留旧卡片并在成功后原子替换第一页', async () => {
  let resolveCollects: ((value: unknown) => void) | undefined;
  const pendingCollects = new Promise((resolve) => { resolveCollects = resolve; });
  const calls: Array<{ envId: string; options: Record<string, unknown> }> = [];
  const { window, controller } = boot({
    curatedList: async (envId: string, options: Record<string, unknown>) => {
      calls.push({ envId, options: JSON.parse(JSON.stringify(options)) });
      if (options.sort === 'collects') return pendingCollects;
      return { ok: true, data: { items: [listItem({ title: '原综合热度第一名' })], total: 25 } };
    },
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  controller.openLibrary();
  await flush();
  $(window, '#curated-next').click();
  await flush();
  assert.match($(window, '#curated-page').textContent ?? '', /第 2 \/ 3 页/);

  $(window, '#curated-sort-trigger').click();
  assert.equal($(window, '#curated-sort-trigger').getAttribute('aria-expanded'), 'true');
  ($(window, '[data-curated-sort="collects"]') as HTMLButtonElement).click();
  await flush(2);

  assert.deepEqual(calls.at(-1), {
    envId: 'env-a', options: { mode: 'uncreated', sort: 'collects', limit: 12, offset: 0 },
  });
  assert.match($(window, '#curated-list').textContent ?? '', /原综合热度第一名/, '排序在途必须保留已确认卡片');
  assert.equal($(window, '#curated-list').getAttribute('aria-busy'), 'true');
  assert.equal($(window, '#curated-library-view').classList.contains('is-reordering'), true);
  assert.equal(($(window, '#curated-sort-trigger') as HTMLButtonElement).disabled, true);

  resolveCollects?.({ ok: true, data: { items: [listItem({ id: 9, title: '收藏第一名' })], total: 25 } });
  await flush();
  assert.match($(window, '#curated-list').textContent ?? '', /收藏第一名/);
  assert.doesNotMatch($(window, '#curated-list').textContent ?? '', /原综合热度第一名/);
  assert.match($(window, '#curated-page').textContent ?? '', /第 1 \/ 3 页/);
  assert.equal($(window, '#curated-sort-label').textContent, '收藏最多');
  assert.equal($(window, '#curated-library-view').classList.contains('is-reordering'), false);
});

test('瞬时排序失败回退旧状态，身份归属失败则清除缓存内容', async () => {
  let failure: 'transient' | 'binding' | null = null;
  const { window, controller } = boot({
    curatedList: async (_envId: string, options: { sort: string }) => {
      if (options.sort === 'likes' && failure === 'transient') return { ok: false, error: 'request_failed' };
      if (options.sort === 'collects' && failure === 'binding') return { ok: false, error: 'binding_conflict' };
      return { ok: true, data: { items: [listItem({ title: '已确认的灵感' })], total: 1 } };
    },
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  controller.openLibrary();
  await flush();

  failure = 'transient';
  $(window, '#curated-sort-trigger').click();
  ($(window, '[data-curated-sort="likes"]') as HTMLButtonElement).click();
  await flush();
  assert.match($(window, '#curated-list').textContent ?? '', /已确认的灵感/);
  assert.equal($(window, '#curated-sort-label').textContent, '综合热度');
  assert.match($(window, '#curated-sort-feedback').textContent ?? '', /排序未更新/);
  assert.equal(hidden($(window, '#curated-sort-feedback')), false);

  failure = 'binding';
  $(window, '#curated-sort-trigger').click();
  ($(window, '[data-curated-sort="collects"]') as HTMLButtonElement).click();
  await flush();
  assert.doesNotMatch($(window, '#curated-list').textContent ?? '', /已确认的灵感/);
  assert.match($(window, '#curated-list').textContent ?? '', /同时出现在多个客户的环境/);
  assert.equal(hidden($(window, '#curated-sort-feedback')), true);
});

test('排序状态按环境恢复，菜单支持方向键、Enter 与 Escape', async () => {
  const calls: Array<{ envId: string; sort: string }> = [];
  const { window, controller } = boot({
    curatedList: async (envId: string, options: { sort: string }) => {
      calls.push({ envId, sort: options.sort });
      return { ok: true, data: { items: [listItem({ title: `${envId}-${options.sort}` })], total: 1 } };
    },
    curatedGet: async () => ({ ok: true, data: { item: detail() } }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '账号 A', platform: 'xiaohongshu' });
  controller.openLibrary();
  await flush();

  const trigger = $(window, '#curated-sort-trigger');
  trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal((window.document.activeElement as HTMLElement)?.dataset.curatedSort, 'weighted');
  $(window, '#curated-sort-menu').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal((window.document.activeElement as HTMLElement)?.dataset.curatedSort, 'collects');
  $(window, '#curated-sort-menu').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.equal($(window, '#curated-sort-label').textContent, '收藏最多');

  $(window, '.curated-card').click();
  await flush();
  $(window, '#content-workspace-close').click();
  assert.equal($(window, '#curated-sort-label').textContent, '收藏最多', '详情返回必须保留排序');

  controller.setEnvironment({ envId: 'env-b', label: '账号 B', platform: 'xiaohongshu' });
  await flush();
  assert.equal($(window, '#curated-sort-label').textContent, '综合热度');
  controller.setEnvironment({ envId: 'env-a', label: '账号 A', platform: 'xiaohongshu' });
  await flush();
  assert.equal($(window, '#curated-sort-label').textContent, '收藏最多');
  assert.deepEqual(calls.slice(-2), [{ envId: 'env-b', sort: 'weighted' }, { envId: 'env-a', sort: 'collects' }]);

  trigger.click();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('精选详情双栏保留彼此独立的滚动位置，窄屏交回单列文档流', async () => {
  const { window, controller } = boot({
    curatedList: async () => ({ ok: true, data: { items: [listItem()], total: 1 } }),
    curatedGet: async () => ({
      ok: true,
      data: {
        item: detail({
          body: '很长的正文\n'.repeat(80),
          referenceImages: Array.from({ length: 6 }, (_, index) => ({
            index,
            sourceUrl: `https://img.test/${index}.jpg`,
            captureStatus: 'url_only',
            capturedAt: 1,
          })),
        }),
      },
    }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  controller.openLibrary();
  await flush();
  $(window, '.curated-card').dispatchEvent(new window.Event('click'));
  await flush();

  const workspace = $(window, '#content-workspace');
  const media = $(window, '.curated-detail-media');
  const copy = $(window, '.curated-detail-copy');
  const close = $(window, '#content-workspace-close');
  const back = $(window, '#content-workspace-back');
  assert.equal(workspace.classList.contains('curated-detail-mode'), true);
  assert.equal(hidden(close), false);
  assert.equal(hidden(back), true);
  assert.equal(close.getAttribute('aria-label'), '返回灵感库');

  const mediaTop = installClampedScroll(media, 80);
  const copyTop = installClampedScroll(copy, 240);
  media.scrollTop = 80;
  assert.deepEqual([mediaTop(), copyTop()], [80, 0]);
  copy.scrollTop = 160;
  assert.deepEqual([mediaTop(), copyTop()], [80, 160]);

  const mediaWheel = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
  media.dispatchEvent(mediaWheel);
  assert.equal(mediaWheel.defaultPrevented, false, '渲染层不得接管滚轮并联动另一栏');
  assert.deepEqual([mediaTop(), copyTop()], [80, 160]);

  const copyWheel = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
  copy.dispatchEvent(copyWheel);
  assert.equal(copyWheel.defaultPrevented, false);
  assert.deepEqual([mediaTop(), copyTop()], [80, 160]);

  close.dispatchEvent(new window.Event('click'));
  assert.equal(workspace.classList.contains('curated-detail-mode'), false);
  assert.equal(controller.currentPage(), 'library');
  assert.equal(hidden(workspace), false);
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
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu', inspirationCount: 1 });
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

test('洗稿任务一经受理，返回未创作列表时立即向服务端重载归类', async () => {
  let listReads = 0;
  const item = listItem({ referenceImages: [] });
  const { window, controller } = boot({
    curatedList: async (_envId: string, options: { mode: string }) => {
      if (options.mode === 'all') return { ok: true, data: { items: [], total: 0 } };
      listReads += 1;
      assert.equal(options.mode, 'uncreated');
      return listReads === 1
        ? { ok: true, data: { items: [item], total: 1 } }
        : { ok: true, data: { items: [], total: 0 } };
    },
    curatedGet: async () => ({ ok: true, data: { item: detail({ referenceImages: [] }) } }),
    curatedCreatePost: async () => ({
      ok: true,
      data: { triggered: true, created: true, task: { id: 'task-triggered', status: 'queued', version: 1 } },
    }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  controller.openLibrary();
  await flush();
  $(window, '.curated-card').dispatchEvent(new window.Event('click'));
  await flush();
  $(window, '.curated-detail-actions .cw-button.primary').dispatchEvent(new window.Event('click'));
  $(window, '#curated-create .cw-button.primary').dispatchEvent(new window.Event('click'));
  await flush();

  $(window, '#content-workspace-close').dispatchEvent(new window.Event('click'));
  await flush();
  assert.equal(controller.currentPage(), 'library');
  assert.equal(listReads, 2, '已持久化触发后必须重读服务端归类，不能保留本地未创作旧页');
  assert.match($(window, '#curated-list').textContent ?? '', /还没有未创作灵感/);
});

test('切账号丢弃旧请求，稿件审核在账号切换时关闭且不残留', async () => {
  let resolveA: ((value: unknown) => void) | undefined;
  const pendingA = new Promise((resolve) => { resolveA = resolve; });
  const { window, controller } = boot({
    curatedList: async (envId: string) => envId === 'env-a'
      ? pendingA
      : { ok: true, data: { items: [listItem({ title: 'B 的灵感' })], total: 1 } },
  });
  controller.setEnvironment({ envId: 'env-a', label: '账号 A', platform: 'xiaohongshu', inspirationCount: 1 });
  controller.openLibrary();
  await flush(2);
  controller.setEnvironment({ envId: 'env-b', label: '账号 B', platform: 'xiaohongshu', inspirationCount: 1 });
  await flush(4);
  resolveA?.({ ok: true, data: { items: [listItem({ title: 'A 的迟到灵感' })], total: 1 } });
  await flush(4);
  const text = $(window, '#curated-list').textContent ?? '';
  assert.match(text, /B 的灵感/);
  assert.doesNotMatch(text, /A 的迟到灵感/);

  controller.openDraft();
  assert.equal(controller.isDraftOpen(), true);
  assert.ok($(window, '#publish-preview-panel').classList.contains('open'));
  controller.setEnvironment({ envId: 'env-c', label: '账号 C', platform: 'xiaohongshu', inspirationCount: 0 });
  assert.equal(controller.isDraftOpen(), false);
  assert.equal(hidden($(window, '#content-workspace')), true);
  assert.equal(hidden($(window, '#legacy-workspace')), false);
});

test('稿件审核占满主内容区，返回/关闭不影响主窗口壳', () => {
  const { window, controller } = boot({});
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu', inspirationCount: 2 });
  controller.openDraft();
  assert.equal(hidden($(window, '#content-workspace')), false);
  assert.equal(hidden($(window, '#legacy-workspace')), true);
  assert.ok($(window, '.shell').classList.contains('content-mode'));
  assert.match($(window, '#content-workspace-title').textContent ?? '', /稿件审核/);
  assert.equal($(window, '#publish-preview-panel').getAttribute('aria-hidden'), 'false');
  assert.equal($(window, '#content-workspace-close').getAttribute('aria-label'), '关闭内容工作区');
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
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
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
  assert.equal(controller.currentPage(), 'detail', '左侧返回仍应只退一层到详情');
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
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
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
  controller.setEnvironment({ envId: 'env-a', label: '账号 A', platform: 'xiaohongshu' });
  controller.openLibrary();
  await flush();
  $(window, '.curated-card').dispatchEvent(new window.Event('click'));
  await flush();

  // 详情还在途 → 切到账号 B → A 的详情回包必须不得渲染到 B 名下。
  controller.setEnvironment({ envId: 'env-b', label: '账号 B', platform: 'xiaohongshu' });
  await flush();
  detailDeferred.resolve?.({ ok: true, data: { item: detail({ title: 'A 账号的私有灵感' }) } });
  await flush();
  assert.doesNotMatch(window.document.body.textContent ?? '', /A 账号的私有灵感/, '旧账号详情绝不能渲染到新账号下');
  assert.equal(hidden($(window, '#content-workspace')), true);
  assert.equal(hidden($(window, '#xhs-environment-dashboard')), false);
  assert.match($(window, '#content-work-account').textContent ?? '', /账号 B/);
});

test('汇总读失败时环境首页保留未知值，并在内容区明确呈现读取失败', async () => {
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: false, status: 503, error: 'curated_content_unavailable', reason: 'curated_content_unavailable' }),
    curatedList: async () => ({ ok: false, status: 503, error: 'curated_content_unavailable', reason: 'curated_content_unavailable' }),
    publishDraftList: async () => ({ ok: false, status: 503, error: 'publish_drafts_unavailable' }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  await flush();
  assert.equal($(window, '#content-home-inspiration-count').textContent, '—');
  assert.match(window.document.body.textContent ?? '', /暂时无法读取精选内容/);
  assert.doesNotMatch($(window, '#content-home-heading').textContent ?? '', /0 条精选灵感/);
});

test('真实 0 条精选在环境首页显示为已知零值', async () => {
  const { window, controller } = boot({
    curatedSummary: async () => ({ ok: true, data: { total: 0, referenceDraftCount: 0 } }),
    curatedList: async () => ({ ok: true, data: { items: [], total: 0, referenceDraftCount: 0 } }),
    publishDraftList: async () => ({ ok: true, data: { items: [], total: 0 } }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  await flush();
  assert.equal($(window, '#content-home-inspiration-count').textContent, '0');
  assert.match($(window, '#content-home-heading').textContent ?? '', /还在寻找新灵感/);
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

test('小红书发布队列按三段呈现四阶段真态，非小红书切换立即关闭且不取数', async () => {
  const calls: string[] = [];
  const { window, controller } = boot({
    publishQueueGet: async (envId: string) => {
      calls.push(envId);
      return queueResponse();
    },
    publishQueueCancel: async () => ({ ok: false, error: 'not_used' }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  await flush();
  const homeProcess = $(window, '#content-work-timeline').textContent ?? '';
  assert.match(homeProcess, /开始创作完成.*正文与配图完成.*发布确认中\.\.\./s);
  assert.doesNotMatch(homeProcess, /发布结果中/, '未来步骤只留在计划中，不得提前显示成正在进行');
  controller.openPublishQueue();
  await flush();

  assert.equal(controller.currentPage(), 'queue');
  assert.equal(hidden($(window, '#content-workspace')), false);
  const text = $(window, '#publish-queue-content').textContent ?? '';
  assert.match(text, /2 条内容正在路上/);
  assert.match(text, /需要你处理.*待确认稿件/s);
  assert.match(text, /系统处理中.*排队与创作/s);
  assert.match(text, /最近完成.*平台确认中，请勿重复操作/s);
  assert.match(text, /正文与配图.*2\/4/s);
  assert.match(text, /发布确认.*待你确认/s);
  assert.match(text, /发布结果.*等待发布/s);
  assert.equal(window.document.querySelectorAll('.publish-queue-stages[role="list"]').length, 2);
  assert.equal(window.document.querySelectorAll('.publish-queue-stage[role="listitem"]').length, 8);
  assert.equal(window.document.querySelector('.publish-queue-stage.is-waiting_human')?.getAttribute('aria-label'), '发布确认，待你确认');
  assert.equal(window.document.querySelectorAll('[data-queue-task-id="task-queue-1"]').length, 1);
  assert.ok(calls.every((envId) => envId === 'env-a'));

  const callCount = calls.length;
  controller.setEnvironment({ envId: 'env-fb', label: 'Facebook 账号', platform: 'facebook' });
  await flush();
  assert.equal(controller.currentPage(), 'home');
  assert.equal(hidden($(window, '#content-workspace')), true);
  assert.equal(controller.publishQueueSnapshot(), null);
  assert.equal(calls.length, callCount, '非小红书环境不得请求发布队列');
});

test('下发证据 stale 时显示暂不可用，不推断待确认、等待发布或正在发布', async () => {
  const { window, controller } = boot({
    publishQueueGet: async () => queueResponse({
      inFlightEvidence: { state: 'stale', asOf: Date.now() - 60_000 },
      summary: { inProgress: 1, waitingForYou: 1, cancellable: 0 },
      tasks: [],
      active: [queueJourney()],
      recent: [],
    }),
    publishQueueCancel: async () => ({ ok: false, error: 'not_used' }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  await flush();
  controller.openPublishQueue();
  await flush();

  const snapshot = controller.publishQueueSnapshot().data;
  const text = $(window, '#publish-queue-content').textContent ?? '';
  assert.equal(snapshot.inFlightEvidence.state, 'stale');
  assert.equal(snapshot.summary.waitingForYou, null, '不确定稿件不得保留确定待确认计数');
  assert.match(text, /下发状态暂不可用/);
  assert.equal(window.document.querySelectorAll('.publish-queue-stage.is-evidence_unavailable').length, 2);
  assert.doesNotMatch(
    Array.from(window.document.querySelectorAll('.publish-queue-stage-copy span'))
      .map((node) => node.textContent).join(' '),
    /待你确认|等待发布|正在发布|未下发/,
  );
  assert.equal(
    Array.from(window.document.querySelectorAll('#publish-queue-content button'))
      .some((button) => button.textContent === '审核稿件'),
    false,
  );
});

test('发布队列切换账号后丢弃旧环境迟到响应', async () => {
  let resolveA: ((value: unknown) => void) | undefined;
  const pendingA = new Promise((resolve) => { resolveA = resolve; });
  const { controller } = boot({
    publishQueueGet: async (envId: string) => envId === 'env-a'
      ? pendingA
      : queueResponse({
        summary: { inProgress: 1, waitingForYou: 0, cancellable: 1 }, active: [], recent: [],
        tasks: [queueTask({ id: 'task-b', title: '账号 B 的任务' })],
      }),
    publishQueueCancel: async () => ({ ok: false, error: 'not_used' }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '账号 A', platform: 'xiaohongshu' });
  controller.setEnvironment({ envId: 'env-b', label: '账号 B', platform: 'xiaohongshu' });
  await flush();
  assert.equal(controller.publishQueueSnapshot().data.tasks[0].title, '账号 B 的任务');
  resolveA?.(queueResponse({
    summary: { inProgress: 1, waitingForYou: 0, cancellable: 1 }, active: [], recent: [],
    tasks: [queueTask({ id: 'task-a', title: '账号 A 的迟到任务' })],
  }));
  await flush();
  assert.equal(controller.publishQueueSnapshot().data.tasks[0].title, '账号 B 的任务');
});

test('取消 queued 任务不乐观移除，只提交精确 id/version 并在 Cloud 刷新后消失', async () => {
  let queueRead = 0;
  let resolveCancel: ((value: unknown) => void) | undefined;
  const cancelPending = new Promise((resolve) => { resolveCancel = resolve; });
  const cancelCalls: unknown[][] = [];
  const { window, controller } = boot({
    publishQueueGet: async () => {
      queueRead += 1;
      return queueRead >= 3
        ? queueResponse({ summary: { inProgress: 0, waitingForYou: 0, cancellable: 0 }, tasks: [], active: [] })
        : queueResponse({ summary: { inProgress: 1, waitingForYou: 0, cancellable: 1 }, active: [], recent: [] });
    },
    publishQueueCancel: async (...args: unknown[]) => {
      cancelCalls.push(args);
      return cancelPending;
    },
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  await flush();
  controller.openPublishQueue();
  await flush();
  const cancelButton = window.document.querySelector('[data-queue-task-id="task-queue-1"]') as HTMLButtonElement;
  cancelButton.click();
  assert.equal($(window, '#publish-queue-cancel-confirm').hasAttribute('open'), true);
  $(window, '#publish-queue-cancel-submit').click();
  await flush(2);
  assert.deepEqual(cancelCalls, [['env-a', 'task-queue-1', 3]]);
  assert.equal(window.document.querySelectorAll('[data-queue-task-id="task-queue-1"]').length, 1, 'Cloud 回包前不得乐观删除');

  resolveCancel?.({ ok: true, data: { data: { id: 'task-queue-1', status: 'cancelled', cancelRequested: false, version: 4, terminal: true } } });
  await flush(8);
  assert.equal(window.document.querySelectorAll('[data-queue-task-id="task-queue-1"]').length, 0);
  assert.match($(window, '#publish-queue-content').textContent ?? '', /夏日通勤穿搭.*已取消/s);
});

test('planning 取消显示安全收口且禁用重复取消；版本冲突只刷新不自动重试', async () => {
  let mode: 'planning' | 'conflict' = 'planning';
  let reads = 0;
  const cancelCalls: unknown[][] = [];
  const { window, controller } = boot({
    publishQueueGet: async () => {
      reads += 1;
      if (mode === 'planning' && reads >= 3) {
        return queueResponse({
          summary: { inProgress: 1, waitingForYou: 0, cancellable: 0 }, active: [], recent: [],
          tasks: [queueTask({ status: 'planning', statusLabel: '取消中，将在安全边界停止', cancelRequested: true, version: 4 })],
        });
      }
      return queueResponse({
        summary: { inProgress: 1, waitingForYou: 0, cancellable: 1 }, active: [], recent: [],
        tasks: [queueTask({ status: 'planning', statusLabel: '正在准备创作' })],
      });
    },
    publishQueueCancel: async (...args: unknown[]) => {
      cancelCalls.push(args);
      return mode === 'planning'
        ? { ok: true, data: { data: { id: 'task-queue-1', status: 'planning', cancelRequested: true, version: 4, terminal: false } } }
        : { ok: false, status: 409, reason: 'version_conflict', error: '任务状态已经变化' };
    },
  });
  controller.setEnvironment({ envId: 'env-a', label: '晚风手作', platform: 'xiaohongshu' });
  await flush();
  controller.openPublishQueue();
  await flush();
  (window.document.querySelector('[data-queue-task-id="task-queue-1"]') as HTMLButtonElement).click();
  $(window, '#publish-queue-cancel-submit').click();
  await flush(8);
  assert.match($(window, '#publish-queue-content').textContent ?? '', /取消中.*安全边界停止/s);
  assert.equal(window.document.querySelectorAll('[data-queue-task-id="task-queue-1"]').length, 0, '取消中不得再出现取消入口');

  mode = 'conflict';
  reads = 0;
  controller.setEnvironment({ envId: 'env-b', label: '晨光记录', platform: 'xiaohongshu' });
  await flush();
  controller.openPublishQueue();
  await flush();
  (window.document.querySelector('[data-queue-task-id="task-queue-1"]') as HTMLButtonElement).click();
  $(window, '#publish-queue-cancel-submit').click();
  await flush(8);
  assert.equal(cancelCalls.filter((args) => args[0] === 'env-b').length, 1, '版本冲突不得使用新版本自动重试');
  assert.match($(window, '#publish-queue-content').textContent ?? '', /任务状态已经变化/);
  assert.equal(window.document.querySelectorAll('[data-queue-task-id="task-queue-1"]').length, 1, '失败后保留任务');
});
