import type { BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayMonitor } from '../browse/overlay-monitor.js';
import type {
  IdentityDecision,
  ReadSelfIdentityOptions,
  SelfIdentityResult,
} from '../cdp/self-identity.js';

export const DEFAULT_PLATFORM_ID = 'xiaohongshu' as const;

export type PlatformId = 'xiaohongshu' | 'facebook';

export type PlatformCapability =
  | 'identity'
  | 'overlay'
  | 'browse'
  | 'comment'
  | 'publish'
  | 'interact'
  | 'patrol';

export interface PlatformDriver {
  readonly platform: PlatformId;
  /** Backward-compatible site/app label carried in hello.app. */
  readonly app: string;
  readonly capabilities: readonly PlatformCapability[];
  /** Existing edge capability labels carried in hello.capabilities. */
  readonly edgeCapabilities: readonly string[];
  readonly defaultStartUrl: string;
  readonly attachUrlIncludes: string;
  readIdentity(cdp: BrowseCdp, opts?: ReadSelfIdentityOptions): Promise<SelfIdentityResult>;
  decideIdentity(idRes: SelfIdentityResult, override: string | undefined): IdentityDecision;
  createOverlayMonitor(cdp: BrowseCdp): OverlayMonitor;
}

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

export function normalizePlatformId(raw: string | undefined): PlatformId {
  const value = (raw ?? DEFAULT_PLATFORM_ID).trim().toLowerCase();
  if (!value || value === 'xhs' || value === 'redbook' || value === 'xiaohongshu') return 'xiaohongshu';
  if (value === 'facebook' || value === 'fb') return 'facebook';
  throw new Error(
    `[aidcp-edge] unsupported AIDCP_PLATFORM=${raw} (supported ids: xiaohongshu; recognized future id: facebook)`,
  );
}
