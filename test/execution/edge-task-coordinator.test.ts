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
