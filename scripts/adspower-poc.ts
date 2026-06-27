#!/usr/bin/env tsx
/**
 * adspower-poc.ts — P0 PoC：验证 edge 现成 CDP/定位/拟人/读身份能【零改动】驱动 AdsPower 启动的浏览器。
 *
 * 目的（"换启动层、留连接层"的可行性证明）：
 *   - 不碰任何主代码（main.ts / chrome-launcher 一行不改）；
 *   - 走 AdsPower 本地 API `browser/start` 拿到标准 DevTools `debug_port`；
 *   - 把该端口直接喂给现成的 `attachToPage`，复用现成的 `readSelfIdentity` / `evalRaw` / `dispatchClick`；
 *   - 证实：AdsPower 暴露的 CDP 端点与 edge 的接入层完全兼容，定位/拟人/读身份无需改动即可跑通；
 *   - 顺带核对 AdsPower 的 cdp_mask（在 edge 自研 stealth 关闭=stealth:false 的前提下）是否仍藏住 navigator.webdriver。
 *
 * 前置：
 *   - AdsPower 客户端已运行、本地 API 已开启（默认 http://local.adspower.net:50325）；
 *   - 已建好一个 AdsPower profile 并在其中登录了目标小红书测试账号（登录态由 AdsPower profile 持久化）；
 *   - 取得该 profile 的 user_id。
 *
 * 用法：
 *   npx tsx scripts/adspower-poc.ts <user_id>
 *   # 或 AIDCP_ADS_USER_ID=<user_id> npx tsx scripts/adspower-poc.ts
 *
 * 可选环境变量：
 *   AIDCP_ADS_API_BASE   本地 API 基址（默认 http://local.adspower.net:50325）
 *   AIDCP_ADS_USER_ID    AdsPower profile id（也可作为第一个命令行参数）
 *   AIDCP_ADS_API_KEY    若 AdsPower 开了安全校验，填 API Key（作 Bearer）
 *   AIDCP_ADS_HEADLESS   '1' 启用 headless（默认 '0'：headed，便于肉眼观察）
 *   AIDCP_ADS_START_URL  起始页（默认小红书 explore）
 */
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { attachToPage, readSelfIdentity } from '../src/cdp/index.js';
import { evalRaw, dispatchClick } from '../src/browse/index.js';

const API_BASE = process.env.AIDCP_ADS_API_BASE ?? 'http://local.adspower.net:50325';
const USER_ID = process.argv[2] ?? process.env.AIDCP_ADS_USER_ID ?? '';
const API_KEY = process.env.AIDCP_ADS_API_KEY;
const HEADLESS = process.env.AIDCP_ADS_HEADLESS ?? '0';
const START_URL = process.env.AIDCP_ADS_START_URL ?? 'https://www.xiaohongshu.com/explore';

interface AdsResp<T> {
  code: number;
  msg?: string;
  data?: T;
}
interface AdsStartData {
  ws?: { selenium?: string; puppeteer?: string };
  debug_port?: string | number;
  webdriver?: string;
}

/** 本地 API 限速 1 req/s——start/active/stop 之间天然有 attach/导航的耗时间隔，不会触限。 */
async function adsApi<T>(path: string, params: Record<string, string>): Promise<AdsResp<T>> {
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = {};
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const res = await fetch(`${API_BASE}${path}?${qs}`, { headers });
  return (await res.json()) as AdsResp<T>;
}

async function startBrowser(): Promise<{ host: string; port: number }> {
  // 固定桌面视口经 launch_args 传入：否则会落进小红书窄屏布局变体，定位/滚动选择器全失效
  // （见 docs/xhs-layout-states.md：宽/窄两套布局，真机实测必须钉死桌面视口）。
  const launchArgs = ['--window-size=1440,980'];
  const resp = await adsApi<AdsStartData>('/api/v1/browser/start', {
    user_id: USER_ID,
    open_tabs: '1', // 关掉平台/历史页，留干净标签
    ip_tab: '0', // 不弹 IP 检测页
    headless: HEADLESS,
    launch_args: JSON.stringify(launchArgs),
  });
  if (resp.code !== 0 || !resp.data?.debug_port) {
    throw new Error(
      `browser/start 失败：code=${resp.code} msg=${resp.msg ?? ''}。` +
        '请确认 AdsPower 已运行、本地 API 已开启、user_id 正确（必要时填 AIDCP_ADS_API_KEY）。',
    );
  }
  const port = Number(resp.data.debug_port);
  console.log(
    `[poc] AdsPower 已启动 profile=${USER_ID} → debug_port=${port}  ws.puppeteer=${resp.data.ws?.puppeteer ?? '(none)'}`,
  );
  return { host: '127.0.0.1', port };
}

async function stopBrowser(): Promise<void> {
  try {
    const resp = await adsApi<unknown>('/api/v1/browser/stop', { user_id: USER_ID });
    console.log(`[poc] browser/stop → code=${resp.code} msg=${resp.msg ?? ''}`);
  } catch (e) {
    console.warn(`[poc] browser/stop 异常（可忽略）：${(e as Error).message}`);
  }
}

async function waitCdpReady(host: string, port: number, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://${host}:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* 未就绪，继续轮询 */
    }
    if (Date.now() >= deadline) throw new Error(`CDP /json/version 未就绪（${timeoutMs}ms）`);
    await sleep(300);
  }
}

/** 测量滚动信号：宽布局走 window/document、窄布局走内层 .feeds-page，外加 feed 卡片数（懒加载会增长）。 */
const MEASURE_JS = `JSON.stringify({
  winY: Math.round(window.scrollY || 0),
  feedY: Math.round(((document.querySelector('.feeds-page') || document.scrollingElement || {}).scrollTop) || 0),
  cards: document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"],section[class*="note"]').length
})`;

interface ScrollSignal {
  winY?: number;
  feedY?: number;
  cards?: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  if (!USER_ID) {
    console.error('用法: npx tsx scripts/adspower-poc.ts <user_id>   （或设 AIDCP_ADS_USER_ID）');
    process.exitCode = 2;
    return;
  }

  const checks: Check[] = [];
  const { host, port } = await startBrowser();
  let closeSession: (() => void) | undefined;

  try {
    await waitCdpReady(host, port);

    // ── C1：现成 attachToPage 直接连上 AdsPower 的 debug_port（stealth 关闭，交给 AdsPower cdp_mask）
    const session = await attachToPage({ host, port, stealth: false });
    closeSession = () => session.close();
    const cdp = session.cdp;
    checks.push({ name: 'C1 现成 attachToPage 连上 AdsPower debug_port', ok: true, detail: `host=${host} port=${port}` });

    // ── C2：导航到小红书并等加载完成
    await cdp.send('Page.navigate', { url: START_URL });
    let href = '';
    let ready = false;
    {
      const deadline = Date.now() + 25_000;
      for (;;) {
        href = await evalRaw<string>(cdp, 'String(location.href)').catch(() => '');
        const rs = await evalRaw<string>(cdp, 'String(document.readyState)').catch(() => '');
        ready = href.includes('xiaohongshu.com') && rs === 'complete';
        if (ready || Date.now() >= deadline) break;
        await sleep(500);
      }
    }
    checks.push({ name: 'C2 导航到小红书并加载完成', ok: ready, detail: `href=${href}` });
    await sleep(1500); // 给 feed/侧栏 hydrate 一点时间

    // ── C3：反检测自洽（cdp_mask 开 + edge stealth 关 → navigator.webdriver 不应暴露）
    const webdriver = await evalRaw<string>(cdp, 'String(navigator.webdriver)').catch(() => 'err');
    const hasChrome = await evalRaw<string>(cdp, 'String(!!window.chrome)').catch(() => '?');
    const ua = await evalRaw<string>(cdp, 'String(navigator.userAgent)').catch(() => '');
    const c3ok = webdriver === 'false' || webdriver === 'undefined';
    checks.push({
      name: 'C3 反检测自洽（navigator.webdriver 未暴露）',
      ok: c3ok,
      detail: `webdriver=${webdriver}  window.chrome=${hasChrome}  ua=${ua.slice(0, 64)}…`,
    });

    // ── C4：现成 readSelfIdentity 读出登录账号 id（含两套布局兼容的本人锚点逻辑）
    const idRes = await readSelfIdentity(cdp, { logger: (m) => console.log('  ' + m) });
    checks.push({
      name: 'C4 现成 readSelfIdentity 读出登录账号 id',
      ok: idRes.ok,
      detail: idRes.ok
        ? `accountId=${idRes.identity.accountId} source=${idRes.identity.source}`
        : `失败：${idRes.reason}（确认该 AdsPower profile 已登录目标小红书账号）`,
    });

    // ── C5：拟人 CDP 输入真实生效（贝塞尔移动 + 滚轮）→ 页面应滚动 / 懒加载新卡片
    const before = JSON.parse(await evalRaw<string>(cdp, MEASURE_JS).catch(() => '{}')) as ScrollSignal;
    await dispatchClick(cdp, 720, 500).catch(() => undefined); // cdp-util 真实拟人原语：贝塞尔逐帧移动 + 点击
    for (let i = 0; i < 5; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 720, y: 500, deltaX: 0, deltaY: 700 });
      await sleep(350);
    }
    await sleep(1200);
    const after = JSON.parse(await evalRaw<string>(cdp, MEASURE_JS).catch(() => '{}')) as ScrollSignal;
    const moved =
      (after.winY ?? 0) > (before.winY ?? 0) ||
      (after.feedY ?? 0) > (before.feedY ?? 0) ||
      (after.cards ?? 0) > (before.cards ?? 0);
    checks.push({
      name: 'C5 拟人 CDP 输入（贝塞尔移动 + 滚轮）真实生效',
      ok: moved,
      detail: `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    });
  } finally {
    if (closeSession) {
      try {
        closeSession();
      } catch {
        /* best-effort */
      }
    }
    await stopBrowser();
  }

  // ── 报告
  console.log('\n==== AdsPower PoC 结果 ====');
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}\n     ${c.detail}`);
  const core = checks.filter((c) => /^C[1245]/.test(c.name));
  const pass = core.length === 4 && core.every((c) => c.ok);
  console.log(
    `\n核心结论：${
      pass
        ? '✅ 通过 —— edge 现成 CDP/定位/拟人/读身份可【零改动】驱动 AdsPower 浏览器，P1（Provider 抽象）可投入。'
        : '❌ 未通过 —— 见上方失败项；attach/导航/读身份/拟人滚动须全绿才算可行。'
    }`,
  );
  const c3 = checks.find((c) => c.name.startsWith('C3'));
  if (c3 && !c3.ok) {
    console.log('⚠ C3：navigator.webdriver 仍暴露 → 需在 AdsPower 开启 cdp_mask，或该 profile 下保留 edge stealth；指纹自洽待进一步核验。');
  }
  process.exitCode = pass ? 0 : 1;
}

process.on('SIGINT', () => {
  console.log('\n[poc] 收到 SIGINT，停止 AdsPower 浏览器…');
  void stopBrowser().finally(() => process.exit(130));
});

main().catch((e) => {
  console.error(`[poc] 致命错误：${(e as Error).stack ?? (e as Error).message}`);
  process.exitCode = 1;
});
