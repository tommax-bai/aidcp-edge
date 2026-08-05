import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InFlightPublishes } from '../../src/execution/in-flight-publishes.js';
import { EdgeTaskCoordinator } from '../../src/execution/edge-task-coordinator.js';

describe('InFlightPublishes', () => {
  it('回收只发回执、不让写者离场：clear 之后页面仍被占，直到 dispatch 真收敛', () => {
    const registry = new InFlightPublishes();
    const failed: string[] = [];
    registry.begin('env-1', (reason) => failed.push(reason));

    assert.equal(registry.writerOnPage, true);
    assert.equal(registry.pendingReceipts, 1);

    registry.recycle('cloud_ws_disconnected');

    // 回执这一半：诚实失败已经发出去了，登记表也清空了。
    assert.deepEqual(failed, ['cloud_ws_disconnected']);
    assert.equal(registry.pendingReceipts, 0);
    // 写者那一半：**一个字都没少打**，页面仍归它。这正是本用例存在的理由——
    // 曾经两者共用一张表，回收一 clear，浏览闸当场松开，两个写者共用同一个 CDP 页面。
    assert.equal(registry.writerOnPage, true);

    registry.settle('env-1');
    assert.equal(registry.writerOnPage, false);
  });

  it('多条在途：settle 一条不让另一条离场', () => {
    const registry = new InFlightPublishes();
    registry.begin('env-1', () => undefined);
    registry.begin('env-2', () => undefined);

    registry.settle('env-1');
    assert.equal(registry.writerOnPage, true);

    registry.settle('env-2');
    assert.equal(registry.writerOnPage, false);
  });

  it('回收两次不重复发回执，且不影响写者在场', () => {
    const registry = new InFlightPublishes();
    let calls = 0;
    registry.begin('env-1', () => { calls++; });

    registry.recycle('user_pause');
    registry.recycle('user_pause');

    assert.equal(calls, 1);
    assert.equal(registry.writerOnPage, true);
  });

  it('settle 一个没登记过的 id 不把计数压到负数（负数会让闸恒假、且毫无症状）', () => {
    const registry = new InFlightPublishes();
    registry.settle('never-registered');
    registry.begin('env-1', () => undefined);

    assert.equal(registry.writerOnPage, true);
    registry.settle('env-1');
    assert.equal(registry.writerOnPage, false);
  });
});

describe('InFlightPublishes × EdgeTaskCoordinator', () => {
  // 端到端复现 5.2：断连时协调器 reset 租约 + 回收路径发完回执，此刻浏览**必须**仍被封住，
  // 因为发布 dispatch 还在页面上逐字打字（Facebook 正文预算上限 400s）。
  // 这里按宿主的真实接线把 publishInFlight 绑到 writerOnPage 上，而不是另写一个布尔。
  it('断连回收后浏览仍被封住，直到发布写者真的离开页面', () => {
    const registry = new InFlightPublishes();
    const coordinator = new EdgeTaskCoordinator({
      browse: { quiesceForTask: async () => 0, resumeAfterTask: async () => {} },
      writers: { publishInFlight: () => registry.writerOnPage },
      onAcquired: () => {},
      onReleased: () => {},
    });

    registry.begin('env-1', () => undefined);
    assert.equal(coordinator.canExecute(), false, '发布写者在场时普通浏览不得动手');

    // 云端断连：协调器作废全部旧所有权，回收路径把在途发布诚实判失败。
    coordinator.reset('cloud_ws_disconnected');
    registry.recycle('cloud_ws_disconnected');

    assert.equal(
      coordinator.canExecute(),
      false,
      '回执发完 ≠ 写者离场：dispatch 仍在页面上，浏览恢复会把发布页导走',
    );

    registry.settle('env-1');
    assert.equal(coordinator.canExecute(), true, 'dispatch 真收敛后浏览才可恢复');
  });
});
