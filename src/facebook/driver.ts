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
  app: 'facebook',
  // 'comment'：Facebook 定向评论执行能力（change facebook-scheduled-comment）。
  // 刻意不含 'browse'——绝不能让边缘装配闸把小红书 BrowseSession 挂到 Facebook 边端上（design 决策）；
  // 评论命令走独立的 Facebook 评论处理器（main.ts 按此能力注册），不复用浏览闭环。
  capabilities: ['identity', 'overlay', 'comment'],
  edgeCapabilities: ['locating', 'cdp'],
  target: FACEBOOK_TARGET,
  defaultStartUrl: FACEBOOK_TARGET.startUrl,
  attachUrlIncludes: FACEBOOK_TARGET.attachUrlIncludes,
  isAllowedTargetUrl: (url) => isUrlAllowedByTargetDescriptor(url, FACEBOOK_TARGET),
  readIdentity: readFacebookIdentity,
  decideIdentity: decideHandshakeIdentity,
  createOverlayMonitor: (cdp) => new FacebookOverlayMonitor(cdp),
};
