import {
  isUrlAllowedByTargetDescriptor,
  type BrowserPlatformDriver,
  type PlatformTargetDescriptor,
} from '../platform/driver.js';
import { decideHandshakeIdentity, type PageContext, type SelfIdentityResult } from '../cdp/self-identity.js';
import { IDENTITY_READ_CURRENT_CAPABILITY } from '../comm/protocol.js';

export const FACEBOOK_DEFAULT_START_URL = 'https://www.facebook.com/';

export const FACEBOOK_TARGET: PlatformTargetDescriptor = {
  startUrl: FACEBOOK_DEFAULT_START_URL,
  attachUrlIncludes: 'facebook.com',
  allowedHostSuffixes: ['facebook.com', 'facebookcorewwwi.onion'],
};

async function nativeOnlyIdentity(): Promise<SelfIdentityResult> {
  return { ok: false, reason: 'facebook_identity_requires_native_page_engine' };
}

/**
 * Facebook 的运行期身份校验上下文分域。
 *
 * 与小红书**判据不同**，而且必须不同：小红书要先分清停在消费端还是创作子域，因为它的身份读取靠
 * 页面上的「我」锚点；Facebook 的身份是 **cookie 派生**（`readNativeFacebookIdentity`），不导航、
 * 不依赖当前停在哪个页面 —— 所以只要还在 Facebook 域内，身份就是可读的，直接归 `consumer`
 * 交给读取与探针判定。
 *
 * 曾经这里没有 FB 判据，宿主一律套小红书的域名分类器，于是 facebook.com 的每个 URL 都是 `unknown`，
 * 校验体每拍打一行「本轮跳过」就返回，**永远走不到** FB 身份读取：一台看起来装好了的空转机器。
 *
 * 已登记的缺口：本函数**不**把 `/login` 之类的页面判成确凿登出（小红书那条 `creator-login` 的对应
 * 物）。FB 未登录时的落地页形态未在真机坐实，凭猜写一条判据只会造出误报机；FB 的登出识别当前走
 * 正向登出探针（周期阻断观测的 `blockingKind==='login'`，FB 与 XHS 共用同一段策略），读数不新鲜时
 * 如实判「无法确认」并跳过 —— 「读不到」与「没有」仍是两态。
 */
export function classifyFacebookIdentityContext(href: string | null | undefined): PageContext {
  if (!href) return 'unknown';
  return isUrlAllowedByTargetDescriptor(href, FACEBOOK_TARGET) ? 'consumer' : 'unknown';
}

export const facebookPlatformDriver: BrowserPlatformDriver = {
  platform: 'facebook',
  runtimeKind: 'browser',
  app: 'facebook',
  // 'comment'：Facebook 定向评论执行能力（change facebook-scheduled-comment）。
  // 'join'：Facebook 加群原子执行能力（change facebook-group-join-and-commenting），独立于 browse。
  // 'browse'/'interact'：Facebook 浏览+点赞闭环（change facebook-browse-and-like-loop）。声明 'browse' 使
  //   装配闸（main.ts）解析到 FacebookBrowseSession——**与 FacebookBrowseSession 实现原子同落**，绝不裸声明
  //   （否则装配闸会把小红书 BrowseSession 挂到 Facebook 边端；design 的 co-landing 不变量）。FB 浏览会话独占
  //   单槽 browseHandler 并【内含】评论/加群委托（声明 browse 后旧 comment-only 注册闸不再触发）。
  // 'publish'：Facebook 个人时间线发帖原子执行能力（manual media pool + approval gate）。
  // 'identity'/'overlay' 为 driver 运行时能力（读身份 / 监测浮层），非编排词表——不进云端 registry 能力集。
  capabilities: ['identity', 'overlay', 'browse', 'comment', 'join', 'publish', 'interact'],
  // 'inline_targeting'：本构建能处理 note.open{surface:'feed'} 就地读 + feed 两段点赞（change
  //   facebook-feed-inline-browse）。云端**版本偏斜闸**（change platform-browse-protocol）只对声明此位的边缘
  //   开 inline 旗标；声明它只表示「我能」，真开与否由云端旗标 gate（默认全关 = 逐位等于今天）。
  // 'facebook_reel_follow_v1'：本构建含同 Reel/作者后置验证的关注执行器；Cloud 只对声明此位的连接启用自动关注。
  edgeCapabilities: [
    'locating',
    'cdp',
    'inline_targeting',
    'facebook_reel_follow_v1',
    IDENTITY_READ_CURRENT_CAPABILITY,
  ],
  target: FACEBOOK_TARGET,
  defaultStartUrl: FACEBOOK_TARGET.startUrl,
  attachUrlIncludes: FACEBOOK_TARGET.attachUrlIncludes,
  isAllowedTargetUrl: (url) => isUrlAllowedByTargetDescriptor(url, FACEBOOK_TARGET),
  // Main routes Facebook identity through Native Page Engine. This sentinel prevents a future
  // generic call from silently restoring JS CDP logic.
  //
  // 浮层监测体工厂已从 driver 契约整体移除（见 platform/driver.ts 的 BrowserPlatformDriver 注释）。
  // 此前这里留的是一个「被调即抛」的 native-only 桩：它挡不住任何东西，因为全仓从来没有调用点——
  // 一个永不被调用的哨兵不产生信号，正是本轮清除的那类无信号保留。Facebook 阻断观测的落点是
  // Native 页面探针与 Rust 动作闸。
  readIdentity: nativeOnlyIdentity,
  decideIdentity: decideHandshakeIdentity,
  classifyIdentityContext: classifyFacebookIdentityContext,
};
