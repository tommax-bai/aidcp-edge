/**
 * self-identity-probe.ts — 「登录后读出自己账号稳定 id」可行性探针（task 0.1，非生产代码）
 * ===========================================================================
 * 只读 DOM + 导航到「我的主页」；【绝不点赞、绝不评论、绝不关注、绝不发布、绝不写入任何账号状态】。
 * 导航到自己主页是只读行为，可安全在已登录的真账号上跑。
 *
 * 回答 change `account-identity-from-login` 的成败手（design D8 / task 0.1）：
 *   设计原先主推「就地从顶栏头像 href 读自己 userid、不跳转」，但代码只证明了登录探测
 *   定位到一个【无 href 的 <img>】（chrome-launcher.ts:410），顶栏是否裸露指向
 *   /user/profile/<自己id> 的锚点【没有代码证明】。唯一被证明可行的是「进我的主页 →
 *   location.href 含自己 id → 复用 extractAuthorProfile:1619 的正则」。
 *   本探针在真机上量出真相，给 0.1 一个确定结论：
 *     ① 就地路径存不存在（顶栏头像/导航区有无 /user/profile 锚点）→ 决定它当不当优化；
 *     ② 跳转路径成不成立（进我的主页能否读出形态合规的 id）→ 这是正式路径，不成立则成败手真挂；
 *     ③ 两条若都出 id，是否一致（互校）；
 *     ④ id 的真实形态（长度/字符集）→ 给 0.1 定下硬形态闸正则。
 *
 * 无漂移：读 id 用与生产【逐字一致】的捕获正则 /\/user\/profile\/([A-Za-z0-9]+)/
 *   （browse-session.ts:1619 extractAuthorProfile 内）。
 *
 * 运行（对一台已登录小红书、开着 9222 远程调试端口的 Chrome）：
 *   AIDCP_CDP_PORT=9222 npx tsx scripts/self-identity-probe.ts
 * 前置：该 Chrome 须已登录目标账号、且当前页在小红书（feed/explore 即可）。
 *   注意：杀 edge 会连带关其子 Chrome；跑探针请独立起一个带 --remote-debugging-port 的 Chrome
 *   指向 .aidcp-chrome-profile（见 launch-multinode / dev-run 的 Chrome 启动参数）。
 *
 * Env: AIDCP_CDP_HOST(127.0.0.1) / AIDCP_CDP_PORT(9222) / AIDCP_PAGE_URL(默认 'xiaohongshu' 过滤页面)。
 */
import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { attachToPage } from '../src/cdp/index.js';
import { evalRaw } from '../src/browse/cdp-util.js';

const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const URL_INCLUDES = process.env.AIDCP_PAGE_URL ?? 'xiaohongshu';
const TS = new Date().toISOString().replace(/[:.]/g, '-');

// 候选硬形态闸（0.1 据真实输出最终敲定）：真实小红书 userid 形如 24 位 hex/base 子串。
const SHAPE_GATE = /^[A-Za-z0-9]{20,}$/;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Cdp = Awaited<ReturnType<typeof attachToPage>>['cdp'];

/** 与生产逐字一致的「从当前 URL 抽自己 userid」（browse-session.ts:1619）。 */
const READ_URL_ID_JS = `(function(){ var m=location.href.match(/\\/user\\/profile\\/([A-Za-z0-9]+)/); return m?m[1]:''; })()`;

const CURRENT_URL_JS = `(function(){ return location.href; })()`;

/**
 * 就地扫描：顶栏/导航区里
 *   - 登录探测同款头像 <img>（chrome-launcher.ts:410 选择器）及其祖先 <a> 的 href；
 *   - 导航区内所有 /user/profile/ 锚点的 href；
 *   - 「我的主页 / 创作中心」入口（文本判，连带其 closest('a') 的 href）。
 * 并用生产正则尝试从「头像祖先锚点」就地抽 id（inPlaceSelfId）。
 */
const IN_PLACE_SCAN_JS = `(function(){
  function ahref(a){ return a ? (a.getAttribute('href')||'') : null; }
  var navScope = document.querySelector('header, nav, .side-bar, [class*="side-bar"], [class*="sidebar"]');
  var avatar = navScope && navScope.querySelector('img[class*="avatar"], [class*="avatar"] img, .user-avatar img');
  var avatarAnchor = null;
  if (avatar){ var n = avatar; while(n && n !== navScope){ if(n.tagName==='A'){ avatarAnchor=n; break; } n=n.parentElement; } }
  var navProfileAnchors = [];
  if (navScope){ var as = navScope.querySelectorAll('a[href*="/user/profile/"]'); for(var i=0;i<as.length && i<12;i++){ navProfileAnchors.push(ahref(as[i])); } }
  var myEntries = [];
  var cand = document.querySelectorAll('a,button,div,span,li');
  for (var j=0;j<cand.length;j++){ var t=(cand[j].textContent||'').replace(/\\s+/g,'').trim();
    if((t.indexOf('我的主页')>=0 || t.indexOf('创作中心')>=0) && t.length<=8){ var a=cand[j].closest('a');
      myEntries.push({text:t, tag:cand[j].tagName, href:ahref(a)}); if(myEntries.length>=12) break; } }
  var inPlaceSelfId = '';
  var avHref = ahref(avatarAnchor);
  if (avHref){ var m0 = avHref.match(/\\/user\\/profile\\/([A-Za-z0-9]+)/); if(m0) inPlaceSelfId = m0[1]; }
  return JSON.stringify({
    href: location.href,
    hasAvatarImg: Boolean(avatar),
    avatarAnchorHref: avHref,
    navProfileAnchors: navProfileAnchors,
    myEntries: myEntries,
    inPlaceSelfId: inPlaceSelfId
  });
})()`;

/** 点一个文本含 needle 的可点元素（取其 closest('a,button') 优先）；返回是否点到。绝不写入账号状态。 */
function clickByTextJs(needle: string): string {
  return `(function(){
    var cand = document.querySelectorAll('a,button,div,span,li');
    for (var i=0;i<cand.length;i++){ var t=(cand[i].textContent||'').replace(/\\s+/g,'').trim();
      if(t.indexOf(${JSON.stringify(needle)})>=0 && t.length<=8){ var c=cand[i].closest('a,button')||cand[i]; c.click(); return true; } }
    return false;
  })()`;
}

/** 合成点击顶栏头像（用于唤出「我的主页」菜单的场景）。只点、不写入。 */
const CLICK_AVATAR_JS = `(function(){
  var navScope = document.querySelector('header, nav, .side-bar, [class*="side-bar"], [class*="sidebar"]');
  var avatar = navScope && navScope.querySelector('img[class*="avatar"], [class*="avatar"] img, .user-avatar img');
  if(!avatar) return false; var c = avatar.closest('a,button,div')||avatar; c.click(); return true;
})()`;

const ON_PROFILE_JS = `(function(){ return /\\/user\\/profile\\//.test(location.href); })()`;

async function waitFor(cdp: Cdp, expr: string, timeoutMs: number, intervalMs = 400): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evalRaw<boolean>(cdp, expr).catch(() => false);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

type InPlace = {
  href: string;
  hasAvatarImg: boolean;
  avatarAnchorHref: string | null;
  navProfileAnchors: (string | null)[];
  myEntries: { text: string; tag: string; href: string | null }[];
  inPlaceSelfId: string;
};

async function readInPlace(cdp: Cdp): Promise<InPlace> {
  const raw = await evalRaw<string>(cdp, IN_PLACE_SCAN_JS).catch(() => '');
  try {
    return JSON.parse(raw) as InPlace;
  } catch {
    return { href: '', hasAvatarImg: false, avatarAnchorHref: null, navProfileAnchors: [], myEntries: [], inPlaceSelfId: '' };
  }
}

/** 尝试进自己主页：先点「我的主页」直链；不行则点头像唤出菜单再点「我的主页」。返回是否进到 /user/profile/。 */
async function gotoMyProfile(cdp: Cdp): Promise<boolean> {
  // 1) 直接点「我的主页」
  await evalRaw<boolean>(cdp, clickByTextJs('我的主页')).catch(() => false);
  if (await waitFor(cdp, ON_PROFILE_JS, 4000)) return true;

  // 2) 点头像唤出菜单 → 再点「我的主页」
  await evalRaw<boolean>(cdp, CLICK_AVATAR_JS).catch(() => false);
  await sleep(800);
  if (await waitFor(cdp, ON_PROFILE_JS, 3000)) return true; // 头像本身可能就是直链
  await evalRaw<boolean>(cdp, clickByTextJs('我的主页')).catch(() => false);
  return waitFor(cdp, ON_PROFILE_JS, 4000);
}

async function main(): Promise<void> {
  const snap: Record<string, unknown> = { ts: TS, host: HOST, port: PORT, shapeGate: String(SHAPE_GATE) };
  console.log('\n=== 自身身份读取探针（task 0.1）===');
  console.log(`连接 Chrome CDP ${HOST}:${PORT}（page 含 "${URL_INCLUDES}"）`);
  console.log('只读 DOM + 导航到我的主页，绝不点赞/评论/关注/发布/写入——可安全在真账号上跑。\n');

  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: URL_INCLUDES });
  const { cdp } = session;
  try {
    await cdp.send('Page.enable').catch(() => undefined);
    await cdp.send('Input.enable').catch(() => undefined);

    const startUrl = await evalRaw<string>(cdp, CURRENT_URL_JS).catch(() => '');
    snap.startUrl = startUrl;
    if (/\/user\/profile\//.test(startUrl)) {
      console.log('注意：当前已在某个 /user/profile/ 页，建议先回 feed 再跑以测「就地」路径。\n');
    }

    // ① 就地路径：顶栏头像/导航区有无 self-profile 锚点
    const inPlace = await readInPlace(cdp);
    snap.inPlace = inPlace;
    console.log('① 就地路径（不跳转）：');
    console.log(`   当前页: ${inPlace.href}`);
    console.log(`   头像 <img> 存在: ${inPlace.hasAvatarImg}`);
    console.log(`   头像祖先 <a> 的 href: ${inPlace.avatarAnchorHref ?? '(无包裹锚点 / 头像不是链接)'}`);
    console.log(`   导航区 /user/profile 锚点: ${JSON.stringify(inPlace.navProfileAnchors)}`);
    console.log(`   「我的主页/创作中心」入口: ${JSON.stringify(inPlace.myEntries)}`);
    console.log(`   就地抽到的自己 id: ${inPlace.inPlaceSelfId || '(空)'}\n`);

    // ② 跳转路径（正式）：进我的主页 → 读 URL id（生产正则）
    console.log('② 跳转路径（进我的主页读 location.href）：');
    const reached = await gotoMyProfile(cdp);
    await sleep(1200);
    const profileUrl = await evalRaw<string>(cdp, CURRENT_URL_JS).catch(() => '');
    const navId = await evalRaw<string>(cdp, READ_URL_ID_JS).catch(() => '');
    snap.reachedMyProfile = reached;
    snap.profileUrl = profileUrl;
    snap.navSelfId = navId;
    console.log(`   进到我的主页: ${reached}`);
    console.log(`   主页 URL: ${profileUrl}`);
    console.log(`   读出的自己 id: ${navId || '(空)'}\n`);

    // ③ 形态闸 + ④ 互校
    const navShapeOk = SHAPE_GATE.test(navId);
    const inPlaceShapeOk = SHAPE_GATE.test(inPlace.inPlaceSelfId);
    const consistent = Boolean(navId) && navId === inPlace.inPlaceSelfId;
    snap.navShapeOk = navShapeOk;
    snap.inPlaceShapeOk = inPlaceShapeOk;
    snap.consistent = consistent;
    snap.navIdLen = navId.length;

    console.log('=== 判定（task 0.1 结论）===');
    // 就地路径
    if (inPlace.inPlaceSelfId && inPlaceShapeOk) {
      console.log('① 就地读: ✅ 顶栏有 self-profile 锚点且 id 形态合规 → 可当「就地优化路径」采用（design D8 路径 2）');
    } else if (inPlace.navProfileAnchors.some((h) => h && /\/user\/profile\//.test(h))) {
      console.log('① 就地读: 🟡 导航区有 /user/profile 锚点但头像本身没抽到 → 可改用该锚点；需在实装里指明具体选择器');
    } else {
      console.log('① 就地读: ❌ 顶栏/导航区无 self-profile 锚点（头像是无 href 的 img/点开菜单）→ 放弃就地优化，走跳转');
    }
    // 跳转路径（正式，成败手）
    if (navId && navShapeOk) {
      console.log(`② 跳转读: ✅ 成立——进我的主页能读出形态合规的 id（len=${navId.length}）→ 正式路径坐实，成败手过`);
    } else if (navId && !navShapeOk) {
      console.log(`② 跳转读: ⚠️ 读出了 id 但不匹配候选形态闸 /${SHAPE_GATE.source}/（len=${navId.length}）→ 据真实形态调整 0.1 的闸正则后即成立`);
    } else {
      console.log('② 跳转读: ❌ 连进我的主页都读不出 id → 成败手不成立，change 应停手重审读取方案（不得退化成静默 default）');
    }
    // 互校
    if (consistent) console.log('④ 互校: ✅ 就地 id 与跳转 id 一致');
    else if (inPlace.inPlaceSelfId && navId) console.log(`④ 互校: ❌ 就地(${inPlace.inPlaceSelfId}) ≠ 跳转(${navId})——就地路径读错对象，别用`);

    console.log(
      '\n结论指引：\n' +
        '  · ② ✅ → 成败手过：以「进我的主页读 URL」为正式路径动手（task 1.1）；① ✅ 则再把就地读当优化。\n' +
        `  · ② ⚠️ → 把 0.1 的硬形态闸正则按真实 id（len=${navId.length}、值见上）调准，再判过。\n` +
        '  · ② ❌ → 停手：换读取方案（如别的稳定 id 源），绝不为了能跑而回落 default。',
    );
  } finally {
    await writeSnap(snap, session);
    session.close();
  }
}

async function writeSnap(snap: Record<string, unknown>, session: Awaited<ReturnType<typeof attachToPage>>): Promise<void> {
  const jsonPath = `/tmp/aidcp-self-identity-probe-${TS}.json`;
  writeFileSync(jsonPath, JSON.stringify(snap, null, 2));
  console.log(`\n[probe] 快照写入 ${jsonPath}`);
  try {
    const shot = await session.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const pngPath = `/tmp/aidcp-self-identity-probe-${TS}.png`;
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
