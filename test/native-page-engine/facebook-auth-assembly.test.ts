import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainSource = readFileSync(
  new URL('../../src/main.ts', import.meta.url),
  'utf8',
);
const coordinatorSource = readFileSync(
  new URL('../../src/native-page-engine/facebook-auth.ts', import.meta.url),
  'utf8',
);
const clientSource = readFileSync(
  new URL('../../src/native-page-engine/client.ts', import.meta.url),
  'utf8',
);
const identitySource = readFileSync(
  new URL('../../src/native-page-engine/identity.ts', import.meta.url),
  'utf8',
);

test('startup assembly runs Facebook auth after Native runtime construction and before stable identity', () => {
  const runtimeAt = mainSource.indexOf('const nativePageRuntime = NativePageRuntime.fromEnvironment(');
  const startupBlockAt = mainSource.indexOf('if (startBrowserAbsent) {', runtimeAt);
  const authAt = mainSource.indexOf(
    'await reconcileFacebookAuthIfNeeded(firstLoginPolicyApplied, loginWaitMs)',
    startupBlockAt,
  );
  const identityAt = mainSource.indexOf(
    'const idRes: SelfIdentityResult = requiresFacebookAdDataReview(manualLoginRequiredReason)',
    startupBlockAt,
  );

  assert.ok(runtimeAt >= 0, 'Native runtime construction must remain present');
  assert.ok(startupBlockAt > runtimeAt, 'startup identity block must follow Native runtime construction');
  assert.ok(authAt > startupBlockAt, 'startup block must invoke the Facebook auth coordinator');
  assert.ok(identityAt > authAt, 'stable identity must remain after Facebook auth reconciliation');
});

test('cold-standby assembly reconciles after reattach and before wake identity read', () => {
  const wakeAt = mainSource.indexOf('wakeFromStandby: async');
  const reattachAt = mainSource.indexOf('await reattachSession(session, attachOpts)', wakeAt);
  const authAt = mainSource.indexOf(
    'await reconcileFacebookAuthIfNeeded(firstLoginPolicyApplied, loginWaitMs)',
    reattachAt,
  );
  const identityAt = mainSource.indexOf('const idRes = await readPlatformIdentity({', authAt);

  assert.ok(wakeAt >= 0);
  assert.ok(reattachAt > wakeAt);
  assert.ok(authAt > reattachAt, 'wake auth must not run against the detached generation');
  assert.ok(identityAt > authAt, 'wake stable identity must remain the final authority after auth');
  assert.match(
    mainSource.slice(wakeAt, authAt),
    /firstLoginPolicyApplied = relaunched\.firstLoginPolicyApplied === true/,
    'each browser generation must use only its own fresh-start policy evidence',
  );
});

test('TypeScript coordinator routes page semantics and input only through Native commands', () => {
  for (const command of [
    'facebook_auth_probe',
    'facebook_auth_submit_login',
    'facebook_auth_enter_totp',
    'facebook_auth_submit_totp',
    'facebook_auth_clear_totp',
    'facebook_auth_dismiss_warning',
    'facebook_auth_close_push_blocker',
    'facebook_auth_confirm_remember_password',
    'facebook_auth_start_ad_data_review',
  ]) {
    assert.match(coordinatorSource, new RegExp(`['"]${command}['"]`));
  }

  assert.doesNotMatch(coordinatorSource, /\bsession\.cdp\b/);
  assert.doesNotMatch(coordinatorSource, /\bRuntime\.evaluate\b/);
  assert.doesNotMatch(coordinatorSource, /\bInput\.dispatch(?:Mouse|Key)Event\b/);
  assert.doesNotMatch(coordinatorSource, /\bquerySelector(?:All)?\b/);
  assert.doesNotMatch(coordinatorSource, /\bdocument\./);
});

test('auth probe policy and receipts remain explicit typed Native protocol fields', () => {
  assert.match(
    coordinatorSource,
    /probeParams\(enteredWindow,\s*options\.freshStartPolicyApplied\)/,
  );
  assert.match(coordinatorSource, /NATIVE_FACEBOOK_AUTH_SIGNALS/);
  assert.doesNotMatch(coordinatorSource, /as NativePageCommandKind/);
  assert.match(clientSource, /output\?: NativePageCommandOutput/);
  assert.match(clientSource, /kind: 'facebook_auth_probe'; value: NativeFacebookAuthProbeReceipt/);
  assert.match(clientSource, /kind: 'facebook_auth_action'; value: NativeFacebookAuthActionReceipt/);
});

test('stable Facebook identity adapter stays read-only and separate from auth actions', () => {
  assert.match(identitySource, /kind:\s*['"]identity_bootstrap['"]/);
  assert.doesNotMatch(identitySource, /facebook_auth_/);
  assert.doesNotMatch(identitySource, /reconcileFacebookStartupAuth/);
});
