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
  assert.equal(session.manifest.platformAdapterVersion, 'xiaohongshu-test');
  const result = await session.probePage(500);
  assert.equal(result.pageKind, 'explore');
  const status = await session.status();
  assert.equal(status.taskId, taskId);
  assert.equal(status.lastCommandId, 1);
  await session.close();
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
