import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, type DOMWindow } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const source = readFileSync(join(electronDir, 'renderer/environment-schedule.js'), 'utf8');
const openWindows: DOMWindow[] = [];
after(() => openWindows.forEach((window) => window.close()));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush(times = 4) { for (let index = 0; index < times; index += 1) await tick(); }
const $ = (window: DOMWindow, selector: string) => window.document.querySelector(selector) as unknown as HTMLElement;

function days() {
  return [
    {
      day: 'monday',
      activityRanges: [{ startHour: 9, endHour: 12 }, { startHour: 14, endHour: 18 }],
      contentRanges: [{ startHour: 10, endHour: 11 }, { startHour: 15, endHour: 17 }],
    },
    { day: 'tuesday', activityRanges: [{ startHour: 9, endHour: 12 }], contentRanges: [] },
    { day: 'wednesday', activityRanges: [], contentRanges: [] },
    { day: 'thursday', activityRanges: [], contentRanges: [] },
    { day: 'friday', activityRanges: [], contentRanges: [] },
    { day: 'saturday', activityRanges: [], contentRanges: [] },
    { day: 'sunday', activityRanges: [], contentRanges: [] },
  ];
}

function response(
  overrides: Record<string, unknown> = {},
  asOf = Date.parse('2026-07-20T02:30:00.000Z'), // Monday 10:30 in Asia/Shanghai
) {
  const data = {
    envKey: 'profile-a',
    timezone: 'Asia/Shanghai',
    weekStartsOn: 'monday',
    autoEnabled: true,
    days: days(),
    actions: [{
      key: 'post',
      label: '创作与发布',
      dailyCap: 2,
      approval: 'review',
      resultCopy: '草稿完成后等你确认',
    }],
    windows: {
      currentActivity: {
        day: 'monday', dayIndex: 0, dayOffset: 0, startHour: 9, endHour: 12,
        startsAt: Date.parse('2026-07-20T01:00:00.000Z'),
        endsAt: Date.parse('2026-07-20T04:00:00.000Z'),
      },
      currentContent: {
        day: 'monday', dayIndex: 0, dayOffset: 0, startHour: 10, endHour: 11,
        startsAt: Date.parse('2026-07-20T02:00:00.000Z'),
        endsAt: Date.parse('2026-07-20T03:00:00.000Z'),
      },
      nextActivity: {
        day: 'monday', dayIndex: 0, dayOffset: 0, startHour: 14, endHour: 18,
        startsAt: Date.parse('2026-07-20T06:00:00.000Z'),
        endsAt: Date.parse('2026-07-20T10:00:00.000Z'),
      },
      nextContent: {
        day: 'monday', dayIndex: 0, dayOffset: 0, startHour: 15, endHour: 17,
        startsAt: Date.parse('2026-07-20T07:00:00.000Z'),
        endsAt: Date.parse('2026-07-20T09:00:00.000Z'),
      },
    },
    ...overrides,
  };
  return { ok: true, data: { data, meta: { requestId: 'schedule-request', asOf } } };
}

function boot(api: Record<string, unknown>, onRuntimeAction: (action: string) => void = () => {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  openWindows.push(window);
  window.scrollTo = () => {};
  window.eval(source);
  const factory = (window as unknown as {
    EnvironmentSchedule: { create(options: unknown): any };
  }).EnvironmentSchedule;
  const controller = factory.create({
    root: $(window, '#environment-schedule-workspace'),
    entry: $(window, '#environment-schedule-entry'),
    legacyRoot: $(window, '#legacy-workspace'),
    interactionRoot: $(window, '#interaction-workspace'),
    contentRoot: $(window, '#content-workspace'),
    shell: $(window, '.shell'),
    api,
    onRuntimeAction,
  });
  return { window, controller };
}

test('入口只属于小红书环境，浏览器和自动化停止时仍通过 HTTP 读取并打开环境内排期', async () => {
  const calls: string[] = [];
  const { window, controller } = boot({
    getEnvironmentSchedule: async (envId: string) => {
      calls.push(envId);
      return response();
    },
  });
  controller.setRuntime({
    automationState: 'stopped',
    browserState: 'closed',
    dailyUsage: { totals: { view: 28, search: 5, like: 4, collect: 2, comment: 1, publish: 0 } },
  });
  controller.setEnvironment({ envId: 'env-a', label: '小萝北', platform: 'xiaohongshu' });
  await flush();

  assert.deepEqual(calls, ['env-a']);
  assert.equal($(window, '#environment-schedule-entry').classList.contains('hidden'), false);
  assert.match($(window, '#environment-schedule-entry-summary').textContent || '', /当前允许工作.*12:00/);

  $(window, '#environment-schedule-entry').click();
  assert.equal($(window, '#legacy-workspace').classList.contains('hidden'), true);
  assert.equal($(window, '#environment-schedule-workspace').classList.contains('hidden'), false);
  assert.ok($(window, '.shell').classList.contains('schedule-mode'));
  assert.match($(window, '#environment-schedule-account').textContent || '', /小萝北/);
  assert.equal($(window, '#environment-schedule-now-kicker').textContent, '当前可工作');
  assert.match($(window, '#environment-schedule-now-detail').textContent || '', /只有启动环境后/);
  assert.match($(window, '#environment-schedule-ranges').textContent || '', /09:00–12:00.*当前可工作/s);
  assert.match($(window, '#environment-schedule-usage').textContent || '', /28浏览.*4点赞.*2收藏/s);
});

test('“工作中”只来自真实运行态，排期页按钮复用当前环境生命周期动作', async () => {
  const actions: string[] = [];
  const { window, controller } = boot(
    { getEnvironmentSchedule: async () => response() },
    (action) => actions.push(action),
  );
  controller.setEnvironment({ envId: 'env-a', label: '小萝北', platform: 'xiaohongshu' });
  await flush();
  controller.setRuntime({ automationState: 'running', browserState: 'open' });
  $(window, '#environment-schedule-entry').click();

  assert.equal($(window, '#environment-schedule-entry-badge').textContent, '工作中');
  assert.equal($(window, '#environment-schedule-now-kicker').textContent, '当前正在工作');
  assert.equal($(window, '#environment-schedule-lifecycle').textContent, '关闭当前环境');
  assert.equal($(window, '#environment-schedule-browser').textContent, '收起浏览器');
  $(window, '#environment-schedule-lifecycle').click();
  $(window, '#environment-schedule-browser').click();
  assert.deepEqual(actions, ['close', 'browser-close']);
});

test('切换环境会丢弃旧账号迟到回包，非小红书环境隐藏入口并退出排期页', async () => {
  let resolveA: ((value: unknown) => void) | undefined;
  const pendingA = new Promise((resolve) => { resolveA = resolve; });
  const { window, controller } = boot({
    getEnvironmentSchedule: async (envId: string) => envId === 'env-a' ? pendingA : response({ envKey: 'profile-b' }),
  });
  controller.setEnvironment({ envId: 'env-a', label: '账号 A', platform: 'xiaohongshu' });
  controller.setEnvironment({ envId: 'env-b', label: '账号 B', platform: 'xiaohongshu' });
  await flush();
  resolveA?.({ ok: false, error: 'client_session_expired' });
  await flush();
  assert.equal(controller.snapshot().environment.envId, 'env-b');
  assert.equal(controller.snapshot().phase, 'ready');

  $(window, '#environment-schedule-entry').click();
  controller.setEnvironment({ envId: 'env-c', label: '视频号', platform: 'wechat_channels' });
  assert.equal($(window, '#environment-schedule-entry').classList.contains('hidden'), true);
  assert.equal($(window, '#environment-schedule-workspace').classList.contains('hidden'), true);
  assert.equal($(window, '#legacy-workspace').classList.contains('hidden'), false);
});

test('空安排与读取失败都有环境内诚实空态，失败可原位重试', async () => {
  let attempt = 0;
  const emptyDays = days().map((day) => ({ ...day, activityRanges: [], contentRanges: [] }));
  const emptyResponse = response({
    autoEnabled: false,
    days: emptyDays,
    actions: [],
    windows: { currentActivity: null, currentContent: null, nextActivity: null, nextContent: null },
  });
  const { window, controller } = boot({
    getEnvironmentSchedule: async () => {
      attempt += 1;
      return attempt === 1 ? { ok: false, error: 'binding_unknown' } : emptyResponse;
    },
  });
  controller.setEnvironment({ envId: 'env-a', label: '小萝北', platform: 'xiaohongshu' });
  await flush();
  assert.equal($(window, '#environment-schedule-entry-badge').textContent, '可重试');
  assert.match($(window, '#environment-schedule-entry-summary').textContent || '', /还没有确认对应/);

  $(window, '#environment-schedule-entry').click();
  assert.equal($(window, '#environment-schedule-retry').classList.contains('hidden'), false);
  $(window, '#environment-schedule-retry').click();
  await flush();
  assert.match($(window, '#environment-schedule-now-title').textContent || '', /本周暂无账号工作时段/);
  assert.match($(window, '#environment-schedule-ranges').textContent || '', /这一天没有工作安排/);
  assert.match($(window, '#environment-schedule-actions').textContent || '', /自动内容暂未开启/);
});

test('过去的排期只标记已结束，绝不冒充任务已完成', async () => {
  const lateMonday = Date.parse('2026-07-20T05:30:00.000Z'); // Monday 13:30 in Asia/Shanghai
  const { window, controller } = boot({
    getEnvironmentSchedule: async () => response({
      windows: {
        currentActivity: null,
        currentContent: null,
        nextActivity: {
          day: 'monday', dayIndex: 0, dayOffset: 0, startHour: 14, endHour: 18,
          startsAt: Date.parse('2026-07-20T06:00:00.000Z'),
          endsAt: Date.parse('2026-07-20T10:00:00.000Z'),
        },
        nextContent: {
          day: 'monday', dayIndex: 0, dayOffset: 0, startHour: 15, endHour: 17,
          startsAt: Date.parse('2026-07-20T07:00:00.000Z'),
          endsAt: Date.parse('2026-07-20T09:00:00.000Z'),
        },
      },
    }, lateMonday),
  });
  controller.setEnvironment({ envId: 'env-a', label: '小萝北', platform: 'xiaohongshu' });
  await flush();
  $(window, '#environment-schedule-entry').click();
  assert.match($(window, '#environment-schedule-ranges').textContent || '', /09:00–12:00.*已结束/s);
  assert.doesNotMatch($(window, '#environment-schedule-workspace').textContent || '', /已完成任务/);
  assert.match($(window, '.esw-note').textContent || '', /不代表任务已经执行/);
});
