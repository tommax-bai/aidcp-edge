import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublishCommandPayload } from '../../src/comm/protocol.js';
import type { NativePageCommand } from '../../src/native-page-engine/client.js';
import { NativePublishExecutor } from '../../src/native-page-engine/publish.js';
import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

function command(
  kind: PublishCommandPayload['kind'],
  seq: number,
  params: PublishCommandPayload['params'] = {},
  platform: PublishCommandPayload['platform'] = 'xiaohongshu',
): PublishCommandPayload {
  return { platform, taskId: 'task-native', recordId: 9, seq, kind, params };
}

test('tracks confirmed upload order and selects cover by its already-uploaded source', async () => {
  const nativeCommands: NativePageCommand[] = [];
  const runtime = {
    execute: async (_owner: string, nativeCommand: NativePageCommand) => {
      nativeCommands.push(nativeCommand);
      return {
        effectPhase: 'confirmed' as const,
        output: { kind: 'publish_receipt', value: { ok: true } },
      };
    },
  } as unknown as NativePageRuntime;
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(png, { status: 200, headers: { 'content-length': String(png.length) } });
  };
  try {
    const executor = new NativePublishExecutor(runtime, 'aidcp-native-publish-test-');
    assert.equal((await executor.dispatch(command('navigate_entry', 1))).ok, true);
    assert.equal((await executor.dispatch(command('upload_image', 2, { imageUrl: 'https://cdn.test/one.png' }))).ok, true);
    assert.equal((await executor.dispatch(command('upload_image', 3, { imageUrl: 'https://cdn.test/two.png' }))).ok, true);
    assert.equal((await executor.dispatch(command('set_cover', 4, { imageUrl: 'https://cdn.test/two.png' }))).ok, true);
    assert.equal(fetches, 2, 'set_cover must select an uploaded preview instead of downloading/uploading again');
    assert.deepEqual(nativeCommands.map((item) => [item.kind, item.params.imageIndex]), [
      ['publish_navigate_entry', undefined],
      ['publish_upload_image', 0],
      ['publish_upload_image', 1],
      ['publish_set_cover', 1],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fails closed when the requested cover was never confirmed as uploaded', async () => {
  const runtime = { execute: async () => { throw new Error('must not dispatch'); } } as unknown as NativePageRuntime;
  const executor = new NativePublishExecutor(runtime, 'aidcp-native-publish-test-');
  const result = await executor.dispatch(command('set_cover', 1, { imageUrl: 'https://cdn.test/missing.png' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cover_source_not_uploaded');
});

test('passes through the Facebook composer and fill deadlines without widening other publish commands', async () => {
  const timeouts: number[] = [];
  const runtime = {
    execute: async (
      _owner: string,
      _nativeCommand: NativePageCommand,
      timeoutMs: number,
    ) => {
      timeouts.push(timeoutMs);
      return {
        effectPhase: 'confirmed' as const,
        output: { kind: 'publish_receipt', value: { ok: true } },
      };
    },
  } as unknown as NativePageRuntime;
  const executor = new NativePublishExecutor(runtime, 'aidcp-native-publish-test-');

  await executor.dispatch({
    ...command('select_mode', 1, {
      optionKind: 'target',
      optionValue: 'facebook_personal_timeline',
    }, 'facebook'),
    timeoutMs: 40_000,
  });
  await executor.dispatch({
    ...command('select_mode', 2, {
      optionKind: 'target',
      optionValue: 'xiaohongshu_note',
    }),
    timeoutMs: 40_000,
  });
  await executor.dispatch(command('select_mode', 3, {
    optionKind: 'target',
    optionValue: 'facebook_personal_timeline',
  }, 'facebook'));
  await executor.dispatch({
    ...command('fill_field', 4, {
      fieldType: 'content',
      value: 'Vietnamese body',
    }, 'facebook'),
    timeoutMs: 400_000,
  });
  await executor.dispatch({
    ...command('fill_field', 5, {
      fieldType: 'content',
      value: 'XHS body',
    }),
    timeoutMs: 400_000,
  });

  assert.deepEqual(timeouts, [40_000, 30_000, 30_000, 400_000, 30_000]);
});

test('keeps the Native publish failure reason instead of replacing it with the effect phase', async () => {
  const runtime = {
    execute: async () => ({
      ok: false,
      effectPhase: 'ambiguous' as const,
      reasonCode: 'post_validate_failed',
      output: {
        kind: 'publish_receipt',
        value: { ok: false, error: 'draft_success_signal_missing', submitDispatched: true },
      },
    }),
  } as unknown as NativePageRuntime;
  const executor = new NativePublishExecutor(runtime, 'aidcp-native-publish-test-');

  const result = await executor.dispatch(command('submit_publish', 1));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'draft_success_signal_missing');
  assert.equal(result.submitDispatched, true);
});

test('a dispatched submit that loses the engine stays non-retryable and preserves its reason', async () => {
  const runtime = {
    execute: async (
      _owner: string,
      _nativeCommand: NativePageCommand,
      _timeoutMs: number,
      _signal?: AbortSignal,
      _commitWindowHandler?: unknown,
      onDispatched?: () => void,
    ) => {
      onDispatched?.();
      throw Object.assign(new Error('engine timed out after accepting the command'), {
        code: 'engine_timeout',
        detail: { reasonCode: 'publish_result_lost' },
      });
    },
  } as unknown as NativePageRuntime;
  const executor = new NativePublishExecutor(runtime, 'aidcp-native-publish-test-');

  const result = await executor.dispatch(command('submit_publish', 1));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'publish_result_lost');
  assert.equal(result.submitDispatched, true);
});

test('a submit rejected while acquiring its Native session remains pre-dispatch', async () => {
  const runtime = {
    execute: async () => {
      throw Object.assign(new Error('Native session could not be opened'), { code: 'engine_exited' });
    },
  } as unknown as NativePageRuntime;
  const executor = new NativePublishExecutor(runtime, 'aidcp-native-publish-test-');

  const result = await executor.dispatch(command('submit_publish', 1));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'engine_exited');
  assert.equal(result.submitDispatched, undefined);
});
