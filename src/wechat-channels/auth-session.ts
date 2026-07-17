import type {
  InteractionAuthReasonCode,
  InteractionAuthStatus,
  InteractionBrowserState,
} from '../comm/protocol.js';
import type { WechatChannelsApiClient } from './api-client.js';
import type { WechatChannelsBrowserSidecar } from './browser-sidecar.js';
import { EncryptedWechatSessionStore, type WechatSessionBinding } from './encrypted-session-store.js';
import { WechatChannelsError, type WechatEndpointErrorCategory } from './error-classifier.js';
import type { WechatProbeOutcome } from './probes/black-box-probe.js';
import type { WechatIdentity, WechatSessionMaterial } from './types.js';

type RecoverableErrorCategory = Extract<
  WechatEndpointErrorCategory,
  'rate_limited' | 'transient_network' | 'permission_denied' | 'schema_changed'
>;
type RecoveryTimer = ReturnType<typeof setTimeout>;

export interface WechatAuthRecoveryBackoff {
  initialMs: number;
  maxMs: number;
}

export type LocalAuthState =
  | 'uninitialized'
  | 'browser_login_required'
  | 'browser_opening'
  | 'qr_waiting'
  | 'identity_verifying'
  | 'session_active'
  | 'browser_closing'
  | 'api_only_running'
  | 'browser_foreground_opening'
  | 'browser_open'
  | 'browser_foreground_closing'
  | 'reauth_required'
  | 'challenge_required'
  | 'degraded'
  | 'disabled';

export interface AuthSnapshot {
  state: LocalAuthState;
  status: InteractionAuthStatus;
  browserState: InteractionBrowserState;
  reasonCode: InteractionAuthReasonCode | null;
  accountId: string | null;
  identity: WechatIdentity | null;
  identityMatches: boolean;
  checkedAt: number;
}

export interface WechatAuthCoordinatorOptions {
  envKey: string;
  expectedAccountId?: string;
  api: WechatChannelsApiClient;
  sidecar: WechatChannelsBrowserSidecar;
  store?: EncryptedWechatSessionStore;
  probeEnabledReads: (session: WechatSessionMaterial) => Promise<WechatProbeOutcome>;
  loginTimeoutMs?: number;
  pollIntervalMs?: number;
  recoveryBackoff?: Partial<Record<RecoverableErrorCategory, Partial<WechatAuthRecoveryBackoff>>>;
  setTimeoutImpl?: (callback: () => void, ms: number) => RecoveryTimer;
  clearTimeoutImpl?: (timer: RecoveryTimer) => void;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  logImpl?: (message: string) => void;
}

export class WechatAuthCoordinator {
  private readonly envKey: string;
  private readonly expectedAccountId?: string;
  private readonly api: WechatChannelsApiClient;
  private readonly sidecar: WechatChannelsBrowserSidecar;
  private readonly store: EncryptedWechatSessionStore;
  private readonly probeEnabledReads: (session: WechatSessionMaterial) => Promise<WechatProbeOutcome>;
  private readonly loginTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly recoveryBackoff: Record<RecoverableErrorCategory, WechatAuthRecoveryBackoff>;
  private readonly setTimeoutImpl: (callback: () => void, ms: number) => RecoveryTimer;
  private readonly clearTimeoutImpl: (timer: RecoveryTimer) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly listeners = new Set<(snapshot: AuthSnapshot) => void>();
  private state: LocalAuthState = 'uninitialized';
  private reasonCode: InteractionAuthReasonCode | null = null;
  private accountId: string | null = null;
  private identity: WechatIdentity | null = null;
  private identityMatches = false;
  private session: WechatSessionMaterial | null = null;
  private checkedAt = 0;
  private authInFlight?: Promise<void>;
  private browserControlChain: Promise<void> = Promise.resolve();
  private manualBrowserVisible = false;
  private recoveryTimer?: RecoveryTimer;
  private recoveryInFlight?: Promise<void>;
  private recoveryCategory?: RecoverableErrorCategory;
  private recoveryDelayMs = 0;
  private recoveryGeneration = 0;

  constructor(options: WechatAuthCoordinatorOptions) {
    this.envKey = options.envKey;
    this.expectedAccountId = options.expectedAccountId;
    this.api = options.api;
    this.sidecar = options.sidecar;
    this.store = options.store ?? new EncryptedWechatSessionStore({ envKey: options.envKey, browserProfileId: options.sidecar.browserProfileId });
    this.probeEnabledReads = options.probeEnabledReads;
    this.loginTimeoutMs = positiveMs(options.loginTimeoutMs, 5 * 60_000);
    this.pollIntervalMs = positiveMs(options.pollIntervalMs, 2_000);
    this.recoveryBackoff = recoveryBackoffOptions(options.recoveryBackoff);
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? ((timer) => clearTimeout(timer));
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.nowImpl ?? Date.now;
    this.log = options.logImpl ?? ((message) => console.log(message));
  }

  onChange(listener: (snapshot: AuthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): AuthSnapshot {
    return {
      state: this.state,
      status: statusFor(this.state),
      browserState: this.sidecar.getState(),
      reasonCode: this.reasonCode,
      accountId: this.accountId,
      identity: this.identity,
      identityMatches: this.identityMatches,
      checkedAt: this.checkedAt || this.now(),
    };
  }

  getSession(): WechatSessionMaterial | null {
    return this.session;
  }

  async initialize(): Promise<void> {
    let stored: Awaited<ReturnType<EncryptedWechatSessionStore['load']>> = null;
    let loadFailureReason: InteractionAuthReasonCode | null = null;
    try {
      stored = await this.store.load(this.expectedAccountId);
    } catch (error) {
      const safe = error instanceof WechatChannelsError ? error : null;
      loadFailureReason = safe?.category === 'identity_mismatch' ? 'WECHAT_IDENTITY_MISMATCH' : 'WECHAT_AUTH_REQUIRED';
    }
    if (stored) {
      this.accountId = stored.binding.accountId;
      this.identity = stored.identity;
      this.session = stored.session;
      this.transition('identity_verifying', null);
      try {
        const observed = await this.api.getIdentity(stored.session);
        this.assertIdentity(observed, stored.binding);
        this.identity = observed;
        this.identityMatches = true;
        const probeOutcome = await this.probeEnabledReads(stored.session);
        if (!probeOutcome.ok) {
          this.applyProbeFailure(probeOutcome.reasonCode);
          return;
        }
        if (stored.legacyBindingMigrated) {
          await this.store.save({ binding: stored.binding, identity: observed, session: stored.session });
        }
        this.cancelRecovery();
        this.transition('api_only_running', null);
        return;
      } catch (error) {
        const safe = error instanceof WechatChannelsError
          ? error
          : new WechatChannelsError('transient_network', 'authData', 'Stored session verification failed temporarily', true);
        if (isRecoverableCategory(safe.category)) {
          this.markApiFailure(safe);
          return;
        }
        if (safe.category === 'identity_mismatch') {
          this.transition('reauth_required', 'WECHAT_IDENTITY_MISMATCH');
          return;
        } else if (safe.category === 'challenge_required') {
          this.transition('challenge_required', 'WECHAT_CHALLENGE_REQUIRED');
        } else {
          this.transition('reauth_required', 'WECHAT_AUTH_REQUIRED');
        }
      }
    } else {
      if (loadFailureReason === 'WECHAT_IDENTITY_MISMATCH') {
        this.transition('reauth_required', loadFailureReason);
        return;
      } else {
        this.transition('browser_login_required', 'WECHAT_AUTH_REQUIRED');
      }
    }
    await this.authenticateThroughBrowser();
  }

  async reopen(reason: 'user_requested' | 'auth_expired' | 'identity_mismatch' | 'challenge_required'): Promise<void> {
    this.cancelRecovery();
    if (reason === 'user_requested') this.manualBrowserVisible = false;
    if (reason === 'identity_mismatch') this.transition('reauth_required', 'WECHAT_IDENTITY_MISMATCH');
    else if (reason === 'challenge_required') this.transition('challenge_required', 'WECHAT_CHALLENGE_REQUIRED');
    else this.transition('reauth_required', 'WECHAT_AUTH_REQUIRED');
    await this.authenticateThroughBrowser();
  }

  async clear(): Promise<void> {
    this.cancelRecovery();
    this.manualBrowserVisible = false;
    this.session = null;
    this.identityMatches = false;
    await this.store.clear();
    this.transition('browser_login_required', 'WECHAT_AUTH_REQUIRED');
  }

  disable(): void {
    this.cancelRecovery();
    this.manualBrowserVisible = false;
    this.session = null;
    this.identityMatches = false;
    this.transition('disabled', 'INTERACTION_FEATURE_DISABLED');
  }

  markApiFailure(error: WechatChannelsError): void {
    if (error.category === 'auth_expired') {
      this.cancelRecovery();
      this.identityMatches = false;
      this.transition('reauth_required', 'WECHAT_AUTH_REQUIRED');
      void this.authenticateThroughBrowser().catch(() => undefined);
    } else if (error.category === 'challenge_required') {
      this.cancelRecovery();
      this.identityMatches = false;
      this.transition('challenge_required', 'WECHAT_CHALLENGE_REQUIRED');
      void this.authenticateThroughBrowser().catch(() => undefined);
    } else if (error.category === 'identity_mismatch') {
      this.cancelRecovery();
      this.identityMatches = false;
      // A session for another finder can never heal by retrying it. Customer re-login is the
      // only recovery path without an automatic retry timer (apart from explicit disablement).
      this.transition('reauth_required', 'WECHAT_IDENTITY_MISMATCH');
    } else if (error.category === 'rate_limited') {
      this.transition('degraded', 'WECHAT_RATE_LIMITED');
      this.scheduleRecovery(error);
    } else if (error.category === 'schema_changed') {
      this.transition('degraded', 'WECHAT_SCHEMA_CHANGED');
      this.scheduleRecovery(error);
    } else if (error.category === 'permission_denied') {
      this.transition('degraded', 'WECHAT_PERMISSION_DENIED');
      this.scheduleRecovery(error);
    } else if (error.category === 'transient_network') {
      this.transition('degraded', 'INTERACTION_UPSTREAM_UNAVAILABLE');
      this.scheduleRecovery(error);
    }
  }

  private applyProbeFailure(reasonCode: InteractionAuthReasonCode): WechatChannelsError {
    const error = probeFailureError(reasonCode);
    if (reasonCode === 'INTERACTION_FEATURE_DISABLED') {
      this.disable();
    } else {
      this.markApiFailure(error);
    }
    return error;
  }

  private scheduleRecovery(error: WechatChannelsError, advance = false): void {
    if (!isRecoverableCategory(error.category) || this.state === 'disabled' || !this.session || !this.identity) return;
    const category = error.category;
    const sameCategory = this.recoveryCategory === category;
    if (this.recoveryTimer && sameCategory && !advance) return;
    if (this.recoveryTimer) {
      this.clearTimeoutImpl(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }

    const limits = this.recoveryBackoff[category];
    const retryAfterMs = category === 'rate_limited' && error.retryAfterMs !== null &&
      Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0
      ? Math.max(1, Math.floor(error.retryAfterMs))
      : null;
    const initial = Math.min(limits.maxMs, retryAfterMs ?? limits.initialMs);
    const delayMs = sameCategory && advance && this.recoveryDelayMs > 0
      ? Math.min(limits.maxMs, Math.max(limits.initialMs, this.recoveryDelayMs * 2))
      : initial;
    this.recoveryCategory = category;
    this.recoveryDelayMs = delayMs;
    this.armRecoveryTimer(delayMs);
    this.log(`[wechat-channels] scheduled ${category} auth recovery in ${delayMs}ms`);
  }

  private armRecoveryTimer(delayMs: number): void {
    const generation = this.recoveryGeneration;
    let timer: RecoveryTimer;
    timer = this.setTimeoutImpl(() => {
      if (this.recoveryTimer === timer) this.recoveryTimer = undefined;
      if (!this.isRecoveryCurrent(generation)) return;
      if (this.recoveryInFlight) {
        this.armRecoveryTimer(Math.max(1, this.recoveryDelayMs));
        return;
      }
      const attempt = this.runRecoveryAttempt(generation);
      this.recoveryInFlight = attempt;
      void attempt.finally(() => {
        if (this.recoveryInFlight === attempt) this.recoveryInFlight = undefined;
      });
    }, delayMs);
    this.recoveryTimer = timer;
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
  }

  private async runRecoveryAttempt(generation: number): Promise<void> {
    const session = this.session;
    const expectedIdentity = this.identity?.externalId;
    if (!session || !expectedIdentity || !this.isRecoveryCurrent(generation)) return;
    try {
      const observed = await this.api.getIdentity(session);
      if (!this.isRecoveryCurrent(generation)) return;
      if (observed.externalId !== expectedIdentity) {
        throw new WechatChannelsError('identity_mismatch', 'authData', 'Active session belongs to another account', false);
      }
      const outcome = await this.probeEnabledReads(session);
      if (!this.isRecoveryCurrent(generation)) return;
      if (!outcome.ok) throw probeFailureError(outcome.reasonCode);

      const accountId = this.accountId ?? this.expectedAccountId ?? this.envKey;
      await this.store.save({
        binding: {
          envKey: this.envKey,
          accountId,
          finderIdentity: observed.externalId,
          browserProfileId: this.sidecar.browserProfileId,
        },
        identity: observed,
        session,
      });
      if (!this.isRecoveryCurrent(generation)) return;
      this.accountId = accountId;
      this.identity = observed;
      this.identityMatches = true;
      if (!this.manualBrowserVisible && this.sidecar.getState() !== 'closed') {
        this.transition('browser_closing', null);
        await this.sidecar.close();
        if (!this.isRecoveryCurrent(generation)) return;
      }
      this.cancelRecovery();
      this.transition(this.manualBrowserVisible ? 'browser_open' : 'api_only_running', null);
      this.log('[wechat-channels] degraded auth session recovered without opening the browser');
    } catch (error) {
      if (!this.isRecoveryCurrent(generation)) return;
      const safe = error instanceof WechatChannelsError
        ? error
        : new WechatChannelsError('transient_network', 'auth_recovery', 'Auth recovery failed before a trustworthy result was available', true);
      if (isRecoverableCategory(safe.category)) {
        this.transition('degraded', authReasonForRecoverable(safe.category));
        this.scheduleRecovery(safe, true);
      } else {
        this.markApiFailure(safe);
      }
    }
  }

  private cancelRecovery(): void {
    this.recoveryGeneration += 1;
    if (this.recoveryTimer) this.clearTimeoutImpl(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryCategory = undefined;
    this.recoveryDelayMs = 0;
  }

  private isRecoveryCurrent(generation: number): boolean {
    return generation === this.recoveryGeneration && this.state !== 'disabled';
  }

  async verifyIdentity(): Promise<boolean> {
    if (!this.session || !this.identity) return false;
    try {
      const observed = await this.api.getIdentity(this.session);
      if (observed.externalId !== this.identity.externalId) {
        throw new WechatChannelsError('identity_mismatch', 'authData', 'Active session belongs to another account', false);
      }
      this.identity = observed;
      this.identityMatches = true;
      this.checkedAt = this.now();
      return true;
    } catch (error) {
      const safe = error instanceof WechatChannelsError
        ? error
        : new WechatChannelsError('transient_network', 'authData', 'Identity verification failed', true);
      this.markApiFailure(safe);
      return false;
    }
  }

  controlBrowser(action: 'open' | 'close'): Promise<void> {
    const execution = this.browserControlChain.then(() => this.runBrowserControl(action));
    this.browserControlChain = execution.catch(() => undefined);
    return execution;
  }

  private async runBrowserControl(action: 'open' | 'close'): Promise<void> {
    if (statusFor(this.state) !== 'active' || !this.session || !this.identity || !this.identityMatches) {
      throw new WechatChannelsError(
        'invalid_command',
        'browser_control',
        'Browser foreground control requires an active identity-bound API session',
        false,
      );
    }

    if (action === 'open') {
      this.manualBrowserVisible = true;
      if (this.sidecar.getState() === 'open') {
        this.transition('browser_open', null);
        return;
      }
      try {
        const opening = this.sidecar.open();
        this.transition('browser_foreground_opening', null);
        await opening;
        this.transition('browser_open', null);
        this.log('[wechat-channels] browser foreground opened by customer request; API session remains active');
      } catch (error) {
        this.manualBrowserVisible = false;
        this.transition('api_only_running', null);
        throw error;
      }
      return;
    }

    this.manualBrowserVisible = false;
    if (this.sidecar.getState() === 'closed') {
      this.transition('api_only_running', null);
      return;
    }
    try {
      const closing = this.sidecar.close();
      this.transition('browser_foreground_closing', null);
      await closing;
      this.transition('api_only_running', null);
      this.log('[wechat-channels] browser returned to API-only background operation by customer request');
    } catch (error) {
      this.transition('api_only_running', null);
      throw error;
    }
  }

  private authenticateThroughBrowser(): Promise<void> {
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.runBrowserAuthentication().finally(() => {
      this.authInFlight = undefined;
    });
    return this.authInFlight;
  }

  private async runBrowserAuthentication(): Promise<void> {
    this.transition('browser_opening', this.reasonCode);
    await this.sidecar.open();
    this.transition('qr_waiting', this.reasonCode);
    const deadline = this.now() + this.loginTimeoutMs;
    for (;;) {
      if (this.now() >= deadline) {
        this.transition('browser_login_required', 'WECHAT_AUTH_REQUIRED');
        throw new WechatChannelsError('auth_expired', 'browser_login', 'Timed out waiting for local QR login', false);
      }
      const candidate = await this.sidecar.readSessionCandidate();
      if (!candidate) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      this.transition('identity_verifying', null);
      let observed: WechatIdentity;
      try {
        observed = await this.api.getIdentity(candidate);
      } catch (error) {
        const safe = error instanceof WechatChannelsError ? error : null;
        if (safe?.category === 'challenge_required') {
          this.transition('challenge_required', 'WECHAT_CHALLENGE_REQUIRED');
          throw safe;
        }
        this.transition('qr_waiting', 'WECHAT_AUTH_REQUIRED');
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      const expectedIdentity = this.identity?.externalId ?? null;
      if (expectedIdentity && observed.externalId !== expectedIdentity) {
        this.identityMatches = false;
        this.transition('reauth_required', 'WECHAT_IDENTITY_MISMATCH');
        throw new WechatChannelsError('identity_mismatch', 'authData', 'Local browser is logged into another account', false);
      }
      const accountId = this.expectedAccountId ?? this.accountId ?? this.envKey;
      const binding: WechatSessionBinding = {
        envKey: this.envKey,
        accountId,
        finderIdentity: observed.externalId,
        browserProfileId: this.sidecar.browserProfileId,
      };
      this.accountId = accountId;
      this.identity = observed;
      this.session = candidate;
      this.identityMatches = true;
      const probeOutcome = await this.probeEnabledReads(candidate);
      if (!probeOutcome.ok) {
        throw this.applyProbeFailure(probeOutcome.reasonCode);
      }
      await this.store.save({ binding, identity: observed, session: candidate });
      this.cancelRecovery();
      this.transition('session_active', null);
      if (this.manualBrowserVisible) {
        this.transition('browser_open', null);
        this.log('[wechat-channels] encrypted API session active; browser remains open by customer request');
        return;
      }
      this.transition('browser_closing', null);
      await this.sidecar.close();
      this.transition('api_only_running', null);
      this.log('[wechat-channels] encrypted API session active; browser is no longer required');
      return;
    }
  }

  private assertIdentity(observed: WechatIdentity, binding: WechatSessionBinding): void {
    if (
      observed.externalId !== binding.finderIdentity ||
      (this.expectedAccountId && binding.accountId !== this.expectedAccountId)
    ) {
      throw new WechatChannelsError('identity_mismatch', 'authData', 'Stored session identity mismatch', false);
    }
  }

  private transition(state: LocalAuthState, reasonCode: InteractionAuthReasonCode | null): void {
    this.state = state;
    this.reasonCode = reasonCode;
    this.checkedAt = this.now();
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}

function statusFor(state: LocalAuthState): InteractionAuthStatus {
  switch (state) {
    case 'uninitialized':
    case 'browser_login_required': return 'login_required';
    case 'browser_opening':
    case 'qr_waiting':
    case 'identity_verifying': return 'authenticating';
    case 'session_active':
    case 'browser_closing':
    case 'api_only_running':
    case 'browser_foreground_opening':
    case 'browser_open':
    case 'browser_foreground_closing': return 'active';
    case 'reauth_required': return 'reauth_required';
    case 'challenge_required': return 'challenge_required';
    case 'degraded': return 'degraded';
    case 'disabled': return 'disabled';
  }
}

function probeFailureError(reasonCode: InteractionAuthReasonCode): WechatChannelsError {
  switch (reasonCode) {
    case 'WECHAT_AUTH_REQUIRED':
      return new WechatChannelsError('auth_expired', 'read_probe', 'Enabled read probe requires authentication', false);
    case 'WECHAT_CHALLENGE_REQUIRED':
      return new WechatChannelsError('challenge_required', 'read_probe', 'Enabled read probe requires browser verification', false);
    case 'WECHAT_IDENTITY_MISMATCH':
      return new WechatChannelsError('identity_mismatch', 'read_probe', 'Enabled read probe observed another finder identity', false);
    case 'WECHAT_RATE_LIMITED':
      return new WechatChannelsError('rate_limited', 'read_probe', 'Enabled read probe was rate limited', true);
    case 'WECHAT_PERMISSION_DENIED':
      return new WechatChannelsError('permission_denied', 'read_probe', 'Enabled read probe was denied', false);
    case 'WECHAT_SCHEMA_CHANGED':
      return new WechatChannelsError('schema_changed', 'read_probe', 'Enabled read probe observed schema drift', false);
    case 'INTERACTION_FEATURE_DISABLED':
      return new WechatChannelsError('permission_denied', 'read_probe', 'Interaction feature is disabled', false);
    case 'INTERACTION_UPSTREAM_UNAVAILABLE':
      return new WechatChannelsError('transient_network', 'read_probe', 'Enabled read probe upstream is unavailable', true);
  }
}

function isRecoverableCategory(category: WechatEndpointErrorCategory): category is RecoverableErrorCategory {
  return category === 'rate_limited' || category === 'transient_network' ||
    category === 'permission_denied' || category === 'schema_changed';
}

function authReasonForRecoverable(category: RecoverableErrorCategory): InteractionAuthReasonCode {
  switch (category) {
    case 'rate_limited': return 'WECHAT_RATE_LIMITED';
    case 'transient_network': return 'INTERACTION_UPSTREAM_UNAVAILABLE';
    case 'permission_denied': return 'WECHAT_PERMISSION_DENIED';
    case 'schema_changed': return 'WECHAT_SCHEMA_CHANGED';
  }
}

function recoveryBackoffOptions(
  overrides: WechatAuthCoordinatorOptions['recoveryBackoff'],
): Record<RecoverableErrorCategory, WechatAuthRecoveryBackoff> {
  const defaults: Record<RecoverableErrorCategory, WechatAuthRecoveryBackoff> = {
    rate_limited: { initialMs: 30_000, maxMs: 5 * 60_000 },
    transient_network: { initialMs: 5_000, maxMs: 2 * 60_000 },
    permission_denied: { initialMs: 5 * 60_000, maxMs: 30 * 60_000 },
    schema_changed: { initialMs: 10 * 60_000, maxMs: 60 * 60_000 },
  };
  for (const category of Object.keys(defaults) as RecoverableErrorCategory[]) {
    const initialMs = positiveMs(overrides?.[category]?.initialMs, defaults[category].initialMs);
    const maxMs = positiveMs(overrides?.[category]?.maxMs, defaults[category].maxMs);
    defaults[category] = { initialMs: Math.min(initialMs, maxMs), maxMs };
  }
  return defaults;
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
