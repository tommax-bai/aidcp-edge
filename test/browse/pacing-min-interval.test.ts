import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowseSession, type BrowseSessionDeps, type BrowseSessionOptions } from '../../src/browse/browse-session.js';
import type { FeedScroller, NoteCard } from '../../src/browse/feed-scroller.js';
import type { ModalController } from '../../src/browse/modal-controller.js';
import type { NoteContent } from '../../src/browse/note-extractor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import {
  makeEnvelope,
  type Envelope,
  type NoteContentPayload,
  type NoteDetailPayload,
  type PacingOp,
  type PacingFloorPayload,
} from '../../src/comm/protocol.js';
import type { PlanStep, ActionResultPayload } from '../../src/comm/protocol.js';

/**
 * 最小间隔 gating 针对性测试（pacing-floor-config-min-interval 设计 §6/§7 红线）。
 *
 * 关键手法：注入**可控递增的 monoNow**（别用真实时钟）+ 记录 sleep 时长的 sleep 桩 + 恒 1.0 的疲劳曲线，
 * 用**退化区间** {minMs:X,maxMs:X} 让 effectiveFloor 反射采样确定性返回 X，从而 gate 待等 = X − elapsed 可精确断言。
 * 驱动路径：两条 `note.open`（首条锚点为 null 跳过间隔、记账；次条走 gate('action') 被测量），间隔改 monoNow 控 elapsed。
 */

const CARD: NoteCard = { position: 0, centerX: 10, centerY: 10, title: 'A', author: 'u', likes: '100', isVideo: false };

function fakeContent(): NoteContent {
  return { title: 'A', body: 'b', author: 'u', likes: 1, collects: 0, comments: 0, tags: [], images: [], isLiked: false };
}

interface Harness {
  deps: BrowseSessionDeps;
  detailCount: () => number;
}

function makeHarness(): Harness {
  let details = 0;
  const scroller: FeedScroller = {
    getVisibleCards: async () => [CARD],
    scrollNext: async () => {},
    openCard: async () => {},
  };
  const modalCtrl: ModalController = {
    isModalOpen: async () => true,
    closeModal: async () => {},
    waitForModal: async () => true,
  };
  const cdp: BrowseCdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        // waitForNoteBody 渲染门：正文已渲染 → 立即返回（否则真实时钟轮询会空转满 3.5s，拖慢测试）。
        if (expr.includes('.trim().length>=3')) return { result: { value: true } } as never;
        if (expr.includes('collect-wrapper') || expr.includes('engage-bar')) return { result: { value: true } } as never;
        if (expr.includes('note-item')) return { result: { value: 10 } } as never;
        return { result: { value: 'https://www.xiaohongshu.com/explore' } } as never;
      }
      return {} as never;
    },
  };
  const client = {
    reportNoteContent: async (_p: NoteContentPayload): Promise<Envelope> => makeEnvelope('session.end', 'ack', 0, { reason: 'ack' }),
    reportPageCards: () => {},
    reportNoteDetail: (_p: NoteDetailPayload) => { details++; },
    reportProfileDetail: () => {},
    reportActionCompleted: () => {},
  };
  const stepRunner = {
    run: async (step: PlanStep): Promise<ActionResultPayload> => ({ actionId: step.actionId, ok: true, outcome: 'success', attempts: 1, reason: 'ok' }),
  };
  const deps: BrowseSessionDeps = {
    dom: { getRoot: () => ({}) as unknown as Document },
    cdp,
    client,
    scroller,
    noteExtractor: (async () => fakeContent()) as unknown as BrowseSessionDeps['noteExtractor'],
    modalCtrl,
    stepRunner,
  };
  return { deps, detailCount: () => details };
}

/** 可控单调时钟：测试逐步 set t，命令处理期间保持常量。 */
interface Mono { t: number }

function baseOpts(sleeps: number[], mono: Mono, opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>, tempo?: number): BrowseSessionOptions {
  return {
    random: () => 0.5,
    sleep: async (ms: number) => { sleeps.push(ms); },
    logger: () => {},
    monoNow: () => mono.t,
    rhythm: { getSpeedFactor: () => 1 }, // 恒 1.0 疲劳 → 隔离 floor 逻辑，effectiveFloor 不被曲线缩放
    opFloorsMs,
    tempo,
  };
}

async function tick(ms = 25): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** 等到 note.detail 上报数达到 want（确保上一条 note.open 已完整处理并记账，再推进时钟）。 */
async function waitDetails(h: Harness, want: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (h.detailCount() < want) {
    if (Date.now() - start > timeoutMs) throw new Error(`等 note.detail=${want} 超时（当前 ${h.detailCount()}）`);
    await tick(5);
  }
}

/**
 * 驱动「note.open(锚) → [设 elapsed] → note.open(测) → session.end」。
 * 返回**第二条 note.open 的 gate 待等**（= 两条 note.detail 之间新增的、且 ≥ 1000 的最大 sleep；
 * 排除首条前的 scanDelay/轮询噪声，第二条 gate 是此后唯一的秒级停顿）。
 */
async function driveTwoOpens(
  h: Harness,
  sleeps: number[],
  mono: Mono,
  firstMono: number,
  gateMono: number,
  secondThinkMs?: number,
): Promise<number[]> {
  const sess = new BrowseSession(h.deps, baseOpts(sleeps, mono));
  mono.t = firstMono;
  const done = sess.start();
  await tick(30);
  // 第一条 note.open：锚点 null → gate 跳过；处理后记账 lastActionEndAt = firstMono。
  await sess.onCloudCommand(makeEnvelope('note.open', 'o1', 0, { index: 0 }));
  await waitDetails(h, 1);
  const before = sleeps.length;
  // 推进单调时钟 → 控制第二条的 elapsed = gateMono − firstMono。
  mono.t = gateMono;
  await sess.onCloudCommand(makeEnvelope('note.open', 'o2', 0, { index: 0, thinkMs: secondThinkMs }));
  await waitDetails(h, 2);
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  return sleeps.slice(before);
}

/** 同 driveTwoOpens，但用注入 opFloorsMs 构造（走构造期注入路径）。 */
async function driveWithSnapshot(
  h: Harness,
  sleeps: number[],
  mono: Mono,
  opFloorsMs: Partial<Record<PacingOp, PacingFloorPayload>>,
  firstMono: number,
  gateMono: number,
  tempo?: number,
): Promise<number[]> {
  const sess = new BrowseSession(h.deps, baseOpts(sleeps, mono, opFloorsMs, tempo));
  mono.t = firstMono;
  const done = sess.start();
  await tick(30);
  await sess.onCloudCommand(makeEnvelope('note.open', 'o1', 0, { index: 0 }));
  await waitDetails(h, 1);
  const before = sleeps.length;
  mono.t = gateMono;
  await sess.onCloudCommand(makeEnvelope('note.open', 'o2', 0, { index: 0 }));
  await waitDetails(h, 2);
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  return sleeps.slice(before);
}

// ============ 红线 1：非默认 floor 真被读到（字段真到边缘 gate）============

test('min-interval: 云端下发非默认 floor → gate 实测间隔命中该值而非内置', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  // 退化区间 {12000,12000} → 反射采样确定性 12000；elapsed = 3000−1000 = 2000 → gate 待等 = 10000。
  const gateSleeps = await driveWithSnapshot(h, sleeps, mono, { action: { minMs: 12000, maxMs: 12000 } }, 1000, 3000);
  assert.ok(gateSleeps.includes(10000), `gate 应等 floor(12000)−elapsed(2000)=10000（非内置 action~2500），实际: ${gateSleeps}`);
  // 内置 action 默认 max 4000，绝不可能产出 10000 → 证明非默认字段真被读到。
});

test('min-interval: 未下发 pacing（内置默认）→ gate 命中内置 action 量级、绝非 10000', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  const gateSleeps = await driveTwoOpens(h, sleeps, mono, 1000, 1000); // elapsed=0 → 待等=内置 floor
  const big = gateSleeps.filter((x) => x >= 1000);
  assert.ok(big.length >= 1, `应有一次内置 floor 兜底停顿，实际: ${gateSleeps}`);
  // 内置 action 采样恒 ≤ 4000（clamp 上界），绝无 10000（对照上一个非默认用例，坐实字段确被读取）。
  assert.ok(!gateSleeps.some((x) => x > 6000), `内置默认不应产出 >6000 的间隔，实际: ${gateSleeps}`);
});

// ============ 红线 2：配 0/负数经三道夹后实测间隔仍 ≥ 防呆下限（绝不零延迟）============

test('min-interval: 配极小 floor（远低于防呆下限）→ 边缘二次夹抬到防呆下限 800、不塌零', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  // 恶意极小配置 {10,20}（psql 直插绕面板）；elapsed=0 → 待等 = 夹后 floor。edge clamp 下界 action=800。
  const gateSleeps = await driveWithSnapshot(h, sleeps, mono, { action: { minMs: 10, maxMs: 20 } }, 1000, 1000);
  assert.ok(gateSleeps.includes(800), `极小配置应被夹到防呆下限 800，实际: ${gateSleeps}`);
  assert.ok(!gateSleeps.some((x) => x > 0 && x < 800 && x >= 10 && x <= 20), `绝不出现未夹的 [10,20] 原值`);
});

test('min-interval: 配 0/负数 → 逐字段回落内置默认（非零），实测间隔 ≥ 防呆下限', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  // minMs=0 / maxMs=-5 均非正 → 逐字段回落 BUILTIN action{1500,4000}；elapsed=0 → 待等 = 内置采样值。
  const gateSleeps = await driveWithSnapshot(h, sleeps, mono, { action: { minMs: 0, maxMs: -5 } }, 1000, 1000);
  const floors = gateSleeps.filter((x) => x >= 800);
  assert.ok(floors.length >= 1, `0/负数应回落内置非零默认，实际: ${gateSleeps}`);
  assert.ok(floors.every((x) => x >= 1500 && x <= 4000), `应落在内置 action[1500,4000] 区间（证明回落而非夹到 800），实际: ${floors}`);
});

// ============ 红线 3：云端慢回不额外 sleep、不塌零；think 与间隔用 max 非 + ============

test('min-interval: 云端慢回（elapsed ≥ floor）→ gate 不额外 sleep、不塌零', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  // floor=12000，但 elapsed = 60000−1000 = 59000 ≫ floor → remaining=0，无 think → gate 不 sleep。
  const gateSleeps = await driveWithSnapshot(h, sleeps, mono, { action: { minMs: 12000, maxMs: 12000 } }, 1000, 60000);
  assert.ok(!gateSleeps.some((x) => x >= 8000), `elapsed≥floor 时不应再等 floor 级停顿（有效间隔已由 elapsed 吸收），实际: ${gateSleeps}`);
  // 不塌零：第二条 note.open 仍执行（detailCount 已达 2，waitDetails 未超时），有效间隔=elapsed=59000>0。
  assert.equal(h.detailCount(), 2, '慢回后第二条 note.open 仍照常执行（间隔被 elapsed 吸收、非零）');
});

test('min-interval: think 与间隔取 max 非相加（remaining 主导）', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  // floor=12000, elapsed=2000 → remaining=10000; thinkMs=4000 → jitter(0.5)=~2981 < remaining。
  // wait = max(10000, 2981) = 10000（若错写成 + 则为 ~12981）。
  const sess = new BrowseSession(h.deps, baseOpts(sleeps, mono, { action: { minMs: 12000, maxMs: 12000 } }));
  mono.t = 1000;
  const done = sess.start();
  await tick(30);
  await sess.onCloudCommand(makeEnvelope('note.open', 'o1', 0, { index: 0 }));
  await waitDetails(h, 1);
  const before = sleeps.length;
  mono.t = 3000;
  await sess.onCloudCommand(makeEnvelope('note.open', 'o2', 0, { index: 0, thinkMs: 4000 }));
  await waitDetails(h, 2);
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  const gate = sleeps.slice(before);
  assert.ok(gate.includes(10000), `wait 应 = max(remaining 10000, think ~2981) = 10000，实际: ${gate}`);
  assert.ok(!gate.some((x) => x > 11000), `绝不 remaining+think(~12981)——用 max 非 +，实际: ${gate}`);
});

test('min-interval: think 主导时 wait = think（间隔较小），仍不相加', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  // floor=2000, elapsed=0 → remaining=2000; thinkMs=30000 → jitter(0.5)=~22350 ≫ remaining。
  const sess = new BrowseSession(h.deps, baseOpts(sleeps, mono, { action: { minMs: 2000, maxMs: 2000 } }));
  mono.t = 1000;
  const done = sess.start();
  await tick(30);
  await sess.onCloudCommand(makeEnvelope('note.open', 'o1', 0, { index: 0 }));
  await waitDetails(h, 1);
  const before = sleeps.length;
  mono.t = 1000; // elapsed=0
  await sess.onCloudCommand(makeEnvelope('note.open', 'o2', 0, { index: 0, thinkMs: 30000 }));
  await waitDetails(h, 2);
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  const gate = sleeps.slice(before);
  const think = Math.round(30000 * Math.exp(0.25 * gaussianAtHalf())); // 与 jitterAround(0.25, random=0.5) 同值
  assert.ok(gate.includes(think), `wait 应 = max(think ${think}, remaining 2000) = think，实际: ${gate}`);
  assert.ok(!gate.some((x) => x > think + 100), `绝不 think+remaining——用 max 非 +，实际: ${gate}`);
});

// ============ 红线 4：重连 applyPacingSnapshot 后新值生效 ============

test('min-interval: 重连 applyPacingSnapshot 后 gate 用新 floor（连接级快照重注入）', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  // 构造期用内置默认；模拟重连：applyPacingSnapshot 灌入新 floor {13000,13000}，随后 gate 应用新值。
  const sess = new BrowseSession(h.deps, baseOpts(sleeps, mono));
  sess.applyPacingSnapshot({ action: { minMs: 13000, maxMs: 13000 } }, 1.0);
  mono.t = 1000;
  const done = sess.start();
  await tick(30);
  await sess.onCloudCommand(makeEnvelope('note.open', 'o1', 0, { index: 0 }));
  await waitDetails(h, 1);
  const before = sleeps.length;
  mono.t = 1000; // elapsed=0 → 待等 = 新 floor 13000
  await sess.onCloudCommand(makeEnvelope('note.open', 'o2', 0, { index: 0 }));
  await waitDetails(h, 2);
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  const gate = sleeps.slice(before);
  assert.ok(gate.includes(13000), `applyPacingSnapshot 后 gate 应用新 floor 13000，实际: ${gate}`);
});

test('min-interval: 重连 applyPacingSnapshot 重置锚点 → 紧接动作跳过间隔（§3.2 不变量2）', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  const sess = new BrowseSession(h.deps, baseOpts(sleeps, mono, { action: { minMs: 12000, maxMs: 12000 } }));
  mono.t = 1000;
  const done = sess.start();
  await tick(30);
  // o1 建立锚点 lastActionEndAt = 1000。
  await sess.onCloudCommand(makeEnvelope('note.open', 'o1', 0, { index: 0 }));
  await waitDetails(h, 1);
  await tick(60); // 等 o1 的 markActionEnd（uplink 后记账）落定，再模拟重连——真实重连在 loop 停止后重注入、无竞争。
  // 模拟身份翻转重连：applyPacingSnapshot 重注入 + 重置锚点（页面已变、首操作跳过间隔）。
  sess.applyPacingSnapshot({ action: { minMs: 12000, maxMs: 12000 } }, 1.0);
  const before = sleeps.length;
  mono.t = 1100; // 相对旧锚点仅 elapsed=100（≪ floor）；若锚点未清则会补差额 ~11900。
  await sess.onCloudCommand(makeEnvelope('note.open', 'o2', 0, { index: 0 }));
  await waitDetails(h, 2);
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  const gate = sleeps.slice(before);
  // 锚点已清 → gate('action') 补差额=0；若未清则 remaining=floor(12000)−elapsed(100)=11900。
  // gate 仅剩 note.open 固有的秒级停顿（与锚点无关、清与不清都有）；补差额 11900 不出现即证锚点已重置。
  assert.ok(!gate.some((x) => x >= 5000), `applyPacingSnapshot 清锚点后无 gate 补差额（否则会现 ~11900），实际: ${gate}`);
});

/** 复算 jitterAround(center, 0.25, random=()=>0.5) 的乘性噪声指数部分（gaussian 在 random=0.5 处的值）。 */
function gaussianAtHalf(): number {
  // Box–Muller: u1=0.5,u2=0.5 → sqrt(-2 ln0.5)·cos(2π·0.5) = sqrt(1.3863)·cos(π) = 1.17741·(−1)
  return Math.sqrt(-2 * Math.log(0.5)) * Math.cos(2 * Math.PI * 0.5);
}

// ============ change pacing-fallback-hardening：中途档位刷新 pacing.update ============

test('pacing.update: 中途升档放大最小间隔且不重置锚点', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  // 初始 tempo=1.0（不传）；退化区间 {3000,3000} → 反射采样确定性 3000。
  const sess = new BrowseSession(h.deps, baseOpts(sleeps, mono, { action: { minMs: 3000, maxMs: 3000 } }));
  mono.t = 1000;
  const done = sess.start();
  await tick(30);
  await sess.onCloudCommand(makeEnvelope('note.open', 'o1', 0, { index: 0 })); // 锚点 = 1000
  await waitDetails(h, 1);
  // 时钟推进到 2000 后中途升档 tempo=2.0。若误经 markActionEnd 记账，锚点会被推进到 2000。
  mono.t = 2000;
  await sess.onCloudCommand(makeEnvelope('pacing.update', 'pu', 0, { tempo: 2.0 }));
  const before = sleeps.length;
  // o2 仍在 2000：正确 → elapsed=2000−1000=1000、floor=3000×2.0=6000 → gate=5000；
  //           误推进锚点 → elapsed=0 → gate=6000（本断言据此把关「不重置锚点」）。
  await sess.onCloudCommand(makeEnvelope('note.open', 'o2', 0, { index: 0 }));
  await waitDetails(h, 2);
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  const gate = sleeps.slice(before);
  assert.ok(gate.includes(5000), `升档后 gate 应 = floor(3000×2=6000)−elapsed(1000)=5000（证 tempo 已应用），实际: ${gate}`);
  assert.ok(!gate.includes(6000), `锚点不应被 pacing.update 推进（否则 elapsed=0 → 6000），实际: ${gate}`);
});

/** 驱动 note.open → note.close，返回 note.close 期间新增的最大 sleep（= ensureDetailDwell 兜底停留）。 */
async function driveOpenClose(
  h: Harness,
  sleeps: number[],
  tempo: number | undefined,
  dwellMs?: number,
): Promise<number> {
  const mono: Mono = { t: 0 };
  const opts: BrowseSessionOptions = { ...baseOpts(sleeps, mono, undefined, tempo), now: () => 5000 }; // 恒定 now → elapsed=0
  const sess = new BrowseSession(h.deps, opts);
  const done = sess.start();
  await tick(30);
  await sess.onCloudCommand(makeEnvelope('note.open', 'o1', 0, { index: 0 }));
  await waitDetails(h, 1);
  const before = sleeps.length;
  await sess.onCloudCommand(makeEnvelope('note.close', 'c1', 0, dwellMs === undefined ? {} : { dwellMs }));
  const start = Date.now();
  while (sleeps.length === before) { if (Date.now() - start > 2000) break; await tick(5); }
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  const created = sleeps.slice(before);
  return created.length ? Math.max(...created) : 0;
}

test('ensureDetailDwell: 缺 dwellMs 的内置兜底停留随 tempo 放大', async () => {
  const d1 = await driveOpenClose(makeHarness(), [], 1.0);
  const d2 = await driveOpenClose(makeHarness(), [], 2.0);
  assert.ok(d1 > 0 && d2 > 0, `两档都应有非零兜底停留，实际 d1=${d1} d2=${d2}`);
  assert.ok(d2 >= d1 * 1.8 && d2 <= d1 * 2.2, `tempo=2 兜底停留应≈2×tempo=1（elapsed 恒 0），实际 d1=${d1} d2=${d2}`);
});

test('ensureDetailDwell: 云端已下发 dwellMs 不再随 tempo 放大（防 double-count）', async () => {
  const d1 = await driveOpenClose(makeHarness(), [], 1.0, 8000);
  const d2 = await driveOpenClose(makeHarness(), [], 2.0, 8000);
  // 给定 dwellMs=8000（已含云端 tempo），边缘只叠抖动、不再乘 this.tempo → 两档实测停留一致。
  assert.equal(d1, d2, `给定 dwellMs 时兜底停留不应随 tempo 变（防二次放大），实际 d1=${d1} d2=${d2}`);
});

test('pacing.update: 循环已停时应用档位但绝不复活会话（回归 Finding 1 自残红线）', async () => {
  const h = makeHarness();
  const sleeps: number[] = [];
  const mono: Mono = { t: 0 };
  const logs: string[] = [];
  const opts: BrowseSessionOptions = { ...baseOpts(sleeps, mono), logger: (m: string) => logs.push(m) };
  const sess = new BrowseSession(h.deps, opts);
  mono.t = 1000;
  const done = sess.start();
  await tick(30);
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' })); // 停掉循环
  await done;
  assert.equal(sess.isRunning(), false, 'session.end 后循环应已停');

  const before = logs.length;
  await sess.onCloudCommand(makeEnvelope('pacing.update', 'pu', 0, { tempo: 1.6 })); // 停机窗口收到档位刷新
  await tick(30);
  const after = logs.slice(before);
  assert.equal(sess.isRunning(), false, 'pacing.update 绝不复活已停会话（自残红线）');
  assert.ok(!after.some((l) => l.includes('唤醒重启')), 'pacing.update 不应触发唤醒重启循环');
  assert.ok(after.some((l) => l.includes('应用中途档位刷新：tempo=1.6')), 'pacing.update 停机时仍应用 tempo、不静默丢弃');
});

test('applyTempoUpdate: 越界 tempo（>上限）被忽略、兜底停留不失控', async () => {
  // 构造期 tempo=1.0；越界 pacing.update{tempo:99} 应被 MAX_TEMPO 挡下、保留 1.0。
  const h = makeHarness();
  const sleeps: number[] = [];
  const opts: BrowseSessionOptions = { ...baseOpts(sleeps, { t: 0 }, undefined, 1.0), now: () => 5000 };
  const sess = new BrowseSession(h.deps, opts);
  const done = sess.start();
  await tick(30);
  await sess.onCloudCommand(makeEnvelope('pacing.update', 'pu', 0, { tempo: 99 })); // 越界 → 忽略
  await sess.onCloudCommand(makeEnvelope('note.open', 'o1', 0, { index: 0 }));
  await waitDetails(h, 1);
  const before = sleeps.length;
  await sess.onCloudCommand(makeEnvelope('note.close', 'c1', 0, {})); // 缺 dwellMs → 兜底停留 = sample×tempo
  const start = Date.now();
  while (sleeps.length === before) { if (Date.now() - start > 2000) break; await tick(5); }
  await sess.onCloudCommand(makeEnvelope('session.end', 'e', 0, { reason: 'end' }));
  await done;
  const dwell = Math.max(0, ...sleeps.slice(before));
  // tempo 若被误设 99：兜底停留≈3535×99≈35 万 ms；被挡下保持 1.0 → ≈3535ms 量级、远低于看门狗。
  assert.ok(dwell > 0 && dwell < 20000, `越界 tempo 应被忽略、兜底停留保持 tempo=1.0 量级，实际 ${dwell}`);
});
