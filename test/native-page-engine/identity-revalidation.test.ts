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
  createIdentityReestablishment,
  judgeRuntimeIdentity,
  observedAccountIdFromDecision,
  reestablishIdentityReadOptions,
  PERIODIC_IDENTITY_READ_HYDRATE_MS,
  REESTABLISH_IDENTITY_READ_HYDRATE_MS,
  type IdentityInvalidReason,
  type IdentityPageContext,
  type ObservationLiveness,
} from '../../src/native-page-engine/identity-guard.js';
import type {
  IdentityDecision,
  ReadSelfIdentityOptions,
  SelfIdentityResult,
} from '../../src/cdp/self-identity.js';
import { facebookPlatformDriver, classifyFacebookIdentityContext } from '../../src/facebook/driver.js';
import { xhsPlatformDriver } from '../../src/xhs/driver.js';

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
  assert.equal(flipped.guard.health, 'invalid');
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
    reportHalt: (reason) => void halts.push(reason),
  });
  return { run, seq, state, logs, halts, readOpts, rebaselined };
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

// ── 宿主装配契约（源码扫描）：上面 T8–T13 证的是判据本身，这一条证「宿主真按判据接线」──────
//
// 这几处的落点同样在 `src/main.ts` 的无导出单 `main()` 里，拿不到可注入句柄。判据（预算、分域、
// 基线口径、IPC）已经在 T8–T13 里被真行为覆盖；这条只钉住「宿主没有绕过它们自己另写一套」——
// 那正是这一批缺陷的共同形态：判据写对了，宿主装配处把它绕过去了。
test('宿主装配契约（源码扫描）：分域按平台走、两种读预算分开、基线用实测值、halt 走 IPC', () => {
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

  // ④ 取消点与 halt 通告都接上了。
  assert.match(block, /generation: \(\) => identityGuard\?\.generation/);
  assert.match(block, /sendLifecycleIpc\(\{ type: 'lifecycle\.identity_halted', reason \}\)/);

  // ⑤ 被叫停的链条留下的「观测还停着」由宿主的恢复路径补上——链条自己不补（见 T11③）。
  const resumeStart = main.indexOf('resumeAutomation: async () => {');
  const resumeEnd = main.indexOf('deactivate: async (reason)', resumeStart);
  assert.ok(resumeStart >= 0 && resumeEnd > resumeStart, '必须存在 resumeAutomation');
  assert.match(
    main.slice(resumeStart, resumeEnd),
    /nativeBrowse\?\.resumeObservation\(\)/,
    '恢复自动化 MUST 一并恢复周期观测，否则浏览重开了但阻断观测永久全盲',
  );

  // ⑥ 外壳真的处理这条 IPC，并把它闩住（否则下一行普通日志就把徽标重置回 running）。
  assert.match(shell, /message\.type === 'lifecycle\.identity_halted'/);
  assert.match(shell, /handle\.identityHalted = reason/);
  assert.match(shell, /fleet\.declaresCoreHalt\(message\) \|\| Boolean\(handle\.identityHalted\)/);
  assert.match(shell, /handle\.identityHalted = null/, '新拉起的核心 MUST 清掉上一轮的 halt 闩');
});
