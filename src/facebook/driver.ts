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
  capabilities: ['identity', 'overlay'],
  edgeCapabilities: ['locating', 'cdp'],
  target: FACEBOOK_TARGET,
  defaultStartUrl: FACEBOOK_TARGET.startUrl,
  attachUrlIncludes: FACEBOOK_TARGET.attachUrlIncludes,
  isAllowedTargetUrl: (url) => isUrlAllowedByTargetDescriptor(url, FACEBOOK_TARGET),
  readIdentity: readFacebookIdentity,
  decideIdentity: decideHandshakeIdentity,
  createOverlayMonitor: (cdp) => new FacebookOverlayMonitor(cdp),
};
