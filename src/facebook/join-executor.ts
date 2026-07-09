import { dispatchClick, evalJson, pressEscape, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../browse/overlay-monitor.js';
import { isUrlAllowedByTargetDescriptor } from '../platform/driver.js';
import { FACEBOOK_TARGET } from './driver.js';

export type FacebookJoinReason =
  | 'observation_only'
  | 'already_member'
  | 'questionnaire_required'
  | 'pending'
  | 'no_button'
  | 'not_facebook'
  | 'login_required'
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
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

export interface FacebookJoinExecutorOptions {
  settleMs?: number;
  waitAfterClickMs?: number;
}

const DEFAULTS: Required<FacebookJoinExecutorOptions> = {
  settleMs: 2_500,
  waitAfterClickMs: 2_000,
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
  };
}

function hasMemberSignal(obs: FacebookGroupJoinObservation | undefined): boolean {
  if (!obs) return false;
  const cta = (obs.mainCtaText ?? '').trim().toLowerCase();
  const aria = (obs.mainCtaAria ?? '').trim().toLowerCase();
  if (['joined', 'leave group', '已加入', '退出小组'].some((s) => cta === s || aria === s)) return true;
  return (obs.membershipSignals ?? []).some((signal) => {
    const s = signal.toLowerCase();
    return ['you are now a member', 'member of this group', '已是成员', '你已加入'].some((needle) => s.includes(needle));
  });
}

const GROUP_JOIN_OBSERVE_JS = String.raw`(function(){
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
  function ctaKind(label){
    label = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!label) return '';
    if (/^(join|join group|加入小组|加入社团|加入群组)$/.test(label)) return 'join';
    if (/^(joined|leave group|已加入|退出小组)$/.test(label)) return 'member';
    if (/^(pending|request sent|cancel request|待批准|已申请)$/.test(label)) return 'pending';
    return '';
  }
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(visible);
  var modalText = dialogs.length ? short(text(dialogs[0]), 1400) : null;
  var h1 = Array.from(document.querySelectorAll('h1,[role="heading"][aria-level="1"]')).filter(visible)[0] || null;
  var headerRoot = h1 && h1.closest ? (h1.closest('[role="main"]') || h1.closest('div')) : null;
  var headerText = short([text(h1), headerRoot ? text(headerRoot) : ''].filter(Boolean).join(' '), 1400);
  var nodes = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(isActionNode);
  var main = null;
  var join = null;
  var signals = [];
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var label = short(text(node) || aria(node), 120);
    var a = short(aria(node), 120);
    var kind = ctaKind(label) || ctaKind(a);
    if (!kind) continue;
    if (!main) main = { el: node, text: label || null, aria: a || null, kind: kind };
    if (kind === 'join' && !join) join = node;
    if (kind === 'member' || kind === 'pending') signals.push(label || a);
  }
  var modalLower = String(modalText || '').toLowerCase();
  var headerLower = String(headerText || '').toLowerCase();
  var pending = signals.some(function(s){ return /(pending|request sent|cancel request|待批准|已申请)/i.test(s); }) ||
    /(pending|request sent|cancel request|待批准|已申请)/i.test(modalLower);
  var questionnaire = /(membership questions|answer questions|required question|回答问题|入群问题|必答)/i.test(modalLower) ||
    /(membership questions|answer questions|回答问题|入群问题)/i.test(headerLower);
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

export class FacebookJoinExecutor {
  private readonly cdp: BrowseCdp;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookJoinExecutorOptions>;

  constructor(deps: FacebookJoinExecutorDeps, options: FacebookJoinExecutorOptions = {}) {
    this.cdp = deps.cdp;
    this.overlayMonitor = deps.overlayMonitor;
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
      await this.sleep(this.opts.settleMs);
      const block = await this.blockingReason();
      if (block) {
        observation = await this.collectObservation(groupUrl, { [block === 'login_required' ? 'loginRequired' : 'captchaDetected']: true });
        return { ok: false, reason: block, groupUrl, clicked: false, observation };
      }
      const raw = await evalJson<RawJoinObservation>(this.cdp, GROUP_JOIN_OBSERVE_JS);
      observation = publicObservation(raw, groupUrl);
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
      if (options.thinkMs && options.thinkMs > 0) await this.sleep(options.thinkMs);
      await dispatchClick(this.cdp, button.x, button.y);
      await this.sleep(this.opts.waitAfterClickMs);
      const postRaw = await evalJson<RawJoinObservation>(this.cdp, GROUP_JOIN_OBSERVE_JS);
      const postObservation = publicObservation(postRaw, groupUrl);
      await this.dismissOptionalModal(postObservation);
      if (hasMemberSignal(postObservation)) {
        return { ok: true, groupUrl, clicked: true, observation, postObservation };
      }
      if (postObservation.questionnaireRequired) {
        return { ok: false, reason: 'questionnaire_required', groupUrl, clicked: true, observation, postObservation };
      }
      if (postObservation.pendingRequest) {
        return { ok: false, reason: 'pending', groupUrl, clicked: true, observation, postObservation };
      }
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
