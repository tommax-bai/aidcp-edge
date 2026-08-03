import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type LoginResult = {
  ok: boolean;
  reason?: 'invalid_credentials' | 'rate_limited' | 'network';
};
type StartupResult = {
  ready: boolean;
  source?: 'disabled' | 'session' | 'credentials';
  reason?: string;
};
type Dependencies = {
  enabled: boolean;
  hasValidSession: () => boolean;
  validateExistingSession: () => Promise<boolean>;
  loadSavedCredentials: () => { name: string; key: string } | null;
  clearSessionPreservingCredentials: () => void;
  clearSessionAndCredentials: () => void;
  loginWithCredentials: (credentials: { name: string; key: string }) => Promise<LoginResult>;
};

const require = createRequire(import.meta.url);
const { restoreClientAuthAtStartup } = require('../../src/electron/client-startup-auth.cjs') as {
  restoreClientAuthAtStartup: (dependencies: Dependencies) => Promise<StartupResult>;
};
const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');

function setup({
  enabled = true,
  sessionValid = false,
  sessionAccepted = false,
  credentials = { name: 'alice', key: 'ck_secret' } as { name: string; key: string } | null,
  loginResult = { ok: true } as LoginResult,
} = {}) {
  const calls = {
    validate: 0,
    load: 0,
    clearSession: 0,
    clearAll: 0,
    login: 0,
  };
  const dependencies: Dependencies = {
    enabled,
    hasValidSession: () => sessionValid,
    validateExistingSession: async () => {
      calls.validate += 1;
      return sessionAccepted;
    },
    loadSavedCredentials: () => {
      calls.load += 1;
      return credentials;
    },
    clearSessionPreservingCredentials: () => { calls.clearSession += 1; },
    clearSessionAndCredentials: () => { calls.clearAll += 1; },
    loginWithCredentials: async (submitted) => {
      calls.login += 1;
      assert.deepEqual(submitted, credentials);
      return loginResult;
    },
  };
  return { calls, dependencies };
}

test('disabled auth and an accepted existing session do not submit saved credentials', async () => {
  const disabled = setup({ enabled: false, sessionValid: false });
  assert.deepEqual(await restoreClientAuthAtStartup(disabled.dependencies), {
    ready: true,
    source: 'disabled',
  });
  assert.equal(disabled.calls.login, 0);

  const restored = setup({ sessionValid: true, sessionAccepted: true });
  assert.deepEqual(await restoreClientAuthAtStartup(restored.dependencies), {
    ready: true,
    source: 'session',
  });
  assert.deepEqual(restored.calls, {
    validate: 1,
    load: 0,
    clearSession: 0,
    clearAll: 0,
    login: 0,
  });
});

test('expired or server-rejected session uses saved credentials exactly once', async () => {
  for (const sessionValid of [false, true]) {
    const fixture = setup({ sessionValid, sessionAccepted: false });
    assert.deepEqual(await restoreClientAuthAtStartup(fixture.dependencies), {
      ready: true,
      source: 'credentials',
    });
    assert.equal(fixture.calls.validate, sessionValid ? 1 : 0);
    assert.equal(fixture.calls.load, 1);
    assert.equal(fixture.calls.clearSession, 1);
    assert.equal(fixture.calls.login, 1);
    assert.equal(fixture.calls.clearAll, 0);
  }
});

test('missing encrypted credentials stops at the login gate without a login request', async () => {
  const fixture = setup({ credentials: null });
  assert.deepEqual(await restoreClientAuthAtStartup(fixture.dependencies), {
    ready: false,
    reason: 'credentials_unavailable',
  });
  assert.equal(fixture.calls.clearSession, 1);
  assert.equal(fixture.calls.login, 0);
  assert.equal(fixture.calls.clearAll, 0);
});

test('definitive credential rejection clears remembered credentials after one attempt', async () => {
  const fixture = setup({ loginResult: { ok: false, reason: 'invalid_credentials' } });
  assert.deepEqual(await restoreClientAuthAtStartup(fixture.dependencies), {
    ready: false,
    reason: 'invalid_credentials',
  });
  assert.equal(fixture.calls.login, 1);
  assert.equal(fixture.calls.clearAll, 1);
});

test('network and rate-limit failures preserve encrypted credentials and never retry', async () => {
  for (const reason of ['network', 'rate_limited'] as const) {
    const fixture = setup({ loginResult: { ok: false, reason } });
    assert.deepEqual(await restoreClientAuthAtStartup(fixture.dependencies), {
      ready: false,
      reason,
    });
    assert.equal(fixture.calls.login, 1);
    assert.equal(fixture.calls.clearSession, 1);
    assert.equal(fixture.calls.clearAll, 0);
  }
});

test('Electron startup awaits one-shot recovery before authenticated startup proceeds', () => {
  const start = main.indexOf('app.whenReady().then(async () => {');
  const end = main.indexOf('// 监督者级兜底', start);
  assert.ok(start >= 0 && end > start);
  const startup = main.slice(start, end);
  assert.match(startup, /const startupAuth = await prepareClientAuthForStartup\(\);/);
  assert.ok(
    startup.indexOf('await prepareClientAuthForStartup()') < startup.indexOf('await proceedAfterAuth()'),
    'saved-credential recovery must settle before the authenticated main window path',
  );
  assert.match(startup, /if \(!startupAuth\.ready\) \{[\s\S]*createLoginWindow\(\);[\s\S]*return;/);

  const ipcStart = main.indexOf("ipcMain.handle('client-auth:login'");
  const ipcEnd = main.indexOf("ipcMain.handle('client-auth:logout'", ipcStart);
  const manualLogin = main.slice(ipcStart, ipcEnd);
  assert.match(manualLogin, /const payload = parseClientLoginPayload\(creds\)/);
  assert.match(manualLogin, /await establishClientSession\(payload\)/);
  assert.match(main, /loginWithCredentials: establishClientSession/);
});
