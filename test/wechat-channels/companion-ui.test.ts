import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthSnapshot } from '../../src/wechat-channels/auth-session.js';
import {
  wechatIdentityUiEvent,
  wireWechatIdentityUiEvents,
} from '../../src/wechat-channels/companion-ui.js';

function snapshot(overrides: Partial<AuthSnapshot> = {}): AuthSnapshot {
  return {
    state: 'api_only_running',
    status: 'active',
    browserState: 'closed',
    reasonCode: null,
    accountId: 'env-a',
    identity: { externalId: 'finder-tom', displayName: 'tom白' },
    identityMatches: true,
    checkedAt: 1,
    ...overrides,
  };
}

test('wechat companion identity: verified cold-start identity emits the existing Electron identity event', () => {
  assert.deepEqual(wechatIdentityUiEvent(snapshot()), {
    kind: 'identity',
    type: 'identity',
    account: { id: 'finder-tom', name: 'tom白' },
  });
});

test('wechat companion identity: unverified, missing, or blank identity cannot drive environment rename', () => {
  assert.equal(wechatIdentityUiEvent(snapshot({ identityMatches: false })), null);
  assert.equal(wechatIdentityUiEvent(snapshot({ identity: null })), null);
  assert.equal(wechatIdentityUiEvent(snapshot({ identity: { externalId: 'finder-tom', displayName: '   ' } })), null);
  assert.equal(wechatIdentityUiEvent(snapshot({ identity: { externalId: '   ', displayName: 'tom白' } })), null);
});

test('wechat companion identity: auth state listener writes a structured stdout event only after verification', () => {
  let listener: ((value: AuthSnapshot) => void) | undefined;
  const logs: string[] = [];
  const unsubscribe = wireWechatIdentityUiEvents(
    {
      onChange(next) {
        listener = next;
        return () => { listener = undefined; };
      },
    },
    (message) => logs.push(message),
  );

  listener?.(snapshot({ state: 'identity_verifying', status: 'authenticating', identityMatches: false }));
  listener?.(snapshot());
  assert.deepEqual(logs, [
    '[ui-event] {"kind":"identity","type":"identity","account":{"id":"finder-tom","name":"tom白"}}',
  ]);
  unsubscribe();
  assert.equal(listener, undefined);
});
