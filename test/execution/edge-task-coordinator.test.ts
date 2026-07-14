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
