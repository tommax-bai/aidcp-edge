import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PublishCommandPayload, PublishCommandResultPayload } from '../comm/protocol.js';
import type { CommitWindowGuard } from '../execution/commit-window.js';
import { nativePublishCommand } from './command-mapper.js';
import { NativePageRuntime } from './runtime.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FACEBOOK_PUBLISH_FILL_MAX_TIMEOUT_MS = 400_000;

export class NativePublishExecutor {
  private readonly drafts = new Map<string, { nextImageIndex: number; imageIndexes: Map<string, number> }>();

  constructor(
    private readonly runtime: NativePageRuntime,
    private readonly tempPrefix: string,
    private readonly commitWindow?: CommitWindowGuard,
  ) {}

  async dispatch(payload: PublishCommandPayload, signal?: AbortSignal): Promise<PublishCommandResultPayload> {
    let tempDir: string | undefined;
    try {
      let localImagePath: string | undefined;
      let imageIndex: number | undefined;
      const draftKey = `${payload.taskId}:${payload.recordId}`;
      if (payload.kind === 'navigate_entry') this.drafts.set(draftKey, { nextImageIndex: 0, imageIndexes: new Map() });
      const draft = this.drafts.get(draftKey) ?? { nextImageIndex: 0, imageIndexes: new Map<string, number>() };
      this.drafts.set(draftKey, draft);
      if (payload.kind === 'upload_image') {
        const imageUrl = payload.params.imageUrl;
        if (!imageUrl) return this.failed(payload, 'image_url_missing');
        const materialized = await materializeImage(imageUrl, this.tempPrefix, signal);
        if (!materialized.ok) return this.failed(payload, materialized.error);
        tempDir = materialized.dir;
        localImagePath = materialized.path;
        imageIndex = draft.nextImageIndex;
      } else if (payload.kind === 'set_cover') {
        const imageUrl = payload.params.imageUrl;
        imageIndex = imageUrl ? draft.imageIndexes.get(imageUrl) : undefined;
        if (imageIndex === undefined) return this.failed(payload, 'cover_source_not_uploaded');
      }
      const maxTimeoutMs = payload.platform === 'facebook'
        ? payload.kind === 'fill_field'
          ? FACEBOOK_PUBLISH_FILL_MAX_TIMEOUT_MS
          : payload.kind === 'select_mode'
            ? 40_000
            : 30_000
        : 30_000;
      const timeoutMs = Math.max(50, Math.min(maxTimeoutMs, payload.timeoutMs ?? 30_000));
      const execution = await this.runtime.execute(
        payload.taskId,
        nativePublishCommand(payload, { localImagePath, imageIndex }),
        timeoutMs,
        signal,
        // 提交窗口处理器与平台无关：开窗由执行体在不可逆写入的正前方发起请求，
        // 宿主只做仲裁与转发。这里**不得**加平台条件——加了就等于把某个平台的
        // 发布提交重新暴露成「无声照写」（协调器可在提交进行中接管）。
        this.commitWindow
          ? (request) => this.commitWindow!.enter(request.budgetMs, request.label)
          : undefined,
      );
      const value = execution.output?.kind === 'publish_receipt'
        ? execution.output.value as Record<string, unknown>
        : {};
      const confirmed = execution.effectPhase === 'confirmed' && value.ok === true;
      if (confirmed && payload.kind === 'upload_image' && payload.params.imageUrl && imageIndex !== undefined) {
        draft.imageIndexes.set(payload.params.imageUrl, imageIndex);
        draft.nextImageIndex = Math.max(draft.nextImageIndex, imageIndex + 1);
      }
      if (payload.kind === 'capture_postId' || payload.kind === 'capture_scheduled' || payload.kind === 'reconcile_scheduled') {
        this.drafts.delete(draftKey);
      }
      return {
        recordId: payload.recordId,
        seq: payload.seq,
        kind: payload.kind,
        ok: confirmed,
        ...(typeof value.submitDispatched === 'boolean' ? { submitDispatched: value.submitDispatched } : {}),
        ...(typeof value.value === 'string' ? { value: value.value } : {}),
        ...(typeof value.postUrl === 'string' ? { postUrl: value.postUrl } : {}),
        ...(!confirmed ? {
          error: execution.effectPhase === 'ambiguous'
            ? 'native_effect_ambiguous'
            : typeof value.error === 'string' ? value.error : 'native_postcondition_failed',
        } : {}),
      };
    } catch (error) {
      const native = error as { code?: string; detail?: { effectPhase?: string } };
      return this.failed(
        payload,
        native.detail?.effectPhase === 'ambiguous' ? 'native_effect_ambiguous' : native.code ?? 'native_dispatch_failed',
      );
    } finally {
      if (tempDir) setTimeout(() => void rm(tempDir!, { recursive: true, force: true }), 5 * 60_000).unref?.();
    }
  }

  private failed(payload: PublishCommandPayload, error: string): PublishCommandResultPayload {
    return { recordId: payload.recordId, seq: payload.seq, kind: payload.kind, ok: false, error };
  }
}

async function materializeImage(
  rawUrl: string,
  tempPrefix: string,
  signal?: AbortSignal,
): Promise<{ ok: true; dir: string; path: string } | { ok: false; error: string }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, error: 'image_url_rejected' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'image_url_rejected' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) return { ok: false, error: 'image_fetch_failed' };
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return { ok: false, error: 'image_too_large' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_IMAGE_BYTES) { await reader.cancel(); return { ok: false, error: 'image_too_large' }; }
      chunks.push(item.value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const extension = imageExtension(bytes);
    if (!extension) return { ok: false, error: 'image_format_unsupported' };
    const dir = await mkdtemp(join(tmpdir(), tempPrefix));
    const path = join(dir, `image.${extension}`);
    await writeFile(path, bytes);
    return { ok: true, dir, path };
  } catch {
    return { ok: false, error: signal?.aborted ? 'preempted_by_task' : 'image_fetch_failed' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function imageExtension(bytes: Buffer): 'jpg' | 'png' | 'webp' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return undefined;
}
