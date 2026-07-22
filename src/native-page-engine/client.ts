import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const PROTOCOL_VERSION = 1;
const DEFAULT_NATIVE_TIMEOUT_MS = 5_000;
const MAX_STDERR_CHARS = 2_048;

export type NativePageKind =
  | 'home'
  | 'explore'
  | 'search'
  | 'note_detail'
  | 'profile'
  | 'login'
  | 'unknown';

export interface NativePageStructuralSignals {
  feedCardCount: number;
  noteDetailCount: number;
  loginWallCount: number;
  dialogCount: number;
  profileSignalCount: number;
  mainCount: number;
}

export interface NativePageProbeResult {
  targetId: string;
  origin: string;
  path: string;
  readyState: 'loading' | 'interactive' | 'complete' | 'unknown';
  pageKind: NativePageKind;
  signals: NativePageStructuralSignals;
}

export interface NativePageProbeInput {
  host: string;
  port: number;
  platform: 'xiaohongshu';
  /** Native CDP/HTTP operation deadline. */
  timeoutMs?: number;
}

export type NativePageEngineErrorCode =
  | 'invalid_request'
  | 'unsupported_protocol'
  | 'endpoint_not_loopback'
  | 'endpoint_unreachable'
  | 'no_matching_target'
  | 'cdp_connect_failed'
  | 'cdp_timeout'
  | 'cdp_error'
  | 'probe_failed'
  | 'engine_timeout'
  | 'engine_exited'
  | 'invalid_protocol';

export class NativePageEngineError extends Error {
  constructor(
    readonly code: NativePageEngineErrorCode,
    message: string,
    readonly detail?: { exitCode?: number | null; signal?: NodeJS.Signals | null; stderr?: string },
  ) {
    super(message);
    this.name = 'NativePageEngineError';
  }
}

type SpawnEngine = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface NativePageEngineClientOptions {
  /** Must be supplied explicitly; normal Edge startup never resolves or launches this binary. */
  binaryPath: string;
  /** Test/development harness only. The production Rust binary takes no arguments. */
  binaryArgs?: string[];
  /** Whole child-process deadline, including readiness and graceful response overhead. */
  processTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnEngine;
}

interface ReadyRecord {
  type: 'ready';
  protocolVersion: number;
  engineVersion: string;
}

interface ErrorRecord {
  code: NativePageEngineErrorCode;
  message: string;
}

interface ResponseRecord {
  type: 'response';
  protocolVersion: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ErrorRecord;
}

export class NativePageEngineClient {
  private readonly spawnImpl: SpawnEngine;

  constructor(private readonly options: NativePageEngineClientOptions) {
    if (!options.binaryPath || !isAbsolute(options.binaryPath)) {
      throw new NativePageEngineError(
        'invalid_request',
        'Native Page Engine binaryPath must be absolute',
      );
    }
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) =>
      spawn(command, args, spawnOptions));
  }

  async probePage(input: NativePageProbeInput): Promise<NativePageProbeResult> {
    validateProbeInput(input);
    const requestId = `probe_${randomUUID().replaceAll('-', '')}`;
    const nativeTimeoutMs = input.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS;
    const processTimeoutMs = this.options.processTimeoutMs ?? nativeTimeoutMs + 1_000;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl(this.options.binaryPath, this.options.binaryArgs ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.options.env },
      });
    } catch (error) {
      throw new NativePageEngineError(
        'engine_exited',
        `Native Page Engine could not start: ${describeError(error)}`,
      );
    }

    return new Promise<NativePageProbeResult>((resolve, reject) => {
      let settled = false;
      let ready = false;
      let stdoutBuffer = '';
      let stderr = '';

      const finish = (
        outcome: { result: NativePageProbeResult } | { error: NativePageEngineError },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        child.removeAllListeners();
        if ('error' in outcome) {
          if (!child.killed) child.kill('SIGTERM');
          reject(outcome.error);
          return;
        }
        child.stdin.end();
        resolve(outcome.result);
      };

      const failProtocol = (message: string): void => {
        finish({
          error: new NativePageEngineError('invalid_protocol', message, {
            stderr: stderr || undefined,
          }),
        });
      };

      const handleLine = (line: string): void => {
        if (!line.trim() || settled) return;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          failProtocol('Native Page Engine emitted malformed stdout');
          return;
        }
        if (!ready) {
          if (!isReadyRecord(record) || record.protocolVersion !== PROTOCOL_VERSION) {
            failProtocol('Native Page Engine readiness protocol mismatch');
            return;
          }
          ready = true;
          child.stdin.write(
            `${JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              id: requestId,
              method: 'probe_page',
              params: {
                host: input.host,
                port: input.port,
                platform: input.platform,
                timeoutMs: nativeTimeoutMs,
              },
            })}\n`,
          );
          return;
        }

        if (!isResponseRecord(record)) {
          failProtocol('Native Page Engine emitted an invalid response record');
          return;
        }
        if (record.protocolVersion !== PROTOCOL_VERSION || record.id !== requestId) {
          return;
        }
        if (!record.ok) {
          if (!record.error || !isKnownErrorCode(record.error.code)) {
            failProtocol('Native Page Engine emitted an invalid error response');
            return;
          }
          finish({
            error: new NativePageEngineError(record.error.code, record.error.message, {
              stderr: stderr || undefined,
            }),
          });
          return;
        }
        const result = parseProbeResult(record.result);
        if (!result) {
          failProtocol('Native Page Engine emitted an invalid probe result');
          return;
        }
        finish({ result });
      };

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutBuffer += chunk.toString();
        for (;;) {
          const newline = stdoutBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          handleLine(line);
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
      });
      child.once('error', (error) => {
        finish({
          error: new NativePageEngineError(
            'engine_exited',
            `Native Page Engine process failed: ${describeError(error)}`,
            { stderr: stderr || undefined },
          ),
        });
      });
      child.once('exit', (exitCode, signal) => {
        finish({
          error: new NativePageEngineError(
            'engine_exited',
            'Native Page Engine exited before returning a result',
            { exitCode, signal, stderr: stderr || undefined },
          ),
        });
      });

      const timer = setTimeout(() => {
        finish({
          error: new NativePageEngineError(
            'engine_timeout',
            'Native Page Engine did not return before the process deadline',
            { stderr: stderr || undefined },
          ),
        });
      }, processTimeoutMs);
    });
  }
}

function validateProbeInput(input: NativePageProbeInput): void {
  if (!input.host || input.host.length > 255) {
    throw new NativePageEngineError('invalid_request', 'Invalid DevTools host');
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new NativePageEngineError('invalid_request', 'Invalid DevTools port');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) {
    throw new NativePageEngineError('invalid_request', 'Invalid native probe timeout');
  }
}

function isReadyRecord(value: unknown): value is ReadyRecord {
  if (!isRecord(value)) return false;
  return (
    value.type === 'ready'
    && typeof value.protocolVersion === 'number'
    && typeof value.engineVersion === 'string'
  );
}

function isResponseRecord(value: unknown): value is ResponseRecord {
  if (!isRecord(value)) return false;
  return (
    value.type === 'response'
    && typeof value.protocolVersion === 'number'
    && typeof value.id === 'string'
    && typeof value.ok === 'boolean'
  );
}

function parseProbeResult(value: unknown): NativePageProbeResult | undefined {
  if (!isRecord(value) || !isRecord(value.signals)) return undefined;
  const signals = value.signals;
  const pageKinds: readonly string[] = [
    'home',
    'explore',
    'search',
    'note_detail',
    'profile',
    'login',
    'unknown',
  ];
  const readyStates: readonly string[] = ['loading', 'interactive', 'complete', 'unknown'];
  const signalNames = [
    'feedCardCount',
    'noteDetailCount',
    'loginWallCount',
    'dialogCount',
    'profileSignalCount',
    'mainCount',
  ] as const;
  if (
    typeof value.targetId !== 'string'
    || typeof value.origin !== 'string'
    || typeof value.path !== 'string'
    || typeof value.readyState !== 'string'
    || !readyStates.includes(value.readyState)
    || typeof value.pageKind !== 'string'
    || !pageKinds.includes(value.pageKind)
    || !signalNames.every((name) => (
      typeof signals[name] === 'number' && Number.isInteger(signals[name])
    ))
  ) {
    return undefined;
  }
  return value as unknown as NativePageProbeResult;
}

function isKnownErrorCode(value: unknown): value is NativePageEngineErrorCode {
  return [
    'invalid_request',
    'unsupported_protocol',
    'endpoint_not_loopback',
    'endpoint_unreachable',
    'no_matching_target',
    'cdp_connect_failed',
    'cdp_timeout',
    'cdp_error',
    'probe_failed',
  ].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
