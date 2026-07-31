import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const core = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');

test('credential fill failure keeps the core attached and waits for identity in place', () => {
  assert.match(core, /authResult\.kind === 'manual_required'[\s\S]*?type: 'lifecycle\.auth_required'/);
  assert.match(core, /kind: 'manual_login_required'[\s\S]*?reason: authResult\.reason/);
  assert.match(core, /unbounded: Boolean\(manualLoginRequiredReason\)/);
  assert.match(core, /readPlatformIdentity\(\{ allowNavigate: false/);
  assert.match(core, /chrome\.killAndConfirmDead\(\)/,
    'explicit pause or close must confirm the owned AdsPower browser before the startup core exits');

  const manualBranch = core.slice(
    core.indexOf("if (authResult.kind === 'manual_required')"),
    core.indexOf("} else if (authResult.kind === 'timeout')"),
  );
  assert.doesNotMatch(manualBranch, /terminateNow\(/,
    'the known manual-login result must not disconnect the core');
});

test('Electron projects the structured reason without releasing browser ownership', () => {
  assert.match(shell, /message\.type === 'lifecycle\.auth_required'/);
  assert.match(shell, /message\.reason !== 'credential_fill_unavailable'/);
  assert.match(shell, /settleLaunchReady\(handle, false\)/,
    'manual attention must release only the serial launch waiter');
  assert.match(shell, /authReason: message\.reason/);
  assert.match(shell, /status\.overlayBlocked \|\| status\.authReason === 'credential_fill_unavailable'/,
    'the retained browser must be shown as waiting for manual handling');
  assert.match(shell, /next\.auth = 'logged in';\s*next\.authReason = null;/,
    'the existing stable account event clears the manual reason after in-place login');
  assert.match(shell, /message\.type === 'lifecycle\.close_failed'[\s\S]*?user_close'[\s\S]*?user_pause'/,
    'a failed confirmed-close attempt must remain visible for both explicit stop commands');

  const browserControl = shell.slice(
    shell.indexOf('function writeBrowserControlCommand'),
    shell.indexOf('function personaNoticeReady'),
  );
  assert.match(browserControl, /handle\.child/);
  assert.match(browserControl, /handle\.browserParkingReady/);
  assert.doesNotMatch(browserControl, /authReason|login required/,
    'manual-login attention must not disable the existing show-browser control');
});
