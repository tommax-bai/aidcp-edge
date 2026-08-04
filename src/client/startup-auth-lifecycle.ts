import type { CoreLifecycleCommand } from './core-lifecycle.js';

export type StartupAuthLifecycleSettlement = 'exited' | 'resume';

export interface StartupAuthLifecycleDependencies {
  closeOwnedBrowser(): Promise<boolean>;
  reportBrowserClosed(): Promise<boolean> | boolean;
  reportPaused(): void;
  reportResumed(): void;
  reportCloseFailed(): void;
  releaseInterrupt(command: CoreLifecycleCommand): void;
  nextCommand(): Promise<CoreLifecycleCommand>;
  exit(code: number): void;
}

function isStopCommand(command: CoreLifecycleCommand): command is 'pause' | 'pause_and_exit' | 'close' {
  return command === 'pause' || command === 'pause_and_exit' || command === 'close';
}

/**
 * Settles a lifecycle stop that arrives before the normal runtime controller exists.
 * Startup remains behind this gate after an unconfirmed close; only an explicit retry
 * or resume can move it again, so no identity/Cloud work leaks past the stop intent.
 */
export async function settleStartupAuthLifecycleInterrupt(
  initialCommand: 'pause' | 'pause_and_exit' | 'close',
  deps: StartupAuthLifecycleDependencies,
): Promise<StartupAuthLifecycleSettlement> {
  let command = initialCommand;
  for (;;) {
    const browserClosed = await deps.closeOwnedBrowser().catch(() => false);
    const evidenceDelivered = browserClosed && await deps.reportBrowserClosed();
    if (evidenceDelivered) {
      if (command === 'pause' || command === 'pause_and_exit') deps.reportPaused();
      deps.exit(0);
      return 'exited';
    }

    deps.reportCloseFailed();
    deps.releaseInterrupt(command);

    for (;;) {
      const next = await deps.nextCommand();
      if (next === 'resume') {
        deps.reportResumed();
        return 'resume';
      }
      if (isStopCommand(next)) {
        command = next;
        break;
      }
    }
  }
}
