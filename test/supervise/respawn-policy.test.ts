import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRespawn, type RespawnPolicyOptions } from '../../src/supervise/respawn-policy.js';

const OPTS: RespawnPolicyOptions = {
  maxConsecutiveFailures: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  healthyUptimeMs: 60_000,
};

test('关机优先：shuttingDown 时任意退出码都不重起（MAJOR⑤）', () => {
  const d = decideRespawn({ exitCode: 75, uptimeMs: 1_000, prevStreak: 0, shuttingDown: true }, OPTS);
  assert.equal(d.action, 'stop');
});

test('干净退出 code=0 → 不重起（节点诚实终止）', () => {
  const d = decideRespawn({ exitCode: 0, uptimeMs: 1_000, prevStreak: 0, shuttingDown: false }, OPTS);
  assert.equal(d.action, 'stop');
});

test('非零退出 → 重起 + 指数退避，连续失败累加', () => {
  const d1 = decideRespawn({ exitCode: 75, uptimeMs: 500, prevStreak: 0, shuttingDown: false }, OPTS);
  assert.equal(d1.action, 'respawn');
  assert.equal(d1.streak, 1);
  assert.equal(d1.delayMs, 1_000); // base * 2^0
  const d2 = decideRespawn({ exitCode: 75, uptimeMs: 500, prevStreak: 1, shuttingDown: false }, OPTS);
  assert.equal(d2.streak, 2);
  assert.equal(d2.delayMs, 2_000); // base * 2^1
});

test('退避封顶在 backoffMaxMs', () => {
  const d = decideRespawn({ exitCode: 1, uptimeMs: 100, prevStreak: 2, shuttingDown: false }, { ...OPTS, backoffMaxMs: 2_500 });
  assert.equal(d.streak, 3);
  assert.equal(d.delayMs, 2_500); // min(2500, 1000*2^2=4000)
});

test('连续失败超上限 → 诚实放弃（不再重起）', () => {
  const d = decideRespawn({ exitCode: 75, uptimeMs: 100, prevStreak: 3, shuttingDown: false }, OPTS);
  assert.equal(d.action, 'give-up');
  assert.equal(d.streak, 4);
});

test('健康存活达阈值 → 连续失败计数清零（慢失败击不穿，MAJOR⑥）', () => {
  // 之前已累计 3 次连续失败（濒临放弃），但这一轮健康存活了 ≥ healthyUptimeMs，
  // 故先清零，本次非零退出只算第 1 次 → respawn 而非 give-up。
  const d = decideRespawn({ exitCode: 75, uptimeMs: 90_000, prevStreak: 3, shuttingDown: false }, OPTS);
  assert.equal(d.action, 'respawn', '健康跑过一轮后应重置预算、继续重起而非放弃');
  assert.equal(d.streak, 1);
  assert.equal(d.delayMs, 1_000);
});

test('健康存活后干净退出 → stop 且计数清零', () => {
  const d = decideRespawn({ exitCode: 0, uptimeMs: 90_000, prevStreak: 2, shuttingDown: false }, OPTS);
  assert.equal(d.action, 'stop');
  assert.equal(d.streak, 0);
});

test('被信号杀（exitCode=null）按非零处理 → 重起', () => {
  const d = decideRespawn({ exitCode: null, uptimeMs: 100, prevStreak: 0, shuttingDown: false }, OPTS);
  assert.equal(d.action, 'respawn');
  assert.equal(d.streak, 1);
});
