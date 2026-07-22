import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const NATIVE_PAGE_ENGINE_PROTOCOL_VERSION = 2;
const DEFAULT_NATIVE_TIMEOUT_MS = 5_000;
const MAX_STDERR_CHARS = 2_048;
const MAX_RECORD_CHARS = 64 * 1024;

export type NativePageKind =
  | 'home'
  | 'explore'
  | 'search'
  | 'note_detail'
  | 'profile'
  | 'notification'
  | 'publish'
  | 'login'
  | 'captcha'
  | 'error'
  | 'unknown';

export interface NativePageStructuralSignals {
  feedCardCount: number;
  noteDetailCount: number;
  loginWallCount: number;
  captchaSignalCount: number;
  dialogCount: number;
  profileSignalCount: number;
  notificationSignalCount: number;
  publishSignalCount: number;
  errorSignalCount: number;
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

export interface NativePageSessionInput extends NativePageProbeInput {
  sessionId: string;
  taskId: string;
}

export interface NativePageEngineManifest {
  engineVersion: string;
  platformAdapterVersion: string;
  capabilityDigest: string;
}

export type NativePageCommandKind =
  | 'page_probe' | 'plan_execute' | 'session_stop' | 'browse_next' | 'browse_scroll' | 'page_scroll'
  | 'feed_refresh' | 'search_execute' | 'note_open' | 'note_close' | 'navigation_back'
  | 'note_browse_images' | 'note_scroll_comments' | 'profile_open' | 'notification_open'
  | 'notification_browse_comments' | 'notification_browse_likes' | 'notification_browse_follows'
  | 'notification_back_home' | 'interaction_like' | 'interaction_collect' | 'interaction_follow'
  | 'interaction_comment' | 'interaction_like_comment' | 'captcha_capture' | 'captcha_click'
  | 'publish_navigate_entry' | 'publish_select_mode' | 'publish_upload_image'
  | 'publish_set_cover' | 'publish_fill_field' | 'publish_add_with_candidate' | 'publish_set_option'
  | 'publish_set_schedule' | 'publish_submit' | 'publish_capture_post_id'
  | 'publish_capture_scheduled' | 'publish_reconcile_scheduled';

export interface NativePageCommand {
  kind: NativePageCommandKind;
  params: Record<string, unknown>;
}

export interface NativePageCommandExecution {
  ok: boolean;
  effectPhase: NativeEffectPhase;
  reasonCode: string;
  output?: { kind: string; value: unknown };
}

export interface NativePageSessionInfo {
  sessionId: string;
  taskId: string;
  state: 'ready' | 'closed';
  targetId: string;
  lastCommandId: number;
  activeCommandId?: number;
}

export interface NativeCancelResult {
  accepted: boolean;
  state: 'cancellation_requested' | 'terminal' | 'not_found';
  commandId: number;
}

export type NativeEffectPhase = 'not_started' | 'dispatched' | 'confirmed' | 'ambiguous';

export type NativePageEngineErrorCode =
  | 'confirmed'
  | 'invalid_request'
  | 'unsupported_protocol'
  | 'session_already_open'
  | 'session_not_open'
  | 'session_mismatch'
  | 'task_mismatch'
  | 'duplicate_command'
  | 'command_in_progress'
  | 'deadline_expired'
  | 'cancelled'
  | 'unsupported_command'
  | 'endpoint_not_loopback'
  | 'endpoint_unreachable'
  | 'no_matching_target'
  | 'cdp_connect_failed'
  | 'cdp_timeout'
  | 'cdp_error'
  | 'probe_failed'
  | 'engine_internal'
  | 'engine_timeout'
  | 'engine_exited'
  | 'invalid_protocol';

export class NativePageEngineError extends Error {
  constructor(
    readonly code: NativePageEngineErrorCode,
    message: string,
    readonly detail?: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      effectPhase?: NativeEffectPhase;
      reasonCode?: string;
    },
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
  /** Absolute path resolved by the caller from development output or process.resourcesPath. */
  binaryPath: string;
  /** Test/development harness only. The production Rust binary takes no arguments. */
  binaryArgs?: string[];
  /** Readiness and individual IPC response deadline. */
  processTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnEngine;
  /** Production package contract. Tests may omit it for fixture engines. */
  expectedManifest?: NativePageEngineManifest;
}

interface ReadyRecord {
  type: 'ready';
  protocolVersion: number;
  manifest: NativePageEngineManifest;
}

interface ErrorRecord {
  code: NativePageEngineErrorCode;
  message: string;
}

interface LifecycleResponse {
  type: 'response';
  protocolVersion: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ErrorRecord;
}

interface CommandResponse {
  type: 'command_result';
  protocolVersion: number;
  id: string;
  sessionId: string;
  taskId: string;
  commandId: number;
  ok: boolean;
  effectPhase: NativeEffectPhase;
  reasonCode: string;
  result?: unknown;
  error?: ErrorRecord;
}

interface PendingResponse {
  resolve(value: unknown): void;
  reject(error: NativePageEngineError): void;
  timer: NodeJS.Timeout;
}

class NativeProcessTransport {
  private readonly pending = new Map<string, PendingResponse>();
  private readonly processTimeoutMs: number;
  private stdoutBuffer = '';
  private stderr = '';
  private ready = false;
  private settledReady = false;
  private exited = false;
  private intentionalShutdown = false;
  private manifest?: NativePageEngineManifest;
  private readonly readyPromise: Promise<NativePageEngineManifest>;
  private resolveReady!: (manifest: NativePageEngineManifest) => void;
  private rejectReady!: (error: NativePageEngineError) => void;
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private readonly readyTimer: NodeJS.Timeout;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    processTimeoutMs: number,
    private readonly expectedManifest?: NativePageEngineManifest,
  ) {
    this.processTimeoutMs = processTimeoutMs;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.readyTimer = setTimeout(() => {
      this.failReady(new NativePageEngineError(
        'engine_timeout',
        'Native Page Engine did not become ready before the process deadline',
        { stderr: this.stderr || undefined },
      ));
      this.terminate();
    }, processTimeoutMs);
    this.attach();
  }

  static async start(options: NativePageEngineClientOptions): Promise<NativeProcessTransport> {
    const processTimeoutMs = options.processTimeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS + 1_000;
    const spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => (
      spawn(command, args, spawnOptions)
    ));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(options.binaryPath, options.binaryArgs ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...options.env },
      });
    } catch (error) {
      throw new NativePageEngineError(
        'engine_exited',
        `Native Page Engine could not start: ${describeError(error)}`,
      );
    }
    const transport = new NativeProcessTransport(child, processTimeoutMs, options.expectedManifest);
    await transport.readyPromise;
    return transport;
  }

  async request(id: string, record: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (!this.ready || this.exited) {
      throw new NativePageEngineError('engine_exited', 'Native Page Engine is not available', {
        stderr: this.stderr || undefined,
      });
    }
    if (this.pending.has(id)) {
      throw new NativePageEngineError('invalid_request', 'Duplicate Native request id');
    }
    const serialized = `${JSON.stringify(record)}\n`;
    if (serialized.length > MAX_RECORD_CHARS) {
      throw new NativePageEngineError('invalid_request', 'Native request exceeds protocol limit');
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativePageEngineError(
          'engine_timeout',
          'Native Page Engine did not return before the IPC deadline',
          { stderr: this.stderr || undefined },
        ));
      }, timeoutMs ?? this.processTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(serialized, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new NativePageEngineError(
          'engine_exited',
          `Native Page Engine stdin failed: ${describeError(error)}`,
          { stderr: this.stderr || undefined },
        ));
      });
    });
  }

  engineManifest(): NativePageEngineManifest {
    if (!this.manifest) {
      throw new NativePageEngineError('invalid_protocol', 'Native Page Engine manifest is unavailable');
    }
    return this.manifest;
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    this.intentionalShutdown = true;
    const id = requestId('shutdown');
    try {
      const raw = await this.request(id, {
        type: 'shutdown',
        protocolVersion: NATIVE_PAGE_ENGINE_PROTOCOL_VERSION,
        id,
      }, Math.min(this.processTimeoutMs, 2_000));
      parseLifecycle(raw, id, () => undefined);
    } catch {
      this.terminate();
    }
    this.child.stdin.end();
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, Math.min(this.processTimeoutMs, 2_000))),
    ]);
    if (!this.exited) this.terminate();
  }

  terminate(): void {
    if (!this.child.killed && !this.exited) this.child.kill('SIGTERM');
  }

  private attach(): void {
    this.child.stdout.on('data', (chunk: Buffer | string) => {
      this.stdoutBuffer += chunk.toString();
      if (this.stdoutBuffer.length > MAX_RECORD_CHARS * 2) {
        this.failProtocol('Native Page Engine stdout exceeded protocol bounds');
        return;
      }
      for (;;) {
        const newline = this.stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.stdoutBuffer.slice(0, newline);
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        this.handleLine(line);
      }
    });
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
    });
    this.child.once('error', (error) => {
      this.failProcess(new NativePageEngineError(
        'engine_exited',
        `Native Page Engine process failed: ${describeError(error)}`,
        { stderr: this.stderr || undefined },
      ));
    });
    this.child.once('exit', (exitCode, signal) => {
      this.exited = true;
      this.resolveExit();
      if (this.intentionalShutdown && this.pending.size === 0) return;
      this.failProcess(new NativePageEngineError(
        'engine_exited',
        'Native Page Engine exited before completing the active request',
        { exitCode, signal, stderr: this.stderr || undefined },
      ));
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.failProtocol('Native Page Engine emitted malformed stdout');
      return;
    }
    if (!this.ready) {
      const ready = parseReadyRecord(record);
      if (!ready) {
        this.failProtocol('Native Page Engine readiness protocol mismatch');
        return;
      }
      this.ready = true;
      if (this.expectedManifest && (
        ready.manifest.engineVersion !== this.expectedManifest.engineVersion
        || ready.manifest.platformAdapterVersion !== this.expectedManifest.platformAdapterVersion
        || ready.manifest.capabilityDigest !== this.expectedManifest.capabilityDigest
      )) {
        this.failProtocol('Native Page Engine readiness manifest does not match the packaged artifact');
        return;
      }
      this.manifest = ready.manifest;
      this.settledReady = true;
      clearTimeout(this.readyTimer);
      this.resolveReady(ready.manifest);
      return;
    }
    if (!isRecord(record) || typeof record.id !== 'string') {
      this.failProtocol('Native Page Engine emitted an invalid response record');
      return;
    }
    const pending = this.pending.get(record.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(record.id);
    pending.resolve(record);
  }

  private failProtocol(message: string): void {
    this.failProcess(new NativePageEngineError('invalid_protocol', message, {
      stderr: this.stderr || undefined,
    }));
    this.terminate();
  }

  private failReady(error: NativePageEngineError): void {
    if (this.settledReady) return;
    this.settledReady = true;
    clearTimeout(this.readyTimer);
    this.rejectReady(error);
  }

  private failProcess(error: NativePageEngineError): void {
    this.failReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class NativePageEngineSession {
  private closed = false;
  private commandId = 0;

  constructor(
    private readonly transport: NativeProcessTransport,
    readonly manifest: NativePageEngineManifest,
    readonly sessionId: string,
    readonly taskId: string,
    readonly info: NativePageSessionInfo,
    private readonly processTimeoutMs: number,
  ) {}

  async probePage(
    timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<NativePageProbeResult> {
    const execution = await this.execute({ kind: 'page_probe', params: {} }, timeoutMs, signal);
    if (!execution.ok || execution.effectPhase !== 'confirmed') {
      throw new NativePageEngineError('invalid_protocol', 'Native page probe did not confirm');
    }
    if (!execution.output || execution.output.kind !== 'page_probe') {
      throw new NativePageEngineError('invalid_protocol', 'Native page probe result kind mismatch');
    }
    const result = parseProbeResult(execution.output.value);
    if (!result) {
      throw new NativePageEngineError('invalid_protocol', 'Native Page Engine emitted an invalid probe result');
    }
    return result;
  }

  async execute(
    command: NativePageCommand,
    timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<NativePageCommandExecution> {
    this.assertOpen();
    validateTimeout(timeoutMs);
    if (signal?.aborted) {
      throw new NativePageEngineError('cancelled', 'Native page command cancelled before dispatch', {
        effectPhase: 'not_started',
      });
    }
    const id = requestId('command');
    const commandId = ++this.commandId;
    const pending = this.transport.request(id, {
      type: 'command', protocolVersion: NATIVE_PAGE_ENGINE_PROTOCOL_VERSION, id,
      sessionId: this.sessionId, taskId: this.taskId, commandId,
      deadlineUnixMs: Date.now() + timeoutMs, command,
    }, Math.max(this.processTimeoutMs, timeoutMs + 250));
    const abort = (): void => { void this.cancel(commandId, 'caller_aborted').catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });
    let raw: unknown;
    try { raw = await pending; } finally { signal?.removeEventListener('abort', abort); }
    const response = parseCommandResponse(raw, id, this.sessionId, this.taskId, commandId);
    if (response.error || (!response.result && !response.ok)) throw nativeResponseError(response);
    const output = isRecord(response.result)
      && typeof response.result.kind === 'string'
      && 'value' in response.result
      ? response.result as { kind: string; value: unknown }
      : undefined;
    if (!output) throw new NativePageEngineError('invalid_protocol', 'Native page command output is invalid');
    return { ok: response.ok, effectPhase: response.effectPhase, reasonCode: response.reasonCode, output };
  }

  async cancel(commandId: number, reason = 'caller_cancelled'): Promise<NativeCancelResult> {
    this.assertOpen();
    if (!Number.isSafeInteger(commandId) || commandId < 1) {
      throw new NativePageEngineError('invalid_request', 'Invalid Native commandId');
    }
    const id = requestId('cancel');
    const raw = await this.transport.request(id, {
      type: 'cancel',
      protocolVersion: NATIVE_PAGE_ENGINE_PROTOCOL_VERSION,
      id,
      sessionId: this.sessionId,
      taskId: this.taskId,
      commandId,
      reason: reason.slice(0, 256),
    });
    return parseLifecycle(raw, id, parseCancelResult);
  }

  async status(): Promise<NativePageSessionInfo> {
    this.assertOpen();
    const id = requestId('status');
    const raw = await this.transport.request(id, {
      type: 'session_status',
      protocolVersion: NATIVE_PAGE_ENGINE_PROTOCOL_VERSION,
      id,
      sessionId: this.sessionId,
    });
    return parseLifecycle(raw, id, parseSessionInfo);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const id = requestId('close');
    try {
      const raw = await this.transport.request(id, {
        type: 'session_close',
        protocolVersion: NATIVE_PAGE_ENGINE_PROTOCOL_VERSION,
        id,
        sessionId: this.sessionId,
      });
      parseLifecycle(raw, id, parseSessionInfo);
    } finally {
      this.closed = true;
      await this.transport.shutdown();
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new NativePageEngineError('session_not_open', 'Native Page Engine session is closed');
    }
  }
}

export class NativePageEngineClient {
  constructor(private readonly options: NativePageEngineClientOptions) {
    if (!options.binaryPath || !isAbsolute(options.binaryPath)) {
      throw new NativePageEngineError(
        'invalid_request',
        'Native Page Engine binaryPath must be absolute',
      );
    }
  }

  async openSession(input: NativePageSessionInput): Promise<NativePageEngineSession> {
    validateProbeInput(input);
    validateIdentifier(input.sessionId, 'sessionId');
    validateIdentifier(input.taskId, 'taskId');
    const transport = await NativeProcessTransport.start(this.options);
    const id = requestId('open');
    const timeoutMs = input.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS;
    try {
      const raw = await transport.request(id, {
        type: 'session_open',
        protocolVersion: NATIVE_PAGE_ENGINE_PROTOCOL_VERSION,
        id,
        sessionId: input.sessionId,
        taskId: input.taskId,
        params: {
          host: input.host,
          port: input.port,
          platform: input.platform,
          timeoutMs,
        },
      }, Math.max(this.options.processTimeoutMs ?? 0, timeoutMs + 250));
      const info = parseLifecycle(raw, id, parseSessionInfo);
      const ready = transport.engineManifest();
      return new NativePageEngineSession(
        transport,
        ready,
        input.sessionId,
        input.taskId,
        info,
        this.options.processTimeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS + 1_000,
      );
    } catch (error) {
      transport.terminate();
      throw error;
    }
  }

  /** One-shot development probe retained as a wrapper over the production v2 session lifecycle. */
  async probePage(input: NativePageProbeInput): Promise<NativePageProbeResult> {
    const suffix = randomUUID().replaceAll('-', '');
    const session = await this.openSession({
      ...input,
      sessionId: `probe_session_${suffix}`,
      taskId: `probe_task_${suffix}`,
    });
    try {
      return await session.probePage(input.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS);
    } finally {
      await session.close().catch(() => undefined);
    }
  }
}

function parseReadyRecord(value: unknown): ReadyRecord | undefined {
  if (!isRecord(value) || !isRecord(value.manifest)) return undefined;
  const manifest = value.manifest;
  if (
    value.type !== 'ready'
    || value.protocolVersion !== NATIVE_PAGE_ENGINE_PROTOCOL_VERSION
    || typeof manifest.engineVersion !== 'string'
    || !manifest.engineVersion
    || typeof manifest.platformAdapterVersion !== 'string'
    || !manifest.platformAdapterVersion
    || typeof manifest.capabilityDigest !== 'string'
    || !/^[a-f0-9]{64}$/i.test(manifest.capabilityDigest)
  ) return undefined;
  return value as unknown as ReadyRecord;
}

function parseLifecycle<T>(
  value: unknown,
  id: string,
  parseResult: (result: unknown) => T,
): T {
  if (!isLifecycleResponse(value) || value.protocolVersion !== NATIVE_PAGE_ENGINE_PROTOCOL_VERSION || value.id !== id) {
    throw new NativePageEngineError('invalid_protocol', 'Native Page Engine lifecycle response mismatch');
  }
  if (!value.ok) throw nativeResponseError(value);
  return parseResult(value.result);
}

function parseCommandResponse(
  value: unknown,
  id: string,
  sessionId: string,
  taskId: string,
  commandId: number,
): CommandResponse {
  if (
    !isRecord(value)
    || value.type !== 'command_result'
    || value.protocolVersion !== NATIVE_PAGE_ENGINE_PROTOCOL_VERSION
    || value.id !== id
    || value.sessionId !== sessionId
    || value.taskId !== taskId
    || value.commandId !== commandId
    || typeof value.ok !== 'boolean'
    || !isEffectPhase(value.effectPhase)
    || typeof value.reasonCode !== 'string'
  ) {
    throw new NativePageEngineError('invalid_protocol', 'Native Page Engine command response mismatch');
  }
  return value as unknown as CommandResponse;
}

function parseSessionInfo(value: unknown): NativePageSessionInfo {
  if (
    !isRecord(value)
    || typeof value.sessionId !== 'string'
    || typeof value.taskId !== 'string'
    || !['ready', 'closed'].includes(String(value.state))
    || typeof value.targetId !== 'string'
    || !Number.isSafeInteger(value.lastCommandId)
    || (value.activeCommandId !== undefined && !Number.isSafeInteger(value.activeCommandId))
  ) {
    throw new NativePageEngineError('invalid_protocol', 'Native Page Engine session result is invalid');
  }
  return value as unknown as NativePageSessionInfo;
}

function parseCancelResult(value: unknown): NativeCancelResult {
  if (
    !isRecord(value)
    || typeof value.accepted !== 'boolean'
    || !['cancellation_requested', 'terminal', 'not_found'].includes(String(value.state))
    || !Number.isSafeInteger(value.commandId)
  ) {
    throw new NativePageEngineError('invalid_protocol', 'Native Page Engine cancel result is invalid');
  }
  return value as unknown as NativeCancelResult;
}

function isLifecycleResponse(value: unknown): value is LifecycleResponse {
  return isRecord(value)
    && value.type === 'response'
    && typeof value.protocolVersion === 'number'
    && typeof value.id === 'string'
    && typeof value.ok === 'boolean';
}

function nativeResponseError(value: { error?: ErrorRecord; effectPhase?: NativeEffectPhase; reasonCode?: string }): NativePageEngineError {
  const code = value.error?.code && isKnownErrorCode(value.error.code)
    ? value.error.code
    : 'invalid_protocol';
  return new NativePageEngineError(
    code,
    value.error?.message ?? 'Native Page Engine returned an invalid failure record',
    { effectPhase: value.effectPhase, reasonCode: value.reasonCode },
  );
}

function validateProbeInput(input: NativePageProbeInput): void {
  if (!input.host || input.host.length > 255) {
    throw new NativePageEngineError('invalid_request', 'Invalid DevTools host');
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new NativePageEngineError('invalid_request', 'Invalid DevTools port');
  }
  validateTimeout(input.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS);
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) {
    throw new NativePageEngineError('invalid_request', 'Invalid native operation timeout');
  }
}

function validateIdentifier(value: string, name: string): void {
  if (!value || value.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new NativePageEngineError('invalid_request', `Invalid Native ${name}`);
  }
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
    'notification',
    'publish',
    'login',
    'captcha',
    'error',
    'unknown',
  ];
  const readyStates: readonly string[] = ['loading', 'interactive', 'complete', 'unknown'];
  const signalNames = [
    'feedCardCount',
    'noteDetailCount',
    'loginWallCount',
    'captchaSignalCount',
    'dialogCount',
    'profileSignalCount',
    'notificationSignalCount',
    'publishSignalCount',
    'errorSignalCount',
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
  ) return undefined;
  return value as unknown as NativePageProbeResult;
}

function isKnownErrorCode(value: unknown): value is NativePageEngineErrorCode {
  return [
    'confirmed',
    'invalid_request',
    'unsupported_protocol',
    'session_already_open',
    'session_not_open',
    'session_mismatch',
    'task_mismatch',
    'duplicate_command',
    'command_in_progress',
    'deadline_expired',
    'cancelled',
    'unsupported_command',
    'endpoint_not_loopback',
    'endpoint_unreachable',
    'no_matching_target',
    'cdp_connect_failed',
    'cdp_timeout',
    'cdp_error',
    'probe_failed',
    'engine_internal',
  ].includes(String(value));
}

function isEffectPhase(value: unknown): value is NativeEffectPhase {
  return ['not_started', 'dispatched', 'confirmed', 'ambiguous'].includes(String(value));
}

function requestId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
