import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import type { EdgeClient } from '../../src/client/edge-client.js';
import type {
  ActionCompletedPayload,
  Envelope,
  MessageType,
  NoteDetailPayload,
  PageCardsPayload,
} from '../../src/comm/protocol.js';
import {
  NativeBrowseSession,
} from '../../src/native-page-engine/browse-session.js';
import {
  nativeAllowedParamsByKind,
  nativeCommandKindByEnvelopeType,
} from '../../src/native-page-engine/command-mapper.js';
import type {
  NativePageCommand,
  NativePageCommandExecution,
} from '../../src/native-page-engine/client.js';
import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 云端时间指令的**跨语言登记表**（`native/page-engine/command-timing.json`）。
 *
 * 这条门禁刻意不做源码文本扫描：按 `.thinkMs` / `think_ms` 计数会被注释、错误文案、
 * 以及「构造时写 None」的死写喂绿（引擎里就有 5 处这样的构造点）。三条腿分别从
 * **真实产物**派生：Rust 从 serde 反序列化行为派生、宿主转发面从 command-mapper 的表派生、
 * 宿主消费面从**真的等了多久**派生。
 */
const TIMING_FIELDS = ['thinkMs', 'dwellMs'] as const;
type TimingField = (typeof TIMING_FIELDS)[number];

interface TimingContractEntry {
  nativeKind: string;
  declares: TimingField[];
  consumes: TimingField[];
  unconsumed: Array<{ field: TimingField; reason: string }>;
}

const timingContract: { commands: TimingContractEntry[] } = JSON.parse(
  readFileSync(resolve(repoRoot, 'native/page-engine/command-timing.json'), 'utf8'),
) as { commands: TimingContractEntry[] };

const contractByKind = new Map(timingContract.commands.map((entry) => [entry.nativeKind, entry]));

function envelopeTypeForKind(kind: string): MessageType {
  for (const [type, mapped] of Object.entries(nativeCommandKindByEnvelopeType)) {
    if (mapped === kind) return type as MessageType;
  }
  throw new Error(`no envelope type maps to native kind ${kind}`);
}

/**
 * 转发面（command-mapper 的允许字段表）与登记表的差集。**纯函数**，好让下面那条植入用例
 * 能拿一张被改坏的表喂进来、确认门禁真的会报出来并点名——否则这条门禁自己就可能是恒真的。
 */
function timingDeclarationDrift(
  allowedByKind: Record<string, readonly string[]>,
  declared: Map<string, TimingContractEntry>,
): string[] {
  const drift: string[] = [];
  for (const [kind, allowed] of Object.entries(allowedByKind)) {
    const forwarded = TIMING_FIELDS.filter((field) => allowed.includes(field));
    const entry = declared.get(kind);
    for (const field of forwarded) {
      if (!entry?.declares.includes(field)) drift.push(`undeclared:${kind}:${field}`);
    }
    for (const field of entry?.declares ?? []) {
      if (!forwarded.includes(field)) drift.push(`not_forwarded:${kind}:${field}`);
    }
  }
  for (const kind of declared.keys()) {
    if (!(kind in allowedByKind)) drift.push(`orphan:${kind}`);
  }
  drift.sort();
  return drift;
}

function harness(options: {
  platform: 'xiaohongshu' | 'facebook';
  clock?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} & {
  execute?: (
    command: NativePageCommand,
    onDispatched?: () => void,
  ) => Promise<NativePageCommandExecution>;
}) {
  const executions: NativePageCommand[] = [];
  const runtimeTimeouts: number[] = [];
  const actions: ActionCompletedPayload[] = [];
  const logs: string[] = [];
  const runtime = {
    async execute(
      _ownerId: string,
      command: NativePageCommand,
      timeoutMs?: number,
      _signal?: AbortSignal,
      _commitWindowHandler?: unknown,
      onDispatched?: () => void,
    ) {
      executions.push(command);
      runtimeTimeouts.push(timeoutMs ?? 0);
      if (options.execute) return options.execute(command, onDispatched);
      onDispatched?.();
      if (command.kind === 'note_open') {
        return {
          ok: true,
          effectPhase: 'confirmed',
          reasonCode: 'confirmed',
          output: {
            kind: 'note_detail',
            value: {
              noteId: 'note-1',
              title: '',
              content: 'body',
              author: 'a',
              likeCount: 0,
              collectCount: 0,
            } satisfies NoteDetailPayload,
          },
        } as unknown as NativePageCommandExecution;
      }
      if (command.kind === 'browse_scroll' || command.kind === 'page_scroll') {
        return {
          ok: true,
          effectPhase: 'confirmed',
          reasonCode: 'confirmed',
          output: {
            kind: 'page_cards',
            value: { startupId: 's', listKind: 'feed', cards: [] } as unknown as PageCardsPayload,
          },
        } as unknown as NativePageCommandExecution;
      }
      return {
        ok: true,
        effectPhase: 'confirmed',
        reasonCode: 'confirmed',
        output: { kind: 'action_receipt', value: { action: 'noop', ok: true } },
      } as unknown as NativePageCommandExecution;
    },
    async closeOwner() { /* no-op */ },
  } as unknown as NativePageRuntime;
  const client = {
    reportActionCompleted(payload: ActionCompletedPayload) { actions.push(payload); },
    reportPageCards() { /* no-op */ },
    reportNoteDetail() { /* no-op */ },
    reportProfileDetail() { /* no-op */ },
    send() { /* no-op */ },
  } as unknown as EdgeClient;
  const session = new NativeBrowseSession({
    runtime,
    client,
    startupId: 'startup-pacing-test',
    platform: options.platform,
    clock: options.clock ?? (() => 1_000),
    random: options.random ?? (() => 0.25), // gaussian(0.25,0.25) ≈ 0 ⇒ jitterAround 恒等，断言可读
    sleep: options.sleep,
    logger: (line: string) => { logs.push(line); },
  });
  return { session, executions, runtimeTimeouts, actions, logs };
}

/** 有界等待：缺了它，一条「本该等却没等」的回归会把用例挂死，而不是给出一行红。 */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}（${ms}ms 内未发生）`)), ms);
  });
  return Promise.race([promise, bound]).finally(() => { if (timer) clearTimeout(timer); }) as Promise<T>;
}

function envelope(type: MessageType, payload: Record<string, unknown>): Envelope {
  return { v: 2, type, id: `env-${type}`, ts: Date.now(), payload } as Envelope;
}

/** 该命令在哪个平台上不会被宿主的能力闸挡掉——挡掉的话行为断言就变成恒真的空跑。 */
function platformFor(type: MessageType): 'xiaohongshu' | 'facebook' {
  // 词汇批 5：互动命令也平台段化，平台一律由名表前缀推导（手抄拒集已归零删除）。
  if (type.startsWith('xiaohongshu.')) return 'xiaohongshu';
  return 'facebook';
}

// ─────────────────────────── 腿①/腿②：登记表 vs 转发面 ───────────────────────────

test('每条命令的时间字段转发面与跨语言登记表逐字相等', () => {
  assert.deepEqual(timingDeclarationDrift(nativeAllowedParamsByKind, contractByKind), []);
});

test('植入验证：转发一个未登记的时间字段、或登记一条不存在的命令，门禁必须报出并点名', () => {
  const withUndeclared = {
    ...nativeAllowedParamsByKind,
    hypothetical_command: ['reason', 'thinkMs'],
  };
  assert.deepEqual(
    timingDeclarationDrift(withUndeclared, contractByKind),
    ['undeclared:hypothetical_command:thinkMs'],
  );

  const withGhost = new Map(contractByKind);
  withGhost.set('retired_command', {
    nativeKind: 'retired_command',
    declares: ['thinkMs'],
    consumes: ['thinkMs'],
    unconsumed: [],
  });
  assert.deepEqual(timingDeclarationDrift(nativeAllowedParamsByKind, withGhost), ['orphan:retired_command']);

  // 少转发一个已登记字段同样要报——否则「删掉一处转发」会静默通过。
  const withMissing = {
    ...nativeAllowedParamsByKind,
    interaction_like: nativeAllowedParamsByKind.interaction_like.filter((f) => f !== 'thinkMs'),
  };
  assert.deepEqual(
    timingDeclarationDrift(withMissing, contractByKind),
    ['not_forwarded:interaction_like:thinkMs'],
  );
});

test('登记表自洽：消费与未消费恰好切分声明，未消费必须写明理由，且没有一条命令同时消费两个字段', () => {
  for (const entry of timingContract.commands) {
    const partition = [...entry.consumes, ...entry.unconsumed.map((item) => item.field)].sort();
    assert.deepEqual(partition, [...entry.declares].sort(), `${entry.nativeKind} 的消费划分未覆盖声明`);
    for (const item of entry.unconsumed) {
      assert.ok(item.reason.trim().length >= 10, `${entry.nativeKind}.${item.field} 必须写明未消费的理由`);
    }
    assert.ok(
      !(entry.consumes.includes('thinkMs') && entry.consumes.includes('dwellMs')),
      `${entry.nativeKind} 同时消费犹豫与停留：两段等待会相加，须先裁定取 max 的口径`,
    );
  }
});

// ─────────────────────── 腿③：消费面由「真的等了多久」派生 ───────────────────────

test('每条登记为消费犹豫的命令，都在第一条影响页面的输入之前等一段抖动后的犹豫', async () => {
  const kinds = timingContract.commands
    .filter((entry) => entry.consumes.includes('thinkMs'))
    .map((entry) => entry.nativeKind);
  assert.ok(kinds.length >= 16, `犹豫消费面收缩到 ${kinds.length} 条，登记表被改小了`);

  for (const kind of kinds) {
    const type = envelopeTypeForKind(kind);
    const waits: number[] = [];
    const h = harness({
      platform: platformFor(type),
      sleep: async (ms) => { waits.push(ms); },
    });
    await h.session.onCloudCommand(envelope(type, {
      noteId: 'note-1',
      authorId: 'author-1',
      commentAnchorId: 'anchor-1',
      groupUrl: 'https://www.facebook.com/groups/1',
      text: 'hi',
      thinkMs: 2_400,
    }));
    assert.deepEqual(waits, [2_400], `${kind} 收下了云端犹豫却没有等待`);
    assert.equal(h.executions.length, 1, `${kind} 未到达执行器（能力闸挡掉了，断言会变成空跑）`);
  }
});

test('每条登记为消费停留的命令，都以内容开始展示的时刻为锚补足抖动后的停留', async () => {
  const kinds = timingContract.commands
    .filter((entry) => entry.consumes.includes('dwellMs'))
    .map((entry) => entry.nativeKind);
  assert.deepEqual(kinds.sort(), ['navigation_back', 'page_scroll']);

  for (const kind of kinds) {
    const type = envelopeTypeForKind(kind);
    const waits: number[] = [];
    const h = harness({ platform: 'xiaohongshu', sleep: async (ms) => { waits.push(ms); } });
    if (kind === 'page_scroll') {
      await h.session.start(); // 首屏扫描回 page.cards ⇒ 立下「本批卡到达」锚点
    } else {
      await h.session.onCloudCommand(envelope('xiaohongshu.note.open', { noteId: 'note-1' })); // ⇒ 立下详情展示锚点
    }
    waits.length = 0;
    await h.session.onCloudCommand(envelope(type, { reason: 'r', targetPage: 'feed', dwellMs: 6_000 }));
    assert.deepEqual(waits, [6_000], `${kind} 收下了云端停留却没有补足`);
  }
});

test('Facebook page_scroll 使用 11s 中心的有界采样、只补已用时间差额并保留独立 180s 执行预算', async () => {
  let now = 1_000;
  const waits: number[] = [];
  let releaseSleep: (() => void) | undefined;
  let markSleepStarted: (() => void) | undefined;
  const sleepStarted = new Promise<void>((resolve) => { markSleepStarted = resolve; });
  const h = harness({
    platform: 'facebook',
    clock: () => now,
    random: () => 0.25,
    sleep: async (ms) => {
      waits.push(ms);
      markSleepStarted?.();
      await new Promise<void>((resolve) => { releaseSleep = resolve; });
    },
  });
  await h.session.start();
  h.logs.length = 0;
  h.runtimeTimeouts.length = 0;
  now = 3_000;

  const pending = h.session.onCloudCommand(envelope('facebook.feed.scroll', { reason: 'feed_scroll', dwellMs: 11_000 }));
  await within(sleepStarted, 100, 'Facebook dwell 等待应在 Native 执行前开始');
  assert.deepEqual(waits, [9_000], '11s 目标减去已用 2s，只补 9s');
  assert.equal(h.executions.filter((command) => command.kind === 'page_scroll').length, 0, '补等完成前不得启动页面命令');
  assert.ok(
    h.logs.some((line) => line.includes('event=command_dwell')
      && line.includes('centerMs=11000')
      && line.includes('targetMs=11000')
      && line.includes('elapsedMs=2000')
      && line.includes('waitMs=9000')
      && line.includes('sampling=facebook_reflected')),
    `应记录可核对的 Facebook dwell 诊断，实际=${JSON.stringify(h.logs)}`,
  );

  assert.ok(releaseSleep, '测试应已进入可取消等待');
  releaseSleep();
  await pending;
  assert.equal(h.executions.filter((command) => command.kind === 'page_scroll').length, 1);
  assert.deepEqual(h.runtimeTimeouts, [180_000], 'pacing 完成后 page_scroll 仍获得独立 180s 页面执行预算');
  await h.session.stopAndWait();
});

test('更宽的有界分布只作用于 Facebook page_scroll，非 Facebook 继续使用既有无界 sigma=0.20', async () => {
  async function pageScrollWait(platform: 'facebook' | 'xiaohongshu'): Promise<number> {
    const waits: number[] = [];
    const h = harness({ platform, random: () => 0, sleep: async (ms) => { waits.push(ms); } });
    await h.session.start();
    waits.length = 0;
    await h.session.onCloudCommand(envelope(platform === 'facebook' ? 'facebook.feed.scroll' : 'xiaohongshu.feed.scroll', { reason: 'feed_scroll', dwellMs: 11_000 }));
    await h.session.stopAndWait();
    return waits[0];
  }

  const facebook = await pageScrollWait('facebook');
  const xiaohongshu = await pageScrollWait('xiaohongshu');
  assert.ok(facebook >= 6_050 && facebook <= 20_900, `Facebook 样本 ${facebook} 必须在相对边界内`);
  assert.ok(xiaohongshu > 20_900, `非 Facebook 应保留既有 sigma=0.20 无界长尾，实际 ${xiaohongshu}`);
});

test('登记为不消费停留的命令确实一步都不等，而同一锚点对关帖仍然有效', async () => {
  const kinds = timingContract.commands
    .filter((entry) => entry.unconsumed.some((item) => item.field === 'dwellMs'))
    .map((entry) => entry.nativeKind);
  assert.deepEqual(kinds.sort(), ['note_browse_images', 'note_scroll_comments']);

  for (const kind of kinds) {
    const waits: number[] = [];
    const h = harness({ platform: 'xiaohongshu', sleep: async (ms) => { waits.push(ms); } });
    await h.session.onCloudCommand(envelope('xiaohongshu.note.open', { noteId: 'note-1' }));
    waits.length = 0;
    await h.session.onCloudCommand(envelope(envelopeTypeForKind(kind), { noteId: 'note-1', dwellMs: 6_000 }));
    assert.deepEqual(waits, [], `${kind} 不该消费停留`);
    // 锚点确实是活的——否则上面那条断言只是「锚点缺席」的空跑。
    await h.session.onCloudCommand(envelope('xiaohongshu.navigation.back', { reason: 'r', targetPage: 'feed', dwellMs: 6_000 }));
    assert.deepEqual(waits, [6_000], `${kind} 之后详情停留锚点必须仍然可用`);
  }
});

// ─────────────────────── 4.3 / 1.7：档位绝不二次乘到云端值上 ───────────────────────

test('改变风控档位不改变云端已下发时长的等待中心值，只放大边缘本地采样兜底', async () => {
  const cloudWaits: number[] = [];
  const fallbackWaits: number[] = [];
  for (const tempo of [1.0, 1.6]) {
    const cloud = harness({ platform: 'xiaohongshu', sleep: async (ms) => { cloudWaits.push(ms); } });
    cloud.session.applyPacingSnapshot(undefined, tempo);
    await cloud.session.onCloudCommand(envelope('xiaohongshu.note.open', { noteId: 'note-1', thinkMs: 2_400 }));
    await cloud.session.onCloudCommand(envelope('xiaohongshu.navigation.back', { reason: 'r', targetPage: 'feed', dwellMs: 6_000 }));

    const fallback = harness({ platform: 'xiaohongshu', sleep: async (ms) => { fallbackWaits.push(ms); } });
    fallback.session.applyPacingSnapshot(undefined, tempo);
    await fallback.session.onCloudCommand(envelope('xiaohongshu.note.open', { noteId: 'note-1' }));
    await fallback.session.onCloudCommand(envelope('xiaohongshu.navigation.back', { reason: 'r', targetPage: 'feed' })); // 旧云端 / 断连：无 dwellMs
  }

  // 云端值：两档完全一致（退役 Facebook 会话把 tempo 又乘了一遍，照抄即 double-count）。
  assert.deepEqual(cloudWaits, [2_400, 6_000, 2_400, 6_000]);
  // 本地采样兜底：非零（不秒退），且随档位成比例放大。
  assert.equal(fallbackWaits.length, 2);
  assert.ok(fallbackWaits[0] > 0, '缺 dwellMs 时仍须有非零停留（治秒退）');
  assert.equal(fallbackWaits[1], Math.round(fallbackWaits[0] * 1.6));
});

// ─────────────────────────── 4.4：节奏接线的两种入口语义 ───────────────────────────

test('中途档位刷新只改档位、绝不清掉离页停留锚点', async () => {
  async function backFallbackWait(update?: number): Promise<number[]> {
    const waits: number[] = [];
    const h = harness({ platform: 'xiaohongshu', sleep: async (ms) => { waits.push(ms); } });
    await h.session.onCloudCommand(envelope('xiaohongshu.note.open', { noteId: 'note-1' }));
    waits.length = 0;
    if (update !== undefined) await h.session.onCloudCommand(envelope('pacing.update', { tempo: update }));
    await h.session.onCloudCommand(envelope('xiaohongshu.navigation.back', { reason: 'r', targetPage: 'feed' })); // 无 dwellMs ⇒ 走本地兜底
    return waits;
  }

  const baseline = await backFallbackWait();
  const raised = await backFallbackWait(1.6);

  // 仍然等到了 ⇒ 锚点没被中途刷新清掉（清了就会整段跳过，那正是「借刷新跳过一次等待」）。
  assert.equal(raised.length, 1);
  assert.ok(baseline[0] > 0);
  assert.equal(raised[0], Math.round(baseline[0] * 1.6));
});

test('重连重注入的每类操作 floor 区间真的被本地兜底采纳', async () => {
  const waits: number[] = [];
  const h = harness({ platform: 'xiaohongshu', sleep: async (ms) => { waits.push(ms); } });
  h.session.applyPacingSnapshot({ detail_dwell: { minMs: 8_000, maxMs: 8_000 } }, 1.0);
  await h.session.onCloudCommand(envelope('xiaohongshu.note.open', { noteId: 'note-1' }));
  waits.length = 0;

  await h.session.onCloudCommand(envelope('xiaohongshu.navigation.back', { reason: 'r', targetPage: 'feed' }));

  assert.deepEqual(waits, [8_000]);
});

// ─────────────────────────────── 安全取消点 ───────────────────────────────

test('离页停留等待被接管时当场让路，且零执行器派发', async () => {
  let entered: (() => void) | undefined;
  const enteredWait = new Promise<void>((resolve) => { entered = resolve; });
  const h = harness({
    platform: 'xiaohongshu',
    sleep: (_ms, signal) => new Promise((_resolve, reject) => {
      entered?.();
      const fail = (): void => reject(Object.assign(new Error('cancelled'), { code: 'aborted' }));
      if (signal?.aborted) fail();
      signal?.addEventListener('abort', fail, { once: true });
    }),
  });
  await h.session.onCloudCommand(envelope('xiaohongshu.note.open', { noteId: 'note-1' }));
  const dispatched = h.executions.length;

  const pending = h.session.onCloudCommand(envelope('xiaohongshu.navigation.back', { reason: 'r', targetPage: 'feed', dwellMs: 60_000 }));
  await within(enteredWait, 1_000, 'xiaohongshu.navigation.back 从未进入离页停留等待');
  h.session.discardQueuedCloudCommands();
  await within(pending, 1_000, '停留等待未在接管到达时让路');

  assert.equal(h.executions.length, dispatched, '停留被取消后绝不派发');
  assert.deepEqual(h.actions.at(-1), { action: 'back', ok: false, reason: 'aborted' });
});

test('被接管掐断的停留不消费锚点：重下的返回命令仍然补足停留，绝不因一次接管变成秒退', async () => {
  const waits: number[] = [];
  let takeover = true;
  const h = harness({
    platform: 'xiaohongshu',
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      waits.push(ms);
      if (!takeover) { resolve(); return; }
      const fail = (): void => reject(Object.assign(new Error('cancelled'), { code: 'aborted' }));
      if (signal?.aborted) fail();
      signal?.addEventListener('abort', fail, { once: true });
      queueMicrotask(() => h.session.discardQueuedCloudCommands());
    }),
  });
  await h.session.onCloudCommand(envelope('xiaohongshu.note.open', { noteId: 'note-1' }));
  waits.length = 0;

  await within(
    h.session.onCloudCommand(envelope('xiaohongshu.navigation.back', { reason: 'r', targetPage: 'feed', dwellMs: 6_000 })),
    1_000,
    '被接管的停留未让路',
  );
  assert.deepEqual(waits, [6_000], '第一次返回应当先进入停留');

  // 云端重下同一条命令：锚点还在（时钟未推进 ⇒ 欠额未变），停留必须原样补足。
  takeover = false;
  await h.session.onCloudCommand(envelope('xiaohongshu.navigation.back', { reason: 'r', targetPage: 'feed', dwellMs: 6_000 }));
  assert.deepEqual(waits, [6_000, 6_000], '接管把锚点吃掉了 ⇒ 重下的返回直接秒退');

  // 而真正等完的那一次确实消费掉了锚点：再下一条不再重复补一段停留。
  await h.session.onCloudCommand(envelope('xiaohongshu.navigation.back', { reason: 'r', targetPage: 'feed', dwellMs: 6_000 }));
  assert.deepEqual(waits, [6_000, 6_000], '锚点已消费，不得再补一段');
});

// ─────────────────── 零派发 ≠ 结果未知：节奏等待期间被接管的那一段 ───────────────────

/**
 * 节奏等待（动作前犹豫 / 离页停留）发生在把命令交给执行器**之前**。那一段被接管时抛出的异常
 * 不带 `effectPhase`，从错误对象反推不出结局 —— 兜底成 `ambiguous` 就是把一条**一个字节都没
 * 发出去**的命令报成「已提交、结果未知」，上游据此写去重、不重投，与诚实红线方向正相反。
 *
 * 本 change 把这个窗口从「仅 Facebook 的翻页」扩到两个平台的关帖 / 返回 / 翻页，又新增了
 * 云端不下发时也会触发的本地兜底停留 —— 窗口显著变宽，所以这道判定必须钉死。
 */
test('节奏等待期间被接管：零派发的命令报「未开始」，绝不报「已提交、结果未知」', async () => {
  const abort = async (): Promise<never> => {
    throw Object.assign(new Error('Native pacing wait aborted'), { code: 'aborted' });
  };
  // 犹豫面与停留面各取一条：两条腿都在派发之前等，两条都必须收窄。
  const cases: Array<{ type: MessageType; payload: Record<string, unknown>; anchor?: MessageType }> = [
    { type: 'xiaohongshu.note.like', payload: { noteId: 'note-1', thinkMs: 2_400 } },
    { type: 'xiaohongshu.navigation.back', payload: { reason: 'r', targetPage: 'feed', dwellMs: 6_000 }, anchor: 'xiaohongshu.note.open' },
  ];

  for (const item of cases) {
    const h = harness({ platform: 'xiaohongshu', sleep: abort });
    if (item.anchor) await h.session.onCloudCommand(envelope(item.anchor, { noteId: 'note-1' }));
    const before = h.executions.length;
    h.actions.length = 0;
    h.logs.length = 0;

    await h.session.onCloudCommand(envelope(item.type, item.payload));

    assert.equal(h.executions.length, before, `${item.type} 根本没派发过，却到达了执行器`);
    assert.equal(h.actions.length, 1, `${item.type} 必须回一条失败`);
    assert.equal(
      h.actions[0]?.reason,
      'aborted',
      `${item.type} 零派发被报成了 native_effect_ambiguous`,
    );
    const failure = h.logs.find((line) => line.includes('event=command_failed'));
    assert.ok(failure, `${item.type} 缺少结构化失败诊断`);
    assert.match(
      failure,
      /effectPhase=not_started/,
      `${item.type} 零派发被上报成「已提交、结果未知」：${failure}`,
    );
  }
});

/** 对照：派发之后失败仍然是 ambiguous —— 否则上面那条会被一句「一律 not_started」喂绿。 */
test('已经交给执行器之后再失败，仍然是「已提交、结果未知」', async () => {
  const h = harness({
    platform: 'xiaohongshu',
    execute: async (_command, onDispatched) => {
      onDispatched?.();
      throw new Error('engine died mid-command');
    },
  });
  await h.session.onCloudCommand(envelope('xiaohongshu.note.like', { noteId: 'note-1' }));

  assert.equal(h.executions.length, 1, '这一条确实到达了执行器');
  assert.equal(h.actions[0]?.reason, 'native_effect_ambiguous');
  const failure = h.logs.find((line) => line.includes('event=command_failed'));
  assert.ok(failure);
  assert.match(failure, /effectPhase=ambiguous/, `派发之后的失败被收窄成了未开始：${failure}`);
});

test('运行时在开会话阶段失败：零命令写入仍报「未开始」', async () => {
  const h = harness({
    platform: 'xiaohongshu',
    execute: async () => {
      throw Object.assign(new Error('engine could not open a session'), { code: 'engine_exited' });
    },
  });

  await h.session.onCloudCommand(envelope('xiaohongshu.note.like', { noteId: 'note-1' }));

  assert.equal(h.actions.length, 1);
  assert.deepEqual(h.actions[0], {
    action: 'like',
    ok: false,
    reason: 'engine_exited',
  });
  const failure = h.logs.find((line) => line.includes('event=command_failed'));
  assert.ok(failure);
  assert.match(failure, /effectPhase=not_started/, `开会话失败被误报成已派发：${failure}`);
});
