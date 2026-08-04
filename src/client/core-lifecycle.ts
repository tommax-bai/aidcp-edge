export type CoreLifecycleCommand = 'pause' | 'pause_and_exit' | 'resume' | 'close' | 'standby' | 'wake';
export type CoreLifecycleState = 'active' | 'pausing' | 'paused' | 'standby' | 'waking' | 'finalizing' | 'finished';

export interface CoreLifecycleDependencies {
  deactivate(reason: string): Promise<void>;
  /** Stop/resume automation at a page-safe boundary without closing Cloud, CDP, browser, or the core process. */
  pauseAutomation?: () => Promise<void>;
  resumeAutomation?: () => Promise<void>;
  closeOwnedBrowser(): Promise<boolean>;
  enterStandby?: () => Promise<boolean>;
  /**
   * 冷待机唤醒：**原地重开浏览器 + 重建浏览器层**，核心进程与云端连接全程不动（change browser-slot-scheduling）。
   *
   * 与 `resume` 的本质区别：`resume` 走 finalize → 进程退出、由外壳重起（一次完整冷启，云端连接断一次）。
   * 待机唤醒会变成高频动作（每小时都可能发生），不能每次都掀一次桌子。返回 false = 唤醒失败，
   * 会话如实**留在待机态**（可再次唤醒），绝不假装已就绪。
   */
  wakeFromStandby?: (resumeAutomation: boolean) => Promise<boolean>;
  exit(code: number): void;
  onPaused?(): void;
  onResumed?(): void;
  onStandby?(): void;
  onWoken?(): void;
  onWakeFailed?(reason: string): void;
  /** Report confirmed owned-browser death to the supervisor before an intentional process exit. */
  reportBrowserClosed?(): Promise<boolean> | boolean;
  onCloseFailed?(): void;
  logger?(message: string): void;
}

export interface CoreFinalizeOptions {
  exitCode: number;
  reason: string;
  preserveBrowser: boolean;
  requireConfirmedClose?: boolean;
}

/** Parse only the narrow local child-process lifecycle protocol. */
export function parseCoreLifecycleCommand(message: unknown): CoreLifecycleCommand | null {
  if (!message || typeof message !== 'object') return null;
  const type = (message as { type?: unknown }).type;
  if (type === 'lifecycle.pause') return 'pause';
  if (type === 'lifecycle.pause_and_exit') return 'pause_and_exit';
  if (type === 'lifecycle.resume') return 'resume';
  if (type === 'lifecycle.close') return 'close';
  if (type === 'lifecycle.standby') return 'standby';
  if (type === 'lifecycle.wake') return 'wake';
  return null;
}

/**
 * Serializes local lifecycle intents while retaining the owned browser handle across pause.
 * The caller owns process IPC/signal wiring; this class owns only transition semantics.
 */
export class CoreLifecycleController {
  private transition: Promise<void> = Promise.resolve();
  private deactivatePromise: Promise<void> | undefined;
  private currentState: CoreLifecycleState;
  private finalizing = false;
  private automationPaused = false;

  constructor(
    private readonly deps: CoreLifecycleDependencies,
    initialState: 'active' | 'paused' | 'standby' = 'active',
    initialAutomationPaused = initialState === 'paused',
  ) {
    this.currentState = initialState;
    this.automationPaused = initialAutomationPaused;
  }

  get state(): CoreLifecycleState {
    return this.currentState;
  }

  request(command: CoreLifecycleCommand): Promise<void> {
    return this.enqueue(async () => {
      if (command === 'pause_and_exit') {
        await this.pause();
        await this.finalize({
          exitCode: 0,
          reason: 'user_pause_disconnect_engine',
          preserveBrowser: false,
          requireConfirmedClose: true,
        });
        return;
      }
      if (command === 'pause') {
        await this.pause();
        return;
      }
      if (command === 'standby') {
        await this.standby();
        return;
      }
      if (command === 'wake') {
        await this.wake();
        return;
      }
      if (command === 'resume' && this.deps.resumeAutomation) {
        await this.resume();
        return;
      }
      await this.finalize({
        exitCode: 0,
        reason: command === 'resume' ? 'legacy_user_resume' : 'user_close',
        preserveBrowser: command === 'resume',
        requireConfirmedClose: command === 'close',
      });
    });
  }

  shutdown(opts: CoreFinalizeOptions): Promise<void> {
    return this.enqueue(() => this.finalize(opts));
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.transition.then(work, work);
    this.transition = next.catch((error) => {
      this.log(`[aidcp-edge] lifecycle transition failed: ${(error as Error)?.message || String(error)}`);
    });
    return next;
  }

  private async pause(): Promise<void> {
    if (this.finalizing || this.currentState === 'finished') return;
    if (!this.automationPaused) {
      const browserWasInStandby = this.currentState === 'standby';
      this.currentState = 'pausing';
      if (this.deps.pauseAutomation) await this.deps.pauseAutomation();
      else await this.ensureDeactivated('user_pause');
      this.automationPaused = true;
      // Browser state and automation state are independent axes. Pausing while the browser is
      // already absent must retain standby so a later explicit resume can still use the normal
      // in-place wake path instead of being mistaken for an already-open browser.
      this.currentState = browserWasInStandby ? 'standby' : 'paused';
      this.log('[aidcp-edge] lifecycle paused: automation stopped, core/cloud/browser retained');
    }
    this.deps.onPaused?.();
  }

  private async resume(): Promise<void> {
    if (this.finalizing || this.currentState === 'finished') return;
    if (this.automationPaused) {
      const browserIsInStandby = this.currentState === 'standby';
      if (!browserIsInStandby) await this.deps.resumeAutomation?.();
      this.automationPaused = false;
      this.currentState = browserIsInStandby ? 'standby' : 'active';
      this.log('[aidcp-edge] lifecycle resumed: automation restarted in place, core/cloud/browser retained');
    }
    this.deps.onResumed?.();
  }

  private async standby(): Promise<void> {
    if (this.finalizing || this.currentState === 'finished') return;
    if (this.currentState === 'standby') {
      this.deps.onStandby?.();
      return;
    }
    this.currentState = 'pausing';
    const confirmed = await this.deps.enterStandby?.();
    if (!confirmed) {
      this.currentState = 'paused';
      this.deps.onCloseFailed?.();
      return;
    }
    this.currentState = 'standby';
    this.log('[aidcp-edge] lifecycle standby: browser closed, cloud connection retained');
    this.deps.onStandby?.();
  }

  /**
   * 冷待机唤醒（change browser-slot-scheduling）：原地重开浏览器，进程与云端连接不动。
   *
   * 幂等：不在待机态就直接确认（外壳可能重复问；重复唤醒绝不重开第二个浏览器）。
   * 失败即**留在待机态**并如实告知——绝不把一个没起来的浏览器报成就绪（那是静默假成功）。
   */
  private async wake(): Promise<void> {
    if (this.finalizing || this.currentState === 'finished') return;
    if (this.currentState !== 'standby') {
      this.deps.onWoken?.();
      return;
    }
    if (!this.deps.wakeFromStandby) {
      this.deps.onWakeFailed?.('wake_not_supported');
      return;
    }
    this.currentState = 'waking';
    let ok = false;
    try {
      ok = await this.deps.wakeFromStandby(!this.automationPaused);
    } catch (error) {
      this.currentState = 'standby';
      const reason = (error as Error)?.message || String(error);
      this.log(`[aidcp-edge] lifecycle wake failed: ${reason}`);
      this.deps.onWakeFailed?.(reason);
      return;
    }
    if (!ok) {
      this.currentState = 'standby';
      this.log('[aidcp-edge] lifecycle wake failed: browser did not come back; staying in standby');
      this.deps.onWakeFailed?.('wake_failed');
      return;
    }
    this.currentState = this.automationPaused ? 'paused' : 'active';
    this.log('[aidcp-edge] lifecycle woken: browser rebuilt in place, core process and cloud link untouched');
    this.deps.onWoken?.();
  }

  private async finalize(opts: CoreFinalizeOptions): Promise<void> {
    if (this.finalizing || this.currentState === 'finished') return;
    this.finalizing = true;
    this.currentState = 'finalizing';
    await this.ensureDeactivated(opts.reason);

    let browserClosed = false;
    if (opts.preserveBrowser) {
      this.log(`[aidcp-edge] lifecycle exit preserves owned browser (reason=${opts.reason})`);
    } else {
      const confirmed = await this.deps.closeOwnedBrowser();
      if (!confirmed) {
        this.log('[aidcp-edge] lifecycle close could not confirm the owned browser is closed');
        if (opts.requireConfirmedClose) {
          this.finalizing = false;
          this.currentState = 'paused';
          this.deps.onCloseFailed?.();
          return;
        }
      } else {
        browserClosed = true;
      }
    }

    if (browserClosed) {
      const reported = await Promise.resolve(this.deps.reportBrowserClosed?.() ?? true).catch(() => false);
      if (!reported) {
        this.log('[aidcp-edge] lifecycle browser close was confirmed but supervisor evidence was not delivered');
        if (opts.requireConfirmedClose) {
          this.finalizing = false;
          this.currentState = 'paused';
          this.deps.onCloseFailed?.();
          return;
        }
      }
    }

    this.currentState = 'finished';
    this.deps.exit(opts.exitCode);
  }

  private ensureDeactivated(reason: string): Promise<void> {
    if (!this.deactivatePromise) this.deactivatePromise = this.deps.deactivate(reason);
    return this.deactivatePromise;
  }

  private log(message: string): void {
    this.deps.logger?.(message);
  }
}
