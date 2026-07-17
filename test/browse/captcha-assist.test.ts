import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaAssistHandler } from '../../src/browse/captcha-assist.js';
import type { BrowseCdp, OverlayKind, OverlayMonitor } from '../../src/browse/index.js';
import type { MessageType } from '../../src/comm/protocol.js';

class FakeCdp implements BrowseCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  /** 当前视口 URL（回放前复检据此判断页面是否被导航走；测试可在 click 前改它）。 */
  viewportUrl = 'https://xhs.test/explore';
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
        return { result: { value: { width: 1000, height: 800, deviceScaleFactor: 2, url: this.viewportUrl } } } as T;
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

// 手动刷新的单次 probe 未见遮罩 → 只回 not_blocked，**绝不发 risk.captcha_cleared**。
// 它与实时循环共用「旧挑战已消失、新挑战未绘出」的瞬时无遮罩窗口，却既无 settle 也无连续确认；
// 据此上报即提前解 restricted（自残）。恢复交由 liveTick 的 K=3 或旁路监测体的翻转闸。
test('captcha assist capture: fresh probe says not blocked → 只回 not_blocked，绝不发 risk.captcha_cleared', async () => {
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

  assert.deepEqual(client.sent.map((item) => item.type), ['captcha.assist.click_result']);
  assert.equal((client.sent[0].payload as { status: string }).status, 'not_blocked');
});

// 注入期不抓帧：此刻画面是派发到一半的半程状态（点了一半 / 打了一半的框），回传给运营毫无价值。
// 这是互斥闸**独有**的职责——「不由半程 probe 误发 cleared」已由 handleCapture 根本不发 cleared 保证
// （见上一个用例），不需要也不该靠互斥闸来兜。
test('captcha assist capture: 注入进行中 → 跳过抓帧，绝不回传半程画面', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  // 全程 captcha：让点击以 still_blocked 收尾，从而把「有没有多出一帧 snapshot」这个判据留干净——
  // 互斥闸若失效，并发 capture 会多推一条 captcha.assist.snapshot。
  const monitor = new FakeMonitor(['captcha', 'captcha', 'captcha', 'captcha']);
  let concurrentCapture: Promise<void> | undefined;
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    getAccountId: () => 'acc-1',
    overlayMonitor: monitor,
    now: () => 3000,
    idGen: () => 'snap-mutex',
    // 在注入的停顿点插入一次并发 capture —— 模拟运营在点击/键入途中手点「刷新」。
    sleep: async () => {
      if (!concurrentCapture) {
        concurrentCapture = handler.handle('captcha.assist.capture', { incidentId: 'cap-mutex' });
      }
    },
    logger: () => {},
    random: () => 0.5,
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'cap-mutex' });
  client.sent.length = 0;

  await handler.handle('captcha.assist.click', {
    incidentId: 'cap-mutex',
    snapshotId: 'snap-mutex',
    points: [{ x: 0.5, y: 0.5 }],
    settleMs: 1,
  });
  await concurrentCapture;

  // 并发 capture 被互斥闸挡下 ⇒ 注入期零 snapshot 推送。
  // （still_blocked 的新帧是随 click_result 载荷回带的，不是独立的 snapshot 消息。）
  assert.equal(
    client.sent.filter((item) => item.type === 'captcha.assist.snapshot').length,
    0,
    '注入期 MUST NOT 推送半程画面',
  );
  assert.deepEqual(client.sent.map((item) => item.type), ['captcha.assist.click_result']);
  assert.equal((client.sent[0].payload as { status: string }).status, 'still_blocked');
});

test('captcha assist click: normalized points map to viewport coordinates and cleared emits risk.captcha_cleared', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    getAccountId: () => 'acc-1',
    overlayMonitor: new FakeMonitor(['captcha', 'captcha', 'none']),
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
  // 顺序不可换：cleared 承重（解除该 edge 暂停），click_result 只驱动面板。断连时 client.send 会抛，
  // 把承重的排在装饰性的之后 = 「验证码已解开」永远到不了云端、账号无限期暗停。
  assert.deepEqual(client.sent.map((item) => item.type), ['risk.captcha_cleared', 'captcha.assist.click_result']);
  assert.equal((client.sent[1].payload as { status: string }).status, 'cleared');
});

// cleared 与 click_result MUST 互不牵连：后者抛错不该让前者白发，前者抛错也不该让后者不发。
test('captcha assist click: click_result 发送抛错不影响已送达的 risk.captcha_cleared', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    getAccountId: () => 'acc-1',
    overlayMonitor: new FakeMonitor(['captcha', 'captcha', 'none']),
    now: () => 3000,
    idGen: () => 'snap-throw',
    sleep: async () => {},
    logger: () => {},
    random: () => 0.5,
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'cap-throw' });
  client.sent.length = 0;
  // cleared 正常送达后，让 click_result 的发送抛错（模拟 socket 在两帧之间断掉）。
  const origSend = client.send.bind(client);
  client.send = ((type: string, payload: unknown, id?: string) => {
    if (type === 'captcha.assist.click_result') throw new Error('socket closed');
    return origSend(type as never, payload as never, id);
  }) as typeof client.send;

  // 整个 handle MUST NOT 因此抛出（否则 finally 之外的调用方会把成功当异常）。
  await handler.handle('captcha.assist.click', {
    incidentId: 'cap-throw',
    snapshotId: 'snap-throw',
    points: [{ x: 0.5, y: 0.5 }],
    settleMs: 1,
  });

  // cleared 已经出去了 —— 这才是解除暂停的那一条。
  assert.deepEqual(client.sent.map((item) => item.type), ['risk.captcha_cleared']);
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
    overlayMonitor: new FakeMonitor(['captcha', 'captcha', 'none']),
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
    overlayMonitor: new FakeMonitor(['captcha', 'captcha', 'none']),
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

// ── 真实轨迹回放（change captcha-assist-trajectory-replay）──────────────────────

test('轨迹回放：带有效轨迹 → click_result replayMode=trajectory，落点权威 (200,150)', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } }); // crop {76,76,248,148}
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    overlayMonitor: new FakeMonitor(['captcha', 'captcha', 'none']),
    now: () => 7000,
    idGen: () => 'snap-traj',
    sleep: async () => {},
    logger: () => {},
    random: () => 0.5,
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'traj-1', quality: 80 });
  cdp.calls.length = 0;
  client.sent.length = 0;

  await handler.handle('captcha.assist.click', {
    incidentId: 'traj-1',
    snapshotId: 'snap-traj',
    points: [{ x: 0.5, y: 0.5 }],
    settleMs: 1,
    trajectory: { v: 1, samples: [{ x: 0.1, y: 0.1, t: 0 }, { x: 0.9, y: 0.9, t: 100 }], clicks: [1] },
  });

  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as { status: string; replayMode?: string };
  assert.equal(result.replayMode, 'trajectory');
  assert.equal(result.status, 'cleared');
  const pressed = cdp.calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
  assert.equal(pressed?.params?.x, 200);
  assert.equal(pressed?.params?.y, 150);
});

test('轨迹回放：畸形轨迹（clicks 长度不符）→ 诚实回落合成，replayMode=synthetic', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const logs: string[] = [];
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    overlayMonitor: new FakeMonitor(['captcha', 'captcha', 'none']),
    now: () => 8000,
    idGen: () => 'snap-bad',
    sleep: async () => {},
    logger: (m) => logs.push(m),
    random: () => 0.5,
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'bad-1', quality: 80 });
  client.sent.length = 0;

  await handler.handle('captcha.assist.click', {
    incidentId: 'bad-1',
    snapshotId: 'snap-bad',
    points: [{ x: 0.5, y: 0.5 }],
    settleMs: 1,
    // clicks 长度 2 ≠ 点数 1 → 无效 → 回落合成。
    trajectory: { v: 1, samples: [{ x: 0.1, y: 0.1, t: 0 }], clicks: [0, 0] },
  });

  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as { replayMode?: string };
  assert.equal(result.replayMode, 'synthetic', '畸形轨迹应回落合成');
  assert.ok(logs.some((l) => l.includes('轨迹无效')), '丢弃轨迹应可观测（有日志）');
});

// ── 回放前强制复检（change lease-strict-preemption 5.7）─────────────────────────

test('回放前复检：阻断已自行消失 → 只回 not_blocked（不发 cleared），绝不派发盲点', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    // capture='captcha'（抓帧存快照）；运营看图期间阻断消失，click 回放前复检探到 'none'。
    overlayMonitor: new FakeMonitor(['captcha', 'none']),
    now: () => 9000,
    idGen: () => 'snap-stale',
    sleep: async () => {},
    logger: () => {},
    random: () => 0.5,
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'stale-1', quality: 80 });
  client.sent.length = 0;
  cdp.calls.length = 0;

  await handler.handle('captcha.assist.click', {
    incidentId: 'stale-1',
    snapshotId: 'snap-stale',
    points: [{ x: 0.5, y: 0.5 }],
    settleMs: 1,
  });

  // 这是「未经注入的单次 probe」：无 settle、无连续确认，与手动刷新同类 ⇒ 绝不由它发 cleared。
  // 恢复交由旁路监测体的翻转闸（独立轮询，遮罩真消失时发配对 cleared），故不发不会滞留暂停态。
  assert.deepEqual(client.sent.map((s) => s.type), ['captcha.assist.click_result']);
  assert.equal((client.sent[0].payload as { status: string }).status, 'not_blocked');
  // 回放前就拦下：阻断已不在，绝不在（可能已是别的页面的）坐标上派发任何点击。
  const pressed = cdp.calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
  assert.equal(pressed, undefined, '阻断已消失时绝不派发点击');
});

test('回放前复检：页面已被导航走（URL 变）→ stale_snapshot + 重抓帧，绝不派发盲点', async () => {
  const cdp = new FakeCdp({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  const client = new FakeClient();
  const handler = new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-1',
    // 阻断类型全程仍是 'captcha'（没变）——只有 URL 这一路能抓出"页面被导航走"。
    overlayMonitor: new FakeMonitor([]),
    now: () => 10000,
    idGen: seqIdGen('snap'), // snap-1 (capture), snap-2 (回放前复检重抓)
    sleep: async () => {},
    logger: () => {},
    random: () => 0.5,
  });
  await handler.handle('captcha.assist.capture', { incidentId: 'moved-1', quality: 80 });
  client.sent.length = 0;
  cdp.calls.length = 0;
  // 运营看图期间页面被导航到发布编辑页。
  cdp.viewportUrl = 'https://xhs.test/publish/publish';

  await handler.handle('captcha.assist.click', {
    incidentId: 'moved-1',
    snapshotId: 'snap-1',
    points: [{ x: 0.5, y: 0.5 }],
    settleMs: 1,
  });

  const types = client.sent.map((s) => s.type);
  assert.ok(types.includes('captcha.assist.snapshot'), '页面变了应重抓帧让运营在新帧上重标');
  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as { status: string };
  assert.equal(result.status, 'stale_snapshot');
  const pressed = cdp.calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
  assert.equal(pressed, undefined, 'URL 变了时绝不派发点击');
});

// ── §5 键入答案链路（change captcha-assist-text-answer）──────────────────────────

/**
 * 键入链路专用 CDP：在 FakeCdp（截图 / 遮罩 DOM / 视口）基础上加焦点探针、字段回读、键事件计数。
 * 字段内容用有状态模型（clear 置空、每字符追加、Backspace 全删）——回读随之演进，解耦于调用次数。
 */
class TypeCdp extends FakeCdp {
  readonly keyEvents: Array<{ type?: string; key?: string; code?: string; text?: string }> = [];
  mousePressed = 0;
  clearCount = 0;
  /** probeFocus 每次调用的返回；用尽后回落 lastFocus（默认可编辑）。 */
  focusQueue: Array<{ tier: string; tag: string }> = [];
  private lastFocus = { tier: 'editable', tag: 'INPUT' };
  private fieldValue = '';
  private selected = false;

  constructor() {
    super({ overlayRect: { x: 100, y: 100, width: 200, height: 100 } });
  }

  override async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === 'Input.dispatchKeyEvent') {
      const ev = {
        type: params?.type as string,
        key: params?.key as string,
        code: params?.code as string,
        text: params?.text as string | undefined,
      };
      this.keyEvents.push(ev);
      if (ev.type === 'keyDown' && ev.code === 'Backspace' && this.selected) {
        this.fieldValue = '';
        this.selected = false;
      } else if (ev.type === 'keyDown' && ev.text !== undefined && ev.code !== 'Enter' && ev.code !== 'Backspace' && ev.key && ev.key.length === 1) {
        this.fieldValue += ev.key;
      }
      return {} as T;
    }
    if (method === 'Input.dispatchMouseEvent') {
      if (params?.type === 'mousePressed') this.mousePressed += 1;
      return {} as T;
    }
    if (method === 'Runtime.evaluate') {
      const expr = String(params?.expression ?? '');
      if (expr.includes("editable ? 'editable'")) {
        const f = this.focusQueue.length ? this.focusQueue.shift()! : this.lastFocus;
        this.lastFocus = f;
        return { result: { value: f } } as T;
      }
      if (expr.includes("typeof el.value === 'string'")) {
        return { result: { value: { text: this.fieldValue } } } as T;
      }
      if (expr.includes("typeof el.select === 'function'")) {
        this.selected = true;
        this.clearCount += 1;
        return { result: { value: true } } as T;
      }
    }
    return super.send<T>(method, params);
  }

  /** 实际派发的可见字符数（keyDown 带 text、非 Enter/Backspace）。 */
  typedChars(): number {
    return this.keyEvents.filter((e) => e.type === 'keyDown' && e.text !== undefined && e.code !== 'Enter' && e.code !== 'Backspace').length;
  }
  enterPressed(): boolean {
    return this.keyEvents.some((e) => e.type === 'keyDown' && e.code === 'Enter');
  }
}

/** 按调用次数投放 probe 结果，用尽后按配置抛错（模拟 Enter 提交导航期 probe 打不到页面）。 */
class ScriptedMonitor implements OverlayMonitor {
  readonly state: OverlayKind = 'captcha';
  private n = 0;
  constructor(private readonly script: OverlayKind[], private readonly throwAfter = Infinity) {}
  async probeNow(): Promise<OverlayKind> {
    const i = this.n++;
    if (i >= this.throwAfter) throw new Error('probe_navigation_in_flight');
    return this.script[i] ?? 'captcha';
  }
  start(): void {}
  stop(): void {}
}

/** 先 capture 播一帧进环，返回 snapshotId 供 click 引用。 */
async function seedSnapshot(handler: CaptchaAssistHandler, client: FakeClient, incidentId: string, snapshotId: string): Promise<void> {
  await handler.handle('captcha.assist.capture', { incidentId, quality: 80 });
  client.sent.length = 0;
  void snapshotId;
}

function makeTypeHandler(cdp: TypeCdp, client: FakeClient, monitor: OverlayMonitor, extra: Record<string, unknown> = {}): CaptchaAssistHandler {
  return new CaptchaAssistHandler({
    cdp,
    client,
    edgeId: 'edge-type',
    getAccountId: () => 'acc-1',
    overlayMonitor: monitor,
    now: () => 5000,
    idGen: seqIdGen('snap'),
    sleep: async () => {},
    logger: () => {},
    random: () => 0.5,
    ...extra,
  });
}

test('键入：可编辑焦点 → 打字 + 回车 → 遮罩清除 ⇒ cleared + risk.captcha_cleared + typeReport 齐全', async () => {
  const cdp = new TypeCdp();
  const client = new FakeClient();
  // capture / stale / recheck#1 / recheck#2 = captcha；提交后复检 = none。
  const handler = makeTypeHandler(cdp, client, new ScriptedMonitor(['captcha', 'captcha', 'captcha', 'captcha', 'none']));
  await seedSnapshot(handler, client, 'inc-ok', 'snap-1');

  await handler.handle('captcha.assist.click', {
    incidentId: 'inc-ok',
    snapshotId: 'snap-1',
    points: [{ x: 0.5, y: 0.5 }],
    text: 'AB3x',
    submit: 'enter',
    settleMs: 1,
  });

  assert.equal(cdp.typedChars(), 4, '恰好派发 4 个可见字符');
  assert.ok(cdp.enterPressed(), '带 submit=enter 应按回车');
  const types = client.sent.map((s) => s.type);
  assert.ok(types.includes('risk.captcha_cleared'), '解开后必须发 risk.captcha_cleared');
  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as {
    status: string; inputMode: string; typeReport: { focus: string; typed: number; verified: string; submitted: boolean };
  };
  assert.equal(result.status, 'cleared');
  assert.equal(result.inputMode, 'click_type');
  assert.equal(result.typeReport.focus, 'editable');
  assert.equal(result.typeReport.typed, 4);
  assert.equal(result.typeReport.verified, 'match');
  assert.equal(result.typeReport.submitted, true);
});

test('键入：焦点没落定（none）⇒ no_target，零字符派发、绝不提交', async () => {
  const cdp = new TypeCdp();
  cdp.focusQueue = [{ tier: 'none', tag: 'BODY' }];
  const client = new FakeClient();
  const handler = makeTypeHandler(cdp, client, new ScriptedMonitor(['captcha', 'captcha', 'captcha']));
  await seedSnapshot(handler, client, 'inc-nt', 'snap-1');

  await handler.handle('captcha.assist.click', {
    incidentId: 'inc-nt', snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], text: 'ab3', submit: 'enter', settleMs: 1,
  });

  assert.equal(cdp.typedChars(), 0);
  assert.equal(cdp.enterPressed(), false);
  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as {
    status: string; reason: string; typeReport: { focus: string; typed: number; submitted: boolean };
  };
  assert.equal(result.status, 'no_target');
  assert.equal(result.reason, 'focus_not_landed');
  assert.equal(result.typeReport.typed, 0);
  assert.equal(result.typeReport.submitted, false);
});

test('键入：中途复检 #1 遮罩已不在 ⇒ cleared_mid_sequence，零字符派发', async () => {
  const cdp = new TypeCdp();
  const client = new FakeClient();
  // capture=captcha, stale=captcha, recheck#1=none（聚焦点击把遮罩解了）。
  const handler = makeTypeHandler(cdp, client, new ScriptedMonitor(['captcha', 'captcha', 'none']));
  await seedSnapshot(handler, client, 'inc-mid', 'snap-1');

  await handler.handle('captcha.assist.click', {
    incidentId: 'inc-mid', snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], text: 'ab3', submit: 'enter', settleMs: 1,
  });

  assert.equal(cdp.typedChars(), 0, '复检 #1 触发即零字符');
  const types = client.sent.map((s) => s.type);
  assert.ok(types.includes('risk.captcha_cleared'));
  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as { status: string; reason: string };
  assert.equal(result.status, 'cleared');
  assert.equal(result.reason, 'cleared_mid_sequence');
});

test('键入：被抢占 ⇒ typed<len + 清场 + 未提交（reason takeover_during_type）', async () => {
  const cdp = new TypeCdp();
  const client = new FakeClient();
  const handler = makeTypeHandler(cdp, client, new ScriptedMonitor(['captcha', 'captcha', 'captcha']), {
    // 前 2 次 checkpoint 持有租约，第 3 个字符前被接管。
    checkTaskLease: (() => { let n = 0; return () => n++ < 2; })(),
    touchTaskLease: () => {},
  });
  await seedSnapshot(handler, client, 'inc-pre', 'snap-1');

  await handler.handle('captcha.assist.click', {
    incidentId: 'inc-pre', snapshotId: 'snap-1', taskId: 'task-1', points: [{ x: 0.5, y: 0.5 }], text: 'abcde', submit: 'enter', settleMs: 1,
  });

  assert.equal(cdp.typedChars(), 2, '恰好派发 2 个字符后被接管');
  assert.equal(cdp.enterPressed(), false, '被抢占后绝不提交');
  assert.ok(cdp.clearCount >= 2, '键入前清空 + 被抢占后清场 ⇒ 至少两次清空');
  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as {
    status: string; reason: string; typeReport: { typed: number; submitted: boolean };
  };
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'takeover_during_type');
  assert.equal(result.typeReport.typed, 2, '如实回报已派发数，绝不回退到意图长度');
  assert.equal(result.typeReport.submitted, false);
});

test('键入：Enter 提交后复检连抛 ⇒ verdict_unavailable_after_submit（不是 click_failed）', async () => {
  const cdp = new TypeCdp();
  const client = new FakeClient();
  // 前 4 次 probe（capture/stale/recheck1/recheck2）返回 captcha，之后全抛（模拟导航期打不到页面）。
  const handler = makeTypeHandler(cdp, client, new ScriptedMonitor(['captcha', 'captcha', 'captcha', 'captcha'], 4));
  await seedSnapshot(handler, client, 'inc-vu', 'snap-1');

  await handler.handle('captcha.assist.click', {
    incidentId: 'inc-vu', snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], text: 'ab3', submit: 'enter', settleMs: 1,
  });

  assert.ok(cdp.enterPressed(), '复检前已按下回车');
  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as {
    status: string; reason: string; typeReport: { submitted: boolean };
  };
  assert.equal(result.status, 'failed');
  assert.ok(result.reason.startsWith('verdict_unavailable_after_submit'), `reason 应为 verdict_unavailable_after_submit，实际 ${result.reason}`);
  assert.ok(!result.reason.includes('click_failed'), '绝不误报 click_failed');
  assert.equal(result.typeReport.submitted, true);
});

test('键入：带 text 但落点不是恰好 1 个 ⇒ 注入前拒绝（invalid_target），零点击零键入', async () => {
  const cdp = new TypeCdp();
  const client = new FakeClient();
  const handler = makeTypeHandler(cdp, client, new ScriptedMonitor(['captcha']));
  await seedSnapshot(handler, client, 'inc-shape', 'snap-1');

  await handler.handle('captcha.assist.click', {
    incidentId: 'inc-shape', snapshotId: 'snap-1', points: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.6 }], text: 'ab', submit: 'enter', settleMs: 1,
  });

  assert.equal(cdp.mousePressed, 0, '拒绝时绝不派发点击');
  assert.equal(cdp.typedChars(), 0);
  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as { status: string; reason: string };
  assert.equal(result.status, 'invalid_target');
  assert.equal(result.reason, 'text_requires_single_focus_point');
});

test('键入：表外字符 ⇒ 注入前整单拒绝（text_unsupported_char），绝不"只帮你点一下"', async () => {
  const cdp = new TypeCdp();
  const client = new FakeClient();
  const handler = makeTypeHandler(cdp, client, new ScriptedMonitor(['captcha']));
  await seedSnapshot(handler, client, 'inc-cs', 'snap-1');

  await handler.handle('captcha.assist.click', {
    incidentId: 'inc-cs', snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], text: '验证', submit: 'enter', settleMs: 1,
  });

  assert.equal(cdp.mousePressed, 0);
  assert.equal(cdp.typedChars(), 0);
  const result = client.sent.find((s) => s.type === 'captcha.assist.click_result')!.payload as { status: string; reason: string };
  assert.equal(result.status, 'invalid_target');
  assert.equal(result.reason, 'text_unsupported_char');
});
