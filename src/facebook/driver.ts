import { decideHandshakeIdentity } from '../cdp/self-identity.js';
import {
  isUrlAllowedByTargetDescriptor,
  type PlatformDriver,
  type PlatformTargetDescriptor,
} from '../platform/driver.js';
import { readFacebookIdentity } from './identity.js';
import { FacebookOverlayMonitor } from './overlay.js';

export const FACEBOOK_DEFAULT_START_URL = 'https://www.facebook.com/';

export const FACEBOOK_TARGET: PlatformTargetDescriptor = {
  startUrl: FACEBOOK_DEFAULT_START_URL,
  attachUrlIncludes: 'facebook.com',
  allowedHostSuffixes: ['facebook.com', 'facebookcorewwwi.onion'],
};

export const facebookPlatformDriver: PlatformDriver = {
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
  edgeCapabilities: ['locating', 'cdp', 'inline_targeting', 'facebook_reel_follow_v1'],
  target: FACEBOOK_TARGET,
  defaultStartUrl: FACEBOOK_TARGET.startUrl,
  attachUrlIncludes: FACEBOOK_TARGET.attachUrlIncludes,
  isAllowedTargetUrl: (url) => isUrlAllowedByTargetDescriptor(url, FACEBOOK_TARGET),
  readIdentity: readFacebookIdentity,
  decideIdentity: decideHandshakeIdentity,
  createOverlayMonitor: (cdp) => new FacebookOverlayMonitor(cdp),
};
