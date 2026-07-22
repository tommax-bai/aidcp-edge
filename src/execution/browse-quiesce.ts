/** A page writer did not reach an honest takeover boundary within the lease budget. */
export class BrowseQuiesceTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`浏览交接未在 ${timeoutMs}ms 内收敛`);
    this.name = 'BrowseQuiesceTimeoutError';
  }
}

export const DEFAULT_TASK_QUIESCE_MS = Number(process.env.AIDCP_TASK_QUIESCE_MS ?? 30_000);
