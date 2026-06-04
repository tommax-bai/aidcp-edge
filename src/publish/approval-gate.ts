import { readFile, rm } from 'node:fs/promises';

import type { PublishRequestPayload } from '../comm/protocol.js';

export interface PublishApprovalSignal {
  requestId: string;
  approved: boolean;
  ts: number;
  payload: Pick<PublishRequestPayload, 'title' | 'content' | 'tags'>;
}

export interface PublishApprovalGateOptions {
  requestId: string;
  signalDir?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  consumeSignal?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readSignal?: (path: string) => Promise<string>;
  removeSignal?: (path: string) => Promise<void>;
}

export interface PublishApprovalGateResult {
  ok: boolean;
  requestId: string;
  signalPath: string;
  approved?: boolean;
  reason?: string;
  signal?: PublishApprovalSignal;
}

const DEFAULT_SIGNAL_DIR = '/tmp';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildPublishApprovalRequestId(now: () => number = Date.now): string {
  return `edge-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildPublishApprovalSignalPath(requestId: string, signalDir = DEFAULT_SIGNAL_DIR): string {
  return `${signalDir.replace(/\/$/, '')}/aidcp-publish-approve-${requestId}.json`;
}

function validateSignal(raw: unknown, requestId: string): PublishApprovalSignal {
  if (!raw || typeof raw !== 'object') {
    throw new Error('signal_invalid_json');
  }
  const signal = raw as Partial<PublishApprovalSignal>;
  if (signal.requestId !== requestId) {
    throw new Error(`signal_request_id_mismatch:${String(signal.requestId ?? '')}`);
  }
  if (typeof signal.approved !== 'boolean') {
    throw new Error('signal_missing_approved');
  }
  if (typeof signal.ts !== 'number' || !Number.isFinite(signal.ts)) {
    throw new Error('signal_missing_ts');
  }
  if (!signal.payload || typeof signal.payload !== 'object') {
    throw new Error('signal_missing_payload');
  }
  const payload = signal.payload as Partial<PublishRequestPayload>;
  if (typeof payload.title !== 'string' || typeof payload.content !== 'string' || !Array.isArray(payload.tags)) {
    throw new Error('signal_invalid_payload');
  }
  return {
    requestId,
    approved: signal.approved,
    ts: signal.ts,
    payload: {
      title: payload.title,
      content: payload.content,
      tags: payload.tags.map((tag) => String(tag)),
    },
  };
}

export async function waitForPublishApproval(
  options: PublishApprovalGateOptions,
): Promise<PublishApprovalGateResult> {
  const {
    requestId,
    signalDir = DEFAULT_SIGNAL_DIR,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    consumeSignal = true,
    now = Date.now,
    sleep = defaultSleep,
    readSignal = (path) => readFile(path, 'utf8'),
    removeSignal = (path) => rm(path, { force: true }),
  } = options;

  const signalPath = buildPublishApprovalSignalPath(requestId, signalDir);
  const deadline = now() + timeoutMs;

  while (now() <= deadline) {
    try {
      const content = await readSignal(signalPath);
      const signal = validateSignal(JSON.parse(content), requestId);
      if (consumeSignal) {
        await removeSignal(signalPath);
      }
      if (!signal.approved) {
        return {
          ok: false,
          requestId,
          signalPath,
          approved: false,
          reason: 'approval_rejected',
          signal,
        };
      }
      return {
        ok: true,
        requestId,
        signalPath,
        approved: true,
        signal,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        if (message.startsWith('signal_')) {
          return {
            ok: false,
            requestId,
            signalPath,
            reason: message,
          };
        }
      }
    }
    if (now() + pollIntervalMs > deadline) {
      break;
    }
    await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    requestId,
    signalPath,
    reason: 'approval_timeout',
  };
}
