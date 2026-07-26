import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const capabilityDirectory = resolve(repoRoot, 'native/page-engine/src/facebook');

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
