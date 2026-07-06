import { evalRaw, type BrowseCdp } from '../../browse/cdp-util.js';

export interface FacebookFingerprintProbeConfig {
  providerKind: string;
  stealth: boolean;
}

export interface FacebookFingerprintSummary {
  href: string;
  providerKind: string;
  stealth: boolean;
  viewport: { width: number; height: number; devicePixelRatio: number };
  language: string | null;
  languagesCount: number;
  timezone: string | null;
  webdriverExposed: boolean;
  pluginsLength: number;
}

const FINGERPRINT_SCAN_JS = `(function(){
  var tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch(e) {}
  return JSON.stringify({
    href: location.href,
    viewport: {
      width: window.innerWidth || 0,
      height: window.innerHeight || 0,
      devicePixelRatio: window.devicePixelRatio || 1
    },
    language: navigator.language || null,
    languagesCount: navigator.languages ? navigator.languages.length : 0,
    timezone: tz,
    webdriverExposed: navigator.webdriver === true,
    pluginsLength: navigator.plugins ? navigator.plugins.length : 0
  });
})()`;

export async function collectFacebookFingerprintSummary(
  cdp: BrowseCdp,
  config: FacebookFingerprintProbeConfig,
): Promise<FacebookFingerprintSummary> {
  const raw = await evalRaw<string>(cdp, FINGERPRINT_SCAN_JS);
  const page = JSON.parse(raw) as Omit<FacebookFingerprintSummary, 'providerKind' | 'stealth'>;
  return {
    ...page,
    providerKind: config.providerKind,
    stealth: config.stealth,
  };
}
