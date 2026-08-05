import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  FacebookTotpBroker,
  FacebookTotpCode,
} from '../../src/cdp/facebook-totp-broker.js';
import {
  CREDENTIAL_FILL_GRACE_MS,
  MAX_STALE_LOGIN_SIGNAL_RETRIES,
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

/**
 * 凭据安定窗口需要时间真的流逝。冻住的时钟（now: () => 0）会让安定永远不满足，
 * 因此凡是驱动 login_submit_ready 的用例都必须用这个会走动的时钟。
 */
function advancingClock(startMs = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => { nowMs += Math.max(0, ms); },
  };
}

/**
 * 一个「已安定」的登录信号 = 同一个 signal id 被连续观测到两次，中间隔满安定窗口。
 * 第一拍只开始计时、绝不下发动作；第二拍才授权提交。
 */
function settledLoginProbes(signalId: string): RuntimeStep[] {
  return [
    { kind: 'facebook_auth_probe', execution: probe('login_submit_ready', { signalId }) },
    { kind: 'facebook_auth_probe', execution: probe('login_submit_ready', { signalId }) },
  ];
}

test('filled email login advances through one TOTP entry and submit chain', async () => {
  const automaticProgress: Array<{ signal: string; action: string }> = [];
  const broker = totpBroker([
    { code: '123456', windowStartMs: 90_000, windowEndMs: 120_000 },
  ]);
  const clock = advancingClock();
  const runtime = new ScriptedRuntime([
    ...settledLoginProbes('login-1'),
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
    now: clock.now,
    sleep: clock.sleep,
    onAutomaticProgress: (progress: { signal: string; action: string }) => automaticProgress.push(progress),
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 3 });
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
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
  assert.deepEqual(automaticProgress, [
    { signal: 'login_submit_ready', action: 'facebook_auth_submit_login' },
    { signal: 'totp_entry_ready', action: 'facebook_auth_enter_totp' },
    { signal: 'totp_submit_ready', action: 'facebook_auth_submit_totp' },
  ]);
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

test('a proven fresh start clears a complete orphan TOTP before entering a new code', async () => {
  const broker = totpBroker([
    { code: '654321', windowStartMs: 90_000, windowEndMs: 120_000 },
  ]);
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_refresh_required', {
        signalId: 'orphan-1',
        serverEpochMs: 90_100,
        reason: 'entered_totp_window_unavailable',
      }),
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

test('an unproven active browser retains an empty TOTP field for manual completion', async () => {
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('totp_entry_ready', { signalId: 'entry-manual', serverEpochMs: 90_100 }),
    },
  ]);
  const broker = totpBroker();

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: broker,
    freshStartPolicyApplied: false,
    timeoutMs: 5_000,
  });

  assert.deepEqual(result, {
    kind: 'manual_required',
    reason: 'fresh_start_policy_unavailable',
    actionAttempts: 0,
  });
  assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
  assert.deepEqual(broker.requests, []);
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
  const clock = advancingClock();
  const runtime = new ScriptedRuntime([
    ...settledLoginProbes('login-1'),
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
    now: clock.now,
    sleep: clock.sleep,
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

test('authenticated quiet window catches a late Remember Password card before startup completes', async () => {
  let nowMs = 0;
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
    { kind: 'facebook_auth_probe', execution: probe('remember_password_confirm', { signalId: 'remember-late' }) },
    {
      kind: 'facebook_auth_confirm_remember_password',
      execution: action('facebook_auth_confirm_remember_password', 'remember-late'),
    },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 30_000,
    authenticatedQuietWindowMs: 15_000,
    pollIntervalMs: 5_000,
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; },
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 1 });
  assert.equal(nowMs, 20_000, 'the late prompt resets the full authenticated quiet window');
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_probe',
    'facebook_auth_confirm_remember_password',
    'facebook_auth_probe',
    'facebook_auth_probe',
    'facebook_auth_probe',
    'facebook_auth_probe',
  ]);
  runtime.assertDone();
});

test('hydrated warning is independently dismissed after transitional probes', async () => {
  const automaticProgress: Array<{ signal: string; action: string }> = [];
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('none', { reason: 'checkpoint_hydrating' }) },
    { kind: 'facebook_auth_probe', execution: probe('none', { reason: 'automation_warning_hydrating' }) },
    { kind: 'facebook_auth_probe', execution: probe('automation_warning_dismiss', { signalId: 'warning-1' }) },
    {
      kind: 'facebook_auth_dismiss_warning',
      execution: action('facebook_auth_dismiss_warning', 'warning-1'),
    },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 20_000,
    sleep: async () => undefined,
    onAutomaticProgress: (progress) => automaticProgress.push(progress),
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 1 });
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_probe',
    'facebook_auth_probe',
    'facebook_auth_dismiss_warning',
    'facebook_auth_probe',
  ]);
  assert.deepEqual(automaticProgress, [
    { signal: 'automation_warning_dismiss', action: 'facebook_auth_dismiss_warning' },
  ]);
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
  const clock = advancingClock();
  const runtime = new ScriptedRuntime([
    ...settledLoginProbes('login-1'),
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
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' ? result.effectPhase : '', 'ambiguous');
  assert.equal(result.actionAttempts, 1);
  assert.equal(runtime.calls.length, 3);
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
  const automaticProgress: Array<{ signal: string; action: string }> = [];
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
    onAutomaticProgress: (progress) => automaticProgress.push(progress),
  });

  assert.deepEqual(result, {
    kind: 'manual_required',
    reason: 'credential_fill_unavailable',
    actionAttempts: 0,
  });
  assert.deepEqual(runtime.calls.map((call) => call.kind), ['facebook_auth_probe']);
  assert.deepEqual(automaticProgress, [], 'manual-required observation must not imply autonomous progress');
  runtime.assertDone();
});

test('a growing password never authorizes submission and settles only when it stops changing', async () => {
  // 观测层每敲进一个字符就换一个 signal id。协调层只有在**同一个 id** 连续被观测到
  // 跨越安定窗口之后才允许提交——旧判据（非空即就绪）会在这里点下第一枪。
  const clock = advancingClock();
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('login_submit_ready', { signalId: 'fill-2' }) },
    { kind: 'facebook_auth_probe', execution: probe('login_submit_ready', { signalId: 'fill-7' }) },
    { kind: 'facebook_auth_probe', execution: probe('login_submit_ready', { signalId: 'fill-15' }) },
    { kind: 'facebook_auth_probe', execution: probe('login_submit_ready', { signalId: 'fill-15' }) },
    { kind: 'facebook_auth_submit_login', execution: action('facebook_auth_submit_login', 'fill-15') },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 30_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 1 });
  assert.deepEqual(
    runtime.calls.filter((call) => call.kind === 'facebook_auth_submit_login')
      .map((call) => (call.params as { signalId?: string }).signalId),
    ['fill-15'],
    'only the settled fill may be submitted',
  );
  runtime.assertDone();
});

test('the fill grace is anchored on both fields appearing, not on document load', async () => {
  // 只有「两个框都在」的观测才启动宽限计时；表单/字段还没渲染出来的拍点 MUST NOT 消耗预算。
  const clock = advancingClock();
  const runtime = new ScriptedRuntime([
    { kind: 'facebook_auth_probe', execution: probe('none', { reason: 'login_form_hydrating' }) },
    { kind: 'facebook_auth_probe', execution: probe('none', { reason: 'login_fields_hydrating' }) },
    ...Array.from(
      { length: Math.ceil(CREDENTIAL_FILL_GRACE_MS / 500) + 1 },
      () => ({
        kind: 'facebook_auth_probe',
        execution: probe('none', { reason: 'credential_fill_pending' }),
      }),
    ),
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 300_000,
    pollIntervalMs: 500,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(result, {
    kind: 'manual_required',
    reason: 'credential_fill_unavailable',
    actionAttempts: 0,
  });
  // 前两拍（表单未渲染）不计入预算：真正到点的时刻必须晚于纯文档年龄口径。
  assert.ok(
    clock.now() >= CREDENTIAL_FILL_GRACE_MS + 1_000,
    `grace must start at the first credential_fill_pending, elapsed=${clock.now()}`,
  );
  assert.equal(
    runtime.calls.every((call) => call.kind === 'facebook_auth_probe'),
    true,
    'an unfilled form must never produce Native input',
  );
});

test('a superseded login signal re-probes instead of failing terminally', async () => {
  // 引擎在预留信号与派发点击**之前**就拒绝了：not_started 是「确定没有输入发出」的权威证据。
  // 重新探测一次就会拿到带新字符数的 id —— 非结构性失败 MUST NOT 落终态。
  // 这里手抄的 (stale_auth_signal, not_started) 这一对，是引擎侧的既有契约：
  // native/page-engine/tests/facebook_auth.rs 的 assert_refused 独立断言了同一对。
  // 那边一改，这条恢复路径就会静默失效，务必两处一起看。
  const clock = advancingClock();
  const runtime = new ScriptedRuntime([
    ...settledLoginProbes('fill-14'),
    {
      kind: 'facebook_auth_submit_login',
      execution: {
        ok: false,
        effectPhase: 'not_started',
        reasonCode: 'stale_auth_signal',
        output: {
          kind: 'facebook_auth_action',
          value: {
            action: 'facebook_auth_submit_login',
            signalId: 'fill-14',
            ok: false,
            reason: 'stale_auth_signal',
          },
        },
      },
    },
    ...settledLoginProbes('fill-15'),
    { kind: 'facebook_auth_submit_login', execution: action('facebook_auth_submit_login', 'fill-15') },
    { kind: 'facebook_auth_probe', execution: probe('authenticated') },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 60_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(result, { kind: 'authenticated', actionAttempts: 2 });
  runtime.assertDone();
});

test('a superseded login signal exhausts a bounded budget and then fails honestly', async () => {
  const clock = advancingClock();
  const staleReceipt = (signalId: string): RuntimeStep => ({
    kind: 'facebook_auth_submit_login',
    execution: {
      ok: false,
      effectPhase: 'not_started',
      reasonCode: 'stale_auth_signal',
      output: {
        kind: 'facebook_auth_action',
        value: {
          action: 'facebook_auth_submit_login',
          signalId,
          ok: false,
          reason: 'stale_auth_signal',
        },
      },
    },
  });
  const steps: RuntimeStep[] = [];
  for (let attempt = 0; attempt <= MAX_STALE_LOGIN_SIGNAL_RETRIES; attempt += 1) {
    steps.push(...settledLoginProbes(`fill-${attempt}`), staleReceipt(`fill-${attempt}`));
  }
  const runtime = new ScriptedRuntime(steps);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 300_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(result, {
    kind: 'failed',
    reason: 'credential_fill_unsettled',
    actionAttempts: MAX_STALE_LOGIN_SIGNAL_RETRIES + 1,
  });
  runtime.assertDone();
});

test('an ambiguous login receipt is never rescued by the superseded-signal path', async () => {
  // 恢复出口只对 not_started 开放。含混回执可能已经把提交按下去了，
  // 重投一条可能已上墙的提交是本仓代价最高的错误 —— 维持终局。
  const clock = advancingClock();
  const runtime = new ScriptedRuntime([
    ...settledLoginProbes('fill-15'),
    {
      kind: 'facebook_auth_submit_login',
      execution: {
        ok: false,
        effectPhase: 'ambiguous',
        reasonCode: 'stale_auth_signal',
        output: {
          kind: 'facebook_auth_action',
          value: {
            action: 'facebook_auth_submit_login',
            signalId: 'fill-15',
            ok: false,
            reason: 'stale_auth_signal',
          },
        },
      },
    },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 30_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(result, {
    kind: 'failed',
    reason: 'stale_auth_signal',
    effectPhase: 'ambiguous',
    actionAttempts: 1,
  });
  runtime.assertDone();
});

test('confirmed suspension Appeal entry stops at one action and hands the successor to the operator', async () => {
  const automaticProgress: Array<{ signal: string; action: string }> = [];
  const runtime = new ScriptedRuntime([
    {
      kind: 'facebook_auth_probe',
      execution: probe('suspension_appeal_start', { signalId: 'appeal-1' }),
    },
    {
      kind: 'facebook_auth_start_suspension_appeal',
      execution: action('facebook_auth_start_suspension_appeal', 'appeal-1'),
    },
  ]);

  const result = await reconcileFacebookStartupAuth({
    runtime,
    totpBroker: totpBroker(),
    freshStartPolicyApplied: true,
    timeoutMs: 30_000,
    onAutomaticProgress: (progress) => automaticProgress.push(progress),
  });

  assert.deepEqual(result, {
    kind: 'manual_required',
    reason: 'facebook_suspension_appeal_step_required',
    actionAttempts: 1,
  });
  assert.deepEqual(runtime.calls.map((call) => call.kind), [
    'facebook_auth_probe',
    'facebook_auth_start_suspension_appeal',
  ]);
  assert.deepEqual(automaticProgress, [{
    signal: 'suspension_appeal_start',
    action: 'facebook_auth_start_suspension_appeal',
  }]);
  runtime.assertDone();
});

test('retained manual-login session re-enters the same coordinator when the page advances to 2FA', async () => {
  const automaticProgress: Array<{ signal: string; action: string }> = [];
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
    onAutomaticProgress: (progress: { signal: string; action: string }) => automaticProgress.push(progress),
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
  assert.deepEqual(automaticProgress, [
    { signal: 'totp_entry_ready', action: 'facebook_auth_enter_totp' },
    { signal: 'totp_submit_ready', action: 'facebook_auth_submit_totp' },
  ], 'only structurally bound automatic actions publish progress');
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

test('TOTP expiring while Continue hydrates is cleared before a new entry and submit', async () => {
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
      execution: probe('none', { reason: 'totp_submit_hydrating', serverEpochMs: 110_100 }),
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
    now: () => 0,
    sleep: async () => undefined,
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
  const ownedWindowProbes = runtime.calls.filter((call) =>
    call.kind === 'facebook_auth_probe'
      && call.params.enteredTotpWindowStartUnixMs === 90_000
  );
  assert.equal(ownedWindowProbes.length, 2, 'hydration and expiry probes retain the owned window');
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
