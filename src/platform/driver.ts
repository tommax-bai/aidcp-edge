import type { BrowseCdp } from '../browse/cdp-util.js';
import type {
  IdentityDecision,
  PageContext,
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

/**
 * XHS/Facebook keep their existing browser-oriented contract.
 *
 * 这里**没有**浮层监测体工厂。删除依据：阻断观测已整体迁进 Native 页面探针（周期观测在
 * native-page-engine 的浏览会话里，动作提交前的即席复检在 Rust 动作闸内），宿主侧没有任何调用点；
 * 而 driver 上一个「接口有、无人调」的工厂成员不产生任何信号——它既不会因为没人调用而报错，
 * 也不会因为实现退化成抛异常的桩而被发现，正是本轮要消灭的那类无信号保留。要恢复阻断观测，
 * 落点在 Native 探针，MUST NOT 在这里重开一个持原始 CDP 句柄、把页面判据写回明文 TypeScript
 * 的工厂（那与页面规则必须留在编码后 Native 产物内的约束直接冲突）。
 */
export interface BrowserPlatformDriver extends BasePlatformDriver {
  readonly runtimeKind: 'browser';
  readIdentity(cdp: BrowseCdp, opts?: ReadSelfIdentityOptions): Promise<SelfIdentityResult>;
  decideIdentity(idRes: SelfIdentityResult, override: string | undefined): IdentityDecision;
  /**
   * 运行期身份校验的**页面上下文分域**：当前 URL 属于「能读身份的页」「自带登录门禁的页」
   * 「确凿登出的页」还是「判不了」。纯函数（只吃 href），实现随平台走。
   *
   * 为什么必须挂在 driver 上：这道闸原本写死成小红书域名判据，于是 Facebook 下的任何 URL 都归
   * `unknown` —— 校验体每拍打一行「本轮跳过」，**永远走不到**为 FB 注入的身份读取。代码与日志都
   * 像已经装上了，实际是一台永久空转的机器；而 FB 正是当前真正在跑的平台。
   *
   * 判据本身也确实是平台相关的：小红书的身份读取依赖页面上的「我」锚点，所以必须先分清停在哪个
   * 子域；Facebook 的身份是 cookie 派生、不导航、不关心当前停在哪个页，所以「在 facebook 域内」
   * 就足以判定「可读」。放到 driver 上，新平台**不实现就编译不过**——不会再出现「装了但永久跳过」。
   */
  classifyIdentityContext(href: string | null | undefined): PageContext;
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
