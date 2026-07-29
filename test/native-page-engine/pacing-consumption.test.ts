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
  FACEBOOK_UNSUPPORTED_COMMANDS,
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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} & { execute?: (command: NativePageCommand) => Promise<NativePageCommandExecution> }) {
  const executions: NativePageCommand[] = [];
  const actions: ActionCompletedPayload[] = [];
  const runtime = {
    async execute(_ownerId: string, command: NativePageCommand) {
      executions.push(command);
      if (options.execute) return options.execute(command);
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
    random: () => 0.25, // gaussian(0.25,0.25) ≈ 0 ⇒ jitterAround 恒等，断言可读
    sleep: options.sleep,
    logger: () => undefined,
  });
  return { session, executions, actions };
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
  return FACEBOOK_UNSUPPORTED_COMMANDS.has(type) ? 'xiaohongshu' : 'facebook';
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
  assert.deepEqual(kinds.sort(), ['navigation_back', 'note_close', 'page_scroll']);

  for (const kind of kinds) {
    const type = envelopeTypeForKind(kind);
    const waits: number[] = [];
    const h = harness({ platform: 'xiaohongshu', sleep: async (ms) => { waits.push(ms); } });
    if (kind === 'page_scroll') {
      await h.session.start(); // 首屏扫描回 page.cards ⇒ 立下「本批卡到达」锚点
    } else {
      await h.session.onCloudCommand(envelope('note.open', { noteId: 'note-1' })); // ⇒ 立下详情展示锚点
    }
    waits.length = 0;
    await h.session.onCloudCommand(envelope(type, { reason: 'r', dwellMs: 6_000 }));
    assert.deepEqual(waits, [6_000], `${kind} 收下了云端停留却没有补足`);
  }
});

test('登记为不消费停留的命令确实一步都不等，而同一锚点对关帖仍然有效', async () => {
  const kinds = timingContract.commands
    .filter((entry) => entry.unconsumed.some((item) => item.field === 'dwellMs'))
    .map((entry) => entry.nativeKind);
  assert.deepEqual(kinds.sort(), ['note_browse_images', 'note_scroll_comments']);

  for (const kind of kinds) {
    const waits: number[] = [];
    const h = harness({ platform: 'xiaohongshu', sleep: async (ms) => { waits.push(ms); } });
    await h.session.onCloudCommand(envelope('note.open', { noteId: 'note-1' }));
    waits.length = 0;
    await h.session.onCloudCommand(envelope(envelopeTypeForKind(kind), { noteId: 'note-1', dwellMs: 6_000 }));
    assert.deepEqual(waits, [], `${kind} 不该消费停留`);
    // 锚点确实是活的——否则上面那条断言只是「锚点缺席」的空跑。
    await h.session.onCloudCommand(envelope('note.close', { reason: 'r', dwellMs: 6_000 }));
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
    await cloud.session.onCloudCommand(envelope('note.open', { noteId: 'note-1', thinkMs: 2_400 }));
    await cloud.session.onCloudCommand(envelope('navigation.back', { reason: 'r', dwellMs: 6_000 }));

    const fallback = harness({ platform: 'xiaohongshu', sleep: async (ms) => { fallbackWaits.push(ms); } });
    fallback.session.applyPacingSnapshot(undefined, tempo);
    await fallback.session.onCloudCommand(envelope('note.open', { noteId: 'note-1' }));
    await fallback.session.onCloudCommand(envelope('navigation.back', { reason: 'r' })); // 旧云端 / 断连：无 dwellMs
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
    await h.session.onCloudCommand(envelope('note.open', { noteId: 'note-1' }));
    waits.length = 0;
    if (update !== undefined) await h.session.onCloudCommand(envelope('pacing.update', { tempo: update }));
    await h.session.onCloudCommand(envelope('navigation.back', { reason: 'r' })); // 无 dwellMs ⇒ 走本地兜底
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
  await h.session.onCloudCommand(envelope('note.open', { noteId: 'note-1' }));
  waits.length = 0;

  await h.session.onCloudCommand(envelope('note.close', { reason: 'r' }));

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
  await h.session.onCloudCommand(envelope('note.open', { noteId: 'note-1' }));
  const dispatched = h.executions.length;

  const pending = h.session.onCloudCommand(envelope('navigation.back', { reason: 'r', dwellMs: 60_000 }));
  await within(enteredWait, 1_000, 'navigation.back 从未进入离页停留等待');
  h.session.discardQueuedCloudCommands();
  await within(pending, 1_000, '停留等待未在接管到达时让路');

  assert.equal(h.executions.length, dispatched, '停留被取消后绝不派发');
  assert.deepEqual(h.actions.at(-1), { action: 'back', ok: false, reason: 'aborted' });
});
