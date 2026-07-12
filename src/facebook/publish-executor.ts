import { dispatchClick, evalJson, evalRaw, insertText, type BrowseCdp } from '../browse/cdp-util.js';
import type { ImageUploader } from '../flows/image-uploader.js';
import type { PublishCommandPayload, PublishCommandResultPayload } from '../comm/protocol.js';

export interface FacebookPublishExecutorOptions {
  settleMs?: number;
  pollMs?: number;
  composerTimeoutMs?: number;
  submitVerifyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FacebookPublishExecutorDeps {
  cdp: BrowseCdp;
  uploader?: ImageUploader;
  logger?: (message: string) => void;
}

const FACEBOOK_HOME_URL = 'https://www.facebook.com/';

const DEFAULTS: Required<FacebookPublishExecutorOptions> = {
  settleMs: 2_000,
  pollMs: 400,
  composerTimeoutMs: 20_000,
  submitVerifyTimeoutMs: 20_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const FB_PUBLISH_HELPERS_JS = String.raw`
function fbPublishVisible(el){
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  var s = window.getComputedStyle ? getComputedStyle(el) : null;
  return r.width > 0 && r.height > 0 &&
    (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01)) &&
    r.right > 0 && r.bottom > 0 && r.left < (window.innerWidth || 0) && r.top < (window.innerHeight || 0);
}
function fbPublishText(el){
  return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
}
function fbPublishLabel(el){
  return String((el && (el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || el.getAttribute('title'))) || '').replace(/\s+/g, ' ').trim();
}
function fbPublishNorm(value){ return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function fbPublishDialog(){
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(fbPublishVisible);
  return dialogs[0] || null;
}
function fbPublishComposerTrigger(){
  var nodes = Array.from(document.querySelectorAll('button,[role="button"],div[aria-label],span[aria-label],a[role="link"]')).filter(fbPublishVisible);
  var re = /(what('|’)s on your mind|create post|create a post|write something|写点什么|在想什么|发帖|帖子|bạn đang nghĩ gì|crear publicación|crear una publicación|post something)/i;
  var scored = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var label = fbPublishLabel(el);
    var text = fbPublishText(el);
    var hay = label + ' ' + text;
    if (!re.test(hay)) continue;
    if (/comment|评论|reply|回复/i.test(hay)) continue;
    scored.push({ el: el, score: (label ? 0 : 4) + Math.min(text.length, 120) });
  }
  scored.sort(function(a,b){ return a.score - b.score; });
  return scored.length ? scored[0].el : null;
}
function fbPublishEditor(){
  var root = fbPublishDialog() || document;
  var editors = Array.from(root.querySelectorAll('[contenteditable="true"][role="textbox"],[contenteditable="true"]')).filter(fbPublishVisible);
  var re = /(what('|’)s on your mind|create a public post|write something|写点什么|在想什么|bạn đang nghĩ gì|qué estás pensando|publicación)/i;
  var exact = editors.find(function(el){
    var hay = fbPublishLabel(el) + ' ' + fbPublishText(el);
    return re.test(hay) && !/comment|评论|reply|回复/i.test(hay);
  });
  return exact || editors[0] || null;
}
function fbPublishFileInput(){
  var root = fbPublishDialog() || document;
  var inputs = Array.from(root.querySelectorAll('input[type="file"]'));
  var imageInput = inputs.find(function(input){
    return /image|jpg|jpeg|png|webp|gif/i.test(input.getAttribute('accept') || '');
  });
  return imageInput || inputs[0] || null;
}
function fbPublishHasImageAttachment(){
  var root = fbPublishDialog() || document;
  if (Array.from(root.querySelectorAll('img[src], video')).some(function(el){ return fbPublishVisible(el); })) return true;
  var body = fbPublishText(root);
  return /(remove photo|移除照片|删除照片|photo attached|已添加照片|ảnh)/i.test(body);
}
function fbPublishSubmitControl(){
  var root = fbPublishDialog() || document;
  var nodes = Array.from(root.querySelectorAll('button,[role="button"],div[aria-label],span[aria-label]')).filter(fbPublishVisible);
  var exact = /^(post|发布|發佈|đăng|publicar|compartir)$/i;
  for (var i = nodes.length - 1; i >= 0; i--) {
    var el = nodes[i];
    var label = fbPublishLabel(el) || fbPublishText(el);
    var clean = label.replace(/\s+/g, ' ').trim();
    if (!exact.test(clean)) continue;
    var disabled = el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null ||
      /disabled/i.test(String(el.className || ''));
    var r = el.getBoundingClientRect();
    return { found: true, disabled: disabled, label: clean.slice(0, 40), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  return { found: false, disabled: false, label: null, x: null, y: null };
}
function fbPublishSubmittedSignal(){
  var dialog = fbPublishDialog();
  if (!dialog) return true;
  var text = fbPublishText(document.body);
  return /(your post is being processed|your post has been shared|post shared|已发布|发布中|發佈中|đã đăng|publicación compartida)/i.test(text);
}
function fbPublishExtractPost(){
  var links = Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; });
  var hit = links.find(function(h){ return /\/posts\/|story_fbid=|\/permalink\//i.test(h); }) || location.href;
  var id = '';
  try {
    var u = new URL(hit, location.href);
    var sf = u.searchParams.get('story_fbid');
    if (sf) id = sf;
    if (!id) {
      var parts = u.pathname.split('/').filter(Boolean);
      var idx = parts.indexOf('posts');
      if (idx >= 0 && parts[idx + 1]) id = parts[idx + 1];
      var pidx = parts.indexOf('permalink');
      if (!id && pidx >= 0 && parts[pidx + 1]) id = parts[pidx + 1];
    }
  } catch(e) {}
  return { postId: id || '', postUrl: hit || '' };
}
`;

function base(payload: PublishCommandPayload): Pick<PublishCommandResultPayload, 'recordId' | 'seq' | 'kind'> {
  return { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
}

function valueSnippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 20);
}

export class FacebookPublishExecutor {
  private readonly cdp: BrowseCdp;
  private readonly uploader?: ImageUploader;
  private readonly opts: Required<FacebookPublishExecutorOptions>;
  private readonly log: (message: string) => void;

  constructor(deps: FacebookPublishExecutorDeps, options: FacebookPublishExecutorOptions = {}) {
    this.cdp = deps.cdp;
    this.uploader = deps.uploader;
    this.opts = { ...DEFAULTS, ...options };
    this.log = deps.logger ?? (() => {});
  }

  async dispatch(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    switch (payload.kind) {
      case 'navigate_entry':
        return this.navigate(payload);
      case 'select_mode':
        return this.openComposer(payload);
      case 'upload_image':
        return this.uploadImage(payload);
      case 'fill_field':
        return this.fillContent(payload);
      case 'submit_publish':
        return this.submit(payload);
      case 'capture_postId':
        return this.capturePostId(payload);
      default:
        return { ...base(payload), ok: false, error: 'kind_not_implemented' };
    }
  }

  private async waitUntil<T>(
    timeoutMs: number,
    fn: () => Promise<T | null | undefined | false>,
  ): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await this.opts.sleep(this.opts.pollMs);
    }
  }

  private async navigate(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    try {
      await this.cdp.send('Page.navigate', { url: FACEBOOK_HOME_URL });
      await this.opts.sleep(this.opts.settleMs);
      const ok = await evalRaw<boolean>(
        this.cdp,
        `(() => /(^|\\.)facebook\\.com$|(^|\\.)facebookcorewwwi\\.onion$/.test(location.hostname))()`,
      );
      return ok ? { ...base(payload), ok: true } : { ...base(payload), ok: false, error: 'not_facebook' };
    } catch (err) {
      return { ...base(payload), ok: false, error: `nav_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async openComposer(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    if (payload.params.value && payload.params.value !== 'facebook_personal_timeline') {
      return { ...base(payload), ok: false, error: 'unsupported_target' };
    }
    try {
      const readyBefore = await this.editorReady();
      if (!readyBefore) {
        const clicked = await evalRaw<boolean>(
          this.cdp,
          `(function(){${FB_PUBLISH_HELPERS_JS} var el = fbPublishComposerTrigger(); if (!el) return false; try { el.scrollIntoView({ block:'center' }); } catch(e) {} try { el.click(); } catch(e) { return false; } return true; })()`,
        );
        if (!clicked) return { ...base(payload), ok: false, error: 'no_target' };
      }
      const ready = await this.waitUntil(this.opts.composerTimeoutMs, () => this.editorReady());
      return ready ? { ...base(payload), ok: true } : { ...base(payload), ok: false, error: 'post_validate_failed' };
    } catch (err) {
      return { ...base(payload), ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async editorReady(): Promise<boolean> {
    return evalRaw<boolean>(
      this.cdp,
      `(function(){${FB_PUBLISH_HELPERS_JS} return !!fbPublishEditor(); })()`,
    ).catch(() => false);
  }

  private async uploadImage(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    const imageUrl = payload.params.imageUrl;
    if (!this.uploader) return { ...base(payload), ok: false, error: 'kind_not_implemented' };
    if (!imageUrl) return { ...base(payload), ok: false, error: 'no_target' };
    const result = await this.uploader.upload(imageUrl);
    if (!result.ok) return { ...base(payload), ok: false, error: result.error ?? 'upload_failed' };
    return { ...base(payload), ok: true };
  }

  private async fillContent(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    if (payload.params.fieldType && payload.params.fieldType !== 'content') {
      this.log(`[facebook-publish] ignore unsupported fieldType=${payload.params.fieldType}`);
      return { ...base(payload), ok: true };
    }
    const value = payload.params.value ?? '';
    const probe = valueSnippet(value);
    if (!value.trim()) return { ...base(payload), ok: false, error: 'empty_content' };
    try {
      const focused = await evalRaw<boolean>(
        this.cdp,
        `(function(){${FB_PUBLISH_HELPERS_JS} var el = fbPublishEditor(); if (!el) return false; try { el.scrollIntoView({ block:'center' }); } catch(e) {} try { el.focus(); el.click && el.click(); } catch(e) {} return document.activeElement === el || true; })()`,
      );
      if (!focused) return { ...base(payload), ok: false, error: 'no_target' };
      await insertText(this.cdp, value);
      if (!probe) return { ...base(payload), ok: true };
      const accepted = await this.waitUntil(5_000, async () =>
        evalRaw<boolean>(
          this.cdp,
          `(function(){${FB_PUBLISH_HELPERS_JS} var el = fbPublishEditor(); return !!el && fbPublishText(el).indexOf(${JSON.stringify(probe)}) >= 0; })()`,
        ).catch(() => false),
      );
      return accepted ? { ...base(payload), ok: true } : { ...base(payload), ok: false, error: 'marker_not_accepted' };
    } catch (err) {
      return { ...base(payload), ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async submit(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    try {
      const target = await evalJson<{ found: boolean; disabled: boolean; label: string | null; x: number | null; y: number | null }>(
        this.cdp,
        `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify(fbPublishSubmitControl()); })()`,
      );
      if (!target.found || typeof target.x !== 'number' || typeof target.y !== 'number') {
        return { ...base(payload), ok: false, error: 'no_target' };
      }
      if (target.disabled) return { ...base(payload), ok: false, error: 'submit_control_disabled' };
      await dispatchClick(this.cdp, target.x, target.y, { overshoot: false, jitter: 0 });
      const submitted = await this.waitUntil(this.opts.submitVerifyTimeoutMs, () =>
        evalRaw<boolean>(
          this.cdp,
          `(function(){${FB_PUBLISH_HELPERS_JS} return fbPublishSubmittedSignal(); })()`,
        ).catch(() => false),
      );
      return submitted ? { ...base(payload), ok: true } : { ...base(payload), ok: false, error: 'post_validate_failed' };
    } catch (err) {
      return { ...base(payload), ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async capturePostId(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    try {
      const found = await evalJson<{ postId: string; postUrl: string }>(
        this.cdp,
        `(function(){${FB_PUBLISH_HELPERS_JS} return JSON.stringify(fbPublishExtractPost()); })()`,
      );
      if (!found.postId) return { ...base(payload), ok: false, error: 'no_target' };
      return {
        ...base(payload),
        ok: true,
        value: found.postId,
        ...(found.postUrl ? { postUrl: found.postUrl } : {}),
      };
    } catch (err) {
      return { ...base(payload), ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
