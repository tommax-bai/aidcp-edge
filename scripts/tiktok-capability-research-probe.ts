#!/usr/bin/env tsx
/**
 * Read-only TikTok Web capability inventory for one explicitly named AdsPower profile.
 *
 * The runner creates and closes only its own temporary tabs. It never clicks a
 * platform control, opens an editor, types content, submits, or stops the profile.
 *
 * Usage:
 *   npx tsx scripts/tiktok-capability-research-probe.ts <adspower_profile_id>
 */
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { attachToPage, selectBrowserProvider, type EdgeSession } from '../src/cdp/index.js';
import {
  TIKTOK_OFFICIAL_API_READINESS,
  TIKTOK_START_URL,
  TikTokCapabilityResearchProbe,
  type TikTokCapabilityResearchSnapshot,
} from '../src/tiktok/index.js';

const PROFILE_ID = (process.argv[2] ?? process.env.AIDCP_ADS_USER_ID ?? '').trim();

interface SurfaceResult {
  snapshot: TikTokCapabilityResearchSnapshot;
  profileUrl?: string;
}

async function openInspectClose(
  controller: EdgeSession,
  endpoint: { host: string; port: number },
  url: string,
): Promise<SurfaceResult> {
  const created = await controller.cdp.send<{ targetId: string }>('Target.createTarget', { url });
  let session: EdgeSession | undefined;
  try {
    await controller.cdp.send('Target.activateTarget', { targetId: created.targetId });
    session = await attachToPage({
      host: endpoint.host,
      port: endpoint.port,
      targetPredicate: (target) => target.id === created.targetId,
      stealth: false,
      reconnect: false,
      client: { timeoutMs: 30_000 },
    });
    const probe = new TikTokCapabilityResearchProbe(session.cdp);
    let snapshot = await probe.inspect();
    for (let attempt = 0; attempt < 6 && !snapshot.hydrated; attempt += 1) {
      await sleep(5_000);
      snapshot = await probe.inspect();
    }
    const profile = await probe.discoverOwnProfileUrl();
    return {
      snapshot,
      profileUrl: profile.status === 'ready' ? profile.href : undefined,
    };
  } finally {
    try {
      session?.close();
    } catch {}
    await controller.cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (!PROFILE_ID) throw new Error('缺少 AdsPower profile id');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(PROFILE_ID)) throw new Error('AdsPower profile id 格式无效');

  const provider = selectBrowserProvider({
    env: { ...process.env, AIDCP_BROWSER_PROVIDER: 'adspower', AIDCP_ADS_USER_ID: PROFILE_ID },
    startUrl: TIKTOK_START_URL,
    logImpl: (message) => console.log(message),
  });
  const launched = await provider.launch({
    host: '127.0.0.1',
    port: Number(process.env.AIDCP_CDP_PORT ?? 9222),
    headless: false,
    readyTimeoutMs: 30_000,
  });

  const controller = await attachToPage({
    host: launched.endpoint.host,
    port: launched.endpoint.port,
    urlIncludes: 'tiktok.com',
    stealth: false,
    reconnect: false,
    client: { timeoutMs: 30_000 },
  });
  try {
    const forYou = await openInspectClose(controller, launched.endpoint, 'https://www.tiktok.com/foryou');
    const following = await openInspectClose(controller, launched.endpoint, 'https://www.tiktok.com/following');
    const profileUrl = forYou.profileUrl ?? following.profileUrl;
    const profile = profileUrl
      ? await openInspectClose(controller, launched.endpoint, profileUrl)
      : undefined;
    const surfaces = {
      forYou: forYou.snapshot,
      following: following.snapshot,
      profile: profile?.snapshot ?? null,
    };
    const report = {
      generatedAt: new Date().toISOString(),
      profileId: PROFILE_ID,
      endpointSource: 'adspower_api' as const,
      surfaces,
      officialApiReadiness: TIKTOK_OFFICIAL_API_READINESS,
      replyLanguage: 'unconfigured' as const,
      replyBlocked: true as const,
      actionsExecuted: [] as const,
      submitted: false as const,
      browserKeptOpen: true as const,
      boundary: 'read_only_capability_research' as const,
    };
    console.log(`[tiktok-capability-research] report=${JSON.stringify(report)}`);
    if (!forYou.snapshot.hydrated || forYou.snapshot.blockReason !== 'none') process.exitCode = 1;
  } finally {
    controller.close();
    console.log('[tiktok-capability-research] 临时标签页已关闭；AdsPower 浏览器保持打开；未点击、未输入、未发送');
  }
}

main().catch((error) => {
  console.error(`[tiktok-capability-research] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
