import type {
  CaptchaAssistCapturePayload,
  CaptchaAssistClickPayload,
  CaptchaAssistClickResultPayload,
  CaptchaAssistSnapshotPayload,
  MessageType,
} from '../comm/protocol.js';
import { dispatchClick, evalRaw, type BrowseCdp } from './cdp-util.js';
import {
  captureBlockingOverlaySnapshot,
  type BlockingOverlayKind,
  type BlockingOverlaySnapshot,
  type OverlayMonitor,
} from './overlay-monitor.js';

type CaptchaAssistCommandPayload = CaptchaAssistCapturePayload | CaptchaAssistClickPayload;

export interface CaptchaAssistEdgeClient {
  send<T>(type: MessageType, payload: T, id?: string): void;
}

export interface CaptchaAssistHandlerDeps {
  cdp: BrowseCdp;
  client: CaptchaAssistEdgeClient;
  edgeId: string;
  getAccountId?: () => string | undefined;
  overlayMonitor?: OverlayMonitor;
  getOverlayMonitor?: () => OverlayMonitor | undefined;
  now?: () => number;
  idGen?: () => string;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

interface ViewportInfo {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  url?: string;
}

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SNAPSHOT_TTL_MS = 5 * 60_000;

export class CaptchaAssistHandler {
  private readonly snapshots = new Map<string, CaptchaAssistSnapshotPayload>();
  private readonly now: () => number;
  private readonly idGen: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: (msg: string) => void;

  constructor(private readonly deps: CaptchaAssistHandlerDeps) {
    this.now = deps.now ?? Date.now;
    this.idGen = deps.idGen ?? (() => `snap-${this.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = deps.logger ?? ((msg) => console.log(msg));
  }

  async handle(type: 'captcha.assist.capture' | 'captcha.assist.click', payload: CaptchaAssistCommandPayload): Promise<void> {
    if (type === 'captcha.assist.capture') {
      await this.handleCapture(payload as CaptchaAssistCapturePayload);
      return;
    }
    await this.handleClick(payload as CaptchaAssistClickPayload);
  }

  private async handleCapture(payload: CaptchaAssistCapturePayload): Promise<void> {
    const kind = await this.probeBlockingKind();
    if (!kind) {
      this.sendClickResult({
        incidentId: payload.incidentId,
        status: 'not_blocked',
        reason: 'blocking_overlay_absent',
        checkedAt: this.now(),
      });
      this.sendRiskCleared();
      return;
    }
    try {
      const snapshot = await this.captureSnapshot(payload.incidentId, kind, payload);
      this.snapshots.set(payload.incidentId, snapshot);
      this.deps.client.send('captcha.assist.snapshot', snapshot);
      this.logger(`[captcha-assist] 已回传截图 incident=${payload.incidentId} snapshot=${snapshot.snapshotId}`);
    } catch (err) {
      this.sendClickResult({
        incidentId: payload.incidentId,
        status: 'failed',
        reason: `capture_failed:${(err as Error).message}`,
        checkedAt: this.now(),
      });
    }
  }

  private async handleClick(payload: CaptchaAssistClickPayload): Promise<void> {
    const snapshot = this.snapshots.get(payload.incidentId);
    if (!snapshot || snapshot.snapshotId !== payload.snapshotId) {
      this.sendClickResult({
        incidentId: payload.incidentId,
        snapshotId: payload.snapshotId,
        status: 'stale_snapshot',
        reason: snapshot ? 'snapshot_id_mismatch' : 'snapshot_missing',
        checkedAt: this.now(),
      });
      return;
    }
    if (!Array.isArray(payload.points) || payload.points.length === 0) {
      this.sendClickResult({
        incidentId: payload.incidentId,
        snapshotId: payload.snapshotId,
        status: 'invalid_target',
        reason: 'empty_points',
        checkedAt: this.now(),
      });
      return;
    }
    try {
      for (const point of payload.points) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
          this.sendClickResult({
            incidentId: payload.incidentId,
            snapshotId: payload.snapshotId,
            status: 'invalid_target',
            reason: 'point_out_of_range',
            checkedAt: this.now(),
          });
          return;
        }
        const x = snapshot.crop.x + point.x * snapshot.crop.width;
        const y = snapshot.crop.y + point.y * snapshot.crop.height;
        await dispatchClick(this.deps.cdp, x, y, { jitter: 0, overshoot: false, moveDelayMs: 6 });
        await this.sleep(220);
      }
      await this.sleep(payload.settleMs ?? 1500);
      const kind = await this.probeBlockingKind();
      if (!kind) {
        this.sendClickResult({
          incidentId: payload.incidentId,
          snapshotId: payload.snapshotId,
          status: 'cleared',
          checkedAt: this.now(),
        });
        this.sendRiskCleared();
        return;
      }
      const next = await this.captureSnapshot(payload.incidentId, kind, {});
      this.snapshots.set(payload.incidentId, next);
      this.sendClickResult({
        incidentId: payload.incidentId,
        snapshotId: payload.snapshotId,
        status: 'still_blocked',
        reason: 'blocking_overlay_still_visible',
        checkedAt: this.now(),
        snapshot: next,
      });
    } catch (err) {
      this.sendClickResult({
        incidentId: payload.incidentId,
        snapshotId: payload.snapshotId,
        status: 'failed',
        reason: `click_failed:${(err as Error).message}`,
        checkedAt: this.now(),
      });
    }
  }

  private async captureSnapshot(
    incidentId: string,
    kind: BlockingOverlayKind,
    request: Pick<CaptchaAssistCapturePayload, 'maxImageWidth' | 'maxImageHeight' | 'quality'>,
  ): Promise<CaptchaAssistSnapshotPayload> {
    const viewport = await readViewport(this.deps.cdp);
    const overlay = await this.captureOverlaySnapshot(kind);
    const crop = computeCrop(viewport, overlay);
    const maxWidth = clampPositive(request.maxImageWidth, 1600);
    const maxHeight = clampPositive(request.maxImageHeight, 1600);
    const scale = Math.min(1, maxWidth / crop.width, maxHeight / crop.height);
    const format = typeof request.quality === 'number' ? 'jpeg' : 'png';
    const screenshot = await this.deps.cdp.send<{ data?: string }>('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: Math.max(1, Math.min(100, Math.round(request.quality ?? 75))) } : {}),
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: crop.x, y: crop.y, width: crop.width, height: crop.height, scale },
    });
    if (!screenshot.data) throw new Error('empty_screenshot');
    const now = this.now();
    return {
      incidentId,
      edgeId: this.deps.edgeId,
      ...(this.deps.getAccountId?.() ? { accountId: this.deps.getAccountId?.() } : {}),
      snapshotId: this.idGen(),
      capturedAt: now,
      expiresAt: now + SNAPSHOT_TTL_MS,
      kind,
      ...(viewport.url ? { url: viewport.url } : {}),
      viewport: {
        width: viewport.width,
        height: viewport.height,
        ...(viewport.deviceScaleFactor ? { deviceScaleFactor: viewport.deviceScaleFactor } : {}),
      },
      crop,
      image: {
        mime: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        data: screenshot.data,
        width: Math.max(1, Math.round(crop.width * scale)),
        height: Math.max(1, Math.round(crop.height * scale)),
      },
      ...(overlay ? { overlay } : {}),
    };
  }

  private async captureOverlaySnapshot(kind: BlockingOverlayKind): Promise<BlockingOverlaySnapshot | undefined> {
    try {
      return await captureBlockingOverlaySnapshot(this.deps.cdp, kind);
    } catch (err) {
      this.logger(`[captcha-assist] 遮罩快照采集失败，退回全视口截图：${(err as Error).message}`);
      return undefined;
    }
  }

  private async probeBlockingKind(): Promise<BlockingOverlayKind | null> {
    const monitor = this.deps.getOverlayMonitor?.() ?? this.deps.overlayMonitor;
    if (!monitor) return 'unknown';
    const kind = await monitor.probeNow();
    return kind === 'captcha' || kind === 'unknown' ? kind : null;
  }

  private sendClickResult(payload: Omit<CaptchaAssistClickResultPayload, 'edgeId' | 'accountId'>): void {
    this.deps.client.send('captcha.assist.click_result', {
      ...payload,
      edgeId: this.deps.edgeId,
      ...(this.deps.getAccountId?.() ? { accountId: this.deps.getAccountId?.() } : {}),
    });
  }

  private sendRiskCleared(): void {
    this.deps.client.send('risk.captcha_cleared', {
      edgeId: this.deps.edgeId,
      ...(this.deps.getAccountId?.() ? { accountId: this.deps.getAccountId?.() } : {}),
    });
  }
}

async function readViewport(cdp: BrowseCdp): Promise<ViewportInfo> {
  const value = await evalRaw<ViewportInfo>(
    cdp,
    `(() => ({
      width: Math.max(1, Math.round(window.innerWidth || document.documentElement.clientWidth || 1)),
      height: Math.max(1, Math.round(window.innerHeight || document.documentElement.clientHeight || 1)),
      deviceScaleFactor: window.devicePixelRatio || 1,
      url: String(location.href || '')
    }))()`,
  );
  return {
    width: clampPositive(value?.width, 1),
    height: clampPositive(value?.height, 1),
    ...(typeof value?.deviceScaleFactor === 'number' && value.deviceScaleFactor > 0 ? { deviceScaleFactor: value.deviceScaleFactor } : {}),
    ...(typeof value?.url === 'string' && value.url ? { url: value.url } : {}),
  };
}

function computeCrop(viewport: ViewportInfo, overlay: BlockingOverlaySnapshot | undefined): CropRect {
  const rect = overlay?.dom?.rect;
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  }
  const pad = 24;
  const x = Math.max(0, Math.floor(rect.x - pad));
  const y = Math.max(0, Math.floor(rect.y - pad));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + pad));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + pad));
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  return { x, y, width, height };
}

function clampPositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
