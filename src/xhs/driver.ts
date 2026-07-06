import type { PlatformDriver } from '../platform/driver.js';
import { CdpOverlayMonitor } from '../browse/overlay-monitor.js';
import { decideHandshakeIdentity, readSelfIdentity } from '../cdp/self-identity.js';

export const XHS_DEFAULT_START_URL = 'https://www.xiaohongshu.com/explore';

export const xhsPlatformDriver: PlatformDriver = {
  platform: 'xiaohongshu',
  app: 'xhs',
  capabilities: ['identity', 'overlay', 'browse', 'comment', 'publish', 'interact', 'patrol'],
  edgeCapabilities: ['locating', 'cdp', 'like', 'browse'],
  defaultStartUrl: XHS_DEFAULT_START_URL,
  attachUrlIncludes: 'xiaohongshu.com',
  readIdentity: readSelfIdentity,
  decideIdentity: decideHandshakeIdentity,
  createOverlayMonitor: (cdp) => new CdpOverlayMonitor(cdp),
};
