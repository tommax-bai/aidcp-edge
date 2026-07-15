import { facebookPlatformDriver } from '../facebook/driver.js';
import { wechatChannelsPlatformDriver } from '../wechat-channels/driver.js';
import { xhsPlatformDriver } from '../xhs/driver.js';
import { normalizePlatformId, type PlatformDriver, type PlatformId } from './driver.js';

/** Mirrors cloud admission metadata for client-side affordances only; cloud remains authoritative. */
export type DelegatedAction =
  | 'comment_batch'
  | 'publish_post'
  | 'publish_from_inspiration'
  | 'comment_curated'
  | 'generate_candidates'
  | 'approve_candidate'
  | 'reject_candidate'
  | 'modify_candidate'
  | 'facebook_group_comment';

export type DelegatedActionSupport =
  | { level: 'supported' }
  | { level: 'beta' | 'unsupported'; reason: string; runtimeGate?: string };

const XHS_DELEGATED_ACTIONS: Record<DelegatedAction, DelegatedActionSupport> = {
  comment_batch: { level: 'supported' },
  publish_post: { level: 'supported' },
  publish_from_inspiration: { level: 'supported' },
  comment_curated: { level: 'supported' },
  generate_candidates: { level: 'supported' },
  approve_candidate: { level: 'supported' },
  reject_candidate: { level: 'supported' },
  modify_candidate: { level: 'supported' },
  facebook_group_comment: { level: 'unsupported', reason: 'facebook_only' },
};

const FACEBOOK_DELEGATED_ACTIONS: Record<DelegatedAction, DelegatedActionSupport> = {
  comment_batch: {
    level: 'beta',
    reason: 'configured_targets_only',
    runtimeGate: 'AIDCP_FB_COMMENT_AUTO',
  },
  publish_post: {
    level: 'beta',
    reason: 'real_machine_and_client_capability_gate',
    runtimeGate: 'facebook_publish_capability',
  },
  publish_from_inspiration: {
    level: 'unsupported',
    reason: 'facebook_creation_template_language_media_strategy_not_ready',
  },
  comment_curated: { level: 'unsupported', reason: 'arbitrary_facebook_post_targeting_not_supported' },
  generate_candidates: { level: 'beta', reason: 'facebook_publish_template_beta' },
  approve_candidate: { level: 'beta', reason: 'facebook_publish_delivery_beta' },
  reject_candidate: { level: 'beta', reason: 'facebook_publish_delivery_beta' },
  modify_candidate: { level: 'beta', reason: 'facebook_publish_delivery_beta' },
  facebook_group_comment: {
    level: 'beta',
    reason: 'configured_or_owned_group_targets_only',
    runtimeGate: 'AIDCP_FB_GROUP_JOIN_AUTO',
  },
};

export const DELEGATED_ACTIONS_BY_PLATFORM: Record<PlatformId, Record<DelegatedAction, DelegatedActionSupport>> = {
  xiaohongshu: XHS_DELEGATED_ACTIONS,
  facebook: FACEBOOK_DELEGATED_ACTIONS,
};

export const PLATFORM_DRIVERS: Partial<Record<PlatformId, PlatformDriver>> = {
  facebook: facebookPlatformDriver,
  wechat_channels: wechatChannelsPlatformDriver,
  xiaohongshu: xhsPlatformDriver,
};

export function selectPlatformDriver(opts: { env?: NodeJS.ProcessEnv } = {}): PlatformDriver {
  const platform = normalizePlatformId(opts.env?.AIDCP_PLATFORM);
  const driver = PLATFORM_DRIVERS[platform];
  if (!driver) {
    throw new Error(`[aidcp-edge] platform=${platform} is recognized but has no edge driver in this build`);
  }
  return driver;
}

export function delegatedActionSupportForPlatform(
  platform: string | null | undefined,
  action: DelegatedAction,
): DelegatedActionSupport {
  return DELEGATED_ACTIONS_BY_PLATFORM[normalizePlatformId(platform ?? undefined)][action];
}
