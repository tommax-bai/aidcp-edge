import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const core = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');

test('credential fill failure keeps the core attached and waits for identity in place', () => {
  assert.match(core, /authResult\.kind === 'manual_required'[\s\S]*?type: 'lifecycle\.auth_required'/);
  assert.match(core, /kind: 'manual_login_required'[\s\S]*?reason: authResult\.reason/);
  assert.match(core, /authenticatedQuietWindowMs: FACEBOOK_AUTHENTICATED_QUIET_WINDOW_MS/,
    'production assembly must keep probing after the first authenticated observation');
  assert.match(core,
    /requiresFacebookAdDataReview\(manualLoginRequiredReason\)[\s\S]*?Facebook 广告数据选择待人工确认/,
    'a stable account identity must not bypass an unresolved post-login privacy choice');
  assert.match(core, /unbounded: Boolean\(manualLoginRequiredReason\)/);
  assert.match(core, /beforeIdentityRead: manualLoginRequiredReason[\s\S]*?reconcileFacebookAuthIfNeeded\(firstLoginPolicyApplied, loginWaitMs\)/,
    'the retained session must serially re-enter the existing coordinator with the original policy proof');
  assert.match(core, /authResult\.kind === 'timeout' && authResult\.actionAttempts > 0[\s\S]*?facebook_auth_timeout_after_action/,
    'a new coordinator instance must not guess state after a confirmed action times out');
  assert.match(core, /readPlatformIdentity\(\{ allowNavigate: false/);
  assert.match(core, /chrome\.killAndConfirmDead\(\)/,
    'explicit pause or close must confirm the owned AdsPower browser before the startup core exits');

  const manualBranch = core.slice(
    core.indexOf("if (authResult.kind === 'manual_required')"),
    core.indexOf("} else if (authResult.kind === 'timeout')"),
  );
  assert.doesNotMatch(manualBranch, /terminateNow\(/,
    'the known manual-login result must not disconnect the core');

  const retainedWait = core.slice(
    core.indexOf('beforeIdentityRead: manualLoginRequiredReason'),
    core.indexOf('// 平台无关就地重读'),
  );
  assert.equal((retainedWait.match(/reconcileFacebookAuthIfNeeded/g) ?? []).length, 1,
    'manual waiting must install one serialized auth consumer, not parallel watchers');
  assert.match(retainedWait,
    /authResult\.kind === 'manual_required'[\s\S]*?manualLoginRequiredReason !== authResult\.reason[\s\S]*?manualLoginRequiredReason = authResult\.reason[\s\S]*?type: 'lifecycle\.auth_required'[\s\S]*?reason: authResult\.reason[\s\S]*?requiresFacebookAdDataReview\(authResult\.reason\)[\s\S]*?kind: 'defer'/,
    'a retained wait must publish a changed review reason and defer identity until the review clears');
  assert.doesNotMatch(retainedWait, /setInterval|setTimeout|Promise\.all/,
    'manual waiting must reuse the identity cadence instead of creating another scheduler');
  assert.match(core, /onAutomaticProgress:[\s\S]*?type: 'lifecycle\.auth_progress'[\s\S]*?kind: 'automatic_login'/,
    'a retained coordinator that regains automatic authority must publish structured progress');
  assert.match(core, /type: 'lifecycle\.auth_failed'[\s\S]*?kind: 'terminal_auth_failure'/,
    'terminal authentication failures must be structured before process exit');
});

test('Electron accepts only enumerated Facebook manual reasons and keeps their browser blocked', () => {
  const authMessages = shell.slice(
    shell.indexOf('const FACEBOOK_MANUAL_AUTH_MESSAGES'),
    shell.indexOf('function facebookManualAuthMessage'),
  );
  assert.deepEqual(
    [...authMessages.matchAll(/^\s{2}([a-z][a-z0-9_]+):/gm)].map((match) => match[1]),
    [
      'credential_fill_unavailable',
      'stale_totp_input_requires_fresh_start',
      'fresh_start_policy_unavailable',
      'auth_probe_unavailable',
      'facebook_ad_data_review_requires_fresh_start',
      'facebook_ad_data_choice_required',
    ],
    'the shell must not accept an open-ended auth reason as manual-safe',
  );
  assert.match(shell,
    /function facebookManualAuthMessage\(reason\)[\s\S]*?hasOwnProperty\.call\(FACEBOOK_MANUAL_AUTH_MESSAGES, key\)[\s\S]*?: null;/,
    'unknown reasons must resolve to null and remain rejected');

  const authHandler = shell.slice(
    shell.indexOf("if (message.type === 'lifecycle.auth_required')"),
    shell.indexOf("if (message.type === 'facebook-totp.request')"),
  );
  assert.match(authHandler, /const authMessage = facebookManualAuthMessage\(message\.reason\)/);
  assert.match(authHandler, /message\.kind !== 'manual_login_required'[\s\S]*?\|\| !authMessage/,
    'an unknown reason must not enter the manual-attention projection');
  assert.match(authHandler, /settleLaunchReady\(handle, false\)/,
    'manual attention must release only the serial launch waiter');
  assert.match(authHandler, /authReason: message\.reason/);
  assert.match(authHandler, /loginFlow: \{ state: 'manual_required', reason: message\.reason \}/);
  assert.match(authHandler, /lastMessage: authMessage[\s\S]*?presencePatch\(authMessage\)/,
    'the accepted structured reason must drive the visible manual-attention copy');
  assert.match(shell, /status\.overlayBlocked \|\| facebookManualAuthMessage\(status\.authReason\)/,
    'all three retained manual reasons must project the browser as blocked');
  assert.match(shell, /next\.auth = 'logged in';\s*next\.authReason = null;/,
    'the existing stable account event clears the manual reason after in-place login');
  assert.match(shell, /message\.type === 'lifecycle\.close_failed'[\s\S]*?user_close'[\s\S]*?user_pause'/,
    'a failed confirmed-close attempt must remain visible for both explicit stop commands');

  assert.match(shell,
    /message\.type === 'lifecycle\.auth_progress'[\s\S]*?loginFlow: \{ state: 'automatic' \}[\s\S]*?正在自动登录/,
    'automatic progress must replace the earlier manual projection without log parsing');
  assert.match(authHandler,
    /message\.type === 'lifecycle\.auth_failed'[\s\S]*?loginFlow: \{ state: 'failed', reason \}/,
    'terminal authentication failure must enter an explicit projected state');
  assert.match(shell,
    /const terminalLoginFailure = handle\.status\.loginFlow[\s\S]*?const exitedAbnormally = retryableSetupFailure \|\| Boolean\(terminalLoginFailure\)/,
    'current-generation authentication failure must outrank an older intentional stop reason');
  assert.match(shell,
    /const decision = terminalLoginFailure[\s\S]*?\{ action: 'stop', streak: 0 \}/,
    'terminal authentication failure must not enter an automatic restart loop');
  assert.match(shell,
    /loginFlow: terminalLoginFailure[\s\S]*?登录认证异常[\s\S]*?edgeFailurePatch/,
    'child close must preserve the authentication failure instead of projecting ordinary offline');

  const browserControl = shell.slice(
    shell.indexOf('function writeBrowserControlCommand'),
    shell.indexOf('function personaNoticeReady'),
  );
  assert.match(browserControl, /handle\.child/);
  assert.match(browserControl, /handle\.browserParkingReady/);
  assert.doesNotMatch(browserControl, /authReason|login required/,
    'manual-login attention must not disable the existing show-browser control');
});
