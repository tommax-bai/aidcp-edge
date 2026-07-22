import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { nativeCommandForEnvelope, nativePublishCommand } from '../../src/native-page-engine/command-mapper.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('projects Edge coordination fields out of the Native command envelope', () => {
  const command = nativeCommandForEnvelope({
    v: 1, id: 'e1', ts: Date.now(), type: 'interaction.comment',
    payload: { taskId: 'lease-secret', noteId: 'n1', text: 'approved', reason: 'commit' },
  });
  assert.deepEqual(command, {
    kind: 'interaction_comment',
    params: { noteId: 'n1', text: 'approved', reason: 'commit' },
  });
});

test('maps every publish atom to one fixed Native command without a fallback surface', () => {
  const kinds = [
    'navigate_entry', 'select_mode', 'upload_image', 'set_cover', 'fill_field',
    'add_with_candidate', 'set_option', 'set_schedule', 'submit_publish',
    'capture_postId', 'capture_scheduled', 'reconcile_scheduled',
  ] as const;
  for (const kind of kinds) {
    const command = nativePublishCommand({
      platform: 'xiaohongshu', taskId: 'task-1', recordId: 7, seq: 1, kind,
      params: { fieldType: 'title', value: 'x', candidateKind: 'topic', candidates: [], imageUrl: 'https://example.test/a.jpg', optionKind: 'visibility', optionValue: 'public', publishTime: Date.now() + 60_000 },
    }, { localImagePath: '/tmp/authorized.jpg', imageIndex: 0 });
    assert.match(command.kind, /^publish_/);
    assert.ok(!('taskId' in command.params));
  }
});

test('main wires every Xiaohongshu page path to Native-only and has no legacy dispatch branch', async () => {
  const main = await readFile(resolve(repoRoot, 'src/main.ts'), 'utf8');
  const runtime = await readFile(resolve(repoRoot, 'src/native-page-engine/runtime.ts'), 'utf8');
  assert.match(main, /小红书页面执行已切换为 Native-only/);
  assert.match(main, /if \(autoBrowse && nativePageRuntime\)/);
  assert.match(main, /nativePublishExecutor\.dispatch/);
  assert.match(main, /client\.onPlanCommand\(dispatchOrQueuePageCommand\)/);
  assert.match(main, /installPageCommandHandler\(routeNativeCommand\)/);
  assert.doesNotMatch(main, /PublishCommandDispatcher|new BrowseSession\(|CloudElementSelector|LikeStepRunner/);
  assert.doesNotMatch(main, /client\.onPublishCommand\(/);
  assert.match(runtime, /AIDCP_NATIVE_PAGE_ENGINE_BINARY is required/);
  assert.doesNotMatch(runtime, /shadow|fallback/i);
});
