#!/usr/bin/env tsx
/**
 * Bounded TikTok web probe for one explicitly named local AdsPower profile.
 *
 * Defaults:
 * - browses two feed items;
 * - observes the current like state without clicking;
 * - does not touch a comment editor unless AIDCP_TIKTOK_PROBE_COMMENT_TEXT is set;
 * - keeps the browser open.
 *
 * A real like requires both:
 *   AIDCP_TIKTOK_PROBE_LIKE=1
 *   AIDCP_TIKTOK_PROBE_CONFIRM_PROFILE=<the exact profile id>
 *
 * Comment probing is fill-only by construction. There is no submit flag or submit code path.
 *
 * Usage:
 *   npx tsx scripts/tiktok-interaction-probe.ts <adspower_profile_id>
 */
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { evalRaw } from '../src/browse/index.js';
import { attachToPage, selectBrowserProvider, type EdgeSession } from '../src/cdp/index.js';
import {
  TIKTOK_START_URL,
  TikTokInteractionProbe,
  hasExactAdsPowerProfileMarker,
  isTikTokTargetUrl,
  toTikTokSafeSnapshot,
  type TikTokBrowseResult,
  type TikTokCommentResult,
  type TikTokLikeResult,
  type TikTokSafeSnapshot,
} from '../src/tiktok/index.js';

const PROFILE_ID = (process.argv[2] ?? process.env.AIDCP_ADS_USER_ID ?? '').trim();
const START_URL = (process.env.AIDCP_TIKTOK_START_URL ?? TIKTOK_START_URL).trim();
const COMMENT_TEXT = process.env.AIDCP_TIKTOK_PROBE_COMMENT_TEXT?.trim();

function boolEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').trim().toLowerCase());
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

async function navigateAndSettle(session: EdgeSession, url: string): Promise<void> {
  await session.cdp.send('Page.navigate', { url });
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const href = await evalRaw<string>(session.cdp, 'String(location.href)').catch(() => '');
    const ready = await evalRaw<string>(session.cdp, 'String(document.readyState)').catch(() => '');
    if (isTikTokTargetUrl(href) && (ready === 'interactive' || ready === 'complete')) break;
    await sleep(500);
  }
  await sleep(7_000);
}

async function verifyDirectProfileEndpoint(port: number, profileId: string): Promise<void> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('AIDCP_TIKTOK_PROBE_CDP_PORT 无效');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`直接 CDP 端点不可用（status=${response.status}）`);
  const targets = (await response.json()) as Array<{ type?: string; url?: string }>;
  if (!hasExactAdsPowerProfileMarker(targets, profileId)) {
    throw new Error('直接 CDP 端点没有与目标 profile 精确匹配的 AdsPower marker，拒绝连接');
  }
}

interface TikTokProbeReport {
  generatedAt: string;
  profileId: string;
  requestedHost: string;
  initial: TikTokSafeSnapshot;
  browsing: TikTokBrowseResult[];
  beforeDraft: TikTokSafeSnapshot;
  like: TikTokLikeResult;
  comment?: TikTokCommentResult;
  browserKeptOpen: boolean;
  endpointSource: 'adspower_api' | 'profile_marker';
  boundary: 'manual_probe_only';
}

async function main(): Promise<void> {
  if (!PROFILE_ID) throw new Error('缺少 AdsPower profile id；请通过首个参数或 AIDCP_ADS_USER_ID 指定');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(PROFILE_ID)) throw new Error('AdsPower profile id 格式无效');
  if (!isTikTokTargetUrl(START_URL)) throw new Error('AIDCP_TIKTOK_START_URL 必须是 tiktok.com 网页');

  const browseSteps = boundedInt(process.env.AIDCP_TIKTOK_PROBE_BROWSE_STEPS, 2, 0, 5);
  const executeLike = boolEnv('AIDCP_TIKTOK_PROBE_LIKE');
  const stopBrowser = boolEnv('AIDCP_TIKTOK_PROBE_STOP');
  const confirmedProfile = process.env.AIDCP_TIKTOK_PROBE_CONFIRM_PROFILE?.trim();
  const directPortRaw = process.env.AIDCP_TIKTOK_PROBE_CDP_PORT?.trim();
  const directPort = directPortRaw ? Number(directPortRaw) : undefined;
  if (directPort !== undefined && stopBrowser) {
    throw new Error('直接 CDP 模式不能设置 AIDCP_TIKTOK_PROBE_STOP；本模式只断开探针，不接管浏览器生命周期');
  }
  let launched: Awaited<ReturnType<ReturnType<typeof selectBrowserProvider>['launch']>> | undefined;
  let endpoint: { host: string; port: number };
  let endpointSource: TikTokProbeReport['endpointSource'];
  if (directPort !== undefined) {
    await verifyDirectProfileEndpoint(directPort, PROFILE_ID);
    endpoint = { host: '127.0.0.1', port: directPort };
    endpointSource = 'profile_marker';
    console.log(`[tiktok-probe] 使用已由 AdsPower profile marker 自证的现存 CDP 端点 port=${directPort}`);
  } else {
    const provider = selectBrowserProvider({
      env: {
        ...process.env,
        AIDCP_BROWSER_PROVIDER: 'adspower',
        AIDCP_ADS_USER_ID: PROFILE_ID,
      },
      startUrl: START_URL,
      logImpl: (message) => console.log(message),
    });
    launched = await provider.launch({
      host: '127.0.0.1',
      port: Number(process.env.AIDCP_CDP_PORT ?? 9222),
      headless: false,
      readyTimeoutMs: Number(process.env.AIDCP_CDP_READY_TIMEOUT_MS ?? 20_000),
    });
    endpoint = launched.endpoint;
    endpointSource = 'adspower_api';
  }
  let session: EdgeSession | undefined;
  try {
    session = await attachToPage({
      host: endpoint.host,
      port: endpoint.port,
      stealth: false,
      reconnect: false,
    });
    await navigateAndSettle(session, START_URL);

    const probe = new TikTokInteractionProbe(session.cdp);
    const initial = await probe.inspect();
    console.log(
      `[tiktok-probe] profile=${PROFILE_ID} host=${initial.host} path=${initial.path} ` +
        `block=${initial.blockReason} login=${initial.loginState} video=${initial.current?.videoId ?? '-'} ` +
        `ambiguous=${initial.currentAmbiguous}`,
    );

    const browsing: TikTokBrowseResult[] = [];
    for (let index = 0; index < browseSteps; index++) {
      const result = await probe.browseNext();
      browsing.push(result);
      console.log(
        `[tiktok-probe] browse#${index + 1} status=${result.status} executed=${result.executed} ` +
          `before=${result.beforeVideoId ?? '-'} after=${result.afterVideoId ?? '-'}`,
      );
      if (result.status !== 'browsed') break;
      await sleep(1_500);
    }

    const like = await probe.likeCurrent({
      profileId: PROFILE_ID,
      execute: executeLike,
      confirmedProfile,
    });
    console.log(
      `[tiktok-probe] like status=${like.status} executed=${like.executed} video=${like.videoId ?? '-'} ` +
        `before=${like.beforeState ?? '-'} after=${like.afterState ?? '-'} confirmation=${like.confirmation}`,
    );

    const beforeDraft = await probe.inspect();
    let comment: TikTokCommentResult | undefined;
    if (COMMENT_TEXT) {
      comment = await probe.fillCommentDraft(COMMENT_TEXT);
      console.log(
        `[tiktok-probe] comment status=${comment.status} executed=${comment.executed} video=${comment.videoId ?? '-'} ` +
          `textLength=${comment.textLength} matched=${comment.matched} submitted=${comment.submitted}`,
      );
    } else {
      console.log('[tiktok-probe] comment skipped（未设置 AIDCP_TIKTOK_PROBE_COMMENT_TEXT）');
    }

    const report: TikTokProbeReport = {
      generatedAt: new Date().toISOString(),
      profileId: PROFILE_ID,
      requestedHost: new URL(START_URL).hostname,
      initial: toTikTokSafeSnapshot(initial),
      browsing,
      beforeDraft: toTikTokSafeSnapshot(beforeDraft),
      like,
      comment,
      browserKeptOpen: !stopBrowser,
      endpointSource,
      boundary: 'manual_probe_only',
    };
    console.log(`[tiktok-probe] report=${JSON.stringify(report)}`);

    const browseOk = browseSteps === 0 || browsing.some((result) => result.status === 'browsed');
    const likeOk = executeLike ? ['ui_confirmed', 'already_liked'].includes(like.status) : like.status === 'shadow' || like.status === 'already_liked';
    const commentOk = !COMMENT_TEXT || comment?.status === 'filled_not_submitted';
    if (!browseOk || !likeOk || !commentOk) process.exitCode = 1;
  } finally {
    try {
      session?.close();
    } catch {
      // best effort: closing the CDP client does not close the AdsPower browser
    }
    if (stopBrowser) {
      if (!launched) throw new Error('缺少 AdsPower 生命周期句柄，无法确认关闭');
      const stopped = await launched.instance.killAndConfirmDead();
      console.log(`[tiktok-probe] AdsPower browser stop confirmed=${stopped}`);
      if (!stopped) process.exitCode = 1;
    } else {
      console.log('[tiktok-probe] AdsPower 浏览器保持打开');
    }
  }
}

main().catch((error) => {
  console.error(`[tiktok-probe] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
