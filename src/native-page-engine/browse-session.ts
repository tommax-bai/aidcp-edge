import { performance } from 'node:perf_hooks';
import type { EdgeBrowseSession } from '../browse/edge-browse-session.js';
import type { EdgeClient } from '../client/edge-client.js';
import type { CommitWindowGuard } from '../execution/commit-window.js';
import { jitterAround, type RandomFn } from '../humanize/timing.js';
import type {
  ActionCompletedPayload,
  ActionResultPayload,
  Envelope,
  IdentityObservedPayload,
  NoteDetailPayload,
  PageCardsPayload,
  PacingFloorPayload,
  PacingOp,
  ProfileDetailPayload,
} from '../comm/protocol.js';
import {
  facebookFeedVideoViewUiText,
  facebookReadUiText,
  facebookReelViewUiText,
} from '../facebook/companion-ui.js';
import {
  canonicalFacebookFeedVideoPostId,
  canonicalFacebookReelPostId,
  canonicalPostId,
} from '../facebook/post-identity-core.js';
import { nativeActionNameForCommand, nativeCommandForEnvelope } from './command-mapper.js';
import type { NativePageCommandExecution, NativePagePlatform } from './client.js';
import { NativePageRuntime } from './runtime.js';

export interface NativeBrowseSessionOptions {
  runtime: NativePageRuntime;
  client: EdgeClient;
  startupId: string;
  platform?: Extract<NativePagePlatform, 'xiaohongshu' | 'facebook'>;
  edgeId?: string;
  getAccountId?: () => string | undefined;
  logger?: (message: string) => void;
  clock?: () => number;
  random?: RandomFn;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  overlayConfirmMs?: number;
  /**
   * 周期阻断观测的节拍（ms）。默认 2000，可注入 / 可经 `AIDCP_NATIVE_OBSERVATION_MS` 配置。
   * 写死一个节拍等于把「多久看一眼」焊进代码，既不能按平台调档也不能在测试里驱动。
   */
  probeIntervalMs?: number;
  /**
   * 检出阻断后普通浏览命令在停手闸里最多等多久（ms）。
   * 等满仍未清除即回**诚实的未开始**——绝不无界地挂在闸门里（云端等不到回执会被看门狗判死整场会话）。
   */
  blockingWaitMs?: number;
  /** 停手等待循环的轮询间隔（ms）。 */
  blockingPollMs?: number;
  commitWindow?: CommitWindowGuard;
}

/** 阻断桶。`none` 之外的三桶都意味着「此刻不该继续对页面动手」。 */
type BlockingKind = 'none' | 'login' | 'captcha' | 'unknown';

/**
 * 阻断桶 → 诚实回执原因码。逐字沿用 Facebook 动作闸已在用的三个名字
 * （`native/page-engine/src/facebook/shared.rs` 的 `login_required` / `blocked_by_captcha` /
 * `blocked_by_unknown`），**不新造**：云端按名字归因，多一个同义词就多一条无归宿的原因码。
 */
const BLOCKING_REASONS: Record<Exclude<BlockingKind, 'none'>, string> = {
  login: 'login_required',
  captcha: 'blocked_by_captcha',
  unknown: 'blocked_by_unknown',
};

/**
 * 每平台一份阻断处置策略。上报闸语义（延后确认 / detected-cleared 严格配对 / 世代作废）
 * 两个平台共用一份实现，差别只在这三格：认哪些桶、要不要在宿主侧本地停手、要不要产出陪伴界面事件。
 */
interface BlockingPolicy {
  classify(value: Record<string, unknown>): BlockingKind;
  /** 低置信「未知阻断」桶是否成立。 */
  reportsUnknownBucket: boolean;
  /** 检出阻断后是否在宿主侧本地停手。 */
  haltsLocalDispatch: boolean;
  /** 是否产出陪伴界面事件（产品范围，非可观测性）。 */
  emitsCompanionUi: boolean;
}

const FACEBOOK_BLOCKING_POLICY: BlockingPolicy = {
  classify(value) {
    if (
      value.blockingKind === 'captcha'
      || value.blockingKind === 'unknown'
      || value.blockingKind === 'login'
    ) {
      return value.blockingKind;
    }
    if (value.pageKind === 'captcha') return 'captcha';
    if (value.pageKind === 'login') return 'login';
    return 'none';
  },
  reportsUnknownBucket: true,
  // Facebook 的停手落在 Rust 侧的逐动作 fail-closed 闸上（每个高危动作提交前各自复检），
  // 宿主不叠第二道会话级停手——那会改变 Facebook 既有的阻断语义，本次回归明确不动它。
  haltsLocalDispatch: false,
  emitsCompanionUi: true,
};

const XIAOHONGSHU_BLOCKING_POLICY: BlockingPolicy = {
  classify(value) {
    // 只认验证码与登录墙两桶。页面探针的「未识别」含义是**这是一个我没认出来的页面**，
    // 不是**这是一堵我认出来但归不了类的阻断墙**：小红书的看图态 / AI 搜索结果页 / 详情弹层
    // 都会落进未识别。把它当阻断上报＝每次识别失败换一次账号降级，是一台误报机。
    // 在页面规则里补出真正的阻断分类器之前，低置信桶是**已声明的缺席**，不是遗漏。
    if (value.pageKind === 'captcha') return 'captcha';
    if (value.pageKind === 'login') return 'login';
    return 'none';
  },
  reportsUnknownBucket: false,
  haltsLocalDispatch: true,
  // 小红书不补在场感 / 陪伴界面事件：迁移前也没有，属产品范围而非可观测性缺陷。
  // 排障级证据走结构化诊断行（见 diagnostic()），与陪伴界面是两条互不替代的通路。
  emitsCompanionUi: false,
};

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Native pacing wait aborted'), { code: 'aborted' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('Native pacing wait aborted'), { code: 'aborted' }));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const monotonicNow = (): number => performance.now();
const DEFAULT_OBSERVATION_INTERVAL_MS = 2_000;
const DEFAULT_BLOCKING_WAIT_MS = 15_000;
const DEFAULT_BLOCKING_POLL_MS = 250;
// ⚠️ 本组是**四处同步**的第 ① 层（请求值）。另外三层：
//   ② 准入校验 `client.ts` 的 validateCommandTimeout（超上限 ⇒ invalid_request，命令**根本不下发**）
//   ③ 会话超时 `runtime.ts` 的 FACEBOOK_NATIVE_SESSION_TIMEOUT_MS
//      （引擎取 `session_timeout_ms.min(ceiling)`，会话值小就**静默夹回旧值**、没有任何报错）
//   ④ 引擎天花板 `native/page-engine/src/engine.rs` 的 command_timeout_ceiling
// 漏 ② ⇒ 命令毫秒级被拒；漏 ③ ⇒ 看着改了其实没生效。typecheck 对这三种漂移全部无感。
//
// 默认档是**跨平台共享**的（小红书 / 视频号也读它）。本次仍随 Facebook 一起 30s → 45s，
// 理由是：Facebook 按 URL 开帖这条走的就是默认档，而它的内层详情水合窗已抬到 23s——
// 留在 30s 会让内层几乎顶满外层（已被 fake-CDP 用例当场抓到倒挂）。
// 抬默认档只放大**容错**，不改变任何成功路径的行为；对另两个平台的唯一影响是诚实失败晚 15s 暴露。
const DEFAULT_NATIVE_COMMAND_TIMEOUT_MS = 45_000;
const FACEBOOK_GROUP_JOIN_TIMEOUT_MS = 135_000;
/**
 * 空关键词首帖开帖的原子上限（change restore-facebook-post-join-comment-continuity）。
 *
 * 该命令内部是一串**串行**有界窗口，最坏路径：群页导航后就绪 12s + 首次探测约 2s +
 * 四轮下滚约 12s + 可选固链导航后就绪 12s + 评论框绑定 18s + 身份回读 30s ≈ 86s。
 * 只放宽内层而不抬这一层等于没改：外层先到点，把边端一个具名失败改判成外层合成失败。
 * 取值与加群命令同为 135s，避免上限种类膨胀。普通开帖（带 url / noteId）仍取默认值。
 */
const FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS = 135_000;
const FACEBOOK_FIRST_POST_SELECTION = 'first_commentable_group_post';
/**
 * 评论提交是**长度感知**预算：逐字拟人输入的实测均速约 165ms/字符
 * （`input.rs` 的对数正态中位 110ms + 标点 ×1.4 + 8% 概率插入 300–600ms 停顿），
 * 再加上找编辑框 / 滚动 / 聚焦 / 提交后等待 / reload / 校验的固定开销约 30s。
 *
 * 2026-07-29 真机：一条约 277 字符的越南语招聘长文，预算 78s（= 18s + 220ms×277 − 1s），
 * 逐字输入没输完就撞 deadline，如实回 `comment_deadline_exceeded` 并清空编辑框。
 * 现按用户口径整体 ×1.5，**上限单独抬到 180s**——上限才是长评论的真正约束：
 * 公式再大也会被它夹回去。180s 覆盖约 880 字符，且仍在会话空转看门狗之内。
 */
const FACEBOOK_COMMENT_TIMEOUT_FLOOR_MS = 42_000;
const FACEBOOK_COMMENT_TIMEOUT_BASE_MS = 27_000;
const FACEBOOK_COMMENT_TIMEOUT_PER_CHAR_MS = 330;
const FACEBOOK_COMMENT_TIMEOUT_MAX_MS = 180_000;
// 传输余量：边端自掐表要比云端步超时早一点收口，好让诚实回执赶在云端判 timeout 之前到。
// 它是「余量」不是「超时」，不随 ×1.5 放大；但预算变长后单跳抖动也变大，给到 2s。
const FACEBOOK_COMMENT_RESPONSE_SLACK_MS = 2_000;

/**
 * 就地读停留地板（edge-local 兜底，纯函数便于单测）：按正文字数线性、封顶，再乘 tempo。
 * 量级沿用已退役的 TypeScript 就地读实现，不另起一套；本文件自带一份是为了不把已退役的
 * Facebook 会话模块重新链回生产路径（打包裁剪会把它剔掉，import 它等于把裁剪判据搞坏）。
 */
const INLINE_READ_FLOOR_BASE_MS = 1_200;
const INLINE_READ_FLOOR_PER_CHAR_MS = 20;
const INLINE_READ_FLOOR_CAP_MS = 9_000;

export function computeInlineReadFloorMs(bodyLen: number, tempo: number): number {
  const raw = INLINE_READ_FLOOR_BASE_MS + Math.max(0, bodyLen) * INLINE_READ_FLOOR_PER_CHAR_MS;
  const capped = Math.min(INLINE_READ_FLOOR_CAP_MS, raw);
  return Math.round(capped * (tempo > 0 ? tempo : 1));
}

const FACEBOOK_UNSUPPORTED_COMMANDS = new Set<Envelope['type']>([
  'interaction.collect',
  'interaction.like_comment',
  'note.browse_images',
  'note.scroll_comments',
  'profile.open',
  'notification.open',
  'notification.browse_comments',
  'notification.browse_likes',
  'notification.browse_follows',
  'notification.back_home',
]);

export class NativeBrowseSession implements EdgeBrowseSession {
  private readonly ownerId: string;
  private readonly logger: (message: string) => void;
  private blocked = false;
  private closed = false;
  private running = false;
  private active?: Promise<void>;
  private activeAbort?: AbortController;
  private probeTimer?: NodeJS.Timeout;
  private blockingKind: BlockingKind = 'none';
  private reportedBlockingKind?: 'captcha' | 'unknown';
  private unknownConfirmTimer?: NodeJS.Timeout;
  private lastBlockingEvidence?: { url?: string; text?: string };
  /**
   * 阻断 episode 世代号：离开云端上报态即自增，令在途的延后确认当场作废。
   * 少了它，一个已经自愈的低置信阻断仍会在确认窗到点时补发一次 detected（配对随之错位）。
   */
  private blockingEpisode = 0;
  private observationSuspended = false;
  private observationDeferredLogged = false;
  private consecutiveProbeFailures = 0;
  private lastOkProbeAt?: number;
  private stopRequested = false;
  private lastFacebookCardsAt = 0;
  private readonly facebookReelViewActivityPostIds = new Set<string>();
  private readonly facebookFeedVideoViewActivityPostIds = new Set<string>();
  /** 就地读停留地板的锚点与目标（edge-local）。与云端 dwell 的新卡锚点取 max、绝不相加。 */
  private inlineReadStartedAt = 0;
  private inlineReadFloorMs = 0;
  /** 本次 feed 面开帖的起始时刻；只有真读出内容（note_detail 到达）才会晋升成 read floor 锚点。 */
  private pendingInlineReadStartedAt = 0;
  /** 握手下发的降速系数。只作用于**边缘本地**兜底值（就地读 read floor），不重复乘到云端已算好的时长上。 */
  private pacingTempo = 1;

  constructor(private readonly options: NativeBrowseSessionOptions) {
    this.ownerId = `browse:${options.startupId}`;
    this.logger = options.logger ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.running || this.blocked || this.closed) return;
    this.running = true;
    this.stopRequested = false;
    try {
      await this.executeAndReport({ kind: 'browse_scroll', params: { reason: 'initial_scan' } });
      this.logger(`[native-page] ${this.options.platform ?? 'xiaohongshu'} Native-only browse session ready`);
      this.diagnostic('session_ready');
      this.scheduleProbe();
    } finally {
      this.running = false;
    }
  }

  async onCloudCommand(env: Envelope): Promise<void> {
    if (env.type === 'pacing.update') return;
    const ownedTaskId = this.ownedTaskId(env);
    if (this.closed || (this.blocked && !ownedTaskId)) {
      this.reportFailure(env, 'native_session_quiesced', 'not_started');
      return;
    }
    if (this.options.platform === 'facebook' && FACEBOOK_UNSUPPORTED_COMMANDS.has(env.type)) {
      this.reportFailure(env, 'capability_unsupported', 'not_started');
      return;
    }
    // 停手闸只拦**普通浏览**。两类命令必须绕过它，否则闸门自己就是死锁的来源：
    //  - 出口②：**会话结束命令**。登录墙 / 验证码常驻时闸门会一直拦着普通命令；
    //    终止命令若也被拦住，云端就再也终止不了这场会话（必须先于闸门判定）。
    //  - **协调器授予的独占任务命令**。解除阻断本身就是任务干的活（远程协助点验证码），
    //    把它拦在等验证码消失的闸门里 = 等一个只有它自己能促成的条件。
    if (env.type !== 'session.end' && !ownedTaskId) {
      const gate = await this.waitWhileBlocked(env);
      if (gate) {
        this.reportFailure(env, gate, 'not_started');
        return;
      }
    }
    const command = nativeCommandForEnvelope(env, this.options.getAccountId?.());
    if (!command) {
      this.reportFailure(env, 'native_command_not_mapped', 'not_started');
      return;
    }
    const controller = new AbortController();
    this.activeAbort = controller;
    const active = this.executeAndReport(command, ownedTaskId ?? this.ownerId, controller.signal, env);
    this.active = active;
    try {
      await active;
      if (env.type === 'session.end') this.stop('cloud_session_end');
    } catch (error) {
      const detail = error as { code?: string; detail?: { effectPhase?: string; reasonCode?: string } };
      const phase = detail.detail?.effectPhase;
      this.reportFailure(
        env,
        phase === 'ambiguous' ? 'native_effect_ambiguous' : detail.code ?? 'native_command_failed',
        phase === 'not_started' || phase === 'dispatched' || phase === 'confirmed' || phase === 'ambiguous'
          ? phase
          : 'ambiguous',
      );
      // 结构化那一行只带 token（可被机械消费、不含现场文本）；下面那条人读的行保留原样，
      // 它带的是引擎错误消息，只供人排障，不是被解析的证据面。
      this.diagnostic('command_failed', {
        command: nativeActionNameForCommand(env.type),
        code: detail.code ?? 'native_command_failed',
        effectPhase: phase ?? 'ambiguous',
      });
      this.logger(`[native-page] ${env.type} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.active === active) this.active = undefined;
      if (this.activeAbort === controller) this.activeAbort = undefined;
    }
  }

  stop(reason = 'local_stop'): void {
    this.running = false;
    this.stopRequested = true;
    this.stopProbe();
    this.activeAbort?.abort();
    this.diagnostic('session_stopped', { reason });
    void this.options.runtime.closeOwner(this.ownerId);
  }

  close(): void {
    this.closed = true;
    this.stop('session_closed');
  }

  async closeAndWait(timeoutMs = 5_000): Promise<boolean> {
    this.closed = true;
    return this.stopAndWait(timeoutMs);
  }

  async stopAndWait(timeoutMs = 5_000): Promise<boolean> {
    this.running = false;
    this.stopRequested = true;
    this.stopProbe();
    this.activeAbort?.abort();
    this.diagnostic('session_stopped', { reason: this.closed ? 'session_closed' : 'drain_stop' });
    const drained = await this.waitActive(timeoutMs);
    await this.options.runtime.closeOwner(this.ownerId);
    return drained;
  }

  async quiesceForTask(timeoutMs = 5_000): Promise<number> {
    this.blocked = true;
    this.stopProbe();
    this.activeAbort?.abort();
    this.diagnostic('task_yield');
    if (!(await this.waitActive(timeoutMs))) {
      throw new Error(`Native ${this.options.platform ?? 'xiaohongshu'} command did not reach its atomic boundary before takeover`);
    }
    await this.options.runtime.closeOwner(this.ownerId);
    return 0;
  }

  async resumeAfterTask(): Promise<void> {
    if (this.closed) return;
    this.blocked = false;
    this.stopRequested = false;
    this.diagnostic('task_resume');
    if (this.options.platform === 'facebook') {
      // Facebook task legs are command-driven and may intentionally reuse the current group/post page.
      // Returning home here destroys that handoff; the next explicit feed command restores active_list_url.
      this.scheduleProbe();
      return;
    }
    await this.start();
  }

  discardQueuedCloudCommands(): void {
    this.activeAbort?.abort();
  }

  applyPacingSnapshot(
    _opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>,
    tempo?: number,
  ): void {
    // 云端已把内容 / 状态相关的系数算进随指令下发的 thinkMs / dwellMs，边缘不再重复乘一次。
    // tempo 仍要留：它是**边缘本地兜底值**（这里是就地读 read floor）唯一的降速旋钮。
    if (typeof tempo === 'number' && Number.isFinite(tempo) && tempo > 0) this.pacingTempo = tempo;
    // opFloorsMs 尚未接线：command-pacing 要求的「操作类命令最小间隔 gating」在 Native 路径整体缺失，
    // 属独立一层、单列后续 change 处理。此处不消费不等于此处无事可做——别照着这条注释再判一次「本就该空」。
  }

  async recoverAfterCloudReconnect(): Promise<void> {
    if (!this.blocked && !this.closed) await this.start();
  }

  private async executeAndReport(
    command: Parameters<NativePageRuntime['execute']>[1],
    ownerId = this.ownerId,
    signal?: AbortSignal,
    env?: Envelope,
  ): Promise<void> {
    await this.applyCommandPacing(command, signal);
    // 就地读锚点在犹豫之后、执行之前记：犹豫属于「决定要看」，不属于「正在看这条」。
    this.pendingInlineReadStartedAt =
      this.options.platform === 'facebook'
        && command.kind === 'note_open'
        && (command.params as { surface?: unknown }).surface === 'feed'
        ? (this.options.clock ?? monotonicNow)()
        : 0;
    const timeoutMs = this.facebookCommandTimeoutMs(command);
    const result = await this.options.runtime.execute(
      ownerId,
      command,
      timeoutMs,
      signal,
      // 提交窗口处理器与平台无关：开窗时刻在写入动作的正前方，而写入整段发生在执行体内部，
      // 宿主无从知道那一刻——窗口只能由执行体发起请求，宿主这里只做仲裁与转发。
      // 曾经的 `platform === 'facebook'` 条件让小红书拿到的是 undefined，
      // 于是它的四处不可逆写入等价于「无声照写」。
      this.options.commitWindow
        ? (request) => this.options.commitWindow!.enter(request.budgetMs, request.label)
        : undefined,
    );
    // 逐命令留证：不是每条命令都以「动作回执」终结（滚动与开帖的终局是结构化上报），
    // 少了这一行，一次浏览闭环里那几条命令在日志里就完全没有痕迹。
    this.diagnostic('command_outcome', {
      command: command.kind,
      effectPhase: result.effectPhase,
      output: result.output?.kind ?? 'none',
      reason: result.reasonCode ?? 'none',
    });
    this.report(result, env);
  }

  private facebookCommandTimeoutMs(command: Parameters<NativePageRuntime['execute']>[1]): number {
    if (this.options.platform !== 'facebook') return DEFAULT_NATIVE_COMMAND_TIMEOUT_MS;
    if (command.kind === 'group_join') return FACEBOOK_GROUP_JOIN_TIMEOUT_MS;
    if (
      command.kind === 'note_open'
      && command.params.selection === FACEBOOK_FIRST_POST_SELECTION
    ) {
      return FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS;
    }
    if (command.kind !== 'interaction_comment') return DEFAULT_NATIVE_COMMAND_TIMEOUT_MS;
    const body = typeof command.params.text === 'string' ? command.params.text.trim() : '';
    const groupChatCode = typeof command.params.groupChatCode === 'string'
      ? command.params.groupChatCode.trim()
      : '';
    const text = groupChatCode ? `${body}\n${groupChatCode}` : body;
    const cloudBudgetMs = Math.min(
      FACEBOOK_COMMENT_TIMEOUT_MAX_MS,
      Math.max(
        FACEBOOK_COMMENT_TIMEOUT_FLOOR_MS,
        FACEBOOK_COMMENT_TIMEOUT_BASE_MS
          + FACEBOOK_COMMENT_TIMEOUT_PER_CHAR_MS * Array.from(text).length,
      ),
    );
    return cloudBudgetMs - FACEBOOK_COMMENT_RESPONSE_SLACK_MS;
  }

  /**
   * 命令前节奏的**单一入口**：动作前犹豫（thinkMs）与离开内容前的停留（dwellMs / 就地读 read floor）。
   *
   * 合成一个入口是为了让「取 max、不相加」这条判定只有一处：拆成两处等待，两边都会以为自己在保证停留，
   * 实际结果要么相加、要么互相抵消，而这两种错法在日志上长得一样。
   */
  private async applyCommandPacing(
    command: Parameters<NativePageRuntime['execute']>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.applyThinkBefore(command, signal);
    await this.ensureScrollDwell(command, signal);
  }

  /**
   * 动作前犹豫：云端已把 tempo / 状态 / 熟悉度系数算进这个中心值，边缘只叠抖动，MUST NOT 再乘一次 tempo。
   * 收下字段却不等待，等于把云端整层节奏收口悄悄作废——这正是本 change 要修的那类丢弃。
   */
  private async applyThinkBefore(
    command: Parameters<NativePageRuntime['execute']>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    const centerMs = Number((command.params as { thinkMs?: unknown }).thinkMs);
    if (!Number.isFinite(centerMs) || centerMs <= 0) return;
    const waitMs = jitterAround(centerMs, 0.25, this.options.random);
    if (waitMs <= 0) return;
    await (this.options.sleep ?? abortableSleep)(waitMs, signal);
  }

  /**
   * 离开当前内容前的停留。两个锚点各测各的跨度、**取 max 不相加**：
   *  ① 云端 dwellMs，锚在本批卡到达时刻；② 就地读 read floor，锚在就地读开始时刻。
   * 就地读比进详情页快得多，只认 ① 会让长帖读完立刻秒滚。
   */
  private async ensureScrollDwell(
    command: Parameters<NativePageRuntime['execute']>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.options.platform !== 'facebook' || command.kind !== 'page_scroll') return;
    const now = (this.options.clock ?? monotonicNow)();
    let remainingMs = 0;
    const centerMs = Number(command.params.dwellMs);
    if (this.lastFacebookCardsAt > 0 && Number.isFinite(centerMs) && centerMs > 0) {
      const targetMs = jitterAround(centerMs, 0.2, this.options.random);
      remainingMs = Math.max(0, targetMs - Math.max(0, now - this.lastFacebookCardsAt));
    }
    if (this.inlineReadStartedAt > 0) {
      remainingMs = Math.max(remainingMs, this.inlineReadFloorMs - Math.max(0, now - this.inlineReadStartedAt));
      this.inlineReadStartedAt = 0; // 消费一次：绝不让旧锚点留到下一条内容上
      this.inlineReadFloorMs = 0;
    }
    if (remainingMs <= 0) return;
    await (this.options.sleep ?? abortableSleep)(remainingMs, signal);
  }

  private report(execution: NativePageCommandExecution, env?: Envelope): void {
    const output = execution.output;
    if (!output) return;
    const value = output.value as Record<string, unknown>;
    switch (output.kind) {
      case 'page_cards':
        this.options.client.reportPageCards({ ...(value as unknown as PageCardsPayload), startupId: this.options.startupId });
        if (this.options.platform === 'facebook') {
          if (env?.type !== 'search.execute') {
            this.lastFacebookCardsAt = (this.options.clock ?? monotonicNow)();
          }
          this.projectFacebookCardActivity(value as unknown as PageCardsPayload);
          const reels = value.listKind === 'reels';
          this.emitUi({
            kind: 'presence',
            type: 'feed',
            presence: reels ? '正在浏览 Reels 视频流…' : '正在浏览推荐流…',
            loopStage: 'feed',
          });
        }
        if (env?.type === 'search.execute') {
          const cards = Array.isArray(value.cards) ? value.cards : [];
          this.options.client.reportActionCompleted({
            action: 'search',
            ok: true,
            ...this.searchContext(env),
            actuated: true,
            searchOutcome: cards.length > 0 ? 'results_ready' : 'no_results',
            resultCount: cards.length,
          });
        }
        return;
      case 'note_detail':
        this.options.client.reportNoteDetail(value as unknown as NoteDetailPayload);
        if (this.options.platform === 'facebook') {
          // 就地读停留地板：按读到的正文长度定目标，锚点取**就地读开始那一刻**（命令下发前记下的）。
          // 锚在开始而非读完，是为了让展开与轮询已经花掉的时间被计入、只补差额——与 dwell 的
          // 「已过去的时间必须计入」同一口径。地板只在真读成功时才立：读失败（展开无效 / 环境变化）
          // 不产生 note_detail，也就不该压一段停留。
          if (this.pendingInlineReadStartedAt > 0) {
            const body = typeof value.content === 'string' ? value.content : '';
            this.inlineReadFloorMs = computeInlineReadFloorMs(body.length, this.pacingTempo);
            this.inlineReadStartedAt = this.pendingInlineReadStartedAt;
          }
          const postId = canonicalPostId(typeof value.noteId === 'string' ? value.noteId : undefined);
          if (
            !postId
            || (
              !this.facebookReelViewActivityPostIds.has(postId)
              && !this.facebookFeedVideoViewActivityPostIds.has(postId)
            )
          ) {
            this.emitUi({
              kind: 'activity',
              type: 'note_open',
              ...facebookReadUiText(value as unknown as NoteDetailPayload),
              loopStage: 'read',
              statsDelta: { views: 1 },
            });
          }
        }
        return;
      case 'profile_detail':
        this.options.client.reportProfileDetail(value as unknown as ProfileDetailPayload);
        return;
      case 'identity_observation':
        this.options.client.send('identity.observed', value as unknown as IdentityObservedPayload, env?.id);
        return;
      case 'notification_home':
        this.options.client.send('notification.home', value as never);
        return;
      case 'notification_items':
        this.options.client.send('notification.items', value as never);
        return;
      case 'action_receipt':
        this.reportActionReceipt(value, execution, env);
        return;
      case 'action_receipt_with_observation': {
        // 「回执 + 随行观测」：一条命令只能回一个输出，但这两类终局既要让云端的动作角色结案，
        // 又必须把本次真看到的东西送到云端。顺序是契约——观测先、回执后：角色一收到回执就结案，
        // 观测晚到会落在结案之后被漏掉（参考图刷新与联系人名册都只挂在观测上）。
        const noteDetail = value.noteDetail;
        if (noteDetail && typeof noteDetail === 'object') {
          // refreshOnly 由宿主强制置真：这是一次「刷新参考图」的随行快照，
          // 绝不能被云端当成一次新的详情打开而多记一笔浏览。
          this.options.client.reportNoteDetail({
            ...(noteDetail as Record<string, unknown>),
            refreshOnly: true,
          } as unknown as NoteDetailPayload);
        }
        const notificationItems = value.notificationItems;
        if (notificationItems && typeof notificationItems === 'object') {
          this.options.client.send('notification.items', notificationItems as never);
        }
        const receipt = value.receipt;
        if (!receipt || typeof receipt !== 'object') {
          throw new Error('Native browse output action_receipt_with_observation carries no receipt');
        }
        this.reportActionReceipt(receipt as Record<string, unknown>, execution, env);
        return;
      }
      case 'page_probe':
        this.observeProbe(value);
        return;
      case 'plan_results': {
        const results = Array.isArray(value.results) ? value.results as unknown as ActionResultPayload[] : [];
        for (const result of results) this.options.client.send('action.result', result, env?.id);
        return;
      }
      default:
        throw new Error(`Unexpected Native browse output: ${output.kind}`);
    }
  }

  /**
   * 动作回执的唯一处理段。裸回执与「回执 + 随行观测」共用这一段：
   * `ok = 回执自称成功 且 效果阶段已确认` 这条口径只许存在一份，复制一份就会漂。
   */
  private reportActionReceipt(
    value: Record<string, unknown>,
    execution: NativePageCommandExecution,
    env?: Envelope,
  ): void {
    const receipt = value as {
      action: string;
      ok: boolean;
      reason?: string;
      groupObservation?: unknown;
      observation?: unknown;
    };
    // 逐命令回执诊断与平台无关。它曾整段包在 Facebook 判据里，于是一次小红书浏览闭环
    // 在日志里只剩「会话就绪」与「失败」两行——没有证据就没有人发现问题，
    // 小红书那批动作诚实性缺陷长期无人察觉的直接原因就在这里。
    // 四元组（动作名 / 成功与否 / 效果相位 / 原因码）全部经 token 白名单收敛：
    // 诊断绝不携带页面正文、凭据或选择器。
    {
      const action = this.diagnosticToken(receipt.action);
      const reason = this.diagnosticToken(receipt.reason ?? execution.reasonCode ?? 'none');
      this.logger(
        `[native-page] action.completed action=${action} ok=${receipt.ok} effectPhase=${execution.effectPhase} reason=${reason}`,
      );
    }
    if (env?.type === 'search.execute') {
      const ok = receipt.ok && execution.effectPhase === 'confirmed';
      if (!ok) {
        this.reportFailure(env, receipt.reason ?? execution.reasonCode, execution.effectPhase);
        return;
      }
      this.options.client.reportActionCompleted({
        action: 'search',
        ok: true,
        ...this.searchContext(env),
        actuated: true,
        searchOutcome: 'results_ready',
        resultCount: Number.isInteger(value.resultCount) && Number(value.resultCount) >= 0
          ? Number(value.resultCount)
          : undefined,
      });
      return;
    }
    const completed = {
      ...receipt,
      ...((receipt.observation === undefined || receipt.observation === null)
        && receipt.groupObservation !== undefined
        && receipt.groupObservation !== null
        ? { observation: receipt.groupObservation }
        : {}),
      ok: receipt.ok && execution.effectPhase === 'confirmed',
    } as ActionCompletedPayload;
    delete (completed as ActionCompletedPayload & { groupObservation?: unknown }).groupObservation;
    this.options.client.reportActionCompleted(completed);
    if (this.options.platform === 'facebook') this.emitFacebookAction(completed);
  }

  private ownedTaskId(env: Envelope): string | undefined {
    const payload = env.payload as { taskId?: unknown } | undefined;
    return typeof payload?.taskId === 'string' && payload.taskId.trim() ? payload.taskId.trim() : undefined;
  }

  private searchContext(env: Envelope): Pick<
    ActionCompletedPayload,
    'activityId' | 'purpose' | 'scope'
  > {
    const payload = (env.payload ?? {}) as {
      activityId?: unknown;
      purpose?: unknown;
      scope?: unknown;
      taskId?: unknown;
    };
    const activityId = typeof payload.activityId === 'string' && payload.activityId.trim()
      ? payload.activityId.trim()
      : env.id;
    const purpose = payload.purpose === 'discovery' || payload.purpose === 'task_targeting' || payload.purpose === 'operator'
      ? payload.purpose
      : typeof payload.taskId === 'string' && payload.taskId.trim()
        ? 'task_targeting'
        : 'discovery';
    const scope = payload.scope === 'container' ? 'container' : 'global';
    return { activityId, purpose, scope };
  }

  private reportFailure(
    env: Envelope,
    reason: string,
    effectPhase: NativePageCommandExecution['effectPhase'],
  ): void {
    if (env.type !== 'search.execute') {
      this.options.client.reportActionCompleted({ action: nativeActionNameForCommand(env.type), ok: false, reason });
      return;
    }
    const actuated = effectPhase !== 'not_started';
    this.options.client.reportActionCompleted({
      action: 'search',
      ok: false,
      reason,
      ...this.searchContext(env),
      actuated,
      searchOutcome: actuated ? 'failed_after_submit' : 'not_submitted',
    });
  }

  private async waitActive(timeoutMs: number): Promise<boolean> {
    const active = this.active;
    if (!active) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const settled = active.then(() => true, () => true);
    try { return await Promise.race([settled, timeout]); } finally { if (timer) clearTimeout(timer); }
  }

  private get blockingPolicy(): BlockingPolicy {
    return this.options.platform === 'facebook'
      ? FACEBOOK_BLOCKING_POLICY
      : XIAOHONGSHU_BLOCKING_POLICY;
  }

  private now(): number {
    return (this.options.clock ?? monotonicNow)();
  }

  private observationIntervalMs(): number {
    const configured = this.options.probeIntervalMs
      ?? Number(process.env.AIDCP_NATIVE_OBSERVATION_MS ?? DEFAULT_OBSERVATION_INTERVAL_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_OBSERVATION_INTERVAL_MS;
  }

  /**
   * 周期阻断观测的存活读数。
   *
   * `msSinceLastOkProbe === undefined` 表示**一次都没成功探测过**，与「探测成功但没看到情况」
   * 是两态：MUST NOT 把「探测不了」当成「没情况」——那是传感层的假成功。
   * 连续失败数与当前保持态一并暴露，外部据此判断「已经看不见多久了」。
   */
  observationStatus(): {
    running: boolean;
    suspended: boolean;
    blockingKind: BlockingKind;
    consecutiveProbeFailures: number;
    msSinceLastOkProbe?: number;
  } {
    return {
      running: this.probeTimer !== undefined,
      suspended: this.observationSuspended,
      blockingKind: this.blockingKind,
      consecutiveProbeFailures: this.consecutiveProbeFailures,
      ...(this.lastOkProbeAt === undefined
        ? {}
        : { msSinceLastOkProbe: Math.max(0, this.now() - this.lastOkProbeAt) }),
    };
  }

  /**
   * 停掉全部周期观测（执行器连接进入不可恢复终态时用）。幂等。
   * 不停的后果是：探针继续对一条已死的连接空轮询，一路跑到进程退出。
   */
  suspendObservation(reason = 'executor_unrecoverable'): void {
    if (this.observationSuspended) return;
    this.observationSuspended = true;
    this.stopProbe();
    this.diagnostic('observation_suspended', { reason });
  }

  /** 重连后整批重启周期观测。启动幂等：没停过就是空操作，停过则干净恢复。 */
  resumeObservation(): void {
    if (this.observationSuspended) {
      this.observationSuspended = false;
      this.diagnostic('observation_resumed');
    }
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    if (this.closed || this.probeTimer) return;
    if (this.blocked || this.observationSuspended) {
      // 「已装配但暂不启动」：待机 / 交接期不起探针，但必须留一条可观测记录——
      // 否则运维分不清监测体是「没装」还是「装了没开」。翻转才记一次，不刷屏。
      if (!this.observationDeferredLogged) {
        this.observationDeferredLogged = true;
        this.diagnostic('observation_deferred', {
          reason: this.blocked ? 'task_takeover' : 'suspended',
        });
      }
      return;
    }
    this.observationDeferredLogged = false;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      void this.probeOnce().finally(() => this.scheduleProbe());
    }, this.observationIntervalMs());
    this.probeTimer.unref?.();
  }

  private stopProbe(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    this.clearUnknownConfirm();
  }

  private clearUnknownConfirm(): void {
    if (this.unknownConfirmTimer) clearTimeout(this.unknownConfirmTimer);
    this.unknownConfirmTimer = undefined;
  }

  /** 一次周期观测。平台无关：判类交给按平台取的策略。 */
  private async probeOnce(): Promise<void> {
    if (this.closed || this.blocked || this.observationSuspended) return;
    try {
      const execution = await this.options.runtime.execute(
        this.ownerId,
        { kind: 'page_probe', params: {} },
        5_000,
      );
      if (execution.output?.kind !== 'page_probe') {
        this.noteProbeFailure('probe_output_missing');
        return;
      }
      this.lastOkProbeAt = this.now();
      if (this.consecutiveProbeFailures > 0) {
        this.diagnostic('observation_recovered', { failures: this.consecutiveProbeFailures });
        this.consecutiveProbeFailures = 0;
      }
      this.observeProbe(execution.output.value as Record<string, unknown>);
    } catch {
      this.noteProbeFailure('probe_failed');
    }
  }

  /**
   * 探测失败的容错档 = **sticky**：保持上一状态、绝不翻转。
   * 翻转的后果是页面正常导航期间的一次瞬时求值失败被当成验证码，刷出假告警。
   * 只在进入失败态时记一行（旧实现每拍刷一行僵尸日志），持续失败靠存活读数在外部可见。
   */
  private noteProbeFailure(reason: string): void {
    this.consecutiveProbeFailures += 1;
    if (this.consecutiveProbeFailures === 1) {
      this.diagnostic('observation_probe_failed', { reason, keptState: this.blockingKind });
    }
  }

  /**
   * @deprecated 兼容别名：既有 Facebook 阻断上报回归用例按这个名字取句柄驱动一次观测。
   * 判类与上报都在平台无关的 {@link observeProbe} 里，这里不做任何第二份判据；
   * 那条用例改指 `observeProbe` 之后即可删除本别名。
   */
  observeFacebookProbe(value: Record<string, unknown>): void {
    this.observeProbe(value);
  }

  /** 驱动一次阻断观测（周期探针与随命令回传的探针输出共用这一段）。 */
  observeProbe(value: Record<string, unknown>): void {
    const policy = this.blockingPolicy;
    const kind = policy.classify(value);
    const url = typeof value.origin === 'string'
      ? `${value.origin}${typeof value.path === 'string' ? value.path : ''}`
      : undefined;
    const evidence = typeof value.blockingText === 'string' && value.blockingText.trim()
      ? value.blockingText.trim().slice(0, 1_000)
      : undefined;
    this.lastBlockingEvidence = { url, text: evidence };
    const previous = this.blockingKind;
    this.blockingKind = kind;
    if (kind !== previous) this.diagnostic('blocking_state', { from: previous, to: kind });

    if (kind === 'captcha') {
      this.clearUnknownConfirm();
      if (this.reportedBlockingKind !== 'captcha') this.reportBlocking('captcha');
      return;
    }
    if (kind === 'unknown') {
      // 低置信桶必须经一轮持续性确认才上报，滤掉一闪即自愈的瞬时坏页。
      // 真验证码指纹走上面那条即时路径、不经确认窗（绝不弱化真验证码）。
      if (!policy.reportsUnknownBucket) return;
      if (previous !== 'unknown' && !this.reportedBlockingKind && !this.unknownConfirmTimer) {
        const configuredConfirmMs = this.options.overlayConfirmMs ?? Number(process.env.AIDCP_OVERLAY_CONFIRM_MS ?? 2_000);
        const confirmMs = Number.isFinite(configuredConfirmMs) && configuredConfirmMs >= 0
          ? configuredConfirmMs
          : 2_000;
        const episode = this.blockingEpisode;
        this.unknownConfirmTimer = setTimeout(() => {
          this.unknownConfirmTimer = undefined;
          // 世代守卫：期间若已离开上报态，这次在途确认作废（自愈后不补发）。
          if (episode !== this.blockingEpisode) return;
          if (this.blockingKind === 'unknown' && !this.reportedBlockingKind) {
            this.reportBlocking('unknown');
          }
        }, confirmMs);
        this.unknownConfirmTimer.unref?.();
      }
      return;
    }
    // 登录墙与无阻断共用这一段：登录墙**只本地停手、不打扰云端**（不发账号级阻断上报）。
    this.clearUnknownConfirm();
    if (!this.reportedBlockingKind) {
      // 从未上报过的阻断态自愈：MUST NOT 发孤儿 cleared。
      if (previous === 'captcha' || previous === 'unknown') this.blockingEpisode += 1;
      return;
    }
    const cleared = this.reportedBlockingKind;
    this.reportedBlockingKind = undefined;
    this.blockingEpisode += 1;
    this.options.client.send('risk.captcha_cleared', {
      edgeId: this.options.edgeId,
      accountId: this.options.getAccountId?.(),
      ...(url ? { url } : {}),
    });
    this.diagnostic('blocking_cleared', { kind: cleared });
    if (policy.emitsCompanionUi) {
      this.emitUi({
        kind: 'activity',
        type: 'popup_cleared',
        sentence: '阻断已解除，继续浏览',
        presence: '继续浏览…',
      });
    }
  }

  private reportBlocking(kind: 'captcha' | 'unknown'): void {
    this.reportedBlockingKind = kind;
    const evidence = this.lastBlockingEvidence;
    this.options.client.send('risk.captcha_detected', {
      edgeId: this.options.edgeId,
      accountId: this.options.getAccountId?.(),
      kind,
      ...(evidence?.url ? { url: evidence.url } : {}),
      ...(evidence?.text ? {
        overlay: {
          kind,
          ...(evidence.url ? { firstDetectedUrl: evidence.url } : {}),
          capturedAt: Date.now(),
          text: evidence.text,
          candidates: [],
        },
      } : {}),
      reason: 'native_page_probe',
    });
    // 诊断只记「有没有证据文案」，不记文案本身：那是页面正文。
    this.diagnostic('blocking_detected', { kind, evidence: evidence?.text ? 'present' : 'absent' });
    if (this.blockingPolicy.emitsCompanionUi) {
      const what = kind === 'captcha' ? '验证码' : '未知阻断/限流';
      this.emitUi({
        kind: 'activity',
        type: 'popup',
        sentence: `遇到${what}，先停一停等处理`,
        presence: `遇到${what}，暂停操作中…`,
      });
    }
  }

  /**
   * 停手等待循环。返回 `undefined` 表示可以继续下发；返回一个原因码表示诚实的**未开始**。
   *
   * 三个显式出口（少一个就有一种停摆形态）：
   *  ① **本地停止**：会话被停 / 被关，等待当场结束；
   *  ② **会话结束命令**：由调用点在进闸门之前放行（见 onCloudCommand），否则登录墙常驻时
   *     云端永远终止不了这场会话；
   *  ③ **任务接管信号**：到达即**抛出**，令该命令零副作用作废、当场让路。
   *     MUST NOT 只 return —— 那会让命令继续对着验证码墙点下去，而交接等的是「命令处理函数还没返回」，
   *     于是它无界地等一条正在等验证码的命令，那个验证码又只有这次交接要授予的协助任务才能点掉：
   *     闭环死锁、整台机器停摆。
   */
  private async waitWhileBlocked(env: Envelope): Promise<string | undefined> {
    if (!this.blockingPolicy.haltsLocalDispatch) return undefined;
    if (this.blockingKind === 'none') return undefined;
    const deadline = this.now() + (this.options.blockingWaitMs ?? DEFAULT_BLOCKING_WAIT_MS);
    const pollMs = this.options.blockingPollMs ?? DEFAULT_BLOCKING_POLL_MS;
    const sleep = this.options.sleep ?? abortableSleep;
    this.diagnostic('blocking_halt_enter', {
      kind: this.blockingKind,
      command: nativeActionNameForCommand(env.type),
    });
    for (;;) {
      // 每一轮都重新读一次当前判类：状态由周期观测在闸门之外持续刷新。
      const kind = this.currentBlockingKind();
      if (kind === 'none') {
        this.diagnostic('blocking_halt_exit', { outcome: 'cleared' });
        return undefined;
      }
      // 出口③：接管到达即抛出（零副作用作废）。
      if (this.blocked) {
        this.diagnostic('blocking_halt_exit', { outcome: 'preempted_by_task' });
        throw Object.assign(
          new Error('Native browse command yielded to task takeover while halted on a blocking overlay'),
          { code: 'preempted_by_task' },
        );
      }
      // 出口①：本地停止。
      if (this.closed || this.stopRequested) {
        this.diagnostic('blocking_halt_exit', { outcome: 'session_stopped' });
        return 'session_stopped';
      }
      if (this.now() >= deadline) {
        this.diagnostic('blocking_halt_exit', { outcome: 'still_blocked', kind });
        return BLOCKING_REASONS[kind];
      }
      await sleep(pollMs);
    }
  }

  private currentBlockingKind(): BlockingKind {
    return this.blockingKind;
  }

  private diagnostic(
    event: string,
    fields: Record<string, string | number | boolean | undefined> = {},
  ): void {
    const parts = [
      `event=${this.diagnosticToken(event)}`,
      `platform=${this.diagnosticToken(this.options.platform ?? 'xiaohongshu')}`,
    ];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(`${this.diagnosticToken(key)}=${this.diagnosticToken(String(value))}`);
    }
    this.logger(`[native-page] session.event ${parts.join(' ')}`);
  }

  private emitFacebookAction(payload: ActionCompletedPayload): void {
    if (!payload.ok) return;
    if (payload.action === 'like') {
      this.emitUi({
        kind: 'activity',
        type: 'like',
        sentence: '点了个赞',
        presence: '刚点了个赞',
        loopStage: 'interact',
        statsDelta: { likes: 1 },
      });
    } else if (payload.action === 'follow' && payload.reason !== 'already_following') {
      this.emitUi({
        kind: 'activity',
        type: 'follow',
        sentence: '关注了一位作者',
        presence: '刚关注了一位作者',
        loopStage: 'interact',
        statsDelta: { follows: 1 },
      });
    } else if (payload.action === 'comment') {
      this.emitUi({
        kind: 'activity',
        type: 'comment',
        sentence: '发表了一条评论',
        presence: '刚发表了一条评论',
        loopStage: 'interact',
        statsDelta: { comments: 1 },
      });
    } else if (payload.action === 'join_group') {
      this.emitUi({
        kind: 'activity',
        type: 'join_group',
        sentence: '已提交加群操作',
        presence: '刚处理了一个加群任务',
        loopStage: 'interact',
      });
    }
  }

  private projectFacebookCardActivity(payload: PageCardsPayload): void {
    if (payload.listKind === 'reels' && payload.cards.length === 1) {
      const card = payload.cards[0];
      const postId = canonicalFacebookReelPostId(card.noteId);
      if (postId && !this.facebookReelViewActivityPostIds.has(postId)) {
        this.facebookReelViewActivityPostIds.add(postId);
        this.emitUi({
          kind: 'activity',
          type: 'reel_view',
          ...facebookReelViewUiText(card),
          loopStage: 'read',
          statsDelta: { views: 1 },
        });
      }
      return;
    }
    if (payload.listKind !== 'feed') return;

    const videos = payload.cards.filter((card) => card.isVideo === true);
    const card = videos.length === 1 ? videos[0] : undefined;
    const postId = canonicalFacebookFeedVideoPostId(card?.noteId);
    if (!card || !postId || this.facebookFeedVideoViewActivityPostIds.has(postId)) return;
    this.facebookFeedVideoViewActivityPostIds.add(postId);
    this.emitUi({
      kind: 'activity',
      type: 'feed_video_view',
      ...facebookFeedVideoViewUiText(card),
      loopStage: 'read',
      statsDelta: { views: 1 },
    });
  }

  private diagnosticToken(value: unknown): string {
    const token = typeof value === 'string' ? value : 'unknown';
    return /^[a-zA-Z0-9_.:-]{1,96}$/.test(token) ? token : 'non_token_reason';
  }

  private emitUi(event: Record<string, unknown>): void {
    this.logger(`[ui-event] ${JSON.stringify(event)}`);
  }
}
