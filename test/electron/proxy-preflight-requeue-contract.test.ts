import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 决策本身由 proxy-preflight.test.ts 的真单测锁住。这里锁的是**接线**：一个正确的决策函数
// 如果没有被调用、或者它的结论没有被执行，行为上等于这道闸不存在。两层缺一不可。

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');

function functionSource(name: string): string {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const end = main.indexOf('\nfunction ', start + 1);
  assert.ok(end > start, `missing function end for ${name}`);
  return main.slice(start, end);
}

test('预检确定失败走分流处置，不再直接终结本次启动', () => {
  const flow = functionSource('startAdsPowerFlow');
  assert.match(flow, /preflight\.state === 'unavailable'[\s\S]{0,240}?handleProxyPreflightFailure\(handle, preflight, generation\)/,
    '确定失败必须进分流；直接调 stopStartForProxyFailure 就是把可恢复失败判死');
  assert.doesNotMatch(flow, /stopStartForProxyFailure\(/,
    '启动流不得绕过分流直接终结');
  assert.match(flow, /resetProxyRequeueBudget\(handle\)/,
    '网络准备过关后必须归还上一轮用掉的重排预算');
});

test('分流消费决策函数的三条出口，不自己另写一套判据', () => {
  const dispatch = functionSource('handleProxyPreflightFailure');
  assert.match(dispatch, /decideProxyPreflightFailure\(/, '必须消费纯函数决策');
  assert.match(dispatch, /requeuesUsed:[\s\S]{0,60}?proxyRequeueStreak/, '必须把已用预算喂进决策');
  assert.match(dispatch, /terminal === 'exhausted'[\s\S]{0,80}?stopStartForProxyRetriesExhausted/,
    '预算耗尽必须走专用终局，措辞与配置类终局不同');
  assert.match(dispatch, /handle\.proxyRequeueStreak = decision\.attempt/, '重排必须记账，否则预算永不耗尽');
});

test('重排回调先作废旧结论再重新入队，且带完整取消闸', () => {
  const schedule = functionSource('scheduleProxyRequeue');
  const invalidateAt = schedule.indexOf('proxyPreflight.invalidate');
  const enqueueAt = schedule.indexOf('enqueueStartFlow');
  assert.ok(invalidateAt >= 0, '重排前必须作废旧结论，否则这一跳不会发出任何探测');
  assert.ok(enqueueAt > invalidateAt, '必须先作废再入队，顺序反了等于没作废');
  // 重排是「延迟重入既有入口」：走 enqueueStartFlow 才能继承并发计数闸与队尾语义。
  assert.doesNotMatch(schedule, /launchQueue\.enqueue|startEdge\(/,
    '重排不得新建旁路或直接起核心——那会绕过并发计数闸和槽位 FIFO');
  for (const gate of ['isCurrentLifecycleGeneration', 'stopRequested', 'removed', 'isQuitting', 'handle.child']) {
    assert.ok(schedule.includes(gate), `重排回调缺取消闸 ${gate}：可能把已被叫停的环境重新拉起来`);
  }
  assert.match(schedule, /clearEdgeFailurePatch\(handle\)/,
    '仍在自愈中 ⇒ 不得写终态失败摘要（提前宣告死亡）');
  assert.doesNotMatch(schedule, /edgeFailurePatch\(`|edge: 'stopped'/,
    '重排等待不是终态');
});

test('冷待机唤醒的退避重试在重探前作废旧结论', () => {
  const rearm = functionSource('rearmWakeRetry');
  const invalidateAt = rearm.indexOf('proxyPreflight.invalidate');
  const wakeAt = rearm.indexOf('wakeColdStandby(handle');
  assert.ok(invalidateAt >= 0,
    '不作废的话第一跳（60s）落在结论缓存有效期内，会复用正被重试的那个失败、一个探测都不发');
  assert.ok(wakeAt > invalidateAt, '必须先作废再唤醒');
});

test('换代次时在途重排一律作废', () => {
  const advance = functionSource('advanceLifecycleGeneration');
  assert.match(advance, /clearProxyRequeueTimer\(handle\)/,
    '暂停 / 停止 / 移出后，在途重排必须撤掉，绝不把已被叫停的环境重新拉起来');
});

test('用户显式启动清空机器用掉的重排预算', () => {
  const queueStart = functionSource('queueStartEnv');
  assert.match(queueStart, /resetProxyRequeueBudget\(handle\)/,
    '人的重试意图不该继承上一轮机器用掉的额度');
});
