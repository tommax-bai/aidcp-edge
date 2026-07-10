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
  };
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

const GROUP_JOIN_OBSERVE_JS = String.raw`(function(){
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
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var label = short(text(node) || aria(node), 120);
    var a = short(aria(node), 120);
    var kind = ctaKind(label) || ctaKind(a);
    if (!kind) continue;
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
  var nodes = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(function(el){
    return visible(el) && !(el.closest && el.closest('[role="banner"],[role="navigation"],[role="complementary"]'));
  });
  // 取「第一个 join 节点」，组合规则与 GROUP_JOIN_OBSERVE_JS 的 main/join 选取逐字一致（kind = ctaKind(text||aria) || ctaKind(aria)）：
  // 保证点到的正是观察校验为加入的那个节点，绝不因规则漂移点到成员/待审节点（点「退出/取消」即自残）。
  var target = null;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var kind = ctaKind(text(node) || aria(node)) || ctaKind(aria(node));
    if (kind === 'join') { target = node; break; }
  }
  if (!target) return JSON.stringify({ clicked: false });
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
      if (hasMemberSignal(observation)) return { ok: false, reason: 'already_member', groupUrl, clicked: false, observation };
      if (observation.questionnaireRequired) return { ok: false, reason: 'questionnaire_required', groupUrl, clicked: false, observation };
      if (observation.pendingRequest) return { ok: false, reason: 'pending', groupUrl, clicked: false, observation };
      if (!options.click) return { ok: false, reason: 'observation_only', groupUrl, clicked: false, observation };

      const button = raw.joinButton;
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
      const clickResult = await evalJson<{ clicked?: boolean }>(this.cdp, GROUP_JOIN_CLICK_JS);
      if (!clickResult?.clicked) {
        // 点击瞬间按钮已消失/不可点（布局漂移或已被他路加入）→ 诚实 no_button，绝不冒充点过。
        return { ok: false, reason: 'no_button', groupUrl, clicked: false, observation };
      }
      if (this.opts.waitAfterClickMs > 0) await this.sleep(this.opts.waitAfterClickMs);
      // 点击后轮询（change fb-group-join-postclick-wait）：等成员态真渲染出来再判——FB 常在点击后数秒才把按钮从「加入小组」
      // 翻成「已加入」，死等一次会把已成功的加入误判成 join_failed。轮询到 已加入/待审/问卷/登录/验证码 或触上限。
      const post = await this.observePostClickUntilSettled(groupUrl);
      const postObservation = post.observation;
      if (post.reason === 'joined') return { ok: true, groupUrl, clicked: true, observation, postObservation };
      if (post.reason) return { ok: false, reason: post.reason, groupUrl, clicked: true, observation, postObservation };
      // 触上限仍未见成员态：按钮还停在「加入小组」→ 诚实 join_failed（绝不冒充成功）。
      return { ok: false, reason: 'join_failed', groupUrl, clicked: true, observation, postObservation };
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
      if (hasMemberSignal(obs)) return { observation: obs, reason: 'joined' };
      if (obs.questionnaireRequired) return { observation: obs, reason: 'questionnaire_required' };
      if (obs.pendingRequest) return { observation: obs, reason: 'pending' };
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
    if (!observation.modalText || observation.questionnaireRequired) return;
    try {
      await pressEscape(this.cdp);
    } catch {
      /* Optional survey dismissal is best-effort and must not turn a real result into failure. */
    }
  }
}
