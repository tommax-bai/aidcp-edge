import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// main.cjs has Electron top-level side effects, so lock the lifecycle ordering at
// source-contract level (the established pattern for Electron main-process tests).
const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');

function blockBetween(startMarker: string, endMarker: string): string {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return main.slice(start, end);
}

test('restored near-expiry session refreshes before authenticated startup proceeds', () => {
  const startup = blockBetween('async function proceedAfterAuth()', 'function startSessionMaintenance()');
  assert.match(startup, /if \(clientAuthEnabled\(\)\) \{[\s\S]*if \(!hasValidSession\(\)\) \{ onSessionInvalid\(\); return; \}/,
    'enabled auth must fail closed if the session expires during startup');
  assert.match(startup, /const sessionReady = await refreshClientSessionIfNeeded\(\);/,
    'startup must run the near-expiry refresh helper');
  assert.ok(
    startup.indexOf('await refreshClientSessionIfNeeded()') < startup.indexOf('await refreshAllowedEnvironments()'),
    'token refresh must happen before scope refresh',
  );
  assert.ok(
    startup.indexOf('await refreshClientSessionIfNeeded()') < startup.indexOf('createWindow()'),
    'token refresh must happen before the main window proceeds',
  );
});

test('shared refresh helper invalidates local expiry and refresh 401 without destroying a valid session on transient failure', () => {
  const helper = blockBetween('async function refreshClientSessionIfNeeded()', 'async function clientAuthFetch(');
  assert.match(helper, /if \(!hasValidSession\(\)\) \{ onSessionInvalid\(\); return false; \}/,
    'local expiry must use the unified invalidation path');
  assert.match(helper, /CLIENT_SESSION_REFRESH_WINDOW_MS/);
  assert.match(helper, /clientAuthFetch\('\/auth\/refresh', \{ method: 'POST', token: clientSession\.token \}\)/);
  assert.match(helper, /saveClientSession\(\{/,
    'successful refresh must persist the replacement session');
  assert.match(helper, /if \(rr\.status === 401 \|\| !hasValidSession\(\)\) \{[\s\S]*onSessionInvalid\(\);[\s\S]*return false;/,
    'server invalidation or expiry during refresh must return to login');
  assert.match(helper, /return true;\s*\}/,
    'a non-401 transient failure may preserve a session that is still locally valid');
});

test('periodic maintenance no longer silently returns when the local session is expired', () => {
  const maintenance = blockBetween('function startSessionMaintenance()', '// 把花名册首成员镜像回旧单值字段');
  assert.match(maintenance, /if \(!clientAuthEnabled\(\)\) return;/,
    'disabled customer auth remains a no-op');
  assert.match(maintenance, /const sessionReady = await refreshClientSessionIfNeeded\(\);[\s\S]*if \(!sessionReady\) return;/,
    'enabled auth delegates expiry and refresh handling to the fail-closed helper');
  assert.doesNotMatch(maintenance, /!clientAuthEnabled\(\) \|\| !hasValidSession\(\)\) return/,
    'the original silent local-expiry branch must not return');
});

test('protected customer-content request invalidates both local expiry and server 401', () => {
  const request = blockBetween('async function delegatedTaskRequest(', "ipcMain.handle('delegated-task:list'");
  assert.match(request, /if \(!clientAuthEnabled\(\)\) return \{ ok: false, status: 401, error: 'client_session_required' \};/,
    'disabled authentication remains distinguishable from an expired session');
  assert.match(request, /if \(!hasValidSession\(\)\) \{[\s\S]*onSessionInvalid\(\);[\s\S]*error: 'client_session_expired'/,
    'local expiry must close the stale main window and report expiry');
  assert.match(request, /if \(r\.status === 401\) \{[\s\S]*onSessionInvalid\(\);[\s\S]*error: 'client_session_expired'/,
    'server-rejected session must use the same invalidation path');
});
