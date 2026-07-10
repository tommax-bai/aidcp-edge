import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaAssistHandler } from '../../src/browse/captcha-assist.js';
import type { BrowseCdp, OverlayKind, OverlayMonitor } from '../../src/browse/index.js';
import type { MessageType } from '../../src/comm/protocol.js';

class FakeCdp implements BrowseCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private shotIdx = 0;
  constructor(
    private readonly opts: {
      overlayRect?: { x: number; y: number; width: number; height: number };
      // 依次返回的截图数据（模拟画面变化/动画）；用完后停在最后一张（模拟稳定画面）。
      screenshots?: string[];
    } = {},
  ) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression ?? '');
      if (expression.includes('deviceScaleFactor')) {
        return { result: { value: { width: 1000, height: 800, deviceScaleFactor: 2, url: 'https://xhs.test/explore' } } } as T;
      }
      return {
        result: {
          value: {
            kind: 'captcha',
            firstDetectedUrl: 'https://xhs.test/explore',
            capturedAt: 100,
            text: '安全验证',
            dom: {
              tag: 'div',
              className: 'captcha-modal',
              rect: this.opts.overlayRect ?? { x: 100, y: 100, width: 200, height: 100 },
              matchReasons: ['captcha_text'],
            },
            candidates: [],
          },
        },
      } as T;
    }
    if (method === 'Page.captureScreenshot') {
      const shots = this.opts.screenshots;
      if (shots && shots.length > 0) {
        const data = shots[Math.min(this.shotIdx, shots.length - 1)];
        this.shotIdx += 1;
        return { data } as T;
      }
      return { data: 'screenshot-base64' } as T;
    }
    return {} as T;
  }
}

/** 让实时循环的分离(void)执行有机会跑完：注入 sleep 立即 resolve，靠 microtask flush 推进到 maxFrames 上界。 */
async function drainLiveLoop(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

/** 递增时钟：每次 now() 前进 step，供最小推帧间隔地板判定用（恒定 now 会让 tooSoon 恒真、永不推）。 */
function steppingClock(start = 1000, step = 1000): () => number {
  let t = start - step;
  return () => (t += step);
}

/** 递增 snapshotId，测试帧环按 id 命中。 */
function seqIdGen(prefix = 'snap'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

class FakeMonitor implements OverlayMonitor {
  readonly state: OverlayKind = 'captcha';
  constructor(private readonly probes: OverlayKind[]) {}
  async probeNow(): Promise<OverlayKind> {
    return this.probes.shift() ?? 'captcha';
  }
  start(): void {}
  stop(): void {}
}

class FakeClient {
  readonly sent: Array<{ type: MessageType; payload: unknown; id?: string }> = [];
  send<T>(type: MessageType, payload: T, id?: string): void {
    this.sent.push({ type, payload, id });
  }
}

test('captcha assist capture: fresh blocking overlay → cropped screenshot snapshot', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    getAccountId: () => 'acc-1',
    overlayMonitor: new FakeMonitor(['captcha']),
    now: () => 1000,
    idGen: () => 'snap-1',
    sleep: async () => {},
    logger: () => {},
  });

  await handler.handle('captcha.assist.capture', { incidentId: 'cap-1', reason: 'refresh', quality: 80 });

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].type, 'captcha.assist.snapshot');
  const snapshot = client.sent[0].payload as {
    snapshotId: string;
    edgeId: string;
    accountId: string;
    crop: { x: number; y: number; width: number; height: number };
    image: { mime: string; data: string };
  };
  assert.equal(snapshot.snapshotId, 'snap-1');
  assert.equal(snapshot.edgeId, 'edge-1');
  assert.equal(snapshot.accountId, 'acc-1');
  assert.deepEqual(snapshot.crop, { x: 76, y: 76, width: 248, height: 148 });
  assert.equal(snapshot.image.mime, 'image/jpeg');
  assert.equal(snapshot.image.data, 'screenshot-base64');
  const screenshotCall = cdp.calls.find((call) => call.method === 'Page.captureScreenshot');
  assert.deepEqual((screenshotCall?.params?.clip as Record<string, unknown>), { x: 76, y: 76, width: 248, height: 148, scale: 1 });
});

test('captcha assist capture: fresh probe says not blocked → not_blocked + risk.captcha_cleared', async () => {
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp: new FakeCdp(),
    client,
    edgeId: 'edge-1',
    getAccountId: () => 'acc-1',
    overlayMonitor: new FakeMonitor(['none']),
    now: () => 2000,
    sleep: async () => {},
    logger: () => {},
  });

  await handler.handle('captcha.assist.capture', { incidentId: 'cap-2' });

  assert.deepEqual(client.sent.map((item) => item.type), ['captcha.assist.click_result', 'risk.captcha_cleared']);
  assert.equal((client.sent[0].payload as { status: string }).status, 'not_blocked');
});

test('captcha assist click: normalized points map to viewport coordinates and cleared emits risk.captcha_cleared', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    getAccountId: () => 'acc-1',
    overlayMonitor: new FakeMonitor(['captcha', 'none']),
    now: () => 3000,
    idGen: () => 'snap-click',
    sleep: async () => {},
    logger: () => {},
    // 确定性随机源：0.5 → symmetric=0（jitter 无位移）且 0.5≥overshootProb（关 overshoot），落点精确。
    random: () => 0.5,
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'cap-3', quality: 80 });
  client.sent.length = 0;

  await handler.handle('captcha.assist.click', {
    incidentId: 'cap-3',
    snapshotId: 'snap-click',
    points: [{ x: 0.5, y: 0.5 }],
    settleMs: 1,
  });

  const pressed = cdp.calls.find(
    (call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed',
  );
  assert.equal(pressed?.params?.x, 200);
  assert.equal(pressed?.params?.y, 150);
  assert.deepEqual(client.sent.map((item) => item.type), ['captcha.assist.click_result', 'risk.captcha_cleared']);
  assert.equal((client.sent[0].payload as { status: string }).status, 'cleared');
});

// ── 实时抓帧循环（change captcha-assist-live-snapshot）─────────────────────────

test('live capture: 内容不变时去重、只推首帧；循环按 maxFrames 有界终止', async () => {
  // 同一张截图反复出现 → 首帧后每 tick 内容不变 → 去重不推。maxFrames=3 → 恰好 3 次 tick 后停。
  const cdp = new FakeCdp({ screenshots: ['same', 'same', 'same', 'same'] });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    overlayMonitor: new FakeMonitor([]), // 永远 'captcha'（仍被挡）
    now: steppingClock(),
    idGen: seqIdGen(),
    sleep: async () => {},
    logger: () => {},
  });

  await handler.handle('captcha.assist.capture', {
    incidentId: 'live-1',
    quality: 80,
    live: { intervalMs: 600, maxDurationMs: 100000, maxFrames: 3 },
  });
  await drainLiveLoop();

  // 只推了首帧（内容去重挡掉后续同帧）。
  const snapshots = client.sent.filter((s) => s.type === 'captcha.assist.snapshot');
  assert.equal(snapshots.length, 1);
  // 有界：初始 1 次 + 3 次 tick 抓帧 = 4 次 captureScreenshot，之后停（不无限）。
  const shots = cdp.calls.filter((c) => c.method === 'Page.captureScreenshot');
  assert.equal(shots.length, 4);
});

test('live capture: 画面变化时推新帧（新 snapshotId）', async () => {
  const cdp = new FakeCdp({ screenshots: ['f0', 'f1', 'f2', 'f3'] });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    overlayMonitor: new FakeMonitor([]),
    now: steppingClock(),
    idGen: seqIdGen(),
    sleep: async () => {},
    logger: () => {},
  });

  await handler.handle('captcha.assist.capture', {
    incidentId: 'live-2',
    quality: 80,
    live: { intervalMs: 600, maxDurationMs: 100000, maxFrames: 3 },
  });
  await drainLiveLoop();

  const snapshots = client.sent.filter((s) => s.type === 'captcha.assist.snapshot');
  // 首帧 f0 + 3 次变化帧 f1/f2/f3 = 4 帧，snapshotId 各不相同。
  assert.equal(snapshots.length, 4);
  const ids = snapshots.map((s) => (s.payload as { snapshotId: string }).snapshotId);
  assert.equal(new Set(ids).size, 4);
});

test('live capture: 自主判清除需连续 K 次无遮罩，且只发 risk.captcha_cleared（不发 click_result）', async () => {
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp: new FakeCdp({ screenshots: ['x'] }),
    client,
    edgeId: 'edge-1',
    // 初始 'captcha'（进循环），随后连续 3 次 'none'（第 3 次才判清除）。
    overlayMonitor: new FakeMonitor(['captcha', 'none', 'none', 'none']),
    now: steppingClock(),
    idGen: seqIdGen(),
    sleep: async () => {},
    logger: () => {},
  });

  await handler.handle('captcha.assist.capture', {
    incidentId: 'live-3',
    quality: 80,
    live: { intervalMs: 600, maxDurationMs: 100000, maxFrames: 5 },
  });
  await drainLiveLoop();

  const types = client.sent.map((s) => s.type);
  // 首帧 snapshot + 自主清除 risk.captcha_cleared；绝无 click_result（自主探测不污染运营复检记录）。
  assert.deepEqual(types, ['captcha.assist.snapshot', 'risk.captcha_cleared']);
  assert.equal(types.filter((t) => t === 'captcha.assist.click_result').length, 0);
});

test('live capture: 连续无遮罩不足 K 次不清除', async () => {
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp: new FakeCdp({ screenshots: ['x'] }),
    client,
    edgeId: 'edge-1',
    // 初始 'captcha'，随后仅 2 次 'none'（< K=3）→ 不清除。
    overlayMonitor: new FakeMonitor(['captcha', 'none', 'none']),
    now: steppingClock(),
    idGen: seqIdGen(),
    sleep: async () => {},
    logger: () => {},
  });

  await handler.handle('captcha.assist.capture', {
    incidentId: 'live-4',
    quality: 80,
    live: { intervalMs: 600, maxDurationMs: 100000, maxFrames: 2 },
  });
  await drainLiveLoop();

  assert.equal(client.sent.filter((s) => s.type === 'risk.captcha_cleared').length, 0);
});

test('帧环：点击稍旧但仍在环内的 snapshotId 被接受；不在环内的判 stale_snapshot', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 }, screenshots: ['a', 'b'] });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    overlayMonitor: new FakeMonitor([]),
    now: steppingClock(),
    idGen: seqIdGen(), // snap-1 (首帧), snap-2 (实时新帧)
    sleep: async () => {},
    logger: () => {},
    random: () => 0.5, // 精确落点（见上）
  });

  await handler.handle('captcha.assist.capture', {
    incidentId: 'ring-1',
    quality: 80,
    live: { intervalMs: 600, maxDurationMs: 100000, maxFrames: 1 },
  });
  await drainLiveLoop();
  client.sent.length = 0;
  cdp.calls.length = 0;

  // 环内已有 snap-1(旧) 与 snap-2(最新)。点稍旧的 snap-1 → 应被接受、正常派发点击。
  await handler.handle('captcha.assist.click', {
    incidentId: 'ring-1',
    snapshotId: 'snap-1',
    points: [{ x: 0.5, y: 0.5 }],
    settleMs: 1,
  });
  const pressed = cdp.calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
  assert.ok(pressed, '稍旧但在环内的 snapshotId 应被接受并派发点击');
  assert.equal(pressed?.params?.x, 200);

  client.sent.length = 0;
  // 不在环内的 snapshotId → stale_snapshot（诚实回执，不盲点）。
  await handler.handle('captcha.assist.click', {
    incidentId: 'ring-1',
    snapshotId: 'snap-999',
    points: [{ x: 0.5, y: 0.5 }],
  });
  assert.equal((client.sent[0].payload as { status: string }).status, 'stale_snapshot');
});

// ── 拟人注入（change captcha-assist-humanize-click）─────────────────────────────

test('拟人注入：多点连续光标（下点从上点真实落点起步）+ press 数==落点数 + 有 mouseMoved 轨迹', async () => {
  // crop = {76,76,248,148}。A(0.25,0.25)→(138,113)，B(0.75,0.75)→(262,187)。random=0.5 → jitter 无位移、关 overshoot。
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    overlayMonitor: new FakeMonitor(['captcha', 'none']),
    now: () => 5000,
    idGen: () => 'snap-mp',
    sleep: async () => {},
    logger: () => {},
    random: () => 0.5,
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'mp-1', quality: 80 });
  cdp.calls.length = 0;

  await handler.handle('captcha.assist.click', {
    incidentId: 'mp-1',
    snapshotId: 'snap-mp',
    points: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }],
    settleMs: 1,
  });

  const presses = cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
  const moves = cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseMoved');
  assert.equal(presses.length, 2, 'press 次数 == 落点数');
  assert.ok(moves.length > 0, '有 mouseMoved 轨迹（非瞬移）');
  assert.deepEqual([presses[0].params?.x, presses[0].params?.y], [138, 113]);
  assert.deepEqual([presses[1].params?.x, presses[1].params?.y], [262, 187]);
  // 第二点应从上一真实落点 (138,113) 起步（光标连续），而非默认远起点。
  const firstReleaseIdx = cdp.calls.findIndex((c) => c.params?.type === 'mouseReleased');
  const nextMove = cdp.calls.slice(firstReleaseIdx + 1).find((c) => c.params?.type === 'mouseMoved');
  assert.deepEqual([nextMove?.params?.x, nextMove?.params?.y], [138, 113], '第二点从上一真实落点起步');
});

test('拟人注入：真实随机源下落点仍落在 target±jitter 容差内（jitter 有界不脱靶）', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-xyz',
    overlayMonitor: new FakeMonitor(['captcha', 'none']),
    now: () => 6000,
    idGen: () => 'snap-tol',
    sleep: async () => {},
    logger: () => {},
    // 不注入 random → 用真实 Math.random（非退化）。
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'tol-1', quality: 80 });
  await handler.handle('captcha.assist.click', {
    incidentId: 'tol-1',
    snapshotId: 'snap-tol',
    points: [{ x: 0.5, y: 0.5 }], // → (200,150)
    settleMs: 1,
  });
  const pressed = cdp.calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
  // jitter=2 → 落点在 target ± 2px 内（overshoot 是中间点、不改最终 press 落点）。
  assert.ok(Math.abs((pressed?.params?.x as number) - 200) <= 2, `x 应在 200±2，实为 ${pressed?.params?.x}`);
  assert.ok(Math.abs((pressed?.params?.y as number) - 150) <= 2, `y 应在 150±2，实为 ${pressed?.params?.y}`);
});
