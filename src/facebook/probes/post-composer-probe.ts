import { createHash } from 'node:crypto';
import {
  dispatchClick,
  dispatchKey,
  evalJson,
  insertText,
  type BrowseCdp,
} from '../../browse/cdp-util.js';

export interface FacebookPostComposerProbeOptions {
  marker?: string;
  composerTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FacebookPostComposerProbeResult {
  ok: boolean;
  reason?: string;
  submitted: false;
  markerHash: string;
  triggerFound: boolean;
  composerOpened: boolean;
  editorFound: boolean;
  focused: boolean;
  markerAccepted: boolean;
  submitControlObserved: boolean;
  submitControlLabel: string | null;
  submitControlDisabled: boolean;
  cleared: boolean;
  finalTextLength: number | null;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_MS = 400;

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markerHash(marker: string): string {
  return createHash('sha256').update(marker).digest('hex').slice(0, 16);
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

const POST_COMPOSER_HELPERS_JS = String.raw`
function fbPostVisible(el){
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  var s = window.getComputedStyle ? getComputedStyle(el) : null;
  return r.width > 0 && r.height > 0 &&
    (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01)) &&
    r.right > 0 && r.bottom > 0 && r.left < (window.innerWidth || 0) && r.top < (window.innerHeight || 0);
}
function fbPostText(el){ return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim(); }
function fbPostLabel(el){ return String((el && (el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || el.getAttribute('title'))) || '').replace(/\s+/g, ' ').trim(); }
function fbPostCenter(el){
  var r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}
function fbPostDialog(){
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(fbPostVisible);
  return dialogs[0] || null;
}
function fbPostTrigger(){
  var nodes = Array.from(document.querySelectorAll('button,[role="button"],div[aria-label],span[aria-label],a[role="link"]')).filter(fbPostVisible);
  var re = /(what('|’)s on your mind|create post|create a post|write something|写点什么|在想什么|发帖|帖子|bạn đang nghĩ gì|crear publicación|crear una publicación|post something)/i;
  var scored = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var label = fbPostLabel(el);
    var text = fbPostText(el);
    var hay = label + ' ' + text;
    if (!re.test(hay)) continue;
    if (/comment|评论|reply|回复/i.test(hay)) continue;
    scored.push({ el: el, score: (label ? 0 : 4) + Math.min(text.length, 120) });
  }
  scored.sort(function(a,b){ return a.score - b.score; });
  return scored.length ? scored[0].el : null;
}
function fbPostEditor(){
  var root = fbPostDialog() || document;
  var editors = Array.from(root.querySelectorAll('[contenteditable="true"][role="textbox"],[contenteditable="true"]')).filter(fbPostVisible);
  var re = /(what('|’)s on your mind|create a public post|write something|写点什么|在想什么|bạn đang nghĩ gì|qué estás pensando|publicación)/i;
  var exact = editors.find(function(el){
    var hay = fbPostLabel(el) + ' ' + fbPostText(el);
    return re.test(hay) && !/comment|评论|reply|回复/i.test(hay);
  });
  return exact || editors[0] || null;
}
function fbPostSubmitControl(){
  var root = fbPostDialog() || document;
  var nodes = Array.from(root.querySelectorAll('button,[role="button"],div[aria-label],span[aria-label]')).filter(fbPostVisible);
  var exact = /^(post|发布|發佈|đăng|publicar|compartir)$/i;
  for (var i = nodes.length - 1; i >= 0; i--) {
    var el = nodes[i];
    var label = (fbPostLabel(el) || fbPostText(el)).replace(/\s+/g, ' ').trim();
    if (!exact.test(label)) continue;
    var disabled = el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null ||
      /disabled/i.test(String(el.className || ''));
    return { observed: true, label: label.slice(0, 40), disabled: disabled };
  }
  return { observed: false, label: null, disabled: false };
}
function fbPostSelectEditorContents(el){
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

interface PointResult {
  found: boolean;
  x: number | null;
  y: number | null;
  label: string | null;
}

interface StateResult {
  editorFound: boolean;
  textLength: number | null;
  markerAccepted: boolean;
  submitControlObserved: boolean;
  submitControlLabel: string | null;
  submitControlDisabled: boolean;
}

interface SelectResult {
  found: boolean;
  selected: boolean;
}

function baseResult(marker: string): FacebookPostComposerProbeResult {
  return {
    ok: false,
    submitted: false,
    markerHash: markerHash(marker),
    triggerFound: false,
    composerOpened: false,
    editorFound: false,
    focused: false,
    markerAccepted: false,
    submitControlObserved: false,
    submitControlLabel: null,
    submitControlDisabled: false,
    cleared: false,
    finalTextLength: null,
  };
}

async function waitUntil<T>(
  timeoutMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
  fn: () => Promise<T | false | null | undefined>,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

async function triggerPoint(cdp: BrowseCdp): Promise<PointResult> {
  return evalJson<PointResult>(
    cdp,
    `(function(){${POST_COMPOSER_HELPERS_JS} var el = fbPostTrigger(); if (!el) return JSON.stringify({ found:false, x:null, y:null, label:null }); var p = fbPostCenter(el); return JSON.stringify({ found:true, x:p.x, y:p.y, label:(fbPostLabel(el)||fbPostText(el)).slice(0,80) }); })()`,
  );
}

async function editorPoint(cdp: BrowseCdp): Promise<PointResult> {
  return evalJson<PointResult>(
    cdp,
    `(function(){${POST_COMPOSER_HELPERS_JS} var el = fbPostEditor(); if (!el) return JSON.stringify({ found:false, x:null, y:null, label:null }); try { el.scrollIntoView({ block:'center' }); } catch(e) {} var p = fbPostCenter(el); return JSON.stringify({ found:true, x:p.x, y:p.y, label:(fbPostLabel(el)||fbPostText(el)).slice(0,80) }); })()`,
  );
}

async function readState(cdp: BrowseCdp, marker: string): Promise<StateResult> {
  return evalJson<StateResult>(
    cdp,
    `(function(){${POST_COMPOSER_HELPERS_JS} var el = fbPostEditor(); var submit = fbPostSubmitControl(); if (!el) return JSON.stringify({ editorFound:false, textLength:null, markerAccepted:false, submitControlObserved:submit.observed, submitControlLabel:submit.label, submitControlDisabled:submit.disabled }); var text = fbPostText(el); return JSON.stringify({ editorFound:true, textLength:text.length, markerAccepted:text.indexOf(${jsString(marker)}) >= 0, submitControlObserved:submit.observed, submitControlLabel:submit.label, submitControlDisabled:submit.disabled }); })()`,
  );
}

async function selectEditorContents(cdp: BrowseCdp): Promise<SelectResult> {
  return evalJson<SelectResult>(
    cdp,
    `(function(){${POST_COMPOSER_HELPERS_JS} var el = fbPostEditor(); if (!el) return JSON.stringify({ found:false, selected:false }); try { el.focus(); } catch(e) {} return JSON.stringify({ found:true, selected:fbPostSelectEditorContents(el) }); })()`,
  );
}

export async function probeFacebookPostComposerReadOnly(
  cdp: BrowseCdp,
  options: FacebookPostComposerProbeOptions = {},
): Promise<FacebookPostComposerProbeResult> {
  const marker = options.marker ?? `aidcp-fb-post-probe-${Date.now()}`;
  const result = baseResult(marker);
  const timeoutMs = options.composerTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? sleepDefault;

  let state = await readState(cdp, marker);
  result.editorFound = state.editorFound;
  result.composerOpened = state.editorFound;

  if (!state.editorFound) {
    const trigger = await triggerPoint(cdp);
    result.triggerFound = trigger.found;
    if (!trigger.found || typeof trigger.x !== 'number' || typeof trigger.y !== 'number') {
      return { ...result, reason: 'trigger_not_found' };
    }
    await dispatchClick(cdp, trigger.x, trigger.y, { overshoot: false, jitter: 0, sleep });
    const opened = await waitUntil(timeoutMs, pollMs, sleep, () => readState(cdp, marker).then((s) => s.editorFound ? s : null));
    if (!opened) return { ...result, reason: 'editor_not_found' };
    state = opened;
    result.editorFound = true;
    result.composerOpened = true;
  }

  result.submitControlObserved = state.submitControlObserved;
  result.submitControlLabel = state.submitControlLabel;
  result.submitControlDisabled = state.submitControlDisabled;

  const editor = await editorPoint(cdp);
  if (!editor.found || typeof editor.x !== 'number' || typeof editor.y !== 'number') {
    return { ...result, reason: 'editor_not_found' };
  }
  await dispatchClick(cdp, editor.x, editor.y, { overshoot: false, jitter: 0, sleep });
  result.focused = true;

  await insertText(cdp, marker);
  const typed = await waitUntil(5_000, pollMs, sleep, () => readState(cdp, marker).then((s) => s.markerAccepted ? s : null));
  if (!typed) return { ...result, reason: 'marker_not_accepted' };
  result.markerAccepted = true;
  result.submitControlObserved = typed.submitControlObserved;
  result.submitControlLabel = typed.submitControlLabel;
  result.submitControlDisabled = typed.submitControlDisabled;

  const selected = await selectEditorContents(cdp);
  if (!selected.found || !selected.selected) return { ...result, reason: 'select_failed' };
  await dispatchKey(cdp, 'Backspace', 'Backspace', 8);
  const cleared = await waitUntil(5_000, pollMs, sleep, async () => {
    const next = await readState(cdp, marker);
    return next.editorFound && next.textLength === 0 ? next : null;
  });
  if (!cleared) {
    const final = await readState(cdp, marker);
    result.finalTextLength = final.textLength;
    return { ...result, reason: 'clear_failed' };
  }

  result.cleared = true;
  result.finalTextLength = cleared.textLength;
  result.ok = result.markerAccepted && result.cleared && result.submitControlObserved;
  if (!result.submitControlObserved) result.reason = 'submit_control_not_observed';
  return result;
}
