import { createHash } from 'node:crypto';
import {
  dispatchKey,
  evalRaw,
  insertText,
  type BrowseCdp,
} from '../../browse/cdp-util.js';

export interface FacebookEditorProbeOptions {
  marker?: string;
  allowGroupQuestionEditor?: boolean;
}

export interface FacebookEditorProbeResult {
  ok: boolean;
  reason?: string;
  submitted: false;
  markerHash: string;
  editorFound: boolean;
  focused: boolean;
  permissionGated: boolean;
  markerAccepted: boolean;
  submitControlObserved: boolean;
  submitControlLabel: string | null;
  cleared: boolean;
  finalTextLength: number | null;
}

function markerHash(marker: string): string {
  return createHash('sha256').update(marker).digest('hex').slice(0, 16);
}

function jsBool(value: boolean): string {
  return value ? 'true' : 'false';
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

const EDITOR_HELPERS_JS = String.raw`
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
function fbFindSubmitControl(){
  var nodes = Array.from(document.querySelectorAll('button,[role="button"],div[aria-label],span[aria-label]'));
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!fbVisible(el)) continue;
    var label = fbLabel(el) || fbText(el);
    if (/^(发布评论|Post|Comment|Reply|Send)$/i.test(label)) return { observed: true, label: label.slice(0, 40) };
  }
  return { observed: false, label: null };
}
function fbSelectEditorContents(el){
  try {
    var range = document.createRange();
    range.selectNodeContents(el);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch(e) {
    return false;
  }
}
`;

function buildFocusEditorJs(allowGroupQuestionEditor: boolean): string {
  return `(function(){${EDITOR_HELPERS_JS}
    var el = fbFindEditor();
    if (!el) return JSON.stringify({ found:false, focused:false, permissionGated:false, label:null, textLength:null });
    var permissionGated = (!${jsBool(allowGroupQuestionEditor)} && (fbIsGroupQuestionEditor(el) || fbJoinSignalVisible()));
    if (permissionGated) return JSON.stringify({ found:true, focused:false, permissionGated:true, label:fbLabel(el), textLength:fbText(el).length });
    try { el.scrollIntoView({ block:'center' }); } catch(e) {}
    try { el.focus(); } catch(e) {}
    return JSON.stringify({ found:true, focused:document.activeElement === el, permissionGated:false, label:fbLabel(el), textLength:fbText(el).length });
  })()`;
}

function buildVerifyTypedJs(marker: string): string {
  return `(function(){${EDITOR_HELPERS_JS}
    var el = fbActiveOrFirstEditor();
    if (!el) return JSON.stringify({ found:false, textLength:null, markerAccepted:false, submitControlObserved:false, submitControlLabel:null });
    var t = fbText(el);
    var submit = fbFindSubmitControl();
    return JSON.stringify({
      found:true,
      textLength:t.length,
      markerAccepted:t.indexOf(${jsString(marker)}) >= 0,
      submitControlObserved:submit.observed,
      submitControlLabel:submit.label
    });
  })()`;
}

const SELECT_EDITOR_CONTENTS_JS = `(function(){${EDITOR_HELPERS_JS}
  var el = fbActiveOrFirstEditor();
  if (!el) return JSON.stringify({ found:false, selected:false });
  el.focus();
  return JSON.stringify({ found:true, selected:fbSelectEditorContents(el) });
})()`;

const READ_ACTIVE_EDITOR_JS = `(function(){${EDITOR_HELPERS_JS}
  var el = fbActiveOrFirstEditor();
  if (!el) return JSON.stringify({ found:false, textLength:null });
  return JSON.stringify({ found:true, textLength:fbText(el).length });
})()`;

interface FocusResult {
  found: boolean;
  focused: boolean;
  permissionGated: boolean;
}

interface VerifyResult {
  found: boolean;
  markerAccepted: boolean;
  submitControlObserved: boolean;
  submitControlLabel: string | null;
}

interface ReadEditorResult {
  found: boolean;
  textLength: number | null;
}

async function evalJson<T>(cdp: BrowseCdp, expression: string): Promise<T> {
  return JSON.parse(await evalRaw<string>(cdp, expression)) as T;
}

function baseResult(marker: string): FacebookEditorProbeResult {
  return {
    ok: false,
    submitted: false,
    markerHash: markerHash(marker),
    editorFound: false,
    focused: false,
    permissionGated: false,
    markerAccepted: false,
    submitControlObserved: false,
    submitControlLabel: null,
    cleared: false,
    finalTextLength: null,
  };
}

export async function probeFacebookCommentEditorReadOnly(
  cdp: BrowseCdp,
  options: FacebookEditorProbeOptions = {},
): Promise<FacebookEditorProbeResult> {
  const marker = options.marker ?? `aidcp-fb-editor-probe-${Date.now()}`;
  const result = baseResult(marker);
  const focus = await evalJson<FocusResult>(cdp, buildFocusEditorJs(Boolean(options.allowGroupQuestionEditor)));
  result.editorFound = focus.found;
  result.focused = focus.focused;
  result.permissionGated = focus.permissionGated;
  if (!focus.found) return { ...result, reason: 'no_editor' };
  if (focus.permissionGated) return { ...result, reason: 'permission_gated' };
  if (!focus.focused) return { ...result, reason: 'focus_failed' };

  await insertText(cdp, marker);
  const typed = await evalJson<VerifyResult>(cdp, buildVerifyTypedJs(marker));
  result.markerAccepted = typed.markerAccepted;
  result.submitControlObserved = typed.submitControlObserved;
  result.submitControlLabel = typed.submitControlLabel;
  if (!typed.found) return { ...result, reason: 'editor_lost' };

  await evalJson<{ found: boolean; selected: boolean }>(cdp, SELECT_EDITOR_CONTENTS_JS);
  await dispatchKey(cdp, 'Backspace', 'Backspace', 8);
  const final = await evalJson<ReadEditorResult>(cdp, READ_ACTIVE_EDITOR_JS);
  result.finalTextLength = final.textLength;
  result.cleared = final.found && final.textLength === 0;
  result.ok = result.markerAccepted && result.submitControlObserved && result.cleared;
  if (!result.markerAccepted) result.reason = 'marker_not_accepted';
  else if (!result.submitControlObserved) result.reason = 'submit_control_not_observed';
  else if (!result.cleared) result.reason = 'clear_failed';
  return result;
}
