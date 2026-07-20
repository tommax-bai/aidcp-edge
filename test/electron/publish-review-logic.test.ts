import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const logic = require('../../src/electron/renderer/publish-review-logic.js') as {
  toShanghaiInput(timestamp: number): string;
  fromShanghaiInput(value: string): number | null;
  defaultScheduledInput(now: number): string;
  shanghaiHourKey(timestamp: number): string;
  nextPeakScheduledInput(currentInput: string, occupiedTimes: number[], now: number): string | null;
  validatePlan(platform: string, mode: string, value: string, now: number):
    { ok: boolean; publishMode?: 'immediate' | 'scheduled'; publishTime?: number | null; reason?: string };
  normalizeDraft(raw: Record<string, unknown>): Record<string, unknown>;
};

const NOW = Date.parse('2026-07-18T10:00:30+08:00');

test('上海时区 datetime-local 往返不依赖操作系统时区', () => {
  const timestamp = Date.parse('2026-07-19T14:35:00+08:00');
  assert.equal(logic.toShanghaiInput(timestamp), '2026-07-19T14:35');
  assert.equal(logic.fromShanghaiInput('2026-07-19T14:35'), timestamp);
  assert.equal(logic.fromShanghaiInput('2026-02-30T10:00'), null);
});

test('默认定时时间向上取整，确保至少提前一小时', () => {
  assert.equal(logic.defaultScheduledInput(NOW), '2026-07-18T11:01');
});

test('热门时段按北京时间 08、12、18 点前进并可跨日连续选择', () => {
  const now = Date.parse('2026-07-20T06:30:00+08:00');
  assert.equal(logic.nextPeakScheduledInput('', [], now), '2026-07-20T08:00');
  assert.equal(logic.nextPeakScheduledInput('2026-07-20T08:00', [], now), '2026-07-20T12:00');
  assert.equal(logic.nextPeakScheduledInput('2026-07-20T18:00', [], now), '2026-07-21T08:00');
});

test('空闲热门时段按北京时间自然小时跳过，08:15 占用早上档', () => {
  const now = Date.parse('2026-07-20T20:00:00+08:00');
  const occupied = [Date.parse('2026-07-21T08:15:00+08:00')];
  assert.equal(logic.shanghaiHourKey(occupied[0]), '2026-07-21T08');
  assert.equal(logic.nextPeakScheduledInput('2026-07-20T21:00', occupied, now), '2026-07-21T12:00');
});

test('所有候选被占用时不越过未来 14 天窗口', () => {
  const now = Date.parse('2026-07-20T20:00:00+08:00');
  const occupied: number[] = [];
  const firstDay = Date.parse('2026-07-21T00:00:00Z');
  for (let day = 0; day < 14; day += 1) {
    const date = new Date(firstDay + day * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const hour of [8, 12, 18]) {
      occupied.push(Date.parse(`${date}T${String(hour).padStart(2, '0')}:15:00+08:00`));
    }
  }
  assert.equal(logic.nextPeakScheduledInput('2026-07-20T21:00', occupied, now), null);
});

test('审批计划严格限制小红书未来 1 小时至 14 天', () => {
  assert.deepEqual(logic.validatePlan('xiaohongshu', 'immediate', '', NOW), {
    ok: true, publishMode: 'immediate', publishTime: null,
  });
  assert.equal(logic.validatePlan('facebook', 'scheduled', '2026-07-18T12:00', NOW).reason, 'schedule_platform_unsupported');
  assert.equal(logic.validatePlan('xiaohongshu', 'scheduled', '', NOW).reason, 'schedule_time_required');
  assert.equal(logic.validatePlan('xiaohongshu', 'scheduled', '2026-07-18T11:00', NOW).reason, 'schedule_time_out_of_range');
  assert.equal(logic.validatePlan('xiaohongshu', 'scheduled', '2026-08-01T10:01', NOW).reason, 'schedule_time_out_of_range');
  assert.deepEqual(logic.validatePlan('xiaohongshu', 'scheduled', '2026-07-18T11:01', NOW), {
    ok: true,
    publishMode: 'scheduled',
    publishTime: Date.parse('2026-07-18T11:01:00+08:00'),
  });
});

test('列表与旧快照统一成审批详情形状', () => {
  assert.deepEqual(logic.normalizeDraft({
    id: 42,
    kind: 'rewrite',
    title: '标题',
    contentVersion: 3,
    publishMode: 'scheduled',
    publishTime: 123,
  }), {
    id: 42,
    recordId: 42,
    platform: 'xiaohongshu',
    kind: 'rewrite',
    title: '标题',
    content: '',
    topics: [],
    images: [],
    contentVersion: 3,
    updatedAt: 0,
    publishMode: 'scheduled',
    publishTime: 123,
  });
});
