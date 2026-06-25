/**
 * self-identity.ts — 登录后读出「自己账号的稳定 id」（change account-identity-from-login，task 1.1）
 * ===========================================================================
 * 把账号身份从「启动器贴的环境变量标签」换成「实际登录进去的那个账号读出的稳定 userid」。
 *
 * 来源定序（0.1 真机已验，2026-06-25）：
 *   ① 首选「就地读」：顶栏头像 <img>（与登录探测同款选择器，chrome-launcher.ts:410 镜像）
 *      上溯到祖先 <a>，取其 href（形如 /user/profile/<id>），套捕获正则。零跳转、零副作用。
 *   ② 兜底「跳转读」：就地锚点缺失时，点「我的主页/头像」进自己主页，读 location.href 套同一正则。
 *   ✗ 不读 cookie 当 id（web_session/a1 是会话/设备 token，无可解 userid）；✗ 不读 class 文本拼 id。
 *
 * 红线：读不出 / 形态不匹配 → 诚实失败（ok:false），【绝不猜、绝不回落 default】。
 *   云端对 accountId 故意零校验（design D5），故边缘这道硬形态闸是「防非空畸形 id 污染主表」的唯一防线。
 *
 * 捕获正则与生产逐字一致（browse-session.ts:1619 extractAuthorProfile 内）；本模块【不整段复用】
 * extractAuthorProfile——它把 authorId 返回耦合在「粉丝/笔记/获赞至少一个」上（browse-session.ts:1635），
 * 读自己 id 只需 href/URL 的 id、不依赖统计数。
 */
import { evalRaw, type BrowseCdp } from '../browse/cdp-util.js';

/** 从 /user/profile/<id> 抽 id 的捕获正则——与生产逐字一致（browse-session.ts:1619）。 */
export const PROFILE_ID_RE = /\/user\/profile\/([A-Za-z0-9]+)/;

/** 硬形态闸：真实小红书 userid（0.1 实测为 24 位 hex；保守放宽到 ≥20 位字母数字）。 */
export const STABLE_ID_SHAPE = /^[A-Za-z0-9]{20,}$/;

/** 顶栏头像选择器——镜像登录探测（chrome-launcher.ts:410），改这里须同步那边。 */
const NAV_SCOPE_SELECTOR = 'header, nav, .side-bar, [class*="side-bar"], [class*="sidebar"]';
const AVATAR_SELECTOR = 'img[class*="avatar"], [class*="avatar"] img, .user-avatar img';

/** 就地扫描的原始信号（纯数据，便于纯函数判定/单测）。 */
export interface SelfIdentitySignals {
  href: string;
  /** 顶栏头像 <img> 的祖先 <a> 的 href（无包裹锚点则 null）。 */
  avatarAnchorHref: string | null;
  /** 导航区内所有 /user/profile 锚点的 href（兜底来源）。 */
  navProfileHrefs: string[];
  /** 昵称（显示名，best-effort，可 null）。 */
  nickname: string | null;
  /** 小红书号（副标识，best-effort，可 null）。 */
  redId: string | null;
}

export interface SelfIdentity {
  /** 账号主键 = 登录态读出的稳定 userid。 */
  accountId: string;
  /** 显示名（昵称），可空——非主键，缺失不阻断。 */
  displayName: string | null;
  /** 小红书号，可空。 */
  redId: string | null;
  /** 身份从哪条路读出。 */
  source: 'in-place' | 'navigate';
}

export type SelfIdentityResult =
  | { ok: true; identity: SelfIdentity }
  | { ok: false; reason: string };

/**
 * 握手身份决策（纯函数，便于单测覆盖优先级与红线）：
 *   - 读出真实 id：env 覆盖优先（不同则标 mismatch 供告警），否则用真实 id；
 *   - 读不出 + 有 env 覆盖：用覆盖值（逃生阀）；
 *   - 读不出 + 无覆盖：halt（诚实停手，调用方不得握手、绝不回落 default）。
 */
export type IdentityDecision =
  | { kind: 'use'; accountId: string; source: 'env-override' | 'in-place' | 'navigate'; mismatch?: { override: string; real: string } }
  | { kind: 'use-override-after-read-fail'; accountId: string; reason: string }
  | { kind: 'halt'; reason: string };

export function decideHandshakeIdentity(idRes: SelfIdentityResult, override: string | undefined): IdentityDecision {
  if (idRes.ok) {
    const real = idRes.identity.accountId;
    if (override) {
      return override === real
        ? { kind: 'use', accountId: override, source: 'env-override' }
        : { kind: 'use', accountId: override, source: 'env-override', mismatch: { override, real } };
    }
    return { kind: 'use', accountId: real, source: idRes.identity.source };
  }
  if (override) return { kind: 'use-override-after-read-fail', accountId: override, reason: idRes.reason };
  return { kind: 'halt', reason: idRes.reason };
}

/** 从一个 href 抽稳定 id；抽不到返回 ''。纯函数。 */
export function extractIdFromHref(href: string | null | undefined): string {
  if (!href) return '';
  const m = href.match(PROFILE_ID_RE);
  return m ? m[1] : '';
}

/** 形态闸：像不像真实 userid。纯函数。 */
export function isValidStableId(id: string): boolean {
  return STABLE_ID_SHAPE.test(id);
}

/**
 * 纯判定：从就地信号推导自己的稳定 id（首选头像祖先锚点，兜底任一导航区 profile 锚点）。
 * 读不出形态合规的 id 返回 ''（交由调用方走跳转兜底或诚实失败）。纯函数、可单测。
 */
export function deriveInPlaceSelfId(signals: SelfIdentitySignals): string {
  const fromAvatar = extractIdFromHref(signals.avatarAnchorHref);
  if (isValidStableId(fromAvatar)) return fromAvatar;
  for (const href of signals.navProfileHrefs) {
    const id = extractIdFromHref(href);
    if (isValidStableId(id)) return id;
  }
  return '';
}

// ---- 页面内 JS（注入执行，只读 + 合成点击/导航，绝不写入任何账号状态）----

/** 就地扫描：头像祖先锚点 href + 导航区 profile 锚点 + 昵称/小红书号（best-effort）。 */
const IN_PLACE_SCAN_JS = `(function(){
  function ahref(a){ return a ? (a.getAttribute('href')||'') : null; }
  var navScope = document.querySelector(${JSON.stringify(NAV_SCOPE_SELECTOR)});
  var avatar = navScope && navScope.querySelector(${JSON.stringify(AVATAR_SELECTOR)});
  var avatarAnchor = null;
  if (avatar){ var n = avatar; while(n && n !== navScope){ if(n.tagName==='A'){ avatarAnchor=n; break; } n=n.parentElement; } }
  var navProfileHrefs = [];
  if (navScope){ var as = navScope.querySelectorAll('a[href*="/user/profile/"]'); for(var i=0;i<as.length && i<12;i++){ var h=ahref(as[i]); if(h) navProfileHrefs.push(h); } }
  return JSON.stringify({
    href: location.href,
    avatarAnchorHref: ahref(avatarAnchor),
    navProfileHrefs: navProfileHrefs,
    nickname: null,
    redId: null
  });
})()`;

/** 自己主页页面上读昵称 / 小红书号（best-effort，读不到为 null）。 */
const READ_DISPLAY_JS = `(function(){
  function txt(el){ return el ? (el.textContent||'').replace(/\\s+/g,' ').trim() : ''; }
  var nameEl = document.querySelector('.user-name, [class*="user-name"], [class*="userName"], .user-nickname, [class*="nickname"]');
  var nickname = txt(nameEl) || null;
  var redId = null;
  var nodes = document.querySelectorAll('span,div,p');
  for (var i=0;i<nodes.length;i++){ var t=txt(nodes[i]); var m=t.match(/小红书号[:：]?\\s*([A-Za-z0-9_\\-]+)/); if(m){ redId=m[1]; break; } }
  return JSON.stringify({ nickname: nickname, redId: redId });
})()`;

const CURRENT_URL_JS = `(function(){ return location.href; })()`;
const ON_PROFILE_JS = `(function(){ return /\\/user\\/profile\\//.test(location.href); })()`;

/** 点文本含 needle 的可点元素（取 closest('a,button')）；只点、不写入。 */
function clickByTextJs(needle: string): string {
  return `(function(){
    var cand = document.querySelectorAll('a,button,div,span,li');
    for (var i=0;i<cand.length;i++){ var t=(cand[i].textContent||'').replace(/\\s+/g,'').trim();
      if(t.indexOf(${JSON.stringify(needle)})>=0 && t.length<=8){ var c=cand[i].closest('a,button')||cand[i]; c.click(); return true; } }
    return false;
  })()`;
}

/** 合成点击顶栏头像（唤出「我的主页」菜单的场景）。只点、不写入。 */
const CLICK_AVATAR_JS = `(function(){
  var navScope = document.querySelector(${JSON.stringify(NAV_SCOPE_SELECTOR)});
  var avatar = navScope && navScope.querySelector(${JSON.stringify(AVATAR_SELECTOR)});
  if(!avatar) return false; var c = avatar.closest('a,button,div')||avatar; c.click(); return true;
})()`;

export interface ReadSelfIdentityOptions {
  /** 跳转兜底时是否允许导航（默认 true）。设 false 则只试就地、失败即诚实失败（不产生跳转副作用）。 */
  allowNavigate?: boolean;
  /** 跳转兜底等待进入主页的超时（ms，默认 6000）。 */
  navigateTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: (msg: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(
  cdp: BrowseCdp,
  expr: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  intervalMs = 400,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const ok = await evalRaw<boolean>(cdp, expr).catch(() => false);
    if (ok) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

async function readDisplay(cdp: BrowseCdp): Promise<{ nickname: string | null; redId: string | null }> {
  const raw = await evalRaw<string>(cdp, READ_DISPLAY_JS).catch(() => '');
  try {
    const o = JSON.parse(raw) as { nickname: string | null; redId: string | null };
    return { nickname: o.nickname ?? null, redId: o.redId ?? null };
  } catch {
    return { nickname: null, redId: null };
  }
}

/**
 * 登录后读出自己账号的稳定 id。首选就地读、兜底跳转读；读不出/形态不匹配 → 诚实失败（ok:false）。
 * 绝不回落 default。
 */
export async function readSelfIdentity(
  cdp: BrowseCdp,
  opts: ReadSelfIdentityOptions = {},
): Promise<SelfIdentityResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const log = opts.logger ?? (() => undefined);
  const allowNavigate = opts.allowNavigate ?? true;
  const navTimeout = opts.navigateTimeoutMs ?? 6000;

  // ① 就地读
  const scanRaw = await evalRaw<string>(cdp, IN_PLACE_SCAN_JS).catch(() => '');
  let signals: SelfIdentitySignals;
  try {
    signals = JSON.parse(scanRaw) as SelfIdentitySignals;
  } catch {
    signals = { href: '', avatarAnchorHref: null, navProfileHrefs: [], nickname: null, redId: null };
  }
  const inPlaceId = deriveInPlaceSelfId(signals);
  if (inPlaceId) {
    log(`[self-identity] 就地读出稳定 id=${inPlaceId}（source=in-place）`);
    const display = await readDisplay(cdp);
    return { ok: true, identity: { accountId: inPlaceId, displayName: display.nickname, redId: display.redId, source: 'in-place' } };
  }

  // ② 跳转兜底
  if (!allowNavigate) {
    return { ok: false, reason: '就地读不出稳定 id 且禁用跳转兜底' };
  }
  log('[self-identity] 就地无 self-profile 锚点，走跳转兜底（进我的主页读 URL）');
  await evalRaw<boolean>(cdp, clickByTextJs('我的主页')).catch(() => false);
  let onProfile = await waitFor(cdp, ON_PROFILE_JS, Math.min(navTimeout, 4000), sleep, now);
  if (!onProfile) {
    await evalRaw<boolean>(cdp, CLICK_AVATAR_JS).catch(() => false);
    await sleep(700);
    onProfile = await waitFor(cdp, ON_PROFILE_JS, 2500, sleep, now);
    if (!onProfile) {
      await evalRaw<boolean>(cdp, clickByTextJs('我的主页')).catch(() => false);
      onProfile = await waitFor(cdp, ON_PROFILE_JS, navTimeout, sleep, now);
    }
  }
  if (!onProfile) {
    return { ok: false, reason: '跳转兜底未能进入我的主页（点不中入口 / 布局变化）' };
  }
  const profileUrl = await evalRaw<string>(cdp, CURRENT_URL_JS).catch(() => '');
  const navId = extractIdFromHref(profileUrl);
  if (!isValidStableId(navId)) {
    return { ok: false, reason: `进了我的主页但读不出形态合规的稳定 id（url=${profileUrl}）` };
  }
  log(`[self-identity] 跳转读出稳定 id=${navId}（source=navigate）`);
  const display = await readDisplay(cdp);
  return { ok: true, identity: { accountId: navId, displayName: display.nickname, redId: display.redId, source: 'navigate' } };
}
