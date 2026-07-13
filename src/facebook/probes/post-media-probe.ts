import { dispatchClick, evalJson, type BrowseCdp } from '../../browse/cdp-util.js';
import type { ImageUploader } from '../../flows/image-uploader.js';

export interface FacebookPostMediaProbeOptions {
  imageUrl: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FacebookPostMediaProbeResult {
  ok: boolean;
  reason?: string;
  submitted: false;
  attachmentObserved: boolean;
  removalControlFound: boolean;
  removed: boolean;
}

interface RemoveControl {
  found: boolean;
  x: number | null;
  y: number | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 400;

const POST_MEDIA_HELPERS_JS = String.raw`
function fbMediaVisible(el){
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  var s = window.getComputedStyle ? getComputedStyle(el) : null;
  return r.width > 0 && r.height > 0 &&
    (!s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.01)) &&
    r.right > 0 && r.bottom > 0 && r.left < (window.innerWidth || 0) && r.top < (window.innerHeight || 0);
}
function fbMediaLabel(el){
  return String((el && (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
}
function fbMediaDialog(){
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(fbMediaVisible);
  return dialogs[0] || null;
}
function fbMediaRemoveControl(){
  var root = fbMediaDialog() || document;
  var nodes = Array.from(root.querySelectorAll('button,[role="button"],div[aria-label],span[aria-label]')).filter(fbMediaVisible);
  var re = /(?:remove|delete|移除|删除|刪除).{0,16}(?:photo|image|attachment|照片|图片|圖片|附件)|(?:photo|image|attachment|照片|图片|圖片|附件).{0,16}(?:remove|delete|移除|删除|刪除)/i;
  for (var i = nodes.length - 1; i >= 0; i--) {
    var el = nodes[i];
    if (!re.test(fbMediaLabel(el))) continue;
    var r = el.getBoundingClientRect();
    return { found:true, x:Math.round(r.left + r.width / 2), y:Math.round(r.top + r.height / 2) };
  }
  return { found:false, x:null, y:null };
}
`;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeControl(cdp: BrowseCdp): Promise<RemoveControl> {
  return evalJson<RemoveControl>(
    cdp,
    `(function(){${POST_MEDIA_HELPERS_JS} return JSON.stringify(fbMediaRemoveControl()); })()`,
  );
}

export async function probeFacebookPostMediaReadOnly(
  cdp: BrowseCdp,
  uploader: ImageUploader,
  options: FacebookPostMediaProbeOptions,
): Promise<FacebookPostMediaProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const result: FacebookPostMediaProbeResult = {
    ok: false,
    submitted: false,
    attachmentObserved: false,
    removalControlFound: false,
    removed: false,
  };

  const uploaded = await uploader.upload(options.imageUrl);
  if (!uploaded.ok) return { ...result, reason: uploaded.error ?? 'image_upload_failed' };
  result.attachmentObserved = true;

  let target: RemoveControl;
  try {
    target = await removeControl(cdp);
  } catch {
    return { ...result, reason: 'removal_control_not_found' };
  }
  result.removalControlFound = target.found;
  if (!target.found || typeof target.x !== 'number' || typeof target.y !== 'number') {
    return { ...result, reason: 'removal_control_not_found' };
  }

  await dispatchClick(cdp, target.x, target.y, { overshoot: false, jitter: 0 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let remaining: RemoveControl;
    try {
      remaining = await removeControl(cdp);
    } catch {
      remaining = { found: true, x: null, y: null };
    }
    if (!remaining.found) return { ...result, ok: true, removed: true };
    if (Date.now() >= deadline) return { ...result, reason: 'removal_not_confirmed' };
    await sleep(pollMs);
  }
}
