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
import type {
  NativeEffectPhase,
  NativeFacebookAuthActionKind,
  NativePageCommand,
  NativePageCommandExecution,
} from '../../src/native-page-engine/client.js';

interface RuntimeStep {
  kind: string;
  execution: NativePageCommandExecution;
}

class ScriptedRuntime implements FacebookAuthRuntime {
  readonly calls: NativePageCommand[] = [];

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
    return step.execution;
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
): NativePageCommandExecution {
  const confirmed = effectPhase === 'confirmed';
  return {
    ok: confirmed,
    effectPhase,
    reasonCode: confirmed ? 'confirmed' : 'postcondition_unconfirmed',
    output: {
      kind: 'facebook_auth_action',
      value: { action: kind, signalId, ok: confirmed },
    },
  };
}

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
