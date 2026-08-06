import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 旧整页发布信封的载荷形状（其消息类型已随 drop-dead-cloud-edge-commands 从协议删除；
 * 本地夹具信号仍沿用这三个字段，故在此自持形状、不再依赖协议）。 */
interface LegacyPublishSignalShape {
  title: string;
  content: string;
  tags: string[];
}

export interface PublishApprovalSignal {
  requestId: string;
  approved: boolean;
  ts: number;
  payload: LegacyPublishSignalShape;
}

export interface PublishApprovalGateOptions {
  requestId: string;
  signalDir?: string;
  /**
   * 绕过显式启用门（**仅**供本闸自身的单测使用；生产与流程代码 MUST NOT 传）。
   * 存在它是为了让夹具行为本身可测，而不是给生产留一个后门——生产路径根本没有本闸的调用者。
   */
  forceEnabledForTest?: boolean;
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

/**
 * 审批信号文件默认目录：跨平台用 `os.tmpdir()`（Windows 无 `/tmp`），可经
 * `AIDCP_PUBLISH_APPROVAL_SIGNAL_DIR` 覆盖。在 call 时解析（非模块加载时常量），便于 env 覆盖与测试。
 */
function resolveDefaultSignalDir(): string {
  return process.env.AIDCP_PUBLISH_APPROVAL_SIGNAL_DIR ?? tmpdir();
}

/**
 * 本闸是否被**显式启用**（change publish-approval-signal-to-database，task 6.1）。
 *
 * 必须同时给出信号目录与开发开关。缺任一即立刻返回「闸未启用」拒因：
 * MUST NOT 静默通过（那是未授权直发），MUST NOT 静默等待到超时（那让一次配置遗漏看起来像
 * 「运营没点通过」，正是本 change 要消灭的那种不可区分的静默停滞）。
 */
function approvalGateExplicitlyEnabled(): boolean {
  const dir = process.env.AIDCP_PUBLISH_APPROVAL_SIGNAL_DIR?.trim();
  return Boolean(dir) && process.env.AIDCP_DEV_PUBLISH === '1';
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildPublishApprovalRequestId(now: () => number = Date.now): string {
  return `edge-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 本机开发夹具的信号文件路径。
 * @deprecated change publish-approval-signal-to-database：它**不再是**与云端的两端契约——
 * 云端授权的权威载体是持久记录，同路径文件只在兼容窗口内作为 best-effort 影子写存在。
 * 生产路径 MUST NOT 依赖此函数。
 */
export function buildPublishApprovalSignalPath(requestId: string, signalDir = resolveDefaultSignalDir()): string {
  // 用 path.join：Windows 用原生分隔符、不再拼出 POSIX-only 的 `/tmp/...`。
  return join(signalDir, `aidcp-publish-approve-${requestId}.json`);
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
  const payload = signal.payload as Partial<LegacyPublishSignalShape>;
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

/**
 * **本机开发夹具**，不是与云端的跨服务契约（change publish-approval-signal-to-database，task 6.2）。
 *
 * 生产人审授权完全在云端完成：授权是云端 `publish_approval_decision` 表上的持久记录，
 * 发布执行由云端 `CommandSequencer` 逐条下发 `publish.command` 原子指令驱动，
 * 桌面客户端的算子路由表里**没有**整页发布处理器（旧整页消息类型已随 drop-dead-cloud-edge-commands 从协议删除）。
 *
 * 因此 edge MUST NOT 以任何本机文件作为「是否已授权」的判据。本函数只服务本地 dev 脚本
 * （`scripts/dev-publish.ts`）与同机 mock/e2e，且必须显式启用（见 `approvalGateExplicitlyEnabled`）。
 */
export async function waitForPublishApproval(
  options: PublishApprovalGateOptions,
): Promise<PublishApprovalGateResult> {
  const {
    requestId,
    signalDir = resolveDefaultSignalDir(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    consumeSignal = true,
    now = Date.now,
    sleep = defaultSleep,
    readSignal = (path) => readFile(path, 'utf8'),
    removeSignal = (path) => rm(path, { force: true }),
  } = options;

  const signalPath = buildPublishApprovalSignalPath(requestId, signalDir);

  // 显式启用门：不读文件、不等待、不放行——立刻给出可区分的拒因。
  if (!options.forceEnabledForTest && !approvalGateExplicitlyEnabled()) {
    return {
      ok: false,
      requestId,
      signalPath,
      reason: 'approval_gate_disabled',
    };
  }

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
