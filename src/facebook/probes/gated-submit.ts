import { createHash } from 'node:crypto';
import type { BrowseCdp } from '../../browse/cdp-util.js';
import {
  dispatchClick,
  dispatchKey,
  evalJson,
  insertText,
} from '../../browse/cdp-util.js';
import type { OverlayKind } from '../../browse/overlay-monitor.js';
import { classifyFacebookOverlay } from '../overlay.js';
import { defaultFacebookConsentAccepter, type FacebookConsentAccepter } from '../consent.js';

export type FacebookGatedSubmitPreflightReason =
  | 'disabled'
  | 'not_disposable'
  | 'missing_target_url'
  | 'target_not_facebook'
  | 'current_not_facebook'
  | 'target_mismatch'
  | 'blocked_by_consent'
  | 'blocked_by_login'
  | 'blocked_by_captcha'
  | 'blocked_by_unknown';

export interface FacebookGatedSubmitPreflightOptions {
  enabled?: boolean;
  disposableAccountConfirmed?: boolean;
  targetUrl?: string;
  currentUrl?: string;
  classifyOverlay?: (cdp: BrowseCdp) => Promise<OverlayKind>;
  /**
   * cookie 同意浮层自动接受器（缺省用 env 策略）。在 overlay 分类前置调用：
   * 同意条是良性合规横幅、先拟人接受清掉，clear 后原动作照常放行；清不掉则诚实 blocked_by_consent。
   */
  acceptConsent?: FacebookConsentAccepter;
}

export type FacebookGatedSubmitPreflightResult =
  | { ok: true; targetUrl: string; currentUrl: string; overlay: 'none' }
  | { ok: false; reason: FacebookGatedSubmitPreflightReason; overlay?: OverlayKind; targetUrl?: string; currentUrl?: string };

export type FacebookGatedSubmitProbeReason =
  | FacebookGatedSubmitPreflightReason
  | 'missing_comment_text'
  | 'editor_not_found'
  | 'permission_gated'
  | 'focus_failed'
  | 'marker_not_accepted'
  | 'submit_control_not_found'
  | 'submit_control_disabled'
  | 'not_confirmed_after_reload';

export interface FacebookGatedSubmitProbeOptions extends FacebookGatedSubmitPreflightOptions {
  commentText?: string;
  allowGroupQuestionEditor?: boolean;
  waitAfterSubmitMs?: number;
  waitAfterReloadMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FacebookGatedSubmitProbeResult {
  ok: boolean;
  reason?: FacebookGatedSubmitProbeReason;
  submitted: boolean;
  serverConfirmed: boolean;
  markerHash?: string;
  preflight: FacebookGatedSubmitPreflightResult;
  editorFound: boolean;
  focused: boolean;
  permissionGated: boolean;
  markerAccepted: boolean;
  submitControlObserved: boolean;
  submitControlLabel: string | null;
  optimisticVisible: boolean;
  reloadedVisible: boolean;
}

function isFacebookUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'facebookcorewwwi.onion';
  } catch {
    return false;
  }
}

function normalizeTarget(value: string): string {
  const url = new URL(value);
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function overlayReason(kind: Exclude<OverlayKind, 'none'>): FacebookGatedSubmitPreflightReason {
  if (kind === 'login') return 'blocked_by_login';
  if (kind === 'captcha') return 'blocked_by_captcha';
  return 'blocked_by_unknown';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markerHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function jsBool(value: boolean): string {
  return value ? 'true' : 'false';
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

const SUBMIT_HELPERS_JS = String.raw`
function fbVisible(el){
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  var s = window.getComputedStyle ? getComputedStyle(el) : null;
  return r.width > 0 && r.height > 0 && (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01));
}
function fbText(el){ return String((el && el.innerText) || (el && el.textContent) || '').replace(/\s+/g, ' ').trim(); }
function fbLabel(el){ return String((el && (el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder'))) || '').replace(/\s+/g, ' ').trim(); }
function fbIsCommentEditor(el){
  var label = fbLabel(el);
  return /写评论|发表评论|Write a comment|Comment as|Comment|输入回答|Answer/i.test(label) ||
    /写评论|Write a comment/i.test(fbText(el));
}
function fbIsGroupQuestionEditor(el){
  return /输入回答|Answer/i.test(fbLabel(el));
}
function fbJoinSignalVisible(){
  var body = fbText(document.body);
  var inGroup = /^\/groups\//i.test(location.pathname);
  return inGroup && /(加入小组|Join group|\bJoin\b|待批准|Pending|回答问题|Answer questions)/i.test(body);
}
function fbFindEditor(){
  var candidates = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).filter(function(el){
    return fbVisible(el) && fbIsCommentEditor(el);
  });
  return candidates[0] || null;
}
function fbActiveOrFirstEditor(){
  var active = document.activeElement;
  if (active && active.matches && active.matches('[contenteditable="true"][role="textbox"]')) return active;
  return fbFindEditor();
}
function fbDisabled(el){
  return !!(el && (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null));
}
function fbSubmitRoot(editor){
  return (editor && editor.closest && (editor.closest('[role="article"]') || editor.closest('form'))) || document;
}
function fbFindSubmitControl(editor){
  var root = fbSubmitRoot(editor);
  var nodes = Array.from(root.querySelectorAll('button,[role="button"],div[aria-label],span[aria-label]'));
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!fbVisible(el)) continue;
    var label = fbLabel(el) || fbText(el);
    if (!/^(发布评论|发表评论|Post|Comment|Reply|Send)$/i.test(label)) continue;
    var r = el.getBoundingClientRect();
    return {
      observed: true,
      label: label.slice(0, 40),
      disabled: fbDisabled(el),
      x: r.left + r.width / 2,
      y: r.top + r.height / 2
    };
  }
  return { observed: false, label: null, disabled: false, x: null, y: null };
}
`;

function buildFocusEditorJs(allowGroupQuestionEditor: boolean): string {
  return `(function(){${SUBMIT_HELPERS_JS}
    var el = fbFindEditor();
    if (!el) return JSON.stringify({ found:false, focused:false, permissionGated:false });
    var permissionGated = (!${jsBool(allowGroupQuestionEditor)} && (fbIsGroupQuestionEditor(el) || fbJoinSignalVisible()));
    if (permissionGated) return JSON.stringify({ found:true, focused:false, permissionGated:true });
    try { el.scrollIntoView({ block:'center' }); } catch(e) {}
    try { el.focus(); } catch(e) {}
    return JSON.stringify({ found:true, focused:document.activeElement === el, permissionGated:false });
  })()`;
}

function buildSubmitReadinessJs(commentText: string): string {
  return `(function(){${SUBMIT_HELPERS_JS}
    var el = fbActiveOrFirstEditor();
    if (!el) return JSON.stringify({ found:false, markerAccepted:false, submitControlObserved:false, submitControlLabel:null, submitControlDisabled:false, x:null, y:null });
    var t = fbText(el);
    var submit = fbFindSubmitControl(el);
    return JSON.stringify({
      found:true,
      markerAccepted:t.indexOf(${jsString(commentText)}) >= 0,
      submitControlObserved:submit.observed,
      submitControlLabel:submit.label,
      submitControlDisabled:submit.disabled,
      x:submit.x,
      y:submit.y
    });
  })()`;
}

function buildMarkerVisibleJs(commentText: string): string {
  return `(function(){${SUBMIT_HELPERS_JS}
    return JSON.stringify({ visible: fbText(document.body).indexOf(${jsString(commentText)}) >= 0 });
  })()`;
}

const SELECT_EDITOR_CONTENTS_JS = `(function(){${SUBMIT_HELPERS_JS}
  var el = fbActiveOrFirstEditor();
  if (!el) return JSON.stringify({ found:false, selected:false });
  try {
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return JSON.stringify({ found:true, selected:true });
  } catch(e) {
    return JSON.stringify({ found:true, selected:false });
  }
})()`;

interface FocusResult {
  found: boolean;
  focused: boolean;
  permissionGated: boolean;
}

interface SubmitReadinessResult {
  found: boolean;
  markerAccepted: boolean;
  submitControlObserved: boolean;
  submitControlLabel: string | null;
  submitControlDisabled: boolean;
  x: number | null;
  y: number | null;
}

interface MarkerVisibleResult {
  visible: boolean;
}

async function clearActiveEditorBestEffort(cdp: BrowseCdp): Promise<void> {
  try {
    await evalJson<{ found: boolean; selected: boolean }>(cdp, SELECT_EDITOR_CONTENTS_JS);
    await dispatchKey(cdp, 'Backspace', 'Backspace', 8);
  } catch {
    // Best effort cleanup before submit; failure is reported by the original probe reason.
  }
}

export async function facebookGatedSubmitPreflight(
  cdp: BrowseCdp,
  options: FacebookGatedSubmitPreflightOptions = {},
): Promise<FacebookGatedSubmitPreflightResult> {
  if (!options.enabled) return { ok: false, reason: 'disabled' };
  if (!options.disposableAccountConfirmed) return { ok: false, reason: 'not_disposable' };
  if (!options.targetUrl) return { ok: false, reason: 'missing_target_url' };
  if (!isFacebookUrl(options.targetUrl)) return { ok: false, reason: 'target_not_facebook', targetUrl: options.targetUrl };

  const currentUrl = options.currentUrl ?? options.targetUrl;
  if (!isFacebookUrl(currentUrl)) return { ok: false, reason: 'current_not_facebook', targetUrl: options.targetUrl, currentUrl };
  if (normalizeTarget(currentUrl) !== normalizeTarget(options.targetUrl)) {
    return { ok: false, reason: 'target_mismatch', targetUrl: options.targetUrl, currentUrl };
  }

  // 先清 cookie 同意浮层（良性合规横幅）：clear 后原动作照常；清不掉则诚实 blocked_by_consent，绝不假成功。
  const acceptConsent = options.acceptConsent ?? defaultFacebookConsentAccepter();
  const consent = await acceptConsent(cdp);
  if (consent.handled && !consent.cleared) {
    return { ok: false, reason: 'blocked_by_consent', targetUrl: options.targetUrl, currentUrl };
  }

  const classify = options.classifyOverlay ?? classifyFacebookOverlay;
  const overlay = await classify(cdp);
  if (overlay !== 'none') {
    return { ok: false, reason: overlayReason(overlay), overlay, targetUrl: options.targetUrl, currentUrl };
  }
  return { ok: true, targetUrl: options.targetUrl, currentUrl, overlay: 'none' };
}

export async function runFacebookGatedSubmitProbe(
  cdp: BrowseCdp,
  options: FacebookGatedSubmitProbeOptions = {},
): Promise<FacebookGatedSubmitProbeResult> {
  const preflight = await facebookGatedSubmitPreflight(cdp, options);
  const base: FacebookGatedSubmitProbeResult = {
    ok: false,
    submitted: false,
    serverConfirmed: false,
    preflight,
    editorFound: false,
    focused: false,
    permissionGated: false,
    markerAccepted: false,
    submitControlObserved: false,
    submitControlLabel: null,
    optimisticVisible: false,
    reloadedVisible: false,
  };
  if (!preflight.ok) return { ...base, reason: preflight.reason };

  const commentText = options.commentText?.trim();
  if (!commentText) return { ...base, reason: 'missing_comment_text' };
  const hashed = markerHash(commentText);
  const sleep = options.sleep ?? defaultSleep;

  const focus = await evalJson<FocusResult>(cdp, buildFocusEditorJs(Boolean(options.allowGroupQuestionEditor)));
  const focusedResult = {
    ...base,
    markerHash: hashed,
    editorFound: focus.found,
    focused: focus.focused,
    permissionGated: focus.permissionGated,
  };
  if (!focus.found) return { ...focusedResult, reason: 'editor_not_found' };
  if (focus.permissionGated) return { ...focusedResult, reason: 'permission_gated' };
  if (!focus.focused) return { ...focusedResult, reason: 'focus_failed' };

  await insertText(cdp, commentText);
  const readiness = await evalJson<SubmitReadinessResult>(cdp, buildSubmitReadinessJs(commentText));
  const readyResult = {
    ...focusedResult,
    markerAccepted: readiness.markerAccepted,
    submitControlObserved: readiness.submitControlObserved,
    submitControlLabel: readiness.submitControlLabel,
  };
  if (!readiness.found) {
    await clearActiveEditorBestEffort(cdp);
    return { ...readyResult, reason: 'editor_not_found' };
  }
  if (!readiness.markerAccepted) {
    await clearActiveEditorBestEffort(cdp);
    return { ...readyResult, reason: 'marker_not_accepted' };
  }
  if (!readiness.submitControlObserved || readiness.x === null || readiness.y === null) {
    await clearActiveEditorBestEffort(cdp);
    return { ...readyResult, reason: 'submit_control_not_found' };
  }
  if (readiness.submitControlDisabled) {
    await clearActiveEditorBestEffort(cdp);
    return { ...readyResult, reason: 'submit_control_disabled' };
  }

  await dispatchClick(cdp, readiness.x, readiness.y);
  await sleep(options.waitAfterSubmitMs ?? 4_000);
  const optimistic = await evalJson<MarkerVisibleResult>(cdp, buildMarkerVisibleJs(commentText));

  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(options.waitAfterReloadMs ?? 5_000);
  const reloaded = await evalJson<MarkerVisibleResult>(cdp, buildMarkerVisibleJs(commentText));
  const submittedResult = {
    ...readyResult,
    submitted: true,
    optimisticVisible: optimistic.visible,
    reloadedVisible: reloaded.visible,
    serverConfirmed: reloaded.visible,
  };
  if (!reloaded.visible) return { ...submittedResult, reason: 'not_confirmed_after_reload' };
  return { ...submittedResult, ok: true };
}
