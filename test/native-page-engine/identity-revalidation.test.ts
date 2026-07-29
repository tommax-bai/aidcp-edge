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
import {
  IdentityRevalidator,
  createIdentityReestablishment,
  type IdentityInvalidReason,
  type IdentityPageContext,
  type ObservationLiveness,
} from '../../src/native-page-engine/identity-guard.js';
import type { IdentityDecision, SelfIdentityResult } from '../../src/cdp/self-identity.js';

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
    readPageContext: async () => setup.contexts[Math.min(ctxIdx++, setup.contexts.length - 1)]!,
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
} = {}) {
  const seq: string[] = [];
  const state = { accountId: 'acct-A', nickname: undefined as string | undefined };
  const run = createIdentityReestablishment({
    logger: () => undefined,
    suspendObservation: () => void seq.push('suspendObservation'),
    stopBrowse: async () => void seq.push('stopBrowse'),
    failInFlightPublishesHonestly: () => void seq.push('failInFlightPublishesHonestly'),
    hasActiveLease: () => over.hasActiveLease ?? false,
    resetTaskCoordinator: () => void seq.push('resetTaskCoordinator'),
    disconnectCloud: async () => void seq.push('disconnectCloud'),
    navigateToConsumerHome: async () => {
      seq.push('navigateToConsumerHome');
      if (over.navigateThrows) throw new Error('Page.navigate 失败');
    },
    readIdentity: async () => {
      seq.push('readIdentity');
      return over.idRes ?? identified('acct-B');
    },
    decideIdentity: () => over.decision ?? { kind: 'use', accountId: 'acct-B', source: 'in-place' },
    nicknameFor: () => 'nick-B',
    applyIdentity: (accountId, nickname) => {
      seq.push('applyIdentity');
      state.accountId = accountId;
      state.nickname = nickname;
    },
    connectCloud: async () => void seq.push('connectCloud'),
    rebaseline: () => void seq.push('rebaseline'),
    resumeObservation: () => void seq.push('resumeObservation'),
    startBrowse: () => void seq.push('startBrowse'),
  });
  return { run, seq, state };
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
