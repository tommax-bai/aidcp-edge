import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForLoginIdentity,
  resolveStartupIdentity,
  type SelfIdentity,
  type SelfIdentityResult,
  type IdentityDecision,
  type LoginWaitResult,
} from '../../src/cdp/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

// change adspower-first-login-wait-gate 回归：启动期有界等待登录门 + 诚实停手真退出编排。

const REAL_ID = '63e2ff0500000000260049ce'; // 24 位 hex，真机形态
const DUMMY_CDP = {} as unknown as BrowseCdp; // 就地重读被注入桩替换，cdp 不被真正使用
const okRes = (accountId = REAL_ID): SelfIdentityResult => ({
  ok: true,
  identity: { accountId, displayName: null, redId: null, source: 'in-place' },
});
const failRes = (): SelfIdentityResult => ({ ok: false, reason: '就地读不出稳定 id' });
const immediateSleep = async () => {};

// ---- waitForLoginIdentity ----

test('waitForLoginIdentity: 就地重读读出真 id → identified', async () => {
  let calls = 0;
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 10_000,
    intervalMs: 100,
    interruptPollMs: 100,
    sleep: immediateSleep,
    now: () => 1000,
    readIdentity: async () => {
      calls += 1;
      return calls >= 3 ? okRes() : failRes(); // 第 3 次读出
    },
  });
  assert.equal(res.kind, 'identified');
  assert.equal(res.kind === 'identified' && res.identity.accountId, REAL_ID);
  assert.equal(calls, 3);
});

test('waitForLoginIdentity: 始终读不出 → timeout（有界、不 hang）', async () => {
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 1000,
    intervalMs: 100,
    interruptPollMs: 100,
    sleep: immediateSleep,
    now: () => 1000,
    readIdentity: async () => failRes(),
  });
  assert.equal(res.kind, 'timeout');
});

test('waitForLoginIdentity: 等待期收到中断 → interrupted（带原因）', async () => {
  let ticks = 0;
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 10_000,
    intervalMs: 100,
    interruptPollMs: 100,
    sleep: immediateSleep,
    now: () => 1000,
    readIdentity: async () => failRes(),
    pollInterrupt: () => {
      ticks += 1;
      return ticks >= 3 ? 'close' : null; // 第 3 tick 到达关闭意图
    },
  });
  assert.equal(res.kind, 'interrupted');
  assert.equal(res.kind === 'interrupted' && res.reason, 'close');
});

test('waitForLoginIdentity: 明确人工登录态无超时并在原地读出身份', async () => {
  let reads = 0;
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 0,
    unbounded: true,
    intervalMs: 1,
    interruptPollMs: 1,
    sleep: immediateSleep,
    readIdentity: async () => {
      reads += 1;
      return reads === 3 ? okRes() : failRes();
    },
  });
  assert.equal(res.kind, 'identified');
  assert.equal(reads, 3);
});

test('waitForLoginIdentity: 每个读身份拍点前串行运行认证协调拍点', async () => {
  const order: string[] = [];
  let reads = 0;
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 0,
    unbounded: true,
    intervalMs: 1,
    interruptPollMs: 1,
    sleep: immediateSleep,
    beforeIdentityRead: async () => {
      order.push('auth');
      return { kind: 'continue' };
    },
    readIdentity: async () => {
      order.push('identity');
      reads += 1;
      return reads === 2 ? okRes() : failRes();
    },
  });
  assert.equal(res.kind, 'identified');
  assert.deepEqual(order, ['auth', 'identity', 'auth', 'identity']);
});

test('waitForLoginIdentity: 登录后页面未稳定时 defer 身份读取，清除后才接纳身份', async () => {
  const order: string[] = [];
  let authPasses = 0;
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 10_000,
    intervalMs: 1,
    interruptPollMs: 1,
    sleep: immediateSleep,
    beforeIdentityRead: async () => {
      authPasses += 1;
      order.push('auth');
      return authPasses < 3 ? { kind: 'defer' } : { kind: 'continue' };
    },
    readIdentity: async () => {
      order.push('identity');
      return okRes();
    },
  });

  assert.equal(res.kind, 'identified');
  assert.deepEqual(order, ['auth', 'auth', 'auth', 'identity']);
});

test('waitForLoginIdentity: 生命周期中断先于认证协调拍点', async () => {
  let authPasses = 0;
  let identityReads = 0;
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 10_000,
    intervalMs: 1,
    interruptPollMs: 1,
    sleep: immediateSleep,
    pollInterrupt: () => 'pause',
    beforeIdentityRead: async () => {
      authPasses += 1;
      return { kind: 'continue' };
    },
    readIdentity: async () => {
      identityReads += 1;
      return failRes();
    },
  });
  assert.deepEqual(res, { kind: 'interrupted', reason: 'pause' });
  assert.equal(authPasses, 0);
  assert.equal(identityReads, 0);
});

test('waitForLoginIdentity: 认证协调拍点失败时安全停手且不读身份', async () => {
  let identityReads = 0;
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 10_000,
    intervalMs: 1,
    interruptPollMs: 1,
    sleep: immediateSleep,
    beforeIdentityRead: async () => ({ kind: 'failed', reason: 'fresh_start_policy_unavailable' }),
    readIdentity: async () => {
      identityReads += 1;
      return okRes();
    },
  });
  assert.deepEqual(res, { kind: 'failed', reason: 'fresh_start_policy_unavailable' });
  assert.equal(identityReads, 0);
});

test('waitForLoginIdentity: 恒定假时钟 + 桩 sleep 不死循环/不 RangeError（迭代上界）', async () => {
  // now 恒定：若循环靠 now() 前进判超时会死循环。断言仍有界返回 timeout（锁死 edge-poll-helpers-iteration-bounded 坑）。
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 300_000, // 5min 预算
    intervalMs: 5000,
    interruptPollMs: 500,
    sleep: immediateSleep,
    now: () => 42, // 恒定
    readIdentity: async () => failRes(),
  });
  assert.equal(res.kind, 'timeout');
});

test('waitForLoginIdentity: 读按 intervalMs 稀疏、中断按 interruptPollMs 密（不 hammer CDP）', async () => {
  let reads = 0;
  let interruptPolls = 0;
  const res = await waitForLoginIdentity(DUMMY_CDP, {
    timeoutMs: 5000,
    intervalMs: 5000, // 读间隔 = 预算量级
    interruptPollMs: 500, // 中断轮询密 10x
    sleep: immediateSleep,
    now: () => 1000,
    readIdentity: async () => {
      reads += 1;
      return failRes();
    },
    pollInterrupt: () => {
      interruptPolls += 1;
      return null;
    },
  });
  assert.equal(res.kind, 'timeout');
  // 读远少于中断轮询次数（读每 10 tick 一次）。
  assert.ok(reads < interruptPolls, `reads(${reads}) 应远少于 interruptPolls(${interruptPolls})`);
  assert.ok(reads <= 3, `读应稀疏（<=3），实际 ${reads}`);
});

// ---- resolveStartupIdentity ----

const HALT: IdentityDecision = { kind: 'halt', reason: '就地读不出稳定 id' };
const USE: IdentityDecision = { kind: 'use', accountId: REAL_ID, source: 'in-place' };
const identifiedWait = (): Promise<LoginWaitResult> =>
  Promise.resolve({ kind: 'identified', identity: { accountId: REAL_ID, displayName: null, redId: null, source: 'in-place' } as SelfIdentity });
const decideUse = (r: SelfIdentityResult): IdentityDecision =>
  r.ok ? { kind: 'use', accountId: r.identity.accountId, source: 'in-place' } : HALT;

test('resolveStartupIdentity: adspower + halt + 等待开 + 读出 → proceed（且调用了等待门）', async () => {
  let waited = 0;
  const action = await resolveStartupIdentity({
    providerKind: 'adspower',
    initialDecision: HALT,
    override: undefined,
    loginWaitMs: 300_000,
    waitForLogin: () => {
      waited += 1;
      return identifiedWait();
    },
    decideIdentity: decideUse,
  });
  assert.equal(action.kind, 'proceed');
  assert.equal(action.kind === 'proceed' && action.decision.accountId, REAL_ID);
  assert.equal(waited, 1);
});

test('resolveStartupIdentity: adspower + halt + 等待超时 → terminate 干净停止码 0（不自动重起）', async () => {
  const action = await resolveStartupIdentity({
    providerKind: 'adspower',
    initialDecision: HALT,
    override: undefined,
    loginWaitMs: 300_000,
    waitForLogin: () => Promise.resolve({ kind: 'timeout' }),
    decideIdentity: decideUse,
  });
  assert.equal(action.kind, 'terminate');
  assert.equal(action.kind === 'terminate' && action.code, 0);
  assert.equal(action.kind === 'terminate' && action.reason, 'login_wait_timeout');
});

test('resolveStartupIdentity: adspower + halt + 等待中断 → terminate 干净停止码 0', async () => {
  const action = await resolveStartupIdentity({
    providerKind: 'adspower',
    initialDecision: HALT,
    override: undefined,
    loginWaitMs: 300_000,
    waitForLogin: () => Promise.resolve({ kind: 'interrupted', reason: 'close' }),
    decideIdentity: decideUse,
  });
  assert.equal(action.kind, 'terminate');
  assert.equal(action.kind === 'terminate' && action.code, 0);
  assert.equal(action.kind === 'terminate' && action.reason, 'interrupted:close');
});

test('resolveStartupIdentity: 人工等待认证协调失败 → terminate 码1且保留失败原因', async () => {
  const action = await resolveStartupIdentity({
    providerKind: 'adspower',
    initialDecision: HALT,
    override: undefined,
    loginWaitMs: 300_000,
    waitForLogin: () => Promise.resolve({ kind: 'failed', reason: 'fresh_start_policy_unavailable' }),
    decideIdentity: decideUse,
  });
  assert.deepEqual(action, {
    kind: 'terminate',
    code: 1,
    reason: 'login_wait_failed:fresh_start_policy_unavailable',
  });
});

test('resolveStartupIdentity: adspower + halt + 等待门关闭(0) → terminate 码1、绝不进等待（关等待仍走真退出）', async () => {
  let waited = 0;
  const action = await resolveStartupIdentity({
    providerKind: 'adspower',
    initialDecision: HALT,
    override: undefined,
    loginWaitMs: 0, // 关等待门
    waitForLogin: () => {
      waited += 1;
      return identifiedWait();
    },
    decideIdentity: decideUse,
  });
  assert.equal(action.kind, 'terminate');
  assert.equal(action.kind === 'terminate' && action.code, 1);
  assert.equal(waited, 0); // 门关时绝不进等待
});

test('resolveStartupIdentity: self + halt → terminate 码1、不进等待门（门严格限 adspower）', async () => {
  let waited = 0;
  const action = await resolveStartupIdentity({
    providerKind: 'self',
    initialDecision: HALT,
    override: undefined,
    loginWaitMs: 300_000,
    waitForLogin: () => {
      waited += 1;
      return identifiedWait();
    },
    decideIdentity: decideUse,
  });
  assert.equal(action.kind, 'terminate');
  assert.equal(action.kind === 'terminate' && action.code, 1);
  assert.equal(waited, 0);
});

test('resolveStartupIdentity: 首读成功(use) → proceed、不进等待（读出即走）', async () => {
  let waited = 0;
  const action = await resolveStartupIdentity({
    providerKind: 'adspower',
    initialDecision: USE,
    override: undefined,
    loginWaitMs: 300_000,
    waitForLogin: () => {
      waited += 1;
      return identifiedWait();
    },
    decideIdentity: decideUse,
  });
  assert.equal(action.kind, 'proceed');
  assert.equal(waited, 0);
});

test('resolveStartupIdentity: override 逃生阀(use-override-after-read-fail) → proceed、不进等待', async () => {
  let waited = 0;
  const action = await resolveStartupIdentity({
    providerKind: 'adspower',
    initialDecision: { kind: 'use-override-after-read-fail', accountId: REAL_ID, reason: 'read fail' },
    override: REAL_ID,
    loginWaitMs: 300_000,
    waitForLogin: () => {
      waited += 1;
      return identifiedWait();
    },
    decideIdentity: decideUse,
  });
  assert.equal(action.kind, 'proceed');
  assert.equal(waited, 0);
});

test('resolveStartupIdentity: 等待读出但 decideIdentity 仍判 halt(异常) → terminate 码1', async () => {
  const action = await resolveStartupIdentity({
    providerKind: 'adspower',
    initialDecision: HALT,
    override: undefined,
    loginWaitMs: 300_000,
    waitForLogin: () => identifiedWait(),
    decideIdentity: () => HALT, // 反常：读出的身份仍被判 halt
  });
  assert.equal(action.kind, 'terminate');
  assert.equal(action.kind === 'terminate' && action.code, 1);
  assert.equal(action.kind === 'terminate' && action.reason, 'post_wait_halt');
});

test('resolveStartupIdentity 反僵尸不变量：任何 halt 首读都不产 proceed（必走 terminate 真退出）', async () => {
  const providers = ['adspower', 'self'];
  const waitOutcomes: LoginWaitResult[] = [{ kind: 'timeout' }, { kind: 'interrupted', reason: 'pause' }];
  const waitMs = [0, 300_000];
  for (const providerKind of providers) {
    for (const wm of waitMs) {
      for (const outcome of waitOutcomes) {
        const action = await resolveStartupIdentity({
          providerKind,
          initialDecision: HALT,
          override: undefined,
          loginWaitMs: wm,
          waitForLogin: () => Promise.resolve(outcome),
          decideIdentity: decideUse,
        });
        // halt 永不静默 proceed（那会退化成握手无身份/或 bare-return 挂僵尸）——必显式 terminate。
        assert.equal(action.kind, 'terminate', `provider=${providerKind} waitMs=${wm} outcome=${outcome.kind}`);
      }
    }
  }
});
