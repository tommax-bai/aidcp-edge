/**
 * notification-clear-probe.ts — XHS「看一眼某通知分类能否真清未读」执行端探针（非生产代码）
 * ===========================================================================
 * 只读 + 点 tab + 良性滚动；【绝不点赞、绝不评论、绝不关注、绝不写入任何账号状态】。
 * 可安全在已登录的真账号上跑。
 *
 * 目的（回答一个关乎整套通知巡视设计是否成立的问题）：
 *   云端「通知巡视」的正确性 rests on「看一眼分类就能把平台未读清掉」。
 *   边缘的未读检测是「边沿触发」——只在「无未读→有未读」翻转时上报一次（notification-monitor.ts:9）。
 *   若「看一眼」并不能让平台角标归零，则未读永久为真 → 再无新翻转 → 机器人对后续通知装聋。
 *   本探针在真机上量出真相：逐类「看一眼」前后角标变化，并 reload 页面确认是否服务端真清除。
 *
 * 方法（无漂移）：
 *   - 读未读用 production 同一段 JS（notification-monitor.ts 的 buildNotificationBadgeJs / buildNotificationHomeJs），
 *     探针与生产测的是同一口径。
 *   - 「看一眼」的 tab 点击 + 滚动逐字复刻 browse-session.ts（行号标注在下方），测的就是生产行为。
 *   - 额外尝试一个「宽松回退点击」，把两类失败分开：① 生产选择器没点中（实现 bug）vs ② 平台看了也不清（平台特性）。
 *
 * 运行（对一台已登录小红书、开着 9222 远程调试端口的 Chrome）：
 *   AIDCP_CDP_PORT=9222 npx tsx scripts/notification-clear-probe.ts
 * 前置：该账号当前需有未读（评论/@、赞收藏、新增关注任一）才测得出东西；三类全 0 会提示先制造未读。
 *
 * Env: AIDCP_CDP_HOST(127.0.0.1) / AIDCP_CDP_PORT(9222) / AIDCP_PAGE_URL(默认 'xiaohongshu' 子串过滤页面)。
 */
import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { attachToPage } from '../src/cdp/index.js';
import { evalRaw } from '../src/browse/cdp-util.js';
import { buildNotificationBadgeJs, buildNotificationHomeJs } from '../src/browse/notification-monitor.js';

const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const URL_INCLUDES = process.env.AIDCP_PAGE_URL ?? 'xiaohongshu';
const TS = new Date().toISOString().replace(/[:.]/g, '-');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Cdp = Awaited<ReturnType<typeof attachToPage>>['cdp'];
type Cat = 'comments' | 'likes' | 'follows';
type Home = { comments: number; likes: number; follows: number };
type Badge = { unread: boolean; count: number };

const CAT_LABEL: Record<Cat, string> = { comments: '评论/@', likes: '赞收藏', follows: '新增关注' };

async function waitFor(cdp: Cdp, expr: string, timeoutMs: number, intervalMs = 400): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evalRaw<boolean>(cdp, expr).catch(() => false);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function readHome(cdp: Cdp): Promise<Home> {
  const raw = await evalRaw<string>(cdp, buildNotificationHomeJs()).catch(() => '');
  try {
    return JSON.parse(raw) as Home;
  } catch {
    return { comments: 0, likes: 0, follows: 0 };
  }
}

async function readBadge(cdp: Cdp): Promise<Badge> {
  const raw = await evalRaw<string>(cdp, buildNotificationBadgeJs()).catch(() => '');
  try {
    return JSON.parse(raw) as Badge;
  } catch {
    return { unread: false, count: 0 };
  }
}

// 点入口去通知首页（逐字复刻 browse-session.ts:1389）。
const OPEN_ENTRY_JS = `(function(){ var a = document.querySelector('a[href*="/notification"]'); if(a){ a.click(); return true; } return false; })()`;

// 「看一眼」分类 tab 的点击——逐字复刻生产，以测真实行为：
//   comments: browse-session.ts:1415（精确「评论和@」或 ^评论 且含 @，故带角标数字也能命中）
//   likes/follows: browse-session.ts:1449（[class*="tab-item"] 叶子 + 标签正则 + length<=8）
function prodClickJs(cat: Cat): string {
  if (cat === 'comments') {
    return `(function(){ var els = Array.from(document.querySelectorAll('[class*="tab-item"]')); for (var i=0;i<els.length;i++){ var t=(els[i].textContent||'').trim(); if(t==='评论和@' || (/^评论/.test(t) && t.indexOf('@')>=0)){ els[i].click(); return true; } } return false; })()`;
  }
  const labelRe = cat === 'likes' ? '赞|收藏' : '关注|粉丝';
  return `(function(){ var els = Array.from(document.querySelectorAll('[class*="tab-item"]')); for (var i=0;i<els.length;i++){ var t=(els[i].textContent||'').trim(); if(t.length<=8 && new RegExp('${labelRe}').test(t)){ els[i].click(); return true; } } return false; })()`;
}

// 宽松回退点击：标签匹配即点（容许尾随角标数字、放宽长度）。用于把「生产选择器没点中」与「平台不清」分开。
function fallbackClickJs(cat: Cat): string {
  const labelRe = cat === 'comments' ? '评论|@' : cat === 'likes' ? '赞|收藏' : '关注|粉丝';
  return `(function(){ var els = Array.from(document.querySelectorAll('[class*="tab-item"]')); for (var i=0;i<els.length;i++){ var el=els[i]; var t=(el.textContent||'').trim(); if(t.length<=12 && new RegExp('${labelRe}').test(t)){ el.click(); return true; } } return false; })()`;
}

// 评论区滚动（逐字复刻 browse-session.ts:1419）。
const SCROLL_JS = `(function(){ window.scrollBy(0, document.documentElement.clientHeight*0.8); return true; })()`;

const TABS_PRESENT = 'document.querySelectorAll(\'[class*="tab-item"]\').length > 0';

/** 回通知首页顶部（点入口；点不中则 Page.navigate 兜底），等 tab 出现。 */
async function gotoNotificationHome(cdp: Cdp): Promise<boolean> {
  const clicked = await evalRaw<boolean>(cdp, OPEN_ENTRY_JS).catch(() => false);
  if (!clicked) {
    await cdp.send('Page.navigate', { url: 'https://www.xiaohongshu.com/notification' }).catch(() => undefined);
  }
  return waitFor(cdp, TABS_PRESENT, 8000);
}

interface Row {
  cat: Cat;
  beforeN: number;
  prodClicked: boolean;
  fallbackClicked: boolean;
  afterImmediate: number; // reload 前的页内读数（可能仅 UI 更新）
  afterReload: number; // reload 后读数（服务端真相）
}

async function main(): Promise<void> {
  const snap: Record<string, unknown> = { ts: TS, host: HOST, port: PORT };
  console.log('\n=== 通知清除探针 ===');
  console.log(`连接 Chrome CDP ${HOST}:${PORT}（page 含 "${URL_INCLUDES}"）`);
  console.log('只点 tab + 滚动，绝不点赞/评论/关注/写入——可安全在真账号上跑。\n');

  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: URL_INCLUDES });
  const { cdp } = session;
  try {
    await cdp.send('Page.enable').catch(() => undefined);
    await cdp.send('Input.enable').catch(() => undefined);

    // 0) 入口红点（初始，左侧导航常驻，feed/通知页都可读）
    const badge0 = await readBadge(cdp);
    snap.entryBadgeBefore = badge0;
    console.log(`入口红点(初始): unread=${badge0.unread} count=${badge0.count}`);

    // 1) 去通知首页，读三栏初始未读
    const homeOk = await gotoNotificationHome(cdp);
    snap.notificationHomeReady = homeOk;
    if (!homeOk) {
      console.log('✗ 通知首页 tab 未出现（可能未登录/未在小红书/布局变化）。');
      await writeSnap(snap, session);
      return;
    }
    await sleep(800);
    const home0 = await readHome(cdp);
    snap.homeBefore = home0;
    console.log(`首页三栏(初始未读): ${CAT_LABEL.comments}=${home0.comments}  ${CAT_LABEL.likes}=${home0.likes}  ${CAT_LABEL.follows}=${home0.follows}\n`);

    if (home0.comments + home0.likes + home0.follows === 0) {
      console.log('注意：三栏初始都为 0，没有未读可测。请先让账号产生未读（让别人评论/赞/关注）后重跑。');
      await writeSnap(snap, session);
      return;
    }

    // 2) 逐类「看一眼」：点击前读 before → 点击(+评论滚动) → 读 afterImmediate
    const cats: Cat[] = ['comments', 'likes', 'follows'];
    const rows: Row[] = [];
    for (const cat of cats) {
      await gotoNotificationHome(cdp);
      await sleep(600);
      const beforeN = (await readHome(cdp))[cat];

      const prodClicked = await evalRaw<boolean>(cdp, prodClickJs(cat)).catch(() => false);
      let fallbackClicked = false;
      if (!prodClicked) fallbackClicked = await evalRaw<boolean>(cdp, fallbackClickJs(cat)).catch(() => false);

      if ((prodClicked || fallbackClicked) && cat === 'comments') {
        for (let i = 0; i < 3; i++) {
          await evalRaw(cdp, SCROLL_JS).catch(() => undefined);
          await sleep(600);
        }
      }
      await sleep(1500); // 给平台 mark-read + 重渲染角标的时间
      const afterImmediate = (await readHome(cdp))[cat];
      rows.push({ cat, beforeN, prodClicked, fallbackClicked, afterImmediate, afterReload: -1 });
      console.log(
        `[${CAT_LABEL[cat]}] 看前=${beforeN} → 看后(页内)=${afterImmediate}  prodClick=${prodClicked} fallback=${fallbackClicked}`,
      );
    }

    // 3) 重载页面 → 服务端真相（页内可能只更新了 UI，reload 后才是平台是否真标已读）
    console.log('\n重新加载页面，确认是否服务端真已清除 …');
    await cdp.send('Page.reload', { ignoreCache: false }).catch(() => undefined);
    await waitFor(cdp, TABS_PRESENT, 10000);
    await sleep(1500);
    const homeReload = await readHome(cdp);
    const badgeReload = await readBadge(cdp);
    snap.homeAfterReload = homeReload;
    snap.entryBadgeAfter = badgeReload;
    for (const r of rows) r.afterReload = homeReload[r.cat];
    console.log(`重载后三栏: ${CAT_LABEL.comments}=${homeReload.comments}  ${CAT_LABEL.likes}=${homeReload.likes}  ${CAT_LABEL.follows}=${homeReload.follows}`);
    console.log(`入口红点(重载后): unread=${badgeReload.unread} count=${badgeReload.count}\n`);

    // 4) 判定
    console.log('=== 判定（看一眼能否真清未读）===');
    const verdicts: Record<string, string> = {};
    for (const r of rows) {
      let v: string;
      if (!r.prodClicked && !r.fallbackClicked) {
        v = '❓ tab 没找到（选择器漂移 / 无该栏）——无法测清除';
      } else if (r.beforeN === 0) {
        v = '— 本栏初始无未读，跳过（先制造该栏未读再测）';
      } else if (r.afterReload === 0) {
        v = '✅ 看一眼能清零（重载后服务端=0）' + (!r.prodClicked && r.fallbackClicked ? '；但生产选择器没点中、靠回退命中 → 需修 browse-session 选择器' : '');
      } else if (r.afterReload < r.beforeN) {
        v = `🟡 部分清除（${r.beforeN}→${r.afterReload}），单看一眼不足以清零（需滚到底/逐条）`;
      } else {
        v = `❌ 看一眼清不掉（重载后仍=${r.afterReload}）——该栏需别的动作（逐条打开/特定交互），否则未读永挂`;
      }
      verdicts[r.cat] = v;
      console.log(`[${CAT_LABEL[r.cat]}] ${v}`);
    }
    snap.verdicts = verdicts;

    console.log(
      '\n结论指引：\n' +
        '  · 三栏都 ✅ → 「巡视循环到零 + 删 epoch 闸」前提成立，可放心按该方向重构。\n' +
        '  · 某栏 ❌/🟡 → 该栏「看一眼」不足以清未读：要么把该栏清除动作做实（滚到底/逐条），\n' +
        '    要么对该栏把边缘触发从「沿触发」退到「计数增量触发」（仅该栏，作兜底）。\n' +
        '  · 出现「靠回退命中」→ 生产 tab 选择器需先修，否则连看都看不到该栏。',
    );
  } finally {
    await writeSnap(snap, session);
    session.close();
  }
}

async function writeSnap(snap: Record<string, unknown>, session: Awaited<ReturnType<typeof attachToPage>>): Promise<void> {
  const jsonPath = `/tmp/aidcp-notification-clear-probe-${TS}.json`;
  writeFileSync(jsonPath, JSON.stringify(snap, null, 2));
  console.log(`\n[probe] 快照写入 ${jsonPath}`);
  try {
    const shot = await session.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const pngPath = `/tmp/aidcp-notification-clear-probe-${TS}.png`;
    writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    console.log(`[probe] 截图写入 ${pngPath}`);
  } catch {
    /* 截图失败不影响快照 */
  }
}

main().catch((e) => {
  console.error('[probe] 失败:', e);
  process.exit(1);
});
