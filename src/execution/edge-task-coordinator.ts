import type {
  EdgeTaskAcquirePayload,
  EdgeTaskAcquiredPayload,
  EdgeTaskReleasePayload,
  EdgeTaskReleasedPayload,
} from '../comm/protocol.js';

export interface EdgeTaskBrowseGate {
  quiesceForTask(): Promise<number>;
  resumeAfterTask(): Promise<void>;
}

export interface EdgeTaskCoordinatorOptions {
  browse: EdgeTaskBrowseGate;
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
 * 同一 edge/CDP 的页面写执行权事实源。
 *
 * 普通浏览不显式持租约；第一个 acquire 到达即冻结其准入并等待当前原子动作收敛。
 * 独占任务按 priority + FIFO 授予，业务命令必须携当前 taskId。
 */
export class EdgeTaskCoordinator {
  private readonly browse: EdgeTaskBrowseGate;
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
    this.onAcquired = options.onAcquired;
    this.onReleased = options.onReleased;
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? Date.now;
    this.maxAbsoluteLeaseMs = options.maxAbsoluteLeaseMs ?? DEFAULT_MAX_ABSOLUTE_LEASE_MS;
  }

  acquire(payload: EdgeTaskAcquirePayload): void {
    if (!payload.taskId) return;
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
    const queued: QueuedAcquire = { payload: this.normalise(payload), order: this.order++ };
    this.armAcquireExpiry(queued);
    this.queue.push(queued);
    this.browseBlocked = true;
    this.logger(`[task] queued taskId=${payload.taskId} kind=${payload.kind} priority=${payload.priority} acquireTimeoutMs=${queued.payload.acquireTimeoutMs}`);
    void this.drain();
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
    if (this.queue.length === 0) {
      await this.resumeBrowseIfIdle();
      return;
    }
    this.quiescing = true;
    let cancelled = 0;
    try {
      cancelled = await this.browse.quiesceForTask();
    } catch (err) {
      this.logger(`[task] quiesce failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.quiescing = false;
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
}
