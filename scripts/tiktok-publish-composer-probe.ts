#!/usr/bin/env tsx
/**
 * TikTok upload/composer probe for one explicitly named local AdsPower profile.
 *
 * This runner can select a caller-provided synthetic video and fill a caption draft.
 * It intentionally has no final-publish flag or final-publish action and always keeps
 * the browser open for operator inspection.
 *
 * Usage:
 *   npx tsx scripts/tiktok-publish-composer-probe.ts <adspower_profile_id>
 *
 * Optional environment:
 *   AIDCP_TIKTOK_PROBE_CDP_PORT=<existing profile-bound CDP port>
 *   AIDCP_TIKTOK_PROBE_MEDIA_PATH=<absolute synthetic video path>
 *   AIDCP_TIKTOK_PROBE_CAPTION_TEXT=<single-line probe caption>
 */
import { stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { evalRaw } from '../src/browse/index.js';
import { attachToPage, selectBrowserProvider, type EdgeSession } from '../src/cdp/index.js';
import {
  TIKTOK_START_URL,
  TikTokPublishComposerProbe,
  hasExactAdsPowerProfileMarker,
  isTikTokTargetUrl,
  type TikTokCaptionDraftResult,
  type TikTokStageFileResult,
  type TikTokUploadPageSnapshot,
} from '../src/tiktok/index.js';

const PROFILE_ID = (process.argv[2] ?? process.env.AIDCP_ADS_USER_ID ?? '').trim();
const MEDIA_PATH = process.env.AIDCP_TIKTOK_PROBE_MEDIA_PATH?.trim();
const CAPTION_TEXT = process.env.AIDCP_TIKTOK_PROBE_CAPTION_TEXT?.trim();

async function verifyDirectProfileEndpoint(port: number, profileId: string): Promise<void> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('AIDCP_TIKTOK_PROBE_CDP_PORT 无效');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`直接 CDP 端点不可用（status=${response.status}）`);
  const targets = (await response.json()) as Array<{ type?: string; url?: string }>;
  if (!hasExactAdsPowerProfileMarker(targets, profileId)) {
    throw new Error('直接 CDP 端点没有与目标 profile 精确匹配的 AdsPower marker，拒绝连接');
  }
}

async function settleOnUploadPage(session: EdgeSession): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await evalRaw<{ href: string; ready: string }>(
      session.cdp,
      `({href:String(location.href),ready:String(document.readyState)})`,
    ).catch(() => ({ href: '', ready: '' }));
    if (/\/tiktokstudio\/upload/i.test(state.href) && (state.ready === 'interactive' || state.ready === 'complete')) {
      await sleep(5_000);
      return;
    }
    await sleep(500);
  }
  throw new Error('TikTok Studio 上传页未在时限内就绪');
}

function safeSnapshot(snapshot: TikTokUploadPageSnapshot): TikTokUploadPageSnapshot {
  return snapshot;
}

async function validateSyntheticMedia(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('AIDCP_TIKTOK_PROBE_MEDIA_PATH 必须是绝对路径');
  if (!['.mp4', '.mov', '.webm'].includes(extname(path).toLowerCase())) throw new Error('探针素材必须是 mp4、mov 或 webm 视频');
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error('探针素材必须是非空普通文件');
  if (info.size > 25 * 1024 * 1024) throw new Error('探针素材超过 25 MiB 安全上限');
}

async function main(): Promise<void> {
  if (!PROFILE_ID) throw new Error('缺少 AdsPower profile id');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(PROFILE_ID)) throw new Error('AdsPower profile id 格式无效');
  if (CAPTION_TEXT && !MEDIA_PATH) throw new Error('只有提供合成视频时才允许填写发布文案');
  if (MEDIA_PATH) await validateSyntheticMedia(MEDIA_PATH);

  const directPortRaw = process.env.AIDCP_TIKTOK_PROBE_CDP_PORT?.trim();
  const directPort = directPortRaw ? Number(directPortRaw) : undefined;
  let launched: Awaited<ReturnType<ReturnType<typeof selectBrowserProvider>['launch']>> | undefined;
  let endpoint: { host: string; port: number };
  let endpointSource: 'adspower_api' | 'profile_marker';
  if (directPort !== undefined) {
    await verifyDirectProfileEndpoint(directPort, PROFILE_ID);
    endpoint = { host: '127.0.0.1', port: directPort };
    endpointSource = 'profile_marker';
  } else {
    const provider = selectBrowserProvider({
      env: { ...process.env, AIDCP_BROWSER_PROVIDER: 'adspower', AIDCP_ADS_USER_ID: PROFILE_ID },
      startUrl: TIKTOK_START_URL,
      logImpl: (message) => console.log(message),
    });
    launched = await provider.launch({ host: '127.0.0.1', port: Number(process.env.AIDCP_CDP_PORT ?? 9222), headless: false });
    endpoint = launched.endpoint;
    endpointSource = 'adspower_api';
  }

  let session: EdgeSession | undefined;
  try {
    session = await attachToPage({ host: endpoint.host, port: endpoint.port, urlIncludes: 'tiktok.com', stealth: false, reconnect: false });
    const probe = new TikTokPublishComposerProbe(session.cdp);
    const href = await evalRaw<string>(session.cdp, 'String(location.href)');
    if (!isTikTokTargetUrl(href)) throw new Error('当前附着页面不是 TikTok');
    if (!/\/tiktokstudio\/upload/i.test(href)) {
      const entry = await probe.inspectUploadEntry();
      console.log(`[tiktok-publish-probe] entry status=${entry.status} block=${entry.blockReason} candidates=${entry.candidateCount}`);
      if (entry.status !== 'ready' || !entry.href) throw new Error(`上传入口不可唯一确认（status=${entry.status}）`);
      await session.cdp.send('Page.navigate', { url: entry.href });
    }
    await settleOnUploadPage(session);

    const initial = await probe.inspectUploadPage();
    console.log(
      `[tiktok-publish-probe] page host=${initial.host} path=${initial.path} block=${initial.blockReason} ` +
        `fileInputs=${initial.fileInputCount} accept=${initial.fileInputAccept ?? '-'} fields=${initial.fieldKinds.length}`,
    );

    let stage: TikTokStageFileResult | undefined;
    let caption: TikTokCaptionDraftResult | undefined;
    if (MEDIA_PATH) {
      console.log('[tiktok-publish-probe] 正在把无敏感合成素材交给 TikTok 页面；这可能形成平台侧暂存，但不会触发公开发布');
      stage = await probe.stageFile(MEDIA_PATH);
      console.log(
        `[tiktok-publish-probe] upload status=${stage.status} selected=${stage.fileSelected} ` +
          `acknowledged=${stage.uploadAcknowledged} composerReady=${stage.composerReady} submitted=${stage.submitted}`,
      );
      if (CAPTION_TEXT && stage.status === 'upload_acknowledged') {
        caption = await probe.fillCaptionDraft(CAPTION_TEXT);
        console.log(
          `[tiktok-publish-probe] caption status=${caption.status} executed=${caption.executed} ` +
            `textLength=${caption.textLength} matched=${caption.matched} submitted=${caption.submitted}`,
        );
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      profileId: PROFILE_ID,
      endpointSource,
      initial: safeSnapshot(initial),
      mediaProvided: Boolean(MEDIA_PATH),
      stage,
      caption,
      submitted: false as const,
      browserKeptOpen: true,
      boundary: 'composer_probe_only' as const,
    };
    console.log(`[tiktok-publish-probe] report=${JSON.stringify(report)}`);

    const readOnlyOk = initial.blockReason === 'none' && initial.fileInputCount === 1;
    const stageOk = !MEDIA_PATH || stage?.status === 'upload_acknowledged';
    const captionOk = !CAPTION_TEXT || caption?.status === 'composer_ready_not_submitted';
    if (!readOnlyOk || !stageOk || !captionOk) process.exitCode = 1;
  } finally {
    try { session?.close(); } catch {}
    console.log('[tiktok-publish-probe] AdsPower 浏览器保持打开；最终发布未执行');
    void launched;
  }
}

main().catch((error) => {
  console.error(`[tiktok-publish-probe] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
