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
import { sanitizeTrajectory, replayTrajectory } from '../humanize/trajectory-replay.js';

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
  // 注入派发中的 incident：实时 tick 与手动抓帧 MUST 跳过，避免抓到派发到一半的半程画面。
  // 名字是「writing」而非「clicking」：这个集合守的是**任何向页面写入的动作**（点击、将来的键入），
  // 不只是点击。叫 clicking 会诱导后来者为键入新开一个 typing 集合，把同一个洞再开一次。
  private readonly writing = new Set<string>();
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
    // 注入期不抓帧（与 liveTick 同形的互斥）：此刻的画面是点击/键入派发到一半的半程状态，
    // 回传给运营毫无价值，而它的 probe 还会污染下面的清除判定。
    if (this.writing.has(payload.incidentId)) return;
    const kind = await this.probeBlockingKind();
    if (!kind) {
      this.stopLive(payload.incidentId);
      // 只回 not_blocked 回执，**绝不发 risk.captcha_cleared**。
      // 手动刷新与实时循环共用同一个「旧挑战已消失、新挑战未绘出」的瞬时无遮罩窗口——
      // 单次 probe 在这里与在 liveTick 里同样不可信。liveTick 为此立了 K=3 连续确认，
      // 而这条路径曾绕过它直接上报清除 = 提前解 restricted（自残）。清除的发出权只归两处：
      // liveTick 的 K=3，与旁路监测体的翻转闸。cloud 的 onClickResult 已把 not_blocked
      // 映射为 cleared，面板照常更新——此处无需、也无权代发。
      this.sendClickResult({
        incidentId: payload.incidentId,
        status: 'not_blocked',
        reason: 'blocking_overlay_absent',
        checkedAt: this.now(),
      });
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
    // 落点范围校验前置（合成与轨迹两路都用 points 作权威落点）。
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
    }
    // 轨迹有效 → 回放运营真实轨迹；无/无效 → 回落合成拟人路径（change captcha-assist-humanize-click）。
    const traj = sanitizeTrajectory(payload.trajectory, payload.points.length);
    const replayMode: 'trajectory' | 'synthetic' = traj ? 'trajectory' : 'synthetic';
    if (payload.trajectory && !traj) {
      // 可观测丢弃：轨迹畸形/超限被丢，如实标注回落，绝不静默、绝不谎称用了轨迹。
      this.logger(`[captcha-assist] 轨迹无效，回落合成 incident=${payload.incidentId}`);
    }
    // 点击全程暂停实时 tick（互斥），避免抓到点击派发中途 / settle / 复检期间的画面。
    this.writing.add(payload.incidentId);
    try {
      // 落点回放前强制复检（change lease-strict-preemption 5.7）：快照是运营几十秒前看到的那一帧，
      // 落点按那一帧标定。回放前若页面已不是那一刻——阻断自行消失 / 换了阻断类型 / 页面被导航走——
      // 照旧坐标盲点就是在错误页面上乱点（抢占落地后那"错误页面"很可能正是发布编辑页）。今天靠
      // "验证码协助命令拿不到租约"挡着（安全的失败）；抢占之后会变成"抢到了 → 盲点"（不安全的成功）。
      // 不一致一律诚实拒绝 + 重抓帧让运营在新帧上重标，绝不盲点。
      if (await this.recheckStaleBeforeReplay(payload, snapshot)) return;
      if (traj) {
        // 落点权威取 points（按被点帧 crop 缩放）；样本供移动/时序；每次 press 前补 move 到权威点。
        await replayTrajectory(this.deps.cdp, snapshot.crop, payload.points, traj, this.random, this.sleep);
      } else {
        // 合成拟人注入：连续光标 + overshoot/jitter + 逐帧 dt 抖动 + 落点前读图停顿 + 点间对数正态停顿。
        const pacing = this.captchaPacing();
        let cursor: { x: number; y: number } | undefined;
        const pts = payload.points;
        for (let i = 0; i < pts.length; i++) {
          const point = pts[i];
          // 用"被点的那一帧自己的 crop"缩放落点（冻结提交时该帧可能不是最新帧）。
          const x = snapshot.crop.x + point.x * snapshot.crop.width;
          const y = snapshot.crop.y + point.y * snapshot.crop.height;
          // 上一点的**真实落点**作下一点起步，保光标连续。
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
          if (i < pts.length - 1) await this.sleep(sampleDelay(pacing.interPoint, this.random));
        }
      }
      await this.sleep(payload.settleMs ?? 1500);
      const kind = await this.probeBlockingKind();
      if (!kind) {
        this.stopLive(payload.incidentId);
        // 顺序不可换：cleared 承重（解除该 edge 的下发暂停、放生产账号继续跑），click_result 只驱动面板。
        // 二者各自 try/catch —— client.send 在断连时会抛，把承重的那条排在装饰性的那条之后，
        // 就是让「验证码已经解开了」这个事实永远到不了云端、账号无限期暗停。
        this.sendRiskClearedSafely();
        this.sendClickResultSafely({
          incidentId: payload.incidentId,
          snapshotId: payload.snapshotId,
          status: 'cleared',
          checkedAt: this.now(),
          replayMode,
        });
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
        replayMode,
      });
    } catch (err) {
      // 注入失败时框里可能留着半截答案/半程状态。不回带新帧，运营看不见现场就无法带 clear 重来。
      // best-effort：重抓帧再失败 MUST NOT 盖掉原始 reason —— 那才是运营要看的那句话。
      const reason = `click_failed:${(err as Error).message}`;
      let snapshot: CaptchaAssistSnapshotPayload | undefined;
      try {
        const kind = await this.probeBlockingKind();
        if (kind) {
          snapshot = await this.captureSnapshot(payload.incidentId, kind, {});
          this.pushSnapshot(payload.incidentId, snapshot);
        }
      } catch (recaptureErr) {
        this.logger(
          `[captcha-assist] 失败路径重抓帧失败 incident=${payload.incidentId}: ${(recaptureErr as Error).message}`,
        );
      }
      this.sendClickResult({
        incidentId: payload.incidentId,
        snapshotId: payload.snapshotId,
        status: 'failed',
        reason,
        checkedAt: this.now(),
        ...(snapshot ? { snapshot } : {}),
        replayMode,
      });
    } finally {
      this.writing.delete(payload.incidentId);
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
    if (this.writing.has(incidentId) || this.capturing.has(incidentId)) return;
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

  /**
   * 发 cleared，吞掉传输异常。
   * 只用于「cleared 与 click_result 成对发出」的成功路径：两者 MUST 互不牵连——
   * 前者抛不该让后者不发，后者抛更不该让前者白发。调用方 MUST 先发 cleared 再发 click_result。
   */
  private sendRiskClearedSafely(): void {
    try {
      this.sendRiskCleared();
    } catch (err) {
      // 吞异常但绝不静默：这条丢了 = 云端不知道验证码已解、该 edge 一直暗停，必须留痕。
      this.logger(`[captcha-assist] risk.captcha_cleared 发送失败（该 edge 可能仍被暂停）：${(err as Error).message}`);
    }
  }

  /** 发 click_result，吞掉传输异常（面板展示用，丢了不影响恢复）。 */
  private sendClickResultSafely(payload: Omit<CaptchaAssistClickResultPayload, 'edgeId' | 'accountId'>): void {
    try {
      this.sendClickResult(payload);
    } catch (err) {
      this.logger(`[captcha-assist] click_result 发送失败：${(err as Error).message}`);
    }
  }

  private sendRiskCleared(): void {
    this.deps.client.send('risk.captcha_cleared', {
      edgeId: this.deps.edgeId,
      ...(this.deps.getAccountId?.() ? { accountId: this.deps.getAccountId?.() } : {}),
    });
  }

  /**
   * 落点回放前强制复检（change lease-strict-preemption 5.7）。
   * 返回 true = 页面已不是快照那一刻、已发诚实回执，调用方 MUST return（绝不回放）；
   * 返回 false = 同类阻断仍在且页面一致，可安全回放。
   */
  private async recheckStaleBeforeReplay(
    payload: CaptchaAssistClickPayload,
    snapshot: CaptchaAssistSnapshotPayload,
  ): Promise<boolean> {
    let kind: BlockingOverlayKind | null;
    let currentUrl: string | undefined;
    try {
      kind = await this.probeBlockingKind();
      currentUrl = (await readViewport(this.deps.cdp)).url;
    } catch (err) {
      // 复检本身失败 = 无法确认页面仍安全 → 绝不盲点，诚实回 failed。
      this.sendClickResult({
        incidentId: payload.incidentId,
        snapshotId: payload.snapshotId,
        status: 'failed',
        reason: `recheck_failed:${(err as Error).message}`,
        checkedAt: this.now(),
      });
      return true;
    }
    // (a) 阻断已自行消失：页面上已无验证码 → 绝不在其上盲点（那可能已经导航到别的页面）。
    // 只回 not_blocked，**绝不由这一次单次 probe 发 risk.captcha_cleared**：此处既没 settle
    // 也没连续确认，与手动刷新同属「未经注入的单次 probe」，同样会撞上多步验证码的瞬时无遮罩窗口。
    // 清除交由旁路监测体的翻转闸（它独立轮询，遮罩真消失时会发配对 cleared）——不发不会滞留暂停态。
    if (!kind) {
      this.stopLive(payload.incidentId);
      this.sendClickResult({
        incidentId: payload.incidentId,
        snapshotId: payload.snapshotId,
        status: 'not_blocked',
        reason: 'cleared_before_replay',
        checkedAt: this.now(),
      });
      return true;
    }
    // (b) 页面已换（阻断类型变了，或 URL 变了）：快照过期 → 重抓帧让运营在新帧上重标，绝不按旧坐标盲点。
    const kindChanged = kind !== snapshot.kind;
    const urlChanged = !!snapshot.url && !!currentUrl && !sameLocation(snapshot.url, currentUrl);
    if (kindChanged || urlChanged) {
      try {
        const next = await this.captureSnapshot(payload.incidentId, kind, {});
        this.pushSnapshot(payload.incidentId, next);
        this.deps.client.send('captcha.assist.snapshot', next);
      } catch (err) {
        this.logger(`[captcha-assist] 回放前复检重抓帧失败 incident=${payload.incidentId}: ${(err as Error).message}`);
      }
      this.sendClickResult({
        incidentId: payload.incidentId,
        snapshotId: payload.snapshotId,
        status: 'stale_snapshot',
        reason: kindChanged ? 'kind_changed_before_replay' : 'page_moved_before_replay',
        checkedAt: this.now(),
      });
      return true;
    }
    return false;
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

/** 仅比 origin+pathname：验证码页的 query/token 每次刷新都不同，纳入比对会把同一页误判成"变了"。 */
function sameLocation(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
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
