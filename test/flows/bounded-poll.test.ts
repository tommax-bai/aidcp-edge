import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollBounded } from '../../src/flows/bounded-poll.js';

/**
 * 回归闸（memory: edge-poll-helpers-iteration-bounded）。
 * 桩环境里 clock 可能恒定、sleep 可能立即 resolve ⇒ 墙钟不是边界，迭代帽才是唯一护栏。
 * 这两条断言绝不真等墙钟：clock/sleep 全注入。
 */

const defaultCap = (timeoutMs: number, intervalMs: number): number =>
  Math.ceil(timeoutMs / Math.max(1, intervalMs)) + 2;

test('pollBounded: 恒定 clock + 立即 resolve 的 sleep + 恒 miss 的 probe ⇒ 迭代帽兜底返回 undefined（不死循环）', async () => {
  const timeoutMs = 200_000; // 200s 墙钟：桩环境下一秒都不真等
  const intervalMs = 500;
  const cap = defaultCap(timeoutMs, intervalMs); // 402
  let probeCalls = 0;
  let sleepCalls = 0;

  const hit = await pollBounded<true>({
    probe: async () => {
      probeCalls += 1;
      // 护栏的护栏：真死循环时让测试快速失败，而不是把 runner 挂死。
      if (probeCalls > cap + 50) throw new Error(`pollBounded 未受迭代帽约束：probe 已被调用 ${probeCalls} 次`);
      return undefined;
    },
    timeoutMs,
    intervalMs,
    clock: () => 1_000, // 恒定：clock() 永远小于 deadline ⇒ 墙钟闸永不触发
    sleep: async () => {
      sleepCalls += 1;
    }, // 立即 resolve ⇒ 每轮零耗时
  });

  assert.equal(hit, undefined, '恒 miss 必须返回 undefined（绝不假成功）');
  assert.ok(probeCalls > 0, 'probe 至少被调用一次');
  assert.ok(
    probeCalls <= cap,
    `probe 调用次数 ${probeCalls} 必须 ≤ 默认迭代帽 ceil(timeout/interval)+2 = ${cap}`,
  );
  assert.ok(sleepCalls <= probeCalls, 'sleep 次数不得超过 probe 次数（每轮至多睡一次）');
});

test('pollBounded: probe-first —— 预算一开始就已耗尽时，probe 仍 MUST 被调用至少 1 次', async () => {
  const timeoutMs = 15_000;
  let probeCalls = 0;
  let sleepCalls = 0;
  let onMissCalls = 0;

  // 第 1 次 clock() 用于算 deadline（= 0 + timeoutMs）；之后直接越过 deadline ⇒ 预算已耗尽。
  let clockCalls = 0;
  const clock = (): number => {
    clockCalls += 1;
    return clockCalls === 1 ? 0 : timeoutMs + 1;
  };

  const hit = await pollBounded<true>({
    probe: async () => {
      probeCalls += 1;
      return undefined;
    },
    onMiss: async () => {
      onMissCalls += 1;
    },
    timeoutMs,
    intervalMs: 500,
    clock,
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  assert.equal(hit, undefined, '预算耗尽且未命中 ⇒ undefined');
  assert.equal(
    probeCalls,
    1,
    '预算耗尽时也 MUST 至少校验过一次：改成「进循环先判死线」会静默退化成一次都不校验',
  );
  assert.equal(sleepCalls, 0, '预算已耗尽后不得再睡');
  assert.equal(onMissCalls, 0, '预算已耗尽后不得再发出带副作用的 onMiss 动作');
});

test('pollBounded: onMiss 只在「未命中且预算未尽」时发出，且排在 sleep 之前', async () => {
  const order: string[] = [];
  let probeCalls = 0;

  const hit = await pollBounded<true>({
    probe: async () => {
      probeCalls += 1;
      order.push('probe');
      return probeCalls >= 2 ? true : undefined; // 第 2 轮命中
    },
    onMiss: async () => {
      order.push('onMiss');
    },
    timeoutMs: 15_000,
    intervalMs: 500,
    clock: () => 0, // 预算全程未尽
    sleep: async () => {
      order.push('sleep');
    },
  });

  assert.equal(hit, true);
  assert.deepEqual(order, ['probe', 'onMiss', 'sleep', 'probe'], 'onMiss 只在 miss 后发出，且在 sleep 之前；命中那轮不再发 onMiss');
});
