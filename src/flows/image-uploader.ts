/**
 * ImageUploader — 配图上传单一线性流程（publish-media-upload）。
 *
 * URL 校验 → 下载到边缘本机临时文件（注入 fetchImpl、redirect:'error'、AbortController 超时、
 * 流式字节上限、magic-byte 格式校验）→ 经 FileInputSetter 设置文件 → 后置校验控件成功态（缩略图，
 * 绑定式轮询，**绝不以 input.files.length>0 为足够条件**）→ finally 清理临时文件。
 *
 * 红线：失败/不可校验 → ok:false + 真实分类 error，绝不伪造 ok:true、绝不伪造有图。
 * download 设为私有方法（单调用方，无复用，按 YAGNI 不拆独立 module）；唯一接缝是 FileInputSetter。
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DomProvider } from '../locating/engine.js';
import type { FileInputSetter } from '../cdp/file-input-setter.js';

export interface ImageUploadResult {
  ok: boolean;
  /** image_url_rejected / image_fetch_failed / image_too_large / image_format_unsupported / no_target / engine_error / image_not_attached */
  error?: string;
}

export interface ImageUploaderDeps {
  fileInputSetter: FileInputSetter;
  /** 后置校验读 DOM 找成功态（缩略图）节点。 */
  dom: DomProvider;
  fetchImpl?: typeof fetch;
  /** 下载超时（毫秒）；总预算须低于云端单指令超时，使慢/过期 URL 边缘先返回干净 ok:false。 */
  downloadTimeoutMs?: number;
  /** 下载字节上限（含流式累计，防 Content-Length 说谎）。 */
  maxBytes?: number;
  /** 是否允许 http:（缺省仅 https:；受控测试可开）。 */
  allowHttp?: boolean;
  /** 成功态轮询超时 / 间隔。 */
  verifyTimeoutMs?: number;
  verifyPollMs?: number;
  /** 成功态判定（缺省 best-effort 选择器，待实机校准）。 */
  hasThumbnail?: (root: Element | Document) => boolean;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** best-effort 成功态选择器（真实小红书 DOM 待实机 CDP 校准；命中即视为该图已进入编辑区）。 */
function defaultHasThumbnail(root: Element | Document): boolean {
  const sel = '[data-action-id="note.publish_image_thumb"], .img-preview, .upload-success, [class*="preview"]';
  try {
    return !!root.querySelector(sel);
  } catch {
    return false;
  }
}

/** magic-byte 嗅探：返回扩展名（jpg/png/webp）或 null（非支持图）。不信任扩展名 / Content-Type。 */
function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return 'webp';
  }
  return null;
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = Number(process.env.AIDCP_IMAGE_DOWNLOAD_TIMEOUT_MS ?? 15_000);
const DEFAULT_MAX_BYTES = Number(process.env.AIDCP_IMAGE_MAX_BYTES ?? 10 * 1024 * 1024);
const DEFAULT_VERIFY_TIMEOUT_MS = Number(process.env.AIDCP_IMAGE_VERIFY_TIMEOUT_MS ?? 8_000);
const DEFAULT_VERIFY_POLL_MS = Number(process.env.AIDCP_IMAGE_VERIFY_POLL_MS ?? 300);

export class ImageUploader {
  private readonly fileInputSetter: FileInputSetter;
  private readonly dom: DomProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly downloadTimeoutMs: number;
  private readonly maxBytes: number;
  private readonly allowHttp: boolean;
  private readonly verifyTimeoutMs: number;
  private readonly verifyPollMs: number;
  private readonly hasThumbnail: (root: Element | Document) => boolean;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: ImageUploaderDeps) {
    this.fileInputSetter = deps.fileInputSetter;
    this.dom = deps.dom;
    this.fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.downloadTimeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowHttp = deps.allowHttp ?? false;
    this.verifyTimeoutMs = deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    this.verifyPollMs = deps.verifyPollMs ?? DEFAULT_VERIFY_POLL_MS;
    this.hasThumbnail = deps.hasThumbnail ?? defaultHasThumbnail;
    this.clock = deps.clock ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 上传一张配图。绝不抛——所有失败转诚实 ok:false + 分类 error。 */
  async upload(imageUrl: string): Promise<ImageUploadResult> {
    // 1) URL 安全校验：仅 https（受控可放 http），拒 file:/data:/blob: 等。
    let url: URL;
    try {
      url = new URL(imageUrl);
    } catch {
      return { ok: false, error: 'image_url_rejected' };
    }
    const schemeOk = url.protocol === 'https:' || (this.allowHttp && url.protocol === 'http:');
    if (!schemeOk) return { ok: false, error: 'image_url_rejected' };

    let dir: string | undefined;
    try {
      // 2) 下载到临时文件（含安全封套）。
      const dl = await this.downloadToTemp(imageUrl);
      if (!dl.ok) return { ok: false, error: dl.error };
      dir = dl.dir;

      // 3) CDP 文件输入桥。
      const set = await this.fileInputSetter.setFiles([dl.path]);
      if (!set.ok) return { ok: false, error: set.error ?? 'no_target' };

      // 4) 后置校验：等成功态（缩略图）出现。绝不以 files.length 为足够条件（红线）。
      const attached = await this.verifyAttached();
      if (!attached) return { ok: false, error: 'image_not_attached' };

      return { ok: true };
    } catch (err) {
      return { ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async downloadToTemp(
    imageUrl: string,
  ): Promise<{ ok: true; dir: string; path: string } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    let res: Response;
    try {
      // redirect:'error'——拒绝任何 3xx，防原始 URL 校验被首跳重定向绕过到内网/本地。
      res = await this.fetchImpl(imageUrl, { redirect: 'error', signal: controller.signal });
    } catch {
      return { ok: false, error: 'image_fetch_failed' };
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, error: 'image_fetch_failed' };

    // Content-Length 预检（可被伪造，仅作早拒）。
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > this.maxBytes) return { ok: false, error: 'image_too_large' };

    const bytes = await this.readCapped(res);
    if (!bytes) return { ok: false, error: 'image_too_large' };

    const ext = sniffImage(bytes);
    if (!ext) return { ok: false, error: 'image_format_unsupported' };

    const dir = await mkdtemp(join(tmpdir(), 'aidcp-img-'));
    const path = join(dir, `image.${ext}`);
    await writeFile(path, bytes);
    return { ok: true, dir, path };
  }

  /** 流式累计读，超上限即中止（防 Content-Length 说谎）；无 body reader 时回退 arrayBuffer。 */
  private async readCapped(res: Response): Promise<Uint8Array | null> {
    const reader = res.body?.getReader?.();
    if (!reader) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return buf.byteLength > this.maxBytes ? null : buf;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > this.maxBytes) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }

  private async verifyAttached(): Promise<boolean> {
    const deadline = this.clock() + this.verifyTimeoutMs;
    for (;;) {
      let root: Element | Document | undefined;
      try {
        root = await this.dom.getRoot();
      } catch {
        root = undefined;
      }
      if (root && this.hasThumbnail(root)) return true;
      if (this.clock() >= deadline) return false;
      await this.sleep(this.verifyPollMs);
    }
  }
}
