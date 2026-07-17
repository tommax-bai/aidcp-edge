import type { InteractionEffectiveCapabilities, InteractionRuntimeControlsPayload } from '../comm/protocol.js';
import type { WechatChannelsEndpoint } from './api-client.js';

export type WechatCapability = 'commentsRead' | 'commentsReply' | 'dmRead' | 'dmSendText';

export interface WechatChannelsFeatureFlags {
  interactionEnabled: boolean;
  accountKillSwitch: boolean;
  writeEnabled: boolean;
  accountWriteEnabled: boolean;
  accountWriteKillSwitch: boolean;
  commentsReadEnabled: boolean;
  commentsReplyEnabled: boolean;
  dmReadEnabled: boolean;
  dmSendTextEnabled: boolean;
  commentWriteProbeVerified: boolean;
  dmWriteProbeVerified: boolean;
}

export const DEFAULT_WECHAT_CHANNELS_FEATURE_FLAGS: WechatChannelsFeatureFlags = {
  interactionEnabled: true,
  accountKillSwitch: false,
  writeEnabled: true,
  accountWriteEnabled: true,
  accountWriteKillSwitch: false,
  commentsReadEnabled: false,
  commentsReplyEnabled: false,
  dmReadEnabled: false,
  dmSendTextEnabled: false,
  commentWriteProbeVerified: false,
  dmWriteProbeVerified: false,
};

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function enabledByDefault(value: string | undefined): boolean {
  if (value === undefined || !value.trim()) return true;
  return enabled(value);
}

export function wechatChannelsFeatureFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): WechatChannelsFeatureFlags {
  return {
    interactionEnabled: enabledByDefault(env.AIDCP_WECHAT_INTERACTION_ENABLED),
    accountKillSwitch: enabled(env.AIDCP_WECHAT_ACCOUNT_KILL_SWITCH),
    writeEnabled: enabledByDefault(env.AIDCP_WECHAT_WRITE_ENABLED),
    // Deprecated as an authorization grant. Cloud account controls are authoritative.
    accountWriteEnabled: true,
    accountWriteKillSwitch: enabled(env.AIDCP_WECHAT_ACCOUNT_WRITE_KILL_SWITCH),
    commentsReadEnabled: enabled(env.AIDCP_WECHAT_COMMENTS_READ_ENABLED),
    commentsReplyEnabled: enabled(env.AIDCP_WECHAT_COMMENTS_REPLY_ENABLED),
    dmReadEnabled: enabled(env.AIDCP_WECHAT_DM_READ_ENABLED),
    dmSendTextEnabled: enabled(env.AIDCP_WECHAT_DM_SEND_TEXT_ENABLED),
    commentWriteProbeVerified: enabled(env.AIDCP_WECHAT_COMMENT_WRITE_PROBE_VERIFIED),
    dmWriteProbeVerified: enabled(env.AIDCP_WECHAT_DM_WRITE_PROBE_VERIFIED),
  };
}

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
  private readonly openEndpoints = new Set<WechatChannelsEndpoint>();

  open(endpoint: WechatChannelsEndpoint): void {
    this.openEndpoints.add(endpoint);
  }

  isOpen(endpoint: WechatChannelsEndpoint): boolean {
    return this.openEndpoints.has(endpoint);
  }

  capabilityAvailable(capability: WechatCapability): boolean {
    for (const endpoint of this.openEndpoints) {
      if (ENDPOINT_CAPABILITIES[endpoint].includes(capability)) return false;
    }
    return true;
  }

  snapshot(): WechatChannelsEndpoint[] {
    return [...this.openEndpoints].sort();
  }
}

export class WechatCapabilityState {
  private readonly passedProbes = new Set<WechatCapability>();
  private remoteControls?: InteractionRuntimeControlsPayload;

  constructor(
    readonly flags: WechatChannelsFeatureFlags,
    readonly breaker: WechatEndpointCircuitBreaker,
  ) {}

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
      this.flags.interactionEnabled &&
      !this.flags.accountKillSwitch &&
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
    const writeBase = base && this.flags.writeEnabled && !this.flags.accountWriteKillSwitch;
    return {
      commentsRead,
      commentsReply:
        writeBase &&
        commentsRead &&
        !!remote?.commentsReplyEnabled &&
        this.flags.commentWriteProbeVerified &&
        this.passedProbes.has('commentsReply') &&
        this.breaker.capabilityAvailable('commentsReply'),
      dmRead,
      dmSendText:
        writeBase &&
        dmRead &&
        !!remote?.dmSendTextEnabled &&
        this.flags.dmWriteProbeVerified &&
        this.passedProbes.has('dmSendText') &&
        this.breaker.capabilityAvailable('dmSendText'),
      dmSendImage: false,
    };
  }
}
