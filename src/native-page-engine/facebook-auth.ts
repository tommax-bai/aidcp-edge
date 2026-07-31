import type {
  FacebookTotpBroker,
  FacebookTotpCode,
} from '../cdp/facebook-totp-broker.js';
import {
  NATIVE_FACEBOOK_AUTH_SIGNALS,
  type NativeFacebookAuthActionKind,
  type NativeFacebookAuthProbeReceipt,
  type NativeFacebookAuthSignal,
  type NativeEffectPhase,
  type NativePageCommand,
  type NativePageCommandExecution,
} from './client.js';

const TOTP_WINDOW_MS = 30_000;
const TOTP_MIN_REMAINING_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_COMMAND_TIMEOUT_MS = 30_000;
const SAFE_REASON_RE = /^[a-z0-9_]{1,80}$/;
const SIGNAL_ID_RE = /^[\x21-\x7e]{1,512}$/;

export type FacebookAuthSignal = NativeFacebookAuthSignal;

type ActionableFacebookAuthSignal = Exclude<
  FacebookAuthSignal,
  'authenticated' | 'manual_login_required' | 'blocked_human_verification' | 'blocked_unknown' | 'none'
>;

type FacebookAuthActionCommandKind = NativeFacebookAuthActionKind;

const ACTION_FOR_SIGNAL: Record<ActionableFacebookAuthSignal, FacebookAuthActionCommandKind> = {
  login_submit_ready: 'facebook_auth_submit_login',
  totp_entry_ready: 'facebook_auth_enter_totp',
  totp_submit_ready: 'facebook_auth_submit_totp',
  totp_refresh_required: 'facebook_auth_clear_totp',
  automation_warning_dismiss: 'facebook_auth_dismiss_warning',
  push_blocker_close: 'facebook_auth_close_push_blocker',
  remember_password_confirm: 'facebook_auth_confirm_remember_password',
};

const AUTH_SIGNALS = new Set<FacebookAuthSignal>(NATIVE_FACEBOOK_AUTH_SIGNALS);

export interface FacebookAuthRuntime {
  execute(
    ownerId: string,
    command: NativePageCommand,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<NativePageCommandExecution>;
}

export interface FacebookAuthCoordinatorOptions {
  runtime: FacebookAuthRuntime;
  totpBroker: FacebookTotpBroker;
  freshStartPolicyApplied: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  pollInterrupt?: () => string | null;
  logger?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
}

export type FacebookAuthCoordinatorResult =
  | { kind: 'authenticated'; actionAttempts: number }
  | { kind: 'disabled'; actionAttempts: 0 }
  | { kind: 'manual_required'; reason: string; actionAttempts: number }
  | { kind: 'timeout'; actionAttempts: number }
  | { kind: 'interrupted'; reason: string; actionAttempts: number }
  | {
      kind: 'failed';
      reason: string;
      effectPhase?: NativeEffectPhase;
      actionAttempts: number;
    };

type FacebookAuthCoordinatorResultWithoutAttempts =
  FacebookAuthCoordinatorResult extends infer Result
    ? Result extends { actionAttempts: number }
      ? Omit<Result, 'actionAttempts'>
      : never
    : never;

type FacebookAuthProbe = NativeFacebookAuthProbeReceipt;

interface EnteredTotpWindow {
  startMs: number;
  endMs: number;
}

type CommandAttempt =
  | { ok: true; execution: NativePageCommandExecution }
  | { ok: false; result: FacebookAuthCoordinatorResult };

type ProbeAttempt =
  | { ok: true; probe: FacebookAuthProbe }
  | { ok: false; result: FacebookAuthCoordinatorResult };

type TotpAttempt =
  | { ok: true; code: FacebookTotpCode }
  | { ok: false; result: FacebookAuthCoordinatorResult };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeReason(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_REASON_RE.test(value) ? value : fallback;
}

function validSignalId(value: unknown): value is string {
  return typeof value === 'string' && SIGNAL_ID_RE.test(value);
}

function validServerEpochMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function windowFor(serverEpochMs: number): EnteredTotpWindow {
  const startMs = Math.floor(serverEpochMs / TOTP_WINDOW_MS) * TOTP_WINDOW_MS;
  return { startMs, endMs: startMs + TOTP_WINDOW_MS };
}

function remainingInWindow(serverEpochMs: number, window: EnteredTotpWindow): number {
  return window.endMs - serverEpochMs;
}

function sameWindow(left: EnteredTotpWindow, right: EnteredTotpWindow): boolean {
  return left.startMs === right.startMs && left.endMs === right.endMs;
}

function validTotpCode(
  value: unknown,
): value is FacebookTotpCode {
  const record = asRecord(value);
  return Boolean(record)
    && typeof record?.code === 'string'
    && /^\d{6}$/.test(record.code)
    && Number.isSafeInteger(record.windowStartMs)
    && Number.isSafeInteger(record.windowEndMs)
    && Number(record.windowEndMs) - Number(record.windowStartMs) === TOTP_WINDOW_MS;
}

function scrubTotpCode(value: unknown): void {
  const record = asRecord(value);
  if (!record || typeof record.code !== 'string') return;
  try {
    record.code = '';
  } catch {
    // A broker-owned immutable object is invalid input; never log or copy its code while failing.
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, Math.max(0, ms));
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function probeParams(
  enteredWindow: EnteredTotpWindow | undefined,
  allowAuthActions: boolean,
): Record<string, unknown> {
  return {
    allowAuthActions,
    ...(enteredWindow ? {
      enteredTotpWindowStartUnixMs: enteredWindow.startMs,
      enteredTotpWindowEndUnixMs: enteredWindow.endMs,
    } : {}),
  };
}

/**
 * Reconciles only Native-produced Facebook auth signals. This module contains no page selectors,
 * DOM calls, or direct CDP input. Stable account identity remains a separate read-only gate.
 */
export async function reconcileFacebookStartupAuth(
  options: FacebookAuthCoordinatorOptions,
): Promise<FacebookAuthCoordinatorResult> {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, Math.floor(options.timeoutMs))
    : 0;
  if (timeoutMs === 0) return { kind: 'disabled', actionAttempts: 0 };

  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const log = options.logger ?? (() => undefined);
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.max(1, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS))
    : DEFAULT_POLL_INTERVAL_MS;
  const deadlineMs = now() + timeoutMs;
  const dispatchedSignalIds = new Set<string>();
  const maxPasses = Math.max(
    32,
    Math.min(4_096, Math.ceil(timeoutMs / pollIntervalMs) + 32),
  );
  let actionAttempts = 0;
  let enteredWindow: EnteredTotpWindow | undefined;
  let pendingProbe: FacebookAuthProbe | undefined;

  const result = (
    value: FacebookAuthCoordinatorResultWithoutAttempts,
  ): FacebookAuthCoordinatorResult => (
    { ...value, actionAttempts } as FacebookAuthCoordinatorResult
  );

  const interrupted = (): string | null => {
    if (options.signal?.aborted) return 'aborted';
    try {
      const reason = options.pollInterrupt?.();
      return reason ? safeReason(reason, 'lifecycle_interrupted') : null;
    } catch {
      return 'lifecycle_interrupt_failed';
    }
  };

  const remainingBudgetMs = (): number => Math.max(0, deadlineMs - now());

  const runCommand = async (
    command: NativePageCommand,
  ): Promise<CommandAttempt> => {
    const before = interrupted();
    if (before) return { ok: false, result: result({ kind: 'interrupted', reason: before }) };
    const remainingMs = remainingBudgetMs();
    if (remainingMs <= 0) return { ok: false, result: result({ kind: 'timeout' }) };

    const controller = new AbortController();
    let lifecycleInterrupt: string | null = null;
    const forwardAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    const interruptTimer = options.pollInterrupt
      ? setInterval(() => {
          const reason = interrupted();
          if (!reason) return;
          lifecycleInterrupt = reason;
          controller.abort();
        }, Math.min(pollIntervalMs, remainingMs))
      : undefined;
    interruptTimer?.unref?.();
    try {
      const execution = await options.runtime.execute(
        'facebook-startup-auth',
        command,
        Math.max(1, Math.min(MAX_COMMAND_TIMEOUT_MS, remainingMs)),
        controller.signal,
      );
      if (lifecycleInterrupt || options.signal?.aborted) {
        return {
          ok: false,
          result: result({
            kind: 'interrupted',
            reason: lifecycleInterrupt ?? 'aborted',
          }),
        };
      }
      if (remainingBudgetMs() <= 0) {
        return { ok: false, result: result({ kind: 'timeout' }) };
      }
      return { ok: true, execution };
    } catch {
      if (lifecycleInterrupt || options.signal?.aborted) {
        return {
          ok: false,
          result: result({
            kind: 'interrupted',
            reason: lifecycleInterrupt ?? 'aborted',
          }),
        };
      }
      if (remainingBudgetMs() <= 0) {
        return { ok: false, result: result({ kind: 'timeout' }) };
      }
      return {
        ok: false,
        result: result({ kind: 'failed', reason: 'native_auth_command_failed' }),
      };
    } finally {
      if (interruptTimer) clearInterval(interruptTimer);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  };

  const readProbe = async (): Promise<ProbeAttempt> => {
    const attempt = await runCommand({
      kind: 'facebook_auth_probe',
      params: probeParams(enteredWindow, options.freshStartPolicyApplied),
    });
    if (!attempt.ok) return attempt;
    const { execution } = attempt;
    if (!execution.ok
        || execution.effectPhase !== 'confirmed'
        || execution.output?.kind !== 'facebook_auth_probe') {
      return {
        ok: false,
        result: result({
          kind: 'failed',
          reason: 'facebook_auth_probe_unconfirmed',
          effectPhase: execution.effectPhase,
        }),
      };
    }
    const value = execution.output.value;
    if (!AUTH_SIGNALS.has(value.signal)) {
      return {
        ok: false,
        result: result({ kind: 'failed', reason: 'facebook_auth_probe_invalid' }),
      };
    }
    const probe: FacebookAuthProbe = { signal: value.signal };
    if (value.signalId !== undefined) {
      if (!validSignalId(value.signalId)) {
        return {
          ok: false,
          result: result({ kind: 'failed', reason: 'facebook_auth_signal_id_invalid' }),
        };
      }
      probe.signalId = value.signalId;
    }
    if (value.serverEpochMs !== undefined) {
      if (!validServerEpochMs(value.serverEpochMs)) {
        return {
          ok: false,
          result: result({ kind: 'failed', reason: 'facebook_server_time_invalid' }),
        };
      }
      probe.serverEpochMs = value.serverEpochMs;
    }
    if (value.reason !== undefined) probe.reason = safeReason(value.reason, 'facebook_auth_blocked');
    return { ok: true, probe };
  };

  const waitWithinBudget = async (
    requestedMs: number,
  ): Promise<FacebookAuthCoordinatorResult | null> => {
    let leftMs = Math.max(0, Math.ceil(requestedMs));
    while (leftMs > 0) {
      const reason = interrupted();
      if (reason) return result({ kind: 'interrupted', reason });
      const budgetMs = remainingBudgetMs();
      if (budgetMs <= 0) return result({ kind: 'timeout' });
      const chunkMs = Math.min(leftMs, pollIntervalMs, budgetMs);
      await sleep(chunkMs, options.signal);
      leftMs -= chunkMs;
    }
    const reason = interrupted();
    return reason ? result({ kind: 'interrupted', reason }) : null;
  };

  const requestTotpWithinBudget = (
    serverEpochMs: number,
  ): Promise<TotpAttempt> => {
    const before = interrupted();
    if (before) {
      return Promise.resolve({
        ok: false,
        result: result({ kind: 'interrupted', reason: before }),
      });
    }
    const remainingMs = remainingBudgetMs();
    if (remainingMs <= 0) {
      return Promise.resolve({ ok: false, result: result({ kind: 'timeout' }) });
    }

    return new Promise<TotpAttempt>((resolve) => {
      let settled = false;
      const finish = (attempt: TotpAttempt): void => {
        if (settled) {
          if (attempt.ok) scrubTotpCode(attempt.code);
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (interruptTimer) clearInterval(interruptTimer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(attempt);
      };
      const onAbort = (): void => {
        finish({
          ok: false,
          result: result({ kind: 'interrupted', reason: 'aborted' }),
        });
      };
      const timeout = setTimeout(
        () => finish({ ok: false, result: result({ kind: 'timeout' }) }),
        remainingMs,
      );
      const interruptTimer = options.pollInterrupt
        ? setInterval(() => {
            const reason = interrupted();
            if (!reason) return;
            finish({
              ok: false,
              result: result({ kind: 'interrupted', reason }),
            });
          }, Math.min(pollIntervalMs, remainingMs))
        : undefined;
      interruptTimer?.unref?.();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }

      void options.totpBroker.request(serverEpochMs).then(
        (code) => {
          if (remainingBudgetMs() <= 0) {
            scrubTotpCode(code);
            finish({ ok: false, result: result({ kind: 'timeout' }) });
            return;
          }
          finish({ ok: true, code });
        },
        () => finish({
          ok: false,
          result: result({ kind: 'failed', reason: 'facebook_totp_unavailable' }),
        }),
      );
    });
  };

  const dispatchAction = async (
    probe: FacebookAuthProbe,
    commandKind: FacebookAuthActionCommandKind,
    params: Record<string, unknown> = {},
  ): Promise<FacebookAuthCoordinatorResult | null> => {
    if (!probe.signalId) {
      return result({ kind: 'failed', reason: 'facebook_auth_signal_id_missing' });
    }
    if (dispatchedSignalIds.has(probe.signalId)) {
      return result({ kind: 'failed', reason: 'facebook_auth_signal_replayed' });
    }
    if (!options.freshStartPolicyApplied) {
      return result({ kind: 'failed', reason: 'fresh_start_policy_unavailable' });
    }

    dispatchedSignalIds.add(probe.signalId);
    actionAttempts += 1;
    const attempt = await runCommand({
      kind: commandKind,
      params: { signalId: probe.signalId, ...params },
    });
    if (!attempt.ok) return attempt.result;

    const { execution } = attempt;
    const output = execution.output;
    if (
      !execution.ok
      || execution.effectPhase !== 'confirmed'
      || output?.kind !== 'facebook_auth_action'
      || output.value.ok !== true
      || output.value.action !== commandKind
      || output.value.signalId !== probe.signalId
    ) {
      return result({
        kind: 'failed',
        reason: safeReason(execution.reasonCode, 'facebook_auth_action_unconfirmed'),
        effectPhase: execution.effectPhase,
      });
    }
    log(`[facebook-auth] action confirmed kind=${commandKind}`);
    return null;
  };

  log(
    `[facebook-auth] bounded reconciliation started policy=${options.freshStartPolicyApplied ? 'fresh' : 'unproven'}`,
  );

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const stopReason = interrupted();
    if (stopReason) return result({ kind: 'interrupted', reason: stopReason });
    if (remainingBudgetMs() <= 0) return result({ kind: 'timeout' });

    let probe: FacebookAuthProbe;
    if (pendingProbe) {
      probe = pendingProbe;
      pendingProbe = undefined;
    } else {
      const attempt = await readProbe();
      if (!attempt.ok) return attempt.result;
      probe = attempt.probe;
    }
    log(`[facebook-auth] observed signal=${probe.signal}`);

    if (probe.signal === 'authenticated') {
      return result({ kind: 'authenticated' });
    }
    if (probe.signal === 'manual_login_required') {
      return result({
        kind: 'manual_required',
        reason: safeReason(probe.reason, 'manual_login_required'),
      });
    }
    if (probe.signal === 'blocked_human_verification') {
      return result({
        kind: 'failed',
        reason: safeReason(probe.reason, 'blocked_human_verification'),
      });
    }
    if (probe.signal === 'blocked_unknown') {
      return result({
        kind: 'failed',
        reason: safeReason(probe.reason, 'blocked_unknown'),
      });
    }
    if (probe.signal === 'none') {
      const waited = await waitWithinBudget(Math.min(pollIntervalMs, remainingBudgetMs()));
      if (waited) return waited;
      continue;
    }

    if (probe.signal === 'totp_entry_ready') {
      if (!options.freshStartPolicyApplied) {
        return result({ kind: 'failed', reason: 'fresh_start_policy_unavailable' });
      }
      if (!validServerEpochMs(probe.serverEpochMs)) {
        return result({ kind: 'failed', reason: 'facebook_server_time_unavailable' });
      }
      const observedWindow = windowFor(probe.serverEpochMs);
      const remainingMs = remainingInWindow(probe.serverEpochMs, observedWindow);
      if (remainingMs < TOTP_MIN_REMAINING_MS) {
        const waited = await waitWithinBudget(remainingMs + 1);
        if (waited) return waited;
        continue;
      }

      const codeAttempt = await requestTotpWithinBudget(probe.serverEpochMs);
      if (!codeAttempt.ok) return codeAttempt.result;
      const brokerCode = codeAttempt.code;
      try {
        if (!validTotpCode(brokerCode)) {
          return result({ kind: 'failed', reason: 'facebook_totp_response_invalid' });
        }
        const brokerWindow = {
          startMs: brokerCode.windowStartMs,
          endMs: brokerCode.windowEndMs,
        };
        if (!sameWindow(observedWindow, brokerWindow)) {
          return result({ kind: 'failed', reason: 'facebook_totp_window_mismatch' });
        }

        // The broker call consumed time. Only a fresh Native server-time observation may authorize
        // entry; local wall-clock extrapolation is deliberately insufficient.
        const freshAttempt = await readProbe();
        if (!freshAttempt.ok) return freshAttempt.result;
        const freshProbe = freshAttempt.probe;
        if (freshProbe.signal !== 'totp_entry_ready') {
          pendingProbe = freshProbe;
          continue;
        }
        if (!validServerEpochMs(freshProbe.serverEpochMs)) {
          return result({ kind: 'failed', reason: 'facebook_server_time_unavailable' });
        }
        const freshWindow = windowFor(freshProbe.serverEpochMs);
        if (!sameWindow(freshWindow, brokerWindow)
            || remainingInWindow(freshProbe.serverEpochMs, freshWindow) < TOTP_MIN_REMAINING_MS) {
          pendingProbe = freshProbe;
          continue;
        }

        const actionResult = await dispatchAction(
          freshProbe,
          ACTION_FOR_SIGNAL.totp_entry_ready,
          {
            totpCode: brokerCode.code,
            totpWindowStartUnixMs: brokerWindow.startMs,
            totpWindowEndUnixMs: brokerWindow.endMs,
          },
        );
        if (actionResult) return actionResult;
        enteredWindow = brokerWindow;
        continue;
      } finally {
        scrubTotpCode(brokerCode);
      }
    }

    if (probe.signal === 'totp_submit_ready') {
      if (!enteredWindow) {
        return result({ kind: 'failed', reason: 'entered_totp_window_missing' });
      }
      if (!validServerEpochMs(probe.serverEpochMs)) {
        return result({ kind: 'failed', reason: 'facebook_server_time_unavailable' });
      }
      const currentWindow = windowFor(probe.serverEpochMs);
      if (!sameWindow(currentWindow, enteredWindow)
          || remainingInWindow(probe.serverEpochMs, currentWindow) < TOTP_MIN_REMAINING_MS) {
        // Native receives the entered window in every probe and must classify this as refresh.
        // Re-probe once without mutating; never clear against a stale submit signal id.
        const refreshAttempt = await readProbe();
        if (!refreshAttempt.ok) return refreshAttempt.result;
        if (refreshAttempt.probe.signal !== 'totp_refresh_required') {
          return result({ kind: 'failed', reason: 'totp_refresh_signal_unavailable' });
        }
        pendingProbe = refreshAttempt.probe;
        continue;
      }
      const actionResult = await dispatchAction(
        probe,
        ACTION_FOR_SIGNAL.totp_submit_ready,
        {
          totpWindowStartUnixMs: enteredWindow.startMs,
          totpWindowEndUnixMs: enteredWindow.endMs,
        },
      );
      if (actionResult) return actionResult;
      continue;
    }

    if (probe.signal === 'totp_refresh_required') {
      if (!enteredWindow) {
        return result({ kind: 'failed', reason: 'entered_totp_window_missing' });
      }
      const actionResult = await dispatchAction(
        probe,
        ACTION_FOR_SIGNAL.totp_refresh_required,
        {
          totpWindowStartUnixMs: enteredWindow.startMs,
          totpWindowEndUnixMs: enteredWindow.endMs,
        },
      );
      if (actionResult) return actionResult;
      enteredWindow = undefined;
      continue;
    }

    const actionResult = await dispatchAction(probe, ACTION_FOR_SIGNAL[probe.signal]);
    if (actionResult) return actionResult;
    // Every confirmed action is followed by a fresh probe at the top of the next pass.
  }

  return result({ kind: 'failed', reason: 'facebook_auth_reconcile_limit' });
}
