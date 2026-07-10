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

export interface BrowserPersonaNotice {
  active: boolean;
  accountLabel?: string;
}

export interface BrowserPersonaNoticeController {
  update(notice: BrowserPersonaNotice): Promise<void>;
  dispose(): void;
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

function normalizePersonaNotice(notice: BrowserPersonaNotice): BrowserPersonaNotice {
  if (!notice || notice.active !== true) return { active: false };
  const label = String(notice.accountLabel || '当前账号').trim().replace(/\s+/g, ' ').slice(0, 80) || '当前账号';
  return { active: true, accountLabel: label };
}

export async function setBrowserPersonaNotice(
  cdp: CdpClient,
  notice: BrowserPersonaNotice,
): Promise<void> {
  const payload = JSON.stringify(normalizePersonaNotice(notice));
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const notice = ${payload};
      const hostId = '__aidcp_persona_notice_host__';
      let host = document.getElementById(hostId);
      if (!notice.active) {
        if (host) host.remove();
        return { active: false };
      }
      if (!document.documentElement) return { active: false, reason: 'document_unavailable' };
      if (!host) {
        host = document.createElement('div');
        host.id = hostId;
        host.setAttribute('data-aidcp-overlay', 'persona-notice');
        for (const [name, value] of Object.entries({
          all: 'initial', position: 'fixed', top: '16px', left: '50%', width: 'min(420px, calc(100vw - 32px))',
          transform: 'translateX(-50%)', zIndex: '2147483647', pointerEvents: 'none'
        })) host.style.setProperty(name.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), value, 'important');
        document.documentElement.appendChild(host);
      }
      const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
      root.replaceChildren();
      const style = document.createElement('style');
      style.textContent = [
        ':host { color-scheme: light; }',
        '.notice { box-sizing: border-box; width: 100%; pointer-events: auto; display: grid; grid-template-columns: 4px 1fr auto;',
        'gap: 12px; align-items: start; border: 1px solid #d8dee9; border-radius: 8px; background: #ffffff;',
        'box-shadow: 0 12px 32px rgba(15, 23, 42, .18); padding: 14px 14px 14px 0;',
        'color: #172033; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }',
        '.bar { align-self: stretch; border-radius: 0 4px 4px 0; background: #e24a3b; }',
        '.copy { min-width: 0; }',
        '.title { margin: 0 0 4px; font-size: 14px; line-height: 1.4; font-weight: 700; letter-spacing: 0; }',
        '.body { margin: 0; font-size: 13px; line-height: 1.55; color: #5c667a; letter-spacing: 0; }',
        'button { width: 28px; height: 28px; border: 0; background: transparent; color: #667085; cursor: pointer;',
        'font: 20px/28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 0; border-radius: 4px; }',
        'button:hover { background: #f2f4f7; color: #172033; }',
        'button:focus-visible { outline: 2px solid #3b6ff0; outline-offset: 1px; }'
      ].join('');
      const card = document.createElement('section');
      card.className = 'notice';
      card.setAttribute('aria-label', 'AIDCP 账号人设提醒');
      const bar = document.createElement('span');
      bar.className = 'bar';
      const copy = document.createElement('div');
      copy.className = 'copy';
      const title = document.createElement('p');
      title.className = 'title';
      title.textContent = '账号人设尚未设置';
      const body = document.createElement('p');
      body.className = 'body';
      body.textContent = notice.accountLabel + ' 已登录，但还没有绑定人设。请回到 AIDCP 客户端完成设置后再开始自动运营。';
      copy.append(title, body);
      const close = document.createElement('button');
      close.type = 'button';
      close.title = '暂时关闭';
      close.setAttribute('aria-label', '暂时关闭人设提醒');
      close.textContent = '×';
      close.addEventListener('click', () => host.remove());
      card.append(bar, copy, close);
      root.append(style, card);
      return { active: true };
    })()`,
    returnByValue: true,
  });
}

export function createBrowserPersonaNoticeController(
  cdp: CdpClient,
  logger: (message: string) => void = console.log,
): BrowserPersonaNoticeController {
  let current: BrowserPersonaNotice = { active: false };
  let disposed = false;

  const apply = async (): Promise<void> => {
    if (disposed) return;
    await setBrowserPersonaNotice(cdp, current);
  };
  const reapply = (): void => {
    if (!current.active || disposed) return;
    void apply().catch((e) => logger(`[browser-persona-notice] reapply failed: ${(e as Error).message}`));
  };
  const offNavigate = cdp.on('Page.frameNavigated', (params) => {
    const frame = params && typeof params === 'object' && 'frame' in params
      ? (params as { frame?: { parentId?: string } }).frame
      : undefined;
    if (frame && !frame.parentId) reapply();
  });
  const offReconnect = cdp.on('cdp.reconnected', reapply);

  return {
    async update(notice: BrowserPersonaNotice): Promise<void> {
      current = normalizePersonaNotice(notice);
      await apply();
    },
    dispose(): void {
      disposed = true;
      offNavigate();
      offReconnect();
      if (current.active) {
        void setBrowserPersonaNotice(cdp, { active: false }).catch(() => undefined);
      }
    },
  };
}

export function installBrowserParkingStdinControl(
  cdp: CdpClient,
  config: BrowserParkingConfig | null,
  logger: (message: string) => void = console.log,
): void {
  if (process.env.AIDCP_BROWSER_CONTROL_STDIN !== '1') return;
  const personaNotice = createBrowserPersonaNoticeController(cdp, logger);
  const rl = createInterface({ input: process.stdin });
  logger('[browser-parking] control-ready');
  rl.on('line', (line) => {
    let msg: { type?: string; payload?: BrowserPersonaNotice };
    try {
      msg = JSON.parse(line) as { type?: string; payload?: BrowserPersonaNotice };
    } catch {
      return;
    }
    if (msg.type === 'browser.show' && config) {
      void showBrowserWindow(cdp, config, logger).catch((e) => logger(`[browser-parking] browser.show failed: ${(e as Error).message}`));
    } else if (msg.type === 'browser.park' && config) {
      void applyBrowserParking(cdp, config, logger).catch((e) => logger(`[browser-parking] browser.park failed: ${(e as Error).message}`));
    } else if (msg.type === 'browser.personaNotice') {
      void personaNotice.update(msg.payload || { active: false })
        .catch((e) => logger(`[browser-persona-notice] update failed: ${(e as Error).message}`));
    }
  });
  rl.on('close', () => personaNotice.dispose());
}
