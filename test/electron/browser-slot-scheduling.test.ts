import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fleet = require('../../src/electron/fleet.cjs');

// ---------------------------------------------------------------------------
// change browser-slot-scheduling：槽位池 + 串行启动队列
//
// 同机能同时开几个浏览器由内存顶死（每个 headful 环境约 700MB；AdsPower 本身不限并发）。
// 旧的错峰队列只保证「相邻开始间隔 ≥1.1s」——10 个环境仍会几乎同时冷启、把内存打爆。
// 这条队列是「起完一个再起下一个」。
// ---------------------------------------------------------------------------

test('槽位上限 = 可用内存 ÷ 单环境估值；override 优先；至少 1', () => {
  const MB = 1024 * 1024;
  assert.equal(fleet.resolveSlotCapacity({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB }), 10);
  assert.equal(fleet.resolveSlotCapacity({ freeBytes: 5000 * MB, perEnvBytes: 700 * MB }), 7);
  assert.equal(fleet.resolveSlotCapacity({ freeBytes: 100 * MB, perEnvBytes: 700 * MB }), 1, '0 槽位 = 整台机器停摆，绝不允许');
  assert.equal(fleet.resolveSlotCapacity({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB, override: 4 }), 4);
});

test('可设置账号数上限 = 2 × 槽位（1:2，用户定案）', () => {
  assert.equal(fleet.maxAccountsForSlots(10), 20);
  assert.equal(fleet.maxAccountsForSlots(8), 16);
});

test('单环境内存估值默认取实测口径 700MB（旧的 1GB 是没量过的设计缺省）', () => {
  assert.equal(fleet.PER_ENV_BYTES_DEFAULT, 700 * 1024 * 1024);
});

test('串行启动队列：起完一个再起下一个（绝不并发冷启）', async () => {
  const queue = fleet.createSerialLaunchQueue({ spacingMs: 0 });
  let concurrent = 0;
  let peak = 0;
  const order: string[] = [];
  const slowLaunch = (key: string) => async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    order.push(key);
    await new Promise((r) => setTimeout(r, 20));
    concurrent -= 1;
    return true;
  };

  const results = await Promise.all([
    queue.enqueue({ key: 'a', kind: 'resume', run: slowLaunch('a') }),
    queue.enqueue({ key: 'b', kind: 'resume', run: slowLaunch('b') }),
    queue.enqueue({ key: 'c', kind: 'resume', run: slowLaunch('c') }),
  ]);

  assert.equal(peak, 1, '任何时刻只有一个环境在启动');
  assert.deepEqual(order, ['a', 'b', 'c'], '同级 FIFO');
  assert.deepEqual(results.map((r: { ok: boolean }) => r.ok), [true, true, true]);
});

test('优先级：手动任务 > 带任务的唤醒 > 普通续场恢复', async () => {
  const queue = fleet.createSerialLaunchQueue({ spacingMs: 0 });
  const order: string[] = [];
  const run = (key: string) => async () => {
    order.push(key);
    await new Promise((r) => setTimeout(r, 5));
    return true;
  };

  // 先塞一个占住队列，后面三个才会真正参与排序。
  const head = queue.enqueue({ key: 'head', kind: 'resume', run: run('head') });
  const rest = Promise.all([
    queue.enqueue({ key: 'resume-1', kind: 'resume', run: run('resume-1') }),
    queue.enqueue({ key: 'manual-1', kind: 'manual', run: run('manual-1') }),
    queue.enqueue({ key: 'task-1', kind: 'task', run: run('task-1') }),
  ]);
  await Promise.all([head, rest]);

  assert.deepEqual(order, ['head', 'manual-1', 'task-1', 'resume-1']);
});

test('一个环境启动失败绝不阻塞队列里其余环境', async () => {
  const queue = fleet.createSerialLaunchQueue({ spacingMs: 0 });
  const done: string[] = [];
  const results = await Promise.all([
    queue.enqueue({
      key: 'boom',
      kind: 'resume',
      run: async () => {
        throw new Error('分身未登录');
      },
    }),
    queue.enqueue({
      key: 'ok',
      kind: 'resume',
      run: async () => {
        done.push('ok');
        return true;
      },
    }),
  ]);

  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /分身未登录/, '如实带出失败原因');
  assert.equal(results[1].ok, true);
  assert.deepEqual(done, ['ok'], '后一个照常启动');
});

test('排队等待计入唤醒死线：轮到它时已超死线 → 立刻诚实失败，绝不再启动一个没人等的浏览器', async () => {
  let clock = 0;
  const queue = fleet.createSerialLaunchQueue({
    spacingMs: 0,
    now: () => clock,
    sleep: async () => {},
  });
  let launched = 0;

  const first = queue.enqueue({
    key: 'slow',
    kind: 'resume',
    run: async () => {
      launched += 1;
      clock += 200_000; // 这一个起了很久，把后面那个的死线耗过去了
      return true;
    },
  });
  const second = queue.enqueue({
    key: 'expired',
    kind: 'task',
    deadlineAt: 180_000, // 180s 唤醒死线
    run: async () => {
      launched += 1;
      return true;
    },
  });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'deadline_exceeded');
  assert.equal(launched, 1, '超死线的那个绝不启动——它会白占一个槽位，而且早已没人在等它了');
});
