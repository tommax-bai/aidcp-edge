import { CdpFileInputSetter, type FileInputSetter } from '../../cdp/file-input-setter.js';
import { evalJson, type BrowseCdp } from '../../browse/cdp-util.js';

export type TikTokUploadBlockReason =
  | 'none'
  | 'not_tiktok'
  | 'login_required'
  | 'challenge'
  | 'access_restricted';

export interface TikTokUploadEntrySnapshot {
  status: 'ready' | 'not_found' | 'ambiguous' | 'blocked';
  blockReason: TikTokUploadBlockReason;
  href?: string;
  candidateCount: number;
}

export interface TikTokComposerFieldEvidence {
  tag: string;
  type: string;
  role: string;
  name: string;
  contenteditable: string;
  placeholder: string;
  ariaLabel: string;
  dataE2e: string;
}

export interface TikTokUploadPageSnapshot {
  host: string;
  path: string;
  blockReason: TikTokUploadBlockReason;
  fileInputCount: number;
  fileInputAccept: string | null;
  fileInputMultiple: boolean;
  fileInputDisabled: boolean;
  fileInputFilesCount: number;
  caption: {
    found: boolean;
    ambiguous: boolean;
    textLength: number | null;
    evidence: TikTokComposerFieldEvidence | null;
  };
  fieldKinds: TikTokComposerFieldEvidence[];
  previewCount: number;
  progressCount: number;
  blockingOverlayVisible: boolean;
  uploadErrorVisible: boolean;
  uploadAcknowledged: boolean;
  composerReady: boolean;
}

export interface TikTokStageFileResult {
  status: 'upload_acknowledged' | 'blocked' | 'ambiguous' | 'input_not_found' | 'set_file_failed' | 'upload_unconfirmed';
  executed: boolean;
  fileSelected: boolean;
  uploadAcknowledged: boolean;
  composerReady: boolean;
  submitted: false;
  reason?: string;
  snapshot: TikTokUploadPageSnapshot;
}

export interface TikTokCaptionDraftResult {
  status: 'composer_ready_not_submitted' | 'invalid_text' | 'blocked' | 'composer_not_ready' | 'editor_not_found' | 'ambiguous' | 'focus_failed' | 'fill_unconfirmed';
  executed: boolean;
  textLength: number;
  matched: boolean;
  submitted: false;
  reason?: string;
}

export interface TikTokPublishComposerProbeOptions {
  fileInputSetter?: FileInputSetter;
  uploadTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 1_000;

export const TIKTOK_UNIQUE_VIDEO_INPUT_JS = String.raw`(() => {
  const nodes = Array.from(document.querySelectorAll('input[type="file"]'))
    .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true')
    .filter((el) => !el.accept || /video/i.test(el.accept));
  return nodes.length === 1 ? nodes[0] : null;
})()`;

export const TIKTOK_UPLOAD_ENTRY_JS = String.raw`(() => {/*aidcp:tiktok-upload-entry*/
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    var s = window.getComputedStyle ? getComputedStyle(el) : null;
    return r.width > 0 && r.height > 0 && (!s || (s.display !== 'none' && s.visibility !== 'hidden'));
  }
  function blockReason() {
    var host = String(location.hostname || '').toLowerCase();
    var path = String(location.pathname || '').toLowerCase();
    if (!(host === 'tiktok.com' || host.endsWith('.tiktok.com'))) return 'not_tiktok';
    if (/captcha|challenge|verify|verification/.test(path) || document.querySelector('iframe[src*="captcha"],iframe[src*="verify"],[data-e2e*="captcha"],[class*="captcha"]')) return 'challenge';
    if (/\/login|\/signup/.test(path) || Array.from(document.querySelectorAll('input[type="password"]')).some(visible)) return 'login_required';
    if (/restricted|unavailable|blocked/.test(path)) return 'access_restricted';
    return 'none';
  }
  var block = blockReason();
  if (block !== 'none') return JSON.stringify({ status: 'blocked', blockReason: block, candidateCount: 0 });
  var nodes = Array.from(document.querySelectorAll('a[data-e2e="nav-upload"],a[href*="/tiktokstudio/upload"]')).filter(visible);
  var byHref = new Map();
  nodes.forEach(function(el) {
    try {
      var url = new URL(String(el.href || ''), location.href);
      if (!(url.hostname === 'tiktok.com' || url.hostname.endsWith('.tiktok.com'))) return;
      if (!/^\/tiktokstudio\/upload\/?$/i.test(url.pathname)) return;
      byHref.set(url.href, url.href);
    } catch {}
  });
  var hrefs = Array.from(byHref.values());
  return JSON.stringify({
    status: hrefs.length === 1 ? 'ready' : hrefs.length === 0 ? 'not_found' : 'ambiguous',
    blockReason: 'none',
    href: hrefs.length === 1 ? hrefs[0] : undefined,
    candidateCount: hrefs.length,
  });
})()`;

export const TIKTOK_UPLOAD_PAGE_SNAPSHOT_JS = String.raw`(() => {/*aidcp:tiktok-upload-page*/
  function rendered(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    var s = window.getComputedStyle ? getComputedStyle(el) : null;
    return r.width > 0 && r.height > 0 && (!s || (s.display !== 'none' && s.visibility !== 'hidden'));
  }
  function normalizedText(el) {
    return String((el && ('value' in el ? el.value : el.textContent)) || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
  }
  function fieldEvidence(el) {
    return {
      tag: String(el.tagName || '').toLowerCase(),
      type: String(el.getAttribute('type') || ''),
      role: String(el.getAttribute('role') || ''),
      name: String(el.getAttribute('name') || ''),
      contenteditable: String(el.getAttribute('contenteditable') || ''),
      placeholder: String(el.getAttribute('placeholder') || ''),
      ariaLabel: String(el.getAttribute('aria-label') || ''),
      dataE2e: String(el.getAttribute('data-e2e') || ''),
    };
  }
  function blockReason() {
    var host = String(location.hostname || '').toLowerCase();
    var path = String(location.pathname || '').toLowerCase();
    if (!(host === 'tiktok.com' || host.endsWith('.tiktok.com'))) return 'not_tiktok';
    if (/captcha|challenge|verify|verification/.test(path) || document.querySelector('iframe[src*="captcha"],iframe[src*="verify"],[data-e2e*="captcha"],[class*="captcha"]')) return 'challenge';
    if (/\/login|\/signup/.test(path) || Array.from(document.querySelectorAll('input[type="password"]')).some(rendered)) return 'login_required';
    if (/restricted|unavailable|blocked/.test(path)) return 'access_restricted';
    return 'none';
  }
  var inputs = Array.from(document.querySelectorAll('input[type="file"]'))
    .filter(function(el) { return !el.disabled && el.getAttribute('aria-disabled') !== 'true'; })
    .filter(function(el) { return !el.accept || /video/i.test(el.accept); });
  var rawFields = Array.from(document.querySelectorAll('textarea,input[type="text"],[contenteditable="true"],[role="textbox"]'))
    .filter(rendered)
    .filter(function(el) { return !el.closest('tiktok-cookie-banner,[data-e2e*="comment"]'); });
  var fields = Array.from(new Set(rawFields));
  var semanticCaption = fields.filter(function(el) {
    var hay = [el.getAttribute('data-e2e'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name')].join(' ');
    return /caption|description|describe|mô tả|chú thích|描述|说明|標題|标题/i.test(hay);
  });
  var editableCaption = fields.filter(function(el) { return el.getAttribute('contenteditable') === 'true'; });
  var captionCandidates = semanticCaption.length ? semanticCaption : editableCaption.length === 1 ? editableCaption : fields.length === 1 ? fields : [];
  var caption = captionCandidates.length === 1 ? captionCandidates[0] : null;
  var previewNodes = Array.from(document.querySelectorAll('video,canvas,img[src^="blob:"]')).filter(rendered);
  var previewCount = previewNodes.length;
  var progressCount = Array.from(document.querySelectorAll('progress,[role="progressbar"]')).filter(rendered).length;
  var blockingOverlayVisible = Array.from(document.querySelectorAll('[role="alertdialog"],[role="dialog"][aria-modal="true"]')).some(rendered);
  var bodyText = String(document.body && document.body.innerText || '').slice(0, 12000);
  var uploadErrorVisible = /upload failed|couldn.t upload|failed to upload|tải lên thất bại|上传失败|上傳失敗/i.test(bodyText);
  var uploadAcknowledged = Boolean(caption) && previewCount > 0 && !uploadErrorVisible;
  var composerReady = uploadAcknowledged && progressCount === 0 && !blockingOverlayVisible;
  return JSON.stringify({
    host: String(location.hostname || ''),
    path: String(location.pathname || ''),
    blockReason: blockReason(),
    fileInputCount: inputs.length,
    fileInputAccept: inputs.length === 1 ? String(inputs[0].accept || '') : null,
    fileInputMultiple: inputs.length === 1 ? Boolean(inputs[0].multiple) : false,
    fileInputDisabled: inputs.length === 1 ? Boolean(inputs[0].disabled || inputs[0].getAttribute('aria-disabled') === 'true') : false,
    fileInputFilesCount: inputs.length === 1 ? Number(inputs[0].files && inputs[0].files.length || 0) : 0,
    caption: {
      found: Boolean(caption),
      ambiguous: semanticCaption.length > 1 || (semanticCaption.length === 0 && editableCaption.length > 1) || (semanticCaption.length === 0 && editableCaption.length === 0 && fields.length > 1),
      textLength: caption ? normalizedText(caption).length : null,
      evidence: caption ? fieldEvidence(caption) : null,
    },
    fieldKinds: fields.map(fieldEvidence).slice(0, 20),
    previewCount: previewCount,
    progressCount: progressCount,
    blockingOverlayVisible: blockingOverlayVisible,
    uploadErrorVisible: uploadErrorVisible,
    uploadAcknowledged: uploadAcknowledged,
    composerReady: composerReady,
  });
})()`;

const TIKTOK_CAPTION_FOCUS_JS = String.raw`(() => {/*aidcp:tiktok-caption-focus*/
  function rendered(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    var s = window.getComputedStyle ? getComputedStyle(el) : null;
    return r.width > 0 && r.height > 0 && (!s || (s.display !== 'none' && s.visibility !== 'hidden'));
  }
  var fields = Array.from(document.querySelectorAll('textarea,input[type="text"],[contenteditable="true"],[role="textbox"]'))
    .filter(rendered)
    .filter(function(el) { return !el.closest('tiktok-cookie-banner,[data-e2e*="comment"]'); });
  var semantic = fields.filter(function(el) {
    var hay = [el.getAttribute('data-e2e'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name')].join(' ');
    return /caption|description|describe|mô tả|chú thích|描述|说明|標題|标题/i.test(hay);
  });
  var editable = fields.filter(function(el) { return el.getAttribute('contenteditable') === 'true'; });
  var candidates = semantic.length ? semantic : editable.length === 1 ? editable : fields.length === 1 ? fields : [];
  if (candidates.length !== 1) return JSON.stringify({ ok: false, reason: candidates.length ? 'ambiguous' : 'editor_not_found' });
  var el = candidates[0];
  el.focus();
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    el.select();
  } else {
    var selection = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return JSON.stringify({ ok: document.activeElement === el || el.contains(document.activeElement) });
})()`;

function buildCaptionVerifyJs(expected: string): string {
  return String.raw`(() => {/*aidcp:tiktok-caption-verify*/
    function rendered(el) {
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle ? getComputedStyle(el) : null;
      return r.width > 0 && r.height > 0 && (!s || (s.display !== 'none' && s.visibility !== 'hidden'));
    }
    function text(el) { return String(('value' in el ? el.value : el.textContent) || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim(); }
    var fields = Array.from(document.querySelectorAll('textarea,input[type="text"],[contenteditable="true"],[role="textbox"]'))
      .filter(rendered)
      .filter(function(el) { return !el.closest('tiktok-cookie-banner,[data-e2e*="comment"]'); });
    var semantic = fields.filter(function(el) {
      var hay = [el.getAttribute('data-e2e'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name')].join(' ');
      return /caption|description|describe|mô tả|chú thích|描述|说明|標題|标题/i.test(hay);
    });
    var editable = fields.filter(function(el) { return el.getAttribute('contenteditable') === 'true'; });
    var candidates = semantic.length ? semantic : editable.length === 1 ? editable : fields.length === 1 ? fields : [];
    if (candidates.length !== 1) return JSON.stringify({ matches: false, textLength: 0, reason: candidates.length ? 'ambiguous' : 'editor_not_found' });
    var actual = text(candidates[0]);
    var expected = ${JSON.stringify(expected.replace(/\s+/g, ' ').trim())};
    return JSON.stringify({ matches: actual === expected, textLength: actual.length });
  })()`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TikTokPublishComposerProbe {
  private readonly fileInputSetter: FileInputSetter;
  private readonly uploadTimeoutMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cdp: BrowseCdp, options: TikTokPublishComposerProbeOptions = {}) {
    this.fileInputSetter = options.fileInputSetter ?? new CdpFileInputSetter(cdp, { inputSelector: TIKTOK_UNIQUE_VIDEO_INPUT_JS });
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  inspectUploadEntry(): Promise<TikTokUploadEntrySnapshot> {
    return evalJson<TikTokUploadEntrySnapshot>(this.cdp, TIKTOK_UPLOAD_ENTRY_JS);
  }

  inspectUploadPage(): Promise<TikTokUploadPageSnapshot> {
    return evalJson<TikTokUploadPageSnapshot>(this.cdp, TIKTOK_UPLOAD_PAGE_SNAPSHOT_JS);
  }

  async stageFile(absPath: string): Promise<TikTokStageFileResult> {
    let snapshot = await this.inspectUploadPage();
    const base = { submitted: false as const };
    if (snapshot.blockReason !== 'none') {
      return { ...base, status: 'blocked', executed: false, fileSelected: false, uploadAcknowledged: false, composerReady: false, reason: snapshot.blockReason, snapshot };
    }
    if (snapshot.fileInputCount !== 1) {
      return { ...base, status: snapshot.fileInputCount > 1 ? 'ambiguous' : 'input_not_found', executed: false, fileSelected: false, uploadAcknowledged: false, composerReady: false, reason: `video_file_input_count_${snapshot.fileInputCount}`, snapshot };
    }
    if (snapshot.fileInputDisabled || !/video/i.test(snapshot.fileInputAccept ?? '')) {
      return { ...base, status: 'input_not_found', executed: false, fileSelected: false, uploadAcknowledged: false, composerReady: false, reason: 'video_file_input_not_usable', snapshot };
    }

    const set = await this.fileInputSetter.setFiles([absPath]);
    if (!set.ok) {
      return { ...base, status: 'set_file_failed', executed: false, fileSelected: false, uploadAcknowledged: false, composerReady: false, reason: set.error, snapshot };
    }

    const deadline = Date.now() + this.uploadTimeoutMs;
    do {
      await this.sleep(this.pollMs);
      snapshot = await this.inspectUploadPage();
      if (snapshot.blockReason !== 'none') {
        return { ...base, status: 'blocked', executed: true, fileSelected: true, uploadAcknowledged: false, composerReady: false, reason: snapshot.blockReason, snapshot };
      }
      if (snapshot.uploadErrorVisible) break;
      if (snapshot.uploadAcknowledged) {
        return { ...base, status: 'upload_acknowledged', executed: true, fileSelected: true, uploadAcknowledged: true, composerReady: snapshot.composerReady, snapshot };
      }
    } while (Date.now() < deadline);

    return {
      ...base,
      status: 'upload_unconfirmed',
      executed: true,
      fileSelected: true,
      uploadAcknowledged: false,
      composerReady: false,
      reason: snapshot.uploadErrorVisible ? 'upload_error_visible' : 'composer_not_ready_before_timeout',
      snapshot,
    };
  }

  async fillCaptionDraft(text: string): Promise<TikTokCaptionDraftResult> {
    const inputText = text.replace(/\s+/g, ' ').trim();
    const base = { submitted: false as const, textLength: inputText.length, matched: false };
    if (!inputText || inputText.length > 500 || /[\r\n]/.test(text)) {
      return { ...base, status: 'invalid_text', executed: false, reason: 'caption_probe_requires_single_line_1_to_500_chars' };
    }
    const snapshot = await this.inspectUploadPage();
    if (snapshot.blockReason !== 'none') return { ...base, status: 'blocked', executed: false, reason: snapshot.blockReason };
    if (!snapshot.composerReady || !snapshot.uploadAcknowledged) return { ...base, status: 'composer_not_ready', executed: false, reason: 'upload_not_acknowledged' };
    if (snapshot.caption.ambiguous) return { ...base, status: 'ambiguous', executed: false, reason: 'caption_editor_ambiguous' };
    if (!snapshot.caption.found) return { ...base, status: 'editor_not_found', executed: false };

    const focused = await evalJson<{ ok: boolean; reason?: string }>(this.cdp, TIKTOK_CAPTION_FOCUS_JS);
    if (!focused.ok) {
      const status = focused.reason === 'ambiguous' ? 'ambiguous' : focused.reason === 'editor_not_found' ? 'editor_not_found' : 'focus_failed';
      return { ...base, status, executed: false, reason: focused.reason };
    }
    await this.cdp.send('Input.insertText', { text: inputText });
    const verified = await evalJson<{ matches: boolean; textLength: number; reason?: string }>(this.cdp, buildCaptionVerifyJs(inputText));
    return {
      submitted: false,
      status: verified.matches ? 'composer_ready_not_submitted' : 'fill_unconfirmed',
      executed: true,
      textLength: verified.textLength,
      matched: verified.matches,
      reason: verified.reason,
    };
  }
}
