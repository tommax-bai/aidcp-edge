import { isUrlAllowedByTargetDescriptor, type BrowserPlatformDriver } from '../platform/driver.js';
import { classifyPageContext, decideHandshakeIdentity, readSelfIdentity } from '../cdp/self-identity.js';
import { IDENTITY_READ_SELF_PROFILE_CAPABILITY } from '../comm/protocol.js';

export const XHS_DEFAULT_START_URL = 'https://www.xiaohongshu.com/explore';
const XHS_TARGET = {
  startUrl: XHS_DEFAULT_START_URL,
  attachUrlIncludes: 'xiaohongshu.com',
  allowedHostSuffixes: ['xiaohongshu.com'],
} as const;

export const xhsPlatformDriver: BrowserPlatformDriver = {
  platform: 'xiaohongshu',
  runtimeKind: 'browser',
  app: 'xhs',
  capabilities: ['identity', 'overlay', 'browse', 'comment', 'publish', 'interact', 'patrol'],
  edgeCapabilities: ['locating', 'cdp', 'like', 'browse', IDENTITY_READ_SELF_PROFILE_CAPABILITY],
  target: XHS_TARGET,
  defaultStartUrl: XHS_TARGET.startUrl,
  attachUrlIncludes: XHS_TARGET.attachUrlIncludes,
  isAllowedTargetUrl: (url) => isUrlAllowedByTargetDescriptor(url, XHS_TARGET),
  readIdentity: readSelfIdentity,
  decideIdentity: decideHandshakeIdentity,
  // 小红书的身份读取依赖页面上的「我」锚点，必须先分清消费端 / 创作子域 / 创作登录页三态。
  classifyIdentityContext: classifyPageContext,
  // 浮层监测体工厂已从 driver 契约移除（见 platform/driver.ts 的 BrowserPlatformDriver 注释）：
  // 小红书阻断观测的落点是 Native 页面探针，不是宿主侧的 CdpOverlayMonitor。
};
