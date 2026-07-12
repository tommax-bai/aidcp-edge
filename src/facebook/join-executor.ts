import { dispatchHover, evalJson, pressEscape, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../browse/overlay-monitor.js';
import { isUrlAllowedByTargetDescriptor } from '../platform/driver.js';
import { FACEBOOK_TARGET } from './driver.js';
import { defaultFacebookConsentAccepter, type FacebookConsentAccepter } from './consent.js';

export type FacebookJoinReason =
  | 'observation_only'
  | 'already_member'
  | 'questionnaire_required'
  | 'pending'
  | 'no_button'
  | 'not_facebook'
  | 'login_required'
  | 'blocked_by_consent'
  | 'blocked_by_captcha'
  | 'nav_error'
  // P1-5（change facebook-join-comment-resilience）：慢渲染瞬态——就绪/点击后上限触顶时页面仍未最小就绪（仍 loading /
  // 无可见动作节点）。区别于「genuinely 没按钮 / 真失败」，供云端跳过 LLM、走短退避重试而非落永久失败。
  | 'not_ready'
  | 'post_not_confirmed_slow'
  | 'join_failed';

export interface FacebookGroupJoinObservation {
  groupUrl?: string;
  pageUrl?: string;
  title?: string;
  mainCtaText?: string | null;
  mainCtaAria?: string | null;
  headerText?: string | null;
  modalText?: string | null;
  membershipSignals?: string[];
  loginRequired?: boolean;
  captchaDetected?: boolean;
  questionnaireRequired?: boolean;
  pendingRequest?: boolean;
  navError?: string | null;
  /** 可见动作节点数 + 文档就绪态（change fb-group-join-wait-render）：用于「等页面真加载完再判定」的就绪轮询 + 审计取证（看清是否观察时仍在 loading）。 */
  actionNodeCount?: number;
  documentReady?: string;
  /**
   * L3 结构后置校验（change facebook-join-structural-verify）：群主体内是否存在可聚焦发帖/评论 composer
   * （`[contenteditable]`/`[role=textbox]`，语言无关成员态信号；M3 子树判别群内发帖框 vs 顶栏/群内搜索框）。
   */
  composerPresent?: boolean;
  /**
   * L3：群主体内是否存在可见「加入」CTA。承重闸——joined 要求 composerPresent 且 joinCtaPresent 为 false
   * （非成员公开组即便渲染 composer 也仍显示加入 CTA、故 joinCtaPresent=true 不判 joined，防新 false-positive）。
   */
  joinCtaPresent?: boolean;
  /**
   * change facebook-join-candidate-scope-guard：从 `location.pathname` 解析出的目标群 id（供作用域判据 + 审计）；解析不出为 null。
   */
  targetGroupId?: string | null;
  /**
   * 目标群「头部/动作区」块是否成功解析（fail-closed 正向包含的前提）。false = 无法确立作用域 → 观测腿绝不在域内选到 join、
   * 点击腿 fail-closed（诚实不点，绝不页面级点）。
   */
  scopeResolved?: boolean;
  /**
   * 被判定「不在目标群作用域」而排除的 join-kind 候选数（多为推荐位异群 join）——纯诊断/审计，佐证「为何诚实不点」。
   */
  outOfScopeJoinCount?: number;
  /**
   * 全量候选清单（含 `inTargetScope:false`，有界）：守 L4「边缘不静默丢原文」——把作用域标注后的完整候选画面上报云端裁判/落审计，
   * 但只有 `inTargetScope=true` 的候选进 mainCta / joinButton / membershipSignals。
   */
  ctaCandidates?: Array<{ text: string | null; kind: string; inTargetScope: boolean }>;
}

interface RawJoinObservation extends FacebookGroupJoinObservation {
  joinButton?: { found: boolean; disabled?: boolean; x?: number; y?: number; text?: string | null; aria?: string | null };
}

export interface FacebookJoinResult {
  ok: boolean;
  reason?: FacebookJoinReason;
  groupUrl: string;
  clicked: boolean;
  observation?: FacebookGroupJoinObservation;
  postObservation?: FacebookGroupJoinObservation;
}

export interface FacebookJoinExecutorDeps {
  cdp: BrowseCdp;
  overlayMonitor?: OverlayMonitor;
  /** cookie 同意浮层自动接受器（缺省用 env 策略）；导航后、阻断判定前置调用。 */
  acceptConsent?: FacebookConsentAccepter;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

export interface FacebookJoinExecutorOptions {
  /** 导航后、开始就绪轮询前的初始等待（缺省 0：轮询本身会等页面加载，不再靠固定时长）。 */
  settleMs?: number;
  waitAfterClickMs?: number;
  /** 就绪轮询上限（change fb-group-join-wait-render）：等「加入按钮/成员/登录/验证码/问卷/待审」等决定性信号出现的最长时间，兜底；FB 网络不稳时靠它宽松等待。 */
  readyTimeoutMs?: number;
  /** 就绪轮询间隔。 */
  pollMs?: number;
  /** 点击加入后等「已加入/退出小组/待审/问卷」等成员态渲染出来的轮询上限（change fb-group-join-postclick-wait / -timeouts）：FB 常在点击后 ~12s+ 才把按钮翻成「已加入」，且网络不稳；死等一次会误判失败。放宽到 45s。 */
  postClickTimeoutMs?: number;
  /** 点击加入按钮前的稳定等待（change fb-group-join-timeouts）：按钮在 interactive 阶段即渲染，但 React 可能尚未挂点击处理器、点了不生效；点前多等一会儿让水合完成，点击更可靠。 */
  preClickSettleMs?: number;
}

const DEFAULTS: Required<FacebookJoinExecutorOptions> = {
  settleMs: 0,
  waitAfterClickMs: 1_500,
  // 30s（原 20s）：就绪轮询按信号出现即早返回，放长只在 FB 慢加载时多等、快页面零成本；
  // 边缘 click 腿最坏 ≈ 30(ready)+2(settle)+1.5(afterClick)+45(post)=78.5s（自动路径 thinkMs=0）+ CDP 往返，
  // 云端 group.join 步骤超时已相应提到 120s 留足余量（见 cloud facebook-group-join-edge-steps.ts）。
  readyTimeoutMs: 30_000,
  pollMs: 600,
  postClickTimeoutMs: 45_000,
  preClickSettleMs: 2_000,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function canonicalGroupUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!isUrlAllowedByTargetDescriptor(url.href, FACEBOOK_TARGET)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const groupIdx = parts.findIndex((p) => p.toLowerCase() === 'groups');
  if (groupIdx < 0 || !parts[groupIdx + 1]) return null;
  return `https://www.facebook.com/groups/${parts[groupIdx + 1]}`;
}

function publicObservation(raw: RawJoinObservation, groupUrl: string): FacebookGroupJoinObservation {
  return {
    groupUrl,
    pageUrl: raw.pageUrl,
    title: raw.title,
    mainCtaText: raw.mainCtaText ?? null,
    mainCtaAria: raw.mainCtaAria ?? null,
    headerText: raw.headerText ?? null,
    modalText: raw.modalText ?? null,
    membershipSignals: raw.membershipSignals ?? [],
    loginRequired: raw.loginRequired === true,
    captchaDetected: raw.captchaDetected === true,
    questionnaireRequired: raw.questionnaireRequired === true,
    pendingRequest: raw.pendingRequest === true,
    navError: raw.navError ?? null,
    actionNodeCount: typeof raw.actionNodeCount === 'number' ? raw.actionNodeCount : 0,
    documentReady: raw.documentReady ?? undefined,
    composerPresent: raw.composerPresent === true,
    joinCtaPresent: raw.joinCtaPresent === true,
    targetGroupId: raw.targetGroupId ?? null,
    // 只有真 observe IIFE 会给出布尔 scopeResolved；缺字段（如预烘焙观测/旧形态）保持 undefined =「未评估」，
    // 绝不默认成 false——否则「作用域未确立」的 fail-closed 闸会对所有未标注观测误触发。
    scopeResolved: typeof raw.scopeResolved === 'boolean' ? raw.scopeResolved : undefined,
    outOfScopeJoinCount: typeof raw.outOfScopeJoinCount === 'number' ? raw.outOfScopeJoinCount : 0,
    ctaCandidates: Array.isArray(raw.ctaCandidates) ? raw.ctaCandidates : [],
  };
}

/**
 * L3 结构确认加入（change facebook-join-structural-verify）——**承重判据 = 语言无关、点击可归因的「跃迁」**：
 * composer 点前不存在、点后存在。这是修正后的核心（对抗评审揪出）：不能只靠「点后无可见加入 CTA」当正向——
 * `joinCtaPresent` 由**词表**派生（`!!join`，join 靠 JOIN_CTA_LABELS 命中），在**未覆盖语种**（正是本功能要治的场景）
 * 会 fail-open：非成员的加入按钮标签也未命中词表 → joinCtaPresent=false → 裸 composer 就误判已加入。跃迁不依赖词表：
 * 非成员公开组点前已渲染 composer → 无跃迁、不误判；点击后 composer 才出现 = 点击真让本账号成为成员。`!joinCtaPresent`
 * 与 `documentReady!=='loading'` 仅作 corroborating/兜底、不单独承重。**仅用于 post-click**——observe/pre-click 无点击、
 * 绝不据结构判 already_member（那条会没点击就 markJoined、污染账本、在没加入的群假评论）。导出供单测。
 */
export function structuralJoinConfirmed(
  pre: FacebookGroupJoinObservation | undefined,
  post: FacebookGroupJoinObservation | undefined,
): boolean {
  if (!post) return false;
  if (pre?.composerPresent === true) return false; // 点前已有 composer（如公开组对非成员）→ 非跃迁，绝不认
  return post.composerPresent === true && post.joinCtaPresent !== true && post.documentReady !== 'loading';
}

/** NFKC 归一 + 收敛空白 + 小写：多语标签/短语匹配统一口径（与 in-page ctaKind 的 replace(/\s+/g,' ').toLowerCase() 对齐）。 */
function normLabel(s: string | null | undefined): string {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 是否已是成员（confirm 侧多语，change facebook-join-comment-resilience P0-2）。旧实现用 EN/ZH 精确 === 与窄短语，
 * 非英中群加成功后按钮翻成本地语「已加入/退出小组」确认不到 → 边缘诚实但错误地报 join_failed、云端可能重复加入。
 * 现改为对成员按钮词表 MEMBER_CTA_LABELS + 多语「已成为成员」整句做 NFKC contains（与 ctaKind 同源；member 先于 join 判，
 * 「đã tham gia」不会被「tham gia」误伤；装饰性英文 "✓ Joined"/"Joined ⌄" 也不再被 === 漏掉）。仍须正向命中成员词，
 * 绝不放宽成「无信号也算已加入」（红线：不假成功）。导出供单测。
 */
export function hasMemberSignal(obs: FacebookGroupJoinObservation | undefined): boolean {
  if (!obs) return false;
  const hitLabel = (s: string): boolean => s.length > 0 && MEMBER_CTA_LABELS.some((k) => s.includes(k));
  if (hitLabel(normLabel(obs.mainCtaText)) || hitLabel(normLabel(obs.mainCtaAria))) return true;
  return (obs.membershipSignals ?? []).some((signal) => {
    const s = normLabel(signal);
    if (s.length === 0) return false;
    return MEMBER_MEMBERSHIP_PHRASES.some((n) => s.includes(n)) || MEMBER_CTA_LABELS.some((k) => s.includes(k));
  });
}

/**
 * Join / Joined / Pending 按钮标签的多语关键词（contains 匹配，小写）。收口于此单一来源：既导出给单测，
 * 又注入 in-page 观测 IIFE——避免旧「EN/ZH 精确匹配」把非英中群的 Join 按钮（如越南语「Tham gia nhóm」）
 * 吞成 null，从而让云端判定角色（多语 LLM）拿不到 CTA 文本、只能 fail-closed 跳过。覆盖目标群常见语种。
 */
// 关键词刻意剔除会误命中页面 chrome 的**裸词**（真机事故:裸「退出」命中输入法「退出联想输入」；裸「entrar」「unir」
// 也是无关子串隐患）。保留各语种明确的加入/退出/待审动词短语;真正的 chrome 隔离靠下方 IIFE 的作用域排除（顶栏/导航/侧栏）。
export const JOIN_CTA_LABELS: readonly string[] = [
  'join group', 'join', '加入小组', '加入群组', '加入社团', '加入', 'tham gia', 'únete', 'unirte', 'participar',
  'entrar al grupo', 'entrar no grupo', 'gabung', 'bergabung', 'เข้าร่วม', 'rejoindre', 'beitreten', 'iscriviti',
  'вступить', 'присоединиться', '참여', '가입', 'انضمام', 'انضم', 'sertai',
];
export const MEMBER_CTA_LABELS: readonly string[] = [
  'joined', 'leave group', '已加入', '退出小组', '退出群组', '退出社团', 'đã tham gia', 'rời nhóm',
  'salir del grupo', 'keluar dari grup', 'quitter le groupe', 'gruppe verlassen', 'ออกจากกลุ่ม',
  '已是成员', '你已加入',
];
export const PENDING_CTA_LABELS: readonly string[] = [
  'pending', 'request sent', 'cancel request', '待批准', '已申请', '待审批', 'đang chờ', 'hủy yêu cầu',
  'solicitud enviada', 'cancelar solicitud', 'menunggu', 'batalkan permintaan', 'demande envoyée',
  'annuler la demande', 'anfrage gesendet', 'รอการอนุมัติ', '요청 보냄', '요청됨',
];
/** 「已成为成员」整句信号（多语，NFKC 小写 contains）——与 MEMBER_CTA_LABELS 并用确认已加入（P0-2）。 */
export const MEMBER_MEMBERSHIP_PHRASES: readonly string[] = [
  'you are now a member', 'member of this group', '已是成员', '你已加入',
  'ahora eres miembro', 'bạn đã là thành viên', 'sudah menjadi anggota', 'вы теперь участник',
];
/**
 * 入群问卷「回答问题才能加入」的多语短语（NFKC 小写 contains，P0-2）。旧实现仅 EN/ZH 正则 → 非英中问卷被漏判为
 * questionnaireRequired=false、随后被 dismissOptionalModal 按 Esc 误关（破坏真问卷）。保守取多词短语、避免单裸词误判。
 */
export const QUESTIONNAIRE_PHRASES: readonly string[] = [
  'membership questions', 'answer questions', 'answer these questions', 'questions to join', 'required question',
  '回答问题', '入群问题', '必答', '加入前请回答',
  'trả lời câu hỏi', 'responde las preguntas', 'preguntas de membresía', 'jawab pertanyaan',
  'répondez aux questions', 'beantworte die fragen', 'ตอบคำถาม',
];

/**
 * 页面是否已「最小就绪」（P1-5）：文档已过 loading 且有可见动作节点。用于把「就绪/点击后上限触顶时页面还没加载出来」
 * 与「页面已就绪却真的没按钮 / 真失败」区分开——前者是可重试的网络瞬态（not_ready / post_not_confirmed_slow）。
 */
function isMinimallyReady(obs: FacebookGroupJoinObservation | undefined): boolean {
  if (!obs) return false;
  return obs.documentReady !== 'loading' && (obs.actionNodeCount ?? 0) > 0;
}

/**
 * modal 文本是否含加群流程信号（加入/成员/待审/问卷任一多语词，P1-7）。用于 dismissOptionalModal 的保守闸：
 * 只清「明确无关的可选浮层」，凡含加群流程信号一律不盲 Esc（可能是词表未覆盖语种的入群门，绝不破坏真门）。
 */
function modalLooksJoinRelated(modalText: string | null | undefined): boolean {
  const s = normLabel(modalText);
  if (!s) return false;
  return [...MEMBER_CTA_LABELS, ...PENDING_CTA_LABELS, ...QUESTIONNAIRE_PHRASES].some((k) => s.includes(k));
}

export type CtaKind = 'join' | 'member' | 'pending' | '';

/**
 * 按标签把 Join 按钮分类。**member / pending 先判、join 后判**——否则「đã tham gia」(已加入) 会被
 * 「tham gia」(加入) 子串误判成 join。纯函数、多语 contains 匹配；与下方 IIFE 内的 ctaKind 同源同序。
 */
export function classifyCtaLabel(label: string | null | undefined): CtaKind {
  const s = String(label ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!s) return '';
  if (MEMBER_CTA_LABELS.some((k) => s.includes(k))) return 'member';
  if (PENDING_CTA_LABELS.some((k) => s.includes(k))) return 'pending';
  if (JOIN_CTA_LABELS.some((k) => s.includes(k))) return 'join';
  return '';
}

/**
 * change facebook-join-candidate-scope-guard：加群候选「目标群作用域」守卫（语言无关、fail-closed 正向包含）。
 * 注入进 observe / click 两个 IIFE（须在 visible 定义之后），令两腿共用同一判据、绝不漂移。
 *
 * 承重 = **D1 正向包含（fail-closed）**：候选在域 **当且仅当** 它是「目标群头部/动作区」块的后代——该块 =
 * 含群名主标题（h1 / [role=heading][aria-level=1]）、且不含任何**异群** `/groups/` 链接的**最大祖先**（上界封顶 [role=main]）。
 * 解析不出主标题 → 无候选在域内（默认出域）。这样即便推荐位 join 是**兄弟裸 div[role=button]、无异群 href 祖先**，
 * 也因不在目标头部块内被挡住（承重不靠链接黑名单）。真机事故背景：FB「发现更多小组」推荐位 join 与目标群 join 文案逐字相同
 * （chrome 语言随账号非随群）→ 旧「页面级文档序首个 join」会误点异群 join（加错群、云端从未裁决，红线）。
 * E1（候选自身/最近祖先链接指向异群）为 corroborating 排除、只减不增。E2（推荐轮播容器）selector 待真机校准（task 0.2），
 * 校准前不接线——D1 已把推荐位挡在头部块外，E2 为纯 corroborating。
 */
const SCOPE_HELPERS_JS = String.raw`
  function __parseGroupId(pathname){
    var m = String(pathname || '').match(/\/groups\/([^\/?#]+)/i);
    if (!m || !m[1]) return null;
    var raw; try { raw = decodeURIComponent(m[1]); } catch (e) { raw = String(m[1]); }
    raw = raw.trim().toLowerCase();
    return raw || null;
  }
  function __groupIdFromHref(href){
    if (!href) return null;
    var path;
    try { path = new URL(href, location.href).pathname; } catch (e) { path = String(href); }
    return __parseGroupId(path);
  }
  var __TARGET_GID = __parseGroupId(location.pathname);
  // 从一个导航元素取它指向的 group id——不止看 a[href]：推荐位卡片常用**非锚点导航**（div[role=link] + onClick/data-*，
  // group id 编码在属性值里而非 href）。对抗评审坐实：只认 a[href] 会漏掉非锚点推荐位、头部块一路吞到 [role=main]（红线 fail-open）。
  // 故先取 href，再扫该元素所有属性值里的 /groups/<id>（兜底捕获 data-* 等编码的目标）。
  function __groupIdFromEl(el){
    if (!el) return null;
    var gid = __groupIdFromHref(el.getAttribute && el.getAttribute('href'));
    if (gid) return gid;
    if (el.attributes){
      for (var i = 0; i < el.attributes.length; i++){
        var v = el.attributes[i] && el.attributes[i].value;
        var m = v && String(v).match(/\/groups\/([^\/?#"']+)/i);
        if (m && m[1]){
          var id; try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; }
          id = id.trim().toLowerCase();
          if (id) return id;
        }
      }
    }
    return null;
  }
  // node 子树内是否含「异于目标群」的 group 导航引用——**扫全部元素**的 href/属性值（二轮评审红线闭合）：
  // group id 可能编码在 div[role=button]/裸 div 的 data-* 上（非 a[href]/role=link），只查 link 元素会漏检 → 头部块吞掉推荐位（红线）。
  // 早退于首个异群引用；无异群时全扫（即无推荐位、无风险的场景，只是确认干净）。残留仅剩「id 完全不在任何属性、只活 JS 闭包」（0.1 gated）。
  function __foreignId(el, targetGid){
    var gid = __groupIdFromEl(el);
    return !!gid && (!targetGid || gid !== targetGid);
  }
  function __hasForeignGroupRef(node, targetGid){
    if (!node) return false;
    if (__foreignId(node, targetGid)) return true; // 节点**自身**属性（三轮评审：块根自身 data-* 编码异群 id、后代扫描漏它 → 误当干净块）
    if (!node.querySelectorAll) return false;
    var els = node.querySelectorAll('*');
    for (var i = 0; i < els.length; i++){
      if (__foreignId(els[i], targetGid)) return true;
    }
    return false;
  }
  // 候选群名主标题（文档序，优先 [role=main] 内）。页面上可能有多个 h1/aria-level=1（目标群 + 各推荐卡片各一）——
  // 由 __resolveHeaderBlock 逐个甄别，取**属于目标群**的那个，绝不盲取首个（对抗评审 v4：盲取首个会取到推荐卡片的 heading）。
  function __groupHeadings(){
    var inMain = Array.from(document.querySelectorAll('[role="main"] h1,[role="main"] [role="heading"][aria-level="1"]')).filter(visible);
    if (inMain.length) return inMain;
    return Array.from(document.querySelectorAll('h1,[role="heading"][aria-level="1"]')).filter(visible);
  }
  // D1：头部/动作区 = 群名主标题上溯到「不含异群 /groups/ 引用」的最高祖先，封顶 [role=main]。
  // **对抗评审 v4 根因修（正向甄别 heading）**：只做负向（块无异群引用）不足——推荐卡片的「群名+加入」内容列本身可不带异群链接
  // （异群链接在兄弟缩略图列），其干净内容列片段会冒充目标头部、其加入钮被误点（jsdom 复现 ok=true 加错群）。
  // 正向信号 = **walk 抵达/停在 ceiling**：目标群顶层 heading 上溯只在 [role=main] 处才撞见（别处的）推荐位异群引用；
  // 而推荐卡片内的 heading 会先停在「引用异群的中层卡片容器」（低于 ceiling）。停在中层 → 该 heading 属某推荐卡片 → 跳过试下一个。
  // 逐个 heading 试，取首个「停在 ceiling 且块无异群引用」的；无一合格 → null（fail-closed）。
  function __resolveHeaderBlock(targetGid){
    var hs = __groupHeadings();
    for (var hi = 0; hi < hs.length; hi++){
      var h = hs[hi];
      var ceiling = (h.closest && h.closest('[role="main"]')) || document.body;
      var node = h;
      var brokeBelowCeiling = false;
      while (node && node !== ceiling){
        var parent = node.parentElement;
        if (!parent) break;
        if (__hasForeignGroupRef(parent, targetGid)){
          if (parent !== ceiling) brokeBelowCeiling = true; // heading 落在「引用异群的中层容器（推荐卡片）」内 → 非目标顶层 heading
          break;
        }
        node = parent;
      }
      if (brokeBelowCeiling) continue;                                    // 推荐卡片内的 heading → 试下一个
      if (node === h && __hasForeignGroupRef(node, targetGid)) continue;  // 起点 h 子树自身带异群引用 → 试下一个
      return node;
    }
    return null; // 无任一 heading 产出「停在 ceiling + 块无异群引用」的目标头部块 → fail-closed
  }
  var __HEADER_BLOCK = __resolveHeaderBlock(__TARGET_GID);
  // E1（corroborating）：候选自身或祖先链上任一元素（含属性编码 id 的 div[role=button]/裸 div）解析到异群 /groups/ → 排除。
  // 上溯 12 层足够覆盖卡片包裹；D1 已扫兄弟子树、E1 补候选祖先链，两者合起覆盖属性编码在「候选自身/祖先」与「兄弟」两类。
  function __candForeignRef(el, targetGid){
    // 只在候选到 __HEADER_BLOCK 之间查（三轮评审：走到根会被块**上方**的共享祖先异群引用误伤目标自身；块上方由 D1 处理）。
    // fix ① 后头部块 own+后代已保证无异群引用，故本 E1 实为纯 corroborating（块内不会命中）——保留作防御纵深，无固定层上限。
    for (var node = el; node; node = node.parentElement){
      if (__foreignId(node, targetGid)) return true;
      if (node === __HEADER_BLOCK) break;
    }
    return false;
  }
  // 最终判据 = D1 正向包含 AND NOT E1（E2 校准前不接线）。fail-closed：无头部块一律出域。
  function __inTargetScope(el){
    if (!__HEADER_BLOCK || !el) return false;
    if (!(__HEADER_BLOCK.contains && __HEADER_BLOCK.contains(el))) return false;
    if (__candForeignRef(el, __TARGET_GID)) return false;
    return true;
  }
  var __SCOPE_RESOLVED = __TARGET_GID != null && !!__HEADER_BLOCK;
`;

const GROUP_JOIN_OBSERVE_JS = String.raw`(function(){
  ${SCOPE_HELPERS_JS}
  var JOIN_KW = ${JSON.stringify(JOIN_CTA_LABELS)};
  var MEMBER_KW = ${JSON.stringify(MEMBER_CTA_LABELS)};
  var PENDING_KW = ${JSON.stringify(PENDING_CTA_LABELS)};
  var QUESTION_KW = ${JSON.stringify(QUESTIONNAIRE_PHRASES)};
  function visible(el){
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    var s = window.getComputedStyle ? getComputedStyle(el) : null;
    return r.width > 0 && r.height > 0 && (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01));
  }
  function text(el){ return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim(); }
  function aria(el){ return String((el && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '').replace(/\s+/g, ' ').trim(); }
  function short(v, n){ v = String(v || '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n) : v; }
  function isActionNode(el){
    if (!el || !visible(el)) return false;
    var tag = String(el.tagName || '').toLowerCase();
    var role = String(el.getAttribute('role') || '').toLowerCase();
    return tag === 'button' || tag === 'a' || role === 'button';
  }
  function disabled(el){
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null);
  }
  function anyIncludes(label, kws){ for (var i=0;i<kws.length;i++){ if (kws[i] && label.indexOf(kws[i]) >= 0) return true; } return false; }
  function ctaKind(label){
    label = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!label) return '';
    // member / pending 先判、join 后判：多语 contains 匹配（"đã tham gia"=joined 不能被 "tham gia"=join 误判）。
    if (anyIncludes(label, MEMBER_KW)) return 'member';
    if (anyIncludes(label, PENDING_KW)) return 'pending';
    if (anyIncludes(label, JOIN_KW)) return 'join';
    return '';
  }
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(visible);
  var modalText = dialogs.length ? short(text(dialogs[0]), 1400) : null;
  var h1 = Array.from(document.querySelectorAll('h1,[role="heading"][aria-level="1"],[role="main"] [role="heading"]')).filter(visible)[0]
    || Array.from(document.querySelectorAll('[role="heading"]')).filter(visible)[0] || null;
  var headerRoot = h1 && h1.closest ? (h1.closest('[role="main"]') || h1.closest('div')) : (document.querySelector('[role="main"]') || null);
  // headerText 兜底：h1/heading 抓不到时回落 [role=main] 区域文本、再回落 document.title——让云端判定角色至少拿到群名 + 按钮文案（含非英中 Join 标签）。
  var headerText = short([text(h1), headerRoot ? text(headerRoot) : ''].filter(Boolean).join(' '), 1400) || short(document.title || '', 300) || null;
  // 只扫群主体区域的动作按钮，排除顶栏/导航/侧栏等页面 chrome（真机事故:顶栏输入法「退出联想输入」被误判成成员 CTA）。
  var nodes = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(function(el){
    return isActionNode(el) && !(el.closest && el.closest('[role="banner"],[role="navigation"],[role="complementary"]'));
  });
  var main = null;
  var join = null;
  var signals = [];
  var pendingCta = false;
  // change facebook-join-candidate-scope-guard：作用域感知——mainCta / join / membershipSignals 只在「目标群作用域内」候选中选取；
  // 出域候选（多为推荐位异群 join）只如实记入 ctaCandidates（守 L4 不静默丢），绝不选取、绝不计入成员信号（防误点/误判 already_member）。
  var outOfScopeJoinCount = 0;
  var ctaCandidates = [];
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var label = short(text(node) || aria(node), 120);
    var a = short(aria(node), 120);
    var kind = ctaKind(label) || ctaKind(a);
    if (!kind) continue;
    var inScope = __inTargetScope(node);
    if (ctaCandidates.length < 16) ctaCandidates.push({ text: label || a || null, kind: kind, inTargetScope: inScope });
    if (!inScope) { if (kind === 'join') outOfScopeJoinCount++; continue; }
    if (kind === 'join') {
      // main 优先取「加入」按钮：即便成员/待审按钮在 DOM 里排更前，mainCtaText 也如实反映加入 CTA（供云端判定）。
      if (!join) join = node;
      if (!main || main.kind !== 'join') main = { el: node, text: label || null, aria: a || null, kind: 'join' };
    } else {
      if (kind === 'pending') pendingCta = true; // 多语「待审/已申请」按钮（PENDING_KW 分类），供 pending 判定（P0-2）。
      if (!main) main = { el: node, text: label || null, aria: a || null, kind: kind };
      signals.push(label || a);
    }
  }
  // L3 结构后置校验（change facebook-join-structural-verify）：群主体内是否存在可聚焦发帖/评论 composer。
  // M3 子树判别：只认 [role=main] 内的 [contenteditable]/[role=textbox]，排除顶栏/导航/侧栏 chrome 与搜索框
  //（顶栏搜索、群内搜索按 aria/placeholder「搜索」多语词剔除），避免把无关输入框当发帖框。选择器精度留真机取证细化。
  function isComposer(el){
    if (!el || !visible(el)) return false;
    if (el.closest && el.closest('[role="banner"],[role="navigation"],[role="complementary"],[role="search"]')) return false;
    var ph = String((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || '').toLowerCase();
    if (/search|搜索|搜尋|tìm kiếm|buscar|cari|recherch|suche|ค้นหา/.test(ph)) return false;
    return true;
  }
  // fail-closed：无 [role=main] 时不认 composer（否则任意页面 textbox 如 Messenger 抽屉会被当群发帖框）。
  var mainEl = document.querySelector('[role="main"]');
  var composerPresent = !!mainEl && Array.from(document.querySelectorAll('[contenteditable="true"],[role="textbox"]')).some(function(el){
    return isComposer(el) && mainEl.contains && mainEl.contains(el);
  });
  // joinCtaPresent = 群主体内是否有可见「加入」CTA（即上方分类到的 join 节点）。承重闸用。
  var joinCtaPresent = !!join;
  var modalLower = String(modalText || '').toLowerCase();
  var headerLower = String(headerText || '').toLowerCase();
  // 待审/问卷改用多语词表 contains（P0-2）：pendingCta = 多语「待审」按钮已分类；modal/header 文本亦对多语词表命中。
  var pending = pendingCta || anyIncludes(modalLower, PENDING_KW);
  var questionnaire = anyIncludes(modalLower, QUESTION_KW) || anyIncludes(headerLower, QUESTION_KW);
  var login = /\/login|\/checkpoint|\/recover/i.test(location.pathname);
  var captcha = /(captcha|security check|人机验证|安全验证)/i.test(modalLower);
  var btn = null;
  if (join) {
    var r = join.getBoundingClientRect();
    btn = {
      found: true,
      disabled: disabled(join),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      text: short(text(join), 120) || null,
      aria: short(aria(join), 120) || null
    };
  }
  return JSON.stringify({
    pageUrl: location.href,
    title: document.title || '',
    actionNodeCount: nodes.length,
    documentReady: document.readyState,
    mainCtaText: main ? main.text : null,
    mainCtaAria: main ? main.aria : null,
    headerText: headerText || null,
    modalText: modalText,
    membershipSignals: signals.slice(0, 8),
    loginRequired: login,
    captchaDetected: captcha,
    questionnaireRequired: questionnaire,
    pendingRequest: pending,
    navError: null,
    composerPresent: composerPresent,
    joinCtaPresent: joinCtaPresent,
    targetGroupId: __TARGET_GID,
    scopeResolved: __SCOPE_RESOLVED,
    outOfScopeJoinCount: outOfScopeJoinCount,
    ctaCandidates: ctaCandidates,
    joinButton: btn || { found: false }
  });
})()`;

/**
 * 在页面内**重新定位**群主体区域的「加入」按钮并调用其 `.click()`（真机实证:FB 的加入控件是
 * `div[role=button]` + React 合成事件，CDP 坐标鼠标点击不可靠——页面水合时布局漂移使坐标落空、
 * 且派发的 mouse 事件序列未必触发其处理器；`element.click()` 在同一按钮上稳定翻成「已加入」）。
 * 点击前在 join-executor 侧另做一次拟人 hover 移动到按钮（保留 mousemove 轨迹供反检测），此处只负责
 * 「点当下真实存在的那个加入按钮」——不依赖过期坐标。分类关键词与 GROUP_JOIN_OBSERVE_JS 同源（同三张多语表）。
 * 表达式带唯一标记 __FB_JOIN_CLICK__ 便于测试桩区分「点击 eval」与「观察 eval」，不打乱观察序列。
 */
const GROUP_JOIN_CLICK_JS = String.raw`/*__FB_JOIN_CLICK__*/(function(){
  ${SCOPE_HELPERS_JS}
  var JOIN_KW = ${JSON.stringify(JOIN_CTA_LABELS)};
  var MEMBER_KW = ${JSON.stringify(MEMBER_CTA_LABELS)};
  var PENDING_KW = ${JSON.stringify(PENDING_CTA_LABELS)};
  function visible(el){
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    var s = window.getComputedStyle ? getComputedStyle(el) : null;
    return r.width > 0 && r.height > 0 && (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01));
  }
  function text(el){ return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim(); }
  function aria(el){ return String((el && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '').replace(/\s+/g, ' ').trim(); }
  function disabled(el){ return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null); }
  function anyIncludes(label, kws){ for (var i=0;i<kws.length;i++){ if (kws[i] && label.indexOf(kws[i]) >= 0) return true; } return false; }
  function ctaKind(label){
    label = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!label) return '';
    if (anyIncludes(label, MEMBER_KW)) return 'member';
    if (anyIncludes(label, PENDING_KW)) return 'pending';
    if (anyIncludes(label, JOIN_KW)) return 'join';
    return '';
  }
  // change facebook-join-candidate-scope-guard：作用域 fail-closed——目标群 id 解析失败 或 头部块解析不出 → 诚实 scope_unresolved、绝不页面级点。
  if (__TARGET_GID == null || !__HEADER_BLOCK) return JSON.stringify({ clicked: false, reason: 'scope_unresolved' });
  var nodes = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(function(el){
    return visible(el) && !(el.closest && el.closest('[role="banner"],[role="navigation"],[role="complementary"]'));
  });
  // 只在「目标群头部/动作区」内取文档序首个 join；**删除**「页面级文档序第一个 join」回落——那正是误点推荐位异群 join 的路径。
  // 组合规则与 GROUP_JOIN_OBSERVE_JS 逐字一致（kind = ctaKind(text||aria) || ctaKind(aria)，且 __inTargetScope 同源）：
  // 保证点到的正是观察校验为加入、且在目标群作用域内的那个节点，绝不点成员/待审节点（点「退出/取消」即自残）、绝不点异群 join（加错群即红线）。
  var target = null;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var kind = ctaKind(text(node) || aria(node)) || ctaKind(aria(node));
    if (kind === 'join' && __inTargetScope(node)) { target = node; break; }
  }
  // 作用域内无 join 候选（目标自身是 member/pending/晚渲染，仅推荐位有异群 join）→ 诚实 no_target_in_scope、绝不越域找 join 冒充点过。
  if (!target) return JSON.stringify({ clicked: false, reason: 'no_target_in_scope' });
  // 禁用态诚实 bail（与 observe 的 pre-click disabled 闸一致）——绝不点已禁用/占位按钮冒充点过。
  if (disabled(target)) return JSON.stringify({ clicked: false, reason: 'disabled' });
  var r = target.getBoundingClientRect();
  try { target.click(); } catch (e) { return JSON.stringify({ clicked: false, error: String((e && e.message) || e) }); }
  return JSON.stringify({ clicked: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: String(text(target)).slice(0, 120) });
})()`;

export class FacebookJoinExecutor {
  private readonly cdp: BrowseCdp;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly acceptConsent: FacebookConsentAccepter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookJoinExecutorOptions>;

  constructor(deps: FacebookJoinExecutorDeps, options: FacebookJoinExecutorOptions = {}) {
    this.cdp = deps.cdp;
    this.overlayMonitor = deps.overlayMonitor;
    this.acceptConsent = deps.acceptConsent ?? defaultFacebookConsentAccepter();
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.logger ?? (() => {});
    this.opts = { ...DEFAULTS, ...options };
  }

  async joinGroup(groupUrlInput: string, options: { click?: boolean; thinkMs?: number } = {}): Promise<FacebookJoinResult> {
    const groupUrl = canonicalGroupUrl(groupUrlInput);
    if (!groupUrl) {
      return { ok: false, reason: 'not_facebook', groupUrl: groupUrlInput, clicked: false };
    }
    let observation: FacebookGroupJoinObservation | undefined;
    try {
      await this.cdp.send('Page.navigate', { url: groupUrl });
      if (this.opts.settleMs > 0) await this.sleep(this.opts.settleMs);
      // 就绪轮询（change fb-group-join-wait-render）：反复观察，直到出现决定性信号（加入按钮已渲染 / 已是成员 /
      // 需登录 / 验证码 / 问卷 / 待审 / 同意浮层清不掉）或触上限——按「页面真加载出来」判定，而非死等固定时长
      // （FB 群页头部+按钮实测常需数秒、且网络不稳）。同意/阻断浮层在轮询内每轮幂等处理。触上限仍无信号 → 用最后一次观察诚实交云端判定。
      const ready = await this.observeUntilReady(groupUrl);
      if (ready.consentBlocked) {
        observation = ready.observation;
        return { ok: false, reason: 'blocked_by_consent', groupUrl, clicked: false, observation };
      }
      if (ready.block) {
        observation = ready.observation;
        return { ok: false, reason: ready.block, groupUrl, clicked: false, observation };
      }
      observation = ready.observation;
      const raw: RawJoinObservation = ready.raw ?? {};
      if (observation.loginRequired) return { ok: false, reason: 'login_required', groupUrl, clicked: false, observation };
      if (observation.captchaDetected) return { ok: false, reason: 'blocked_by_captcha', groupUrl, clicked: false, observation };
      // already_member 仅当**域内无 join 按钮**时成立（矛盾守卫，对抗评审红线闭合补强）：一个显示「加入」CTA 的群绝不可能是你已加入的群，
      // 故「有成员信号 + 同时有域内 join 按钮」必是异群信号污染（如极端不透明推荐位漏出域）→ 不判 already_member、照常去点目标自身 join。
      if (hasMemberSignal(observation) && !raw.joinButton?.found) {
        return { ok: false, reason: 'already_member', groupUrl, clicked: false, observation };
      }
      if (observation.questionnaireRequired) return { ok: false, reason: 'questionnaire_required', groupUrl, clicked: false, observation };
      if (observation.pendingRequest) return { ok: false, reason: 'pending', groupUrl, clicked: false, observation };
      // L3：observe/pre-click **不据结构判 already_member**（对抗评审揪出）——此处无点击，joinCtaPresent 词表派生会 fail-open，
      // 结构 already_member 会没点击就 markJoined、污染账本、在没加入的群假评论。结构判定仅用于 post-click 的「跃迁」（见 structuralJoinConfirmed）。
      // observe 期已加入只认词表 hasMemberSignal（权威正向标签）。

      const button = raw.joinButton;
      // P1-5：就绪轮询触顶但页面仍未最小就绪（仍 loading / 无动作节点）且没抓到加入按钮 → not_ready（可重试网络瞬态）。
      // 供云端直接短退避重试，绝不把「慢渲染」当成 observation_only 喂给判定角色 → fail-closed → 永久失败（本 change 治的主因）。
      if (!isMinimallyReady(observation) && !button?.found) {
        return { ok: false, reason: 'not_ready', groupUrl, clicked: false, observation };
      }
      if (!options.click) return { ok: false, reason: 'observation_only', groupUrl, clicked: false, observation };

      // change facebook-join-candidate-scope-guard（Fix，对抗评审 Finding 2）：作用域未确立（页面已就绪但目标群 id/头部块解析不出）
      // → not_ready 可重试瞬态，绝不落 no_button——no_button 被云端判永久 failed（不进重试池），会把「重导航/晚渲染时暂时框不住
      // 作用域」的可加入群永久丢弃。fail-closed 安全侧：不点、可重试。
      if (observation.scopeResolved === false) {
        return { ok: false, reason: 'not_ready', groupUrl, clicked: false, observation };
      }
      if (!button?.found || button.disabled || typeof button.x !== 'number' || typeof button.y !== 'number') {
        return { ok: false, reason: 'no_button', groupUrl, clicked: false, observation };
      }
      // 点击前定值稳定等待（change fb-group-join-timeouts）：加入按钮常在 interactive 阶段就渲染，但此时 React 可能尚未
      // 挂上点击处理器→点了不生效（真机:同群早点点空、页面稳定后点成功）。点前多等一小会儿让水合完成再点，更可靠。
      if (this.opts.preClickSettleMs > 0) await this.sleep(this.opts.preClickSettleMs);
      if (options.thinkMs && options.thinkMs > 0) await this.sleep(options.thinkMs);
      // 拟人 hover 移动到按钮（就绪观察时的坐标，仅为保留 mousemove 轨迹供反检测）——落点是否精确不影响结果，
      // 真正的点击由页面内 element.click() 完成（change fb-group-join-js-click：真机实证坐标点击不让 FB 加入、JS 点击稳定生效）。
      try {
        await dispatchHover(this.cdp, button.x, button.y);
      } catch {
        /* hover 仅拟人化，失败不影响后续 JS 点击。 */
      }
      const clickResult = await evalJson<{ clicked?: boolean; reason?: string }>(this.cdp, GROUP_JOIN_CLICK_JS);
      if (!clickResult?.clicked) {
        const bail = clickResult?.reason;
        // 作用域守卫 fail-closed（scope_unresolved：目标群 id/头部块解析不出；no_target_in_scope：域内无 join 候选）
        // → 「未能确立作用域、无法确信下手」的可重试瞬态，映射 not_ready（云端短退避重试、不计入尝试上限）。绝不折叠成 no_button：
        // no_button 被云端判永久 failed（对抗评审 Finding 2 坐实），会把「重导航/晚渲染时暂时框不住作用域」的可加入群永久丢弃。
        if (bail === 'scope_unresolved' || bail === 'no_target_in_scope') {
          this.log(`[fb-join] click bail (scope-guard, retryable): ${bail}`);
          return { ok: false, reason: 'not_ready', groupUrl, clicked: false, observation };
        }
        // 点击瞬间按钮已消失/不可点（布局漂移或已被他路加入）→ 诚实 no_button，绝不冒充点过（既有行为）。
        return { ok: false, reason: 'no_button', groupUrl, clicked: false, observation };
      }
      if (this.opts.waitAfterClickMs > 0) await this.sleep(this.opts.waitAfterClickMs);
      // 点击后轮询（change fb-group-join-postclick-wait）：等成员态真渲染出来再判——FB 常在点击后数秒才把按钮从「加入小组」
      // 翻成「已加入」，死等一次会把已成功的加入误判成 join_failed。轮询到 已加入/待审/问卷/登录/验证码 或触上限。
      const post = await this.observePostClickUntilSettled(groupUrl, observation);
      const postObservation = post.observation;
      if (post.reason === 'joined') return { ok: true, groupUrl, clicked: true, observation, postObservation };
      if (post.reason) return { ok: false, reason: post.reason, groupUrl, clicked: true, observation, postObservation };
      // 触上限仍未见成员态：页面已最小就绪却仍无成员态 → 诚实 join_failed；仍在加载/无动作节点 → post_not_confirmed_slow
      //（P1-5：慢渲染瞬态，供云端短退避重试而非当终局失败）。两者都绝不冒充成功。
      const settled = isMinimallyReady(postObservation);
      return { ok: false, reason: settled ? 'join_failed' : 'post_not_confirmed_slow', groupUrl, clicked: true, observation, postObservation };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[fb-join] joinGroup failed: ${message}`);
      return {
        ok: false,
        reason: 'nav_error',
        groupUrl,
        clicked: false,
        observation: observation ?? { groupUrl, navError: message },
      };
    }
  }

  /**
   * 就绪轮询（change fb-group-join-wait-render）：导航后反复观察，直到出现**决定性信号**再返回——
   * 加入按钮已渲染 / 已是成员 / 需登录 / 验证码 / 问卷 / 待审 / 同意浮层清不掉。避免在 FB 群页尚未渲染出
   * 头部与按钮（实测常需数秒、网络不稳）时就过早观察到空页面而误判 ambiguous。触上限仍无信号 → 返回最后一次
   * 观察（诚实交云端判定，绝不假成功）。同意/阻断浮层每轮幂等处理，任意时刻出现都能捕获。
   */
  private async observeUntilReady(groupUrl: string): Promise<{
    raw?: RawJoinObservation;
    observation: FacebookGroupJoinObservation;
    block?: 'login_required' | 'blocked_by_captcha';
    consentBlocked?: boolean;
  }> {
    const pollMs = Math.max(50, this.opts.pollMs);
    const maxPolls = Math.max(1, Math.ceil(this.opts.readyTimeoutMs / pollMs));
    const deadline = Date.now() + this.opts.readyTimeoutMs;
    let lastRaw: RawJoinObservation | undefined;
    let lastObs: FacebookGroupJoinObservation = { groupUrl };
    for (let i = 0; i < maxPolls; i++) {
      const consent = await this.acceptConsent(this.cdp);
      if (consent.handled && !consent.cleared) {
        return { observation: await this.collectObservation(groupUrl, {}), consentBlocked: true };
      }
      const block = await this.blockingReason();
      if (block) {
        return {
          observation: await this.collectObservation(groupUrl, {
            [block === 'login_required' ? 'loginRequired' : 'captchaDetected']: true,
          }),
          block,
        };
      }
      const raw = await evalJson<RawJoinObservation>(this.cdp, GROUP_JOIN_OBSERVE_JS);
      const obs = publicObservation(raw, groupUrl);
      lastRaw = raw;
      lastObs = obs;
      if (this.isDecisiveObservation(raw, obs)) return { raw, observation: obs };
      if (Date.now() >= deadline) break;
      await this.sleep(pollMs);
    }
    return { raw: lastRaw, observation: lastObs };
  }

  /**
   * 是否已出现足以判定的信号：明确门槛/阻断态（登录/验证码/问卷/待审）、已是成员、或**加入按钮真渲染出来且页面已过 loading**。
   * 刻意 NOT 把「有任意 mainCtaText」当决定性——真机事故:loading 阶段无关 chrome 按钮被分类后轮询误以为拿到信号而提前停。
   * 加入按钮还要求 documentReady 已过 'loading'——真机事故:加入按钮在 loading 瞬间就出现、轮询立即停，把 loading 态观察
   * 送给云端 LLM，LLM 因「UI 未加载完」保守判 ambiguous（实测:同群在 interactive 态判 instant_join、在 loading 态判 ambiguous）。
   * 阻断/成员/门槛态是确定性状态、不受 readyState 影响，立即决定；只有需 LLM 判的「加入」case 等到页面稳定。
   */
  private isDecisiveObservation(raw: RawJoinObservation, obs: FacebookGroupJoinObservation): boolean {
    if (obs.loginRequired || obs.captchaDetected || obs.questionnaireRequired || obs.pendingRequest) return true;
    if (hasMemberSignal(obs)) return true;
    // L3：不把结构成员态当 observe 期决定性信号（结构判定仅用于 post-click 跃迁；observe 期据结构判 already_member 已删除）。
    if (raw.joinButton?.found && obs.documentReady !== 'loading') return true;
    return false;
  }

  /**
   * 点击「加入」后轮询等成员态渲染（change fb-group-join-postclick-wait）：FB 常在点击后数秒才把按钮从「加入小组」
   * 翻成「已加入」（真机实测:+2s 时仍显示加入小组、documentReady=interactive，加载完后才变已加入）。反复观察直到
   * 已加入（joined）/ 待审（pending）/ 问卷（questionnaire）/ 登录 / 验证码 出现，或触上限。触上限仍未见成员态 →
   * 无 reason 返回（调用方判 join_failed，诚实、绝不因"点过了"就冒充成功）。
   */
  private async observePostClickUntilSettled(
    groupUrl: string,
    /** 同一次 click 导航内的点前观测——供 L3「跃迁」判据（composer 点前无、点后有）。 */
    preObservation: FacebookGroupJoinObservation | undefined,
  ): Promise<{
    observation: FacebookGroupJoinObservation;
    reason?: 'joined' | 'pending' | 'questionnaire_required' | 'login_required' | 'blocked_by_captcha';
  }> {
    const pollMs = Math.max(50, this.opts.pollMs);
    const maxPolls = Math.max(1, Math.ceil(this.opts.postClickTimeoutMs / pollMs));
    const deadline = Date.now() + this.opts.postClickTimeoutMs;
    let last: FacebookGroupJoinObservation = { groupUrl };
    for (let i = 0; i < maxPolls; i++) {
      const raw = await evalJson<RawJoinObservation>(this.cdp, GROUP_JOIN_OBSERVE_JS);
      const obs = publicObservation(raw, groupUrl);
      await this.dismissOptionalModal(obs);
      last = obs;
      if (obs.loginRequired) return { observation: obs, reason: 'login_required' };
      if (obs.captchaDetected) return { observation: obs, reason: 'blocked_by_captcha' };
      if (hasMemberSignal(obs)) return { observation: obs, reason: 'joined' }; // 词表命中：权威成员标签，authoritative
      // 顺序（L3）：pending/问卷先于结构 joined——Join→Pending 翻转即便渲了 composer 也判 pending、不判 joined。
      if (obs.questionnaireRequired) return { observation: obs, reason: 'questionnaire_required' };
      if (obs.pendingRequest) return { observation: obs, reason: 'pending' };
      // L3 结构主判（承重 = 语言无关「跃迁」）：composer 点前无、点后有 → 点击真让本账号成为成员 → joined。
      // 非成员公开组点前已有 composer → 无跃迁、不误判；未覆盖语种加入据此仍被识别（消灭重复加群），且不依赖词表派生的 joinCtaPresent。
      if (structuralJoinConfirmed(preObservation, obs)) return { observation: obs, reason: 'joined' };
      if (Date.now() >= deadline) break;
      await this.sleep(pollMs);
    }
    return { observation: last };
  }

  private async collectObservation(
    groupUrl: string,
    flags: Partial<Pick<FacebookGroupJoinObservation, 'loginRequired' | 'captchaDetected'>>,
  ): Promise<FacebookGroupJoinObservation> {
    try {
      const raw = await evalJson<RawJoinObservation>(this.cdp, GROUP_JOIN_OBSERVE_JS);
      return { ...publicObservation(raw, groupUrl), ...flags };
    } catch {
      return { groupUrl, ...flags };
    }
  }

  private async blockingReason(): Promise<'login_required' | 'blocked_by_captcha' | undefined> {
    const monitor = this.overlayMonitor;
    if (!monitor) return undefined;
    let kind: OverlayKind;
    try {
      kind = await monitor.probeNow();
    } catch {
      return 'blocked_by_captcha';
    }
    if (kind === 'login') return 'login_required';
    if (kind === 'captcha' || kind === 'unknown') return 'blocked_by_captcha';
    return undefined;
  }

  private async dismissOptionalModal(observation: FacebookGroupJoinObservation): Promise<void> {
    // P1-7：只清「明确无关的可选浮层」。凡是问卷 / 待审 / 或 modal 文本含加群流程信号（含词表未覆盖语种的入群门），
    // 一律不盲 Esc——绝不破坏真的入群问卷/审批门（破坏性动作比误判更差）。诚实留给后续轮询/上层判定。
    if (!observation.modalText || observation.questionnaireRequired || observation.pendingRequest) return;
    if (modalLooksJoinRelated(observation.modalText)) return;
    try {
      await pressEscape(this.cdp);
    } catch {
      /* Optional survey dismissal is best-effort and must not turn a real result into failure. */
    }
  }
}
