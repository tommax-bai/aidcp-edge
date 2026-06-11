/**
 * 验收用例 AC-PUB-* — 发布审批信号契约（边缘侧）
 *
 * 守护点：边缘 `waitForPublishApproval` 读取的信号文件路径/结构，必须与云端飞书卡片回调
 *   （aidcp-cloud `getApprovalSignalPath` / `handleCardAction`）写入的完全一致。
 *   约定路径格式：/tmp/aidcp-publish-approve-<requestId>.json
 *   产品红线：未收到 approved=true 时，绝不静默发布。
 *
 * 环境层级：离线 / 逻辑级（fs 通过 readSignal/removeSignal 注入，不碰真实磁盘）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublishApprovalRequestId,
  buildPublishApprovalSignalPath,
  waitForPublishApproval,
  type PublishApprovalSignal,
} from '../../src/publish/approval-gate.js';

const signalFor = (id: string, approved: boolean): PublishApprovalSignal => ({
  requestId: id,
  approved,
  ts: 1700000000000,
  payload: { title: 'T', content: 'C', tags: ['a', 'b'] },
});

describe('AC-PUB 发布审批信号契约（edge）', () => {
  it('AC-PUB-01 信号路径格式与跨层约定一致', () => {
    assert.equal(buildPublishApprovalSignalPath('req-x'), '/tmp/aidcp-publish-approve-req-x.json');
  });

  it('AC-PUB-02 requestId 唯一且形如 edge-*', () => {
    const a = buildPublishApprovalRequestId(() => 1);
    const b = buildPublishApprovalRequestId(() => 1);
    assert.notEqual(a, b);
    assert.match(a, /^edge-/);
  });

  it('AC-PUB-03 approved=true → 放行并消费信号文件', async () => {
    const id = 'req-ok';
    let removed = false;
    const res = await waitForPublishApproval({
      requestId: id,
      pollIntervalMs: 1,
      timeoutMs: 100,
      readSignal: async () => JSON.stringify(signalFor(id, true)),
      removeSignal: async () => { removed = true; },
    });
    assert.equal(res.ok, true);
    assert.equal(res.approved, true);
    assert.equal(removed, true);
  });

  it('AC-PUB-04 approved=false → 拒绝（绝不静默发布）', async () => {
    const id = 'req-no';
    const res = await waitForPublishApproval({
      requestId: id,
      pollIntervalMs: 1,
      timeoutMs: 100,
      readSignal: async () => JSON.stringify(signalFor(id, false)),
      removeSignal: async () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'approval_rejected');
  });

  it('AC-PUB-05 requestId 不匹配的信号被拒（防串号误发）', async () => {
    const res = await waitForPublishApproval({
      requestId: 'req-self',
      pollIntervalMs: 1,
      timeoutMs: 100,
      readSignal: async () => JSON.stringify(signalFor('req-other', true)),
      removeSignal: async () => {},
    });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /signal_request_id_mismatch/);
  });

  it('AC-PUB-06 无信号 → 超时返回（不阻塞、不误发）', async () => {
    let t = 0;
    const res = await waitForPublishApproval({
      requestId: 'req-timeout',
      pollIntervalMs: 10,
      timeoutMs: 30,
      now: () => (t += 10),
      sleep: async () => {},
      readSignal: async () => {
        const e = new Error('missing') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'approval_timeout');
  });
});
