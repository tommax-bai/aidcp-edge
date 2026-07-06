/**
 * Manual Facebook Phase-0 probe runner.
 *
 * This script is intentionally conservative:
 * - no credential automation;
 * - no submit/click on post controls;
 * - storage output is summarized by existing redaction helpers;
 * - identity output is hashed, never printed as a raw Facebook account id.
 *
 * Example:
 *   AIDCP_ADS_USER_ID=k1ebny3j npx tsx test/manual/facebook-phase0-probe.ts
 *
 * Optional:
 *   AIDCP_FB_PROBE_URL=https://www.facebook.com/Meta/posts/... \
 *   AIDCP_FB_RUN_EDITOR_PROBE=true \
 *   AIDCP_FB_RUN_F2=1 \
 *   AIDCP_FB_F2_URLS=https://www.facebook.com/login/,https://www.facebook.com/checkpoint/ \
 *   AIDCP_FB_EXECUTE_GATED_SUBMIT=1 \
 *   AIDCP_FB_GATED_SUBMIT=1 \
 *   AIDCP_FB_DISPOSABLE_CONFIRMED=1 \
 *   AIDCP_FB_GATED_TARGET_URL=https://www.facebook.com/... \
 *   AIDCP_FB_GATED_COMMENT_TEXT='operator-owned disposable test comment' \
 *   npx tsx test/manual/facebook-phase0-probe.ts
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { evalRaw } from '../../src/browse/cdp-util.js';
import {
  attachToPage,
  selectBrowserProvider,
  type BrowserProvider,
} from '../../src/cdp/index.js';
import {
  collectFacebookFingerprintSummary,
  collectFacebookPageStructure,
  collectFacebookStorageSummary,
  facebookGatedSubmitPreflight,
  facebookPlatformDriver,
  probeFacebookCommentEditorReadOnly,
  readFacebookIdentity,
  classifyFacebookOverlay,
  runFacebookGatedSubmitProbe,
  type FacebookEditorProbeResult,
  type FacebookGatedSubmitPreflightResult,
  type FacebookGatedSubmitProbeResult,
  type FacebookPageStructureSummary,
  type FacebookStorageSummary,
  type FacebookFingerprintSummary,
} from '../../src/facebook/index.js';

interface SafeIdentitySummary {
  ok: boolean;
  accountIdHash?: string;
  reason?: string;
}

interface BlockingProbeResult {
  requestedUrl: string;
  finalUrl: string;
  overlay: string;
  surface: string;
}

interface Phase0ProbeReport {
  generatedAt: string;
  profileId: string;
  providerKind: string;
  targetUrl: string;
  finalUrl: string;
  overlay: string;
  identity: SafeIdentitySummary;
  fingerprint: FacebookFingerprintSummary;
  storage: FacebookStorageSummary;
  pageStructure: FacebookPageStructureSummary;
  editorProbe?: FacebookEditorProbeResult;
  gatedSubmitPreflight: FacebookGatedSubmitPreflightResult;
  gatedSubmitProbe?: FacebookGatedSubmitProbeResult;
  blockingProbes: BlockingProbeResult[];
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boolEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function hashStable(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function safeIdentitySummary(res: Awaited<ReturnType<typeof readFacebookIdentity>>): SafeIdentitySummary {
  if (!res.ok) return { ok: false, reason: res.reason };
  return {
    ok: true,
    accountIdHash: hashStable(res.identity.accountId),
  };
}

function splitUrls(value: string | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function currentUrl(cdp: { send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> }): Promise<string> {
  return evalRaw<string>(cdp, 'location.href');
}

async function navigateAndSettle(
  cdp: { send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> },
  url: string,
  waitMs: number,
): Promise<string> {
  await cdp.send('Page.navigate', { url });
  await sleep(waitMs);
  return currentUrl(cdp);
}

function selectProvider(startUrl: string, userId: string): BrowserProvider {
  return selectBrowserProvider({
    env: {
      ...process.env,
      AIDCP_BROWSER_PROVIDER: process.env.AIDCP_BROWSER_PROVIDER ?? 'adspower',
      AIDCP_ADS_USER_ID: userId,
    } as NodeJS.ProcessEnv,
    startUrl,
    logImpl: (msg) => console.log(msg),
  });
}

async function runBlockingProbes(
  cdp: { send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> },
  urls: string[],
  waitMs: number,
): Promise<BlockingProbeResult[]> {
  const results: BlockingProbeResult[] = [];
  for (const url of urls) {
    const finalUrl = await navigateAndSettle(cdp, url, waitMs);
    const overlay = await classifyFacebookOverlay(cdp);
    const structure = await collectFacebookPageStructure(cdp);
    results.push({
      requestedUrl: url,
      finalUrl,
      overlay,
      surface: structure.surface,
    });
  }
  return results;
}

async function writeReportIfRequested(report: Phase0ProbeReport): Promise<void> {
  const out = process.env.AIDCP_FB_PROBE_OUT?.trim();
  if (!out) return;
  const path = resolve(out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[facebook-phase0] wrote sanitized report to ${path}`);
}

async function main(): Promise<void> {
  const userId = requireEnv('AIDCP_ADS_USER_ID');
  const executeGatedSubmit = boolEnv('AIDCP_FB_EXECUTE_GATED_SUBMIT');
  const gatedTargetUrl = process.env.AIDCP_FB_GATED_TARGET_URL?.trim();
  const targetUrl = process.env.AIDCP_FB_PROBE_URL?.trim() ||
    (executeGatedSubmit && gatedTargetUrl ? gatedTargetUrl : facebookPlatformDriver.defaultStartUrl);
  const waitMs = Number(process.env.AIDCP_FB_WAIT_MS ?? 3500);
  const runEditorProbe = boolEnv('AIDCP_FB_RUN_EDITOR_PROBE');
  const runF2 = boolEnv('AIDCP_FB_RUN_F2');
  const f2Urls = runF2 ? splitUrls(process.env.AIDCP_FB_F2_URLS) : [];
  const keepBrowser = boolEnv('AIDCP_FB_KEEP_BROWSER');

  if (runF2 && f2Urls.length === 0) {
    throw new Error('AIDCP_FB_RUN_F2=1 requires AIDCP_FB_F2_URLS');
  }
  if (executeGatedSubmit && runEditorProbe) {
    throw new Error('AIDCP_FB_EXECUTE_GATED_SUBMIT=1 cannot be combined with AIDCP_FB_RUN_EDITOR_PROBE');
  }
  if (executeGatedSubmit && runF2) {
    throw new Error('AIDCP_FB_EXECUTE_GATED_SUBMIT=1 cannot be combined with AIDCP_FB_RUN_F2');
  }

  const provider = selectProvider(targetUrl, userId);
  const launched = await provider.launch({
    host: process.env.AIDCP_CDP_HOST ?? '127.0.0.1',
    port: Number(process.env.AIDCP_CDP_PORT ?? 9222),
    headless: process.env.AIDCP_CHROME_HEADLESS === 'true',
    readyTimeoutMs: Number(process.env.AIDCP_CDP_READY_TIMEOUT_MS ?? 15_000),
  });

  const session = await attachToPage({
    host: launched.endpoint.host,
    port: launched.endpoint.port,
    stealth: false,
    urlIncludes: facebookPlatformDriver.attachUrlIncludes,
    targetPredicate: (target) => facebookPlatformDriver.isAllowedTargetUrl(target.url),
  });

  try {
    const finalUrl = await navigateAndSettle(session.cdp, targetUrl, waitMs);
    const overlay = await classifyFacebookOverlay(session.cdp);
    const identity = safeIdentitySummary(await readFacebookIdentity(session.cdp));
    const fingerprint = await collectFacebookFingerprintSummary(session.cdp, {
      providerKind: provider.kind,
      stealth: false,
    });
    const storage = await collectFacebookStorageSummary(session.cdp);
    const pageStructure = await collectFacebookPageStructure(session.cdp);
    const editorProbe = runEditorProbe ? await probeFacebookCommentEditorReadOnly(session.cdp) : undefined;
    const gatedSubmitPreflight = await facebookGatedSubmitPreflight(session.cdp, {
      enabled: boolEnv('AIDCP_FB_GATED_SUBMIT'),
      disposableAccountConfirmed: boolEnv('AIDCP_FB_DISPOSABLE_CONFIRMED'),
      targetUrl: gatedTargetUrl,
      currentUrl: finalUrl,
    });
    const gatedSubmitProbe = executeGatedSubmit
      ? await runFacebookGatedSubmitProbe(session.cdp, {
        enabled: boolEnv('AIDCP_FB_GATED_SUBMIT'),
        disposableAccountConfirmed: boolEnv('AIDCP_FB_DISPOSABLE_CONFIRMED'),
        targetUrl: gatedTargetUrl,
        currentUrl: finalUrl,
        commentText: process.env.AIDCP_FB_GATED_COMMENT_TEXT,
      })
      : undefined;
    const blockingProbes = await runBlockingProbes(session.cdp, f2Urls, waitMs);

    const report: Phase0ProbeReport = {
      generatedAt: new Date().toISOString(),
      profileId: userId,
      providerKind: provider.kind,
      targetUrl,
      finalUrl,
      overlay,
      identity,
      fingerprint,
      storage,
      pageStructure,
      ...(editorProbe ? { editorProbe } : {}),
      gatedSubmitPreflight,
      ...(gatedSubmitProbe ? { gatedSubmitProbe } : {}),
      blockingProbes,
    };

    console.log(JSON.stringify(report, null, 2));
    await writeReportIfRequested(report);
  } finally {
    session.close();
    if (!keepBrowser) {
      launched.instance.kill();
    }
  }
}

main().catch((err) => {
  console.error('[facebook-phase0] failed:', err);
  process.exitCode = 1;
});
