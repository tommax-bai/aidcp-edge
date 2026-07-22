import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublishCommandPayload } from '../../src/comm/protocol.js';
import type { NativePageCommand } from '../../src/native-page-engine/client.js';
import { NativePublishExecutor } from '../../src/native-page-engine/publish.js';
import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

function command(kind: PublishCommandPayload['kind'], seq: number, params: PublishCommandPayload['params'] = {}): PublishCommandPayload {
  return { platform: 'xiaohongshu', taskId: 'task-native', recordId: 9, seq, kind, params };
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
