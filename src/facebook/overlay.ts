import { evalRaw, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../browse/overlay-monitor.js';

export interface FacebookBlockingSignals {
  href: string;
  text?: string;
  frameUrls?: string[];
}

export function classifyFacebookOverlayFromSignals(signals: FacebookBlockingSignals): OverlayKind {
  const href = String(signals.href || '').toLowerCase();
  const text = String(signals.text || '').replace(/\s+/g, ' ');
  const textLower = text.toLowerCase();
  const frames = (signals.frameUrls || []).join('\n').toLowerCase();

  if (
    href.includes('/checkpoint') ||
    href.includes('/two_step_verification') ||
    frames.includes('fbsbx.com/captcha') ||
    frames.includes('google.com/recaptcha') ||
    /进行人机身份验证|人机身份验证|security check|captcha|recaptcha/i.test(text)
  ) {
    return 'captcha';
  }

  if (
    href.includes('/login') ||
    href.includes('/recover') ||
    /登录 facebook|登录或注册|log in to facebook|forgot password|account recovery|账号恢复|找回账号/i.test(text)
  ) {
    return 'login';
  }

  if (
    href.includes('/help/contact') ||
    /temporarily blocked|you.?re temporarily blocked|暂时被限制|功能暂时不可用|你暂时无法使用/i.test(textLower)
  ) {
    return 'unknown';
  }

  return 'none';
}

const FACEBOOK_OVERLAY_SCAN_JS = `(function(){
  function clip(s, n){ s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; }
  var frameUrls = [];
  var frames = document.querySelectorAll('iframe');
  for (var i = 0; i < frames.length && frameUrls.length < 20; i++) {
    var src = frames[i].getAttribute('src') || frames[i].src || '';
    if (src) frameUrls.push(src);
  }
  return JSON.stringify({
    href: location.href,
    text: clip(document.body ? document.body.innerText : '', 4000),
    frameUrls: frameUrls
  });
})()`;

export async function classifyFacebookOverlay(cdp: BrowseCdp): Promise<OverlayKind> {
  const raw = await evalRaw<string>(cdp, FACEBOOK_OVERLAY_SCAN_JS);
  try {
    return classifyFacebookOverlayFromSignals(JSON.parse(raw) as FacebookBlockingSignals);
  } catch {
    return 'unknown';
  }
}

export interface FacebookOverlayMonitorOptions {
  pollMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  logger?: (msg: string) => void;
}

export class FacebookOverlayMonitor implements OverlayMonitor {
  private current: OverlayKind = 'none';
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(
    private readonly cdp: BrowseCdp,
    private readonly opts: FacebookOverlayMonitorOptions = {},
  ) {}

  get state(): OverlayKind {
    return this.current;
  }

  async probeNow(): Promise<OverlayKind> {
    return classifyFacebookOverlay(this.cdp);
  }

  start(onTransition?: (from: OverlayKind, to: OverlayKind) => void): void {
    if (!this.stopped) return;
    this.stopped = false;
    const pollMs = this.opts.pollMs ?? 1000;
    const setTimer = this.opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const loop = async (): Promise<void> => {
      if (this.stopped) return;
      await this.tick(onTransition);
      if (this.stopped) return;
      this.timer = setTimer(() => void loop(), pollMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      const clearTimer = this.opts.clearTimer ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h));
      clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  async tick(onTransition?: (from: OverlayKind, to: OverlayKind) => void): Promise<void> {
    let next: OverlayKind;
    try {
      next = await this.probeNow();
    } catch (err) {
      this.opts.logger?.(`[facebook-overlay] probe failed; keeping state=${this.current}: ${(err as Error).message}`);
      return;
    }
    if (next !== this.current) {
      const prev = this.current;
      this.current = next;
      onTransition?.(prev, next);
    }
  }
}
