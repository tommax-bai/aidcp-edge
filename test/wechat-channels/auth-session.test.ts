import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WechatChannelsApiClient } from '../../src/wechat-channels/api-client.js';
import { WechatAuthCoordinator } from '../../src/wechat-channels/auth-session.js';
import type { WechatChannelsBrowserSidecar } from '../../src/wechat-channels/browser-sidecar.js';
import { EncryptedWechatSessionStore } from '../../src/wechat-channels/encrypted-session-store.js';
import { WechatChannelsError } from '../../src/wechat-channels/error-classifier.js';
import { sessionPath } from '../../src/wechat-channels/local-paths.js';
import type { WechatIdentity, WechatSessionMaterial } from '../../src/wechat-channels/types.js';

const SCOPE = { envKey: 'env-a', browserProfileId: 'profile-a' };
const IDENTITY: WechatIdentity = { externalId: 'finder-a', displayName: 'Finder A' };
const SESSION: WechatSessionMaterial = {
  cookies: [{ name: 'session_key', value: 'cookie-top-secret', domain: '.channels.weixin.qq.com', path: '/' }],
  userAgent: 'Wechat-Test-UA',
  acquiredAt: 100,
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
  state: 'closed' | 'open' = 'closed';
  opens = 0;
  closes = 0;

  constructor(private readonly candidate: WechatSessionMaterial | null) {}

  getState(): 'closed' | 'open' {
    return this.state;
  }

  async open(): Promise<void> {
    this.opens++;
    this.state = 'open';
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

test('wechat session store: AES-GCM round-trip keeps cookies out of plaintext and binds account/scope', async () => {
  await withTempDir(async (root) => {
    const store = new EncryptedWechatSessionStore(SCOPE, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '11'.repeat(32) },
      nowImpl: () => 123,
      randomBytesImpl: (size) => Buffer.alloc(size, 7),
    });
    await store.save({
      binding: { ...SCOPE, accountId: IDENTITY.externalId, finderIdentity: IDENTITY.externalId },
      identity: IDENTITY,
      session: SESSION,
    });

    const encrypted = await readFile(sessionPath(root, SCOPE), 'utf8');
    assert.equal(encrypted.includes('cookie-top-secret'), false);
    assert.equal(encrypted.includes('session_key'), false);
    assert.equal(encrypted.includes('Finder A'), false);
    const loaded = await store.load(IDENTITY.externalId);
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

test('wechat auth: browser login closes only after identity, encrypted save, and enabled read probe succeed', async () => {
  await withTempDir(async (root) => {
    const sidecar = new FakeSidecar(SESSION);
    const transitions: string[] = [];
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: IDENTITY.externalId,
      api: apiReturning(IDENTITY),
      sidecar,
      store: new EncryptedWechatSessionStore(SCOPE, {
        rootDir: root,
        env: { AIDCP_WECHAT_MASTER_KEY: '22'.repeat(32) },
      }),
      probeEnabledReads: async () => true,
      nowImpl: (() => {
        let now = 1;
        return () => now++;
      })(),
      sleepImpl: async () => {},
      logImpl: () => {},
    });
    auth.onChange((snapshot) => transitions.push(snapshot.state));

    await auth.initialize();

    assert.equal(auth.getSnapshot().state, 'api_only_running');
    assert.equal(auth.getSnapshot().browserState, 'closed');
    assert.equal(auth.getSnapshot().identityMatches, true);
    assert.equal(sidecar.opens, 1);
    assert.equal(sidecar.closes, 1);
    assert.deepEqual(
      transitions,
      ['browser_login_required', 'browser_opening', 'qr_waiting', 'identity_verifying', 'session_active', 'browser_closing', 'api_only_running'],
    );
  });
});

test('wechat auth: stored encrypted session resumes API-only without opening browser', async () => {
  await withTempDir(async (root) => {
    const store = new EncryptedWechatSessionStore(SCOPE, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '33'.repeat(32) },
    });
    await store.save({
      binding: { ...SCOPE, accountId: IDENTITY.externalId, finderIdentity: IDENTITY.externalId },
      identity: IDENTITY,
      session: SESSION,
    });
    const sidecar = new FakeSidecar(null);
    let probes = 0;
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: IDENTITY.externalId,
      api: apiReturning(IDENTITY),
      sidecar,
      store,
      probeEnabledReads: async () => {
        probes++;
        return true;
      },
      logImpl: () => {},
    });

    await auth.initialize();

    assert.equal(auth.getSnapshot().state, 'api_only_running');
    assert.equal(sidecar.opens, 0);
    assert.equal(sidecar.closes, 0);
    assert.equal(probes, 1);
  });
});

test('wechat auth: wrong account fails closed and never closes or persists the candidate session', async () => {
  await withTempDir(async (root) => {
    const sidecar = new FakeSidecar(SESSION);
    const store = new EncryptedWechatSessionStore(SCOPE, {
      rootDir: root,
      env: { AIDCP_WECHAT_MASTER_KEY: '44'.repeat(32) },
    });
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: 'finder-expected',
      api: apiReturning({ externalId: 'finder-wrong', displayName: 'Wrong Finder' }),
      sidecar,
      store,
      probeEnabledReads: async () => true,
      sleepImpl: async () => {},
      logImpl: () => {},
    });

    await assert.rejects(
      () => auth.initialize(),
      (error: unknown) => error instanceof WechatChannelsError && error.code === 'WECHAT_IDENTITY_MISMATCH',
    );
    assert.equal(auth.getSnapshot().status, 'reauth_required');
    assert.equal(auth.getSnapshot().reasonCode, 'WECHAT_IDENTITY_MISMATCH');
    assert.equal(auth.getSnapshot().identityMatches, false);
    assert.equal(sidecar.closes, 0);
    assert.equal(await store.load(), null);
  });
});

test('wechat auth: a failed read probe keeps the browser open and exposes schema degradation', async () => {
  await withTempDir(async (root) => {
    const sidecar = new FakeSidecar(SESSION);
    const auth = new WechatAuthCoordinator({
      envKey: SCOPE.envKey,
      expectedAccountId: IDENTITY.externalId,
      api: apiReturning(IDENTITY),
      sidecar,
      store: new EncryptedWechatSessionStore(SCOPE, {
        rootDir: root,
        env: { AIDCP_WECHAT_MASTER_KEY: '55'.repeat(32) },
      }),
      probeEnabledReads: async () => false,
      sleepImpl: async () => {},
      logImpl: () => {},
    });
    await assert.rejects(
      () => auth.initialize(),
      (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed',
    );
    assert.equal(auth.getSnapshot().status, 'degraded');
    assert.equal(auth.getSnapshot().reasonCode, 'WECHAT_SCHEMA_CHANGED');
    assert.equal(sidecar.state, 'open');
    assert.equal(sidecar.closes, 0);
  });
});

test('wechat auth: disabled feature stays fail-closed without opening a browser', async () => {
  const sidecar = new FakeSidecar(SESSION);
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: IDENTITY.externalId,
    api: apiReturning(IDENTITY),
    sidecar,
    probeEnabledReads: async () => true,
    logImpl: () => {},
  });
  auth.disable();
  assert.equal(auth.getSnapshot().status, 'disabled');
  assert.equal(auth.getSnapshot().reasonCode, 'INTERACTION_FEATURE_DISABLED');
  assert.equal(auth.getSnapshot().identityMatches, false);
  assert.equal(sidecar.opens, 0);
});

test('wechat auth: ordinary network degradation does not reopen the browser', () => {
  const sidecar = new FakeSidecar(SESSION);
  const auth = new WechatAuthCoordinator({
    envKey: SCOPE.envKey,
    expectedAccountId: IDENTITY.externalId,
    api: apiReturning(IDENTITY),
    sidecar,
    probeEnabledReads: async () => true,
    logImpl: () => {},
  });
  auth.markApiFailure(new WechatChannelsError(
    'transient_network',
    'postList',
    'upstream temporarily unavailable',
    true,
  ));
  assert.equal(auth.getSnapshot().status, 'degraded');
  assert.equal(auth.getSnapshot().reasonCode, 'INTERACTION_UPSTREAM_UNAVAILABLE');
  assert.equal(sidecar.opens, 0);
});
