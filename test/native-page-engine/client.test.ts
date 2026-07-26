import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  NativePageEngineClient,
  NativePageEngineError,
} from '../../src/native-page-engine/client.js';

const fixture = fileURLToPath(
  new URL('../fixtures/native-page-engine/fake-engine.mjs', import.meta.url),
);

function client(mode: string, processTimeoutMs = 3_000): NativePageEngineClient {
  return new NativePageEngineClient({
    binaryPath: process.execPath,
    binaryArgs: [fixture],
    processTimeoutMs,
    env: { AIDCP_FAKE_ENGINE_MODE: mode },
  });
}

const input = {
  host: '127.0.0.1',
  port: 9222,
  platform: 'xiaohongshu' as const,
  timeoutMs: 500,
};

test('resolves only the correlated protocol-v2 command result', async () => {
  const result = await client('success').probePage(input);
  assert.equal(result.pageKind, 'explore');
  assert.equal(result.signals.feedCardCount, 12);
});

test('keeps one supervised process across session status and commands', async () => {
  const taskId = 'task-1';
  const session = await client('success').openSession({
    ...input,
    sessionId: 'session-1',
    taskId,
  });
  assert.equal(session.manifest.platformAdapterVersion, 'multi-platform-test');
  assert.deepEqual(session.manifest.platformAdapters.map(({ platform }) => platform), [
    'xiaohongshu',
    'facebook',
    'wechat_channels',
  ]);
  const result = await session.probePage(500);
  assert.equal(result.pageKind, 'explore');
  const status = await session.status();
  assert.equal(status.taskId, taskId);
  assert.equal(status.lastCommandId, 1);
  await session.close();
});

test('executes only a typed high-level command and preserves the tagged result', async () => {
  const session = await client('success').openSession({
    ...input,
    sessionId: 'session-command',
    taskId: 'task-command',
  });
  const execution = await session.execute({ kind: 'browse_scroll', params: { reason: 'test' } }, 500);
  assert.equal(execution.effectPhase, 'confirmed');
  assert.equal(execution.output?.kind, 'page_cards');
  assert.deepEqual(execution.output?.value, {
    cards: [{ index: 0, title: 'Native card', likeCount: 1, collectCount: 2 }],
  });
  await session.close();
});

test('permits 90 seconds only for a Facebook group_join command', async () => {
  const session = await client('success').openSession({
    ...input,
    platform: 'facebook',
    timeoutMs: 90_000,
    sessionId: 'session-facebook-join',
    taskId: 'task-facebook-join',
  });
  await session.execute({
    kind: 'group_join',
    params: { groupUrl: 'https://www.facebook.com/groups/42', click: true },
  }, 90_000);
  await assert.rejects(
    session.execute({ kind: 'page_probe', params: {} }, 90_000),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
  await session.close();

  await assert.rejects(client('success').openSession({
    ...input,
    timeoutMs: 90_000,
    sessionId: 'session-xhs-long',
    taskId: 'task-xhs-long',
  }), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'invalid_request');
    return true;
  });
});

test('rejects a ready engine whose capability manifest differs from the packaged contract', async () => {
  const strict = new NativePageEngineClient({
    binaryPath: process.execPath,
    binaryArgs: [fixture],
    processTimeoutMs: 500,
    env: { AIDCP_FAKE_ENGINE_MODE: 'success' },
    expectedManifest: {
      engineVersion: 'test',
      platformAdapterVersion: 'multi-platform-test',
      platformAdapters: [
        { platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-test' },
        { platform: 'facebook', adapterVersion: 'facebook-test' },
        { platform: 'wechat_channels', adapterVersion: 'wechat-channels-test' },
      ],
      capabilityDigest: 'b'.repeat(64),
    },
  });
  await assert.rejects(strict.probePage(input), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'invalid_protocol');
    return true;
  });
});

test('forwards AbortSignal cancellation and preserves not_started truth', async () => {
  const session = await client('cancel').openSession({
    ...input,
    sessionId: 'session-cancel',
    taskId: 'task-cancel',
  });
  const controller = new AbortController();
  const pending = session.probePage(500, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'cancelled');
    assert.equal(error.detail?.effectPhase, 'not_started');
    return true;
  });
  await session.close();
});

test('preserves native stable errors', async () => {
  await assert.rejects(client('native-error').probePage(input), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'no_matching_target');
    return true;
  });
});

test('kills a child that exceeds the process deadline', async () => {
  await assert.rejects(
    client('hang', 100).probePage({ ...input, timeoutMs: 50 }),
    (error: unknown) => {
      assert.ok(error instanceof NativePageEngineError);
      assert.equal(error.code, 'engine_timeout');
      return true;
    },
  );
});

test('rejects malformed stdout instead of accepting partial output', async () => {
  await assert.rejects(client('malformed').probePage(input), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'invalid_protocol');
    return true;
  });
});

test('reports exit before readiness honestly', async () => {
  await assert.rejects(client('exit').probePage(input), (error: unknown) => {
    assert.ok(error instanceof NativePageEngineError);
    assert.equal(error.code, 'engine_exited');
    assert.equal(error.detail?.exitCode, 23);
    return true;
  });
});
