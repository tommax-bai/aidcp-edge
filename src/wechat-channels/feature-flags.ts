import type { InteractionEffectiveCapabilities } from '../comm/protocol.js';
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
  interactionEnabled: false,
  accountKillSwitch: false,
  writeEnabled: false,
  accountWriteEnabled: false,
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

export function wechatChannelsFeatureFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): WechatChannelsFeatureFlags {
  return {
    interactionEnabled: enabled(env.AIDCP_WECHAT_INTERACTION_ENABLED),
    accountKillSwitch: enabled(env.AIDCP_WECHAT_ACCOUNT_KILL_SWITCH),
    writeEnabled: enabled(env.AIDCP_WECHAT_WRITE_ENABLED),
    accountWriteEnabled: enabled(env.AIDCP_WECHAT_ACCOUNT_WRITE_ENABLED),
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

  effective(params: { authActive: boolean; identityMatches: boolean }): InteractionEffectiveCapabilities {
    const base =
      this.flags.interactionEnabled &&
      !this.flags.accountKillSwitch &&
      params.authActive &&
      params.identityMatches;
    const commentsRead =
      base &&
      this.flags.commentsReadEnabled &&
      this.passedProbes.has('commentsRead') &&
      this.breaker.capabilityAvailable('commentsRead');
    const dmRead =
      base &&
      this.flags.dmReadEnabled &&
      this.passedProbes.has('dmRead') &&
      this.breaker.capabilityAvailable('dmRead');
    const writeBase = base && this.flags.writeEnabled && this.flags.accountWriteEnabled && !this.flags.accountWriteKillSwitch;
    return {
      commentsRead,
      commentsReply:
        writeBase &&
        commentsRead &&
        this.flags.commentsReplyEnabled &&
        this.flags.commentWriteProbeVerified &&
        this.passedProbes.has('commentsReply') &&
        this.breaker.capabilityAvailable('commentsReply'),
      dmRead,
      dmSendText:
        writeBase &&
        dmRead &&
        this.flags.dmSendTextEnabled &&
        this.flags.dmWriteProbeVerified &&
        this.passedProbes.has('dmSendText') &&
        this.breaker.capabilityAvailable('dmSendText'),
      dmSendImage: false,
    };
  }
}
