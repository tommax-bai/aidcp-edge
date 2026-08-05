import type {
  FacebookTotpBroker,
  FacebookTotpCode,
} from '../cdp/facebook-totp-broker.js';
import {
  NATIVE_FACEBOOK_AUTH_SIGNALS,
  NativePageEngineError,
  type NativeFacebookAuthActionKind,
  type NativeFacebookAuthProbeReceipt,
  type NativeFacebookAuthSignal,
  type NativeEffectPhase,
  type NativePageCommand,
  type NativePageCommandExecution,
  type NativePageEngineErrorCode,
} from './client.js';

const TOTP_WINDOW_MS = 30_000;
const TOTP_MIN_REMAINING_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
/**
 * 凭据安定窗口：同一个 `login_submit_ready` signal id 必须连续被观测到跨越这么久，才允许提交。
 *
 * AdsPower 的凭据是**逐字符模拟人手敲**进去的，所以「输入框非空」只证明填充**开始了**，
 * 绝不证明填充**结束了**。旧判据只看非空，实测在密码敲到第 1–2 个字符时就点了提交，
 * Facebook 回「密码不正确」，而点击又抢走焦点让填充永远停在半截（见 change
 * settle-facebook-credential-fill）。实测相邻按键间隔约 100–250ms，本值给到 6 倍余量。
 */
export const CREDENTIAL_SETTLE_MS = 1_500;
/**
 * 凭据填充宽限期，锚点是**两个凭据框首次同时被观测到**，不是文档开始加载。
 *
 * 文档零点比表单出现早十几秒（实测表单 ~10.7s 才出现、密码 ~15.2s 才开始敲），
 * 拿文档年龄计时会在敲完之前先判「凭据不可用」。实测从两个框出现到敲完约 7.5s，本值给到 6 倍余量。
 */
export const CREDENTIAL_FILL_GRACE_MS = 45_000;
/**
 * 「我准备点的这段时间里凭据又变了」的有界恢复次数。
 *
 * 这条路径的回执是 `stale_auth_signal` + `not_started`——引擎在预留信号与派发点击**之前**就拒绝了，
 * 「没有任何输入被发出」是权威事实而非猜测，因此重来不触碰提交点红线。它是非结构性失败：
 * 重新探测一次就会拿到带新字符数的 signal id。MUST NOT 落终态（见 docs/stop-or-continue.md）。
 */
export const MAX_STALE_LOGIN_SIGNAL_RETRIES = 5;
const MAX_COMMAND_TIMEOUT_MS = 30_000;
const PROBE_STABILIZATION_TIMEOUT_MS = 20_000;
const PROBE_RETRY_DELAYS_MS = [250, 500, 1_000] as const;
const FACEBOOK_AUTH_OWNER_ID = 'facebook-startup-auth';
const SAFE_REASON_RE = /^[a-z0-9_]{1,80}$/;
const SIGNAL_ID_RE = /^[\x21-\x7e]{1,512}$/;
const TRANSIENT_PROBE_ERROR_CODES = new Set<NativePageEngineErrorCode>([
  'endpoint_unreachable',
  'no_matching_target',
  'cdp_connect_failed',
  'cdp_timeout',
  'cdp_error',
  'engine_timeout',
  'engine_exited',
]);

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
  ad_data_review_get_started: 'facebook_auth_start_ad_data_review',
  suspension_appeal_start: 'facebook_auth_start_suspension_appeal',
};

const AUTH_SIGNALS = new Set<FacebookAuthSignal>(NATIVE_FACEBOOK_AUTH_SIGNALS);

export interface FacebookAuthRuntime {
  execute(
    ownerId: string,
    command: NativePageCommand,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<NativePageCommandExecution>;
  closeOwner(ownerId: string): Promise<void>;
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
  /** Additional authenticated quiet window used by the AdsPower startup gate. */
  authenticatedQuietWindowMs?: number;
  onAutomaticProgress?: (progress: {
    signal: FacebookAuthSignal;
    action: NativeFacebookAuthActionKind;
  }) => void;
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

/**
 * 「凭据在我准备点的这段时间里又变了」的可恢复出口。它**不是**一个结果，
 * 所以刻意不做成 `FacebookAuthCoordinatorResult` 的一员——落进结果类型就迟早会被某条
 * `return attempt.result` 顺手当成终态返回出去。
 */
const STALE_LOGIN_SIGNAL = Symbol('facebook_auth_stale_login_signal');

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

function nativeFailure(error: unknown): {
  code: NativePageEngineErrorCode | 'unknown';
  effectPhase?: NativeEffectPhase;
  transientProbe: boolean;
} {
  if (!(error instanceof NativePageEngineError)) {
    return { code: 'unknown', transientProbe: false };
  }
  return {
    code: error.code,
    effectPhase: error.detail?.effectPhase,
    transientProbe: TRANSIENT_PROBE_ERROR_CODES.has(error.code),
  };
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
  const authenticatedQuietWindowMs = Number.isFinite(options.authenticatedQuietWindowMs)
    ? Math.max(0, Math.floor(options.authenticatedQuietWindowMs ?? 0))
    : 0;
  const deadlineMs = now() + timeoutMs;
  const dispatchedSignalIds = new Set<string>();
  const maxPasses = Math.max(
    32,
    Math.min(4_096, Math.ceil(timeoutMs / pollIntervalMs) + 32),
  );
  let actionAttempts = 0;
  let enteredWindow: EnteredTotpWindow | undefined;
  let pendingProbe: FacebookAuthProbe | undefined;
  let authenticatedQuietStartedAt: number | undefined;
  /** 两个凭据框首次同时被观测到的时刻——填充宽限期的锚点，不是文档零点。 */
  let credentialFieldsFirstSeenAt: number | undefined;
  /** 当前正在计安定的 `login_submit_ready` signal id 及其首次观测时刻。 */
  let settlingLoginSignalId: string | undefined;
  let settlingLoginSignalSince: number | undefined;
  /** 已消费的「凭据又变了」恢复次数。恢复预算 MUST 只由失败消费，等待不计入。 */
  let staleLoginSignalRetries = 0;

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

  /**
   * 记下「两个凭据框都在」这一事实。锚点只由 `credential_fill_pending`（框在、还没填好）
   * 与 `login_submit_ready`（框在、已填上）两种观测确立；`login_form_hydrating` /
   * `login_fields_hydrating` 是页面自己还没渲染完，MUST NOT 消耗给填充的预算。
   */
  const noteCredentialFieldsPresent = (): void => {
    credentialFieldsFirstSeenAt ??= now();
  };

  /** 自「两个框都在」起是否已耗尽填充宽限期。锚点未确立时恒为 false。 */
  const credentialFillGraceExpired = (): boolean => (
    credentialFieldsFirstSeenAt !== undefined
    && now() - credentialFieldsFirstSeenAt >= CREDENTIAL_FILL_GRACE_MS
  );

  const forgetLoginSettleState = (): void => {
    settlingLoginSignalId = undefined;
    settlingLoginSignalSince = undefined;
  };

  /**
   * 把动作结果收敛回结果类型。恢复出口只在登录提交上产生，2FA 三条路径拿不到它——
   * 真拿到就是装配错了，如实报一个**具名**原因，绝不折进已有失败名当兜底桶。
   */
  const asResult = (
    outcome: FacebookAuthCoordinatorResult | typeof STALE_LOGIN_SIGNAL,
  ): FacebookAuthCoordinatorResult => (
    outcome === STALE_LOGIN_SIGNAL
      ? result({ kind: 'failed', reason: 'facebook_auth_stale_signal_misrouted' })
      : outcome
  );

  const runCommand = async (
    command: NativePageCommand,
  ): Promise<CommandAttempt> => {
    const probeStabilizationDeadlineMs = command.kind === 'facebook_auth_probe'
      ? Math.min(deadlineMs, now() + PROBE_STABILIZATION_TIMEOUT_MS)
      : undefined;
    let transientProbeRetries = 0;
    for (;;) {
      const before = interrupted();
      if (before) return { ok: false, result: result({ kind: 'interrupted', reason: before }) };
      const remainingMs = remainingBudgetMs();
      if (remainingMs <= 0) return { ok: false, result: result({ kind: 'timeout' }) };
      const stabilizationRemainingMs = probeStabilizationDeadlineMs === undefined
        ? remainingMs
        : Math.max(0, probeStabilizationDeadlineMs - now());
      if (transientProbeRetries > 0 && stabilizationRemainingMs <= 0) {
        log(
          '[facebook-auth] native probe stabilization exhausted '
          + `windowMs=${PROBE_STABILIZATION_TIMEOUT_MS} disposition=manual`,
        );
        return {
          ok: false,
          result: result({ kind: 'manual_required', reason: 'auth_probe_unavailable' }),
        };
      }

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
          FACEBOOK_AUTH_OWNER_ID,
          command,
          Math.max(1, Math.min(MAX_COMMAND_TIMEOUT_MS, remainingMs, stabilizationRemainingMs)),
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
      } catch (error) {
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

        const failure = nativeFailure(error);
        const retryWindowRemainingMs = probeStabilizationDeadlineMs === undefined
          ? 0
          : Math.max(0, probeStabilizationDeadlineMs - now());
        const retryProbe = command.kind === 'facebook_auth_probe'
          && failure.transientProbe
          && retryWindowRemainingMs > 0;
        const effectPhase = failure.effectPhase ?? 'unknown';
        if (command.kind === 'facebook_auth_probe'
            && failure.transientProbe
            && !retryProbe) {
          log(
            `[facebook-auth] native command failure kind=${command.kind} code=${failure.code} `
            + `effectPhase=${effectPhase} disposition=manual `
            + `windowMs=${PROBE_STABILIZATION_TIMEOUT_MS}`,
          );
          return {
            ok: false,
            result: result({ kind: 'manual_required', reason: 'auth_probe_unavailable' }),
          };
        }
        if (!retryProbe) {
          log(
            `[facebook-auth] native command failure kind=${command.kind} code=${failure.code} `
            + `effectPhase=${effectPhase} disposition=terminal`,
          );
          return {
            ok: false,
            result: result({
              kind: 'failed',
              reason: 'native_auth_command_failed',
              ...(failure.effectPhase ? { effectPhase: failure.effectPhase } : {}),
            }),
          };
        }

        transientProbeRetries += 1;
        const retryDelayMs = PROBE_RETRY_DELAYS_MS[
          Math.min(transientProbeRetries - 1, PROBE_RETRY_DELAYS_MS.length - 1)
        ];
        log(
          `[facebook-auth] native command failure kind=${command.kind} code=${failure.code} `
          + `effectPhase=${effectPhase} disposition=retry `
          + `attempt=${transientProbeRetries} retryInMs=${retryDelayMs}`,
        );
        try {
          await options.runtime.closeOwner(FACEBOOK_AUTH_OWNER_ID);
        } catch {
          log('[facebook-auth] native owner reset failed disposition=terminal');
          return {
            ok: false,
            result: result({ kind: 'failed', reason: 'native_auth_session_reset_failed' }),
          };
        }

        const waitMs = Math.min(
          retryDelayMs,
          remainingBudgetMs(),
          Math.max(0, (probeStabilizationDeadlineMs ?? deadlineMs) - now()),
        );
        if (waitMs <= 0) {
          if (remainingBudgetMs() <= 0) {
            return { ok: false, result: result({ kind: 'timeout' }) };
          }
          return {
            ok: false,
            result: result({ kind: 'manual_required', reason: 'auth_probe_unavailable' }),
          };
        }
        await sleep(waitMs, options.signal);
      } finally {
        if (interruptTimer) clearInterval(interruptTimer);
        options.signal?.removeEventListener('abort', forwardAbort);
      }
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
  ): Promise<FacebookAuthCoordinatorResult | null | typeof STALE_LOGIN_SIGNAL> => {
    if (!probe.signalId) {
      return result({ kind: 'failed', reason: 'facebook_auth_signal_id_missing' });
    }
    if (dispatchedSignalIds.has(probe.signalId)) {
      return result({ kind: 'failed', reason: 'facebook_auth_signal_replayed' });
    }
    if (!options.freshStartPolicyApplied) {
      return result({ kind: 'failed', reason: 'fresh_start_policy_unavailable' });
    }

    try {
      options.onAutomaticProgress?.({ signal: probe.signal, action: commandKind });
    } catch (error) {
      log(`[facebook-auth] automatic progress observer failed: ${error instanceof Error ? error.message : String(error)}`);
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
    const boundedReceipt = output?.kind === 'facebook_auth_action'
      && output.value.action === commandKind
      && output.value.signalId === probe.signalId
      ? output.value
      : undefined;
    if (
      !execution.ok
      || execution.effectPhase !== 'confirmed'
      || output?.kind !== 'facebook_auth_action'
      || output.value.ok !== true
      || output.value.action !== commandKind
      || output.value.signalId !== probe.signalId
    ) {
      const failureReason = safeReason(
        boundedReceipt?.reason,
        safeReason(execution.reasonCode, 'facebook_auth_action_unconfirmed'),
      );
      // 唯一的可恢复出口，三个条件缺一不可：① 只对登录提交（只有凭据是被逐字符敲进去的）；
      // ② 拒绝原因必须正好是「信号过期」；③ effectPhase 必须是 not_started ——引擎在预留信号
      // 与派发点击**之前**就拒绝了，这是「确定没有任何输入发出」的权威证据，不是「不知道发没发」。
      // ambiguous / dispatched、以及任何其它拒绝原因（信号已消费 / 预算耗尽 / 已取消）都不走这里，
      // 维持既有终局语义——重投一条可能已按下的提交，是本仓代价最高的错误。
      if (
        commandKind === 'facebook_auth_submit_login'
        && failureReason === 'stale_auth_signal'
        && execution.effectPhase === 'not_started'
      ) {
        return STALE_LOGIN_SIGNAL;
      }
      return result({
        kind: 'failed',
        reason: failureReason,
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
      if (authenticatedQuietWindowMs > 0) {
        authenticatedQuietStartedAt ??= now();
        const quietElapsedMs = Math.max(0, now() - authenticatedQuietStartedAt);
        if (quietElapsedMs < authenticatedQuietWindowMs) {
          const waited = await waitWithinBudget(Math.min(
            pollIntervalMs,
            authenticatedQuietWindowMs - quietElapsedMs,
            remainingBudgetMs(),
          ));
          if (waited) return waited;
          continue;
        }
      }
      return result({ kind: 'authenticated' });
    }
    authenticatedQuietStartedAt = undefined;
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
    if (probe.signal !== 'login_submit_ready') forgetLoginSettleState();
    if (probe.signal === 'none') {
      // 观测层对「两个框都在、还没填好」恒回 pending，时间判断由这里做：
      // 锚点是两个框首次同时出现，不是文档零点（文档零点比表单出现早十几秒）。
      if (probe.reason === 'credential_fill_pending') {
        noteCredentialFieldsPresent();
        if (credentialFillGraceExpired()) {
          log(
            '[facebook-auth] credential fill did not settle '
            + `windowMs=${CREDENTIAL_FILL_GRACE_MS} disposition=manual`,
          );
          return result({ kind: 'manual_required', reason: 'credential_fill_unavailable' });
        }
      }
      const waited = await waitWithinBudget(Math.min(pollIntervalMs, remainingBudgetMs()));
      if (waited) return waited;
      continue;
    }

    // 未证明 fresh-start 的浏览器代次永远不会被允许改动登录态（下面 dispatchAction 会当场拒绝）。
    // 那条终局答案与凭据填没填完无关，不该先花 1.5s 等一个注定用不上的安定窗口。
    if (probe.signal === 'login_submit_ready' && probe.signalId && options.freshStartPolicyApplied) {
      // 非空只证明填充**开始了**。同一个 signal id 连续观测到跨越安定窗口，才是
      // 「不再往里敲了」的证据——id 里含凭据字符数，多一个字符 id 就换一个。
      noteCredentialFieldsPresent();
      if (settlingLoginSignalId !== probe.signalId) {
        settlingLoginSignalId = probe.signalId;
        settlingLoginSignalSince = now();
      }
      const settledForMs = now() - (settlingLoginSignalSince ?? now());
      if (settledForMs < CREDENTIAL_SETTLE_MS) {
        // 安定迟迟不来（例如布局持续抖动）也不能永远等下去：仍受同一个填充宽限期约束，
        // 到点后进入人工登录等待这个安全态，而不是提交一个可能只有半截的密码。
        if (credentialFillGraceExpired()) {
          log(
            '[facebook-auth] credential fill did not settle '
            + `windowMs=${CREDENTIAL_FILL_GRACE_MS} disposition=manual`,
          );
          return result({ kind: 'manual_required', reason: 'credential_fill_unavailable' });
        }
        // 等满剩余的安定时长再复读，而不是每个节拍空转一次：安定与否只由「下一次观测到的
        // id 还是不是它」决定，中途多问几遍不会更早知道答案。期间凭据若又变了，下一拍的 id
        // 就会不同，安定从头计。
        const waited = await waitWithinBudget(Math.min(
          CREDENTIAL_SETTLE_MS - settledForMs,
          remainingBudgetMs(),
        ));
        if (waited) return waited;
        continue;
      }
    }

    if (probe.signal === 'totp_entry_ready') {
      if (!options.freshStartPolicyApplied) {
        return result({ kind: 'manual_required', reason: 'fresh_start_policy_unavailable' });
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
        if (actionResult) return asResult(actionResult);
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
      if (actionResult) return asResult(actionResult);
      continue;
    }

    if (probe.signal === 'totp_refresh_required') {
      if (!enteredWindow) {
        if (!options.freshStartPolicyApplied) {
          return result({
            kind: 'manual_required',
            reason: 'stale_totp_input_requires_fresh_start',
          });
        }
        if (!validServerEpochMs(probe.serverEpochMs)) {
          return result({ kind: 'failed', reason: 'facebook_server_time_unavailable' });
        }
        const recoveryWindow = windowFor(probe.serverEpochMs);
        const recoveryResult = await dispatchAction(
          probe,
          ACTION_FOR_SIGNAL.totp_refresh_required,
          {
            totpWindowStartUnixMs: recoveryWindow.startMs,
            totpWindowEndUnixMs: recoveryWindow.endMs,
          },
        );
        if (recoveryResult) return asResult(recoveryResult);
        continue;
      }
      const actionResult = await dispatchAction(
        probe,
        ACTION_FOR_SIGNAL.totp_refresh_required,
        {
          totpWindowStartUnixMs: enteredWindow.startMs,
          totpWindowEndUnixMs: enteredWindow.endMs,
        },
      );
      if (actionResult) return asResult(actionResult);
      enteredWindow = undefined;
      continue;
    }

    const actionResult = await dispatchAction(probe, ACTION_FOR_SIGNAL[probe.signal]);
    if (actionResult === STALE_LOGIN_SIGNAL) {
      // 凭据在下发的这一瞬又变了，引擎在派发点击之前就拒绝了 —— 没有任何输入发出。
      // 这不是结构性失败：重新探测一次就会拿到带新字符数的 signal id。有界重来，绝不落终态。
      staleLoginSignalRetries += 1;
      forgetLoginSettleState();
      if (staleLoginSignalRetries > MAX_STALE_LOGIN_SIGNAL_RETRIES) {
        return result({ kind: 'failed', reason: 'credential_fill_unsettled' });
      }
      log(
        '[facebook-auth] login submit refused on superseded credential fill '
        + `attempt=${staleLoginSignalRetries} disposition=reprobe`,
      );
      const waited = await waitWithinBudget(Math.min(pollIntervalMs, remainingBudgetMs()));
      if (waited) return waited;
      continue;
    }
    if (actionResult) return actionResult;
    if (probe.signal === 'suspension_appeal_start') {
      return result({
        kind: 'manual_required',
        reason: 'facebook_suspension_appeal_step_required',
      });
    }
    // Every confirmed action is followed by a fresh probe at the top of the next pass.
  }

  return result({ kind: 'failed', reason: 'facebook_auth_reconcile_limit' });
}
