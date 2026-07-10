export type CoreLifecycleCommand = 'pause' | 'resume' | 'close';
export type CoreLifecycleState = 'active' | 'pausing' | 'paused' | 'finalizing' | 'finished';

export interface CoreLifecycleDependencies {
  deactivate(reason: string): Promise<void>;
  closeOwnedBrowser(): Promise<boolean>;
  exit(code: number): void;
  onPaused?(): void;
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
  if (type === 'lifecycle.resume') return 'resume';
  if (type === 'lifecycle.close') return 'close';
  return null;
}

/**
 * Serializes local lifecycle intents while retaining the owned browser handle across pause.
 * The caller owns process IPC/signal wiring; this class owns only transition semantics.
 */
export class CoreLifecycleController {
  private transition: Promise<void> = Promise.resolve();
  private deactivatePromise: Promise<void> | undefined;
  private currentState: CoreLifecycleState = 'active';
  private finalizing = false;

  constructor(private readonly deps: CoreLifecycleDependencies) {}

  get state(): CoreLifecycleState {
    return this.currentState;
  }

  request(command: CoreLifecycleCommand): Promise<void> {
    return this.enqueue(async () => {
      if (command === 'pause') {
        await this.pause();
        return;
      }
      await this.finalize({
        exitCode: 0,
        reason: command === 'resume' ? 'user_resume' : 'user_close',
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
    if (this.currentState !== 'paused') {
      this.currentState = 'pausing';
      await this.ensureDeactivated('user_pause');
      this.currentState = 'paused';
      this.log('[aidcp-edge] lifecycle paused: automation stopped, owned browser retained');
    }
    this.deps.onPaused?.();
  }

  private async finalize(opts: CoreFinalizeOptions): Promise<void> {
    if (this.finalizing || this.currentState === 'finished') return;
    this.finalizing = true;
    this.currentState = 'finalizing';
    await this.ensureDeactivated(opts.reason);

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
