import { isUrlAllowedByTargetDescriptor, type PlatformDriver } from '../platform/driver.js';
import { CdpOverlayMonitor } from '../browse/overlay-monitor.js';
import { decideHandshakeIdentity, readSelfIdentity } from '../cdp/self-identity.js';

export const XHS_DEFAULT_START_URL = 'https://www.xiaohongshu.com/explore';
const XHS_TARGET = {
  startUrl: XHS_DEFAULT_START_URL,
  attachUrlIncludes: 'xiaohongshu.com',
  allowedHostSuffixes: ['xiaohongshu.com'],
} as const;

export const xhsPlatformDriver: PlatformDriver = {
  platform: 'xiaohongshu',
  app: 'xhs',
  capabilities: ['identity', 'overlay', 'browse', 'comment', 'publish', 'interact', 'patrol'],
  edgeCapabilities: ['locating', 'cdp', 'like', 'browse'],
  target: XHS_TARGET,
  defaultStartUrl: XHS_TARGET.startUrl,
  attachUrlIncludes: XHS_TARGET.attachUrlIncludes,
  isAllowedTargetUrl: (url) => isUrlAllowedByTargetDescriptor(url, XHS_TARGET),
  readIdentity: readSelfIdentity,
  decideIdentity: decideHandshakeIdentity,
  createOverlayMonitor: (cdp) => new CdpOverlayMonitor(cdp),
};
