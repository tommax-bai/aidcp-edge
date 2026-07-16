import type {
  InteractionAuthReasonCode,
  InteractionAuthStatus,
  InteractionBrowserState,
} from '../comm/protocol.js';
import type { WechatChannelsApiClient } from './api-client.js';
import type { WechatChannelsBrowserSidecar } from './browser-sidecar.js';
import { EncryptedWechatSessionStore, type WechatSessionBinding } from './encrypted-session-store.js';
import { WechatChannelsError } from './error-classifier.js';
import type { WechatIdentity, WechatSessionMaterial } from './types.js';

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
  probeEnabledReads: (session: WechatSessionMaterial) => Promise<boolean>;
  loginTimeoutMs?: number;
  pollIntervalMs?: number;
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
  private readonly probeEnabledReads: (session: WechatSessionMaterial) => Promise<boolean>;
  private readonly loginTimeoutMs: number;
  private readonly pollIntervalMs: number;
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

  constructor(options: WechatAuthCoordinatorOptions) {
    this.envKey = options.envKey;
    this.expectedAccountId = options.expectedAccountId;
    this.api = options.api;
    this.sidecar = options.sidecar;
    this.store = options.store ?? new EncryptedWechatSessionStore({ envKey: options.envKey, browserProfileId: options.sidecar.browserProfileId });
    this.probeEnabledReads = options.probeEnabledReads;
    this.loginTimeoutMs = positiveMs(options.loginTimeoutMs, 5 * 60_000);
    this.pollIntervalMs = positiveMs(options.pollIntervalMs, 2_000);
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
        const probeOk = await this.probeEnabledReads(stored.session);
        if (!probeOk) {
          this.transition('degraded', 'WECHAT_SCHEMA_CHANGED');
          return;
        }
        if (stored.legacyBindingMigrated) {
          await this.store.save({ binding: stored.binding, identity: observed, session: stored.session });
        }
        this.transition('api_only_running', null);
        return;
      } catch (error) {
        const safe = error instanceof WechatChannelsError ? error : null;
        if (safe?.category === 'identity_mismatch') {
          this.transition('reauth_required', 'WECHAT_IDENTITY_MISMATCH');
        } else if (safe?.category === 'challenge_required') {
          this.transition('challenge_required', 'WECHAT_CHALLENGE_REQUIRED');
        } else {
          this.transition('reauth_required', 'WECHAT_AUTH_REQUIRED');
        }
      }
    } else {
      if (loadFailureReason === 'WECHAT_IDENTITY_MISMATCH') {
        this.transition('reauth_required', loadFailureReason);
      } else {
        this.transition('browser_login_required', 'WECHAT_AUTH_REQUIRED');
      }
    }
    await this.authenticateThroughBrowser();
  }

  async reopen(reason: 'user_requested' | 'auth_expired' | 'identity_mismatch' | 'challenge_required'): Promise<void> {
    if (reason === 'user_requested') this.manualBrowserVisible = false;
    if (reason === 'identity_mismatch') this.transition('reauth_required', 'WECHAT_IDENTITY_MISMATCH');
    else if (reason === 'challenge_required') this.transition('challenge_required', 'WECHAT_CHALLENGE_REQUIRED');
    else this.transition('reauth_required', 'WECHAT_AUTH_REQUIRED');
    await this.authenticateThroughBrowser();
  }

  async clear(): Promise<void> {
    this.manualBrowserVisible = false;
    this.session = null;
    this.identityMatches = false;
    await this.store.clear();
    this.transition('browser_login_required', 'WECHAT_AUTH_REQUIRED');
  }

  disable(): void {
    this.manualBrowserVisible = false;
    this.session = null;
    this.identityMatches = false;
    this.transition('disabled', 'INTERACTION_FEATURE_DISABLED');
  }

  markApiFailure(error: WechatChannelsError): void {
    if (error.category === 'auth_expired') {
      this.identityMatches = false;
      this.transition('reauth_required', 'WECHAT_AUTH_REQUIRED');
      void this.authenticateThroughBrowser().catch(() => undefined);
    } else if (error.category === 'challenge_required') {
      this.identityMatches = false;
      this.transition('challenge_required', 'WECHAT_CHALLENGE_REQUIRED');
      void this.authenticateThroughBrowser().catch(() => undefined);
    } else if (error.category === 'identity_mismatch') {
      this.identityMatches = false;
      this.transition('reauth_required', 'WECHAT_IDENTITY_MISMATCH');
      void this.authenticateThroughBrowser().catch(() => undefined);
    } else if (error.category === 'rate_limited') {
      this.transition('degraded', 'WECHAT_RATE_LIMITED');
    } else if (error.category === 'schema_changed') {
      this.transition('degraded', 'WECHAT_SCHEMA_CHANGED');
    } else if (error.category === 'permission_denied') {
      this.transition('degraded', 'WECHAT_PERMISSION_DENIED');
    } else if (error.category === 'transient_network') {
      this.transition('degraded', 'INTERACTION_UPSTREAM_UNAVAILABLE');
    }
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
      const probeOk = await this.probeEnabledReads(candidate);
      if (!probeOk) {
        this.transition('degraded', 'WECHAT_SCHEMA_CHANGED');
        throw new WechatChannelsError('schema_changed', 'read_probe', 'Enabled read probes did not establish a safe API session', false);
      }
      await this.store.save({ binding, identity: observed, session: candidate });
      this.accountId = accountId;
      this.identity = observed;
      this.session = candidate;
      this.identityMatches = true;
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

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
