import type { BrowseCdp } from '../../browse/cdp-util.js';
import type { OverlayKind } from '../../browse/overlay-monitor.js';
import { classifyFacebookOverlay } from '../overlay.js';

export type FacebookGatedSubmitPreflightReason =
  | 'disabled'
  | 'not_disposable'
  | 'missing_target_url'
  | 'target_not_facebook'
  | 'current_not_facebook'
  | 'target_mismatch'
  | 'blocked_by_login'
  | 'blocked_by_captcha'
  | 'blocked_by_unknown';

export interface FacebookGatedSubmitPreflightOptions {
  enabled?: boolean;
  disposableAccountConfirmed?: boolean;
  targetUrl?: string;
  currentUrl?: string;
  classifyOverlay?: (cdp: BrowseCdp) => Promise<OverlayKind>;
}

export type FacebookGatedSubmitPreflightResult =
  | { ok: true; targetUrl: string; currentUrl: string; overlay: 'none' }
  | { ok: false; reason: FacebookGatedSubmitPreflightReason; overlay?: OverlayKind; targetUrl?: string; currentUrl?: string };

function isFacebookUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'facebookcorewwwi.onion';
  } catch {
    return false;
  }
}

function normalizeTarget(value: string): string {
  const url = new URL(value);
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function overlayReason(kind: Exclude<OverlayKind, 'none'>): FacebookGatedSubmitPreflightReason {
  if (kind === 'login') return 'blocked_by_login';
  if (kind === 'captcha') return 'blocked_by_captcha';
  return 'blocked_by_unknown';
}

export async function facebookGatedSubmitPreflight(
  cdp: BrowseCdp,
  options: FacebookGatedSubmitPreflightOptions = {},
): Promise<FacebookGatedSubmitPreflightResult> {
  if (!options.enabled) return { ok: false, reason: 'disabled' };
  if (!options.disposableAccountConfirmed) return { ok: false, reason: 'not_disposable' };
  if (!options.targetUrl) return { ok: false, reason: 'missing_target_url' };
  if (!isFacebookUrl(options.targetUrl)) return { ok: false, reason: 'target_not_facebook', targetUrl: options.targetUrl };

  const currentUrl = options.currentUrl ?? options.targetUrl;
  if (!isFacebookUrl(currentUrl)) return { ok: false, reason: 'current_not_facebook', targetUrl: options.targetUrl, currentUrl };
  if (normalizeTarget(currentUrl) !== normalizeTarget(options.targetUrl)) {
    return { ok: false, reason: 'target_mismatch', targetUrl: options.targetUrl, currentUrl };
  }

  const classify = options.classifyOverlay ?? classifyFacebookOverlay;
  const overlay = await classify(cdp);
  if (overlay !== 'none') {
    return { ok: false, reason: overlayReason(overlay), overlay, targetUrl: options.targetUrl, currentUrl };
  }
  return { ok: true, targetUrl: options.targetUrl, currentUrl, overlay: 'none' };
}
