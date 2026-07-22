import type { InteractionEffectiveCapabilities, InteractionRuntimeControlsPayload } from '../comm/protocol.js';
import type { WechatChannelsEndpoint } from './api-client.js';

export type WechatCapability = 'commentsRead' | 'commentsReply' | 'dmRead' | 'dmSendText';

const ENDPOINT_CAPABILITIES: Record<WechatChannelsEndpoint, readonly WechatCapability[]> = {
  authLoginCode: [],
  authLoginStatus: [],
  authData: ['commentsRead', 'commentsReply', 'dmRead', 'dmSendText'],
  postList: ['commentsRead', 'commentsReply'],
  commentList: ['commentsRead', 'commentsReply'],
  commentCreate: ['commentsReply'],
  dmLoginCookie: ['dmRead', 'dmSendText'],
  dmNewMessages: ['dmRead', 'dmSendText'],
  dmHistory: ['dmRead', 'dmSendText'],
  dmSessionInfo: ['dmRead', 'dmSendText'],
  dmSendText: ['dmSendText'],
  dmUploadMedia: [],
};

/** A schema break opens only the affected endpoint/capability circuit. */
export class WechatEndpointCircuitBreaker {
  private readonly openedAt = new Map<WechatChannelsEndpoint, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; nowImpl?: () => number } = {}) {
    this.ttlMs = positiveMs(options.ttlMs, 10 * 60_000);
    this.now = options.nowImpl ?? Date.now;
  }

  open(endpoint: WechatChannelsEndpoint): void {
    this.openedAt.set(endpoint, this.now());
  }

  close(endpoint: WechatChannelsEndpoint): void {
    this.openedAt.delete(endpoint);
  }

  reset(): void {
    this.openedAt.clear();
  }

  isOpen(endpoint: WechatChannelsEndpoint): boolean {
    const openedAt = this.openedAt.get(endpoint);
    if (openedAt === undefined) return false;
    if (this.now() - openedAt < this.ttlMs) return true;
    this.openedAt.delete(endpoint);
    return false;
  }

  capabilityAvailable(capability: WechatCapability): boolean {
    for (const endpoint of this.openedAt.keys()) {
      if (this.isOpen(endpoint) && ENDPOINT_CAPABILITIES[endpoint].includes(capability)) return false;
    }
    return true;
  }

  snapshot(): WechatChannelsEndpoint[] {
    return [...this.openedAt.keys()].filter((endpoint) => this.isOpen(endpoint)).sort();
  }
}

export class WechatCapabilityState {
  private readonly passedProbes = new Set<WechatCapability>();
  private remoteControls?: InteractionRuntimeControlsPayload;

  constructor(readonly breaker: WechatEndpointCircuitBreaker) {}

  markProbePassed(capability: WechatCapability): void {
    this.passedProbes.add(capability);
  }

  clearProbe(capability: WechatCapability): void {
    this.passedProbes.delete(capability);
  }

  resetRemoteControls(): void {
    this.remoteControls = undefined;
  }

  applyRemoteControls(
    controls: InteractionRuntimeControlsPayload,
    scope: { accountId: string; envKey: string },
  ): boolean {
    if (controls.accountId !== scope.accountId || controls.envKey !== scope.envKey ||
        !Number.isInteger(controls.version) || controls.version < 0 ||
        typeof controls.commentsReadEnabled !== 'boolean' ||
        typeof controls.commentsReplyEnabled !== 'boolean' ||
        typeof controls.dmReadEnabled !== 'boolean' ||
        typeof controls.dmSendTextEnabled !== 'boolean' ||
        controls.dmSendImageEnabled !== false) return false;
    if (this.remoteControls && controls.version < this.remoteControls.version) return false;
    if (this.remoteControls && controls.version === this.remoteControls.version) {
      return controls.accountId === this.remoteControls.accountId &&
        controls.envKey === this.remoteControls.envKey &&
        controls.commentsReadEnabled === this.remoteControls.commentsReadEnabled &&
        controls.commentsReplyEnabled === this.remoteControls.commentsReplyEnabled &&
        controls.dmReadEnabled === this.remoteControls.dmReadEnabled &&
        controls.dmSendTextEnabled === this.remoteControls.dmSendTextEnabled &&
        controls.dmSendImageEnabled === this.remoteControls.dmSendImageEnabled;
    }
    this.remoteControls = { ...controls };
    return true;
  }

  getRemoteControls(): InteractionRuntimeControlsPayload | undefined {
    return this.remoteControls ? { ...this.remoteControls } : undefined;
  }

  effective(params: { authActive: boolean; identityMatches: boolean }): InteractionEffectiveCapabilities {
    const remote = this.remoteControls;
    const base =
      !!remote &&
      params.authActive &&
      params.identityMatches;
    const commentsRead =
      base &&
      !!remote?.commentsReadEnabled &&
      this.passedProbes.has('commentsRead') &&
      this.breaker.capabilityAvailable('commentsRead');
    const dmRead =
      base &&
      !!remote?.dmReadEnabled &&
      this.passedProbes.has('dmRead') &&
      this.breaker.capabilityAvailable('dmRead');
    return {
      commentsRead,
      commentsReply:
        base &&
        commentsRead &&
        !!remote?.commentsReplyEnabled &&
        this.breaker.capabilityAvailable('commentsReply'),
      dmRead,
      dmSendText:
        base &&
        dmRead &&
        !!remote?.dmSendTextEnabled &&
        this.breaker.capabilityAvailable('dmSendText'),
      dmSendImage: false,
    };
  }
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
