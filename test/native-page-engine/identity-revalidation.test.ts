/**
 * 运行期身份持续校验与身份重立链（change restore-native-xiaohongshu-session-guards §5 + 1.9①）。
 *
 * 只在启动与冷待机唤醒各读一次身份**不算**满足：长跑会话中途换号 / 掉登录会一秒都发现不了，
 * 之后的全部记账都挂在错账号上。本组用例钉住七条不变量：
 *   T1 分域四态一张表（不误杀、不假愈）
 *   T2 防抖阈值 + 中途恢复即清零
 *   T3 跨页计数污染（创作页穿插必须清零；unknown 跳过后仍能正常判定）
 *   T4 只 emit 一次 + rebaseline 复位
 *   T5 正向登出探针三分支（含本次新增的**新鲜度守卫**：陈旧读数绝不压成「真登出」）
 *   T6 重立链顺序（硬约束 A：在途发布诚实判失败早于断开云端）
 *   T7 halt 纯返回（硬约束 B：归位后仍读不出 ⇒ 停在无身份态，绝不回落默认账号）
 *   T14 判失效之后**这一局怎么收口**（作废 / halt / 链条自身异常三态各有归宿，绝不压成一态）
 * 外加一条**弱断言**（源码文本扫描）覆盖 1.9① 的宿主侧接线，见文件末尾的说明。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  IdentityRevalidator,
  applyWakeIdentityResettlement,
  automationResumeCallback,
  createIdentityReestablishment,
  AUTOMATION_STALLED_HALT_PHRASE,
  judgeAutomationResume,
  judgeRuntimeIdentity,
  judgeWakeIdentityResettlement,
  observedAccountIdFromDecision,
  reestablishIdentityReadOptions,
  refuseWakeUnderIdentityGate,
  resumeAutomationUnderIdentityGate,
  PERIODIC_IDENTITY_READ_HYDRATE_MS,
  REESTABLISH_IDENTITY_READ_HYDRATE_MS,
  type IdentityHealth,
  type IdentityInvalidReason,
  type IdentityPageContext,
  type IdentityReestablishmentOutcome,
  type ObservationLiveness,
  type WakeIdentityResettlementDeps,
} from '../../src/native-page-engine/identity-guard.js';
import type {
  IdentityDecision,
  ReadSelfIdentityOptions,
  SelfIdentityResult,
} from '../../src/cdp/self-identity.js';
import { facebookPlatformDriver, classifyFacebookIdentityContext } from '../../src/facebook/driver.js';
import { xhsPlatformDriver } from '../../src/xhs/driver.js';
import { CoreLifecycleController } from '../../src/client/core-lifecycle.js';
import {
  RUNTIME_POSTURE_IPC_TYPE,
  RUNTIME_POSTURE_KINDS,
  deliverLifecycleIpc,
  publishPostureWithFallback,
  runtimePostureIpc,
  type RuntimePosture,
} from '../../src/client/runtime-posture.js';
import {
  guardCommandsUnderIdentity,
  guardPublishCommandsUnderIdentity,
  judgeCloudRebindUnderIdentity,
  judgeCommandUnderIdentity,
  rebindCloudUnderIdentityGate,
  EDGE_TASK_LANE,
  NATIVE_COMMAND_LANE,
  type IdentityCommandGateDeps,
} from '../../src/client/identity-command-gate.js';

const OBSERVATION_INTERVAL_MS = 2_000;

function identified(accountId: string): SelfIdentityResult {
  return { ok: true, identity: { accountId, displayName: null, redId: null, source: 'in-place' } };
}
const NO_ANCHOR: SelfIdentityResult = { ok: false, reason: '就地扫描读不出本人锚点' };

/** 周期阻断观测读数。默认「新鲜且无登录墙」。 */
function liveness(over: Partial<ObservationLiveness> = {}): ObservationLiveness {
  return {
    running: true,
    suspended: false,
    blockingKind: 'none',
    consecutiveProbeFailures: 0,
    msSinceLastOkProbe: 500,
    ...over,
  };
}

interface GuardHarness {
  guard: IdentityRevalidator;
  logs: string[];
  invalidated: IdentityInvalidReason[];
}

function harness(setup: {
  baseline?: string;
  threshold?: number;
  /** 按调用序返回页面上下文；用完最后一个则一直复用它。 */
  contexts: IdentityPageContext[];
  /** 按调用序返回就地读身份结果；用完最后一个则一直复用它。 */
  identities?: (SelfIdentityResult | Error)[];
  observation?: () => ObservationLiveness | undefined;
  /** 在 readPageContext 返回前挂住（模拟「在途 check」），用于取消点用例。 */
  contextGate?: () => Promise<void>;
}): GuardHarness {
  const logs: string[] = [];
  const invalidated: IdentityInvalidReason[] = [];
  let ctxIdx = 0;
  let idIdx = 0;
  const guard = new IdentityRevalidator(setup.baseline ?? 'acct-A', {
    threshold: setup.threshold ?? 2,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    logger: (m) => logs.push(m),
    // 单测直接驱动 check()：定时器只登记、不真的跑，免得引入时钟依赖。
    setTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
    clearTimer: () => undefined,
    readPageContext: async () => {
      if (setup.contextGate) await setup.contextGate();
      return setup.contexts[Math.min(ctxIdx++, setup.contexts.length - 1)]!;
    },
    readIdentity: async () => {
      const list = setup.identities ?? [identified('acct-A')];
      const next = list[Math.min(idIdx++, list.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
    observationStatus: setup.observation ?? (() => liveness()),
  });
  guard.start((reason) => invalidated.push(reason));
  return { guard, logs, invalidated };
}

// ── T1：分域四态一张表 ─────────────────────────────────────────────────────────

test('T1 分域四态：creator-app 判健康清零、creator-login 计一次、unknown 既不增也不清、consumer 读出基线判健康', async () => {
  // creator-app：创作平台真实页自带登录门禁，能停在这＝已登录。
  const creatorApp = harness({ contexts: ['creator-app'] });
  await creatorApp.guard.check();
  assert.equal(creatorApp.guard.consecutiveFailures, 0);
  assert.equal(creatorApp.guard.health, 'healthy');
  assert.deepEqual(creatorApp.invalidated, []);

  // creator-login：创作子域被重定向到 /login = 确凿登出，进计数（阈值 2，尚未到）。
  const creatorLogin = harness({ contexts: ['creator-login'] });
  await creatorLogin.guard.check();
  assert.equal(creatorLogin.guard.consecutiveFailures, 1);
  assert.deepEqual(creatorLogin.invalidated, []);

  // unknown：本轮跳过——既不计失效（误杀）也不判健康（假愈）。先垫一次 creator-login 把计数抬到 1。
  const unknown = harness({ contexts: ['creator-login', 'unknown'] });
  await unknown.guard.check();
  assert.equal(unknown.guard.consecutiveFailures, 1);
  await unknown.guard.check();
  assert.equal(unknown.guard.consecutiveFailures, 1, 'unknown 那一轮 MUST NOT 计数，也 MUST NOT 清零');
  assert.equal(unknown.guard.health, 'healthy');
  assert.ok(unknown.logs.some((l) => l.includes('无法确认，本轮跳过')), 'unknown 必须留下可观测日志');

  // consumer + 读出基线：健康 + 清零。
  const consumer = harness({
    contexts: ['creator-login', 'consumer'],
    identities: [identified('acct-A')],
  });
  await consumer.guard.check();
  assert.equal(consumer.guard.consecutiveFailures, 1);
  await consumer.guard.check();
  assert.equal(consumer.guard.consecutiveFailures, 0);
  assert.equal(consumer.guard.health, 'healthy');
});

// ── T2：防抖阈值 + 中途恢复清零 ───────────────────────────────────────────────

test('T2 换号连续达阈值才判失效；中途读回基线即清零、绝不误触发', async () => {
  const flipped = harness({
    contexts: ['consumer'],
    identities: [identified('acct-B')],
  });
  await flipped.guard.check();
  assert.deepEqual(flipped.invalidated, [], '第 1 次只计数，绝不当场判失效');
  await flipped.guard.check();
  assert.deepEqual(flipped.invalidated, [{ kind: 'changed', newId: 'acct-B' }]);
  // 判失效 ≠ 终局：球交给了重立链，终局由链条回执定（见 T14）。这一格 MUST NOT 是 'invalid'——
  // 那会把「链条被叫停作废」与「链条跑完结论是停手」压成一态，前者随后就永久哑火了。
  assert.equal(flipped.guard.health, 'reestablishing');
  assert.deepEqual(flipped.guard.lastReason, { kind: 'changed', newId: 'acct-B' });

  // 中途恢复基线：计数清零，再读到新 id 只重新从 1 起算，不该被前一次凑够阈值。
  const flaky = harness({
    contexts: ['consumer'],
    identities: [identified('acct-B'), identified('acct-A'), identified('acct-B')],
  });
  await flaky.guard.check();
  await flaky.guard.check();
  assert.equal(flaky.guard.consecutiveFailures, 0, '读回基线必须清零');
  await flaky.guard.check();
  assert.equal(flaky.guard.consecutiveFailures, 1);
  assert.deepEqual(flaky.invalidated, [], '一次瞬时读到新 id 不得判失效');
});

// ── T3：跨页计数污染 ─────────────────────────────────────────────────────────

test('T3 创作发布页穿插在两次消费页失效之间必须清零；unknown 跳过后回消费页仍能正常判定', async () => {
  // 发布把标签页带到创作子域：不清零就会跨页凑够阈值、把健康账号误杀。
  const crossPage = harness({
    contexts: ['consumer', 'creator-app', 'consumer'],
    identities: [NO_ANCHOR],
    observation: () => liveness({ blockingKind: 'login' }),
  });
  await crossPage.guard.check();
  assert.equal(crossPage.guard.consecutiveFailures, 1);
  await crossPage.guard.check();
  assert.equal(crossPage.guard.consecutiveFailures, 0, '创作页那一轮必须清零');
  await crossPage.guard.check();
  assert.equal(crossPage.guard.consecutiveFailures, 1, '不得跨页凑够阈值');
  assert.deepEqual(crossPage.invalidated, []);

  // unknown 只是跳过一轮，不该破坏后续判定：回到消费页立刻续上，第 2 次消费页失效即达阈值。
  const skipped = harness({
    contexts: ['consumer', 'unknown', 'consumer'],
    identities: [NO_ANCHOR],
    observation: () => liveness({ blockingKind: 'login' }),
  });
  await skipped.guard.check();
  await skipped.guard.check();
  assert.equal(skipped.guard.consecutiveFailures, 1);
  await skipped.guard.check();
  assert.deepEqual(skipped.invalidated, [{ kind: 'lost' }]);
});

// ── T4：只 emit 一次 + rebaseline 复位 ────────────────────────────────────────

test('T4 判失效后重复校验不再 emit；rebaseline 后复位健康并按新基线判定', async () => {
  const h = harness({
    contexts: ['consumer'],
    identities: [identified('acct-B')],
  });
  await h.guard.check();
  await h.guard.check();
  assert.equal(h.invalidated.length, 1);
  await h.guard.check();
  await h.guard.check();
  assert.equal(h.invalidated.length, 1, '已判失效后 MUST NOT 重复 emit');

  h.guard.rebaseline('acct-B');
  assert.equal(h.guard.health, 'healthy');
  assert.equal(h.guard.consecutiveFailures, 0);
  assert.equal(h.guard.baseline, 'acct-B');
  assert.equal(h.guard.lastReason, null);
  await h.guard.check();
  assert.equal(h.guard.consecutiveFailures, 0, 'rebaseline 后读到新基线即健康');
  assert.equal(h.invalidated.length, 1);
});

// ── T5：正向登出探针三分支 + 新鲜度守卫 ──────────────────────────────────────

test('T5 正向登出探针：新鲜登录墙才判登出；无登录墙、暂停、从未探测过、读数陈旧一律跳过', async () => {
  const noAnchor = { contexts: ['consumer'] as IdentityPageContext[], identities: [NO_ANCHOR] };

  // 肯定分支：读数新鲜且看见登录墙 → 判 lost。
  const loggedOut = harness({ ...noAnchor, observation: () => liveness({ blockingKind: 'login' }) });
  assert.equal(loggedOut.guard.probeLogout().verdict, 'logged_out');
  await loggedOut.guard.check();
  assert.equal(loggedOut.guard.consecutiveFailures, 1);

  // 否定分支：读数新鲜但没有登录墙 → 疑似无侧栏页 / 弹层态，跳过。
  const noWall = harness({ ...noAnchor, observation: () => liveness({ blockingKind: 'none' }) });
  assert.equal(noWall.guard.probeLogout().verdict, 'not_logged_out');
  await noWall.guard.check();
  assert.equal(noWall.guard.consecutiveFailures, 0);
  assert.ok(noWall.logs.some((l) => l.includes('not_logged_out')));

  // ── 以下三条是本次新增的**新鲜度守卫**：读数不可信时绝不判登出 ──
  // 三条都把 blockingKind 摆成 'login'：只有守卫真的生效，才不会被这个陈旧的「登录墙」骗去判失效。

  // 观测已暂停（执行器故障 / 冷待机）：读数停在最后一次结论上，不可采信。
  const suspended = harness({
    ...noAnchor,
    observation: () => liveness({ suspended: true, blockingKind: 'login' }),
  });
  assert.equal(suspended.guard.probeLogout().verdict, 'unconfirmable');
  await suspended.guard.check();
  assert.equal(suspended.guard.consecutiveFailures, 0, '观测暂停期间 MUST NOT 判登出');

  // 一次都没成功探测过：与「探测成功但没看到情况」是两态。
  const neverProbed = harness({
    ...noAnchor,
    observation: () => liveness({ msSinceLastOkProbe: undefined, blockingKind: 'login' }),
  });
  assert.equal(neverProbed.guard.probeLogout().verdict, 'unconfirmable');
  await neverProbed.guard.check();
  assert.equal(neverProbed.guard.consecutiveFailures, 0, '从未成功探测过 MUST NOT 判登出');

  // 读数陈旧（超过 3 × 观测节拍）：sticky 缓存里的 login 可能是几分钟前的结论。
  const stale = harness({
    ...noAnchor,
    observation: () => liveness({
      msSinceLastOkProbe: OBSERVATION_INTERVAL_MS * 3 + 1,
      consecutiveProbeFailures: 9,
      blockingKind: 'login',
    }),
  });
  assert.equal(stale.guard.probeLogout().verdict, 'unconfirmable');
  await stale.guard.check();
  await stale.guard.check();
  await stale.guard.check();
  assert.equal(stale.guard.consecutiveFailures, 0, '陈旧读数 MUST NOT 被压成「真登出」');
  assert.deepEqual(stale.invalidated, []);
  assert.ok(
    stale.logs.some((l) => l.includes('无法确认') && l.includes('漏判')),
    '连续无法确认必须打一条存活告警（只告警、不升级为失效）',
  );

  // 观测体尚未装配同样按「无法确认」处置，绝不按登出计（退役实现的缺省是 `=> true`，此处显式偏离）。
  const noObservation = harness({ ...noAnchor, observation: () => undefined });
  assert.equal(noObservation.guard.probeLogout().verdict, 'unconfirmable');
  await noObservation.guard.check();
  assert.equal(noObservation.guard.consecutiveFailures, 0);
});

// ── T6 / T7：身份重立链 ──────────────────────────────────────────────────────

function chain(over: {
  decision?: IdentityDecision;
  hasActiveLease?: boolean;
  navigateThrows?: boolean;
  idRes?: SelfIdentityResult;
  /** 某一步之后宿主叫停一次：模拟暂停 / 冷待机 / 停用在链条中途到来。 */
  bumpGenerationAfter?: string;
  /** 第 N 次读代际之后叫停：模拟叫停正好落在「链条取基线」与「第一个取消点」之间。 */
  bumpGenerationOnNthRead?: number;
  connectCloudThrows?: boolean;
  rebaseline?: (accountId: string) => void;
} = {}) {
  const seq: string[] = [];
  const logs: string[] = [];
  const halts: string[] = [];
  const restored: string[] = [];
  const postures: RuntimePosture[] = [];
  const readOpts: ReadSelfIdentityOptions[] = [];
  const rebaselined: string[] = [];
  const state = { accountId: 'acct-A', nickname: undefined as string | undefined };
  let generation = 0;
  let generationReads = 0;
  const step = (name: string): void => {
    seq.push(name);
    if (over.bumpGenerationAfter === name) generation += 1;
  };
  const run = createIdentityReestablishment({
    logger: (m) => logs.push(m),
    suspendObservation: () => step('suspendObservation'),
    stopBrowse: async () => step('stopBrowse'),
    failInFlightPublishesHonestly: () => step('failInFlightPublishesHonestly'),
    hasActiveLease: () => over.hasActiveLease ?? false,
    resetTaskCoordinator: () => step('resetTaskCoordinator'),
    disconnectCloud: async () => step('disconnectCloud'),
    navigateToConsumerHome: async () => {
      step('navigateToConsumerHome');
      if (over.navigateThrows) throw new Error('Page.navigate 失败');
    },
    readIdentity: async (options) => {
      readOpts.push(options);
      step('readIdentity');
      return over.idRes ?? identified('acct-B');
    },
    decideIdentity: () => over.decision ?? { kind: 'use', accountId: 'acct-B', source: 'in-place' },
    nicknameFor: () => 'nick-B',
    applyIdentity: (accountId, nickname) => {
      step('applyIdentity');
      state.accountId = accountId;
      state.nickname = nickname;
    },
    connectCloud: async () => {
      step('connectCloud');
      if (over.connectCloudThrows) throw new Error('云端不可达');
    },
    rebaseline: (accountId) => {
      step('rebaseline');
      rebaselined.push(accountId);
      over.rebaseline?.(accountId);
    },
    resumeObservation: () => step('resumeObservation'),
    startBrowse: () => step('startBrowse'),
    generation: () => {
      generationReads += 1;
      const current = generation;
      if (over.bumpGenerationOnNthRead === generationReads) generation += 1;
      return current;
    },
    reportPosture: (posture) => {
      postures.push(posture);
      if (posture.kind === 'identity_halted') halts.push(posture.reason);
      if (posture.kind === 'healthy' && posture.accountId) restored.push(posture.accountId);
    },
  });
  return { run, seq, state, logs, halts, restored, postures, readOpts, rebaselined };
}

test('T6 重立链顺序：在途发布诚实判失败严格早于断开云端；成功路径按全序收口', async () => {
  const c = chain();
  const outcome = await c.run({ kind: 'changed', newId: 'acct-B' });

  assert.deepEqual(outcome, { kind: 'reestablished', accountId: 'acct-B' });
  assert.deepEqual(c.seq, [
    'suspendObservation',
    'stopBrowse',
    'failInFlightPublishesHonestly',
    'disconnectCloud',
    'navigateToConsumerHome',
    'readIdentity',
    'applyIdentity',
    'connectCloud',
    'rebaseline',
    'resumeObservation',
    'startBrowse',
  ]);
  // 硬约束 A 单独再钉一次：断连之后 send 只能 best-effort 失败，云端会无限期挂起等结果。
  assert.ok(
    c.seq.indexOf('failInFlightPublishesHonestly') < c.seq.indexOf('disconnectCloud'),
    '在途发布诚实判失败 MUST 早于断开云端连接',
  );
  // 硬约束 B 前半：先归位再读。
  assert.ok(c.seq.indexOf('navigateToConsumerHome') < c.seq.indexOf('readIdentity'));
  assert.equal(c.state.accountId, 'acct-B');
  assert.equal(c.state.nickname, 'nick-B');

  // 归位导航失败不中断链条（与退役实现同：退回原地读，不更坏）。
  const navFailed = chain({ navigateThrows: true });
  assert.deepEqual((await navFailed.run({ kind: 'lost' })), { kind: 'reestablished', accountId: 'acct-B' });
  assert.ok(navFailed.seq.indexOf('readIdentity') > navFailed.seq.indexOf('navigateToConsumerHome'));

  // 身份翻转时仍有活跃租约：当场中止租约后照走，绝不静默等租约结束（那会让翻转无限期不生效）。
  const leased = chain({ hasActiveLease: true });
  await leased.run({ kind: 'changed', newId: 'acct-B' });
  assert.ok(
    leased.seq.indexOf('failInFlightPublishesHonestly') < leased.seq.indexOf('resetTaskCoordinator')
      && leased.seq.indexOf('resetTaskCoordinator') < leased.seq.indexOf('disconnectCloud'),
    '租约中止落在诚实回执之后、断连之前',
  );
  assert.equal(leased.state.accountId, 'acct-B', '有租约时身份照样翻转');

  // 重入闩：重立在跑时再触发一次直接让路，绝不并发跑两条链。
  const reentrant = chain();
  const first = reentrant.run({ kind: 'lost' });
  const second = await reentrant.run({ kind: 'lost' });
  assert.deepEqual(second, { kind: 'skipped', reason: 'already_running' });
  await first;
});

test('T7 归位后仍读不出身份：停在无身份态，不换身份、不重连云端、不重启浏览，绝不回落默认账号', async () => {
  const c = chain({
    idRes: { ok: false, reason: '归位后仍读不出稳定 id' },
    decision: { kind: 'halt', reason: '登录态读不出稳定账号 id' },
  });
  const outcome = await c.run({ kind: 'lost' });

  assert.deepEqual(outcome, { kind: 'halted', reason: '登录态读不出稳定账号 id' });
  // 全序 deepEqual 就是「halt 是纯返回」的正向表述：链条到 readIdentity 为止，后面一步都没走。
  assert.deepEqual(c.seq, [
    'suspendObservation',
    'stopBrowse',
    'failInFlightPublishesHonestly',
    'disconnectCloud',
    'navigateToConsumerHome',
    'readIdentity',
  ]);
  // 红线：身份保持在失效前的值——既不换成新 id，更不回落到 'default'。
  assert.equal(c.state.accountId, 'acct-A');
  assert.equal(c.state.nickname, undefined);

  // halt 之后仍可再次触发（重入闩已释放），且行为一致——不会因为一次 halt 就永久卡住。
  assert.deepEqual((await c.run({ kind: 'lost' })).kind, 'halted');
});

// ── T8：覆盖值不得绕过 halt 红线（运行期覆盖无权威）─────────────────────────────

test('T8 归位后读不出 + 设了 AIDCP_ACCOUNT_ID：MUST 判 halt，绝不拿覆盖值重新握手开跑', async () => {
  // 纯判定层：`use-override-after-read-fail` 是启动期逃生阀的产物，运行期一律 halt。
  const verdict = judgeRuntimeIdentity({
    kind: 'use-override-after-read-fail',
    accountId: 'override-X',
    reason: '就地读不出稳定 id 且禁用跳转兜底',
  });
  assert.equal(verdict.kind, 'halt');
  assert.match(
    verdict.kind === 'halt' ? verdict.reason : '',
    /读不出稳定 id/,
    'halt 原因必须原样带出「读不出」的实测事实，不得被覆盖值糊掉',
  );

  // 链条层：这才是真正会把一台没有登录态的浏览器当成账号 X 继续跑的那条路径。
  const c = chain({
    idRes: { ok: false, reason: '归位后仍读不出稳定 id' },
    decision: { kind: 'use-override-after-read-fail', accountId: 'override-X', reason: '归位后仍读不出稳定 id' },
  });
  const outcome = await c.run({ kind: 'lost' });

  assert.equal(outcome.kind, 'halted');
  // 全序 deepEqual = 「halt 纯返回」的正向表述：一步都没往下走。
  assert.deepEqual(c.seq, [
    'suspendObservation',
    'stopBrowse',
    'failInFlightPublishesHonestly',
    'disconnectCloud',
    'navigateToConsumerHome',
    'readIdentity',
  ]);
  assert.equal(c.state.accountId, 'acct-A', '绝不把覆盖值写成本节点身份');
  assert.deepEqual(c.rebaselined, [], '没确立身份就绝不重设基线');
  assert.equal(c.halts.length, 1, 'halt 必须对外通告恰一次');
});

// ── T9：两种读预算必须分开（慢不是失败终局）───────────────────────────────────

test('T9 归位后重读用足预算、周期校验用小预算；两者 MUST NOT 共用一个写死的小预算', async () => {
  // 归位是一次整页重载（CDP 的 Page.navigate 在导航**开始**就返回、不等 load）。拿 1s 去读一个刚
  // 开始加载的页面，读到的只是「还没渲染完」；把它判成终局失败，换个号就把健康节点变成砖。
  assert.ok(
    REESTABLISH_IDENTITY_READ_HYDRATE_MS >= 6_000,
    '归位后重读的水合预算 MUST ≥ 退役实现使用的 6000ms（它靠这段预算「等锚点渲染出来」）',
  );
  assert.ok(
    PERIODIC_IDENTITY_READ_HYDRATE_MS <= 2_000 && PERIODIC_IDENTITY_READ_HYDRATE_MS < REESTABLISH_IDENTITY_READ_HYDRATE_MS,
    '周期校验每 30s 就有下一拍，读不出跳过即可，绝不该为它长时间占住 CDP',
  );
  assert.deepEqual(reestablishIdentityReadOptions(), {
    allowNavigate: false,
    hydrateTimeoutMs: REESTABLISH_IDENTITY_READ_HYDRATE_MS,
  });

  // 行为层：链条**自己**把预算交给读取实现，宿主没有插手的缝。
  const c = chain();
  await c.run({ kind: 'changed', newId: 'acct-B' });
  assert.equal(c.readOpts.length, 1);
  assert.equal(c.readOpts[0]!.allowNavigate, false, '运行期读身份一律只读、不导航（红线）');
  assert.ok(
    (c.readOpts[0]!.hydrateTimeoutMs ?? 0) >= 6_000,
    '归位后重读 MUST 带足量水合预算，否则「页面还没渲染完」会被判成「读不出身份」',
  );
});

// ── T10：基线口径一致 + 覆盖值不一致必须响亮告警（否则无限重建循环）─────────────

test('T10 覆盖值 ≠ 实测 id：以实测值为准、响亮告警、按实测值重设基线（不再无限重建）', async () => {
  // 纯判定层。
  const mismatchDecision: IdentityDecision = {
    kind: 'use',
    accountId: 'override-X',
    source: 'env-override',
    mismatch: { override: 'override-X', real: 'real-Y' },
  };
  assert.deepEqual(judgeRuntimeIdentity(mismatchDecision), {
    kind: 'accept',
    accountId: 'real-Y',
    overrideIgnored: { override: 'override-X', real: 'real-Y' },
  });
  assert.equal(observedAccountIdFromDecision(mismatchDecision), 'real-Y');
  assert.equal(
    observedAccountIdFromDecision({ kind: 'use', accountId: 'real-Y', source: 'in-place' }),
    'real-Y',
  );
  assert.equal(
    observedAccountIdFromDecision({ kind: 'use-override-after-read-fail', accountId: 'override-X', reason: 'x' }),
    undefined,
    '读不出实测值时 MUST 返回 undefined，绝不用覆盖值冒充「实测到的」',
  );

  // 链条层：换身份 / 重设基线用的都是**实测**值，且告警必须出现在日志里。
  const c = chain({ idRes: identified('real-Y'), decision: mismatchDecision });
  const outcome = await c.run({ kind: 'changed', newId: 'real-Y' });
  assert.deepEqual(outcome, { kind: 'reestablished', accountId: 'real-Y' });
  assert.equal(c.state.accountId, 'real-Y');
  assert.deepEqual(c.rebaselined, ['real-Y'], '基线 MUST 与校验体的比较口径（页面读出的 id）一致');
  assert.ok(
    c.logs.some((l) => l.includes('⚠') && l.includes('override-X') && l.includes('real-Y')),
    '覆盖值被实测事实推翻时 MUST 响亮告警，不能只打一句「✓ 身份已重新确立」',
  );

  // 闭环层：校验体 + 链条真接在一起跑一遍，钉死「不再无限重建」。
  // 基线取错值时，这里第二轮会再次判失效 —— 那正是每 2×节拍拆一次会话的无限循环。
  const invalidations: IdentityInvalidReason[] = [];
  const guard = new IdentityRevalidator('override-X', {
    threshold: 2,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    setTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
    clearTimer: () => undefined,
    readPageContext: async () => 'consumer',
    readIdentity: async () => identified('real-Y'),
    observationStatus: () => liveness(),
  });
  const loopChain = chain({
    idRes: identified('real-Y'),
    decision: mismatchDecision,
    rebaseline: (id) => guard.rebaseline(id),
  });
  guard.start((reason) => void invalidations.push(reason));
  await guard.check();
  await guard.check();
  assert.equal(invalidations.length, 1, '覆盖值与实测 id 不一致时，第一轮翻转是应该发生的');
  await loopChain.run(invalidations[0]!);
  // 重立之后再跑两拍：健康、不再翻转。基线若被写成覆盖值，这两拍会凑够阈值再翻一次。
  await guard.check();
  await guard.check();
  assert.equal(guard.health, 'healthy');
  assert.equal(guard.consecutiveFailures, 0);
  assert.equal(invalidations.length, 1, '重立之后 MUST NOT 再次判失效（否则就是无限重建循环）');
});

// ── T11：宿主叫停后，在途 check 与在途链条 MUST 当场作废 ───────────────────────

test('T11 stop() 之后：在途 check 不再判失效；在途链条当场作废并回滚自己做过的改动', async () => {
  // ① 在途 check：stop() 时正好卡在读页面上下文里，恢复后 MUST 什么都不做。
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness({
    contexts: ['creator-login'], // 恢复后若继续跑，这一格会计一次失效
    contextGate: () => gate,
  });
  const inFlight = h.guard.check();
  h.guard.stop();
  release();
  await inFlight;
  assert.equal(h.guard.consecutiveFailures, 0, 'stop() 之后返回的在途 check MUST 作废，绝不计数');
  assert.deepEqual(h.invalidated, [], 'stop() 之后 MUST NOT 再把重立链拉起来');

  // ② 在途链条：叫停正好落在「取基线」与「第一个取消点」之间 —— 一个副作用都不该做。
  const atEntry = chain({ bumpGenerationOnNthRead: 1 });
  const entryOutcome = await atEntry.run({ kind: 'lost' });
  assert.deepEqual(entryOutcome, { kind: 'aborted', step: 'entry', observationSuspendedByChain: false });
  assert.deepEqual(atEntry.seq, [], '入口取消点 MUST 早于任何副作用');

  // ③ 在途链条：叫停发生在「已停浏览、还没断云端」——冷待机想要的正是这个状态。
  const midStop = chain({ bumpGenerationAfter: 'stopBrowse' });
  const midOutcome = await midStop.run({ kind: 'lost' });
  assert.equal(midOutcome.kind, 'aborted');
  assert.ok(!midStop.seq.includes('disconnectCloud'), '被叫停后 MUST NOT 再去关云端连接（冷待机契约是保留它）');
  assert.ok(!midStop.seq.includes('startBrowse'), '被叫停后 MUST NOT 把浏览重新拉起来');
  // 周期观测**故意不在链条里恢复**（冷待机 / 停用马上就要关浏览器，此刻恢复＝对着已 detach 的 CDP
  // 空轮询到唤醒）。但「还停着」这个事实 MUST 如实带出去，恢复责任在宿主的 resumeAutomation。
  assert.ok(!midStop.seq.includes('resumeObservation'));
  assert.equal(midOutcome.kind === 'aborted' && midOutcome.observationSuspendedByChain, true);

  // ④ 在途链条：叫停发生在**已经断开云端之后** —— 那条连接是 intentionalClose（不自动重连、
  //    不发断连事件），不补回来节点就静默失联、外壳的唤醒指令再也送不到。
  const afterDisconnect = chain({ bumpGenerationAfter: 'disconnectCloud' });
  const afterOutcome = await afterDisconnect.run({ kind: 'lost' });
  assert.equal(afterOutcome.kind, 'aborted');
  assert.equal(afterOutcome.kind === 'aborted' && afterOutcome.cloudRestored, true);
  assert.ok(afterDisconnect.seq.includes('connectCloud'), '本链条断掉的云端连接 MUST 由本链条补回');
  assert.ok(!afterDisconnect.seq.includes('applyIdentity'));
  assert.ok(!afterDisconnect.seq.includes('startBrowse'));

  // ⑤ 回滚失败必须如实回报，绝不静默当成「已恢复」。
  const restoreFailed = chain({ bumpGenerationAfter: 'disconnectCloud', connectCloudThrows: true });
  const failedOutcome = await restoreFailed.run({ kind: 'lost' });
  assert.equal(failedOutcome.kind === 'aborted' && failedOutcome.cloudRestored, false);
  assert.ok(restoreFailed.logs.some((l) => l.includes('与云端失联')));

  // ⑥ 最后一个取消点：身份已换、云端已按新身份连上，但宿主此刻叫停 → 绝不 startBrowse
  //    （用户点了「暂停」，几秒后浏览自己又开始跑，就是这里放行造成的）。
  const beforeRestart = chain({ bumpGenerationAfter: 'rebaseline' });
  const restartOutcome = await beforeRestart.run({ kind: 'changed', newId: 'acct-B' });
  assert.equal(restartOutcome.kind, 'aborted');
  assert.ok(!beforeRestart.seq.includes('startBrowse'));
  assert.equal(
    restartOutcome.kind === 'aborted' && restartOutcome.cloudRestored,
    undefined,
    '这一步云端已由主路径连上，作废时 MUST NOT 再重连一次',
  );
});

// ── T12：halt 终局对外壳可见（IPC 主路径 + 文案白名单双保险）───────────────────

test('T12 halt MUST 对外通告；成功与作废路径 MUST NOT 通告；halt 文案能被外壳终态白名单认出', async () => {
  const halted = chain({
    idRes: { ok: false, reason: '归位后仍读不出稳定 id' },
    decision: { kind: 'halt', reason: '登录态读不出稳定账号 id' },
  });
  await halted.run({ kind: 'lost' });
  assert.deepEqual(halted.halts, ['登录态读不出稳定账号 id'], 'halt MUST 通告恰一次、且带上真实原因');

  const ok = chain();
  await ok.run({ kind: 'changed', newId: 'acct-B' });
  assert.deepEqual(ok.halts, [], '成功重立 MUST NOT 通告 halt');

  const aborted = chain({ bumpGenerationAfter: 'stopBrowse' });
  await aborted.run({ kind: 'lost' });
  assert.deepEqual(aborted.halts, [], '被宿主叫停不是 halt 终局，MUST NOT 通告');

  // 第二道保险：halt 那行日志必须能被桌面外壳的「核心自述终态」白名单认出。
  // 这里喂的是链条**真实打出来的**那行（不是抄一份常量），改了措辞就会红。
  const require = createRequire(import.meta.url);
  const fleet = require('../../src/electron/fleet.cjs') as { declaresCoreHalt(line: string): boolean };
  const haltLine = halted.logs.find((l) => l.includes('✗'));
  assert.ok(haltLine, 'halt 必须留下一行可观测日志');
  assert.equal(
    fleet.declaresCoreHalt(haltLine!),
    true,
    'halt 文案 MUST 命中外壳终态白名单（IPC 之外的第二道保险）',
  );
});

// ── T13：分域判据必须平台相关（否则在 Facebook 上永久空转）─────────────────────

test('T13 Facebook 域内一律可读（不再永久跳过）；小红书三态判据原样保留', async () => {
  // driver 契约层：FB 的分域判据必须认自己的域。
  assert.equal(facebookPlatformDriver.classifyIdentityContext('https://www.facebook.com/'), 'consumer');
  assert.equal(facebookPlatformDriver.classifyIdentityContext('https://www.facebook.com/groups/123'), 'consumer');
  assert.equal(facebookPlatformDriver.classifyIdentityContext('https://m.facebook.com/reel/9'), 'consumer');
  assert.equal(classifyFacebookIdentityContext('https://www.xiaohongshu.com/explore'), 'unknown');
  assert.equal(classifyFacebookIdentityContext('about:blank'), 'unknown');
  assert.equal(classifyFacebookIdentityContext(null), 'unknown');

  // 小红书那套三态判据一格没动（FB 的修法不许顺手把它抹平）。
  assert.equal(xhsPlatformDriver.classifyIdentityContext('https://www.xiaohongshu.com/explore'), 'consumer');
  assert.equal(xhsPlatformDriver.classifyIdentityContext('https://creator.xiaohongshu.com/publish'), 'creator-app');
  assert.equal(xhsPlatformDriver.classifyIdentityContext('https://creator.xiaohongshu.com/login'), 'creator-login');
  assert.equal(xhsPlatformDriver.classifyIdentityContext('https://www.facebook.com/'), 'unknown');

  // 行为层：把 FB 的判据接进校验体，一次真实的换号必须被判出来。
  // 换成小红书判据（旧行为），下面两拍全部走「本轮跳过」，invalidated 恒为空。
  const invalidated: IdentityInvalidReason[] = [];
  const logs: string[] = [];
  const guard = new IdentityRevalidator('100000000000001', {
    threshold: 2,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    logger: (m) => logs.push(m),
    setTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
    clearTimer: () => undefined,
    readPageContext: async () =>
      facebookPlatformDriver.classifyIdentityContext('https://www.facebook.com/?sk=h_chr'),
    readIdentity: async () => ({
      ok: true,
      identity: { accountId: '100000000000002', displayName: null, redId: null, source: 'facebook-cookie' },
    }),
    observationStatus: () => liveness(),
  });
  guard.start((reason) => void invalidated.push(reason));
  await guard.check();
  await guard.check();
  assert.deepEqual(
    invalidated,
    [{ kind: 'changed', newId: '100000000000002' }],
    'Facebook 上的换号 MUST 被判出来——这套校验在 FB 上曾经是永久空转的',
  );
  assert.ok(
    !logs.some((l) => l.includes('本轮跳过')),
    'Facebook 域内 MUST NOT 再出现每拍一行的「无法判定 → 本轮跳过」恒定噪声',
  );
});

// ── T14：判失效之后这一局怎么收口（作废 ≠ halt ≠ 链条自身异常）───────────────────
//
// 「已判失效」不是终局，只是把球交给了重立链。三种收场各有归宿：作废＝这次没做完（退回待判）、
// halt / 链条异常＝做完了结论是停手（终局）。把它们压成一态的代价是决定性的：链条一被叫停作废，
// 校验体就永久停在已失效态、`check()` 首行早退、`rebaseline` 又永远等不到（链条正是在到达它之前
// 被作废的）—— 暂停→恢复之后节点可能正跑在错误身份下，而且再也测不出换号。

/**
 * 按**宿主接线的形状**把校验体与重立链接起来：`guard.start(cb)` → cb 里起链条 → 链条回执回喂 guard。
 * 本组要证的正是「回执这条边」，只有真接起来才证得动（分开测两个零件永远看不见中间断掉的那根线）。
 */
function wired(over: {
  /** 页面上就地读出来的 id。换号场景里它一直是新 id（问题没被治好，翻转仍在）。 */
  pageIdentity: string;
  /** 宿主在链条的哪一步叫停（模拟暂停 / 冷待机 / 停用）。 */
  stopAt?: string;
  /** 链条在哪一步抛异常。 */
  throwAt?: string;
  /** 归位后重读的决策（halt 场景用）。 */
  decision?: IdentityDecision;
}) {
  const logs: string[] = [];
  const seq: string[] = [];
  const halts: string[] = [];
  const restored: string[] = [];
  const postures: RuntimePosture[] = [];
  const outcomes: IdentityReestablishmentOutcome[] = [];
  const invalidated: IdentityInvalidReason[] = [];
  let guard!: IdentityRevalidator;
  const step = (name: string): void => {
    seq.push(name);
    if (over.stopAt === name) guard.stop();
    if (over.throwAt === name) throw new Error(`${name} 炸了`);
  };
  guard = new IdentityRevalidator('acct-A', {
    threshold: 2,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    logger: (m) => logs.push(m),
    setTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
    clearTimer: () => undefined,
    readPageContext: async () => 'consumer',
    readIdentity: async () => identified(over.pageIdentity),
    observationStatus: () => liveness(),
  });
  const run = createIdentityReestablishment({
    logger: (m) => logs.push(m),
    suspendObservation: () => step('suspendObservation'),
    stopBrowse: async () => step('stopBrowse'),
    failInFlightPublishesHonestly: () => step('failInFlightPublishesHonestly'),
    hasActiveLease: () => false,
    resetTaskCoordinator: () => step('resetTaskCoordinator'),
    disconnectCloud: async () => step('disconnectCloud'),
    navigateToConsumerHome: async () => step('navigateToConsumerHome'),
    readIdentity: async () => {
      step('readIdentity');
      return identified(over.pageIdentity);
    },
    decideIdentity: () => over.decision ?? { kind: 'use', accountId: over.pageIdentity, source: 'in-place' },
    nicknameFor: () => undefined,
    applyIdentity: () => step('applyIdentity'),
    connectCloud: async () => step('connectCloud'),
    rebaseline: (id) => {
      step('rebaseline');
      guard.rebaseline(id);
    },
    resumeObservation: () => step('resumeObservation'),
    startBrowse: () => step('startBrowse'),
    generation: () => guard.generation,
    reportPosture: (posture) => {
      postures.push(posture);
      if (posture.kind === 'identity_halted') halts.push(posture.reason);
      if (posture.kind === 'healthy' && posture.accountId) restored.push(posture.accountId);
    },
  });
  /** 宿主的 `startIdentityGuard()`。回执回喂那一行正是本组用例钉的东西。 */
  const startGuard = (): void => {
    guard.start((reason) => {
      invalidated.push(reason);
      void run(reason).then((outcome) => {
        outcomes.push(outcome);
        guard.noteReestablishmentOutcome(outcome);
      });
    });
  };
  return { guard, startGuard, seq, logs, halts, restored, postures, outcomes, invalidated };
}

/** 排空链条那串立即 resolve 的 await（微任务在下一个宏任务前必然全部跑完）。 */
const settle = (): Promise<void> => new Promise((resolve) => void setImmediate(resolve));

test('T14 链条回执三态各有归宿：作废退回待判、halt 是终局、链条异常不许裸逸出', async () => {
  // ① 作废：宿主在「停浏览」处叫停（暂停 / 冷待机就落在这里）。
  //    这一格是本组的核心——它曾经让运行期身份校验在暂停→恢复之后**永久哑火**。
  const aborted = wired({ pageIdentity: 'acct-B', stopAt: 'stopBrowse' });
  aborted.startGuard();
  await aborted.guard.check();
  await aborted.guard.check();
  await settle();
  assert.equal(aborted.outcomes[0]?.kind, 'aborted');
  assert.equal(aborted.guard.health, 'healthy', '作废＝这次没做完，MUST 退回待判，绝不停在已失效态');
  assert.equal(aborted.guard.baseline, 'acct-A', '基线 MUST 保持旧值——正是它让下一拍能把翻转重新判出来');
  assert.equal(aborted.guard.consecutiveFailures, 0);
  assert.ok(aborted.logs.some((l) => l.includes('退回**待判**')));

  // 宿主恢复自动化（resumeAutomation → startIdentityGuard）。页面上仍是换过的号（问题没被治好）。
  aborted.startGuard();
  await aborted.guard.check();
  await aborted.guard.check();
  assert.equal(
    aborted.invalidated.length,
    2,
    '恢复后 MUST 能再次判出换号；停在 1 次 = 校验体永久哑火（装了但永久不工作）',
  );

  // ② halt：链条跑完了，结论是停手。这是**终局**，恢复自动化 / CDP 重连再怎么 start() 都不复活。
  const halted = wired({
    pageIdentity: 'acct-B',
    decision: { kind: 'halt', reason: '登录态读不出稳定账号 id' },
  });
  halted.startGuard();
  await halted.guard.check();
  await halted.guard.check();
  await settle();
  assert.equal(halted.outcomes[0]?.kind, 'halted');
  assert.equal(halted.guard.health, 'invalid');
  halted.startGuard(); // ← 恢复路径反复调它；MUST NOT 顺手把终局洗回健康
  await halted.guard.check();
  await halted.guard.check();
  await halted.guard.check();
  assert.equal(halted.invalidated.length, 1, 'halt 之后 MUST NOT 再判定：终局就是终局');
  assert.equal(halted.guard.health, 'invalid');

  // ③ 链条自身抛异常：MUST NOT 裸逸出。逸出之后没有任何东西会收口，校验体永久停在「重立中」，
  //    而外壳还一直显示「运行中」——两处都是静默假成功。
  const crashed = wired({ pageIdentity: 'acct-B', throwAt: 'disconnectCloud' });
  crashed.startGuard();
  await crashed.guard.check();
  await crashed.guard.check();
  await settle();
  assert.equal(crashed.outcomes[0]?.kind, 'crashed');
  assert.equal(crashed.halts.length, 1, '半拆终局 MUST 通告外壳（不然左栏一直显示「运行中 / 已连接云端」）');
  assert.equal(crashed.guard.health, 'invalid');
  assert.ok(!crashed.seq.includes('startBrowse'));

  // ④ 迟到的回执 MUST NOT 洗掉一个已经收口的局：冷待机唤醒会先 rebaseline，
  //    此时一条上一局的陈旧回执飘过来，绝不许把刚重立好的健康节点翻成终局。
  const late = wired({ pageIdentity: 'acct-B', stopAt: 'stopBrowse' });
  late.startGuard();
  await late.guard.check();
  await late.guard.check();
  await settle();
  late.guard.rebaseline('acct-B'); // 真正的身份重立（唤醒路径）
  late.guard.noteReestablishmentOutcome({ kind: 'crashed', reason: '上一局的迟到回执' });
  assert.equal(late.guard.health, 'healthy', '迟到回执 MUST 是空操作，绝不翻动不属于它的那一局');
});

// ── T15：冷待机唤醒后的身份收口（唤醒＝第二条「身份真的重新确立了」的路径）─────────────
//
// 唤醒会在新一代浏览器里重新读一次身份、读不出就直接判唤醒失败——所以走到收口时就意味着「刚刚实测
// 确认过」，与重立链步 11 等价。既然等价，它就必须承担步 11 的**全部**收口：重设基线（终局唯一的
// 解除边）、补回上一局 halt 断掉的云端连接、通告外壳解除红角标。三件事由同一个条件管。
//
// 曾经的形态：①③ 没有，② 只在「账号变了」时顺手做，① 还被关进 `if (resumeAutomation)` 里。而外壳
// 传的是「automation 没暂停」——**暂停中的节点被唤醒时它必然是 false**。于是一个真 halt 过的节点走
// 暂停 → 冷待机 → 唤醒（保持暂停）→ 恢复自动化 回来时：浏览重开、定时器重新武装、外壳显示运行中，
// 而判定首行永久早退、云端再也没连上、角标一直红着。

interface WakeHarness {
  seq: string[];
  logs: string[];
  rebaselined: string[];
  restored: string[];
  deps: WakeIdentityResettlementDeps;
}

function wakeHarness(over: { cloudAttached?: boolean; restoreThrows?: boolean } = {}): WakeHarness {
  const seq: string[] = [];
  const logs: string[] = [];
  const rebaselined: string[] = [];
  const restored: string[] = [];
  return {
    seq,
    logs,
    rebaselined,
    restored,
    deps: {
      logger: (m) => void logs.push(m),
      rebaseline: (id) => {
        seq.push('rebaseline');
        rebaselined.push(id);
      },
      cloudLinkAttached: () => over.cloudAttached ?? false,
      restoreCloudLink: async () => {
        seq.push('restoreCloudLink');
        if (over.restoreThrows) throw new Error('云端不可达');
      },
      reportPosture: (posture) => {
        if (posture.kind === 'healthy' && posture.accountId) {
          seq.push('reportIdentityRestored');
          restored.push(posture.accountId);
        }
      },
      startBrowse: () => void seq.push('startBrowse'),
      startIdentityGuard: () => void seq.push('startIdentityGuard'),
    },
  };
}

const MEASURED: IdentityDecision = { kind: 'use', accountId: 'acct-B', source: 'in-place' };
const OVERRIDE_ONLY: IdentityDecision = {
  kind: 'use-override-after-read-fail',
  accountId: 'override-X',
  reason: '唤醒后就地读不出稳定 id',
};

test('T15 唤醒后的身份收口与 resumeAutomation 无关：保持暂停也必须重设基线、补回云端、解除角标', async () => {
  // ── ① 判据层：实测到 id ⇒ 一次真重立；上一局是不是终局都一样。
  assert.deepEqual(judgeWakeIdentityResettlement(MEASURED, 'invalid'), { kind: 'reestablished', accountId: 'acct-B' });
  assert.deepEqual(judgeWakeIdentityResettlement(MEASURED, 'healthy'), { kind: 'reestablished', accountId: 'acct-B' });
  // 覆盖值不是实测值：绝不拿它当基线（拿了就是把一个页面上永远读不出的值钉进校验体 → 无限重建）。
  assert.equal(judgeWakeIdentityResettlement(OVERRIDE_ONLY, 'healthy').kind, 'unmeasured');
  assert.equal(judgeWakeIdentityResettlement(OVERRIDE_ONLY, 'invalid').kind, 'wake_rejected');

  // ── ② 核心格：实测到身份 + **保持暂停**（resumeAutomation=false）。
  //    这一格就是复现路径里的那一步。身份三件收口 MUST 全做，自动化 MUST NOT 恢复。
  const paused = wakeHarness();
  await applyWakeIdentityResettlement({ kind: 'reestablished', accountId: 'acct-B' }, false, paused.deps);
  assert.deepEqual(
    paused.rebaselined,
    ['acct-B'],
    '唤醒保持暂停时 MUST 照样重设基线——它是无身份终局唯一的解除边，关进 resumeAutomation 分支＝永久失效态',
  );
  assert.deepEqual(paused.restored, ['acct-B'], '外壳闩住的红角标 MUST 被解除（核心健康、外壳终局＝口径分岔）');
  assert.deepEqual(paused.seq, ['rebaseline', 'restoreCloudLink', 'reportIdentityRestored']);
  assert.ok(!paused.seq.includes('startBrowse'), '保持暂停 MUST NOT 把浏览拉起来');
  assert.ok(!paused.seq.includes('startIdentityGuard'), '保持暂停 MUST NOT 重新武装周期校验的定时器');

  // ── ③ 恢复自动化：三件收口照做，且**基线先于**重新武装定时器（否则第一拍拿旧基线判）。
  const resumed = wakeHarness();
  await applyWakeIdentityResettlement({ kind: 'reestablished', accountId: 'acct-B' }, true, resumed.deps);
  assert.deepEqual(resumed.seq, [
    'rebaseline',
    'restoreCloudLink',
    'reportIdentityRestored',
    'startBrowse',
    'startIdentityGuard',
  ]);

  // ── ④ 云端还连着（常规唤醒：连接全程没断）⇒ MUST NOT 再连一次。
  const attached = wakeHarness({ cloudAttached: true });
  await applyWakeIdentityResettlement({ kind: 'reestablished', accountId: 'acct-B' }, true, attached.deps);
  assert.ok(!attached.seq.includes('restoreCloudLink'), '连接还在时重复 connect 会白白换掉一条好连接');
  assert.deepEqual(attached.rebaselined, ['acct-B']);

  // ── ⑤ 云端补不回来：如实告警，但基线照样解除、角标照样通告（身份确实重立了，不该被牵连）。
  const restoreFailed = wakeHarness({ restoreThrows: true });
  await applyWakeIdentityResettlement({ kind: 'reestablished', accountId: 'acct-B' }, true, restoreFailed.deps);
  assert.deepEqual(restoreFailed.rebaselined, ['acct-B']);
  assert.deepEqual(restoreFailed.restored, ['acct-B']);
  assert.ok(restoreFailed.logs.some((l) => l.includes('与云端失联')), '补不回来 MUST 响亮告警，绝不静默当成已恢复');

  // ── ⑥ 没实测到 + 上一局不是终局：一件都不解除（基线仍是上一次实测值），自动化照旧恢复。
  const unmeasured = wakeHarness();
  await applyWakeIdentityResettlement({ kind: 'unmeasured', reason: '只有覆盖值顶着' }, true, unmeasured.deps);
  assert.deepEqual(unmeasured.rebaselined, [], '没实测到就 MUST NOT 重设基线（那是把「不知道」说成「知道」）');
  assert.deepEqual(unmeasured.restored, []);
  assert.ok(!unmeasured.seq.includes('restoreCloudLink'));
  assert.deepEqual(unmeasured.seq, ['startBrowse', 'startIdentityGuard']);

  // ── ⑦ 没实测到 + 上一局正停在无身份终局：唤醒被拒，**一件副作用都不做**（尤其不恢复自动化）。
  //    放它回来 = 浏览跑着、外壳显示运行中，而身份校验是死的、云端是断的——正是本批要根除的形态。
  const rejected = wakeHarness();
  await applyWakeIdentityResettlement({ kind: 'wake_rejected', reason: '只有覆盖值顶着' }, true, rejected.deps);
  assert.deepEqual(rejected.seq, [], '唤醒被拒 MUST 是纯返回');
  assert.ok(rejected.logs.some((l) => l.includes('重新登录')), '必须给出处理办法，不能只是静默不动');
});

test('T15bis 闭环：真 halt 过的节点走「暂停 → 冷待机 → 唤醒（保持暂停）→ 恢复自动化」之后仍能判出换号', async () => {
  // 上一条 T15 钉的是收口函数本身；这一条把它接回校验体，钉住「终局真的被解除了」这个结果。
  const h = wired({ pageIdentity: 'acct-B', decision: { kind: 'halt', reason: '登录态读不出稳定账号 id' } });
  h.startGuard();
  await h.guard.check();
  await h.guard.check();
  await settle();
  assert.equal(h.guard.health, 'invalid', '前置：一次真 halt 之后校验体停在终局');
  assert.equal(h.halts.length, 1);

  // 暂停 / 冷待机：宿主叫停（递增代际、停定时器）。
  h.guard.stop();
  // 唤醒（保持暂停）：新一代浏览器里重新实测到身份 = acct-B。
  const wake = wakeHarness();
  await applyWakeIdentityResettlement(
    judgeWakeIdentityResettlement({ kind: 'use', accountId: 'acct-B', source: 'in-place' }, h.guard.health),
    false, // ← 保持暂停：这正是外壳对一个暂停中的节点发 wake 时传的值
    { ...wake.deps, rebaseline: (id) => h.guard.rebaseline(id), startIdentityGuard: () => h.startGuard() },
  );
  assert.equal(h.guard.health, 'healthy', '唤醒实测到身份 ⇒ 终局 MUST 被解除');
  assert.equal(h.guard.baseline, 'acct-B', '基线 MUST 跟上新一代浏览器里实测到的 id');

  // 恢复自动化，页面此后又换了一次号：必须再判得出来。
  h.startGuard();
  const before = h.invalidated.length;
  await h.guard.check(); // 页面读出的仍是 acct-B == 新基线 ⇒ 健康
  assert.equal(h.guard.consecutiveFailures, 0);
  assert.equal(h.invalidated.length, before, '基线已跟上，MUST NOT 把同一个号误判成换号');
});

test('T15ter 端到端：真 lifecycle 驱动「暂停 → 冷待机 → 唤醒 → 恢复」，四条轴 MUST 一起回到健康', async () => {
  // T15 / T15bis 钉的是收口函数与校验体；这一条把**真的** CoreLifecycleController 接进来，按运营的
  // 操作序走一遍。它证的是别处证不了的那一件事：`wake` 传给宿主的是「automation 没暂停」——一个
  // 暂停中的节点被唤醒时它必然是 false，所以任何挂在「恢复自动化」上的身份收口都必然被跳过。
  const logs: string[] = [];
  let pageIdentity = 'acct-A';
  let accountId = 'acct-A';
  let browsing = false;
  let cloudAttached = true;
  let shellHalted: string | null = null;

  const guard = new IdentityRevalidator('acct-A', {
    threshold: 2,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    logger: (m) => logs.push(m),
    setTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
    clearTimer: () => undefined,
    readPageContext: async () => 'consumer',
    readIdentity: async () => identified(pageIdentity),
    observationStatus: () => liveness(),
  });
  const reestablish = createIdentityReestablishment({
    logger: (m) => logs.push(m),
    suspendObservation: () => undefined,
    stopBrowse: async () => { browsing = false; },
    failInFlightPublishesHonestly: () => undefined,
    hasActiveLease: () => false,
    resetTaskCoordinator: () => undefined,
    // halt 关云端用的是 intentionalClose：不自动重连、也不 emit 断连事件。
    disconnectCloud: async () => { cloudAttached = false; },
    navigateToConsumerHome: async () => undefined,
    readIdentity: async () => ({ ok: false, reason: '归位后仍读不出稳定 id' }),
    decideIdentity: () => ({ kind: 'halt', reason: '登录态读不出稳定账号 id' }),
    nicknameFor: () => undefined,
    applyIdentity: () => undefined,
    connectCloud: async () => { cloudAttached = true; },
    rebaseline: (id) => guard.rebaseline(id),
    resumeObservation: () => undefined,
    startBrowse: () => { browsing = true; },
    generation: () => guard.generation,
    reportPosture: (posture) => {
      shellHalted = posture.kind === 'identity_halted' ? posture.reason : null;
    },
  });
  const startIdentityGuard = (): void => {
    if (!accountId) return;
    guard.start((reason) => void reestablish(reason).then((o) => guard.noteReestablishmentOutcome(o)));
  };
  const lifecycle = new CoreLifecycleController({
    pauseAutomation: async () => { guard.stop(); browsing = false; },
    resumeAutomation: async () => { browsing = true; startIdentityGuard(); },
    deactivate: async () => undefined,
    closeOwnedBrowser: async () => true,
    enterStandby: async () => { guard.stop(); browsing = false; return { ok: true }; },
    wakeFromStandby: async (resumeAutomation) => {
      // 宿主唤醒步 4 的等价物：新一代浏览器里重新读身份并确认成功（读不出会直接判唤醒失败）。
      const decision: IdentityDecision = { kind: 'use', accountId: pageIdentity, source: 'in-place' };
      const resettlement = judgeWakeIdentityResettlement(decision, guard.health);
      if (resettlement.kind === 'wake_rejected') return false;
      accountId = pageIdentity;
      await applyWakeIdentityResettlement(resettlement, resumeAutomation, {
        logger: (m) => logs.push(m),
        rebaseline: (id) => guard.rebaseline(id),
        cloudLinkAttached: () => cloudAttached,
        restoreCloudLink: async () => { cloudAttached = true; },
        reportPosture: (posture) => { if (posture.kind === 'healthy') shellHalted = null; },
        startBrowse: () => { browsing = true; },
        startIdentityGuard: () => startIdentityGuard(),
      });
      return true;
    },
    exit: () => undefined,
    logger: (m) => logs.push(m),
  });

  startIdentityGuard();
  browsing = true;

  // 一次**真** halt：页面换了号，链条归位后读不出 ⇒ 终局。
  pageIdentity = 'acct-B';
  await guard.check();
  await guard.check();
  await settle();
  assert.equal(guard.health, 'invalid', '前置：真 halt 之后校验体停在终局');
  assert.equal(cloudAttached, false, '前置：halt 断掉了云端连接');
  assert.equal(shellHalted, '登录态读不出稳定账号 id', '前置：外壳红角标已闩上');

  await lifecycle.request('pause');
  await lifecycle.request('standby');
  await lifecycle.request('wake'); // ← 保持暂停：wake 传的是 !automationPaused = false
  await lifecycle.request('resume');

  assert.equal(browsing, true, '浏览确实重开了——所以下面三条只要有一条没回来，就是「跑着但传感层是死的」');
  assert.equal(guard.health, 'healthy', '主项：恢复之后校验体 MUST 回到可判定态');
  assert.equal(guard.baseline, 'acct-B', '主项：基线 MUST 跟上唤醒时实测到的 id');
  assert.equal(cloudAttached, true, '伴随项 a：身份重新确认之后，halt 断掉的云端连接 MUST 补回来');
  assert.equal(shellHalted, null, '伴随项 b：外壳那枚闩住的红角标 MUST 被解除');
});

// ── T15quater：同族扫描新捞出的另一条入口（不经冷待机的「暂停 → 恢复」）─────────────────
//
// 上面几条治的是冷待机唤醒那条路。但「让节点重新跑起来」的入口不止一条：真 halt 之后运营点一次
// 「暂停」再点一次「恢复」，浏览循环照样重新跑起来——而这条路**不带来任何新的身份事实**，校验体
// 仍停在终局、云端仍是断的。同一个洞换个入口再挖一遍。判据：带来实测的入口才配解除终局；不带来
// 实测的入口在终局面前必须停手。

test('T15quater 恢复自动化的身份准入：终局身份下 MUST 拒绝放行，绝不在未知身份下把浏览重新拉起来', async () => {
  // ── 判据层。
  assert.deepEqual(judgeAutomationResume('healthy'), { kind: 'allow' });
  assert.deepEqual(judgeAutomationResume('reestablishing'), { kind: 'allow' },
    '链条持球的中间态 MUST 放行——拦它等于把一次正常的重立卡死');
  const refused = judgeAutomationResume('invalid');
  assert.equal(refused.kind, 'refuse');
  assert.match(refused.kind === 'refuse' ? refused.reason : '', /重新登录/,
    '拒绝必须给出处理办法，否则运营只会反复点「恢复」');

  // ── 行为层：真 lifecycle 驱动 halt → 暂停 → 恢复（**不经冷待机**）。
  // 关键差别（本轮修正）：`resumeAutomation` 里跑的是**真实现** `resumeAutomationUnderIdentityGate`，
  // 不再是用例自己重写一遍宿主逻辑。上一轮那种写法测的是自家闭包——把源码里的 `throw` 整行删掉，
  // 整套用例仍然全绿，等于没有闸。
  let pageIdentity = 'acct-A';
  let browsing = false;
  let cloudAttached = true;
  let observationRunning = true;
  const postures: RuntimePosture[] = [];
  const guard = new IdentityRevalidator('acct-A', {
    threshold: 2,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    setTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
    clearTimer: () => undefined,
    readPageContext: async () => 'consumer',
    readIdentity: async () => identified(pageIdentity),
    observationStatus: () => liveness(),
  });
  const reestablish = createIdentityReestablishment({
    logger: () => undefined,
    suspendObservation: () => undefined,
    stopBrowse: async () => { browsing = false; },
    failInFlightPublishesHonestly: () => undefined,
    hasActiveLease: () => false,
    resetTaskCoordinator: () => undefined,
    disconnectCloud: async () => { cloudAttached = false; },
    navigateToConsumerHome: async () => undefined,
    readIdentity: async () => ({ ok: false, reason: '归位后仍读不出稳定 id' }),
    decideIdentity: () => ({ kind: 'halt', reason: '登录态读不出稳定账号 id' }),
    nicknameFor: () => undefined,
    applyIdentity: () => undefined,
    connectCloud: async () => { cloudAttached = true; },
    rebaseline: (id) => guard.rebaseline(id),
    resumeObservation: () => undefined,
    startBrowse: () => { browsing = true; },
    generation: () => guard.generation,
    reportPosture: (posture) => void postures.push(posture),
  });
  const startIdentityGuard = (): void => {
    guard.start((reason) => void reestablish(reason).then((o) => guard.noteReestablishmentOutcome(o)));
  };
  // 宿主薄接线：把**真**闸接进真 lifecycle。用例不再复制任何判定。
  const resumeAutomation = (): Promise<void> => resumeAutomationUnderIdentityGate(guard.health, {
    logger: () => undefined,
    reportPosture: (posture) => void postures.push(posture),
    haltReason: () => '登录态读不出稳定账号 id',
    resumeObservation: () => { observationRunning = true; },
    startBrowse: () => { browsing = true; },
    startIdentityGuard,
  });
  const lifecycle = new CoreLifecycleController({
    pauseAutomation: async () => { guard.stop(); browsing = false; observationRunning = false; },
    resumeAutomation,
    deactivate: async () => undefined,
    closeOwnedBrowser: async () => true,
    exit: () => undefined,
  });

  startIdentityGuard();
  browsing = true;
  pageIdentity = 'acct-B';
  await guard.check();
  await guard.check();
  await settle();
  assert.equal(guard.health, 'invalid', '前置：真 halt 之后停在终局');
  assert.equal(cloudAttached, false, '前置：halt 断掉了云端连接');

  await lifecycle.request('pause');
  postures.length = 0;
  await lifecycle.request('resume').catch(() => undefined);

  assert.equal(browsing, false, '终局身份下 MUST NOT 把浏览重新拉起来（云端还断着，跑起来就是白烧动作 + 上报全丢）');
  assert.equal(observationRunning, false, '被拒的恢复 MUST 一件副作用都不做（连观测都不许重启）');
  assert.equal(lifecycle.state, 'paused', '拒绝之后 MUST 如实留在暂停态，绝不投影成「已恢复」');
  // 拒绝走的是抛异常 ⇒ 不会有 lifecycle.resumed；**必须**由这里把终局再喊一遍，否则外壳那条乐观投影
  // （它在下发指令前就把界面写成运行中了）永远没人纠正。这一条正是回归①在核心侧的对应闸。
  assert.deepEqual(postures, [{ kind: 'identity_halted', reason: '登录态读不出稳定账号 id' }],
    '被拒时 MUST 把当前终局重新对外通告一次');

  // 直接驱动真实现再钉一遍「拒绝＝抛出」：宿主契约里，抛出才是「保持暂停态」。
  // 副作用用**记账**而不是 assert.fail：后者会让「删掉 throw」这次突变照样以 AssertionError 的形式
  // 满足 assert.rejects（用例自己把突变盖住了）。记账后单独断言，两条独立判据都得成立。
  const refusedCalls: string[] = [];
  const settledAsRefused = await resumeAutomationUnderIdentityGate('invalid', {
    logger: () => undefined,
    reportPosture: () => undefined,
    haltReason: () => 'x',
    resumeObservation: () => void refusedCalls.push('resumeObservation'),
    startBrowse: () => void refusedCalls.push('startBrowse'),
    startIdentityGuard: () => void refusedCalls.push('startIdentityGuard'),
  }).then(() => 'resolved', (error: unknown) => (error as Error).message);
  assert.equal(settledAsRefused, 'identity_halted_relogin_required',
    '删掉这一 throw ⇒ 恢复静默放行、宿主以为成功：这条断言就是那次突变的杀手');
  assert.deepEqual(refusedCalls, [], '被拒的恢复 MUST 一件副作用都不做');

  // 唯一的出路仍然是一次带实测的入口：冷待机唤醒（或重启节点）。
  const wake = wakeHarness();
  await applyWakeIdentityResettlement(
    judgeWakeIdentityResettlement({ kind: 'use', accountId: 'acct-B', source: 'in-place' }, guard.health),
    false,
    { ...wake.deps, rebaseline: (id) => guard.rebaseline(id) },
  );
  assert.deepEqual(judgeAutomationResume(guard.health), { kind: 'allow' }, '带实测的入口解除终局之后 MUST 放行');
});

// ── T16：阈值满但**无人接管**那一格（不留一个永远等不到回执的中间态）─────────────────

test('T16 判失效时没有回调接管 ⇒ 直接落终局 invalid，绝不停在等不到回执的「重立中」', async () => {
  const logs: string[] = [];
  const guard = new IdentityRevalidator('acct-A', {
    threshold: 2,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    logger: (m) => logs.push(m),
    setTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
    clearTimer: () => undefined,
    readPageContext: async () => 'consumer',
    readIdentity: async () => identified('acct-B'),
    observationStatus: () => liveness(),
  });
  guard.start(); // ← 不给 onInvalid：没有任何东西会来收口这一局

  await guard.check();
  await guard.check();
  assert.equal(
    guard.health,
    'invalid',
    '无人接管时 MUST 直接落终局：停在「重立中」＝一个永远等不到回执的中间态，与永久哑火同形',
  );

  // 「终局」不是措辞而是行为：再怎么 check / 收到迟到回执都不许把它翻回可判定态。
  await guard.check();
  assert.equal(guard.health, 'invalid');
  guard.noteReestablishmentOutcome({ kind: 'aborted', step: 'stop_browse', observationSuspendedByChain: true });
  assert.equal(guard.health, 'invalid', '不属于这一局的回执 MUST NOT 把无人接管的终局洗回待判');
  guard.start(); // 恢复自动化 / CDP 重连都会反复调它
  assert.equal(guard.health, 'invalid');

  // 唯一的解除边仍然只有一次真正的身份重立。
  guard.rebaseline('acct-B');
  assert.equal(guard.health, 'healthy');
});

// ── T17：链条在**重设基线之后**崩掉（身份没问题，收尾没做完）────────────────────────

test('T17 重立成功之后收尾步骤抛异常：MUST NOT 报成身份终局，也 MUST NOT 把校验体钉死', async () => {
  const c = wired({ pageIdentity: 'acct-B', throwAt: 'resumeObservation' });
  c.startGuard();
  await c.guard.check();
  await c.guard.check();
  await settle();

  const outcome = c.outcomes[0];
  assert.equal(outcome?.kind, 'crashed');
  assert.equal(
    outcome?.kind === 'crashed' && outcome.identityReestablished,
    true,
    '崩在步 11 之后 MUST 如实带出「身份已经换成了」——它决定这次崩要不要被当成身份终局',
  );
  assert.deepEqual(
    c.halts,
    [],
    '身份恰恰是唯一没出问题的东西：报 halt 会把刚解除的红角标重新闩上，文案还写着「身份确立失败」',
  );
  assert.deepEqual(c.restored, ['acct-B'], '身份确实重立了，通告 MUST 已经发出去');
  // 本轮新增的那一格：**「不说假话」不等于「说了真话」。** 上一轮只做到不报 halt，于是外壳停在步 11.5
  // 刚解除完角标的那个状态——运行中、无角标，而浏览与观测永久停着、没有任何东西会重启它们。
  assert.deepEqual(
    c.postures.at(-1),
    { kind: 'automation_stalled', reason: 'resumeObservation 炸了' },
    '身份完好但自动化没跑起来 MUST 如实说出这第三态；缺了它，外界看到的是「运行中、无角标」＝静默假成功',
  );
  assert.equal(c.guard.health, 'healthy', '基线已换、状态已回健康：一次与身份无关的故障 MUST NOT 把它钉成终局');
  assert.equal(c.guard.baseline, 'acct-B');
  assert.ok(
    c.logs.some((l) => l.includes('身份本身没有问题')),
    '真正没做完的是「恢复自动化」，日志必须把排查方向指对',
  );

  // 迟到的「重立后崩」回执 MUST NOT 翻动**不属于它的**下一局。
  // 这一局（A）已经由 rebaseline 收口回健康；此后校验体判出新一次翻转、进「重立中」把球交给链条 B。
  // 此时 A 的陈旧回执飘过来：它说的是「A 的收尾崩了」，与 B 正在处理的身份毫无关系。少了这道守卫，
  // 它会把 B 持球的那一局直接钉成终局，而 B 随后的真回执又会因为「状态已不是重立中」被当作迟到丢掉
  // ——一台身份完好的机器就此永久哑火。
  c.guard.rebaseline('acct-C'); // 页面上又换了一次号（此刻页面读出的仍是 acct-B）
  c.guard.start((reason) => void reason); // 重新武装回调（上一局的链条已收场，这一局交给链条 B）
  await c.guard.check();
  await c.guard.check();
  assert.equal(c.guard.health, 'reestablishing', '前置：新一局已把球交给链条 B');
  c.guard.noteReestablishmentOutcome({ kind: 'crashed', reason: 'A 的迟到回执', identityReestablished: true });
  assert.equal(
    c.guard.health,
    'reestablishing',
    '一条回执只收口它自己那一局：身份已确立的崩溃 MUST NOT 把别人持球的那一局钉成终局',
  );

  // 对照组：崩在步 11 **之前** ⇒ 原样是身份终局（这一格 T14③ 也钉，这里再钉一次边界）。
  const early = wired({ pageIdentity: 'acct-B', throwAt: 'disconnectCloud' });
  early.startGuard();
  await early.guard.check();
  await early.guard.check();
  await settle();
  assert.equal(early.halts.length, 1);
  assert.deepEqual(early.restored, []);
  assert.equal(early.guard.health, 'invalid');
});

// ── T18：身份未落定时，节点不许代表这个账号动作，也不许以陈旧身份重新上线（S9）─────────
//
// `halt` 是**纯返回**：它停浏览、停观测、断云端，但**从不关浏览器**。浏览器仍开着、登着一个我们已经
// 明说「不知道是谁」的账号。于是两条路能把它重新拉回线上并真的动手：
//   ① 运营在客户端切一次云端环境 → 重绑一步到位、全程不问身份 ⇒ 以陈旧身份对新云端宣称在线；
//   ② 云端随后派下来的发布 / 任务认领会经协调器与执行器**真的执行** ⇒ 真发帖、记账挂错账号。
// 后者比「浏览循环空转」重一个量级：它在平台上留下真实痕迹，且账目是错的。

test('T18 身份闸：写动作与重绑被拦并如实回执，救援 / 读 / 收尾类照常放行', () => {
  // ── ① 写动作（以页面账号名义动作的那些）在两种未落定态下都 MUST 被拦。
  for (const health of ['invalid', 'reestablishing'] as const) {
    for (const type of ['publish.command', 'xiaohongshu.note.comment', 'facebook.note.like', 'edge.task.acquire', 'facebook.group.join'] as const) {
      const verdict = judgeCommandUnderIdentity(health, type);
      assert.equal(verdict.kind, 'refuse', `${health} 下 ${type} MUST 被拦：它会在平台上留下该账号名下的真实痕迹`);
      assert.equal(verdict.kind === 'refuse' ? verdict.reason : '', 'identity_unresolved',
        '拒绝 MUST 有具名原因并回执——静默丢弃会让云端分不清「没触达」与「执行了但没结果」');
    }
  }

  // ── ② 救援 / 读 / 收尾类 MUST 放行：拦掉它们只会让节点更难救。
  for (const type of [
    'edge.task.release',
    'identity.read_current_page',
    'identity.read_self_profile',
    'captcha.assist.capture',
    'captcha.assist.click',
    'session.end',
  ] as const) {
    assert.deepEqual(judgeCommandUnderIdentity('invalid', type), { kind: 'allow' },
      `${type} 是救援 / 读 / 收尾，拦掉等于把唯一的自救路径也堵死`);
  }
  // 不代表账号动作的控制类命令本来就不在闸的辖区内。
  assert.deepEqual(judgeCommandUnderIdentity('invalid', 'pacing.update'), { kind: 'allow' });
  assert.deepEqual(judgeCommandUnderIdentity('invalid', 'ping'), { kind: 'allow' });

  // ── ③ 身份健康时一律放行（这道闸只在身份未落定时存在）。
  assert.deepEqual(judgeCommandUnderIdentity('healthy', 'publish.command'), { kind: 'allow' });
  assert.deepEqual(judgeCommandUnderIdentity(undefined, 'publish.command'), { kind: 'allow' },
    '没有装配校验体（无浏览 / 无身份闭环）时 MUST NOT 凭空拦——那会把一台正常机器停掉');

  // ── ④ 重绑：终局 / 重立中 MUST 拒绝，且理由里带处理办法。
  assert.deepEqual(judgeCloudRebindUnderIdentity('healthy'), { kind: 'allow' });
  for (const health of ['invalid', 'reestablishing'] as const) {
    const verdict = judgeCloudRebindUnderIdentity(health);
    assert.equal(verdict.kind, 'refuse');
    const reason = verdict.kind === 'refuse' ? verdict.reason : '';
    assert.match(reason, /identity_unresolved/);
    assert.match(reason, /重新登录/, '拒绝必须给出处理办法，否则运营只会反复点切换');
  }
});

// ── T19：唤醒被身份闸拒绝时**真的拆**（不是只打一行告警）───────────────────────────
//
// 抽成可注入实现的唯一理由是**可杀**：上一轮这段留在宿主大闭包里，用例只能扫源码文本，
// 而「保留告警但不再拆除、照常返回成功」这种现实形态的削弱在文本断言下完全存活。

test('T19 唤醒被拒：MUST 诚实回执在途发布 + 释放浏览器层 + 停代理世代 + 杀浏览器，并如实回 false', async () => {
  const seq: string[] = [];
  const logs: string[] = [];
  const result = await refuseWakeUnderIdentityGate('唤醒后仍读不出稳定账号 id', 'browser_wake_identity_unmeasured', {
    logger: (m) => void logs.push(m),
    failInFlightPublishesHonestly: (reason) => void seq.push(`fail:${reason}`),
    detachSession: async () => {
      seq.push('detach:start');
      await new Promise<void>((resolve) => setImmediate(resolve));
      seq.push('detach:end');
    },
    suspendProxyGeneration: (reason) => void seq.push(`proxy:${reason}`),
    killBrowser: async () => void seq.push('kill'),
  });

  assert.equal(result, false, '唤醒失败 MUST 如实回 false（＝留在待机态、可再次唤醒），绝不把身份未知的浏览器当就绪');
  assert.deepEqual(seq, [
    'fail:browser_wake_identity_unmeasured',
    'detach:start',
    'detach:end',
    'proxy:browser_wake_identity_unmeasured',
    'kill',
  ], '四件副作用与顺序都是不变量：先诚实回执（否则云端无限期挂起）、再释放 CDP（否则被动断开会被当成意外掉线留僵尸）、最后才杀浏览器');
  assert.ok(logs.some((l) => l.includes('留在待机态')), '拒绝必须说清「现在是什么状态、还能怎么办」');
});

// ── T20：交付前自查表 —— 八条终局 / 恢复路径 × **外界看到什么** ───────────────────────
//
// 上一轮的教训：改完只核了核心侧，于是把一个「看得见、且处理办法恰好正确」的假失败，换成了一个
// 「外壳全绿、无角标」的假成功。所以这条用例从**外壳那一侧**逐条驱动，每条都问同一个问题：
// 外面看到的，和里面真实发生的，是不是同一件事。
//
// 判定全部来自真模块（核心的 identity-guard + 外壳的 runtime-posture.cjs）；这里只保留 main.cjs 那几条
// 与本主题无关的日志推断（「已连接云端」「浏览循环结束」…），用来复现**覆写**这个真实威胁。

const requireCjs = createRequire(import.meta.url);
const shellPostureModule = requireCjs('../../src/electron/runtime-posture.cjs') as {
  RUNTIME_POSTURE_KINDS: string[];
  parseRuntimePosture: (message: unknown) => unknown;
  projectRuntimePosture: (posture: unknown) => ShellProjection;
  postureLatches: (posture: unknown) => boolean;
  postureOfLiveCore: (posture: unknown, declaredBy: unknown, currentChild: unknown) => unknown;
  runtimePostureTransition: (
    previousLatch: unknown,
    posture: unknown,
    context: { closeIntent?: boolean },
  ) => { latch: unknown; patch: ShellProjection | null };
  posturePatchFrom: (
    projection: ShellProjection,
    deps: {
      presencePatch: (text: string) => Record<string, unknown>;
      clearFailure: () => Record<string, unknown>;
      setFailure: (summary: string) => Record<string, unknown>;
    },
  ) => Record<string, unknown>;
  commitPatchUnderPosture: (
    posture: unknown,
    next: Record<string, unknown>,
    nowIso: string,
  ) => Record<string, unknown>;
  runtimePostureOverride: (posture: unknown) => { axes: Record<string, string>; presence: string | null } | null;
  judgeResumeUnderPosture: (posture: unknown) => { kind: string; message?: string; presence?: string };
  runResumeUnderPosture: (
    posture: unknown,
    deps: {
      refuse: (patch: { edge: string; session: string; lastMessage: string; presence: string }) => void;
      proceed: () => void;
    },
  ) => boolean;
};
const shellFleet = requireCjs('../../src/electron/fleet.cjs') as {
  declaresCoreHalt: (line: string) => boolean;
};

interface ShellProjection {
  axes: Record<string, string>;
  message: string | null;
  presence: string | null;
  failure: string | null | undefined;
}

interface VisibleStatus {
  edge: string;
  session: string;
  cloud: string;
  auth: string;
  lastMessage: string;
  presence: string;
  edgeFailure: string | null;
}

/**
 * 外壳视角的**真**装配：闩的作用域、收 posture 的转移、日志行覆盖层、恢复按钮准入，四处全部驱动
 * `runtime-posture.cjs` 的真函数（连终态白名单也用真的 `fleet.declaresCoreHalt`）。
 *
 * 本 harness 里 MUST NOT 出现任何判据的复制品——上一轮它自己写了一份闭包，于是把宿主源码里的动作
 * 删掉、把覆盖层整块挪走，这套用例照样全绿。现在唯一的自写逻辑是几条与本主题无关的日志文本推断
 * （「已连接云端」「浏览循环结束」…），它们的存在正是为了复现**覆写**这个真实威胁。
 */
function shellView() {
  const status: VisibleStatus = {
    edge: 'running',
    session: 'running',
    cloud: 'connected',
    auth: 'logged in',
    lastMessage: '自动化运行中',
    presence: '自动化运行中',
    edgeFailure: null,
  };
  let latch: unknown = null;
  /** 闩是**哪一次 core run** 说的（与 main.cjs 的 handle.runtimePostureCore 对应）。 */
  let latchCore: unknown = null;
  let currentCore: unknown = { core: 1 };
  const live = (): unknown => shellPostureModule.postureOfLiveCore(latch, latchCore, currentCore);
  /**
   * 投影 → 补丁的翻译**必须**走真模块（`posturePatchFrom`），不许在这里抄一份。
   *
   * 上一轮这里就是一份手抄的等价逻辑，于是宿主 `posturePatch` 里那一格「失败卡片怎么写 / 怎么清」
   * 被整格删掉，全套用例照样零红——而那一格是持久红卡的**唯一写入口**。这里的三个 deps 就是宿主
   * `main.cjs` 里那三件私有动作的最小等价物。
   */
  const applyProjection = (projection: ShellProjection): void => {
    const patch = shellPostureModule.posturePatchFrom(projection, {
      presencePatch: (text) => ({ presence: { text, at: new Date().toISOString() } }),
      clearFailure: () => ({ edgeFailure: null }),
      setFailure: (summary) => ({ edgeFailure: summary }),
    });
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'presence') {
        status.presence = String((value as { text?: string })?.text ?? '');
      } else {
        (status as unknown as Record<string, unknown>)[key] = value;
      }
    }
  };
  return {
    status,
    /** 当前**有效**的闩（核心换代 / 退出后自动作废）。 */
    liveLatch: (): unknown => live(),
    /** 外壳收到核心的运行态 IPC（与 main.cjs 那一段逐行对应；转移判定来自真模块）。 */
    receive(ipc: Record<string, unknown>, context: { closeIntent?: boolean } = {}): void {
      const posture = shellPostureModule.parseRuntimePosture(ipc);
      if (!posture) return;
      const transition = shellPostureModule.runtimePostureTransition(live(), posture, context);
      latch = transition.latch;
      latchCore = currentCore;
      if (transition.patch) applyProjection(transition.patch);
    },
    /** 核心又打了一行普通日志（这正是覆写威胁的来源）。 */
    log(line: string): void {
      const halting = shellFleet.declaresCoreHalt(line) || shellPostureModule.postureLatches(live());
      const next: Record<string, unknown> = { edge: halting ? 'warning' : 'running', lastMessage: line };
      if (!halting) next.edgeFailure = null;
      if (line.includes('已连接云端')) next.cloud = 'connected';
      if (line.includes('浏览循环结束')) next.session = 'idle';
      if (line.includes('自动浏览已启动')) next.session = 'running';
      const committed = shellPostureModule.commitPatchUnderPosture(live(), next, new Date().toISOString());
      for (const [key, value] of Object.entries(committed)) {
        if (key === 'presence') {
          status.presence = typeof value === 'string' ? value : String((value as { text?: string })?.text ?? '');
        } else {
          (status as unknown as Record<string, unknown>)[key] = value;
        }
      }
    },
    /** 运营点了「恢复」。返回是否真的往下走（proceed 由真模块决定调不调）。 */
    clickResume(): { kind: string; proceeded: boolean } {
      let proceeded = false;
      const allowed = shellPostureModule.runResumeUnderPosture(live(), {
        refuse: (patch) => {
          Object.assign(status, {
            edge: patch.edge,
            session: patch.session,
            lastMessage: patch.lastMessage,
            presence: patch.presence,
          });
        },
        proceed: () => {
          proceeded = true;
          // 宿主 proceed 分支真正会做的那件事：把界面写成运行中并下发恢复。
          Object.assign(status, { edge: 'running', session: 'running' });
        },
      });
      return { kind: allowed ? 'allow' : 'refuse', proceeded };
    },
    /** 核心退出了（handle.child = undefined）。 */
    coreExited(): void {
      currentCore = null;
    },
    /** 核心被重新拉起（新一代 core run）。 */
    respawnCore(): void {
      currentCore = { core: 2 };
    },
  };
}

/** 核心的 posture 直投到外壳：等价于宿主的 `publishRuntimePosture`。 */
function pipe(view: ReturnType<typeof shellView>) {
  return (posture: RuntimePosture): void => view.receive(runtimePostureIpc(posture));
}

test('T20 自查表：八条路径逐条核对「外面看到的 = 里面发生的」', async () => {
  // ① 真 halt：里面＝浏览停 / 观测停 / 云端被主动断开 / 不知道登着谁。
  {
    const view = shellView();
    const c = wired({ pageIdentity: 'acct-B', decision: { kind: 'halt', reason: '登录态读不出稳定账号 id' } });
    c.startGuard();
    await c.guard.check();
    await c.guard.check();
    await settle();
    for (const posture of c.postures) pipe(view)(posture);
    view.log('[aidcp-edge] 心跳 ok');            // ← 覆写威胁：普通日志一行
    view.log('[aidcp-edge] 已连接云端 ws://x');   // ← 更坏的一行：它会去写 cloud
    assert.equal(view.status.edge, 'warning', '① 终局 MUST 有角标');
    assert.equal(view.status.session, 'idle');
    assert.equal(view.status.cloud, 'disconnected', '① 云端确实被断开了，界面 MUST NOT 说「已连接」');
    assert.equal(view.status.auth, 'login required');
    assert.ok(view.status.edgeFailure?.includes('运行期身份确立失败'), '① 失败卡片 MUST 扛得住日志行覆写');
    assert.match(view.status.presence, /重新登录/, '① 在场感 MUST 给出处理办法');
  }

  // ② 重立成功：里面＝身份换成新号、云端按新身份连上、浏览与观测都回来了。
  {
    const view = shellView();
    view.receive(runtimePostureIpc({ kind: 'identity_halted', reason: '上一局的终局' })); // 先闩上
    const c = wired({ pageIdentity: 'acct-B' });
    c.startGuard();
    await c.guard.check();
    await c.guard.check();
    await settle();
    for (const posture of c.postures) pipe(view)(posture);
    view.log('[aidcp-edge] 自动浏览已启动');
    assert.equal(view.status.edge, 'running', '② 真重立之后 MUST 解除角标，否则核心说健康、外壳说终局');
    assert.equal(view.status.edgeFailure, null);
    assert.equal(view.status.session, 'running', '② 闩解除后日志推断 MUST 重新生效');
    assert.match(view.status.presence, /身份已重新确立/);
  }

  // ③ 重立被作废（宿主暂停 / 冷待机中途叫停）：里面＝这次没做完、基线仍是旧的、云端已补回。
  {
    const view = shellView();
    const c = wired({ pageIdentity: 'acct-B', stopAt: 'stopBrowse' });
    c.startGuard();
    await c.guard.check();
    await c.guard.check();
    await settle();
    assert.equal(c.outcomes[0]?.kind, 'aborted', '前置：确实走的是作废那条路');
    for (const posture of c.postures) pipe(view)(posture);
    view.log('[aidcp-edge] 心跳 ok');
    assert.equal(view.status.edge, 'running', '③ 作废不是失败：MUST NOT 留角标');
    assert.equal(view.status.edgeFailure, null);
    assert.ok(!view.status.presence.includes('正在重新确认'),
      '③ 「正在重新确认身份」是闩住的文案，作废后 MUST 被解除，否则它会永远挂在界面上');
  }

  // ④ 崩在步 11（重设基线）之前：里面＝身份没换成、节点半拆。
  {
    const view = shellView();
    const c = wired({ pageIdentity: 'acct-B', throwAt: 'disconnectCloud' });
    c.startGuard();
    await c.guard.check();
    await c.guard.check();
    await settle();
    for (const posture of c.postures) pipe(view)(posture);
    view.log('[aidcp-edge] 心跳 ok');
    assert.equal(view.status.edge, 'warning', '④ 半拆终局 MUST 有角标');
    assert.equal(view.status.session, 'idle');
    assert.ok(view.status.edgeFailure?.includes('运行期身份确立失败'));
  }

  // ⑤ 崩在步 11 **之后**：里面＝身份完好、云端已按新身份连上，但浏览与观测停着且无人会重启。
  //    这一格是本轮要根除的回归：上一轮它长成「外壳全绿、无角标」。
  {
    const view = shellView();
    const c = wired({ pageIdentity: 'acct-B', throwAt: 'resumeObservation' });
    c.startGuard();
    await c.guard.check();
    await c.guard.check();
    await settle();
    for (const posture of c.postures) pipe(view)(posture);
    view.log('[aidcp-edge] 心跳 ok');
    view.log('[aidcp-edge] 浏览循环结束');
    assert.equal(view.status.edge, 'warning', '⑤ MUST 有角标：浏览与观测永久停着，「运行中、无角标」＝静默假成功');
    assert.equal(view.status.session, 'idle');
    assert.ok(view.status.edgeFailure?.includes('自动化已停摆'), '⑤ 失败卡片 MUST 说清是自动化停摆、不是身份失败');
    assert.ok(!view.status.edgeFailure?.includes('身份确立失败'),
      '⑤ MUST NOT 讲成身份失败：那会把运营推去「重新登录 + 重启」，而有效动作是点「恢复」');
    assert.match(view.status.presence, /恢复/, '⑤ 在场感 MUST 指向正确的处理办法');
    // 而且它 MUST 允许「恢复」——那正是它的处理办法。
    assert.equal(view.clickResume().kind, 'allow', '⑤ MUST NOT 把一台身份完好、只是没跑起来的机器拦死');
  }

  // ⑥ 终局身份下点「恢复」：外壳先判再发 ⇒ 一秒钟都不许出现「运行中」。
  {
    const view = shellView();
    view.receive(runtimePostureIpc({ kind: 'identity_halted', reason: '登录态读不出稳定账号 id' }));
    const verdict = view.clickResume();
    assert.equal(verdict.kind, 'refuse');
    assert.equal(view.status.edge, 'warning', '⑥ 回归形态：这里曾在下发指令前就写成 running，而拒绝走抛异常、没有人来纠正');
    assert.equal(view.status.session, 'paused', '⑥ session MUST NOT 被乐观写成 running');
    assert.match(view.status.lastMessage, /重新登录/, '⑥ 拒绝 MUST 给处理办法');
    // 核心侧那道闸同时也在（外壳闩陈旧时的兜底），且拒绝时会把终局再喊一遍。
    const postures: RuntimePosture[] = [];
    const effects: string[] = [];
    const settled = await resumeAutomationUnderIdentityGate('invalid', {
      logger: () => undefined,
      reportPosture: (p) => void postures.push(p),
      haltReason: () => '登录态读不出稳定账号 id',
      resumeObservation: () => void effects.push('resumeObservation'),
      startBrowse: () => void effects.push('startBrowse'),
      startIdentityGuard: () => void effects.push('startIdentityGuard'),
    }).then(() => 'resolved', () => 'rejected');
    assert.equal(settled, 'rejected', '⑥ 核心侧 MUST 抛出（抛出＝保持暂停态）');
    assert.deepEqual(effects, [], '⑥ 被拒的恢复 MUST 一件副作用都不做');
    assert.deepEqual(postures, [{ kind: 'identity_halted', reason: '登录态读不出稳定账号 id' }]);
  }

  // ⑦ 终局身份下唤醒被拒：外壳侧 MUST 仍然是那个终局（唤醒没能解除它），浏览器已还回槽位。
  {
    const view = shellView();
    view.receive(runtimePostureIpc({ kind: 'identity_halted', reason: '登录态读不出稳定账号 id' }));
    const seq: string[] = [];
    const woke = await refuseWakeUnderIdentityGate('唤醒后仍读不出稳定账号 id', 'browser_wake_identity_unmeasured', {
      logger: () => undefined,
      failInFlightPublishesHonestly: () => void seq.push('fail'),
      detachSession: () => void seq.push('detach'),
      suspendProxyGeneration: () => void seq.push('proxy'),
      killBrowser: async () => void seq.push('kill'),
    });
    view.log('[aidcp-edge] 心跳 ok');
    assert.equal(woke, false);
    assert.deepEqual(seq, ['fail', 'detach', 'proxy', 'kill'], '⑦ 半开的浏览器 MUST 还回槽位，否则它挡着别的账号');
    assert.equal(view.status.edge, 'warning', '⑦ 唤醒没解除终局 ⇒ 界面 MUST 仍是终局');
    assert.equal(view.status.cloud, 'disconnected');
  }

  // ⑧ 终局身份下切云端环境（S9）：MUST 拒绝，且界面仍是终局——绝不以陈旧身份宣称在线。
  {
    const view = shellView();
    view.receive(runtimePostureIpc({ kind: 'identity_halted', reason: '登录态读不出稳定账号 id' }));
    const verdict = judgeCloudRebindUnderIdentity('invalid');
    assert.equal(verdict.kind, 'refuse');
    view.log('[aidcp-edge] 心跳 ok');
    assert.equal(view.status.edge, 'warning');
    assert.equal(view.status.cloud, 'disconnected', '⑧ 重绑被拒 ⇒ 节点对任何云端都不在场，界面 MUST NOT 说「已连接」');
    // 而且此刻云端就算把发布派下来，也不许执行。
    assert.equal(judgeCommandUnderIdentity('invalid', 'publish.command').kind, 'refuse');
  }
});

test('T20bis 跨侧对账：核心与外壳的四态名册 MUST 逐字一致（两份手工契约的唯一机械守卫）', () => {
  assert.deepEqual([...shellPostureModule.RUNTIME_POSTURE_KINDS], [...RUNTIME_POSTURE_KINDS]);
  // IPC 形状不对时 MUST 返回 null（绝不拿半截字段去画界面）。
  assert.equal(shellPostureModule.parseRuntimePosture({ type: RUNTIME_POSTURE_IPC_TYPE }), null);
  assert.equal(shellPostureModule.parseRuntimePosture({ type: RUNTIME_POSTURE_IPC_TYPE, posture: { kind: 'bogus' } }), null);
  assert.equal(shellPostureModule.parseRuntimePosture({ type: 'lifecycle.paused' }), null);
  assert.deepEqual(
    shellPostureModule.parseRuntimePosture(runtimePostureIpc({ kind: 'healthy', accountId: 'acct-B' })),
    { kind: 'healthy', accountId: 'acct-B' },
  );
});


// ── T21 「把闸中性化 → 有用例变红」的七条 ────────────────────────────────────────
//
// 上一轮这七道闸全部**杀不掉**：判据在模块里、动作在宿主的巨型函数里，用例只能扫源码文本，而文本
// 扫描能断言「判据出现了」「顺序在前」，唯独断言不了「拒绝真的会拦」。复验实测：下面每一条只删掉
// 动作、保留判据，26 条用例零红——
//   ① 重绑闸留 `const rebindVerdict = judge…`、删紧随的 `throw`
//   ② 命令闸条件改 `|| true`
//   ③ 发布闸条件改 `false && …`
//   ④ 恢复闸调用尾巴加 `.catch(() => undefined)`
//   ⑤ 外壳拒绝分支删 `return;`
//   ⑥ 日志行 posture 覆盖层整块挪到日志推断之前
//   ⑦ close 分支的清闩删掉（同一字面串三处，扫描只要求存在其一）
// 现在这七处的判据与动作都收进了可注入实现，下面七条用例驱动的就是那些实现本身。

test('T21① 重绑闸：身份未落定时重绑动作一次都不许发生（删掉 throw ⇒ 本条红）', async () => {
  const ran: string[] = [];
  const refused = await rebindCloudUnderIdentityGate('invalid', async (): Promise<string> => {
    ran.push('rebind');
    return 'ok';
  }).then(() => 'resolved', (error: unknown) => (error as Error).message);
  assert.notEqual(refused, 'resolved', '终局身份下 MUST 拒绝');
  assert.match(String(refused), /identity_unresolved/);
  assert.equal(ran.length, 0, '被拒的重绑 MUST 一件副作用都不做——放行了就是以陈旧身份对新云端宣称在线');
  // 重立中同样拦（那一刻我们已经判定页面上的人变了，只是还没换完）。
  await rebindCloudUnderIdentityGate<void>('reestablishing', async () => {
    ran.push('rebind');
  }).catch(() => undefined);
  assert.equal(ran.length, 0);
  // 身份落定 ⇒ 照常放行，且返回值原样交回（闸不许改变正常路径的语义）。
  assert.equal(await rebindCloudUnderIdentityGate('healthy', async () => 'rebound'), 'rebound');
});

test('T21② 命令闸：身份未落定时页面命令 MUST 不执行且有真回执（条件改恒放行 ⇒ 本条红）', () => {
  const executed: string[] = [];
  const receipts: Array<{ action: string; ok: boolean; reason: string }> = [];
  const logs: string[] = [];
  const deps = (health: IdentityHealth): IdentityCommandGateDeps => ({
    health: () => health,
    actionNameFor: (type) => (type === 'xiaohongshu.note.comment' ? 'comment' : type),
    reportActionCompleted: (receipt) => void receipts.push(receipt),
    logger: (line) => void logs.push(line),
  });
  const guarded = (health: IdentityHealth) => guardCommandsUnderIdentity(
    NATIVE_COMMAND_LANE,
    deps(health),
    (env: { type: string }) => void executed.push(env.type),
  );
  guarded('invalid')({ type: 'xiaohongshu.note.comment' });
  assert.deepEqual(executed, [], '被拒的页面命令 MUST NOT 执行——它会以未知身份在平台上留真实痕迹');
  assert.deepEqual(receipts, [{ action: 'comment', ok: false, reason: 'identity_unresolved' }],
    '拒绝 MUST 有回执：静默丢弃会让云端分不清「命令没触达」与「执行了但没结果」，只能等满步超时');
  // 救援 / 读 / 收尾类照常放行（拦掉会把唯一的自救路径也堵死）。
  guarded('invalid')({ type: 'identity.read_current_page' });
  guarded('invalid')({ type: 'session.end' });
  assert.deepEqual(executed, ['identity.read_current_page', 'session.end']);
  // 身份落定 ⇒ 全部放行、不发任何拒绝回执。
  guarded('healthy')({ type: 'xiaohongshu.note.comment' });
  assert.deepEqual(executed.at(-1), 'xiaohongshu.note.comment');
  assert.equal(receipts.length, 1);
});

test('T21③ 发布闸：身份未落定时 MUST 不执行且按发布回执形状如实回（条件改恒假 ⇒ 本条红）', () => {
  const executed: string[] = [];
  const sent: Array<{ payload: Record<string, unknown>; correlationId: string }> = [];
  const guarded = (health: IdentityHealth) => guardPublishCommandsUnderIdentity(
    {
      health: () => health,
      sendResult: (payload, correlationId) => void sent.push({ payload, correlationId }),
      logger: () => undefined,
    },
    (env: { id: string }) => void executed.push(env.id),
  );
  const env = { id: 'env-1', type: 'publish.command' as const, payload: { recordId: 7, seq: 2, kind: 'fill_title' } };
  guarded('invalid')(env);
  assert.deepEqual(executed, [], '被拒的发布 MUST NOT 执行——发布是在平台上留真实痕迹的动作');
  assert.equal(sent.length, 1, '拒绝 MUST 回执，否则云端挂起等一个不会来的结果');
  assert.equal(sent[0]?.correlationId, 'env-1', '回执按信封 id 关联，否则云端认不出是哪一条');
  assert.deepEqual(sent[0]?.payload, {
    recordId: 7, seq: 2, kind: 'fill_title', ok: false, error: 'identity_unresolved',
  });
  guarded('healthy')(env);
  assert.deepEqual(executed, ['env-1']);
  assert.equal(sent.length, 1, '放行路径 MUST NOT 多发一条结果');
});

test('T21④ 恢复闸：被拒的恢复 MUST 以 reject 收场（吞掉拒绝 ⇒ 本条红）', async () => {
  const effects: string[] = [];
  const postures: RuntimePosture[] = [];
  const make = (health: IdentityHealth, browserAbsent = false) => automationResumeCallback({
    health: () => health,
    browserAbsent: () => browserAbsent,
    logger: () => undefined,
    reportPosture: (posture) => void postures.push(posture),
    haltReason: () => '登录态读不出稳定账号 id',
    resumeObservation: () => void effects.push('resumeObservation'),
    startBrowse: () => void effects.push('startBrowse'),
    startIdentityGuard: () => void effects.push('startIdentityGuard'),
  });
  const refused = await make('invalid')().then(() => 'resolved', () => 'rejected');
  assert.equal(refused, 'rejected',
    '抛出＝保持暂停态。吞掉它，生命周期控制器就会发出「已恢复」，界面画成运行中，而三件恢复动作一件都没做');
  assert.deepEqual(effects, [], '被拒的恢复 MUST 一件副作用都不做');
  assert.deepEqual(postures, [{ kind: 'identity_halted', reason: '登录态读不出稳定账号 id' }],
    '拒绝时 MUST 把终局再喊一遍，把外壳可能已抢先写下的乐观投影纠回来');
  // 浏览器缺席也必须以 reject 收场（那条路要走唤醒，不是恢复）。
  assert.equal(await make('healthy', true)().then(() => 'resolved', (e: unknown) => (e as Error).message),
    'browser_absent_use_wake');
  assert.deepEqual(effects, []);
  // 身份完好 ⇒ 三件恢复动作按序发生，并解除可能挂着的残局闩。
  await make('healthy')();
  assert.deepEqual(effects, ['resumeObservation', 'startBrowse', 'startIdentityGuard']);
  assert.deepEqual(postures.at(-1), { kind: 'healthy' });
});

test('T21⑤ 外壳恢复按钮：终局身份下 MUST 不往下走（删掉早退 ⇒ 本条红）', () => {
  const view = shellView();
  view.receive(runtimePostureIpc({ kind: 'identity_halted', reason: '登录态读不出稳定账号 id' }));
  const refused = view.clickResume();
  assert.equal(refused.kind, 'refuse');
  assert.equal(refused.proceeded, false,
    '拒绝分支 MUST NOT 继续往下：往下走就会把界面写成运行中并真的下发恢复，而没有任何东西来纠正');
  assert.equal(view.status.edge, 'warning');
  assert.equal(view.status.session, 'paused');
  // 残局（身份完好、只是没跑起来）MUST 放行——点「恢复」正是它的处理办法。
  const stalled = shellView();
  stalled.receive(runtimePostureIpc({ kind: 'automation_stalled', reason: '收尾步骤异常' }));
  const allowed = stalled.clickResume();
  assert.equal(allowed.kind, 'allow');
  assert.equal(allowed.proceeded, true);
});

test('T21⑥ 日志行覆盖层：闩住期间四轴 MUST 由 posture 压回（不施加覆盖 ⇒ 本条红）', () => {
  const halted = { kind: 'identity_halted', reason: '读不出稳定账号 id' };
  // 一行「已连接云端」的日志推断会写 cloud:'connected'——闩住时它 MUST 被压回 disconnected。
  const committed = shellPostureModule.commitPatchUnderPosture(
    halted,
    { edge: 'running', session: 'running', cloud: 'connected', lastMessage: '已连接云端' },
    '2026-07-30T00:00:00.000Z',
  ) as Record<string, unknown>;
  assert.equal(committed.cloud, 'disconnected', '云端确实被主动断开了，界面 MUST NOT 说「已连接」');
  assert.equal(committed.session, 'idle');
  assert.equal(committed.auth, 'login required');
  assert.equal(committed.edge, 'warning');
  assert.equal((committed.presence as { text: string }).text, '身份已失效，请重新登录后重启');
  assert.equal(committed.lastMessage, '已连接云端', 'lastMessage 是滚动叙述，本就该被这一行覆写');
  // 没有闩 ⇒ 原样交回（覆盖层绝不在健康态下越权改四轴）。
  const next = { edge: 'running', cloud: 'connected' };
  assert.equal(shellPostureModule.commitPatchUnderPosture(null, next, 'x'), next);
});

test('T21⑦ 闩的作用域＝说它的那次 core run：核心退出 / 换代之后 MUST 立刻失效', () => {
  const view = shellView();
  view.receive(runtimePostureIpc({ kind: 'identity_halted', reason: '读不出稳定账号 id' }));
  assert.ok(view.liveLatch(), '前置：本次 core run 说的话，当然有效');
  view.log('[aidcp-edge] 心跳 ok');
  assert.equal(view.status.edge, 'warning');

  view.coreExited();
  assert.equal(view.liveLatch(), null,
    '进程都没了，posture 就不再描述任何东西：留着会把「已停止」压成「身份已失效」');
  view.log('[aidcp-edge] 心跳 ok');
  assert.equal(view.status.edge, 'running', '核心退出后 MUST NOT 再由旧闩压四轴（终局归因走退出码那条权威判据）');

  const respawned = shellView();
  respawned.receive(runtimePostureIpc({ kind: 'automation_stalled', reason: '收尾步骤异常' }));
  respawned.respawnCore();
  assert.equal(respawned.liveLatch(), null, '新拉起的核心会自己重走一遍并重新发 posture，绝不继承上一轮的残局');
});

// ── T22 本轮新引入的回归：一次普通唤醒把外壳无条件写成运行中并清掉失败卡片 ──────────
test('T22 健康态 posture 只在真闩着时才动界面；关闭意图优先', () => {
  // ① 一个已暂停、挂着一张**与身份无关**的失败卡片的环境（代理运行证据缺失）。
  const view = shellView();
  Object.assign(view.status, {
    edge: 'warning',
    session: 'paused',
    presence: '自动化已暂停',
    edgeFailure: '代理运行证据缺失：未取得出口自证',
  });
  // 唤醒实测到了身份 ⇒ 核心照常发一条 healthy{accountId}（每次唤醒都会来一条，这是常态）。
  view.receive(runtimePostureIpc({ kind: 'healthy', accountId: 'acct-A' }));
  assert.equal(view.status.edge, 'warning', '没有闩可解 ⇒ MUST NOT 把环境写成运行中');
  assert.equal(view.status.session, 'paused');
  assert.equal(view.status.edgeFailure, '代理运行证据缺失：未取得出口自证',
    '身份健康与这张卡片无关，MUST NOT 顺手把别人的失败态擦掉');
  assert.equal(view.status.presence, '自动化已暂停');

  // ② 真闩着时，同一条消息照旧要解闩（这才是健康态投影的用途）。
  const latched = shellView();
  latched.receive(runtimePostureIpc({ kind: 'identity_halted', reason: '读不出稳定账号 id' }));
  assert.ok(latched.status.edgeFailure?.includes('运行期身份确立失败'));
  latched.receive(runtimePostureIpc({ kind: 'healthy', accountId: 'acct-A' }));
  assert.equal(latched.status.edge, 'running');
  assert.equal(latched.status.edgeFailure, null);
  assert.match(latched.status.presence, /身份已重新确立/);

  // ③ 关闭意图优先：唤醒撞上关闭时，迟到的 posture MUST NOT 把界面翻回运行中。
  const closing = shellView();
  closing.receive(runtimePostureIpc({ kind: 'identity_halted', reason: '读不出稳定账号 id' }));
  Object.assign(closing.status, { edge: 'idle', session: 'idle', lastMessage: '正在关闭…' });
  closing.receive(runtimePostureIpc({ kind: 'healthy', accountId: 'acct-A' }), { closeIntent: true });
  assert.equal(closing.status.edge, 'idle', '关闭意图优先：外壳别处已有同款守卫，posture 这一笔比它先到、不能例外');
  assert.equal(closing.status.lastMessage, '正在关闭…');
  assert.equal(closing.liveLatch(), null, '闩本身照旧按事实更新（只是不画）');
});

// ── T23 `automation_stalled` 的第二道网 ──────────────────────────────────────────
test('T23 残局 MUST 在 IPC 之外还有一条网：核心自己的日志行能被外壳终态白名单认出', async () => {
  // ① 步 11 之后崩（身份完好、收尾没做完）——真链条跑出来的真日志。
  const crashed = wired({ pageIdentity: 'acct-B', throwAt: 'resumeObservation' });
  crashed.startGuard();
  await crashed.guard.check();
  await crashed.guard.check();
  await settle();
  assert.equal(crashed.outcomes[0]?.kind, 'crashed', '前置：确实走的是收尾崩掉那条路');
  assert.ok(
    crashed.logs.some((line) => shellFleet.declaresCoreHalt(line)),
    '残局态的 posture IPC 在父子通道断开时是静默 no-op；只有这一条边时，丢了就退回「全绿无角标」',
  );
  assert.ok(crashed.logs.some((line) => line.includes(AUTOMATION_STALLED_HALT_PHRASE)));

  // ② 作废回滚时云端没连回来（另一条走向残局的路）同样要落到白名单里。
  const abortLogs: string[] = [];
  const abortPostures: RuntimePosture[] = [];
  let generation = 0;
  const stalledOnAbort = createIdentityReestablishment({
    logger: (m) => abortLogs.push(m),
    suspendObservation: () => undefined,
    stopBrowse: async () => undefined,
    failInFlightPublishesHonestly: () => undefined,
    hasActiveLease: () => false,
    resetTaskCoordinator: () => undefined,
    // 在这一步之后叫停：此刻云端连接**是本链条断的**，作废回滚必须把它补回来——补不回来就是残局。
    disconnectCloud: async () => { generation += 1; },
    navigateToConsumerHome: async () => undefined,
    readIdentity: async () => identified('acct-B'),
    decideIdentity: () => ({ kind: 'use', accountId: 'acct-B', source: 'in-place' }),
    nicknameFor: () => undefined,
    applyIdentity: () => undefined,
    connectCloud: async () => { throw new Error('云端连不上'); },
    rebaseline: () => undefined,
    resumeObservation: () => undefined,
    startBrowse: () => undefined,
    generation: () => generation,
    reportPosture: (posture) => void abortPostures.push(posture),
  });
  const outcome = await stalledOnAbort({ kind: 'lost' });
  assert.equal(outcome.kind, 'aborted');
  assert.deepEqual(abortPostures.at(-1)?.kind, 'automation_stalled');
  assert.ok(
    abortLogs.some((line) => shellFleet.declaresCoreHalt(line)),
    '这条路同样只有 posture 一条边，必须也留下白名单措辞',
  );

  // ③ IPC 送不到时，核心 MUST 自己补一行白名单措辞（process.send 在通道断开时是静默 no-op）。
  for (const posture of [
    { kind: 'identity_halted', reason: 'r' } as const,
    { kind: 'automation_stalled', reason: 'r' } as const,
  ]) {
    const lines: string[] = [];
    publishPostureWithFallback(posture, { sendIpc: () => false, logger: (line) => lines.push(line) });
    assert.equal(lines.length, 1, `${posture.kind}：IPC 丢了 MUST 有日志兜底`);
    assert.ok(shellFleet.declaresCoreHalt(lines[0]!), `${posture.kind}：兜底行 MUST 能被外壳白名单认出`);
  }
  // 送达时不重复喊（否则每一次终局都会多一条噪声行）。
  const quiet: string[] = [];
  publishPostureWithFallback({ kind: 'identity_halted', reason: 'r' }, { sendIpc: () => true, logger: (l) => quiet.push(l) });
  assert.deepEqual(quiet, []);

  // ④ 送达判据**本身**（上面三段传的都是假的 sendIpc，驱动不到它）。
  //    这条判据是整条第二道网的开关：判成「送到了」就永远不会有兜底行。把它改成恒 true ⇒ 本段当场红。
  {
    const sent: unknown[] = [];
    assert.equal(
      deliverLifecycleIpc({ connected: true, send: (payload) => void sent.push(payload) }, { type: 'x' }),
      true,
      '通道在、send 在 ⇒ 真发出去并如实报送达',
    );
    assert.equal(sent.length, 1);
    assert.equal(
      deliverLifecycleIpc({ connected: false, send: () => undefined }, { type: 'x' }),
      false,
      '通道已断 ⇒ process.send 是静默 no-op，MUST 判成没送到（否则第二道网永不触发）',
    );
    assert.equal(
      deliverLifecycleIpc({ connected: true }, { type: 'x' }),
      false,
      '不是 fork 起来的进程没有 send ⇒ MUST 判成没送到，且绝不抛',
    );
    assert.equal(deliverLifecycleIpc({}, { type: 'x' }), false);
  }
});

// ── T24 负向应答尚未接线的通道：不伪造回执，但必须响亮 + 必须留下可执行配方 ──────────
test('T24 任务租约通道被身份闸拒绝时 MUST NOT 伪造一条云端收不到的回执', () => {
  const executed: string[] = [];
  const receipts: unknown[] = [];
  const logs: string[] = [];
  const guarded = guardCommandsUnderIdentity(
    EDGE_TASK_LANE,
    {
      health: () => 'invalid',
      actionNameFor: (type) => type,
      reportActionCompleted: (receipt) => void receipts.push(receipt),
      logger: (line) => void logs.push(line),
    },
    (env: { type: string }) => void executed.push(env.type),
  );
  guarded({ type: 'edge.task.acquire' });
  assert.deepEqual(executed, [], '认领＝接下来会以这个账号的名义动作 + 记账，身份未落定时 MUST 拦');
  assert.deepEqual(receipts, [],
    '负向应答的形状（edge.task.released + reason）存在，但「身份未落定」这个 reason 还没接线；'
    + '发一条云端不认识的 action.completed 比不发更坏——它让人以为已经兑现了');
  assert.equal(logs.length, 1, '不发回执 ≠ 静默丢弃：本地必须响亮记一笔');
  // 缺口的**陈述必须是真的**，且必须带落点：只说「没有路」会让下一个人以为无路可走、从而永远不去补。
  assert.match(logs[0]!, /edge\.task\.released/, '必须点名那条本来就存在的负向应答形状');
  assert.match(logs[0]!, /reason 枚举值/, '必须说清缺的只是一个枚举值，而不是「没有形状」');
  assert.match(logs[0]!, /protocol\.ts/, '必须给出补齐的落点');
  assert.match(logs[0]!, /acquire_timeout/, '必须说清不补的代价（云端空等满自己的超时）');
  assert.doesNotMatch(logs[0]!, /没有负向应答形状/, '这句话是假的，MUST NOT 再出现');
  // 释放永远放行（拦掉只会让租约挂着不放、云端一直以为任务在跑）。
  guarded({ type: 'edge.task.release' });
  assert.deepEqual(executed, ['edge.task.release']);
});

// ── 1.9① 宿主侧接线（**弱断言**：源码文本扫描，不计入行为覆盖）──────────────────
//
// 下面这条只证明「宿主源码里写了这几处调用」，证不了运行时真的按顺序发生。
// 之所以退化成文本扫描：这三处接线的落点是 `src/main.ts` 的一个 1400 行无导出单 `main()`，
// 拿不到可注入的句柄。真行为覆盖在会话侧（browse-session.test.ts 的 suspend/resume 幂等用例）
// 与上面 T1–T7；这条只防「有人把接线整段删掉」。
test('1.9① 弱断言（源码扫描）：执行器终态停观测、冷待机停观测、重连整批重启', () => {
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/main.ts'), 'utf8');

  const isolateStart = main.indexOf('const isolateExecutorFailure');
  const isolateEnd = main.indexOf('// Input 超时', isolateStart);
  assert.ok(isolateStart >= 0 && isolateEnd > isolateStart);
  assert.match(
    main.slice(isolateStart, isolateEnd),
    /suspendObservation\(reason\)/,
    '执行器终态（cdp.unrecoverable / cdp.control_unavailable 的共同收口）必须停掉周期观测——'
      + '冷待机在有活跃租约 / 复用外部浏览器时会被拒绝，把停手挂在待机路径上会漏',
  );

  const standbyStart = main.indexOf('enterStandby: async () => {');
  const standbyEnd = main.indexOf('wakeFromStandby: async', standbyStart);
  assert.ok(standbyStart >= 0 && standbyEnd > standbyStart);
  assert.match(main.slice(standbyStart, standbyEnd), /suspendObservation\('cold_standby'\)/);

  const reconnStart = main.indexOf("session.cdp.on('cdp.reconnected'");
  const reconnEnd = main.indexOf("process.on('SIGINT'", reconnStart);
  assert.ok(reconnStart >= 0 && reconnEnd > reconnStart, '必须存在 cdp.reconnected 订阅');
  assert.match(main.slice(reconnStart, reconnEnd), /resumeObservation\(\)/);
});

// ── 宿主装配契约（源码扫描）：**只证「这一行接线还在」，不再假装能证「闸真的会拦」** ──────
//
// 这一条的边界必须写死，否则下一个人又会往里加断言、以为加满了就等于有覆盖：
//   能证的：宿主没有把闸整段删掉 / 绕过去自己另写一份（那正是这一批缺陷的共同形态）。
//   证不了的：拒绝真的会拦。上一轮整套断言就是在这里失守的——留着判据、删掉动作，26 条用例零红。
// 所以本轮把七道闸的**判据 + 动作**全部搬进了可注入实现（identity-guard / identity-command-gate /
// runtime-posture.cjs），行为覆盖在 T20 / T21 / T22 / T23 / T24：中性化那些实现里的任何一处，
// 那几条用例当场红。这里只剩「接线还在吗」这一件文本能诚实回答的事。
test('宿主装配契约（源码扫描）：闸的接线还在、且没有被搬回宿主大闭包里自己写一遍', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const main = readFileSync(join(here, '../../src/main.ts'), 'utf8');
  const shell = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');

  const guardStart = main.indexOf('identityGuard = new IdentityRevalidator(');
  const guardEnd = main.indexOf('startIdentityGuard = (): void =>', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart, '必须存在身份校验体 + 重立链的装配块');
  const block = main.slice(guardStart, guardEnd);

  // ① 分域判据按平台走：写死小红书判据会让 FB 侧永久空转。
  assert.match(block, /platformDriver\.classifyIdentityContext\(/);
  assert.doesNotMatch(block, /readPageContext\(session\.cdp\)/,
    '运行期分域 MUST NOT 直接用小红书专用判据（facebook.com 会一律归 unknown、永远跳过）');

  // ② 两种读预算分开：周期校验用小预算常量，归位后重读由链条给（宿主原样转发、不得写死）。
  assert.match(block, /hydrateTimeoutMs: PERIODIC_IDENTITY_READ_HYDRATE_MS/);
  assert.match(block, /readIdentity: \(options\) => readIdentityInPlace\(\{ \.\.\.options/,
    '归位后重读的预算 MUST 由链条给、宿主原样转发；写死一个小预算＝把「还没渲染完」判成终局失败');
  assert.doesNotMatch(block, /hydrateTimeoutMs: 1_000/,
    '装配块里 MUST NOT 再出现写死的 1s 预算（它曾同时服务周期校验与归位后重读）');

  // ③ 基线口径 = 页面实测值，不是可能被覆盖的握手身份。
  assert.match(block, /new IdentityRevalidator\(observedAccountId \?\? accountId \?\? ''/);
  assert.match(main, /observedAccountId = observedAccountIdFromDecision\(resolved\)/);

  // ④ 取消点与「对外呈现只经一条边」都接上了。行为覆盖：T11 / T20 / T23。
  assert.match(block, /generation: \(\) => identityGuard\?\.generation/);
  assert.match(block, /reportPosture: publishRuntimePosture/,
    '链条的对外通告 MUST 走那条唯一的边；宿主自己另拼一条 IPC 就是在重造分岔');
  assert.match(main, /const publishRuntimePosture = \(posture: RuntimePosture\): void =>/);
  assert.match(main, /publishPostureWithFallback\(posture, \{/,
    'posture MUST 经带日志兜底的那条出口发（IPC 在父子通道断开时是静默 no-op，行为覆盖见 T23③）');
  // 送达判据 MUST 在可注入模块里：内联在 main() 闭包时用例只能传假的 sendIpc，真判据零覆盖
  //（改成恒 true ⇒ 第二道网整条蒸发而全绿）。行为覆盖见 T23④。
  assert.match(
    main,
    /const sendLifecycleIpc = \(payload: Record<string, unknown>\): boolean => deliverLifecycleIpc\(process, payload\);/,
    '「送到了吗」MUST 由可注入判据回答，宿主不得内联一份自己的',
  );

  // ⑤ 恢复自动化：宿主**连 async 壳都不写**，整段是可注入实现。行为覆盖 T15quater / T20⑥ / T21④。
  //    留一层壳就够被削弱：给那句 await 加 `.catch(() => undefined)`，拒绝被吞、控制器发出「已恢复」。
  assert.match(main, /resumeAutomation: automationResumeCallback\(\{/,
    '恢复自动化 MUST 整段交给可注入实现，宿主不得自己写 async 壳');
  const resumeStart = main.indexOf('resumeAutomation: automationResumeCallback({');
  const resumeEnd = main.indexOf('deactivate: async (reason)', resumeStart);
  assert.ok(resumeStart >= 0 && resumeEnd > resumeStart, '必须存在 resumeAutomation 装配');
  const resumeBlock = main.slice(resumeStart, resumeEnd);
  assert.match(resumeBlock, /browserAbsent: \(\) => coldStandbyActive/);
  assert.match(resumeBlock, /resumeObservation: \(\) => nativeBrowse\?\.resumeObservation\(\)/,
    '恢复自动化 MUST 一并恢复周期观测，否则浏览重开了但阻断观测永久全盲');
  assert.doesNotMatch(resumeBlock, /await resumeAutomationUnderIdentityGate/,
    '宿主 MUST NOT 再自己 await 一次闸——那层壳正是 `.catch(() => undefined)` 的落脚点');

  // ⑤bis 链条回执 MUST 回喂校验体：判失效之后校验体停在「重立中」抑制判定，回执是它唯一的出口。
  // 少了这一行，暂停→恢复之后运行期身份校验永久哑火（换号再也测不出来），行为覆盖见 T14。
  const startGuardStart = main.indexOf('startIdentityGuard = (): void => {');
  const startGuardEnd = main.indexOf('if (!coldStandbyActive && !startAutomationPaused) startIdentityGuard();', startGuardStart);
  assert.ok(startGuardStart >= 0 && startGuardEnd > startGuardStart, '必须存在 startIdentityGuard 装配');
  const startGuardBlock = main.slice(startGuardStart, startGuardEnd);
  assert.match(startGuardBlock, /noteReestablishmentOutcome\(outcome\)/,
    '链条回执 MUST 回喂校验体，否则被叫停作废之后它永久停在「重立中」再也不判定');
  assert.match(startGuardBlock, /kind: 'crashed'/,
    '连兜底都抛了的那条路 MUST 照样收口状态机，绝不留一个永远等不到回执的中间态');

  // ⑥ 外壳侧：闩的转移、覆盖层的施加、恢复准入三处都只经模块，且**都不是可以挪位置的块**。
  //    行为覆盖在 T20 / T21⑤⑥⑦ / T22；这条只防「有人在别处再拼一份状态」。
  assert.match(shell, /const transition = runtimePostureTransition\(livePosture\(handle\), posture, \{/);
  assert.match(shell, /closeIntent: Boolean\(handle\.stopRequested \|\| handle\.removed \|\| isQuitting\)/,
    '关闭意图优先：外壳别处已有同款守卫，posture 这一笔比它先到、不能例外（行为覆盖 T22③）');
  assert.match(shell, /handle\.runtimePosture = transition\.latch;/);
  // ⑥bis 上面那行只存**闩**；把 posture 画到界面上的是紧挨着的下一行，而它此前零覆盖——
  //      删掉它，闩照存、四轴照被覆盖层压住，但**持久失败卡片永不出现**（那一笔是红卡的唯一写入口，
  //      终局与残局的红卡全靠它）。存了不画＝「判了但不据此动作」，本系列在追的正是这一族。
  assert.match(
    shell,
    /if \(transition\.patch\) updateStatus\(handle, posturePatch\(handle, transition\.patch\)\);/,
    'posture 转移 MUST 真的落到界面上；只存闩不画界面＝红卡永不出现',
  );
  // 翻译本体 MUST 在可注入模块里（行为覆盖：T20①④⑤ 的 edgeFailure 断言现在驱动的是真函数）。
  // 宿主这一处只许是薄接线；再抄一份等价逻辑，删掉模块里那一格就又测不到了。
  assert.match(shell, /return posturePatchFrom\(projection, \{/,
    'posture 投影 → 补丁的翻译 MUST 走 runtime-posture.cjs 的真实现，宿主 MUST NOT 自己再写一份');
  assert.match(shell, /fleet\.declaresCoreHalt\(message\) \|\| postureLatches\(livePosture\(handle\)\)/);
  // 覆盖层与落盘是**同一个表达式**：上一轮它是末尾一整块 if，整块挪到日志推断之前，扫描照样全绿。
  assert.match(
    shell,
    /updateStatus\(handle, commitPatchUnderPosture\(livePosture\(handle\), next, new Date\(\)\.toISOString\(\)\)\);/,
    'posture 覆盖层 MUST 合成在唯一那次落盘调用的实参位置上，绝不写成可以整块挪动的 if',
  );
  assert.doesNotMatch(shell, /const postureOverride = runtimePostureOverride\(/,
    '外壳 MUST NOT 再自己取覆盖层后手工 Object.assign（那正是可挪动的那一块）');
  // 闩的作用域由**读侧**判（postureOfLiveCore），不再靠三处手工清闩——那三处同一字面串，删掉任一处
  // 既扫不出也测不到。行为覆盖 T21⑦。
  assert.match(shell, /function livePosture\(handle\) \{\n\s*return postureOfLiveCore\(handle\.runtimePosture, handle\.runtimePostureCore, handle\.child\);/,
    '闩的有效性 MUST 在读的时候判；宿主里 MUST NOT 有第二种取闩方式');
  assert.doesNotMatch(shell, /postureLatches\(handle\.runtimePosture\)/,
    '任何直读 handle.runtimePosture 的判定都绕过了作用域判据，MUST 一律经 livePosture()');
  // 恢复按钮：分支本体在模块里，宿主只提供 refuse / proceed 两个出口（行为覆盖 T21⑤）。
  assert.match(shell, /runResumeUnderPosture\(livePosture\(handle\), \{/);
  assert.match(shell, /proceed: \(\) => resumeEdgeUnderPosture\(handle\),/);
  assert.equal(
    (shell.match(/resumeEdgeUnderPosture\(/g) ?? []).length,
    2,
    '闸后的动作 MUST 只有「定义 + 闸的 proceed 出口」两处；出现第三处＝有人在闸之外先跑了一遍',
  );
  assert.doesNotMatch(shell, /const resumeVerdict = judgeResumeUnderPosture\(/,
    '外壳 MUST NOT 再自己判一次再自己 return——那句 return 删掉就恢复照发，且扫不出来');

  // ⑦ 唤醒后的身份收口 MUST 与 resumeAutomation 解耦：宿主只调收口函数，自己不再判「要不要重设基线」。
  //    行为覆盖在 T15；这条只防「有人把它挪回 `if (resumeAutomation)` 里」。
  const wakeStart = main.indexOf('wakeFromStandby: async (resumeAutomation) => {');
  const wakeEnd = main.indexOf('exit: (code) => process.exit(code)', wakeStart);
  assert.ok(wakeStart >= 0 && wakeEnd > wakeStart, '必须存在冷待机唤醒块');
  const wakeBlock = main.slice(wakeStart, wakeEnd);
  assert.match(wakeBlock, /judgeWakeIdentityResettlement\(decision, identityGuard\?\.health/,
    '唤醒后的收口判据 MUST 由 identity-guard 给（宿主里没有可单测的缝，自己判就没人钉得住）');
  assert.match(wakeBlock, /await applyWakeIdentityResettlement\(resettlement, resumeAutomation,/);
  assert.doesNotMatch(wakeBlock, /if \(resumeAutomation\)/,
    '唤醒块里 MUST NOT 再自己按 resumeAutomation 分叉——身份收口与自动化是两根独立的轴');
  assert.doesNotMatch(wakeBlock, /identityGuard\?\.rebaseline\(wakeBaseline\)/,
    '基线 MUST NOT 再由宿主自己拼（曾经拼成 observedAccountId ?? accountId：读不出时会把覆盖值钉进校验体）');

  // ⑧ 唤醒的首登辅助、身份读取与终局解除三条拒绝路径都走**真拆**的可注入实现
  //    （行为覆盖见 T19 / T20⑦，首登辅助见 automate-facebook-first-login）。
  assert.match(wakeBlock, /reportPosture: publishRuntimePosture/);
  assert.equal(
    (wakeBlock.match(/refuseWakeUnderIdentityGate\(/g) ?? []).length,
    3,
    '「首登辅助失败」「读不出身份」「唤醒没能解除终局」三条路 MUST 共用同一个真拆收场，绝不各写一份',
  );

  // ⑨ S9 身份闸：重绑与三个命令入口都过闸（行为覆盖见 T18 / T20⑧ / T21①②③ / T24）。
  //    这里只断言「包裹还在」——闸体本身（判据 + 拒绝动作）已在 identity-command-gate.ts 里，
  //    中性化它会让 T21①②③ / T24 当场红。
  assert.match(main, /await rebindCloudUnderIdentityGate\(identityGuard\?\.health, async \(\) => \{/,
    '重绑动作 MUST 整段作为回调交给闸；宿主留一句 `if (…) throw` 就可以被删成「判了不拦」');
  assert.doesNotMatch(main, /const rebindVerdict = judgeCloudRebindUnderIdentity/,
    '宿主 MUST NOT 再自己取裁决再自己 throw');
  assert.match(main, /client\.onEdgeTaskCommand\(guardCommandsUnderIdentity\(EDGE_TASK_LANE, identityGateDeps,/);
  assert.match(main, /guardCommandsUnderIdentity\(\n\s*NATIVE_COMMAND_LANE,\n\s*identityGateDeps,/);
  assert.equal(
    (main.match(/nativeSession\.onCloudCommand\(/g) ?? []).length,
    1,
    '页面命令的执行入口 MUST 只有闸内那一处；出现第二处＝有人绕过闸直接派发',
  );
  assert.match(main, /client\.onPublishAtomCommand\(guardPublishCommandsUnderIdentity</);
  assert.doesNotMatch(main, /const refuseCommandUnderIdentity = /,
    '宿主 MUST NOT 再自己写一份「判 + 回执 + return true」——那份可以被改成恒放行且扫不出来');

  // ⑦ 那句被坐实为假的话 MUST NOT 活在任何一处源码里。
  //
  // 「协议上没有负向应答形状」是错的：形状就是 `edge.task.released` + `reason`，云端 onReleased 对已知
  // 原因即刻 reject、不等 acquire 超时，边缘协调器本身就在用它。缺的只是「身份未落定」这一档 reason。
  // 之所以要为一句注释写断言：读代码的人先到接线现场，被那句话告知「无路可走」，就永远不会去补那一档
  // ——这正是本批工作在追的那族病（写着有、其实没有；说没路、其实有路），只是落在了文字上。
  // 用例既有的日志断言（T24）钉的是运行时字符串，钉不住源码里的拷贝，所以这里单独扫一遍。
  for (const [name, source] of [['src/main.ts', main], ['src/electron/main.cjs', shell]] as const) {
    assert.doesNotMatch(source, /没有\*{0,2}负向应答形状/, `${name} 里不得再出现那句已被坐实为假的陈述`);
  }
  assert.doesNotMatch(main, /ack:\s*'none'|`ack:'none'`/,
    "'none' 这个枚举值已删（现为 'unwired'：形状在、这一档 reason 未接线）；注释里也不许留");
});
