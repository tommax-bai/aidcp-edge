import type { BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayMonitor } from '../browse/overlay-monitor.js';
import type {
  IdentityDecision,
  ReadSelfIdentityOptions,
  SelfIdentityResult,
} from '../cdp/self-identity.js';

export const DEFAULT_PLATFORM_ID = 'xiaohongshu' as const;

export type PlatformId = 'xiaohongshu' | 'facebook' | 'wechat_channels';

export type PlatformCapability =
  | 'identity'
  | 'overlay'
  | 'browse'
  | 'comment'
  | 'join'
  | 'publish'
  | 'interact'
  | 'patrol'
  | 'auth.browser_sidecar'
  | 'interaction.comment.read'
  | 'interaction.comment.reply'
  | 'interaction.dm.read'
  | 'interaction.dm.send_text'
  | 'interaction.dm.send_image';

export interface PlatformTargetDescriptor {
  readonly startUrl: string;
  /** Backward-compatible substring used by older attach paths. */
  readonly attachUrlIncludes: string;
  /** Host suffixes that are valid for this platform runtime. */
  readonly allowedHostSuffixes: readonly string[];
}

export interface BasePlatformDriver {
  readonly platform: PlatformId;
  /** Browser-oriented drivers and API-only interaction runtimes have different lifecycles. */
  readonly runtimeKind: 'browser' | 'interaction';
  /** Backward-compatible site/app label carried in hello.app. */
  readonly app: string;
  readonly capabilities: readonly PlatformCapability[];
  /** Existing edge capability labels carried in hello.capabilities. */
  readonly edgeCapabilities: readonly string[];
  readonly target: PlatformTargetDescriptor;
  readonly defaultStartUrl: string;
  readonly attachUrlIncludes: string;
  isAllowedTargetUrl(url: string): boolean;
}

/** XHS/Facebook keep their existing browser-oriented contract. */
export interface BrowserPlatformDriver extends BasePlatformDriver {
  readonly runtimeKind: 'browser';
  readIdentity(cdp: BrowseCdp, opts?: ReadSelfIdentityOptions): Promise<SelfIdentityResult>;
  decideIdentity(idRes: SelfIdentityResult, override: string | undefined): IdentityDecision;
  createOverlayMonitor(cdp: BrowseCdp): OverlayMonitor;
}

/** API-only platforms register without inventing browse/like/publish methods. */
export interface InteractionPlatformDriver extends BasePlatformDriver {
  readonly runtimeKind: 'interaction';
}

export type PlatformDriver = BrowserPlatformDriver | InteractionPlatformDriver;

export class UnsupportedPlatformCapabilityError extends Error {
  constructor(
    readonly platform: PlatformId,
    readonly capability: PlatformCapability,
  ) {
    super(`[aidcp-edge] platform=${platform} does not support capability=${capability}`);
    this.name = 'UnsupportedPlatformCapabilityError';
  }
}

export function assertPlatformCapability(driver: PlatformDriver, capability: PlatformCapability): void {
  if (!driver.capabilities.includes(capability)) {
    throw new UnsupportedPlatformCapabilityError(driver.platform, capability);
  }
}

export function isUrlAllowedByTargetDescriptor(url: string, target: PlatformTargetDescriptor): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return target.allowedHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export function normalizePlatformId(raw: string | undefined): PlatformId {
  const value = (raw ?? DEFAULT_PLATFORM_ID).trim().toLowerCase();
  if (!value || value === 'xhs' || value === 'redbook' || value === 'xiaohongshu') return 'xiaohongshu';
  if (value === 'facebook' || value === 'fb') return 'facebook';
  if (value === 'wechat_channels' || value === 'wechat-channels' || value === 'wechat') return 'wechat_channels';
  throw new Error(
    `[aidcp-edge] unsupported AIDCP_PLATFORM=${raw} (supported ids: xiaohongshu, facebook, wechat_channels)`,
  );
}
