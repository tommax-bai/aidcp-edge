import type {
  EdgeTaskAcquirePayload,
  EdgeTaskAcquiredPayload,
  EdgeTaskReleasePayload,
  EdgeTaskReleasedPayload,
} from '../comm/protocol.js';

export interface EdgeTaskBrowseGate {
  /**
   * 接管：让路 + **有界**等待真写段收敛，返回被取消的未开始浏览命令数。
   * 未在预算内收敛 MUST 抛出——调用方据此不授予、诚实终结排队申请，MUST NOT 谎称已收敛
   * （change lease-strict-preemption）。
   */
  quiesceForTask(timeoutMs?: number): Promise<number>;
  resumeAfterTask(): Promise<void>;
}

/**
 * 页面写者注册表探针（change lease-strict-preemption 5.2）。
 *
 * 协调器原本只认识**一个**页面写者（browse gate）；发布执行流是**第二个**写者，今天游离在协调器视野
 * 之外。本探针把「当前在跑写者」的两类事实喂给协调器，用于两处抢占安全判定：
 *   ① 抢占前问「在跑写者是否处于不可逆提交窗口」（六处提交点，5.1）——是则**拒绝抢占**、回
 *      `window_busy` + 剩余预算（不强杀已提交动作、也不让抢占者空等）；否则可抢占。
 *   ② 恢复浏览 / 放行普通浏览命令前问「是否有在途发布写」（5.9）——有则封住，绝不让浏览恢复把发布页
 *      导航走（否则发布后置校验会把「已离开发布页」误判成发布成功）。
 *
 * **保守缺省**：全部方法可选。`inCommitWindow` 返回 `undefined`（探针未接线）时，协调器**无法确认
 * 「不在窗口」→ 一律不抢占**（回落到今日排队等待行为）；`publishInFlight` 缺省视为无在途发布写、不额外
 * 封锁。因此本探针未注入时，协调器行为与抢占前**逐字不变**（抢占能力休眠、待 5.1/5.3 接线真探针才生效）。
 */
export interface EdgeTaskPageWriterProbe {
  /** 当前在跑的独占写者是否处于不可逆提交窗口（六处提交点，5.1）。`undefined` = 无法确认（→ 不抢占）。 */
  inCommitWindow?(): boolean | undefined;
  /** 当前提交窗口的剩余毫秒（`window_busy` 回执携带，供云端精确等待后重排 acquire，不空转轮询）。 */
  commitWindowRemainingMs?(): number | undefined;
  /** 是否有在途发布写（独立于租约；治 5.9 假成功）。 */
  publishInFlight?(): boolean | undefined;
  /**
   * 取消在途发布写并**有界等待**其收敛（真取消，5.3）；返回被取消数（0 或 1）。
   * 未在预算内收敛 MUST 抛出（与 browse gate 同构）——协调器据此判控制面故障。缺省视为无在途发布可取消。
   */
  cancelPublish?(timeoutMs?: number): Promise<number>;
}

export interface EdgeTaskCoordinatorOptions {
  browse: EdgeTaskBrowseGate;
  /**
   * 页面写者注册表探针（change lease-strict-preemption 5.2/5.3/5.9）。未注入 = 抢占能力休眠、行为与今日逐字不变。
   */
  writers?: EdgeTaskPageWriterProbe;
  /** 浏览器控制面是否可安全接管。false 时必须快速明确拒绝，不能占住普通浏览再等云端超时。 */
  canAcquire?: () => boolean;
  /**
   * 浏览器是否被**主动收起**（冷待机已释放浏览器层）——区别于「浏览器在、但控制不健康」。
   * 这两件事今天被压成同一个 `cdp_unhealthy`，那是**假话**：停泊是我们自己干的，而且叫得醒。
   * change browser-slot-scheduling。
   */
  browserAbsent?: () => boolean;
  /**
   * 请求唤醒并**有界等待**浏览器就绪；返回是否真的就绪。
   * `deadlineAt` = 调用方（云端 acquire 计时器）等不下去的绝对时刻——外壳据此决定何时回话，
   * **但绝不据此放弃开浏览器**：那台浏览器正是下一次重试要命中的东西。
   * 未注入时，浏览器缺席按不可唤醒处理（诚实拒绝，绝不假装能干）。
   */
  requestWake?: (deadlineAt?: number) => Promise<boolean>;
  onAcquired: (payload: EdgeTaskAcquiredPayload) => void;
  onReleased: (payload: EdgeTaskReleasedPayload) => void;
  logger?: (message: string) => void;
  now?: () => number;
  maxAbsoluteLeaseMs?: number;
}

interface QueuedAcquire {
  payload: EdgeTaskAcquirePayload;
  order: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface ActiveLease {
  payload: EdgeTaskAcquirePayload;
  acquiredAt: number;
  timer?: ReturnType<typeof setTimeout>;
  cancelledBrowseCommands: number;
}

const PRIORITY: Record<EdgeTaskAcquirePayload['priority'], number> = {
  automatic: 1,
  human: 2,
  system_recovery: 3,
};

const DEFAULT_MAX_ABSOLUTE_LEASE_MS = 30 * 60_000;
const MIN_LEASE_MS = 1_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 45_000;
const MIN_ACQUIRE_TIMEOUT_MS = 1;
/**
 * 唤醒作答的往返余量：云端在**推送前**就 arm 了自己的 acquire 计时器，所以边缘天然落后。
 * 迟一步作答 = 对着一个已经判超时走人的调用方说话（云端那头这条任务已经算「没开始」了）。
 * 宁可早答，绝不迟答。
 */
const WAKE_RTT_MARGIN_MS = 5_000;

/**
 * 同一 edge/CDP 的页面写执行权事实源。
 *
 * 普通浏览不显式持租约；第一个 acquire 到达即冻结其准入并等待当前原子动作收敛。
 * 独占任务按 priority + FIFO 授予，业务命令必须携当前 taskId。
 */
export class EdgeTaskCoordinator {
  private readonly browse: EdgeTaskBrowseGate;
  private readonly writers?: EdgeTaskPageWriterProbe;
  private readonly canAcquire: () => boolean;
  private readonly browserAbsent: () => boolean;
  private readonly requestWake: (deadlineAt?: number) => Promise<boolean>;
  /** 正在为其唤醒浏览器的 taskId（唤醒是异步有界的；期间重复 acquire 绝不重复触发唤醒）。 */
  private readonly waking = new Set<string>();
  private readonly onAcquired: (payload: EdgeTaskAcquiredPayload) => void;
  private readonly onReleased: (payload: EdgeTaskReleasedPayload) => void;
  private readonly logger: (message: string) => void;
  private readonly now: () => number;
  private readonly maxAbsoluteLeaseMs: number;
  private queue: QueuedAcquire[] = [];
  private active?: ActiveLease;
  private quiescing = false;
  private browseBlocked = false;
  private order = 0;
  private readonly terminal = new Map<string, EdgeTaskReleasedPayload['reason']>();

  constructor(options: EdgeTaskCoordinatorOptions) {
    this.browse = options.browse;
    this.writers = options.writers;
    this.canAcquire = options.canAcquire ?? (() => true);
    this.browserAbsent = options.browserAbsent ?? (() => false);
    this.requestWake = options.requestWake ?? (() => Promise.resolve(false));
    this.onAcquired = options.onAcquired;
    this.onReleased = options.onReleased;
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? Date.now;
    this.maxAbsoluteLeaseMs = options.maxAbsoluteLeaseMs ?? DEFAULT_MAX_ABSOLUTE_LEASE_MS;
  }

  acquire(payload: EdgeTaskAcquirePayload): void {
    if (!payload.taskId) return;
    // 已在为它唤醒浏览器：唤醒是异步有界的，重复的 acquire 绝不再触发第二次唤醒、也绝不当成新请求。
    if (this.waking.has(payload.taskId)) return;
    if (this.active?.payload.taskId === payload.taskId) {
      this.touch(payload.taskId);
      this.onAcquired({
        taskId: payload.taskId,
        kind: this.active.payload.kind,
        cancelledBrowseCommands: this.active.cancelledBrowseCommands,
      });
      return;
    }
    if (this.queue.some((entry) => entry.payload.taskId === payload.taskId)) return;
    if (this.terminal.has(payload.taskId)) {
      this.onReleased({ taskId: payload.taskId, reason: 'duplicate' });
      return;
    }
    if (!this.canAcquire()) {
      // 浏览器被冷待机主动收起 → 它不是坏了，是叫得醒的。走唤醒路径，绝不回一句假的 cdp_unhealthy。
      if (this.browserAbsent()) {
        void this.acquireAfterWake(payload);
        return;
      }
      this.rememberTerminal(payload.taskId, 'cdp_unhealthy');
      this.onReleased({ taskId: payload.taskId, reason: 'cdp_unhealthy' });
      this.logger(`[task] rejected taskId=${payload.taskId} reason=cdp_unhealthy`);
      return;
    }
    const queued: QueuedAcquire = { payload: this.normalise(payload), order: this.order++ };
    this.armAcquireExpiry(queued);
    this.queue.push(queued);
    this.browseBlocked = true;
    this.logger(`[task] queued taskId=${payload.taskId} kind=${payload.kind} priority=${payload.priority} acquireTimeoutMs=${queued.payload.acquireTimeoutMs}`);
    this.drainOrPreempt(queued);
  }

  /**
   * 严格高档位可抢占在跑的低档位任务（5.4）；同档 / 低档一律排队等待（FIFO，事实源＝申请到达顺序）。
   *
   * 抢占三态（由「在跑写者是否在提交窗口」决定，5.4 + 5.5 窗口豁免判据）：
   *  - `preempt`：确认不在提交窗口 → 释放在跑任务（`preempted_by_task`）→ 后续 `drain` 取消其在途写者并授予 challenger；
   *  - `window_busy`：确认在提交窗口 → **绝不强杀已提交动作**，立刻回 challenger `window_busy` + 剩余预算（不空等）；
   *  - `unknown`：探针未接线 / 无法确认 → **保守不抢占**，challenger 排队等待（回落今日行为）。
   */
  private drainOrPreempt(challenger: QueuedAcquire): void {
    if (this.active && !this.quiescing && this.strictlyOutranks(challenger.payload, this.active.payload)) {
      const inWindow = this.writers?.inCommitWindow?.();
      if (inWindow === false) {
        this.logger(`[task] preempting active=${this.active.payload.taskId} for challenger=${challenger.payload.taskId}（严格高档位、不在提交窗口）`);
        // 释放在跑任务 → finishActive 触发 drain：drain 的 quiesce 会取消被抢占写者（browse 让路 + 取消在途发布），
        // 收敛后授予 challenger。被抢占任务由云端事件驱动重投（7.1），绝不进 terminal。
        this.finishActive('preempted_by_task');
        return;
      }
      if (inWindow === true) {
        this.rejectChallengerWindowBusy(challenger, this.writers?.commitWindowRemainingMs?.());
        return;
      }
      // inWindow === undefined：无法确认「不在窗口」→ 保守不抢占，challenger 落到下面 drain（active 在跑时 drain 立即返回、challenger 排队）。
    }
    void this.drain();
  }

  private strictlyOutranks(a: EdgeTaskAcquirePayload, b: EdgeTaskAcquirePayload): boolean {
    return PRIORITY[a.priority] > PRIORITY[b.priority];
  }

  /**
   * 在跑写者处于不可逆提交窗口：拒绝抢占、回 `window_busy` + 剩余预算。
   * **绝不 rememberTerminal**——`window_busy` 是可重试的「稍后再来」而非终态；进 terminal 会让云端按剩余预算
   * 重排的 acquire 被当 `duplicate` 摘掉，抢占永远发不出去。在跑任务保持不动、继续持租约。
   */
  private rejectChallengerWindowBusy(challenger: QueuedAcquire, remainingMs?: number): void {
    const idx = this.queue.indexOf(challenger);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.clearAcquireExpiry(challenger);
    this.onReleased({ taskId: challenger.payload.taskId, reason: 'window_busy', windowRemainingMs: remainingMs });
    this.logger(`[task] window_busy challenger=${challenger.payload.taskId} remainingMs=${remainingMs ?? '-'}（提交窗口占用，不强杀在跑写者）`);
  }

  /**
   * 浏览器缺席（冷待机）→ 请求唤醒、有界等待、就绪后走正常授予路径（change browser-slot-scheduling）。
   *
   * 唤醒失败回 `browser_wake_failed`——一个**独立于** `cdp_unhealthy` 的诚实原因：前者可恢复（浏览器
   * 是我们自己收起来的），后者是控制面故障。云端据此区分「该重试」与「该报警」。
   */
  private async acquireAfterWake(payload: EdgeTaskAcquirePayload): Promise<void> {
    const taskId = payload.taskId;
    this.waking.add(taskId);
    // 调用方（云端）的死线是唯一权威：它在 push **之前**就 arm 了自己的计时器，我们只准**提前**作答、
    // 绝不迟答（迟答 = 对着一个已经走人的调用方说话）。扣一个往返余量，把这场竞速让给云端。
    const deadlineAt = this.now() + Math.max(0, (this.normalise(payload).acquireTimeoutMs ?? 0) - WAKE_RTT_MARGIN_MS);
    this.logger(`[task] browser parked; requesting wake taskId=${taskId} kind=${payload.kind} budgetMs=${deadlineAt - this.now()}`);
    let ready = false;
    try {
      ready = await this.requestWake(deadlineAt);
    } catch (error) {
      this.logger(`[task] wake threw taskId=${taskId}: ${(error as Error)?.message || String(error)}`);
      ready = false;
    }
    this.waking.delete(taskId);
    // 唤醒期间可能已被 release / 超时判终态：不复活一个已经了结的任务。
    if (this.terminal.has(taskId)) return;
    if (!ready || !this.canAcquire()) {
      this.rememberTerminal(taskId, 'browser_wake_failed');
      this.onReleased({ taskId, reason: 'browser_wake_failed' });
      this.logger(`[task] rejected taskId=${taskId} reason=browser_wake_failed`);
      return;
    }
    this.logger(`[task] browser woken; resuming acquire taskId=${taskId}`);
    this.acquire(payload);
  }

  /**
   * 是否有任务持着执行权（含排队中 / 正在让位）。
   *
   * 释放浏览器与在跑租约**必须互斥**：绝不把浏览器从一个正在执行的任务底下抽走。冷待机据此拒绝进入。
   */
  hasActiveLease(): boolean {
    return !!this.active || this.queue.length > 0 || this.quiescing || this.waking.size > 0 || this.publishInFlight();
  }

  release(payload: EdgeTaskReleasePayload): void {
    const taskId = payload.taskId;
    if (this.active?.payload.taskId === taskId) {
      this.finishActive('released');
      return;
    }
    const queued = this.queue.findIndex((entry) => entry.payload.taskId === taskId);
    if (queued >= 0) {
      const [entry] = this.queue.splice(queued, 1);
      if (entry) this.clearAcquireExpiry(entry);
      this.rememberTerminal(taskId, 'released');
      this.onReleased({ taskId, reason: 'released' });
      void this.drain();
      return;
    }
    this.onReleased({ taskId, reason: this.terminal.has(taskId) ? 'duplicate' : 'not_owner' });
  }

  /** 当前业务命令是否拥有页面写权。普通浏览仅在协调器完全空闲时允许。 */
  canExecute(taskId?: string): boolean {
    if (!this.canAcquire()) return false;
    if (this.active) return !!taskId && this.active.payload.taskId === taskId;
    // 在途发布写（租约已释放但 dispatch/后置校验仍在跑）：普通浏览命令必须让位，绝不导航走发布页
    // （治 5.9「已离开发布页 = 发布成功」假成功——抢占方 / 恢复导航会替发布把页面导走）。
    if (this.publishInFlight()) return false;
    if (this.quiescing || this.queue.length > 0 || this.browseBlocked) return false;
    return !taskId;
  }

  touch(taskId: string): boolean {
    if (this.active?.payload.taskId !== taskId) return false;
    this.armExpiry(this.active);
    return true;
  }

  get currentTaskId(): string | undefined {
    return this.active?.payload.taskId;
  }

  get blocksBrowse(): boolean {
    return this.browseBlocked || this.quiescing || !!this.active || this.queue.length > 0 || this.publishInFlight();
  }

  /** CDP 软重连已完成后的恢复钩子；只在没有既有任务 owner 时解除此前让位留下的 browse 冻结。 */
  resumeAfterControlRecovery(): void {
    if (!this.canAcquire() || this.active || this.quiescing || this.queue.length > 0 || this.browseBlocked) return;
    this.browseBlocked = true;
    void this.resumeBrowseIfIdle();
  }

  /** 云端连接/进程关闭时本地立即作废全部旧所有权。 */
  reset(reason = 'connection_reset'): void {
    if (this.active?.timer) clearTimeout(this.active.timer);
    const activeId = this.active?.payload.taskId;
    this.active = undefined;
    for (const queued of this.queue) this.clearAcquireExpiry(queued);
    this.queue = [];
    this.quiescing = false;
    this.logger(`[task] reset reason=${reason}${activeId ? ` active=${activeId}` : ''}`);
    void this.resumeBrowseIfIdle();
  }

  private normalise(payload: EdgeTaskAcquirePayload): EdgeTaskAcquirePayload {
    const leaseMs = Number.isFinite(payload.leaseMs) ? Math.max(MIN_LEASE_MS, payload.leaseMs) : MIN_LEASE_MS;
    const requestedAcquireTimeoutMs = Number.isFinite(payload.acquireTimeoutMs)
      ? payload.acquireTimeoutMs!
      : DEFAULT_ACQUIRE_TIMEOUT_MS;
    const acquireTimeoutMs = Math.max(
      MIN_ACQUIRE_TIMEOUT_MS,
      Math.min(requestedAcquireTimeoutMs, this.maxAbsoluteLeaseMs),
    );
    return { ...payload, leaseMs: Math.min(leaseMs, this.maxAbsoluteLeaseMs), acquireTimeoutMs };
  }

  private pickNext(): QueuedAcquire | undefined {
    if (this.queue.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const current = this.queue[i]!;
      const selected = this.queue[best]!;
      const priorityDelta = PRIORITY[current.payload.priority] - PRIORITY[selected.payload.priority];
      if (priorityDelta > 0 || (priorityDelta === 0 && current.order < selected.order)) best = i;
    }
    const [next] = this.queue.splice(best, 1);
    if (next) this.clearAcquireExpiry(next);
    return next;
  }

  private armAcquireExpiry(queued: QueuedAcquire): void {
    const delay = queued.payload.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    queued.timer = setTimeout(() => {
      const index = this.queue.indexOf(queued);
      if (index < 0) return;
      this.queue.splice(index, 1);
      this.rememberTerminal(queued.payload.taskId, 'expired');
      this.onReleased({ taskId: queued.payload.taskId, reason: 'expired' });
      this.logger(`[task] acquire expired taskId=${queued.payload.taskId}`);
      void this.drain();
    }, delay);
    queued.timer.unref?.();
  }

  private clearAcquireExpiry(queued: QueuedAcquire): void {
    if (!queued.timer) return;
    clearTimeout(queued.timer);
    queued.timer = undefined;
  }

  private async drain(): Promise<void> {
    if (this.active || this.quiescing) return;
    if (!this.canAcquire()) {
      this.rejectQueuedForUnhealthyCdp();
      // 浏览器控制未恢复时绝不能为了清理租约而调用 resumeAfterTask；那会再次触碰不可信的页面。
      this.browseBlocked = false;
      return;
    }
    if (this.queue.length === 0) {
      await this.resumeBrowseIfIdle();
      return;
    }
    this.quiescing = true;
    let cancelled = 0;
    try {
      cancelled = await this.quiesceAllWriters();
    } catch (err) {
      // 交接未收敛 = 某个页面写者（browse 真写段 / 在途发布）超预算，页面可能仍在被它改写。
      // **绝不能吞掉异常后继续往下授予**（既有隐患：catch 只打日志、随即照常 acquire ⇒ 在一个仍在
      // 写页面的孤儿动作之上授权，两个写者交错打进同一个页面）。诚实终结排队申请、解除浏览冻结、
      // 回到可继续协调的状态（change lease-strict-preemption）。
      this.quiescing = false;
      // 结构判据（memory failure-must-be-structural）：先分清「控制面丢失」还是「写者收到取消仍不停手」。
      if (!this.canAcquire()) {
        this.logger(`[task] quiesce failed 且控制面已失: ${err instanceof Error ? err.message : String(err)} → cdp_unhealthy`);
        this.rejectQueuedForUnhealthyCdp();
      } else {
        this.logger(`[task] quiesce failed（写者收到取消仍不停手）: ${err instanceof Error ? err.message : String(err)} → 判控制面故障 yield_timeout`);
        this.rejectQueuedForControlPlaneFault();
      }
      this.browseBlocked = false;
      return;
    } finally {
      this.quiescing = false;
    }
    if (!this.canAcquire()) {
      this.rejectQueuedForUnhealthyCdp();
      // 等 cdp.control_recovered 通过 resumeAfterControlRecovery() 再恢复浏览。
      this.browseBlocked = false;
      return;
    }
    // 高优先级申请可能在 quiesce 等待期间到达；到安全边界后重新选队头。
    const next = this.pickNext();
    if (!next) {
      await this.resumeBrowseIfIdle();
      return;
    }
    const lease: ActiveLease = {
      payload: next.payload,
      acquiredAt: this.now(),
      cancelledBrowseCommands: cancelled,
    };
    this.active = lease;
    this.armExpiry(lease);
    this.logger(`[task] acquired taskId=${next.payload.taskId} kind=${next.payload.kind} cancelledBrowse=${cancelled}`);
    this.onAcquired({
      taskId: next.payload.taskId,
      kind: next.payload.kind,
      cancelledBrowseCommands: cancelled,
    });
  }

  private armExpiry(lease: ActiveLease): void {
    if (lease.timer) clearTimeout(lease.timer);
    const absoluteRemaining = lease.acquiredAt + this.maxAbsoluteLeaseMs - this.now();
    const delay = Math.max(1, Math.min(lease.payload.leaseMs, absoluteRemaining));
    lease.timer = setTimeout(() => {
      if (this.active !== lease) return;
      this.logger(`[task] expired taskId=${lease.payload.taskId}`);
      this.finishActive('expired');
    }, delay);
    lease.timer.unref?.();
  }

  private finishActive(reason: 'released' | 'expired' | 'preempted_by_task'): void {
    const lease = this.active;
    if (!lease) return;
    if (lease.timer) clearTimeout(lease.timer);
    this.active = undefined;
    // 被抢占的任务会被云端事件驱动重投（7.1）——绝不进 terminal，否则重投的同 taskId acquire 被当 duplicate 摘掉、白抢占。
    if (reason !== 'preempted_by_task') this.rememberTerminal(lease.payload.taskId, reason);
    this.onReleased({ taskId: lease.payload.taskId, reason });
    this.logger(`[task] ${reason} taskId=${lease.payload.taskId}`);
    void this.drain();
  }

  private async resumeBrowseIfIdle(): Promise<void> {
    if (this.active || this.quiescing || this.queue.length > 0 || !this.browseBlocked) return;
    // 在途发布写未收敛前绝不恢复浏览导航（否则恢复的导航把发布页导走 → 发布后置校验误判成功，5.9）。
    // 发布 dispatch 收敛后由 notifyPublishSettled() 再触发一次本方法。
    if (this.publishInFlight()) return;
    try {
      await this.browse.resumeAfterTask();
    } catch (err) {
      this.logger(`[task] browse resume failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 恢复导航/重报期间继续封住迟到的旧普通命令；只有恢复收敛且没有新接管申请才真正放行。
    if (!this.active && !this.quiescing && this.queue.length === 0) this.browseBlocked = false;
  }

  /** 在途发布写收敛后调用（5.3/5.9 配套）：若协调器空闲则恢复浏览，避免发布 dispatch 结束后浏览永久冻结。 */
  notifyPublishSettled(): void {
    void this.resumeBrowseIfIdle();
  }

  private publishInFlight(): boolean {
    return this.writers?.publishInFlight?.() === true;
  }

  /**
   * 让位 / 抢占时取消**全部**在跑页面写者并有界等待收敛：browse 让路 + 取消在途发布（真取消，5.3）。
   * 用 `allSettled` 保证两个写者的取消**都被下发**（一个抛出不能让另一个漏取消）；任一未收敛即抛出 →
   * drain 据此判控制面故障。返回被取消的命令 / 发布总数。
   */
  private async quiesceAllWriters(): Promise<number> {
    // 仅在**确有在途发布写**时下发发布取消——无在途发布时不空跑 cancelPublish（普通首次让位路径不触发）。
    const cancelPublish = this.publishInFlight() && this.writers?.cancelPublish
      ? this.writers.cancelPublish()
      : Promise.resolve(0);
    const results = await Promise.allSettled([
      this.browse.quiesceForTask(),
      cancelPublish,
    ]);
    let cancelled = 0;
    let firstError: unknown;
    for (const r of results) {
      if (r.status === 'fulfilled') cancelled += r.value ?? 0;
      else if (firstError === undefined) firstError = r.reason;
    }
    if (firstError !== undefined) throw firstError;
    return cancelled;
  }

  private rememberTerminal(taskId: string, reason: EdgeTaskReleasedPayload['reason']): void {
    this.terminal.set(taskId, reason);
    if (this.terminal.size <= 256) return;
    const first = this.terminal.keys().next().value as string | undefined;
    if (first) this.terminal.delete(first);
  }

  /** CDP 在让位过程中失去可靠控制时，所有尚未授予的任务都必须即时显式失败。 */
  private rejectQueuedForUnhealthyCdp(): void {
    const queued = this.queue;
    this.queue = [];
    for (const entry of queued) {
      this.clearAcquireExpiry(entry);
      this.rememberTerminal(entry.payload.taskId, 'cdp_unhealthy');
      this.onReleased({ taskId: entry.payload.taskId, reason: 'cdp_unhealthy' });
      this.logger(`[task] rejected taskId=${entry.payload.taskId} reason=cdp_unhealthy`);
    }
  }

  /**
   * 让位交接未在预算内收敛：某个页面写者**收到取消后仍不停手**——本质是控制面故障（§5.5 语义判据，
   * 而非算术边界；参照 memory failure-must-be-structural）。MUST NOT 授予（绝不在仍在写页面的动作头上
   * 再放一个人进来）、MUST NOT 谎称已收敛。
   *
   * 终态用 `yield_timeout`（change lease-strict-preemption 6.1 新增）——它明确指向**人工动作「请运营重启
   * 浏览器客户端」**（§10.4），不是自愈、也不是「一个动作跑太久」的良性 expired。控制面**丢失**（CDP 不可
   * 用）是另一回事，由调用方在 catch 里先分流到 `rejectQueuedForUnhealthyCdp`（cdp_unhealthy）。
   */
  private rejectQueuedForControlPlaneFault(): void {
    const queued = this.queue;
    this.queue = [];
    for (const entry of queued) {
      this.clearAcquireExpiry(entry);
      this.rememberTerminal(entry.payload.taskId, 'yield_timeout');
      this.onReleased({ taskId: entry.payload.taskId, reason: 'yield_timeout' });
      this.logger(`[task] rejected taskId=${entry.payload.taskId} reason=yield_timeout（写者收到取消仍不停手 → 请运营重启浏览器客户端）`);
    }
  }
}
