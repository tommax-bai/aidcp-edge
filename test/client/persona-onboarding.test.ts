/**
 * change edge-persona-keyword-generation — core 侧 persona stdin/stdout 桥单测。
 *
 * 覆盖 makePersonaStdinHandler：按行缓冲分行、只处理 persona.*、调 client.request（显式 190s 超时）、
 * 成功/失败诚实回执、跨 chunk 分行、缺 id / 非本模块行忽略。
 *
 * 环境层级：离线 / 逻辑级（stub client + reply 捕获，不碰真实 process.stdin/stdout）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  makePersonaStdinHandler,
  PERSONA_REQUEST_TIMEOUT_MS,
  type PersonaRequestClient,
} from '../../src/client/persona-onboarding.js';
import { makeEnvelope } from '../../src/comm/protocol.js';

const tick = () => new Promise((r) => setImmediate(r));

function stubClient(
  impl?: (type: string, payload: unknown) => Promise<unknown>,
): PersonaRequestClient & { calls: { type: string; payload: unknown; timeoutMs?: number }[] } {
  const calls: { type: string; payload: unknown; timeoutMs?: number }[] = [];
  return {
    calls,
    request: async (type: 'persona.generate' | 'persona.persist', payload: unknown, timeoutMs?: number) => {
      calls.push({ type, payload, timeoutMs });
      const p = impl
        ? await impl(type, payload)
        : { ok: true, soulYaml: 'identity:\n  name: "x"', identitySummary: 'x' };
      return makeEnvelope('persona.generate.result', 'srv-1', 1700000000000, p as never);
    },
  };
}

describe('makePersonaStdinHandler', () => {
  it('persona.generate 行 → 调 client.request（190s 超时）+ 成功回执带 payload', async () => {
    const client = stubClient();
    const replies: unknown[] = [];
    const feed = makePersonaStdinHandler(client, (o) => replies.push(o), () => {});
    feed(JSON.stringify({ type: 'persona.generate', id: 'req-1', payload: { keywordSelections: ['美妆'], idempotencyKey: 'k1' } }) + '\n');
    await tick();
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].type, 'persona.generate');
    assert.equal(client.calls[0].timeoutMs, PERSONA_REQUEST_TIMEOUT_MS);
    assert.deepEqual(client.calls[0].payload, { keywordSelections: ['美妆'], idempotencyKey: 'k1' });
    assert.deepEqual(replies, [{ id: 'req-1', ok: true, payload: { ok: true, soulYaml: 'identity:\n  name: "x"', identitySummary: 'x' } }]);
  });

  it('非 persona 行（browser.show）与非 JSON 行被忽略（不调 request、不回执）', async () => {
    const client = stubClient();
    const replies: unknown[] = [];
    const feed = makePersonaStdinHandler(client, (o) => replies.push(o), () => {});
    feed('{"type":"browser.show"}\n');
    feed('这不是 JSON\n');
    await tick();
    assert.equal(client.calls.length, 0);
    assert.equal(replies.length, 0);
  });

  it('缺 id 的 persona 行被忽略', async () => {
    const client = stubClient();
    const replies: unknown[] = [];
    const feed = makePersonaStdinHandler(client, (o) => replies.push(o), () => {});
    feed(JSON.stringify({ type: 'persona.generate', payload: {} }) + '\n');
    await tick();
    assert.equal(client.calls.length, 0);
    assert.equal(replies.length, 0);
  });

  it('client.request 抛错 → 诚实回 ok:false + error（不本地兜底）', async () => {
    const client = stubClient(async () => {
      throw new Error('边-云 WS 未连接');
    });
    const replies: { id: string; ok: boolean; error?: string }[] = [];
    const feed = makePersonaStdinHandler(client, (o) => replies.push(o), () => {});
    feed(JSON.stringify({ type: 'persona.persist', id: 'req-9', payload: { soulYaml: 'x' } }) + '\n');
    await tick();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ok, false);
    assert.equal(replies[0].id, 'req-9');
    assert.match(replies[0].error || '', /WS 未连接/);
  });

  it('跨 chunk 分行：半行 + 半行拼成一整行才处理', async () => {
    const client = stubClient();
    const replies: unknown[] = [];
    const feed = makePersonaStdinHandler(client, (o) => replies.push(o), () => {});
    const line = JSON.stringify({ type: 'persona.generate', id: 'req-2', payload: { keywordSelections: ['x'], idempotencyKey: 'k' } });
    feed(line.slice(0, 20)); // 前半段：无换行 → 不处理
    await tick();
    assert.equal(client.calls.length, 0);
    feed(line.slice(20) + '\n'); // 后半段 + 换行 → 拼齐处理
    await tick();
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].type, 'persona.generate');
  });
});
