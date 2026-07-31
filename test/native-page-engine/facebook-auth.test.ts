import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  FacebookTotpBroker,
  FacebookTotpCode,
} from '../../src/cdp/facebook-totp-broker.js';
import {
  reconcileFacebookStartupAuth,
  type FacebookAuthSignal,
  type FacebookAuthRuntime,
} from '../../src/native-page-engine/facebook-auth.js';
import {
  NativePageEngineError,
  type NativeEffectPhase,
  type NativeFacebookAuthActionKind,
  type NativePageCommand,
  type NativePageCommandExecution,
} from '../../src/native-page-engine/client.js';

interface RuntimeStep {
  kind: string;
  execution?: NativePageCommandExecution;
  error?: Error;
}

class ScriptedRuntime implements FacebookAuthRuntime {
  readonly calls: NativePageCommand[] = [];
  readonly closedOwners: string[] = [];

  constructor(private readonly steps: RuntimeStep[]) {}

  async execute(
    _ownerId: string,
    command: NativePageCommand,
    _timeoutMs?: number,
    _signal?: AbortSignal,
  ): Promise<NativePageCommandExecution> {
    this.calls.push(command);
    const step = this.steps.shift();
    assert.ok(step, `unexpected Native command ${command.kind}`);
    assert.equal(command.kind, step.kind);
    if (step.error) throw step.error;
    assert.ok(step.execution, `missing execution for Native command ${command.kind}`);
    return step.execution;
  }

  async closeOwner(ownerId: string): Promise<void> {
    this.closedOwners.push(ownerId);
  }

  assertDone(): void {
    assert.equal(this.steps.length, 0, 'script retained unused Native steps');
  }
}

function probe(
  signal: FacebookAuthSignal,
  options: { signalId?: string; serverEpochMs?: number; reason?: string } = {},
): NativePageCommandExecution {
  return {
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: {
      kind: 'facebook_auth_probe',
      value: { signal, ...options },
    },
  };
}

function action(
  kind: NativeFacebookAuthActionKind,
  signalId: string,
  effectPhase: NativeEffectPhase = 'confirmed',
  reason?: string,
): NativePageCommandExecution {
  const confirmed = effectPhase === 'confirmed';
  return {
    ok: confirmed,
    effectPhase,
    reasonCode: confirmed ? 'confirmed' : 'postcondition_unconfirmed',
    output: {
      kind: 'facebook_auth_action',
      value: { action: kind, signalId, ok: confirmed, ...(reason ? { reason } : {}) },
    },
  };
}

test('filled email login advances through one TOTP entry and submit chain', async () => {
  const broker = totpBroker([
    { code: '123456', windowStartMs: 90_000, windowEndMs: 120_000 },
  ]);
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('login_submit_ready', { signalId: 'login-1' }) },
    { kind: 'facebook_auth_submit_login', execution: action('facebook_auth_submit_login', 'login-1') },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-observed', serverEpochMs: 90_100 }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-fresh', serverEpochMs: 90_200 }),
    },
    { kind: 'facebook_auth_enter_totp', execution: action('facebook_auth_enter_totp', 'entry-fresh') },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_submit_ready', { signalId: 'submit-1', serverEpochMs: 90_300 }),
    },
    { kind: 'facebook_auth_submit_totp', execution: action('facebook_auth_submit_totp', 'submit-1') },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: broker,
    freshStartPolicyApplied: true,
    timeoutMs: 30_000,
    now: () => 0,
    sleep: async () => undefined,
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 3 });
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_submit_login',
    'facebook_auth_probe',
    'facebook_auth_probe',
    'facebook_auth_enter_totp',
    'facebook_auth_probe',
    'facebook_auth_submit_totp',
    'facebook_auth_probe',
  ]);
  assert.deepEqual(broker.requests, [90_100]);
  runtime.assertDone();
});

function totpBroker(
  codes: FacebookTotpCode[] = [],
): FacebookTotpBroker & { requests: number[] } {
  const requests: number[] = [];
  return {
    requests,
    async request(serverEpochMs) {
      requests.push(serverEpochMs);
      const code = codes.shift();
      assert.ok(code, 'unexpected TOTP request');
      return code;
    },
  };
}

test('a proven fresh start clears orphan TOTP text before entering a new code', async () => {
  const broker = totpBroker([
    { code: '654321', windowStartMs: 90_000, windowEndMs: 120_000 },
  ]);
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_refresh_required', { signalId: 'orphan-1', serverEpochMs: 90_100 }),
    },
    { kind: 'facebook_auth_clear_totp', execution: action('facebook_auth_clear_totp', 'orphan-1') },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-observed', serverEpochMs: 90_200 }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-fresh', serverEpochMs: 90_300 }),
    },
    { kind: 'facebook_auth_enter_totp', execution: action('facebook_auth_enter_totp', 'entry-fresh') },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_submit_ready', { signalId: 'submit-1', serverEpochMs: 90_400 }),
    },
    { kind: 'facebook_auth_submit_totp', execution: action('facebook_auth_submit_totp', 'submit-1') },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: broker,
    freshStartPolicyApplied: true,
    timeoutMs: 30_000,
    now: () => 0,
    sleep: async () => undefined,
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 3 });
  assert.deepEqual(runtime.calls[1], {
    kind: 'facebook_auth_clear_totp',
    params: {
      signalId: 'orphan-1',
      totpWindowStartUnixMs: 90_000,
      totpWindowEndUnixMs: 120_000,
    },
  });
  assert.deepEqual(broker.requests, [90_200]);
  runtime.assertDone();
});

test('an unproven active browser retains orphan TOTP text for manual handling', async () => {
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_refresh_required', { signalId: 'orphan-1', serverEpochMs: 90_100 }),
    },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: false,
    timeoutMs: 5_000,
  });

  assert.deepEqual(result, {
    kind: 'manual_required',
    reason: 'stale_totp_input_requires_fresh_start',
    actionAttempts: 0,
  });
  assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
  runtime.assertDone();
});

test('an unconfirmed TOTP action preserves its bounded Native receipt reason', async () => {
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-observed', serverEpochMs: 90_100 }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-fresh', serverEpochMs: 90_200 }),
    },
    {
      kind: 'facebook_auth_enter_totp',
      execution: action('facebook_auth_enter_totp', 'entry-fresh', 'ambiguous', 'totp_entry_target_lost'),
    },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker([
      { code: '123456', windowStartMs: 90_000, windowEndMs: 120_000 },
    ]),
    freshStartPolicyApplied: true,
    timeoutMs: 10_000,
    now: () => 0,
    sleep: async () => undefined,
  });

  assert.deepEqual(result, {
    kind: 'failed',
    reason: 'totp_entry_target_lost',
    effectPhase: 'ambiguous',
    actionAttempts: 1,
  });
  runtime.assertDone();
});

test('already-authenticated profile is a no-op even without fresh-start policy evidence', async () => {
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);
  const broker = totpBroker();

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: broker,
    freshStartPolicyApplied: false,
    timeoutMs: 5_000,
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 0 });
  assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
  assert.deepEqual(runtime.calls[0]?.params, { allowAuthActions: false });
  assert.deepEqual(broker.requests, []);
  runtime.assertDone();
});

test('transient read-only auth probe failure rebuilds its owner and succeeds in the same process', async () => {
  let nowMs = 0;
  const logs: string[] = [];
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      error: new NativePageEngineError('cdp_error', 'sensitive raw failure', {
        effectPhase: 'not_started',
        stderr: 'must not be logged',
      }),
    },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 5_000,
    pollIntervalMs: 500,
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; },
    logger: (message) => logs.push(message),
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 0 });
  assert.equal(nowMs, 250);
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_probe',
  ]);
  assert.deepEqual(runtime.closedOwners, ['facebook-startup-auth']);
  assert.ok(logs.includes(
    '[facebook-auth] native command failure kind=facebook_auth_probe code=cdp_error '
    + 'effectPhase=not_started disposition=retry attempt=1 retryInMs=250',
  ));
  assert.equal(logs.join('\n').includes('sensitive raw failure'), false);
  assert.equal(logs.join('\n').includes('must not be logged'), false);
  runtime.assertDone();
});

test('twenty-second transient probe exhaustion enters controlled manual login without input', async () => {
  let nowMs = 0;
  let calls = 0;
  const closedOwners: string[] = [];
  const runtime: FacebookAuthRuntime = {
    async execute(_ownerId, command) {
      calls += 1;
      assert.equal(command.kind, 'facebook_auth_probe');
      throw new NativePageEngineError('cdp_error', 'persistent startup churn', {
        effectPhase: 'not_started',
      });
    },
    async closeOwner(ownerId) {
      closedOwners.push(ownerId);
    },
  };

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 60_000,
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; },
  });

  assert.deepEqual(result, {
    kind: 'manual_required',
    reason: 'auth_probe_unavailable',
    actionAttempts: 0,
  });
  assert.equal(nowMs, 20_000);
  assert.ok(calls > 1);
  assert.equal(closedOwners.length, calls);
  assert.ok(closedOwners.every((ownerId) => ownerId === 'facebook-startup-auth'));
});

test('contract probe failure is terminal and does not reset the Native owner', async () => {
  const logs: string[] = [];
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      error: new NativePageEngineError('invalid_protocol', 'protocol mismatch'),
    },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 5_000,
    logger: (message) => logs.push(message),
  });

  assert.deepEqual(result, {
    kind: 'failed',
    reason: 'native_auth_command_failed',
    actionAttempts: 0,
  });
  assert.deepEqual(runtime.closedOwners, []);
  assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
  assert.ok(logs.includes(
    '[facebook-auth] native command failure kind=facebook_auth_probe code=invalid_protocol '
    + 'effectPhase=unknown disposition=terminal',
  ));
  runtime.assertDone();
});

test('Native action exception is terminal even when its error code is retryable for probes', async () => {
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('login_submit_ready', { signalId: 'login-1' }),
    },
    {
      kind: 'facebook_auth_submit_login',
      error: new NativePageEngineError('cdp_error', 'action receipt unavailable', {
        effectPhase: 'ambiguous',
      }),
    },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 5_000,
  });

  assert.deepEqual(result, {
    kind: 'failed',
    reason: 'native_auth_command_failed',
    effectPhase: 'ambiguous',
    actionAttempts: 1,
  });
  assert.deepEqual(runtime.closedOwners, []);
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_submit_login',
  ]);
  runtime.assertDone();
});

test('optional post-login signals may arrive reordered and each action is followed by a fresh probe', async () => {
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('remember_password_confirm', { signalId: 'remember-1' }) },
    {
      kind: 'facebook_auth_confirm_remember_password',
      execution: action('facebook_auth_confirm_remember_password', 'remember-1'),
    },
    { kind: 'facebook_auth_probe', execution: probe('automation_warning_dismiss', { signalId: 'warning-2' }) },
    {
      kind: 'facebook_auth_dismiss_warning',
      execution: action('facebook_auth_dismiss_warning', 'warning-2'),
    },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 10_000,
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 2 });
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_confirm_remember_password',
    'facebook_auth_probe',
    'facebook_auth_dismiss_warning',
    'facebook_auth_probe',
  ]);
  for (const call of runtime.calls.filter((call) => call.kind === 'facebook_auth_probe')) {
    assert.equal(call.params.allowAuthActions, true);
  }
  runtime.assertDone();
});

test('an unchanged signal id is never dispatched twice', async () => {
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('push_blocker_close', { signalId: 'push-1' }) },
    {
      kind: 'facebook_auth_close_push_blocker',
      execution: action('facebook_auth_close_push_blocker', 'push-1'),
    },
    { kind: 'facebook_auth_probe', execution: probe('push_blocker_close', { signalId: 'push-1' }) },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 10_000,
  });

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' ? result.reason : '', 'facebook_auth_signal_replayed');
  assert.equal(result.actionAttempts, 1);
  assert.equal(
    runtime.calls.filter((call) => String(call.kind) === 'facebook_auth_close_push_blocker').length,
    1,
  );
  runtime.assertDone();
});

test('an ambiguous Native action receipt is terminal and is not replayed', async () => {
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('login_submit_ready', { signalId: 'login-1' }) },
    {
      kind: 'facebook_auth_submit_login',
      execution: action('facebook_auth_submit_login', 'login-1', 'ambiguous'),
    },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 10_000,
  });

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' ? result.effectPhase : '', 'ambiguous');
  assert.equal(result.actionAttempts, 1);
  assert.equal(runtime.calls.length, 2);
  runtime.assertDone();
});

test('an active/orphan browser without fresh-start policy may pass authenticated but may not mutate login', async () => {
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('login_submit_ready', { signalId: 'login-1' }) },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: false,
    timeoutMs: 10_000,
  });

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' ? result.reason : '', 'fresh_start_policy_unavailable');
  assert.equal(result.actionAttempts, 0);
  assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
  assert.deepEqual(runtime.calls[0]?.params, { allowAuthActions: false });
  runtime.assertDone();
});

test('none signals consume the bounded wait budget and then time out', async () => {
  let nowMs = 0;
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('none') },
    { kind: 'facebook_auth_probe', execution: probe('none') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 1_000,
    pollIntervalMs: 500,
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; },
  });

  assert.deepEqual(result, { kind: 'timeout', actionAttempts: 0 });
  assert.equal(nowMs, 1_000);
  runtime.assertDone();
});

test('lifecycle interruption stops before the next Native command', async () => {
  const runtime = new ScriptedRuntime([]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 10_000,
    pollInterrupt: () => 'pause',
  });

  assert.deepEqual(result, { kind: 'interrupted', reason: 'pause', actionAttempts: 0 });
  assert.deepEqual(runtime.calls, []);
  runtime.assertDone();
});

test('missing AdsPower credential fill becomes a manual-login result without Native input', async () => {
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('manual_login_required', { reason: 'credential_fill_unavailable' }),
    },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 5_000,
  });

  assert.deepEqual(result, {
    kind: 'manual_required',
    reason: 'credential_fill_unavailable',
    actionAttempts: 0,
  });
  assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
  runtime.assertDone();
});

test('retained manual-login session re-enters the same coordinator when the page advances to 2FA', async () => {
  const broker = totpBroker([
    { code: '123456', windowStartMs: 90_000, windowEndMs: 120_000 },
  ]);
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('manual_login_required', { reason: 'credential_fill_unavailable' }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-observed', serverEpochMs: 90_100 }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-fresh', serverEpochMs: 90_200 }),
    },
    {
      kind: 'facebook_auth_enter_totp',
      execution: action('facebook_auth_enter_totp', 'entry-fresh'),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_submit_ready', { signalId: 'submit-fresh', serverEpochMs: 90_300 }),
    },
    {
      kind: 'facebook_auth_submit_totp',
      execution: action('facebook_auth_submit_totp', 'submit-fresh'),
    },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);
  const options = {
    runtime,
    totpBroker: broker,
    freshStartPolicyApplied: true,
    timeoutMs: 30_000,
    now: () => 0,
    sleep: async () => undefined,
  };

  const initial = await reconcileFacebookStartupAuth(options);
  assert.deepEqual(initial, {
    kind: 'manual_required',
    reason: 'credential_fill_unavailable',
    actionAttempts: 0,
  });

  const reentered = await reconcileFacebookStartupAuth(options);
  assert.deepEqual(reentered, { kind: 'authenticated', actionAttempts: 2 });
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_probe',
    'facebook_auth_probe',
    'facebook_auth_enter_totp',
    'facebook_auth_probe',
    'facebook_auth_submit_totp',
    'facebook_auth_probe',
  ]);
  assert.deepEqual(broker.requests, [90_100]);
  runtime.assertDone();
});

test('unchanged manual-login page remains a zero-action coordinator cadence', async () => {
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('manual_login_required', { reason: 'credential_fill_unavailable' }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('manual_login_required', { reason: 'credential_fill_unavailable' }),
    },
  ]);
  const options = {
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 5_000,
  };

  const first = await reconcileFacebookStartupAuth(options);
  const second = await reconcileFacebookStartupAuth(options);

  assert.equal(first.kind, 'manual_required');
  assert.equal(first.actionAttempts, 0);
  assert.equal(second.kind, 'manual_required');
  assert.equal(second.actionAttempts, 0);
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_probe',
  ]);
  runtime.assertDone();
});

test('TOTP entry waits below ten seconds, requests the new window, and re-probes before input', async () => {
  let nowMs = 0;
  const brokerCode = { code: '123456', windowStartMs: 90_000, windowEndMs: 120_000 };
  const broker = totpBroker([brokerCode]);
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-old', serverEpochMs: 80_500 }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-new', serverEpochMs: 90_100 }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-fresh', serverEpochMs: 90_200 }),
    },
    {
      kind: 'facebook_auth_enter_totp',
      execution: action('facebook_auth_enter_totp', 'entry-fresh'),
    },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: broker,
    freshStartPolicyApplied: true,
    timeoutMs: 30_000,
    pollIntervalMs: 500,
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; },
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 1 });
  assert.equal(nowMs, 9_501);
  assert.deepEqual(broker.requests, [90_100]);
  const entry = runtime.calls.find((call) => String(call.kind) === 'facebook_auth_enter_totp');
  assert.deepEqual(entry?.params, {
    signalId: 'entry-fresh',
    totpCode: '123456',
    totpWindowStartUnixMs: 90_000,
    totpWindowEndUnixMs: 120_000,
  });
  assert.equal(brokerCode.code, '', 'confirmed entry must scrub the broker-owned object in place');
  runtime.assertDone();
});

test('stale entered TOTP is cleared as its own action before a new entry and submit', async () => {
  const broker = totpBroker([
    { code: '111111', windowStartMs: 90_000, windowEndMs: 120_000 },
    { code: '222222', windowStartMs: 120_000, windowEndMs: 150_000 },
  ]);
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-1', serverEpochMs: 100_000 }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-1-fresh', serverEpochMs: 100_100 }),
    },
    {
      kind: 'facebook_auth_enter_totp',
      execution: action('facebook_auth_enter_totp', 'entry-1-fresh'),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_refresh_required', { signalId: 'clear-1', serverEpochMs: 120_100 }),
    },
    {
      kind: 'facebook_auth_clear_totp',
      execution: action('facebook_auth_clear_totp', 'clear-1'),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-2', serverEpochMs: 120_200 }),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-2-fresh', serverEpochMs: 120_300 }),
    },
    {
      kind: 'facebook_auth_enter_totp',
      execution: action('facebook_auth_enter_totp', 'entry-2-fresh'),
    },
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_submit_ready', { signalId: 'submit-2', serverEpochMs: 120_400 }),
    },
    {
      kind: 'facebook_auth_submit_totp',
      execution: action('facebook_auth_submit_totp', 'submit-2'),
    },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: broker,
    freshStartPolicyApplied: true,
    timeoutMs: 30_000,
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 4 });
  assert.deepEqual(
    runtime.calls
      .filter((call) => String(call.kind) !== 'facebook_auth_probe')
      .map((call) => call.kind),
    [
      'facebook_auth_enter_totp',
      'facebook_auth_clear_totp',
      'facebook_auth_enter_totp',
      'facebook_auth_submit_totp',
    ],
  );
  assert.deepEqual(broker.requests, [100_000, 120_200]);
  runtime.assertDone();
});

test('a broker response for another TOTP window fails before Native input', async () => {
  const brokerCode = { code: '123456', windowStartMs: 120_000, windowEndMs: 150_000 };
  const broker = totpBroker([brokerCode]);
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-1', serverEpochMs: 100_000 }),
    },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: broker,
    freshStartPolicyApplied: true,
    timeoutMs: 10_000,
  });

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' ? result.reason : '', 'facebook_totp_window_mismatch');
  assert.equal(result.actionAttempts, 0);
  assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
  assert.equal(brokerCode.code, '', 'window mismatch must scrub the broker-owned object in place');
  runtime.assertDone();
});

test('a fresh probe signal change scrubs the broker-owned code before continuing', async () => {
  const brokerCode = { code: '123456', windowStartMs: 90_000, windowEndMs: 120_000 };
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-1', serverEpochMs: 100_000 }),
    },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker([brokerCode]),
    freshStartPolicyApplied: true,
    timeoutMs: 10_000,
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 0 });
  assert.equal(brokerCode.code, '', 'signal change must scrub before the pending probe continues');
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_probe',
  ]);
  runtime.assertDone();
});

test('a stalled TOTP broker cannot outlive the shared login budget', async () => {
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-1', serverEpochMs: 100_000 }),
    },
  ]);
  const broker: FacebookTotpBroker = {
    request: async () => await new Promise<FacebookTotpCode>(() => undefined),
  };

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: broker,
    freshStartPolicyApplied: true,
    timeoutMs: 20,
  });

  assert.deepEqual(result, { kind: 'timeout', actionAttempts: 0 });
  assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
  runtime.assertDone();
});

test('human-verification and unfamiliar checkpoints dispatch no Native input', async () => {
  for (const [signal, reason] of [
    ['blocked_human_verification', 'captcha_detected'],
    ['blocked_unknown', 'checkpoint_unrecognized'],
  ] as const) {
    const runtime = new ScriptedRuntime([
      { kind: 'facebook_auth_probe', execution: probe(signal, { reason }) },
    ]);

    const result = await reconcileFacebookStartupAuth({
      runtime,
      totpBroker: totpBroker(),
      freshStartPolicyApplied: true,
      timeoutMs: 5_000,
    });

    assert.equal(result.kind, 'failed');
    assert.equal(result.kind === 'failed' ? result.reason : '', reason);
    assert.equal(result.actionAttempts, 0);
    assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
    runtime.assertDone();
  }
});
