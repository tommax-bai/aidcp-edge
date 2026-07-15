import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommitWindowGuard, combineCommitWindows } from '../../src/execution/commit-window.js';

describe('CommitWindowGuard（change lease-strict-preemption 5.1）', () => {
  it('enter 开窗、dispose 关窗；剩余预算如实', () => {
    let now = 1_000;
    const g = new CommitWindowGuard(() => now);
    assert.equal(g.isOpen(), false, '初始不开窗');
    const dispose = g.enter(15_000, 'xhs_submit');
    assert.equal(g.isOpen(), true);
    assert.equal(g.remainingMs(), 15_000);
    assert.equal(g.label, 'xhs_submit');
    now += 5_000;
    assert.equal(g.remainingMs(), 10_000, '剩余随时间递减');
    dispose();
    assert.equal(g.isOpen(), false, 'dispose 后关窗');
    assert.equal(g.remainingMs(), 0);
    assert.equal(g.label, undefined);
  });

  it('时基兜底：disposer 从未调用也会在预算耗尽后自动过期（卡死窗口绝不永久挡抢占）', () => {
    let now = 0;
    const g = new CommitWindowGuard(() => now);
    g.enter(20_000); // 拿到 disposer 但故意不调用
    assert.equal(g.isOpen(), true);
    now = 19_999;
    assert.equal(g.isOpen(), true);
    now = 20_000;
    assert.equal(g.isOpen(), false, '到预算即自动关窗');
    now = 999_999;
    assert.equal(g.remainingMs(), 0);
  });

  it('世代守卫：迟到的旧 disposer 绝不误关一个新开的窗口', () => {
    let now = 0;
    const g = new CommitWindowGuard(() => now);
    const disposeOld = g.enter(10_000, 'old');
    // 旧窗口正常结束（此处不调用 disposeOld，模拟被新窗口接续）
    now = 10_000; // 旧窗口时基已过期
    const disposeNew = g.enter(10_000, 'new'); // 新一代窗口
    assert.equal(g.isOpen(), true);
    assert.equal(g.label, 'new');
    disposeOld(); // 迟到的旧 disposer
    assert.equal(g.isOpen(), true, '旧 disposer 绝不误关新窗口');
    assert.equal(g.label, 'new');
    disposeNew();
    assert.equal(g.isOpen(), false);
  });

  it('budgetMs<=0 不开窗（绝不开一个已过期的假窗口）', () => {
    let now = 5;
    const g = new CommitWindowGuard(() => now);
    const d0 = g.enter(0);
    assert.equal(g.isOpen(), false);
    d0(); // no-op，绝不抛
    const dNeg = g.enter(-100);
    assert.equal(g.isOpen(), false);
    dNeg();
  });

  it('combineCommitWindows：任一写者开窗即在窗口内、取开着那个的剩余', () => {
    let now = 0;
    const publish = new CommitWindowGuard(() => now);
    const browse = new CommitWindowGuard(() => now);
    const probe = combineCommitWindows([publish, browse]);
    assert.equal(probe.inCommitWindow(), false);
    assert.equal(probe.commitWindowRemainingMs(), 0);

    const disposeBrowse = browse.enter(4_000, 'xhs_comment');
    assert.equal(probe.inCommitWindow(), true, '浏览写者开窗 → 聚合在窗口内');
    assert.equal(probe.commitWindowRemainingMs(), 4_000);
    disposeBrowse();

    const disposePublish = publish.enter(15_000, 'xhs_submit');
    assert.equal(probe.inCommitWindow(), true, '发布写者开窗 → 聚合在窗口内');
    assert.equal(probe.commitWindowRemainingMs(), 15_000);
    disposePublish();
    assert.equal(probe.inCommitWindow(), false);
  });
});
