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
import { sampleDelay, defaultRandom as humanDefaultRandom, type TimingConfig } from '../humanize/index.js';

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
  /** 注入随机源（change captcha-assist-humanize-click）：拟人参数与停顿共用，测试注入确定性。 */
  random?: () => number;
}

/**
 * 协助注入点击的拟人节奏基线（change captcha-assist-humanize-click）。
 * 现役日常点击默认 overshoot~15% / jitter 3 / moveDelay 8；验证码是反爬审查最严、专门用鼠标轨迹熵
 * 做指纹的场景，这里取**不低于日常**的档：恢复 overshoot + 小幅 jitter + 略慢移动 + 落点前读图停顿 +
 * 点间对数正态停顿。中心值按 edgeId 派生每机偏置（见 captchaPacing），避免全 fleet 逐字相同的节奏自成
 * 车队指纹。
 */
const CAPTCHA_PACING = {
  jitter: 2,
  overshootProb: 0.22,
  moveDelayMs: 11,
  hoverDwell: { mu: Math.log(650), sigma: 0.4, min: 280, max: 1600 } satisfies TimingConfig,
  interPoint: { mu: Math.log(950), sigma: 0.4, min: 420, max: 2600 } satisfies TimingConfig,
};

/** 按 edgeId 派生 [-0.15, 0.15) 的每机偏置（FNV-1a），打散车队级节奏指纹。 */
function edgeIdBias(edgeId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < edgeId.length; i++) {
    h ^= edgeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1000) / 1000 * 0.3 - 0.15;
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

// 每 incident 保留最近若干帧（change captcha-assist-live-snapshot）：实时抓帧会推进"最新"，
// 运营点的是被 pin 的稍旧但"与所见一致"的帧，按其 snapshotId 在环内查回该帧自己的 crop 落点。
// 边缘环 > 云端近期集，确保云端放行的 snapshotId 边缘一定还留着（云端拦不到、边缘却已淘汰 = 白跑）。
const SNAPSHOT_RING_SIZE = 8;

// 实时抓帧循环参数（都有硬钳制，云端下发只是 hint）。
const LIVE_INTERVAL_MS = { def: 800, min: 600, max: 2000 };
const LIVE_MAX_DURATION_MS = { def: 30_000, min: 5_000, max: 120_000 };
const LIVE_MAX_FRAMES = { min: 1, max: 400 };
// 自主判"验证码已清除"需连续 K 次探测都无遮罩才成立——多步验证码在旧挑战消失、新挑战未绘出之间
// 有瞬时无遮罩窗口，单次没看到就发 risk.captcha_cleared 会提前解 restricted（自残）。
const LIVE_CLEAR_CONFIRMATIONS = 3;
// 最小推帧间隔硬地板：带倒计时/动画的页每帧字节都变、内容去重永不命中时，用它兜住带宽/成本。
const LIVE_MIN_PUSH_INTERVAL_MS = 600;
// 实时帧适度降质以约束单帧字节（运营看清挑战足够，不追求原画质）。
const LIVE_FRAME_QUALITY = 60;

interface LiveState {
  token: number;
  clearStreak: number;
  lastPushedHash?: string;
  lastPushAt: number;
}

export class CaptchaAssistHandler {
  // 每 incident 一个最近帧环（newest last）。
  private readonly snapshotRings = new Map<string, CaptchaAssistSnapshotPayload[]>();
  // 活跃实时循环：存在 = 在跑；token 用于 re-arm 时抢占旧循环、stopLive 时令旧循环自然退出。
  private readonly live = new Map<string, LiveState>();
  // 点击派发中的 incident：实时 tick MUST 跳过，避免抓到点击派发到一半的半程画面。
  private readonly clicking = new Set<string>();
  // 抓帧进行中的 incident：手动刷新与实时 tick 互斥，避免并发 captureScreenshot 叠加。
  private readonly capturing = new Set<string>();
  private liveCounter = 0;
  private readonly now: () => number;
  private readonly idGen: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: (msg: string) => void;
  private readonly random: () => number;

  constructor(private readonly deps: CaptchaAssistHandlerDeps) {
    this.now = deps.now ?? Date.now;
    this.idGen = deps.idGen ?? (() => `snap-${this.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = deps.logger ?? ((msg) => console.log(msg));
    this.random = deps.random ?? humanDefaultRandom;
  }

  /** 本 edge 的协助点击节奏：基线叠 edgeId 派生偏置（防车队指纹）。 */
  private captchaPacing() {
    const bias = edgeIdBias(this.deps.edgeId);
    return {
      jitter: CAPTCHA_PACING.jitter,
      overshootProb: Math.min(0.35, Math.max(0.1, CAPTCHA_PACING.overshootProb + bias * 0.4)),
      moveDelayMs: Math.max(6, Math.round(CAPTCHA_PACING.moveDelayMs * (1 + bias))),
      hoverDwell: CAPTCHA_PACING.hoverDwell,
      interPoint: CAPTCHA_PACING.interPoint,
    };
  }

  async handle(type: 'captcha.assist.capture' | 'captcha.assist.click', payload: CaptchaAssistCommandPayload): Promise<void> {
    if (type === 'captcha.assist.capture') {
      await this.handleCapture(payload as CaptchaAssistCapturePayload);
      return;
    }
    await this.handleClick(payload as CaptchaAssistClickPayload);
  }

  private pushSnapshot(incidentId: string, snap: CaptchaAssistSnapshotPayload): void {
    const ring = this.snapshotRings.get(incidentId) ?? [];
    ring.push(snap);
    while (ring.length > SNAPSHOT_RING_SIZE) ring.shift();
    this.snapshotRings.set(incidentId, ring);
  }

  private findSnapshot(incidentId: string, snapshotId: string): CaptchaAssistSnapshotPayload | undefined {
    const ring = this.snapshotRings.get(incidentId);
    if (!ring) return undefined;
    // 从最新往旧找：常规提交命中最新，冻结提交命中稍旧帧。
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i].snapshotId === snapshotId) return ring[i];
    }
    return undefined;
  }

  private async handleCapture(payload: CaptchaAssistCapturePayload): Promise<void> {
    const kind = await this.probeBlockingKind();
    if (!kind) {
      this.stopLive(payload.incidentId);
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
      this.capturing.add(payload.incidentId);
      const snapshot = await this.captureSnapshot(payload.incidentId, kind, payload);
      this.pushSnapshot(payload.incidentId, snapshot);
      this.deps.client.send('captcha.assist.snapshot', snapshot);
      this.logger(`[captcha-assist] 已回传截图 incident=${payload.incidentId} snapshot=${snapshot.snapshotId}`);
      // 带 live 字段 = 进入有界实时抓帧循环（首帧已推，seed 去重哈希避免立即重推同帧）。
      if (payload.live) this.startLive(payload.incidentId, payload.live, hashImageData(snapshot.image.data));
    } catch (err) {
      this.sendClickResult({
        incidentId: payload.incidentId,
        status: 'failed',
        reason: `capture_failed:${(err as Error).message}`,
        checkedAt: this.now(),
      });
    } finally {
      this.capturing.delete(payload.incidentId);
    }
  }

  private async handleClick(payload: CaptchaAssistClickPayload): Promise<void> {
    const snapshot = this.findSnapshot(payload.incidentId, payload.snapshotId);
    if (!snapshot) {
      this.sendClickResult({
        incidentId: payload.incidentId,
        snapshotId: payload.snapshotId,
        status: 'stale_snapshot',
        reason: this.snapshotRings.has(payload.incidentId) ? 'snapshot_id_mismatch' : 'snapshot_missing',
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
    // 点击全程暂停实时 tick（互斥），避免抓到点击派发中途 / settle / 复检期间的画面。
    this.clicking.add(payload.incidentId);
    try {
      // 拟人注入（change captcha-assist-humanize-click）：连续光标 + overshoot/jitter + 逐帧 dt 抖动 +
      // 落点前读图停顿 + 点间对数正态停顿；节奏按 edgeId 派生偏置。不再用比日常更弱的 jitter:0/overshoot:false。
      const pacing = this.captchaPacing();
      let cursor: { x: number; y: number } | undefined;
      const pts = payload.points;
      for (let i = 0; i < pts.length; i++) {
        const point = pts[i];
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
        // 用"被点的那一帧自己的 crop"缩放落点（冻结提交时该帧可能不是最新帧）。
        const x = snapshot.crop.x + point.x * snapshot.crop.width;
        const y = snapshot.crop.y + point.y * snapshot.crop.height;
        // 上一点的**真实落点**作下一点起步，保光标连续（dispatchClick 返回含 jitter/overshoot 的末点）。
        cursor = await dispatchClick(this.deps.cdp, x, y, {
          from: cursor,
          jitter: pacing.jitter,
          overshoot: this.random() < pacing.overshootProb,
          moveDelayMs: pacing.moveDelayMs,
          moveDelayJitter: true,
          hoverDwellMs: sampleDelay(pacing.hoverDwell, this.random),
          random: this.random,
          sleep: this.sleep,
        });
        // 点间对数正态停顿：仅非末点后停（末点后直接进 settle）。
        if (i < pts.length - 1) await this.sleep(sampleDelay(pacing.interPoint, this.random));
      }
      await this.sleep(payload.settleMs ?? 1500);
      const kind = await this.probeBlockingKind();
      if (!kind) {
        this.stopLive(payload.incidentId);
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
      this.pushSnapshot(payload.incidentId, next);
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
    } finally {
      this.clicking.delete(payload.incidentId);
    }
  }

  // ── 实时抓帧循环（change captcha-assist-live-snapshot）─────────────────────────
  // 有界、内容去重、自终止。iteration-bounded：终止靠 for-loop 帧数上界 + token 抢占，
  // 绝不拿 now() 当唯一终止条件（桩测注入恒定 now 会死循环，见 memory）。

  private startLive(incidentId: string, hint: NonNullable<CaptchaAssistCapturePayload['live']>, seedHash: string): void {
    const token = ++this.liveCounter;
    // re-arm：直接覆盖 token，旧循环下一拍看到 token 变了会自然退出，clearStreak 归零重来。
    this.live.set(incidentId, { token, clearStreak: 0, lastPushedHash: seedHash, lastPushAt: this.now() });
    const intervalMs = clampRange(hint.intervalMs, LIVE_INTERVAL_MS.def, LIVE_INTERVAL_MS.min, LIVE_INTERVAL_MS.max);
    const maxDurationMs = clampRange(hint.maxDurationMs, LIVE_MAX_DURATION_MS.def, LIVE_MAX_DURATION_MS.min, LIVE_MAX_DURATION_MS.max);
    const framesByTime = Math.ceil(maxDurationMs / intervalMs) + 2;
    const maxFrames = clampRange(hint.maxFrames, framesByTime, LIVE_MAX_FRAMES.min, LIVE_MAX_FRAMES.max);
    void this.runLiveLoop(incidentId, token, intervalMs, maxDurationMs, maxFrames);
  }

  private stopLive(incidentId: string): void {
    // 删 token → 正在跑的循环下一拍看到 token 不匹配即退出。
    this.live.delete(incidentId);
  }

  private async runLiveLoop(
    incidentId: string,
    token: number,
    intervalMs: number,
    maxDurationMs: number,
    maxFrames: number,
  ): Promise<void> {
    const startedAt = this.now();
    try {
      for (let i = 0; i < maxFrames; i++) {
        await this.sleep(intervalMs);
        // token 变了（stopLive / re-arm）→ 本循环退出。
        if (this.live.get(incidentId)?.token !== token) return;
        // 软时间上界：真机会触发；桩测恒定 now 下不触发但 maxFrames 兜住，不会死循环。
        if (this.now() - startedAt >= maxDurationMs) break;
        await this.liveTick(incidentId, token);
      }
    } catch (err) {
      this.logger(`[captcha-assist] 实时循环异常退出 incident=${incidentId}: ${(err as Error).message}`);
    } finally {
      // 仅当仍是本循环持有 token 时清理，避免误删 re-arm 后的新循环状态。
      if (this.live.get(incidentId)?.token === token) this.live.delete(incidentId);
    }
  }

  private async liveTick(incidentId: string, token: number): Promise<void> {
    if (this.clicking.has(incidentId) || this.capturing.has(incidentId)) return;
    const kind = await this.probeBlockingKind();
    const state = this.live.get(incidentId);
    if (!state || state.token !== token) return;

    if (!kind) {
      // 无遮罩：连续确认 K 次 + 有 tick 间隔作 settle 才判真清除，单次不清（防瞬时无遮罩窗口误清）。
      state.clearStreak += 1;
      if (state.clearStreak >= LIVE_CLEAR_CONFIRMATIONS) {
        this.stopLive(incidentId);
        // 自主清除只发 risk.captcha_cleared（走 onCleared），绝不发 click_result——否则把非运营
        // 发起的探测记进 incident.lastResult，污染前端"上次复检"与审计。
        this.sendRiskCleared();
        this.logger(`[captcha-assist] 实时循环自主判清除 incident=${incidentId}（连续${state.clearStreak}次无遮罩）`);
      }
      return;
    }
    state.clearStreak = 0;

    // 仍被挡：抓帧 → 内容去重（+最小推帧间隔地板）→ 变了才推新帧。
    this.capturing.add(incidentId);
    try {
      const snap = await this.captureSnapshot(incidentId, kind, { quality: LIVE_FRAME_QUALITY });
      const cur = this.live.get(incidentId);
      if (!cur || cur.token !== token) return; // 抓帧期间被抢占/停止
      const hash = hashImageData(snap.image.data);
      const now = this.now();
      const unchanged = hash === cur.lastPushedHash;
      const tooSoon = now - cur.lastPushAt < LIVE_MIN_PUSH_INTERVAL_MS;
      if (unchanged || tooSoon) return;
      cur.lastPushedHash = hash;
      cur.lastPushAt = now;
      this.pushSnapshot(incidentId, snap);
      this.deps.client.send('captcha.assist.snapshot', snap);
      this.logger(`[captcha-assist] 实时新帧 incident=${incidentId} snapshot=${snap.snapshotId}`);
    } catch (err) {
      // 单次抓帧失败不杀循环，下一拍再试。
      this.logger(`[captcha-assist] 实时抓帧失败 incident=${incidentId}: ${(err as Error).message}`);
    } finally {
      this.capturing.delete(incidentId);
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

/** 取正数 value（无效则用 def），再钳到 [min,max]。用于把云端下发的 live hint 收进安全区间。 */
function clampRange(value: unknown, def: number, min: number, max: number): number {
  const v = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : def;
  return Math.min(max, Math.max(min, v));
}

/**
 * 便宜的内容哈希（FNV-1a 32-bit）用于实时抓帧去重：同帧不重推。
 * 精确哈希对带倒计时/动画的页会每帧不同（去重失效），故上层另有最小推帧间隔地板兜底成本。
 */
function hashImageData(data: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${data.length}`;
}
