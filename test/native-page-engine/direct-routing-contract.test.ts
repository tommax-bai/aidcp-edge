import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { nativeActionNameForCommand, nativeCommandForEnvelope, nativePublishCommand } from '../../src/native-page-engine/command-mapper.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('projects Edge coordination fields out of the Native command envelope', () => {
  const command = nativeCommandForEnvelope({
    v: 1, id: 'e1', ts: Date.now(), type: 'xiaohongshu.note.comment',
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
    type: 'facebook.note.open',
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

test('derives the scroll surface from the platform-segmented envelope name', () => {
  // 词汇批 4：面由命令名声明，mapper 解析为引擎 surface 参数；targetSurface 载荷字段已退役。
  const resume = nativeCommandForEnvelope({
    v: 2,
    id: 'resume-reels',
    ts: Date.now(),
    type: 'facebook.reels.scroll',
    payload: {
      taskId: 'must-not-cross-native-boundary',
      reason: 'resume_redrive',
    },
  } as never);
  assert.deepEqual(resume, {
    kind: 'page_scroll',
    params: { reason: 'resume_redrive', surface: 'reels' },
  });

  const feed = nativeCommandForEnvelope({
    v: 2,
    id: 'feed-scroll',
    ts: Date.now(),
    type: 'xiaohongshu.feed.scroll',
    payload: { reason: 'feed_scroll' },
  } as never);
  assert.deepEqual(feed, {
    kind: 'page_scroll',
    params: { reason: 'feed_scroll', surface: 'feed' },
  });

  const search = nativeCommandForEnvelope({
    v: 2,
    id: 'search-scroll',
    ts: Date.now(),
    type: 'facebook.search.scroll',
    payload: { reason: 'search_scroll' },
  } as never);
  assert.deepEqual(search, {
    kind: 'page_scroll',
    params: { reason: 'search_scroll', surface: 'search' },
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

test('derives the like object from the platform-segmented envelope name', () => {
  // 词汇批 5：对象由命令名声明（按对象拆、不按位置拆），mapper 解析为引擎 object 参数；
  // FB 引擎据此路由视频/帖级执行器，现场不符诚实失败。
  const video = nativeCommandForEnvelope({
    v: 2, id: 'video-like', ts: Date.now(), type: 'facebook.video.like',
    payload: { noteId: 'https://www.facebook.com/reel/1' },
  } as never);
  assert.deepEqual(video, {
    kind: 'interaction_like',
    params: { noteId: 'https://www.facebook.com/reel/1', object: 'video' },
  });

  const post = nativeCommandForEnvelope({
    v: 2, id: 'post-like', ts: Date.now(), type: 'facebook.note.like',
    payload: { noteId: 'https://www.facebook.com/a/posts/1' },
  } as never);
  assert.deepEqual(post, {
    kind: 'interaction_like',
    params: { noteId: 'https://www.facebook.com/a/posts/1', object: 'note' },
  });

  const xhs = nativeCommandForEnvelope({
    v: 2, id: 'xhs-like', ts: Date.now(), type: 'xiaohongshu.note.like',
    payload: { noteId: 'n1' },
  } as never);
  assert.deepEqual(xhs, {
    kind: 'interaction_like',
    params: { noteId: 'n1', object: 'note' },
  });
});

test('interaction correlation keys: every platform-object envelope has an explicit table entry with the legacy value', () => {
  // 词汇批 5 红线（协议第 5 处同步点）：关联键值与协议名脱钩、值不动。
  // 本断言杀 nativeActionNameForCommand 的 `?? type` 静默回落——漏表项时新命令名会被
  // 当关联键发出，云端角色永远等不到回执且当未知失败动作处理（CLAUDE.md §2 第 5 处）。
  const expected: Record<string, string> = {
    'xiaohongshu.note.like': 'like',
    'facebook.note.like': 'like',
    'facebook.video.like': 'like',
    'xiaohongshu.note.collect': 'collect',
    'xiaohongshu.user.follow': 'follow',
    'facebook.user.follow': 'follow',
    'xiaohongshu.note.comment': 'comment',
    'facebook.note.comment': 'comment',
    'xiaohongshu.comment.like': 'comment_like',
  };
  for (const [type, action] of Object.entries(expected)) {
    assert.equal(nativeActionNameForCommand(type), action,
      `${type} 必须有显式关联键表项（值=${action}），绝不允许回落成命令名`);
  }
});
