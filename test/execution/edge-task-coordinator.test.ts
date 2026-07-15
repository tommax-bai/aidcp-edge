import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeTaskCoordinator } from '../../src/execution/edge-task-coordinator.js';
import type { EdgeTaskAcquiredPayload, EdgeTaskReleasedPayload } from '../../src/comm/protocol.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('EdgeTaskCoordinator', () => {
  it('quiesce 期间重新按优先级选队头，同级 FIFO，最后只恢复一次浏览', async () => {
    const gate = deferred<number>();
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    let quiesces = 0;
    let resumes = 0;
    const coordinator = new EdgeTaskCoordinator({
      browse: {
        quiesceForTask: async () => { quiesces++; return gate.promise; },
        resumeAfterTask: async () => { resumes++; },
      },
      onAcquired: (payload) => acquired.push(payload),
      onReleased: (payload) => released.push(payload),
    });

    coordinator.acquire({ taskId: 'auto-1', kind: 'comment_prepare', priority: 'automatic', leaseMs: 60_000 });
    coordinator.acquire({ taskId: 'human-1', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    coordinator.acquire({ taskId: 'human-2', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    assert.equal(coordinator.canExecute(), false, 'quiescing 后普通浏览立即封住');

    gate.resolve(2);
    await tick();
    assert.equal(quiesces, 1);
    assert.deepEqual(acquired.map((item) => item.taskId), ['human-1']);
    assert.equal(acquired[0]?.cancelledBrowseCommands, 2);
    assert.equal(coordinator.canExecute('human-1'), true);
    assert.equal(coordinator.canExecute('auto-1'), false);
    assert.equal(coordinator.canExecute(), false);

    coordinator.release({ taskId: 'human-1', outcome: 'completed' });
    await tick();
    assert.deepEqual(acquired.map((item) => item.taskId), ['human-1', 'human-2'], '同级 FIFO 后授予第二个人工任务');
    coordinator.release({ taskId: 'human-2', outcome: 'completed' });
    await tick();
    assert.deepEqual(acquired.map((item) => item.taskId), ['human-1', 'human-2', 'auto-1']);
    coordinator.release({ taskId: 'auto-1', outcome: 'completed' });
    await tick();
    assert.equal(resumes, 1, '所有独占任务收敛后恰恢复一次');
    assert.equal(coordinator.canExecute(), true);
    assert.deepEqual(released.map((item) => item.reason), ['released', 'released', 'released']);
  });

  it('迟到命令与重复 release 不取得所有权', async () => {
    const released: EdgeTaskReleasedPayload[] = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      onAcquired: () => {},
      onReleased: (payload) => released.push(payload),
    });
    coordinator.acquire({ taskId: 'publish-a', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    await tick();
    coordinator.release({ taskId: 'publish-a' });
    await tick();
    assert.equal(coordinator.canExecute('publish-a'), false);
    coordinator.release({ taskId: 'publish-a' });
    assert.equal(released.at(-1)?.reason, 'duplicate');
    coordinator.release({ taskId: 'never-owned' });
    assert.equal(released.at(-1)?.reason, 'not_owner');
  });

  it('绝对租约到期自动释放并恢复，不永久冻结', async () => {
    const released: EdgeTaskReleasedPayload[] = [];
    let resumed = 0;
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => { resumed++; } },
      onAcquired: () => {},
      onReleased: (payload) => released.push(payload),
      maxAbsoluteLeaseMs: 5,
    });
    coordinator.acquire({ taskId: 'stuck', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(released.some((item) => item.taskId === 'stuck' && item.reason === 'expired'), true);
    assert.equal(resumed, 1);
    assert.equal(coordinator.canExecute(), true);
  });

  it('quiesce 未在 acquire 等待期内收敛时废弃排队任务，不授予无主租约', async () => {
    const gate = deferred<number>();
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    let resumed = 0;
    const coordinator = new EdgeTaskCoordinator({
      browse: {
        quiesceForTask: async () => gate.promise,
        resumeAfterTask: async () => { resumed++; },
      },
      onAcquired: (payload) => acquired.push(payload),
      onReleased: (payload) => released.push(payload),
    });

    coordinator.acquire({ taskId: 'stale-acquire', kind: 'comment_prepare', priority: 'automatic', leaseMs: 60_000, acquireTimeoutMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(acquired, []);
    assert.deepEqual(released, [{ taskId: 'stale-acquire', reason: 'expired' }]);

    gate.resolve(0);
    await tick();
    assert.deepEqual(acquired, [], 'quiesce 迟到也不得重新授予已过期任务');
    assert.equal(resumed, 1);
    assert.equal(coordinator.canExecute(), true);
  });

  it('CDP 控制不可用时立即明确拒绝接管，不等待 quiesce 或云端 acquire 超时', () => {
    const released: EdgeTaskReleasedPayload[] = [];
    let quiesces = 0;
    const coordinator = new EdgeTaskCoordinator({
      browse: {
        quiesceForTask: async () => { quiesces++; return 0; },
        resumeAfterTask: async () => {},
      },
      canAcquire: () => false,
      onAcquired: () => assert.fail('CDP 不可用时不得授予任务'),
      onReleased: (payload) => released.push(payload),
    });

    coordinator.acquire({ taskId: 'publish-cdp-unhealthy', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    assert.deepEqual(released, [{ taskId: 'publish-cdp-unhealthy', reason: 'cdp_unhealthy' }]);
    assert.equal(quiesces, 0);
    assert.equal(coordinator.canExecute(), false, '不可用时连现有页面写命令也不得继续下发');
  });

  it('让位期间 CDP 变为不可用时废弃排队任务，不发迟到 acquired', async () => {
    const gate = deferred<number>();
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    let ready = true;
    let resumes = 0;
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => gate.promise, resumeAfterTask: async () => { resumes++; } },
      canAcquire: () => ready,
      onAcquired: (payload) => acquired.push(payload),
      onReleased: (payload) => released.push(payload),
    });
    coordinator.acquire({ taskId: 'lost-during-quiesce', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    ready = false;
    gate.resolve(0);
    await tick();

    assert.deepEqual(acquired, []);
    assert.deepEqual(released, [{ taskId: 'lost-during-quiesce', reason: 'cdp_unhealthy' }]);
    assert.equal(resumes, 0, '控制不可用时不得为清理租约而恢复浏览');

    ready = true;
    coordinator.resumeAfterControlRecovery();
    await tick();
    assert.equal(resumes, 1, '只有控制恢复后才解除此前的浏览冻结');
  });

  it('两个发布任务整段串行，原子命令绝不 A/B 交错', async () => {
    const atoms: string[] = [];
    let coordinator!: EdgeTaskCoordinator;
    coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      onAcquired: (payload) => {
        for (const atom of ['navigate_entry', 'select_mode', 'submit_publish']) atoms.push(`${payload.taskId}:${atom}`);
        coordinator.release({ taskId: payload.taskId, outcome: 'completed' });
      },
      onReleased: () => {},
    });
    coordinator.acquire({ taskId: 'publish-a', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    coordinator.acquire({ taskId: 'publish-b', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.deepEqual(atoms, [
      'publish-a:navigate_entry', 'publish-a:select_mode', 'publish-a:submit_publish',
      'publish-b:navigate_entry', 'publish-b:select_mode', 'publish-b:submit_publish',
    ]);
  });
});

// ---------------------------------------------------------------------------
// change browser-slot-scheduling：停泊 ≠ 故障
//
// 冷待机把浏览器主动收起来后，旧行为对任务请求回一句 cdp_unhealthy——那是**假话**：浏览器没坏，
// 是我们自己收起来的，而且叫得醒。云端据此以为边缘出了故障，任务就此丢失。
// ---------------------------------------------------------------------------
describe('EdgeTaskCoordinator：浏览器停泊走唤醒路径', () => {
  const mk = (opts: {
    browserAbsent: () => boolean;
    requestWake: (deadlineAt?: number) => Promise<boolean>;
    canAcquire: () => boolean;
  }) => {
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      canAcquire: opts.canAcquire,
      browserAbsent: opts.browserAbsent,
      requestWake: opts.requestWake,
      onAcquired: (p) => acquired.push(p),
      onReleased: (p) => released.push(p),
    });
    return { coordinator, acquired, released };
  };

  it('停泊中收到任务 → 唤醒成功后正常授予租约（绝不回假的 cdp_unhealthy）', async () => {
    let parked = true;
    let wakes = 0;
    const { coordinator, acquired, released } = mk({
      canAcquire: () => !parked,
      browserAbsent: () => parked,
      requestWake: async () => {
        wakes++;
        parked = false; // 浏览器起来了
        return true;
      },
    });

    coordinator.acquire({ taskId: 't-1', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();

    assert.equal(wakes, 1, '触发了一次唤醒');
    assert.deepEqual(acquired.map((a) => a.taskId), ['t-1'], '唤醒后正常拿到租约');
    assert.deepEqual(released, [], '绝不回 cdp_unhealthy');
  });

  it('唤醒失败 → 回 browser_wake_failed（与 cdp_unhealthy 明确区分）', async () => {
    const { coordinator, acquired, released } = mk({
      canAcquire: () => false,
      browserAbsent: () => true,
      requestWake: async () => false, // 唤不醒（内存不足 / 冷启失败 / 超死线）
    });

    coordinator.acquire({ taskId: 't-2', kind: 'comment_prepare', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    await tick();

    assert.deepEqual(acquired, [], '没起来就绝不授予租约');
    assert.deepEqual(released, [{ taskId: 't-2', reason: 'browser_wake_failed' }], '诚实的、可恢复的失败原因');
  });

  it('浏览器在、但控制不健康 → 仍是 cdp_unhealthy（不误走唤醒路径）', async () => {
    let wakes = 0;
    const { coordinator, released } = mk({
      canAcquire: () => false,
      browserAbsent: () => false, // 浏览器在，只是控制面坏了
      requestWake: async () => {
        wakes++;
        return true;
      },
    });

    coordinator.acquire({ taskId: 't-3', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    await tick();

    assert.equal(wakes, 0, '真故障绝不去叫醒一个本来就开着的浏览器');
    assert.deepEqual(released, [{ taskId: 't-3', reason: 'cdp_unhealthy' }]);
  });

  it('唤醒期间重复 acquire 绝不触发第二次唤醒（不会开出第二个浏览器）', async () => {
    let wakes = 0;
    const gate = deferred<boolean>();
    let parked = true;
    const { coordinator, acquired } = mk({
      canAcquire: () => !parked,
      browserAbsent: () => parked,
      requestWake: () => {
        wakes++;
        return gate.promise;
      },
    });

    const req = { taskId: 't-4', kind: 'publish', priority: 'human', leaseMs: 60_000 } as const;
    coordinator.acquire({ ...req });
    coordinator.acquire({ ...req }); // 云端重发
    coordinator.acquire({ ...req });
    await tick();
    assert.equal(wakes, 1, '唤醒中：重复请求绝不再叫一次');

    parked = false;
    gate.resolve(true);
    await tick();
    await tick();
    assert.deepEqual(acquired.map((a) => a.taskId), ['t-4']);
  });

  it('租约在跑 / 排队中 → hasActiveLease 为真（冷待机据此拒绝抽走浏览器）', async () => {
    const { coordinator } = mk({ canAcquire: () => true, browserAbsent: () => false, requestWake: async () => true });
    assert.equal(coordinator.hasActiveLease(), false, '空闲时可以进待机');
    coordinator.acquire({ taskId: 't-5', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    await tick();
    assert.equal(coordinator.hasActiveLease(), true, '有任务在跑就绝不释放浏览器');
    coordinator.release({ taskId: 't-5' });
    await tick();
    assert.equal(coordinator.hasActiveLease(), false, '任务结束后才可以进待机');
  });
});

// ---------------------------------------------------------------------------
// 调用方的死线必须原样传给外壳（change browser-slot-scheduling）。
//
// 外壳靠它决定**什么时候回话**（「这次没轮到你」），而不是决定**要不要开浏览器**。
// 不传 = 外壳不知道有人在死线上等 → 那个任务只能干等到自己的死线超时。
describe('EdgeTaskCoordinator：把调用方的 acquire 死线传给外壳', () => {
  it('唤醒时带上绝对死线 = now + acquireTimeoutMs − 往返余量（宁可早答，绝不迟答）', async () => {
    const seen: Array<number | undefined> = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      canAcquire: () => false,
      browserAbsent: () => true,
      requestWake: async (deadlineAt) => { seen.push(deadlineAt); return false; },
      onAcquired: () => {},
      onReleased: () => {},
      now: () => 1_000_000,
    });

    coordinator.acquire({ taskId: 't-dl', kind: 'comment_prepare', priority: 'automatic', leaseMs: 60_000, acquireTimeoutMs: 200_000 });
    await tick();
    await tick();

    assert.equal(seen.length, 1, '唤醒被触发一次');
    // 云端在 push **之前**就 arm 了自己的计时器，所以边缘天然落后：扣 5s 余量，把竞速让给云端。
    assert.equal(seen[0], 1_000_000 + 200_000 - 5_000, '死线 = now + acquireTimeoutMs − 5s');
  });

  it('预算已耗尽（死线早于现在）→ 传下去的死线不会是负预算的将来时刻', async () => {
    const seen: Array<number | undefined> = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      canAcquire: () => false,
      browserAbsent: () => true,
      requestWake: async (deadlineAt) => { seen.push(deadlineAt); return false; },
      onAcquired: () => {},
      onReleased: () => {},
      now: () => 500,
    });

    // acquireTimeoutMs 小于往返余量 → 预算按 0 算，绝不倒推出一个「过去」的死线让外壳误判。
    coordinator.acquire({ taskId: 't-tight', kind: 'comment_prepare', priority: 'automatic', leaseMs: 60_000, acquireTimeoutMs: 1_000 });
    await tick();
    await tick();

    assert.equal(seen[0], 500, '预算 clamp 到 0：死线 = 此刻，外壳据此立刻诚实作答');
  });
});

// ---------------------------------------------------------------------------
// 抢占核心（change lease-strict-preemption 5.2 写者注册表探针 / 5.4 严格抢占 + 提交窗口豁免 /
// 5.5 让位超时 = 控制面故障 / 5.9 在途发布写让位）。
//
// 关键安全属性：一切抢占行为**由可选探针门控**。探针未接线（无 writers）时 inCommitWindow 永不 === false
// → 绝不抢占 → 与抢占前逐字同行为（休眠，待 5.1/5.3 接真探针才生效）。
// ---------------------------------------------------------------------------
describe('EdgeTaskCoordinator：抢占核心', () => {
  it('5.4 严格高档位抢占低档位在跑任务：被抢占回 preempted_by_task 且可重投、challenger 被授予', async () => {
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      writers: { inCommitWindow: () => false }, // 确认不在提交窗口 → 可抢占
      onAcquired: (p) => acquired.push(p),
      onReleased: (p) => released.push(p),
    });

    coordinator.acquire({ taskId: 'auto-pub', kind: 'publish', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    assert.deepEqual(acquired.map((a) => a.taskId), ['auto-pub'], '低档发布先拿到租约');

    coordinator.acquire({ taskId: 'human-cmt', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.equal(released.some((r) => r.taskId === 'auto-pub' && r.reason === 'preempted_by_task'), true, '被抢占任务回 preempted_by_task');
    assert.deepEqual(acquired.map((a) => a.taskId), ['auto-pub', 'human-cmt'], 'challenger 被授予');
    assert.equal(coordinator.canExecute('human-cmt'), true);
    assert.equal(coordinator.canExecute('auto-pub'), false, '被抢占任务不再持写权');

    // 被抢占任务由云端事件驱动重投（7.1）——同 taskId 绝不被当 duplicate 摘掉。
    coordinator.release({ taskId: 'human-cmt', outcome: 'completed' });
    await tick();
    coordinator.acquire({ taskId: 'auto-pub', kind: 'publish', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.equal(acquired.filter((a) => a.taskId === 'auto-pub').length, 2, '被抢占任务重投拿回租约');
    assert.equal(released.some((r) => r.taskId === 'auto-pub' && r.reason === 'duplicate'), false, '重投绝不回 duplicate');
  });

  it('5.4 同档位不抢占：排队 FIFO', async () => {
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      writers: { inCommitWindow: () => false },
      onAcquired: (p) => acquired.push(p),
      onReleased: (p) => released.push(p),
    });
    coordinator.acquire({ taskId: 'human-1', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    await tick();
    coordinator.acquire({ taskId: 'human-2', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.deepEqual(acquired.map((a) => a.taskId), ['human-1'], '同档不抢占：human-2 排队等待');
    assert.equal(released.some((r) => r.reason === 'preempted_by_task'), false);
    coordinator.release({ taskId: 'human-1' });
    await tick();
    assert.deepEqual(acquired.map((a) => a.taskId), ['human-1', 'human-2'], '在跑任务释放后按 FIFO 授予');
  });

  it('5.4 低档位不抢高档位：排队等待', async () => {
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      writers: { inCommitWindow: () => false },
      onAcquired: (p) => acquired.push(p),
      onReleased: (p) => released.push(p),
    });
    coordinator.acquire({ taskId: 'human-1', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    coordinator.acquire({ taskId: 'auto-1', kind: 'publish', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.deepEqual(acquired.map((a) => a.taskId), ['human-1'], '低档不抢高档：auto-1 排队');
    assert.equal(released.some((r) => r.reason === 'preempted_by_task'), false);
  });

  it('5.4 在跑写者处于提交窗口：拒绝抢占、回 window_busy + 剩余预算、不强杀、可重试', async () => {
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    let inWindow = true;
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      writers: { inCommitWindow: () => inWindow, commitWindowRemainingMs: () => 4_200 },
      onAcquired: (p) => acquired.push(p),
      onReleased: (p) => released.push(p),
    });
    coordinator.acquire({ taskId: 'auto-pub', kind: 'publish', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    coordinator.acquire({ taskId: 'human-cmt', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    const wb = released.find((r) => r.taskId === 'human-cmt');
    assert.equal(wb?.reason, 'window_busy', '提交窗口占用 → challenger 回 window_busy');
    assert.equal(wb?.windowRemainingMs, 4_200, '携带剩余预算，不让抢占者空等');
    assert.equal(released.some((r) => r.taskId === 'auto-pub'), false, '在跑发布不被强杀');
    assert.deepEqual(acquired.map((a) => a.taskId), ['auto-pub']);
    assert.equal(coordinator.canExecute('auto-pub'), true, '在跑发布仍持租约');

    // 窗口关闭后重试成功抢占（window_busy 未进 terminal，绝不被当 duplicate）。
    inWindow = false;
    coordinator.acquire({ taskId: 'human-cmt', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.equal(released.some((r) => r.taskId === 'auto-pub' && r.reason === 'preempted_by_task'), true, '窗口关闭后重试抢占成功');
    assert.deepEqual(acquired.map((a) => a.taskId), ['auto-pub', 'human-cmt']);
  });

  it('5.3/5.4 抢占取消在途发布写：cancelPublish 仅在确有在途发布时调用、取消数计入授予回执', async () => {
    const acquired: EdgeTaskAcquiredPayload[] = [];
    let cancelPublishCalls = 0;
    let publishing = false; // 发布 dispatch 尚未开跑
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      writers: {
        inCommitWindow: () => false,
        publishInFlight: () => publishing,
        cancelPublish: async () => { cancelPublishCalls++; publishing = false; return 1; },
      },
      onAcquired: (p) => acquired.push(p),
      onReleased: () => {},
    });
    coordinator.acquire({ taskId: 'auto-pub', kind: 'publish', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    assert.equal(cancelPublishCalls, 0, '首次授予（无在途发布）不空跑 cancelPublish');
    publishing = true; // 发布 dispatch 开跑
    coordinator.acquire({ taskId: 'human-cmt', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.equal(cancelPublishCalls, 1, '抢占在途发布时下发一次真取消');
    const granted = acquired.find((a) => a.taskId === 'human-cmt');
    assert.equal(granted?.cancelledBrowseCommands, 1, '取消总数计入（browse 0 + publish 1）');
  });

  it('5.5 让位写者收到取消仍不停手 → yield_timeout（控制面故障，非 expired）', async () => {
    const released: EdgeTaskReleasedPayload[] = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => { throw new Error('quiesce timeout'); }, resumeAfterTask: async () => {} },
      canAcquire: () => true,
      onAcquired: () => assert.fail('未收敛绝不授予'),
      onReleased: (p) => released.push(p),
    });
    coordinator.acquire({ taskId: 'stuck-writer', kind: 'comment_prepare', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.deepEqual(released, [{ taskId: 'stuck-writer', reason: 'yield_timeout' }], '控制面故障 → yield_timeout（请运营重启客户端），绝不 expired');
    // 复核 wf_3a8e8996 finding #1：yield_timeout 后 browse **保持冻结**——写者收到取消仍在改页面，
    // 普通浏览绝不能恢复（否则与失控写者交错、后置校验误判导航走的 DOM 为成功）。
    assert.equal(coordinator.canExecute(), false, 'yield_timeout 后普通浏览仍冻结（写者仍在改页面，待运营重启）');
    assert.equal(coordinator.blocksBrowse, true, 'yield_timeout 后 blocksBrowse 仍为真');
  });

  it('5.5 让位期间控制面丢失（CDP 不可用）→ cdp_unhealthy（不误判 yield_timeout）', async () => {
    const released: EdgeTaskReleasedPayload[] = [];
    let ready = true;
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => { ready = false; throw new Error('cdp lost mid-quiesce'); }, resumeAfterTask: async () => {} },
      canAcquire: () => ready,
      onAcquired: () => assert.fail('控制面丢失绝不授予'),
      onReleased: (p) => released.push(p),
    });
    coordinator.acquire({ taskId: 'lost', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.deepEqual(released, [{ taskId: 'lost', reason: 'cdp_unhealthy' }], 'quiesce 抛出但控制面已失 → cdp_unhealthy 而非 yield_timeout');
  });

  it('5.9 在途发布写期间普通浏览让位（canExecute/blocksBrowse/hasActiveLease），收敛后放行', () => {
    let publishing = true;
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      writers: { publishInFlight: () => publishing },
      onAcquired: () => {},
      onReleased: () => {},
    });
    assert.equal(coordinator.canExecute(), false, '在途发布写时普通浏览命令让位（治「已离开发布页=成功」假成功）');
    assert.equal(coordinator.blocksBrowse, true);
    assert.equal(coordinator.hasActiveLease(), true, '在途发布写时不释放浏览器（冷待机据此拒绝）');
    publishing = false;
    assert.equal(coordinator.canExecute(), true, '发布收敛后普通浏览放行');
    assert.equal(coordinator.blocksBrowse, false);
    assert.equal(coordinator.hasActiveLease(), false);
  });

  it('5.9 发布 dispatch 结束后 notifyPublishSettled 恢复浏览（不永久冻结）', async () => {
    let publishing = true;
    let resumes = 0;
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => { resumes++; } },
      writers: { publishInFlight: () => publishing },
      onAcquired: () => {},
      onReleased: () => {},
    });
    coordinator.acquire({ taskId: 'pub', kind: 'publish', priority: 'human', leaseMs: 60_000 });
    await tick();
    coordinator.release({ taskId: 'pub' });
    await tick();
    assert.equal(resumes, 0, '在途发布写未收敛前绝不恢复浏览');
    publishing = false;
    coordinator.notifyPublishSettled();
    await tick();
    assert.equal(resumes, 1, '发布收敛后恰恢复一次浏览');
  });

  it('5.2 探针未接线时抢占休眠：严格高档到达也不抢占（行为与今日逐字一致）', async () => {
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      // 无 writers 探针
      onAcquired: (p) => acquired.push(p),
      onReleased: (p) => released.push(p),
    });
    coordinator.acquire({ taskId: 'auto', kind: 'publish', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    coordinator.acquire({ taskId: 'human', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.deepEqual(acquired.map((a) => a.taskId), ['auto'], '探针未接线 → 不抢占，human 排队');
    assert.equal(released.some((r) => r.reason === 'preempted_by_task' || r.reason === 'window_busy'), false);
  });

  it('5.4 inCommitWindow 返回 undefined（无法确认）→ 保守不抢占', async () => {
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      writers: { inCommitWindow: () => undefined },
      onAcquired: (p) => acquired.push(p),
      onReleased: (p) => released.push(p),
    });
    coordinator.acquire({ taskId: 'auto', kind: 'publish', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    coordinator.acquire({ taskId: 'human', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    assert.deepEqual(acquired.map((a) => a.taskId), ['auto'], '无法确认窗口 → 保守不抢占');
    assert.equal(released.some((r) => r.reason === 'preempted_by_task'), false);
  });

  it('BLOCKER 抢占时 cancelPublish 不停手 → 被抢占任务回 yield_timeout（绝非 preempted，防云端重投未停发布=双发）', async () => {
    // 复核 wf_3a8e8996 BLOCKER：被抢占任务的「干净让位·可重投」终态 MUST 只在写者取消**确认收敛后**才发；
    // 若 cancelPublish 抛出（写者收到取消仍不停手），被抢占发布 MUST 回 yield_timeout 而非 preempted_by_task，
    // 否则云端会重投一个可能已提交的发布 → 不可逆双发。
    const acquired: EdgeTaskAcquiredPayload[] = [];
    const released: EdgeTaskReleasedPayload[] = [];
    let publishing = false;
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      canAcquire: () => true,
      writers: {
        inCommitWindow: () => false, // 不在提交窗口 → 允许抢占
        publishInFlight: () => publishing,
        cancelPublish: async () => { throw new Error('publish writer 收到取消仍不停手'); },
      },
      onAcquired: (p) => acquired.push(p),
      onReleased: (p) => released.push(p),
    });
    coordinator.acquire({ taskId: 'auto-pub', kind: 'publish', priority: 'automatic', leaseMs: 60_000 });
    await tick();
    assert.deepEqual(acquired.map((a) => a.taskId), ['auto-pub'], '发布先拿到租约（此时无在途发布，grant quiesce 不触发 cancelPublish）');
    publishing = true; // 发布 dispatch 开跑
    coordinator.acquire({ taskId: 'human-cmt', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    await tick();
    const pub = released.find((r) => r.taskId === 'auto-pub');
    assert.equal(pub?.reason, 'yield_timeout', '取消不收敛 → 被抢占发布回 yield_timeout（控制面故障），绝不谎称干净让位');
    assert.equal(released.some((r) => r.taskId === 'auto-pub' && r.reason === 'preempted_by_task'), false, '绝不 preempted_by_task（否则云端重投 = 双发）');
    assert.equal(released.find((r) => r.taskId === 'human-cmt')?.reason, 'yield_timeout', '控制面故障整队回收：challenger 也 yield_timeout');
    assert.equal(acquired.some((a) => a.taskId === 'human-cmt'), false, '控制面故障绝不授予 challenger');
    assert.equal(coordinator.canExecute(), false, 'browse 保持冻结（失控写者仍在改页面）');
  });

  it('finding-A 非发布任务持租约 + 发布在途 → 其命令也让位（防御纵深，publishInFlight 闸不被 active 持有者绕过）', async () => {
    // 复核 wf_3a8e8996 finding A：canExecute 的 active 分支此前先返回、绕过了 publishInFlight 闸。
    // 构造「comment 任务持租约 + 发布在途（无 cancelPublish → acquire 不清它）」的边缘态，验证防御纵深生效。
    let publishing = true;
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      writers: { publishInFlight: () => publishing }, // 无 cancelPublish → 授予时不清在途发布
      onAcquired: () => {},
      onReleased: () => {},
    });
    coordinator.acquire({ taskId: 'cmt-task', kind: 'comment_commit', priority: 'human', leaseMs: 60_000 });
    await tick();
    assert.equal(coordinator.currentTaskId, 'cmt-task', '非发布任务持租约');
    assert.equal(coordinator.canExecute('cmt-task'), false, '发布在途时，非发布租约持有者的命令也让位（防止导航走发布页 → 假成功）');
    publishing = false;
    assert.equal(coordinator.canExecute('cmt-task'), true, '发布收敛后，该租约持有者命令恢复放行');
  });
});
