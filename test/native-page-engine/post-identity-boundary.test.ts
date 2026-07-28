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
  // 生产剪枝黑名单的落点已从 prune-production-dist.mjs 收口到共享事实源模块
  // （分片枚举从清单派生，退役 TypeScript 模块清单与之并列在同一处）。
  const productionExclusionList = readFileSync(
    new URL('../../scripts/native-engine-inventory.cjs', import.meta.url),
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
  // 存在性断言：只证明这两条登记在退役清单里，不构成「闸门会判定」的证据；
  // 判定证据在 artifact-gates.test.ts 的植入式自测（植入被禁模块并观察拒绝）。
  assert.match(productionExclusionList, /['"]facebook\/post-identity\.js['"]/);
  assert.match(productionExclusionList, /['"]facebook\/cta-labels\.js['"]/);
});
