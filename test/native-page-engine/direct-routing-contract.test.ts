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
  }, '61591824155856');
  assert.deepEqual(command, {
    kind: 'interaction_comment',
    params: {
      noteId: 'n1',
      text: 'approved',
      reason: 'commit',
      accountId: '61591824155856',
    },
  });
});

test('preserves Facebook first-post selection across the Native command boundary', () => {
  const command = nativeCommandForEnvelope({
    v: 1,
    id: 'first-post-open',
    ts: Date.now(),
    type: 'note.open',
    payload: {
      taskId: 'lease-secret',
      selection: 'first_commentable_group_post',
      container: 'https://www.facebook.com/groups/945390701793119',
    },
  } as never);
  assert.deepEqual(command, {
    kind: 'note_open',
    params: {
      selection: 'first_commentable_group_post',
      container: 'https://www.facebook.com/groups/945390701793119',
    },
  });
});

test('preserves unified resume target while legacy page.scroll remains compatible', () => {
  const resume = nativeCommandForEnvelope({
    v: 2,
    id: 'resume-reels',
    ts: Date.now(),
    type: 'page.scroll',
    payload: {
      taskId: 'must-not-cross-native-boundary',
      reason: 'resume_redrive',
      targetSurface: 'reels',
    },
  } as never);
  assert.deepEqual(resume, {
    kind: 'page_scroll',
    params: { reason: 'resume_redrive', targetSurface: 'reels' },
  });

  const legacy = nativeCommandForEnvelope({
    v: 2,
    id: 'legacy-scroll',
    ts: Date.now(),
    type: 'page.scroll',
    payload: { reason: 'feed_scroll' },
  } as never);
  assert.deepEqual(legacy, {
    kind: 'page_scroll',
    params: { reason: 'feed_scroll' },
  });
});

test('identity commands preserve Cloud correlation but inject only the Edge-bound account', () => {
  const current = nativeCommandForEnvelope({
    v: 2,
    id: 'identity-current',
    ts: Date.now(),
    type: 'identity.read_current',
    payload: { captureId: 'capture-1', accountId: 'cloud-must-not-choose' },
  } as never, 'edge-bound-account');
  assert.deepEqual(current, {
    kind: 'identity_read_current',
    params: { captureId: 'capture-1', accountId: 'edge-bound-account' },
  });

  const selfProfile = nativeCommandForEnvelope({
    v: 2,
    id: 'identity-self',
    ts: Date.now(),
    type: 'identity.read_self_profile',
    payload: { captureId: 'capture-2' },
  } as never, 'edge-bound-account');
  assert.deepEqual(selfProfile, {
    kind: 'identity_read_self_profile',
    params: { captureId: 'capture-2', accountId: 'edge-bound-account' },
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

test('main wires every browser-platform page path to Native-only and has no legacy dispatch branch', async () => {
  const main = await readFile(resolve(repoRoot, 'src/main.ts'), 'utf8');
  const runtime = await readFile(resolve(repoRoot, 'src/native-page-engine/runtime.ts'), 'utf8');
  assert.match(main, /\$\{platformDriver\.platform\} 页面执行已切换为 Native-only/);
  assert.match(main, /const nativePageRuntime = NativePageRuntime\.fromEnvironment/);
  assert.match(main, /if \(autoBrowse\) \{[\s\S]*new NativeBrowseSession/);
  assert.match(main, /nativePublishExecutor\.dispatch/);
  assert.match(main, /client\.onPlanCommand\(dispatchOrQueuePageCommand\)/);
  assert.match(main, /installPageCommandHandler\(routeNativeCommand\)/);
  assert.doesNotMatch(main, /PublishCommandDispatcher|new BrowseSession\(|CloudElementSelector|LikeStepRunner/);
  assert.doesNotMatch(main, /client\.onPublishCommand\(/);
  assert.match(runtime, /AIDCP_NATIVE_PAGE_ENGINE_BINARY is required/);
  assert.doesNotMatch(runtime, /shadow|fallback/i);
});
