/**
 * 客户端发起的 publish RPC stdin↔WS 桥（change client-preview-image-delete 起承载两类）。
 *
 * 这里守的是一个 typecheck 抓不到的静默失败：主进程发了 core 不认的 type，
 * core 会**一声不吭地丢弃**，症状只是主进程 35s 后超时——所以「新 type 必须被放行」需要有断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  makePublishApprovalStdinHandler,
  type PublishApprovalReply,
} from '../../src/client/publish-approval-onboarding.js';
import type { Envelope } from '../../src/comm/protocol.js';

function harness(request?: (type: string, payload: unknown) => Promise<Envelope>) {
  const sent: { type: string; payload: unknown; timeoutMs?: number }[] = [];
  const replies: PublishApprovalReply[] = [];
  const client = {
    request: async <T>(type: 'publish.approval_action' | 'publish.draft_image_remove', payload: T, timeoutMs?: number) => {
      sent.push({ type, payload, timeoutMs });
      if (request) return request(type, payload);
      return { type: `${type}.result`, id: 'env-1', v: 2, ts: 1, payload: { ok: true } } as unknown as Envelope;
    },
  };
  const onChunk = makePublishApprovalStdinHandler(client, (value) => replies.push(value), () => {});
  return { onChunk, sent, replies };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('publish 客户端 RPC 桥', () => {
  it('放行 publish.approval_action：按 30s 超时转发并回执', async () => {
    const { onChunk, sent, replies } = harness();
    onChunk(`${JSON.stringify({ type: 'publish.approval_action', id: 'a1', payload: { requestId: 'publish-89' } })}\n`);
    await tick();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'publish.approval_action');
    assert.equal(sent[0].timeoutMs, 30_000); // 必须 < 主进程 35s，否则主进程先超时、诚实拒因送不回来
    assert.equal(replies[0].id, 'a1');
    assert.equal(replies[0].ok, true);
  });

  it('放行 publish.draft_image_remove：原样转发 payload（本模块只做传输，不做任何判断）', async () => {
    const { onChunk, sent, replies } = harness();
    const payload = { requestId: 'publish-89', contentVersion: 0, imageUrl: 'https://o/b.jpg' };
    onChunk(`${JSON.stringify({ type: 'publish.draft_image_remove', id: 'd1', payload })}\n`);
    await tick();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'publish.draft_image_remove');
    assert.deepEqual(sent[0].payload, payload);
    assert.equal(replies[0].id, 'd1');
    assert.equal(replies[0].ok, true);
  });

  it('未知 type 仍静默丢弃（零回归：桥不是通用命令口）', async () => {
    const { onChunk, sent, replies } = harness();
    onChunk(`${JSON.stringify({ type: 'publish.request', id: 'x1', payload: {} })}\n`);
    onChunk(`${JSON.stringify({ type: 'session.end', id: 'x2', payload: {} })}\n`);
    onChunk('not json\n');
    await tick();

    assert.equal(sent.length, 0);
    assert.equal(replies.length, 0);
  });

  it('云端请求失败 → 诚实回执 ok:false + 原因，绝不假成功', async () => {
    const { onChunk, replies } = harness(async () => {
      throw new Error('边-云 WS 未连接');
    });
    onChunk(`${JSON.stringify({ type: 'publish.draft_image_remove', id: 'd2', payload: {} })}\n`);
    await tick();

    assert.equal(replies.length, 1);
    assert.equal(replies[0].ok, false);
    assert.match(String(replies[0].error), /未连接/);
  });
});
