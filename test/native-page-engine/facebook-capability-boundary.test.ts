import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const capabilityDirectory = resolve(repoRoot, 'native/page-engine/src/facebook');
const routerDirectory = resolve(repoRoot, 'native/page-engine/src/facebook-router');

test('generic engine contains no command-specific Facebook workflow', async () => {
  const engine = await readFile(resolve(repoRoot, 'native/page-engine/src/engine.rs'), 'utf8');
  assert.doesNotMatch(engine, /\bexecute_facebook_/);
  assert.doesNotMatch(engine, /\b(?:probe|commit|dispatch|validated)_facebook_/);
  assert.doesNotMatch(engine, /facebook::[a-z_]+_expression/);
  assert.match(engine, /facebook::runtime::execute/);
});

test('every declared Facebook owner has one capability runtime module with behavior', async () => {
  const runtime = await readFile(resolve(capabilityDirectory, 'runtime.rs'), 'utf8');
  const owners = [...runtime.matchAll(/FacebookCapability::(\w+)\s*=>/g)]
    .map((match) => match[1]);
  assert.deepEqual(owners, [
    'Session',
    'Feed',
    'FeedLike',
    'Reels',
    'GroupJoin',
    'Comment',
    'Publish',
  ]);

  const modules = [
    ['session.rs', 'execute_facebook_identity'],
    ['feed.rs', 'execute_facebook_initial_feed'],
    ['feed_like.rs', 'execute_facebook_like'],
    ['reels.rs', 'execute_facebook_follow'],
    ['group_join.rs', 'execute_facebook_group_join'],
    ['comment.rs', 'execute_facebook_comment'],
    ['publish.rs', 'execute_facebook_publish_submit'],
  ] as const;
  for (const [file, behavior] of modules) {
    const source = await readFile(resolve(capabilityDirectory, file), 'utf8');
    assert.match(source, new RegExp(`async fn ${behavior}\\b`), `${file} must own ${behavior}`);
  }
});

test('parity ledger points only at focused executable behavior suites', async () => {
  const ledger = await readFile(resolve(capabilityDirectory, 'capability.rs'), 'utf8');
  const suites = [...ledger.matchAll(/"((?:test\/)[^"]+\.test\.ts)"/g)]
    .map((match) => match[1]!);
  assert.ok(suites.length >= 2);
  for (const suite of new Set(suites)) {
    await access(resolve(repoRoot, suite));
  }
});

test('reaction semantics are assembled once before Feed and Reels capability consumers', async () => {
  const manifest = (await readFile(resolve(routerDirectory, 'manifest.txt'), 'utf8'))
    .trim()
    .split(/\r?\n/);
  assert.ok(manifest.indexOf('08-reaction-semantics.js') > manifest.indexOf('05-session.js'));
  assert.ok(manifest.indexOf('08-reaction-semantics.js') < manifest.indexOf('10-feed-like.js'));
  assert.ok(manifest.indexOf('08-reaction-semantics.js') < manifest.indexOf('30-reels.js'));

  const semantics = await readFile(resolve(routerDirectory, '08-reaction-semantics.js'), 'utf8');
  const feed = await readFile(resolve(routerDirectory, '10-feed-like.js'), 'utf8');
  const reels = await readFile(resolve(routerDirectory, '30-reels.js'), 'utf8');
  for (const symbol of ['neutralLike', 'unlike', 'postComment', 'reactionState']) {
    assert.match(semantics, new RegExp(`const ${symbol}=`));
    assert.doesNotMatch(feed, new RegExp(`const ${symbol}=`));
    assert.doesNotMatch(reels, new RegExp(`const ${symbol}=`));
  }
  assert.match(reels, /const reelReactionState=/);
});

test('Publish stage actions have one Rust owner and probe-only router vocabulary', async () => {
  const publish = await readFile(resolve(capabilityDirectory, 'publish.rs'), 'utf8');
  const vocabulary = await readFile(resolve(routerDirectory, '60-publish.js'), 'utf8');
  const dispatch = await readFile(resolve(routerDirectory, '90-dispatch.js'), 'utf8');

  for (const command of [
    'PublishNavigateEntry',
    'PublishSelectMode',
    'PublishFillField',
    'PublishSubmit',
  ]) {
    assert.match(publish, new RegExp(`NativeCommand::${command}`));
  }
  for (const kind of [
    'publish_navigate_entry',
    'publish_select_mode',
    'publish_fill_field',
    'publish_submit',
  ]) {
    assert.doesNotMatch(dispatch, new RegExp(`if\\(kind==='${kind}'\\)`));
  }
  assert.match(vocabulary, /分享你的新鲜事/);
  assert.match(vocabulary, /發佈/);
  assert.match(vocabulary, /publicar/);
  assert.match(vocabulary, /compartir/);
  assert.match(vocabulary, /your post is being processed/);
  assert.match(vocabulary, /publicación compartida/);
});
