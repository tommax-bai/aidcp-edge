import type { CoreLifecycleCommand } from './core-lifecycle.js';

export type LifecycleAuthInterruptCommand = Extract<
  CoreLifecycleCommand,
  'pause' | 'pause_and_exit' | 'close'
>;

const INTERRUPT_PRIORITY: LifecycleAuthInterruptCommand[] = [
  'close',
  'pause_and_exit',
  'pause',
];

function isInterruptCommand(
  command: CoreLifecycleCommand,
): command is LifecycleAuthInterruptCommand {
  return command === 'pause' || command === 'pause_and_exit' || command === 'close';
}

/**
 * Lifecycle transitions are serialized, but an intent to stop must interrupt an in-flight browser
 * wake immediately instead of waiting behind it. Counts retain duplicate intents until each queued
 * lifecycle request settles.
 */
export class LifecycleAuthInterruptTracker {
  private readonly counts = new Map<LifecycleAuthInterruptCommand, number>();

  note(command: CoreLifecycleCommand): void {
    if (!isInterruptCommand(command)) return;
    this.counts.set(command, (this.counts.get(command) ?? 0) + 1);
  }

  release(command: CoreLifecycleCommand): void {
    if (!isInterruptCommand(command)) return;
    const count = this.counts.get(command) ?? 0;
    if (count <= 1) this.counts.delete(command);
    else this.counts.set(command, count - 1);
  }

  current(): LifecycleAuthInterruptCommand | null {
    return INTERRUPT_PRIORITY.find((command) => (this.counts.get(command) ?? 0) > 0) ?? null;
  }
}
