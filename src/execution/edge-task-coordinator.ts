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

export interface EdgeTaskCoordinatorOptions {
  browse: EdgeTaskBrowseGate;
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
    void this.drain();
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
    return !!this.active || this.queue.length > 0 || this.quiescing || this.waking.size > 0;
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
    return this.browseBlocked || this.quiescing || !!this.active || this.queue.length > 0;
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
      cancelled = await this.browse.quiesceForTask();
    } catch (err) {
      // 交接未收敛 = 真写段里有个动作超预算，页面可能仍在被它改写。
      // **绝不能吞掉异常后继续往下授予**（既有隐患：catch 只打日志、随即照常 acquire ⇒ 在一个仍在
      // 写页面的孤儿动作之上授权，两个写者交错打进同一个页面）。诚实终结排队申请、解除浏览冻结、
      // 回到可继续协调的状态（change lease-strict-preemption）。
      this.logger(`[task] quiesce failed: ${err instanceof Error ? err.message : String(err)} → 不授予、诚实终结排队申请`);
      this.quiescing = false;
      this.rejectQueuedForQuiesceTimeout();
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

  private finishActive(reason: 'released' | 'expired'): void {
    const lease = this.active;
    if (!lease) return;
    if (lease.timer) clearTimeout(lease.timer);
    this.active = undefined;
    this.rememberTerminal(lease.payload.taskId, reason);
    this.onReleased({ taskId: lease.payload.taskId, reason });
    this.logger(`[task] ${reason} taskId=${lease.payload.taskId}`);
    void this.drain();
  }

  private async resumeBrowseIfIdle(): Promise<void> {
    if (this.active || this.quiescing || this.queue.length > 0 || !this.browseBlocked) return;
    try {
      await this.browse.resumeAfterTask();
    } catch (err) {
      this.logger(`[task] browse resume failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 恢复导航/重报期间继续封住迟到的旧普通命令；只有恢复收敛且没有新接管申请才真正放行。
    if (!this.active && !this.quiescing && this.queue.length === 0) this.browseBlocked = false;
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
   * 交接未在预算内收敛：真写段里有一个超出预算的动作，页面可能仍在被它改写。
   * MUST NOT 授予（绝不在一个仍在写页面的动作头上再放一个人进来）、MUST NOT 谎称已收敛。
   *
   * 终态用已有的 `expired`（申请没能在预算内被受理），**绝不复用 `cdp_unhealthy`**——那是假话：
   * 浏览器控制面是健康的，只是有个动作跑太久；而云端会据此对运营发出「请重启浏览器客户端」的
   * 误导指令。零协议改动（change lease-strict-preemption）。
   */
  private rejectQueuedForQuiesceTimeout(): void {
    const queued = this.queue;
    this.queue = [];
    for (const entry of queued) {
      this.clearAcquireExpiry(entry);
      this.rememberTerminal(entry.payload.taskId, 'expired');
      this.onReleased({ taskId: entry.payload.taskId, reason: 'expired' });
      this.logger(`[task] rejected taskId=${entry.payload.taskId} reason=quiesce_timeout（回执 expired）`);
    }
  }
}
