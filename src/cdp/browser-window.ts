import { createInterface } from 'node:readline';
import type { CdpClient } from './client.js';

export type BrowserParkingMode = 'parking-display' | 'edge-strip' | 'offscreen';

export interface BrowserWindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BrowserParkingConfig {
  mode: BrowserParkingMode;
  effectiveMode: BrowserParkingMode;
  bounds: BrowserWindowBounds;
  fallbackBounds: BrowserWindowBounds;
  visibleBounds: BrowserWindowBounds;
  fallbackReason?: string;
}

interface VisibilityProbe {
  hidden?: boolean;
  visibility?: string;
  w?: number;
  h?: number;
}

const VALID_MODES = new Set(['parking-display', 'edge-strip', 'offscreen']);
const MIN_VIEWPORT_WIDTH = 1000;
const MIN_VIEWPORT_HEIGHT = 600;

function parseBounds(raw: string | undefined): BrowserWindowBounds | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<BrowserWindowBounds>;
    const left = Number(value.left);
    const top = Number(value.top);
    const width = Number(value.width);
    const height = Number(value.height);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return { left: Math.floor(left), top: Math.floor(top), width: Math.floor(width), height: Math.floor(height) };
  } catch {
    return null;
  }
}

function modeOf(raw: string | undefined): BrowserParkingMode {
  return VALID_MODES.has(raw || '') ? raw as BrowserParkingMode : 'edge-strip';
}

export function browserParkingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserParkingConfig | null {
  const bounds = parseBounds(env.AIDCP_BROWSER_PARKING_BOUNDS);
  const fallbackBounds = parseBounds(env.AIDCP_BROWSER_PARKING_FALLBACK_BOUNDS);
  const visibleBounds = parseBounds(env.AIDCP_BROWSER_PARKING_VISIBLE_BOUNDS);
  if (!bounds || !fallbackBounds || !visibleBounds) return null;
  return {
    mode: modeOf(env.AIDCP_BROWSER_PARKING_MODE),
    effectiveMode: modeOf(env.AIDCP_BROWSER_PARKING_EFFECTIVE_MODE),
    bounds,
    fallbackBounds,
    visibleBounds,
    fallbackReason: env.AIDCP_BROWSER_PARKING_FALLBACK_REASON,
  };
}

async function setWindowBounds(cdp: CdpClient, bounds: BrowserWindowBounds): Promise<void> {
  const win = await cdp.send<{ windowId?: number }>('Browser.getWindowForTarget');
  if (!Number.isInteger(win.windowId)) throw new Error('Browser.getWindowForTarget 未返回 windowId');
  await cdp.send('Browser.setWindowBounds', {
    windowId: win.windowId,
    bounds: { ...bounds, windowState: 'normal' },
  });
}

async function probeVisibility(cdp: CdpClient): Promise<VisibilityProbe> {
  const r = await cdp.send<{ result?: { value?: VisibilityProbe } }>('Runtime.evaluate', {
    expression: `(() => ({
      hidden: document.hidden,
      visibility: document.visibilityState,
      w: window.innerWidth || 0,
      h: window.innerHeight || 0
    }))()`,
    returnByValue: true,
  });
  return r.result?.value ?? {};
}

function isVisibleProbeOk(probe: VisibilityProbe): boolean {
  return probe.hidden === false &&
    probe.visibility === 'visible' &&
    Number(probe.w) >= MIN_VIEWPORT_WIDTH &&
    Number(probe.h) >= MIN_VIEWPORT_HEIGHT;
}

export async function applyBrowserParking(
  cdp: CdpClient,
  config: BrowserParkingConfig | null,
  logger: (message: string) => void = console.log,
): Promise<void> {
  if (!config) return;
  if (config.fallbackReason) {
    logger(`[browser-parking] ${config.mode} 降级为 ${config.effectiveMode} (${config.fallbackReason})`);
  }
  await setWindowBounds(cdp, config.bounds);
  const probe = await probeVisibility(cdp);
  if (isVisibleProbeOk(probe)) {
    logger(`[browser-parking] applied mode=${config.effectiveMode} viewport=${probe.w}x${probe.h}`);
    return;
  }

  logger(`[browser-parking] mode=${config.effectiveMode} visibility check failed, falling back to edge-strip`);
  await setWindowBounds(cdp, config.fallbackBounds);
  const fallbackProbe = await probeVisibility(cdp);
  if (!isVisibleProbeOk(fallbackProbe)) {
    throw new Error(
      `[browser-parking] 停放后页面不可见或视口异常 hidden=${fallbackProbe.hidden} visibility=${fallbackProbe.visibility} viewport=${fallbackProbe.w}x${fallbackProbe.h}`,
    );
  }
  logger(`[browser-parking] fallback applied viewport=${fallbackProbe.w}x${fallbackProbe.h}`);
}

export async function showBrowserWindow(
  cdp: CdpClient,
  config: BrowserParkingConfig | null,
  logger: (message: string) => void = console.log,
): Promise<void> {
  if (!config) throw new Error('未配置浏览器窗口位置');
  await setWindowBounds(cdp, config.visibleBounds);
  logger('[browser-parking] browser window moved to visible bounds');
}

export function installBrowserParkingStdinControl(
  cdp: CdpClient,
  config: BrowserParkingConfig | null,
  logger: (message: string) => void = console.log,
): void {
  if (process.env.AIDCP_BROWSER_CONTROL_STDIN !== '1' || !config) return;
  const rl = createInterface({ input: process.stdin });
  logger('[browser-parking] control-ready');
  rl.on('line', (line) => {
    let msg: { type?: string };
    try {
      msg = JSON.parse(line) as { type?: string };
    } catch {
      return;
    }
    if (msg.type === 'browser.show') {
      void showBrowserWindow(cdp, config, logger).catch((e) => logger(`[browser-parking] browser.show failed: ${(e as Error).message}`));
    } else if (msg.type === 'browser.park') {
      void applyBrowserParking(cdp, config, logger).catch((e) => logger(`[browser-parking] browser.park failed: ${(e as Error).message}`));
    }
  });
}
