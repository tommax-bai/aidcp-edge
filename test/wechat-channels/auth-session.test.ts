import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserProfileInUseError } from '../../src/cdp/browser-provider.js';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import { WechatAuthCoordinator } from '../../src/wechat-channels/auth-session.js';
import {
  captureRequestContext,
  safeBrowserSidecarDiagnostic,
  type WechatChannelsBrowserSidecar,
} from '../../src/wechat-channels/browser-sidecar.js';
import { EncryptedWechatSessionStore } from '../../src/wechat-channels/encrypted-session-store.js';
import { WechatChannelsError } from '../../src/wechat-channels/error-classifier.js';
import {
  DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS,
  WechatCapabilityState,
  WechatEndpointCircuitBreaker,
} from '../../src/wechat-channels/feature-flags.js';
import { sessionPath } from '../../src/wechat-channels/local-paths.js';
import { WechatChannelsProbeRunner } from '../../src/wechat-channels/probes/black-box-probe.js';
import type { WechatIdentity, WechatSessionMaterial } from '../../src/wechat-channels/types.js';

const SCOPE = { envKey: 'env-a', browserProfileId: 'profile-a' };
const IDENTITY: WechatIdentity = { externalId: 'finder-a', displayName: 'Finder A' };
const SESSION: WechatSessionMaterial = {
  cookies: [{ name: 'session_key', value: 'cookie-top-secret', domain: '.channels.weixin.qq.com', path: '/' }],
  userAgent: 'Wechat-Test-UA',
  acquiredAt: 100,
  requestContext: { version: 1, aid: 'aid-test', pageUrl: 'https://channels.weixin.qq.com/platform/post/list', commonBody: { logFinderId: 'finder-test', logFinderUin: 'uin-test', rawKeyBuff: 'raw-key-test', pluginSessionId: null, reqScene: 7, scene: 7 }, headers: { fingerprintDeviceId: 'device-test', wechatUin: 'uin-test' } },
};

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aidcp-wc-auth-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class FakeSidecar implements WechatChannelsBrowserSidecar {
  readonly browserProfileId = SCOPE.browserProfileId;
  state: 'closed' | 'open' | 'unavailable' = 'closed';
  opens = 0;
  closes = 0;

  constructor(
    private readonly candidate: WechatSessionMaterial | null,
    private readonly onOpen?: () => void | Promise<void>,
    private readonly openError?: Error,
  ) {}

  getState(): 'closed' | 'open' | 'unavailable' {
    return this.state;
  }

  async open(): Promise<void> {
    this.opens++;
    if (this.openError) {
      this.state = 'unavailable';
      throw this.openError;
    }
    try {
      const opening = this.onOpen?.();
      if (opening) await opening;
      this.state = 'open';
    } catch (error) {
      this.state = 'unavailable';
      throw error;
    }
  }

  async readSessionCandidate(): Promise<WechatSessionMaterial | null> {
    return this.candidate;
  }

  async close(): Promise<void> {
    this.closes++;
    this.state = 'closed';
  }
}

function apiReturning(identity: WechatIdentity): WechatChannelsApiClient {
  return { getIdentity: async () => identity } as unknown as WechatChannelsApiClient;
}

function memoryStore(): EncryptedWechatSessionStore {
  let stored = {
    binding: { ...SCOPE, accountId: SCOPE.envKey, finderIdentity: IDENTITY.externalId },
    identity: IDENTITY,
    session: SESSION,
    legacyBindingMigrated: false,
  };
  return {
    load: async () => stored,
    save: async (next: typeof stored) => { stored = { ...next, legacyBindingMigrated: false }; },
    clear: async () => { stored = null as unknown as typeof stored; },
  } as unknown as EncryptedWechatSessionStore;
}

function emptyMemoryStore(): EncryptedWechatSessionStore {
  return {
    load: async () => null,
    save: async () => {},
    clear: async () => {},
  } as unknown as EncryptedWechatSessionStore;
}

class FakeTimers {
  private readonly tasks: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];

  readonly setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const task = { callback, delayMs, cancelled: false };
    this.tasks.push(task);
    return task as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    (timer as unknown as { cancelled: boolean }).cancelled = true;
  };

  pendingDelays(): number[] {
    return this.tasks.filter((task) => !task.cancelled).map((task) => task.delayMs);
  }

  async runNext(): Promise<void> {
    const task = this.tasks.find((candidate) => !candidate.cancelled);
    assert.ok(task, 'expected a scheduled recovery timer');
    task.cancelled = true;
    task.callback();
    await flushAsync();
  }
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('wechat session store: AES-GCM round-trip keeps cookies out of plaintext and binds account/scope', async () => {
  await withTempDir(async (root) => {
    const store = new EncryptedWechatSessionStore(SCOPE, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '11'.repeat(32) },
      nowImpl: () => 123,
      randomBytesImpl: (size) => Buffer.alloc(size, 7),
    });
    await store.save({
      binding: { ...SCOPE, accountId: SCOPE.envKey, finderIdentity: IDENTITY.externalId },
      identity: IDENTITY,
      session: SESSION,
    });

    const encrypted = await readFile(sessionPath(root, SCOPE), 'utf8');
    assert.equal(encrypted.includes('cookie-top-secret'), false);
    assert.equal(encrypted.includes('session_key'), false);
    assert.equal(encrypted.includes('Finder A'), false);
    const loaded = await store.load(SCOPE.envKey);
    assert.deepEqual(loaded?.session, SESSION);
    assert.equal(loaded?.savedAt, 123);
    await assert.rejects(
      () => store.load('finder-other'),
      (error: unknown) => error instanceof WechatChannelsError && error.category === 'identity_mismatch',
    );

    const otherScopeStore = new EncryptedWechatSessionStore({ envKey: 'env-b', browserProfileId: 'profile-a' }, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '11'.repeat(32) },
    });
    assert.equal(await otherScopeStore.load(), null);
  });
});

test('wechat auth capture: accepts observed empty finder uin and raw key strings', () => {
  const captured = captureRequestContext({
    request: {
      url: 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data?_aid=aid-test&_pageUrl=https%3A%2F%2Fchannels.weixin.qq.com%2Fplatform%2Fpost%2Flist&_rid=rid-test',
      postData: JSON.stringify({
        _log_finder_id: 'finder-test',
        _log_finder_uin: '',
        rawKeyBuff: '',
        timestamp: '123',
        scene: 7,
        reqScene: 7,
        pluginSessionId: null,
      }),
      headers: {
        'finger-print-device-id': 'device-test',
        'X-WECHAT-UIN': 'uin-test',
      },
    },
  });

  assert.deepEqual(captured?.commonBody, {
    logFinderId: 'finder-test',
    logFinderUin: '',
    rawKeyBuff: '',
    pluginSessionId: null,
    reqScene: 7,
    scene: 7,
  });
});

test('wechat session store: accepts captured empty finder uin and raw key strings', async () => {
  await withTempDir(async (root) => {
    const store = new EncryptedWechatSessionStore(SCOPE, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '12'.repeat(32) },
    });
    const observedSession: WechatSessionMaterial = {
      ...SESSION,
      requestContext: {
        ...SESSION.requestContext,
        commonBody: {
          ...SESSION.requestContext.commonBody,
          logFinderUin: '',
          rawKeyBuff: '',
        },
      },
    };
    await store.save({
      binding: { ...SCOPE, accountId: SCOPE.envKey, finderIdentity: IDENTITY.externalId },
      identity: IDENTITY,
      session: observedSession,
    });

    assert.deepEqual((await store.load(SCOPE.envKey))?.session, observedSession);
  });
});

test('wechat auth: browser login closes only after identity, encrypted save, and enabled read probe succeed', async () => {
  await withTempDir(async (root) => {
    const logs: string[] = [];
    const sidecar = new FakeSidecar(SESSION, () => {
      assert.ok(logs.some((line) => line.includes('browser=required trigger=startup_stored_session_missing')),
        'browser reason must be logged before the provider is opened');
    });
    const transitions: string[] = [];
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: SCOPE.envKey,
      api: apiReturning(IDENTITY),
      sidecar,
      store: new EncryptedWechatSessionStore(SCOPE, {
        rootDir: root,
        env: { AIDCP_WECHAT_MASTER_KEY: '22'.repeat(32) },
      }),
      probeEnabledReads: async () => ({ ok: true }),
      nowImpl: (() => {
        let now = 1;
        return () => now++;
      })(),
      sleepImpl: async () => {},
      logImpl: (message) => logs.push(message),
    });
    auth.onChange((snapshot) => transitions.push(snapshot.state));

    await auth.initialize();

    assert.equal(auth.getSnapshot().state, 'api_only_running');
    assert.equal(auth.getSnapshot().browserState, 'closed');
    assert.equal(auth.getSnapshot().identityMatches, true);
    assert.equal(sidecar.opens, 1);
    assert.equal(sidecar.closes, 1);
    assert.ok(logs.some((line) => line.includes('stored_session=missing')));
    assert.doesNotMatch(logs.join('\n'), /cookie-top-secret|raw-key-test|finder-a/);
    assert.deepEqual(
      transitions,
      ['browser_login_required', 'browser_opening', 'qr_waiting', 'identity_verifying', 'session_active', 'browser_closing', 'api_only_running'],
    );
  });
});

test('wechat auth: timed-out QR login closes the browser before returning login_required', async () => {
  let now = 0;
  const sidecar = new FakeSidecar(null);
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: apiReturning(IDENTITY),
    sidecar,
    store: emptyMemoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    loginTimeoutMs: 2,
    pollIntervalMs: 1,
    nowImpl: () => now++,
    sleepImpl: async () => {},
    logImpl: () => {},
  });

  await assert.rejects(
    () => auth.initialize(),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'auth_expired',
  );

  assert.equal(auth.getSnapshot().status, 'login_required');
  assert.equal(auth.getSnapshot().browserState, 'closed');
  assert.equal(sidecar.opens, 1);
  assert.equal(sidecar.closes, 1, '鉴权失败也必须确认关闭，避免占住临时通道');
});

test('wechat auth: stored encrypted session resumes API-only without opening browser', async () => {
  await withTempDir(async (root) => {
    const logs: string[] = [];
    const store = new EncryptedWechatSessionStore(SCOPE, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '33'.repeat(32) },
    });
    await store.save({
      binding: { ...SCOPE, accountId: SCOPE.envKey, finderIdentity: IDENTITY.externalId },
      identity: IDENTITY,
      session: SESSION,
    });
    const sidecar = new FakeSidecar(null);
    let probes = 0;
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: SCOPE.envKey,
      api: apiReturning(IDENTITY),
      sidecar,
      store,
      probeEnabledReads: async () => {
        probes++;
        return { ok: true };
      },
      logImpl: (message) => logs.push(message),
    });

    await auth.initialize();

    assert.equal(auth.getSnapshot().state, 'api_only_running');
    assert.equal(sidecar.opens, 0);
    assert.equal(sidecar.closes, 0);
    assert.equal(probes, 1);
    assert.ok(logs.some((line) => line.includes('stored_session=found')));
    assert.ok(logs.some((line) => line.includes('stored_session=valid browser=skipped mode=api_only')));
    assert.equal(logs.some((line) => line.includes('browser=required')), false);
    assert.doesNotMatch(logs.join('\n'), /cookie-top-secret|raw-key-test|finder-a/);
  });
});

test('wechat auth: expired stored session logs its reason before browser reauthentication', async () => {
  const logs: string[] = [];
  let identityCalls = 0;
  const sidecar = new FakeSidecar(SESSION, () => {
    assert.ok(logs.some((line) => line.includes('browser=required trigger=startup_stored_session_expired')),
      'expired-session reason must be logged before the provider is opened');
  });
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: {
      getIdentity: async () => {
        identityCalls++;
        if (identityCalls === 1) {
          throw new WechatChannelsError('auth_expired', 'authData', 'synthetic expired session', false);
        }
        return IDENTITY;
      },
    } as unknown as WechatChannelsApiClient,
    sidecar,
    store: memoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    sleepImpl: async () => {},
    logImpl: (message) => logs.push(message),
  });

  await auth.initialize();

  assert.equal(sidecar.opens, 1);
  assert.equal(sidecar.closes, 1);
  assert.equal(auth.getSnapshot().state, 'api_only_running');
  assert.doesNotMatch(logs.join('\n'), /cookie-top-secret|raw-key-test|finder-a|synthetic expired session/);
});

test('wechat auth: expired session browser launch failure returns to reauth_required with a safe code', async () => {
  const logs: string[] = [];
  const sidecar = new FakeSidecar(
    null,
    undefined,
    new Error('AdsPower rejected Authorization=Bearer top-secret cookie=cookie-top-secret'),
  );
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: {
      getIdentity: async () => {
        throw new WechatChannelsError('auth_expired', 'authData', 'stored session expired', false);
      },
    } as unknown as WechatChannelsApiClient,
    sidecar,
    store: memoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    logImpl: (message) => logs.push(message),
  });

  await assert.rejects(auth.initialize(), (error: unknown) => {
    assert.ok(error instanceof WechatChannelsError);
    assert.equal(error.code, 'WECHAT_AUTH_REQUIRED');
    assert.equal(error.endpoint, 'browser_login');
    return true;
  });
  assert.equal(auth.getSnapshot().state, 'reauth_required');
  assert.equal(auth.getSnapshot().status, 'reauth_required');
  assert.equal(auth.getSnapshot().reasonCode, 'WECHAT_AUTH_REQUIRED');
  assert.equal(auth.getSnapshot().browserState, 'unavailable');
  assert.ok(logs.some((line) => line.includes('state=reauth_required action=customer_retry')));
  assert.doesNotMatch(logs.join('\n'), /top-secret|cookie-top-secret|Authorization|stored session expired/);
});

test('wechat auth: first-login browser launch failure returns to login_required and remains retryable', async () => {
  const sidecar = new FakeSidecar(null, undefined, new Error('local browser unavailable'));
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: apiReturning(IDENTITY),
    sidecar,
    store: emptyMemoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    logImpl: () => {},
  });

  await assert.rejects(auth.initialize(), (error: unknown) => {
    assert.ok(error instanceof WechatChannelsError);
    assert.equal(error.code, 'WECHAT_AUTH_REQUIRED');
    return true;
  });
  assert.equal(auth.getSnapshot().state, 'browser_login_required');
  assert.equal(auth.getSnapshot().status, 'login_required');
  assert.equal(auth.getSnapshot().reasonCode, 'WECHAT_AUTH_REQUIRED');
  assert.equal(auth.getSnapshot().browserState, 'unavailable');
});

test('wechat browser diagnostic exposes only whitelist fields', () => {
  const diagnostic = safeBrowserSidecarDiagnostic(new Error(
    '[aidcp-edge] AdsPower browser-profile/start 失败：code=-321 msg=Authorization Bearer api-key-secret '
      + 'cookie=cookie-top-secret https://local.adspower.net/start?token=query-secret',
  ));
  assert.equal(
    diagnostic,
    'provider=adspower operation=browser-profile/start kind=provider_rejected provider_code=-321',
  );
  assert.doesNotMatch(diagnostic, /Authorization|Bearer|api-key-secret|cookie|top-secret|https|query-secret/);

  assert.equal(
    safeBrowserSidecarDiagnostic(new Error('[aidcp-edge] AdsPower browser-profile/start 响应异常：HTTP 503')),
    'provider=adspower operation=browser-profile/start kind=http_error http_status=503',
  );
  assert.equal(
    safeBrowserSidecarDiagnostic(new Error('opaque secret payload')),
    'provider=browser operation=sidecar.open kind=unexpected',
  );
});

test('wechat auth: occupied reauthorization exits authenticating and explicit retry can recover', async () => {
  const logs: string[] = [];
  let identityCalls = 0;
  let occupied = true;
  const sidecar = new FakeSidecar(SESSION, () => {
    if (occupied) {
      occupied = false;
      throw new BrowserProfileInUseError(SCOPE.browserProfileId, 't***@gmail.com');
    }
  });
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: {
      getIdentity: async () => {
        identityCalls++;
        if (identityCalls === 1) {
          throw new WechatChannelsError('auth_expired', 'authData', 'synthetic expired session', false);
        }
        return IDENTITY;
      },
    } as unknown as WechatChannelsApiClient,
    sidecar,
    store: memoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    sleepImpl: async () => {},
    logImpl: (message) => logs.push(message),
  });

  await auth.initialize();

  assert.equal(auth.getSnapshot().state, 'reauth_required');
  assert.equal(auth.getSnapshot().status, 'reauth_required');
  assert.equal(auth.getSnapshot().browserState, 'unavailable');
  assert.equal(auth.getSnapshot().reasonCode, 'INTERACTION_BROWSER_PROFILE_IN_USE');
  assert.equal(auth.getSnapshot().identityMatches, false);
  assert.equal(sidecar.opens, 1);
  assert.equal(sidecar.closes, 0);
  assert.match(logs.join('\n'), /reason=INTERACTION_BROWSER_PROFILE_IN_USE/);
  assert.match(logs.join('\n'), /owner_hint=t\*\*\*@gmail\.com/);
  assert.doesNotMatch(logs.join('\n'), /tommax\.bai@gmail\.com/);

  await auth.reopen('user_requested');

  assert.equal(auth.getSnapshot().state, 'api_only_running');
  assert.equal(auth.getSnapshot().status, 'active');
  assert.equal(auth.getSnapshot().browserState, 'closed');
  assert.equal(auth.getSnapshot().reasonCode, null);
  assert.equal(auth.getSnapshot().identityMatches, true);
  assert.equal(sidecar.opens, 2);
  assert.equal(sidecar.closes, 1);
});

test('wechat auth: active API-only session can open a visible browser and return to background idempotently', async () => {
  await withTempDir(async (root) => {
    const store = new EncryptedWechatSessionStore(SCOPE, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '35'.repeat(32) },
    });
    await store.save({
      binding: { ...SCOPE, accountId: SCOPE.envKey, finderIdentity: IDENTITY.externalId },
      identity: IDENTITY,
      session: SESSION,
    });
    const sidecar = new FakeSidecar(null);
    const transitions: string[] = [];
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: SCOPE.envKey,
      api: apiReturning(IDENTITY),
      sidecar,
      store,
      probeEnabledReads: async () => ({ ok: true }),
      logImpl: () => {},
    });
    auth.onChange((snapshot) => transitions.push(`${snapshot.state}:${snapshot.browserState}`));
    await auth.initialize();

    await auth.controlBrowser('open');
    await auth.controlBrowser('open');
    assert.equal(auth.getSnapshot().status, 'active');
    assert.equal(auth.getSnapshot().browserState, 'open');
    assert.equal(sidecar.opens, 1);

    await auth.controlBrowser('close');
    await auth.controlBrowser('close');
    assert.equal(auth.getSnapshot().state, 'api_only_running');
    assert.equal(auth.getSnapshot().browserState, 'closed');
    assert.equal(sidecar.closes, 1);
    assert.ok(transitions.includes('browser_foreground_opening:open'));
    assert.ok(transitions.includes('browser_open:open'));
    assert.ok(transitions.includes('browser_foreground_closing:closed'));
  });
});

test('wechat auth: browser foreground control fails closed before identity-bound auth is active', async () => {
  const sidecar = new FakeSidecar(SESSION);
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: apiReturning(IDENTITY),
    sidecar,
    probeEnabledReads: async () => ({ ok: true }),
    logImpl: () => {},
  });

  await assert.rejects(
    () => auth.controlBrowser('open'),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'invalid_command',
  );
  assert.equal(sidecar.opens, 0);
});

test('wechat auth: legacy finder-as-account binding migrates to logical env scope after verification', async () => {
  await withTempDir(async (root) => {
    const store = new EncryptedWechatSessionStore(SCOPE, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '34'.repeat(32) },
    });
    await store.save({
      binding: { ...SCOPE, accountId: IDENTITY.externalId, finderIdentity: IDENTITY.externalId },
      identity: IDENTITY,
      session: SESSION,
    });
    const sidecar = new FakeSidecar(null);
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: SCOPE.envKey,
      api: apiReturning(IDENTITY),
      sidecar,
      store,
      probeEnabledReads: async () => ({ ok: true }),
      logImpl: () => {},
    });
    await auth.initialize();
    assert.equal(auth.getSnapshot().status, 'active');
    assert.equal(sidecar.opens, 0);
    const migrated = await store.load(SCOPE.envKey);
    assert.equal(migrated?.binding.accountId, SCOPE.envKey);
    assert.equal(migrated?.binding.finderIdentity, IDENTITY.externalId);
    assert.equal(migrated?.legacyBindingMigrated, false);
  });
});

test('wechat auth: a finder identity change fails closed and never replaces the durable binding', async () => {
  await withTempDir(async (root) => {
    const sidecar = new FakeSidecar(SESSION);
    const store = new EncryptedWechatSessionStore(SCOPE, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '44'.repeat(32) },
    });
    await store.save({
      binding: { ...SCOPE, accountId: SCOPE.envKey, finderIdentity: IDENTITY.externalId },
      identity: IDENTITY,
      session: SESSION,
    });
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: SCOPE.envKey,
      api: apiReturning({ externalId: 'finder-wrong', displayName: 'Wrong Finder' }),
      sidecar,
      store,
      probeEnabledReads: async () => ({ ok: true }),
      sleepImpl: async () => {},
      logImpl: () => {},
    });

    await auth.initialize();
    assert.equal(auth.getSnapshot().status, 'reauth_required');
    assert.equal(auth.getSnapshot().reasonCode, 'WECHAT_IDENTITY_MISMATCH');
    assert.equal(auth.getSnapshot().identityMatches, false);
    assert.equal(sidecar.opens, 0, 'identity mismatch must wait for an explicit customer re-login');
    assert.equal(sidecar.closes, 0);
    assert.equal((await store.load(SCOPE.envKey))?.binding.finderIdentity, IDENTITY.externalId);
  });
});

test('wechat auth: a failed read probe closes the transient browser and exposes schema degradation', async () => {
  await withTempDir(async (root) => {
    const sidecar = new FakeSidecar(SESSION);
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: SCOPE.envKey,
      api: apiReturning(IDENTITY),
      sidecar,
      store: new EncryptedWechatSessionStore(SCOPE, {
        rootDir: root,
        env: { AIDCP_WECHAT_MASTER_KEY: '55'.repeat(32) },
      }),
      probeEnabledReads: async () => ({ ok: false, reasonCode: 'WECHAT_SCHEMA_CHANGED' }),
      sleepImpl: async () => {},
      logImpl: () => {},
    });
    await assert.rejects(
      () => auth.initialize(),
      (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed',
    );
    assert.equal(auth.getSnapshot().status, 'degraded');
    assert.equal(auth.getSnapshot().reasonCode, 'WECHAT_SCHEMA_CHANGED');
    assert.equal(sidecar.state, 'closed');
    assert.equal(sidecar.closes, 1, 'schema degradation must not hold the machine-wide transient lane');
  });
});

test('wechat auth: disabled feature stays fail-closed without opening a browser', async () => {
  const sidecar = new FakeSidecar(SESSION);
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: apiReturning(IDENTITY),
    sidecar,
    probeEnabledReads: async () => ({ ok: true }),
    logImpl: () => {},
  });
  auth.disable();
  assert.equal(auth.getSnapshot().status, 'disabled');
  assert.equal(auth.getSnapshot().reasonCode, 'INTERACTION_FEATURE_DISABLED');
  assert.equal(auth.getSnapshot().identityMatches, false);
  assert.equal(sidecar.opens, 0);
});

test('wechat auth: stored-session network degradation logs API recovery and keeps the browser closed', async () => {
  const logs: string[] = [];
  const timers = new FakeTimers();
  const sidecar = new FakeSidecar(null);
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: {
      getIdentity: async () => {
        throw new WechatChannelsError('transient_network', 'authData', 'upstream temporarily unavailable', true);
      },
    } as unknown as WechatChannelsApiClient,
    sidecar,
    store: memoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    logImpl: (message) => logs.push(message),
  });

  await auth.initialize();

  assert.equal(auth.getSnapshot().status, 'degraded');
  assert.equal(auth.getSnapshot().reasonCode, 'INTERACTION_UPSTREAM_UNAVAILABLE');
  assert.equal(sidecar.opens, 0);
  assert.deepEqual(timers.pendingDelays(), [5_000]);
  assert.ok(logs.some((line) => line.includes(
    'browser=skipped reason=INTERACTION_UPSTREAM_UNAVAILABLE recovery=api_retry',
  )));
  assert.doesNotMatch(logs.join('\n'), /upstream temporarily unavailable|cookie-top-secret/);
});

test('wechat auth: rate limiting follows retry-after and recovers without opening the browser', async () => {
  const timers = new FakeTimers();
  const sidecar = new FakeSidecar(null);
  let identityCalls = 0;
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: {
      getIdentity: async () => { identityCalls++; return IDENTITY; },
    } as unknown as WechatChannelsApiClient,
    sidecar,
    store: memoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    logImpl: () => {},
  });
  await auth.initialize();

  auth.markApiFailure(new WechatChannelsError('rate_limited', 'postList', 'limited', true, 37));
  assert.equal(auth.getSnapshot().status, 'degraded');
  assert.equal(auth.getSnapshot().reasonCode, 'WECHAT_RATE_LIMITED');
  assert.deepEqual(timers.pendingDelays(), [37]);

  await timers.runNext();
  assert.equal(auth.getSnapshot().state, 'api_only_running');
  assert.equal(auth.getSnapshot().identityMatches, true);
  assert.equal(identityCalls, 2);
  assert.equal(sidecar.opens, 0);
  assert.deepEqual(timers.pendingDelays(), []);
});

test('wechat auth: an expired runtime API session is recaptured through the existing browser sidecar', async () => {
  const logs: string[] = [];
  const sidecar = new FakeSidecar(SESSION);
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: apiReturning(IDENTITY),
    sidecar,
    store: memoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    logImpl: (message) => logs.push(message),
  });
  await auth.initialize();
  assert.equal(auth.getSnapshot().status, 'active');
  assert.equal(sidecar.opens, 0);

  auth.markApiFailure(new WechatChannelsError(
    'auth_expired',
    'postList',
    'request failed with cookie-top-secret',
    false,
    null,
    true,
    200,
    300334,
  ));
  await flushAsync();

  assert.equal(sidecar.opens, 1);
  assert.equal(sidecar.closes, 1);
  assert.equal(auth.getSnapshot().state, 'api_only_running');
  assert.equal(auth.getSnapshot().status, 'active');
  assert.equal(auth.getSnapshot().reasonCode, null);
  assert.ok(logs.some((line) => line.includes('trigger=runtime_auth_expired')));
  assert.doesNotMatch(logs.join('\n'), /request failed|cookie-top-secret/);
});

test('wechat auth: an unrelated platform rejection does not open the browser', async () => {
  const sidecar = new FakeSidecar(null);
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: apiReturning(IDENTITY),
    sidecar,
    store: memoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    logImpl: () => {},
  });
  await auth.initialize();

  auth.markApiFailure(new WechatChannelsError(
    'platform_rejected',
    'postList',
    'unrelated rejection',
    false,
    null,
    true,
    200,
    300335,
  ));
  await flushAsync();

  assert.equal(sidecar.opens, 0);
  assert.equal(auth.getSnapshot().state, 'api_only_running');
  assert.equal(auth.getSnapshot().status, 'active');
});

test('wechat auth: transient recovery backs off to its cap, keeps retrying, and disable cancels it', async () => {
  const timers = new FakeTimers();
  const sidecar = new FakeSidecar(null);
  let identityCalls = 0;
  const api = {
    getIdentity: async () => {
      identityCalls++;
      if (identityCalls >= 2 && identityCalls <= 4) {
        throw new WechatChannelsError('transient_network', 'authData', 'temporary outage', true);
      }
      return IDENTITY;
    },
  } as unknown as WechatChannelsApiClient;
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api,
    sidecar,
    store: memoryStore(),
    probeEnabledReads: async () => ({ ok: true }),
    recoveryBackoff: { transient_network: { initialMs: 5, maxMs: 20 } },
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    logImpl: () => {},
  });
  await auth.initialize();

  auth.markApiFailure(new WechatChannelsError('transient_network', 'postList', 'temporary outage', true));
  assert.deepEqual(timers.pendingDelays(), [5]);
  await timers.runNext();
  assert.deepEqual(timers.pendingDelays(), [10]);
  await timers.runNext();
  assert.deepEqual(timers.pendingDelays(), [20]);
  await timers.runNext();
  assert.deepEqual(timers.pendingDelays(), [20], 'recovery must keep retrying at the cap');
  await timers.runNext();
  assert.equal(auth.getSnapshot().state, 'api_only_running');
  assert.deepEqual(timers.pendingDelays(), []);

  auth.markApiFailure(new WechatChannelsError('transient_network', 'postList', 'temporary outage', true));
  assert.deepEqual(timers.pendingDelays(), [5], 'successful recovery resets backoff');
  const callsBeforeDisable = identityCalls;
  auth.disable();
  assert.deepEqual(timers.pendingDelays(), []);
  await flushAsync();
  assert.equal(identityCalls, callsBeforeDisable);
  assert.equal(sidecar.opens, 0);
});

test('wechat auth: probe failure keeps its rate-limit reason instead of reporting schema drift', async () => {
  const timers = new FakeTimers();
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api: apiReturning(IDENTITY),
    sidecar: new FakeSidecar(null),
    store: memoryStore(),
    probeEnabledReads: async () => ({ ok: false, reasonCode: 'WECHAT_RATE_LIMITED' }),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    logImpl: () => {},
  });

  await auth.initialize();
  assert.equal(auth.getSnapshot().status, 'degraded');
  assert.equal(auth.getSnapshot().reasonCode, 'WECHAT_RATE_LIMITED');
  assert.deepEqual(timers.pendingDelays(), [30_000]);
});

test('wechat auth: an account with no posts stays active while comments remain fail-closed', async () => {
  const flags = { ...DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS, commentsReadEnabled: true };
  const capabilityState = new WechatCapabilityState(flags, new WechatEndpointCircuitBreaker());
  capabilityState.applyRemoteControls({
    accountId: SCOPE.envKey,
    envKey: SCOPE.envKey,
    version: 1,
    commentsReadEnabled: true,
    commentsReplyEnabled: false,
    dmReadEnabled: false,
    dmSendTextEnabled: false,
    dmSendImageEnabled: false,
  }, { accountId: SCOPE.envKey, envKey: SCOPE.envKey });
  const api = {
    getIdentity: async () => IDENTITY,
    listPosts: async () => ({ items: [], nextCursor: null, hasMore: false }),
  } as unknown as WechatChannelsApiClient;
  const runner = new WechatChannelsProbeRunner({ api, flags, capabilityState });
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: SCOPE.envKey,
    api,
    sidecar: new FakeSidecar(null),
    store: memoryStore(),
    probeEnabledReads: (session) => runner.probeEnabledReads(session),
    logImpl: () => {},
  });

  await auth.initialize();
  assert.equal(auth.getSnapshot().state, 'api_only_running');
  assert.equal(auth.getSnapshot().reasonCode, null);
  assert.equal(capabilityState.effective({ authActive: true, identityMatches: true }).commentsRead, false);
  assert.deepEqual(runner.snapshot().map((result) => [result.status, result.reasonCode]), [
    ['gated', 'NO_READ_PROBE_SCOPE'],
    ['disabled', null],
  ]);
});
