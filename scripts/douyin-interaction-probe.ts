#!/usr/bin/env tsx
/**
 * Bounded Douyin web probe for one explicitly named local AdsPower profile.
 *
 * Every real external side effect requires its own action flag plus an exact profile confirmation:
 *   AIDCP_DOUYIN_PROBE_LIKE=1
 *   AIDCP_DOUYIN_PROBE_FOLLOW=1
 *   AIDCP_DOUYIN_PROBE_COLLECT=1
 *   AIDCP_DOUYIN_PROBE_DM_REPLY=1             (body fixed to 好的)
 *   AIDCP_DOUYIN_PROBE_LIVE_CHAT=1            (body fixed to 1111)
 *   AIDCP_DOUYIN_PROBE_LIVE_COMMENT_REPLY=1   (body fixed to 666)
 *   AIDCP_DOUYIN_PROBE_CONFIRM_PROFILE=<exact profile id>
 *
 * The probe never submits an ordinary post comment, uploads, or publishes.
 */
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { evalRaw } from '../src/browse/index.js';
import { attachToPage, selectBrowserProvider, type EdgeSession } from '../src/cdp/index.js';
import {
  DOUYIN_LIVE_URL,
  DOUYIN_START_URL,
  DouyinInteractionProbe,
  hasExactAdsPowerProfileMarker,
  isDouyinTargetUrl,
  toDouyinSafeSnapshot,
  type ActionResult,
  type DouyinSafeSnapshot,
  type MessageResult,
} from '../src/douyin/index.js';

const PROFILE_ID = (process.argv[2] ?? process.env.AIDCP_ADS_USER_ID ?? '').trim();
const START_URL = (process.env.AIDCP_DOUYIN_START_URL ?? DOUYIN_START_URL).trim();

function boolEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').trim().toLowerCase());
}

async function navigateAndSettle(session: EdgeSession, url: string, settleMs = 7_000): Promise<void> {
  await session.cdp.send('Page.navigate', { url });
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const href = await evalRaw<string>(session.cdp, 'String(location.href)').catch(() => '');
    const ready = await evalRaw<string>(session.cdp, 'String(document.readyState)').catch(() => '');
    if (isDouyinTargetUrl(href) && (ready === 'interactive' || ready === 'complete')) break;
    await sleep(500);
  }
  await sleep(settleMs);
}

async function verifyDirectProfileEndpoint(port: number, profileId: string): Promise<void> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('AIDCP_DOUYIN_PROBE_CDP_PORT 无效');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`直接 CDP 端点不可用（status=${response.status}）`);
  const targets = (await response.json()) as Array<{ type?: string; url?: string }>;
  if (!hasExactAdsPowerProfileMarker(targets, profileId)) throw new Error('直接 CDP 端点没有精确匹配目标 profile 的 AdsPower marker，拒绝连接');
}

interface ProbeReport {
  generatedAt: string;
  profileId: string;
  endpointSource: 'adspower_api' | 'profile_marker';
  initial?: DouyinSafeSnapshot;
  open?: ActionResult;
  prompt?: ActionResult;
  like?: ActionResult;
  follow?: ActionResult;
  collect?: ActionResult;
  dm?: MessageResult;
  liveRoom?: ActionResult;
  liveChat?: MessageResult;
  liveReply?: MessageResult;
  browserKeptOpen: true;
  boundary: 'manual_probe_only';
}

function logAction(label: string, result: ActionResult): void {
  console.log(`[douyin-probe] ${label} status=${result.status} executed=${result.executed} before=${result.beforeState ?? '-'} after=${result.afterState ?? '-'} confirmation=${result.confirmation}`);
}

function logMessage(label: string, result: MessageResult): void {
  console.log(`[douyin-probe] ${label} status=${result.status} executed=${result.executed} textLength=${result.textLength} submitted=${result.submitted} confirmation=${result.confirmation}`);
}

async function main(): Promise<void> {
  if (!PROFILE_ID) throw new Error('缺少 AdsPower profile id');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(PROFILE_ID)) throw new Error('AdsPower profile id 格式无效');
  if (!isDouyinTargetUrl(START_URL)) throw new Error('AIDCP_DOUYIN_START_URL 必须是 douyin.com 网页');

  const flags = {
    like: boolEnv('AIDCP_DOUYIN_PROBE_LIKE'),
    follow: boolEnv('AIDCP_DOUYIN_PROBE_FOLLOW'),
    collect: boolEnv('AIDCP_DOUYIN_PROBE_COLLECT'),
    dm: boolEnv('AIDCP_DOUYIN_PROBE_DM_REPLY'),
    liveChat: boolEnv('AIDCP_DOUYIN_PROBE_LIVE_CHAT'),
    liveReply: boolEnv('AIDCP_DOUYIN_PROBE_LIVE_COMMENT_REPLY'),
  };
  const confirmedProfile = process.env.AIDCP_DOUYIN_PROBE_CONFIRM_PROFILE?.trim();
  const directPortRaw = process.env.AIDCP_DOUYIN_PROBE_CDP_PORT?.trim();
  const directPort = directPortRaw ? Number(directPortRaw) : undefined;

  let launched: Awaited<ReturnType<ReturnType<typeof selectBrowserProvider>['launch']>> | undefined;
  let endpoint: { host: string; port: number };
  let endpointSource: ProbeReport['endpointSource'];
  if (directPort !== undefined) {
    await verifyDirectProfileEndpoint(directPort, PROFILE_ID);
    endpoint = { host: '127.0.0.1', port: directPort };
    endpointSource = 'profile_marker';
    console.log(`[douyin-probe] 使用已由 AdsPower profile marker 自证的现存 CDP 端点 port=${directPort}`);
  } else {
    const provider = selectBrowserProvider({
      env: { ...process.env, AIDCP_BROWSER_PROVIDER: 'adspower', AIDCP_ADS_USER_ID: PROFILE_ID },
      startUrl: START_URL,
      logImpl: (message) => console.log(message),
    });
    launched = await provider.launch({ host: '127.0.0.1', port: Number(process.env.AIDCP_CDP_PORT ?? 9222), headless: false, readyTimeoutMs: Number(process.env.AIDCP_CDP_READY_TIMEOUT_MS ?? 20_000) });
    endpoint = launched.endpoint;
    endpointSource = 'adspower_api';
  }

  let session: EdgeSession | undefined;
  const report: ProbeReport = { generatedAt: new Date().toISOString(), profileId: PROFILE_ID, endpointSource, browserKeptOpen: true, boundary: 'manual_probe_only' };
  try {
    session = await attachToPage({
      host: endpoint.host,
      port: endpoint.port,
      stealth: false,
      reconnect: false,
      targetPredicate: (target) => {
        try {
          const url = new URL(target.url);
          return url.hostname === 'www.douyin.com';
        } catch {
          return false;
        }
      },
    });
    await session.cdp.send('Page.bringToFront');
    const probe = new DouyinInteractionProbe(session.cdp);

    if (flags.like || flags.follow || flags.collect) {
      await navigateAndSettle(session, START_URL);
      report.initial = toDouyinSafeSnapshot(await probe.inspect());
      console.log(`[douyin-probe] initial host=${report.initial.host} path=${report.initial.path} block=${report.initial.blockReason} login=${report.initial.loginState}`);
      report.open = await probe.openCurrentCard();
      logAction('open', report.open);
      report.prompt = await probe.dismissKnownInteractionPrompt();
      logAction('interaction-prompt', report.prompt);
      if (flags.like) {
        report.like = await probe.likeCurrent({ profileId: PROFILE_ID, execute: true, confirmedProfile });
        logAction('like', report.like);
      }
      if (flags.follow) {
        report.follow = await probe.followCurrent({ profileId: PROFILE_ID, execute: true, confirmedProfile });
        logAction('follow', report.follow);
      }
      if (flags.collect) {
        report.collect = await probe.collectCurrent({ profileId: PROFILE_ID, execute: true, confirmedProfile });
        logAction('collect', report.collect);
      }
    }

    if (flags.dm) {
      await navigateAndSettle(session, START_URL);
      report.dm = await probe.replyLatestInboundDm({ profileId: PROFILE_ID, execute: true, confirmedProfile, text: '好的' });
      logMessage('dm', report.dm);
    }

    if (flags.liveChat || flags.liveReply) {
      await navigateAndSettle(session, DOUYIN_LIVE_URL, 10_000);
      let liveState = await probe.inspectLive();
      if (!liveState.chatEditor.found) {
        report.liveRoom = await probe.enterFirstLiveRoom();
        logAction('live-room', report.liveRoom);
        await sleep(5_000);
        liveState = await probe.inspectLive();
      }
      if (flags.liveChat) {
        report.liveChat = await probe.sendLiveChat({ profileId: PROFILE_ID, execute: true, confirmedProfile, text: '1111' });
        logMessage('live-chat', report.liveChat);
      }
      if (flags.liveReply) {
        report.liveReply = await probe.replyLiveComment({ profileId: PROFILE_ID, execute: true, confirmedProfile, text: '666' });
        logMessage('live-reply', report.liveReply);
      }
    }

    console.log(`[douyin-probe] report=${JSON.stringify(report)}`);
    const results = [report.like, report.follow, report.collect, report.dm, report.liveChat, report.liveReply].filter((value): value is ActionResult | MessageResult => Boolean(value));
    if (results.some((value) => !['ui_confirmed', 'already_active'].includes(value.status))) process.exitCode = 1;
  } finally {
    try { session?.close(); } catch { /* disconnect only; keep AdsPower open */ }
    console.log('[douyin-probe] AdsPower 浏览器保持打开');
    void launched;
  }
}

main().catch((error) => {
  console.error(`[douyin-probe] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
