import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const NATIVE_PAGE_ENGINE_PROTOCOL_VERSION = 2;
const DEFAULT_NATIVE_TIMEOUT_MS = 5_000;
/**
 * ⚠️ 本组是**四处同步**的第 ② 层（准入校验）。另外三层：
 *   ① 请求值      `browse-session.ts`
 *   ③ 会话超时    `runtime.ts` 的 FACEBOOK_NATIVE_SESSION_TIMEOUT_MS
 *                （引擎取 `session_timeout_ms.min(ceiling)`，会话值小就**静默夹回旧值**、不报错）
 *   ④ 引擎天花板  native/page-engine/src/engine.rs 的 command_timeout_ceiling
 *
 * 本层的失败形态最刺眼：超上限 ⇒ `invalid_request`，命令**根本不下发**。
 * 2026-07-29 只抬了 ① 而漏了本层，结果每一次首帖开帖都在毫秒级被拒，云端读到的却是
 * 「群内未找到合适的可评论帖子」——比原缺陷更糟，且把诊断指向完全错误的方向。
 * 桩运行时的单测**绕过本校验**，故 `client.test.ts` 里另有走真实校验的回归。
 *
 * **导出的理由**：提交窗口的兜底预算**派生自它**（见 `NATIVE_COMMIT_WINDOW_BUDGETS` 的
 * `xhs_comment_submit`），门禁按「窗口预算 ≥ 这个上限」的恒等式对账。这个数字已经被调过一次
 * （Facebook 时间预算整体 ×1.5，30_000 → 45_000），任何手抄一份的地方都会在下一次调整时
 * 静默失配——而窗口比命令短的后果是「已发出的写入被当成没发生 ⇒ 上游重投 ⇒ 重复评论」。
 */
export const MAX_NATIVE_TIMEOUT_MS = 45_000;
const MAX_FACEBOOK_FEED_SCROLL_TIMEOUT_MS = 180_000;
const MAX_FACEBOOK_PUBLISH_SELECT_MODE_TIMEOUT_MS = 60_000;
const MAX_FACEBOOK_COMMENT_TIMEOUT_MS = 180_000;
const MAX_FACEBOOK_GROUP_JOIN_TIMEOUT_MS = 135_000;
const MAX_FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS = 135_000;
/**
 * Facebook **会话**超时的准入上限，必须 ≥ 上面所有命令上限里的最大者（当前 = 评论 180s）。
 * 会话超时偏小会让引擎把命令天花板静默夹回；而这里校验得太严则更糟——
 * `openSession` 直接 invalid_request，**整个 Facebook 会话开不起来**，不是某条命令失败。
 */
const MAX_FACEBOOK_SESSION_TIMEOUT_MS = 180_000;
const FACEBOOK_FIRST_POST_SELECTION = 'first_commentable_group_post';
const MAX_FACEBOOK_PUBLISH_FILL_TIMEOUT_MS = 600_000;
const MAX_STDERR_CHARS = 2_048;
const MAX_RECORD_CHARS = 64 * 1024;
/**
 * 逐行转发的**单行**上限。与 `MAX_STDERR_CHARS` 同值但**不是同一件事**：
 * 后者是进程级失败归因用的滚动尾缓冲（允许被挤掉、允许截断成半行），前者是转发通路的行界。
 * 两者并行存在，改一个不会自动改另一个。
 */
const MAX_DIAGNOSTIC_LINE_CHARS = 2_048;
/** 引擎具名诊断族的前缀（`native/page-engine/src/**` 的 `eprintln!` 全族共用）。 */
const ENGINE_DIAGNOSTIC_FAMILY_PREFIX = 'native_page_engine_';

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
  blockingKind?: 'none' | 'login' | 'captcha' | 'unknown';
  blockingText?: string;
  signals: NativePageStructuralSignals;
  /**
   * 通知未读读数（三态）。`unreadable` = 读不到，与 `clear`（确实没有未读）必须区分：
   * 把读不到当成没有未读，等于静默把一次读取失败说成「已清零」。
   * 缺失 / 非法一律解析成 `unreadable`。周期调用由承接方装配，此处只定契约与解析。
   */
  notificationUnread: NativePageNotificationUnread;
}

export interface NativePageNotificationUnread {
  state: 'unread' | 'clear' | 'unreadable';
  /** 附带计数；红点无数字时为 0，不参与「有没有未读」的判定。 */
  count: number;
}

export interface NativePageProbeInput {
  host: string;
  port: number;
  platform: NativePagePlatform;
  /** Native CDP/HTTP operation deadline. */
  timeoutMs?: number;
  /**
   * 被准入的那一个浏览器实例的身份证据：浏览器级调试地址
   * （`ws://127.0.0.1:<port>/devtools/browser/<uuid>`），由提供方在启动 / 接管时读到并原样带过来。
   *
   * 端口不是身份 —— 同机多环境并行时，指纹浏览器释放的调试端口会被另一个环境复用。
   * 引擎在**重连**时按它复核「这一次连上的还是不是当初那一个浏览器」，对不上就诚实拒绝。
   * 缺席的代价是「重连一律被拒」，不是「退化成端口对上就接管」。
   */
  browserDebuggerUrl?: string;
}

export interface NativePageSessionInput extends NativePageProbeInput {
  sessionId: string;
  taskId: string;
}

export interface NativePageEngineManifest {
  engineVersion: string;
  platformAdapterVersion: string;
  platformAdapters: NativePagePlatformAdapter[];
  capabilityDigest: string;
}

export type NativePagePlatform = 'xiaohongshu' | 'facebook' | 'wechat_channels';

export interface NativePagePlatformAdapter {
  platform: NativePagePlatform;
  adapterVersion: string;
}

export type NativePageCommandKind =
  | 'page_probe' | 'plan_execute' | 'session_stop' | 'browse_next' | 'browse_scroll' | 'page_scroll'
  | 'feed_refresh' | 'search_execute' | 'note_open' | 'note_close' | 'navigation_back'
  | 'note_browse_images' | 'note_scroll_comments' | 'profile_open' | 'notification_open'
  | 'notification_browse_comments' | 'notification_browse_likes' | 'notification_browse_follows'
  | 'notification_back_home' | 'interaction_like' | 'interaction_collect' | 'interaction_follow'
  | 'interaction_comment' | 'interaction_like_comment' | 'group_join'
  | 'wechat_capture_session' | 'identity_bootstrap' | 'identity_read_current'
  | 'identity_read_self_profile' | 'captcha_capture' | 'captcha_click'
  | 'facebook_auth_probe' | 'facebook_auth_submit_login' | 'facebook_auth_enter_totp'
  | 'facebook_auth_submit_totp' | 'facebook_auth_clear_totp'
  | 'facebook_auth_dismiss_warning' | 'facebook_auth_close_push_blocker'
  | 'facebook_auth_confirm_remember_password' | 'facebook_auth_start_ad_data_review'
  | 'publish_navigate_entry' | 'publish_select_mode' | 'publish_upload_image'
  | 'publish_set_cover' | 'publish_fill_field' | 'publish_add_with_candidate' | 'publish_set_option'
  | 'publish_set_schedule' | 'publish_submit' | 'publish_capture_post_id'
  | 'publish_capture_scheduled' | 'publish_reconcile_scheduled';

export const NATIVE_FACEBOOK_AUTH_SIGNALS = [
  'authenticated',
  'login_submit_ready',
  'totp_entry_ready',
  'totp_submit_ready',
  'totp_refresh_required',
  'automation_warning_dismiss',
  'push_blocker_close',
  'remember_password_confirm',
  'ad_data_review_get_started',
  'manual_login_required',
  'blocked_human_verification',
  'blocked_unknown',
  'none',
] as const;

export type NativeFacebookAuthSignal = typeof NATIVE_FACEBOOK_AUTH_SIGNALS[number];

export interface NativeFacebookAuthProbeReceipt {
  signal: NativeFacebookAuthSignal;
  signalId?: string;
  serverEpochMs?: number;
  reason?: string;
}

export type NativeFacebookAuthActionKind = Exclude<
  Extract<NativePageCommandKind, `facebook_auth_${string}`>,
  'facebook_auth_probe'
>;

const NATIVE_FACEBOOK_AUTH_ACTION_KIND_FLAGS = {
  facebook_auth_submit_login: true,
  facebook_auth_enter_totp: true,
  facebook_auth_submit_totp: true,
  facebook_auth_clear_totp: true,
  facebook_auth_dismiss_warning: true,
  facebook_auth_close_push_blocker: true,
  facebook_auth_confirm_remember_password: true,
  facebook_auth_start_ad_data_review: true,
} as const satisfies Record<NativeFacebookAuthActionKind, true>;

export const NATIVE_FACEBOOK_AUTH_ACTION_KINDS = Object.freeze(
  Object.keys(NATIVE_FACEBOOK_AUTH_ACTION_KIND_FLAGS) as NativeFacebookAuthActionKind[],
);

export interface NativeFacebookAuthActionReceipt {
  action: NativeFacebookAuthActionKind;
  signalId: string;
  ok: boolean;
  reason?: string;
}

export type NativeFacebookAuthOutput =
  | { kind: 'facebook_auth_probe'; value: NativeFacebookAuthProbeReceipt }
  | { kind: 'facebook_auth_action'; value: NativeFacebookAuthActionReceipt };

const NATIVE_NON_AUTH_OUTPUT_KINDS = [
  'page_probe',
  'page_cards',
  'note_detail',
  'profile_detail',
  'notification_items',
  'notification_home',
  'action_receipt',
  'action_receipt_with_observation',
  'plan_results',
  'publish_receipt',
  'captcha_snapshot',
  'wechat_session_candidate',
  'facebook_identity',
  'identity_observation',
] as const;

type NativeNonAuthOutputKind = typeof NATIVE_NON_AUTH_OUTPUT_KINDS[number];

export type NativePageCommandOutput =
  | NativeFacebookAuthOutput
  | { kind: NativeNonAuthOutputKind; value: unknown };

export interface NativePageCommand {
  kind: NativePageCommandKind;
  params: Record<string, unknown>;
}

export interface NativePageCommandExecution {
  ok: boolean;
  effectPhase: NativeEffectPhase;
  reasonCode: string;
  output?: NativePageCommandOutput;
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

export type NativeCommitWindowLabel =
  | 'fb_join_click'
  | 'fb_comment_enter'
  | 'fb_publish_submit'
  | 'xhs_comment_submit'
  | 'xhs_notification_comments'
  | 'xhs_notification_likes'
  | 'xhs_notification_follows'
  | 'xhs_publish_submit';

export interface NativeCommitWindowRequest {
  sessionId: string;
  taskId: string;
  commandId: number;
  token: string;
  label: NativeCommitWindowLabel;
  budgetMs: number;
}

export type NativeCommitWindowHandler = (
  request: NativeCommitWindowRequest,
) => () => void;

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
  | 'commit_window_unavailable'
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

export interface NativePageEngineDiagnostic {
  operationStage?: 'reuse_probe'
    | 'action_gate_page_probe'
    | 'action_gate_consent_probe'
    | 'action_gate_result'
    | 'readiness_probe'
    | 'join_click'
    | 'verification_probe';
  decodeStage?: 'cdp_exception'
    | 'cdp_wrapper'
    | 'output_kind'
    | 'output_value'
    | 'typed_value';
  expectedKind?: string;
  fieldPath?: string;
  actualType?: 'missing' | 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';
  exceptionClass?: 'error'
    | 'type_error'
    | 'reference_error'
    | 'range_error'
    | 'syntax_error'
    | 'eval_error'
    | 'uri_error';
  exceptionReason?: 'cannot_read_property' | 'reference_not_defined' | 'not_a_function' | 'other';
  exceptionToken?: string;
  lineNumber?: number;
  columnNumber?: number;
}

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
      diagnostic?: NativePageEngineDiagnostic;
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

/**
 * 引擎子进程错误输出的**一整行**，已成帧、已定界、已分类。
 *
 * 这是纯协议客户端交给外界的全部内容：只有字符串 / 数字 / 布尔，没有落点、没有格式。
 * 写到哪里、盖什么归因章、怎么排版，全由注入方（`runtime.ts`）决定 —— 客户端不认识 `console`，
 * 也不认识文件系统。
 */
export interface NativeEngineDiagnosticLine {
  /**
   * 同一个引擎进程内单调递增的序号，从 1 起。
   * 序号存在的意义是**让缺口可见**：转发被上限压掉时，读者看得出中间少了多少行。
   */
  seq: number;
  /**
   * 引擎自己写的那一行，去掉行尾换行；已按单行上限定界。
   * 宿主**不校验内容** —— 无页面派生内容是引擎侧的义务，这里只保证长度与成帧。
   */
  text: string;
  /** `known` = 命中引擎具名诊断族；`other` = 其余（panic / backtrace / 任何未知输出）。 */
  kind: 'known' | 'other';
  /** 源行超过单行上限、被截断到上限长度。**绝不静默**：注入方必须把它渲染出来。 */
  truncated: boolean;
  /** 进程退出时行缓冲里还剩的半行，被冲出而非丢弃。同样必须渲染出来。 */
  incomplete: boolean;
}

/**
 * 诊断出口。缺席即**逐字保持今天的行为**（只拼尾缓冲、不转发）。
 * 抛异常不会影响传输：出口坏了是出口的事，不能反过来把协议通道打断。
 */
export type NativeEngineDiagnosticSink = (line: NativeEngineDiagnosticLine) => void;

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
  /**
   * 会话期内**可重复取值**的端点解析入口。引擎在重连时会问一次：这个会话现在该连哪里？
   *
   * 建会话时那对 host/port 是**当时**的值；浏览器被重开（冷待机唤醒即如此）之后端口会换，
   * 而旧端口不会闲着 —— 同机另一个环境的浏览器随时可能占上去。
   *
   * 解析不出来时 MUST 返回 `undefined`，**MUST NOT 把上一次的值原样回填**：
   * 那正是「端口被别的环境复用」这条危害的入口。省略本项等价于恒定解析不出来
   * （引擎会沿用建会话时的端点，附着仍受实例身份复核约束）。
   */
  resolveEndpoint?: () => { host: string; port: number } | undefined;
  /**
   * 引擎子进程错误输出的逐行出口。**可选**：缺席时本客户端的行为与本项引入之前逐字相同
   *（错误输出仍只进滚动尾缓冲、仍只在进程级失败时挂进 detail）。
   *
   * 引入它的理由：引擎写的诊断绝大多数落在**命令正常返回、进程不退出**的路径上，
   * 只靠尾缓冲那条出口，它们随进程一起被丢掉 —— 「写了但结构上没人看得到」等于没写。
   * 转发是 tee 不是搬迁：尾缓冲一字不改。
   */
  onDiagnosticLine?: NativeEngineDiagnosticSink;
}

interface ReadyRecord {
  type: 'ready';
  protocolVersion: number;
  manifest: NativePageEngineManifest;
}

interface ErrorRecord {
  code: NativePageEngineErrorCode;
  message: string;
  diagnostic?: unknown;
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

/**
 * 引擎发来的开窗请求，**线路形状**：只有标签，没有预算数字。
 *
 * 预算由宿主按标签发放（{@link NATIVE_COMMIT_WINDOW_BUDGETS}），所以它不在这个类型里；
 * 带上预算的那个形状是 {@link NativeCommitWindowRequest}，由宿主授予之后才组装出来。
 * 两个形状分开写，是为了让「谁说了算」在类型上就看得见：读进来的没有数字，能读到数字的都是授予后的。
 */
interface CommitWindowRequestRecord extends Omit<NativeCommitWindowRequest, 'budgetMs'> {
  type: 'commit_window_request';
  protocolVersion: number;
  id: string;
}

/** 引擎在重连时主动要一次当前端点。与提交窗口请求同一形状（沿用当前命令的请求 id 作关联键）。 */
interface EndpointRequestRecord {
  type: 'endpoint_request';
  protocolVersion: number;
  id: string;
  sessionId: string;
  taskId: string;
  commandId: number;
  token: string;
}

interface PendingResponse {
  resolve(value: unknown): void;
  reject(error: NativePageEngineError): void;
  timer: NodeJS.Timeout;
  commitWindowHandler?: NativeCommitWindowHandler;
  disposeCommitWindow?: () => void;
  /** `undefined` for lifecycle requests; command requests start false and flip only in stdin's success callback. */
  commandDispatched?: boolean;
  onCommandDispatched?: () => void;
}

class NativeProcessTransport {
  private readonly pending = new Map<string, PendingResponse>();
  private readonly processTimeoutMs: number;
  private stdoutBuffer = '';
  private stderr = '';
  /** 转发通路自己的行缓冲，与 `stderr` 尾缓冲互不影响（后者允许半行、允许被挤掉）。 */
  private stderrLine = '';
  /** 当前这一行已作为超长行发出，剩余部分丢弃到行尾为止 —— 而不是把尾巴当成新的一行。 */
  private stderrLineDropping = false;
  private diagnosticSeq = 0;
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
    /** 会话期内可重复取值的端点解析入口；缺席等价于恒定解析不出来。 */
    private readonly resolveEndpointImpl?: () => { host: string; port: number } | undefined,
    /** 逐行诊断出口；缺席即不转发（行为与本项引入前逐字相同）。 */
    private readonly diagnosticSink?: NativeEngineDiagnosticSink,
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
    const transport = new NativeProcessTransport(
      child,
      processTimeoutMs,
      options.expectedManifest,
      options.resolveEndpoint,
      options.onDiagnosticLine,
    );
    await transport.readyPromise;
    return transport;
  }

  async request(
    id: string,
    record: Record<string, unknown>,
    timeoutMs?: number,
    commitWindowHandler?: NativeCommitWindowHandler,
    onCommandDispatched?: () => void,
  ): Promise<unknown> {
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
        const pending = this.pending.get(id);
        if (!pending) return;
        pending?.disposeCommitWindow?.();
        this.pending.delete(id);
        pending.reject(new NativePageEngineError(
          'engine_timeout',
          'Native Page Engine did not return before the IPC deadline',
          {
            stderr: this.stderr || undefined,
            ...(pending.commandDispatched !== undefined
              // A command request entered the write path. If the IPC deadline wins before the
              // write callback, bytes may still be buffered/in flight; that is not proof of zero dispatch.
              ? { effectPhase: 'ambiguous' as const }
              : {}),
          },
        ));
      }, timeoutMs ?? this.processTimeoutMs);
      const pending: PendingResponse = {
        resolve,
        reject,
        timer,
        commitWindowHandler,
        ...(onCommandDispatched
          ? { commandDispatched: false, onCommandDispatched }
          : {}),
      };
      this.pending.set(id, pending);
      this.child.stdin.write(serialized, (error) => {
        if (!error) {
          if (pending.commandDispatched === false) {
            pending.commandDispatched = true;
            pending.onCommandDispatched?.();
          }
          return;
        }
        const active = this.pending.get(id);
        if (!active) return;
        clearTimeout(active.timer);
        active.disposeCommitWindow?.();
        this.pending.delete(id);
        active.reject(new NativePageEngineError(
          'engine_exited',
          `Native Page Engine stdin failed: ${describeError(error)}`,
          {
            stderr: this.stderr || undefined,
            ...(active.commandDispatched !== undefined
              ? { effectPhase: active.commandDispatched ? 'ambiguous' : 'not_started' }
              : {}),
          },
        ));
      });
    });
  }

  /**
   * 存活的**肯定证据**：握手已完成、Node 明说进程还没退出（`exitCode`/`signalCode` 均为 null）、
   * 没被我们杀过、且标准输入这条通道现在可写。
   * MUST NOT 退化成「没记到死讯就算活着」——退出事件可能还没派发，缓存句柄就是这么被复用成僵尸的。
   */
  isLive(): boolean {
    return this.ready
      && !this.exited
      && !this.child.killed
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.child.stdin.writable === true;
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
      const text = chunk.toString();
      // ① 进程级失败归因用的滚动尾缓冲：**一字不改**。
      this.stderr = `${this.stderr}${text}`.slice(-MAX_STDERR_CHARS);
      // ② 并行的逐行出口。它不依赖进程死亡，因此成功路径上的诊断第一次有了收件人。
      this.consumeStderrForDiagnostics(text);
    });
    // 半行冲刷挂在**流结束**上而不是进程 `exit` 上：`exit` 可能先于 stderr 把剩余数据递完，
    // 那时冲刷会把一条完整行劈成两半、并给前半段打上假的「不完整」标。
    // `close`（全部 stdio 关闭后才触发）作为兜底，冲刷本身对空缓冲是 no-op。
    this.child.stderr.once('end', () => this.flushStderrLine(true));
    this.child.once('close', () => this.flushStderrLine(true));
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

  /**
   * 把一个 chunk 切成行喂给转发出口。**按行成帧，不是按 chunk 拼接**：
   * 一行被读边界劈成两半时必须重新拼回一行，否则读者会看到两条互相都不成立的诊断。
   */
  private consumeStderrForDiagnostics(chunk: string): void {
    if (!this.diagnosticSink) return;
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf('\n');
      if (newline < 0) {
        this.appendStderrFragment(rest);
        return;
      }
      this.appendStderrFragment(rest.slice(0, newline));
      rest = rest.slice(newline + 1);
      this.flushStderrLine(false);
    }
  }

  private appendStderrFragment(fragment: string): void {
    if (!fragment) return;
    // 超长行的尾巴：已经作为截断行发出去了，剩下的丢到行尾为止。
    // MUST NOT 把它当成新的一行 —— 那会凭空造出一条引擎从未写过的诊断。
    if (this.stderrLineDropping) return;
    const room = MAX_DIAGNOSTIC_LINE_CHARS - this.stderrLine.length;
    if (fragment.length <= room) {
      this.stderrLine += fragment;
      return;
    }
    this.emitDiagnosticLine(this.stderrLine + fragment.slice(0, room), true, false);
    this.stderrLine = '';
    this.stderrLineDropping = true;
  }

  private flushStderrLine(incomplete: boolean): void {
    if (this.stderrLineDropping) {
      // 超长行的收尾：整行已发过，这里只是把状态复位，不再补发一条。
      this.stderrLineDropping = false;
      this.stderrLine = '';
      return;
    }
    const line = this.stderrLine.replace(/\r+$/, '');
    this.stderrLine = '';
    if (!line) return;
    this.emitDiagnosticLine(line, false, incomplete);
  }

  private emitDiagnosticLine(text: string, truncated: boolean, incomplete: boolean): void {
    const sink = this.diagnosticSink;
    if (!sink) return;
    this.diagnosticSeq += 1;
    try {
      sink({
        seq: this.diagnosticSeq,
        text,
        // 全量转发、只做分类：只放行具名族会把 panic 与 backtrace 静默丢掉，
        // 而那恰恰是引擎能产出的最有价值的输出。
        kind: text.startsWith(ENGINE_DIAGNOSTIC_FAMILY_PREFIX) ? 'known' : 'other',
        truncated,
        incomplete,
      });
    } catch {
      // 出口自身抛异常不得反噬协议通道。这里吞掉的是出口的故障，不是引擎的诊断。
    }
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
        || JSON.stringify(ready.manifest.platformAdapters) !== JSON.stringify(this.expectedManifest.platformAdapters)
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
    if (record.type === 'commit_window_request') {
      const commitWindow = parseCommitWindowRequest(record);
      if (!commitWindow) {
        // 结构坏了才是传输契约破了：连是哪条命令都读不出来，没有可归因的对象。
        this.failProtocol('Native Page Engine emitted an invalid commit window request');
        this.terminate();
        return;
      }
      const budgetMs = grantCommitWindowBudget(commitWindow.label);
      if (budgetMs === undefined) {
        this.rejectCommitWindowContract(commitWindow, 'commit_window_label_unknown');
        return;
      }
      this.handleCommitWindowRequest(record.id, commitWindow, budgetMs);
      return;
    }
    if (record.type === 'endpoint_request') {
      const endpointRequest = parseEndpointRequest(record);
      if (!endpointRequest) {
        // 结构坏了才是传输契约破了：连是哪条命令都读不出来，没有可归因的对象。
        this.failProtocol('Native Page Engine emitted an invalid endpoint request');
        this.terminate();
        return;
      }
      this.handleEndpointRequest(endpointRequest);
      return;
    }
    const pending = this.pending.get(record.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.disposeCommitWindow?.();
    this.pending.delete(record.id);
    pending.resolve(record);
  }

  private handleCommitWindowRequest(
    id: string,
    request: CommitWindowRequestRecord,
    budgetMs: number,
  ): void {
    const pending = this.pending.get(id);
    if (!pending || pending.disposeCommitWindow) {
      this.failProtocol('Native Page Engine commit window has no matching active command');
      return;
    }
    let accepted = false;
    if (pending.commitWindowHandler) {
      try {
        // 交给守卫的是**宿主授予的**预算，不是引擎说的：引擎这条线上根本没有数字可说。
        pending.disposeCommitWindow = pending.commitWindowHandler({ ...request, budgetMs });
        accepted = true;
      } catch {
        accepted = false;
      }
    }
    const ackId = requestId('commit_window_ack');
    void this.request(ackId, {
      type: 'commit_window_ack',
      protocolVersion: NATIVE_PAGE_ENGINE_PROTOCOL_VERSION,
      id: ackId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      commandId: request.commandId,
      token: request.token,
      label: request.label,
      accepted,
    }, Math.min(this.processTimeoutMs, 2_000)).catch((error) => {
      pending.disposeCommitWindow?.();
      pending.disposeCommitWindow = undefined;
      this.failProcess(error);
      this.terminate();
    });
  }

  /**
   * 回答引擎「这个会话现在该连哪里」。
   *
   * 解析不出来时如实回一个**空端点**（不带 host/port）—— 引擎收到之后会诚实地判重连失败，
   * 而不是拿一个来路不明的端口去附着。这条应答绝不能省略：省略了引擎只能干等到命令截止。
   */
  private handleEndpointRequest(request: EndpointRequestRecord): void {
    let resolved: { host: string; port: number } | undefined;
    try {
      const candidate = this.resolveEndpointImpl?.();
      if (
        candidate
        && typeof candidate.host === 'string'
        && candidate.host.length > 0
        && Number.isSafeInteger(candidate.port)
        && candidate.port > 0
      ) {
        resolved = { host: candidate.host, port: candidate.port };
      }
    } catch {
      resolved = undefined;
    }
    const resultId = requestId('endpoint_result');
    void this.request(resultId, {
      type: 'endpoint_result',
      protocolVersion: NATIVE_PAGE_ENGINE_PROTOCOL_VERSION,
      id: resultId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      commandId: request.commandId,
      token: request.token,
      ...(resolved ?? {}),
    }, Math.min(this.processTimeoutMs, 2_000)).catch(() => {
      // 应答送不出去 = 传输已经不健康。命令自身的失败仍由引擎按预算如实回报，
      // 这里不再叠一层猜测性的结论。
    });
  }

  /**
   * 提交窗口的契约违规：拒绝这一次窗口（不可逆动作因此不会被按下），并把结论绑到**当前这条命令**上。
   * 引擎进程不终止——一条命令的契约不符，代价必须停在这条命令，而不是把整个环境打成砖。
   */
  private rejectCommitWindowContract(
    request: CommitWindowRequestRecord,
    reason: CommitWindowContractViolation,
  ): void {
    const pending = this.pending.get(request.id);
    // 先发否决回执：引擎收到 accepted=false 会在按下之前放弃，不必干等到命令截止。
    const ackId = requestId('commit_window_ack');
    void this.request(ackId, {
      type: 'commit_window_ack',
      protocolVersion: NATIVE_PAGE_ENGINE_PROTOCOL_VERSION,
      id: ackId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      commandId: request.commandId,
      token: request.token,
      label: request.label,
      accepted: false,
    }, Math.min(this.processTimeoutMs, 2_000)).catch(() => undefined);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.disposeCommitWindow?.();
    this.pending.delete(request.id);
    pending.reject(new NativePageEngineError(
      'commit_window_unavailable',
      `Native commit window contract violation: ${reason}`,
      { effectPhase: 'not_started', reasonCode: reason, stderr: this.stderr || undefined },
    ));
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
      pending.disposeCommitWindow?.();
      pending.reject(pending.commandDispatched === undefined || error.detail?.effectPhase
        ? error
        : new NativePageEngineError(error.code, error.message, {
          ...error.detail,
          // Process death while a command write is pending cannot prove that zero bytes reached
          // the child. The explicit stdin-write error path above is the only pre-dispatch proof.
          effectPhase: 'ambiguous',
        }));
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
    readonly platform: NativePagePlatform,
  ) {}

  /** 会话句柄是否还能承载命令：本会话未关闭 **且** 底层传输给出存活的肯定证据。 */
  isLive(): boolean {
    return !this.closed && this.transport.isLive();
  }

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
    commitWindowHandler?: NativeCommitWindowHandler,
    onCommandDispatched?: () => void,
  ): Promise<NativePageCommandExecution> {
    this.assertOpen();
    validateCommandTimeout(this.platform, command, timeoutMs);
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
    }, Math.max(this.processTimeoutMs, timeoutMs + 250), commitWindowHandler
      ? (request) => {
      if (
        request.sessionId !== this.sessionId
        || request.taskId !== this.taskId
        || request.commandId !== commandId
      ) {
        throw new NativePageEngineError(
          'invalid_protocol',
          'Native commit window correlation mismatch',
        );
      }
      return commitWindowHandler(request);
    }
      : undefined,
    // Always register command dispatch tracking, even when the caller only needs effect-phase truth.
    onCommandDispatched ?? (() => undefined));
    const abort = (): void => { void this.cancel(commandId, 'caller_aborted').catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });
    let raw: unknown;
    try { raw = await pending; } finally { signal?.removeEventListener('abort', abort); }
    const response = parseCommandResponse(raw, id, this.sessionId, this.taskId, commandId);
    if (response.error || (!response.result && !response.ok)) throw nativeResponseError(response);
    const output = parseNativePageCommandOutput(response.result);
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

  /**
   * 客户端**实际持有**的诊断出口，供装配闸按引用核对。
   *
   * 存在的理由是一种很像成功的失败：选项加好了、单测全绿、生产装配那一处忘了传 —— 通路根本不存在，
   * 而工作读起来像是做完了。断言「选项可被接受」抓不到它，只有断言「生产客户端手上是不是那一个」才抓得到。
   */
  diagnosticSink(): NativeEngineDiagnosticSink | undefined {
    return this.options.onDiagnosticLine;
  }

  async openSession(input: NativePageSessionInput): Promise<NativePageEngineSession> {
    // 会话超时自身也要过准入校验，且它必须**容得下最长的那条命令**——引擎按
    // `session_timeout_ms.min(命令天花板)` 算预算，会话值偏小会把天花板静默夹回。
    // 这里曾复用加群上限，于是「会话超时 > 加群上限」时 openSession 直接 invalid_request、
    // **整个 Facebook 会话开不起来**（不是某条命令失败，是全线不可用）。改为按最长命令上限校验。
    validateProbeInput(
      input,
      input.platform === 'facebook' ? MAX_FACEBOOK_SESSION_TIMEOUT_MS : MAX_NATIVE_TIMEOUT_MS,
    );
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
          // 引擎侧 `deny_unknown_fields`：没有证据就整项省略，绝不发一个空串顶上
          //（空串会在引擎入口被判成非法身份、整个会话开不起来）。
          ...(input.browserDebuggerUrl ? { browserDebuggerUrl: input.browserDebuggerUrl } : {}),
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
        input.platform,
      );
    } catch (error) {
      transport.terminate();
      throw error;
    }
  }

  /** One-shot development probe retained as a wrapper over the production v2 session lifecycle. */
  async probePage(input: NativePageProbeInput): Promise<NativePageProbeResult> {
    validateProbeInput(input, MAX_NATIVE_TIMEOUT_MS);
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
    || !isPlatformAdapters(manifest.platformAdapters)
    || typeof manifest.capabilityDigest !== 'string'
    || !/^[a-f0-9]{64}$/i.test(manifest.capabilityDigest)
  ) return undefined;
  return value as unknown as ReadyRecord;
}

function isPlatformAdapters(value: unknown): value is NativePagePlatformAdapter[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const adapter of value) {
    if (
      !isRecord(adapter)
      || !['xiaohongshu', 'facebook', 'wechat_channels'].includes(String(adapter.platform))
      || typeof adapter.adapterVersion !== 'string'
      || !adapter.adapterVersion
      || seen.has(String(adapter.platform))
    ) {
      return false;
    }
    seen.add(String(adapter.platform));
  }
  return true;
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

function parseNativePageCommandOutput(value: unknown): NativePageCommandOutput | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string' || !('value' in value)) {
    return undefined;
  }
  if (value.kind === 'facebook_auth_probe') {
    const receipt = value.value;
    if (
      !isRecord(receipt)
      || typeof receipt.signal !== 'string'
      || !NATIVE_FACEBOOK_AUTH_SIGNALS.includes(receipt.signal as NativeFacebookAuthSignal)
      || (receipt.signalId !== undefined && typeof receipt.signalId !== 'string')
      || (receipt.serverEpochMs !== undefined && !Number.isSafeInteger(receipt.serverEpochMs))
      || (receipt.reason !== undefined && typeof receipt.reason !== 'string')
    ) {
      return undefined;
    }
    return {
      kind: value.kind,
      value: {
        signal: receipt.signal as NativeFacebookAuthSignal,
        ...(receipt.signalId === undefined ? {} : { signalId: receipt.signalId }),
        ...(receipt.serverEpochMs === undefined ? {} : { serverEpochMs: Number(receipt.serverEpochMs) }),
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      },
    };
  }
  if (value.kind === 'facebook_auth_action') {
    const receipt = value.value;
    if (
      !isRecord(receipt)
      || !NATIVE_FACEBOOK_AUTH_ACTION_KINDS.includes(
        receipt.action as NativeFacebookAuthActionReceipt['action'],
      )
      || typeof receipt.signalId !== 'string'
      || typeof receipt.ok !== 'boolean'
      || (receipt.reason !== undefined && typeof receipt.reason !== 'string')
    ) {
      return undefined;
    }
    return {
      kind: value.kind,
      value: {
        action: receipt.action as NativeFacebookAuthActionReceipt['action'],
        signalId: receipt.signalId,
        ok: receipt.ok,
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      },
    };
  }
  if (NATIVE_NON_AUTH_OUTPUT_KINDS.includes(value.kind as NativeNonAuthOutputKind)) {
    return { kind: value.kind as NativeNonAuthOutputKind, value: value.value };
  }
  return undefined;
}

/**
 * 提交窗口预算的**单一事实源**（宿主权威）。引擎侧 `native/page-engine/src/facebook/capability.rs`
 * 与 `native/page-engine/src/commit_window.rs` 的窗口只保留标签、其数字是这张表的镜像，由
 * `test/native-page-engine/runtime-contracts-commit-window.test.ts` 机械对账；
 * 单边改一个数字，仓库检查当场失败。
 *
 * 运行期口径：宿主按**标签**发放预算，引擎自报的数字只作为「不超过事实源上限」的请求值。
 * MUST NOT 回到「两边各写一份 + 相等断言 + 不等就终止引擎」——一次纯节奏调优会在按下按钮前
 * 把整个引擎杀掉，然后被上报成一条普通失败。
 *
 * ⚠️ **这张表是准入白名单，不只是数字表**：不在表里的标签会被判成契约违规并否决窗口，
 * 而窗口拿不到时写入 MUST NOT 派发。所以引擎新增一处提交窗口却漏改这里，后果不是
 * 「少了一层保护」，而是那处写入**全部拒发**（回执诚实，但功能停摆）。
 * 两平台的预算各按各自真实提交时长定：小红书发布提交是 15s，Facebook 是 20s，混用即拉长或截短。
 */
export const NATIVE_COMMIT_WINDOW_BUDGETS: Readonly<Record<NativeCommitWindowLabel, number>> = {
  // 提交窗预算随 Facebook 时间预算整体 ×1.5（2026-07-29）。这里是**事实源**，
  // native/page-engine/src/facebook/capability.rs 里的同名数字只是镜像，运行期以本表为准。
  fb_join_click: 27_750,
  fb_comment_enter: 30_000,
  fb_publish_submit: 30_000,
  // 评论提交现在把硬件级逐字输入整段包在窗口里（引擎侧 `commit_window.rs` 写了推导），
  // 故预算 = 命令墙钟上限。窗口的真实关闭点仍是命令结束时的 dispose，这个数字只是兜底上限。
  // ⚠️ MUST **引用**那个常量、MUST NOT 手抄字面量：上限低于命令墙钟上限的后果不是报错，
  // 是窗口静默过期 ⇒ 抢占重新落回提交那一刻 ⇒ 一条可能已发出去的评论被当成没发生 ⇒ 重复评论。
  xhs_comment_submit: MAX_NATIVE_TIMEOUT_MS,
  xhs_notification_comments: 20_000,
  xhs_notification_likes: 20_000,
  xhs_notification_follows: 20_000,
  xhs_publish_submit: 15_000,
};

/** 结构合法但契约不符的提交窗口请求：绑定到当前命令，不牵连引擎进程。 */
type CommitWindowContractViolation = 'commit_window_label_unknown';

function parseCommitWindowRequest(value: unknown): CommitWindowRequestRecord | undefined {
  if (
    !isRecord(value)
    || value.type !== 'commit_window_request'
    || value.protocolVersion !== NATIVE_PAGE_ENGINE_PROTOCOL_VERSION
    || typeof value.id !== 'string'
    || typeof value.sessionId !== 'string'
    || typeof value.taskId !== 'string'
    || !Number.isSafeInteger(value.commandId)
    || typeof value.token !== 'string'
    || typeof value.label !== 'string'
  ) {
    return undefined;
  }
  return value as unknown as CommitWindowRequestRecord;
}

function parseEndpointRequest(value: unknown): EndpointRequestRecord | undefined {
  if (
    !isRecord(value)
    || value.type !== 'endpoint_request'
    || value.protocolVersion !== NATIVE_PAGE_ENGINE_PROTOCOL_VERSION
    || typeof value.id !== 'string'
    || typeof value.sessionId !== 'string'
    || typeof value.taskId !== 'string'
    || !Number.isSafeInteger(value.commandId)
    || typeof value.token !== 'string'
  ) {
    return undefined;
  }
  return value as unknown as EndpointRequestRecord;
}

/**
 * 按**标签**发放预算。请求里不带数字，这里也不看数字。
 *
 * 曾经的口径是 `min(引擎请求, 事实源)`。那一版是从「两边各写一份 + 相等断言 + 不等就终止引擎」
 * 往回收的中间态：数字已经不作数，但字段还在线路上。字段留着的唯一效果，是让下一个调预算的人
 * 以为改引擎那份也能改到实际窗口——改了不报错、不冲突、也不生效。现在线路上只有标签。
 *
 * 旧引擎二进制仍可能带一个 `budgetMs` 过来：**忽略**，不拒。拒了等于让一次版本错配把
 * 那几处不可逆写入全部停摆，而这个字段本来就已经不作数了。
 *
 * 标签不认识时返回 undefined —— 那是契约违规，不是「按默认放行」。
 */
function grantCommitWindowBudget(label: string): number | undefined {
  if (!Object.hasOwn(NATIVE_COMMIT_WINDOW_BUDGETS, label)) return undefined;
  return NATIVE_COMMIT_WINDOW_BUDGETS[label as NativeCommitWindowLabel];
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
    {
      effectPhase: value.effectPhase,
      reasonCode: value.reasonCode,
      diagnostic: parseNativeDiagnostic(value.error?.diagnostic),
    },
  );
}

function parseNativeDiagnostic(value: unknown): NativePageEngineDiagnostic | undefined {
  if (!isRecord(value)) return undefined;
  const operationStages = [
    'reuse_probe',
    'action_gate_page_probe',
    'action_gate_consent_probe',
    'action_gate_result',
    'readiness_probe',
    'join_click',
    'verification_probe',
  ] as const;
  const decodeStages = [
    'cdp_exception',
    'cdp_wrapper',
    'output_kind',
    'output_value',
    'typed_value',
  ] as const;
  const actualTypes = ['missing', 'null', 'boolean', 'number', 'string', 'array', 'object'] as const;
  const exceptionClasses = [
    'error',
    'type_error',
    'reference_error',
    'range_error',
    'syntax_error',
    'eval_error',
    'uri_error',
  ] as const;
  const exceptionReasons = [
    'cannot_read_property',
    'reference_not_defined',
    'not_a_function',
    'other',
  ] as const;
  const operationStage = typeof value.operationStage === 'string'
    && operationStages.includes(value.operationStage as typeof operationStages[number])
    ? value.operationStage as NativePageEngineDiagnostic['operationStage']
    : undefined;
  const decodeStage = typeof value.decodeStage === 'string'
    && decodeStages.includes(value.decodeStage as typeof decodeStages[number])
    ? value.decodeStage as NativePageEngineDiagnostic['decodeStage']
    : undefined;
  const expectedKind = typeof value.expectedKind === 'string'
    && /^[a-z][a-z0-9_]{0,63}$/.test(value.expectedKind)
    ? value.expectedKind
    : undefined;
  const fieldPath = typeof value.fieldPath === 'string'
    && value.fieldPath.length <= 160
    && /^[A-Za-z0-9_.\[\]-]+$/.test(value.fieldPath)
    ? value.fieldPath
    : undefined;
  const actualType = typeof value.actualType === 'string'
    && actualTypes.includes(value.actualType as typeof actualTypes[number])
    ? value.actualType as NativePageEngineDiagnostic['actualType']
    : undefined;
  const exceptionClass = typeof value.exceptionClass === 'string'
    && exceptionClasses.includes(value.exceptionClass as typeof exceptionClasses[number])
    ? value.exceptionClass as NativePageEngineDiagnostic['exceptionClass']
    : undefined;
  const exceptionReason = typeof value.exceptionReason === 'string'
    && exceptionReasons.includes(value.exceptionReason as typeof exceptionReasons[number])
    ? value.exceptionReason as NativePageEngineDiagnostic['exceptionReason']
    : undefined;
  const exceptionToken = typeof value.exceptionToken === 'string'
    && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value.exceptionToken)
    ? value.exceptionToken
    : undefined;
  const lineNumber = Number.isSafeInteger(value.lineNumber)
    && Number(value.lineNumber) >= 0
    && Number(value.lineNumber) <= 0xffff_ffff
    ? Number(value.lineNumber)
    : undefined;
  const columnNumber = Number.isSafeInteger(value.columnNumber)
    && Number(value.columnNumber) >= 0
    && Number(value.columnNumber) <= 0xffff_ffff
    ? Number(value.columnNumber)
    : undefined;
  if (
    !operationStage
    && !decodeStage
    && !expectedKind
    && !fieldPath
    && !actualType
    && !exceptionClass
    && !exceptionReason
    && !exceptionToken
    && lineNumber === undefined
    && columnNumber === undefined
  ) return undefined;
  return {
    ...(operationStage ? { operationStage } : {}),
    ...(decodeStage ? { decodeStage } : {}),
    ...(expectedKind ? { expectedKind } : {}),
    ...(fieldPath ? { fieldPath } : {}),
    ...(actualType ? { actualType } : {}),
    ...(exceptionClass ? { exceptionClass } : {}),
    ...(exceptionReason ? { exceptionReason } : {}),
    ...(exceptionToken ? { exceptionToken } : {}),
    ...(lineNumber !== undefined ? { lineNumber } : {}),
    ...(columnNumber !== undefined ? { columnNumber } : {}),
  };
}

function validateProbeInput(input: NativePageProbeInput, maxTimeoutMs = MAX_NATIVE_TIMEOUT_MS): void {
  if (!input.host || input.host.length > 255) {
    throw new NativePageEngineError('invalid_request', 'Invalid DevTools host');
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new NativePageEngineError('invalid_request', 'Invalid DevTools port');
  }
  validateTimeout(input.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS, maxTimeoutMs);
}

function validateTimeout(timeoutMs: number, maxTimeoutMs = MAX_NATIVE_TIMEOUT_MS): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > maxTimeoutMs) {
    throw new NativePageEngineError('invalid_request', 'Invalid native operation timeout');
  }
}

function validateCommandTimeout(
  platform: NativePagePlatform,
  command: NativePageCommand,
  timeoutMs: number,
): void {
  const maxTimeoutMs = platform !== 'facebook'
    ? MAX_NATIVE_TIMEOUT_MS
    : command.kind === 'browse_scroll' || command.kind === 'page_scroll'
      ? MAX_FACEBOOK_FEED_SCROLL_TIMEOUT_MS
      : command.kind === 'publish_fill_field'
      ? MAX_FACEBOOK_PUBLISH_FILL_TIMEOUT_MS
      : command.kind === 'interaction_comment'
        ? MAX_FACEBOOK_COMMENT_TIMEOUT_MS
        : command.kind === 'group_join'
          ? MAX_FACEBOOK_GROUP_JOIN_TIMEOUT_MS
          : command.kind === 'publish_select_mode'
            ? MAX_FACEBOOK_PUBLISH_SELECT_MODE_TIMEOUT_MS
            : command.kind === 'note_open'
              && command.params.selection === FACEBOOK_FIRST_POST_SELECTION
              ? MAX_FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS
              : MAX_NATIVE_TIMEOUT_MS;
  validateTimeout(timeoutMs, maxTimeoutMs);
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
  return {
    ...value,
    notificationUnread: parseNotificationUnread(value.notificationUnread),
  } as unknown as NativePageProbeResult;
}

/**
 * 未读读数的解析：缺失、结构不对、取值不认识，一律回「读不到」。
 * MUST NOT 回落成 `clear` —— 下游把「没有未读」当已清零跳过，读取失败静默变成已清零
 * 会让真通知永远不被处理。
 */
function parseNotificationUnread(value: unknown): NativePageNotificationUnread {
  const unreadable: NativePageNotificationUnread = { state: 'unreadable', count: 0 };
  if (!isRecord(value)) return unreadable;
  if (value.state !== 'unread' && value.state !== 'clear') return unreadable;
  const count = typeof value.count === 'number' && Number.isInteger(value.count) && value.count >= 0
    ? Math.min(999, value.count)
    : 0;
  return { state: value.state, count: value.state === 'unread' ? count : 0 };
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
    'commit_window_unavailable',
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
