#!/usr/bin/env tsx
/**
 * Probe the inline Follow control on one Facebook Reel.
 *
 * Default is read-only. A real follow requires both an explicit AdsPower profile id and
 * AIDCP_FB_PROBE_FOLLOW=1. The probe never unfollows and never falls back to another author.
 *
 * Usage:
 *   npx tsx scripts/fb-reels-follow-probe.ts <adspower_user_id>
 *   AIDCP_FB_PROBE_FOLLOW=1 npx tsx scripts/fb-reels-follow-probe.ts <adspower_user_id>
 */
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { evalRaw } from '../src/browse/index.js';
import { attachToPage } from '../src/cdp/index.js';
import {
  buildReelFollowTargetJs,
  FacebookReelsReader,
  type FacebookReelFollowTarget,
} from '../src/facebook/reels-reader.js';

const API_BASE = process.env.AIDCP_ADS_API_BASE ?? 'http://local.adspower.net:50325';
const USER_ID = process.argv[2] ?? process.env.AIDCP_ADS_USER_ID ?? '';
const TARGET_AUTHOR = process.env.AIDCP_FB_PROBE_AUTHOR ?? 'Salon de Comolis';
const TARGET_PROFILE_URL = process.env.AIDCP_FB_PROBE_PROFILE_URL
  ?? 'https://www.facebook.com/profile.php?id=61583901050321&sk=reels_tab';
const DO_FOLLOW = process.env.AIDCP_FB_PROBE_FOLLOW === '1';
const DO_STOP = process.env.AIDCP_FB_PROBE_STOP === '1';

interface AdsResponse<T> {
  code: number;
  msg?: string;
  data?: T;
}

interface AdsStartData {
  debug_port?: string | number;
}

interface ProfileProbe {
  href: string;
  title: string;
  login: boolean;
  checkpoint: boolean;
  reelLinks: string[];
}

async function adsGet<T>(path: string, params: Record<string, string>): Promise<AdsResponse<T>> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${API_BASE}${path}?${query}`);
  return (await response.json()) as AdsResponse<T>;
}

async function ensureBrowser(): Promise<{ host: string; port: number }> {
  if (!USER_ID) throw new Error('缺少 AdsPower user_id；请通过首个参数或 AIDCP_ADS_USER_ID 指定');
  const active = await adsGet<AdsStartData>('/api/v1/browser/active', { user_id: USER_ID }).catch(() => null);
  if (active?.code === 0 && active.data?.debug_port) {
    return { host: '127.0.0.1', port: Number(active.data.debug_port) };
  }
  const started = await adsGet<AdsStartData>('/api/v1/browser/start', {
    user_id: USER_ID,
    open_tabs: '1',
    ip_tab: '0',
    headless: '0',
    launch_args: JSON.stringify(['--window-size=1440,980']),
  });
  if (started.code !== 0 || !started.data?.debug_port) {
    throw new Error(`browser/start 失败：code=${started.code} msg=${started.msg ?? ''}`);
  }
  return { host: '127.0.0.1', port: Number(started.data.debug_port) };
}

async function stopBrowser(): Promise<void> {
  await adsGet('/api/v1/browser/stop', { user_id: USER_ID }).catch(() => undefined);
}

async function waitCdp(host: string, port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // bounded retry
    }
    await sleep(300);
  }
  throw new Error('CDP /json/version 未就绪');
}

async function navigate(cdp: { send(method: string, params?: unknown): Promise<unknown> }, url: string): Promise<void> {
  await cdp.send('Page.navigate', { url });
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const ready = await evalRaw<string>(cdp as never, 'String(document.readyState)').catch(() => '');
    const href = await evalRaw<string>(cdp as never, 'String(location.href)').catch(() => '');
    if (ready === 'complete' && href.includes('facebook.com')) break;
    await sleep(500);
  }
  await sleep(8_000);
}

const PROFILE_PROBE_JS = String.raw`(function(){
  function visible(el){if(!el||!el.getBoundingClientRect)return false;var r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>1&&r.height>1&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden';}
  function absolute(href){try{return new URL(href,location.href).href;}catch(e){return '';}}
  var body=String((document.body&&document.body.innerText)||'').slice(0,5000);
  var links=[];Array.from(document.querySelectorAll('a[href]')).forEach(function(a){var h=absolute(a.getAttribute('href')||'');if(!h||!/^https:\/\/(?:www\.)?facebook\.com\/reel\/[^/?#]+/i.test(h)||!visible(a)||links.indexOf(h)>=0)return;links.push(h);});
  return JSON.stringify({href:location.href,title:document.title,login:/(登录 Facebook|Log in to Facebook|Log Into Facebook)/i.test(body),checkpoint:/checkpoint/i.test(location.href),reelLinks:links.slice(0,20)});
})()`;

async function readProfile(cdp: unknown): Promise<ProfileProbe> {
  return JSON.parse(await evalRaw<string>(cdp as never, PROFILE_PROBE_JS)) as ProfileProbe;
}

async function readFollow(cdp: unknown): Promise<FacebookReelFollowTarget> {
  return JSON.parse(await evalRaw<string>(cdp as never, buildReelFollowTargetJs())) as FacebookReelFollowTarget;
}

async function main(): Promise<void> {
  const { host, port } = await ensureBrowser();
  let close: (() => void) | undefined;
  try {
    await waitCdp(host, port);
    const session = await attachToPage({ host, port, stealth: false });
    close = () => session.close();
    const cdp = session.cdp;

    console.log(`[probe] profile=${USER_ID} author=${TARGET_AUTHOR} real=${DO_FOLLOW}`);
    await navigate(cdp, TARGET_PROFILE_URL);
    const profile = await readProfile(cdp);
    console.log(`[probe] profile href=${profile.href} title=${profile.title} login=${profile.login} checkpoint=${profile.checkpoint} reelLinks=${profile.reelLinks.length}`);
    if (profile.login || profile.checkpoint) throw new Error('目标环境落在登录或 checkpoint 页面，零点击中止');
    if (!profile.reelLinks.length) throw new Error('目标 Reels 页没有可见 Reel 链接，零点击中止');

    await navigate(cdp, profile.reelLinks[0]);
    const before = await readFollow(cdp);
    console.log(`[probe] reel noteId=${before.noteId ?? '-'} author=${before.author ?? '-'} state=${before.state ?? '-'} label=${JSON.stringify(before.label ?? '')}`);
    if (!before.ok || !before.noteId || !before.found || before.ambiguous || before.authorMatches !== 1) {
      throw new Error('未唯一确认目标作者、关注控件和活动 Reel，零点击中止');
    }
    if (before.author !== TARGET_AUTHOR) {
      throw new Error(`活动 Reel 作者不是目标作者（actual=${JSON.stringify(before.author)}），零点击中止`);
    }

    const reader = new FacebookReelsReader({ cdp, sleep });
    const result = await reader.follow(before.noteId, !DO_FOLLOW);
    const after = await readFollow(cdp).catch(() => null);
    if (result.reason === 'already_followed') {
      console.log(`[probe] 结果=already_followed（平台当前已关注，未点击） label=${JSON.stringify(after?.label ?? before.label ?? '')}`);
      return;
    }
    if (result.reason === 'shadow') {
      console.log('[probe] 结果=shadow（已唯一定位，未设 AIDCP_FB_PROBE_FOLLOW=1，未点击）');
      return;
    }
    if (result.ok && result.executed && after?.noteId === before.noteId && after.author === TARGET_AUTHOR && after.state === 'following') {
      console.log(`[probe] 结果=followed label=${JSON.stringify(after.label ?? '')} text=${JSON.stringify(after.text ?? '')}`);
      return;
    }
    throw new Error(`关注执行未被同一 Reel 状态确认（reason=${result.reason ?? 'unknown'} executed=${result.executed}）`);
  } finally {
    try { close?.(); } catch { /* best effort */ }
    if (DO_STOP) await stopBrowser();
    else console.log('[probe] AdsPower 浏览器保持打开');
  }
}

main().catch((error) => {
  console.error(`[probe] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
