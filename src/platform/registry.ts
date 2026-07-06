import { xhsPlatformDriver } from '../xhs/driver.js';
import { normalizePlatformId, type PlatformDriver, type PlatformId } from './driver.js';

export const PLATFORM_DRIVERS: Partial<Record<PlatformId, PlatformDriver>> = {
  xiaohongshu: xhsPlatformDriver,
};

export function selectPlatformDriver(opts: { env?: NodeJS.ProcessEnv } = {}): PlatformDriver {
  const platform = normalizePlatformId(opts.env?.AIDCP_PLATFORM);
  const driver = PLATFORM_DRIVERS[platform];
  if (!driver) {
    throw new Error(`[aidcp-edge] platform=${platform} is recognized but has no edge driver in this build`);
  }
  return driver;
}
