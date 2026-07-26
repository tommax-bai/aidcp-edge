import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Native browse orchestration imports the production-safe post identity module', () => {
  const browseSession = readFileSync(
    new URL('../../src/native-page-engine/browse-session.ts', import.meta.url),
    'utf8',
  );
  const identityCore = readFileSync(
    new URL('../../src/facebook/post-identity-core.ts', import.meta.url),
    'utf8',
  );
  const productionPruner = readFileSync(
    new URL('../../scripts/prune-production-dist.mjs', import.meta.url),
    'utf8',
  );

  assert.match(
    browseSession,
    /from ['"]\.\.\/facebook\/post-identity-core\.js['"]/,
  );
  assert.doesNotMatch(
    browseSession,
    /from ['"]\.\.\/facebook\/post-identity\.js['"]/,
  );
  assert.doesNotMatch(identityCore, /\bfrom\s+['"]/);
  assert.doesNotMatch(identityCore, /\b(?:FB_TARGET_HELPERS_JS|FACEBOOK_REACTION_CONTROL_HELPERS_JS)\b/);
  assert.match(productionPruner, /['"]facebook\/post-identity\.js['"]/);
  assert.match(productionPruner, /['"]facebook\/cta-labels\.js['"]/);
});
